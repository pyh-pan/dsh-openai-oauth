// SIWC checkpoint template for the native summarize() extension hook.
// The unchanged conversation/system/tool prefix comes from the native engine;
// framing, shrink validation and the durable transaction remain native too.
export const COMPACTION_INSTRUCTION = [
  'Create a concise engineering checkpoint of the preceding conversation. Do not continue the task, execute tools, or answer earlier requests.',
  'Return only Markdown, using every heading below in order. Prefer precise bullets; use "(none)" for empty sections.',
  '',
  '## Primary Request and Intent',
  '## Key Technical Concepts',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Jobs',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
  '',
  "Preserve the user's constraints and corrections, essential identifiers, paths, commands, error codes, decisions and unresolved work. Distinguish completed work from unverified claims. The next step must serve the latest request.",
  'Merge any earlier <compacted-summary> checkpoint with subsequent developments; retain facts that remain relevant, remove stale plans, and do not copy the earlier checkpoint verbatim.',
  'Do not add introductory commentary or mention this instruction. Only the checkpoint text will be kept.',
].join('\n');
