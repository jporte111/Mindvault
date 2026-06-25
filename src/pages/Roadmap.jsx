import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Brain, RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import StrategyDashboard from '@/components/strategy/StrategyDashboard';
import FeatureIdeasLevel from '@/components/strategy/FeatureIdeasLevel';
import StrategicOpportunities from '@/components/strategy/StrategicOpportunities';

export default function Roadmap() {
  const [level, setLevel] = useState('features');
  const [running, setRunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState('');
  const queryClient = useQueryClient();

  const { data: trainings = [], isLoading } = useQuery({
    queryKey: ['trainings'],
    queryFn: () => base44.entities.Training.list('-created_date'),
  });

  const { data: painPoints = [] } = useQuery({
    queryKey: ['painPoints'],
    queryFn: () => base44.entities.RecurringPainPoint.list('-frequency_count'),
  });
  const { data: workflowPatterns = [] } = useQuery({
    queryKey: ['workflowPatterns'],
    queryFn: () => base44.entities.WorkflowPattern.list('-frequency_count'),
  });
  const { data: decisionRules = [] } = useQuery({
    queryKey: ['decisionRules'],
    queryFn: () => base44.entities.DecisionRulePattern.list('-frequency_count'),
  });
  const { data: clusters = [] } = useQuery({
    queryKey: ['productClusters'],
    queryFn: () => base44.entities.ProductOpportunityCluster.list('-overall_opportunity_score'),
  });
  const { data: recommendations = [] } = useQuery({
    queryKey: ['productRecommendations'],
    queryFn: () => base44.entities.ProductRecommendation.list('-last_updated_date'),
  });

  const analyzedCount = trainings.filter(t => t.status === 'ready' || t.summary).length;
  const recommendation = recommendations[0];
  const hasRunAnalysis = painPoints.length > 0 || clusters.length > 0 || !!recommendation;

  const [strategyPhase, setStrategyPhase] = useState('');

  const handleRunStrategy = async () => {
    setRunning(true);
    try {
      // Phase 1: Patterns
      setStrategyPhase('Analyzing patterns across all trainings...');
      toast.info('Phase 1/3: Analyzing patterns across all trainings...');
      const res1 = await base44.functions.invoke('runProductStrategyEngine', { phase: 'patterns' });
      const data1 = res1.data || res1;
      if (data1.error) { toast.error(data1.error); return; }
      queryClient.invalidateQueries({ queryKey: ['painPoints'] });
      queryClient.invalidateQueries({ queryKey: ['workflowPatterns'] });
      queryClient.invalidateQueries({ queryKey: ['decisionRules'] });

      // Phase 2: Clusters
      setStrategyPhase('Grouping features into product clusters...');
      toast.info('Phase 2/3: Grouping features into product opportunity clusters...');
      const res2 = await base44.functions.invoke('runProductStrategyEngine', { phase: 'clusters' });
      const data2 = res2.data || res2;
      if (data2.error) { toast.error(data2.error); return; }
      queryClient.invalidateQueries({ queryKey: ['productClusters'] });

      // Phase 3: Recommendation
      setStrategyPhase('Generating product recommendation...');
      toast.info('Phase 3/3: Generating product recommendation...');
      const res3 = await base44.functions.invoke('runProductStrategyEngine', { phase: 'recommendation' });
      const data3 = res3.data || res3;
      if (data3.error) { toast.error(data3.error); return; }
      queryClient.invalidateQueries({ queryKey: ['productRecommendations'] });

      toast.success(`Strategy analysis complete! ${data1.pain_points_found} pain points, ${data1.workflow_patterns_found} workflows, ${data1.decision_rules_found} decision rules, ${data2.clusters_found} clusters, recommendation: ${data3.confidence_level} confidence.`);
    } catch (err) {
      toast.error('Strategy analysis failed: ' + (err?.message || 'Unknown error'));
    } finally {
      setRunning(false);
      setStrategyPhase('');
    }
  };

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

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-card border-b border-border px-8 py-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Brain className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h1 className="font-sora text-2xl font-bold text-foreground">Product Strategy Engine</h1>
                <p className="text-muted-foreground text-sm">{analyzedCount} analyzed trainings · {clusters.length} product clusters · {painPoints.length} pain points</p>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                onClick={handleRunStrategy}
                disabled={running || analyzedCount === 0}
                size="sm"
                className="gap-2 text-xs bg-primary hover:bg-primary/90"
              >
                {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Brain className="w-3.5 h-3.5" />}
                {running ? (strategyPhase || 'Analyzing...') : 'Run Strategy Analysis'}
              </Button>
              <Button
                onClick={handleRefreshMarketDemand}
                disabled={refreshing}
                size="sm"
                variant="outline"
                className="gap-2 text-xs"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? (refreshProgress || 'Refreshing...') : 'Refresh Market Demand'}
              </Button>
            </div>
          </div>

          {/* Level toggle */}
          <div className="flex gap-2 mt-5">
            <button
              onClick={() => setLevel('features')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                level === 'features' ? 'bg-primary text-white' : 'bg-card text-muted-foreground border border-border hover:text-foreground'
              }`}
            >
              Feature Ideas from Individual Trainings
            </button>
            <button
              onClick={() => setLevel('strategic')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                level === 'strategic' ? 'bg-primary text-white' : 'bg-card text-muted-foreground border border-border hover:text-foreground'
              }`}
            >
              Strategic Product Opportunities
            </button>
          </div>
        </div>
      </div>

      {/* Dashboard */}
      <StrategyDashboard
        analyzedCount={analyzedCount}
        painPoints={painPoints}
        workflowPatterns={workflowPatterns}
        decisionRules={decisionRules}
        clusters={clusters}
        recommendation={recommendation}
      />

      {/* Content */}
      <div className="px-8 py-6 max-w-5xl mx-auto">
        {level === 'features' ? (
          <FeatureIdeasLevel trainings={trainings} isLoading={isLoading} />
        ) : (
          <StrategicOpportunities
            painPoints={painPoints}
            workflowPatterns={workflowPatterns}
            decisionRules={decisionRules}
            clusters={clusters}
            recommendation={recommendation}
            trainings={trainings}
            isLoading={isLoading}
            hasRunAnalysis={hasRunAnalysis}
          />
        )}
      </div>
    </div>
  );
}