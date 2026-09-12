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
 *   HARAVAN_SETTINGS_DECLARATIONS_ABSENT
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

/** Parseable Liquid source: sections, templates, layout and snippets alike. */
const SOURCE_EXTENSIONS = new Set(['.liquid', '.html']);

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
const SETTINGS_READ_PATTERN = /(?<![\w.$])settings\.([A-Za-z_][A-Za-z0-9_]*(?:-+[A-Za-z0-9_]+)*)/g;

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
  }

  // Collect all known/declared settings keys
  const knownSettings = new Set();
  if (fs.existsSync(settingsDataPath)) {
    const dataParsed = parseJsonDocument(readFileIfPresent(settingsDataPath) ?? '{}');
    if (dataParsed.ok && isPlainObject(dataParsed.value)) {
      const root = dataParsed.value;
      if (isPlainObject(root.current)) {
        for (const k of Object.keys(root.current)) knownSettings.add(k);
      }
      for (const k of Object.keys(root)) {
        if (k !== 'current' && k !== 'presets') knownSettings.add(k);
      }
    }
  }
  // Declared ids come from both sources (`collectDeclaredSettingIds` unions the
  // schema with the live control names in config/settings.html).
  for (const k of collectDeclaredSettingIds(themeDir)) knownSettings.add(k);

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

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const lineNum = lineIndex + 1;
        const lineText = lines[lineIndex];

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

        // Check unresolved settings (dot and bracket spellings alike)
        const settingsMatches = matchSettingReadIds(lineText);
        for (const settingId of settingsMatches) {
          if (knownSettings.size > 0 && !knownSettings.has(settingId)) {
            failures.push({
              rule: 'HARAVAN_SETTING_UNRESOLVED',
              file: relativePath,
              line: lineNum,
              message: `setting 'settings.${settingId}' is read but unresolved in config/settings_data.json`,
              detail: `Unresolved setting id '${settingId}' (${relativePath}:${lineNum})`,
            });
          }
        }
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

  return { ok: failures.length === 0, failures };
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
      for (const id of matchSettingReadIds(stripped)) {
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
      detail: `settings.${id} is read in ${files.join(', ')} but is declared in neither ${SETTINGS_SCHEMA_RELATIVE_PATH} nor the control names of ${SETTINGS_FORM_RELATIVE_PATH}`,
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
