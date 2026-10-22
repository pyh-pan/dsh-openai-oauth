# Protocol and lifecycle

The source of truth is OpenAI's current official SIWC documentation:

- [OSS token sharing](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration/sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Profiles/sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models/inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Errors/recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [UI guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)

## Authentication

First registration uses `dynamic_agent_client`, the actual stable name hint **DSH ChatGPT Source**, and a persistent per-installation host UUID URI. Each callback-issued client ID is stored and reused for that registration. Registration identity and package/repository branding are separate: upgrades do not silently create another Agent.

State, nonce and PKCE S256 are fresh per attempt. Loopback uses 127.0.0.1, with one exact callback URI per attempt; occupied preferred ports fall back to an available loopback port. Wrong state does not consume the attempt; valid callbacks are single-use, bounded and cancelable.

Official discovery/JWKS restrict issuer/endpoints and RS256. Signature, audience/azp, time, nonce and subject are checked before saving identity. Direct subscription scope is validated from the actual Token grant, not callback text. Identity without direct permission remains disabled for inference.

## Storage and sessions

The Host credentials namespace remains `chatgpt-subscription-login`. Account records use issued-client hashes and bind verified subjects; registrations are not mixed across accounts/workspaces. Host ID survives restarts. Selecting an account changes an explicit generation, not the current conversation's provider.

Refresh reads the newest rotating token inside the native cross-process lock, performs bounded network work and atomically commits it. Caller cancellation does not discard an already-started successful rotation. Terminal refresh failures clear tokens but retain registration; temporary errors retain the grant.

Authorization transport has at most two attempts within one shared 12-second request budget, including its 100 ms retry delay. Discovery/JWKS reads may retry a transport failure once (never a TLS verification failure). Authorization-code exchange and rotating refresh retry only allowlisted DNS/connect failures that prove no connection was established; a reset, socket failure or unknown outcome is not automatically replayed. HTTP errors are not retried by this transport. A signal supplied to the protocol stops its dispatch/backoff, and late responses are cancelled. A rotating refresh already started inside `SessionManager` deliberately uses only its independent maintenance deadline: cancelling an inference wait does not cancel that transaction or discard a successful rotation. The existing 20-second total maintenance deadline still bounds each cross-process refresh transaction.

Failures distinguish DNS, connect, TLS, deadline, metadata-read and unconfirmed-write outcomes using fixed non-secret codes and messages. Underlying exceptions, headers and token bodies are not logged. Temporary failures retain the saved grant; this does not claim that an unconfirmed remote rotation did not occur. Network recovery never disables TLS, overrides proxy settings, falls back to another origin/provider, or promises uninterrupted external connectivity.

Sign-out attempts official revocation with bounded retries and then clears local tokens. Failure returns `REMOTE_REVOCATION_UNCONFIRMED`; local deletion alone is never reported as remote revocation. Other clients' grants are not touched.

## Stable session affinity

DSH supplies a durable `sessionId` to its native Llm call. For a valid session, this adapter derives `dsh_` plus SHA-256/base64url of `JSON.stringify([accountKey, sessionId])`. The Responses `prompt_cache_key`, `session_id` header and `x-client-request-id` header use that same value. Raw account keys and session paths are not transmitted as affinity identifiers.

Affinity remains stable across rotating tokens, adapter recreation and selection-generation changes, while accounts and main/child sessions stay isolated. Standalone calls that omit `sessionId` omit all three fields rather than sharing a global key. Catalog and OAuth requests do not acquire these fields.

The key field in the supplied controlled experiments was `session_id`; the other two align the full metadata behavior. These experiments do not expose the server's internal routing algorithm. Cache hits can occasionally occur without explicit affinity, and affinity does not guarantee a fixed hit percentage: cold starts, new content, compaction, expiry and eviction still matter. Assess fresh request usage, not a historical cumulative percentage. Usage accounting and tool namespace are unchanged; no cache-retention parameter is added.

Version 0.3.1 was also checked inside an actual Windows/x64 DSH Desktop 0.2.1-rc.1 Host using its existing SIWC grant, not another client's OAuth. A fixed synthetic tool loop made exactly four Responses calls on `gpt-6.1-sol` / `high`: cold 0/6503 cached input tokens, then warm 6400/6534 (97.95%), 6400/6565 (97.49%) and 6400/6596 (97.03%). Outbound metadata consistency and raw usage were observed without exporting credentials or private history; native replay and namespace were retained. This is a bounded synthetic desktop-Host check, not a promise about every real conversation or a macOS live-cache validation.

## Models and Responses

`GET https://api.openai.com/v1/models` supplies the real account catalog. Only `visibility=list` entries are offered, in server order, retaining slugs. Catalog JSON has a separate 8 MiB limit because rich model metadata can exceed the smaller OAuth/discovery bound.

Actual reasoning choices/defaults map into native Llm capability metadata; unsupported explicit choices fail. Summary is requested only when advertised supported. Text, verified image bytes and supported document bytes are sent inline; explicit modality exclusions are enforced and absent catalog facts stay unknown. Native structured file references survive the pre-adapter text projection through a request-scoped bridge, not path parsing. See [attachment contracts and limits](attachments.md).

Inference uses public `POST /v1/responses`, `store:false`, `stream:true`; tools use the `dsh` namespace. No backend-api, fixed legacy Codex client, partner secret or billing fallback.

SSE is decoded strictly, independent of a generic/missing MIME label. Only successful `response.completed` finishes a turn. When its stateless aggregate is empty, reconstruction requires every contiguous output item to have an explicit done event; partial deltas are never treated as completion. Failed/incomplete/truncated/oversized streams fail closed.

Tool arguments/results and native encrypted reasoning/message phase can be replayed only for the same account/model and unedited durable contents. Cross-source or edited history degrades to safe visible text/tool history.

Preview-incompatible `maxTokens` and `temperature` are rejected, not silently dropped. Audio/video, the Files upload API, hosted MCP and tool-search are not implemented.
