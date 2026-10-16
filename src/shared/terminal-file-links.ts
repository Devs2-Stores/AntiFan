/**
 * Terminal file-path linkification: finds the file paths in one terminal line
 * that the standalone renderer turns into Quick-Look links. Environment-free so
 * the compiled module ships to standalone.js as a classic-script global and the
 * tests exercise the exact matcher the renderer runs.
 *
 * Absolute paths may contain directory names with spaces (`E:/Work/S2 Sky
 * Fashion/a.md`, `E:/Work/1. Intro/a.md`): a space-separated directory segment is
 * accepted only when its words carry no shell metacharacter and no `.` except one
 * ending a word, so a file name followed by prose (`a.ts was saved`) or a command
 * chain (`dir && node x.js`) does not swallow the text after it. The file-name
 * segment itself never contains a space. Plain words before a later `/` still read
 * as a spaced directory (`Moved E:/Work/a to b/c.md` links the whole run): Quick
 * Look then reports a missing file, which is the cost of linking real spaced paths.
 */

export interface TerminalFileLink {
  /** 0-based start column of the path within the line. */
  start: number;
  /** 0-based exclusive end column. */
  end: number;
  /** Path text as printed, including an optional `:line[:col]` suffix. */
  text: string;
}

const VALID_FILE_EXTENSIONS: Record<string, true> = {
  ts: true, tsx: true, js: true, jsx: true, cjs: true, mjs: true,
  json: true, json5: true, jsonc: true,
  css: true, scss: true, sass: true, less: true,
  html: true, htm: true, liquid: true, bwt: true,
  md: true, markdown: true, txt: true, rtf: true,
  yaml: true, yml: true, toml: true, ini: true, conf: true, config: true,
  svg: true, png: true, jpg: true, jpeg: true, webp: true, gif: true, ico: true, avif: true, bmp: true,
  sh: true, bash: true, zsh: true, ps1: true, bat: true, cmd: true,
  py: true, rs: true, go: true, c: true, cpp: true, h: true, hpp: true, cs: true, java: true, kt: true, swift: true, rb: true, php: true,
  lock: true, log: true, sql: true, csv: true, tsv: true, xml: true, vue: true, svelte: true, astro: true,
  graphql: true, gql: true, proto: true, env: true,
};

const DISALLOWED_EXTENSIONS: Record<string, true> = {
  list: true, get: true, set: true, create: true, update: true, delete: true, close: true, activate: true,
  reload: true, navigate: true, evaluate: true, stat: true, read: true, write: true, drop: true, drag: true,
  hover: true, click: true, scroll: true, type: true, clear: true, freeze: true, capture: true, compare: true,
  dump_dom: true, styles: true, snapshot: true, validate_gate: true, verify_claim: true, record_claim: true,
  style_override: true, export_clean: true, resolve_element: true, tabs: true,
};

// Characters that end any path token.
const STOP = String.raw`\s:;,"'<>()[\]` + '`' + String.raw`\x1b`;
// A path token without spaces; may span several `/`-separated segments.
const TOKEN = `[^${STOP}]+`;
// One directory segment of an absolute path: a plain segment, or space-separated
// words free of shell metacharacters whose only dot may end the word (`1. Intro`).
const SPACED_WORD = String.raw`[^${STOP}.\\/&|$=*?!#]+\.?`;
const DIR_SEGMENT = String.raw`(?:${SPACED_WORD}(?: ${SPACED_WORD})+|[^${STOP}\\/]+)[\\/]`;

const FILE_PATH_RE = new RegExp(
  String.raw`(?:^|[\s"'` + '`' + String.raw`(\[<])(` +
    '(?:' +
      String.raw`[a-zA-Z]:[\\/](?:${DIR_SEGMENT})*${TOKEN}` +
      String.raw`|(?:\.{1,2}[\\/]|[a-zA-Z0-9_\-.]+[\\/])${TOKEN}\.[a-zA-Z0-9_\-]+` +
      String.raw`|\/(?:home|Users|usr|var|tmp|etc|work|Work)[\\/](?:${DIR_SEGMENT})*${TOKEN}` +
      String.raw`|[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*\.[a-zA-Z0-9_\-]+` +
    ')' +
    String.raw`(?::\d+(?::\d+)?)?)`,
  'g',
);

/** True when a matched token names a real file type, not an MCP tool or RPC method. */
export function isValidTerminalFilePath(candidate: string): boolean {
  if (!candidate || typeof candidate !== 'string') return false;
  let p = candidate.trim().replace(/^["'`]/, '').replace(/["'`]$/, '');
  p = p.replace(/[,.;)]+$/, '');

  // `theme.*` MCP tool names are not guarded by prefix: none ends in an allowed file
  // extension, and a prefix guard would also reject `layout/theme.liquid`.
  if (
    p.startsWith('anti.') ||
    p.includes('/anti.') ||
    p.includes('\\anti.') ||
    p.startsWith('browser.') ||
    p.includes('/browser.') ||
    p.includes('\\browser.') ||
    p.includes('mcp__') ||
    p.startsWith('xd://') ||
    p.includes('antifan-browser/') ||
    p.includes('antifan-browser\\') ||
    p.startsWith('console.') ||
    p.startsWith('process.') ||
    p.startsWith('window.') ||
    p.startsWith('document.')
  ) {
    return false;
  }
  const lineColIdx = p.search(/:\d+(?::\d+)?$/);
  if (lineColIdx !== -1) p = p.slice(0, lineColIdx);

  const lastDot = p.lastIndexOf('.');
  if (lastDot === -1) return false;
  const ext = p.slice(lastDot + 1).toLowerCase();
  if (DISALLOWED_EXTENSIONS[ext]) return false;
  return VALID_FILE_EXTENSIONS[ext] === true;
}

/** Every linkable file path in one terminal line, left to right. */
export function findTerminalFileLinks(line: string): TerminalFileLink[] {
  const links: TerminalFileLink[] = [];
  FILE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_RE.exec(line)) !== null) {
    const pathText = match[1];
    if (pathText === undefined || !isValidTerminalFilePath(pathText)) continue;
    // The path group always ends the match; its prefix is at most one delimiter char.
    const start = match.index + match[0].length - pathText.length;
    links.push({ start, end: start + pathText.length, text: pathText });
  }
  return links;
}

/** One terminal cell, as xterm's IBufferCell exposes it. */
export interface TerminalCellLike {
  getChars(): string;
  getWidth(): number;
}

/** One buffer row, as xterm's IBufferLine exposes it. */
export interface TerminalLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): TerminalCellLike | undefined;
}

export interface TerminalBufferLike {
  getLine(y: number): TerminalLineLike | undefined;
}

/** A link in buffer coordinates, as xterm's link provider takes it: 1-based, end inclusive. */
export interface TerminalFileLinkRange {
  text: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/** Rows one logical line may span before the reader stops (a runaway wrap chain). */
const MAX_WRAPPED_ROWS = 64;

/**
 * File links touching buffer row `bufferLineNumber` (1-based, as xterm's provideLinks passes it),
 * in cell coordinates. The row is read together with the rows it wraps from and into, so a path the
 * terminal broke across rows stays one link, and every string index is mapped to the cell it was
 * printed in: a wide glyph (CJK, emoji) takes two cells but one index, so string offsets alone put
 * every link after it in the wrong columns.
 */
export function findTerminalFileLinkRanges(buffer: TerminalBufferLike, bufferLineNumber: number): TerminalFileLinkRange[] {
  const row = bufferLineNumber - 1;
  let first = row;
  while (first > 0 && row - first < MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped) first -= 1;
  let text = '';
  const cells: Array<{ x: number; y: number; width: number }> = [];
  for (let y = first; y - first < MAX_WRAPPED_ROWS; y += 1) {
    const line = buffer.getLine(y);
    if (!line || (y > first && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      const width = cell ? cell.getWidth() : 1;
      if (width === 0) continue; // the right half of a wide glyph
      const chars = (cell && cell.getChars()) || ' ';
      for (let k = 0; k < chars.length; k += 1) cells.push({ x: x + 1, y: y + 1, width });
      text += chars;
    }
  }
  const ranges: TerminalFileLinkRange[] = [];
  for (const link of findTerminalFileLinks(text)) {
    const startCell = cells[link.start];
    const endCell = cells[link.end - 1];
    if (!startCell || !endCell || endCell.y < bufferLineNumber || startCell.y > bufferLineNumber) continue;
    ranges.push({
      text: link.text,
      start: { x: startCell.x, y: startCell.y },
      end: { x: endCell.x + endCell.width - 1, y: endCell.y },
    });
  }
  return ranges;
}
