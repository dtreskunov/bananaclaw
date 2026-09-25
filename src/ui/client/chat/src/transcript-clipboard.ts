export interface TranscriptClipboardPayload {
  html: string;
  text: string;
}

export function transcriptClipboardPayload(element: HTMLElement): TranscriptClipboardPayload {
  return {
    html: `<div>${element.innerHTML}</div>`,
    text: element.innerText || element.textContent || '',
  };
}

export async function copyTranscriptContent(element: HTMLElement): Promise<'rich' | 'plain'> {
  const payload = transcriptClipboardPayload(element);
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error('Clipboard access is unavailable in this browser.');

  if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
    await clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([payload.html], { type: 'text/html' }),
        'text/plain': new Blob([payload.text], { type: 'text/plain' }),
      }),
    ]);
    return 'rich';
  }

  if (typeof clipboard.writeText !== 'function') {
    throw new Error('Clipboard writing is unavailable in this browser.');
  }
  await clipboard.writeText(payload.text);
  return 'plain';
}
