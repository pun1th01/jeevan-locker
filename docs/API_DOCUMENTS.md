# JeevanLocker — Document management API

The patient's own controls over a document already in their vault: who it is shared with directly, and its title and description. Report uploads, what each reader receives and the `MedicalDocument` shape are in [API_LAB.md](API_LAB.md) §3 and §5; consent and break-glass are in [API_CONSENT_EMERGENCY.md](API_CONSENT_EMERGENCY.md).

Base path: `/api/documents`. Every route needs `Authorization: Bearer <token>`. These routes match the calls the patient dashboard makes (`client/src/services/document.service.ts`): same method, path and body, and the client reads `document` from the response.

---

## 1. Rules shared by every route here

- **Role: patient.** Any other role gets `403 You do not have permission to access this resource` from the role gate, before the document is looked up.
- **Owner only.** The caller must be the document's `uploadedBy`, and that includes lab reports in their vault. Another patient gets a `403` naming the rule. As elsewhere, an unknown id is `404 Document not found`, so a signed-in patient can tell that an id exists, never what it holds (TESTING.md §5).
- **Response:** `200 { message, document }`, where `document` is the `MedicalDocument` wire shape as the caller may see it. That is the same serializer as `GET /documents/:id`.
- **Nothing on-chain changes.** The file, its plaintext hash and its `DocumentRegistry` record are never touched, so `/integrity` verifies exactly as before.

---

## 2. `PATCH /api/documents/:id/share` — share with a doctor

Body `{ doctorId }`. Adds the doctor to the direct share list. Sharing again with the same doctor is a `200 Doctor already has access to this document` that writes nothing. Audit `DOCUMENT_SHARE`; event `document.shared` to the doctor.

## 3. `PATCH /api/documents/:id/unshare` — remove a doctor's direct share

Body `{ doctorId }`.

Removes that one doctor from `sharedWithDoctors` and **nothing else**. An approved consent or a live break-glass grant the same doctor holds is a separate permission with its own revoke (`PATCH /consents/:id/revoke`, `DELETE /emergency-access/:id`), and the doctor keeps reading through it.

| Status | Message | When |
|---|---|---|
| 200 | `Direct access removed` | the doctor was on the share list and is now off it |
| 200 | `This doctor had no direct access to this document` | nothing to remove; nothing is written |
| 400 | `A valid doctor ID is required` | missing or malformed `doctorId` |
| 404 | `Document not found` | |
| 403 | `Only the uploading patient can change who this document is shared with` | the caller is not the owner |

Effects on `Direct access removed`: audit `DOCUMENT_UNSHARED` (actor the patient, metadata `{ doctorId, patientId }`). The removal is one guarded `$pull`, so concurrent unshares of the same doctor write one audit row. There is no event: like a lab-link revocation, it is audit-only. The doctor's next read is refused unless another permission allows it.

## 4. `PATCH /api/documents/:id/metadata` — rename or describe

Body `{ title?, description? }`. At least one is required, and **nothing else may be sent**.

| Field | Rule |
|---|---|
| `title` | string, trimmed, 1–120 characters |
| `description` | string, trimmed, at most **500** characters. An empty or whitespace-only string clears it. |

- **Only the title and description can change.** A body carrying any other field (`uploadedBy`, `sharedWithDoctors`, `documentHash`, `blockchainTxHash`, `mimeType`, any lab-report field…) is refused, not silently ignored, so a client can never believe it changed something it did not.
- **Lab-issued fields are never editable.** A lab report keeps the title its lab issued and every report field (`labName`, `testName`, `nablCertNumber`, `authorizingDoctorName`, `hospitalName`, `reportDate`, `testValues`). The patient may add or change its description. Sending the report's current title unchanged is allowed; the dashboard always sends it.
- **Who sees the description.** The patient, doctors who can read the document, and admins. **Never the lab**: a lab gets its report back as issued, not the patient's note about it.

| Status | Message | When |
|---|---|---|
| 200 | `Document details updated` | something changed |
| 200 | `No changes to save` | the values sent equal the stored ones; nothing is written |
| 400 | `Only the title and description of a document can be changed` | an unknown field in the body |
| 400 | `Send a title or a description to change` | neither was sent |
| 400 | `Document title must be 1 to 120 characters` | |
| 400 | `Description must be 500 characters or fewer` | also for a non-string description |
| 404 | `Document not found` | |
| 403 | `Only the uploading patient can edit this document` | the caller is not the owner |
| 403 | `A lab report keeps the title its lab issued; only its description can be changed` | a new title for a lab report |

Effects on `Document details updated`: audit `DOCUMENT_UPDATED` (actor the patient). Its metadata is `{ fields: 'title' | 'description' | 'title,description', previousTitle?, patientId }`, with `previousTitle` present when the title changed. No event.

## 5. `DELETE /api/documents/:id` — delete from the vault (soft delete)

No body. Role: patient (owner).

The document is **marked** deleted (`deletedAt`, `deletedBy`), never removed. The row, the encrypted file and the on-chain `DocumentRegistry` record stay, so an admin can still prove what existed and verify it. What changes is who can reach it:

| Reader | After the delete |
|---|---|
| The patient | Gone. `404 Document not found` on every read and write path; absent from `my-documents`. |
| Every doctor | Gone, whatever the route was: a direct share, a consent or a break-glass grant. `404` on every path, absent from `my-documents` and from `GET /patients/lookup`. A new consent request or break-glass on it is `404` and creates nothing. |
| The issuing lab (lab reports only) | Unchanged. It keeps its own report, for the same reason it does after a link is revoked (API_LAB.md §2): a lab must be able to stand behind what it signed. It is **not** told about the deletion. |
| Admins | Still readable everywhere, with `deletedAt` on the document. The audit feed marks the document *Deleted by patient*, and `GET /audit/summary` counts it under `deletedDocuments` instead of `totalDocuments`. |

**What the delete ends (the cascade).** Each step is the same transition a patient makes by hand, audited, anchored and notified exactly once, with `cause: 'DOCUMENT_DELETED'` in the audit metadata:

- an `APPROVED` consent becomes `REVOKED` (`CONSENT_REVOKED`, anchor `REVOKED`, event `consent.revoked` to the doctor);
- a `PENDING` consent becomes `REJECTED` (`CONSENT_REJECTED`, anchor `REJECTED`, event `consent.rejected`);
- a live break-glass grant becomes `REVOKED`, `revokedBy` the patient (`EMERGENCY_ACCESS_REVOKED`, anchor `REVOKED`, event `emergency.revoked`). A grant whose window has already passed is left to the expiry job and ends as `EXPIRED`.

The document is marked deleted *before* the cascade runs, so from that instant no doctor is served, whatever the cascade has reached. A consent that a concurrent request moves between `PENDING` and `APPROVED` mid-cascade is read again and closed from its new state.

**The deletion itself** is audited as `DOCUMENT_DELETED` (actor the patient; metadata `{ patientId, deletedAt, consentsRevoked, consentsRejected, grantsRevoked }`) and anchored on-chain under `document:<id>:DELETED`. The preimage is in ANCHORING.md §2, and boot reconciliation rebuilds the anchor if its row is lost.

| Status | Body | When |
|---|---|---|
| 200 | `{ message: 'Document deleted. Doctors can no longer open it; its hash stays on the blockchain and the audit trail is kept.', consentsRevoked, consentsRejected, grantsRevoked }` | the dashboard shows `message` |
| 404 | `Document not found` | unknown id, already deleted, or the loser of two concurrent deletes |
| 403 | `Only the uploading patient can delete this document` | another patient |

There is no undelete.

---

## 6. What each reader learns about the people on a document (response minimisation)

Every document response (`GET /documents/:id`, `my-documents`, and every write response) names up to three kinds of people: the owning patient (`uploadedBy`), the doctors it is shared with (`sharedWithDoctors`) and, for a lab report, the issuing lab (`uploadedByLab`). Each reader receives only what they act on:

| Reader | `uploadedBy` (the patient) | `sharedWithDoctors` | `uploadedByLab` |
|---|---|---|---|
| the owning patient | `{ id, name }` | `[{ id, name, email }]`, to manage them | `{ id, name, organisation }` |
| a doctor with access | `{ id, name, email }`, to contact the patient | **not sent** | `{ id, name, organisation }` |
| the issuing lab | `{ id, name }` | **not sent** | `{ id, name, organisation }` |
| an admin | the full account record (`id, name, email, role, verified, organisation?, createdAt`) | full records | full record |

Nobody but an admin ever receives another user's `role`, `verified` flag or account `createdAt`, nor a lab account's email. Which doctors a patient shared a document with is the patient's own care decision: a doctor reads the document, not the list of colleagues who also may. A lab sees neither.

Consents, break-glass grants and lab links already name people as `{ id, name }` (a lab adds `organisation`) to both parties, as their documented shapes say (API_CONSENT_EMERGENCY.md §3.2, §4.2; API_LAB.md §2). Notifications carry only `actorName`. TESTING.md C59–C60 pin every one of these shapes per reader.

---

Tests: TESTING.md C54 (unshare) and C55 (metadata), `server/test/access/documentManagement.test.ts`; C57–C58 (delete), `server/test/access/documentDeletion.test.ts`. Every route here has a row in the route inventory (C1–C3).
