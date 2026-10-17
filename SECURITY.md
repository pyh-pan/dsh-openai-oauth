# Security policy

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/pyh-pan/dsh-openai-oauth/security/advisories/new) when enabled. If unavailable, ask the maintainer to establish a private channel without posting vulnerability details.

Never include credentials, JWTs/claims, OAuth codes or callback URLs, raw authorization responses, credential files, cookies, private account identifiers, internal endpoints, or unredacted traces in public issues.

Share only plugin/DSH versions, OS/architecture, sanitized steps, expected/actual behavior, and safe error codes. Do not authorize an investigator to log in as you or transfer tokens.

## Trust boundary

- Supported deployment is a local DSH Desktop Host. Remote forwarding/proxies and headless servers are not claimed supported.
- Management APIs require the native authenticated Connection carrier. The temporary anonymous OAuth listener binds only 127.0.0.1 and validates state, Host, method and path.
- Signature/issuer/audience/time/nonce/subject checks use official discovery and JWKS. Registered clients and tokens are scoped by account/workspace registration.
- Native credential storage protects local file access; it is not a claim of encrypted Keychain/DPAPI storage. A compromised OS user, debugger or trusted Host plugin remains outside this protection.
- Refresh uses the native cross-process lock and atomic persistence. Revocation failure is not disguised as remote sign-out.
- No telemetry or central account/token relay is introduced.

Keep personal profiles, extracted application files and real acceptance traces out of pull requests. The repository's tests intentionally use synthetic credentials.
