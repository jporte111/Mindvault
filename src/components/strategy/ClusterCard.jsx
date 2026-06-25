import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ExternalLink, Target, Shield, TrendingUp, Building, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

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

function ScoreRow({ icon: Icon, label, value }) {
  const color = value >= 4 ? 'text-green-600' : value >= 3 ? 'text-yellow-600' : 'text-red-500';
  return (
    <div className="flex items-center gap-2">
      <Icon className="w-3.5 h-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground flex-1">{label}</span>
      <span className={`text-xs font-bold ${color}`}>{value ?? '—'}/5</span>
    </div>
  );
}

export default function ClusterCard({ cluster, trainingMap }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-card border border-border rounded-2xl p-5 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1">
          <h3 className="font-sora text-base font-bold text-foreground">{cluster.cluster_name}</h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{cluster.description}</p>
        </div>
        <div className="flex gap-1.5 flex-wrap shrink-0">
          <Badge className={`text-xs border ${priorityColor[cluster.priority] || ''}`}>{cluster.priority}</Badge>
          {cluster.facing && <Badge className={`text-xs border ${facingColor[cluster.facing] || ''}`}>{cluster.facing}</Badge>}
        </div>
      </div>

      {/* Scores */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 pt-1">
        <ScoreRow icon={Target} label="Internal Need" value={cluster.internal_need_score} />
        <ScoreRow icon={TrendingUp} label="AI Market Demand" value={cluster.AI_estimated_market_demand_score} />
        <ScoreRow icon={Building} label="Business Fit" value={cluster.business_fit_score} />
        <ScoreRow icon={Shield} label="Defensibility" value={cluster.defensibility_score} />
        <ScoreRow icon={Wrench} label="Complexity" value={cluster.implementation_complexity_score} />
        <ScoreRow icon={Target} label="Overall" value={cluster.overall_opportunity_score} />
      </div>

      {/* Related items */}
      {(cluster.related_feature_ideas?.length > 0 || cluster.related_pain_points?.length > 0 || cluster.related_workflow_patterns?.length > 0 || cluster.related_decision_rules?.length > 0) && (
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 text-xs text-primary hover:underline">
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          {expanded ? 'Hide details' : 'Show related features & evidence'}
        </button>
      )}

      {expanded && (
        <div className="space-y-2 pt-1">
          {cluster.related_feature_ideas?.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground mb-1">FEATURE IDEAS</p>
              <div className="flex flex-wrap gap-1.5">
                {cluster.related_feature_ideas.map((f, i) => (
                  <span key={i} className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] border border-primary/20">{f}</span>
                ))}
              </div>
            </div>
          )}
          {cluster.related_pain_points?.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground mb-1">PAIN POINTS</p>
              <div className="flex flex-wrap gap-1.5">
                {cluster.related_pain_points.map((p, i) => (
                  <span key={i} className="px-2 py-0.5 rounded-full bg-red-50 text-red-700 text-[11px] border border-red-200">{p}</span>
                ))}
              </div>
            </div>
          )}
          {cluster.related_workflow_patterns?.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground mb-1">WORKFLOW PATTERNS</p>
              <div className="flex flex-wrap gap-1.5">
                {cluster.related_workflow_patterns.map((w, i) => (
                  <span key={i} className="px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 text-[11px] border border-purple-200">{w}</span>
                ))}
              </div>
            </div>
          )}
          {cluster.related_decision_rules?.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground mb-1">DECISION RULES</p>
              <div className="flex flex-wrap gap-1.5">
                {cluster.related_decision_rules.map((d, i) => (
                  <span key={i} className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[11px] border border-amber-200">{d}</span>
                ))}
              </div>
            </div>
          )}
          {cluster.supporting_evidence_summary && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground mb-1">EVIDENCE</p>
              <p className="text-xs text-muted-foreground italic leading-relaxed">{cluster.supporting_evidence_summary}</p>
            </div>
          )}
        </div>
      )}

      {cluster.priority_reason && (
        <p className="text-xs text-muted-foreground italic">{cluster.priority_reason}</p>
      )}

      {/* Source trainings */}
      {cluster.related_training_ids?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border">
          <span className="text-[11px] text-muted-foreground py-0.5">Sources:</span>
          {cluster.related_training_ids.slice(0, 6).map(id => (
            <Link key={id} to={`/training/${id}`} className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline py-0.5">
              <ExternalLink className="w-2.5 h-2.5" />
              {trainingMap[id] || 'Training'}
            </Link>
          ))}
          {cluster.related_training_ids.length > 6 && (
            <span className="text-[11px] text-muted-foreground py-0.5">+{cluster.related_training_ids.length - 6} more</span>
          )}
        </div>
      )}
    </div>
  );
}