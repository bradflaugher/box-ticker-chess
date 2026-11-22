// Small synthesised sound effects (no audio files to download).

export class Sound {
  constructor() {
    this.enabled = true;
    this.ctx = null;
  }

  context() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // A short filtered noise burst: the "clack" of a piece on wood.
  knock(ctx, at, freq, gain, length = 0.07) {
    const frames = Math.floor(ctx.sampleRate * length);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 3;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 1.4;
    const amp = ctx.createGain();
    amp.gain.value = gain;
    src.connect(filter).connect(amp).connect(ctx.destination);
    src.start(at);
  }

  tone(ctx, at, freq, gain, length, type = 'sine') {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(gain, at + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(amp).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + length + 0.02);
  }

  play(name) {
    if (!this.enabled) return;
    let ctx;
    try {
      ctx = this.context();
    } catch {
      return;
    }
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    if (name === 'move') this.knock(ctx, t, 1100, 0.5);
    else if (name === 'capture') {
      this.knock(ctx, t, 700, 0.7, 0.09);
      this.knock(ctx, t + 0.045, 1500, 0.35, 0.05);
    } else if (name === 'check') {
      // Rubber stamp, then a desk bell.
      this.knock(ctx, t, 260, 1.1, 0.12);
      this.tone(ctx, t + 0.05, 1568, 0.12, 0.7);
      this.tone(ctx, t + 0.05, 2349, 0.05, 0.5);
    } else if (name === 'win') {
      [523, 659, 784, 1047].forEach((f, i) => this.tone(ctx, t + i * 0.11, f, 0.13, 0.5, 'triangle'));
    } else if (name === 'lose') {
      [392, 330, 262].forEach((f, i) => this.tone(ctx, t + i * 0.16, f, 0.12, 0.6, 'triangle'));
    } else if (name === 'draw') {
      [440, 440].forEach((f, i) => this.tone(ctx, t + i * 0.2, f, 0.1, 0.4, 'triangle'));
    }
  }
}
