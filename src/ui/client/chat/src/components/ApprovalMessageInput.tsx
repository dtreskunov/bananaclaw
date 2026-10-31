import './ApprovalMessageInput.css';
import { MAX_APPROVAL_MESSAGE_LENGTH } from '../../../../shared/approval-message';
import { approvalMessageDrafts } from '../approval-messages';
import { useRef } from 'preact/hooks';
import { ComposerInput, useComposerTextarea } from './ComposerInput';

export function ApprovalMessageInput({ approvalId, disabled }: { approvalId: string; disabled: boolean }) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const value = approvalMessageDrafts.value[approvalId] ?? '';
  const { autosize, multiLine } = useComposerTextarea(inputRef,value);
  return <div class="approval-response-message">
    <span class="approval-message-label">Message to agent (optional)</span>
    <ComposerInput inputRef={inputRef} multiLine={multiLine} listening={false}
      className="approval-message-composer"
      textarea={{
        'aria-label': 'Message to agent', placeholder: 'Optional message',
        maxLength: MAX_APPROVAL_MESSAGE_LENGTH, disabled, value,
        onInput: event => {
          approvalMessageDrafts.value = { ...approvalMessageDrafts.value, [approvalId]: event.currentTarget.value };
          autosize();
        },
      }} />
  </div>;
}
