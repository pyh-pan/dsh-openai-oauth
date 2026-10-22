// The real production entry, native services and native preset declarations.
// Temporary synthetic credentials/attachments; only exact mock endpoints allowed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { API_PATH, PROVIDER } from '../src/siwc/controller.js';
import { AccountStore } from '../src/siwc/accounts.js';
import { ISSUER, DIRECT_SCOPE, RESOURCE } from '../src/siwc/protocol.js';
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
  { default: Attachments },
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
  load('@deepseek-ai/dsh-attachment-local'),
  import('../src/index.js'),
]);
const dir = await mkdtemp(join(tmpdir(), 'dsh-siwc-bootstrap-'));
const ctx = new Context();
const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, init) => {
  if (url === `${RESOURCE}/models`)
    return Response.json({
      models: [
        {
          slug: 'fixture-vision',
          visibility: 'list',
          input_modalities: ['text', 'image'],
          supports_file_input: true,
        },
        { slug: 'fixture-text', visibility: 'list', input_modalities: ['text'] },
      ],
    });
  if (url !== `${RESOURCE}/responses`) throw Error('REAL_NETWORK_DISABLED_IN_FIXTURE');
  assert.equal(init.headers.authorization, 'Bearer synthetic-unified-access');
  requests.push(JSON.parse(init.body));
  return new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_unified_fixture',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_unified_fixture',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'synthetic-ok', annotations: [] }],
          },
        ],
      },
    })}\n\n`,
  );
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
  class ExistingAdapter extends native.LlmAdapter {
    providerInfo(id) {
      return { id, name: id };
    }
  }
  ctx.llm.registerAdapter(['fixture-other-provider'], new ExistingAdapter());
  await ctx.plugin(sessions.default);
  await ctx.plugin(projections.default);
  await ctx.plugin(meter.default);
  await ctx.plugin(agents.default);
  await ctx.plugin(Credentials, { path: join(dir, 'synthetic-credentials.yaml'), watch: false });
  await ctx.plugin(Attachments, { dshHome: join(dir, 'synthetic-home') });
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
  const carrier = ctx.connection.createSharedFetchHandler('/api');
  const stateResponse = await carrier.fetch(new Request('http://localhost' + API_PATH), {
    id: 'fixture-owner',
    principal: { kind: 'owner' },
  });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.coverage.presets.filter((p) => p.status === 'ready').length, 4);
  assert.equal(state.coverage.status, 'pending');
  assert.equal(state.coverage.sessions.checked, 0);
  assert.ok(!JSON.stringify(state.coverage).includes('file:'));
  // Exercise the actual main entry's attachment bridge and adapter, not just
  // independently tested factories. No session id means no preset claim.
  const accounts = new AccountStore(ctx.credentials);
  const key = await accounts.beginRegistration('oaiapp_unified_bootstrap_fixture');
  await accounts.saveValidated({
    clientId: 'oaiapp_unified_bootstrap_fixture',
    issuer: ISSUER,
    subject: 'synthetic-unified-user',
    accessToken: 'synthetic-unified-access',
    refreshToken: 'synthetic-unified-refresh',
    idToken: 'synthetic-unified-id',
    expiresAt: Date.now() + 3600000,
    scopes: [DIRECT_SCOPE],
  });
  await accounts.select(key);
  const sharp = req('sharp');
  const png = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 128, b: 0 } },
  })
    .png()
    .toBuffer();
  const image = await ctx.attachments.saveImage({
    data: png,
    mediaType: 'image/png',
    name: 'synthetic-unified.png',
  });
  const fileBytes = Buffer.from('synthetic unified document');
  const file = await ctx.attachments.saveFile({ data: fileBytes, name: 'synthetic-unified.txt' });
  const user = native.createUserMessage({
    source: { kind: 'user' },
    content: [
      { type: 'image', attachment: image },
      { type: 'file', attachment: file },
    ],
  });
  const historyBefore = JSON.stringify(user);
  const collect = async (prepared, extra = {}) => {
    const chunks = [];
    for await (const chunk of prepared.stream({
      ...prepared.config,
      messages: [user],
      ...extra,
    }))
      chunks.push(chunk);
    return chunks;
  };
  const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: 'fixture-vision' });
  assert.equal((await collect(prepared)).at(-1).reason.kind, 'stop');
  assert.deepEqual(
    requests[0].input[0].content.map((p) => p.type),
    ['input_image', 'input_file'],
  );
  assert.deepEqual(
    Buffer.from(requests[0].input[0].content[1].file_data.split(',')[1], 'base64'),
    fileBytes,
  );
  assert.equal(
    JSON.stringify(user),
    historyBefore,
    'the real main entry preserves durable history',
  );
  const negative = await ctx.llm.prepareCall({ provider: PROVIDER, model: 'fixture-text' });
  assert.equal(
    (await collect(negative)).at(-1).reason.failure.code,
    'ATTACHMENT_MODEL_UNSUPPORTED',
  );
  // Native prepared calls are deliberately single-use; create a fresh call.
  const uncovered = await ctx.llm.prepareCall({ provider: PROVIDER, model: 'fixture-vision' });
  assert.equal(
    (await collect(uncovered, { sessionId: 'synthetic-unknown-session' })).at(-1).reason.failure
      .code,
    'SIWC_SESSION_COVERAGE_UNAVAILABLE',
  );
  assert.equal(
    requests.length,
    1,
    'negative capability and uncovered sessions never reach Responses',
  );
  assert.ok(ctx.llm.listProviders().some((p) => p.id === 'fixture-other-provider'));
  await provider.dispose();
  await ctx.loader.await();
  assert.ok(!ctx.llm.listProviders().some((p) => p.id === 'chatgpt-subscription'));
  assert.ok(ctx.llm.listProviders().some((p) => p.id === 'fixture-other-provider'));
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
      networkInterceptedInFixture: true,
      mainEntryInlineAttachments: true,
      mainEntryPreparedNegativeCapability: true,
      mainEntryUnknownSessionAdmission: true,
      existingSourcesPreserved: true,
      nativeProfileCompatibilityPreflight: true,
      ownerSettingsCoverageDiagnostics: true,
    }),
  );
} finally {
  await ctx.fiber.dispose();
  globalThis.fetch = originalFetch;
  clearTimeout(timeout);
  hook.deregister();
  await rm(dir, { recursive: true, force: true });
}
