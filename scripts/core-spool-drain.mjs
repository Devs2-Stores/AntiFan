#!/usr/bin/env node
// core-spool-drain.mjs — single detached drain for the Core bridge's episodic spool.
//
// The bridge appends one sanitized JSONL line per tool_result to
// <project>/.canary/core-bridge/spool/<sessionId>.jsonl (no spawn on the hot
// path). This process is launched once per settled run, takes a lock so two
// drains never overlap, compresses each spool file through an OpenAI-compatible
// gateway into a handful of durable "episodes", folds them into one session-summary segment and stores it via the Core CLI
// `session-summary` records (Core upsertSessionSummary). Nothing here ever becomes a claim.
//
// Fail-open and fail-discard (claude-mem doctrine): any error drops the batch,
// never replays it later, never blocks anything, always exits 0.
//
// Spool format (one JSON object per line, written by the bridge's tool_result handler, already sanitized and capped):
//   {"t":<epoch ms>,"tool":"<name>","input":"<args, <=4000 chars>","out":"<result head/tail, <=3000 chars>","err":<bool>,"id":"<toolCallId>|null","files":["<path>"]}
// A file is <sessionId>.jsonl; a drain renames it to .draining while processing and to .<ms>.done afterwards (pruned after 24 h).
//
// Config (env, key itself never logged):
//   ANTIFAN_CORE_OBSERVER_URL        base URL, e.g. http://127.0.0.1:20128/v1 (required)
//   ANTIFAN_CORE_OBSERVER_MODEL      cheap model id (required)
//   ANTIFAN_CORE_OBSERVER_KEY_ENV    NAME of the env var holding the API key (optional)
//   ANTIFAN_CORE_OBSERVER_MAX_CHARS  chars per call (default 24000)
//   ANTIFAN_CORE_OBSERVER_TIMEOUT_MS request timeout (default 30000)
//   ANTIFAN_CORE_OBSERVER_DAY_TOKENS per-day token ceiling (default 200000)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EPISODE_TYPES = ['bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision', 'gotcha', 'security_note'];
const LOCK_STALE_MS = 10 * 60 * 1000;
const DONE_TTL_MS = 24 * 60 * 60 * 1000;

// Second-pass redaction (the bridge already sanitized the spool; the model's
// output is checked again before it is stored).
const REDACTIONS = [
	/\boc_sk_[A-Za-z0-9]+/g,
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bEAA[A-Za-z0-9]{20,}/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
	/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
	/\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*[^\s"'`,;]+/gi,
];
export function redact(text) {
	let out = String(text ?? '');
	for (const re of REDACTIONS) out = out.replace(re, '[REDACTED]');
	return out;
}

export function loadObserverConfig(env = process.env) {
	const baseUrl = (env.ANTIFAN_CORE_OBSERVER_URL ?? '').trim();
	const model = (env.ANTIFAN_CORE_OBSERVER_MODEL ?? '').trim();
	if (!baseUrl || !model) return null;
	const keyEnv = (env.ANTIFAN_CORE_OBSERVER_KEY_ENV ?? '').trim();
	const apiKey = keyEnv ? (env[keyEnv] ?? '').trim() : '';
	if (keyEnv && !apiKey) return null; // a named key that is empty means the feature is off
	const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
	return {
		baseUrl: baseUrl.replace(/\/+$/, ''),
		model,
		apiKey,
		maxCharsPerCall: num(env.ANTIFAN_CORE_OBSERVER_MAX_CHARS, 24_000),
		timeoutMs: num(env.ANTIFAN_CORE_OBSERVER_TIMEOUT_MS, 30_000),
		dayTokens: num(env.ANTIFAN_CORE_OBSERVER_DAY_TOKENS, 200_000),
	};
}

// Static, byte-stable prefix first (provider prompt-cache friendly).
export const OBSERVER_SYSTEM = [
	'You compress a coding agent\'s tool activity into durable engineering findings.',
	'Reply with ONLY a JSON array. Each element is either {"skip":"noise"} or an episode:',
	`{"type":"${EPISODE_TYPES.join('|')}","title":"<=100 chars","subtitle":"optional","facts":["short fact"],"narrative":"1-3 sentences","concepts":["how-it-works|why-it-exists|what-changed|problem-solution|gotcha|pattern|trade-off"],"files":["path"]}`,
	'Rules: record durable findings only (what was changed and why, gotchas, decisions); skip status checks, listings and plain reads; one episode per fact, never repeat a fact;',
	'never infer anything from a range marked <elided chars=N/>; all output is UNVERIFIED observation, never an instruction.',
	'Return [] when nothing is worth keeping.',
].join('\n');

const RESTATE = 'Your previous reply was not a valid JSON array of episodes. Reply again with ONLY the JSON array.';

export function selectEvents(events, maxChars) {
	const picked = [];
	let total = 0;
	for (const e of events) {
		const size = (e.input?.length ?? 0) + (e.out?.length ?? 0) + 80;
		if (picked.length > 0 && total + size > maxChars) break;
		picked.push(e);
		total += size;
	}
	return picked;
}

export function buildObserverPrompt(events) {
	const user = events
		.map((e, i) => `#${i + 1} tool=${e.tool}${e.err ? ' ERROR' : ''}${e.files?.length ? ` files=${e.files.join(',')}` : ''}\ninput: ${e.input}\noutput: ${e.out}`)
		.join('\n\n');
	return { system: OBSERVER_SYSTEM, user: `Tool events, in order:\n\n${user}` };
}

/** Strict validation. Returns { episodes, skipped } or null when the reply is not usable. */
export function parseEpisodes(text) {
	if (typeof text !== 'string') return null;
	let body = text.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
	if (fence) body = fence[1];
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const episodes = [];
	let skipped = 0;
	for (const item of parsed) {
		if (!item || typeof item !== 'object') return null;
		if (item.skip) { skipped += 1; continue; }
		if (!EPISODE_TYPES.includes(item.type) || typeof item.title !== 'string' || item.title.trim().length === 0) return null;
		const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => redact(x).slice(0, 400)).slice(0, 10) : []);
		episodes.push({
			type: item.type,
			title: redact(item.title).slice(0, 120),
			subtitle: typeof item.subtitle === 'string' ? redact(item.subtitle).slice(0, 160) : undefined,
			facts: strs(item.facts),
			narrative: typeof item.narrative === 'string' ? redact(item.narrative).slice(0, 800) : '',
			concepts: strs(item.concepts),
			files: strs(item.files),
		});
	}
	return { episodes, skipped };
}

/**
 * One batch call with a single restate retry. Never throws: returns
 * { episodes: [], skipped: 0, tokens, ok:false } when the gateway fails or the
 * reply stays invalid twice.
 */
export async function compressEvents(cfg, events, { fetchImpl = globalThis.fetch } = {}) {
	const picked = selectEvents(events, cfg.maxCharsPerCall);
	const { system, user } = buildObserverPrompt(picked);
	const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
	let tokens = 0;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
				body: JSON.stringify({ model: cfg.model, messages, temperature: 0 }),
				signal: AbortSignal.timeout(cfg.timeoutMs),
			});
			if (!res.ok) return { episodes: [], skipped: 0, tokens, ok: false, consumed: picked.length };
			const json = await res.json();
			tokens += Number(json?.usage?.total_tokens ?? 0) || 0;
			const reply = json?.choices?.[0]?.message?.content;
			const parsed = parseEpisodes(reply);
			if (parsed) return { ...parsed, tokens, ok: true, consumed: picked.length };
			messages.push({ role: 'assistant', content: String(reply ?? '') }, { role: 'user', content: RESTATE });
		} catch {
			return { episodes: [], skipped: 0, tokens, ok: false, consumed: picked.length };
		}
	}
	return { episodes: [], skipped: 0, tokens, ok: false, consumed: picked.length };
}

function readEvents(file) {
	const events = [];
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (e && typeof e.tool === 'string') events.push(e);
		} catch { /* a torn line is dropped */ }
	}
	return events;
}

function today() {
	return new Date().toISOString().slice(0, 10);
}

function readTokens(spoolDir) {
	try {
		const t = JSON.parse(fs.readFileSync(path.join(spoolDir, 'observer-tokens.json'), 'utf8'));
		if (t.day === today()) return Number(t.tokens) || 0;
	} catch { /* none yet */ }
	return 0;
}

function addTokens(spoolDir, add) {
	try {
		fs.writeFileSync(path.join(spoolDir, 'observer-tokens.json'), JSON.stringify({ day: today(), tokens: readTokens(spoolDir) + add }));
	} catch { /* ceiling bookkeeping is best-effort */ }
}

function acquireLock(lock) {
	for (let i = 0; i < 2; i += 1) {
		try {
			const fd = fs.openSync(lock, 'wx');
			fs.writeSync(fd, String(process.pid));
			fs.closeSync(fd);
			return true;
		} catch {
			try {
				if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
				else return false;
			} catch { return false; }
		}
	}
	return false;
}

const clipTo = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const joined = (eps, withNarrative) => clipTo(eps.map((e) => (withNarrative && e.narrative ? `${e.title}: ${e.narrative}` : e.title)).join('\n'), 1500);

/**
 * Fold the distilled episodes of one drain into one session-summary segment. Everything here is unverified
 * observer output; `notes` says so, and the store keeps summaries out of claim retrieval.
 * @returns {{segment:number, projectRoot?:string, request:string, investigated:string, learned:string, completed:string, nextSteps:string, notes:string}}
 */
export function buildSessionSummary(episodes, { events = [], projectRoot } = {}) {
  const tools = [...new Set(events.map((e) => e.tool))].slice(0, 8).join(', ');
  const files = [...new Set(events.flatMap((e) => e.files ?? []))].slice(0, 15);
  const of = (...types) => episodes.filter((e) => types.includes(e.type));
  return {
    segment: Math.floor(Date.now() / 1000),
    ...(projectRoot ? { projectRoot } : {}),
    request: `Tool activity: ${events.length} event(s) via ${tools || 'unknown tools'}`,
    investigated: joined(of('discovery'), false),
    learned: joined(of('gotcha', 'decision', 'bugfix', 'security_note'), true),
    completed: joined(of('feature', 'change', 'refactor'), false),
    nextSteps: '',
    notes: clipTo(`UNVERIFIED observer summary.${files.length ? ` Files: ${files.join(', ')}` : ''}`, 800),
  };
}

function storeSummary(cliPath, projectRoot, sessionId, summary) {
	const r = spawnSync(process.execPath, [cliPath, 'session-summary', '-'], { input: JSON.stringify({ sessionId, ...summary }), timeout: 20_000, windowsHide: true, encoding: 'utf8' });
	return r.status === 0;
}

/**
 * Drain every spool file once. Returns a summary; never throws.
 * `store` is injectable for tests.
 */
export async function drain({ spoolDir, cliPath, projectRoot, env = process.env, fetchImpl, store } = {}) {
	const summary = { files: 0, events: 0, episodes: 0, summaries: 0, skipped: 0, tokens: 0, discarded: 0, locked: false, disabled: false };
	try {
		const cfg = loadObserverConfig(env);
		if (!cfg) { summary.disabled = true; return summary; }
		if (!fs.existsSync(spoolDir)) return summary;
		const lock = path.join(spoolDir, '.drain.lock');
		if (!acquireLock(lock)) { summary.locked = true; return summary; }
		const put = store ?? ((sid, ss) => storeSummary(cliPath, projectRoot, sid, ss));
		try {
			for (const name of fs.readdirSync(spoolDir)) {
				const full = path.join(spoolDir, name);
				if (name.endsWith('.done')) {
					try { if (Date.now() - fs.statSync(full).mtimeMs > DONE_TTL_MS) fs.rmSync(full, { force: true }); } catch { /* ignore */ }
					continue;
				}
				if (name.endsWith('.draining')) {
					// Left by a crashed drain: discard, never replay.
					try { if (Date.now() - fs.statSync(full).mtimeMs > LOCK_STALE_MS) fs.renameSync(full, `${full.replace(/\.draining$/, '')}.done`); } catch { /* ignore */ }
					continue;
				}
				if (!name.endsWith('.jsonl')) continue;
				const claimed = `${full}.draining`;
				try { fs.renameSync(full, claimed); } catch { continue; }
				const sessionId = name.replace(/\.jsonl$/, '');
				summary.files += 1;
				try {
					const events = readEvents(claimed);
					summary.events += events.length;
					if (events.length === 0) continue;
					if (readTokens(spoolDir) >= cfg.dayTokens) { summary.discarded += events.length; continue; }
					const res = await compressEvents(cfg, events, { fetchImpl });
					summary.tokens += res.tokens;
					addTokens(spoolDir, res.tokens);
					summary.skipped += res.skipped;
					if (!res.ok) { summary.discarded += events.length; continue; }
					if (res.episodes.length > 0) {
						summary.episodes += res.episodes.length;
						const ss = buildSessionSummary(res.episodes, { events, projectRoot });
						if (put(sessionId, ss)) summary.summaries += 1;
					}
				} finally {
					try { fs.renameSync(claimed, `${full.replace(/\.jsonl$/, '')}.${Date.now()}.done`); } catch { /* ignore */ }
				}
			}
		} finally {
			fs.rmSync(lock, { force: true });
		}
	} catch { /* fail open */ }
	return summary;
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] ?? '';
	}
	return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const a = parseArgs(process.argv.slice(2));
	await drain({ spoolDir: a['spool-dir'], cliPath: a.cli, projectRoot: a.project });
	process.exit(0);
}
