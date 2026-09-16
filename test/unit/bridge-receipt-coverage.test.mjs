// bridge-receipt-coverage.test.mjs — drift guard for the bridge's
// receipt-required set.
//
// scripts/antifan-omp-mcp.cjs declares mutability per CORE_DISPATCH row
// (third element === true). The pre-hook keeps a copy of that set — the
// compiled hook cannot require() the .cjs proxy without loading its
// ws/MCP-server machinery — so this test derives the mutating set from the
// real table and asserts the bridge refuses EVERY mutating entry on all
// three tool surfaces (bare advertised name, MCP-mounted name, xd:// device
// path) plus its CLI subcommand spelling, while refusing none of the
// advisory entries. A mutating entry added to CORE_DISPATCH without
// updating the hook fails here.
//
// Behavioral only: tool_call results and recorded events, no source-text
// assertions on the hook. The hook runs against a mock pi and an exit-2
// stub CLI so Core is unavailable.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_PATH = path.join(REPO, '.omp', 'hooks', 'pre', 'antifan-core-bridge.ts');
// Node type-stripping honors the repo's "type": "commonjs" and would treat
// the .ts hook as CJS; an .mts copy of the same bytes forces ESM (same trick
// as context-bridge.test.mjs).
const HOOK_MTS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hook-')), 'antifan-core-bridge.mts');
fs.copyFileSync(HOOK_PATH, HOOK_MTS);
const { default: bridgeHook } = await import(pathToFileURL(HOOK_MTS).href);

// The mutating set is read from the real dispatch table — never re-declared
// in this file, or the guard would drift alongside the file it watches.
const { CORE_DISPATCH } = require(path.join(REPO, 'scripts', 'antifan-omp-mcp.cjs'));
const MUTATING = Object.keys(CORE_DISPATCH).filter((name) => CORE_DISPATCH[name][2] === true);
const ADVISORY = Object.keys(CORE_DISPATCH).filter((name) => CORE_DISPATCH[name][2] !== true);

// CLI coverage is derived the same way: each `case '<cmd>':` slice of
// scripts/antifan-core.cjs is mutating iff its `out = core.<m>(` call binds
// the store method of a mutating CORE_DISPATCH entry. Block-form cases that
// only read through core.db SELECTs (regressions, task-runs, pack-detail,
// case-detail) have no such call and land in the advisory assertion below.
const CLI_SOURCE = fs.readFileSync(path.join(REPO, 'scripts', 'antifan-core.cjs'), 'utf8');
const STORE_METHOD_TO_DISPATCH = new Map(
	Object.entries(CORE_DISPATCH).map(([name, entry]) => [entry[0], name]),
);
const ALL_CLI_COMMANDS = [];
const MUTATING_CLI_COMMANDS = [];
const CLI_COVERED_DISPATCHES = new Set();
const caseMatches = [...CLI_SOURCE.matchAll(/case '([a-z0-9-]+)'/g)];
for (let i = 0; i < caseMatches.length; i++) {
	const cmd = caseMatches[i][1];
	ALL_CLI_COMMANDS.push(cmd);
	const body = CLI_SOURCE.slice(caseMatches[i].index, caseMatches[i + 1]?.index ?? CLI_SOURCE.length);
	const call = /out = core\.([A-Za-z0-9_]+)\(/.exec(body);
	if (!call) continue;
	const dispatch = STORE_METHOD_TO_DISPATCH.get(call[1]);
	if (!dispatch) continue; // CLI-only commands (import) are asserted individually below
	if (CORE_DISPATCH[dispatch][2] !== true) continue;
	MUTATING_CLI_COMMANDS.push(cmd);
	CLI_COVERED_DISPATCHES.add(dispatch);
}

// ---------------------------------------------------------------------------
// Harness (same shape as context-bridge.test.mjs)
// ---------------------------------------------------------------------------

const ENV_KEYS = [
	'SUPER_CORE_DB',
	'ANTIFAN_CORE_CLI',
	'ANTIFAN_CORE_BRIDGE_LOG',
	'ANTIFAN_CORE_TIMEOUT_MS',
	'ANTIFAN_PROJECT_ROOT',
	'ANTIFAN_CORE_PACK_LIMIT',
	'ANTIFAN_CORE_STATUS_RETRY_MS',
];

async function withEnv(overrides, fn) {
	const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(overrides)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return await fn();
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

function makePi() {
	const handlers = new Map();
	const sent = [];
	const entries = [];
	const logs = [];
	const pi = {
		on: (event, fn) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
		},
		sendMessage: (m) => sent.push(m),
		appendEntry: (customType, data) => entries.push({ customType, data }),
		logger: {
			info: (m) => logs.push(['info', m]),
			warn: (m) => logs.push(['warn', m]),
			error: (m) => logs.push(['error', m]),
		},
	};
	const emitBeforeAgentStart = async (prompt, ctx = {}) => {
		const messages = [];
		for (const h of handlers.get('before_agent_start') ?? []) {
			const r = await h({ type: 'before_agent_start', prompt }, ctx);
			if (r?.message) messages.push(r.message);
		}
		return messages;
	};
	const emit = async (event, payload = {}, ctx = {}) => {
		const results = [];
		for (const h of handlers.get(event) ?? []) {
			results.push(await h({ type: event, ...payload }, ctx));
		}
		return results;
	};
	return { pi, handlers, sent, entries, logs, emit, emitBeforeAgentStart };
}

const EXIT2_STUB = `console.error(JSON.stringify({available:false,reason:'super-core unavailable: stub exit 2'})); process.exit(2);`;

// ---------------------------------------------------------------------------
// Coverage: every mutating CORE_DISPATCH entry is refused on every surface
// ---------------------------------------------------------------------------

test('every mutating CORE_DISPATCH entry is refused on every surface when Core is unavailable', async () => {
	assert.ok(MUTATING.length > 0, 'dispatch table must declare mutating entries');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-coverage-'));
	const stub = path.join(dir, 'stub-cli.cjs');
	fs.writeFileSync(stub, EXIT2_STUB, 'utf8');
	const log = path.join(dir, 'events.jsonl');
	await withEnv(
		{ ANTIFAN_CORE_CLI: stub, ANTIFAN_CORE_BRIDGE_LOG: log, SUPER_CORE_DB: undefined, ANTIFAN_PROJECT_ROOT: undefined },
		async () => {
			const h = makePi();
			bridgeHook(h.pi);
			const ctx = { cwd: REPO };
			await h.emitBeforeAgentStart('coverage task', ctx); // establishes unavailable

			let expectedRefusals = 0;
			for (const name of MUTATING) {
				const mounted = `mcp__antifan_browser_${name.replace(/\./g, '_')}`;
				const [bare] = await h.emit('tool_call', { toolName: name, input: {} }, ctx);
				assert.equal(bare?.block, true, `${name} must be refused (advertised name)`);
				assert.match(bare.reason, /REFUSED_CORE_UNAVAILABLE/);
				const [mountedCall] = await h.emit('tool_call', { toolName: mounted, input: {} }, ctx);
				assert.equal(mountedCall?.block, true, `${name} must be refused (MCP-mounted name)`);
				const [xd] = await h.emit(
					'tool_call',
					{ toolName: 'write', input: { path: `xd://${mounted}`, content: '{}' } },
					ctx,
				);
				assert.equal(xd?.block, true, `${name} must be refused (xd:// device path)`);
				expectedRefusals += 3;
			}

			// The CLI surface covers the same mutating set: one subcommand per
			// mutating dispatch entry, derived from the CLI's own switch.
			const uncovered = MUTATING.filter((name) => !CLI_COVERED_DISPATCHES.has(name));
			assert.deepEqual(uncovered, [], 'every mutating dispatch entry needs a CLI subcommand');
			for (const cmd of MUTATING_CLI_COMMANDS) {
				const [r] = await h.emit(
					'tool_call',
					{ toolName: 'bash', input: { command: `node scripts/antifan-core.cjs ${cmd} '{}'` } },
					ctx,
				);
				assert.equal(r?.block, true, `antifan-core ${cmd} must be refused`);
				expectedRefusals += 1;
			}

			// `import` mutates the store (importScout writes claims/cases) but has
			// no CORE_DISPATCH row, so it is asserted individually.
			const [imp] = await h.emit(
				'tool_call',
				{ toolName: 'bash', input: { command: "node scripts/antifan-core.cjs import './reports'" } },
				ctx,
			);
			assert.equal(imp?.block, true, 'antifan-core import mutates the store and must be refused');
			expectedRefusals += 1;

			// Advisory entries and read-only CLI commands are never refused.
			for (const name of ADVISORY) {
				const [r] = await h.emit('tool_call', { toolName: name, input: {} }, ctx);
				assert.equal(r, undefined, `${name} is advisory and must not be refused`);
			}
			const mutatingCli = new Set([...MUTATING_CLI_COMMANDS, 'import']);
			for (const cmd of ALL_CLI_COMMANDS.filter((c) => !mutatingCli.has(c))) {
				const [r] = await h.emit(
					'tool_call',
					{ toolName: 'bash', input: { command: `node scripts/antifan-core.cjs ${cmd} '{}'` } },
					ctx,
				);
				assert.equal(r, undefined, `antifan-core ${cmd} is read-only and must not be refused`);
			}

			// The once-per-session failure contract holds after every refusal.
			assert.equal(
				h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_FAILED').length,
				1,
				'exactly one BRIDGE_CONTEXT_FAILED per session',
			);
			const refused = h.entries.filter((e) => e.data?.event === 'BRIDGE_ACTION_REFUSED');
			assert.equal(refused.length, expectedRefusals, 'every refusal is recorded');
		},
	);
});
