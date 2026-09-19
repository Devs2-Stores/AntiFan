// anti-direct-policy.test.mjs - behavioral tests for AntiFan Anti-Direct Policy
//
// Verifies:
// 1. Audits exports: DECISIONS.REFUSED_CORE_RETRIEVAL_POLICY, ANTI_DIRECT_FORBIDDEN_TOOLS,
//    and isAntiDirectForbiddenTool classifier.
// 2. Bridge dual-plane arming: zero-token injection, process.env latching, and
//    BRIDGE_CONTEXT_SKIPPED event emission on /skill:anti-direct or natural language directives.
// 3. Subagent inheritance: process.env.ANTIFAN_ANTI_DIRECT=1 propagates to prompt runs.
// 4. Context message stripping: all core context packs stripped in anti-direct mode.
// 5. Session compaction preservation: antiDirect state preserved in preserveData.
// 6. Tool-call enforcement: retrieval tools blocked with REFUSED_CORE_RETRIEVAL_POLICY;
//    write and learning tools (core.record_*, core.ingest_outcome, core.receipt) remain active.
// 7. Session shutdown hygiene: env vars cleared.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_PATH = path.join(REPO, '.omp', 'hooks', 'pre', 'antifan-core-bridge.ts');
const AUDITS_PATH = path.join(REPO, '.canary', 'tools', 'fix-loop', 'audits.mjs');

const HOOK_MTS = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), 'anti-direct-hook-')),
	'antifan-core-bridge.mts'
);
fs.copyFileSync(HOOK_PATH, HOOK_MTS);
const { default: bridgeHook } = await import(pathToFileURL(HOOK_MTS).href);
const {
	DECISIONS,
	ANTI_DIRECT_FORBIDDEN_TOOLS,
	isAntiDirectForbiddenTool: auditsIsForbidden,
} = await import(pathToFileURL(AUDITS_PATH).href);

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

// ---------------------------------------------------------------------------
// 1. Audits & Declarations
// ---------------------------------------------------------------------------

test('audits exports REFUSED_CORE_RETRIEVAL_POLICY and forbidden tool list', () => {
	assert.equal(DECISIONS.REFUSED_CORE_RETRIEVAL_POLICY, 'REFUSED_CORE_RETRIEVAL_POLICY');
	assert.ok(Array.isArray(ANTI_DIRECT_FORBIDDEN_TOOLS));
	assert.ok(ANTI_DIRECT_FORBIDDEN_TOOLS.includes('core.query'));
	assert.ok(ANTI_DIRECT_FORBIDDEN_TOOLS.includes('core.recommend'));
	assert.ok(ANTI_DIRECT_FORBIDDEN_TOOLS.includes('core.receipt_v2'));
	assert.ok(ANTI_DIRECT_FORBIDDEN_TOOLS.includes('core.context_pack'));
	assert.ok(ANTI_DIRECT_FORBIDDEN_TOOLS.includes('core.find_similar'));

	// Test classifier
	assert.equal(auditsIsForbidden('core.query'), true);
	assert.equal(auditsIsForbidden('core_query'), true);
	assert.equal(auditsIsForbidden('mcp__antifan_browser_core_recommend'), true);
	assert.equal(auditsIsForbidden('core.receipt_v2'), true);

	// Write and learning tools must NOT be forbidden
	assert.equal(auditsIsForbidden('core.record_fix_pattern'), false);
	assert.equal(auditsIsForbidden('core.record_anti_pattern'), false);
	assert.equal(auditsIsForbidden('core.ingest_outcome'), false);
	assert.equal(auditsIsForbidden('core.adjudicate'), false);
	assert.equal(auditsIsForbidden('core.receipt'), false);
});

// ---------------------------------------------------------------------------
// 2. Dual-Plane Arming and Zero-Token Skip in Bridge
// ---------------------------------------------------------------------------

test('before_agent_start arms anti-direct mode and skips Core pack on skill invocation', async () => {
	delete process.env.ANTIFAN_ANTI_DIRECT;
	delete process.env.ANTIFAN_ANTI_DIRECT_ORIGIN;

	const h = makePi();
	bridgeHook(h.pi);

	await h.emit('session_start');

	const messages = await h.emitBeforeAgentStart('/skill:anti-direct');
	assert.equal(messages.length, 0, 'No pack message injected into prompt');
	assert.equal(process.env.ANTIFAN_ANTI_DIRECT, '1', 'Process env latched for child subagents');

	const skipped = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SKIPPED');
	assert.ok(skipped.length >= 1, 'Emitted BRIDGE_CONTEXT_SKIPPED');
	assert.equal(skipped[0].data.intent, 'user-direct');
	assert.equal(skipped[0].data.triggeredBy, 'user_skill_invocation');
});

test('before_agent_start arms anti-direct mode on Vietnamese natural language directive', async () => {
	delete process.env.ANTIFAN_ANTI_DIRECT;
	delete process.env.ANTIFAN_ANTI_DIRECT_ORIGIN;

	const h = makePi();
	bridgeHook(h.pi);

	await h.emit('session_start');

	const messages = await h.emitBeforeAgentStart('sửa trực tiếp nút cart không tra core');
	assert.equal(messages.length, 0, 'No pack message injected');
	assert.equal(process.env.ANTIFAN_ANTI_DIRECT, '1');

	const skipped = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SKIPPED');
	assert.ok(skipped.length >= 1);
	assert.equal(skipped[0].data.intent, 'user-direct');
	assert.equal(skipped[0].data.triggeredBy, 'natural_language');
});

test('process.env.ANTIFAN_ANTI_DIRECT=1 causes even generic prompts to skip Core pack', async () => {
	process.env.ANTIFAN_ANTI_DIRECT = '1';

	const h = makePi();
	bridgeHook(h.pi);

	await h.emit('session_start');

	const messages = await h.emitBeforeAgentStart('analyze checkout flow');
	assert.equal(messages.length, 0);

	const skipped = h.entries.filter((e) => e.data?.event === 'BRIDGE_CONTEXT_SKIPPED');
	assert.ok(skipped.length >= 1);
	assert.equal(skipped[0].data.intent, 'user-direct');
});

// ---------------------------------------------------------------------------
// 3. Context Hook Message Stripping
// ---------------------------------------------------------------------------

test('context hook strips all core context pack messages when anti-direct is active', async () => {
	delete process.env.ANTIFAN_ANTI_DIRECT;

	const h = makePi();
	bridgeHook(h.pi);

	await h.emit('session_start');
	// Arm anti-direct
	await h.emitBeforeAgentStart('anti-direct mode');

	const messages = [
		{ role: 'user', content: 'hello' },
		{
			role: 'custom',
			customType: 'antifan-core-bridge',
			content: '[AntiFan Core context pack 123]',
			details: { kind: 'core-context-pack', packId: '123' },
		},
		{ role: 'agent', content: 'ok' },
	];

	const [res] = await h.emit('context', { messages });
	assert.ok(res?.messages, 'Filtered messages returned');
	assert.equal(res.messages.length, 2);
	assert.ok(!res.messages.some((m) => m.customType === 'antifan-core-bridge'));
});

// ---------------------------------------------------------------------------
// 4. Session Compacting Preservation
// ---------------------------------------------------------------------------

test('session.compacting preserves antiDirect state', async () => {
	delete process.env.ANTIFAN_ANTI_DIRECT;

	const h = makePi();
	bridgeHook(h.pi);

	await h.emit('session_start');
	await h.emitBeforeAgentStart('/skill:anti-direct');

	const [compaction] = await h.emit('session.compacting');
	assert.ok(compaction?.preserveData);
	assert.equal(compaction.preserveData.antiDirect, true);
	assert.equal(compaction.preserveData.antiDirectTrigger, 'user_skill_invocation');
	assert.match(compaction.context[0], /anti-direct policy active/);
});

// ---------------------------------------------------------------------------
// 5. Tool Call Enforcement
// ---------------------------------------------------------------------------

test('tool_call blocks retrieval tools with REFUSED_CORE_RETRIEVAL_POLICY in anti-direct mode', async () => {
	delete process.env.ANTIFAN_ANTI_DIRECT;

	const h = makePi();
	bridgeHook(h.pi);

	await h.emit('session_start');
	await h.emitBeforeAgentStart('sửa trực tiếp không tra core');

	// Attempt core.query
	const [queryBlock] = await h.emit('tool_call', {
		toolName: 'core.query',
		input: { text: 'cart filter bug' },
	});
	assert.ok(queryBlock?.block, 'core.query is blocked');
	assert.match(queryBlock.reason, /REFUSED_CORE_RETRIEVAL_POLICY/);

	// Attempt core.recommend
	const [recBlock] = await h.emit('tool_call', {
		toolName: 'core.recommend',
		input: { task: 'filter' },
	});
	assert.ok(recBlock?.block, 'core.recommend is blocked');
	assert.match(recBlock.reason, /REFUSED_CORE_RETRIEVAL_POLICY/);

	// Attempt MCP mounted name
	const [mcpBlock] = await h.emit('tool_call', {
		toolName: 'mcp__antifan_browser_core_find_similar',
		input: { task: 'filter' },
	});
	assert.ok(mcpBlock?.block, 'MCP find_similar is blocked');
	assert.match(mcpBlock.reason, /REFUSED_CORE_RETRIEVAL_POLICY/);

	// Attempt CLI retrieval via bash
	const [cliBlock] = await h.emit('tool_call', {
		toolName: 'bash',
		input: { command: 'node scripts/antifan-core.cjs query "test"' },
	});
	assert.ok(cliBlock?.block, 'CLI query is blocked');
	assert.match(cliBlock.reason, /REFUSED_CORE_RETRIEVAL_POLICY/);
});

test('tool_call permits learning and write tools in anti-direct mode', async () => {
	delete process.env.ANTIFAN_ANTI_DIRECT;

	const h = makePi();
	bridgeHook(h.pi);

	await h.emit('session_start');
	await h.emitBeforeAgentStart('/skill:anti-direct');

	// core.record_fix_pattern is not blocked by anti-direct policy
	const [recordBlock] = await h.emit('tool_call', {
		toolName: 'core.record_fix_pattern',
		input: { before: 'a', after: 'b' },
	});
	assert.equal(recordBlock?.block ?? false, false, 'core.record_fix_pattern is permitted');

	// core.ingest_outcome is not blocked by anti-direct policy
	const [ingestBlock] = await h.emit('tool_call', {
		toolName: 'core.ingest_outcome',
		input: { task: 'fix', verdict: 'SUCCESS' },
	});
	assert.equal(ingestBlock?.block ?? false, false, 'core.ingest_outcome is permitted');
});

// ---------------------------------------------------------------------------
// 6. Session Shutdown Hygiene
// ---------------------------------------------------------------------------

test('session_shutdown clears ANTIFAN_ANTI_DIRECT environment variables', async () => {
	process.env.ANTIFAN_ANTI_DIRECT = '1';
	process.env.ANTIFAN_ANTI_DIRECT_ORIGIN = 'test-session-123';

	const h = makePi();
	bridgeHook(h.pi);

	await h.emit('session_shutdown');
	assert.equal(process.env.ANTIFAN_ANTI_DIRECT, undefined);
	assert.equal(process.env.ANTIFAN_ANTI_DIRECT_ORIGIN, undefined);
});
