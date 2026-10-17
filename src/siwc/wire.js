import { SiwcError, digest, reject } from './protocol.js';
import { PROVIDER } from './controller.js';

export const REPLAY_KIND = 'chatgpt-subscription-responses';
export const TOOL_NAMESPACE = 'dsh';
const MAX_EVENT = 8 * 1024 * 1024;
const asText = (blocks) =>
  blocks
    .map((block) => {
      if (block.type !== 'text') reject('UNSUPPORTED_CONTENT');
      return block.text;
    })
    .join('\n');

export function callId(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 4096) reject('INVALID_TOOL_HISTORY');
  const base = raw.split('|', 1)[0];
  return /^[A-Za-z0-9_-]{1,64}$/.test(base) ? base : `call_${digest(raw)}`;
}
function visibleOutput(output) {
  const blocks = [];
  for (const item of output) {
    if (item.type === 'message')
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') blocks.push({ type: 'text', text: part.text });
        else if (part.type === 'refusal') blocks.push({ type: 'text', text: part.refusal });
      }
    if (item.type === 'function_call')
      blocks.push({
        type: 'tool-call',
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
  }
  return blocks;
}
function canonical(blocks) {
  const result = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      if (result.at(-1)?.type === 'text') result.at(-1).text += block.text;
      else result.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool-call')
      result.push({
        type: 'tool-call',
        id: callId(block.id),
        name: block.name,
        arguments: block.arguments,
      });
  }
  return JSON.stringify(result);
}
export function replayOutput(output) {
  if (!Array.isArray(output) || output.length > 4096) reject('INVALID_RESPONSE', 502);
  return output.map((item) => {
    if (!item || typeof item !== 'object') reject('INVALID_RESPONSE', 502);
    if (item.type === 'reasoning') {
      const summary = (item.summary ?? []).map((part) => {
        if (part.type !== 'summary_text' || typeof part.text !== 'string')
          reject('INVALID_RESPONSE', 502);
        return { type: 'summary_text', text: part.text };
      });
      return {
        type: 'reasoning',
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        summary,
        ...(typeof item.encrypted_content === 'string'
          ? { encrypted_content: item.encrypted_content }
          : {}),
      };
    }
    if (item.type === 'function_call') {
      if (
        typeof item.call_id !== 'string' ||
        callId(item.call_id) !== item.call_id ||
        typeof item.name !== 'string' ||
        !item.name ||
        typeof item.arguments !== 'string'
      )
        reject('INVALID_RESPONSE', 502);
      if (item.namespace !== undefined && item.namespace !== TOOL_NAMESPACE)
        reject('UNSUPPORTED_TOOL_NAMESPACE', 502);
      return {
        type: 'function_call',
        namespace: TOOL_NAMESPACE,
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      };
    }
    if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content))
      return {
        type: 'message',
        role: 'assistant',
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(['commentary', 'final_answer'].includes(item.phase) ? { phase: item.phase } : {}),
        content: item.content.map((part) => {
          if (part.type === 'output_text' && typeof part.text === 'string')
            return { type: 'output_text', text: part.text, annotations: [] };
          if (part.type === 'refusal' && typeof part.refusal === 'string')
            return { type: 'refusal', refusal: part.refusal };
          reject('UNSUPPORTED_OUTPUT', 502);
        }),
      };
    reject('UNSUPPORTED_OUTPUT', 502);
  });
}

export function responsesBody(options, { accountKey, reasoningSummary = false }) {
  if (options.stop !== undefined) reject('UNSUPPORTED_OPTION');
  // The SIWC preview explicitly forbids these otherwise-standard API fields.
  // Reject explicit settings instead of silently pretending a limit was applied.
  if (options.maxTokens !== undefined) reject('UNSUPPORTED_MAX_TOKENS');
  if (options.temperature !== undefined) reject('UNSUPPORTED_TEMPERATURE');
  if (!Array.isArray(options.messages)) reject('INVALID_REQUEST');
  const input = [];
  const seenCalls = new Map();
  for (const message of options.messages)
    for (const block of message.content ?? [])
      if (block.type === 'tool-call') {
        const id = callId(block.id);
        if (seenCalls.has(id) && seenCalls.get(id) !== block.id) reject('INVALID_TOOL_HISTORY');
        seenCalls.set(id, block.id);
      }
  for (const message of options.messages) {
    if (!Array.isArray(message.content)) reject('INVALID_REQUEST');
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: callId(message.toolCallId),
        output: `${message.isError ? '[Tool error]\n' : ''}${asText(message.content)}`,
      });
      continue;
    }
    if (message.role === 'assistant') {
      const state = message.source?.replayState?.response;
      let native;
      if (
        message.source?.provider === PROVIDER &&
        message.source?.model === options.model &&
        state?.kind === REPLAY_KIND &&
        state.version === 1 &&
        state.accountKey === accountKey
      ) {
        // Native encrypted reasoning/phase metadata is reusable only while its
        // visible contents, exact model and account still match durable history.
        try {
          const candidate = replayOutput(state.output);
          if (canonical(visibleOutput(candidate)) === canonical(message.content))
            native = candidate;
        } catch {
          /* Foreign/edited/old replay degrades to durable text+tools. */
        }
      }
      if (native) {
        input.push(...native);
        continue;
      }
      for (const block of message.content) {
        if (block.type === 'text' && block.text)
          input.push({
            role: 'assistant',
            content: [{ type: 'output_text', text: block.text, annotations: [] }],
          });
        else if (block.type === 'tool-call')
          input.push({
            type: 'function_call',
            namespace: TOOL_NAMESPACE,
            call_id: callId(block.id),
            name: block.name,
            arguments: block.arguments,
          });
        else if (!['text', 'reasoning'].includes(block.type)) reject('UNSUPPORTED_CONTENT');
      }
      continue;
    }
    if (!['user', 'system', 'developer'].includes(message.role)) reject('UNSUPPORTED_CONTENT');
    const text = asText(message.content);
    if (text)
      input.push({
        role: message.role === 'system' ? 'developer' : message.role,
        content: [{ type: 'input_text', text }],
      });
  }
  const tools = options.tools?.map((tool) => {
    if (tool.deferLoading) reject('UNSUPPORTED_CONTENT');
    return {
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters,
      strict: false,
    };
  });
  return {
    model: options.model,
    input,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    ...(options.system !== undefined ? { instructions: options.system } : {}),
    ...(tools?.length
      ? {
          tools: [
            {
              type: 'namespace',
              name: TOOL_NAMESPACE,
              description: 'Tools executed locally by DSH Desktop.',
              tools,
            },
          ],
        }
      : {}),
    ...(options.reasoningEffort !== undefined
      ? {
          reasoning: {
            effort: options.reasoningEffort,
            ...(reasoningSummary ? { summary: 'auto' } : {}),
          },
        }
      : {}),
  };
}

async function readChunk(reader, signal, idleTimeoutMs) {
  if (signal?.aborted) reject('CANCELLED');
  let timer, onAbort;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, rejectRead) => {
        timer = setTimeout(
          () => rejectRead(new SiwcError('STREAM_IDLE_TIMEOUT', 504)),
          idleTimeoutMs,
        );
        if (signal) {
          onAbort = () => rejectRead(new SiwcError('CANCELLED'));
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export async function* sseEvents(
  body,
  { signal, idleTimeoutMs = 120000, maxEventBytes = MAX_EVENT } = {},
) {
  if (!body) reject('INVALID_STREAM', 502);
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '',
    eventName = '',
    data = [],
    eventSize = 0,
    sawCR = false;
  function event() {
    if (!data.length) {
      eventName = '';
      eventSize = 0;
      return undefined;
    }
    const text = data.join('\n');
    data = [];
    eventSize = 0;
    const name = eventName;
    eventName = '';
    if (text === '[DONE]') return { type: '__done' };
    try {
      const parsed = JSON.parse(text);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.type !== 'string' ||
        (name && name !== 'message' && name !== parsed.type)
      )
        reject('INVALID_STREAM', 502);
      return parsed;
    } catch {
      reject('INVALID_STREAM', 502);
    }
  }
  function line(value) {
    if (value === '') return event();
    if (value.startsWith(':')) return undefined;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') eventName = content;
    if (field === 'data') {
      data.push(content);
      eventSize += Buffer.byteLength(content);
      if (eventSize > maxEventBytes) reject('STREAM_EVENT_TOO_LARGE', 502);
    }
  }
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal, idleTimeoutMs);
      let text;
      try {
        text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      } catch {
        reject('INVALID_STREAM', 502);
      }
      for (const char of text) {
        if (sawCR) {
          sawCR = false;
          if (char === '\n') continue;
        }
        if (char === '\r' || char === '\n') {
          const parsed = line(pending);
          pending = '';
          if (char === '\r') sawCR = true;
          if (parsed) {
            if (parsed.type === '__done') return;
            yield parsed;
          }
        } else {
          pending += char;
          if (pending.length > maxEventBytes) reject('STREAM_EVENT_TOO_LARGE', 502);
        }
      }
      if (done) break;
    }
    // A blank line delimits each event. Never treat an unterminated partial JSON
    // record as a successful terminal event on a broken connection.
    if (pending || data.length) reject('STREAM_CLOSED', 502);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Socket already failed/aborted. */
    }
    reader.releaseLock();
  }
}

export const PROVIDER_ERRORS = {
  subscription_sharing_user_not_eligible: 'CHATGPT_NOT_ELIGIBLE',
  subscription_sharing_usage_limit_exceeded: 'QUOTA',
  subscription_sharing_usage_unavailable: 'SERVER',
  subscription_sharing_user_unavailable: 'SERVER',
  subscription_sharing_unsupported_capability: 'INVALID_REQUEST',
  subscription_sharing_route_not_supported: 'CHATGPT_ROUTE_UNSUPPORTED',
  subscription_sharing_invalid_user: 'AUTH',
  chatpass_v2_scope_not_authorized: 'DIRECT_PERMISSION_MISSING',
  chatpass_v2_invalid_authorization_context: 'DIRECT_PERMISSION_MISSING',
  context_length_exceeded: 'CONTEXT_WINDOW_EXCEEDED',
  rate_limit_exceeded: 'RATE_LIMIT',
  insufficient_quota: 'QUOTA',
};
export function providerFailure(error, status, requestId) {
  const rawCode = error?.code;
  const code = Object.hasOwn(PROVIDER_ERRORS, rawCode)
    ? PROVIDER_ERRORS[rawCode]
    : status === 401
      ? 'AUTH'
      : status === 403
        ? 'CHATGPT_PERMISSION'
        : status === 429
          ? 'RATE_LIMIT'
          : status >= 500
            ? 'SERVER'
            : 'INVALID_REQUEST';
  return {
    code,
    message: code,
    ...(Number.isInteger(status) ? { status } : {}),
    ...(Object.hasOwn(PROVIDER_ERRORS, rawCode) ? { providerCode: rawCode } : {}),
    ...(typeof requestId === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(requestId)
      ? { requestId }
      : {}),
    // Deliberately preserve only schema facts, never upstream message/input data.
    responseShape: {
      error:
        typeof error === 'object' && error !== null
          ? Object.keys(error)
              .filter((key) => ['code', 'type', 'message', 'param'].includes(key))
              .sort()
          : [],
    },
  };
}

export class ResponseStream {
  constructor({ accountKey, model }) {
    this.accountKey = accountKey;
    this.model = model;
    this.blocks = [];
    this.items = new Map();
    this.doneItems = new Set();
    this.responseId = undefined;
    this.completed = false;
  }
  #newBlock(key, type, metadata = {}) {
    if (this.blocks.length >= 4096) reject('STREAM_TOO_LARGE', 502);
    const block = { index: this.blocks.length, key, type, text: '', closed: false, ...metadata };
    this.blocks.push(block);
    return block;
  }
  #find(key) {
    return this.blocks.find((block) => block.key === key);
  }
  *#set(key, type, value, metadata = {}, final = false) {
    if (typeof value !== 'string') reject('INVALID_STREAM', 502);
    let block = this.#find(key);
    if (!block) {
      block = this.#newBlock(key, type, metadata);
      yield { type: 'block-start', index: block.index, blockType: type };
    }
    if (
      block.type !== type ||
      (type === 'tool-call' && (block.callId !== metadata.callId || block.name !== metadata.name))
    )
      reject('INVALID_STREAM', 502);
    if (block.closed) {
      if (final && value === block.text) return;
      reject('INVALID_STREAM', 502);
    }
    if (final) {
      if (!value.startsWith(block.text)) reject('INVALID_STREAM', 502);
      value = value.slice(block.text.length);
    }
    if (value) {
      block.text += value;
      if (block.text.length > 16 * 1024 * 1024) reject('STREAM_TOO_LARGE', 502);
      if (type === 'tool-call')
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.callId,
          name: block.name,
          argumentsDelta: value,
        };
      else
        yield {
          type: type === 'reasoning' ? 'reasoning-delta' : 'text-delta',
          index: block.index,
          text: value,
        };
    }
    if (final) {
      block.closed = true;
      yield {
        type: 'block-end',
        index: block.index,
        block:
          type === 'tool-call'
            ? { type, id: block.callId, name: block.name, arguments: block.text }
            : { type, text: block.text },
      };
    }
  }
  *#itemDone(index, item) {
    if (item.type === 'function_call') {
      if (!item.call_id || !item.name) reject('INVALID_STREAM', 502);
      yield* this.#set(
        `tool:${index}`,
        'tool-call',
        item.arguments,
        { callId: item.call_id, name: item.name },
        true,
      );
    } else if (item.type === 'message') {
      for (const [contentIndex, part] of (item.content ?? []).entries()) {
        if (part.type === 'output_text')
          yield* this.#set(`text:${index}:${contentIndex}`, 'text', part.text, {}, true);
        else if (part.type === 'refusal')
          yield* this.#set(`text:${index}:${contentIndex}`, 'text', part.refusal, {}, true);
        else reject('UNSUPPORTED_OUTPUT', 502);
      }
    } else if (item.type === 'reasoning') {
      for (const [summaryIndex, part] of (item.summary ?? []).entries())
        if (part.text || this.#find(`reasoning:${index}:${summaryIndex}`))
          yield* this.#set(`reasoning:${index}:${summaryIndex}`, 'reasoning', part.text, {}, true);
    } else reject('UNSUPPORTED_OUTPUT', 502);
  }
  *event(event, requestId) {
    if (this.completed) reject('INVALID_STREAM', 502);
    const index = event.output_index;
    if (event.type === 'response.created') {
      if (typeof event.response?.id !== 'string') reject('INVALID_STREAM', 502);
      this.responseId = event.response.id;
    } else if (event.type === 'response.output_item.added') {
      if (!Number.isSafeInteger(index) || index < 0 || this.items.has(index))
        reject('INVALID_STREAM', 502);
      const item = event.item;
      this.items.set(index, item);
      if (item?.type === 'function_call')
        yield* this.#set(`tool:${index}`, 'tool-call', item.arguments ?? '', {
          callId: item.call_id,
          name: item.name,
        });
    } else if (['response.output_text.delta', 'response.refusal.delta'].includes(event.type)) {
      if (!this.items.has(index) || !Number.isSafeInteger(event.content_index))
        reject('INVALID_STREAM', 502);
      yield* this.#set(`text:${index}:${event.content_index}`, 'text', event.delta);
    } else if (event.type === 'response.function_call_arguments.delta') {
      const item = this.items.get(index);
      if (item?.type !== 'function_call') reject('INVALID_STREAM', 502);
      yield* this.#set(`tool:${index}`, 'tool-call', event.delta, {
        callId: item.call_id,
        name: item.name,
      });
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      if (this.items.get(index)?.type !== 'reasoning' || !Number.isSafeInteger(event.summary_index))
        reject('INVALID_STREAM', 502);
      yield* this.#set(`reasoning:${index}:${event.summary_index}`, 'reasoning', event.delta);
    } else if (event.type === 'response.output_item.done') {
      if (!Number.isSafeInteger(index) || index < 0) reject('INVALID_STREAM', 502);
      // Keep function calls unsealed until the successful terminal response;
      // partial/failed turns must not present a completed tool block to the host.
      if (event.item?.type !== 'function_call') yield* this.#itemDone(index, event.item);
      this.items.set(index, event.item);
      this.doneItems.add(index);
    } else if (event.type === 'response.completed') {
      const response = event.response;
      if (
        !response ||
        response.status !== 'completed' ||
        typeof response.id !== 'string' ||
        (this.responseId && this.responseId !== response.id)
      )
        reject('INVALID_STREAM', 502);
      let completedOutput = response.output;
      // Stateless streaming can omit the aggregate while supplying definitive
      // output_item.done records. Only reconstruct after response.completed,
      // with every contiguous item explicitly finalized; never trust deltas alone.
      if (Array.isArray(completedOutput) && completedOutput.length === 0 && this.items.size > 0) {
        if (this.doneItems.size !== this.items.size) reject('INVALID_STREAM', 502);
        completedOutput = Array.from({ length: this.items.size }, (_, itemIndex) => {
          if (!this.doneItems.has(itemIndex)) reject('INVALID_STREAM', 502);
          return this.items.get(itemIndex);
        });
      }
      const output = replayOutput(completedOutput);
      const finalChunks = [];
      for (const [itemIndex, item] of output.entries())
        finalChunks.push(...this.#itemDone(itemIndex, item));
      if (this.blocks.some((block) => !block.closed)) reject('INVALID_STREAM', 502);
      const streamed = this.blocks.map((block) =>
        block.type === 'tool-call'
          ? { type: block.type, id: block.callId, name: block.name, arguments: block.text }
          : { type: block.type, text: block.text },
      );
      if (canonical(streamed) !== canonical(visibleOutput(output))) reject('INVALID_STREAM', 502);
      const usage = response.usage ?? {};
      const inputTokens =
        Number.isFinite(usage.input_tokens) && usage.input_tokens >= 0 ? usage.input_tokens : 0;
      const outputTokens =
        Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0 ? usage.output_tokens : 0;
      const cacheRead =
        Number.isFinite(usage.input_tokens_details?.cached_tokens) &&
        usage.input_tokens_details.cached_tokens >= 0
          ? Math.min(usage.input_tokens_details.cached_tokens, inputTokens)
          : 0;
      if (!visibleOutput(output).some((block) => block.type === 'tool-call' || block.text))
        reject('EMPTY_RESPONSE', 502);
      yield* finalChunks;
      yield {
        type: 'usage',
        usage: {
          inputTokens: inputTokens - cacheRead,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
        },
      };
      this.completed = true;
      yield {
        type: 'finish',
        reason: {
          kind: output.some((item) => item.type === 'function_call') ? 'tool-calls' : 'stop',
        },
        replayState: {
          response: {
            kind: REPLAY_KIND,
            version: 1,
            accountKey: this.accountKey,
            model: this.model,
            responseId: response.id,
            output,
          },
          blocks: this.blocks.map((block) => ({ type: block.type })),
        },
      };
    } else if (event.type === 'response.failed' || event.type === 'error') {
      const error = event.response?.error ?? event.error ?? event;
      this.completed = true;
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: providerFailure(error, undefined, requestId) },
      };
    } else if (event.type === 'response.incomplete') {
      this.completed = true;
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'RESPONSE_INCOMPLETE', message: 'RESPONSE_INCOMPLETE' },
        },
      };
    }
    // Non-content lifecycle events and SSE pings do not manufacture output.
  }
}
