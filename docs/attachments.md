# Image and document input

Version 0.3.5 sends verified local attachment bytes as inline `input_image` and `input_file` parts to the public Responses endpoint. It never calls the Files upload API, fetches an attachment URL, or substitutes a path supplied in chat text for an uploaded attachment.

The [official SIWC limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) permit text, image and file inputs when the selected model accepts them, but exclude audio/video and the Files upload API. General Responses input shapes are documented in [Images and vision](https://developers.openai.com/api/docs/guides/images-vision) and [File inputs](https://developers.openai.com/api/docs/guides/file-inputs). API-key file-upload examples are not used by this provider.

## Supported inputs

- Images: PNG, JPEG, WebP and GIF admitted by DSH. DSH owns validation, orientation, metadata removal and single-frame normalization; animation is not transmitted. Request versions preserve aspect ratio without enlargement, with at most 4,194,304 pixels and a 4,096-pixel long edge. Their encoded-byte target is 4 MiB, not a guarantee every encoder result fits that target.
- Documents: PDF, TXT/Markdown/JSON/CSV/TSV, common code/text formats, DOC/DOCX/RTF/ODT, PPT/PPTX and XLS/XLSX. The exact filename-to-MIME allowlist is in `src/siwc/attachments.js`. Unknown binary formats such as ZIP/EXE are rejected, not silently omitted.
- PDF page images require a vision-capable model. Non-PDF documents are processed according to the upstream file-input rules; inline transmission does not promise interpretation of embedded Office images/charts or every spreadsheet row.
- Only user attachment blocks are accepted. System/developer attachments and tool-result image/file content are not enabled by this implementation.

Model names are not used to invent capabilities. If the catalog supplies `input_modalities`, `supports_image_input` or `supports_file_input`, recognized facts and explicit exclusions are enforced; malformed/conflicting facts fail closed. These optional fields are not asserted to be a required SIWC catalog schema. Missing image facts remain unknown in the native directory instead of falsely declaring text-only or guaranteed vision support. Missing native image-read support remains an explicit text-only capability. The server remains authoritative for model/account acceptance.

## Local limits and history

Limits cover the entire replayed request, not only its newest message:

| Limit                                                         | Value      |
| ------------------------------------------------------------- | ---------- |
| Retained images                                               | 20         |
| Files                                                         | 10         |
| Each file / encoded image version                             | 20 MiB     |
| Combined raw file bytes                                       | 40 MiB     |
| Combined inline data-URL bytes, counting repeated occurrences | 64 MiB     |
| Local attachment-read/preparation deadline                    | 30 seconds |

These are conservative plugin limits, not claims about upstream maximums. File data is read in bounded chunks, checked against the declared size and SHA-256, and encoded only after verification. There is no arbitrary local filesystem read by this adapter. Native image request versions are verified by the attachment backend and checked against the requested dimensions and byte accounting.

The durable conversation retains structured references, not new base64 event records or remote file IDs. Every stateless Responses request reconstructs needed attachment input from those references. Native explicitly offloaded images remain text placeholders and are never re-sent as pixels. Over-limit history fails explicitly; this source does not silently discard old attachments to make a request fit. Existing assistant reasoning/tool replay and session affinity are unchanged.

## Native file projection bridge

DSH Desktop 0.2.1-rc.2 projects file blocks to local-tool handle text before adapter dispatch. A provider that only implements wire serialization therefore cannot receive those files directly.

The bridge uses the public `llm/stream` middleware seam to retain the original structured file occurrences in a request-local `AsyncLocalStorage` scope. At dispatch it restores only matching user message IDs, positions and exact native-generated handle values. It preserves other native projections. No text scan discovers file references or paths; a chat message that imitates a handle cannot trigger a read. Concurrent/nested calls and iterator cleanup keep separate scopes. The scope also remembers whether any admitted user image remains non-offloaded: native text-only projection cannot erase that fact and bypass the resolved model's negative capability check. Such requests fail before inference instead of silently sending image placeholders; explicitly offloaded images remain allowed as text. A changed native projection fails with `ATTACHMENT_PROJECTION_CHANGED` instead of guessing.

The installed rc.2 image backend requires explicit `width`, `height` and `maxBytes` request targets. Older development declarations describing only `maxPixels` are not proof of the installed runtime contract. Missing native bridge contracts fail with a named compatibility diagnostic; do not patch ASAR/framework modules to bypass them.

## Verification boundary

`npm run test:native` exercises the actual installed LlmRuntime and local attachment backend using generated images, TXT/PDF bytes, a temporary credential store and mock upstreams. It verifies the file projection bridge, inline bytes, history replay, unknown modality handling, negative image capability after native projection, explicitly offloaded text-only continuation, concurrent scope isolation and corruption rejection. This attachment suite was previously exercised on macOS arm64 Desktop 0.2.1-rc.2. The merged 0.3.6 suites also pass on Windows x64 Desktop 0.2.1-rc.2, including the actual provider entry's inline image/file bridge, prepared negative capability and unknown-session guard. These are native synthetic checks, not a claim that every historically validated release or either platform's GUI/real-account path has passed.

Real-account image/document inference is separate, user-approved verification. Do not use private conversation history or arbitrary user files for an unattended test.
