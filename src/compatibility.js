// Evidence is not an admission whitelist. New release labels use the same contracts.
export const VALIDATED_DSH_VERSIONS = ['0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2'];
export const MINIMUM_DSH_VERSION = '0.2.0-rc.2';
export const DSH_COMPATIBILITY_RANGE = `>=${MINIMUM_DSH_VERSION}`;

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

export function classifyDshVersion(version) {
  const parsed = parseVersion(version);
  // A metadata probe failure is not a broken Interface. Actual contracts still apply.
  if (!parsed) return 'unknown';
  const { major, minor, patch, pre } = parsed;
  const aboveFloor =
    major > 0 ||
    (minor > 2 && major === 0) ||
    (major === 0 &&
      minor === 2 &&
      (patch > 0 ||
        !pre ||
        pre[0] > 'rc' ||
        (pre[0] === 'rc' &&
          pre.length >= 2 &&
          (!/^\d+$/.test(pre[1]) || pre[1].length > 1 || pre[1] >= '2'))));
  if (!aboveFloor) return 'unsupported';
  return VALIDATED_DSH_VERSIONS.includes(version) ? 'validated' : 'compatible';
}

// Diagnostics only: components may be versioned independently without changing contracts.
export const HOST_VERSION_FIELDS = [
  'llmVersion',
  'credentialsVersion',
  'connectionVersion',
  'bootVersion',
  'compactionVersion',
  'presetVersion',
  'presetRegistryVersion',
  'settingsModelsVersion',
  'modelSelectionVersion',
];

export function assessHost(info) {
  const status = classifyDshVersion(info.desktopVersion);
  if (status === 'unsupported') return { status, reason: 'UNSUPPORTED_DSH_VERSION' };
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
  // Version equality cannot prove module identity; the actual service class can.
  if (typeof native.default === 'function' && !(ctx.llm instanceof native.default))
    issues.push('llm.runtime-instance');
  if (issues.length) throw new Error(`DSH_HOST_CONTRACT_MISSING:${issues.join(',')}`);
  return { version, status };
}

// The historical operator-only carrier predates principals. Recognize its real
// exported class and admission Interface, never a release string or a bare flag.
export function isOperatorConnection(connection, nativeConnection) {
  return (
    typeof nativeConnection?.OperatorPeer === 'function' &&
    typeof nativeConnection.Peer !== 'function' &&
    connection.operator instanceof nativeConnection.OperatorPeer &&
    connection.operator.principal === undefined &&
    typeof connection.createPeer !== 'function' &&
    callable(connection, 'admit') &&
    callable(connection, 'requestRejection')
  );
}
