# JeevanLocker

JeevanLocker is a secure, full-stack medical records management system built to be scalable and ready for future blockchain integration.

## Architecture

This project is structured as a monorepo containing:
- `client/`: React + Vite frontend with Tailwind CSS and Zustand.
- `server/`: Node.js + Express backend with MongoDB and JWT Auth.
- `docs/`: Future documentation and architecture guidelines.

## Requirements

- Node.js > 18
- MongoDB (Running locally or MongoDB Atlas)

## Setup Instructions

1. **Clone the repository**
   ```bash
   git clone <repo-url>
   cd jeevan-locker
   ```

2. **Backend Setup**
   ```bash
   cd server
   npm install
   cp .env.example .env
   # Update .env if necessary
   npm run dev
   ```
   The backend will start on `http://localhost:5000`.

3. **Frontend Setup**
   ```bash
   cd client
   npm install
   npm run dev
   ```
   The frontend will start on typically `http://localhost:5173`.

## Environment Variables

Check `server/.env.example` to see required variables (e.g. `MONGO_URI`, `JWT_SECRET`, `PORT`).
