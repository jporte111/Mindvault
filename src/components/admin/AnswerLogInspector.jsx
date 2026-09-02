import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollText, Loader2, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';

// Read-only view of recent AnswerLog rows. Knowledge-quality analytics only:
// there is deliberately NO asking-user column and no per-employee grouping.
// Rows exist only when the answer_logging_enabled flag is on.

const CONF_COLOR = {
  high: 'bg-green-100 text-green-800 border-green-200',
  medium: 'bg-amber-100 text-amber-800 border-amber-200',
  low: 'bg-red-100 text-red-800 border-red-200',
};

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export default function AnswerLogInspector() {
  const [expanded, setExpanded] = useState(null);

  const { data: rows = [], isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['answer-log', 'recent'],
    // Base44 built-in created_date drives ordering.
    queryFn: () => base44.entities.AnswerLog.list('-created_date', 100),
  });

  return (
    <Card className="border-border">
      <CardHeader className="pb-4">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <ScrollText className="w-4 h-4 text-primary" />
          AI answer log
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 gap-1 text-xs"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground/70">
          Recent RAG answers for knowledge-quality review. Populated only while{' '}
          <code>answer_logging_enabled</code> is on. No employee identifier is recorded.
        </p>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {isError && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            Couldn’t load the answer log. It needs admin access and at least one logged answer.
          </div>
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <div className="text-sm text-muted-foreground py-6 text-center">
            No answers logged yet.
          </div>
        )}

        {rows.length > 0 && (
          <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
            {rows.map((r) => {
              const isOpen = expanded === r.id;
              const scores = isOpen ? safeParse(r.retrieval_scores) : null;
              const filtered = isOpen ? safeParse(r.filtered_out_counts) : null;
              return (
                <div key={r.id} className="text-sm">
                  <button
                    className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-muted/40"
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                  >
                    {isOpen ? (
                      <ChevronDown className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{r.question || r.standalone_query || '(no question text)'}</div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                        <Badge variant="outline" className={CONF_COLOR[r.confidence] || ''}>
                          {r.confidence || '—'}
                        </Badge>
                        <Badge variant="outline">{r.retrieval_mode || '—'}</Badge>
                        <Badge variant="outline">{r.answer_status || '—'}</Badge>
                        <span>{r.client_scope || 'general'}</span>
                        <span>· {Number(r.latency_ms) || 0} ms</span>
                        <span>· {(r.final_source_ids || []).length} sources</span>
                        <span>· {fmtTime(r.created_date)}</span>
                      </div>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="px-9 pb-3 pt-1 space-y-2 text-xs bg-muted/20">
                      <div>
                        <span className="text-muted-foreground">Standalone query: </span>
                        {r.standalone_query || '—'}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Retrieved chunk ids: </span>
                        {(r.retrieved_chunk_ids || []).join(', ') || '—'}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Final source ids: </span>
                        {(r.final_source_ids || []).join(', ') || '—'}
                      </div>
                      {filtered && Object.keys(filtered).length > 0 && (
                        <div>
                          <span className="text-muted-foreground">Governance-filtered: </span>
                          {Object.entries(filtered).map(([k, v]) => `${k}×${v}`).join(', ')}
                        </div>
                      )}
                      {Array.isArray(scores) && scores.length > 0 && (
                        <div className="overflow-x-auto">
                          <table className="text-xs border-collapse">
                            <thead>
                              <tr className="text-muted-foreground">
                                <th className="text-left pr-3">chunk</th>
                                <th className="text-left pr-3">sem</th>
                                <th className="text-left pr-3">lex</th>
                                <th className="text-left">score</th>
                              </tr>
                            </thead>
                            <tbody>
                              {scores.map((s, i) => (
                                <tr key={s.id || i}>
                                  <td className="pr-3 font-mono">{s.id}</td>
                                  <td className="pr-3">{s.sem}</td>
                                  <td className="pr-3">{s.lex}</td>
                                  <td>{s.score}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
