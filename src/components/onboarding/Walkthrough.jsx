import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';
import { WALKTHROUGH_STEPS, resolveStepAction, WALKTHROUGH_SEEN_KEY } from '@/lib/walkthroughSteps';

const readLS = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writeLS = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable — the app must not crash; the tour may just reappear later */
  }
};

// Onboarding-2 — a short, optional, skippable, reopenable admin walkthrough.
// Built entirely from the existing Dialog primitive: no third-party tour
// library, no DOM-element spotlighting, no automatic navigation between
// steps. Onboarding state lives only in localStorage, never Base44 — no new
// entity, no AppConfig flag — and every access is best-effort (try/catch).
//
// Reopen: a parent (AppLayout) mounts this once and holds a ref. The visible
// Help trigger in Sidebar / MobileNav calls ref.current.open() to reopen the
// tour even after mv_onboarding_seen is already 'true'.
const Walkthrough = forwardRef(function Walkthrough(_props, ref) {
  const isAdmin = useIsAdmin();
  const { knowledgeHealthEnabled } = useSystemConfig();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  // Auto-open once per device: admin only, and only when this device has
  // never dismissed the tour before.
  useEffect(() => {
    if (isAdmin && readLS(WALKTHROUGH_SEEN_KEY) !== 'true') {
      setOpen(true);
    }
  }, [isAdmin]);

  useImperativeHandle(ref, () => ({
    open: () => {
      setStep(0);
      setOpen(true);
    },
  }), []);

  if (!isAdmin) return null;

  const total = WALKTHROUGH_STEPS.length;
  const current = WALKTHROUGH_STEPS[step];
  const action = resolveStepAction(current, { knowledgeHealthEnabled });
  const isLast = step === total - 1;

  // Skip, Finish, and any intentional close (Escape, overlay click, the X
  // button) all mean the same thing: remember this device has seen the tour.
  const dismiss = () => {
    writeLS(WALKTHROUGH_SEEN_KEY, 'true');
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : dismiss())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{current.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-sm text-foreground leading-relaxed">{current.copy}</p>
          {current.secondary && (
            <p className="text-xs text-muted-foreground leading-relaxed">{current.secondary}</p>
          )}
          {action.disabledNote && (
            <p className="text-xs text-amber-700">{action.disabledNote}</p>
          )}
          {action.href && (
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={() => navigate(action.href)}>
              {action.label}
            </Button>
          )}
        </div>

        <div className="flex items-center justify-center gap-1.5 pt-1" aria-hidden="true">
          {WALKTHROUGH_STEPS.map((s, i) => (
            <span key={s.id} className={`w-1.5 h-1.5 rounded-full ${i === step ? 'bg-primary' : 'bg-muted'}`} />
          ))}
        </div>
        <p className="text-center text-[11px] text-muted-foreground">Step {step + 1} of {total}</p>

        <DialogFooter className="sm:justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={dismiss}>Skip tour</Button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                Back
              </Button>
            )}
            {isLast ? (
              <Button type="button" size="sm" onClick={dismiss}>Finish</Button>
            ) : (
              <Button type="button" size="sm" onClick={() => setStep((s) => Math.min(total - 1, s + 1))}>
                Next
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export default Walkthrough;
