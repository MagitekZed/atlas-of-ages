// Grid geometry shared by the nature systems: coarse-grid dimensions, bilinear
// upsampling tables, per-row runs of land / water tiles (so hot loops skip the
// other kind without branching per tile) and region bookkeeping. All derived
// data lives in world.cache and is keyed by world.versions.water.

import { WATER } from '../../core/constants.js';

/** Weather moisture grid: tiles per coarse cell. */
export const WX_CELL = 8;
/** Climate anomaly grid: tiles per cell. */
export const ANOM_CELL = 8;
/** Region size (tiles) for droughts, fauna and biome-shift bookkeeping. */
export const REGION = 32;

export function coarseDims(W, H, C) {
  const cw = Math.max(2, Math.ceil(W / C)), ch = Math.max(2, Math.ceil(H / C));
  return { cw, ch, cn: cw * ch };
}

/**
 * Bilinear sampling tables mapping n fine cells onto cn coarse cells of size C
 * (cell centres aligned): c0[k] is the lower coarse index (≤ cn - 2) and t[k] the weight.
 */
export function interpTable(n, C, cn) {
  const c0 = new Int32Array(n), t = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const f = (k + 0.5) / C - 0.5;
    let a = Math.floor(f), w = f - a;
    if (a < 0) { a = 0; w = 0; }
    if (a > cn - 2) { a = cn - 2; w = 1; }
    c0[k] = a; t[k] = Math.min(1, Math.max(0, w));
  }
  return { c0, t };
}

/** Cached upsampling tables for a given coarse cell size. */
export function upTables(world, C) {
  const key = 'natUp' + C;
  let u = world.cache[key];
  if (u && u.W === world.W && u.H === world.H) return u;
  const d = coarseDims(world.W, world.H, C);
  const tx = interpTable(world.W, C, d.cw), ty = interpTable(world.H, C, d.ch);
  u = world.cache[key] = { W: world.W, H: world.H, C, ...d, cx0: tx.c0, wx: tx.t, cy0: ty.c0, wy: ty.t,
    rowA: new Float64Array(d.cw), rowB: new Float64Array(d.cw), rowC: new Float64Array(d.cw) };
  return u;
}

/**
 * Upsample a coarse field into a tile field with bilinear interpolation.
 * Rows y ≡ phase (mod K) only (K = 1 → every row). Optional clamp [lo, hi].
 */
export function upsampleField(world, C, src, dst, lo = -Infinity, hi = Infinity, K = 1, phase = 0) {
  const u = upTables(world, C);
  upKernel(src, dst, lo, hi, K, phase, world.W, world.H, u.cw, u.cy0, u.wy, u.cx0, u.wx, u.rowA, C === 8 && u.cw * 8 === world.W ? 1 : 0);
}

function upKernel(src, dst, lo, hi, K, phase, W, H, cw, cy0, wy, cx0, wx, rb, fast8) {
  for (let y = phase; y < H; y += K) {
    const r0 = cy0[y] * cw, r1 = r0 + cw, ty = wy[y];
    for (let c = 0; c < cw; c++) { const a = src[r0 + c]; rb[c] = a + (src[r1 + c] - a) * ty; }
    const row = y * W;
    if (fast8) {
      // 8-tile cells: fixed sub-cell weights, half-cell toward each neighbour.
      let o = row;
      for (let c = 0; c < cw; c++) {
        const b = rb[c];
        const ab = c > 0 ? b - rb[c - 1] : 0, bd = c < cw - 1 ? rb[c + 1] - b : 0;
        dst[o] = Math.min(hi, Math.max(lo, b - 0.4375 * ab)); dst[o + 1] = Math.min(hi, Math.max(lo, b - 0.3125 * ab));
        dst[o + 2] = Math.min(hi, Math.max(lo, b - 0.1875 * ab)); dst[o + 3] = Math.min(hi, Math.max(lo, b - 0.0625 * ab));
        dst[o + 4] = Math.min(hi, Math.max(lo, b + 0.0625 * bd)); dst[o + 5] = Math.min(hi, Math.max(lo, b + 0.1875 * bd));
        dst[o + 6] = Math.min(hi, Math.max(lo, b + 0.3125 * bd)); dst[o + 7] = Math.min(hi, Math.max(lo, b + 0.4375 * bd));
        o += 8;
      }
      continue;
    }
    for (let x = 0; x < W; x++) {
      const c = cx0[x], a = rb[c];
      const v = a + (rb[c + 1] - a) * wx[x];
      dst[row + x] = Math.min(hi, Math.max(lo, v));
    }
  }
}

/**
 * Per-row runs of tiles of one kind. runs = Int32Array of [start, end) pairs
 * (absolute tile indices), rowStart[y]..rowStart[y+1] index pairs belonging to row y.
 * kind 'land' = WATER.LAND, 'water' = ocean or lake.
 */
export function tileRuns(world, kind) {
  const key = kind === 'land' ? 'natLandRuns' : 'natWaterRuns';
  const v = world.versions.water;
  let r = world.cache[key];
  if (r && r.v === v && r.N === world.N) return r;
  const { W, H, f } = world;
  const water = f.water;
  const wantLand = kind === 'land';
  const tmp = [];
  const rowStart = new Int32Array(H + 1);
  let count = 0;
  for (let y = 0; y < H; y++) {
    rowStart[y] = tmp.length / 2;
    let x = 0;
    const row = y * W;
    while (x < W) {
      while (x < W && ((water[row + x] === WATER.LAND) !== wantLand)) x++;
      if (x >= W) break;
      const s = x;
      while (x < W && ((water[row + x] === WATER.LAND) === wantLand)) x++;
      tmp.push(row + s, row + x);
      count += x - s;
    }
  }
  rowStart[H] = tmp.length / 2;
  r = world.cache[key] = { v, N: world.N, runs: Int32Array.from(tmp), rowStart, count };
  return r;
}

/** Cached list of land tile indices (for Monte-Carlo sampling of rare per-tile events). */
export function landList(world) {
  const v = world.versions.water;
  let c = world.cache.natLandList;
  if (c && c.v === v && c.N === world.N) return c.list;
  const { N, f } = world;
  const water = f.water;
  let n = 0;
  for (let i = 0; i < N; i++) if (water[i] === WATER.LAND) n++;
  const list = new Int32Array(n);
  n = 0;
  for (let i = 0; i < N; i++) if (water[i] === WATER.LAND) list[n++] = i;
  world.cache.natLandList = { v, N: world.N, list };
  return list;
}

/** Region grid helpers (REGION-tile squares). */
export function regionDims(world) {
  const rw = Math.max(1, Math.ceil(world.W / REGION)), rh = Math.max(1, Math.ceil(world.H / REGION));
  return { rw, rh, rn: rw * rh };
}
export const regionOf = (world, x, y) => Math.floor(y / REGION) * Math.max(1, Math.ceil(world.W / REGION)) + Math.floor(x / REGION);
export function regionCentre(world, r) {
  const rw = Math.max(1, Math.ceil(world.W / REGION));
  const rx = r % rw, ry = Math.floor(r / rw);
  return { x: Math.min(world.W - 1, rx * REGION + REGION / 2), y: Math.min(world.H - 1, ry * REGION + REGION / 2) };
}
