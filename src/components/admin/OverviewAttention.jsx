import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowRight, CheckCircle2, AlertTriangle } from 'lucide-react';

// Actionable maintenance items derived from the workspace's own data —
// each with a direct button to the screen where it's fixed. Separate from
// the initial setup checklist; availability items are only surfaced here
// once setup is complete (the checklist covers them during setup).
export default function OverviewAttention({ sources = [], processes = [], members = [], setupComplete = true }) {
  const items = [];

  const needsAvailability = sources.filter(
    (s) => s && !s.is_archived && s.status === 'ready' &&
      (!s.knowledge_scope || s.knowledge_scope === 'unclassified'),
  );
  const needsAttention = sources.filter(
    (s) => s && !s.is_archived && s.is_active_version !== false &&
      (s.status === 'error' || s.index_status === 'failed' || s.verification_status === 'rejected'),
  );
  const processing = sources.filter((s) => s && !s.is_archived && s.status === 'processing');

  if (needsAttention.length > 0) {
    items.push({
      id: 'source-attention',
      copy: `${needsAttention.length} ${needsAttention.length === 1 ? 'knowledge source needs' : 'knowledge sources need'} attention before the assistant can use ${needsAttention.length === 1 ? 'it' : 'them'}.`,
      actionLabel: 'Review sources',
      to: '/knowledge#attention',
    });
  }
  if (setupComplete && needsAvailability.length > 0) {
    items.push({
      id: 'source-availability',
      copy: `${needsAvailability.length} ${needsAvailability.length === 1 ? 'document needs' : 'documents need'} an availability setting before the assistant can use ${needsAvailability.length === 1 ? 'it' : 'them'}.`,
      actionLabel: 'Review documents',
      to: '/knowledge#availability',
    });
  }
  if (processing.length > 0) {
    items.push({
      id: 'sources-processing',
      copy: `${processing.length} ${processing.length === 1 ? 'source is' : 'sources are'} still being read and summarized.`,
      actionLabel: 'View sources',
      to: '/knowledge',
    });
  }

  const activeProcesses = processes.filter((p) => p && p.status === 'active');
  const processesMissingGovernance = activeProcesses.filter(
    (p) => !p.process_owner || !p.subject_matter_expert || !p.criticality,
  );
  if (activeProcesses.length > 0 && processesMissingGovernance.length > 0) {
    items.push({
      id: 'process-governance',
      copy: `${processesMissingGovernance.length} of ${activeProcesses.length} processes ${processesMissingGovernance.length === 1 ? 'is' : 'are'} missing an owner, an expert, or a criticality.`,
      actionLabel: 'Review processes',
      to: '/processes',
    });
  }

  const pendingInvites = members.filter((m) => m && m.status === 'pending');
  if (pendingInvites.length > 0) {
    items.push({
      id: 'pending-invites',
      copy: `${pendingInvites.length} team ${pendingInvites.length === 1 ? 'invitation is' : 'invitations are'} still waiting to be accepted.`,
      actionLabel: 'Manage team',
      to: '/company',
    });
  }

  return (
    <Card className="border-border">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          {items.length > 0 ? (
            <>
              <AlertTriangle className="w-4 h-4 text-primary" />
              Needs your attention
            </>
          ) : (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              Needs your attention
            </>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing needs your attention right now — the assistant is working with
            everything you&apos;ve made available.
          </p>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.id} className="flex flex-col sm:flex-row sm:items-center gap-3">
                <p className="flex-1 text-sm text-foreground leading-relaxed">{item.copy}</p>
                <Button asChild size="sm" className="bg-primary hover:bg-primary/90 flex-shrink-0 gap-1">
                  <Link to={item.to}>
                    {item.actionLabel}
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}