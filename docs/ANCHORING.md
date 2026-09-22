# JeevanLocker — On-chain Audit Anchoring

How consent decisions and emergency ("break-glass") access are made tamper-evident by anchoring them on a blockchain, and how anyone holding a database record can check — with nothing but a shell — that the record still matches what was anchored. Written from the implementation in `server/contracts/AuditAnchorRegistry.sol`, `server/src/services/anchorPreimage.service.ts`, `anchorQueue.service.ts`, `anchorWorker.service.ts` and `server/src/controllers/anchor.controller.ts` (Phase 1, Task 6).

Related: [ENCRYPTION.md](ENCRYPTION.md) (documents at rest — the same "the chain describes the fact, not a mutable view of it" principle), [API_ADMIN.md](API_ADMIN.md).

---

## 1. Summary

Every time a consent request is **made, approved, rejected or revoked**, every time a doctor **grants themselves emergency access**, and every time a patient **revokes that emergency access**, the server builds a small, fixed-format text record of that event (the *preimage*), takes its SHA-256 digest, and writes the digest to a smart contract under a key derived from the record's id. The contract is write-once per key and timestamps each write with the block time.

Three things follow:

1. **The chain never holds personal data.** Only a 32-byte key (a keccak-256 hash of an id string) and a 32-byte digest. Not the patient, not the doctor, not the purpose text, not the document.
2. **The record can be verified after the fact.** Rebuild the preimage from the database row, hash it, read the digest back from the contract, compare. If the row was edited after the event, the digests differ.
3. **The user's request never waits for the chain.** Consent works during a chain outage; the anchor is queued durably and written when the chain is back. Nothing is silently dropped: an anchor that never makes it becomes a visible, retryable `FAILED` row.

---

## 2. What exactly is hashed — the preimage, byte for byte

The preimage is a JSON object serialized by `JSON.stringify` with **no whitespace**, with **exactly these keys in exactly this order**. ObjectIds are their 24-hex string; timestamps are ISO 8601 UTC with milliseconds (`toISOString()`); `documentHash` is the document's SHA-256 in lower-case hex, or `null` if the document has none.

### Consent events (`REQUESTED`, `APPROVED`, `REJECTED`, `REVOKED`)

```
{"v":1,"type":"consent","event":<EVENT>,"consentId":<id>,"patientId":<id>,"doctorId":<id>,"documentId":<id>,"documentHash":<hex|null>,"purpose":<string>,"occurredAt":<ISO>}
```

`occurredAt` is the timestamp of **that** transition: `requestedAt` for `REQUESTED`, `approvedAt` for `APPROVED`, `rejectedAt` for `REJECTED`, `revokedAt` for `REVOKED`.

### Emergency grant (`GRANTED`)

```
{"v":1,"type":"emergency","event":"GRANTED","emergencyAccessId":<id>,"doctorId":<id>,"patientId":<id>,"documentId":<id>,"documentHash":<hex|null>,"reason":<string>,"createdAt":<ISO>,"expiresAt":<ISO>}
```

`expiresAt` is the grant window read off the row, whatever `EMERGENCY_ACCESS_DURATION_MINUTES` was when the grant was created. Configuring a different window changes that one **value**; it never changes the key order or the field set, so the bytes stay the format above and every anchor made under any setting still verifies.

### Emergency revocation (`REVOKED`)

```
{"v":1,"type":"emergency","event":"REVOKED","emergencyAccessId":<id>,"doctorId":<id>,"patientId":<id>,"documentId":<id>,"documentHash":<hex|null>,"grantedAt":<ISO>,"revokedBy":<id>,"revokedAt":<ISO>}
```

`grantedAt` is the grant's `createdAt` and pins *which* grant instance this revocation ends. `expiresAt` is absent on purpose: the grant was cut short, so its original expiry is a property of the `GRANTED` event and is already anchored there. `revokedBy` is the patient.

Two fields you will **not** find in any emergency preimage: `status` (it changes on the next transition) and `afterRevocation`. The latter marks a grant that re-opened access a patient had just revoked; it is deliberately kept off-chain because adding it to the `GRANTED` preimage would change those bytes and invalidate every anchor made before it existed — and because it is *derivable* from what is already anchored: a `REVOKED` event for that doctor+document followed by a later `GRANTED` event for the same pair is exactly what the flag summarises.

### Keys

Off-chain record key (a plain string): `consent:<consentId>:<EVENT>` or `emergency:<emergencyAccessId>:<EVENT>`.
On-chain key: `keccak256(utf8(record key))` — 32 bytes, what the contract's mapping is indexed by.

### Why these fields and not others

Every field is **immutable once the transition has happened**: the ids never change, `purpose`/`reason` are written once at creation, and each transition timestamp is set exactly once. `status` is deliberately absent — it changes on every later transition and would make the `APPROVED` anchor "wrong" the moment the consent is revoked. That is why an anchor for `APPROVED` stays valid forever, even after the same consent is revoked (which gets its own `REVOKED` anchor).

`documentHash` ties the consent to the document's own on-chain record (see ENCRYPTION.md §5): the anchor says *this doctor was granted access to a document whose plaintext hashes to this value*.

---

## 3. Worked example

A consent, as it sits in MongoDB:

| Field | Value |
|---|---|
| `_id` | `66f2a1b3c4d5e6f708192a3b` |
| `patientId` | `66f2a1b3c4d5e6f708192a01` |
| `doctorId` | `66f2a1b3c4d5e6f708192a02` |
| `documentId` | `66f2a1b3c4d5e6f708192a10` (whose `documentHash` is `4cbcc0d6…851fd9e`) |
| `purpose` | `Pre-operative cardiology review` |
| `requestedAt` | `2026-09-21T09:15:00.000Z` |
| `approvedAt` | `2026-09-21T09:42:17.512Z` |

**Preimage for the `APPROVED` event** (one line, no spaces, no trailing newline):

```
{"v":1,"type":"consent","event":"APPROVED","consentId":"66f2a1b3c4d5e6f708192a3b","patientId":"66f2a1b3c4d5e6f708192a01","doctorId":"66f2a1b3c4d5e6f708192a02","documentId":"66f2a1b3c4d5e6f708192a10","documentHash":"4cbcc0d60e005ca14a7ccd6e705bac955644327663c196cadcf1954cd851fd9e","purpose":"Pre-operative cardiology review","occurredAt":"2026-09-21T09:42:17.512Z"}
```

**Digest (SHA-256 of those bytes):**

```
17cec17ef072de9a90c4924e8055fe08bf918d525fbb6e39bea09e21b2971d42
```

**Record key:** `consent:66f2a1b3c4d5e6f708192a3b:APPROVED`
**On-chain key:** `0x00370c5ff059a06d708263b9784bb72129018aa895bb62a2805e2420ac1ff871`

And for an emergency grant on the same document (`_id 66f2a1b3c4d5e6f708192b77`, reason `Patient unconscious in ED`, created `2026-09-21T22:03:41.000Z`, expires `2026-09-21T22:18:41.000Z`):

```
{"v":1,"type":"emergency","event":"GRANTED","emergencyAccessId":"66f2a1b3c4d5e6f708192b77","doctorId":"66f2a1b3c4d5e6f708192a02","patientId":"66f2a1b3c4d5e6f708192a01","documentId":"66f2a1b3c4d5e6f708192a10","documentHash":"4cbcc0d60e005ca14a7ccd6e705bac955644327663c196cadcf1954cd851fd9e","reason":"Patient unconscious in ED","createdAt":"2026-09-21T22:03:41.000Z","expiresAt":"2026-09-21T22:18:41.000Z"}
```
digest `93e8f759f1577b8f403e25d84dcb7b7b6fa5efe6fed2498362b40ecfbaa9e01f`, record key `emergency:66f2a1b3c4d5e6f708192b77:GRANTED`, on-chain key `0x3bb0c68d2a59886fb82f5c31bbac64b197da87f21fb1bae028524df10333f6f0`.

If the patient then revokes that grant at `2026-09-21T22:07:05.220Z` (four minutes into the fifteen), the revocation anchors as:

```
{"v":1,"type":"emergency","event":"REVOKED","emergencyAccessId":"66f2a1b3c4d5e6f708192b77","doctorId":"66f2a1b3c4d5e6f708192a02","patientId":"66f2a1b3c4d5e6f708192a01","documentId":"66f2a1b3c4d5e6f708192a10","documentHash":"4cbcc0d60e005ca14a7ccd6e705bac955644327663c196cadcf1954cd851fd9e","grantedAt":"2026-09-21T22:03:41.000Z","revokedBy":"66f2a1b3c4d5e6f708192a01","revokedAt":"2026-09-21T22:07:05.220Z"}
```
digest `a667a8b1f962a04b0c6ce1ccada4d8262bee7f55b963cd6b3f1df4cdf7b9eec8`, record key `emergency:66f2a1b3c4d5e6f708192b77:REVOKED`, on-chain key `0x2c2cbf59063d57fb51f9a7f76eeff6964373bfe7c1c673dc879000e4f7e46808`. The grant and its revocation are two independent, write-once anchors: reading both tells you the session existed *and* that the patient ended it early, and neither can be altered afterwards.

These values are produced by the server code and reproduced by the shell commands below. `npm run verify:anchors` (in `server/`) rebuilds all three from `anchorPreimage.service.ts` and fails if any byte, digest or key drifts from what is printed here — it needs no database and no chain, so run it after touching anything in that file.

---

## 4. Recomputing the digest by hand

You need only the record and a shell. Take care that nothing adds a trailing newline: `printf '%s'`, not `echo`.

```bash
# SHA-256 of the preimage (Linux/macOS/Git Bash)
printf '%s' '{"v":1,"type":"consent","event":"APPROVED","consentId":"66f2a1b3c4d5e6f708192a3b","patientId":"66f2a1b3c4d5e6f708192a01","doctorId":"66f2a1b3c4d5e6f708192a02","documentId":"66f2a1b3c4d5e6f708192a10","documentHash":"4cbcc0d60e005ca14a7ccd6e705bac955644327663c196cadcf1954cd851fd9e","purpose":"Pre-operative cardiology review","occurredAt":"2026-09-21T09:42:17.512Z"}' | sha256sum
# 17cec17ef072de9a90c4924e8055fe08bf918d525fbb6e39bea09e21b2971d42
```

Or with Node, building the preimage from the field values so the key order is enforced by the object literal:

```bash
node -e '
const p = JSON.stringify({ v:1, type:"consent", event:"APPROVED",
  consentId:"66f2a1b3c4d5e6f708192a3b", patientId:"66f2a1b3c4d5e6f708192a01", doctorId:"66f2a1b3c4d5e6f708192a02",
  documentId:"66f2a1b3c4d5e6f708192a10", documentHash:"4cbcc0d60e005ca14a7ccd6e705bac955644327663c196cadcf1954cd851fd9e",
  purpose:"Pre-operative cardiology review", occurredAt:"2026-09-21T09:42:17.512Z" });
console.log(require("crypto").createHash("sha256").update(p, "utf8").digest("hex"));'
```

The on-chain key (keccak-256 is not in coreutils; use `cast` or ethers):

```bash
cast keccak "consent:66f2a1b3c4d5e6f708192a3b:APPROVED"
# 0x00370c5ff059a06d708263b9784bb72129018aa895bb62a2805e2420ac1ff871

# or, from server/ where ethers is installed:
node -e 'const e=require("ethers");console.log(e.keccak256(e.toUtf8Bytes("consent:66f2a1b3c4d5e6f708192a3b:APPROVED")))'
```

---

## 5. Reading the anchor back from the chain

The contract (`AuditAnchorRegistry`) exposes `getAnchor(bytes32 key) → (bytes32 digest, uint256 timestamp, address anchoredBy)`. Its address is `AUDIT_ANCHOR_ADDRESS` in `server/.env` (printed by `npm run chain:deploy`; on a fresh Hardhat node it is `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`).

With Foundry's `cast`:

```bash
cast call 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
  "getAnchor(bytes32)(bytes32,uint256,address)" \
  0x00370c5ff059a06d708263b9784bb72129018aa895bb62a2805e2420ac1ff871 \
  --rpc-url http://127.0.0.1:8545
# 0x17cec17ef072de9a90c4924e8055fe08bf918d525fbb6e39bea09e21b2971d42
# 1789979600            <- block timestamp (unix seconds)
# 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   <- the server wallet
```

With the Hardhat console (`cd server && npx hardhat console --network localhost`):

```js
const c = await ethers.getContractAt("AuditAnchorRegistry", "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512");
await c.getAnchor(ethers.keccak256(ethers.toUtf8Bytes("consent:66f2a1b3c4d5e6f708192a3b:APPROVED")));
// Result(3) [ '0x17cec1…1d42', 1789979600n, '0xf39F…2266' ]
```

A digest of `0x000…000` means nothing is anchored under that key. A transaction hash alone proves nothing — the contract state is what to read.

---

## 6. Comparing the three values

The admin verify view (and `GET /api/admin/anchors/:id/verify`) puts three independently obtained digests side by side:

| # | Value | Obtained from |
|---|---|---|
| 1 | **recomputed** | the database record *as it is now*, through §2/§4 |
| 2 | **stored** | the `ChainAnchor` row — what the server hashed at the time of the event |
| 3 | **on-chain** | `getAnchor(key)` on the contract, §5 |

| Comparison | If they differ, it means |
|---|---|
| **1 ≠ 2** | The database record was **altered after it was anchored**. The view names the field(s) whose values differ between the stored and recomputed preimages (e.g. `purpose`, `approvedAt`). This is the tampering case the anchoring exists to expose. |
| **2 ≠ 3** | The on-chain anchor **does not belong to this record**: wrong key, a different chain/deployment than the one the row was anchored on, or nothing anchored yet (`PENDING`). Not evidence about the record itself. |
| **1 = 2 = 3** | The record is exactly what was anchored, and the anchor is where the row says it is. **Verified.** |

Recomputed can also be *absent*: the record no longer exists, or it never reached the event (an `APPROVED` anchor cannot exist for a consent that was rejected).

---

## 7. What is deliberately not on-chain

Per anchor the contract stores a 32-byte key, a 32-byte digest, a timestamp and the sender address. That is all. No names, no ids in the clear, no purpose text, no document hash, no reason. The digest is one-way, and the preimage contains two random ObjectIds and a millisecond timestamp, so it cannot be guessed from the digest.

The consequence is that the chain alone tells you nothing about anybody — it can only **confirm or deny** a record you already hold. That is the intended property for medical data: public verifiability without public disclosure.

---

## 8. The queue — what the statuses mean

Anchoring happens **after** the request has succeeded, not as part of it. When a consent transitions or an emergency grant is created, the server writes the audit row, then inserts one `ChainAnchor` row (a local database insert, milliseconds) and returns. A background worker in the same process sends the transactions, one at a time, in order.

| Status | Meaning | What you see on the row |
|---|---|---|
| **PENDING** | Queued or retrying. The event happened and is recorded off-chain; the chain write has not succeeded yet. | `attempts`, `nextAttemptAt`, `lastAttemptAt` and `lastError` are always filled in after the first try, so a row that has been pending for days explains why (e.g. `connect ECONNREFUSED`, or `Audit anchoring is not configured`). |
| **ANCHORED** | The digest is on-chain. | `txHash`, `blockNumber`, `anchoredAt` (block time). The same proof is copied onto the consent / emergency record as `anchors.<event>`. |
| **FAILED** | The worker gave up after the attempt cap. The event is still fully recorded off-chain; only the anchor is missing. | `failedAt`, `lastError`; a `CHAIN_ANCHOR_FAILED` audit row is written so it appears in the admin feed. The row is never deleted and an admin can **Retry** it. |

Retry schedule: attempt *n* waits `5 s × 2ⁿ⁻¹`, capped at **1 hour**; the cap is **60 attempts ≈ 50 hours** of continuous outage. A chain that is down overnight, or restarted by a developer, does not produce `FAILED` rows.

Guarantees, plainly:

- **The request never blocks on the chain** and never fails because of it.
- **At-least-once anchoring.** Every row is retried until it is on-chain or an admin is told. The contract is write-once per key, so a retry after a partially recorded success cannot create a second anchor; the worker recognises "already anchored", checks the digest matches, and recovers the original transaction from the contract's event log.
- **Restart-safe.** All worker state is on the row; a new process resumes exactly where the old one stopped.
- **Self-healing.** At every boot the server re-derives, from the consent and emergency records themselves, which anchors *should* exist (consent: `REQUESTED` always, `APPROVED`/`REJECTED`/`REVOKED` when the matching timestamp is set; emergency: `GRANTED` always, `REVOKED` when `revokedAt` is set) and enqueues any that have no row. This closes the one window the queue cannot cover on its own — a crash between writing the audit row and inserting the anchor row — so the queue is a work list, not the only source of truth. The sweep is idempotent and only ever creates rows for events that have actually happened.
- **Nothing is dropped silently.** The only terminal failure state is a visible `FAILED` row with an audit entry.

Operational notes: the boot sweep scans consents, grants and anchor keys with narrow projections — negligible up to ~10⁵ records; `ANCHOR_RECONCILE_WINDOW_DAYS` bounds it to recent records for larger deployments (any window longer than the longest possible downtime is sufficient, since a lost enqueue is always for a record written at the moment of the crash). Run one server process per wallet: transactions are serialized in-process to keep the nonce consistent.

---

## 9. Limits and non-goals

- Anchoring proves **integrity and existence-by-time**, not authorization. That a consent was approved at 09:42 is attested; whether the approver was entitled to approve is the access-control layer's job (and the audit log's).
- The block timestamp is the local Hardhat node's clock in development; on a public chain it would be consensus time.
- The registry contract is not upgradeable and stores only what §7 says. Changing the preimage format bumps `v` so old anchors remain verifiable under the format they were made with.
- Only these six events are anchored: the four consent transitions, an emergency grant and an emergency revocation. Document uploads are anchored separately (`DocumentRegistry`, see ENCRYPTION.md §5). Emergency **expiry** is audited but not anchored — it is derivable from `expiresAt`, which the `GRANTED` preimage already fixes. Lab links, logins, views and downloads are audited off-chain only.

---

## 10. Admin API

All admin-only (`verifyToken` + `requireRole('admin')`).

| Method | Path | Returns |
|---|---|---|
| GET | `/api/admin/anchors?status=&recordType=&limit=` | `{ anchors: ChainAnchorRow[], counts: { PENDING, ANCHORED, FAILED } }`, newest first (`limit` 1–200, default 50). `400` on a bad `status`/`recordType`/`limit`. |
| GET | `/api/admin/anchors/:id/verify` | `AnchorVerification` — the three digests, `matchesRecord`, `matchesChain`, `verified`, `differingFields`, `chainReachable`, `recordFound`, both preimages. `400` bad id, `404` unknown. |
| POST | `/api/admin/anchors/:id/retry` | re-queues a `FAILED` (or stuck `PENDING`) row: `{ message: 'Anchor re-queued', anchor }`. `409 Only pending or failed anchors can be retried` for `ANCHORED`; `404` unknown. |

Shapes are in `client/src/types/anchor.ts`. Consent and emergency records also expose `anchors.<event>` = `{ digest, txHash, blockNumber, anchoredAt }` once anchored.
