import { Link } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const SEVERITY = {
  urgent: { label: 'Urgent', className: 'bg-destructive/15 text-destructive border-destructive/30' },
  needs_attention: { label: 'Needs attention', className: 'bg-primary/10 text-primary border-primary/30' },
  info: { label: 'Info', className: 'bg-muted text-muted-foreground border-border' },
};

export default function NotificationItem({ n, onMarkRead, onDismiss, busy }) {
  const sev = SEVERITY[n.severity] || SEVERITY.info;
  const resolved = !!n.resolved_at || n.status === 'resolved';
  const dismissed = n.status === 'dismissed';
  const closed = resolved || dismissed;
  return (
    <div className={cn('p-3 border-b border-border last:border-0', closed && 'opacity-60')}>
      <div className="flex items-center gap-2">
        {!closed && !n.read_at && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" aria-hidden="true" />}
        <Badge variant="outline" className={sev.className}>{sev.label}</Badge>
        {dismissed && <Badge variant="outline" className="bg-muted text-muted-foreground">Dismissed</Badge>}
        <span className="ml-auto text-xs text-muted-foreground flex-shrink-0">
          {n.triggered_at ? formatDistanceToNow(new Date(n.triggered_at), { addSuffix: true }) : ''}
        </span>
      </div>
      <p className="mt-2 text-sm font-medium text-foreground">{n.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{n.message}</p>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        {n.action_href && !resolved && (
          <Button asChild size="sm" variant="outline">
            <Link to={n.action_href}>{n.action_label || 'Open'}</Link>
          </Button>
        )}
        {!resolved && !n.read_at && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onMarkRead(n)}>Mark read</Button>
        )}
        {!closed && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDismiss(n)}>Dismiss</Button>
        )}
        {resolved && <span className="text-xs text-muted-foreground">Resolved</span>}
      </div>
    </div>
  );
}