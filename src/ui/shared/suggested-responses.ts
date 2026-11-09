export const MAX_SUGGESTED_RESPONSES = 6;
export const MAX_SUGGESTED_RESPONSE_LENGTH = 240;

export function isSuggestedResponses(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_SUGGESTED_RESPONSES &&
    value.every((text) => typeof text === 'string' && !!text.trim() && text.length <= MAX_SUGGESTED_RESPONSE_LENGTH) &&
    new Set(value).size === value.length
  );
}

export function parseSuggestedResponses(value: string): string[] {
  const responses: unknown = JSON.parse(value);
  if (!isSuggestedResponses(responses)) throw new Error('Invalid response suggestions');
  return responses;
}
