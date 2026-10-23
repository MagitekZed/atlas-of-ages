// Stage 7 · Soil, minerals, resource deposits and a starting vegetation estimate.
//   soil     — biome baseline; alluvial river valleys, lake shores and volcanic plains
//              rich; steep, high, frozen or arid ground poor; × params.soilFertility.
//   mineral  — ore richness from mountains, plate-boundary stress and volcanic arcs.
//   resource — ~3 % of land tiles hold a deposit chosen by geology/biome rules
//              (weighted sampling with spacing; rare kinds placed first).
//   veg/vegCap — an initial biomass guess so a freshly generated map (or a preview)
//              looks alive before ecology takes over.

import { RNG, createNoise2D } from '../core/rng.js';
import { BIOME, BIOMES, WATER, RESOURCES } from '../core/constants.js';
import { clamp01, smoothstep, DX8, DY8 } from '../core/util.js';
import { fbmL, octavesFor, weightedOrder, num } from './grid.js';

const SOIL_BASE = {
  [BIOME.ICE]: 0.02, [BIOME.TUNDRA]: 0.22, [BIOME.TAIGA]: 0.4, [BIOME.STEPPE]: 0.78, [BIOME.SHRUBLAND]: 0.5,
  [BIOME.TEMPERATE_FOREST]: 0.68, [BIOME.TEMPERATE_RAINFOREST]: 0.6, [BIOME.HOT_DESERT]: 0.08, [BIOME.COLD_DESERT]: 0.12,
  [BIOME.SAVANNA]: 0.52, [BIOME.TROPICAL_FOREST]: 0.6, [BIOME.RAINFOREST]: 0.55, [BIOME.WETLAND]: 0.7, [BIOME.ALPINE]: 0.15,
};

export function buildSoilAndMinerals(world, ctx) {
  const { W, H, N, f, params, seed } = world;
  const e = f.elevation, water = f.water, biome = f.biome, river = f.river, pb = f.plateBoundary;
  const fert = Math.max(0, num(params.soilFertility, 1));
  const nS = createNoise2D(seed + ':soil'), nM = createNoise2D(seed + ':mineral');
  const oS = octavesFor(H, 6, 3), oM = octavesFor(H, 8, 3);
  // volcanic plains around volcano sites (normalised radius 0.05)
  const volcBoost = new Float32Array(N);
  for (const s of ctx.volcanoSites || []) {
    const R = 0.05;
    const x0 = Math.max(0, Math.floor((s.u - R) * H)), x1 = Math.min(W - 1, Math.ceil((s.u + R) * H));
    const y0 = Math.max(0, Math.floor((s.v - R) * H)), y1 = Math.min(H - 1, Math.ceil((s.v + R) * H));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot((x + 0.5) / H - s.u, (y + 0.5) / H - s.v) / R;
      if (d < 1) { const i = y * W + x; volcBoost[i] = Math.max(volcBoost[i], 0.22 * (1 - d * d)); }
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const u = (x + 0.5) / H, v = (y + 0.5) / H;
    if (water[i] !== WATER.LAND) { f.soil[i] = 0; f.mineral[i] = 0; continue; }
    // slope (max drop to a neighbour, per tile, scaled to resolution)
    let slope = 0, nearRiver = 0, lakeAdj = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      const dz = Math.abs(e[j] - e[i]) * H / 160;
      if (dz > slope) slope = dz;
      if (river[j] > nearRiver) nearRiver = river[j];
      if (water[j] === WATER.LAKE) lakeAdj = 1;
    }
    let s = SOIL_BASE[biome[i]] ?? 0.4;
    const r = river[i];
    s += 0.07 * r + (r < 2 && nearRiver >= 2 ? 0.05 : 0);         // alluvium
    if (lakeAdj) s += 0.05;
    s += volcBoost[i];
    s -= Math.min(0.3, slope * 4.5);
    s -= 0.25 * smoothstep(0.7, 0.9, e[i]);
    s += 0.07 * fbmL(nS, u * 6, v * 6, 3, oS);
    f.soil[i] = clamp01(s * fert);
    const mount = smoothstep(0.6, 0.85, e[i]);
    const m = 0.1 + 0.42 * mount + 0.38 * pb[i] + 0.4 * volcBoost[i] + 0.16 * fbmL(nM, u * 8, v * 8, 3, oM);
    f.mineral[i] = clamp01(m);
  }
}

/** Initial vegetation: biome capacity × moisture × warmth × soil. */
export function seedVegetation(world) {
  const { N, f } = world;
  for (let i = 0; i < N; i++) {
    if (f.water[i] !== WATER.LAND) { f.veg[i] = 0; f.vegCap[i] = 0; continue; }
    const B = BIOMES[f.biome[i]];
    const m = clamp01(0.35 + 1.6 * f.soilWater[i]);
    const t = clamp01((f.annTemp[i] + 12) / 20);
    const cap = clamp01((B?.vegMax ?? 0.3) * m * (0.35 + 0.65 * t) * (0.65 + 0.35 * clamp01(f.soil[i] / 0.6)));
    f.vegCap[i] = cap; f.veg[i] = cap * 0.92;
  }
}

// ---------------------------------------------------------------------------- resources

const SHARE = { gems: 0.035, gold: 0.06, tin: 0.05, oil: 0.07, marble: 0.065, copper: 0.1, spices: 0.08, furs: 0.08, salt: 0.09, coal: 0.11, horses: 0.11, iron: 0.12 };
const ORDER = ['gems', 'gold', 'tin', 'oil', 'marble', 'copper', 'spices', 'furs', 'salt', 'coal', 'horses', 'iron'];
const RID = Object.fromEntries(RESOURCES.map((r) => [r.key, r.id]));

export function placeResources(world, ctx) {
  const { W, H, N, f, seed } = world;
  const rng = new RNG(seed + ':resources');
  const e = f.elevation, water = f.water, biome = f.biome, river = f.river, pb = f.plateBoundary;
  f.resource.fill(0); f.resourceAmt.fill(0);
  let landN = 0;
  for (let i = 0; i < N; i++) if (water[i] === WATER.LAND) landN++;
  if (!landN) return {};
  const total = Math.round(landN * 0.03);
  const playa = ctx.playaMask || null;
  // shared terrain terms, computed once
  const hill = new Float32Array(N), mount = new Float32Array(N), low = new Float32Array(N), shield = new Float32Array(N);
  const dScale = 160 / H;
  for (let i = 0; i < N; i++) {
    if (water[i] !== WATER.LAND) continue;
    const el = e[i];
    hill[i] = smoothstep(0.55, 0.64, el) * (1 - smoothstep(0.8, 0.9, el));
    mount[i] = smoothstep(0.68, 0.8, el);
    low[i] = 1 - smoothstep(0.52, 0.6, el);
    shield[i] = (1 - Math.min(1, pb[i] * 2)) * smoothstep(4, 20, f.distCoast[i] * dScale);
  }
  const score = (key, i) => {
    if (water[i] !== WATER.LAND) return 0;
    const b = biome[i], p = pb[i], h = hill[i], mt = mount[i], lo = low[i];
    switch (key) {
      case 'copper': return (h + 0.6 * mt) * (0.25 + p) + 0.15 * shield[i] * h;
      case 'tin': return h * (0.15 + p) * (b === BIOME.TAIGA || b === BIOME.TEMPERATE_FOREST ? 1 : 0.7);
      case 'iron': return 0.8 * h * (0.3 + 0.5 * p) + 0.45 * lo * shield[i] + 0.2 * mt;
      case 'gold': return mt * (0.25 + p) + (river[i] >= 2 && e[i] < 0.62 ? 0.25 * p + 0.12 : 0);
      case 'gems': return mt * p * 0.6 + 0.12 * shield[i] * h + (b === BIOME.RAINFOREST && h > 0 ? 0.1 : 0);
      case 'marble': return h * (0.35 + 0.65 * p);
      case 'horses': return (b === BIOME.STEPPE ? 1 : b === BIOME.SAVANNA ? 0.45 : b === BIOME.SHRUBLAND ? 0.4 : 0) * (1 - mt);
      case 'spices': return (b === BIOME.TROPICAL_FOREST ? 1 : b === BIOME.RAINFOREST ? 0.85 : b === BIOME.SAVANNA ? 0.15 : 0) * (f.annTemp[i] > 19 ? 1 : 0.3);
      case 'salt': return (playa && playa[i] ? 1.3 : 0) + (b === BIOME.HOT_DESERT ? 0.7 : b === BIOME.COLD_DESERT ? 0.45 : 0) * lo + (f.coast[i] && f.baseMoisture[i] < 0.2 ? 0.6 : 0);
      case 'furs': return b === BIOME.TAIGA ? 1 : b === BIOME.TUNDRA ? 0.65 : b === BIOME.TEMPERATE_RAINFOREST ? 0.2 : 0;
      case 'coal': return lo * (b === BIOME.TEMPERATE_FOREST ? 1 : b === BIOME.WETLAND ? 0.7 : b === BIOME.STEPPE ? 0.6 : b === BIOME.TAIGA ? 0.45 : b === BIOME.TEMPERATE_RAINFOREST ? 0.5 : 0.08) * (1 - Math.min(1, p * 1.5));
      case 'oil': return (b === BIOME.HOT_DESERT ? 1 : b === BIOME.COLD_DESERT ? 0.5 : b === BIOME.WETLAND ? 0.4 : 0.05) * lo + (f.coast[i] ? 0.35 * lo : 0);
      default: return 0;
    }
  };
  // a deposit blocks its neighbours; the same kind keeps 3 tiles apart
  const taken = new Uint8Array(N);
  const counts = {};
  let budget = total;
  const tryPlace = (key, want) => {
    if (want <= 0) return 0;
    const rid = RID[key];
    const order = weightedOrder(rng, N, (i) => (taken[i] ? 0 : score(key, i)), 0.06);
    let placed = 0;
    for (let k = 0; k < order.length && placed < want; k++) {
      const i = order[k];
      if (taken[i]) continue;
      const x = i % W, y = (i / W) | 0;
      let clash = false;
      for (let dy = -3; dy <= 3 && !clash; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= H) continue;
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= W) continue;
          if (f.resource[ny * W + nx] === rid) { clash = true; break; }
        }
      }
      if (clash) continue;
      f.resource[i] = rid; f.resourceAmt[i] = 1; placed++;
      taken[i] = 1;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx >= 0 && ny >= 0 && nx < W && ny < H) taken[ny * W + nx] = 1;
      }
    }
    return placed;
  };
  for (const k of ORDER) {
    const p = tryPlace(k, Math.min(Math.round(total * SHARE[k]), budget));
    counts[k] = p; budget -= p;
  }
  // spend what kinds without habitat could not use on the widespread ones
  for (const k of ['iron', 'copper', 'horses', 'coal', 'salt', 'marble']) {
    if (budget <= 0) break;
    const p = tryPlace(k, Math.min(budget, Math.ceil(total * 0.04)));
    counts[k] += p; budget -= p;
  }
  return counts;
}
