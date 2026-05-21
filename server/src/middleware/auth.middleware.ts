import type { RequestHandler } from 'express';
import jwt, { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { env } from '../config/env';
import { User } from '../models/User';
import type { AuthenticatedRequest, AuthTokenPayload } from '../types/auth.types';
import type { UserRole } from '../types/user.types';
import { toSafeUser } from '../utils/auth.util';
import { asyncHandler } from '../utils/asyncHandler.util';

const getBearerToken = (authorizationHeader: string | undefined): string | null => {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }

  return authorizationHeader.split(' ')[1] ?? null;
};

export const verifyToken: RequestHandler = asyncHandler(async (req, res, next) => {
  const token = getBearerToken(req.headers.authorization);

  if (!token) {
    res.status(401).json({ message: 'Authentication token is required' });
    return;
  }

  try {
    const decoded = jwt.verify(token, env.jwtSecret) as AuthTokenPayload;

    if (!decoded.userId) {
      res.status(401).json({ message: 'Invalid authentication token' });
      return;
    }

    const user = await User.findById(decoded.userId);

    if (!user) {
      res.status(401).json({ message: 'Authenticated user no longer exists' });
      return;
    }

    (req as AuthenticatedRequest).user = toSafeUser(user);
    next();
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      res.status(401).json({ message: 'Authentication token has expired' });
      return;
    }

    if (error instanceof JsonWebTokenError) {
      res.status(401).json({ message: 'Invalid authentication token' });
      return;
    }

    throw error;
  }
});

export const requireRole = (...roles: UserRole[]): RequestHandler => {
  return (req, res, next) => {
    const authRequest = req as AuthenticatedRequest;

    if (!authRequest.user) {
      res.status(401).json({ message: 'Authentication is required' });
      return;
    }

    if (!roles.includes(authRequest.user.role)) {
      res.status(403).json({ message: 'You do not have permission to access this resource' });
      return;
    }

    next();
  };
};
