import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findDesktop, inspectHost, hostEnvironment } from './host.mjs';
try {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--race')) throw Error('Only --race is supported');
  const host = findDesktop();
  inspectHost(host);
  const script = fileURLToPath(
    new URL(
      args.includes('--race') ? './native-session-race.mjs' : './native-siwc.mjs',
      import.meta.url,
    ),
  );
  const result = spawnSync(host.executable, ['--expose-internals', script], {
    env: hostEnvironment(host),
    stdio: 'inherit',
    shell: false,
    timeout: 90000,
  });
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
