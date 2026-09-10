/**
 * Campaign run decisions that carry no RPC or browser state.
 *
 * These live apart from the orchestrator because they are the parts a live run
 * cannot cheaply re-check: the process exit status, the canonical verdict index
 * and the hub rendering. The orchestrator imports them; the unit test exercises
 * them directly, so a decision bug surfaces before a 45-case run.
 */
import { PROVENANCE_CODES } from './evidence-provenance.mjs';

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
  const ids = [];
  for (const rawPart of String(pages).split(',')) {
    const part = rawPart.trim();
    if (part === '') return { ok: false, reason: `--pages '${pages}' has an empty entry` };
    const bounds = part.split('-');
    if (bounds.length > 2) return { ok: false, reason: `--pages '${pages}' cannot read '${part}'` };
    if (bounds.length === 2) {
      const [start, end] = bounds.map(Number);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        return { ok: false, reason: `--pages '${pages}' cannot read the range '${part}'` };
      }
      for (let id = start; id <= end; id += 1) ids.push(id);
      continue;
    }
    const id = Number(part);
    if (!Number.isInteger(id)) return { ok: false, reason: `--pages '${pages}' cannot read '${part}'` };
    ids.push(id);
  }
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return { ok: false, reason: `--pages '${pages}' names ${unknown.join(', ')}, outside ${targetIds[0]}-${targetIds[targetIds.length - 1]}` };
  }
  return { ok: true, ids };
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
      cases.push({
        pageId: Number(pageId),
        slug: page.slug,
        page: page.name,
        viewport: vpLabel,
        dimension: vp.viewport ?? null,
        verdict: vp.overall ?? 'INCONCLUSIVE',
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
      });
    }
  }

  const tally = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
  for (const c of cases) tally[c.verdict] = (tally[c.verdict] || 0) + 1;

  return {
    runId: runSummary.runId,
    generatedAt: new Date().toISOString(),
    startedAt: runSummary.startedAt,
    finishedAt: runSummary.finishedAt ?? null,
    instance: runSummary.instance ?? null,
    instanceRecord: runSummary.instanceRecord ?? null,
    runLock: runSummary.runLock ?? null,
    tabCensus: runSummary.tabCensus ?? null,
    refusals: runSummary.refusals || [],
    tally,
    executiveVerdict: cases.length === 0 ? 'INCONCLUSIVE' : (tally.PASS === cases.length ? 'PASS' : (tally.FAIL > 0 ? 'FAIL' : 'INCONCLUSIVE')),
    cases,
    superseded: supersededSlugs.map((slug) => ({ slug, reason: 'evidence predates any attempt pointer' })),
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
    for (const label of viewportLabels) {
      const vp = pageResult.viewports?.[label];
      if (!vp) {
        incomplete.push({ pageId: p.id, viewport: label, code: 'CASE_NOT_RUN' });
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
 */
export function computeRunExit(runSummary, pagesFilter, { targetPages, viewportLabels }) {
  const requested = pagesFilter && pagesFilter.length > 0 ? targetPages.filter((p) => pagesFilter.includes(p.id)) : targetPages;
  const labels = viewportLabels && viewportLabels.length > 0 ? viewportLabels : [];
  const failedPages = Object.values(runSummary.pageResults).filter((p) => p.status === 'FAILED').map((p) => p.id);
  const provenanceRefusals = runSummary.refusals.filter(
    (r) => r.code === PROVENANCE_CODES.IDENTITY_MISMATCH || r.code === PROVENANCE_CODES.BUNDLE_DRIFT
  );
  const { incomplete, runnerErrors } = scanRequestedCases(runSummary, requested, labels);

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
  // case's own viewport entry is missing from the page result.
  const format = (r) => `${r.code}@page-${r.pageId}${r.viewport ? `:${r.viewport}` : ''}`;
  const absenceDetails = new Set(incomplete.map(format));
  for (const r of runSummary.refusals.filter((r) => DECLARED_CASE_ABSENCES.has(r.code))) absenceDetails.add(format(r));
  if (absenceDetails.size > 0) {
    // Requested cases that produced no adjudication at all: a page that never ran, a
    // case with no viewport entry, a bundle that was never built, a declared absence.
    return { code: 1, reason: 'INCOMPLETE_CASES', detail: [...absenceDetails] };
  }
  const cases = Object.values(runSummary.pageResults || {}).flatMap((p) => Object.values(p.viewports || {}));
  return {
    code: 0,
    reason: 'OK',
    adjudicableCases: cases.filter((c) => c.overall === 'PASS' || c.overall === 'FAIL').length,
    inconclusiveCases: cases.filter((c) => c.overall === 'INCONCLUSIVE').length,
  };
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

  return `<!doctype html>
<meta charset="utf-8">
<title>15-page campaign — ${esc(index.runId)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#111}
table{border-collapse:collapse;min-width:640px}
th,td{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}
td.v-PASS{background:#e6f5e6}td.v-FAIL{background:#fbe6e6}td.v-INCONCLUSIVE{background:#fdf5e0}
.cause{display:block;font-size:11px;color:#555}
.slug,.attempt{display:block;font-weight:400;font-size:11px;color:#666}
.superseded{background:#fdf5e0;padding:8px}
</style>
<h1>15-page campaign</h1>
<p>run ${esc(index.runId)} — generated ${esc(index.generatedAt)} — verdict <strong>${esc(index.executiveVerdict)}</strong>
(${index.tally.PASS} PASS / ${index.tally.FAIL} FAIL / ${index.tally.INCONCLUSIVE} INCONCLUSIVE)</p>
${superseded}
<table><thead><tr><th>Page</th>${viewportLabels.map((v) => `<th>${esc(v)}</th>`).join('')}</tr></thead>
<tbody>
${rows}
</tbody></table>
<p>Machine-readable: <code>_verdicts.json</code> · published report: <code>current-report.json</code></p>
`;
}
