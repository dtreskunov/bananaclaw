import { jsonSchema, tool, type ToolSet } from 'ai';

export const NO_REPLY_TOOL = 'no_reply';

/** Sent as a transient user message, with no tools offered, once a turn hits the step limit. */
export const STEP_LIMIT_PROMPT =
  '<system>You have reached the step limit for this turn, so no more tools can run. Write your final message now: what you found or finished, what is still undone, and how to continue.</system>';

export function stepBudgetInstructions(maxSteps: number, stepsCompleted: number): string {
  const remaining = maxSteps - stepsCompleted;
  const budget = `Step budget: ${stepsCompleted} of ${maxSteps} steps used; ${remaining} remain before tools are disabled.`;
  if (remaining === 0) {
    return `## Turn budget\n\n${budget}\n\nTools are now disabled. Write your final message using only verified results: what you found or finished, what is still undone, and the concrete next step.`;
  }
  return `## Turn budget

You have at most ${maxSteps} model steps for this turn. A step may contain multiple tool calls. This is a hard ceiling, not a target. At the ceiling, tools are disabled and you get one final step to report progress.

Work toward a useful, verified result well before the ceiling. Batch repetitive reads or collection operations when safe, and avoid repeatedly checking unchanged state. If an approach makes little progress, change strategy rather than continuing the same loop.

Reserve the last 10 steps for saving durable results, validating them, and preparing a clear handoff. If the full request cannot fit, complete a coherent portion and report what is verified, what remains, and the concrete next step. Do not claim completion without verification.

${budget}${remaining <= 10 ? '\n\nOnly a few steps remain. Stop expanding scope; prioritize saving and verifying the current portion, then give a clear handoff.' : ''}`;
}

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
