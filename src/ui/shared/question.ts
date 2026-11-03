export interface QuestionOption {
  label: string;
  selectedLabel: string;
  value: string;
}

export interface QuestionInput {
  question: string;
  responseMode: 'choice' | 'text' | 'choice_or_text';
  options: QuestionOption[];
  placeholder?: string;
  multiline?: boolean;
}

export type QuestionResponse =
  | { responseType: 'choice' | 'text'; value: string }
  | { responseType: 'skipped'; value?: never };

export function questionAcceptsResponse(
  mode: QuestionInput['responseMode'],
  options: QuestionOption[],
  response: QuestionResponse,
): boolean {
  return (
    response.responseType === 'skipped' ||
    (response.responseType === 'choice'
      ? mode !== 'text' && options.some((option) => option.value === response.value)
      : mode !== 'choice')
  );
}
