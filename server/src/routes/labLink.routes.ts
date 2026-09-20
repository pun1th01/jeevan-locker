import { Router } from 'express';
import { approveLabLink, listLabLinks, rejectLabLink, requestLabLink, revokeLabLink } from '../controllers/labLink.controller';
import { requireRole, verifyToken } from '../middleware/auth.middleware';
import { labLinkRateLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

router.use(verifyToken);

// Lab-initiated. Same lookup rules and the same per-user throttle as GET /patients/lookup.
router.post('/', requireRole('lab'), labLinkRateLimiter, requestLabLink);
router.get('/', requireRole('patient', 'lab'), listLabLinks);
router.patch('/:id/approve', requireRole('patient'), approveLabLink);
router.patch('/:id/reject', requireRole('patient'), rejectLabLink);
router.delete('/:id', requireRole('patient'), revokeLabLink);

export default router;
