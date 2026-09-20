import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { User } from '../models/User';
import type { AuthenticatedRequest } from '../types/auth.types';
import { createAuditLog, getRequestIpAddress } from '../utils/audit.util';
import { asyncHandler } from '../utils/asyncHandler.util';
import { toSafeUser } from '../utils/auth.util';
import { isUserRole } from '../utils/validation.util';

const getIdParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] ?? '' : value ?? '');
const getQueryString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/**
 * GET /api/admin/users?role=<role>&verified=<true|false>
 * Both filters optional. Oldest first so a verification queue reads top-down in arrival order.
 */
export const listUsers: RequestHandler = asyncHandler(async (req, res) => {
  const role = getQueryString(req.query.role);
  const verified = getQueryString(req.query.verified).toLowerCase();
  const filter: Record<string, unknown> = {};

  if (role) {
    if (!isUserRole(role)) {
      res.status(400).json({ message: 'role must be one of patient, doctor, admin' });
      return;
    }

    filter.role = role;
  }

  if (verified) {
    if (verified !== 'true' && verified !== 'false') {
      res.status(400).json({ message: 'verified must be true or false' });
      return;
    }

    filter.verified = verified === 'true';
  }

  const users = await User.find(filter).sort({ createdAt: 1 });
  res.json({ users: users.map(toSafeUser) });
});

/**
 * PATCH /api/admin/users/:id/verify
 * Idempotent: a second call returns 200 with the same user and writes no second audit row.
 */
export const verifyDoctor: RequestHandler = asyncHandler(async (req, res) => {
  const admin = (req as AuthenticatedRequest).user;

  if (!admin) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const userId = getIdParam(req.params.id);

  if (!Types.ObjectId.isValid(userId)) {
    res.status(400).json({ message: 'A valid user ID is required' });
    return;
  }

  const user = await User.findById(userId);

  if (!user) {
    res.status(404).json({ message: 'User not found' });
    return;
  }

  if (user.role !== 'doctor') {
    res.status(400).json({ message: 'Only doctor accounts require verification' });
    return;
  }

  if (user.verified) {
    res.json({ message: 'Doctor is already verified', user: toSafeUser(user) });
    return;
  }

  user.verified = true;
  await user.save();

  await createAuditLog({
    userId: admin.id,
    action: 'DOCTOR_VERIFIED',
    ipAddress: getRequestIpAddress(req),
    metadata: { doctorId: user._id.toString(), doctorEmail: user.email },
  });

  res.json({ message: 'Doctor verified', user: toSafeUser(user) });
});
