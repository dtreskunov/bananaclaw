import type { QuestionInput, QuestionOption } from '../ui/shared/question.js';

/**
 * Shared ask_question payload schema + normalization.
 *
 * Producers (host-side approvals, container-side ask_user_question MCP tool)
 * emit an `ask_question` payload. Options may be bare strings for ergonomics,
 * but are normalized here into a consistent shape before delivery, persistence,
 * and rendering.
 */

export interface OptionInput {
  label: string;
  selectedLabel?: string;
  value?: string;
}

export type RawOption = string | OptionInput;

export type NormalizedOption = QuestionOption;

export function normalizeOption(raw: RawOption): NormalizedOption {
  if (typeof raw === 'string') {
    return { label: raw, selectedLabel: raw, value: raw };
  }
  const label = raw.label;
  return {
    label,
    selectedLabel: raw.selectedLabel ?? label,
    value: raw.value ?? label,
  };
}

export function normalizeOptions(raws: RawOption[]): NormalizedOption[] {
  return raws.map(normalizeOption);
}

export interface AskQuestionPayload extends QuestionInput {
  type: 'ask_question';
  questionId: string;
}

export function formatQuestionResponse(question: string, response: string): string {
  const quote = question
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  return `${quote}\n\n${response}`;
}
