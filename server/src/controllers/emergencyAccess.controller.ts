import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { EmergencyAccess, type IEmergencyAccess } from '../models/EmergencyAccess';
import { MedicalDocument } from '../models/MedicalDocument';
import { User } from '../models/User';
import type { AuthenticatedRequest } from '../types/auth.types';
import { createAuditLog, getRequestIpAddress } from '../utils/audit.util';
import { asyncHandler } from '../utils/asyncHandler.util';
import { findApprovedConsent } from '../utils/consent.util';
import { emitAppEvent, eventBase } from '../events/appEvents';
import { enqueueEmergencyAnchor } from '../services/anchorQueue.service';
import { serializeAnchorReferences } from '../utils/anchors.util';
import {
  EMERGENCY_ACCESS_DURATION_MS,
  EMERGENCY_ACCESS_DURATION_MINUTES,
  findActiveEmergencyAccess,
} from '../utils/emergencyAccess.util';

interface EmergencyAccessResponse {
  id: string;
  doctorId: string;
  patientId: string;
  documentId: string;
  reason: string;
  status: 'ACTIVE' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
  anchors?: Record<string, { digest: string; txHash: string; blockNumber: number; anchoredAt: string }>;
}

const getAuthenticatedDoctor = (req: AuthenticatedRequest) => req.user ?? null;

const serializeEmergencyAccess = (emergencyAccess: IEmergencyAccess): EmergencyAccessResponse => ({
  id: emergencyAccess._id.toString(),
  doctorId: emergencyAccess.doctorId.toString(),
  patientId: emergencyAccess.patientId.toString(),
  documentId: emergencyAccess.documentId.toString(),
  reason: emergencyAccess.reason,
  status: emergencyAccess.status,
  createdAt: emergencyAccess.createdAt.toISOString(),
  expiresAt: emergencyAccess.expiresAt.toISOString(),
  anchors: serializeAnchorReferences(emergencyAccess.anchors),
});

const getRequestString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export const grantEmergencyAccess: RequestHandler = asyncHandler(async (req, res) => {
  const doctor = getAuthenticatedDoctor(req as AuthenticatedRequest);

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

  const expiresAt = new Date(Date.now() + EMERGENCY_ACCESS_DURATION_MS);
  const emergencyAccess = await EmergencyAccess.create({
    doctorId: doctor.id,
    patientId: patient._id,
    documentId: document._id,
    reason,
    status: 'ACTIVE',
    expiresAt,
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
    },
  });

  await enqueueEmergencyAnchor(emergencyAccess, document.documentHash ?? null);

  // Only a NEW grant notifies; the "already active" path above returns without emitting.
  emitAppEvent('emergency.granted', {
    ...eventBase({
      recipientUserId: patient._id.toString(),
      actorUserId: doctor.id,
      actorName: doctor.name,
      documentId: document._id.toString(),
      message: `${doctor.name} used emergency access on "${document.title}"`,
    }),
    documentId: document._id.toString(),
    emergencyAccessId: emergencyAccess._id.toString(),
    documentTitle: document.title,
    reason,
    expiresAt: expiresAt.toISOString(),
  });

  res.status(201).json({
    message: `Emergency access granted for ${EMERGENCY_ACCESS_DURATION_MINUTES} minutes`,
    emergencyAccess: serializeEmergencyAccess(emergencyAccess),
  });
});
