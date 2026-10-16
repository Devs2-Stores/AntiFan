import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  FULL_PAGE_MAX_STITCHED_DEVICE_PIXELS,
  finalizeFullPageTiles,
  fullPageMaxCssHeight,
  planTiles,
  prewarmOptionsForDocument,
  stitchPngTiles,
  type RgbaJpegEncoder,
} from '../../src/main/verification/full-page-tiles';
import { decodePng, encodePng, type RgbaImage } from '../../src/main/verification/png-contact-sheet';
import { CAPTURE_MAX_DIMENSION, CaptureError } from '../../src/main/verification/visual-capture';
import { createCaptureHarness } from './capture-host-harness';

function solid(width: number, height: number, rgb: [number, number, number]): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

describe('full-page tiling', () => {
  it('plans a 25292 px document as 2 tiles under the 16384 px raster ceiling with an exact total', () => {
    const plan = planTiles(25292, CAPTURE_MAX_DIMENSION);
    assert.deepEqual(plan, [
      { index: 0, offsetCssY: 0, cssHeight: 16384 },
      { index: 1, offsetCssY: 16384, cssHeight: 8908 },
    ]);
    assert.equal(plan.reduce((sum, tile) => sum + tile.cssHeight, 0), 25292);
  });

  it('plans one tile for a short page and nothing for an unmeasurable one', () => {
    assert.deepEqual(planTiles(900, 8192), [{ index: 0, offsetCssY: 0, cssHeight: 900 }]);
    assert.deepEqual(planTiles(0, 8192), []);
    assert.deepEqual(planTiles(Number.NaN, 8192), []);
    assert.deepEqual(planTiles(500, 0), []);
  });

  it('derives the tallest legal document from the stitched-pixel budget and carries the walk past the default ceiling', () => {
    assert.equal(fullPageMaxCssHeight(1440, 1), Math.floor(FULL_PAGE_MAX_STITCHED_DEVICE_PIXELS / 1440));
    assert.equal(fullPageMaxCssHeight(1440, 2), Math.floor(FULL_PAGE_MAX_STITCHED_DEVICE_PIXELS / (1440 * 4)));
    assert.equal(fullPageMaxCssHeight(0, 1), 0);
    const walk = prewarmOptionsForDocument(25292, 900, 100000);
    assert.equal(walk.maxDocumentHeight, 100000);
    assert.ok(walk.maxSteps >= Math.ceil(25292 / (900 * 0.85)), 'the walk must have enough steps to reach the bottom');
  });

  it('composes tiles into one image with the exact summed height and untouched pixels', async () => {
    const top = encodePng(solid(4, 3, [255, 0, 0]));
    const bottom = encodePng(solid(4, 2, [0, 0, 255]));
    const image = await stitchPngTiles([top, bottom]);
    assert.ok(image);
    assert.deepEqual({ width: image.width, height: image.height }, { width: 4, height: 5 });
    assert.deepEqual([...image.data.subarray(0, 4)], [255, 0, 0, 255]);
    assert.deepEqual([...image.data.subarray((4 * 4 + 1) * 4, (4 * 4 + 1) * 4 + 4)], [0, 0, 255, 255]);
    assert.equal(await stitchPngTiles([top, encodePng(solid(5, 2, [0, 0, 0]))]), null, 'widths must agree');
    assert.equal(await stitchPngTiles([top, Buffer.from('not a png')]), null);
  });

  it('delivers JPEG when requested and reports the PNG fallback when no encoder exists', async () => {
    const tiles = [encodePng(solid(4, 3, [10, 20, 30])), encodePng(solid(4, 2, [10, 20, 30]))];
    let seen: { width: number; height: number; quality: number } | undefined;
    const encoder: RgbaJpegEncoder = (image, quality) => {
      seen = { width: image.width, height: image.height, quality };
      return Buffer.from('jpeg-bytes');
    };
    const jpeg = await finalizeFullPageTiles(tiles, { format: 'jpeg', quality: 70, encodeJpeg: encoder });
    assert.ok(jpeg);
    assert.equal(jpeg.format, 'jpeg');
    assert.equal(jpeg.fallbackReason, undefined);
    assert.deepEqual(seen, { width: 4, height: 5, quality: 70 });

    const noEncoder = await finalizeFullPageTiles(tiles, { format: 'jpeg', encodeJpeg: () => null });
    assert.ok(noEncoder);
    assert.equal(noEncoder.format, 'png');
    assert.match(noEncoder.fallbackReason ?? '', /jpeg-encoder-unavailable/);
    assert.equal(decodePng(noEncoder.data)?.height, 5);
  });

  it('re-encodes an over-ceiling PNG as JPEG 85 and says why', async () => {
    const tiles = [encodePng(solid(64, 64, [1, 2, 3])), encodePng(solid(64, 64, [4, 5, 6]))];
    let quality = 0;
    const result = await finalizeFullPageTiles(tiles, {
      format: 'png',
      maxBytes: 32,
      encodeJpeg: (_image, q) => {
        quality = q;
        return Buffer.from('small-jpeg');
      },
    });
    assert.ok(result);
    assert.equal(result.format, 'jpeg');
    assert.equal(quality, 85);
    assert.match(result.fallbackReason ?? '', /exceeds the 32 byte artifact ceiling.*re-encoded as JPEG 85/);

    const within = await finalizeFullPageTiles(tiles, { format: 'png', maxBytes: 10_000_000, encodeJpeg: () => { throw new Error('must not encode'); } });
    assert.equal(within?.format, 'png');
    assert.equal(within?.fallbackReason, undefined);
  });
});

describe('captureVerificationScreenshot above the single-raster ceiling', () => {
  it('captures a 25292 px page as tiles and returns one image of the full height', async () => {
    const { devTools, calls } = createCaptureHarness({ surface: { dpr: 1, vw: 200, vh: 600 }, documentHeight: 25292 });

    const envelope = await devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { fullPage: true, skipQuiescence: true });

    const clips = calls
      .filter((c) => c.method === 'Page.captureScreenshot')
      .map((c) => c.params?.clip as { y: number; height: number });
    assert.deepEqual(clips.map((c) => [c.y, c.height]), [[0, 8192], [8192, 8192], [16384, 8192], [24576, 716]]);
    assert.deepEqual(envelope.rasterSize, { width: 200, height: 25292 });
    assert.deepEqual(envelope.cssCaptureSize, { width: 200, height: 25292 });
    assert.deepEqual(envelope.tiles, { count: 4, stitched: true });
    assert.equal(envelope.format, 'png');
    assert.equal(decodePng(Buffer.from(envelope.data, 'base64'))?.height, 25292);
  });

  it('delivers PNG with the reason recorded when a JPEG was requested and no encoder is available', async () => {
    const { devTools } = createCaptureHarness({ documentHeight: 20000 });

    const envelope = await devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { fullPage: true, format: 'jpeg', skipQuiescence: true });

    assert.equal(envelope.format, 'png');
    assert.match(envelope.fallbackReason ?? '', /jpeg-encoder-unavailable/);
    assert.equal(envelope.rasterSize.height, 20000);
  });

  it('records the ceiling fallback when a single-raster PNG exceeds the caller byte ceiling', async () => {
    const { devTools } = createCaptureHarness({ documentHeight: 2400 });

    const envelope = await devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { fullPage: true, maxBytes: 10, skipQuiescence: true });

    assert.match(envelope.fallbackReason ?? '', /exceeds the 10 byte artifact ceiling/);
    assert.equal(envelope.tiles, undefined);
  });

  it('still refuses a document whose composed image would exceed the pixel budget, before any raster', async () => {
    const { devTools, calls } = createCaptureHarness({ surface: { dpr: 1, vw: 1200, vh: 800 }, documentHeight: 200000 });

    await assert.rejects(
      () => devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { fullPage: true, skipQuiescence: true }),
      (err: unknown) => err instanceof CaptureError && err.code === 'FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY'
    );
    assert.equal(calls.some((c) => c.method === 'Page.captureScreenshot'), false);
  });
});
