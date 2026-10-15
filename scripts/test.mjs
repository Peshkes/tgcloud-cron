// Runs the compiled tests. `node --test <dir>` treats the argument as a
// directory on Node 18 and as a glob on Node 21+, so the files are listed here.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = 'build-test/test';
const files = readdirSync(root, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => join(root, f))
  .sort();

const { status } = spawnSync(process.execPath, ['--test', ...files, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(status ?? 1);
