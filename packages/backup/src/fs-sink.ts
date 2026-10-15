import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { BackupSink } from './backup.js';

/** `2026-10-16T02:30:00Z` as a directory name that every file system accepts. */
export function timestampName(date: Date): string {
  return date
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, 'Z');
}

/**
 * Writes backup files into `dir`, creating it. `location` is what messages
 * show, usually `dir` relative to the working directory.
 */
export function directorySink(dir: string, location: string = dir): BackupSink {
  mkdirSync(dir, { recursive: true });
  return {
    location,
    open(name: string) {
      // runBackup only produces safe names; this keeps any other caller inside `dir`.
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.')) {
        throw new Error(`refusing to write backup file "${name}"`);
      }
      const path = `${dir}/${name}`;
      const hash = createHash('sha256');
      let bytes = 0;
      writeFileSync(path, '');
      return {
        async append(text: string) {
          const chunk = Buffer.from(text, 'utf8');
          appendFileSync(path, chunk);
          hash.update(chunk);
          bytes += chunk.length;
        },
        async close() {
          return { bytes, sha256: hash.digest('hex') };
        },
      };
    },
  };
}
