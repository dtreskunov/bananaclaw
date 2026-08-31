import fs from 'node:fs';
import { isStepCount, streamText, type ModelMessage, type ToolSet, type UserModelMessage } from 'ai';

import { registerProvider } from './provider-registry.js';
import { loadConfig } from '../config.js';
import type {
  ActivityStep,
  AgentProvider,
  AgentQuery,
  FileAttachment,
  ForkContinuationInput,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
  QueryPushOptions,
  CallUsage,
  TurnUsage,
} from './types.js';
import { pickActivityDetail } from './types.js';
import { resolveNativeModel, type NativeModel } from './native/catalog.js';
import { loadNativeInstructions } from './native/instructions.js';
import { NativeSkillRegistry } from './native/skills.js';
import { NativeStore } from './native/store.js';
import { createNativeTools } from './native/tools.js';
import { NATIVE_TODO_INSTRUCTIONS, NativeTodoState, shouldRequireTodos } from './native/todos.js';

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

function usageFor(
  model: NativeModel,
  raw: unknown,
  finalStepRaw: unknown,
  durationMs: number,
  numTurns: number,
): TurnUsage {
  const usage = callUsageFor(model, raw);
  const finalStepUsage = callUsageFor(model, finalStepRaw);
  return {
    ...usage,
    num_turns: numTurns,
    duration_ms: durationMs,
    context_tokens: finalStepUsage.context_tokens,
  };
}

function callUsageFor(model: NativeModel, raw: unknown): CallUsage {
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
    model: model.wireId,
    context_window: model.contextWindow,
    max_output_tokens: model.maxOutputTokens,
    context_tokens: input + output,
  };
}

function patchTargets(input: Record<string, unknown> | undefined): string | undefined {
  if (typeof input?.patch !== 'string') return undefined;
  const files = [...new Set(
    [...input.patch.matchAll(/^(?:---|\+\+\+)\s+([^\t\n]+)/gm)]
      .map((match) => match[1].replace(/^[ab]\//, ''))
      .filter((filename) => filename !== '/dev/null'),
  )];
  if (files.length === 0) return undefined;
  return files.length <= 3
    ? files.join(', ')
    : `${files.slice(0, 3).join(', ')} +${files.length - 3} more`;
}

export function formatNativeToolStep(
  part: Record<string, unknown>,
  status: 'running' | 'completed' | 'error',
): ActivityStep {
  const input = part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : undefined;
  const tool = String(part.toolName ?? 'tool');
  let detail = pickActivityDetail(input);
  let title: string | undefined;
  if (tool === 'skill' && typeof input?.name === 'string' && input.name.trim()) {
    detail = typeof input.path === 'string' && input.path.trim()
      ? `${input.name.trim()}/${input.path.trim()}`
      : input.name.trim();
    title = status === 'running' ? 'Loading skill' : 'Loaded skill';
  } else if (tool === 'patch') {
    detail = patchTargets(input);
    title = status === 'running'
      ? detail ? 'Applying patch to' : 'Applying patch'
      : detail ? 'Applied patch to' : 'Applied patch';
  } else if (tool === 'todoread') {
    title = status === 'running' ? 'Reviewing task list' : 'Reviewed task list';
  }
  return {
    kind: 'tool',
    id: String(part.toolCallId ?? `native-tool-${Date.now()}`),
    tool,
    status,
    ...(detail ? { detail } : {}),
    ...(title ? { title } : {}),
    ...(status === 'error' ? { error: errorMessage(part.error) } : {}),
  };
}

// Each protocol's ai-sdk package is imported on demand: a group speaks one of
// them, and loading both costs ~6MB resident for nothing.
async function languageModel(model: NativeModel) {
  if (model.protocol === 'anthropic-messages') {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    return createAnthropic({
      name: model.providerId,
      baseURL: model.baseURL,
      apiKey: 'placeholder',
    }).messages(model.modelId);
  }
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  return createOpenAICompatible({
    name: model.providerId,
    baseURL: model.baseURL,
    apiKey: 'placeholder',
    includeUsage: true,
  }).chatModel(model.modelId);
}

/**
 * Defers loading `native/mcp-client.js` until a turn actually needs external
 * MCP tools. The MCP client SDK plus its four transports costs ~19MB resident
 * and most native groups configure no external servers at all.
 */
function lazyMcpManager(servers: Record<string, McpServerConfig> | undefined, cwd: string) {
  const configured = servers && Object.keys(servers).length > 0 ? servers : null;
  let instance: import('./native/mcp-client.js').NativeMcpManager | null = null;
  return {
    async tools(signal: AbortSignal): Promise<ToolSet> {
      if (!configured) return {};
      if (!instance) {
        const { NativeMcpManager } = await import('./native/mcp-client.js');
        instance = new NativeMcpManager(configured, cwd);
      }
      return instance.tools(signal);
    },
    async close(): Promise<void> {
      await instance?.close();
    },
  };
}

export function portableHistory(messages: ModelMessage[]): ModelMessage[] {
  const ephemeralToolCallIds = new Set<string>();
  const isTodoTool = (toolName: string): boolean =>
    ['todowrite', 'todoread', 'todo_update', 'todo_read'].includes(toolName);
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if ('toolName' in part && typeof part.toolName === 'string' && isTodoTool(part.toolName)) {
          ephemeralToolCallIds.add(part.toolCallId);
        }
      }
    } else if (message.role === 'tool') {
      for (const part of message.content) {
        if ('toolName' in part && typeof part.toolName === 'string' && isTodoTool(part.toolName)) {
          ephemeralToolCallIds.add(part.toolCallId);
        }
        if (
          part.type === 'tool-result' &&
          part.output.type === 'error-text' &&
          /Available tools: (?:todowrite|todo_update)/.test(part.output.value)
        ) {
          ephemeralToolCallIds.add(part.toolCallId);
        }
      }
    }
  }
  const output: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const content = message.content.filter((part) => {
        if (part.type === 'reasoning' || part.type === 'reasoning-file') return false;
        if (part.type === 'text' && /\b(?:todowrite|todoread|todo_(?:update|read))\b/.test(part.text)) return false;
        return !('toolCallId' in part && ephemeralToolCallIds.has(part.toolCallId));
      });
      if (content.length > 0) output.push({ ...message, content });
    } else if (message.role === 'tool') {
      const content = message.content.filter(
        (part) => !('toolCallId' in part && ephemeralToolCallIds.has(part.toolCallId)),
      );
      if (content.length > 0) output.push({ ...message, content });
    } else {
      output.push(message);
    }
  }
  return output;
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
    const mcpManager = lazyMcpManager(options.mcpServers, input.cwd);
    const skills = new NativeSkillRegistry(undefined, undefined, undefined, loadConfig().disabledSkills);

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        try {
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
              const todoState = new NativeTodoState();
              const configuredModel = options.model ?? process.env.NATIVE_MODEL;
              if (!configuredModel) throw new Error('native requires a canonical model setting');
              const resolved = await resolveNativeModel(configuredModel);
              const prior = portableHistory(store.messages(continuation));
              const incoming = userMessage(turn.text, turn.files, resolved);
              const tools = turn.toolsDisabled
                ? {}
                : {
                    ...createNativeTools(input.cwd, options.additionalDirectories, skills, todoState),
                    ...(await mcpManager.tools(abortController.signal)),
                  };
              const configuredMaxOutput =
                typeof options.modelParams?.max_tokens === 'number'
                  ? Math.floor(options.modelParams.max_tokens)
                  : resolved.maxOutputTokens;
              const result = streamText({
                model: await languageModel(resolved),
                system: loadNativeInstructions(
                  input.systemContext?.instructions,
                  skills.instructions(),
                  turn.toolsDisabled ? null : NATIVE_TODO_INSTRUCTIONS,
                ),
                messages: [...prior, incoming],
                tools,
                stopWhen: isStepCount(20),
                ...(!turn.toolsDisabled && shouldRequireTodos(turn.text)
                  ? {
                      prepareStep: ({ stepNumber, instructions }) =>
                        stepNumber === 0
                          ? {
                              activeTools: ['todowrite'] as const,
                              toolChoice: { type: 'tool' as const, toolName: 'todowrite' as const },
                              instructions: `${String(
                                instructions ?? '',
                              )}\n\nThis is a planning-only step. Call todowrite exactly once and do not call any other tool.`,
                            }
                          : undefined,
                    }
                  : {}),
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
                if (part.type === 'tool-call') yield { type: 'progress', step: formatNativeToolStep(part, 'running') };
                else if (part.type === 'tool-result') yield { type: 'progress', step: formatNativeToolStep(part, 'completed') };
                else if (part.type === 'tool-error') yield { type: 'progress', step: formatNativeToolStep(part, 'error') };
                else if (part.type === 'error') throw part.error;
                else if (part.type === 'finish-step') {
                  yield {
                    type: 'usage_call',
                    data: callUsageFor(resolved, part.usage),
                  };
                  yield { type: 'assistant_message' };
                }
              }

              const responseMessages = (await result.responseMessages) as ModelMessage[];
              const checkpoint = store.append(continuation, [incoming, ...portableHistory(responseMessages)]);
              const [usage, steps] = await Promise.all([result.usage, result.steps]);
              yield {
                type: 'usage',
                data: usageFor(resolved, usage, steps.at(-1)?.usage, Date.now() - startedAt, steps.length),
              };
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
        } finally {
          await mcpManager.close();
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
        void mcpManager.close();
        wake?.();
      },
      events,
    };
  }
}

registerProvider('native', (options) => new NativeProvider(options));
