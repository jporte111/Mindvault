import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { Zap, Download, ExternalLink, RefreshCw, TrendingUp, Clock } from 'lucide-react';
import { toast } from 'sonner';

const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };
const priorityColor = {
  High: 'bg-red-100 text-red-700 border-red-200',
  Medium: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  Low: 'bg-green-100 text-green-700 border-green-200',
};
const facingColor = {
  Internal: 'bg-slate-100 text-slate-700 border-slate-200',
  'Client-Facing': 'bg-blue-100 text-blue-700 border-blue-200',
  Both: 'bg-purple-100 text-purple-700 border-purple-200',
};

function FilterPill({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all border ${
        active ? 'bg-primary text-white border-primary' : 'bg-card text-muted-foreground border-border hover:border-primary/50 hover:text-foreground'
      }`}
    >
      {label}
    </button>
  );
}

export default function Roadmap() {
  const [filterPriority, setFilterPriority] = useState('All');
  const [filterFacing, setFilterFacing] = useState('All');
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const { data: trainings = [], isLoading } = useQuery({
    queryKey: ['trainings'],
    queryFn: () => base44.entities.Training.list('-created_date'),
  });

  const [refreshProgress, setRefreshProgress] = useState('');

  const handleRefreshMarketDemand = async () => {
    setRefreshing(true);
    setRefreshProgress('Starting market demand refresh...');
    toast.info('Refreshing market demand — checking external trends for each feature. This may take a few minutes...');
    try {
      let skip = 0;
      let totalUpdated = 0;
      let totalErrors = 0;
      let hasMore = true;

      while (hasMore) {
        const res = await base44.functions.invoke('updateRoadmapMarketDemand', { skip, limit: 2 });
        const data = res.data || res;
        totalUpdated += data.features_updated || 0;
        totalErrors += data.errors?.length || 0;
        hasMore = data.has_more;
        skip = data.next_skip || skip + 2;
        setRefreshProgress(`Updated ${totalUpdated} features so far...`);
        // Refresh the list as we go so progress is visible
        queryClient.invalidateQueries({ queryKey: ['trainings'] });
      }

      if (totalErrors > 0) {
        toast.warning(`Market demand refreshed for ${totalUpdated} features (${totalErrors} errors)`);
      } else {
        toast.success(`Market demand refreshed for ${totalUpdated} features`);
      }
      queryClient.invalidateQueries({ queryKey: ['trainings'] });
    } catch (err) {
      toast.error('Failed to refresh market demand: ' + (err?.message || 'Unknown error'));
    } finally {
      setRefreshing(false);
      setRefreshProgress('');
    }
  };

  // Flatten all features with their source training
  const allFeatures = trainings.flatMap(t =>
    (t.app_feature_opportunities || []).map(f => ({ ...f, trainingId: t.id, trainingTitle: t.title }))
  ).sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));

  const filtered = allFeatures.filter(f => {
    const matchesPriority = filterPriority === 'All' || f.priority === filterPriority;
    const matchesFacing = filterFacing === 'All' || f.facing === filterFacing || (filterFacing === 'Both' && f.facing === 'Both');
    return matchesPriority && matchesFacing;
  });

  const exportCSV = () => {
    const headers = ['Feature Name', 'Problem Solved', 'User Type', 'Required Inputs', 'Output', 'Facing', 'Priority', 'Source Training'];
    const rows = filtered.map(f => [
      f.feature_name, f.problem_solved, f.user_type, f.required_inputs, f.output, f.facing, f.priority, f.trainingTitle
    ].map(v => `"${(v || '').replace(/"/g, '""')}"`));
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'app-roadmap.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const counts = { High: 0, Medium: 0, Low: 0 };
  allFeatures.forEach(f => { if (counts[f.priority] !== undefined) counts[f.priority]++; });

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-card border-b border-border px-8 py-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Zap className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h1 className="font-sora text-2xl font-bold text-foreground">App Roadmap</h1>
                <p className="text-muted-foreground text-sm">{allFeatures.length} feature opportunities across {trainings.length} trainings</p>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                onClick={handleRefreshMarketDemand}
                disabled={refreshing || allFeatures.length === 0}
                size="sm"
                className="gap-2 text-xs bg-primary hover:bg-primary/90"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? (refreshProgress || 'Refreshing...') : 'Refresh Market Demand'}
              </Button>
              <Button onClick={exportCSV} variant="outline" size="sm" className="gap-2 text-xs">
                <Download className="w-3.5 h-3.5" />
                Export CSV
              </Button>
            </div>
          </div>

          {/* Stats */}
          <div className="flex gap-4 mt-5">
            {['High', 'Medium', 'Low'].map(p => (
              <div key={p} className={`px-4 py-2 rounded-xl border text-sm font-medium ${priorityColor[p]}`}>
                {counts[p]} {p}
              </div>
            ))}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-4 mt-5">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground font-medium">Priority</span>
              <div className="flex gap-1.5 flex-wrap">
                {['All', 'High', 'Medium', 'Low'].map(p => (
                  <FilterPill key={p} label={p} active={filterPriority === p} onClick={() => setFilterPriority(p)} />
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground font-medium">Facing</span>
              <div className="flex gap-1.5 flex-wrap">
                {['All', 'Internal', 'Client-Facing', 'Both'].map(f => (
                  <FilterPill key={f} label={f} active={filterFacing === f} onClick={() => setFilterFacing(f)} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Feature Cards */}
      <div className="px-8 py-6 max-w-5xl mx-auto">
        {isLoading ? (
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => <div key={i} className="h-36 rounded-2xl bg-muted animate-pulse" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <Zap className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
            <p className="text-muted-foreground font-medium">No features found</p>
            <p className="text-muted-foreground/60 text-sm mt-1">Upload trainings to generate app feature opportunities</p>
          </div>
        ) : (
          <div className="space-y-4">
            {filtered.map((feat, i) => (
              <div key={i} className="bg-card border border-border rounded-2xl p-5 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <h3 className="font-semibold text-foreground text-base">{feat.feature_name}</h3>
                  <div className="flex gap-2 flex-wrap">
                    <Badge className={`text-xs border ${priorityColor[feat.priority] || 'bg-muted text-muted-foreground'}`}>
                      {feat.priority} Priority
                    </Badge>
                    <Badge className={`text-xs border ${facingColor[feat.facing] || 'bg-muted text-muted-foreground'}`}>
                      {feat.facing}
                    </Badge>
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1.5">
                  <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Problem: </span>{feat.problem_solved}</p>
                  <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Users: </span>{feat.user_type}</p>
                  <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Inputs: </span>{feat.required_inputs}</p>
                  <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Output: </span>{feat.output}</p>
                </div>

                {/* Scoring */}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {[
                    { label: 'Internal Need', value: feat.internal_need_score },
                    { label: 'Market Demand', value: feat.market_demand_score },
                    { label: 'Business Value', value: feat.business_value_score },
                    { label: 'Complexity', value: feat.implementation_complexity_score },
                  ].map(s => (
                    <span key={s.label} className="px-2 py-0.5 rounded-md bg-muted text-xs text-muted-foreground border border-border">
                      {s.label}: <span className="font-semibold text-foreground">{s.value ?? '—'}/5</span>
                    </span>
                  ))}
                </div>

                {/* Market demand analysis */}
                {feat.market_demand_summary && (
                  <div className="rounded-xl bg-primary/5 border border-primary/20 p-3 space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                      <TrendingUp className="w-3.5 h-3.5" />
                      Market Demand Analysis
                    </div>
                    <p className="text-xs text-foreground leading-relaxed">{feat.market_demand_summary}</p>
                    {feat.market_signal_sources?.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {feat.market_signal_sources.map((src, i) => (
                          <span key={i} className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] border border-primary/20">
                            {src}
                          </span>
                        ))}
                      </div>
                    )}
                    {feat.last_market_check_date && (
                      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        Last checked {new Date(feat.last_market_check_date).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                )}

                {feat.priority_reason && (
                  <p className="text-xs text-muted-foreground italic">{feat.priority_reason}</p>
                )}

                <Link
                  to={`/training/${feat.trainingId}`}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
                >
                  <ExternalLink className="w-3 h-3" />
                  Source: {feat.trainingTitle}
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}