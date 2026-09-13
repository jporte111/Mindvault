import { Navigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { useTenantRole } from '@/hooks/useTenantRole';
import { useHashScroll } from '@/hooks/useHashScroll';
import { Loader2, Bot, MessageSquare, ArrowRight, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import AssistantToggles from '@/components/admin/AssistantToggles';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';

// Assistant — how the AI assistant answers, in business language: answer
// settings, a way to test an answer, and where employee feedback lands.
// Technical controls (engine selection, retrieval modes, rollout) stay on
// the platform admin's advanced settings page.
export default function AssistantSettings() {
  const { user } = useAuth();
  const { isClientAdmin, isLoading: roleLoading } = useTenantRole();
  useHashScroll();
  const system = useSystemConfig();
  const isSuperAdmin = user?.role === 'admin';

  if (roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!isClientAdmin && !isSuperAdmin) return <Navigate to="/" replace />;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 md:px-8 py-8 md:py-12 space-y-8">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
              <Bot className="w-6 h-6 text-primary" />
            </div>
            <h1 className="font-sora font-semibold text-2xl md:text-3xl text-foreground">
              Assistant
            </h1>
          </div>
          <p className="text-sm md:text-base text-muted-foreground mt-2 leading-relaxed">
            How your team&apos;s AI assistant answers, and what happens to the questions it
            can&apos;t.
          </p>
        </div>

        {/* Test an answer */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-6 space-y-4">
            <div>
              <p className="text-base font-semibold text-foreground">Test an answer</p>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                The best way to check the assistant: ask a real question you know the answer
                to, and open the source it cites.
              </p>
            </div>
            <Button asChild className="bg-primary hover:bg-primary/90 gap-1">
              <Link to="/chat">
                <MessageSquare className="w-4 h-4" />
                Ask a test question
                <ArrowRight className="w-4 h-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        {/* Answer settings — plain language, wired to real flags */}
        <AssistantToggles editable={isSuperAdmin} />

        {/* Where feedback and requests for help go */}
        <Card className="border-border">
          <CardHeader className="pb-4">
            <CardTitle className="text-base font-semibold">Feedback and requests for help</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            {system.knowledgeGapsEnabled ? (
              <p>
                Employees can flag when an answer didn&apos;t help, and topics that keep
                coming up are collected as knowledge gaps. Review them on the{' '}
                <Link to="/continuity" className="text-primary font-medium hover:underline">
                  Operational Continuity
                </Link>{' '}
                page when it&apos;s enabled for your company.
              </p>
            ) : (
              <p>
                Answer feedback is currently off — questions the knowledge base can&apos;t
                answer aren&apos;t being collected yet.
              </p>
            )}
            {system.clarificationsEnabled ? (
              <p>
                Employees can use <strong className="text-foreground">“I still need help”</strong>{' '}
                under an answer to open a request your team answers in a private thread —
                employees see their own requests under “My questions”.
              </p>
            ) : (
              <p>
                The “I still need help” option is currently off — employees can&apos;t open
                requests for human help from an answer yet.
              </p>
            )}
            {isSuperAdmin && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground/80 border-t border-border pt-3">
                <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span>
                  Technical controls — engine selection, retrieval modes, rollout
                  percentages, indexing diagnostics — live under Platform settings →
                  Advanced.
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}