/**
 * Remote theme commands run by a Leader's worker.
 *
 * A worker is an OMP session the Leader started in another terminal; it runs
 * unattended, so the only thing that keeps it off a live storefront is code, not
 * its prompt. The rule the user set: a worker may sync its bound draft theme by
 * itself, and everything else that changes a theme on the shop waits for the user.
 *
 * Pure decision logic over the shell command text, kept free of fs/env/spawn so
 * it is testable as a table. `edit-guard.ts` decides whether the caller is a
 * worker and runs the one network check a verdict asks for (`hrv theme info -j`).
 */

import * as path from "node:path";

export const THEME_PUSH_CODES = {
  /** publish / delete / rename / duplicate / share, any Shopify write, or an unknown action. */
  REMOTE_OP: "REFUSED_THEME_REMOTE_OP",
  /** `hrv theme push` without `--only`, or any `--force`. */
  PUSH_SCOPE: "REFUSED_THEME_PUSH_SCOPE",
  /** The command names a theme id other than the bound `.haravan-cli_local.json` one. */
  PUSH_FOREIGN_THEME: "REFUSED_THEME_PUSH_FOREIGN_THEME",
  /** The bound theme is the shop's live (`main`) theme. */
  PUSH_LIVE: "REFUSED_THEME_PUSH_LIVE",
  /** No binding, or `hrv theme info` could not prove the bound theme is a draft. */
  PUSH_UNVERIFIED: "REFUSED_THEME_PUSH_UNVERIFIED",
} as const;

export interface ThemeCommand {
  cli: "hrv" | "shopify";
  /** First known action word after `theme`, or the first positional when none is known. */
  action: string;
  /** Numeric positional after the action (the `[value]` theme id), if any. */
  themeId: string | null;
  flags: string[];
  /** A `cd` / `pushd` / `Set-Location` ran earlier in the same command line. */
  dirChanged: boolean;
  /** The command text from the CLI word on, for refusals and the audit row. */
  text: string;
}

const HRV_READ_ACTIONS: Record<string, true> = {
  list: true,
  info: true,
  fetch: true,
  pull: true,
  export: true,
  lint: true,
  console: true,
  help: true,
};
const HRV_SYNC_ACTIONS: Record<string, true> = { push: true, dev: true };
const SHOPIFY_READ_ACTIONS: Record<string, true> = {
  list: true,
  info: true,
  pull: true,
  check: true,
  package: true,
  open: true,
  init: true,
  console: true,
  profile: true,
  "language-server": true,
  help: true,
};
const KNOWN_ACTIONS: Record<string, true> = {
  ...HRV_READ_ACTIONS,
  ...HRV_SYNC_ACTIONS,
  ...SHOPIFY_READ_ACTIONS,
  publish: true,
  delete: true,
  rename: true,
  duplicate: true,
  share: true,
  upload: true,
};

/** First words that move the shell, so a later theme command no longer runs in the checked folder. */
const DIR_CHANGE_WORDS: Record<string, true> = {
  cd: true,
  pushd: true,
  chdir: true,
  "set-location": true,
  sl: true,
};

/** `C:\x\hrv.cmd`, `./node_modules/.bin/haravan`, `shopify.exe` → `hrv` | `shopify` | null. */
function cliOf(token: string): "hrv" | "shopify" | null {
  const base = path.win32.basename(path.posix.basename(token)).toLowerCase().replace(/\.(cmd|exe|ps1|bat|js|mjs|cjs)$/, "");
  if (base === "hrv" || base === "haravan") return "hrv";
  if (base === "shopify") return "shopify";
  return null;
}

/**
 * Every `hrv|haravan|shopify ... theme <action>` in a shell line. Quotes are
 * dropped before splitting, so a call wrapped in `powershell -Command "..."` or
 * `cmd /c "..."` is still seen; a quoted mention (`echo "hrv theme push"`) is
 * over-detected on purpose - a false refusal is a question to the user, a missed
 * push is a changed shop.
 */
export function parseThemeCommands(command: string): ThemeCommand[] {
  if (typeof command !== "string" || command.length === 0) return [];
  const found: ThemeCommand[] = [];
  const segments = command.replace(/["'`]/g, " ").split(/&&|\|\||[;|\r\n&]/);
  let dirChanged = false;
  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    const first = tokens[0];
    if (first !== undefined && DIR_CHANGE_WORDS[first.toLowerCase()] === true) dirChanged = true;
    for (let i = 0; i < tokens.length; i += 1) {
      const cli = cliOf(tokens[i] ?? "");
      if (cli === null) continue;
      const themeAt = tokens.indexOf("theme", i + 1);
      if (themeAt === -1) continue;
      // Global options may sit between the CLI word and `theme`; any other word means
      // `theme` belongs to something else (`hrv org theme`, `shopify app ...`).
      if (tokens.slice(i + 1, themeAt).some((token) => !token.startsWith("-"))) continue;
      const rest = tokens.slice(themeAt + 1);
      const positionals = rest.filter((token) => !token.startsWith("-"));
      const action =
        positionals.find((token) => KNOWN_ACTIONS[token.toLowerCase()] === true)?.toLowerCase() ??
        positionals[0]?.toLowerCase() ??
        "";
      const afterAction = action ? rest.slice(rest.findIndex((token) => token.toLowerCase() === action) + 1) : [];
      const themeId = afterAction.find((token) => /^\d+$/.test(token)) ?? null;
      found.push({
        cli,
        action,
        themeId,
        flags: rest.filter((token) => token.startsWith("-")).map((token) => token.toLowerCase()),
        dirChanged,
        text: tokens.slice(i).join(" "),
      });
      i = tokens.length;
    }
  }
  return found;
}

export type ThemeCommandPlan =
  | { decision: "allow" }
  | { decision: "block"; code: string; reason: string }
  /** Allowed only if `hrv theme info -j` in the theme root reports `themeId` with a non-`main` role. */
  | { decision: "verify-draft"; themeId: string };

const ASK =
  "Stop and report STATUS: NEEDS_INPUT to the Leader with the exact command; only the user can approve it.";

/**
 * One command against the worker's bound theme id (`null` when the workspace has
 * no `.haravan-cli_local.json`).
 */
export function planThemeCommand(cmd: ThemeCommand, boundThemeId: string | null): ThemeCommandPlan {
  const action = cmd.action;
  if (action === "" || (cmd.cli === "hrv" ? HRV_READ_ACTIONS : SHOPIFY_READ_ACTIONS)[action] === true) {
    return { decision: "allow" };
  }
  if (cmd.cli === "shopify" || HRV_SYNC_ACTIONS[action] !== true) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.REMOTE_OP,
      reason: `${THEME_PUSH_CODES.REMOTE_OP}: '${cmd.text}' changes a theme on the shop, and a Leader worker may only sync its own bound draft Haravan theme (hrv theme push --only <files> / hrv theme dev). ${ASK}`,
    };
  }
  if (cmd.flags.includes("-f") || cmd.flags.includes("--force")) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_SCOPE,
      reason: `${THEME_PUSH_CODES.PUSH_SCOPE}: '${cmd.text}' uses --force, which overwrites changes made on the shop. ${ASK}`,
    };
  }
  if (action === "push" && !cmd.flags.some((flag) => flag === "-o" || flag === "--only" || flag.startsWith("--only="))) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_SCOPE,
      reason: `${THEME_PUSH_CODES.PUSH_SCOPE}: '${cmd.text}' pushes the whole theme. Push only the files you changed: hrv theme push --only <file> [<file> ...].`,
    };
  }
  if (cmd.dirChanged) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_UNVERIFIED,
      reason: `${THEME_PUSH_CODES.PUSH_UNVERIFIED}: '${cmd.text}' runs after a cd in the same command, so the theme it targets cannot be checked. Run it alone with the bash tool's cwd set to the theme folder.`,
    };
  }
  if (boundThemeId === null) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_UNVERIFIED,
      reason: `${THEME_PUSH_CODES.PUSH_UNVERIFIED}: '${cmd.text}' runs in a workspace with no .haravan-cli_local.json, so the target theme cannot be checked. ${ASK}`,
    };
  }
  if (cmd.themeId !== null && cmd.themeId !== boundThemeId) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_FOREIGN_THEME,
      reason: `${THEME_PUSH_CODES.PUSH_FOREIGN_THEME}: '${cmd.text}' targets theme ${cmd.themeId}, but this workspace is bound to theme ${boundThemeId} (.haravan-cli_local.json). ${ASK}`,
    };
  }
  return { decision: "verify-draft", themeId: boundThemeId };
}

/** Parsed `hrv theme info -j`; null when the output holds no theme object. */
export function parseThemeInfo(output: string): { themeId: string; role: string } | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as { theme_id?: unknown; role?: unknown };
    if (parsed.theme_id == null || typeof parsed.role !== "string") return null;
    return { themeId: String(parsed.theme_id).trim(), role: parsed.role.trim().toLowerCase() };
  } catch {
    return null;
  }
}

/** The refusal for a `verify-draft` plan whose `hrv theme info` answer did not clear it. */
export function draftVerdict(
  cmd: ThemeCommand,
  boundThemeId: string,
  info: { themeId: string; role: string } | null,
  detail: string,
): { decision: "allow" } | { decision: "block"; code: string; reason: string } {
  if (info === null || info.themeId !== boundThemeId) {
    const seen = info === null ? detail : `it reported theme ${info.themeId}`;
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_UNVERIFIED,
      reason: `${THEME_PUSH_CODES.PUSH_UNVERIFIED}: could not prove theme ${boundThemeId} is a draft before '${cmd.text}' (hrv theme info -j: ${seen}). ${ASK}`,
    };
  }
  if (info.role === "main") {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_LIVE,
      reason: `${THEME_PUSH_CODES.PUSH_LIVE}: theme ${boundThemeId} is the shop's LIVE theme (role main), and '${cmd.text}' would change what customers see. ${ASK}`,
    };
  }
  return { decision: "allow" };
}
