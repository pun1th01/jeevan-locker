import type { AppEventMap, AppEventName } from '../appEvents';
import { onAnyAppEvent } from '../appEvents';
import { AccessLog } from '../../models/AccessLog';
import { Notification } from '../../models/Notification';

const getDedupeKey = (name: AppEventName, payload: AppEventMap[AppEventName]): string => {
  if ('consentId' in payload) {
    return `${name}:${payload.consentId}`;
  }

  if ('emergencyAccessId' in payload) {
    return `${name}:${payload.emergencyAccessId}`;
  }

  if ('labLinkId' in payload) {
    return `${name}:${payload.labLinkId}`;
  }

  if (name === 'document.shared') {
    return `${name}:${payload.documentId}:${payload.recipientUserId}`;
  }

  return `${name}:${payload.documentId}`;
};

/**
 * Persists every app event for its declared recipient. This listener remains independently defensive even though
 * the emitter already isolates failures, so future changes cannot accidentally leak a persistence failure to a request.
 */
export const registerNotificationListener = (): void => {
  onAnyAppEvent(async (name, payload) => {
    try {
      const notification = await Notification.create({
        recipientUserId: payload.recipientUserId,
        actorUserId: payload.actorUserId,
        actorName: payload.actorName,
        eventName: name,
        message: payload.message,
        documentId: payload.documentId,
        dedupeKey: getDedupeKey(name, payload),
        read: false,
        createdAt: new Date(payload.occurredAt),
      });

      await AccessLog.create({
        userId: notification.recipientUserId,
        action: 'NOTIFICATION_SENT',
        targetDocument: notification.documentId,
        timestamp: new Date(),
        ipAddress: 'events',
        metadata: { event: name, actorUserId: payload.actorUserId },
      });
    } catch (error) {
      const isDuplicate =
        typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11000;

      if (!isDuplicate) {
        console.error(`[notifications] failed to persist ${name}:`, error);
      }
    }
  });
};
