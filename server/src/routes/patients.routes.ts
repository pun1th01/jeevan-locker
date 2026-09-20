import { Router } from 'express';
import { lookupPatient } from '../controllers/patients.controller';
import { requireRole, requireVerifiedDoctor, verifyToken } from '../middleware/auth.middleware';
import { patientLookupRateLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

router.use(verifyToken, requireRole('doctor'));

// Middleware order on /lookup is deliberate:
//   verifyToken -> requireRole('doctor') -> patientLookupRateLimiter -> requireVerifiedDoctor -> lookupPatient
// The limiter needs verifyToken first (it keys on the user id), and it must run BEFORE the verification
// gate: otherwise an unverified doctor could loop on this endpoint unthrottled — each request costs a DB
// user read in verifyToken and would never increment a counter. Throttle first, then authorize.
router.get('/lookup', patientLookupRateLimiter, requireVerifiedDoctor, lookupPatient);

export default router;
