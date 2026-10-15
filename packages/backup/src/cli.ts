import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ApiError,
  baseUrlFromEnv,
  DEFAULT_BASE_URL,
  type FetchLike,
  TgcloudClient,
} from 'tgcloud-api';
import { DEFAULT_PAGE_SIZE, isTableName, MAX_PAGE_SIZE, runBackup } from './backup.js';
import { directorySink, timestampName } from './fs-sink.js';

export const EXIT = { ok: 0, failed: 1, usage: 2, auth: 3, transient: 4 } as const;

export interface Io {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly fetch: FetchLike;
  readonly now: () => Date;
  readonly version: string;
}

const DEFAULT_OUT = 'tgcloud-backup';

const HELP = `Usage: tgbackup export [options]

Exports every table of a Telegram Serverless bot to NDJSON.
Read-only: it runs SELECT statements through the management API.

Options:
  --out <dir>        Parent directory. Default: ${DEFAULT_OUT}
                     Files go to <dir>/<UTC timestamp>/.
  --tables <a,b>     Only these tables. Default: all tables.
  --page-size <n>    Rows per call, 1-${MAX_PAGE_SIZE}. Default: ${DEFAULT_PAGE_SIZE}
  --json             Print progress as JSON lines
  -h, --help         Show this help
  -v, --version      Show the version

Environment:
  TGCLOUD_TOKEN     CLI access token from @BotFather (your bot > Serverless > CLI Access)
  TG_CLOUD_API_URL  Management API base URL. Default: ${DEFAULT_BASE_URL}
  TGCLOUD_BETA=1    Use the beta API, as the official CLI does

Exit codes: 0 ok, 1 export failed, 2 usage error, 3 auth error, 4 transient error.`;

export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        tables: { type: 'string' },
        'page-size': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (err) {
    return usage(io, err instanceof Error ? err.message : String(err));
  }

  if (values.version) {
    io.stdout(io.version);
    return EXIT.ok;
  }
  if (values.help || positionals.length === 0) {
    io.stdout(HELP);
    return values.help ? EXIT.ok : EXIT.usage;
  }
  if (positionals[0] !== 'export' || positionals.length > 1) {
    return usage(io, `unknown command "${positionals.join(' ')}"`);
  }

  const tables =
    typeof values.tables === 'string' ? values.tables.split(',').map((t) => t.trim()) : [];
  const badTables = tables.filter((t) => !isTableName(t));
  if (badTables.length > 0) return usage(io, `invalid table name(s): ${badTables.join(', ')}`);

  let pageSize = DEFAULT_PAGE_SIZE;
  if (typeof values['page-size'] === 'string') {
    pageSize = Number(values['page-size']);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      return usage(io, `--page-size must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    }
  }

  const token = io.env.TGCLOUD_TOKEN;
  if (!token) {
    io.stderr(
      'error: TGCLOUD_TOKEN is not set. Get the CLI access token from @BotFather (your bot > Serverless > CLI Access).',
    );
    return EXIT.auth;
  }

  const json = values.json === true;
  const print = (type: string, message: string, extra: Record<string, unknown> = {}) => {
    if (json) io.stdout(JSON.stringify({ ts: io.now().toISOString(), type, message, ...extra }));
    else io.stdout(`[backup] ${message}`);
  };

  try {
    const platform = new TgcloudClient({
      token,
      fetch: io.fetch,
      baseUrl: baseUrlFromEnv(io.env),
    });
    const parent = join(io.cwd, typeof values.out === 'string' ? values.out : DEFAULT_OUT);
    const dir = join(parent, timestampName(io.now()));
    const sink = directorySink(dir, relative(io.cwd, dir) || '.');
    print('start', `exporting ${platform.appId} to ${sink.location}`);
    const summary = await runBackup({
      platform,
      sink,
      tables,
      pageSize,
      now: io.now,
      onProgress: (message) => print('progress', message),
    });
    print(
      'end',
      `done: ${summary.rows} row(s) from ${summary.tables} table(s) in ${summary.location}`,
      {
        ...summary,
      },
    );
    return EXIT.ok;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`error: ${message}`);
    if (err instanceof ApiError) {
      if (err.kind === 'auth') return EXIT.auth;
      if (err.transient) return EXIT.transient;
    }
    return EXIT.failed;
  }
}

function usage(io: Io, message: string): number {
  io.stderr(`error: ${message}`);
  io.stderr('Run `tgbackup --help` for usage.');
  return EXIT.usage;
}
