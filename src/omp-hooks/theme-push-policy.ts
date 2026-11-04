/**
 * Remote theme commands run by a Leader's worker.
 *
 * A worker is an OMP session the Leader started in another terminal; it runs
 * unattended, so the only thing that keeps it off a live storefront is code, not
 * its prompt. The rule the user set (03/11/2026): a worker may push to the theme id its `hrv`
 * workspace is bound to (`.haravan-cli_local.json`), live or copy alike, as long as `hrv theme info`
 * there succeeds and reports that same id, and the push carries `--nodelete` (a bare push deletes every
 * remote file the folder does not hold); it may push scoped files to one verified unpublished
 * Shopify theme; everything else that changes a theme on the shop waits for the user.
 *
 * Pure decision logic over the shell command text, kept free of fs/env/spawn so
 * it is testable as a table. `edit-guard.ts` decides whether the caller is a
 * worker and runs the one network check a verdict asks for (`hrv theme info -j`).
 */

import * as path from "node:path";

export const THEME_PUSH_CODES = {
  /** publish / delete / rename / duplicate / share, any Shopify write, or an unknown action. */
  REMOTE_OP: "REFUSED_THEME_REMOTE_OP",
  /** `--force` or `--prune`, or a Shopify push that is not scoped to named files. */
  PUSH_SCOPE: "REFUSED_THEME_PUSH_SCOPE",
  /** `hrv theme push` without `--nodelete`: the CLI would delete every remote file this folder does not hold. Fix: add `--nodelete`. */
  PUSH_NODELETE: "REFUSED_THEME_PUSH_NODELETE",
  /** `hrv theme push` that would send `config/settings_data.json` without naming it: add `--ignore config/settings_data.json` or name the files with `--only`. */
  PUSH_SETTINGS_DATA: "REFUSED_THEME_PUSH_SETTINGS_DATA",
  /** The command names a theme id other than the bound `.haravan-cli_local.json` one. */
  PUSH_FOREIGN_THEME: "REFUSED_THEME_PUSH_FOREIGN_THEME",
  /** `hrv theme dev` (a watcher that keeps writing) on the shop's live (`main`) theme, or a Shopify push with a live flag. */
  PUSH_LIVE: "REFUSED_THEME_PUSH_LIVE",
  /** No binding, or `hrv theme info` could not prove it reports the bound theme id. */
  PUSH_UNVERIFIED: "REFUSED_THEME_PUSH_UNVERIFIED",
  /** An `eval` cell names the theme CLI: a subprocess there escapes the shell-line checks. */
  VIA_EVAL: "REFUSED_THEME_VIA_EVAL",
  /** The line names the theme CLI in a shape the rules cannot read: wrapper, subshell, quoted, line-continued. */
  COMPLEX: "REFUSED_THEME_COMPLEX",
} as const;

export interface ThemeCommand {
  cli: "hrv" | "shopify" | "sapo";
  /** First known action word after `theme`, or the first positional when none is known. */
  action: string;
  /** Numeric positional after the action (the `[value]` theme id), if any. */
  themeId: string | null;
  flags: string[];
  /** A `cd` / `pushd` / `Set-Location` ran earlier in the same command line. */
  dirChanged: boolean;
  /** The shell line holds more than one command (`;`, `&&`, `||`, `|`, `&`, line break), so this one is not alone on its line. */
  chained: boolean;
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

/** `C:\x\hrv.cmd`, `./node_modules/.bin/haravan`, `shopify.exe`, `sapo` → `hrv` | `shopify` | `sapo` | null. */
function cliOf(token: string): "hrv" | "shopify" | "sapo" | null {
  const base = path.win32.basename(path.posix.basename(token)).toLowerCase().replace(/\.(cmd|exe|ps1|bat|js|mjs|cjs)$/, "");
  if (base === "hrv" || base === "haravan" || base === "haravan-cli") return "hrv";
  if (base === "shopify") return "shopify";
  if (base === "sapo") return "sapo";
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
  const chained = segments.filter((segment) => segment.trim().length > 0).length > 1;
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
        chained,
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
  /** Allowed only if `hrv theme info -j` in the theme root succeeds and reports `themeId`; `hrv theme dev` also needs a non-`main` role. */
  | { decision: "verify-draft"; themeId: string }
  /**
   * A scoped `shopify theme push` at one numeric theme of one store. Allowed only if
   * `shopify theme list --id <themeId> --store <store> --json` reports exactly that theme with role
   * `unpublished` or `development`.
   */
  | { decision: "verify-shopify-draft"; themeId: string; store: string };

const ASK =
  "Stop and report STATUS: NEEDS_INPUT to the Leader with the exact command; only the user can approve it.";

/**
 * One command against the worker's bound theme id (`null` when the workspace has
 * no `.haravan-cli_local.json`).
 */
export function planThemeCommand(cmd: ThemeCommand, boundThemeId: string | null): ThemeCommandPlan {
  const action = cmd.action;
  if (cmd.cli === "hrv" && cmd.flags.some((flag) => flag === "--prune" || flag.startsWith("--prune="))) {
    if (!cmd.flags.some((flag) => flag === "--help" || flag === "-h")) {
      return {
        decision: "block",
        code: THEME_PUSH_CODES.PUSH_SCOPE,
        reason: `${THEME_PUSH_CODES.PUSH_SCOPE}: '${cmd.text}' uses --prune, which deletes local files that are not on the remote theme. ${ASK}`,
      };
    }
  }
  if (action === "" || (cmd.cli === "hrv" ? HRV_READ_ACTIONS : SHOPIFY_READ_ACTIONS)[action] === true) {
    return { decision: "allow" };
  }
  if (cmd.flags.some((flag) => flag === "--help" || flag === "-h")) {
    // Help output runs nothing on the shop.
    return { decision: "allow" };
  }
  if (cmd.cli === "shopify" && action === "push") return planShopifyPush(cmd);
  if (cmd.cli !== "hrv" && action === "dev") {
    // `shopify|sapo theme dev` serves a local preview on a development theme, so it does not
    // change the live theme; naming an existing theme does, directly (`--theme`, `-t`, `-t123`,
    // `-t=123`) or through an environment of shopify.theme.toml (`-e`, `--environment`), so those
    // forms stay a question for the user. A theme id set in the process environment
    // (SHOPIFY_FLAG_THEME_ID) is not visible in the command line and is not checked.
    const namesExistingTheme = cmd.flags.some(
      (flag) =>
        flag === "--theme" ||
        flag.startsWith("--theme=") ||
        flag === "--environment" ||
        flag.startsWith("--environment=") ||
        /^-[a-z]*[te]/.test(flag),
    );
    if (!namesExistingTheme) return { decision: "allow" };
    return {
      decision: "block",
      code: THEME_PUSH_CODES.REMOTE_OP,
      reason: `${THEME_PUSH_CODES.REMOTE_OP}: '${cmd.text}' syncs to an existing theme (--theme/-t or an --environment/-e), which may be the live one. Run '${cmd.cli} theme dev' without it so it uses a development theme. ${ASK}`,
    };
  }
  if (cmd.cli !== "hrv" || HRV_SYNC_ACTIONS[action] !== true) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.REMOTE_OP,
      reason: `${THEME_PUSH_CODES.REMOTE_OP}: '${cmd.text}' changes a theme on the shop, and a Leader worker may only sync its own bound Haravan theme (hrv theme push [--only <files>] --nodelete / hrv theme dev on a non-live theme) or push scoped files to one unpublished Shopify theme (shopify theme push --theme <id> --store <store> --only <files> --nodelete). ${ASK}`,
    };
  }
  if (cmd.flags.some((flag) => flag === "--force" || flag.startsWith("--force=") || isShortBundleWith(flag, "f"))) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_SCOPE,
      reason: `${THEME_PUSH_CODES.PUSH_SCOPE}: '${cmd.text}' uses --force, which overwrites changes made on the shop. ${ASK}`,
    };
  }
  if (cmd.dirChanged) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_UNVERIFIED,
      reason: `${THEME_PUSH_CODES.PUSH_UNVERIFIED}: '${cmd.text}' may not run in the folder that was checked: a cd, pushd, Set-Location or script ran before it in this line or earlier in this terminal, so the theme it targets cannot be verified. Run it alone from a new terminal whose folder is the theme folder.`,
    };
  }
  if (action === "push" && cmd.chained) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.COMPLEX,
      reason: `${THEME_PUSH_CODES.COMPLEX}: '${cmd.text}' is chained with another command on the same line (;, &&, ||, |, &, line break, or a redirect such as 2>&1). A push must be one plain command alone on its line, so what it runs after and before cannot hide a second push. ${ASK}`,
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
  if (action === "push" && !hasNodeleteFlag(cmd.flags)) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_NODELETE,
      reason: `${THEME_PUSH_CODES.PUSH_NODELETE}: '${cmd.text}' has no --nodelete, so hrv would delete every file on theme ${boundThemeId} that this folder does not hold (snippets and assets other apps installed included). Add --nodelete and run it again: hrv theme push [--only <files>] --nodelete.`,
    };
  }
  if (action === "push" && pushSendsSettingsUnnamed(cmd.text)) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_SETTINGS_DATA,
      reason: `${THEME_PUSH_CODES.PUSH_SETTINGS_DATA}: '${cmd.text}' would also push ${SETTINGS_DATA_KEY}, and hrv does not compare that file with the shop (the admin rewrites it whenever the merchant saves), so it would overwrite settings saved there. Add --ignore ${SETTINGS_DATA_KEY} (or -x ${SETTINGS_DATA_KEY}), or name the files you changed with --only. To push that file itself: run hrv theme fetch ${boundThemeId} --only ${SETTINGS_DATA_KEY}, edit the fetched copy, then hrv theme push --only ${SETTINGS_DATA_KEY} --nodelete.`,
    };
  }
  return { decision: "verify-draft", themeId: boundThemeId };
}

/**
 * Everything `shopify theme push` accepts that a worker may pass. `--theme` is the target (a
 * numeric id only), `--store` the shop, `--only`/`--nodelete` keep the push to named files;
 * `--ignore`, `--json`, `--path`, `--no-color` and `--verbose` change nothing on the shop.
 */
const SHOPIFY_PUSH_VALUE_FLAGS: Record<string, "theme" | "store" | "only" | "ignore" | "path"> = {
  "--theme": "theme",
  "-t": "theme",
  "--store": "store",
  "-s": "store",
  "--only": "only",
  "-o": "only",
  "--ignore": "ignore",
  "-x": "ignore",
  "--path": "path",
};
const SHOPIFY_PUSH_BOOLEAN_FLAGS: Record<string, "nodelete" | "other"> = {
  "--nodelete": "nodelete",
  "-n": "nodelete",
  "--json": "other",
  "-j": "other",
  "--no-color": "other",
  "--verbose": "other",
};
/** Flags that target the live theme, by long and short name. */
const SHOPIFY_PUSH_LIVE_FLAGS: Record<string, true> = { "--live": true, "-l": true, "--allow-live": true, "-a": true };

/** `x` or `x.myshopify.com`: the two store forms the CLI documents, as one plain token. */
const SHOPIFY_STORE_RE = /^[a-z0-9][a-z0-9-]*(?:\.myshopify\.com)?$/i;
/** A theme id without a leading zero. */
const SHOPIFY_THEME_ID_RE = /^[1-9]\d{0,19}$/;

/**
 * A worker's `shopify theme push`: allowed only as a scoped push (`--only`, `--nodelete`) to one
 * numeric theme of one named store, with no flag that picks, creates, publishes or forces a
 * theme. The flag list is an allow-list: anything not named in it is refused. Whether the
 * theme is not the live one is the caller's check (`verify-shopify-draft`).
 */
function planShopifyPush(cmd: ThemeCommand): ThemeCommandPlan {
  const block = (code: string, why: string): ThemeCommandPlan => ({
    decision: "block",
    code,
    reason: `${code}: '${cmd.text}' ${why} ${ASK}`,
  });
  const tokens = cmd.text.split(/\s+/).filter(Boolean);
  const themeAt = tokens.indexOf("theme", 1);
  if (themeAt === -1 || tokens[themeAt + 1] !== "push") {
    return block(
      THEME_PUSH_CODES.REMOTE_OP,
      "does not read as 'shopify theme push <flags>' (a flag or word sits between 'theme' and 'push').",
    );
  }
  const values: Record<"theme" | "store" | "only" | "ignore" | "path", string[]> = {
    theme: [],
    store: [],
    only: [],
    ignore: [],
    path: [],
  };
  let nodelete = false;
  const args = tokens.slice(themeAt + 2);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (!token.startsWith("-") || token === "-" || token === "--") {
      return block(THEME_PUSH_CODES.PUSH_SCOPE, `has the argument '${token}', which is not a flag value (theme push takes none).`);
    }
    let name: string;
    let inline: string | null = null;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      name = eq === -1 ? token : token.slice(0, eq);
      inline = eq === -1 ? null : token.slice(eq + 1);
    } else {
      name = token.slice(0, 2);
      const rest = token.slice(2);
      if (rest.length > 0) inline = rest.startsWith("=") ? rest.slice(1) : rest;
    }
    if (SHOPIFY_PUSH_LIVE_FLAGS[name] === true) {
      return block(THEME_PUSH_CODES.PUSH_LIVE, `uses ${name}, which targets or allows the shop's LIVE theme.`);
    }
    if (name === "--force" || name === "-f") {
      return block(THEME_PUSH_CODES.PUSH_SCOPE, `uses ${name}, which skips the confirmation of a folder that is not a theme.`);
    }
    const booleanKind = SHOPIFY_PUSH_BOOLEAN_FLAGS[name];
    if (booleanKind !== undefined) {
      if (inline !== null) return block(THEME_PUSH_CODES.REMOTE_OP, `writes ${token}: flags that take no value cannot be bundled or given one.`);
      if (booleanKind === "nodelete") nodelete = true;
      continue;
    }
    const valueKind = SHOPIFY_PUSH_VALUE_FLAGS[name];
    if (valueKind === undefined) {
      return block(
        THEME_PUSH_CODES.REMOTE_OP,
        `uses ${name}, which a worker may not pass to shopify theme push (allowed: --theme/-t <id>, --store/-s, --only/-o, --nodelete/-n, --ignore/-x, --json/-j, --path, --no-color, --verbose).`,
      );
    }
    const multiple = valueKind === "only" || valueKind === "ignore";
    const taken: string[] = [];
    if (inline !== null) {
      taken.push(inline);
    } else {
      // A value-less flag takes the next word; --only/--ignore take every word up to the next flag.
      while (i + 1 < args.length && !(args[i + 1] ?? "-").startsWith("-")) {
        i += 1;
        taken.push(args[i] ?? "");
        if (!multiple) break;
      }
    }
    if (taken.length === 0 || taken.some((value) => value.length === 0)) {
      return block(THEME_PUSH_CODES.PUSH_SCOPE, `has ${name} without a value.`);
    }
    values[valueKind].push(...taken);
  }
  if (values.only.length === 0) {
    return block(
      THEME_PUSH_CODES.PUSH_SCOPE,
      "pushes the whole theme. Push only the files you changed: shopify theme push --theme <id> --store <store> --only <file> [<file> ...] --nodelete.",
    );
  }
  if (!nodelete) {
    return block(THEME_PUSH_CODES.PUSH_SCOPE, "has no --nodelete, so it would delete remote files that are not in this folder.");
  }
  if (values.theme.length !== 1 || !SHOPIFY_THEME_ID_RE.test(values.theme[0] ?? "")) {
    return block(
      THEME_PUSH_CODES.PUSH_UNVERIFIED,
      "must name exactly one existing theme by its numeric id (--theme 123456789); a name or a missing --theme cannot be checked.",
    );
  }
  if (values.store.length !== 1 || !SHOPIFY_STORE_RE.test(values.store[0] ?? "")) {
    return block(
      THEME_PUSH_CODES.PUSH_UNVERIFIED,
      "must name exactly one store (--store <prefix> or --store <prefix>.myshopify.com) so the theme's role can be checked.",
    );
  }
  if (values.path.length > 1) {
    return block(THEME_PUSH_CODES.PUSH_SCOPE, "has more than one --path.");
  }
  if (cmd.dirChanged) {
    return block(
      THEME_PUSH_CODES.PUSH_UNVERIFIED,
      "may not run in the folder that was checked: a cd, pushd, Set-Location or script ran before it in this line or earlier in this terminal. Run it alone from a new terminal whose folder is the theme folder.",
    );
  }
  const [themeId] = values.theme;
  const [store] = values.store;
  if (themeId === undefined || store === undefined) return block(THEME_PUSH_CODES.PUSH_UNVERIFIED, "has no theme or store.");
  return { decision: "verify-shopify-draft", themeId, store };
}

/** `-f`, `-nf`, `-fo`: a single-dash flag or a bundle of short flags that includes `letter`. */
function isShortBundleWith(flag: string, letter: string): boolean {
  return /^-[a-z]+$/.test(flag) && flag.includes(letter);
}

/**
 * `--nodelete`, or a short bundle in which `n` comes before any value-taking letter (`-n`, `-jn`,
 * `-nb`, `-nx <pattern>`): the only spellings the CLI reads as "do not delete remote files". In
 * `-on` the `n` is the value of `-o` (`--only n`), and `--nodelete=<value>` is not a spelling the
 * CLI documents.
 */
function hasNodeleteFlag(flags: string[]): boolean {
  return flags.some((flag) => {
    if (flag === "--nodelete") return true;
    if (flag.startsWith("--") || !flag.startsWith("-")) return false;
    for (const letter of flag.slice(1)) {
      if (letter === "n") return true;
      if (letter !== "j" && letter !== "b") return false;
    }
    return false;
  });
}

const SETTINGS_DATA_KEY = "config/settings_data.json";

/** One glob (`*`, `**`, `?`) against a theme key; null for syntax this reader does not model (`{}`, `[]`, `!`, `()`). */
function globMatch(pattern: string, key: string): boolean | null {
  if (/[{}[\]!()]/.test(pattern)) return null;
  const body = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((piece) => piece.replace(/[.+^$|\\]/g, "\\$&").replace(/\?/g, "[^/]"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${body}$`).test(key);
}

/**
 * True when an `hrv theme push` line would send `config/settings_data.json` without that file being
 * named: no file selection at all, or a selection some pattern of which could match it, and no
 * `--ignore`/`-x` pattern that certainly excludes it. Files are named by `--only`/`-o`, by a
 * positional comma list (`hrv theme push a.liquid,b.liquid`; a numeric positional is no file), and
 * excluded by `--ignore`/`-x`. Naming the file exactly is the deliberate way to push it.
 */
function pushSendsSettingsUnnamed(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  const named: string[] = [];
  const ignore: string[] = [];
  const clean = (value: string): string => value.replace(/^["']+|["']+$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
  let into: string[] | null = null;
  for (const token of tokens.slice(tokens.findIndex((word) => word.toLowerCase() === "push") + 1)) {
    if (!token.startsWith("-") || token === "-") {
      if (into !== null) into.push(clean(token));
      else for (const file of token.split(",")) if (file.length > 0 && !/^\d+$/.test(file)) named.push(clean(file));
      continue;
    }
    into = null;
    const long = /^--(only|ignore)(?:=(.*))?$/i.exec(token);
    if (long !== null) {
      into = long[1]?.toLowerCase() === "only" ? named : ignore;
      if (long[2] !== undefined && long[2].length > 0) into.push(clean(long[2]));
      continue;
    }
    if (token.startsWith("--")) continue;
    for (let i = 1; i < token.length; i += 1) {
      const letter = token[i]?.toLowerCase();
      if (letter !== "o" && letter !== "x") continue;
      into = letter === "o" ? named : ignore;
      const rest = token.slice(i + 1).replace(/^=/, "");
      if (rest.length > 0) into.push(clean(rest));
      break;
    }
  }
  if (ignore.some((pattern) => pattern === SETTINGS_DATA_KEY || globMatch(pattern, SETTINGS_DATA_KEY) === true)) return false;
  return named.length === 0 || named.some((pattern) => pattern !== SETTINGS_DATA_KEY && globMatch(pattern, SETTINGS_DATA_KEY) !== false);
}

const CLI_WORD = String.raw`(?:hrv|haravan-cli|haravan|shopify|sapo)(?:\.(?:cmd|exe|ps1|bat|js|mjs|cjs))?`;
/**
 * After a CLI word: not part of a longer name (`hrv.liquid`, `hrv-x`) and not a folder
 * (`shopify/theme`, `Shopify\Rebel`). A backslash that is only a source-code escape
 * (`'haravan\n theme'`) still ends the word.
 */
const CLI_END = String.raw`(?![a-z0-9_-]|\.[a-z0-9]|/|\\(?![nrt](?![a-z0-9_])))`;
const CLI_START = String.raw`(?:^|[^a-z0-9_.-])`;

/** `theme` as a word of its own: not `theme.liquid`, `themes`, `layout/theme`, `--theme-x`. */
const THEME_WORD_RE = /(?:^|[^a-z0-9_\\/.-])theme(?![a-z0-9_-]|\.[a-z0-9]|[\\/])/gi;
const CLI_OCCURRENCE_RE = new RegExp(String.raw`${CLI_START}(${CLI_WORD})${CLI_END}`, "gi");

function snippetOf(text: string, from: number, to: number): string {
  return text.slice(from, to).replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * The first place where a theme CLI word is followed later by `theme`, across lines, quotes, list
 * and call syntax; null when there is none. `hrv.liquid` is a file, not the CLI; `hrv.cmd` /
 * `hrv.js` / `haravan-cli` are. A path is not a mention: `shopify/theme`, `layout/theme.liquid`,
 * `...\Shopify\Rebel\layout\theme.liquid`. A CLI word reached through a path is the CLI only when
 * `theme` follows in the same statement, whatever its case: `./node_modules/.bin/haravan theme`
 * and `C:/Users/x/AppData/Roaming/npm/HRV theme push` run the CLI, while a folder named after it
 * (`cd ".../S2 Corporate/Haravan" && rg ...`) is a statement of its own.
 */
function themeMentionSnippet(text: string): string | null {
  const themeAt: number[] = [];
  for (const match of text.matchAll(THEME_WORD_RE)) themeAt.push((match.index ?? 0) + match[0].length - "theme".length);
  if (themeAt.length === 0) return null;
  for (const match of text.matchAll(CLI_OCCURRENCE_RE)) {
    const word = match[1] ?? "";
    const end = (match.index ?? 0) + match[0].length;
    const before = match[0].length > word.length ? match[0].charAt(0) : "";
    const next = themeAt.find((at) => at >= end);
    if (next === undefined) continue;
    const pathQualified = before === "/" || before === "\\";
    if (pathQualified && /[;&|\r\n]/.test(text.slice(end, next))) continue;
    return snippetOf(text, end - word.length, next + "theme".length);
  }
  return null;
}

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
 *
 * The keyword has to sit outside quotes: `function` or `eval` inside an `rg` pattern
 * (`rg -n "function create" src/haravan/x.ts`) renames nothing. The keyword's own line is
 * scanned up to the next `;`, `&` or `|`, and any CLI word on it counts, a capitalised path word
 * included (`function h { C:/tools/HRV @args }`): a line that defines a wrapper names its target on purpose.
 */
const ALIAS_KEYWORD_RE = /(?:^|[\s;&|(])(set-alias|new-alias|sal|alias|doskey|new-variable|set-variable|function|iex|invoke-expression|eval)(?![a-z0-9_-])/gi;
const ALIAS_TARGET_RE = new RegExp(String.raw`(?:^|[\s"'=\\/])${CLI_WORD}${CLI_END}`, "i");
const CLI_ASSIGN_RE = new RegExp(
  String.raw`(?:^|[;&|(]\s*|\bset\s+)(?:(?:const|let|var|export)\s+)?[$%]?[\w:.-]+%?\s*=\s*(?:[rbfu]{1,2}(?=["']))?["']?((?:[^\s;&|"']*[\\/])?)(${CLI_WORD})["']?(?=[\s;&|)]|$)`,
  "gim",
);

/**
 * A folder named after a CLI, not the CLI: `E:/Work/themes/devs2/S2 Corporate/Haravan`. The CLIs
 * are lowercase commands (`hrv`, `haravan`, `shopify`, `sapo`) and `hrv.cmd` / `haravan.js` are the
 * CLI wherever they sit, while the theme and app folders of a workspace are named `Haravan`,
 * `Shopify`, `Sapo`. `hrv` is the Haravan CLI's only bin and no workspace folder carries that
 * name, so it is the CLI in any case. `before` is the character just left of the word.
 */
function isFolderName(name: string, before: string): boolean {
  return (
    (before === "/" || before === "\\") &&
    /^[A-Z]/.test(name) &&
    !/^hrv$/i.test(name) &&
    !/\.(?:cmd|exe|ps1|bat|js|mjs|cjs)$/i.test(name)
  );
}

/** Whether `index` sits inside a quoted span of its own line (`"`, `'` or a backtick opened earlier on that line). */
function insideQuotes(text: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = text.lastIndexOf("\n", index - 1) + 1; i < index; i += 1) {
    const ch = text.charAt(i);
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    }
  }
  return quote !== null;
}

function aliasSnippet(text: string): string | null {
  for (const keyword of text.matchAll(ALIAS_KEYWORD_RE)) {
    const start = (keyword.index ?? 0) + keyword[0].length - (keyword[1] ?? "").length;
    if (insideQuotes(text, start)) continue;
    const tail = text.slice(start).split(/[\r\n;&|]/, 1)[0] ?? "";
    if (ALIAS_TARGET_RE.test(tail)) return snippetOf(text, start, start + tail.length);
  }
  return null;
}

function assignSnippet(text: string): string | null {
  for (const match of text.matchAll(CLI_ASSIGN_RE)) {
    const prefix = match[1] ?? "";
    if (prefix.length > 0 && isFolderName(match[2] ?? "", prefix.charAt(prefix.length - 1))) continue;
    return snippetOf(match[0], 0, match[0].length);
  }
  return null;
}

/**
 * A segment whose command is the CLI and whose next word comes from a variable, call, block or
 * expansion (`hrv $c publish`), or whose command is a variable that is followed by `theme`
 * (`& $h theme push`, `$h theme push`): the variable may hold the CLI under any name.
 */
function hasIndirectCliArgument(text: string): boolean {
  for (const segment of topLevelSegments(text)) {
    const tokens = segment.trim().split(/\s+/);
    if (cliOf(tokens[0] ?? "") !== null) {
      const next = tokens.slice(1).find((token) => !token.startsWith("-"));
      if (next !== undefined && /^[$%@`{(]/.test(next)) return true;
      continue;
    }
    const [command, ...args] = tokens.filter((token, index) => index > 0 || !/^(?:&|call|\.)$/i.test(token));
    if (command === undefined || !/^["']?[$%]\{?[\w:.-]+\}?%?["']?$/.test(command)) continue;
    if (args.some((token) => /^["']?theme["']?$/i.test(token))) return true;
  }
  return false;
}

function unquoted(text: string): string {
  return text.replace(/["'`^]/g, "");
}

/** `hrv api put|post|delete|patch ...` or `hrv rollback-last-push`, spelled plainly or with quote-splitting. */
function remoteWriteSnippet(text: string): string | null {
  const match = REMOTE_WRITE_RE.exec(text) ?? REMOTE_WRITE_RE.exec(unquoted(text));
  return match === null ? null : match[0].replace(/\s+/g, " ").trim().slice(0, 120);
}

function indirectionSnippet(text: string): string | null {
  const plain = aliasSnippet(text) ?? assignSnippet(text);
  if (plain !== null) return plain;
  const bare = unquoted(text);
  const stripped = aliasSnippet(bare) ?? assignSnippet(bare);
  if (stripped !== null) return stripped;
  return hasIndirectCliArgument(text) || hasIndirectCliArgument(bare) ? "the CLI followed by a variable, call or expansion" : null;
}

/**
 * The text that makes `text` a use of the theme CLI the gate has to judge: `hrv|haravan|
 * haravan-cli|shopify ... theme`, a shop write through `hrv api` / `hrv rollback-last-push`, or an
 * alias, variable or `iex` that hides the CLI word; null when there is none. Tested on the raw
 * text and on a copy with quoting characters removed, so `h""rv theme push` and `h^rv theme push`
 * are seen. Over-detection is intended: a false hit costs a question to the user, a miss is a
 * changed shop. A folder named after a CLI (`.../Haravan`) and a keyword quoted inside a search
 * pattern are not uses of it.
 */
export function themeCliEvidence(text: string): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  return themeMentionSnippet(text) ?? themeMentionSnippet(unquoted(text)) ?? remoteWriteSnippet(text) ?? indirectionSnippet(text);
}

/** True when `themeCliEvidence` finds a use of the theme CLI in `text`. */
export function mentionsThemeCli(text: string): boolean {
  return themeCliEvidence(text) !== null;
}

/**
 * Signs that an `eval` cell starts a process: `subprocess`, `os.system`, `child_process`, `Bun.$`,
 * `spawn(`, `exec(`, or an IPython `!cmd` / `%cmd` line.
 */
export const SUBPROCESS_RE = /subprocess|os\.(?:system|popen|exec|spawn)|child_process|Bun\.(?:\$|spawn)|Deno\.(?:run|Command)|shelljs|\$`|\bspawn\w*\s*\(|\bexec\w*\s*\(|(?:^|\n)\s*[!%]/;

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
  if (remoteWriteSnippet(text) !== null) {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.REMOTE_OP,
      command,
      reason: `${THEME_PUSH_CODES.REMOTE_OP}: '${command}' writes to the shop outside the draft-theme sync (hrv api put/post/delete/patch sends the request as given, hrv rollback-last-push restores remote files without a draft check). A Leader worker may only sync its own bound draft Haravan theme (hrv theme push --only <files> / hrv theme dev). ${ASK}`,
    };
  }
  if (indirectionSnippet(text) !== null) {
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
 * A CLI word anywhere in an eval cell that is not a workspace folder: `hrv`, `HRV`, `C:/…/npm/HRV`,
 * `shopify`, however the path to it is built (`pathlib.Path(".../HRV")`, `os.path.join(npm, "HRV")`,
 * `cli = r".../HRV"`). Unlike a shell line, a cell has no "same statement" to tie the word to `theme`,
 * so only a folder named `Haravan` or `Sapo` (the theme and app folders; `shopify` and `hrv` are bins
 * and `hrv` is the Haravan CLI's only one) is set aside.
 */
function namesCliWordInCell(text: string): boolean {
  for (const match of text.matchAll(CLI_OCCURRENCE_RE)) {
    const word = match[1] ?? "";
    const before = match[0].length > word.length ? match[0].charAt(0) : "";
    if ((before === "/" || before === "\\") && /^(?:Haravan|Sapo)$/.test(word)) continue;
    return true;
  }
  return false;
}

/**
 * An `eval` cell (Python or JS) reaches the theme CLI only by starting a process (`subprocess`,
 * `os.system`, `!cmd`, `Bun.$`, `$\``, `child_process`), where argument lists and working-directory
 * changes cannot be read back reliably. A worker runs theme commands through the bash tool only,
 * so an eval cell that starts a process and names a CLI word is refused - read actions included.
 * A cell that only reads a file, prints text or searches for these words starts nothing and passes.
 */
export function planEvalThemeCode(code: string): ThemeCommandPlan {
  if (typeof code !== "string" || !SUBPROCESS_RE.test(code)) return { decision: "allow" };
  if (!namesCliWordInCell(code) && !namesCliWordInCell(unquoted(code)) && !mentionsThemeCli(code)) return { decision: "allow" };
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

/** Parsed `shopify theme list --json`: the array of themes; null when the output holds none. */
export function parseShopifyThemeList(output: string): { id: string; role: string }[] | null {
  const trimmed = output.trim();
  const end = trimmed.lastIndexOf("]");
  if (end === -1) return null;
  // The CLI may print a notice (a version update, a login line) before the JSON.
  const starts = [...trimmed.matchAll(/^\[/gm)].map((match) => match.index ?? 0);
  for (const start of starts) {
    if (start > end) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const themes: { id: string; role: string }[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== "object" || !("id" in item) || !("role" in item)) return null;
      const { id, role } = item;
      if ((typeof id !== "number" && typeof id !== "string") || typeof role !== "string") return null;
      themes.push({ id: String(id).trim(), role: role.trim().toLowerCase() });
    }
    return themes;
  }
  return null;
}

/** The refusal for a `verify-shopify-draft` plan whose `shopify theme list` answer did not clear it. */
export function shopifyDraftVerdict(
  cmd: ThemeCommand,
  plan: { themeId: string; store: string },
  themes: { id: string; role: string }[] | null,
  detail: string,
): { decision: "allow" } | { decision: "block"; code: string; reason: string } {
  const unverified = (seen: string): { decision: "block"; code: string; reason: string } => ({
    decision: "block",
    code: THEME_PUSH_CODES.PUSH_UNVERIFIED,
    reason: `${THEME_PUSH_CODES.PUSH_UNVERIFIED}: could not prove theme ${plan.themeId} of ${plan.store} is an unpublished theme before '${cmd.text}' (shopify theme list --id ${plan.themeId} --store ${plan.store} --json: ${seen}). ${ASK}`,
  });
  if (themes === null) return unverified(detail);
  const matches = themes.filter((theme) => theme.id === plan.themeId);
  if (matches.length !== 1) return unverified(`it reported ${matches.length} themes with that id`);
  const role = matches[0]?.role ?? "";
  if (role === "live" || role === "main") {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_LIVE,
      reason: `${THEME_PUSH_CODES.PUSH_LIVE}: theme ${plan.themeId} is the shop's LIVE theme (role ${role}), and '${cmd.text}' would change what customers see. ${ASK}`,
    };
  }
  if (role === "unpublished" || role === "development") return { decision: "allow" };
  return unverified(`its role is '${role}'`);
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
      reason: `${THEME_PUSH_CODES.PUSH_UNVERIFIED}: could not prove this workspace is logged in to its bound theme ${boundThemeId} before '${cmd.text}' (hrv theme info -j: ${seen}). ${ASK}`,
    };
  }
  if (info.role === "main" && cmd.action === "dev") {
    return {
      decision: "block",
      code: THEME_PUSH_CODES.PUSH_LIVE,
      reason: `${THEME_PUSH_CODES.PUSH_LIVE}: theme ${boundThemeId} is the shop's LIVE theme (role main), and '${cmd.text}' keeps writing local edits to it as they happen. Push the files you changed instead. ${ASK}`,
    };
  }
  return { decision: "allow" };
}
