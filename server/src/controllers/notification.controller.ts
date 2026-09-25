import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { Notification, type INotification } from '../models/Notification';
import type { AuthenticatedRequest } from '../types/auth.types';
import { asyncHandler } from '../utils/asyncHandler.util';

const getIdParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] ?? '' : value ?? '');

const serializeNotification = (notification: INotification) => ({
  id: notification._id.toString(),
  actorName: notification.actorName,
  eventName: notification.eventName,
  message: notification.message,
  documentId: notification.documentId?.toString() ?? null,
  read: notification.read,
  createdAt: notification.createdAt.toISOString(),
});

export const listNotifications: RequestHandler = asyncHandler(async (req, res) => {
  const user = (req as AuthenticatedRequest).user;

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const filter = { recipientUserId: user.id };
  const [notifications, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }),
    Notification.countDocuments({ ...filter, read: false }),
  ]);

  res.json({ notifications: notifications.map(serializeNotification), unreadCount });
});

export const markNotificationRead: RequestHandler = asyncHandler(async (req, res) => {
  const user = (req as AuthenticatedRequest).user;

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const notificationId = getIdParam(req.params.id);
  if (!Types.ObjectId.isValid(notificationId)) {
    res.status(400).json({ message: 'A valid notification ID is required' });
    return;
  }

  const notification = await Notification.findOneAndUpdate(
    { _id: notificationId, recipientUserId: user.id },
    { $set: { read: true } },
    { new: true }
  );

  if (!notification) {
    res.status(404).json({ message: 'Notification not found' });
    return;
  }

  res.json({ notification: serializeNotification(notification) });
});

export const markAllNotificationsRead: RequestHandler = asyncHandler(async (req, res) => {
  const user = (req as AuthenticatedRequest).user;

  if (!user) {
    res.status(401).json({ message: 'Authentication is required' });
    return;
  }

  const result = await Notification.updateMany({ recipientUserId: user.id, read: false }, { $set: { read: true } });
  res.json({ modifiedCount: result.modifiedCount });
});
