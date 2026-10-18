// The real production entry, native services and native preset declarations.
// Only an EMPTY temporary credential store; transport is denied in this process.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const asar = process.env.DSH_ASAR;
if (!asar) throw Error('Set DSH_ASAR');
const req = createRequire(pathToFileURL(join(asar, 'dsh/package.json')));
const peers = new Map(
  [
    '@deepseek-ai/dsh-agent-preset',
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-basic/package.json',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/schemastery',
    'zod',
  ].map((n) => [n, pathToFileURL(req.resolve(n)).href]),
);
const hook = registerHooks({
  resolve(s, c, next) {
    return !c.conditions.includes('require') && peers.has(s)
      ? { url: peers.get(s), shortCircuit: true }
      : next(s, c);
  },
});
const load = (n) => import(pathToFileURL(req.resolve(n)).href);
const [
  { Context },
  { default: Loader, Group },
  native,
  sessions,
  projections,
  meter,
  agents,
  { default: Registry },
  connection,
  { default: Credentials },
  production,
] = await Promise.all([
  load('@deepseek-ai/cordis'),
  load('@deepseek-ai/cordis-plugin-loader'),
  load('@deepseek-ai/dsh-llm'),
  load('@deepseek-ai/dsh-session'),
  load('@deepseek-ai/dsh-session-projection'),
  load('@deepseek-ai/dsh-token-meter'),
  load('@deepseek-ai/dsh-agent'),
  load('@deepseek-ai/dsh-agent-preset-registry'),
  load('@deepseek-ai/dsh-client-connection'),
  load('@deepseek-ai/dsh-credentials-local'),
  import('../src/index.js'),
]);
const dir = await mkdtemp(join(tmpdir(), 'dsh-siwc-bootstrap-'));
const ctx = new Context();
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw Error('REAL_NETWORK_DISABLED_IN_FIXTURE');
};
const timeout = setTimeout(() => {
  console.error('NATIVE_PROVIDER_BOOTSTRAP_TIMEOUT');
  process.exit(1);
}, 30000);
try {
  ctx.provide('profileContext', {
    dir,
    home: dir,
    installAnchor: join(asar, 'dsh/package.json'),
    patchPath: join(dir, 'cordis.patch.yml'),
    overlays: [],
    startedBundles: [],
  });
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(asar, 'dsh/package.json')).href });
  ctx.loader.builtins.group = Group;
  await ctx.plugin(native.default);
  await ctx.plugin(sessions.default);
  await ctx.plugin(projections.default);
  await ctx.plugin(meter.default);
  await ctx.plugin(agents.default);
  await ctx.plugin(Credentials, { path: join(dir, 'empty-fixture.yaml'), watch: false });
  await ctx.plugin(connection, {});
  await ctx.plugin(Registry, { default: 'cordis' });
  const ids = ['standard', 'cordis', 'ptc', 'minimal'];
  const raw = new Map();
  for (const id of ids) {
    const config = {
      id,
      plugins: [
        {
          name: 'cordis:group',
          isolate: { compaction: true },
          config: [
            {
              name: '@deepseek-ai/dsh-compaction-basic',
              config: { auto: true, headroomTokens: 1024 },
            },
          ],
        },
      ],
    };
    raw.set(id, structuredClone(config));
    await ctx.loader.create({ id: 'preset-' + id, name: '@deepseek-ai/dsh-agent-preset', config });
  }
  await ctx.loader.await();
  const provider = await ctx.plugin(production);
  assert.ok(ctx.llm.listProviders().some((p) => p.id === 'chatgpt-subscription'));
  assert.ok((await ctx.agentPresets.list()).every((p) => !p.broken));
  const expected = new URL('../src/compaction.js', import.meta.url).href;
  const compositions = ctx.agentPresets.inspectCompositions();
  assert.equal(compositions.length, 4);
  for (const c of compositions) {
    assert.equal(c.modules.filter((m) => m.moduleName === expected).length, 1);
    assert.ok(!c.modules.some((m) => m.moduleName === '@deepseek-ai/dsh-compaction-basic'));
  }
  for (const e of ctx.loader.entries())
    assert.deepEqual(e.options.config, raw.get(e.options.config.id));
  await provider.dispose();
  await ctx.loader.await();
  assert.ok(!ctx.llm.listProviders().some((p) => p.id === 'chatgpt-subscription'));
  for (const c of ctx.agentPresets.inspectCompositions())
    assert.equal(
      c.modules.filter((m) => m.moduleName === '@deepseek-ai/dsh-compaction-basic').length,
      1,
    );
  console.log(
    JSON.stringify({
      nativeProductionBootstrap: 'passed',
      realMainEntry: true,
      singleProviderBundle: true,
      allFourPresetsAdapted: true,
      rawDeclarationsUnchanged: true,
      unloadRestoresNativeDeclarations: true,
      userCredentialsAccessed: false,
      realInference: false,
      networkDeniedInFixture: true,
      nativeProfileCompatibilityPreflight: true,
    }),
  );
} finally {
  await ctx.fiber.dispose();
  globalThis.fetch = originalFetch;
  clearTimeout(timeout);
  hook.deregister();
  await rm(dir, { recursive: true, force: true });
}
