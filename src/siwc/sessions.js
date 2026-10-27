import { DIRECT_SCOPE, SiwcError, reject, safeCode } from './protocol.js';
import { SELECTION_KEY } from './accounts.js';
import { GrantRenewal, credentialGeneration } from './renewal.js';
import { GrantRevocation } from './revocation.js';

const payload = (value) =>
  value?.kind === 'grant' && [1, 2].includes(value.payload?.schema) ? value.payload : undefined;
const record = (value) => ({ kind: 'grant', payload: value });
const same = (a, b) => a?.key === b?.key && a?.generation === b?.generation;
const ensureNotAborted = (signal) => {
  if (signal?.aborted) throw signal.reason ?? new SiwcError('CANCELLED');
};
export class SessionManager {
  #accounts;
  #closed = false;
  #requests = new Map();
  #transactions = new Set();
  #loggingOut = new Set();
  #renewal;
  #revocation;
  #knownGenerations = new Map();
  constructor({
    accounts,
    protocol,
    now = Date.now,
    refreshMarginMs = 60000,
    maintenanceTimeoutMs = 20000,
    revokeBackoffMs = 250,
  }) {
    this.#accounts = accounts;
    this.now = now;
    this.refreshMarginMs = refreshMarginMs;
    this.maintenanceTimeoutMs = maintenanceTimeoutMs;
    this.revokeBackoffMs = revokeBackoffMs;
    this.#revocation = new GrantRevocation({
      accounts,
      protocol,
      now,
      maintenanceTimeoutMs,
      revokeBackoffMs,
    });
    this.#renewal = new GrantRenewal({
      accounts,
      protocol,
      now,
      maintenanceTimeoutMs,
      assertOpen: (key) => this.#open(key),
    });
  }
  #open(key) {
    if (this.#closed) reject('PLUGIN_DISPOSED', 409);
    if (this.#loggingOut.has(key)) reject('ACCOUNT_SIGNED_OUT', 401);
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
      const account = await this.#accounts.registration(key, { fresh: true });
      const generation = credentialGeneration(account);
      const changed = this.#knownGenerations.get(key) !== generation;
      this.#knownGenerations.set(key, generation);
      if (
        account.status !== 'authorized' ||
        !account.accessToken ||
        !account.scopes?.includes(DIRECT_SCOPE) ||
        account.renewal?.state === 'revoking'
      ) {
        this.#cancel(
          key,
          account.status === 'disabled' ? 'DIRECT_PERMISSION_MISSING' : 'ACCOUNT_REAUTH_REQUIRED',
        );
        return true;
      }
      return changed;
    } catch {
      this.#cancel(key, 'ACCOUNT_REAUTH_REQUIRED');
      return true;
    }
  }
  access(key, options = {}) {
    return this.#track(this.#access(key, options));
  }
  async #access(
    key,
    { signal, selection, forceRefresh = false, allowNearExpiry = false, allowRefresh = true } = {},
  ) {
    this.#open(key);
    ensureNotAborted(signal);
    // This also validates the namespace/key, without reading any other provider.
    const initial = await this.#accounts.registration(key, { fresh: true });
    const selected = await this.#accounts.selection();
    if (selected?.key !== key || (selection && !same(selected, selection)))
      reject('ACCOUNT_CHANGED', 409);
    let saved;
    try {
      saved = await this.#track(
        this.#renewal.access(key, {
          signal,
          forceRefresh,
          allowRefresh,
          margin: allowNearExpiry === true ? 0 : this.refreshMarginMs,
          expectedGeneration: credentialGeneration(initial),
        }),
      );
    } catch (error) {
      if (safeCode(error) === 'ACCOUNT_REAUTH_REQUIRED')
        this.#cancel(key, 'ACCOUNT_REAUTH_REQUIRED');
      throw error;
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
    this.#knownGenerations.set(key, credentialGeneration(saved));
    return {
      accessToken: saved.accessToken,
      signal: request.abort.signal,
      credentialGeneration: credentialGeneration(saved),
    };
  }
  logout(key) {
    return this.#track(this.#logout(key));
  }
  async #logout(key) {
    if (this.#closed) reject('PLUGIN_DISPOSED', 409);
    if (this.#loggingOut.has(key)) reject('AUTH_BUSY', 409);
    this.#loggingOut.add(key);
    try {
      await this.#accounts.registration(key, { fresh: true });
      this.#cancel(key, 'ACCOUNT_SIGNED_OUT');
      const result = await this.#revocation.run(key);
      await this.#accounts.credentials.modifyRecord(SELECTION_KEY, (current) => {
        const selected = payload(current);
        if (selected?.accountKey !== key) return;
        return record({ schema: 1, accountKey: null, generation: (selected.generation ?? 0) + 1 });
      });
      return result;
    } catch (error) {
      if (error instanceof SiwcError) throw error;
      throw new SiwcError('ACCOUNT_STORAGE_FAILED', 500);
    } finally {
      this.#loggingOut.delete(key);
    }
  }
  async drain() {
    while (this.#transactions.size) await Promise.allSettled([...this.#transactions]);
  }
  async dispose() {
    this.#closed = true;
    for (const key of this.#requests.keys()) this.#cancel(key, 'PLUGIN_DISPOSED');
    // Graceful plugin disposal lets an in-flight rotation atomically commit.
    // Each network maintenance transaction already has a total bounded deadline.
    await this.drain();
  }
}
