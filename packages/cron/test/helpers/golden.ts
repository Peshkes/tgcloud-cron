import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Compares `actual` with `test/golden/<name>`. Run with UPDATE_GOLDEN=1 to
 * rewrite the files, then review the diff.
 */
export function assertGolden(name: string, actual: string): void {
  const path = join('test/golden', name);
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    if (process.env.UPDATE_GOLDEN !== '1')
      assert.fail(`created missing golden file ${path}; review and rerun`);
    return;
  }
  assert.equal(
    actual,
    readFileSync(path, 'utf8'),
    `differs from ${path} (UPDATE_GOLDEN=1 to accept)`,
  );
}
