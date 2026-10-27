# Forward compatibility: contracts, not release whitelists

## Admission and evidence

The minimum Host requirement is `>=0.2.0-rc.2`, shared by `src/compatibility.js`, every DSH peer and the helper checks. There is no guessed next-minor/major upper limit. This is loading eligibility, **not a promise about every future release**. Evidence for actual releases/platforms lives in [compatibility.md](compatibility.md).

- A proven below-minimum version is unsupported.
- `validated` records a historical native baseline; `compatible` means an above-minimum release label, not new behavioral certification. Neither label changes the initialization path.
- Unknown/unreadable version metadata continues to actual Interface checks. It is not evidence of incompatibility.
- Different component version strings are diagnostics, not a rejection rule. The actual Llm service must belong to the imported native class; critical classes remain supplied by the Host, not another installed framework copy.

DSH's native boot evaluator checks DSH peers with `includePrerelease: true`. The package uses real minimum-only peers, not `engines.dsh` to hide narrower peers, `*`, or an exact-version exemption. Native tests cross-check the manifest against the **installed evaluator**; synthetic future labels test that rule, not unreleased binaries.

The admission approach follows [dsh-context 0.74.0](https://github.com/bowenliang123/dsh-context/blob/v0.74.0/docs/compatibility.md): a minimum floor, shape-driven use and separately recorded baseline evidence. Its metadata/fold fail-open rules are not permission to ignore authentication, malformed inference data or missing session protection here.

## Production initialization

Production imports only the provider implementation and its Host peers. It never discovers another executable or spawns the native test suites. The install helper performs structural discovery and invokes the native manager; it does not run release tests merely because a version label changed. There is no persisted compatibility exemption or production skip-tests flag.

1. Check essential Llm, credentials and Connection methods and actual Llm class identity.
2. Register an inert JSON management response. Prove GET/POST guest denial and owner reachability in process before any account runtime is created. Timeout/disposal remains bounded.
3. The historical operator-only Connection is identified by its actual exported `OperatorPeer` class, absence of principal/createPeer capability and authenticated admission Interface, not a release string. Its anonymous admission must reject. An unknown principal-capable carrier cannot acquire this legacy treatment from its version.
4. Start the account/provider runtime. Observe session services through a separate deferred dependency lifecycle, so their absence cannot keep account settings pending.
5. Session dispatch always crosses the protection gate. While dependencies/imports/reconciliation fail or remain pending, a fixed diagnostic blocks session-scoped requests. No history or attachment is dropped to make a request succeed. A successfully installed integration checks the exact selected/retained native revision and compaction outcome at dispatch.

The native registry's `inspectCompositions` is preferred. The older registry's public retained-mount readers are an explicit Adapter for the same inspection; they also prove runtime-root membership. Neither path guesses from a creation header or copies the compaction engine. Unsupported custom declarations remain unmodified and their uncovered session requests remain blocked.

## Additive changes and optional capabilities

Unrelated fields, catalog models/reasoning options and ordinary additional plugins do not require a new plugin release. Known preset declarations preserve unrelated rows, metadata, configuration and expressions. Ambiguous backends, nested/dynamic compaction groups or incompatible retained instances do not gain approval from a broad version range.

Public network/cache peers are optional and initialize independently of account management. Missing capabilities retain Host transport or memory-only metadata; unknown network-module execution fails the affected network operation rather than silently authorizing another route. On macOS a tightly bounded, shell-free OS DNS read is not a version check or test runner. No global dispatcher, DNS or TLS setting is rewritten. Persistent model/effort metadata never supplies credential, context or attachment authority, and real pressure preparation still reaches the native algorithm.

Model-directory badges and coverage-report inventory are optional display capabilities. Missing badges do not remove the settings card. Missing inventory reports `unavailable`; it neither approves nor disables the separate real session guard. Necessary stream completion, credential atomicity, owner authentication, attachment integrity and compaction transaction checks remain strict.

The existing settings route reports fixed initialization/coverage errors, without native paths or arbitrary exceptions. Client responses distinguish a missing Host route, access denial, malformed response and actual transport failure. A compatibility problem is not presented as proof of an expired authorization.

## Development and release verification

Run source/package checks and all four native suites explicitly before deploying a reviewed change. They use disposable profiles/stores and controlled upstreams. They never run as a production startup dependency. See [installation](install.md) for deployment and restart consent.

| Check                              | Evidence                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure contract/lifecycle tests      | Minimum floor, unknown labels, changed owner semantics, actual class identity, optional service load/unload, safe failures and historical Interface Adapters |
| Installed boot/profile fixture     | Final manifest admission without exemptions, old narrow manifest rejection and preservation of other layers                                                  |
| Native provider/race suites        | Mock catalog/Responses, replay, temporary-store restart and cross-process single-refresh rotation                                                            |
| Native compaction/preset suites    | Native checkpoints/shrinkage, four supported presets, additive plugin rows, failure blocking, retained revisions, restore and children                       |
| Real main-entry version invariance | Same native classes/code under baseline, future and missing APP_IDENTITY labels; no version-dependent omitted integration or recursive preflight             |
| User-controlled Desktop acceptance | Actual package/link/bundle, settings/source and the target Agent's selected/retained composition; not replaced by Node or source tests                       |

A finite suite cannot establish every future behavior. A necessary contract failure names the affected operation and must be investigated; a test-environment failure is not automatically evidence of an upstream breaking change. Real inference/refresh/revocation remains a separately approved operation.
