const BEARER = ['Bear', 'er '].join('') + 'abcdefghij'.repeat(3);
// Behavioral tests for the bridge's budget-fitted renderer, privacy choke point,
// injection ack and episodic spool, plus the spool drain's compression contract.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_PATH = path.join(REPO, '.omp', 'hooks', 'pre', 'antifan-core-bridge.ts');
const HOOK_MTS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-fit-')), 'antifan-core-bridge.mts');
fs.copyFileSync(HOOK_PATH, HOOK_MTS);
const bridge = await import(pathToFileURL(HOOK_MTS).href);
const bridgeHook = bridge.default;
const drainMod = await import(pathToFileURL(path.join(REPO, 'scripts', 'core-spool-drain.mjs')).href);

for (const k of ['ANTIFAN_ANTI_DIRECT', 'ANTIFAN_ANTI_DIRECT_ORIGIN']) delete process.env[k];

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function withEnv(overrides, fn) {
	const saved = Object.keys(overrides).map((k) => [k, process.env[k]]);
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
	const pi = {
		on: (e, fn) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
		sendMessage() {},
		appendEntry() {},
		logger: { info() {}, warn() {}, error() {} },
	};
	const emit = async (event, payload = {}, ctx = {}) => {
		const out = [];
		for (const h of handlers.get(event) ?? []) out.push(await h({ type: event, ...payload }, ctx));
		return out;
	};
	return { pi, emit };
}

const FIXTURE_PACK = (claims, extra = {}) => ({
	packId: 'pack-fit',
	task: 't',
	platform: null,
	release: null,
	permissionScope: 'eligible-content-only',
	claims,
	conflicts: [],
	unknowns: [],
	diagnostics: null,
	generatedAt: new Date().toISOString(),
	...extra,
});
const claim = (i, len = 300) => ({ claimId: `c${i}`, kind: 'RULE', statement: `rule ${i} ${'s'.repeat(len)}`, confidence: 'observed', score: 0.6, coverage: 1, contextPlatform: null });

test('renderPack keeps the JSON body valid and conflicts/diagnostics alive over the char budget', () => {
	const conflicts = Array.from({ length: 10 }, (_, i) => ({ conflictId: `x${i}`, positionsJson: 'p'.repeat(2000) }));
	const pack = FIXTURE_PACK(Array.from({ length: 15 }, (_, i) => claim(i)), {
		conflicts,
		diagnostics: { staleClaims: 0, agingClaims: 0, gapKinds: [], pendingCount: 3, pendingTop: [{ candidateId: 'k1', statement: 'q'.repeat(900) }], healthy: false },
	});
	const r = bridge.renderPack(pack, 'th', REPO, pack.claims);
	assert.ok(r.chars <= 12_000, `chars ${r.chars}`);
	assert.equal(r.overBudget, false);
	assert.ok(r.reductions.length > 0);
	const body = r.text.slice(r.text.indexOf('{'));
	const parsed = JSON.parse(body);
	assert.ok(parsed.claims.length >= 3);
	assert.equal(parsed.claims.length, r.claimIds.length);
	assert.ok(parsed.diagnostics, 'diagnostics survive');
	assert.ok(parsed.conflicts.length >= 1, 'conflicts survive');
	assert.ok(!r.text.includes('[truncated'), 'no mid-JSON slice');
});

test('renderPack pages on store-wide lesson debt even when the pack scope owes none', () => {
	const debt = {
		staleClaims: 0, agingClaims: 0, gapKinds: [], pendingCount: 0, pendingTop: [], pendingOldestDays: 0,
		storePendingCount: 143, storePendingOldestDays: 12.4, pendingAlert: true, healthy: false,
	};
	const alerted = bridge.renderPack(FIXTURE_PACK([claim(1, 40)], { diagnostics: debt }), 'th', REPO, [claim(1, 40)]);
	assert.match(
		alerted.text,
		/\[Core Lessons: 143 lesson\(s\) awaiting adjudication store-wide, oldest 12\.4 day\(s\) — review with: node scripts\/leader\/leader-job\.mjs lessons\]/,
	);
	assert.ok(!alerted.text.includes('[Core Health: ]'), 'no empty health line when the queue is the only debt');
	const body = JSON.parse(alerted.text.slice(alerted.text.indexOf('\n{') + 1));
	assert.equal(body.diagnostics.storePendingCount, 143, 'store-wide numbers ride the JSON body');
	assert.equal(body.diagnostics.pendingCount, 0, 'the scoped slice stays scoped');

	// Below the alert thresholds the banner keeps the scoped adjudication line
	// and stays off the store-wide one.
	const quiet = { ...debt, pendingCount: 2, pendingTop: [{ candidateId: 'cand-1' }], storePendingCount: 2, storePendingOldestDays: 1, pendingAlert: false };
	const calm = bridge.renderPack(FIXTURE_PACK([claim(1, 40)], { diagnostics: quiet }), 'th', REPO, [claim(1, 40)]);
	assert.ok(!calm.text.includes('[Core Lessons:'));
	assert.match(calm.text, /\[Core Health: 2 PENDING candidate\(s\) awaiting adjudication/);
	assert.match(calm.text, /core\.adjudicate/);
});

test('renderPack leaves a small pack untouched', () => {
	const pack = FIXTURE_PACK([claim(1, 50), claim(2, 50)]);
	const r = bridge.renderPack(pack, 'th', REPO, pack.claims);
	assert.deepEqual(r.reductions, []);
	assert.deepEqual(r.claimIds, ['c1', 'c2']);
});

test('sanitizeText strips private blocks (nested, unclosed kept) and redacts secrets', () => {
	assert.equal(bridge.stripPrivateBlocks('a <private>b <private>c</private> d</private> e').text, 'a  e');
	assert.equal(bridge.stripPrivateBlocks('explain how <private> works').text, 'explain how ', 'an unclosed <private> drops the rest');
	const s = bridge.sanitizeText(`x ${BEARER} and password: hunter2 and hatch_sess=XYZ123 y`);
	assert.ok(!/abcdefghijabcdefghij|hunter2|XYZ123/.test(s), s);
	assert.match(s, /\[REDACTED:/);
});

test('renderPack redacts secrets in statements at the pack boundary', () => {
	const pack = FIXTURE_PACK([{ ...claim(1, 10), statement: 'use token: sk-abcdefghijklmnopqrstuvwx now' }]);
	const r = bridge.renderPack(pack, 'th', REPO, pack.claims);
	assert.ok(!r.text.includes('sk-abcdefghijklmnop'));
});

test('bridge redaction handles quoted, single-quoted, JSON-escaped and prefixed values like Core', () => {
	const cases = [
		'password="hunter 2 spaces"', "token='abc 123'", 'api_key: "k-999"', 'DB_PASSWORD=plainvalue', 'export TOKEN=abc123xyz',
		String.raw`{"cmd":"export TOKEN=\"abc 123xyz\" && run"}`, '{"password":"quoted-json-value"}', "{'secret': 'single'}",
		'ANTIFAN_SECRET_X="has space"', 'hatch_sess="cookie value"',
	];
	for (const input of cases) {
		const out = bridge.sanitizeText(`before ${input} after`);
		assert.ok(!/hunter|abc 123|abc123|k-999|plainvalue|quoted-json|single|has space|cookie value|spaces/.test(out), `${input} -> ${out}`);
		assert.match(out, /\[REDACTED:/);
		assert.ok(out.startsWith('before ') && out.endsWith(' after'), `${input} -> ${out}`);
	}
});

test('bridge pairs private tags by name and fails closed on an unclosed <private>', () => {
	assert.equal(bridge.stripPrivateBlocks('a <private>SECRET</system-reminder> LEAK').text, 'a ');
	assert.equal(bridge.stripPrivateBlocks('a <private>S</antifan-context> L</private> b').text, 'a  b');
	assert.equal(bridge.stripPrivateBlocks('x <system-reminder> prose').text, 'x <system-reminder> prose');
});

test('renderPack sanitizes statements before the cap cuts them', () => {
	const long = `${'a'.repeat(40)} <private>${'S'.repeat(30)}</private> tail`;
	const pack = FIXTURE_PACK([{ ...claim(1, 10), statement: long }]);
	const r = bridge.renderPack(pack, 'th', REPO, pack.claims);
	assert.ok(!r.text.includes('SSSSSS'));
});

function recordingPackStub(dir, packJson) {
	const calls = path.join(dir, 'calls.jsonl');
	const stub = path.join(dir, 'stub-cli.cjs');
	fs.writeFileSync(
		stub,
		`const fs=require('node:fs');const raw=process.argv[3]==='-'?fs.readFileSync(0,'utf8'):process.argv[3];` +
			`fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({cmd:process.argv[2],args:JSON.parse(raw||'{}')})+'\\n');` +
			`if(process.argv[2]==='pack')console.log(${JSON.stringify(JSON.stringify(packJson))});else console.log('{}');`,
	);
	return { stub, calls: () => readJsonl(calls) };
}

test('seeded pack reports the rendered claim ids to Core through a detached inject-ack', async () => {
	const dir = tmp('bridge-ack-');
	const pack = FIXTURE_PACK(Array.from({ length: 4 }, (_, i) => claim(i, 60)));
	const rec = recordingPackStub(dir, pack);
	const log = path.join(dir, 'events.jsonl');
	await withEnv(
		{ ANTIFAN_CORE_CLI: rec.stub, ANTIFAN_CORE_BRIDGE_LOG: log, ANTIFAN_PROJECT_ROOT: undefined, SUPER_CORE_DB: undefined, ANTIFAN_CORE_PACK_ID: undefined, ANTIFAN_CORE_MIN_SCORE: '0', ANTIFAN_CORE_MIN_COVERAGE: '0', ANTIFAN_CORE_MIN_INJECT_CLAIMS: '1', ANTIFAN_CORE_INJECT_KINDS: '*' },
		async () => {
			const h = makePi();
			bridgeHook(h.pi);
			const out = await h.emit('before_agent_start', { prompt: 'fix the package.json name field' }, { cwd: REPO });
			const msg = out[0].message;
			assert.equal(msg.details.claimCount, 4);
			const seeded = readJsonl(log).find((r) => r.event === 'BRIDGE_CONTEXT_SEEDED');
			assert.deepEqual(seeded.claimIds, ['c0', 'c1', 'c2', 'c3']);
			assert.ok(seeded.packChars > 0);
			let ack;
			for (let i = 0; i < 60 && !ack; i += 1) {
				ack = rec.calls().find((c) => c.cmd === 'inject-ack');
				if (!ack) await new Promise((r) => setTimeout(r, 100));
			}
			assert.ok(ack, 'inject-ack was sent');
			assert.deepEqual(ack.args.claimIds, ['c0', 'c1', 'c2', 'c3']);
			assert.equal(ack.args.packId, 'pack-fit');
			// The pack id is exported per bash call that runs leader-job, never through process.env.
			assert.equal(process.env.ANTIFAN_CORE_PACK_ID, undefined);
			const leaderCall = { toolName: 'bash', input: { command: 'node scripts/leader/leader-job.mjs close --job j' } };
			await h.emit('tool_call', leaderCall, { cwd: REPO });
			assert.equal(leaderCall.input.command, 'export ANTIFAN_CORE_PACK_ID=pack-fit; node scripts/leader/leader-job.mjs close --job j');
			const other = { toolName: 'bash', input: { command: 'echo hi' } };
			await h.emit('tool_call', other, { cwd: REPO });
			assert.equal(other.input.command, 'echo hi');
		},
	);
});

test('tool_result spools sanitized lines synchronously with no spawn; agent_end launches exactly one drain', async () => {
	const root = tmp('bridge-spool-');
	fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
	const marker = path.join(root, 'drain-argv.json');
	fs.writeFileSync(path.join(root, 'scripts', 'core-spool-drain.mjs'), `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2))+'\\n');`);
	const rec = recordingPackStub(root, FIXTURE_PACK([]));
	fs.copyFileSync(rec.stub, path.join(root, 'scripts', 'antifan-core.cjs'));
	await withEnv(
		{ ANTIFAN_PROJECT_ROOT: root, ANTIFAN_CORE_CLI: undefined, ANTIFAN_CORE_BRIDGE_LOG: 'off', ANTIFAN_CORE_OBSERVER_URL: 'http://127.0.0.1:1/v1', ANTIFAN_CORE_EPISODES: undefined },
		async () => {
			const h = makePi();
			bridgeHook(h.pi);
			const ctx = { cwd: root, sessionManager: { getSessionId: () => 'sess-1' } };
			const t0 = performance.now();
			await h.emit('tool_result', { toolName: 'bash', input: { command: 'echo hi' }, content: [{ type: 'text', text: `ok <private>cookie 123</private> ${BEARER} done` }], isError: false, toolCallId: 't1' }, ctx);
			await h.emit('tool_result', { toolName: 'edit', input: { path: 'a.liquid' }, content: 'edited a.liquid', toolCallId: 't2' }, ctx);
			await h.emit('tool_result', { toolName: 'edit', input: { path: 'a.liquid' }, content: 'edited a.liquid', toolCallId: 't3' }, ctx); // duplicate (tool,input)
			await h.emit('tool_result', { toolName: 'todo_write', input: {}, content: 'x' }, ctx); // skip tool
			await h.emit('tool_result', { toolName: 'core.query', input: {}, content: 'x' }, ctx); // no recursion
			await h.emit('tool_result', { toolName: 'read', input: { path: 'b' }, content: 'tiny' }, ctx); // small read
			await h.emit('tool_result', { toolName: 'bash', input: { command: 'true' }, content: '' }, ctx); // empty
			assert.ok(performance.now() - t0 < 250, 'handlers stay cheap');
			const spool = path.join(root, '.canary', 'core-bridge', 'spool', 'sess-1.jsonl');
			const lines = readJsonl(spool);
			assert.equal(lines.length, 2);
			const raw = fs.readFileSync(spool, 'utf8');
			assert.ok(!/cookie 123|abcdefghijabcdefghij|<private>/.test(raw), raw);
			assert.equal(rec.calls().length, 0, 'tool_result never spawns the CLI');
			await h.emit('agent_end', { messages: [{ id: 'm1' }] }, ctx);
			await h.emit('agent_end', { messages: [{ id: 'm2' }] }, ctx);
			for (let i = 0; i < 60 && !fs.existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 100));
			assert.ok(fs.existsSync(marker), 'drain launched');
			assert.equal(readJsonl(marker).length, 1, 'second agent_end had nothing new to drain');
		},
	);
});

test('without ANTIFAN_CORE_OBSERVER_URL nothing is spooled', async () => {
	const root = tmp('bridge-nospool-');
	fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
	await withEnv({ ANTIFAN_PROJECT_ROOT: root, ANTIFAN_CORE_BRIDGE_LOG: 'off', ANTIFAN_CORE_OBSERVER_URL: undefined }, async () => {
		const h = makePi();
		bridgeHook(h.pi);
		await h.emit('tool_result', { toolName: 'bash', input: { command: 'x' }, content: 'out' }, { cwd: root });
		assert.ok(!fs.existsSync(path.join(root, '.canary')));
	});
});

// ---- drain / compression --------------------------------------------------

const cfg = { baseUrl: 'http://gw/v1', model: 'm', apiKey: 'KEYVALUE', maxCharsPerCall: 24000, timeoutMs: 5000, dayTokens: 1000 };
const EV = (n) => Array.from({ length: n }, (_, i) => ({ tool: 'edit', input: `{"path":"f${i}"}`, out: `changed f${i}`, err: false, files: [`f${i}`] }));
const reply = (content, tokens = 10) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: tokens } }) });
const VALID = JSON.stringify([{ type: 'bugfix', title: 'Fix X', facts: ['a'], narrative: 'n' }, { type: 'gotcha', title: 'Y', narrative: 'm' }]);

test('compressEvents: valid, restate-retry, double-invalid and prefix invariance', async () => {
	const bodies = [];
	const mk = (replies) => async (_u, init) => {
		bodies.push(JSON.parse(init.body));
		return reply(replies.shift());
	};
	const a = await drainMod.compressEvents(cfg, EV(3), { fetchImpl: mk([VALID]) });
	assert.equal(a.ok, true);
	assert.equal(a.episodes.length, 2);
	const b = await drainMod.compressEvents(cfg, EV(3), { fetchImpl: mk(['sure!', VALID]) });
	assert.equal(b.episodes.length, 2);
	assert.equal(b.tokens, 20);
	const c = await drainMod.compressEvents(cfg, EV(3), { fetchImpl: mk(['prose', 'prose again']) });
	assert.equal(c.ok, false);
	assert.deepEqual(c.episodes, []);
	const d = await drainMod.compressEvents(cfg, EV(7), { fetchImpl: mk([VALID]) });
	assert.equal(d.ok, true);
	const sys = bodies.map((x) => x.messages[0].content);
	assert.ok(sys.every((s) => s === sys[0]), 'system prompt is byte-stable');
	assert.ok(!JSON.stringify(bodies).includes('KEYVALUE'), 'key never in the body');
});

test('parseEpisodes rejects bad types, redacts secrets, counts skips', () => {
	assert.equal(drainMod.parseEpisodes('[{"type":"nope","title":"t"}]'), null);
	const r = drainMod.parseEpisodes(`\`\`\`json\n[{"skip":"noise"},{"type":"change","title":"uses ${BEARER}"}]\n\`\`\``);
	assert.equal(r.skipped, 1);
	assert.ok(!r.episodes[0].title.includes('abcdefghijabcdefghij'));
});

test('drain stores episodes once, takes the lock, honors the day ceiling and fails open', async () => {
	const dir = tmp('drain-');
	fs.writeFileSync(path.join(dir, 's1.jsonl'), EV(3).map((e) => JSON.stringify(e)).join('\n') + '\n');
	const stored = [];
	const env = { ANTIFAN_CORE_OBSERVER_URL: 'http://gw/v1', ANTIFAN_CORE_OBSERVER_MODEL: 'm' };
	const fetchImpl = async () => reply(VALID, 50);
	const s = await drainMod.drain({ spoolDir: dir, env, fetchImpl, store: (sid, ss) => (stored.push([sid, ss]), true) });
	assert.equal(s.episodes, 2);
	assert.equal(s.summaries, 1);
	assert.deepEqual(stored.map((x) => x[0]), ['s1']);
	assert.match(stored[0][1].learned, /Fix X: n/);
	assert.match(stored[0][1].notes, /UNVERIFIED/);
	assert.ok(Number.isInteger(stored[0][1].segment));
	assert.ok(fs.readdirSync(dir).some((n) => n.endsWith('.done')));
	assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.jsonl') || n === '.drain.lock'));
	// locked
	fs.writeFileSync(path.join(dir, '.drain.lock'), '1');
	fs.writeFileSync(path.join(dir, 's2.jsonl'), JSON.stringify(EV(1)[0]) + '\n');
	assert.equal((await drainMod.drain({ spoolDir: dir, env, fetchImpl, store: () => true })).locked, true);
	fs.rmSync(path.join(dir, '.drain.lock'));
	// disabled without config
	assert.equal((await drainMod.drain({ spoolDir: dir, env: {}, fetchImpl })).disabled, true);
	// ceiling
	fs.writeFileSync(path.join(dir, 'observer-tokens.json'), JSON.stringify({ day: new Date().toISOString().slice(0, 10), tokens: 999999 }));
	const c = await drainMod.drain({ spoolDir: dir, env, fetchImpl, store: () => true });
	assert.equal(c.episodes, 0);
	assert.equal(c.discarded, 1);
	// gateway failure discards, does not throw
	fs.writeFileSync(path.join(dir, 's3.jsonl'), JSON.stringify(EV(1)[0]) + '\n');
	fs.rmSync(path.join(dir, 'observer-tokens.json'));
	const f = await drainMod.drain({ spoolDir: dir, env, fetchImpl: async () => { throw new Error('down'); }, store: () => true });
	assert.equal(f.episodes, 0);
});
