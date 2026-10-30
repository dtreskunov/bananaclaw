import { signal } from '@preact/signals';

export const approvalMessageDrafts = signal<Record<string, string>>({});

export function clearApprovalMessage(approvalId: string): void {
  const next = { ...approvalMessageDrafts.value };
  delete next[approvalId];
  approvalMessageDrafts.value = next;
}
