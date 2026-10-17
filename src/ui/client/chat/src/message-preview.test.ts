import { afterEach, describe, expect, it, vi } from 'vitest';
import { messagePreviewLayout, observeMessagePreview } from './message-preview';

afterEach(() => vi.unstubAllGlobals());

describe('message preview sizing', () => {
  it.each([299, 300])('leaves a %ipx body unchanged when it fits exactly or below the limit', (height) => {
    expect(messagePreviewLayout(height, 400, 100, 38)).toEqual({ truncated: false, height });
  });

  it('reserves message metadata and the reader control without shrinking the full body', () => {
    expect(messagePreviewLayout(500, 400, 100, 38)).toEqual({ truncated: true, height: 262 });
  });

  it('does not oscillate near the threshold when the reader control appears', () => {
    expect(messagePreviewLayout(301, 400, 100, 0)).toEqual({ truncated: true, height: 300 });
    expect(messagePreviewLayout(301, 400, 100, 38)).toEqual({ truncated: true, height: 262 });
    expect(messagePreviewLayout(300, 400, 100, 38)).toEqual({ truncated: false, height: 300 });
  });

  it('clamps tight layouts and ignores a temporarily hidden transcript', () => {
    expect(messagePreviewLayout(500, 40, 100, 38)).toEqual({ truncated: true, height: 0 });
    expect(messagePreviewLayout(500, 0, 100, 38)).toEqual({ truncated: false, height: 500 });
  });
});

describe('message preview observation', () => {
  it('remeasures viewport, content and metadata changes and disconnects on unmount', () => {
    let measure: () => void = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          measure = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    let viewportHeight = 500;
    let bodyHeight = 700;
    let clipHeight = 700;
    let controlHeight = 0;
    let bubbleHeight = 744;
    const viewport = { getBoundingClientRect: () => ({ height: viewportHeight }) } as HTMLElement;
    const content = { getBoundingClientRect: () => ({ height: bodyHeight }) } as HTMLElement;
    const clip = { getBoundingClientRect: () => ({ height: clipHeight }) } as HTMLElement;
    const control = { getBoundingClientRect: () => ({ height: controlHeight }) } as HTMLElement;
    const bubble = { getBoundingClientRect: () => ({ height: bubbleHeight }) } as HTMLElement;
    const parts: Record<string, HTMLElement> = {
      '.log': viewport,
      '.msg': bubble,
      '.message-preview-content': content,
      '.message-preview-clip': clip,
      '.message-preview-control': control,
    };
    const preview = {
      closest: (selector: string) => parts[selector],
      querySelector: (selector: string) => parts[selector],
    } as HTMLElement;
    vi.stubGlobal('getComputedStyle', (_: HTMLElement, pseudo?: string) =>
      pseudo ? { height: '10px' } : { rowGap: '6px', paddingTop: '0px', paddingBottom: '0px' },
    );
    const update = vi.fn();
    const dispose = observeMessagePreview(preview, update);
    expect(update).toHaveBeenLastCalledWith({ truncated: true, height: 424 });
    expect(observe.mock.calls.map(([element]) => element)).toEqual([viewport, bubble, content, control]);

    controlHeight = 38;
    clipHeight = 386;
    bubbleHeight = 468;
    measure();
    expect(update).toHaveBeenLastCalledWith({ truncated: true, height: 386 });

    viewportHeight = 400;
    measure();
    expect(update).toHaveBeenLastCalledWith({ truncated: true, height: 286 });

    bodyHeight = 100;
    measure();
    expect(update).toHaveBeenLastCalledWith({ truncated: false, height: 100 });
    dispose();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('reports malformed preview markup instead of silently hiding the reader control', () => {
    const preview = { closest: () => null, querySelector: () => null };
    expect(() => observeMessagePreview(preview, vi.fn())).toThrow('Message preview is missing');
  });
});
