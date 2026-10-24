import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyQaWaivers,
  collectReceiptFindings,
  buildReceiptFindings,
  type ThemeQaDetailedFindings,
  type ThemeQaStrictFailure,
} from '../../src/main/qa/theme-qa-workflow';
import { boundQaReportResponse, QA_RESPONSE_BUDGET_BYTES } from '../../src/main/qa/qa-response-bounds';

describe('classifyQaWaivers', () => {
  it('accepts waivable rule ids and echoes them', () => {
    const { accepted, ignored } = classifyQaWaivers([
      { rule: 'font-below-min', reason: 'parity with reference' },
      { rule: 'edge-control', reason: 'measured' },
    ]);
    assert.deepEqual(accepted.map((w) => w.rule), ['font-below-min', 'edge-control']);
    assert.deepEqual(ignored, []);
  });

  it('reports layout_integrity ids as unwaivable instead of dropping them silently', () => {
    const { accepted, ignored } = classifyQaWaivers([
      { rule: 'layout_integrity:clipping', reason: 'carousel bleed' },
      { rule: 'layout_integrity@768:offscreen', reason: 'carousel bleed' },
    ]);
    assert.deepEqual(accepted, []);
    assert.equal(ignored.length, 2);
    assert.match(ignored[0]!.why, /cannot be waived/);
    assert.match(ignored[0]!.why, /inert/);
    assert.equal(ignored[1]!.rule, 'layout_integrity@768:offscreen');
  });

  it('points a width-suffixed id at its waivable base id', () => {
    const { accepted, ignored } = classifyQaWaivers([{ rule: 'font-below-min@375', reason: 'x' }]);
    assert.deepEqual(accepted, []);
    assert.match(ignored[0]!.why, /base id 'font-below-min'/);
  });

  it('names rules that never fail a run and unknown ids', () => {
    const { ignored } = classifyQaWaivers([
      { rule: 'image-low-res', reason: 'x' },
      { rule: 'no-such-rule', reason: 'x' },
    ]);
    assert.match(ignored[0]!.why, /never fails a run/);
    assert.match(ignored[1]!.why, /not a waivable rule id/);
  });
});

describe('receipt findings reconcile with criticalCount', () => {
  const spacingWarning = {
    kind: 'spacing' as const,
    ruleId: 'edge-control',
    severity: 'warning' as const,
    selector: 'a.cta',
    details: 'control hugs the edge',
    rect: { x: 0, y: 0, w: 10, h: 10 },
  };
  const strictSpacing: ThemeQaStrictFailure = {
    rule: 'layout_integrity@1440:spacing:edge-control',
    severity: 'critical',
    selector: 'a.cta',
    rect: null,
    message: 'control hugs the edge',
    activeKey: `spacing:a.cta:${spacingWarning.details.slice(0, 80)}`,
  };
  const stateFailure: ThemeQaStrictFailure = {
    rule: 'state_matrix:OVERLAY_NOT_OPENED',
    severity: 'critical',
    selector: null,
    rect: null,
    message: 'Overlay cart: did not open',
  };

  const base = {
    layoutIntegrity: {
      measured: true,
      viewport: { width: 1440 },
      findings: [spacingWarning],
    },
    strictFailures: [strictSpacing, stateFailure],
  } as unknown as ThemeQaDetailedFindings;

  it('lists build-strict failures as criticals and lists a promoted spacing warning once', () => {
    const listed = collectReceiptFindings(base);
    assert.equal(listed.filter((f) => f.severity === 'critical').length, 2);
    assert.equal(listed.filter((f) => f.severity === 'warning').length, 0, 'the promoted warning is not repeated as a warning');
    assert.deepEqual(listed.map((f) => f.rule).sort(), ['layout_integrity@1440:spacing:edge-control', 'state_matrix:OVERLAY_NOT_OPENED']);
  });

  it('leaves an unpromoted spacing warning as a warning', () => {
    const listed = collectReceiptFindings({ ...base, strictFailures: undefined } as ThemeQaDetailedFindings);
    assert.deepEqual(listed.map((f) => f.severity), ['warning']);
  });

  it('does not cap the full list, only the receipt slice', () => {
    const ratchet = { ok: false, findings: Array.from({ length: 500 }, (_, i) => ({ rule: 'dead-setting', id: `s${i}`, message: 'dead' })) };
    const all = collectReceiptFindings(base, ratchet);
    assert.equal(all.length, 502);
    assert.equal(buildReceiptFindings(base, ratchet, 200).length, 200);
  });
});

describe('boundQaReportResponse', () => {
  const makeReport = (count: number) => ({
    runId: 'run-1',
    summary: { passed: false, verdict: 'FAIL', criticalCount: count },
    receipt: { written: true, path: 'C:/work/.antifan/qa-receipts/run-1.json' },
    waivers: [{ rule: 'font-below-min', reason: 'parity' }],
    findings: {
      settingsRatchet: Array.from({ length: count }, (_, i) => ({ rule: 'dead-setting', severity: i % 7 === 0 ? 'critical' : 'warning', message: `x`.repeat(300), id: `s${i}` })),
      evidenceGaps: ['gap one', 'gap two'],
    },
  });

  it('returns a small report untouched', () => {
    const report = makeReport(3);
    assert.equal(boundQaReportResponse(report), report);
  });

  it('bounds a large report, keeps it parseable and names the receipt and the cuts', () => {
    const report = makeReport(2000);
    const originalBytes = Buffer.byteLength(JSON.stringify(report));
    assert.ok(originalBytes > QA_RESPONSE_BUDGET_BYTES * 4);
    const bounded = boundQaReportResponse(report) as Record<string, any>;
    const text = JSON.stringify(bounded);
    assert.ok(Buffer.byteLength(text) <= QA_RESPONSE_BUDGET_BYTES, `bounded response is ${Buffer.byteLength(text)} bytes`);
    const parsed = JSON.parse(text);
    assert.equal(parsed.summary.criticalCount, 2000);
    assert.equal(parsed.runId, 'run-1');
    assert.equal(parsed.responseBound.truncated, true);
    assert.equal(parsed.responseBound.originalBytes, originalBytes);
    assert.equal(parsed.responseBound.receiptPath, 'C:/work/.antifan/qa-receipts/run-1.json');
    assert.ok(parsed.responseBound.cuts.some((c: { path: string; total: number }) => c.path.includes('settingsRatchet') && c.total === 2000));
    assert.ok(parsed.findings.settingsRatchet[0].severity === 'critical', 'critical entries lead the kept slice');
    assert.equal(report.findings.settingsRatchet.length, 2000, 'the input is not mutated');
  });

  it('honours a small budget and keeps the verdict', () => {
    const report = { ...makeReport(5), huge: 'y'.repeat(QA_RESPONSE_BUDGET_BYTES * 2) };
    const bounded = boundQaReportResponse(report, 4096) as Record<string, any>;
    const text = JSON.stringify(bounded);
    assert.ok(Buffer.byteLength(text) <= 4096);
    assert.equal(JSON.parse(text).summary.verdict, 'FAIL');
  });
});
