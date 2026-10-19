// Contract tests for side-by-side layout candidates: PNG contact-sheet maths and the
// orchestration/scoring around the in-page measurements. Real captures and real CSS are pinned
// by test/e2e/layout-candidates-fixtures-probe.cjs.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { composeContactSheet, composeContactSheetFromPngs, decodePng, decodePngAsync, downscale, encodePng, encodePngAsync, readPngSize, stackPngsVertically, CONTACT_SHEET_COLUMN_COLORS, type RgbaImage } from '../../src/main/verification/png-contact-sheet';
import { normalizeCandidateOptions, runLayoutCandidates, scoreCandidateWidth, type LayoutCandidatesDeps, type SectionMetrics } from '../../src/main/qa/layout-candidates';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { issueRuntimeLease, makeControlPlaneId, type BrowserTarget } from '../../src/shared/control-plane-contracts';

function solid(width: number, height: number, rgb: [number, number, number]): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}
const px = (img: RgbaImage, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe('png contact sheet', () => {
  it('round-trips RGBA through encode/decode', () => {
    const img = solid(7, 5, [10, 200, 30]);
    img.data[0] = 255; img.data[1] = 0; img.data[2] = 0;
    const back = decodePng(encodePng(img));
    assert.ok(back);
    assert.strictEqual(back.width, 7);
    assert.strictEqual(back.height, 5);
    assert.deepStrictEqual(px(back, 0, 0), [255, 0, 0, 255]);
    assert.deepStrictEqual(px(back, 6, 4), [10, 200, 30, 255]);
  });

  it('refuses bytes that are not a supported PNG', () => {
    assert.strictEqual(decodePng(Buffer.from('not a png at all, definitely not')), null);
  });

  it('box-downscales by an integer factor', () => {
    const img = solid(4, 2, [0, 0, 0]);
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) img.data.fill(255, (y * 4 + x) * 4, (y * 4 + x) * 4 + 3);
    const half = downscale(img, 2);
    assert.strictEqual(half.width, 2);
    assert.strictEqual(half.height, 1);
    assert.deepStrictEqual(px(half, 0, 0), [255, 255, 255, 255]);
    assert.deepStrictEqual(px(half, 1, 0), [0, 0, 0, 255]);
  });

  it('lays columns left to right with a colour bar per column and pads shorter ones', () => {
    const a = solid(10, 20, [255, 255, 255]);
    const b = solid(10, 6, [0, 0, 0]);
    const { image, factor } = composeContactSheet([a, b], { gutter: 2, headerBarHeight: 3, background: [9, 9, 9] });
    assert.strictEqual(factor, 1);
    assert.strictEqual(image.width, 2 + 10 + 2 + 10 + 2);
    assert.strictEqual(image.height, 20 + 3 + 4);
    assert.deepStrictEqual(px(image, 2, 2), [...CONTACT_SHEET_COLUMN_COLORS[0]!, 255], 'baseline bar');
    assert.deepStrictEqual(px(image, 14, 2), [...CONTACT_SHEET_COLUMN_COLORS[1]!, 255], 'first candidate bar');
    assert.deepStrictEqual(px(image, 2, 5), [255, 255, 255, 255]);
    assert.deepStrictEqual(px(image, 14, 5), [0, 0, 0, 255]);
    assert.deepStrictEqual(px(image, 14, 20), [9, 9, 9, 255], 'shorter column padded with background');
  });

  it('downscales the whole sheet to respect maxWidth', () => {
    const { image, factor } = composeContactSheet([solid(1000, 10, [1, 1, 1]), solid(1000, 10, [2, 2, 2])], { maxWidth: 1024 });
    assert.ok(factor >= 2);
    assert.ok(image.width <= 1024);
  });

  it('reads the size from the header without inflating the image', () => {
    assert.deepStrictEqual(readPngSize(encodePng(solid(13, 7, [1, 2, 3]))), { width: 13, height: 7 });
    assert.strictEqual(readPngSize(Buffer.from('not a png at all, definitely not')), null);
  });

  it('decodes and encodes off-thread to the same bytes as the synchronous path', async () => {
    const img = solid(9, 4, [40, 50, 60]);
    img.data[5] = 255;
    const asyncPng = await encodePngAsync(img);
    assert.ok(asyncPng.equals(encodePng(img)));
    const back = await decodePngAsync(asyncPng);
    assert.ok(back);
    assert.ok(back.data.equals(img.data));
    assert.strictEqual(await decodePngAsync(Buffer.from('not a png at all, definitely not')), null);
  });

  it('builds the same sheet from PNG bytes as from decoded images', async () => {
    const imgs = [solid(1200, 30, [255, 255, 255]), solid(900, 50, [0, 0, 0]), solid(1100, 20, [10, 120, 200])];
    const expected = composeContactSheet(imgs, { maxWidth: 1024 });
    const sheet = await composeContactSheetFromPngs(imgs.map((i) => encodePng(i)), { maxWidth: 1024 });
    assert.ok(sheet);
    assert.strictEqual(sheet.factor, expected.factor);
    const decoded = decodePng(sheet.png)!;
    assert.strictEqual(decoded.width, expected.image.width);
    assert.strictEqual(decoded.height, expected.image.height);
    assert.ok(decoded.data.equals(expected.image.data));
    assert.strictEqual(await composeContactSheetFromPngs([encodePng(imgs[0]!), Buffer.from('garbage bytes that are no png')]), null);
  });

  it('stacks full-page slices top to bottom in order', async () => {
    const top = solid(6, 4, [255, 0, 0]);
    const bottom = solid(6, 3, [0, 0, 255]);
    const stacked = await stackPngsVertically([encodePng(top), encodePng(bottom)]);
    assert.ok(stacked);
    const img = decodePng(stacked)!;
    assert.strictEqual(img.width, 6);
    assert.strictEqual(img.height, 7);
    assert.deepStrictEqual(px(img, 5, 3), [255, 0, 0, 255]);
    assert.deepStrictEqual(px(img, 0, 4), [0, 0, 255, 255]);
    assert.strictEqual(await stackPngsVertically([encodePng(top), encodePng(solid(5, 3, [0, 0, 0]))]), null, 'widths must agree');
    assert.strictEqual(await stackPngsVertically([encodePng(top), Buffer.from('not a png')]), null);
    assert.strictEqual(await stackPngsVertically([]), null);
  });
});

const cleanMetrics = (over: Partial<SectionMetrics> = {}): SectionMetrics => ({
  found: true, rect: { x: 0, y: 100, width: 1200, height: 400 }, docOverflowX: false, spill: [], offViewport: [], clippedText: [], truncatedText: 0,
  overlappingText: [], fontSizes: [14, 16, 24], leftEdges: 2, gapCount: 4, gapsOnGrid: 4, ...over,
});

describe('candidate scoring', () => {
  it('disqualifies breaks and penalises quality gaps', () => {
    const broken = scoreCandidateWidth(375, cleanMetrics({ docOverflowX: true, clippedText: ['h3.title "Áo"'] }), { contrastLow: 0, tapTiny: 0 });
    assert.strictEqual(broken.breaks.length, 2);
    const clean = scoreCandidateWidth(1440, cleanMetrics(), { contrastLow: 0, tapTiny: 0 });
    // A page that masks its overflow (body overflow-x: hidden) reports no document overflow while
    // a widened section's text runs off screen: that is still a break.
    const masked = scoreCandidateWidth(1440, cleanMetrics({ offViewport: ['p.copyright 0..2400 vs viewport 0..1440'] }), { contrastLow: 0, tapTiny: 0 });
    assert.strictEqual(masked.breaks.length, 1);
    assert.match(masked.breaks[0]!, /past the viewport edge/);
    assert.deepStrictEqual(clean.breaks, []);
    assert.strictEqual(clean.score, 100);
    const sloppy = scoreCandidateWidth(1440, cleanMetrics({ fontSizes: [11, 12, 13, 14, 15, 16, 18, 24], leftEdges: 7, gapsOnGrid: 2 }), { contrastLow: 1, tapTiny: 0 });
    // 5 (contrast) + 6 (3 extra sizes) + 6 (3 extra edges) + 7.5 (half the gaps off grid)
    assert.strictEqual(sloppy.score, 75.5);
  });

  it('validates input before any page work', () => {
    assert.throws(() => normalizeCandidateOptions({ scopeSelector: '', candidates: [{ id: 'a', css: 'x{}' }] }), /scopeSelector/);
    assert.throws(() => normalizeCandidateOptions({ scopeSelector: '.s', candidates: [] }), /1-5/);
    assert.throws(() => normalizeCandidateOptions({ scopeSelector: '.s', candidates: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, css: 'x{}' })) }), /1-5/);
    assert.throws(() => normalizeCandidateOptions({ scopeSelector: '.s', candidates: [{ id: 'baseline', css: 'x{}' }] }), /baseline/);
    assert.throws(() => normalizeCandidateOptions({ scopeSelector: '.s', candidates: [{ id: 'a', css: 'x{}' }, { id: 'a', css: 'y{}' }] }), /unique/);
    assert.throws(() => normalizeCandidateOptions({ scopeSelector: '.s', candidates: [{ id: 'a', css: 'x{}' }], breakpoints: [320, 768, 1024, 1440] }), /at most 3/);
    const ok = normalizeCandidateOptions({ scopeSelector: '.s', candidates: [{ id: 'a', css: 'x{}' }] });
    assert.deepStrictEqual(ok.breakpoints, [375, 1440]);
    assert.strictEqual(ok.sets[0]!.isBaseline, true);
  });
});

describe('candidate orchestration', () => {
  function deps(metricsFor: (css: string | null, width: number) => SectionMetrics | null, opts: { throwOnCapture?: boolean } = {}) {
    const log: string[] = [];
    let currentCss: string | null = null;
    let width = 0;
    let restored = false;
    const d: LayoutCandidatesDeps = {
      evalJs: async (script) => {
        if (script.includes('__antifan_candidate_override')) {
          const m = script.match(/const css = (null|"(?:[^"\\]|\\.)*");/);
          currentCss = m && m[1] !== 'null' ? JSON.parse(m[1]!) : null;
          log.push(`css:${currentCss === null ? 'clear' : currentCss}`);
          return { applied: currentCss !== null };
        }
        if (script.includes('gapsOnGrid')) return metricsFor(currentCss, width);
        return { measured: true, viewport: { width, height: 800 }, mobile: width <= 767, findings: [], stats: { textElementsChecked: 1, contrastIndeterminate: 0, controlsChecked: 0, floatingWidgets: 0, scrollPositions: 1, durationMs: 1, truncated: false, truncatedReasons: [] } };
      },
      setViewportWidth: async (w) => { width = w; log.push(`vp:${w}`); },
      captureClip: async () => {
        if (opts.throwOnCapture) throw new Error('capture exploded');
        return encodePng(solid(4, 3, [currentCss ? 200 : 100, 0, 0]));
      },
      stagePng: async (_png, label) => ({ id: `art-${label}` }),
      composeSheet: (pngs) => {
        const imgs = pngs.map((p) => decodePng(p)!);
        const { image, factor } = composeContactSheet(imgs);
        return { png: encodePng(image), downscale: factor };
      },
      restoreViewport: async () => { restored = true; log.push('restore'); },
      wait: async () => undefined,
    };
    return { d, log, wasRestored: () => restored, cssNow: () => currentCss };
  }

  it('ranks non-breaking candidates, disqualifies breaking ones and builds one sheet per width', async () => {
    const h = deps((css) => cleanMetrics(css && css.includes('BREAK') ? { docOverflowX: true } : css && css.includes('SLOPPY') ? { leftEdges: 9 } : {}));
    const res = await runLayoutCandidates(h.d, {
      scopeSelector: '.hero',
      candidates: [
        { id: 'tight', css: '.hero{gap:16px}' },
        { id: 'broken', css: '.hero{width:2000px} /* BREAK */' },
        { id: 'sloppy', css: '.hero{} /* SLOPPY */' },
      ],
    });
    assert.strictEqual(res.measured, true);
    const broken = res.candidates.find((c) => c.id === 'broken')!;
    assert.strictEqual(broken.disqualified, true);
    assert.ok(!res.ranking.includes('broken'));
    assert.strictEqual(res.ranking[res.ranking.length - 1], 'sloppy');
    assert.strictEqual(res.contactSheets.length, 2);
    assert.deepStrictEqual(res.contactSheets[0]!.columns, ['baseline', 'tight', 'broken', 'sloppy']);
    assert.ok(h.log.indexOf('vp:375') < h.log.indexOf('vp:1440'), 'breakpoints outer, candidates inner');
    assert.strictEqual(h.cssNow(), null, 'candidate css removed at the end');
    assert.ok(h.wasRestored());
  });

  it('charges candidates only for breaks beyond the ones the current design already has', async () => {
    const h = deps((css) => cleanMetrics({
      // The live section already spills one element; a candidate that keeps it is not worse.
      spill: css && css.includes('WIDER') ? ['a', 'b'] : ['footer-logo 0..420 vs 16..359'],
    }));
    const res = await runLayoutCandidates(h.d, {
      scopeSelector: 'footer',
      candidates: [{ id: 'same', css: 'footer{padding:8px}' }, { id: 'wider', css: 'footer{} /* WIDER */' }],
      breakpoints: [375],
    });
    const by = Object.fromEntries(res.candidates.map((c) => [c.id, c]));
    assert.strictEqual(by['baseline']!.disqualified, false, 'the reference is never disqualified by its own defects');
    assert.ok(by['baseline']!.preExistingBreaks!.length > 0);
    assert.strictEqual(by['same']!.disqualified, false);
    assert.strictEqual(by['wider']!.disqualified, true);
    assert.ok(by['wider']!.disqualifyReasons[0]!.includes('2 vs 1'));
  });

  it('clears the candidate stylesheet and restores the viewport when a capture throws', async () => {
    const h = deps(() => cleanMetrics(), { throwOnCapture: true });
    const res = await runLayoutCandidates(h.d, { scopeSelector: '.hero', candidates: [{ id: 'a', css: '.hero{color:red}' }], breakpoints: [1440] });
    assert.ok(res.candidates.every((c) => c.widths.every((w) => w.error === 'capture exploded')));
    assert.strictEqual(h.cssNow(), null);
    assert.ok(h.wasRestored());
  });

  it('ends the run on cancel between candidates instead of recording it as a candidate error', async () => {
    const h = deps(() => cleanMetrics());
    let checks = 0;
    h.d.throwIfCancelled = () => {
      checks++;
      // width check, baseline, first candidate: cancel lands before the second candidate.
      if (checks === 4) throw Object.assign(new Error('compare_candidates was cancelled'), { code: 'ABORTED' });
    };
    await assert.rejects(
      runLayoutCandidates(h.d, { scopeSelector: '.hero', candidates: [{ id: 'a', css: '.hero{color:red}' }, { id: 'b', css: '.hero{color:blue}' }], breakpoints: [1440] }),
      /cancelled/
    );
    assert.ok(!h.log.includes('css:.hero{color:blue}'), 'the candidate after the cancel never ran');
    assert.strictEqual(h.cssNow(), null, 'candidate css removed');
    assert.ok(h.wasRestored(), 'viewport restored on cancel');
  });

  it('reports a viewport the host could not restore', async () => {
    const h = deps(() => cleanMetrics());
    h.d.restoreViewport = async () => false;
    const res = await runLayoutCandidates(h.d, { scopeSelector: '.hero', candidates: [{ id: 'a', css: '.hero{}' }], breakpoints: [1440] });
    assert.strictEqual(res.viewportRestored, false);
  });

  it('reports an unmeasured run when the section never exists', async () => {
    const h = deps(() => ({ ...cleanMetrics(), found: false, rect: null }));
    const res = await runLayoutCandidates(h.d, { scopeSelector: '.missing', candidates: [{ id: 'a', css: 'x{}' }], breakpoints: [1440] });
    assert.strictEqual(res.measured, false);
    assert.ok(res.error?.startsWith('SCOPE_NOT_FOUND'));
    assert.deepStrictEqual(res.ranking, []);
  });
});

describe('compare_candidates on the port', () => {
  function target(): BrowserTarget {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    return { tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1, runtimeId: lease.runtimeId, projectId, workspaceId };
  }

  function candidateHost(record: Record<string, unknown> | null) {
    const calls: string[] = [];
    let vp = { w: 1280, h: 800 };
    let css: string | null = null;
    const host = {
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'data:image/png;base64,',
      getTabList: () => (record ? [record] : [{ id: 'tab-1-other' }]),
      hasTab: (id: string) => id === 'tab-1',
      setViewportSize: async (o: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number }) => {
        vp = { w: o.width, h: o.height };
        calls.push(`viewport ${o.width}x${o.height} mobile=${o.mobile} dpr=${o.deviceScaleFactor}`);
        return { success: true };
      },
      setDevicePreset: (_tab: string, presetId: string, opts?: { reload?: boolean }) => { calls.push(`preset ${presetId} reload=${opts?.reload}`); return true; },
      setZoom: (_tab: string, zoom: number) => { calls.push(`zoom ${zoom}`); return true; },
      settleTabEmulation: async () => { calls.push('settle'); },
      readRenderSurface: async () => ({ vw: vp.w, vh: vp.h, readyState: 'complete', hidden: false }),
      captureVerificationScreenshot: async () => ({ data: encodePng(solid(6, 4, [css ? 200 : 100, 0, 0])).toString('base64') }),
      evalJs: async (script: string) => {
        if (script.includes('__antifan_candidate_override')) {
          const m = script.match(/const css = (null|"(?:[^"\\]|\\.)*");/);
          css = m && m[1] !== 'null' ? JSON.parse(m[1]!) : null;
          return { applied: css !== null };
        }
        if (script.includes('gapsOnGrid')) return cleanMetrics();
        return null;
      },
    };
    return { host: host as unknown as BrowserHostPort, calls, cssNow: () => css };
  }

  const run = { runId: 'run-1', attemptId: 'attempt-1' };
  const params = { scopeSelector: '.hero', candidates: [{ id: 'a', css: '.hero{gap:8px}' }], breakpoints: [375, 1440] };

  it('puts a named preset back as that preset, without a reload, at its preview zoom', async () => {
    const h = candidateHost({ id: 'tab-1', devicePresetId: 'iphone-15', customViewport: { width: 393, height: 852, mobile: true, deviceScaleFactor: 3 }, zoomFactor: 0.75 });
    const res = await new BrowserControlPort(h.host).compareCandidates(target(), params, run);
    assert.strictEqual(res.viewportRestored, true);
    assert.strictEqual(res.contactSheets.length, 2);
    assert.strictEqual(h.cssNow(), null);
    const tail = h.calls.slice(-3);
    assert.deepStrictEqual(tail, ['preset iphone-15 reload=false', 'zoom 0.75', 'settle'], 'the preset is settled before the run reports it restored');
  });

  it('puts a custom size back with its device scale and zoom', async () => {
    const h = candidateHost({ id: 'tab-1', devicePresetId: 'custom-820x1180', customViewport: { width: 820, height: 1180, mobile: false, deviceScaleFactor: 2 }, zoomFactor: 1.25 });
    const res = await new BrowserControlPort(h.host).compareCandidates(target(), params, run);
    assert.strictEqual(res.viewportRestored, true);
    assert.deepStrictEqual(h.calls.slice(-2), ['zoom 1.25', 'viewport 820x1180 mobile=false dpr=2']);
  });

  it('refuses to start when the tab viewport cannot be read back', async () => {
    const h = candidateHost(null);
    await assert.rejects(new BrowserControlPort(h.host).compareCandidates(target(), params, run), (err: unknown) => (err as { code?: string }).code === 'TARGET_STALE');
    assert.deepStrictEqual(h.calls, [], 'no viewport was changed');
  });

  it('refuses malformed input before the page is touched', async () => {
    const h = candidateHost({ id: 'tab-1', devicePresetId: 'responsive', zoomFactor: 1 });
    await assert.rejects(
      new BrowserControlPort(h.host).compareCandidates(target(), { scopeSelector: '.hero', candidates: [] }, run),
      (err: unknown) => (err as { code?: string }).code === 'INVALID_ARGUMENT'
    );
    assert.deepStrictEqual(h.calls, []);
  });
});
