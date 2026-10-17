# Third-party notices

## DeepSeek Harness

The plugin uses the installed DSH public Host/client interfaces as peers. The optional compaction entry subclasses the installed public BasicCompactionEngine hook and uses an original checkpoint template; it does not redistribute the native transaction/range/measurement implementation. No extracted DSH application, ASAR, framework snapshot, or pi-ai runtime is distributed here. DSH and its dependencies retain their respective MIT licenses and trademarks. Schemastery and Zod remain external installed Host peers, not vendored dependencies.

## OpenAI

The ChatGPT sign-in mark embedded in the client originates from OpenAI's official SIWC UI resources. OpenAI owns the relevant marks; use is subject to the [SIWC UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) and applicable brand rules. The project is not endorsed by OpenAI.

## Engineering reference

Repository organization and installation/security documentation were informed by [AdonisSheldon/dsh-openai-oauth](https://github.com/AdonisSheldon/dsh-openai-oauth), MIT-licensed (reviewed reference commit: ba29660530fe05779b06f129a0c0ed5c2237b73f). Its older Codex authentication implementation and bundled output are not copied or used. Any future substantial code reuse must retain its original license notices.

Prettier 3.6.2 (MIT) is a development-only formatter, not a bundled runtime dependency.

All current runtime implementation is included as source; native platform/framework dependencies remain external peers. No proper-lockfile or other copied credential subsystem is bundled.
