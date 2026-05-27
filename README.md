# JeevanLocker

JeevanLocker is a secure, role-based medical document management MVP designed to streamline how patients, doctors, and administrators interact with clinical records. Built on the MERN stack with TypeScript, the platform tackles the fragmentation of personal health records by providing a centralized, secure vault where patients control access to their sensitive documents. 

In its current MVP scope, the platform demonstrates a functional architecture for secure file uploads, role-based access control (RBAC), controlled document sharing, and comprehensive audit logging.

---

## 🎯 Features

### Authentication & Security
* **JWT Authentication:** Secure, stateless session management using HTTP-only compatible token flows.
* **Role-Based Access Control (RBAC):** Strict permissions dividing the platform into Patient, Doctor, and Admin workspaces.
* **Protected Routes:** Frontend and backend validation preventing unauthorized access.
* **Seeded Demo Accounts:** Auto-provisioned development accounts for immediate testing.
* **Upload Validation:** Strict MIME type checking and file size limits (5MB) using Multer.
* **Audit Logging:** Every login, document upload, and sharing event is recorded and timestamped with IP context.

### Medical Document Management
* **Document Vault:** Centralized storage for patient medical histories.
* **Metadata Management:** Documents are categorized by type, date, and description.
* **Role-Based Retrieval:** Documents are strictly bound to their owner unless explicitly shared.
* **Doctor Sharing Workflow:** Patients can temporarily grant access to specific doctors.
* **Secure Previews & Downloads:** Handled directly through memory streams and secure headers to prevent unauthorized direct asset links.

### Dashboards
* **Patient Dashboard:** View personal health records, upload new documents, and manage active sharing permissions.
* **Doctor Dashboard:** View records shared by patients, filtered efficiently for quick clinical access.
* **Admin Dashboard:** Platform-wide oversight, system monitoring, and comprehensive audit log reviews.

### UI/UX
* **Modern Aesthetic:** Dark medical-tech theme utilizing Tailwind CSS and Radix UI primitives.
* **Drag-and-Drop Uploads:** Intuitive file dropping with immediate validation feedback.
* **State Management:** Loading spinners, context-aware error toasts, and smooth transitions.
* **Responsive Design:** Mobile-first approach ensuring usability across all devices.

---

## 🛠 Tech Stack

### Frontend
- **Framework:** React 19 + TypeScript
- **Tooling:** Vite
- **Styling:** Tailwind CSS + Radix UI
- **State Management:** Zustand (with persistence)
- **Routing:** React Router v7
- **HTTP Client:** Axios

### Backend
- **Framework:** Node.js + Express
- **Language:** TypeScript
- **Database:** MongoDB + Mongoose (with `mongodb-memory-server` for dev)
- **Authentication:** JSON Web Tokens (JWT) + bcrypt
- **File Handling:** Multer

---

## 🏗 System Architecture

* **Frontend/Backend Separation:** Clean decoupled architecture communicating via REST APIs.
* **API Architecture:** Standardized response formats and centralized error handling middleware.
* **RBAC Flow:** Requests hit authorization middlewares that verify JWT integrity and exact role requirements before mounting controllers.
* **Secure File Flow:** Files are validated in-memory, stored securely, and served via protected endpoints—never directly exposed to public static folders.
* **Audit Logging Architecture:** An independent Mongoose model hooks into critical controllers (Auth, Document) to silently write non-blocking logs for compliance tracking.

---

## 📁 Project Structure

```text
jeevan-locker/
├── client/              # React/Vite Frontend
│   ├── src/             
│   │   ├── components/  # Reusable UI primitives (Radix) & Layouts
│   │   ├── lib/         # Axios config & utility functions
│   │   ├── pages/       # Role-specific dashboard views & auth
│   │   ├── services/    # API integration layer
│   │   └── store/       # Zustand state management
│   └── package.json
└── server/              # Express/Node Backend
    ├── src/             
    │   ├── config/      # Environment & DB configurations
    │   ├── controllers/ # Request handlers
    │   ├── middleware/  # JWT auth, RBAC, formatting, & error handling
    │   ├── models/      # Mongoose Schemas (User, Document, AuditLog)
    │   ├── routes/      # Express route definitions
    │   └── utils/       # Validation, hashing, and seeding utilities
    └── package.json
```

---

## 🔑 Demo Accounts

For immediate testing, development-only seeded accounts are initialized on startup:

| Role | Email | Password |
| :--- | :--- | :--- |
| **Admin** | `admin@jeevanlocker.dev` | `Admin123!` |
| **Doctor** | `doctor@jeevanlocker.dev` | `Doctor123!` |
| **Patient** | `patient@jeevanlocker.dev` | `Patient123!` |

*(Note: These accounts only seed when `NODE_ENV=development`)*

---

## 🚀 Setup Instructions

### Prerequisites
- Node.js > 18.x
- Git

### 1. Clone the repository
```bash
git clone https://github.com/pun1th01/jeevan-locker.git
cd jeevan-locker
```

### 2. Backend Setup
```bash
cd server
npm install

# The dev server will automatically use an In-Memory MongoDB 
# instance if no local MongoDB is detected on port 27017!
npm run dev
```

### 3. Frontend Setup (New Terminal)
```bash
cd client
npm install
npm run dev
```

The frontend will start at `http://localhost:5173`.

---

## 🔌 API Overview

* **Auth:** `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
* **Documents:** `GET /api/documents`, `POST /api/documents/upload`
* **Sharing:** `POST /api/documents/:id/share`, `DELETE /api/documents/:id/share/:doctorId`
* **Preview/Download:** `GET /api/documents/:id/preview`, `GET /api/documents/:id/download`
* **Audit:** `GET /api/audit/logs`

---

## 🛡 Security Considerations

**Implemented Systems:**
* **Stateless JWT Auth:** Bearer tokens used for localized session persistence.
* **RBAC:** Backend endpoints enforce strict role verification.
* **Protected File Access:** Documents cannot be requested without a valid JWT matching the owner or a doctor in the shared list.
* **Upload Safety:** Multer buffer restrictions protect against infinite-size payload attacks.
* **Audit Logging:** Core actions are independently verified and logged.

**Future Scope:**
* End-to-End Encryption (E2EE)
* Immutable Blockchain Ledgers

*(Note: The current implementation demonstrates the architectural foundation. It is an MVP and does not claim enterprise-grade compliance out-of-the-box.)*

---

## 📈 Current MVP Status

JeevanLocker is currently in the **MVP / Developer Preview** phase.
The system efficiently handles localized end-to-end functionality including database persistence, UI, role gating, and core workflows. Intentionally simplified for demonstration, file assets are stored locally, and the database utilizes an in-memory fallback to eliminate friction during peer reviews.

---

## 🔮 Future Improvements

If extended towards production, the following architectures would be integrated:
* **Blockchain Verification:** Storing document hashes on a ledger for immutable proof-of-authenticity.
* **Encryption-at-Rest:** AES-256 implementation natively within the database layer.
* **Cloud Storage:** Transitioning local buffers to AWS S3 / GCP buckets.
* **Notifications:** Socket-based push alerts for document sharing.
* **OCR Integration:** Extracting deep text from uploaded medical scans.
* **Production Deployment:** Dockerization and CI/CD pipelines.

---

## 📸 Screenshots

*(Add screenshots here using markdown placeholders)*

* ![Login Page](#) 
* ![Patient Dashboard](#)
* ![Doctor Dashboard](#)
* ![Admin Dashboard](#)
* ![Upload Modal](#)
* ![Preview Modal](#)

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE).
