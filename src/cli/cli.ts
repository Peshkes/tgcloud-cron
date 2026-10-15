import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { CLOUDFLARE_DIR, generateCloudflare } from '../adapters/cloudflare/worker.js';
import { generateGithubWorkflow, WORKFLOW_PATH } from '../adapters/github/workflow.js';
import {
  ApiError,
  DEFAULT_BASE_URL,
  type FetchLike,
  TgcloudClient,
} from '../adapters/tgcloud/client.js';
import { formatEvent, formatEventJson } from '../app/format.js';
import type { Deps, RunEvent } from '../app/ports.js';
import { type JobOutcome, runJob, runTick } from '../app/run.js';
import { CONFIG_FILE, type Config, JOB_MODULE_DIR } from '../core/config.js';
import { nextRuns, parseCron, previousRun } from '../core/cron.js';
import { parseJsonc } from '../core/jsonc.js';
import { checkTarget, findJob, jobsForSchedule, TARGETS, type Target } from '../core/registry.js';
import { fileSink } from './fs-sink.js';
import {
  loadConfig,
  MODULE_ROOT,
  moduleFile,
  readLocalModules,
  requireProjectRoot,
  UsageError,
} from './project.js';
import { CONFIG_TEMPLATE, JOB_TEMPLATE } from './templates.js';

export const EXIT = { ok: 0, jobFailed: 1, usage: 2, auth: 3, transient: 4 } as const;

export interface Io {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly fetch: FetchLike;
  readonly now: () => Date;
  readonly version: string;
}

const HELP = `Usage: tgcron <command> [options]

Scheduled jobs for Telegram Serverless.

Commands:
  init                         Create tgcron.json and an example job
  check                        Validate tgcron.json and generated files (offline)
  generate github|cloudflare   Write the scheduler configuration
  run <job> [--local]          Run one job now (--local: use local files, not deployed code)
  tick --schedule "<cron>"     Run every job on this schedule (used by the generated workflow)

Options:
  --json        Print run events as JSON lines (run, tick)
  --name <n>    Worker name (generate cloudflare). Default: tgcron
  -h, --help    Show this help
  -v, --version Show the version

Environment:
  TGCLOUD_TOKEN     CLI access token from @BotFather (run, tick)
  TG_CLOUD_API_URL  Management API base URL. Default: ${DEFAULT_BASE_URL}

Exit codes: 0 ok, 1 a job failed, 2 usage or config error, 3 auth error, 4 transient error.`;

export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
    io.stderr('Run `tgcron --help` for usage.');
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(io.version);
    return EXIT.ok;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    io.stdout(HELP);
    return command || values.help ? EXIT.ok : EXIT.usage;
  }

  try {
    switch (command) {
      case 'init':
        return init(io);
      case 'check':
        return check(io);
      case 'generate':
        return generate(io, rest[0], values.name);
      case 'run':
        return await run(io, rest[0], values.local === true, values.json === true);
      case 'tick':
        return await tick(io, values.schedule, values.json === true);
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`error: ${err.message}`);
      return EXIT.usage;
    }
    throw err;
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      local: { type: 'boolean' },
      schedule: { type: 'string' },
      name: { type: 'string' },
    },
  });
}

function init(io: Io): number {
  const created: string[] = [];
  const write = (path: string, content: string) => {
    const full = join(io.cwd, path);
    if (existsSync(full)) {
      io.stdout(`exists   ${path}`);
      return;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    created.push(path);
    io.stdout(`created  ${path}`);
  };

  if (!existsSync(join(io.cwd, MODULE_ROOT))) {
    io.stderr(
      `warning: no ${MODULE_ROOT}/ folder here; is this a tgcloud project? (npx tgcloud init)`,
    );
  }
  write(CONFIG_FILE, CONFIG_TEMPLATE);
  write(`${MODULE_ROOT}/${JOB_MODULE_DIR}/example.js`, JOB_TEMPLATE);
  io.stdout('');
  io.stdout('Next: deploy the job with `npx tgcloud push`, then `npx tgcron generate github`.');
  return EXIT.ok;
}

function check(io: Io): number {
  const root = requireProjectRoot(io.cwd);
  const config = loadConfig(root);
  let errors = 0;
  const now = io.now();

  for (const job of config.jobs) {
    const state = job.enabled ? '' : '  (disabled)';
    io.stdout(`${job.name}  "${job.schedule.source}"${state}`);
    if (job.kind === 'module') {
      const file = moduleFile(root, job.module);
      if (!existsSync(file)) {
        errors++;
        io.stdout(`  error: ${relative(root, file)} not found`);
      }
    } else {
      io.stdout('  built-in backup');
    }
    const next = nextRuns(job.schedule, now, 3).map((d) =>
      d.toISOString().replace(':00.000Z', 'Z'),
    );
    io.stdout(`  next: ${next.length > 0 ? next.join(', ') : 'never'}`);
  }
  if (config.jobs.length === 0) io.stdout('no jobs defined');

  // Targets are checked when their generated files exist.
  for (const target of TARGETS) {
    const expected = generatedFiles(config, target, io.version, workerName(root));
    const present = expected.filter((f) => existsSync(join(root, f.path)));
    if (present.length === 0) continue;
    for (const p of checkTarget(config, target)) {
      if (p.severity === 'error') errors++;
      io.stdout(`${target}: ${p.severity}: ${p.job ? `${p.job}: ` : ''}${p.message}`);
    }
    for (const file of present) {
      if (readFileSync(join(root, file.path), 'utf8') !== file.content) {
        errors++;
        io.stdout(
          `${target}: error: ${file.path} is out of date; run \`npx tgcron generate ${target}\``,
        );
      }
    }
  }

  io.stdout(errors === 0 ? 'ok' : `${errors} error(s)`);
  return errors === 0 ? EXIT.ok : EXIT.usage;
}

// The Worker name is chosen at generate time; read it back for comparison.
function workerName(root: string): string | undefined {
  const path = join(root, CLOUDFLARE_DIR, 'wrangler.jsonc');
  if (!existsSync(path)) return undefined;
  try {
    const name = (parseJsonc(readFileSync(path, 'utf8')) as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

function generatedFiles(config: Config, target: Target, version: string, name: string | undefined) {
  if (target === 'github') {
    return [{ path: WORKFLOW_PATH, content: generateGithubWorkflow(config, { version }) }];
  }
  return generateCloudflare(config, { version, ...(name !== undefined ? { name } : {}) });
}

function generate(io: Io, target: string | undefined, name: string | undefined): number {
  if (target !== 'github' && target !== 'cloudflare') {
    throw new UsageError('usage: tgcron generate github|cloudflare');
  }
  const root = requireProjectRoot(io.cwd);
  const config = loadConfig(root);

  const problems = checkTarget(config, target);
  for (const p of problems) {
    io.stderr(`${p.severity}: ${p.job ? `${p.job}: ` : ''}${p.message}`);
  }
  if (problems.some((p) => p.severity === 'error')) return EXIT.usage;

  let files: { path: string; content: string }[];
  try {
    files = generatedFiles(config, target, io.version, name);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  for (const file of files) {
    const full = join(root, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
    io.stdout(`wrote ${file.path}`);
  }

  io.stdout('');
  if (target === 'github') {
    io.stdout('Next:');
    io.stdout(
      '  1. Add the repository secret TGCLOUD_TOKEN (Settings > Secrets and variables > Actions).',
    );
    io.stdout(`  2. Commit ${WORKFLOW_PATH} and push to the default branch.`);
    io.stdout('  3. Try a job now: Actions > tgcron > Run workflow.');
  } else {
    io.stdout('Next:');
    io.stdout(`  cd ${CLOUDFLARE_DIR} && npm install`);
    io.stdout('  npx wrangler secret put TGCLOUD_TOKEN');
    io.stdout('  npx wrangler deploy');
  }
  return EXIT.ok;
}

async function run(
  io: Io,
  name: string | undefined,
  local: boolean,
  json: boolean,
): Promise<number> {
  if (!name) throw new UsageError('usage: tgcron run <job> [--local]');
  const root = requireProjectRoot(io.cwd);
  const config = loadConfig(root);
  const job = findJob(config, name);
  if (!job) {
    const known = config.jobs.map((j) => j.name).join(', ') || 'none';
    throw new UsageError(`unknown job "${name}"; jobs in ${CONFIG_FILE}: ${known}`);
  }
  const localModules = local ? readLocalModules(root) : undefined;

  const reporter = new Reporter(io, json);
  const deps = makeDeps(io, root, reporter);
  if (!deps) return EXIT.auth;
  try {
    const outcome = await runJob(job, deps, localModules ? { localModules } : {});
    reporter.summary([outcome]);
    return outcome.ok ? EXIT.ok : EXIT.jobFailed;
  } catch (err) {
    return reporter.fatal(err);
  }
}

async function tick(io: Io, schedule: string | undefined, json: boolean): Promise<number> {
  if (!schedule) throw new UsageError('usage: tgcron tick --schedule "<cron expression>"');
  let cron: ReturnType<typeof parseCron>;
  try {
    cron = parseCron(schedule);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const root = requireProjectRoot(io.cwd);
  const config = loadConfig(root);
  const reporter = new Reporter(io, json);

  if (jobsForSchedule(config, cron.source).length === 0) {
    // The workflow on the default branch can lag behind tgcron.json.
    reporter.warn(
      `no enabled job has schedule "${cron.source}"; regenerate the workflow with \`npx tgcron generate github\``,
    );
    return EXIT.ok;
  }

  const deps = makeDeps(io, root, reporter);
  if (!deps) return EXIT.auth;
  const scheduledAt = previousRun(cron, io.now()) ?? null;
  const result = await runTick(config, cron.source, deps, scheduledAt);
  reporter.summary(result.outcomes);
  if (result.fatal) return reporter.fatal(result.fatal);
  return result.outcomes.every((o) => o.ok) ? EXIT.ok : EXIT.jobFailed;
}

function makeDeps(io: Io, root: string, reporter: Reporter): Deps | undefined {
  const token = io.env.TGCLOUD_TOKEN;
  if (!token) {
    reporter.error(
      'TGCLOUD_TOKEN is not set. Get the CLI access token from @BotFather (your bot > Serverless > CLI Access) and pass it as an environment variable or CI secret.',
    );
    return undefined;
  }
  let platform: TgcloudClient;
  try {
    platform = new TgcloudClient({
      token,
      fetch: io.fetch,
      baseUrl: io.env.TG_CLOUD_API_URL || DEFAULT_BASE_URL,
    });
  } catch (err) {
    reporter.error(err instanceof Error ? err.message : String(err));
    return undefined;
  }
  return {
    platform,
    emit: (event) => reporter.event(event),
    now: io.now,
    newRunId: () => randomBytes(4).toString('hex'),
    backupSink: (job, startedAt) => fileSink(root, job, startedAt),
  };
}

/** Prints run events, and in GitHub Actions adds annotations and a step summary. */
class Reporter {
  private readonly github: boolean;
  private readonly rows: string[] = [];

  constructor(
    private readonly io: Io,
    private readonly json: boolean,
  ) {
    this.github = io.env.GITHUB_ACTIONS === 'true';
  }

  event(event: RunEvent): void {
    if (this.json) {
      this.io.stdout(formatEventJson(event, this.io.now()));
    } else {
      for (const line of formatEvent(event)) this.io.stdout(line);
    }
    if (event.type === 'end') {
      const status = event.ok ? 'ok' : 'failed';
      const detail = event.ok ? '' : (event.error ?? '').split('\n')[0];
      this.rows.push(
        `| ${event.job} | ${event.runId} | ${status} | ${(event.durationMs / 1000).toFixed(1)}s | ${md(detail ?? '')} |`,
      );
      if (!event.ok && this.github) {
        this.io.stdout(
          `::error title=tgcron job ${event.job} failed::${annotation(event.error ?? 'failed')}`,
        );
      }
    }
  }

  warn(message: string): void {
    this.io.stderr(`warning: ${message}`);
    if (this.github) this.io.stdout(`::warning title=tgcron::${annotation(message)}`);
  }

  error(message: string): void {
    this.io.stderr(`error: ${message}`);
    if (this.github) this.io.stdout(`::error title=tgcron::${annotation(message)}`);
  }

  fatal(err: unknown): number {
    if (!(err instanceof ApiError)) throw err;
    this.error(err.message);
    if (err.kind === 'auth') return EXIT.auth;
    if (err.transient) return EXIT.transient;
    return EXIT.jobFailed;
  }

  summary(outcomes: readonly JobOutcome[]): void {
    const file = this.io.env.GITHUB_STEP_SUMMARY;
    if (!this.github || !file || outcomes.length === 0) return;
    const text = [
      '### tgcron',
      '',
      '| Job | Run | Status | Time | Error |',
      '| --- | --- | --- | --- | --- |',
      ...this.rows,
      '',
    ].join('\n');
    try {
      appendFileSync(file, `${text}\n`);
    } catch {
      // The summary is a convenience; the log already has everything.
    }
  }
}

// GitHub workflow commands end at a newline and treat % specially.
function annotation(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function md(text: string): string {
  return text.replace(/\|/g, '\\|').slice(0, 200);
}
