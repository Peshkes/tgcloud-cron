import type { Deployed, RunResult } from '../../src/adapters/tgcloud/client.js';
import type { BackupSink, Deps, Platform, RunEvent } from '../../src/app/ports.js';

export interface RunCall {
  module: string;
  sources: Readonly<Record<string, string>>;
  args: Record<string, unknown>;
  idempotent: boolean;
}

export class FakePlatform implements Platform {
  readonly appId = 'app123';
  readonly runs: RunCall[] = [];
  getCalls = 0;

  constructor(
    readonly deployed: Deployed,
    private readonly respond: (call: RunCall) => RunResult | Promise<RunResult>,
  ) {}

  async getDeployed(): Promise<Deployed> {
    this.getCalls++;
    return this.deployed;
  }

  async run(
    module: string,
    sources: Readonly<Record<string, string>>,
    args: Record<string, unknown>,
    options: { idempotent?: boolean } = {},
  ): Promise<RunResult> {
    const call = { module, sources, args, idempotent: options.idempotent === true };
    this.runs.push(call);
    return this.respond(call);
  }
}

export class MemorySink implements BackupSink {
  readonly location = 'mem://backup';
  readonly files = new Map<string, string>();
  open(path: string) {
    let text = '';
    return {
      append: async (chunk: string) => {
        text += chunk;
      },
      close: async () => {
        this.files.set(path, text);
        return { bytes: text.length, sha256: `sha-of-${path}` };
      },
    };
  }
}

export function deps(platform: Platform, extra: Partial<Deps> = {}): Deps & { events: RunEvent[] } {
  const events: RunEvent[] = [];
  let id = 0;
  let clock = Date.parse('2026-10-16T09:00:00Z');
  return {
    platform,
    emit: (e) => events.push(e),
    now: () => {
      clock += 250;
      return new Date(clock);
    },
    newRunId: () => `r${++id}`,
    events,
    ...extra,
  };
}
