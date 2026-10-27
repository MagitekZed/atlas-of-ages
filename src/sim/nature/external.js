// Guarded links to modules owned by the world generator. Either may be missing or
// broken while the project is assembled; the nature systems then degrade gracefully
// (no coastline recompute; a local biome classifier stands in).

import { fallbackClassify } from './biomeFallback.js';

let hydro = null;
try { hydro = await import('../../gen/hydrology.js'); } catch (e) { /* not available */ }
let biomes = null;
try { biomes = await import('../../gen/biomes.js'); } catch (e) { /* not available */ }

export const hasHydrology = () => Boolean(hydro && typeof hydro.recomputeWater === 'function');
export const hasBiomes = () => Boolean(biomes && typeof biomes.classifyBiomes === 'function');

/** Recompute the water mask from elevation and sea level. Returns true if it ran. */
export function recomputeWaterSafe(world) {
  if (!hasHydrology()) return false;
  try { hydro.recomputeWater(world, { keepSea: true }); return true; } catch (e) { console.error('[nature] recomputeWater failed', e); return false; }
}

/** Reclassify biomes; returns the number of changed tiles (gen's classifier, else the local fallback). */
export function classifyBiomesSafe(world) {
  if (hasBiomes()) {
    try { return biomes.classifyBiomes(world) | 0; } catch (e) { console.error('[nature] classifyBiomes failed', e); }
  }
  return fallbackClassify(world);
}
