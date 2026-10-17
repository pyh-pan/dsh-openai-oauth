// Two actual Electron/Node processes, one native credentials-local file.
// All credentials are synthetic and confined to a new temporary directory.
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { AccountStore } from '../src/siwc/accounts.js';
import { SessionManager } from '../src/siwc/sessions.js';
import { DIRECT_SCOPE, ISSUER } from '../src/siwc/protocol.js';

const asar = process.env.DSH_ASAR;
if (!asar) throw new Error('Set DSH_ASAR');
const req = createRequire(pathToFileURL(join(asar, 'package.json')));
const { Context } = req('@deepseek-ai/cordis');
const { default: Credentials } = await import(
  pathToFileURL(join(asar, 'dsh/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js')).href
);
const child = process.env.DSH_RACE_WORKER === '1';
const dir = child ? process.env.DSH_RACE_DIR : await mkdtemp(join(tmpdir(), 'dsh-siwc-lock-'));
const filename = join(dir, 'synthetic-credentials.yaml');
const audit = join(dir, 'refresh-count.txt');
const ctx = new Context();
const timeout = setTimeout(() => {
  console.error('Native cross-process refresh test timed out');
  process.exit(1);
}, 30000);
let sessions;
try {
  const credentialFiber = await ctx.plugin(Credentials, { path: filename, watch: false });
  const accounts = new AccountStore(ctx.credentials);
  if (child) {
    sessions = new SessionManager({
      accounts,
      protocol: {
        refresh: async (old) => {
          assert.equal(old.refreshToken, 'synthetic-original-refresh');
          await appendFile(audit, 'refresh\n');
          await new Promise((resolve) => setTimeout(resolve, 150));
          return {
            ...old,
            accessToken: 'synthetic-rotated-access',
            refreshToken: 'synthetic-rotated-refresh',
            expiresAt: Date.now() + 3600000,
            savedAt: Date.now(),
          };
        },
      },
    });
    const selected = await accounts.selection();
    assert.ok(selected);
    const access = await sessions.access(selected.key, { selection: selected });
    assert.equal(access.accessToken, 'synthetic-rotated-access');
    console.log(JSON.stringify({ worker: true, okay: true }));
  } else {
    const clientId = 'oaiapp_native_race_test_123456';
    const key = await accounts.beginRegistration(clientId);
    await accounts.saveValidated({
      clientId,
      issuer: ISSUER,
      subject: 'synthetic-race-sub',
      accessToken: 'synthetic-expired-access',
      refreshToken: 'synthetic-original-refresh',
      idToken: 'synthetic-validated-id',
      expiresAt: Date.now() - 1000,
      scopes: [DIRECT_SCOPE],
    });
    await accounts.select(key);
    const launch = () =>
      new Promise((resolve, rejectChild) => {
        const proc = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            DSH_RACE_WORKER: '1',
            DSH_RACE_DIR: dir,
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '',
          stderr = '';
        proc.stdout.on('data', (data) => {
          stdout += data;
        });
        proc.stderr.on('data', (data) => {
          stderr += data;
        });
        proc.once('error', rejectChild);
        proc.once('close', (code) => {
          if (code !== 0) rejectChild(new Error(`Synthetic worker failed (${code}): ${stderr}`));
          else resolve(JSON.parse(stdout.trim()));
        });
      });
    const workers = await Promise.all([launch(), launch()]);
    assert.ok(workers.every((result) => result.okay));
    assert.equal((await readFile(audit, 'utf8')).trim().split('\n').length, 1);
    // Restart native credentials to prove on-disk durability, not a parent cache.
    await credentialFiber.restart();
    const resumed = new AccountStore(ctx.credentials);
    const stored = await resumed.registration(key);
    assert.equal(stored.refreshToken, 'synthetic-rotated-refresh');
    assert.equal(stored.accessToken, 'synthetic-rotated-access');
    assert.equal(stored.clientId, clientId);
    console.log(
      JSON.stringify({
        processes: 2,
        nativeCrossProcessLock: true,
        refreshes: 1,
        atomicRotationPersisted: true,
        nativeStoreRestarted: true,
        realTokensUsed: false,
      }),
    );
  }
} finally {
  await sessions?.dispose();
  await ctx.fiber.dispose();
  clearTimeout(timeout);
  if (!child) await rm(dir, { recursive: true, force: true });
}
