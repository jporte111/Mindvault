import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageCircleQuestion, Send } from 'lucide-react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useTenantRole } from '@/hooks/useTenantRole';
import { answerAdminHelpQuestion, getStarterPrompts } from '@/lib/adminHelp';

// A bounded local conversation only — never persisted, never sent anywhere.
// A fresh conversation on refresh is expected and fine for V1.
const MAX_MESSAGES = 40;

// Admin Help Assistant — ongoing conversational product support for admins,
// separate from the employee-facing AI Assistant. Entirely client-side and
// deterministic: it answers only from the curated corpus in
// src/lib/adminHelp (never customer knowledge), performs no writes, and
// makes no network call. Admin-only.
export default function AdminHelpAssistant() {
  const isAdmin = useIsAdmin();
  const { isClientAdmin } = useTenantRole();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');

  // Product help is available to platform admins AND Client Admins — both
  // configure MindVault for their organization.
  if (!isAdmin && !isClientAdmin) return null;
  const helpLabel = isAdmin ? 'Admin Help' : 'Help';

  const ask = (question) => {
    const q = String(question || '').trim();
    if (!q) return;
    // Route is the only "page context" passed in — a route string, nothing
    // from the DOM, no employee data, no entity payload.
    const result = answerAdminHelpQuestion(q, { route: location.pathname });
    setMessages((prev) => {
      const next = [
        ...prev,
        { role: 'user', text: q },
        { role: 'assistant', text: result.answer, sources: result.sources, navigation: result.navigation },
      ];
      return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
    });
    setDraft('');
  };

  const onSubmit = (e) => {
    e.preventDefault();
    ask(draft);
  };

  const starterPrompts = getStarterPrompts(location.pathname);

  return (
    <>
      {/* Persistent launcher — bottom-right on desktop, offset above the
          mobile bottom tab bar on mobile. Never navigates the admin away. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed z-40 bottom-20 md:bottom-6 right-4 md:right-6 h-12 px-4 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 flex items-center gap-2 text-sm font-medium hover:bg-primary/90 transition-colors"
        aria-label="Ask MindVault — Help"
      >
        <MessageCircleQuestion className="w-4 h-4" />
        <span className="hidden sm:inline">{helpLabel}</span>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md flex flex-col p-0 gap-0">
          <SheetHeader className="p-4 border-b border-border text-left space-y-1">
            <SheetTitle>MindVault Help</SheetTitle>
            <SheetDescription>Ask how to configure and use MindVault.</SheetDescription>
            <p className="text-[11px] text-muted-foreground pt-1">
              This assistant explains MindVault. It does not answer questions from your company knowledge —
              use the AI Assistant for that.
            </p>
          </SheetHeader>

          <ScrollArea className="flex-1 min-h-0">
            <div className="p-4 space-y-3">
              {messages.length === 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Try asking:</p>
                  {starterPrompts.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => ask(p)}
                      className="block w-full text-left text-sm rounded-lg border border-border px-3 py-2 hover:bg-muted/50 hover:border-primary/40 transition-colors"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}

              {messages.map((m, i) => (
                <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
                  <div
                    className={`inline-block max-w-[90%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed text-left ${
                      m.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-foreground'
                    }`}
                  >
                    {m.text}
                  </div>
                  {m.role === 'assistant' && m.sources?.length > 0 && (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Based on: {m.sources.map((s) => s.title).join(' · ')}
                    </p>
                  )}
                  {m.role === 'assistant' && m.navigation?.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {m.navigation.map((n) => (
                        <Button
                          key={n.route}
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => navigate(n.route)}
                        >
                          {n.label}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>

          <form onSubmit={onSubmit} className="p-3 border-t border-border flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask how to use MindVault…"
              className="min-h-[44px] max-h-32 resize-none text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  ask(draft);
                }
              }}
            />
            <Button type="submit" size="icon" disabled={!draft.trim()} aria-label="Send">
              <Send className="w-4 h-4" />
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}