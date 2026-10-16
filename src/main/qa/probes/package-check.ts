import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { ProbeFinding } from './probe-deps';

const MAX_ZIP_ENTRIES = 20_000;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_ENTRY_BYTES = 1024 * 1024;
const MAX_TEXT_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_FINDINGS_PER_RULE = 50;
const TEXT_EXTENSION = /\.(liquid|json|html|css|scss|js|mjs|svg|txt|md|xml|yml|yaml)$/i;
const LAYOUT_ENTRY = 'layout/theme.liquid';

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

interface PackageView {
  names: string[];
  readText(name: string): Promise<string | null>;
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'private-key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'shopify-token', re: /shp(?:at|ca|pa|ss)_[a-f0-9]{32}/ },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'secret-key', re: /(?<![A-Za-z0-9_-])sk-(?:proj-|live-|test-)?[A-Za-z0-9]{24,}/ },
  { name: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  {
    name: 'credential-assignment',
    re: /(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)["']?\s*[:=]\s*["'][A-Za-z0-9_\-.+/=]{16,}["']/i,
  },
];

const RESIDUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'lorem-ipsum', re: /lorem ipsum/gi },
  { name: 'todo-marker', re: /\b(?:TODO|FIXME)\b/g },
  { name: 'local-path', re: /[A-Za-z]:[\\/](?:Users|Work|Projects)[\\/]/g },
  { name: 'dev-host', re: /\blocalhost:\d{2,5}|127\.0\.0\.1/g },
];

const SECRET_FILE = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|[^/]+\.(pem|key|p12|pfx))$/i;
const ASSET_REFERENCE = /(["'])([^"'\r\n{}|]+?)\1\s*\|\s*asset_url/g;
const VIETNAMESE_DIACRITICS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const UNACCENTED_VIETNAMESE = [
  'khong', 'duoc', 'cua', 'nhung', 'cho', 'va', 'trang', 'san pham', 'cap nhat', 'phien ban', 'sua loi', 'them moi',
  'toi uu', 'giao dien', 'hien thi', 'danh muc', 'gio hang', 'cai dat', 'thay doi',
];

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

function mask(sample: string): string {
  return `${sample.slice(0, 4)}… (${sample.length} chars)`;
}

class ZipReader {
  private constructor(
    private readonly handle: FileHandle,
    readonly entries: ZipEntry[]
  ) {}

  static async open(file: string): Promise<ZipReader> {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (size < 22) throw new Error('file is too small to be a zip archive');
      const tail = Buffer.alloc(Math.min(size, 22 + 0xffff));
      await handle.read(tail, 0, tail.length, size - tail.length);
      let eocd = -1;
      for (let i = tail.length - 22; i >= 0; i -= 1) {
        if (tail.readUInt32LE(i) === 0x06054b50) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new Error('end of central directory record not found');
      const total = tail.readUInt16LE(eocd + 10);
      const cdSize = tail.readUInt32LE(eocd + 12);
      const cdOffset = tail.readUInt32LE(eocd + 16);
      if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported');
      if (total > MAX_ZIP_ENTRIES) throw new Error(`archive lists ${total} entries (limit ${MAX_ZIP_ENTRIES})`);
      if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES || cdOffset + cdSize > size) throw new Error('central directory is out of bounds');

      const cd = Buffer.alloc(cdSize);
      await handle.read(cd, 0, cdSize, cdOffset);
      const entries: ZipEntry[] = [];
      let pos = 0;
      for (let n = 0; n < total; n += 1) {
        if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== 0x02014b50) throw new Error('corrupt central directory');
        const nameLength = cd.readUInt16LE(pos + 28);
        const extraLength = cd.readUInt16LE(pos + 30);
        const commentLength = cd.readUInt16LE(pos + 32);
        entries.push({
          flags: cd.readUInt16LE(pos + 8),
          method: cd.readUInt16LE(pos + 10),
          compressedSize: cd.readUInt32LE(pos + 20),
          size: cd.readUInt32LE(pos + 24),
          localOffset: cd.readUInt32LE(pos + 42),
          name: cd.toString('utf8', pos + 46, pos + 46 + nameLength),
        });
        pos += 46 + nameLength + extraLength + commentLength;
      }
      return new ZipReader(handle, entries);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async read(entry: ZipEntry): Promise<Buffer | null> {
    if (entry.flags & 1 || (entry.method !== 0 && entry.method !== 8)) return null;
    if (entry.size > MAX_TEXT_ENTRY_BYTES || entry.compressedSize > MAX_TEXT_ENTRY_BYTES + 1024) return null;
    const local = Buffer.alloc(30);
    await this.handle.read(local, 0, 30, entry.localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) return null;
    const dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const raw = Buffer.alloc(entry.compressedSize);
    await this.handle.read(raw, 0, raw.length, dataStart);
    let data: Buffer;
    try {
      data = entry.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: entry.size + 1 });
    } catch {
      return null;
    }
    return data.length === entry.size ? data : null;
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

async function walkDirectory(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [''];
  while (stack.length > 0 && out.length < MAX_ZIP_ENTRIES) {
    const rel = stack.pop() as string;
    for (const dirent of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      if (dirent.name === '.git' || dirent.name === 'node_modules') continue;
      const child = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) stack.push(child);
      else if (dirent.isFile()) out.push(child);
    }
  }
  return out.sort();
}

function pushLimited(findings: ProbeFinding[], counts: Map<string, number>, finding: ProbeFinding): void {
  const seen = counts.get(finding.ruleId) ?? 0;
  counts.set(finding.ruleId, seen + 1);
  if (seen < MAX_FINDINGS_PER_RULE) findings.push(finding);
}

function assetExists(name: string, names: Set<string>): boolean {
  const base = `assets/${name}`;
  if (names.has(base) || names.has(`${base}.liquid`)) return true;
  return name.endsWith('.css') && (names.has(`${base.slice(0, -4)}.liquid`) || names.has(base.slice(0, -4)));
}

async function checkView(
  view: PackageView,
  p: { expectedBrand?: string; forbiddenWords?: string[] },
  findings: ProbeFinding[]
): Promise<void> {
  const counts = new Map<string, number>();
  const names = new Set(view.names);

  if (!names.has(LAYOUT_ENTRY)) {
    findings.push({ ruleId: 'package-required-entry', severity: 'critical', message: `Missing required entry ${LAYOUT_ENTRY}.`, measured: { entry: LAYOUT_ENTRY } });
  }
  if (!names.has('config/settings_schema.json') && !names.has('config/settings.html')) {
    findings.push({
      ruleId: 'package-required-entry',
      severity: 'critical',
      message: 'Missing config/settings_schema.json (or config/settings.html for a legacy theme).',
      measured: { entry: 'config/settings_schema.json' },
    });
  }
  if (!view.names.some((n) => n.startsWith('templates/'))) {
    findings.push({ ruleId: 'package-required-entry', severity: 'critical', message: 'Missing templates/ entries.', measured: { entry: 'templates/' } });
  }

  for (const name of view.names) {
    if (SECRET_FILE.test(name)) {
      findings.push({ ruleId: 'package-secret-file', severity: 'critical', message: `${name} must not ship in a theme package.`, measured: { file: name } });
    }
  }

  const forbidden = (p.forbiddenWords ?? []).map((w) => w.trim()).filter((w) => w.length > 0);
  const forbiddenFiles = new Map<string, string[]>();
  const brand = p.expectedBrand ? fold(p.expectedBrand.trim()) : '';
  let brandSeen = false;
  const referencedAssets = new Map<string, string>();
  let skipped = 0;
  let budget = MAX_TEXT_TOTAL_BYTES;

  for (const name of view.names) {
    if (!TEXT_EXTENSION.test(name)) continue;
    const text = await view.readText(name);
    if (text === null) {
      skipped += 1;
      continue;
    }
    budget -= text.length;
    if (budget < 0) {
      skipped += 1;
      break;
    }

    for (const { name: kind, re } of SECRET_PATTERNS) {
      const match = re.exec(text);
      if (match) {
        pushLimited(findings, counts, {
          ruleId: 'package-secret',
          severity: 'critical',
          message: `${name} contains what looks like a ${kind} (${kind === 'private-key' ? 'value withheld' : mask(match[0])}).`,
          measured: { file: name, kind },
        });
      }
    }

    const lower = text.toLowerCase();
    for (const word of forbidden) {
      if (lower.includes(word.toLowerCase())) forbiddenFiles.set(word, [...(forbiddenFiles.get(word) ?? []), name]);
    }

    if (!/\.min\.(js|css)$/i.test(name)) {
      for (const { name: kind, re } of RESIDUE_PATTERNS) {
        const hits = text.match(re)?.length ?? 0;
        if (hits > 0) {
          pushLimited(findings, counts, {
            ruleId: 'package-residue',
            severity: 'warning',
            message: `${name} has ${hits} ${kind} occurrence${hits === 1 ? '' : 's'}.`,
            measured: { file: name, kind, hits },
          });
        }
      }
    }

    if (brand && (name === LAYOUT_ENTRY || name === 'config/settings_schema.json' || name === 'config/settings_data.json') && fold(text).includes(brand)) {
      brandSeen = true;
    }

    if (name === 'config/settings_schema.json') {
      try {
        const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
        if (!Array.isArray(parsed)) {
          findings.push({ ruleId: 'package-schema-invalid', severity: 'critical', message: 'config/settings_schema.json must be a JSON array.', measured: { file: name } });
        }
      } catch (err) {
        findings.push({
          ruleId: 'package-schema-invalid',
          severity: 'critical',
          message: `config/settings_schema.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          measured: { file: name },
        });
      }
    }

    if (/\.(liquid|html|css|scss|js)$/i.test(name)) {
      for (const match of text.matchAll(ASSET_REFERENCE)) {
        const ref = match[2]?.trim();
        if (ref && !/^(https?:)?\/\//.test(ref) && !referencedAssets.has(ref)) referencedAssets.set(ref, name);
      }
    }
  }

  for (const [word, files] of forbiddenFiles) {
    findings.push({
      ruleId: 'package-forbidden-word',
      severity: 'critical',
      message: `Forbidden word "${word}" found in ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}.`,
      measured: { word, files: files.length },
    });
  }
  if (brand && !brandSeen) {
    findings.push({
      ruleId: 'package-brand-missing',
      severity: 'warning',
      message: `Expected brand "${p.expectedBrand}" appears in none of ${LAYOUT_ENTRY}, config/settings_schema.json, config/settings_data.json.`,
      measured: { brand: p.expectedBrand },
    });
  }
  for (const [ref, from] of referencedAssets) {
    if (!assetExists(ref, names)) {
      pushLimited(findings, counts, {
        ruleId: 'package-asset-missing',
        severity: 'critical',
        message: `${from} references asset "${ref}" which is not in the package.`,
        measured: { asset: ref, from },
      });
    }
  }
  if (skipped > 0) {
    findings.push({
      ruleId: 'package-scan-limit',
      severity: 'info',
      message: `${skipped} text file${skipped === 1 ? ' was' : 's were'} too large to scan (limit ${MAX_TEXT_ENTRY_BYTES} bytes each, ${MAX_TEXT_TOTAL_BYTES} total).`,
      measured: { skipped },
    });
  }
}

function checkForm(before: Record<string, string> | undefined, after: Record<string, string> | undefined, findings: ProbeFinding[]): void {
  if (!after) return;
  const previous = new Map(Object.entries(before ?? {}).map(([k, v]): [string, string] => [fold(k).replace(/[-_]+/g, ' ').trim(), v]));
  for (const [key, value] of Object.entries(after)) {
    const nk = fold(key).replace(/[-_]+/g, ' ').trim();
    const was = previous.get(nk);
    if (/(^| )(price|gia|gia ban|cost)( |$)/.test(nk) && was !== undefined) {
      const beforeNumber = Number(String(was).replace(/\D/g, '') || '0');
      const afterNumber = Number(String(value).replace(/\D/g, '') || '0');
      if (beforeNumber !== afterNumber) {
        findings.push({
          ruleId: 'package-form-price-changed',
          severity: 'critical',
          message: `Form field "${key}" changed from ${String(was)} to ${String(value)}.`,
          measured: { field: key, before: was, after: value },
        });
      }
    }
    if (/(^| )(note|notes|ghi chu|mo ta|description|release notes)( |$)/.test(nk) && !VIETNAMESE_DIACRITICS.test(value)) {
      const lowered = value.toLowerCase();
      const hits = UNACCENTED_VIETNAMESE.filter((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(lowered));
      if (hits.length >= 2) {
        findings.push({
          ruleId: 'package-notes-no-diacritics',
          severity: 'warning',
          message: `Form field "${key}" is Vietnamese written without diacritics (${hits.slice(0, 3).join(', ')}).`,
          measured: { field: key },
        });
      }
    }
  }
}

function normalizeZipNames(entries: ZipEntry[], findings: ProbeFinding[]): Map<string, ZipEntry> {
  const byName = new Map<string, ZipEntry>();
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/').replace(/^\.\//, '');
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
      findings.push({ ruleId: 'package-zip-unsafe-path', severity: 'critical', message: `Entry path "${entry.name}" escapes the package root.`, measured: { entry: entry.name } });
      continue;
    }
    byName.set(name, entry);
  }
  if (byName.has(LAYOUT_ENTRY)) return byName;
  const nested = [...byName.keys()].find((n) => n.endsWith(`/${LAYOUT_ENTRY}`));
  if (!nested) return byName;
  const prefix = nested.slice(0, nested.length - LAYOUT_ENTRY.length);
  findings.push({
    ruleId: 'package-nested-root',
    severity: 'critical',
    message: `The theme sits under "${prefix}" inside the zip; layout/, config/ and templates/ must be at the archive root.`,
    measured: { prefix },
  });
  const stripped = new Map<string, ZipEntry>();
  for (const [name, entry] of byName) if (name.startsWith(prefix)) stripped.set(name.slice(prefix.length), entry);
  return stripped;
}

export async function runPackageCheck(p: {
  workspaceRoot: string;
  zipPath?: string;
  expectedBrand?: string;
  forbiddenWords?: string[];
  formBefore?: Record<string, string>;
  formAfter?: Record<string, string>;
}): Promise<{ passed: boolean; findings: ProbeFinding[]; zipEntries?: number }> {
  const findings: ProbeFinding[] = [];
  let zipEntries: number | undefined;

  if (p.zipPath) {
    const zipFile = path.resolve(p.workspaceRoot, p.zipPath);
    let zip: ZipReader;
    try {
      zip = await ZipReader.open(zipFile);
    } catch (err) {
      findings.push({
        ruleId: 'package-zip-unreadable',
        severity: 'critical',
        message: `Cannot read ${path.basename(zipFile)}: ${err instanceof Error ? err.message : String(err)}`,
        measured: { zip: zipFile },
      });
      checkForm(p.formBefore, p.formAfter, findings);
      return { passed: false, findings };
    }
    try {
      zipEntries = zip.entries.filter((e) => !e.name.endsWith('/')).length;
      const byName = normalizeZipNames(zip.entries, findings);
      await checkView(
        {
          names: [...byName.keys()].sort(),
          async readText(name) {
            const entry = byName.get(name);
            if (!entry || entry.size > MAX_TEXT_ENTRY_BYTES) return null;
            const data = await zip.read(entry);
            return data ? data.toString('utf8') : null;
          },
        },
        p,
        findings
      );
    } finally {
      await zip.close();
    }
  } else {
    const root = path.resolve(p.workspaceRoot);
    let names: string[];
    try {
      names = await walkDirectory(root);
    } catch (err) {
      findings.push({
        ruleId: 'package-root-missing',
        severity: 'critical',
        message: `Cannot read workspace root ${root}: ${err instanceof Error ? err.message : String(err)}`,
        measured: { root },
      });
      checkForm(p.formBefore, p.formAfter, findings);
      return { passed: false, findings };
    }
    await checkView(
      {
        names,
        async readText(name) {
          const file = path.join(root, name);
          const { size } = await fs.stat(file);
          return size > MAX_TEXT_ENTRY_BYTES ? null : fs.readFile(file, 'utf8');
        },
      },
      p,
      findings
    );
  }

  checkForm(p.formBefore, p.formAfter, findings);
  return { passed: !findings.some((f) => f.severity === 'critical'), findings, ...(zipEntries !== undefined ? { zipEntries } : {}) };
}
