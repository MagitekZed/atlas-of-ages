// Vector geometry built from tile fields and cached as Path2D in tile coordinates
// (entity convention: tile (x, y) spans [x-0.5, x+0.5]). Coastlines and engraved
// "water-lining" are iso-contours (marching squares on sub-divided bilinear cells);
// rivers are tapered midpoint-quadratic curves along flowDir; roads are smoothed
// chains through the road graph; borders are traced tile edges rounded by Chaikin.

import { WATER } from '../core/constants.js';
import { clamp01, clamp } from '../core/util.js';

/**
 * How much of a river's cartographic width it keeps at zoom z (CSS px per tile): rivers are
 * drawn broad from afar and narrow toward a truer width as you descend (town plans use the
 * floor, so a river runs through a town at the width it has outside).
 */
export const riverWidthK = (z) => clamp(30 / Math.max(1, z), 0.35, 1);
/** River deltas fade from this zoom and are gone by DELTA_OUT (Province zoom, where town plans take over). */
const DELTA_FADE = 20, DELTA_OUT = 34;
const smoothstep01 = (t) => { const u = clamp01(t); return u * u * (3 - 2 * u); };

// ---------------------------------------------------------------------------
// Chunked paths: a Path2D per B×B-tile block so a frame strokes only what is on screen.

export class ChunkedPath {
  constructor(W, H, B = 32) {
    this.B = B; this.bw = Math.max(1, Math.ceil(W / B)); this.bh = Math.max(1, Math.ceil(H / B));
    this.chunks = new Map();
    this.cx = 0; this.cy = 0; this.cur = -1; this.n = 0;
  }
  _chunk(x, y) {
    let bx = Math.floor((x + 0.5) / this.B), by = Math.floor((y + 0.5) / this.B);
    if (bx < 0) bx = 0; else if (bx >= this.bw) bx = this.bw - 1;
    if (by < 0) by = 0; else if (by >= this.bh) by = this.bh - 1;
    return by * this.bw + bx;
  }
  _path(k) { let p = this.chunks.get(k); if (!p) { p = new Path2D(); this.chunks.set(k, p); } return p; }
  _enter(k) {
    if (k === this.cur) return this._path(k);
    const p = this._path(k);
    p.moveTo(this.cx, this.cy);
    this.cur = k;
    return p;
  }
  moveTo(x, y) { this.cx = x; this.cy = y; this.cur = this._chunk(x, y); this._path(this.cur).moveTo(x, y); }
  lineTo(x, y) {
    const p = this._enter(this._chunk((this.cx + x) / 2, (this.cy + y) / 2));
    p.lineTo(x, y); this.cx = x; this.cy = y; this.n++;
  }
  quadraticCurveTo(qx, qy, x, y) {
    const p = this._enter(this._chunk(qx, qy));
    p.quadraticCurveTo(qx, qy, x, y); this.cx = x; this.cy = y; this.n++;
  }
  closePath() { /* chunked paths stay open; callers close loops by revisiting the start */ }
  /** Stroke the chunks overlapping tile bounds vb ({x0,x1,y0,y1}); all when vb is null. */
  stroke(ctx, vb) {
    if (!vb) { for (const p of this.chunks.values()) ctx.stroke(p); return; }
    const B = this.B;
    const bx0 = Math.max(0, Math.floor(vb.x0 / B) - 1), bx1 = Math.min(this.bw - 1, Math.floor(vb.x1 / B) + 1);
    const by0 = Math.max(0, Math.floor(vb.y0 / B) - 1), by1 = Math.min(this.bh - 1, Math.floor(vb.y1 / B) + 1);
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      const p = this.chunks.get(by * this.bw + bx);
      if (p) ctx.stroke(p);
    }
  }
}

// ---------------------------------------------------------------------------
// Iso-contours

/**
 * Marching squares over a per-tile scalar field F at level `lvl`, each cell between tile
 * centres subdivided S×S so the polyline follows the bilinear surface closely.
 * Returns chains: Float32Array [x0, y0, x1, y1, ...] in tile coordinates.
 */
export function contour(W, H, F, lvl, S = 3) {
  const GW = (W - 1) * S + 1;
  const segA = [], segB = [];
  const pos = new Map();
  const sv = new Float32Array((S + 1) * (S + 1));
  for (let cy = 0; cy < H - 1; cy++) {
    for (let cx = 0; cx < W - 1; cx++) {
      const i = cy * W + cx;
      const v00 = F[i], v10 = F[i + 1], v01 = F[i + W], v11 = F[i + W + 1];
      const a0 = v00 >= lvl, a1 = v10 >= lvl, a2 = v01 >= lvl, a3 = v11 >= lvl;
      if (a0 === a1 && a1 === a2 && a2 === a3) continue;
      for (let sy = 0; sy <= S; sy++) {
        const fy = sy / S;
        for (let sx = 0; sx <= S; sx++) {
          const fx = sx / S;
          sv[sy * (S + 1) + sx] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
        }
      }
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const p00 = sv[sy * (S + 1) + sx], p10 = sv[sy * (S + 1) + sx + 1];
          const p01 = sv[(sy + 1) * (S + 1) + sx], p11 = sv[(sy + 1) * (S + 1) + sx + 1];
          let code = 0;
          if (p00 >= lvl) code |= 1; if (p10 >= lvl) code |= 2; if (p11 >= lvl) code |= 4; if (p01 >= lvl) code |= 8;
          if (code === 0 || code === 15) continue;
          const GX = cx * S + sx, GY = cy * S + sy;
          // edge ids: top (GX,GY)->(GX+1,GY), bottom (GX,GY+1)->(GX+1,GY+1), left (GX,GY)->(GX,GY+1), right (GX+1,GY)->(GX+1,GY+1)
          const top = (GY * GW + GX) * 2, bottom = ((GY + 1) * GW + GX) * 2;
          const left = (GY * GW + GX) * 2 + 1, right = (GY * GW + GX + 1) * 2 + 1;
          const ex = (id, va, vb, x0, y0, x1, y1) => {
            if (pos.has(id)) return;
            const d = vb - va;
            const t = Math.abs(d) < 1e-12 ? 0.5 : clamp01((lvl - va) / d);
            pos.set(id, [(x0 + (x1 - x0) * t) / S, (y0 + (y1 - y0) * t) / S]);
          };
          const T = () => ex(top, p00, p10, GX, GY, GX + 1, GY);
          const Bo = () => ex(bottom, p01, p11, GX, GY + 1, GX + 1, GY + 1);
          const Le = () => ex(left, p00, p01, GX, GY, GX, GY + 1);
          const Ri = () => ex(right, p10, p11, GX + 1, GY, GX + 1, GY + 1);
          const seg = (ea, fa, eb, fb) => { fa(); fb(); segA.push(ea); segB.push(eb); };
          switch (code) {
            case 1: case 14: seg(left, Le, top, T); break;
            case 2: case 13: seg(top, T, right, Ri); break;
            case 3: case 12: seg(left, Le, right, Ri); break;
            case 4: case 11: seg(right, Ri, bottom, Bo); break;
            case 6: case 9: seg(top, T, bottom, Bo); break;
            case 7: case 8: seg(left, Le, bottom, Bo); break;
            case 5: case 10: {
              const c = (p00 + p10 + p01 + p11) / 4 >= lvl;
              if ((code === 5) === c) { seg(left, Le, bottom, Bo); seg(top, T, right, Ri); }
              else { seg(left, Le, top, T); seg(right, Ri, bottom, Bo); }
              break;
            }
          }
        }
      }
    }
  }
  return chainSegments(segA, segB, pos);
}

function chainSegments(segA, segB, pos) {
  const n = segA.length;
  const adj = new Map();
  const link = (id, s) => { const a = adj.get(id); if (a) a.push(s); else adj.set(id, [s]); };
  for (let s = 0; s < n; s++) { link(segA[s], s); link(segB[s], s); }
  const used = new Uint8Array(n);
  const chains = [];
  const walk = (s0, fromId) => {
    // returns list of ids starting at fromId, following segments
    const ids = [fromId];
    let s = s0, cur = fromId;
    for (;;) {
      used[s] = 1;
      const nxt = segA[s] === cur ? segB[s] : segA[s];
      ids.push(nxt);
      cur = nxt;
      const cand = adj.get(cur);
      let ns = -1;
      if (cand) for (const c of cand) if (!used[c]) { ns = c; break; }
      if (ns < 0) break;
      s = ns;
    }
    return ids;
  };
  const emit = (ids) => {
    const out = new Float32Array(ids.length * 2);
    for (let k = 0; k < ids.length; k++) { const p = pos.get(ids[k]); out[k * 2] = p[0]; out[k * 2 + 1] = p[1]; }
    chains.push(out);
  };
  // open chains first (endpoints with a single segment)
  for (const [id, list] of adj) {
    if (list.length !== 1 || used[list[0]]) continue;
    emit(walk(list[0], id));
  }
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    emit(walk(s, segA[s]));
  }
  return chains;
}

/** Path (Path2D, or ChunkedPath when `chunked` = [W, H]) from chains with at least minPts points. */
export function chainsToPath(chains, minPts = 2, chunked = null) {
  const p = chunked ? new ChunkedPath(chunked[0], chunked[1]) : new Path2D();
  for (const c of chains) {
    const n = c.length / 2;
    if (n < minPts) continue;
    p.moveTo(c[0], c[1]);
    for (let k = 1; k < n; k++) p.lineTo(c[k * 2], c[k * 2 + 1]);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Coast & water-lining

/** Signed distance-ish field from ocean tiles to the nearest land (lakes count as land). */
export function coastDistance(world, maxD = 6) {
  const { W, H, N, f } = world;
  const D = new Float32Array(N);
  const sx = new Int32Array(N).fill(-1), sy = new Int32Array(N);
  const q = new Int32Array(N); let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) {
    if (f.water[i] !== WATER.OCEAN) { D[i] = -0.5; sx[i] = i % W; sy[i] = (i / W) | 0; q[qt++] = i; }
    else D[i] = maxD;
  }
  while (qh < qt) {
    const i = q[qh++];
    const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((dx | dy) === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (f.water[j] !== WATER.OCEAN) continue;
      const ddx = nx - sx[i], ddy = ny - sy[i];
      const d = Math.sqrt(ddx * ddx + ddy * ddy) - 0.5;
      if (d < D[j] - 1e-4 && d < maxD) { D[j] = d; sx[j] = sx[i]; sy[j] = sy[i]; q[qt++] = j; }
    }
  }
  return D;
}

// ---------------------------------------------------------------------------
// Rivers

/**
 * River network as tapered pieces grouped into width buckets.
 * Returns { buckets: [{ t, path }], count } where t ∈ [0,1] is relative size.
 */
export function buildRivers(world, NB = 10, chunked = true, minPts = 2, Lv = null) {
  const { W, N, f } = world;
  // where the drawn coast (the zero contour of the land level Lv, bilinear between tile
  // centres) crosses the reach from tile i to the water tile j: the river ends there, a hair
  // past the ink, instead of running half a tile out to sea
  const coastAt = (i, j) => {
    if (!Lv) return 0.5;
    const H = world.H;
    const ax = i % W, ay = (i / W) | 0, bx = j % W, by = (j / W) | 0;
    const lv = (x, y) => {
      const x0 = Math.max(0, Math.min(W - 1, Math.floor(x))), y0 = Math.max(0, Math.min(H - 1, Math.floor(y)));
      const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = x - Math.floor(x), fy = y - Math.floor(y);
      return Lv[y0 * W + x0] * (1 - fx) * (1 - fy) + Lv[y0 * W + x1] * fx * (1 - fy) + Lv[y1 * W + x0] * (1 - fx) * fy + Lv[y1 * W + x1] * fx * fy;
    };
    let prev = lv(ax, ay);
    if (!(prev > 0)) return 0.5;
    for (let k = 1; k <= 16; k++) {
      const t = k / 16, v = lv(ax + (bx - ax) * t, ay + (by - ay) * t);
      if (v <= 0) { const u = (k - 1 + prev / Math.max(1e-6, prev - v)) / 16; return Math.min(1, u + 0.05 / Math.max(1, Math.hypot(bx - ax, by - ay))); }
      prev = v;
    }
    return 0.5;
  };
  const riv = f.river, fd = f.flowDir, fl = f.flow, wa = f.water;
  const isR = (i) => i >= 0 && i < N && riv[i] > 0 && wa[i] === WATER.LAND;
  let minF = Infinity, maxF = 0, count = 0;
  const mainUp = new Int32Array(N).fill(-1);
  const hasUp = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!isR(i)) continue;
    count++;
    const v = fl[i] > 0 ? fl[i] : 1e-3;
    if (v < minF) minF = v; if (v > maxF) maxF = v;
    const j = fd[i];
    if (j >= 0 && j < N && isR(j)) {
      hasUp[j] = 1;
      const m = mainUp[j];
      if (m < 0 || fl[i] > fl[m]) mainUp[j] = i;
    }
  }
  const buckets = [];
  for (let k = 0; k < NB; k++) buckets.push({ t: k / (NB - 1), path: chunked ? new ChunkedPath(world.W, world.H) : new Path2D(), n: 0 });
  const mouths = [];
  if (!count) return { buckets, count, mouths };
  const lmin = Math.log(Math.max(1e-3, minF)), lspan = Math.max(1e-3, Math.log(Math.max(minF * 1.01, maxF)) - lmin);
  const tOf = (i) => {
    let t = (Math.log(Math.max(1e-3, fl[i])) - lmin) / lspan;
    t = clamp01(t);
    // the hydrology river class gives a floor so great rivers always read as great
    const cls = riv[i];
    const floor = cls >= 4 ? 0.75 : cls >= 3 ? 0.5 : cls >= 2 ? 0.25 : 0;
    return Math.max(t, floor);
  };
  const cx = (i) => i % W, cy = (i) => (i / W) | 0;
  const pts = [];
  for (let h = 0; h < N; h++) {
    if (!isR(h) || hasUp[h]) continue; // heads only
    // follow downstream along the main stem
    pts.length = 0;
    let i = h, prevT = tOf(h) * 0.6;
    pts.push(cx(i), cy(i), prevT);
    for (let guard = 0; guard < N; guard++) {
      const j = fd[i];
      if (j < 0 || j >= N) break;
      if (isR(j)) {
        // a tributary keeps its own width to the confluence (the main stem's width there drew
        // a thick stub sticking out of the bigger river)
        const main = mainUp[j] === i;
        pts.push(cx(j), cy(j), main ? tOf(j) : tOf(i));
        if (!main) break; // a tributary ends at its confluence
        i = j;
        continue;
      }
      if (wa[j] !== WATER.LAND) {
        const ct = coastAt(i, j);
        pts.push(cx(i) + (cx(j) - cx(i)) * ct, cy(i) + (cy(j) - cy(i)) * ct, tOf(i));
        // a great river meeting the sea (or a lake) builds a delta: see drawDeltas
        if (riv[i] >= 3 || tOf(i) >= 0.5) {
          let dx = cx(j) - cx(i), dy = cy(j) - cy(i);
          // average the seaward direction over the neighbouring water so the fan faces open water
          let sx = 0, sy = 0;
          for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
            const xx = cx(i) + ox, yy = cy(i) + oy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= world.H) continue;
            if (wa[yy * W + xx] !== WATER.LAND) { sx += ox; sy += oy; }
          }
          if (sx || sy) { dx = dx * 0.5 + sx / Math.hypot(sx, sy); dy = dy * 0.5 + sy / Math.hypot(sx, sy); }
          const dl = Math.hypot(dx, dy) || 1;
          // the apex sits on the river's own last reach, just inside the coast: the channels
          // split where the river meets the sea, never out across the land beside it
          const mx = cx(i) + (cx(j) - cx(i)) * ct, my = cy(i) + (cy(j) - cy(i)) * ct;
          mouths.push({ x: mx, y: my, ax: mx + (cx(i) - mx) * 0.45, ay: my + (cy(i) - my) * 0.45, dx: dx / dl, dy: dy / dl, t: tOf(i), lake: wa[j] === WATER.LAKE, h: (i * 2654435761) >>> 0 });
        }
      }
      break;
    }
    const n = pts.length / 3;
    if (n < minPts) continue;
    // a one-tile spur of a minor stream reads as a stray tick mark: leave it out
    if (n < 3 && pts[2] < 0.3 && pts[5] < 0.3) continue;
    // pieces: [p0 → m01], [m(k-1,k) Q p_k → m(k,k+1)], [m(n-2,n-1) → p_{n-1}]
    let curB = -1, path = null;
    const mid = (a, b) => [(pts[a * 3] + pts[b * 3]) / 2, (pts[a * 3 + 1] + pts[b * 3 + 1]) / 2];
    const bOf = (k) => Math.max(0, Math.min(NB - 1, Math.round(pts[k * 3 + 2] * (NB - 1))));
    for (let k = 0; k < n; k++) {
      const b = bOf(k);
      let start, end, ctrl = null;
      if (k === 0) { start = [pts[0], pts[1]]; end = mid(0, 1); }
      else if (k === n - 1) { start = mid(k - 1, k); end = [pts[k * 3], pts[k * 3 + 1]]; }
      else { start = mid(k - 1, k); ctrl = [pts[k * 3], pts[k * 3 + 1]]; end = mid(k, k + 1); }
      if (b !== curB) { path = buckets[b].path; path.moveTo(start[0], start[1]); curB = b; buckets[b].n++; }
      if (ctrl) path.quadraticCurveTo(ctrl[0], ctrl[1], end[0], end[1]);
      else path.lineTo(end[0], end[1]);
    }
  }
  return { buckets, count, mouths };
}

/**
 * River deltas (world transform, z ≥ 5): where a great river meets the sea its channel splits
 * into tapering distributaries over a fan of marsh and sandbanks, with a plume of silt beyond.
 * mouths from buildRivers; col the river colour; widthPx(t) the river's stroke width in CSS px.
 */
export function drawDeltas(ctx, z, mouths, vb, col, widthPx, alpha = 1, lobes = true) {
  if (!mouths || !mouths.length || z < 5 || z >= DELTA_OUT) return;
  // a delta is a regional feature: it gives way as the town plans and the shore detail take
  // over (up close its tile-sized fan read as stray lines across the river's town)
  const a0 = clamp01((z - 5) / 4) * (1 - smoothstep01((z - DELTA_FADE) / (DELTA_OUT - DELTA_FADE))) * alpha;
  if (a0 <= 0.02) return;
  const hf = (h, k) => ((Math.imul(h ^ Math.imul(k + 1, 0x9e3779b1), 0x85ebca6b) >>> 8) & 1023) / 1023;
  const bands = [new Path2D(), new Path2D(), new Path2D()];
  let any = false;
  for (const m of mouths) {
    if (m.lake) continue;
    const L = 0.7 + 1.1 * m.t;
    if (m.x < vb.x0 - L - 1 || m.x > vb.x1 + L + 1 || m.y < vb.y0 - L - 1 || m.y > vb.y1 + L + 1) continue;
    any = true;
    const ang = Math.atan2(m.dy, m.dx), spread = 0.62 + 0.2 * m.t;
    const ax = m.ax ?? m.x - m.dx * 0.8, ay = m.ay ?? m.y - m.dy * 0.8;
    const cxm = m.x + m.dx * L * 0.35, cym = m.y + m.dy * L * 0.35;
    const R0 = L * 1.05;
    if (lobes) {
      // a plume of silt out to sea
      const px0 = m.x + m.dx * L * 0.9, py0 = m.y + m.dy * L * 0.9;
      const g1 = ctx.createRadialGradient(px0, py0, 0, px0, py0, L * 1.2);
      g1.addColorStop(0, `rgba(176,156,108,${(0.2 * a0).toFixed(3)})`); g1.addColorStop(1, 'rgba(176,156,108,0)');
      ctx.fillStyle = g1; ctx.beginPath(); ctx.arc(px0, py0, L * 1.2, 0, Math.PI * 2); ctx.fill();
      // the delta plain pushed out into the sea: marsh by the coast, sandbanks at the lip
      const g2 = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, R0);
      g2.addColorStop(0, `rgba(140,156,104,${(0.5 * a0).toFixed(3)})`);
      g2.addColorStop(0.55, `rgba(176,178,128,${(0.5 * a0).toFixed(3)})`);
      g2.addColorStop(0.85, `rgba(206,196,150,${(0.5 * a0).toFixed(3)})`);
      g2.addColorStop(1, 'rgba(214,204,160,0)');
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.moveTo(m.x - m.dx * 0.15, m.y - m.dy * 0.15);
      for (let q = 0; q <= 14; q++) {
        const a = ang + (q / 14 - 0.5) * 2.2 * spread;
        const rr = R0 * (0.55 + 0.45 * Math.cos((q / 14 - 0.5) * Math.PI) + (hf(m.h, q + 40) - 0.5) * 0.14);
        ctx.lineTo(m.x + Math.cos(a) * rr, m.y + Math.sin(a) * rr);
      }
      ctx.closePath(); ctx.fill();
    }
    // distributaries: tapering, bending, the larger ones forking near the lip
    const n = 3 + Math.round(m.t * 2);
    for (let q = 0; q < n; q++) {
      const f = q / (n - 1) - 0.5;
      const a = ang + f * spread * 1.7 + (hf(m.h, q) - 0.5) * 0.18;
      const len = R0 * (0.7 + 0.25 * hf(m.h, q + 9)) * (1 - Math.abs(f) * 0.3);
      const ex = m.x + Math.cos(a) * len, ey = m.y + Math.sin(a) * len;
      // pass near the main mouth so the channels leave the river where it meets the coast
      const qx = (cxm + (ax + ex) / 2) / 2 + (hf(m.h, q + 20) - 0.5) * 0.3 * len, qy = (cym + (ay + ey) / 2) / 2 + (hf(m.h, q + 30) - 0.5) * 0.3 * len;
      let lx = ax, ly = ay;
      for (let k = 1; k <= 9; k++) {
        const u = k / 9, v = 1 - u;
        const x = v * v * ax + 2 * u * v * qx + u * u * ex, y = v * v * ay + 2 * u * v * qy + u * u * ey;
        const band = bands[Math.min(2, Math.floor((k - 1) / 3))];
        band.moveTo(lx, ly); band.lineTo(x, y);
        lx = x; ly = y;
        if (k === 6 && Math.abs(f) < 0.45 && hf(m.h, q + 50) < 0.6) {
          const fa = a + (hf(m.h, q + 60) < 0.5 ? 0.45 : -0.45), fl = len * 0.3;
          bands[2].moveTo(x, y); bands[2].quadraticCurveTo(x + Math.cos(a) * fl * 0.5, y + Math.sin(a) * fl * 0.5, x + Math.cos(fa) * fl, y + Math.sin(fa) * fl);
        }
      }
    }
  }
  if (!any) return;
  const w = Math.max(0.7, widthPx(0.8) * 0.4);
  ctx.strokeStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.globalAlpha = Math.min(1, 0.8 * a0 + 0.1);
  for (let b = 0; b < 3; b++) { ctx.lineWidth = (w * (1 - b * 0.28)) / z; ctx.stroke(bands[b]); }
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
}

// ---------------------------------------------------------------------------
// Roads

/** Smoothed road network grouped by level 1..3. Returns { paths: [null, P1, P2, P3], count }. */
export function buildRoads(world) {
  const { W, H, N, f } = world;
  const road = f.road;
  const paths = [null, new ChunkedPath(W, H), new ChunkedPath(W, H), new ChunkedPath(W, H)];
  let count = 0;
  // adjacency: up to 8 neighbours per node, stored as a bitmask of directions
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  const mask = new Uint8Array(N);
  const has = (x, y) => x >= 0 && y >= 0 && x < W && y < H && road[y * W + x] > 0;
  for (let i = 0; i < N; i++) {
    if (!road[i]) continue;
    count++;
    const x = i % W, y = (i / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (!has(nx, ny)) continue;
      if (d & 1) {
        // diagonal: only when neither orthogonal shortcut exists
        if (has(x + DX[d], y) || has(x, y + DY[d])) continue;
      }
      mask[i] |= 1 << d;
    }
  }
  if (!count) return { paths, count };
  const deg = new Uint8Array(N);
  for (let i = 0; i < N; i++) { let m = mask[i], c = 0; while (m) { c += m & 1; m >>= 1; } deg[i] = c; }
  const lvlOf = (i, j) => Math.min(3, Math.max(1, Math.min(road[i], road[j])));
  const visited = new Uint8Array(N); // per-node bitmask of used directions
  const opp = (d) => (d + 4) & 7;
  const pts = [];
  const flushChain = (lvl) => {
    const n = pts.length / 2;
    if (n < 2) return;
    const p = paths[lvl];
    p.moveTo(pts[0], pts[1]);
    if (n === 2) { p.lineTo(pts[2], pts[3]); return; }
    p.lineTo((pts[0] + pts[2]) / 2, (pts[1] + pts[3]) / 2);
    for (let k = 1; k < n - 1; k++) {
      p.quadraticCurveTo(pts[k * 2], pts[k * 2 + 1], (pts[k * 2] + pts[k * 2 + 2]) / 2, (pts[k * 2 + 1] + pts[k * 2 + 3]) / 2);
    }
    p.lineTo(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
  };
  const walkFrom = (i0, d0) => {
    pts.length = 0;
    let i = i0, d = d0;
    const W_ = W;
    pts.push(i % W_, (i / W_) | 0);
    const lvl = lvlOf(i, (((i / W_) | 0) + DY[d]) * W_ + (i % W_) + DX[d]);
    for (let guard = 0; guard < N; guard++) {
      const x = i % W_, y = (i / W_) | 0;
      const j = (y + DY[d]) * W_ + x + DX[d];
      visited[i] |= 1 << d; visited[j] |= 1 << opp(d);
      pts.push(j % W_, (j / W_) | 0);
      if (deg[j] !== 2) break;
      // continue through j along its other unused edge of the same level
      let nd = -1;
      for (let e = 0; e < 8; e++) {
        if (!(mask[j] & (1 << e)) || (visited[j] & (1 << e))) continue;
        const k = (((j / W_) | 0) + DY[e]) * W_ + (j % W_) + DX[e];
        if (lvlOf(j, k) !== lvl) continue;
        nd = e; break;
      }
      if (nd < 0) break;
      i = j; d = nd;
    }
    flushChain(lvl);
  };
  for (let i = 0; i < N; i++) {
    if (!mask[i] || deg[i] === 2) continue;
    for (let d = 0; d < 8; d++) if ((mask[i] & (1 << d)) && !(visited[i] & (1 << d))) walkFrom(i, d);
  }
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    for (let d = 0; d < 8; d++) if ((mask[i] & (1 << d)) && !(visited[i] & (1 << d))) walkFrom(i, d);
  }
  return { paths, count };
}

// ---------------------------------------------------------------------------
// Tile-edge tracing (borders, outlines)

/**
 * Trace the tile edges where edgeFn(i, j) is true (i, j orthogonal neighbours; j = -1 for
 * the world boundary when `outside` is set). Returns chains (vertex lists in tile
 * coordinates) split at junctions; `closed` flags loops.
 */
export function traceEdges(W, H, edgeFn, outside = false) {
  const VW = W + 1, VH = H + 1;
  const m = new Uint8Array(VW * VH); // bits: 1 right, 2 down, 4 left, 8 up
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // vertical edge to the right of (x, y)
      if (x < W - 1 ? edgeFn(i, i + 1) : outside && edgeFn(i, -1)) {
        const v = y * VW + x + 1; m[v] |= 2; m[v + VW] |= 8;
      }
      if (x === 0 && outside && edgeFn(i, -1)) { const v = y * VW; m[v] |= 2; m[v + VW] |= 8; }
      // horizontal edge below (x, y)
      if (y < H - 1 ? edgeFn(i, i + W) : outside && edgeFn(i, -1)) {
        const v = (y + 1) * VW + x; m[v] |= 1; m[v + 1] |= 4;
      }
      if (y === 0 && outside && edgeFn(i, -1)) { const v = x; m[v] |= 1; m[v + 1] |= 4; }
    }
  }
  const deg = new Uint8Array(VW * VH);
  for (let v = 0; v < m.length; v++) { const b = m[v]; deg[v] = (b & 1) + ((b >> 1) & 1) + ((b >> 2) & 1) + ((b >> 3) & 1); }
  const step = [[1, 0, 1, 4], [0, 1, 2, 8], [-1, 0, 4, 1], [0, -1, 8, 2]]; // dx, dy, bit, opposite bit
  const chains = [];
  const walk = (v0, dir0) => {
    const out = [];
    let v = v0, dir = dir0;
    out.push((v % VW) - 0.5, ((v / VW) | 0) - 0.5);
    for (let guard = 0; guard < m.length; guard++) {
      const [dx, dy, bit, ob] = step[dir];
      m[v] &= ~bit;
      const nv = v + dy * VW + dx;
      m[nv] &= ~ob;
      v = nv;
      out.push((v % VW) - 0.5, ((v / VW) | 0) - 0.5);
      if (deg[v] !== 2 || v === v0) break;
      let nd = -1;
      for (let k = 0; k < 4; k++) if (m[v] & step[k][2]) { nd = k; break; }
      if (nd < 0) break;
      dir = nd;
    }
    const closed = v === v0 && out.length > 4;
    chains.push({ pts: out, closed });
  };
  for (let v = 0; v < m.length; v++) {
    if (deg[v] === 2 || deg[v] === 0) continue;
    for (let k = 0; k < 4; k++) if (m[v] & step[k][2]) walk(v, k);
  }
  for (let v = 0; v < m.length; v++) {
    for (let k = 0; k < 4; k++) if (m[v] & step[k][2]) walk(v, k);
  }
  return chains;
}

/** Chaikin corner cutting; open chains keep their endpoints. */
export function chaikin(pts, closed, iterations = 2) {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    const n = p.length / 2;
    if (n < 3) return p;
    const out = [];
    if (!closed) out.push(p[0], p[1]);
    const lim = closed ? n : n - 1;
    for (let k = 0; k < lim; k++) {
      const a = k, b = (k + 1) % n;
      const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1];
      out.push(ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25, ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75);
    }
    if (!closed) out.push(p[(n - 1) * 2], p[(n - 1) * 2 + 1]);
    p = out;
  }
  return p;
}

/** Drop the interior points of straight runs (keeps every corner). */
export function dropCollinear(pts) {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const out = [pts[0], pts[1]];
  for (let k = 1; k < n - 1; k++) {
    const ax = out[out.length - 2], ay = out[out.length - 1];
    const bx = pts[k * 2], by = pts[k * 2 + 1], cx = pts[k * 2 + 2], cy = pts[k * 2 + 3];
    if (Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) > 1e-9) out.push(bx, by);
  }
  out.push(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
  return out;
}

/**
 * Build a smoothed path (Path2D, or ChunkedPath when `chunked` = [W, H]) from traced edge
 * chains. `sc` rescales chains traced on a sub-tile grid (sc = 1 / pixels per tile) into
 * tile coordinates.
 */
export function edgesToPath(chains, smooth = 2, chunked = null, sc = 1) {
  const path = chunked ? new ChunkedPath(chunked[0], chunked[1]) : new Path2D();
  for (const c of chains) {
    let src = c.pts;
    if (sc !== 1) {
      src = new Array(c.pts.length);
      for (let k = 0; k < c.pts.length; k++) src[k] = (c.pts[k] + 0.5) * sc - 0.5;
      src = dropCollinear(src);
    }
    const p = smooth ? chaikin(src, c.closed, smooth) : src;
    const n = p.length / 2;
    if (n < 2) continue;
    path.moveTo(p[0], p[1]);
    for (let k = 1; k < n; k++) path.lineTo(p[k * 2], p[k * 2 + 1]);
    if (c.closed) { if (chunked) path.lineTo(p[0], p[1]); else path.closePath(); }
  }
  return path;
}
