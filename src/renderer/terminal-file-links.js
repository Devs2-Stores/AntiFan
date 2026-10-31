var exports = exports || {};
var module = { exports: exports };
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidTerminalFilePath = isValidTerminalFilePath;
exports.findTerminalFileLinks = findTerminalFileLinks;
exports.findTerminalFileLinkRanges = findTerminalFileLinkRanges;
const VALID_FILE_EXTENSIONS = {
    ts: true, tsx: true, js: true, jsx: true, cjs: true, mjs: true,
    json: true, json5: true, jsonc: true,
    css: true, scss: true, sass: true, less: true,
    html: true, htm: true, liquid: true, bwt: true,
    md: true, markdown: true, txt: true, rtf: true,
    yaml: true, yml: true, toml: true, ini: true, conf: true, config: true,
    svg: true, png: true, jpg: true, jpeg: true, webp: true, gif: true, ico: true, avif: true, bmp: true,
    mp4: true, webm: true, mov: true, m4v: true, ogv: true, mkv: true,
    sh: true, bash: true, zsh: true, ps1: true, bat: true, cmd: true,
    py: true, rs: true, go: true, c: true, cpp: true, h: true, hpp: true, cs: true, java: true, kt: true, swift: true, rb: true, php: true,
    lock: true, log: true, sql: true, csv: true, tsv: true, xml: true, vue: true, svelte: true, astro: true,
    graphql: true, gql: true, proto: true, env: true,
    pdf: true, doc: true, docx: true, xls: true, xlsx: true, ppt: true, pptx: true, zip: true,
};
const DISALLOWED_EXTENSIONS = {
    list: true, get: true, set: true, create: true, update: true, delete: true, close: true, activate: true,
    reload: true, navigate: true, evaluate: true, stat: true, read: true, write: true, drop: true, drag: true,
    hover: true, click: true, scroll: true, type: true, clear: true, freeze: true, capture: true, compare: true,
    dump_dom: true, styles: true, snapshot: true, validate_gate: true, verify_claim: true, record_claim: true,
    style_override: true, export_clean: true, resolve_element: true, tabs: true,
};
// Characters that end any path token.
const STOP = String.raw `\s:;,"'<>()[\]` + '`' + String.raw `\x1b`;
// A path token without spaces; may span several `/`-separated segments.
const TOKEN = `[^${STOP}]+`;
// One directory segment of an absolute path: a plain segment, or space-separated
// words free of shell metacharacters whose only dot may end the word (`1. Intro`).
const SPACED_WORD = String.raw `[^${STOP}.\\/&|$=*?!#]+\.?`;
const DIR_SEGMENT = String.raw `(?:${SPACED_WORD}(?: ${SPACED_WORD})+|[^${STOP}\\/]+)[\\/]`;
const FILE_PATH_RE = new RegExp(String.raw `(?:^|[\s"'` + '`' + String.raw `(\[<])(` +
    '(?:' +
    String.raw `[a-zA-Z]:[\\/](?:${DIR_SEGMENT})*${TOKEN}` +
    String.raw `|(?:\.{1,2}[\\/]|[a-zA-Z0-9_\-.]+[\\/])${TOKEN}\.[a-zA-Z0-9_\-]+` +
    String.raw `|\/(?:home|Users|usr|var|tmp|etc|work|Work)[\\/](?:${DIR_SEGMENT})*${TOKEN}` +
    String.raw `|[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*\.[a-zA-Z0-9_\-]+` +
    ')' +
    String.raw `(?::\d+(?::\d+)?)?)`, 'g');
/** True when a matched token names a real file type, not an MCP tool or RPC method. */
function isValidTerminalFilePath(candidate) {
    if (!candidate || typeof candidate !== 'string')
        return false;
    let p = candidate.trim().replace(/^["'`]/, '').replace(/["'`]$/, '');
    p = p.replace(/[,.;)]+$/, '');
    // `theme.*` MCP tool names are not guarded by prefix: none ends in an allowed file
    // extension, and a prefix guard would also reject `layout/theme.liquid`.
    if (p.startsWith('anti.') ||
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
        p.startsWith('document.')) {
        return false;
    }
    const lineColIdx = p.search(/:\d+(?::\d+)?$/);
    if (lineColIdx !== -1)
        p = p.slice(0, lineColIdx);
    const lastDot = p.lastIndexOf('.');
    if (lastDot === -1)
        return false;
    const ext = p.slice(lastDot + 1).toLowerCase();
    if (DISALLOWED_EXTENSIONS[ext])
        return false;
    return VALID_FILE_EXTENSIONS[ext] === true;
}
/** Every linkable file path in one terminal line, left to right. */
function findTerminalFileLinks(line) {
    const links = [];
    FILE_PATH_RE.lastIndex = 0;
    let match;
    while ((match = FILE_PATH_RE.exec(line)) !== null) {
        const pathText = match[1];
        if (pathText === undefined || !isValidTerminalFilePath(pathText))
            continue;
        // The path group always ends the match; its prefix is at most one delimiter char.
        const start = match.index + match[0].length - pathText.length;
        links.push({ start, end: start + pathText.length, text: pathText });
    }
    return links;
}
/** Rows one logical line may span before the reader stops (a runaway wrap chain). */
const MAX_WRAPPED_ROWS = 64;
/** Word-wrap breaks one path may be joined across (a path with several spaced folders). */
const MAX_JOINED_BREAKS = 4;
// The end of a row that stops inside an absolute path: the path start, then any spaced words.
const PATH_HEAD_RE = new RegExp(String.raw `(?:^|[\s"'` + '`' + String.raw `(\[<])(?:[a-zA-Z]:[\\/]|\/(?:home|Users|usr|var|tmp|etc|work|Work)[\\/])` +
    String.raw `[^${STOP}]*(?: ${SPACED_WORD})*$`);
function readRows(buffer, first, last) {
    let text = '';
    const cells = [];
    for (let y = first; y <= last; y += 1) {
        const line = buffer.getLine(y);
        if (!line)
            break;
        for (let x = 0; x < line.length; x += 1) {
            const cell = line.getCell(x);
            const width = cell ? cell.getWidth() : 1;
            if (width === 0)
                continue; // the right half of a wide glyph
            const chars = (cell && cell.getChars()) || ' ';
            for (let k = 0; k < chars.length; k += 1)
                cells.push({ x: x + 1, y: y + 1, width });
            text += chars;
        }
    }
    return { text, cells };
}
function trimRows(rows, start, end) {
    let from = 0;
    let to = rows.text.length;
    if (start)
        while (from < to && rows.text[from] === ' ')
            from += 1;
    if (end)
        while (to > from && rows.text[to - 1] === ' ')
            to -= 1;
    return { text: rows.text.slice(from, to), cells: rows.cells.slice(from, to) };
}
/** The 0-based rows xterm soft-wrapped into one logical line with `row`. */
function wrapGroup(buffer, row) {
    let first = row;
    while (first > 0 && row - first < MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped)
        first -= 1;
    let last = row;
    while (last - first < MAX_WRAPPED_ROWS - 1 && buffer.getLine(last + 1)?.isWrapped)
        last += 1;
    return { first, last };
}
/**
 * True when the program word-wrapped a path at one of its spaces: `prev` ends inside an absolute
 * path, the hard-broken row `next` opens with a `/`- or `\`-separated token, and that token would
 * not have fitted after `prev`'s text. The fit test is what tells a TUI's word wrap (OMP prints
 * `E:\Work\F1GENZ` and `MultiSync\a.xlsx` as two rows) from two unrelated lines.
 */
function continuesPathAcrossBreak(buffer, prev, next) {
    const nextLine = buffer.getLine(next);
    const prevLine = buffer.getLine(prev.last);
    if (!nextLine || nextLine.isWrapped || !prevLine)
        return false;
    const head = trimRows(readRows(buffer, prev.first, prev.last), false, true);
    const lastCell = head.cells[head.cells.length - 1];
    if (!lastCell || lastCell.y !== prev.last + 1 || !PATH_HEAD_RE.test(head.text))
        return false;
    const tail = trimRows(readRows(buffer, next, next), true, false);
    const tokenLength = tail.text.search(/ |$/);
    const token = tail.text.slice(0, tokenLength);
    if (!/[\\/]/.test(token) || !new RegExp(`^${TOKEN}$`).test(token))
        return false;
    let tokenColumns = 0;
    for (const cell of tail.cells.slice(0, tokenLength))
        tokenColumns += cell.width;
    return lastCell.x + lastCell.width - 1 + 1 + tokenColumns > prevLine.length;
}
/**
 * File links touching buffer row `bufferLineNumber` (1-based, as xterm's provideLinks passes it),
 * in cell coordinates. The row is read together with the rows it wraps from and into, so a path the
 * terminal broke across rows stays one link, and every string index is mapped to the cell it was
 * printed in: a wide glyph (CJK, emoji) takes two cells but one index, so string offsets alone put
 * every link after it in the wrong columns. A path the program itself word-wrapped at a space (hard
 * rows, no xterm wrap flag) is joined back the same way when `continuesPathAcrossBreak` holds.
 */
function findTerminalFileLinkRanges(buffer, bufferLineNumber) {
    const start = wrapGroup(buffer, bufferLineNumber - 1);
    const groups = [start];
    let head = start;
    for (let k = 0; k < MAX_JOINED_BREAKS && head.first > 0; k += 1) {
        const prev = wrapGroup(buffer, head.first - 1);
        if (!continuesPathAcrossBreak(buffer, prev, head.first))
            break;
        groups.unshift(prev);
        head = prev;
    }
    let tail = start;
    for (let k = 0; k < MAX_JOINED_BREAKS; k += 1) {
        if (!continuesPathAcrossBreak(buffer, tail, tail.last + 1))
            break;
        tail = wrapGroup(buffer, tail.last + 1);
        groups.push(tail);
    }
    let text = '';
    const cells = [];
    groups.forEach((group, i) => {
        const rows = trimRows(readRows(buffer, group.first, group.last), i > 0, i < groups.length - 1);
        const before = cells[cells.length - 1];
        if (before) {
            text += ' ';
            cells.push({ x: before.x + before.width, y: before.y, width: 1 });
        }
        text += rows.text;
        cells.push(...rows.cells);
    });
    const ranges = [];
    for (const link of findTerminalFileLinks(text)) {
        const startCell = cells[link.start];
        const endCell = cells[link.end - 1];
        if (!startCell || !endCell || endCell.y < bufferLineNumber || startCell.y > bufferLineNumber)
            continue;
        ranges.push({
            text: link.text,
            start: { x: startCell.x, y: startCell.y },
            end: { x: endCell.x + endCell.width - 1, y: endCell.y },
        });
    }
    return ranges;
}
//# sourceMappingURL=terminal-file-links.js.map
window.findTerminalFileLinks = exports.findTerminalFileLinks;
window.findTerminalFileLinkRanges = exports.findTerminalFileLinkRanges;
