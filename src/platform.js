// 端末機能。どれも「使えなくても体験が壊れない」ように、失敗は静かに無視する。

export function createWakeLock() {
  let sentinel = null;
  let wanted = false;
  async function acquire() {
    if (!wanted || sentinel || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => { sentinel = null; });
    } catch {
      sentinel = null; // 省電力モードや非対応環境
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') acquire(); });
  return {
    get supported() { return 'wakeLock' in navigator; },
    get active() { return !!sentinel; },
    async request() { wanted = true; await acquire(); },
    async release() {
      wanted = false;
      const s = sentinel; sentinel = null;
      try { await s?.release(); } catch { /* noop */ }
    },
  };
}

export function vibrate(pattern) {
  try { if (navigator.vibrate) return navigator.vibrate(pattern); } catch { /* noop */ }
  return false;
}

export const notifications = {
  get supported() { return 'Notification' in globalThis; },
  get permission() { return this.supported ? Notification.permission : 'denied'; },
  async request() {
    if (!this.supported) return 'denied';
    try { return await Notification.requestPermission(); } catch { return 'denied'; }
  },
  /** 内容は「時間が終わった」ことだけ。感情や記録は含めない。 */
  async show(title, body) {
    if (this.permission !== 'granted') return false;
    try {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg) { await reg.showNotification(title, { body, tag: 'zazen-end', icon: 'icons/icon-192.png', silent: false }); return true; }
      new Notification(title, { body, tag: 'zazen-end' });
      return true;
    } catch { return false; }
  },
};

export function createSpeech() {
  const synth = globalThis.speechSynthesis;
  return {
    get supported() { return !!synth; },
    speak(text, lang) {
      if (!synth) return;
      try {
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang === 'ja' ? 'ja-JP' : 'en-US';
        u.rate = 0.85;
        u.pitch = 0.95;
        u.volume = 0.8;
        // 端末内の声を優先する
        const voices = synth.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith(lang));
        const local = voices.find((v) => v.localService) || voices[0];
        if (local) u.voice = local;
        synth.speak(u);
      } catch { /* noop */ }
    },
    cancel() { try { synth?.cancel(); } catch { /* noop */ } },
  };
}

/** 省電力の推定。端末の申告だけを使い、計測データは外へ出さない。 */
export async function guessLowPower() {
  const n = navigator;
  if ((n.hardwareConcurrency && n.hardwareConcurrency <= 2) || (n.deviceMemory && n.deviceMemory <= 2)) return true;
  if (n.connection?.saveData) return true;
  try {
    const b = await n.getBattery?.();
    if (b && !b.charging && b.level < 0.2) return true;
  } catch { /* noop */ }
  return false;
}
