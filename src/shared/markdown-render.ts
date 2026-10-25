/**
 * Markdown -> HTML for the terminal file viewer (`standalone.js` ships this file as a classic
 * script through `scripts/lib/generated-renderer-assets.cjs`).
 *
 * Dependency-free on purpose: it runs in the renderer, which has no bundler. Every character of
 * the source is HTML-escaped; the only markup in the output is what this module emits, so a
 * Markdown file cannot inject elements, attributes or scripts. Raw HTML in the source is shown as
 * text, and an HTML comment block is dropped. Link and image targets pass `sanitizeMarkdownUrl`
 * (http, https, mailto, file:///, drive paths, relative paths; never `javascript:` or a UNC share).
 *
 * Covered: ATX/setext headings, paragraphs with hard breaks, fenced and indented code, block
 * quotes, nested ordered/unordered/task lists, GFM tables with alignment, rules, inline code,
 * strong/emphasis/strikethrough, links, images, reference links, autolinks and bare URLs.
 * Not covered: footnotes, math, raw HTML.
 */

export interface MarkdownRenderOptions {
  /** Final `src` for an image whose target already passed the URL filter; null drops the image. */
  resolveImage?: (href: string) => string | null;
  /** Highlighted HTML for a fenced block, or null to show it as plain escaped text. */
  highlight?: (code: string, lang: string) => string | null;
}

/** Block quotes and lists nest by recursion; past this depth the rest is shown as text. */
const MAX_DEPTH = 24;

/** Tables with more columns than this scroll sideways rather than squeezing into the viewer. */
const WIDE_TABLE_COLUMNS = 8;

/** Tables with more body rows than this use a fixed column layout (see renderTable). */
const BIG_TABLE_ROWS = 400;

const ENTITY_TAIL = '(?:#\\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});';
const BARE_AMPERSAND = new RegExp(`&(?!${ENTITY_TAIL})`, 'g');

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Like `escapeHtml`, but a well-formed entity (`&nbsp;`, `&#169;`) in prose keeps its meaning. */
function escapeText(text: string): string {
  return text.replace(BARE_AMPERSAND, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CONTROL_CHARS = /[\u0000-\u0020\u007f-\u009f]/g;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i;

/** The target when it is safe to put in an `href`/`src`, otherwise null. */
export function sanitizeMarkdownUrl(raw: string, kind: 'link' | 'image' = 'link'): string | null {
  const url = raw.trim();
  if (!url) return null;
  // Control characters and spaces inside a scheme (`java\tscript:`) are ignored by browsers.
  const probe = url.replace(CONTROL_CHARS, '');
  // Browsers normalise `/\`, `\/` and `\\` alike, so any two leading slashes of either kind is a network path.
  if (/^[\\/]{2}/.test(probe)) return null;
  if (kind === 'image' && DATA_IMAGE.test(probe)) return url;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(probe);
  if (!scheme) return url;
  const name = scheme[1]!.toLowerCase();
  if (name.length === 1) return url; // `E:/folder/file.png`
  if (name === 'http' || name === 'https') return url;
  if (name === 'mailto' && kind === 'link') return url;
  // `file:///X:/dir` and `file:///dir`; a fourth slash (`file:////host/share`) is a UNC share to Windows.
  if (name === 'file' && /^file:\/\/\/(?![\\/])/i.test(probe)) return url;
  return null;
}

/**
 * Absolute path a link or image target points at, resolved against the Markdown file's own
 * location (forward slashes). Null when the target is not a local path.
 */
export function resolveMarkdownPath(baseFilePath: string, href: string): string | null {
  let target = href.trim();
  if (!target || target.startsWith('#')) return null;
  if (/^file:\/\/\//i.test(target)) {
    target = target.slice(8);
    if (/^\/[A-Za-z]:/.test(target)) target = target.slice(1);
  } else if (/^[A-Za-z][A-Za-z0-9+.-]{1,}:/.test(target)) {
    return null; // http:, mailto:, data: ...
  }
  target = target.replace(/[?#].*$/, '');
  try {
    target = decodeURIComponent(target);
  } catch {
    // keep the text as written
  }
  target = target.replace(/\\/g, '/');
  if (!target) return null;

  const base = baseFilePath.replace(/\\/g, '/');
  const drive = /^([A-Za-z]:)(?:\/|$)/.exec(base)?.[1] ?? '';
  let full: string;
  if (/^[A-Za-z]:\//.test(target)) {
    full = target;
  } else if (target.startsWith('/')) {
    full = drive ? `${drive}${target}` : target;
  } else {
    const slash = base.lastIndexOf('/');
    full = `${slash >= 0 ? base.slice(0, slash) : ''}/${target}`;
  }

  const root = /^[A-Za-z]:/.test(full) ? full.slice(0, 2) : '';
  const rest = root ? full.slice(2) : full;
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${root}/${parts.join('/')}`;
}

/** `file:///` URL for a local link or image target, or the URL itself for http(s)/data. */
export function markdownAssetUrl(baseFilePath: string, href: string): string | null {
  const url = href.trim();
  if (/^(?:https?:|data:)/i.test(url)) return url;
  const resolved = resolveMarkdownPath(baseFilePath, url);
  if (!resolved) return null;
  const encoded = encodeURI(resolved).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return /^[A-Za-z]:/.test(resolved) ? `file:///${encoded}` : `file://${encoded}`;
}

// ---------------------------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------------------------

interface LinkDefinition {
  href: string;
  title: string;
}

interface InlineContext {
  options: MarkdownRenderOptions;
  definitions: Map<string, LinkDefinition>;
}

const TOKEN_OPEN = '\u0001';
const TOKEN_CLOSE = '\u0002';
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Text of a link label with the markup stripped, for an image's `alt`. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/[*_~`]/g, '');
}

/** Index of the `]` that closes the `[` at `open`, or -1. Skips escapes and code spans. */
function findClosingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const end = text.indexOf(fence, i + run);
      if (end >= 0) i = end + run - 1;
      else i += run - 1;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface ParsedDestination {
  href: string;
  title: string;
  end: number;
}

/** Parses `(dest "title")` starting at the `(` at `start`. */
function parseInlineDestination(text: string, start: number): ParsedDestination | null {
  let i = start + 1;
  const skipSpace = (): void => {
    while (i < text.length && /[ \t\n]/.test(text[i]!)) i++;
  };
  skipSpace();
  let href = '';
  if (text[i] === '<') {
    const close = text.indexOf('>', i + 1);
    if (close < 0 || text.slice(i + 1, close).includes('\n')) return null;
    href = text.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    const from = i;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '\\' && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '(') depth++;
      if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    href = text.slice(from, i).replace(/\\([!-/:-@[-`{-~])/g, '$1');
  }
  skipSpace();
  let title = '';
  const quote = text[i];
  if (quote === '"' || quote === "'" || quote === '(') {
    const closer = quote === '(' ? ')' : quote;
    let j = i + 1;
    while (j < text.length && text[j] !== closer) {
      if (text[j] === '\\') j++;
      j++;
    }
    if (j >= text.length) return null;
    title = text.slice(i + 1, j).replace(/\\([!-/:-@[-`{-~])/g, '$1');
    i = j + 1;
    skipSpace();
  }
  if (text[i] !== ')') return null;
  return { href, title, end: i + 1 };
}

function renderLink(href: string, title: string, innerHtml: string): string {
  const safe = sanitizeMarkdownUrl(href, 'link');
  if (!safe) return innerHtml;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a class="md-link" href="${escapeHtml(safe)}" data-md-href="${escapeHtml(safe)}"${titleAttr}>${innerHtml}</a>`;
}

function renderImage(href: string, title: string, alt: string, context: InlineContext): string {
  const safe = sanitizeMarkdownUrl(href, 'image');
  const resolve = context.options.resolveImage;
  const src = safe ? (resolve ? resolve(safe) : safe) : null;
  const altText = escapeHtml(alt);
  if (!src) return `<span class="md-img-missing">${altText || 'image'}</span>`;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<img class="md-img" src="${escapeHtml(src)}" alt="${altText}"${titleAttr} data-md-alt="${altText}" loading="lazy">`;
}

function trimUrlTail(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (last !== undefined && /[.,;:!?*_~'"]/.test(last)) {
      out = out.slice(0, -1);
    } else if (last === ')' && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
      out = out.slice(0, -1);
    } else {
      return out;
    }
  }
}

function renderInline(source: string, context: InlineContext): string {
  const text = source.replace(/[\u0001\u0002]/g, '');
  const tokens: string[] = [];
  const put = (html: string): string => {
    tokens.push(html);
    return `${TOKEN_OPEN}${tokens.length - 1}${TOKEN_CLOSE}`;
  };

  let out = '';
  let plain = '';
  const flush = (): void => {
    if (plain) {
      out += escapeText(plain);
      plain = '';
    }
  };
  const emit = (html: string): void => {
    flush();
    out += put(html);
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '\n') {
        emit('<br>');
        i += 2;
      } else if (next !== undefined && ASCII_PUNCTUATION.test(next)) {
        emit(escapeHtml(next));
        i += 2;
      } else {
        plain += ch;
        i++;
      }
      continue;
    }

    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      let end = -1;
      for (let j = i + run; j < text.length; ) {
        if (text[j] !== '`') {
          j++;
          continue;
        }
        let length = 1;
        while (text[j + length] === '`') length++;
        if (length === run) {
          end = j;
          break;
        }
        j += length;
      }
      if (end < 0) {
        plain += fence;
        i += run;
        continue;
      }
      let code = text.slice(i + run, end).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      emit(`<code class="md-inline-code">${escapeHtml(code)}</code>`);
      i = end + run;
      continue;
    }

    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const isImage = ch === '!';
      const open = isImage ? i + 1 : i;
      const close = findClosingBracket(text, open);
      if (close > open) {
        const label = text.slice(open + 1, close);
        let href = '';
        let title = '';
        let end = -1;
        if (text[close + 1] === '(') {
          const parsed = parseInlineDestination(text, close + 1);
          if (parsed) {
            href = parsed.href;
            title = parsed.title;
            end = parsed.end;
          }
        } else if (text[close + 1] === '[') {
          const refClose = text.indexOf(']', close + 2);
          if (refClose > close) {
            const refLabel = text.slice(close + 2, refClose) || label;
            const definition = context.definitions.get(normalizeLabel(refLabel));
            if (definition) {
              href = definition.href;
              title = definition.title;
              end = refClose + 1;
            }
          }
        }
        if (end < 0) {
          const definition = context.definitions.get(normalizeLabel(label));
          if (definition && label.trim()) {
            href = definition.href;
            title = definition.title;
            end = close + 1;
          }
        }
        if (end > 0) {
          emit(isImage
            ? renderImage(href, title, plainText(label), context)
            : renderLink(href, title, renderInline(label, context)));
          i = end;
          continue;
        }
      }
      plain += isImage ? '![' : '[';
      i += isImage ? 2 : 1;
      continue;
    }

    if (ch === '<') {
      const autolink = /^<((?:https?|mailto):[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/i.exec(text.slice(i, i + 2048));
      if (autolink) {
        const target = autolink[1]!;
        const href = /^[a-z]+:/i.test(target) ? target : `mailto:${target}`;
        emit(renderLink(href, '', escapeHtml(target)));
        i += autolink[0].length;
        continue;
      }
      plain += ch;
      i++;
      continue;
    }

    if ((ch === 'h' || ch === 'H') && (i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]!))) {
      const bare = /^https?:\/\/[^\s<>]+/i.exec(text.slice(i, i + 2048));
      if (bare) {
        const url = trimUrlTail(bare[0]);
        if (url.length > 8) {
          emit(renderLink(url, '', escapeHtml(url)));
          i += url.length;
          continue;
        }
      }
    }

    plain += ch;
    i++;
  }
  flush();

  out = out
    .replace(/ {2,}\n/g, () => put('<br>'))
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![A-Za-z0-9_])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(?<![*A-Za-z0-9])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<![A-Za-z0-9_])_(?=[^\s_])([^_]*?[^\s_])_(?![A-Za-z0-9_])/g, '<em>$1</em>');

  // Tokens hold finished HTML (nested spans were restored by their own call), so one pass is enough.
  return out.replace(new RegExp(`${TOKEN_OPEN}(\\d+)${TOKEN_CLOSE}`, 'g'), (_match, index: string) => tokens[Number(index)] ?? '');
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

interface BlockContext extends InlineContext {
  depth: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const BLOCKQUOTE = /^ {0,3}>/;
const LIST_MARKER = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const DEFINITION = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === '';
}

function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (ch === '\\' && row[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function startsTable(lines: string[], index: number): boolean {
  const header = lines[index];
  const delimiter = lines[index + 1];
  if (header === undefined || delimiter === undefined) return false;
  if (!header.includes('|') || !TABLE_DELIMITER.test(delimiter) || !delimiter.includes('-')) return false;
  if (!delimiter.includes('|') && !header.trim().startsWith('|')) return false;
  return splitTableRow(header).length === splitTableRow(delimiter).length;
}

function listMarkerKind(marker: string): string {
  return /\d/.test(marker) ? `ol${marker[marker.length - 1]}` : `ul${marker}`;
}

/** True when `line` begins a block that ends a running paragraph. */
function interruptsParagraph(lines: string[], index: number): boolean {
  const line = lines[index]!;
  if (FENCE.test(line) || BLOCKQUOTE.test(line) || THEMATIC_BREAK.test(line)) return true;
  if (ATX_HEADING.test(line)) return true;
  const list = LIST_MARKER.exec(line);
  if (list) {
    const ordered = /\d/.test(list[2]!);
    const empty = line.slice(list[0].length).trim() === '';
    if (!empty && (!ordered || parseInt(list[2]!, 10) === 1)) return true;
  }
  return startsTable(lines, index);
}

function renderBlocks(lines: string[], context: BlockContext, tight = false): string {
  if (context.depth > MAX_DEPTH) {
    return `<p>${renderInline(lines.join('\n'), context)}</p>`;
  }
  const html: string[] = [];
  const slugCounts = context.depth === 0 ? new Map<string, number>() : null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    // HTML comment block: invisible in rendered Markdown.
    if (line.trim().startsWith('<!--')) {
      while (i < lines.length && !lines[i]!.includes('-->')) i++;
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i++;
      const closer = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
      while (i < lines.length && !closer.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // closing fence (or the end of input)
      const code = body.join('\n');
      const highlighted = context.options.highlight?.(code, lang.toLowerCase()) ?? null;
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
      html.push(`<pre class="md-code"${langAttr}><code>${highlighted ?? escapeHtml(code)}</code></pre>`);
      continue;
    }

    const heading = ATX_HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const raw = heading[2] ?? '';
      html.push(renderHeading(level, raw, context, slugCounts));
      i++;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }

    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]!) >= 4)) {
        body.push(isBlank(lines[i]) ? '' : lines[i]!.slice(4));
        i++;
      }
      while (body.length && body[body.length - 1] === '') body.pop();
      html.push(`<pre class="md-code"><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && BLOCKQUOTE.test(lines[i]!)) {
        inner.push(lines[i]!.replace(/^ {0,3}> ?/, ''));
        i++;
      }
      html.push(`<blockquote>${renderBlocks(inner, { ...context, depth: context.depth + 1 })}</blockquote>`);
      continue;
    }

    if (startsTable(lines, i)) {
      const next = renderTable(lines, i, context);
      html.push(next.html);
      i = next.end;
      continue;
    }

    const list = LIST_MARKER.exec(line);
    if (list) {
      const next = renderList(lines, i, context);
      html.push(next.html);
      i = next.end;
      continue;
    }

    const definition = DEFINITION.exec(line);
    if (definition) {
      i++;
      continue;
    }

    // Paragraph (or a setext heading when an underline follows).
    const paragraph: string[] = [line];
    i++;
    let setext = 0;
    while (i < lines.length && !isBlank(lines[i])) {
      const underline = SETEXT_UNDERLINE.exec(lines[i]!);
      if (underline) {
        setext = underline[1]!.startsWith('=') ? 1 : 2;
        i++;
        break;
      }
      if (interruptsParagraph(lines, i)) break;
      paragraph.push(lines[i]!);
      i++;
    }
    const joined = paragraph.map((row) => row.replace(/^[ \t]+/, '')).join('\n');
    if (setext) {
      html.push(renderHeading(setext, joined.replace(/\n/g, ' '), context, slugCounts));
    } else if (tight) {
      html.push(renderInline(joined, context));
    } else {
      html.push(`<p>${renderInline(joined, context)}</p>`);
    }
  }
  return html.join('\n');
}

function renderHeading(level: number, raw: string, context: BlockContext, slugCounts: Map<string, number> | null): string {
  let anchor = '';
  const base = slugify(plainText(raw));
  if (base) {
    const counts = slugCounts ?? new Map<string, number>();
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchor = ` data-md-id="${escapeHtml(seen ? `${base}-${seen}` : base)}"`;
  }
  return `<h${level}${anchor}>${renderInline(raw.trim(), context)}</h${level}>`;
}

function renderTable(lines: string[], start: number, context: BlockContext): { html: string; end: number } {
  const header = splitTableRow(lines[start]!);
  const alignments = splitTableRow(lines[start + 1]!).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  });
  const cell = (tag: 'th' | 'td', text: string, column: number): string => {
    const align = alignments[column];
    const style = align ? ` style="text-align:${align}"` : '';
    return `<${tag}${style}>${renderInline(text, context)}</${tag}>`;
  };
  const head = `<thead><tr>${header.map((text, column) => cell('th', text, column)).join('')}</tr></thead>`;
  const rows: string[] = [];
  let i = start + 2;
  while (i < lines.length && !isBlank(lines[i]) && lines[i]!.includes('|')) {
    if (FENCE.test(lines[i]!) || BLOCKQUOTE.test(lines[i]!)) break;
    const cells = splitTableRow(lines[i]!);
    const padded = header.map((_unused, column) => cells[column] ?? '');
    rows.push(`<tr>${padded.map((text, column) => cell('td', text, column)).join('')}</tr>`);
    i++;
  }
  const body = rows.length ? `<tbody>${rows.join('')}</tbody>` : '';
  // Past this many columns the browser would squeeze every column to its longest word and wrap the
  // rest character by character; such a table keeps natural column widths and scrolls sideways.
  const classes = ['md-table-wrap'];
  if (header.length > WIDE_TABLE_COLUMNS) classes.push('md-table-wide');
  // Automatic layout measures every cell of every row (about 1.4 s for 4000 rows in a narrow viewer);
  // a fixed layout sizes the columns from the first row only.
  const big = rows.length > BIG_TABLE_ROWS;
  if (big) classes.push('md-table-big');
  const tableStyle = big ? ` style="--md-cols:${header.length}"` : '';
  return { html: `<div class="${classes.join(' ')}"><table${tableStyle}>${head}${body}</table></div>`, end: i };
}

interface ListItem {
  lines: string[];
  task: 'open' | 'done' | null;
}

function renderList(lines: string[], start: number, context: BlockContext): { html: string; end: number } {
  const first = LIST_MARKER.exec(lines[start]!)!;
  const kind = listMarkerKind(first[2]!);
  const ordered = /\d/.test(first[2]!);
  const startNumber = ordered ? parseInt(first[2]!, 10) : 1;
  const items: ListItem[] = [];
  let loose = false;
  let i = start;

  while (i < lines.length) {
    const marker = LIST_MARKER.exec(lines[i]!);
    if (!marker || listMarkerKind(marker[2]!) !== kind || THEMATIC_BREAK.test(lines[i]!)) break;

    const leading = marker[1]!.length;
    const spaces = marker[3]!.length;
    const markerWidth = marker[2]!.length;
    const restOfLine = lines[i]!.slice(marker[0].length);
    const contentIndent = leading + markerWidth + (spaces === 0 || spaces > 4 ? 1 : spaces);
    const body: string[] = [spaces > 4 ? ' '.repeat(spaces - 1) + restOfLine : restOfLine];
    i++;

    while (i < lines.length) {
      const current = lines[i]!;
      if (isBlank(current)) {
        // A blank line continues the item only when an indented line follows it.
        let ahead = i + 1;
        while (ahead < lines.length && isBlank(lines[ahead])) ahead++;
        if (ahead < lines.length && indentOf(lines[ahead]!) >= contentIndent) {
          for (let k = i; k < ahead; k++) body.push('');
          i = ahead;
          continue;
        }
        break;
      }
      if (indentOf(current) >= contentIndent) {
        body.push(current.slice(contentIndent));
        i++;
        continue;
      }
      // Lazy continuation of the item's running paragraph.
      const previous = body[body.length - 1];
      if (!isBlank(previous) && !LIST_MARKER.test(current) && !interruptsParagraph(lines, i)) {
        body.push(current.replace(/^[ \t]+/, ''));
        i++;
        continue;
      }
      break;
    }

    while (body.length && isBlank(body[body.length - 1])) body.pop();
    let task: ListItem['task'] = null;
    const taskMatch = /^\[([ xX])\][ \t]+/.exec(body[0] ?? '');
    if (taskMatch) {
      task = taskMatch[1] === ' ' ? 'open' : 'done';
      body[0] = body[0]!.slice(taskMatch[0].length);
    }
    items.push({ lines: body, task });

    // A blank line between two items makes the list loose.
    let ahead = i;
    while (ahead < lines.length && isBlank(lines[ahead])) ahead++;
    const nextMarker = ahead < lines.length ? LIST_MARKER.exec(lines[ahead]!) : null;
    if (nextMarker && listMarkerKind(nextMarker[2]!) === kind && !THEMATIC_BREAK.test(lines[ahead]!)) {
      if (ahead > i) loose = true;
      i = ahead;
    } else {
      break;
    }
  }

  const hasTask = items.some((item) => item.task);
  const rendered = items.map((item) => {
    const checkbox = item.task
      ? `<input type="checkbox" class="md-task" disabled${item.task === 'done' ? ' checked' : ''}> `
      : '';
    const inner = renderBlocks(item.lines, { ...context, depth: context.depth + 1 }, !loose);
    return `<li${item.task ? ' class="md-task-item"' : ''}>${checkbox}${inner}</li>`;
  });
  const classes = hasTask ? ' class="md-task-list"' : '';
  const html = ordered
    ? `<ol${classes}${startNumber !== 1 ? ` start="${startNumber}"` : ''}>${rendered.join('')}</ol>`
    : `<ul${classes}>${rendered.join('')}</ul>`;
  return { html, end: i };
}

/** Link reference definitions (`[id]: url "title"`), collected outside fenced code. */
function collectDefinitions(lines: string[]): Map<string, LinkDefinition> {
  const definitions = new Map<string, LinkDefinition>();
  let fence: string | null = null;
  for (const line of lines) {
    const open = FENCE.exec(line);
    if (fence) {
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && line.replace(/^ {0,3}[`~]+/, '').trim() === '') fence = null;
      continue;
    }
    if (open) {
      fence = open[1]!;
      continue;
    }
    const match = DEFINITION.exec(line);
    if (match) {
      const key = normalizeLabel(match[1]!);
      if (!definitions.has(key)) {
        definitions.set(key, { href: match[2]!, title: match[3] ?? match[4] ?? match[5] ?? '' });
      }
    }
  }
  return definitions;
}

/** Renders Markdown source to an HTML fragment. Output is safe to assign to `innerHTML`. */
export function renderMarkdown(source: string, options: MarkdownRenderOptions = {}): string {
  const lines = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^( *)\t/, (_match, spaces: string) => `${spaces}    `));
  const definitions = collectDefinitions(lines);
  return renderBlocks(lines, { options, definitions, depth: 0 });
}
