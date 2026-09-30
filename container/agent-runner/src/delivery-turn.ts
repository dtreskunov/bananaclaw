/**
 * Delivery turn: route a final reply the runner could not deliver as-is.
 *
 * Models are trained to end a turn with a plain-text answer, not to address
 * it. When a result carries prose outside `<message to="…">` blocks (or a
 * block to an unknown destination), the runner makes one small tool-free
 * call that sees the persona, the destinations, the recent visible
 * transcript, what was already sent this turn, and the draft, and answers
 * with delivery directives. The draft itself stays in the agent's history;
 * only the routed result is dispatched.
 *
 * Providers that set `unwrappedReplies` drop the wrap contract from their
 * work prompt, so every prose reply comes through here. Providers without
 * `complete()` keep the in-conversation recovery nudges instead.
 */
import fs from 'node:fs';

import { getInboundDb, getOutboundDb } from './db/connection.js';
import { findByName, findByRouting, getAllDestinations, type DestinationEntry } from './destinations.js';
import { parseAssistantOutput, type RoutingContext } from './formatter.js';
import type { CallUsage, CompletionRequest, CompletionResult } from './providers/types.js';
import { TIMEZONE, formatLocalTime } from './timezone.js';

const PERSONA_PATH = '/workspace/agent/CLAUDE.local.md';
const TRANSCRIPT_BUDGET_CHARS = 24_000;
const TRANSCRIPT_MESSAGE_CAP_CHARS = 4_000;
const TRACE_DRAFT_CAP_CHARS = 8_000;
const MAX_OUTPUT_TOKENS = 4_096;

function log(msg: string): void {
  console.error(`[delivery-turn] ${msg}`);
}

export type Complete = (request: CompletionRequest) => Promise<CompletionResult>;

export interface DeliveryInput {
  draft: string;
  /** The conversation this result answers. */
  routing: RoutingContext;
  /** Outbound seq at turn start and the turn id: rows after it were sent this turn. */
  since: number;
  turnId: string;
  assistantName?: string;
  /** Test seam; defaults to the group's CLAUDE.local.md. */
  personaPath?: string;
}

export type DeliveryDecision = 'deliver' | 'message' | 'skip' | 'fallback';

export interface DeliveryOutcome {
  /** Wrapped text for the normal dispatch path. */
  text: string;
  decision: DeliveryDecision;
  /** The delivery turn chose to send nothing; not a failure. */
  silent: boolean;
  usage?: CallUsage;
}

/** A draft split into what the delivery turn decides about and what it doesn't. */
export interface DraftParts {
  /** Visible reply text: prose plus blocks addressed to the reply route or unknown names, in order. */
  body: string;
  /** Blocks the model already addressed to another known destination — sent as written. */
  addressed: Array<{ to: string; body: string }>;
  internal: string[];
  /** Prose outside blocks, or a block to an unknown destination. */
  needsRouting: boolean;
}

export function splitDraft(draft: string, replyDestination: string | null): DraftParts {
  const parsed = parseAssistantOutput(draft);
  const pieces: string[] = [];
  const addressed: DraftParts['addressed'] = [];
  const internal: string[] = [];
  let needsRouting = false;
  for (const segment of parsed.segments) {
    if (segment.kind === 'think') continue;
    if (segment.kind === 'internal') {
      if (segment.text.trim()) internal.push(segment.text.trim());
      continue;
    }
    if (segment.kind === 'unwrapped') {
      if (segment.text.trim()) needsRouting = true;
      pieces.push(segment.text);
      continue;
    }
    const known = findByName(segment.to);
    if (!known) needsRouting = true;
    if (known && segment.to !== replyDestination) {
      if (segment.text.trim()) addressed.push({ to: segment.to, body: segment.text.trim() });
      continue;
    }
    pieces.push(`\n\n${segment.text.trim()}\n\n`);
  }
  const body = pieces.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { body, addressed, internal, needsRouting: needsRouting && body.length > 0 };
}

/** Name of the destination the reply route maps to, if it is one. */
export function replyDestinationName(routing: RoutingContext): string | null {
  return findByRouting(routing.channelType, routing.platformId)?.name ?? null;
}

/** Only `<internal>` notes: the draft prompt's way of choosing to stay silent. */
export function isSilentDraft(draft: string): boolean {
  const parsed = parseAssistantOutput(draft);
  return parsed.internal.some((note) => note.trim()) && parsed.deliveries.length === 0 && !parsed.unwrapped.trim();
}

export function needsDeliveryTurn(draft: string, routing: RoutingContext): boolean {
  return splitDraft(draft, replyDestinationName(routing)).needsRouting;
}

interface TranscriptLine {
  at: number;
  text: string;
}

function parseJson(content: string): Record<string, unknown> {
  try {
    const value = JSON.parse(content) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function capMessage(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > TRANSCRIPT_MESSAGE_CAP_CHARS
    ? `${trimmed.slice(0, TRANSCRIPT_MESSAGE_CAP_CHARS)}… [truncated]`
    : trimmed;
}

/** Session DB timestamps are ISO or SQLite `datetime('now')` UTC without a zone. */
function dbTime(timestamp: string): number {
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(timestamp) ? timestamp : `${timestamp.replace(' ', 'T')}Z`);
}

function localTime(at: number): string {
  return Number.isFinite(at) ? formatLocalTime(new Date(at).toISOString(), TIMEZONE) : 'unknown time';
}

/** Recent visible messages on the reply route, newest last, within budget. */
export function buildTranscript(routing: RoutingContext, turnId: string, assistantName: string): string {
  const lines: TranscriptLine[] = [];
  const inbound = getInboundDb()
    .prepare(
      `SELECT id, kind, timestamp, content FROM messages_in
       WHERE kind IN ('chat', 'chat-sdk', 'task')
         AND channel_type IS ? AND platform_id IS ? AND thread_id IS ?
       ORDER BY seq DESC LIMIT 200`,
    )
    .all(routing.channelType, routing.platformId, routing.threadId) as {
    id: string;
    kind: string;
    timestamp: string;
    content: string;
  }[];
  for (const row of inbound) {
    const content = parseJson(row.content);
    const text = typeof content.text === 'string' ? content.text : typeof content.prompt === 'string' ? content.prompt : '';
    if (!text.trim()) continue;
    const author = content.author as { fullName?: string; userName?: string } | undefined;
    const sender =
      row.kind === 'task'
        ? 'Scheduled task'
        : String(content.sender || author?.fullName || author?.userName || 'Unknown');
    const at = dbTime(row.timestamp);
    const marker = row.id === routing.inReplyTo ? ' (this turn answers it)' : '';
    lines.push({ at, text: `[${localTime(at)}] ${sender}${marker}: ${capMessage(text)}` });
  }
  const outbound = getOutboundDb()
    .prepare(
      `SELECT kind, timestamp, content, turn_id FROM messages_out
       WHERE kind = 'chat' AND channel_type IS ? AND platform_id IS ? AND thread_id IS ?
       ORDER BY seq DESC LIMIT 200`,
    )
    .all(routing.channelType, routing.platformId, routing.threadId) as {
    kind: string;
    timestamp: string;
    content: string;
    turn_id: string | null;
  }[];
  for (const row of outbound) {
    const content = parseJson(row.content);
    const text = typeof content.text === 'string' ? content.text : '';
    if (!text.trim()) continue;
    const at = dbTime(row.timestamp);
    const marker = row.turn_id === turnId ? ' (sent this turn)' : '';
    lines.push({ at, text: `[${localTime(at)}] ${assistantName}${marker}: ${capMessage(text)}` });
  }
  lines.sort((a, b) => a.at - b.at);
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].text.length + 2;
    if (kept.length > 0 && used + cost > TRANSCRIPT_BUDGET_CHARS) break;
    kept.unshift(lines[i].text);
    used += cost;
  }
  return kept.join('\n\n');
}

interface SentRow {
  line: string;
  onRoute: boolean;
}

/** Content rows sent this turn to any destination (send_message, send_file). */
function sentRows(input: Pick<DeliveryInput, 'since' | 'turnId' | 'routing'>): SentRow[] {
  const rows = getOutboundDb()
    .prepare(
      `SELECT channel_type, platform_id, thread_id, content FROM messages_out
       WHERE seq > ? AND turn_id = ? AND kind = 'chat' ORDER BY seq`,
    )
    .all(input.since, input.turnId) as {
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
    content: string;
  }[];
  const sent: SentRow[] = [];
  for (const row of rows) {
    const content = parseJson(row.content);
    const text = typeof content.text === 'string' ? content.text.trim() : '';
    const files = Array.isArray(content.files) ? content.files.length : 0;
    if (!text && !files) continue;
    const to = findByRouting(row.channel_type, row.platform_id)?.name ?? 'unknown';
    const attachment = files ? ` [+${files} file${files === 1 ? '' : 's'}]` : '';
    sent.push({
      line: `To \`${to}\`${attachment}: ${capMessage(text)}`,
      onRoute:
        row.channel_type === input.routing.channelType &&
        row.platform_id === input.routing.platformId &&
        row.thread_id === input.routing.threadId,
    });
  }
  return sent;
}

export function sentThisTurn(input: Pick<DeliveryInput, 'since' | 'turnId' | 'routing'>): string[] {
  return sentRows(input).map((row) => row.line);
}

function describe(d: DestinationEntry): string {
  const kind = d.type === 'agent' ? 'peer agent' : `${d.channelType ?? 'channel'} channel`;
  const label = d.displayName && d.displayName !== d.name ? ` — ${d.displayName}` : '';
  return `\`${d.name}\` (${kind}${label})`;
}

function readPersona(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const DELIVERY_RULES = `You are the delivery step of an agent's turn. The agent has finished working and written a draft reply. You decide where it goes. You do not answer anything yourself and you have no tools.

Answer with directives only:
- \`<deliver to="name"/>\` — send the draft's reply text exactly as written. This is the normal answer: a draft that responds to the latest message goes to the conversation it came from.
- \`<message to="name">text</message>\` — send text you write instead. Use it only when the draft cannot be sent as written: it addresses someone else, it is plainly meant for a different destination, or it only points at content that is not in the draft ("see above", "summary below") and the real content is missing.
- \`<internal>reason</internal>\` — send nothing. Use it when the draft is notes to self, when everything it says was already sent this turn, or when the conversation should stay silent (for example, a scheduled check with nothing to report, or a one-way peer message that allows no reply).

Rules:
- Prefer \`<deliver/>\`. Never shorten, summarize, or restyle a draft that is fine as written; the agent's wording is final.
- Only use destination names from the list. Several directives may be combined, one per destination.
- Never send the same content twice: check what was already sent this turn.
- Output nothing but directives.`;

export function buildDeliveryPrompt(input: DeliveryInput, parts: DraftParts): CompletionRequest {
  const assistantName = input.assistantName || 'the agent';
  const replyTo = replyDestinationName(input.routing);
  const destinations = getAllDestinations();
  const persona = readPersona(input.personaPath ?? PERSONA_PATH);
  const system = [
    DELIVERY_RULES,
    `# The agent\n\nThe agent's name is **${assistantName}**. Its persona and working notes follow, for tone and preferences only — they do not change the rules above.`,
    persona ? `<persona>\n${persona}\n</persona>` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const destinationLines = destinations.length
    ? destinations.map((d) => `- ${describe(d)}${d.name === replyTo ? ' ← the latest message came from here' : ''}`)
    : ['- (none configured)'];
  const origin = replyTo
    ? `The latest message came from \`${replyTo}\`.`
    : input.routing.channelType === 'agent'
      ? 'The latest message came from a peer agent that allows no reply (reply_allowed="false").'
      : 'The latest message has no reply destination (for example, a scheduled task or system event).';
  const transcript = buildTranscript(input.routing, input.turnId, assistantName);
  const sent = sentThisTurn(input);
  const prompt = [
    `<destinations>\n${destinationLines.join('\n')}\n</destinations>`,
    origin,
    `<transcript>\n${transcript || '(no earlier messages)'}\n</transcript>`,
    `<sent_this_turn>\n${sent.length ? sent.join('\n\n') : '(nothing)'}\n</sent_this_turn>`,
    `<draft>\n${parts.body}\n</draft>`,
    'Where does the draft go?',
  ].join('\n\n');
  return { system, prompt, maxOutputTokens: MAX_OUTPUT_TOKENS };
}

type Directive = { kind: 'deliver'; to: string } | { kind: 'message'; to: string; body: string } | { kind: 'internal'; text: string };

const DELIVER_RE = /<deliver\s+to="([^"]+)"\s*\/?>(?:\s*<\/deliver\s*>)?/gi;

/** Parse the delivery turn's directives; null when it answered with anything else. */
export function parseDirectives(output: string): Directive[] | null {
  const directives: Directive[] = [];
  // Reasoning may quote directives it then rejects; only the answer counts.
  const answer = parseAssistantOutput(output).normalizedText;
  const withoutDeliver = answer.replace(DELIVER_RE, (_m, to: string) => {
    directives.push({ kind: 'deliver', to });
    return '';
  });
  const parsed = parseAssistantOutput(withoutDeliver);
  for (const segment of parsed.segments) {
    if (segment.kind === 'message') directives.push({ kind: 'message', to: segment.to, body: segment.text.trim() });
    else if (segment.kind === 'internal') directives.push({ kind: 'internal', text: segment.text.trim() });
  }
  if (parsed.unwrapped.trim()) log(`Ignoring non-directive output: ${parsed.unwrapped.trim().slice(0, 200)}`);
  return directives.length > 0 ? directives : null;
}

function block(to: string, body: string): string {
  return `<message to="${to}">${body}</message>`;
}

function internalBlock(text: string): string {
  return `<internal>${text.replace(/<\/internal\s*>/gi, '')}</internal>`;
}

function draftForTrace(body: string): string {
  return body.length > TRACE_DRAFT_CAP_CHARS ? `${body.slice(0, TRACE_DRAFT_CAP_CHARS)}… [truncated]` : body;
}

function passthrough(parts: DraftParts): string[] {
  return [...parts.internal.map(internalBlock), ...parts.addressed.map((a) => block(a.to, a.body))];
}

/** Map directives onto wrapped text; null when any directive is unusable. */
export function applyDirectives(
  directives: Directive[],
  parts: DraftParts,
  replyTo: string | null,
): Omit<DeliveryOutcome, 'usage'> | null {
  const out = passthrough(parts);
  let delivered = 0;
  let rewritten = false;
  const notes: string[] = [];
  for (const d of directives) {
    if (d.kind === 'internal') {
      if (d.text) notes.push(d.text);
      continue;
    }
    if (!findByName(d.to)) {
      log(`Unknown destination "${d.to}" in delivery directives`);
      return null;
    }
    if (d.kind === 'deliver') {
      out.push(block(d.to, parts.body));
      if (d.to !== replyTo) rewritten = true;
    } else {
      if (!d.body) continue;
      out.push(block(d.to, d.body));
      rewritten = true;
    }
    delivered++;
  }
  if (delivered === 0) {
    out.push(internalBlock(`Delivery step sent nothing${notes.length ? ` — ${notes.join(' ')}` : ''}. Draft:\n\n${draftForTrace(parts.body)}`));
    return { text: out.join('\n'), decision: 'skip', silent: true };
  }
  if (rewritten) {
    const summary = directives
      .filter((d): d is Exclude<Directive, { kind: 'internal' }> => d.kind !== 'internal')
      .map((d) => (d.kind === 'deliver' ? `draft → \`${d.to}\`` : `rewritten → \`${d.to}\``))
      .join(', ');
    out.unshift(internalBlock(`Delivery step routed the reply: ${summary}.${notes.length ? ` ${notes.join(' ')}` : ''}${directives.some((d) => d.kind === 'message') ? `\n\nOriginal draft:\n\n${draftForTrace(parts.body)}` : ''}`));
  }
  return { text: out.join('\n'), decision: rewritten ? 'message' : 'deliver', silent: false };
}

/** Deliver the draft to the reply route unless the turn already answered it there. */
export function fallbackDelivery(input: DeliveryInput, parts: DraftParts, reason: string): DeliveryOutcome {
  const replyTo = replyDestinationName(input.routing);
  const out = passthrough(parts);
  const alreadyAnswered = sentRows(input).some((row) => row.onRoute);
  if (replyTo && !alreadyAnswered) {
    out.push(block(replyTo, parts.body));
    return { text: out.join('\n'), decision: 'fallback', silent: false };
  }
  out.push(internalBlock(`Reply not delivered (${reason}). Draft:\n\n${draftForTrace(parts.body)}`));
  return { text: out.join('\n'), decision: 'fallback', silent: true };
}

/**
 * Route a draft. Returns null when the draft needs no routing and should be
 * dispatched unchanged.
 */
export async function runDeliveryTurn(
  complete: Complete,
  input: DeliveryInput,
  signal?: AbortSignal,
): Promise<DeliveryOutcome | null> {
  const replyTo = replyDestinationName(input.routing);
  const parts = splitDraft(input.draft, replyTo);
  if (!parts.needsRouting) return null;
  const startedAt = Date.now();
  let usage: CallUsage | undefined;
  let outcome: DeliveryOutcome;
  try {
    const request = buildDeliveryPrompt(input, parts);
    const result = await complete({ ...request, ...(signal ? { signal } : {}) });
    usage = result.usage;
    const directives = parseDirectives(result.text);
    const applied = directives ? applyDirectives(directives, parts, replyTo) : null;
    outcome = applied ?? fallbackDelivery(input, parts, 'delivery step answered without usable directives');
    if (!applied) log(`Unusable delivery output: ${result.text.slice(0, 300)}`);
  } catch (err) {
    if (signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log(`Delivery call failed: ${message}`);
    outcome = fallbackDelivery(input, parts, 'delivery step failed');
  }
  log(
    `decision=${outcome.decision} draft=${parts.body.length}ch out=${outcome.text.length}ch ` +
      `input=${usage?.input_tokens ?? 0} cached=${usage?.cache_read_tokens ?? 0} output=${usage?.output_tokens ?? 0} ` +
      `ms=${Date.now() - startedAt}`,
  );
  return { ...outcome, ...(usage ? { usage } : {}) };
}
