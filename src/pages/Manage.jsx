import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { useTenantRole } from '@/hooks/useTenantRole';
import { Loader2 } from 'lucide-react';
import UploadTraining from '@/components/admin/UploadTraining';
import OperationalProcessManager from '@/components/admin/OperationalProcessManager';

// Manage — the Client Admin's day-to-day admin hub: add knowledge sources
// and describe operational processes. Everything writes through the guarded
// backend functions, which verify the caller's tenant scope server-side.
// Platform admins can open it to preview the client experience.
export default function Manage() {
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
          <h1 className="font-sora font-semibold text-2xl text-foreground">Manage</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Add knowledge and describe how your organization works — everything feeds the AI Assistant.
          </p>
        </div>

        <div id="manage-knowledge" className="scroll-mt-6">
          <UploadTraining />
        </div>

        <div id="manage-processes" className="scroll-mt-6">
          <OperationalProcessManager />
        </div>
      </div>
    </div>
  );
}