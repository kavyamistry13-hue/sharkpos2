// Small dependency-free CSV reader/writer (RFC 4180 style).
//   parse():  BOM, CRLF/LF/CR line ends, quoted fields with "" escapes and line breaks inside quotes. An unterminated quote is an error, never guessed.
//   toCsv():  quotes when needed, and neutralises spreadsheet-formula injection (a TEXT cell starting with = + - @ tab or CR gets a leading ').
const { badRequest } = require('./errors');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLS = 40;

function parse(input) {
  if (typeof input !== 'string') throw badRequest('Send the CSV file as text (Content-Type: text/csv).', { code: 'CSV_NOT_TEXT' });
  if (Buffer.byteLength(input, 'utf8') > MAX_BYTES) throw badRequest('This CSV is larger than 5 MB. Split it into smaller files.', { code: 'CSV_TOO_LARGE' });
  let s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows = []; const lines = [];           // lines[i] = the line number the row started on (for error messages)
  let row = []; let field = ''; let q = false; let line = 1; let rowLine = 1; let any = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0].trim() !== '') { rows.push(row); lines.push(rowLine); }   // blank lines are skipped
    row = []; any = false;
  };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 1; } else q = false; } else { if (c === '\n') line += 1; field += c; }
      continue;
    }
    if (c === '"' && field === '' ) { q = true; any = true; continue; }
    if (c === '"') throw badRequest(`Line ${line}: a quote appears in the middle of a value. Wrap the whole value in quotes and double any inner quote.`, { code: 'CSV_MALFORMED', line });
    if (c === ',') { endField(); continue; }
    if (c === '\r' || c === '\n') { if (c === '\r' && s[i + 1] === '\n') i += 1; endRow(); line += 1; rowLine = line; continue; }
    field += c; any = true;
  }
  if (q) throw badRequest('The CSV has an opening quote that is never closed. Check the last quoted value.', { code: 'CSV_MALFORMED' });
  if (any || field !== '' || row.length) endRow();
  if (!rows.length) throw badRequest('The CSV file is empty.', { code: 'CSV_EMPTY' });
  if (rows[0].length > MAX_COLS) throw badRequest(`The CSV has more than ${MAX_COLS} columns.`, { code: 'CSV_MALFORMED' });
  if (rows.length - 1 > MAX_ROWS) throw badRequest(`The CSV has more than ${MAX_ROWS} rows. Split it into smaller files.`, { code: 'CSV_TOO_MANY_ROWS' });
  return { header: rows[0].map((h) => h.trim()), rows: rows.slice(1), lines: lines.slice(1) };
}

const needsQuote = /[",\r\n]/;
function cell(v, { text = false } = {}) {
  if (v === null || v === undefined) return '';
  let t = v instanceof Date ? v.toISOString() : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  if (text && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return needsQuote.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** columns: [{ key, header, text? }] — `text: true` for free-text columns (names, notes), which get the formula guard; numbers/dates never do. */
function toCsv(rows, columns) {
  const out = [columns.map((c) => cell(c.header)).join(',')];
  for (const r of rows) out.push(columns.map((c) => cell(r[c.key], { text: c.text })).join(','));
  return `﻿${out.join('\r\n')}\r\n`;     // BOM so Excel reads ₹ and Indian names as UTF-8
}

module.exports = { parse, toCsv, MAX_ROWS, MAX_BYTES };
