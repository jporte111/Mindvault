import { Inbox } from 'lucide-react';
import NotificationItem from './NotificationItem';

export default function NotificationPanel({ notifications, loading, onMarkRead, onDismiss, busyId }) {
  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground text-center">Loading notifications…</div>;
  }
  if (!notifications.length) {
    return (
      <div className="p-6 flex flex-col items-center gap-2 text-center">
        <Inbox className="w-6 h-6 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">You're all caught up — no notifications.</p>
      </div>
    );
  }
  // Fetched newest-first; resolved episodes move to their own section below.
  const active = notifications.filter((n) => !n.resolved_at && n.status !== 'resolved');
  const resolved = notifications.filter((n) => !!n.resolved_at || n.status === 'resolved');
  return (
    <div className="max-h-[70vh] overflow-y-auto">
      {active.map((n) => (
        <NotificationItem key={n.id} n={n} onMarkRead={onMarkRead} onDismiss={onDismiss} busy={busyId === n.id} />
      ))}
      {resolved.length > 0 && (
        <>
          <p className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Resolved</p>
          {resolved.map((n) => (
            <NotificationItem key={n.id} n={n} onMarkRead={onMarkRead} onDismiss={onDismiss} busy={busyId === n.id} />
          ))}
        </>
      )}
    </div>
  );
}