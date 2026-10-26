/**
 * AntiFan Browser Desktop — Workspace Resolver
 * Pure URL → workspace-path classification shared by terminal routing and
 * annotation storage. Extracted from NativeTabHost.resolveTargetWorkspace so the
 * matching logic is unit-testable in isolation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CapabilityError } from '../../shared/control-plane-contracts';
import { StorageLocations } from '../config/storage-locations';
import { recordLifecycleEvent } from '../diagnostics/main-lifecycle-log';
export const DEFAULT_WORKSPACE_ROOTS = [
  path.join('e:\\Work', 'customizes'),
  path.join('e:\\Work', 'themes'),
  path.join('e:\\Work', 'apps'),
];

/**
 * Built-in roots an explicit caller-supplied workspaceRoot may name. Extends the project
 * roots with media folders that hold upload assets but are not URL-routed
 * projects, so resolveWorkspaceFromUrl keeps scanning DEFAULT_WORKSPACE_ROOTS only.
 * Further roots are added without a code change through WORKSPACE_ROOTS_FILE, see
 * resolveAuthorizedWorkspaceRoots.
 */
export const AUTHORIZED_WORKSPACE_ROOTS = [
  ...DEFAULT_WORKSPACE_ROOTS,
  path.join('e:\\Work', 'shopee-reels'),
  path.join('e:\\Work', 'Gác'),
];

/**
 * `<data root>/workspace-roots.json`: a JSON array of absolute directory paths (or an object with
 * a `roots` array) that extend AUTHORIZED_WORKSPACE_ROOTS. It widens which directories an agent
 * may read from and write to, so every entry is validated and a bad entry is dropped, never
 * repaired.
 */
export const WORKSPACE_ROOTS_FILE = 'workspace-roots.json';

export type WorkspaceRootJournal = (event: string, fields: Record<string, unknown>) => void;

export interface WorkspaceRootsOptions {
  /** Data root holding WORKSPACE_ROOTS_FILE; defaults to ANTIFAN_DATA_ROOT, then the install default. */
  dataRoot?: string;
  /** Receives one line per ignored entry or unreadable file; defaults to the lifecycle log. */
  journal?: WorkspaceRootJournal;
}

export interface ConfiguredWorkspaceRoots {
  roots: string[];
  rejected: Array<{ entry: string; reason: string }>;
}

export type ConfiguredRootCheck = { ok: true; root: string } | { ok: false; reason: string };

function rootKey(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

/**
 * Accepts only an absolute, normalized, existing directory: no `..` segment, no UNC or device
 * path, no drive or filesystem root (a root would authorize the whole disk).
 */
export function validateConfiguredWorkspaceRoot(entry: unknown): ConfiguredRootCheck {
  if (typeof entry !== 'string' || !entry.trim()) return { ok: false, reason: 'not a non-empty string' };
  const raw = entry.trim();
  if (/^[\\/]{2}/.test(raw)) return { ok: false, reason: 'UNC and device paths are not allowed' };
  if (process.platform === 'win32' ? !/^[a-zA-Z]:[\\/]/.test(raw) : !path.isAbsolute(raw)) {
    return { ok: false, reason: 'not an absolute path' };
  }
  if (raw.split(/[\\/]+/).includes('..')) return { ok: false, reason: 'contains a ".." segment' };
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root) return { ok: false, reason: 'a drive or filesystem root is not allowed' };
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(resolved).isDirectory();
  } catch {
    return { ok: false, reason: 'does not exist' };
  }
  if (!isDirectory) return { ok: false, reason: 'not a directory' };
  return { ok: true, root: resolved };
}

/** Parses the file text; duplicates collapse (case-insensitively on Windows). Throws on invalid JSON or shape. */
export function parseWorkspaceRootsConfig(text: string): ConfiguredWorkspaceRoots {
  const parsed: unknown = JSON.parse(text);
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && 'roots' in parsed && Array.isArray(parsed.roots)
      ? (parsed.roots as unknown[])
      : null;
  if (!entries) throw new Error('expected a JSON array of paths or an object with a "roots" array');
  const roots: string[] = [];
  const seen = new Set<string>();
  const rejected: ConfiguredWorkspaceRoots['rejected'] = [];
  for (const entry of entries) {
    const check = validateConfiguredWorkspaceRoot(entry);
    if (!check.ok) {
      rejected.push({ entry: typeof entry === 'string' ? entry.slice(0, 260) : JSON.stringify(entry)?.slice(0, 260) ?? String(entry), reason: check.reason });
      continue;
    }
    const key = rootKey(check.root);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(check.root);
  }
  return { roots, rejected };
}

interface RootsCacheEntry {
  file: string;
  mtimeMs: number;
  size: number;
  result: ConfiguredWorkspaceRoots;
}
let rootsCache: RootsCacheEntry | null = null;

function resolveDataRoot(options: WorkspaceRootsOptions | undefined): string | null {
  if (options?.dataRoot) return options.dataRoot;
  try {
    return process.env.ANTIFAN_DATA_ROOT?.trim() || StorageLocations.getDataRoot();
  } catch {
    return null;
  }
}

/** Roots from WORKSPACE_ROOTS_FILE, re-read only when the file's mtime or size changes. */
export function loadConfiguredWorkspaceRoots(options?: WorkspaceRootsOptions): ConfiguredWorkspaceRoots {
  const none: ConfiguredWorkspaceRoots = { roots: [], rejected: [] };
  const dataRoot = resolveDataRoot(options);
  if (!dataRoot) return none;
  const file = path.join(dataRoot, WORKSPACE_ROOTS_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    rootsCache = null;
    return none;
  }
  if (rootsCache && rootsCache.file === file && rootsCache.mtimeMs === stat.mtimeMs && rootsCache.size === stat.size) {
    return rootsCache.result;
  }
  const journal = options?.journal ?? recordLifecycleEvent;
  let result = none;
  try {
    result = parseWorkspaceRootsConfig(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    journal('workspaceRoots.unreadable', { file, reason: err instanceof Error ? err.message : String(err) });
  }
  for (const rejected of result.rejected) {
    journal('workspaceRoots.entryIgnored', { file, entry: rejected.entry, reason: rejected.reason });
  }
  rootsCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, result };
  return result;
}

/** Built-in roots plus the validated roots from WORKSPACE_ROOTS_FILE. */
export function resolveAuthorizedWorkspaceRoots(options?: WorkspaceRootsOptions): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const root of [...AUTHORIZED_WORKSPACE_ROOTS, ...loadConfiguredWorkspaceRoots(options).roots]) {
    const key = rootKey(path.resolve(root));
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(root);
  }
  return merged;
}

function cleanProjectName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, '');
}

function hostLabels(host: string): string[] {
  return host.toLowerCase().split('.').filter(Boolean).map(cleanProjectName);
}

function myharavanBase(host: string): string {
  const labels = hostLabels(host);
  const haravanIndex = labels.indexOf('myharavan');
  return haravanIndex > 0 ? labels[haravanIndex - 1] ?? '' : '';
}

/**
 * True when the project name appears as a complete hostname label (or as the
 * Haravan storefront base) in the host — the deterministic exact pass.
 */
export function hostExactlyMatchesProject(host: string, projectName: string): boolean {
  const labels = hostLabels(host);
  const projectClean = cleanProjectName(projectName);
  if (!projectClean) return false;
  return labels.includes(projectClean) || myharavanBase(host) === projectClean;
}

/**
 * True when the project name differs from a complete hostname label only by a
 * trailing numeric suffix ("Seahorse2" ← host "seahorse"). Never true for an
 * exact or myharavan match; callers run the exact pass first.
 */
export function hostSuffixMatchesProject(host: string, projectName: string): boolean {
  const projectClean = cleanProjectName(projectName);
  if (hostExactlyMatchesProject(host, projectName)) return false;
  const stripped = projectClean.replace(/\d+$/, '');
  if (stripped.length < 3) return false;
  return hostLabels(host).includes(stripped);
}

/**
 * Backwards-compatible composite predicate: exact OR suffix. Kept for tests and
 * callers that do not need the two-pass determinism guarantee.
 */
export function hostMatchesProject(host: string, projectName: string): boolean {
  return hostExactlyMatchesProject(host, projectName) || hostSuffixMatchesProject(host, projectName);
}

/**
 * Resolve a page URL to a workspace directory path, or null when no configured
 * project root matches. Exact matches are resolved in a first pass and numeric
 * suffix matches in a second, so both "Seahorse" and "Seahorse2" existing
 * stays deterministic regardless of directory enumeration order.
 */
export function resolveWorkspaceFromUrl(tabUrl?: string, roots: string[] = DEFAULT_WORKSPACE_ROOTS): string | null {
  if (!tabUrl) return null;
  try {
    const parsedUrl = new URL(tabUrl);
    const host = parsedUrl.hostname.toLowerCase();
    if (!host) return null;
    for (const pass of [hostExactlyMatchesProject, hostSuffixMatchesProject]) {
      for (const rootDir of roots) {
        if (!fs.existsSync(rootDir)) continue;
        const projects = fs.readdirSync(rootDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
        for (const project of projects) {
          if (pass(host, project.name)) {
            return path.normalize(path.join(rootDir, project.name));
          }
        }
      }
    }
  } catch {}
  return null;
}

/**
 * Validate that an explicit caller-supplied workspaceRoot resides within the
 * session's authorized roots (AUTHORIZED_WORKSPACE_ROOTS) and exists on disk.
 * Prevents arbitrary filesystem path traversal/escape while allowing external tabs
 * (e.g. partners.haravan.com) to target an authorized project directory.
 */
export function validateAuthorizedWorkspaceRoot(
  candidateRoot: string,
  authorizedRoots: string[] = resolveAuthorizedWorkspaceRoots(),
  /** The file the caller is acting on, named in the refusal so a multi-file call says which one it was. */
  subject?: { filePath?: string }
): string {
  if (typeof candidateRoot !== 'string' || !candidateRoot.trim()) {
    throw new CapabilityError('INVALID_ARGUMENT', 'workspaceRoot must be a non-empty string');
  }
  const resolved = path.resolve(candidateRoot.trim());
  if (!fs.existsSync(resolved)) {
    throw new CapabilityError('WORKSPACE_UNBOUND', `Workspace root does not exist on disk: ${candidateRoot}`);
  }
  const realCandidate = fs.realpathSync(resolved);
  const candStat = fs.statSync(realCandidate);
  if (!candStat.isDirectory()) {
    throw new CapabilityError('INVALID_ARGUMENT', `Workspace root is not a directory: ${candidateRoot}`);
  }

  const isAuthorized = authorizedRoots.some((allowed) => {
    if (!fs.existsSync(allowed)) return false;
    const realAllowed = fs.realpathSync(path.resolve(allowed));
    const rel = path.relative(realAllowed, realCandidate);
    return (
      rel === '' ||
      (!rel.startsWith('..') && !path.isAbsolute(rel) && !(process.platform === 'win32' && /^[a-zA-Z]:/.test(rel)))
    );
  });

  if (!isAuthorized) {
    const rootsText = authorizedRoots.length > 0 ? authorizedRoots.join(', ') : '(none configured)';
    throw new CapabilityError(
      'OUTSIDE_WORKSPACE',
      `Access denied: workspaceRoot "${candidateRoot}" is not within authorized project roots (${rootsText})`,
      {
        workspaceRoot: candidateRoot,
        authorizedRoots: [...authorizedRoots],
        failedCheck: 'workspaceRoot',
        ...(typeof subject?.filePath === 'string' && subject.filePath ? { filePath: subject.filePath } : {}),
        recovery: 'pass a workspaceRoot inside one of authorizedRoots, or omit workspaceRoot to use the bound workspace',
      }
    );
  }

  return path.normalize(realCandidate);
}