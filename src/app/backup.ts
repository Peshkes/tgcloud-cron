import { BACKUP_MODULE, BACKUP_SOURCE, moduleSpace } from '../adapters/tgcloud/entry.js';
import type { BackupJob } from '../core/config.js';
import type { Deps } from './ports.js';

export interface BackupSummary {
  readonly location: string;
  readonly tables: number;
  readonly rows: number;
}

interface TableInfo {
  readonly name: string;
  readonly withoutRowid: boolean;
}

interface Page {
  readonly rows: unknown[];
  readonly last?: number;
}

// A page that hits the CPU, memory or response-size limit is retried with
// half as many rows. The limits are not published, so the error text is the
// only signal.
const LIMIT_ERROR = /cpu|memory|limit|too large|exceed|size/i;
const MIN_PAGE_SIZE = 1;

/**
 * Exports tables page by page, one `/run` call per page, and writes one
 * NDJSON file per table plus `schema.js` and `manifest.json`.
 *
 * Pages are separate calls, so the export is not a point-in-time snapshot:
 * rows written while it runs may or may not be included.
 */
export async function runBackup(
  job: BackupJob,
  modules: Readonly<Record<string, string>>,
  deps: Deps,
  ids: { job: string; runId: string },
  startedAt: Date,
): Promise<BackupSummary> {
  const sink = deps.backupSink?.(job.name, startedAt);
  if (!sink) throw new Error('backup jobs need a file system; run them with the CLI');
  const sources = moduleSpace(modules, { [BACKUP_MODULE]: BACKUP_SOURCE });
  const progress = (message: string) => deps.emit({ type: 'progress', ...ids, message });

  const call = async (input: Record<string, unknown>): Promise<unknown> => {
    const result = await deps.platform.run(BACKUP_MODULE, sources, input, { idempotent: true });
    if (!result.ok) throw result.error;
    return result.value;
  };

  let tables: TableInfo[];
  if (job.tables.length > 0) {
    tables = job.tables.map((name) => ({ name, withoutRowid: false }));
  } else {
    const listed = await call({ op: 'tables' });
    if (!Array.isArray(listed)) throw new Error('backup: table list is not an array');
    tables = listed.map((t) => ({ name: String(t.name), withoutRowid: t.withoutRowid === true }));
    progress(`found ${tables.length} table(s): ${tables.map((t) => t.name).join(', ') || '-'}`);
  }

  const files: Record<string, { rows: number; bytes: number; sha256: string }> = {};
  let totalRows = 0;

  for (const table of tables) {
    const file = sink.open(`${table.name}.ndjson`);
    let rows = 0;
    let after = 0;
    let pageSize = job.pageSize;

    for (;;) {
      let page: Page;
      try {
        const input = table.withoutRowid
          ? { op: 'page', table: table.name, offset: rows, limit: pageSize, noRowid: true }
          : { op: 'page', table: table.name, after, limit: pageSize };
        page = parsePage(await call(input));
      } catch (err) {
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
      if (page.last !== undefined) after = page.last;
      if (page.rows.length < pageSize) break;
    }

    files[`${table.name}.ndjson`] = { rows, ...(await file.close()) };
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
    format: 'tgcloud-cron/backup@1',
    app: deps.platform.appId,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    consistency: 'per-page; not a point-in-time snapshot',
    encoding: { bytes: '{"$base64": "..."}', bigint: '{"$bigint": "..."}' },
    files,
  };
  const file = sink.open('manifest.json');
  await file.append(`${JSON.stringify(manifest, null, 2)}\n`);
  await file.close();

  return { location: sink.location, tables: tables.length, rows: totalRows };
}

function parsePage(value: unknown): Page {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Page).rows)) {
    throw new Error('backup: page result has no rows array');
  }
  const { rows, last } = value as { rows: unknown[]; last?: unknown };
  return typeof last === 'number' ? { rows, last } : { rows };
}
