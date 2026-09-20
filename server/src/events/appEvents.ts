import { EventEmitter } from 'node:events';

/**
 * In-process application events. One emitter, no queue, no persistence, no retry, at-most-once.
 * Listeners run asynchronously (setImmediate) and in isolation: a throwing or rejecting listener is
 * logged and can never fail or slow the HTTP request that emitted. Every emit site sits AFTER the
 * database write and the audit row, so listeners may assume the referenced ids exist.
 * Contract documented in docs/EVENTS.md — change both together.
 */

export const APP_EVENT_NAMES = [
  'consent.requested',
  'consent.approved',
  'consent.rejected',
  'consent.revoked',
  'emergency.granted',
  'emergency.revoked',
  'document.shared',
  'lab.link.requested',
  'lab.link.approved',
  'lab.report.uploaded',
] as const;

export type AppEventName = (typeof APP_EVENT_NAMES)[number];

/** Every event carries exactly these; a notification row can be written from the base alone. */
export interface AppEventBase {
  /** Who should see the notification. */
  recipientUserId: string;
  /** Who caused it — always the authenticated user at the emit site. */
  actorUserId: string;
  /** Display name of the actor, so a listener needs no extra lookup. */
  actorName: string;
  /** null only for lab.link.* — there is no document yet. */
  documentId: string | null;
  /** Short, display-ready, English, no markup. */
  message: string;
  /** ISO 8601, server clock. */
  occurredAt: string;
}

export interface AppEventMap {
  'consent.requested': AppEventBase & { documentId: string; consentId: string; documentTitle: string; purpose: string };
  'consent.approved': AppEventBase & { documentId: string; consentId: string; documentTitle: string };
  'consent.rejected': AppEventBase & { documentId: string; consentId: string; documentTitle: string };
  'consent.revoked': AppEventBase & { documentId: string; consentId: string; documentTitle: string };
  'emergency.granted': AppEventBase & {
    documentId: string;
    emergencyAccessId: string;
    documentTitle: string;
    reason: string;
    expiresAt: string;
  };
  /** Typed so the shape is fixed now; NOT emitted anywhere until a revoke feature exists. */
  'emergency.revoked': AppEventBase & { documentId: string; emergencyAccessId: string; documentTitle: string };
  'document.shared': AppEventBase & { documentId: string; documentTitle: string };
  'lab.link.requested': AppEventBase & { documentId: null; labLinkId: string; labName: string; organisation?: string };
  'lab.link.approved': AppEventBase & { documentId: null; labLinkId: string; patientName: string };
  'lab.report.uploaded': AppEventBase & { documentId: string; documentTitle: string; labName: string; criticalCount: number };
}

export type AppEventListener<N extends AppEventName> = (payload: AppEventMap[N]) => void | Promise<void>;
export type AnyAppEventListener = <N extends AppEventName>(name: N, payload: AppEventMap[N]) => void | Promise<void>;

const ANY_EVENT = Symbol('app-event:any');

const emitter = new EventEmitter();
// A notification writer plus a few feature listeners is normal; keep Node's "possible leak" warning quiet.
emitter.setMaxListeners(50);

const runIsolated = (name: AppEventName, run: () => void | Promise<void>) => {
  setImmediate(() => {
    try {
      const result = run();

      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((error: unknown) => {
          console.error(`[events] listener for ${name} rejected:`, error);
        });
      }
    } catch (error) {
      console.error(`[events] listener for ${name} threw:`, error);
    }
  });
};

/** Fire-and-forget. Returns synchronously; listeners run on the next macrotask, each isolated. */
export const emitAppEvent = <N extends AppEventName>(name: N, payload: AppEventMap[N]): void => {
  emitter.emit(name, payload);
  emitter.emit(ANY_EVENT, name, payload);
};

/** Subscribe to one event. Returns an unsubscribe function. */
export const onAppEvent = <N extends AppEventName>(name: N, listener: AppEventListener<N>): (() => void) => {
  const wrapped = (payload: AppEventMap[N]) => runIsolated(name, () => listener(payload));
  emitter.on(name, wrapped);
  return () => {
    emitter.off(name, wrapped);
  };
};

/** Subscribe to every event — what a notification writer wants. Returns an unsubscribe function. */
export const onAnyAppEvent = (listener: AnyAppEventListener): (() => void) => {
  const wrapped = <N extends AppEventName>(name: N, payload: AppEventMap[N]) => runIsolated(name, () => listener(name, payload));
  emitter.on(ANY_EVENT, wrapped);
  return () => {
    emitter.off(ANY_EVENT, wrapped);
  };
};

/** Shared helper so every emit site stamps the base fields the same way. */
export const eventBase = (input: Omit<AppEventBase, 'occurredAt'>): AppEventBase => ({
  ...input,
  occurredAt: new Date().toISOString(),
});
