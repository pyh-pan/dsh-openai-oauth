import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { BoundedLookup } from '../src/siwc/network-lookup.js';
import { createHostTransport } from '../src/siwc/network-transport.js';
import { OpenAIProtocol, TOKEN_ENDPOINT, RESOURCE } from '../src/siwc/protocol.js';
import { CLIENT } from './siwc-fixtures.js';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw Error('REAL_NETWORK_DISABLED_IN_FIXTURE');
};
test.after(() => {
  globalThis.fetch = originalFetch;
});
const publicAddress = (value) => value === '1.1.1.1' || value === '2606:4700:4700::1111';
const exchange = (protocol) =>
  protocol.exchange({
    grant_type: 'refresh_token',
    client_id: CLIENT,
    refresh_token: 'synthetic',
    resource: RESOURCE,
  });

function wire({
  hold = false,
  secure = true,
  status = 200,
  headers = {},
  body = '{"ok":true}',
} = {}) {
  const calls = [];
  const agent = {
    destroyed: 0,
    destroy() {
      this.destroyed++;
    },
  };
  const request = (url, options, receive) => {
    const req = new EventEmitter();
    const call = { url, options, content: undefined, ended: false };
    calls.push(call);
    const keep = setTimeout(() => req.destroy(Error('synthetic late failure')), 1000);
    req.destroy = (error) => {
      clearTimeout(keep);
      if (error) queueMicrotask(() => req.emit('error', error));
    };
    req.end = (content) => {
      call.content = content;
      call.ended = true;
      assert.equal(transport.stateFor(options.signal)?.writeOutcome ?? 'unknown', 'unknown');
      if (hold) return;
      clearTimeout(keep);
      const response = new PassThrough();
      response.statusCode = status;
      response.headers = headers;
      response.complete = true;
      receive(response);
      response.end(body);
    };
    queueMicrotask(() =>
      options.lookup(url.hostname, { all: true, family: 0 }, (error) => {
        if (error) {
          req.destroy(error);
          return;
        }
        const socket = new EventEmitter();
        socket.encrypted = true;
        socket.authorized = false;
        socket.connecting = true;
        req.emit('socket', socket);
        socket.emit('connect');
        if (secure) {
          socket.authorized = true;
          socket.connecting = false;
          socket.emit('secureConnect');
        }
      }),
    );
    return req;
  };
  const transport = createHostTransport({
    proxyRouteFor: () => ({ proxied: false }),
    isPublicAddress: publicAddress,
    hostOverride: async () => false,
    dnsPolicy: async () => ({ servers: ['127.0.0.1'] }),
    lookup: { resolve: async () => [{ address: '1.1.1.1', family: 4 }] },
    request,
    agent,
  });
  return { transport, calls, agent };
}

test('configured-server DNS is bounded, shared, cached and does not invoke OS getaddrinfo', async () => {
  let calls = 0,
    cancelled = 0;
  const resolver = new BoundedLookup({
    isPublicAddress: publicAddress,
    queryTimeoutMs: 10,
    resolver: () => ({
      resolve4: async () => {
        calls++;
        return ['1.1.1.1'];
      },
      resolve6: () => new Promise(() => {}),
      cancel() {
        cancelled++;
      },
    }),
  });
  const values = await Promise.all(
    Array.from({ length: 12 }, () => resolver.resolve('auth.openai.com')),
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
  assert.ok(values.every((v) => v[0].address === '1.1.1.1'));
  values[0][0].address = '127.0.0.1';
  assert.equal((await resolver.resolve('auth.openai.com'))[0].address, '1.1.1.1');
});

test('a mixed public/private DNS answer is rejected as a whole', async () => {
  const resolver = new BoundedLookup({
    isPublicAddress: publicAddress,
    resolver: () => ({
      resolve4: async () => ['1.1.1.1', '127.0.0.1'],
      resolve6: async () => [],
      cancel() {},
    }),
  });
  await assert.rejects(resolver.resolve('auth.openai.com'), {
    code: 'SIWC_NETWORK_ADDRESS_BLOCKED',
  });
});

test('proxy and unknown routes leave Host fetch in control, never reading proxy credentials or resolving locally', async () => {
  for (const route of [
    {
      proxied: true,
      get proxy() {
        throw Error('must not read proxy secret');
      },
    },
    undefined,
  ]) {
    let fetched = 0,
      hostReads = 0;
    const transport = createHostTransport({
      proxyRouteFor: () => route,
      isPublicAddress: publicAddress,
      hostOverride: async () => {
        hostReads++;
        return false;
      },
      lookup: {
        resolve() {
          throw Error('must not resolve proxy target');
        },
      },
      request() {
        throw Error('must not bypass Host');
      },
      fetchImpl: async () => {
        fetched++;
        return Response.json({ ok: true });
      },
    });
    try {
      assert.equal((await transport.fetch(TOKEN_ENDPOINT)).status, 200);
      assert.equal(fetched, 1);
      assert.equal(hostReads, 0);
    } finally {
      transport.dispose();
    }
  }
});

test('explicit hosts overrides and unavailable public-address capability preserve Host transport', async () => {
  for (const capability of [true, false]) {
    let fetched = 0;
    const transport = createHostTransport({
      proxyRouteFor: () => ({ proxied: false }),
      ...(capability ? { isPublicAddress: publicAddress } : {}),
      hostOverride: async () => true,
      request() {
        throw Error('must preserve Host');
      },
      fetchImpl: async () => {
        fetched++;
        return new Response(null, { status: 204 });
      },
    });
    try {
      await transport.fetch(TOKEN_ENDPOINT);
      assert.equal(fetched, 1);
    } finally {
      transport.dispose();
    }
  }
});

test('private transport preserves body and strict original-host TLS, handles compressed JSON and disposes only its Agent', async () => {
  const encoded = gzipSync('{"ok":true}');
  const { transport, calls, agent } = wire({
    headers: { 'content-encoding': 'gzip', 'content-length': String(encoded.length) },
    body: encoded,
  });
  try {
    const response = await transport.fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      body: 'grant_type=synthetic',
      headers: { authorization: 'synthetic-only' },
    });
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(calls[0].content, 'grant_type=synthetic');
    assert.equal(calls[0].options.servername, 'auth.openai.com');
    assert.equal(calls[0].options.rejectUnauthorized, true);
    assert.equal(calls[0].options.autoSelectFamilyAttemptTimeout, 2000);
  } finally {
    transport.dispose();
    transport.dispose();
  }
  assert.equal(agent.destroyed, 1);
});

test('redirects are not followed; arbitrary origins, credentials, paths and queries never dispatch', async () => {
  const { transport, calls } = wire({ status: 302 });
  try {
    for (const target of [
      'http://auth.openai.com',
      'https://evil.invalid',
      'https://user:secret@auth.openai.com',
      'https://api.openai.com/v1/files',
      'https://auth.openai.com/a?secret=private',
    ])
      await assert.rejects(transport.fetch(target), { code: 'SIWC_ORIGIN_BLOCKED' });
    assert.equal(calls.length, 0);
    await assert.rejects(transport.fetch(TOKEN_ENDPOINT), { code: 'SIWC_REDIRECT_BLOCKED' });
    assert.equal(calls.length, 1);
  } finally {
    transport.dispose();
  }
});

test('deadline before TLS is proven not sent, while deadline after TLS stays uncertain', async () => {
  for (const secure of [false, true]) {
    const { transport, calls } = wire({ hold: true, secure });
    const protocol = new OpenAIProtocol({
      fetchImpl: transport.fetch,
      stateFor: transport.stateFor,
      timeoutMs: 20,
    });
    try {
      await assert.rejects(exchange(protocol), (error) => {
        assert.equal(error.code, secure ? 'AUTH_REQUEST_UNCONFIRMED' : 'AUTH_CONNECT_FAILED');
        assert.equal(error.renewalOutcome, secure ? 'unknown' : 'not_sent');
        return true;
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].ended, secure, 'no request end/write is allowed before verified TLS');
    } finally {
      transport.dispose();
    }
  }
});

test('an earlier connect timeout cannot prove that a later attempt was not sent', async () => {
  const { transport } = wire({ hold: true, secure: true });
  let calls = 0;
  const fetchImpl = async (url, options) => {
    if (++calls === 1)
      throw new TypeError('synthetic', {
        cause: Object.assign(Error('synthetic'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      });
    return transport.fetch(url, options);
  };
  const protocol = new OpenAIProtocol({ fetchImpl, stateFor: transport.stateFor, timeoutMs: 150 });
  try {
    await assert.rejects(exchange(protocol), {
      code: 'AUTH_REQUEST_UNCONFIRMED',
      renewalOutcome: 'unknown',
    });
    assert.equal(calls, 2);
  } finally {
    transport.dispose();
  }
});
