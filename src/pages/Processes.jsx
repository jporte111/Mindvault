import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { useTenantRole } from '@/hooks/useTenantRole';
import { Loader2, Workflow } from 'lucide-react';
import OperationalProcessManager from '@/components/admin/OperationalProcessManager';

// Processes — the Client Admin's plain-language home for describing how
// their organization works. All writes go through the guarded
// manageOperationalProcess backend function, which verifies the caller's
// tenant scope server-side. Platform admins can open it to preview the
// client experience.
export default function Processes() {
  const { user } = useAuth();
  const { isClientAdmin, isLoading: roleLoading } = useTenantRole();

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
      <div className="max-w-4xl mx-auto px-4 py-8 md:py-10 space-y-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Workflow className="w-4 h-4 text-primary" />
            </div>
            <h1 className="font-sora font-semibold text-2xl text-foreground">Processes</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
            Describe how your organization works, one recurring workflow at a time. Processes keep
            your knowledge grouped by how your business actually runs — and remind you when it's
            time for a refresh.
          </p>
        </div>

        <OperationalProcessManager />
      </div>
    </div>
  );
}