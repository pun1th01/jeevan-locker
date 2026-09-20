import { Router } from 'express';
import { lookupPatient } from '../controllers/patients.controller';
import { requireRole, verifyToken } from '../middleware/auth.middleware';
import { patientLookupRateLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

router.use(verifyToken, requireRole('doctor'));

// Middleware order on /lookup is deliberate and must be kept when the verification gate lands:
//   verifyToken -> requireRole('doctor') -> patientLookupRateLimiter -> requireVerifiedDoctor -> lookupPatient
// The limiter needs verifyToken first (it keys on the user id), and it must run BEFORE the gate:
// otherwise an unverified doctor can loop on this endpoint unthrottled — each request costs a DB
// user read in verifyToken and never increments a counter. Throttle first, then authorize.
// TODO(Task 2, item 7 — doctor verification gate): insert `requireVerifiedDoctor` between
// patientLookupRateLimiter and lookupPatient on the line below. Unverified doctors get 403 here,
// on POST /consents/request, and on POST /emergency-access.
router.get('/lookup', patientLookupRateLimiter, lookupPatient);

export default router;
