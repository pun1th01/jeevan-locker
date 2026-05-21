import jwt from 'jsonwebtoken';
import type { IUser } from '../models/User';
import { env } from '../config/env';
import type { SafeUser } from '../types/user.types';

export const toSafeUser = (user: IUser): SafeUser => ({
  id: user._id.toString(),
  name: user.name,
  email: user.email,
  role: user.role,
  createdAt: user.createdAt.toISOString(),
});

export const generateAuthToken = (user: IUser): string =>
  jwt.sign(
    {
      userId: user._id.toString(),
      role: user.role,
    },
    env.jwtSecret,
    { expiresIn: '7d' }
  );
