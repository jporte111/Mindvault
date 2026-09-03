import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, ShieldCheck, Users, ClipboardList, MessageCircleQuestion } from 'lucide-react';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';
import {
  fetchKnowledgeHealth, TONE, BAND_TONE, COVERAGE_TONE, CONTINUITY_TONE, KEYPERSON_TONE,
} from '@/lib/knowledgeHealth';

function Pill({ tone = 'muted', children }) {
  return <Badge variant="outline" className={`text-xs ${TONE[tone] || TONE.muted}`}>{children}</Badge>;
}

function BandCard({ title, band, label, caveat }) {
  return (
    <Card className="border-border">
      <CardContent className="py-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wide">{title}</p>
        <div className="mt-1 flex items-center gap-2">
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${
            (BAND_TONE[band] === 'ok') ? 'bg-emerald-500'
              : (BAND_TONE[band] === 'warn') ? 'bg-amber-500'
                : (BAND_TONE[band] === 'error') ? 'bg-red-500' : 'bg-slate-300'}`} />
          <span className="text-sm font-semibold text-foreground">{label}</span>
        </div>
        {caveat && <p className="mt-1 text-[11px] text-muted-foreground">{caveat}</p>}
      </CardContent>
    </Card>
  );
}

function SummaryCard({ label, big, sub, onClick }) {
  return (
    <button onClick={onClick} className="text-left">
      <Card className="border-border hover:border-primary/40 transition-colors">
        <CardContent className="py-4">
          <p className="text-2xl font-bold text-foreground">{big}</p>
          <p className="text-sm font-medium text-foreground/80">{label}</p>
          {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
        </CardContent>
      </Card>
    </button>
  );
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'processes', label: 'Process Continuity' },
  { id: 'queue', label: 'Review Queue' },
  { id: 'people', label: 'Key-Person Exposure' },
  { id: 'gaps', label: 'Knowledge Gaps' },
];

export default function Continuity() {
  const isAdmin = useIsAdmin();
  const { knowledgeHealthEnabled } = useSystemConfig();
  const [tab, setTab] = useState('overview');
  const [scope, setScope] = useState('general');

  const { data: clients = [] } = useQuery({
    queryKey: ['clients'],
    queryFn: () => base44.entities.Client.list('name'),
    enabled: isAdmin && knowledgeHealthEnabled,
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ['knowledge-health', scope],
    queryFn: () => fetchKnowledgeHealth(scope),
    enabled: isAdmin && knowledgeHealthEnabled,
  });

  const rows = useMemo(() => {
    const r = [...(data?.processRows || [])];
    const order = { at_risk: 0, not_documented: 1, needs_setup: 2, ready: 3 };
    const crit = { mission_critical: 0, high: 1, medium: 2, low: 3 };
    return r.sort((a, b) =>
      (order[a.continuityState] - order[b.continuityState]) ||
      ((crit[a.criticality] ?? 4) - (crit[b.criticality] ?? 4)) ||
      String(a.name).localeCompare(b.name));
  }, [data]);

  if (!isAdmin) {
    return <Shell><p className="text-sm text-muted-foreground">This dashboard is available to admins only.</p></Shell>;
  }
  if (!knowledgeHealthEnabled) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          The Operational Continuity dashboard is turned off. Enable it under <span className="font-medium">Admin → System</span>.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex gap-1 bg-muted rounded-xl p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-lg text-sm ${tab === t.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="ml-auto h-9 rounded-lg border border-border bg-background px-3 text-sm"
        >
          <option value="general">All firm-wide</option>
          {clients.map((c) => <option key={c.id} value={c.id}>Client: {c.name}</option>)}
        </select>
      </div>

      {isLoading && <div className="py-16 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline" /> Loading…</div>}
      {error && <p className="text-sm text-red-600">{error?.message || 'Failed to load'}</p>}

      {data && tab === 'overview' && (
        <div className="space-y-5">
          {/* Setup banner */}
          {(data.setup?.processesNeedingOwner + data.setup?.processesNeedingCriticality + data.setup?.sourcesNeedingCadence + data.setup?.legacyNeedingReindex + data.setup?.unclassifiedItems) > 0 && (
            <Card className="border-amber-200 bg-amber-50">
              <CardContent className="py-3 text-sm text-amber-900 space-y-0.5">
                <p className="font-medium">Governance setup</p>
                {data.setup.processesNeedingOwner > 0 && <p>{data.setup.processesNeedingOwner} processes need an owner assigned.</p>}
                {data.setup.processesNeedingSme > 0 && <p>{data.setup.processesNeedingSme} processes need a subject-matter expert.</p>}
                {data.setup.processesNeedingCriticality > 0 && <p>{data.setup.processesNeedingCriticality} processes need a criticality set.</p>}
                {data.setup.sourcesNeedingCadence > 0 && <p>{data.setup.sourcesNeedingCadence} sources have no review schedule.</p>}
                {data.setup.unlinkedSources > 0 && <p>{data.setup.unlinkedSources} knowledge sources aren’t linked to a process yet.</p>}
                {data.setup.legacyNeedingReindex > 0 && <p>{data.setup.legacyNeedingReindex} {data.setup && 'legacy knowledge sources still need re-indexing before their documentation status can be confirmed.'}</p>}
                {data.setup.unclassifiedItems > 0 && <p>{data.setup.unclassifiedItems} items are awaiting classification.</p>}
              </CardContent>
            </Card>
          )}

          {/* Snapshot */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <BandCard title="Coverage" band={data.snapshot.coverage.band} label={data.snapshot.coverage.label} />
            <BandCard title="Currency" band={data.snapshot.currency.band} label={data.snapshot.currency.label} />
            <BandCard title="Verification" band={data.snapshot.verification.band} label={data.snapshot.verification.label} caveat={data.snapshot.verification.caveat} />
            <BandCard title="Key-person resilience" band={data.snapshot.keyPersonResilience.band} label={data.snapshot.keyPersonResilience.label} />
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <SummaryCard label="Critical process coverage" big={data.metrics.criticalCoverage.display.split(' of ')[0]}
              sub={data.metrics.criticalCoverage.display + (data.metrics.criticalCoverage.unknownDisplay ? ` · ${data.metrics.criticalCoverage.unknownDisplay}` : '')}
              onClick={() => setTab('processes')} />
            <SummaryCard label="Knowledge needing review" big={data.metrics.knowledgeNeedingReview.overdue}
              sub={`${data.metrics.knowledgeNeedingReview.overdue} overdue · ${data.metrics.knowledgeNeedingReview.due_soon} due soon`}
              onClick={() => setTab('queue')} />
            <SummaryCard label="Active knowledge not yet verified" big={data.metrics.activeNotVerified.total}
              sub="Includes legacy knowledge that predates the verification workflow." onClick={() => setTab('queue')} />
            <SummaryCard label="Open knowledge gaps" big={data.metrics.openGaps.open}
              sub={`${data.metrics.openGaps.open} open · ${data.metrics.openGaps.watching} watching`} onClick={() => setTab('gaps')} />
            <SummaryCard label="Processes without an owner or SME" big={data.metrics.processesWithoutOwnerOrSme} onClick={() => setTab('processes')} />
            <SummaryCard label="Sources needing attention" big={data.metrics.sourcesNeedingAttention} onClick={() => setTab('queue')} />
          </div>

          {/* Address first */}
          <Card className="border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <ClipboardList className="w-4 h-4 text-primary" /> Address first
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {(data.addressFirst || []).length === 0
                ? <p className="px-5 py-6 text-sm text-muted-foreground">Nothing urgent — nice.</p>
                : <div className="divide-y divide-border">
                  {data.addressFirst.map((it) => (
                    <div key={it.id} className="px-5 py-3 flex items-center gap-3">
                      <span className="text-sm text-foreground flex-1">{it.label}{it.title ? ` — ${it.title}` : ''}</span>
                      {it.criticality && <Pill tone="muted">{it.criticality.replace('_', ' ')}</Pill>}
                    </div>
                  ))}
                </div>}
            </CardContent>
          </Card>
        </div>
      )}

      {data && tab === 'processes' && (
        <Card className="border-border">
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="px-4 py-2">Process</th>
                  <th className="px-4 py-2">Criticality</th>
                  <th className="px-4 py-2">Owner / SME</th>
                  <th className="px-4 py-2">Documentation</th>
                  <th className="px-4 py-2">Review</th>
                  <th className="px-4 py-2">Gaps</th>
                  <th className="px-4 py-2">Key-person</th>
                  <th className="px-4 py-2">State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/60">
                    <td className="px-4 py-2.5 font-medium text-foreground">{r.name}</td>
                    <td className="px-4 py-2.5">{r.criticality ? r.criticality.replace('_', ' ') : <Pill tone="warn">not set</Pill>}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {(r.owner?.name || 'Not assigned')} / {(r.sme?.name || '—')}{r.backup ? ` · backup ${r.backup.name}` : ''}
                    </td>
                    <td className="px-4 py-2.5"><Pill tone={COVERAGE_TONE[r.coverageState]}>{r.coverageLabel}</Pill></td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.freshnessLabel}</td>
                    <td className="px-4 py-2.5">{r.openGaps || 0}</td>
                    <td className="px-4 py-2.5"><Pill tone={KEYPERSON_TONE[r.keyPersonLevel]}>{r.keyPersonLabel}</Pill></td>
                    <td className="px-4 py-2.5"><Pill tone={CONTINUITY_TONE[r.continuityState]}>{r.continuityLabel}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {data && tab === 'queue' && (
        <Card className="border-border">
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {(data.reviewQueue || []).map((it) => (
                <div key={it.id} className="px-5 py-3 flex items-center gap-3">
                  <span className="text-sm text-foreground flex-1">{it.label}{it.title ? ` — ${it.title}` : ''}</span>
                  {it.criticality && <Pill tone="muted">{it.criticality.replace('_', ' ')}</Pill>}
                </div>
              ))}
              {(data.reviewQueue || []).length === 0 && <p className="px-5 py-6 text-sm text-muted-foreground">Queue is clear.</p>}
            </div>
          </CardContent>
        </Card>
      )}

      {data && tab === 'people' && (
        <div className="space-y-3">
          {(data.keyPersonExposure || []).length === 0
            ? <p className="text-sm text-muted-foreground">No single-person dependencies found.</p>
            : (data.keyPersonExposure || []).map((p) => (
              <Card key={p.userId} className="border-border">
                <CardContent className="py-3">
                  <p className="text-sm font-medium text-foreground flex items-center gap-2">
                    <Users className="w-4 h-4 text-primary" /> {p.name}
                    {p.concentration && <Pill tone="error">sole expert on multiple critical processes</Pill>}
                  </p>
                  <ul className="mt-1 text-xs text-muted-foreground list-disc pl-6">
                    {p.processes.map((pr) => (
                      <li key={pr.id}>{pr.name}{pr.criticality ? ` (${pr.criticality.replace('_', ' ')})` : ''} — {pr.role.replace('_', ' ')}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
        </div>
      )}

      {data && tab === 'gaps' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{data.gapInvariantNote}</p>
          {(data.gaps || []).map((g) => (
            <Card key={g.id} className="border-border">
              <CardContent className="py-3">
                <p className="text-sm font-medium text-foreground flex items-center gap-2">
                  <MessageCircleQuestion className="w-4 h-4 text-primary" /> {g.title}
                  <Pill tone={g.state === 'open' ? 'warn' : 'info'}>{g.promoted ? 'Confirmed pattern' : g.state === 'candidate' ? 'Watching' : g.state.replace('_', ' ')}</Pill>
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Asked {g.timesAsked}× by {g.distinctReporters} {g.distinctReporters === 1 ? 'person' : 'people'}
                  {g.missingFacets?.length ? ` · missing: ${g.missingFacets.join(', ')}` : ''}
                </p>
              </CardContent>
            </Card>
          ))}
          {(data.gaps || []).length === 0 && <p className="text-sm text-muted-foreground">No open knowledge gaps.</p>}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="bg-card border-b border-border px-8 py-6">
        <div className="max-w-6xl mx-auto flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="font-sora text-xl md:text-2xl font-bold text-foreground">Operational Continuity</h1>
            <p className="text-sm text-muted-foreground">Where is our operational knowledge healthy, stale, incomplete, unowned, or dependent on one person?</p>
          </div>
        </div>
      </div>
      <div className="px-8 py-6 max-w-6xl mx-auto">{children}</div>
    </div>
  );
}
