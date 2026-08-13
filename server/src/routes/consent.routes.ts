import { Router } from 'express';
import {
  approveConsent,
  getMyConsents,
  getPendingConsents,
  getReceivedConsents,
  listConsentTargets,
  rejectConsent,
  requestConsent,
  revokeConsent,
} from '../controllers/consent.controller';
import { requireRole, verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.use(verifyToken);
router.post('/request', requireRole('doctor'), requestConsent);
router.get('/targets', requireRole('doctor'), listConsentTargets);
router.get('/my', requireRole('doctor'), getMyConsents);
router.get('/pending', requireRole('patient'), getPendingConsents);
router.get('/received', requireRole('patient'), getReceivedConsents);
router.patch('/:id/approve', requireRole('patient'), approveConsent);
router.patch('/:id/reject', requireRole('patient'), rejectConsent);
router.patch('/:id/revoke', requireRole('patient'), revokeConsent);

export default router;
