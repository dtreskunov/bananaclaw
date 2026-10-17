/**
 * Home Assistant channel adapter (v2) — native, self-registers on import.
 *
 * Bridges NanoClaw to Home Assistant's [webhook-conversation] custom
 * component (https://github.com/EuleMitKeule/webhook-conversation). HA's
 * conversation agent POSTs a turn to `/webhook/homeassistant`; this adapter
 * routes it through the configured agent group and holds the HTTP request
 * open until the agent's reply lands in `outbound.db` (surfaced via the
 * adapter's `deliver` callback), then returns it in the shape HA expects.
 *
 * Request body (webhook-conversation conversation schema, subset we use):
 *   {
 *     "conversation_id": "abc123",   // stable while HA continues the convo
 *     "query": "latest user message",
 *     "messages": [{ "role": "...", "content": "..." }, ...],
 *     "system_prompt": "optional extra instructions",
 *     "exposed_entities": [{ entity_id, name, state, area_name, ... }],
 *     "user_id": "ha user id", "user_name": "John Doe",
 *     "language": "en-US",
 *     "stream": false              // see Streaming below
 *   }
 *
 * Response — two modes, picked per request by the `stream` flag:
 *
 *   Non-streaming (default, `stream: false` or missing):
 *     `{ "output": "<reply text>" }` — a single JSON body delivered when the
 *     agent's reply lands. NanoClaw never emits `tool_calls`, so HA's tool
 *     loop always exits after one POST. Disable "Enable streaming" on the HA
 *     integration to use this mode.
 *
 *   Streaming (`stream: true`, "Enable streaming" on in HA):
 *     Newline-delimited JSON chunks, written progressively while the agent
 *     works so the user gets fast voice/UI feedback instead of staring at
 *     dead air for the whole turn:
 *       {"type":"item","content":"<query>. "}\n     // immediate echo of the query
 *       {"type":"item","content":"Thinking. "}\n   // rotating filler, every 6s
 *       {"type":"item","content":"Pondering. "}\n
 *       …
 *       {"type":"item","content":"<reply>"}\n      // final agent reply
 *       {"type":"end"}\n
 *     The first chunk is the user's query verbatim — HA's voice pipeline
 *     starts speaking it as soon as the bytes arrive, so the satellite
 *     acknowledges within ~100ms of the user finishing their sentence.
 *     The filler timer then rotates through `FILLERS` every
 *     `FILLER_INTERVAL_MS` ms, capped at `MAX_FILLERS` per turn so a stuck
 *     turn never produces an unbounded transcript. We deliberately do NOT
 *     forward the framework's progress hints (`session_state.progress`) —
 *     they leak tool names and internal model state into the user's voice
 *     transcript. HA's `_send_payload_streaming` concatenates `item`
 *     contents into the assistant's reply, so the final transcript reads
 *     as: "<query>. Thinking. Pondering. <reply>".
 *     On timeout / teardown / superseded we emit `{"type":"error",…}\n`,
 *     which HA's parser turns into a HomeAssistantError.
 *
 * Clarifying questions: HA is synchronous request/response with no interactive
 * controls, so when the agent emits a chat-sdk `ask_question` we render the
 * prompt with its options as a natural inline list ("Which lamp? Desk, Floor,
 * or Corner?", see `renderAskQuestion`), always ending with a question mark.
 * That settles the held request instead of letting it hang to the timeout,
 * and — because HA core continues a conversation whenever the assistant's
 * reply ends with "?" — keeps the same conversation_id (and reopens the voice
 * mic), so the user's answer returns as the next turn in the same conversation
 * with full prior context.
 *
 * Security: the endpoint is on the shared public HTTP server, so auth lives
 * on the mount. HTTP Basic credentials are checked against
 * HA_WEBHOOK_USERNAME / HA_WEBHOOK_PASSWORD (constant-time compare). The
 * factory returns null (adapter skipped) unless HA_WEBHOOK_AGENT_GROUP is
 * set — that env var names the agent group every HA turn is routed to.
 *
 * Turn lifecycle: each HA POST is one inbound message in the conversation's
 * session. HA resends the full `messages` array each call, but our session
 * already holds the prior turns, so we forward only the latest `query`. The
 * agent's reply is captured by the first `deliver` for that (platformId,
 * threadId), which settles the held request with the reply text.
 *
 * Session continuity: HA core keeps a conversation alive (same
 * conversation_id, voice mic reopened) when the assistant's reply ends with a
 * question mark; `renderAskQuestion` ends every clarifying reply with "?" to
 * trigger that. We key the session directly off `conversation_id`, so a
 * continuing HA conversation maps to the same agent session and the agent's
 * own per-thread chat history carries context forward — we do NOT replay
 * HA's `messages` array into the prompt (see `buildTurn`).
 */
import crypto from 'node:crypto';
import type http from 'node:http';

import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { mountHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelSetup, InboundEvent, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

import { extractDisplayQuery, HA_CHANNEL_TYPE } from './homeassistant-text.js';
export { extractDisplayQuery, HA_CHANNEL_TYPE } from './homeassistant-text.js';
const WEBHOOK_PATH = '/webhook/homeassistant';
const DEFAULT_TIMEOUT_MS = 295_000;
const DEFAULT_OUTPUT_FIELD = 'output';

/**
 * Short acknowledgement phrases appended to the query echo so the user
 * hears that work is starting. Picked at random per request. Exported
 * for tests.
 */
export const ACKS: readonly string[] = [
  'Let me look into that...',
  'On it...',
  'Give me a sec...',
  'One moment...',
  'Working on it...',
  'Let me check...',
  'Hang on...',
  'Let me see...',
];

/**
 * Rotating filler phrases emitted as streaming items while the agent thinks.
 * These get spoken aloud by HA's TTS, so they should sound natural, varied,
 * and slightly unexpected — not robotic status updates. All end in "-ing"
 * so they read as ongoing activity. Order is fixed (not random) so
 * consecutive turns don't repeat. Exported for tests.
 */
export const FILLERS: readonly string[] = [
  'Still working on it...',
  'Taking a bit longer than usual...',
  'Hang tight, still on it...',
  'Digging deeper...',
  'Bear with me, almost there...',
  'Still thinking this through...',
  "This one's taking a minute...",
  "Haven't forgotten about you...",
  'Still here, still working...',
  'Pulling some threads together...',
  'Bit of a tricky one...',
  'Working through the details...',
  'Still going, promise...',
  'Getting closer...',
  'Just a little longer...',
  'Wrapping my head around this...',
  'Making progress...',
  'Almost got it...',
  'Putting the finishing touches on...',
  'Should have something for you soon...',
];
/** Time between filler emissions. */
export const FILLER_INTERVAL_MS = 15_000;

export interface HaConfig {
  agentGroupId: string;
  username?: string;
  password?: string;
  timeoutMs: number;
}

/** A webhook-conversation message entry. */
interface HaMessage {
  role: string;
  content?: string;
  tool_call_id?: string;
  tool_name?: string;
}

/** Parsed subset of the webhook-conversation conversation payload. */
interface HaPayload {
  conversation_id?: string;
  query?: string;
  messages?: HaMessage[];
  system_prompt?: string;
  exposed_entities?: unknown;
  user_id?: string;
  user_name?: string;
  language?: string;
  /** True when HA's "Enable streaming" is on; selects NDJSON reply mode. */
  stream?: boolean;
}

/** An in-flight HTTP request awaiting the agent's reply. */
interface PendingRequest {
  res: http.ServerResponse;
  timer: ReturnType<typeof setTimeout>;
  /** Set once we've started/finished responding so we never double-write. */
  settled: boolean;
  /** True when the request asked for NDJSON streaming. */
  streaming: boolean;
  /** True once we've written streaming response headers. */
  streamStarted: boolean;
  /** Filler-word timer, only set in streaming mode. Cleared on every settle path. */
  fillerInterval?: ReturnType<typeof setInterval>;
  /** Number of fillers emitted so far; capped at MAX_FILLERS. */
  fillerCount: number;
  /** Shuffled filler indices for this request. */
  fillerOrder: number[];
}

function readConfig(): HaConfig | null {
  const env = readEnvFile([
    'HA_WEBHOOK_AGENT_GROUP',
    'HA_WEBHOOK_USERNAME',
    'HA_WEBHOOK_PASSWORD',
    'HA_WEBHOOK_TIMEOUT',
  ]);
  const agentGroupId = process.env.HA_WEBHOOK_AGENT_GROUP || env.HA_WEBHOOK_AGENT_GROUP;
  if (!agentGroupId) return null;
  const timeoutSec = parseInt(process.env.HA_WEBHOOK_TIMEOUT || env.HA_WEBHOOK_TIMEOUT || '', 10);
  return {
    agentGroupId,
    username: process.env.HA_WEBHOOK_USERNAME || env.HA_WEBHOOK_USERNAME,
    password: process.env.HA_WEBHOOK_PASSWORD || env.HA_WEBHOOK_PASSWORD,
    timeoutMs: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : DEFAULT_TIMEOUT_MS,
  };
}

/** Deterministic platform_id for the agent group all HA turns route to. */
function platformIdFor(agentGroupId: string): string {
  return `ha:${agentGroupId}`;
}

function pendingKey(platformId: string, threadId: string | null): string {
  return `${platformId}::${threadId ?? ''}`;
}

/** Timing-safe string compare that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still run a compare against a same-length buffer to avoid leaking
    // length via early return timing; result is discarded.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Idempotently ensure a `homeassistant` messaging group exists for the
 * configured agent group and is wired to it. Public sender policy +
 * `sender_scope: 'all'` — the HTTP Basic auth on the mount is the trust
 * boundary, so authenticated turns always engage.
 */
function ensureMessagingGroup(agentGroupId: string): void {
  const platformId = platformIdFor(agentGroupId);
  let mg = getMessagingGroupByPlatform(HA_CHANNEL_TYPE, platformId);
  if (!mg) {
    createMessagingGroup({
      id: `mg-ha-${crypto.randomBytes(6).toString('hex')}`,
      channel_type: HA_CHANNEL_TYPE,
      platform_id: platformId,
      name: 'Home Assistant',
      is_group: 0,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: new Date().toISOString(),
    });
    mg = getMessagingGroupByPlatform(HA_CHANNEL_TYPE, platformId)!;
  }
  const wired = getMessagingGroupAgents(mg.id).some((a) => a.agent_group_id === agentGroupId);
  if (!wired) {
    createMessagingGroupAgent({
      id: `mga-ha-${crypto.randomBytes(6).toString('hex')}`,
      messaging_group_id: mg.id,
      agent_group_id: agentGroupId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: new Date().toISOString(),
    });
  }
}

/**
 * Build a turn from an HA payload.
 *
 * Returns the user-visible `text`: just the latest `query`. We deliberately
 * do NOT forward:
 *
 * - HA's per-request `system_prompt` or `exposed_entities` state blob: that
 *   payload is multi-KB and pushes weak models toward malformed output, and
 *   the agent can read live home state on demand via Home Assistant's MCP
 *   server anyway.
 * - The prior turns HA replays in `messages` on every call. The agent's own
 *   per-thread session already holds those turns, so re-embedding them in the
 *   user message is at best redundant and in practice confuses the model into
 *   responding to the embedded transcript instead of the user's actual query.
 *   `renderAskQuestion` (always ending in "?") keeps clarifying-question
 *   follow-ups on the same `conversation_id` — and thus the same session —
 *   so context survives the round-trip without replay. If HA *does* open a
 *   fresh `conversation_id` (user timed out, said "stop", etc.) that's a
 *   deliberate new conversation, and treating it as one is the right call.
 * - `tool_result` entries that can appear in `messages`. They only show up
 *   when a prior assistant turn returned `tool_calls`, which our adapter
 *   never does (`extractOutboundText` flattens everything to text), so the
 *   integration's tool-call loop always exits after one POST.
 */
export function buildTurn(payload: HaPayload): { text: string } {
  return { text: (payload.query ?? '').trim() };
}

/**
 * Strip the legacy `[Conversation so far]…[End conversation so far]` and
 * `[Tool Result: …]…[End Tool Result]` blocks that earlier versions of
 * `buildTurn` prepended, so the web chat UI shows just the user's actual
 * query when looking back at old HA rows. Current `buildTurn` never produces
 * these markers; this helper exists only to clean up pre-existing inbound
 * rows. Returns the trimmed remainder, or the original text unchanged if no
 * markers are found.
 */
/**
 * Render a chat-sdk `ask_question` payload as plain text.
 *
 * HA's webhook-conversation integration is synchronous request/response and
 * cannot show interactive option buttons — if we ignore the question the held
 * HTTP request just hangs until it times out. We render the prompt followed by
 * the options as a natural inline list ("Which lamp? Desk, Floor, or
 * Corner?"), always ending with a question mark. That settles the request,
 * lets HA speak/show the prompt, and — because HA core continues a
 * conversation whenever the assistant's reply ends with "?" — keeps the same
 * conversation_id (and reopens the voice mic), so the user's answer comes back
 * as the next turn in the same conversation, where the agent resolves it from
 * context. Returns null if the payload isn't a usable ask_question.
 */
export function renderAskQuestion(content: Record<string, unknown>): string | null {
  if (content.type !== 'ask_question') return null;
  const prompt = content.question ?? content.title;
  const promptText = typeof prompt === 'string' ? prompt.trim() : '';
  const labels = Array.isArray(content.options)
    ? content.options
        .map((o) => (o && typeof o === 'object' ? (o as Record<string, unknown>).label : undefined))
        .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
    : [];
  if (!promptText && labels.length === 0) return null;

  const parts: string[] = [];
  if (promptText) {
    // Give the prompt its own terminal punctuation so the options read as a
    // follow-up question rather than running into it.
    parts.push(/[?;？.!]$/.test(promptText) ? promptText : `${promptText}?`);
  }
  if (labels.length > 0) parts.push(`${joinOptions(labels)}?`);

  let text = parts.join(' ').trim();
  // Guarantee a trailing question mark. HA core only continues a conversation
  // (keeping the same conversation_id and reopening the voice mic) when the
  // assistant's reply ends with "?" / ";" / "？". See "Session continuity".
  if (text && !/[?;？]$/.test(text)) text += '?';
  return text || null;
}

/** Join option labels into a natural list: "A", "A or B", "A, B, or C". */
function joinOptions(labels: string[]): string {
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`;
}

/**
 * Encode a single NDJSON streaming chunk (no trailing brace games — just
 * `JSON.stringify(chunk) + "\n"`). Exported so the wire format can be unit
 * tested without a live socket.
 */
export function streamItem(content: string): string {
  return `${JSON.stringify({ type: 'item', content })}\n`;
}

export function streamEnd(): string {
  return `${JSON.stringify({ type: 'end' })}\n`;
}

export function streamError(message: string): string {
  return `${JSON.stringify({ type: 'error', message })}\n`;
}

/** Extract the reply text from an outbound message's parsed content. */
export function extractOutboundText(message: OutboundMessage): string | null {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    const text = obj.markdown ?? obj.text;
    if (typeof text === 'string') return text;
    // chat-sdk ask_question: flatten to text so the held HA request settles
    // with the prompt instead of hanging until timeout.
    const asked = renderAskQuestion(obj);
    if (asked !== null) return asked;
  }
  return null;
}

/**
 * Exported for tests; production code goes through the channel registry
 * factory at the bottom of the file. Tests pass a synthetic `HaConfig` and
 * mock `mountHandler` to capture the request handler.
 */
export function createAdapter(config: HaConfig): ChannelAdapter {
  let setupCallbacks: ChannelSetup | null = null;
  const pending = new Map<string, PendingRequest>();

  function clearPending(key: string): void {
    const p = pending.get(key);
    if (p) {
      clearTimeout(p.timer);
      stopFiller(p);
      pending.delete(key);
    }
  }

  /**
   * Write streaming response headers if we haven't already. NDJSON over a
   * chunked HTTP/1.1 response; `X-Accel-Buffering: no` keeps any fronting
   * nginx from holding chunks back until the response closes.
   */
  function startStream(p: PendingRequest): void {
    if (p.streamStarted) return;
    p.streamStarted = true;
    try {
      p.res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
    } catch (err) {
      log.warn('HA streaming writeHead failed', { err });
    }
  }

  /** Best-effort write of a pre-encoded NDJSON line to the streaming response. */
  function writeStreamLine(p: PendingRequest, line: string): void {
    if (!p.streamStarted) startStream(p);
    try {
      p.res.write(line);
    } catch (err) {
      log.warn('HA streaming chunk write failed', { err });
    }
  }

  /**
   * Start the rotating filler timer for a streaming request. Emits one
   * `{type:'item', content:'<word>. '}` chunk every FILLER_INTERVAL_MS,
   * stopping when the cap is hit. The cap matters: HA's voice TTS will
   * actually speak each filler, so an uncapped stream on a stuck turn
   * would natter at the user indefinitely.
   */
  function startFiller(p: PendingRequest): void {
    if (p.fillerInterval) return;
    p.fillerInterval = setInterval(() => {
      if (p.settled) {
        stopFiller(p);
        return;
      }
      const word = FILLERS[p.fillerOrder[p.fillerCount % p.fillerOrder.length]];
      p.fillerCount += 1;
      writeStreamLine(p, streamItem(`\n${word}`));
    }, FILLER_INTERVAL_MS);
  }

  /** Idempotent: clear the filler interval if present. */
  function stopFiller(p: PendingRequest): void {
    if (p.fillerInterval) {
      clearInterval(p.fillerInterval);
      p.fillerInterval = undefined;
    }
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    // ── HTTP Basic auth ──────────────────────────────────────────────
    if (config.username && config.password) {
      const header = req.headers.authorization || '';
      const m = header.match(/^Basic\s+(.+)$/i);
      let ok = false;
      if (m) {
        const decoded = Buffer.from(m[1], 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        if (sep >= 0) {
          const u = decoded.slice(0, sep);
          const p = decoded.slice(sep + 1);
          ok = safeEqual(u, config.username) && safeEqual(p, config.password);
        }
      }
      if (!ok) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Basic realm="nanoclaw-homeassistant"',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

    // ── Parse body ───────────────────────────────────────────────────
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let payload: HaPayload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HaPayload;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    if (!setupCallbacks) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'adapter_not_ready' }));
      return;
    }

    // Key the session directly off HA's conversation_id, which stays stable
    // while HA continues a conversation; fall back to a fresh id otherwise.
    const threadId = (payload.conversation_id || `ha-${Date.now()}`).trim();
    const platformId = platformIdFor(config.agentGroupId);
    const { text } = buildTurn(payload);
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'empty_query' }));
      return;
    }

    const streaming = payload.stream === true;
    const senderId = payload.user_id ? `ha-user:${payload.user_id}` : 'ha-user:default';
    const messageId = `ha-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const key = pendingKey(platformId, threadId);

    // Supersede any in-flight request for the same conversation (HA retries,
    // overlapping turns) so we don't leak a held socket.
    const existing = pending.get(key);
    if (existing && !existing.settled) {
      existing.settled = true;
      clearTimeout(existing.timer);
      stopFiller(existing);
      try {
        if (existing.streamStarted) {
          existing.res.write(streamError('superseded'));
          existing.res.end();
        } else if (existing.streaming) {
          existing.res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          existing.res.end(streamError('superseded'));
        } else {
          existing.res.writeHead(409, { 'Content-Type': 'application/json' });
          existing.res.end(JSON.stringify({ error: 'superseded' }));
        }
      } catch {
        // swallow — socket may already be gone
      }
    }

    const timer = setTimeout(() => {
      const p = pending.get(key);
      if (!p || p.settled) return;
      p.settled = true;
      stopFiller(p);
      pending.delete(key);
      try {
        if (p.streaming) {
          if (!p.streamStarted) startStream(p);
          p.res.write(streamItem('Sorry, I took too long on that one. Could you try again?'));
          p.res.write(streamEnd());
          p.res.end();
        } else {
          p.res.writeHead(504, { 'Content-Type': 'application/json' });
          p.res.end(
            JSON.stringify({ [DEFAULT_OUTPUT_FIELD]: 'Sorry, I took too long on that one. Could you try again?' }),
          );
        }
      } catch (err) {
        log.warn('HA webhook timeout response failed', { err });
      }
      log.warn('HA webhook turn timed out', { threadId, timeoutMs: config.timeoutMs });
    }, config.timeoutMs);

    const fillerOrder = Array.from({ length: FILLERS.length }, (_, i) => i);
    for (let i = fillerOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [fillerOrder[i], fillerOrder[j]] = [fillerOrder[j], fillerOrder[i]];
    }
    const p: PendingRequest = {
      res,
      timer,
      settled: false,
      streaming,
      streamStarted: false,
      fillerCount: 0,
      fillerOrder,
    };
    pending.set(key, p);

    // Streaming: open the response NOW and echo the user's query as the first
    // item so HA's voice satellite starts speaking the ack within ~100ms
    // instead of waiting for the agent to think. Then start the filler timer.
    if (streaming) {
      const echoBase = extractDisplayQuery(text);
      if (echoBase) {
        // If the query already ends in terminal punctuation, just add a
        // trailing space; otherwise add ". " so the echo reads as its own
        // sentence before the fillers and final reply.
        const echo = /[.!?。！？]$/.test(echoBase) ? `${echoBase} ` : `${echoBase}. `;
        const ack = ACKS[Math.floor(Math.random() * ACKS.length)];
        writeStreamLine(p, streamItem(`${echo}\n${ack}`));
      }
      startFiller(p);
    }

    // ── Route inbound ────────────────────────────────────────────────
    const event: InboundEvent = {
      channelType: HA_CHANNEL_TYPE,
      platformId,
      threadId,
      message: {
        id: messageId,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        isMention: true,
        isGroup: false,
        content: JSON.stringify({
          text,
          sender: senderId,
          senderId,
          senderName: payload.user_name,
        }),
      },
    };

    try {
      await setupCallbacks.onInboundEvent(event);
    } catch (err) {
      log.error('HA webhook failed to route inbound', { threadId, err });
      clearPending(key);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'routing_failed' }));
      } else {
        try {
          res.end();
        } catch {
          // swallow
        }
      }
    }
  }

  const adapter: ChannelAdapter = {
    name: 'homeassistant',
    channelType: HA_CHANNEL_TYPE,
    supportsThreads: true,
    supportsMultiFile: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      setupCallbacks = cfg;
      ensureMessagingGroup(config.agentGroupId);
      mountHandler(WEBHOOK_PATH, (req, res) => {
        void handleRequest(req, res);
      });
      log.info('Home Assistant channel ready', {
        path: WEBHOOK_PATH,
        agentGroupId: config.agentGroupId,
        authRequired: Boolean(config.username && config.password),
      });
    },

    async teardown(): Promise<void> {
      for (const [key, p] of pending) {
        clearTimeout(p.timer);
        stopFiller(p);
        if (!p.settled) {
          try {
            if (p.streamStarted) {
              p.res.write(streamError('shutting_down'));
              p.res.end();
            } else if (p.streaming) {
              p.res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
              p.res.end(streamError('shutting_down'));
            } else {
              p.res.writeHead(503, { 'Content-Type': 'application/json' });
              p.res.end(JSON.stringify({ error: 'shutting_down' }));
            }
          } catch {
            // swallow
          }
        }
        pending.delete(key);
      }
      setupCallbacks = null;
    },

    isConnected(): boolean {
      return setupCallbacks !== null;
    },

    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      const key = pendingKey(platformId, threadId);
      const p = pending.get(key);
      if (!p || p.settled) return undefined;

      const text = extractOutboundText(message);
      if (text === null) return undefined; // non-text payload (card, etc.) — ignore

      // The first text reply settles the held request.
      p.settled = true;
      clearPending(key);
      try {
        if (p.streaming) {
          if (!p.streamStarted) startStream(p);
          p.res.write(streamItem(text));
          p.res.write(streamEnd());
          p.res.end();
        } else {
          p.res.writeHead(200, { 'Content-Type': 'application/json' });
          p.res.end(JSON.stringify({ [DEFAULT_OUTPUT_FIELD]: text }));
        }
      } catch (err) {
        log.warn('HA webhook response write failed', { err });
      }
      return undefined;
    },
  };

  return adapter;
}

registerChannelAdapter('homeassistant', {
  factory: () => {
    const config = readConfig();
    if (!config) return null;
    return createAdapter(config);
  },
});
