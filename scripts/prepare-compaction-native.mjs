import { isDeepStrictEqual } from 'node:util';
import { mkdir, writeFile, copyFile, readFile, realpath, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  compactionPresetPatch,
  assertNoEmbeddedCredentials,
  isWithinDirectory,
} from '../src/siwc/compaction-composition.js';
import { readCompactionProfile } from './compaction-profile.mjs';

async function main() {
  const args = process.argv.slice(2),
    options = {};
  if (args.length % 2)
    throw new Error(
      'Use --profile NAME --preset ID --runtime-overlays none --output NEW_DIRECTORY',
    );
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--profile', '--preset', '--output', '--runtime-overlays'].includes(args[i]) ||
      options[args[i]]
    )
      throw new Error('SIWC_PREPARE_ARGUMENTS_INVALID');
    options[args[i]] = args[i + 1];
  }
  const profileName = options['--profile'] ?? 'desktop';
  const presetId = options['--preset'] ?? 'standard';
  if (
    !/^[a-z0-9-]+$/.test(profileName) ||
    !/^[a-z0-9-]+$/.test(presetId) ||
    !options['--output'] ||
    !isAbsolute(options['--output'])
  )
    throw new Error('SIWC_PREPARE_ARGUMENTS_INVALID');
  // Launcher-only overlays cannot be recovered from a profile directory. Require
  // an explicit operator assertion, then verify the installed live composition.
  if (options['--runtime-overlays'] !== 'none')
    throw new Error('SIWC_RUNTIME_OVERLAYS_REQUIRE_EXPLICIT_REVIEW');
  const asar = process.env.DSH_ASAR;
  if (!asar) throw new Error('Set DSH_ASAR');
  const req = createRequire(pathToFileURL(join(asar, 'dsh/package.json')));
  const boot = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href);
  const yaml = req('js-yaml');
  const basic = JSON.parse(
    await readFile(req.resolve('@deepseek-ai/dsh-compaction-basic/package.json'), 'utf8'),
  );
  if (basic.version !== '0.2.1-rc.2') throw new Error('DSH_SIWC_COMPACTION_VERSION_UNVALIDATED');
  const home = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const profileDir =
    process.env.DSH_PROFILE_DIR && process.env.DSH_PROFILE === profileName
      ? process.env.DSH_PROFILE_DIR
      : join(home, 'profiles', profileName);
  const output = resolve(options['--output']);
  const profilesRoot = join(home, 'profiles');
  // Keep lexical evidence too: a child profile junction can point outside the
  // physical profiles root. Also exclude every known child profile's real root.
  for (const root of [resolve(profileDir), resolve(profilesRoot)])
    if (isWithinDirectory(root, output)) throw new Error('SIWC_OUTPUT_MUST_NOT_BE_PROFILE');
  const profileRoots = [await realpath(profileDir), await realpath(profilesRoot)];
  for (const entry of await readdir(profilesRoot, { withFileTypes: true }))
    if (entry.isDirectory() || entry.isSymbolicLink())
      profileRoots.push(await realpath(join(profilesRoot, entry.name)));
  const parent = await realpath(dirname(output));
  const intendedOutput = join(parent, basename(output));
  for (const root of profileRoots)
    if (isWithinDirectory(root, intendedOutput)) throw new Error('SIWC_OUTPUT_MUST_NOT_BE_PROFILE');
  // Only audited read-only primitives. In particular NOT loadProfileDirectory,
  // which can migrate a manifest even when merely asked to load a profile.
  const { layers, userLayers, target } = readCompactionProfile(boot, {
    profileDir,
    home,
    installAnchor: join(asar, 'dsh/package.json'),
    runtimeVersion: basic.version,
    presetId,
    join,
  });
  const patch = compactionPresetPatch(target);
  assertNoEmbeddedCredentials(patch);
  const js = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    predicate: (value) =>
      value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string',
    represent: (value) => value.__jsExpr,
    construct: (value) => ({ __jsExpr: value }),
  });
  const schema = yaml.DEFAULT_SCHEMA.extend([js]);
  const serialized = yaml.dump([patch], { schema, noRefs: true, lineWidth: -1 });
  const roundtrip = boot.loadOverlayPatches;
  // Native parser and the actual installed patch precedence must both preserve
  // the intended result. Serialization-only validation happens before any write.
  if (!isDeepStrictEqual(yaml.load(serialized, { schema }), [patch]))
    throw new Error('SIWC_PRESET_SERIALIZATION_MISMATCH');
  const composed = boot.composeEntries([...layers, [patch], ...userLayers]);
  if (!isDeepStrictEqual(composed.find((row) => row.id === patch.id)?.config, patch.config))
    throw new Error('SIWC_PRESET_PRECEDENCE_MISMATCH');
  // mkdir without recursive refuses any existing target, including junctions.
  await mkdir(output);
  const actualOutput = await realpath(output);
  if (
    process.platform === 'win32'
      ? actualOutput.toLowerCase() !== intendedOutput.toLowerCase()
      : actualOutput !== intendedOutput
  )
    throw new Error('SIWC_OUTPUT_PARENT_CHANGED');
  for (const root of profileRoots)
    if (isWithinDirectory(root, actualOutput)) throw new Error('SIWC_OUTPUT_MUST_NOT_BE_PROFILE');
  const manifest = {
    name: '@local/dsh-siwc-compaction-compat',
    version: '1.0.0',
    private: true,
    type: 'module',
    engines: { dsh: '0.2.1-rc.2' },
    description: 'Reviewed native SIWC compaction preset replacement. No server token hard cap.',
    exports: { './locale/*.json': './locale/*.json', './icon': './icon.svg' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  };
  await mkdir(join(output, 'locale'));
  await writeFile(join(output, 'cordis.patch.yml'), serialized);
  if (!isDeepStrictEqual(roundtrip('dsh', join(output, 'cordis.patch.yml')), [patch]))
    throw new Error('SIWC_NATIVE_PRESET_PARSE_MISMATCH');
  for (const locale of ['en', 'zh'])
    await copyFile(
      new URL(`../src/locale/compaction/${locale}.json`, import.meta.url),
      join(output, 'locale', `${locale}.json`),
    );
  await copyFile(new URL('../src/compaction-icon.svg', import.meta.url), join(output, 'icon.svg'));
  // Publish an installable bundle manifest only after every artifact validates.
  await writeFile(join(output, 'package.json'), JSON.stringify(manifest, null, 2));
  console.log(
    JSON.stringify({
      prepared: true,
      profile: profileName,
      preset: presetId,
      replacedBackendCount: 1,
      originalNativeConfigPreserved: true,
      profileFilesWritten: false,
      installed: false,
      credentialsRead: false,
      runtimeOverlays: 'operator-declared-none-not-live-verified',
      output,
    }),
  );
}
try {
  await main();
} catch (error) {
  // Native YAML errors may carry the entire source buffer. Never print an
  // arbitrary message/stack/cause from a user's profile or bundle parser.
  const allowed = new Set([
    'SIWC_PREPARE_ARGUMENTS_INVALID',
    'SIWC_RUNTIME_OVERLAYS_REQUIRE_EXPLICIT_REVIEW',
    'DSH_SIWC_COMPACTION_VERSION_UNVALIDATED',
    'SIWC_OUTPUT_MUST_NOT_BE_PROFILE',
    'SIWC_OUTPUT_PARENT_CHANGED',
    'SIWC_PROFILE_BUNDLE_LIST_UNSUPPORTED',
    'SIWC_PROFILE_REQUIRES_NATIVE_MIGRATION',
    'SIWC_PROFILE_BUNDLE_CONTRACT_UNSUPPORTED',
    'SIWC_PRESET_NOT_FOUND_OR_DISABLED',
    'SIWC_PRESET_HIGHER_PRIORITY_OVERRIDE_REQUIRES_REVIEW',
    'SIWC_PRESET_DECLARATION_UNSUPPORTED',
    'SIWC_PRESET_RELATIVE_MODULE_UNSUPPORTED',
    'SIWC_COMPACTION_REQUIRES_ISOLATED_GROUP',
    'SIWC_PRESET_DYNAMIC_GROUP_UNSUPPORTED',
    'SIWC_COMPACTION_GROUP_UNSUPPORTED',
    'SIWC_COMPACTION_OWNER_UNSUPPORTED',
    'SIWC_COMPACTION_OWNER_COUNT',
    'SIWC_PRESET_MAY_CONTAIN_CREDENTIALS',
    'SIWC_PRESET_SERIALIZATION_MISMATCH',
    'SIWC_PRESET_PRECEDENCE_MISMATCH',
    'SIWC_NATIVE_PRESET_PARSE_MISMATCH',
  ]);
  console.error(allowed.has(error?.message) ? error.message : 'SIWC_COMPACTION_PREPARE_FAILED');
  process.exitCode = 1;
}
