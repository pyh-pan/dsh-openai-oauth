import { open, mkdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { reasoningCapabilities } from './capabilities.js';

const validScope = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const slug = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
function metadata(models) {
  if (!Array.isArray(models) || models.length > 4096) throw Error('MODEL_CACHE_INVALID');
  const ids = new Set();
  return models.map((model) => {
    if (
      !slug(model.id) ||
      ids.has(model.id) ||
      typeof model.name !== 'string' ||
      model.name.length > 256
    )
      throw Error('MODEL_CACHE_INVALID');
    ids.add(model.id);
    let reasoning;
    if (model.reasoning) {
      if (!Array.isArray(model.reasoning.efforts)) throw Error('MODEL_CACHE_INVALID');
      reasoning = reasoningCapabilities({
        supported_reasoning_levels: model.reasoning.efforts.map((level) => ({
          effort: level.id,
          description: level.description,
        })),
        default_reasoning_level: model.reasoning.defaultEffort,
      });
    }
    // Display/selection only. Never persist context-window, attachment, quota or
    // authorization facts; preparation uses a credential-bound runtime contract.
    return {
      provider: 'chatgpt-subscription',
      id: model.id,
      name: model.name,
      ...(reasoning ? { reasoning } : {}),
    };
  });
}
export class ModelCache {
  #entries = new Map();
  #writes = Promise.resolve();
  #closed = false;
  constructor({ root, now = Date.now } = {}) {
    Object.assign(this, { root, now });
  }
  async get(scope) {
    if (!validScope(scope) || this.#closed) return;
    if (this.#entries.has(scope)) return structuredClone(this.#entries.get(scope));
    if (!this.root) return;
    let file;
    try {
      file = await open(
        join(this.root, scope + '.json'),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) return;
      const value = JSON.parse(await file.readFile('utf8'));
      if (value.schema !== 1 || value.scope !== scope || !Number.isFinite(value.cachedAt)) return;
      if (this.#closed) return;
      const entry = { models: metadata(value.models), cachedAt: value.cachedAt };
      this.#entries.set(scope, entry);
      return structuredClone(entry);
    } catch {
      return;
    } finally {
      await file?.close().catch(() => {});
    }
  }
  set(scope, models) {
    if (!validScope(scope) || this.#closed) return Promise.resolve();
    const entry = { models: metadata(models), cachedAt: this.now() };
    this.#entries.set(scope, entry);
    if (!this.root) return Promise.resolve();
    const contents = JSON.stringify({ schema: 1, scope, ...entry });
    if (Buffer.byteLength(contents) > 1024 * 1024) return Promise.resolve();
    const write = async () => {
      let file;
      const temporary = join(this.root, `${scope}.${randomUUID()}.tmp`);
      try {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        file = await open(temporary, 'wx', 0o600);
        await file.writeFile(contents);
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temporary, join(this.root, scope + '.json'));
      } finally {
        await file?.close();
        await rm(temporary, { force: true }).catch(() => {});
      }
    };
    this.#writes = this.#writes.then(write, write).catch(() => {});
    return this.#writes;
  }
  async dispose() {
    this.#closed = true;
    await this.#writes;
    this.#entries.clear();
  }
}
