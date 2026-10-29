import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Send, Database, AlertCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { toast } from 'sonner';
import ChatMessage from '@/components/chat/ChatMessage';
import ClientSelect from '@/components/knowledge/ClientSelect';
import { useAuth } from '@/lib/AuthContext';
import { useChatConfig, useSystemConfig } from '@/components/admin/ChatEngineToggle';
import { CLIENT_PREFIX, SCOPE_GENERAL } from '@/lib/knowledgeScope';
import { listKnowledgeSources } from '@/lib/scopedData';

// Stable 0-99 bucket for a user id, for canary rollout.
function bucketFor(id) {
  let h = 0;
  for (let i = 0; i < String(id || '').length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
  return h % 100;
}

const CLIENT_STORAGE_KEY = 'mindvault:chatClientScope';

export default function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasContent, setHasContent] = useState(true);
  const [clientScope, setClientScope] = useState(() => {
    try { return localStorage.getItem(CLIENT_STORAGE_KEY) || SCOPE_GENERAL; } catch { return SCOPE_GENERAL; }
  });
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { chatEngine, ragRolloutPct } = useChatConfig();
  const { knowledgeGapsEnabled, clarificationsEnabled } = useSystemConfig();
  const engine = chatEngine === 'rag' || bucketFor(user?.id) < ragRolloutPct ? 'rag' : 'legacy';
  const clientId = clientScope.startsWith(CLIENT_PREFIX) ? clientScope.slice(CLIENT_PREFIX.length) : null;

  useEffect(() => {
    try { localStorage.setItem(CLIENT_STORAGE_KEY, clientScope); } catch { /* ignore */ }
  }, [clientScope]);

  useEffect(() => {
    listKnowledgeSources({ status: 'ready' })
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
    const history = messages
      .filter((m) => !m.loading && !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, userMsg, pendingMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = engine === 'rag'
        ? await base44.functions.invoke('askKnowledgeBaseV2', { question, clientId, conversation: history })
        : await base44.functions.invoke('askKnowledgeBase', { question });
      const data = res?.data ?? res;
      setMessages((m) => {
        const next = [...m];
        next[next.length - 1] = {
          role: 'assistant',
          content: data.answer || "I couldn't find anything in the training library that addresses this. The trainings may not cover this topic, or your question may need rephrasing. Try using more specific terms (e.g., a client name, a software, a workflow step), or check the Library to confirm the relevant training has been synced and analyzed.",
          sources: data.sources || [],
          // Phase 4: present only when operational answer mode fired; the
          // renderer falls back to plain markdown otherwise.
          answerMode: data.answer_mode,
          answerStatus: data.answer_status,
          operationalAnswer: data.operational_answer,
          // Phase 5: context the feedback control needs. The raw question stays
          // client-side only (the server re-derives / re-gates it).
          answerLogId: data.answer_log_id || null,
          standaloneQuery: question,
          operationalProcessId: data.operational_answer?.process_id || null,
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
    <div className="flex flex-col h-[calc(100vh-3.5rem-env(safe-area-inset-top))] md:h-screen" data-tour="chat-page">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 md:px-6 py-6 space-y-5">
        <div className="max-w-3xl mx-auto" data-tour="chat-results">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center text-center py-16">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
                <Sparkles className="w-8 h-8 text-primary" />
              </div>
              <h1 className="font-sora text-2xl font-bold text-foreground mb-2">AI Assistant</h1>
              <p className="text-muted-foreground text-sm max-w-md leading-relaxed">
                Ask anything about how your team works — SOPs, decision rules, common mistakes, past sessions. Answers are grounded only in your approved knowledge and cite their sources.
              </p>
              {!hasContent && (
                <div className="mt-6 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-amber-700 text-sm max-w-md text-left">
                  <Database className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    There’s no knowledge to answer from yet.{' '}
                    {isAdmin
                      ? 'Add and classify knowledge sources so employees can get grounded answers here.'
                      : 'Ask an admin to add and classify knowledge sources — then this assistant can help.'}
                  </span>
                </div>
              )}
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className="mb-5 last:mb-0">
              <ChatMessage
                message={msg}
                feedbackEnabled={engine === 'rag' && knowledgeGapsEnabled && msg.role === 'assistant'}
                clarificationsEnabled={clarificationsEnabled}
                clientScope={clientScope}
              />
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
        {engine === 'rag' && (
          <div className="max-w-3xl mx-auto mb-2 flex items-center gap-2">
            <span className="text-xs text-muted-foreground flex-shrink-0">Answering about:</span>
            <div className="w-56" data-tour="chat-scope-selector">
              <ClientSelect
                value={clientScope}
                onChange={setClientScope}
                includeNeedsReview={false}
                className="h-9"
              />
            </div>
            <span className="text-[11px] text-muted-foreground/70 hidden sm:inline">
              Only this context + firm-wide knowledge is searched.
            </span>
          </div>
        )}
        <form onSubmit={ask} className="max-w-3xl mx-auto flex items-center gap-2">
          <input
            data-tour="chat-input"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            placeholder={hasContent ? 'Ask about a process, SOP, or decision rule…' : 'No knowledge to answer from yet'}
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
        {clarificationsEnabled && (
          <div className="max-w-3xl mx-auto mt-2 text-center">
            <Link
              to="/my-questions"
              className="text-xs text-muted-foreground hover:text-primary underline-offset-2 hover:underline"
            >
              View my past questions
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}