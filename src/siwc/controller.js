import { OAuthAttempt } from './oauth.js';
import { SiwcError, reject, safeCode } from './protocol.js';

export const API_PATH = '/api/local-chatgpt-source';
export const PROVIDER = 'chatgpt-subscription';
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
const activePhase = (phase) => ['starting', 'waiting', 'verifying'].includes(phase);

export class SiwcController {
  #starting = false;
  #closed = false;
  #current;
  constructor(
    { accounts, protocol, sessions, onSelection, readNotice, readCoverage },
    options = {},
  ) {
    Object.assign(this, { accounts, protocol, sessions, onSelection, readNotice, readCoverage });
    this.options = options;
  }
  #assertOpen() {
    if (this.#closed) reject('PLUGIN_DISPOSED', 409);
  }
  async snapshot() {
    this.#assertOpen();
    return {
      provider: PROVIDER,
      protocol: 'siwc',
      usageUrl: USAGE_URL,
      accounts: await this.accounts.accounts(),
      selection: await this.accounts.selection(),
      attempt: this.#current?.status ?? null,
      notice: this.readNotice?.() ?? null,
      ...(this.readCoverage ? { coverage: await this.readCoverage() } : {}),
      // Never serialize the AccountStore or the protocol instance.
    };
  }
  async start(key, enablePlanUsage = false) {
    this.#assertOpen();
    if (this.#starting || activePhase(this.#current?.status.phase)) reject('AUTH_BUSY', 409);
    this.#starting = true;
    try {
      const hostId = await this.accounts.hostId();
      const registration = key === undefined ? undefined : await this.accounts.registration(key);
      this.#assertOpen();
      const attempt = new OAuthAttempt(this.protocol, {
        hostId,
        registration,
        ...this.options,
        enablePlanUsage: enablePlanUsage === true,
        onIssued: (clientId, signal) => {
          this.#assertOpen();
          return this.accounts.beginRegistration(clientId, signal);
        },
        onAuthorized: (grant, signal) => {
          this.#assertOpen();
          return this.accounts.saveValidated(grant, signal);
        },
      });
      this.#current = attempt;
      await attempt.start();
      return await this.snapshot();
    } finally {
      this.#starting = false;
    }
  }
  cancel(id) {
    this.#assertOpen();
    if (typeof id !== 'string' || this.#current?.id !== id) reject('ATTEMPT_NOT_FOUND', 404);
    this.#current.cancel();
  }
  async select(key) {
    this.#assertOpen();
    const selection = await this.accounts.select(key);
    await this.onSelection?.(selection);
  }
  async logout(key) {
    this.#assertOpen();
    if (this.#starting || activePhase(this.#current?.status.phase)) reject('AUTH_BUSY', 409);
    if (!this.sessions) reject('SESSION_SERVICE_UNAVAILABLE', 503);
    return this.sessions.logout(key);
  }
  dispose() {
    this.#closed = true;
    this.#current?.dispose();
  }
}

async function readBody(request) {
  if (
    request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !==
    'application/json'
  )
    reject('JSON_REQUIRED', 415);
  const reader = request.body?.getReader();
  if (!reader) reject('INVALID_REQUEST');
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        reject('REQUEST_TOO_LARGE', 413);
      }
      parts.push(Buffer.from(value));
    }
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) reject('INVALID_REQUEST');
    return body;
  } catch (error) {
    if (error instanceof SiwcError) throw error;
    reject('INVALID_REQUEST');
  } finally {
    reader.releaseLock();
  }
}

// This handler MUST be mounted under the authenticated native Connection carrier.
// It never binds an unauthenticated management API. The only anonymous listener
// is the state-bound, temporary HTTP loopback OAuth callback.
export function createSiwcHandler(controller) {
  const json = (body, status = 200) =>
    Response.json(body, {
      status,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  return async (request) => {
    try {
      if (request.method === 'GET') return json(await controller.snapshot());
      if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
      const body = await readBody(request);
      switch (body.action) {
        case 'start':
          return json(await controller.start(body.key, body.enablePlanUsage === true));
        case 'cancel':
          controller.cancel(body.attemptId);
          break;
        case 'select':
          await controller.select(body.key);
          break;
        case 'acknowledge':
          await controller.accounts.acknowledgeWelcome(body.key);
          break;
        case 'logout': {
          const result = await controller.logout(body.key);
          return json({ ...(await controller.snapshot()), logout: result });
        }
        default:
          reject('INVALID_ACTION');
      }
      return json(await controller.snapshot());
    } catch (error) {
      return json({ error: safeCode(error) }, error instanceof SiwcError ? error.status : 500);
    }
  };
}
