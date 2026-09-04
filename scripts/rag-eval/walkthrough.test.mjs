// Onboarding-2 — tests for the admin walkthrough: the pure step data /
// resolveStepAction logic (src/lib/walkthroughSteps.js), plus structural
// (source-scan) assertions on the Walkthrough component and its Help
// triggers. There is no React test renderer in this repo (see
// onboarding-copy.test.mjs's precedent for SetupChecklist.jsx), so component
// *behavior* that isn't expressible as pure logic is verified the same way
// Onboarding-1 verified SetupChecklist: by asserting the exact patterns the
// spec requires are present in the component source.
//   node --test scripts/rag-eval/walkthrough.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WALKTHROUGH_STEPS, resolveStepAction, WALKTHROUGH_SEEN_KEY } from '../../src/lib/walkthroughSteps.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// ====================================================================
// pure step data
// ====================================================================

test('exactly 6 steps, in the specified order', () => {
  assert.equal(WALKTHROUGH_STEPS.length, 6);
  assert.deepEqual(WALKTHROUGH_STEPS.map((s) => s.id), [
    'welcome', 'knowledge', 'assistant', 'admin', 'continuity', 'checklist',
  ]);
});

test('every step has a non-empty title and copy; step 1 has no route action', () => {
  for (const s of WALKTHROUGH_STEPS) {
    assert.equal(typeof s.title, 'string');
    assert.ok(s.title.length > 0);
    assert.equal(typeof s.copy, 'string');
    assert.ok(s.copy.length > 0);
  }
  assert.equal(WALKTHROUGH_STEPS[0].actionHref, null);
  assert.equal(WALKTHROUGH_STEPS[0].actionLabel, null);
});

test('route actions are correct for each step that has one', () => {
  const byId = Object.fromEntries(WALKTHROUGH_STEPS.map((s) => [s.id, s]));
  assert.equal(byId.knowledge.actionHref, '/library');
  assert.equal(byId.assistant.actionHref, '/chat');
  assert.equal(byId.admin.actionHref, '/admin');
  assert.equal(byId.continuity.actionHref, '/continuity');
  assert.equal(byId.checklist.actionHref, '/admin');
});

test('deterministic key used for "seen" state', () => {
  assert.equal(WALKTHROUGH_SEEN_KEY, 'mv_onboarding_seen');
});

// ====================================================================
// resolveStepAction — the one piece of logic that depends on live state
// ====================================================================

test('non-continuity steps pass their fixed action through unchanged, flag on or off', () => {
  const welcome = WALKTHROUGH_STEPS[0];
  assert.deepEqual(resolveStepAction(welcome, { knowledgeHealthEnabled: true }), { label: null, href: null, disabledNote: null });
  const admin = WALKTHROUGH_STEPS.find((s) => s.id === 'admin');
  assert.deepEqual(resolveStepAction(admin, { knowledgeHealthEnabled: false }), { label: 'Open Admin', href: '/admin', disabledNote: null });
});

test('continuity step + flag ON -> routes to /continuity, no disabled note', () => {
  const step = WALKTHROUGH_STEPS.find((s) => s.id === 'continuity');
  const r = resolveStepAction(step, { knowledgeHealthEnabled: true });
  assert.equal(r.href, '/continuity');
  assert.equal(r.label, 'Open Operational Continuity');
  assert.equal(r.disabledNote, null);
});

test('continuity step + flag OFF -> never routes to /continuity; routes to /admin with a note', () => {
  const step = WALKTHROUGH_STEPS.find((s) => s.id === 'continuity');
  const r = resolveStepAction(step, { knowledgeHealthEnabled: false });
  assert.notEqual(r.href, '/continuity');
  assert.equal(r.href, '/admin');
  assert.ok(r.disabledNote && r.disabledNote.length > 0);
  assert.match(r.disabledNote, /Admin.*System/);
});

test('continuity step with no state argument at all defaults to the disabled path (never assumes enabled)', () => {
  const step = WALKTHROUGH_STEPS.find((s) => s.id === 'continuity');
  const r = resolveStepAction(step);
  assert.equal(r.href, '/admin');
});

test('resolveStepAction never throws on a null/undefined step', () => {
  assert.doesNotThrow(() => resolveStepAction(null));
  assert.doesNotThrow(() => resolveStepAction(undefined));
});

// ====================================================================
// Walkthrough.jsx — structural assertions (no React renderer available)
// ====================================================================

test('Walkthrough is admin-only', () => {
  const s = read('src/components/onboarding/Walkthrough.jsx');
  assert.ok(/useIsAdmin\(\)/.test(s));
  assert.ok(/if \(!isAdmin\) return null;/.test(s));
});

test('Walkthrough auto-opens only when admin AND mv_onboarding_seen !== "true"', () => {
  const s = read('src/components/onboarding/Walkthrough.jsx');
  assert.match(s, /isAdmin && readLS\(WALKTHROUGH_SEEN_KEY\) !== 'true'/);
});

test('Skip, Finish, and intentional dialog close all write the seen flag (single dismiss() path)', () => {
  const s = read('src/components/onboarding/Walkthrough.jsx');
  // one shared dismiss() that writes localStorage, wired to Skip, Finish, and
  // Dialog's onOpenChange(false) (Escape / overlay click / the X button)
  const dismissFn = s.match(/const dismiss = \(\) => \{([\s\S]*?)\};/);
  assert.ok(dismissFn, 'no dismiss() found');
  assert.match(dismissFn[1], /writeLS\(WALKTHROUGH_SEEN_KEY, 'true'\)/);
  assert.match(s, /onClick=\{dismiss\}>Skip tour</);
  assert.match(s, /onClick=\{dismiss\}>Finish</);
  assert.match(s, /onOpenChange=\{\(next\) => \(next \? setOpen\(true\) : dismiss\(\)\)\}/);
});

test('localStorage access is wrapped in try/catch and never throws on failure', () => {
  const s = read('src/components/onboarding/Walkthrough.jsx');
  const readFn = s.match(/const readLS = \(k\) => \{([\s\S]*?)\n\};/)[1];
  const writeFn = s.match(/const writeLS = \(k, v\) => \{([\s\S]*?)\n\};/)[1];
  assert.match(readFn, /try \{/);
  assert.match(readFn, /catch/);
  assert.match(writeFn, /try \{/);
  assert.match(writeFn, /catch/);
});

test('Next / Back only change the step index — they never call navigate()', () => {
  const s = read('src/components/onboarding/Walkthrough.jsx');
  const nextBtn = s.match(/>\s*Next\s*<\/Button>/);
  assert.ok(nextBtn, 'Next button not found');
  // isolate the Next button's onClick handler text and confirm it only touches setStep
  const nextHandler = s.match(/onClick=\{\(\) => setStep\(\(s\) => Math\.min\(total - 1, s \+ 1\)\)\}/);
  assert.ok(nextHandler, 'Next handler must only call setStep, never navigate');
  const backHandler = s.match(/onClick=\{\(\) => setStep\(\(s\) => Math\.max\(0, s - 1\)\)\}/);
  assert.ok(backHandler, 'Back handler must only call setStep, never navigate');
  // navigate() is called from exactly one place: inside goToAction, which the
  // route-action button calls — never directly from Next/Back/Skip/Finish
  const navigateCalls = [...s.matchAll(/navigate\(/g)];
  assert.equal(navigateCalls.length, 1, 'navigate() must be called from exactly one place');
  const navigateSite = s.match(/const goToAction = \(href\) => \{([\s\S]*?)\};/);
  assert.ok(navigateSite, 'goToAction() not found');
  assert.match(navigateSite[1], /navigate\(href\)/);
});

// ====================================================================
// Correction — an explicit route action must dismiss the walkthrough (seen
// flag + close) BEFORE navigating, since Walkthrough is mounted at layout
// level and survives route changes. Reuses dismiss() rather than
// duplicating the localStorage write.
// ====================================================================

test('the route-action button calls goToAction(), not navigate() directly', () => {
  const s = read('src/components/onboarding/Walkthrough.jsx');
  assert.equal(/onClick=\{\(\) => navigate\(action\.href\)\}/.test(s), false, 'the action button must no longer call navigate() directly');
  assert.match(s, /onClick=\{\(\) => goToAction\(action\.href\)\}/);
});

test('goToAction() dismisses (seen flag + close) THEN navigates — reusing dismiss(), not a duplicate localStorage write', () => {
  const s = read('src/components/onboarding/Walkthrough.jsx');
  const fn = s.match(/const goToAction = \(href\) => \{([\s\S]*?)\};/);
  assert.ok(fn, 'goToAction() not found');
  const body = fn[1];
  // order: dismiss() runs before navigate(href)
  const dismissIdx = body.indexOf('dismiss()');
  const navigateIdx = body.indexOf('navigate(href)');
  assert.ok(dismissIdx >= 0 && navigateIdx >= 0, 'goToAction must call both dismiss() and navigate(href)');
  assert.ok(dismissIdx < navigateIdx, 'dismiss() must run before navigate(href)');
  // no duplicated localStorage write inside goToAction itself — it must
  // delegate to the single dismiss() implementation
  assert.equal(/writeLS/.test(body), false, 'goToAction must not duplicate the localStorage write; it must reuse dismiss()');
});

test('an explicit route action therefore also records the seen flag (transitively, via dismiss())', () => {
  const s = read('src/components/onboarding/Walkthrough.jsx');
  // dismiss() is the single place mv_onboarding_seen is written, and
  // goToAction() calls dismiss() — so the action path is covered without a
  // second write site.
  const dismissFn = s.match(/const dismiss = \(\) => \{([\s\S]*?)\};/)[1];
  assert.match(dismissFn, /writeLS\(WALKTHROUGH_SEEN_KEY, 'true'\)/);
  const writeSites = [...s.matchAll(/writeLS\(WALKTHROUGH_SEEN_KEY/g)];
  assert.equal(writeSites.length, 1, 'mv_onboarding_seen must be written from exactly one place (dismiss)');
});

test('Help can reopen the walkthrough after a route-action dismissal — open() ignores the seen flag', () => {
  const s = read('src/components/onboarding/Walkthrough.jsx');
  const openImpl = s.match(/useImperativeHandle\(ref, \(\) => \(\{([\s\S]*?)\}\), \[\]\);/);
  assert.ok(openImpl, 'useImperativeHandle not found');
  // open() unconditionally resets step and opens — no readLS/seen check gating it
  assert.equal(/readLS|WALKTHROUGH_SEEN_KEY/.test(openImpl[1]), false, 'open() must not gate on the seen flag');
  assert.match(openImpl[1], /setStep\(0\)/);
  assert.match(openImpl[1], /setOpen\(true\)/);
});

test('reopen imperative handle exists and always resets to step 0 (usable even when seen=true)', () => {
  const s = read('src/components/onboarding/Walkthrough.jsx');
  assert.match(s, /useImperativeHandle\(ref, \(\) => \(\{[\s\S]*?open: \(\) => \{[\s\S]*?setStep\(0\);[\s\S]*?setOpen\(true\);/);
});

const stripComments = (s) => s.replace(/\/\/.*$/gm, '');

test('no Base44 persistence, no new entity, no AppConfig write, in the walkthrough files', () => {
  for (const f of ['src/components/onboarding/Walkthrough.jsx', 'src/lib/walkthroughSteps.js']) {
    const code = stripComments(read(f));
    assert.equal(/base44\./.test(code), false, `${f} must not touch Base44`);
    assert.equal(/AppConfig/.test(code), false, `${f} must not reference AppConfig`);
    assert.equal(/InvokeLLM|embedKnowledge|asServiceRole/.test(code), false, `${f} must not call backend/LLM/embeddings behavior`);
  }
});

test('walkthroughSteps.js is pure — no React, no Base44, no localStorage', () => {
  const code = stripComments(read('src/lib/walkthroughSteps.js'));
  assert.equal(/^\s*import\s/m.test(code), false);
  assert.equal(/localStorage|base44|InvokeLLM/.test(code), false);
});

// ====================================================================
// Help trigger — admin-only, reopens even when already seen
// ====================================================================

test('AppLayout mounts Walkthrough exactly once and wires onOpenHelp to both navs', () => {
  const s = read('src/components/layout/AppLayout.jsx');
  const mounts = [...s.matchAll(/<Walkthrough\b/g)];
  assert.equal(mounts.length, 1, 'Walkthrough must be mounted exactly once (at layout level)');
  assert.match(s, /walkthroughRef\.current\?\.open\(\)/);
  assert.match(s, /<Sidebar user=\{user\} onOpenHelp=\{openHelp\}/);
  assert.match(s, /<MobileNav user=\{user\} onOpenHelp=\{openHelp\}/);
});

test('Sidebar Help trigger is admin-gated and calls onOpenHelp unconditionally (no seen-flag check)', () => {
  const s = read('src/components/layout/Sidebar.jsx');
  const block = s.match(/\{user\?\.role === 'admin' && \(\s*<button\s+onClick=\{onOpenHelp\}[\s\S]*?<\/button>\s*\)\}/);
  assert.ok(block, 'admin-gated Help button not found in Sidebar');
  assert.match(block[0], /aria-label="Help"/);
  assert.equal(/mv_onboarding_seen/.test(block[0]), false, 'Help trigger must not itself gate on the seen flag');
});

test('MobileNav Help trigger is admin-gated and calls onOpenHelp unconditionally', () => {
  const s = read('src/components/layout/MobileNav.jsx');
  const block = s.match(/\{user\?\.role === 'admin' && \(\s*<button\s+onClick=\{onOpenHelp\}[\s\S]*?<\/button>\s*\)\}/);
  assert.ok(block, 'admin-gated Help button not found in MobileNav');
  assert.match(block[0], /aria-label="Help"/);
});

test('non-admin users get no onboarding walkthrough trigger in either nav', () => {
  for (const f of ['src/components/layout/Sidebar.jsx', 'src/components/layout/MobileNav.jsx']) {
    const s = read(f);
    // the Help button markup only exists inside the `user?.role === 'admin' &&` guard
    const helpButtonOutsideGuard = /aria-label="Help"/.test(s.replace(/\{user\?\.role === 'admin' && \([\s\S]*?\)\}/g, ''));
    assert.equal(helpButtonOutsideGuard, false, `${f}: a Help trigger exists outside the admin guard`);
  }
});
