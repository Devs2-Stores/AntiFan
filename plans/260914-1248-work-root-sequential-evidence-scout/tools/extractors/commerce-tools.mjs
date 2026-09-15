// v4 intelligence-layer producer: commercial-intel.jsonl, tool-intel.jsonl,
// skill-versions.jsonl. Evidence-anchored only — a row is emitted only when
// real file content or filenames support it; an empty-evidence unit correctly
// returns empty ledgers. No deps beyond node builtins.
//
// Contract (see deep-analyze-unit.mjs):
//   extract(ctx) -> { claims: [], ledgers: { '<file>.jsonl': [rows] } }
//   ctx = { unitId, unit, files, platform, claims, ev, gitEv, cid, did, depId, unitAbs, REGISTER }
// Every ledger row carries unitId so the orchestrator can rewrite per-unit.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const EXTRACTOR = 'extract/commerce-tools';
const MAX_BYTES = 256 * 1024;
const MAX_COMMERCIAL_FILES = 20;
const MAX_TOOLS = 25;
const MAX_SKILL_MDS = 3;
const MAX_CHANGELOG_FILES = 5;
const MAX_VERSIONS = 12;

// ---------- small helpers ----------

const sha12 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const mkId = (prefix, unitId, s) => `${prefix}-${sha12(`${unitId}|${s}`)}`;

// Bounded read: never pulls more than maxBytes, survives missing/huge files.
function readSlice(p, maxBytes = MAX_BYTES) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const size = Math.min(maxBytes, fs.fstatSync(fd).size);
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
  }
}

const base = (p) => path.basename(p ?? '').toLowerCase();
const ext = (p) => path.extname(p ?? '').toLowerCase();
const segs = (rel) => String(rel ?? '').split(/[\\/]+/).filter(Boolean);

// Extensions whose bytes are safe to regex as text.
const PARSEABLE_EXT = new Set([
  '.md', '.markdown', '.txt', '.rst', '.html', '.htm', '.csv', '.tsv',
  '.json', '.jsonl', '.yml', '.yaml', '.xml', '.toml', '.ini', '.cfg', '.log',
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.py', '.rb', '.php',
  '.sh', '.bash', '.ps1', '.bat', '.cmd', '.liquid', '.css', '.scss', '.sql',
  '.graphql', '.vue', '.svelte', '.env',
]);
// Document-like names that may carry commercial meaning even when binary.
const DOC_EXT = new Set([
  '.md', '.markdown', '.txt', '.rst', '.html', '.htm', '.csv',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx', '.odt',
]);
const SCRIPT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.py', '.rb', '.php',
  '.sh', '.bash', '.ps1', '.bat', '.cmd',
]);

const isParseable = (f) => PARSEABLE_EXT.has(ext(f.path)) || ext(f.path) === '';
const isDoc = (f) => DOC_EXT.has(ext(f.path)) || ext(f.path) === '';

// ---------- claim plumbing ----------

function makeCtx(ctx) {
  const unitId = ctx.unitId;
  const ev = (f, anchor) => (typeof ctx.ev === 'function'
    ? ctx.ev(f, anchor)
    : { entryId: f?.entryId ?? null, revision: f?.sha256 ?? null, path: f?.relPath ?? null, anchor });
  const cid = (s) => (typeof ctx.cid === 'function' ? ctx.cid(s) : mkId('c', unitId, s));
  const out = [];
  const claim = (statement, kind, evidenceRefs, extra = {}) => {
    const c = {
      claimId: cid(statement + (evidenceRefs[0]?.anchor ?? '')),
      unitId, statement, kind, evidenceRefs,
      counterEvidence: [],
      context: { platform: ctx.platform ?? null, version: null },
      extractorVersion: EXTRACTOR,
      status: 'OBSERVED',
      confidence: 'observed',
      sourceKind: EXTRACTOR,
      ...extra,
    };
    out.push(c);
    if (Array.isArray(ctx.claims)) ctx.claims.push(c);
    return c;
  };
  return { ev, claim, out };
}

// ---------- commercial intel ----------

const COMMERCIAL_NAME_RE = /quote|báo giá|bao gia|estimate|scope|client|khách|khach|revision|feedback|acceptance|pricing|bảng giá|bang gia|invoice|hóa đơn|hoa don|brief|yêu cầu|yeu cau/i;
const MONEY_RE = /(?:[$€£₫]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:vnd|vnđ|usd|eur|gbp|triệu|trieu|tỷ|ty|tr|nghìn|nghin|dollars?|bucks?|million|k)\b)/gi;
const ACTUAL_RE = /actual|thực tế|thuc te|final|chốt|chot|invoic|thanh toán|thanh toan|paid|đã trả|da tra/i;
const ESTIMATE_RE = /estimate|ước|uoc|dự kiến|du kien|roughly|khoảng|khoang|approx|dự phòng|du phong/i;
const QUOTE_RE = /quote|báo giá|bao gia|price|pricing|giá|cost|chi phí|chi phi|budget|ngân sách|ngan sach|rate|fee|phí/i;
const SCOPE_HEAD_RE = /^#{1,6}[ \t]+.*(scope|phạm vi|pham vi|scope of work)/i;
const SCOPE_LINE_RE = /^[ \t]*(?:scope|phạm vi(?: công việc)?|pham vi(?: cong viec)?)[ \t]*[:：][ \t]*(\S.{0,280})/i;
const RISK_HEAD_RE = /^#{1,6}[ \t]+.*(risk|rủi ro|rui ro)/i;
const RISK_LINE_RE = /^[ \t]*(?:risk|rủi ro|rui ro)[ \t]*[:：][ \t]*(\S.{0,230})/i;
const REVISION_RES = [
  /(\d{1,2})[ \t]*(?:revisions?|rounds?|lần sửa|lan sua|vòng duyệt|vong duyet|lần feedback|lan feedback)/i,
  /(?:revisions?|rounds?|lần sửa|lan sua|vòng|vong|sửa lần|sua lan)[ \t]*[:#]?[ \t]*(\d{1,2})/i,
];

// First non-empty, non-heading lines after a heading, joined. Cap 300 chars.
function sectionSnippet(lines, fromIdx, maxLines = 3) {
  const picked = [];
  for (let j = fromIdx + 1; j < lines.length && picked.length < maxLines; j += 1) {
    const t = lines[j].trim();
    if (!t) { if (picked.length) break; continue; }
    if (/^#{1,6}\s/.test(t)) break;
    picked.push(t.replace(/^[-*]\s+/, ''));
  }
  const s = picked.join(' | ').trim();
  return s ? s.slice(0, 300) : null;
}

function extractCommercial(ctx, C) {
  const rows = [];
  const files = (ctx.files ?? []).filter((f) =>
    f?.path && isDoc(f) &&
    (COMMERCIAL_NAME_RE.test(f.relPath ?? '') || COMMERCIAL_NAME_RE.test(base(f.path))));

  for (const f of files.slice(0, MAX_COMMERCIAL_FILES)) {
    const row = {
      intelId: mkId('ci', ctx.unitId, f.relPath ?? f.path),
      unitId: ctx.unitId,
      taskType: ctx.unit?.kind ?? segs(ctx.unit?.relPath).pop() ?? 'unknown',
      quote: null, scope: null, estimate: null, actual: null,
      risk: null, revisionCount: null,
      createdAt: f.mtime ?? null,
    };
    let parsed = false;

    if (isParseable(f)) {
      const raw = readSlice(f.path);
      if (raw) {
        parsed = true;
        const lines = raw.split(/\r?\n/);
        const fnameIsQuote = /quote|báo giá|bao gia|estimate|pricing|price|cost|bảng giá|bang gia/i.test(base(f.path));
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          // money, classified by the label on its own line
          const monies = line.match(MONEY_RE);
          if (monies) {
            const amt = monies[0].trim();
            if (ACTUAL_RE.test(line)) { if (!row.actual) row.actual = amt; }
            else if (ESTIMATE_RE.test(line)) { if (!row.estimate) row.estimate = amt; }
            else if (QUOTE_RE.test(line) || fnameIsQuote) { if (!row.quote) row.quote = amt; }
          }
          if (!row.scope) {
            const m = line.match(SCOPE_LINE_RE);
            if (m) row.scope = m[1].trim().slice(0, 300);
            else if (SCOPE_HEAD_RE.test(line)) row.scope = sectionSnippet(lines, i);
          }
          if (!row.risk) {
            const m = line.match(RISK_LINE_RE);
            if (m) row.risk = m[1].trim().slice(0, 250);
            else if (RISK_HEAD_RE.test(line)) row.risk = sectionSnippet(lines, i, 2)?.slice(0, 250) ?? null;
          }
          if (row.revisionCount == null) {
            for (const re of REVISION_RES) {
              const m = line.match(re);
              if (m) { row.revisionCount = Number(m[1]); break; }
            }
          }
        }
      }
    }

    const hasField = row.quote || row.scope || row.estimate || row.actual || row.risk || row.revisionCount != null;
    // A doc-like file whose name carries a commercial signal is itself evidence
    // of a commercial artifact, even when nothing parseable fell out.
    if (hasField || !parsed) {
      rows.push(row);
      C.claim(`commercial artifact: ${f.relPath ?? f.path}`, 'COMMERCIAL', [C.ev(f, 'commercial-file')], {
        confidence: hasField ? 'observed' : 'inferred',
        subject: row.taskType,
      });
    }
  }
  return rows;
}

// ---------- tool intel ----------

const TOOL_DIR_RE = /^(tools?|scripts?|bin|cli|cmds?|utilities?)$/i;
const STAGE_BY_DIR = {
  tool: 'tooling', tools: 'tooling',
  script: 'automation', scripts: 'automation',
  bin: 'cli-entry', cli: 'cli-entry', cmd: 'cli-entry', cmds: 'cli-entry',
  utility: 'utility', utilities: 'utility',
};
const STAGE_HINTS = [
  [/test|spec|e2e|qa/i, 'testing'],
  [/build|bundle|dist|compile/i, 'build'],
  [/deploy|release|publish|ship/i, 'release'],
  [/migrat|convert|xplat|port/i, 'migration'],
  [/gen|scaffold|create|init/i, 'generation'],
  [/analyz|scan|audit|inspect|report|measure/i, 'analysis'],
  [/ci|workflow|pipeline/i, 'ci'],
  [/clean|prune|purge/i, 'maintenance'],
];
const USAGE_RE = /^[ \t]*(?:usage|sử dụng|su dung|cách dùng|cach dung)[ \t]*[:：]?[ \t]*(\S.{0,180})/i;
const OUTPUT_RE = /outputs?|writes?|generates?|produces?|emits?|stdout|xuất|xuat/i;
const FAILURE_RE = /fails?|errors?|throws?|exits?|cannot|refuses?|lỗi|loi\b|crash/i;
const TIME_SAVED_RE = /saves?\b|time.?saved|tiết kiệm|tiet kiem|giảm.*(thời gian|thoi gian)/i;
const MAINT_RE = /maintenance|bảo trì|bao tri|upkeep/i;
const ROI_RE = /\broi\b|return on investment/i;
const FREQ_RE = /daily|weekly|every (day|week|release|pr|deploy)|per release|tần suất|tan suat|mỗi (ngày|tuần|lần)|moi (ngay|tuan|lan)/i;

function inferStage(relPath) {
  const s = segs(relPath);
  const name = s.pop() ?? '';
  for (const [re, stage] of STAGE_HINTS) if (re.test(name)) return stage;
  for (const seg of s) for (const [re, stage] of STAGE_HINTS) if (re.test(seg)) return stage;
  const dir = s.find((x) => TOOL_DIR_RE.test(x));
  return STAGE_BY_DIR[dir?.toLowerCase()] ?? 'tooling';
}

// First substantive comment/doc line: header comment block of a script, or
// first paragraph of a README. Returns null when nothing real exists.
function firstDocLine(raw, maxLen = 200) {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).slice(0, 60);
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^#!/.test(t)) continue;
    if (/^\/\*/.test(t)) { inBlock = true; continue; }
    if (inBlock && /\*\/$/.test(t)) { inBlock = false; continue; }
    const cleaned = t.replace(/^(\/\/|#+|<!--|\*|--+)\s?/, '').replace(/-->$/, '').replace(/^"{3}|'{3}/, '').replace(/"{3}$|'{3}$/, '').trim();
    if (!cleaned || /^#{1,6}\s*$/.test(t)) continue;
    if (cleaned.length >= 15) return cleaned.slice(0, maxLen);
  }
  return null;
}

function firstMatchLine(raw, re, maxLen = 200) {
  if (!raw) return null;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim().replace(/^(\/\/|#+|\*|[-*])\s?/, '').trim();
    if (t.length >= 10 && re.test(t)) return t.slice(0, maxLen);
  }
  return null;
}

function extractTools(ctx, C) {
  const rows = [];
  const seen = new Set();
  const files = ctx.files ?? [];

  // README/description lookup per directory for problemSolved.
  const readmeByDir = new Map();
  for (const f of files) {
    if (/^readme(\.|$)/i.test(base(f.path)) && isParseable(f)) {
      const dir = segs(f.relPath).slice(0, -1).join('/').toLowerCase();
      if (!readmeByDir.has(dir)) readmeByDir.set(dir, f);
    }
  }
  const readmeCache = new Map();
  const readmeFor = (relPath) => {
    const dir = segs(relPath).slice(0, -1).join('/').toLowerCase();
    if (!readmeByDir.has(dir)) return null;
    if (!readmeCache.has(dir)) readmeCache.set(dir, readSlice(readmeByDir.get(dir).path));
    return readmeCache.get(dir);
  };

  const pushTool = (name, f, anchor, docRaw, desc) => {
    if (rows.length >= MAX_TOOLS || !name) return;
    const key = `${name}|${f.relPath ?? f.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    const doc = docRaw ?? readmeFor(f.relPath) ?? null;
    const row = {
      toolId: mkId('tool', ctx.unitId, key),
      unitId: ctx.unitId,
      name: String(name).slice(0, 120),
      problemSolved: (desc ?? firstDocLine(doc)) ?? null,
      workflowStage: inferStage(f.relPath ?? f.path),
      inputs: firstMatchLine(doc, USAGE_RE) ?? null,
      outputs: firstMatchLine(doc, OUTPUT_RE) ?? null,
      failureModes: firstMatchLine(doc, FAILURE_RE) ?? null,
      timeSaved: firstMatchLine(doc, TIME_SAVED_RE) ?? null,
      maintenanceCost: firstMatchLine(doc, MAINT_RE) ?? null,
      roi: firstMatchLine(doc, ROI_RE) ?? null,
      usageFrequency: firstMatchLine(doc, FREQ_RE) ?? null,
      status: 'OBSERVED',
      createdAt: f.mtime ?? null,
    };
    rows.push(row);
    C.claim(`tool observed: ${row.name} (${f.relPath ?? f.path})`, 'TOOL', [C.ev(f, anchor)], {
      confidence: 'observed', subject: row.name,
    });
  };

  // (a) package.json with a bin field -> each bin entry is a CLI tool.
  for (const f of files) {
    if (base(f.path) !== 'package.json' || rows.length >= MAX_TOOLS) continue;
    const raw = readSlice(f.path);
    if (!raw) continue;
    let pkg;
    try { pkg = JSON.parse(raw); } catch { continue; }
    if (!pkg.bin) continue;
    const entries = typeof pkg.bin === 'string'
      ? { [pkg.name ?? segs(f.relPath).slice(-2, -1)[0] ?? 'cli']: pkg.bin }
      : pkg.bin;
    for (const name of Object.keys(entries ?? {})) {
      pushTool(name, f, `package.json bin:${name}`, null, typeof pkg.description === 'string' ? pkg.description.slice(0, 200) : null);
    }
  }

  // (b) script files living under a tool-ish directory.
  for (const f of files) {
    if (rows.length >= MAX_TOOLS) break;
    if (!f?.path || !SCRIPT_EXT.has(ext(f.path))) continue;
    const rel = f.relPath ?? '';
    if (/node_modules|\.min\.|\.(test|spec)\.|__tests__|[\\/]fixtures?[\\/]/i.test(rel)) continue;
    if (!segs(rel).some((s) => TOOL_DIR_RE.test(s))) continue;
    const raw = readSlice(f.path, 64 * 1024); // header + usage live at the top
    pushTool(base(f.path).replace(/\.[^.]+$/, ''), f, 'tool-file', raw, null);
  }

  return rows;
}

// ---------- skill versions ----------

// NOTE: intra-line whitespace is [ \t], never \s — \s crosses newlines and a
// version heading would swallow the next line's bullet as its own title.
const VER_HEADING_RE = /^#{1,6}[ \t]+\[?v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]*)?)\]?[ \t]*[-–—:]?[ \t]*(.*)$/gm;
const VER_BULLET_RE = /^[ \t]*[-*][ \t]+\[?v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]*)?)\]?[ \t]*[-–—:)][ \t]*(.{10,300})/gm;
const CHANGELOG_NAME_RE = /changelog|history|releases?|versions?/i;
const FIX_RE = /fix|resolve|patch|correct|repair|sửa|sua|khắc phục|khac phuc|address/i;
const FAILURE_RE2 = /bug|broken|regression|fail|lỗi|loi\b|error|issue|crash|defect/i;
const PROD_RE = /production|deploy|release|phát hành|phat hanh|live|shipped|publish/i;

// skills-register.json sits at <plan>/reports/; resolve the real skillId for
// this unit, falling back to the observed sk-<unitId-suffix> convention.
function resolveSkillId(ctx) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const reg = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'reports', 'skills-register.json'), 'utf8'));
    const hit = (reg.skills ?? []).find((s) => s.unitId === ctx.unitId);
    if (hit?.skillId) return hit.skillId;
  } catch { /* register absent (e.g. standalone test) -> convention fallback */ }
  return ctx.unitId?.startsWith('u-') ? `sk-${ctx.unitId.slice(2)}` : (ctx.unitId ?? 'unknown');
}

function classifyVersionBlock(block) {
  // One line per field; a "fix broken X" line counts as the fix, not the failure.
  let failure = null; let fix = null; let production = null;
  for (const line of block.split(/\r?\n/)) {
    const t = line.trim().replace(/^[-*]\s+/, '').trim();
    if (t.length < 8) continue;
    if (!fix && FIX_RE.test(t)) { fix = t.slice(0, 250); continue; }
    if (!failure && FAILURE_RE2.test(t)) { failure = t.slice(0, 250); continue; }
    if (!production && PROD_RE.test(t)) production = t.slice(0, 250);
  }
  return { failure, fix, production };
}

function extractSkillVersions(ctx, C) {
  const files = ctx.files ?? [];
  const skillMds = files.filter((f) => /^skill\.md$/i.test(base(f.path)) && isParseable(f));
  const isSkillUnit = ctx.unit?.kind === 'skill' || skillMds.length > 0;
  if (!isSkillUnit) return [];

  const skillId = resolveSkillId(ctx);
  const rows = [];
  const byVersion = new Map(); // one row per (skillId, version); later evidence enriches nulls
  const pushVersion = (version, fields, f, anchor) => {
    if (!version) return;
    const v = String(version).slice(0, 60);
    let row = byVersion.get(v);
    if (!row) {
      if (rows.length >= MAX_VERSIONS) return;
      row = {
        versionId: mkId('sv', ctx.unitId, `${skillId}:${v}`),
        unitId: ctx.unitId,
        skillId,
        version: v,
        failure: null, fix: null, production: null,
        createdAt: f.mtime ?? null,
      };
      byVersion.set(v, row);
      rows.push(row);
    }
    for (const k of ['failure', 'fix', 'production']) {
      if (row[k] == null && fields[k] != null) row[k] = fields[k];
    }
    C.claim(`skill ${skillId} version ${v}`, 'SKILL-VERSION', [C.ev(f, anchor)], {
      confidence: 'observed', subject: skillId,
    });
  };

  // (a) SKILL.md frontmatter `version:` — the declared current version.
  for (const f of skillMds.slice(0, MAX_SKILL_MDS)) {
    const raw = readSlice(f.path);
    if (!raw) continue;
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const vm = fm?.[1].match(/^version\s*:\s*["']?([^"'\r\n]+?)["']?\s*$/m);
    if (vm) pushVersion(vm[1].trim(), {}, f, 'frontmatter:version');
  }

  // (b) Changelog / version-history sections in SKILL.md and CHANGELOG-like files.
  const changelogFiles = files.filter((f) =>
    isParseable(f) &&
    (/^skill\.md$/i.test(base(f.path)) || CHANGELOG_NAME_RE.test(base(f.path))));
  for (const f of changelogFiles.slice(0, MAX_CHANGELOG_FILES)) {
    const raw = readSlice(f.path);
    if (!raw) continue;
    // version headings carry a block; bullets carry a single line.
    for (const m of raw.matchAll(VER_HEADING_RE)) {
      const rest = raw.slice(m.index + m[0].length);
      const nextHead = rest.search(/^#{1,6}\s/m);
      const block = (nextHead >= 0 ? rest.slice(0, nextHead) : rest).slice(0, 4000);
      pushVersion(m[1], { ...classifyVersionBlock(block) }, f, `changelog:${m[1]}`);
    }
    for (const m of raw.matchAll(VER_BULLET_RE)) {
      pushVersion(m[1], classifyVersionBlock(m[2]), f, `changelog:${m[1]}`);
    }
  }
  return rows;
}

// ---------- entry ----------

export function extract(ctx) {
  const C = makeCtx(ctx ?? {});
  const ledgers = {
    'commercial-intel.jsonl': extractCommercial(ctx ?? {}, C),
    'tool-intel.jsonl': extractTools(ctx ?? {}, C),
    'skill-versions.jsonl': extractSkillVersions(ctx ?? {}, C),
  };
  return { claims: C.out, ledgers };
}

export default extract;
