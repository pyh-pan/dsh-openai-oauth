import { randomUUID } from 'node:crypto';

// Pure policy/config factories: importing this module never loads a Host peer,
// reads settings/credentials, or starts a request. The host is the retry owner.
export const MAX_TIMER_MS = 2 ** 31 - 1;
export const DEFAULT_REQUEST_POLICY = Object.freeze({
  responseHeadersTimeoutMs: 60000,
  streamIdleTimeoutMs: 120000,
  // Deliberately measured from Response arrival, not from model-step start.
  streamTotalTimeoutMs: 30 * 60000,
  catalogTimeoutMs: 15000,
  maxRetries: 5,
  timing: false,
});
export const NORMAL_RETRY_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
]);
const keys = Object.keys(DEFAULT_REQUEST_POLICY);
const object = (value) =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const invalid = () => {
  // Never echo a supplied value or key in the activation diagnostic.
  throw new TypeError('SIWC_REQUEST_POLICY_INVALID');
};
export function normalizeRequestPolicy(value = {}) {
  if (!object(value) || Reflect.ownKeys(value).some((key) => !keys.includes(key))) invalid();
  const policy = { ...DEFAULT_REQUEST_POLICY, ...value };
  for (const key of keys.filter((key) => key.endsWith('TimeoutMs')))
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1 || policy[key] > MAX_TIMER_MS)
      invalid();
  if (!Number.isSafeInteger(policy.maxRetries) || policy.maxRetries < 0 || policy.maxRetries > 5)
    invalid();
  if (typeof policy.timing !== 'boolean') invalid();
  // Raising one attempt's headers budget must explicitly reduce retries. This
  // bounds headers-only waiting to the old 60s * 6 attempts, NOT an end-to-end
  // step deadline: auth/catalog/backoff/streaming still have separate clocks.
  if (
    policy.responseHeadersTimeoutMs > DEFAULT_REQUEST_POLICY.responseHeadersTimeoutMs &&
    (!Object.hasOwn(value, 'maxRetries') ||
      policy.maxRetries > 1 ||
      policy.responseHeadersTimeoutMs * (policy.maxRetries + 1) > 360000)
  )
    invalid();
  return Object.freeze(policy);
}
export function normalizePluginConfig(value = {}) {
  if (!object(value) || Reflect.ownKeys(value).some((key) => key !== 'requestPolicy')) invalid();
  return { requestPolicy: normalizeRequestPolicy(value.requestPolicy) };
}
export function resolvedRetryPolicy(policy) {
  return {
    mode: 'normal',
    maxRetries: policy.maxRetries,
    retryableCodes: [...NORMAL_RETRY_CODES],
    initialDelayMs: 500,
    maxDelayMs: 10000,
    jitterRatio: 0.1,
  };
}

const TIMING_STAGES = new Set([
  'request-built',
  'fetch-start',
  'response-headers',
  'first-sse',
  'first-content',
  'response-headers-timeout',
  'stream-total-timeout',
  'stream-idle-timeout',
  'error-body-timeout',
  'terminal',
]);
const TIMING_CODES = new Set([
  ...NORMAL_RETRY_CODES,
  'ABORTED',
  'PLUGIN_DISPOSED',
  'ACCOUNT_CHANGED',
  'ACCOUNT_SIGNED_OUT',
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_REAUTH_REQUIRED',
  'DIRECT_PERMISSION_MISSING',
  'NO_ADAPTER',
  'UNKNOWN_MODEL',
  'MODEL_CATALOG_INVALID',
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'INVALID_STREAM',
  'INVALID_SESSION_CONTEXT',
  'INVALID_TOOL_HISTORY',
  'STREAM_IDLE_TIMEOUT',
  'STREAM_CLOSED',
  'STREAM_EVENT_TOO_LARGE',
  'STREAM_TOO_LARGE',
  'RESPONSE_TOO_LARGE',
  'RESPONSE_INCOMPLETE',
  'UNSUPPORTED_MAX_TOKENS',
  'UNSUPPORTED_TEMPERATURE',
  'UNSUPPORTED_OPTION',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_OUTPUT',
  'UNSUPPORTED_TOOL_NAMESPACE',
  'AUTH',
  'CHATGPT_NOT_ELIGIBLE',
  'CHATGPT_ROUTE_UNSUPPORTED',
  'CHATGPT_PERMISSION',
  'QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'STOP',
  'TOOL_CALLS',
  'MAX_TOKENS',
  'CONSUMER_RETURN',
  'SIWC_SESSION_COVERAGE_UNAVAILABLE',
  'SIWC_PRESET_REVISION_MISMATCH',
  'SIWC_COMPACTION_NOT_COVERED',
  'SIWC_COMPACTION_REQUIRED',
  'DSH_SIWC_COMPACTION_SAFETY_MISSING',
]);
const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
];
export function createTimingTrace(policy, logger, now = () => performance.now()) {
  if (!policy.timing) return undefined;
  const callId = randomUUID();
  const started = now();
  const seen = new Set();
  return (stage, { requestBytes, usage, code } = {}) => {
    if (!TIMING_STAGES.has(stage) || seen.has(stage)) return;
    seen.add(stage);
    try {
      const elapsed = now() - started;
      const event = {
        callId,
        stage,
        elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed * 1000) / 1000) : 0,
        ...(Number.isSafeInteger(requestBytes) && requestBytes >= 0 ? { requestBytes } : {}),
        ...(usage
          ? {
              usage: Object.fromEntries(
                USAGE_KEYS.filter((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0).map(
                  (key) => [key, usage[key]],
                ),
              ),
            }
          : {}),
        ...(code !== undefined ? { code: TIMING_CODES.has(code) ? code : 'OTHER' } : {}),
        effectivePolicy: { ...policy },
      };
      // One fixed string argument avoids accidental structured logger expansion.
      // Logging (including throwing/rejecting custom loggers) is never inference.
      const result = logger?.info?.(`SIWC_TIMING ${JSON.stringify(event)}`);
      Promise.resolve(result).catch(() => {});
    } catch {
      /* Opt-in diagnostics must not change a model call's outcome. */
    }
  };
}

// Schema is supplied by index.js from the installed runtime's public peer.
// Keep validation ahead of the descriptive object branch. The optional Schema
// can pass a root null through unchanged; apply/normalizePluginConfig(null)
// still rejects it before runtime creation. Config({}) selects the defaults.
// Do not make the root required: the default bundle omits config entirely.
// The object half keeps every public field discoverable by Config inspection.
export function createPluginConfig(Schema) {
  return Schema.intersect([
    Schema.transform(Schema.any(), normalizePluginConfig),
    Schema.object({
      requestPolicy: Schema.object({
        responseHeadersTimeoutMs: Schema.number()
          .default(60000)
          .description(
            'Response headers timeout in ms (default 60000). Positive integer <= 2147483647. Above 60000 requires explicit maxRetries <= 1 and headers * (1 + maxRetries) <= 360000; not a model-step deadline.',
          ),
        streamIdleTimeoutMs: Schema.number()
          .default(120000)
          .description(
            'SSE read idle timeout in ms (default 120000). Positive integer <= 2147483647.',
          ),
        streamTotalTimeoutMs: Schema.number()
          .default(1800000)
          .description(
            'Stream total timeout in ms FROM RESPONSE HEADERS (default 1800000). Positive integer <= 2147483647; excludes earlier phases and host retry backoff.',
          ),
        catalogTimeoutMs: Schema.number()
          .default(15000)
          .description(
            'Catalog request and body timeout in ms (default 15000). Positive integer <= 2147483647.',
          ),
        maxRetries: Schema.number()
          .default(5)
          .description(
            'Host-owned additional retries, integer 0..5 (default 5), normal mode only. Direct llm.stream calls remain single-attempt. Lifecycle and deterministic parameter failures are not retryable.',
          ),
        timing: Schema.boolean()
          .default(false)
          .description(
            'Opt in to allowlisted local timing JSON (default false): random callId, stages, elapsed ms, request bytes, numeric usage, effective policy and safe outcome code only. No account/session/content/headers/replay identifiers.',
          ),
      }).default({}),
    }),
  ]);
}
