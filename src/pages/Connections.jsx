import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { useTenantRole } from '@/hooks/useTenantRole';
import { useHashScroll } from '@/hooks/useHashScroll';
import { Loader2, Cable } from 'lucide-react';
import DriveSyncCard from '@/components/admin/DriveSyncCard';
import ServerUrlCard from '@/components/connect/ServerUrlCard';
import ConnectInstructions from '@/components/connect/ConnectInstructions';

// Connections — Google Drive import and external AI assistant (MCP)
// connections, with setup instructions and honest status.
export default function Connections() {
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
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-8 md:py-12 space-y-10">
      <div>
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
            <Cable className="w-6 h-6 text-primary" />
          </div>
          <h1 className="font-sora font-semibold text-2xl md:text-3xl text-foreground">
            Connections
          </h1>
        </div>
        <p className="text-sm md:text-base text-muted-foreground mt-2 leading-relaxed">
          Bring knowledge in from Google Drive, and let AI assistants like Claude,
          ChatGPT, and Cursor answer questions from your MindVault on your behalf.
        </p>
      </div>

      <DriveSyncCard />

      <div>
        <h2 className="font-sora font-semibold text-foreground mb-4">
          External AI assistants
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">
          Copy the server URL below, then follow the steps for your assistant. The
          assistant signs in as you and only with the access your account already has.
        </p>
        <div className="mb-8">
          <ServerUrlCard />
        </div>
        <ConnectInstructions />
      </div>
    </div>
  );
}