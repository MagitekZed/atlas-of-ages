// Small shared helpers. DOM-free; safe to import from sim, render and UI code.

export const SQRT2 = Math.SQRT2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (a === b ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const remap = (v, a0, a1, b0, b1) => b0 + (b1 - b0) * clamp01(invLerp(a0, a1, v));

// 4- and 8-neighbourhood offsets. DIR8 order: E, SE, S, SW, W, NW, N, NE.
export const DX4 = [1, -1, 0, 0];
export const DY4 = [0, 0, 1, -1];
export const DX8 = [1, 1, 0, -1, -1, -1, 0, 1];
export const DY8 = [0, 1, 1, 1, 0, -1, -1, -1];
export const DIST8 = [1, SQRT2, 1, SQRT2, 1, SQRT2, 1, SQRT2];

export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
export const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

/** Binary min-heap of (id, priority) pairs. Used by pathfinding, territory and hydrology. */
export class MinHeap {
  constructor(capacity = 1024) {
    this.ids = new Int32Array(capacity);
    this.pri = new Float64Array(capacity);
    this.size = 0;
  }
  clear() { this.size = 0; }
  _grow() {
    const n = this.ids.length * 2;
    const ids = new Int32Array(n); ids.set(this.ids); this.ids = ids;
    const pri = new Float64Array(n); pri.set(this.pri); this.pri = pri;
  }
  push(id, priority) {
    if (this.size >= this.ids.length) this._grow();
    let i = this.size++;
    const ids = this.ids, pri = this.pri;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (pri[p] <= priority) break;
      ids[i] = ids[p]; pri[i] = pri[p]; i = p;
    }
    ids[i] = id; pri[i] = priority;
  }
  peekPriority() { return this.size ? this.pri[0] : Infinity; }
  /** Removes and returns the id with the lowest priority (or -1 if empty). */
  pop() {
    if (!this.size) return -1;
    const ids = this.ids, pri = this.pri;
    const top = ids[0];
    const n = --this.size;
    if (n > 0) {
      const lid = ids[n], lp = pri[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && pri[c + 1] < pri[c]) c++;
        if (pri[c] >= lp) break;
        ids[i] = ids[c]; pri[i] = pri[c]; i = c;
      }
      ids[i] = lid; pri[i] = lp;
    }
    return top;
  }
}

export function formatNumber(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(digits) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(digits) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(digits) + 'k';
  if (a >= 100) return Math.round(n).toString();
  if (a >= 10) return n.toFixed(Math.min(digits, 1)).replace(/\.0$/, '');
  return n.toFixed(digits + 1).replace(/\.?0+$/, '') || '0';
}

export function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

export function rgbToHex([r, g, b]) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
export function hexToRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
/** h in degrees, s/l in 0..1 → [r,g,b] 0..255 */
export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255].map(Math.round);
}
export const mixRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Index of a weighted random choice. weights: number[] (non-negative). */
export function weightedIndex(rng, weights) {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (total <= 0) return -1;
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] > 0 ? weights[i] : 0;
    if (r < w) return i;
    r -= w;
  }
  return weights.length - 1;
}

export const now = () => (globalThis.performance ? globalThis.performance.now() : Date.now());

/**
 * One scale for disasters (fire, famine, flood …): a toll is major news (imp 3) at 1,000 dead,
 * or at a fifth of the stricken town's people when that is 400 or more. frac = dead / (dead + survivors).
 */
export const majorToll = (dead, frac = 0) => dead >= 1000 || (frac >= 0.2 && dead >= 400);

/** The indefinite article for a word: "an ancestral", "an Eoondish", "a unicorn", "an heir". */
export function aOrAn(word) {
  const w = String(word || '').trim();
  if (/^(honou?r|heir|hour|honest)/i.test(w)) return 'an';
  if (/^(uni|use|usu|ura|ure|euro|eu|one|once|ubi)/i.test(w)) return 'a';
  return /^[aeiou]/i.test(w) ? 'an' : 'a';
}
/** "an ancestral" — the article and the word. */
export const withArticle = (word) => `${aOrAn(word)} ${word}`;
