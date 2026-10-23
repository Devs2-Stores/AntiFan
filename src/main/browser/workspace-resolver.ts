/**
 * AntiFan Browser Desktop — Workspace Resolver
 * Pure URL → workspace-path classification shared by terminal routing and
 * annotation storage. Extracted from NativeTabHost.resolveTargetWorkspace so the
 * matching logic is unit-testable in isolation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CapabilityError } from '../../shared/control-plane-contracts';
export const DEFAULT_WORKSPACE_ROOTS = [
  path.join('e:\\Work', 'customizes'),
  path.join('e:\\Work', 'themes'),
  path.join('e:\\Work', 'apps'),
];

/**
 * Roots an explicit caller-supplied workspaceRoot may name. Extends the project
 * roots with media folders that hold upload assets but are not URL-routed
 * projects, so resolveWorkspaceFromUrl keeps scanning DEFAULT_WORKSPACE_ROOTS only.
 * Gác is the omp session root for the Tường channels; the user allowed agent
 * uploads from it on 23/10/2026 instead of DataTransfer injection.
 */
export const AUTHORIZED_WORKSPACE_ROOTS = [
  ...DEFAULT_WORKSPACE_ROOTS,
  path.join('e:\\Work', 'shopee-reels'),
  path.join('e:\\Work', 'Gác'),
];

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
  authorizedRoots: string[] = AUTHORIZED_WORKSPACE_ROOTS
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
        recovery: 'pass a workspaceRoot inside one of authorizedRoots, or omit workspaceRoot to use the bound workspace',
      }
    );
  }

  return path.normalize(realCandidate);
}