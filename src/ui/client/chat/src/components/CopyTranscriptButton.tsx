import { copyTranscriptContent } from '../transcript-clipboard';
import { CopyIcon } from './ActionIcons';
import { showToast } from './Toast';

export function CopyTranscriptButton({ getContent, label, onFeedback }: {
  getContent: () => HTMLElement | null;
  label?: string;
  onFeedback?: (message: string) => void;
}) {
  const feedback = onFeedback ?? showToast;
  const copy = async (): Promise<void> => {
    const content = getContent();
    if (!content) {
      console.error('Failed to copy transcript message: message content is unavailable.');
      feedback('Could not copy message');
      return;
    }
    try {
      await copyTranscriptContent(content);
      feedback('Copied message');
    } catch (error) {
      console.error('Failed to copy transcript message:', error);
      feedback('Could not copy message');
    }
  };

  return (
    <button
      type="button"
      class="msg-action-btn msg-copy-btn"
      title={label ?? 'Copy this message'}
      aria-label={label ?? 'Copy this message'}
      onClick={copy}
    >
      <CopyIcon />
      {label ? <span>{label}</span> : null}
    </button>
  );
}
