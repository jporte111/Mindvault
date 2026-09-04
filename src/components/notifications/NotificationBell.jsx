import { useCallback, useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useToast } from '@/components/ui/use-toast';
import { dismissNotification, fetchMyNotifications, markNotificationRead } from '@/lib/notifications';
import NotificationPanel from './NotificationPanel';

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setNotifications(await fetchMyNotifications());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const unread = notifications.filter((n) => n.status === 'open' && !n.read_at).length;

  const act = async (n, fn, patch) => {
    setBusyId(n.id);
    try {
      await fn(n.id);
      setNotifications((rows) => rows.map((r) => (r.id === n.id ? { ...r, ...patch } : r)));
    } catch (e) {
      toast({ title: 'Could not update the notification', description: e?.message, variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) load(); }}>
      <PopoverTrigger asChild>
        <button
          className="relative flex items-center justify-center w-11 h-11 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        >
          <Bell className="w-5 h-5" />
          {unread > 0 && (
            <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold flex items-center justify-center">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 md:w-96 p-0">
        <p className="px-3 py-2 text-sm font-semibold border-b border-border">Notifications</p>
        <NotificationPanel
          notifications={notifications}
          loading={loading}
          busyId={busyId}
          onMarkRead={(n) => act(n, markNotificationRead, { read_at: new Date().toISOString() })}
          onDismiss={(n) => act(n, dismissNotification, { status: 'dismissed' })}
        />
      </PopoverContent>
    </Popover>
  );
}