# JeevanLocker — Encryption at Rest

How medical documents are protected on disk, what that protection does and does not achieve, and how the keys are managed. Written from the implementation in `server/src/services/documentCrypto.service.ts`, `server/src/services/documentIngest.service.ts`, `server/src/controllers/document.controller.ts` and `server/src/scripts/encryptExistingDocuments.ts` (Phase 1, Task 5).

---

## 1. Summary

Every file in the vault is encrypted with **AES-256-GCM** under a **random key unique to that file**. That per-file key is itself encrypted ("wrapped") by a single **master key** that lives only in the server's environment. The database stores the wrapped key; the disk stores the ciphertext; neither is useful without the master key, and the master key is useful only together with both.

The **SHA-256 hash registered on the blockchain is always the hash of the original, unencrypted document**. It is computed in the same pass that encrypts the bytes. Encryption therefore changes nothing about what the chain attests: a document uploaded before this feature and one uploaded after it are verified the same way, and the same on-chain record stays valid after the file is encrypted by the migration.

A file that has been altered on disk — by a byte, by truncation, by being swapped with another document's file — **cannot be served at all**. GCM authentication fails, the request is answered with `409 Document file failed integrity check`, and a `DOCUMENT_INTEGRITY_FAILED` audit row records who tried to open which document and why it failed.

---

## 2. Threat model, in plain terms

The vault has three separable pieces: the **files** in `server/uploads/`, the **database** (MongoDB), and the **master key** (`DOCUMENT_MASTER_KEY` in the server's environment). An attacker who obtains:

| Obtains | Can read documents? | Why not |
|---|---|---|
| **only the files** (e.g. a copied disk, a leaked backup of `uploads/`) | **No.** | Each file is AES-256-GCM ciphertext under a key that is not on the disk in any form. File names are opaque (`<timestamp>-<uuid>.pdf.enc`) and the container has no metadata beyond a 4-byte magic and a random IV. Nothing distinguishes one patient's file from another's. |
| **only the database** | **No document content.** | The database holds document *metadata* (titles, owners, hashes, lab report fields such as test values) and the *wrapped* per-file keys. A wrapped key is AES-256-GCM ciphertext under the master key; without it the keys are random bytes. Note that the metadata itself — titles, `testValues` — is not encrypted; see §9. |
| **files + database, no master key** | **No.** | Same as above: the per-file keys are only present in wrapped form. |
| **the master key only** | **No.** | There is nothing to decrypt without both the wrapped keys (database) and the ciphertext (files). |
| **files + master key, no database** | **No.** | The wrapped per-file keys are not in the files. This is deliberate defence in depth: a leaked `uploads/` directory plus a leaked environment variable is still not enough. |
| **files + database + master key** | **Yes — everything.** | This is the server's own position. Protecting the master key (§6) is what the whole scheme reduces to. |

What encryption at rest does **not** protect against:

- **A compromised running server.** The server decrypts on demand; anyone who can execute code on it can read what the server can read. Access control (`getDocumentAccessDecision`), rate limiting and the audit trail address that layer, not encryption.
- **An attacker who can modify files and wants to *destroy* data.** Encryption detects modification (the file becomes unreadable and the failure is audited) but cannot prevent deletion. Backups do that.
- **Leakage of the plaintext during the brief upload window** (§7).
- **Leakage through metadata** (§9).

---

## 3. Key hierarchy

```
DOCUMENT_MASTER_KEY  (32 bytes, environment only)          ── the KEK
        │  AES-256-GCM, random 12-byte IV, AAD = document id
        ▼
wrapped data key     (60 bytes base64, MedicalDocument.encryption.wrappedKey)
        │  unwrap in memory for one request, zeroed after use
        ▼
data key (DEK)       (32 random bytes, one per file, never stored unwrapped)
        │  AES-256-GCM, random 12-byte IV, AAD = document id
        ▼
<name>.enc           (the file on disk)
```

- **Master key (KEK)** — `DOCUMENT_MASTER_KEY`, exactly 32 bytes, base64 or hex. Parsed once at boot. `DOCUMENT_MASTER_KEY_ID` (default `primary`) is a label recorded on every row so a later rotation can tell which master key wrapped which document.
- **Data key (DEK)** — `crypto.randomBytes(32)` per file. It exists in process memory while a file is written or read and is overwritten with zeros immediately after (`Buffer.fill(0)`). It is never logged, never serialized, never written anywhere except in wrapped form.
- **Associated data** — both the file and the wrapped key are authenticated together with the document's MongoDB `ObjectId` (allocated *before* the file is encrypted, precisely so it can be used here). Consequences: a ciphertext copied onto another document's row fails; a wrapped key copied onto another row fails; the pairing of row ↔ file ↔ key is cryptographically bound.
- **Why two levels?** Rotating the master key never requires touching a file (§6). Compromise of one data key exposes one file. And the KEK can be moved to a hardware module or cloud KMS later without changing the file format, because the only operation it performs is wrap/unwrap of 32-byte keys.

---

## 4. Container layout on disk

```
offset 0    4 bytes   magic  "JLE1"        identifies a vault file; no PDF/PNG/JPEG starts with it
offset 4   12 bytes   IV                   random per file (and the key is per file, so never reused)
offset 16   N bytes   ciphertext           N = plaintext length exactly (GCM is a stream mode)
end-16     16 bytes   GCM authentication tag
```

`plaintextSize = fileSize − 32`. The tag is the last thing written because Node's cipher produces it only after the final block; keeping it *in* the file means the file authenticates itself and a database/file mismatch after a partial failure is detectable from the file alone.

**The GCM streaming caveat.** Authenticated encryption verifies the tag at the *end* of decryption, but a streaming decryptor emits plaintext as it goes. Sending those bytes straight to a browser would mean a tampered file gets a `200 OK` and only fails after the client has received garbage. JeevanLocker therefore reads every file **twice** when serving it:

1. **Pass 1 — authenticate.** Decrypt the whole file into a hashing sink (no buffering; a few milliseconds for the 5 MB maximum). If the tag or associated data does not verify, respond `409` and audit. This pass also yields the plaintext SHA-256, which is exactly what the integrity endpoint needs.
2. **Pass 2 — stream.** Decrypt again, piping plaintext to the response with `Content-Length` = plaintext size.

A file that changes between the two passes fails in pass 2; the response is then aborted rather than completed, so a client never receives a clean `200` for unauthenticated bytes.

---

## 5. Where hashing happens, and why the chain stays valid

`encryptFileToVault` streams the plaintext through a SHA-256 tee **and** the cipher in one pass. The hash it returns is the plaintext hash; the ingest pipeline stores it as `documentHash` and registers it on-chain. Nothing ever hashes a `.enc` file:

- `POST /documents/upload` and `POST /lab/reports` → `ingestUploadedDocument` → `encryptFileToVault` → `registerDocumentHash(plaintext hash)`.
- `GET /documents/:id/integrity` → pass 1 → plaintext hash → compared with the on-chain record.
- The demo seed → `encryptFileToVault` → `documentHash` (the on-chain seed registration must use this same value; a comment in `ensureDemoDocument` says so).
- The migration (§8) refuses to encrypt a legacy file whose current SHA-256 differs from its stored `documentHash` — encrypting it would silently launder a replaced file.

---

## 6. Key rotation

Because every file has its own data key, **rotating the master key never rewrites a file**. Only the 60-byte wrapped keys on the rows are touched.

Procedure (designed; the rotation script is not yet implemented):

1. Generate a new master key. Set `DOCUMENT_MASTER_KEY` to it and `DOCUMENT_MASTER_KEY_ID` to a new label (e.g. `k2`). Keep the old key available to the server as a *retired* key (planned variable `DOCUMENT_MASTER_KEYS_RETIRED="primary:<base64>"`), consulted **only** for unwrapping — the one addition the service needs is a keyring lookup by `keyId` instead of the single-key check it has today.
2. Run `rotate:master-key`: for every document whose `encryption.keyId` ≠ current, unwrap with the retired key, re-wrap with the current key, and switch the row with one conditional `updateOne({ _id, 'encryption.keyId': oldId })`. O(documents) database writes, zero file I/O, trivially resumable — a document is either on the old label or the new one.
3. When no row carries the old label, remove the retired key from the environment. Rows on an unknown label are refused with `503 Document encryption key is unavailable` (and audited as `DOCUMENT_INTEGRITY_FAILED` / `KEY_UNAVAILABLE`), so a misconfiguration is loud, not silent.

**If the master key is compromised** *and* the wrapped keys may have been exfiltrated, rotating the KEK is not enough — the attacker can already unwrap the old wrapped keys. The files then need **new data keys**: the same script with a `--rekey-files` flag would decrypt each file with its old DEK and re-encrypt it with a fresh one via the ingest encryptor (temp + rename, exactly like the migration). This is the only scenario that requires touching files.

**If only a single file's DEK leaks** (it never leaves memory, so this is a theoretical case), the exposure is that one file.

---

## 7. The upload window (accepted, documented, future hardening)

Uploads arrive through Multer's `diskStorage`, which writes the incoming bytes to `server/uploads/<name>` **in plaintext** before the controller runs. The ingest pipeline then checks the magic bytes, encrypts that temp file to `<name>.enc`, and unlinks the plaintext. The plaintext therefore exists on disk **for the duration of one HTTP request** and is removed on every path — success, validation failure, encryption failure, database failure, chain failure (all verified).

What this means: an attacker with live read access to the disk during an upload could capture that file. Given that such an attacker can also read process memory and the master key, this is not a meaningful weakening of the model in §2, but it is a real window and it is stated here rather than hidden.

**Future hardening:** switch Multer to `memoryStorage` (uploads are capped at 5 MB) so plaintext never touches disk, and stream from the buffer into the encryptor. Nothing in the container format or the database changes.

---

## 8. Migrating existing plaintext files

Documents uploaded before this feature have no `encryption` field and their file is plaintext. They keep working unchanged (`encryptedAtRest: false` in every API response — the UI shows the lock badge only for `true`, so coverage is visible during the migration).

```bash
cd server
npm run migrate:encrypt -- --dry-run   # report, change nothing
npm run migrate:encrypt                # encrypt; re-run until it reports nothing to do
npm run migrate:encrypt -- --verify    # decrypt every encrypted file and compare with documentHash
```

The script connects directly to `MONGO_URI` (not the in-memory dev database), is idempotent, and is safe to re-run after a crash at any point. **Run one instance at a time.** Per document without `encryption`:

```
0. delete uploads/*.enc.tmp                       leftovers of a crash mid-write
1. delete <name>.enc if it exists                 an orphan: its wrapped key never reached the row, so it
                                                  cannot be decrypted by anyone — re-encrypt from plaintext
2. skip if <name> (plaintext) is missing          never invent data
3. skip if SHA-256(<name>) ≠ documentHash         the bytes changed since upload — refuse to launder them
4. encrypt <name> → <name>.enc.tmp ; fsync ; rename → <name>.enc          atomic publish
5. one conditional updateOne({ _id, encryption: {$exists:false} })         atomic switch-over
6. unlink <name>                                                           plaintext removed last
```

Before touching any pending document, the script first removes leftover plaintext siblings of documents that are already encrypted (a crash between 5 and 6) — recovery runs before new work, so a run that itself dies mid-loop has still cleaned up after the previous one.

**Crash matrix — exercised with real process deaths** (`MIGRATE_CRASH_AFTER=encrypt|update|unlink`, test hook only):

| Process dies… | On disk | Database row | Serving meanwhile | Next run |
|---|---|---|---|---|
| while writing (step 4) | plaintext + partial `.enc.tmp` | plaintext | works, from plaintext | step 0 deletes the temp; redo |
| after step 4, before 5 | plaintext + complete `.enc` | plaintext | works, from plaintext | step 1 deletes the orphan; redo |
| after step 5, before 6 | plaintext + `.enc` | **encrypted** | works, from `.enc` | leftover sweep deletes the plaintext |
| after step 6 | `.enc` | encrypted | works | nothing to do |

At no point does the row point at a file that is wrong for the state the row describes, because no file is ever modified in place and the only database write is one conditional update. A refused document (steps 2–3) is reported with its id and left exactly as found; the script exits `1` so an operator notices.

---

## 9. Limits and non-goals

- **Metadata is not encrypted.** Titles, file names, owner ids, lab report fields (including `testValues` and flags), audit rows and the wrapped keys are stored in MongoDB in the clear. Field-level encryption of test values is a possible extension; it was out of scope here.
- **Not end-to-end.** The server holds the master key and decrypts for every authorised request. Client-side (patient-held) keys would be a different design with different trade-offs (no server-side search, no doctor access without key sharing).
- **In-memory zeroing is best-effort.** Node.js does not guarantee that a `Buffer` is the only copy of key bytes; OpenSSL keeps its own key schedule. `fill(0)` shortens the window but cannot promise that no copy remains.
- **The integrity of the chain record itself** is the blockchain's guarantee, not this feature's.

---

## 10. Operational rules

- **Losing `DOCUMENT_MASTER_KEY` loses every document, permanently.** There is no recovery path by design — that is what "the files are useless without the key" means. Back the key up outside the repository, outside the server, in at least two places, before the first real upload. The server refuses to start without it and refuses a key of the wrong length; there is deliberately no development fallback that could quietly generate a key and then lose it.
- Generate a key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- Treat `server/uploads/` and the MongoDB data as two halves of one dataset in backups: either half alone is unreadable, but a restore needs both from a consistent point in time plus the key.
- Every failed authentication is audited as `DOCUMENT_INTEGRITY_FAILED` with the reason (`TAMPERED`, `BAD_CONTAINER`, `KEY_UNAVAILABLE`), the operation (`view`, `download`, `integrity`), the document id, the stored file name and the key label. Repeated `TAMPERED` rows on one document mean the file on disk was changed; `KEY_UNAVAILABLE` after a deployment means the environment's key label does not match the rows — check `DOCUMENT_MASTER_KEY_ID`.

---

## 11. API surface touched

| Endpoint | Change |
|---|---|
| `POST /documents/upload`, `POST /lab/reports` | file encrypted before the row exists; unchanged request/response except `encryptedAtRest: true` |
| `GET /documents/:id/view`, `/download` | decrypt (two passes); new `409 Document file failed integrity check`, new `503 Document encryption key is unavailable`; `Content-Length` is the plaintext size |
| `GET /documents/:id/integrity` | hashes decrypted plaintext; same 409/503 on authentication failure; `verified:false` only when the file decrypts fine but its hash differs from the chain |
| every document response | `encryptedAtRest: boolean` |
