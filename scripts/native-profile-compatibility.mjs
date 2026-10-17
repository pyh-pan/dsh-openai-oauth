// Exercise the installed boot policy with disposable profile/package metadata.
// No user profile, config, exemptions or credential files are opened here.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SUPPORTED_DSH_VERSIONS } from './host.mjs';
import { classifyDshVersion } from '../src/compatibility.js';

export async function verifyProfileCompatibility(asar) {
  const bootDir = join(asar, 'dsh/node_modules/@deepseek-ai/dsh-app-boot');
  const version = JSON.parse(await readFile(join(bootDir, 'package.json'), 'utf8')).version;
  // Historical validated releases may predate the boot-policy contract.
  // Every future candidate must exercise it, rather than silently skipping.
  if (['0.2.0-rc.2', '0.2.1-rc.1'].includes(version))
    return { profileCompatibilityPolicyTested: false };
  const boot = await import(pathToFileURL(join(bootDir, 'lib/index.js')).href);
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.equal(manifest.engines.dsh, undefined, 'use real peer requirements, not an override');
  for (const runtime of SUPPORTED_DSH_VERSIONS)
    assert.equal(boot.evaluatePluginCompatibility(manifest, {}, runtime), undefined);
  for (const runtime of ['0.2.1-rc.3', '0.2.1', '0.2.2-alpha.1', '0.2.9', '0.2.99-rc.1'])
    assert.equal(boot.evaluatePluginCompatibility(manifest, {}, runtime), undefined);
  // Cross-check the shared classifier against the actual installed SemVer policy.
  for (const runtime of [
    ...SUPPORTED_DSH_VERSIONS,
    '0.2.0-rc.2+build',
    '0.2.0',
    '0.2.0-rc.3',
    '0.2.1-alpha.1',
    '0.2.1-rc',
    '0.2.1-rc.0',
    '0.2.1-rc.1.0',
    '0.2.1-rc.3',
    '0.2.1-rc.999999999999999999999',
    '0.2.1',
    '0.2.2-alpha.1',
    '0.2.2',
    '0.2.99',
    '0.3.0-0',
    '0.3.0-alpha.1',
    '0.3.0',
    '1.0.0',
  ])
    assert.equal(
      boot.evaluatePluginCompatibility(manifest, {}, runtime) === undefined,
      classifyDshVersion(runtime) !== 'unsupported',
      `manifest/helper drift for ${runtime}`,
    );
  for (const runtime of ['0.3.0-0', '0.3.0-rc.1', '0.3.0', '9.0.0']) {
    const denied = boot.evaluatePluginCompatibility(manifest, {}, runtime);
    assert.ok(denied, `unexpected support for ${runtime}`);
    assert.equal(denied.exempted, false);
  }

  const dir = await mkdtemp(join(tmpdir(), 'dsh-siwc-profile-'));
  try {
    const pluginDir = join(dir, 'node_modules', ...manifest.name.split('/'));
    const sentinelName = '@fixture/existing-source';
    const sentinelDir = join(dir, 'node_modules', ...sentinelName.split('/'));
    await mkdir(pluginDir, { recursive: true });
    await mkdir(sentinelDir, { recursive: true });
    await writeFile(join(pluginDir, 'cordis.patch.yml'), patch);
    await writeFile(
      join(sentinelDir, 'package.json'),
      JSON.stringify({
        name: sentinelName,
        version: '1.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
    );
    await writeFile(
      join(sentinelDir, 'cordis.patch.yml'),
      '- insert:\n    - id: existing-source\n      name: existing-source\n',
    );
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        private: true,
        dsh: { profile: { bundles: [sentinelName, manifest.name] } },
      }),
    );
    const legacy = {
      ...manifest,
      version: '0.3.1',
      peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.0-rc.2 || 0.2.1-rc.1' },
    };
    await writeFile(join(pluginDir, 'package.json'), JSON.stringify(legacy));
    const load = () =>
      boot.loadProfileDirectory('dsh', dir, join(asar, 'dsh/package.json'), { userLayer: false });
    const compose = (profile) => boot.composeEntries(profile.layers.map((layer) => layer.patches));
    const legacyDenied = boot.evaluatePluginCompatibility(legacy, {}, version) !== undefined;
    const denied = load();
    // Rebuild metadata may still satisfy a historical peer. Do not make the
    // regression fixture itself introduce a false incompatibility for it.
    assert.equal(denied.skippedBundles.length, legacyDenied ? 1 : 0);
    if (legacyDenied) {
      assert.equal(denied.skippedBundles[0].packageName, manifest.name);
      assert.ok(denied.skippedBundles[0].reason.includes(`incompatible with dsh ${version}`));
    }
    assert.deepEqual(
      compose(denied).map((row) => row.id),
      legacyDenied ? ['existing-source'] : ['existing-source', 'chatgpt-subscription-login'],
    );

    await writeFile(join(pluginDir, 'package.json'), JSON.stringify(manifest));
    const allowed = load();
    assert.deepEqual(allowed.skippedBundles, []);
    assert.deepEqual(
      allowed.layers.map((layer) => layer.packageName),
      [sentinelName, manifest.name],
    );
    const rows = compose(allowed);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['existing-source', 'chatgpt-subscription-login'],
    );
    assert.equal(rows[1].name, manifest.name);
    assert.equal(rows[1].disabled, undefined);
    return {
      profileCompatibilityPolicyTested: true,
      legacyBundleDenied: legacyDenied,
      currentBundleLoadedWithoutExemption: true,
      existingProfileLayerPreserved: true,
      outsideFamilyDenied: true,
      candidateRangeMatchesInstalledPolicy: true,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
