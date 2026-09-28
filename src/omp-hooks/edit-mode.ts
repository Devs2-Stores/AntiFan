/**
 * Edit-mode derivation for AntiFan OMP sessions.
 *
 * One source of truth for the `[⚡Direct-Edit]` / `[🚀Super-Fast]` / `[🧠Core-Context]`
 * vocabulary. Imported by the user-scope edit guard, the repo-scope
 * `antifan-core-bridge` hook and `theme-qa-gate`, so the surfaces that arm a
 * mode, enforce it and stay silent under it can never disagree.
 *
 * Deliberately erasable-TypeScript only (no enum, no namespace, no decorators)
 * because unit tests import this file directly with the Node type stripper.
 *
 * Precedence, in one place: an explicit tag or skill in the prompt always wins,
 * including as the way out of a latched mode. Env is only the *initial* latch at
 * session start, which is what a spawned subagent inherits; it never overrides
 * what the person types.
 */

export type EditMode = "unset" | "core" | "direct" | "fast";

export type EditModeTrigger =
  | "annotation_tag"
  | "skill_invocation"
  | "natural_language"
  | "env_latch"
  | "inherited"
  | "latched"
  | "none";

export interface EditModeDecision {
  /** Mode that applies to the prompt being prepared. */
  mode: EditMode;
  trigger: EditModeTrigger;
  /** True when the decision differs from the latched value. */
  changed: boolean;
}

/** `[🚀Super-Fast]`, `[Super-Fast]`, `[super fast]`. */
export const SUPER_FAST_TAG_RE = /\[[^\]]*super[- ]?fast\]/i;
/** `[⚡Direct-Edit]`, `[Direct-Edit]`, `[direct edit]`. */
export const DIRECT_TAG_RE = /\[[^\]]*direct[- ]?edit\]/i;
/** `[🧠Core-Context]`, `[Core-Pack]`. */
export const CORE_TAG_RE = /\[[^\]]*core[- ]?(?:context|pack)\]/i;
/** `/skill:anti-direct`, or the bare skill name in a routed prompt. */
export const ANTI_DIRECT_SKILL_RE = /\b(?:skill:)?anti-direct\b/i;
/** Vietnamese/English spoken arming. Never used to disarm. */
export const ANTI_DIRECT_NL_RE =
  /(?:sửa\s+trực\s+tiếp|không\s+tra\s+core|tắt\s+core|bỏ\s+qua\s+core|skip\s+core)/i;

export const EDIT_MODE_ENV = "ANTIFAN_EDIT_MODE";

export const EDIT_MODES: readonly EditMode[] = ["unset", "core", "direct", "fast"];

/** Direct and Super-Fast scope writes and silence storefront QA. */
export const SCOPED_MODES: readonly EditMode[] = ["direct", "fast"];

export const MODE_LABELS: Record<EditMode, string> = {
  unset: "unset",
  core: "Core-Context",
  direct: "Direct-Edit",
  fast: "Super-Fast",
};

/** `ANTIFAN_EDIT_MODE` as a validated mode, or null when absent/invalid. */
export function readEditModeEnv(
  env: Record<string, string | undefined> = process.env,
): EditMode | null {
  const raw = env[EDIT_MODE_ENV];
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return (EDIT_MODES as readonly string[]).includes(value) ? (value as EditMode) : null;
}

/** Replays the last `antifan.edit-mode` custom entry out of a session branch. */
export function readEditModeFromBranch(branch: unknown): EditMode | null {
  if (!Array.isArray(branch)) return null;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (!entry || entry.type !== "custom" || entry.customType !== "antifan.edit-mode") continue;
    const data = entry.data as { mode?: unknown } | null;
    const mode = typeof data?.mode === "string" ? data.mode.trim().toLowerCase() : "";
    return (EDIT_MODES as readonly string[]).includes(mode) ? (mode as EditMode) : null;
  }
  return null;
}

/**
 * Tags win over the latched mode; a prompt with no signal keeps what the session
 * already latched. Skill invocation and spoken arming are the same intent as the
 * Direct tag; only an explicit Core signal, or leaving the session, disarms.
 */
export function deriveEditMode(
  prompt: string | undefined,
  latched: EditMode = "unset",
): EditModeDecision {
  const text = typeof prompt === "string" ? prompt : "";
  const decide = (mode: EditMode, trigger: EditModeTrigger): EditModeDecision => ({
    mode,
    trigger,
    changed: mode !== latched,
  });
  if (SUPER_FAST_TAG_RE.test(text)) return decide("fast", "annotation_tag");
  if (DIRECT_TAG_RE.test(text)) return decide("direct", "annotation_tag");
  if (CORE_TAG_RE.test(text)) return decide("core", "annotation_tag");
  if (ANTI_DIRECT_SKILL_RE.test(text)) return decide("direct", "skill_invocation");
  if (ANTI_DIRECT_NL_RE.test(text)) return decide("direct", "natural_language");
  return { mode: latched, trigger: latched === "unset" ? "none" : "latched", changed: false };
}
