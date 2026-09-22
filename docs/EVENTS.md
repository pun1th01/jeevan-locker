# JeevanLocker — Application Events

The in-process event contract that the Notification feature (model, endpoints, bell) is built on. Written from the implemented code in `server/src/events/appEvents.ts` and the emit sites listed below (Phase 0, Task 3). If the code and this file disagree, the code wins — open an issue.

Related: [API_LAB.md](API_LAB.md), [API_ADMIN.md](API_ADMIN.md).

---

## 1. What this is (and isn't)

- **One typed emitter** over a single Node `EventEmitter`. Module: `server/src/events/appEvents.ts`.
- **In-process only.** No queue, no persistence, no retry, no cross-process delivery. **At-most-once**: a server restart loses anything emitted but not yet handled. If a notification must survive that, the listener has to persist it — that is the Notification model's job.
- **Asynchronous and isolated.** `emitAppEvent()` returns synchronously; every listener runs on the next macrotask via `setImmediate`, each wrapped in `try/catch`. A listener that throws or rejects is logged with `console.error('[events] listener for <name> threw|rejected:', error)` and **can never fail or slow the HTTP request** that emitted. Order between listeners of the same event is registration order; order across different events is not guaranteed.
- **Emitted only after persistence + audit.** Every emit site sits after the database write and after the `AccessLog` row. A listener may assume every id in the payload exists and that the corresponding audit row is already there.
- The emitter does **not** write `NOTIFICATION_SENT` audit rows. That is the Notification listener's responsibility, once per notification it actually creates.

---

## 2. Event names

```ts
export const APP_EVENT_NAMES = [
  'consent.requested',
  'consent.approved',
  'consent.rejected',
  'consent.revoked',
  'emergency.granted',
  'emergency.revoked',      // emitted since Phase 1 task 7 (patient revocation)
  'document.shared',
  'lab.link.requested',
  'lab.link.approved',
  'lab.report.uploaded',
] as const;
export type AppEventName = (typeof APP_EVENT_NAMES)[number];
```

---

## 3. Payload shapes

### Base — every event has exactly these six fields

```ts
export interface AppEventBase {
  recipientUserId: string;     // who should see the notification
  actorUserId: string;         // who caused it — always the authenticated user at the emit site
  actorName: string;           // display name of the actor; no lookup needed to render a row
  documentId: string | null;   // null ONLY for lab.link.* (there is no document yet)
  message: string;             // short, display-ready, English, no markup (exact strings in §5)
  occurredAt: string;          // ISO 8601, server clock
}
```

A Notification row can be written from the base alone; the per-event extras are for richer rendering or deduplication.

### Per event

```ts
export interface AppEventMap {
  'consent.requested':   AppEventBase & { documentId: string; consentId: string; documentTitle: string; purpose: string };
  'consent.approved':    AppEventBase & { documentId: string; consentId: string; documentTitle: string };
  'consent.rejected':    AppEventBase & { documentId: string; consentId: string; documentTitle: string };
  'consent.revoked':     AppEventBase & { documentId: string; consentId: string; documentTitle: string };
  'emergency.granted':   AppEventBase & { documentId: string; emergencyAccessId: string; documentTitle: string; reason: string; expiresAt: string; afterRevocation: boolean };
  'emergency.revoked':   AppEventBase & { documentId: string; emergencyAccessId: string; documentTitle: string };
  'document.shared':     AppEventBase & { documentId: string; documentTitle: string };
  'lab.link.requested':  AppEventBase & { documentId: null; labLinkId: string; labName: string; organisation?: string };
  'lab.link.approved':   AppEventBase & { documentId: null; labLinkId: string; patientName: string };
  'lab.report.uploaded': AppEventBase & { documentId: string; documentTitle: string; labName: string; criticalCount: number };
}
```

Notes:
- `expiresAt` (emergency) is ISO 8601 — the grant lasts 15 minutes from `occurredAt`.
- `organisation` on `lab.link.requested` is present only when the lab account has one (labs always do; the key is omitted, not `undefined`, when absent).
- `criticalCount` is the number of `testValues` entries flagged `critical` on the uploaded report (0 when none, or when no test values were supplied).
- `consent.*` events for `approved`/`rejected`/`revoked` carry `documentTitle` looked up at emit time; if the document has since been deleted (no delete endpoint exists in Phase 0) it falls back to `"a document"`.

---

## 4. Who gets what, from where

| Event | `recipientUserId` | `actorUserId` | Emitted from | Condition |
|---|---|---|---|---|
| `consent.requested` | the patient | the doctor | `consent.controller.ts` → `requestConsent` | after `CONSENT_REQUESTED` audit, on the `201` path |
| `consent.approved` | the doctor | the patient | `consent.controller.ts` → `updateConsent` | after `CONSENT_APPROVED` audit |
| `consent.rejected` | the doctor | the patient | same | after `CONSENT_REJECTED` audit |
| `consent.revoked` | the doctor | the patient | same | after `CONSENT_REVOKED` audit |
| `emergency.granted` | the patient | the doctor | `emergencyAccess.controller.ts` → `grantEmergencyAccess` | **only on a new grant (`201`)**. The "Emergency access is already active" `200` path does **not** emit |
| `emergency.revoked` | **the doctor** losing access | the patient | `emergencyAccess.controller.ts` → `revokeEmergencyAccess` | after the `EMERGENCY_ACCESS_REVOKED` audit row, only when the `ACTIVE → REVOKED` transition actually happened (the `409` path does not emit) |
| `document.shared` | the doctor | the patient | `document.controller.ts` → `shareDocumentWithDoctor` | **only when the doctor was actually added**. The "Doctor already has access" path does **not** emit |
| `lab.link.requested` | the patient | the lab | `labLink.controller.ts` → `requestLabLink` | after `LAB_LINK_REQUESTED` audit, on the `201` path |
| `lab.link.approved` | the lab | the patient | `labLink.controller.ts` → `transitionLabLink` (`ACTIVE` branch) | after `LAB_LINKED` audit. Rejection and revocation are **audit-only**, no event |
| `lab.report.uploaded` | the patient | the lab | `labReport.controller.ts` → `uploadLabReport` | after `LAB_REPORT_UPLOADED` audit — i.e. after the file is on disk, the row exists and the hash is on-chain |

Not emitted anywhere (by design): break-glass **expiry** (`EMERGENCY_ACCESS_EXPIRED` is audit-only — the grant simply ran its stated course, and the expiry time was already known to the patient from the grant notification), doctor verification, lab creation, patient lookups, integrity checks, document views/downloads, lab link rejection/revocation.

---

## 5. Exact `message` strings

`${…}` is filled at emit time. `title` is `document.title`; names are the users' `name` fields.

| Event | `message` |
|---|---|
| `consent.requested` | `${doctorName} requested access to "${title}"` |
| `consent.approved` | `${patientName} approved your access to "${title}"` |
| `consent.rejected` | `${patientName} declined your access request for "${title}"` |
| `consent.revoked` | `${patientName} revoked your access to "${title}"` |
| `emergency.granted` | `${doctorName} used emergency access on "${title}"` — **or**, when `afterRevocation` is true, `${doctorName} used emergency access on "${title}" again after you revoked it`. Render both variants. |
| `emergency.revoked` | `${patientName} revoked your emergency access to "${title}"` |
| `document.shared` | `${patientName} shared "${title}" with you` |
| `lab.link.requested` | `${labName} requests permission to upload reports to your vault` |
| `lab.link.approved` | `${patientName} authorised your lab to upload reports` |
| `lab.report.uploaded` | `${labName} added a verified report "${title}" to your vault` — with ` (N critical value)` / ` (N critical values)` appended when `criticalCount > 0` |

---

## 6. Subscribing

```ts
import { onAppEvent, onAnyAppEvent } from '../events/appEvents';

// one event
const off = onAppEvent('document.shared', async (payload) => {
  // payload is AppEventMap['document.shared']
});
off(); // unsubscribe

// every event — what a notification writer wants
onAnyAppEvent(async (name, payload) => {
  // name is narrowed per call; payload matches AppEventMap[name]
});
```

Listeners are registered **once at boot** in `server/src/events/registerListeners.ts`:

```ts
export const registerAppEventListeners = (): void => {
  registerNoopListener();          // Phase 0 placeholder: console.debug in development, no-op otherwise
  // registerNotificationListener(); // <- Notification feature adds its listener here
};
```

`index.ts` calls `registerAppEventListeners()` after `connectDB()` and before `app.listen()`. Nothing else in the codebase needs to know a listener exists. A listener may be `async`; its rejection is caught and logged. Do not register listeners from inside controllers or per request.

### Emitting (for anyone adding a new site)

```ts
import { emitAppEvent, eventBase } from '../events/appEvents';

emitAppEvent('document.shared', {
  ...eventBase({ recipientUserId, actorUserId: user.id, actorName: user.name, documentId, message }),
  documentId,          // repeat the narrowed type
  documentTitle,
});
```

Rules for a new emit site: emit **after** the DB write and the audit row; never on an idempotent "already done" path; add the name to `APP_EVENT_NAMES` and `AppEventMap` and to this file in the same change.

---

## 7. Guidance for the Notification listener

- **Persist first, then audit.** Create the Notification row from the payload, then write one `NOTIFICATION_SENT` audit row (`userId` = `recipientUserId`, `targetDocument` = `documentId`, metadata `{ event: name, actorUserId }`). The audit action already exists in `AccessLog.ts` and the admin dashboard already renders it.
- **Dedupe key** (so a retry or a double-emit never produces two bells):
  | Event | key |
  |---|---|
  | `consent.*` | `${name}:${consentId}` |
  | `emergency.granted` / `emergency.revoked` | `${name}:${emergencyAccessId}` |
  | `document.shared` | `${name}:${documentId}:${recipientUserId}` |
  | `lab.link.*` | `${name}:${labLinkId}` |
  | `lab.report.uploaded` | `${name}:${documentId}` |
- **Don't block.** The listener runs off the request path already, but keep it to one insert; anything heavier belongs in a job.
- **Recipient is authoritative.** Render to `recipientUserId` only; never fan out to other users from a listener.
- **`emergency.granted` has two message variants.** `afterRevocation: true` means this grant re-opened access the patient revoked within the last `EMERGENCY_REGRANT_WINDOW_HOURS` (default 24); the message says so, and the flag is on the payload so a listener can style it as an escalation rather than parse text.
- **Roles of the recipient by event:** patient — `consent.requested`, `emergency.granted`, `lab.link.requested`, `lab.report.uploaded`; doctor — `consent.approved|rejected|revoked`, `document.shared`, `emergency.revoked`; lab — `lab.link.approved`.
- The `message` is safe to render as text. It is not HTML.
