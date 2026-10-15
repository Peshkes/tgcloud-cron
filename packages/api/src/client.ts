/**
 * Client for the Telegram Serverless management API.
 *
 * The API is not documented. Everything here mirrors `@tgcloud/cli` 0.2.0
 * (`src/api/client.js`, `src/api/endpoints.js`), the only reference for it:
 *
 *   base     https://cloud.telegram.org/app<id>/manage
 *   auth     Authorization: Bearer app<id>:<secret>
 *   success  { ok: true, result }
 *   failure  { ok: false, description, error_code, error_type?, parameters? }
 *
 * The client takes `fetch` as a parameter so it runs unchanged in Node and in
 * a Cloudflare Worker, and so tests can replay recorded responses.
 */

export const DEFAULT_BASE_URL = 'https://cloud.telegram.org';

/**
 * The base URL the official CLI would use: `TG_CLOUD_API_URL` overrides the
 * default, and `TGCLOUD_BETA=1` appends `/beta`.
 */
export function baseUrlFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  const base = (env.TG_CLOUD_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return env.TGCLOUD_BETA === '1' ? `${base}/beta` : base;
}

const TOKEN_FORMAT = /^(app\d+):[A-Za-z0-9_-]+$/;

export interface FetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

export interface ClientOptions {
  /** CLI access token, `app<id>:<secret>`. */
  readonly token: string;
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  /** Per-request timeout. Default 60 s. */
  readonly timeoutMs?: number;
  /** Retries for transient failures (see `retryable`). Default 3. */
  readonly maxRetries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type ApiErrorKind =
  /** 401 or 403: the token is wrong or revoked. */
  | 'auth'
  /** 429. */
  | 'rate_limit'
  /** 5xx. */
  | 'server'
  /** No HTTP response: DNS, connection, timeout. */
  | 'network'
  /** The server rejected the request or the code failed (other 4xx, `ok: false`). */
  | 'request'
  /** The response was not the expected envelope. */
  | 'protocol';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status: number | undefined,
    readonly details: {
      readonly code?: number | string;
      readonly type?: string;
      readonly parameters?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
  }

  get transient(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'server' || this.kind === 'network';
  }
}

export type LogLevel = 'log' | 'dbg' | 'inf' | 'wrn' | 'err';

export interface LogEntry {
  readonly level: LogLevel;
  /** Seconds since the run started. */
  readonly t: number;
  readonly message: string;
  /** The platform cut the message short. */
  readonly truncated: boolean;
  /** `module:line`, when the platform reports it. */
  readonly origin?: string;
}

export interface RunSuccess {
  readonly ok: true;
  readonly value: unknown;
  readonly logs: readonly LogEntry[];
  /** Platform-side execution time in seconds, if reported. */
  readonly time?: number;
}

export interface RunFailure {
  readonly ok: false;
  readonly error: ApiError;
  readonly logs: readonly LogEntry[];
  readonly time?: number;
}

export type RunResult = RunSuccess | RunFailure;

/**
 * What tools need from the management API. `TgcloudClient` implements it;
 * tests and other transports can too.
 */
export interface Platform {
  readonly appId: string;
  getDeployed(): Promise<Deployed>;
  run(
    module: string,
    sources: Readonly<Record<string, string>>,
    args: Record<string, unknown>,
    options?: { ctx?: Record<string, unknown>; idempotent?: boolean },
  ): Promise<RunResult>;
}

export interface Deployed {
  readonly revision: number;
  /** `{ "lib/cart": "<source>" }`, module names without `.js`. */
  readonly modules: Readonly<Record<string, string>>;
}

/** The public half of a token, safe to print. Throws without echoing the token. */
export function appIdFromToken(token: string): string {
  const match = TOKEN_FORMAT.exec(token);
  if (!match) {
    throw new ApiError(
      'auth',
      'TGCLOUD_TOKEN has an invalid format; expected "app<id>:<secret>"',
      undefined,
    );
  }
  return match[1] as string;
}

export class TgcloudClient implements Platform {
  readonly appId: string;
  private readonly token: string;
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions) {
    this.appId = appIdFromToken(options.token);
    this.token = options.token;
    this.fetch = options.fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Deployed revision and module sources (`GET /get`). */
  async getDeployed(): Promise<Deployed> {
    const result = await this.call('GET', '/get', undefined, () => true);
    if (!isObject(result) || !isObject(result.canonical_modules)) {
      throw new ApiError('protocol', 'GET /get: response has no canonical_modules', 200);
    }
    const modules: Record<string, string> = {};
    for (const [name, source] of Object.entries(result.canonical_modules)) {
      if (typeof source === 'string') modules[name] = source;
    }
    return { revision: typeof result.revision === 'number' ? result.revision : 0, modules };
  }

  /**
   * Run `module` from the given module space (`POST /run`). Nothing is
   * deployed and the deployed state is not consulted.
   *
   * A job failure is returned, not thrown, together with the logs the
   * platform captured. Auth, network and protocol errors are thrown.
   *
   * By default only 429 is retried: any other failure may arrive after the
   * job has already run, and running it twice can send messages twice. Pass
   * `idempotent: true` for read-only code to retry every transient error.
   */
  async run(
    module: string,
    sources: Readonly<Record<string, string>>,
    args: Record<string, unknown>,
    options: { ctx?: Record<string, unknown>; idempotent?: boolean } = {},
  ): Promise<RunResult> {
    let result: unknown;
    try {
      result = await this.call(
        'POST',
        '/run',
        { module, sources, args, ctx: options.ctx ?? {} },
        (err) => options.idempotent === true || err.kind === 'rate_limit',
      );
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'request') {
        const p = err.details.parameters ?? {};
        return { ok: false, error: err, logs: parseLogs(p.log), ...timeOf(p.time) };
      }
      throw err;
    }

    if (!isObject(result)) {
      throw new ApiError('protocol', 'POST /run: result is not an object', 200);
    }
    const logs = parseLogs(result.log);
    const value = result.result;
    // The official CLI renders `{ __error, message }` as a failure, so the
    // platform can report an exception inside a successful envelope.
    if (isObject(value) && value.__error) {
      const message = typeof value.message === 'string' ? clean(value.message) : 'job threw';
      return {
        ok: false,
        error: new ApiError('request', message, 200),
        logs,
        ...timeOf(result.time),
      };
    }
    return { ok: true, value, logs, ...timeOf(result.time) };
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    retryable: (err: ApiError) => boolean,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, path, body);
      } catch (err) {
        if (!(err instanceof ApiError) || !err.transient || !retryable(err)) throw err;
        if (attempt >= this.maxRetries) throw err;
        await this.sleep(backoffMs(err, attempt));
      }
    }
  }

  private async once(method: string, path: string, body: unknown): Promise<unknown> {
    const url = `${this.baseUrl}/${this.appId}/manage${path}`;
    const init: Parameters<FetchLike>[1] = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: FetchResponse;
    let text: string;
    try {
      res = await this.fetch(url, init);
      text = await res.text();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApiError(
        'network',
        `${method} ${path}: cannot reach ${this.baseUrl}: ${clean(reason)}`,
        undefined,
      );
    }
    return parseEnvelope(method, path, res.status, text);
  }
}

function parseEnvelope(method: string, path: string, status: number, text: string): unknown {
  const where = `${method} ${path}`;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(
      kindForStatus(status) ?? 'protocol',
      `${where}: HTTP ${status}, response is not JSON`,
      status,
    );
  }
  if (!isObject(data) || typeof data.ok !== 'boolean') {
    throw new ApiError(
      kindForStatus(status) ?? 'protocol',
      `${where}: HTTP ${status}, unexpected response shape`,
      status,
    );
  }
  if (data.ok) return data.result;

  const description =
    typeof data.description === 'string'
      ? clean(data.description)
      : `server error (HTTP ${status})`;
  const details: { code?: number | string; type?: string; parameters?: Record<string, unknown> } =
    {};
  const code = data.error_code ?? data.error;
  if (typeof code === 'number' || typeof code === 'string') details.code = code;
  if (typeof data.error_type === 'string') details.type = data.error_type;
  if (isObject(data.parameters)) details.parameters = data.parameters;
  throw new ApiError(kindForStatus(status) ?? 'request', description, status, details);
}

function kindForStatus(status: number): ApiErrorKind | undefined {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return undefined;
}

function backoffMs(err: ApiError, attempt: number): number {
  const retryAfter = err.details.parameters?.retry_after;
  if (typeof retryAfter === 'number' && retryAfter > 0 && retryAfter <= 60)
    return retryAfter * 1000;
  return 1000 * 2 ** attempt;
}

function parseLogs(raw: unknown): LogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: LogEntry[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const truncated = entry.M != null;
    const message = truncated ? entry.M : entry.m;
    const item: LogEntry = {
      level: isLevel(entry._) ? entry._ : 'log',
      t: typeof entry.t === 'number' ? entry.t : 0,
      message: clean(typeof message === 'string' ? message : JSON.stringify(message ?? '')),
      truncated,
    };
    const origin = parseOrigin(entry.o);
    out.push(origin ? { ...item, origin } : item);
  }
  return out;
}

function parseOrigin(o: unknown): string | undefined {
  if (typeof o === 'string') return clean(o);
  if (isObject(o)) {
    const module = o.m ?? o.module;
    const line = o.l ?? o.line;
    if (module != null && line != null) return clean(`${module}:${line}`);
    if (module != null) return clean(String(module));
  }
  return undefined;
}

function isLevel(v: unknown): v is LogLevel {
  return v === 'log' || v === 'dbg' || v === 'inf' || v === 'wrn' || v === 'err';
}

function timeOf(t: unknown): { time?: number } {
  return typeof t === 'number' ? { time: t } : {};
}

/**
 * Removes control characters from server text so a response cannot inject
 * terminal escape sequences. Tabs and newlines are kept; the logger prefixes
 * every line, so a newline cannot forge a log line of its own.
 */
export function clean(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return s.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
