// Territory raster: categorical regions (nations, faiths, cultures, eras, plague zones)
// painted at F px per tile with rounded edges (a Gaussian vote over the surrounding tiles),
// a translucent wash and a soft inner glow along every border (two chamfer distance
// transforms: to other regions and to the coast). Also computes label anchors (deepest
// interior tile + principal axis) for each region. Shares the terrain layer's land/water
// field so tints stop at the coast.
//
// Rebuilds are time-sliced: a build runs as a generator over a few frames under a time
// budget, so a busy world (borders changing every month at Max speed) never stalls a frame.
// The canvas keeps the previous picture until the new one is complete.

import { makeCanvas } from './terrain.js';

export const WATER_CAT = -2;
export const NONE_CAT = -1;
const TAPS = 6;          // vote kernel taps per axis
const SIGMA = 1.05;      // vote kernel width (tiles)
const nowMs = () => (globalThis.performance ? performance.now() : 0);

export function pickFpx(N) {
  return Math.max(2, Math.min(5, Math.round(Math.sqrt(6.6e5 / Math.max(1, N)))));
}

/** Normalised Gaussian weights for taps at offsets -2..3 from the sample at fraction t. */
function gaussTaps(t, out, o) {
  let s = 0;
  for (let k = 0; k < TAPS; k++) {
    const d = k - 2 - t;
    const w = Math.exp(-(d * d) / (2 * SIGMA * SIGMA));
    out[o + k] = w; s += w;
  }
  for (let k = 0; k < TAPS; k++) out[o + k] /= s;
}

/**
 * Sub-tile category map: each of the F×F pixels of a tile takes the category that wins a
 * Gaussian-weighted vote of the 6×6 surrounding land tiles, and pixels on the water side
 * of the coast field (Lv < 0) are WATER_CAT. Region outlines come out as smooth curves.
 */
export class CategoryVote {
  constructor(W, H, F) {
    this.W = W; this.H = H; this.F = F;
    const cw = (this.cw = W * F), ch = (this.ch = H * F);
    this.pix = new Int32Array(cw * ch);
    this.uni = new Uint8Array(W * H);
    this.colX0 = new Int32Array(cw); this.colX1 = new Int32Array(cw); this.colFx = new Float32Array(cw);
    this.colTap = new Int32Array(cw * TAPS); this.colWt = new Float32Array(cw * TAPS);
    for (let px = 0; px < cw; px++) {
      const u = (px + 0.5) / F - 0.5;
      let x0 = Math.floor(u); const fx = u - x0;
      let x1 = x0 + 1;
      for (let k = 0; k < TAPS; k++) this.colTap[px * TAPS + k] = Math.max(0, Math.min(W - 1, x0 - 2 + k));
      gaussTaps(fx, this.colWt, px * TAPS);
      if (x0 < 0) x0 = 0; if (x1 > W - 1) x1 = W - 1; if (x0 > W - 1) x0 = W - 1;
      this.colX0[px] = x0; this.colX1[px] = x1; this.colFx[px] = fx;
    }
    this.cs = new Int32Array(TAPS * TAPS); this.ws = new Float32Array(TAPS * TAPS);
    this.rowTap = new Int32Array(TAPS); this.rowWt = new Float32Array(TAPS);
  }

  /** Mark tiles whose 5×5 neighbourhood holds one category (fast path for interiors). */
  prepare(cat) {
    const W = this.W, H = this.H, uni = this.uni;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, c = cat[i];
        let u = 1;
        for (let dy = -2; dy <= 2 && u; dy++) {
          const yy = y + dy < 0 ? 0 : y + dy >= H ? H - 1 : y + dy;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx < 0 ? 0 : x + dx >= W ? W - 1 : x + dx;
            const k = cat[yy * W + xx];
            if (k !== c && k !== WATER_CAT) { u = 0; break; }
          }
        }
        uni[i] = u;
      }
    }
  }

  /** Vote pixel rows [py0, py1). Call prepare(cat) first. */
  rows(cat, Lv, py0, py1) {
    const W = this.W, H = this.H, F = this.F, cw = this.cw, pix = this.pix, uni = this.uni;
    const colX0 = this.colX0, colX1 = this.colX1, colFx = this.colFx, colTap = this.colTap, colWt = this.colWt;
    const cs = this.cs, ws = this.ws, rowTap = this.rowTap, rowWt = this.rowWt;
    for (let py = py0; py < py1; py++) {
      const v = (py + 0.5) / F - 0.5;
      let y0 = Math.floor(v); const fy = v - y0;
      for (let k = 0; k < TAPS; k++) rowTap[k] = Math.max(0, Math.min(H - 1, y0 - 2 + k)) * W;
      gaussTaps(fy, rowWt, 0);
      let y1 = y0 + 1;
      if (y0 < 0) y0 = 0; if (y1 > H - 1) y1 = H - 1; if (y0 > H - 1) y0 = H - 1;
      const r0 = y0 * W, r1 = y1 * W;
      let o = py * cw;
      for (let px = 0; px < cw; px++, o++) {
        const x0 = colX0[px], x1 = colX1[px], fx = colFx[px];
        const a = r0 + x0, b = r0 + x1, c = r1 + x0, d = r1 + x1;
        const L = Lv[a] * (1 - fx) * (1 - fy) + Lv[b] * fx * (1 - fy) + Lv[c] * (1 - fx) * fy + Lv[d] * fx * fy;
        if (L < 0) { pix[o] = WATER_CAT; continue; }
        const ca = cat[a];
        if (ca === cat[b] && ca === cat[c] && ca === cat[d] && uni[a] & uni[b] & uni[c] & uni[d]) { pix[o] = ca === WATER_CAT ? NONE_CAT : ca; continue; }
        let n = 0;
        const ct = px * TAPS;
        for (let ky = 0; ky < TAPS; ky++) {
          const rt = rowTap[ky], wy = rowWt[ky];
          for (let kx = 0; kx < TAPS; kx++) {
            const k = cat[rt + colTap[ct + kx]];
            if (k === WATER_CAT) continue;
            const wt = wy * colWt[ct + kx];
            let m = 0;
            while (m < n && cs[m] !== k) m++;
            if (m === n) { cs[n] = k; ws[n] = wt; n++; } else ws[m] += wt;
          }
        }
        let best = NONE_CAT, bw = -1;
        for (let m = 0; m < n; m++) if (ws[m] > bw) { bw = ws[m]; best = cs[m]; }
        pix[o] = best;
      }
    }
  }

  /** Vote every row at once. */
  all(cat, Lv) { this.prepare(cat); this.rows(cat, Lv, 0, this.ch); return this.pix; }
}

export class TerritoryLayer {
  constructor(world, terrain) {
    this.world = world;
    this.terrain = terrain;
    const W = world.W, H = world.H, N = world.N;
    const F = (this.F = pickFpx(N));
    this.cw = W * F; this.ch = H * F;
    this.canvas = makeCanvas(this.cw, this.ch);
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(this.cw, this.ch);
    this.buf = new Uint32Array(this.img.data.buffer);
    const P = this.cw * this.ch;
    this.vote = new CategoryVote(W, H, F);
    this.pix = this.vote.pix;
    this.d1 = new Float32Array(P);
    this.d2 = new Float32Array(P);
    this.cat = new Int32Array(N);
    this.B = 16;
    this.runs = [];
    this.key = null;
    this.job = null;
    this.lastBuild = -1e9;
    this.anchors = new Map();
    this.empty = true;
    this.version = 0;
    this.lastCost = 0;
    this.busyMs = 0;
  }

  /**
   * Keep the raster in step with `spec` = { key, catFn(i) → category, colorFn(cat) →
   * [r,g,b,a?] | null, fillA, glowA, glowTiles, coastK }. A new key starts a time-sliced
   * rebuild (at most every `minInterval` ms); `budgetMs` of it runs per call. The first
   * build, or `force`, completes synchronously.
   */
  update(spec, force = false, minInterval = 350, budgetMs = 4) {
    if (!spec) { this.empty = true; this.key = null; this.job = null; return false; }
    const now = nowMs();
    if (!this.job) {
      if (spec.key === this.key) return false;
      if (!force && !this.empty && now - this.lastBuild < minInterval) return false;
      this.job = { key: spec.key, it: this._steps(spec), work: 0 };
    } else if (force && this.job.key !== spec.key) {
      this.job = { key: spec.key, it: this._steps(spec), work: 0 };
    }
    const job = this.job;
    const sync = force || this.empty;
    const t0 = nowMs();
    let done = false;
    for (;;) {
      const r = job.it.next();
      if (r.done) { done = true; break; }
      if (!sync && nowMs() - t0 >= budgetMs) break;
    }
    const spent = nowMs() - t0;
    job.work += spent;
    this.busyMs = spent;
    if (!done) return false;
    this.job = null;
    this.key = job.key;
    this.lastBuild = nowMs();
    this.lastCost = job.work;
    this.empty = false;
    this.version++;
    return true;
  }

  /** The rebuild, as a sequence of slices (each yield is a safe pause point). */
  * _steps(spec) {
    const w = this.world, W = w.W, H = w.H, N = w.N, F = this.F, cw = this.cw, ch = this.ch;
    const cat = this.cat, vote = this.vote, pix = this.pix;
    const isLand = this.terrain.isLand, Lv = this.terrain.Lv;
    // 1. tile categories (a snapshot: the world may move on while we paint)
    for (let i = 0; i < N; i++) {
      if (isLand[i] < 0.5) { cat[i] = WATER_CAT; continue; }
      const c = spec.catFn(i);
      cat[i] = c == null || !(c >= 0) ? NONE_CAT : c;
    }
    // 2. colour lookup per category (cached per build)
    const colors = new Map();
    const colorOf = (c) => {
      let v = colors.get(c);
      if (v === undefined) {
        const rgb = c >= 0 ? spec.colorFn(c) : null;
        v = rgb && Number.isFinite(rgb[0]) ? [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0, Number.isFinite(rgb[3]) ? rgb[3] : 1] : null;
        colors.set(c, v);
      }
      return v;
    };
    vote.prepare(cat);
    yield;
    // 3. pixel categories
    const SL = 24;
    for (let py = 0; py < ch; py += SL) { vote.rows(cat, Lv, py, Math.min(ch, py + SL)); yield; }
    // 4. distance transforms: d1 to a different land region, d2 to the coast
    const glowPx = Math.max(1, (spec.glowTiles || 2) * F);
    const coastK = spec.coastK ?? 0.5;
    const BIG = 1e6;
    const d1 = this.d1, d2 = this.d2;
    const P = cw * ch;
    for (let o = 0; o < P; o++) {
      const c = pix[o];
      if (c < 0) { d1[o] = BIG; d2[o] = BIG; continue; }
      const x = o % cw;
      let edge = false, coast = false, k;
      if (x > 0) { k = pix[o - 1]; if (k === WATER_CAT) coast = true; else if (k !== c) edge = true; }
      if (x < cw - 1) { k = pix[o + 1]; if (k === WATER_CAT) coast = true; else if (k !== c) edge = true; }
      if (o >= cw) { k = pix[o - cw]; if (k === WATER_CAT) coast = true; else if (k !== c) edge = true; }
      if (o < P - cw) { k = pix[o + cw]; if (k === WATER_CAT) coast = true; else if (k !== c) edge = true; }
      d1[o] = edge ? 0.5 : BIG;
      d2[o] = coast ? 0.5 : BIG;
    }
    yield;
    yield* chamfer(d1, pix, cw, ch, glowPx + 2);
    if (coastK > 0) yield* chamfer(d2, pix, cw, ch, glowPx + 2);
    // 5. paint
    const buf = this.buf;
    const fillA = spec.fillA ?? 0.3, glowA = spec.glowA ?? 0.5;
    for (let py = 0; py < ch; py += SL * 2) {
      const oEnd = Math.min(ch, py + SL * 2) * cw;
      for (let o = py * cw; o < oEnd; o++) {
        const c = pix[o];
        if (c < 0) { buf[o] = 0; continue; }
        const col = colorOf(c);
        if (!col) { buf[o] = 0; continue; }
        let g = 0;
        const e1 = d1[o];
        if (e1 < glowPx) { const t = 1 - e1 / glowPx; g = t * t; }
        if (coastK > 0) {
          const e2 = d2[o];
          if (e2 < glowPx) { const t = 1 - e2 / glowPx; const g2 = t * t * coastK; if (g2 > g) g = g2; }
        }
        let a = (fillA + glowA * g) * col[3];
        if (!(a > 0)) a = 0; else if (a > 1) a = 1;
        const ai = (a * 255) | 0;
        buf[o] = ((ai << 24) | (col[2] << 16) | (col[1] << 8) | col[0]) >>> 0;
      }
      yield;
    }
    // runs of B×B-tile blocks that hold any tint (so drawing can skip empty space)
    const B = this.B, bw = Math.ceil(W / B), bh = Math.ceil(H / B);
    const used = new Uint8Array(bw * bh);
    for (let i = 0; i < N; i++) if (cat[i] >= 0) used[(((i / W) | 0) / B | 0) * bw + ((i % W) / B | 0)] = 1;
    // dilate by one block so soft edges near block borders are not clipped
    const dil = used.slice();
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      if (!used[by * bw + bx]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = bx + dx, y = by + dy;
        if (x >= 0 && y >= 0 && x < bw && y < bh) dil[y * bw + x] = 1;
      }
    }
    const runs = [];
    for (let by = 0; by < bh; by++) {
      let start = -1;
      for (let bx = 0; bx <= bw; bx++) {
        const on = bx < bw && dil[by * bw + bx];
        if (on && start < 0) start = bx;
        if (!on && start >= 0) { runs.push([start, by, bx - 1]); start = -1; }
      }
    }
    yield;
    const anchors = spec.anchors !== false ? computeAnchors(w, cat) : this.anchors;
    yield;
    // publish: the canvas, runs and anchors change together
    this.ctx.putImageData(this.img, 0, 0);
    this.runs = runs;
    this.anchors = anchors;
  }
}

/** Two-pass chamfer distance (1, √2) restricted to pixels of the same region (sliced). */
function* chamfer(d, pix, cw, ch, cap) {
  const D = 1.4142;
  const SL = 64;
  for (let y = 0; y < ch; y++) {
    let o = y * cw;
    for (let x = 0; x < cw; x++, o++) {
      let v = d[o];
      if (v <= 0.5) continue;
      const c = pix[o];
      if (c < 0) continue;
      if (x > 0 && pix[o - 1] === c) { const t = d[o - 1] + 1; if (t < v) v = t; }
      if (y > 0) {
        const u = o - cw;
        if (pix[u] === c) { const t = d[u] + 1; if (t < v) v = t; }
        if (x > 0 && pix[u - 1] === c) { const t = d[u - 1] + D; if (t < v) v = t; }
        if (x < cw - 1 && pix[u + 1] === c) { const t = d[u + 1] + D; if (t < v) v = t; }
      }
      d[o] = v > cap ? cap + 1 : v;
    }
    if (y % SL === SL - 1) yield;
  }
  for (let y = ch - 1; y >= 0; y--) {
    let o = y * cw + cw - 1;
    for (let x = cw - 1; x >= 0; x--, o--) {
      let v = d[o];
      if (v <= 0.5) continue;
      const c = pix[o];
      if (c < 0) continue;
      if (x < cw - 1 && pix[o + 1] === c) { const t = d[o + 1] + 1; if (t < v) v = t; }
      if (y < ch - 1) {
        const u = o + cw;
        if (pix[u] === c) { const t = d[u] + 1; if (t < v) v = t; }
        if (x < cw - 1 && pix[u + 1] === c) { const t = d[u + 1] + D; if (t < v) v = t; }
        if (x > 0 && pix[u - 1] === c) { const t = d[u - 1] + D; if (t < v) v = t; }
      }
      d[o] = v;
    }
    if (y % SL === 0) yield;
  }
}

/**
 * For each category ≥ 0: { x, y, n, piece, angle, len, depth } — the label point (deepest
 * interior tile, or the centroid when that is nearly as deep), total tile count, the size
 * of the largest connected piece, its principal-axis angle (radians, clamped to ±0.5) and
 * extent along that axis in tiles. Measured on the largest piece so a name never straddles
 * a sea between two pieces of a realm.
 */
export function computeAnchors(world, cat) {
  const { W, H, N } = world;
  const dist = new Uint16Array(N);
  const q = new Int32Array(N); let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) {
    const c = cat[i];
    if (c < 0) continue;
    const x = i % W, y = (i / W) | 0;
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
      cat[i - 1] !== c || cat[i + 1] !== c || cat[i - W] !== c || cat[i + W] !== c;
    if (edge) { dist[i] = 1; q[qt++] = i; }
  }
  while (qh < qt) {
    const i = q[qh++], c = cat[i], d = dist[i];
    const x = i % W;
    for (let k = 0; k < 4; k++) {
      const j = k === 0 ? (x > 0 ? i - 1 : -1) : k === 1 ? (x < W - 1 ? i + 1 : -1) : k === 2 ? i - W : i + W;
      if (j < 0 || j >= N || cat[j] !== c || dist[j]) continue;
      dist[j] = d + 1; q[qt++] = j;
    }
  }
  // connected pieces (4-neighbour) per category; keep the largest piece of each
  const comp = new Int32Array(N).fill(-1);
  const pieceSize = [], pieceCat = [];
  for (let s = 0; s < N; s++) {
    const c = cat[s];
    if (c < 0 || comp[s] >= 0) continue;
    const id = pieceSize.length;
    let n = 0;
    qh = 0; qt = 0; q[qt++] = s; comp[s] = id;
    while (qh < qt) {
      const i = q[qh++]; n++;
      const x = i % W;
      for (let k = 0; k < 4; k++) {
        const j = k === 0 ? (x > 0 ? i - 1 : -1) : k === 1 ? (x < W - 1 ? i + 1 : -1) : k === 2 ? i - W : i + W;
        if (j < 0 || j >= N || cat[j] !== c || comp[j] >= 0) continue;
        comp[j] = id; q[qt++] = j;
      }
    }
    pieceSize.push(n); pieceCat.push(c);
  }
  const bestPiece = new Map(), total = new Map();
  for (let p = 0; p < pieceSize.length; p++) {
    const c = pieceCat[p];
    total.set(c, (total.get(c) || 0) + pieceSize[p]);
    const b = bestPiece.get(c);
    if (b == null || pieceSize[p] > pieceSize[b]) bestPiece.set(c, p);
  }
  const acc = new Map();
  for (let i = 0; i < N; i++) {
    const c = cat[i];
    if (c < 0 || comp[i] !== bestPiece.get(c)) continue;
    const x = i % W, y = (i / W) | 0;
    let a = acc.get(c);
    if (!a) { a = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, best: i, bd: 0 }; acc.set(c, a); }
    a.n++; a.sx += x; a.sy += y; a.sxx += x * x; a.syy += y * y; a.sxy += x * y;
    if (dist[i] > a.bd) { a.bd = dist[i]; a.best = i; }
  }
  const out = new Map();
  for (const [c, a] of acc) {
    const n = a.n;
    const mx = a.sx / n, my = a.sy / n;
    const cxx = a.sxx / n - mx * mx, cyy = a.syy / n - my * my, cxy = a.sxy / n - mx * my;
    const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = Math.max(0, tr / 2 + disc);
    let angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    if (!Number.isFinite(angle)) angle = 0;
    if (angle > Math.PI / 2) angle -= Math.PI; if (angle < -Math.PI / 2) angle += Math.PI;
    angle = Math.max(-0.5, Math.min(0.5, angle));
    let x = a.best % W, y = (a.best / W) | 0;
    const cx = Math.round(mx), cy = Math.round(my);
    const ci = cy * W + cx;
    if (cx >= 0 && cy >= 0 && cx < W && cy < H && cat[ci] === c && comp[ci] === bestPiece.get(c) && dist[ci] >= a.bd * 0.7) { x = cx; y = cy; }
    out.set(c, { x, y, cx: mx, cy: my, n: total.get(c) || n, piece: n, angle, len: Math.max(2, Math.sqrt(l1) * 3.2), depth: a.bd });
  }
  return out;
}
