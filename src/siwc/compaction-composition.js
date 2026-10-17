import path from 'node:path';

export function isWithinDirectory(parent, target, implementation = path) {
  const relative = implementation.relative(parent, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${implementation.sep}`) &&
      !implementation.isAbsolute(relative))
  );
}

const BASIC = '@deepseek-ai/dsh-compaction-basic';
const COMPAT = '@pyh-pan/dsh-openai-oauth/compaction';
const error = (code) => {
  throw new Error(code);
};

// A whole declaration must be preserved because Loader config overrides are
// replacement, not deep merge. No profile files are written by this transform.
export function compactionPresetPatch(presetRow) {
  const copy = structuredClone(presetRow);
  if (
    copy?.name !== '@deepseek-ai/dsh-agent-preset' ||
    !copy.id ||
    !Array.isArray(copy.config?.plugins)
  )
    error('SIWC_PRESET_DECLARATION_UNSUPPORTED');
  let replaced = 0;
  const walk = (rows) => {
    for (const row of rows) {
      if (
        typeof row?.name === 'string' &&
        (/^[./\\\\]/.test(row.name) || /^[A-Za-z]:/.test(row.name))
      )
        error('SIWC_PRESET_RELATIVE_MODULE_UNSUPPORTED');
      if (row?.name === BASIC || row?.name === COMPAT)
        error('SIWC_COMPACTION_REQUIRES_ISOLATED_GROUP');
      if (row?.name !== 'cordis:group') continue;
      if (!Array.isArray(row.config)) error('SIWC_PRESET_DYNAMIC_GROUP_UNSUPPORTED');
      if (row.isolate?.compaction !== undefined) {
        if (!row.isolate.compaction || row.disabled) error('SIWC_COMPACTION_GROUP_UNSUPPORTED');
        const owners = row.config.filter((child) => [BASIC, COMPAT].includes(child.name));
        const allowed = new Set([
          BASIC,
          '@deepseek-ai/dsh-command-compact',
          '@deepseek-ai/dsh-compaction-tool-result-pruner',
        ]);
        if (
          owners.length !== 1 ||
          owners[0].name !== BASIC ||
          owners[0].disabled ||
          row.config.some((child) => !allowed.has(child.name))
        )
          error('SIWC_COMPACTION_OWNER_UNSUPPORTED');
        const owner = owners[0];
        owner.name = COMPAT;
        owner.config = {
          basic: owner.config ?? {},
          summaryTimeoutMs: 300000,
          maxSummaryBytes: 262144,
        };
        replaced++;
      } else walk(row.config);
    }
  };
  walk(copy.config.plugins);
  if (replaced !== 1) error('SIWC_COMPACTION_OWNER_COUNT');
  return { id: copy.id, name: copy.name, config: copy.config };
}

// Refuse known credential carriers before producing a portable declaration.
// This is a conservative leak guard, not proof arbitrary plugin text is public.
export function assertNoEmbeddedCredentials(value) {
  const visit = (v) => {
    if (
      typeof v === 'string' &&
      (/Bearer\s+\S+/i.test(v) ||
        /\bsk-[A-Za-z0-9_-]{24,}/.test(v) ||
        /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(v))
    )
      error('SIWC_PRESET_MAY_CONTAIN_CREDENTIALS');
    if (v && typeof v === 'object')
      for (const [key, entry] of Object.entries(v)) {
        if (
          /^(?:accessToken|refreshToken|idToken|apiKey|password|authorization|clientSecret|secret)$/i.test(
            key,
          ) &&
          entry
        )
          error('SIWC_PRESET_MAY_CONTAIN_CREDENTIALS');
        visit(entry);
      }
  };
  visit(value);
}
