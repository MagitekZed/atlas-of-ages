// Stage 3 · Erosion. Ages of rain on the normalised relief:
//   - fluvial incision by the stream-power law, solved implicitly in drainage order
//     (Braun & Willett 2013) so large rivers cut valleys through ranges without
//     instability; base level is the sea (0.5), so coastlines hold;
//   - sediment routed downstream and dropped where transport capacity falls
//     (alluvial plains, valley floors, deltas on the shelf);
//   - hillslope diffusion and a talus pass that soften peaks and scarps.
// Coefficients are expressed per normalised length, so preview and full maps agree.

import { MinHeap, clamp, clamp01, DX8, DY8 } from '../core/util.js';
import { priorityFlood, routeOnFilled, labelComponents, num, REF_H, REF_N } from './grid.js';
import { oceanMask } from './hydrology.js';

const SEA = 0.5;

export function erodeTerrain(world, opts = {}) {
  const { W, H, N, f, params } = world;
  const strength = clamp01(num(params.erosion, 0.5));
  const e = f.elevation;
  const preview = Boolean(opts.preview);
  if (strength <= 0.001) { talus(world, 1, 0.5); return; }

  const iters = preview ? 2 : 10;
  // incision coefficient per iteration; preview runs fewer, stronger steps
  const K = (0.004 + 0.022 * strength) * (preview ? 3.2 : 1);
  const Kc = 0.9;                  // sediment transport capacity coefficient
  const res = H / REF_H;
  const Dt = clamp(0.06 * strength * res * res * (preview ? 5 : 1), 0, 0.22);   // hillslope diffusion per pass

  const F = new Float64Array(N), parent = new Int32Array(N), order = new Int32Array(N);
  const visited = new Uint8Array(N), ocean = new Uint8Array(N), rcv = new Int32Array(N);
  const area = new Float32Array(N), eroded = new Float32Array(N), sed = new Float32Array(N);
  const minDonor = new Float32Array(N), tmp = new Float32Array(N);
  const heap = new MinHeap(Math.max(1024, N >> 2));
  // crude rain weighting by latitude (wet tropics and storm belts erode faster)
  const rowRain = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const phi = Math.abs(1 - 2 * (y + 0.5) / H) * 90;
    rowRain[y] = 0.35 + 0.9 * Math.exp(-((phi / 12) ** 2)) + 0.45 * Math.exp(-(((phi - 50) / 14) ** 2)) + 0.2;
  }

  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < N; i++) ocean[i] = e[i] < SEA ? 1 : 0;
    const n = priorityFlood(W, H, e, ocean, SEA, F, parent, order, visited, heap);
    routeOnFilled(W, H, F, parent, order, n, rcv);

    // drainage area (rain-weighted tiles), upstream first
    for (let k = 0; k < n; k++) { const i = order[k]; area[i] = rowRain[(i / W) | 0]; }
    for (let k = n - 1; k >= 0; k--) {
      const i = order[k], r = rcv[i];
      if (r >= 0 && !ocean[r]) area[r] += area[i];
    }

    // implicit stream-power incision, downstream first
    for (let k = 0; k < n; k++) {
      const i = order[k], r = rcv[i];
      eroded[i] = 0;
      if (r < 0) continue;
      if (F[i] - e[i] > 1e-6) continue;          // inside a closed depression: leave for lakes
      const dx = (i % W) !== (r % W) && ((i / W) | 0) !== ((r / W) | 0) ? Math.SQRT2 : 1;
      const er = ocean[r] ? SEA : e[r];
      const fac = K * Math.sqrt(area[i]) / dx;
      const en = (e[i] + fac * er) / (1 + fac);
      if (en < e[i]) { eroded[i] = e[i] - en; e[i] = en; }
    }

    // sediment: upstream first, deposit where capacity drops; never above the donors
    sed.fill(0);
    minDonor.fill(2);
    for (let k = n - 1; k >= 0; k--) {
      const i = order[k], r = rcv[i];
      let q = sed[i] + eroded[i];
      if (r < 0) continue;
      const er = ocean[r] ? SEA : e[r];
      const slope = Math.max(0, e[i] - er);
      const cap = Kc * Math.sqrt(area[i]) * slope * 0.05;
      // deposit on valley floors (not inside closed basins, which stay lakes)
      if (q > cap && minDonor[i] < 2 && F[i] - e[i] <= 1e-6) {
        const room = Math.max(0, minDonor[i] - 1e-5 - e[i]);
        const dep = Math.min(room, (q - cap) * 0.5);
        if (dep > 0) { e[i] += dep; q -= dep; }
      }
      if (e[i] < minDonor[r]) minDonor[r] = e[i];
      if (ocean[r]) {
        const room = Math.max(0, 0.4985 - e[r]);
        const d2 = Math.min(room, q * 0.25);
        if (d2 > 0) e[r] += d2;
      } else sed[r] += q;
    }

    // hillslope diffusion on land (ocean neighbours count as sea level)
    if (Dt > 0) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const ei = e[i];
        if (ei < SEA) { tmp[i] = ei; continue; }
        let s = 0, c = 0;
        for (let d = 0; d < 8; d += 2) {
          const nx = x + DX8[d], ny = y + DY8[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const v = e[ny * W + nx];
          s += v < SEA ? SEA : v; c++;
        }
        const nv = ei + Dt * (s / c - ei);
        tmp[i] = nv < 0.5004 ? 0.5004 : nv;
      }
      e.set(tmp);
    }
  }
  talus(world, preview ? 1 : 2, strength);
}

/** Thermal erosion: slopes steeper than the angle of repose shed material downhill. */
function talus(world, passes, strength) {
  const { W, H, N, f } = world;
  const e = f.elevation;
  const delta = new Float32Array(N);
  // repose slope in elevation units per tile, scaled to resolution (normalised slope ≈ 9.5)
  const rep = (9.5 / H) * (1.4 - 0.5 * strength);
  for (let p = 0; p < passes; p++) {
    delta.fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const ei = e[i];
      if (ei < 0.56) continue;
      let lo = -1, ld = 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        const dd = (ei - e[j]) / (d & 1 ? Math.SQRT2 : 1);
        if (dd > ld) { ld = dd; lo = j; }
      }
      if (lo >= 0 && ld > rep) {
        const mv = (ld - rep) * 0.22;
        delta[i] -= mv; delta[lo] += mv;
      }
    }
    for (let i = 0; i < N; i++) {
      if (!delta[i]) continue;
      const was = e[i];
      let v = was + delta[i];
      // never push land under the sea or ocean over it in this pass
      if (was >= SEA && v < 0.5004) v = 0.5004;
      if (was < SEA && v >= SEA) v = 0.4995;
      e[i] = clamp(v, 0, 1);
    }
  }
}

/**
 * Settle closed basins after erosion. Over geological time rivers cut through the sills
 * of most hollows; only deep or broad basins (rifts, glacial scours, interior sinks)
 * survive as lake basins. Basins are ranked by depth^0.7 × area^0.3 (favouring the
 * scoured high latitudes) and kept within two lake-area budgets; the rest are breached.
 * Returns { basins, candidates, kept, carved }.
 */
export function settleBasins(world) {
  const { W, H, N, f } = world;
  const e = f.elevation;
  const ocean = new Uint8Array(N), comp = new Int32Array(N), queue = new Int32Array(N);
  const cSize = new Int32Array(N), cEdge = new Uint8Array(N);
  oceanMask(W, H, e, SEA, ocean, comp, queue, cSize, cEdge);
  const F = new Float64Array(N), parent = new Int32Array(N), order = new Int32Array(N), visited = new Uint8Array(N);
  priorityFlood(W, H, e, ocean, SEA, F, parent, order, visited, new MinHeap(Math.max(1024, N >> 2)));
  const mark = new Uint8Array(N);
  let land = 0;
  for (let i = 0; i < N; i++) { if (!ocean[i]) land++; mark[i] = !ocean[i] && F[i] - e[i] > 1e-6 ? 1 : 0; }
  const sizes = labelComponents(W, H, mark, comp, queue);
  const nc = sizes.length;
  const depth = new Float64Array(nc), latS = new Float64Array(nc);
  for (let i = 0; i < N; i++) {
    const c = comp[i]; if (c < 0) continue;
    const d = F[i] - e[i]; if (d > depth[c]) depth[c] = d;
    latS[c] += Math.abs(1 - 2 * (((i / W) | 0) + 0.5) / H);
  }
  const scale = N / REF_N;
  const minArea = Math.max(2, Math.round(4 * scale));
  const ids = [];
  for (let c = 0; c < nc; c++) {
    if (sizes[c] < minArea || depth[c] < 0.002) continue;
    const alat = latS[c] / sizes[c];
    ids.push([Math.pow(depth[c], 0.7) * Math.pow(sizes[c] / scale, 0.3) * (1 + 1.6 * smooth(0.45, 0.7, alat)), c]);
  }
  ids.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  // two budgets: up to two great basins (deep troughs, interior sinks) and a scatter of
  // ordinary lake basins, each a small share of the land
  const keep = new Uint8Array(nc);
  const bigCut = land * 0.006;
  let bigBudget = land * 0.025, bigCount = 2;
  let smallBudget = land * 0.022, smallCount = Math.round(40 * Math.sqrt(scale));
  for (const [, c] of ids) {
    if (sizes[c] > bigCut) {
      if (bigCount > 0 && depth[c] >= 0.01 && sizes[c] <= bigBudget) { keep[c] = 1; bigBudget -= sizes[c]; bigCount--; }
    } else if (smallCount > 0 && sizes[c] <= smallBudget) {
      keep[c] = 1; smallBudget -= sizes[c]; smallCount--;
    }
  }
  let kept = 0;
  for (let c = 0; c < nc; c++) kept += keep[c];
  // drain the rest by breaching: depth below the sill is softly capped (tanh keeps the
  // basin's shape and its minima), then every local minimum is joined to the outlet by a
  // channel cut down through the sill along the flood path (strictly descending)
  const MAX_CUT = 0.012;
  for (let i = 0; i < N; i++) {
    const c = comp[i];
    if (c < 0 || keep[c]) continue;
    const d = F[i] - e[i];
    if (d > 0) e[i] = F[i] - MAX_CUT * Math.tanh(d / MAX_CUT);
  }
  let carved = 0;
  for (let i = 0; i < N; i++) {
    const c = comp[i];
    if (c < 0 || keep[c]) continue;
    const x = i % W, y = (i / W) | 0, ei = e[i];
    let isMin = true;
    for (let d = 0; d < 8 && isMin; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (e[ny * W + nx] < ei) isMin = false;
    }
    if (!isMin) continue;
    let level = ei, t = parent[i];
    for (let guard = 0; t >= 0 && guard < N; guard++) {
      level -= 2e-6;
      if (ocean[t]) break;
      if (e[t] < level && comp[t] !== c) break;       // past the sill and already lower
      if (e[t] > level) { e[t] = level; carved++; }
      t = parent[t];
    }
  }
  return { basins: nc, candidates: ids.length, kept, carved };
}

const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
