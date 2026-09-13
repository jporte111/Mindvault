import { useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bot, Info } from 'lucide-react';
import { toast } from 'sonner';
import { useSystemConfig, SYSTEM_CONFIG_KEY } from '@/components/admin/ChatEngineToggle';

// Plain-language answer settings, wired to the real AppConfig flags.
// Editable by platform admins; company admins see the current values
// read-only (the flags are platform-wide today, so a company admin
// changing them would change them for every company).
const BUSINESS_FLAGS = [
  {
    key: 'require_verification_for_retrieval',
    label: 'Only answer from verified knowledge',
    hint: 'When on, the assistant uses only sources a reviewer has confirmed are accurate. Anything not yet verified stops answering until someone verifies it.',
  },
  {
    key: 'clarifications_enabled',
    label: 'Let employees request human help',
    hint: 'Adds an “I still need help” option under answers, which opens a request your team can answer.',
  },
  {
    key: 'knowledge_gaps_enabled',
    label: 'Track questions the knowledge base cannot answer',
    hint: 'Collects the topics employees asked about that weren’t covered, so you can see what to document next.',
  },
  {
    key: 'answer_logging_enabled',
    label: 'Track answer quality',
    hint: 'Records questions asked and how well they were answered so quality can be reviewed. No individual is identified.',
  },
];

export default function AssistantToggles({ editable }) {
  const queryClient = useQueryClient();
  const system = useSystemConfig();

  const values = {
    require_verification_for_retrieval: system.requireVerification,
    clarifications_enabled: system.clarificationsEnabled,
    knowledge_gaps_enabled: system.knowledgeGapsEnabled,
    answer_logging_enabled: system.answerLogging,
  };

  const save = async (key, next) => {
    try {
      if (system.row) {
        await base44.entities.AppConfig.update(system.row.id, { [key]: next });
      } else {
        await base44.entities.AppConfig.create({
          key: SYSTEM_CONFIG_KEY,
          governance_ranking_enabled: true,
          [key]: next,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['app-config', SYSTEM_CONFIG_KEY] });
      toast.success('Assistant settings saved');
    } catch (err) {
      toast.error('Failed to save: ' + (err?.message || 'Unknown error'));
    }
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Bot className="w-4 h-4 text-primary" />
          How the assistant answers
        </CardTitle>
        {!editable && (
          <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/50 border border-border rounded-lg px-3 py-2">
            <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              These settings currently apply to all companies on MindVault and are managed
              by the MindVault team. Contact support if you need one changed.
            </span>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {BUSINESS_FLAGS.map((f) => {
          const on = values[f.key] === true;
          return (
            <div key={f.key} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{f.label}</div>
                <p className="text-xs text-muted-foreground/80 mt-0.5">{f.hint}</p>
              </div>
              {editable ? (
                <button
                  onClick={() => save(f.key, !on)}
                  className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                    on
                      ? 'bg-primary text-white border-primary'
                      : 'bg-card text-muted-foreground border-border hover:border-primary/50'
                  }`}
                >
                  {on ? 'On' : 'Off'}
                </button>
              ) : (
                <span
                  className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border ${
                    on ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-muted border-border text-muted-foreground'
                  }`}
                >
                  {on ? 'On' : 'Off'}
                </span>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}