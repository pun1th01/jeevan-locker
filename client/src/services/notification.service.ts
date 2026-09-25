import { api } from '../lib/api';
import type { Notification } from '../types/notification';

interface NotificationListResponse {
  notifications: Notification[];
  unreadCount: number;
}

interface NotificationResponse {
  notification: Notification;
}

export const notificationService = {
  async getNotifications(): Promise<NotificationListResponse> {
    const { data } = await api.get<NotificationListResponse>('/notifications');
    return data;
  },

  async markRead(notificationId: string): Promise<Notification> {
    const { data } = await api.patch<NotificationResponse>(`/notifications/${notificationId}/read`);
    return data.notification;
  },

  async markAllRead(): Promise<void> {
    await api.patch('/notifications/read-all');
  },
};
