import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findDesktop, inspectHost, hostEnvironment } from './host.mjs';
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((a) => !['--race', '--compaction', '--presets'].includes(a)))
    throw Error('Only --race, --compaction or --presets is supported');
  const host = findDesktop();
  inspectHost(host);
  const script = fileURLToPath(
    new URL(
      args.includes('--race')
        ? './native-session-race.mjs'
        : args.includes('--compaction')
          ? './native-compaction.mjs'
          : args.includes('--presets')
            ? './native-preset-integration.mjs'
            : './native-siwc.mjs',
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
  if (args.includes('--presets') && process.exitCode === 0) {
    const bootstrap = spawnSync(
      host.executable,
      [
        '--expose-internals',
        fileURLToPath(new URL('./native-provider-bootstrap.mjs', import.meta.url)),
      ],
      { env: hostEnvironment(host), stdio: 'inherit', shell: false, timeout: 90000 },
    );
    process.exitCode = bootstrap.status ?? 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
