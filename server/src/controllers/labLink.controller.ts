import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { LabLink, type ILabLink, type LabLinkStatus } from '../models/LabLink';
import type { AuthenticatedRequest } from '../types/auth.types';
import type { SafeUser } from '../types/user.types';
import { createAuditLog, getRequestIpAddress } from '../utils/audit.util';
import { asyncHandler } from '../utils/asyncHandler.util';
import { emitAppEvent, eventBase } from '../events/appEvents';
import {
  auditPatientLookup,
  findPatientByQuery,
  LOOKUP_QUERY_REQUIRED_MESSAGE,
  PATIENT_NOT_FOUND_MESSAGE,
  readLookupQuery,
} from '../utils/patientLookup.util';

interface PopulatedUser {
  _id: Types.ObjectId;
  name: string;
  organisation?: string;
}

type LabLinkWithReferences = Omit<ILabLink, 'patientId' | 'labId'> & {
  patientId: Types.ObjectId | PopulatedUser;
  labId: Types.ObjectId | PopulatedUser;
};

/** Wire shape for a lab link. Mirrored in docs/API_LAB.md. */
export interface LabLinkResponse {
  id: string;
  patient: { id: string; name: string };
  lab: { id: string; name: string; organisation?: string };
  status: LabLinkStatus;
  requestedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  revokedAt?: string;
}

const isPopulatedUser = (value: unknown): value is PopulatedUser =>
  typeof value === 'object' && value !== null && '_id' in value && 'name' in value;

const getIdParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] ?? '' : value ?? '');

const USER_FIELDS = 'name organisation';

export const serializeLabLink = (link: ILabLink): LabLinkResponse => {
  const populated = link as LabLinkWithReferences;
  const patient = isPopulatedUser(populated.patientId) ? populated.patientId : null;
  const lab = isPopulatedUser(populated.labId) ? populated.labId : null;

  return {
    id: link._id.toString(),
    patient: { id: patient ? patient._id.toString() : link.patientId.toString(), name: patient?.name ?? 'Unknown patient' },
    lab: {
      id: lab ? lab._id.toString() : link.labId.toString(),
      name: lab?.name ?? 'Unknown lab',
      ...(lab?.organisation ? { organisation: lab.organisation } : {}),
    },
    status: link.status,
    requestedAt: link.requestedAt.toISOString(),
    ...(link.approvedAt ? { approvedAt: link.approvedAt.toISOString() } : {}),
    ...(link.rejectedAt ? { rejectedAt: link.rejectedAt.toISOString() } : {}),
    ...(link.revokedAt ? { revokedAt: link.revokedAt.toISOString() } : {}),
  };
};

const populateLink = async (link: ILabLink) =>
  link.populate([
    { path: 'patientId', select: USER_FIELDS },
    { path: 'labId', select: USER_FIELDS },
  ]);

const auditLink = async (
  req: AuthenticatedRequest,
  actorId: string,
  action: 'LAB_LINK_REQUESTED' | 'LAB_LINKED' | 'LAB_LINK_REJECTED' | 'LAB_UNLINKED',
  link: ILabLink
) =>
  createAuditLog({
    userId: actorId,
    action,
    ipAddress: getRequestIpAddress(req),
    metadata: {
      labLinkId: link._id.toString(),
      labId: link.labId.toString(),
      patientId: link.patientId.toString(),
      status: link.status,
    },
  });

/**
 * POST /api/lab-links  { query: <patient email | ObjectId> }   (lab)
 * Uses the same exact-match lookup, identical-404 rule, PATIENT_LOOKUP audit and (in the router) the same
 * per-user rate limit as GET /patients/lookup — a lab must not be a cheaper enumeration path than a doctor.
 */
export const requestLabLink: RequestHandler = asyncHandler(async (req, res) => {
  const lab = (req as AuthenticatedRequest).user;

  if (!lab) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const outcome = await findPatientByQuery(readLookupQuery(body.query));

  if (outcome.kind === 'invalid') {
    res.status(400).json({ message: LOOKUP_QUERY_REQUIRED_MESSAGE });
    return;
  }

  await auditPatientLookup(req, lab.id, outcome);

  if (outcome.kind === 'not_found') {
    res.status(404).json({ message: PATIENT_NOT_FOUND_MESSAGE });
    return;
  }

  const patientId = outcome.patient._id;
  const existing = await LabLink.findOne({ labId: lab.id, patientId, status: { $in: ['PENDING', 'ACTIVE'] } });

  if (existing) {
    res.status(409).json({
      message: existing.status === 'ACTIVE' ? 'This patient has already authorised your lab' : 'A link request is already pending with this patient',
    });
    return;
  }

  let link: ILabLink;

  try {
    link = await LabLink.create({ labId: lab.id, patientId, status: 'PENDING' });
  } catch (error) {
    // Partial unique index: two concurrent requests for the same pair — surface the same 409 as above.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      res.status(409).json({ message: 'A link request is already pending with this patient' });
      return;
    }

    throw error;
  }

  await auditLink(req as AuthenticatedRequest, lab.id, 'LAB_LINK_REQUESTED', link);
  emitAppEvent('lab.link.requested', {
    ...eventBase({
      recipientUserId: patientId.toString(),
      actorUserId: lab.id,
      actorName: lab.name,
      documentId: null,
      message: `${lab.name} requests permission to upload reports to your vault`,
    }),
    documentId: null,
    labLinkId: link._id.toString(),
    labName: lab.name,
    ...(lab.organisation ? { organisation: lab.organisation } : {}),
  });
  await populateLink(link);
  res.status(201).json({ message: 'Link request sent to patient', link: serializeLabLink(link) });
});

/**
 * GET /api/lab-links   (patient: my PENDING + ACTIVE links; lab: every link I requested, any status)
 */
export const listLabLinks: RequestHandler = asyncHandler(async (req, res) => {
  const user = (req as AuthenticatedRequest).user;

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const filter: Record<string, unknown> =
    user.role === 'lab' ? { labId: user.id } : { patientId: user.id, status: { $in: ['PENDING', 'ACTIVE'] } };

  const links = await LabLink.find(filter)
    .sort({ requestedAt: -1 })
    .populate('patientId', USER_FIELDS)
    .populate('labId', USER_FIELDS);

  res.json({ links: links.map(serializeLabLink) });
});

const transitionLabLink = (
  nextStatus: 'ACTIVE' | 'REJECTED' | 'REVOKED',
  requiredStatus: 'PENDING' | 'ACTIVE',
  action: 'LAB_LINKED' | 'LAB_LINK_REJECTED' | 'LAB_UNLINKED',
  successMessage: string
): RequestHandler =>
  asyncHandler(async (req, res) => {
    const patient = (req as AuthenticatedRequest).user as SafeUser | undefined;

    if (!patient) {
      res.status(401).json({ message: 'Authentication is required' });
      return;
    }

    const linkId = getIdParam(req.params.id);

    if (!Types.ObjectId.isValid(linkId)) {
      res.status(400).json({ message: 'A valid lab link ID is required' });
      return;
    }

    const link = await LabLink.findById(linkId);

    if (!link) {
      res.status(404).json({ message: 'Lab link not found' });
      return;
    }

    if (!link.patientId.equals(patient.id)) {
      res.status(403).json({ message: 'You do not have permission to change this lab link' });
      return;
    }

    if (link.status !== requiredStatus) {
      res.status(409).json({ message: `Only ${requiredStatus.toLowerCase()} lab links can be ${successMessage.toLowerCase()}` });
      return;
    }

    link.status = nextStatus;
    if (nextStatus === 'ACTIVE') link.approvedAt = new Date();
    if (nextStatus === 'REJECTED') link.rejectedAt = new Date();
    if (nextStatus === 'REVOKED') link.revokedAt = new Date();
    await link.save();

    await auditLink(req as AuthenticatedRequest, patient.id, action, link);

    // Only approval notifies the lab; rejection and revocation are audit-only in Phase 0.
    if (nextStatus === 'ACTIVE') {
      emitAppEvent('lab.link.approved', {
        ...eventBase({
          recipientUserId: link.labId.toString(),
          actorUserId: patient.id,
          actorName: patient.name,
          documentId: null,
          message: `${patient.name} authorised your lab to upload reports`,
        }),
        documentId: null,
        labLinkId: link._id.toString(),
        patientName: patient.name,
      });
    }

    await populateLink(link);
    res.json({ message: `Lab link ${successMessage.toLowerCase()}`, link: serializeLabLink(link) });
  });

/** PATCH /api/lab-links/:id/approve (patient, owner): PENDING -> ACTIVE */
export const approveLabLink = transitionLabLink('ACTIVE', 'PENDING', 'LAB_LINKED', 'Approved');
/** PATCH /api/lab-links/:id/reject (patient, owner): PENDING -> REJECTED */
export const rejectLabLink = transitionLabLink('REJECTED', 'PENDING', 'LAB_LINK_REJECTED', 'Rejected');
/** DELETE /api/lab-links/:id (patient, owner): ACTIVE -> REVOKED. Reports already issued stay readable by the lab. */
export const revokeLabLink = transitionLabLink('REVOKED', 'ACTIVE', 'LAB_UNLINKED', 'Revoked');

/** Used by the report upload to gate on an ACTIVE link. */
export const findActiveLabLink = (labId: string, patientId: Types.ObjectId | string) =>
  LabLink.findOne({ labId, patientId, status: 'ACTIVE' });
