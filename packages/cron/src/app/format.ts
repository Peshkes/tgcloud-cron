import { clean } from 'tgcloud-api';
import type { RunEvent } from './ports.js';

const LEVEL_LABEL = { log: 'log', dbg: 'debug', inf: 'info', wrn: 'warn', err: 'error' } as const;
const MAX_VALUE_CHARS = 300;

/** Human-readable lines for one event. Every line carries the job and run id. */
export function formatEvent(event: RunEvent): string[] {
  const prefix = `[${event.job} ${event.runId}]`;
  switch (event.type) {
    case 'start': {
      const when = event.scheduledAt ? `scheduled ${event.scheduledAt}` : 'manual run';
      const code =
        event.code === 'local'
          ? 'local code'
          : `deployed code${event.revision !== undefined ? `, revision ${event.revision}` : ''}`;
      return [`${prefix} start   ${when}, ${code}`];
    }
    case 'log': {
      const e = event.entry;
      const meta = [`+${Math.round(e.t * 1000)}ms`, e.origin ? `[${e.origin}]` : '']
        .filter(Boolean)
        .join('  ');
      const label = LEVEL_LABEL[e.level].padEnd(5);
      return indent(
        `${e.message}${e.truncated ? ' [truncated]' : ''}`,
        `${prefix}   ${label} `,
        meta,
      );
    }
    case 'progress':
      return [`${prefix}   ${event.message}`];
    case 'end': {
      const timing = [
        event.platformTime !== undefined
          ? `platform ${Math.round(event.platformTime * 1000)}ms`
          : '',
        `total ${(event.durationMs / 1000).toFixed(2)}s`,
      ]
        .filter(Boolean)
        .join(', ');
      if (event.ok) {
        // The value comes from job code: every line keeps the prefix, so a
        // returned string cannot start a GitHub workflow command.
        if (event.value === undefined) return [`${prefix} ok      ${timing}`];
        return indent(formatValue(event.value), `${prefix} ok      `, timing);
      }
      return indent(event.error ?? 'failed', `${prefix} FAILED  `, timing);
    }
  }
}

// Continuation lines keep the prefix so `grep <job>` shows the whole message.
function indent(text: string, head: string, tail: string): string[] {
  const lines = text.split('\n');
  const pad = `${head.slice(0, head.indexOf(']') + 1)}${' '.repeat(head.length - head.indexOf(']') - 1)}`;
  return lines.map((line, i) => {
    const start = i === 0 ? head : pad;
    const end = i === lines.length - 1 && tail ? `  ${tail}` : '';
    return `${start}${line}${end}`;
  });
}

export function formatValue(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  text = clean(text);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}...` : text;
}

/** One JSON object per event, for log processors. */
export function formatEventJson(event: RunEvent, at: Date): string {
  return JSON.stringify({ ts: at.toISOString(), ...event });
}
