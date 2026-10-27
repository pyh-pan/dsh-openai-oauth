import { Resolver, getServers } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const TIMED_OUT = Symbol('dns deadline');
async function bounded(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const dnsError = () => Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' });
let hostChecks;
let hostCheckedAt = 0;
// Respect explicit hosts overrides by leaving those destinations with the Host.
// Retain only two boolean flags, never unrelated hosts/configuration contents.
export async function hasHostOverride(hostname) {
  if (!hostChecks || Date.now() - hostCheckedAt > 30000) {
    hostCheckedAt = Date.now();
    hostChecks = (async () => {
      const path =
        process.platform === 'win32'
          ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
          : '/etc/hosts';
      try {
        const text = await readFile(path, 'utf8');
        if (text.length > 1024 * 1024) return;
        const result = new Map([
          ['auth.openai.com', false],
          ['api.openai.com', false],
        ]);
        for (const line of text.split('\n')) {
          const [address, ...names] = line.split('#', 1)[0].trim().split(/\s+/);
          if (!isIP(address)) continue;
          for (const name of names) {
            const normalized = name.toLowerCase().replace(/\.$/, '');
            if (result.has(normalized)) result.set(normalized, true);
          }
        }
        return result;
      } catch (error) {
        if (error.code === 'ENOENT') return new Map();
      }
    })();
  }
  const result = await hostChecks;
  return result ? (result.get(hostname) ?? false) : undefined;
}

// Public official-provider DNS only. Uses the process's already configured DNS
// servers through bounded c-ares queries, not macOS's intermittently stuck
// getaddrinfo path. No public DNS/IP or global resolver override is installed.
export class BoundedLookup {
  #pending = new Map();
  #cache = new Map();
  #active = new Set();
  #closed = false;
  constructor({
    resolver = (servers) => {
      const value = new Resolver({ timeout: 1500, tries: 1 });
      value.setServers(servers ?? getServers());
      return value;
    },
    queryTimeoutMs = 1800,
    now = Date.now,
    isPublicAddress,
  } = {}) {
    this.resolver = resolver;
    Object.assign(this, { queryTimeoutMs, now, isPublicAddress });
  }
  #validate(records) {
    if (
      !Array.isArray(records) ||
      !records.length ||
      records.some(
        (record) =>
          ![4, 6].includes(record.family) ||
          isIP(record.address) !== record.family ||
          !this.isPublicAddress?.(record.address),
      )
    )
      throw Object.assign(new Error('SIWC_NETWORK_ADDRESS_BLOCKED'), {
        code: 'SIWC_NETWORK_ADDRESS_BLOCKED',
      });
    return records.map(({ address, family }) => ({ address, family }));
  }
  async #query(hostname, servers, families) {
    const resolver = this.resolver(servers);
    this.#active.add(resolver);
    const records = [];
    const read = async (family, query) => {
      try {
        const answer = await query;
        if (Array.isArray(answer))
          for (const entry of answer)
            records.push({ address: typeof entry === 'string' ? entry : entry.address, family });
      } catch {
        /* One address family may be unavailable. */
      }
    };
    try {
      await bounded(
        Promise.all(
          families.map((family) =>
            read(family, family === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname)),
          ),
        ),
        this.queryTimeoutMs,
      );
      if (!records.length) throw dnsError();
      return this.#validate(records.sort((a, b) => a.family - b.family));
    } finally {
      this.#active.delete(resolver);
      resolver.cancel();
    }
  }
  async resolve(hostname, family = 0, servers, families = [4, 6]) {
    if (this.#closed) throw dnsError();
    const key = hostname + '|' + JSON.stringify([servers ?? [], families]);
    const cached = this.#cache.get(key);
    let records = cached?.expiresAt > this.now() ? cached.records : undefined;
    if (!records) {
      let operation = this.#pending.get(key);
      if (!operation) {
        operation = this.#query(hostname, servers, families);
        this.#pending.set(key, operation);
      }
      try {
        records = await operation;
      } finally {
        if (this.#pending.get(key) === operation) this.#pending.delete(key);
      }
      if (this.#closed) throw dnsError();
      this.#cache.set(key, { records, expiresAt: this.now() + 30000 });
    }
    const filtered = family ? records.filter((record) => record.family === family) : records;
    if (!filtered.length) throw dnsError();
    return filtered.map((record) => ({ ...record }));
  }
  invalidate(hostname) {
    for (const key of this.#cache.keys())
      if (key.startsWith(hostname + '|')) this.#cache.delete(key);
  }
  dispose() {
    this.#closed = true;
    for (const resolver of this.#active) resolver.cancel();
    this.#cache.clear();
  }
}
