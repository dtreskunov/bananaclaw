import { copyTranscriptContent } from '../transcript-clipboard';
import { CopyIcon } from './ActionIcons';
import { showToast } from './Toast';

export function CopyTranscriptButton({ getContent }: { getContent: () => HTMLElement | null }) {
  const copy = async (): Promise<void> => {
    const content = getContent();
    if (!content) {
      console.error('Failed to copy transcript message: message content is unavailable.');
      showToast('Could not copy message');
      return;
    }
    try {
      await copyTranscriptContent(content);
      showToast('Copied message');
    } catch (error) {
      console.error('Failed to copy transcript message:', error);
      showToast('Could not copy message');
    }
  };

  return (
    <button
      type="button"
      class="msg-action-btn msg-copy-btn"
      title="Copy this message"
      aria-label="Copy this message"
      onClick={copy}
    >
      <CopyIcon />
    </button>
  );
}
