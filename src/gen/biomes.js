// Biome classification, Whittaker-style: annual mean temperature against an aridity
// index (precipitation over potential evapotranspiration), plus ICE for the very cold,
// ALPINE above the tree line, WETLAND on flat, wet lowlands beside big rivers, lakes
// and deltas, and DEEP_OCEAN vs OCEAN by depth (shelf ≥ seaLevel − 0.08).
//
// classifyBiomes(world) → number of tiles whose biome changed. Climate calls it yearly;
// a small hysteresis band keeps tiles near a threshold from flickering year to year
// (a tile keeps its biome while a slightly perturbed climate would still produce it).

import { BIOME, WATER } from '../core/constants.js';
import { bumpVersion, ensureField } from '../core/world.js';
import { DX8, DY8 } from '../core/util.js';

const MM = 3000;                 // annRain 1.0 ≈ 3000 mm/yr
const HYST_T = 1.0;              // °C
const HYST_P = 0.1;              // fraction of precipitation
const MEMORY = 0.12;             // share of a year's climate folded into the normals (≈ 8-year memory)
const NORMALS_EVERY = 300;       // days between blends (classifyBiomes may run more often)

/** Potential evapotranspiration (mm/yr) at annual mean temperature T. */
export const pet = (T) => (T > 0 ? 330 + 46 * T : Math.max(140, 330 + 12 * T));

/**
 * Land biome for a climate. T °C, P mm/yr, hKm height above sea level (km),
 * wet: 0..1 wetland suitability (flat, by water), already including its own gating.
 */
export function landBiome(T, P, hKm, wet) {
  if (hKm > 4.3) return T < -16 && P > 40 ? BIOME.ICE : BIOME.ALPINE;
  if (T < -10.5) return P > 45 ? BIOME.ICE : BIOME.COLD_DESERT;   // ice sheets need snowfall to build
  if (hKm > 2.4 && T < -1.5) return BIOME.ALPINE;
  const ai = P / pet(T);
  if (wet > 0 && ai > 0.6 && T > -3 && wet > 1.0 - Math.min(0.5, (ai - 0.6) * 0.6)) return BIOME.WETLAND;
  if (T < -4) return BIOME.TUNDRA;
  if (T < 3.5) {
    if (ai < 0.22) return BIOME.COLD_DESERT;
    if (ai < 0.45) return BIOME.STEPPE;
    return BIOME.TAIGA;
  }
  if (T < 19) {
    if (ai < 0.16) return T > 14 ? BIOME.HOT_DESERT : BIOME.COLD_DESERT;
    if (ai < 0.4) return BIOME.STEPPE;
    if (ai < 0.62) return T < 8 ? BIOME.STEPPE : BIOME.SHRUBLAND;
    if (T < 6 && ai > 0.75) return BIOME.TAIGA;
    if (ai > 1.45 && T < 16.5) return BIOME.TEMPERATE_RAINFOREST;
    return BIOME.TEMPERATE_FOREST;
  }
  if (ai < 0.16) return BIOME.HOT_DESERT;
  if (ai < 0.55) return BIOME.SAVANNA;
  if (ai < 1.15) return BIOME.TROPICAL_FOREST;
  return BIOME.RAINFOREST;
}

/**
 * Climate normals: decadal means of annTemp and annRain (f.biomeTemp, f.biomeRain) that
 * biomes respond to, so one wet or dry year does not redraw the map. Blended toward the
 * current annual means at most once per NORMALS_EVERY days; seeded from them at genesis
 * or when absent (old saves, fallback worlds).
 */
function climateNormals(world, initial) {
  const { N, f } = world;
  const fresh = !f.biomeTemp || f.biomeTemp.length !== N || !f.biomeRain || f.biomeRain.length !== N;
  const Tn = ensureField(world, 'biomeTemp', Float32Array, N);
  const Pn = ensureField(world, 'biomeRain', Float32Array, N);
  const st = (world.sys.biomes ||= { lastBlend: -1e9 });
  const day = world.time?.day ?? 0;
  const annT = f.annTemp, annR = f.annRain;
  if (initial || fresh) {
    for (let i = 0; i < N; i++) {
      Tn[i] = Number.isFinite(annT[i]) ? annT[i] : 10;
      Pn[i] = Number.isFinite(annR[i]) && annR[i] >= 0 ? annR[i] : 0.3;
    }
    st.lastBlend = day;
  } else if (day - st.lastBlend >= NORMALS_EVERY) {
    for (let i = 0; i < N; i++) {
      const t = annT[i], r = annR[i];
      if (Number.isFinite(t)) Tn[i] += MEMORY * (t - Tn[i]);
      if (Number.isFinite(r) && r >= 0) Pn[i] += MEMORY * (r - Pn[i]);
    }
    st.lastBlend = day;
  }
  return [Tn, Pn];
}

/**
 * Reclassify f.biome from climate normals. opts.initial: genesis (normals seeded from the
 * annual means, no hysteresis). Returns changedCount; bumps versions.biome on change.
 */
export function classifyBiomes(world, opts = {}) {
  const { W, H, N, f } = world;
  const e = f.elevation, water = f.water, biome = f.biome, river = f.river;
  const [annT, annR] = climateNormals(world, Boolean(opts.initial));
  let sea = Number(world.climate?.seaLevel);
  if (!Number.isFinite(sea)) sea = 0.5;
  const shelf = sea - 0.08;
  const span = Math.max(1e-6, 1 - sea);
  const initial = Boolean(opts.initial);
  let changed = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const w = water[i];
    let b;
    if (w === WATER.OCEAN) b = e[i] >= shelf ? BIOME.OCEAN : BIOME.DEEP_OCEAN;
    else if (w === WATER.LAKE) b = BIOME.LAKE;
    else {
      let T = annT[i]; if (!Number.isFinite(T)) T = 10;
      let r = annR[i]; if (!Number.isFinite(r) || r < 0) r = 0.3;
      const P = r * MM;
      const hKm = Math.max(0, (e[i] - sea) / span) * 7;
      const wet = wetness(world, x, y, i, hKm);
      b = landBiome(T, P, hKm, wet);
      const cur = biome[i];
      if (!initial && b !== cur && isLandBiome(cur)) {
        // hysteresis: keep the current biome if a nearby climate would still yield it
        if (landBiome(T + HYST_T, P, hKm, wet) === cur || landBiome(T - HYST_T, P, hKm, wet) === cur ||
            landBiome(T, P * (1 + HYST_P), hKm, wet) === cur || landBiome(T, P * (1 - HYST_P), hKm, wet) === cur) b = cur;
      }
    }
    if (biome[i] !== b) { biome[i] = b; changed++; }
  }
  if (changed) bumpVersion(world, 'biome');
  return changed;
}

const isLandBiome = (b) => b !== BIOME.DEEP_OCEAN && b !== BIOME.OCEAN && b !== BIOME.LAKE;

/**
 * Wetland suitability 0..~1.7: low ground with little relief beside a big river, a lake,
 * or a river mouth (floodplains, deltas, lake margins, boreal muskeg). 0 when none applies.
 */
function wetness(world, x, y, i, hKm) {
  if (hKm > 0.8) return 0;
  const { W, H, f } = world;
  const e = f.elevation, river = f.river, water = f.water;
  let lakeAdj = 0, sumRel = 0, n = 0;
  const ei = e[i];
  for (let d = 0; d < 8; d++) {
    const nx = x + DX8[d], ny = y + DY8[d];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    if (water[j] === WATER.LAKE) lakeAdj = 1;
    sumRel += Math.abs(e[j] - ei); n++;
  }
  const rel = n ? sumRel / n : 0;                     // mean local relief
  if (rel > 0.009) return 0;
  const r = river[i];
  const down = f.flowDir[i];
  const grad = down >= 0 && down < e.length ? Math.max(0, ei - e[down]) : 0;
  if (r > 0 && grad > 0.006) return 0;                // a fast mountain stream, not a floodplain
  let s = 0;
  if (r >= 3) s += 0.6 + 0.25 * (r - 3);
  else if (r === 2) s += 0.38;
  else if (r === 1) s += 0.15;
  if (lakeAdj) s += 0.6;
  if (f.coast[i] && r >= 2) s += 0.45;               // deltas and estuaries
  if (s <= 0) return 0;
  s += 0.45 * (1 - hKm / 0.8);                        // the lower and flatter, the wetter
  s += 0.3 * (1 - rel / 0.009);
  const T = f.annTemp[i];
  if (T > -4 && T < 4 && rel < 0.004) s += 0.25;      // boreal muskeg on flat, poorly drained ground
  return s;
}
