import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  CheckCircle2, ListOrdered, GitBranch, AlertTriangle,
  Package, Target, Cpu, Sparkles, BookOpen, Zap
} from 'lucide-react';

const Section = ({ icon: Icon, title, children, color = 'text-primary' }) => (
  <Card className="border-border">
    <CardHeader className="pb-3">
      <CardTitle className="text-base font-semibold flex items-center gap-2">
        <Icon className={`w-4 h-4 ${color}`} />
        {title}
      </CardTitle>
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);

const BulletList = ({ items, color = 'bg-primary/10 text-primary' }) => (
  <ul className="space-y-2">
    {items.map((item, i) => (
      <li key={i} className="flex items-start gap-3 text-sm text-foreground">
        <span className={`w-5 h-5 rounded-full ${color} text-xs flex items-center justify-center flex-shrink-0 font-semibold mt-0.5`}>
          {i + 1}
        </span>
        {item}
      </li>
    ))}
  </ul>
);

const priorityColor = {
  High: 'bg-red-100 text-red-700 border-red-200',
  Medium: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  Low: 'bg-green-100 text-green-700 border-green-200',
};

export default function TrainingDetailSections({ training }) {
  return (
    <div className="space-y-6">
      {/* Key Takeaways */}
      {training.key_takeaways?.length > 0 && (
        <Section icon={CheckCircle2} title="Key Takeaways">
          <BulletList items={training.key_takeaways} />
        </Section>
      )}

      {/* SOP */}
      {training.sop_steps?.length > 0 && (
        <Section icon={ListOrdered} title="Step-by-Step SOP">
          <ol className="space-y-3">
            {training.sop_steps.map((step, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-foreground">
                <span className="w-6 h-6 rounded-full bg-primary text-white text-xs flex items-center justify-center flex-shrink-0 font-bold mt-0.5">
                  {i + 1}
                </span>
                <span>{step.replace(/^\d+\.\s*/, '')}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {/* Decision Rules */}
      {training.decision_rules?.length > 0 && (
        <Section icon={GitBranch} title="Decision Rules" color="text-violet-500">
          <ul className="space-y-3">
            {training.decision_rules.map((rule, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <span className="w-5 h-5 rounded bg-violet-100 text-violet-600 text-xs flex items-center justify-center flex-shrink-0 font-bold mt-0.5">→</span>
                <span className="text-foreground">{rule}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Common Mistakes */}
      {training.common_mistakes?.length > 0 && (
        <Section icon={AlertTriangle} title="Common Mistakes & Watchouts" color="text-orange-500">
          <ul className="space-y-2">
            {training.common_mistakes.map((mistake, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-600 text-xs flex items-center justify-center flex-shrink-0 font-semibold mt-0.5">!</span>
                <span className="text-foreground">{mistake}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Required Inputs */}
      {training.required_inputs?.length > 0 && (
        <Section icon={Package} title="Required Inputs" color="text-blue-500">
          <ul className="space-y-2">
            {training.required_inputs.map((input, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-foreground">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                {input}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Final Output */}
      {training.final_output && (
        <Section icon={Target} title="Final Output" color="text-emerald-500">
          <p className="text-sm text-foreground leading-relaxed">{training.final_output}</p>
        </Section>
      )}

      {/* Software / Systems */}
      {training.software_systems?.length > 0 && (
        <Section icon={Cpu} title="Software & Systems Mentioned" color="text-slate-500">
          <div className="flex flex-wrap gap-2">
            {training.software_systems.map((sys, i) => (
              <Badge key={i} variant="outline" className="text-xs">{sys}</Badge>
            ))}
          </div>
        </Section>
      )}

      {/* App Feature Opportunities */}
      {training.app_feature_opportunities?.length > 0 && (
        <Section icon={Zap} title="App Feature Opportunities" color="text-primary">
          <div className="space-y-4">
            {training.app_feature_opportunities.map((feat, i) => (
              <div key={i} className="border border-border rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="font-semibold text-sm text-foreground">{feat.feature_name}</span>
                  <div className="flex gap-2">
                    <Badge className={`text-xs border ${priorityColor[feat.priority] || 'bg-muted'}`}>
                      {feat.priority} Priority
                    </Badge>
                    <Badge variant="outline" className="text-xs">{feat.facing}</Badge>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Problem:</span> {feat.problem_solved}</p>
                <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Users:</span> {feat.user_type}</p>
                <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Inputs:</span> {feat.required_inputs}</p>
                <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Output:</span> {feat.output}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* AI Knowledge Entry */}
      {training.ai_knowledge_entry && (
        <Section icon={BookOpen} title="AI Assistant Knowledge Entry" color="text-primary">
          <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">{training.ai_knowledge_entry}</p>
        </Section>
      )}
    </div>
  );
}