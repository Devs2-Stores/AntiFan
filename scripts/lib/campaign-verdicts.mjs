/**
 * Campaign run decisions that carry no RPC or browser state.
 *
 * These live apart from the orchestrator because they are the parts a live run
 * cannot cheaply re-check: the process exit status, the canonical verdict index
 * and the hub rendering. The orchestrator imports them; the unit test exercises
 * them directly, so a decision bug surfaces before a 45-case run.
 */
import { PROVENANCE_CODES } from './evidence-provenance.mjs';
export const EXIT = {
  OK: 0,
  USAGE: 2,
  NOT_MEASURABLE: 3,
  REFUSAL: 4,
};

export const ROUTE_REFUSAL_CODES = {
  HOST_MISMATCH: 'URL_HOST_MISMATCH',
  THEME_MISMATCH: 'URL_THEME_MISMATCH',
  PATH_MISMATCH: 'URL_PATH_MISMATCH',
  EXPECTATION_MISSING: 'URL_EXPECTATION_MISSING',
};

const ROUTE_REFUSAL_CODE_SET = new Set(Object.values(ROUTE_REFUSAL_CODES));

/**
 * A route refusal is a typed absence of a verdict, not a fidelity outcome. A page-level
 * refusal (the reference tab never reached the requested route) is recorded on the page
 * result while `overall` stays `INCONCLUSIVE`, and it mints no case — so the index's
 * `tally`/`routeRefusals` are empty and every renderer must ask this instead of printing
 * `overall`, or the refused page reads as a metrics shortfall.
 */
export function pageRouteRefusal(pageResult) {
  const code = pageResult?.refusal?.code ?? pageResult?.causeCode ?? null;
  if (!code || !ROUTE_REFUSAL_CODE_SET.has(code)) return null;
  return {
    code,
    reason: pageResult.refusal?.reason ?? pageResult.error ?? null,
    detail: pageResult.refusal?.detail ?? null,
  };
}

/** Display status for a page: the route refusal first, then the fidelity outcome. */
export function renderPageStatus(pageResult) {
  if (!pageResult) return 'NOT_TESTED';
  const refusal = pageRouteRefusal(pageResult);
  if (!refusal) return pageResult.overall ?? 'NOT_TESTED';
  const detail = refusal.detail ?? {};
  const requested = detail.requestedPath ?? detail.requested ?? '?';
  const observed = detail.observedPath ?? detail.observed ?? '?';
  return `REFUSED (${refusal.code}: requested ${requested}, tab reported ${observed})`;
}

export class VerdictRefusal extends Error {
  constructor({ code, message, exitCode = EXIT.REFUSAL, detail = null }) {
    super(message);
    this.name = 'VerdictRefusal';
    this.code = code;
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

export function refuseVerdict(code, exitCode = EXIT.REFUSAL, message, detail = null) {
  return new VerdictRefusal({ code, message, exitCode, detail });
}

export function hasMissingExpectation(vpOrCapture) {
  if (!vpOrCapture) return false;
  if (vpOrCapture.causeCode === 'URL_EXPECTATION_MISSING') return true;
  if (vpOrCapture.code === 'URL_EXPECTATION_MISSING') return true;
  if (vpOrCapture.refusal?.code === 'URL_EXPECTATION_MISSING') return true;
  if (vpOrCapture.missingExpectation === true) return true;
  if (vpOrCapture.expectationMarker === 'URL_EXPECTATION_MISSING') return true;
  if (vpOrCapture.routeAssertion?.status === 'URL_EXPECTATION_MISSING') return true;
  if (vpOrCapture.capture?.code === 'URL_EXPECTATION_MISSING') return true;
  if (vpOrCapture.capture?.missingExpectation === true) return true;
  if (vpOrCapture.capture?.expectedUrlMissing === true) return true;
  if (vpOrCapture.capture?.expectationMarker === 'URL_EXPECTATION_MISSING') return true;
  if (vpOrCapture.capture?.routeAssertion?.status === 'URL_EXPECTATION_MISSING') return true;
  if (vpOrCapture.capture?.expectedUrl === null && (vpOrCapture.capture?.marker === 'URL_EXPECTATION_MISSING' || vpOrCapture.capture?.valid === false)) return true;
  if (vpOrCapture.capture?.reference?.missingExpectation || vpOrCapture.capture?.clone?.missingExpectation) return true;
  if (vpOrCapture.capture?.reference?.code === 'URL_EXPECTATION_MISSING' || vpOrCapture.capture?.clone?.code === 'URL_EXPECTATION_MISSING') return true;
  return false;
}

export function mintVerdict(caseData) {
  if (!caseData || typeof caseData !== 'object') {
    throw refuseVerdict('INVALID_ARGUMENT', EXIT.REFUSAL, 'caseData is required to mint a verdict');
  }
  if (hasMissingExpectation(caseData)) {
    throw refuseVerdict('URL_EXPECTATION_MISSING', EXIT.REFUSAL, 'cannot mint a verdict whose capture carries URL_EXPECTATION_MISSING', { caseData });
  }
  return {
    verdict: caseData.overall ?? caseData.verdict ?? 'INCONCLUSIVE',
    causeCode: caseData.causeCode ?? 'UNCLASSIFIED',
    status: caseData.status ?? 'COMPLETED',
    refusal: caseData.refusal ?? null,
    expectedUrl: caseData.expectedUrl ?? caseData.capture?.expectedUrl ?? null,
    routeIdentity: caseData.routeIdentity ?? null,
  };
}


/**
 * A filter is refused unless every comma-separated part resolves and every id it
 * names is a page this campaign can run, before the lock is taken. This is also
 * the only parser for `--pages` ("3", "1-5", "2,7"): validating one parse and
 * running another let `'1,nonsense'` and `'1,5-3'` both parse to `[1]`, so the run
 * would cover a subset of what the operator asked for and never say so.
 *
 * Returns `{ ok: true, ids: null }` when no filter was given.
 */
export function validatePagesFilter(pages, targetIds) {
  if (!pages) return { ok: true, ids: null };
  const known = new Set(targetIds);
  const minId = targetIds[0];
  const maxId = targetIds[targetIds.length - 1];
  const outside = (id) => `--pages '${pages}' names ${id}, outside ${minId}-${maxId}`;
  const ids = [];
  for (const rawPart of String(pages).split(',')) {
    const part = rawPart.trim();
    if (part === '') return { ok: false, reason: `--pages '${pages}' has an empty entry` };
    // Digits only: `Number('-1')` is a number and `Number('1e2')` is 100, so a
    // numeric cast would accept shorthand that names a different page.
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) return { ok: false, reason: `--pages '${pages}' cannot read the range '${part}'` };
      // Bound before expanding: '1-999999999' must refuse, not allocate.
      if (start < minId) return { ok: false, reason: outside(start) };
      if (end > maxId) return { ok: false, reason: outside(end) };
      for (let id = start; id <= end; id += 1) ids.push(id);
      continue;
    }
    const single = /^(\d+)$/.exec(part);
    if (!single) return { ok: false, reason: `--pages '${pages}' cannot read '${part}'` };
    const id = Number(single[1]);
    if (!known.has(id)) return { ok: false, reason: outside(id) };
    ids.push(id);
  }
  return { ok: true, ids };
}

/**
 * The viewport scope of a run: which labels this invocation measures, and which it
 * leaves unverified.
 *
 * A viewport that is not run is declared, never silently missing — the verdict
 * artifact says which labels it never measured, because a batch that covers two of
 * three viewports must not read as a whole-clone verdict. Selection refuses an
 * unreadable entry for the same reason `--pages` does: a typo would otherwise
 * shrink the case set and still look like a complete run.
 */
export function selectViewports(allViewports, spec) {
  const labels = allViewports.map((v) => v.label);
  if (spec === undefined || spec === null || String(spec).trim() === '') {
    return { ok: true, viewports: allViewports, excluded: [], mobileUnverified: false };
  }
  const selected = [];
  for (const rawPart of String(spec).split(',')) {
    const label = rawPart.trim();
    if (label === '') return { ok: false, reason: `--viewports '${spec}' has an empty entry` };
    if (!labels.includes(label)) {
      return { ok: false, reason: `--viewports '${spec}' names '${label}', not one of ${labels.join('/')}` };
    }
    if (!selected.includes(label)) selected.push(label);
  }
  const viewports = allViewports.filter((v) => selected.includes(v.label));
  const excluded = allViewports
    .filter((v) => !selected.includes(v.label))
    .map((v) => ({ label: v.label, mobile: v.mobile === true, reason: 'not selected in this run: no bundle is verified for it here' }));
  return {
    ok: true,
    viewports,
    excluded,
    mobileUnverified: excluded.some((e) => e.mobile),
  };
}

/**
 * One canonical verdict and cause per page x viewport, in one machine-readable
 * index. Pre-existing evidence that carries no attempt identity is marked
 * superseded rather than being silently attributed to a fresh run.
 */
/**
 * Completed cases that name neither the bundle they measured nor the instance they
 * measured on. Such a case is not evidence, whether it is read from the run summary
 * or from the index that was built out of it, so both readers share this predicate.
 */
export function casesWithoutProvenance(cases) {
  return (cases || [])
    .filter((c) => c && c.status === 'COMPLETED' && (!c.bundle || !c.instance))
    .map((c) => ({ pageId: c.pageId, viewport: c.viewport ?? null }));
}

export function buildVerdictIndex(runSummary, { supersededSlugs = [] } = {}) {
  const cases = [];
  for (const [pageId, page] of Object.entries(runSummary.pageResults || {})) {
    for (const [vpLabel, vp] of Object.entries(page.viewports || {})) {
      if (hasMissingExpectation(vp)) {
        throw refuseVerdict(
          'URL_EXPECTATION_MISSING',
          EXIT.REFUSAL,
          `cannot mint a verdict whose capture carries URL_EXPECTATION_MISSING (page ${pageId}:${vpLabel})`,
          { pageId: Number(pageId), viewport: vpLabel, capture: vp.capture }
        );
      }
      const routeRefused = Boolean(vp.refusal && ROUTE_REFUSAL_CODE_SET.has(vp.refusal.code));
      cases.push({
        pageId: Number(pageId),
        slug: page.slug,
        page: page.name,
        viewport: vpLabel,
        dimension: vp.viewport ?? null,
        // A route refusal is a typed refusal, not a fidelity verdict: minting it as its
        // own class keeps the tally, the hub counts, and the case table on one reading
        // of the same fact, and keeps a refused leg out of PASS/FAIL/INCONCLUSIVE.
        verdict: routeRefused ? 'ROUTE_REFUSED' : (vp.overall ?? 'INCONCLUSIVE'),
        causeCode: vp.causeCode ?? (vp.status === 'BLOCKED_BY_BUILD' ? 'CLONE_BUILD_FAILED' : 'UNCLASSIFIED'),
        status: vp.status ?? null,
        visual: vp.visual?.verdict ?? null,
        mismatchPercentage: vp.visual?.mismatchPercentage ?? null,
        captureValid: vp.capture?.valid ?? null,
        geometry: vp.structure
          ? {
              reference: { docHeight: vp.structure.refDocH, sections: vp.structure.refSections, cards: vp.structure.refCards },
              clone: { docHeight: vp.structure.cloneDocH, sections: vp.structure.cloneSections, cards: vp.structure.cloneCards },
            }
          : null,
        artifacts: {
          referencePng: vp.capture?.reference?.sha256 ?? null,
          clonePng: vp.capture?.clone?.sha256 ?? null,
        },
        refusal: vp.refusal ?? null,
        bundle: vp.bundle ?? page.bundle ?? null,
        instance: vp.instance ?? runSummary.instance ?? null,
        attemptId: page.attemptId ?? null,
        evidenceRoot: page.evidenceRoot ?? null,
        routeIdentity: vp.routeIdentity ?? page.routeIdentity ?? null,
        expectedUrl: vp.capture?.expectedUrl ?? vp.expectedUrl ?? null,
      });
    }
  }

  const tally = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0, ROUTE_REFUSED: 0 };
  for (const c of cases) {
    // One count per case: a route refusal is minted as its own class, so no case can
    // be counted twice and a refused leg can never appear in the pass tally.
    tally[c.verdict] = (tally[c.verdict] || 0) + 1;
  }

  return {
    runId: runSummary.runId,
    generatedAt: new Date().toISOString(),
    startedAt: runSummary.startedAt,
    finishedAt: runSummary.finishedAt ?? null,
    instance: runSummary.instance ?? null,
    instanceRecord: runSummary.instanceRecord ?? null,
    runLock: runSummary.runLock ?? null,
    tabCensus: runSummary.tabCensus ?? null,
    // Which viewports this run measured, and which it left unverified. A reader
    // must be able to tell a two-viewport batch from a whole-clone verdict.
    scope: runSummary.scope ?? null,
    refusals: runSummary.refusals || [],
    tally,
    executiveVerdict: cases.length === 0 ? 'INCONCLUSIVE' : (tally.PASS === cases.length ? 'PASS' : (tally.FAIL > 0 ? 'FAIL' : 'INCONCLUSIVE')),
    cases,
    superseded: supersededSlugs.map((slug) => ({ slug, reason: 'evidence predates any attempt pointer' })),
    routeRefusals: cases.filter((c) => c.verdict === 'ROUTE_REFUSED'),
    exit: runSummary.exit ?? null,
  };
}

/**
 * A code here means a *requested* case was not produced, and the absence is
 * declared rather than failed: the case carries a cause code instead of a verdict,
 * and the process must not report the batch as complete.
 */
const DECLARED_CASE_ABSENCES = new Set(['MOBILE_BUNDLE_ABSENT']);

/**
 * Classify each requested page x viewport. The boundary is "did the case produce
 * evidence of an adjudication at all": a case that never ran is incomplete, a case
 * that ran and yielded a cause-coded verdict is output (a fidelity FAIL, and an
 * INCONCLUSIVE the reconciliation phase must explain), and a case that threw is a
 * runner error.
 */
function scanRequestedCases(runSummary, requestedPages, viewportLabels) {
  const incomplete = [];
  const runnerErrors = [];
  for (const p of requestedPages) {
    const pageResult = runSummary.pageResults[p.id];
    if (!pageResult) {
      incomplete.push({ pageId: p.id, viewport: null, code: 'PAGE_NOT_RUN' });
      continue;
    }
    const pageRefusal = pageRouteRefusal(pageResult);
    for (const label of viewportLabels) {
      const vp = pageResult.viewports?.[label];
      if (!vp) {
        // A page-level route refusal is why these legs do not exist; naming
        // CASE_NOT_RUN would drop the reason the run refused.
        incomplete.push({ pageId: p.id, viewport: label, code: pageRefusal ? pageRefusal.code : 'CASE_NOT_RUN' });
        continue;
      }
      const code = vp.causeCode ?? null;
      if (vp.status === 'ERROR') runnerErrors.push({ pageId: p.id, viewport: label, code: code || 'VIEWPORT_RUN_ERROR' });
      else if (vp.status === 'BLOCKED_BY_BUILD') incomplete.push({ pageId: p.id, viewport: label, code: code || 'CLONE_BUILD_FAILED' });
      // A refused case produced no adjudication, whether the absence was declared
      // (no mobile bundle) or the run stopped before the compare (readiness,
      // rasterization): either way the requested case did not happen.
      else if (vp.status === 'REFUSED') incomplete.push({ pageId: p.id, viewport: label, code: code || 'CASE_REFUSED' });
      else if (vp.overall !== 'PASS' && vp.overall !== 'FAIL' && vp.overall !== 'INCONCLUSIVE') {
        incomplete.push({ pageId: p.id, viewport: label, code: code || 'NO_VERDICT' });
      }
    }
  }
  return { incomplete, runnerErrors };
}

/**
 * The process exit status encodes process success only: an adjudicable fidelity
 * FAIL is valid campaign output and exits 0. Non-zero means the run itself could
 * not produce a complete, provenance-bound set of verdicts.
 *
 * `excludedViewports` names the viewports this run declared out of scope. A reduced
 * batch exits 0 only when at least one of its measured cases was adjudicated: scope
 * reduction exists to obtain a verdict on what remains, so a reduced batch that
 * adjudicated nothing is not a success and reports `NO_ADJUDICATED_CASE`.
 */
export function computeRunExit(runSummary, pagesFilter, { targetPages, viewportLabels, excludedViewports = [] }) {
  const requested = pagesFilter && pagesFilter.length > 0 ? targetPages.filter((p) => pagesFilter.includes(p.id)) : targetPages;
  const labels = viewportLabels && viewportLabels.length > 0 ? viewportLabels : [];
  const failedPages = Object.values(runSummary.pageResults).filter((p) => p.status === 'FAILED').map((p) => p.id);
  const provenanceRefusals = (runSummary.refusals || []).filter(
    (r) => r.code === PROVENANCE_CODES.IDENTITY_MISMATCH || r.code === PROVENANCE_CODES.BUNDLE_DRIFT
  );
  const { incomplete, runnerErrors } = scanRequestedCases(runSummary, requested, labels);

  // A route refusal is a typed refusal of the run, not an absent case. The run-level
  // record is the authoritative statement of it and is reported as-is; the per-leg
  // copies only speak for a page the run summary never named, so a page-level refusal
  // is not restated once per leg it removed. Either way the refusal wins over the
  // generic incomplete exit, so the report names the real cause instead of blaming the
  // pipeline for a document that was never measured.
  const runLevelRefusals = (runSummary.refusals || []).filter((r) => ROUTE_REFUSAL_CODE_SET.has(r.code));
  const pagesWithRunLevelRefusal = new Set(runLevelRefusals.map((r) => r.pageId));
  const seenRefusals = new Set();
  const routeRefusals = [];
  for (const r of [...runLevelRefusals, ...incomplete, ...runnerErrors]) {
    if (!ROUTE_REFUSAL_CODE_SET.has(r.code)) continue;
    if (!runLevelRefusals.includes(r) && pagesWithRunLevelRefusal.has(r.pageId)) continue;
    const key = `${r.pageId}:${r.viewport ?? ''}:${r.code}`;
    if (seenRefusals.has(key)) continue;
    seenRefusals.add(key);
    routeRefusals.push(r);
  }
  if (routeRefusals.length > 0) {
    return {
      code: EXIT.REFUSAL,
      reason: 'ROUTE_REFUSAL',
      detail: routeRefusals.map((r) => `${r.code}@page-${r.pageId}${r.viewport ? `:${r.viewport}` : ''}`),
    };
  }
  if (runSummary.lockLost) return { code: 1, reason: 'LOCK_LOST', detail: runSummary.lockLost };
  if (provenanceRefusals.length > 0) {
    return {
      code: 1,
      reason: 'PROVENANCE_REFUSAL',
      detail: provenanceRefusals.map((r) => `${r.code}@page-${r.pageId}${r.viewport ? `:${r.viewport}` : ''}`),
    };
  }
  // A case that finished without naming the bundle it measured and the instance it
  // measured on is not evidence, so the batch that contains it is not publishable.
  // Provenance resolves exactly as the index resolves it — the case's own value
  // first, then the page's bundle and the run's instance — so a case that inherits
  // is not mistaken for a case that is missing.
  const naked = casesWithoutProvenance(
    Object.values(runSummary.pageResults || {}).flatMap((p) =>
      Object.entries(p.viewports || {}).map(([label, vp]) => ({
        pageId: p.id,
        viewport: label,
        status: vp.status,
        bundle: vp.bundle ?? p.bundle ?? null,
        instance: vp.instance ?? runSummary.instance ?? null,
      }))
    )
  );
  if (naked.length > 0) {
    return { code: 1, reason: 'PROVENANCE_INCOMPLETE', detail: naked.map(({ pageId, viewport }) => `NO_PROVENANCE@page-${pageId}:${viewport}`) };
  }
  // A page that threw is a runner error even though its cases are also missing, and
  // the named reason matters more than the case list it implies.
  if (failedPages.length > 0) return { code: 1, reason: 'RUNNER_ERROR', failedPages };
  if (runnerErrors.length > 0) {
    return {
      code: 1,
      reason: 'RUNNER_ERROR',
      detail: runnerErrors.map((r) => `${r.code}@page-${r.pageId}${r.viewport ? `:${r.viewport}` : ''}`),
    };
  }
  // A declared absence is also recorded at run level, so it is counted even when the
  // case's own viewport entry is missing from the page result. A viewport outside the
  // run's declared scope is not a requested case, so a record naming one cannot make
  // the requested set incomplete; the runner does not execute excluded viewports, so
  // such a record means the scope was declared after that case was attempted.
  const format = (r) => `${r.code}@page-${r.pageId}${r.viewport ? `:${r.viewport}` : ''}`;
  const outOfScope = new Set(excludedViewports);
  const absenceDetails = new Set(incomplete.map(format));
  for (const r of (runSummary.refusals || []).filter((r) => DECLARED_CASE_ABSENCES.has(r.code) && !outOfScope.has(r.viewport))) {
    absenceDetails.add(format(r));
  }
  if (absenceDetails.size > 0) {
    // Requested cases that produced no adjudication at all: a page that never ran, a
    // case with no viewport entry, a bundle that was never built, a declared absence.
    return { code: 1, reason: 'INCOMPLETE_CASES', detail: [...absenceDetails] };
  }
  // The tally counts the cases this run was asked to measure: an excluded viewport is
  // declared out of scope, so its entry (a stale refusal, or a case recorded before the
  // scope was declared) must not appear as a measured result.
  const cases = Object.values(runSummary.pageResults || {}).flatMap((p) =>
    Object.entries(p.viewports || {})
      .filter(([label]) => !outOfScope.has(label) && (labels.length === 0 || labels.includes(label)))
      .map(([, vp]) => vp)
  );
  const tally = {
    adjudicableCases: cases.filter((c) => c.overall === 'PASS' || c.overall === 'FAIL').length,
    inconclusiveCases: cases.filter((c) => c.overall === 'INCONCLUSIVE').length,
  };
  if (excludedViewports.length > 0) {
    // Reducing scope is only worth anything if what remains gets adjudicated: a batch
    // that measured two viewports and validated none of them has verified nothing, and
    // reporting success would be the green-without-evidence failure this exit status
    // exists to prevent. The declared exclusion travels with the status either way.
    if (tally.adjudicableCases === 0) {
      const causes = [...new Set(cases.map((c) => c.causeCode).filter(Boolean))];
      return {
        code: 1,
        reason: 'NO_ADJUDICATED_CASE',
        detail: causes.length > 0 ? causes : ['NO_CASES'],
        unverifiedViewports: [...excludedViewports],
        ...tally,
      };
    }
    // The batch is complete for the scope it declared, and the declaration travels
    // with the status: an excluded viewport is unverified, so nothing about this
    // result claims it renders faithfully.
    return { code: 0, reason: 'OK_SCOPE_REDUCED', unverifiedViewports: [...excludedViewports], ...tally };
  }
  return { code: 0, reason: 'OK', ...tally };
}

/**
 * The hub is derived from the index, never hand-maintained: a page whose evidence
 * predates an attempt pointer appears as superseded, so opening the hub can never
 * show another run's verdict as if it were this run's.
 */
export function renderHubHtml(index, { viewportLabels }) {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const byPage = new Map();
  for (const c of index.cases) {
    if (!byPage.has(c.pageId)) byPage.set(c.pageId, { slug: c.slug, page: c.page, attemptId: c.attemptId, cases: [] });
    byPage.get(c.pageId).cases.push(c);
  }

  const rows = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, page]) => {
      const byViewport = new Map(page.cases.map((c) => [c.viewport, c]));
      const cells = viewportLabels
        .map((label) => {
          const c = byViewport.get(label);
          return c
            ? `<td class="v-${esc(c.verdict)}">${esc(c.verdict)}<span class="cause">${esc(c.causeCode)}</span></td>`
            : '<td class="v-missing">—</td>';
        })
        .join('');
      return `<tr><th>${id} ${esc(page.page)}<span class="slug">${esc(page.slug)}</span><span class="attempt">${esc(page.attemptId ?? 'no attempt')}</span></th>${cells}</tr>`;
    })
    .join('\n');

  const superseded = index.superseded.length
    ? `<p class="superseded">Superseded (no attempt pointer): ${index.superseded.map((s) => `${esc(s.slug)} — ${esc(s.reason)}`).join('; ')}</p>`
    : '';

  // A run that measured two of three viewports must not read as a clone verdict:
  // the exclusion is printed above the table, not inferred from a missing column.
  const excluded = index.scope?.excluded ?? [];
  // Printed for every run: a green tally with nothing adjudicated is the reading this
  // line exists to prevent, and it must be visible without opening the JSON. When the
  // run declared a scope, only the cases inside it count as measured — a case the scope
  // excludes would otherwise be reported as a measurement the run refused to make.
  const scopeLabels = index.scope?.viewports ?? null;
  const scopedCases = scopeLabels ? index.cases.filter((c) => scopeLabels.includes(c.viewport)) : index.cases;
  // A route-refused case produced no measurement, so it is reported by the REFUSED
  // line and excluded here: the measured counts and the run tally then read one fact
  // the same way instead of two.
  const measuredCases = scopedCases.filter((c) => c.verdict !== 'ROUTE_REFUSED');
  const adjudicated = measuredCases.filter((c) => c.verdict === 'PASS' || c.verdict === 'FAIL').length;
  const measured = measuredCases.length;
  const countOf = (verdict) => measuredCases.filter((c) => c.verdict === verdict).length;
  const adjudication = `<p class="scope">ADJUDICATED: ${adjudicated} of ${measured} measured case(s) carry a PASS/FAIL verdict (${countOf('PASS')} PASS / ${countOf('FAIL')} FAIL / ${countOf('INCONCLUSIVE')} INCONCLUSIVE)</p>`;
  const scope = excluded.length
    ? `<p class="scope">SCOPE: measured ${index.scope.viewports.map(esc).join(', ') || '—'} · NOT VERIFIED ${excluded
        .map((e) => esc(e.label))
        .join(', ')}${index.scope.mobileUnverified ? ' (mobile)' : ''} — an excluded viewport is unverified, not passing</p>`
    : '';
  // A refused page mints no case, so the table cannot show why it is absent: a route
  // refusal would render as a missing row. The refusal class is printed explicitly.
  const refusals = (index.refusals ?? []).length
    ? `<p class="refused">REFUSED: ${index.refusals
        .map((r) => {
          const detail = r.detail?.detail ?? r.detail ?? {};
          const where = `${r.pageId}${r.viewport ? `@${r.viewport}` : ''}`;
          const urls =
            detail.requested || detail.observed
              ? ` (requested ${detail.requestedPath ?? detail.requested} → tab reported ${detail.observedPath ?? detail.observed})`
              : '';
          return `${esc(where)} ${esc(r.code)}${esc(urls)}`;
        })
        .join('; ')}</p>`
    : '';

  return `<!doctype html>
<meta charset="utf-8">
<title>15-page campaign — ${esc(index.runId)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#111}
table{border-collapse:collapse;min-width:640px}
th,td{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}
td.v-PASS{background:#e6f5e6}td.v-FAIL{background:#fbe6e6}td.v-INCONCLUSIVE{background:#fdf5e0}td.v-ROUTE_REFUSED{background:#fbe6e6}
.cause{display:block;font-size:11px;color:#555}
.slug,.attempt{display:block;font-weight:400;font-size:11px;color:#666}
.superseded{background:#fdf5e0;padding:8px}
.scope{background:#eef2ff;padding:8px}
.refused{background:#fbe6e6;padding:8px}
.scope-inline{color:#444;font-weight:400}
</style>
<h1>15-page campaign</h1>
<p>run ${esc(index.runId)} — generated ${esc(index.generatedAt)} — verdict <strong>${esc(index.executiveVerdict)}</strong>${
    excluded.length ? ` <span class="scope-inline">(scope-reduced: ${index.scope.viewports.map(esc).join(', ')} measured)</span>` : ''
  }
(${index.tally.PASS} PASS / ${index.tally.FAIL} FAIL / ${index.tally.INCONCLUSIVE} INCONCLUSIVE)</p>
${adjudication}
${scope}
${refusals}
${superseded}
<table><thead><tr><th>Page</th>${viewportLabels.map((v) => `<th>${esc(v)}</th>`).join('')}</tr></thead>
<tbody>
${rows}
</tbody></table>
<p>Machine-readable: <code>_verdicts.json</code> · published report: <code>current-report.json</code></p>
`;
}
