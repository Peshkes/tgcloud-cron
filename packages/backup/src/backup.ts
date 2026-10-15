import { ApiError, type Platform, withModules } from 'tgcloud-api';
import { BACKUP_MODULE, BACKUP_SOURCE } from './exporter.js';

/** Where a backup's files go. `directorySink` writes them to disk. */
export interface BackupSink {
  /** Where the files end up, for messages. */
  readonly location: string;
  open(name: string): BackupFile;
}

export interface BackupFile {
  append(text: string): Promise<void>;
  close(): Promise<{ bytes: number; sha256: string }>;
}

export interface BackupOptions {
  readonly platform: Platform;
  readonly sink: BackupSink;
  /** Deployed modules, if already fetched. Otherwise read with `GET /get`. */
  readonly modules?: Readonly<Record<string, string>>;
  /** Tables to export. Default: every table listed in `sqlite_master`. */
  readonly tables?: readonly string[];
  /** Rows per `/run` call. Default 500. */
  readonly pageSize?: number;
  readonly now?: () => Date;
  readonly onProgress?: (message: string) => void;
}

export interface BackupSummary {
  readonly location: string;
  readonly tables: number;
  readonly rows: number;
}

export const DEFAULT_PAGE_SIZE = 500;
export const MAX_PAGE_SIZE = 10_000;
export const MANIFEST_FORMAT = 'tgcloud-backup@1';

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether a name can be given in `tables`. Discovered tables may use any name. */
export function isTableName(name: string): boolean {
  return TABLE_NAME.test(name);
}

interface TableInfo {
  readonly name: string;
  /** Column name that reaches the rowid, or null to page by offset. */
  readonly rowid: string | null;
}

interface Page {
  readonly rows: unknown[];
  readonly last?: string;
}

// A page that hits the CPU, memory or response-size limit is retried with
// half as many rows. The limits are not published, so the error text is the
// only signal.
// Matched only against errors of the code itself (kind "request"), never
// against 429s, which mention limits too.
const LIMIT_ERROR = /cpu|memory|too large|exceed/i;
const MIN_PAGE_SIZE = 1;

/**
 * Exports tables page by page, one `/run` call per page, and writes one
 * NDJSON file per table plus `schema.js` and `manifest.json`.
 *
 * Read-only: the exporter only runs SELECT statements. Pages are separate
 * calls, so the export is not a point-in-time snapshot: rows written while it
 * runs may or may not be included.
 */
export async function runBackup(options: BackupOptions): Promise<BackupSummary> {
  const { platform, sink } = options;
  const now = options.now ?? (() => new Date());
  const progress = options.onProgress ?? (() => {});
  const requested = options.tables ?? [];
  const bad = requested.filter((t) => !isTableName(t));
  if (bad.length > 0) throw new Error(`invalid table name(s): ${bad.join(', ')}`);
  const initialPageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (
    !Number.isInteger(initialPageSize) ||
    initialPageSize < 1 ||
    initialPageSize > MAX_PAGE_SIZE
  ) {
    throw new Error(`page size must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }

  const startedAt = now();
  const modules = options.modules ?? (await platform.getDeployed()).modules;
  const sources = withModules(modules, { [BACKUP_MODULE]: BACKUP_SOURCE });

  const call = async (input: Record<string, unknown>): Promise<unknown> => {
    const result = await platform.run(BACKUP_MODULE, sources, input, { idempotent: true });
    if (!result.ok) throw result.error;
    return result.value;
  };

  // The listing also says how to page each table, so it runs even when the
  // caller names the tables.
  const listed = await call({ op: 'tables' });
  if (!Array.isArray(listed)) throw new Error('backup: table list is not an array');
  const all: TableInfo[] = listed.map((t) => ({
    name: String(t.name),
    rowid: typeof t.rowid === 'string' ? t.rowid : null,
  }));
  let tables = all;
  if (requested.length > 0) {
    const missing = requested.filter((name) => !all.some((t) => t.name === name));
    if (missing.length > 0) throw new Error(`table(s) not found: ${missing.join(', ')}`);
    tables = all.filter((t) => requested.includes(t.name));
  } else {
    progress(`found ${tables.length} table(s): ${tables.map((t) => t.name).join(', ') || '-'}`);
  }

  const files: Record<string, { table?: string; rows: number; bytes: number; sha256: string }> = {};
  const usedNames = new Set<string>(['schema', 'manifest']);
  let totalRows = 0;

  for (const table of tables) {
    const fileName = `${tableFileName(table.name, usedNames)}.ndjson`;
    const file = sink.open(fileName);
    let rows = 0;
    let after: string | null = null;
    let pageSize = initialPageSize;

    for (;;) {
      let page: Page;
      try {
        const input =
          table.rowid === null
            ? { op: 'page', table: table.name, rowid: null, offset: rows, limit: pageSize }
            : { op: 'page', table: table.name, rowid: table.rowid, after, limit: pageSize };
        page = parsePage(await call(input));
      } catch (err) {
        // Auth, network and rate-limit errors are not about this table; keep
        // their kind so the caller can map them to the right exit code.
        if (err instanceof ApiError && err.kind !== 'request') throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (pageSize > MIN_PAGE_SIZE && LIMIT_ERROR.test(message)) {
          pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 2));
          progress(`${table.name}: page too large (${message}); retrying with ${pageSize} rows`);
          continue;
        }
        throw new Error(`backup of table "${table.name}" failed after ${rows} rows: ${message}`);
      }

      if (page.rows.length > 0) {
        await file.append(`${page.rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
      }
      rows += page.rows.length;
      if (page.rows.length < pageSize) break;
      if (table.rowid !== null) {
        if (page.last === undefined || page.last === after) {
          throw new Error(`backup of table "${table.name}": the rowid cursor did not advance`);
        }
        after = page.last;
      }
    }

    files[fileName] = { table: table.name, rows, ...(await file.close()) };
    totalRows += rows;
    progress(`${table.name}: ${rows} row(s)`);
  }

  const schema = modules.schema;
  if (schema !== undefined) {
    const file = sink.open('schema.js');
    await file.append(schema);
    files['schema.js'] = { rows: 0, ...(await file.close()) };
  }

  const manifest = {
    format: MANIFEST_FORMAT,
    app: platform.appId,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    consistency: 'per-page; not a point-in-time snapshot',
    encoding: { bytes: '{"$base64": "..."}', bigint: '{"$bigint": "..."}' },
    files,
  };
  const file = sink.open('manifest.json');
  await file.append(`${JSON.stringify(manifest, null, 2)}\n`);
  await file.close();

  return { location: sink.location, tables: tables.length, rows: totalRows };
}

/**
 * A file name for a table. Table names come from the database and SQLite
 * accepts any text in a quoted name, including `../x`, so only a safe subset
 * is used as is. Names are compared case-insensitively because macOS and
 * Windows file systems are; the manifest maps every file back to its table.
 */
export function tableFileName(table: string, used: Set<string>): string {
  const base = /^[A-Za-z0-9_-]{1,100}$/.test(table)
    ? table
    : table.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'table';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}`;
  used.add(name.toLowerCase());
  return name;
}

function parsePage(value: unknown): Page {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Page).rows)) {
    throw new Error('backup: page result has no rows array');
  }
  const { rows, last } = value as { rows: unknown[]; last?: unknown };
  return typeof last === 'string' ? { rows, last } : { rows };
}
