import { Router } from 'express';
import { getCurrentUser, loginUser, registerUser } from '../controllers/auth.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.get('/me', verifyToken, getCurrentUser);

export default router;
