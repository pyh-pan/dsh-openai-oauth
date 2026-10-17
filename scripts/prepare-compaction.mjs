// Read-only profile composition; emits a NEW reviewable bundle, never installs.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findDesktop, inspectHost, hostEnvironment } from './host.mjs';
try {
  const host = findDesktop();
  inspectHost(host);
  const result = spawnSync(
    host.executable,
    [
      '--expose-internals',
      fileURLToPath(new URL('./prepare-compaction-native.mjs', import.meta.url)),
      ...process.argv.slice(2),
    ],
    { env: hostEnvironment(host), stdio: 'inherit', shell: false, timeout: 30000 },
  );
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
