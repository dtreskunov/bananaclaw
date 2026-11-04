import { APICallError, RetryError, isStepCount, streamText, wrapLanguageModel, type LanguageModelCallEndEvent, type LanguageModelMiddleware, type ModelMessage, type ToolSet } from 'ai';

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
import { nativeToolOutcome, toolActivityFields } from './tool-activity.js';
import { resolveNativeModel, type NativeModel } from './native/catalog.js';
import { inlineHistoryBytes, MAX_INLINE_BYTES, prepareNativeUserMessage } from './native/attachments.js';
export { prepareNativeUserMessage as userMessage } from './native/attachments.js';
import { loadNativeInstructions, nativeMediaInstructions } from './native/instructions.js';
import { NativeSkillRegistry } from './native/skills.js';
import { NativeStore } from './native/store.js';
import { INTERRUPTED_TOOL, NativeTurnJournal } from './native/turn-journal.js';
import {
  compactNativeContext, COMPACTION_INSTRUCTIONS, createCompactionPolicy, isContextOverflow, type NativeCompactionPlan,
} from './native/compaction.js';
import { createNativeTools } from './native/tools.js';
import { openAiToolMedia } from './native/tool-media.js';
import { applyMediaQuarantines, isMediaParameterError, mediaKeys } from './native/media-recovery.js';
import { NATIVE_TODO_INSTRUCTIONS, NativeTodoState, shouldRequireTodos } from './native/todos.js';
import {
  isPointerReply,
  NO_REPLY_TOOL,
  NO_REPLY_TOOLS,
  noReplyReason,
} from './native/reply.js';
import { DeferredMcpTools, mcpToolSearchMode } from './native/tool-search.js';
import { boundToolResults, finishedToolReceipts } from './native/tool-results.js';

function log(message: string): void {
  console.error(`[native-provider] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseErrorBody(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') return {};
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === 'object' && 'error' in body &&
        body.error && typeof body.error === 'object') return body.error as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return {};
}

function providerErrorMessage(error: unknown): string {
  if (RetryError.isInstance(error) && APICallError.isInstance(error.lastError)) error = error.lastError;
  const message = errorMessage(error);
  if (!APICallError.isInstance(error) || message !== 'Provider returned error') return message;
  const status = error.statusCode ? ` (HTTP ${error.statusCode})` : '';
  const { metadata } = parseErrorBody(error.responseBody);
  if (!metadata || typeof metadata !== 'object') return `${message}${status}`;
  const provider = 'provider_name' in metadata && typeof metadata.provider_name === 'string'
    ? `${metadata.provider_name}: ` : '';
  const raw = parseErrorBody('raw' in metadata ? metadata.raw : undefined);
  const detail = typeof raw.message === 'string' && raw.message.trim() ? raw.message : message;
  const sharedPool = 'limit_source' in metadata && metadata.limit_source === 'upstream_provider_shared_pool'
    ? '. The free endpoint shared upstream pool is rate-limited; retry later or select another model.' : '';
  return `${provider}${detail}${status}${sharedPool}`;
}

function quotaExhausted(error: unknown): boolean {
  return /\b(?:Token|M) Plan\b.*\busage limit\b/i.test(errorMessage(error));
}

const stopExhaustedQuota: LanguageModelMiddleware = {
  wrapStream: async ({ doStream }) => {
    try { return await doStream(); }
    catch (error) {
      if (APICallError.isInstance(error) && quotaExhausted(error))
        throw new APICallError({ ...error, message: error.message, cause: error, isRetryable: false });
      throw error;
    }
  },
};

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
  const outcome = status === 'completed' ? nativeToolOutcome(tool, part.output) : undefined;
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
    status: outcome?.status ?? status,
    ...(detail ? { detail } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    ...(title ? { title } : {}),
    ...(outcome?.error || status === 'error' ? { error: outcome?.error ?? errorMessage(part.error) } : {}),
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
function lazyMcpManager(
  servers: Record<string, McpServerConfig> | undefined,
  cwd: string,
  onBrokerGuidance: (guidance: string) => void,
) {
  const configured = servers && Object.keys(servers).length > 0 ? servers : null;
  let instance: Promise<import('./native/mcp-client.js').NativeMcpManager> | null = null;
  let closed = false;
  return {
    async entries(
      signal?: AbortSignal, serverNames?: string[], strict = false,
    ): Promise<import('./native/mcp-client.js').McpToolEntry[]> {
      if (!configured) return [];
      if (closed) throw new Error('MCP manager is closed');
      instance ??= import('./native/mcp-client.js').then(({ NativeMcpManager }) =>
        new NativeMcpManager(configured, cwd, onBrokerGuidance));
      return (await instance).entries(signal, serverNames, strict);
    },
    async close(): Promise<void> {
      closed = true;
      await (await instance)?.close();
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
  readonly supportsToolCancellation = true;
  readonly structuredReplies = true;
  readonly reportsModelRequests = true;
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
    let journal: NativeTurnJournal | undefined;
    const steering: SteeringInput[] = [];
    const acceptedSteering = new Set<string>();
    const preparingSteering = new Set<string>();
    const abortController = new AbortController();
    const options = this.options;
    const store = this.store;
    const project = (messages: ModelMessage[]) => boundToolResults(messages, store);
    const history = (conversation: string) => project(portableHistory(
      finishedToolReceipts(store.contextEntries(conversation), store),
    ));
    const seenBrokerGuidance = new Set<string>();
    const pendingBrokerGuidance = new Set<string>();
    const mcpManager = lazyMcpManager(options.mcpServers, input.cwd, (guidance) => {
      if (!active || seenBrokerGuidance.has(guidance)) return;
      seenBrokerGuidance.add(guidance);
      pendingBrokerGuidance.add(guidance);
    });
    const toolSearchMode = mcpToolSearchMode(options.modelParams?.mcp_tool_search);
    let loggedDeferral = false;
    let lazyMcpTools: DeferredMcpTools | null = null;
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
            seenBrokerGuidance.clear();
            pendingBrokerGuidance.clear();
            const startedAt = Date.now();
            const callUsages: CallUsage[] = [];
            function* flushCallUsage(): Generator<ProviderEvent> {
              for (const data of callUsages.splice(0)) yield { type: 'usage_call', data };
            }
            try {
              const todoState = new NativeTodoState();
              const configuredModel = options.model ?? process.env.NATIVE_MODEL;
              if (!configuredModel) throw new Error('native requires a canonical model setting');
              const prior = history(continuation);
              const turnJournal = new NativeTurnJournal(store, continuation, { role: 'user', content: turn.text });
              journal = turnJournal;
              abortController.signal.throwIfAborted();
              const resolved = await resolveNativeModel(configuredModel);
              const miniMaxFlash = /^MiniMax-M3\.1-Flash(?:-Preview)?$/i.test(resolved.modelId);
              const conversation = continuation;
              abortController.signal.throwIfAborted();
              const messages: ModelMessage[] = [...prior, { role: 'user', content: turn.text }];
              const mediaScope = JSON.stringify([resolved.providerId, resolved.modelId, resolved.baseURL, resolved.protocol]);
              const quarantines = store.mediaQuarantines(conversation, mediaScope);
              const projectedContext = () => applyMediaQuarantines(messages, quarantines);
              const confirmedMedia = new Set<string>();
              let mediaRecoveryAttempted = false;
              let mediaRetry: { key: string; reason: string; error: unknown } | undefined;
              let quarantineNoticeSent = false;
              let toolMediaPressure = false;
              const nativeTools = (): ToolSet => turn.toolsDisabled
                ? {}
                : {
                    ...createNativeTools(input.cwd, skills, todoState, {
                      model: resolved,
                      maxInlineBytes: Math.max(0, MAX_INLINE_BYTES - inlineHistoryBytes(projectedContext())),
                      onMediaPressure: () => { toolMediaPressure = true; },
                    }),
                    ...NO_REPLY_TOOLS,
                  };
              const configuredMaxOutput =
                typeof options.modelParams?.max_tokens === 'number'
                  ? Math.floor(options.modelParams.max_tokens)
                  : resolved.maxOutputTokens;
              const adapter = await languageModel(resolved);
              const modelSetupMs = Date.now() - startedAt;
              const compactionPolicy = createCompactionPolicy(resolved.contextWindow);
              const middleware: LanguageModelMiddleware[] = [
                ...(resolved.protocol === 'openai-chat' ? [openAiToolMedia] : []),
                stopExhaustedQuota,
              ];
              const model = wrapLanguageModel({ model: adapter, middleware });
              const requestModel = wrapLanguageModel({ model: adapter, middleware: [...middleware, compactionPolicy.preflight] });
              let firstStep = true;
              let finishReason = '';
              let reply: string | null = null;
              let silence: string | null = null;
              let checkpoint = journal.checkpoint;
              const appliedSteeringIds: string[] = [];
              function recordCall({ usage, performance }: LanguageModelCallEndEvent, summary = false): void {
                // Stopping can make the SDK close a waiting stream with a synthetic, usage-less
                // finish; that is not a report of the call.
                if (abortController.signal.aborted && usage.inputTokens === undefined && usage.outputTokens === undefined) return;
                const data = timedCallUsageFor(resolved, usage, performance.responseTimeMs);
                // A summary call's prompt is the old history, not the conversation's context.
                if (summary) data.context_tokens = undefined;
                callUsages.push(data);
              }
              // One-off instruction for the next step; never persisted.
              let nudge: string | null = null;
              // Text written alongside tool calls, which is never delivered.
              let undeliveredChars = 0;
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
                  messages.splice(0, messages.length, ...history(conversation));
                  compactionPolicy.compacted();
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
              async function* prepareInput(
                text: string, files: FileAttachment[] | undefined, extraBytes = 0,
              ): AsyncGenerator<ProviderEvent, ModelMessage> {
                while (true) {
                  let pressure = false;
                  const historyBytes = inlineHistoryBytes(projectedContext());
                  const message = await prepareNativeUserMessage(text, files, resolved, {
                    signal: abortController.signal,
                    maxInlineBytes: MAX_INLINE_BYTES - historyBytes - extraBytes,
                    ...(historyBytes > 0 ? { onMediaPressure: () => { pressure = true; } } : {}),
                  });
                  if (!pressure) return message;
                  yield* compactContext(compactionPolicy.recover('media'));
                }
              }
              const inputStarted = Date.now();
              const incoming = yield* prepareInput(turn.text, turn.files);
              journal.updateInput(incoming);
              messages.splice(0, messages.length, ...history(continuation));
              const inputPreparationMs = Date.now() - inputStarted;
              const discoveryStarted = Date.now();
              const lazyServers = !turn.toolsDisabled && toolSearchMode === 'always'
                ? Object.keys(options.mcpServers ?? {}) : [];
              const mcpEntries = turn.toolsDisabled || lazyServers.length ? [] :
                await mcpManager.entries(abortController.signal);
              // Loaded tool sets can grow between steps; rebuild per step.
              const deferredMcp = lazyServers.length
                ? (lazyMcpTools ??= new DeferredMcpTools({
                    servers: lazyServers,
                    load: (servers, signal) => mcpManager.entries(signal, servers, true),
                  }, prior))
                : null;
              if (deferredMcp && !loggedDeferral) {
                loggedDeferral = true;
                log(`Lazy MCP discovery enabled for ${lazyServers.length} servers`);
              }
              const mcpTools: ToolSet = deferredMcp
                ? {}
                : Object.fromEntries(mcpEntries.map((entry) => [entry.name, entry.tool]));
              const stepTools = (): ToolSet => ({ ...nativeTools(), ...(deferredMcp?.toolSet() ?? mcpTools) });
              const mcpCatalog = deferredMcp?.instructions() ?? null;
              abortController.signal.throwIfAborted();
              log(`Preparation ${JSON.stringify({
                modelSetupMs, inputPreparationMs, mcpDiscoveryMs: Date.now() - discoveryStarted,
                totalMs: Date.now() - startedAt, mcpMode: toolSearchMode,
              })}`);
              while (true) {
                abortController.signal.throwIfAborted();
                if (!mediaRetry) {
                  while (inlineHistoryBytes(projectedContext()) > MAX_INLINE_BYTES)
                    yield* compactContext(compactionPolicy.recover('media'));
                  const plan = compactionPolicy.proactive();
                  if (plan) yield* compactContext(plan);
                }
                const requestContext = projectedContext();
                if (!mediaRetry && !quarantineNoticeSent && quarantines.size &&
                    mediaKeys(messages).some(key => quarantines.has(key))) {
                  quarantineNoticeSent = true;
                  yield { type: 'progress', step: {
                    kind: 'notification', id: `native-media-quarantine-${continuation}-${startedAt}`,
                    text: 'Previously quarantined media omitted for this model',
                    detail: 'Original attachments remain preserved; unavailable media is explicitly marked in model context.',
                  } };
                }
                toolMediaPressure = false;
                const stepNudge: string | null = [nudge, ...pendingBrokerGuidance].filter(Boolean).join('\n\n') || null;
                nudge = null;
                pendingBrokerGuidance.clear();
                const tools = stepTools();
                const system = loadNativeInstructions(
                      input.systemContext?.instructions,
                      [skills.instructions(), mcpCatalog].filter(Boolean).join('\n\n') || null,
                      turn.toolsDisabled ? null : NATIVE_TODO_INSTRUCTIONS,
                      nativeMediaInstructions(tools),
                    );
                const requestMessages: ModelMessage[] = stepNudge
                  ? [...requestContext, { role: 'user', content: stepNudge }] : requestContext;
                yield { type: 'model_request' };
                const result = streamText({
                  model: requestModel, system,
                  messages: requestMessages,
                  tools: journal.wrap(tools, abortController.signal),
                  ...(deferredMcp ? { repairToolCall: deferredMcp.repairToolCall } : {}),
                  // Own the boundary: SDK prepareStep cannot resume a text-only
                  // final step and may race ahead of the consumer's event loop.
                  stopWhen: isStepCount(1),
                  ...(!turn.toolsDisabled && shouldRequireTodos(turn.text)
                    ? {
                        prepareStep: ({ instructions }) =>
                          firstStep
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
                  maxRetries: mediaRetry ? 0 : 2,
                  abortSignal: abortController.signal,
                  // A model call can finish before its tool does. Retain its
                  // usage even if cancellation prevents finish-step.
                  onLanguageModelCallEnd: (event) => recordCall(event),
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
                    if (['tool-input-start', 'tool-input-delta', 'tool-call', 'tool-result', 'tool-error',
                      'tool-approval-request', 'text-delta', 'reasoning-delta', 'file', 'source'].includes(String(part.type)))
                      stepProducedOutput = true;
                    // The silence reason is reported with the result, not as activity.
                    if (part.toolName === NO_REPLY_TOOL) continue;
                    if (part.type === 'tool-call') {
                      const toolInputFingerprint = fingerprintToolInput(part.input);
                      const step = formatNativeToolStep(part, 'running');
                      journal.announceTool(step.id);
                      yield {
                        type: 'progress',
                        step,
                        ...(toolInputFingerprint ? { toolInputFingerprint } : {}),
                      };
                    } else if (part.type === 'tool-result') yield { type: 'progress', step: formatNativeToolStep(part, 'completed') };
                    else if (part.type === 'tool-error') {
                      const step = formatNativeToolStep(part, 'error');
                      yield { type: 'progress', step: errorMessage(part.error) === INTERRUPTED_TOOL
                        ? { ...step, status: 'interrupted', error: INTERRUPTED_TOOL } : step };
                    }
                    else if (part.type === 'error') throw part.error;
                    else if (part.type === 'text-delta') journal.appendText(String(part.text ?? ''));
                    else if (part.type === 'finish-step') {
                      journal.save();
                      yield { type: 'assistant_message' };
                    }
                  }
                } catch (error) {
                  abortController.signal.throwIfAborted();
                  if (mediaRetry) {
                    log(`Media-free retry failed: ${errorMessage(error)}; surfacing original rejection`);
                    yield { type: 'progress', step: {
                      kind: 'notification', id: `native-media-retry-${continuation}-${startedAt}-failed`,
                      text: 'Media-free retry failed; no attachment was quarantined', detail: errorMessage(error),
                    } };
                    throw mediaRetry.error;
                  }
                  if (isContextOverflow(error)) {
                    if (stepProducedOutput || !compactionPolicy.canRecover()) throw error;
                    yield* compactContext(compactionPolicy.recover('context'));
                  } else {
                    const key = !mediaRecoveryAttempted && !stepProducedOutput && !turnJournal.hasToolExecutions() &&
                      isMediaParameterError(error) ? mediaKeys(requestContext).reverse().find(key => !confirmedMedia.has(key)) : undefined;
                    if (!key) throw error;
                    mediaRecoveryAttempted = true;
                    mediaRetry = { key, reason: errorMessage(error), error };
                    quarantines.set(key, mediaRetry.reason);
                    log(`Provider rejected media-bearing request; retrying once without newest unconfirmed attachment`);
                    yield { type: 'progress', step: {
                      kind: 'notification', id: `native-media-retry-${continuation}-${startedAt}`,
                      text: 'Provider rejected this request; retrying once without the newest unconfirmed media',
                      detail: `${mediaRetry.reason}. Original attachments and completed tool actions remain preserved.`,
                    } };
                  }
                  nudge = stepNudge;
                  continue;
                }

                const responseMessages = (await result.responseMessages) as ModelMessage[];
                await journal.settle();
                yield* flushCallUsage();
                if (abortController.signal.aborted) throw new Error('Turn stopped');
                checkpoint = journal.finishSegment(portableHistory(responseMessages));
                for (const key of mediaKeys(requestContext)) confirmedMedia.add(key);
                if (mediaRetry) {
                  store.quarantineMedia(conversation, mediaScope, mediaRetry.key, checkpoint, mediaRetry.reason);
                  mediaRetry = undefined;
                  quarantineNoticeSent = true;
                  yield { type: 'progress', step: {
                    kind: 'notification', id: `native-media-quarantine-${continuation}-${startedAt}-confirmed`,
                    text: 'Media-free retry succeeded; attachment quarantined for this model',
                    detail: 'The original media is preserved. Repair or regenerate it before loading it again.',
                  } };
                }
                messages.push(...project(responseMessages));
                const step = (await result.steps).at(-1);
                const usage = step?.usage;
                firstStep = false;
                if (!toolMediaPressure)
                  compactionPolicy.observe(callUsageFor(resolved, usage).context_tokens, usage?.inputTokens);
                const stepText = (await result.text).trim() || null;
                finishReason = String(await result.finishReason);
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
                while (!ended && prepared.length < steering.length) {
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
              }
              // No await or yield between closing acceptance and deciding the
              // final result; guidance arriving after this belongs to a later turn.
              active = false;
              yield { type: 'checkpoint', ref: checkpoint };
              const result: Extract<ProviderEvent, { type: 'result' }> = {
                type: 'result',
                text: null,
                finishReason,
                replies: reply ? [{ text: reply }] : [],
                ...(!reply && silence !== null ? { silence } : {}),
              };
              yield result;
              turnJournal.acknowledgeResult(result, abortController.signal);
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
                message: providerErrorMessage(error),
                // SDK retries are exhausted; no further attempt will follow this event.
                retryable: false,
              };
            } finally {
              active = false;
              journal = undefined;
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
      stopTool(toolCallId: string): boolean {
        return active && !ended && !abortController.signal.aborted && (journal?.stopTool(toolCallId) ?? false);
      },
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
