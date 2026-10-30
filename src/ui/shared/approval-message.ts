export const MAX_APPROVAL_MESSAGE_LENGTH = 4000;

export interface ApprovalResponseMessage {
  userId: string;
  message: string;
}

export class ApprovalMessageError extends Error {}

export function parseApprovalMessage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ApprovalMessageError('Approval message must be text.');
  if (value.length > MAX_APPROVAL_MESSAGE_LENGTH)
    throw new ApprovalMessageError(`Approval message must be at most ${MAX_APPROVAL_MESSAGE_LENGTH} characters.`);
  return value.trim() || undefined;
}
