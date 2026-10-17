import { createHash, randomUUID } from 'node:crypto';
import { DIRECT_SCOPE, ISSUER, digest, reject, validClientId, validHostId } from './protocol.js';

export const OWNER = 'chatgpt-subscription-login';
export const HOST_KEY = `${OWNER}/host`;
export const SELECTION_KEY = `${OWNER}/selection`;
const PREFIX = `${OWNER}/account-`;
const record = (payload) => ({ kind: 'grant', payload });
// Native credential keys require lowercase hyphenated identifiers; base64url
// hashes contain capitals/underscores and are NOT valid record-key segments.
const accountKey = (clientId) => `${PREFIX}${createHash('sha256').update(clientId).digest('hex')}`;
const validKey = (key) =>
  typeof key === 'string' &&
  key.startsWith(PREFIX) &&
  /^[a-f0-9]{64}$/.test(key.slice(PREFIX.length));
const readPayload = (value) =>
  value?.kind === 'grant' && value.payload?.schema === 1 ? value.payload : undefined;
const checkSignal = (signal) => {
  if (signal?.aborted) reject('CANCELLED');
};

// All writes stay in this plugin's namespace. No credential enumeration outside
// that namespace, no token reads from Pi/Codex, and no plain settings secrets.
export class AccountStore {
  constructor(credentials) {
    this.credentials = credentials;
  }
  async hostId() {
    const saved = await this.credentials.modifyRecord(HOST_KEY, (current) => {
      const existing = readPayload(current);
      if (existing && validHostId(existing.hostId)) return undefined;
      if (current) reject('HOST_RECORD_INVALID');
      return record({ schema: 1, hostId: `urn:uuid:${randomUUID()}` });
    });
    return readPayload(saved).hostId;
  }
  async registration(key) {
    if (!validKey(key)) reject('ACCOUNT_NOT_FOUND', 404);
    const payload = readPayload(await this.credentials.readRecord(key));
    if (!payload || !validClientId(payload.clientId) || accountKey(payload.clientId) !== key)
      reject('ACCOUNT_NOT_FOUND', 404);
    return payload;
  }
  async beginRegistration(clientId, signal) {
    if (!validClientId(clientId)) reject('CLIENT_ID_INVALID');
    checkSignal(signal);
    const key = accountKey(clientId);
    await this.credentials.modifyRecord(key, (current) => {
      checkSignal(signal);
      const existing = readPayload(current);
      if (existing && existing.clientId === clientId) return undefined;
      if (current) reject('ACCOUNT_RECORD_INVALID');
      return record({ schema: 1, clientId, status: 'pending', createdAt: Date.now() });
    });
    return key;
  }
  async saveValidated(grant, signal) {
    checkSignal(signal);
    if (
      !validClientId(grant.clientId) ||
      grant.issuer !== ISSUER ||
      typeof grant.subject !== 'string' ||
      !grant.subject ||
      !Array.isArray(grant.scopes) ||
      !grant.accessToken ||
      !grant.idToken ||
      !Number.isFinite(grant.expiresAt) ||
      (grant.refreshToken !== undefined &&
        (typeof grant.refreshToken !== 'string' || !grant.refreshToken))
    )
      reject('INVALID_GRANT_RECORD');
    const key = accountKey(grant.clientId);
    await this.credentials.modifyRecord(key, (current) => {
      checkSignal(signal);
      const existing = readPayload(current);
      if (!existing || existing.clientId !== grant.clientId) reject('REGISTRATION_INCOMPLETE');
      if (existing.subject && existing.subject !== grant.subject) reject('ACCOUNT_MISMATCH');
      const {
        accessToken,
        refreshToken,
        idToken,
        expiresAt,
        savedAt,
        scopes,
        tokenType,
        ...mapping
      } = existing;
      return record({
        ...mapping,
        ...grant,
        schema: 1,
        status: grant.scopes.includes(DIRECT_SCOPE) ? 'authorized' : 'disabled',
        updatedAt: Date.now(),
      });
    });
    // Saving a verified account NEVER changes the active account. Selection is a
    // separate explicit UI action, so cancel/HMR cannot switch a running session.
    return key;
  }
  async accounts() {
    const entries = await this.credentials.listRecords();
    const accounts = [];
    for (const { key } of entries) {
      if (!validKey(key)) continue;
      const account = await this.registration(key);
      accounts.push({
        key,
        label: `${account.email ?? account.displayName ?? 'ChatGPT'} · ${digest(account.clientId).slice(0, 8)}`,
        status: account.status,
        signedIn: ['authorized', 'disabled'].includes(account.status) && !!account.accessToken,
        inferenceEnabled: account.status === 'authorized' && account.scopes?.includes(DIRECT_SCOPE),
        welcomeRequired: account.status === 'authorized' && !account.welcomeSeen,
        renewable: !!account.refreshToken,
      });
    }
    return accounts;
  }
  async acknowledgeWelcome(key) {
    await this.registration(key);
    await this.credentials.modifyRecord(key, (current) => {
      const account = readPayload(current);
      if (account?.status !== 'authorized' || !account.scopes?.includes(DIRECT_SCOPE))
        reject('DIRECT_PERMISSION_MISSING', 403);
      if (account.welcomeSeen) return undefined;
      return record({ ...account, welcomeSeen: true });
    });
  }
  async selection() {
    // A readRecord cache can lag another process until its file watcher fires.
    // A no-op exclusive mutation reloads from disk before request dispatch.
    const selection = readPayload(
      await this.credentials.modifyRecord(SELECTION_KEY, () => undefined),
    );
    return selection && validKey(selection.accountKey)
      ? { key: selection.accountKey, generation: selection.generation }
      : undefined;
  }
  async select(key, signal) {
    checkSignal(signal);
    const account = await this.registration(key);
    if (
      account.status !== 'authorized' ||
      !account.accessToken ||
      !account.scopes?.includes(DIRECT_SCOPE)
    )
      reject('ACCOUNT_REAUTH_REQUIRED', 401);
    await this.credentials.modifyRecord(SELECTION_KEY, (current) => {
      checkSignal(signal);
      const existing = readPayload(current);
      return record({ schema: 1, accountKey: key, generation: (existing?.generation ?? 0) + 1 });
    });
    return this.selection();
  }
}
