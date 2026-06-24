import { useAuth } from '@/lib/AuthContext';

export function useIsAdmin() {
  const { user } = useAuth();
  return user?.role === 'admin';
}