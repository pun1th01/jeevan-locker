# JeevanLocker — Consent and Emergency Access API

How a doctor gains access to a patient's document when it has not been shared directly: by **consent** (the patient approves a request) or by **break-glass emergency access** (the doctor opens the record at once, time-limited, audited and anchored, and the patient can end it). Written from the implemented code in `server/src/controllers/consent.controller.ts`, `emergencyAccess.controller.ts`, `patients.controller.ts` and `server/src/utils/emergencyAccess.util.ts`; every status and message below is the exact value the server sends. If the code and this file disagree, the code wins — open an issue.

Related: [API_LAB.md](API_LAB.md) (the lab role and lab links), [API_ADMIN.md](API_ADMIN.md) (doctor verification), [EVENTS.md](EVENTS.md) (the notification events these calls emit), [ANCHORING.md](ANCHORING.md) (the on-chain anchors they enqueue), [TESTING.md](TESTING.md) (claims C5–C8, C13, C16 and C34–C39 test this behaviour).

---

## 1. Basics

- Base URL `http://localhost:5000/api`; `Authorization: Bearer <jwt>` from `POST /auth/login`. Every route here requires a token.
- Identity and role are reloaded from the database on every request; the role inside the token is ignored.

Errors common to every route:

| Status | Message | When |
|---|---|---|
| 401 | `Authentication token is required` | no `Authorization: Bearer …` header |
| 401 | `Invalid authentication token` | malformed token, wrong signature, no `userId` claim |
| 401 | `Authentication token has expired` | |
| 401 | `Authenticated user no longer exists` | user deleted after the token was issued |
| 403 | `You do not have permission to access this resource` | wrong role for the route |
| 403 | `Your doctor account is awaiting admin verification` | an **unverified doctor** on `POST /consents/request` or `POST /emergency-access` (and `GET /patients/lookup`) — see API_ADMIN.md §3 |

**Rate limits.** None of the consent or emergency-access routes is rate-limited. The doctor's way in — `GET /patients/lookup` (§2) — is: 30 lookups per doctor per 15 minutes, counted *before* the verification gate. Break-glass is instead bounded by the live-grant cap (§5.3).

**IDs.** All ids are 24-hex MongoDB ObjectIds. A malformed `:id` is a `400`; a well-formed id that matches nothing is a `404`.

---

## 2. Finding the patient and the document — `GET /api/patients/lookup`

Role: **doctor, verified**. Middleware order: `verifyToken → requireRole('doctor') → rate limiter → requireVerifiedDoctor → handler`, so an unverified doctor's attempts still count toward the limit.

Query: `query` — a patient's email or id. Trimmed; a 24-hex value is matched against `_id`, anything else is lower-cased and matched against `email`; always restricted to `role: 'patient'`. No prefix or partial search.

Response `200`:

```ts
{
  patient: { id: string; name: string };
  documents: Array<{
    id: string;
    title: string;
    createdAt: string;                 // ISO 8601
    access: 'none' | 'shared' | 'consent_approved' | 'consent_pending' | 'emergency_active';
    emergencyActive: boolean;          // independent of `access`: a live break-glass grant exists
    emergencyExpiresAt?: string;       // present when emergencyActive
  }>;                                  // newest first
}
```

`access` is this doctor's relationship to each document, one value by precedence: `shared` > `consent_approved` > `consent_pending` > `emergency_active` > `none`. The lookup first expires this doctor's lapsed grants, so `emergencyActive` is never stale.

| Status | Message | When |
|---|---|---|
| 400 | `A patient email or ID is required` | `query` missing, blank, or longer than 254 characters |
| 404 | `No patient found for that email or ID` | no patient matches — **byte-identical** whether the address is unknown or belongs to a doctor, admin or lab |
| 429 | `Too many patient lookups. Try again later.` | the 31st lookup in 15 minutes by this doctor |

Audit: every evaluated lookup (`200` and `404`) writes `PATIENT_LOOKUP`, actor the doctor, `metadata: { query, matchedBy: 'email' | 'id', found: 'true' | 'false', patientId? }` — the raw query is kept on purpose.

---

## 3. Consent

### 3.1 State machine

```
            POST /consents/request (doctor, verified)
                          │
                          ▼
                       PENDING
                      /        \
   PATCH …/approve   /          \   PATCH …/reject      (the patient the consent names)
                    ▼            ▼
                APPROVED       REJECTED   (terminal)
                    │
   PATCH …/revoke   │                                    (the same patient)
                    ▼
                 REVOKED   (terminal)
```

- **Only `APPROVED` grants access** — read access to that one document, for that one doctor, until revoked. `PENDING`, `REJECTED` and `REVOKED` grant nothing.
- At most **one open consent** (`PENDING` or `APPROVED`) per doctor + document, enforced by a partial unique index. After a rejection or revocation the doctor may request again.
- Each transition sets its own timestamp once: `approvedAt`, `rejectedAt`, `revokedAt` (`requestedAt` at creation). Timestamps are never cleared.
- A consent request is **not** blocked by an existing direct share or a live break-glass grant.

### 3.2 `Consent` shape

```ts
interface Consent {
  id: string;
  patient:  { id: string; name: string };
  doctor:   { id: string; name: string };
  document: { id: string; title: string };
  purpose: string;                       // 1–500 characters, as the doctor wrote it
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';
  requestedAt: string;                   // ISO 8601
  approvedAt?: string;
  rejectedAt?: string;
  revokedAt?: string;
  anchors?: Partial<Record<'requested' | 'approved' | 'rejected' | 'revoked', AnchorReference>>;
}

interface AnchorReference { digest: string; txHash: string; blockNumber: number; anchoredAt: string }
```

`anchors` appears once at least one event of the consent is on-chain; each key appears when that event is (ANCHORING.md §8).

**Names in write responses.** The list endpoints join real names and titles. The write endpoints (`POST /consents/request` and the three `PATCH` routes) return the consent **unjoined**, so their `patient.name`, `doctor.name` and `document.title` are the placeholders `Unknown patient`, `Unknown doctor` and `Unavailable document`; the ids are correct. Read names from a list endpoint.

### 3.3 `POST /api/consents/request` — ask a patient for access

Role: **doctor, verified**.

Request (JSON):

```ts
{ patientId: string; documentId: string; purpose: string }   // purpose: 1–500 characters after trim
```

Response `201`: `{ message: 'Access request sent to patient', consent: Consent }` (status `PENDING`).

Checks, in order:

| Status | Message | When |
|---|---|---|
| 400 | `A consent purpose of 1 to 500 characters is required` | `purpose` missing, blank or over 500 characters |
| 400 | `A valid patient ID and document ID are required` | either id is not 24-hex |
| 400 | `Doctors cannot request access to their own document` | `patientId` is the caller's own id |
| 404 | `Patient not found` | no **patient** has that id |
| 404 | `Document not found` | |
| 400 | `The selected document does not belong to the selected patient` | |
| 409 | `Access is already approved` | this doctor already holds an `APPROVED` consent for the document |
| 409 | `An access request is already pending` | this doctor already has a `PENDING` request for it |
| 409 | `An access request is already pending or approved` | two requests raced; the unique index let one through |

Effects on `201`: audit `CONSENT_REQUESTED` (actor the doctor); anchor `REQUESTED` enqueued; event `consent.requested` to the patient.

### 3.4 Lists

| Route | Role | Returns |
|---|---|---|
| `GET /api/consents/my` | doctor (verified or not) | every consent **this doctor** requested, any status |
| `GET /api/consents/pending` | patient | this patient's `PENDING` consents |
| `GET /api/consents/received` | patient | this patient's `PENDING` **and** `APPROVED` consents (what can still be acted on) |

All three: `200 { consents: Consent[] }`, newest `requestedAt` first, names and titles joined. No query parameters, no pagination.

### 3.5 `PATCH /api/consents/:id/approve` · `/reject` · `/revoke` — the patient decides

Role: **patient**, and only the patient the consent names. No body.

| Route | Required status | New status | Response `200` |
|---|---|---|---|
| `…/approve` | `PENDING` | `APPROVED` | `{ message: 'Consent approved', consent }` |
| `…/reject` | `PENDING` | `REJECTED` | `{ message: 'Consent rejected', consent }` |
| `…/revoke` | `APPROVED` | `REVOKED` | `{ message: 'Consent revoked', consent }` |

| Status | Message | When |
|---|---|---|
| 400 | `A valid consent ID is required` | |
| 404 | `Consent request not found` | |
| 403 | `You do not have permission to change this consent request` | the caller is not the consent's patient |
| 409 | `Only pending consent requests can be approved` | `/approve` on a non-`PENDING` consent |
| 409 | `Only pending consent requests can be rejected` | `/reject` on a non-`PENDING` consent |
| 409 | `Only approved consent requests can be revoked` | `/revoke` on a non-`APPROVED` consent |

Effects on `200`: audit `CONSENT_APPROVED` / `CONSENT_REJECTED` / `CONSENT_REVOKED` (actor the patient); anchor `APPROVED` / `REJECTED` / `REVOKED` enqueued; event `consent.approved` / `consent.rejected` / `consent.revoked` to the doctor. A revocation takes effect on the doctor's next request.

---

## 4. Emergency access (break-glass)

### 4.1 State machine

```
        POST /emergency-access (doctor, verified)
                        │
                        ▼
                     ACTIVE ──────────────────────────────┐
                        │                                  │
   expiresAt passes     │   DELETE /emergency-access/:id   │
   (scheduled job, or   │   (the patient the grant names)  │
    the lazy sweep on   ▼                                  ▼
    the doctor's reads) EXPIRED  (terminal)             REVOKED  (terminal)
```

- A grant is **live** when `status` is `ACTIVE` **and** `expiresAt` is in the future. Every read path checks both, so a grant whose window has passed stops granting access at once, even before anything sweeps it to `EXPIRED`.
- A live grant gives read access to that one document, for that one doctor, until it expires or is revoked.
- Both transitions are terminal and guarded by one atomic, status-conditioned update: each is written — and audited — exactly once, and neither can overwrite the other.
- Expiry happens without any request: a background job runs every `EMERGENCY_EXPIRY_POLL_MS` (default 60 000 ms) and drains successive batches of `EMERGENCY_EXPIRY_BATCH_LIMIT` (200); the doctor's own reads also sweep their lapsed grants. Either way the transition is recorded as `EMERGENCY_ACCESS_EXPIRED` with IP `system`.

### 4.2 `EmergencyAccess` shape

```ts
interface EmergencyAccess {
  id: string;
  doctorId: string;
  patientId: string;
  documentId: string;
  reason: string;                        // 1–500 characters, as the doctor wrote it
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  createdAt: string;                     // ISO 8601
  expiresAt: string;                     // createdAt + EMERGENCY_ACCESS_DURATION_MINUTES
  revokedAt?: string;
  revokedBy?: string;                    // the patient
  afterRevocation?: true;                // present only when true — see §5.4
  followsRevokedGrantId?: string;        // the revoked grant this one followed
  anchors?: Partial<Record<'granted' | 'revoked', AnchorReference>>;
  doctor?:   { id: string; name: string };   // joined on GET /emergency-access
  patient?:  { id: string; name: string };   // joined on GET /emergency-access
  document?: { id: string; title: string };  // joined on GET /emergency-access
}
```

### 4.3 `POST /api/emergency-access` — break glass

Role: **doctor, verified**.

Request (JSON):

```ts
{ patientId: string; documentId: string; reason: string }   // reason: 1–500 characters after trim
```

Responses:

| Status | Body | When |
|---|---|---|
| **201** | `{ message: 'Emergency access granted for 15 minutes', emergencyAccess }` | a new grant. The duration in the message follows `EMERGENCY_ACCESS_DURATION_MINUTES` (`1 minute`, `30 seconds` for sub-minute values). |
| **200** | `{ message: 'Emergency access is already active for this document', emergencyAccess }` | this doctor already holds a live grant for the document: that grant is returned, **nothing is written, audited or notified** |

Checks, in order:

| Status | Message | When |
|---|---|---|
| 400 | `An emergency access reason is required` | `reason` missing or blank |
| 400 | `Emergency access reason must be 500 characters or fewer` | |
| 400 | `A valid patient ID and document ID are required` | either id is not 24-hex |
| 404 | `Patient not found` | no **patient** has that id |
| 404 | `Document not found` | |
| 400 | `The selected document does not belong to the selected patient` | |
| 409 | `This doctor already has normal access to the selected document` | the document is shared with this doctor |
| 409 | `This doctor already has patient-approved consent for the selected document` | an `APPROVED` consent exists. (A `PENDING` consent does **not** block: break-glass is the escalation while the patient hasn't answered.) |
| 200 | *(already active — above)* | |
| 409 | `You already have N active emergency accesses (limit M). Revoke one or wait for it to expire before starting another.` | the doctor is at the cap (§5.3); `N` live grants, limit `M` |

Effects on `201`: audit `EMERGENCY_ACCESS_GRANTED` (actor the doctor); anchor `GRANTED` enqueued; event `emergency.granted` to the patient. Before deciding, the handler expires this doctor's lapsed grants (writing their `EMERGENCY_ACCESS_EXPIRED` rows).

### 4.4 `GET /api/emergency-access` — list grants

Role: **patient** (grants on their own documents) or **doctor**, verified or not (their own grants).

Query: `status` — `ACTIVE` (default), `EXPIRED`, `REVOKED` or `all`, case-insensitive.

- `ACTIVE` means **live**: `status: 'ACTIVE'` and `expiresAt` in the future.
- For a doctor, lapsed grants are expired first. For a patient they are not, so with `status=all` a patient may see a row that still reads `ACTIVE` with an `expiresAt` in the past; treat live as "`ACTIVE` and not yet expired", as the patient panel does.

Response `200`: `{ emergencyAccesses: EmergencyAccess[] }`, newest `createdAt` first, at most 100, with `doctor`, `patient` and `document` joined.

| Status | Message | When |
|---|---|---|
| 400 | `status must be ACTIVE, EXPIRED, REVOKED or all` | |

### 4.5 `DELETE /api/emergency-access/:id` — the patient ends a grant

Role: **patient**, and only the patient the grant names. No body.

Response `200`: `{ message: 'Emergency access revoked', emergencyAccess }` (with `doctor` and `document` joined). The doctor loses access on their very next request.

| Status | Message | When |
|---|---|---|
| 400 | `A valid emergency access ID is required` | |
| 404 | `Emergency access not found` | |
| 403 | `You do not have permission to revoke this emergency access` | the caller is not the grant's patient |
| 409 | `Only active emergency access can be revoked` | already `EXPIRED` or `REVOKED` — including a second revoke, or a race the expiry won |

Effects on `200`: audit `EMERGENCY_ACCESS_REVOKED` (actor the patient); anchor `REVOKED` enqueued; event `emergency.revoked` to the **doctor**. A `409` writes nothing.

---

## 5. Emergency-access rules

All four settings live in `server/.env` (see `.env.example`); each is read per call, falls back to its default when unset, and warns once at boot when set to something unusable. Boot prints the effective values.

### 5.1 Duration — `EMERGENCY_ACCESS_DURATION_MINUTES` (default 15)

Fixed at creation into `expiresAt`. Changing the setting affects only new grants. Fractional values are allowed (`0.5` = 30 seconds) so expiry can be demonstrated live.

### 5.2 One live grant per doctor per document

Enforced by the database (partial unique index `one_active_grant_per_doctor_document` on `{ doctorId, documentId }` for `ACTIVE` rows), so it holds for any number of server processes. A second request while one is live returns the existing grant (`200`, above). A row that has lapsed but is not yet swept still occupies the index; the insert then expires it through the normal guarded transition (one `EMERGENCY_ACCESS_EXPIRED` row) and retries once.

### 5.3 The cap — `EMERGENCY_MAX_ACTIVE_GRANTS` (default 5)

The number of **live** grants one doctor may hold at once, across all patients. Lapsed and revoked grants do not count. The check-count-insert runs under a per-doctor in-process lock, so concurrent requests cannot overshoot it; one doctor's requests never wait for another's. **Single-process assumption:** like the chain send mutex and the rate-limit store, the lock is per server process — several instances would need the cap enforced by the database (TESTING.md §5).

### 5.4 Re-grant after revocation — `EMERGENCY_REGRANT_WINDOW_HOURS` (default 24)

Revoking does not stop a doctor from breaking glass again — but a return is never silent. When the **same doctor** breaks glass on the **same document** within this window after the patient revoked their previous grant there:

- the grant carries `afterRevocation: true` and `followsRevokedGrantId`;
- the `EMERGENCY_ACCESS_GRANTED` audit row carries `afterRevocation: 'true'`, `followsRevokedGrantId` and `previouslyRevokedAt`;
- `emergency.granted` carries `afterRevocation: true` and the message variant *"… again after you revoked it"*;
- the patient's list shows the flag (the dashboard panel highlights it).

A first grant, another doctor, another document, or a revocation older than the window is not flagged. The flag is **off-chain on purpose**: the `GRANTED` preimage is frozen (ANCHORING.md §2), and the return is already derivable from the anchored `REVOKED` and `GRANTED` events.

---

## 6. Audit actions

| Action | Written by | Actor (`userId`) | IP | Metadata |
|---|---|---|---|---|
| `PATIENT_LOOKUP` | `GET /patients/lookup` (every evaluated call) | doctor | request | `{ query, matchedBy, found, patientId? }` |
| `CONSENT_REQUESTED` | `POST /consents/request` (201) | doctor | request | `{ consentId, doctorId, patientId, purpose, status }` |
| `CONSENT_APPROVED` · `CONSENT_REJECTED` · `CONSENT_REVOKED` | the `PATCH` routes (200) | patient | request | same as above, with the new `status` |
| `EMERGENCY_ACCESS_GRANTED` | `POST /emergency-access` (201 only) | doctor | request | `{ emergencyAccessId, doctorId, patientId, reason, expiresAt, afterRevocation: 'true' \| 'false', followsRevokedGrantId?, previouslyRevokedAt? }` |
| `EMERGENCY_ACCESS_REVOKED` | `DELETE /emergency-access/:id` (200) | patient | request | `{ emergencyAccessId, doctorId, patientId, grantedAt, expiresAt, revokedAt }` |
| `EMERGENCY_ACCESS_EXPIRED` | the expiry job, or the lazy sweep on the doctor's reads | doctor | `system` | `{ emergencyAccessId, doctorId, patientId, expiresAt }` |

Each document the doctor then reads through a consent or grant is audited separately (`DOCUMENT_ACCESS`, `DOCUMENT_PREVIEW`, `DOCUMENT_DOWNLOAD`, `INTEGRITY_VERIFIED`), with `metadata.accessMethod` `'consent'` (plus `consentGrantId`) or `'emergency'` (plus `emergencyAccessId` and `expiresAt`), and the document's `patientId` — API_ADMIN.md §4 lists every method.

---

## 7. Events and anchors

Events are emitted after the database write and the audit row, only when something actually changed (never on a `409` or the "already active" `200`). Full payloads and the notification-listener guidance are in [EVENTS.md](EVENTS.md).

| Call | Event | Recipient | `message` |
|---|---|---|---|
| `POST /consents/request` | `consent.requested` | patient | `${doctorName} requested access to "${title}"` |
| `PATCH …/approve` | `consent.approved` | doctor | `${patientName} approved your access to "${title}"` |
| `PATCH …/reject` | `consent.rejected` | doctor | `${patientName} declined your access request for "${title}"` |
| `PATCH …/revoke` | `consent.revoked` | doctor | `${patientName} revoked your access to "${title}"` |
| `POST /emergency-access` | `emergency.granted` | patient | `${doctorName} used emergency access on "${title}"`, or `… on "${title}" again after you revoked it` |
| `DELETE /emergency-access/:id` | `emergency.revoked` | doctor | `${patientName} revoked your emergency access to "${title}"` |

Expiry emits no event: the end time was already in the grant notification.

Every consent transition and every grant and revocation enqueues one on-chain anchor — `consent:<id>:REQUESTED|APPROVED|REJECTED|REVOKED`, `emergency:<id>:GRANTED|REVOKED` — as one local database insert; the anchor worker sends the transaction afterwards, so **no request here waits on, or fails because of, the chain**. Expiry is not anchored (it is derivable from the anchored `expiresAt`). Preimages, verification and the queue are in [ANCHORING.md](ANCHORING.md).

---

## 8. End-to-end example (curl)

```bash
API=http://localhost:5000/api
DOC=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"doctor@jeevanlocker.dev","password":"Doctor123!"}' | jq -r .token)
PAT=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"patient@jeevanlocker.dev","password":"Patient123!"}' | jq -r .token)

# 1. find the patient and a document
curl -s "$API/patients/lookup?query=patient@jeevanlocker.dev" -H "Authorization: Bearer $DOC"
# -> { patient: { id: "<P>" }, documents: [ { id: "<D>", access: "none", emergencyActive: false }, … ] }

# 2a. consent: request, then the patient approves
curl -s -X POST $API/consents/request -H "Authorization: Bearer $DOC" -H 'Content-Type: application/json' \
  -d '{"patientId":"<P>","documentId":"<D>","purpose":"Pre-operative review"}'
# -> 201 { consent: { id: "<C>", status: "PENDING" } }
curl -s -X PATCH $API/consents/<C>/approve -H "Authorization: Bearer $PAT"
# -> 200 { message: "Consent approved" }

# 2b. or break glass on another document, and the patient ends it
curl -s -X POST $API/emergency-access -H "Authorization: Bearer $DOC" -H 'Content-Type: application/json' \
  -d '{"patientId":"<P>","documentId":"<D2>","reason":"Patient unconscious in ED"}'
# -> 201 { message: "Emergency access granted for 15 minutes", emergencyAccess: { id: "<G>", status: "ACTIVE" } }
curl -s -X DELETE $API/emergency-access/<G> -H "Authorization: Bearer $PAT"
# -> 200 { message: "Emergency access revoked" }   (the doctor's next read of <D2> is 403)
```
