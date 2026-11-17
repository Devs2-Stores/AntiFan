// Privacy choke point for every Core write path: strips <private>-style blocks
// and redacts secret-shaped text BEFORE anything reaches SQLite.
// ANTIFAN_CORE_REDACT=off disables redaction (not tag stripping).

export interface RedactionConfig {
  patterns: Array<{ name: string; re: RegExp }>;
  excludedProjects: string[];
}

const STRIP_TAGS = ['private', 'antifan-context', 'system-reminder', 'persisted-output'] as const;
const TAG_RE = new RegExp(`<(/)?(${STRIP_TAGS.join('|')})(?:\\s[^>]*)?>`, 'gi');

/** Value of an assignment: quoted (plain or JSON-escaped), else a run of non-space characters. */
const SECRET_VALUE = String.raw`(?:\\?"[^"\n]*\\?"|'[^'\n]*'|\S+)`;
const KEY_SEP = String.raw`["']?\s*[:=]\s*`;
const BUILTIN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'oc-key', re: /\boc_sk_[A-Za-z0-9]+/g },
  { name: 'sk-key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'meta-token', re: /\bEAA[A-Za-z0-9]{20,}/g },
  { name: 'jwt', re: /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: 'hatch', re: new RegExp(String.raw`\bhatch_(?:sess|native_auth_device|gw|vml)${KEY_SEP}${SECRET_VALUE}`, 'gi') },
  { name: 'antifan-secret', re: new RegExp(String.raw`\bANTIFAN_SECRET_[A-Z0-9_]+${KEY_SEP}${SECRET_VALUE}`, 'g') },
  { name: 'assign', re: new RegExp(String.raw`(?:password|passwd|secret|api[_-]?key|token)${KEY_SEP}${SECRET_VALUE}`, 'gi') },
];

const redactionOff = (env: NodeJS.ProcessEnv) => String(env.ANTIFAN_CORE_REDACT ?? '').toLowerCase() === 'off';

export function defaultRedactionConfig(env: NodeJS.ProcessEnv = process.env): RedactionConfig {
  const patterns = redactionOff(env) ? [] : BUILTIN_PATTERNS.map((p) => ({ name: p.name, re: new RegExp(p.re.source, p.re.flags) }));
  if (!redactionOff(env)) {
    const extra = String(env.ANTIFAN_CORE_REDACT_PATTERNS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    extra.forEach((src, i) => {
      try { patterns.push({ name: `custom${i + 1}`, re: new RegExp(src, 'g') }); } catch { /* invalid user regex: ignored */ }
    });
  }
  const excludedProjects = String(env.ANTIFAN_CORE_EXCLUDED_PROJECTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { patterns, excludedProjects };
}

/** True when `projectRoot` equals or sits under an excluded root (component-wise, case-insensitive). */
export function isExcludedProject(projectRoot: string | null | undefined, cfg: RedactionConfig = defaultRedactionConfig()): boolean {
  if (!projectRoot) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\\/g, '/').replace(/\/+$/g, '');
  const p = norm(projectRoot);
  return cfg.excludedProjects.some((e) => {
    const n = norm(e);
    return n !== '' && (p === n || p.startsWith(`${n}/`));
  });
}

/**
 * Linear balanced scanner: an open tag pairs only with a close tag of the SAME
 * name (nested same-name tags count by depth), so `<private>…</system-reminder>`
 * cannot close. A `<private>` that never closes fails closed: the rest of the
 * string is dropped. Other tags left unclosed in prose are left alone.
 */
export function stripPrivate(text: string): { text: string; blocks: number } {
  if (typeof text !== 'string' || text.indexOf('<') < 0) return { text, blocks: 0 };
  const tokens: Array<{ idx: number; end: number; close: boolean; name: string }> = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text))) {
    tokens.push({ idx: m.index, end: m.index + m[0].length, close: !!m[1], name: m[2].toLowerCase() });
  }
  let out = '';
  let pos = 0;
  let blocks = 0;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.close) { i += 1; continue; }
    let depth = 1;
    let j = i + 1;
    for (; j < tokens.length; j++) {
      if (tokens[j].name !== t.name) continue;
      depth += tokens[j].close ? -1 : 1;
      if (depth === 0) break;
    }
    if (j < tokens.length) {
      out += text.slice(pos, t.idx);
      pos = tokens[j].end;
      blocks += 1;
      i = j + 1;
    } else if (t.name === 'private') {
      out += text.slice(pos, t.idx);
      return { text: out, blocks: blocks + 1 };
    } else {
      i += 1;
    }
  }
  return { text: out + text.slice(pos), blocks };
}

export function redactSecrets(text: string, cfg: RedactionConfig = defaultRedactionConfig()): { text: string; hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  let out = text;
  for (const p of cfg.patterns) {
    out = out.replace(new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`), () => {
      hits[p.name] = (hits[p.name] ?? 0) + 1;
      return `[REDACTED:${p.name}]`;
    });
  }
  return { text: out, hits };
}

export function sanitizeText(text: string, cfg: RedactionConfig = defaultRedactionConfig()): { text: string; blocks: number; hits: Record<string, number> } {
  const stripped = stripPrivate(text);
  const red = redactSecrets(stripped.text, cfg);
  return { text: red.text, blocks: stripped.blocks, hits: red.hits };
}

/** Deep, non-mutating: every string value is sanitized, object keys are kept. */
export function sanitizeJson<T>(value: T, cfg: RedactionConfig = defaultRedactionConfig()): T {
  if (typeof value === 'string') return sanitizeText(value, cfg).text as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeJson(v, cfg)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeJson(v, cfg);
    return out as T;
  }
  return value;
}
