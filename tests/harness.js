// 依存なしの小さなテストハーネス。ブラウザで動く（tools/test.py がヘッドレスで実行する）。

const registry = [];
let currentFile = '';

export function setFile(name) { currentFile = name; }

export function test(name, fn, { timeout = 20_000 } = {}) {
  registry.push({ file: currentFile, name, fn, timeout });
}

class AssertionError extends Error {}

function fmt(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const assert = {
  ok(v, msg = 'expected truthy') { if (!v) throw new AssertionError(`${msg} (got ${fmt(v)})`); },
  equal(a, b, msg = '') { if (a !== b) throw new AssertionError(`${msg} expected ${fmt(b)}, got ${fmt(a)}`); },
  notEqual(a, b, msg = '') { if (a === b) throw new AssertionError(`${msg} expected not ${fmt(b)}`); },
  deepEqual(a, b, msg = '') { if (fmt(a) !== fmt(b)) throw new AssertionError(`${msg} expected ${fmt(b)}, got ${fmt(a)}`); },
  approx(a, b, tol, msg = '') { if (!(Math.abs(a - b) <= tol)) throw new AssertionError(`${msg} expected ${b}±${tol}, got ${a}`); },
  throws(fn, msg = 'expected to throw') { let threw = false; try { fn(); } catch { threw = true; } if (!threw) throw new AssertionError(msg); },
  includes(arr, v, msg = '') { if (!arr.includes(v)) throw new AssertionError(`${msg} expected to include ${fmt(v)}`); },
};

export async function run({ filter = '' } = {}) {
  const results = [];
  for (const t of registry) {
    if (filter && !`${t.file} ${t.name}`.includes(filter)) continue;
    const t0 = performance.now();
    try {
      await Promise.race([
        Promise.resolve().then(t.fn),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${t.timeout}ms`)), t.timeout)),
      ]);
      results.push({ file: t.file, name: t.name, ok: true, ms: Math.round(performance.now() - t0) });
    } catch (err) {
      results.push({ file: t.file, name: t.name, ok: false, ms: Math.round(performance.now() - t0), error: String(err && err.stack || err) });
    }
  }
  return results;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
