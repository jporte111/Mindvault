import { Link, useOutletContext } from 'react-router-dom';
import { BookOpen, MessageSquare, ArrowRight, Sparkles, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import PullToRefresh from '@/components/layout/PullToRefresh';
import { useTenantRole } from '@/hooks/useTenantRole';
import ClientHome from '@/components/home/ClientHome';
import { Loader2 } from 'lucide-react';

export default function Home() {
  const { user } = useOutletContext() || {};
  const queryClient = useQueryClient();
  const { isClientAdmin, isLoading: roleLoading } = useTenantRole();

  const { data: trainings = [] } = useQuery({
    queryKey: ['trainings-count'],
    queryFn: () => base44.entities.Training.list(),
  });

  const readyCount = trainings.filter(t => t.status === 'ready').length;
  const categories = [...new Set(trainings.map(t => t.category).filter(Boolean))];

  // Client Admins get the setup command center (new admins) or a calm
  // operational dashboard (setup complete) instead of the marketing hero.
  if (roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }
  if (isClientAdmin) return <ClientHome />;

  return (
    <div className="min-h-screen bg-background">
      <PullToRefresh onRefresh={() => queryClient.invalidateQueries({ queryKey: ['trainings-count'] })}>
      {/* Hero */}
      <div className="relative overflow-hidden bg-gradient-to-br from-sidebar via-sidebar to-primary/20 px-8 py-20">
        <div className="absolute inset-0 opacity-5">
          <div className="absolute top-10 left-10 w-72 h-72 bg-primary rounded-full blur-3xl" />
          <div className="absolute bottom-10 right-10 w-96 h-96 bg-primary rounded-full blur-3xl" />
        </div>
        <div className="relative max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/20 border border-primary/30 text-primary text-xs font-medium mb-6">
            <Sparkles className="w-3 h-3" />
            AI-Powered Knowledge Base
          </div>
          <h1 className="font-sora text-4xl md:text-5xl font-bold text-white leading-tight mb-4">
            Everything you need to<br />
            <span className="text-primary">learn & grow</span>
          </h1>
          <p className="text-white/60 text-lg max-w-xl mb-8 leading-relaxed">
            All of your company's operational knowledge — SOPs, processes, policies, training, and recordings — in one place.
            Ask the AI assistant any question and get instant answers grounded in your team's knowledge.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg" className="bg-primary hover:bg-primary/90 shadow-lg shadow-primary/30 font-medium">
              <Link to="/library">
                <BookOpen className="w-4 h-4 mr-2" />
                Browse Library
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="border-white/20 text-white hover:bg-white/10 font-medium">
              <Link to="/chat">
                <MessageSquare className="w-4 h-4 mr-2" />
                Ask AI Assistant
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="px-8 py-8 border-b border-border bg-card">
        <div className="max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-3 gap-6">
          <div className="text-center">
            <p className="text-3xl font-sora font-bold text-primary">{readyCount}</p>
            <p className="text-muted-foreground text-sm mt-1">Knowledge Sources</p>
          </div>
          <div className="text-center">
            <p className="text-3xl font-sora font-bold text-primary">{categories.length}</p>
            <p className="text-muted-foreground text-sm mt-1">Topics Covered</p>
          </div>
          <div className="text-center col-span-2 md:col-span-1">
            <p className="text-3xl font-sora font-bold text-primary">∞</p>
            <p className="text-muted-foreground text-sm mt-1">Questions Answered</p>
          </div>
        </div>
      </div>

      {/* Feature Cards */}
      <div className="px-8 py-12 max-w-5xl mx-auto">
        <h2 className="font-sora text-xl font-semibold text-foreground mb-6">Get Started</h2>
        <div className="grid md:grid-cols-2 gap-5">
          <Link to="/library">
            <Card className="p-6 group hover:shadow-xl hover:-translate-y-1 transition-all duration-300 cursor-pointer border-border bg-card overflow-hidden relative">
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full -translate-y-8 translate-x-8" />
              <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
                <BookOpen className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-sora font-semibold text-foreground text-lg mb-2 group-hover:text-primary transition-colors">Knowledge Library</h3>
              <p className="text-muted-foreground text-sm leading-relaxed mb-4">
                Browse every knowledge source by category. View summaries, procedures, decision rules, and open the original.
              </p>
              <div className="flex items-center gap-1 text-primary text-sm font-medium">
                Explore <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </div>
            </Card>
          </Link>

          <Link to="/chat">
            <Card className="p-6 group hover:shadow-xl hover:-translate-y-1 transition-all duration-300 cursor-pointer border-border bg-card overflow-hidden relative">
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full -translate-y-8 translate-x-8" />
              <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
                <Sparkles className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-sora font-semibold text-foreground text-lg mb-2 group-hover:text-primary transition-colors">AI Assistant</h3>
              <p className="text-muted-foreground text-sm leading-relaxed mb-4">
                Ask any question in plain English. The AI searches your approved knowledge and gives you a precise answer with references.
              </p>
              <div className="flex items-center gap-1 text-primary text-sm font-medium">
                Ask a question <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </div>
            </Card>
          </Link>
        </div>
      </div>
      </PullToRefresh>
    </div>
  );
}