import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bot, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

export const CHAT_CONFIG_KEY = 'chat';

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
  return {
    row: data || null,
    chatEngine: data?.chat_engine === 'rag' ? 'rag' : 'legacy',
    ragRolloutPct: Number(data?.rag_rollout_pct) || 0,
  };
}

export default function ChatEngineToggle() {
  const queryClient = useQueryClient();
  const { row, chatEngine, ragRolloutPct } = useChatConfig();

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
            (<code>askKnowledgeBaseV2</code>) only after the test matrix passes. RAG needs the
            <code> EMBEDDINGS_API_KEY</code> secret and at least some classified, indexed trainings.
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
      </CardContent>
    </Card>
  );
}
