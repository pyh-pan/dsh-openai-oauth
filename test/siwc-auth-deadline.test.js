import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProtocol, RESOURCE } from '../src/siwc/protocol.js';
import { CLIENT } from './siwc-fixtures.js';

test('a token response body ignoring abort cannot hold refresh beyond its request deadline', async () => {
  let controller;
  const body = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  const protocol = new OpenAIProtocol({
    timeoutMs: 15,
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  const operation = protocol
    .exchange({
      grant_type: 'refresh_token',
      client_id: CLIENT,
      refresh_token: 'synthetic-refresh',
      resource: RESOURCE,
    })
    .then(
      () => 'unexpected-success',
      (error) => error,
    );
  let timer;
  try {
    const result = await Promise.race([
      operation,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('stalled'), 80);
      }),
    ]);
    assert.notEqual(
      result,
      'stalled',
      'headers receipt must not end the authorization deadline boundary',
    );
    assert.equal(result instanceof Error, true);
  } finally {
    clearTimeout(timer);
    try {
      controller.close();
    } catch {
      /* The fixed implementation may already have cancelled it. */
    }
    await operation;
  }
});
