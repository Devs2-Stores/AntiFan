/**
 * AntiFan Browser Desktop — full-page tiling.
 *
 * Chromium rasterizes at most CAPTURE_MAX_DIMENSION px per screenshot, and a tall compositor
 * snapshot comes back with its lower part blank well before that. A document taller than one
 * raster is therefore captured as vertical tiles and composed here into one image. Composition
 * is pure Node (PNG decode/encode over zlib); the optional JPEG step needs an encoder, which the
 * main process supplies through Electron's nativeImage and which is injectable for tests.
 */
import { decodePngAsync, encodePngAsync, type RgbaImage } from './png-contact-sheet';

/** Device-pixel ceiling of one composed full-page image (RGBA in memory: 4 bytes per pixel). */
export const FULL_PAGE_MAX_STITCHED_DEVICE_PIXELS = 150_000_000;

/** Quality of the JPEG re-encode used when a PNG exceeds the artifact ceiling. */
export const FULL_PAGE_FALLBACK_JPEG_QUALITY = 85;

export interface TilePlanEntry {
  index: number;
  /** Document-space CSS offset of the tile's top edge. */
  offsetCssY: number;
  cssHeight: number;
}

/**
 * Split a document of `totalCssHeight` CSS px into consecutive tiles of at most `maxTileCssHeight`.
 * Tiles never overlap and their heights sum to exactly the total, so the composed image has the
 * measured document height.
 */
export function planTiles(totalCssHeight: number, maxTileCssHeight: number): TilePlanEntry[] {
  if (!Number.isFinite(totalCssHeight) || totalCssHeight < 1) return [];
  if (!Number.isFinite(maxTileCssHeight) || maxTileCssHeight < 1) return [];
  const total = Math.ceil(totalCssHeight);
  const tile = Math.floor(maxTileCssHeight);
  const plan: TilePlanEntry[] = [];
  for (let offset = 0; offset < total; offset += tile) {
    plan.push({ index: plan.length, offsetCssY: offset, cssHeight: Math.min(tile, total - offset) });
  }
  return plan;
}

/** Tallest document (CSS px) whose composed image stays inside the stitched-pixel budget. */
export function fullPageMaxCssHeight(cssWidth: number, rasterScale: number): number {
  if (!Number.isFinite(cssWidth) || cssWidth < 1 || !Number.isFinite(rasterScale) || rasterScale <= 0) return 0;
  return Math.floor(FULL_PAGE_MAX_STITCHED_DEVICE_PIXELS / (cssWidth * rasterScale * rasterScale));
}

/** Scroll-walk limits derived from the measured document, passed to the pre-capture walk. */
export interface PrewarmWalkOptions {
  maxDocumentHeight: number;
  maxSteps: number;
}

/**
 * Walk settings that carry the pre-capture scroll through the whole document: the default walk
 * stops at 16384 CSS px or 20 steps, which would leave the lower tiles unmaterialized.
 */
export function prewarmOptionsForDocument(
  documentCssHeight: number,
  viewportCssHeight: number,
  maxDocumentCssHeight: number
): PrewarmWalkOptions {
  const stepPx = Math.max(200, viewportCssHeight * 0.85);
  const steps = Math.ceil(documentCssHeight / stepPx) + 6;
  return {
    maxDocumentHeight: Math.max(16_384, Math.floor(maxDocumentCssHeight)),
    maxSteps: Math.min(160, Math.max(20, steps)),
  };
}

/** JPEG encoder over straight RGBA; null when none is available or encoding failed. */
export type RgbaJpegEncoder = (image: RgbaImage, quality: number) => Buffer | null;

function swapRedBlue(data: Buffer): void {
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i]!;
    data[i] = data[i + 2]!;
    data[i + 2] = r;
  }
}

/**
 * Electron nativeImage JPEG encoder. nativeImage bitmaps are BGRA, so the red/blue channels are
 * swapped in place for the call and restored before returning (no second full-size buffer).
 */
export const nativeImageJpegEncoder: RgbaJpegEncoder = (image, quality) => {
  try {
    const electron = require('electron') as { nativeImage?: { createFromBitmap?: (b: Buffer, o: { width: number; height: number }) => { isEmpty: () => boolean; toJPEG: (q: number) => Buffer } } };
    const create = electron?.nativeImage?.createFromBitmap;
    if (typeof create !== 'function') return null;
    swapRedBlue(image.data);
    try {
      const img = create(image.data, { width: image.width, height: image.height });
      if (!img || img.isEmpty()) return null;
      const out = img.toJPEG(Math.max(1, Math.min(100, Math.round(quality))));
      return out && out.length > 0 ? out : null;
    } finally {
      swapRedBlue(image.data);
    }
  } catch {
    return null;
  }
};

/**
 * Decode every tile and place it into one preallocated RGBA buffer (peak memory: the result plus
 * one tile). Null when a tile is not a supported PNG or the widths differ.
 */
export async function stitchPngTiles(tiles: Buffer[]): Promise<RgbaImage | null> {
  if (!tiles.length) return null;
  const first = await decodePngAsync(tiles[0]!);
  if (!first) return null;
  if (tiles.length === 1) return first;
  const decoded: RgbaImage[] = [first];
  let height = first.height;
  // Heights are needed up front to size the buffer; decoding twice would double the CPU, so the
  // decoded tiles are kept and released as they are copied.
  for (let i = 1; i < tiles.length; i++) {
    const img = await decodePngAsync(tiles[i]!);
    if (!img || img.width !== first.width) return null;
    decoded.push(img);
    height += img.height;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (first.width * height > FULL_PAGE_MAX_STITCHED_DEVICE_PIXELS) return null;
  const data = Buffer.allocUnsafe(first.width * height * 4);
  let row = 0;
  for (let i = 0; i < decoded.length; i++) {
    const img = decoded[i]!;
    img.data.copy(data, row * first.width * 4);
    row += img.height;
    decoded[i] = undefined as unknown as RgbaImage;
  }
  return { width: first.width, height, data };
}

export interface FinalizedFullPage {
  data: Buffer;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** Why the delivered format differs from the requested one; absent when it does not. */
  fallbackReason?: string;
  tileCount: number;
}

export interface FinalizeFullPageOptions {
  format: 'png' | 'jpeg';
  quality?: number;
  /** Per-artifact byte ceiling; a PNG above it is re-encoded as JPEG. */
  maxBytes?: number;
  encodeJpeg?: RgbaJpegEncoder;
}

/**
 * Compose PNG tiles into the delivered full-page image: PNG, or JPEG when requested or when the
 * PNG would exceed the artifact ceiling (then `fallbackReason` names the cause). Returns null when
 * the tiles cannot be composed.
 */
export async function finalizeFullPageTiles(tiles: Buffer[], options: FinalizeFullPageOptions): Promise<FinalizedFullPage | null> {
  const encodeJpeg = options.encodeJpeg ?? nativeImageJpegEncoder;
  const quality = options.quality ?? FULL_PAGE_FALLBACK_JPEG_QUALITY;
  const image = await stitchPngTiles(tiles);
  if (!image) return null;
  const base = { width: image.width, height: image.height, tileCount: tiles.length };

  if (options.format === 'jpeg') {
    const jpeg = encodeJpeg(image, quality);
    if (jpeg) return { ...base, data: jpeg, format: 'jpeg' };
    const png = await encodePngAsync(image);
    return { ...base, data: png, format: 'png', fallbackReason: 'jpeg-encoder-unavailable: delivered PNG' };
  }

  const png = tiles.length === 1 ? tiles[0]! : await encodePngAsync(image);
  if (options.maxBytes === undefined || png.length <= options.maxBytes) return { ...base, data: png, format: 'png' };
  const jpeg = encodeJpeg(image, FULL_PAGE_FALLBACK_JPEG_QUALITY);
  const exceeded = `PNG of ${png.length} bytes exceeds the ${options.maxBytes} byte artifact ceiling`;
  if (jpeg) return { ...base, data: jpeg, format: 'jpeg', fallbackReason: `${exceeded}: re-encoded as JPEG ${FULL_PAGE_FALLBACK_JPEG_QUALITY}` };
  return { ...base, data: png, format: 'png', fallbackReason: `${exceeded}: JPEG encoder unavailable, delivered PNG` };
}
