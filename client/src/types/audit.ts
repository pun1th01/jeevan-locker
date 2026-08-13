import type { User } from './auth';

export type AuditAction =
  | 'USER_LOGIN'
  | 'DOCUMENT_UPLOAD'
  | 'DOCUMENT_ACCESS'
  | 'DOCUMENT_PREVIEW'
  | 'DOCUMENT_DOWNLOAD'
  | 'DOCUMENT_SHARE'
  | 'CONSENT_REQUESTED'
  | 'CONSENT_APPROVED'
  | 'CONSENT_REJECTED'
  | 'CONSENT_REVOKED'
  | 'EMERGENCY_ACCESS_GRANTED';

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
