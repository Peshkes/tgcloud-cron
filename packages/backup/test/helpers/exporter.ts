import { createRequire } from 'node:module';
import { BACKUP_SOURCE } from '../../src/exporter.js';

export type Row = Record<string, unknown>;
export interface Db {
  all(sql: string, params?: Record<string, unknown>): Promise<Row[]>;
}
export type Exporter = (input: Record<string, unknown>) => Promise<unknown>;

/** Loads the exporter that normally runs in the isolate, with `sdk.db` replaced. */
export function loadExporter(db: Db): Exporter {
  const body = BACKUP_SOURCE.replace("import { db } from 'sdk';", '').replace(
    'export default async function',
    'return async function',
  );
  return new Function('db', body)(db) as Exporter;
}

interface SqliteStatement {
  all(params: Record<string, unknown>): Row[];
  setReadBigInts(on: boolean): void;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

/**
 * A real SQLite database through `node:sqlite` (Node 22.5+), or undefined
 * where it is not available. Large integers come back as bigint, as they may
 * on the platform.
 */
export function sqlite(schema: string): { db: Db; raw: SqliteDb } | undefined {
  let mod: { DatabaseSync: new (path: string) => SqliteDb };
  try {
    mod = createRequire(import.meta.url)('node:sqlite');
  } catch {
    return undefined;
  }
  const raw = new mod.DatabaseSync(':memory:');
  raw.exec(schema);
  const db: Db = {
    async all(sql, params = {}) {
      const stmt = raw.prepare(sql);
      stmt.setReadBigInts(true);
      return stmt.all(params).map((row) => {
        // Small integers as numbers, like the platform's JSON-friendly driver.
        const out: Row = {};
        for (const [k, v] of Object.entries(row)) {
          out[k] =
            typeof v === 'bigint' &&
            v <= BigInt(Number.MAX_SAFE_INTEGER) &&
            v >= -BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(v)
              : v;
        }
        return out;
      });
    },
  };
  return { db, raw };
}
