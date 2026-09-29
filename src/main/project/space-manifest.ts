import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `<folder>/.antifan/space.json`: the working set a folder declares — the terminals it runs and the
 * web tabs it keeps open — so opening a Space reproduces it instead of the user rebuilding it by
 * hand. The file lives in the folder, so everything in it is untrusted input: commands are shown
 * to the user and confirmed per content hash before anything runs, and local tab paths are
 * contained to the folder.
 */
export const SPACE_MANIFEST_DIR = '.antifan';
export const SPACE_MANIFEST_FILE = 'space.json';

export type SpaceTerminalRole = 'agent' | 'sync' | 'shell';
export type TerminalIdlePolicy = 'never' | 'manual';

export interface SpaceTerminalSpec {
  id: string;
  label: string;
  command?: string;
  role: SpaceTerminalRole;
  idlePolicy: TerminalIdlePolicy;
}

export type SpaceTabSpec =
  | { kind: 'url'; url: string; role?: string; alias?: string }
  | { kind: 'path'; path: string; role?: string; alias?: string };

export interface SpaceManifest {
  version: 1;
  name?: string;
  terminals: SpaceTerminalSpec[];
  tabs: SpaceTabSpec[];
}

export interface SpaceManifestError {
  path: string;
  message: string;
}

export type SpaceManifestParse =
  | { ok: true; manifest: SpaceManifest; hash: string }
  | { ok: false; errors: SpaceManifestError[] };

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_TERMINALS = 16;
const MAX_TABS = 24;
const MAX_COMMAND_CHARS = 500;
const MAX_TEXT_CHARS = 80;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const TERMINAL_ROLES: Record<string, true> = { agent: true, sync: true, shell: true };
const IDLE_POLICIES: Record<string, true> = { never: true, manual: true };
// A command is typed into a shell and submitted once. A line break would submit a second command
// the confirm dialog shows as the tail of the first, so control characters are refused outright.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function optionalText(
  value: unknown,
  at: string,
  errors: SpaceManifestError[],
  max = MAX_TEXT_CHARS,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL_CHARS.test(value)) {
    errors.push({ path: at, message: `must be a non-empty single-line string of at most ${max} characters` });
    return undefined;
  }
  return value.trim();
}

/**
 * A folder-relative tab path, checked by spelling only: absolute paths, drive letters, UNC and
 * device paths, and any `..` segment are refused so the path cannot name anything outside the
 * folder no matter what the folder later contains. The filesystem half of the containment check
 * (a link inside the folder pointing out of it) is `resolveSpaceTabPath`.
 */
function relativeTabPath(value: unknown, at: string, errors: SpaceManifestError[]): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 260 || CONTROL_CHARS.test(value)) {
    errors.push({ path: at, message: 'must be a non-empty folder-relative path' });
    return undefined;
  }
  const spelled = value.trim();
  const segments = spelled.split(/[\\/]+/);
  const last = segments[segments.length - 1] ?? '';
  if (
    path.win32.isAbsolute(spelled)
    || path.posix.isAbsolute(spelled)
    || /^[A-Za-z]:/.test(spelled)
    || segments.some((segment) => segment === '..')
    || segments.every((segment) => segment === '' || segment === '.')
  ) {
    errors.push({ path: at, message: 'must stay inside the folder (no absolute, drive, UNC or ".." paths)' });
    return undefined;
  }
  // Win32 alternate data streams and reserved device names resolve "inside" the folder by
  // spelling but do not name a file the opener can hand to a preview tab.
  if (segments.some((segment) => segment.includes(':')) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(last)) {
    errors.push({ path: at, message: 'must not name a device or alternate data stream' });
    return undefined;
  }
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/');
}

function webUrl(value: unknown, at: string, errors: SpaceManifestError[]): string | undefined {
  if (typeof value === 'string' && value.length <= 2048) {
    try {
      const parsed = new URL(value.trim());
      // Stricter than the browser's navigation policy on purpose: a file in a repository may open
      // web pages, never the app's own `antifan:` surfaces or local previews by URL.
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    } catch {
      // Falls through to the field error below.
    }
  }
  errors.push({ path: at, message: 'must be an http(s) URL' });
  return undefined;
}

export function spaceManifestHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Validate one manifest buffer. Pure: the caller reads the file once and keeps the buffer. */
export function parseSpaceManifest(buffer: Buffer): SpaceManifestParse {
  if (buffer.length > MAX_MANIFEST_BYTES) {
    return { ok: false, errors: [{ path: '', message: `file is larger than ${MAX_MANIFEST_BYTES} bytes` }] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    return { ok: false, errors: [{ path: '', message: `not valid JSON: ${(err as Error).message}` }] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ path: '', message: 'must be a JSON object' }] };
  }
  const doc = raw as Record<string, unknown>;
  const errors: SpaceManifestError[] = [];
  if (doc.version !== 1) errors.push({ path: 'version', message: 'must be 1' });
  const name = optionalText(doc.name, 'name', errors);

  const terminals: SpaceTerminalSpec[] = [];
  const rawTerminals = doc.terminals ?? [];
  if (!Array.isArray(rawTerminals) || rawTerminals.length > MAX_TERMINALS) {
    errors.push({ path: 'terminals', message: `must be an array of at most ${MAX_TERMINALS} entries` });
  } else {
    const seen = new Set<string>();
    rawTerminals.forEach((entry, index) => {
      const at = `terminals[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push({ path: at, message: 'must be an object' });
        return;
      }
      const t = entry as Record<string, unknown>;
      const before = errors.length;
      const id = typeof t.id === 'string' && ID_PATTERN.test(t.id) ? t.id : undefined;
      if (!id) errors.push({ path: `${at}.id`, message: 'must match [A-Za-z0-9_-]{1,32}' });
      else if (seen.has(id)) errors.push({ path: `${at}.id`, message: `duplicate id '${id}'` });
      else seen.add(id);
      const label = optionalText(t.label, `${at}.label`, errors) ?? id;
      const command = optionalText(t.command, `${at}.command`, errors, MAX_COMMAND_CHARS);
      const role = t.role ?? 'shell';
      if (typeof role !== 'string' || !Object.hasOwn(TERMINAL_ROLES, role)) {
        errors.push({ path: `${at}.role`, message: 'must be agent, sync or shell' });
      }
      const policy = t.idlePolicy ?? (role === 'sync' ? 'never' : 'manual');
      if (typeof policy !== 'string' || !Object.hasOwn(IDLE_POLICIES, policy)) {
        errors.push({ path: `${at}.idlePolicy`, message: 'must be never or manual' });
      } else if (role === 'sync' && policy !== 'never') {
        // Sleeping a terminal kills its process tree; a sync watcher that sleeps stops uploading.
        errors.push({ path: `${at}.idlePolicy`, message: 'a sync terminal must use idlePolicy "never"' });
      }
      if (errors.length === before && id && label) {
        terminals.push({
          id,
          label,
          ...(command ? { command } : {}),
          role: role as SpaceTerminalRole,
          idlePolicy: policy as TerminalIdlePolicy,
        });
      }
    });
  }

  const tabs: SpaceTabSpec[] = [];
  const rawTabs = doc.tabs ?? [];
  if (!Array.isArray(rawTabs) || rawTabs.length > MAX_TABS) {
    errors.push({ path: 'tabs', message: `must be an array of at most ${MAX_TABS} entries` });
  } else {
    rawTabs.forEach((entry, index) => {
      const at = `tabs[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push({ path: at, message: 'must be an object' });
        return;
      }
      const t = entry as Record<string, unknown>;
      const before = errors.length;
      const role = optionalText(t.role, `${at}.role`, errors);
      const alias = optionalText(t.alias, `${at}.alias`, errors);
      const meta = { ...(role ? { role } : {}), ...(alias ? { alias } : {}) };
      if ((t.url === undefined) === (t.path === undefined)) {
        errors.push({ path: at, message: 'must have exactly one of url or path' });
        return;
      }
      if (t.url !== undefined) {
        const url = webUrl(t.url, `${at}.url`, errors);
        if (url && errors.length === before) tabs.push({ kind: 'url', url, ...meta });
      } else {
        const rel = relativeTabPath(t.path, `${at}.path`, errors);
        if (rel && errors.length === before) tabs.push({ kind: 'path', path: rel, ...meta });
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: { version: 1, ...(name ? { name } : {}), terminals, tabs },
    hash: spaceManifestHash(buffer),
  };
}

export function spaceManifestPath(folder: string): string {
  return path.join(folder, SPACE_MANIFEST_DIR, SPACE_MANIFEST_FILE);
}

/**
 * Read the folder's manifest exactly once. The returned buffer is what gets validated, hashed and
 * shown in the confirm, so an edit made after this read can never run under an earlier approval.
 */
export function readSpaceManifest(folder: string): { found: false } | { found: true; buffer: Buffer; parse: SpaceManifestParse } {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(spaceManifestPath(folder));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { found: false };
    return { found: true, buffer: Buffer.alloc(0), parse: { ok: false, errors: [{ path: '', message: `unreadable: ${(err as Error).message}` }] } };
  }
  return { found: true, buffer, parse: parseSpaceManifest(buffer) };
}

/**
 * The absolute file a `path` tab opens, or undefined when it resolves outside `realFolder` (the
 * folder's realpath spelling, not its lowercased key). A file that does not exist yet is
 * contained by its deepest existing ancestor: that ancestor's realpath must be inside the
 * folder, so a missing leaf beneath a link pointing outside is still refused.
 */
export function resolveSpaceTabPath(realFolder: string, relative: string): string | undefined {
  const joined = path.resolve(realFolder, relative);
  let existing = joined;
  const tail: string[] = [];
  let real: string | undefined;
  for (;;) {
    try {
      real = fs.realpathSync.native(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return undefined;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const resolved = tail.length > 0 ? path.join(real, ...tail) : real;
  const rel = path.relative(realFolder, resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  return resolved;
}

/** Single-line, bounded text the parser will accept, or undefined when nothing usable remains. */
function cleanText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
  return text || undefined;
}

/**
 * Build a manifest from what the folder is running now: one entry per live shell (its typed
 * command is unknown, so none is guessed) and one per open web tab. The result is round-tripped
 * through the parser, so a template the user did not edit always opens.
 */
export function buildSpaceTemplate(
  name: string,
  terminals: ReadonlyArray<{ label: string; role?: string; idlePolicy?: string }>,
  tabUrls: ReadonlyArray<{ url: string; alias?: string; role?: string }>,
): SpaceManifest {
  const usedIds = new Set<string>();
  const specs: SpaceTerminalSpec[] = [];
  for (const t of terminals.slice(0, MAX_TERMINALS)) {
    const base = t.label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'shell';
    let id = base;
    for (let n = 2; usedIds.has(id); n += 1) id = `${base}-${n}`;
    usedIds.add(id);
    const role: SpaceTerminalRole = t.role === 'agent' || t.role === 'sync' ? t.role : 'shell';
    specs.push({
      id,
      label: cleanText(t.label) || id,
      role,
      idlePolicy: role === 'sync' || t.idlePolicy === 'never' ? 'never' : 'manual',
    });
  }
  const seen = new Set<string>();
  const tabs: SpaceTabSpec[] = [];
  for (const t of tabUrls) {
    let url: string;
    try {
      const parsed = new URL(t.url.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      url = parsed.toString();
    } catch {
      continue;
    }
    if (tabs.length >= MAX_TABS || seen.has(url)) continue;
    seen.add(url);
    const role = cleanText(t.role);
    const alias = cleanText(t.alias);
    tabs.push({ kind: 'url', url, ...(role ? { role } : {}), ...(alias ? { alias } : {}) });
  }
  const cleanName = cleanText(name);
  return { version: 1, ...(cleanName ? { name: cleanName } : {}), terminals: specs, tabs };
}

/** Serialise a manifest in the on-disk shape (`url`/`path` keys, not the parsed `kind`). */
export function serializeSpaceManifest(manifest: SpaceManifest): string {
  return `${JSON.stringify(
    {
      version: manifest.version,
      ...(manifest.name ? { name: manifest.name } : {}),
      terminals: manifest.terminals,
      tabs: manifest.tabs.map((t) =>
        t.kind === 'url'
          ? { url: t.url, ...(t.role ? { role: t.role } : {}), ...(t.alias ? { alias: t.alias } : {}) }
          : { path: t.path, ...(t.role ? { role: t.role } : {}), ...(t.alias ? { alias: t.alias } : {}) },
      ),
    },
    null,
    2,
  )}\n`;
}

/** Create the manifest file exclusively: an existing file is never overwritten. */
export function writeSpaceManifestExclusive(folder: string, manifest: SpaceManifest): 'written' | 'exists' {
  const body = serializeSpaceManifest(manifest);
  // A scaffold the opener would refuse is a bug in the scaffold, never a file worth writing.
  const check = parseSpaceManifest(Buffer.from(body, 'utf8'));
  if (!check.ok) throw new Error(`generated space.json is invalid: ${check.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  fs.mkdirSync(path.join(folder, SPACE_MANIFEST_DIR), { recursive: true });
  try {
    fs.writeFileSync(spaceManifestPath(folder), body, { encoding: 'utf8', flag: 'wx' });
    return 'written';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw err;
  }
}

/** A `.gitignore` line that names the `.antifan` directory itself (or everything inside it). */
const ANTIFAN_IGNORE_LINE = /^(?:\*\*\/|\/)?\.antifan(?:\/(?:\*{1,2})?)?$/;

/**
 * True when the folder is a git working tree (a `.git` directory, or the `.git` file a linked
 * worktree or submodule carries) whose root `.gitignore` does not end up ignoring `.antifan/`.
 * A manifest lists URLs that may be private, so a scaffold in such a folder is one `git add .`
 * from being published. Rules are read in order and the last one that names the directory
 * wins, so a later `!.antifan/` re-includes it. Only the root `.gitignore` is consulted.
 */
export function antifanDirUnignoredInGit(folder: string): boolean {
  if (!fs.existsSync(path.join(folder, '.git'))) return false;
  let ignore = '';
  try {
    ignore = fs.readFileSync(path.join(folder, '.gitignore'), 'utf8');
  } catch {
    return true;
  }
  let ignored = false;
  for (const raw of ignore.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) {
      if (ANTIFAN_IGNORE_LINE.test(line.slice(1))) ignored = false;
    } else if (ANTIFAN_IGNORE_LINE.test(line)) {
      ignored = true;
    }
  }
  return !ignored;
}
