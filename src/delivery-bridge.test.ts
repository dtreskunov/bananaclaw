import { describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, OutboundFile, OutboundMessage } from './channels/adapter.js';
import { createDeliveryBridge } from './delivery-bridge.js';

function mkFile(name: string): OutboundFile {
  return { filename: name, data: Buffer.from(name) };
}

function stubAdapter(opts: { supportsMultiFile?: boolean; idPrefix?: string }): {
  adapter: ChannelAdapter;
  calls: Array<{ platformId: string; threadId: string | null; message: OutboundMessage }>;
} {
  const calls: Array<{ platformId: string; threadId: string | null; message: OutboundMessage }> = [];
  let counter = 0;
  const adapter = {
    name: 'mock',
    channelType: 'mock',
    supportsThreads: false,
    supportsMultiFile: opts.supportsMultiFile,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver(platformId: string, threadId: string | null, message: OutboundMessage) {
      calls.push({ platformId, threadId, message });
      counter += 1;
      return `${opts.idPrefix ?? 'mid'}-${counter}`;
    },
  } as unknown as ChannelAdapter;
  return { adapter, calls };
}

describe('createDeliveryBridge', () => {
  it('passes through single-file messages unchanged', async () => {
    const { adapter, calls } = stubAdapter({ supportsMultiFile: false });
    const bridge = createDeliveryBridge({ getChannelAdapter: () => adapter });
    const files = [mkFile('only.mp3')];
    const id = await bridge.deliver('mock', 'plat-1', null, 'chat', JSON.stringify({ text: 'hi' }), files);
    expect(id).toBe('mid-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].message.files).toHaveLength(1);
    expect((calls[0].message.content as { text: string }).text).toBe('hi');
  });

  it('splits multi-file messages into N single-file calls when the adapter does not support multi', async () => {
    const { adapter, calls } = stubAdapter({ supportsMultiFile: false });
    const bridge = createDeliveryBridge({ getChannelAdapter: () => adapter });
    const files = [mkFile('a.mp3'), mkFile('b.mp3'), mkFile('c.mp3')];
    const id = await bridge.deliver(
      'mock',
      'plat-1',
      'thread-1',
      'chat',
      JSON.stringify({ text: 'three songs' }),
      files,
    );

    expect(id).toBe('mid-1');
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.message.files?.[0]?.filename)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
    // Text rides on the first call only
    expect((calls[0].message.content as { text: string }).text).toBe('three songs');
    expect((calls[1].message.content as { text: string }).text).toBe('');
    expect((calls[2].message.content as { text: string }).text).toBe('');
    // Routing identical across splits
    for (const c of calls) {
      expect(c.platformId).toBe('plat-1');
      expect(c.threadId).toBe('thread-1');
    }
  });

  it('does not split when the adapter declares supportsMultiFile=true', async () => {
    const { adapter, calls } = stubAdapter({ supportsMultiFile: true });
    const bridge = createDeliveryBridge({ getChannelAdapter: () => adapter });
    const files = [mkFile('a.pdf'), mkFile('b.pdf')];
    await bridge.deliver('mock', 'plat-1', null, 'chat', JSON.stringify({ text: 'two files' }), files);
    expect(calls).toHaveLength(1);
    expect(calls[0].message.files).toHaveLength(2);
  });

  it('returns undefined and warns when no adapter is registered', async () => {
    const bridge = createDeliveryBridge({ getChannelAdapter: () => undefined });
    const id = await bridge.deliver('missing', 'plat-1', null, 'chat', JSON.stringify({ text: 'x' }), undefined);
    expect(id).toBeUndefined();
  });

  it('uses markdown alongside text when clearing on splits', async () => {
    const { adapter, calls } = stubAdapter({ supportsMultiFile: false });
    const bridge = createDeliveryBridge({ getChannelAdapter: () => adapter });
    const files = [mkFile('a.png'), mkFile('b.png')];
    await bridge.deliver('mock', 'plat-1', null, 'chat', JSON.stringify({ markdown: '**hi**', text: 'hi' }), files);
    expect(calls).toHaveLength(2);
    const first = calls[0].message.content as { markdown?: string; text?: string };
    const second = calls[1].message.content as { markdown?: string; text?: string };
    expect(first.markdown).toBe('**hi**');
    expect(first.text).toBe('hi');
    expect(second.markdown).toBe('');
    expect(second.text).toBe('');
  });

  it('forwards setTyping to the adapter when available', async () => {
    const { adapter } = stubAdapter({ supportsMultiFile: false });
    const setTyping = vi.fn().mockResolvedValue(undefined);
    (adapter as unknown as { setTyping: typeof setTyping }).setTyping = setTyping;
    const bridge = createDeliveryBridge({ getChannelAdapter: () => adapter });
    await bridge.setTyping('mock', 'plat-1', 'thread-1');
    expect(setTyping).toHaveBeenCalledWith('plat-1', 'thread-1', undefined, undefined);
  });
});
