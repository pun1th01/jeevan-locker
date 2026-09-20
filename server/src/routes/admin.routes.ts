import { Router } from 'express';
import { createLabUser, listUsers, verifyDoctor } from '../controllers/admin.controller';
import { requireRole, verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.use(verifyToken, requireRole('admin'));

router.get('/users', listUsers);
// Lab accounts only. Admin creation stays CLI-only, permanently — see createLabUser.
router.post('/users', createLabUser);
router.patch('/users/:id/verify', verifyDoctor);

export default router;
