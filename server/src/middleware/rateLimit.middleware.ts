import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { AuthenticatedRequest } from '../types/auth.types';

/**
 * All limiters key on req.ip, which is only trustworthy because `trust proxy` is configured explicitly
 * (see config/env.ts). The in-memory store resets on restart; fine for a single-process deployment — the same
 * assumption as sendSerialized (chain.service.ts, the wallet nonce) and the per-doctor break-glass lock
 * (withDoctorGrantLock, emergencyAccess.util.ts). Several instances would need a shared store (e.g. Redis).
 */

const MINUTE_MS = 60 * 1000;

const tooManyRequests =
  (message: string): RequestHandler =>
  (_req, res) => {
    res.status(429).json({ message });
  };

/** Anonymous endpoints: keyed by client IP (IPv6-safe). */
const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');

/** Authenticated endpoints: keyed by user id so one account cannot spread lookups across addresses; IP fallback. */
const userKey = (req: Request) => (req as AuthenticatedRequest).user?.id ?? ipKey(req);

/** POST /auth/login — 10 attempts per IP per 15 minutes. */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * MINUTE_MS,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: ipKey,
  handler: tooManyRequests('Too many login attempts. Try again in 15 minutes.'),
});

/** POST /auth/register — 5 registrations per IP per hour. */
export const registerRateLimiter = rateLimit({
  windowMs: 60 * MINUTE_MS,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: ipKey,
  handler: tooManyRequests('Too many accounts created from this address. Try again in an hour.'),
});

/** GET /patients/lookup — 30 lookups per doctor per 15 minutes; mount AFTER verifyToken so the user key exists. */
export const patientLookupRateLimiter = rateLimit({
  windowMs: 15 * MINUTE_MS,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: userKey,
  handler: tooManyRequests('Too many patient lookups. Try again later.'),
});

/** POST /lab-links — 30 link requests (each is a patient lookup) per lab per 15 minutes; mount AFTER verifyToken. */
export const labLinkRateLimiter = rateLimit({
  windowMs: 15 * MINUTE_MS,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: userKey,
  handler: tooManyRequests('Too many patient lookups. Try again later.'),
});
