// Extractor: platform.mjs — v4 intelligence-layer producer.
// Emits ledgers:
//   archetypes.jsonl          — project archetype classification per unit
//   platform-semantics.jsonl  — semantic-role facts mined from theme/Liquid/CSS
// Evidence-anchored only: a row exists only when a real file, layout marker,
// or unit-name signal supports it. No evidence -> empty ledgers (correct).
//
// ctx = { unitId, unit, files, platform, claims, decisions, ev, gitEv,
//         cid, did, depId, unitAbs, REGISTER }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BYTES = 256 * 1024;   // per-file read cap
const MAX_CONTENT_READS = 150;  // total content reads per unit
const MAX_ARCHETYPE_ROWS = 6;   // archetypes emitted per unit
const MAX_STRUCT_ROWS = 300;    // section/snippet/template/layout rows
const MAX_SETTING_ROWS = 200;   // settings_schema/settings.html rows
const MAX_CSSVAR_ROWS = 150;    // css custom property rows
const MAX_SETREF_ROWS = 100;    // settings.* liquid reference rows

const norm = (p) => (p ?? '').replace(/\\/g, '/');
const baseName = (p) => norm(p).split('/').pop() ?? '';
const stem = (p) => baseName(p).replace(/\.[^.]+$/, '');
const ext = (p) => (baseName(p).match(/\.[^.]+$/) ?? [''])[0].toLowerCase();

export function extract(ctx) {
  const { unitId, unit, files, platform, ev, cid } = ctx;
  const ledgers = { 'archetypes.jsonl': [], 'platform-semantics.jsonl': [] };
  const claims = [];
  if (!Array.isArray(files) || files.length === 0) return { claims, ledgers };

  const id = (prefix, s) =>
    `${prefix}-${crypto.createHash('sha1').update(`${unitId}${s}`).digest('hex').slice(0, 12)}`;

  const unitRel = norm(unit?.relPath).replace(/\/+$/, '');
  // Path of a file relative to the unit root (layout detection needs the
  // inner segments; relPath is work-root-relative and carries the unit path).
  const inner = (f) => {
    const r = norm(f.relPath);
    return unitRel && r.startsWith(unitRel + '/') ? r.slice(unitRel.length + 1) : r;
  };
  const innerSegs = (f) => inner(f).split('/').filter(Boolean);
  const topDir = (f) => innerSegs(f).length > 1 ? innerSegs(f)[0].toLowerCase() : null;

  let reads = 0;
  const readSlice = (f) => {
    if (reads >= MAX_CONTENT_READS) return null;
    if (f.contentPolicy && f.contentPolicy !== 'ALLOWED') return null;
    reads += 1;
    try { return fs.readFileSync(f.path, 'utf8').slice(0, MAX_BYTES); } catch { return null; }
  };

  const markers = new Set(unit?.markers ?? []);
  const kind = unit?.kind ?? null;

  // ---------------- theme layout ----------------
  const layoutDirs = new Set();
  for (const f of files) {
    const d = topDir(f);
    if (d && ['templates', 'sections', 'snippets', 'layout', 'config', 'assets', 'blocks', 'locales'].includes(d)) {
      layoutDirs.add(d);
    }
  }
  const hasThemeLayout = layoutDirs.has('templates') && (layoutDirs.has('snippets') || layoutDirs.has('sections'));
  const isThemeUnit = kind === 'theme' || markers.has('theme-project') || hasThemeLayout;
  const hasLiquid = files.some((f) => ['.liquid', '.bwt'].includes(ext(f.path)));

  const maturityLevel =
    layoutDirs.has('layout') && layoutDirs.has('templates') && layoutDirs.has('snippets') && layoutDirs.has('config')
      ? 'full'
      : layoutDirs.has('templates') || layoutDirs.has('sections')
        ? 'partial'
        : layoutDirs.size > 0 ? 'minimal' : null;

  // ---------------- archetype classification ----------------
  // Each rule appends {marker, path} evidence to a bucket; a bucket with at
  // least one marker produces one row. Name signals carry no file (path:null)
  // and are labeled as such — they are still real observed evidence.
  const buckets = new Map();
  const mark = (arch, marker, f) => {
    if (!buckets.has(arch)) buckets.set(arch, []);
    const b = buckets.get(arch);
    if (b.length < 40) b.push({ marker, path: f ? norm(f.relPath) : null });
  };

  const nameHay = `${unitRel} ${baseName(unitRel)}`;
  const segHas = (re) => unitRel.split('/').some((s) => re.test(s));

  // name / marker signals. Marker names the actual segment that fired.
  const nameMark = (arch, re) => {
    const seg = unitRel.split('/').find((s) => re.test(s));
    if (seg !== undefined) mark(arch, `name-signal:${seg}`, null);
  };
  if (segHas(/^(clone|replica|reference|ref|copy)$/i) || /(^|[\/\-_\s])(clone|replica)([\/\-_\s]|$)/i.test(nameHay)) {
    nameMark('Theme Clone', /clone|replica|reference|^ref$|copy/i);
  }
  nameMark('Theme Customization', /customi[sz]/i);
  nameMark('Landing Page', /^(landing|lp)$/i);
  if (segHas(/^(fix|bugfix|hotfix|bug|patch)$/i) || /(^|[\/\-_\s])(bugfix|hotfix)([\/\-_\s]|$)/i.test(nameHay)) {
    nameMark('Bug Fix', /^(fix|bugfix|hotfix|bug|patch)$/i);
  }
  nameMark('Migration', /migrat|convert|h2s|to[-_](sapo|haravan|shopify)/i);
  nameMark('Feature', /^features?$/i);
  nameMark('SEO', /^seo$/i);
  nameMark('Responsive', /^(responsive|mobile)$/i);
  nameMark('Performance', /^(perf|performance|pagespeed|speed)$/i);
  if (kind === 'skill') mark('Tool', 'unit-kind:skill', null);

  // structural signals from file layout
  for (const f of files) {
    const segs = innerSegs(f);
    const top = segs.length > 1 ? segs[0].toLowerCase() : null;
    const bn = baseName(f.path).toLowerCase();
    const st = stem(f.path).toLowerCase();
    const e = ext(f.path);

    if (top === 'templates' && ['.liquid', '.bwt', '.json'].includes(e)) {
      if (/^product([.\-_]|$)/.test(st)) mark('Product Page', `template:${segs.join('/')}`, f);
      if (/^(collection|list_collections|list-collections)([.\-_]|$)/.test(st)) mark('Collection', `template:${segs.join('/')}`, f);
      if (/^(blog|article)([.\-_]|$)/.test(st)) mark('Blog', `template:${segs.join('/')}`, f);
      if (/^page\.(landing|promo|campaign|lp)/.test(st)) mark('Landing Page', `template:${segs.join('/')}`, f);
      if (/^search/.test(st)) mark('Collection', `template:${segs.join('/')}`, f);
    }
    if (/^(seo)([.\-_]|$)/.test(st)) mark('SEO', `file:${norm(f.relPath)}`, f);
    if (/(lazy|lazyload|pagespeed|critical[-_]?css|optimi[sz]e?|min\.(css|js)$)/.test(bn)) {
      mark('Performance', `file:${norm(f.relPath)}`, f);
    }
    if (/(responsive|mobile|breakpoint)/.test(bn)) mark('Responsive', `file:${norm(f.relPath)}`, f);
    if (/(webhook|oauth|api[-_.]|feed|integration)/.test(bn)) mark('Integration', `file:${norm(f.relPath)}`, f);
    if (/(app[-_.]?(embed|block|proxy))/.test(bn) || (top === 'blocks' && /app/.test(bn))) {
      mark('App Integration', `file:${norm(f.relPath)}`, f);
    }
    if (top === 'tools' && ['.mjs', '.js', '.cjs'].includes(e)) mark('Tool', `tool-script:${norm(f.relPath)}`, f);

    if (bn === 'package.json') {
      const raw = readSlice(f);
      if (raw) {
        try {
          const pkg = JSON.parse(raw);
          if (pkg.bin) mark('Tool', 'package.json:bin', f);
          const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
          if (deps.some((d) => /sdk|api-client|graphql-client/i.test(d))) {
            mark('Integration', `package.json:dep:${deps.find((d) => /sdk|api-client|graphql-client/i.test(d))}`, f);
          }
          if (deps.some((d) => /shopify|haravan|sapo|bizweb/i.test(d))) {
            mark('App Integration', `package.json:dep:${deps.find((d) => /shopify|haravan|sapo|bizweb/i.test(d))}`, f);
          }
        } catch { /* malformed package.json — no marker */ }
      }
    }
  }

  // content signal: JSON-LD structured data in liquid templates/snippets = SEO work
  if (isThemeUnit || hasLiquid) {
    let scanned = 0;
    for (const f of files) {
      if (scanned >= 40) break;
      if (!['.liquid', '.bwt'].includes(ext(f.path))) continue;
      const top = topDir(f);
      if (!['templates', 'snippets', 'sections', 'layout'].includes(top)) continue;
      scanned += 1;
      const raw = readSlice(f);
      if (raw && /application\/ld\+json/i.test(raw)) { mark('SEO', `ld+json:${norm(f.relPath)}`, f); break; }
    }
  }

  // theme work default: a theme-layout unit is theme customization unless a
  // clone signal already fired (clone rows stand on their own evidence too).
  if (hasThemeLayout) {
    mark('Theme Customization', `theme-layout:${[...layoutDirs].sort().join('+')}`, null);
  }

  const archRows = [...buckets.entries()]
    .map(([name, evidence]) => ({ name, evidence }))
    .sort((a, b) => b.evidence.length - a.evidence.length || a.name.localeCompare(b.name))
    .slice(0, MAX_ARCHETYPE_ROWS);

  const newestMtime = (evs) => {
    let m = null;
    for (const e of evs) {
      if (!e.path) continue;
      const f = files.find((x) => norm(x.relPath) === e.path);
      if (f?.mtime && (!m || f.mtime > m)) m = f.mtime;
    }
    return m;
  };

  for (const { name, evidence } of archRows) {
    ledgers['archetypes.jsonl'].push({
      archetypeId: id('arch', `archetype:${name}`),
      unitId,
      name,
      platform: platform ?? null,
      maturityLevel,
      evidence,
      createdAt: newestMtime(evidence),
    });
    const evidenceRefs = evidence.slice(0, 8).map((e) => {
      if (!e.path) return { entryId: null, revision: null, path: null, anchor: `inference:${e.marker}` };
      const f = files.find((x) => norm(x.relPath) === e.path);
      return f ? ev(f, e.marker) : { entryId: null, revision: null, path: e.path, anchor: e.marker };
    });
    claims.push({
      claimId: cid(`archetype:${name}`),
      unitId,
      statement: `unit classified as archetype '${name}' (markers: ${evidence.slice(0, 6).map((e) => e.marker).join('; ')})`,
      kind: 'ARCHETYPE',
      evidenceRefs,
      counterEvidence: [],
      context: { platform: platform ?? null, version: null },
      extractorVersion: 'extract/platform',
      status: 'OBSERVED',
      confidence: evidence.some((e) => e.path) ? 'observed' : 'inferred',
      sourceKind: 'archetype-classification',
      subject: unitRel || unitId,
    });
  }

  // ---------------- platform semantics ----------------
  // Only for units where theme/liquid evidence exists.
  const semPlatform =
    platform ??
    (files.some((f) => ext(f.path) === '.bwt') ? 'sapo'
      : files.some((f) => baseName(f.path).toLowerCase() === 'settings.html') ? 'haravan'
      : hasLiquid ? 'generic-liquid'
      : null);

  if (semPlatform || isThemeUnit) {
    const plat = semPlatform ?? 'unknown';
    const sem = (f, role, prop, cssFact, truth, anchor) => {
      ledgers['platform-semantics.jsonl'].push({
        semanticId: id('sem', `${role}:${prop ?? ''}:${norm(f.relPath)}`),
        unitId,
        platform: plat,
        semanticRole: role,
        propertyName: prop ?? null,
        cssFact: cssFact ?? null,
        semanticTruth: truth ?? null,
        evidence: `${norm(f.relPath)}#${anchor}`,
        createdAt: f.mtime ?? null,
      });
    };

    // 1) structural roles: sections/snippets/templates/layout/blocks
    const STRUCT = { sections: 'section', snippets: 'snippet', templates: 'template', layout: 'layout', blocks: 'block' };
    let structCount = 0;
    for (const f of files) {
      if (structCount >= MAX_STRUCT_ROWS) break;
      const top = topDir(f);
      const role = STRUCT[top];
      if (!role || !['.liquid', '.bwt', '.json'].includes(ext(f.path))) continue;
      let truth = `${role} file '${baseName(f.path)}'`;
      if (role === 'section' && ext(f.path) !== '.json') {
        const raw = readSlice(f);
        const m = raw?.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
        if (m) {
          try {
            const schema = JSON.parse(m[1]);
            if (schema?.name) truth = `section '${stem(f.path)}' declares schema name '${schema.name}'`;
          } catch { /* unparseable schema block — keep file-level truth */ }
        }
      }
      sem(f, role, stem(f.path), null, truth, role);
      structCount += 1;
    }

    // 2) settings surfaces
    for (const f of files) {
      const bn = baseName(f.path).toLowerCase();
      if (bn === 'settings_schema.json') {
        const raw = readSlice(f);
        if (!raw) continue;
        let schema;
        try { schema = JSON.parse(raw); } catch { schema = null; }
        if (!Array.isArray(schema)) continue;
        let n = 0;
        for (const block of schema) {
          if (n >= MAX_SETTING_ROWS) break;
          if (!block || !Array.isArray(block.settings)) continue;
          for (const s of block.settings) {
            if (n >= MAX_SETTING_ROWS) break;
            if (!s?.id) continue;
            sem(
              f, 'settings', String(s.id), null,
              `admin setting '${s.label ?? s.id}' (type=${s.type ?? 'unknown'}) in '${block.name ?? 'unnamed'}'`,
              `settings_schema.${s.id}`,
            );
            n += 1;
          }
        }
      } else if (bn === 'settings.html') {
        const raw = readSlice(f);
        if (!raw) continue;
        let n = 0;
        for (const m of raw.matchAll(/name=["']([a-zA-Z][\w.\[\]-]*)["']/g)) {
          if (n >= MAX_SETTING_ROWS) break;
          sem(f, 'settings', m[1], null, `legacy settings.html field '${m[1]}'`, `settings_html.${m[1]}`);
          n += 1;
        }
      }
    }

    // 3) CSS custom properties + settings.* references (content scan)
    const seenVar = new Set();
    const seenRef = new Set();
    const tokenKind = (v) =>
      /colo[u]?r|bg|background/i.test(v) ? 'color token'
        : /font|text|type/i.test(v) ? 'typography token'
        : /space|gap|pad|margin/i.test(v) ? 'spacing token'
        : /radius|border|round/i.test(v) ? 'shape token'
        : /shadow|elevation/i.test(v) ? 'elevation token'
        : /width|height|size|container/i.test(v) ? 'sizing token'
        : 'theme token';

    for (const f of files) {
      if (seenVar.size >= MAX_CSSVAR_ROWS && seenRef.size >= MAX_SETREF_ROWS) break;
      const e = ext(f.path);
      if (!['.css', '.liquid', '.bwt', '.html'].includes(e)) continue;
      const raw = readSlice(f);
      if (!raw) continue;

      if (seenVar.size < MAX_CSSVAR_ROWS) {
        for (const m of raw.matchAll(/--([a-zA-Z][\w-]*)\s*:\s*([^;}{]+)/g)) {
          const varName = `--${m[1]}`;
          if (seenVar.has(varName)) continue;
          seenVar.add(varName);
          const value = m[2].trim().slice(0, 120);
          sem(
            f, 'css-variable', varName, `${varName}: ${value}`,
            `${tokenKind(varName)} declared in ${baseName(f.path)}`,
            `css-var:${varName}`,
          );
          if (seenVar.size >= MAX_CSSVAR_ROWS) break;
        }
      }

      if (['.liquid', '.bwt'].includes(e) && seenRef.size < MAX_SETREF_ROWS) {
        for (const m of raw.matchAll(/\bsettings\.([a-zA-Z][\w.]*)|settings\[['"]([\w.-]+)['"]\]/g)) {
          const prop = m[1] ?? m[2];
          if (!prop || seenRef.has(prop)) continue;
          seenRef.add(prop);
          sem(
            f, 'setting-reference', prop, null,
            `liquid reads theme setting '${prop}'`,
            `setting-ref:${prop}`,
          );
          if (seenRef.size >= MAX_SETREF_ROWS) break;
        }
      }
    }
  }

  return { claims, ledgers };
}
