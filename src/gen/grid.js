// Generator toolkit: resolution-aware fractal noise, chamfer distance transforms,
// connected-component labelling and priority-flood drainage routing. Pure functions;
// callers own every buffer. DOM-free.
//
// Coordinates: generator stages sample noise in normalised units u = (x + 0.5) / H,
// v = (y + 0.5) / H (so u spans 0..W/H and v spans 0..1). A preview map and a full map
// of the same seed therefore sample the same continuous functions.

import { DX8, DY8, DIST8 } from '../core/util.js';

/** The medium map is the reference resolution for resolution-independent measures. */
export const REF_W = 256;
export const REF_H = 160;
export const REF_N = REF_W * REF_H;

/** A finite number from a param value, or the default. */
export const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/**
 * Fractal noise whose normalisation depends only on `octaves`. Summing just the first
 * `used` octaves yields a low-pass copy of the same function, so a coarse grid can skip
 * detail it cannot resolve without changing the large-scale shape. Roughly [-1, 1].
 */
export function fbmL(noise2, x, y, octaves, used = octaves) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    if (o < used) sum += amp * noise2(x * freq + o * 17.31, y * freq - o * 9.73);
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}

/** Ridged multifractal with the same truncation rule as fbmL. [0, 1], sharp crests. */
export function ridgedL(noise2, x, y, octaves, used = octaves) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0, prev = 1;
  for (let o = 0; o < octaves; o++) {
    if (o < used) {
      let n = 1 - Math.abs(noise2(x * freq + o * 31.7, y * freq + o * 11.3));
      n *= n;
      sum += n * amp * prev;
      prev = n;
    }
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}

/** How many octaves (lacunarity 2, starting at baseFreq per normalised unit) a grid of H rows resolves. */
export function octavesFor(H, baseFreq, octaves) {
  const lim = H / 2.4;
  let n = 0, fq = baseFreq;
  while (n < octaves && fq <= lim) { n++; fq *= 2; }
  return Math.max(1, n);
}

/**
 * In-place two-pass 8-neighbour chamfer distance transform (tiles, within ~8% of
 * Euclidean). `dist` must hold 0 at sources and a large value elsewhere. Tiles where
 * `block[i]` is non-zero neither receive nor pass on distance.
 */
export function chamfer(W, H, dist, block = null) {
  const D2 = Math.SQRT2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let d = dist[i];
      if (d === 0 || (block && block[i])) continue;
      if (x > 0) { const v = dist[i - 1] + 1; if (v < d) d = v; }
      if (y > 0) {
        const j = i - W;
        let v = dist[j] + 1; if (v < d) d = v;
        if (x > 0) { v = dist[j - 1] + D2; if (v < d) d = v; }
        if (x < W - 1) { v = dist[j + 1] + D2; if (v < d) d = v; }
      }
      dist[i] = d;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let d = dist[i];
      if (d === 0 || (block && block[i])) continue;
      if (x < W - 1) { const v = dist[i + 1] + 1; if (v < d) d = v; }
      if (y < H - 1) {
        const j = i + W;
        let v = dist[j] + 1; if (v < d) d = v;
        if (x < W - 1) { v = dist[j + 1] + D2; if (v < d) d = v; }
        if (x > 0) { v = dist[j - 1] + D2; if (v < d) d = v; }
      }
      dist[i] = d;
    }
  }
}

/**
 * Label 8-connected components of tiles where member[i] is non-zero.
 * labels: Int32Array(N) (−1 outside), queue: Int32Array(N) scratch.
 * Returns the component sizes (plain array, index = label).
 */
export function labelComponents(W, H, member, labels, queue) {
  labels.fill(-1);
  const sizes = [];
  const N = W * H;
  for (let s = 0; s < N; s++) {
    if (!member[s] || labels[s] >= 0) continue;
    const id = sizes.length;
    let qh = 0, qt = 0;
    queue[qt++] = s; labels[s] = id;
    while (qh < qt) {
      const i = queue[qh++], x = i % W, y = (i / W) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (!member[j] || labels[j] >= 0) continue;
        labels[j] = id; queue[qt++] = j;
      }
    }
    sizes.push(qt);
  }
  return sizes;
}

/**
 * Priority-flood drainage routing (Barnes, Lehman & Mulla 2014) with FIFO tie-breaking.
 * Seeds are ocean tiles (ocean[i] != 0) that touch a non-ocean tile, at level `sea`,
 * plus non-ocean tiles on the map edge at their own height (they drain off the map).
 * Writes: F — filled surface (depressions raised to their spill level; ocean = sea),
 *         parent — the tile each tile was reached from (−1 for seeds and ocean),
 *         order — non-ocean tiles in pop order (F non-decreasing, so reversing it gives
 *                 an upstream-first order for any routing that only steps to lower F
 *                 or to the flood parent).
 * Returns the number of tiles written to `order`.
 */
export function priorityFlood(W, H, e, ocean, sea, F, parent, order, visited, heap) {
  const N = W * H;
  heap.clear();
  visited.fill(0);
  let seq = 0;
  for (let i = 0; i < N; i++) {
    if (!ocean[i]) continue;
    visited[i] = 1; F[i] = sea; parent[i] = -1;
  }
  for (let i = 0; i < N; i++) {
    if (!ocean[i]) continue;
    const x = i % W, y = (i / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (!ocean[ny * W + nx]) { heap.push(i, sea + (seq++) * 1e-13); break; }
    }
  }
  const seedEdge = (i) => {
    if (visited[i]) return;
    visited[i] = 1; F[i] = e[i]; parent[i] = -1;
    heap.push(i, e[i] + (seq++) * 1e-13);
  };
  for (let x = 0; x < W; x++) { seedEdge(x); seedEdge((H - 1) * W + x); }
  for (let y = 1; y < H - 1; y++) { seedEdge(y * W); seedEdge(y * W + W - 1); }

  let n = 0;
  while (heap.size) {
    const c = heap.pop();
    if (!ocean[c]) order[n++] = c;
    const fc = F[c], x = c % W, y = (c / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (visited[j]) continue;
      visited[j] = 1;
      const fv = e[j] > fc ? e[j] : fc;
      F[j] = fv; parent[j] = c;
      heap.push(j, fv + (seq++) * 1e-13);
    }
  }
  return n;
}

/**
 * Flow directions for the tiles in `order`: steepest descent on the filled surface where
 * it is strictly downhill, otherwise the flood parent (flats, filled depressions).
 * The result keeps the reverse of `order` a valid upstream-first order.
 */
export function routeOnFilled(W, H, F, parent, order, n, dir) {
  for (let k = 0; k < n; k++) {
    const i = order[k], x = i % W, y = (i / W) | 0, fi = F[i];
    let best = parent[i], bs = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      const drop = fi - F[j];
      if (drop > 1e-7) {
        const s = drop / DIST8[d];
        if (s > bs) { bs = s; best = j; }
      }
    }
    dir[i] = best;
  }
}

/** Separable box blur (radius r tiles) of src into dst, using tmp as scratch. All Float32/64 arrays of length W*H. */
export function boxBlur(W, H, src, dst, tmp, r) {
  if (r <= 0) { dst.set(src); return; }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      const x0 = x - r < 0 ? 0 : x - r, x1 = x + r >= W ? W - 1 : x + r;
      for (let k = x0; k <= x1; k++) { s += src[row + k]; n++; }
      tmp[row + x] = s / n;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let s = 0, n = 0;
      const y0 = y - r < 0 ? 0 : y - r, y1 = y + r >= H ? H - 1 : y + r;
      for (let k = y0; k <= y1; k++) { s += tmp[k * W + x]; n++; }
      dst[y * W + x] = s / n;
    }
  }
}

/** Index of the first element of a sorted Float64Array that is >= v. */
export function lowerBound(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Principal-axis angle (radians, in [-π/2, π/2]) of a point cloud given its second moments. */
export function axisAngle(cxx, cyy, cxy) {
  let a = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  if (!Number.isFinite(a)) a = 0;
  if (a > Math.PI / 2) a -= Math.PI;
  if (a < -Math.PI / 2) a += Math.PI;
  return a;
}

/**
 * Exponential-race weighted sampling order: returns tile indices with score > minScore,
 * ordered so that taking them front-to-back samples without replacement in proportion to
 * score. Keys are packed with the index into one float64 so a native numeric sort does
 * the work (index < 2^18, key quantised to 1e-6).
 */
export function weightedOrder(rng, N, scoreAt, minScore) {
  const packed = new Float64Array(N);
  let n = 0;
  for (let i = 0; i < N; i++) {
    const s = scoreAt(i);
    if (!(s > minScore)) continue;
    const key = -Math.log(1 - rng.next() * 0.999999) / s;
    packed[n++] = Math.min(4e7, Math.floor(key * 1e6)) * 262144 + i;
  }
  const out = packed.subarray(0, n).sort();
  const idx = new Int32Array(n);
  for (let k = 0; k < n; k++) idx[k] = out[k] % 262144;
  return idx;
}

/**
 * Continental "frame" taper at normalised (u, v) on a map of aspect A: 1 well inside,
 * falling to 0 toward the frame and the corners (a rectangle softened by an ellipse).
 * j is a jitter (normalised units) that makes the taper contour irregular.
 */
export function frameTaper(u, v, A, j) {
  const eu = Math.min(u, A - u) + j, ev = Math.min(v, 1 - v) + j * 0.8;
  const rect = smooth01(0.03, 0.2, eu) * smooth01(0.015, 0.15, ev);
  const re = Math.hypot((u - A / 2) / (A / 2), (v - 0.5) / 0.5) - j * 2.2;
  return rect * (1 - smooth01(0.84, 1.1, re));
}
const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
