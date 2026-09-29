/**
 * Per-project appearance (colour, star), durable and keyed by project id.
 *
 * It is deliberately its own store: the capsule store may hold several records for one project
 * (an ambiguous claim), so appearance kept on a capsule would differ by which record is asked.
 * Capsules keep affiliation; the picker and the Terminal Manager both read this one place.
 *
 * Every value is validated on the way in and on the way out of the file: a colour is a plain
 * 6-digit hex, a star is a boolean, a key is a control-plane project id. Anything else is dropped
 * rather than repaired, so a hand-edited or truncated file can never paint or star a row.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TERMINAL_CATEGORY_COLOR_PATTERN } from '../../shared/contracts';
import { isControlPlaneId } from '../../shared/control-plane-contracts';

export interface ProjectAppearance {
  color?: string;
  starred?: boolean;
}

export type ProjectAppearancePatch = { color?: string | null; starred?: boolean };

/** Hard cap: a store that grows without bound is a leak, not a preference. */
export const PROJECT_PREFERENCES_MAX = 512;
export const PROJECT_PREFERENCES_FILE = 'project-preferences.json';

interface StoredFile {
  version: 1;
  projects: Record<string, ProjectAppearance>;
}

function cleanAppearance(value: unknown): ProjectAppearance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: ProjectAppearance = {};
  if (typeof raw.color === 'string' && TERMINAL_CATEGORY_COLOR_PATTERN.test(raw.color)) {
    out.color = raw.color.toLowerCase();
  }
  if (raw.starred === true) out.starred = true;
  return out.color || out.starred ? out : undefined;
}

export class ProjectPreferences {
  private readonly entries = new Map<string, ProjectAppearance>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return; // First run, or unreadable: start empty, never throw at boot.
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const projects = parsed && typeof parsed === 'object' ? (parsed as { projects?: unknown }).projects : undefined;
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return;
    for (const [id, value] of Object.entries(projects as Record<string, unknown>)) {
      if (this.entries.size >= PROJECT_PREFERENCES_MAX) break;
      if (!isControlPlaneId(id, 'project')) continue;
      const appearance = cleanAppearance(value);
      if (appearance) this.entries.set(id, appearance);
    }
  }

  get(projectId: string): ProjectAppearance {
    const found = this.entries.get(projectId);
    return found ? { ...found } : {};
  }

  list(): Record<string, ProjectAppearance> {
    const out: Record<string, ProjectAppearance> = {};
    for (const [id, appearance] of this.entries) out[id] = { ...appearance };
    return out;
  }

  /**
   * Apply a patch. `color: null` clears the colour; `starred: false` clears the star. Returns the
   * resulting appearance, or `undefined` when the patch is invalid (bad id, bad colour, cap hit)
   * and nothing changed. Persists before returning so an accepted answer is a durable one.
   */
  set(projectId: string, patch: ProjectAppearancePatch): ProjectAppearance | undefined {
    if (!isControlPlaneId(projectId, 'project')) return undefined;
    if (patch.color !== undefined && patch.color !== null
      && !(typeof patch.color === 'string' && TERMINAL_CATEGORY_COLOR_PATTERN.test(patch.color))) {
      return undefined;
    }
    if (patch.starred !== undefined && typeof patch.starred !== 'boolean') return undefined;

    const current = this.entries.get(projectId) ?? {};
    const next: ProjectAppearance = { ...current };
    if (patch.color === null) delete next.color;
    else if (typeof patch.color === 'string') next.color = patch.color.toLowerCase();
    if (patch.starred === false) delete next.starred;
    else if (patch.starred === true) next.starred = true;

    const empty = !next.color && !next.starred;
    if (!empty && !this.entries.has(projectId) && this.entries.size >= PROJECT_PREFERENCES_MAX) return undefined;

    const before = new Map(this.entries);
    if (empty) this.entries.delete(projectId);
    else this.entries.set(projectId, next);
    if (!this.persist()) {
      this.entries.clear();
      for (const [k, v] of before) this.entries.set(k, v);
      return undefined;
    }
    return empty ? {} : { ...next };
  }

  /**
   * Forget a project's appearance. Idempotent. Returns false when the deletion could not be made
   * durable; memory is rolled back so it never disagrees with disk.
   */
  remove(projectId: string): boolean {
    const previous = this.entries.get(projectId);
    if (!previous) return true;
    this.entries.delete(projectId);
    if (this.persist()) return true;
    this.entries.set(projectId, previous);
    return false;
  }

  private persist(): boolean {
    const body: StoredFile = { version: 1, projects: this.list() };
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
      return false;
    }
  }
}
