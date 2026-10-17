// Reused by candidate native preflight and the optional compaction suite.
// Only public Schema validation, native registry metadata and synthetic input.
import assert from 'node:assert/strict';
import { createPluginConfig, normalizePluginConfig } from '../src/siwc/request-policy.js';

export function verifyNativeRequestPolicy(Schema) {
  const Config = createPluginConfig(Schema);
  const defaults = Config({});
  assert.equal(defaults.requestPolicy.responseHeadersTimeoutMs, 60000);
  assert.equal(defaults.requestPolicy.maxRetries, 5);
  const configured = Config({ requestPolicy: { responseHeadersTimeoutMs: 180000, maxRetries: 1 } });
  assert.equal(configured.requestPolicy.responseHeadersTimeoutMs, 180000);
  assert.equal(configured.requestPolicy.maxRetries, 1);
  // Optional Schemastery roots may pass null through; apply is the hard guard.
  assert.throws(() => normalizePluginConfig(Config(null)));
  for (const value of [
    { unknown: true },
    { requestPolicy: null },
    { requestPolicy: { responseHeadersTimeoutMs: 180000 } },
    { requestPolicy: { responseHeadersTimeoutMs: 180000, maxRetries: 5 } },
    { requestPolicy: { unexpected: true } },
  ])
    assert.throws(() => normalizePluginConfig(Config(value)));
  return true;
}
