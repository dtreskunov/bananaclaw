import './ApprovalMessageInput.css';
import { MAX_APPROVAL_MESSAGE_LENGTH } from '../../../../shared/approval-message';
import { approvalMessageDrafts } from '../approval-messages';

export function ApprovalMessageInput({ approvalId, disabled }: { approvalId: string; disabled: boolean }) {
  return <div class="approval-response-message">
    <label>Message to agent (optional)
      <textarea aria-label="Message to agent" rows={2} maxLength={MAX_APPROVAL_MESSAGE_LENGTH}
        disabled={disabled} value={approvalMessageDrafts.value[approvalId] ?? ''}
        onInput={event => {
          approvalMessageDrafts.value = { ...approvalMessageDrafts.value, [approvalId]: event.currentTarget.value };
        }} />
    </label>
    <small class="muted">Included with the decision. Don't include passwords or tokens.</small>
  </div>;
}
