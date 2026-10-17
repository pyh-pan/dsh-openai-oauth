// Native isolation: installed ASAR services + v0.2 host composition. This NEVER
// reads the user's credential store or calls an upstream inference endpoint.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { AccountStore } from '../src/siwc/accounts.js';
import { SessionManager } from '../src/siwc/sessions.js';
import { createHostPlugin } from '../src/siwc/host.js';
import { PROVIDER, API_PATH } from '../src/siwc/controller.js';
import { ISSUER, DIRECT_SCOPE, RESOURCE } from '../src/siwc/protocol.js';
import { sessionAffinity } from '../src/siwc/wire.js';

const asar = process.env.DSH_ASAR;
if (!asar) throw new Error('Set DSH_ASAR');
const req = createRequire(pathToFileURL(join(asar, 'package.json')));
const { Context } = req('@deepseek-ai/cordis');
const load = (p) => import(pathToFileURL(join(asar, 'dsh/node_modules', p, 'lib/index.js')).href);
const [{ default: Credentials }, native, connection] = await Promise.all([
  load('@deepseek-ai/dsh-credentials-local'),
  load('@deepseek-ai/dsh-llm'),
  load('@deepseek-ai/dsh-client-connection'),
]);
const dir = await mkdtemp(join(tmpdir(), 'dsh-siwc-native-'));
const ctx = new Context();
const timeout = setTimeout(() => {
  console.error('Native SIWC isolation timed out');
  process.exit(1);
}, 30000);
const requests = [];
const settle = async (check) => {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Native dependency graph did not settle');
};
let accounts;
try {
  const credentialFiber = await ctx.plugin(Credentials, {
    path: join(dir, 'temporary-credentials.yaml'),
    watch: false,
  });
  await ctx.plugin(native.default);
  await ctx.plugin(connection, {});
  // Existing source sentinels prove the new source is additive, not a registry reset.
  class ExistingAdapter extends native.LlmAdapter {
    providerInfo(id) {
      return { id, name: id };
    }
  }
  ctx.llm.registerAdapter(
    ['deepseek-account', 'deepseek-official', 'existing-api-source'],
    new ExistingAdapter(),
  );
  await ctx.credentials.modifyRecord('llm-pi-ai/openai-codex', () => ({
    kind: 'grant',
    payload: { testSentinel: 'untouched' },
  }));
  const plugin = createHostPlugin(native, (context) => {
    accounts = new AccountStore(context.credentials);
    const protocol = {
      revoke: async (grant) => {
        assert.equal(grant.refreshToken, 'native-test-refresh');
      },
    };
    return {
      accounts,
      protocol,
      controllerOptions: { port: 0 },
      sessions: new SessionManager({ accounts, protocol }),
      fetchImpl: async (url, options) => {
        requests.push({ url, ...options });
        if (url === `${RESOURCE}/models`)
          return Response.json({
            models: [
              {
                slug: 'native-test-model',
                display_name: 'Native fixture',
                visibility: 'list',
                supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
                default_reasoning_level: 'high',
                supports_reasoning_summary_parameter: true,
              },
            ],
          });
        assert.equal(url, `${RESOURCE}/responses`);
        assert.ok(options.headers['user-agent'], 'Real attributionHeaders must reach the wire');
        const output = [
          {
            type: 'message',
            id: 'msg_native',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'native-fixture-ok', annotations: [] }],
          },
        ];
        const data = {
          type: 'response.completed',
          response: {
            id: 'resp_native',
            status: 'completed',
            output,
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        };
        return new Response(`data: ${JSON.stringify(data)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    };
  });
  const fiber = await ctx.plugin(plugin);
  assert.deepEqual(
    ctx.llm.listProviders().map((provider) => provider.id),
    ['deepseek-account', 'deepseek-official', 'existing-api-source', PROVIDER],
  );
  assert.deepEqual(await ctx.llm.listModels(PROVIDER), []);
  const key = await accounts.beginRegistration('oaiapp_native_fixture_123456');
  await accounts.saveValidated({
    clientId: 'oaiapp_native_fixture_123456',
    issuer: ISSUER,
    subject: 'native-test-sub',
    accessToken: 'native-test-access',
    refreshToken: 'native-test-refresh',
    idToken: 'native-test-id',
    expiresAt: Date.now() + 3600000,
    scopes: [DIRECT_SCOPE],
  });
  const call = async (body) => {
    const response = await ctx.connection.createSharedFetchHandler('/api').fetch(
      new Request(
        `http://localhost${API_PATH}`,
        body
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {},
      ),
      { id: 'native-fixture-owner', principal: { kind: 'owner' } },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const connectionVersion = JSON.parse(
    await readFile(
      join(asar, 'dsh/node_modules/@deepseek-ai/dsh-client-connection/package.json'),
      'utf8',
    ),
  ).version;
  if (connectionVersion === '0.2.1-rc.1') {
    const denied = await ctx.connection
      .createSharedFetchHandler('/api')
      .fetch(new Request(`http://localhost${API_PATH}`), {
        id: 'native-fixture-non-owner',
        principal: { kind: 'guest' },
      });
    assert.equal(denied.status, 403);
  }
  await accounts.select(key); // Exercise the protected persistence boundary directly.
  const selected = await call({ action: 'select', key });
  assert.equal(selected.selection.key, key);
  assert.ok(!JSON.stringify(selected).includes('native-test-access'));
  const models = await ctx.llm.listModels(PROVIDER);
  assert.equal(models[0].id, 'native-test-model');
  assert.equal(
    (await ctx.llm.resolveCallConfig({ provider: PROVIDER, model: models[0].id })).reasoningEffort,
    'high',
  );
  await assert.rejects(
    ctx.llm.resolveCallConfig({
      provider: PROVIDER,
      model: models[0].id,
      reasoningEffort: 'invented',
    }),
    { code: 'UNSUPPORTED_REASONING_EFFORT' },
  );
  const chunks = [];
  for await (const chunk of ctx.llm.stream({
    provider: PROVIDER,
    model: models[0].id,
    sessionId: 'native-fixture-durable-session',
    messages: [
      { id: 'user-fixture', role: 'user', content: [{ type: 'text', text: 'fixture only' }] },
    ],
  }))
    chunks.push(chunk);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  const responseRequest = requests.find((request) => request.url.endsWith('/responses'));
  const affinity = sessionAffinity('native-fixture-durable-session', key);
  assert.equal(responseRequest.headers.session_id, affinity);
  assert.equal(responseRequest.headers['x-client-request-id'], affinity);
  assert.equal(JSON.parse(responseRequest.body).prompt_cache_key, affinity);
  for (const request of requests.filter((request) => request.url.endsWith('/models'))) {
    assert.equal(request.headers.session_id, undefined);
    assert.equal(request.headers['x-client-request-id'], undefined);
  }
  assert.deepEqual(JSON.parse(requests.find((r) => r.url.endsWith('/responses')).body).reasoning, {
    effort: 'high',
    summary: 'auto',
  });
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'native-fixture-ok');
  const terminal = chunks.at(-1);
  assert.equal(terminal.replayState.response.kind, 'chatgpt-subscription-responses');
  const assembled = new native.BlockAssembler();
  for (const chunk of chunks) assembled.push(chunk);
  // The native assembler must accept our replay envelope, including index pruning.
  assert.equal(assembled.blocks()[0].text, 'native-fixture-ok');
  assert.equal(assembled.replayState.response.kind, 'chatgpt-subscription-responses');
  const waiting = await call({ action: 'start' });
  assert.equal(waiting.attempt.phase, 'waiting');
  const callback = new URL(new URL(waiting.attempt.authorizeUrl).searchParams.get('redirect_uri'));
  await call({ action: 'cancel', attemptId: waiting.attempt.id });
  await assert.rejects(fetch(callback));
  await fiber.dispose();
  await credentialFiber.restart();
  const restarted = await ctx.plugin(plugin);
  await settle(() => ctx.connection?.fetchRoutes?.has(API_PATH));
  assert.equal((await call()).accounts[0].signedIn, true);
  assert.equal((await ctx.llm.listModels(PROVIDER))[0].id, 'native-test-model');
  const signedOut = await call({ action: 'logout', key });
  assert.equal(signedOut.logout.remoteConfirmed, true);
  assert.equal(signedOut.accounts[0].signedIn, false);
  await restarted.dispose();
  assert.equal(
    ctx.llm.listProviders().some((provider) => provider.id === PROVIDER),
    false,
  );
  assert.equal(ctx.llm.listProviders().length, 3);
  assert.deepEqual((await ctx.credentials.readRecord('llm-pi-ai/openai-codex')).payload, {
    testSentinel: 'untouched',
  });
  assert.equal(requests.filter((request) => request.url.endsWith('/responses')).length, 1);
  console.log(
    JSON.stringify({
      nativeServices: true,
      sourceRegisteredAndUnloaded: true,
      existingSourcesPreserved: true,
      modelDirectory: true,
      attributedMockResponses: true,
      nativeChunkAssembly: true,
      nativeSessionAffinityPropagated: true,
      authenticatedCarrierApi: true,
      nonOwnerApiDenied: connectionVersion === '0.2.1-rc.1',
      callbackCancellation: true,
      nativeStoreRestart: true,
      scopedRevocationWithMockUpstream: true,
      userCredentialsAccessed: false,
      realInference: false,
    }),
  );
} finally {
  clearTimeout(timeout);
  await ctx.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
}
