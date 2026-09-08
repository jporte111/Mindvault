import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

// Resolves the signed-in user's tenant application role from their OWN
// TenantMembership rows — RLS only ever returns the caller's own rows, and an
// active client_admin row is what unlocks the Team page for tenant admins.
export function useTenantRole() {
  const { data: membership, isLoading } = useQuery({
    queryKey: ['my-tenant-membership'],
    queryFn: async () => {
      try {
        const rows = await base44.entities.TenantMembership.filter({});
        return rows?.find((m) => m.status === 'active') || null;
      } catch {
        return null;
      }
    },
    staleTime: 60 * 1000,
  });

  return {
    membership,
    isClientAdmin:
      membership?.app_role === 'client_admin' && membership?.status === 'active',
    isLoading,
  };
}