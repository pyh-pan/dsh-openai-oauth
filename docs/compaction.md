# Unified SIWC compaction and request safety

## One package and one update path

Starting with **0.3.6**, the ordinary `dsh-openai-oauth` provider entry owns SIWC compaction. Version **0.3.7** removes the initial rc.2-only restriction and follows the actual Host Interfaces. Do not install a second local configuration bundle for normal use. The `./compaction` export remains an internal module and a supported explicit composition building block; it is not a second provider or a separate account owner.

The native basic summarizer passes a positive `maxTokens`, while this provider deliberately rejects that option for ordinary SIWC requests. Updating only the adapter's error labels never solved that contract conflict. The integrated implementation replaces the one basic backend inside each supported preset's **existing compaction isolation group**, retaining native range selection, tools/tail pairing, checkpoint transactions, persistence and shrink checks.

Automatic integration is shape-driven, not pinned to a release label. A deferred dependency lifecycle waits for the loader, preset registry, agents and session projections without making them hard account-provider dependencies. Missing, pending or failed integration denies session-scoped requests with a fixed diagnostic while account management remains available. Successful initialization still proves the actual retained composition before dispatch. Complete native suites are explicit development/release checks, never production startup dependencies.

The registry inspection prefers `inspectCompositions`; the historical public retained-mount exports provide the same read-only inspection when that aggregate method is absent. Runtime-root membership and the current engine generation marker remain required. No compaction algorithm or transaction owner is copied or replaced. Platform evidence and limits are recorded in [compatibility.md](compatibility.md).

## Preserve declarations; inspect actual revisions

The provider uses the installed Cordis `internal/config` waterfall for the exact native `AgentPreset` class. It transforms detached in-memory configurations for the known `standard`, `cordis`, `ptc` and `minimal` declarations. Already-loaded native declarations receive a public `Fiber.update(rawConfig, true)` (`noSave`) update. New declarations go through the same hook. No profile manifest, lockfile, user patch or full preset snapshot is written by this runtime integration. No framework method, module export or ASAR is patched.

The transformation preserves the original preset identity, display metadata, unrelated plugins (including additive ordinary rows in a known compaction group), native basic configuration, group isolation and expression nodes. It never evaluates child expressions itself. Ambiguous/duplicate owners, dynamic groups or unknown composition shapes are not rewritten. The former local compatibility backend is recognized idempotently during migration, without wrapping `basic` twice.

Native registry revision retention still owns live Agents and children. An update does **not** forcibly rebind a running Agent. A 30-second reconciliation bound and disposal signal prevent indefinite waits or late session-protection activation after dependency unload. Account initialization does not wait for absent optional session services.

Every session-scoped Responses dispatch, including the native prepared-call path, checks:

- the live Agent exists;
- its native `agentPreset` projection agrees with the exact composition it joined;
- that retained composition has exactly one compatible backend, no remaining basic backend and no leaked root service;
- the compatible instance supplies the safety contract, and a conversation request is not bypassing a recorded/transient failed-compaction state.

Admission runs before attachment restoration/history projection, again after asynchronous attachment preparation, and at the actual Responses fetch after selection/authorization waits. Attachment reads or refresh waits cannot preserve a stale approval. Prepared calls retain their captured model capabilities; invalidating the catalog must not erase a negative image/file capability.

The creation header alone is **not authoritative**. A header can say `standard` while a subsequent `agent-preset/selected` event and the live composition both say `cordis`. Children are checked against their inherited retained revision as well.

Unknown sessions, mismatched revisions or uncovered compositions fail locally with `SIWC_SESSION_COVERAGE_UNAVAILABLE`, `SIWC_PRESET_REVISION_MISMATCH` or `SIWC_COMPACTION_NOT_COVERED`, before a Responses body is sent. Unexpected inspection failures become the fixed `DSH_SIWC_PRESET_CONTRACT_MISSING`, not a retryable network error. Ordinary standalone calls without a session identity remain possible; they do not claim preset protection.

## Runtime coverage in the existing settings page

The original ChatGPT subscription settings card shows four preset-definition states and aggregate live SIWC session counts: checked, protected, compaction-needed and uncovered. It uses the same owner-authenticated management API, not another endpoint or plugin. The native current-definition inventory and each Agent's exact retained revision are inspected at read time. Inspection is bounded; unavailable or incomplete inspection is never shown as successful validation.

No session/account identifiers, module paths, config, conditions, prompts or arbitrary errors enter the coverage report. A protected-but-paused session is distinct from an uncovered one. Zero live SIWC sessions produces **pending**, not a claim that a real historic session was tested. Refresh the existing settings card after opening the target session; do not send a real request just to make a status indicator green.

## Cold-runtime selection metadata and pressure preparation (0.3.9)

The original selector may read an account-scoped, previously verified model/effort directory without renewing authorization. That persistent directory deliberately has no context or attachment authority. Native pressure compaction runs in `agent/pre-step`, before the Agent's actual `Llm.prepareCall`; a restored session already has a durable request header, even when its history is short.

For that actual SIWC conversation pressure target only, the compatible override first calls the public `Llm.prepareCall` to authorize and load live capability metadata, then executes the original pressure algorithm. It never dispatches that temporary handle, writes request/header/history, fabricates a capacity, or reuses the handle as the Agent's final request. A new/unrouted session or foreign conversation does not receive this warm-up. A different summary provider does not change the conversation's pressure target or disable its failure guard.

The real rc.3 cold-session fixture reproduced `TargetPressureConfigError` before this change. It now passes, while failed authorization, a truly absent context capacity and cancellation still reject and retain original history. Source/package/native results remain distinct from real account recovery; see [authorization diagnosis](auth-resilience.md).

## Honest summary limits

For the **finally resolved summary target** `provider=chatgpt-subscription`, including explicit summary routes and conversation `modelPolicies`:

- Replay uses the native system/conversation prefix, tools, tool history and account/session affinity.
- The hook omits `maxTokens` and `max_output_tokens`; its result and native summary record omit `maxTokens`. They do not claim a server output-token cap.
- Native configuration is preserved under `basic`; its `maxTokens` still controls other summary providers. Other providers use the native summary hook unchanged. Headroom remains a pressure reservation, not a SIWC server hard cap.
- Default local deadline: **300,000 ms** including hook preparation/streaming. Default local output bound: **262,144 UTF-8 bytes**, counting text, visible reasoning and tool-argument deltas, with at most 1,024 block indexes.
- Exceeding a local bound aborts and fails; a truncated checkpoint is never accepted. These bounds are not hard quota/cost ceilings: a server can do work before seeing cancellation.
- Only a successful `stop` terminal with nonempty text is accepted. Missing/error/incomplete/truncated/tool-only/unsupported output fails. Reasoning is not substituted for summary text.
- Native stability and shrink checks still run. Failed operations retain durable history, including any native pruning already committed, not a fabricated summary.

Ordinary adapter parameter checks remain strict. A caller cannot bypass them merely by setting `purpose: compaction`. No provider/model/account or billing fallback is selected.

## Fail closed and recover explicitly

The native basic backend normally logs an automatic compaction error and continues the turn. The compatible backend adds a scoped pre-step guard and a projection of the last committed `compaction/end`. It also observes overall pressure failures outside the summary hook. A failed SIWC operation pauses the next conversation step instead of resending an ever-growing history.

Provider-wide admission checks the same readiness for prepared/direct session requests, so a scoped listener cannot be the only line of defense. Compaction requests remain admitted to allow an explicit recovery. A successful, committed `/compact` clears the transient failure; a null/no-progress result does not fabricate recovery. Native idle/maintenance admission, durable locks and transaction ownership remain unchanged.

Inspect the failure and fix its cause at an idle boundary. Use a reviewed handoff to a new session if safe compaction is impossible. Do not clear raw logs, repeatedly submit an impossible request or copy the entire old log into a new session. A code rollback does not undo an existing checkpoint, and unmatched native transaction markers remain native locks.

## Installation and migration from the former local bundle

1. Develop in an isolated checkout, never the checkout linked into an active Desktop. Run all checks below on the actual installed runtime.
2. Confirm an idle window including the deploying conversation. Deploy from an external terminal or independent assistant; native HMR can unload a provider immediately. Normal Quit/reopen is required to restore sessions into the reviewed definitions; never force-kill or promise lossless in-flight replacement.
3. From the reviewed provider checkout use native `npm run dsh -- plugin --profile desktop add -w .`. Keep linked installations linked; see [safe linked updates](install.md#updating-a-linked-checkout-safely). Do not remove then add an archive over a Windows Junction.
4. For an existing `@local/dsh-siwc-compaction-compat`, verify the new provider's four supported transformations first, then disable/remove **only that old local bundle** through the native manager/CLI. Preserve its reference outside the public repository for rollback. Do not edit profile package/lock/patch files manually.
5. Restart normally with consent. Verify the actual provider version/canonical target, one provider owner, no separately selected local compatibility bundle, each supported native composition, and the exact revision of restored target sessions. Check the projected selected preset, not just a default or the frozen header. Keep accounts, current model and other providers unchanged.

The legacy `prepare:compaction` tool is retained only for explicit/manual composition review and recovery. It is not the installation/update path for the automatic integration. Unknown/custom presets need contract review or an explicit compatible backend; they must not silently continue through an uncovered SIWC route.

## Request timeouts and private diagnostics

The time/retry defaults remain unchanged; 0.3.9 additionally exposes an explicit transport choice:

| Setting                    |   Default | Scope                                                                                                                                                           |
| -------------------------- | --------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `responseHeadersTimeoutMs` |    60,000 | Starts before JSON serialization/fetch, ends at Response arrival; earlier account/catalog/body projection is outside it                                         |
| `streamIdleTimeoutMs`      |   120,000 | SSE byte inactivity, not visible-token latency; pings can reset it                                                                                              |
| `streamTotalTimeoutMs`     | 1,800,000 | Starts **after Response headers**, not end-to-end                                                                                                               |
| `catalogTimeoutMs`         |    15,000 | Catalog headers/body and separate non-2xx Responses body deadline                                                                                               |
| `maxRetries`               |         5 | Host-owned additional normal retries; no adapter retry loop                                                                                                     |
| `timing`                   |     false | Opt-in allowlisted local stage logs                                                                                                                             |
| `transport`                |    `auto` | Native proxy routing; recognized macOS bounded direct mode, otherwise Host fetch. `host` retains Host fetch for every route; no global network settings change. |

Safe positive-integer timer values and known keys are required. `maxRetries` is 0..5. Above 60s headers requires an explicit `maxRetries` of 0 or 1 and `(1 + maxRetries) × responseHeadersTimeoutMs <= 360,000`. A measured 180s/one-extra-retry candidate is possible, not automatically selected. Repair and verify compaction before relaxing timing.

There is no implemented whole-step cross-attempt deadline in this Host contract. The product bound covers headers waits only, excluding preparation, backoff and streaming. Do not present it as a cost ceiling or an end-to-end deadline. The Host is the retry owner; direct `llm.stream()` summaries remain single-attempt. Lifecycle, unsupported-parameter and coverage/safety failures are not retryable network errors.

Fixed native-compatible timeout messages distinguish headers, post-headers duration, catalog and error-body deadlines. `STREAM_IDLE_TIMEOUT`, cancellation, account changes and `PLUGIN_DISPOSED` remain separate. No arbitrary `details` field or invented HTTP 504 is used.

Opt-in `SIWC_TIMING` contains only a random local attempt ID, stages/elapsed times, request bytes, numeric usage, effective policy and allowlisted outcome. It excludes account/session identifiers, headers/Authorization, bodies, tool parameters, replay data and arbitrary causes. Logging failures cannot affect inference. Client timing does not by itself distinguish DNS/upload/proxy/server queue/model compute. A first `block-start` is not a network response-headers timestamp.

## Verification and boundaries

```sh
npm ci
npm test
npm run check
npm run test:package
npm run doctor
npm run test:native
npm run test:race
npm run test:compaction
npm run test:presets
```

The preset suite uses the installed native Loader, registry, real main entry and temporary credentials, with mock/denied transport. It covers all four presets, manual and automatic checkpoints/shrinkage, failed-operation admission, header/selection mismatch, restore, child inheritance, retained old revisions, future declarations, prepared-call admission and noSave cleanup. Pure tests additionally cover malformed/unknown declarations, additive rows, migration idempotency, historical Interface Adapters and optional dependency lifecycle races. The real main-entry suite also repeats with only its release metadata changed to historical/future/missing labels; this proves version invariance, not those other binaries' compatibility. No real grant/history is read and no server inference is made.

These checks are not proof of macOS GUI behavior, quota, large historic-session recovery or the impossibility of another network timeout. Real acceptance needs separate bounded approval. Start with small synthetic requests, no test retries, no full old history, and fail rather than expanding a budget automatically.

Rollback uses a compatible saved reviewed checkout and native `add -w`, at an agreed idle window. Credential payload v2 in 0.3.9 must not be downgraded or have its safety markers erased; use `requestPolicy.transport: host` when retaining Host networking is the needed fallback, rather than loading an old reader over new safety records. Restore an old local bundle only if its old provider explicitly needs it; 0.3.3's standard-only declaration does not fix an old cordis session. Retain history and user settings. Do not roll back an entire profile over newer user edits.
