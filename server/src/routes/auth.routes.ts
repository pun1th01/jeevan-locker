import { Router } from 'express';
import { getCurrentUser, loginUser, registerUser } from '../controllers/auth.controller';
import { verifyToken } from '../middleware/auth.middleware';
import { loginRateLimiter, registerRateLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

router.post('/register', registerRateLimiter, registerUser);
router.post('/login', loginRateLimiter, loginUser);
router.get('/me', verifyToken, getCurrentUser);

export default router;
