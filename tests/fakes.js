// テスト用の偽物: 音声（呼び出しを記録）、時計は src/core/clock.js の fakeClock を使う。

function param(v = 0) {
  const p = {
    value: v,
    events: [],
    setTargetAtTime(val, t) { p.events.push(['target', val, t]); p.value = val; return p; },
    setValueAtTime(val, t) { p.events.push(['set', val, t]); p.value = val; return p; },
    linearRampToValueAtTime(val, t) { p.events.push(['ramp', val, t]); p.value = val; return p; },
    cancelScheduledValues(t) { p.events.push(['cancel', t]); return p; },
  };
  return p;
}

function node(extra = {}) {
  return { connect() {}, disconnect() {}, ...extra };
}

/** clock.mono() を音声クロックとして使う偽の AudioContext を作るクラスを返す */
export function makeFakeAudio(clock, { failConstruct = false, startState = 'running' } = {}) {
  const log = { starts: [], stops: 0, contexts: [] };
  class FakeAudioContext {
    constructor() {
      if (failConstruct) throw new Error('AudioContext unavailable');
      this.sampleRate = 48000;
      this.state = startState;
      this.destination = node();
      this.onstatechange = null;
      this._t0 = clock.mono();
      log.contexts.push(this);
    }
    get currentTime() { return this.state === 'running' ? (clock.mono() - this._t0) / 1000 : this._frozen ?? 0; }
    resume() { this.state = 'running'; this.onstatechange && this.onstatechange(); return Promise.resolve(); }
    suspend() { this._frozen = this.currentTime; this.state = 'suspended'; this.onstatechange && this.onstatechange(); return Promise.resolve(); }
    createGain() { return node({ gain: param(1) }); }
    createDynamicsCompressor() { return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }); }
    createBiquadFilter() { return node({ type: 'lowpass', frequency: param(350), Q: param(1) }); }
    createStereoPanner() { return node({ pan: param(0) }); }
    createBuffer(ch, len, sr) {
      const data = Array.from({ length: ch }, () => new Float32Array(len));
      return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (i) => data[i] };
    }
    createBufferSource() {
      const ctx = this;
      const src = node({
        buffer: null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: param(1),
        start(when = 0) { log.starts.push({ when, len: src.buffer?.length, at: ctx.currentTime, src }); src.started = when; },
        stop() { src.stopped = true; log.stops += 1; },
      });
      return src;
    }
  }
  return { AudioCtor: FakeAudioContext, log };
}

/** 鐘（長さ 16 秒程度のバッファ）の再生だけを数える */
export function bellStarts(log) {
  return log.starts.filter((s) => s.len > 48000 * 2 && !s.src.stopped && !s.src.loop);
}
