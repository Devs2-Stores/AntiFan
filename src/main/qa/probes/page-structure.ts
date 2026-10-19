import type { ProbeDeps, ProbeResult } from './probe-deps';
import {
  HOME_STRUCTURE_RULES,
  classifyHomeSection,
  consecutiveDuplicateRoles,
  evaluateHomeStructure,
  type ClassifiedHomeSection,
  type HomeStructureRules,
  type RawHomeSection,
} from './home-structure-rules';

export interface PageStructureData {
  count: number;
  order: string[];
  heightShare: number[];
  duplicateRoles: string[];
}

interface PageStructureCapture {
  ok: boolean;
  reason?: string;
  viewportHeight: number;
  pageHeight: number;
  sections: RawHomeSection[];
}

// Collects raw signals only; role classification lives in home-structure-rules.ts.
// No backticks or dollar-brace sequences below: the runtime is embedded in a template string.
const PAGE_STRUCTURE_RUNTIME = String.raw`function () {
  var SKIP = /^(script|style|template|link|noscript|meta)$/i;
  var CHROME = /(^| )(header|announcement|announcement bar|topbar|top bar)( |$)/;
  function norm(s) { return String(s || '').toLowerCase().replace(/[-_]+/g, ' '); }
  function clsOf(el) { return typeof el.className === 'string' ? el.className.trim() : ''; }
  function typeOf(el) { return el.getAttribute('data-section-type') || el.getAttribute('data-section') || ''; }
  function isChrome(el) {
    if (el.tagName.toLowerCase() === 'header') return true;
    return CHROME.test(norm(typeOf(el)) + ' ' + norm(el.getAttribute('id')) + ' ' + norm(clsOf(el)));
  }
  function kids(scope) {
    return Array.prototype.filter.call(scope.children, function (c) { return !SKIP.test(c.tagName); });
  }
  var mainSel = ['main', '#MainContent', '#main-content', '[role="main"]', '#content', '.main-content'];
  var scope = null;
  for (var i = 0; i < mainSel.length && !scope; i += 1) scope = document.querySelector(mainSel[i]);
  scope = scope || document.body;
  for (var depth = 0; depth < 2; depth += 1) {
    var inner = kids(scope);
    if (inner.length === 1 && inner[0].children.length > 1) scope = inner[0]; else break;
  }
  var picked = kids(scope).filter(function (el) { return !isChrome(el); });
  var footerNodes = Array.prototype.slice.call(document.querySelectorAll('footer, [data-section-type*="footer"], .site-footer'));
  var footers = footerNodes.filter(function (f) {
    if (!(f.getBoundingClientRect().height > 0)) return false;
    if (footerNodes.some(function (o) { return o !== f && o.contains(f); })) return false;
    return !picked.some(function (el) { return el === f || el.contains(f); });
  });
  if (footers.length) picked.push(footers[footers.length - 1]);
  function uniq(el, selector) {
    var seen = {}; var n = 0;
    Array.prototype.forEach.call(el.querySelectorAll(selector), function (a) {
      var h = (a.getAttribute('href') || '').split('?')[0];
      if (h && !seen[h]) { seen[h] = 1; n += 1; }
    });
    return n;
  }
  var sy = window.pageYOffset || 0;
  var sections = [];
  picked.forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (!(r.height > 0)) return;
    var h = el.querySelector('h1, h2, h3');
    var cls = clsOf(el);
    sections.push({
      tag: el.tagName.toLowerCase(),
      id: el.getAttribute('id') || '',
      cls: cls.slice(0, 200),
      type: typeOf(el),
      heading: h ? (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100) : '',
      productLinks: uniq(el, 'a[href*="/products/"]'),
      collectionLinks: uniq(el, 'a[href*="/collections/"]'),
      blogLinks: uniq(el, 'a[href*="/blogs/"]'),
      hasEmailInput: !!el.querySelector('input[type="email"]'),
      imgCount: el.querySelectorAll('img, picture, video').length,
      top: r.top + sy,
      height: r.height,
      selector: el.getAttribute('id') ? '#' + el.getAttribute('id') : el.tagName.toLowerCase() + (cls ? '.' + cls.split(/\s+/)[0] : '')
    });
  });
  var doc = document.documentElement;
  return {
    ok: sections.length > 0,
    reason: sections.length > 0 ? undefined : 'no visible page sections found',
    viewportHeight: window.innerHeight || 0,
    pageHeight: Math.max(doc.scrollHeight || 0, document.body ? document.body.scrollHeight || 0 : 0),
    sections: sections
  };
}`;

export function buildPageStructureScript(): string {
  return `(${PAGE_STRUCTURE_RUNTIME})()`;
}

export async function runPageStructure(
  deps: ProbeDeps,
  p: { rules?: Partial<HomeStructureRules>; viewportHeight?: number } = {}
): Promise<ProbeResult<PageStructureData>> {
  const empty: PageStructureData = { count: 0, order: [], heightShare: [], duplicateRoles: [] };
  let capture: PageStructureCapture | undefined;
  try {
    capture = (await deps.evalJs(buildPageStructureScript())) as PageStructureCapture | undefined;
  } catch (err) {
    return { measured: false, passed: null, findings: [], data: empty, error: err instanceof Error ? err.message : String(err) };
  }
  if (!capture || !capture.ok || !Array.isArray(capture.sections)) {
    return { measured: false, passed: null, findings: [], data: empty, error: capture?.reason ?? 'page structure script returned nothing' };
  }

  const rules: HomeStructureRules = { ...HOME_STRUCTURE_RULES, ...p.rules };
  const sections: ClassifiedHomeSection[] = capture.sections.map((s) => ({ ...s, role: classifyHomeSection(s) }));
  const viewportHeight = p.viewportHeight ?? capture.viewportHeight;
  const findings = evaluateHomeStructure(sections, { viewportHeight, pageHeight: capture.pageHeight }, rules);

  const total = sections.reduce((sum, s) => sum + s.height, 0);
  const order = sections.map((s) => s.role);
  return {
    measured: true,
    passed: !findings.some((f) => f.severity === 'critical'),
    findings,
    data: {
      count: sections.filter((s) => s.role !== 'footer').length,
      order,
      heightShare: sections.map((s) => (total > 0 ? Number((s.height / total).toFixed(4)) : 0)),
      duplicateRoles: consecutiveDuplicateRoles(order),
    },
  };
}
