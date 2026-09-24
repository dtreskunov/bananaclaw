import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function worklet(rate: number) {
  let Processor: new () => {
    process(inputs: Float32Array[][]): boolean;
    port: { onmessage: (event: { data: string }) => void };
  };
  const messages: Array<ArrayBuffer | string> = [];
  vm.runInNewContext(fs.readFileSync(new URL('./chat/voice-worklet.js', import.meta.url), 'utf8'), {
    sampleRate: rate,
    AudioWorkletProcessor: class {
      port = { postMessage: (message: ArrayBuffer | string) => messages.push(message), onmessage: null };
    },
    registerProcessor: (_name: string, ctor: typeof Processor) => {
      Processor = ctor;
    },
    ArrayBuffer,
    DataView,
  });
  return { processor: new Processor!(), messages };
}

describe('voice PCM worklet', () => {
  it.each([16000, 44100, 48000])(
    'emits 16kHz mono s16le at %i hardware rate, bounded chunks and a flush marker',
    (rate) => {
      const { processor, messages } = worklet(rate);
      for (let i = 0; i < rate; i += 128) {
        const size = Math.min(128, rate - i);
        processor.process([[new Float32Array(size).fill(1), new Float32Array(size).fill(0)]]);
      }
      processor.port.onmessage({ data: 'finish' });
      const buffers = messages.filter((message): message is ArrayBuffer => message instanceof ArrayBuffer);
      const samples = buffers.reduce((sum, buffer) => sum + buffer.byteLength / 2, 0);
      expect(Math.abs(samples - 16000)).toBeLessThanOrEqual(1);
      expect(buffers.every((buffer) => buffer.byteLength <= 6400)).toBe(true);
      expect(new DataView(buffers[0]).getInt16(0, true)).toBe(16384);
      expect(messages.at(-1)).toBe('flushed');
      expect(processor.process([[new Float32Array(128)]])).toBe(false);
    },
  );

  it('clamps negative samples and flushes a short final block', () => {
    const { processor, messages } = worklet(16000);
    processor.process([[new Float32Array([-2, -1, 0, 1, 2])]]);
    expect(messages).toHaveLength(0);
    processor.port.onmessage({ data: 'finish' });
    const view = new DataView(messages[0] as ArrayBuffer);
    expect(Array.from({ length: 5 }, (_, i) => view.getInt16(i * 2, true))).toEqual([-32768, -32768, 0, 32767, 32767]);
  });
});
