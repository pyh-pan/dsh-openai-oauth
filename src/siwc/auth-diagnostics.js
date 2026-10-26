// Temporary, opt-in observation of one failed token request. No raw exceptions,
// identities, URLs, headers or body bytes leave this module. Transport unchanged.
import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { AUTH_NETWORK_MESSAGES } from './auth-network.js';

const scope = new AsyncLocalStorage();
const CODES = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ABORT_ERR',
  'UND_ERR_ABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_INVALID_ARG',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_INVALID_URL',
  'ERR_STREAM_PREMATURE_CLOSE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const STAGES = [
  'not_dispatched',
  'fetch_started',
  'request_created',
  'connecting',
  'connected',
  'body_sent',
  'headers_received',
];
const KINDS = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'AggregateError',
  'DOMException',
  'AbortError',
  'TimeoutError',
]);
const enumValue = (value, choices) => (choices.includes(value) ? value : 'unknown');
const boundedNumber = (value) =>
  Number.isFinite(value) ? Math.max(0, Math.min(86400000, Math.round(value))) : 0;

function safeRecord(value) {
  if (!value || value.schema !== 1) return;
  const outcome = value.outcome;
  if (typeof outcome !== 'string' || !Object.hasOwn(AUTH_NETWORK_MESSAGES, outcome)) return;
  const transportCodes = [];
  const inputCodes = value.transportCodes;
  if (Array.isArray(inputCodes)) {
    for (let i = 0; i < Math.min(inputCodes.length, 8); i++) {
      const code = inputCodes[i];
      if (CODES.has(code) && !transportCodes.includes(code)) transportCodes.push(code);
    }
  }
  return {
    schema: 1,
    outcome,
    phase: enumValue(value.phase, ['refresh', 'code_exchange']),
    tokenState: enumValue(value.tokenState, ['expired', 'unexpired']),
    stage: enumValue(value.stage, STAGES),
    elapsedMs: boundedNumber(value.elapsedMs),
    budgetMs: boundedNumber(value.budgetMs),
    attempts: Math.min(2, boundedNumber(value.attempts)),
    timeout: value.timeout === true,
    errorKind: KINDS.has(value.errorKind) ? value.errorKind : 'unknown',
    transportCodes,
    proxy: Object.fromEntries(
      ['http', 'https', 'all', 'node'].map((key) => [key, value.proxy?.[key] === true]),
    ),
  };
}

// Validate again at the message boundary: never stringify a caller's object.
export function formatAuthDiagnostic(value) {
  try {
    const record = safeRecord(value);
    return record
      ? `[SIWC-AUTH-DIAG first-failure] ${JSON.stringify(record)} [/SIWC-AUTH-DIAG]`
      : '';
  } catch {
    return '';
  }
}

export function observeAuthRequest(fetchImpl, url, context = {}, { env = process.env } = {}) {
  let expected;
  try {
    expected = new URL(url);
  } catch {
    /* An invalid URL still goes to fetch unchanged; stage events are optional. */
  }
  const marker = Symbol('siwc-auth-observation');
  const requests = new WeakMap();
  const bindings = [];
  const transportCodes = new Set();
  const started = performance.now();
  let attempts = 0,
    stage = 'not_dispatched',
    signal,
    errorKind = 'unknown';
  const current = () => {
    const active = scope.getStore();
    return active?.marker === marker && active.attempt === attempts;
  };
  const advance = (next) => {
    if (STAGES.indexOf(next) > STAGES.indexOf(stage)) stage = next;
  };
  const noteError = (error, depth = 0, seen = new Set()) => {
    try {
      if (!error || depth > 4 || seen.has(error)) return;
      seen.add(error);
      if (KINDS.has(error.name)) errorKind = error.name;
      if (CODES.has(error.code) && transportCodes.size < 8) transportCodes.add(error.code);
      if (error instanceof AggregateError)
        for (const branch of error.errors.slice(0, 8)) noteError(branch, depth + 1, seen);
      noteError(error.cause, depth + 1, seen);
    } catch {
      /* Ignore malformed errors without changing their propagation. */
    }
  };
  const listen = (name, callback) => {
    const safe = (message) => {
      try {
        callback(message);
      } catch {
        /* Diagnostics must never fail a request. */
      }
    };
    subscribe(name, safe);
    bindings.push([name, safe]);
  };
  listen('undici:request:create', ({ request }) => {
    if (
      current() &&
      expected &&
      request?.origin === expected.origin &&
      request.path === expected.pathname &&
      request.method === 'POST'
    ) {
      requests.set(request, attempts);
      advance('request_created');
    }
  });
  for (const [name, next] of [
    ['undici:client:beforeConnect', 'connecting'],
    ['undici:client:connected', 'connected'],
  ])
    listen(name, () => {
      if (current()) advance(next);
    });
  listen('undici:client:connectError', ({ error }) => {
    if (current()) noteError(error);
  });
  for (const [name, next] of [
    ['undici:request:bodySent', 'body_sent'],
    ['undici:request:headers', 'headers_received'],
  ])
    listen(name, ({ request }) => {
      if (requests.get(request) === attempts) advance(next);
    });
  listen('undici:request:error', ({ request, error }) => {
    if (requests.get(request) === attempts) noteError(error);
  });

  return {
    fetch(requestUrl, options) {
      attempts++;
      stage = 'fetch_started';
      signal = options.signal;
      return scope.run({ marker, attempt: attempts }, async () => {
        try {
          return await fetchImpl(requestUrl, options);
        } catch (error) {
          noteError(error);
          throw error;
        }
      });
    },
    snapshot(outcome, budgetMs) {
      const record = safeRecord({
        schema: 1,
        outcome,
        phase: context?.phase,
        tokenState: context?.tokenState,
        stage,
        elapsedMs: performance.now() - started,
        budgetMs,
        attempts,
        errorKind,
        transportCodes: [...transportCodes],
        timeout: signal?.aborted === true && signal.reason?.name === 'TimeoutError',
        proxy: {
          http: Boolean(env.http_proxy || env.HTTP_PROXY),
          https: Boolean(env.https_proxy || env.HTTPS_PROXY),
          all: Boolean(env.all_proxy || env.ALL_PROXY),
          node: Boolean(env.NODE_USE_ENV_PROXY),
        },
      });
      if (!record) return;
      Object.freeze(record.transportCodes);
      Object.freeze(record.proxy);
      return Object.freeze(record);
    },
    dispose() {
      for (const [name, callback] of bindings.splice(0)) unsubscribe(name, callback);
    },
  };
}
