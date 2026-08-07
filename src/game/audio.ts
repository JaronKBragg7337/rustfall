// Audio — entirely synthesised, no downloaded assets.
//
// Every sound here is built from oscillators and filtered noise at runtime, for
// two reasons. The game already pays 2.4 MB for textures and a sample library
// would dwarf that on a phone connection. And synthesis parameterises: one
// footstep function covers dirt, metal deck and interior boards by moving a
// filter, instead of shipping three sets of samples.
//
// Browsers refuse to start audio before a user gesture, so the context is
// created lazily on the first real interaction and everything is a no-op until
// then. Nothing in the game needs to know that.
const MASTER_DEFAULT = 0.6;

type Surface = "dirt" | "metal" | "wood" | "gravel";

export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private noiseBuffer!: AudioBuffer;
  private started = false;
  muted = false;
  private volume = MASTER_DEFAULT;
  private genGain: GainNode | null = null;

  /** Safe to call on every gesture; only the first one does anything. */
  resume() {
    if (this.started) {
      if (this.ctx?.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.started = true;

    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(this.ctx.destination);

    // One second of white noise, reused by every noise-based voice.
    const sr = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, sr, sr);
    const d = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    this.startWind();
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  get enabled() { return this.started && !this.muted; }

  private noiseSource(): AudioBufferSourceNode {
    const n = this.ctx!.createBufferSource();
    n.buffer = this.noiseBuffer;
    n.loop = true;
    return n;
  }

  /** Continuous filtered-noise wind bed; the only always-on voice. */
  private startWind() {
    const ctx = this.ctx!;
    const src = this.noiseSource();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 420;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.05;
    src.connect(this.windFilter).connect(this.windGain).connect(this.master);
    src.start();

    // Slow LFO on cutoff and level so the bed breathes instead of hissing flatly.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 190;
    lfo.connect(lfoGain).connect(this.windFilter.frequency);
    lfo.start();

    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.043;
    const lfo2Gain = ctx.createGain();
    lfo2Gain.gain.value = 0.028;
    lfo2.connect(lfo2Gain).connect(this.windGain.gain);
    lfo2.start();
  }

  /** Ramp the wind for weather — 0 calm, 1 full dust storm. */
  setWind(intensity: number) {
    if (!this.started) return;
    const t = this.ctx!.currentTime;
    this.windGain.gain.setTargetAtTime(0.05 + intensity * 0.22, t, 1.5);
    this.windFilter.frequency.setTargetAtTime(420 + intensity * 700, t, 1.5);
    this.windFilter.Q.setTargetAtTime(0.7 + intensity * 1.6, t, 1.5);
  }

  /** Short filtered-noise burst — the basis of footsteps, impacts and hits. */
  private burst(opts: {
    dur: number; type: BiquadFilterType; freq: number; q?: number;
    gain: number; decay?: number; delay?: number;
  }) {
    if (!this.started || this.muted) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const src = this.noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.frequency.value = opts.freq;
    f.Q.value = opts.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(opts.gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + opts.dur + 0.02);
  }

  /** Pitched voice — used for zaps, servos, UI and the pickup chime. */
  private tone(opts: {
    freq: number; to?: number; dur: number; gain: number;
    type?: OscillatorType; delay?: number;
  }) {
    if (!this.started || this.muted) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const o = ctx.createOscillator();
    o.type = opts.type ?? "sine";
    o.frequency.setValueAtTime(opts.freq, t);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t + opts.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(opts.gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + opts.dur + 0.02);
  }

  // ─────────────────────────── voices ───────────────────────────

  /** Surface changes the filter, not the sample. */
  footstep(surface: Surface = "dirt", running = false) {
    const g = running ? 0.22 : 0.13;
    switch (surface) {
      case "metal":
        this.burst({ dur: 0.14, type: "bandpass", freq: 2400, q: 3, gain: g * 0.8 });
        this.tone({ freq: 1500, to: 700, dur: 0.09, gain: g * 0.12, type: "square" });
        break;
      case "wood":
        this.burst({ dur: 0.11, type: "lowpass", freq: 900, q: 1.2, gain: g });
        this.tone({ freq: 180, to: 110, dur: 0.08, gain: g * 0.25, type: "sine" });
        break;
      case "gravel":
        this.burst({ dur: 0.16, type: "highpass", freq: 1600, q: 0.8, gain: g * 0.9 });
        break;
      default:
        this.burst({ dur: 0.12, type: "lowpass", freq: 620, q: 0.9, gain: g });
    }
  }

  playerShot() {
    this.burst({ dur: 0.16, type: "bandpass", freq: 1100, q: 0.8, gain: 0.5 });
    this.tone({ freq: 900, to: 120, dur: 0.14, gain: 0.16, type: "sawtooth" });
    this.burst({ dur: 0.3, type: "lowpass", freq: 320, q: 0.7, gain: 0.14, delay: 0.02 });
  }

  mechPunch() {
    this.tone({ freq: 150, to: 40, dur: 0.32, gain: 0.4, type: "square" });
    this.burst({ dur: 0.26, type: "lowpass", freq: 500, q: 1, gain: 0.34 });
  }

  /** Incoming zap from a hostile robot. */
  enemyShot() {
    this.tone({ freq: 1700, to: 260, dur: 0.2, gain: 0.2, type: "sawtooth" });
    this.burst({ dur: 0.14, type: "highpass", freq: 2200, gain: 0.14 });
  }

  /** A shot that stopped on cover — duller, no sting. */
  shotBlocked() {
    this.burst({ dur: 0.13, type: "lowpass", freq: 700, q: 1.4, gain: 0.2 });
  }

  hurt() {
    this.tone({ freq: 260, to: 90, dur: 0.28, gain: 0.22, type: "triangle" });
    this.burst({ dur: 0.18, type: "lowpass", freq: 420, gain: 0.16 });
  }

  robotDeath() {
    this.tone({ freq: 620, to: 60, dur: 0.6, gain: 0.24, type: "sawtooth" });
    this.burst({ dur: 0.5, type: "lowpass", freq: 900, q: 0.8, gain: 0.28 });
    this.burst({ dur: 0.24, type: "bandpass", freq: 2600, q: 2, gain: 0.12, delay: 0.08 });
  }

  bossStomp() {
    this.tone({ freq: 78, to: 28, dur: 0.7, gain: 0.5, type: "sine" });
    this.burst({ dur: 0.4, type: "lowpass", freq: 190, q: 0.8, gain: 0.34 });
  }

  pickup() {
    this.tone({ freq: 660, dur: 0.1, gain: 0.16, type: "triangle" });
    this.tone({ freq: 990, dur: 0.14, gain: 0.14, type: "triangle", delay: 0.07 });
    this.tone({ freq: 1320, dur: 0.18, gain: 0.1, type: "sine", delay: 0.14 });
  }

  /**
   * Generator chug — the second persistent voice after the wind. A square-wave
   * LFO gates two low oscillators into the classic single-cylinder putter, and
   * the engine drives the master gain every frame with distance attenuation,
   * so it is only ever audible while running AND nearby. Muting rides on the
   * master gain like every other voice.
   */
  setGenerator(running: boolean, proximity: number) {
    if (!this.started) return;
    const ctx = this.ctx!;
    if (!this.genGain) {
      const o1 = ctx.createOscillator();
      o1.type = "sawtooth";
      o1.frequency.value = 52;
      const o2 = ctx.createOscillator();
      o2.type = "square";
      o2.frequency.value = 104;
      const o2Gain = ctx.createGain();
      o2Gain.gain.value = 0.4;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 330;
      filter.Q.value = 0.8;
      const am = ctx.createGain();
      am.gain.value = 0.72;
      const lfo = ctx.createOscillator();
      lfo.type = "square";
      lfo.frequency.value = 7.4;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.28;
      lfo.connect(lfoGain).connect(am.gain);
      this.genGain = ctx.createGain();
      this.genGain.gain.value = 0;
      o1.connect(filter);
      o2.connect(o2Gain).connect(filter);
      filter.connect(am).connect(this.genGain).connect(this.master);
      o1.start();
      o2.start();
      lfo.start();
    }
    const target = running && !this.muted ? Math.max(0, Math.min(1, proximity)) * 0.3 : 0;
    this.genGain.gain.setTargetAtTime(target, ctx.currentTime, 0.25);
  }

  /** Stalker telegraph — a rising whine that tightens as the shot charges. */
  laserCharge() {
    this.tone({ freq: 240, to: 1900, dur: 1.15, gain: 0.15, type: "sawtooth" });
    this.tone({ freq: 480, to: 2600, dur: 1.15, gain: 0.06, type: "sine" });
  }

  /** The bolt leaving the barrel — a crack, not a zap. */
  laserDischarge() {
    this.burst({ dur: 0.2, type: "highpass", freq: 1800, q: 0.7, gain: 0.38 });
    this.tone({ freq: 2400, to: 180, dur: 0.22, gain: 0.28, type: "square" });
    this.burst({ dur: 0.32, type: "lowpass", freq: 480, q: 0.8, gain: 0.16, delay: 0.02 });
  }

  /** Runner aggro — a two-bark shriek so the fast one announces itself. */
  runnerScreech() {
    this.tone({ freq: 700, to: 1500, dur: 0.26, gain: 0.18, type: "sawtooth" });
    this.tone({ freq: 1450, to: 520, dur: 0.38, gain: 0.16, type: "sawtooth", delay: 0.2 });
    this.burst({ dur: 0.5, type: "bandpass", freq: 2100, q: 2.5, gain: 0.1 });
  }

  build() {
    this.burst({ dur: 0.14, type: "bandpass", freq: 1800, q: 2.4, gain: 0.24 });
    this.tone({ freq: 420, to: 620, dur: 0.13, gain: 0.14, type: "square" });
  }

  ui() {
    this.tone({ freq: 880, dur: 0.05, gain: 0.07, type: "square" });
  }

  layerFlip() {
    this.tone({ freq: 420, to: 1260, dur: 0.22, gain: 0.12, type: "sine" });
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}
