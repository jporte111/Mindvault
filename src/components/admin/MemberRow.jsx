import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { UserMinus, UserPlus, Mail } from 'lucide-react';

// One tenant-member row: role select + revoke / reactivate. All actions run
// through the manageTenantMembers backend function — the UI never writes a
// TenantMembership row directly.
export default function MemberRow({ member, onAction, busy }) {
  const isInactive = member.status === 'inactive';
  const isPending = member.status === 'pending';
  const statusStyles = {
    active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent',
    pending: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-transparent',
    inactive: 'bg-muted text-muted-foreground border-transparent',
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 py-4 border-b border-border last:border-b-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">
          {member.display_name || member.email}
        </p>
        <p className="text-xs text-muted-foreground truncate">{member.email}</p>
      </div>

      <Badge variant="outline" className={`w-fit ${statusStyles[member.status] || ''}`}>
        {member.status}
      </Badge>

      <div className="flex items-center gap-2">
        <select
          value={member.app_role}
          disabled={busy || isInactive}
          onChange={(e) => onAction(member, 'update_role', { app_role: e.target.value })}
          className="h-11 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          aria-label={`Role for ${member.email}`}
        >
          <option value="client_user">Client User</option>
          <option value="client_admin">Client Admin</option>
        </select>

        {isPending ? (
          <Button
            variant="outline"
            size="sm"
            className="h-11 gap-1.5"
            disabled={busy}
            onClick={() => onAction(member, 'resend', {})}
          >
            <Mail className="w-4 h-4" /> Resend invite
          </Button>
        ) : null}

        {isInactive ? (
          <Button
            variant="outline"
            size="sm"
            className="h-11 gap-1.5"
            disabled={busy}
            onClick={() => onAction(member, 'reactivate', {})}
          >
            <UserPlus className="w-4 h-4" /> Restore
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-11 gap-1.5 text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => onAction(member, 'revoke', {})}
          >
            <UserMinus className="w-4 h-4" /> Revoke
          </Button>
        )}
      </div>
    </div>
  );
}