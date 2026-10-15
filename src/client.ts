/**
 * The Telegram Serverless management API client on its own, for tools that
 * need `/get` and `/run` without the scheduler.
 */
export {
  ApiError,
  type ApiErrorKind,
  appIdFromToken,
  type ClientOptions,
  DEFAULT_BASE_URL,
  type Deployed,
  type FetchLike,
  type LogEntry,
  type RunResult,
  TgcloudClient,
} from './adapters/tgcloud/client.js';
