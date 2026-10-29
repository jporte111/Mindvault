import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/AuthContext';
import { useTenantRole } from '@/hooks/useTenantRole';
import { useHashScroll } from '@/hooks/useHashScroll';
import { Loader2, Users, ShieldCheck } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import CompanyDetailsForm from '@/components/onboarding/CompanyDetailsForm';
import TenantMembersManager from '@/components/admin/TenantMembersManager';
import TenantLogoMark from '@/components/common/TenantLogoMark';
import { getMyWorkspace } from '@/lib/scopedData';

// Company & Team — company details and branding, invitations, and member
// roles/permissions in one place. Company details are managed by the
// company's own admins; platform admins preview the member management.
export default function Company() {
  const { user } = useAuth();
  const { isClientAdmin, membership, isLoading: roleLoading } = useTenantRole();
  useHashScroll();

  const isSuperAdmin = user?.role === 'admin';

  if (roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!isClientAdmin && !isSuperAdmin) return <Navigate to="/" replace />;

  // The company's own Tenant record is only resolvable for its members —
  // a platform admin has no membership, so no tenant to edit.
  const canEditDetails = isClientAdmin && !!membership;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 md:px-8 py-8 md:py-12 space-y-8">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
              <Users className="w-6 h-6 text-primary" />
            </div>
            <h1 className="font-sora font-semibold text-2xl md:text-3xl text-foreground">
              Company &amp; Team
            </h1>
          </div>
          <p className="text-sm md:text-base text-muted-foreground mt-2 leading-relaxed">
            How your company appears in MindVault, and who on your team can access it.
          </p>
        </div>

        {/* Company details + branding (the company's own admins) */}
        <div id="company-details" className="scroll-mt-6">
          {canEditDetails ? (
            <CompanyDetailsWrapper />
          ) : (
            <Card className="border-border">
              <CardContent className="p-5">
                <p className="text-sm text-muted-foreground">
                  Company details and branding are managed by this company&apos;s own
                  admins. As a platform admin you&apos;re previewing member management only.
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Team — invitations, roles, revoke/reactivate */}
        <TenantMembersManager />

        {/* Roles in plain language */}
        <Card className="border-border">
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-primary" />
              <p className="text-sm font-semibold text-foreground">How roles work</p>
            </div>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">Admin</span> — manages the
                company&apos;s knowledge, processes, and team: uploads sources, sets who can
                use them, invites members, and changes roles.
              </p>
              <p>
                <span className="font-medium text-foreground">Member</span> — asks the
                assistant questions and browses knowledge. They can&apos;t change any
                company settings.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// Loads the company's own Tenant record (never another workspace's) and
// renders the shared details form against it.
function CompanyDetailsWrapper() {
  const { membership } = useTenantRole();
  const { data: tenant } = useQuery({
    queryKey: ['client-setup-tenant'],
    enabled: !!membership,
    staleTime: 60 * 1000,
    queryFn: async () => {
      return getMyWorkspace();
    },
  });

  if (!tenant) {
    return (
      <Card className="border-border">
        <CardContent className="p-5">
          <p className="text-sm text-muted-foreground">Loading company details…</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3 mb-[-16px] pl-1">
        <TenantLogoMark
          name={tenant.name}
          logoUrl={tenant.logo_url}
          brandColor={tenant.brand_color}
          className="w-5 h-5 rounded"
        />
        <p className="text-xs text-muted-foreground">
          Currently: {tenant.name}
        </p>
      </div>
      <CompanyDetailsForm tenant={tenant} onSaved={() => {}} />
    </>
  );
}