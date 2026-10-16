import type { ProbeDeps, ProbeFinding, ProbeResult } from './probe-deps';

export interface MenuDepthData {
  maxDepth: number;
  perLevelCounts: number[];
  level3Visible: boolean;
  mobileMaxDepth?: number;
}

export type MenuOp = 'discover' | 'visible' | 'find-opener' | 'cleanup';

interface MenuItemRecord {
  path: string;
  depth: number;
  label: string;
  hasSub: boolean;
  parent: string | null;
  hasToggle: boolean;
}

interface DiscoverResult {
  ok: boolean;
  reason?: string;
  items: MenuItemRecord[];
}

interface VisibleResult {
  visibleByDepth: number[];
  maxVisibleDepth: number;
}

const MAX_TOP_INTERACTIONS = 10;
const MAX_CHILD_INTERACTIONS = 4;

// Marks the menu it finds with data-af-menu / data-af-menu-toggle attributes so the host can address items by
// selector; the cleanup op removes them. No backticks or dollar-brace sequences: embedded in a template string.
const MENU_RUNTIME = String.raw`function (op, mobile) {
  var ITEM = 'li, [role="menuitem"]';
  var LIST = 'ul, ol, [role="menu"], [role="menubar"]';
  var MOBILE_RE = /mobile|drawer|offcanvas|off-canvas|sidemenu|side-menu|slide-?menu|hamburger/i;
  var DESKTOP_ROOTS = ['nav.main-nav', '.main-nav', '.site-nav', '#site-nav', '[data-menu="desktop"]', 'header nav', 'nav[aria-label]', 'nav', '[role="navigation"]'];
  var MOBILE_ROOTS = ['[class*="mobile-menu"]', '[class*="mobile-nav"]', '#mobile-menu', '[class*="drawer"] nav', '[class*="drawer"]', '[class*="offcanvas"]', '[class*="off-canvas"]', '[data-mobile-menu]', '[role="dialog"] nav'];
  var OPENERS = ['button[aria-label*="menu"]', 'button[aria-label*="Menu"]', '[aria-label*="menu"][role="button"]', '[aria-label*="Menu"][role="button"]', '.hamburger', '.menu-toggle', '.menu-icon', '.nav-toggle', '.mobile-menu-toggle', '[data-action*="menu"]', 'button[aria-controls*="menu"]', '[class*="burger"]', '[class*="menu-toggle"]', '[class*="menu-btn"]'];
  var TOGGLE_SEL = 'button, summary, [class*="arrow"], [class*="toggle"], [class*="caret"], [class*="expand"], [class*="chevron"], [aria-expanded]';

  function isVisible(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity) === 0 || n.hidden) return false;
    }
    var r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    return !(r.right <= 0 || r.bottom <= 0 || r.left >= (window.innerWidth || 1e9));
  }
  function clsOf(n) { return typeof n.className === 'string' ? n.className : ''; }
  function mobileish(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (MOBILE_RE.test((n.id || '') + ' ' + clsOf(n))) return true;
    }
    return false;
  }
  function itemOf(node) { return node ? node.closest(ITEM) : null; }
  function directItems(list) {
    return Array.prototype.filter.call(list.children, function (c) { return c.matches(ITEM); });
  }
  function childLists(item) {
    return Array.prototype.filter.call(item.querySelectorAll(LIST), function (l) { return itemOf(l.parentElement) === item; });
  }
  function labelEl(item) {
    var found = Array.prototype.find.call(item.children, function (c) { return !c.matches(LIST) && !c.querySelector(LIST); });
    return found || item;
  }
  function topList(root) {
    var lists = Array.prototype.filter.call(root.querySelectorAll(LIST), function (l) {
      var it = itemOf(l.parentElement);
      return !it || !root.contains(it);
    });
    if (root.matches(LIST)) lists.unshift(root);
    var best = null; var bestN = 0;
    lists.forEach(function (l) { var n = directItems(l).length; if (n > bestN) { best = l; bestN = n; } });
    return bestN >= 2 ? best : null;
  }
  function candidates() {
    var sels = mobile ? MOBILE_ROOTS.concat(DESKTOP_ROOTS) : DESKTOP_ROOTS;
    var out = [];
    sels.forEach(function (s) {
      Array.prototype.forEach.call(document.querySelectorAll(s), function (el) {
        if (out.indexOf(el) < 0 && (mobile || !mobileish(el))) out.push(el);
      });
    });
    return out;
  }
  function clear() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-af-menu], [data-af-menu-toggle], [data-af-menu-opener]'), function (el) {
      el.removeAttribute('data-af-menu'); el.removeAttribute('data-af-menu-toggle'); el.removeAttribute('data-af-menu-opener');
    });
  }

  if (op === 'cleanup') { clear(); return { ok: true }; }

  if (op === 'visible') {
    var byDepth = []; var maxD = 0;
    Array.prototype.forEach.call(document.querySelectorAll('[data-af-menu]'), function (item) {
      if (!isVisible(labelEl(item))) return;
      var d = item.getAttribute('data-af-menu').split('.').length;
      byDepth[d - 1] = (byDepth[d - 1] || 0) + 1;
      if (d > maxD) maxD = d;
    });
    for (var k = 0; k < byDepth.length; k += 1) byDepth[k] = byDepth[k] || 0;
    return { visibleByDepth: byDepth, maxVisibleDepth: maxD };
  }

  if (op === 'find-opener') {
    var open = false;
    MOBILE_ROOTS.forEach(function (s) {
      Array.prototype.forEach.call(document.querySelectorAll(s), function (el) {
        var l = topList(el);
        if (l && isVisible(directItems(l)[0])) open = true;
      });
    });
    if (open) return { ok: true, alreadyOpen: true, selector: null };
    for (var i = 0; i < OPENERS.length; i += 1) {
      var el = Array.prototype.find.call(document.querySelectorAll(OPENERS[i]), isVisible);
      if (el) { el.setAttribute('data-af-menu-opener', '1'); return { ok: true, alreadyOpen: false, selector: '[data-af-menu-opener="1"]' }; }
    }
    return { ok: true, alreadyOpen: false, selector: null };
  }

  clear();
  var roots = candidates();
  var top = null;
  for (var r = 0; r < roots.length && !top; r += 1) top = topList(roots[r]);
  if (!top) return { ok: false, reason: 'no navigation list with at least two items found', items: [] };

  var items = [];
  function collect(item, path, depth, parent) {
    if (items.length >= 400 || depth > 5) return;
    var subs = [];
    childLists(item).forEach(function (l) { directItems(l).forEach(function (s) { subs.push(s); }); });
    var lab = labelEl(item);
    var toggle = Array.prototype.find.call(item.children, function (c) { return c.matches(TOGGLE_SEL) && !c.matches(LIST) && !c.querySelector(LIST); });
    if (!toggle && lab !== item && lab.hasAttribute('aria-expanded')) toggle = lab;
    item.setAttribute('data-af-menu', path);
    if (toggle && subs.length) toggle.setAttribute('data-af-menu-toggle', path);
    items.push({
      path: path,
      depth: depth,
      label: (lab.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      hasSub: subs.length > 0,
      parent: parent,
      hasToggle: !!(toggle && subs.length)
    });
    subs.forEach(function (s, j) { collect(s, path + '.' + j, depth + 1, path); });
  }
  directItems(top).forEach(function (t, i) { collect(t, String(i), 1, null); });
  return { ok: true, items: items };
}`;

export function buildMenuScript(op: MenuOp, opts: { mobile?: boolean } = {}): string {
  return `(${MENU_RUNTIME})(${JSON.stringify(op)}, ${JSON.stringify(opts.mobile === true)})`;
}

export async function runMenuDepth(
  deps: ProbeDeps,
  p: { expectedMaxDepth?: number; mobile?: boolean } = {}
): Promise<ProbeResult<MenuDepthData>> {
  const mobile = p.mobile === true;
  const empty: MenuDepthData = { maxDepth: 0, perLevelCounts: [], level3Visible: false };
  const findings: ProbeFinding[] = [];

  try {
    if (mobile) {
      const opener = (await deps.evalJs(buildMenuScript('find-opener', { mobile }))) as { selector: string | null } | undefined;
      if (opener?.selector) {
        const clicked = await deps.click(opener.selector);
        if (!clicked.ok) {
          findings.push({ ruleId: 'menu-interaction-failed', severity: 'info', message: `Could not click the menu opener: ${clicked.error ?? 'unknown'}.` });
        }
        await deps.wait(300);
      }
    }

    const found = (await deps.evalJs(buildMenuScript('discover', { mobile }))) as DiscoverResult | undefined;
    if (!found || !found.ok) {
      return {
        measured: false,
        passed: null,
        findings: [
          ...findings,
          { ruleId: 'menu-not-found', severity: 'info', message: found?.reason ?? 'menu discovery returned nothing' },
        ],
        data: empty,
        error: found?.reason ?? 'menu discovery returned nothing',
      };
    }

    const items = found.items;
    const maxDepth = items.reduce((m, i) => Math.max(m, i.depth), 0);
    const perLevelCounts: number[] = [];
    for (const item of items) perLevelCounts[item.depth - 1] = (perLevelCounts[item.depth - 1] ?? 0) + 1;

    let maxVisibleDepth = 1;
    let failedInteractions = 0;
    const open = async (item: MenuItemRecord): Promise<void> => {
      const target = mobile && item.hasToggle ? `[data-af-menu-toggle="${item.path}"]` : `[data-af-menu="${item.path}"]`;
      let res = mobile ? await deps.click(target) : await deps.hover(target);
      if (!res.ok && !mobile) res = await deps.click(target);
      if (!res.ok) {
        failedInteractions += 1;
        return;
      }
      await deps.wait(mobile ? 150 : 120);
      const seen = (await deps.evalJs(buildMenuScript('visible', { mobile }))) as VisibleResult | undefined;
      if (seen && seen.maxVisibleDepth > maxVisibleDepth) maxVisibleDepth = seen.maxVisibleDepth;
    };

    const tops = items.filter((i) => i.depth === 1 && i.hasSub).slice(0, MAX_TOP_INTERACTIONS);
    for (const top of tops) {
      await open(top);
      const children = items.filter((i) => i.parent === top.path && i.hasSub).slice(0, MAX_CHILD_INTERACTIONS);
      for (const child of children) await open(child);
    }

    if (failedInteractions > 0) {
      findings.push({
        ruleId: 'menu-interaction-failed',
        severity: 'info',
        message: `${failedInteractions} menu item${failedInteractions === 1 ? '' : 's'} could not be ${mobile ? 'clicked' : 'hovered'}; visible depth may be understated.`,
        measured: { failedInteractions },
      });
    }

    const where = mobile ? 'mobile drawer' : 'desktop menu';
    const expected = p.expectedMaxDepth;
    if (expected !== undefined && maxDepth < expected) {
      findings.push({
        ruleId: 'menu-level-not-rendered',
        severity: 'critical',
        message: `The ${where} renders ${maxDepth} level${maxDepth === 1 ? '' : 's'} but the navigation tree has ${expected}; levels beyond ${maxDepth} are missing from the markup.`,
        measured: { rendered: maxDepth, expected, perLevelCounts },
      });
    }
    if (maxDepth >= 3 && maxVisibleDepth < 3) {
      findings.push({
        ruleId: 'menu-level-not-visible',
        severity: expected !== undefined && expected >= 3 ? 'critical' : 'warning',
        message: `The ${where} has a third level in the markup but it never became visible after ${mobile ? 'clicking' : 'hovering'} its parents.`,
        measured: { rendered: maxDepth, visible: maxVisibleDepth },
      });
    }

    const data: MenuDepthData = { maxDepth, perLevelCounts, level3Visible: maxVisibleDepth >= 3 };
    if (mobile) data.mobileMaxDepth = maxVisibleDepth;
    return { measured: true, passed: !findings.some((f) => f.severity === 'critical'), findings, data };
  } catch (err) {
    return { measured: false, passed: null, findings, data: empty, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await deps.evalJs(buildMenuScript('cleanup', { mobile })).catch(() => undefined);
  }
}
