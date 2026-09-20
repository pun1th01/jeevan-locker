import type { User } from './auth';

// Mirrors AUDIT_ACTIONS in server/src/models/AccessLog.ts — keep the two lists in sync.
export type AuditAction =
  | 'USER_LOGIN'
  | 'DOCUMENT_UPLOAD'
  | 'DOCUMENT_ACCESS'
  | 'DOCUMENT_PREVIEW'
  | 'DOCUMENT_DOWNLOAD'
  | 'DOCUMENT_SHARE'
  | 'DOCUMENT_UNSHARED'
  | 'DOCUMENT_DELETED'
  | 'DOCUMENT_UPDATED'
  | 'INTEGRITY_VERIFIED'
  | 'CONSENT_REQUESTED'
  | 'CONSENT_APPROVED'
  | 'CONSENT_REJECTED'
  | 'CONSENT_REVOKED'
  | 'EMERGENCY_ACCESS_GRANTED'
  | 'EMERGENCY_ACCESS_REVOKED'
  | 'EMERGENCY_ACCESS_EXPIRED'
  | 'PATIENT_LOOKUP'
  | 'LAB_LINK_REQUESTED'
  | 'LAB_LINKED'
  | 'LAB_LINK_REJECTED'
  | 'LAB_UNLINKED'
  | 'LAB_REPORT_UPLOADED'
  | 'NOTIFICATION_SENT'
  | 'ADMIN_CREATED'
  | 'DOCTOR_VERIFIED';

export interface AuditDocumentSummary {
  id: string;
  title: string;
  originalFileName: string;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  user: User;
  action: AuditAction;
  targetDocument: AuditDocumentSummary | null;
  timestamp: string;
  ipAddress: string;
  metadata?: Record<string, string>;
}

export interface AuditSummary {
  totalUsers: number;
  totalDocuments: number;
  recentActivity: AuditLogEntry[];
}
