import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SiwcError, reject, safeCode } from './protocol.js';
import { credentialGeneration, clearedGrant, pendingRenewal, assertRenewal } from './renewal.js';
import { withSignal } from './abortable.js';
const payload = (value) =>
  value?.kind === 'grant' && [1, 2].includes(value.payload?.schema) ? value.payload : undefined;
const record = (payload) => ({ kind: 'grant', payload });

// Revocation is idempotent, but a failed LOCAL clear must never resurrect the
// revoked credential in another process. Persist the deny-use fence first and
// keep the global credential-file lock out of all network/cleanup waits.
export class GrantRevocation {
  constructor({ accounts, protocol, now, maintenanceTimeoutMs, revokeBackoffMs }) {
    Object.assign(this, { accounts, protocol, now, maintenanceTimeoutMs, revokeBackoffMs });
  }
  async run(key) {
    const deadline = AbortSignal.timeout(this.maintenanceTimeoutMs),
      id = randomUUID();
    let claimed;
    while (!claimed) {
      let waiting = false;
      const saved = payload(
        await this.accounts.credentials.modifyRecord(key, (current) => {
          const account = this.accounts.assertRegistration(key, payload(current));
          assertRenewal(account);
          if (
            pendingRenewal(account, this.now()) ||
            (account.renewal?.state === 'revoking' && account.renewal.expiresAt > this.now())
          ) {
            waiting = true;
            return;
          }
          return record({
            ...account,
            schema: 2,
            renewal: {
              state: 'revoking',
              id,
              generation: credentialGeneration(account),
              expiresAt: this.now() + this.maintenanceTimeoutMs,
            },
          });
        }),
      );
      if (waiting) {
        try {
          await delay(15, undefined, { signal: deadline });
        } catch {
          reject('ACCOUNT_RENEWAL_UNCONFIRMED', 409);
        }
      } else claimed = saved;
    }
    let remoteConfirmed = false,
      remoteError = claimed.refreshToken ? undefined : 'NO_RENEWABLE_TOKEN';
    if (claimed.refreshToken) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await withSignal(() => this.protocol.revoke(claimed, deadline), deadline);
          remoteConfirmed = true;
          break;
        } catch (error) {
          remoteError = deadline.aborted ? 'NETWORK_TIMEOUT' : safeCode(error);
          if (attempt === 0 && remoteError === 'REVOCATION_RETRYABLE' && !deadline.aborted) {
            try {
              await delay(this.revokeBackoffMs, undefined, { signal: deadline });
            } catch {
              remoteError = 'NETWORK_TIMEOUT';
              break;
            }
            continue;
          }
          break;
        }
      }
    }
    try {
      await this.accounts.credentials.modifyRecord(key, (current) => {
        const account = this.accounts.assertRegistration(key, payload(current));
        if (
          account.renewal?.id !== id ||
          credentialGeneration(account) !== credentialGeneration(claimed) ||
          account.clientId !== claimed.clientId ||
          account.subject !== claimed.subject
        )
          reject('ACCOUNT_CHANGED', 409);
        return record(clearedGrant(account, 'signed-out', this.now()));
      });
    } catch (error) {
      if (error instanceof SiwcError) throw error;
      // The durable revoking fence, not a process-local flag, still denies use.
      throw new SiwcError('ACCOUNT_STORAGE_FAILED', 500);
    }
    if (remoteConfirmed) return { remoteConfirmed: true };
    return {
      remoteConfirmed: false,
      warning: 'REMOTE_REVOCATION_UNCONFIRMED',
      reason: remoteError ?? 'REVOCATION_FAILED',
    };
  }
}
