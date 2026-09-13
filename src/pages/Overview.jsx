import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { useTenantRole } from '@/hooks/useTenantRole';
import { Loader2 } from 'lucide-react';
import AdminOverview from '@/components/admin/AdminOverview';

// Overview — the company admin's landing screen: setup progress, the next
// recommended action, and items needing attention. Platform admins get a
// workspace selector. Client users are redirected home.
export default function Overview() {
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

  return <AdminOverview />;
}