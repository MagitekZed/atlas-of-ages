// Hydrology: oceans, lakes, drainage and rivers derived from the current elevation and
// sea level. recomputeWater(world) reads only elevation, climate.seaLevel, baseMoisture,
// annTemp and params.riverDensity, and writes only hydrology fields (water, coast,
// distCoast, landmass, flowDir, flow, river) — so running it twice changes nothing.
//
// Pipeline:
//   1. Ocean = below sea level and connected to the map edge, or a large enclosed basin.
//   2. Priority-flood from the coast and map edge → filled surface, drainage tree.
//   3. Closed depressions are judged by size, depth and water balance (catchment runoff
//      against open-water evaporation): overflowing lakes, shrunken terminal lakes in
//      endorheic basins, dry salt pans, or (small) simply drained pits.
//   4. Flow accumulation weighted by baseMoisture, with evaporation losses over arid land
//      and open water; river classes by thresholds scaled by params.riverDensity.
//   5. coast, distCoast (chamfer distance), landmass (8-connected, largest first).
// Bumps versions.water and emits 'waterChanged'.

import { WATER } from '../core/constants.js';
import { MinHeap, clamp, clamp01, DX8, DY8 } from '../core/util.js';
import { bumpVersion } from '../core/world.js';
import { emit } from '../core/hooks.js';
import { priorityFlood, routeOnFilled, chamfer, labelComponents, num, REF_N, REF_H } from './grid.js';

/** River class thresholds (runoff in medium-map tile units) at riverDensity 0.5. */
export const RIVER_THRESHOLDS = [2, 7, 24, 70];

const DRAINED = 0, FULL = 1, TERMINAL = 2, PLAYA = 3;

function scratch(world) {
  const N = world.N;
  let s = world.cache.hydroScratch;
  if (s && s.N === N) return s;
  s = world.cache.hydroScratch = {
    N,
    ocean: new Uint8Array(N), mark: new Uint8Array(N), visited: new Uint8Array(N),
    comp: new Int32Array(N), queue: new Int32Array(N), cSize: new Int32Array(N), cEdge: new Uint8Array(N),
    F: new Float64Array(N), parent: new Int32Array(N), order: new Int32Array(N), list: new Int32Array(N),
    indeg: new Int32Array(N), runoff: new Float32Array(N), flow1: new Float32Array(N), keep: new Float32Array(N),
    dist: new Float32Array(N),
    heap: new MinHeap(Math.max(1024, N >> 2)),
  };
  return s;
}

/** River-class thresholds for the world's riverDensity. */
export function riverThresholds(world) {
  const dens = clamp01(num(world.params?.riverDensity, 0.5));
  const mult = Math.pow(2, (0.5 - dens) * 2.6);
  return RIVER_THRESHOLDS.map((t) => t * mult);
}

/**
 * Ocean = below `sea` and 8-connected to the map edge, or an enclosed below-sea basin of
 * at least 0.15 % of the map (an inland sea), or (given prev, the water mask before) a basin
 * that held sea: sea closed off by new land stays sea at sea level, a lagoon, rather than
 * filling to its rim as a lake. Writes ocean[i] ∈ {0,1}; returns the count.
 * comp/queue/cSize: Int32Array(N) scratch, cEdge: Uint8Array(N) scratch.
 */
export function oceanMask(W, H, e, sea, ocean, comp, queue, cSize, cEdge, prev = null) {
  const N = W * H;
  comp.fill(-1);
  let nb = 0;
  for (let s0 = 0; s0 < N; s0++) {
    if (comp[s0] >= 0 || !(e[s0] < sea)) continue;
    let qh = 0, qt = 0, edge = 0;
    queue[qt++] = s0; comp[s0] = nb;
    while (qh < qt) {
      const i = queue[qh++], x = i % W, y = (i / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || (prev && prev[i] === WATER.OCEAN)) edge = 1;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (comp[j] >= 0 || !(e[j] < sea)) continue;
        comp[j] = nb; queue[qt++] = j;
      }
    }
    cSize[nb] = qt; cEdge[nb] = edge; nb++;
  }
  const minBasin = Math.max(12, Math.round(N * 0.0015));
  let n = 0;
  for (let i = 0; i < N; i++) {
    const c = comp[i];
    const o = c >= 0 && (cEdge[c] || cSize[c] >= minBasin) ? 1 : 0;
    ocean[i] = o; n += o;
  }
  return n;
}

/**
 * Net open-water evaporation per tile at annual mean temperature T (°C), in the same
 * units as baseMoisture (1 ≈ 3000 mm/yr): ≈ 300 mm at 0 °C to ≈ 1700 mm at 25 °C,
 * less the rain that falls on the lake itself.
 */
const lakeEvap = (T, rain) => Math.max(0.01, clamp((300 + 55 * T) / 3000, 0.03, 0.75) - 0.6 * rain);

/** opts.keepSea: sea cut off from the ocean stays sea (during play; world generation leaves it out). */
export function recomputeWater(world, opts = {}) {
  const { W, H, N, f } = world;
  const e = f.elevation, water = f.water, dir = f.flowDir, flow = f.flow, river = f.river;
  let sea = Number(world.climate?.seaLevel);
  if (!Number.isFinite(sea)) sea = 0.5;
  sea = clamp(sea, 0.02, 0.98);
  const S = scratch(world);
  const { ocean, mark, visited, comp, queue, cSize, cEdge, F, parent, order, list, indeg, runoff, flow1, keep, dist, heap } = S;
  const areaScale = REF_N / N;

  // ---- 1. ocean mask
  const oceanTiles = oceanMask(W, H, e, sea, ocean, comp, queue, cSize, cEdge, opts.keepSea ? water : null);

  // ---- 2. priority flood + routing on the filled surface
  const n = priorityFlood(W, H, e, ocean, sea, F, parent, order, visited, heap);
  for (let i = 0; i < N; i++) if (ocean[i]) dir[i] = -1;
  routeOnFilled(W, H, F, parent, order, n, dir);

  // ---- 3. runoff and arid-land retention
  const moist = f.baseMoisture, annT = f.annTemp;
  let haveMoist = false, haveTemp = false;
  for (let i = 0; i < N; i += 7) { if (moist[i] > 0) haveMoist = true; if (annT[i] !== 0) haveTemp = true; if (haveMoist && haveTemp) break; }
  const lossK = 0.012 * (REF_H / H);
  for (let i = 0; i < N; i++) {
    if (ocean[i]) { runoff[i] = 0; keep[i] = 1; continue; }
    let m = haveMoist ? moist[i] : 0.3;
    if (!(m > 0)) m = 0; else if (m > 1.5) m = 1.5;
    runoff[i] = Math.pow(m, 1.35) * areaScale;
    const T = haveTemp && Number.isFinite(annT[i]) ? annT[i] : 10;
    const arid = clamp01(1 - m / 0.25) * clamp01((T + 5) / 30);
    keep[i] = 1 - lossK * arid;
  }

  // pass-1 accumulation without losses (inflow to each depression)
  flow1.fill(0);
  for (let k = n - 1; k >= 0; k--) {
    const i = order[k];
    const q = flow1[i] + runoff[i];
    flow1[i] = q;
    const d = dir[i];
    if (d >= 0 && !ocean[d]) flow1[d] += q;
  }

  // ---- 4. closed depressions → lakes / terminal lakes / salt pans / drained pits
  for (let i = 0; i < N; i++) mark[i] = !ocean[i] && F[i] - e[i] > 1e-6 ? 1 : 0;
  const sizes = labelComponents(W, H, mark, comp, queue);
  const nc = sizes.length;
  const start = new Int32Array(nc + 1);
  for (let c = 0; c < nc; c++) start[c + 1] = start[c] + sizes[c];
  const fill = start.slice(0, nc);
  for (let i = 0; i < N; i++) { const c = comp[i]; if (c >= 0) list[fill[c]++] = i; }
  const minLake = Math.max(2, Math.round(4 / areaScale));
  const minDepth = 0.002;          // ≈ 28 m below the spill point
  const kind = new Uint8Array(nc);
  const evapTot = new Float64Array(nc);
  const outlet = new Int32Array(nc).fill(-1);
  water.fill(WATER.LAND);
  for (let i = 0; i < N; i++) if (ocean[i]) water[i] = WATER.OCEAN;
  const lakes = [];
  // an exit leads out of basin c for good if its downstream chain drops below the spill
  // level, reaches the sea or a sink, without passing back through the basin
  const exitLeaves = (j, c, spill) => {
    for (let steps = 0; steps < 8192 && j >= 0; steps++) {
      if (ocean[j]) return true;
      if (comp[j] === c) return false;
      if (F[j] < spill - 1e-7) return true;
      j = dir[j];
    }
    return true;
  };
  for (let c = 0; c < nc; c++) {
    const a = start[c], b = start[c + 1], size = b - a;
    let maxDepth = 0, sumT = 0, sumM = 0, inflow = 0;
    for (let k = a; k < b; k++) {
      const i = list[k];
      const dpt = F[i] - e[i]; if (dpt > maxDepth) maxDepth = dpt;
      sumT += haveTemp && Number.isFinite(annT[i]) ? annT[i] : 10;
      sumM += haveMoist ? clamp01(moist[i]) : 0.3;
      if (flow1[i] > inflow) inflow = flow1[i];
    }
    if (size < minLake || maxDepth < minDepth) { kind[c] = DRAINED; continue; }
    const evap = lakeEvap(sumT / size, sumM / size) * areaScale;
    const sustain = inflow / Math.max(1e-9, evap);
    let lakeTiles = 0;
    if (sustain >= size) {
      kind[c] = FULL; lakeTiles = size; evapTot[c] = evap * size;
      // single outlet: the rim crossing that truly leaves the basin (lowest ground first,
      // then the most water); the whole basin is routed to it
      const spill = F[list[a]];
      let o = -1, oj = -1, bestF = Infinity, bestQ = -1;
      for (let k = a; k < b; k++) {
        const i = list[k], x = i % W, y = (i / W) | 0;
        for (let d = 0; d < 8; d++) {
          const nx = x + DX8[d], ny = y + DY8[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (comp[j] === c) continue;
          const fj = ocean[j] ? -1 : F[j];
          if (fj > bestF + 1e-9 || (Math.abs(fj - bestF) <= 1e-9 && flow1[i] <= bestQ)) continue;
          if (!exitLeaves(j, c, spill)) continue;
          o = i; oj = j; bestF = fj; bestQ = flow1[i];
        }
      }
      if (o < 0) { o = list[a]; oj = -1; }        // no way out found: the basin's own sink
      dir[o] = oj;
      outlet[c] = o;
      let qh = 0, qt = 0;
      queue[qt++] = o; visited[o] = 2;
      for (let k = a; k < b; k++) if (list[k] !== o) visited[list[k]] = 0;
      while (qh < qt) {
        const i = queue[qh++], x = i % W, y = (i / W) | 0;
        for (let d = 0; d < 8; d++) {
          const nx = x + DX8[d], ny = y + DY8[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (comp[j] !== c || visited[j] === 2) continue;
          visited[j] = 2; dir[j] = i; queue[qt++] = j;
        }
      }
      for (let k = a; k < b; k++) water[list[k]] = WATER.LAKE;
    } else {
      // endorheic: water runs downhill to the basin floor and evaporates there
      for (let k = a; k < b; k++) {
        const i = list[k], x = i % W, y = (i / W) | 0, ei = e[i];
        let best = -1, bs = 0;
        for (let d = 0; d < 8; d++) {
          const nx = x + DX8[d], ny = y + DY8[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          const drop = (ei - e[j]) / (d & 1 ? Math.SQRT2 : 1);
          if (drop > bs) { bs = drop; best = j; }
        }
        dir[i] = best;   // −1 at the floor: a true sink
      }
      lakeTiles = Math.min(size, Math.floor(sustain));
      if (lakeTiles >= minLake) {
        kind[c] = TERMINAL;
        const tiles = Array.from(list.subarray(a, b)).sort((p, q) => e[p] - e[q] || p - q);
        for (let k = 0; k < lakeTiles; k++) water[tiles[k]] = WATER.LAKE;
      } else { kind[c] = PLAYA; lakeTiles = 0; }
    }
    if (lakeTiles > 0) {
      let sx = 0, sy = 0, deep = -1, di = list[a];
      for (let k = a; k < b; k++) {
        const i = list[k];
        if (water[i] !== WATER.LAKE) continue;
        sx += i % W; sy += (i / W) | 0;
        const dp = F[i] - e[i];
        if (dp > deep) { deep = dp; di = i; }
      }
      lakes.push({
        id: lakes.length, tiles: lakeTiles, x: di % W, y: (di / W) | 0, cx: sx / lakeTiles, cy: sy / lakeTiles,
        level: F[list[a]], depth: deep, terminal: kind[c] === TERMINAL, basin: size,
      });
    }
  }

  // ---- 5. accumulation with losses (Kahn order over the final drainage graph)
  indeg.fill(0);
  for (let i = 0; i < N; i++) {
    if (ocean[i]) continue;
    const d = dir[i];
    if (d >= 0 && !ocean[d]) indeg[d]++;
  }
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (!ocean[i] && indeg[i] === 0) queue[qt++] = i;
  flow.fill(0);
  const landTiles = N - oceanTiles;
  for (let pass = 0; pass < 2; pass++) {
    while (qh < qt) {
      const i = queue[qh++];
      let q = flow[i] + runoff[i];
      const c = comp[i];
      if (c >= 0 && outlet[c] === i) q = Math.max(0, q - evapTot[c]);
      else if (water[i] === WATER.LAND) q *= keep[i];
      flow[i] = q;
      const d = dir[i];
      if (d >= 0 && !ocean[d]) { flow[d] += q; if (--indeg[d] === 0) queue[qt++] = d; }
    }
    if (qt >= landTiles) break;
    // safety net: in a one-successor graph the tiles Kahn leaves behind lie on cycles.
    // Walk each cycle, cut it at one tile (which becomes a sink) and let the water drain.
    for (let i = 0; i < N; i++) {
      if (ocean[i] || indeg[i] <= 0 || mark[i] === 2) continue;
      let j = i;
      for (let guard = 0; guard < N && mark[j] !== 2; guard++) {
        mark[j] = 2;
        const d = dir[j];
        if (d < 0 || ocean[d]) break;
        j = d;
      }
      const d = dir[j];
      if (d >= 0 && !ocean[d]) {
        dir[j] = -1;
        if (--indeg[d] === 0) queue[qt++] = d;
      }
    }
    for (let i = 0; i < N; i++) if (mark[i] === 2) mark[i] = 0;
  }

  // ---- 6. river classes
  const [t1, t2, t3, t4] = riverThresholds(world);
  let riverTiles = 0;
  for (let i = 0; i < N; i++) {
    if (water[i] !== WATER.LAND) { river[i] = 0; continue; }
    const q = flow[i];
    const r = q >= t4 ? 4 : q >= t3 ? 3 : q >= t2 ? 2 : q >= t1 ? 1 : 0;
    river[i] = r; if (r) riverTiles++;
  }

  // ---- 7. coast, distance to coast, landmasses
  const coast = f.coast, dc = f.distCoast;
  for (let i = 0; i < N; i++) {
    dist[i] = ocean[i] ? 0 : 1e9;
    coast[i] = 0;
    if (water[i] !== WATER.LAND) continue;
    const x = i % W, y = (i / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (ocean[ny * W + nx]) { coast[i] = 1; break; }
    }
  }
  chamfer(W, H, dist);
  for (let i = 0; i < N; i++) {
    if (water[i] !== WATER.LAND) { dc[i] = 0; continue; }
    const v = Math.round(dist[i] - 1);
    dc[i] = v <= 0 ? 0 : v > 65535 ? 65535 : v;
  }
  for (let i = 0; i < N; i++) mark[i] = water[i] === WATER.LAND ? 1 : 0;
  const lsz = labelComponents(W, H, mark, comp, queue);
  const ids = lsz.map((_, k) => k).sort((a, b) => lsz[b] - lsz[a] || a - b);
  const remap = new Int32Array(lsz.length);
  ids.forEach((old, rank) => { remap[old] = rank; });
  const lm = f.landmass;
  for (let i = 0; i < N; i++) lm[i] = comp[i] >= 0 ? remap[comp[i]] : -1;

  world.cache.hydro = {
    version: (world.versions.water || 0) + 1,
    sea,
    lakes,
    landmasses: ids.map((old, rank) => ({ id: rank, size: lsz[old] })),
    playas: kind.reduce((s, k) => s + (k === PLAYA ? 1 : 0), 0),
  };
  if (world.climate) world.climate.appliedSeaLevel = sea;
  bumpVersion(world, 'water');
  emit(world, 'waterChanged');
  return { oceanTiles, lakes: lakes.length, riverTiles, landmasses: lsz.length };
}

/** Lake list from the last recompute (rebuilt on demand if the cache was lost). */
export function lakeList(world) {
  const h = world.cache.hydro;
  if (h && h.version === world.versions.water) return h.lakes;
  // cache lost (e.g. after load): recover lake components from the water mask
  const { W, H, N, f } = world;
  const mark = new Uint8Array(N), lab = new Int32Array(N), q = new Int32Array(N);
  for (let i = 0; i < N; i++) mark[i] = f.water[i] === WATER.LAKE ? 1 : 0;
  const sizes = labelComponents(W, H, mark, lab, q);
  const acc = sizes.map((s, id) => ({ id, tiles: s, x: 0, y: 0, cx: 0, cy: 0, level: 0, depth: 0, terminal: false, basin: s, _b: -1 }));
  for (let i = 0; i < N; i++) {
    const c = lab[i]; if (c < 0) continue;
    const L = acc[c]; L.cx += (i % W) / L.tiles; L.cy += ((i / W) | 0) / L.tiles;
    if (L._b < 0 || f.elevation[i] < f.elevation[L._b]) { L._b = i; L.x = i % W; L.y = (i / W) | 0; }
  }
  for (const L of acc) delete L._b;
  return acc;
}
