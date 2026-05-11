import { useState, useRef, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import ChatMessage from '@/components/chat/ChatMessage';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Sparkles, Send, Lightbulb } from 'lucide-react';

const SUGGESTED_QUESTIONS = [
  'What are the key steps in our sales process?',
  'How do we handle customer objections?',
  'What does the onboarding process look like for new hires?',
  'What are our core company values?',
];

export default function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async (questionText) => {
    const question = questionText || input.trim();
    if (!question || loading) return;

    setInput('');
    setMessages(prev => [...prev,
      { role: 'user', content: question },
      { role: 'assistant', loading: true, content: '' }
    ]);
    setLoading(true);

    const res = await base44.functions.invoke('askKnowledgeBase', { question });
    const { answer, sources } = res.data;

    setMessages(prev => {
      const updated = [...prev];
      updated[updated.length - 1] = { role: 'assistant', content: answer, sources };
      return updated;
    });
    setLoading(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="h-screen bg-background flex flex-col">
      {/* Header */}
      <div className="bg-card border-b border-border px-6 py-5 flex-shrink-0">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-md shadow-primary/25">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="font-sora font-semibold text-foreground">AI Knowledge Assistant</h1>
            <p className="text-xs text-muted-foreground">Ask anything about your company trainings</p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
          {messages.length === 0 ? (
            <div className="text-center py-16">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Sparkles className="w-8 h-8 text-primary" />
              </div>
              <h2 className="font-sora font-semibold text-foreground text-xl mb-2">Ask the Knowledge Base</h2>
              <p className="text-muted-foreground text-sm max-w-md mx-auto mb-8 leading-relaxed">
                I can search through all your training recordings and transcripts to answer any question instantly.
              </p>

              <div className="grid sm:grid-cols-2 gap-3 max-w-xl mx-auto text-left">
                {SUGGESTED_QUESTIONS.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => sendMessage(q)}
                    className="p-4 rounded-xl border border-border bg-card hover:bg-accent/50 hover:border-primary/40 transition-all text-left text-sm text-muted-foreground hover:text-foreground group"
                  >
                    <Lightbulb className="w-3.5 h-3.5 text-primary mb-2 group-hover:scale-110 transition-transform" />
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <ChatMessage key={i} message={msg} />
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="bg-card border-t border-border px-6 py-4 flex-shrink-0">
        <div className="max-w-3xl mx-auto flex gap-3 items-end">
          <Textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your company trainings..."
            className="resize-none min-h-[48px] max-h-32 text-sm bg-background border-border"
            rows={1}
          />
          <Button
            onClick={() => sendMessage()}
            disabled={!input.trim() || loading}
            className="bg-primary hover:bg-primary/90 h-12 w-12 p-0 flex-shrink-0 shadow-md shadow-primary/25"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
        <p className="text-center text-xs text-muted-foreground/60 mt-2 max-w-3xl mx-auto">
          Press Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}