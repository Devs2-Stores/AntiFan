// Layout-tolerant sheet diff for Leader jobs. Rows are keyed by the TEXT of the task
// column (never by row number); cells are addressed by header text. Duplicate keys are
// told apart by occurrence index (1-based, in file order).

import { parseCsv } from "./csv.mjs";

export const normKey = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const normVal = (s) => String(s ?? "").replace(/\r\n/g, "\n");
const isNumeric = (s) => /^[\d\s.,/%+-]+$/.test(s);
const DONE_LIKE = /^(true|x|fixed|done|đã báo khách|closed|resolved)$/i;
const CHECKBOX = /^(true|false)$/i;

const colLetter = (j) => {
  let n = j + 1;
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/**
 * @param {string[][]} rows parsed CSV
 * @param {{work:string, owner?:string|null, note:string, done?:string|null}} cols header texts
 */
export function analyzeSheet(rows, cols) {
  const wanted = [["work", cols.work], ["note", cols.note], ["owner", cols.owner], ["done", cols.done]].filter(
    ([, h]) => h,
  );
  let headerRow = -1;
  let best = { missing: wanted.map(([, h]) => h), at: -1 };
  for (let r = 0; r < rows.length; r++) {
    const trimmed = rows[r].map((c) => c.trim());
    const missing = wanted.filter(([, h]) => !trimmed.includes(String(h).trim())).map(([, h]) => h);
    if (missing.length === 0) {
      headerRow = r;
      break;
    }
    if (missing.length < best.missing.length) best = { missing, at: r };
  }
  if (headerRow < 0) {
    return {
      ok: false,
      error: `header row not found: no row contains all of [${wanted.map(([, h]) => h).join(" | ")}]; closest row ${best.at + 1} lacks [${best.missing.join(" | ")}]`,
    };
  }
  const head = rows[headerRow].map((c) => c.trim());
  const idx = {};
  for (const [k, h] of wanted) idx[k] = head.indexOf(String(h).trim());
  const width = Math.max(0, ...rows.map((r) => r.length));
  const seen = new Map();
  const headers = [];
  for (let j = 0; j < width; j++) {
    let name = head[j] || `col${colLetter(j)}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name}#${n}`;
    headers.push(name);
  }
  const reserved = new Set(Object.values(idx));
  const occ = new Map();
  const out = rows.map((cells, r) => {
    const cell = (j) => (j >= 0 ? (cells[j] ?? "") : "");
    const first = cells.map(normKey).find((c) => c !== "") ?? "";
    let key = null;
    if (r > headerRow) {
      key = normKey(cell(idx.work));
      if (!key) {
        for (let j = 0; j < cells.length; j++) {
          if (reserved.has(j)) continue;
          const t = normKey(cells[j]);
          if (t && !isNumeric(t)) {
            key = t;
            break;
          }
        }
      }
    }
    const data = Boolean(key);
    if (!data) key = `~${normKey(first)}`;
    const n = (occ.get(key) ?? 0) + 1;
    occ.set(key, n);
    const map = {};
    for (let j = 0; j < width; j++) map[headers[j]] = normVal(cells[j] ?? "");
    return { rowNumber: r + 1, key, occ: n, id: `${key}\u0000${n}`, data, cells: map };
  });
  const dataRows = out.filter((x) => x.data);
  const doneName = idx.done >= 0 && idx.done !== undefined ? headers[idx.done] : null;
  const doneVals = doneName ? dataRows.map((x) => x.cells[doneName].trim()).filter((v) => v !== "") : [];
  const doneKind = !doneName ? "none" : doneVals.every((v) => CHECKBOX.test(v)) ? "checkbox" : "stage";
  return {
    ok: true,
    headerRow: headerRow + 1,
    headers,
    names: {
      work: headers[idx.work],
      note: headers[idx.note],
      owner: idx.owner !== undefined ? headers[idx.owner] : null,
      done: doneName,
    },
    doneKind,
    rows: out,
  };
}

export function parseSheet(text, cols) {
  let rows;
  try {
    rows = parseCsv(text);
  } catch (e) {
    return { ok: false, error: `CSV parse error: ${e.message}` };
  }
  if (rows.length === 0) return { ok: false, error: "CSV is empty" };
  const first = (rows[0][0] ?? "").trim().toLowerCase();
  if (/^<!doctype html|^<html/.test(first) || (rows.length < 3 && /sign in|đăng nhập/i.test(rows.flat().join(" ")))) {
    return { ok: false, error: "response is an HTML/login page, not CSV (sheet is private or the link is wrong)" };
  }
  return analyzeSheet(rows, cols);
}

/** Rows the Dev side still owes, computed on one sheet analysis. */
export function outstandingDevRows(sheet) {
  const { names, doneKind } = sheet;
  const out = [];
  for (const r of sheet.rows) {
    if (!r.data) continue;
    if (names.owner && !/\bdev\b/i.test(r.cells[names.owner])) continue;
    const note = r.cells[names.note].trim();
    const done = names.done ? r.cells[names.done].trim() : "";
    if (doneKind === "stage") {
      if (DONE_LIKE.test(done)) continue;
    } else {
      if (/^true$/i.test(done) || note !== "") continue;
    }
    out.push({ row: r.rowNumber, key: r.key.length > 100 ? `${r.key.slice(0, 97)}...` : r.key });
  }
  return out;
}

/** Cell-level diff of two analyses. */
export function diffSheets(before, after) {
  const b = new Map(before.rows.map((r) => [r.id, r]));
  const a = new Map(after.rows.map((r) => [r.id, r]));
  const changed = [];
  const added = [];
  const removed = [];
  for (const [id, ra] of a) {
    const rb = b.get(id);
    if (!rb) {
      if (ra.data || Object.values(ra.cells).some((v) => v.trim() !== "")) added.push(ra);
      continue;
    }
    const names = new Set([...Object.keys(rb.cells), ...Object.keys(ra.cells)]);
    for (const col of names) {
      const x = rb.cells[col] ?? "";
      const y = ra.cells[col] ?? "";
      if (x !== y) changed.push({ key: ra.key, occ: ra.occ, col, rowBefore: rb.rowNumber, rowAfter: ra.rowNumber, before: x, after: y, data: ra.data });
    }
  }
  for (const [id, rb] of b) {
    if (!a.has(id) && (rb.data || Object.values(rb.cells).some((v) => v.trim() !== ""))) removed.push(rb);
  }
  return { changed, added, removed };
}

const short = (s, n = 70) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/**
 * @param {{beforeText:string, afterText:string|null, cols:object, claimed:Array<{key:string,col:string,expect:string,occurrence?:number}>, readError?:string}} p
 */
export function verifySheet(p) {
  const base = { status: "UNREADABLE", notes: [], changedCells: [], foreign: [], added: [], removed: [], outstandingDevRows: [], claimedCount: 0 };
  if (p.afterText == null) return { ...base, notes: [p.readError || "current sheet could not be read"] };
  const before = parseSheet(p.beforeText, p.cols);
  if (!before.ok) return { ...base, notes: [`snapshot-before unreadable: ${before.error}`] };
  const after = parseSheet(p.afterText, p.cols);
  if (!after.ok) return { ...base, notes: [`current sheet unreadable: ${after.error}`] };

  const diff = diffSheets(before, after);
  const notes = [];
  let fail = false;
  const claimedIds = new Set();
  const claims = p.claimed ?? [];
  for (const c of claims) {
    const label = `"${short(normKey(c.key))}" / ${c.col}`;
    const key = normKey(c.key);
    const matches = after.rows.filter((r) => r.data && r.key === key);
    if (matches.length === 0) {
      notes.push(`FAIL claimed row not found by text: ${label}`);
      fail = true;
      continue;
    }
    if (matches.length > 1 && !c.occurrence) {
      notes.push(`FAIL claimed key is ambiguous (${matches.length} rows share this text), give "occurrence": ${label}`);
      fail = true;
      continue;
    }
    const row = matches[c.occurrence ? c.occurrence - 1 : 0];
    if (!row) {
      notes.push(`FAIL claimed occurrence ${c.occurrence} does not exist (${matches.length} rows): ${label}`);
      fail = true;
      continue;
    }
    if (!(c.col in row.cells)) {
      notes.push(`FAIL claimed column does not exist in the sheet header: ${c.col} (headers: ${after.headers.join(" | ")})`);
      fail = true;
      continue;
    }
    const cellId = `${row.id}\u0000${c.col}`;
    claimedIds.add(cellId);
    const actual = row.cells[c.col];
    const prev = before.rows.find((r) => r.id === row.id)?.cells[c.col];
    if (prev === actual) {
      notes.push(`FAIL claimed but unchanged: ${label} (row ${row.rowNumber})`);
      fail = true;
    } else if (actual !== normVal(c.expect)) {
      notes.push(`FAIL cell differs from expect: ${label} (row ${row.rowNumber}) actual=${JSON.stringify(short(actual, 60))} expect=${JSON.stringify(short(normVal(c.expect), 60))}`);
      fail = true;
    }
  }

  const changedCells = [];
  const foreign = [];
  for (const ch of diff.changed) {
    const id = `${ch.key}\u0000${ch.occ}\u0000${ch.col}`;
    const rec = { key: short(ch.key, 100), occ: ch.occ, col: ch.col, rowBefore: ch.rowBefore, rowAfter: ch.rowAfter, before: short(ch.before, 60), after: short(ch.after, 60) };
    changedCells.push(rec);
    if (!claimedIds.has(id)) {
      foreign.push(rec);
      notes.push(`WARN foreign edit: "${short(ch.key)}" / ${ch.col} (row ${ch.rowAfter}) changed but is not in the report`);
    }
  }
  const added = diff.added.map((r) => ({ row: r.rowNumber, key: short(r.key, 100) }));
  const removed = diff.removed.map((r) => ({ row: r.rowNumber, key: short(r.key, 100) }));
  for (const r of added) notes.push(`WARN row appended (foreign): row ${r.row} "${short(r.key)}"`);
  for (const r of removed) notes.push(`WARN row removed: was row ${r.row} "${short(r.key)}"`);

  const status = fail ? "FAIL" : foreign.length || added.length || removed.length ? "WARN" : "PASS";
  return {
    status,
    notes,
    changedCells,
    foreign,
    added,
    removed,
    claimedCount: claims.length,
    outstandingDevRows: outstandingDevRows(after),
    doneKind: after.doneKind,
  };
}
