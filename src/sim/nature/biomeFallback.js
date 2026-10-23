// Stand-in Whittaker classifier used only when src/gen/biomes.js is unavailable,
// so climate change still redraws the map. Mirrors the generator's broad rules:
// water by depth, ice / alpine / tundra / taiga toward the cold, and desert →
// grassland → forest → rainforest with rising rainfall.

import { BIOME, WATER } from '../../core/constants.js';
import { bumpVersion } from '../../core/world.js';

function classify(f, i, sea) {
  const w = f.water[i];
  if (w === WATER.OCEAN) return f.elevation[i] < sea - 0.08 ? BIOME.DEEP_OCEAN : BIOME.OCEAN;
  if (w === WATER.LAKE) return BIOME.LAKE;
  const t = f.annTemp[i], m = f.annRain[i], e = f.elevation[i];
  if (e > 0.88 && t < 6) return BIOME.ALPINE;
  if (t < -9) return BIOME.ICE;
  if (t < -2) return BIOME.TUNDRA;
  if (f.river[i] >= 2 && m > 0.55 && e < sea + 0.05 && t > 0) return BIOME.WETLAND;
  if (t < 5) return m > 0.3 ? BIOME.TAIGA : BIOME.COLD_DESERT;
  if (t < 18) return m < 0.14 ? BIOME.COLD_DESERT : m < 0.3 ? BIOME.STEPPE : m < 0.42 ? BIOME.SHRUBLAND : m < 0.72 ? BIOME.TEMPERATE_FOREST : BIOME.TEMPERATE_RAINFOREST;
  return m < 0.12 ? BIOME.HOT_DESERT : m < 0.32 ? BIOME.SAVANNA : m < 0.58 ? BIOME.TROPICAL_FOREST : BIOME.RAINFOREST;
}

export function fallbackClassify(world) {
  const { N, f } = world;
  const sea = world.climate.seaLevel;
  let changed = 0;
  for (let i = 0; i < N; i++) {
    const b = classify(f, i, sea);
    if (b !== f.biome[i]) { f.biome[i] = b; changed++; }
  }
  if (changed) bumpVersion(world, 'biome');
  return changed;
}
