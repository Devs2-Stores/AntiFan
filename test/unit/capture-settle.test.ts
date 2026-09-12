import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import {
  CaptureSettleGate,
  buildFontSettleScript,
  buildImageDecodeScript,
  buildDomQuietScript,
  createBrowserSettlePredicates,
  buildPreCaptureSampleExpr,
  PRE_CAPTURE_SAMPLE_EXPR,
  type VisualSettleReceipt,
  type CaptureSettlePredicates,
} from '../../src/main/verification/capture-settle';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

describe('CaptureSettleGate (pure predicate runner)', () => {
  it('evaluates all 4 predicates when they succeed promptly', async () => {
    const predicates: CaptureSettlePredicates = {
      networkIdle: async () => true,
      fontsReady: async () => true,
      imagesDecoded: async () => ({ settled: true, brokenImages: [] }),
      domQuiet: async () => true,
    };

    const receipt = await CaptureSettleGate.evaluate(predicates);
    assert.strictEqual(receipt.settleComplete, true);
    assert.strictEqual(receipt.gates.network, true);
    assert.strictEqual(receipt.gates.fonts, true);
    assert.strictEqual(receipt.gates.images, true);
    assert.strictEqual(receipt.gates.dom, true);
    assert.deepStrictEqual(receipt.brokenImages, []);
    assert.ok(receipt.timingsMs.total >= 0);
  });

  it('reports network failure when networkIdle times out or returns false', async () => {
    const predicates: CaptureSettlePredicates = {
      networkIdle: async () => false,
      fontsReady: async () => true,
      imagesDecoded: async () => ({ settled: true, brokenImages: [] }),
      domQuiet: async () => true,
    };

    const receipt = await CaptureSettleGate.evaluate(predicates);
    assert.strictEqual(receipt.settleComplete, false);
    assert.strictEqual(receipt.gates.network, false);
    assert.strictEqual(receipt.gates.fonts, true);
  });

  it('reports font failure when fontsReady returns false (V-16)', async () => {
    const predicates: CaptureSettlePredicates = {
      networkIdle: async () => true,
      fontsReady: async () => false,
      imagesDecoded: async () => ({ settled: true, brokenImages: [] }),
      domQuiet: async () => true,
    };

    const receipt = await CaptureSettleGate.evaluate(predicates);
    assert.strictEqual(receipt.settleComplete, false);
    assert.strictEqual(receipt.gates.fonts, false);
  });

  it('reports image decode failure when imagesDecoded returns settled:false (V-17)', async () => {
    const predicates: CaptureSettlePredicates = {
      networkIdle: async () => true,
      fontsReady: async () => true,
      imagesDecoded: async () => ({ settled: false, brokenImages: [] }),
      domQuiet: async () => true,
    };

    const receipt = await CaptureSettleGate.evaluate(predicates);
    assert.strictEqual(receipt.settleComplete, false);
    assert.strictEqual(receipt.gates.images, false);
  });

  it('assertResources throws RESOURCE_FAILURE when broken images are detected (V-18)', async () => {
    const predicates: CaptureSettlePredicates = {
      networkIdle: async () => true,
      fontsReady: async () => true,
      imagesDecoded: async () => ({ settled: true, brokenImages: ['https://example.com/missing.png'] }),
      domQuiet: async () => true,
    };

    const receipt = await CaptureSettleGate.evaluate(predicates);
    assert.strictEqual(receipt.settleComplete, false);
    assert.deepStrictEqual(receipt.brokenImages, ['https://example.com/missing.png']);

    assert.throws(
      () => CaptureSettleGate.assertResources(receipt),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual((err as CapabilityError).code, 'RESOURCE_FAILURE');
        assert.ok((err as CapabilityError).message.includes('missing.png'));
        return true;
      }
    );
  });

  it('reports DOM failure when domQuiet returns false', async () => {
    const predicates: CaptureSettlePredicates = {
      networkIdle: async () => true,
      fontsReady: async () => true,
      imagesDecoded: async () => ({ settled: true, brokenImages: [] }),
      domQuiet: async () => false,
    };

    const receipt = await CaptureSettleGate.evaluate(predicates);
    assert.strictEqual(receipt.settleComplete, false);
    assert.strictEqual(receipt.gates.dom, false);
  });

  it('enforces hard timeout ceiling even when a predicate never resolves', async () => {
    const predicates: CaptureSettlePredicates = {
      networkIdle: () => new Promise(() => {}), // never resolves
    };

    const t0 = Date.now();
    const receipt = await CaptureSettleGate.evaluate(predicates, {
      networkTimeoutMs: 50,
      totalTimeoutMs: 50,
    });
    const elapsed = Date.now() - t0;

    assert.strictEqual(receipt.settleComplete, false);
    assert.strictEqual(receipt.gates.network, false);
    assert.ok(elapsed < 500, `Expected elapsed (${elapsed}ms) to be bounded by total timeout`);
  });
});

describe('Script builders (in-page evaluation scripts)', () => {
  it('buildFontSettleScript generates valid bounded script', () => {
    const script = buildFontSettleScript(400);
    assert.ok(script.includes('document.fonts.ready'));
    assert.ok(script.includes('400'));
    // vm.Script throws SyntaxError on any malformed source, so this fails if the assembled script is invalid.
    assert.doesNotThrow(() => {
      new vm.Script(script);
    }, 'Font settle script must be syntactically valid JavaScript');
  });

  it('buildImageDecodeScript generates valid in-region decode script', () => {
    const script = buildImageDecodeScript(800, { x: 10, y: 20, width: 300, height: 400 });
    assert.ok(script.includes('img.decode'));
    assert.ok(script.includes('naturalWidth === 0'));
    assert.ok(script.includes('"x":10'));
    assert.ok(script.includes('800'));
    // vm.Script throws SyntaxError on any malformed source, so this fails if the assembled script is invalid.
    assert.doesNotThrow(() => {
      new vm.Script(script);
    }, 'Image decode script must be syntactically valid JavaScript');
  });

  it('buildDomQuietScript generates double-rAF and MutationObserver script with fallback timeout failing closed', () => {
    const script = buildDomQuietScript(150);
    assert.ok(script.includes('requestAnimationFrame'));
    assert.ok(script.includes('MutationObserver'));
    assert.ok(script.includes('finish(false)') || script.includes('resolve(false)'));
    // vm.Script throws SyntaxError on any malformed source, so this fails if the assembled script is invalid.
    assert.doesNotThrow(() => {
      new vm.Script(script);
    }, 'DOM quiet script must be syntactically valid JavaScript');
  });
});

describe('createBrowserSettlePredicates', () => {
  it('requires res.settled && !res.timedOut for network quiescence', async () => {
    const mockTracker = {
      awaitQuiescence: async () => ({ settled: true, durationMs: 50, timedOut: true }), // ceiling reached
    };
    const predicates = createBrowserSettlePredicates(
      { evalJs: async () => true },
      'tab-1',
      'desktop',
      { networkTracker: mockTracker }
    );

    const settled = await predicates.networkIdle!(100);
    assert.strictEqual(settled, false, 'Expected timedOut: true to fail the network gate');
  });

  it('passes network quiescence when settled:true and timedOut:false', async () => {
    const mockTracker = {
      awaitQuiescence: async () => ({ settled: true, durationMs: 20, timedOut: false }),
    };
    const predicates = createBrowserSettlePredicates(
      { evalJs: async () => true },
      'tab-1',
      'desktop',
      { networkTracker: mockTracker }
    );

    const settled = await predicates.networkIdle!(100);
    assert.strictEqual(settled, true);
  });

  it('fails closed when no network tracker is provided (fail-closed contract)', async () => {
    const predicates = createBrowserSettlePredicates(
      { evalJs: async () => true },
      'tab-1',
      'desktop'
    );
    const settled = await predicates.networkIdle!(100);
    assert.strictEqual(settled, false, 'Expected absent tracker to fail closed');
  });

  it('executes font settle script and captures font readiness (V-16)', async () => {
    let fontScriptExecuted = false;
    const mockEvalHost = {
      evalJs: async (script: string) => {
        fontScriptExecuted = true;
        assert.ok(script.includes('document.fonts.ready'));
        return true;
      },
    };
    const predicates = createBrowserSettlePredicates(mockEvalHost, 'tab-1');
    const fontReady = await predicates.fontsReady!(200);
    assert.strictEqual(fontReady, true);
    assert.strictEqual(fontScriptExecuted, true);
  });

  it('executes font settle script and reports font timeout (V-16)', async () => {
    const mockEvalHost = {
      evalJs: async () => false, // simulated font timeout
    };
    const predicates = createBrowserSettlePredicates(mockEvalHost, 'tab-1');
    const fontReady = await predicates.fontsReady!(200);
    assert.strictEqual(fontReady, false);
  });

  it('executes image decode script and captures decoded status (V-17)', async () => {
    let decodeScriptExecuted = false;
    const mockEvalHost = {
      evalJs: async (script: string) => {
        decodeScriptExecuted = true;
        assert.ok(script.includes('img.decode'));
        return { settled: true, brokenImages: [] };
      },
    };
    const predicates = createBrowserSettlePredicates(mockEvalHost, 'tab-1');
    const res = await predicates.imagesDecoded!(300);
    assert.strictEqual(res.settled, true);
    assert.deepStrictEqual(res.brokenImages, []);
    assert.strictEqual(decodeScriptExecuted, true);
  });

  it('detects broken image through adapter and raises RESOURCE_FAILURE (V-18)', async () => {
    const brokenUrl = 'https://cdn.example.com/missing-404.jpg';
    const mockEvalHost = {
      evalJs: async () => {
        return { settled: true, brokenImages: [brokenUrl] };
      },
    };
    const mockTracker = {
      awaitQuiescence: async () => ({ settled: true, durationMs: 10, timedOut: false }),
    };
    const predicates = createBrowserSettlePredicates(mockEvalHost, 'tab-1', 'desktop', {
      networkTracker: mockTracker,
    });

    const receipt = await CaptureSettleGate.evaluate(predicates);
    assert.strictEqual(receipt.settleComplete, false);
    assert.deepStrictEqual(receipt.brokenImages, [brokenUrl]);

    assert.throws(
      () => CaptureSettleGate.assertResources(receipt),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityError);
        assert.strictEqual((err as CapabilityError).code, 'RESOURCE_FAILURE');
        assert.ok((err as CapabilityError).message.includes(brokenUrl));
        return true;
      }
    );
  });

  it('executes DOM quiet script and captures double-rAF settlement', async () => {
    let domScriptExecuted = false;
    const mockEvalHost = {
      evalJs: async (script: string) => {
        domScriptExecuted = true;
        assert.ok(script.includes('requestAnimationFrame'));
        return true;
      },
    };
    const predicates = createBrowserSettlePredicates(mockEvalHost, 'tab-1');
    const quiet = await predicates.domQuiet!(150);
    assert.strictEqual(quiet, true);
    assert.strictEqual(domScriptExecuted, true);
  });
});

describe('Live script execution in simulated DOM sandbox (executable contract)', () => {
  function runScriptInDom(script: string, env: {
    document?: any;
    window?: any;
    requestAnimationFrame?: any;
    MutationObserver?: any;
    setInterval?: any;
    clearInterval?: any;
    Date?: Pick<DateConstructor, 'now'>;
  }) {
    const sandbox = {
      document: env.document || {},
      window: env.window || { innerWidth: 1200, innerHeight: 800 },
      requestAnimationFrame: 'requestAnimationFrame' in env ? env.requestAnimationFrame : ((cb: () => void) => setTimeout(cb, 5)),
      MutationObserver: env.MutationObserver,
      setTimeout,
      clearTimeout,
      setInterval: env.setInterval || setInterval,
      clearInterval: env.clearInterval || clearInterval,
      Date: env.Date ?? Date,
      Promise,
      Array,
      Math,
      JSON,
    };
    const fn = new Function('sandbox', `with(sandbox) { return ${script}; }`);
    return fn(sandbox);
  }

  it('runs buildFontSettleScript against resolving document.fonts.ready', async () => {
    const script = buildFontSettleScript(100);
    const res = await runScriptInDom(script, {
      document: { fonts: { ready: Promise.resolve() } },
    });
    assert.strictEqual(res, true);
  });

  it('runs buildFontSettleScript and times out when fonts do not resolve', async () => {
    const script = buildFontSettleScript(20);
    const hangingPromise = new Promise<void>(() => {});
    const res = await runScriptInDom(script, {
      document: { fonts: { ready: hangingPromise } },
    });
    assert.strictEqual(res, false);
  });

  it('runs buildImageDecodeScript: detects in-region broken image and excludes off-region image (V-17, V-18)', async () => {
    const script = buildImageDecodeScript(200, { x: 0, y: 0, width: 800, height: 600 });
    const inRegionBroken = {
      complete: true,
      naturalWidth: 0,
      naturalHeight: 0,
      src: 'https://example.com/broken.png',
      currentSrc: 'https://example.com/broken.png',
      getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 100, top: 10, left: 10, bottom: 110, right: 110 }),
      decode: async () => {},
    };
    const offRegionBroken = {
      complete: true,
      naturalWidth: 0,
      naturalHeight: 0,
      src: 'https://example.com/offscreen-broken.png',
      currentSrc: 'https://example.com/offscreen-broken.png',
      getBoundingClientRect: () => ({ x: 1000, y: 1000, width: 100, height: 100, top: 1000, left: 1000, bottom: 1100, right: 1100 }),
      decode: async () => {},
    };
    const inRegionValid = {
      complete: true,
      naturalWidth: 200,
      naturalHeight: 200,
      src: 'https://example.com/valid.png',
      currentSrc: 'https://example.com/valid.png',
      getBoundingClientRect: () => ({ x: 50, y: 50, width: 100, height: 100, top: 50, left: 50, bottom: 150, right: 150 }),
      decode: async () => {},
    };
    const res = await runScriptInDom(script, {
      document: { images: [inRegionBroken, offRegionBroken, inRegionValid] },
      window: { innerWidth: 1200, innerHeight: 800 },
    });
    assert.strictEqual(res.settled, true);
    assert.deepStrictEqual(res.brokenImages, ['https://example.com/broken.png']);
  });

  it('runs buildImageDecodeScript: times out when image decoding hangs (V-17)', async () => {
    const script = buildImageDecodeScript(30, { x: 0, y: 0, width: 800, height: 600 });
    const hangingImg = {
      complete: false,
      naturalWidth: 0,
      naturalHeight: 0,
      src: 'https://example.com/slow.png',
      currentSrc: 'https://example.com/slow.png',
      getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 100, top: 10, left: 10, bottom: 110, right: 110 }),
      decode: () => new Promise<void>(() => {}),
    };
    const res = await runScriptInDom(script, {
      document: { images: [hangingImg] },
      window: { innerWidth: 1200, innerHeight: 800 },
    });
    assert.strictEqual(res.settled, false);
  });

  it('runs buildImageDecodeScript: fails closed when image decode rejects (V-17)', async () => {
    const script = buildImageDecodeScript(100, { x: 0, y: 0, width: 800, height: 600 });
    const rejectingImg = {
      complete: false,
      naturalWidth: 0,
      naturalHeight: 0,
      src: 'https://example.com/error.png',
      currentSrc: 'https://example.com/error.png',
      getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 100, top: 10, left: 10, bottom: 110, right: 110 }),
      decode: () => Promise.reject(new Error('Image decode aborted')),
    };
    const res = await runScriptInDom(script, {
      document: { images: [rejectingImg] },
      window: { innerWidth: 1200, innerHeight: 800 },
    });
    assert.strictEqual(res.settled, false);
  });

  it('runs buildDomQuietScript: resolves true via double-rAF when quiet window passes', async () => {
    let rAfCount = 0;
    let simulatedNow = 10000;
    const script = buildDomQuietScript(200);
    const res = await runScriptInDom(script, {
      Date: {
        now: () => simulatedNow,
      },
      requestAnimationFrame: (cb: () => void) => {
        rAfCount++;
        simulatedNow += 30;
        queueMicrotask(cb);
      },
    });
    assert.strictEqual(res, true);
    assert.strictEqual(rAfCount, 2);
  });

  it('runs buildDomQuietScript: resolves true via MutationObserver quiet window when requestAnimationFrame is missing (background tab)', async () => {
    class MockMutationObserver {
      observed: any[] = [];
      constructor(public cb: (mutations: any[]) => void) {}
      observe(el: any, opts: any) { this.observed.push({ el, opts }); }
      disconnect() {}
    }
    const script = buildDomQuietScript(60);
    const res = await runScriptInDom(script, {
      requestAnimationFrame: undefined,
      MutationObserver: MockMutationObserver,
      document: { documentElement: {} },
    });
    assert.strictEqual(res, true);
  });

  it('runs buildDomQuietScript: fails closed when mutations continuously occur until ceiling timer', async () => {
    let observerCb: ((mutations: any[]) => void) | null = null;
    class MockMutationObserver {
      constructor(public cb: (mutations: any[]) => void) {
        observerCb = cb;
      }
      observe() {}
      disconnect() {}
    }
    const script = buildDomQuietScript(60);
    const res = await runScriptInDom(script, {
      requestAnimationFrame: undefined,
      MutationObserver: MockMutationObserver,
      document: { documentElement: {} },
      setInterval: (fn: () => void, ms: number) => {
        return setInterval(() => {
          if (observerCb) observerCb([{ type: 'childList' }]);
          fn();
        }, ms);
      },
    });
    assert.strictEqual(res, false);
  });

  it('runs buildDomQuietScript: fails closed when both requestAnimationFrame and MutationObserver are missing', async () => {
    const script = buildDomQuietScript(50);
    const res = await runScriptInDom(script, {
      requestAnimationFrame: undefined,
      MutationObserver: undefined,
    });
    assert.strictEqual(res, false);
  });

describe('buildPreCaptureSampleExpr (quiescence sample expressions)', () => {
  it('viewport mode ignores offscreen lazy images and display:none images', () => {
    const script = buildPreCaptureSampleExpr({ fullPage: false });
    const sample = runScriptInDom(script, {
      window: { innerWidth: 1000, innerHeight: 500, scrollY: 0 },
      document: {
        readyState: 'complete',
        fonts: { status: 'loaded' },
        documentElement: { scrollHeight: 3000, scrollWidth: 1000 },
        images: [
          // Visible in-viewport loaded image
          { complete: true, naturalWidth: 100, naturalHeight: 100, src: 'https://ex.com/v.png', offsetParent: {}, offsetWidth: 100, offsetHeight: 100, getBoundingClientRect: () => ({ x: 0, y: 100, width: 100, height: 100, top: 100, bottom: 200 }) },
          // Hidden display:none image (must be ignored)
          { complete: false, naturalWidth: 0, naturalHeight: 0, src: 'https://ex.com/hidden.png', offsetParent: null, offsetWidth: 0, offsetHeight: 0, getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0 }) },
          // Offscreen lazy image at y=2500 (must be ignored in viewport mode)
          { complete: false, naturalWidth: 0, naturalHeight: 0, loading: 'lazy', src: 'https://ex.com/offscreen-lazy.png', offsetParent: {}, offsetWidth: 100, offsetHeight: 100, getBoundingClientRect: () => ({ x: 0, y: 2500, width: 100, height: 100, top: 2500, bottom: 2600 }) },
        ],
      },
    });

    assert.strictEqual(sample.pendingImages, 0, 'Offscreen lazy and hidden images must not count as pending');
    assert.strictEqual(sample.imageParts.length, 1, 'Only visible in-viewport image must be in imageParts');
    assert.ok(sample.imageParts[0].includes('https://ex.com/v.png'));
  });

  it('full-page mode ignores display:none images but includes offscreen lazy images', () => {
    const script = buildPreCaptureSampleExpr({ fullPage: true });
    const sample = runScriptInDom(script, {
      window: { innerWidth: 1000, innerHeight: 500, scrollY: 0 },
      document: {
        readyState: 'complete',
        fonts: { status: 'loaded' },
        documentElement: { scrollHeight: 3000, scrollWidth: 1000 },
        images: [
          // Visible in-viewport loaded image
          { complete: true, naturalWidth: 100, naturalHeight: 100, src: 'https://ex.com/v.png', offsetParent: {}, offsetWidth: 100, offsetHeight: 100, getBoundingClientRect: () => ({ x: 0, y: 100, width: 100, height: 100, top: 100, bottom: 200 }) },
          // Hidden display:none image (must still be ignored in full-page)
          { complete: false, naturalWidth: 0, naturalHeight: 0, src: 'https://ex.com/hidden.png', offsetParent: null, offsetWidth: 0, offsetHeight: 0, getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0 }) },
          // Offscreen lazy image at y=2500 (must NOT be ignored in full-page mode)
          { complete: false, naturalWidth: 0, naturalHeight: 0, loading: 'lazy', src: 'https://ex.com/offscreen-lazy.png', offsetParent: {}, offsetWidth: 100, offsetHeight: 100, getBoundingClientRect: () => ({ x: 0, y: 2500, width: 100, height: 100, top: 2500, bottom: 2600 }) },
        ],
      },
    });

    assert.strictEqual(sample.pendingImages, 0, 'Offscreen lazy image must NOT count as pending in full-page mode to prevent capture deadlock');
    assert.strictEqual(sample.imageParts.length, 2, 'Visible and offscreen lazy image must be tracked in full-page identity hash');
  });
});
});
