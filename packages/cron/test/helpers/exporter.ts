import { BACKUP_SOURCE } from 'tgcloud-backup';

export type Row = Record<string, unknown>;

/**
 * The backup exporter with `sdk.db` replaced by in-memory rowid tables. The
 * exporter itself is tested against real SQLite in tgcloud-backup; here it
 * only has to answer the queries a backup job sends.
 */
export function loadExporter(tables: Record<string, Row[]>) {
  const db = {
    async all(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
      if (sql.includes('sqlite_master')) {
        return Object.keys(tables)
          .sort()
          .map((name) => ({ name, sql: `CREATE TABLE ${name} (x)` }));
      }
      if (sql.includes('pragma_table_info')) return [];
      const name = /FROM "((?:[^"]|"")+)"/.exec(sql)?.[1]?.replace(/""/g, '"') ?? '';
      const rows = tables[name];
      if (!rows) throw new Error(`no such table: ${name}`);
      const after =
        params[':after'] === undefined ? Number.NEGATIVE_INFINITY : Number(params[':after']);
      return rows
        .map((r, i) => ({ __tgbackup_rowid: i + 1, ...r }))
        .filter((r) => r.__tgbackup_rowid > after)
        .slice(0, Number(params[':limit']));
    },
  };
  const body = BACKUP_SOURCE.replace("import { db } from 'sdk';", '').replace(
    'export default async function',
    'return async function',
  );
  return new Function('db', body)(db) as (input: Record<string, unknown>) => Promise<unknown>;
}
