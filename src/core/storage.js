// localStorage の薄いラッパー。
// - 例外（プライベートモード、容量不足、無効化）を外に漏らさない
// - 失敗したらメモリ上に保持して体験を続ける
// - 失敗は onError で UI に一度だけ穏やかに伝える
//
// 端末外へは何も送らない。

const DEFAULT_PREFIX = 'zazen.v1.';

export function createStorage(backend = safeLocalStorage(), { onError, prefix = DEFAULT_PREFIX } = {}) {
  const PREFIX = prefix;
  const memory = new Map();
  let degraded = !backend;

  function report(kind, err) {
    degraded = true;
    if (onError) {
      try { onError(kind, err); } catch { /* noop */ }
    }
  }

  return {
    get degraded() { return degraded; },
    read(key, fallback = null) {
      const k = PREFIX + key;
      if (memory.has(k)) return memory.get(k);
      if (!backend) return fallback;
      try {
        const raw = backend.getItem(k);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (err) {
        // 壊れたデータ: 退避してから既定値で続ける
        try { backend.setItem(k + '.corrupt', backend.getItem(k) ?? ''); backend.removeItem(k); } catch { /* noop */ }
        report('corrupt', err);
        return fallback;
      }
    },
    write(key, value) {
      const k = PREFIX + key;
      if (!backend) { memory.set(k, value); return false; }
      try {
        backend.setItem(k, JSON.stringify(value));
        memory.delete(k);
        return true;
      } catch (err) {
        memory.set(k, value);
        report(isQuota(err) ? 'quota' : 'write', err);
        return false;
      }
    },
    remove(key) {
      const k = PREFIX + key;
      memory.delete(k);
      if (!backend) return;
      try { backend.removeItem(k); backend.removeItem(k + '.corrupt'); } catch { /* noop */ }
    },
    /** このアプリのデータをすべて消す */
    clearAll() {
      for (const k of [...memory.keys()]) if (k.startsWith(PREFIX)) memory.delete(k);
      if (!backend) return;
      try {
        const keys = [];
        for (let i = 0; i < backend.length; i++) {
          const k = backend.key(i);
          if (k && k.startsWith(PREFIX)) keys.push(k);
        }
        keys.forEach((k) => backend.removeItem(k));
      } catch { /* noop */ }
    },
  };
}

function isQuota(err) {
  return !!err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014 || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

function safeLocalStorage() {
  try {
    const ls = globalThis.localStorage;
    const probe = DEFAULT_PREFIX + '__probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/** テスト用: メモリ上の Storage 互換オブジェクト。failWrites で容量不足を模倣。 */
export function memoryBackend({ failWrites = false } = {}) {
  const m = new Map();
  return {
    failWrites,
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      if (this.failWrites) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, String(v));
    },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}
