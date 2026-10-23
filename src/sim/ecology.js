// Ecology (order 20): the living surface.
//   land stripes          vegetation (every 10 days per row): capacity from biome × soil
//                         water × temperature × soil × farmland, snow, devastation, pollution
//                         and ash; logistic growth (dormant in winter), dieback, grazing.
//                         Fauna (monthly): herbivores and predators (Rosenzweig–MacArthur)
//                         with migration toward pasture and hunting pressure from people.
//                         Slow (monthly): soil regeneration, erosion, desertification; decay
//                         of devastation, burn scars and ash
//   water stripe          fish stocks every 48 days (shelves, cold seas and lakes richest)
//   daily                 wildfire spread and spontaneous ignition (nature/fire.js)
//   yearly                regional fauna / soil bookkeeping → collapses, recoveries, extinctions
// Vegetation capacity is also bent by the ext 'vegCap' providers (enchanted woods, blight),
// sampled at the start of each season on a coarse 4×4-tile grid (the saved field ecoVegMul, all
// ones when no provider answers) so the per-tile kernels stay cheap.
// Exports ignite(world, i, intensity). God tools: bloom, forest, herds, predators, fish, wildfire
// (previews in nature/previews-life.js; effects sprout, spawn and fire, with src: 'tool').

import { WATER, BIOME, BIOMES, DAYS_PER_YEAR } from '../core/constants.js';
import { ensureField, isMonthStart, isYearStart, emitFx, monthOf } from '../core/world.js';
import { chronicle } from '../core/chronicle.js';
import { registerTool } from '../core/tools.js';
import { on } from '../core/hooks.js';
import { hash2, hashString } from '../core/rng.js';
import { mulOf, hasProviders } from '../core/ext.js';
import { fin, clampR, ss, rateOk, rateprune, pick, cap, forDisc, yearNum, profStart, profEnd, primeCache } from './nature/common.js';
import { tileRuns, regionDims, regionOf, REGION } from './nature/grid.js';
import { ignite as igniteTile, updateFires, spontaneous, fireList } from './nature/fire.js';
import { regionName, placePhrase } from './nature/places.js';
import { bloomPreview, forestPreview, herdsPreview, predatorsPreview, fishPreview, wildfirePreview } from './nature/previews-life.js';

const ID = 'ecology';
const K_VEG = 10;    // vegetation stripe: each land row every 10 days
const K_FAUNA = 30;  // fauna stripe (monthly per row)
const K_SLOW = 30;   // soil, scars, static capacity
const K_FISH = 48;   // fish stripe over water
const VC = 4;        // tiles per cell of the vegCap provider grid (ecoVegMul)

/** The coarse grid the ext 'vegCap' multiplier is kept on: { cw, ch } cells of VC × VC tiles. */
const vegGrid = (world) => ({ cw: Math.ceil(world.W / VC), ch: Math.ceil(world.H / VC) });

/** One land tile per cell (the centre, else the first land tile), keyed by the water version. */
function vegReps(world) {
  const key = world.versions.water;
  let c = world.cache.natVegRep;
  if (c && c.key === key && c.N === world.N) return c.reps;
  const { W, H, f } = world;
  const { cw, ch } = vegGrid(world);
  const reps = new Int32Array(cw * ch).fill(-1);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    const mx = Math.min(W - 1, cx * VC + (VC >> 1)), my = Math.min(H - 1, cy * VC + (VC >> 1));
    let best = f.water[my * W + mx] === WATER.LAND ? my * W + mx : -1;
    for (let y = cy * VC; best < 0 && y < Math.min(H, cy * VC + VC); y++) for (let x = cx * VC; x < Math.min(W, cx * VC + VC); x++) if (f.water[y * W + x] === WATER.LAND) { best = y * W + x; break; }
    reps[cy * cw + cx] = best;
  }
  world.cache.natVegRep = { key, N: world.N, reps };
  return reps;
}

/** Season start: ask the 'vegCap' providers once per cell (pure answers; all ones when none). */
function refreshVegMul(world) {
  const { cw, ch } = vegGrid(world);
  const vm = ensureField(world, 'ecoVegMul', Float32Array, cw * ch, 1);
  if (!hasProviders('vegCap')) { if (vm[0] !== 1 || vm[vm.length - 1] !== 1) vm.fill(1); return vm; }
  const reps = vegReps(world);
  for (let c = 0; c < vm.length; c++) {
    const i = reps[c];
    const m = i >= 0 ? mulOf('vegCap', world, i) : 1;
    vm[c] = Number.isFinite(m) ? m : 1;
  }
  return vm;
}

/** Start or strengthen a fire on land tile i (no-op on water or barren ground). */
export function ignite(world, i, intensity = 0.6, opts = {}) {
  // Fires only exist where the ecology system runs them (it spreads and ends them).
  if (!world?.sys?.[ID]?.seeded) return false;
  if (!world.f.fireId) ensureField(world, 'fireId', Int32Array, world.N);
  return igniteTile(world, i, intensity, opts);
}

export const system = { id: ID, order: 20, init, update };

// Per-biome constant tables (derived from the kernel table; never mutated).
const NB = BIOMES.length;
const VEGMAX = new Float32Array(NB), HERBCAP = new Float32Array(NB), FISHB = new Float32Array(NB), GROW = new Float32Array(NB), GRAZE = new Float32Array(NB);
for (const b of BIOMES) {
  VEGMAX[b.id] = b.vegMax; HERBCAP[b.id] = b.herbCap; FISHB[b.id] = b.fish;
  // Herbivores crop grass and browse; they barely dent the standing wood of a forest.
  GRAZE[b.id] = 0.07 * (1 - 0.7 * Math.min(1, b.wood));
  GROW[b.id] = b.id === BIOME.STEPPE || b.id === BIOME.SAVANNA || b.id === BIOME.SHRUBLAND ? 1.1
    : b.id === BIOME.WETLAND ? 0.8 : b.id === BIOME.TUNDRA || b.id === BIOME.ALPINE ? 0.35
      : b.id === BIOME.ICE ? 0.1 : b.id === BIOME.HOT_DESERT || b.id === BIOME.COLD_DESERT ? 0.5 : 0.45;
}

// Fauna (per year): Rosenzweig–MacArthur with predator crowding.
const RH = 0.9;      // herbivore intrinsic growth
const ATT = 4.0;     // predator attack rate
const HS = 0.15;     // half-saturation prey density
const CONV = 0.12;   // conversion efficiency (× predatorRatio)
const MP = 0.25;     // predator mortality
const CROWD = 2.5;   // predator self-limitation
const MIG = 4;       // migration relaxation rate per year


// ---------------------------------------------------------------------------
// Hooks

// Coastlines moved: clear life from drowned land, seed fish in new seas, give new shores soil.
on('waterChanged', (world) => {
  if (!world.f?.soilBase || !world.sys?.[ID]) return;
  world.cache.natCapStatic = null;
  world.sys[ID].capDirty = true;   // saved: a world saved before the rebuild still rebuilds
  const { N, f } = world;
  let prev = world.cache.natEcoWater;
  if (!prev || prev.length !== N) { world.cache.natEcoWater = Uint8Array.from(f.water); return; }
  for (let i = 0; i < N; i++) {
    const was = prev[i], now = f.water[i];
    if (was === now) continue;
    if (now !== WATER.LAND) {
      f.veg[i] = 0; f.vegCap[i] = 0; f.herb[i] = 0; f.pred[i] = 0; f.fire[i] = 0; f.burnScar[i] = 0;
      f.fish[i] = Math.max(f.fish[i], 0.25 * (FISHB[f.biome[i]] || 0.8));
      if (f.pasture) f.pasture[i] = 0;
    } else if (was !== WATER.LAND) {
      f.fish[i] = 0;
      f.veg[i] = Math.max(f.veg[i], 0.04);
      f.soil[i] = Math.max(f.soil[i], 0.35);
      f.soilBase[i] = Math.max(f.soilBase[i], 0.4);
      f.soilWater[i] = Math.max(f.soilWater[i], 0.5);
    }
  }
  prev.set(f.water);
});

// ---------------------------------------------------------------------------
// Init

function init(world) {
  primeCache(world);
  const { N, f } = world;
  ensureField(world, 'soilBase', Float32Array, N);
  ensureField(world, 'pasture', Float32Array, N);
  ensureField(world, 'fireId', Int32Array, N);
  ensureField(world, 'ash', Float32Array, N);
  { const { cw, ch } = vegGrid(world); ensureField(world, 'ecoVegMul', Float32Array, cw * ch, 1); }
  if (!world.sys[ID] || !world.sys[ID].seeded) seed(world);
  const sys = world.sys[ID];
  sys.counts ||= {};
  sys.fireEv ||= {};
  sys.nextEv ||= 1;
  sys.rl ||= {};
  world.cache.natEcoWater = Uint8Array.from(f.water);
  world.cache.natFire = null;
  // Static vegetation capacity is saved (ecoCapS) so a reloaded world continues exactly;
  // build it only for a new world or a save that lacks it.
  const hadCap = f.ecoCapS && f.ecoCapS.length === N && f.ecoCapS.some((v) => v > 0);
  ensureField(world, 'ecoCapS', Float32Array, N);
  world.cache.natCapStatic = hadCap && !sys.capDirty ? f.ecoCapS : null;
  fireList(world);
  // Hunting factors are refreshed monthly; a reload reuses the saved month's values.
  if (Array.isArray(sys.hunt)) huntCache(world, sys.hunt); else huntFactors(world);
}

function seed(world) {
  const { N, f } = world;
  const prior = world.sys[ID] || {};
  const sys = world.sys[ID] = { ...prior, seeded: true, counts: prior.counts || {}, fireEv: prior.fireEv || {}, nextEv: prior.nextEv || 1, rl: prior.rl || {} };
  // Genesis soil becomes the baseline it regenerates toward.
  for (let i = 0; i < N; i++) {
    const s = Math.min(1, Math.max(0, fin(f.soil[i], 0.4)));
    f.soil[i] = s;
    f.soilBase[i] = f.water[i] === WATER.LAND ? s : 0;
  }
  // Vegetation: start at capacity (unless the generator already painted it).
  let vegSum = 0, land = 0;
  for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND) { vegSum += f.veg[i]; land++; }
  const painted = land > 0 && vegSum / land > 0.02;
  const fa = clampR(fin(world.params.faunaAbundance, 1), 0, 2);
  const pr = clampR(fin(world.params.predatorRatio, 1), 0, 2);
  const hs = hashString(String(world.seed) + ':veg') & 0xffffff;
  for (let i = 0; i < N; i++) {
    if (f.water[i] !== WATER.LAND) {
      f.veg[i] = 0; f.vegCap[i] = 0; f.herb[i] = 0; f.pred[i] = 0;
      f.fish[i] = fishCap(world, i) * 0.9;
      continue;
    }
    f.fish[i] = 0;
    const capv = vegCapOf(world, i);
    f.vegCap[i] = capv;
    if (!painted) f.veg[i] = capv * (0.82 + 0.18 * hash2(i % world.W, (i / world.W) | 0, hs));
    const v = f.veg[i];
    const Kh = HERBCAP[f.biome[i]] * ss(0, 0.5, v) * fa * (1 - 0.8 * f.farm[i]);
    const eq = faunaEquilibrium(Kh, pr);
    f.herb[i] = eq.h;
    f.pred[i] = eq.p;
    f.pasture[i] = Kh;
  }
  // Fauna spin-up: eight seasons-free years of herd and hunter dynamics, so history begins
  // near the land's own balance rather than drifting toward it over the first decades.
  {
    const runs = tileRuns(world, 'land');
    const glacier = f.glacier || zeros(world);
    const hunt = huntFactors(world);
    for (let k = 0; k < 48; k++) {
      faunaKernel(runs.runs, runs.rowStart, 0, 1, world.W, world.H, 1 / 6, fa, pr, hunt,
        f.biome, f.veg, f.farm, f.snow, f.devastation, glacier, f.herb, f.pred, f.pasture, f.popDensity, f.owner);
    }
  }
  const g = { veg: 0, herb: 0, pred: 0, fish: 0, land: 0, water: 0 };
  for (let i = 0; i < N; i++) {
    if (f.water[i] === WATER.LAND) { g.veg += f.veg[i]; g.herb += f.herb[i]; g.pred += f.pred[i]; g.land++; }
    else { g.fish += f.fish[i]; g.water++; }
  }
  sys.genesis = { veg: g.veg / Math.max(1, g.land), herb: g.herb / Math.max(1, g.land), pred: g.pred / Math.max(1, g.land), fish: g.fish / Math.max(1, g.water) };
  sys.regions = null;
}

function faunaEquilibrium(Kh, pr) {
  if (Kh <= 0.001) return { h: 0, p: 0 };
  const e = CONV * pr;
  const denom = e * ATT - MP;
  if (denom <= 0) return { h: Kh * 0.9, p: 0 };
  let h = (HS * MP) / denom;
  if (h >= Kh) return { h: Kh * 0.9, p: 0 };
  h = Math.max(h, Kh * 0.35);
  const p = Math.max(0, (RH / ATT) * (1 - h / Kh) * (h + HS));
  return { h: Math.min(1, h), p: Math.min(1, p * 0.8) };
}

function vegCapOf(world, i) {
  const f = world.f;
  const b = f.biome[i];
  const moist = ss(0.05, 0.45, f.soilWater[i]);
  const at = f.annTemp[i];
  const tF = (0.3 + 0.7 * ss(-16, -2, at)) * (1 - 0.5 * ss(30, 42, at));
  const sF = 0.4 + 0.6 * ss(0.05, 0.55, f.soil[i]);
  const ash = f.ash ? f.ash[i] : 0;
  const ext = hasProviders('vegCap') ? mulOf('vegCap', world, i) : 1;
  return Math.min(1, Math.max(0, VEGMAX[b] * moist * tF * sF * (1 - 0.85 * f.farm[i]) * (1 - f.snow[i]) * (1 - 0.6 * f.devastation[i]) * (1 - 0.5 * f.pollution[i]) * (1 - 0.6 * ash) * ext));
}

function fishCap(world, i) {
  const f = world.f;
  const fa = clampR(fin(world.params.fishAbundance, 1), 0, 2);
  const cold = 0.75 + 0.5 * (1 - ss(4, 26, f.annTemp[i]));
  return Math.min(1, FISHB[f.biome[i]] * fa * cold * upwelling(world)[i] * (1 - 0.6 * f.snow[i]) * (1 - 0.5 * f.pollution[i]));
}

/** Hunting pressure multiplier per civ: foragers hunt hardest; farmers and industrial peoples less. */
function huntFactors(world) {
  const vals = world.civs.map((c) => {
    if (!c || !c.alive) return 1;
    const farming = c.mods && fin(c.mods.farming, 0) > 0;
    const era = fin(c.tech?.era, 0);
    return era >= 6 ? 0.25 : farming ? 0.5 : 1;
  });
  if (world.sys[ID]) world.sys[ID].hunt = vals;
  return huntCache(world, vals);
}
/** Typed copy of the per-civ hunting factors; civs founded since the last refresh hunt as foragers (1). */
function huntCache(world, vals) {
  const h = world.cache.natHunt = new Float32Array(Math.max(16, vals.length * 2)).fill(1);
  for (let k = 0; k < vals.length; k++) h[k] = fin(vals[k], 1);
  return h;
}

// ---------------------------------------------------------------------------
// Update

function update(world) {
  const day = world.time.day;
  if (isMonthStart(world)) {
    huntFactors(world);
    // vegetation answers slowly: the providers are asked once a season (2–3k cells), not monthly
    if (monthOf(world) % 3 === 0) refreshVegMul(world);
  }
  let t = profStart(world);
  vegStripe(world, day % K_VEG);
  profEnd(world, 'eco.veg', t); t = profStart(world);
  faunaStripe(world, (day + 5) % K_FAUNA);
  profEnd(world, 'eco.fauna', t); t = profStart(world);
  slowStripe(world, (day + 11) % K_SLOW);
  profEnd(world, 'eco.slow', t); t = profStart(world);
  waterStripe(world, (day + 3) % K_FISH);
  profEnd(world, 'eco.fish', t); t = profStart(world);
  spontaneous(world);
  updateFires(world);
  profEnd(world, 'eco.fire', t); t = profStart(world);
  if (isYearStart(world) && day > 0) yearly(world);
  profEnd(world, 'eco.yearly', t);
}

/**
 * The slowly changing part of vegetation capacity — biome × temperature normal × soil ×
 * pollution — cached per tile and refreshed by the slow stripe (inputs change over years).
 */
function capStatic(world) {
  let c = world.cache.natCapStatic;
  if (c && c.length === world.N) return c;
  c = world.cache.natCapStatic = ensureField(world, 'ecoCapS', Float32Array, world.N);
  if (world.sys[ID]) world.sys[ID].capDirty = false;
  c.fill(0);
  const runs = tileRuns(world, 'land');
  const f = world.f, annT = f.annTemp, soil = f.soil, biome = f.biome, poll = f.pollution;
  for (let q = 0; q < runs.runs.length; q += 2) for (let i = runs.runs[q]; i < runs.runs[q + 1]; i++) c[i] = capStaticAt(annT[i], soil[i], biome[i], poll[i]);
  return c;
}
/** Biome × temperature normal × soil × pollution (the slowly changing part of vegCap). */
function capStaticAt(at, sl, b, pol) {
  const tc = Math.min(1, Math.max(0, (at + 16) * 0.0714));
  const th = Math.min(1, Math.max(0, (at - 30) * 0.0833));
  const tF = (0.3 + 0.7 * tc * tc * (3 - 2 * tc)) * (1 - 0.5 * th * th * (3 - 2 * th));
  const sc = Math.min(1, Math.max(0, (sl - 0.05) * 2));
  const sF = 0.4 + 0.6 * sc * sc * (3 - 2 * sc);
  return VEGMAX[b] * tF * sF * (1 - 0.5 * pol);
}

// Each stripe is a thin wrapper that gathers live params and field arrays, and a kernel
// that takes only typed arrays and numbers. Kernels therefore keep stable type feedback
// (no world/cache objects whose shapes change as other systems add caches), so V8 keeps
// them optimised.

/** A zero array standing in for an optional field (e.g. glacier without climate). */
function zeros(world) {
  let z = world.cache.natEcoZero;
  if (!z || z.length !== world.N) z = world.cache.natEcoZero = new Float32Array(world.N);
  return z;
}

/** Vegetation stripe: capacity (× moisture, land use, snow, damage), growth / dieback, grazing. */
function vegStripe(world, phase) {
  const { W, H, f, params } = world;
  const runs = tileRuns(world, 'land');
  const vg = clampR(fin(params.vegetationGrowth, 1), 0, 5);
  let vm = f.ecoVegMul;
  const { cw, ch } = vegGrid(world);
  if (!vm || vm.length !== cw * ch) vm = refreshVegMul(world);
  vegKernel(runs.runs, runs.rowStart, phase, K_VEG, W, H, K_VEG / DAYS_PER_YEAR, vg, capStatic(world),
    f.biome, f.soilWater, f.temp, f.veg, f.vegCap, f.farm, f.snow, f.devastation, f.ash, f.herb, vm, cw);
}

function vegKernel(R, rs, phase, K, W, H, dt, vg, cs, biome, sw, temp, veg, vegCap, farm, snow, dev, ash, herb, vm, cw) {
  for (let y = phase; y < H; y += K) {
    const row = y * W, crow = (y >> 2) * cw;
    for (let q = rs[y]; q < rs[y + 1]; q++) {
      const b = R[2 * q + 1];
      for (let i = R[2 * q]; i < b; i++) {
        const bi = biome[i];
        const sn = snow[i];
        const m = Math.min(1, Math.max(0, (sw[i] - 0.05) * 2.5));
        const capv = Math.min(1, cs[i] * m * m * (3 - 2 * m) * (1 - 0.85 * farm[i]) * (1 - sn) * (1 - 0.6 * dev[i]) * (1 - 0.6 * ash[i]) * vm[crow + ((i - row) >> 2)]);
        vegCap[i] = capv;
        // growth in the growing season (dormant under snow and frost); dieback above capacity
        const g = Math.min(1, Math.max(0, (temp[i] - 1) * 0.0909));
        const G = g * g * (3 - 2 * g) * (1 - sn);
        const v = veg[i];
        const grow = GROW[bi] * vg * G * (v + 0.15) * Math.max(0, capv - v);
        const die = 0.35 * Math.max(0, v - capv) * (0.05 + 0.95 * G);
        veg[i] = Math.min(1, Math.max(0, v + dt * (grow - die - GRAZE[bi] * herb[i] * Math.min(1, v * 3))));
      }
    }
  }
}

/** Fauna stripe: herbivores and predators, migration toward pasture / prey, hunting. */
function faunaStripe(world, phase) {
  const { W, H, f, params } = world;
  const runs = tileRuns(world, 'land');
  const fa = clampR(fin(params.faunaAbundance, 1), 0, 2);
  const pr = clampR(fin(params.predatorRatio, 1), 0, 2);
  const hunt = world.cache.natHunt || huntFactors(world);
  faunaKernel(runs.runs, runs.rowStart, phase, K_FAUNA, W, H, K_FAUNA / DAYS_PER_YEAR, fa, pr, hunt,
    f.biome, f.veg, f.farm, f.snow, f.devastation, f.glacier || zeros(world), f.herb, f.pred, f.pasture, f.popDensity, f.owner);
}

function faunaKernel(R, rs, phase, K, W, H, dt, fa, pr, hunt, biome, veg, farm, snow, dev, glacier, herb, pred, pasture, popD, owner) {
  const mig = Math.min(0.5, MIG * dt);
  const conv = CONV * pr;
  const huntN = hunt.length;
  for (let y = phase; y < H; y += K) {
    const up = y > 0 ? -W : 0, dn = y < H - 1 ? W : 0;
    for (let q = rs[y]; q < rs[y + 1]; q++) {
      const a = R[2 * q], b = R[2 * q + 1];
      for (let i = a; i < b; i++) {
        const vv = Math.min(1, veg[i] * 2);
        const Kh = HERBCAP[biome[i]] * vv * vv * (3 - 2 * vv) * fa * (1 - 0.8 * farm[i]) * (1 - 0.5 * dev[i]) * (1 - 0.9 * glacier[i]);
        const past = Kh * (1 - 0.75 * snow[i]);
        pasture[i] = past;
        const h = herb[i], p = pred[i];
        const pd = popD[i];
        const own = owner[i];
        const hf = own >= 0 && own < huntN ? hunt[own] : 1;
        const hunting = 0.55 * (pd / (pd + 150)) * hf;
        const fr = ATT * h / (h + HS);
        let nh = h + dt * (RH * h * (1 - h / (Kh + 0.002)) - fr * p - hunting * h);
        let np = p + dt * p * (conv * fr - MP - CROWD * p - 0.5 * hunting);
        // migration toward pasture (herds) and toward prey (predators)
        const il = i > a ? i - 1 : i, ir = i + 1 < b ? i + 1 : i;
        const iu = i + up, id = i + dn;
        const tot = nh + herb[il] + herb[ir] + herb[iu] + herb[id];
        const pn = pasture[il] + pasture[ir] + pasture[iu] + pasture[id];
        nh += mig * (tot * (past + 1e-4) / (past + pn + 5e-4) - nh);
        const ptot = np + pred[il] + pred[ir] + pred[iu] + pred[id];
        np += mig * (ptot * (nh + 0.005) / (tot + 0.025) - np);
        // refugia: a trickle of animals always wanders back into suitable country
        if (Kh > 0.05) { nh = Math.max(nh, 0.004 * Kh); if (pr > 0 && nh > 0.03) np = Math.max(np, 0.0006 * pr); }
        herb[i] = Math.min(1, Math.max(0, nh));
        pred[i] = Math.min(1, Math.max(0, np));
      }
    }
  }
}

/**
 * Slow stripe: soil regenerates toward its genesis baseline under natural cover, bare or
 * overgrazed ground erodes and arid land degrades toward desert; devastation, burn scars
 * and ash fade; the cached static capacity is refreshed.
 */
function slowStripe(world, phase) {
  const { H, f, params } = world;
  const runs = tileRuns(world, 'land');
  const fert = clampR(fin(params.soilFertility, 1) / Math.max(0.1, fin(world.genesisParams?.soilFertility, 1)), 0.2, 6);
  slowKernel(runs.runs, runs.rowStart, phase, K_SLOW, H, K_SLOW / DAYS_PER_YEAR, fert, capStatic(world),
    f.biome, f.annRain, f.annTemp, f.soil, f.soilBase, f.veg, f.vegCap, f.farm, f.devastation, f.ash, f.burnScar, f.herb, f.pasture, f.elevation, f.pollution);
}

function slowKernel(R, rs, phase, K, H, dt, fert, cs, biome, annR, annT, soil, soilBase, veg, vegCap, farm, dev, ash, scar, herb, pasture, elev, poll) {
  for (let y = phase; y < H; y += K) {
    for (let q = rs[y]; q < rs[y + 1]; q++) {
      const b = R[2 * q + 1];
      for (let i = R[2 * q]; i < b; i++) {
        const v = veg[i], fm = farm[i], as = ash[i];
        // Soil: regenerates toward its baseline under natural cover; bare or overgrazed
        // ground erodes in the rain, and arid land overused by herds turns toward desert.
        const natural = 0.6 * vegCap[i] / (1 - 0.85 * fm + 1e-3);
        const deficit = Math.max(0, natural - v) / (natural + 0.03);
        const sl = soil[i];
        const tgt = Math.min(1, soilBase[i] * fert * (1 - 0.45 * deficit) + 0.15 * as);
        const ar = annR[i];
        const erosion = 0.05 * deficit * Math.min(1, ar * 2.5) * (1 + 3 * Math.max(0, elev[i] - 0.6)) * (1 - fm * 0.5);
        const at = Math.min(1, Math.max(0, (ar - 0.15) * 5));
        const arid = 1 - at * at * (3 - 2 * at);
        const desert = arid * (0.12 * Math.max(0, herb[i] - pasture[i] - 0.02) + 0.03 * deficit * (1 - fm));
        const ns = Math.min(1, Math.max(0, sl + dt * (0.04 * (tgt - sl) - erosion - desert)));
        soil[i] = ns;
        const dv = dev[i];
        dev[i] = Math.max(0, dv - dt * (0.04 + 0.22 * dv));
        scar[i] = Math.max(0, scar[i] - dt * (0.12 + 0.6 * v));
        ash[i] = Math.max(0, as - dt * (0.02 + 0.15 * as));
        cs[i] = capStaticAt(annT[i], ns, biome[i], poll[i]);
      }
    }
  }
}

/** Fish stripe over water: logistic regrowth toward a capacity set by depth, cold and lakes. */
function waterStripe(world, phase) {
  const { H, f } = world;
  const runs = tileRuns(world, 'water');
  const fa = clampR(fin(world.params.fishAbundance, 1), 0, 2);
  fishKernel(runs.runs, runs.rowStart, phase, K_FISH, H, K_FISH / DAYS_PER_YEAR, fa, upwelling(world), f.biome, f.annTemp, f.snow, f.pollution, f.fish);
  waterScarKernel(runs.runs, runs.rowStart, phase, K_FISH, H, f.devastation, f.burnScar);
}

/**
 * Scars on water (lava hissing into the sea, storm wrack, naval battles) wash away within a
 * few months; the land kernels never visit water tiles, so without this they would stay.
 */
function waterScarKernel(R, rs, phase, K, H, dev, scar) {
  const k = Math.exp(-K / 60);
  for (let y = phase; y < H; y += K) {
    for (let q = rs[y]; q < rs[y + 1]; q++) {
      const a = R[2 * q], b = R[2 * q + 1];
      for (let i = a; i < b; i++) {
        if (dev[i] > 0) dev[i] = dev[i] > 0.002 ? dev[i] * k : 0;
        if (scar[i] > 0) scar[i] = scar[i] > 0.002 ? scar[i] * k : 0;
      }
    }
  }
}

/**
 * Upwelling bonus per water tile (cache): subtropical seas with a coast close to the east
 * (eastern boundary currents, where trade winds drive cold, rich water up the shore),
 * plus a smaller bonus on any coast.
 */
function upwelling(world) {
  const v = world.versions.water;
  let c = world.cache.natUpwell;
  if (c && c.v === v && c.a.length === world.N) return c.a;
  const { W, H, f } = world;
  const water = f.water, a = new Float32Array(world.N).fill(1);
  for (let y = 0; y < H; y++) {
    const al = Math.abs(1 - (2 * (y + 0.5)) / H);
    const sub = al > 0.12 && al < 0.5 ? 1 : 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (water[i] === WATER.LAND) continue;
      let east = 0, near = 0;
      for (let d = 1; d <= 3 && x + d < W; d++) if (water[i + d] === WATER.LAND) { east = 1; break; }
      for (let d = 1; d <= 2 && !near; d++) {
        if ((x - d >= 0 && water[i - d] === WATER.LAND) || (y - d >= 0 && water[i - d * W] === WATER.LAND) || (y + d < H && water[i + d * W] === WATER.LAND)) near = 1;
      }
      a[i] = 1 + 0.5 * east * sub + 0.15 * (near || east);
    }
  }
  world.cache.natUpwell = { v, a };
  return a;
}

function fishKernel(R, rs, phase, K, H, dt, fa, upw, biome, annT, snow, poll, fish) {
  for (let y = phase; y < H; y += K) {
    for (let q = rs[y]; q < rs[y + 1]; q++) {
      const a = R[2 * q], b = R[2 * q + 1];
      for (let i = a; i < b; i++) {
        const tc = Math.min(1, Math.max(0, (annT[i] - 4) * (1 / 22)));
        const cold = 0.75 + 0.5 * (1 - tc * tc * (3 - 2 * tc));
        const Kf = Math.min(1, FISHB[biome[i]] * fa * cold * upw[i] * (1 - 0.6 * snow[i]) * (1 - 0.5 * poll[i]));
        const v = fish[i];
        const d = v < Kf ? 0.7 * v * (1 - v / (Kf + 1e-3)) + 0.02 * Kf : -0.5 * (v - Kf);
        fish[i] = Math.min(1, Math.max(0, v + dt * d));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Yearly: regional bookkeeping and chronicle

/** The land tile nearest (x, y) within a few tiles (else (x, y) itself). */
function landNear(world, x, y) {
  const { W, H, f } = world;
  let best = null, bd = 1e9;
  for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H || f.water[yy * W + xx] !== WATER.LAND) continue;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = { x: xx, y: yy }; }
  }
  return best || { x: Math.max(0, Math.min(W - 1, x)), y: Math.max(0, Math.min(H - 1, y)) };
}

/** Region id of every tile (cache). */
function regionIndex(world) {
  let c = world.cache.natRegionIdx;
  if (c && c.length === world.N) return c;
  c = world.cache.natRegionIdx = new Int32Array(world.N);
  const { W, H } = world;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) c[y * W + x] = regionOf(world, x, y);
  return c;
}

const HERB_WORDS = {
  [BIOME.STEPPE]: ['the wild horse herds', 'the great bison herds', 'the steppe antelope'],
  [BIOME.SAVANNA]: ['the antelope herds', 'the great herds of the grasslands', 'the zebra and buffalo'],
  [BIOME.TUNDRA]: ['the reindeer herds', 'the caribou'],
  [BIOME.TAIGA]: ['the elk', 'the moose and red deer'],
  [BIOME.TEMPERATE_FOREST]: ['the deer', 'the wild boar and red deer'],
  [BIOME.TEMPERATE_RAINFOREST]: ['the elk', 'the forest deer'],
  [BIOME.TROPICAL_FOREST]: ['the forest antelope', 'the tapirs and deer'],
  [BIOME.RAINFOREST]: ['the forest antelope', 'the tapirs'],
  [BIOME.SHRUBLAND]: ['the wild goats', 'the gazelles'],
  [BIOME.HOT_DESERT]: ['the gazelles', 'the wild camels'],
  [BIOME.COLD_DESERT]: ['the wild asses', 'the saiga'],
  [BIOME.WETLAND]: ['the marsh deer', 'the water buffalo'],
  [BIOME.ALPINE]: ['the ibex', 'the mountain goats'],
  [BIOME.ICE]: ['the musk oxen'],
};
const PRED_WORDS = {
  [BIOME.STEPPE]: ['the steppe wolves'], [BIOME.SAVANNA]: ['the lions', 'the great cats'], [BIOME.TUNDRA]: ['the white wolves'],
  [BIOME.TAIGA]: ['the wolves and bears'], [BIOME.TEMPERATE_FOREST]: ['the wolves', 'the bears and lynx'], [BIOME.TEMPERATE_RAINFOREST]: ['the bears'],
  [BIOME.TROPICAL_FOREST]: ['the leopards'], [BIOME.RAINFOREST]: ['the jaguars', 'the great cats'], [BIOME.SHRUBLAND]: ['the jackals and wolves'],
  [BIOME.HOT_DESERT]: ['the jackals'], [BIOME.COLD_DESERT]: ['the snow leopards'], [BIOME.WETLAND]: ['the crocodiles'], [BIOME.ALPINE]: ['the snow leopards'], [BIOME.ICE]: ['the white bears'],
};

function yearly(world) {
  const { N, W, f } = world;
  const sys = world.sys[ID];
  const day = world.time.day;
  const { rn } = regionDims(world);
  const H = new Float64Array(rn), P = new Float64Array(rn), V = new Float64Array(rn), PD = new Float64Array(rn), L = new Float64Array(rn), SO = new Float64Array(rn), SB = new Float64Array(rn), AR = new Float64Array(rn);
  const SX = new Float64Array(rn), SY = new Float64Array(rn);
  const NBI = BIOMES.length;
  const bc = new Int32Array(rn * NBI);
  const ownC = new Map();
  let gH = 0, gP = 0, gV = 0, gL = 0;
  const water = f.water, herb = f.herb, pred = f.pred, veg = f.veg, popD = f.popDensity, soil = f.soil, soilBase = f.soilBase, annR = f.annRain, biome = f.biome, owner = f.owner;
  const rIdx = regionIndex(world);
  for (let i = 0; i < N; i++) {
    if (water[i] !== WATER.LAND) continue;
    const r = rIdx[i];
    const h = herb[i], p = pred[i], v = veg[i];
    H[r] += h; P[r] += p; V[r] += v; PD[r] += popD[i]; L[r]++;
    SX[r] += i % W; SY[r] += (i / W) | 0;
    SO[r] += soil[i]; SB[r] += soilBase[i]; AR[r] += annR[i];
    bc[r * NBI + biome[i]]++;
    const o = owner[i];
    if (o >= 0) { const k = r * 4096 + o; ownC.set(k, (ownC.get(k) || 0) + 1); }
    gH += h; gP += p; gV += v; gL++;
  }
  sys.global = { herb: gH / Math.max(1, gL), pred: gP / Math.max(1, gL), veg: gV / Math.max(1, gL) };
  let reg = sys.regions;
  if (!reg || !Array.isArray(reg.h) || reg.h.length !== rn) {
    reg = sys.regions = { h: Array.from(H), p: Array.from(P), low: new Array(rn).fill(0), plow: new Array(rn).fill(0), soilLow: new Array(rn).fill(0) };
  }
  const domBiome = (r) => { let best = BIOME.STEPPE, bn = -1; for (let b = 3; b < BIOMES.length; b++) { const n = bc[r * BIOMES.length + b]; if (n > bn) { bn = n; best = b; } } return best; };
  const domOwner = (r) => { let best = -1, bn = 0; for (const [k, n] of ownC) if (((k / 4096) | 0) === r && n > bn) { bn = n; best = k % 4096; } return best; };
  for (let r = 0; r < rn; r++) {
    if (L[r] < REGION * REGION * 0.15) continue;
    const hm = reg.h[r], pm = reg.p[r];
    // Name the region by its land: the land tile nearest its land centroid.
    const c = landNear(world, Math.round(SX[r] / L[r]), Math.round(SY[r] / L[r]));
    const b = domBiome(r);
    // Herds
    if (!reg.low[r] && hm > L[r] * 0.03 && H[r] < hm * 0.3) {
      reg.low[r] = hm;
      if (rateOk(sys, `herdLow:${r}`, day, 40)) {
        const hunted = PD[r] / L[r] > 40;
        const o = domOwner(r);
        const civ = o >= 0 ? world.civs[o] : null;
        const who = hunted && civ ? ` by ${civ.adjective} hunters` : hunted ? ' by hunters' : '';
        const why = hunted ? `, hunted out${who}` : world.climate.droughtIndex > 0.25 ? ' in the long dry years' : ' as the pastures failed';
        const beasts = pick(world, HERB_WORDS[b] || ['the herds']);
        chronicle(world, { cat: 'nature', imp: 2, x: c.x, y: c.y, key: 'nature.herds.collapse', text: pick(world, [
          `${cap(beasts)} of ${regionName(world, c.x, c.y)} dwindled to a remnant${why}.`,
          `Where ${beasts} had once darkened the plains of ${regionName(world, c.x, c.y)}, only scattered bands remained${why}.`,
        ]) });
      }
    } else if (reg.low[r] && H[r] > reg.low[r] * 0.75) {
      if (rateOk(sys, `herdUp:${r}`, day, 40)) {
        const beasts = pick(world, HERB_WORDS[b] || ['the herds']);
        chronicle(world, { cat: 'nature', imp: 1, x: c.x, y: c.y, key: 'nature.herds.return', text: `${cap(beasts)} returned in numbers to ${regionName(world, c.x, c.y)}.` });
      }
      reg.low[r] = 0;
    }
    // Predators
    if (!reg.plow[r] && pm > L[r] * 0.004 && P[r] < pm * 0.08) {
      reg.plow[r] = pm;
      if (rateOk(sys, `predLow:${r}`, day, 50)) {
        const hunted = PD[r] / L[r] > 40;
        const beasts = pick(world, PRED_WORDS[b] || ['the wolves']);
        chronicle(world, { cat: 'nature', imp: 2, x: c.x, y: c.y, key: 'nature.predators.gone', text: `${cap(beasts)} vanished from ${regionName(world, c.x, c.y)}${hunted ? ', trapped and speared until none were left' : ', starved by the dwindling herds'}.` });
      }
    } else if (reg.plow[r] && P[r] > reg.plow[r] * 0.5) {
      if (rateOk(sys, `predUp:${r}`, day, 50)) {
        const beasts = pick(world, PRED_WORDS[b] || ['the wolves']);
        chronicle(world, { cat: 'nature', imp: 1, x: c.x, y: c.y, key: 'nature.predators.return', text: `${cap(beasts)} prowled ${regionName(world, c.x, c.y)} once more.` });
      }
      reg.plow[r] = 0;
    }
    // Desertification of arid, overused land
    const arid = AR[r] / L[r] < 0.3;
    if (arid && SB[r] > 0 && !reg.soilLow[r] && SO[r] < SB[r] * 0.6 && rateOk(sys, `dust:${r}`, day, 50)) {
      reg.soilLow[r] = 1;
      const o = domOwner(r);
      const civ = o >= 0 ? world.civs[o] : null;
      chronicle(world, { cat: 'nature', imp: 2, x: c.x, y: c.y, key: 'nature.desert', ...(civ ? { civId: civ.id } : {}), text: civ
        ? `Overgrazed and stripped of trees, the ${civ.adjective} lands of ${regionName(world, c.x, c.y)} turned to dust and blowing sand.`
        : `The thin soils of ${regionName(world, c.x, c.y)} blew away on the wind, and the land turned toward desert.` });
    } else if (reg.soilLow[r] && SO[r] > SB[r] * 0.8) reg.soilLow[r] = 0;
    // Slow running means (≈ 15-year memory)
    reg.h[r] = hm + (H[r] - hm) * 0.07;
    reg.p[r] = pm + (P[r] - pm) * 0.07;
  }
  // World-wide die-off.
  const g = sys.genesis;
  if (g && g.herb > 0 && sys.global.herb < g.herb * 0.25 && rateOk(sys, 'globalHerb', day, 120)) {
    chronicle(world, { cat: 'nature', imp: 4, key: 'nature.herds.world', text: `By Year ${yearNum(world)} the great herds of the world had dwindled to a quarter of their ancient number.` });
  }
  const fy = sys.fireYear;
  if (fy) { sys.lastFireYear = { ...fy }; sys.fireYear = { year: yearNum(world), ignitions: 0, tiles: 0, biggest: 0, events: 0 }; }
  rateprune(sys, day, 300);
}

// ---------------------------------------------------------------------------
// God tools (group 'life')

function stroke(world, id) {
  const sys = world.sys[ID];
  if (!sys) return false;
  const day = world.time.day;
  const s = sys.stroke;
  if (s && s.tool === id && day - s.day < 30) { s.day = day; return false; }
  sys.stroke = { tool: id, day };
  return true;
}
const endStroke = (world) => { if (world.sys[ID]) world.sys[ID].stroke = null; };

/** Once per stroke: the tool's effect (fx = { type, glyph? }) and a Divine Hand line. */
function divine(world, id, x, y, R, text, fx) {
  if (!stroke(world, id)) return;
  emitFx(world, { type: fx.type, x, y, r: R, ...(fx.glyph ? { glyph: fx.glyph } : {}), src: 'tool' });
  if (text) chronicle(world, { cat: 'divine', imp: 1, x, y, text, key: `divine.${id}` });
}

const notReady = { ok: false, message: 'Life has not yet taken hold.' };

registerTool({
  id: 'bloom', label: 'Bloom', group: 'life', icon: 'bloom', order: 10, polarity: 'boon',
  desc: 'Quicken the land: lush growth and richer soil.',
  target: 'area', radius: 6, minRadius: 1, maxRadius: 30, continuous: true,
  strength: { label: 'Vigour', min: 0.1, max: 1, default: 0.5 },
  preview: bloomPreview,
  apply(world, x, y, { radius, strength }) {
    if (!world.sys[ID]) return notReady;
    const f = world.f, s = clampR(fin(strength, 0.5), 0, 1);
    let n = 0;
    forDisc(world, x, y, Math.max(0.5, fin(radius, 6)), (i, tx, ty, d) => {
      if (f.water[i] !== WATER.LAND) return;
      const g = (1 - d * d) * s;
      f.soil[i] = Math.min(1, f.soil[i] + 0.06 * g);
      f.soilWater[i] = Math.min(1, f.soilWater[i] + 0.06 * g);
      f.veg[i] = Math.min(1, f.veg[i] + 0.15 * g * (0.4 + VEGMAX[f.biome[i]]));
      f.burnScar[i] *= 1 - 0.5 * g;
      f.devastation[i] *= 1 - 0.3 * g;
      if (f.fire[i] > 0 && g > 0.2) f.fire[i] = 0;
      n++;
    });
    if (!n) return { ok: false, message: 'Nothing grows on open water.' };
    divine(world, 'bloom', x, y, radius, `The land ${placePhrase(world, x, y).text} burst into sudden, impossible bloom.`, { type: 'sprout' });
    return { ok: true, message: 'The land blooms.' };
  },
  finish(world) { endStroke(world); },
});

registerTool({
  id: 'forest', label: 'Plant Forest', group: 'life', icon: 'forest', order: 20, polarity: 'boon',
  desc: 'Raise woodland. Forests hold the soil, cool the land and breathe moisture into the air downwind.',
  target: 'area', radius: 5, minRadius: 1, maxRadius: 25, continuous: true,
  strength: { label: 'Density', min: 0.1, max: 1, default: 0.6 },
  preview: forestPreview,
  apply(world, x, y, { radius, strength }) {
    if (!world.sys[ID]) return notReady;
    const f = world.f, s = clampR(fin(strength, 0.6), 0, 1);
    let n = 0;
    forDisc(world, x, y, Math.max(0.5, fin(radius, 5)), (i, tx, ty, d) => {
      if (f.water[i] !== WATER.LAND || f.biome[i] === BIOME.ICE) return;
      const g = (1 - d * d) * s;
      const target = Math.max(0.55, VEGMAX[f.biome[i]]) * (1 - 0.85 * f.farm[i]);
      f.veg[i] = Math.min(1, Math.max(f.veg[i], f.veg[i] + (target - f.veg[i]) * 0.35 * g));
      f.soilWater[i] = Math.min(1, f.soilWater[i] + 0.04 * g);
      f.soil[i] = Math.min(1, f.soil[i] + 0.02 * g);
      f.soilBase[i] = Math.min(1, f.soilBase[i] + 0.01 * g);
      if (f.fire[i] > 0) f.fire[i] = 0;
      n++;
    });
    if (!n) return { ok: false, message: 'Trees will not take root here.' };
    divine(world, 'forest', x, y, radius, `A forest rose overnight ${placePhrase(world, x, y).text}, as if the trees had been waiting beneath the soil.`, { type: 'sprout' });
    return { ok: true, message: 'Trees take root.' };
  },
  finish(world) { endStroke(world); },
});

registerTool({
  id: 'herds', label: 'Herds', group: 'life', icon: 'herds', order: 30, polarity: 'boon',
  desc: 'Release grazing herds onto the land.',
  target: 'area', radius: 6, minRadius: 1, maxRadius: 30, continuous: true,
  strength: { label: 'Numbers', min: 0.1, max: 1, default: 0.5 },
  preview: herdsPreview,
  apply(world, x, y, { radius, strength }) {
    if (!world.sys[ID]) return notReady;
    const f = world.f, s = clampR(fin(strength, 0.5), 0, 1);
    let n = 0;
    forDisc(world, x, y, Math.max(0.5, fin(radius, 6)), (i, tx, ty, d) => {
      if (f.water[i] !== WATER.LAND) return;
      f.herb[i] = Math.min(1, f.herb[i] + 0.3 * (1 - d * d) * s);
      n++;
    });
    if (!n) return { ok: false, message: 'The herds would drown.' };
    const b = f.biome[y * world.W + x];
    divine(world, 'herds', x, y, radius, `${cap(pick(world, HERB_WORDS[b] || ['herds of wild beasts']))} poured out of nowhere ${placePhrase(world, x, y).text}.`, { type: 'spawn', glyph: 'herd' });
    return { ok: true, message: 'Herds spread across the land.' };
  },
  finish(world) { endStroke(world); },
});

registerTool({
  id: 'predators', label: 'Predators', group: 'life', icon: 'predators', order: 40, polarity: 'neutral',
  desc: 'Loose wolves, great cats and other hunters to thin the herds.',
  target: 'area', radius: 6, minRadius: 1, maxRadius: 30, continuous: true,
  strength: { label: 'Pack size', min: 0.1, max: 1, default: 0.5 },
  preview: predatorsPreview,
  apply(world, x, y, { radius, strength }) {
    if (!world.sys[ID]) return notReady;
    const f = world.f, s = clampR(fin(strength, 0.5), 0, 1);
    let n = 0;
    forDisc(world, x, y, Math.max(0.5, fin(radius, 6)), (i, tx, ty, d) => {
      if (f.water[i] !== WATER.LAND) return;
      f.pred[i] = Math.min(1, f.pred[i] + 0.08 * (1 - d * d) * s);
      n++;
    });
    if (!n) return { ok: false, message: 'There is nothing to hunt at sea.' };
    const b = f.biome[y * world.W + x];
    divine(world, 'predators', x, y, radius, `${cap(pick(world, PRED_WORDS[b] || ['the wolves']))} came howling out of the wilds ${placePhrase(world, x, y).text}.`, { type: 'spawn', glyph: 'pred' });
    return { ok: true, message: 'Predators stalk the land.' };
  },
  finish(world) { endStroke(world); },
});

registerTool({
  id: 'fish', label: 'Fish Shoals', group: 'life', icon: 'fish', order: 50, polarity: 'boon',
  desc: 'Fill seas and lakes with fish.',
  target: 'area', radius: 8, minRadius: 1, maxRadius: 40, continuous: true,
  strength: { label: 'Abundance', min: 0.1, max: 1, default: 0.6 },
  preview: fishPreview,
  apply(world, x, y, { radius, strength }) {
    if (!world.sys[ID]) return notReady;
    const f = world.f, s = clampR(fin(strength, 0.6), 0, 1);
    let n = 0;
    forDisc(world, x, y, Math.max(0.5, fin(radius, 8)), (i, tx, ty, d) => {
      if (f.water[i] === WATER.LAND) return;
      f.fish[i] = Math.min(1, f.fish[i] + 0.4 * (1 - d * d) * s);
      n++;
    });
    if (!n) return { ok: false, message: 'Fish need water.' };
    const pl = placePhrase(world, x, y);
    const waters = pl.kind === 'sea' || pl.kind === 'ocean' || pl.kind === 'lake' ? `The waters of ${pl.name}` : `The waters ${pl.text}`;
    divine(world, 'fish', x, y, radius, `${waters} teemed with fish beyond counting.`, { type: 'spawn', glyph: 'fish' });
    return { ok: true, message: 'The waters teem with fish.' };
  },
  finish(world) { endStroke(world); },
});

registerTool({
  id: 'wildfire', label: 'Wildfire', group: 'life', icon: 'wildfire', order: 60, polarity: 'bane',
  desc: 'Set the land alight. Dry grass and forest burn fiercely; wet land resists.',
  target: 'area', radius: 2, minRadius: 0, maxRadius: 12, continuous: true,
  strength: { label: 'Heat', min: 0.2, max: 1, default: 0.8 },
  preview: wildfirePreview,
  apply(world, x, y, { radius, strength }) {
    if (!world.sys[ID]) return notReady;
    const s = clampR(fin(strength, 0.8), 0.05, 1);
    const R = Math.max(0, fin(radius, 2)), f = world.f;
    // judge first, without rng, whether anything can catch (what ignite() accepts), so a
    // refused stroke leaves history untouched; the tinder nearest the centre always catches
    let first = -1, firstD = Infinity;
    forDisc(world, x, y, R, (i, tx, ty, d) => {
      if (d < firstD && f.water[i] === WATER.LAND && f.veg[i] >= 0.06 && f.snow[i] <= 0.6) { first = i; firstD = d; }
    });
    if (first < 0) return { ok: false, message: 'Nothing here will burn.' };
    let lit = 0;
    forDisc(world, x, y, R, (i, tx, ty, d) => {
      if (d > 0.6 && world.rng.next() > 0.5) return;
      if (ignite(world, i, s * (1 - 0.4 * d), { cause: 'divine' })) lit++;
    });
    if (!lit && ignite(world, first, s * (1 - 0.4 * firstD), { cause: 'divine' })) lit++;
    if (!lit) return { ok: false, message: 'Nothing here will burn.' };
    if (stroke(world, 'wildfire')) {
      emitFx(world, { type: 'curse', x, y, r: Math.max(1, radius), src: 'tool' });
      emitFx(world, { type: 'fire', x, y, r: Math.max(1, radius), src: 'tool' });
      emitFx(world, { type: 'label', x, y, text: `${lit} tile${lit === 1 ? '' : 's'} ablaze`, tone: 'bane', size: 0.9, src: 'tool' });
      chronicle(world, { cat: 'divine', imp: 1, x, y, key: 'divine.wildfire', text: pick(world, [
        `Fire fell from the heavens ${placePhrase(world, x, y).text}.`,
        `A tongue of flame licked down out of a clear sky ${placePhrase(world, x, y).text}, and the land began to burn.`,
      ]) });
    }
    return { ok: true, message: `${lit} tiles set alight.` };
  },
  finish(world) { endStroke(world); },
});
