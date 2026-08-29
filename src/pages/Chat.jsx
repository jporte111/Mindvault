import { useState, useRef, useEffect } from 'react';
import { Sparkles, Send, Database, AlertCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';
import ChatMessage from '@/components/chat/ChatMessage';

export default function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasContent, setHasContent] = useState(true);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    base44.entities.Training.filter({ status: 'ready' })
      .then((rows) => setHasContent(rows.length > 0))
      .catch(() => setHasContent(true));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const ask = async (e) => {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    const userMsg = { role: 'user', content: question };
    const pendingMsg = { role: 'assistant', content: '', loading: true };
    setMessages((m) => [...m, userMsg, pendingMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await base44.functions.invoke('askKnowledgeBase', { question });
      setMessages((m) => {
        const next = [...m];
        next[next.length - 1] = {
          role: 'assistant',
          content: res.answer || 'No answer returned.',
          sources: res.sources || [],
        };
        return next;
      });
    } catch (err) {
      setMessages((m) => {
        const next = [...m];
        next[next.length - 1] = {
          role: 'assistant',
          content: `Sorry — I couldn't reach the knowledge base. ${err?.message || ''}`,
          error: true,
        };
        return next;
      });
      toast.error('Knowledge base request failed');
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem-env(safe-area-inset-top))] md:h-screen">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 md:px-6 py-6 space-y-5">
        <div className="max-w-3xl mx-auto">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center text-center py-16">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
                <Sparkles className="w-8 h-8 text-primary" />
              </div>
              <h1 className="font-sora text-2xl font-bold text-foreground mb-2">AI Assistant</h1>
              <p className="text-muted-foreground text-sm max-w-md leading-relaxed">
                Ask anything about your training library — SOPs, decision rules, common mistakes, and past sessions. Answers cite the source trainings.
              </p>
              {!hasContent && (
                <div className="mt-6 flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-amber-700 text-sm max-w-md">
                  <Database className="w-4 h-4 flex-shrink-0" />
                  <span>No analyzed trainings yet. An admin needs to sync and analyze recordings first.</span>
                </div>
              )}
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className="mb-5 last:mb-0">
              <ChatMessage message={msg} />
              {msg.error && (
                <div className="flex items-center gap-1.5 text-xs text-destructive mt-1.5 pl-11">
                  <AlertCircle className="w-3.5 h-3.5" />
                  Request failed
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-border bg-background/95 backdrop-blur px-4 md:px-6 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <form onSubmit={ask} className="max-w-3xl mx-auto flex items-center gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            placeholder={hasContent ? 'Ask about a training, SOP, or decision rule...' : 'Knowledge base is empty — sync trainings first'}
            className="flex-1 h-11 rounded-full border border-input bg-card px-5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="h-11 w-11 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-md shadow-primary/20 hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}