import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import EmptyState from '@/components/common/EmptyState';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import {
  Loader2, ShieldCheck, Users, ClipboardList, MessageCircleQuestion, ArrowRight, ExternalLink,
} from 'lucide-react';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';
import ConceptHelp from '@/components/onboarding/ConceptHelp';
import {
  fetchKnowledgeHealth, TONE, BAND_TONE, COVERAGE_TONE, CONTINUITY_TONE, KEYPERSON_TONE,
  TREND_TONE, TREND_STRIP_DIMENSIONS,
  fetchKnowledgeHealthTrendHistory, TREND_SERIES_LABELS, GOV_STATUS_TONE,
} from '@/lib/knowledgeHealth';
import { buildSparklinePath } from '@/lib/sparkline';

function Pill({ tone = 'muted', children }) {
  return <Badge variant="outline" className={`text-xs ${TONE[tone] || TONE.muted}`}>{children}</Badge>;
}

function BandCard({ title, band, label, caveat = null, help = null, tourId = null }) {
  return (
    <Card className="border-border" data-tour={tourId || undefined}>
      <CardContent className="py-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
          {title}
          {help && <ConceptHelp term={help} className="normal-case" />}
        </p>
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

// Phase 9 P9-1 — deterministic "since last period" strip. No chart, no score.
// Shows raw previous -> current with a direction word; deteriorating first.
function fmtTrendVal(v, kind) {
  if (v == null) return '—';
  if (kind === 'ratio') return `${v.covered}/${v.evaluable}`;
  return String(v);
}
function TrendStrip({ trend }) {
  if (!trend) return null; // snapshots flag off -> no trend key
  if (!trend.comparable) {
    return (
      <div className="rounded-xl border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
        Trend data starts after the next monthly snapshot.
      </div>
    );
  }
  const rows = TREND_STRIP_DIMENSIONS
    .map((d) => ({ ...d, ...(trend.dimensions?.[d.key] || {}) }))
    .filter((r) => r.direction);
  const changed = [
    ...rows.filter((r) => r.direction === 'deteriorating'),
    ...rows.filter((r) => r.direction === 'improving'),
    ...rows.filter((r) => r.direction === 'unknown' && r.previous != null),
  ];
  const stable = rows.filter((r) => r.direction === 'stable');
  const periods = trend.periods_elapsed && trend.periods_elapsed > 1 ? ` (${trend.periods_elapsed} periods)` : '';
  const tone = (dir) =>
    TREND_TONE[dir] === 'ok' ? 'text-emerald-600'
      : TREND_TONE[dir] === 'error' ? 'text-red-600' : 'text-muted-foreground';
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Since {trend.previous_period_key || 'last period'}{periods}
      </p>
      {changed.length === 0
        ? <p className="mt-1 text-xs text-muted-foreground">No material change since {trend.previous_period_key}.</p>
        : (
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {changed.map((r) => (
              <span key={r.key} className="text-xs">
                <span className="text-muted-foreground">{r.label} </span>
                <span className="font-medium text-foreground">
                  {fmtTrendVal(r.previous, r.kind)} → {fmtTrendVal(r.current, r.kind)}
                </span>{' '}
                <span className={tone(r.direction)}>{r.direction}</span>
              </span>
            ))}
          </div>
        )}
      {stable.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          No change: {stable.map((r) => r.label).join(' · ')}
        </p>
      )}
    </div>
  );
}

// Phase 9 P9-2 — compact multi-period sparklines over the existing snapshot
// history. Deterministic SVG, no chart library, no composite score. x positions
// come from the ACTUAL calendar-month offset and the path is BROKEN across any
// gap of more than one month — a missing snapshot is visually discontinuous,
// never interpolated or zero-filled. Geometry is the pure buildSparklinePath.
function Sparkline({ points, min, max }) {
  if (!points || points.length < 2) return <span className="text-[11px] text-muted-foreground">—</span>;
  const w = 88, h = 22, pad = 2;
  const { d, dots } = buildSparklinePath(points, { width: w, height: h, pad, min, max });
  return (
    <svg width={w} height={h} className="text-primary" aria-hidden>
      {d && <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
      {dots.map((pt) => (
        <circle key={pt.period_key} cx={pt.x.toFixed(1)} cy={pt.y.toFixed(1)} r="1.6" fill="currentColor" />
      ))}
    </svg>
  );
}

function TrendPanel({ history }) {
  if (!history) return null;
  const count = history.count || 0;
  if (count < 2) {
    return (
      <Card className="border-border" data-tour="continuity-trends">
        <CardContent className="py-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Trends</span> — a monthly snapshot records
          your continuity numbers so leadership can see whether things are improving or slipping.{' '}
          {count === 1
            ? 'One month captured so far — trends appear after the next monthly snapshot.'
            : 'No months captured yet. Turn on Knowledge Health Snapshots under Admin → System to start.'}
        </CardContent>
      </Card>
    );
  }
  const range = history.period_range;
  const series = (history.series || []).filter((s) => s.points && s.points.length >= 2);
  return (
    <Card className="border-border" data-tour="continuity-trends">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold flex items-center gap-1">
          Trends <ConceptHelp term="snapshot" /> <span className="text-xs font-normal text-muted-foreground">· {count} periods{range ? ` (${range.first} – ${range.last})` : ''}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
          {series.map((s) => {
            const dir = s.last < s.first ? 'improving' : s.last > s.first ? 'deteriorating' : 'stable';
            return (
              <div key={s.key} className="flex items-center justify-between gap-2 border-b border-border/50 py-1">
                <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">
                  {TREND_SERIES_LABELS[s.key] || s.key}
                </span>
                <span className="text-xs font-medium text-foreground tabular-nums">{s.first} → {s.last}</span>
                <span className={
                  dir === 'improving' ? 'text-[11px] text-emerald-600'
                    : dir === 'deteriorating' ? 'text-[11px] text-red-600' : 'text-[11px] text-muted-foreground'
                }>{dir}</span>
                <Sparkline points={s.points} min={s.min} max={s.max} />
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Deterministic counts from monthly snapshots for this scope only. Missing months are left blank — no estimate is drawn.
        </p>
      </CardContent>
    </Card>
  );
}

// Phase 9 P9-3 — compact deterministic "what changed" between the latest two
// persisted fingerprint-bearing monthly snapshots for this exact scope. No
// score, no prose, no prediction. Falls back to a plain message when there are
// fewer than two comparable periods or the fingerprint format changed.
function pl(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
function WhatChanged({ change, onProcesses, onGaps }) {
  if (!change || !change.continuity) return null;
  const c = change.continuity;
  const g = change.gaps || {};

  if (!c.comparable) {
    const msg = c.reason === 'version_changed'
      ? 'Change detection is unavailable this period because the snapshot format changed.'
      : c.reason === 'truncated'
        ? 'Change detection is unavailable this period (too many exposures to compare reliably).'
        : 'Period-over-period change needs at least two monthly snapshots.';
    return (
      <Card className="border-border">
        <CardContent className="py-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">What changed</span> — {msg}
        </CardContent>
      </Card>
    );
  }

  const cat = c.categories;
  const n = (x) => (x && typeof x.count === 'number' ? x.count : 0);
  const improved = [];
  const attention = [];
  const created = [];

  if (n(cat.atRisk.resolved)) improved.push([pl(n(cat.atRisk.resolved), 'process', 'processes') + ' moved out of At Risk', onProcesses]);
  if (n(cat.keyPerson.resolved)) improved.push([pl(n(cat.keyPerson.resolved), 'key-person dependency', 'key-person dependencies') + ' resolved', onProcesses]);
  if (n(cat.overdueReview.resolved)) improved.push([pl(n(cat.overdueReview.resolved), 'overdue review exposure', 'overdue review exposures') + ' cleared', onProcesses]);
  if (n(cat.criticalDocGap.resolved)) improved.push([pl(n(cat.criticalDocGap.resolved), 'critical documentation gap', 'critical documentation gaps') + ' resolved', onProcesses]);
  if (n(cat.governanceSetup.improved)) improved.push([pl(n(cat.governanceSetup.improved), 'governance setup improvement', 'governance setup improvements'), onProcesses]);
  if (g.comparable && n(g.resolvedSincePrior)) improved.push([pl(n(g.resolvedSincePrior), 'previously recurring gap', 'previously recurring gaps') + ' resolved', onGaps]);

  if (n(cat.atRisk.new)) {
    const k = n(cat.atRisk.newCritical);
    attention.push([pl(n(cat.atRisk.new), 'process', 'processes') + ' newly At Risk' + (k ? ` (${k} critical)` : ''), onProcesses]);
  }
  if (n(cat.keyPerson.new)) attention.push([pl(n(cat.keyPerson.new), 'newly exposed key-person dependency', 'newly exposed key-person dependencies'), onProcesses]);
  if (n(cat.overdueReview.new)) attention.push([pl(n(cat.overdueReview.new), 'newly overdue review exposure', 'newly overdue review exposures'), onProcesses]);
  if (n(cat.governanceSetup.regressed)) attention.push([pl(n(cat.governanceSetup.regressed), 'governance setup regression', 'governance setup regressions'), onProcesses]);
  if (g.comparable && n(g.frequencyRises)) attention.push([pl(n(g.frequencyRises), 'gap', 'gaps') + ' increased in frequency', onGaps]);
  if (g.comparable && g.longUnresolved?.state === 'known' && g.longUnresolved.items.length) {
    attention.push([pl(g.longUnresolved.items.length, 'recurring gap', 'recurring gaps') + ` unresolved since ${g.longUnresolved.items[0].since}`, onGaps]);
  }

  if (n(cat.criticalDocGap.new)) created.push([pl(n(cat.criticalDocGap.new), 'new critical documentation gap', 'new critical documentation gaps'), onProcesses]);
  if (g.comparable && n(g.newlyPromoted)) created.push([pl(n(g.newlyPromoted), 'recurring gap', 'recurring gaps') + ' reached actionable threshold', onGaps]);

  const periods = c.periods_elapsed && c.periods_elapsed > 1 ? ` (${c.periods_elapsed} periods)` : '';
  const nothing = !improved.length && !attention.length && !created.length;

  const Group = ({ title, items, tone }) => items.length ? (
    <div className="space-y-1">
      <p className={`text-xs font-semibold uppercase tracking-wide ${tone}`}>{title}</p>
      <ul className="space-y-0.5">
        {items.map(([text, onClick], i) => (
          <li key={i}>
            <button onClick={onClick} className="text-sm text-foreground text-left hover:underline">{text}</button>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold flex items-center gap-1">
          What changed <ConceptHelp term="what_changed" /> <span className="text-xs font-normal text-muted-foreground">· since {c.previous_period_key || 'the prior period'}{periods}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {nothing
          ? <p className="text-sm text-muted-foreground">No material continuity or gap changes since {c.previous_period_key}.</p>
          : <>
            <Group title="Improved" items={improved} tone="text-emerald-700" />
            <Group title="Needs attention" items={attention} tone="text-red-700" />
            <Group title="New" items={created} tone="text-muted-foreground" />
          </>}
        {!g.comparable && (
          <p className="text-[11px] text-muted-foreground">
            Gap-level change {g.reason === 'version_changed' ? 'unavailable (format changed)' : g.reason === 'truncated' ? 'unavailable (too many gaps)' : 'needs two comparable monthly snapshots'}.
          </p>
        )}
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

// "What should I do next?" — a link into an existing governed workflow, or a
// button that opens this process's detail drawer. The dashboard never mutates
// lifecycle state itself.
function ActionLink({ action, onOpenProcess }) {
  if (!action) return null;
  if (action.href) {
    return (
      <Link to={action.href} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline whitespace-nowrap">
        {action.label} <ExternalLink className="w-3 h-3" />
      </Link>
    );
  }
  if (action.processId) {
    return (
      <button
        onClick={() => onOpenProcess(action.processId)}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline whitespace-nowrap"
      >
        {action.label} <ArrowRight className="w-3 h-3" />
      </button>
    );
  }
  return null;
}

function FilterSelect({ value, onChange, options, allLabel }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-lg border border-border bg-background px-2 text-xs"
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'processes', label: 'Process Continuity' },
  { id: 'governance', label: 'Governance' },
  { id: 'queue', label: 'Review Queue' },
  { id: 'people', label: 'Key-Person Exposure' },
  { id: 'gaps', label: 'Knowledge Gaps' },
];

const CRITICALITY_OPTS = [
  { value: 'mission_critical', label: 'mission critical' },
  { value: 'high', label: 'high' },
  { value: 'medium', label: 'medium' },
  { value: 'low', label: 'low' },
];
const CONTINUITY_OPTS = [
  { value: 'at_risk', label: 'At risk' },
  { value: 'not_documented', label: 'Not documented' },
  { value: 'needs_setup', label: 'Needs setup' },
  { value: 'ready', label: 'Ready' },
];
const KEYPERSON_OPTS = [
  { value: 'critical', label: 'Critical key-person dependency' },
  { value: 'high', label: 'High key-person dependency' },
  { value: 'elevated', label: 'Elevated dependency' },
  { value: 'informational', label: 'Minor dependency' },
  { value: 'none', label: 'No single-person dependency' },
  { value: 'unknown', label: 'Dependency risk unknown' },
];

export default function Continuity() {
  const isAdmin = useIsAdmin();
  const { knowledgeHealthEnabled } = useSystemConfig();

  // Onboarding-1: record that an admin has opened the dashboard, so the setup
  // checklist's "Continuity dashboard reviewed" item can complete. Never proven
  // by a snapshot existing — only by an actual visit.
  useEffect(() => {
    if (isAdmin && knowledgeHealthEnabled) {
      try {
        localStorage.setItem('mv_continuity_visited', 'true');
      } catch {
        /* ignore */
      }
    }
  }, [isAdmin, knowledgeHealthEnabled]);

  const [tab, setTab] = useState('overview');
  const [scope, setScope] = useState('general');
  const [detailProcessId, setDetailProcessId] = useState(null);

  // Process Continuity filters (client-side, over the already-scoped payload)
  const [fDept, setFDept] = useState('');
  const [fCrit, setFCrit] = useState('');
  const [fOwner, setFOwner] = useState('');
  const [fState, setFState] = useState('');
  const [fKeyPerson, setFKeyPerson] = useState('');
  // Review Queue filters
  const [qType, setQType] = useState('');
  const [qCrit, setQCrit] = useState('');
  const [qDept, setQDept] = useState('');

  const openProcess = (id) => { setDetailProcessId(id); };

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
  // Phase 9 P9-2 — bounded multi-period history for the trend panel. Exact scope.
  const { data: history } = useQuery({
    queryKey: ['knowledge-health-history', scope],
    queryFn: () => fetchKnowledgeHealthTrendHistory(scope, 12),
    enabled: isAdmin && knowledgeHealthEnabled,
  });

  const sortedRows = useMemo(() => {
    const r = [...(data?.processRows || [])];
    const order = { at_risk: 0, not_documented: 1, needs_setup: 2, ready: 3 };
    const crit = { mission_critical: 0, high: 1, medium: 2, low: 3 };
    return r.sort((a, b) =>
      (order[a.continuityState] - order[b.continuityState]) ||
      ((crit[a.criticality] ?? 4) - (crit[b.criticality] ?? 4)) ||
      String(a.name).localeCompare(b.name));
  }, [data]);

  const deptOpts = useMemo(() => {
    const s = new Set((data?.processRows || []).map((r) => r.department).filter(Boolean));
    return [...s].sort().map((d) => ({ value: d, label: d }));
  }, [data]);
  const ownerOpts = useMemo(() => {
    const m = new Map();
    for (const r of data?.processRows || []) if (r.owner?.id) m.set(r.owner.id, r.owner.name || r.owner.id);
    return [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([value, label]) => ({ value, label }));
  }, [data]);
  const queueTypeOpts = useMemo(() => {
    const m = new Map();
    for (const it of data?.reviewQueue || []) if (!m.has(it.kind)) m.set(it.kind, it.label);
    return [...m.entries()].map(([value, label]) => ({ value, label }));
  }, [data]);
  const queueDeptOpts = useMemo(() => {
    const s = new Set((data?.reviewQueue || []).map((it) => it.department).filter(Boolean));
    return [...s].sort().map((d) => ({ value: d, label: d }));
  }, [data]);

  const filteredRows = useMemo(() => sortedRows.filter((r) =>
    (!fDept || r.department === fDept) &&
    (!fCrit || r.criticality === fCrit) &&
    (!fOwner || r.owner?.id === fOwner) &&
    (!fState || r.continuityState === fState) &&
    (!fKeyPerson || r.keyPersonLevel === fKeyPerson)
  ), [sortedRows, fDept, fCrit, fOwner, fState, fKeyPerson]);

  const filteredQueue = useMemo(() => (data?.reviewQueue || []).filter((it) =>
    (!qType || it.kind === qType) &&
    (!qCrit || it.criticality === qCrit) &&
    (!qDept || it.department === qDept)
  ), [data, qType, qCrit, qDept]);

  const detailRow = useMemo(
    () => (data?.processRows || []).find((r) => r.id === detailProcessId) || null,
    [data, detailProcessId],
  );

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
                {data.setup.legacyNeedingReindex > 0 && <p>{data.setup.legacyNeedingReindex} legacy knowledge sources still need re-indexing before their documentation status can be confirmed.</p>}
                {data.setup.unclassifiedItems > 0 && <p>{data.setup.unclassifiedItems} items are awaiting classification.</p>}
              </CardContent>
            </Card>
          )}

          {/* Phase 9 P9-1 — single-period trend strip (present when snapshots flag is on) */}
          <TrendStrip trend={data.trend} />
          {/* Phase 9 P9-2 — multi-period trend panel over the snapshot history */}
          <TrendPanel history={history} />
          {/* Phase 9 P9-3 — persisted-period vs prior-period executive change summary */}
          <WhatChanged
            change={data.change}
            onProcesses={() => setTab('processes')}
            onGaps={() => setTab('gaps')}
          />

          {/* Snapshot */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-tour="continuity-overview">
            <BandCard title="Coverage" band={data.snapshot.coverage.band} label={data.snapshot.coverage.label} help="coverage" tourId="continuity-coverage" />
            <BandCard title="Currency" band={data.snapshot.currency.band} label={data.snapshot.currency.label} help="currency" />
            <BandCard title="Verification" band={data.snapshot.verification.band} label={data.snapshot.verification.label} caveat={data.snapshot.verification.caveat} help="verification" tourId="continuity-verification" />
            <BandCard title="Key-person resilience" band={data.snapshot.keyPersonResilience.band} label={data.snapshot.keyPersonResilience.label} help="key_person" tourId="continuity-keyperson" />
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
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-foreground">{it.label}{it.title ? ` — ${it.title}` : ''}</span>
                        {it.rationale && <span className="block text-[11px] text-muted-foreground mt-0.5">Why: {it.rationale}</span>}
                      </span>
                      {it.criticality && <Pill tone="muted">{it.criticality.replace('_', ' ')}</Pill>}
                      <ActionLink action={it.action} onOpenProcess={openProcess} />
                    </div>
                  ))}
                </div>}
            </CardContent>
          </Card>
        </div>
      )}

      {data && tab === 'processes' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <FilterSelect value={fDept} onChange={setFDept} options={deptOpts} allLabel="All departments" />
            <FilterSelect value={fCrit} onChange={setFCrit} options={CRITICALITY_OPTS} allLabel="All criticalities" />
            <FilterSelect value={fOwner} onChange={setFOwner} options={ownerOpts} allLabel="All owners" />
            <FilterSelect value={fState} onChange={setFState} options={CONTINUITY_OPTS} allLabel="All states" />
            <FilterSelect value={fKeyPerson} onChange={setFKeyPerson} options={KEYPERSON_OPTS} allLabel="All key-person levels" />
            {(fDept || fCrit || fOwner || fState || fKeyPerson) && (
              <button onClick={() => { setFDept(''); setFCrit(''); setFOwner(''); setFState(''); setFKeyPerson(''); }}
                className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground">Clear</button>
            )}
            <span className="ml-auto text-xs text-muted-foreground self-center">{filteredRows.length} of {sortedRows.length} processes</span>
          </div>
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
                    <th className="px-4 py-2">State <ConceptHelp term="continuity_exposure" /></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((r) => (
                    <tr key={r.id} onClick={() => openProcess(r.id)} className="border-b border-border/60 cursor-pointer hover:bg-muted/40">
                      <td className="px-4 py-2.5 font-medium text-foreground">{r.name}<span className="block text-[11px] text-muted-foreground font-normal">{r.department || '—'}</span></td>
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
                  {filteredRows.length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">No processes match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}

      {data && tab === 'governance' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Each process against the governance basics already tracked in the product. Missing data is shown as
            missing / needs attention / unknown — never assumed bad. No new health rules.
          </p>
          <Card className="border-border">
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="px-4 py-2">Process</th>
                    <th className="px-4 py-2">Criticality</th>
                    <th className="px-4 py-2">Owner</th>
                    <th className="px-4 py-2">SME</th>
                    <th className="px-4 py-2">Review cadence</th>
                    <th className="px-4 py-2">Coverage</th>
                    <th className="px-4 py-2">Verification</th>
                    <th className="px-4 py-2">Backup / key-person</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r) => {
                    const g = r.governance || {};
                    const cell = (c) => c
                      ? <Pill tone={GOV_STATUS_TONE[c.status] || 'muted'}>{c.label}</Pill>
                      : <span className="text-muted-foreground">—</span>;
                    return (
                      <tr key={r.id} onClick={() => openProcess(r.id)} className="border-b border-border/60 cursor-pointer hover:bg-muted/40">
                        <td className="px-4 py-2.5 font-medium text-foreground">{r.name}</td>
                        <td className="px-4 py-2.5">{g.criticality || (r.criticality ? r.criticality.replace('_', ' ') : 'Not set')}</td>
                        <td className="px-4 py-2.5">{cell(g.owner)}</td>
                        <td className="px-4 py-2.5">{cell(g.sme)}</td>
                        <td className="px-4 py-2.5">{cell(g.reviewCadence)}</td>
                        <td className="px-4 py-2.5">{cell(g.coverage)}</td>
                        <td className="px-4 py-2.5">{cell(g.verification)}</td>
                        <td className="px-4 py-2.5">{cell(g.backupKeyPerson)}</td>
                      </tr>
                    );
                  })}
                  {sortedRows.length === 0 && (
                    <tr><td colSpan={8} className="p-0">
                      <EmptyState
                        title="No operational processes yet"
                        body="Operational processes are the workflows the business runs on. Add the 3–5 you could least afford to lose, then give each one an owner and a subject-matter expert."
                        action={{ label: 'Add a process in Admin', href: '/admin' }}
                      />
                    </td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}

      {data && tab === 'queue' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <FilterSelect value={qType} onChange={setQType} options={queueTypeOpts} allLabel="All item types" />
            <FilterSelect value={qCrit} onChange={setQCrit} options={CRITICALITY_OPTS} allLabel="All criticalities" />
            <FilterSelect value={qDept} onChange={setQDept} options={queueDeptOpts} allLabel="All departments" />
            {(qType || qCrit || qDept) && (
              <button onClick={() => { setQType(''); setQCrit(''); setQDept(''); }}
                className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground">Clear</button>
            )}
            <span className="ml-auto text-xs text-muted-foreground self-center">{filteredQueue.length} of {(data.reviewQueue || []).length} items</span>
          </div>
          <Card className="border-border">
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {filteredQueue.map((it) => (
                  <div key={it.id} className="px-5 py-3 flex items-center gap-3">
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-foreground">
                        {it.label}{it.title ? ` — ${it.title}` : ''}
                        {it.department && <span className="text-[11px] text-muted-foreground"> · {it.department}</span>}
                      </span>
                      {it.rationale && <span className="block text-[11px] text-muted-foreground mt-0.5">Why: {it.rationale}</span>}
                    </span>
                    {it.criticality && <Pill tone="muted">{it.criticality.replace('_', ' ')}</Pill>}
                    <ActionLink action={it.action} onOpenProcess={openProcess} />
                  </div>
                ))}
                {filteredQueue.length === 0 && <p className="px-5 py-6 text-sm text-muted-foreground">{(data.reviewQueue || []).length === 0 ? 'Queue is clear.' : 'No items match these filters.'}</p>}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {data && tab === 'people' && (
        <div className="space-y-3">
          {(data.keyPersonExposure || []).length === 0
            ? <EmptyState
                title="No key-person dependencies found"
                body="No critical process currently depends on one identifiable person with no backup. This is about keeping the business resilient — assign backup SMEs on your critical processes to keep it that way."
              />
            : (data.keyPersonExposure || []).map((p) => (
              <Card key={p.userId} className="border-border">
                <CardContent className="py-3">
                  <p className="text-sm font-medium text-foreground flex items-center gap-2">
                    <Users className="w-4 h-4 text-primary" /> {p.name}
                    {p.concentration && <Pill tone="error">sole expert on multiple critical processes</Pill>}
                  </p>
                  <ul className="mt-1 text-xs text-muted-foreground list-disc pl-6">
                    {p.processes.map((pr) => (
                      <li key={pr.id}>
                        <button className="hover:underline" onClick={() => openProcess(pr.id)}>{pr.name}</button>
                        {pr.criticality ? ` (${pr.criticality.replace('_', ' ')})` : ''} — {pr.role.replace('_', ' ')}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
        </div>
      )}

      {data && tab === 'gaps' && (
        <div className="space-y-5">
          <div className="flex items-center gap-1.5">
            <h2 className="text-sm font-semibold text-foreground">Knowledge gaps</h2>
            <ConceptHelp term="knowledge_gap" />
          </div>
          <p className="text-xs text-muted-foreground">{data.gapInvariantNote}</p>
          {[
            { key: 'open', title: 'Open', match: (g) => g.state === 'open' },
            { key: 'under_review', title: 'Under review', match: (g) => g.state === 'under_review' },
            { key: 'candidate', title: 'Watching', match: (g) => g.state === 'candidate' },
          ].map(({ key, title, match }) => {
            const bucket = (data.gaps || []).filter(match);
            if (bucket.length === 0) return null;
            return (
              <div key={key} className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {title} ({bucket.length}){key === 'candidate' && ' — accruing evidence, not yet actionable'}
                </p>
                {bucket.map((g) => (
                  <Card key={g.id} className="border-border">
                    <CardContent className="py-3">
                      <p className="text-sm font-medium text-foreground flex items-center gap-2 flex-wrap">
                        <MessageCircleQuestion className="w-4 h-4 text-primary shrink-0" /> {g.title}
                        <Pill tone={g.state === 'open' ? 'warn' : g.state === 'under_review' ? 'info' : 'muted'}>
                          {g.promoted ? 'Confirmed pattern' : title}
                        </Pill>
                        {g.processName && (
                          <button className="text-xs text-primary hover:underline" onClick={() => openProcess(g.processId)}>{g.processName}</button>
                        )}
                        {g.hasUnresolvedClarification && <Pill tone="info">clarification open</Pill>}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Asked {g.timesAsked}× by {g.distinctReporters} {g.distinctReporters === 1 ? 'person' : 'people'}
                        {g.ageDays != null && ` · first seen ${g.ageDays}d ago`}
                        {g.relatedSourceCount ? ` · ${g.relatedSourceCount} related source${g.relatedSourceCount === 1 ? '' : 's'}` : ''}
                        {g.missingFacets?.length ? ` · missing: ${g.missingFacets.join(', ')}` : ''}
                      </p>
                      {g.relatedSourceTitles?.length > 0 && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">Related: {g.relatedSourceTitles.join('; ')}</p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            );
          })}
          {(data.gaps || []).length === 0 && <p className="text-sm text-muted-foreground">No knowledge gaps.</p>}
        </div>
      )}

      {/* Process Detail drawer */}
      <Sheet open={!!detailRow} onOpenChange={(o) => { if (!o) setDetailProcessId(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          {detailRow && (
            <>
              <SheetHeader>
                <SheetTitle className="pr-8">{detailRow.name}</SheetTitle>
              </SheetHeader>
              <div className="mt-4 space-y-5 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Pill tone="muted">{detailRow.department || 'No department'}</Pill>
                  <Pill tone="muted">{detailRow.criticality ? detailRow.criticality.replace('_', ' ') : 'criticality not set'}</Pill>
                  <Pill tone={CONTINUITY_TONE[detailRow.continuityState]}>{detailRow.continuityLabel}</Pill>
                </div>
                {detailRow.detail?.description && (
                  <p className="text-muted-foreground">{detailRow.detail.description}</p>
                )}

                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><p className="text-muted-foreground">Owner</p><p className="font-medium">{detailRow.owner?.name || 'Not assigned'}</p></div>
                  <div><p className="text-muted-foreground">SME</p><p className="font-medium">{detailRow.sme?.name || 'Not assigned'}</p></div>
                  <div><p className="text-muted-foreground">Backup SME</p><p className="font-medium">{detailRow.backup?.name || 'None'}</p></div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div><p className="text-muted-foreground">Documentation</p><p className="font-medium">{detailRow.coverageLabel}</p></div>
                  <div><p className="text-muted-foreground">Review status</p><p className="font-medium">{detailRow.freshnessLabel}</p></div>
                </div>

                {/* Key-person finding */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Key-person dependency</p>
                  <Pill tone={KEYPERSON_TONE[detailRow.keyPersonLevel]}>{detailRow.keyPersonLabel}</Pill>
                  {detailRow.detail?.keyPersonReasons?.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                      {detailRow.detail.keyPersonReasons.map((reason, i) => <li key={i}>{reason}</li>)}
                    </ul>
                  )}
                  {detailRow.keyPersonPersons?.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {detailRow.keyPersonPersons.map((x) => `${x.name} (${x.role.replace('_', ' ')})`).join(', ')}
                    </p>
                  )}
                </div>

                {/* Linked sources */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                    Linked governed sources ({detailRow.detail?.linkedSources?.length || 0})
                  </p>
                  {(detailRow.detail?.linkedSources || []).length === 0
                    ? <p className="text-xs text-muted-foreground">No knowledge sources linked to this process.</p>
                    : <ul className="space-y-2">
                      {detailRow.detail.linkedSources.map((s) => (
                        <li key={s.id} className="rounded-lg border border-border p-2">
                          <Link to={`/training/${s.id}`} className="text-xs font-medium text-primary hover:underline inline-flex items-center gap-1">
                            {s.title} <ExternalLink className="w-3 h-3" />
                          </Link>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{s.documentationStatus} · {s.verification} · {s.freshnessLabel} · {s.effectiveLabel}</p>
                        </li>
                      ))}
                    </ul>}
                </div>

                {/* Open gaps */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                    Open knowledge gaps ({detailRow.detail?.openGaps?.length || 0})
                  </p>
                  {(detailRow.detail?.openGaps || []).length === 0
                    ? <p className="text-xs text-muted-foreground">None.</p>
                    : <ul className="space-y-1 text-xs text-muted-foreground">
                      {detailRow.detail.openGaps.map((g) => (
                        <li key={g.id}>
                          {g.title} — asked {g.timesAsked}× by {g.distinctReporters} {g.distinctReporters === 1 ? 'person' : 'people'}
                          {g.promoted && ' · confirmed pattern'}
                          {g.missingFacets?.length ? ` · missing: ${g.missingFacets.join(', ')}` : ''}
                        </li>
                      ))}
                    </ul>}
                </div>

                {/* Clarifications */}
                <div className="text-xs text-muted-foreground">
                  Clarification threads: {detailRow.detail?.clarifications?.total || 0}
                  {detailRow.detail?.clarifications?.awaitingEmployee ? ` (${detailRow.detail.clarifications.awaitingEmployee} waiting on the employee)` : ''}
                </div>

                {/* Recommended next actions */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Recommended next actions</p>
                  {(detailRow.detail?.recommendedActions || []).length === 0
                    ? <p className="text-xs text-muted-foreground">Nothing outstanding for this process.</p>
                    : <ul className="space-y-1">
                      {detailRow.detail.recommendedActions.map((a, i) => (
                        <li key={i}>
                          {a.href
                            ? <Link to={a.href} className="text-xs text-primary hover:underline inline-flex items-center gap-1">{a.label} <ExternalLink className="w-3 h-3" /></Link>
                            : <span className="text-xs text-foreground">{a.label}</span>}
                        </li>
                      ))}
                    </ul>}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
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