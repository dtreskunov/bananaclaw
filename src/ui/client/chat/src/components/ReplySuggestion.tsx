import { EditIcon } from './ActionIcons';
import './ReplySuggestion.css';

interface Props {
  label: string;
  labelHtml?: string;
  disabled: boolean;
  sendDisabled: boolean;
  onChoose: (draft: string) => void;
  onSend: (draft: string) => void;
}

export function ReplySuggestion({ label, labelHtml, disabled, sendDisabled, onChoose, onSend }: Props) {
  return (
    <span class="reply-suggestion">
      <button
        type="button"
        class="reply-suggestion-label"
        aria-label={`Send suggestion: ${label}`}
        aria-description="Send this reply immediately"
        disabled={sendDisabled}
        onClick={(event) => {
          event.stopPropagation();
          if (!sendDisabled) onSend(label);
        }}
        {...(labelHtml === undefined ? { children: label } : { dangerouslySetInnerHTML: { __html: labelHtml } })}
      />
      <button
        type="button"
        class="msg-action-btn reply-suggestion-edit"
        title="Edit suggestion"
        aria-label={`Edit suggestion: ${label}`}
        aria-description="Fill the composer with this reply without sending"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          if (!disabled) onChoose(label);
        }}
      >
        <EditIcon />
      </button>
    </span>
  );
}
