import { copyTranscriptContent } from '../transcript-clipboard';
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
      <svg class="msg-copy-icon" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
      </svg>
    </button>
  );
}
