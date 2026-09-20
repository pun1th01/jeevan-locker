import { Router } from 'express';
import { grantEmergencyAccess } from '../controllers/emergencyAccess.controller';
import { requireRole, requireVerifiedDoctor, verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.use(verifyToken, requireRole('doctor'), requireVerifiedDoctor);

router.post('/', grantEmergencyAccess);

export default router;
