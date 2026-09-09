// useHashScroll — deep-link scroll regression suite.
//
// The hook must scroll the #section-id target into view both on the initial
// mount (cross-page deep link, e.g. Settings -> /setup#company-details from a
// MindVault Help action) AND when the hash changes while the page is already
// mounted (same-page deep link). This repo has no React test renderer, so
// the mechanism is verified by structural assertions on the hook source plus
// the anchor targets and checklist hrefs it depends on.
//   node --test scripts/rag-eval/hash-scroll.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const HOOK = 'src/hooks/useHashScroll.js';

test('useHashScroll reads the hash from the router location, not window (so it is not mount-only)', () => {
  const s = stripComments(read(HOOK));
  assert.match(s, /import\s*\{\s*useLocation\s*\}\s*from\s*'react-router-dom'/,
    'must use react-router useLocation');
  assert.match(s, /useLocation\(\)/);
  assert.doesNotMatch(s, /window\.location\.hash/,
    'reading window.location.hash directly is the mount-only bug this fix removes');
});

test('the scroll effect is keyed on the location hash and key, plus delayMs', () => {
  const s = stripComments(read(HOOK));
  // The dependency array is what makes a same-page hash change re-run the
  // effect; without hash/key in it the hook only ever fires once on mount.
  const dep = s.match(/\}\s*,\s*\[([^\]]*)\]\s*\)\s*;?\s*\}?\s*$/m) || s.match(/\}\s*,\s*\[([^\]]*)\]\s*\)/);
  assert.ok(dep, 'could not find the useEffect dependency array');
  const deps = dep[1].split(',').map((d) => d.trim());
  assert.ok(deps.includes('hash'), 'effect must depend on hash');
  assert.ok(deps.includes('key'), 'effect must depend on key (re-following the same deep link)');
  assert.ok(deps.includes('delayMs'), 'effect must still depend on delayMs');
});

test('exactly one scrollIntoView, still behind the render delay, still cleaned up', () => {
  const s = stripComments(read(HOOK));
  assert.equal((s.match(/scrollIntoView/g) || []).length, 1, 'exactly one scrollIntoView call');
  assert.match(s, /scrollIntoView\(\{\s*behavior:\s*'smooth'/);
  assert.match(s, /setTimeout\([\s\S]+?,\s*delayMs\)/, 'delay preserved');
  assert.match(s, /clearTimeout\(/, 'timeout cleanup preserved');
  assert.match(s, /useHashScroll\(delayMs = 150\)/, 'default 150ms delay preserved');
});

test('no scroll loop: the effect never navigates or mutates the hash', () => {
  const s = stripComments(read(HOOK));
  assert.doesNotMatch(s, /navigate\(|location\.hash\s*=|pushState|replaceState|window\.location\s*=/,
    'the hook must only read the hash and scroll — never change location');
});

test('existing setup-checklist deep links still resolve: anchors and hrefs are intact', () => {
  // Cross-page deep links that already shipped must keep working.
  const gettingStarted = read('src/pages/GettingStarted.jsx');
  assert.match(gettingStarted, /useHashScroll\(\)/);
  assert.match(gettingStarted, /id="company-details"/);

  const manage = read('src/pages/Manage.jsx');
  assert.match(manage, /useHashScroll\(\)/);
  assert.match(manage, /id="manage-knowledge"/);

  const clientSetup = read('src/lib/clientSetup.js');
  assert.match(clientSetup, /actionHref: '\/setup#company-details'/);
  assert.match(clientSetup, /actionHref: '\/manage#manage-knowledge'/);
});
