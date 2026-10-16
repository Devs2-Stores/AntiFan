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
 *   HARAVAN_FORBIDDEN_SECTION               -- validateThemeSchemas (platform: haravan)
 *   HARAVAN_FORBIDDEN_SCHEMA, HARAVAN_FORBIDDEN_RENDER,
 *   HARAVAN_FORBIDDEN_FILTER, HARAVAN_CART_ITEM_NAMING,
 *   HARAVAN_BLOG_ARTICLES_COUNT, HARAVAN_MEDIA_TAG_FORBIDDEN,
 *   HARAVAN_MEDIA_NO_FALLBACK,
 *   HARAVAN_INCLUDE_TARGET_MISSING, HARAVAN_SETTING_UNRESOLVED,
 *   HARAVAN_SETTINGS_HTML_MISSING, HARAVAN_SETTINGS_HTML_INVALID,
 *   HARAVAN_SETTINGS_HTML_FORBIDDEN, HARAVAN_SETTINGS_SCHEMA_MISSING,
 *   HARAVAN_SETTINGS_DECLARATIONS_ABSENT,
 *   HARAVAN_NO_DUAL_SURFACE, HARAVAN_SINGLE_CHROME
 *                                           -- checkHaravanLiquidContracts
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

/** Parseable Liquid/BWT source: sections, templates, layout and snippets alike. */
const SOURCE_EXTENSIONS = new Set(['.liquid', '.html', '.bwt']);

const SETTINGS_SCHEMA_RELATIVE_PATH = 'config/settings_schema.json';

/** Legacy declaration source, whose control names are setting ids. */
const SETTINGS_FORM_RELATIVE_PATH = 'config/settings.html';

/**
 * `settings.<id>` where the dot is not preceded by another property access, so
 * `section.settings.x` and `block.settings.x` (section/block scoped settings)
 * are not mistaken for global theme settings.
 *
 * Hyphens are legal inside an id (`settings.footer-top-check-1`), but the id may
 * not end on one: `settings.loomline_addthis_live_show-%}` would otherwise absorb
 * the Liquid whitespace-trim marker into the id and report a phantom id.
 */
const SETTINGS_READ_PATTERN = /(?<![\w.$'"])settings\.([A-Za-z_][A-Za-z0-9_]*(?:-+[A-Za-z0-9_]+)*)/g;

/**
 * `settings['<id>']` — the bracket spelling real Haravan themes use for dynamic
 * keys and for upload settings whose id is the file name (`settings['logo.png']`).
 * A dot-only reader misses those reads entirely.
 */
const SETTINGS_BRACKET_READ_PATTERN = /(?<![\w.$])settings\[\s*(['"])([^'"]+)\1\s*\]/g;

/** Every global setting id a source text reads, in both spellings. */
function matchSettingReadIds(text) {
  const ids = [];
  for (const match of text.matchAll(SETTINGS_READ_PATTERN)) ids.push(match[1]);
  for (const match of text.matchAll(SETTINGS_BRACKET_READ_PATTERN)) ids.push(match[2]);
  return ids;
}
const SETTING_ID_ATTR_PATTERN = /\bsetting-id\s*=\s*(['"])([A-Za-z0-9_-]+)\1/g;
const SETTING_ID_DYN_ATTR_PATTERN = /\bsetting-id\s*=\s*(['"])\{\{[-~]?\s*([A-Za-z_][A-Za-z0-9_]*)\s*[-~]?\}\}\1/g;

function resolveDynamicTemplatesInFile(text) {
  const varTemplates = new Map();
  const addTemplate = (name, tpl) => {
    const cleaned = tpl.replace(/\0DYN\0/g, '');
    if (!cleaned || !/^[A-Za-z0-9_-]+$/.test(cleaned)) return;
    if (!varTemplates.has(name)) varTemplates.set(name, new Set());
    varTemplates.get(name).add(tpl);
  };

  for (const cap of text.matchAll(/\{%[-~]?\s*capture\s+([A-Za-z0-9_]+)\s*[-~]?%\}([\s\S]*?)\{%[-~]?\s*endcapture\s*[-~]?%\}/g)) {
    const varName = cap[1];
    const body = cap[2].trim();
    if (!body.includes('{{') && !/^[A-Za-z0-9_-]+$/.test(body)) continue;
    const tpl = body.replace(/\{\{[\s\S]*?\}\}/g, '\0DYN\0');
    addTemplate(varName, tpl);
  }

  for (let pass = 0; pass < 3; pass += 1) {
    for (const asg of text.matchAll(/\{%[-~]?\s*assign\s+([A-Za-z0-9_]+)\s*=\s*([\s\S]*?)\s*[-~]?%\}/g)) {
      const varName = asg[1];
      const rhs = asg[2].trim();
      const parts = rhs.split(/\|\s*append\s*:\s*/).map((p) => p.trim());
      if (parts.length === 1) {
        const m = parts[0].match(/^(['"])([A-Za-z0-9_-]+)\1$/);
        if (m) addTemplate(varName, m[2]);
        continue;
      }
      let current = [''];
      let valid = true;
      for (const part of parts) {
        const strMatch = part.match(/^(['"])([^'"]*)\1$/);
        if (strMatch) {
          current = current.map((c) => c + strMatch[2]);
        } else if (/^[A-Za-z0-9_]+$/.test(part) && varTemplates.has(part)) {
          const next = [];
          for (const c of current) {
            for (const t of varTemplates.get(part)) next.push(c + t);
          }
          current = next;
        } else if (/^[A-Za-z0-9_.[\]'"]+$/.test(part)) {
          current = current.map((c) => c + '\0DYN\0');
        } else {
          valid = false;
          break;
        }
      }
      if (valid) {
        for (const tpl of current) addTemplate(varName, tpl);
      }
    }
  }
  return varTemplates;
}


/** 1-based line number of the first line matching a pattern, or null. */
function findFirstMatchLine(lines, pattern) {
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) return index + 1;
  }
  return null;
}

/** Control names a settings.html source declares, ignoring commented-out markup. */
function listFormSettingNames(source) {
  const names = [];
  const live = source.replace(HTML_COMMENT_BLOCK, ' ');
  for (const match of live.matchAll(SETTINGS_FORM_NAME_PATTERN)) names.push(match[2]);
  return names;
}

/** A schema document is live only when it declares at least one control. */
function schemaDeclaresControl(value) {
  if (Array.isArray(value)) return value.some(schemaDeclaresControl);
  if (!isPlainObject(value)) return false;
  if (typeof value.type === 'string' && value.type.length > 0) return true;
  return Object.keys(value).some((key) => schemaDeclaresControl(value[key]));
}

/** True when config/settings_schema.json declares at least one control. */
function settingsSchemaIsLive(themeDir) {
  const source = readFileIfPresent(path.join(themeDir, 'config', 'settings_schema.json'));
  if (source === null) return false;
  const parsed = parseJsonDocument(source);
  // An unparseable schema is refused by the schema validator; do not add a
  // second failure for the same file here.
  if (!parsed.ok) return true;
  return schemaDeclaresControl(parsed.value);
}

/** True when config/settings.html declares at least one live control. */
function settingsFormIsLive(themeDir) {
  const source = readFileIfPresent(path.join(themeDir, 'config', 'settings.html'));
  if (source === null) return false;
  return listFormSettingNames(source).length > 0;
}

/** Liquid comments are not reads: a setting mentioned only there is still dead. */
const LIQUID_COMMENT_BLOCK = /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g;

/**
 * Cart-item object names this linter refuses: the two aliases the platform
 * documents as prohibited (`cart_item`, `item_cart`), plus the cart-prefixed
 * invention `cart_line_item`, which has the same defect shape. The loop
 * variable over `cart.items` is free; only the object name counts.
 */
const PROHIBITED_CART_ITEM_NAMES = new Set(['cart_item', 'item_cart', 'cart_line_item']);

/** HTML comments declare nothing: an inert settings form keeps its names inside one. */
const HTML_COMMENT_BLOCK = /<!--[\s\S]*?-->/g;

/**
 * Legacy declaration source: in `config/settings.html` the control `name` is the
 * setting id. Themes that declare settings only here have no schema to read.
 */
const SETTINGS_FORM_NAME_PATTERN = /<(?:input|select|textarea|button)\b[^>]*\sname\s*=\s*(['"])([^'"]+)\1/gi;

const SCHEMA_BLOCK_START = /\{%-?\s*schema\s*-?%\}/;
const SCHEMA_BLOCK_END = /\{%-?\s*endschema\s*-?%\}/;

/**
 * Liquid block tags that must be closed. A theme edit that converts static
 * markup into loops/conditionals fails silently at render time when a closer is
 * lost, so the linter tracks openers against their end* closers.
 */
const LIQUID_BLOCK_TAGS = new Map([
  ['if', 'endif'],
  ['unless', 'endunless'],
  ['case', 'endcase'],
  ['for', 'endfor'],
  ['capture', 'endcapture'],
  ['form', 'endform'],
  ['paginate', 'endpaginate'],
  ['tablerow', 'endtablerow'],
  ['schema', 'endschema'],
]);
const LIQUID_END_TAGS = new Set(LIQUID_BLOCK_TAGS.values());
const LIQUID_TAG_NAME = /\{%-?\s*([A-Za-z_][A-Za-z0-9_]*)/g;

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
export function validateThemeSchemas(themeDir, options = {}) {
  const platform = options.platform ?? null;
  // A Haravan theme declaring settings in legacy HTML mode has no
  // config/settings_schema.json; requiring one unconditionally is the
  // false-requirement defect this flag exists to prevent. Callers that do not
  // pass a mode keep the pre-existing "schema is expected" behaviour.
  const schemaRequired = options.schemaRequired ?? true;
  const failures = [];
  const schemaFiles = [];
  const sections = [];
  const schemaPath = path.join(themeDir, 'config', 'settings_schema.json');
  const schemaSource = readFileIfPresent(schemaPath);
  if (schemaSource === null) {
    if (schemaRequired) {
      schemaFiles.push({ path: SETTINGS_SCHEMA_RELATIVE_PATH, ok: false, error: 'file not found' });
      failures.push({
        rule: 'SETTINGS_SCHEMA_MISSING',
        path: SETTINGS_SCHEMA_RELATIVE_PATH,
        detail: 'config/settings_schema.json is not present in the theme',
      });
    }
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
    if (platform === 'haravan') {
      sections.push({ path: relativePath, ok: false, error: 'sections/ is forbidden in Haravan' });
      failures.push({
        rule: 'HARAVAN_FORBIDDEN_SECTION',
        path: relativePath,
        detail: `sections/ is forbidden in Haravan themes (${relativePath})`,
      });
      continue;
    }
    const source = readFileIfPresent(absolutePath);
    if (source === null) {
      sections.push({ path: relativePath, ok: false, error: 'file not readable' });
      failures.push({ rule: 'SECTION_SCHEMA_UNREADABLE', path: relativePath, detail: 'section file could not be read' });
      continue;
    }

    const block = extractSectionSchemaBlock(source);
    if (!block.found) {
      // Shopify renders schema-less sections through the Section Rendering API and the
      // `{% section %}` tag (Dawn's predictive-search, pickup-availability); only the
      // theme editor needs a schema, so absence is not a defect there. Sapo (.bwt)
      // sections do not use {% schema %} blocks at all.
      if (
        platform === 'shopify' ||
        platform === 'sapo' ||
        path.extname(absolutePath).toLowerCase() === '.bwt'
      ) {
        sections.push({ path: relativePath, ok: true, error: null });
        continue;
      }
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

const HARAVAN_FORBIDDEN_FILTERS = [
  'reject',
  'where',
  'concat',
  'at_most',
  'at_least',
  'image_url',
];
const HARAVAN_FORBIDDEN_FILTER_REGEX = new RegExp(`\\|\\s*(${HARAVAN_FORBIDDEN_FILTERS.join('|')})\\b`, 'g');

const HARAVAN_FORBIDDEN_OBJECTS = ['request\\.'];
const HARAVAN_FORBIDDEN_OBJECT_REGEX = new RegExp(`\\b(${HARAVAN_FORBIDDEN_OBJECTS.join('|')})`, 'g');

/**
 * Verify Haravan platform Liquid contracts and settings mode conditions.
 *
 * Returns { ok, failures } where each failure has { rule, file, line, message, detail }.
 */
export function checkHaravanLiquidContracts(themeDir, options = {}) {
  const failures = [];
  const settingsMode = options.settingsMode ?? 'auto';

  // 1. Check sections/ directory
  const sectionsDir = path.join(themeDir, 'sections');
  if (fs.existsSync(sectionsDir)) {
    const sectionFiles = listSourceFiles(sectionsDir, SOURCE_EXTENSIONS);
    for (const absolutePath of sectionFiles) {
      const relativePath = toPosixRelative(themeDir, absolutePath);
      failures.push({
        rule: 'HARAVAN_FORBIDDEN_SECTION',
        file: relativePath,
        line: 1,
        message: `sections/ is forbidden in Haravan themes (${relativePath})`,
        detail: `sections/ directory is not supported on the Haravan platform`,
      });
    }
  }

  // 2. Settings mode validation
  const settingsHtmlPath = path.join(themeDir, 'config', 'settings.html');
  const settingsSchemaPath = path.join(themeDir, 'config', 'settings_schema.json');
  const settingsDataPath = path.join(themeDir, 'config', 'settings_data.json');

  const hasSettingsHtml = fs.existsSync(settingsHtmlPath);
  const hasSettingsSchema = fs.existsSync(settingsSchemaPath);

  const settingsDataSource = readFileIfPresent(settingsDataPath);
  if (settingsDataSource !== null) {
    const parsedData = parseJsonDocument(settingsDataSource);
    if (!parsedData.ok || !isPlainObject(parsedData.value)) {
      failures.push({
        rule: 'HARAVAN_SETTINGS_DATA_INVALID',
        file: 'config/settings_data.json',
        line: 1,
        message: 'config/settings_data.json is not a valid JSON object',
        detail: parsedData.error || 'root value must be a JSON object',
      });
    }
  }

  if (settingsMode === 'legacy') {
    if (!hasSettingsHtml) {
      failures.push({
        rule: 'HARAVAN_SETTINGS_HTML_MISSING',
        file: 'config/settings.html',
        line: 1,
        message: 'config/settings.html is required in legacy mode',
        detail: 'Legacy Haravan themes require config/settings.html',
      });
    }
  } else if (settingsMode === 'f1genz') {
    // Real F1GENZ themes ship config/settings.html: the merchant form is the
    // operative declaration surface whenever the paired schema carries no
    // control. Refusing the form outright rejects the shipped shape of the
    // branch, so the refusal is scoped to the case where the schema is live.
    if (hasSettingsHtml && settingsSchemaIsLive(themeDir)) {
      failures.push({
        rule: 'HARAVAN_SETTINGS_HTML_FORBIDDEN',
        file: 'config/settings.html',
        line: 1,
        message: 'config/settings.html must be absent when config/settings_schema.json declares settings',
        detail: 'A live F1GENZ schema is the declaration surface: the legacy form duplicates it',
      });
    }
    if (!hasSettingsSchema) {
      failures.push({
        rule: 'HARAVAN_SETTINGS_SCHEMA_MISSING',
        file: 'config/settings_schema.json',
        line: 1,
        message: 'config/settings_schema.json is required in f1genz mode',
        detail: 'F1GENZ themes require config/settings_schema.json',
      });
    }
  }

  // A theme declares its settings in `config/settings_schema.json`, in the
  // legacy `config/settings.html` form, or in both. A schema that holds no
  // control plus a form whose controls are all commented out declares nothing,
  // and every settings read in the theme is then unbacked.
  if (hasSettingsSchema && !settingsSchemaIsLive(themeDir) && !settingsFormIsLive(themeDir)) {
    failures.push({
      rule: 'HARAVAN_SETTINGS_DECLARATIONS_ABSENT',
      file: 'config/settings_schema.json',
      line: 1,
      message: 'no live settings declaration: the schema declares no control and settings.html is inert',
      detail: 'config/settings_schema.json carries no selectable setting and config/settings.html declares none outside comments',
    });
  }

  const fileInputNames = new Set();
  if (hasSettingsHtml) {
    const htmlSource = readFileIfPresent(settingsHtmlPath) ?? '';
    const lines = htmlSource.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.includes('{%') || line.includes('{{')) {
        failures.push({
          rule: 'HARAVAN_SETTINGS_HTML_INVALID',
          file: 'config/settings.html',
          line: i + 1,
          message: 'config/settings.html must be pure HTML without Liquid tags',
          detail: `Liquid tag found at line ${i + 1} of config/settings.html`,
        });
        break;
      }
    }

    // Parse controls, extract file inputs, and detect duplicate control names (HARAVAN_SETTINGS_DUPLICATE_NAME)
    const strippedHtml = htmlSource.replace(HTML_COMMENT_BLOCK, (match) => match.replace(/[^\r\n]/g, ' '));
    const controlTagRegex = /<(input|select|textarea)\b([^>]*)>/gi;
    let controlMatch;
    const occurrences = new Map();
    while ((controlMatch = controlTagRegex.exec(strippedHtml)) !== null) {
      const tag = controlMatch[1].toLowerCase();
      const attrs = controlMatch[2];
      const nameMatch = /\bname\s*=\s*(?:['"]([^'"]+)['"]|([^\s>]+))/i.exec(attrs);
      if (nameMatch) {
        const name = nameMatch[1] ?? nameMatch[2];
        let type = tag;
        if (tag === 'input') {
          const typeMatch = /\btype\s*=\s*(?:['"]([^'"]+)['"]|([^\s>]+))/i.exec(attrs);
          type = (typeMatch ? (typeMatch[1] ?? typeMatch[2]) : 'text').toLowerCase();
          if (type === 'file') {
            fileInputNames.add(name);
          }
        }
        const line = strippedHtml.slice(0, controlMatch.index).split('\n').length;
        if (!occurrences.has(name)) occurrences.set(name, []);
        occurrences.get(name).push({ type, line });
      }
    }

    for (const [name, entries] of occurrences.entries()) {
      if (entries.length > 1) {
        const allRadio = entries.every((e) => e.type === 'radio');
        if (!allRadio) {
          failures.push({
            rule: 'HARAVAN_SETTINGS_DUPLICATE_NAME',
            id: name,
            file: 'config/settings.html',
            line: entries[1].line,
            message: `Duplicate setting control name '${name}' in config/settings.html`,
            detail: `Found ${entries.length} controls sharing name '${name}'. Every non-radio control must have a unique name.`,
          });
        }
      }
    }
  }

  // Collect all declared settings keys (strictly from declarations, excluding settings_data.json)
  const knownSettings = collectDeclaredSettingIds(themeDir);
  // 3. Scan all Liquid source files
  const liquidDirs = ['layout', 'templates', 'snippets', 'sections'];
  for (const directory of liquidDirs) {
    const dirPath = path.join(themeDir, directory);
    if (!fs.existsSync(dirPath)) continue;
    for (const absolutePath of listSourceFiles(dirPath, SOURCE_EXTENSIONS)) {
      const relativePath = toPosixRelative(themeDir, absolutePath);
      const rawSource = readFileIfPresent(absolutePath);
      if (rawSource === null) continue;

      // Strip Liquid comments while preserving newlines
      const source = rawSource.replace(LIQUID_COMMENT_BLOCK, (match) => match.replace(/[^\r\n]/g, ' '));
      const lines = source.split('\n');
      // Pre-scan capture blocks that assign image filenames
      const capturedImageVars = new Map();
      const CAPTURE_BLOCK_REGEX = /\{%-?\s*capture\s+([A-Za-z0-9_]+)\s*-?%}([\s\S]*?)\{%-?\s*endcapture\s*-?%}/g;
      let captureMatch;
      while ((captureMatch = CAPTURE_BLOCK_REGEX.exec(source)) !== null) {
        const varName = captureMatch[1];
        const body = captureMatch[2].trim();
        if (/\.(?:png|jpe?g|webp|gif|ico|svg|bmp|avif)$/i.test(body)) {
          const captureLine = source.slice(0, captureMatch.index).split('\n').length;
          // Multiple capture blocks may reuse one var name in a file (e.g. a
          // header loop and a footer loop both capturing `img_k`); keep every
          // occurrence so a later capture never blinds an earlier read.
          const list = capturedImageVars.get(varName) ?? [];
          list.push({ pattern: body, line: captureLine });
          capturedImageVars.set(varName, list);
        }
      }


      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const lineNum = lineIndex + 1;
        const lineText = lines[lineIndex];

        // Check HARAVAN_NO_DUAL_SURFACE
        if (/theme-surface-(?:desktop|mobile)\b/.test(lineText)) {
          failures.push({
            rule: 'HARAVAN_NO_DUAL_SURFACE',
            file: relativePath,
            line: lineNum,
            message: `Dual-surface wrapper class found in ${relativePath}`,
            detail: `Haravan themes must be pure 1-DOM responsive. Dual-surface split containers ('theme-surface-desktop'/'theme-surface-mobile') are forbidden (${relativePath}:${lineNum})`,
          });
        }

        // Check {% schema %}
        if (/\{%-?\s*schema\b/.test(lineText)) {
          failures.push({
            rule: 'HARAVAN_FORBIDDEN_SCHEMA',
            file: relativePath,
            line: lineNum,
            message: '{% schema %} blocks are forbidden in Haravan themes',
            detail: `Haravan themes cannot use {% schema %} blocks (${relativePath}:${lineNum})`,
          });
        }

        // Check {% render %}
        if (/\{%-?\s*render\b/.test(lineText)) {
          failures.push({
            rule: 'HARAVAN_FORBIDDEN_RENDER',
            file: relativePath,
            line: lineNum,
            message: '{% render %} is forbidden in Haravan themes, use {% include %}',
            detail: `Haravan DotLiquid engine does not support {% render %} (${relativePath}:${lineNum})`,
          });
        }

        // Check forbidden filters
        let filterMatch;
        HARAVAN_FORBIDDEN_FILTER_REGEX.lastIndex = 0;
        while ((filterMatch = HARAVAN_FORBIDDEN_FILTER_REGEX.exec(lineText)) !== null) {
          const filterName = filterMatch[1];
          failures.push({
            rule: 'HARAVAN_FORBIDDEN_FILTER',
            file: relativePath,
            line: lineNum,
            message: `Shopify-only filter '${filterName}' is forbidden in Haravan themes`,
            detail: `Filter '${filterName}' is not supported in Haravan DotLiquid (${relativePath}:${lineNum})`,
          });
        }
        // Check forbidden Shopify objects
        let objectMatch;
        HARAVAN_FORBIDDEN_OBJECT_REGEX.lastIndex = 0;
        while ((objectMatch = HARAVAN_FORBIDDEN_OBJECT_REGEX.exec(lineText)) !== null) {
          const objName = objectMatch[1].replace('\\.', '.');
          failures.push({
            rule: 'HARAVAN_FORBIDDEN_OBJECT',
            file: relativePath,
            line: lineNum,
            message: `Shopify-only object '${objName}' is forbidden in Haravan themes`,
            detail: `Object '${objName}' is not supported in Haravan DotLiquid (${relativePath}:${lineNum})`,
          });
        }


        // Haravan documents `line_item` as the cart item object and prohibits the
        // aliases `cart_item` / `item_cart`; the loop variable name itself is free
        // (`for item in cart.items` is the dominant spelling in real themes).
        const cartLoopMatch = /\{%-?\s*for\s+([A-Za-z0-9_]+)\s+in\s+cart\.items\b/.exec(lineText);
        if (cartLoopMatch && PROHIBITED_CART_ITEM_NAMES.has(cartLoopMatch[1])) {
          failures.push({
            rule: 'HARAVAN_CART_ITEM_NAMING',
            file: relativePath,
            line: lineNum,
            message: `cart item alias '${cartLoopMatch[1]}' is prohibited; iterate cart.items directly`,
            detail: `Haravan names the cart item object 'line_item' and prohibits '${cartLoopMatch[1]}' (${relativePath}:${lineNum})`,
          });
        }

        // Check blog.articles_count vs articles.size. `articles.size` is only
        // wrong when it stands for a total; `{% if articles.size > 0 %}` is an
        // emptiness test and stays legal.
        const articleSizeMatch = /\b(?:blog\.)?articles\.size\b/g;
        for (
          let sizeMatch = articleSizeMatch.exec(lineText);
          sizeMatch !== null;
          sizeMatch = articleSizeMatch.exec(lineText)
        ) {
          const tail = lineText.slice(sizeMatch.index + sizeMatch[0].length);
          if (/^\s*(?:[<>]=?|==|!=)\s*[01]\b/.test(tail)) continue;
          failures.push({
            rule: 'HARAVAN_BLOG_ARTICLES_COUNT',
            file: relativePath,
            line: lineNum,
            message: 'use blog.articles_count for article totals instead of articles.size',
            detail: `Haravan DotLiquid requires blog.articles_count (${relativePath}:${lineNum})`,
          });
        }

        // product.media and media_tag are checked once per file, below.

        // Check include target resolution
        const includeMatches = lineText.matchAll(/\{%-?\s*include\s+['"]([A-Za-z0-9_.-]+)['"]/g);
        for (const incMatch of includeMatches) {
          const snippetName = incMatch[1];
          const snippetFileLiquid = path.join(themeDir, 'snippets', `${snippetName}.liquid`);
          const snippetFileHtml = path.join(themeDir, 'snippets', `${snippetName}.html`);
          const snippetFileDirect = path.join(themeDir, 'snippets', snippetName);
          if (
            !fs.existsSync(snippetFileLiquid) &&
            !fs.existsSync(snippetFileHtml) &&
            !fs.existsSync(snippetFileDirect)
          ) {
            failures.push({
              rule: 'HARAVAN_INCLUDE_TARGET_MISSING',
              file: relativePath,
              line: lineNum,
              message: `included snippet '${snippetName}' does not exist under snippets/`,
              detail: `Target snippet '${snippetName}' was not found in snippets/ (${relativePath}:${lineNum})`,
            });
          }
        }

        // Check upload settings reads and unresolved settings
        const settingsMatches = matchSettingReadIds(lineText);
        for (const settingId of settingsMatches) {
          if (fileInputNames.has(settingId)) {
            failures.push({
              rule: 'HARAVAN_SETTINGS_UPLOAD_READ',
              id: settingId,
              file: relativePath,
              line: lineNum,
              message: `Upload setting '${settingId}' must be referenced via '${settingId}' | asset_url, not settings['${settingId}']`,
              detail: `An <input type="file"> uploads an asset to assets/. Reading it via settings object fails or breaks asset resolution.`,
            });
          } else if (knownSettings.size > 0 && !knownSettings.has(settingId)) {
            failures.push({
              rule: 'HARAVAN_SETTING_UNRESOLVED',
              id: settingId,
              file: relativePath,
              line: lineNum,
              message: `setting 'settings.${settingId}' is read but unresolved in config/settings_schema.json or config/settings.html`,
              detail: `Unresolved setting id '${settingId}' (${relativePath}:${lineNum})`,
            });
          }
        }

        // Check dynamic bracket reads preceded by a capture block ending in an image extension
        const SETTINGS_DYNAMIC_BRACKET_REGEX = /(?<![\w.$])settings\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]/g;
        let dynMatch;
        while ((dynMatch = SETTINGS_DYNAMIC_BRACKET_REGEX.exec(lineText)) !== null) {
          const dynVar = dynMatch[1];
          if (capturedImageVars.has(dynVar)) {
            const entries = capturedImageVars.get(dynVar);
            // Resolve the active capture: the most recent capture of this var
            // at or before the read line. A read must never bind to a capture
            // declared below it.
            const entry = [...entries].reverse().find((e) => lineNum >= e.line);
            if (entry) {
              failures.push({
                rule: 'HARAVAN_SETTINGS_UPLOAD_READ',
                id: entry.pattern,
                file: relativePath,
                line: lineNum,
                message: `Upload setting '${entry.pattern}' must be referenced via '${entry.pattern}' | asset_url, not settings['${entry.pattern}']`,
                detail: `An <input type="file"> uploads an asset to assets/. Reading it via settings object fails or breaks asset resolution.`,
              });
            }
          }
        }
      }

      // Single Paginate Invariant (DotLiquid .NET Crash Guard)
      const paginateCount = (source.match(/\{%-?\s*paginate\b/g) || []).length;
      if (paginateCount > 1) {
        failures.push({
          rule: 'HARAVAN_DUPLICATE_PAGINATE',
          file: relativePath,
          line: 1,
          message: `Multiple {% paginate %} tags detected (${paginateCount}). Haravan DotLiquid permits at most one paginate block per template.`,
          detail: `Having more than one paginate tag causes DotLiquid fatal HTTP 500 error on Haravan (${relativePath})`,
        });
      }

      // Product media access: `media_tag` is an unverified filter, and a
      // `product.media` gallery is only acceptable when the same file also
      // reaches the proven image fields, so a theme without the media extension
      // still renders something. Blanket-banning product.media refuses a
      // construct real Haravan themes ship. `source` is already comment-stripped:
      // a documented example is not a media read, and a commented-out fallback
      // is not a fallback.
      const mediaTagLine = findFirstMatchLine(lines, /\bmedia_tag\b/);
      if (mediaTagLine !== null) {
        failures.push({
          rule: 'HARAVAN_MEDIA_TAG_FORBIDDEN',
          file: relativePath,
          line: mediaTagLine,
          message: 'media_tag is unverified in Haravan runtime; use product.images',
          detail: `media_tag has no verified Haravan runtime support (${relativePath}:${mediaTagLine})`,
        });
      }
      const mediaLine = findFirstMatchLine(lines, /\bproduct\.media\b/);
      if (mediaLine !== null && !/\bproduct\.(?:images|featured_image)\b/.test(source)) {
        failures.push({
          rule: 'HARAVAN_MEDIA_NO_FALLBACK',
          file: relativePath,
          line: mediaLine,
          message: 'product.media is read without a product.images fallback in the same file',
          detail: `product.media needs a proven fallback (product.images or product.featured_image) in ${relativePath} (${relativePath}:${mediaLine})`,
        });
      }

      // Check Liquid block-tag balance: every opener needs its end* closer.
      // Scans the raw source with an explicit comment/raw suppression state so
      // tags shown inside documentation comments are never counted.
      const openTags = [];
      let suppressDepth = 0;
      LIQUID_TAG_NAME.lastIndex = 0;
      let tagMatch;
      while ((tagMatch = LIQUID_TAG_NAME.exec(rawSource)) !== null) {
        const tagName = tagMatch[1].toLowerCase();
        const tagLine = rawSource.slice(0, tagMatch.index).split('\n').length;
        if (suppressDepth > 0) {
          if (tagName === 'comment' || tagName === 'raw') suppressDepth += 1;
          else if (tagName === 'endcomment' || tagName === 'endraw') suppressDepth -= 1;
          continue;
        }
        if (tagName === 'comment' || tagName === 'raw') {
          suppressDepth = 1;
          continue;
        }
        if (LIQUID_BLOCK_TAGS.has(tagName)) {
          openTags.push({ tag: tagName, line: tagLine });
          continue;
        }
        if (!LIQUID_END_TAGS.has(tagName)) continue;
        const opened = openTags.pop();
        if (!opened || LIQUID_BLOCK_TAGS.get(opened.tag) !== tagName) {
          failures.push({
            rule: 'HARAVAN_LIQUID_TAG_UNBALANCED',
            file: relativePath,
            line: tagLine,
            message: `{% ${tagName} %} does not close the open block`,
            detail: opened
              ? `{% ${tagName} %} at line ${tagLine} closes {% ${opened.tag} %} opened at line ${opened.line} (${relativePath})`
              : `Unexpected {% ${tagName} %} with no open block (${relativePath}:${tagLine})`,
          });
        }
      }
      for (const opened of openTags) {
        failures.push({
          rule: 'HARAVAN_LIQUID_TAG_UNBALANCED',
          file: relativePath,
          line: opened.line,
          message: `{% ${opened.tag} %} is never closed`,
          detail: `Unclosed {% ${opened.tag} %} opened at line ${opened.line} (${relativePath}:${opened.line})`,
        });
      }
    }
  }

  // 4. Single chrome checks: single header snippet, single footer snippet, no duplicate header includes in layout
  const headerSnippetPath = path.join(themeDir, 'snippets', 'header.liquid');
  if (fs.existsSync(headerSnippetPath)) {
    const rawHeader = readFileIfPresent(headerSnippetPath) ?? '';
    const headerSource = rawHeader.replace(LIQUID_COMMENT_BLOCK, (match) => match.replace(/[^\r\n]/g, ' '));
    const headerMatches = headerSource.match(/<header\b/gi) || [];
    if (headerMatches.length > 1) {
      failures.push({
        rule: 'HARAVAN_SINGLE_CHROME',
        file: 'snippets/header.liquid',
        line: 1,
        message: `snippets/header.liquid must have at most 1 <header> tag, found ${headerMatches.length}`,
        detail: `Multiple <header> tags found in snippets/header.liquid (${headerMatches.length}). Themes must use a single canonical <header> container.`,
      });
    }
  }

  const footerSnippetPath = path.join(themeDir, 'snippets', 'footer.liquid');
  if (fs.existsSync(footerSnippetPath)) {
    const rawFooter = readFileIfPresent(footerSnippetPath) ?? '';
    const footerSource = rawFooter.replace(LIQUID_COMMENT_BLOCK, (match) => match.replace(/[^\r\n]/g, ' '));
    const footerMatches = footerSource.match(/<footer\b/gi) || [];
    if (footerMatches.length > 1) {
      failures.push({
        rule: 'HARAVAN_SINGLE_CHROME',
        file: 'snippets/footer.liquid',
        line: 1,
        message: `snippets/footer.liquid must have at most 1 <footer> tag, found ${footerMatches.length}`,
        detail: `Multiple <footer> tags found in snippets/footer.liquid (${footerMatches.length}). Themes must use a single canonical <footer> container.`,
      });
    }
  }

  const themeLayoutPath = path.join(themeDir, 'layout', 'theme.liquid');
  if (fs.existsSync(themeLayoutPath)) {
    const rawThemeLayout = readFileIfPresent(themeLayoutPath) ?? '';
    const themeLayoutSource = rawThemeLayout.replace(LIQUID_COMMENT_BLOCK, (match) => match.replace(/[^\r\n]/g, ' '));
    const hasHeaderInclude = /\{%-?\s*include\s+['"](?:snippets\/)?header(?:\.liquid)?['"]/.test(themeLayoutSource);
    const hasHeaderMobileInclude = /\{%-?\s*include\s+['"](?:snippets\/)?header-mobile(?:\.liquid)?['"]/.test(themeLayoutSource);
    if (hasHeaderInclude && hasHeaderMobileInclude) {
      failures.push({
        rule: 'HARAVAN_SINGLE_CHROME',
        file: 'layout/theme.liquid',
        line: 1,
        message: 'layout/theme.liquid must not include both header and header-mobile',
        detail: 'Theme layout includes duplicate chrome (both header and header-mobile snippets). Themes must use a single responsive header.',
      });
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Bind every global `settings.<id>` read in the theme source to an id declared
 * in `config/settings_schema.json` (nested section block settings included). A
 * read with no declaration is a named failure; a declared id the source never
 * reads is reported as dead, which is a smell rather than a refusal.
 */
export function checkSettingsBinding(themeDir) {
  const declared = collectDeclaredSettingIds(themeDir);
  const reads = new Map();
  const recordRead = (id, relativePath) => {
    if (!reads.has(id)) reads.set(id, new Set());
    reads.get(id).add(relativePath);
  };
  for (const directory of SOURCE_DIRECTORIES) {
    for (const absolutePath of listSourceFiles(path.join(themeDir, directory), SOURCE_EXTENSIONS)) {
      const source = readFileIfPresent(absolutePath);
      if (source === null) continue;
      const relativePath = toPosixRelative(themeDir, absolutePath);
      const stripped = source.replace(LIQUID_COMMENT_BLOCK, ' ');
      for (const id of matchSettingReadIds(stripped)) {
        recordRead(id, relativePath);
      }
      const htmlClean = stripped.replace(HTML_COMMENT_BLOCK, ' ');
      for (const attrMatch of htmlClean.matchAll(SETTING_ID_ATTR_PATTERN)) {
        recordRead(attrMatch[2], relativePath);
      }
      const varTemplates = resolveDynamicTemplatesInFile(stripped);
      if (varTemplates.size > 0 && declared.size > 0) {
        const dynVars = new Set();
        for (const m of stripped.matchAll(/(?<![\w.$])settings\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]/g)) {
          dynVars.add(m[1]);
        }
        for (const m of htmlClean.matchAll(SETTING_ID_DYN_ATTR_PATTERN)) {
          dynVars.add(m[2]);
        }
        for (const varName of dynVars) {
          const tpls = varTemplates.get(varName);
          if (!tpls) continue;
          for (const tpl of tpls) {
            const pattern = tpl
              .split('\0DYN\0')
              .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('[A-Za-z0-9_-]+');
            const re = new RegExp(`^${pattern}$`);
            for (const id of declared) {
              if (re.test(id)) recordRead(id, relativePath);
            }
          }
        }
      }
    }
  }

  const undeclared = [];
  const failures = [];
  for (const id of [...reads.keys()].sort(compareStrings)) {
    if (declared.has(id)) continue;
    const files = [...reads.get(id)].sort(compareStrings);
    undeclared.push({ id, files });
    const detail = `settings.${id} is read in ${files.join(', ')} but is declared in neither ${SETTINGS_SCHEMA_RELATIVE_PATH} nor the control names of ${SETTINGS_FORM_RELATIVE_PATH}`;
    failures.push({
      rule: 'SETTING_UNDECLARED',
      id,
      file: files[0],
      files,
      message: detail,
      detail,
    });
  }

  const dead = [...declared]
    .filter((id) => !reads.has(id))
    .sort(compareStrings)
    .map((id) => ({ id }));

  return { ok: failures.length === 0, undeclared, dead, failures };
}

const F1GENZ_CONTENT_SETTING_TYPES = new Set([
  'text', 'textarea', 'image_picker', 'link_list', 'collection', 'blog', 'page',
]);
const F1GENZ_HSTATIC_HTTPS_RE = /^https:\/\/[a-z0-9.-]*hstatic\.net\/.+/i;
const F1GENZ_OTHER_HTTPS_RE = /^https:\/\/[a-z0-9.-]+\/.+/i;
const F1GENZ_THEME_SCOPED_URL_RE = /\/themes\/[^/]+\/[^/]+\//i;
const F1GENZ_SOCIAL_ID_RE = /(facebook|instagram|tiktok|youtube|zalo|shopee|lazada)/i;
const F1GENZ_TECHNICAL_LITERAL_RE = /^\s*-?\d+(\.\d+)?(px|rem|em|%|vh|vw|s|ms|deg|fr)?\s*$|^#[0-9a-f]{3,8}$|^(true|false)$/i;

function maskRangesPreserveNewlines(str, regex) {
  return str.replace(regex, (m) => m.replace(/[^\r\n]/g, ' '));
}

function isBareSocialDomainUrl(rawVal) {
  if (typeof rawVal !== 'string') return false;
  const trimmed = rawVal.trim();
  if (!trimmed || trimmed === '#') return false;
  let candidate = trimmed;
  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) && /^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname || !parsed.hostname.includes('.')) return false;
    return (parsed.pathname === '' || parsed.pathname === '/') && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function getContentSettingFromCondition(cond, kind, settingsVars, varTemplates, settingMap) {
  const trimmed = cond.trim();
  if (!trimmed) return null;
  const clauses = trimmed.split(/\b(?:and|or)\b/i).map((c) => c.trim()).filter(Boolean);
  let matchedSettingId = null;
  for (const clause of clauses) {
    const settingMatch = clause.match(/settings(?:\.([A-Za-z0-9_]+)|\[\s*(?:['"]([A-Za-z0-9_-]+)['"]|([A-Za-z0-9_]+))\s*\])/);
    let ref = settingMatch ? (settingMatch[1] || settingMatch[2] || settingMatch[3]) : null;
    let exprEnd = settingMatch ? settingMatch.index + settingMatch[0].length : 0;
    let exprStart = settingMatch ? settingMatch.index : 0;
    if (!ref) {
      for (const m of clause.matchAll(/(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)(?![.\w[])/g)) {
        if (settingsVars.has(m[1])) {
          ref = settingsVars.get(m[1]);
          exprStart = m.index;
          exprEnd = m.index + m[0].length;
          break;
        }
      }
    }
    if (!ref) return null;
    let isContentSetting = false;
    let resolvedId = ref;
    if (settingMap.has(ref)) {
      isContentSetting = F1GENZ_CONTENT_SETTING_TYPES.has(settingMap.get(ref).type);
    } else if (varTemplates && varTemplates.has(ref)) {
      for (const tpl of varTemplates.get(ref)) {
        const pattern = tpl
          .split('\0DYN\0')
          .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[A-Za-z0-9_]+');
        const re = new RegExp(`^${pattern}$`);
        for (const [sid, sObj] of settingMap.entries()) {
          if (re.test(sid) && F1GENZ_CONTENT_SETTING_TYPES.has(sObj.type)) {
            isContentSetting = true;
            resolvedId = sid;
            break;
          }
        }
      }
    } else if (!/(?:^|_)(enable|disable|show|hide|autoplay)(?:_|$)/i.test(ref)) {
      isContentSetting = true;
    }
    if (!isContentSetting) return null;
    const afterTrim = clause.slice(exprEnd).trim();
    const beforeTrim = clause.slice(0, exprStart).trim();
    if (kind === 'if' || kind === 'elsif') {
      if (
        /^!=\s*(?:blank|nil|empty|''|"")(?:\b|$)/.test(afterTrim) ||
        /^\.[A-Za-z0-9_.]+\s*!=\s*(?:blank|nil|empty|''|"")(?:\b|$)/.test(afterTrim) ||
        /^\.size\s*>\s*0\b/.test(afterTrim)
      ) {
        matchedSettingId = matchedSettingId || resolvedId;
      } else if (afterTrim === '' && !/(?:==|!=|<=|>=|<|>|contains)\s*$/.test(beforeTrim)) {
        matchedSettingId = matchedSettingId || resolvedId;
      } else {
        return null;
      }
    } else if (kind === 'unless') {
      if (/^==\s*(?:blank|nil|empty|''|"")(?:\b|$)/.test(afterTrim)) {
        matchedSettingId = matchedSettingId || resolvedId;
      } else {
        return null;
      }
    }
  }
  return matchedSettingId;
}

/**
 * The company branch a theme workspace declares in .workspace-context.json ("f1genz", "devs2", ...),
 * or null when the workspace declares none.
 */
export function readWorkspaceBranch(themeDir) {
  for (const name of ['.workspace-context.json', 'workspace-context.json']) {
    const parsed = parseJsonDocument(readFileIfPresent(path.join(themeDir, name)) ?? '');
    if (parsed.ok && parsed.value && typeof parsed.value.branch === 'string' && parsed.value.branch.trim()) {
      return parsed.value.branch.trim().toLowerCase();
    }
  }
  return null;
}

/**
 * F1genz house rules for settings_schema.json and the Liquid that reads it. They are brand
 * conventions, not platform contracts, so they run only on a workspace whose
 * .workspace-context.json names the f1genz branch (or when options.branch says so); any other
 * workspace gets an empty, skipped result.
 */
export function checkF1genzSettingsSchema(themeDir, options = {}) {
  const errors = [];
  const warnings = [];
  const info = [];
  const branch = typeof options.branch === 'string' ? options.branch.trim().toLowerCase() : readWorkspaceBranch(themeDir);
  if (branch !== 'f1genz') {
    return { ok: true, errors, warnings, info, failures: errors, skipped: 'workspace is not on the f1genz branch' };
  }
  const normalizeFinding = (rule, message, meta = {}) => {
    const out = { rule, message };
    if (meta.file !== undefined && meta.file !== null) {
      out.file = String(meta.file).replace(/\\/g, '/');
    }
    if (typeof meta.line === 'number' && meta.line > 0) {
      out.line = meta.line;
    }
    const k = meta.id !== undefined ? meta.id : meta.key;
    if (k !== undefined && k !== null) {
      out.id = String(k);
      out.key = String(k);
    }
    return out;
  };
  const fail = (rule, message, meta) => errors.push(normalizeFinding(rule, message, meta));
  const warn = (rule, message, meta) => warnings.push(normalizeFinding(rule, message, meta));

  const schemaPath = path.join(themeDir, 'config', 'settings_schema.json');
  const rawSchemaText = readFileIfPresent(schemaPath);
  if (rawSchemaText === null) {
    return { ok: true, errors, warnings, info, failures: errors };
  }
  const parsedSchema = parseJsonDocument(rawSchemaText);
  if (!parsedSchema.ok || !Array.isArray(parsedSchema.value)) {
    return { ok: true, errors, warnings, info, failures: errors };
  }
  const schema = parsedSchema.value;

  const residueWordsRaw = Array.isArray(options.residueWords)
    ? options.residueWords
    : typeof options.residueWords === 'string'
      ? options.residueWords.split(',')
      : [];
  const residuePatterns = [];
  const seenResidue = new Set();
  for (const rawWord of residueWordsRaw) {
    const norm = String(rawWord).normalize('NFC').trim();
    if (!norm) continue;
    const lower = norm.toLowerCase();
    if (seenResidue.has(lower)) continue;
    seenResidue.add(lower);
    const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    residuePatterns.push({
      word: norm,
      regex: new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu'),
    });
  }
  const checkResidue = (str, fieldDesc, meta) => {
    if (!residuePatterns.length || typeof str !== 'string' || !str) return;
    const norm = str.normalize('NFC');
    for (const { word, regex } of residuePatterns) {
      if (regex.test(norm)) {
        fail(
          'residue-vocabulary',
          `${meta.file}:${meta.line || 1} (${meta.id || 'schema'}) ${fieldDesc} contains donor residue vocabulary '${word}': "${str.slice(0, 80)}"`,
          meta,
        );
      }
    }
  };

  const idLines = new Map();
  const groupLines = new Map();
  for (const m of rawSchemaText.matchAll(/"id"\s*:\s*"([^"]+)"/g)) {
    if (!idLines.has(m[1])) idLines.set(m[1], lineOfIndex(rawSchemaText, m.index));
  }
  for (const m of rawSchemaText.matchAll(/"name"\s*:\s*"([^"]+)"/g)) {
    if (!groupLines.has(m[1])) groupLines.set(m[1], []);
    groupLines.get(m[1]).push(lineOfIndex(rawSchemaText, m.index));
  }
  const getSettingLine = (id) => idLines.get(id) || 1;
  const getGroupLine = (name, occ = 1) => {
    const list = groupLines.get(name);
    if (!list || !list.length) return 1;
    return list[Math.min(occ - 1, list.length - 1)] || 1;
  };

  const sectionNames = new Map();
  const groupNumberMap = new Map();
  const settingMap = new Map();

  for (const [sectionIndex, section] of schema.entries()) {
    if (!isPlainObject(section)) continue;
    if (typeof section.name === 'string' && section.name) {
      const prevCount = sectionNames.get(section.name) || 0;
      sectionNames.set(section.name, prevCount + 1);
      const groupLine = getGroupLine(section.name, prevCount + 1);
      if (prevCount > 0) {
        fail('duplicate-group', `duplicate section name: ${section.name}`, {
          file: 'config/settings_schema.json',
          line: groupLine,
          id: section.name,
        });
      }
      const numMatch = section.name.match(/^\s*(\d+)\s*[.:\-)]/);
      if (numMatch) {
        const groupNum = numMatch[1];
        if (groupNumberMap.has(groupNum) && groupNumberMap.get(groupNum) !== section.name) {
          fail(
            'duplicate-group',
            `duplicate numbered group prefix '${groupNum}.': "${section.name}" conflicts with "${groupNumberMap.get(groupNum)}"`,
            { file: 'config/settings_schema.json', line: groupLine, id: section.name },
          );
        } else {
          groupNumberMap.set(groupNum, section.name);
        }
      }
    }
    if (!Array.isArray(section.settings)) continue;
    for (const [settingIndex, setting] of section.settings.entries()) {
      if (!isPlainObject(setting)) continue;
      const location = `${section.name || sectionIndex + 1} setting ${settingIndex + 1}`;
      const settingLine = setting.id ? getSettingLine(setting.id) : getGroupLine(section.name || '', 1);
      if (setting.type === 'header' || setting.type === 'paragraph') {
        if (setting.content) {
          checkResidue(setting.content, 'content', {
            file: 'config/settings_schema.json',
            line: settingLine,
            id: section.name || location,
          });
        }
        continue;
      }
      if (!setting.id || typeof setting.id !== 'string') continue;
      if (!settingMap.has(setting.id)) {
        settingMap.set(setting.id, { ...setting, sectionName: section.name, sectionIndex, line: settingLine });
      }
      checkResidue(setting.label, 'label', { file: 'config/settings_schema.json', line: settingLine, id: setting.id });
      checkResidue(setting.info, 'info', { file: 'config/settings_schema.json', line: settingLine, id: setting.id });
      if (typeof setting.default === 'string') {
        checkResidue(setting.default, 'default', { file: 'config/settings_schema.json', line: settingLine, id: setting.id });
      }
      if ((setting.type === 'select' || setting.type === 'radio') && Array.isArray(setting.options)) {
        const validValues = new Set();
        for (const opt of setting.options) {
          if (isPlainObject(opt)) {
            if (opt.value !== undefined) validValues.add(String(opt.value));
            if (typeof opt.label === 'string') {
              checkResidue(opt.label, 'options[].label', {
                file: 'config/settings_schema.json',
                line: settingLine,
                id: setting.id,
              });
            }
          }
        }
        if (setting.default !== undefined && setting.default !== null) {
          const defStr = String(setting.default);
          if (!validValues.has(defStr)) {
            fail(
              'select-default-invalid',
              `${location} (${setting.id}) default '${defStr}' is not in options[].value (${[...validValues].join(', ')})`,
              { file: 'config/settings_schema.json', line: settingLine, id: setting.id },
            );
          }
        }
      }
    }
  }

  const settingsDataPath = path.join(themeDir, 'config', 'settings_data.json');
  const rawDataText = readFileIfPresent(settingsDataPath) ?? '';
  const parsedData = rawDataText ? parseJsonDocument(rawDataText) : { ok: false, value: null };
  const settingsData = parsedData.ok && isPlainObject(parsedData.value) ? parsedData.value : null;
  const dataKeyLines = new Map();
  for (const m of rawDataText.matchAll(/"([^"]+)"\s*:/g)) {
    if (!dataKeyLines.has(m[1])) dataKeyLines.set(m[1], lineOfIndex(rawDataText, m.index));
  }
  const getDataKeyLine = (key) => dataKeyLines.get(key) || 1;

  const dataScopes = [];
  if (settingsData) {
    if (isPlainObject(settingsData.current)) {
      dataScopes.push({ scopeName: 'current', values: settingsData.current });
    }
    if (isPlainObject(settingsData.presets)) {
      for (const [presetName, presetObj] of Object.entries(settingsData.presets)) {
        if (isPlainObject(presetObj)) {
          dataScopes.push({ scopeName: `presets.${presetName}`, values: presetObj });
        }
      }
    }
  }

  const reportedOrphans = new Set();
  for (const { scopeName, values } of dataScopes) {
    for (const [k, val] of Object.entries(values)) {
      const dataLine = getDataKeyLine(k);
      if (typeof val === 'string') {
        checkResidue(val, `settings_data.json (${scopeName})`, {
          file: 'config/settings_data.json',
          line: dataLine,
          id: k,
        });
      }
      const setting = settingMap.get(k);
      if (!setting) {
        if (!reportedOrphans.has(k)) {
          reportedOrphans.add(k);
          warn('data-orphan-key', `settings_data.json key '${k}' (${scopeName}) does not exist in settings_schema.json`, {
            file: 'config/settings_data.json',
            line: dataLine,
            id: k,
          });
        }
        continue;
      }
      if ((setting.type === 'select' || setting.type === 'radio') && Array.isArray(setting.options)) {
        if (val !== undefined && val !== null) {
          const validValues = new Set(
            setting.options
              .filter((o) => isPlainObject(o) && o.value !== undefined)
              .map((o) => String(o.value)),
          );
          const valStr = String(val);
          if (!validValues.has(valStr)) {
            fail(
              'select-value-invalid',
              `settings_data.json (${scopeName}) key '${k}' has value '${valStr}' not in schema options[].value (${[...validValues].join(', ')})`,
              { file: 'config/settings_data.json', line: dataLine, id: k },
            );
          }
        }
      }
    }
  }

  const currentDataObj = settingsData && isPlainObject(settingsData.current) ? settingsData.current : {};
  for (const [id, setting] of settingMap.entries()) {
    const schemaLine = setting.line || 1;
    if (setting.type === 'image_picker') {
      const defVal = typeof setting.default === 'string' ? setting.default.trim() : '';
      const curVal = typeof currentDataObj[id] === 'string' ? currentDataObj[id].trim() : '';
      let hasValidDataUrl = false;
      if (defVal !== '') {
        if (F1GENZ_HSTATIC_HTTPS_RE.test(defVal)) {
          if (F1GENZ_THEME_SCOPED_URL_RE.test(defVal)) {
            warn(
              'image-picker-theme-scoped-url',
              `image_picker '${id}' default in settings_schema.json uses theme-scoped URL '${defVal}'`,
              { file: 'config/settings_schema.json', line: schemaLine, id },
            );
          }
        } else if (F1GENZ_OTHER_HTTPS_RE.test(defVal)) {
          fail(
            'image-picker-bare-default',
            `image_picker '${id}' default in settings_schema.json uses non-hstatic https host '${defVal}' — must be full https://...hstatic.net/... URL`,
            { file: 'config/settings_schema.json', line: schemaLine, id },
          );
        } else {
          fail(
            'image-picker-bare-default',
            `image_picker '${id}' default in settings_schema.json has invalid/bare value '${defVal}' — must be full https://...hstatic.net/... URL`,
            { file: 'config/settings_schema.json', line: schemaLine, id },
          );
        }
      }
      const seenThemeScopedData = new Set();
      for (const { scopeName, values } of dataScopes) {
        if (!(id in values)) continue;
        const rawVal = values[id];
        const val = typeof rawVal === 'string' ? rawVal.trim() : '';
        if (val === '') continue;
        const dataLine = getDataKeyLine(id);
        if (F1GENZ_HSTATIC_HTTPS_RE.test(val)) {
          hasValidDataUrl = true;
          if (F1GENZ_THEME_SCOPED_URL_RE.test(val) && !seenThemeScopedData.has(val)) {
            seenThemeScopedData.add(val);
            warn(
              'image-picker-theme-scoped-url',
              `image_picker '${id}' (${scopeName}) in settings_data.json uses theme-scoped URL '${val}'`,
              { file: 'config/settings_data.json', line: dataLine, id },
            );
          }
        } else if (F1GENZ_OTHER_HTTPS_RE.test(val)) {
          hasValidDataUrl = true;
          fail(
            'image-picker-bare-value',
            `image_picker '${id}' (${scopeName}) in settings_data.json uses non-hstatic https host '${val}' — must be full https://...hstatic.net/... URL`,
            { file: 'config/settings_data.json', line: dataLine, id },
          );
        } else {
          fail(
            'image-picker-bare-value',
            `image_picker '${id}' (${scopeName}) in settings_data.json has bare/invalid value '${val}'`,
            { file: 'config/settings_data.json', line: dataLine, id },
          );
        }
      }
      if (defVal === '' && hasValidDataUrl) {
        const sampleUrl = curVal || 'https://cdn.hstatic.net/...';
        fail(
          'image-picker-default-missing',
          `image_picker '${id}' has valid URL in settings_data.json but empty 'default' in settings_schema.json — copy '${sampleUrl}' into schema 'default'`,
          { file: 'config/settings_schema.json', line: schemaLine, id },
        );
      } else if (defVal === '' && curVal === '' && !hasValidDataUrl) {
        warn(
          'image-picker-empty',
          `image_picker '${id}' is empty in both settings_schema.json default and settings_data.json`,
          { file: 'config/settings_schema.json', line: schemaLine, id },
        );
      }
    }
    if (setting.type === 'text' && F1GENZ_SOCIAL_ID_RE.test(id)) {
      if (typeof setting.default === 'string' && isBareSocialDomainUrl(setting.default)) {
        warn(
          'social-bare-domain',
          `social setting '${id}' default in settings_schema.json is a bare domain placeholder '${setting.default.trim()}'`,
          { file: 'config/settings_schema.json', line: schemaLine, id },
        );
      }
      for (const { scopeName, values } of dataScopes) {
        if (typeof values[id] === 'string' && isBareSocialDomainUrl(values[id])) {
          const dataLine = getDataKeyLine(id);
          warn(
            'social-bare-domain',
            `social setting '${id}' (${scopeName}) in settings_data.json is a bare domain placeholder '${values[id].trim()}'`,
            { file: 'config/settings_data.json', line: dataLine, id },
          );
        }
      }
    }
  }

  const liquidFolders = ['layout', 'snippets', 'templates', 'assets', 'sections'];
  const liquidFiles = liquidFolders
    .flatMap((folder) => listSourceFiles(path.join(themeDir, folder), new Set(['.liquid'])))
    .map((file) => ({
      file,
      relFile: toPosixRelative(themeDir, file),
      text: readFileIfPresent(file) ?? '',
    }));

  const referencedIds = new Set();
  const dynamicReferencedIds = new Set();
  const annotatedFilesById = new Map();

  for (const { relFile, text } of liquidFiles) {
    const isStorefrontLiquid = /^(layout|templates|sections|snippets)\//.test(relFile);
    let cleanText = maskRangesPreserveNewlines(text, /\{%[-~]?\s*comment\s*[-~]?%\}[\s\S]*?\{%[-~]?\s*endcomment\s*[-~]?%\}/g);
    cleanText = maskRangesPreserveNewlines(cleanText, /\{%[-~]?\s*raw\s*[-~]?%\}[\s\S]*?\{%[-~]?\s*endraw\s*[-~]?%\}/g);
    // Whole tag bodies, not lines: an output or {% liquid %} block may span several lines.
    for (const tag of cleanText.matchAll(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g)) {
      for (const match of tag[0].matchAll(/settings\.([A-Za-z0-9_]+)|settings\[\s*['"]([A-Za-z0-9_-]+)['"]\s*\]/g)) {
        referencedIds.add(match[1] || match[2]);
      }
    }
    const varTemplates = resolveDynamicTemplatesInFile(cleanText);
    for (const m of cleanText.matchAll(/settings\[\s*([A-Za-z0-9_]+)\s*\]/g)) {
      const tpls = varTemplates.get(m[1]);
      if (!tpls) continue;
      for (const tpl of tpls) {
        const pattern = tpl
          .split('\0DYN\0')
          .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[A-Za-z0-9_]+');
        const family = new RegExp(`^${pattern}$`);
        for (const id of settingMap.keys()) {
          if (family.test(id)) dynamicReferencedIds.add(id);
        }
      }
    }

    cleanText = maskRangesPreserveNewlines(cleanText, /<!--[\s\S]*?-->/g);
    const settingsVars = new Map();
    for (const m of cleanText.matchAll(/\{%[-~]?\s*assign\s+([A-Za-z0-9_]+)\s*=\s*settings(?:\.([A-Za-z0-9_]+)|\[\s*(?:['"]([A-Za-z0-9_-]+)['"]|([A-Za-z0-9_]+))\s*\])\s*(?:\|[\s\S]*?)?[-~]?%\}/g)) {
      settingsVars.set(m[1], m[2] || m[3] || m[4]);
    }
    for (const m of cleanText.matchAll(/\{%[-~]?\s*capture\s+([A-Za-z0-9_]+)\s*[-~]?%\}\s*\{\{[-~]?\s*settings(?:\.([A-Za-z0-9_]+)|\[\s*(?:['"]([A-Za-z0-9_-]+)['"]|([A-Za-z0-9_]+))\s*\])[\s\S]*?\}\}\s*\{%[-~]?\s*endcapture\s*[-~]?%\}/g)) {
      settingsVars.set(m[1], m[2] || m[3] || m[4]);
    }

    if (isStorefrontLiquid) {
      for (const tagMatch of cleanText.matchAll(/(\{\{[-~]?([\s\S]*?)[-~]?}}|\{%[-~]?([\s\S]*?)[-~]?%\})/g)) {
        const inner = tagMatch[2] !== undefined ? tagMatch[2] : tagMatch[3];
        const tagOffset = tagMatch.index;
        if (inner.includes('default')) {
          for (const dm of inner.matchAll(/(?:^|[=,(\s])(settings\.[A-Za-z0-9_]+|settings\[\s*(?:['"][A-Za-z0-9_-]+['"]|[A-Za-z0-9_]+)\s*\]|[A-Za-z0-9_.[\]'"]+)((?:\s*\|\s*[A-Za-z0-9_]+(?:\s*:\s*(?:'[^']*'|"[^"]*"|[^|]+))?)*?)\s*\|\s*default\s*:\s*('([^']*)'|"([^"]*)"|([^\s|}]+))/g)) {
            const primary = dm[1].trim();
            let settingKey = null;
            const directMatch = primary.match(/^settings(?:\.([A-Za-z0-9_]+)|\[\s*(?:['"]([A-Za-z0-9_-]+)['"]|([A-Za-z0-9_]+))\s*\])$/);
            if (directMatch) {
              settingKey = directMatch[1] || directMatch[2] || directMatch[3];
            } else if (/^[A-Za-z0-9_]+$/.test(primary) && settingsVars.has(primary)) {
              settingKey = settingsVars.get(primary);
            }
            if (!settingKey) continue;
            const isQuoted = dm[3].startsWith("'") || dm[3].startsWith('"');
            const literalVal = dm[4] !== undefined ? dm[4] : (dm[5] !== undefined ? dm[5] : dm[6]);
            const line = lineOfIndex(cleanText, tagOffset + dm.index);
            if (isQuoted && literalVal.trim() === '') continue;
            const isTechnical = F1GENZ_TECHNICAL_LITERAL_RE.test(literalVal.trim());
            if (!isQuoted && !isTechnical) continue;
            const fallbackKind = isTechnical ? 'technical literal' : 'hardcoded literal';
            fail(
              'liquid-hardcoded-fallback',
              `${relFile}:${line} ${fallbackKind} fallback on setting '${settingKey}': ${primary} | default: ${dm[3]}`,
              { file: relFile, line, id: settingKey },
            );
          }
        }
        const innerNoStrings = inner.replace(/'[^']*'|\"[^\"]*\"/g, (s) => ' '.repeat(s.length));
        for (const hm of inner.matchAll(/(?<![.\w])(linklists|collections|blogs|pages)\[\s*(['"])([^'"]+)\2\s*\]/g)) {
          const obj = hm[1];
          const handle = hm[3];
          if (obj === 'collections' && handle === 'all') continue;
          const line = lineOfIndex(cleanText, tagOffset + hm.index);
          const expr = `${obj}['${handle}']`;
          fail(
            'liquid-hardcoded-handle',
            `${relFile}:${line} hardcoded ${obj} handle '${handle}' (${expr}); must read handle from a schema setting`,
            { file: relFile, line, id: expr },
          );
        }
        for (const dm of innerNoStrings.matchAll(/(?<![.\w])(linklists|collections|blogs|pages)\.([A-Za-z0-9_-]+)/g)) {
          const obj = dm[1];
          const prop = dm[2];
          if (['first', 'last', 'size', 'empty', 'blank'].includes(prop)) continue;
          if (obj === 'collections' && prop === 'all') continue;
          const line = lineOfIndex(cleanText, tagOffset + dm.index);
          const expr = `${obj}.${prop}`;
          fail(
            'liquid-hardcoded-handle',
            `${relFile}:${line} hardcoded ${obj} handle '${prop}' (${expr}); must read handle from a schema setting`,
            { file: relFile, line, id: expr },
          );
        }
      }
    }

    const guardRanges = [];
    const stack = [];
    const childBlockRanges = [];
    const tagRe = /\{%[-~]?\s*(if|unless|elsif|else|endif)\b([\s\S]*?)[-~]?%\}/g;
    let m;
    while ((m = tagRe.exec(cleanText)) !== null) {
      const kw = m[1];
      const cond = m[2] || '';
      const startIdx = m.index;
      const endIdx = tagRe.lastIndex;
      const tagLine = lineOfIndex(cleanText, startIdx);
      if (kw === 'if' || kw === 'unless') {
        stack.push({
          kind: kw,
          openStart: startIdx,
          openLine: tagLine,
          branches: [{ type: kw, cond, bodyStart: endIdx, bodyEnd: endIdx, tagLine }],
        });
      } else if (kw === 'elsif') {
        if (stack.length > 0) {
          const top = stack[stack.length - 1];
          top.branches[top.branches.length - 1].bodyEnd = startIdx;
          top.branches.push({ type: 'elsif', cond, bodyStart: endIdx, bodyEnd: endIdx, tagLine });
        }
      } else if (kw === 'else') {
        if (stack.length > 0) {
          const top = stack[stack.length - 1];
          top.branches[top.branches.length - 1].bodyEnd = startIdx;
          top.branches.push({ type: 'else', cond: '', bodyStart: endIdx, bodyEnd: endIdx, tagLine });
        }
      } else if (kw === 'endif') {
        if (stack.length > 0) {
          const top = stack.pop();
          top.branches[top.branches.length - 1].bodyEnd = startIdx;
          top.closeEnd = endIdx;
          for (const b of top.branches) {
            if (b.cond) guardRanges.push({ kw: b.type, cond: b.cond, start: b.bodyStart, end: b.bodyEnd });
          }
          if (isStorefrontLiquid) {
            const elseBranch = top.branches.find((b) => b.type === 'else');
            if (elseBranch) {
              let matchedSetting = null;
              for (const b of top.branches) {
                if (b.type === 'else') break;
                const sId = getContentSettingFromCondition(b.cond, b.type, settingsVars, varTemplates, settingMap);
                if (sId) {
                  matchedSetting = sId;
                  break;
                }
              }
              if (matchedSetting) {
                let bodySlice = cleanText.slice(elseBranch.bodyStart, elseBranch.bodyEnd);
                const baseOffset = elseBranch.bodyStart;
                const chars = bodySlice.split('');
                for (const cr of childBlockRanges) {
                  if (cr.start >= elseBranch.bodyStart && cr.end <= elseBranch.bodyEnd) {
                    for (let k = cr.start - baseOffset; k < cr.end - baseOffset; k += 1) {
                      if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
                    }
                  }
                }
                bodySlice = chars.join('');
                const noSvg = bodySlice.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
                const noLiquid = noSvg.replace(/\{\{[\s\S]*?\}\}/g, ' ').replace(/\{%[\s\S]*?%\}/g, ' ');
                let literalAttr = null;
                for (const tm of noLiquid.matchAll(/<[A-Za-z0-9_-]+([^>]*)>/g)) {
                  const hm = tm[1].match(/\b(href|src)\s*=\s*(['"])([\s\S]*?)\2/i);
                  if (hm && hm[3].trim() !== '') {
                    literalAttr = `${hm[1]}="${hm[3].trim()}"`;
                    break;
                  }
                }
                const textOnly = noLiquid.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
                const hasHardcodedText =
                  /[\p{L}\p{N}]/u.test(textOnly) ||
                  (textOnly === '#' && !/\{\{|\{%/.test(noSvg));
                if (hasHardcodedText || literalAttr) {
                  const snippetDesc = literalAttr || `"${textOnly.slice(0, 70)}"`;
                  fail(
                    'liquid-hardcoded-fallback',
                    `${relFile}:${elseBranch.tagLine} hardcoded {% else %} fallback for setting '${matchedSetting}': ${snippetDesc}`,
                    { file: relFile, line: elseBranch.tagLine, id: matchedSetting },
                  );
                }
              }
            }
          }
          childBlockRanges.push({ start: top.openStart, end: top.closeEnd });
        }
      }
    }

    for (const tagMatch of cleanText.matchAll(/<[^>]+>/gs)) {
      const tag = tagMatch[0];
      const idMatch = tag.match(/setting-id="([^"]+)"/);
      const typeMatch = tag.match(/setting-type="([^"]+)"/);
      if (!idMatch || !typeMatch) continue;
      const rawId = idMatch[1];
      const editorType = typeMatch[1];
      const tagLine = lineOfIndex(cleanText, tagMatch.index);
      let token = rawId;
      const isDynamicAttr = rawId.includes('{{') || rawId.includes('{%');
      if (isDynamicAttr) {
        const dynMatch = rawId.match(/^\{\{[-~]?\s*([A-Za-z0-9_]+)\s*[-~]?\}\}$/);
        if (dynMatch) token = dynMatch[1];
      } else {
        if (!annotatedFilesById.has(rawId)) {
          annotatedFilesById.set(rawId, { files: new Set(), firstFile: relFile, firstLine: tagLine });
        }
        annotatedFilesById.get(rawId).files.add(relFile);
      }
      if (isStorefrontLiquid && ['text', 'textarea', 'image'].includes(editorType)) {
        const aliasVars = [token];
        for (const [vName, sRef] of settingsVars.entries()) {
          if (sRef === token) aliasVars.push(vName);
        }
        const activeConds = guardRanges
          .filter((r) => tagMatch.index >= r.start && tagMatch.index <= r.end)
          .map((r) => r.cond);
        const isGuarded = activeConds.some(
          (c) =>
            aliasVars.some((tok) => c.includes(tok)) &&
            (/!=\s*(?:blank|nil|empty|''|"")/.test(c) || /==\s*(?:blank|nil|empty|''|"")/.test(c) || !/(?:==|!=)/.test(c)),
        );
        if (!isGuarded) {
          warn(
            'setting-id-unguarded',
            `${relFile}:${tagLine} element with setting-id="${rawId}" (setting-type="${editorType}") is not guarded by if ... != blank`,
            { file: relFile, line: tagLine, id: token },
          );
        }
      }
    }
  }

  for (const [id, infoObj] of annotatedFilesById.entries()) {
    if (infoObj.files.size >= 2) {
      warn(
        'duplicate-setting-id',
        `setting-id '${id}' is bound in ${infoObj.files.size} files: ${[...infoObj.files].join(', ')}`,
        { file: infoObj.firstFile, line: infoObj.firstLine, id },
      );
    }
  }

  for (const id of settingMap.keys()) {
    if (!referencedIds.has(id) && !dynamicReferencedIds.has(id) && !annotatedFilesById.has(id)) {
      const s = settingMap.get(id);
      fail('dead-setting', `schema setting has no resolved reference: ${id} ("${s.label}" in "${s.sectionName}")`, {
        file: 'config/settings_schema.json',
        line: s.line || 1,
        id,
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings, info, failures: errors };
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

/**
 * Ids declared by the theme, from both declaration sources Haravan accepts:
 * `config/settings_schema.json` (including nested block settings) and the legacy
 * `config/settings.html` merchant form, where each control's `name` is the id.
 * A schema-only reader calls every read in a legacy theme undeclared.
 */
function collectDeclaredSettingIds(themeDir) {
  const ids = new Set();
  const schemaSource = readFileIfPresent(path.join(themeDir, 'config', 'settings_schema.json'));
  if (schemaSource !== null) {
    const parsed = parseJsonDocument(schemaSource);
    if (parsed.ok) collectSettingIds(parsed.value, ids);
  }
  const formSource = readFileIfPresent(path.join(themeDir, 'config', 'settings.html'));
  if (formSource !== null) {
    // A shipped settings.html can be inert: real themes comment the whole form
    // out, so names inside an HTML comment declare nothing.
    for (const name of listFormSettingNames(formSource)) ids.add(name);
  }
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
  const aliases = [`${name}.liquid`, `${name}.bwt`];
  const stem = name.replace(/\.[^./\\]+$/, '');
  if (stem !== name) aliases.push(`${stem}.liquid`, `${stem}.bwt`);
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
