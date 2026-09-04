import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, GitBranch, RefreshCw, AlertTriangle, History } from 'lucide-react';
import { toast } from 'sonner';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';
import ConceptHelp from '@/components/onboarding/ConceptHelp';
import {
  STATE_LABELS,
  ACTION_LABELS,
  runLifecycleAction,
  fetchSourceHistory,
  runReconcile,
} from '@/lib/knowledgeLifecycle';

const TONE_CLASS = {
  ok: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  info: 'bg-sky-100 text-sky-700 border-sky-200',
  warn: 'bg-amber-100 text-amber-700 border-amber-200',
  error: 'bg-red-100 text-red-700 border-red-200',
  muted: 'text-muted-foreground border-border',
};

function StateBadge({ state }) {
  const s = STATE_LABELS[state] || { label: state, tone: 'muted' };
  return <Badge variant="outline" className={`text-xs ${TONE_CLASS[s.tone]}`}>{s.label}</Badge>;
}

// DisplayState -> the plain-language actions we surface (mirrors the engine's
// availableActions for canWrite=true, advanced=false).
const ACTIONS_FOR = {
  draft: ['edit', 'send_for_review', 'approve', 'reject', 'archive'],
  in_review: ['edit', 'approve', 'request_changes', 'reject'],
  changes_requested: ['edit', 'send_for_review', 'approve', 'reject'],
  verified: ['edit', 'publish', 'reject', 'archive'],
  published: ['edit', 'archive'],
  outdated: ['edit', 'archive'],
  previous_version: ['restore'],
  archived: ['restore'],
  rejected: ['edit'],
  needs_attention: ['reindex'],
  indexing: [],
};

export default function KnowledgeLifecyclePanel() {
  const qc = useQueryClient();
  const { sourceLifecycleEnabled } = useSystemConfig();
  const [busy, setBusy] = useState(null);
  const [openHistory, setOpenHistory] = useState(null);
  const [note, setNote] = useState('');

  const { data: trainings = [], isLoading } = useQuery({
    queryKey: ['all-trainings'],
    queryFn: () => base44.entities.Training.list('-created_date'),
  });

  const { data: history } = useQuery({
    queryKey: ['source-history', openHistory],
    queryFn: () => fetchSourceHistory(openHistory),
    enabled: !!openHistory,
  });

  // One row per lineage: the active version, or an orphan draft with no active sibling.
  const rootId = (t) => t.root_source_id || t.id;
  const byLineage = new Map();
  for (const t of trainings) {
    const k = rootId(t);
    const cur = byLineage.get(k);
    if (!cur || (t.is_active_version !== false && cur.is_active_version === false)) byLineage.set(k, t);
  }
  const rows = [...byLineage.values()].filter((t) => t.knowledge_scope && t.knowledge_scope !== 'unclassified');

  const act = async (action, t) => {
    setBusy(t.id + action);
    try {
      const r = await runLifecycleAction(action, t.id, action === 'reject' || action === 'request_changes' ? { note } : {});
      if (r?.ok) {
        toast.success(`${ACTION_LABELS[action]}: ${STATE_LABELS[r.displayState]?.label || r.displayState}`);
      } else {
        toast.error(r?.message || r?.error || 'Action failed');
      }
      qc.invalidateQueries({ queryKey: ['all-trainings'] });
      qc.invalidateQueries({ queryKey: ['source-history', openHistory] });
      setNote('');
    } catch (e) {
      toast.error(e?.message || 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  const repair = async () => {
    setBusy('reconcile');
    try {
      const r = await runReconcile();
      toast.success(`Repair run: ${r?.handled || 0} recovered, ${r?.manual || 0} need manual review`);
      qc.invalidateQueries({ queryKey: ['all-trainings'] });
    } catch (e) {
      toast.error(e?.message || 'Repair failed');
    } finally {
      setBusy(null);
    }
  };

  if (!sourceLifecycleEnabled) {
    return (
      <Card className="border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-primary" />
            Knowledge Lifecycle
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Source Lifecycle is turned off. Enable it under <span className="font-medium">System</span> to
            manage versions, review, and publishing. Repair and first-time classification remain available
            while it is off.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border">
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-primary" />
          Knowledge Lifecycle
          <ConceptHelp term="verification" />
        </CardTitle>
        <Button variant="outline" size="sm" className="gap-1.5 text-xs" disabled={busy === 'reconcile'} onClick={repair}>
          <RefreshCw className={`w-3.5 h-3.5 ${busy === 'reconcile' ? 'animate-spin' : ''}`} />
          Run repair
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">No classified knowledge sources yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((t) => {
              const ds = t.lifecycle_state === 'active' ? 'published' : (t.lifecycle_state || 'draft');
              return (
                <div key={t.id} className="px-5 py-4 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{t.title}</p>
                      <p className="text-xs text-muted-foreground">
                        v{t.version_number || 1}
                        {t.verification_status ? ` · ${t.verification_status}` : ''}
                        {t.index_status ? ` · index: ${t.index_status}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {t.index_status === 'failed' && <AlertTriangle className="w-4 h-4 text-red-500" />}
                      <StateBadge state={ds} />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(ACTIONS_FOR[ds] || []).filter((a) => a !== 'edit').map((a) => (
                      <Button
                        key={a}
                        size="sm"
                        variant={a === 'publish' || a === 'approve' ? 'default' : 'outline'}
                        className="h-7 text-xs"
                        disabled={busy === t.id + a}
                        onClick={() => act(a, t)}
                      >
                        {busy === t.id + a ? <Loader2 className="w-3 h-3 animate-spin" /> : ACTION_LABELS[a]}
                      </Button>
                    ))}
                    <Button
                      size="sm" variant="ghost" className="h-7 text-xs gap-1"
                      onClick={() => setOpenHistory(openHistory === t.id ? null : t.id)}
                    >
                      <History className="w-3 h-3" /> History
                    </Button>
                  </div>
                  {openHistory === t.id && history && (
                    <div className="mt-2 rounded-lg border border-border bg-muted/40 p-3 space-y-2 text-xs">
                      <p className="font-medium text-foreground">
                        Lineage {history.lineage_id?.slice(0, 8)} · active v{history.active_version_number ?? '—'}
                        {history.has_open_draft ? ' · open draft' : ''}
                      </p>
                      {(history.versions || []).map((v) => (
                        <div key={v.id} className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground">
                            v{v.version_number} · {v.chunk_count} units{v.index_stale_units ? ` (${v.index_stale_units} held)` : ''}
                          </span>
                          <StateBadge state={v.displayState} />
                        </div>
                      ))}
                      {(history.failed_operations || []).length > 0 && (
                        <p className="text-red-600">
                          {history.failed_operations.length} failed operation(s) — use “Run repair”.
                        </p>
                      )}
                      {(history.audit || []).slice(0, 6).map((a, i) => (
                        <p key={i} className="text-muted-foreground">
                          {a.at?.slice(0, 10)} · {a.action} · {a.summary}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
