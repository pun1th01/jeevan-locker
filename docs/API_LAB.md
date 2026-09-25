# JeevanLocker — Lab API

Everything a lab-facing client needs. Written from the implemented server code (Phase 0, commit `1e94707`); every status code and message string below is the exact value the server sends. If the code and this file ever disagree, the code wins — open an issue.

Related: [API_ADMIN.md](API_ADMIN.md) covers how lab accounts are provisioned and how doctors get verified; [API_CONSENT_EMERGENCY.md](API_CONSENT_EMERGENCY.md) covers how doctors gain access to a patient's documents (consent and break-glass).

---

## 1. Basics

- Base URL: `http://localhost:5000/api` (client default: `VITE_API_URL`).
- Auth: `Authorization: Bearer <jwt>` from `POST /auth/login`. Tokens last 7 days. Every authenticated request re-reads the user from the database, so role/flag changes apply immediately without a new login.
- All JSON errors have the shape `{ "message": string }` (validation errors add `"errors": Record<string, string>`).
- Common auth failures on every protected route:

| Status | Message | When |
|---|---|---|
| 401 | `Authentication token is required` | no `Authorization: Bearer …` header |
| 401 | `Invalid authentication token` | malformed/bad signature |
| 401 | `Authentication token has expired` | |
| 401 | `Authenticated user no longer exists` | user deleted after token issued |
| 403 | `You do not have permission to access this resource` | wrong role for the route |

### The `lab` role

`UserRole = 'patient' | 'doctor' | 'admin' | 'lab'`. A lab account:

- **cannot self-register** — `POST /auth/register` with `role: 'lab'` → `400 { message: 'Validation failed', errors: { role: 'Role must be patient or doctor' } }`.
- is created by an admin (`POST /api/admin/users`, see [API_ADMIN.md](API_ADMIN.md#post-apiadminusers--create-a-lab-account)) or from the server CLI: `npm run create:lab -- --name … --email … --password … --organisation …`.
- is `verified: true` by construction and always has an `organisation`.
- **Admin creation is CLI-only, permanently.** There is no HTTP endpoint that creates an admin, and `POST /api/admin/users` refuses `role: 'admin'`.

Demo lab (dev seed): `lab@jeevanlocker.dev` / `Lab123!!`, organisation "Thyrocare Technologies Ltd".

### `User` shape (as returned everywhere)

```ts
interface User {
  id: string;
  name: string;
  email: string;
  role: 'patient' | 'doctor' | 'admin' | 'lab';
  verified: boolean;        // always true for labs
  organisation?: string;    // present for labs; optional for doctors; absent for patients/admins
  createdAt: string;        // ISO 8601
}
```

---

## 2. Lab link — the authorisation model

A lab may upload into a patient's vault only while a **LabLink** between them is `ACTIVE`. Links are **lab-initiated, patient-approved**.

```
                 POST /lab-links (lab)
                          │
                          ▼
                      PENDING
                     /        \
   PATCH …/approve  /          \  PATCH …/reject   (patient, owner)
                   ▼            ▼
                ACTIVE       REJECTED   (terminal)
                   │
   DELETE …/:id    │  (patient, owner)
                   ▼
                REVOKED   (terminal)
```

Rules:

- At most **one open link** (`PENDING` or `ACTIVE`) per lab+patient pair — enforced by a partial unique index. Rejected/revoked links stay as history and a lab may request again afterwards.
- Only `ACTIVE` permits `POST /lab/reports`.
- **Revoking a link stops future uploads but does not remove the lab's access to reports it already issued.** The lab keeps read/download/integrity access to every document where `uploadedByLab` is that lab, forever. Rationale: a lab signs what it issues (NABL number, authorising doctor, test values). It must be able to stand behind, re-read and re-verify a report it produced even after the patient ends the relationship — otherwise a revocation would let a patient erase the issuer's ability to audit its own output. The patient, not the lab, is the owner (`uploadedBy`) and controls sharing.

### `LabLink` shape

```ts
type LabLinkStatus = 'PENDING' | 'ACTIVE' | 'REJECTED' | 'REVOKED';

interface LabLink {
  id: string;
  patient: { id: string; name: string };                 // no email, by design
  lab: { id: string; name: string; organisation?: string };
  status: LabLinkStatus;
  requestedAt: string;   // ISO 8601
  approvedAt?: string;   // present iff status has passed through ACTIVE
  rejectedAt?: string;   // present iff REJECTED
  revokedAt?: string;    // present iff REVOKED
}
```

---

## 3. Endpoints

### `POST /api/lab-links` — request a link with a patient

Role: **lab**. Rate limit: **30 per lab per 15 minutes** (keyed on the lab's user id; counts every call that reaches the route, found or not).

Request (JSON):
```ts
{ query: string }   // the patient's email address OR their 24-hex user id — exact match only
```

Matching: trimmed; if the value is a 24-hex string it is matched against `_id`, otherwise lower-cased and matched against `email`; always restricted to `role: 'patient'`. There is no prefix/partial search. The same rule, the same identical-404 behaviour and the same audit row are used by the doctor-side `GET /patients/lookup`.

Response `201`:
```ts
{ message: 'Link request sent to patient', link: LabLink }   // link.status === 'PENDING'
```

Errors:

| Status | Message | When |
|---|---|---|
| 400 | `A patient email or ID is required` | `query` missing, blank, or longer than 254 chars |
| 404 | `No patient found for that email or ID` | no patient matches — **identical** whether the email is unknown or belongs to a doctor/admin/lab (the endpoint never confirms that an address exists with another role) |
| 409 | `A link request is already pending with this patient` | an open `PENDING` link exists (also returned if two requests race) |
| 409 | `This patient has already authorised your lab` | an `ACTIVE` link exists |
| 429 | `Too many patient lookups. Try again later.` | rate limit |

Audit: every evaluated call (200 **and** 404) writes `PATIENT_LOOKUP` (`metadata: { query, matchedBy: 'email' | 'id', found: 'true' | 'false', patientId? }` — the raw query, including the email, is kept on purpose). A `201` additionally writes `LAB_LINK_REQUESTED` (`metadata: { labLinkId, labId, patientId, status }`).

### `GET /api/lab-links` — list links

Role: **patient** or **lab**.

- As a **lab**: every link the lab has requested, any status, newest first.
- As a **patient**: the patient's `PENDING` and `ACTIVE` links only (rejected/revoked are hidden from the patient view).

Response `200`: `{ links: LabLink[] }` (may be `[]`).

### `PATCH /api/lab-links/:id/approve` — patient approves

Role: **patient**, and the link's `patient.id` must equal the caller. `PENDING → ACTIVE`, sets `approvedAt`.

Response `200`: `{ message: 'Lab link approved', link: LabLink }`.

| Status | Message |
|---|---|
| 400 | `A valid lab link ID is required` |
| 404 | `Lab link not found` |
| 403 | `You do not have permission to change this lab link` (not the link's patient — includes labs) |
| 409 | `Only pending lab links can be approved` |

Audit: `LAB_LINKED`.

### `PATCH /api/lab-links/:id/reject` — patient rejects

Role: **patient** (owner). `PENDING → REJECTED`, sets `rejectedAt`.

Response `200`: `{ message: 'Lab link rejected', link: LabLink }`. Errors as above with `409 Only pending lab links can be rejected`. Audit: `LAB_LINK_REJECTED`.

### `DELETE /api/lab-links/:id` — patient revokes

Role: **patient** (owner). `ACTIVE → REVOKED`, sets `revokedAt`. See the revoke rule in §2 — already-issued reports remain readable by the lab.

Response `200`: `{ message: 'Lab link revoked', link: LabLink }`. Errors as above with `409 Only active lab links can be revoked`. Audit: `LAB_UNLINKED`.

### `POST /api/lab/reports` — upload a verified report

Role: **lab**. Requires an `ACTIVE` link with the target patient. Content type: `multipart/form-data`.

| Field | Type | Required | Rule |
|---|---|---|---|
| `file` | file | yes | PDF, JPEG or PNG; at most **5 MB** — 5,242,880 bytes is accepted, 5,242,881 is refused with `413` (the same boundary as the upload dialog); one file. The declared MIME type is checked against the file's **magic bytes** — a mismatch is rejected. |
| `patientId` | string | yes | 24-hex user id of a **patient** (get it from the link's `patient.id`) |
| `title` | string | yes | 1–120 chars after trim |
| `labName` | string | no | ≤ 120 |
| `testName` | string | no | ≤ 120 |
| `nablCertNumber` | string | no | ≤ 120 |
| `authorizingDoctorName` | string | no | ≤ 120 |
| `hospitalName` | string | no | ≤ 120 |
| `reportDate` | string | no | ISO 8601; must not be in the future |
| `testValues` | string | no | **JSON-encoded array** (see §4). Omit or send `""` for none. |

Pipeline (identical to the patient upload): multer whitelist/size → field validation → ACTIVE-link check → magic-byte check → SHA-256 → database row → on-chain registration of the hash → audit. **Every failure after the file has hit disk removes the file; a chain failure also deletes the database row.** A `201` therefore always means the report is on disk, in the database, and registered on the chain.

Response `201`: `{ document: MedicalDocument }` (see §5) with `uploadedBy` = the patient, `uploadedByLab` = the calling lab, and `testValues[*].flag` computed by the server.

Errors (in the order they are checked):

| Status | Message | When |
|---|---|---|
| 400 | `Only PDF, JPG, and PNG files are allowed` | declared MIME type outside the whitelist (multer) |
| 413 | `Uploaded file exceeds the 5 MB limit` | the file is larger than 5,242,880 bytes (exactly 5 MB is accepted) |
| 400 | `Document upload failed` | other multer error (e.g. two files) |
| 400 | `A PDF, JPG, or PNG report file is required` | no `file` part |
| 400 | `A valid patient ID is required` | `patientId` not a 24-hex ObjectId |
| 400 | `Report title must be 1 to 120 characters` | |
| 400 | `<field> must be 120 characters or fewer` | `labName` / `testName` / `nablCertNumber` / `authorizingDoctorName` / `hospitalName` |
| 400 | `reportDate must be an ISO 8601 date` | |
| 400 | `reportDate cannot be in the future` | |
| 400 | one of the `testValues` messages in §4 | |
| 404 | `Patient not found` | id is well-formed but is not a patient |
| 403 | `This patient has not authorised your lab` | no `ACTIVE` link (never requested, still pending, rejected, or revoked) |
| 400 | `File content does not match its declared type` | magic bytes ≠ declared MIME type |
| 500/503 | `Internal server error` / `Blockchain is not configured. …` | chain unreachable or not configured — file and row rolled back |

Audit: `LAB_REPORT_UPLOADED` (`userId` = lab, `targetDocument` = the new document, `metadata: { patientId, labLinkId, testValueCount, criticalCount }`). It is **not** also logged as `DOCUMENT_UPLOAD`.

---

## 4. `testValues` — JSON schema and flag rule

Send as a JSON string in the multipart field. Any `flag` you include is **ignored**; the server computes it.

```ts
type TestValueInput = {
  name: string;           // 1–80 chars, trimmed
  value: number | string; // finite number (numeric strings accepted, e.g. "9.1")
  unit: string;           // 1–20 chars, trimmed
  refLow?: number;        // reference range
  refHigh?: number;
  criticalLow?: number;   // panic limits — optional, but this is what makes a value 'critical'
  criticalHigh?: number;
};
// max 200 entries
```

Bound constraints (each only checked when both sides are present): `refLow ≤ refHigh`, `criticalLow ≤ criticalHigh`, `criticalLow ≤ refLow`, `criticalHigh ≥ refHigh`.

Stored and returned shape — the bounds are stored **alongside** the value so the reason for every flag is auditable:

```ts
type TestValueFlag = 'normal' | 'high' | 'low' | 'critical';

interface TestValue {
  name: string;
  value: number;
  unit: string;
  refLow?: number;        // present only if supplied
  refHigh?: number;
  criticalLow?: number;
  criticalHigh?: number;
  flag: TestValueFlag;
}
```

Flag rule, in priority order:

1. `value < criticalLow` or `value > criticalHigh` → **`critical`**
2. else `value < refLow` → **`low`**; `value > refHigh` → **`high`**
3. else, or when no bounds were supplied at all → **`normal`**

Each bound is independent: a value with only `refHigh` set can be `high` or `normal`, never `low`. A value between `refHigh` and `criticalHigh` is `high`, not `critical`.

Validation errors (all `400`, message exactly as shown, `[i]` is the zero-based index):

| Message |
|---|
| `testValues must be a JSON array` |
| `testValues may contain at most 200 entries` |
| `testValues[i] must be an object` |
| `testValues[i].name must be 1 to 80 characters` |
| `testValues[i].unit must be 1 to 20 characters` |
| `testValues[i].value must be a finite number` |
| `testValues[i].refLow must be a finite number` (same for `refHigh`, `criticalLow`, `criticalHigh`) |
| `testValues[i]: refLow must not exceed refHigh` |
| `testValues[i]: criticalLow must not exceed criticalHigh` |
| `testValues[i]: criticalLow must not exceed refLow` |
| `testValues[i]: criticalHigh must not be below refHigh` |

Example:
```json
[
  { "name": "Hemoglobin", "value": 9.1, "unit": "g/dL", "refLow": 12, "refHigh": 16, "criticalLow": 7 },
  { "name": "Potassium",  "value": 6.8, "unit": "mmol/L", "refLow": 3.5, "refHigh": 5.1, "criticalHigh": 6.0 },
  { "name": "Glucose",    "value": 95,  "unit": "mg/dL", "refLow": 70, "refHigh": 100 }
]
```
→ flags `low`, `critical`, `normal`.

---

## 5. What a lab can read

Access rule (`getDocumentAccessDecision`): a lab may read a document **only if `uploadedByLab` is that lab**. Nothing else — not documents of linked patients, not other labs' reports, not documents shared with anyone. This does not change when a link is revoked.

### `GET /api/documents/my-documents`

Role: any. For a **lab** returns every document it issued (`uploadedByLab === me`), newest first, regardless of link status.

Response `200`: `{ documents: MedicalDocument[] }`.

### `GET /api/documents/:id`, `GET /api/documents/:id/view`, `GET /api/documents/:id/download`, `GET /api/documents/:id/integrity`

Role: any; access by the rule above. `403 You do not have permission to access this document` otherwise; `404 Document not found` for unknown ids. `/view` streams inline, `/download` as attachment, `/integrity` re-hashes the file and compares with the on-chain record (`{ verified, algorithm, currentHash, blockchainHash, blockchainTxHash, registeredAt }`; `409 This document was not registered on the blockchain` for pre-chain seed documents).

Reading logs `DOCUMENT_ACCESS` / `DOCUMENT_PREVIEW` / `DOCUMENT_DOWNLOAD` / `INTEGRITY_VERIFIED` respectively, with the lab as the actor and `metadata: { accessMethod: 'lab', patientId }` (see API_ADMIN.md §4 for every method).

### `MedicalDocument` shape

Lab-report fields are flat and optional; **`uploadedByLab` being present is what marks a verified lab report.** Storage paths are never returned.

```ts
interface MedicalDocument {
  id: string;
  title: string;
  originalFileName: string;
  mimeType: 'application/pdf' | 'image/jpeg' | 'image/png';
  uploadedBy: User;                 // the owning PATIENT — also for lab reports
  sharedWithDoctors: User[];
  documentHash?: string;            // SHA-256 hex
  hashAlgorithm?: 'SHA-256';
  blockchainTxHash?: string;
  blockchainRegisteredAt?: string;
  // --- present only when a lab issued the document ---
  uploadedByLab?: User;             // role 'lab', with organisation
  labName?: string;
  testName?: string;
  nablCertNumber?: string;
  authorizingDoctorName?: string;
  hospitalName?: string;
  reportDate?: string;              // ISO 8601
  testValues?: TestValue[];
  createdAt: string;
  updatedAt: string;
}
```

### Routes a lab is **denied** (all `403 You do not have permission to access this resource`)

`POST /documents/upload` (patient), `PATCH /documents/:id/share` (patient), `GET /documents/doctors` (patient/admin), `GET /patients/lookup` (doctor — labs use `POST /lab-links`), `POST /consents/request` and every consent route, `POST /emergency-access`, `GET /audit/summary` (admin), everything under `/admin` (admin).

---

## 6. Rate limits

| Route | Window | Limit | Key | 429 message |
|---|---|---|---|---|
| `POST /auth/login` | 15 min | 10 | client IP | `Too many login attempts. Try again in 15 minutes.` |
| `POST /auth/register` | 60 min | 5 | client IP | `Too many accounts created from this address. Try again in an hour.` |
| `POST /lab-links` | 15 min | 30 | lab user id | `Too many patient lookups. Try again later.` |

Standard `RateLimit` response headers (IETF draft-8) are sent. Counters are in-memory and reset when the server restarts.

---

## 7. Audit actions a lab's activity produces

| Action | Written by | Actor |
|---|---|---|
| `LAB_CREATED` | admin endpoint / CLI provisioning | admin (or `cli`) |
| `PATIENT_LOOKUP` | `POST /lab-links` (every evaluated call) | lab |
| `LAB_LINK_REQUESTED` | `POST /lab-links` (201) | lab |
| `LAB_LINKED` | `PATCH /lab-links/:id/approve` | patient |
| `LAB_LINK_REJECTED` | `PATCH /lab-links/:id/reject` | patient |
| `LAB_UNLINKED` | `DELETE /lab-links/:id` | patient |
| `LAB_REPORT_UPLOADED` | `POST /lab/reports` (201) | lab |
| `DOCUMENT_ACCESS` / `DOCUMENT_PREVIEW` / `DOCUMENT_DOWNLOAD` / `INTEGRITY_VERIFIED` | reading an issued report | lab |
| `USER_LOGIN` | `POST /auth/login` | lab |

All rows are visible to admins in `GET /audit/summary` and rendered in the admin dashboard.

---

## 8. End-to-end example (curl)

```bash
# 1. lab logs in
LAB=$(curl -s -X POST localhost:5000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"lab@jeevanlocker.dev","password":"Lab123!!"}' | jq -r .token)

# 2. request a link with a patient by email
curl -s -X POST localhost:5000/api/lab-links -H "Authorization: Bearer $LAB" \
  -H 'Content-Type: application/json' -d '{"query":"patient@jeevanlocker.dev"}'
# -> 201 { link: { id: "<LINK>", status: "PENDING", patient: { id: "<PATIENT>", … } } }

# 3. patient approves (in the UI, or:)
PAT=$(curl -s -X POST localhost:5000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"patient@jeevanlocker.dev","password":"Patient123!"}' | jq -r .token)
curl -s -X PATCH localhost:5000/api/lab-links/<LINK>/approve -H "Authorization: Bearer $PAT"

# 4. lab uploads a report
curl -s -X POST localhost:5000/api/lab/reports -H "Authorization: Bearer $LAB" \
  -F patientId=<PATIENT> -F title="CBC Panel" -F labName="Thyrocare" -F testName="CBC" \
  -F nablCertNumber="MC-1234" -F reportDate=2026-09-01T10:00:00Z \
  -F testValues='[{"name":"Hb","value":9.1,"unit":"g/dL","refLow":12,"refHigh":16,"criticalLow":7}]' \
  -F file=@report.pdf
# -> 201 { document: { …, uploadedByLab: { name: "Thyrocare Diagnostics", … }, testValues: [{ …, flag: "low" }] } }
```
