import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';
import { verifyKnowledgeSource } from '@/lib/knowledgeLifecycle';

// One-click verification for a published knowledge source. Runs the same
// governed steps the Knowledge Lifecycle panel runs by hand: fork an identical
// draft, prepare it, verify it, publish it. Only shown when those steps are
// actually possible (admin, lifecycle on, source active and not yet verified).
export default function VerifySourceButton({ training }) {
  const isAdmin = useIsAdmin();
  const { sourceLifecycleEnabled } = useSystemConfig();
  const queryClient = useQueryClient();
  const [verifying, setVerifying] = useState(false);

  const eligible = isAdmin && sourceLifecycleEnabled
    && training.is_active_version !== false
    && !training.is_archived
    && training.verification_status !== 'verified'
    && training.verification_status !== 'rejected';
  if (!eligible) return null;

  const handleVerify = async () => {
    setVerifying(true);
    toast.info('Verifying — preparing the source may take a moment…');
    try {
      const r = await verifyKnowledgeSource(training.id);
      if (r?.ok) {
        toast.success(r?.noOp ? 'This source is already verified.' : 'Verified and published.');
      } else {
        toast.error(r?.message || r?.error || 'Verification failed.');
      }
    } catch (err) {
      const data = err?.response?.data;
      toast.error('Verification failed: ' + (data?.message || data?.error || err?.message || 'Unknown error'));
    } finally {
      setVerifying(false);
      queryClient.invalidateQueries({ queryKey: ['training', training.id] });
      queryClient.invalidateQueries({ queryKey: ['trainings'] });
      queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-health'] });
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-2 text-xs border-primary/50 text-primary hover:bg-primary/10"
      onClick={handleVerify}
      disabled={verifying}
    >
      {verifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
      {verifying ? 'Verifying…' : 'Verify this source'}
    </Button>
  );
}