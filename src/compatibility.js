// One policy for package metadata, install helpers and the production Host guard.
// A candidate is eligible for contract testing, NOT evidence of a future release.
export const VALIDATED_DSH_VERSIONS = ['0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2'];
export const DSH_COMPATIBILITY_RANGE = '0.2.0-rc.2 || >=0.2.1-rc.1 <0.3.0-0';

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 128) return;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match || match[0] !== value) return;
  const numbers = match.slice(1, 4).map(Number);
  const pre = match[4]?.split('.');
  if (numbers.some((n) => !Number.isSafeInteger(n))) return;
  if (pre?.some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith('0'))) return;
  return { major: numbers[0], minor: numbers[1], patch: numbers[2], pre };
}

// Compare just prerelease identifiers with rc.1, without coercing arbitrary-length
// numeric identifiers to imprecise JS numbers. Release/build handling is separate.
function atLeastRc1(pre) {
  if (!pre) return true;
  if (/^\d+$/.test(pre[0])) return false;
  if (pre[0] !== 'rc') return pre[0] > 'rc';
  if (pre.length < 2) return false;
  if (!/^\d+$/.test(pre[1])) return true;
  return pre[1] !== '0';
}

export function classifyDshVersion(version) {
  const parsed = parseVersion(version);
  const eligible =
    parsed?.major === 0 &&
    parsed.minor === 2 &&
    ((parsed.patch === 0 && parsed.pre?.join('.') === 'rc.2') ||
      (parsed.patch === 1 && atLeastRc1(parsed.pre)) ||
      parsed.patch > 1);
  if (!eligible) return 'unsupported';
  return VALIDATED_DSH_VERSIONS.includes(version) ? 'validated' : 'candidate';
}

export const HOST_VERSION_FIELDS = [
  'llmVersion',
  'credentialsVersion',
  'connectionVersion',
  'bootVersion',
  'settingsModelsVersion',
  'modelSelectionVersion',
];

export function assessHost(info) {
  const status = classifyDshVersion(info.desktopVersion);
  if (status === 'unsupported') return { status, reason: 'UNSUPPORTED_DSH_VERSION' };
  if (HOST_VERSION_FIELDS.some((field) => info[field] !== info.desktopVersion))
    return { status: 'unsupported', reason: 'DSH_COMPONENT_VERSION_MISMATCH' };
  if (!Array.isArray(info.contractIssues) || info.contractIssues.length)
    return { status: 'unsupported', reason: 'DSH_HOST_CONTRACT_MISSING' };
  return { status, reason: null };
}

const callable = (target, key) => typeof target?.[key] === 'function';
export function nativeContractIssues(native) {
  return ['LlmAdapter', 'LlmError', 'attributionHeaders']
    .filter((name) => !callable(native, name))
    .map((name) => `llm.${name}`);
}

export function serviceContractIssues(ctx) {
  const requirements = [
    [ctx, 'effect', 'context.effect'],
    [ctx, 'on', 'context.on'],
    [ctx.llm, 'registerAdapter', 'llm.registerAdapter'],
    [ctx.credentials, 'readRecord', 'credentials.readRecord'],
    [ctx.credentials, 'listRecords', 'credentials.listRecords'],
    [ctx.credentials, 'modifyRecord', 'credentials.modifyRecord'],
    [ctx.connection?.fetch, 'register', 'connection.fetch.register'],
    [ctx.connection, 'createSharedFetchHandler', 'connection.createSharedFetchHandler'],
  ];
  return requirements.filter(([target, key]) => !callable(target, key)).map(([, , name]) => name);
}

export function assertHostContract(native, ctx) {
  const version = native.APP_IDENTITY?.version;
  const status = classifyDshVersion(version);
  if (status === 'unsupported') throw new Error('UNSUPPORTED_DSH_VERSION');
  const issues = [...nativeContractIssues(native), ...serviceContractIssues(ctx)];
  if (issues.length) throw new Error(`DSH_HOST_CONTRACT_MISSING:${issues.join(',')}`);
  return { version, status };
}
