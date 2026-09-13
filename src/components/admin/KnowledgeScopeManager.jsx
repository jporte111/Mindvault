import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldQuestion, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import ClientSelect from '@/components/knowledge/ClientSelect';
import ClientsCard from '@/components/admin/ClientsCard';
import ConceptHelp from '@/components/onboarding/ConceptHelp';
import {
  classifyTraining,
  isClassified,
  reindexTraining,
  scopeValueOf,
  SCOPE_GENERAL,
  SCOPE_UNCLASSIFIED,
} from '@/lib/knowledgeScope';

function scopeLabel(training, clients) {
  const v = scopeValueOf(training);
  if (v === SCOPE_GENERAL) return 'Firm-wide / general';
  if (v.startsWith('client:')) {
    const c = clients.find((x) => x.id === v.slice('client:'.length));
    return c ? `Client: ${c.name}` : 'Client (unknown)';
  }
  return 'Needs review';
}

export default function KnowledgeScopeManager() {
  const [rowScope, setRowScope] = useState({}); // trainingId -> scope value
  const [busyRow, setBusyRow] = useState(null);

  const { data: clients = [] } = useQuery({
    queryKey: ['clients'],
    queryFn: () => base44.entities.Client.list('name'),
  });
  const { data: trainings = [] } = useQuery({
    queryKey: ['all-trainings'],
    queryFn: () => base44.entities.Training.list('-created_date'),
  });

  const saveScope = async (training) => {
    const value = rowScope[training.id] ?? scopeValueOf(training);
    setBusyRow(training.id);
    try {
      const { index } = await classifyTraining(training.id, value, clients);
      if (!isClassified(value)) {
        toast.success(`"${training.title}" set to Needs review (removed from chat)`);
      } else if (index?.ok) {
        toast.success(`"${training.title}" classified and indexed`);
      } else {
        toast.warning(`"${training.title}" classified, but indexing failed: ${index?.error || index?.result?.error || 'unknown'} — retry from Re-index.`);
      }
    } catch (err) {
      toast.error('Failed to classify: ' + (err?.message || 'Unknown error'));
    } finally {
      setBusyRow(null);
    }
  };

  const reindex = async (training) => {
    setBusyRow(training.id);
    try {
      const r = await reindexTraining(training.id);
      if (r?.ok) toast.success(`Re-indexed "${training.title}"`);
      else toast.error(`Re-index failed: ${r?.error || r?.result?.error || 'unknown'}`);
    } finally {
      setBusyRow(null);
    }
  };

  const needsReview = trainings.filter((t) => !isClassified(scopeValueOf(t)));
  const classified = trainings.filter((t) => isClassified(scopeValueOf(t)));

  return (
    <>
      {/* Clients */}
      <ClientsCard />

      {/* Needs review */}
      <Card className="border-border">
        <CardHeader className="pb-4">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <ShieldQuestion className="w-4 h-4 text-primary" />
            Needs review
            <ConceptHelp term="scope" />
            {needsReview.length > 0 && (
              <Badge variant="outline" className="ml-1 bg-amber-100 text-amber-700 border-amber-200 text-xs">{needsReview.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {needsReview.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">Every training has a knowledge scope. Nothing to review.</p>
          ) : (
            <div className="divide-y divide-border">
              {needsReview.map((t) => (
                <div key={t.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{t.title}</p>
                    <p className="text-xs text-muted-foreground">{t.category || 'Uncategorized'} · {t.status}</p>
                  </div>
                  <div className="sm:w-64">
                    <ClientSelect
                      value={rowScope[t.id] ?? SCOPE_UNCLASSIFIED}
                      onChange={(v) => setRowScope((s) => ({ ...s, [t.id]: v }))}
                      disabled={busyRow === t.id}
                    />
                  </div>
                  <Button
                    size="sm"
                    className="bg-primary hover:bg-primary/90 gap-2"
                    disabled={busyRow === t.id || !isClassified(rowScope[t.id] ?? SCOPE_UNCLASSIFIED)}
                    onClick={() => saveScope(t)}
                  >
                    {busyRow === t.id ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    Save &amp; index
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Classified — scope + re-index */}
      {classified.length > 0 && (
        <Card className="border-border">
          <CardHeader className="pb-4">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-primary" />
              Classified knowledge ({classified.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {classified.map((t) => (
                <div key={t.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{t.title}</p>
                    <p className="text-xs text-muted-foreground">{scopeLabel(t, clients)}</p>
                  </div>
                  <div className="sm:w-56">
                    <ClientSelect
                      value={rowScope[t.id] ?? scopeValueOf(t)}
                      onChange={(v) => setRowScope((s) => ({ ...s, [t.id]: v }))}
                      disabled={busyRow === t.id}
                    />
                  </div>
                  {(rowScope[t.id] ?? scopeValueOf(t)) !== scopeValueOf(t) ? (
                    <Button size="sm" className="bg-primary hover:bg-primary/90" disabled={busyRow === t.id} onClick={() => saveScope(t)}>
                      {busyRow === t.id ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" className="gap-1.5 text-xs" disabled={busyRow === t.id} onClick={() => reindex(t)}>
                      <RefreshCw className={`w-3.5 h-3.5 ${busyRow === t.id ? 'animate-spin' : ''}`} />
                      Re-index
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}