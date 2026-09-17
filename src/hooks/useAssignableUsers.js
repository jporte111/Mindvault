import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

// People options for owner / SME pickers. Platform admins can list app users
// directly; Client Admins cannot, so their options come from their own team's
// verified member list (resolved server-side by manageTenantMembers).
export function useAssignableUsers(isSuperAdmin) {
  const { data: platformUsers = null } = useQuery({
    queryKey: ['users'],
    queryFn: () => base44.entities.User.list().catch(() => []),
    enabled: !!isSuperAdmin,
  });
  const { data: tenantMembers = null } = useQuery({
    queryKey: ['tenant-members'],
    queryFn: async () => {
      const res = await base44.functions.invoke('manageTenantMembers', { action: 'list' });
      return res?.data?.members ?? [];
    },
    enabled: !isSuperAdmin,
  });
  if (isSuperAdmin) return platformUsers ?? [];
  return (tenantMembers ?? [])
    .filter((m) => m.user_id && m.status === 'active')
    .map((m) => ({ id: m.user_id, full_name: m.display_name || m.email }));
}