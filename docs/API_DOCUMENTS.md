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

## 5. `DELETE /api/documents/:id` — not implemented

The dashboard's Delete button is hidden until this route exists.

---

Tests: TESTING.md C54 (unshare) and C55 (metadata), `server/test/access/documentManagement.test.ts`; both routes have rows in the route inventory (C1–C3).
