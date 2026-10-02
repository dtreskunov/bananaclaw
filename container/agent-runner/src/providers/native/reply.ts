import { jsonSchema, tool, type ToolSet } from 'ai';

export const NO_REPLY_TOOL = 'no_reply';

/** Sent as a transient user message when a final message only points at undelivered text. */
export const POINTER_REPLY_PROMPT =
  '<system>That message was not sent: it refers to text the user cannot see. Only your final message is delivered; text written alongside tool calls is not. Write the complete message itself.</system>';

/** Sent as a transient user message, with no tools offered, once a turn hits the step limit. */
export const STEP_LIMIT_PROMPT =
  '<system>You have reached the step limit for this turn, so no more tools can run. Write your final message now: what you found or finished, what is still undone, and how to continue.</system>';

const POINTER_MAX_CHARS = 300;
const POINTER_MIN_UNDELIVERED_CHARS = 400;
const POINTER_PATTERN = /\b(?:above|earlier|previous (?:message|response|reply))\b/i;

/** `no_reply` ends the turn without sending anything; the step loop reads its reason. */
export const NO_REPLY_TOOLS: ToolSet = {
  [NO_REPLY_TOOL]: tool({
    description:
      'End your turn without sending anything, for example a scheduled check that found nothing worth reporting, or when everything was already delivered with send_message or send_file. Never use it to skip answering a person.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why nothing is sent. Shown only in the activity trace.' } },
      required: ['reason'],
    }),
    execute: async () => 'Ending the turn without a reply.',
  }),
};

export function noReplyReason(input: unknown): string {
  return String((input as { reason?: unknown } | null)?.reason ?? '').trim() || 'No reply needed.';
}

/** True when a short final message only points at text the user never received. */
export function isPointerReply(text: string, undeliveredChars: number): boolean {
  return (
    undeliveredChars >= POINTER_MIN_UNDELIVERED_CHARS &&
    text.trim().length <= POINTER_MAX_CHARS &&
    POINTER_PATTERN.test(text)
  );
}
