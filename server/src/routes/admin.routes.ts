import { Router } from 'express';
import { listUsers, verifyDoctor } from '../controllers/admin.controller';
import { requireRole, verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.use(verifyToken, requireRole('admin'));

router.get('/users', listUsers);
router.patch('/users/:id/verify', verifyDoctor);

export default router;
