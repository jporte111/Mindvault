import { Brain, AlertTriangle, Workflow, Scale, Target, Shield, TrendingUp, Lightbulb, Layers } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const confidenceColor = {
  High: 'bg-green-100 text-green-700 border-green-200',
  Medium: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  Low: 'bg-orange-100 text-orange-700 border-orange-200',
};

function StatCard({ icon: Icon, label, value, sublabel, color }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 flex items-start gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${color || 'bg-primary/10'}`}>
        <Icon className="w-4 h-4 text-primary" />
      </div>
      <div>
        <p className="text-2xl font-bold font-sora text-foreground leading-none">{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{label}</p>
        {sublabel && <p className="text-[11px] text-muted-foreground/70 mt-0.5">{sublabel}</p>}
      </div>
    </div>
  );
}

function MiniCluster({ cluster, scoreKey, label }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-border last:border-0">
      <span className="text-xs text-foreground font-medium truncate">{cluster.cluster_name}</span>
      <span className="text-xs font-semibold text-primary shrink-0">{cluster[scoreKey]}/5</span>
    </div>
  );
}

export default function StrategyDashboard({ analyzedCount, painPoints, workflowPatterns, decisionRules, clusters, recommendation }) {
  const topClusters = [...clusters].sort((a, b) => (b.overall_opportunity_score || 0) - (a.overall_opportunity_score || 0)).slice(0, 3);
  const topDefensibility = [...clusters].sort((a, b) => (b.defensibility_score || 0) - (a.defensibility_score || 0)).slice(0, 3);
  const topBusinessFit = [...clusters].sort((a, b) => (b.business_fit_score || 0) - (a.business_fit_score || 0)).slice(0, 3);

  return (
    <div className="px-8 py-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <Brain className="w-4 h-4 text-primary" />
        <h2 className="font-sora text-sm font-semibold text-foreground">Product Strategy Dashboard</h2>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
        <StatCard icon={Layers} label="Analyzed Transcripts" value={analyzedCount} color="bg-blue-100" />
        <StatCard icon={AlertTriangle} label="Recurring Pain Points" value={painPoints.length} color="bg-red-100" />
        <StatCard icon={Workflow} label="Workflow Patterns" value={workflowPatterns.length} color="bg-purple-100" />
        <StatCard icon={Scale} label="Decision Rules" value={decisionRules.length} color="bg-amber-100" />
        <StatCard icon={Target} label="Product Clusters" value={clusters.length} color="bg-green-100" />
      </div>

      {/* Confidence + recommendation topics */}
      <div className="grid md:grid-cols-2 gap-3 mt-3">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Recommendation Confidence</h3>
          </div>
          {recommendation ? (
            <div className="space-y-2">
              <Badge className={`text-xs border ${confidenceColor[recommendation.confidence_level] || confidenceColor.Low}`}>
                {recommendation.confidence_level} Confidence
              </Badge>
              <p className="text-xs text-muted-foreground leading-relaxed">{recommendation.confidence_reason}</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No recommendation yet. Run Strategy Analysis to generate one.</p>
          )}
        </div>

        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Lightbulb className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Trainings Needed to Improve Confidence</h3>
          </div>
          {recommendation?.additional_training_topics_needed ? (
            <p className="text-xs text-muted-foreground leading-relaxed">{recommendation.additional_training_topics_needed}</p>
          ) : (
            <p className="text-xs text-muted-foreground">Run Strategy Analysis to see what additional training topics would improve the recommendation.</p>
          )}
        </div>
      </div>

      {/* Top clusters by score */}
      {clusters.length > 0 && (
        <div className="grid md:grid-cols-3 gap-3 mt-3">
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Target className="w-3.5 h-3.5 text-primary" />
              <h3 className="text-xs font-semibold text-foreground">Top Clusters (Overall)</h3>
            </div>
            {topClusters.map((c, i) => <MiniCluster key={i} cluster={c} scoreKey="overall_opportunity_score" />)}
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Shield className="w-3.5 h-3.5 text-primary" />
              <h3 className="text-xs font-semibold text-foreground">Highest Defensibility</h3>
            </div>
            {topDefensibility.map((c, i) => <MiniCluster key={i} cluster={c} scoreKey="defensibility_score" />)}
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Brain className="w-3.5 h-3.5 text-primary" />
              <h3 className="text-xs font-semibold text-foreground">Highest Business Fit</h3>
            </div>
            {topBusinessFit.map((c, i) => <MiniCluster key={i} cluster={c} scoreKey="business_fit_score" />)}
          </div>
        </div>
      )}
    </div>
  );
}