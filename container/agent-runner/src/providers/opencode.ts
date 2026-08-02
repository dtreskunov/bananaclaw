import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { registerProvider } from './provider-registry.js';
import type { ActivityStep, AgentProvider, AgentQuery, FileAttachment, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { pickActivityDetail } from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { parseAssistantOutput } from '../formatter.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

/**
 * Normalize finalized assistant text before delivery. Some OpenCode/provider
 * combinations drop the leading `<` of the first response tag, so the shared
 * tolerant parser repairs known wrappers and removes provider reasoning. The
 * same normalization also protects the SSE compatibility fallback.
 */
export function normalizeAssistantText(raw: string): string {
  return parseAssistantOutput(raw).normalizedText;
}

// ── Model parameters (model_params bag) ──────────────────────────────────
// Keys that map to the per-model `options` bag OpenCode hands to the
// underlying AI SDK (provider.<name>.models.<id>.options). Unknown keys
// are tolerated — we warn once at startup and drop them.
const MODEL_LEVEL_PARAM_KEYS = new Set<string>([
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'seed',
]);

/**
 * Pick only the AI-SDK passthrough keys from the model_params bag. Returns
 * an empty object when nothing applies so callers can spread unconditionally.
 * Exported for unit tests.
 */
export function pickModelOptionsForOpenCode(
  modelParams: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!modelParams) return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(modelParams)) {
    if (MODEL_LEVEL_PARAM_KEYS.has(k)) out[k] = modelParams[k];
  }
  return out;
}

let warnedUnknownKeys = false;
function warnUnknownModelParamsOnce(modelParams: Record<string, unknown> | undefined): void {
  if (warnedUnknownKeys || !modelParams) return;
  const unknown = Object.keys(modelParams).filter((k) => !MODEL_LEVEL_PARAM_KEYS.has(k));
  if (unknown.length === 0) return;
  warnedUnknownKeys = true;
  log(`ignoring unknown model_params: ${unknown.join(', ')} (recognized: ${[...MODEL_LEVEL_PARAM_KEYS].join(', ')})`);
}

/**
 * OpenCode sessions persist under XDG_DATA_HOME (mounted per-session on the
 * host). When a session is resumed across container restarts, OpenCode
 * defaults the next turn's model to whatever the previous assistant turn
 * used — silently ignoring the new server-level `model` config. To honor
 * per-group model changes we pass `body.model` on every prompt.
 */
function resolveModelForPrompt(
  optionModel: string | undefined,
): { providerID: string; modelID: string } | undefined {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const fullModel = optionModel || process.env.OPENCODE_MODEL;
  if (!fullModel) return undefined;
  const modelID = fullModel.replace(new RegExp(`^${provider}/`), '');
  return { providerID: provider, modelID };
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout/i;

// ── Progress hints ────────────────────────────────────────────────────────
// OpenCode emits very chatty SSE (tool calls, private thinking, streaming text).
// We translate selected events into one-line `progress` ProviderEvents that
// the poll-loop persists to session_state.progress, which the host typing
// module reads as a hint next to the typing dots. This is the only signal
// the user sees during long tool-heavy turns, so keep strings short and
// throttle to avoid thrashing the per-session SQLite file.

type OpenCodePart = {
  id?: string;
  sessionID?: string;
  type?: string;
  messageID?: string;
  text?: string;
  tool?: string;
  callID?: string;
  filename?: string;
  mime?: string;
  source?: { path?: string };
  files?: string[];
  attempt?: number;
  error?: unknown;
  auto?: boolean;
  agent?: string;
  description?: string;
  time?: { start?: number; end?: number };
  state?: {
    status?: 'pending' | 'running' | 'completed' | 'error';
    input?: Record<string, unknown>;
    title?: string;
    error?: string;
    time?: { start?: number; end?: number };
  };
};

/** OpenCode's subscription is process-wide, so delayed/background message
 * events must not contaminate the active turn. */
export function isEventForSession(eventSessionId: string | undefined, activeSessionId: string): boolean {
  return eventSessionId === activeSessionId;
}

/**
 * Map an OpenCode `finish` reason to a human-readable message used when the
 * turn ended with no user-visible text. Exported for tests.
 */
export function describeFinishReason(finish: string): string {
  switch (finish) {
    case 'length':
      return 'Model hit its max output tokens before producing a reply (often after a long reasoning step). Try a shorter prompt or a model with a higher output cap.';
    case 'content-filter':
    case 'content_filter':
      return 'Model stopped due to a content filter and produced no reply.';
    case 'tool-calls':
    case 'tool_calls':
      return 'Model ended with a pending tool call but no reply text.';
    case 'error':
      return 'Model finished with an error and produced no reply.';
    default:
      return `Model finished with reason "${finish}" and produced no reply.`;
  }
}

/**
 * Map an OpenCode part-update to a structured activity step, or null if the
 * part isn't progress-worthy. Pure function — exported for unit tests. No
 * human-readable formatting happens here: tool name + raw primary argument
 * are passed through and the UI does the presentation.
 *
 * Private thinking, streaming text, snapshots, and permission events are
 * deliberately excluded from user-visible activity.
 */
export function formatProgressFromPart(
  part: OpenCodePart | undefined,
): ActivityStep | null {
  if (!part?.type || !part.id) return null;
  const inp = (part.state?.input ?? {}) as Record<string, unknown>;
  switch (part.type) {
    case 'tool': {
      const tool = part.tool || '';
      if (!tool) return null;
      const detail = pickActivityDetail(inp);
      const status = part.state?.status ?? 'pending';
      const start = part.state?.time?.start;
      const end = part.state?.time?.end;
      return {
        kind: 'tool', id: part.callID || part.id, tool, status,
        ...(detail ? { detail } : {}),
        ...(part.state?.title ? { title: part.state.title } : {}),
        ...(status === 'error' && part.state?.error ? { error: part.state.error } : {}),
        ...(typeof start === 'number' && typeof end === 'number' ? { durationMs: Math.max(0, end - start) } : {}),
      };
    }
    case 'file':
      return { kind: 'file', id: part.id, ...(part.source?.path ? { path: part.source.path } : {}), ...(part.filename ? { name: part.filename } : {}), ...(part.mime ? { mime: part.mime } : {}) };
    case 'patch':
      return { kind: 'patch', id: part.id, files: (part.files ?? []).slice(0, 100) };
    case 'retry':
      return { kind: 'retry', id: part.id, attempt: part.attempt ?? 0, ...(activityError(part.error) ? { error: activityError(part.error) } : {}) };
    case 'compaction':
      return { kind: 'compaction', id: part.id, auto: part.auto };
    case 'subtask':
      return { kind: 'subtask', id: part.id, ...(part.agent ? { agent: part.agent } : {}), ...(part.description ? { description: part.description } : {}) };
    default:
      return null;
  }
}

function activityError(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { message?: unknown; data?: { message?: unknown }; name?: unknown };
  const value = e.data?.message ?? e.message ?? e.name;
  return typeof value === 'string' ? value : undefined;
}

/** Concatenate every distinct finalized text part in provider order. Streaming
 * updates are snapshots of individual part ids; finalized parts are the only
 * reliable source for the complete assistant response. */
export function finalTextFromParts(parts: OpenCodePart[]): string {
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}

/** OpenCode creates a new assistant message around each tool call. Only the
 * last one is the completed reply; earlier text is intermediate narration. */
export function finalTextFromAssistantMessages(messages: OpenCodePart[][]): string {
  const finalMessage = messages.at(-1);
  return finalMessage ? finalTextFromParts(finalMessage) : '';
}

export function hasNonEmptyReasoning(parts: Array<{ type?: string; text?: string }>): boolean {
  return parts.some((part) => part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim().length > 0);
}

export function isRecoverableReasoningOnlyCompletion(
  rawText: string,
  reasoningOutputNonEmpty: boolean,
  finish: string | undefined,
): boolean {
  return rawText.trim().length === 0 && reasoningOutputNonEmpty && finish === 'unknown';
}

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function spawnOpencodeServer(config: Record<string, unknown>, timeoutMs = 10_000): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    const port = 4096;
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      detached: true,
    });

    const id = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  return out;
}

const SKILLS_DIR = '/app/skills';
const SKILLS_INDEX_PATH = '/tmp/nanoclaw-skills-index.md';

/**
 * Parse the `name` and `description` from a SKILL.md YAML frontmatter block.
 * Extracts the block between the leading `---` fences and hands it to Bun's
 * native YAML parser, so folded/literal block scalars (`>-`, `|`) are handled
 * correctly. Returns an empty object when there's no frontmatter or it fails
 * to parse.
 */
export function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const lines = md.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return {};

  const block = lines.slice(1, end).join('\n');
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(block);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};

  const fm = parsed as Record<string, unknown>;
  const out: { name?: string; description?: string } = {};
  if (typeof fm.name === 'string') out.name = fm.name.trim();
  if (typeof fm.description === 'string') out.description = fm.description.replace(/\s+/g, ' ').trim();
  return out;
}

/**
 * Emulate Claude's Skills progressive disclosure for OpenCode. Scans the
 * mounted `/app/skills` tree, builds a compact index (name + description +
 * absolute SKILL.md path), writes it to a container-local file, and returns
 * that path so it can be added to OpenCode's `instructions`. Only the
 * descriptions are always-loaded; the agent reads a skill's body on demand
 * with its file tools. Returns null when no skills are mounted.
 */
export function generateSkillsIndex(skillsDir = SKILLS_DIR, outPath = SKILLS_INDEX_PATH): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    return null;
  }

  const skills: { name: string; description: string; path: string }[] = [];
  for (const dir of entries.sort()) {
    const skillFile = `${skillsDir}/${dir}/SKILL.md`;
    let md: string;
    try {
      md = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    const fm = parseSkillFrontmatter(md);
    const name = fm.name || dir;
    if (!fm.description) continue;
    skills.push({ name, description: fm.description, path: skillFile });
  }

  if (skills.length === 0) return null;

  const body = [
    '# Available skills',
    '',
    'You have access to skills — packaged instructions for specific tasks.',
    'When a request matches a skill below, read that skill\'s SKILL.md with your',
    'file/read tool BEFORE acting, then follow it. Only the summaries are shown',
    'here; the full instructions live in each file.',
    '',
    ...skills.map((s) => `- **${s.name}** — ${s.description}\n  Read: \`${s.path}\``),
    '',
  ].join('\n');

  try {
    fs.writeFileSync(outPath, body);
  } catch {
    return null;
  }
  return outPath;
}

export function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = options.model || process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;
  const providerSmallModelId = smallModel ? smallModel.replace(new RegExp(`^${provider}/`), '') : undefined;
  const modelsToRegister: string[] = [providerModelId, providerSmallModelId].filter(
    (m): m is string => typeof m === 'string' && m.length > 0,
  );
  // Drop duplicates while preserving first-seen order.
  const dedupedModels = modelsToRegister.filter((mid, i, a) => a.indexOf(mid) === i);

  const modelOptions = pickModelOptionsForOpenCode(options.modelParams);
  const hasModelOptions = Object.keys(modelOptions).length > 0;
  warnUnknownModelParamsOnce(options.modelParams);

  // Build per-model entries. Only the main model gets the modelParams
  // options applied — the small model (used for compaction/summaries) keeps
  // its defaults so a tiny output cap on the chat model doesn't truncate
  // background tasks.
  const buildModelEntry = (mid: string): Record<string, unknown> => {
    const base: Record<string, unknown> = { id: mid, name: mid, tool_call: true };
    if (hasModelOptions && mid === providerModelId) base.options = modelOptions;
    return base;
  };

  let providerOptions: Record<string, unknown>;
  if (provider === 'anthropic') {
    // For the anthropic-direct path we don't override `options` (no API key
    // swap) but we DO register a model entry when modelParams need to apply.
    providerOptions =
      hasModelOptions && providerModelId
        ? { anthropic: { models: { [providerModelId]: buildModelEntry(providerModelId) } } }
        : {};
  } else {
    providerOptions = {
      [provider]: {
        options: { apiKey: 'placeholder', baseURL: proxyUrl },
        ...(dedupedModels.length > 0
          ? { models: Object.fromEntries(dedupedModels.map((mid) => [mid, buildModelEntry(mid)])) }
          : {}),
      },
    };
  }

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // Load shared base + per-group fragments + per-group memory through OpenCode's
  // native instructions pipeline (session/instruction.ts). Absolute paths with
  // globs are supported. Files are read raw — `@./...` includes are NOT expanded
  // by OpenCode, so point at the concrete files, not at composed CLAUDE.md.
  const instructions = [
    '/app/CLAUDE.md',
    '/workspace/agent/.claude-fragments/*.md',
    '/workspace/agent/CLAUDE.local.md',
  ];

  // OpenCode has no native Skills feature, so surface the mounted skills as a
  // generated index it can read on demand (progressive disclosure emulation).
  const skillsIndex = generateSkillsIndex();
  if (skillsIndex) instructions.push(skillsIndex);

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    // As of OpenCode 1.14+ `permission` is a per-tool object, not the bare
    // string `'allow'` the 1.4.x schema accepted (the string is silently
    // ignored by newer servers, which then fall back to "ask" and lean on
    // our permission.updated auto-reply). Grant every gate so the agent runs
    // unattended — same intent as the old string form.
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
      doom_loop: 'allow',
      external_directory: 'allow',
    },
    tools: {
      question: false,
    },
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    instructions,
    mcp,
  };
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: options.model || process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
    modelOptions: pickModelOptionsForOpenCode(options.modelParams),
  });
}

async function ensureSharedRuntime(options: ProviderOptions): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await spawnOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    sharedRuntime = {
      proc,
      client,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    killProcessTree(sharedRuntime.proc);
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;
  // Lazy memoized Map<"providerID/modelID", { context, output }>. Populated
  // once via client.config.providers() and reused for every subsequent turn
  // — model metadata doesn't change inside a container's lifetime.
  private modelLimitsPromise: Promise<Map<string, { context: number; output: number }>> | null = null;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  private async getModelLimits(
    client: OpencodeClient,
    providerID: string | undefined,
    modelID: string | undefined,
  ): Promise<{ context_window?: number; max_output_tokens?: number }> {
    if (!providerID || !modelID) return {};
    if (!this.modelLimitsPromise) {
      this.modelLimitsPromise = (async () => {
        const out = new Map<string, { context: number; output: number }>();
        try {
          const res = await client.config.providers();
          const providers = (res.data?.providers ?? []) as Array<{
            id: string;
            models?: Record<string, { limit?: { context?: number; output?: number } }>;
          }>;
          for (const p of providers) {
            for (const [mid, model] of Object.entries(p.models ?? {})) {
              const ctx = model?.limit?.context;
              const outTok = model?.limit?.output;
              if (ctx || outTok) {
                out.set(`${p.id}/${mid}`, { context: ctx ?? 0, output: outTok ?? 0 });
              }
            }
          }
        } catch (err) {
          log(`Failed to fetch model limits: ${err instanceof Error ? err.message : String(err)}`);
        }
        return out;
      })();
    }
    const map = await this.modelLimitsPromise;
    const hit = map.get(`${providerID}/${modelID}`);
    if (!hit) return {};
    return {
      context_window: hit.context > 0 ? hit.context : undefined,
      max_output_tokens: hit.output > 0 ? hit.output : undefined,
    };
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let initialFiles: FileAttachment[] | undefined = input.files;

    const systemInstructions = input.systemContext?.instructions;
    pending.push(wrapPromptWithContext(input.prompt, systemInstructions));

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 300_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options);
      const { client, stream } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const text = pending.shift()!;
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        // Build prompt parts: text + any inline file attachments (first turn only).
        const parts: Array<{ type: string; text?: string; mime?: string; url?: string; filename?: string }> = [
          { type: 'text', text },
        ];
        if (initialFiles && initialFiles.length > 0) {
          for (const file of initialFiles) {
            try {
              const data = fs.readFileSync(file.path);
              const b64 = data.toString('base64');
              parts.push({ type: 'file', mime: file.mime, url: `data:${file.mime};base64,${b64}`, filename: file.filename });
            } catch (err) {
              log(`Failed to read attachment ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          initialFiles = undefined; // Only send on first prompt
        }

        const modelSelection = resolveModelForPrompt(self.options.model);
        const promptRes = await client.session.promptAsync({
          path: { id: sessionId },
          body: {
            parts: parts as any,
            ...(modelSelection ? { model: modelSelection } : {}),
          },
        });
        if (promptRes.error) {
          self.activeSessionId = undefined;
          throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
        }

        // Compatibility fallback only: preserve each distinct streaming text
        // part rather than overwriting all text under its message id.
        const textPartsByMessageId = new Map<string, Map<string, OpenCodePart>>();
        const roleByMessageId = new Map<string, string>();
        const finishByMessageId = new Map<string, string>();
        let lastAssistantUsage: import('./types.js').TurnUsage | null = null;
        // Captured separately so the limits-lookup at yield-time has the
        // provider id (TurnUsage itself doesn't carry it).
        let lastAssistantProviderID: string | undefined;
        let lastAssistantModelID: string | undefined;
        let lastEventAt = Date.now();
        let eventTimedOut = false;
        let timeoutReject: ((err: Error) => void) | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => { timeoutReject = reject; });
        const timeoutCheck = setInterval(() => {
          if (eventTimedOut) return;
          if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
            log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${sessionId}`);
            eventTimedOut = true;
            clearInterval(timeoutCheck);
            self.activeSessionId = undefined;
            destroySharedRuntime();
            kick();
            timeoutReject?.(new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`));
          }
        }, 5000);

        try {
          turn: while (true) {
            if (aborted) return;

            const { value: ev, done } = await Promise.race([stream.next(), timeoutPromise]);
            if (done) {
              throw new Error('OpenCode SSE stream ended unexpectedly');
            }

            if (!ev?.type || ev.type === 'server.connected' || ev.type === 'server.heartbeat') continue;

            lastEventAt = Date.now();
            yield { type: 'activity' };

            switch (ev.type) {
              case 'message.updated': {
                const info = ev.properties.info as {
                  id?: string; sessionID?: string; role?: string;
                  cost?: number;
                  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
                  providerID?: string;
                  modelID?: string;
                  finish?: string;
                } | undefined;
                if (!isEventForSession(info?.sessionID, sessionId)) break;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                  if (info.finish) finishByMessageId.set(info.id, info.finish);
                  // Capture usage from the last assistant message.
                  if (info.role === 'assistant' && (typeof info.cost === 'number' || info.tokens)) {
                    lastAssistantUsage = {
                      cost_usd: info.cost ?? 0,
                      input_tokens: info.tokens?.input ?? 0,
                      output_tokens: info.tokens?.output ?? 0,
                      cache_read_tokens: info.tokens?.cache?.read ?? 0,
                      cache_write_tokens: info.tokens?.cache?.write ?? 0,
                      reasoning_tokens: info.tokens?.reasoning,
                      model: info.modelID ?? '',
                    };
                    lastAssistantProviderID = info.providerID;
                    lastAssistantModelID = info.modelID;
                  }
                }
                break;
              }
              case 'message.part.updated': {
                const part = ev.properties.part as OpenCodePart | undefined;
                if (!isEventForSession(part?.sessionID, sessionId)) break;
                if (part?.type === 'text' && part.messageID && part.text) {
                  let messageParts = textPartsByMessageId.get(part.messageID);
                  if (!messageParts) {
                    messageParts = new Map();
                    textPartsByMessageId.set(part.messageID, messageParts);
                  }
                  messageParts.set(part.id || '__unidentified_text_part__', part);
                }
                const step = formatProgressFromPart(part);
                if (step) {
                  yield { type: 'progress', step };
                }
                break;
              }
              case 'permission.updated': {
                const perm = ev.properties as { id?: string; sessionID?: string };
                if (perm.sessionID === sessionId && perm.id) {
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                break;
              }
              case 'session.status': {
                const props = ev.properties as {
                  sessionID?: string;
                  status?: { type?: string; attempt?: number; message?: string };
                };
                if (props.sessionID !== sessionId) break;
                const st = props.status;
                if (
                  st?.type === 'retry' &&
                  typeof st.attempt === 'number' &&
                  st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                  st.message
                ) {
                  self.activeSessionId = undefined;
                  throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                }
                break;
              }
              case 'session.error': {
                const props = ev.properties as { sessionID?: string; error?: unknown };
                if (props.sessionID === sessionId || props.sessionID === undefined) {
                  self.activeSessionId = undefined;
                  throw new Error(sessionErrorMessage(props));
                }
                break;
              }
              case 'session.idle': {
                const sid = (ev.properties as { sessionID?: string }).sessionID;
                if (sid === sessionId) {
                  break turn;
                }
                break;
              }
              default:
                break;
            }
          }
        } finally {
          clearInterval(timeoutCheck);
        }

        let resultText = '';
        let reasoningOutputNonEmpty = false;
        let lastAssistantId: string | undefined;
        const assistantMessageIds: string[] = [];
        for (const [msgId, role] of roleByMessageId) {
          if (role === 'assistant') {
            lastAssistantId = msgId;
            assistantMessageIds.push(msgId);
          }
        }
        // Finalized message parts are the sole normal source for response text.
        // If a final fetch fails, fall back to the per-part SSE snapshots for
        // that message rather than dropping an otherwise deliverable reply.
        let lastAssistantMessageData: { info?: unknown; parts?: OpenCodePart[] } | undefined;
        const assistantMessageParts: OpenCodePart[][] = [];
        for (const messageID of assistantMessageIds) {
          let finalizedParts: OpenCodePart[] | undefined;
          try {
            const message = await client.session.message({ path: { id: sessionId, messageID } });
            const data = message.data as { info?: unknown; parts?: OpenCodePart[] } | undefined;
            finalizedParts = data?.parts;
            if (messageID === lastAssistantId) lastAssistantMessageData = data;
          } catch (err) {
            log(`Failed to refresh final assistant message: ${err instanceof Error ? err.message : String(err)}`);
          }
          const parts = finalizedParts ?? [...(textPartsByMessageId.get(messageID)?.values() ?? [])];
          assistantMessageParts.push(parts);
          reasoningOutputNonEmpty ||= hasNonEmptyReasoning(parts);
        }
        resultText = finalTextFromAssistantMessages(assistantMessageParts);
        // Repair known malformed wrappers and drop inline chain-of-thought.
        // Capture whether the model produced ANY raw text first: if it did but
        // normalization strips it to nothing, the reply was swallowed (e.g. an
        // unclosed `<think>` with no `<message>`), not genuinely absent. The
        // poll-loop keys its recovery nudge off this distinction.
        const rawResultNonEmpty = resultText.trim().length > 0;
        const parsedResult = parseAssistantOutput(resultText);
        const recoveredFromUnclosedThink = parsedResult.diagnostics.includes('unclosed-think');
        resultText = parsedResult.normalizedText;
        const lastFinish = lastAssistantId ? finishByMessageId.get(lastAssistantId) : undefined;
        // MiniMax/OpenRouter can terminate mid-reasoning with finish="unknown"
        // and no text/tool part. The reasoning proves this was an interrupted
        // reply rather than intentional silence, so reuse the one-shot delivery
        // nudge instead of surfacing an immediate terminal provider error.
        const recoverableReasoningOnly = isRecoverableReasoningOnlyCompletion(
          resultText,
          reasoningOutputNonEmpty,
          lastFinish,
        );
        // Some providers (e.g. gemini-via-openrouter) finalize cost/tokens in a
        // `message.updated` that arrives *after* `session.idle` ends our loop,
        // so the values we captured from streaming events are still zero. Do a
        // one-shot fetch of the assistant message to pick up the final values.
        if (lastAssistantId) {
          try {
            let messageData = lastAssistantMessageData;
            if (!messageData) {
              const msgRes = await client.session.message({ path: { id: sessionId, messageID: lastAssistantId } });
              messageData = msgRes.data as { info?: unknown; parts?: OpenCodePart[] } | undefined;
            }
            const info = (messageData?.info ?? messageData) as {
              cost?: number;
              tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
              providerID?: string;
              modelID?: string;
            } | undefined;
            if (info && (typeof info.cost === 'number' || info.tokens)) {
              lastAssistantUsage = {
                cost_usd: info.cost ?? 0,
                input_tokens: info.tokens?.input ?? 0,
                output_tokens: info.tokens?.output ?? 0,
                cache_read_tokens: info.tokens?.cache?.read ?? 0,
                cache_write_tokens: info.tokens?.cache?.write ?? 0,
                reasoning_tokens: info.tokens?.reasoning,
                model: info.modelID ?? '',
              };
              if (info.providerID) lastAssistantProviderID = info.providerID;
              if (info.modelID) lastAssistantModelID = info.modelID;
            }
          } catch (err) {
            log(`Failed to refresh final assistant usage: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (lastAssistantUsage) {
          // Enrich with model limits so the host can render context/output
          // budget bars and warn before the agent runs into a hard cap.
          // Best-effort: missing limits stay undefined.
          const limits = await self.getModelLimits(client, lastAssistantProviderID, lastAssistantModelID);
          if (limits.context_window !== undefined) lastAssistantUsage.context_window = limits.context_window;
          if (limits.max_output_tokens !== undefined) lastAssistantUsage.max_output_tokens = limits.max_output_tokens;
          yield { type: 'usage', data: lastAssistantUsage };
          lastAssistantUsage = null;
        }
        // Empty text + non-stop finish = silent drop. Convert to an error so
        // the poll-loop's unsurfacedError path tells the user what happened
        // (e.g. "length" = model hit max_output_tokens before producing any
        // user-visible text — common with heavy-reasoning models like
        // minimax-m3 capped low on OpenRouter).
        if (!resultText && lastFinish && lastFinish !== 'stop' && !recoverableReasoningOnly) {
          const reasonMsg = describeFinishReason(lastFinish);
          yield { type: 'error', message: reasonMsg, retryable: false, classification: `opencode:finish:${lastFinish}` };
        }
        const strippedToEmpty =
          (rawResultNonEmpty || recoverableReasoningOnly) && resultText.trim().length === 0;
        yield {
          type: 'result',
          text: resultText || null,
          strippedToEmpty,
          finishReason: lastFinish,
          recoveredFromUnclosedThink,
        };
      }
    }

    return {
      push: (message: string, files?: FileAttachment[]) => {
        pending.push(wrapPromptWithContext(message, systemInstructions));
        if (files && files.length > 0) {
          // Re-arm initialFiles so the next prompt loop iteration picks them up.
          initialFiles = files;
        }
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
