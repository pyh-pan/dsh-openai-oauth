import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { VALIDATED_DSH_VERSIONS, assessHost } from '../src/compatibility.js';
export { DSH_COMPATIBILITY_RANGE, assessHost } from '../src/compatibility.js';
export const SUPPORTED_DSH_VERSIONS = VALIDATED_DSH_VERSIONS;
export const SUPPORTED_DSH = SUPPORTED_DSH_VERSIONS.at(-1);
const scripts = dirname(fileURLToPath(import.meta.url));
const fail = (code) => {
  throw new Error(code);
};

export function findDesktop({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  exists = existsSync,
  bundleExecutable,
} = {}) {
  if (!['win32', 'darwin'].includes(platform)) fail('UNSUPPORTED_DESKTOP_PLATFORM');
  const p = platform === 'win32' ? win32 : posix;
  const candidates = [];
  if (env.DSH_APP) {
    if (!p.isAbsolute(env.DSH_APP)) fail('DSH_APP_MUST_BE_ABSOLUTE');
    candidates.push(env.DSH_APP);
  } else if (platform === 'win32') {
    if (env.LOCALAPPDATA)
      candidates.push(
        p.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
      );
    if (env.ProgramFiles)
      candidates.push(p.join(env.ProgramFiles, 'DeepSeek Harness', 'DeepSeek Harness.exe'));
  } else
    candidates.push(
      '/Applications/DeepSeek Harness.app',
      p.join(home, 'Applications', 'DeepSeek Harness.app'),
    );
  for (const candidate of candidates) {
    let executable = candidate,
      resources;
    if (platform === 'darwin' && candidate.endsWith('.app')) {
      let name;
      if (bundleExecutable) name = bundleExecutable(candidate);
      else {
        const plist = p.join(candidate, 'Contents', 'Info.plist');
        if (exists(plist)) {
          const probe = spawnSync(
            '/usr/bin/plutil',
            ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist],
            { encoding: 'utf8', timeout: 5000, shell: false },
          );
          if (probe.status === 0) name = probe.stdout.trim();
        }
      }
      if (name && !/^[A-Za-z0-9 ._-]{1,128}$/.test(name)) fail('UNSAFE_BUNDLE_EXECUTABLE');
      const names = [
        ...new Set([name, 'DeepSeek Harness', 'deepseek-harness', 'DSH'].filter(Boolean)),
      ];
      executable = names.map((n) => p.join(candidate, 'Contents', 'MacOS', n)).find(exists);
      resources = p.join(candidate, 'Contents', 'Resources');
    } else if (platform === 'darwin')
      resources = p.join(p.dirname(p.dirname(executable)), 'Resources');
    else resources = p.join(p.dirname(executable), 'resources');
    if (!executable || !exists(executable)) continue;
    const asar = env.DSH_ASAR ?? p.join(resources, 'app.asar');
    if (!p.isAbsolute(asar)) fail('DSH_ASAR_MUST_BE_ABSOLUTE');
    if (!exists(asar)) continue;
    return {
      platform,
      executable,
      asar,
      cli: p.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
      customLocation: !!env.DSH_APP,
    };
  }
  fail('DESKTOP_NOT_FOUND_SET_DSH_APP');
}

export function hostEnvironment(host, env = process.env) {
  const result = { ...env, ELECTRON_RUN_AS_NODE: '1', DSH_ASAR: host.asar };
  // A parent's debugging/profiling flags must not turn a helper into an inspector.
  delete result.NODE_OPTIONS;
  delete result.ELECTRON_ENABLE_LOGGING;
  // Root synthetic checks always allocate their own temporary store. Only
  // their owned race workers may set these controls explicitly.
  delete result.DSH_RACE_WORKER;
  delete result.DSH_RACE_DIR;
  return result;
}

export function readHostInfo(host, { spawn = spawnSync } = {}) {
  const result = spawn(host.executable, ['--expose-internals', join(scripts, 'host-info.mjs')], {
    env: hostEnvironment(host),
    encoding: 'utf8',
    timeout: 20000,
    shell: false,
  });
  if (result.status !== 0) fail('DESKTOP_NODE_INSPECTION_FAILED');
  let info;
  try {
    info = JSON.parse(result.stdout.trim());
  } catch {
    fail('DESKTOP_NODE_INSPECTION_INVALID');
  }
  if (info.platform !== host.platform || !info.cliAvailable)
    fail('DESKTOP_HOST_LAYOUT_UNSUPPORTED');
  return info;
}

export function isSupportedHost(info) {
  return assessHost(info).status !== 'unsupported';
}

export function inspectHost(host, options) {
  const info = readHostInfo(host, options);
  const assessment = assessHost(info);
  if (assessment.reason) fail(assessment.reason);
  return info;
}

export function runCandidateChecks(host, { spawn = spawnSync } = {}) {
  // No real profiles, credentials or upstreams: these scripts use disposable
  // stores. This is shared by installation and direct Desktop-update startup.
  for (const script of [
    'native-siwc.mjs',
    'native-session-race.mjs',
    'native-preset-integration.mjs',
    'native-provider-bootstrap.mjs',
  ]) {
    const checked = spawn(host.executable, ['--expose-internals', join(scripts, script)], {
      env: hostEnvironment(host),
      stdio: 'inherit',
      shell: false,
      timeout: 90000,
    });
    if (checked.status !== 0) fail('DSH_CANDIDATE_NATIVE_CHECK_FAILED');
  }
}

function isNativeRemoval(args) {
  if (args[0] !== 'plugin') return false;
  let index = 1;
  while (index < args.length) {
    if (args[index] === '--profile' && args[index + 1]) index += 2;
    else if (args[index].startsWith('--profile=')) index++;
    else break;
  }
  return args[index] === 'remove';
}

export function invokeCli(host, args, { spawn = spawnSync } = {}) {
  const info = inspectHost(host, { spawn });
  // A failed candidate must still be removable through the native manager.
  // Never infer a command from an arbitrary argument/package named "remove".
  if (assessHost(info).status === 'candidate' && !isNativeRemoval(args))
    runCandidateChecks(host, { spawn });
  const result = spawn(host.executable, ['--expose-internals', host.cli, ...args], {
    env: hostEnvironment(host),
    stdio: 'inherit',
    shell: false,
  });
  return result.status ?? 1;
}
