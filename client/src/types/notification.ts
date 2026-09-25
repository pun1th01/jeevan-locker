export type NotificationEventName =
  | 'consent.requested'
  | 'consent.approved'
  | 'consent.rejected'
  | 'consent.revoked'
  | 'emergency.granted'
  | 'emergency.revoked'
  | 'document.shared'
  | 'lab.link.requested'
  | 'lab.link.approved'
  | 'lab.report.uploaded';

export interface Notification {
  id: string;
  actorName: string;
  eventName: NotificationEventName;
  message: string;
  documentId: string | null;
  read: boolean;
  createdAt: string;
}
