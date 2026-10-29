import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BookOpen, Loader2, RefreshCw, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import ClientSelect from '@/components/knowledge/ClientSelect';
import EmptyState from '@/components/common/EmptyState';
import {
  classifyTraining,
  isClassified,
  reindexTraining,
  scopeValueOf,
} from '@/lib/knowledgeScope';
import { sourceStatus, SOURCE_STATUS_ORDER } from '@/lib/sourceStatus';
import { listKnowledgeSources, listMyClients } from '@/lib/scopedData';

const TONE_CLASS = {
  red: 'bg-red-50 border-red-200 text-red-700',
  amber: 'bg-amber-50 border-amber-200 text-amber-700',
  blue: 'bg-blue-50 border-blue-200 text-blue-700',
  green: 'bg-green-50 border-green-200 text-green-700',
  muted: 'bg-muted border-border text-muted-foreground',
};

// Every knowledge source with a plain-business status — Processing, Needs
// your review, Available to the assistant, or Needs attention — with the
// reason and the next action when it isn't available. Making a source
// available (choosing who can use it) is different from verifying it
// (confirming it is accurate); both are surfaced here.
export default function SourceStatusList() {
  const queryClient = useQueryClient();
  const [rowScope, setRowScope] = useState({}); // trainingId -> scope value
  const [busyRow, setBusyRow] = useState(null);

  const { data: clients = [] } = useQuery({
    queryKey: ['clients'],
    queryFn: () => listMyClients(),
  });
  const { data: trainings = [], isLoading } = useQuery({
    queryKey: ['all-trainings'],
    queryFn: () => listKnowledgeSources({ sort: '-created_date' }),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
    queryClient.invalidateQueries({ queryKey: ['trainings'] });
  };

  const makeAvailable = async (training) => {
    const value = rowScope[training.id] ?? scopeValueOf(training);
    if (!isClassified(value)) return;
    setBusyRow(training.id);
    try {
      const { index } = await classifyTraining(training.id, value, clients);
      invalidate();
      if (index?.ok) toast.success(`"${training.title}" is now available to the assistant`);
      else toast.warning(`"${training.title}" was made available, but preparing it failed: ${index?.error || index?.result?.error || 'unknown'} — use Retry on the list.`);
    } catch (err) {
      toast.error('Could not make it available: ' + (err?.message || 'Unknown error'));
    } finally {
      setBusyRow(null);
    }
  };

  const retryIndex = async (training) => {
    setBusyRow(training.id);
    try {
      const r = await reindexTraining(training.id);
      if (r?.ok) toast.success(`"${training.title}" is being prepared for the assistant`);
      else toast.error(`Retry failed: ${r?.error || r?.result?.error || 'unknown'}`);
      invalidate();
    } finally {
      setBusyRow(null);
    }
  };

  const rows = trainings
    .map((t) => ({ training: t, status: sourceStatus(t) }))
    .filter((r) => r.status)
    .sort((a, b) =>
      SOURCE_STATUS_ORDER.indexOf(a.status.key) - SOURCE_STATUS_ORDER.indexOf(b.status.key),
    );

  const grouped = SOURCE_STATUS_ORDER
    .map((key) => ({ key, rows: rows.filter((r) => r.status.key === key) }))
    .filter((g) => g.rows.length > 0);

  return (
    <Card className="border-border" id="availability">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-primary" />
          Sources and their status
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Making a source available lets the assistant use it. Verifying it is how you
          confirm the content is accurate — a source can be available before it&apos;s verified.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-12 bg-muted rounded-xl animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={BookOpen}
              title="No knowledge sources yet"
              body="Add your first source above — an SOP, policy, or process document. It will show up here with a clear status."
            />
          </div>
        ) : (
          <div className="divide-y divide-border">
            {grouped.map((group) => (
              <div key={group.key} id={group.key === 'attention' ? 'attention' : undefined} className="scroll-mt-6">
                {group.rows.map(({ training, status }) => (
                  <div key={training.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-foreground truncate">{training.title}</p>
                        <Badge variant="outline" className={`text-xs border flex-shrink-0 ${TONE_CLASS[status.tone]}`}>
                          {status.label}
                        </Badge>
                        {status.verified && (
                          <Badge variant="outline" className="text-xs border bg-emerald-50 border-emerald-200 text-emerald-700 flex-shrink-0">
                            Verified
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{status.reason}</p>
                      {status.next && (
                        <p className="text-xs text-muted-foreground/70 mt-0.5">Next: {status.next}</p>
                      )}
                    </div>

                    {status.canSetAvailability && (
                      <>
                        <div className="sm:w-56">
                          <ClientSelect
                            value={rowScope[training.id] ?? scopeValueOf(training)}
                            onChange={(v) => setRowScope((s) => ({ ...s, [training.id]: v }))}
                            disabled={busyRow === training.id}
                          />
                        </div>
                        <Button
                          size="sm"
                          className="bg-primary hover:bg-primary/90 flex-shrink-0"
                          disabled={busyRow === training.id || !isClassified(rowScope[training.id] ?? scopeValueOf(training))}
                          onClick={() => makeAvailable(training)}
                        >
                          {busyRow === training.id ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Make available'}
                        </Button>
                      </>
                    )}
                    {status.canRetryIndex && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-xs flex-shrink-0"
                        disabled={busyRow === training.id}
                        onClick={() => retryIndex(training)}
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${busyRow === training.id ? 'animate-spin' : ''}`} />
                        Retry
                      </Button>
                    )}
                    <Button asChild variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-muted-foreground flex-shrink-0">
                      <Link to={status.detailHref}>
                        Open <ExternalLink className="w-3.5 h-3.5" />
                      </Link>
                    </Button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}