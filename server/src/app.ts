import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import auditRoutes from './routes/audit.routes';
import authRoutes from './routes/auth.routes';
import documentRoutes from './routes/document.routes';
import emergencyAccessRoutes from './routes/emergencyAccess.routes';
import consentRoutes from './routes/consent.routes';
import patientsRoutes from './routes/patients.routes';

export const app = express();

// Must be set before any middleware reads req.ip (audit logging, rate limiting). See env.ts for the rules.
app.set('trust proxy', env.trustProxy);

app.use(helmet());
app.use(
  cors({
    origin: env.clientOrigin,
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', message: 'JeevanLocker API is running' });
});

app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/emergency-access', emergencyAccessRoutes);
app.use('/api/consents', consentRoutes);
app.use('/api/patients', patientsRoutes);
app.use('/api/audit', auditRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
