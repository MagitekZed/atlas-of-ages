// Seeded randomness and noise. All simulation randomness must flow through world.rng
// (an RNG instance) so a seed + parameter set reproduces the same history.

/** 32-bit string hash (FNV-1a with a final avalanche). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic integer hash of (x, y, seed) → uint32. */
export function hash2i(x, y, seed = 0) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}
/** Deterministic hash of (x, y, seed) → float in [0, 1). */
export const hash2 = (x, y, seed = 0) => hash2i(x, y, seed) / 4294967296;

/** sfc32 PRNG. Serialisable through `.state` (array of four uint32). */
export class RNG {
  constructor(seed = 1) {
    const h = typeof seed === 'string' ? hashString(seed) : (seed >>> 0);
    this.state = [h ^ 0x9e3779b9, Math.imul(h, 0x85ebca6b) >>> 0, (h ^ 0xc2b2ae35) >>> 0, (0x27d4eb2f ^ Math.imul(h, 31)) >>> 0];
    for (let i = 0; i < 16; i++) this.nextU32();
  }
  static fromState(state) {
    const r = new RNG(0);
    r.state = state.slice(0, 4).map((v) => v >>> 0);
    return r;
  }
  nextU32() {
    const s = this.state;
    let a = s[0], b = s[1], c = s[2], d = s[3];
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    s[0] = a >>> 0; s[1] = b >>> 0; s[2] = c >>> 0; s[3] = d >>> 0;
    return t >>> 0;
  }
  /** float in [0, 1) */
  next() { return this.nextU32() / 4294967296; }
  float(lo = 0, hi = 1) { return lo + (hi - lo) * this.next(); }
  /** integer in [lo, hi] inclusive */
  int(lo, hi) { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr.length ? arr[Math.floor(this.next() * arr.length)] : undefined; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  normal(mean = 0, sd = 1) {
    const u = 1 - this.next(), v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  /** A new independent RNG derived from this one (advances this stream once). */
  fork(salt = '') { return new RNG((this.nextU32() ^ hashString(String(salt))) >>> 0); }
}

// ---------------------------------------------------------------------------
// 2-D simplex noise (Gustavson). createNoise2D(seed) → (x, y) => [-1, 1]

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);

export function createNoise2D(seed = 0) {
  const rng = new RNG(typeof seed === 'string' ? seed : (seed >>> 0) ^ 0x5bd1e995);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  return function noise2(xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = (perm[ii + perm[jj]] & 7) * 2; t0 *= t0; n0 = t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = (perm[ii + i1 + perm[jj + j1]] & 7) * 2; t1 *= t1; n1 = t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = (perm[ii + 1 + perm[jj + 1]] & 7) * 2; t2 *= t2; n2 = t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2); }
    return 70 * (n0 + n1 + n2);
  };
}

/** Fractal Brownian motion over a noise2 function. Returns roughly [-1, 1]. */
export function fbm(noise2, x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x * freq + o * 17.31, y * freq - o * 9.73);
    norm += amp; amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal noise in [0, 1]: sharp crests, good for mountain chains. */
export function ridged(noise2, x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0, prev = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(noise2(x * freq + o * 31.7, y * freq + o * 11.3));
    n *= n;
    sum += n * amp * prev;
    norm += amp;
    prev = n;
    amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}
