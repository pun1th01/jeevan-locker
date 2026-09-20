import { Router } from 'express';
import { grantEmergencyAccess } from '../controllers/emergencyAccess.controller';
import { requireRole, verifyToken } from '../middleware/auth.middleware';

const router = Router();

// TODO(Task 2, item 7 — doctor verification gate): add `requireVerifiedDoctor` after requireRole('doctor').
router.use(verifyToken, requireRole('doctor'));

router.post('/', grantEmergencyAccess);

export default router;
