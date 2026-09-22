import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { EMERGENCY_ACCESS_STATUSES, EmergencyAccess, type EmergencyAccessStatus, type IEmergencyAccess } from '../models/EmergencyAccess';
import { MedicalDocument } from '../models/MedicalDocument';
import { User } from '../models/User';
import type { AuthenticatedRequest } from '../types/auth.types';
import type { SafeUser } from '../types/user.types';
import { createAuditLog, getRequestIpAddress } from '../utils/audit.util';
import { asyncHandler } from '../utils/asyncHandler.util';
import { findApprovedConsent } from '../utils/consent.util';
import { emitAppEvent, eventBase } from '../events/appEvents';
import { enqueueEmergencyAnchor } from '../services/anchorQueue.service';
import { serializeAnchorReferences, type AnchorReferenceResponse } from '../utils/anchors.util';
import {
  EMERGENCY_ACCESS_DURATION_MS,
  EMERGENCY_ACCESS_DURATION_MINUTES,
  countActiveEmergencyAccesses,
  expireEmergencyAccesses,
  findActiveEmergencyAccess,
  maxActiveEmergencyGrants,
  regrantWindowMs,
} from '../utils/emergencyAccess.util';

interface EmergencyAccessResponse {
  id: string;
  doctorId: string;
  patientId: string;
  documentId: string;
  reason: string;
  status: EmergencyAccessStatus;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
  /** This grant re-opened access the patient had recently revoked — surfaced so a return is never silent. */
  afterRevocation?: boolean;
  followsRevokedGrantId?: string;
  anchors?: Record<string, AnchorReferenceResponse>;
  /** Joined summaries, present on the list endpoint. */
  doctor?: { id: string; name: string };
  patient?: { id: string; name: string };
  document?: { id: string; title: string };
}

const getAuthenticatedUser = (req: AuthenticatedRequest) => req.user ?? null;
const getRequestString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const getIdParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] ?? '' : value ?? '');

interface NamedUser {
  _id: Types.ObjectId;
  name: string;
}

interface SerializeContext {
  doctor?: NamedUser | null;
  patient?: NamedUser | null;
  document?: { _id: Types.ObjectId; title: string } | null;
}

const serializeEmergencyAccess = (emergencyAccess: IEmergencyAccess, context: SerializeContext = {}): EmergencyAccessResponse => ({
  id: emergencyAccess._id.toString(),
  doctorId: emergencyAccess.doctorId.toString(),
  patientId: emergencyAccess.patientId.toString(),
  documentId: emergencyAccess.documentId.toString(),
  reason: emergencyAccess.reason,
  status: emergencyAccess.status,
  createdAt: emergencyAccess.createdAt.toISOString(),
  expiresAt: emergencyAccess.expiresAt.toISOString(),
  ...(emergencyAccess.revokedAt ? { revokedAt: emergencyAccess.revokedAt.toISOString() } : {}),
  ...(emergencyAccess.revokedBy ? { revokedBy: emergencyAccess.revokedBy.toString() } : {}),
  ...(emergencyAccess.afterRevocation ? { afterRevocation: true } : {}),
  ...(emergencyAccess.followsRevokedGrantId ? { followsRevokedGrantId: emergencyAccess.followsRevokedGrantId.toString() } : {}),
  anchors: serializeAnchorReferences(emergencyAccess.anchors),
  ...(context.doctor ? { doctor: { id: context.doctor._id.toString(), name: context.doctor.name } } : {}),
  ...(context.patient ? { patient: { id: context.patient._id.toString(), name: context.patient.name } } : {}),
  ...(context.document ? { document: { id: context.document._id.toString(), title: context.document.title } } : {}),
});

/**
 * POST /api/emergency-access (verified doctor)
 * Break-glass: time-limited, audited, anchored, capped, and — when it re-opens access the patient just
 * revoked — flagged so the return is conspicuous rather than silent.
 */
export const grantEmergencyAccess: RequestHandler = asyncHandler(async (req, res) => {
  const doctor = getAuthenticatedUser(req as AuthenticatedRequest);

  if (!doctor) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const patientId = getRequestString(req.body.patientId);
  const documentId = getRequestString(req.body.documentId);
  const reason = getRequestString(req.body.reason);

  if (!reason) {
    res.status(400).json({ message: 'An emergency access reason is required' });
    return;
  }

  if (reason.length > 500) {
    res.status(400).json({ message: 'Emergency access reason must be 500 characters or fewer' });
    return;
  }

  if (!Types.ObjectId.isValid(patientId) || !Types.ObjectId.isValid(documentId)) {
    res.status(400).json({ message: 'A valid patient ID and document ID are required' });
    return;
  }

  const [patient, document] = await Promise.all([
    User.findOne({ _id: patientId, role: 'patient' }),
    MedicalDocument.findById(documentId),
  ]);

  if (!patient) {
    res.status(404).json({ message: 'Patient not found' });
    return;
  }

  if (!document) {
    res.status(404).json({ message: 'Document not found' });
    return;
  }

  if (!document.uploadedBy.equals(patient._id)) {
    res.status(400).json({ message: 'The selected document does not belong to the selected patient' });
    return;
  }

  if (document.sharedWithDoctors.some((sharedDoctorId) => sharedDoctorId.equals(doctor.id))) {
    res.status(409).json({ message: 'This doctor already has normal access to the selected document' });
    return;
  }

  // Approved consent already grants access; break-glass on top of it would only add an unaudited-looking path.
  // A PENDING consent is deliberately NOT blocked: emergency access is the escalation while the patient hasn't answered.
  if (await findApprovedConsent(doctor.id, document._id)) {
    res.status(409).json({ message: 'This doctor already has patient-approved consent for the selected document' });
    return;
  }

  const activeEmergencyAccess = await findActiveEmergencyAccess(doctor.id, document._id);

  if (activeEmergencyAccess) {
    res.json({
      message: 'Emergency access is already active for this document',
      emergencyAccess: serializeEmergencyAccess(activeEmergencyAccess),
    });
    return;
  }

  // findActiveEmergencyAccess above only sweeps THIS document, so sweep the doctor's other grants too:
  // the count already ignores lapsed rows (it filters on expiresAt), but this keeps their EXPIRED audit
  // rows timely even between ticks of the scheduled expiry job.
  await expireEmergencyAccesses(doctor.id);
  const activeCount = await countActiveEmergencyAccesses(doctor.id);
  const maxActive = maxActiveEmergencyGrants();

  if (activeCount >= maxActive) {
    res.status(409).json({
      message: `You already have ${activeCount} active emergency accesses (limit ${maxActive}). Revoke one or wait for it to expire before starting another.`,
    });
    return;
  }

  // A patient revoking this doctor on this document must mean something: a return inside the window is
  // recorded on the grant, in the audit metadata, in the notification, and in the patient's list.
  const recentlyRevoked = await EmergencyAccess.findOne({
    doctorId: doctor.id,
    documentId: document._id,
    status: 'REVOKED',
    revokedAt: { $gte: new Date(Date.now() - regrantWindowMs()) },
  }).sort({ revokedAt: -1 });

  const expiresAt = new Date(Date.now() + EMERGENCY_ACCESS_DURATION_MS);
  const emergencyAccess = await EmergencyAccess.create({
    doctorId: doctor.id,
    patientId: patient._id,
    documentId: document._id,
    reason,
    status: 'ACTIVE',
    expiresAt,
    ...(recentlyRevoked ? { afterRevocation: true, followsRevokedGrantId: recentlyRevoked._id } : {}),
  });

  await createAuditLog({
    userId: doctor.id,
    action: 'EMERGENCY_ACCESS_GRANTED',
    targetDocument: document._id,
    ipAddress: getRequestIpAddress(req),
    metadata: {
      emergencyAccessId: emergencyAccess._id.toString(),
      doctorId: doctor.id,
      patientId: patient._id.toString(),
      reason,
      expiresAt: expiresAt.toISOString(),
      afterRevocation: String(Boolean(recentlyRevoked)),
      ...(recentlyRevoked
        ? { followsRevokedGrantId: recentlyRevoked._id.toString(), previouslyRevokedAt: recentlyRevoked.revokedAt!.toISOString() }
        : {}),
    },
  });

  await enqueueEmergencyAnchor(emergencyAccess, 'GRANTED', document.documentHash ?? null);

  // Only a NEW grant notifies; the "already active" path above returns without emitting.
  emitAppEvent('emergency.granted', {
    ...eventBase({
      recipientUserId: patient._id.toString(),
      actorUserId: doctor.id,
      actorName: doctor.name,
      documentId: document._id.toString(),
      message: recentlyRevoked
        ? `${doctor.name} used emergency access on "${document.title}" again after you revoked it`
        : `${doctor.name} used emergency access on "${document.title}"`,
    }),
    documentId: document._id.toString(),
    emergencyAccessId: emergencyAccess._id.toString(),
    documentTitle: document.title,
    reason,
    expiresAt: expiresAt.toISOString(),
    afterRevocation: Boolean(recentlyRevoked),
  });

  res.status(201).json({
    message: `Emergency access granted for ${EMERGENCY_ACCESS_DURATION_MINUTES} minutes`,
    emergencyAccess: serializeEmergencyAccess(emergencyAccess),
  });
});

const isEmergencyStatus = (value: string): value is EmergencyAccessStatus =>
  (EMERGENCY_ACCESS_STATUSES as readonly string[]).includes(value);

/**
 * GET /api/emergency-access?status=ACTIVE|EXPIRED|REVOKED|all   (patient or doctor)
 * Patient: grants on their own documents. Doctor: their own grants. Default is live grants only
 * (ACTIVE and not yet lapsed), so a patient sees exactly what is open on their records right now.
 */
export const listEmergencyAccesses: RequestHandler = asyncHandler(async (req, res) => {
  const user = getAuthenticatedUser(req as AuthenticatedRequest) as SafeUser | null;

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const requested = getRequestString(req.query.status).toUpperCase() || 'ACTIVE';

  if (requested !== 'ALL' && !isEmergencyStatus(requested)) {
    res.status(400).json({ message: 'status must be ACTIVE, EXPIRED, REVOKED or all' });
    return;
  }

  // Lapsed-but-not-yet-swept rows must never be shown as live. The scheduled job usually got there
  // first; this keeps the patient's view honest even between ticks.
  if (user.role === 'doctor') {
    await expireEmergencyAccesses(user.id);
  }

  const scope = user.role === 'doctor' ? { doctorId: user.id } : { patientId: user.id };
  const statusFilter =
    requested === 'ALL'
      ? {}
      : requested === 'ACTIVE'
        ? { status: 'ACTIVE' as const, expiresAt: { $gt: new Date() } }
        : { status: requested };

  const grants = await EmergencyAccess.find({ ...scope, ...statusFilter }).sort({ createdAt: -1 }).limit(100);
  const documentIds = [...new Set(grants.map((grant) => grant.documentId.toString()))];
  const userIds = [...new Set(grants.flatMap((grant) => [grant.doctorId.toString(), grant.patientId.toString()]))];
  const [documents, users] = await Promise.all([
    MedicalDocument.find({ _id: { $in: documentIds } }).select('title'),
    User.find({ _id: { $in: userIds } }).select('name'),
  ]);
  const documentById = new Map(documents.map((document) => [document._id.toString(), document]));
  const userById = new Map(users.map((entry) => [entry._id.toString(), entry]));

  res.json({
    emergencyAccesses: grants.map((grant) =>
      serializeEmergencyAccess(grant, {
        doctor: userById.get(grant.doctorId.toString()),
        patient: userById.get(grant.patientId.toString()),
        document: documentById.get(grant.documentId.toString()),
      })
    ),
  });
});

/**
 * DELETE /api/emergency-access/:id   (patient who owns the record)
 * Ends the session immediately: the status guard makes the transition exactly-once, and every read path
 * already filters on status ACTIVE + expiresAt, so the doctor loses access on their very next request.
 */
export const revokeEmergencyAccess: RequestHandler = asyncHandler(async (req, res) => {
  const patient = getAuthenticatedUser(req as AuthenticatedRequest);

  if (!patient) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const grantId = getIdParam(req.params.id);

  if (!Types.ObjectId.isValid(grantId)) {
    res.status(400).json({ message: 'A valid emergency access ID is required' });
    return;
  }

  const grant = await EmergencyAccess.findById(grantId);

  if (!grant) {
    res.status(404).json({ message: 'Emergency access not found' });
    return;
  }

  if (!grant.patientId.equals(patient.id)) {
    res.status(403).json({ message: 'You do not have permission to revoke this emergency access' });
    return;
  }

  const revokedAt = new Date();
  const result = await EmergencyAccess.updateOne(
    { _id: grant._id, status: 'ACTIVE' },
    { $set: { status: 'REVOKED', revokedAt, revokedBy: new Types.ObjectId(patient.id) } }
  );

  if (result.modifiedCount === 0) {
    res.status(409).json({ message: 'Only active emergency access can be revoked' });
    return;
  }

  const revoked = (await EmergencyAccess.findById(grant._id))!;
  const [document, doctor] = await Promise.all([
    MedicalDocument.findById(revoked.documentId).select('title documentHash'),
    User.findById(revoked.doctorId).select('name'),
  ]);

  await createAuditLog({
    userId: patient.id,
    action: 'EMERGENCY_ACCESS_REVOKED',
    targetDocument: revoked.documentId,
    ipAddress: getRequestIpAddress(req),
    metadata: {
      emergencyAccessId: revoked._id.toString(),
      doctorId: revoked.doctorId.toString(),
      patientId: revoked.patientId.toString(),
      grantedAt: revoked.createdAt.toISOString(),
      expiresAt: revoked.expiresAt.toISOString(),
      revokedAt: revokedAt.toISOString(),
    },
  });

  await enqueueEmergencyAnchor(revoked, 'REVOKED', document?.documentHash ?? null);

  emitAppEvent('emergency.revoked', {
    ...eventBase({
      recipientUserId: revoked.doctorId.toString(),
      actorUserId: patient.id,
      actorName: patient.name,
      documentId: revoked.documentId.toString(),
      message: `${patient.name} revoked your emergency access to "${document?.title ?? 'a document'}"`,
    }),
    documentId: revoked.documentId.toString(),
    emergencyAccessId: revoked._id.toString(),
    documentTitle: document?.title ?? 'a document',
  });

  res.json({
    message: 'Emergency access revoked',
    emergencyAccess: serializeEmergencyAccess(revoked, {
      doctor,
      document,
    }),
  });
});
