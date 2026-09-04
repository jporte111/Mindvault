// Guided Product Tour — the dedicated test suite for the driver.js-based,
// page-to-page guided tour that replaces the old modal walkthrough.
//
// Structure / route-flow / persistence-key assertions run against the pure
// step data (src/lib/guidedTourSteps.js). Behavior that only exists at
// runtime (navigation logic, dismissal semantics, admin gating, resilience)
// is verified by structural (source-scan) assertions on GuidedTour.jsx and
// the nav components — the same approach used for the prior Walkthrough.jsx,
// since this repo has no React test renderer.
//   node --test scripts/rag-eval/guided-tour.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GUIDED_TOUR_SEEN_KEY,
  resolveGuidedTourSteps,
  GUIDED_TOUR_ALL_STEPS_ENABLED,
  GUIDED_TOUR_ALL_STEPS_DISABLED,
} from '../../src/lib/guidedTourSteps.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const stripComments = (s) => s.replace(/\/\/.*$/gm, '');

const VALID_ROUTES = new Set(['/library', '/chat', '/admin', '/continuity']);
const DATA_TOUR_SELECTOR = /^\[data-tour="[a-z0-9-]+"\]$/;

// ====================================================================
// 1. Structure
// ====================================================================

test('total step count stays within 15–20, in both the enabled and disabled Continuity paths', () => {
  assert.ok(GUIDED_TOUR_ALL_STEPS_ENABLED.length >= 15 && GUIDED_TOUR_ALL_STEPS_ENABLED.length <= 20,
    `enabled path has ${GUIDED_TOUR_ALL_STEPS_ENABLED.length} steps`);
  assert.ok(GUIDED_TOUR_ALL_STEPS_DISABLED.length >= 15 && GUIDED_TOUR_ALL_STEPS_DISABLED.length <= 20,
    `disabled path has ${GUIDED_TOUR_ALL_STEPS_DISABLED.length} steps`);
});

test('every step has a unique id, in both paths', () => {
  for (const steps of [GUIDED_TOUR_ALL_STEPS_ENABLED, GUIDED_TOUR_ALL_STEPS_DISABLED]) {
    const ids = steps.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate step id found');
  }
});

test('every step has a valid, known route', () => {
  for (const steps of [GUIDED_TOUR_ALL_STEPS_ENABLED, GUIDED_TOUR_ALL_STEPS_DISABLED]) {
    for (const s of steps) {
      assert.ok(VALID_ROUTES.has(s.route), `${s.id} has an unknown route "${s.route}"`);
    }
  }
});

test('every step has a stable [data-tour="..."] selector — no nth-child, class, tag, or text selectors', () => {
  for (const steps of [GUIDED_TOUR_ALL_STEPS_ENABLED, GUIDED_TOUR_ALL_STEPS_DISABLED]) {
    for (const s of steps) {
      assert.match(s.selector, DATA_TOUR_SELECTOR, `${s.id} selector "${s.selector}" is not a stable data-tour selector`);
      if (s.fallbackSelector) {
        assert.match(s.fallbackSelector, DATA_TOUR_SELECTOR, `${s.id} fallbackSelector "${s.fallbackSelector}" is not a stable data-tour selector`);
      }
      assert.equal(/nth-child|nth-of-type/.test(s.selector), false);
      assert.equal(/^\./.test(s.selector), false, 'must not be a class selector');
      assert.equal(/:contains|text\(\)/.test(s.selector), false, 'must not target by visible text');
    }
  }
});

test('every step has a non-empty title and description', () => {
  for (const s of GUIDED_TOUR_ALL_STEPS_ENABLED) {
    assert.equal(typeof s.title, 'string');
    assert.ok(s.title.length > 0, `${s.id} has no title`);
    assert.equal(typeof s.description, 'string');
    assert.ok(s.description.length > 0, `${s.id} has no description`);
  }
});

test('exactly one final step per path, and it is the last element', () => {
  for (const steps of [GUIDED_TOUR_ALL_STEPS_ENABLED, GUIDED_TOUR_ALL_STEPS_DISABLED]) {
    const finals = steps.filter((s) => s.final === true);
    assert.equal(finals.length, 1, 'expected exactly one final:true step');
    assert.equal(steps[steps.length - 1].final, true, 'the final step must be the last step');
  }
});

// ====================================================================
// 2. Route flow
// ====================================================================

test('Library steps (1–5) stay on /library, in order', () => {
  const libSteps = GUIDED_TOUR_ALL_STEPS_ENABLED.slice(0, 5);
  assert.deepEqual(libSteps.map((s) => s.id), [
    'library-intro', 'library-add-knowledge', 'library-search', 'library-filters', 'library-results',
  ]);
  for (const s of libSteps) assert.equal(s.route, '/library');
});

test('transition: final Library step -> first Assistant step is a route change to /chat', () => {
  const steps = GUIDED_TOUR_ALL_STEPS_ENABLED;
  const lastLib = steps[4];
  const firstChat = steps[5];
  assert.equal(lastLib.route, '/library');
  assert.equal(firstChat.route, '/chat');
  assert.notEqual(lastLib.route, firstChat.route);
});

test('transition: Assistant -> Admin is a route change', () => {
  const steps = GUIDED_TOUR_ALL_STEPS_ENABLED;
  const lastChat = steps[8];
  const firstAdmin = steps[9];
  assert.equal(lastChat.route, '/chat');
  assert.equal(firstAdmin.route, '/admin');
});

test('transition: Admin -> Continuity happens only when knowledge_health_enabled is true', () => {
  const enabled = resolveGuidedTourSteps({ knowledgeHealthEnabled: true });
  const disabled = resolveGuidedTourSteps({ knowledgeHealthEnabled: false });
  assert.ok(enabled.some((s) => s.route === '/continuity'), 'enabled path must include Continuity steps');
  assert.equal(disabled.some((s) => s.route === '/continuity'), false, 'disabled path must never route to /continuity');
});

test('Admin -> finishes safely (stays on /admin) when Continuity is disabled', () => {
  const disabled = resolveGuidedTourSteps({ knowledgeHealthEnabled: false });
  const last = disabled[disabled.length - 1];
  assert.equal(last.final, true);
  assert.equal(last.route, '/admin');
  assert.match(last.description, /turned off/i);
  assert.match(last.description, /Admin.*System/);
});

test('the final step always closes with the same "ready" message, whichever path produced it', () => {
  for (const steps of [GUIDED_TOUR_ALL_STEPS_ENABLED, GUIDED_TOUR_ALL_STEPS_DISABLED]) {
    const last = steps[steps.length - 1];
    assert.equal(last.title, "You're ready to use MindVault");
    assert.match(last.secondary, /restart this tour.*Help/i);
  }
});

test('Back works across route boundaries — GuidedTour.jsx re-runs the same route-aware effect on step decrement', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  // Back only decrements the index; it does NOT special-case routes — it
  // relies on the shared effect (which checks location.pathname !== step.route
  // and navigates) to run again for the prior step, whatever route it's on.
  assert.match(s, /onPrevClick: \(\) => setStepIndex\(\(i\) => Math\.max\(i - 1, 0\)\)/);
  // there is exactly one route-mismatch-triggers-navigate site — shared by
  // both Next and Back, since both just change stepIndex
  const navigateGuards = [...s.matchAll(/if \(location\.pathname !== step\.route\)/g)];
  assert.equal(navigateGuards.length, 1, 'route-aware navigation must be centralized, not duplicated per direction');
});

// ====================================================================
// 3. Navigation
// ====================================================================

test('Next navigates automatically when the next step is on a different route', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  assert.match(s, /if \(location\.pathname !== step\.route\) \{\s*navigate\(step\.route\);\s*return undefined;\s*\}/);
});

test('same-page Next does not call navigate() — it only advances the step index', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  const onNext = s.match(/onNextClick: \(\) => \{([\s\S]*?)\},\s*onPrevClick/);
  assert.ok(onNext, 'onNextClick handler not found');
  assert.equal(/navigate\(/.test(onNext[1]), false, 'onNextClick must never call navigate() directly — route changes go through the shared effect');
  assert.match(onNext[1], /setStepIndex/);
});

test('no separate "Open Knowledge / Open Admin / Open Assistant" action buttons remain from the old modal walkthrough', () => {
  const s = read('src/components/onboarding/GuidedTour.jsx');
  assert.equal(/Open Knowledge|Open Admin|Open AI Assistant|Open Operational Continuity/.test(s), false);
  assert.equal(/goToAction/.test(s), false, 'the old modal-walkthrough helper must not be reintroduced');
});

test('the old modal Walkthrough is fully removed', () => {
  assert.throws(() => read('src/components/onboarding/Walkthrough.jsx'));
  assert.throws(() => read('src/lib/walkthroughSteps.js'));
});

// ====================================================================
// 4. Persistence
// ====================================================================

test('uses mv_guided_tour_seen_v1 as its seen key', () => {
  assert.equal(GUIDED_TOUR_SEEN_KEY, 'mv_guided_tour_seen_v1');
  const s = read('src/components/onboarding/GuidedTour.jsx');
  assert.match(s, /GUIDED_TOUR_SEEN_KEY/);
  assert.equal(/mv_onboarding_seen/.test(s), false, 'must not reuse or reference the old modal-walkthrough key');
});

test('old mv_onboarding_seen never suppresses the new tour (no read of that key anywhere in the tour)', () => {
  const s = read('src/components/onboarding/GuidedTour.jsx') + read('src/lib/guidedTourSteps.js');
  assert.equal(/mv_onboarding_seen/.test(s), false);
});

test('Skip (closing via driver.js\'s close action) and Finish both write the seen flag through one shared dismiss()', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  const dismissFn = s.match(/const dismiss = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/);
  assert.ok(dismissFn, 'dismiss() not found');
  assert.match(dismissFn[1], /writeLS\(GUIDED_TOUR_SEEN_KEY, 'true'\)/);
  // dismiss is wired as the ONE onDestroyed hook for the driver instance —
  // every close path (X button -> destroy(), Escape, overlay click, and the
  // Finish button on the last step -> destroy()) routes through it.
  assert.match(s, /onDestroyed: dismiss/);
  const writeSites = [...s.matchAll(/writeLS\(GUIDED_TOUR_SEEN_KEY/g)];
  assert.equal(writeSites.length, 1, 'the seen flag must be written from exactly one place');
  // Finish (last step's Next button) and the close (x) button both destroy()
  // the driver instance rather than writing localStorage themselves
  assert.match(s, /onNextClick: \(\) => \{\s*if \(isLast\) \{\s*driverRef\.current\.destroy\(\);/);
  assert.match(s, /onCloseClick: \(\) => driverRef\.current\.destroy\(\)/);
});

test('Help restart ignores the seen flag — restart() never reads it', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  const restartFn = s.match(/const restart = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/);
  assert.ok(restartFn, 'restart() not found');
  assert.equal(/readLS|GUIDED_TOUR_SEEN_KEY/.test(restartFn[1]), false, 'restart() must not gate on the seen flag');
  assert.match(restartFn[1], /setStepIndex\(0\)/);
  assert.match(restartFn[1], /setActive\(true\)/);
  assert.match(s, /useImperativeHandle\(ref, \(\) => \(\{ restart \}\)/);
});

test('localStorage read/write are try/catch wrapped and never throw', () => {
  const s = read('src/components/onboarding/GuidedTour.jsx');
  const readFn = s.match(/const readLS = \(k\) => \{([\s\S]*?)\n\};/)[1];
  const writeFn = s.match(/const writeLS = \(k, v\) => \{([\s\S]*?)\n\};/)[1];
  assert.match(readFn, /try \{/);
  assert.match(readFn, /catch/);
  assert.match(writeFn, /try \{/);
  assert.match(writeFn, /catch/);
});

// ====================================================================
// 5. Resilience
// ====================================================================

test('a missing target (primary AND fallback absent) skips forward instead of crashing', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  const notFoundBranch = s.match(/if \(!el\) \{([\s\S]*?)\n\s*\}\n\s*return;/);
  assert.ok(notFoundBranch, 'missing-target branch not found');
  assert.match(notFoundBranch[1], /setStepIndex\(\(i\) => i \+ 1\)/);
  assert.equal(/throw/.test(notFoundBranch[1]), false);
});

test('resolveElement checks the primary selector, then the fallback — supports the empty-state fallback pattern', () => {
  const s = read('src/components/onboarding/GuidedTour.jsx');
  assert.match(s, /const primary = step\.selector \? document\.querySelector\(step\.selector\) : null;/);
  assert.match(s, /if \(step\.fallbackSelector\) return document\.querySelector\(step\.fallbackSelector\) \|\| null;/);
});

test('empty Library is supported: the results step has a fallback to the empty-state selector', () => {
  const step = GUIDED_TOUR_ALL_STEPS_ENABLED.find((s) => s.id === 'library-results');
  assert.equal(step.selector, '[data-tour="knowledge-results"]');
  assert.equal(step.fallbackSelector, '[data-tour="knowledge-empty-state"]');
});

test('empty Chat is supported: the results step targets the always-present conversation container (empty or not)', () => {
  const step = GUIDED_TOUR_ALL_STEPS_ENABLED.find((s) => s.id === 'chat-results');
  assert.equal(step.selector, '[data-tour="chat-results"]');
});

test('the chat scope selector is marked optional — its absence (legacy engine) is expected, not a resilience failure', () => {
  const step = GUIDED_TOUR_ALL_STEPS_ENABLED.find((s) => s.id === 'chat-scope');
  assert.equal(step.optional, true);
});

test('no OperationalProcess records is supported: process steps target stable containers that render regardless of row count', () => {
  const ids = ['admin-operational-processes', 'admin-process-people', 'admin-process-criticality-cadence'];
  for (const id of ids) {
    const step = GUIDED_TOUR_ALL_STEPS_ENABLED.find((s) => s.id === id);
    assert.ok(step, `${id} missing`);
    assert.match(step.selector, DATA_TOUR_SELECTOR);
  }
});

test('no snapshots is supported: the Trends step targets a container present in both the "no history" and populated states', () => {
  const step = GUIDED_TOUR_ALL_STEPS_ENABLED.find((s) => s.id === 'continuity-trends');
  assert.equal(step.selector, '[data-tour="continuity-trends"]');
  const continuityPage = read('src/pages/Continuity.jsx');
  const trendsAttrs = [...continuityPage.matchAll(/data-tour="continuity-trends"/g)];
  assert.equal(trendsAttrs.length, 2, 'both the empty-history and populated TrendPanel branches must carry the same selector');
});

test('disabled Continuity is supported: the disabled path never includes a /continuity step and ends safely on /admin', () => {
  const disabled = GUIDED_TOUR_ALL_STEPS_DISABLED;
  assert.equal(disabled.some((s) => s.route === '/continuity'), false);
  assert.equal(disabled[disabled.length - 1].route, '/admin');
});

// ====================================================================
// Correction — optional targets must not stall Next for the full 4s
// resilience window; they get a short bounded wait instead, while required
// targets keep the conservative window.
// ====================================================================

test('optional steps are resolved with the short bounded wait, not the default 4s', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  assert.match(s, /waitForElement\(step, \{ timeoutMs: step\.optional \? OPTIONAL_WAIT_MS : REQUIRED_WAIT_MS \}\)/);
});

test('required steps retain the conservative ~4000ms wait', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  assert.match(s, /const REQUIRED_WAIT_MS = 4000;/);
  // and it's still the default when no override is passed, so any other
  // caller of waitForElement (or a future one) stays conservative by default
  assert.match(s, /function waitForElement\(step, \{ timeoutMs = REQUIRED_WAIT_MS \} = \{\}\)/);
});

test('the optional wait is meaningfully short (300–750ms) — long enough for a real React render, not long enough to feel frozen', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  const m = s.match(/const OPTIONAL_WAIT_MS = (\d+);/);
  assert.ok(m, 'OPTIONAL_WAIT_MS constant not found');
  const ms = Number(m[1]);
  assert.ok(ms >= 300 && ms <= 750, `OPTIONAL_WAIT_MS=${ms} is outside the recommended 300–750ms range`);
  assert.ok(ms < 4000, 'must be strictly shorter than the required-target wait');
});

test('a missing OPTIONAL target advances the tour via the same skip-forward branch — it does not terminate the tour', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  // there is exactly one "not found" branch, reached regardless of
  // step.optional — no separate early-exit/terminate path for optional steps
  const notFoundBranches = [...s.matchAll(/if \(!el\) \{/g)];
  assert.equal(notFoundBranches.length, 1, 'there must be exactly one missing-target branch, shared by required and optional steps');
  const branch = s.match(/if \(!el\) \{([\s\S]*?)\n\s*\}\n\s*return;/)[1];
  assert.match(branch, /setStepIndex\(\(i\) => i \+ 1\)/);
  assert.equal(/step\.optional/.test(branch), false, 'the skip logic must not special-case optional — the timeout difference alone is the fix');
});

test('chat-scope remains the one optional step, and its wait resolves via step.optional (no separate flag)', () => {
  const optionalSteps = GUIDED_TOUR_ALL_STEPS_ENABLED.filter((s) => s.optional === true);
  assert.deepEqual(optionalSteps.map((s) => s.id), ['chat-scope']);
});

test('cross-route Next/Back behavior is unchanged by the timeout correction', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  // the route-mismatch-navigate branch still runs BEFORE any waitForElement
  // call, and still doesn't know or care about step.optional
  assert.match(s, /if \(location\.pathname !== step\.route\) \{\s*navigate\(step\.route\);\s*return undefined;\s*\}/);
  const navigateIdx = s.indexOf('navigate(step.route)');
  const waitCallIdx = s.indexOf('waitForElement(step, { timeoutMs:');
  assert.ok(navigateIdx > -1 && waitCallIdx > -1 && navigateIdx < waitCallIdx, 'route navigation must still happen before element resolution');
  assert.match(s, /onPrevClick: \(\) => setStepIndex\(\(i\) => Math\.max\(i - 1, 0\)\)/);
});

// ====================================================================
// 6. Permissions
// ====================================================================

test('non-admin does not auto-start the tour', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  assert.match(s, /if \(isAdmin && readLS\(GUIDED_TOUR_SEEN_KEY\) !== 'true'\) \{/);
  assert.match(s, /if \(!isAdmin\) return null;/);
});

test('non-admin has no guided-tour Help trigger in either nav', () => {
  for (const f of ['src/components/layout/Sidebar.jsx', 'src/components/layout/MobileNav.jsx']) {
    const s = read(f);
    const helpButtonOutsideGuard = /aria-label="Help"/.test(s.replace(/\{user\?\.role === 'admin' && \([\s\S]*?\)\}/g, ''));
    assert.equal(helpButtonOutsideGuard, false, `${f}: a Help trigger exists outside the admin guard`);
  }
});

test('AppLayout mounts GuidedTour exactly once and wires the Help triggers to restart()', () => {
  const s = read('src/components/layout/AppLayout.jsx');
  const mounts = [...s.matchAll(/<GuidedTour\b/g)];
  assert.equal(mounts.length, 1, 'GuidedTour must be mounted exactly once');
  assert.match(s, /guidedTourRef\.current\?\.restart\(\)/);
  assert.match(s, /<Sidebar user=\{user\} onOpenHelp=\{openHelp\}/);
  assert.match(s, /<MobileNav user=\{user\} onOpenHelp=\{openHelp\}/);
});

test('the tour never reveals Admin/Continuity content to employees — it is admin-gated as a whole, not per-step', () => {
  const s = stripComments(read('src/components/onboarding/GuidedTour.jsx'));
  // a single top-level admin gate covers every step, including the Admin
  // and Continuity ones — there is no per-step role check to bypass
  assert.equal((s.match(/useIsAdmin\(\)/g) || []).length, 1);
  assert.equal((s.match(/if \(!isAdmin\) return null;/g) || []).length, 1);
});

// ====================================================================
// 7. Copy
// ====================================================================

const BANNED_JARGON = /\b(embeddings?|vector(s| retrieval)?|\bRAG\b|schema|\bchunk(s|ed)?\b|payload|fingerprints?|retrieval)\b/i;

test('no user-facing implementation jargon anywhere in the guided tour copy', () => {
  for (const s of [...GUIDED_TOUR_ALL_STEPS_ENABLED, ...GUIDED_TOUR_ALL_STEPS_DISABLED]) {
    assert.equal(BANNED_JARGON.test(s.title), false, `title "${s.title}"`);
    assert.equal(BANNED_JARGON.test(s.description), false, `description "${s.description}"`);
    if (s.secondary) assert.equal(BANNED_JARGON.test(s.secondary), false, `secondary "${s.secondary}"`);
  }
});

test('no reintroduction of visible "Training(s)" terminology in the guided tour copy', () => {
  for (const s of [...GUIDED_TOUR_ALL_STEPS_ENABLED, ...GUIDED_TOUR_ALL_STEPS_DISABLED]) {
    const blob = `${s.title} ${s.description} ${s.secondary || ''}`;
    assert.equal(/\btraining(s)?\b/i.test(blob), false, `"${blob}"`);
  }
});

test('does not imply every critical process must have a backup merely because of criticality', () => {
  const step = GUIDED_TOUR_ALL_STEPS_ENABLED.find((s) => s.id === 'admin-process-people');
  assert.match(step.description, /where a true key-person dependency exists/i);
  assert.equal(/every critical process (must|needs)/i.test(step.description), false);
});

test('does not claim unverified content is automatically wrong', () => {
  const step = GUIDED_TOUR_ALL_STEPS_ENABLED.find((s) => s.id === 'admin-verification');
  assert.equal(/wrong|incorrect|invalid/i.test(step.description), false);
});

test('does not invent a composite continuity score, and does not infer key-person dependency from criticality alone', () => {
  const coverage = GUIDED_TOUR_ALL_STEPS_ENABLED.find((s) => s.id === 'continuity-coverage');
  const keyperson = GUIDED_TOUR_ALL_STEPS_ENABLED.find((s) => s.id === 'continuity-keyperson');
  assert.equal(/\bscore\b/i.test(coverage.description), false);
  assert.equal(/criticality alone|because.*critical/i.test(keyperson.description), false);
});

test('does not claim every AI Assistant answer is "approved"', () => {
  const step = GUIDED_TOUR_ALL_STEPS_ENABLED.find((s) => s.id === 'chat-intro');
  assert.equal(/\bapproved\b/i.test(step.description), false);
});

// ====================================================================
// 8. Regression — no new backend surface, no telemetry, no demo data
// ====================================================================

test('no Base44 / new-entity / new-flag / LLM / embeddings / analytics calls anywhere in the guided tour', () => {
  for (const f of ['src/components/onboarding/GuidedTour.jsx', 'src/lib/guidedTourSteps.js']) {
    const s = stripComments(read(f));
    assert.equal(/base44\./.test(s), false, `${f} must not touch Base44`);
    assert.equal(/AppConfig/.test(s), false, `${f} must not reference AppConfig`);
    assert.equal(/InvokeLLM|embedKnowledge|asServiceRole/.test(s), false, `${f} must not call backend/LLM/embeddings behavior`);
    assert.equal(/analytics|telemetry|posthog|segment\.io|mixpanel/i.test(s), false, `${f} must not add analytics/telemetry`);
  }
});

test('guidedTourSteps.js is pure — no React, no driver.js, no Base44, no localStorage', () => {
  const s = stripComments(read('src/lib/guidedTourSteps.js'));
  assert.equal(/^\s*import\s/m.test(s), false);
  assert.equal(/localStorage|base44|driver\(|InvokeLLM/.test(s), false);
});

test('driver.js is the only new dependency added for the tour', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies['driver.js'], 'driver.js not found in dependencies');
});
