// Land evaluation shared by genesis, expansion, emergence, territory and settlement
// economies: habitability grid, crop suitability, per-tile travel cost for territory,
// and "proxy" detection when ecology fields are not being simulated (headless subsets).
// Everything here is derived data kept in world.cache.civ and rebuilt on demand, except the
// month's proxy flags (sys.civ.proxy), which are state.

import { BIOMES, BIOME, WATER } from '../../core/constants.js';
import { smoothstep, clamp01, DX8, DY8 } from '../../core/util.js';
import { civCache } from './state.js';
import { ensureField } from '../../core/world.js';

/** Crop temperature suitability from the annual mean (°C). */
export const suitTemp = (t) => smoothstep(-1, 9, t) * (1 - 0.55 * smoothstep(27, 35, t));
/** Crop moisture suitability from a 0..1 moisture index. */
export const suitMoist = (m) => smoothstep(0.05, 0.3, m) * (1 - 0.35 * smoothstep(0.85, 1.0, m));

/** True if any 8-neighbour of i is a lake. */
export function nearLake(world, i) {
  const { W, H, f } = world;
  const x = i % W, y = (i / W) | 0;
  for (let d = 0; d < 8; d++) {
    const nx = x + DX8[d], ny = y + DY8[d];
    if (nx >= 0 && ny >= 0 && nx < W && ny < H && f.water[ny * W + nx] === WATER.LAKE) return true;
  }
  return false;
}

/** Per-tile lake-shore flags (8-neighbour), cached by water version. */
export function lakeShore(world) {
  const c = civCache(world);
  const v = world.versions.water;
  if (c.lakeAdj && c.lakeAdj.length === world.N && c.lakeAdjV === v) return c.lakeAdj;
  const { W, H, N, f } = world;
  const a = c.lakeAdj && c.lakeAdj.length === N ? c.lakeAdj : new Uint8Array(N);
  a.fill(0);
  for (let i = 0; i < N; i++) {
    if (f.water[i] !== WATER.LAKE) continue;
    const x = i % W, y = (i / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) a[ny * W + nx] = 1;
    }
  }
  c.lakeAdj = a; c.lakeAdjV = v;
  return a;
}

/** Fresh-water access of a land tile: river class, lake shore. */
export const freshWater = (world, i) => world.f.river[i] > 0 || nearLake(world, i);

/**
 * Habitability 0..1 of every land tile: food potential (wild + farm), fresh water, coast,
 * temperate climate, minus altitude and ice. Cached; rebuilt yearly (forced, at midsummer)
 * and between times only when the land itself changed — terrain or coastlines — at most
 * monthly. The slow drift of biomes waits for the yearly refresh.
 */
export function habitGrid(world, force = false) {
  const c = civCache(world);
  const v = world.versions;
  // versions minus versions.load survive save/load (every version is bumped once on load)
  const L = v.load || 0;
  const key = `${v.terrain - L}|${v.water - L}|${v.biome - L}`;
  const st = world.sys.civ;
  const { N, f } = world;
  restoreHabit(world, c);
  const landKey = `${v.terrain - L}|${v.water - L}|`;
  if (!force && c.habit && c.habit.length === N && (c.habitKey === key || String(c.habitKey).startsWith(landKey) || world.time.day - c.habitDay < 30)) return c.habit;
  const h = ensureField(world, 'civHabit', Float32Array, N);
  const ct = ensureField(world, 'civClimT', Float32Array, N);
  const lake = lakeShore(world);
  habitKernel(N, f.water, f.biome, f.annTemp, f.soil, f.river, lake, f.coast, f.annRain, f.soilWater, f.elevation, f.snow, f.resource, f.devastation, h, ct);
  c.habit = h; c.climT = ct; c.habitKey = key; c.habitDay = world.time.day;
  if (st) { st.habitKey = key; st.habitDay = world.time.day; }
  return h;
}

// Biome properties by biome id as typed tables (Float64: the very numbers of BIOMES), so the
// grid passes below run as kernels over typed arrays only: rebuilt yearly or rarer, a pass
// that read the BIOMES objects ran far slower and was thrown out of optimised code often.
const HAB_B = (b) => BIOMES[b] || BIOMES[BIOME.STEPPE];
const T_HABIT = Float64Array.from({ length: 256 }, (_, b) => HAB_B(b).habit);
const T_FARM = Float64Array.from({ length: 256 }, (_, b) => HAB_B(b).farm);
const T_WILD = Float64Array.from({ length: 256 }, (_, b) => HAB_B(b).wildFood);
const T_MOVE = Float64Array.from({ length: 256 }, (_, b) => { const B = BIOMES[b]; return B && B.move > 0 ? B.move : 1.2; });

/** The habitability pass (habitGrid), tile by tile exactly as it was written inline. */
function habitKernel(N, water, biome, annTemp, soil, river, lake, coast, annRain, soilWater, elevation, snow, resource, devastation, h, ct) {
  for (let i = 0; i < N; i++) {
    if (water[i] !== LAND) { h[i] = 0; ct[i] = 0; continue; }
    const b = biome[i];
    const t = annTemp[i];
    ct[i] = suitTemp(t);
    let s = 0.35 * T_HABIT[b] + 0.25 * T_FARM[b] * Math.min(1.2, soil[i] / 0.6) + 0.12 * T_WILD[b];
    const r = river[i];
    if (r > 0) s += 0.1 + 0.04 * r;
    else if (lake[i]) s += 0.12;
    if (coast[i]) s += 0.08;
    s += 0.12 * suitTemp(t) * suitMoist(0.5 * annRain[i] + 0.5 * soilWater[i]);
    const e = elevation[i];
    if (e > 0.75) s -= 0.25; else if (e > 0.62) s -= 0.07;
    s -= 0.3 * snow[i];
    if (resource[i]) s += 0.04;
    s -= 0.3 * devastation[i];
    // the cold is hard on people whatever the land offers: frozen grasslands and taiga are
    // thinly peopled next to temperate plains (ct[i] as stored)
    s *= 0.4 + 0.6 * ct[i];
    h[i] = clamp01(s);
  }
}
const LAND = WATER.LAND;

/** The overland cost pass (landCostGrid). */
function landCostKernel(N, water, biome, elevation, river, lc) {
  for (let i = 0; i < N; i++) {
    if (water[i] !== LAND) { lc[i] = 0; continue; }
    let m = T_MOVE[biome[i]];
    const e = elevation[i];
    if (e > 0.88) m *= 3; else if (e > 0.75) m *= 2.1; else if (e > 0.62) m *= 1.3;
    if (river[i] >= 3) m += 0.6;
    lc[i] = m;
  }
}

/** After a load: take up the grid the running world was using (saved), not one built from today's land. */
function restoreHabit(world, c) {
  if (c.habit) return;
  const st = world.sys.civ, f = world.f, N = world.N;
  if (st && st.habitKey != null && f.civHabit && f.civHabit.length === N && f.civClimT && f.civClimT.length === N) {
    c.habit = f.civHabit; c.climT = f.civClimT; c.habitKey = st.habitKey; c.habitDay = st.habitDay;
  }
}

/** Crop temperature suitability per tile (refreshed with the habitability grid). */
export function climGrid(world) {
  const c = civCache(world);
  if (!c.climT || c.climT.length !== world.N) restoreHabit(world, c);
  if (!c.climT || c.climT.length !== world.N) habitGrid(world, true);
  return c.climT;
}

// Biome properties as typed arrays (indexed by biome id) for hot loops.
export const BIO_WILD = Float32Array.from(BIOMES, (b) => b.wildFood);
export const BIO_VEGMAX = Float32Array.from(BIOMES, (b) => b.vegMax);
export const BIO_HERB = Float32Array.from(BIOMES, (b) => b.herbCap);
export const BIO_WOOD = Float32Array.from(BIOMES, (b) => b.wood);
export const BIO_FARM = Float32Array.from(BIOMES, (b) => b.farm);
export const BIO_FISH = Float32Array.from(BIOMES, (b) => Math.max(0.3, b.fish || 0.5));

/**
 * Per-tile overland cost for territory spread (land only; water handled by the caller):
 * biome move cost × relief, +river barrier for great rivers. Cached by terrain version.
 */
export function landCostGrid(world) {
  const c = civCache(world);
  const v = world.versions;
  const key = `${v.terrain}|${v.water}|${v.biome}`;
  if (c.landCost && c.landCost.length === world.N && c.landCostKey === key) return c.landCost;
  const { N, f } = world;
  const lc = c.landCost && c.landCost.length === N ? c.landCost : new Float32Array(N);
  landCostKernel(N, f.water, f.biome, f.elevation, f.river, lc);
  c.landCost = lc; c.landCostKey = key;
  return lc;
}

/**
 * Detect whether ecology fields are live. If vegetation / herds / fish are all zero (the
 * ecology system is absent), settlement economies fall back to biome-based estimates so
 * the civ module still produces sensible histories on its own. Judged at each month start
 * and kept as state (sys.civ.proxy), so a world saved or keyframed mid-month reads the same
 * flags as the running one, even when a slider has pushed a mean across a threshold since.
 */
export function updateProxies(world) {
  const c = civCache(world);
  const { N, f } = world;
  let veg = 0, herb = 0, fish = 0, nl = 0, nw = 0;
  for (let i = 0; i < N; i += 17) {
    if (f.water[i] === WATER.LAND) { veg += f.veg[i]; herb += f.herb[i]; nl++; }
    else { fish += f.fish[i]; nw++; }
  }
  c.proxy = {
    veg: nl > 0 && veg / nl < 0.01,
    herb: nl > 0 && herb / nl < 0.002,
    fish: nw > 0 && fish / nw < 0.002,
  };
  if (world.sys.civ) world.sys.civ.proxy = c.proxy;
  return c.proxy;
}
export function proxies(world) {
  const c = civCache(world);
  if (c.proxy) return c.proxy;
  const p = world.sys.civ?.proxy;
  if (p && typeof p === 'object') return (c.proxy = { veg: !!p.veg, herb: !!p.herb, fish: !!p.fish });
  return updateProxies(world);
}

/** List of coastal land tiles (for overseas colonisation searches). Cached by water version. */
export function coastTiles(world) {
  const c = civCache(world);
  const v = world.versions.water;
  if (c.coastList && c.coastListV === v) return c.coastList;
  const { N, f } = world;
  let n = 0;
  for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND && f.coast[i]) n++;
  const out = new Int32Array(n);
  n = 0;
  for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND && f.coast[i]) out[n++] = i;
  c.coastList = out; c.coastListV = v;
  return out;
}
