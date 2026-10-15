/**
 * Cloudflare Worker entry. `tgcron generate cloudflare` writes a worker.js
 * that imports this module; Wrangler bundles it.
 */
import { DEFAULT_BASE_URL, TgcloudClient } from './adapters/tgcloud/client.js';
import { formatEvent } from './app/format.js';
import { runTick } from './app/run.js';
import { formatProblems, validateConfig } from './core/config.js';

export interface WorkerEnv {
  readonly TGCLOUD_TOKEN?: string;
  readonly TG_CLOUD_API_URL?: string;
}

export interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}

export function createScheduledHandler(options: { jobs: unknown }) {
  const parsed = validateConfig({ jobs: options.jobs });
  if (!parsed.ok) {
    throw new Error(`tgcloud-cron: invalid job table\n${formatProblems(parsed.problems)}`);
  }
  const config = parsed.config;

  return async (controller: ScheduledController, env: WorkerEnv): Promise<void> => {
    if (!env.TGCLOUD_TOKEN) {
      throw new Error(
        'tgcloud-cron: TGCLOUD_TOKEN is not set; run `npx wrangler secret put TGCLOUD_TOKEN`',
      );
    }
    const platform = new TgcloudClient({
      token: env.TGCLOUD_TOKEN,
      baseUrl: env.TG_CLOUD_API_URL || DEFAULT_BASE_URL,
      fetch: (url, init) => fetch(url, init),
    });

    const result = await runTick(
      config,
      controller.cron,
      {
        platform,
        emit: (event) => {
          for (const line of formatEvent(event)) console.log(line);
        },
        now: () => new Date(),
        newRunId: () => crypto.randomUUID().slice(0, 8),
      },
      new Date(controller.scheduledTime),
    );

    if (result.outcomes.length === 0 && !result.fatal) {
      console.log(`tgcloud-cron: no enabled job has schedule "${controller.cron}"`);
    }
    // Throwing marks the invocation as failed in the Cloudflare dashboard.
    if (result.fatal) throw new Error(`tgcloud-cron: ${result.fatal.message}`);
    const failed = result.outcomes.filter((o) => !o.ok).map((o) => o.job);
    if (failed.length > 0) throw new Error(`tgcloud-cron: failed jobs: ${failed.join(', ')}`);
  };
}
