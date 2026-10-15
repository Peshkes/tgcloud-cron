import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { CONFIG_FILE, type Config, formatProblems, validateConfig } from '../core/config.js';
import { parseJsonc } from '../core/jsonc.js';

export const MODULE_ROOT = 'tgcloud';

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** Nearest directory at or above `start` with a tgcron.json. */
export function findProjectRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function requireProjectRoot(start: string): string {
  const root = findProjectRoot(start);
  if (!root) {
    throw new UsageError(`no ${CONFIG_FILE} found in ${start} or above; run \`npx tgcron init\``);
  }
  return root;
}

export function loadConfig(root: string): Config {
  const path = join(root, CONFIG_FILE);
  let raw: unknown;
  try {
    raw = parseJsonc(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(`${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = validateConfig(raw);
  if (!result.ok) {
    throw new UsageError(`${CONFIG_FILE} is invalid:\n${formatProblems(result.problems)}`);
  }
  return result.config;
}

/**
 * Module sources of the local project, keyed by module name, read the way
 * the official CLI does: `schema.js`, `lib/` recursively, and the flat
 * runnable directories.
 */
export function readLocalModules(root: string): Record<string, string> {
  const base = join(root, MODULE_ROOT);
  if (!existsSync(base)) throw new UsageError(`no ${MODULE_ROOT}/ folder in ${root}`);
  const modules: Record<string, string> = {};
  const add = (file: string) => {
    const name = relative(base, file).split(sep).join('/').replace(/\.js$/, '');
    modules[name] = readFileSync(file, 'utf8');
  };

  const schema = join(base, 'schema.js');
  if (existsSync(schema)) add(schema);
  for (const dir of ['lib', 'handlers', 'endpoints']) {
    walk(join(base, dir), dir === 'lib', add);
  }
  return modules;
}

function walk(dir: string, nested: boolean, add: (file: string) => void): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && nested) walk(path, nested, add);
    else if (entry.isFile() && entry.name.endsWith('.js')) add(path);
  }
}

export function moduleFile(root: string, module: string): string {
  return join(root, MODULE_ROOT, `${module}.js`);
}
