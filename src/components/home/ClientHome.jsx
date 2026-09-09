import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  BookOpen, MessageSquare, Users, Workflow, ArrowRight, MessageCircleQuestion, Loader2,
} from 'lucide-react';
import { useClientSetup } from '@/hooks/useClientSetup';
import { OPEN_HELP_EVENT } from '@/components/onboarding/AdminHelpAssistant';
import ClientSetupChecklist from '@/components/onboarding/ClientSetupChecklist';
import NextActionCard from '@/components/onboarding/NextActionCard';
import TenantLogoMark from '@/components/common/TenantLogoMark';

// Home for Client Admins — a setup command center while setup is incomplete,
// then a calm operational dashboard once everything is ready.
export default function ClientHome() {
  const {
    items, progressPct, nextItem, setupComplete, loading, sources, members, tenant, markStepDone,
  } = useClientSetup();

  const openHelp = () => window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT));

  const recent = (sources || []).slice(0, 3);
  const activeMembers = (members || []).filter((m) => m.status === 'active').length;
  const pendingMembers = (members || []).filter((m) => m.status === 'pending').length;

  if (loading) {
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
                : 'Set up your MindVault'}
            </h1>
          </div>
          <p className="text-sm md:text-base text-muted-foreground mt-2 leading-relaxed">
            {setupComplete
              ? 'Everything is ready — your team can ask questions and get answers with sources.'
              : "We'll walk you through the essentials. You can come back to this checklist anytime."}
          </p>
        </div>

        {setupComplete ? (
          /* Operational dashboard — quick access to the day-to-day */
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { to: '/library', icon: BookOpen, label: 'Knowledge', copy: 'Browse and add what your team knows' },
              { to: '/chat', icon: MessageSquare, label: 'AI Assistant', copy: 'Ask a question, see the source' },
              { to: '/processes', icon: Workflow, label: 'Processes', copy: 'Keep how you work described and current' },
              { to: '/team', icon: Users, label: 'Team', copy: 'Invite people and manage their roles' },
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
        ) : (
          /* Setup mode — one obvious next action plus the full guided checklist */
          <>
            <NextActionCard item={nextItem} />
            <ClientSetupChecklist items={items} onMarkDone={markStepDone} />
          </>
        )}

        {/* Status strip — recent knowledge + team */}
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold text-foreground">Recent knowledge</p>
                <Link to="/library" className="text-xs text-primary font-medium">
                  View all
                </Link>
              </div>
              {recent.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing added yet — your uploads will appear here.
                </p>
              ) : (
                recent.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 py-2 border-t border-border">
                    <BookOpen className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="text-sm text-foreground truncate">{s.title}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold text-foreground">Your team</p>
                <Link to="/team" className="text-xs text-primary font-medium">
                  Manage
                </Link>
              </div>
              <p className="text-xs text-muted-foreground">
                {members == null
                  ? 'Team information is still loading.'
                  : activeMembers === 0
                    ? 'No active members yet.'
                    : `${activeMembers} active member${activeMembers === 1 ? '' : 's'}${pendingMembers ? ` · ${pendingMembers} pending invitation${pendingMembers === 1 ? '' : 's'}` : ''}.`}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Help — always one click away, without leaving the page */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
            <MessageCircleQuestion className="w-5 h-5 text-primary flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-foreground">Not sure what to do next?</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Ask MindVault — answers are based on your setup progress and the page you're on.
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