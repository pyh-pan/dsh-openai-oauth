# dsh-openai-oauth

**Use your ChatGPT subscription in DeepSeek Harness Desktop through official Sign in with ChatGPT (SIWC).**

English | [简体中文](README.zh.md)

[![Verify](https://github.com/pyh-pan/dsh-openai-oauth/actions/workflows/verify.yml/badge.svg)](https://github.com/pyh-pan/dsh-openai-oauth/actions/workflows/verify.yml)

Independent community plugin; not affiliated with OpenAI or DeepSeek. This is **not** the legacy fixed-client Codex OAuth/backend-api integration.

## Features

- Continue with ChatGPT, dynamic Agent registration, persistent host identity, and verified ID Tokens.
- Account-specific models and reasoning levels in **DSH's existing model selector**.
- Public Responses streaming, local function tools, tool results, and compatible history replay.
- Multiple saved account/workspace registrations, explicit account selection, rotating refresh, and scoped sign-out.
- Keeps DeepSeek Account, API-key providers, other sources, and existing sessions independent. No silent billing fallback.
- No Codex CLI, API key, patched ASAR, or replacement pi-ai installation.

## Compatibility

Requires **DSH Desktop 0.2.0-rc.2** and Node.js **24+** for development/install helpers.

| Environment                                     | Status                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Windows Desktop 0.2.0-rc.2                      | SIWC baseline previously exercised; public-package migration verification pending  |
| macOS Desktop 0.2.0-rc.2                        | Portability work and real desktop validation in progress; not yet claimed verified |
| Windows/macOS/Linux Node CI                     | Protocol/package tests only; not proof of desktop login or inference               |
| Older DSH, remote/headless Hosts, Linux Desktop | Not currently claimed supported                                                    |

See [compatibility and verification](docs/compatibility.md). Do not bypass version checks or upgrade bundled framework dependencies to force compatibility.

## Install from source

No npm publication is required or currently promised.

```sh
git clone https://github.com/pyh-pan/dsh-openai-oauth.git
cd dsh-openai-oauth
npm ci
npm test
npm run check
npm run test:package
npm run doctor
npm run dsh -- plugin --profile desktop add -w .
```

The `dsh` helper discovers the installed desktop executable and invokes its own bundled CLI; it does not install another Host. Use `DSH_APP` for a nonstandard installation. See [installation](docs/install.md) for Windows PowerShell and macOS examples.

Only restart DSH after running tasks have finished. A window close may hide the application to the tray; use its normal Quit action.

### Use a reviewed archive

```sh
npm run pack
npm run dsh -- plugin --profile desktop add ./artifacts/pyh-pan-dsh-openai-oauth-0.3.0.tgz
```

Do not keep the old private bundle and this bundle enabled simultaneously: they deliberately preserve the same provider/credential identity. See [migration](docs/migration.md).

## Sign in and use

1. Open **Settings → Models → ChatGPT subscription**.
2. Click **Continue with ChatGPT**, then open the official authorization link in your browser.
3. Name/approve the Agent on OpenAI's page. Finish authentication yourself; never copy tokens from another client.
4. Read the first-use notice and select **Use this account**. Signing in alone does not switch your conversation's model.
5. Select **ChatGPT Subscription** in the existing model picker. Its **Reasoning level** submenu shows only choices advertised by that model.
6. Use **Manage usage** to review the Agent, quota, limits, and access at [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

Accounts without the granted direct-inference scope remain signed in but disabled for inference. Explicitly enable subscription inference to request consent again. Reauthorization reuses the registration; adding a different account is a separate action.

## Limits and security

- Models, reasoning choices and quota are account/server dependent, not an unlimited or universal model entitlement.
- Currently advertises **text input** and client function tools. Direct image/file upload and hosted MCP/tool-search are not implemented.
- The current SIWC preview does not accept some ordinary API parameters. Explicit `maxTokens`/`temperature` settings are rejected, not silently ignored; clear them before using this source.
- Subscription failures never switch to an API-key/balance provider.
- Tokens stay in the native Host credentials service, not browser storage or ordinary plugin settings. Native local storage is not a promise of OS-keychain encryption.
- Sign-out attempts remote revocation and clears this account's local tokens, retaining its registration. Unconfirmed remote revocation is reported; review access in ChatGPT settings.
- Read [SECURITY.md](SECURITY.md), [protocol design](docs/protocol.md), and [third-party notices](THIRD_PARTY_NOTICES.md).

## Development

```sh
npm ci
npm test
npm run check
npm run test:package
npm run test:native
npm run test:race
```

Pure tests use generated identities and mock upstreams. Native tests use an installed DSH and **temporary** credentials; they do not read your grant or spend inference quota. Real-account desktop validation is separately documented and always user-controlled.

Source is published directly as ESM; no generated `lib/` or vendor snapshot is necessary. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Update / remove

For a linked checkout, review/pull changes, run checks, then restart DSH safely. For an archive, install the reviewed replacement using the native plugin command. To remove:

```sh
npm run dsh -- plugin --profile desktop remove @pyh-pan/dsh-openai-oauth
```

Removal preserves stored credentials. If you want to disconnect this Agent, sign out or manage access in ChatGPT settings first; do not delete the entire DSH profile.

[MIT](LICENSE)
