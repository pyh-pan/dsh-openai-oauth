import { setTimeout as delay } from 'node:timers/promises';

// Fixed, non-secret diagnostics. Never attach a transport cause, URL, body or token.
export const AUTH_NETWORK_MESSAGES = Object.freeze({
  AUTH_DNS_FAILED:
    'Cannot resolve auth.openai.com after bounded retries. Check DNS and network access; existing authorization was kept.',
  AUTH_CONNECT_FAILED:
    'Cannot connect to auth.openai.com after bounded retries. Check network or proxy access; existing authorization was kept.',
  AUTH_TLS_FAILED:
    'Cannot verify the TLS connection to auth.openai.com. Check the system clock and trusted network certificates; TLS verification was not bypassed.',
  AUTH_NETWORK_FAILED:
    'Cannot read OpenAI authorization metadata after bounded retries. Check network access to auth.openai.com; existing authorization was kept.',
  AUTH_NETWORK_TIMEOUT:
    'The OpenAI authorization network deadline expired. Check access to auth.openai.com; existing authorization was kept.',
  AUTH_REQUEST_UNCONFIRMED:
    'The connection to auth.openai.com ended before the authorization request was confirmed. It was not automatically replayed; check the account status in model settings.',
});

export class AuthNetworkError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const unknown = () => ({ code: 'AUTH_NETWORK_FAILED', beforeConnect: false });
function classify(error, depth = 0) {
  if (!error || depth > 4) return unknown();
  // Inspect EVERY branch before trusting any aggregate-level code. Empty,
  // oversized or mixed/unknown aggregates cannot authorize a write replay.
  if (error instanceof AggregateError) {
    if (error.errors.length === 0 || error.errors.length > 8) return unknown();
    const failures = error.errors.map((item) => classify(item, depth + 1));
    if (failures.every((item) => item.beforeConnect))
      return {
        code: failures.every((item) => item.code === 'AUTH_DNS_FAILED')
          ? 'AUTH_DNS_FAILED'
          : 'AUTH_CONNECT_FAILED',
        beforeConnect: true,
      };
    return failures.find((item) => item.code === 'AUTH_TLS_FAILED') ?? unknown();
  }
  const code = error.code;
  if (['EAI_AGAIN', 'ENOTFOUND'].includes(code))
    return { code: 'AUTH_DNS_FAILED', beforeConnect: true };
  if (['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code))
    return { code: 'AUTH_CONNECT_FAILED', beforeConnect: true };
  if (
    typeof code === 'string' &&
    (/^(?:ERR_(?:TLS|SSL)_|CERT_|CRL_|ERROR_IN_(?:CERT|CRL)_|KEYUSAGE_)/.test(code) ||
      [
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_GET_ISSUER_CERT',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'UNABLE_TO_GET_CRL',
        'UNABLE_TO_GET_CRL_ISSUER',
        'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
        'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
        'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
        'INVALID_CA',
        'INVALID_PURPOSE',
        'INVALID_EXTENSION',
        'INVALID_POLICY_EXTENSION',
        'NO_EXPLICIT_POLICY',
        'PATH_LENGTH_EXCEEDED',
        'APPLICATION_VERIFICATION',
        'CA_KEY_TOO_SMALL',
        'EE_KEY_TOO_SMALL',
        'CA_MD_TOO_WEAK',
        'HOSTNAME_MISMATCH',
        'IP_ADDRESS_MISMATCH',
        'EMAIL_MISMATCH',
      ].includes(code))
  )
    return { code: 'AUTH_TLS_FAILED', beforeConnect: false };
  if (code === undefined && error.cause) return classify(error.cause, depth + 1);
  return unknown();
}
function cancelBody(response) {
  try {
    Promise.resolve(response?.body?.cancel()).catch(() => {});
  } catch {
    /* A late response may already have released/locked its body. */
  }
}
function fetchAttempt(fetchImpl, url, options, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return fetchImpl(url, { ...options, redirect: 'error', signal });
      })
      .then(
        (response) => {
          if (settled || signal.aborted) {
            abort();
            cancelBody(response);
          } else finish(resolve, response);
        },
        (error) => finish(reject, error),
      );
  });
}

// One 12s budget (by default), including both attempts, backoff and subsequent
// response-body consumption. It remains below the SessionManager's 20s lock budget.
// GET/HEAD may be replayed once; writes only after a proven pre-connect failure.
// No automatic HTTP-status retry, TLS bypass, alternate origin or proxy override.
export async function requestAuth(fetchImpl, url, options, timeoutMs) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const readOnly = ['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase());
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchAttempt(fetchImpl, url, options, signal);
    } catch (error) {
      if (options.signal?.aborted) throw new AuthNetworkError('CANCELLED');
      if (deadline.aborted)
        throw new AuthNetworkError(readOnly ? 'AUTH_NETWORK_TIMEOUT' : 'AUTH_REQUEST_UNCONFIRMED');
      const failure = classify(error);
      if (
        attempt === 0 &&
        failure.code !== 'AUTH_TLS_FAILED' &&
        (readOnly || failure.beforeConnect)
      ) {
        try {
          await delay(100, undefined, { signal });
        } catch {
          throw new AuthNetworkError(
            options.signal?.aborted ? 'CANCELLED' : 'AUTH_NETWORK_TIMEOUT',
          );
        }
        continue;
      }
      throw new AuthNetworkError(
        readOnly || failure.beforeConnect || failure.code === 'AUTH_TLS_FAILED'
          ? failure.code
          : 'AUTH_REQUEST_UNCONFIRMED',
      );
    }
  }
}
