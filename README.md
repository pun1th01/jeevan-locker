# JeevanLocker

JeevanLocker is a highly secure, blockchain-backed medical document management system. It enables patients to securely store, manage, and share their medical records with healthcare providers and laboratories.

## 1. Project Overview

The current application is built with the following stack:
- **Frontend**: React 19, TypeScript, Vite
- **Backend**: Express 5, TypeScript, Mongoose
- **Database**: MongoDB (with dynamic in-memory failover for local development)
- **Document Storage**: Encrypted at rest (AES-256-GCM) on local disk
- **Blockchain**: Hardhat local Ethereum-compatible network (used for document integrity verification and audit anchoring)

## 2. Major Features

- **Secure Authentication**: Role-based access control (RBAC) with JWT.
- **Encrypted Document Storage**: Documents are encrypted at rest using AES-256-GCM.
- **Blockchain Integrity Verification**: A plaintext SHA-256 hash of the uploaded document is stored on-chain, proving document authenticity.
- **Consent Workflow**: Patients explicitly grant, reject, or revoke access to doctors.
- **Emergency / Break-Glass Access**: Verified doctors can request time-bound emergency access to documents without prior consent, subject to strict audit trails and limits.
- **Audit Logging & Anchoring**: Critical actions (like consent grants and emergency access) are logged and periodically anchored to the blockchain.
- **Lab Integration**: Dedicated Lab roles can link with patients, upload verified lab reports (with NABL certification), and highlight critical test values.
- **Administrative Tools**: Admins can manage users, oversee audit anchors, and verify doctor accounts.

## 3. User Roles

JeevanLocker supports four distinct roles:

1. **Patient**: Can upload documents, request lab links, approve/reject/revoke consent requests, and manage their health profile.
2. **Doctor**: Can request access to patient documents. *Verified* doctors can use the Emergency / Break-Glass feature to bypass consent in life-threatening scenarios.
3. **Lab**: Can request links with patients and upload verified lab reports with structured test data.
4. **Admin**: Can view audit logs, manage anchor synchronization, and verify unverified doctor accounts. (Admin self-registration is strictly blocked).

## 4. System Architecture

```
[ React Client ]
       ↓
[ Express API ]
       ↓
[ MongoDB ] — stores metadata, users, consents, and audit logs.
       ↓
[ Encrypted Document Storage ] — files are AES-256-GCM encrypted on disk.
       ↓
[ Hardhat Blockchain ] — smart contracts store integrity hashes and audit anchors.
```
During development, the Hardhat node runs locally to simulate an Ethereum-compatible network. Blockchain data is exclusively used for verifying data integrity and anchoring audits, while actual document content and PII never touch the chain.

## 5. Document Encryption and Integrity

1. When a patient uploads a document, the API computes the **plaintext SHA-256 hash**.
2. The file is then **encrypted at rest** using AES-256-GCM with a server-side Master Key and stored on disk.
3. The computed plaintext SHA-256 hash is submitted to the local blockchain via the `DocumentRegistry` contract.
4. When a user requests integrity verification, the system retrieves the on-chain hash and compares it against the expected document hash, ensuring the file hasn't been tampered with.

## 6. Blockchain Configuration

JeevanLocker uses two primary smart contracts deployed on a local Hardhat node:
- **`DOCUMENT_REGISTRY_ADDRESS`**: Stores plaintext document hashes.
- **`AUDIT_ANCHOR_ADDRESS`**: Stores cryptographic digests of critical audit events.

The automated startup script handles deploying these contracts and updating the server's `.env` configuration dynamically.

## 7. Authentication and Access Control

- **Mechanism**: JWT Bearer tokens passed via the `Authorization` header.
- **Verification**: Doctors must be explicitly verified by an Admin before they can perform sensitive actions (like Patient Lookups, requesting Consents, or using Break-Glass).
- **Rate Limiting**: Strict rate limiting is applied to authentication and lookup routes to prevent enumeration.

## 8. Consent Flow

1. **Doctor** searches for a patient (if verified) and requests access to a specific document.
2. **Patient** sees a pending consent request in their dashboard.
3. **Patient** approves or rejects the request.
4. If approved, the doctor gains access. The patient can later **revoke** this consent at any time.

## 9. Emergency / Break-Glass Flow

1. A **Verified Doctor** declares an emergency to access a patient's document without prior consent.
2. Access is immediately granted for a configurable time window (e.g., 15 minutes).
3. The system enforces a strict cap on how many active emergency grants a doctor can hold concurrently.
4. Once the window expires, access is automatically revoked.
5. All break-glass actions are heavily audited and anchored to the blockchain.

## 10. Lab Flow

1. A **Lab** requests a link with a Patient using their email.
2. The **Patient** approves the Lab Link.
3. The **Lab** can now upload structured lab reports (including NABL Certification numbers, reference ranges, and critical value flags) directly to the patient's locker.
4. Lab reports are marked as "Verified" and cannot be tampered with.

See [API_LAB.md](docs/API_LAB.md) for full endpoint details.

## 11. Admin Flow

Admins are manually provisioned (via CLI/seed) and cannot self-register. Admins oversee the platform by verifying doctors, monitoring audit logs, and managing blockchain anchors.

See [API_ADMIN.md](docs/API_ADMIN.md) for full endpoint details.

## 12. API Reference

### Authentication (`/api/auth`)
| Method | Endpoint | Access | Purpose |
|--------|----------|--------|---------|
| POST | `/register` | Public | Register a new user |
| POST | `/login` | Public | Authenticate and receive JWT |
| GET | `/me` | Authenticated | Get current user profile |

### Patient Lookup (`/api/patients`)
| Method | Endpoint | Access | Purpose |
|--------|----------|--------|---------|
| GET | `/lookup` | Verified Doctor | Look up a patient by email |

### Documents (`/api/documents`)
| Method | Endpoint | Access | Purpose |
|--------|----------|--------|---------|
| POST | `/upload` | Patient | Upload and encrypt a document |
| GET | `/my-documents` | Authenticated | List accessible documents |
| GET | `/:id/view` | Authenticated | Stream decrypted document |
| GET | `/:id/download` | Authenticated | Download decrypted document |
| GET | `/:id/integrity` | Authenticated | Verify blockchain integrity |
| PATCH | `/:id/share` | Patient | Direct share with a doctor |

### Consent (`/api/consents`)
| Method | Endpoint | Access | Purpose |
|--------|----------|--------|---------|
| POST | `/request` | Verified Doctor | Request access to a document |
| GET | `/my` | Doctor | List outgoing requests |
| GET | `/pending` | Patient | List incoming pending requests |
| GET | `/received` | Patient | List all incoming requests |
| PATCH | `/:id/approve` | Patient | Approve a request |
| PATCH | `/:id/reject` | Patient | Reject a request |
| PATCH | `/:id/revoke` | Patient | Revoke an active consent |

### Emergency / Break-Glass (`/api/emergency-access`)
| Method | Endpoint | Access | Purpose |
|--------|----------|--------|---------|
| POST | `/` | Verified Doctor | Declare emergency for a document |
| GET | `/` | Patient, Doctor | List emergency access records |
| DELETE | `/:id` | Patient | Manually revoke an emergency grant |

### Lab (`/api/lab-links`, `/api/lab-reports`)
See [API_LAB.md](docs/API_LAB.md) for endpoints.

### Admin (`/api/admin`)
See [API_ADMIN.md](docs/API_ADMIN.md) for endpoints.

## 13. Environment Variables

Create a `server/.env` file based on `server/.env.example`.

```env
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/jeevan-locker
JWT_SECRET=<your-random-secret>
CLIENT_ORIGIN=http://localhost:5173
TRUST_PROXY=

# Blockchain configuration
BLOCKCHAIN_RPC_URL=http://127.0.0.1:8545
BLOCKCHAIN_PRIVATE_KEY=<your-hardhat-private-key>
DOCUMENT_REGISTRY_ADDRESS=<auto-populated-by-startup>
AUDIT_ANCHOR_ADDRESS=<auto-populated-by-startup>

# Encryption keys
DOCUMENT_MASTER_KEY=<base64-encoded-32-byte-key>
DOCUMENT_MASTER_KEY_ID=primary

# Configuration limits
ANCHOR_RECONCILE_WINDOW_DAYS=0
EMERGENCY_ACCESS_DURATION_MINUTES=15
EMERGENCY_MAX_ACTIVE_GRANTS=5
EMERGENCY_REGRANT_WINDOW_HOURS=24
EMERGENCY_EXPIRY_POLL_MS=60000
EMERGENCY_EXPIRY_BATCH_LIMIT=200
```

## 14. Prerequisites

- Node.js (v20+ recommended)
- npm
- Git

*(Note: A local MongoDB installation is not strictly required for development testing due to the in-memory failover feature).*

## 15. Installation

```bash
git clone <repository-url>
cd jeevan-locker

# Install server dependencies
cd server
npm install

# Install client dependencies
cd ../client
npm install
```

## 16. Environment Setup

Copy the example environment file:
```bash
cd server
cp .env.example .env
```
Ensure `JWT_SECRET` is set. The one-command startup script will automatically handle generating the `DOCUMENT_MASTER_KEY` and populating the blockchain addresses.

## 17. One-Command Development Startup

To run the entire stack (Blockchain, API, and Client) with automatic configuration:

```bash
cd server
node scripts/dev-startup.js
```

**What this does:**
1. Spawns the local Hardhat blockchain node.
2. Waits for RPC readiness.
3. Compiles and deploys the `DocumentRegistry` and `AuditAnchorRegistry` contracts.
4. Extracts the contract addresses and writes them to `server/.env`.
5. Generates `DOCUMENT_MASTER_KEY` in `.env` if missing.
6. Starts the Express API (`npm run dev`), which automatically seeds demo users, documents, and on-chain hashes.
7. Starts the Vite React client (`npm run dev`).

*If startup fails, ensure port 8545, 5000, and 5173 are free, and verify `.env` formatting.*

## 18. Manual Development Startup

If you prefer to start services manually in separate terminals:

```bash
# Terminal 1: Blockchain
cd server
npm run chain

# Terminal 2: Deployment
cd server
npm run chain:deploy
# (Manually copy addresses to .env, and generate DOCUMENT_MASTER_KEY)

# Terminal 3: Server
cd server
npm run dev

# Terminal 4: Client
cd client
npm run dev
```

## 19. MongoDB Development Gotcha

**Important Note for Developers:**
In `server/src/config/db.ts`, if `NODE_ENV` is `development` AND the `MONGO_URI` includes `127.0.0.1`, the server will automatically intercept the connection and spawn a temporary `mongodb-memory-server`.

- **Why:** This ensures zero-configuration startup for new developers and prevents state contamination between test runs.
- **Impact:** **Your database data will disappear every time you restart the server.**
- **Workaround:** To use a persistent local database, change `MONGO_URI` in `.env` to use `localhost` instead of `127.0.0.1` (e.g., `mongodb://localhost:27017/jeevan-locker`), which bypasses the in-memory interceptor.

## 20. Testing

JeevanLocker features a robust automated test suite (934 tests) utilizing Vitest, Supertest, and Hardhat. The test suite automatically provisions its own in-memory MongoDB and Hardhat network, ignoring your `.env`.

To run the test suite:
```bash
cd server
npm test
```
The suite fully covers access control, break-glass workflow, encryption at rest, file validation, route guards, and blockchain anchoring logic. See [TESTING.md](docs/TESTING.md) for details.

## 21. Build

To compile the TypeScript backend for production:
```bash
cd server
npm run build
```

To compile the React frontend:
```bash
cd client
npm run build
```

## 22. Documentation Links

- [Lab API Documentation](docs/API_LAB.md)
- [Admin API Documentation](docs/API_ADMIN.md)
- [System Events Documentation](docs/EVENTS.md)
- [Testing Architecture](docs/TESTING.md)

## 23. Project Status

The Phase II implementation is feature-complete for demonstration purposes. The local blockchain integration, encryption at rest, lab workflows, and the 934-test automated suite are fully operational.
