import { useState } from 'react';
import { useHashScroll } from '@/hooks/useHashScroll';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { 
  RefreshCw, Trash2, CheckCircle2, AlertCircle, 
  Clock, BookOpen, Settings, Cloud, Zap, Download, ExternalLink
} from 'lucide-react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import UploadTraining from '@/components/admin/UploadTraining';
import KnowledgeScopeManager from '@/components/admin/KnowledgeScopeManager';
import KnowledgeLifecyclePanel from '@/components/admin/KnowledgeLifecyclePanel';
import OperationalProcessManager from '@/components/admin/OperationalProcessManager';
import ChatEngineToggle from '@/components/admin/ChatEngineToggle';
import AnswerLogInspector from '@/components/admin/AnswerLogInspector';
import KnowledgeGapManager from '@/components/admin/KnowledgeGapManager';
import ClarificationQueue from '@/components/admin/ClarificationQueue';
import ClientSelect from '@/components/knowledge/ClientSelect';
import SetupChecklist from '@/components/onboarding/SetupChecklist';
import EmptyState from '@/components/common/EmptyState';
import { SCOPE_GENERAL, SCOPE_UNCLASSIFIED } from '@/lib/knowledgeScope';

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

export default function Admin() {
  // Checklist action links navigate to /admin#<section-id>. When arriving from
  // another page, scroll the referenced section into view.
  useHashScroll();

  const [activeTab, setActiveTab] = useState('content');
  const [folderId, setFolderId] = useState('');
  const [syncScope, setSyncScope] = useState(SCOPE_UNCLASSIFIED);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [filterPriority, setFilterPriority] = useState('All');
  const [filterFacing, setFilterFacing] = useState('All');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState('');

  const queryClient = useQueryClient();

  const { data: trainings = [], isLoading } = useQuery({
    queryKey: ['all-trainings'],
    queryFn: () => base44.entities.Training.list('-created_date'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Training.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
      queryClient.invalidateQueries({ queryKey: ['trainings'] });
      toast.success('Training deleted');
    },
    onError: (err) => toast.error('Failed to delete: ' + err.message),
  });

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    const scopeArg = syncScope === SCOPE_GENERAL
      ? { scope: 'general' }
      : syncScope.startsWith('client:')
        ? { clientId: syncScope.slice('client:'.length) }
        : {};
    const res = await base44.functions.invoke('syncFromDrive', { folderId: folderId.trim() || undefined, ...scopeArg });
    setSyncResult(res.data);
    setSyncing(false);
    if (res.data.synced > 0) {
      queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
      queryClient.invalidateQueries({ queryKey: ['trainings'] });
      toast.success(`Synced ${res.data.synced} new knowledge source${res.data.synced === 1 ? '' : 's'}!`);
    } else {
      toast.info('No new knowledge sources found.');
    }
  };

  const statusConfig = {
    ready: { icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50 border-green-200', label: 'Ready' },
    processing: { icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200', label: 'Processing' },
    error: { icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-50 border-red-200', label: 'Error' },
  };

  const stats = {
    total: trainings.length,
    ready: trainings.filter(t => t.status === 'ready').length,
    processing: trainings.filter(t => t.status === 'processing').length,
  };

  const allFeatures = trainings.flatMap(t =>
    (t.app_feature_opportunities || []).map(f => ({ ...f, trainingId: t.id, trainingTitle: t.title }))
  ).sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));

  const filteredFeatures = allFeatures.filter(f => {
    const matchesPriority = filterPriority === 'All' || f.priority === filterPriority;
    const matchesFacing = filterFacing === 'All' || f.facing === filterFacing;
    return matchesPriority && matchesFacing;
  });

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
        queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
        queryClient.invalidateQueries({ queryKey: ['trainings'] });
      }

      if (totalErrors > 0) {
        toast.warning(`Market demand refreshed for ${totalUpdated} features (${totalErrors} errors)`);
      } else {
        toast.success(`Market demand refreshed for ${totalUpdated} features`);
      }
      queryClient.invalidateQueries({ queryKey: ['all-trainings'] });
      queryClient.invalidateQueries({ queryKey: ['trainings'] });
    } catch (err) {
      toast.error('Failed to refresh market demand: ' + (err?.message || 'Unknown error'));
    } finally {
      setRefreshing(false);
      setRefreshProgress('');
    }
  };

  const exportRoadmapCSV = () => {
    const headers = ['Feature Name', 'Problem Solved', 'User Type', 'Required Inputs', 'Output', 'Facing', 'Priority', 'Internal Need Score', 'Market Demand Score', 'Business Value Score', 'Implementation Complexity Score', 'Priority Reason', 'Source Training'];
    const rows = filteredFeatures.map(f => [
      f.feature_name, f.problem_solved, f.user_type, f.required_inputs, f.output, f.facing, f.priority,
      f.internal_need_score, f.market_demand_score, f.business_value_score, f.implementation_complexity_score,
      f.priority_reason, f.trainingTitle
    ].map(v => `"${(v != null ? v : '').toString().replace(/"/g, '""')}"`));
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'app-roadmap.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const tabs = [
    { id: 'content', label: 'Content Management', icon: Settings },
    { id: 'roadmap', label: 'App Roadmap', icon: Zap },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-card border-b border-border px-8 py-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Settings className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h1 className="font-sora text-2xl font-bold text-foreground">Admin Panel</h1>
              <p className="text-muted-foreground text-sm">Manage your knowledge base content</p>
            </div>
          </div>
          {/* Tabs */}
          <div className="flex gap-1 bg-muted p-1 rounded-xl w-fit">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Roadmap Tab */}
      {activeTab === 'roadmap' && (
        <div className="px-8 py-8 max-w-5xl mx-auto space-y-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <p className="text-muted-foreground text-sm">{allFeatures.length} feature opportunities across {trainings.length} trainings</p>
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
              <Button onClick={exportRoadmapCSV} variant="outline" size="sm" className="gap-2 text-xs">
                <Download className="w-3.5 h-3.5" />
                Export CSV
              </Button>
            </div>
          </div>

          {/* Priority stats */}
          <div className="flex gap-3 flex-wrap">
            {['High', 'Medium', 'Low'].map(p => {
              const count = allFeatures.filter(f => f.priority === p).length;
              return (
                <div key={p} className={`px-4 py-2 rounded-xl border text-sm font-medium ${priorityColor[p]}`}>
                  {count} {p}
                </div>
              );
            })}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground font-medium">Priority</span>
              <div className="flex gap-1.5 flex-wrap">
                {['All', 'High', 'Medium', 'Low'].map(p => (
                  <button key={p} onClick={() => setFilterPriority(p)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all border ${filterPriority === p ? 'bg-primary text-white border-primary' : 'bg-card text-muted-foreground border-border hover:border-primary/50'}`}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground font-medium">Facing</span>
              <div className="flex gap-1.5 flex-wrap">
                {['All', 'Internal', 'Client-Facing', 'Both'].map(f => (
                  <button key={f} onClick={() => setFilterFacing(f)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all border ${filterFacing === f ? 'bg-primary text-white border-primary' : 'bg-card text-muted-foreground border-border hover:border-primary/50'}`}>
                    {f}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Feature cards */}
          {filteredFeatures.length === 0 ? (
            <div className="text-center py-16">
              <Zap className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-muted-foreground">No features found. Upload trainings to generate roadmap items.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredFeatures.map((feat, i) => (
                <div key={i} className="bg-card border border-border rounded-2xl p-5 space-y-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <h3 className="font-semibold text-foreground text-base">{feat.feature_name}</h3>
                    <div className="flex gap-2 flex-wrap">
                      <Badge className={`text-xs border ${priorityColor[feat.priority] || 'bg-muted text-muted-foreground'}`}>{feat.priority} Priority</Badge>
                      <Badge className={`text-xs border ${facingColor[feat.facing] || 'bg-muted text-muted-foreground'}`}>{feat.facing}</Badge>
                    </div>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1.5">
                    <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Problem: </span>{feat.problem_solved}</p>
                    <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Users: </span>{feat.user_type}</p>
                    <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Inputs: </span>{feat.required_inputs}</p>
                    <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Output: </span>{feat.output}</p>
                  </div>

                  {/* Scoring */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { label: 'Internal Need', value: feat.internal_need_score },
                      { label: 'Market Demand', value: feat.market_demand_score },
                      { label: 'Business Value', value: feat.business_value_score },
                      { label: 'Complexity', value: feat.implementation_complexity_score },
                    ].map(({ label, value }) => (
                      <div key={label} className="bg-muted/50 rounded-lg px-2.5 py-1.5 text-center">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">{label}</p>
                        <p className="text-sm font-bold text-foreground">{value != null ? `${value}/5` : '—'}</p>
                      </div>
                    ))}
                  </div>

                  {feat.priority_reason && (
                    <p className="text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg px-3 py-2">
                      <span className="font-medium text-foreground">Priority Reason: </span>{feat.priority_reason}
                    </p>
                  )}

                  <Link to={`/training/${feat.trainingId}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <ExternalLink className="w-3 h-3" />
                    Source: {feat.trainingTitle}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Content Management Tab */}
      {activeTab === 'content' && (
      <div className="px-8 py-8 max-w-5xl mx-auto space-y-6">
        {/* Onboarding-1: derived setup checklist (admin-only, never blocking) */}
        <SetupChecklist />

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Total knowledge sources', value: stats.total, icon: BookOpen },
            { label: 'Ready', value: stats.ready, icon: CheckCircle2 },
            { label: 'Processing', value: stats.processing, icon: Clock },
          ].map(({ label, value, icon: Icon }) => (
            <Card key={label} className="border-border">
              <CardContent className="p-5 flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Icon className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-sora font-bold text-foreground">{value}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Upload Card */}
        <div data-tour="knowledge-management">
          <UploadTraining />
        </div>

        {/* Operational processes: governance owner of knowledge sources */}
        <div id="admin-processes" className="scroll-mt-6">
          <OperationalProcessManager />
        </div>

        {/* RAG knowledge scope: clients, needs-review queue, re-index */}
        <div id="admin-classify" className="scroll-mt-6">
          <KnowledgeScopeManager />
        </div>

        {/* Phase 6: governed versioning / review / publishing (flag-gated) */}
        <div id="admin-verification" className="scroll-mt-6">
          <KnowledgeLifecyclePanel />
        </div>

        {/* Chatbot engine flag (legacy vs RAG) + rollout + Phase 3 governance flags */}
        <div id="admin-system" className="scroll-mt-6">
          <ChatEngineToggle />
        </div>

        {/* Phase 3 observability: read-only recent AI answers (admin only) */}
        <AnswerLogInspector />

        {/* Phase 5: knowledge gaps + clarification queue (flag-gated, render null when off) */}
        <KnowledgeGapManager />
        <ClarificationQueue />

        {/* Sync Card */}
        <Card className="border-border">
          <CardHeader className="pb-4">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Cloud className="w-4 h-4 text-primary" />
              Sync from Google Drive
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm text-muted-foreground mb-2 block">
                Google Drive Folder ID (optional — leave blank to search all transcript files)
              </Label>
              <Input
                value={folderId}
                onChange={e => setFolderId(e.target.value)}
                placeholder="e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs"
                className="font-mono text-sm bg-background"
              />
              <p className="text-xs text-muted-foreground/70 mt-1.5">
                Find your folder ID in the Google Drive URL: drive.google.com/drive/folders/<strong>FOLDER_ID</strong>
              </p>
            </div>

            <div>
              <Label className="text-sm text-muted-foreground mb-2 block">
                Knowledge scope for everything synced in this run
              </Label>
              <ClientSelect value={syncScope} onChange={setSyncScope} disabled={syncing} />
              <p className="text-xs text-muted-foreground/70 mt-1.5">
                "Needs review" (default) keeps synced trainings out of the chatbot until you classify them below.
              </p>
            </div>

            <Button
              onClick={handleSync}
              disabled={syncing}
              className="bg-primary hover:bg-primary/90 shadow-md shadow-primary/20 gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync Now'}
            </Button>

            {syncResult && (
              <div className={`p-4 rounded-xl border text-sm ${syncResult.error ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-700'}`}>
                {syncResult.error ? (
                  <p>Error: {syncResult.error}</p>
                ) : (
                  <p>
                    ✓ Synced <strong>{syncResult.synced}</strong> new knowledge source(s) ·
                    Skipped <strong>{syncResult.skipped}</strong> already-imported
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Knowledge source list */}
        <Card className="border-border">
          <CardHeader className="pb-4">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-primary" />
              All knowledge sources
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-6 space-y-3">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-12 bg-muted rounded-xl animate-pulse" />
                ))}
              </div>
            ) : trainings.length === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="No knowledge sources yet"
                body="This is where your operational knowledge lives — SOPs, process docs, policies and recordings — so employees can get grounded answers. Add your first source above, or connect Google Drive to import."
              />
            ) : (
              <div className="divide-y divide-border">
                {trainings.map(training => {
                  const cfg = statusConfig[training.status] || statusConfig.ready;
                  const StatusIcon = cfg.icon;
                  return (
                    <div key={training.id} className="flex items-center gap-4 px-5 py-4 hover:bg-muted/30 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{training.title}</p>
                        <p className="text-xs text-muted-foreground">{training.category || 'Uncategorized'} · {training.presenter || 'Unknown presenter'}</p>
                      </div>
                      <Badge variant="outline" className={`text-xs border ${cfg.bg} ${cfg.color} gap-1 flex-shrink-0`}>
                        <StatusIcon className="w-3 h-3" />
                        {cfg.label}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive flex-shrink-0 h-8 w-8 p-0"
                        onClick={() => deleteMutation.mutate(training.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      )}
    </div>
  );
}