// audio.js — all sound synthesized at runtime. No sample assets.
// Per GDD: ambient drone, proximity heartbeat, the Listener's call, relay shriek.

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.nodes = {};
    this._beatAt = 0;
    this._stepAt = 0;
  }

  // Must be called from a user gesture (browser autoplay policy).
  start() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    // ---- ambient drone: two detuned subs + filtered noise ----
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.0;
    this.droneGain.connect(this.master);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    lp.Q.value = 1.2;
    lp.connect(this.droneGain);

    [36.7, 37.4].forEach((f) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      o.connect(g).connect(lp);
      o.start();
    });

    // room noise floor — keeps the mix from ever being truly silent
    this.noiseBuf = this._makeNoise(2.0);
    const air = ctx.createBufferSource();
    air.buffer = this.noiseBuf;
    air.loop = true;
    const airF = ctx.createBiquadFilter();
    airF.type = 'bandpass';
    airF.frequency.value = 400;
    airF.Q.value = 0.6;
    const airG = ctx.createGain();
    airG.gain.value = 0.045;
    air.connect(airF).connect(airG).connect(this.master);
    air.start();

    // ---- relay shriek bus (gated) ----
    this.shriekGain = ctx.createGain();
    this.shriekGain.gain.value = 0;
    this.shriekGain.connect(this.master);
    const sF = ctx.createBiquadFilter();
    sF.type = 'bandpass';
    sF.frequency.value = 1400;
    sF.Q.value = 3;
    sF.connect(this.shriekGain);
    [610, 923, 1237].forEach((f) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.33;
      o.connect(g).connect(sF);
      o.start();
    });

    this.ready = true;
    this.fadeDrone(0.5, 4);
  }

  _makeNoise(sec) {
    const n = Math.floor(this.ctx.sampleRate * sec);
    const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  fadeDrone(to, sec) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.droneGain.gain.cancelScheduledValues(t);
    this.droneGain.gain.setValueAtTime(this.droneGain.gain.value, t);
    this.droneGain.gain.linearRampToValueAtTime(to, t + sec);
  }

  // one-shot noise burst through a filter
  _burst(dur, type, freq, q, gain, atk = 0.005) {
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t);
    s.stop(t + dur + 0.05);
  }

  _tone(freq, dur, type, gain, glideTo) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  footstep(intensity) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    if (now < this._stepAt) return;
    this._stepAt = now + (intensity > 0.7 ? 0.30 : intensity > 0.3 ? 0.48 : 0.75);
    this._burst(0.10, 'lowpass', 300 + intensity * 500, 1.0, 0.10 + intensity * 0.16);
  }

  click() { // flashlight toggle — diegetically the loudest small sound in the game
    if (!this.ready) return;
    this._burst(0.045, 'bandpass', 2600, 6, 0.30);
  }

  // The Listener's idle clicking. rate rises with alertness.
  tick(alert) {
    if (!this.ready) return;
    this._burst(0.05, 'bandpass', 1100 + alert * 900, 8, 0.05 + alert * 0.09);
  }

  call() { // entry to HUNT — dissonant rising pair
    if (!this.ready) return;
    this._tone(150, 1.5, 'sawtooth', 0.16, 420);
    this._tone(158, 1.5, 'sawtooth', 0.14, 445);
    this._burst(1.3, 'bandpass', 700, 1.5, 0.13, 0.25);
  }

  // proximity heartbeat — the real threat readout
  heartbeat(prox, dt) {
    if (!this.ready || prox <= 0.02) return;
    this._beatAt -= dt * (0.9 + prox * 2.6);
    if (this._beatAt > 0) return;
    this._beatAt = 1.0;
    const g = 0.10 + prox * 0.30;
    this._tone(58, 0.16, 'sine', g);
    setTimeout(() => this.ready && this._tone(48, 0.20, 'sine', g * 0.65), 165);
  }

  setShriek(on) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.shriekGain.gain.cancelScheduledValues(t);
    this.shriekGain.gain.setValueAtTime(this.shriekGain.gain.value, t);
    this.shriekGain.gain.linearRampToValueAtTime(on ? 0.20 : 0, t + (on ? 0.3 : 0.7));
  }

  relayDone() {
    if (!this.ready) return;
    this._tone(320, 0.7, 'sine', 0.16, 640);
  }

  death() {
    if (!this.ready) return;
    this.fadeDrone(0, 0.4);
    this.setShriek(false);
    this._burst(1.6, 'lowpass', 900, 1, 0.5, 0.01);
    this._tone(70, 1.8, 'sawtooth', 0.3, 34);
  }

  win() {
    if (!this.ready) return;
    this.setShriek(false);
    this.fadeDrone(0.1, 3);
    [261, 329, 392].forEach((f, i) =>
      setTimeout(() => this.ready && this._tone(f, 2.4, 'sine', 0.12), i * 260));
  }

  stopAll() {
    if (!this.ready) return;
    this.setShriek(false);
    this.fadeDrone(0, 0.5);
  }
}
