import { ExternalLink, BookOpen, Sparkles, User } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router-dom';

export default function ChatMessage({ message }) {
  const isUser = message.role === 'user';

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