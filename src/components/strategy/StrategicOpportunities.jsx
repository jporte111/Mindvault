import { AlertTriangle, Workflow, Scale, Layers, Brain, Sparkles } from 'lucide-react';
import PatternSection from '@/components/strategy/PatternSection';
import ClusterCard from '@/components/strategy/ClusterCard';
import ProductRecommendationCard from '@/components/strategy/ProductRecommendationCard';

export default function StrategicOpportunities({ painPoints, workflowPatterns, decisionRules, clusters, recommendation, trainings, isLoading, hasRunAnalysis }) {
  const trainingMap = {};
  trainings.forEach(t => { trainingMap[t.id] = t.title; });

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[...Array(4)].map((_, i) => <div key={i} className="h-40 rounded-2xl bg-muted animate-pulse" />)}
      </div>
    );
  }

  if (!hasRunAnalysis) {
    return (
      <div className="text-center py-20">
        <Brain className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
        <p className="text-muted-foreground font-medium">No strategy analysis yet</p>
        <p className="text-muted-foreground/60 text-sm mt-1">Click "Run Strategy Analysis" above to analyze all trainings and generate strategic product opportunities.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Product Recommendation */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-primary" />
          <h3 className="font-sora text-base font-semibold text-foreground">Product Recommendation</h3>
        </div>
        {recommendation ? (
          <ProductRecommendationCard recommendation={recommendation} trainingMap={trainingMap} />
        ) : (
          <div className="bg-muted/30 border border-dashed border-border rounded-xl p-8 text-center">
            <p className="text-sm text-muted-foreground">No product recommendation generated. This may happen if the analysis encountered an error. Try running the analysis again.</p>
          </div>
        )}
      </div>

      {/* Product Opportunity Clusters */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Layers className="w-4 h-4 text-primary" />
          <h3 className="font-sora text-base font-semibold text-foreground">Product Opportunity Clusters</h3>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{clusters.length} clusters</span>
        </div>
        {clusters.length === 0 ? (
          <div className="bg-muted/30 border border-dashed border-border rounded-xl p-8 text-center">
            <p className="text-sm text-muted-foreground">No clusters identified yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {clusters.map((c, i) => <ClusterCard key={i} cluster={c} trainingMap={trainingMap} />)}
          </div>
        )}
      </div>

      {/* Recurring Pain Points */}
      <PatternSection
        title="Recurring Pain Points"
        icon={AlertTriangle}
        items={painPoints}
        type="pain_point"
        trainingMap={trainingMap}
        emptyMessage="No recurring pain points detected. Upload more trainings to help the system identify repeated problems."
      />

      {/* Workflow Patterns */}
      <PatternSection
        title="Repeated Manual Workflows"
        icon={Workflow}
        items={workflowPatterns}
        type="workflow"
        trainingMap={trainingMap}
        emptyMessage="No repeated manual workflows detected. Upload more trainings to help the system identify automation opportunities."
      />

      {/* Decision Rule Patterns */}
      <PatternSection
        title="Judgment-Based Decision Rules"
        icon={Scale}
        items={decisionRules}
        type="decision_rule"
        trainingMap={trainingMap}
        emptyMessage="No judgment-based decision rules detected. Upload more trainings to help the system identify recurring judgment patterns."
      />
    </div>
  );
}