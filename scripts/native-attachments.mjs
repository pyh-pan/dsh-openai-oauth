// Real installed attachment store + LlmRuntime; generated images/documents,
// temporary credentials and mock Responses only. No real grant or inference.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AccountStore } from '../src/siwc/accounts.js';
import { SessionManager } from '../src/siwc/sessions.js';
import { createHostPlugin } from '../src/siwc/host.js';
import { createAttachmentBridge } from '../src/siwc/attachment-bridge.js';
import { PROVIDER } from '../src/siwc/controller.js';
import { DIRECT_SCOPE, ISSUER, RESOURCE } from '../src/siwc/protocol.js';

export async function verifyNativeAttachments(asar) {
  const load = (p) => import(pathToFileURL(join(asar, 'dsh/node_modules', p, 'lib/index.js')).href);
  const req = createRequire(pathToFileURL(join(asar, 'dsh/package.json')));
  const { Context } = req('@deepseek-ai/cordis');
  const sharp = req('sharp');
  const [native, { default: Credentials }, { default: AttachmentStore }, connection] =
    await Promise.all([
      load('@deepseek-ai/dsh-llm'),
      load('@deepseek-ai/dsh-credentials-local'),
      load('@deepseek-ai/dsh-attachment-local'),
      load('@deepseek-ai/dsh-client-connection'),
    ]);
  const root = await mkdtemp(join(tmpdir(), 'dsh-attachments-native-'));
  const ctx = new Context(),
    requests = [];
  let accounts;
  try {
    await ctx.plugin(Credentials, { path: join(root, 'temporary-credentials.yaml'), watch: false });
    await ctx.plugin(AttachmentStore, { dshHome: join(root, 'temporary-home') });
    await ctx.plugin(native.default);
    await ctx.plugin(connection, {});
    const plugin = createHostPlugin(
      native,
      (context) => {
        accounts = new AccountStore(context.credentials);
        const protocol = { revoke: async () => {} };
        const bridge = createAttachmentBridge(context, native);
        return {
          accounts,
          protocol,
          sessions: new SessionManager({ accounts, protocol }),
          attachments: bridge.store,
          restoreFiles: bridge.restoreFiles,
          fetchImpl: async (url, init) => {
            if (url === `${RESOURCE}/models`)
              return Response.json({
                models: [
                  {
                    slug: 'native-vision',
                    visibility: 'list',
                    input_modalities: ['text', 'image'],
                    supports_file_input: true,
                  },
                  { slug: 'native-text', visibility: 'list', input_modalities: ['text'] },
                  { slug: 'native-unknown', visibility: 'list' },
                ],
              });
            assert.equal(url, `${RESOURCE}/responses`, 'no Files API or remote attachment fetch');
            requests.push(JSON.parse(init.body));
            const response = {
              type: 'response.completed',
              response: {
                id: 'resp_attachment_fixture',
                status: 'completed',
                output: [
                  {
                    id: 'msg_attachment_fixture',
                    type: 'message',
                    role: 'assistant',
                    content: [
                      { type: 'output_text', text: 'synthetic-attachment-ok', annotations: [] },
                    ],
                  },
                ],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            return new Response(`data: ${JSON.stringify(response)}\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            });
          },
        };
      },
      { verifyCandidate: async () => {} },
    );
    await ctx.plugin(plugin);
    for (let i = 0; i < 100 && !accounts; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(accounts, 'attachment-aware source must register');
    const key = await accounts.beginRegistration('oaiapp_native_attachment_fixture');
    await accounts.saveValidated({
      clientId: 'oaiapp_native_attachment_fixture',
      issuer: ISSUER,
      subject: 'synthetic-attachment-user',
      accessToken: 'synthetic-attachment-access',
      refreshToken: 'synthetic-attachment-refresh',
      idToken: 'synthetic-attachment-id',
      expiresAt: Date.now() + 3600000,
      scopes: [DIRECT_SCOPE],
    });
    await accounts.select(key);
    const models = await ctx.llm.listModels(PROVIDER);
    assert.deepEqual(models.find((m) => m.id === 'native-vision').inputModalities, [
      'text',
      'image',
    ]);
    assert.deepEqual(models.find((m) => m.id === 'native-text').inputModalities, ['text']);
    assert.equal(models.find((m) => m.id === 'native-unknown').inputModalities, undefined);
    const png = await sharp({
      create: { width: 24, height: 24, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const image = await ctx.attachments.saveImage({
      data: png,
      mediaType: 'image/png',
      name: 'synthetic-red.png',
    });
    const txt = Buffer.from('synthetic native file sentinel');
    const textFile = await ctx.attachments.saveFile({ data: txt, name: 'fixture.txt' });
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    );
    const pdfFile = await ctx.attachments.saveFile({ data: pdf, name: 'fixture.pdf' });
    const verifiedVersion = await ctx.attachments.readImageRequest(image, {
      width: image.width,
      height: image.height,
      maxBytes: 4 * 1024 * 1024,
    });
    assert.ok(verifiedVersion.data.byteLength > 0);
    const verifiedFile = [];
    for await (const chunk of ctx.attachments.readFileStream(textFile)) verifiedFile.push(chunk);
    assert.deepEqual(Buffer.concat(verifiedFile), txt);
    const user = native.createUserMessage({
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', attachment: image },
        { type: 'text', text: 'between' },
        { type: 'file', attachment: textFile },
        { type: 'file', attachment: pdfFile },
      ],
    });
    const original = JSON.stringify(user);
    const collect = async (model, messages, extra = {}) => {
      const chunks = [];
      for await (const chunk of ctx.llm.stream({
        provider: PROVIDER,
        model,
        sessionId: 'native-attachment-session',
        messages,
        ...extra,
      }))
        chunks.push(chunk);
      return chunks;
    };
    const first = await collect('native-vision', [user]);
    assert.equal(first.at(-1).reason.kind, 'stop', JSON.stringify(first.at(-1).reason));
    const body = requests.at(-1),
      parts = body.input[0].content;
    assert.deepEqual(
      parts.map((p) => p.type),
      ['input_text', 'input_image', 'input_text', 'input_file', 'input_file'],
    );
    const imageBytes = Buffer.from(parts[1].image_url.split(',')[1], 'base64');
    const imageMetadata = await sharp(imageBytes).metadata();
    assert.equal(imageMetadata.width, 24);
    assert.equal(imageMetadata.height, 24);
    assert.deepEqual(Buffer.from(parts[3].file_data.split(',')[1], 'base64'), txt);
    assert.deepEqual(Buffer.from(parts[4].file_data.split(',')[1], 'base64'), pdf);
    assert.equal(parts[3].filename, 'fixture.txt');
    assert.equal(parts[4].filename, 'fixture.pdf');
    assert.equal(JSON.stringify(user), original, 'durable history is immutable');
    const reply = native.createAssistantMessage({
      content: [{ type: 'text', text: 'synthetic-attachment-ok' }],
      source: { provider: PROVIDER, model: 'native-vision' },
    });
    const again = await collect('native-vision', [
      user,
      reply,
      native.createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'follow up' }],
      }),
    ]);
    assert.equal(again.at(-1).reason.kind, 'stop');
    assert.deepEqual(
      requests.at(-1).input[0],
      body.input[0],
      'complete attachment history is replayed',
    );
    const fileOnly = native.createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'file', attachment: textFile }],
    });
    assert.equal((await collect('native-text', [fileOnly])).at(-1).reason.kind, 'stop');
    assert.equal(requests.at(-1).input[0].content[0].type, 'input_file');
    assert.equal((await collect('native-unknown', [user])).at(-1).reason.kind, 'stop');
    assert.equal(requests.at(-1).input[0].content[1].type, 'input_image');
    const imageOnly = native.createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'image', attachment: image }],
    });
    const beforeNegative = requests.length;
    const negative = await collect('native-text', [
      imageOnly,
      reply,
      native.createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'follow up after model switch' }],
      }),
    ]);
    assert.equal(
      negative.at(-1).reason.kind,
      'error',
      'native text projection must not silently drop retained image input',
    );
    assert.equal(negative.at(-1).reason.failure.code, 'ATTACHMENT_MODEL_UNSUPPORTED');
    assert.equal(
      requests.length,
      beforeNegative,
      'negative image capability sends no Responses request',
    );
    const preparedNegative = await ctx.llm.prepareCall({
      provider: PROVIDER,
      model: 'native-text',
    });
    const preparedChunks = [];
    for await (const chunk of preparedNegative.stream(
      Object.freeze({
        ...preparedNegative.config,
        sessionId: 'native-prepared-negative',
        messages: [imageOnly],
      }),
    ))
      preparedChunks.push(chunk);
    assert.equal(preparedChunks.at(-1).reason.failure.code, 'ATTACHMENT_MODEL_UNSUPPORTED');
    assert.equal(
      requests.length,
      beforeNegative,
      'prepared native dispatch also rejects before inference',
    );
    for (const [type, attachment] of [
      ['image', image],
      ['file', textFile],
    ]) {
      const nonUser = native.createAssistantMessage({
        content: [{ type, attachment }],
        source: { provider: PROVIDER, model: 'native-vision' },
      });
      const rejected = await collect('native-text', [nonUser]);
      assert.equal(rejected.at(-1).reason.failure.code, 'UNSUPPORTED_CONTENT');
      assert.equal(
        requests.length,
        beforeNegative,
        'non-user attachments send no Responses request',
      );
    }
    const offloaded = native.createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'image', attachment: image, offloaded: true }],
    });
    assert.equal((await collect('native-text', [offloaded])).at(-1).reason.kind, 'stop');
    assert.equal(requests.at(-1).input[0].content[0].type, 'input_text');
    assert.ok(!JSON.stringify(requests.at(-1)).includes('data:image/'));
    const abort = new AbortController();
    const variants = await Promise.all(
      ['ALPHA', 'BETA'].map(async (label) => {
        const bytes = Buffer.from(label);
        const ref = await ctx.attachments.saveFile({ data: bytes, name: `${label}.txt` });
        const m = native.createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'file', attachment: ref }],
        });
        return collect('native-text', [m], { signal: abort.signal });
      }),
    );
    assert.ok(variants.every((chunks) => chunks.at(-1).reason.kind === 'stop'));
    for (const request of requests.slice(-2)) {
      const part = request.input[0].content[0];
      assert.equal(
        Buffer.from(part.file_data.split(',')[1], 'base64').toString(),
        part.filename.slice(0, -4),
      );
    }
    const count = requests.length;
    const fixturePath = ctx.attachments.fileHostPath(textFile);
    assert.ok(fixturePath.startsWith(root), 'only corrupt the disposable fixture');
    // The native store correctly saves read-only files. Change permissions on
    // this disposable object only to exercise the integrity-failure path.
    await chmod(fixturePath, 0o600);
    await writeFile(fixturePath, 'corrupted fixture');
    const broken = await collect('native-text', [fileOnly]);
    assert.equal(broken.at(-1).reason.kind, 'error');
    assert.equal(broken.at(-1).reason.failure.code, 'ATTACHMENT_READ_FAILED');
    assert.equal(requests.length, count, 'corrupt file never reaches the upstream');
    return {
      nativeAttachmentStore: true,
      nativeInlineImages: true,
      nativeInlineFiles: true,
      nativeFileProjectionBridge: true,
      nativeAttachmentHistoryReplay: true,
      nativeUnknownModalityAccepted: true,
      nativeNegativeImageCapabilityGuard: true,
      nativePreparedNegativeImageCapabilityGuard: true,
      nativeNonUserAttachmentGuard: true,
      nativeOffloadedTextOnlyAccepted: true,
      nativeAttachmentScopeIsolation: true,
      nativeAttachmentIntegrityGuard: true,
    };
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
