import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bot, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

export const CHAT_CONFIG_KEY = 'chat';
export const SYSTEM_CONFIG_KEY = 'system';

// Reads the singleton AppConfig row { key: 'chat' }. Returns sensible
// defaults (legacy engine) when it doesn't exist yet.
export function useChatConfig() {
  const { data } = useQuery({
    queryKey: ['app-config', CHAT_CONFIG_KEY],
    queryFn: async () => {
      const rows = await base44.entities.AppConfig.filter({ key: CHAT_CONFIG_KEY });
      return rows[0] || null;
    },
  });
  const rm = data?.retrieval_mode;
  return {
    row: data || null,
    chatEngine: data?.chat_engine === 'rag' ? 'rag' : 'legacy',
    ragRolloutPct: Number(data?.rag_rollout_pct) || 0,
    retrievalMode: rm === 'lexical' || rm === 'semantic' ? rm : 'auto',
  };
}

// Phase 3 governance / observability flags live on a separate AppConfig row
// { key: 'system' }. Absent row => every flag at its safe default: verification
// and ingestion gates OFF, governance ranking ON, answer logging OFF.
export function useSystemConfig() {
  const { data } = useQuery({
    queryKey: ['app-config', SYSTEM_CONFIG_KEY],
    queryFn: async () => {
      const rows = await base44.entities.AppConfig.filter({ key: SYSTEM_CONFIG_KEY });
      return rows[0] || null;
    },
  });
  return {
    row: data || null,
    requireVerification: data?.require_verification_for_retrieval === true,
    requireIngestionReview: data?.require_ingestion_review === true,
    governanceRanking: data?.governance_ranking_enabled !== false,
    answerLogging: data?.answer_logging_enabled === true,
  };
}

const SYSTEM_FLAGS = [
  {
    key: 'require_verification_for_retrieval',
    label: 'Require verification for retrieval',
    hint: 'When on, only sources marked "verified" are used. Rejected sources are always excluded regardless. Default off so unverified knowledge keeps answering.',
  },
  {
    key: 'require_ingestion_review',
    label: 'Require ingestion review',
    hint: 'When on, sources flagged "needs review" during ingestion are excluded from answers until an admin reviews them. Default off.',
  },
  {
    key: 'governance_ranking_enabled',
    label: 'Governance ranking signals',
    hint: 'Small authority boost + freshness penalty on ranking. Non-destructive. On by default; turn off only if answer quality regresses.',
    defaultOn: true,
  },
  {
    key: 'answer_logging_enabled',
    label: 'Answer logging (AnswerLog)',
    hint: 'Logs each question, retrieval detail, and latency for knowledge-quality analysis. No employee identifier is stored. Off by default — logging raw questions is an explicit opt-in.',
  },
];

const RETRIEVAL_MODES = [
  { value: 'auto', label: 'Auto', hint: 'Semantic when embeddings work, lexical otherwise.' },
  { value: 'lexical', label: 'Lexical only', hint: 'Never calls an embeddings provider. No key needed.' },
  { value: 'semantic', label: 'Semantic (required)', hint: 'Errors if embeddings are unavailable.' },
];

export default function ChatEngineToggle() {
  const queryClient = useQueryClient();
  const { row, chatEngine, ragRolloutPct, retrievalMode } = useChatConfig();
  const system = useSystemConfig();

  const save = async (patch) => {
    try {
      if (row) {
        await base44.entities.AppConfig.update(row.id, patch);
      } else {
        await base44.entities.AppConfig.create({
          key: CHAT_CONFIG_KEY,
          chat_engine: 'legacy',
          rag_rollout_pct: 0,
          ...patch,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['app-config', CHAT_CONFIG_KEY] });
      toast.success('Chatbot engine settings saved');
    } catch (err) {
      toast.error('Failed to save: ' + (err?.message || 'Unknown error'));
    }
  };

  const saveSystem = async (patch) => {
    try {
      if (system.row) {
        await base44.entities.AppConfig.update(system.row.id, patch);
      } else {
        await base44.entities.AppConfig.create({
          key: SYSTEM_CONFIG_KEY,
          require_verification_for_retrieval: false,
          require_ingestion_review: false,
          governance_ranking_enabled: true,
          answer_logging_enabled: false,
          ...patch,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['app-config', SYSTEM_CONFIG_KEY] });
      toast.success('Governance settings saved');
    } catch (err) {
      toast.error('Failed to save: ' + (err?.message || 'Unknown error'));
    }
  };

  const systemFlagValue = (key) => {
    if (key === 'governance_ranking_enabled') return system.governanceRanking;
    if (key === 'require_verification_for_retrieval') return system.requireVerification;
    if (key === 'require_ingestion_review') return system.requireIngestionReview;
    if (key === 'answer_logging_enabled') return system.answerLogging;
    return false;
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Bot className="w-4 h-4 text-primary" />
          Chatbot engine
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            Legacy (<code>askKnowledgeBase</code>) is the production default. Switch to RAG
            (<code>askKnowledgeBaseV2</code>) only after the test matrix passes. RAG needs at least
            some classified, indexed trainings — an embeddings key is optional (see Retrieval mode).
          </span>
        </div>

        <div className="flex gap-2">
          {['legacy', 'rag'].map((eng) => (
            <button
              key={eng}
              onClick={() => save({ chat_engine: eng })}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all border ${
                chatEngine === eng
                  ? 'bg-primary text-white border-primary'
                  : 'bg-card text-muted-foreground border-border hover:border-primary/50'
              }`}
            >
              {eng === 'legacy' ? 'Legacy (production)' : 'RAG (askKnowledgeBaseV2)'}
            </button>
          ))}
        </div>

        <div>
          <Label className="text-sm text-muted-foreground mb-2 block">
            Retrieval mode (RAG engine)
          </Label>
          <div className="flex flex-wrap gap-2">
            {RETRIEVAL_MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => save({ retrieval_mode: m.value })}
                title={m.hint}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                  retrievalMode === m.value
                    ? 'bg-primary text-white border-primary'
                    : 'bg-card text-muted-foreground border-border hover:border-primary/50'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground/70 mt-1.5">
            {RETRIEVAL_MODES.find((m) => m.value === retrievalMode)?.hint}
            {' '}Embeddings are optional — the knowledge base works without <code>EMBEDDINGS_API_KEY</code>.
          </p>
        </div>

        <div>
          <Label className="text-sm text-muted-foreground mb-2 block">
            Canary rollout to RAG while engine is Legacy (% of users, by stable id hash)
          </Label>
          <div className="flex gap-2 items-center">
            <Input
              type="number"
              min={0}
              max={100}
              defaultValue={ragRolloutPct}
              key={ragRolloutPct}
              onBlur={(e) => {
                const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                if (v !== ragRolloutPct) save({ rag_rollout_pct: v });
              }}
              className="w-28 bg-background"
            />
            <span className="text-xs text-muted-foreground">
              {chatEngine === 'rag' ? 'Ignored — engine is already RAG for everyone.' : `${ragRolloutPct}% of users on RAG.`}
            </span>
          </div>
        </div>

        <div className="pt-2 border-t border-border">
          <Label className="text-sm text-muted-foreground mb-2 block">
            System / governance (RAG engine)
          </Label>
          <div className="space-y-2">
            {SYSTEM_FLAGS.map((f) => {
              const on = systemFlagValue(f.key);
              return (
                <div key={f.key} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{f.label}</div>
                    <p className="text-xs text-muted-foreground/70">{f.hint}</p>
                  </div>
                  <button
                    onClick={() => saveSystem({ [f.key]: !on })}
                    className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                      on
                        ? 'bg-primary text-white border-primary'
                        : 'bg-card text-muted-foreground border-border hover:border-primary/50'
                    }`}
                  >
                    {on ? 'On' : 'Off'}
                  </button>
                </div>
              );
            })}
          </div>
          {system.requireVerification && (
            <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>
                Verification gating is on. Only <code>verified</code> sources answer — any knowledge
                still <code>unverified</code> will not be used until an admin verifies it.
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
