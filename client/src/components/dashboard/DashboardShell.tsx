import { Activity, Bell, LogOut, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { notificationService } from '../../services/notification.service';
import { useAuthStore } from '../../store/useAuthStore';
import type { Notification } from '../../types/notification';
import { Button } from '../ui/button';

interface DashboardMetric {
  label: string;
  value: string;
  tone: string;
}

interface DashboardShellProps {
  title: string;
  subtitle: string;
  metrics: DashboardMetric[];
  children: ReactNode;
}

export default function DashboardShell({ title, subtitle, metrics, children }: DashboardShellProps) {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isNotificationMenuOpen, setIsNotificationMenuOpen] = useState(false);

  useEffect(() => {
    if (!user) {
      return;
    }

    let isCurrent = true;
    void notificationService
      .getNotifications()
      .then(({ notifications: loadedNotifications, unreadCount: loadedUnreadCount }) => {
        if (isCurrent) {
          setNotifications(loadedNotifications);
          setUnreadCount(loadedUnreadCount);
        }
      })
      .catch(() => undefined);

    return () => {
      isCurrent = false;
    };
  }, [user]);

  const handleNotificationClick = async (notification: Notification) => {
    if (notification.read) {
      return;
    }

    try {
      const updatedNotification = await notificationService.markRead(notification.id);
      setNotifications((currentNotifications) =>
        currentNotifications.map((currentNotification) =>
          currentNotification.id === updatedNotification.id ? updatedNotification : currentNotification
        )
      );
      setUnreadCount((currentCount) => Math.max(0, currentCount - 1));
    } catch {
      // A failed read receipt should not prevent the recipient from seeing the message.
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await notificationService.markAllRead();
      setNotifications((currentNotifications) => currentNotifications.map((notification) => ({ ...notification, read: true })));
      setUnreadCount(0);
    } catch {
      // Leave the visible state unchanged when the server could not record the action.
    }
  };

  return (
    <section className="py-8">
      <div className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-md border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-xs font-semibold uppercase text-emerald-200">
            <ShieldCheck className="h-4 w-4" />
            {user?.role} workspace
          </div>
          <h1 className="text-3xl font-bold text-white md:text-4xl">{title}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400 md:text-base">{subtitle}</p>
        </div>

        <div className="flex max-w-full items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{user?.name}</p>
            <p className="truncate text-xs text-slate-400">{user?.email}</p>
          </div>
          <div className="relative">
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={() => setIsNotificationMenuOpen((isOpen) => !isOpen)}
              aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
              aria-expanded={isNotificationMenuOpen}
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 ? (
                <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-rose-500 px-1 text-center text-[10px] font-bold leading-4 text-white">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              ) : null}
            </Button>
            {isNotificationMenuOpen ? (
              <div className="absolute right-0 z-20 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-white/10 bg-slate-950 shadow-2xl shadow-black/40">
                <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                  <p className="text-sm font-semibold text-white">Notifications</p>
                  {unreadCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => void handleMarkAllRead()}
                      className="text-xs font-semibold text-emerald-200 transition-colors hover:text-emerald-100"
                    >
                      Mark all read
                    </button>
                  ) : null}
                </div>
                {notifications.length > 0 ? (
                  <div className="max-h-96 overflow-y-auto divide-y divide-white/10">
                    {notifications.map((notification) => {
                      const isEmergencyGrant = notification.eventName === 'emergency.granted';
                      return (
                        <button
                          key={notification.id}
                          type="button"
                          onClick={() => void handleNotificationClick(notification)}
                          className={`w-full px-4 py-3 text-left transition-colors hover:bg-white/[0.04] ${
                            notification.read ? 'bg-transparent' : isEmergencyGrant ? 'bg-rose-500/15' : 'bg-emerald-300/[0.06]'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <Bell className={`mt-0.5 h-4 w-4 shrink-0 ${isEmergencyGrant ? 'text-rose-300' : 'text-emerald-300'}`} />
                            <div className="min-w-0">
                              <p className={`text-sm leading-5 ${isEmergencyGrant ? 'font-semibold text-rose-100' : 'text-slate-100'}`}>
                                {notification.message}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                {new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(
                                  new Date(notification.createdAt)
                                )}
                              </p>
                            </div>
                            {!notification.read ? (
                              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${isEmergencyGrant ? 'bg-rose-400' : 'bg-emerald-300'}`} />
                            ) : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="px-4 py-8 text-center text-sm text-slate-400">You have no notifications yet.</p>
                )}
              </div>
            ) : null}
          </div>
          <Button type="button" variant="secondary" size="icon" onClick={logout} aria-label="Logout">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {metrics.map((metric) => (
          <div key={metric.label} className="min-w-0 rounded-lg border border-white/10 bg-slate-900/70 p-5">
            <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-md bg-white/5">
              <Activity className={`h-4 w-4 ${metric.tone}`} />
            </div>
            <p className="truncate text-2xl font-bold text-white">{metric.value}</p>
            <p className="mt-1 text-sm text-slate-400">{metric.label}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[1.4fr_0.8fr]">{children}</div>
    </section>
  );
}
