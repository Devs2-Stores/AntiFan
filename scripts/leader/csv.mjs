// RFC 4180 CSV reader/writer for Google Sheets exports (quoted fields, "" escapes,
// embedded newlines, CRLF or LF). Backslashes are literal. No dependencies.

/** @param {string} text @returns {string[][]} */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "" && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      fieldStarted = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStarted = false;
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (quoted) throw new Error("CSV ends inside a quoted field (truncated export?)");
  if (field !== "" || fieldStarted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** @param {string[][]} rows */
export function stringifyCsv(rows) {
  const enc = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(enc).join(",")).join("\n") + "\n";
}
