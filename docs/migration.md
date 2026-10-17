# Migrate an existing private installation

The public package is `@pyh-pan/dsh-openai-oauth`. It preserves:

- provider ID: `chatgpt-subscription`
- Host plugin/credential owner and inserted entry ID: `chatgpt-subscription-login`
- model slugs, stored host ID, account registrations and issued client IDs
- authenticated management API path and native storage behavior

The package name changes; registration identity does not.

## Updating the same public bundle after a Desktop upgrade

If the profile already links `@pyh-pan/dsh-openai-oauth` to this checkout, keep that owner and its credential namespace. On Desktop 0.2.1-rc.2, the previous plugin 0.3.1 is skipped because its peer range excludes rc.2; use the validated 0.3.2 checkout and the [installation checks](install.md), then the native add command and a safe restart. No private-to-public switch, credential migration, automatic reauthorization or version exemption is needed. A missing UI alone is not evidence that a grant was revoked.

## Safe switch

1. Finish any active DSH tasks and inspect the existing bundle identity without dumping profiles/credential contents.
2. Keep rollback metadata outside this repository. Never copy credential files.
3. Validate the new checkout and package first.
4. Use the installed DSH CLI/plugin manager to remove the **old bundle only**, then add the new checkout/archive. Do not enable both simultaneously, manually edit profile files, or rename credential namespaces.
5. Quit/restart normally and verify one source, the saved account, original model selection, other providers, and unchanged settings.
6. Roll back by removing the new bundle and reinstalling the previous reviewed package/reference if needed; leave grants intact.

Do not restore a whole profile backup over user changes. Do not migrate fixed-client Codex grants into SIWC; old unrelated grants remain untouched and require independent consent to revoke.

On a different computer, create its own host registration through normal sign-in. Never transfer tokens from the old installation.
