/* Browser AudioWorklet asset. No imports or build step; the host serves it verbatim. */
class VoicePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.position = 0;
    this.previous = 0;
    this.total = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'finish') {
        this.stopped = true;
        this.flush();
        this.port.postMessage('flushed');
      }
    };
  }

  flush() {
    if (!this.samples.length) return;
    const buffer = new ArrayBuffer(this.samples.length * 2);
    const view = new DataView(buffer);
    this.samples.forEach((sample, index) => {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(index * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
    });
    this.samples = [];
    this.port.postMessage(buffer, [buffer]);
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    // Browsers may ignore the requested context rate. Resample continuously
    // across render blocks and downmix to mono before writing signed LE PCM.
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      while (this.position <= this.total) {
        const fraction = this.position - (this.total - 1);
        this.samples.push(this.total === 0 ? sample : this.previous + (sample - this.previous) * fraction);
        this.position += sampleRate / 16000;
        if (this.samples.length >= 3200) this.flush();
      }
      this.previous = sample;
      this.total++;
    }
    return true;
  }
}
registerProcessor('voice-pcm', VoicePcmProcessor);
