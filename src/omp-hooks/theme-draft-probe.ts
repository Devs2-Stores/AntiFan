/**
 * The decision "may this shell line run a theme command from a Leader's worker?", shared by
 * everything that carries a worker's keystrokes to a shell: the edit-guard hook (the bash
 * tool) and the Manager (`terminal.write`). One module owns classify -> find the binding ->
 * `hrv theme info -j` -> verdict, so both entry points apply the same classification.
 *
 * It decides only; the caller decides whether the caller is a worker, and writes its own
 * audit rows. Free of Electron and Manager imports on purpose: the hook bundle ships it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { findBindingRoot, resolveShopIdentity } from "./theme-paths";
import {
  classifyThemeLine,
  draftVerdict,
  parseShopifyThemeList,
  parseThemeInfo,
  planThemeCommand,
  shopifyDraftVerdict,
  THEME_PUSH_CODES,
} from "./theme-push-policy";

/** Shell command prefix that runs the Haravan CLI; tests and non-PATH installs override it. */
export const HRV_COMMAND_ENV = "ANTIFAN_HRV_COMMAND";
/** Shell command prefix that runs the Shopify CLI; tests and non-PATH installs override it. */
export const SHOPIFY_COMMAND_ENV = "ANTIFAN_SHOPIFY_COMMAND";

export interface HrvRun {
  /** Combined stdout+stderr (capped), or null when the CLI never ran to completion. */
  output: string | null;
  exitCode: number | null;
  /** Why `output` is null: spawn error or timeout. */
  failure: string;
}

/**
 * The text of a thrown value, without letting the value decide whether the caller can
 * report. A null-prototype object, a throwing `message` getter or a hostile `toString`
 * all reach here from the same place a refusal is being built.
 */
export function describeError(err: unknown): string {
  try {
    if (err instanceof Error && typeof err.message === "string") return err.message;
  } catch {
    /* a throwing message getter falls through to the coercion below */
  }
  try {
    return String(err);
  } catch {
    try {
      return Object.prototype.toString.call(err);
    } catch {
      return "unprintable error";
    }
  }
}

/**
 * Stops the probe and everything it started. `shell: true` runs the CLI under `cmd.exe` /
 * `sh`; `child.kill()` ends only that shell on Windows and leaves `hrv` (node) running past
 * the timeout, so the tree is taken down instead: `taskkill /T /F` on Windows, the process
 * group elsewhere (the probe is spawned as a group leader there). The plain kill is the
 * fallback when the tree kill itself cannot run.
 */
function killProbeTree(child: ChildProcess): void {
  const pid = child.pid;
  const plainKill = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  if (pid === undefined) return plainKill();
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", plainKill);
      killer.on("close", (code) => {
        if (code !== 0) plainKill();
      });
    } catch {
      plainKill();
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    plainKill();
  }
}

/**
 * `<cli> <args>` in `cwd`, where `<cli>` is the value of `envName` or `fallback`. One shell line
 * (a `.cmd` shim on Windows needs the shell), so callers must interpolate only values they
 * validated as plain tokens.
 */
function runCli(envName: string, fallback: string, cwd: string, args: string, timeoutMs: number): Promise<HrvRun> {
  const { promise, resolve } = Promise.withResolvers<HrvRun>();
  const command = (process.env[envName] ?? "").trim() || fallback;
  let output = "";
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = (run: HrvRun) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(run);
  };
  try {
    const child = spawn(`${command} ${args}`, {
      cwd,
      shell: true,
      windowsHide: true,
      // A group leader off Windows, so the timeout can end the whole group.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => {
      if (output.length < 16_384) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (err) => finish({ output: null, exitCode: null, failure: describeError(err) }));
    child.on("close", (code) => finish({ output, exitCode: code, failure: "" }));
    timer = setTimeout(() => {
      killProbeTree(child);
      finish({ output: null, exitCode: null, failure: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
  } catch (err) {
    finish({ output: null, exitCode: null, failure: describeError(err) });
  }
  return promise;
}

/** `hrv <args>` in `cwd`; see `runCli`. */
export function runHrv(cwd: string, args: string, timeoutMs: number): Promise<HrvRun> {
  return runCli(HRV_COMMAND_ENV, "hrv", cwd, args, timeoutMs);
}

/** `shopify <args>` in `cwd`; see `runCli`. */
export function runShopify(cwd: string, args: string, timeoutMs: number): Promise<HrvRun> {
  return runCli(SHOPIFY_COMMAND_ENV, "shopify", cwd, args, timeoutMs);
}

/**
 * Environment variables the Shopify CLI reads in place of the flags a worker may not pass to
 * `theme push` (live, publish, create, development, force, legacy upload, environment, token). A
 * line that looks scoped on the command line would still act on them, so one set in this process
 * stops the push.
 */
const SHOPIFY_PUSH_ENV_OVERRIDES = [
  "SHOPIFY_FLAG_LIVE",
  "SHOPIFY_FLAG_ALLOW_LIVE",
  "SHOPIFY_FLAG_PUBLISH",
  "SHOPIFY_FLAG_UNPUBLISHED",
  "SHOPIFY_FLAG_DEVELOPMENT",
  "SHOPIFY_FLAG_FORCE",
  "SHOPIFY_FLAG_STABLE",
  "SHOPIFY_FLAG_ENVIRONMENT",
  "SHOPIFY_CLI_THEME_TOKEN",
];

export function lastOutputLine(output: string): string {
  const lines = output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\(node:\d+\)|^\(Use `node/.test(line));
  return lines[lines.length - 1] ?? "(no output)";
}

export type ThemeGateOutcome =
  /** The line names no theme CLI. */
  | { decision: "pass" }
  /** Every theme command in the line may run; `verified` lists the sync commands the draft check (`hrv theme info -j` / `shopify theme list`) cleared. */
  | { decision: "allow"; verified: string[] }
  | { decision: "block"; code: string; reason: string; command: string };

/**
 * Gate one shell line of a worker. `cwd` is the folder the line will run in;
 * `assumeDirChanged` says the shell was moved by an earlier line, so the binding found
 * from `cwd` cannot be trusted and any sync action is unverifiable. `timeoutMs` bounds each
 * draft probe (`hrv theme info -j`, `shopify theme list`); a probe that cannot answer in time is a refusal, never a pass.
 */
export async function gateThemeLine(o: {
  text: string;
  cwd: string;
  timeoutMs: number;
  assumeDirChanged?: boolean;
}): Promise<ThemeGateOutcome> {
  const line = classifyThemeLine(o.text, { assumeDirChanged: o.assumeDirChanged });
  if (line.decision === "none") return { decision: "pass" };
  if (line.decision === "block") {
    return { decision: "block", code: line.code, reason: line.reason, command: line.command };
  }
  const bindingRoot = findBindingRoot(o.cwd);
  const boundThemeId = bindingRoot === null ? null : (resolveShopIdentity(bindingRoot)?.themeId ?? null);
  const verified: string[] = [];
  for (const cmd of line.commands) {
    const plan = planThemeCommand(cmd, boundThemeId);
    let verdict: { decision: "allow" } | { decision: "block"; code: string; reason: string };
    if (plan.decision === "verify-draft" && bindingRoot !== null) {
      const run = await runHrv(bindingRoot, "theme info -j", o.timeoutMs);
      const info = run.output === null ? null : parseThemeInfo(run.output);
      const detail = run.output === null ? run.failure : lastOutputLine(run.output);
      verdict = draftVerdict(cmd, plan.themeId, info, detail);
      if (verdict.decision === "allow") verified.push(cmd.text);
    } else if (plan.decision === "verify-draft") {
      verdict = draftVerdict(cmd, plan.themeId, null, "no binding folder");
    } else if (plan.decision === "verify-shopify-draft") {
      const override = SHOPIFY_PUSH_ENV_OVERRIDES.find((name) => (process.env[name] ?? "").trim().length > 0);
      if (override !== undefined) {
        verdict = {
          decision: "block",
          code: THEME_PUSH_CODES.PUSH_UNVERIFIED,
          reason: `${THEME_PUSH_CODES.PUSH_UNVERIFIED}: ${override} is set in the environment, and the Shopify CLI would apply it to '${cmd.text}' in place of a flag the push rules check. Stop and report STATUS: NEEDS_INPUT to the Leader with the exact command; only the user can approve it.`,
        };
      } else {
        const run = await runShopify(o.cwd, `theme list --id ${plan.themeId} --store ${plan.store} --json`, o.timeoutMs);
        const info = run.output === null || run.exitCode !== 0 ? null : parseShopifyThemeList(run.output);
        const detail =
          run.output === null ? run.failure : run.exitCode !== 0 ? `exit ${run.exitCode ?? "null"}: ${lastOutputLine(run.output)}` : lastOutputLine(run.output);
        verdict = shopifyDraftVerdict(cmd, plan, info, detail);
        if (verdict.decision === "allow") verified.push(cmd.text);
      }
    } else {
      verdict = plan;
    }
    if (verdict.decision === "block") {
      return { decision: "block", code: verdict.code, reason: verdict.reason, command: cmd.text };
    }
  }
  return { decision: "allow", verified };
}
