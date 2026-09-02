import { ExternalLink, BookOpen, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router-dom';

// Phase 4 — Operational Guidance answer mode. Status is a grounding/coverage
// measure (NOT an authority measure); authority is a separate per-section chip.
const STATUS_META = {
  HIGH: { label: 'Fully supported by available knowledge', cls: 'bg-green-100 text-green-800 border-green-200' },
  PARTIAL: { label: 'Partial — some details not documented', cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  INSUFFICIENT: { label: 'Not documented', cls: 'bg-muted text-muted-foreground border-border' },
};
const AUTHORITY_LABEL = {
  authoritative: 'Approved policy / SOP',
  advisory: 'Training notes / reference',
  mixed: 'Multiple source types',
  unknown: 'Authority not classified',
};

function AuthorityChip({ a }) {
  if (!a) return null;
  const isAuth = a === 'authoritative';
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 ${
        isAuth ? 'border-primary/40 text-primary' : 'border-border text-muted-foreground'
      }`}
    >
      {AUTHORITY_LABEL[a] || a}
    </span>
  );
}

function OperationalAnswer({ status, data, fallbackMarkdown }) {
  const sm = STATUS_META[status] || STATUS_META.INSUFFICIENT;
  return (
    <div className="space-y-3 text-sm text-foreground">
      <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${sm.cls}`}>
        {sm.label}
      </span>

      {status === 'INSUFFICIENT' || !data ? (
        <p className="leading-relaxed text-muted-foreground">{fallbackMarkdown}</p>
      ) : (
        <>
          {data.direct_answer?.text && (
            <div className="space-y-1.5">
              <p className="leading-relaxed">{data.direct_answer.text}</p>
              <AuthorityChip a={data.direct_answer.authority} />
            </div>
          )}

          {(data.sections || []).map((s) => (
            <div key={s.key} className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold">{s.title}</h3>
                <AuthorityChip a={s.authority} />
              </div>
              <ul className="list-disc pl-5 space-y-1 marker:text-primary/60">
                {(s.items || []).map((it, i) => (
                  <li key={i} className="leading-relaxed">{it.text}</li>
                ))}
              </ul>
            </div>
          ))}

          {data.missing_facets?.length > 0 && (
            <p>
              <span className="font-semibold">Not documented:</span>{' '}
              {data.missing_facets.join(', ')}.
            </p>
          )}

          {data.contradiction_note && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {data.contradiction_note}
            </div>
          )}

          {data.stale_sources?.length > 0 && (
            <p className="text-xs text-muted-foreground">
              ⚠ Some sources for this answer are overdue for review:{' '}
              {data.stale_sources.map((x) => x.title).join(', ')}.
            </p>
          )}

          {data.unverified_used && (
            <p className="text-xs text-muted-foreground/70">Based on unverified knowledge.</p>
          )}
        </>
      )}
    </div>
  );
}

export default function ChatMessage({ message }) {
  const isUser = message.role === 'user';
  const isOperational = message.answerMode === 'operational';

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-3 shadow-md shadow-primary/20">
          <p className="text-sm leading-relaxed">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 items-start">
      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center flex-shrink-0 shadow-md shadow-primary/25 mt-0.5">
        <Sparkles className="w-4 h-4 text-white" />
      </div>
      <div className="flex-1 space-y-3 max-w-[85%]">
        <div className="bg-card border border-border rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
          {message.loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              Searching knowledge base...
            </div>
          ) : isOperational ? (
            <OperationalAnswer
              status={message.answerStatus}
              data={message.operationalAnswer}
              fallbackMarkdown={message.content}
            />
          ) : (
            <ReactMarkdown
              className="text-sm max-w-none text-foreground leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              components={{
                h1: ({ node, ...p }) => <h1 className="text-base font-bold mt-4 mb-2 text-foreground" {...p} />,
                h2: ({ node, ...p }) => <h2 className="text-base font-bold mt-4 mb-2 text-foreground flex items-center gap-2" {...p} />,
                h3: ({ node, ...p }) => <h3 className="text-sm font-semibold mt-3 mb-1.5 text-foreground" {...p} />,
                p: ({ node, ...p }) => <p className="my-2 leading-relaxed" {...p} />,
                ul: ({ node, ...p }) => <ul className="my-2 list-disc pl-5 space-y-1.5 marker:text-primary/60" {...p} />,
                ol: ({ node, ...p }) => <ol className="my-2 list-decimal pl-5 space-y-1.5 marker:text-primary/60 font-medium" {...p} />,
                li: ({ node, ...p }) => <li className="leading-relaxed pl-1" {...p} />,
                strong: ({ node, ...p }) => <strong className="font-semibold text-foreground" {...p} />,
                em: ({ node, ...p }) => <em className="italic text-foreground" {...p} />,
                blockquote: ({ node, ...p }) => <blockquote className="my-2.5 border-l-2 border-primary/50 pl-3 italic text-muted-foreground" {...p} />,
                hr: ({ node, ...p }) => <hr className="my-3 border-border" {...p} />,
                a: ({ node, ...p }) => <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer" {...p} />,
                code: ({ node, ...p }) => <code className="bg-muted px-1.5 py-0.5 rounded text-[0.85em] font-mono" {...p} />,
                pre: ({ node, ...p }) => <pre className="my-2.5 bg-muted p-3 rounded-lg overflow-x-auto text-xs" {...p} />,
                table: ({ node, ...p }) => <div className="my-3 overflow-x-auto"><table className="w-full text-xs border border-border rounded-lg" {...p} /></div>,
                th: ({ node, ...p }) => <th className="bg-muted px-3 py-2 text-left font-semibold border-b border-border" {...p} />,
                td: ({ node, ...p }) => <td className="px-3 py-2 border-b border-border/60 align-top" {...p} />,
              }}
            >
              {message.content}
            </ReactMarkdown>
          )}
        </div>

        {message.sources?.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground font-medium pl-1">Referenced trainings:</p>
            {message.sources.map((source) => (
              <Link key={source.id} to={`/training/${source.id}`}>
                <Card className="p-3 flex items-center gap-3 hover:bg-accent/50 transition-colors cursor-pointer border-border group">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <BookOpen className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors truncate">{source.title}</p>
                    {source.category && (
                      <p className="text-xs text-muted-foreground">{source.category}</p>
                    )}
                  </div>
                  <ExternalLink className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0" />
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}