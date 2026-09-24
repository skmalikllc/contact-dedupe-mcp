/** Minimal RFC 4180 CSV reader/writer — no dependency, handles quotes and CRLF. */

function parseCsv(text, delimiter = ',') {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}

/** CSV text → array of objects keyed by the header row. */
function toObjects(text, delimiter = ',') {
  const rows = parseCsv(text, delimiter);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; });
    return o;
  });
  return { headers, records };
}

function escape(value, delimiter = ',') {
  const s = String(value == null ? '' : value);
  return /[",\r\n]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fromObjects(records, headers, delimiter = ',') {
  const cols = headers && headers.length
    ? headers
    : [...records.reduce((set, r) => { Object.keys(r).forEach((k) => set.add(k)); return set; }, new Set())];
  const lines = [cols.map((c) => escape(c, delimiter)).join(delimiter)];
  for (const r of records) lines.push(cols.map((c) => escape(r[c], delimiter)).join(delimiter));
  return lines.join('\r\n');
}

module.exports = { parseCsv, toObjects, fromObjects, escape };
