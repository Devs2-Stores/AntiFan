import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import {
  buildImageDecodeScript,
  buildPreCaptureSampleExpr,
  evaluatePreCaptureQuiescence,
  type EvalHost,
} from '../../src/main/verification/capture-settle';
import { buildReferenceMaterializationScript } from '../../src/main/verification/visual-capture';

/**
 * Minimal img stand-in that mirrors Chromium reflection: assigning `src`/`srcset`
 * updates the attribute reading too, and `currentSrc` only gains a value once the
 * image actually resolves (here: when `decode()` is invoked).
 */
interface FakeImgOpts {
  attrs?: Record<string, string>;
  complete?: boolean;
  naturalWidth?: number;
  naturalHeight?: number;
  rect?: { x: number; y: number; width: number; height: number; top: number; left: number; bottom: number; right: number };
  hidden?: boolean;
  loading?: string;
  picture?: FakePicture;
}

interface FakePicture {
  querySelector: (sel: string) => unknown;
}

class FakeImg {
  public attrs: Record<string, string>;
  public complete: boolean;
  public naturalWidth: number;
  public naturalHeight: number;
  public loading: string | undefined;
  public offsetParent: object | null;
  public offsetWidth: number;
  public offsetHeight: number;
  private rect: NonNullable<FakeImgOpts['rect']>;
  private picture: FakePicture | undefined;

  constructor(o: FakeImgOpts = {}) {
    this.attrs = o.attrs ?? {};
    this.complete = o.complete ?? true;
    this.naturalWidth = o.naturalWidth ?? 0;
    this.naturalHeight = o.naturalHeight ?? 0;
    this.loading = o.loading;
    const r = o.rect ?? { x: 10, y: 10, width: 100, height: 100, top: 10, left: 10, bottom: 110, right: 110 };
    this.rect = r;
    const footprint = !o.hidden && r.width > 0 && r.height > 0;
    this.offsetParent = footprint ? {} : null;
    this.offsetWidth = footprint ? r.width : 0;
    this.offsetHeight = footprint ? r.height : 0;
    this.picture = o.picture;
  }

  get src(): string {
    return this.attrs['src'] ?? '';
  }
  set src(v: string) {
    this.attrs['src'] = v;
  }
  get srcset(): string {
    return this.attrs['srcset'] ?? '';
  }
  set srcset(v: string) {
    this.attrs['srcset'] = v;
  }
  get currentSrc(): string {
    return this.complete && (this.attrs['src'] || this.attrs['srcset']) ? (this.attrs['src'] ?? '') : '';
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  getBoundingClientRect(): FakeImgOpts['rect'] {
    return this.rect;
  }
  closest(sel: string): FakePicture | null {
    return sel === 'picture' && this.picture ? this.picture : null;
  }
  decode(): Promise<void> {
    this.complete = true;
    return Promise.resolve();
  }
}

/** Rendered, srcless, lazy-source-bearing image (the Pancake/levents.asia shape). */
function lazyImg(over: FakeImgOpts = {}): FakeImg {
  return new FakeImg({ attrs: { 'data-src': 'https://cdn.ex.com/lazy.png' }, ...over });
}

/** Rendered, fully-loaded image. */
function loadedImg(src = 'https://ex.com/v.png'): FakeImg {
  return new FakeImg({
    attrs: { src },
    complete: true,
    naturalWidth: 100,
    naturalHeight: 100,
  });
}

function runInDom<T>(scriptText: string, sandbox: Record<string, unknown>): T {
  const ctx = vm.createContext({
    Promise,
    Array,
    Math,
    setTimeout,
    clearTimeout,
    ...sandbox,
  });
  return vm.runInContext(scriptText, ctx) as T;
}

interface SampleResult {
  readyState: string;
  imageCount: number;
  pendingImages: number;
  srclessImages: number;
  brokenImages: string[];
  imageParts: string[];
  docHeight: number;
  scrollWidth: number;
}

function sampleSandbox(images: FakeImg[]): Record<string, unknown> {
  return {
    window: { innerWidth: 1000, innerHeight: 800, scrollX: 0, scrollY: 0 },
    document: {
      readyState: 'complete',
      fonts: { status: 'loaded' },
      documentElement: { scrollHeight: 3000, scrollWidth: 1000 },
      body: { scrollHeight: 3000 },
      images,
    },
  };
}

describe('pre-capture sample: srcless lazy images', () => {
  it('counts rendered srcless data-src images separately from pending and broken', () => {
    const sample = runInDom<SampleResult>(
      buildPreCaptureSampleExpr({ fullPage: false }),
      sampleSandbox([
        lazyImg(),
        lazyImg(),
        loadedImg(),
        // Still loading with a real src: pending, not srcless.
        new FakeImg({ attrs: { src: 'https://ex.com/loading.png' }, complete: false }),
        // Real broken image: broken, not srcless.
        new FakeImg({ attrs: { src: 'https://ex.com/404.png' }, complete: true }),
      ]),
    );

    assert.strictEqual(sample.srclessImages, 2);
    assert.strictEqual(sample.pendingImages, 1);
    // vm-realm arrays fail prototype identity, so compare a main-realm copy.
    assert.deepStrictEqual([...sample.brokenImages], ['https://ex.com/404.png'], 'srcless images must not masquerade as broken');
    assert.strictEqual(sample.imageCount, 5);
  });

  it('ignores srcless candidates without a lazy-source signal or rendered footprint', () => {
    const sample = runInDom<SampleResult>(
      buildPreCaptureSampleExpr({ fullPage: false }),
      sampleSandbox([
        lazyImg(),
        // Empty image with no lazy-source signal: not lazy, just broken/empty.
        new FakeImg({ attrs: {} }),
        // display:none lazy image has no footprint.
        lazyImg({ hidden: true }),
        // 1x1 tracking beacon carrying data-src.
        lazyImg({ rect: { x: 0, y: 0, width: 1, height: 1, top: 0, left: 0, bottom: 1, right: 1 } }),
        // Offscreen (viewport mode) lazy image.
        lazyImg({ rect: { x: 0, y: 2500, width: 100, height: 100, top: 2500, left: 0, bottom: 2600, right: 100 } }),
      ]),
    );

    assert.strictEqual(sample.srclessImages, 1, 'only the rendered in-viewport lazy-source img counts');
  });

  it('counts an img backed only by an ancestor picture > source[data-srcset]', () => {
    const picture: FakePicture = {
      querySelector: (sel: string) => (sel === 'source[data-srcset]' ? {} : null),
    };
    const sample = runInDom<SampleResult>(
      buildPreCaptureSampleExpr({ fullPage: false }),
      sampleSandbox([new FakeImg({ attrs: {}, picture }), loadedImg()]),
    );

    assert.strictEqual(sample.srclessImages, 1);
  });
});

describe('evaluatePreCaptureQuiescence: srcless gate', () => {
  interface FakeSample {
    readyState: string;
    fontsSettled: boolean;
    fontsStatus: string;
    imageCount: number;
    pendingImages: number;
    srclessImages: number;
    brokenImages: string[];
    imageSetHash: string;
    imageStructureCount: number;
    imageParts: string[];
    imageContentParts: string[];
    imageStructureParts: string[];
    docHeight: number;
    scrollWidth: number;
  }

  const sampleOf = (over: Partial<FakeSample> = {}): FakeSample => ({
    readyState: 'complete',
    fontsSettled: true,
    fontsStatus: 'loaded',
    imageCount: 3,
    pendingImages: 0,
    srclessImages: 0,
    brokenImages: [],
    imageSetHash: 'aaaa0000',
    imageStructureCount: 1,
    imageParts: ['https://ex.com/hero.png|1200x600|0,0,1200,600|c'],
    imageContentParts: ['https://ex.com/hero.png|1200x600'],
    imageStructureParts: ['1200x600'],
    docHeight: 1000,
    scrollWidth: 1000,
    ...over,
  });

  const hostOf = (sample: FakeSample): EvalHost => ({
    evalJs: async () => sample,
  });

  it('refuses when rendered images carry lazy data-* sources and names them unmaterialized', async () => {
    const result = await evaluatePreCaptureQuiescence(hostOf(sampleOf({ srclessImages: 2 })), 'tab-1', 'desktop', { dwellMs: 0 });

    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.failingPredicate, 'imagesSettled');
    assert.strictEqual(result.predicates.imagesSettled, false);
    assert.match(result.reason ?? '', /unmaterialized image\(s\)/);
    assert.match(result.reason ?? '', /2/);
    assert.strictEqual(result.measurements.srclessImages, 2);
    assert.strictEqual(result.warnings.srclessImages, 2);
  });

  it('disables the leftover-pending tolerance while srcless images remain', async () => {
    const result = await evaluatePreCaptureQuiescence(
      hostOf(sampleOf({ srclessImages: 1, pendingImages: 1, imageCount: 5 })),
      'tab-1',
      'desktop',
      { dwellMs: 0 },
    );

    assert.strictEqual(result.ready, false, 'a leftover pending image is only tolerated on a fully materialized page');
    assert.strictEqual(result.failingPredicate, 'imagesSettled');
  });
  it('keeps the pending refusal message when no srcless images exist', async () => {
    const result = await evaluatePreCaptureQuiescence(
      hostOf(sampleOf({ pendingImages: 2, imageCount: 3 })),
      'tab-1',
      'desktop',
      { dwellMs: 0 },
    );

    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.failingPredicate, 'imagesSettled');
    assert.match(result.reason ?? '', /2 pending image\(s\) still loading/);
    assert.doesNotMatch(result.reason ?? '', /unmaterialized/);
  });

  it('admits a quiet page and reports a zero srcless count', async () => {
    const result = await evaluatePreCaptureQuiescence(hostOf(sampleOf()), 'tab-1', 'desktop', { dwellMs: 0 });

    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.predicates.imagesSettled, true);
    assert.strictEqual(result.measurements.srclessImages, 0);
    assert.strictEqual(result.warnings.srclessImages, 0);
  });
});

interface MaterializationResult {
  materialized: boolean;
  passes: number;
  imagesTotal: number;
  imagesStillPending: number;
  placeholdersBefore: number;
  placeholdersAfter: number;
  unmaterialized: number;
  dataSrcSwapped: number;
}

function materializationSandbox(images: FakeImg[]): Record<string, unknown> {
  return {
    window: { scrollY: 0, pageYOffset: 0, scrollTo: () => {} },
    location: { href: 'https://ex.com/' },
    document: {
      documentElement: { scrollHeight: 0 },
      body: { scrollHeight: 0 },
      images,
      querySelectorAll: () => [],
    },
  };
}

describe('reference materialization script', () => {
  it('emits no data-src swap unless opted in', () => {
    const script = buildReferenceMaterializationScript();
    // The unmaterialized counter always inspects data-* attrs; what must stay gated is
    // the mutation: only the opted-in build assigns data-src onto img.src.
    assert.ok(!script.includes('img.src = dataSrc'), 'default script must not assign lazy sources');
    assert.ok(script.includes('const dataSrcSwapped = 0'), 'receipt field must exist either way');
    assert.doesNotThrow(() => new vm.Script(script));
  });

  it('emits the swap block when materializeDataSrc is opted in', () => {
    const script = buildReferenceMaterializationScript({ materializeDataSrc: true });
    assert.ok(script.includes("img.getAttribute('data-src')"));
    assert.ok(script.includes("source[data-srcset]"));
    assert.doesNotThrow(() => new vm.Script(script));
  });

  it('reports unmaterialized srcless images and a false verdict without the swap', async () => {
    const script = buildReferenceMaterializationScript();
    const result = await runInDom<Promise<MaterializationResult>>(script, materializationSandbox([lazyImg(), loadedImg()]));

    assert.strictEqual(result.materialized, false, 'a walk that leaves blank boxes is not materialized');
    assert.strictEqual(result.unmaterialized, 1);
    assert.strictEqual(result.dataSrcSwapped, 0);
    assert.strictEqual(result.placeholdersAfter, 1);
    assert.strictEqual(result.imagesStillPending, 0);
  });

  it('swaps data-src onto src when opted in and then reports materialized', async () => {
    const img = lazyImg();
    const script = buildReferenceMaterializationScript({ materializeDataSrc: true });
    const result = await runInDom<Promise<MaterializationResult>>(script, materializationSandbox([img, loadedImg()]));

    assert.strictEqual(result.dataSrcSwapped, 1);
    assert.strictEqual(img.src, 'https://cdn.ex.com/lazy.png');
    assert.strictEqual(img.getAttribute('data-src'), 'https://cdn.ex.com/lazy.png', 'the data attribute stays in place');
    assert.strictEqual(result.unmaterialized, 0);
    assert.strictEqual(result.placeholdersAfter, 0);
    assert.strictEqual(result.materialized, true);
  });

  it('reports a clean page materialized with zero srcless work', async () => {
    const script = buildReferenceMaterializationScript({ materializeDataSrc: true });
    const result = await runInDom<Promise<MaterializationResult>>(script, materializationSandbox([loadedImg()]));

    assert.strictEqual(result.materialized, true);
    assert.strictEqual(result.unmaterialized, 0);
    assert.strictEqual(result.dataSrcSwapped, 0);
  });
});

describe('settle.images script: srcless images in capture region', () => {
  it('refuses settle when an in-viewport image never materialized its lazy source', async () => {
    const script = buildImageDecodeScript(200);
    const result = await runInDom<Promise<{ settled: boolean; brokenImages: string[]; srclessImages: number }>>(script, {
      window: { innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0 },
      document: { images: [lazyImg(), loadedImg()] },
    });

    assert.strictEqual(result.settled, false, 'a capture over unmaterialized images must not report settled');
    assert.strictEqual(result.srclessImages, 1);
    assert.deepStrictEqual([...result.brokenImages], []);
  });

  it('settles normally when every in-scope image has a real source', async () => {
    const script = buildImageDecodeScript(200);
    const result = await runInDom<Promise<{ settled: boolean; brokenImages: string[]; srclessImages: number }>>(script, {
      window: { innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0 },
      document: { images: [loadedImg()] },
    });

    assert.strictEqual(result.settled, true);
    assert.strictEqual(result.srclessImages, 0);
  });
});
