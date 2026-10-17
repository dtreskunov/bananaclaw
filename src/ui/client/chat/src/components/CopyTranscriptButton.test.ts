import { afterEach, describe, expect, it, vi } from 'vitest';
import { toastMessage } from '../state';
import { dismissToast } from './Toast';
import { CopyTranscriptButton } from './CopyTranscriptButton';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (toastMessage.value) dismissToast();
});

function transcriptElement(): HTMLElement {
  return {
    innerHTML: '<p>Hello world</p>',
    innerText: 'Hello world',
    textContent: 'Hello world',
  } as HTMLElement;
}

describe('copy transcript button', () => {
  it('copies from the supplied message content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const button = CopyTranscriptButton({ getContent: transcriptElement });

    await button.props.onClick();

    expect(writeText).toHaveBeenCalledWith('Hello world');
    expect(toastMessage.value).toMatchObject({ text: 'Copied message', kind: 'ok' });
  });

  it('shows copy failures as transient feedback', async () => {
    vi.stubGlobal('navigator', {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const button = CopyTranscriptButton({ getContent: transcriptElement });

    await button.props.onClick();

    expect(toastMessage.value).toMatchObject({ text: 'Could not copy message', kind: 'ok' });
    consoleError.mockRestore();
  });

  it('can label the reader action and report feedback inside the modal', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onFeedback = vi.fn();
    const button = CopyTranscriptButton({ getContent: transcriptElement, label: 'Copy message', onFeedback });
    await button.props.onClick();
    expect(button.props['aria-label']).toBe('Copy message');
    expect(onFeedback).toHaveBeenCalledWith('Copied message');
    expect(toastMessage.value).toBeNull();
  });

  it('reports unavailable reader content explicitly', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onFeedback = vi.fn();
    await CopyTranscriptButton({ getContent: () => null, onFeedback }).props.onClick();
    expect(consoleError).toHaveBeenCalled();
    expect(onFeedback).toHaveBeenCalledWith('Could not copy message');
    consoleError.mockRestore();
  });
});
