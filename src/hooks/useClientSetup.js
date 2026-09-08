import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';
import { useAuth } from '@/lib/AuthContext';
import { useTenantRole } from '@/hooks/useTenantRole';
import {
  deriveClientSetupItems,
  clientSetupCompleteCount,
  clientSetupProgressPct,
  clientSetupRequiredComplete,
  CLIENT_SETUP_MANUAL_FLAGS,
} from '@/lib/clientSetup';

async function fetchMyTenant() {
  const rows = await base44.entities.Tenant.list('name');
  return rows?.[0] ?? null;
}

/**
 * The signed-in member's own workspace display name (empty string for
 * platform admins and anyone without a tenant membership).
 */
export function useTenantName() {
  const { membership } = useTenantRole();
  const { data: tenant } = useQuery({
    queryKey: ['client-setup-tenant'],
    enabled: !!membership,
    staleTime: 60 * 1000,
    queryFn: fetchMyTenant,
  });
  return membership ? tenant?.name ?? '' : '';
}

/**
 * The Client Admin guided-setup engine. Progress is derived live from the
 * tenant's own data (members, knowledge sources, processes) so it is
 * automatically resumable, plus the signed-in user's own saved setup flags
 * for the manual steps. markStepDone persists a manual step's completion to
 * the user's own profile.
 */
export function useClientSetup() {
  const { user, checkUserAuth } = useAuth();
  const { isClientAdmin, membership, isLoading: roleLoading } = useTenantRole();

  const dataEnabled = !!user && (user.role === 'admin' || isClientAdmin);

  const tenantQuery = useQuery({
    queryKey: ['client-setup-tenant'],
    enabled: dataEnabled && !!membership,
    staleTime: 60 * 1000,
    queryFn: fetchMyTenant,
  });
  const membersQuery = useQuery({
    queryKey: ['client-setup-members'],
    enabled: isClientAdmin,
    queryFn: async () => {
      const res = await base44.functions.invoke('manageTenantMembers', { action: 'list' });
      return res?.data?.members ?? null;
    },
  });
  const sourcesQuery = useQuery({
    queryKey: ['client-setup-sources'],
    enabled: dataEnabled,
    queryFn: async () => (await base44.entities.Training.list('-created_date')) ?? null,
  });
  const processesQuery = useQuery({
    queryKey: ['client-setup-processes'],
    enabled: dataEnabled,
    queryFn: async () => (await base44.entities.OperationalProcess.list()) ?? null,
  });

  const tenant = tenantQuery.data ?? null;
  const flags = user?.data || {};
  const manual = {
    company_details: flags[CLIENT_SETUP_MANUAL_FLAGS.company_details] === true,
    test_mindvault: flags[CLIENT_SETUP_MANUAL_FLAGS.test_mindvault] === true,
    review_permissions: flags[CLIENT_SETUP_MANUAL_FLAGS.review_permissions] === true,
  };

  const items = deriveClientSetupItems({
    tenant,
    members: membersQuery.data ?? null,
    sources: sourcesQuery.data ?? null,
    processes: processesQuery.data ?? null,
    manual,
  });

  const markStepDone = async (stepId) => {
    const flag = CLIENT_SETUP_MANUAL_FLAGS[stepId];
    if (!flag) return false;
    try {
      await base44.auth.updateMe({ [flag]: true });
      await checkUserAuth();
      return true;
    } catch {
      toast.error('Could not save — please try again.');
      return false;
    }
  };

  return {
    isClientAdmin,
    roleLoading,
    loading:
      roleLoading ||
      (dataEnabled && (sourcesQuery.isLoading || processesQuery.isLoading)) ||
      (isClientAdmin && (tenantQuery.isLoading || membersQuery.isLoading)),
    items,
    complete: clientSetupCompleteCount(items),
    progressPct: clientSetupProgressPct(items),
    setupComplete: clientSetupRequiredComplete(items),
    nextItem: items.find((i) => i.state !== 'Complete') ?? null,
    tenant,
    members: membersQuery.data ?? null,
    sources: sourcesQuery.data ?? null,
    processes: processesQuery.data ?? null,
    markStepDone,
  };
}