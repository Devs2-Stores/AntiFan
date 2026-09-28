/**
 * Workspace shape resolution for edit-mode enforcement.
 *
 * The guard's question is never "which tool", it is "which file". This module
 * answers that from the session cwd alone: the nearest annotation-bound ancestor
 * (`.antifan/`, the same rule `theme-qa-gate` uses), the nearest theme root, and
 * the small set of directories a scoped session is allowed to write.
 *
 * Fail closed: a cwd that looks like neither a theme nor an AntiFan workspace has
 * no editable roots, so every write is refused until the person leaves the mode.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const THEME_SUBDIRS = [
  "layout",
  "templates",
  "sections",
  "snippets",
  "assets",
  "config",
  "locales",
];

/** Directories a scoped session may still use for its own bookkeeping. */
const BOOKKEEPING_SUBDIRS = [".antifan", ".qa", "plans", "reports", "docs", "specs", "tmp"];

/** Root-level files a scoped session may write (theme metadata, workspace docs). */
const ROOT_FILE_EXTS = [".json", ".md", ".liquid", ".txt"];

const HRV_MARKER = ".hrv-sync-state.json";
const MAX_WALK_UP = 12;

/**
 * Strong theme evidence. A lone `config/` or `assets/` directory is far too common
 * (dotfiles, app configs) to call a workspace a theme; a theme always ships
 * `templates/` next to at least one of the Liquid content directories, or carries
 * the Haravan sync marker.
 */
function looksLikeThemeRoot(dir: string): boolean {
  if (isFile(path.join(dir, HRV_MARKER))) return true;
  if (!isDirectory(path.join(dir, "templates"))) return false;
  return ["layout", "sections", "snippets"].some((sub) => isDirectory(path.join(dir, sub)));
}

export interface EditGuardConfig {
  allowExtraPaths: string[];
  error: string | null;
}

export interface WorkspaceShape {
  cwd: string;
  /** Nearest annotation root, else theme root, else cwd. */
  workspaceRoot: string;
  annotationRoot: string | null;
  themeRoot: string | null;
  /** Absolute directories whose subtrees are writable in a scoped mode. */
  editableRoots: string[];
  /** Absolute directories where a root-level ROOT_FILE_EXTS file is writable. */
  rootFileDirs: string[];
  allowExtraPaths: string[];
  configError: string | null;
}

export type WriteVerdict =
  | { decision: "allow"; absPath: string }
  | {
      decision: "block";
      code: "REFUSED_EDIT_SCOPE" | "REFUSED_THEME_ROOT_UNRESOLVED";
      absPath: string;
      reason: string;
    };

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** True when `child` is `parent` or below it, Windows-case-insensitively. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === "") return true;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

/** `%ANTIFAN_DATA_ROOT%/edit-guard.json`, the only way to widen the allow-list. */
export function loadEditGuardConfig(
  env: Record<string, string | undefined> = process.env,
): EditGuardConfig {
  const root = env.ANTIFAN_DATA_ROOT;
  if (typeof root !== "string" || root.trim().length === 0) {
    return { allowExtraPaths: [], error: null };
  }
  const configPath = path.join(root.trim(), "edit-guard.json");
  if (!isFile(configPath)) return { allowExtraPaths: [], error: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      allowExtraPaths?: unknown;
    };
    const raw = Array.isArray(parsed?.allowExtraPaths) ? parsed.allowExtraPaths : [];
    const allowExtraPaths = raw
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => path.resolve(entry.trim()));
    return { allowExtraPaths, error: null };
  } catch (error) {
    return {
      allowExtraPaths: [],
      error: error instanceof Error ? error.message : "unreadable edit-guard.json",
    };
  }
}

export function resolveWorkspaceShape(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): WorkspaceShape {
  const start = path.resolve(cwd && cwd.trim().length > 0 ? cwd : process.cwd());
  let annotationRoot: string | null = null;
  let themeRoot: string | null = null;
  let dir = start;
  for (let depth = 0; depth <= MAX_WALK_UP; depth += 1) {
    if (annotationRoot === null && isDirectory(path.join(dir, ".antifan"))) {
      annotationRoot = dir;
    }
    if (themeRoot === null && looksLikeThemeRoot(dir)) {
      themeRoot = dir;
    }
    if (annotationRoot !== null && themeRoot !== null) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const workspaceRoot = annotationRoot ?? themeRoot ?? start;
  const editableRoots: string[] = [];
  if (themeRoot !== null) {
    for (const sub of THEME_SUBDIRS) {
      const candidate = path.join(themeRoot, sub);
      if (isDirectory(candidate)) editableRoots.push(candidate);
    }
  }
  for (const sub of BOOKKEEPING_SUBDIRS) {
    const candidate = path.join(workspaceRoot, sub);
    if (isDirectory(candidate)) editableRoots.push(candidate);
  }

  const rootFileDirs: string[] = [];
  if (themeRoot !== null) rootFileDirs.push(themeRoot);
  if (workspaceRoot !== themeRoot) rootFileDirs.push(workspaceRoot);

  const config = loadEditGuardConfig(env);

  return {
    cwd: start,
    workspaceRoot,
    annotationRoot,
    themeRoot,
    editableRoots,
    rootFileDirs,
    allowExtraPaths: config.allowExtraPaths,
    configError: config.error,
  };
}

/**
 * Resolves one write target. `rawTarget` may be relative (hook cwd is the session
 * cwd) or absolute; a missing or non-string target is a refusal, never a pass.
 */
export function classifyWritePath(shape: WorkspaceShape, rawTarget: unknown): WriteVerdict {
  const raw = typeof rawTarget === "string" ? rawTarget.trim() : "";
  if (raw.length === 0) {
    return {
      decision: "block",
      code: "REFUSED_EDIT_SCOPE",
      absPath: "",
      reason: "write target path is missing or not a string",
    };
  }
  const absPath = path.resolve(shape.cwd, raw);
  for (const root of shape.editableRoots) {
    if (isInside(root, absPath)) return { decision: "allow", absPath };
  }
  for (const extra of shape.allowExtraPaths) {
    if (isInside(extra, absPath)) return { decision: "allow", absPath };
  }
  if (shape.rootFileDirs.some((dir) => path.dirname(absPath) === dir)) {
    if (ROOT_FILE_EXTS.includes(path.extname(absPath).toLowerCase())) {
      return { decision: "allow", absPath };
    }
  }
  if (shape.themeRoot === null && shape.annotationRoot === null) {
    return {
      decision: "block",
      code: "REFUSED_THEME_ROOT_UNRESOLVED",
      absPath,
      reason: `no theme root and no .antifan/ found walking up from ${shape.cwd}; send [Core-Context] to leave the mode`,
    };
  }
  return {
    decision: "block",
    code: "REFUSED_EDIT_SCOPE",
    absPath,
    reason: `outside the writable set of ${shape.themeRoot ?? shape.workspaceRoot}`,
  };
}
