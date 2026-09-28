import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTranscriptContent, transcriptClipboardPayload } from './transcript-clipboard';

afterEach(() => {
  vi.unstubAllGlobals();
});

function transcriptElement(): HTMLElement {
  return {
    innerHTML: '<p>Hello <strong>world</strong></p>',
    innerText: 'Hello world',
    textContent: 'Hello world',
  } as HTMLElement;
}

describe('transcript clipboard', () => {
  it('builds rich and plain payloads from rendered message content', () => {
    expect(transcriptClipboardPayload(transcriptElement())).toEqual({
      html: '<div><p>Hello <strong>world</strong></p></div>',
      text: 'Hello world',
    });
  });

  it('writes HTML and plain text clipboard formats together', async () => {
    class FakeClipboardItem {
      constructor(readonly data: Record<string, Blob>) {}
    }
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write } });

    await expect(copyTranscriptContent(transcriptElement())).resolves.toBe('rich');
    const item = write.mock.calls[0]![0][0] as FakeClipboardItem;
    expect(await item.data['text/html']!.text()).toBe('<div><p>Hello <strong>world</strong></p></div>');
    expect(await item.data['text/plain']!.text()).toBe('Hello world');
  });

  it('falls back to plain text when rich clipboard items are unsupported', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyTranscriptContent(transcriptElement())).resolves.toBe('plain');
    expect(writeText).toHaveBeenCalledWith('Hello world');
  });

  it('falls back to plain text when a supported rich write is rejected', async () => {
    class FakeClipboardItem {
      constructor(readonly data: Record<string, Blob>) {}
    }
    const write = vi.fn().mockRejectedValue(new DOMException('Rich formats denied', 'NotAllowedError'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write, writeText } });

    await expect(copyTranscriptContent(transcriptElement())).resolves.toBe('plain');
    expect(writeText).toHaveBeenCalledWith('Hello world');
  });

  it('reports both failures when rich and plain clipboard writes are rejected', async () => {
    class FakeClipboardItem {
      constructor(readonly data: Record<string, Blob>) {}
    }
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', {
      clipboard: {
        write: vi.fn().mockRejectedValue(new DOMException('Rich formats denied', 'NotAllowedError')),
        writeText: vi.fn().mockRejectedValue(new DOMException('Clipboard denied', 'NotAllowedError')),
      },
    });

    await expect(copyTranscriptContent(transcriptElement())).rejects.toThrow(
      'Rich and plain-text clipboard writes failed.',
    );
  });
});
