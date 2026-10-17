# SIWC compaction and timeout repair

## Why a provider update alone is not enough

DSH Desktop 0.2.1-rc.2's basic summarizer always passes a positive `maxTokens` (normally 65,536). This provider deliberately rejects explicit `maxTokens` for its SIWC route. Consequently the ordinary basic summarizer fails locally with `UNSUPPORTED_MAX_TOKENS`; increasing network timeouts does not fix that contract conflict.

The optional `@pyh-pan/dsh-openai-oauth/compaction` export replaces **one** basic backend **inside the existing preset's compaction isolation group**. It subclasses the public `BasicCompactionEngine`, customizes its documented `summarize()` hook, and wraps the public `compactIfNeeded()` result only to observe overall failure. Its range selection, retention, tool pairing, transaction, persistence and shrink algorithms remain native. Other summary providers use the original hook unchanged. The main provider bundle intentionally does not edit presets automatically.

This optional component is separately pinned to **Desktop 0.2.1-rc.2**. The OAuth provider's broader compatibility range is not a validation claim for this hook. Different runtime versions fail closed until reviewed and tested; do not weaken the guard to force activation.

## Explicit no-server-token-cap semantics

For the **finally resolved summary target** `provider=chatgpt-subscription`, including explicit summary routes and conversation `modelPolicies`:

- The hook reuses the native replayed system/conversation prefix, tools, tool history and session affinity, then appends its checkpoint template.
- It does **not** send `maxTokens` or `max_output_tokens`. Its result and native `compaction/summary` record omit `maxTokens`; they never claim the native 65,536 cap was enforced.
- The original complete native configuration lives unchanged under `basic`. Native `maxTokens` still controls other summary providers, not the SIWC hook. Pressure headroom remains a reservation/heuristic, **not** an output hard cap on this route.
- The local summary deadline is **300,000 ms** by default, including preparation/streaming within the hook. Default local streamed output limit is **262,144 UTF-8 bytes**, counting text, visible reasoning and function-argument deltas; at most 1,024 block indexes are retained.
- Exceeding either local limit aborts and **fails** the summary; no locally truncated checkpoint is accepted. These are neither server token limits nor hard quota/cost ceilings. The server may do work before observing cancellation.
- Only an explicit successful `stop` terminal with nonempty text is accepted. Missing/failed/incomplete/truncated/tool-only/unsupported output fails; reasoning is never substituted for summary text.
- Native shrink and stability checks still run after the hook. Failed operations retain the latest durable history (including any native pruning already committed), not a fabricated checkpoint.

The adapter's ordinary parameter checks are unchanged. Passing `purpose: compaction` yourself does not bypass the cap/temperature/stop validation. No account, model, provider or billing fallback is selected.

## Safe continuation after failure

The native backend normally logs a failed automatic compaction and continues with the long history. This replacement adds a **pre-step safety guard**, not a second compaction backend. A host-only `sessionProjections` unit folds the last committed `compaction/end` outcome. When the resolved summary route is SIWC and the last attempt failed, the guard rejects continuation (`turn/end: blocked`) and logs `SIWC_COMPACTION_REQUIRED`. It also covers native failures after the hook, such as a summary that does not shrink. A thin `compactIfNeeded()` catch records the current operation's failure for the guard without changing the native algorithm; this also handles successful individual checkpoints that nevertheless fail overall pressure convergence, configuration failures and active locks with no new failed end marker. This transient outcome is recomputed on the next native pressure check, not treated as durable history. A successful subsequent `/compact` clears the committed failed state. Other summary routes pass through unchanged.

This is intentionally fail-closed: it can pause work instead of silently sending ever-growing history. Inspect the failed compaction, fix its cause, and compact at an idle boundary; otherwise write a reviewed handoff and use a new session. Do not clear raw logs, repeatedly resubmit the same impossible request, or copy the entire old log into a new session. Unmatched transaction markers remain native durable locks.

## Prepare a reviewed preset replacement

1. Finish active tasks. Do not edit a checkout linked into a live profile while developing; use a separate worktree.
2. Run the source/package checks and the isolated native compaction suite below against the actual installed Desktop.
3. Prepare a **new** review bundle outside the profile, choosing the current preset explicitly:

   ```sh
   npm run prepare:compaction -- --profile desktop --preset standard --runtime-overlays none --output /absolute/new/review-bundle
   ```

   On Windows supply an absolute native directory such as `D:\\review\\siwc-compaction-bundle`. The output directory must not exist. This command reads native composed manifests/patches, not credential storage, and never installs anything. It uses audited read-only boot primitives, not the native load/migration helpers that may write manifests. It reads bundle, profile and global-home patch layers, changes one known backend name, and wraps only its original config under `basic`. It refuses a higher-priority user/global override of the target preset rather than emitting a bundle that would silently lose to that override. It also refuses unknown/duplicate ownership, dynamic/unsupported groups, relative module references and obvious embedded credential carriers. `--runtime-overlays none` is an explicit operator assertion that no additional launch-only overlays affect the preset, **not** a live verification; unknown overlays require manual review. Output parent/profile directories are canonicalized, including Windows case and junction aliases. A filesystem adversary concurrently changing parent directories is outside this helper's security boundary. The generated bundle is **local configuration**, not an artifact to commit publicly; review it for private data and user customizations.

4. Review the diff against the current preset and save its original bundle/config reference for rollback. A whole preset override does **not** inherit future upstream preset additions automatically. Preserve the compaction/pruner isolation realm and original command/pruner rows; do not also enable global compaction.
5. With an explicitly agreed idle deployment window, install the reviewed provider archive/link and review bundle through the native manager:

   ```sh
   npm run dsh -- plugin --profile desktop add /absolute/reviewed-provider.tgz
   npm run dsh -- plugin --profile desktop add -w /absolute/new/review-bundle
   ```

6. Existing live Agents retain their preset revision. Installing a declaration alone does not repair those live Agents. Quit Desktop normally **only after tasks finish and the user agrees**, then reopen the same installation so restored sessions acquire the reviewed definition. Never force-kill, patch ASAR/framework code or promise lossless in-flight HMR. Recheck one backend per retained composition, provider registration, unchanged account/current model/other sources, and absence of loading diagnostics.

The provider archive must include the new subpath before the compatibility declaration can load. The generator does not install an older duplicate owner or change saved account selection. For custom/unknown compositions, stop for manual review rather than force the transform.

## Timeout policy and private timing

The main provider accepts an optional `requestPolicy` object. Defaults deliberately retain the previous timing values:

| Setting                    |   Default | Scope                                                                                                                                                      |
| -------------------------- | --------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `responseHeadersTimeoutMs` |    60,000 | Responses request: starts before JSON serialization/fetch, ends at Response arrival; earlier account access/catalog/body projection are outside this timer |
| `streamIdleTimeoutMs`      |   120,000 | SSE reader byte inactivity; transport pings can reset it, not a visible-token deadline                                                                     |
| `streamTotalTimeoutMs`     | 1,800,000 | Starts **after Response headers**, not end-to-end total                                                                                                    |
| `catalogTimeoutMs`         |    15,000 | Catalog headers plus body; also the separate Responses non-2xx body-read deadline                                                                          |
| `maxRetries`               |         5 | Host-owned extra normal retries, not adapter retries                                                                                                       |
| `timing`                   |   `false` | Opt-in allowlisted local attempt timing                                                                                                                    |

Timeout values must be safe positive integers no larger than the supported timer ceiling; unknown keys and invalid combinations reject before activation. `maxRetries` is an integer from 0 through 5, never `always`. Setting headers above 60 seconds requires an **explicit** `maxRetries` of 0 or 1 and `(maxRetries + 1) × responseHeadersTimeoutMs <= 360,000`. For example a deliberately chosen 180-second candidate may be paired with one extra retry, **not** five. Do not apply this candidate merely because it is available; first repair compaction, then measure.

There is **no implemented 300-second whole-step deadline** in the current Host contract. The product bound above covers headers waits only, excludes preparation/backoff/streaming and does not combine independent Host recovery mechanisms. The Host remains the only retry owner; direct `llm.stream()` summaries are one attempt. A full cross-attempt wall-clock budget needs an upstream logical-call/deadline contract, not guesses based on session IDs or turn signals.

Errors retain supported native fields. Headers, post-headers stream total, catalog, and non-2xx body deadlines keep compatible `code=TIMEOUT` and fixed safe messages (`SIWC_RESPONSE_HEADERS_TIMEOUT`, `SIWC_STREAM_TOTAL_TIMEOUT_FROM_HEADERS`, `SIWC_CATALOG_TIMEOUT`, `SIWC_ERROR_BODY_TIMEOUT`). `STREAM_IDLE_TIMEOUT`, user cancellation, account changes and `PLUGIN_DISPOSED` remain distinct. No unsupported `details` property or invented HTTP 504 is used.

When enabled, `SIWC_TIMING` records contain a new random **local attempt** ID, fixed stage/elapsed timings, request byte size, allowlisted usage, effective policy and safe error code. They do not log user/tool content, Authorization/headers, raw or stable-hashed account/session identity, encrypted replay, full error causes or arbitrary upstream messages. Timing is client-side evidence; it cannot split upstream queueing, model compute, upload, proxy or TCP/TLS latency by itself. Logging failures must not affect inference.

## Verification and honest boundaries

```sh
npm ci
npm test
npm run check
npm run test:package
npm run doctor
npm run test:native
npm run test:race
npm run test:compaction
```

Pure unit tests and the installed native mock suite must both pass. Native tests use synthetic sessions, mock transport and a disposable native persistence root; no real grants or real history. They reproduce the old local failure, then verify native checkpoint replacement, smaller derived request history, preserved tail, metadata without a cap, failed-terminal/size/stability/cancellation behavior, paired markers, safety guard and native log restoration. This is not evidence of real quota, real history recovery, GUI rendering or future upstream reliability.

Real-account acceptance needs a **separate bounded approval**: initially at most one small synthetic summary plus one short subsequent request on an explicitly chosen account/model, without test retries or escalation. A real old long-session recovery is another explicit approval and may still fail if its input is already too large. Keep that history intact and fall back to a reviewed human handoff, not data deletion. No finite patch can guarantee that a network/upstream never times out again.

## Rollback

At an idle window, remove the generated compatibility bundle through the native manager and reinstall the saved provider archive/ref, then safely Quit/reopen. Its preset override disappears, restoring the preceding declaration layer. Preserve any newer intentional user preset edits rather than blindly replacing them. Do not delete accounts, grants, other sources or sessions. Code rollback does **not** undo an already committed native checkpoint; history restoration requires a separately verified native recovery path and user approval, never manual session-file rewriting.

## Evidence scope

The 2026-10-18 independent local review reproduced the historic snapshot: 136 closed summary attempts all failed with `UNSUPPORTED_MAX_TOKENS`, no summary checkpoint, and 55 TIMEOUT attempts with median 60.043 seconds. Matching-window completed steps were 87 vs 243, TIMEOUT attempts 47 vs 0, input medians 612,377 vs 312,063. Attempts and completed steps have different denominators; both sessions exclude one crossing boundary step. The first historic TIMEOUT predates the first summary failure, so compaction is not a proven necessary cause of every timeout. The original “first content” metric was a `block-start`, not a measured HTTP headers/visible-token timestamp. Lifecycle failures are not network errors.

This review could not re-fetch the current [official SIWC preview restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) or [inference documentation](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) because the local DNS/SSRF policy rejected the resolved address, and search was unavailable. This is **not fresh upstream certification**. Existing strict preview checks were conservatively preserved; ordinary Responses API documentation is not evidence that SIWC accepts those caps. No DNS/TLS/SSRF settings or credential boundaries were weakened.
