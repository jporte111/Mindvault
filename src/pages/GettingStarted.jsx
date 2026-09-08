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
          <h1 className="font-sora font-semibold text-2xl md:text-3xl text-foreground">
            Set up your MindVault
          </h1>
          <p className="text-sm md:text-base text-muted-foreground mt-2 leading-relaxed">
            We'll walk you through the essentials. You can come back to this checklist anytime —
            your progress is saved as you go.
          </p>
        </div>

        {!setupComplete && <NextActionCard item={nextItem} />}

        {/* Step 1 — company details (the Client Admin's own workspace) */}
        {isClientAdmin && tenant && (
          <div id="company-details" className="scroll-mt-6">
            <CompanyDetailsForm
              tenant={tenant}
              onSaved={() => markStepDone('company_details')}
            />
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