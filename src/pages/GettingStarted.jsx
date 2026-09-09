import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { useTenantRole } from '@/hooks/useTenantRole';
import { useClientSetup } from '@/hooks/useClientSetup';
import { useHashScroll } from '@/hooks/useHashScroll';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CheckCircle2, Loader2 } from 'lucide-react';
import ClientSetupChecklist from '@/components/onboarding/ClientSetupChecklist';
import CompanyDetailsForm from '@/components/onboarding/CompanyDetailsForm';
import NextActionCard from '@/components/onboarding/NextActionCard';
import TenantLogoMark from '@/components/common/TenantLogoMark';

// Getting Started — the Client Admin's guided setup experience. Every step
// explains what to do and why, tracks progress live from the tenant's own
// data, and is fully resumable — completed steps are remembered
// automatically. Platform admins can view it to preview the client
// experience.
export default function GettingStarted() {
  const { user } = useAuth();
  const { isClientAdmin, isLoading: roleLoading } = useTenantRole();
  const { items, nextItem, setupComplete, loading, tenant, markStepDone } = useClientSetup();
  // Checklist actions link to /setup#company-details — scroll to it.
  useHashScroll();
  const isSuperAdmin = user?.role === 'admin';
  const [editingDetails, setEditingDetails] = useState(false);
  const companyDetailsDone =
    items.find((i) => i.id === 'company_details')?.state === 'Complete';

  if (roleLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!isClientAdmin && !isSuperAdmin) return <Navigate to="/" replace />;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8 md:py-12 space-y-8">
        {/* Welcome — what setup involves */}
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
              Set up {tenant?.name ? `${tenant.name}’s` : 'your'} MindVault
            </h1>
          </div>
          <p className="text-sm md:text-base text-muted-foreground mt-2 leading-relaxed">
            We'll walk you through the essentials. You can come back to this checklist anytime —
            your progress is saved as you go.
          </p>
        </div>

        {!setupComplete && <NextActionCard item={nextItem} />}

        {/* Step 1 — company details (the Client Admin's own workspace).
            Once saved it collapses to a completed summary so the page
            visibly moves on to the next step. */}
        {isClientAdmin && tenant && (!companyDetailsDone || editingDetails) && (
          <div id="company-details" className="scroll-mt-6">
            <CompanyDetailsForm
              tenant={tenant}
              onSaved={() => {
                setEditingDetails(false);
                return markStepDone('company_details');
              }}
            />
          </div>
        )}
        {isClientAdmin && tenant && companyDetailsDone && !editingDetails && (
          <div id="company-details" className="scroll-mt-6">
            <Card className="border-emerald-500/30 bg-emerald-500/5">
              <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
                <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-foreground">Company details saved</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Your company name and branding are set. You can change them anytime.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 text-xs"
                  onClick={() => setEditingDetails(true)}
                >
                  Edit
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {/* The guided checklist — progress bar, why/what/done, actions */}
        <ClientSetupChecklist items={items} onMarkDone={markStepDone} />

        {/* Completion — what's done and what's worth doing next */}
        {setupComplete && (
          <Card className="border-emerald-500/30 bg-emerald-500/5">
            <CardContent className="p-6 space-y-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">You're all set</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    The core of MindVault is ready for your team. Here are a few things worth doing
                    whenever you have time:
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 sm:pl-8">
                <Button asChild variant="outline" size="sm" className="h-9 text-xs">
                  <Link to="/manage#manage-knowledge">Add more knowledge</Link>
                </Button>
                <Button asChild variant="outline" size="sm" className="h-9 text-xs">
                  <Link to="/team">Invite more teammates</Link>
                </Button>
                <Button asChild variant="outline" size="sm" className="h-9 text-xs">
                  <Link to="/chat">Ask another question</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}