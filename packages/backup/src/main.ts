#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { EXIT, runCli } from './cli.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  fetch: (url, init) => fetch(url, init),
  now: () => new Date(),
  version: pkg.version,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = EXIT.usage;
  },
);
