import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { useTenantRole } from '@/hooks/useTenantRole';
import { useHashScroll } from '@/hooks/useHashScroll';
import { Loader2, BookOpen, Info } from 'lucide-react';
import UploadTraining from '@/components/admin/UploadTraining';
import ClientsCard from '@/components/admin/ClientsCard';
import SourceStatusList from '@/components/admin/SourceStatusList';
import KnowledgeLifecyclePanel from '@/components/admin/KnowledgeLifecyclePanel';

// Knowledge — add sources, review what was extracted, decide who can use
// each one, and see a clear status for every source. Availability and
// verification are explained and kept distinct.
export default function KnowledgeAdmin() {
  const { user } = useAuth();
  const { isClientAdmin, isLoading: roleLoading } = useTenantRole();
  useHashScroll();

  if (roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!isClientAdmin && user?.role !== 'admin') return <Navigate to="/" replace />;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 md:px-8 py-8 md:py-12 space-y-8">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
              <BookOpen className="w-6 h-6 text-primary" />
            </div>
            <h1 className="font-sora font-semibold text-2xl md:text-3xl text-foreground">Knowledge</h1>
          </div>
          <p className="text-sm md:text-base text-muted-foreground mt-2 leading-relaxed">
            Add the documents your team relies on, decide who can use each one, and keep
            them current. The assistant only answers from what&apos;s made available here.
          </p>
        </div>

        {/* Availability vs verification, in plain language */}
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/50 border border-border rounded-xl px-4 py-3">
          <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            <strong className="text-foreground">Making a source available</strong> means the
            assistant can use it in answers. <strong className="text-foreground">Verifying</strong>{' '}
            it is how you confirm its content is accurate — a source can be available before
            it&apos;s verified, and verifying is always a deliberate human action.
          </span>
        </div>

        {/* Add knowledge */}
        <div id="add-knowledge" className="scroll-mt-6" data-tour="knowledge-management">
          <UploadTraining />
        </div>

        {/* Every source with its status and next action */}
        <SourceStatusList />

        {/* Client-specific knowledge scoping */}
        <ClientsCard />

        {/* Governed review / verify / versioning (renders nothing while the
            workflow is off) */}
        <KnowledgeLifecyclePanel />
      </div>
    </div>
  );
}