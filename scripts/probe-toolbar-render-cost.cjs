#!/usr/bin/env node
/**
 * Probe (run by hand, not a test lane): measures the DOM work the toolbar's hot paths do per
 * state push, on the shipped bundle, in a real DOM. Three paths, all invisible to the renderer
 * unit-test harness:
 *
 *   1. the tab strip — selector work per `renderTabs()`, cold and steady state;
 *   2. the chrome-profile dropdown — mutations per `renderChromeProfiles()` push, plus proof
 *      that a changed profile list still rebuilds (the guard must not stale the menu);
 *   3. the phone panel — a closed panel is not rebuilt while the badge still follows the
 *      state, an open panel still repaints, and an unplug while open cannot leave the body
 *      showing a connected phone.
 *
 * Why this instrument: `renderTabs()` (src/renderer/toolbar.ts) builds each tab element with
 * `innerHTML`, which the renderer unit-test harness ("FakeElement") does not parse, so the
 * harness cannot see the seven child nodes this probe counts. jsdom parses it.
 *
 * Usage: node scripts/probe-tabstrip-render-cost.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, '.compiled', 'src', 'renderer', 'toolbar.html');
const JS_PATH = path.join(ROOT, '.compiled', 'src', 'renderer', 'toolbar.js');
const SHIM_PATH = path.join(ROOT, '.compiled', 'src', 'renderer', 'exports-shim.js');

const failures = [];
function check(name, condition, detail) {
  const verdict = condition ? 'PASS' : 'FAIL';
  if (!condition) failures.push(name);
  console.log(`[${verdict}] ${name}${detail === undefined ? '' : `  observed=${JSON.stringify(detail)}`}`);
}

const dom = new JSDOM(fs.readFileSync(HTML_PATH, 'utf8'), {
  url: pathToFileURL(HTML_PATH).href,
  runScripts: 'dangerously',
  pretendToBeVisual: true,
});
const win = dom.window;

/**
 * The page's own two scripts run as real scripts (not `eval`): the strip's model lives in a
 * top-level `let`, and a top-level `let` inside an eval is confined to that eval's scope —
 * evaluated instead of executed, the bundle would render from an empty model and every
 * measurement below would read zero for the wrong reason.
 */
function injectScript(source) {
  const element = win.document.createElement('script');
  element.textContent = source;
  win.document.head.appendChild(element);
}

injectScript(`
  window.antifanToolbar = new Proxy({}, { get: () => () => undefined });
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  }
  if (typeof window.ResizeObserver !== 'function') {
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  if (typeof window.IntersectionObserver !== 'function') {
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
`);
injectScript(fs.readFileSync(SHIM_PATH, 'utf8'));
injectScript(fs.readFileSync(JS_PATH, 'utf8'));

const counters = { querySelector: 0, querySelectorAll: 0, getAttribute: 0 };
const perSelector = new Map();
const patch = (proto, method, label) => {
  const original = proto[method];
  proto[method] = function (...args) {
    counters[label] += 1;
    if (label === 'querySelector' || label === 'querySelectorAll') {
      const key = `${label}:${args[0]}`;
      perSelector.set(key, (perSelector.get(key) ?? 0) + 1);
    }
    return original.apply(this, args);
  };
};
patch(win.Element.prototype, 'querySelector', 'querySelector');
patch(win.Element.prototype, 'querySelectorAll', 'querySelectorAll');
patch(win.Document.prototype, 'querySelector', 'querySelector');
patch(win.Document.prototype, 'querySelectorAll', 'querySelectorAll');
patch(win.Element.prototype, 'getAttribute', 'getAttribute');

const reset = () => {
  counters.querySelector = 0;
  counters.querySelectorAll = 0;
  counters.getAttribute = 0;
  perSelector.clear();
};
const snapshot = () => ({ ...counters, selectors: new Map(perSelector) });
const format = (s) => {
  const top = [...s.selectors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9)
    .map(([k, v]) => `${k} x${v}`).join(' | ');
  return `querySelector=${s.querySelector} querySelectorAll=${s.querySelectorAll} getAttribute=${s.getAttribute}${top ? `  [${top}]` : ''}`;
};

function tabModel(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    title: `Tab ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    favicon: '',
    isLoading: false,
    isMuted: false,
    isAudible: false,
    isAgentControlled: false,
    aiState: '',
  }));
}

const strip = () => Array.from(win.document.querySelectorAll('#tabList > [data-tab-id]'));
const tabEl = (id) => win.document.querySelector(`#tabList [data-tab-id="${id}"]`);
const text = (id, selector) => tabEl(id)?.querySelector(selector)?.textContent ?? null;

win.eval(`currentTabs = ${JSON.stringify(tabModel(6))}; activeTabId = 't1';`);

// Render 1: creates the six tab elements and fills each element's ref cache once.
reset();
win.eval('renderTabs()');
const cold = snapshot();

// Render 2: every element is already in the strip, so this is the steady-state path the
// 5 Hz state broadcast drives.
reset();
win.eval('renderTabs()');
const warm = snapshot();

console.log('--- selector work per render ---');
console.log(`first paint (creates 6 elements)  ${format(cold)}`);
console.log(`steady-state re-render            ${format(warm)}`);

check('first paint builds one element per tab', strip().length === 6, strip().length);
check(
  'each tab element carries the seven cached children plus the close button',
  strip().every((el) => ['tab-index-badge', 'tab-spinner', 'tab-icon', 'tab-title', 'tab-agent-badge', 'tab-audio-btn', 'tab-status-dot', 'tab-close']
    .every((cls) => el.querySelector(`.${cls}`) !== null)),
  strip().map((el) => el.children.length),
);
check('index badge is rendered per position', text('t6', '.tab-index-badge') === '#6', text('t6', '.tab-index-badge'));
check('title is rendered from the model', text('t3', '.tab-title') === 'Tab 3', text('t3', '.tab-title'));

check(
  'steady-state re-render runs no child selector at all',
  warm.querySelector === 0 && warm.querySelectorAll === 0,
  format(warm),
);
check(
  'steady-state re-render reads no attribute through a selector',
  ![...warm.selectors.keys()].some((key) => key.includes('data-tab-id')),
  [...warm.selectors.keys()],
);
check(
  'the cache fill costs exactly the seven child selectors per new element',
  (cold.selectors.get('querySelector:.tab-index-badge') ?? 0) === 6
    && (cold.selectors.get('querySelector:.tab-title') ?? 0) === 6
    && (cold.selectors.get('querySelector:.tab-agent-badge') ?? 0) === 6,
  {
    indexBadge: cold.selectors.get('querySelector:.tab-index-badge') ?? 0,
    title: cold.selectors.get('querySelector:.tab-title') ?? 0,
    agentBadge: cold.selectors.get('querySelector:.tab-agent-badge') ?? 0,
  },
);

// A re-render that carries new data must still repaint through the cached refs.
const changed = tabModel(6);
changed[2].title = 'RETITLED';
changed[2].isLoading = true;
changed[2].isAgentControlled = true;
changed[2].aiState = 'agent_working';
changed[4].isAudible = true;
win.eval(`currentTabs = ${JSON.stringify(changed)};`);
reset();
win.eval('renderTabs()');
const repaint = snapshot();

check('cached refs still repaint a changed title', text('t3', '.tab-title') === 'RETITLED', text('t3', '.tab-title'));
check('cached refs still toggle the agent badge', tabEl('t3')?.querySelector('.tab-agent-badge')?.style.display === 'inline-flex',
  tabEl('t3')?.querySelector('.tab-agent-badge')?.style.display);
check('cached refs still drive the loading spinner', tabEl('t3')?.querySelector('.tab-spinner')?.style.display === 'inline-block',
  tabEl('t3')?.querySelector('.tab-spinner')?.style.display);
check('cached refs still drive the audio button', tabEl('t5')?.querySelector('.tab-audio-btn')?.style.display === 'inline-flex',
  tabEl('t5')?.querySelector('.tab-audio-btn')?.style.display);
check('the repaint render ran no selector either', repaint.querySelector === 0, format(repaint));

// A tab added after the cache exists still gets its refs, and a closed one still leaves.
const grown = tabModel(7);
win.eval(`currentTabs = ${JSON.stringify(grown)};`);
reset();
win.eval('renderTabs()');
const added = snapshot();
check('a new tab is appended and painted', strip().length === 7 && text('t7', '.tab-title') === 'Tab 7', strip().length);
check('only the new element pays the cache fill', (added.selectors.get('querySelector:.tab-title') ?? 0) === 1, format(added));

win.eval(`currentTabs = ${JSON.stringify(tabModel(7).filter((t) => t.id !== 't4'))};`);
reset();
win.eval('renderTabs()');
const removed = snapshot();
check('a closed tab leaves the strip', strip().length === 6 && tabEl('t4') === null, strip().length);
check('the removal pass runs no selector', removed.querySelector === 0 && removed.querySelectorAll === 0, format(removed));

// --- path 2: the chrome-profile dropdown is rebuilt only when its input changes ------------
const dropdown = win.document.getElementById('profileDropdownList');
const phoneBody = win.document.getElementById('phoneStatusBody');
const phoneOverlay = win.document.getElementById('phoneStatusOverlay');
const phoneButton = win.document.getElementById('btnPhoneStatus');
const phoneText = win.document.getElementById('phoneStatusText');

/** DOM writes performed inside `target` while `run` executes. */
function mutationsIn(target, run) {
  const types = [];
  const observer = new win.MutationObserver(() => {});
  observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true });
  run();
  for (const record of observer.takeRecords()) types.push(record.type);
  observer.disconnect();
  return types.length;
}

const profileFixtures = [
  { id: 'p1', name: 'Work' },
  { id: 'p2', name: 'Personal' },
];
win.eval(`availableChromeProfiles = ${JSON.stringify(profileFixtures)}; activeProfileInfo = ${JSON.stringify(profileFixtures[0])};`);

const dropdownItems = () => Array.from(dropdown.children).length;
const dropdownFirst = mutationsIn(dropdown, () => win.eval('renderChromeProfiles()'));
const itemsAfterFirst = dropdownItems();
const dropdownSecond = mutationsIn(dropdown, () => win.eval('renderChromeProfiles()'));

check(
  'the chrome-profile dropdown builds its rows on the first push',
  itemsAfterFirst >= 2 && dropdownFirst > 0,
  { mutations: dropdownFirst, items: itemsAfterFirst },
);
check('an unchanged push rebuilds no chrome-profile row', dropdownSecond === 0, dropdownSecond);

const renamedProfiles = profileFixtures.map((p) => (p.id === 'p1' ? { id: 'p1', name: 'Work renamed' } : p));
win.eval(`availableChromeProfiles = ${JSON.stringify(renamedProfiles)};`);
const dropdownThird = mutationsIn(dropdown, () => win.eval('renderChromeProfiles()'));
check(
  'a renamed profile still rebuilds the dropdown',
  dropdownThird > 0 && dropdown.textContent.includes('Work renamed'),
  { mutations: dropdownThird, text: dropdown.textContent.replace(/\s+/g, ' ').slice(0, 48) },
);

// --- path 3: the phone panel body is rebuilt only while the panel is on screen -------------
const connectedPhone = { state: 'connected', name: 'iPhone 15', model: 'iPhone15,2', osVersion: '18.1' };
const disconnectedPhone = { state: 'disconnected' };

phoneOverlay.style.display = 'none';
win.eval(`renderPhoneStatus(${JSON.stringify(disconnectedPhone)})`);
const badgeHidden = phoneButton.style.display;
const closedPush = mutationsIn(phoneBody, () => win.eval(`renderPhoneStatus(${JSON.stringify(connectedPhone)})`));

check('a closed phone panel is not rebuilt by a push', closedPush === 0, closedPush);
check(
  'the phone badge still follows the state while the panel is closed',
  badgeHidden === 'none' && phoneButton.style.display === 'inline-flex' && phoneText.textContent.includes('iPhone 15'),
  { before: badgeHidden, after: phoneButton.style.display, text: phoneText.textContent },
);

phoneOverlay.style.display = 'flex';
const openPush = mutationsIn(phoneBody, () => win.eval(`renderPhoneStatus(${JSON.stringify(connectedPhone)})`));
check('an open phone panel still repaints on a push', openPush > 0, openPush);

const unplugPush = mutationsIn(phoneBody, () => win.eval(`renderPhoneStatus(${JSON.stringify(disconnectedPhone)})`));
check(
  'an open panel cannot keep showing a connected phone after unplug',
  unplugPush > 0 && phoneBody.textContent.includes('Không phát hiện thiết bị'),
  { mutations: unplugPush, text: phoneBody.textContent.replace(/\s+/g, ' ').slice(0, 56) },
);

console.log(`--- ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED: ${failures.join(', ')}`} ---`);
process.exit(failures.length === 0 ? 0 : 1);
