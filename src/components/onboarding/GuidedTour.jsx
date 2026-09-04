import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useSystemConfig } from '@/components/admin/ChatEngineToggle';
import { GUIDED_TOUR_SEEN_KEY, resolveGuidedTourSteps } from '@/lib/guidedTourSteps';

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

// Bounded resolution of a step's DOM target: check immediately, then watch
// for it via MutationObserver (the primary sync mechanism — NOT a sleep
// loop), capped by a timeout so a missing element can never hang the tour.
function resolveElement(step) {
  if (!step) return null;
  const primary = step.selector ? document.querySelector(step.selector) : null;
  if (primary) return primary;
  if (step.fallbackSelector) return document.querySelector(step.fallbackSelector) || null;
  return null;
}

function waitForElement(step, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const immediate = resolveElement(step);
    if (immediate) {
      resolve(immediate);
      return;
    }
    let settled = false;
    const finish = (el) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    };
    const observer = new MutationObserver(() => {
      const found = resolveElement(step);
      if (found) finish(found);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

// Guided Product Tour — replaces the old modal walkthrough with a real,
// page-to-page tour built on driver.js (spotlight, overlay, positioning,
// popovers, and scroll-into-view are all driver.js — nothing hand-built
// here). Admin-only. Mounted once at AppLayout level so it survives route
// changes; the visible Help trigger in Sidebar / MobileNav calls
// ref.current.restart() to run it again regardless of the seen flag.
const GuidedTour = forwardRef(function GuidedTour(_props, ref) {
  const isAdmin = useIsAdmin();
  const { knowledgeHealthEnabled } = useSystemConfig();
  const navigate = useNavigate();
  const location = useLocation();

  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  const steps = useMemo(
    () => resolveGuidedTourSteps({ knowledgeHealthEnabled }),
    [knowledgeHealthEnabled],
  );
  const runTokenRef = useRef(0);

  // Skip, Finish, and any intentional close of the driver.js popover
  // (Escape, overlay click, or its close (x) button — see onCloseClick
  // below) all funnel through driver.js's own destroy() lifecycle, which
  // calls this single onDestroyed hook. This is the one place the seen flag
  // is written and the tour is marked inactive.
  const dismiss = useCallback(() => {
    writeLS(GUIDED_TOUR_SEEN_KEY, 'true');
    setActive(false);
  }, []);

  const driverRef = useRef(null);
  if (driverRef.current === null) {
    driverRef.current = driver({
      animate: true,
      smoothScroll: true,
      allowClose: true,
      allowKeyboardControl: true,
      overlayClickBehavior: 'close',
      stagePadding: 6,
      onDestroyed: dismiss,
    });
  }

  useEffect(() => () => driverRef.current?.destroy(), []);

  // The core route-aware step driver. Re-runs whenever the tour is active,
  // the step index changes, or the route changes (the third dependency is
  // what lets a route navigated to for THIS step's sake resolve back into
  // this same effect once React Router has updated location.pathname).
  useEffect(() => {
    if (!active) return undefined;
    const step = steps[stepIndex];
    if (!step) {
      driverRef.current.destroy();
      return undefined;
    }

    const myToken = ++runTokenRef.current;

    // Cross-route Next/Back: navigate first, then let this effect re-run
    // once React Router reflects the new route — never navigate AND
    // highlight in the same pass, since the target page may not be mounted
    // yet (AppLayout's route transition is itself asynchronous).
    if (location.pathname !== step.route) {
      navigate(step.route);
      return undefined;
    }

    let cancelled = false;
    waitForElement(step).then((el) => {
      if (cancelled || runTokenRef.current !== myToken) return;

      if (!el) {
        // Resilience: a missing target (no records yet, an optional control
        // that isn't shown in this state, or a selector that never
        // appeared) must never crash or strand the tour — skip forward.
        if (stepIndex < steps.length - 1) {
          setStepIndex((i) => i + 1);
        } else {
          driverRef.current.destroy();
        }
        return;
      }

      const total = steps.length;
      const isFirst = stepIndex === 0;
      const isLast = stepIndex === total - 1;
      const description = step.secondary ? `${step.description} ${step.secondary}` : step.description;

      driverRef.current.highlight({
        element: el,
        popover: {
          title: step.title,
          description,
          side: step.placement || 'bottom',
          align: 'start',
          showButtons: isFirst ? ['next', 'close'] : ['next', 'previous', 'close'],
          showProgress: true,
          progressText: `${stepIndex + 1} of ${total}`,
          nextBtnText: isLast ? 'Finish' : 'Next',
          prevBtnText: 'Back',
          onNextClick: () => {
            if (isLast) {
              driverRef.current.destroy();
            } else {
              setStepIndex((i) => Math.min(i + 1, total - 1));
            }
          },
          onPrevClick: () => setStepIndex((i) => Math.max(i - 1, 0)),
          onCloseClick: () => driverRef.current.destroy(),
        },
      });
    });

    return () => {
      cancelled = true;
    };
  }, [active, stepIndex, location.pathname, navigate, steps]);

  // Auto-start once per device: admin only, only when never dismissed
  // before on this device. Reuses the exact same route-aware effect above —
  // it navigates to Library itself since step 0's route is /library.
  useEffect(() => {
    if (isAdmin && readLS(GUIDED_TOUR_SEEN_KEY) !== 'true') {
      setStepIndex(0);
      setActive(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const restart = useCallback(() => {
    runTokenRef.current += 1;
    setStepIndex(0);
    setActive(true);
  }, []);

  useImperativeHandle(ref, () => ({ restart }), [restart]);

  // driver.js renders its own overlay/popover directly to document.body —
  // this component itself never renders DOM of its own.
  if (!isAdmin) return null;
  return null;
});

export default GuidedTour;
