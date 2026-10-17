import { reject } from './protocol.js';
const names = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
};
// These labels do not invent capabilities: only the account catalog's actual
// entries become choices. Unknown future IDs retain their verbatim wire value.
export function reasoningCapabilities(entry) {
  const levels = entry.supported_reasoning_levels;
  if (levels == null || (Array.isArray(levels) && levels.length === 0)) return undefined;
  if (!Array.isArray(levels) || levels.length > 16) reject('MODEL_CATALOG_INVALID', 502);
  const seen = new Set();
  const efforts = levels.map((level) => {
    const id = typeof level === 'string' ? level : level?.effort;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(id) || seen.has(id))
      reject('MODEL_CATALOG_INVALID', 502);
    seen.add(id);
    return {
      id,
      name: Object.hasOwn(names, id) ? names[id] : id,
      ...(typeof level?.description === 'string'
        ? { description: level.description.slice(0, 2048) }
        : {}),
    };
  });
  const defaultEffort = entry.default_reasoning_level;
  if (defaultEffort != null && !seen.has(defaultEffort)) reject('MODEL_CATALOG_INVALID', 502);
  return { efforts, ...(defaultEffort == null ? {} : { defaultEffort }) };
}
