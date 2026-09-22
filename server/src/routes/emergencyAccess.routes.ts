import { Router } from 'express';
import { grantEmergencyAccess, listEmergencyAccesses, revokeEmergencyAccess } from '../controllers/emergencyAccess.controller';
import { requireRole, requireVerifiedDoctor, verifyToken } from '../middleware/auth.middleware';

const router = Router();

// Authentication applies to every route here; the role gates are per-route because this router is no
// longer doctor-only. Starting break-glass stays restricted to a VERIFIED doctor exactly as before —
// requireRole('doctor') + requireVerifiedDoctor moved from router.use onto POST / and nowhere else.
router.use(verifyToken);

router.post('/', requireRole('doctor'), requireVerifiedDoctor, grantEmergencyAccess);
router.get('/', requireRole('patient', 'doctor'), listEmergencyAccesses);
router.delete('/:id', requireRole('patient'), revokeEmergencyAccess);

export default router;
