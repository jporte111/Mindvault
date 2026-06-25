import { Link } from 'react-router-dom';
import { Sparkles, ExternalLink, Target, Users, AlertTriangle, Rocket, Map, Shield, Zap, Database, Lightbulb } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const confidenceColor = {
  High: 'bg-green-100 text-green-700 border-green-200',
  Medium: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  Low: 'bg-orange-100 text-orange-700 border-orange-200',
};

function Field({ icon: Icon, label, children }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-primary" />
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
      </div>
      <div className="text-sm text-foreground leading-relaxed pl-5">{children}</div>
    </div>
  );
}

export default function ProductRecommendationCard({ recommendation, trainingMap }) {
  if (!recommendation) return null;

  return (
    <div className="bg-gradient-to-br from-primary/5 to-card border border-primary/30 rounded-2xl p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="font-sora text-xl font-bold text-foreground">{recommendation.product_name_idea}</h3>
            <p className="text-sm text-muted-foreground italic mt-0.5">{recommendation.positioning_statement}</p>
          </div>
        </div>
        <Badge className={`text-xs border ${confidenceColor[recommendation.confidence_level] || confidenceColor.Low}`}>
          {recommendation.confidence_level} Confidence
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">{recommendation.confidence_reason}</p>

      {/* Core fields */}
      <div className="grid md:grid-cols-2 gap-4">
        <Field icon={Users} label="Target Users">
          {recommendation.target_users}
        </Field>
        <Field icon={Target} label="Main Problem Solved">
          {recommendation.main_problem_solved}
        </Field>
      </div>

      {/* Core modules */}
      {recommendation.core_modules?.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-primary" />
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Core Modules</p>
          </div>
          <div className="flex flex-wrap gap-2 pl-5">
            {recommendation.core_modules.map((m, i) => (
              <span key={i} className="px-3 py-1 rounded-lg bg-primary/10 text-primary text-xs font-medium border border-primary/20">{m}</span>
            ))}
          </div>
        </div>
      )}

      {/* Strategy fields */}
      <div className="grid md:grid-cols-2 gap-4">
        <Field icon={Shield} label="Unique Business Advantage">
          {recommendation.unique_business_advantage}
        </Field>
        <Field icon={Shield} label="Why Hard to Copy">
          {recommendation.why_hard_to_copy}
        </Field>
      </div>

      <Field icon={Target} label="Competitive Positioning">
        {recommendation.competitive_positioning}
      </Field>

      {/* MVP + Roadmap */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl bg-green-50 border border-green-200 p-4 space-y-1">
          <div className="flex items-center gap-1.5">
            <Rocket className="w-3.5 h-3.5 text-green-600" />
            <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">First Version MVP</p>
          </div>
          <p className="text-sm text-foreground leading-relaxed">{recommendation.first_version_mvp}</p>
        </div>
        <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 space-y-1">
          <div className="flex items-center gap-1.5">
            <Map className="w-3.5 h-3.5 text-blue-600" />
            <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Future Version Roadmap</p>
          </div>
          <p className="text-sm text-foreground leading-relaxed">{recommendation.future_version_roadmap}</p>
        </div>
      </div>

      {/* Risks + Data needed */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 space-y-1">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-red-600" />
            <p className="text-xs font-semibold text-red-700 uppercase tracking-wide">Risks & Weaknesses</p>
          </div>
          <p className="text-sm text-foreground leading-relaxed">{recommendation.risks_or_weaknesses}</p>
        </div>
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 space-y-1">
          <div className="flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-amber-600" />
            <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide">Data Needed to Improve Confidence</p>
          </div>
          <p className="text-sm text-foreground leading-relaxed">{recommendation.data_needed_to_improve_confidence}</p>
        </div>
      </div>

      {/* Additional training topics */}
      {recommendation.additional_training_topics_needed && (
        <div className="rounded-xl bg-primary/5 border border-primary/20 p-4 space-y-1">
          <div className="flex items-center gap-1.5">
            <Lightbulb className="w-3.5 h-3.5 text-primary" />
            <p className="text-xs font-semibold text-primary uppercase tracking-wide">Additional Training Topics Needed</p>
          </div>
          <p className="text-sm text-foreground leading-relaxed">{recommendation.additional_training_topics_needed}</p>
        </div>
      )}

      {/* Related clusters */}
      {recommendation.related_product_clusters?.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Built on Clusters</p>
          <div className="flex flex-wrap gap-2">
            {recommendation.related_product_clusters.map((c, i) => (
              <span key={i} className="px-2.5 py-0.5 rounded-full bg-muted text-xs text-muted-foreground border border-border">{c}</span>
            ))}
          </div>
        </div>
      )}

      {/* Source trainings */}
      {recommendation.related_training_ids?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-border">
          <span className="text-xs text-muted-foreground py-0.5">Key trainings:</span>
          {recommendation.related_training_ids.slice(0, 8).map(id => (
            <Link key={id} to={`/training/${id}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline py-0.5">
              <ExternalLink className="w-3 h-3" />
              {trainingMap[id] || 'Training'}
            </Link>
          ))}
          {recommendation.related_training_ids.length > 8 && (
            <span className="text-xs text-muted-foreground py-0.5">+{recommendation.related_training_ids.length - 8} more</span>
          )}
        </div>
      )}
    </div>
  );
}