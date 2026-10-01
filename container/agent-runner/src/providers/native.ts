import { isStepCount, streamText, type ModelMessage, type ToolSet } from 'ai';

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
  SteeringInput,
} from './types.js';
import { fingerprintToolInput, pickActivityDetail } from './types.js';
import { resolveNativeModel, type NativeModel } from './native/catalog.js';
import { inlineHistoryBytes, MAX_INLINE_BYTES, prepareNativeUserMessage } from './native/attachments.js';
export { prepareNativeUserMessage as userMessage } from './native/attachments.js';
import { loadNativeInstructions } from './native/instructions.js';
import { NativeSkillRegistry } from './native/skills.js';
import { NativeStore } from './native/store.js';
import { NativeTurnJournal } from './native/turn-journal.js';
import { createNativeTools } from './native/tools.js';
import { NATIVE_TODO_INSTRUCTIONS, NativeTodoState, shouldRequireTodos } from './native/todos.js';
import {
  createReplyTools,
  FORCE_REPLY_PROMPT,
  isPointerReply,
  isReplyTool,
  POINTER_REPLY_PROMPT,
  REPLY_TOOL,
  ReplyCollector,
  replyRepair,
} from './native/reply.js';
import {
  DeferredMcpTools,
  estimateMcpToolTokens,
  mcpToolSearchMode,
  shouldDeferMcpTools,
} from './native/tool-search.js';

const MAX_STEPS = 20;

function log(message: string): void {
  console.error(`[native-provider] ${message}`);
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

/**
 * Maps AI SDK usage onto the provider-wide convention shared with the Claude
 * and OpenCode providers: `input_tokens` counts uncached input only, cache
 * reads/writes are separate, and `context_tokens` is the whole prompt plus reply.
 */
function callUsageFor(model: NativeModel, raw: unknown): CallUsage {
  const usage = (raw ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
  };
  const totalInput = usage.inputTokens ?? 0;
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const input = usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, totalInput - cacheRead - cacheWrite);
  const output = usage.outputTokens ?? 0;
  const inputRate = model.inputCostPerMTok ?? 0;
  const cost =
    (input * inputRate +
      cacheRead * (model.cacheReadCostPerMTok ?? inputRate) +
      cacheWrite * (model.cacheWriteCostPerMTok ?? inputRate) +
      output * (model.outputCostPerMTok ?? 0)) /
    1_000_000;
  return {
    cost_usd: cost,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: usage.outputTokenDetails?.reasoningTokens,
    model: model.wireId,
    context_window: model.contextWindow,
    max_output_tokens: model.maxOutputTokens,
    context_tokens: input + cacheRead + cacheWrite + output,
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
  } else if (tool === 'tool_search') {
    detail = typeof input?.query === 'string' ? input.query.replace(/^select:/i, '').trim() || undefined : undefined;
    title = status === 'running' ? 'Loading tools' : 'Loaded tools';
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
    async entries(signal: AbortSignal): Promise<import('./native/mcp-client.js').McpToolEntry[]> {
      if (!configured) return [];
      if (!instance) {
        const { NativeMcpManager } = await import('./native/mcp-client.js');
        instance = new NativeMcpManager(configured, cwd);
      }
      return instance.entries(signal);
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
  readonly supportsSteering = true;
  readonly supportsInputEditing = true;
  readonly supportsInputCancellation = true;
  readonly replyTool = true;
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

  appliedSteering(continuation: string, ids: string[]): string[] {
    return this.store.appliedSteering(continuation, ids);
  }

  query(input: QueryInput): AgentQuery {
    type Pending = { text: string; files?: FileAttachment[]; toolsDisabled?: boolean };
    const pending: Pending[] = [{ text: input.prompt, files: input.files }];
    let wake: (() => void) | null = null;
    let ended = false;
    let stoppedByUser = false;
    let active = false;
    const steering: SteeringInput[] = [];
    const acceptedSteering = new Set<string>();
    const preparingSteering = new Set<string>();
    const abortController = new AbortController();
    const options = this.options;
    const store = this.store;
    const mcpManager = lazyMcpManager(options.mcpServers, input.cwd);
    const toolSearchMode = mcpToolSearchMode(options.modelParams?.mcp_tool_search);
    let loggedDeferral = false;
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

          let initialPending = true;
          while (initialPending || !abortController.signal.aborted) {
            initialPending = false;
            if (pending.length === 0) {
              if (ended) break;
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = null;
              continue;
            }

            const turn = pending.shift()!;
            active = true;
            const startedAt = Date.now();
            let journal: NativeTurnJournal | undefined;
            const callUsages: CallUsage[] = [];
            function* flushCallUsage(): Generator<ProviderEvent> {
              for (const data of callUsages.splice(0)) yield { type: 'usage_call', data };
            }
            try {
              const todoState = new NativeTodoState();
              const configuredModel = options.model ?? process.env.NATIVE_MODEL;
              if (!configuredModel) throw new Error('native requires a canonical model setting');
              const prior = portableHistory(store.messages(continuation));
              journal = new NativeTurnJournal(store, continuation, { role: 'user', content: turn.text });
              abortController.signal.throwIfAborted();
              const resolved = await resolveNativeModel(configuredModel);
              abortController.signal.throwIfAborted();
              const incoming = await prepareNativeUserMessage(turn.text, turn.files, resolved, {
                signal: abortController.signal,
                maxInlineBytes: MAX_INLINE_BYTES - inlineHistoryBytes(prior),
              });
              journal.updateInput(incoming);
              abortController.signal.throwIfAborted();
              const replies = new ReplyCollector();
              const replyTools = createReplyTools(replies);
              const nativeTools: ToolSet = turn.toolsDisabled
                ? replyTools
                : { ...createNativeTools(input.cwd, options.additionalDirectories, skills, todoState), ...replyTools };
              const mcpEntries = turn.toolsDisabled ? [] : await mcpManager.entries(abortController.signal);
              // Large external tool sets are loaded on demand via tool_search;
              // the loaded set can grow between steps, so rebuild per step.
              const deferredMcp = shouldDeferMcpTools(mcpEntries, toolSearchMode)
                ? new DeferredMcpTools(mcpEntries, prior)
                : null;
              if (deferredMcp && !loggedDeferral) {
                loggedDeferral = true;
                console.error(
                  `[native-provider] Deferring ${mcpEntries.length} MCP tools (~${estimateMcpToolTokens(mcpEntries)} tokens) behind tool_search`,
                );
              }
              const mcpTools: ToolSet = deferredMcp
                ? {}
                : Object.fromEntries(mcpEntries.map((entry) => [entry.name, entry.tool]));
              const stepTools = (): ToolSet => ({ ...nativeTools, ...(deferredMcp?.toolSet() ?? mcpTools) });
              const mcpCatalog = deferredMcp?.instructions() ?? null;
              abortController.signal.throwIfAborted();
              const configuredMaxOutput =
                typeof options.modelParams?.max_tokens === 'number'
                  ? Math.floor(options.modelParams.max_tokens)
                  : resolved.maxOutputTokens;
              const model = await languageModel(resolved);
              const messages: ModelMessage[] = [...prior, incoming];
              const repairReply = replyRepair(replies);
              let stepsCompleted = 0;
              let finishReason = '';
              let checkpoint = journal.checkpoint;
              const appliedSteeringIds: string[] = [];
              const totalUsage: TurnUsage = usageFor(resolved, {}, {}, 0, 0);
              // A reply (or an explicit no_reply) is owed for the latest input.
              let replyDue = true;
              // Transient instruction for a step that must call `reply`; never persisted.
              let forcing: string | null = null;
              let forcedReply = false;
              let pointerChecked = false;
              let undeliveredChars = 0;
              // What to deliver if even a forced step ends without calling reply.
              let salvage: string | null = null;
              while (true) {
                abortController.signal.throwIfAborted();
                const forcedStep = forcing;
                forcing = null;
                const repliesBefore = replies.replies.length;
                const result = streamText({
                  model,
                  system: loadNativeInstructions(
                    input.systemContext?.instructions,
                    [skills.instructions(), mcpCatalog].filter(Boolean).join('\n\n') || null,
                    turn.toolsDisabled ? null : NATIVE_TODO_INSTRUCTIONS,
                  ),
                  messages: forcedStep ? [...messages, { role: 'user', content: forcedStep }] : messages,
                  tools: journal.wrap(stepTools(), abortController.signal),
                  repairToolCall: async (repair) =>
                    (await repairReply(repair)) ?? (deferredMcp ? deferredMcp.repairToolCall(repair) : null),
                  ...(forcedStep ? { toolChoice: { type: 'tool' as const, toolName: REPLY_TOOL } } : {}),
                  // Own the boundary: SDK prepareStep cannot resume a text-only
                  // final step and may race ahead of the consumer's event loop.
                  stopWhen: isStepCount(1),
                  ...(!turn.toolsDisabled && shouldRequireTodos(turn.text)
                    ? {
                        prepareStep: ({ instructions }) =>
                          stepsCompleted === 0
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
                  // A model call can finish before its tool does. Retain its
                  // usage even if cancellation prevents finish-step.
                  onLanguageModelCallEnd: ({ usage }) => {
                    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
                      callUsages.push(callUsageFor(resolved, usage));
                    }
                  },
                  ...(configuredMaxOutput ? { maxOutputTokens: configuredMaxOutput } : {}),
                  ...(typeof options.modelParams?.temperature === 'number'
                    ? { temperature: options.modelParams.temperature }
                    : {}),
                  ...(typeof options.modelParams?.top_p === 'number' ? { topP: options.modelParams.top_p } : {}),
                });

                // Start the resumed generation before yielding acknowledgements.
                // New guidance offered in response then targets this running step.
                for (const id of appliedSteeringIds.splice(0)) yield { type: 'steering_applied', id };
                for await (const rawPart of result.stream) {
                  yield* flushCallUsage();
                  yield { type: 'activity' };
                  const part = rawPart as unknown as Record<string, unknown>;
                  // The reply itself is the message, not activity.
                  if (isReplyTool(part.toolName)) continue;
                  if (part.type === 'tool-call') {
                    const toolInputFingerprint = fingerprintToolInput(part.input);
                    yield {
                      type: 'progress',
                      step: formatNativeToolStep(part, 'running'),
                      ...(toolInputFingerprint ? { toolInputFingerprint } : {}),
                    };
                  }
                  else if (part.type === 'tool-result') yield { type: 'progress', step: formatNativeToolStep(part, 'completed') };
                  else if (part.type === 'tool-error') yield { type: 'progress', step: formatNativeToolStep(part, 'error') };
                  else if (part.type === 'error') throw part.error;
                  else if (part.type === 'text-delta') journal.appendText(String(part.text ?? ''));
                  else if (part.type === 'finish-step') {
                    journal.save();
                    yield { type: 'assistant_message' };
                  }
                }

                const responseMessages = (await result.responseMessages) as ModelMessage[];
                await journal.settle();
                yield* flushCallUsage();
                if (abortController.signal.aborted) throw new Error('Turn stopped');
                checkpoint = journal.finishSegment(portableHistory(responseMessages));
                messages.push(...responseMessages);
                const [usage, steps] = await Promise.all([result.usage, result.steps]);
                stepsCompleted += steps.length;
                const segmentUsage = usageFor(resolved, usage, steps.at(-1)?.usage, 0, 0);
                totalUsage.cost_usd += segmentUsage.cost_usd;
                totalUsage.input_tokens += segmentUsage.input_tokens;
                totalUsage.output_tokens += segmentUsage.output_tokens;
                totalUsage.cache_read_tokens += segmentUsage.cache_read_tokens;
                totalUsage.cache_write_tokens += segmentUsage.cache_write_tokens;
                totalUsage.reasoning_tokens = (totalUsage.reasoning_tokens ?? 0) + (segmentUsage.reasoning_tokens ?? 0);
                totalUsage.context_tokens = segmentUsage.context_tokens;
                const stepText = (await result.text).trim() || null;
                finishReason = String(await result.finishReason);
                const stepReplies = replies.replies.slice(repliesBefore);
                const repliedThisStep = replies.takeStepCalls() > 0;
                const pointer =
                  !pointerChecked &&
                  stepReplies.length === 1 &&
                  isPointerReply(stepReplies[0].text, undeliveredChars + (stepText?.length ?? 0));
                undeliveredChars += stepText?.length ?? 0;
                if (pointer) {
                  pointerChecked = true;
                  replies.discardLast(1);
                  log(`Rejected a reply that points at undelivered text: ${JSON.stringify(stepReplies[0].text.slice(0, 120))}`);
                }
                replyDue = pointer || (replyDue && !repliedThisStep);

                let applied = false;
                // Prepare all inputs before acknowledging any: preparation failures
                // must not consume input for a generation that never starts.
                const prepared: Array<{ input: SteeringInput; message: ModelMessage }> = [];
                let inlineBytes = inlineHistoryBytes(messages);
                while (!ended && stepsCompleted < MAX_STEPS && prepared.length < steering.length) {
                  const guidance = steering[prepared.length];
                  // Lock before preparation can yield: an edit must never change
                  // the buffer while an attachment is being prepared for ingestion.
                  preparingSteering.add(guidance.id);
                  if (store.appliedSteering(continuation, [guidance.id]).length > 0) {
                    steering.splice(prepared.length, 1);
                    yield { type: 'steering_applied', id: guidance.id };
                    continue;
                  }
                  const message = await prepareNativeUserMessage(guidance.prompt, guidance.files, resolved, {
                    signal: abortController.signal,
                    maxInlineBytes: MAX_INLINE_BYTES - inlineBytes,
                  });
                  inlineBytes += inlineHistoryBytes([message]);
                  prepared.push({ input: guidance, message });
                }
                abortController.signal.throwIfAborted();
                if (!ended) {
                  for (const item of prepared) {
                    if (journal.applySteering(item.input.id, item.message)) {
                      messages.push(item.message);
                      applied = true;
                    }
                    steering.shift();
                  }
                  appliedSteeringIds.push(...prepared.map((item) => item.input.id));
                }
                const step = steps.at(-1);
                const continueTools = step && step.toolCalls.length > 0 &&
                  step.toolCalls.every((call) => step.content.some((part) =>
                    (part.type === 'tool-result' || part.type === 'tool-error') &&
                    part.toolCallId === call.toolCallId));
                if (applied) {
                  // New guidance needs its own reply.
                  replyDue = true;
                  forcedReply = false;
                  salvage = null;
                  continue;
                }
                if (pointer) {
                  salvage = stepReplies[0].text;
                  forcing = POINTER_REPLY_PROMPT;
                  continue;
                }
                if (!replyDue) break;
                if (stepsCompleted < MAX_STEPS && continueTools) continue;
                salvage = stepText ?? salvage;
                if (forcedReply) break;
                forcedReply = true;
                forcing = FORCE_REPLY_PROMPT;
              }
              if (replyDue && salvage) {
                log('Turn ended without a reply call; delivering its final text as the reply');
                replies.record({ text: salvage });
              }
              // No await or yield between closing acceptance and deciding the
              // final result; guidance arriving after this belongs to a later turn.
              active = false;
              yield {
                type: 'usage',
                data: { ...totalUsage, duration_ms: Date.now() - startedAt, num_turns: stepsCompleted },
              };
              yield { type: 'checkpoint', ref: checkpoint };
              yield {
                type: 'result',
                text: null,
                finishReason,
                replies: replies.replies,
                ...(replies.replies.length === 0 && replies.silence !== null ? { silence: replies.silence } : {}),
              };
            } catch (error) {
              active = false;
              if (abortController.signal.aborted) {
                if (journal) {
                  await journal.settle();
                  yield* flushCallUsage();
                  for (const step of journal.activity()) {
                    if (step.kind !== 'tool' || !isReplyTool(step.tool)) yield { type: 'progress', step };
                  }
                  yield { type: 'checkpoint', ref: journal.save(true, stoppedByUser) };
                }
                break;
              }
              yield {
                type: 'error',
                message: errorMessage(error),
                retryable: /timeout|429|5\d\d|network|fetch/i.test(errorMessage(error)),
              };
            } finally {
              active = false;
              steering.length = 0;
              acceptedSteering.clear();
              preparingSteering.clear();
            }
          }
        } finally {
          ended = true;
          await mcpManager.close();
        }
      },
    };

    return {
      cancelSteering(id: string): boolean {
        if (!active || ended || abortController.signal.aborted || preparingSteering.has(id)) return false;
        const index = steering.findIndex((input) => input.id === id);
        if (index < 0) return false;
        steering.splice(index, 1);
        // Keep acceptedSteering as a tombstone against duplicate acceptance.
        return true;
      },
      replaceSteering(guidance: SteeringInput): boolean {
        if (!active || ended || abortController.signal.aborted || preparingSteering.has(guidance.id)) return false;
        const index = steering.findIndex((input) => input.id === guidance.id);
        if (index < 0) return false;
        steering[index] = guidance;
        return true;
      },
      steer(guidance: SteeringInput): boolean {
        if (!active || ended || abortController.signal.aborted) return false;
        if (!acceptedSteering.has(guidance.id)) {
          acceptedSteering.add(guidance.id);
          steering.push(guidance);
        }
        return true;
      },
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
      abort(reason): void {
        stoppedByUser = reason === 'user';
        abortController.abort();
        void mcpManager.close();
        wake?.();
      },
      events,
    };
  }
}

registerProvider('native', (options) => new NativeProvider(options));
