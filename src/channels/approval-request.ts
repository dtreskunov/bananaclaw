export interface OptionInput {
  label: string;
  selectedLabel?: string;
  value?: string;
}

export type RawOption = string | OptionInput;

export interface NormalizedOption {
  label: string;
  selectedLabel: string;
  value: string;
}

export function normalizeOption(raw: RawOption): NormalizedOption {
  if (typeof raw === 'string') {
    return { label: raw, selectedLabel: raw, value: raw };
  }
  return {
    label: raw.label,
    selectedLabel: raw.selectedLabel ?? raw.label,
    value: raw.value ?? raw.label,
  };
}

export function normalizeOptions(raws: RawOption[]): NormalizedOption[] {
  return raws.map(normalizeOption);
}

export interface ApprovalRequestPayload {
  type: 'approval_request';
  approvalId: string;
  title: string;
  body: string;
  options: NormalizedOption[];
}

export const USER_APPROVAL_TITLE = '👤 New user wants access';
export const USER_APPROVAL_OPTIONS = normalizeOptions([
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
]);

/** Only canonical indexed callbacks may resolve a persisted approval option. */
export function resolveApprovalAction(
  actionId: string,
  lookup: (approvalId: string) => { title: string; options: NormalizedOption[] } | undefined,
): { approvalId: string; title: string; option: NormalizedOption } | undefined {
  const match = /^nca:([^:]+):(0|[1-9]\d*)$/.exec(actionId);
  if (!match) return;
  const render = lookup(match[1]);
  const index = Number(match[2]);
  if (!render || !Number.isSafeInteger(index) || !render.options[index]) return;
  return { approvalId: match[1], title: render.title, option: render.options[index] };
}
