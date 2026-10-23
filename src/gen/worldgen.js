// World generator. generateWorld(world, { preview, onStage }) fills every gen-owned field
// of a fresh world (see SPEC §4), world.climate sea levels, world.volcanoes and
// world.features. Synchronous and deterministic for a seed + params; all noise is
// sampled in normalised coordinates so a 128×80 preview resembles the full map.
//
// Pipeline:
//   1 plates        noise-warped Voronoi plates, continents, motions, boundary classes
//   2 relief        crust + tectonics + hotspots + volcanic cones + straits between
//                   continents → rank normalisation (exact ocean share, Earth-like hypsometry)
//   3 erosion       stream-power incision, deposition, hillslope diffusion, talus
//   4 water         ocean mask, lakes, drainage (hydrology.recomputeWater)
//   5 climate       winds, temperature, moisture advection → baseMoisture
//   6 rivers        hydrology again, now weighted by rainfall
//   7 biomes        classifyBiomes
//   8 soil          soil, minerals, resource deposits, starting vegetation
//   9 volcanoes     named vents on land
//  10 features      continents, oceans, seas, islands, ranges, lakes, rivers, deserts, forests

import { bumpVersion } from '../core/world.js';
import { WATER } from '../core/constants.js';
import { now } from '../core/util.js';
import { buildPlates } from './plates.js';
import { buildRelief, normalizeRelief, fixSeaFraction } from './elevation.js';
import { erodeTerrain, settleBasins } from './erosion.js';
import { recomputeWater } from './hydrology.js';
import { buildClimate } from './climate-base.js';
import { classifyBiomes } from './biomes.js';
import { buildSoilAndMinerals, seedVegetation, placeResources } from './geology.js';
import { raiseVolcanicIslands, placeVolcanoes } from './volcanoes.js';
import { nameFeatures } from './features.js';

export const GEN_VERSION = 1;

export function generateWorld(world, opts = {}) {
  const preview = Boolean(opts.preview);
  const onStage = typeof opts.onStage === 'function' ? opts.onStage : null;
  const timings = {};
  const stage = (label, key, fn) => {
    if (onStage) { try { onStage(label); } catch (e) { /* UI callback errors never stop generation */ } }
    const t = now();
    fn();
    timings[key] = now() - t;
  };
  const t0 = now();
  const ctx = { preview, usedNames: new Set([world.name]) };
  const c = world.climate;
  // Relief is normalised around 0.5; a genesis sea-level shift floods (or bares) it from the
  // start, so the first peoples never settle coasts the sea would take in the first year.
  const shift = Math.max(-0.12, Math.min(0.12, Number(world.params?.seaLevelOffset) || 0));
  c.baseSeaLevel = 0.5; c.seaLevel = 0.5 + shift; c.appliedSeaLevel = c.seaLevel;
  world.volcanoes = [];
  world.features = [];

  stage('Drifting the plates', 'plates', () => buildPlates(world, ctx));
  stage('Raising the continents', 'relief', () => { buildRelief(world, ctx); normalizeRelief(world, ctx); });
  stage('Weathering the land', 'erosion', () => {
    erodeTerrain(world, { preview });
    raiseVolcanicIslands(world, ctx);
    ctx.basins = settleBasins(world);
    fixSeaFraction(world, ctx.oceanK);
  });
  stage('Filling the seas', 'water', () => recomputeWater(world));
  stage('Stirring the winds', 'climate', () => buildClimate(world));
  stage('Carving the rivers', 'rivers', () => recomputeWater(world));
  stage('Painting the biomes', 'biomes', () => classifyBiomes(world, { initial: true }));
  stage('Seeding the earth', 'soil', () => {
    ctx.playaMask = playaMask(world);
    buildSoilAndMinerals(world, ctx);
    seedVegetation(world);
    ctx.resources = placeResources(world, ctx);
  });
  stage('Waking the volcanoes', 'volcanoes', () => placeVolcanoes(world, ctx));
  if (!preview) stage('Naming the world', 'features', () => nameFeatures(world, ctx));

  const pl = ctx.plates;
  world.sys.gen = {
    version: GEN_VERSION,
    preview,
    plates: Array.from({ length: pl.P }, (_, k) => ({
      id: k, continental: Boolean(pl.cont[k]), continent: pl.cont[k] ? pl.contId[k] : -1,
      vx: round3(pl.vx[k]), vy: round3(pl.vy[k]), spin: round3(pl.om[k]),
      x: round3(pl.cx[k] * world.H), y: round3(pl.cy[k] * world.H), area: round3(pl.area[k]),
    })),
    hotspots: (ctx.hotspots || []).map((h) => ({ x: round3(h.u * world.H), y: round3(h.v * world.H), plate: h.plate, continental: h.continental })),
    oceanFraction: round3(oceanFraction(world)),
  };
  for (const k of ['terrain', 'water', 'biome', 'features']) bumpVersion(world, k);
  timings.total = now() - t0;
  world.cache.genTimings = timings;
  return { timings, resources: ctx.resources || {}, basins: ctx.basins };
}

const round3 = (v) => Math.round(v * 1000) / 1000;

function oceanFraction(world) {
  let n = 0;
  for (let i = 0; i < world.N; i++) if (world.f.water[i] === WATER.OCEAN) n++;
  return n / world.N;
}

/** Dry salt-pan basins (endorheic floors without a lake) for salt deposits. */
function playaMask(world) {
  const { N, f } = world;
  const m = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (f.water[i] !== WATER.LAND || f.flowDir[i] >= 0) continue;
    const x = i % world.W, y = (i / world.W) | 0;
    if (x === 0 || y === 0 || x === world.W - 1 || y === world.H - 1) continue;   // map-edge outlets, not sinks
    m[i] = 1;
  }
  return m;
}
