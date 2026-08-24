/**
 * AntiFan Browser Desktop — Workspace Resolver
 * Pure URL → workspace-path classification shared by terminal routing and
 * annotation storage. Extracted from NativeTabHost.resolveTargetWorkspace so the
 * matching logic is unit-testable in isolation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_WORKSPACE_ROOTS = [
  path.join('e:\\Work', 'customizes'),
  path.join('e:\\Work', 'themes'),
  path.join('e:\\Work', 'apps'),
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