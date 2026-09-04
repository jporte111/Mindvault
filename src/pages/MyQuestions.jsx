import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card } from '@/components/ui/card';
import { MessageCircleQuestion, Loader2, Send } from 'lucide-react';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';
import EmptyState from '@/components/common/EmptyState';

// Phase 5. The employee's own clarification threads. Owner-scoped via
// getMyClarifications. Nothing here is knowledge; the SME's replies are a human
// conversation, not retrieved guidance.
export default function MyQuestions() {
  const queryClient = useQueryClient();
  const { clarificationsEnabled } = useSystemConfig();
  const [drafts, setDrafts] = useState({});
  const [busyId, setBusyId] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['my-clarifications'],
    queryFn: () => base44.functions.invoke('getMyClarifications', {}).then((r) => r?.data ?? r),
    enabled: clarificationsEnabled,
  });
  const threads = data?.clarifications || [];

  const reply = async (id) => {
    const message = (drafts[id] || '').trim();
    if (!message) return;
    setBusyId(id);
    try {
      await base44.functions.invoke('replyToClarification', { clarificationRequestId: id, message });
      setDrafts((d) => ({ ...d, [id]: '' }));
      queryClient.invalidateQueries({ queryKey: ['my-clarifications'] });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-8 space-y-4">
      <div className="flex items-center gap-2">
        <MessageCircleQuestion className="w-5 h-5 text-primary" />
        <h1 className="font-sora text-xl font-bold">My questions</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Follow-ups you sent to a subject-matter expert. Replies here are a conversation — they don&apos;t
        change the assistant&apos;s answers directly.
      </p>

      {!clarificationsEnabled && (
        <div className="text-sm text-muted-foreground bg-muted/40 border border-border rounded-lg px-3 py-2">
          The clarification workflow isn&apos;t enabled.
        </div>
      )}

      {clarificationsEnabled && isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      )}

      {clarificationsEnabled && !isLoading && threads.length === 0 && (
        <EmptyState
          icon={MessageCircleQuestion}
          title="No open questions"
          body="When an answer from the AI Assistant doesn't fully help, you can send it to an expert. Your conversations with them show up here so you can follow up."
          action={{ label: 'Ask the AI Assistant', href: '/chat' }}
        />
      )}

      {threads.map((t) => (
        <Card key={t.id} className="p-4 space-y-3 border-border">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t.normalized_topic || 'Clarification'}</span>
            <span className="text-xs text-muted-foreground capitalize">{String(t.status || '').replace(/_/g, ' ')}</span>
          </div>
          <div className="space-y-2">
            {(t.messages || []).map((m) => (
              <div
                key={m.id}
                className={`text-sm rounded-lg px-3 py-2 ${
                  m.sender_type === 'sme'
                    ? 'bg-primary/5 border border-primary/20'
                    : 'bg-muted/50 border border-border'
                }`}
              >
                <div className="text-[11px] text-muted-foreground mb-0.5">
                  {m.sender_type === 'sme' ? 'Subject-matter expert' : 'You'}
                </div>
                <p className="leading-relaxed whitespace-pre-wrap">{m.message}</p>
              </div>
            ))}
            {(t.messages || []).length === 0 && (
              <p className="text-xs text-muted-foreground">No messages yet.</p>
            )}
          </div>
          {t.status !== 'not_applicable' && (
            <div className="flex gap-2">
              <textarea
                value={drafts[t.id] || ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value.slice(0, 2000) }))}
                rows={2}
                placeholder="Add a reply…"
                className="flex-1 rounded border border-input bg-card px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                onClick={() => reply(t.id)}
                disabled={busyId === t.id || !(drafts[t.id] || '').trim()}
                className="h-9 w-9 rounded bg-primary text-white flex items-center justify-center disabled:opacity-40 self-end"
              >
                {busyId === t.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
