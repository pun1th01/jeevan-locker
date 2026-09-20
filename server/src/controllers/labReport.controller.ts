import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import type { IMedicalDocument } from '../models/MedicalDocument';
import { User } from '../models/User';
import { DocumentIngestError, discardUploadedFile, ingestUploadedDocument, type LabReportFields } from '../services/documentIngest.service';
import type { AuthenticatedRequest } from '../types/auth.types';
import { createAuditLog, getRequestIpAddress } from '../utils/audit.util';
import { asyncHandler } from '../utils/asyncHandler.util';
import { parseTestValues } from '../utils/testValues.util';
import { findActiveLabLink } from './labLink.controller';
import { populateDocumentUsers, serializeMedicalDocument } from './document.controller';

export const LAB_NOT_AUTHORISED_MESSAGE = 'This patient has not authorised your lab';

const REPORT_TEXT_FIELDS = ['labName', 'testName', 'nablCertNumber', 'authorizingDoctorName', 'hospitalName'] as const;
const REPORT_TEXT_MAX_LENGTH = 120;

type ReportTextField = (typeof REPORT_TEXT_FIELDS)[number];

const readOptionalText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * POST /api/lab/reports  (lab, multipart/form-data)
 * Fields: file, patientId, title, labName?, testName?, nablCertNumber?, authorizingDoctorName?, hospitalName?,
 *         reportDate? (ISO 8601, not in the future), testValues? (JSON array string).
 * Requires an ACTIVE LabLink for (lab, patient). Every failure after multer has written the file unlinks it;
 * the ingest service additionally rolls back the DB row if the chain write fails — identical to the patient upload.
 */
export const uploadLabReport: RequestHandler = asyncHandler(async (req, res) => {
  const lab = (req as AuthenticatedRequest).user;

  if (!lab) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const file = req.file;

  if (!file) {
    res.status(400).json({ message: 'A PDF, JPG, or PNG report file is required' });
    return;
  }

  const fail = async (status: number, body: Record<string, unknown>) => {
    await discardUploadedFile(file.path);
    res.status(status).json(body);
  };

  const body = (req.body ?? {}) as Record<string, unknown>;
  const patientId = typeof body.patientId === 'string' ? body.patientId.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';

  if (!Types.ObjectId.isValid(patientId)) {
    await fail(400, { message: 'A valid patient ID is required' });
    return;
  }

  if (!title || title.length > 120) {
    await fail(400, { message: 'Report title must be 1 to 120 characters' });
    return;
  }

  const textFields: Partial<Record<ReportTextField, string>> = {};

  for (const field of REPORT_TEXT_FIELDS) {
    const value = readOptionalText(body[field]);

    if (value !== undefined && value.length > REPORT_TEXT_MAX_LENGTH) {
      await fail(400, { message: `${field} must be ${REPORT_TEXT_MAX_LENGTH} characters or fewer` });
      return;
    }

    if (value !== undefined) {
      textFields[field] = value;
    }
  }

  let reportDate: Date | undefined;
  const rawReportDate = readOptionalText(body.reportDate);

  if (rawReportDate !== undefined) {
    reportDate = new Date(rawReportDate);

    if (Number.isNaN(reportDate.getTime())) {
      await fail(400, { message: 'reportDate must be an ISO 8601 date' });
      return;
    }

    if (reportDate.getTime() > Date.now()) {
      await fail(400, { message: 'reportDate cannot be in the future' });
      return;
    }
  }

  const testValues = parseTestValues(body.testValues);

  if (testValues.error || !testValues.values) {
    await fail(400, { message: testValues.error ?? 'testValues is invalid' });
    return;
  }

  const patient = await User.findOne({ _id: patientId, role: 'patient' }).select('_id');

  if (!patient) {
    await fail(404, { message: 'Patient not found' });
    return;
  }

  const link = await findActiveLabLink(lab.id, patient._id);

  if (!link) {
    await fail(403, { message: LAB_NOT_AUTHORISED_MESSAGE });
    return;
  }

  const labReport: LabReportFields = {
    uploadedByLab: lab.id,
    ...textFields,
    ...(reportDate ? { reportDate } : {}),
    testValues: testValues.values,
  };

  let document: IMedicalDocument;

  try {
    document = await ingestUploadedDocument({ file, title, uploadedBy: patient._id, labReport });
  } catch (error) {
    if (error instanceof DocumentIngestError) {
      res.status(error.statusCode).json({ message: error.message });
      return;
    }

    throw error;
  }

  await createAuditLog({
    userId: lab.id,
    action: 'LAB_REPORT_UPLOADED',
    targetDocument: document._id,
    ipAddress: getRequestIpAddress(req),
    metadata: {
      patientId: patient._id.toString(),
      labLinkId: link._id.toString(),
      testValueCount: String(testValues.values.length),
      criticalCount: String(testValues.values.filter((value) => value.flag === 'critical').length),
    },
  });

  const populatedDocument = await populateDocumentUsers(document);
  res.status(201).json({ document: serializeMedicalDocument(populatedDocument) });
});
