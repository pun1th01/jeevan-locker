import { Router } from 'express';
import { grantEmergencyAccess, listEmergencyAccessTargets } from '../controllers/emergencyAccess.controller';
import { requireRole, verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.use(verifyToken, requireRole('doctor'));

router.get('/targets', listEmergencyAccessTargets);
router.post('/', grantEmergencyAccess);

export default router;
