// Optional replacement within a preset's EXISTING compaction isolation group.
// Not activated by the provider's default bundle; never mount two backends.
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import metadata from '@deepseek-ai/dsh-compaction-basic/package.json' with { type: 'json' };
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm';
import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { createCompactionClass, safetyDefinition } from './siwc/compaction.js';

// This optional hook is behaviorally pinned separately from the base OAuth
// compatibility range. Future native implementations need the native suite.
if (metadata.version !== '0.2.1-rc.2') throw new Error('DSH_SIWC_COMPACTION_VERSION_UNVALIDATED');
const Engine = createCompactionClass({ BasicCompactionEngine, BlockAssembler, LlmError });
export default class SiwcCompactionEngine extends Engine {
  static Config = Schema.object({
    basic: BasicCompactionEngine.Config,
    summaryTimeoutMs: Schema.number()
      .step(1)
      .min(1)
      .max(1800000)
      .description(
        'Local SIWC summary wall-clock deadline, milliseconds; not a token or billing cap. Default 300000.',
      ),
    maxSummaryBytes: Schema.number()
      .step(1)
      .min(1)
      .max(8388608)
      .description(
        'Local streamed output UTF-8 byte limit; exceeded output fails, never truncates a successful checkpoint. Default 262144.',
      ),
  });
  constructor(ctx, config) {
    super(ctx, config);
    ctx.sessionProjections.register(safetyDefinition(z.object({ failed: z.boolean() })));
  }
}
