import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import {
  compactionPresetPatch,
  assertNoEmbeddedCredentials,
  isWithinDirectory,
} from '../src/siwc/compaction-composition.js';
import { readCompactionProfile } from '../scripts/compaction-profile.mjs';
const nativeName = '@deepseek-ai/dsh-compaction-basic';
const declaration = () => ({
  id: 'preset-standard',
  name: '@deepseek-ai/dsh-agent-preset',
  config: {
    id: 'standard',
    order: 1,
    plugins: [
      { id: 'unrelated', name: 'fixture', config: { exact: { __jsExpr: 'process.platform' } } },
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true, toolResultPruner: true },
        config: [
          {
            id: 'compaction-basic',
            name: nativeName,
            config: {
              maxTokens: 1234,
              auto: true,
              modelPolicies: [
                {
                  provider: 'other',
                  model: 'custom',
                  summarizationProvider: 'third',
                  summarizationModel: 'special',
                },
              ],
            },
          },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        ],
      },
    ],
  },
});
test('whole preset replacement changes exactly one owner and preserves native config', () => {
  const source = declaration(),
    original = structuredClone(source),
    patch = compactionPresetPatch(source);
  assert.deepEqual(source, original);
  assert.deepEqual(patch.config.plugins[0], source.config.plugins[0]);
  const row = patch.config.plugins[1].config[0];
  assert.equal(row.name, '@pyh-pan/dsh-openai-oauth/compaction');
  assert.deepEqual(row.config.basic, source.config.plugins[1].config[0].config);
  assert.deepEqual(patch.config.plugins[1].isolate, source.config.plugins[1].isolate);
  assert.equal(patch.config.order, 1);
});
test('unknown or duplicate backend cannot silently create two transaction owners', () => {
  for (const change of [
    (p) => p.config.plugins[1].config.push({ name: nativeName }),
    (p) => p.config.plugins[1].config.push({ name: 'unknown-backend' }),
    (p) => {
      p.config.plugins[1].config[0].disabled = true;
    },
    (p) => {
      delete p.config.plugins[1].isolate;
    },
  ]) {
    const p = declaration();
    change(p);
    assert.throws(() => compactionPresetPatch(p), /SIWC_/);
  }
});
test('Windows directory exclusion compares path identity, not string casing', () => {
  assert.equal(
    isWithinDirectory('C:\\DSH\\profiles\\desktop', 'c:\\dsh\\PROFILES\\desktop\\review', win32),
    true,
  );
  assert.equal(
    isWithinDirectory(
      'C:\\DSH\\profiles\\desktop',
      'C:\\DSH\\profiles\\desktop-other\\review',
      win32,
    ),
    false,
  );
});
test('profile preparation uses only read-only primitives and refuses higher priority overrides', () => {
  const target = declaration(),
    seen = [];
  let high = [];
  const boot = {
    PROFILE_PATCH_FILENAME: 'cordis.patch.yml',
    loadProfileDirectory() {
      throw new Error('Must never call mutating profile loader');
    },
    readProfileManifest: (prefix, dir) =>
      dir === '/profile'
        ? { dsh: { profile: { bundles: ['fixture'] } } }
        : { dsh: { bundle: { patch: 'patch.yml' } } },
    resolveBundleDir: () => '/bundle',
    evaluatePluginCompatibility: () => undefined,
    bundlePatchPaths: () => ['/bundle/patch.yml'],
    loadOverlayPatches: () => [{ insert: [target] }],
    loadOptionalPatches: (prefix, file) => {
      seen.push(file);
      return file.startsWith('/home/') ? high : [];
    },
    composeEntries: () => [target],
  };
  const args = {
    profileDir: '/profile',
    home: '/home',
    installAnchor: '/installation/package.json',
    runtimeVersion: '0.2.1-rc.2',
    presetId: 'standard',
    join: (...parts) => parts.join('/'),
  };
  assert.equal(readCompactionProfile(boot, args).target, target);
  assert.equal(seen.length, 2);
  high = [{ id: 'preset-standard', config: { plugins: [] } }];
  assert.throws(() => readCompactionProfile(boot, args), /HIGHER_PRIORITY_OVERRIDE/);
  boot.readProfileManifest = () => ({
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-experimental-schedule-bundle'] } },
  });
  assert.throws(() => readCompactionProfile(boot, args), /REQUIRES_NATIVE_MIGRATION/);
});
test('credential carriers refuse portable declaration without printing their value', () => {
  assert.doesNotThrow(() => assertNoEmbeddedCredentials(declaration()));
  for (const value of [
    { apiKey: 'fixture-sensitive' },
    { nested: ['Bearer fixture-sensitive'] },
    { refreshToken: 'fixture-sensitive' },
  ])
    assert.throws(() => assertNoEmbeddedCredentials(value), /SIWC_PRESET_MAY_CONTAIN_CREDENTIALS/);
});
