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
  /** An `eval` cell names the theme CLI: a subprocess there escapes the shell-line checks. */
  VIA_EVAL: "REFUSED_THEME_VIA_EVAL",
  /** The line names the theme CLI in a shape the rules cannot read: wrapper, subshell, quoted, line-continued. */
  COMPLEX: "REFUSED_THEME_COMPLEX",
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
  popd: true,
  chdir: true,
  "set-location": true,
  "push-location": true,
  "pop-location": true,
  sl: true,
};

/** `cd`, `cd..`, `cd\`, `cd/d`, and a bare drive switch such as `D:` all move the shell. */
function isDirChangeToken(token: string): boolean {
  const lower = token.toLowerCase();
  return DIR_CHANGE_WORDS[lower] === true || /^(?:cd|chdir|sl)[.\\/]/.test(lower) || /^[a-z]:$/.test(lower);
}

/** The parser's segments: quotes become spaces, then split on `&&`, `||`, `;`, `|`, line breaks and `&`. */
function parserSegments(command: string): string[] {
  return command.replace(/["'`]/g, " ").split(/&&|\|\||[;|\r\n&]/);
}

/** A segment that starts a script in the current shell (`. x`, `source x`, `.\go.ps1`, `x.bat`): it may `cd`. */
function isScriptCall(first: string): boolean {
  if (cliOf(first) !== null) return false;
  return first === "." || first.toLowerCase() === "source" || /^\.[\\/]/.test(first) || /\.(?:ps1|bat|cmd|sh)$/i.test(first);
}

/**
 * True when the line may move the shell's folder: any directory-changing word as a token
 * anywhere (inside `{ }`, `( )`, quotes, `if`/`for` bodies, `iex '...'`), a bare drive switch,
 * or a segment that runs a script. Over-detection is intended: the cost is "open a new
 * terminal in the theme folder", the cost of a miss is a verdict against the wrong binding.
 */
export function startsDirChange(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  const stripped = text.replace(/["'`]/g, " ");
  if (stripped.split(/[\s{}();|&,]+/).some((token) => token.length > 0 && isDirChangeToken(token))) return true;
  return parserSegments(text).some((segment) => {
    const first = segment.split(/\s+/).find(Boolean);
    return first !== undefined && isScriptCall(first);
  });
}

/** `C:\x\hrv.cmd`, `./node_modules/.bin/haravan`, `shopify.exe` → `hrv` | `shopify` | null. */
function cliOf(token: string): "hrv" | "shopify" | null {
  const base = path.win32.basename(path.posix.basename(token)).toLowerCase().replace(/\.(cmd|exe|ps1|bat|js|mjs|cjs)$/, "");
  if (base === "hrv" || base === "haravan" || base === "haravan-cli") return "hrv";
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
  const segments = parserSegments(command);
  let dirChanged = false;
  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    const first = tokens[0];
    if (first !== undefined && isDirChangeToken(first)) dirChanged = true;
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
  if (cmd.flags.some((flag) => flag === "--force" || flag.startsWith("--force=") || isShortBundleWith(flag, "f"))) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_SCOPE,
      reason: `${THEME_PUSH_CODES.PUSH_SCOPE}: '${cmd.text}' uses --force, which overwrites changes made on the shop. ${ASK}`,
    };
  }
  if (action === "push" && !cmd.flags.some((flag) => flag === "--only" || flag.startsWith("--only=") || isShortBundleWith(flag, "o"))) {
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
      reason: `${THEME_PUSH_CODES.PUSH_UNVERIFIED}: '${cmd.text}' may not run in the folder that was checked: a cd, pushd, Set-Location or script ran before it in this line or earlier in this terminal, so the theme it targets cannot be verified. Run it alone from a new terminal whose folder is the theme folder.`,
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

/** `-f`, `-nf`, `-fo`: a single-dash flag or a bundle of short flags that includes `letter`. */
function isShortBundleWith(flag: string, letter: string): boolean {
  return /^-[a-z]+$/.test(flag) && flag.includes(letter);
}

const CLI_WORD = String.raw`(?:hrv|haravan-cli|haravan|shopify)(?:\.(?:cmd|exe|ps1|bat|js|mjs|cjs))?`;
/**
 * After a CLI word: not part of a longer name (`hrv.liquid`, `hrv-x`) and not a folder
 * (`shopify/theme`, `Shopify\Rebel`). A backslash that is only a source-code escape
 * (`'haravan\n theme'`) still ends the word.
 */
const CLI_END = String.raw`(?![a-z0-9_-]|\.[a-z0-9]|/|\\(?![nrt](?![a-z0-9_])))`;
const CLI_START = String.raw`(?:^|[^a-z0-9_.-])`;

/**
 * A theme CLI word followed later by `theme`, across lines, quotes, list and call syntax.
 * `hrv.liquid` is a file, not the CLI; `hrv.cmd` / `hrv.js` / `haravan-cli` are. A path is not
 * a mention: `shopify/theme`, `...\Shopify\Rebel\layout\theme.liquid`, `layout/theme.liquid`.
 */
const THEME_CLI_MENTION_RE = new RegExp(
  String.raw`${CLI_START}${CLI_WORD}${CLI_END}[\s\S]*?(?:^|[^a-z0-9_\\/.-])theme(?![a-z0-9_-]|\.[a-z0-9]|[\\/])`,
  "i",
);

/**
 * Shop writes that do not say `theme`: `hrv api put|post|delete|patch <path>` (the raw
 * Admin API; `PUT /web/themes/<id>.json {"role":"main"}` is what `hrv theme publish` sends) and
 * `hrv rollback-last-push` (restores remote files with no draft check). `hrv api get` is a read.
 */
const REMOTE_WRITE_RE = new RegExp(
  String.raw`${CLI_START}${CLI_WORD}${CLI_END}(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+(?:api(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+(?:put|post|delete|patch)(?![a-z0-9_-])|rollback-last-push(?![a-z0-9_-]))`,
  "i",
);

/**
 * Lines that rename, store or evaluate the CLI word, so that a later line runs it without
 * spelling it: `Set-Alias h hrv`, `alias h=hrv`, `doskey`, `function h { hrv ... }`, `iex`,
 * and `$h = 'hrv'` / `set H=hrv` / `cli = "hrv"`.
 */
const CLI_ALIAS_RE = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:set-alias|new-alias|sal|alias|doskey|new-variable|set-variable|function|iex|invoke-expression|eval)(?![a-z0-9_-])[^\r\n;&|]*?(?:^|[\s"'=\\/])${CLI_WORD}(?![a-z0-9_-]|\.[a-z0-9])`,
  "i",
);
const CLI_ASSIGN_RE = new RegExp(
  String.raw`(?:^|[;&|(]\s*|\bset\s+)(?:(?:const|let|var|export)\s+)?[$%]?[\w:.-]+%?\s*=\s*["']?(?:[^\s;&|"']*[\\/])?${CLI_WORD}["']?(?=[\s;&|)]|$)`,
  "im",
);

/** A segment that starts with the CLI and then takes its next word from a variable, call, block or expansion. */
function hasIndirectCliArgument(text: string): boolean {
  for (const segment of topLevelSegments(text)) {
    const tokens = segment.trim().split(/\s+/);
    if (cliOf(tokens[0] ?? "") === null) continue;
    const next = tokens.slice(1).find((token) => !token.startsWith("-"));
    if (next !== undefined && /^[$%@`{(]/.test(next)) return true;
  }
  return false;
}

function unquoted(text: string): string {
  return text.replace(/["'`^]/g, "");
}

/** `hrv api put|post|delete|patch ...` or `hrv rollback-last-push`, spelled plainly or with quote-splitting. */
function namesRemoteWrite(text: string): boolean {
  return REMOTE_WRITE_RE.test(text) || REMOTE_WRITE_RE.test(unquoted(text));
}

function namesCliIndirection(text: string): boolean {
  return (
    CLI_ALIAS_RE.test(text) ||
    CLI_ASSIGN_RE.test(text) ||
    CLI_ALIAS_RE.test(unquoted(text)) ||
    CLI_ASSIGN_RE.test(unquoted(text)) ||
    hasIndirectCliArgument(text)
  );
}

/**
 * True when `text` is a use of the theme CLI the gate has to judge: `hrv|haravan|haravan-cli|
 * shopify ... theme`, a shop write through `hrv api` / `hrv rollback-last-push`, or an alias,
 * variable or `iex` that hides the CLI word. Tested on the raw text and on a copy with quoting
 * characters removed, so `h""rv theme push` and `h^rv theme push` are seen. Over-detection is
 * intended: a false hit costs a question to the user, a miss is a changed shop.
 */
export function mentionsThemeCli(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return (
    THEME_CLI_MENTION_RE.test(text) ||
    THEME_CLI_MENTION_RE.test(unquoted(text)) ||
    namesRemoteWrite(text) ||
    namesCliIndirection(text)
  );
}

export type ThemeLinePlan =
  /** No theme-CLI mention: nothing to gate. */
  | { decision: "none" }
  | { decision: "commands"; commands: ThemeCommand[] }
  | { decision: "block"; code: string; reason: string; command: string };

/** Characters and shapes after which the line cannot be read back as plain `hrv theme ...` commands. */
const COMPLEX_SHAPE_RE = /[({`]|\\[\r\n]|\.haravan-cli_local\.json/i;

/** Top-level shell segments: split on `&&`, `||`, `;`, `|`, line breaks and `&` outside quotes. */
function topLevelSegments(text: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of text) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
    } else if (ch === ";" || ch === "|" || ch === "&" || ch === "\r" || ch === "\n") {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments.filter((segment) => segment.trim().length > 0);
}

/**
 * What the push rules can say about one shell line. A line that names a theme CLI is only
 * readable when every segment that names it starts with the CLI itself and parses to a
 * command; a wrapper (`bash -c`, `cmd /c`, `powershell -c`, `npx`), a subshell, a quoted or
 * line-continued CLI word, a global option before `theme`, or a write to the binding file
 * hides what runs, so it is refused as COMPLEX instead of being guessed at.
 */
export function classifyThemeLine(text: string, opts: { assumeDirChanged?: boolean } = {}): ThemeLinePlan {
  if (typeof text !== "string" || !mentionsThemeCli(text)) return { decision: "none" };
  const command = text.trim().slice(0, 200);
  const complex = (why: string): ThemeLinePlan => ({
    decision: "block",
    code: THEME_PUSH_CODES.COMPLEX,
    command,
    reason: `${THEME_PUSH_CODES.COMPLEX}: '${command}' names the theme CLI in a shape the push rules cannot read (${why}). Run each theme command on its own as one plain bash command - hrv theme <action> ... - with the bash tool's cwd set to the theme folder; no wrapper (bash -c, cmd /c, powershell -c, npx), no ( ), $( ), { }, backtick or backslash-newline, no quoted CLI word, no global option before 'theme', and no mention of the CLI inside another command's text (git commit -F <file> instead of -m). ${ASK}`,
  });
  if (namesRemoteWrite(text)) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.REMOTE_OP,
      command,
      reason: `${THEME_PUSH_CODES.REMOTE_OP}: '${command}' writes to the shop outside the draft-theme sync (hrv api put/post/delete/patch sends the request as given, hrv rollback-last-push restores remote files without a draft check). A Leader worker may only sync its own bound draft Haravan theme (hrv theme push --only <files> / hrv theme dev). ${ASK}`,
    };
  }
  if (namesCliIndirection(text)) {
    return complex("an alias, variable, eval or expansion hides which command runs");
  }
  if (COMPLEX_SHAPE_RE.test(text)) {
    return complex("subshell, grouping, backtick, line continuation or .haravan-cli_local.json");
  }
  let mentioningSegments = 0;
  for (const segment of topLevelSegments(text)) {
    if (!mentionsThemeCli(segment)) continue;
    mentioningSegments += 1;
    const first = segment.trim().split(/\s+/)[0] ?? "";
    if (cliOf(first) === null) return complex("the segment does not start with the CLI");
    if (parseThemeCommands(segment).length === 0) return complex("no 'theme <action>' directly after the CLI word");
  }
  if (mentioningSegments === 0) return complex("the CLI word and 'theme' are not in the same command");
  const commands = parseThemeCommands(text).map((cmd) => ({
    ...cmd,
    dirChanged: cmd.dirChanged || opts.assumeDirChanged === true,
  }));
  if (commands.length === 0) return complex("no theme command could be read");
  return { decision: "commands", commands };
}

/**
 * An `eval` cell (Python or JS) can start the theme CLI through `subprocess`, `os.system`,
 * `!cmd`, `Bun.$` or `child_process`, where argument lists and working-directory changes
 * cannot be read back reliably. A worker runs theme commands through the bash tool only,
 * so any eval cell naming the CLI next to `theme` is refused - read actions included.
 */
export function planEvalThemeCode(code: string): ThemeCommandPlan {
  if (typeof code !== "string" || !mentionsThemeCli(code)) return { decision: "allow" };
  return {
    decision: "block",
    code: THEME_PUSH_CODES.VIA_EVAL,
    reason: `${THEME_PUSH_CODES.VIA_EVAL}: this eval cell runs the theme CLI (hrv/haravan/shopify ... theme). A Leader worker runs theme commands only through the bash tool, where the push rules can check them; use bash with its cwd set to the theme folder.`,
  };
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
