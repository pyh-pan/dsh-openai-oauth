import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DIRECT_SCOPE, SiwcError, reject, safeCode } from './protocol.js';
import { withSignal } from './abortable.js';

const payload = (value) =>
  value?.kind === 'grant' && [1, 2].includes(value.payload?.schema) ? value.payload : undefined;
const record = (value) => ({ kind: 'grant', payload: value });
export function credentialGeneration(account) {
  if (account?.credentialGeneration === undefined) return 0;
  if (!Number.isSafeInteger(account.credentialGeneration) || account.credentialGeneration < 0)
    reject('ACCOUNT_RECORD_INVALID', 500);
  return account.credentialGeneration;
}
export function assertRenewal(account) {
  const marker = account.renewal;
  if (marker === undefined) return;
  if (
    account.schema !== 2 ||
    !marker ||
    Array.isArray(marker) ||
    typeof marker !== 'object' ||
    marker.generation !== credentialGeneration(account) ||
    !['pending', 'uncertain', 'retryable', 'revoking'].includes(marker.state)
  )
    reject('ACCOUNT_RECORD_INVALID', 500);
  if (marker.state === 'retryable') {
    if (
      !Number.isFinite(marker.retryAt) ||
      typeof marker.failureCode !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(marker.failureCode)
    )
      reject('ACCOUNT_RECORD_INVALID', 500);
  } else if (
    typeof marker.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker.id) ||
    !Number.isFinite(marker.expiresAt)
  )
    reject('ACCOUNT_RECORD_INVALID', 500);
}
export const pendingRenewal = (account, now) =>
  account?.renewal?.state === 'pending' && account.renewal.expiresAt > now;
export function clearedGrant(account, status, now) {
  return Object.fromEntries(
    Object.entries({
      schema: 2,
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
      credentialGeneration: credentialGeneration(account) + 1,
    }).filter(([, value]) => value !== undefined),
  );
}
function authorized(account) {
  if (!account || account.status !== 'authorized' || !account.accessToken)
    reject(
      account?.status === 'disabled' ? 'DIRECT_PERMISSION_MISSING' : 'ACCOUNT_REAUTH_REQUIRED',
      401,
    );
  if (!account.scopes?.includes(DIRECT_SCOPE)) reject('DIRECT_PERMISSION_MISSING', 403);
}
function blocked() {
  return new SiwcError('ACCOUNT_RENEWAL_UNCONFIRMED', 409);
}

// A durable claim is committed BEFORE any rotating POST. The network does not
// hold the global credential-file lock. Only the claim's exact generation may
// commit a replacement. Crashes, lost replies, validation or commit failures
// cannot turn another manager/restart into an old-token replay.
export class GrantRenewal {
  constructor({ accounts, protocol, now, maintenanceTimeoutMs, assertOpen }) {
    Object.assign(this, { accounts, protocol, now, maintenanceTimeoutMs, assertOpen });
  }
  async wait(key) {
    const deadline = AbortSignal.timeout(this.maintenanceTimeoutMs);
    while (true) {
      const account = payload(await this.accounts.credentials.modifyRecord(key, () => undefined));
      if (!pendingRenewal(account, this.now())) return account;
      try {
        await delay(15, undefined, { signal: deadline });
      } catch {
        throw blocked();
      }
    }
  }
  async access(
    key,
    { signal, forceRefresh = false, margin, allowRefresh = true, expectedGeneration },
  ) {
    const deadline = AbortSignal.timeout(this.maintenanceTimeoutMs);
    let initialGeneration = expectedGeneration;
    while (true) {
      let owned = false,
        waiting = false,
        terminal;
      const claimId = randomUUID();
      const saved = payload(
        await this.accounts.credentials.modifyRecord(key, (current) => {
          this.assertOpen(key);
          signal?.throwIfAborted();
          const account = this.accounts.assertRegistration(key, payload(current));
          authorized(account);
          assertRenewal(account);
          initialGeneration ??= credentialGeneration(account);
          const forced = forceRefresh && credentialGeneration(account) === initialGeneration;
          const usable = !forced && account.expiresAt > this.now() + margin;
          if (account.renewal) {
            if (account.renewal.state === 'revoking') reject('ACCOUNT_SIGNED_OUT', 401);
            if (account.renewal.state === 'pending') {
              if (!pendingRenewal(account, this.now())) throw blocked();
              if (!allowRefresh) reject('ACCOUNT_REFRESH_IN_PROGRESS', 409);
              waiting = true;
              return undefined;
            }
            if (account.renewal.state === 'uncertain') throw blocked();
            if (account.renewal.state !== 'retryable') throw blocked();
            if (usable) return undefined;
            if (account.renewal.retryAt > this.now())
              throw new SiwcError(account.renewal.failureCode ?? 'AUTH_NETWORK_FAILED', 502);
          }
          if (usable) return undefined;
          if (!allowRefresh) reject('ACCOUNT_REFRESH_REQUIRED', 409);
          if (!account.refreshToken) {
            terminal = new SiwcError('ACCOUNT_REAUTH_REQUIRED', 401);
            return record(clearedGrant(account, 'reauth-required', this.now()));
          }
          if (deadline.aborted) reject('AUTH_NETWORK_TIMEOUT', 502);
          owned = true;
          return record({
            ...account,
            schema: 2,
            renewal: {
              id: claimId,
              state: 'pending',
              generation: credentialGeneration(account),
              expiresAt: this.now() + this.maintenanceTimeoutMs,
            },
          });
        }),
      );
      if (terminal) throw terminal;
      if (waiting) {
        try {
          await delay(15, undefined, { signal: deadline });
        } catch {
          throw blocked();
        }
        continue;
      }
      if (!owned) return saved;
      let replacement,
        failure,
        renewalStarted = false;
      try {
        replacement = await withSignal(() => {
          renewalStarted = true;
          return this.protocol.refresh(saved, deadline);
        }, deadline);
        if (
          replacement.clientId !== saved.clientId ||
          replacement.subject !== saved.subject ||
          replacement.issuer !== saved.issuer
        )
          reject('ACCOUNT_MISMATCH', 502);
      } catch (error) {
        if (!renewalStarted) {
          failure = new SiwcError('AUTH_NETWORK_TIMEOUT', 502);
          failure.renewalOutcome = 'not_sent';
        } else
          failure =
            deadline.aborted && !(error instanceof SiwcError)
              ? new SiwcError('AUTH_REQUEST_UNCONFIRMED', 502)
              : error;
      }
      try {
        let superseded = false;
        const committed = payload(
          await this.accounts.credentials.modifyRecord(key, (current) => {
            const account = payload(current);
            if (
              account?.renewal?.id !== claimId ||
              credentialGeneration(account) !== saved.renewal.generation ||
              account.clientId !== saved.clientId ||
              account.subject !== saved.subject
            ) {
              superseded = true;
              return undefined;
            }
            const { renewal, ...previous } = account;
            if (!failure) {
              const { renewal: _renewal, ...validated } = replacement;
              return record({
                ...validated,
                schema: 2,
                credentialGeneration: credentialGeneration(account) + 1,
                status: validated.scopes.includes(DIRECT_SCOPE) ? 'authorized' : 'disabled',
                updatedAt: this.now(),
              });
            }
            const code = safeCode(failure);
            if (
              ['INVALID_GRANT', 'REFRESH_TOKEN_INVALID'].includes(code) &&
              failure.renewalOutcome === 'rejected'
            ) {
              terminal = new SiwcError('ACCOUNT_REAUTH_REQUIRED', 401);
              return record(clearedGrant(account, 'reauth-required', this.now()));
            }
            if (['not_sent', 'rejected'].includes(failure?.renewalOutcome))
              return record({
                ...previous,
                renewal: {
                  state: 'retryable',
                  failureCode: code,
                  retryAt: this.now() + 1000,
                  generation: credentialGeneration(account),
                },
              });
            return record({
              ...previous,
              renewal: { ...renewal, state: 'uncertain', failureCode: code },
            });
          }),
        );
        if (superseded) reject('ACCOUNT_CHANGED', 409);
        if (terminal) throw terminal;
        if (failure) throw failure;
        return committed;
      } catch (error) {
        // A storage failure leaves the already durable pending claim in place.
        // Preserve safe domain failures; never export a storage exception.
        if (error instanceof SiwcError) throw error;
        try {
          await this.accounts.credentials.modifyRecord(key, (current) => {
            const account = payload(current);
            if (account?.renewal?.id !== claimId) return undefined;
            return record({
              ...account,
              renewal: {
                ...account.renewal,
                state: 'uncertain',
                failureCode: 'ACCOUNT_STORAGE_FAILED',
              },
            });
          });
        } catch {
          /* The already committed pending claim still fences this generation. */
        }
        throw blocked();
      }
    }
  }
}
