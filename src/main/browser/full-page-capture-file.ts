import * as fs from 'node:fs';
import * as path from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SLUG_LENGTH = 60;
const MAX_NAME_ATTEMPTS = 100;

export class FullPageCaptureFileError extends Error {
  constructor(public readonly code: 'CAPTURE_NOT_PNG' | 'CAPTURE_NAME_EXHAUSTED', message: string) {
    super(message);
    this.name = 'FullPageCaptureFileError';
  }
}

export function fullPageCaptureSlug(pageUrl: string | undefined): string {
  let raw = pageUrl || '';
  try {
    const parsed = new URL(raw);
    raw = `${parsed.hostname}${parsed.pathname}`;
  } catch {}
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  const slug = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'page';
}

export function fullPageCaptureStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export interface WriteFullPageCaptureInput {
  base64Png: string;
  dir: string;
  pageUrl?: string;
  now?: Date;
}

export interface WrittenFullPageCapture {
  filePath: string;
  fileName: string;
  size: number;
}

export function writeFullPageCapture(input: WriteFullPageCaptureInput): WrittenFullPageCapture {
  const bytes = Buffer.from(input.base64Png, 'base64');
  if (bytes.length <= PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new FullPageCaptureFileError('CAPTURE_NOT_PNG', 'Full-page capture did not return PNG bytes');
  }
  fs.mkdirSync(input.dir, { recursive: true });
  const base = `fullpage_${fullPageCaptureStamp(input.now ?? new Date())}_${fullPageCaptureSlug(input.pageUrl)}`;
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const fileName = attempt === 1 ? `${base}.png` : `${base}-${attempt}.png`;
    const filePath = path.join(input.dir, fileName);
    try {
      fs.writeFileSync(filePath, bytes, { flag: 'wx' });
      return { filePath, fileName, size: bytes.length };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new FullPageCaptureFileError('CAPTURE_NAME_EXHAUSTED', `No free file name for ${base}.png in ${input.dir}`);
}
