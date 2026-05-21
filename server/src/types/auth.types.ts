import type { Request } from 'express';
import type { JwtPayload } from 'jsonwebtoken';
import type { SafeUser, UserRole } from './user.types';

export interface AuthenticatedRequest extends Request {
  user?: SafeUser;
}

export interface AuthTokenPayload extends JwtPayload {
  userId: string;
  role: UserRole;
}
