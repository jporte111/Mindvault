import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, UserPlus, Mail, ShieldCheck, Clock } from 'lucide-react';
import { toast } from 'sonner';
import MemberRow from './MemberRow';

// Tenant team management: invite members, change roles, revoke / restore
// access. Every action goes through the manageTenantMembers backend function,
// which verifies the caller's tenant-admin scope server-side — the client is
// never trusted with tenant ids or membership writes.
export default function TenantMembersManager() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [appRole, setAppRole] = useState('client_user');
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'admin';
  const [tenantId, setTenantId] = useState('');

  // A platform Super Admin has no tenant membership — they must explicitly
  // target a tenant. Client Admins are scoped to their own tenant server-side.
  const { data: tenants = [] } = useQuery({
    queryKey: ['tenants'],
    queryFn: async () => (await base44.entities.Tenant.list('name')) ?? [],
    enabled: isSuperAdmin,
  });

  useEffect(() => {
    if (isSuperAdmin && !tenantId && tenants.length) setTenantId(tenants[0].id);
  }, [isSuperAdmin, tenants, tenantId]);

  const { data: members = [], isLoading, error } = useQuery({
    queryKey: ['tenant-members', isSuperAdmin ? tenantId : 'own'],
    enabled: !isSuperAdmin || !!tenantId,
    queryFn: async () => {
      const res = await base44.functions.invoke('manageTenantMembers', {
        action: 'list',
        ...(isSuperAdmin && tenantId ? { tenant_id: tenantId } : {}),
      });
      return res?.data?.members ?? [];
    },
  });

  const callApi = async (payload) => {
    try {
      const res = await base44.functions.invoke('manageTenantMembers', {
        ...payload,
        ...(isSuperAdmin && tenantId ? { tenant_id: tenantId } : {}),
      });
      const message = res?.data?.error;
      if (message) throw new Error(message);
      return true;
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || 'Something went wrong');
      return false;
    }
  };

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['tenant-members'] });

  const handleInvite = async () => {
    const trimmed = email.trim();
    if (!trimmed) { toast.error('Enter an email address'); return; }
    setInviting(true);
    const ok = await callApi({ action: 'invite', email: trimmed, app_role: appRole });
    if (ok) { setEmail(''); refresh(); }
    setInviting(false);
  };

  const handleRowAction = async (member, action, extra) => {
    setBusyId(member.id);
    const ok = await callApi({ action, id: member.id, ...extra });
    if (ok) refresh();
    setBusyId(null);
  };

  const activeCount = members.filter((m) => m.status === 'active').length;
  const pendingCount = members.filter((m) => m.status === 'pending').length;

  return (
    <div className="space-y-6">
      {isSuperAdmin && (
        <Card className="border-border">
          <CardHeader className="pb-4">
            <CardTitle className="text-base font-semibold">Tenant</CardTitle>
          </CardHeader>
          <CardContent>
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Tenant to manage"
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground/70 mt-1.5">
              You're a platform admin — choose which tenant's team you're managing.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Invite */}
      <Card className="border-border">
        <CardHeader className="pb-4">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-primary" />
            Invite a team member
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="bg-background flex-1"
              onKeyDown={(e) => { if (e.key === 'Enter') handleInvite(); }}
            />
            <select
              value={appRole}
              onChange={(e) => setAppRole(e.target.value)}
              className="h-11 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Role for the invited member"
            >
              <option value="client_user">Client User</option>
              <option value="client_admin">Client Admin</option>
            </select>
            <Button
              onClick={handleInvite}
              disabled={inviting}
              className="bg-primary hover:bg-primary/90 gap-2 h-11"
            >
              {inviting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
              Send invite
            </Button>
          </div>
          <p className="text-xs text-muted-foreground/70">
            They'll get an email invitation and join your team automatically when they sign in.
            A Client Admin can manage the team and knowledge; a Client User can search and ask questions.
          </p>
        </CardContent>
      </Card>

      {/* Members */}
      <Card className="border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" />
            Team members
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {activeCount} active{pendingCount > 0 ? ` · ${pendingCount} pending invitation${pendingCount === 1 ? '' : 's'}` : ''}
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : error ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {error?.response?.data?.error || error?.message || 'Could not load the team.'}
            </p>
          ) : members.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Invite your first team member above.
            </p>
          ) : members.length === 1 && members[0].user_id === user.id ? (
            <div className="py-6 text-center">
              <p className="text-sm font-medium text-foreground">You're the only team member</p>
              <p className="text-sm text-muted-foreground mt-1">
                Invite the people who should be able to use or manage your MindVault.
              </p>
            </div>
          ) : (
            <div>
              {members.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  busy={busyId === m.id}
                  onAction={handleRowAction}
                />
              ))}
              {pendingCount > 0 && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground/70 mt-4">
                  <Clock className="w-3.5 h-3.5" />
                  Pending members activate automatically when they accept and sign in.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}