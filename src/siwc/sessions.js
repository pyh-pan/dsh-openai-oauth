import { DIRECT_SCOPE, SiwcError, reject, safeCode } from './protocol.js';
import { SELECTION_KEY } from './accounts.js';

const payload = (value) =>
  value?.kind === 'grant' && value.payload?.schema === 1 ? value.payload : undefined;
const record = (value) => ({ kind: 'grant', payload: value });
const same = (a, b) => a?.key === b?.key && a?.generation === b?.generation;
const ensureNotAborted = (signal) => {
  if (signal?.aborted) throw signal.reason ?? new SiwcError('CANCELLED');
};
function cleared(account, status, now) {
  // Preserve the verified registration/label, never a stale ID-token hint.
  return Object.fromEntries(
    Object.entries({
      schema: 1,
      clientId: account.clientId,
      issuer: account.issuer,
      subject: account.subject,
      email: account.email,
      displayName: account.displayName,
      createdAt: account.createdAt,
      updatedAt: now,
      welcomeSeen: account.welcomeSeen,
      status,
      scopes: [],
    }).filter(([, value]) => value !== undefined),
  );
}

export class SessionManager {
  #accounts;
  #protocol;
  #closed = false;
  #requests = new Map();
  #transactions = new Set();
  #loggingOut = new Set();
  #blocked = new Map();
  constructor({
    accounts,
    protocol,
    now = Date.now,
    refreshMarginMs = 60000,
    maintenanceTimeoutMs = 20000,
    revokeBackoffMs = 250,
  }) {
    this.#accounts = accounts;
    this.#protocol = protocol;
    this.now = now;
    this.refreshMarginMs = refreshMarginMs;
    this.maintenanceTimeoutMs = maintenanceTimeoutMs;
    this.revokeBackoffMs = revokeBackoffMs;
  }
  #open(key) {
    if (this.#closed) reject('PLUGIN_DISPOSED', 409);
    if (this.#loggingOut.has(key)) reject('ACCOUNT_SIGNED_OUT', 401);
    if (this.#blocked.has(key)) reject(this.#blocked.get(key), 401);
  }
  #track(promise) {
    this.#transactions.add(promise);
    promise.then(
      () => this.#transactions.delete(promise),
      () => this.#transactions.delete(promise),
    );
    return promise;
  }
  #cancel(key, code) {
    this.#requests.get(key)?.abort.abort(new SiwcError(code));
    this.#requests.delete(key);
  }
  selectionChanged(selection) {
    for (const [key, current] of this.#requests)
      if (!selection || key !== selection.key || current.generation !== selection.generation)
        this.#cancel(key, 'ACCOUNT_CHANGED');
  }
  async accountChanged(key) {
    try {
      const account = await this.#accounts.registration(key);
      if (
        account.status !== 'authorized' ||
        !account.accessToken ||
        !account.scopes?.includes(DIRECT_SCOPE)
      ) {
        this.#cancel(
          key,
          account.status === 'disabled' ? 'DIRECT_PERMISSION_MISSING' : 'ACCOUNT_REAUTH_REQUIRED',
        );
      } else this.#blocked.delete(key);
    } catch {
      this.#cancel(key, 'ACCOUNT_REAUTH_REQUIRED');
    }
  }
  access(key, options = {}) {
    return this.#track(this.#access(key, options));
  }
  async #access(key, { signal, selection, forceRefresh = false } = {}) {
    this.#open(key);
    ensureNotAborted(signal);
    // This also validates the namespace/key, without reading any other provider.
    await this.#accounts.registration(key);
    const selected = await this.#accounts.selection();
    if (selected?.key !== key || (selection && !same(selected, selection)))
      reject('ACCOUNT_CHANGED', 409);
    let terminalError;
    const transaction = this.#accounts.credentials.modifyRecord(key, async (current) => {
      this.#open(key);
      ensureNotAborted(signal);
      const account = payload(current);
      if (!account || account.status !== 'authorized' || !account.accessToken)
        reject(
          account?.status === 'disabled' ? 'DIRECT_PERMISSION_MISSING' : 'ACCOUNT_REAUTH_REQUIRED',
          401,
        );
      if (!account.scopes?.includes(DIRECT_SCOPE)) reject('DIRECT_PERMISSION_MISSING', 403);
      if (!forceRefresh && account.expiresAt > this.now() + this.refreshMarginMs) return undefined;
      if (!account.refreshToken) {
        terminalError = new SiwcError('ACCOUNT_REAUTH_REQUIRED', 401);
        return record(cleared(account, 'reauth-required', this.now()));
      }
      // This callback runs under credentials-local's cross-process writer lock,
      // after its reload. Do not tie a rotating-token transaction to a caller's
      // inference cancellation: finish and persist it, then honor cancellation.
      // Total maintenance deadline < native 30s lock wait, including JWKS fetch.
      const deadline = AbortSignal.timeout(this.maintenanceTimeoutMs);
      try {
        const refreshed = await this.#protocol.refresh(account, deadline);
        const updated = {
          ...refreshed,
          schema: 1,
          status: refreshed.scopes.includes(DIRECT_SCOPE) ? 'authorized' : 'disabled',
          updatedAt: this.now(),
        };
        return record(updated);
      } catch (error) {
        if (['INVALID_GRANT', 'REFRESH_TOKEN_INVALID'].includes(safeCode(error))) {
          terminalError = new SiwcError('ACCOUNT_REAUTH_REQUIRED', 401);
          return record(cleared(account, 'reauth-required', this.now()));
        }
        throw error; // Network, infrastructure or client configuration != revoked grant.
      }
    });
    const saved = payload(await this.#track(transaction));
    if (terminalError) {
      this.#cancel(key, 'ACCOUNT_REAUTH_REQUIRED');
      throw terminalError;
    }
    this.#open(key);
    ensureNotAborted(signal);
    if (!saved?.scopes.includes(DIRECT_SCOPE)) {
      this.#cancel(key, 'DIRECT_PERMISSION_MISSING');
      reject('DIRECT_PERMISSION_MISSING', 403);
    }
    const after = await this.#accounts.selection();
    if (!same(selected, after)) reject('ACCOUNT_CHANGED', 409);
    let request = this.#requests.get(key);
    if (!request || request.generation !== selected.generation || request.abort.signal.aborted) {
      this.#cancel(key, 'ACCOUNT_CHANGED');
      request = { generation: selected.generation, abort: new AbortController() };
      this.#requests.set(key, request);
    }
    return { accessToken: saved.accessToken, signal: request.abort.signal };
  }
  logout(key) {
    return this.#track(this.#logout(key));
  }
  async #logout(key) {
    this.#open(key);
    await this.#accounts.registration(key);
    this.#open(key);
    this.#loggingOut.add(key);
    this.#cancel(key, 'ACCOUNT_SIGNED_OUT');
    let remoteConfirmed = false,
      remoteError;
    try {
      const transaction = this.#accounts.credentials.modifyRecord(key, async (current) => {
        const account = payload(current);
        if (!account) reject('ACCOUNT_NOT_FOUND', 404);
        // Another process may have refreshed while this transaction was queued.
        // Revoke the latest rotating token, never an out-of-lock cached token.
        if (account.refreshToken) {
          const deadline = AbortSignal.timeout(this.maintenanceTimeoutMs);
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await this.#protocol.revoke(account, deadline);
              remoteConfirmed = true;
              break;
            } catch (error) {
              remoteError = safeCode(error);
              if (
                deadline.aborted ||
                attempt > 0 ||
                ![
                  'NETWORK',
                  'NETWORK_TIMEOUT',
                  'REVOCATION_RETRYABLE',
                  'OIDC_DISCOVERY_FAILED',
                ].includes(remoteError)
              )
                break;
              await new Promise((resolve) => setTimeout(resolve, this.revokeBackoffMs));
            }
          }
        } else {
          // A prior confirmed/local logout remains locally signed out. No
          // assertion about an unknown upstream renewable session is fabricated.
          remoteError = 'NO_RENEWABLE_TOKEN';
        }
        return record(cleared(account, 'signed-out', this.now()));
      });
      await this.#track(transaction);
      await this.#accounts.credentials.modifyRecord(SELECTION_KEY, (current) => {
        const selected = payload(current);
        if (selected?.accountKey !== key) return undefined;
        return record({ schema: 1, accountKey: null, generation: (selected.generation ?? 0) + 1 });
      });
      return {
        remoteConfirmed,
        ...(!remoteConfirmed
          ? { warning: 'REMOTE_REVOCATION_UNCONFIRMED', reason: remoteError ?? 'REVOCATION_FAILED' }
          : {}),
      };
    } catch (error) {
      // If storage could not commit, do not resume using an already-revoked grant.
      this.#blocked.set(key, 'ACCOUNT_REAUTH_REQUIRED');
      throw error;
    } finally {
      this.#loggingOut.delete(key);
    }
  }
  async dispose() {
    this.#closed = true;
    for (const key of this.#requests.keys()) this.#cancel(key, 'PLUGIN_DISPOSED');
    // Graceful plugin disposal lets an in-flight rotation atomically commit.
    // Each network maintenance transaction already has a total bounded deadline.
    await Promise.allSettled([...this.#transactions]);
  }
}
