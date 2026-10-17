# Forward compatibility: eligibility is not validation

## Policy

The shared policy is in `src/compatibility.js`. Package metadata, helpers, runtime guards and tests consume or verify it:

```text
0.2.0-rc.2 || >=0.2.1-rc.1 <0.3.0-0
```

- **Validated release:** `0.2.0-rc.2`, `0.2.1-rc.1`, `0.2.1-rc.2`. Validation is scoped to the platform and evidence in [compatibility.md](compatibility.md), not a promise about every machine.
- **Candidate:** another release inside the range, including later `0.2.1` RCs/final and `0.2.x` patches. It may proceed only after contract checks and local isolated native suites pass. It is not added to the validated list automatically.
- **Unsupported:** outside the range, invalid versions, mixed installed components, missing contracts, or failed behavioral checks. In particular, `0.3.0` **prereleases as well as final** are outside the range. The historical `0.2.0-rc.2` exception does not automatically admit `0.2.0` final or other RCs.

The inspected rc.2 boot policy uses SemVer with `includePrerelease: true`. Therefore `0.2.2-alpha.1`/beta/RC also lie inside the candidate range: prerelease labels are not a stability guarantee, and the same mandatory checks apply. `<0.3.0-0` intentionally excludes the next minor's prereleases, unlike a naive `<0.3.0` upper bound under that policy. If a future boot implementation changes its range semantics, its own rejection remains authoritative; no exemption is granted.

This is our bounded best-effort policy, **not an established upstream promise that all 0.2.x releases preserve APIs**. SemVer before 1.0 and RC numbering alone cannot establish compatibility. No unbounded range, `engines.dsh` override, downgrade or ignore-version flag is used.

## Which changes require attention?

| DSH change                                                                                       | Expected treatment                                                                                                   |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Unrelated UI polish, performance changes, ordinary fixes without changing consumed contracts     | Should not require a new exact version entry; candidates can pass the checks                                         |
| Additive optional fields, new providers or capabilities retaining existing contracts             | Usually compatible; ignore unrelated additions and keep server-advertised model/reasoning choices                    |
| Bundle metadata, loader/module resolution or client injection changes                            | May prevent activation before any OAuth code runs; test actual boot composition and diagnose the package layer first |
| Llm registration, adapter handle, stream/chunk, tool replay or reasoning semantics               | Require regression evidence; no invented models, dropped terminal validation or billing fallback                     |
| Settings slots, locale or model-directory services renamed/removed                               | Client contract diagnostic; do not replace the native selector or silently switch models                             |
| Connection exact-route authorization or owner principal semantics                                | Fail closed; never expose account management to guests or weaken authentication                                      |
| Credentials record schema, async atomic modification, restart persistence or cross-process locks | High risk; isolated native store/restart and competing-refresh checks must pass before candidate activation          |
| Next `0.x` minor/major, mixed package versions, unknown installation layout                      | Stop for explicit review and new evidence; no automatic compatibility claim                                          |

Even a patch or RC can contain a breaking change; a larger version can also retain APIs. The table classifies **changes**, not guarantees based on release labels.

## Three enforcement layers

1. **Metadata and diagnostics.** `doctor` reads only installed version metadata and service exports, not profiles/grants. It reports `compatibility: validated|candidate|unsupported`, the eligible range, validated list, component versions and named contract issues. Desktop, Llm, credentials, Connection, boot and the two required model UI packages must be the same exact version. Export/method presence is a structural check, not proof of semantics. `eligible: true` does not certify login, inference or a future release.
2. **Candidate behavior checks.** Before candidate installation/activation CLI operations, the helper runs both isolated native suites with the installed executable. They use disposable package/profile fixtures, temporary synthetic credentials and controlled upstreams. Tests cover loader composition, model registration/reasoning, mock stream/replay, owner denial, cancellation, store restart and two-process single-refresh rotation. Failure stops before the requested activation command. Native `plugin remove` remains available after structural checks for safe recovery; an argument/package named `remove` cannot bypass activation checks. After a **direct Desktop update**, production startup also runs those same suites before creating its real-account runtime. It pins the running executable and verifies its version/tuple rather than trusting an unrelated `DSH_APP`/`DSH_ASAR` override. These checks can delay candidate startup. They are bounded and rerun instead of persisting an unverified compatibility exemption. Native fixtures use an injected no-op preflight because they are already the isolated check, not a production flag or recursive self-test.
3. **Live composition guards.** Before account-runtime creation, verify the consumed service methods. On 0.2.1+ the actual management route initially serves only an inert 503 response. In-process GET/POST probes must prove guest denial and owner reachability before the real handler is enabled. No network request, extra endpoint, real credential read or upstream call is made by the probe. A stall is bounded; disposal cannot initialize a late runtime. The separately validated 0.2.0 baseline retains its historical carrier behavior. Client-side guards name missing slot/locale/directory hooks.

Production behavior probes supplement, rather than replace, transport authentication or regression tests. No finite test suite proves every future storage/streaming behavior. A change that retains function names but changes semantics may still need a plugin update; passing checks is not an official upstream or cross-platform certification. Real inference/refresh/revocation of user grants remain separately approved operations, never part of automatic compatibility checks.

## Safe upgrade workflow

1. Update DSH normally; keep the public plugin's owner and stored namespace unchanged.
2. Run `npm run doctor`. A candidate is not automatically a verified release; inspect its classification and any named missing contract.
3. Run the standard source/package checks and `npm run test:native` / `npm run test:race`. Native installation through the helper enforces candidate behavior checks again; direct-update startup does too.
4. Use the native plugin command, then Quit/reopen only after tasks finish and the user agrees. Confirm both entries, the saved account, other providers and current selection. Official sign-in/account selection, if actually needed, belongs to the user.
5. If blocked, keep grants intact and report the safe diagnostic code. Do not edit a profile to force loading or install another framework copy.

Useful codes: `UNSUPPORTED_DSH_VERSION`, `DSH_COMPONENT_VERSION_MISMATCH`, `DSH_HOST_CONTRACT_MISSING`, `DSH_CANDIDATE_NATIVE_CHECK_FAILED`, `DSH_RUNNING_INSTALLATION_MISMATCH`, `DSH_CONNECTION_OWNER_BOUNDARY_CHANGED`, `DSH_CONNECTION_OWNER_BOUNDARY_TIMEOUT`, `DSH_ADAPTER_HANDLE_CONTRACT_CHANGED`, and `DSH_CLIENT_CONTRACT_MISSING`.

## Evidence and regression limits

The policy and manifest are compared against the **installed rc.2** boot SemVer evaluator for synthetic version strings. Tests simulate candidate orchestration, preflight failure, missing interfaces, owner-boundary changes, timeouts and unload races. Actual native behavior was tested on Windows/x64 rc.2. Synthetic `0.2.2`/`0.2.9` labels are **not** tests of those released or unreleased binaries. Earlier releases keep their historical validation records; macOS GUI compatibility and real-account operations are not inferred from Windows/Node tests.

Reference: [upstream plugin publishing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md), [package API groups](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md). These are moving documentation, not a pinned rc.2 stability contract. Direct web retrieval was blocked by the local DNS/SSRF safety policy during this investigation; it was not weakened. The concrete loading and authorization findings rely on the installed artifact and reproducible local tests described in [compatibility.md](compatibility.md), not an assumed upstream versioning guarantee.
