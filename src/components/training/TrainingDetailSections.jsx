import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import InlineText from '@/components/edit/InlineText';
import EditableList from '@/components/edit/EditableList';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Plus, X } from 'lucide-react';
import {
  CheckCircle2, ListOrdered, GitBranch, AlertTriangle,
  Package, Target, Cpu, BookOpen, Split, Ban, ShieldCheck,
  Users, Stamp, ArrowUpRight, CalendarClock, ClipboardList,
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

// Read-only bullet list for the additive operational fields (no inline editing
// of these in this phase).
const SimpleList = ({ items, markerClass = 'bg-primary/50' }) => (
  <ul className="space-y-2">
    {items.map((item, i) => (
      <li key={i} className="flex items-start gap-2 text-sm text-foreground">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-2 ${markerClass}`} />
        <span>{item}</span>
      </li>
    ))}
  </ul>
);

export default function TrainingDetailSections({ training, onUpdate }) {
  const isAdmin = useIsAdmin();

  const updateSys = (i, v) =>
    onUpdate('software_systems', (training.software_systems || []).map((x, j) => (j === i ? v : x)));
  const removeSys = (i) =>
    onUpdate('software_systems', (training.software_systems || []).filter((_, j) => j !== i));
  const addSys = () =>
    onUpdate('software_systems', [...(training.software_systems || []), '']);

  return (
    <div className="space-y-6">
      {/* Key Takeaways */}
      {training.key_takeaways?.length > 0 && (
        <Section icon={CheckCircle2} title="Key Takeaways">
          <EditableList
            items={training.key_takeaways}
            onSave={(arr) => onUpdate('key_takeaways', arr)}
            isAdmin={isAdmin}
            listClassName="space-y-2"
            textClassName="text-sm text-foreground"
            marker={(i) => (
              <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center flex-shrink-0 font-semibold mt-0.5">
                {i + 1}
              </span>
            )}
          />
        </Section>
      )}

      {/* Prerequisites */}
      {training.prerequisites?.length > 0 && (
        <Section icon={ClipboardList} title="Prerequisites" color="text-blue-500">
          <SimpleList items={training.prerequisites} markerClass="bg-blue-400" />
        </Section>
      )}

      {/* SOP */}
      {training.sop_steps?.length > 0 && (
        <Section icon={ListOrdered} title="Step-by-Step SOP">
          <EditableList
            items={training.sop_steps}
            onSave={(arr) => onUpdate('sop_steps', arr)}
            isAdmin={isAdmin}
            ordered
            listClassName="space-y-3"
            textClassName="text-sm text-foreground"
            marker={(i) => (
              <span className="w-6 h-6 rounded-full bg-primary text-white text-xs flex items-center justify-center flex-shrink-0 font-bold mt-0.5">
                {i + 1}
              </span>
            )}
          />
        </Section>
      )}

      {/* Decision Rules */}
      {training.decision_rules?.length > 0 && (
        <Section icon={GitBranch} title="Decision Rules" color="text-violet-500">
          <EditableList
            items={training.decision_rules}
            onSave={(arr) => onUpdate('decision_rules', arr)}
            isAdmin={isAdmin}
            listClassName="space-y-3"
            textClassName="text-sm text-foreground"
            marker={() => (
              <span className="w-5 h-5 rounded bg-violet-100 text-violet-600 text-xs flex items-center justify-center flex-shrink-0 font-bold mt-0.5">→</span>
            )}
          />
        </Section>
      )}

      {/* Exceptions */}
      {training.exceptions?.length > 0 && (
        <Section icon={Split} title="Exceptions" color="text-amber-500">
          <SimpleList items={training.exceptions} markerClass="bg-amber-400" />
        </Section>
      )}

      {/* Common Mistakes */}
      {training.common_mistakes?.length > 0 && (
        <Section icon={AlertTriangle} title="Common Mistakes & Watchouts" color="text-orange-500">
          <EditableList
            items={training.common_mistakes}
            onSave={(arr) => onUpdate('common_mistakes', arr)}
            isAdmin={isAdmin}
            listClassName="space-y-2"
            textClassName="text-sm text-foreground"
            marker={() => (
              <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-600 text-xs flex items-center justify-center flex-shrink-0 font-semibold mt-0.5">!</span>
            )}
          />
        </Section>
      )}

      {/* Do Not */}
      {training.prohibited_actions?.length > 0 && (
        <Section icon={Ban} title="Do Not" color="text-red-500">
          <SimpleList items={training.prohibited_actions} markerClass="bg-red-400" />
        </Section>
      )}

      {/* Required Inputs */}
      {training.required_inputs?.length > 0 && (
        <Section icon={Package} title="Required Inputs" color="text-blue-500">
          <EditableList
            items={training.required_inputs}
            onSave={(arr) => onUpdate('required_inputs', arr)}
            isAdmin={isAdmin}
            listClassName="space-y-2"
            textClassName="text-sm text-foreground"
            marker={() => <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0 mt-2" />}
          />
        </Section>
      )}

      {/* Roles Involved */}
      {training.roles_involved?.length > 0 && (
        <Section icon={Users} title="Roles Involved" color="text-slate-500">
          <SimpleList items={training.roles_involved} markerClass="bg-slate-400" />
        </Section>
      )}

      {/* Approvals */}
      {training.approvers?.length > 0 && (
        <Section icon={Stamp} title="Approvals" color="text-emerald-600">
          <SimpleList items={training.approvers} markerClass="bg-emerald-400" />
        </Section>
      )}

      {/* Escalation */}
      {training.escalation_paths?.length > 0 && (
        <Section icon={ArrowUpRight} title="Escalation" color="text-rose-500">
          <SimpleList items={training.escalation_paths} markerClass="bg-rose-400" />
        </Section>
      )}

      {/* Deadlines */}
      {training.deadlines?.length > 0 && (
        <Section icon={CalendarClock} title="Deadlines & Timing" color="text-cyan-600">
          <SimpleList items={training.deadlines} markerClass="bg-cyan-400" />
        </Section>
      )}

      {/* Verification Checkpoints */}
      {training.verification_checkpoints?.length > 0 && (
        <Section icon={ShieldCheck} title="Verification Checkpoints" color="text-green-600">
          <SimpleList items={training.verification_checkpoints} markerClass="bg-green-400" />
        </Section>
      )}

      {/* Final Output */}
      {(training.final_output || isAdmin) && (
        <Section icon={Target} title="Final Output" color="text-emerald-500">
          <InlineText
            value={training.final_output}
            onSave={(v) => onUpdate('final_output', v)}
            isAdmin={isAdmin}
            multiline
            className="text-sm text-foreground leading-relaxed"
            emptyText="Click to add the final output"
          />
        </Section>
      )}

      {/* Software / Systems */}
      {training.software_systems?.length > 0 && (
        <Section icon={Cpu} title="Software & Systems Mentioned" color="text-slate-500">
          <div className="flex flex-wrap gap-2">
            {training.software_systems.map((sys, i) => (
              <Badge key={i} variant="outline" className="text-xs group/ss inline-flex items-center gap-1 pr-1.5">
                <InlineText
                  value={sys}
                  onSave={(v) => updateSys(i, v)}
                  isAdmin={isAdmin}
                  multiline={false}
                  className="text-xs"
                />
                {isAdmin && (
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); removeSys(i); }}
                    className="text-muted-foreground hover:text-destructive"
                    title="Remove"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </Badge>
            ))}
            {isAdmin && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); addSys(); }}
                className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium h-6 px-2 border border-dashed border-primary/40 rounded-md"
              >
                <Plus className="w-3 h-3" />
                Add
              </button>
            )}
          </div>
        </Section>
      )}

      {/* AI Knowledge Entry */}
      {(training.ai_knowledge_entry || isAdmin) && (
        <Section icon={BookOpen} title="AI Assistant Knowledge Entry" color="text-primary">
          <InlineText
            value={training.ai_knowledge_entry}
            onSave={(v) => onUpdate('ai_knowledge_entry', v)}
            isAdmin={isAdmin}
            multiline
            className="text-sm text-muted-foreground leading-relaxed"
            emptyText="Click to add a knowledge entry"
          />
        </Section>
      )}
    </div>
  );
}
