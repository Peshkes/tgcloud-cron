import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BACKUP_DIR } from '../adapters/github/workflow.js';
import type { BackupSink } from '../app/ports.js';

/** Writes a backup to `tgcron-backup/<job>/<UTC timestamp>/` under the project root. */
export function fileSink(root: string, job: string, startedAt: Date): BackupSink {
  const stamp = startedAt
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, 'Z');
  const dir = join(root, BACKUP_DIR, job, stamp);
  mkdirSync(dir, { recursive: true });

  return {
    location: relative(root, dir) || '.',
    open(name: string) {
      const path = join(dir, name);
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
