import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ExternalLink, Plus, Minus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const segmentColor = {
  'Small Business': 'bg-blue-100 text-blue-700 border-blue-200',
  'High-Net-Worth Household': 'bg-purple-100 text-purple-700 border-purple-200',
  'Both': 'bg-indigo-100 text-indigo-700 border-indigo-200',
  'Internal Only': 'bg-slate-100 text-slate-700 border-slate-200',
};

function ScorePill({ label, value }) {
  return (
    <span className="px-2 py-0.5 rounded-md bg-muted text-xs text-muted-foreground border border-border">
      {label}: <span className="font-semibold text-foreground">{value ?? '—'}/5</span>
    </span>
  );
}

function TrainingLinks({ ids, trainingMap }) {
  if (!ids?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {ids.slice(0, 5).map(id => (
        <Link
          key={id}
          to={`/training/${id}`}
          className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
        >
          <ExternalLink className="w-2.5 h-2.5" />
          {trainingMap[id] || 'Training'}
        </Link>
      ))}
      {ids.length > 5 && <span className="text-[11px] text-muted-foreground">+{ids.length - 5} more</span>}
    </div>
  );
}

function PainPointItem({ item, trainingMap }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold text-sm text-foreground">{item.name}</h4>
            {item.client_segment && (
              <Badge className={`text-[11px] border ${segmentColor[item.client_segment] || ''}`}>{item.client_segment}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{item.description}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="secondary" className="text-[11px]">{item.frequency_count} trainings</Badge>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        <ScorePill label="Severity" value={item.severity_score} />
      </div>
      {item.supporting_evidence_summary && (
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 text-[11px] text-primary hover:underline mt-2">
          <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          {expanded ? 'Hide evidence' : 'Show evidence'}
        </button>
      )}
      {expanded && item.supporting_evidence_summary && (
        <p className="text-xs text-muted-foreground italic mt-1.5 leading-relaxed">{item.supporting_evidence_summary}</p>
      )}
      <TrainingLinks ids={item.related_training_ids} trainingMap={trainingMap} />
    </div>
  );
}

function WorkflowItem({ item, trainingMap }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold text-sm text-foreground">{item.name}</h4>
            {item.workflow_type && <Badge variant="outline" className="text-[11px]">{item.workflow_type}</Badge>}
            {item.client_segment && (
              <Badge className={`text-[11px] border ${segmentColor[item.client_segment] || ''}`}>{item.client_segment}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{item.description}</p>
        </div>
        <Badge variant="secondary" className="text-[11px] shrink-0">{item.frequency_count} trainings</Badge>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        <ScorePill label="Automation Potential" value={item.automation_potential_score} />
        <ScorePill label="Complexity" value={item.complexity_score} />
      </div>
      {item.supporting_evidence_summary && (
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 text-[11px] text-primary hover:underline mt-2">
          <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          {expanded ? 'Hide evidence' : 'Show evidence'}
        </button>
      )}
      {expanded && item.supporting_evidence_summary && (
        <p className="text-xs text-muted-foreground italic mt-1.5 leading-relaxed">{item.supporting_evidence_summary}</p>
      )}
      <TrainingLinks ids={item.related_training_ids} trainingMap={trainingMap} />
    </div>
  );
}

function DecisionRuleItem({ item, trainingMap }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold text-sm text-foreground">{item.rule_name}</h4>
            {item.client_segment && (
              <Badge className={`text-[11px] border ${segmentColor[item.client_segment] || ''}`}>{item.client_segment}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{item.rule_description}</p>
        </div>
        <Badge variant="secondary" className="text-[11px] shrink-0">{item.frequency_count} trainings</Badge>
      </div>
      {item.example_if_then_rule && (
        <div className="mt-2 rounded-lg bg-primary/5 border border-primary/20 px-3 py-2">
          <p className="text-xs text-foreground font-mono">{item.example_if_then_rule}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 mt-2">
        <ScorePill label="Judgment Dependency" value={item.judgment_dependency_score} />
      </div>
      {item.supporting_evidence_summary && (
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 text-[11px] text-primary hover:underline mt-2">
          <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          {expanded ? 'Hide evidence' : 'Show evidence'}
        </button>
      )}
      {expanded && item.supporting_evidence_summary && (
        <p className="text-xs text-muted-foreground italic mt-1.5 leading-relaxed">{item.supporting_evidence_summary}</p>
      )}
      <TrainingLinks ids={item.related_training_ids} trainingMap={trainingMap} />
    </div>
  );
}

export default function PatternSection({ title, icon: Icon, items, type, trainingMap, emptyMessage }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-primary" />
        <h3 className="font-sora text-base font-semibold text-foreground">{title}</h3>
        <Badge variant="secondary" className="text-xs">{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <div className="bg-muted/30 border border-dashed border-border rounded-xl p-8 text-center">
          <Icon className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">{emptyMessage || 'No patterns identified yet. Run Strategy Analysis to detect them.'}</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          {items.map((item, i) => {
            if (type === 'pain_point') return <PainPointItem key={i} item={item} trainingMap={trainingMap} />;
            if (type === 'workflow') return <WorkflowItem key={i} item={item} trainingMap={trainingMap} />;
            return <DecisionRuleItem key={i} item={item} trainingMap={trainingMap} />;
          })}
        </div>
      )}
    </div>
  );
}