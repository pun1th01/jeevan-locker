# JeevanLocker — Admin API

The three admin endpoints plus the doctor-verification gate they control. Written from the implemented server code (Phase 0, commit `1e94707`); every status and message below is the exact value the server sends.

Related: [API_LAB.md](API_LAB.md) — what a lab account can do once it exists; [API_CONSENT_EMERGENCY.md](API_CONSENT_EMERGENCY.md) — the consent and break-glass routes the verification gate protects.

---

## 1. Basics

- Base URL `http://localhost:5000/api`; `Authorization: Bearer <jwt>` from `POST /auth/login`.
- Every route below is mounted under `verifyToken` + `requireRole('admin')`:

| Status | Message | When |
|---|---|---|
| 401 | `Authentication token is required` / `Invalid authentication token` / `Authentication token has expired` / `Authenticated user no longer exists` | token problems |
| 403 | `You do not have permission to access this resource` | caller is not an admin |

- Demo admin (dev seed): `admin@jeevanlocker.dev` / `Admin123!`.

### How admins come to exist — CLI only, permanently

Admins **cannot self-register** (`POST /auth/register` accepts only `patient` and `doctor`) and **cannot be created through any HTTP endpoint** — `POST /api/admin/users` refuses `role: 'admin'`. This is deliberate and permanent: a compromised admin session must not be able to mint further admins. Provision one on the server:

```bash
cd server
npm run create:admin -- --name "Ops Admin" --email ops@example.com --password 'Str0ngPass!'
```

The script connects directly to `MONGO_URI` (it bypasses the in-memory dev database on purpose), creates the account `verified: true`, and writes an `ADMIN_CREATED` audit row with IP `cli`. See README → "Creating an admin or a lab".

### `User` shape

```ts
interface User {
  id: string;
  name: string;
  email: string;
  role: 'patient' | 'doctor' | 'admin' | 'lab';
  verified: boolean;        // see §3; true for admins and labs by construction
  organisation?: string;    // labs always, doctors optionally, never patients/admins
  createdAt: string;        // ISO 8601
}
```

---

## 2. Endpoints

### `GET /api/admin/users` — list users (the verification queue)

Query parameters, both optional and combinable:

| Param | Values |
|---|---|
| `role` | `patient` \| `doctor` \| `admin` \| `lab` |
| `verified` | `true` \| `false` |

Sorted by `createdAt` **ascending** (oldest first) so a queue reads top-down in arrival order. No pagination.

Response `200`: `{ users: User[] }`.

| Status | Message |
|---|---|
| 400 | `role must be one of patient, doctor, admin, lab` |
| 400 | `verified must be true or false` |

The verification queue is `GET /api/admin/users?role=doctor&verified=false`.

### `PATCH /api/admin/users/:id/verify` — verify a doctor

Sets `verified = true` on a **doctor** account. Idempotent: calling it on an already-verified doctor returns `200` with the same user and writes **no** second audit row.

Response `200`:
```ts
{ message: 'Doctor verified', user: User }              // flipped now
{ message: 'Doctor is already verified', user: User }   // no-op
```

| Status | Message | When |
|---|---|---|
| 400 | `A valid user ID is required` | `:id` is not a 24-hex ObjectId |
| 404 | `User not found` | |
| 400 | `Only doctor accounts require verification` | target is a patient, admin or lab |

Audit (only on the actual flip): `DOCTOR_VERIFIED`, `userId` = the admin, `metadata: { doctorId, doctorEmail }`.

There is no "unverify" endpoint in Phase 0.

### `POST /api/admin/users` — create a **lab** account

Creates a lab. **Lab accounts only** — this is not a general user-creation endpoint, and it never creates admins (see §1).

Request (JSON):
```ts
{
  name: string;          // ≥ 2 chars
  email: string;         // valid address; stored lower-cased
  password: string;      // ≥ 8 chars; bcrypt-hashed server-side
  organisation: string;  // 2–120 chars, required
  role?: 'lab';          // optional; anything else is rejected, not coerced
}
```

Response `201`: `{ user: User }` with `role: 'lab'`, `verified: true`, `organisation` set.

| Status | Body | When |
|---|---|---|
| 400 | `{ message: 'This endpoint creates lab accounts only' }` | `role` present and not `'lab'` (including `'admin'`) |
| 400 | `{ message: 'Validation failed', errors: { name? , email?, password?, organisation? } }` | field errors; messages: `Name must be at least 2 characters`, `Enter a valid email address`, `Password must be at least 8 characters`, `Organisation is required for lab accounts`, `Organisation must be 2 to 120 characters`, `Organisation must be text` |
| 409 | `{ message: 'A user with this email already exists' }` | |

Audit: `LAB_CREATED`, `userId` = the admin, `metadata: { labId, labEmail, organisation }`.

Equivalent CLI: `npm run create:lab -- --name … --email … --password … --organisation …` (writes `LAB_CREATED` with IP `cli`).

---

## 3. The doctor verification gate

`User.verified` defaults to `false`. A doctor who self-registers is unverified until an admin calls `PATCH /api/admin/users/:id/verify`.

### What an unverified doctor **cannot** do

Each of these returns **`403 { message: 'Your doctor account is awaiting admin verification' }`**:

| Route | Note |
|---|---|
| `GET /api/patients/lookup` | the gate runs **after** the per-user rate limiter, so attempts still count toward the 30/15 min limit (an unverified account cannot loop on it for free) |
| `POST /api/consents/request` | |
| `POST /api/emergency-access` | (break-glass) |

### What an unverified doctor **can** still do

Log in; `GET /auth/me`; `GET /documents/my-documents`, `GET /documents/:id`, `/view`, `/download`, `/integrity` for documents already shared with them, already approved by consent, or under a live emergency grant; `GET /consents/my`. Verification gates *initiating* new access, not access the patient already granted.

### Effect is immediate

`verifyToken` reloads the user from the database on every request, so the moment `verified` flips the same JWT passes the gate — **no re-login**. The doctor dashboard reads `user.verified` from `/auth/me` on load and shows an "Account awaiting verification" banner with the Request Access / Emergency Access buttons disabled until then.

### Who is verified by construction

- Demo doctors from the dev seed (`doctor@`, `doctor2@jeevanlocker.dev`) — the seed also re-asserts this on every restart.
- Admins created by `create:admin`.
- Labs created by `POST /api/admin/users` or `create:lab`.

The flag is only *read* for doctors; patients and admins carry `false` and nothing checks it. Labs are not gated by `requireVerifiedDoctor` (it passes non-doctor roles through) but are `true` anyway.

---

## 4. Audit actions an admin's activity produces

| Action | Written by | Metadata |
|---|---|---|
| `ADMIN_CREATED` | `npm run create:admin` | `{ createdBy: 'cli', email }`, IP `cli` |
| `LAB_CREATED` | `POST /api/admin/users` / `npm run create:lab` | `{ labId, labEmail, organisation }` |
| `DOCTOR_VERIFIED` | `PATCH /api/admin/users/:id/verify` (first call only) | `{ doctorId, doctorEmail }` |
| `USER_LOGIN` | `POST /auth/login` | |

All 27 audit actions are in `server/src/models/AccessLog.ts` (mirrored in `client/src/types/audit.ts`) and rendered by the admin dashboard from `GET /api/audit/summary` (last 50 events + totals).

---

## 5. Example — clear the verification queue

```bash
ADM=$(curl -s -X POST localhost:5000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@jeevanlocker.dev","password":"Admin123!"}' | jq -r .token)

curl -s "localhost:5000/api/admin/users?role=doctor&verified=false" -H "Authorization: Bearer $ADM"
# -> { users: [ { id: "<DOC>", name: "New Doctor", verified: false, … } ] }

curl -s -X PATCH localhost:5000/api/admin/users/<DOC>/verify -H "Authorization: Bearer $ADM"
# -> { message: "Doctor verified", user: { …, verified: true } }

curl -s -X POST localhost:5000/api/admin/users -H "Authorization: Bearer $ADM" \
  -H 'Content-Type: application/json' \
  -d '{"name":"City Diagnostics","email":"lab2@example.com","password":"Str0ngPass!","organisation":"City Diagnostics Pvt Ltd"}'
# -> 201 { user: { role: "lab", verified: true, organisation: "City Diagnostics Pvt Ltd", … } }
```
