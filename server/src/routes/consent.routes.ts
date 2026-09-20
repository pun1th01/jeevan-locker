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
import { requireRole, verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.use(verifyToken);
// TODO(Task 2, item 7 — doctor verification gate): add `requireVerifiedDoctor` after requireRole('doctor') on /request.
router.post('/request', requireRole('doctor'), requestConsent);
router.get('/my', requireRole('doctor'), getMyConsents);
router.get('/pending', requireRole('patient'), getPendingConsents);
router.get('/received', requireRole('patient'), getReceivedConsents);
router.patch('/:id/approve', requireRole('patient'), approveConsent);
router.patch('/:id/reject', requireRole('patient'), rejectConsent);
router.patch('/:id/revoke', requireRole('patient'), revokeConsent);

export default router;
