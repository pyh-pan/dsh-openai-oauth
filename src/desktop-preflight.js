import { findDesktop, inspectHost, runCandidateChecks } from '../scripts/host.mjs';
import { assessHost } from './compatibility.js';

// Direct Desktop updates bypass the install helper. Before any real account
// runtime is created on a candidate, test the SAME executable that is running
// this plugin. Do not honor a possibly unrelated DSH_APP/DSH_ASAR override.
export function validateRunningCandidate(
  version,
  {
    executable = process.execPath,
    platform = process.platform,
    find = findDesktop,
    inspect = inspectHost,
    check = runCandidateChecks,
  } = {},
) {
  const host = find({ platform, env: { DSH_APP: executable } });
  const info = inspect(host);
  if (info.desktopVersion !== version || assessHost(info).status !== 'candidate')
    throw new Error('DSH_RUNNING_INSTALLATION_MISMATCH');
  check(host);
}
