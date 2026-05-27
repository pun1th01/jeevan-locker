import { Router } from 'express';
import { getAuditSummary } from '../controllers/audit.controller';
import { requireRole, verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/summary', verifyToken, requireRole('admin'), getAuditSummary);

export default router;
