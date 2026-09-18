// context-bridge.test.mjs — behavioral tests for .omp/hooks/pre/antifan-core-bridge.ts
//
// Asserts observable behavior only: messages returned, blocks issued, events
// recorded. No wiring/source-text assertions. The hook is exercised through a
// mock pi (ExtensionAPI-shaped) plus the REAL scripts/antifan-core.cjs CLI
// against a throwaway SUPER_CORE_DB.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_PATH = path.join(REPO, '.omp', 'hooks', 'pre', 'antifan-core-bridge.ts');
// The OMP runtime (Bun) loads .ts hooks as ESM. Node's type-stripping honors the
// repo's "type": "commonjs" and would treat this .ts as CJS, so the test imports
// an .mts copy — same source bytes, forced ESM.
const HOOK_MTS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hook-')), 'antifan-core-bridge.mts');
fs.copyFileSync(HOOK_PATH, HOOK_MTS);
const { default: bridgeHook } = await import(pathToFileURL(HOOK_MTS).href);


// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ENV_KEYS = [
	'SUPER_CORE_DB',
	'ANTIFAN_CORE_CLI',
	'ANTIFAN_CORE_BRIDGE_LOG',
	'ANTIFAN_CORE_TIMEOUT_MS',
	'ANTIFAN_PROJECT_ROOT',
	'ANTIFAN_CORE_PACK_LIMIT',
	'ANTIFAN_CORE_BRIDGE_GATE',
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
	// Mimics ExtensionRunner.emitBeforeAgentStart: collects result.message.
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

function tmpDir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStubCli(dir, body) {
	const p = path.join(dir, 'stub-cli.cjs');
	fs.writeFileSync(p, body, 'utf8');
	return p;
}

const EXIT2_STUB = `console.error(JSON.stringify({available:false,reason:'super-core unavailable: stub exit 2'})); process.exit(2);`;
const SLEEP_STUB = `setTimeout(() => {}, 60000);`;

function readJsonl(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// R2 — discovery trap: factories directly under .omp/hooks/ are NOT discovered
// ---------------------------------------------------------------------------

test('hook discovery scans only pre/ and post/ subdirectories', () => {
	const root = tmpDir('hook-discovery-');
	fs.mkdirSync(path.join(root, '.omp', 'hooks', 'pre'), { recursive: true });
	fs.mkdirSync(path.join(root, '.omp', 'hooks', 'post'), { recursive: true });
	fs.writeFileSync(path.join(root, '.omp', 'hooks', 'misplaced.ts'), 'export default function(){}');
	fs.writeFileSync(path.join(root, '.omp', 'hooks', 'pre', 'found.ts'), 'export default function(){}');
	fs.writeFileSync(path.join(root, '.omp', 'hooks', 'post', 'found.js'), 'export default function(){}');
	fs.writeFileSync(path.join(root, '.omp', 'hooks', 'pre', 'not-a-hook.txt'), 'x');

	// Replica of the native scan: <root>/.omp/hooks/{pre,post}/*.{ts,js}, files only.
	const discovered = [];
	for (const type of ['pre', 'post']) {
		const dir = path.join(root, '.omp', 'hooks', type);
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith('.') || !entry.isFile()) continue;
			if (!/\.(ts|js)$/.test(entry.name)) continue;
			discovered.push(path.join(dir, entry.name));
		}
	}

	assert.equal(discovered.length, 2);
	assert.ok(discovered.some((p) => p.endsWith(path.join('pre', 'found.ts'))));
	assert.ok(discovered.some((p) => p.endsWith(path.join('post', 'found.js'))));
	assert.ok(!discovered.some((p) => p.includes('misplaced')), 'direct child of hooks/ must not be discovered');
});

test('bridge hook is placed inside .omp/hooks/pre/ where discovery scans', () => {
	assert.ok(fs.existsSync(HOOK_PATH), 'hook file must exist at .omp/hooks/pre/antifan-core-bridge.ts');
	assert.equal(typeof bridgeHook, 'function', 'hook module must default-export a factory');
});

// ---------------------------------------------------------------------------
// R3/R7 — Core available: exactly one pack message with identity + scope
// ---------------------------------------------------------------------------

test('core available: before_agent_start returns one pack message with identity', async () => {
	const dir = tmpDir('core-bridge-ok-');
	const db = path.join(dir, 'core.db');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ SUPER_CORE_DB: db, ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };

		const messages = await h.emitBeforeAgentStart('audit the haravan theme sections', ctx);
		assert.equal(messages.length, 1, 'exactly one message seeded');
		const msg = messages[0];
		assert.equal(msg.customType, 'antifan-core-bridge');
		assert.equal(msg.details.kind, 'core-context-pack');
		assert.match(msg.details.packId, /^pack-/);
		assert.equal(msg.details.projectRoot, REPO, 'project identity resolves to repo root, not blind cwd');
		assert.equal(msg.details.permissionScope, 'eligible-content-only');
		assert.ok(typeof msg.details.taskHash === 'string' && msg.details.taskHash.length > 0);
		assert.ok(msg.content.includes(msg.details.packId), 'pack id visible in message content');
		assert.equal(h.sent.length, 0, 'pack is returned, not sent out-of-band');

		// Identical prompt: no second spawn, no second message.
		const again = await h.emitBeforeAgentStart('audit the haravan theme sections', ctx);
		assert.equal(again.length, 0, 'identical prompt does not re-seed');

		const seeded = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SEEDED');
		assert.equal(seeded.length, 1);
		assert.equal(seeded[0].data.packId, msg.details.packId);
	});
});

test('project root resolves by walking up from a subdirectory cwd', async () => {
	const dir = tmpDir('core-bridge-subdir-');
	await withEnv({ SUPER_CORE_DB: path.join(dir, 'core.db'), ANTIFAN_CORE_BRIDGE_LOG: path.join(dir, 'events.jsonl'), ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const messages = await h.emitBeforeAgentStart('task from nested dir', { cwd: path.join(REPO, 'scripts') });
		assert.equal(messages.length, 1);
		assert.equal(messages[0].details.projectRoot, REPO);
	});
});

// ---------------------------------------------------------------------------
// R5 — fail-open: exit-2 CLI, missing CLI, and timeout all continue the session
// ---------------------------------------------------------------------------

test('core unavailable (CLI exit 2): session continues, exactly one BRIDGE_CONTEXT_FAILED', async () => {
	const dir = tmpDir('core-bridge-down-');
	const stub = writeStubCli(dir, EXIT2_STUB);
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ ANTIFAN_CORE_CLI: stub, ANTIFAN_CORE_BRIDGE_LOG: log, SUPER_CORE_DB: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };

		const first = await h.emitBeforeAgentStart('first prompt', ctx);
		assert.equal(first.length, 1, 'failure label delivered inline once');
		assert.equal(first[0].details.event, 'BRIDGE_CONTEXT_FAILED');
		assert.match(first[0].content, /BRIDGE_CONTEXT_FAILED/);
		assert.match(first[0].content, /stub exit 2/);

		// Later prompts: session continues silently — no second event, no throw.
		const second = await h.emitBeforeAgentStart('second prompt', ctx);
		assert.equal(second.length, 0, 'no duplicate failure message');

		const failed = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_FAILED');
		assert.equal(failed.length, 1, 'exactly one BRIDGE_CONTEXT_FAILED session entry');
		const fileEvents = readJsonl(log).filter((r) => r.event === 'BRIDGE_CONTEXT_FAILED');
		assert.equal(fileEvents.length, 1, 'exactly one BRIDGE_CONTEXT_FAILED in JSONL evidence');
	});
});

test('core unavailable (CLI missing): fail-open with one event', async () => {
	const dir = tmpDir('core-bridge-missing-');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ ANTIFAN_CORE_CLI: path.join(dir, 'no-such-cli.cjs'), ANTIFAN_CORE_BRIDGE_LOG: log, SUPER_CORE_DB: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const messages = await h.emitBeforeAgentStart('prompt', { cwd: REPO });
		assert.equal(messages.length, 1);
		assert.equal(messages[0].details.event, 'BRIDGE_CONTEXT_FAILED');
		assert.equal(h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_FAILED').length, 1);
	});
});

test('core timeout: hard spawn timeout fires and session continues', async () => {
	const dir = tmpDir('core-bridge-timeout-');
	const stub = writeStubCli(dir, SLEEP_STUB);
	const log = path.join(dir, 'events.jsonl');
	await withEnv(
		{ ANTIFAN_CORE_CLI: stub, ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_TIMEOUT_MS: '300', SUPER_CORE_DB: undefined, ANTIFAN_PROJECT_ROOT: undefined },
		async () => {
			const h = makePi();
			bridgeHook(h.pi);
			const started = Date.now();
			const messages = await h.emitBeforeAgentStart('prompt', { cwd: REPO });
			const elapsed = Date.now() - started;
			assert.ok(elapsed < 5000, `handler must not wait forever (took ${elapsed}ms)`);
			assert.equal(messages.length, 1);
			assert.equal(messages[0].details.event, 'BRIDGE_CONTEXT_FAILED');
			assert.match(messages[0].details.reason, /timeout/i);
		},
	);
});

// ---------------------------------------------------------------------------
// R4 — pack identity survives compaction
// ---------------------------------------------------------------------------

test('session.compacting preserves packId, coreRelease, taskHash', async () => {
	const dir = tmpDir('core-bridge-compact-');
	await withEnv({ SUPER_CORE_DB: path.join(dir, 'core.db'), ANTIFAN_CORE_BRIDGE_LOG: path.join(dir, 'events.jsonl'), ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };
		const messages = await h.emitBeforeAgentStart('compaction survival task', ctx);
		const packId = messages[0].details.packId;
		const taskHash = messages[0].details.taskHash;

		const results = await h.emit('session.compacting', { sessionId: 's1', messages: [] }, ctx);
		const preserve = results.map((r) => r?.preserveData).find(Boolean);
		assert.ok(preserve, 'preserveData returned');
		assert.equal(preserve.packId, packId, 'packId invariant across compaction');
		assert.equal(preserve.taskHash, taskHash);
		assert.ok('coreRelease' in preserve, 'coreRelease key present even when null');
		assert.equal(preserve.permissionScope, 'eligible-content-only');
	});
});

test('session.compacting records unavailable state when no pack was seeded', async () => {
	const dir = tmpDir('core-bridge-compact-down-');
	const stub = writeStubCli(dir, EXIT2_STUB);
	await withEnv({ ANTIFAN_CORE_CLI: stub, ANTIFAN_CORE_BRIDGE_LOG: path.join(dir, 'events.jsonl'), SUPER_CORE_DB: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		await h.emitBeforeAgentStart('prompt', { cwd: REPO });
		const results = await h.emit('session.compacting', { sessionId: 's1', messages: [] }, { cwd: REPO });
		const preserve = results.map((r) => r?.preserveData).find(Boolean);
		assert.equal(preserve.packId, null);
		assert.equal(preserve.coreStatus, 'unavailable');
		assert.ok(preserve.unavailableReason);
	});
});

// ---------------------------------------------------------------------------
// R3 — context budget: stale/duplicate pack injections are stripped
// ---------------------------------------------------------------------------

function packMessage(packId, kind = 'core-context-pack') {
	return {
		role: 'custom',
		customType: 'antifan-core-bridge',
		content: `pack ${packId}`,
		display: true,
		details: { kind, packId },
		timestamp: 1,
	};
}

test('context handler drops stale and duplicate pack messages, keeps current once', async () => {
	const dir = tmpDir('core-bridge-budget-');
	await withEnv({ SUPER_CORE_DB: path.join(dir, 'core.db'), ANTIFAN_CORE_BRIDGE_LOG: path.join(dir, 'events.jsonl'), ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };
		const messages = await h.emitBeforeAgentStart('budget task', ctx);
		const currentId = messages[0].details.packId;

		const conversation = [
			packMessage('pack-stale-old'),
			{ role: 'user', content: 'hello', timestamp: 1 },
			packMessage(currentId),
			packMessage(currentId), // duplicate of current
			{ role: 'custom', customType: 'antifan-core-bridge', content: 'failure label', display: true, details: { kind: 'bridge_context_failed' }, timestamp: 2 },
		];
		const results = await h.emit('context', { messages: conversation }, ctx);
		const out = results.map((r) => r?.messages).find(Boolean);
		assert.ok(out, 'context handler returns filtered messages');

		const bridgeMsgs = out.filter((m) => m.customType === 'antifan-core-bridge');
		const packs = bridgeMsgs.filter((m) => m.details?.kind === 'core-context-pack');
		assert.equal(packs.length, 1, 'exactly one pack message survives');
		assert.equal(packs[0].details.packId, currentId);
		assert.ok(bridgeMsgs.some((m) => m.details?.kind === 'bridge_context_failed'), 'failure label is not stripped');
		assert.equal(out.length, 3);
	});
});

test('context handler drops all pack messages when core is unavailable', async () => {
	const dir = tmpDir('core-bridge-budget-down-');
	const stub = writeStubCli(dir, EXIT2_STUB);
	await withEnv({ ANTIFAN_CORE_CLI: stub, ANTIFAN_CORE_BRIDGE_LOG: path.join(dir, 'events.jsonl'), SUPER_CORE_DB: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };
		await h.emitBeforeAgentStart('prompt', ctx);
		const results = await h.emit('context', { messages: [packMessage('pack-any'), { role: 'user', content: 'x', timestamp: 1 }] }, ctx);
		const out = results.map((r) => r?.messages).find(Boolean);
		assert.equal(out.length, 1, 'stale pack dropped when no current pack exists');
		assert.equal(out[0].role, 'user');
	});
});

// ---------------------------------------------------------------------------
// R6 — policy by action kind
// ---------------------------------------------------------------------------

test('receipt-required actions are refused when core is unavailable; advisory continues', async () => {
	const dir = tmpDir('core-bridge-policy-');
	const stub = writeStubCli(dir, EXIT2_STUB);
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ ANTIFAN_CORE_CLI: stub, ANTIFAN_CORE_BRIDGE_LOG: log, SUPER_CORE_DB: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };
		await h.emitBeforeAgentStart('policy task', ctx); // establishes unavailable

		// Receipt-required tool name → blocked.
		const [receipt] = await h.emit('tool_call', { toolName: 'core.receipt', input: { task: 't', recommendation: 'r' } }, ctx);
		assert.equal(receipt.block, true);
		assert.match(receipt.reason, /REFUSED_CORE_UNAVAILABLE/);

		// Receipt-required via bash CLI → blocked.
		const [cli] = await h.emit('tool_call', { toolName: 'bash', input: { command: "node scripts/antifan-core.cjs receipt '{\"task\":\"t\",\"recommendation\":\"r\"}'" } }, ctx);
		assert.equal(cli.block, true);
		assert.match(cli.reason, /REFUSED_CORE_UNAVAILABLE/);

		// Receipt-required via xd:// device write → blocked.
		const [xd] = await h.emit('tool_call', { toolName: 'write', input: { path: 'xd://mcp__antifan_browser_core_receipt', content: '{}' } }, ctx);
		assert.equal(xd.block, true);

		// Versioned receipt action. The token contains a digit, so a canonicaliser
		// that stops at `[a-z_]` truncates it to `core.receipt.v` — a key no input
		// can produce — and lets the call through. All three name forms must block.
		const [receiptV2] = await h.emit('tool_call', { toolName: 'core.receipt_v2', input: { packId: 'p' } }, ctx);
		assert.equal(receiptV2.block, true, 'core.receipt_v2 is receipt-required');
		assert.match(receiptV2.reason, /REFUSED_CORE_UNAVAILABLE/);
		const [receiptV2Mounted] = await h.emit('tool_call', { toolName: 'mcp__antifan_browser_core_receipt_v2', input: { packId: 'p' } }, ctx);
		assert.equal(receiptV2Mounted.block, true, 'the MCP-mounted spelling blocks too');
		const [receiptV2Xd] = await h.emit('tool_call', { toolName: 'write', input: { path: 'xd://mcp__antifan_browser_core_receipt_v2', content: '{}' } }, ctx);
		assert.equal(receiptV2Xd.block, true, 'the xd:// spelling blocks too');

		// Advisory surfaces → not blocked.
		const [advisoryTool] = await h.emit('tool_call', { toolName: 'core.query', input: { text: 'x' } }, ctx);
		assert.equal(advisoryTool, undefined);
		const [read] = await h.emit('tool_call', { toolName: 'read', input: { path: 'x' } }, ctx);
		assert.equal(read, undefined);
		const [advisoryCli] = await h.emit('tool_call', { toolName: 'bash', input: { command: "node scripts/antifan-core.cjs query '{\"text\":\"x\"}'" } }, ctx);
		assert.equal(advisoryCli, undefined);

		// Still exactly one failure event for the whole session.
		assert.equal(h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_FAILED').length, 1);
		const refused = h.entries.filter((e) => e.data?.event === 'BRIDGE_ACTION_REFUSED');
		assert.ok(refused.length >= 3, 'each refusal is recorded');
	});
});

test('receipt-required actions pass through when core is available', async () => {
	const dir = tmpDir('core-bridge-policy-ok-');
	await withEnv({ SUPER_CORE_DB: path.join(dir, 'core.db'), ANTIFAN_CORE_BRIDGE_LOG: path.join(dir, 'events.jsonl'), ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };
		await h.emitBeforeAgentStart('policy task available', ctx);
		const [receipt] = await h.emit('tool_call', { toolName: 'core.receipt', input: { task: 't', recommendation: 'r' } }, ctx);
		assert.equal(receipt, undefined, 'available core does not block receipt-required calls');
	});
});

// ---------------------------------------------------------------------------
// R7 — foreign project isolation: no project root → fail-open, no injection
// ---------------------------------------------------------------------------

test('foreign project cwd resolves no project root and fails open', async () => {
	const dir = tmpDir('core-bridge-foreign-');
	const foreign = tmpDir('foreign-project-');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_CLI: undefined, SUPER_CORE_DB: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const messages = await h.emitBeforeAgentStart('task', { cwd: foreign });
		assert.equal(messages.length, 1);
		assert.equal(messages[0].details.event, 'BRIDGE_CONTEXT_FAILED');
		assert.equal(messages[0].details.projectRoot, null, 'no pack identity for a foreign project');
	});
});

// ---------------------------------------------------------------------------
// R7 (lifecycle) — turn_end / agent_end / session_shutdown bindings
// ---------------------------------------------------------------------------

test('turn_end records exactly one row per completed turn, zero duplicates on re-entry', async () => {
	const dir = tmpDir('core-bridge-turn-');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_CLI: undefined, SUPER_CORE_DB: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const message = { role: 'assistant', id: 'msg-1', timestamp: 1 };

		await h.emit('turn_end', { message, toolResults: [] });
		await h.emit('turn_end', { message, toolResults: [] }); // re-entered same turn
		const rows = () => readJsonl(log).filter((r) => r.event === 'BRIDGE_TURN_END');
		assert.equal(rows().length, 1, 'a re-entered turn must not add a duplicate row');
		assert.equal(rows()[0].turn, 1);
		assert.equal(h.entries.filter((e) => e.data?.event === 'BRIDGE_TURN_END').length, 1);

		await h.emit('turn_end', { message: { role: 'assistant', id: 'msg-2', timestamp: 2 }, toolResults: [] });
		assert.equal(rows().length, 2, 'a new turn records a second row');
		assert.equal(rows()[1].turn, 2, 'the turn counter is monotonic');
	});
});

test('agent_end records one row for the settling event and skips mid-run events', async () => {
	const dir = tmpDir('core-bridge-agent-end-');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_CLI: undefined, SUPER_CORE_DB: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const rows = () => readJsonl(log).filter((r) => r.event === 'BRIDGE_AGENT_END');

		await h.emit('agent_end', { messages: [{ role: 'assistant', id: 'm1' }], willContinue: true });
		assert.equal(rows().length, 0, 'a mid-run agent_end (willContinue) is not a completion');

		await h.emit('agent_end', { messages: [{ role: 'assistant', id: 'm1' }] });
		assert.equal(rows().length, 1, 'the settling event records one row');

		await h.emit('agent_end', { messages: [{ role: 'assistant', id: 'm1' }] }); // re-entered
		assert.equal(rows().length, 1, 'a re-entered settle event adds no duplicate');
	});
});

test('session_shutdown records one row and releases the pack identity', async () => {
	const dir = tmpDir('core-bridge-shutdown-');
	const db = path.join(dir, 'core.db');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ SUPER_CORE_DB: db, ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };
		const messages = await h.emitBeforeAgentStart('shutdown task', ctx);
		assert.equal(messages.length, 1, 'pack seeded');
		assert.match(messages[0].details.packId, /^pack-/);

		await h.emit('session_shutdown', {});
		await h.emit('session_shutdown', {});
		const rows = () => readJsonl(log).filter((r) => r.event === 'BRIDGE_SESSION_SHUTDOWN');
		assert.equal(rows().length, 1, 'shutdown is recorded once per session');
		assert.equal(rows()[0].packId, messages[0].details.packId, 'the row names the pack that was live');

		// Released identity is observable through compaction, which reports the
		// pack line only while a pack is live.
		const [compaction] = await h.emit('session.compacting', {});
		assert.ok(
			compaction.context[0].includes('AntiFan Core unavailable'),
			`shutdown must release the pack identity, got: ${compaction.context[0]}`,
		);
	});
});

test('a transient outage does not refuse receipt actions after Core recovers', async () => {
	const dir = tmpDir('core-bridge-recovery-');
	// Distinct files: writeStubCli() reuses one filename, so a second call would
	// overwrite the outage stub and the session would never see Core go down.
	const failing = path.join(dir, 'stub-cli-down.cjs');
	const healthy = path.join(dir, 'stub-cli-up.cjs');
	fs.writeFileSync(failing, EXIT2_STUB, 'utf8');
	fs.writeFileSync(healthy, "process.stdout.write(JSON.stringify({ status: 'ok' }));", 'utf8');
	const log = path.join(dir, 'events.jsonl');
	await withEnv(
		{
			ANTIFAN_CORE_CLI: failing,
			ANTIFAN_CORE_BRIDGE_LOG: log,
			// Expire the unavailable verdict immediately so the next call re-probes,
			// instead of waiting out the production cooldown.
			ANTIFAN_CORE_STATUS_RETRY_MS: '1',
			SUPER_CORE_DB: undefined,
			ANTIFAN_PROJECT_ROOT: undefined,
		},
		async () => {
			const h = makePi();
			bridgeHook(h.pi);
			const ctx = { cwd: REPO };
			await h.emitBeforeAgentStart('recovery task', ctx);

			const [duringOutage] = await h.emit('tool_call', { toolName: 'core.receipt', input: { task: 't' } }, ctx);
			assert.equal(duringOutage.block, true, 'a receipt action is refused while Core is down');

			process.env.ANTIFAN_CORE_CLI = healthy;
			await new Promise((resolve) => setTimeout(resolve, 25));

			const [afterRecovery] = await h.emit('tool_call', { toolName: 'core.receipt', input: { task: 't' } }, ctx);
			assert.equal(afterRecovery, undefined, 'a recovered Core is no longer refused');
		},
	);
});

// ---------------------------------------------------------------------------
// Storefront decoupling P0: intent gating (clone vs storefront-edit)
// ---------------------------------------------------------------------------

test('storefront-edit prompt returns zero messages and records BRIDGE_CONTEXT_SKIPPED once', async () => {
	const dir = tmpDir('core-bridge-storefront-edit-');
	const db = path.join(dir, 'core.db');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ SUPER_CORE_DB: db, ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };

		const prompt = 'ẩn nút Book Now bằng display none';
		const messages = await h.emitBeforeAgentStart(prompt, ctx);
		assert.equal(messages.length, 0, 'storefront-edit prompt returns zero messages');

		const skipped = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SKIPPED');
		assert.equal(skipped.length, 1, 'records exactly one BRIDGE_CONTEXT_SKIPPED session entry');
		assert.equal(skipped[0].data?.intent, 'storefront-edit');

		// An identical re-prompt adds no second skip event
		const again = await h.emitBeforeAgentStart(prompt, ctx);
		assert.equal(again.length, 0, 'identical re-prompt returns zero messages');
		const skippedAgain = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SKIPPED');
		assert.equal(skippedAgain.length, 1, 'identical re-prompt adds no second skip event');

		const fileEvents = readJsonl(log).filter((r) => r.event === 'BRIDGE_CONTEXT_SKIPPED');
		assert.equal(fileEvents.length, 1, 'file log matches session entry');
	});
});

test('clone intent still seeds exactly one core-context-pack message', async () => {
	const dir = tmpDir('core-bridge-clone-');
	const db = path.join(dir, 'core.db');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ SUPER_CORE_DB: db, ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };

		const prompt = 'clone website https://example.com vào theme hiện có';
		const messages = await h.emitBeforeAgentStart(prompt, ctx);
		assert.equal(messages.length, 1, 'clone intent seeds exactly one message');
		const msg = messages[0];
		assert.equal(msg.customType, 'antifan-core-bridge');
		assert.equal(msg.details.kind, 'core-context-pack');
		assert.match(msg.details.packId, /^pack-/);

		const seeded = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SEEDED');
		assert.equal(seeded.length, 1, 'BRIDGE_CONTEXT_SEEDED recorded');
	});
});

test('with ANTIFAN_CORE_BRIDGE_GATE=off, storefront-edit prompt seeds a pack', async () => {
	const dir = tmpDir('core-bridge-gate-off-');
	const db = path.join(dir, 'core.db');
	const log = path.join(dir, 'events.jsonl');
	await withEnv(
		{
			SUPER_CORE_DB: db,
			ANTIFAN_CORE_BRIDGE_LOG: log,
			ANTIFAN_CORE_CLI: undefined,
			ANTIFAN_PROJECT_ROOT: undefined,
			ANTIFAN_CORE_BRIDGE_GATE: 'off',
		},
		async () => {
			const h = makePi();
			bridgeHook(h.pi);
			const ctx = { cwd: REPO };

			const prompt = 'ẩn nút Book Now bằng display none';
			const messages = await h.emitBeforeAgentStart(prompt, ctx);
			assert.equal(messages.length, 1, 'seeds a pack when gate is off');
			const msg = messages[0];
			assert.equal(msg.customType, 'antifan-core-bridge');
			assert.equal(msg.details.kind, 'core-context-pack');
			assert.match(msg.details.packId, /^pack-/);

			const seeded = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SEEDED');
			assert.equal(seeded.length, 1, 'BRIDGE_CONTEXT_SEEDED recorded');
		},
	);
});

test('general prompt seeds pack, subsequent storefront-edit clears pack and context strips earlier pack', async () => {
	const dir = tmpDir('core-bridge-seq-strip-');
	const db = path.join(dir, 'core.db');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ SUPER_CORE_DB: db, ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };

		// 1. General prompt seeds a pack
		const generalMessages = await h.emitBeforeAgentStart('general prompt to analyze system', ctx);
		assert.equal(generalMessages.length, 1, 'general prompt seeds exactly one pack message');
		assert.equal(generalMessages[0].details.kind, 'core-context-pack');
		assert.match(generalMessages[0].details.packId, /^pack-/);
		const firstPackId = generalMessages[0].details.packId;

		// 2. Storefront-edit prompt in the same session returns zero messages
		const editMessages = await h.emitBeforeAgentStart('ẩn nút Book Now bằng display none', ctx);
		assert.equal(editMessages.length, 0, 'storefront-edit prompt returns zero messages');

		// 3. context handler strips earlier pack message from conversation (reuse packMessage('pack-stale-old'))
		const results = await h.emit(
			'context',
			{ messages: [packMessage('pack-stale-old'), { role: 'user', content: 'x', timestamp: 1 }] },
			ctx,
		);
		const out = results.map((r) => r?.messages).find(Boolean);
		assert.ok(out, 'context handler returns filtered messages');
		assert.equal(out.length, 1, 'must leave only the user message');
		assert.equal(out[0].role, 'user');
		assert.equal(out[0].content, 'x');

		// Also verify that the earlier pack message from turn 1 is stripped
		const resultsFirst = await h.emit(
			'context',
			{ messages: [packMessage(firstPackId), { role: 'user', content: 'y', timestamp: 2 }] },
			ctx,
		);
		const outFirst = resultsFirst.map((r) => r?.messages).find(Boolean);
		assert.ok(outFirst, 'context handler strips previously active pack as well');
		assert.equal(outFirst.length, 1);
		assert.equal(outFirst[0].role, 'user');
		assert.equal(outFirst[0].content, 'y');
	});
});

test('storefront-edit: "xóa nút mua ngay trên mobile" returns zero messages and records BRIDGE_CONTEXT_SKIPPED', async () => {
	const dir = tmpDir('core-bridge-storefront-edit-xoa-');
	const db = path.join(dir, 'core.db');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ SUPER_CORE_DB: db, ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };

		const prompt = 'xóa nút mua ngay trên mobile';
		const messages = await h.emitBeforeAgentStart(prompt, ctx);
		assert.equal(messages.length, 0, 'storefront-edit prompt returns zero messages');

		const skipped = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SKIPPED');
		assert.equal(skipped.length, 1, 'records exactly one BRIDGE_CONTEXT_SKIPPED session entry');
		assert.equal(skipped[0].data?.intent, 'storefront-edit');

		const fileEvents = readJsonl(log).filter((r) => r.event === 'BRIDGE_CONTEXT_SKIPPED');
		assert.equal(fileEvents.length, 1, 'file log matches session entry');
	});
});

test('storefront-edit: "delete cart button from header" returns zero messages and records BRIDGE_CONTEXT_SKIPPED', async () => {
	const dir = tmpDir('core-bridge-storefront-edit-delete-');
	const db = path.join(dir, 'core.db');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ SUPER_CORE_DB: db, ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };

		const prompt = 'delete cart button from header';
		const messages = await h.emitBeforeAgentStart(prompt, ctx);
		assert.equal(messages.length, 0, 'storefront-edit prompt returns zero messages');

		const skipped = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SKIPPED');
		assert.equal(skipped.length, 1, 'records exactly one BRIDGE_CONTEXT_SKIPPED session entry');
		assert.equal(skipped[0].data?.intent, 'storefront-edit');

		const fileEvents = readJsonl(log).filter((r) => r.event === 'BRIDGE_CONTEXT_SKIPPED');
		assert.equal(fileEvents.length, 1, 'file log matches session entry');
	});
});

test('clone wins over storefront-edit: "chỉnh banner cho giống mẫu tham khảo" seeds core-context-pack', async () => {
	const dir = tmpDir('core-bridge-clone-wins-');
	const db = path.join(dir, 'core.db');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ SUPER_CORE_DB: db, ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };

		const prompt = 'chỉnh banner cho giống mẫu tham khảo';
		const messages = await h.emitBeforeAgentStart(prompt, ctx);
		assert.equal(messages.length, 1, 'clone intent wins and seeds exactly one message');
		const msg = messages[0];
		assert.equal(msg.customType, 'antifan-core-bridge');
		assert.equal(msg.details.kind, 'core-context-pack');
		assert.match(msg.details.packId, /^pack-/);

		const skipped = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SKIPPED');
		assert.equal(skipped.length, 0, 'not skipped');

		const seeded = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SEEDED');
		assert.equal(seeded.length, 1, 'BRIDGE_CONTEXT_SEEDED recorded');
	});
});

test('clone wins over storefront-edit: "chỉnh theo web đối thủ" seeds core-context-pack', async () => {
	const dir = tmpDir('core-bridge-clone-web-doi-thu-');
	const db = path.join(dir, 'core.db');
	const log = path.join(dir, 'events.jsonl');
	await withEnv({ SUPER_CORE_DB: db, ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_CORE_CLI: undefined, ANTIFAN_PROJECT_ROOT: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		const ctx = { cwd: REPO };

		const messages = await h.emitBeforeAgentStart('chỉnh header theo web đối thủ', ctx);
		assert.equal(messages.length, 1, 'reference phrasing seeds exactly one message');
		assert.equal(messages[0].details.kind, 'core-context-pack');
		assert.match(messages[0].details.packId, /^pack-/);
		assert.equal(h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SKIPPED').length, 0, 'not skipped');
	});
});
