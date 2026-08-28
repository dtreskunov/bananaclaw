import fs from 'node:fs';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { isStepCount, streamText, type ModelMessage, type UserModelMessage } from 'ai';

import { registerProvider } from './provider-registry.js';
import type {
  ActivityStep,
  AgentProvider,
  AgentQuery,
  FileAttachment,
  ForkContinuationInput,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
  QueryPushOptions,
  TurnUsage,
} from './types.js';
import { pickActivityDetail } from './types.js';
import { resolveNativeModel, type NativeModel } from './native/catalog.js';
import { loadNativeInstructions } from './native/instructions.js';
import { NativeStore } from './native/store.js';
import { createNativeTools } from './native/tools.js';

function log(message: string): void {
  console.error(`[native-provider] ${message}`);
}

const NATIVE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const NATIVE_AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav']);

function attachmentModality(file: FileAttachment): string | null {
  if (NATIVE_IMAGE_MIME_TYPES.has(file.mime)) return 'image';
  if (NATIVE_AUDIO_MIME_TYPES.has(file.mime)) return 'audio';
  if (file.mime.startsWith('video/')) return 'video';
  if (file.mime === 'application/pdf') return 'pdf';
  if (file.mime === 'text/plain') return 'text';
  return null;
}

function protocolSupportsModality(protocol: NativeModel['protocol'], modality: string): boolean {
  if (protocol === 'anthropic-messages') return modality === 'text' || modality === 'image' || modality === 'pdf';
  return (
    modality === 'text' || modality === 'image' || modality === 'audio' || modality === 'video' || modality === 'pdf'
  );
}

export function userMessage(
  text: string,
  files: FileAttachment[] | undefined,
  model?: Pick<NativeModel, 'protocol' | 'inputModalities'>,
): UserModelMessage {
  const nativeFiles = (files ?? []).filter((file) => {
    const modality = attachmentModality(file);
    if (!modality) return false;
    if (model && !protocolSupportsModality(model.protocol, modality)) return false;
    return !model?.inputModalities || model.inputModalities.includes(modality);
  });
  if (nativeFiles.length === 0) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...nativeFiles.map((file) => ({
        type: 'file' as const,
        data: fs.readFileSync(file.path).toString('base64'),
        mediaType: file.mime,
        filename: file.filename,
      })),
    ],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usageFor(model: NativeModel, raw: unknown, durationMs: number): TurnUsage {
  const usage = (raw ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cost = (input * (model.inputCostPerMTok ?? 0) + output * (model.outputCostPerMTok ?? 0)) / 1_000_000;
  return {
    cost_usd: cost,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: usage.cachedInputTokens ?? 0,
    cache_write_tokens: 0,
    reasoning_tokens: usage.reasoningTokens,
    duration_ms: durationMs,
    model: model.wireId,
    context_window: model.contextWindow,
    max_output_tokens: model.maxOutputTokens,
    context_tokens: input + output,
  };
}

function toolStep(part: Record<string, unknown>, status: 'running' | 'completed' | 'error'): ActivityStep {
  const input = part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : undefined;
  return {
    kind: 'tool',
    id: String(part.toolCallId ?? `native-tool-${Date.now()}`),
    tool: String(part.toolName ?? 'tool'),
    status,
    ...(pickActivityDetail(input) ? { detail: pickActivityDetail(input) } : {}),
    ...(status === 'error' ? { error: errorMessage(part.error) } : {}),
  };
}

function languageModel(model: NativeModel) {
  if (model.protocol === 'anthropic-messages') {
    return createAnthropic({
      name: model.providerId,
      baseURL: model.baseURL,
      apiKey: 'placeholder',
    }).messages(model.modelId);
  }
  return createOpenAICompatible({
    name: model.providerId,
    baseURL: model.baseURL,
    apiKey: 'placeholder',
    includeUsage: true,
  }).chatModel(model.modelId);
}

export function portableHistory(messages: ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return [message];
    const content = message.content.filter((part) => part.type !== 'reasoning' && part.type !== 'reasoning-file');
    return content.length > 0 ? [{ ...message, content }] : [];
  });
}

export class NativeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private readonly options: ProviderOptions;
  private readonly store: NativeStore;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
    this.store = new NativeStore();
    if (options.effort) log(`Ignoring unsupported generic Chat effort value: ${options.effort}`);
  }

  isSessionInvalid(error: unknown): boolean {
    return /native continuation .* not found/i.test(errorMessage(error));
  }

  async forkContinuation(input: ForkContinuationInput): Promise<string | null> {
    return this.store.fork(input.continuation, input.anchorRef);
  }

  query(input: QueryInput): AgentQuery {
    type Pending = { text: string; files?: FileAttachment[]; toolsDisabled?: boolean };
    const pending: Pending[] = [{ text: input.prompt, files: input.files }];
    let wake: (() => void) | null = null;
    let ended = false;
    const abortController = new AbortController();
    const options = this.options;
    const store = this.store;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        let continuation = input.continuation;
        if (continuation && !store.hasConversation(continuation)) {
          throw new Error(`Native continuation ${continuation} not found`);
        }
        continuation ??= store.createConversation();
        yield { type: 'init', continuation };

        while (!abortController.signal.aborted) {
          if (pending.length === 0) {
            if (ended) break;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
            continue;
          }

          const turn = pending.shift()!;
          const startedAt = Date.now();
          try {
            const configuredModel = options.model ?? process.env.NATIVE_MODEL;
            if (!configuredModel) throw new Error('native requires a canonical model setting');
            const resolved = await resolveNativeModel(configuredModel);
            const prior = portableHistory(store.messages(continuation));
            const incoming = userMessage(turn.text, turn.files, resolved);
            const tools = turn.toolsDisabled ? {} : createNativeTools(input.cwd, options.additionalDirectories);
            const configuredMaxOutput =
              typeof options.modelParams?.max_tokens === 'number'
                ? Math.floor(options.modelParams.max_tokens)
                : resolved.maxOutputTokens;
            const result = streamText({
              model: languageModel(resolved),
              system: loadNativeInstructions(input.systemContext?.instructions),
              messages: [...prior, incoming],
              tools,
              stopWhen: isStepCount(20),
              maxRetries: 2,
              abortSignal: abortController.signal,
              ...(configuredMaxOutput ? { maxOutputTokens: configuredMaxOutput } : {}),
              ...(typeof options.modelParams?.temperature === 'number'
                ? { temperature: options.modelParams.temperature }
                : {}),
              ...(typeof options.modelParams?.top_p === 'number' ? { topP: options.modelParams.top_p } : {}),
            });

            for await (const rawPart of result.stream) {
              yield { type: 'activity' };
              const part = rawPart as unknown as Record<string, unknown>;
              if (part.type === 'tool-call') yield { type: 'progress', step: toolStep(part, 'running') };
              else if (part.type === 'tool-result') yield { type: 'progress', step: toolStep(part, 'completed') };
              else if (part.type === 'tool-error') yield { type: 'progress', step: toolStep(part, 'error') };
              else if (part.type === 'error') throw part.error;
              else if (part.type === 'finish-step') yield { type: 'assistant_message' };
            }

            const responseMessages = (await result.responseMessages) as ModelMessage[];
            const checkpoint = store.append(continuation, [incoming, ...responseMessages]);
            yield { type: 'usage', data: usageFor(resolved, await result.usage, Date.now() - startedAt) };
            yield { type: 'checkpoint', ref: checkpoint };
            yield {
              type: 'result',
              text: (await result.text).trim() || null,
              finishReason: String(await result.finishReason),
            };
          } catch (error) {
            if (abortController.signal.aborted) break;
            yield {
              type: 'error',
              message: errorMessage(error),
              retryable: /timeout|429|5\d\d|network|fetch/i.test(errorMessage(error)),
            };
          }
        }
      },
    };

    return {
      push(message: string, files?: FileAttachment[], pushOptions?: QueryPushOptions): boolean {
        if (ended || abortController.signal.aborted) return false;
        pending.push({ text: message, files, toolsDisabled: pushOptions?.tools === 'disabled' });
        wake?.();
        return true;
      },
      end(): void {
        ended = true;
        wake?.();
      },
      abort(): void {
        abortController.abort();
        wake?.();
      },
      events,
    };
  }
}

registerProvider('native', (options) => new NativeProvider(options));
