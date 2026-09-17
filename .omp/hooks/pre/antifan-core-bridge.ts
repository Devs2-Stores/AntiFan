/**
 * antifan-core-bridge.ts — AntiFan Super Core context bridge (pre hook).
 *
 * Seeds one Core context pack per user prompt into the agent turn, keeps the
 * pack identity alive across compaction, and fails OPEN when Core is
 * unavailable: the session continues and exactly one BRIDGE_CONTEXT_FAILED
 * event is emitted per session.
 *
 * Placement contract (verified): this file MUST live under .omp/hooks/pre/ —
 * factories placed directly in .omp/hooks/ are silently not discovered.
 *
 * Transport: `node scripts/antifan-core.cjs <cmd> '<json>'`. The CLI already
 * prints {"available":false,"reason":...} on stderr and exits 2 when Core
 * cannot load; that is the fail-open signal — no other probe is invented.
 *
 *   session_start        reset per-session bridge state (dedupe window)
 *   before_agent_start   spawn `pack`, return ONE message carrying the pack
 *   context              budget lever: drop stale/duplicate pack injections
 *   session.compacting   preserveData {packId, coreRelease, taskHash}
 *   tool_call            R6 policy: refuse receipt-required actions when Core
 *                        is unavailable; advisory calls continue
 *   turn_end             one BRIDGE_TURN_END row per completed turn (deduped)
 *   agent_end            one BRIDGE_AGENT_END row per settled run (willContinue
 *                        mid-run events are skipped)
 *   session_shutdown     one BRIDGE_SESSION_SHUTDOWN row + pack identity release
 *
 * Evidence: every bridge event is appended as a session entry via
 * pi.appendEntry('antifan-core-bridge', ...) AND written as one JSONL line to
 * <projectRoot>/.canary/core-bridge/events.jsonl (override:
 * ANTIFAN_CORE_BRIDGE_LOG; 'off' disables the file channel).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Local structural types (the runtime supplies these objects; declared here so
// this file stays erasable-syntax-only and importable by plain Node tests).
// ---------------------------------------------------------------------------

interface BridgeLogger {
	info?(message: string): void;
	warn?(message: string): void;
	error?(message: string): void;
}

interface BridgeContext {
	cwd?: string;
	sessionManager?: { getSessionId?(): string | undefined };
	ui?: { notify?(message: string, level?: string): void };
}

interface BridgeMessagePayload {
	customType: string;
	content: string;
	display: boolean;
	details?: Record<string, unknown>;
	attribution?: "user" | "agent";
}

interface BridgeAPI {
	logger?: BridgeLogger;
	on?(event: string, handler: (event: unknown, ctx: BridgeContext) => unknown): void;
	sendMessage?(message: BridgeMessagePayload, options?: Record<string, unknown>): void;
	appendEntry?<T>(customType: string, data?: T): void;
}

interface CorePack {
	packId: string;
	task: string;
	platform: string | null;
	release: { releaseId?: string; createdAt?: string } | null;
	permissionScope: string;
	claims: Array<Record<string, unknown>>;
	conflicts: Array<Record<string, unknown>>;
	unknowns: Array<Record<string, unknown>>;
	generatedAt: string;
}

interface BridgeState {
	coreStatus: "unknown" | "available" | "unavailable";
	unavailableReason: string | null;
	/** When `coreStatus` was last decided, so an unavailable verdict can expire. */
	coreStatusAt: number;
	pack: CorePack | null;
	packId: string | null;
	coreRelease: string | null;
	taskHash: string | null;
	projectRoot: string | null;
	failureEmitted: boolean;
	/** Monotonic count of completed turns, for lifecycle telemetry. */
	turnsCompleted: number;
	/** Dedupe keys for re-entered lifecycle events (same message → same key). */
	lastTurnKey: string | null;
	lastAgentEndKey: string | null;
	shutdownEmitted: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** customType of the injected pack message (and of the failure label). */
const BRIDGE_MESSAGE_TYPE = "antifan-core-bridge";
/** Session-entry customType + JSONL event channel. */
const BRIDGE_ENTRY_TYPE = "antifan-core-bridge";
/** The single failure event name — emitted at most once per session. */
const BRIDGE_CONTEXT_FAILED = "BRIDGE_CONTEXT_FAILED";
/** Refusal code for receipt-required actions while Core is unavailable. */
const REFUSAL_CODE = "REFUSED_CORE_UNAVAILABLE";

const DEFAULT_TIMEOUT_MS = 8_000;
/**
 * How long an "unavailable" verdict is trusted before Core is probed again.
 *
 * Without expiry one transient failure — a timeout while super-core cold-starts
 * against a large WAL database — refused every receipt-required action for the
 * rest of the session, blaming Core long after it recovered. A false
 * "unavailable" is indistinguishable from a real one at the refusal site.
 */
const CORE_STATUS_RETRY_MS = 30_000;
const PROBE_TIMEOUT_MS = 4_000;
const MAX_PACK_CHARS = 12_000;
const MAX_STATEMENT_CHARS = 300;
const MAX_CLAIMS_IN_MESSAGE = 15;
const MAX_OUTPUT_CHARS = 16_000_000;

/**
 * Actions that bind a decision to evidence — every mutating entry in the
 * CORE_DISPATCH table of scripts/antifan-omp-mcp.cjs (the rows whose third
 * element is `true`; invokeCore() refuses them with CORE_UNAVAILABLE when the
 * store is down). These must be REFUSED by the bridge when Core is
 * unavailable, never silently downgraded to advisory.
 *
 * Keys are canonicalCoreName() output: the advertised name with every `_` and
 * `.` folded to `.` (core.record_experience_node → core.record.experience.node).
 * The set is enumerated by hand because the compiled hook cannot require()
 * the .cjs proxy without loading its ws/MCP-server machinery;
 * test/unit/bridge-receipt-coverage.test.mjs derives the mutating set from
 * CORE_DISPATCH itself and fails if this table drifts from it.
 */
const RECEIPT_REQUIRED_CANONICAL: Record<string, true> = {
	"core.recommend": true,
	"core.receipt": true,
	"core.receipt.v2": true,
	"core.adjudicate": true,
	"core.ingest.outcome": true,
	"core.invalidate": true,
	"core.revoke": true,
	"core.snapshot": true,
	"core.rollback": true,
	"core.record.experience.node": true,
	"core.record.experience.edge": true,
	"core.record.anti.pattern": true,
	"core.record.workaround": true,
	"core.record.fix.pattern": true,
	"core.corpus.audit": true,
	"core.check.phase.gate": true,
	"core.resolve.conflict": true,
	"core.record.regression": true,
	"core.replay.regression": true,
	"core.record.observation": true,
	"core.record.principle": true,
	"core.record.hidden.requirement": true,
	"core.record.commercial": true,
	"core.record.tool": true,
	"core.record.archetype": true,
	"core.record.platform.semantic": true,
	"core.record.practice.parity": true,
	"core.record.skill.version": true,
};

/**
 * CLI subcommands of scripts/antifan-core.cjs that are receipt-required: the
 * CLI spelling of every mutating CORE_DISPATCH entry (same source of truth
 * and same drift guard as the canonical table above), plus `import` — a
 * mutating command (importScout writes claims/cases) with no CORE_DISPATCH
 * row, so it is listed here individually.
 */
const RECEIPT_REQUIRED_CLI_COMMANDS: Record<string, true> = {
	recommend: true,
	receipt: true,
	"receipt-v2": true,
	adjudicate: true,
	outcome: true,
	invalidate: true,
	revoke: true,
	snapshot: true,
	rollback: true,
	"exp-node": true,
	"exp-edge": true,
	"anti-pattern": true,
	workaround: true,
	"fix-pattern": true,
	audit: true,
	gate: true,
	"resolve-conflict": true,
	regression: true,
	replay: true,
	observe: true,
	principle: true,
	"hidden-req": true,
	commercial: true,
	tool: true,
	archetype: true,
	"platform-semantic": true,
	"practice-parity": true,
	"skill-version": true,
	"import": true,
};

// ---------------------------------------------------------------------------
// Path / identity resolution
// ---------------------------------------------------------------------------

/**
 * Project identity is the directory that owns scripts/antifan-core.cjs — found
 * by walking up from the session cwd, never the blind cwd itself. A foreign
 * project (no CLI ancestor) resolves to null and the bridge fails open.
 */
function resolveProjectRoot(cwd: string | undefined): string | null {
	const override = process.env.ANTIFAN_PROJECT_ROOT;
	if (override && override.trim().length > 0) {
		return path.resolve(override.trim());
	}
	let dir = path.resolve(cwd ?? process.cwd());
	for (;;) {
		if (fs.existsSync(path.join(dir, "scripts", "antifan-core.cjs"))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function resolveCliPath(projectRoot: string | null): string | null {
	const override = process.env.ANTIFAN_CORE_CLI;
	if (override && override.trim().length > 0) {
		return path.resolve(override.trim());
	}
	if (!projectRoot) return null;
	const cli = path.join(projectRoot, "scripts", "antifan-core.cjs");
	return fs.existsSync(cli) ? cli : null;
}

function resolveLogPath(projectRoot: string | null): string | null {
	const override = process.env.ANTIFAN_CORE_BRIDGE_LOG;
	if (override !== undefined) {
		if (override.trim().length === 0 || override.trim().toLowerCase() === "off") {
			return null;
		}
		return path.isAbsolute(override) ? override : path.resolve(override.trim());
	}
	if (!projectRoot) return null;
	return path.join(projectRoot, ".canary", "core-bridge", "events.jsonl");
}

function envInt(name: string, fallback: number, max: number): number {
	const raw = process.env[name];
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/** taskHash binds the pack to (normalized task text, project identity). */
function computeTaskHash(task: string, projectRoot: string): string {
	const normalized = task.replace(/\s+/g, " ").trim();
	return createHash("sha256").update(`${projectRoot}\n${normalized}`, "utf8").digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// CLI transport — hard timeout, fail-open result, never throws
// ---------------------------------------------------------------------------

interface CliResult {
	ok: boolean;
	pack?: CorePack;
	reason?: string;
}

function isCorePack(value: unknown): value is CorePack {
	return (
		typeof value === "object" &&
		value !== null &&
		"packId" in value &&
		typeof value.packId === "string" &&
		value.packId.length > 0 &&
		"claims" in value &&
		Array.isArray(value.claims)
	);
}

/**
 * Resolves a runtime that can execute the Core CLI as a script argument.
 *
 * `process.execPath` is only a Node runtime when the host is Node. The OMP
 * binary is a Bun single-file build, so inside a hook `process.execPath` is the
 * host itself — spawning it with `[scriptPath, ...args]` treats the script path
 * as a positional message, prints TUI teardown escapes and exits non-zero.
 * Every session then silently took the fail-open path and no pack was ever
 * injected. Under Bun, resolve a real Node from PATH instead.
 *
 * `ANTIFAN_NODE` overrides the resolution for hosts where Node is not on PATH.
 */
function resolveNodeRuntime(): string {
	const override = process.env.ANTIFAN_NODE;
	if (typeof override === "string" && override.trim().length > 0) return override.trim();
	if (process.versions?.bun) return process.platform === "win32" ? "node.exe" : "node";
	return process.execPath;
}

/**
 * The e-commerce platform this workspace targets, when it declares one.
 *
 * Passed to `pack` so retrieval is scoped. Not inferred from the prompt: a
 * wrong guess silently drops the correct evidence, which is a worse failure
 * than the extra cross-platform claims it would avoid.
 */
function resolvePlatform(): string | null {
	const raw = process.env.ANTIFAN_CORE_PLATFORM;
	if (typeof raw !== "string") return null;
	const value = raw.trim().toLowerCase();
	return value.length > 0 ? value : null;
}

function runCoreCli(
	command: string,
	argsJson: string,
	opts: { cliPath: string; cwd: string; timeoutMs: number },
): Promise<CliResult> {
	const { promise, resolve } = Promise.withResolvers<CliResult>();
	let child: ChildProcess;
	try {
		child = spawn(resolveNodeRuntime(), [opts.cliPath, command, argsJson], {
			cwd: opts.cwd,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		resolve({ ok: false, reason: `spawn failed: ${err instanceof Error ? err.message : String(err)}` });
		return promise;
	}

	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let settled = false;

	const finish = (result: CliResult) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(result);
	};

	const timer = setTimeout(() => {
		timedOut = true;
		try {
			child.kill("SIGKILL");
		} catch {
			/* process may already be gone */
		}
	}, opts.timeoutMs);

	child.stdout?.on("data", (chunk: Buffer) => {
		if (stdout.length < MAX_OUTPUT_CHARS) stdout += String(chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		if (stderr.length < MAX_OUTPUT_CHARS) stderr += String(chunk);
	});
	child.on("error", (err: Error) => {
		finish({ ok: false, reason: `spawn error: ${err.message}` });
	});
	child.on("close", (code: number | null) => {
		if (timedOut) {
			finish({ ok: false, reason: `timeout after ${opts.timeoutMs}ms` });
			return;
		}
		if (code === 0) {
			try {
				const parsed: unknown = JSON.parse(stdout);
				if (isCorePack(parsed)) {
					finish({ ok: true, pack: parsed });
					return;
				}
				if (
					typeof parsed === "object" &&
					parsed !== null &&
					"available" in parsed &&
					parsed.available === false
				) {
					const reason = "reason" in parsed ? String(parsed.reason) : "core reported unavailable";
					finish({ ok: false, reason });
					return;
				}
				// Non-pack commands (e.g. stats) only prove availability.
				finish({ ok: true });
				return;
			} catch {
				finish({ ok: false, reason: "unparseable CLI output" });
				return;
			}
		}
		// Non-zero exit: the CLI's documented fail-open signal is
		// {"available":false,"reason":...} on stderr with exit 2.
		let reason = `exit ${code}`;
		try {
			const errObj: unknown = JSON.parse(stderr.trim());
			if (typeof errObj === "object" && errObj !== null && "available" in errObj && errObj.available === false) {
				reason = "reason" in errObj ? String(errObj.reason) : reason;
			}
		} catch {
			const trimmed = stderr.trim();
			if (trimmed.length > 0) reason = `${reason}: ${trimmed.slice(0, 300)}`;
		}
		finish({ ok: false, reason });
	});
	return promise;
}

// ---------------------------------------------------------------------------
// Receipt-required action classification (R6)
// ---------------------------------------------------------------------------

/** Normalize a tool name to canonical dotted form: core_receipt → core.receipt. */
function canonicalCoreName(toolName: string): string | null {
	const name = toolName.trim().toLowerCase();
	if (!name) return null;
	// Find a `core.<action>` segment anywhere in the name so MCP-mounted names
	// like `mcp__antifan_browser_core_receipt` classify the same as `core.receipt`.
	// The preceding-char guard keeps `hardcore.receipt`-style names out, and the
	// trailing class admits digits so versioned actions (core.receipt_v2) resolve
	// to their real key instead of truncating to `core.receipt.v`.
	const match = /(?:^|[^a-z0-9])core[._][a-z0-9_]+/.exec(name);
	if (!match) return null;
	const segment = match[0].replace(/^[^a-z0-9]+/, "");
	return segment.replace(/[_.]/g, ".");
}

/**
 * Classify a tool_call as receipt-required (returns the action label) or not
 * (null). Covers three surfaces: direct core.* tool names, xd:// device-write
 * paths, and bash invocations of the antifan-core CLI.
 */
function classifyReceiptRequired(toolName: string, input: Record<string, unknown>): string | null {
	const canonical = canonicalCoreName(toolName);
	if (canonical && RECEIPT_REQUIRED_CANONICAL[canonical] === true) {
		return canonical;
	}
	const target = String(input?.path ?? input?.file ?? input?.filePath ?? "");
	const xdMatch = /core[._]([a-z0-9_]+)/i.exec(target);
	if (xdMatch) {
		const candidate = `core.${xdMatch[1].toLowerCase().replace(/_/g, ".")}`;
		if (RECEIPT_REQUIRED_CANONICAL[candidate] === true) return candidate;
	}
	if (/^(bash|shell|exec|user_bash)$/i.test(toolName.trim())) {
		const command = String(input?.command ?? input?.cmd ?? "");
		const match = /antifan-core(?:\.cjs)?\b[^&|;]*?\b([a-z][a-z0-9-]*)\b/i.exec(command);
		if (match) {
			const sub = match[1].toLowerCase();
			if (RECEIPT_REQUIRED_CLI_COMMANDS[sub] === true) return `cli:${sub}`;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function renderPackContent(pack: CorePack, taskHash: string, projectRoot: string): string {
	const claims = pack.claims.slice(0, MAX_CLAIMS_IN_MESSAGE).map((c) => ({
		claimId: c.claimId,
		kind: c.kind,
		statement: typeof c.statement === "string" ? c.statement.slice(0, MAX_STATEMENT_CHARS) : c.statement,
		confidence: c.confidence,
		contextPlatform: c.contextPlatform ?? null,
	}));
	const body = {
		source: "antifan-core-bridge",
		packId: pack.packId,
		taskHash,
		projectRoot,
		coreRelease: pack.release?.releaseId ?? null,
		permissionScope: pack.permissionScope,
		generatedAt: pack.generatedAt,
		claimCount: pack.claims.length,
		conflictCount: pack.conflicts.length,
		unknowns: pack.unknowns,
		claims,
		conflicts: pack.conflicts.slice(0, 10),
	};
	let text = `[AntiFan Core context pack ${pack.packId} — permissionScope=${pack.permissionScope}]\n`;
	text += JSON.stringify(body, null, 1);
	if (text.length > MAX_PACK_CHARS) {
		text = `${text.slice(0, MAX_PACK_CHARS)}\n…[truncated at ${MAX_PACK_CHARS} chars]`;
	}
	return text;
}

// ---------------------------------------------------------------------------
// Event narrowing helpers
// ---------------------------------------------------------------------------

function stringField(event: unknown, key: string): string | undefined {
	if (typeof event === "object" && event !== null && key in event) {
		const value = (event as Record<string, unknown>)[key];
		return typeof value === "string" ? value : undefined;
	}
	return undefined;
}

function inputField(event: unknown): Record<string, unknown> {
	if (typeof event === "object" && event !== null && "input" in event) {
		const value = (event as Record<string, unknown>).input;
		if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
	}
	return {};
}

function messagesField(event: unknown): Array<Record<string, unknown>> | undefined {
	if (typeof event === "object" && event !== null && "messages" in event) {
		const value = (event as Record<string, unknown>).messages;
		if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
	}
	return undefined;
}

/**
 * Stable identity of the message a lifecycle event carries, used to dedupe a
 * re-entered `turn_end` / `agent_end`: the same turn re-emitted carries the same
 * assistant message (`id` when present, else `timestamp`), a new turn does not.
 */
function eventMessageKey(event: unknown): string | null {
	if (typeof event !== "object" || event === null) return null;
	const e = event as Record<string, unknown>;
	const pick = (m: unknown): string | null => {
		if (typeof m !== "object" || m === null) return null;
		const r = m as Record<string, unknown>;
		if (typeof r.id === "string" && r.id.length > 0) return `id:${r.id}`;
		if (typeof r.timestamp === "number") return `ts:${r.timestamp}`;
		return null;
	};
	const direct = pick(e.message);
	if (direct) return direct;
	const msgs = e.messages;
	if (Array.isArray(msgs) && msgs.length > 0) return pick(msgs[msgs.length - 1]);
	return null;
}

// ---------------------------------------------------------------------------
// Hook factory — one state instance per session binding
// ---------------------------------------------------------------------------

export default function antifanCoreBridgeHook(pi: BridgeAPI): void {
	if (typeof pi?.on !== "function") return;

	const state: BridgeState = {
		coreStatus: "unknown",
		unavailableReason: null,
		coreStatusAt: 0,
		pack: null,
		packId: null,
		coreRelease: null,
		taskHash: null,
		projectRoot: null,
		failureEmitted: false,
		turnsCompleted: 0,
		lastTurnKey: null,
		lastAgentEndKey: null,
		shutdownEmitted: false,
	};

	const log = (level: "info" | "warn" | "error", message: string) => {
		try {
			pi.logger?.[level]?.(`[antifan-core-bridge] ${message}`);
		} catch {
			/* logger must never break the session */
		}
	};

	/** Persist one bridge event: session entry + JSONL line. Never throws. */
	const recordEvent = (event: string, data: Record<string, unknown>) => {
		const record = {
			ts: new Date().toISOString(),
			event,
			projectRoot: state.projectRoot,
			taskHash: state.taskHash,
			packId: state.packId,
			...data,
		};
		try {
			pi.appendEntry?.(BRIDGE_ENTRY_TYPE, record);
		} catch {
			/* session entry channel is best-effort */
		}
		const logPath = resolveLogPath(state.projectRoot);
		if (logPath) {
			try {
				fs.mkdirSync(path.dirname(logPath), { recursive: true });
				fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
			} catch {
				/* file channel is best-effort */
			}
		}
	};

	/**
	 * Emit BRIDGE_CONTEXT_FAILED exactly once per session. Returns the failure
	 * message payload when the caller should deliver it inline (the first
	 * before_agent_start failure), otherwise sends it via pi.sendMessage.
	 */
	const emitFailureOnce = (
		reason: string,
		deliver: "inline" | "send",
	): { message: BridgeMessagePayload } | undefined => {
		state.coreStatus = "unavailable";
		state.unavailableReason = reason;
		if (state.failureEmitted) return undefined;
		state.failureEmitted = true;
		recordEvent(BRIDGE_CONTEXT_FAILED, { reason });
		log("warn", `${BRIDGE_CONTEXT_FAILED}: ${reason}`);
		const payload: BridgeMessagePayload = {
			customType: BRIDGE_MESSAGE_TYPE,
			content:
				`[${BRIDGE_CONTEXT_FAILED}] AntiFan Core context unavailable — continuing WITHOUT Core context ` +
				`(advisory only; receipt-required actions will be refused). ` +
				`reason=${reason} taskHash=${state.taskHash ?? "none"} projectRoot=${state.projectRoot ?? "unresolved"}`,
			display: true,
			details: {
				kind: "bridge_context_failed",
				event: BRIDGE_CONTEXT_FAILED,
				reason,
				taskHash: state.taskHash,
				projectRoot: state.projectRoot,
				permissionScope: "eligible-content-only",
			},
			attribution: "agent",
		};
		if (deliver === "inline") return { message: payload };
		try {
			pi.sendMessage?.(payload);
		} catch {
			/* delivery is best-effort; the event is already recorded */
		}
		return undefined;
	};

	/**
	 * Probe Core availability via `stats`.
	 *
	 * A healthy verdict is cached for the session; an unavailable verdict
	 * expires after `CORE_STATUS_RETRY_MS` so a transient failure cannot refuse
	 * receipt-required actions for the rest of the session.
	 */
	const ensureCoreStatus = async (ctx: BridgeContext): Promise<"available" | "unavailable"> => {
		if (state.coreStatus === "available") return "available";
		if (
			state.coreStatus === "unavailable" &&
			Date.now() - state.coreStatusAt < envInt("ANTIFAN_CORE_STATUS_RETRY_MS", CORE_STATUS_RETRY_MS, 600_000)
		) {
			return "unavailable";
		}
		state.projectRoot = state.projectRoot ?? resolveProjectRoot(ctx?.cwd);
		const cliPath = resolveCliPath(state.projectRoot);
		if (!cliPath) {
			state.coreStatus = "unavailable";
			state.coreStatusAt = Date.now();
			state.unavailableReason = "antifan-core CLI not found under project root";
			return state.coreStatus;
		}
		const probe = await runCoreCli("stats", "{}", {
			cliPath,
			cwd: state.projectRoot ?? process.cwd(),
			timeoutMs: PROBE_TIMEOUT_MS,
		});
		if (probe.ok) {
			state.coreStatus = "available";
			state.unavailableReason = null;
		} else {
			state.coreStatus = "unavailable";
			state.unavailableReason = probe.reason ?? "probe failed";
		}
		state.coreStatusAt = Date.now();
		return state.coreStatus;
	};

	// -- session_start: reset the per-session dedupe window --------------------
	pi.on("session_start", () => {
		state.coreStatus = "unknown";
		state.unavailableReason = null;
		state.coreStatusAt = 0;
		state.pack = null;
		state.packId = null;
		state.coreRelease = null;
		state.taskHash = null;
		state.projectRoot = null;
		state.failureEmitted = false;
		state.turnsCompleted = 0;
		state.lastTurnKey = null;
		state.lastAgentEndKey = null;
		state.shutdownEmitted = false;
	});

	// -- before_agent_start: seed exactly one pack message ---------------------
	pi.on("before_agent_start", async (event: unknown, ctx: BridgeContext) => {
		try {
			const prompt = stringField(event, "prompt");
			const task = prompt && prompt.trim().length > 0 ? prompt.trim() : "antifan session";
			state.projectRoot = resolveProjectRoot(ctx?.cwd);
			const taskHash = state.projectRoot ? computeTaskHash(task, state.projectRoot) : null;
			const isSameTask = state.taskHash !== null && taskHash === state.taskHash;
			state.taskHash = taskHash;

			// Identical prompt re-seed: reuse the pack, do not spawn again.
			if (state.pack && isSameTask) {
				return undefined;
			}

			const cliPath = resolveCliPath(state.projectRoot);
			if (!state.projectRoot || !cliPath) {
				return emitFailureOnce(
					state.projectRoot
						? "antifan-core CLI not found under project root"
						: "no antifan project root resolved from cwd",
					"inline",
				);
			}
			const platform = resolvePlatform();

			const result = await runCoreCli(
				"pack",
				JSON.stringify({
					task,
					limit: envInt("ANTIFAN_CORE_PACK_LIMIT", MAX_CLAIMS_IN_MESSAGE, 50),
					// Scope the pack to a platform when the workspace declares one.
					// Without it the Core applies no platform constraint, so claims
					// tagged for a different e-commerce platform are injected into
					// every turn — the noise the retrieval layer exists to stop.
					// Deliberately not inferred from the prompt: a wrong platform
					// silently drops the correct evidence, which is worse than the
					// extra claims it would avoid.
					...(platform ? { platform } : {}),
				}),
				{ cliPath, cwd: state.projectRoot, timeoutMs: envInt("ANTIFAN_CORE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 30_000) },
			);

			if (!result.ok || !result.pack) {
				return emitFailureOnce(result.reason ?? "pack command returned no pack", "inline");
			}

			const pack = result.pack;
			state.coreStatus = "available";
			state.pack = pack;
			state.packId = pack.packId;
			state.coreRelease = pack.release?.releaseId ?? null;
			recordEvent("BRIDGE_CONTEXT_SEEDED", {
				packId: pack.packId,
				coreRelease: state.coreRelease,
				claimCount: pack.claims.length,
			});
			return {
				message: {
					customType: BRIDGE_MESSAGE_TYPE,
					content: renderPackContent(pack, taskHash ?? "", state.projectRoot),
					display: true,
					details: {
						kind: "core-context-pack",
						packId: pack.packId,
						taskHash,
						projectRoot: state.projectRoot,
						coreRelease: state.coreRelease,
						permissionScope: pack.permissionScope ?? "eligible-content-only",
						claimCount: pack.claims.length,
						conflictCount: pack.conflicts.length,
						generatedAt: pack.generatedAt,
					},
					attribution: "agent",
				} satisfies BridgeMessagePayload,
			};
		} catch (err) {
			// Fail open: a bridge bug must never take the session down.
			return emitFailureOnce(`bridge error: ${err instanceof Error ? err.message : String(err)}`, "inline");
		}
	});

	// -- context: budget lever — drop stale/duplicate pack injections ----------
	pi.on("context", (event: unknown) => {
		try {
			const messages = messagesField(event);
			if (!messages) return undefined;
			let keptCurrent = false;
			let changed = false;
			const filtered = messages.filter((msg) => {
				const isBridgeMessage =
					(msg?.role === "custom" || msg?.role === "hookMessage") &&
					msg?.customType === BRIDGE_MESSAGE_TYPE;
				if (!isBridgeMessage) return true;
				const details = (msg?.details ?? {}) as Record<string, unknown>;
				if (details.kind !== "core-context-pack") return true; // failure label stays
				const isCurrent = state.packId !== null && details.packId === state.packId;
				if (isCurrent && !keptCurrent) {
					keptCurrent = true;
					return true;
				}
				changed = true;
				return false;
			});
			return changed ? { messages: filtered } : undefined;
		} catch {
			return undefined;
		}
	});

	// -- session.compacting: pack identity survives compression ----------------
	pi.on("session.compacting", () => {
		try {
			const preserveData: Record<string, unknown> = {
				packId: state.packId,
				coreRelease: state.coreRelease,
				taskHash: state.taskHash,
				projectRoot: state.projectRoot,
				permissionScope: "eligible-content-only",
				coreStatus: state.coreStatus,
			};
			if (state.unavailableReason) preserveData.unavailableReason = state.unavailableReason;
			const contextLine = state.packId
				? `AntiFan Core pack ${state.packId} (release ${state.coreRelease ?? "none"}, taskHash ${state.taskHash ?? "none"}) was injected at agent start; permissionScope=eligible-content-only.`
				: `AntiFan Core unavailable (${state.unavailableReason ?? "not seeded"}); session ran without Core context.`;
			return { context: [contextLine], preserveData };
		} catch {
			return undefined;
		}
	});

	// -- tool_call: R6 policy — refuse receipt-required when Core unavailable --
	pi.on("tool_call", async (event: unknown, ctx: BridgeContext) => {
		try {
			const toolName = stringField(event, "toolName") ?? stringField(event, "name") ?? "";
			const action = classifyReceiptRequired(toolName, inputField(event));
			if (!action) return undefined; // advisory surface: never blocked by the bridge
			const status = await ensureCoreStatus(ctx ?? {});
			if (status === "available") return undefined;
			const reason =
				`${REFUSAL_CODE}: receipt-required action '${action}' refused — AntiFan Core unavailable ` +
				`(${state.unavailableReason ?? "unknown reason"}). Advisory calls continue; this action is not downgraded.`;
			recordEvent("BRIDGE_ACTION_REFUSED", { action, reason });
			emitFailureOnce(state.unavailableReason ?? "core unavailable", "send");
			log("warn", reason);
			return { block: true, reason };
		} catch (err) {
			// A receipt-required action whose guard itself failed must not run.
			const reason = `${REFUSAL_CODE}: bridge policy check failed (${err instanceof Error ? err.message : String(err)})`;
			return { block: true, reason };
		}
	});

	// -- turn_end / agent_end / session_shutdown: lifecycle truth --------------
	// The three previously unbound events complete the bridge's session
	// lifecycle: each completed turn and each settled agent run leaves exactly
	// one evidence row (a re-entered event carrying the same message emits zero
	// duplicates), and session_shutdown releases the pack identity so the next
	// session cannot inherit a stale pack. Telemetry only: handlers never throw
	// and never spawn — the CLI is not touched here.
	pi.on("turn_end", (event: unknown) => {
		try {
			const key = eventMessageKey(event);
			if (key !== null && key === state.lastTurnKey) return;
			state.lastTurnKey = key;
			state.turnsCompleted += 1;
			recordEvent("BRIDGE_TURN_END", { turn: state.turnsCompleted });
		} catch {
			/* telemetry only: never break the session */
		}
	});

	pi.on("agent_end", (event: unknown) => {
		try {
			// Modern Pi/OMP emit agent_end mid-run and mark the non-terminal ones
			// with willContinue; only the settling event is a completion.
			const willContinue =
				typeof event === "object" && event !== null &&
				(event as Record<string, unknown>).willContinue === true;
			if (willContinue) return;
			const key = eventMessageKey(event);
			if (key !== null && key === state.lastAgentEndKey) return;
			state.lastAgentEndKey = key;
			recordEvent("BRIDGE_AGENT_END", { turnsCompleted: state.turnsCompleted });
		} catch {
			/* telemetry only */
		}
	});

	pi.on("session_shutdown", () => {
		try {
			if (state.shutdownEmitted) return;
			state.shutdownEmitted = true;
			recordEvent("BRIDGE_SESSION_SHUTDOWN", {
				coreStatus: state.coreStatus,
				turnsCompleted: state.turnsCompleted,
			});
			// Release the pack identity: a shutdown session must not pin the pack
			// for whatever runs next.
			state.pack = null;
			state.packId = null;
			state.coreRelease = null;
			state.taskHash = null;
		} catch {
			/* telemetry only */
		}
	});
}
