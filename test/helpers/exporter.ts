import { BACKUP_SOURCE } from '../../src/adapters/tgcloud/entry.js';

export type Row = Record<string, unknown>;
export interface FakeTable {
  sql: string;
  rows: Row[];
}

/**
 * Loads the exporter that normally runs in the isolate, with `db` replaced by
 * a fake that understands exactly the queries the exporter sends.
 */
export function loadExporter(tables: Record<string, FakeTable>, queries: string[] = []) {
  const db = {
    async all(sql: string, params: Record<string, number> = {}): Promise<Row[]> {
      queries.push(sql);
      if (sql.includes('sqlite_master')) {
        return Object.entries(tables)
          .filter(([name]) => !name.startsWith('sqlite_'))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, t]) => ({ name, sql: t.sql }));
      }
      const name = /FROM "((?:[^"]|"")+)"/.exec(sql)?.[1]?.replace(/""/g, '"') ?? '';
      const table = tables[name];
      if (!table) throw new Error(`no such table: ${name}`);
      const limit = params[':limit'] ?? 0;
      if (sql.includes('OFFSET')) {
        const offset = params[':offset'] ?? 0;
        return table.rows.slice(offset, offset + limit);
      }
      const after = params[':after'] ?? 0;
      return table.rows
        .map((r, i) => ({ __tgcron_rowid: i + 1, ...r }))
        .filter((r) => r.__tgcron_rowid > after)
        .slice(0, limit);
    },
  };
  const body = BACKUP_SOURCE.replace("import { db } from 'sdk';", '').replace(
    'export default async function',
    'return async function',
  );
  return new Function('db', body)(db) as (input: Record<string, unknown>) => Promise<unknown>;
}
