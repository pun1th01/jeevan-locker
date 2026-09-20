import { Router } from 'express';
import { lookupPatient } from '../controllers/patients.controller';
import { requireRole, verifyToken } from '../middleware/auth.middleware';

const router = Router();

// TODO(Task 2, item 7 — doctor verification gate): insert `requireVerifiedDoctor` after
// requireRole('doctor') here. Unverified doctors must get a 403 from lookup, consent request,
// and emergency access. Until then any doctor account can look patients up.
router.use(verifyToken, requireRole('doctor'));

router.get('/lookup', lookupPatient);

export default router;
