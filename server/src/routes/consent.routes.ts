import { Router } from 'express';
import {
  approveConsent,
  getMyConsents,
  getPendingConsents,
  getReceivedConsents,
  rejectConsent,
  requestConsent,
  revokeConsent,
} from '../controllers/consent.controller';
import { requireRole, requireVerifiedDoctor, verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.use(verifyToken);
// Only /request is gated on verification; /my stays open so an unverified doctor can still see their history.
router.post('/request', requireRole('doctor'), requireVerifiedDoctor, requestConsent);
router.get('/my', requireRole('doctor'), getMyConsents);
router.get('/pending', requireRole('patient'), getPendingConsents);
router.get('/received', requireRole('patient'), getReceivedConsents);
router.patch('/:id/approve', requireRole('patient'), approveConsent);
router.patch('/:id/reject', requireRole('patient'), rejectConsent);
router.patch('/:id/revoke', requireRole('patient'), revokeConsent);

export default router;
