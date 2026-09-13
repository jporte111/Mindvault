import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  BookOpen, MessageSquare, Users, Workflow, ArrowRight, MessageCircleQuestion, Loader2,
} from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { useTenantRole } from '@/hooks/useTenantRole';
import { useClientSetup } from '@/hooks/useClientSetup';
import ClientSetupChecklist from '@/components/onboarding/ClientSetupChecklist';
import NextActionCard from '@/components/onboarding/NextActionCard';
import OverviewAttention from '@/components/admin/OverviewAttention';
import TenantLogoMark from '@/components/common/TenantLogoMark';
import { OPEN_HELP_EVENT } from '@/components/onboarding/AdminHelpAssistant';
import {
  deriveClientSetupItems,
  clientSetupCompleteCount,
  clientSetupProgressPct,
  clientSetupRequiredComplete,
} from '@/lib/clientSetup';

const WORKSPACE_KEY = 'mv_preview_workspace';

// Overview — the company admin's single landing view: setup progress and
// the next recommended step while setting up, then actionable maintenance
// items once running. Platform admins get an explicit workspace selector
// and see each company's derived state in preview.
export default function AdminOverview() {
  const { user } = useAuth();
  const { isClientAdmin, isLoading: roleLoading } = useTenantRole();
  const isSuperAdmin = user?.role === 'admin';

  // --- Client admin: everything derives from the workspace's own data ---
  const setup = useClientSetup();

  // --- Platform admin: pick a workspace to preview ---
  const [workspaceId, setWorkspaceId] = useState(
    () => (typeof window !== 'undefined' ? window.localStorage.getItem(WORKSPACE_KEY) || '' : ''),
  );
  const { data: tenants = [] } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => base44.entities.Tenant.list('name'),
    enabled: isSuperAdmin && !isClientAdmin,
  });
  useEffect(() => {
    if (isSuperAdmin && !isClientAdmin && !workspaceId && tenants.length) {
      setWorkspaceId(tenants[0].id);
    }
  }, [isSuperAdmin, isClientAdmin, tenants, workspaceId]);
  const selectWorkspace = (id) => {
    setWorkspaceId(id);
    window.localStorage.setItem(WORKSPACE_KEY, id);
  };

  const { data: previewSources = [] } = useQuery({
    queryKey: ['all-trainings'],
    queryFn: () => base44.entities.Training.list('-created_date'),
    enabled: isSuperAdmin && !isClientAdmin && !!workspaceId,
  });
  const { data: previewProcesses = [] } = useQuery({
    queryKey: ['client-setup-processes'],
    queryFn: () => base44.entities.OperationalProcess.list(),
    enabled: isSuperAdmin && !isClientAdmin && !!workspaceId,
  });
  const { data: previewMembers = null } = useQuery({
    queryKey: ['workspace-members', workspaceId],
    queryFn: () => base44.entities.TenantMembership.filter({ tenant_id: workspaceId }),
    enabled: isSuperAdmin && !isClientAdmin && !!workspaceId,
  });

  const previewTenant = tenants.find((t) => t.id === workspaceId) || null;
  const previewItems = isSuperAdmin && !isClientAdmin
    ? deriveClientSetupItems({
        tenant: previewTenant,
        members: previewMembers,
        sources: previewSources.filter((s) => s.tenant_id === workspaceId),
        processes: previewProcesses.filter((p) => p.tenant_id === workspaceId),
        manual: {},
      })
    : [];

  // Converge the two paths into one render model.
  const data = isClientAdmin
    ? {
        tenant: setup.tenant,
        items: setup.items,
        nextItem: setup.nextItem,
        setupComplete: setup.setupComplete,
        sources: setup.sources || [],
        processes: setup.processes || [],
        members: setup.members || [],
        loading: setup.loading,
        markStepDone: setup.markStepDone,
      }
    : {
        tenant: previewTenant,
        items: previewItems,
        nextItem: previewItems.find((i) => i.state !== 'Complete') ?? null,
        setupComplete: clientSetupRequiredComplete(previewItems),
        sources: previewSources.filter((s) => s.tenant_id === workspaceId),
        processes: previewProcesses.filter((p) => p.tenant_id === workspaceId),
        members: previewMembers || null,
        loading: roleLoading || (!!workspaceId && (previewMembers === null || previewSources === null)),
        markStepDone: async () => false,
      };

  const openHelp = () => window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT));
  const { tenant, items, nextItem, setupComplete, sources, processes, members } = data;

  const showContinuitySetup = setupComplete &&
    processes.filter((p) => p && p.status === 'active' && (!p.process_owner || !p.subject_matter_expert || !p.criticality)).length > 0;

  if (roleLoading || data.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 md:px-8 py-8 md:py-12 space-y-8">
        {/* Header */}
        <div>
          <div className="flex items-center gap-3">
            {tenant && (
              <TenantLogoMark
                name={tenant.name}
                logoUrl={tenant.logo_url}
                brandColor={tenant.brand_color}
                className="w-8 h-8 rounded-lg"
              />
            )}
            <h1 className="font-sora font-semibold text-2xl md:text-3xl text-foreground">
              {setupComplete
                ? tenant?.name
                  ? `Welcome back to ${tenant.name}’s MindVault`
                  : 'Welcome back'
                : tenant?.name
                  ? `Set up ${tenant.name}’s MindVault`
                  : 'Set up your MindVault'}
            </h1>
          </div>
          <p className="text-sm md:text-base text-muted-foreground mt-2 leading-relaxed">
            {setupComplete
              ? 'Everything is ready — your team can ask questions and get answers with sources.'
              : "We'll walk you through the essentials. Your progress is saved as you go, and you can skip any step."}
          </p>
        </div>

        {/* Platform admin workspace selector */}
        {isSuperAdmin && !isClientAdmin && (
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-5 space-y-2">
              <p className="text-sm font-semibold text-foreground">
                Viewing a company&apos;s administration
              </p>
              <select
                value={workspaceId}
                onChange={(e) => selectWorkspace(e.target.value)}
                className="h-11 w-full sm:w-72 rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                aria-label="Workspace to view"
              >
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                You&apos;re signed in as a platform admin — this preview shows each
                company&apos;s own setup state. Company changes are made by that company&apos;s admins.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Guided setup — while incomplete: one next step + the checklist.
            The checklist is the guided flow: every step links to the same
            screen used for ongoing management. */}
        {!setupComplete && (
          <>
            <NextActionCard item={nextItem} />
            <ClientSetupChecklist items={items} onMarkDone={data.markStepDone} />
          </>
        )}

        {/* Maintenance — actionable items with direct buttons */}
        <OverviewAttention
          sources={sources}
          processes={processes}
          members={members || []}
          setupComplete={setupComplete}
        />

        {/* Follow-up flow: continuity tracking (owners, experts, backups,
            review schedules) once the core setup is done. */}
        {setupComplete && showContinuitySetup && (
          <Card className="border-border">
            <CardContent className="p-6 space-y-4">
              <div>
                <p className="text-sm font-semibold text-foreground">Set up continuity tracking</p>
                <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                  Give each process an owner, a subject-matter expert (and a backup where one
                  person is the only one who can run it), a criticality, and a review schedule.
                  That&apos;s what lets MindVault show what&apos;s at risk when knowledge goes stale.
                </p>
              </div>
              <Button asChild className="bg-primary hover:bg-primary/90 gap-1">
                <Link to="/processes">
                  Review processes
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Day-to-day quick access once setup is complete */}
        {setupComplete && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { to: '/knowledge', icon: BookOpen, label: 'Knowledge', copy: 'Add sources and manage availability' },
              { to: '/chat', icon: MessageSquare, label: 'AI Assistant', copy: 'Ask a question, see the source' },
              { to: '/processes', icon: Workflow, label: 'Processes', copy: 'Keep how you work described and current' },
              { to: '/company', icon: Users, label: 'Company & Team', copy: 'Invite people and manage their roles' },
            ].map(({ to, icon: Icon, label, copy }) => (
              <Link key={to} to={to}>
                <Card className="p-5 h-full hover:shadow-md hover:border-primary/40 transition-all">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
                    <Icon className="w-5 h-5 text-primary" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{copy}</p>
                </Card>
              </Link>
            ))}
          </div>
        )}

        {/* Help — one click away, without leaving the page */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
            <MessageCircleQuestion className="w-5 h-5 text-primary flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-foreground">Not sure what to do next?</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Ask MindVault — answers are based on your setup progress and the page you&apos;re on.
              </p>
            </div>
            <Button
              onClick={openHelp}
              size="sm"
              className="bg-primary hover:bg-primary/90 flex-shrink-0 gap-1"
            >
              Ask MindVault
              <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}