/** Entry module name of the exporter inside the `/run` module space. */
export const BACKUP_MODULE = 'endpoints/tgbackup_export';

/**
 * Exporter run inside the isolate. The isolate has no Buffer, atob or btoa,
 * so blobs are base64-encoded by hand. Values that JSON cannot carry are
 * tagged: `{ "$base64": "..." }` for bytes, `{ "$bigint": "..." }` for
 * integers beyond 2^53.
 *
 * Operations:
 *   { op: "tables" }                                -> [{ name, rowid }]
 *   { op: "page", table, rowid, after, limit }      -> { rows, last }   rowid paging
 *   { op: "page", table, rowid: null, offset, limit } -> { rows }       WITHOUT ROWID tables
 *
 * `rowid` is the name that reaches the real rowid in that table, or null when
 * the table has none. `after` and `last` are rowids as strings; `after: null`
 * starts from the first row.
 */
export const BACKUP_SOURCE = `// Sent by tgcloud-backup with each /run call. Never deployed.
import { db } from 'sdk';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] + '=' : '==';
  }
  return out;
}

function encode(value) {
  if (value instanceof Uint8Array) return { $base64: base64(value) };
  if (value instanceof ArrayBuffer) return { $base64: base64(new Uint8Array(value)) };
  if (typeof value === 'bigint') return { $bigint: String(value) };
  return value;
}

function quote(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function encodeRow(row, skip) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (k !== skip) out[k] = encode(v);
  return out;
}

// A table can define its own column named rowid, _rowid_ or oid, which then
// hides the real rowid under that name. Use the first name the table leaves free.
const ROWID_NAMES = ['rowid', '_rowid_', 'oid'];

async function rowidName(table) {
  try {
    const cols = await db.all('SELECT name FROM pragma_table_info(:t)', { ':t': table });
    const taken = new Set(cols.map((c) => String(c.name).toLowerCase()));
    return ROWID_NAMES.find((n) => !taken.has(n)) ?? null;
  } catch {
    return 'rowid';
  }
}

export default async function (input) {
  if (input.op === 'tables') {
    const rows = await db.all(
      // Internal tables start with "sqlite_"; LIKE would treat "_" as a wildcard.
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name",
    );
    const out = [];
    for (const r of rows) {
      const withoutRowid = /\\)\\s*(?:STRICT\\s*,\\s*)?WITHOUT\\s+ROWID\\s*(?:,\\s*STRICT\\s*)?;?\\s*$/i.test(r.sql || '');
      out.push({ name: r.name, rowid: withoutRowid ? null : await rowidName(r.name) });
    }
    return out;
  }
  if (input.op === 'page') {
    const table = quote(input.table);
    if (input.rowid === null) {
      const rows = await db.all('SELECT * FROM ' + table + ' LIMIT :limit OFFSET :offset', {
        ':limit': input.limit,
        ':offset': input.offset,
      });
      return { rows: rows.map((r) => encodeRow(r)) };
    }
    if (!ROWID_NAMES.includes(input.rowid)) throw new Error('bad rowid name ' + input.rowid);
    const rowid = input.rowid;
    // The first page has no lower bound: rowids can be zero or negative.
    // The cursor travels as a string so rowids beyond 2^53 survive JSON.
    const where = input.after === null ? '' : ' WHERE ' + rowid + ' > CAST(:after AS INTEGER)';
    const params = { ':limit': input.limit };
    if (input.after !== null) params[':after'] = input.after;
    const rows = await db.all(
      'SELECT ' + rowid + ' AS __tgbackup_rowid, * FROM ' + table + where + ' ORDER BY ' + rowid + ' LIMIT :limit',
      params,
    );
    let last = input.after;
    const out = rows.map((r) => {
      last = String(r.__tgbackup_rowid);
      return encodeRow(r, '__tgbackup_rowid');
    });
    return { rows: out, last };
  }
  throw new Error('unknown op ' + input.op);
}
`;
