import type { RequestHandler, Response } from 'express';
import { User, type IUser } from '../models/User';
import type { AuthenticatedRequest } from '../types/auth.types';
import { createAuditLog, getRequestIpAddress } from '../utils/audit.util';
import { generateAuthToken, toSafeUser } from '../utils/auth.util';
import { asyncHandler } from '../utils/asyncHandler.util';
import { validateLoginInput, validateRegisterInput } from '../utils/validation.util';

const sendAuthResponse = (res: Response, statusCode: number, user: IUser) => {
  res.status(statusCode).json({
    user: toSafeUser(user),
    token: generateAuthToken(user),
  });
};

export const registerUser: RequestHandler = asyncHandler(async (req, res) => {
  const validation = validateRegisterInput(req.body);

  if (!validation.data) {
    res.status(400).json({ message: 'Validation failed', errors: validation.errors });
    return;
  }

  const existingUser = await User.exists({ email: validation.data.email });

  if (existingUser) {
    res.status(409).json({ message: 'A user with this email already exists' });
    return;
  }

  const user = await User.create(validation.data);
  sendAuthResponse(res, 201, user);
});

export const loginUser: RequestHandler = asyncHandler(async (req, res) => {
  const validation = validateLoginInput(req.body);

  if (!validation.data) {
    res.status(400).json({ message: 'Validation failed', errors: validation.errors });
    return;
  }

  const user = await User.findOne({ email: validation.data.email }).select('+password');

  if (!user || !(await user.comparePassword(validation.data.password))) {
    res.status(401).json({ message: 'Invalid email or password' });
    return;
  }

  await createAuditLog({
    userId: user._id,
    action: 'USER_LOGIN',
    ipAddress: getRequestIpAddress(req),
  });

  sendAuthResponse(res, 200, user);
});

export const getCurrentUser: RequestHandler = (req, res) => {
  const authRequest = req as AuthenticatedRequest;

  if (!authRequest.user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  res.json({ user: authRequest.user });
};
