/**
 * Theme-root marker guard. A QA receipt filed under a folder that is not a
 * theme proves nothing about the theme the user is editing, so QA entry points
 * refuse such a root before running or writing evidence. The usual cause is a
 * tab bound to an ASCII-folded stray directory next to the real, diacritic-named
 * theme folder.
 */
import { CapabilityError } from '../../shared/control-plane-contracts';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const WORKSPACE_NOT_THEME_CODE = 'WORKSPACE_NOT_THEME';

/**
 * Files whose presence makes a directory a theme root: Haravan/Shopify (`layout/`, `config/`) and
 * Sapo (`layouts/theme.bwt`, `configs/`), which spell both directories in the plural.
 */
export const THEME_ROOT_MARKERS: readonly string[] = [
  'layout/theme.liquid',
  'config/settings_schema.json',
  'config/settings.html',
  'layouts/theme.bwt',
  'configs/settings_schema.json',
];
/** Directory AntiFan itself creates inside any root it ever saw; it says nothing about theme content. */
const TOOL_OWNED_DIR = '.antifan';

export interface WorkspaceRootAssessment {
  ok: boolean;
  hasMarkers: boolean;
  empty: boolean;
  reason?: string;
  suggestion?: string;
}

function foldDiacritics(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function hasThemeMarkers(dir: string): boolean {
  return THEME_ROOT_MARKERS.some((marker) => {
    try {
      return fs.statSync(path.join(dir, ...marker.split('/'))).isFile();
    } catch {
      return false;
    }
  });
}

function findDiacriticSibling(root: string): string | undefined {
  const parent = path.dirname(root);
  const base = path.basename(root);
  if (!base || parent === root) return undefined;
  const folded = foldDiacritics(base);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === base) continue;
    if (foldDiacritics(entry.name) !== folded) continue;
    const candidate = path.join(parent, entry.name);
    if (hasThemeMarkers(candidate)) return candidate;
  }
  return undefined;
}

export function assessWorkspaceRoot(root: string): WorkspaceRootAssessment {
  const resolved = typeof root === 'string' ? root.trim() : '';
  if (!resolved) {
    return { ok: false, hasMarkers: false, empty: true, reason: 'no workspace root was supplied' };
  }
  let entries: string[];
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      return { ok: false, hasMarkers: false, empty: false, reason: `'${resolved}' is not a directory` };
    }
    entries = fs.readdirSync(resolved);
  } catch {
    return { ok: false, hasMarkers: false, empty: true, reason: `'${resolved}' does not exist or is not readable` };
  }
  if (hasThemeMarkers(resolved)) return { ok: true, hasMarkers: true, empty: false };
  const empty = entries.every((name) => name === TOOL_OWNED_DIR);
  const suggestion = findDiacriticSibling(resolved);
  const reason = `'${resolved}' ${empty ? 'is empty' : 'has none of the theme markers'} (${THEME_ROOT_MARKERS.join(', ')})`;
  return { ok: false, hasMarkers: false, empty, reason, ...(suggestion ? { suggestion } : {}) };
}

/** Message shared by every caller that refuses a non-theme root. */
export function describeNonThemeRoot(assessment: WorkspaceRootAssessment): string {
  const hint = assessment.suggestion
    ? ` A sibling folder with the same name and diacritics holds the theme: '${assessment.suggestion}'; rebind the tab or pass that workspaceRoot.`
    : ' Bind the tab to the theme folder, or pass allowNonTheme: true for a plain-folder run.';
  return `${assessment.reason ?? 'workspace root is not a theme'}.${hint}`;
}

/**
 * Refuse a non-theme root before any evidence is produced. An empty root means
 * the tab has no bound workspace at all; that provisional case is handled by the
 * callers (no receipt is written) and is not a marker failure.
 */
export function assertThemeWorkspaceRoot(root: string, capability: string): void {
  if (!root.trim()) return;
  const assessment = assessWorkspaceRoot(root);
  if (assessment.ok) return;
  throw new CapabilityError(
    WORKSPACE_NOT_THEME_CODE,
    `${capability} refused workspace root: ${describeNonThemeRoot(assessment)} Nothing ran and no receipt was written.`,
    { workspaceRoot: root, ...(assessment.suggestion ? { suggestion: assessment.suggestion } : {}) }
  );
}
