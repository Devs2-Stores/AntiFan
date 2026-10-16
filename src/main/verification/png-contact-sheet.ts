/**
 * AntiFan Browser Desktop — PNG contact sheets for side-by-side comparison.
 *
 * Pure Node (zlib only): decode 8-bit RGB/RGBA non-interlaced PNGs (the format CDP captures
 * produce), box-downscale by an integer factor, lay images out left-to-right with a gutter on a
 * shared background, and encode the result as one PNG. Kept dependency-free and Electron-free
 * so it runs in unit tests and in any process.
 */
import * as zlib from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  /** Tightly packed RGBA, width * height * 4 bytes. */
  data: Buffer;
}

export interface ContactSheetOptions {
  /** Gap between columns in output pixels (default 24). */
  gutter?: number;
  /** Background RGB (default light grey). */
  background?: [number, number, number];
  /** Integer-downscale until the sheet is at most this wide (default 4096). */
  maxWidth?: number;
  /** ...and at most this tall (default 4096). */
  maxHeight?: number;
  /** Colour bar drawn above each column so columns stay identifiable (default 8px). */
  headerBarHeight?: number;
}

/** Column bar colours: baseline first (grey), then distinct hues for candidates. */
export const CONTACT_SHEET_COLUMN_COLORS: ReadonlyArray<[number, number, number]> = [
  [120, 120, 120],
  [220, 38, 38],
  [37, 99, 235],
  [22, 163, 74],
  [217, 119, 6],
  [147, 51, 234],
  [8, 145, 178],
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(type: string, data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < 4; i++) c = (CRC_TABLE[(c ^ type.charCodeAt(i)) & 0xff]! ^ (c >>> 8)) >>> 0;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface PngChunks {
  width: number;
  height: number;
  colorType: number;
  idat: Buffer;
}

/** Walk the chunk list of a supported PNG (8-bit RGB/RGBA, non-interlaced); null otherwise. */
function readPngChunks(buf: Buffer, headerOnly: boolean): PngChunks | null {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let sawIhdr = false;
  const idat: Buffer[] = [];
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    const start = offset + 8;
    const end = start + len;
    if (end + 4 > buf.length) return null;
    if (type === 'IHDR') {
      if (len !== 13) return null;
      width = buf.readUInt32BE(start);
      height = buf.readUInt32BE(start + 4);
      const bitDepth = buf[start + 8]!;
      colorType = buf[start + 9]!;
      const interlace = buf[start + 12]!;
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return null;
      sawIhdr = true;
      if (headerOnly) break;
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  if (!sawIhdr || width <= 0 || height <= 0) return null;
  if (!headerOnly && idat.length === 0) return null;
  return { width, height, colorType, idat: headerOnly ? Buffer.alloc(0) : Buffer.concat(idat) };
}

/** Width and height from the IHDR chunk, without inflating the image data. */
export function readPngSize(buf: Buffer): { width: number; height: number } | null {
  const head = readPngChunks(buf, true);
  return head ? { width: head.width, height: head.height } : null;
}

/** Decode an 8-bit RGB or RGBA, non-interlaced PNG; returns null for anything else. */
export function decodePng(buf: Buffer): RgbaImage | null {
  const chunks = readPngChunks(buf, false);
  if (!chunks) return null;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(chunks.idat);
  } catch {
    return null;
  }
  return unfilter(raw, chunks.width, chunks.height, chunks.colorType);
}

/** decodePng with the inflate step on the zlib thread pool instead of the calling thread. */
export async function decodePngAsync(buf: Buffer): Promise<RgbaImage | null> {
  const chunks = readPngChunks(buf, false);
  if (!chunks) return null;
  let raw: Buffer;
  try {
    raw = await new Promise<Buffer>((resolve, reject) => zlib.inflate(chunks.idat, (err, out) => (err ? reject(err) : resolve(out))));
  } catch {
    return null;
  }
  return unfilter(raw, chunks.width, chunks.height, chunks.colorType);
}

function unfilter(raw: Buffer, width: number, height: number, colorType: number): RgbaImage | null {
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[base + 1 + x]!;
      const a = x >= bpp ? row[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let r = v;
      if (filter === 1) r = (v + a) & 0xff;
      else if (filter === 2) r = (v + b) & 0xff;
      else if (filter === 3) r = (v + ((a + b) >>> 1)) & 0xff;
      else if (filter === 4) r = (v + paeth(a, b, c)) & 0xff;
      row[x] = r;
    }
    for (let px = 0; px < width; px++) {
      const o = (y * width + px) * 4;
      const s = px * bpp;
      out[o] = row[s]!;
      out[o + 1] = row[s + 1]!;
      out[o + 2] = row[s + 2]!;
      out[o + 3] = bpp === 4 ? row[s + 3]! : 255;
    }
    prev = Buffer.from(row);
  }
  return { width, height, data: out };
}

function filterRows(img: RgbaImage): Buffer {
  const stride = img.width * 4;
  const rows = Buffer.alloc(img.height * (stride + 1));
  for (let y = 0; y < img.height; y++) {
    rows[y * (stride + 1)] = 0;
    img.data.copy(rows, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return rows;
}

/** Encode RGBA as an 8-bit RGBA PNG (filter 0 rows, zlib default level). */
export function encodePng(img: RgbaImage): Buffer {
  return assemblePng(img, zlib.deflateSync(filterRows(img)));
}

/** encodePng with the deflate step on the zlib thread pool instead of the calling thread. */
export async function encodePngAsync(img: RgbaImage): Promise<Buffer> {
  const rows = filterRows(img);
  const deflated = await new Promise<Buffer>((resolve, reject) => zlib.deflate(rows, (err, out) => (err ? reject(err) : resolve(out))));
  return assemblePng(img, deflated);
}

function assemblePng(img: RgbaImage, deflated: Buffer): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(type, data), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflated), chunk('IEND', Buffer.alloc(0))]);
}

/** Box-average downscale by an integer factor (factor 1 returns the input). */
export function downscale(img: RgbaImage, factor: number): RgbaImage {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return img;
  const w = Math.max(1, Math.floor(img.width / f));
  const h = Math.max(1, Math.floor(img.height / f));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < f; dy++) {
        const sy = y * f + dy;
        if (sy >= img.height) break;
        for (let dx = 0; dx < f; dx++) {
          const sx = x * f + dx;
          if (sx >= img.width) break;
          const o = (sy * img.width + sx) * 4;
          r += img.data[o]!; g += img.data[o + 1]!; b += img.data[o + 2]!; a += img.data[o + 3]!; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Lay images left-to-right on one sheet, each under a colour bar, downscaled by the smallest
 * integer factor that keeps the sheet within maxWidth. Images keep their aspect ratio; shorter
 * columns are padded with the background colour.
 */
export function composeContactSheet(images: RgbaImage[], options: ContactSheetOptions = {}): { image: RgbaImage; factor: number } {
  if (!images.length) throw new Error('composeContactSheet needs at least one image');
  const factor = sheetFactor(images, options);
  return { image: paintSheet(images.map((img) => downscale(img, factor)), options), factor };
}

/**
 * composeContactSheet straight from PNG bytes, for the main process. The downscale factor comes
 * from the IHDR sizes, so each capture is inflated (on the zlib thread pool), downscaled and
 * dropped before the next one is decoded, the event loop gets a turn between images, and the
 * sheet is deflated off-thread. Returns null when any input is not a supported PNG.
 */
export async function composeContactSheetFromPngs(pngs: Buffer[], options: ContactSheetOptions = {}): Promise<{ png: Buffer; factor: number } | null> {
  if (!pngs.length) throw new Error('composeContactSheetFromPngs needs at least one image');
  const sizes = pngs.map((png) => readPngSize(png));
  if (sizes.some((s) => !s)) return null;
  const factor = sheetFactor(sizes as Array<{ width: number; height: number }>, options);
  const scaled: RgbaImage[] = [];
  for (const png of pngs) {
    const img = await decodePngAsync(png);
    if (!img) return null;
    scaled.push(downscale(img, factor));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const image = paintSheet(scaled, options);
  return { png: await encodePngAsync(image), factor };
}

/** Smallest integer downscale that keeps the sheet within maxWidth x maxHeight. */
function sheetFactor(sizes: Array<{ width: number; height: number }>, options: ContactSheetOptions): number {
  const gutter = Math.max(0, Math.round(options.gutter ?? 24));
  const maxWidth = Math.max(64, Math.round(options.maxWidth ?? 4096));
  const bar = Math.max(0, Math.round(options.headerBarHeight ?? 8));
  const maxHeight = Math.max(64, Math.round(options.maxHeight ?? 4096));
  const rawWidth = sizes.reduce((sum, img) => sum + img.width, 0) + gutter * (sizes.length + 1);
  const rawHeight = Math.max(...sizes.map((img) => img.height)) + bar + gutter * 2;
  return Math.max(1, Math.ceil(rawWidth / maxWidth), Math.ceil(rawHeight / maxHeight));
}

/** Lay already-scaled images left to right under their colour bars. */
function paintSheet(scaled: RgbaImage[], options: ContactSheetOptions): RgbaImage {
  const gutter = Math.max(0, Math.round(options.gutter ?? 24));
  const bg = options.background ?? [236, 236, 236];
  const bar = Math.max(0, Math.round(options.headerBarHeight ?? 8));
  const width = scaled.reduce((sum, img) => sum + img.width, 0) + gutter * (scaled.length + 1);
  const height = Math.max(...scaled.map((img) => img.height)) + bar + gutter * 2;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255;
  }
  let x0 = gutter;
  scaled.forEach((img, col) => {
    const color = CONTACT_SHEET_COLUMN_COLORS[col % CONTACT_SHEET_COLUMN_COLORS.length]!;
    for (let y = gutter; y < gutter + bar; y++) {
      for (let x = x0; x < x0 + img.width; x++) {
        const o = (y * width + x) * 4;
        data[o] = color[0]; data[o + 1] = color[1]; data[o + 2] = color[2]; data[o + 3] = 255;
      }
    }
    const top = gutter + bar;
    for (let y = 0; y < img.height; y++) {
      img.data.copy(data, ((top + y) * width + x0) * 4, y * img.width * 4, (y + 1) * img.width * 4);
    }
    x0 += img.width + gutter;
  });
  return { width, height, data };
}
