import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';
import {
  GAP_STATUS_TABS,
  GAP_STATUS_LABEL,
  RESOLUTION_TYPES,
  GAP_PRIORITIES,
  GAP_ORIGIN_LABEL,
  scopeLabel,
} from '@/lib/knowledgeGap';

// Phase 5. Admin review of KnowledgeGap evidence. A gap is NOT knowledge — every
// action here writes only KnowledgeGap + AuditEvent. Resolving via a source is a
// guard: the named Training must already be verified + active + not archived +
// in the exact scope.
export default function KnowledgeGapManager() {
  const queryClient = useQueryClient();
  const { knowledgeGapsEnabled } = useSystemConfig();
  const [tab, setTab] = useState('open');
  const [busyId, setBusyId] = useState(null);
  const [resolveFor, setResolveFor] = useState(null);
  const [resForm, setResForm] = useState({ resolutionType: 'clarified_no_change', resolvedSourceIds: '', notes: '' });

  const { data: clients = [] } = useQuery({ queryKey: ['clients'], queryFn: () => base44.entities.Client.list('name') });
  const { data: users = [] } = useQuery({ queryKey: ['users-all'], queryFn: () => base44.entities.User.list().catch(() => []) });

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['knowledge-gaps', tab],
    queryFn: () => base44.functions.invoke('listKnowledgeGaps', { status: tab, limit: 200 }).then((r) => r?.data ?? r),
    enabled: knowledgeGapsEnabled,
  });
  const gaps = data?.gaps || [];

  const act = async (gapId, payload) => {
    setBusyId(gapId);
    try {
      await base44.functions.invoke('reviewKnowledgeGap', { gapId, ...payload });
      queryClient.invalidateQueries({ queryKey: ['knowledge-gaps'] });
      setResolveFor(null);
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const userLabel = (id) => users.find((u) => u.id === id)?.full_name || users.find((u) => u.id === id)?.email || id;

  if (!knowledgeGapsEnabled) return null;

  return (
    <Card className="border-border">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-primary" />
          Knowledge gaps
          <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Refresh
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground/70">
          Evidence that documented knowledge is incomplete for a real question. Not knowledge itself.
          Resolving via a source requires that source to already be verified + active + in-scope.
        </p>

        <div className="flex flex-wrap gap-1.5">
          {GAP_STATUS_TABS.map((s) => (
            <button
              key={s}
              onClick={() => setTab(s)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium border ${
                tab === s ? 'bg-primary text-white border-primary' : 'bg-card text-muted-foreground border-border'
              }`}
            >
              {GAP_STATUS_LABEL[s]}
            </button>
          ))}
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {!isLoading && gaps.length === 0 && (
          <div className="text-sm text-muted-foreground py-6 text-center">No {GAP_STATUS_LABEL[tab].toLowerCase()} gaps.</div>
        )}

        <div className="space-y-2">
          {gaps.map((g) => (
            <div key={g.id} className="border border-border rounded-lg p-3 text-sm space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium">{g.title}</div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                    <Badge variant="outline">{scopeLabel(g.client_scope, clients)}</Badge>
                    <Badge variant="outline">{g.operational_process_id ? 'linked process' : 'unassigned'}</Badge>
                    <span>asked {g.times_asked}× · {g.distinct_reporters} reporter(s)</span>
                    <span>· priority {g.priority}</span>
                    {(g.origins || []).map((o) => <span key={o}>· {GAP_ORIGIN_LABEL[o] || o}</span>)}
                  </div>
                  {(g.missing_facets || []).length > 0 && (
                    <div className="text-xs text-amber-700 mt-1">missing: {g.missing_facets.join(', ')}</div>
                  )}
                  {(g.related_source_ids || []).length > 0 && (
                    <div className="text-xs mt-1 flex flex-wrap gap-2">
                      {g.related_source_ids.map((id) => (
                        <Link key={id} to={`/training/${id}`} className="text-primary underline">{id.slice(0, 8)}</Link>
                      ))}
                    </div>
                  )}
                  {g.assigned_sme && <div className="text-xs text-muted-foreground mt-1">SME: {userLabel(g.assigned_sme)}</div>}
                  {(g.example_questions || []).length > 0 && (
                    <details className="text-xs text-muted-foreground mt-1">
                      <summary>example questions</summary>
                      <ul className="list-disc pl-4">{g.example_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
                    </details>
                  )}
                </div>
              </div>

              {['candidate', 'open', 'under_review'].includes(g.status) && (
                <div className="flex flex-wrap gap-1.5">
                  <select
                    className="text-xs border border-border rounded px-1.5 py-1 bg-card"
                    defaultValue=""
                    onChange={(e) => e.target.value && act(g.id, { action: 'assign', assignedSme: e.target.value })}
                  >
                    <option value="" disabled>Assign SME…</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email || u.id}</option>)}
                  </select>
                  <select
                    className="text-xs border border-border rounded px-1.5 py-1 bg-card"
                    value={g.priority}
                    onChange={(e) => act(g.id, { action: 'set_priority', priority: e.target.value })}
                  >
                    {GAP_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  {g.status !== 'under_review' && (
                    <button disabled={busyId === g.id} onClick={() => act(g.id, { action: 'start_review' })} className="px-2 py-1 rounded border border-border text-xs">Start review</button>
                  )}
                  <button disabled={busyId === g.id} onClick={() => { setResolveFor(g); setResForm({ resolutionType: 'clarified_no_change', resolvedSourceIds: '', notes: '' }); }} className="px-2 py-1 rounded border border-border text-xs">Resolve…</button>
                </div>
              )}
              {['resolved', 'not_applicable'].includes(g.status) && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{g.resolution_type}</span>
                  <button disabled={busyId === g.id} onClick={() => act(g.id, { action: 'reopen' })} className="px-2 py-0.5 rounded border border-border">Reopen</button>
                </div>
              )}

              {resolveFor?.id === g.id && (
                <div className="border-t border-border pt-2 space-y-2">
                  <select
                    className="text-xs border border-border rounded px-1.5 py-1 bg-card w-full"
                    value={resForm.resolutionType}
                    onChange={(e) => setResForm((f) => ({ ...f, resolutionType: e.target.value }))}
                  >
                    {RESOLUTION_TYPES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                  {RESOLUTION_TYPES.find((r) => r.value === resForm.resolutionType)?.needsSource && (
                    <input
                      className="text-xs border border-border rounded px-1.5 py-1 bg-card w-full"
                      placeholder="Verified Training id(s), comma-separated"
                      value={resForm.resolvedSourceIds}
                      onChange={(e) => setResForm((f) => ({ ...f, resolvedSourceIds: e.target.value }))}
                    />
                  )}
                  <input
                    className="text-xs border border-border rounded px-1.5 py-1 bg-card w-full"
                    placeholder="Notes (optional)"
                    value={resForm.notes}
                    onChange={(e) => setResForm((f) => ({ ...f, notes: e.target.value }))}
                  />
                  <div className="flex gap-2">
                    <button
                      disabled={busyId === g.id}
                      onClick={() => act(g.id, {
                        action: 'resolve',
                        resolutionType: resForm.resolutionType,
                        resolvedSourceIds: resForm.resolvedSourceIds.split(',').map((s) => s.trim()).filter(Boolean),
                        resolutionNotes: resForm.notes || undefined,
                      })}
                      className="px-3 py-1 rounded bg-primary text-white text-xs"
                    >
                      Confirm resolve
                    </button>
                    <button onClick={() => setResolveFor(null)} className="px-2 py-1 rounded text-xs text-muted-foreground">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
