import { findByRouting } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';
import type { FileAttachment } from './providers/types.js';
import { TIMEZONE, formatLocalTime } from './timezone.js';

/**
 * Command categories for messages starting with '/'.
 * - admin: sender must be in NANOCLAW_ADMIN_USER_IDS
 * - filtered: silently drop (mark completed without processing)
 * - passthrough: pass raw to the agent (no XML wrapping)
 * - none: not a command — format normally
 */
export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';

const ADMIN_COMMANDS = new Set(['/remote-control', '/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);
const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/start']);

export interface CommandInfo {
  category: CommandCategory;
  command: string; // the command name (e.g., '/clear')
  text: string; // full original text
  senderId: string | null;
}

/**
 * Categorize a message as a command or not.
 * Only applies to chat/chat-sdk messages.
 *
 * The extracted `senderId` is compared against `NANOCLAW_ADMIN_USER_IDS`
 * which stores ids in the namespaced form `<channel_type>:<raw>` (see
 * src/db/users.ts). chat-sdk-bridge serializes `author.userId` as a raw
 * platform id with no prefix, so we prefix it here. If the id already
 * contains a `:` we assume it's pre-namespaced (non-chat-sdk adapters
 * that populate `senderId` directly) and leave it alone.
 */
export function categorizeMessage(msg: MessageInRow): CommandInfo {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  const senderId = extractSenderId(msg, content);

  if (!text.startsWith('/')) {
    return { category: 'none', command: '', text, senderId };
  }

  // Extract the command name (e.g., '/clear' from '/clear some args')
  const command = text.split(/\s/)[0].toLowerCase();

  if (ADMIN_COMMANDS.has(command)) {
    return { category: 'admin', command, text, senderId };
  }

  if (FILTERED_COMMANDS.has(command)) {
    return { category: 'filtered', command, text, senderId };
  }

  return { category: 'passthrough', command, text, senderId };
}

/**
 * Narrow check for /clear — the only command the runner handles directly.
 * All other command gating (filtered, admin) is done by the host router
 * before messages reach the container.
 */
export function isClearCommand(msg: MessageInRow): boolean {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  return text.toLowerCase().startsWith('/clear');
}

/**
 * True for any chat that needs the outer loop's command path: /clear plus
 * admin/passthrough slash commands the SDK can only dispatch when they are
 * a query's first input. Used by the follow-up poller to bail out and let
 * the outer loop reopen the query.
 */
export function isRunnerCommand(msg: MessageInRow): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const cat = categorizeMessage(msg).category;
  return cat === 'admin' || cat === 'passthrough';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSenderId(msg: MessageInRow, content: any): string | null {
  // Authoritative: the host's senderResolver writes the canonical UUID
  // here. Older inbound rows (written before sender_user_id existed)
  // fall through to the legacy synthesis path below.
  if (msg.sender_user_id) return msg.sender_user_id;
  const raw: string | null = content?.senderId || content?.author?.userId || null;
  if (!raw) return null;
  // Already namespaced (e.g. "telegram:123") — use as-is.
  if (raw.includes(':')) return raw;
  // Raw platform id from chat-sdk serialization — prefix with channel type.
  if (!msg.channel_type) return raw;
  return `${msg.channel_type}:${raw}`;
}

/**
 * Routing context extracted from messages_in rows.
 * Copied to messages_out by default so responses go back to the sender.
 */
export interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
}

/**
 * Extract routing context from a batch of messages.
 *
 * Uses the LAST message's routing fields — replies thread under the most
 * recent message in the batch, matching how chat UIs render conversations.
 * Using `first` here let earlier messages in a multi-message batch "claim"
 * the reply, leaving the newer ones looking unanswered.
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  const last = messages[messages.length - 1];
  return {
    platformId: last?.platform_id ?? null,
    channelType: last?.channel_type ?? null,
    threadId: last?.thread_id ?? null,
    inReplyTo: last?.id ?? null,
  };
}

/**
 * Format a batch of messages_in rows into a prompt string.
 *
 * Prepends a `<context timezone="<IANA>" />` header so the agent always knows
 * what timezone it's in — every timestamp it sees in message bodies is the
 * user's local time, and every time it produces (schedules, suggests) should
 * be interpreted as local time in that same zone. This header is v1 behavior
 * (src/v1/router.ts:20-22); dropping it led to misinterpretations where the
 * agent scheduled tasks for the wrong hour.
 *
 * Strips routing fields — the agent never sees platform_id, channel_type, thread_id.
 */
export function formatMessages(messages: MessageInRow[]): string {
  const header = `<context timezone="${escapeXml(TIMEZONE)}" />\n`;
  if (messages.length === 0) return header;

  // Group by kind
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

  if (chatMessages.length > 0) {
    parts.push(formatChatMessages(chatMessages));
  }
  if (taskMessages.length > 0) {
    parts.push(...taskMessages.map(formatTaskMessage));
  }
  if (webhookMessages.length > 0) {
    parts.push(...webhookMessages.map(formatWebhookMessage));
  }
  if (systemMessages.length > 0) {
    parts.push(...systemMessages.map(formatSystemMessage));
  }

  return header + parts.join('\n\n');
}

function formatChatMessages(messages: MessageInRow[]): string {
  // Each `<message id="..." from="...">...</message>` block is self-contained;
  // concatenating them reads to the agent as a sequence of distinct messages.
  // Earlier revisions wrapped multi-message batches in an outer `<messages>`
  // envelope, but the Claude Agent SDK responded to that shape with a
  // synthetic stub (`model: "<synthetic>"`, `content: "No response
  // requested."`) instead of calling the API — see #2555 for the full trace.
  // The fix is simply to drop the wrapper; the single-message path (which
  // already worked) is now just the N=1 case of the same code.
  const formatted = messages.map(formatSingleChat).join('\n');
  const hasWeb = messages.some((m) => m.channel_type === 'web');
  if (!hasWeb) return formatted;
  // For the NanoClaw web/file-browser channel, tell the agent how to make
  // file references clickable. The UI rewrites relative-path markdown links
  // and backtick-quoted filename tokens into download links pointing at the
  // file endpoint, so the agent should use one of those two forms instead
  // of plain prose like "Here it is — foo.mp3".
  const hint =
    '<format_hint channel="web">When you mention a file that lives in the agent workspace, format it as a Markdown link using a workspace-relative path — e.g. `[sick_day_v2.mp3](output/sick_day_v2.mp3)` — or wrap the relative path in backticks: `` `output/sick_day_v2.mp3` ``. Do NOT use absolute container paths like `/workspace/...`. The user\'s UI will turn either form into a clickable download link; plain prose filenames are not clickable.</format_hint>';
  return hint + '\n' + formatted;
}

function formatSingleChat(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const sender = content.sender || content.author?.fullName || content.author?.userName || 'Unknown';
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const text = content.text || '';
  const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
  const replyAttr = content.replyTo?.id ? ` reply_to="${escapeXml(String(content.replyTo.id))}"` : '';
  const replyPrefix = formatReplyContext(content.replyTo);
  const attachmentsSuffix = formatAttachments(content.attachments);

  const fromAttr = originAttr(msg);

  return `<message${idAttr}${fromAttr} sender="${escapeXml(sender)}" time="${escapeXml(time)}"${replyAttr}>${replyPrefix}${escapeXml(text)}${attachmentsSuffix}</message>`;
}

/**
 * Build a ` from="destination_name"` attribute string from a message's routing
 * fields. Shared by all formatters so the agent always knows where a message
 * originated — critical for explicit addressing.
 */
function originAttr(msg: MessageInRow): string {
  const fromDest = findByRouting(msg.channel_type, msg.platform_id);
  if (fromDest) return ` from="${escapeXml(fromDest.name)}"`;
  if (msg.channel_type || msg.platform_id) {
    return ` from="unknown:${escapeXml(msg.channel_type || '')}:${escapeXml(msg.platform_id || '')}"`;
  }
  return '';
}

function formatTaskMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const from = originAttr(msg);
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const parts: string[] = [];
  // Execution framing. A scheduled task fires as its own turn but resumes the
  // same conversation continuation — which may still show the exchange where
  // this very task was scheduled and confirmed. Without an explicit cue, some
  // models (notably reasoning models like minimax) treat the fired task as
  // already-handled: they emit only chain-of-thought and no user-visible
  // output, so nothing is sent. Make it unmistakable that this is the moment
  // of execution, that the work has NOT been done yet, and that a reply is
  // mandatory — internal reasoning alone does not count as carrying it out.
  parts.push(
    'The scheduled time for this task has now arrived. This is the execution ' +
      'moment — not a reminder, a duplicate, or a re-scheduling. You have NOT ' +
      'carried out the instruction below yet; any earlier turn only scheduled ' +
      'it. Perform it now and actually send the resulting message(s). Do not ' +
      'reply with internal reasoning only, and do not treat it as already done.',
    '',
  );
  if (content.scriptOutput) {
    parts.push('Script output:', JSON.stringify(content.scriptOutput, null, 2), '');
  }
  parts.push('Instructions:', content.prompt || '');
  return `<task${from} time="${escapeXml(time)}">${parts.join('\n')}</task>`;
}

function formatWebhookMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const source = content.source || 'unknown';
  const event = content.event || 'unknown';
  const from = originAttr(msg);
  return `<webhook${from} source="${escapeXml(source)}" event="${escapeXml(event)}">${JSON.stringify(content.payload || content, null, 2)}</webhook>`;
}

function formatSystemMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const from = originAttr(msg);
  return `<system_response${from} action="${escapeXml(content.action || 'unknown')}" status="${escapeXml(content.status || 'unknown')}">${JSON.stringify(content.result || null)}</system_response>`;
}

/**
 * Render the quoted original inside the <message> body.
 *
 * Matches v1 format (src/v1/router.ts:10-18): `<quoted_message from="X">Y</quoted_message>`.
 * Requires BOTH sender and text — if only id is present the reply_to attribute
 * on the parent <message> carries the link without an inline preview.
 *
 * No truncation here (v1 didn't truncate).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReplyContext(replyTo: any): string {
  if (!replyTo) return '';
  const sender = replyTo.sender;
  const text = replyTo.text;
  if (!sender || !text) return '';
  return `\n  <quoted_message from="${escapeXml(sender)}">${escapeXml(text)}</quoted_message>\n`;
}

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  webm: 'audio/webm',
};

/**
 * Normalize audio MIME types that providers (e.g. OpenRouter) don't accept.
 * Maps unsupported container MIME types to their closest accepted equivalent.
 */
const AUDIO_MIME_NORMALIZE: Record<string, string> = {
  'audio/webm': 'audio/ogg',   // Opus in WebM → treat as Ogg (same codec)
  'audio/x-m4a': 'audio/mp4',  // Non-standard m4a MIME → standard
};

/**
 * Extract file attachments from a batch of messages. Returns absolute
 * container paths + MIME types suitable for passing to multimodal models.
 */
export function extractFileAttachments(messages: MessageInRow[]): FileAttachment[] {
  const files: FileAttachment[] = [];
  for (const msg of messages) {
    const content = parseContent(msg.content);
    const attachments = content.attachments;
    if (!Array.isArray(attachments)) continue;
    for (const a of attachments) {
      if (!a.localPath) continue;
      const ext = (a.name || a.filename || '').split('.').pop()?.toLowerCase() || '';
      const rawMime = a.mimeType || a.mime || EXT_TO_MIME[ext];
      if (!rawMime) continue;
      const mime = AUDIO_MIME_NORMALIZE[rawMime] || rawMime;
      files.push({
        path: `/workspace/${a.localPath}`,
        mime,
        filename: a.name || a.filename || 'attachment',
      });
    }
  }
  return files;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAttachments(attachments: any[] | undefined): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts = attachments.map((a) => {
    const name = a.name || a.filename || 'attachment';
    const type = a.type || 'file';
    const localPath = a.localPath ? `/workspace/${a.localPath}` : '';
    const url = a.url || '';
    if (localPath) {
      return `[${type}: ${escapeXml(name)} — saved to ${escapeXml(localPath)}]`;
    }
    return url ? `[${type}: ${escapeXml(name)} (${escapeXml(url)})]` : `[${type}: ${escapeXml(name)}]`;
  });
  return '\n' + parts.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type OutputDiagnostic =
  | 'missing-leading-angle'
  | 'orphan-think-close'
  | 'unclosed-think'
  | 'unclosed-internal'
  | 'unclosed-message';

export type AssistantOutputSegment =
  | { kind: 'message'; to: string; text: string }
  | { kind: 'internal'; text: string }
  | { kind: 'think'; text: string }
  | { kind: 'unwrapped'; text: string };

export interface ParsedAssistantOutput {
  segments: AssistantOutputSegment[];
  deliveries: Array<{ to: string; body: string }>;
  internal: string[];
  unwrapped: string;
  diagnostics: OutputDiagnostic[];
  /** Input with reasoning removed and recoverable wrappers normalized. */
  normalizedText: string;
}

type OpenSegment =
  | { kind: 'message'; to: string; text: string; opener: string }
  | { kind: 'internal'; text: string }
  | { kind: 'think'; text: string };

const OUTPUT_TAG_RE =
  /<message\s+to="([^"]+)"\s*>|<\/message\s*>|<internal\s*>|<\/internal\s*>|<think(?:ing)?\b[^>]*>|<\/think(?:ing)?\s*>/gi;

function appendOutputSegment(segments: AssistantOutputSegment[], segment: AssistantOutputSegment): void {
  if (!segment.text) return;
  const prior = segments[segments.length - 1];
  if (segment.kind === 'unwrapped' && prior?.kind === 'unwrapped') {
    prior.text += segment.text;
  } else {
    segments.push(segment);
  }
}

function serializeSegments(
  segments: AssistantOutputSegment[],
  include: (segment: AssistantOutputSegment) => boolean,
): string {
  return segments
    .filter(include)
    .map((segment) => {
      if (segment.kind === 'message') return `<message to="${segment.to}">${segment.text}</message>`;
      if (segment.kind === 'internal') return `<internal>${segment.text}</internal>`;
      if (segment.kind === 'think') return `<think>${segment.text}</think>`;
      return segment.text;
    })
    .join('')
    .trim();
}

/** Model reasoning frequently quotes the routing syntax in Markdown code
 * spans. Tags inside those spans are examples, not structural output. */
function isInsideMarkdownCode(text: string, index: number): boolean {
  let activeTicks = 0;
  for (let i = 0; i < index;) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < index && text[end] === '`') end++;
    const run = end - i;
    if (activeTicks === 0) activeTicks = run;
    else if (run === activeTicks) activeTicks = 0;
    i = end;
  }
  return activeTicks > 0;
}

function isDeliveryOnlySuffix(text: string, from: number): boolean {
  let rest = text.slice(from);
  let seen = false;
  while (rest.trimStart()) {
    rest = rest.trimStart();
    const messageOpen = /^<message\s+to="[^"]+"\s*>/i.exec(rest);
    if (messageOpen) {
      const close = /<\/message\s*>/i.exec(rest.slice(messageOpen[0].length));
      if (!close) return false;
      rest = rest.slice(messageOpen[0].length + close.index + close[0].length);
      seen = true;
      continue;
    }
    const internalOpen = /^<internal\s*>/i.exec(rest);
    if (internalOpen) {
      const close = /<\/internal\s*>/i.exec(rest.slice(internalOpen[0].length));
      if (!close) return false;
      rest = rest.slice(internalOpen[0].length + close.index + close[0].length);
      seen = true;
      continue;
    }
    return false;
  }
  return seen;
}

/**
 * Parse the model's XML-like output in one tolerant pass. This deliberately is
 * not an XML parser: model output can be truncated, lose its first `<`, or put
 * a valid delivery block inside an unclosed `<think>`. Every character is
 * assigned to exactly one message, internal, private-think, or unwrapped segment.
 */
export function parseAssistantOutput(raw: string): ParsedAssistantOutput {
  const diagnostics: OutputDiagnostic[] = [];
  const leadingWhitespace = raw.match(/^\s*/)?.[0] ?? '';
  let body = raw.slice(leadingWhitespace.length);
  if (
    body && body[0] !== '<' &&
    /^(?:message(?:\s+[\w-]+=|>)|internal\s*>|think(?:ing)?(?:\s[^>]*)?>)/i.test(body)
  ) {
    body = '<' + body;
    diagnostics.push('missing-leading-angle');
  }
  const text = leadingWhitespace + body;
  const segments: AssistantOutputSegment[] = [];
  let open: OpenSegment | undefined;
  let cursor = 0;
  OUTPUT_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  const appendText = (value: string) => {
    if (!value) return;
    if (open) open.text += value;
    else appendOutputSegment(segments, { kind: 'unwrapped', text: value });
  };
  const finishOpen = () => {
    if (!open) return;
    if (open.kind === 'message') appendOutputSegment(segments, { kind: 'message', to: open.to, text: open.text });
    else appendOutputSegment(segments, { kind: open.kind, text: open.text });
    open = undefined;
  };

  while ((match = OUTPUT_TAG_RE.exec(text)) !== null) {
    appendText(text.slice(cursor, match.index));
    cursor = OUTPUT_TAG_RE.lastIndex;
    const token = match[0];
    const lower = token.toLowerCase();
    const messageTo = match[1];
    const isThinkClose = lower.startsWith('</think') || lower.startsWith('</thinking');

    if (!isThinkClose && isInsideMarkdownCode(text, match.index)) {
      appendText(token);
      continue;
    }

    if (open?.kind === 'message') {
      if (lower.startsWith('</message')) finishOpen();
      else open.text += token;
      continue;
    }
    if (open?.kind === 'internal') {
      if (lower.startsWith('</internal')) finishOpen();
      else if (messageTo !== undefined && isDeliveryOnlySuffix(text, match.index)) {
        diagnostics.push('unclosed-internal');
        finishOpen();
        open = { kind: 'message', to: messageTo, text: '', opener: token };
      } else open.text += token;
      continue;
    }
    if (open?.kind === 'think') {
      if (isThinkClose) finishOpen();
      else if (messageTo !== undefined && isDeliveryOnlySuffix(text, match.index)) {
        diagnostics.push('unclosed-think');
        finishOpen();
        open = { kind: 'message', to: messageTo, text: '', opener: token };
      } else if (lower.startsWith('<internal') && isDeliveryOnlySuffix(text, match.index)) {
        diagnostics.push('unclosed-think');
        finishOpen();
        open = { kind: 'internal', text: '' };
      } else open.text += token;
      continue;
    }

    if (messageTo !== undefined) open = { kind: 'message', to: messageTo, text: '', opener: token };
    else if (lower.startsWith('<internal')) open = { kind: 'internal', text: '' };
    else if (lower.startsWith('<think') || lower.startsWith('<thinking')) open = { kind: 'think', text: '' };
    else if (isThinkClose) {
      diagnostics.push('orphan-think-close');
      // A lost opening tag leaves its reasoning prefix as unwrapped text.
      // Reclassify that prefix unless a real delivery/internal segment was
      // already completed before this stray close.
      if (!segments.some((segment) => segment.kind === 'message' || segment.kind === 'internal')) {
        const prefix = segments.map((segment) => segment.text).join('');
        segments.length = 0;
        if (prefix) appendOutputSegment(segments, { kind: 'think', text: prefix });
      }
    } else {
      appendOutputSegment(segments, { kind: 'unwrapped', text: token });
    }
  }
  appendText(text.slice(cursor));

  if (open?.kind === 'think') {
    diagnostics.push('unclosed-think');
    finishOpen();
  } else if (open?.kind === 'internal') {
    diagnostics.push('unclosed-internal');
    finishOpen();
  } else if (open?.kind === 'message') {
    diagnostics.push('unclosed-message');
    appendOutputSegment(segments, { kind: 'unwrapped', text: open.opener + open.text });
    open = undefined;
  }

  const deliveries = segments
    .filter((segment): segment is Extract<AssistantOutputSegment, { kind: 'message' }> => segment.kind === 'message')
    .map((segment) => ({ to: segment.to, body: segment.text.trim() }));
  const internal = segments
    .filter((segment) => segment.kind === 'internal')
    .map((segment) => segment.text.trim())
    .filter(Boolean);
  const unwrapped = segments
    .filter((segment) => segment.kind === 'unwrapped')
    .map((segment) => segment.text)
    .join('')
    .trim();

  return {
    segments,
    deliveries,
    internal,
    unwrapped,
    diagnostics,
    normalizedText: serializeSegments(segments, (segment) => segment.kind !== 'think'),
  };
}

/** Strip `<internal>...</internal>` blocks from agent output, then trim. */
export function stripInternalTags(text: string): string {
  return serializeSegments(parseAssistantOutput(text).segments, (segment) => segment.kind !== 'internal');
}

/** Strip provider chain-of-thought while recovering delivery blocks from malformed wrappers. */
export function stripThinkTags(text: string): string {
  return parseAssistantOutput(text).normalizedText;
}

/** Return internal scratchpad blocks separated by blank lines. */
export function extractInternalTags(text: string): string {
  return parseAssistantOutput(text).internal.join('\n\n');
}
