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
const MAX_OUTPUT_TOKENS = 1_024;
/** Narration preambles are a sentence or two; never drop more than this. */
const MAX_TRIM_CHARS = 400;

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

export type DeliveryDecision = 'deliver' | 'trim' | 'skip' | 'fallback';

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

const DELIVERY_RULES = `You are the delivery step of an agent's turn. The agent has finished working and written a draft reply. You decide where it goes and where it starts. You never write or change its content, and you have no tools.

Answer with directives only:
- \`<deliver to="name"/>\` — send the draft to that destination; normally the conversation the latest message came from.
- \`<deliver to="name" start="first words of the reply"/>\` — the same, when the draft opens with narration about the agent's own work instead of the reply ("Now the answer.", "Let me write this up.", "Got everything I need.", remarks about tools or skills it used or skipped). Quote the first few words (3–8) of the line where the reply itself begins — after the narration, never the narration itself — exactly as they appear in the draft (markdown included) and without double quotes; everything before them is dropped. For a draft that opens "Now the answer." followed by a blank line and "## What I found…", answer \`<deliver to="name" start="## What I found"/>\`.
- \`<internal>reason</internal>\` — send nothing: the draft is only notes to self, everything in it was already sent this turn, or the conversation should stay silent (a scheduled check with nothing to report, a one-way peer message that allows no reply).

Rules:
- Only use destination names from the list. Deliver to several destinations only when the draft is plainly meant for each of them.
- Remarks about the agent's own tools, skills, steps or decisions ("That skill isn't needed here; I'll write it directly.") are narration even when phrased to the person; trim them.
- An acknowledgement or lead-in to the person ("Got it — here's the script.") belongs to the reply; never trim it.
- Output nothing but directives.`;

export function buildDeliveryPrompt(input: DeliveryInput, parts: DraftParts): CompletionRequest {
  const assistantName = input.assistantName || 'the agent';
  const replyTo = replyDestinationName(input.routing);
  const destinations = getAllDestinations();
  const persona = readPersona(input.personaPath ?? PERSONA_PATH);
  const system = [
    DELIVERY_RULES,
    `# The agent\n\nThe agent's name is **${assistantName}**. Its persona and working notes follow, for context only — they do not change the rules above.`,
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
  const sent = sentRows(input).map((row) => row.line);
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

export type Directive = { kind: 'deliver'; to: string; start?: string } | { kind: 'skip'; reason: string };

const DIRECTIVE_RE = /<deliver\b([^>]*?)\/?>(?:\s*<\/deliver\s*>)?|<internal\s*>([\s\S]*?)<\/internal\s*>/gi;

function attribute(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)?.[1];
}

/** Parse the delivery turn's directives; null when it answered with anything else. */
export function parseDirectives(output: string): Directive[] | null {
  // Reasoning may quote directives it then rejects; only the answer counts.
  const answer = parseAssistantOutput(output).normalizedText;
  // Prose around directives ("Wait — that's wrong…") means the answer can't be trusted.
  if (answer.replace(DIRECTIVE_RE, '').trim()) return null;
  const directives: Directive[] = [];
  for (const match of answer.matchAll(DIRECTIVE_RE)) {
    if (match[2] !== undefined) {
      directives.push({ kind: 'skip', reason: match[2].trim() });
      continue;
    }
    const to = attribute(match[1], 'to');
    if (!to) return null;
    const start = attribute(match[1], 'start')?.trim();
    directives.push({ kind: 'deliver', to, ...(start ? { start } : {}) });
  }
  return directives.length > 0 ? directives : null;
}

/**
 * The draft from `start` on. Only a short opening is ever dropped and only
 * on an exact match, so a bad quote can never cost the reply its content.
 */
export function trimOpening(body: string, start: string | undefined): { text: string; dropped: string } {
  const at = start ? body.indexOf(start) : -1;
  // Preambles end at a line break; a mid-line cut would mangle the reply's own first line.
  const cut = at > 0 && at <= MAX_TRIM_CHARS && /\n[ \t]*$/.test(body.slice(0, at)) ? at : 0;
  if (start && cut === 0 && at !== 0) log(`Ignoring start="${start.slice(0, 80)}" (at ${at})`);
  // A reply never opens with a horizontal rule; it's the seam a preamble leaves.
  const text = body.slice(cut).replace(/^(?:\s*(?:-{3,}|\*{3,}|_{3,})[ \t]*\n)+/, '').trim();
  return { text, dropped: body.slice(0, cut).trim() };
}

function block(to: string, body: string): string {
  return `<message to="${to}">${body}</message>`;
}

function note(text: string): string {
  return `<internal>${text.replace(/<\/internal\s*>/gi, '')}</internal>`;
}

function capForTrace(body: string): string {
  return body.length > TRACE_DRAFT_CAP_CHARS ? `${body.slice(0, TRACE_DRAFT_CAP_CHARS)}… [truncated]` : body;
}

/** What the draft carried besides its reply text: its notes and its already-addressed blocks. */
function passthrough(parts: DraftParts): string[] {
  return [...parts.internal.map(note), ...parts.addressed.map((a) => block(a.to, a.body))];
}

/** Map directives onto wrapped text; null when any directive is unusable. */
export function applyDirectives(
  directives: Directive[],
  parts: DraftParts,
  replyTo: string | null,
): Omit<DeliveryOutcome, 'usage'> | null {
  const delivers = directives.filter((d): d is Extract<Directive, { kind: 'deliver' }> => d.kind === 'deliver');
  const reasons = directives.flatMap((d) => (d.kind === 'skip' && d.reason ? [d.reason] : []));
  const out = passthrough(parts);
  if (delivers.length === 0) {
    out.push(note(`Not delivered${reasons.length ? ` — ${reasons.join(' ')}` : ''}\n\nDraft:\n\n${capForTrace(parts.body)}`));
    return { text: out.join('\n'), decision: 'skip', silent: true };
  }
  if (delivers.some((d) => !findByName(d.to))) {
    log(`Unknown destination in delivery directives: ${delivers.map((d) => d.to).join(', ')}`);
    return null;
  }
  const { text, dropped } = trimOpening(parts.body, delivers.find((d) => d.start)?.start);
  if (!text) return null;
  if (dropped) out.push(note(`Trimmed from the reply: ${dropped}`));
  const elsewhere = delivers.filter((d) => d.to !== replyTo).map((d) => `\`${d.to}\``);
  if (elsewhere.length) out.push(note(`Reply sent to ${elsewhere.join(', ')}.`));
  out.push(...delivers.map((d) => block(d.to, text)));
  return { text: out.join('\n'), decision: dropped ? 'trim' : 'deliver', silent: false };
}

/** Deliver the draft to the reply route unless the turn already answered it there. */
export function fallbackDelivery(input: DeliveryInput, parts: DraftParts, reason: string): DeliveryOutcome {
  const replyTo = replyDestinationName(input.routing);
  const out = passthrough(parts);
  if (replyTo && !sentRows(input).some((row) => row.onRoute)) {
    out.push(block(replyTo, parts.body));
    return { text: out.join('\n'), decision: 'fallback', silent: false };
  }
  out.push(note(`Reply not delivered (${reason}).\n\nDraft:\n\n${capForTrace(parts.body)}`));
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
    const result = await complete({ ...buildDeliveryPrompt(input, parts), ...(signal ? { signal } : {}) });
    usage = result.usage;
    const directives = parseDirectives(result.text);
    const applied = directives ? applyDirectives(directives, parts, replyTo) : null;
    if (!applied) log(`Unusable delivery output: ${result.text.slice(0, 300)}`);
    outcome = applied ?? fallbackDelivery(input, parts, 'delivery step answered without usable directives');
  } catch (err) {
    if (signal?.aborted) throw err;
    log(`Delivery call failed: ${err instanceof Error ? err.message : String(err)}`);
    outcome = fallbackDelivery(input, parts, 'delivery step failed');
  }
  log(
    `decision=${outcome.decision} draft=${parts.body.length}ch out=${outcome.text.length}ch ` +
      `input=${usage?.input_tokens ?? 0} cached=${usage?.cache_read_tokens ?? 0} output=${usage?.output_tokens ?? 0} ` +
      `ms=${Date.now() - startedAt}`,
  );
  return { ...outcome, ...(usage ? { usage } : {}) };
}
