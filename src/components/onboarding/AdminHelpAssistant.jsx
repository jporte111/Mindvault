import { useState, useEffect } from 'react';
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
import { useClientSetup, useTenantName } from '@/hooks/useClientSetup';
import { answerAdminHelpQuestion, getStarterPrompts } from '@/lib/adminHelp';
import { buildSupportContext } from '@/lib/supportContext';

// The Help AI opens as a side panel without leaving the current page — the
// sidebar's Help item and every "Ask MindVault" button dispatch this event.
export const OPEN_HELP_EVENT = 'mindvault:open-help';

// A bounded local conversation only — never persisted, never sent anywhere.
// A fresh conversation on refresh is expected and fine for V1.
const MAX_MESSAGES = 40;

// MindVault Help — the contextual setup copilot for Client Admins and the
// product-help assistant for platform admins, separate from the
// employee-facing AI Assistant. Entirely client-side and deterministic: it
// answers only from the curated corpus in src/lib/adminHelp plus the live
// setup context derived from the caller's own data (never customer
// knowledge), performs no writes, and makes no network call.
export default function AdminHelpAssistant() {
  const isAdmin = useIsAdmin();
  const { isClientAdmin } = useTenantRole();
  const setup = useClientSetup();
  const tenantName = useTenantName();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const openHelp = () => setOpen(true);
    window.addEventListener(OPEN_HELP_EVENT, openHelp);
    return () => window.removeEventListener(OPEN_HELP_EVENT, openHelp);
  }, []);

  // Product help is available to platform admins AND Client Admins — both
  // configure MindVault for their organization.
  if (!isAdmin && !isClientAdmin) return null;
  const helpLabel = isClientAdmin ? 'Help' : 'Admin Help';

  // Setup context makes answers situational: the copilot knows the tenant's
  // setup progress, the user's role, the current page, and the live counts of
  // knowledge, team members, and processes. Read-only derived data only.
  const buildSetupContext = () => {
    if (!isClientAdmin) return null;
    const { items, progressPct, setupComplete, nextItem, sources, members, processes, loading } = setup;
    return {
      role: 'client_admin',
      loading,
      progressPct,
      setupComplete,
      nextItem: nextItem
        ? {
            label: nextItem.label,
            why: nextItem.why,
            how: nextItem.how,
            doneWhen: nextItem.doneWhen,
            actionLabel: nextItem.actionLabel,
            actionHref: nextItem.actionHref,
          }
        : null,
      items: items.map(({ id, label, state, required }) => ({ id, label, state, required })),
      counts: {
        knowledge: Array.isArray(sources) ? sources.length : null,
        members: Array.isArray(members) ? members.length : null,
        processes: Array.isArray(processes) ? processes.length : null,
      },
    };
  };

  // The caller's app-level role — the one categorical fact the assistant
  // needs, never a tenant id or membership row.
  const userRole = isAdmin ? 'super_admin' : isClientAdmin ? 'client_admin' : 'client_user';

  const ask = (question) => {
    const q = String(question || '').trim();
    if (!q) return;
    // Context passed to the planner: the current route + hash, derived
    // read-only setup state, the recent conversation turns, and a
    // structured runtime support context (current page/section, role,
    // workspace name, onboarding progress, and the most recent captured
    // application error/action). Nothing from the DOM, no employee data,
    // no entity payload, no security-sensitive fields.
    const routeWithHash = `${location.pathname}${location.hash || ''}`;
    const setupCtx = buildSetupContext();
    const result = answerAdminHelpQuestion(q, {
      route: routeWithHash,
      setup: setupCtx,
      history: messages.slice(-10).map(({ role, text }) => ({ role, text })),
      supportContext: buildSupportContext({
        route: routeWithHash,
        userRole,
        tenantName: tenantName || null,
        setup: setupCtx
          ? {
              progressPct: setupCtx.progressPct,
              setupComplete: setupCtx.setupComplete,
              nextItem: setupCtx.nextItem
                ? { id: undefined, label: setupCtx.nextItem.label }
                : null,
              counts: setupCtx.counts,
              items: setupCtx.items,
            }
          : null,
      }),
    });
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
            <SheetDescription>Ask how to set up and use MindVault.</SheetDescription>
            <p className="text-[11px] text-muted-foreground pt-1">
              This assistant explains MindVault and your setup progress. It does not answer questions
              from your company knowledge — use the AI Assistant for that.
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
                          onClick={() => {
                            // Close the panel so the destination is actually
                            // visible — otherwise a deep link to the page
                            // you're already on looks like a dead button.
                            setOpen(false);
                            navigate(n.route);
                          }}
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