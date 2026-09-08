import { Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { useTenantRole } from '@/hooks/useTenantRole';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, MessageSquare, Sparkles } from 'lucide-react';
import ClientSetupChecklist from '@/components/onboarding/ClientSetupChecklist';
import { deriveClientSetupItems } from '@/lib/clientSetup';

// Getting Started — the Client Admin's self-serve onboarding page. Explains
// what MindVault asks of a new team, tracks setup progress from the tenant's
// own data, and links each step to where it happens. Platform admins can
// view it to preview the client experience.
export default function GettingStarted() {
  const { user } = useAuth();
  const { isClientAdmin, isLoading: roleLoading } = useTenantRole();
  const isSuperAdmin = user?.role === 'admin';

  // Client Admins see their own tenant's member list (server-verified).
  const { data: members } = useQuery({
    queryKey: ['tenant-members', 'setup'],
    enabled: isClientAdmin,
    queryFn: async () => {
      const res = await base44.functions.invoke('manageTenantMembers', { action: 'list' });
      return res?.data?.members ?? null;
    },
  });

  // RLS already scopes both reads to the caller's own tenant.
  const { data: sources, isLoading: sourcesLoading } = useQuery({
    queryKey: ['client-setup-sources'],
    queryFn: async () => (await base44.entities.Training.list('-created_date')) ?? [],
  });
  const { data: processes, isLoading: processesLoading } = useQuery({
    queryKey: ['client-setup-processes'],
    queryFn: async () => (await base44.entities.OperationalProcess.list()) ?? [],
  });

  if (roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!isClientAdmin && !isSuperAdmin) return <Navigate to="/" replace />;

  const loading =
    sourcesLoading || processesLoading || (isClientAdmin && members === undefined);

  const items = deriveClientSetupItems({
    members: isClientAdmin ? members ?? null : null,
    sources: sources ?? null,
    processes: processes ?? null,
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8 md:py-12 space-y-6">
        {/* Welcome — what MindVault is and what setup involves */}
        <div>
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <h1 className="font-sora font-semibold text-2xl md:text-3xl text-foreground">
            Welcome to MindVault
          </h1>
          <p className="text-sm md:text-base text-muted-foreground mt-2 leading-relaxed">
            MindVault turns your organization's documents, recordings, and process notes into an AI
            assistant that answers your team's questions — showing the sources behind every answer.
            Getting started is four short steps, and this page tracks your progress automatically.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ClientSetupChecklist items={items} />
        )}

        {/* First-question CTA — the whole point of setup */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <MessageSquare className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-foreground">Ask your first question</p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                Once your knowledge is added and searchable, open the AI Assistant and ask something
                real — you'll see exactly which sources it used.
              </p>
            </div>
            <Button asChild className="bg-primary hover:bg-primary/90 flex-shrink-0">
              <Link to="/chat">Open the AI Assistant</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}