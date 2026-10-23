// Terrain raster: an offscreen canvas at T px per tile, painted from bilinear-interpolated
// tile data. Hillshade (light from the north-west), smooth biome blending, vegetation,
// seasonal farmland patchwork, snow and sea ice, burn scars, depth-tinted water with a soft
// coastline rim. One "style" per map mode family. Rows refresh incrementally under a time
// budget (visible rows first) so seasons sweep across the map without frame spikes.

import { BIOME, BIOMES, WATER } from '../core/constants.js';
import { latitude, yearPhase } from '../core/world.js';
import { smoothstep, clamp01 } from '../core/util.js';
import { hash2i } from '../core/rng.js';
import * as P from './palette.js';

/** Raster style used by each map mode. */
export const STYLE_FOR_MODE = {
  terrain: 'natural', political: 'muted', religion: 'muted', culture: 'muted', tech: 'muted',
  trade: 'muted', disease: 'muted', resources: 'resources', elevation: 'elevation',
  temperature: 'temperature', rainfall: 'rainfall', biome: 'biome', vegetation: 'vegetation',
  fauna: 'fauna', population: 'population', plates: 'plates', devastation: 'devastation',
  pollution: 'pollution',
};

// Per-style constants: hillshade strength on land / water, paper grain, farmland, snow,
// coastline rim, categorical (nearest-tile) sampling.
const STYLES = {
  natural: { shadeL: 1.15, shadeW: 0.22, grainL: 0.045, grainW: 0.02, farm: true, snow: true, snowA: 0.96, rim: 1, nearest: false, relief: 0.62 },
  muted: { shadeL: 0.8, shadeW: 0.12, grainL: 0.04, grainW: 0.025, farm: false, snow: true, snowA: 0.5, rim: 0.6, nearest: false, relief: 0.2 },
  resources: { shadeL: 0.75, shadeW: 0.12, grainL: 0.04, grainW: 0.025, farm: false, snow: true, snowA: 0.45, rim: 0.6, nearest: false, relief: 0.22 },
  devastation: { shadeL: 0.7, shadeW: 0.1, grainL: 0.035, grainW: 0.02, farm: false, snow: false, snowA: 0, rim: 0.5, nearest: false, relief: 0.26 },
  pollution: { shadeL: 0.7, shadeW: 0.1, grainL: 0.035, grainW: 0.02, farm: false, snow: false, snowA: 0, rim: 0.5, nearest: false, relief: 0.26 },
  elevation: { shadeL: 1.15, shadeW: 0.45, grainL: 0.02, grainW: 0.01, farm: false, snow: false, snowA: 0, rim: 0.3, nearest: false, relief: 0.5 },
  temperature: { shadeL: 0.5, shadeW: 0.1, grainL: 0.015, grainW: 0.01, farm: false, snow: false, snowA: 0, rim: 0.2, nearest: false, relief: 0.16 },
  rainfall: { shadeL: 0.55, shadeW: 0.1, grainL: 0.015, grainW: 0.01, farm: false, snow: false, snowA: 0, rim: 0.3, nearest: false, relief: 0.16 },
  biome: { shadeL: 0.55, shadeW: 0.15, grainL: 0.015, grainW: 0.01, farm: false, snow: false, snowA: 0, rim: 0.4, nearest: true, relief: 0.2 },
  vegetation: { shadeL: 0.5, shadeW: 0.1, grainL: 0.015, grainW: 0.01, farm: false, snow: false, snowA: 0, rim: 0.3, nearest: false, relief: 0.16 },
  fauna: { shadeL: 0.45, shadeW: 0.1, grainL: 0.015, grainW: 0.01, farm: false, snow: false, snowA: 0, rim: 0.3, nearest: false, relief: 0.12 },
  population: { shadeL: 0.7, shadeW: 0.1, grainL: 0.02, grainW: 0.015, farm: false, snow: false, snowA: 0, rim: 0.15, nearest: false, relief: 0.22 },
  plates: { shadeL: 0.6, shadeW: 0.3, grainL: 0.015, grainW: 0.01, farm: false, snow: false, snowA: 0, rim: 0.3, nearest: false, relief: 0.2 },
};

export function makeCanvas(w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

/** Pixels per tile for the raster: ~2.6 Mpx total, 3..8 px/tile (8 on a medium map). */
export function pickTpx(N) {
  return Math.max(3, Math.min(8, Math.round(Math.sqrt(2.6e6 / Math.max(1, N)))));
}

let NOISE = null, NOISE_C = null;
/** 256×256 tileable soft blotches only, in [-1, 1] (organic thresholds: snow lines, fields). */
export function coarseNoise() { if (!NOISE_C) noiseTexture(); return NOISE_C; }
/** 256×256 tileable paper grain in [-1, 1]: fine hash grain + soft blotches. */
export function noiseTexture() {
  if (NOISE) return NOISE;
  const S = 256, n = new Float32Array(S * S);
  const lattice = (cells, seed) => {
    const g = new Float32Array(cells * cells);
    for (let k = 0; k < g.length; k++) g[k] = hash2i(k % cells, (k / cells) | 0, seed) / 4294967296 * 2 - 1;
    return (x, y) => {
      const u = (x / S) * cells, v = (y / S) * cells;
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const a = g[(y0 % cells) * cells + (x0 % cells)], b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
      const c = g[((y0 + 1) % cells) * cells + (x0 % cells)], d = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
      return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    };
  };
  const l1 = lattice(8, 11), l2 = lattice(16, 23), l3 = lattice(64, 37), l4 = lattice(32, 53);
  const c = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const fine = hash2i(x, y, 991) / 4294967296 * 2 - 1;
    n[y * S + x] = fine * 0.45 + l3(x, y) * 0.2 + l2(x, y) * 0.2 + l1(x, y) * 0.25;
    c[y * S + x] = l4(x, y) * 0.5 + l2(x, y) * 0.3 + l3(x, y) * 0.2;
  }
  NOISE_C = c;
  return (NOISE = n);
}

const RELIEF = new Map();
const RELIEF_PERIOD = 48; // tiles per texture repeat
/**
 * Tileable micro-relief for T px per tile (cached per T): a ridged multi-octave height
 * field and its hillshade (light from the north-west). `shade` is signed around 0 (flat),
 * `rank` is the height's percentile in [0, 1] (snow and ice lie on the high ground first).
 * Gives mountains crisp ridges and valleys finer than the tile data, at any raster density.
 */
export function reliefTexture(T) {
  const key = Math.max(1, Math.round(T));
  let r = RELIEF.get(key);
  if (r) return r;
  const S = RELIEF_PERIOD * key, n = S * S;
  const h = new Float32Array(n);
  // cells per period (2, 1, ½, ¼ tile) with amplitude ∝ size^1.35: broad spurs and gullies
  // carry the slope, finer octaves only roughen it; octaves finer than ~2.5 px are dropped
  const octaves = [[24, 1.0, 71], [48, 0.39, 83], [96, 0.153, 97], [192, 0.06, 109]].filter(([c]) => S / c >= 2.5);
  for (const [cells, amp, seed] of octaves) {
    const g = new Float32Array(cells * cells);
    for (let k = 0; k < g.length; k++) g[k] = hash2i(k % cells, (k / cells) | 0, seed) / 4294967296;
    const per = S / cells;
    for (let y = 0; y < S; y++) {
      const v = y / per, y0 = Math.floor(v), fy = v - y0;
      const sy = fy * fy * (3 - 2 * fy);
      const r0 = (y0 % cells) * cells, r1 = ((y0 + 1) % cells) * cells;
      for (let x = 0; x < S; x++) {
        const u = x / per, x0 = Math.floor(u), fx = u - x0;
        const sx = fx * fx * (3 - 2 * fx);
        const c0 = x0 % cells, c1 = (x0 + 1) % cells;
        const a = g[r0 + c0], b = g[r0 + c1], c = g[r1 + c0], d = g[r1 + c1];
        const val = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
        const ridge = 1 - Math.abs(val * 2 - 1);
        h[y * S + x] += ridge * ridge * amp;
      }
    }
  }
  // hillshade per texel; gradients measured per tile so the look is the same at any T
  const shade = new Float32Array(n);
  const K = 3.6, hL = 1.0;
  for (let y = 0; y < S; y++) {
    const ym = ((y - 1 + S) % S) * S, yp = ((y + 1) % S) * S, yr = y * S;
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S, xp = (x + 1) % S;
      const gx = (h[yr + xp] - h[yr + xm]) * 0.5 * key * K;
      const gy = (h[yp + x] - h[ym + x]) * 0.5 * key * K;
      const len = Math.sqrt(gx * gx + gy * gy + 1);
      shade[yr + x] = (gx + gy + hL) / (hL * len) - 1;
    }
  }
  // percentile rank of the height (histogram CDF)
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < n; k++) { const v = h[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const BINS = 1024, hist = new Float64Array(BINS + 1);
  const sc = BINS / Math.max(1e-9, hi - lo);
  for (let k = 0; k < n; k++) hist[Math.min(BINS - 1, ((h[k] - lo) * sc) | 0)]++;
  for (let b = 1; b < BINS; b++) hist[b] += hist[b - 1];
  const rank = new Float32Array(n);
  for (let k = 0; k < n; k++) rank[k] = hist[Math.min(BINS - 1, ((h[k] - lo) * sc) | 0)] / n;
  r = { S, shade, rank };
  RELIEF.set(key, r);
  return r;
}

const nowMs = () => (globalThis.performance ? performance.now() : 0);

export class TerrainLayer {
  constructor(world, opts = {}) {
    this.world = world;
    const W = world.W, H = world.H, N = world.N;
    const T = (this.T = opts.tpx || pickTpx(N));
    this.cw = W * T; this.ch = H * T;
    this.canvas = makeCanvas(this.cw, this.ch);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    this.img = this.ctx.createImageData(this.cw, this.ch);
    this.buf = new Uint32Array(this.img.data.buffer);
    this.buf.fill(0xff1a120b);
    this.colX0 = new Int32Array(this.cw); this.colX1 = new Int32Array(this.cw); this.colFx = new Float32Array(this.cw);
    for (let px = 0; px < this.cw; px++) {
      const u = (px + 0.5) / T - 0.5;
      let x0 = Math.floor(u); const fx = u - x0;
      let x1 = x0 + 1;
      if (x0 < 0) x0 = 0; if (x1 > W - 1) x1 = W - 1; if (x0 > W - 1) x0 = W - 1;
      this.colX0[px] = x0; this.colX1[px] = x1; this.colFx[px] = fx;
    }
    // per-tile prepass data
    this.tR = new Float32Array(N); this.tG = new Float32Array(N); this.tB = new Float32Array(N);
    this.wR = new Float32Array(N); this.wG = new Float32Array(N); this.wB = new Float32Array(N);
    this.isLand = new Float32Array(N);
    this.Lv = new Float32Array(N);
    this.shade = new Float32Array(N);
    this.shoreT = new Float32Array(N);
    this.farmT = new Float32Array(N);
    this.snowT = new Float32Array(N);
    this.iceT = new Float32Array(N);
    this.rowTime = new Float64Array(H).fill(-1e9);
    this.rowDay = new Float64Array(H).fill(-1);
    this.dirty = new Uint8Array(H).fill(2);
    this.urgent = H;
    this.crop = new Float32Array(H * 9); // per row: grain, pasture, fallow RGB
    this.style = STYLES[opts.style] ? opts.style : 'natural';
    this.sweepY = 0; this.visY = 0;
    this.elevCopy = new Float32Array(N); this.waterCopy = new Uint8Array(N);
    this.vTerrain = null; this.vWater = null; this.vBiome = null;
    // biome tints blended over each tile's land neighbourhood (smooth biome transitions)
    this.bl = { lr: new Float32Array(N), lg: new Float32Array(N), lb: new Float32Array(N), br: new Float32Array(N), bg: new Float32Array(N), bb: new Float32Array(N), vmax: new Float32Array(N), seas: new Float32Array(N), grassy: new Float32Array(N), wet: new Float32Array(N) };
    this.vegMissing = false; this._vegCheckDay = -1e9;
    this.noise = noiseTexture();
    this.noiseC = coarseNoise();
    this.relief = reliefTexture(T);
    this.rug = new Float32Array(N);
    const RS = this.relief.S;
    this.colRel = new Int32Array(this.cw);
    for (let px = 0; px < this.cw; px++) this.colRel[px] = px % RS;
    // smoothed copies of nature fields (several are computed on coarse cells upstream)
    this.sm = {};
    this._smAt = {};
    this._bNum = new Float32Array(N); this._bDen = new Float32Array(N); this._bT = new Float32Array(N);
    this.lastWork = 0;
    this.version = 0;          // bumps whenever pixels change (minimap cache key)
    this.staticVersion = 0;    // bumps when Lv/shore/shade change (territory raster key)
    this.syncStatic(true);
  }

  setStyle(style) {
    if (!STYLES[style] || style === this.style) return false;
    this.style = style;
    this._smStyle = null;
    this.dirty.fill(2); this.urgent = this.world.H;
    this.rowTime.fill(-1e9);
    return true;
  }

  /** Detect elevation / water edits by diffing against our copy; mark affected rows urgent. */
  syncStatic(force = false) {
    const w = this.world, v = w.versions, f = w.f, W = w.W, H = w.H, N = w.N;
    if (!force && v.terrain === this.vTerrain && v.water === this.vWater) return false;
    this.vTerrain = v.terrain; this.vWater = v.water;
    let y0 = H, y1 = -1, waterChanged = force;
    const el = f.elevation, wa = f.water, ec = this.elevCopy, wc = this.waterCopy;
    for (let i = 0; i < N; i++) {
      if (el[i] !== ec[i] || wa[i] !== wc[i]) {
        if (wa[i] !== wc[i]) waterChanged = true;
        ec[i] = el[i]; wc[i] = wa[i];
        const y = (i / W) | 0;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (force) { y0 = 0; y1 = H - 1; }
    if (y1 < 0) return false;
    this.computeShade(Math.max(0, y0 - 1), Math.min(H - 1, y1 + 1));
    this.computeLv();
    if (waterChanged) this.computeShore();
    this._smField('depth', el, false, 1);
    for (let y = Math.max(0, y0 - 2); y <= Math.min(H - 1, y1 + 2); y++) {
      if (this.dirty[y] !== 2) { this.dirty[y] = 2; this.urgent++; }
      this.rowTime[y] = -1e9;
    }
    this.staticVersion++;
    return true;
  }

  /** Re-blend biome tints when the biome map changes (yearly); stale rows repaint in the sweep. */
  syncBiomes(force = false) {
    const w = this.world, v = w.versions.biome;
    if (!force && v === this.vBiome) return false;
    this.vBiome = v;
    const f = w.f, W = w.W, H = w.H, bi = f.biome, wa = f.water, bl = this.bl;
    const nB = BIOMES.length;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let s = 0, lr = 0, lg = 0, lb = 0, br = 0, bg = 0, bb = 0, vm = 0, se = 0, gr = 0, we = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            const j = yy * W + xx;
            if (wa[j] !== WATER.LAND && j !== i) continue;
            const b = bi[j] < nB ? bi[j] : BIOME.STEPPE;
            if (BIOMES[b].water) continue;
            const k = (dx ? 1 : 2) * (dy ? 1 : 2);
            const L = P.LUSH[b], B = P.BARE[b];
            lr += L[0] * k; lg += L[1] * k; lb += L[2] * k; br += B[0] * k; bg += B[1] * k; bb += B[2] * k;
            vm += Math.max(0.05, BIOMES[b].vegMax) * k; se += P.SEASONAL[b] * k; gr += P.GRASSY[b] * k; we += (b === BIOME.WETLAND ? 1 : 0) * k;
            s += k;
          }
        }
        if (s <= 0) {
          const b = bi[i] < nB && !BIOMES[bi[i]].water ? bi[i] : BIOME.STEPPE;
          const L = P.LUSH[b], B = P.BARE[b];
          lr = L[0]; lg = L[1]; lb = L[2]; br = B[0]; bg = B[1]; bb = B[2];
          vm = Math.max(0.05, BIOMES[b].vegMax); se = P.SEASONAL[b]; gr = P.GRASSY[b]; we = b === BIOME.WETLAND ? 1 : 0; s = 1;
        }
        const inv = 1 / s;
        bl.lr[i] = lr * inv; bl.lg[i] = lg * inv; bl.lb[i] = lb * inv; bl.br[i] = br * inv; bl.bg[i] = bg * inv; bl.bb[i] = bb * inv;
        bl.vmax[i] = vm * inv; bl.seas[i] = se * inv; bl.grassy[i] = gr * inv; bl.wet[i] = we * inv;
      }
    }
    this.rowDay.fill(-1);
    return true;
  }

  /** Mask-weighted separable blur (two box passes per axis ≈ Gaussian, radius R). */
  _blur(src, land, R, out, Ry = R) {
    const w = this.world, W = w.W, H = w.H, N = w.N, wa = w.f.water;
    const num = this._bNum, den = this._bDen, t = this._bT;
    for (let i = 0; i < N; i++) {
      const m = (wa[i] === 0) === land ? 1 : 0;
      num[i] = m ? src[i] : 0; den[i] = m;
    }
    for (let pass = 0; pass < 2; pass++) {
      boxH(num, t, W, H, R); boxV(t, num, W, H, Ry);
      boxH(den, t, W, H, R); boxV(t, den, W, H, Ry);
    }
    for (let i = 0; i < N; i++) {
      const d = den[i];
      const v = d > 1e-6 ? num[i] / d : src[i];
      out[i] = Number.isFinite(v) ? v : 0;
    }
  }

  _smField(key, src, land, R, Ry = R) {
    const N = this.world.N;
    let a = this.sm[key];
    if (!a || a.length !== N) a = this.sm[key] = new Float32Array(N);
    this._blur(src, land, R, a, Ry);
    this._smAt[key] = this.world.time.day;
    return a;
  }

  /** Refresh the smoothed nature fields the current style needs (at most two per call). */
  _smoothFields(force = false) {
    const w = this.world, f = w.f, st = this.style, day = w.time.day;
    const need = [];
    // (soil water inherits row-band stripes from the rain upsampling: blur it more vertically)
    if (st === 'natural') need.push(['veg', f.veg, true, 2], ['soilWater', f.soilWater, true, 2, 3]);
    else if (st === 'vegetation') need.push(['veg', f.veg, true, 2]);
    else if (st === 'fauna') need.push(['herb', f.herb, true, 2], ['pred', f.pred, true, 2], ['fish', f.fish, false, 2]);
    // these fields drift slowly: refresh one per call, each at most every ~0.4 s of real
    // time, so a fast-running simulation does not pay for a blur every frame
    const now = nowMs();
    this._smT = this._smT || {};
    let done = 0;
    for (const [key, src, land, R, Ry] of need) {
      if (!force && this.sm[key] && (this._smAt[key] === day || done >= 1 || now - (this._smT[key] || -1e9) < 400)) continue;
      this._smField(key, src, land, R, Ry ?? R);
      this._smT[key] = now;
      done++;
    }
  }

  computeShade(y0, y1) {
    const w = this.world, f = w.f, W = w.W, H = w.H;
    const el = f.elevation, wa = f.water, sh = this.shade, rug = this.rug;
    const sea = w.climate?.seaLevel ?? 0.5;
    // metres per elevation unit / metres per tile, × vertical exaggeration
    const mLand = (7000 / Math.max(0.05, 1 - sea) / 20000) * 16;
    const mSea = (8000 / Math.max(0.05, sea) / 20000) * 2.2;
    const hL = 1.2;
    const nb = new Float32Array(9);
    for (let y = y0; y <= y1; y++) {
      const ym = y > 0 ? y - 1 : 0, yp = y < H - 1 ? y + 1 : H - 1;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const xm = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : W - 1;
        const land = wa[i] === WATER.LAND;
        // 3×3 neighbourhood; water reads as the sea surface for land tiles and vice versa
        let k = 0;
        for (const yy of [ym, y, yp]) {
          const r = yy * W;
          for (const xx of [xm, x, xp]) {
            const e = el[r + xx];
            nb[k++] = land ? (e > sea ? e : sea) : (e < sea ? e : sea);
          }
        }
        const gx = (nb[2] + 2 * nb[5] + nb[8] - nb[0] - 2 * nb[3] - nb[6]) / 8;
        const gy = (nb[6] + 2 * nb[7] + nb[8] - nb[0] - 2 * nb[1] - nb[2]) / 8;
        const m0 = land ? mLand : mSea;
        const sx = gx * m0, sy = gy * m0;
        const len = Math.sqrt(sx * sx + sy * sy + 1);
        // Lambert against light from the north-west (-1, -1, hL), normalised so flat = 1
        let m = (sx + sy + hL) / (hL * len);
        // a touch of ambient occlusion in hollows, highlight on crests
        if (land) {
          const lap = (nb[0] + nb[1] + nb[2] + nb[3] + nb[5] + nb[6] + nb[7] + nb[8]) / 8 - nb[4];
          m -= lap * m0 * 0.9;
        }
        if (!(m > 0.2)) m = 0.2;
        sh[i] = m > 1.9 ? 1.9 : m;
        // ruggedness: how much micro-relief the tile shows (high ground and steep slopes)
        if (land) {
          const up = (el[i] - sea) / Math.max(0.05, 1 - sea);
          const rv = 0.05 + 0.95 * smoothstep(0.08, 0.6, up) + Math.min(0.25, Math.sqrt(sx * sx + sy * sy) * 0.1);
          rug[i] = rv > 1 ? 1 : rv;
        } else rug[i] = 0;
      }
    }
  }

  /**
   * Signed land/water field for the coastline: the true sea-level contour of the elevation
   * where it agrees with the water mask, forced to the mask's sign elsewhere; lake shores
   * sit midway between lake and land tile centres.
   */
  computeLv() {
    const w = this.world, f = w.f, W = w.W, H = w.H, N = w.N, Lv = this.Lv, isLand = this.isLand;
    const el = f.elevation, wa = f.water;
    const sea = w.climate?.seaLevel ?? 0.5;
    const K = 22, MIN = 0.06;
    for (let i = 0; i < N; i++) {
      const wt = wa[i];
      isLand[i] = wt === WATER.LAND ? 1 : 0;
      if (wt === WATER.LAKE) { Lv[i] = -0.45; continue; }
      let v = (el[i] - sea) * K;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      if (wt === WATER.LAND) { if (v < MIN) v = MIN; }
      else if (v > -MIN) v = -MIN;
      Lv[i] = v;
    }
    // lake shores: lakes have no shore relief to follow, so shape the field from the lake
    // mask itself. A lake tile with few lake neighbours (a convex corner) and a land tile
    // with many (a concave bay) both sit near the shore line, which rounds the outlines
    // instead of leaving octagons through the tile midpoints.
    const lakeFrac = (x, y) => {
      let n = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const wgt = dx && dy ? 0.7 : 1;
        n += wgt; if (wa[ny * W + nx] === WATER.LAKE) k += wgt;
      }
      return n > 0 ? k / n : 0;
    };
    for (let i = 0; i < N; i++) {
      if (wa[i] !== WATER.LAKE) continue;
      const x = i % W, y = (i / W) | 0;
      Lv[i] = -0.45 * (0.4 + 0.6 * lakeFrac(x, y));
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (wa[j] !== WATER.LAND) continue;
        const cap = 0.45 * (0.4 + 0.6 * (1 - lakeFrac(nx, ny)));
        if (Lv[j] > cap) Lv[j] = cap;
      }
    }
    // soften the field once (keeps every tile's sign) so coasts curve instead of stepping
    const tmp = this._lvTmp || (this._lvTmp = new Float32Array(N));
    for (let y = 0; y < H; y++) {
      const ym = y > 0 ? y - 1 : 0, yp = y < H - 1 ? y + 1 : H - 1;
      for (let x = 0; x < W; x++) {
        const xm = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : W - 1;
        const i = y * W + x;
        let v = (Lv[ym * W + xm] + Lv[ym * W + xp] + Lv[yp * W + xm] + Lv[yp * W + xp]) * 0.0625 +
          (Lv[ym * W + x] + Lv[y * W + xm] + Lv[y * W + xp] + Lv[yp * W + x]) * 0.125 + Lv[i] * 0.25;
        // never let the blur swallow one-tile islands or straits
        const o = Lv[i];
        if (isLand[i]) { const lo = Math.max(MIN * 0.5, o * 0.5); if (v < lo) v = lo; }
        else { const hi = Math.min(-MIN * 0.5, o * 0.5); if (v > hi) v = hi; }
        tmp[i] = v;
      }
    }
    Lv.set(tmp);
  }

  /** Shore proximity for water tiles (1 next to land, fading over 3 tiles); land = 1. */
  computeShore() {
    const w = this.world, f = w.f, W = w.W, H = w.H, N = w.N, s = this.shoreT;
    const dist = new Uint8Array(N).fill(255);
    const q = new Int32Array(N); let qh = 0, qt = 0;
    for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND) { dist[i] = 0; q[qt++] = i; }
    while (qh < qt) {
      const i = q[qh++], d = dist[i];
      if (d >= 4) continue;
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx | dy) === 0 || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (dist[j] > d + 1) { dist[j] = d + 1; q[qt++] = j; }
      }
    }
    for (let i = 0; i < N; i++) {
      const d = dist[i];
      s[i] = d === 0 ? 1 : d === 1 ? 1 : d === 2 ? 0.5 : d === 3 ? 0.22 : d === 4 ? 0.08 : 0;
    }
  }

  _checkVeg() {
    const w = this.world, f = w.f, N = w.N;
    if (w.time.day - this._vegCheckDay < 30 && this._vegCheckDay >= 0) return;
    this._vegCheckDay = w.time.day;
    let s = 0, n = 0;
    const step = Math.max(1, (N / 997) | 0);
    for (let i = 0; i < N; i += step) if (f.water[i] === WATER.LAND) { s += f.veg[i]; n++; }
    this.vegMissing = n > 0 && s / n < 0.004;
  }

  /** Per-row seasonal crop colours (grain, pasture, fallow) for the local season. */
  _cropRow(y, lat) {
    const w = this.world;
    let ph = yearPhase(w) + (lat < 0 ? 0.5 : 0);
    ph -= Math.floor(ph);
    const tilt = clamp01((w.params?.axialTilt ?? 23) / 23);
    const seas = smoothstep(0.1, 0.42, Math.abs(lat)) * Math.min(1.3, tilt);
    const g = cropCycle(ph);
    const tropic = [150, 158, 82];
    const k = clamp01(seas);
    const c = this.crop, o = y * 9;
    c[o] = tropic[0] + (g[0] - tropic[0]) * k; c[o + 1] = tropic[1] + (g[1] - tropic[1]) * k; c[o + 2] = tropic[2] + (g[2] - tropic[2]) * k;
    // pasture: green most of the year, tawny in deep winter
    const winter = k * (0.5 + 0.5 * Math.cos(ph * Math.PI * 2)) * 0.8;
    c[o + 3] = 118 + (150 - 118) * winter; c[o + 4] = 150 + (132 - 150) * winter; c[o + 5] = 78 + (92 - 78) * winter;
    c[o + 6] = 150; c[o + 7] = 120; c[o + 8] = 86;
    return { ph, seas: k };
  }

  /**
   * Snow (or sea ice) at tile i softened by a 3×3 binomial kernel over tiles of the same
   * surface, so cover outlines come out round instead of following the tile grid.
   */
  _snowSoft(i, x, y, land) {
    const w = this.world, W = w.W, H = w.H, sn = w.f.snow, wa = w.f.water;
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      const wy = dy ? 1 : 2;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const j = yy * W + xx;
        if ((wa[j] === WATER.LAND) !== land) continue;
        const k = wy * (dx ? 1 : 2);
        s += sn[j] * k; n += k;
      }
    }
    const v = n > 0 ? s / n : sn[i];
    return v > 0 ? (v < 1 ? v : 1) : 0;
  }

  /** Land field `a` at tile i under a 3×3 binomial kernel over land tiles (soft marks). */
  _soft(a, i, x, y) {
    const w = this.world, W = w.W, H = w.H, wa = w.f.water;
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const j = yy * W + xx;
        if (wa[j] !== WATER.LAND) continue;
        const k = (dx ? 1 : 2) * (dy ? 1 : 2);
        s += a[j] * k; n += k;
      }
    }
    const v = n > 0 ? s / n : a[i];
    return v > 0 ? (v < 1 ? v : 1) : 0;
  }

  /** popDensity under a 3×3 binomial kernel (any surface), for rounder city glows. */
  _softPop(i, x, y) {
    const w = this.world, W = w.W, H = w.H, a = w.f.popDensity;
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const k = (dx ? 1 : 2) * (dy ? 1 : 2);
        const v = a[yy * W + xx];
        s += (v > 0 ? v : 0) * k; n += k;
      }
    }
    return n > 0 ? s / n : 0;
  }

  /** Compute per-tile colours for one tile row under the current style. */
  prepassRow(y) {
    const w = this.world, f = w.f, W = w.W, style = this.style;
    const sea = w.climate?.seaLevel ?? 0.5;
    const lat = latitude(w, y);
    const { ph, seas } = this._cropRow(y, lat);
    const autumn = seas * Math.max(0, 1 - Math.abs(ph - 0.84) / 0.11);
    const wintry = seas * smoothstep(0.72, 0.98, Math.abs(ph - 0.5) * 2);
    const tR = this.tR, tG = this.tG, tB = this.tB, wR = this.wR, wG = this.wG, wB = this.wB;
    const el = f.elevation, wa = f.water, bi = f.biome;
    const vegMissing = this.vegMissing;
    const sm = this.sm;
    const smVeg = sm.veg || f.veg, smSoil = sm.soilWater || f.soilWater;
    const smDepth = sm.depth || el;
    const bl = this.bl;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const water = wa[i] !== WATER.LAND;
      const e = el[i];
      const b = bi[i] < BIOMES.length ? bi[i] : BIOME.STEPPE;
      this.farmT[i] = 0; this.snowT[i] = 0; this.iceT[i] = 0;
      if (water) {
        const lake = wa[i] === WATER.LAKE;
        const d = lake ? 0.05 + (1 - this.shoreT[i]) * 0.12 : clamp01((sea - smDepth[i]) / Math.max(0.02, sea));
        let ramp;
        switch (style) {
          case 'natural': ramp = P.RAMPS.seaNatural; break;
          case 'elevation': ramp = P.RAMPS.seaHypso; break;
          case 'muted': case 'resources': case 'devastation': case 'pollution': ramp = P.RAMPS.seaMuted; break;
          default: ramp = P.RAMPS.seaData;
        }
        let k = Math.max(0, Math.min(255, (d * 255) | 0)) * 3;
        let r = ramp.lut[k], g = ramp.lut[k + 1], bb = ramp.lut[k + 2];
        if (style === 'temperature') {
          const tt = clamp01((f.temp[i] + 40) / 85);
          const kk = ((tt * 255) | 0) * 3, L = P.RAMPS.temperature.lut;
          r = L[kk] * 0.72; g = L[kk + 1] * 0.72; bb = L[kk + 2] * 0.76;
        } else if (style === 'fauna') {
          const kk = ((clamp01((sm.fish || f.fish)[i]) * 255) | 0) * 3, L = P.RAMPS.fish.lut;
          r = L[kk]; g = L[kk + 1]; bb = L[kk + 2];
        } else if (style === 'population') {
          r = 16 + d * 4; g = 22 + d * 4; bb = 34 + d * 8;
        } else if (style === 'plates') {
          const pc = P.plateColor(f.plate[i]);
          const s = clamp01(f.plateBoundary[i]);
          r = pc[0] * 0.5 + 64 * 0.5; g = pc[1] * 0.5 + 92 * 0.5; bb = pc[2] * 0.5 + 124 * 0.5;
          if (s > 0.05) { const m = s * s * 0.7; r += (150 - r) * m; g += (40 - g) * m; bb += (36 - bb) * m; }
        } else if (style === 'biome') {
          const c = P.BIOME_FLAT[d > 0.17 ? BIOME.DEEP_OCEAN : lake ? BIOME.LAKE : BIOME.OCEAN];
          r = c[0]; g = c[1]; bb = c[2];
        } else if (lake && style === 'natural') {
          r = 70 + 18 * this.shoreT[i]; g = 128 + 18 * this.shoreT[i]; bb = 152 + 10 * this.shoreT[i];
        }
        wR[i] = r; wG[i] = g; wB[i] = bb;
        // land colour under water corners is never sampled (weights renormalise), keep finite
        tR[i] = r; tG[i] = g; tB[i] = bb;
        if (this.styleSnow()) this.iceT[i] = this._snowSoft(i, x, y, false);
        continue;
      }
      // ---- land
      let r, g, bb;
      switch (style) {
        case 'natural': {
          const vmax = bl.vmax[i];
          const veg = vegMissing ? vmax * clamp01(0.35 + f.annRain[i] * 1.2) : smVeg[i];
          let v = clamp01(veg / vmax); v = Math.pow(v, 0.75);
          r = bl.br[i] + (bl.lr[i] - bl.br[i]) * v; g = bl.bg[i] + (bl.lg[i] - bl.bg[i]) * v; bb = bl.bb[i] + (bl.lb[i] - bl.bb[i]) * v;
          const sz = bl.seas[i];
          if (sz > 0) {
            const tC = f.temp[i];
            const cold = smoothstep(4, -6, tC) * 0.75 + wintry * 0.25;
            const a = autumn * sz * 0.55 * v;
            r += (P.AUTUMN[0] - r) * a; g += (P.AUTUMN[1] - g) * a; bb += (P.AUTUMN[2] - bb) * a;
            const c = cold * sz * 0.5;
            r += (P.WINTER_BROWN[0] - r) * c; g += (P.WINTER_BROWN[1] - g) * c; bb += (P.WINTER_BROWN[2] - bb) * c;
          }
          const gr = bl.grassy[i];
          if (gr > 0) {
            const dry = smoothstep(0.42, 0.08, smSoil[i]) * gr * 0.45;
            r += (P.STRAW[0] - r) * dry; g += (P.STRAW[1] - g) * dry; bb += (P.STRAW[2] - bb) * dry;
          }
          const wet = bl.wet[i];
          if (wet > 0) { r -= 6 * wet; g += 2 * wet; bb += 10 * wet; }
          const rk = smoothstep(0.7, 0.88, e) * 0.65;
          if (rk > 0) { r += (P.ROCK[0] - r) * rk; g += (P.ROCK[1] - g) * rk; bb += (P.ROCK[2] - bb) * rk; }
          const pop = f.popDensity[i];
          if (pop > 600) {
            const u = smoothstep(6.4, 10.5, Math.log(pop + 1)) * 0.7;
            r += (P.URBAN[0] - r) * u; g += (P.URBAN[1] - g) * u; bb += (P.URBAN[2] - bb) * u;
          }
          // burn scars and devastation as soft smudges: a lone scorched tile is a faint mark,
          // a burned-over country a dark swathe
          const bs = this._soft(f.burnScar, i, x, y);
          if (bs > 0.02) { const k = smoothstep(0.02, 0.55, bs) * 0.62; r += (P.CHARCOAL[0] - r) * k; g += (P.CHARCOAL[1] - g) * k; bb += (P.CHARCOAL[2] - bb) * k; }
          const dv = this._soft(f.devastation, i, x, y);
          if (dv > 0.02) { const k = smoothstep(0.02, 0.8, dv) * 0.5; r += (P.RUST[0] - r) * k; g += (P.RUST[1] - g) * k; bb += (P.RUST[2] - bb) * k; }
          const pl = f.pollution[i];
          if (pl > 0.01) { const k = clamp01(pl) * 0.55; r += (P.SMOG[0] - r) * k; g += (P.SMOG[1] - g) * k; bb += (P.SMOG[2] - bb) * k; }
          this.farmT[i] = f.farm[i];
          this.snowT[i] = this._snowSoft(i, x, y, true);
          // gentle hypsometric hint: uplands paler and browner
          const up = smoothstep(0.56, 0.74, e) * 0.28;
          r += (178 - r) * up; g += (164 - g) * up; bb += (136 - bb) * up;
          break;
        }
        case 'muted': case 'resources': case 'devastation': case 'pollution': {
          const pr = P.PARCHMENT;
          const hint = 0.16;
          r = pr[0] + (bl.lr[i] - pr[0]) * hint; g = pr[1] + (bl.lg[i] - pr[1]) * hint; bb = pr[2] + (bl.lb[i] - pr[2]) * hint;
          const hi = smoothstep(0.68, 0.92, e) * 0.18;
          r -= 40 * hi; g -= 44 * hi; bb -= 46 * hi;
          if (style === 'resources') {
            const m = Math.pow(clamp01(f.mineral[i]), 1.4) * 0.42;
            r += (192 - r) * m; g += (132 - g) * m; bb += (84 - bb) * m;
          } else if (style === 'devastation' || style === 'pollution') {
            const val = clamp01(style === 'devastation' ? f.devastation[i] : f.pollution[i]);
            if (val > 0.004) {
              const L = (style === 'devastation' ? P.RAMPS.devastation : P.RAMPS.pollution).lut;
              const kk = ((val * 255) | 0) * 3, a = 0.3 + 0.7 * Math.sqrt(val);
              r += (L[kk] - r) * a; g += (L[kk + 1] - g) * a; bb += (L[kk + 2] - bb) * a;
            }
          }
          if (style !== 'devastation' && style !== 'pollution') this.snowT[i] = this._snowSoft(i, x, y, true);
          break;
        }
        case 'elevation': {
          const t = clamp01((e - sea) / Math.max(0.05, 1 - sea));
          const kk = ((t * 255) | 0) * 3, L = P.RAMPS.landHypso.lut;
          r = L[kk]; g = L[kk + 1]; bb = L[kk + 2];
          break;
        }
        case 'temperature': {
          const t = clamp01((f.temp[i] + 40) / 85);
          const kk = ((t * 255) | 0) * 3, L = P.RAMPS.temperature.lut;
          r = L[kk]; g = L[kk + 1]; bb = L[kk + 2];
          break;
        }
        case 'rainfall': {
          const t = clamp01(Math.sqrt(clamp01(f.annRain[i])) * 1.0);
          const kk = ((t * 255) | 0) * 3, L = P.RAMPS.rainfall.lut;
          r = L[kk]; g = L[kk + 1]; bb = L[kk + 2];
          break;
        }
        case 'biome': {
          const c = P.BIOME_FLAT[b];
          r = c[0]; g = c[1]; bb = c[2];
          break;
        }
        case 'vegetation': {
          const vm = vegMissing ? BIOMES[b].vegMax * clamp01(0.35 + f.annRain[i] * 1.2) : smVeg[i];
          const kk = ((clamp01(vm) * 255) | 0) * 3, L = P.RAMPS.vegetation.lut;
          r = L[kk]; g = L[kk + 1]; bb = L[kk + 2];
          break;
        }
        case 'fauna': {
          const kk = ((clamp01((sm.herb || f.herb)[i] * 1.6) * 255) | 0) * 3, L = P.RAMPS.herb.lut;
          r = L[kk]; g = L[kk + 1]; bb = L[kk + 2];
          const pk = clamp01((sm.pred || f.pred)[i] * 12) * 0.62;
          r += (178 - r) * pk; g += (54 - g) * pk; bb += (42 - bb) * pk;
          break;
        }
        case 'population': {
          const pop = Math.max(f.popDensity[i] * 0.6, this._softPop(i, x, y));
          const t = pop > 0.5 ? clamp01(Math.log10(1 + pop) / 5.2) : 0;
          const base = 46 + 10 * smoothstep(0.55, 0.9, e);
          if (t > 0.02) {
            const kk = ((t * 255) | 0) * 3, L = P.RAMPS.population.lut;
            r = L[kk]; g = L[kk + 1]; bb = L[kk + 2];
          } else { r = base - 6; g = base - 2; bb = base + 12; }
          break;
        }
        case 'plates': {
          const pc = P.plateColor(f.plate[i]);
          r = pc[0]; g = pc[1]; bb = pc[2];
          const s = clamp01(f.plateBoundary[i]);
          if (s > 0.05) { const m = s * s * 0.75; r += (168 - r) * m; g += (44 - g) * m; bb += (36 - bb) * m; }
          break;
        }
        default: { const c = P.LUSH[b]; r = c[0]; g = c[1]; bb = c[2]; }
      }
      tR[i] = r; tG[i] = g; tB[i] = bb;
      wR[i] = r; wG[i] = g; wB[i] = bb;
    }
    this.rowTime[y] = this._now;
  }

  styleSnow() { return STYLES[this.style].snow; }

  /** Paint the T pixel rows of tile row ty from the prepass data. */
  paintRow(ty) {
    const w = this.world, W = w.W, H = w.H, T = this.T, cw = this.cw;
    const st = STYLES[this.style];
    const buf = this.buf, noise = this.noise, noiseC = this.noiseC;
    const colX0 = this.colX0, colX1 = this.colX1, colFx = this.colFx;
    const Lv = this.Lv, isL = this.isLand, shade = this.shade, shore = this.shoreT;
    const tR = this.tR, tG = this.tG, tB = this.tB, wR = this.wR, wG = this.wG, wB = this.wB;
    const farmT = this.farmT, snowT = this.snowT, iceT = this.iceT, rug = this.rug;
    const nearest = st.nearest, farmOn = st.farm, snowOn = st.snow, snowA = st.snowA;
    const shadeL = st.shadeL, shadeW = st.shadeW, grainL = st.grainL, grainW = st.grainW, rimK = st.rim, reliefK = st.relief;
    const RS = this.relief.S, rShade = this.relief.shade, rRank = this.relief.rank, colRel = this.colRel;
    const natural = this.style === 'natural';
    const PS = T >= 6 ? 3 : 2;
    const hedge = T >= 5;
    const crop = this.crop;
    const rimR = natural ? 150 : 214, rimG = natural ? 198 : 224, rimB = natural ? 192 : 220;
    const lineR = natural ? 212 : 236, lineG = natural ? 230 : 236, lineB = natural ? 218 : 226;
    const snowR = P.SNOW[0], snowG = P.SNOW[1], snowB = P.SNOW[2];
    // shadow tint (× shading deficit): natural maps take a blue-violet slate, muted ones paler
    const shR = natural ? 30 : 58, shG = natural ? 34 : 60, shB = natural ? 58 : 78;
    for (let sub = 0; sub < T; sub++) {
      const py = ty * T + sub;
      const v = (py + 0.5) / T - 0.5;
      let y0 = Math.floor(v); const fy = v - y0;
      let y1 = y0 + 1;
      if (y0 < 0) y0 = 0; if (y1 > H - 1) y1 = H - 1; if (y0 > H - 1) y0 = H - 1;
      const r0 = y0 * W, r1 = y1 * W;
      const co = ty * 9;
      const nrow = (py & 255) << 8;
      const rrow = (py % RS) * RS;
      const irow = ((py + (RS >> 1)) % RS) * RS;
      let o = py * cw;
      for (let px = 0; px < cw; px++, o++) {
        const x0 = colX0[px], x1 = colX1[px], fx = colFx[px];
        const a = r0 + x0, b = r0 + x1, c = r1 + x0, d = r1 + x1;
        const gx = 1 - fx, gy = 1 - fy;
        const w00 = gx * gy, w10 = fx * gy, w01 = gx * fy, w11 = fx * fy;
        const L = Lv[a] * w00 + Lv[b] * w10 + Lv[c] * w01 + Lv[d] * w11;
        const nz = noise[nrow | (px & 255)];
        let R, G, B, m;
        if (L >= 0) {
          let la = isL[a] * w00, lb = isL[b] * w10, lc = isL[c] * w01, ld = isL[d] * w11;
          let ws = la + lb + lc + ld;
          if (ws < 1e-6) { la = w00; lb = w10; lc = w01; ld = w11; ws = 1; }
          const inv = 1 / ws;
          if (nearest) {
            // categorical maps: a sharpened blend (weights⁴) keeps classes crisp but rounds
            // the corners that plain nearest-tile sampling would leave as squares
            const qa = la * la * la * la, qb = lb * lb * lb * lb, qc = lc * lc * lc * lc, qd = ld * ld * ld * ld;
            const qi = 1 / Math.max(1e-12, qa + qb + qc + qd);
            R = (tR[a] * qa + tR[b] * qb + tR[c] * qc + tR[d] * qd) * qi;
            G = (tG[a] * qa + tG[b] * qb + tG[c] * qc + tG[d] * qd) * qi;
            B = (tB[a] * qa + tB[b] * qb + tB[c] * qc + tB[d] * qd) * qi;
          } else {
            R = (tR[a] * la + tR[b] * lb + tR[c] * lc + tR[d] * ld) * inv;
            G = (tG[a] * la + tG[b] * lb + tG[c] * lc + tG[d] * ld) * inv;
            B = (tB[a] * la + tB[b] * lb + tB[c] * lc + tB[d] * ld) * inv;
          }
          const sh = (shade[a] * la + shade[b] * lb + shade[c] * lc + shade[d] * ld) * inv;
          const ro = rrow + colRel[px];
          const rg = (rug[a] * la + rug[b] * lb + rug[c] * lc + rug[d] * ld) * inv;
          let rel = rShade[ro] * rg * reliefK;
          if (farmOn) {
            const F = (farmT[a] * la + farmT[b] * lb + farmT[c] * lc + farmT[d] * ld) * inv;
            if (F > 0.03) {
              const qx = (px / PS) | 0, qy = (py / PS) | 0;
              let h = Math.imul(qx, 0x27d4eb2d) ^ Math.imul(qy, 0x165667b1);
              h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h >>>= 0;
              if ((h & 1023) < F * 1250) {
                const typ = (h >>> 10) % 7;
                const ci = co + (typ < 4 ? 0 : typ < 6 ? 3 : 6);
                const jit = 1 + ((((h >>> 14) & 63) / 63) - 0.5) * 0.18;
                const edge = hedge && (px % PS === 0 || py % PS === 0) ? 0.84 : 1;
                const k = 0.86 * smoothstep(0.03, 0.25, F);
                R += (crop[ci] * jit * edge - R) * k;
                G += (crop[ci + 1] * jit * edge - G) * k;
                B += (crop[ci + 2] * jit * edge - B) * k;
              }
            }
          }
          let snowK = 0;
          if (snowOn) {
            const S = (snowT[a] * la + snowT[b] * lb + snowT[c] * lc + snowT[d] * ld) * inv;
            if (S > 0.004) {
              // partial cover lies on the high ground of the micro-relief first, so thin
              // snow reads as streaks on ridges and a full cover as an unbroken mantle
              // (in the hills by the relief's crests, on the plains in soft drifts)
              const wr = rg * 0.85;
              const q = 1 - (rRank[ro] * wr + (noiseC[nrow | (px & 255)] * 0.75 + 0.5) * (1 - wr));
              let k = (S * 1.1 - q) * (4 + 6 * rg) + 0.5;
              if (k > 0) {
                if (k > 1) k = 1;
                k = k * k * (3 - 2 * k);
                snowK = k;
                k *= snowA;
                R += (snowR - R) * k; G += (snowG - G) * k; B += (snowB - B) * k;
                if (natural) rel *= 1 + snowK * 0.4;
              }
            }
          }
          if (natural && snowK < 0.5) {
            const v = (rRank[ro] - 0.5) * 0.16;
            R += (R * 0.25 + 30) * v; G += (G * 0.12 + 22) * v; B += (B * 0.1 + 14) * v;
          }
          m = 1 + (sh - 1) * shadeL + rel + nz * grainL;
          // shadowed snow takes a cold blue cast
          if (snowK > 0 && m < 1) { const c = (1 - m) * snowK * snowA; R -= 26 * c; G -= 8 * c; B += 20 * c; }
        } else {
          let la = (1 - isL[a]) * w00, lb = (1 - isL[b]) * w10, lc = (1 - isL[c]) * w01, ld = (1 - isL[d]) * w11;
          let ws = la + lb + lc + ld;
          if (ws < 1e-6) { la = w00; lb = w10; lc = w01; ld = w11; ws = 1; }
          const inv = 1 / ws;
          R = (wR[a] * la + wR[b] * lb + wR[c] * lc + wR[d] * ld) * inv;
          G = (wG[a] * la + wG[b] * lb + wG[c] * lc + wG[d] * ld) * inv;
          B = (wB[a] * la + wB[b] * lb + wB[c] * lc + wB[d] * ld) * inv;
          const sh = (shade[a] * la + shade[b] * lb + shade[c] * lc + shade[d] * ld) * inv;
          if (rimK > 0) {
            const so = shore[a] * w00 + shore[b] * w10 + shore[c] * w01 + shore[d] * w11;
            const k1 = so * so * 0.34 * rimK;
            R += (rimR - R) * k1; G += (rimG - G) * k1; B += (rimB - B) * k1;
            let q = 1 + L * 6.5; if (q < 0) q = 0;
            const k2 = q * q * 0.42 * rimK;
            R += (lineR - R) * k2; G += (lineG - G) * k2; B += (lineB - B) * k2;
          }
          let iceRel = 0, iceK = 0;
          if (snowOn) {
            const I = (iceT[a] * la + iceT[b] * lb + iceT[c] * lc + iceT[d] * ld) * inv;
            if (I > 0.04) {
              // pack ice: an unbroken sheet where cover is full, breaking into floes with
              // dark leads toward its margin (soft blotches + a little fine relief)
              const io = irow + colRel[px];
              const q = 0.42 + noiseC[nrow | (px & 255)] * 0.5 + (rRank[io] - 0.5) * 0.05;
              let k = (I * 1.18 - q) * 4 + 0.5;
              if (k > 0) {
                if (k > 1) k = 1;
                const edge = 1 - Math.abs(k - 0.5) * 2;
                k = k * k * (3 - 2 * k) * snowA;
                iceK = k;
                R += (224 - R) * k; G += (233 - G) * k; B += (240 - B) * k;
                if (edge > 0.4) { const dk = 1 - (edge - 0.4) * 0.22 * snowA; R *= dk; G *= dk; B *= dk; }
                iceRel = rShade[io] * 0.025 * k;
              }
            }
          }
          // the sea floor's relief does not show through pack ice
          m = 1 + (sh - 1) * shadeW * (1 - iceK) + iceRel + nz * grainW * (1 - iceK * 0.6);
        }
        if (m < 0.45) m = 0.45; else if (m > 1.5) m = 1.5;
        // shadows fall toward a cool slate instead of black; lights lift toward paper white
        let r, g, bl;
        if (m < 1) { const d = 1 - m; r = R * m + d * shR; g = G * m + d * shG; bl = B * m + d * shB; }
        else { const d = (m - 1) * 0.62; r = R + (255 - R) * d + R * d * 0.25; g = G + (255 - G) * d + G * d * 0.2; bl = B + (255 - B) * d * 0.9; }
        r = r < 0 ? 0 : r > 255 ? 255 : r;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        bl = bl < 0 ? 0 : bl > 255 ? 255 : bl;
        buf[o] = 0xff000000 | (bl << 16) | (g << 8) | r;
      }
    }
  }

  _refresh(y) {
    const H = this.world.H, now = this._now;
    for (let r = y - 1; r <= y + 1; r++) {
      if (r < 0 || r >= H) continue;
      if (now - this.rowTime[r] > 40) this.prepassRow(r);
    }
    this.paintRow(y);
    if (this.dirty[y] === 2) this.urgent--;
    this.dirty[y] = 0;
    this.rowDay[y] = this.world.time.day;
    this._lo = Math.min(this._lo, y); this._hi = Math.max(this._hi, y);
    this._rows.push(y);
  }

  _flush() {
    if (!this._rows.length) return;
    const T = this.T;
    const rows = this._rows.sort((a, b) => a - b);
    let s = rows[0], p = rows[0];
    const put = (a, b) => this.ctx.putImageData(this.img, 0, 0, 0, a * T, this.cw, (b - a + 1) * T);
    for (let k = 1; k < rows.length; k++) {
      if (rows[k] === p + 1 || rows[k] === p) { p = rows[k]; continue; }
      put(s, p); s = p = rows[k];
    }
    put(s, p);
    this._rows.length = 0;
    this.version++;
  }

  /** Synchronous full repaint (first frame, previews). */
  buildAll() {
    this._now = nowMs();
    this._rows = []; this._lo = 1e9; this._hi = -1;
    this.syncStatic();
    this.syncBiomes();
    this._checkVeg();
    this._smoothFields(true);
    const H = this.world.H;
    for (let y = 0; y < H; y++) this.prepassRow(y);
    for (let y = 0; y < H; y++) {
      this.paintRow(y);
      this.dirty[y] = 0; this.rowDay[y] = this.world.time.day;
    }
    this.urgent = 0;
    this.ctx.putImageData(this.img, 0, 0);
    this.version++;
  }

  /**
   * Incremental refresh under a time budget. vis = [y0, y1] visible tile rows.
   * Urgent rows (style switch, terrain edits) go first, then two sweeps (visible / global)
   * repaint rows whose day is stale so seasons roll smoothly across the map.
   */
  update(budgetMs = 3, vis = null, urgentBudgetMs = 12) {
    const t0 = nowMs();
    this._now = t0;
    this._rows = this._rows || []; this._lo = 1e9; this._hi = -1;
    this.syncStatic();
    this.syncBiomes();
    this._checkVeg();
    this._smoothFields(this.urgent > 0 && !this._smStyle);
    this._smStyle = this.style;
    const w = this.world, H = w.H, day = w.time.day;
    const vy0 = vis ? Math.max(0, vis[0]) : 0, vy1 = vis ? Math.min(H - 1, vis[1]) : H - 1;
    if (this.urgent > 0) {
      const lim = Math.max(budgetMs, urgentBudgetMs);
      for (let y = vy0; y <= vy1 && nowMs() - t0 < lim; y++) if (this.dirty[y] === 2) this._refresh(y);
      for (let y = 0; y < H && nowMs() - t0 < lim; y++) if (this.dirty[y] === 2) this._refresh(y);
    }
    // seasonal sweep: only rows whose content is older than the current day
    let guard = 0, turn = 0;
    while (nowMs() - t0 < budgetMs && guard < H * 2) {
      guard++;
      let y;
      if ((turn++ & 1) === 0 && vy1 >= vy0) {
        this.visY = this.visY < vy0 || this.visY > vy1 ? vy0 : this.visY;
        y = this.visY++;
        if (this.visY > vy1) this.visY = vy0;
      } else {
        y = this.sweepY++;
        if (this.sweepY >= H) this.sweepY = 0;
      }
      if (this.rowDay[y] === day && this.dirty[y] === 0) continue;
      this._refresh(y);
    }
    this._flush();
    this.lastWork = nowMs() - t0;
  }
}

// ---------------------------------------------------------------------------
// The ground pass

let TOOTH = null;
/**
 * A 256 × 256 tileable "tooth" texture: the fibre of laid paper — fine speckle with faint
 * horizontal chain lines and a little soft mottling — as texels of ink (dark) and light at
 * low alpha, so it can be laid over any picture with plain source-over.
 */
function toothTexture() {
  if (TOOTH) return TOOTH;
  const S = 256;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  const soft = (cells, seed) => {
    const gr = new Float32Array(cells * cells);
    for (let k = 0; k < gr.length; k++) gr[k] = hash2i(k % cells, (k / cells) | 0, seed) / 4294967296 * 2 - 1;
    return (x, y) => {
      const u = (x / S) * cells, v = (y / S) * cells;
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const a = gr[(y0 % cells) * cells + (x0 % cells)], b = gr[(y0 % cells) * cells + ((x0 + 1) % cells)];
      const cc = gr[((y0 + 1) % cells) * cells + (x0 % cells)], dd = gr[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
      return (a + (b - a) * sx) * (1 - sy) + (cc + (dd - cc) * sx) * sy;
    };
  };
  const m1 = soft(8, 401), m2 = soft(32, 409);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const fib = hash2i(x, y, 991) / 4294967296 * 2 - 1;
    const fib2 = hash2i(x >> 1, y, 997) / 4294967296 * 2 - 1;     // fibres stretch a little along x
    const chain = (y % 32 === 0 ? -0.18 : 0);
    const v = fib * 0.42 + fib2 * 0.28 + m2(x, y) * 0.18 + m1(x, y) * 0.12 + chain;
    const o = (y * S + x) * 4;
    const lite = v > 0;
    d[o] = lite ? 255 : 36; d[o + 1] = lite ? 252 : 30; d[o + 2] = lite ? 242 : 22; d[o + 3] = Math.min(255, Math.abs(v) * 255);
  }
  g.putImageData(img, 0, 0);
  TOOTH = { canvas: c, S, patterns: new WeakMap() };
  return TOOTH;
}

/**
 * The ground: the terrain raster over the visible tiles (entity-coordinate world transform
 * set by the caller), upscaled with the smoothing its magnification calls for; once the raster
 * is magnified, a relief-and-fibre tooth laid over it at the zoom's octave (two octaves cross-
 * faded, each a quarter of the next's texel), so deep zoom shows grain instead of blur.
 * vb: visible tile range; z: CSS px per tile; dpr: device pixel ratio.
 */
export function paintGround(ctx, terr, vb, z, dpr, opts = {}) {
  const T = terr.T;
  const sx0 = Math.max(0, Math.min(terr.cw, Math.floor(vb.x0 * T) - T)), sx1 = Math.max(0, Math.min(terr.cw, Math.ceil((vb.x1 + 1) * T) + T));
  const sy0 = Math.max(0, Math.min(terr.ch, Math.floor(vb.y0 * T) - T)), sy1 = Math.max(0, Math.min(terr.ch, Math.ceil((vb.y1 + 1) * T) + T));
  if (!(sx1 > sx0 && sy1 > sy0)) return;
  const mag = (z * dpr) / T;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = mag < 0.55 ? 'medium' : 'low';   // ('high' resamples on the CPU: far too slow for a full-screen upscale)
  ctx.drawImage(terr.canvas, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0 / T - 0.5, sy0 / T - 0.5, (sx1 - sx0) / T, (sy1 - sy0) / T);
  const k = (opts.tooth ?? 1) * smoothstep(2, 4.5, mag);
  if (k <= 0.01 || typeof ctx.createPattern !== 'function') return;
  const tooth = toothTexture();
  let pat = tooth.patterns.get(ctx);
  if (!pat) { pat = ctx.createPattern(tooth.canvas, 'repeat'); if (!pat) return; tooth.patterns.set(ctx, pat); }
  if (typeof pat.setTransform !== 'function' || typeof DOMMatrix === 'undefined') return;
  // texel ≈ 1.2–2.4 device px: o = log2 of device px per tile / 1.2
  const lo = Math.log2(Math.max(1, (z * dpr) / 1.2));
  const o0 = Math.floor(lo), fr = lo - o0;
  const x0 = vb.x0 - 1.5, y0 = vb.y0 - 1.5, w = vb.x1 - vb.x0 + 3, h = vb.y1 - vb.y0 + 3;
  for (const [o, a] of [[o0, 1 - fr], [o0 + 1, fr]]) {
    if (a <= 0.02) continue;
    const s = 1 / Math.pow(2, o);               // tiles per texel
    pat.setTransform(new DOMMatrix([s, 0, 0, s, -0.5, -0.5]));
    ctx.globalAlpha = 0.16 * k * a;
    ctx.fillStyle = pat;
    ctx.fillRect(x0, y0, w, h);
  }
  ctx.globalAlpha = 1;
}

/** Seasonal crop colours (grain, pasture, fallow: 9 numbers into out) for local year phase ph at latitude lat. */
export function cropColors(world, lat, ph, out = new Float32Array(9)) {
  const tilt = clamp01((world.params?.axialTilt ?? 23) / 23);
  const seas = clamp01(smoothstep(0.1, 0.42, Math.abs(lat)) * Math.min(1.3, tilt));
  const g = cropCycle(ph);
  const tropic = [150, 158, 82];
  out[0] = tropic[0] + (g[0] - tropic[0]) * seas; out[1] = tropic[1] + (g[1] - tropic[1]) * seas; out[2] = tropic[2] + (g[2] - tropic[2]) * seas;
  const winter = seas * (0.5 + 0.5 * Math.cos(ph * Math.PI * 2)) * 0.8;
  out[3] = 118 + (150 - 118) * winter; out[4] = 150 + (132 - 150) * winter; out[5] = 78 + (92 - 78) * winter;
  out[6] = 150; out[7] = 120; out[8] = 86;
  return out;
}

/** Grain field colour through the local year (0 = midwinter, 0.5 = midsummer). */
const CROP_KEYS = [
  [0.0, [138, 112, 82]], [0.17, [142, 116, 82]], [0.27, [140, 150, 88]], [0.36, [110, 156, 72]],
  [0.48, [120, 152, 62]], [0.6, [184, 174, 84]], [0.68, [214, 184, 96]], [0.76, [190, 160, 104]],
  [0.86, [146, 114, 80]], [1.0, [138, 112, 82]],
];
function cropCycle(ph) {
  let j = 0;
  while (j < CROP_KEYS.length - 2 && ph > CROP_KEYS[j + 1][0]) j++;
  const [t0, c0] = CROP_KEYS[j], [t1, c1] = CROP_KEYS[j + 1];
  const u = t1 > t0 ? clamp01((ph - t0) / (t1 - t0)) : 0;
  return [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
}

/** Horizontal running-sum box filter of radius R (sums, not means; clamped at edges). */
export function boxH(a, out, W, H, R) {
  for (let y = 0; y < H; y++) {
    const o = y * W;
    let s = 0;
    for (let x = -R; x <= R; x++) s += a[o + (x < 0 ? 0 : x >= W ? W - 1 : x)];
    for (let x = 0; x < W; x++) {
      out[o + x] = s;
      const add = x + R + 1, sub = x - R;
      s += a[o + (add >= W ? W - 1 : add)] - a[o + (sub < 0 ? 0 : sub)];
    }
  }
}
/** Vertical running-sum box filter of radius R. */
export function boxV(a, out, W, H, R) {
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = -R; y <= R; y++) s += a[(y < 0 ? 0 : y >= H ? H - 1 : y) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = s;
      const add = y + R + 1, sub = y - R;
      s += a[(add >= H ? H - 1 : add) * W + x] - a[(sub < 0 ? 0 : sub) * W + x];
    }
  }
}
