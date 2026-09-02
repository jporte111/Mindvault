import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MessagesSquare, Loader2, RefreshCw } from 'lucide-react';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';

// Phase 5. SME/admin view of clarification threads. The SME's reply is a human
// message — NEVER knowledge, never retrieved. "Needs a knowledge change" just
// points at the gap / source; it edits nothing.
export default function ClarificationQueue() {
  const queryClient = useQueryClient();
  const { clarificationsEnabled } = useSystemConfig();
  const [drafts, setDrafts] = useState({});
  const [busyId, setBusyId] = useState(null);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['clarifications-admin'],
    queryFn: () => base44.functions.invoke('getMyClarifications', { all: true }).then((r) => r?.data ?? r),
    enabled: clarificationsEnabled,
  });
  const threads = (data?.clarifications || []).filter((t) => !['not_applicable', 'knowledge_updated'].includes(t.status));

  const respond = async (id, extra) => {
    setBusyId(id);
    try {
      await base44.functions.invoke('respondToClarification', { clarificationRequestId: id, ...extra });
      setDrafts((d) => ({ ...d, [id]: '' }));
      queryClient.invalidateQueries({ queryKey: ['clarifications-admin'] });
    } finally {
      setBusyId(null);
    }
  };

  if (!clarificationsEnabled) return null;

  return (
    <Card className="border-border">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <MessagesSquare className="w-4 h-4 text-primary" />
          Clarification queue
          <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Refresh
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {!isLoading && threads.length === 0 && (
          <div className="text-sm text-muted-foreground py-6 text-center">No open clarification threads.</div>
        )}

        {threads.map((t) => (
          <div key={t.id} className="border border-border rounded-lg p-3 text-sm space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{t.normalized_topic || 'Clarification'}</span>
              <div className="flex items-center gap-1.5">
                <Badge variant="outline">{t.client_scope}</Badge>
                <span className="text-xs text-muted-foreground capitalize">{String(t.status).replace(/_/g, ' ')}</span>
              </div>
            </div>
            <div className="space-y-1.5">
              {(t.messages || []).map((m) => (
                <div key={m.id} className={`text-xs rounded px-2 py-1.5 ${m.sender_type === 'sme' ? 'bg-primary/5' : 'bg-muted/50'}`}>
                  <span className="text-muted-foreground">{m.sender_type === 'sme' ? 'SME' : 'Employee'}: </span>
                  <span className="whitespace-pre-wrap">{m.message}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <textarea
                value={drafts[t.id] || ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value.slice(0, 2000) }))}
                rows={2}
                placeholder="Reply to the employee…"
                className="flex-1 rounded border border-input bg-card px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                disabled={busyId === t.id || !(drafts[t.id] || '').trim()}
                onClick={() => respond(t.id, { message: (drafts[t.id] || '').trim() })}
                className="px-2 py-1 rounded bg-primary text-white text-xs disabled:opacity-40"
              >
                Send reply
              </button>
              <button
                disabled={busyId === t.id}
                onClick={() => respond(t.id, { message: (drafts[t.id] || '').trim() || undefined, status: 'answered' })}
                className="px-2 py-1 rounded border border-border text-xs"
              >
                Send &amp; mark answered
              </button>
              <button
                disabled={busyId === t.id}
                onClick={() => respond(t.id, { status: 'not_applicable' })}
                className="px-2 py-1 rounded border border-border text-xs text-muted-foreground"
              >
                Not applicable
              </button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
