import { isStepCount, streamText, wrapLanguageModel, type LanguageModelCallEndEvent, type ModelMessage, type ToolSet } from 'ai';

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
import { fingerprintToolInput } from './types.js';
import { builtinToolResultError, toolActivityFields } from './tool-activity.js';
import { resolveNativeModel, type NativeModel } from './native/catalog.js';
import { inlineHistoryBytes, MAX_INLINE_BYTES, prepareNativeUserMessage } from './native/attachments.js';
export { prepareNativeUserMessage as userMessage } from './native/attachments.js';
import { loadNativeInstructions, nativeMediaInstructions } from './native/instructions.js';
import { NativeSkillRegistry } from './native/skills.js';
import { NativeStore } from './native/store.js';
import { NativeTurnJournal } from './native/turn-journal.js';
import {
  compactNativeContext, COMPACTION_INSTRUCTIONS, CompactionSummaryError, createCompactionPolicy, isContextOverflow, type NativeCompactionPlan,
} from './native/compaction.js';
import { createNativeTools } from './native/tools.js';
import { openAiToolMedia } from './native/tool-media.js';
import { NATIVE_TODO_INSTRUCTIONS, NativeTodoState, shouldRequireTodos } from './native/todos.js';
import {
  isPointerReply,
  NO_REPLY_TOOL,
  NO_REPLY_TOOLS,
  noReplyReason,
  STEP_LIMIT_PROMPT,
} from './native/reply.js';
import {
  DeferredMcpTools,
  estimateMcpToolTokens,
  mcpToolSearchMode,
  shouldDeferMcpTools,
} from './native/tool-search.js';

export const MAX_STEPS = 100;

function log(message: string): void {
  console.error(`[native-provider] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    context_tokens: typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0 &&
      typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0
      ? input + cacheRead + cacheWrite + output : undefined,
  };
}

function timedCallUsageFor(model: NativeModel, raw: unknown, responseTimeMs: number): CallUsage & { duration_api_ms: number } {
  return { ...callUsageFor(model, raw), duration_api_ms: Math.round(responseTimeMs) };
}

function addUsage(total: TurnUsage, data: CallUsage): void {
  total.cost_usd += data.cost_usd;
  total.input_tokens += data.input_tokens;
  total.output_tokens += data.output_tokens;
  total.cache_read_tokens += data.cache_read_tokens;
  total.cache_write_tokens += data.cache_write_tokens;
  total.reasoning_tokens = (total.reasoning_tokens ?? 0) + (data.reasoning_tokens ?? 0);
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
  const fields = toolActivityFields(tool, input);
  let detail = fields.detail;
  let title: string | undefined;
  const resultError = status === 'completed' ? builtinToolResultError(tool, part.output) : undefined;
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
  } else if (tool === 'view_image') {
    title = status === 'completed' ? 'Viewed image' : 'Viewing image';
  } else if (tool === 'view_pdf') {
    title = status === 'completed' ? 'Viewed PDF' : 'Viewing PDF';
  } else if (tool === 'listen_audio') {
    title = status === 'completed' ? 'Listened to audio' : 'Listening to audio';
  } else if (tool === 'view_video') {
    title = status === 'completed' ? 'Viewed video' : 'Viewing video';
  }
  return {
    kind: 'tool',
    id: String(part.toolCallId ?? `native-tool-${Date.now()}`),
    tool,
    status: resultError ? 'error' : status,
    ...(detail ? { detail } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    ...(title ? { title } : {}),
    ...(resultError || status === 'error' ? { error: resultError ?? errorMessage(part.error) } : {}),
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
    if ((message.role === 'assistant' || message.role === 'tool') && Array.isArray(message.content)) {
      for (const part of message.content) {
        if ('toolName' in part && typeof part.toolName === 'string' && isTodoTool(part.toolName)) {
          ephemeralToolCallIds.add(part.toolCallId);
        }
        if (
          message.role === 'tool' &&
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
  readonly structuredReplies = true;
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
            let modelCallMs = 0;
            let compactionCalls = 0;
            let journal: NativeTurnJournal | undefined;
            const callUsages: CallUsage[] = [];
            function* flushCallUsage(): Generator<ProviderEvent> {
              for (const data of callUsages.splice(0)) yield { type: 'usage_call', data };
            }
            try {
              const todoState = new NativeTodoState();
              const configuredModel = options.model ?? process.env.NATIVE_MODEL;
              if (!configuredModel) throw new Error('native requires a canonical model setting');
              const prior = portableHistory(store.contextMessages(continuation));
              const turnJournal = new NativeTurnJournal(store, continuation, { role: 'user', content: turn.text });
              journal = turnJournal;
              abortController.signal.throwIfAborted();
              const resolved = await resolveNativeModel(configuredModel);
              const miniMaxFlash = /^MiniMax-M3\.1-Flash-Preview$/i.test(resolved.modelId);
              const conversation = continuation;
              abortController.signal.throwIfAborted();
              const messages: ModelMessage[] = [...prior, { role: 'user', content: turn.text }];
              let toolMediaPressure = false;
              const nativeTools = (): ToolSet => turn.toolsDisabled
                ? {}
                : {
                    ...createNativeTools(input.cwd, skills, todoState, {
                      model: resolved,
                      maxInlineBytes: Math.max(0, MAX_INLINE_BYTES - inlineHistoryBytes(messages)),
                      onMediaPressure: () => { toolMediaPressure = true; },
                    }),
                    ...NO_REPLY_TOOLS,
                  };
              const configuredMaxOutput =
                typeof options.modelParams?.max_tokens === 'number'
                  ? Math.floor(options.modelParams.max_tokens)
                  : resolved.maxOutputTokens;
              const adapter = await languageModel(resolved);
              const model = resolved.protocol === 'openai-chat'
                ? wrapLanguageModel({ model: adapter, middleware: openAiToolMedia })
                : adapter;
              let stepsCompleted = 0;
              let finishReason = '';
              let reply: string | null = null;
              let silence: string | null = null;
              let checkpoint = journal.checkpoint;
              const appliedSteeringIds: string[] = [];
              const totalUsage: TurnUsage = callUsageFor(resolved, {});
              function recordCall({ usage, performance }: LanguageModelCallEndEvent, summary = false): void {
                const data = timedCallUsageFor(resolved, usage, performance.responseTimeMs);
                modelCallMs += data.duration_api_ms;
                if (summary) {
                  data.context_tokens = undefined;
                  compactionCalls++;
                }
                if (summary || usage.inputTokens !== undefined || usage.outputTokens !== undefined) callUsages.push(data);
                addUsage(totalUsage, data);
              }
              // One-off instruction for the next step; never persisted.
              let nudge: string | null = null;
              // Past the step limit: one more step, without tools, to report progress.
              let wrappingUp = false;
              // Text written alongside tool calls, which is never delivered.
              let undeliveredChars = 0;
              const compactionPolicy = createCompactionPolicy(resolved.contextWindow);
              async function* compactContext(plan: NativeCompactionPlan): AsyncGenerator<ProviderEvent> {
                abortController.signal.throwIfAborted();
                const compactStartedAt = Date.now();
                const compactId = `native-compaction-${continuation}-${plan.ordinal}-${compactStartedAt}`;
                yield { type: 'progress', step: {
                  kind: 'compaction', id: compactId, auto: true, status: 'running',
                  detail: plan.detail,
                } };
                try {
                  await turnJournal.settle();
                  const compactedContext = await compactNativeContext({
                    store, conversation, protectedInputs: turnJournal.inputRefs(),
                    attempt: plan.attempt, contextWindow: resolved.contextWindow, maxOutputTokens: resolved.maxOutputTokens,
                    reasoning: resolved.reasoning === true || miniMaxFlash,
                    signal: abortController.signal,
                    summarize: async (prompt, request) => {
                      const compacted = streamText({
                        model, system: COMPACTION_INSTRUCTIONS, messages: [{ role: 'user', content: prompt }],
                        maxOutputTokens: request.maxOutputTokens,
                        ...(miniMaxFlash ? { providerOptions: resolved.protocol === 'anthropic-messages'
                          ? { anthropic: { effort: 'low' } }
                          : { [resolved.providerId]: { reasoningEffort: 'low' } } } : {}),
                        maxRetries: 0, abortSignal: request.signal,
                        onLanguageModelCallEnd: (event) => recordCall(event, true),
                      });
                      for await (const part of compacted.stream) if (part.type === 'error') throw part.error;
                      const [text, finishReason, usage] = await Promise.all([
                        compacted.text, compacted.finishReason, compacted.usage,
                      ]);
                      return { text, finishReason, outputTokens: usage.outputTokens,
                        reasoningTokens: usage.outputTokenDetails?.reasoningTokens };
                    },
                  });
                  messages.splice(0, messages.length, ...portableHistory(store.contextMessages(conversation)));
                  compactionPolicy.observe(undefined);
                  yield* flushCallUsage();
                  yield { type: 'progress', step: {
                    kind: 'compaction', id: compactId, auto: true, status: 'completed',
                    detail: `Summarized ${compactedContext.sourceBytes} UTF-8 bytes in ${compactedContext.requests} model requests`,
                    durationMs: Date.now() - compactStartedAt,
                  } };
                } catch (error) {
                  yield* flushCallUsage();
                  yield { type: 'progress', step: {
                    kind: 'compaction', id: compactId, auto: true,
                    status: abortController.signal.aborted ? 'interrupted' : 'error',
                    error: errorMessage(error), durationMs: Date.now() - compactStartedAt,
                  } };
                  throw error;
                }
              }
              async function* maybeCompactContext(): AsyncGenerator<ProviderEvent> {
                const plan = compactionPolicy.proactive();
                if (!plan) return;
                if (plan === 'limit') {
                  yield { type: 'progress', step: {
                    kind: 'notification', id: `native-compaction-limit-${continuation}-${startedAt}`,
                    text: 'Automatic compaction limit reached for this turn',
                    detail: 'Continuing normally; context-overflow and media recovery remain available.',
                  } };
                  return;
                }
                try {
                  yield* compactContext(plan);
                } catch (error) {
                  abortController.signal.throwIfAborted();
                  compactionPolicy.disableProactive();
                  log(`Proactive compaction failed; retaining context: ${errorMessage(error)}`);
                  yield { type: 'progress', step: {
                    kind: 'notification', id: `native-compaction-${continuation}-${plan.ordinal}-${startedAt}-fallback`,
                    text: 'Automatic compaction failed; continuing with existing context',
                    detail: errorMessage(error),
                  } };
                }
              }
              async function* prepareInput(
                text: string, files: FileAttachment[] | undefined, extraBytes = 0,
              ): AsyncGenerator<ProviderEvent, ModelMessage> {
                while (true) {
                  let pressure = false;
                  const historyBytes = inlineHistoryBytes(messages);
                  const message = await prepareNativeUserMessage(text, files, resolved, {
                    signal: abortController.signal,
                    maxInlineBytes: MAX_INLINE_BYTES - historyBytes - extraBytes,
                    ...(historyBytes > 0 ? { onMediaPressure: () => { pressure = true; } } : {}),
                  });
                  if (!pressure) return message;
                  yield* compactContext(compactionPolicy.recover('media'));
                }
              }
              const incoming = yield* prepareInput(turn.text, turn.files);
              journal.updateInput(incoming);
              messages.splice(0, messages.length, ...portableHistory(store.contextMessages(continuation)));
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
              const stepTools = (): ToolSet => ({ ...nativeTools(), ...(deferredMcp?.toolSet() ?? mcpTools) });
              const mcpCatalog = deferredMcp?.instructions() ?? null;
              abortController.signal.throwIfAborted();
              while (true) {
                abortController.signal.throwIfAborted();
                while (inlineHistoryBytes(messages) > MAX_INLINE_BYTES)
                  yield* compactContext(compactionPolicy.recover('media'));
                yield* maybeCompactContext();
                toolMediaPressure = false;
                const stepNudge: string | null = nudge;
                nudge = null;
                const tools = wrappingUp ? {} : stepTools();
                const result = streamText({
                  model,
                  system: loadNativeInstructions(
                    input.systemContext?.instructions,
                    [skills.instructions(), mcpCatalog].filter(Boolean).join('\n\n') || null,
                    turn.toolsDisabled ? null : NATIVE_TODO_INSTRUCTIONS,
                    nativeMediaInstructions(tools),
                  ),
                  messages: stepNudge ? [...messages, { role: 'user', content: stepNudge }] : messages,
                  tools: journal.wrap(tools, abortController.signal),
                  ...(deferredMcp ? { repairToolCall: deferredMcp.repairToolCall } : {}),
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
                  onLanguageModelCallEnd: recordCall,
                  ...(configuredMaxOutput ? { maxOutputTokens: configuredMaxOutput } : {}),
                  ...(typeof options.modelParams?.temperature === 'number'
                    ? { temperature: options.modelParams.temperature }
                    : {}),
                  ...(typeof options.modelParams?.top_p === 'number' ? { topP: options.modelParams.top_p } : {}),
                });

                // Start the resumed generation before yielding acknowledgements.
                // New guidance offered in response then targets this running step.
                for (const id of appliedSteeringIds.splice(0)) yield { type: 'steering_applied', id };
                let stepProducedOutput = false;
                try {
                  for await (const rawPart of result.stream) {
                    yield* flushCallUsage();
                    yield { type: 'activity' };
                    const part = rawPart as unknown as Record<string, unknown>;
                    if (['tool-call', 'tool-result', 'tool-error', 'text-delta'].includes(String(part.type)))
                      stepProducedOutput = true;
                    // The silence reason is reported with the result, not as activity.
                    if (part.toolName === NO_REPLY_TOOL) continue;
                    if (part.type === 'tool-call') {
                      const toolInputFingerprint = fingerprintToolInput(part.input);
                      yield {
                        type: 'progress',
                        step: formatNativeToolStep(part, 'running'),
                        ...(toolInputFingerprint ? { toolInputFingerprint } : {}),
                      };
                    } else if (part.type === 'tool-result') yield { type: 'progress', step: formatNativeToolStep(part, 'completed') };
                    else if (part.type === 'tool-error') yield { type: 'progress', step: formatNativeToolStep(part, 'error') };
                    else if (part.type === 'error') throw part.error;
                    else if (part.type === 'text-delta') journal.appendText(String(part.text ?? ''));
                    else if (part.type === 'finish-step') {
                      journal.save();
                      yield { type: 'assistant_message' };
                    }
                  }
                } catch (error) {
                  if (!isContextOverflow(error) || stepProducedOutput || !compactionPolicy.canRecover()) throw error;
                  yield* compactContext(compactionPolicy.recover('context'));
                  nudge = stepNudge;
                  continue;
                }

                const responseMessages = (await result.responseMessages) as ModelMessage[];
                await journal.settle();
                yield* flushCallUsage();
                if (abortController.signal.aborted) throw new Error('Turn stopped');
                checkpoint = journal.finishSegment(portableHistory(responseMessages));
                messages.push(...responseMessages);
                const steps = await result.steps;
                stepsCompleted += steps.length;
                totalUsage.context_tokens = callUsageFor(resolved, steps.at(-1)?.usage).context_tokens;
                compactionPolicy.observe(totalUsage.context_tokens);
                const stepText = (await result.text).trim() || null;
                finishReason = String(await result.finishReason);
                const step = steps.at(-1);
                // A step without tool calls is the final message; text written
                // alongside tool calls is working notes and is never delivered.
                const finalStep = !step || step.toolCalls.length === 0;
                const finalText = finalStep ? stepText : null;
                if (!finalStep) undeliveredChars += stepText?.length ?? 0;
                const silenceCall = step?.toolCalls.find((call) => call.toolName === NO_REPLY_TOOL);
                if (silenceCall) silence = noReplyReason(silenceCall.input);

                let applied = false;
                // Prepare all inputs before acknowledging any: preparation failures
                // must not consume input for a generation that never starts.
                const prepared: Array<{ input: SteeringInput; message: ModelMessage }> = [];
                let preparedBytes = 0;
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
                  const message = yield* prepareInput(guidance.prompt, guidance.files, preparedBytes);
                  preparedBytes += inlineHistoryBytes([message]);
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
                const continueTools = step && step.toolCalls.length > 0 &&
                  step.toolCalls.every((call) => step.content.some((part) =>
                    (part.type === 'tool-result' || part.type === 'tool-error') &&
                    part.toolCallId === call.toolCallId));
                if (toolMediaPressure) {
                  yield* compactContext(compactionPolicy.recover('media'));
                  nudge = 'Media history was compacted. Retry the failed media tool if still needed; do not repeat completed actions.';
                }
                if (applied) {
                  // Guidance supersedes a drafted answer: the model sees the
                  // draft in history and answers both in its next final message.
                  undeliveredChars += finalText?.length ?? 0;
                  continue;
                }
                reply = finalText;
                if (reply && isPointerReply(reply, undeliveredChars)) {
                  // Data collection only: a retry was removed; revisit if this fires often.
                  log(`Warning: final message may point at ${undeliveredChars} chars of undelivered text: ${JSON.stringify(reply.slice(0, 120))}`);
                }
                if (reply || silenceCall || !continueTools) break;
                if (stepsCompleted < MAX_STEPS) continue;
                if (wrappingUp) break;
                wrappingUp = true;
                nudge = STEP_LIMIT_PROMPT;
                log(`Reached the ${MAX_STEPS}-step limit; asking for a progress report`);
              }
              // No await or yield between closing acceptance and deciding the
              // final result; guidance arriving after this belongs to a later turn.
              active = false;
              yield {
                type: 'usage',
                data: { ...totalUsage, duration_ms: Date.now() - startedAt, duration_api_ms: modelCallMs,
                  num_turns: stepsCompleted + compactionCalls },
              };
              yield { type: 'checkpoint', ref: checkpoint };
              yield {
                type: 'result',
                text: null,
                finishReason,
                replies: reply ? [{ text: reply }] : [],
                ...(!reply && silence !== null ? { silence } : {}),
              };
            } catch (error) {
              active = false;
              yield* flushCallUsage();
              if (abortController.signal.aborted) {
                if (journal) {
                  await journal.settle();
                  yield* flushCallUsage();
                  for (const step of journal.activity()) {
                    if (step.kind !== 'tool' || step.tool !== NO_REPLY_TOOL) yield { type: 'progress', step };
                  }
                  yield { type: 'checkpoint', ref: journal.save(true, stoppedByUser) };
                }
                break;
              }
              yield {
                type: 'error',
                message: errorMessage(error),
                retryable: !(error instanceof CompactionSummaryError) && /timeout|429|5\d\d|network|fetch/i.test(errorMessage(error)),
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
