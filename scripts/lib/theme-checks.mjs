/**
 * Static theme checks for the Haravan customize workflow.
 *
 * A pixel comparison over a page that silently contains `Liquid error`, reads a
 * setting the theme never declared, or points at an asset the theme does not
 * ship is worse than no comparison: it publishes a number that looks like
 * fidelity. These four checks run offline (no browser, no network) over a
 * captured document or a theme source tree and return named refusals, so the
 * run can refuse a surface by rule instead of passing it.
 *
 * Position matters. `scanRenderFailures` walks the document and reports only
 * text nodes: a `{{ ... }}`/`{% ... %}`-shaped string inside an HTML attribute,
 * inside `<script>`/`<style>`, or inside a comment is data, not an unrendered
 * template, and reporting it would refuse every theme that ships a JS template
 * or a CSS custom property. HTML comments are data as well, so `Liquid error`
 * quoted inside a comment is a quotation, not a rendered failure.
 *
 * Rule names (a refusal names one of these):
 *   LIQUID_ERROR, LIQUID_EXCEPTION, LIQUID_SYNTAX_ERROR, UNRENDERED_OUTPUT,
 *   UNRENDERED_TAG                          -- scanRenderFailures
 *   SETTINGS_SCHEMA_MISSING, SETTINGS_SCHEMA_JSON_INVALID,
 *   SETTINGS_SCHEMA_SHAPE_INVALID, SECTION_SCHEMA_MISSING,
 *   SECTION_SCHEMA_UNTERMINATED, SECTION_SCHEMA_JSON_INVALID,
 *   SECTION_SCHEMA_SHAPE_INVALID, SECTION_SCHEMA_UNREADABLE
 *                                           -- validateThemeSchemas
 *   SETTING_UNDECLARED                      -- checkSettingsBinding
 *   ASSET_MISSING_LOCAL                     -- checkAssetReferences (localMissing)
 *
 * Every function is pure with respect to its arguments: the same html string or
 * the same theme directory produces the same ordered result, with no module
 * state retained between calls. An absent or empty theme directory never
 * throws: the file walks yield nothing, the settings-schema failure is still
 * named, and binding and asset checks report an empty, successful result.
 */

import fs from 'node:fs';
import path from 'node:path';

const RENDER_ERROR_PHRASES = [
  { rule: 'LIQUID_ERROR', phrase: 'Liquid error' },
  { rule: 'LIQUID_EXCEPTION', phrase: 'Liquid Exception' },
  { rule: 'LIQUID_SYNTAX_ERROR', phrase: 'Liquid syntax error' },
];

const UNRENDERED_MARKERS = [
  { rule: 'UNRENDERED_OUTPUT', marker: '{{' },
  { rule: 'UNRENDERED_TAG', marker: '{%' },
];

/** Directories that hold Liquid source: layout, templates, sections, snippets. */
const SOURCE_DIRECTORIES = ['layout', 'templates', 'sections', 'snippets'];

/** Parseable Liquid source: sections, templates, layout and snippets alike. */
const SOURCE_EXTENSIONS = new Set(['.liquid', '.html']);

const SETTINGS_SCHEMA_RELATIVE_PATH = 'config/settings_schema.json';

/**
 * `settings.<id>` where the dot is not preceded by another property access, so
 * `section.settings.x` and `block.settings.x` (section/block scoped settings)
 * are not mistaken for global theme settings.
 */
const SETTINGS_READ_PATTERN = /(?<![\w.$])settings\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** Liquid comments are not reads: a setting mentioned only there is still dead. */
const LIQUID_COMMENT_BLOCK = /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g;

const SCHEMA_BLOCK_START = /\{%-?\s*schema\s*-?%\}/;
const SCHEMA_BLOCK_END = /\{%-?\s*endschema\s*-?%\}/;

/** A quoted literal piped into an asset or file filter names one asset. */
const ASSET_LITERAL_FILTERS = [
  /(['"])([^'"\r\n]+)\1\s*\|\s*asset_url\b/g,
  /(['"])([^'"\r\n]+)\1\s*\|\s*file_url\b/g,
];

/**
 * A direct `/assets/...` path, never the tail of a remote URL: the preceding
 * character must not continue a host or path (`https://cdn/assets/x` is remote,
 * `url(/assets/x)` and `'/assets/x'` are local).
 */
const DIRECT_ASSET_PATH = /(?<![\w.:/-])\/assets\/([^'"\s()?#\\]+)/g;

/**
 * Scan a rendered document and report every Liquid failure marker that appears
 * in text position. Returns one entry per rule, with the occurrence count and a
 * short excerpt of the first occurrence, ordered by the rule list above.
 */
export function scanRenderFailures(html) {
  const text = typeof html === 'string' ? html : '';
  if (text.length === 0) return { ok: true, failures: [] };

  const found = new Map();
  const record = (rule, index, length) => {
    const existing = found.get(rule);
    if (existing) {
      existing.count += 1;
      return;
    }
    found.set(rule, { count: 1, index, length });
  };

  for (const [start, end] of textPositionSpans(text)) {
    const segment = text.slice(start, end);
    for (const { rule, phrase } of RENDER_ERROR_PHRASES) {
      let from = 0;
      for (;;) {
        const at = segment.indexOf(phrase, from);
        if (at === -1) break;
        record(rule, start + at, phrase.length);
        from = at + phrase.length;
      }
    }
    for (const { rule, marker } of UNRENDERED_MARKERS) {
      let from = 0;
      for (;;) {
        const at = segment.indexOf(marker, from);
        if (at === -1) break;
        record(rule, start + at, marker.length);
        from = at + marker.length;
      }
    }
  }

  const failures = [...RENDER_ERROR_PHRASES, ...UNRENDERED_MARKERS]
    .filter(({ rule }) => found.has(rule))
    .map(({ rule }) => {
      const { count, index, length } = found.get(rule);
      return { rule, count, example: `line ${lineOfIndex(text, index)}: ${excerptAround(text, index, length)}` };
    });

  return { ok: failures.length === 0, failures };
}

/**
 * Validate the theme's declared structure: `config/settings_schema.json` parses
 * and has the shape the platform expects, and every file under `sections/`
 * carries a `{% schema %}` block that parses to a JSON object. Returns per-file
 * ok/error records plus the flat failure list.
 */
export function validateThemeSchemas(themeDir) {
  const failures = [];
  const schemaFiles = [];
  const sections = [];

  const schemaPath = path.join(themeDir, 'config', 'settings_schema.json');
  const schemaSource = readFileIfPresent(schemaPath);
  if (schemaSource === null) {
    schemaFiles.push({ path: SETTINGS_SCHEMA_RELATIVE_PATH, ok: false, error: 'file not found' });
    failures.push({
      rule: 'SETTINGS_SCHEMA_MISSING',
      path: SETTINGS_SCHEMA_RELATIVE_PATH,
      detail: 'config/settings_schema.json is not present in the theme',
    });
  } else {
    const parsed = parseJsonDocument(schemaSource);
    if (!parsed.ok) {
      schemaFiles.push({ path: SETTINGS_SCHEMA_RELATIVE_PATH, ok: false, error: parsed.error });
      failures.push({ rule: 'SETTINGS_SCHEMA_JSON_INVALID', path: SETTINGS_SCHEMA_RELATIVE_PATH, detail: parsed.error });
    } else {
      const shapeProblem = describeSettingsSchemaProblem(parsed.value);
      if (shapeProblem) {
        schemaFiles.push({ path: SETTINGS_SCHEMA_RELATIVE_PATH, ok: false, error: shapeProblem });
        failures.push({ rule: 'SETTINGS_SCHEMA_SHAPE_INVALID', path: SETTINGS_SCHEMA_RELATIVE_PATH, detail: shapeProblem });
      } else {
        schemaFiles.push({ path: SETTINGS_SCHEMA_RELATIVE_PATH, ok: true, error: null });
      }
    }
  }

  for (const absolutePath of listSourceFiles(path.join(themeDir, 'sections'), SOURCE_EXTENSIONS)) {
    const relativePath = toPosixRelative(themeDir, absolutePath);
    const source = readFileIfPresent(absolutePath);
    if (source === null) {
      sections.push({ path: relativePath, ok: false, error: 'file not readable' });
      failures.push({ rule: 'SECTION_SCHEMA_UNREADABLE', path: relativePath, detail: 'section file could not be read' });
      continue;
    }

    const block = extractSectionSchemaBlock(source);
    if (!block.found) {
      sections.push({ path: relativePath, ok: false, error: 'no {% schema %} block' });
      failures.push({ rule: 'SECTION_SCHEMA_MISSING', path: relativePath, detail: 'section declares no {% schema %} block' });
      continue;
    }
    if (!block.terminated) {
      sections.push({ path: relativePath, ok: false, error: '{% schema %} block is not closed by {% endschema %}' });
      failures.push({
        rule: 'SECTION_SCHEMA_UNTERMINATED',
        path: relativePath,
        detail: '{% schema %} block is not closed by {% endschema %}',
      });
      continue;
    }

    const parsed = parseJsonDocument(block.body);
    if (!parsed.ok) {
      sections.push({ path: relativePath, ok: false, error: parsed.error });
      failures.push({ rule: 'SECTION_SCHEMA_JSON_INVALID', path: relativePath, detail: parsed.error });
      continue;
    }
    if (!isPlainObject(parsed.value)) {
      sections.push({ path: relativePath, ok: false, error: 'schema block must be a JSON object' });
      failures.push({
        rule: 'SECTION_SCHEMA_SHAPE_INVALID',
        path: relativePath,
        detail: '{% schema %} block must parse to a JSON object',
      });
      continue;
    }
    sections.push({ path: relativePath, ok: true, error: null });
  }

  return { ok: failures.length === 0, schemaFiles, sections, failures };
}

/**
 * Bind every global `settings.<id>` read in the theme source to an id declared
 * in `config/settings_schema.json` (nested section block settings included). A
 * read with no declaration is a named failure; a declared id the source never
 * reads is reported as dead, which is a smell rather than a refusal.
 */
export function checkSettingsBinding(themeDir) {
  const reads = new Map();
  for (const directory of SOURCE_DIRECTORIES) {
    for (const absolutePath of listSourceFiles(path.join(themeDir, directory), SOURCE_EXTENSIONS)) {
      const source = readFileIfPresent(absolutePath);
      if (source === null) continue;
      const relativePath = toPosixRelative(themeDir, absolutePath);
      const stripped = source.replace(LIQUID_COMMENT_BLOCK, ' ');
      for (const match of stripped.matchAll(SETTINGS_READ_PATTERN)) {
        const id = match[1];
        if (!reads.has(id)) reads.set(id, new Set());
        reads.get(id).add(relativePath);
      }
    }
  }

  const declared = collectDeclaredSettingIds(themeDir);
  const undeclared = [];
  const failures = [];
  for (const id of [...reads.keys()].sort(compareStrings)) {
    if (declared.has(id)) continue;
    const files = [...reads.get(id)].sort(compareStrings);
    undeclared.push({ id, files });
    failures.push({
      rule: 'SETTING_UNDECLARED',
      id,
      detail: `settings.${id} is read in ${files.join(', ')} but is not declared in ${SETTINGS_SCHEMA_RELATIVE_PATH}`,
    });
  }

  const dead = [...declared]
    .filter((id) => !reads.has(id))
    .sort(compareStrings)
    .map((id) => ({ id }));

  return { ok: failures.length === 0, undeclared, dead, failures };
}

/**
 * Resolve every asset reference the theme source makes and classify it: present
 * in `assets/` or `static/`, missing locally (a named failure, rule
 * `ASSET_MISSING_LOCAL`), or remote (recorded with its origin so an external
 * dependency is visible rather than assumed). Unresolvable dynamic filters
 * (`{{ x | asset_url }}`) are not reported, because a static pass cannot name
 * the file they resolve to. A reference to a compiled asset counts as present
 * when its Liquid source ships: the platform compiles `assets/blog.js.liquid`
 * to the `blog.js` the reference asks for, and a real theme refuses every
 * reference otherwise.
 */
export function checkAssetReferences(themeDir) {
  const references = new Map();
  const addReference = (rawRef, file) => {
    const ref = rawRef.trim();
    if (ref.length === 0) return;
    if (ref.includes('{{') || ref.includes('{%') || ref.includes('}}') || ref.includes('%}')) return;
    const isRemote = /^(https?:)?\/\//i.test(ref);
    const key = `${isRemote ? 'remote' : 'local'} ${ref}`;
    if (!references.has(key)) references.set(key, { ref, remote: isRemote, files: new Set() });
    references.get(key).files.add(file);
  };

  for (const directory of SOURCE_DIRECTORIES) {
    for (const absolutePath of listSourceFiles(path.join(themeDir, directory), SOURCE_EXTENSIONS)) {
      const source = readFileIfPresent(absolutePath);
      if (source === null) continue;
      const relativePath = toPosixRelative(themeDir, absolutePath);
      for (const pattern of ASSET_LITERAL_FILTERS) {
        for (const match of source.matchAll(pattern)) addReference(match[2], relativePath);
      }
      for (const match of source.matchAll(DIRECT_ASSET_PATH)) addReference(match[1], relativePath);
    }
  }

  const localMissing = [];
  const remote = [];
  let localPresent = 0;
  for (const reference of [...references.values()].sort((a, b) => compareStrings(a.ref, b.ref))) {
    const files = [...reference.files].sort(compareStrings);
    if (reference.remote) {
      remote.push({ ref: reference.ref, origin: describeRemoteOrigin(reference.ref), files });
      continue;
    }
    if (localAssetExists(themeDir, reference.ref)) {
      localPresent += 1;
    } else {
      localMissing.push({ ref: reference.ref, files });
    }
  }

  return {
    ok: localMissing.length === 0,
    localMissing,
    remote,
    counts: { localPresent, localMissing: localMissing.length, remote: remote.length },
  };
}

/**
 * Spans of the document that hold rendered text. Everything that is not text is
 * skipped: tags and their attribute values, comments, doctypes, and the bodies
 * of `<script>` and `<style>`. A `<` that cannot start a tag is text.
 */
function textPositionSpans(html) {
  const spans = [];
  let textStart = 0;
  let cursor = 0;
  const flush = (end) => {
    if (end > textStart) spans.push([textStart, end]);
  };

  while (cursor < html.length) {
    const lt = html.indexOf('<', cursor);
    if (lt === -1) break;
    const tail = html.slice(lt);

    if (tail.startsWith('<!--')) {
      flush(lt);
      const close = html.indexOf('-->', lt + 4);
      cursor = close === -1 ? html.length : close + 3;
      textStart = cursor;
      continue;
    }

    if (tail.startsWith('<!')) {
      flush(lt);
      const close = html.indexOf('>', lt);
      cursor = close === -1 ? html.length : close + 1;
      textStart = cursor;
      continue;
    }

    if (!/^<\/?[A-Za-z]/.test(tail)) {
      cursor = lt + 1;
      continue;
    }

    const tagEnd = findTagEnd(html, lt);
    if (tagEnd === -1) {
      cursor = lt + 1;
      continue;
    }

    flush(lt);
    const tagName = (/^<\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(lt, tagEnd + 1)) || [])[1];
    cursor = tagEnd + 1;
    textStart = cursor;

    const lowered = tagName ? tagName.toLowerCase() : '';
    if (lowered === 'script' || lowered === 'style') {
      const closer = new RegExp(`</${lowered}\\s*>`, 'i').exec(html.slice(cursor));
      cursor = closer ? cursor + closer.index + closer[0].length : html.length;
      textStart = cursor;
    }
  }

  flush(html.length);
  return spans;
}

/** End index of the tag that opens at `start`, or -1 when it never closes. */
function findTagEnd(html, start) {
  let quote = null;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
    if (character === '<') return -1;
  }
  return -1;
}

function lineOfIndex(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text[cursor] === '\n') line += 1;
  }
  return line;
}

function excerptAround(text, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const collapsed = text.slice(start, end).replace(/\s+/g, ' ').trim();
  const clipped = collapsed.length > 140 ? `${collapsed.slice(0, 140)}...` : collapsed;
  return `${start > 0 ? '...' : ''}${clipped}${end < text.length ? '...' : ''}`;
}

function readFileIfPresent(absolutePath) {
  try {
    return fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function parseJsonDocument(raw) {
  try {
    return { ok: true, value: JSON.parse(raw), error: null };
  } catch (error) {
    return { ok: false, value: null, error: error.message };
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Deterministic ordering that does not depend on the host locale. */
function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Every source file below `dir` with a wanted extension, in sorted path order.
 * A missing or unreadable directory yields no files.
 */
function listSourceFiles(dir, extensions) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries.sort((a, b) => compareStrings(a.name, b.name))) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(absolutePath, extensions));
    } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(absolutePath);
    }
  }
  return files;
}

function toPosixRelative(themeDir, absolutePath) {
  return path.relative(themeDir, absolutePath).split(path.sep).join('/');
}

function extractSectionSchemaBlock(source) {
  const start = SCHEMA_BLOCK_START.exec(source);
  if (!start) return { found: false, terminated: false, body: '' };
  const body = source.slice(start.index + start[0].length);
  const end = SCHEMA_BLOCK_END.exec(body);
  if (!end) return { found: true, terminated: false, body };
  return { found: true, terminated: true, body: body.slice(0, end.index) };
}

/**
 * A usable schema document is an array of groups, each with optional `settings`
 * entries that declare a type (and, when they accept input, a non-empty id) and
 * optional blocks whose settings are checked the same way. A metadata group
 * such as `theme_info` legitimately carries neither.
 */
function describeSettingsSchemaProblem(value) {
  if (!Array.isArray(value)) return 'settings_schema.json must contain an array of setting groups';
  for (let index = 0; index < value.length; index += 1) {
    const group = value[index];
    if (!isPlainObject(group)) return `group ${index} must be an object`;
    const settingsProblem = describeSettingEntriesProblem(group.settings, `group ${index}`);
    if (settingsProblem) return settingsProblem;
    if (group.blocks !== undefined) {
      if (!Array.isArray(group.blocks)) return `group ${index} blocks must be an array`;
      for (let blockIndex = 0; blockIndex < group.blocks.length; blockIndex += 1) {
        const block = group.blocks[blockIndex];
        if (!isPlainObject(block)) return `group ${index} block ${blockIndex} must be an object`;
        const blockProblem = describeSettingEntriesProblem(block.settings, `group ${index} block ${blockIndex}`);
        if (blockProblem) return blockProblem;
      }
    }
  }
  return null;
}

function describeSettingEntriesProblem(entries, where) {
  if (entries === undefined) return null;
  if (!Array.isArray(entries)) return `${where} settings must be an array`;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isPlainObject(entry)) return `${where} setting ${index} must be an object`;
    if (typeof entry.type !== 'string' || entry.type.length === 0) {
      return `${where} setting ${index} must declare a type`;
    }
    if (entry.id !== undefined && (typeof entry.id !== 'string' || entry.id.length === 0)) {
      return `${where} setting ${index} id must be a non-empty string`;
    }
  }
  return null;
}

/** Ids declared anywhere in the schema document, including nested block settings. */
function collectDeclaredSettingIds(themeDir) {
  const ids = new Set();
  const source = readFileIfPresent(path.join(themeDir, 'config', 'settings_schema.json'));
  if (source === null) return ids;
  const parsed = parseJsonDocument(source);
  if (!parsed.ok) return ids;
  collectSettingIds(parsed.value, ids);
  return ids;
}

function collectSettingIds(value, ids) {
  if (Array.isArray(value)) {
    for (const item of value) collectSettingIds(item, ids);
    return;
  }
  if (!isPlainObject(value)) return;
  if (typeof value.id === 'string' && value.id.length > 0 && typeof value.type === 'string') ids.add(value.id);
  for (const key of Object.keys(value)) collectSettingIds(value[key], ids);
}

/**
 * A local reference resolves in `assets/` or `static/`, either as the path it
 * names (`assets/main.css`) or as a bare file name the platform looks up in
 * either directory. Under `assets/` the compiled Liquid spelling also counts.
 * A reference never escapes the theme: traversal segments are refused rather
 * than stat-ed outside the tree.
 */
function localAssetExists(themeDir, ref) {
  const cleanRef = ref
    .split(/[?#]/)[0]
    .replace(/^[\\/]+/, '')
    .replace(/^(?:\.\/)+/, '');
  if (cleanRef.length === 0) return false;

  const scoped = /^(assets|static)\//i.exec(cleanRef);
  if (scoped) {
    const directory = scoped[1].toLowerCase();
    const name = cleanRef.slice(scoped[0].length);
    const names = directory === 'assets' ? [name, ...compiledAssetAliases(name)] : [name];
    return names.some((candidate) => isFileUnder(path.join(themeDir, directory), candidate));
  }

  return (
    ['assets', 'static'].some((directory) => isFileUnder(path.join(themeDir, directory), cleanRef)) ||
    compiledAssetAliases(cleanRef).some((alias) => isFileUnder(path.join(themeDir, 'assets'), alias))
  );
}

/**
 * The platform compiles Liquid assets on upload, so `'blog.js' | asset_url` is
 * satisfied by `assets/blog.js.liquid` and `'color_font.scss.css' | asset_url`
 * by `assets/color_font.scss.liquid`. Both spellings appear in real themes.
 */
function compiledAssetAliases(name) {
  const aliases = [`${name}.liquid`];
  const stem = name.replace(/\.[^./\\]+$/, '');
  if (stem !== name) aliases.push(`${stem}.liquid`);
  return aliases;
}

function isFileUnder(directory, name) {
  const segments = name.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return false;
  try {
    return fs.statSync(path.join(directory, ...segments)).isFile();
  } catch {
    return false;
  }
}

/** Remote origins are recorded protocol-and-host lowercased so repeats collapse. */
function describeRemoteOrigin(ref) {
  const match = /^(https?:)?\/\/([^/?#]+)/i.exec(ref);
  if (!match) return null;
  return `${match[1] ? match[1].toLowerCase() : ''}//${match[2].toLowerCase()}`;
}
