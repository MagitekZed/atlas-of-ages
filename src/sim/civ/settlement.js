// Monthly settlement economy and society. Each live settlement is processed once a month
// (staggered by id across the days of the month).
//
// Catchment: land tiles within s.radius that the settlement owns (f.ownerSettle) plus the
// water tiles its territory reached (cache.civ.waterSettle) for fishing.
//
// Food (person-months; one person eats one per month):
//   gathering & hunting  WILD·wildFood·veg + HUNT·herb on unfarmed land, seasonal, labour-
//                        limited with diminishing returns (1 − e^(−labour·k/potential))
//   farming              farm·soil·crop suitability(annTemp, moisture)·farmYield, harvested
//                        mostly in late summer/autumn away from the tropics; farmland needs
//                        labourers (fewer with better tools)
//   fishing              fish density on owned waters + river fish; depletes fish stocks
//   granary              stock with spoilage and a storage cap; civ network shares surpluses
//   famine               deaths, emigration, unrest; trading towns can buy grain with wealth
// Farmland: conversion when hungry (clears veg), abandonment without labour, fallowing on
// exhausted soil; soil exhaustion slowed by husbandry / crop rotation / fertiliser.
// Population: births (food, housing, happiness, × birthRate) and deaths (health, crowding,
// siege), shaped by the town's age bands (core/cohorts.js: reconciled first, rounded last).
// Health: crowding vs sanitation, hunger, disease, pollution. Happiness: food, wealth, taxes,
// war weariness, faith, buildings, ruler. Unrest and loyalty follow.
// Hands: the town's trades (jobs.js, set after the land scan): the farmers and gatherers feed it,
// craftsmen, builders and labourers make, merchants trade, miners work the mine.
// Production: labour not tied to food, mines (deplete mineral / resourceAmt), timber.
// Wealth: production, commerce, luxury deposits, tradeIncome (written by trade) → taxes.
// Also: housing, culture, defense/garrison, tier & radius, popDensity, pollution & CO₂.
//
// Town modifiers (contracts §6): every phase reads townMods(world, s) — core settlementMods
// (the town's timed effects) combined with the smods of any registered racial buildings it
// holds: happiness, unrest, loyalty, health (added), defense (a fractional bonus to the
// fortification rating), foodYield, production, culture, birth, mortality, housing (×), and
// research (× the realm's research, people-weighted) and attract (× urban drift) in civmonth.
// Ext call sites: demography (birth / mortality ×), loyalty (+). Registered civ mod keys:
// mortality (× deaths), forestFarm (fields among the trees: clearing × (1 − ff), forest field
// cap × (0.6 + 0.4·ff)), deepHalls (housing × 1.4 on hills and mountains).
// Hooks: famine { sid, deaths, months } (once per famine, at its end or the town's death,
// when ≥ 50 died or ≥ 5 %), tierChanged (s, from, to), depositExhausted { sid, i, resource }.

import { WATER, RESOURCES, TIERS, BIOME, tierForPop, DAYS_PER_YEAR } from '../../core/constants.js';
import { destroySettlement, settlementsNear } from '../../core/entities.js';
import { latitude, monthOf, emitFx } from '../../core/world.js';
import { emit } from '../../core/hooks.js';
import { neutralSettlementMods, SETTLEMENT_MOD_KEYS } from '../../core/effects.js';
import { mulEachOf, sumOf, hasProviders } from '../../core/ext.js';
import { reconcileCohorts, cohortMonth, cohortTotal, settleCohorts, verifyCohorts, COHORT_DEV } from '../../core/cohorts.js';
import { clamp, clamp01, smoothstep, majorToll } from '../../core/util.js';
import { proxies, climGrid, BIO_WILD, BIO_VEGMAX, BIO_HERB, BIO_WOOD, BIO_FARM, BIO_FISH } from './land.js';
import { getMods, hasTech, modValue } from './tech.js';
import { allowedLevel, progressProject, buildingSmods } from './buildings.js';
import { buildingDef } from './data.js';
import { routeMigrants, trySettlers } from './expansion.js';
import { updateJobs, J } from './jobs.js';
import { fin, div, record, rateOk, civCache, ensureSettlementFields, touched } from './state.js';
import { theName, peopleOf, pick, peopleCount, seasonWord, approx } from './prose.js';

// Yields (person-months per month)
const WILD_BASE = 62;      // fully vegetated tile, wildFood 1
const HUNT_BASE = 55;      // herbivore density 1
const FARM_BASE = 1100;    // fully farmed tile, soil 1, ideal climate
/** Most a tile is ever farmed (hedges, woodlots, pasture and villages share the land). */
const FARM_MAX = 0.8;
const FISH_BASE = 150;     // water tile, fish density 1, coastal sea
const RIVER_FISH = 10;     // per river class on land tiles
const GATHER_K = 2.4;      // max food a forager can bring in per month (as jobs.js)
const GRAIN_PER_WEALTH = 40;
/** Housing ceiling by era before buildings and tech multipliers. */
const HOUSE_ERA = [3500, 16000, 45000, 110000, 220000, 520000, 2000000, 8000000];
/** Catchment radius by tier. */
export const TIER_RADIUS = [2, 2, 3, 3, 4, 5, 6];
/** Northern-hemisphere harvest share by month (sums to 1). */
const HARVEST = [0, 0, 0, 0.01, 0.03, 0.06, 0.12, 0.3, 0.32, 0.12, 0.03, 0.01];

// Building levels read every month, kept in a fixed-layout typed array per settlement
// (s.buildings objects come in many shapes, which makes direct reads slow). Rebuilt on
// scan months and whenever s.flags.brev changes (buildings.js bumps it on completion).
export const BV = { granary: 0, market: 1, aqueduct: 2, sewers: 3, hospital: 4, mine: 5, bank: 6, harbor: 7, railway: 8,
  temple: 9, theatre: 10, library: 11, university: 12, walls: 13, barracks: 14, factory: 15, observatory: 16 };
const BV_UP = 17, BV_N = 18;
/** Offset of a settlement's building levels in civCache(world).bv (refreshed if stale). */
export function buildingVec(world, s, refresh = false) {
  const c = civCache(world);
  const id = s.id;
  if (!c.bv || c.bv.length < (id + 1) * BV_N) {
    const cap = Math.max(id + 1, world.settlements.length) + 128;
    const v = new Float32Array(cap * BV_N), r = new Int32Array(cap).fill(-1);
    if (c.bv) { v.set(c.bv); r.set(c.bvRev); }
    c.bv = v; c.bvRev = r;
  }
  const o = id * BV_N;
  const rev = s.flags.brev | 0;
  if (refresh || c.bvRev[id] !== rev) {
    const v = c.bv;
    v.fill(0, o, o + BV_N);
    let up = 0;
    const B = s.buildings;
    for (const k in B) {
      const lv = +B[k] || 0;
      const j = BV[k];
      if (j !== undefined) v[o + j] = lv;
      const def = buildingDef(k);
      if (def) up += def.upkeep * lv;
    }
    v[o + BV_UP] = up;
    c.bvRev[id] = rev;
  }
  return o;
}

const SM_KEYS = Object.keys(SETTLEMENT_MOD_KEYS);
const NEUTRAL_SM = neutralSettlementMods();
/**
 * The town's modifiers: its timed effects aggregated exactly as core settlementMods does (an
 * effect counts for every month whose first day it is live at; add keys summed, mul keys
 * multiplied, each clamped), combined with the smods of the registered halls it holds.
 * Frozen; the shared neutral object when neither applies. Cached per town while its effects
 * list (effectsV), its buildings and the set of effects live at month start stay the same —
 * a window that ends at the first month start on which a live effect has expired — so the
 * value is a pure function of state, but is not rebuilt every month.
 */
export function townMods(world, s) {
  const bm = buildingSmods(world, s);
  const effs = s.effects;
  if (!bm && (!effs || !effs.length)) return NEUTRAL_SM;
  const ms = Math.floor(world.time.day / 30) * 30;
  const cache = (civCache(world).tmods ||= {});
  const v = s.effectsV | 0;
  const hit = cache[s.id];
  if (hit && hit.v === v && hit.bm === bm && ms >= hit.from && ms < hit.until) return hit.val;
  const out = { ...NEUTRAL_SM };
  let any = false, until = Infinity;
  if (effs) {
    for (const e of effs) {
      if (!e || !e.m || !(e.until < 0 || e.until > ms)) continue;
      if (e.until >= 0 && e.until < until) until = e.until;
      for (const key in e.m) {
        const spec = SETTLEMENT_MOD_KEYS[key];
        const x = e.m[key];
        if (!spec || typeof x !== 'number' || !Number.isFinite(x)) continue;
        if (spec.kind === 'add') out[key] += x; else out[key] *= x;
        any = true;
      }
    }
  }
  if (any) for (const key of SM_KEYS) { const [lo, hi] = SETTLEMENT_MOD_KEYS[key].limit; const x = out[key]; out[key] = x < lo ? lo : x > hi ? hi : x; }
  if (bm) {
    for (const key of SM_KEYS) {
      const x = bm[key];
      if (x === undefined) continue;
      const spec = SETTLEMENT_MOD_KEYS[key];
      let y = spec.kind === 'add' ? out[key] + x : out[key] * x;
      y = y < spec.limit[0] ? spec.limit[0] : y > spec.limit[1] ? spec.limit[1] : y;
      if (Number.isFinite(y)) { out[key] = y; any = true; }
    }
  }
  const val = any ? Object.freeze(out) : NEUTRAL_SM;
  cache[s.id] = { v, bm, from: ms, until, val };
  return val;
}

function scratch(world) {
  const c = civCache(world);
  if (!c.sc) c.sc = { idx: new Int32Array(512), wild: new Float32Array(512), fy: new Float32Array(512), fishv: new Float32Array(512), n: 0 };
  return c.sc;
}

/**
 * Scratch values shared by the phases of one settlement's monthly update (one fixed-shape
 * object per world, in the cache; updates never nest).
 */
function scratchX(world) {
  const c = civCache(world);
  return c.ux || (c.ux = {
    mods: null, sm: null, era: 0, pop: 0, due: false, bo: 0,
    harvestW: 0, wildSeason: 1, farming: false,
    wildPot: 0, fishPot: 0, farmCap: 0, farmLoad: 0, timber: 0, ore: 0, lux: 0, strat: 0, weightSum: 0,
    labor: 0, fw: 0, farmLabor: 0, farmFrac: 0, farmMean: 0, left: 0, gPot: 0, gPotMean: 0, gatherNow: 0, gatherMean: 0,
    pressure: 0, prodFood: 0, fed: 1, stockMonths: 0, housing: 0, houseRatio: 0,
    dis: 0, production: 0, foodWorkers: 0, tier: 0, isCap: false,
    cm: { births: 0, deaths: 0, famine: 0, emig: 0 },
    workers: 0, jobProd: 1, jobTrade: 1, jobMine: 1,
  });
}

/**
 * One settlement, one month. cctx is the per-civ context built by the civ pass:
 * { mods, era, capital, atWar }.
 */
export function updateSettlement(world, s, civ, cctx) {
  ensureSettlementFields(s);
  const pop = fin(s.population, 0);
  if (pop < 8) { abandon(world, s, civ, 'dwindled'); return; }
  const workers = reconcileCohorts(world, s, civ);
  const X = scratchX(world);
  X.workers = workers;
  X.mods = cctx.mods || getMods(world, civ);
  X.sm = townMods(world, s);
  X.era = cctx.era | 0;
  X.pop = pop;
  seasonAndLand(world, s, civ, X);
  updateJobs(world, s, civ, X, civCache(world).bv, X.bo, BV);
  foodPhase(world, s, X);
  demographyPhase(world, s, civ, X);
  healthAndEconomy(world, s, civ, X);
  socialPhase(world, s, civ, cctx, X);
  landUseAndGrowth(world, s, civ, cctx, X);
  settleCohorts(s);
  if (COHORT_DEV.verify && s.alive) verifyCohorts(world, s);
}

/** Season of the harvest, the catchment's potentials (rescanned quarterly) and buildings. */
function seasonAndLand(world, s, civ, X) {
  const mods = X.mods;
  const lat = latitude(world, s.y);
  const tilt = clamp(fin(world.params.axialTilt, 23) / 23, 0, 2);
  const amp = smoothstep(0.12, 0.55, Math.abs(lat)) * Math.min(1, tilt);
  const m = monthOf(world);
  const mh = lat >= 0 ? m : (m + 6) % 12;
  X.harvestW = HARVEST[mh] * amp + (1 - amp) / 12;
  X.wildSeason = 1 + 0.45 * amp * Math.sin(2 * Math.PI * ((mh + 0.5) / 12 - 0.35));
  X.farming = mods.farming > 0;

  // catchment potentials (rescanned quarterly, cached on s.flags.pot)
  const monthIdx = Math.floor(world.time.day / 30);
  let pot = s.flags.pot;
  // quarterly rescan; monthly in a settlement's first year (its territory is still forming,
  // and a scan made before the first territory pass sees only the town's own tile)
  const due = (monthIdx + s.id) % SCAN_EVERY === 0 || world.time.day - fin(s.foundedDay) < 360;
  X.due = due;
  if (!Array.isArray(pot) || pot.length !== POT_LEN || pot[POT_LEN - 1] !== s.radius || due) {
    const since = Array.isArray(pot) && pot.length === POT_LEN ? Math.min(6, Math.max(1, monthIdx - pot[POT_LEN - 2])) : 0;
    pot = scanCatchment(world, s, mods, X.era, since);
    const ml = +s.buildings.mine || 0;
    if (ml || pot[6] > 0 || pot[7] > 0) depleteDeposits(world, s, civ, X.era, ml, mods, since || 1);
  }
  let farmCap = pot[2];
  // frost at harvest time ruins standing crops (checked monthly at the town)
  if (X.harvestW > 0.08) { const t = world.f.temp[s.i]; if (t < 2) farmCap *= clamp01((t + 6) / 8); }
  const fy = X.sm.foodYield;
  X.wildPot = pot[0] * mods.gatherYield * fy;
  X.fishPot = pot[1] * mods.fishYield * fy;
  X.farmCap = farmCap * mods.farmYield * fy;
  X.farmLoad = pot[3]; X.timber = pot[4]; X.ore = pot[5]; X.lux = pot[6]; X.strat = pot[7]; X.weightSum = pot[8];
  X.bo = buildingVec(world, s, due);
}

/** Labour, harvests, gathering and fishing, and the granary. */
function foodPhase(world, s, X) {
  const mods = X.mods, pop = X.pop;
  const bv = civCache(world).bv, bo = X.bo;
  // the hands come from the town's trades (jobs.js): the farmers work the fields, and everyone
  // else forages part-time (the herders, hunters and fishers are its full-time share)
  const labor = X.workers;
  const fw = X.fw;
  const farmNeed = X.farmLoad * fw;
  const farmLabor = Math.min(s.jobs[J.farm], farmNeed);
  const farmFrac = farmNeed > 0 ? farmLabor / farmNeed : 0;
  const farmMean = X.farmCap * farmFrac;
  const left = Math.max(0, labor - farmLabor);
  const gPot = X.wildPot * X.wildSeason + X.fishPot;
  const gPotMean = X.wildPot + X.fishPot;
  const gatherNow = gPot > 0 ? gPot * (1 - Math.exp(-left * GATHER_K / gPot)) : 0;
  const gatherMean = gPotMean > 0 ? gPotMean * (1 - Math.exp(-left * GATHER_K / gPotMean)) : 0;
  const siegeF = s.siege ? 0.45 : 1;
  const farmNow = farmMean * 12 * X.harvestW * siegeF;
  const prodFood = Math.max(0, farmNow + gatherNow * siegeF);
  s.foodProd = prodFood;
  s.foodNeed = pop;
  s.capacity = Math.max(1, X.farmCap + 0.82 * gPotMean);
  X.labor = labor; X.fw = fw; X.farmLabor = farmLabor; X.farmFrac = farmFrac; X.farmMean = farmMean; X.left = left;
  X.gPot = gPot; X.gPotMean = gPotMean; X.gatherNow = gatherNow; X.gatherMean = gatherMean; X.prodFood = prodFood;
  // grain shipped in by the realm's granary network counts toward what the town can feed, and
  // a secure supply line eases the pressure a little more (otherwise imports that exactly
  // cover the shortfall hold a city at the size its own fields can feed: cities fed by their
  // realm grow to about a third beyond their hinterland)
  X.pressure = div(pop, farmMean + gatherMean + 1.15 * fin(s.foodImport) + 1, 2);

  // food stock: spoilage, storage cap, buying grain in hard times
  const granary = bv[bo + BV.granary];
  let stock = fin(s.food) + prodFood - pop;
  const spoil = 0.05 / Math.max(0.3, mods.storage) / (1 + 0.9 * granary);
  const storeCap = pop * (4 + 3 * granary) * mods.storage + 50;
  let fed = 1;
  if (stock > 0) {
    stock -= stock * spoil;
    if (stock > storeCap) stock = storeCap;
  } else if (stock < 0) {
    if ((bv[bo + BV.market] > 0 || fin(s.tradeIncome) > 0 || s.harbor) && s.wealth > 0 && !s.siege) {
      const buy = Math.min(-stock, s.wealth * GRAIN_PER_WEALTH);
      stock += buy;
      s.wealth -= buy / GRAIN_PER_WEALTH;
    }
    if (stock < 0) { fed = clamp01(1 + stock / pop); stock = 0; }
  }
  s.food = stock;
  X.fed = fed;
  X.stockMonths = div(stock, pop, 0);
}

/** Births, deaths, famine and emigration. */
function demographyPhase(world, s, civ, X) {
  const P = world.params, mods = X.mods, pop = X.pop, fed = X.fed, sm = X.sm;
  const housing = Math.max(20, fin(s.housing, pop));
  const houseRatio = pop / housing;
  let famineDeaths = 0, emig = 0;
  if (fed < 0.999) {
    const short = 1 - fed;
    if (!(s.famine > 0)) s.flags.famPop0 = pop;
    s.famine = (s.famine || 0) + 1;
    famineDeaths = pop * short * 0.1;
    emig = pop * short * 0.07 * fin(P.migration, 1);
  } else if (s.famine > 0) {
    if (s.famine >= 3 && s.flags.famineDeaths > 0) famineEnded(world, s);
    famineHook(world, s);
    s.famine = 0;
    s.flags.famineDeaths = 0;
  }
  // a people's own nature (WP5 demography: elves breed slowly and live long), the town's
  // effects and the realm's arts
  const dm = hasProviders('demography') ? mulEachOf('demography', world, s, civ) : null;
  const houseF = houseRatio < 0.75 ? 1 : Math.pow(clamp01((1 - houseRatio) / 0.25), 1.5);
  const foodF = fed < 1 ? 0.3 * fed : clamp(0.8 + 0.06 * X.stockMonths, 0.8, 1.12);
  // births fall as the people press on what the land can feed (smooth Malthusian check)
  const pressF = clamp01((1.15 - X.pressure) / 0.4);
  let birthA = 0.044 * fin(P.birthRate, 1) * mods.birth * foodF * houseF * pressF * (0.75 + 0.5 * s.happiness) * sm.birth;
  let deathA = 0.032 * (1.45 - s.health) + (houseRatio > 1 ? 0.06 * (houseRatio - 1) : 0) + (s.siege ? 0.04 : 0);
  deathA = Math.max(0.004, deathA) * sm.mortality * modValue(mods, 'mortality', 1);
  if (dm) { birthA *= dm.birth; deathA *= dm.mortality; }
  if (houseRatio > 1.02) emig += pop * 0.01 * (houseRatio - 1) * fin(P.migration, 1);
  // the crude rates are those of a town at the reference age structure: the town's own bands
  // shape them (women of childbearing age and their partners, the old and the very young), the
  // famine takes the frail and the emigrants are the young (core/cohorts.js)
  const out = cohortMonth(world, s, civ, birthA, deathA, famineDeaths, emig, X.cm);
  famineDeaths = out.famine; emig = out.emig;
  const newPop = cohortTotal(s.cohorts);
  s.growth = clamp(div(newPop - pop, pop, 0) * 12, -1, 1);
  s.emigrants = emig;
  if (famineDeaths > 0) {
    s.flags.famineDeaths = fin(s.flags.famineDeaths) + famineDeaths;
    if (s.famine >= 2) famineReport(world, s, civ, s.flags.famineDeaths, emig);
  }
  s.population = newPop;
  if (newPop > s.peakPopulation) s.peakPopulation = newPop;
  X.pop = newPop;
  X.housing = housing;
  X.houseRatio = houseRatio;
  // overcrowding emigrants are sent on quarterly (fewer, larger moves); famine refugees at once
  if (emig > 0) {
    s.flags.emig = fin(s.flags.emig) + emig;
    if (s.flags.emig >= 5 && (famineDeaths > 0 || X.due)) { routeMigrants(world, s, civ, s.flags.emig); s.flags.emig = 0; }
  }
}

/** The famine hook, once per famine (at its end, or when the town dies of it): ≥ 50 dead or ≥ 5 %. */
function famineHook(world, s) {
  const dead = fin(s.flags.famineDeaths);
  const months = s.famine | 0;
  if (!(dead > 0) || !(months > 0)) return;
  const base = Math.max(1, fin(s.flags.famPop0, s.population + dead));
  if (dead >= 50 || dead / base >= 0.05) emit(world, 'famine', { sid: s.id, deaths: Math.round(dead), months });
}

/** Health, production, commerce, taxes and housing. */
function healthAndEconomy(world, s, civ, X) {
  const f = world.f, mods = X.mods, pop = X.pop, ci = s.i, era = X.era;
  const bv = civCache(world).bv, bo = X.bo;
  let dis = 0;
  if (s.disease && typeof s.disease === 'object') {
    dis = fin(s.disease.I, 0);
    if (dis > 1) dis = div(dis, pop, 0);
    dis = clamp01(dis);
  }
  X.dis = dis;
  const bAqueduct = bv[bo + BV.aqueduct] > 0 ? 1 : 0, bSewers = bv[bo + BV.sewers] > 0 ? 1 : 0, bHospital = bv[bo + BV.hospital];
  const bRail = bv[bo + BV.railway] > 0 ? 1 : 0;
  const sanEff = clamp01(0.3 * bAqueduct + 0.4 * bSewers + 0.12 * bHospital + (mods.sanitation - 1) * 0.6);
  let ht = 0.8 * mods.health
    - 0.07 * Math.log10(Math.max(1, pop / 600)) * (1 - sanEff)
    - 0.35 * (1 - X.fed) - 0.04 * Math.min(6, s.famine)
    - 0.6 * dis + 0.03 * bHospital + 0.02 * bAqueduct
    - 0.25 * f.pollution[ci] - 0.15 * f.devastation[ci] + X.sm.health;
  ht = clamp(ht, 0.05, 0.98);
  s.health = clamp01(s.health + (ht - s.health) * 0.3);

  // production & wealth
  const foodWorkers = X.farmLabor + Math.min(X.left, X.gatherNow / (GATHER_K * 0.75));
  X.foodWorkers = foodWorkers;
  const nonFood = Math.max(0, pop - foodWorkers);
  const mineLvl = bv[bo + BV.mine];
  const ore = X.ore, strat = X.strat;
  const oreOut = mineLvl ? ore * (1.5 + 1.5 * mineLvl) * mods.mining : ore * 0.3 * Math.max(0, mods.mining - 1);
  const timberOut = X.timber * 0.35 * Math.min(1, pop / 600);
  const stratOut = strat * (0.4 + 0.25 * mineLvl) * Math.min(1, pop / 1500);
  // the trades (jobs.js): craftsmen, builders and labourers against an unbuilt town's, the miners
  // the mine asks for
  let production = ((pop * 0.004 + nonFood * 0.025 * X.jobProd) * mods.production + oreOut * X.jobMine + timberOut + stratOut)
    * (0.55 + 0.6 * s.happiness) * (1 - 0.45 * s.unrest) * (s.siege ? 0.5 : 1) * X.sm.production;
  production = Math.max(0, fin(production));
  s.production = production;
  X.production = production;
  const commerceT = civ.traits ? fin(civ.traits.commerce, 0.5) : 0.5;
  // the merchants against an unbuilt town's: markets, banks and a harbour draw more of them
  // (jobs.js), so their trade grows as the merchants come
  const commerce = Math.pow(pop, 0.8) * 0.012 * (0.5 + commerceT) * mods.trade * (X.jobTrade + 0.1 * bRail);
  const gross = production * 0.25 + commerce + fin(s.tradeIncome) + X.lux * 1.6 * Math.min(1, pop / 800);
  const taxRate = clamp(civ.taxRate * mods.taxEfficiency, 0, 0.6);
  const tax = Math.max(0, gross * taxRate * (1 - 0.6 * s.unrest) * (s.siege ? 0.3 : 1));
  const upkeep = bv[bo + BV_UP] * (1 + 0.2 * era);
  s.wealth = Math.max(0, fin(s.wealth) * 0.985 + gross - tax - upkeep);
  s.taxes = tax;
  civ.flags.taxAcc = fin(civ.flags.taxAcc) + tax;

  // housing: built with production, capped by era & infrastructure
  let eraCap = HOUSE_ERA[era] * mods.housing * (1 + 0.35 * bAqueduct + 0.4 * bSewers + 0.15 * bRail) * X.sm.housing;
  // halls dug into the hills (a delving people's deepHalls): more room on high ground
  const dh = modValue(mods, 'deepHalls', 0);
  if (dh > 0 && f.elevation[ci] >= 0.62) eraCap *= 1 + 0.4 * Math.min(1, dh);
  let hs = X.housing;
  if (hs < pop * 1.3 && hs < eraCap) hs += Math.min(production * 0.35 * 3, pop * 0.03 + 15);
  if (hs > eraCap) hs += (eraCap - hs) * 0.05;
  if (hs > pop * 3 && hs > 200) hs *= 0.996;
  s.housing = Math.max(20, fin(hs, pop));
}

/** Happiness, unrest, loyalty, assimilation, culture, defence and garrison. */
function socialPhase(world, s, civ, cctx, X) {
  const f = world.f, mods = X.mods, pop = X.pop, ci = s.i, dis = X.dis, houseRatio = X.houseRatio;
  const bv = civCache(world).bv, bo = X.bo;
  const tr = civ.traits || DEFAULT_TRAITS;
  const bTemple = bv[bo + BV.temple], bTheatre = bv[bo + BV.theatre];
  const isCap = civ.capitalId === s.id;
  X.isCap = isCap;
  const cap = cctx.capital;
  const dCap = cap && !isCap ? Math.hypot(cap.x - s.x, cap.y - s.y) : 0;
  const dRatio = dCap / Math.max(4, mods.adminRange);
  const stockMonths = X.stockMonths, fed = X.fed;
  let h = 0.5 + (stockMonths >= 3 ? 0.05 : stockMonths >= 1 ? 0.02 : -0.05);
  if (fed < 1) h -= 0.35 * (1 - fed) + 0.05;
  h += 0.08 * Math.tanh(div(s.wealth, pop, 0) * 15);
  h -= Math.max(0, civ.taxRate - 0.06) * 1.2;
  h -= 0.3 * clamp01(fin(civ.warWeariness));
  if (civ.stateReligion != null && s.dominantReligion != null) {
    h += s.dominantReligion === civ.stateReligion ? 0.05 : -(0.04 + 0.08 * fin(tr.religiosity, 0.5)) * (1.2 - fin(tr.tolerance, 0.5));
  }
  h += 0.03 * Math.min(2, bTemple) + 0.04 * bTheatre + 0.02 * (bv[bo + BV.market] > 0 ? 1 : 0);
  h += 0.6 * mods.happiness;
  h -= 0.035 * Math.log10(Math.max(1, pop / 2000));   // crowded, anonymous cities
  h -= 0.06 * clamp(dRatio, 0, 1.5);                    // provincial neglect
  if (s.siege) h -= 0.2;
  h -= 0.4 * dis;
  h -= 0.15 * Math.max(0, houseRatio - 0.95);
  h += (s.health - 0.7) * 0.2;
  const fl = s.flags;
  const sinceConq = fl.conqueredDay != null ? (world.time.day - fl.conqueredDay) / DAYS_PER_YEAR : 999;
  if (sinceConq < 25) h -= 0.08 * (1 - sinceConq / 25);
  h -= 0.06 * (1 - fl.assim);
  h -= 0.2 * f.devastation[ci];
  h += X.sm.happiness;
  s.happiness = clamp01(s.happiness + (clamp01(h) - s.happiness) * 0.25);

  // unrest relaxes toward the town's present grievances (other systems may add sudden
  // shocks — plague panic, sieges — which fade as the grievances do)
  const garRatio = div(s.garrison, pop, 0);
  const grievance = 1.6 * Math.max(0, 0.5 - s.happiness) + 1.1 * Math.max(0, 0.55 - s.loyalty)
    + (s.famine >= 2 ? 0.15 : 0) + (houseRatio > 1.05 ? 0.06 : 0) + Math.max(0, civ.taxRate - 0.15) * 0.8
    + (s.siege ? 0.08 : 0) + 0.2 * dis;
  const calm = Math.min(0.15, garRatio * 4) + (s.happiness > 0.6 ? 0.05 : 0) + (civ.government === 'dictatorship' ? 0.06 : 0);
  const unrestT = clamp01(grievance - calm + X.sm.unrest);
  s.unrest = clamp01(s.unrest + (unrestT - s.unrest) * (unrestT > s.unrest ? 0.15 : 0.1));

  // from the Renaissance on, distant and subject peoples of large realms want states of their own
  const nat = civ.settlementIds.length >= 12 ? clamp((fin(civ.tech?.era, 0) - 4) / 3, 0, 1) : 0;
  const lt = 0.82 - 0.22 * clamp(dRatio - 0.4, 0, 2) - 0.3 * (1 - fl.assim)
    - (nat > 0 ? 0.16 * nat * (s.originCivId !== s.civId ? 1 : 0.35) * clamp(dRatio, 0, 1.5) : 0)
    + (civ.stability - 0.6) * 0.3 + (civ.legitimacy - 0.6) * 0.15 + (s.happiness - 0.5) * 0.25 - s.unrest * 0.15
    + (isCap ? 0.2 : 0) - (sinceConq < 30 ? 0.1 * (1 - sinceConq / 30) : 0)
    + X.sm.loyalty + (hasProviders('loyalty') ? sumOf('loyalty', world, s, civ) : 0);
  s.loyalty = clamp01(s.loyalty + (clamp01(lt) - s.loyalty) * 0.12);
  // months of sustained disaffection (a rising needs years of grievance, not one bad season)
  fl.grieve = s.unrest > 0.5 && s.loyalty < 0.45 ? Math.min(600, fin(fl.grieve) + 1) : Math.max(0, fin(fl.grieve) - 3);
  // months of estrangement of a subject people: feeds independence movements from the Renaissance on
  fl.natl = nat > 0 && s.loyalty < 0.25 && s.originCivId !== s.civId ? Math.min(600, fin(fl.natl) + 1) : Math.max(0, fin(fl.natl) - 2);
  if (s.originCivId === s.civId) fl.assim = Math.min(1, fl.assim + 0.01);
  else fl.assim = Math.min(1, fl.assim + (0.008 + 0.004 * Math.log10(1 + fin(civ.culture) / 1000)) / 12);

  // culture, defence, garrison
  s.culture = Math.max(0, fin(s.culture) * 0.9985 + 0.008 * Math.sqrt(pop) * mods.culture * X.sm.culture
    * (1 + 0.35 * bTemple + 0.5 * bTheatre + 0.25 * bv[bo + BV.library] + 0.5 * bv[bo + BV.university] + 0.8 * fl.wonders));
  const tier = tierForPop(pop);
  X.tier = tier;
  if (!s.siege) {
    const defT = (0.5 + 0.12 * tier + 0.55 * bv[bo + BV.walls]) * mods.defense * (1 - 0.5 * f.devastation[ci]) * (1 + X.sm.defense);
    s.defense = Math.max(0, fin(s.defense) + (defT - fin(s.defense)) * 0.1);
    const garT = Math.max(5, pop * 0.012 * (0.6 + 0.8 * fin(tr.militarism, 0.5)) * (1 + 0.5 * bv[bo + BV.barracks]) * mods.military);
    s.garrison = Math.max(0, fin(s.garrison) + (garT - fin(s.garrison)) * 0.06);
  }
}
const DEFAULT_TRAITS = Object.freeze({});

/** Land-use plans for the next scan, emissions, projects, tier and radius, settlers, abandonment. */
function landUseAndGrowth(world, s, civ, cctx, X) {
  const mods = X.mods, pop = X.pop, era = X.era;
  const bv = civCache(world).bv, bo = X.bo;
  const fishEffort = X.gPot > 0 ? X.gatherNow / X.gPot : 0;
  const pressure = X.pressure, farmFrac = X.farmFrac;
  const expand = X.farming && (pressure > 0.9 || X.stockMonths < 1.5) && farmFrac > 0.97 && X.labor - X.farmLabor > X.fw * 0.05;
  const rural = X.workers > 0 ? Math.min(pop, X.foodWorkers * pop / X.workers) : 0;
  const industry = mods.industry * Math.max(0, mods.pollution);
  const urban = pop - rural;
  const ep = s.flags.ep;
  const nep = Array.isArray(ep) && ep.length === 8 ? ep : (s.flags.ep = new Array(8).fill(0));
  nep[0] = expand ? 0.045 * Math.min(1.6, pressure) : 0;
  nep[1] = farmFrac < 0.75 && X.farmLoad > 0 ? 0.03 * (1 - farmFrac) : 0;
  nep[2] = rural; nep[3] = urban; nep[4] = X.weightSum; nep[5] = fishEffort;
  nep[6] = 0.0025 * Math.min(1, pop / 5000);
  nep[7] = industry > 0 ? Math.min(0.12, (urban / 200000) * industry * 0.08 * (1 + 0.5 * bv[bo + BV.factory])) : 0;
  if (industry > 0 && world.climate) {
    // ≈ 0.08 ppm per year per million industrial people at full intensity: a few million people
    // in a smoky industrial age raise CO₂ by tens of ppm per century (visible greenhouse warming)
    const add = (pop / 1e6) * industry * 0.08 / 12;
    if (add > 0) world.climate.co2 = Math.min(5000, fin(world.climate.co2, 280) + add);
  }

  // project (buildings & wonders); the planning context is only needed when picking one
  if (!s.siege) {
    const planning = !s.project && world.time.day >= fin(s.flags.planDay, -1);
    const mineLvl = bv[bo + BV.mine];
    progressProject(world, s, civ, X.production * 0.5, planning ? {
      stockMonths: X.stockMonths, houseRatio: X.houseRatio, health: s.health, happiness: s.happiness,
      ore: mineLvl ? X.ore : X.ore + X.strat * 0.3,
      fishShare: div(X.fishPot, X.gPotMean + X.farmCap, 0), atWar: cctx.atWar,
      // read only when walls can be raised (chooseProject): the search is pure, so asking it
      // later or not at all changes nothing
      get borderTown() { return settlementsNear(world, s.x, s.y, 10, (o) => o.civId !== s.civId).length > 0; },
      isCapital: X.isCap, era, mods, production: X.production,
    } : null);
  }

  // tier & radius
  const tier = X.tier;
  const oldTier = s.tier;
  s.tier = tier;
  if (tier > fin(s.flags.maxTier, oldTier)) { s.flags.maxTier = tier; tierReport(world, s, civ, tier); }
  // announced through the hook with a little hysteresis: a rise at once, a fall only when the
  // town has shrunk well below the line (a village hovering at 500 does not flicker)
  const seen = fin(s.flags.tierSeen, oldTier);
  if (tier > seen || (tier < seen && tierForPop(pop * 1.15) < seen)) { s.flags.tierSeen = tier; emit(world, 'tierChanged', s, seen, tier); }
  // iron tools, carts and roads let a city work a wider hinterland (Iron Age and later)
  s.radius = Math.min(8, TIER_RADIUS[tier] + (mods.movement >= 1.8 ? 1 : 0) + (tier >= 4 && era >= 2 ? 1 : 0)); // territory follows at its next pass
  const hb = bv[bo + BV.harbor] > 0 && s.coastal;
  if (s.harbor !== hb) s.harbor = hb;

  // expansion
  trySettlers(world, s, civ, { pressure, houseRatio: X.houseRatio, mods });

  // abandonment
  if (s.population < 8 || (s.famine >= 18 && s.population < 60)) {
    if (s.population >= 1) routeMigrants(world, s, civ, s.population);
    abandon(world, s, civ, s.famine >= 18 ? 'famine' : 'dwindled');
  }
}

const SCAN_EVERY = 3;
const LAND = WATER.LAND;
const POT_LEN = 11;
/** Wooded biomes (forest gardens apply there). */
const FOREST_B = new Uint8Array(32);
for (const b of [BIOME.TAIGA, BIOME.TEMPERATE_FOREST, BIOME.TEMPERATE_RAINFOREST, BIOME.TROPICAL_FOREST, BIOME.RAINFOREST]) FOREST_B[b] = 1;

/**
 * Visit every catchment tile once: apply the land-use decisions of the last `since` months
 * (farm conversion / abandonment, fallowing, field care, logging, fishing pressure,
 * pollution), write where people live (popDensity), and return the catchment's raw
 * potentials [wildPot, fishPot, farmCap, farmLoad, timber, ore, lux, strat, weightSum,
 * scanMonth, radius] (before tech yield multipliers), cached on s.flags.pot.
 */
function scanCatchment(world, s, mods, era, since) {
  const { W, H, f } = world;
  const prox = proxies(world);
  const cc = civCache(world);
  // fishing grounds from the last territory pass (a saved field, so present right after a load)
  if (!cc.waterSettle && world.f.civWaterSettle && world.f.civWaterSettle.length === world.N) cc.waterSettle = world.f.civWaterSettle;
  const ws = cc.waterSettle;
  const sc = scratch(world);
  const farming = mods.farming > 0;
  const irrig = mods.irrigation > 0;
  const r = s.radius | 0;
  const r2 = (r + 0.5) * (r + 0.5);
  const fishR2 = Math.min(r2, 12.25);
  const climT = climGrid(world);
  const water = f.water, biome = f.biome, ownS = f.ownerSettle, farmF = f.farm, soil = f.soil;
  const vegF = f.veg, herbF = f.herb, snowF = f.snow, annRain = f.annRain, soilWater = f.soilWater, riverF = f.river;
  const coastF = f.coast, devF = f.devastation, pollF = f.pollution, mineralF = f.mineral;
  const resF = f.resource, resAmtF = f.resourceAmt, fishF = f.fish, elevF = f.elevation, popD = f.popDensity;
  const pveg = prox.veg, pherb = prox.herb, pfish = prox.fish;
  const sid = s.id, ci = s.i, sx = s.x, sy = s.y;
  const tch = touched(world);
  const tflag = tch.flag, tlist = tch.list;
  let tn = tch.n;
  const scIdx = sc.idx, scFy = sc.fy;
  // decisions of the last scan interval (per-month rates × months elapsed)
  const ep = s.flags.ep;
  const hasEp = since > 0 && Array.isArray(ep) && ep.length === 8;
  const k = hasEp ? since : 0;
  const eRate = hasEp ? Math.min(0.5, ep[0] * k) : 0, eShrink = hasEp ? Math.min(0.5, ep[1] * k) : 0;
  const eRural = hasEp ? ep[2] : 0, eUrban = hasEp ? ep[3] : 0, eWsum = hasEp ? Math.max(1, ep[4]) : 1;
  const eLog = hasEp ? Math.min(0.2, ep[6] * k) : 0, eEmit = hasEp ? Math.min(0.3, ep[7] * k) : 0;
  const fishTake = hasEp && !pfish && ep[5] > 0 ? Math.min(0.15, 0.03 * ep[5] * Math.sqrt(mods.fishYield) * k) : 0;
  const exhaust = 0.001 * (1 - mods.soilCare) * k;
  // farmers tend their fields (manure, fallow crops, terraces): soil drifts back toward its
  // natural fertility on worked land, offsetting exhaustion and the erosion of bare fields
  const care = Math.min(0.5, 0.05 * (0.5 + mods.soilCare) * k);
  const fallow = 0.02 * k;
  // forest gardens (forestFarm, e.g. elven wood-singing): fields among standing trees
  const ff = Math.min(1, modValue(mods, 'forestFarm', 0));
  const ffCap = 0.6 + 0.4 * ff, ffClear = 1 - ff;
  const soilRef = f.soilBase && f.soilBase.length === world.N ? f.soilBase : civCache(world).soil0;
  let n = 0;
  let wildPot = 0, fishPot = 0, farmCap = 0, farmLoad = 0, timber = 0, ore = 0, lux = 0, strat = 0, weightSum = 0, farmland = 0;
  let resBits = 0;
  for (let dy = -r; dy <= r; dy++) {
    const y = sy + dy;
    if (y < 0 || y >= H) continue;
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const x = sx + dx;
      if (x < 0 || x >= W) continue;
      const i = y * W + x;
      if (water[i] !== LAND) {
        if (d2 > fishR2 || !ws || ws[i] !== sid || n >= 511) continue;
        let fv = pfish ? 0.6 : fishF[i];
        if (fishTake > 0) { fv -= fv * fishTake; fishF[i] = fv; }
        fishPot += FISH_BASE * fv * BIO_FISH[biome[i]] * (1 - 0.7 * snowF[i]);
        scIdx[n] = i; scFy[n] = -1; n++;
        continue;
      }
      if (ownS[i] !== sid && i !== ci) continue;
      if (n >= 511) continue;
      if (!tflag[i]) { tflag[i] = 1; tlist[tn++] = i; }
      const b = biome[i];
      let fm = farmF[i];
      let sl = soil[i];
      if (farming) {
        const e = elevF[i];
        const relief = e > 0.75 ? 0.12 : e > 0.62 ? 0.6 : 1;
        const bf = BIO_FARM[b] * 1.15;
        // fields cluster near the town; the outer catchment stays mostly wild or pasture
        const forestGarden = ff > 0 && FOREST_B[b] === 1;
        const fmax = (bf > FARM_MAX ? FARM_MAX : bf) * relief * (climT[i] > 0.15 ? 1 : 0) * (sl > 0.08 ? 1 : 0.3) * (1 - 0.45 * d2 / r2) * (forestGarden ? ffCap : 1);
        if (eRate > 0 && fm < fmax) {
          const dfm = eRate * (fmax - fm) / (1 + 0.6 * d2 / r2);
          fm += dfm;
          vegF[i] = Math.max(0.02, vegF[i] - dfm * 0.9 * (forestGarden ? ffClear : 1));
        }
        if (eShrink > 0) fm -= fm * eShrink;
        else if (fm > fmax + 0.02 && k > 0) fm -= (fm - fmax) * Math.min(0.5, 0.05 * k); // marginal fields revert
        if (fm > 0.2 && sl < 0.16) fm -= fallow; // fallow exhausted fields
        if (fm > 0.01 && k > 0) {
          const ref = soilRef ? Math.min(1, soilRef[i] * 0.9) : 0.5;
          sl = Math.max(0.05, sl - fm * exhaust * sl + (ref > sl ? fm * care * (ref - sl) : 0));
          soil[i] = sl;
        }
        fm = fm < 0 ? 0 : fm > 1 ? 1 : fm;
        farmF[i] = fm;
        farmland += fm;
      }
      let v = vegF[i];
      if (eLog > 0 && fm < 0.5 && v > 0.35) { v -= v * eLog; vegF[i] = v; }
      if (pveg) v = BIO_VEGMAX[b] * 0.8;
      if (eEmit > 0) pollF[i] = Math.min(1, pollF[i] + (i === ci ? eEmit : eEmit * 0.25));
      const hb = pherb ? BIO_HERB[b] * 0.4 : herbF[i];
      const wild = (WILD_BASE * BIO_WILD[b] * (0.25 + 0.75 * v) + HUNT_BASE * hb) * (1 - 0.85 * fm) * (1 - 0.8 * snowF[i]);
      let moist = 0.5 * annRain[i] + 0.5 * soilWater[i];
      const rv = riverF[i];
      if (irrig && moist < 0.5 && (rv > 0 || coastF[i])) moist = 0.5;
      // moisture suitability: smoothstep(0.05, 0.3) with a mild penalty for waterlogging
      let tm = (moist - 0.05) / 0.25;
      tm = tm <= 0 ? 0 : tm >= 1 ? 1 : tm * tm * (3 - 2 * tm);
      if (moist > 0.85) { let w = (moist - 0.85) / 0.15; w = w >= 1 ? 1 : w * w * (3 - 2 * w); tm *= 1 - 0.35 * w; }
      const fy = FARM_BASE * sl * climT[i] * tm * (1 - 0.6 * devF[i]) * (1 - 0.6 * pollF[i]);
      const wsh = wild * 0.3 + fm * fy + 1;
      if (hasEp) popD[i] = eRural * wsh / eWsum + (i === ci ? eUrban : 0);
      scIdx[n] = i; scFy[n] = fy; n++;
      wildPot += wild;
      farmCap += fm * fy;
      farmLoad += fm;
      weightSum += wsh;
      if (rv > 0) fishPot += RIVER_FISH * rv;
      timber += BIO_WOOD[b] * v * (1 - fm);
      const mi = mineralF[i];
      if (mi > 0.2) ore += mi;
      const res = resF[i];
      if (res) {
        resBits |= 1 << res;
        const amt = resAmtF[i];
        const R = RESOURCES[res];
        if (amt > 0 && R && R.era <= era) {
          if (R.kind === 'luxury') lux += R.value * (amt < 1 ? amt : 1);
          else strat += R.value * (amt < 1 ? amt : 1);
        }
      }
    }
  }
  sc.n = n;
  tch.n = tn;
  s.flags.res = resBits;
  if (farming) s.farmland = farmland;
  const pot = Array.isArray(s.flags.pot) && s.flags.pot.length === POT_LEN ? s.flags.pot : (s.flags.pot = new Array(POT_LEN).fill(0));
  pot[0] = wildPot; pot[1] = fishPot; pot[2] = farmCap; pot[3] = farmLoad; pot[4] = timber;
  pot[5] = ore; pot[6] = lux; pot[7] = strat; pot[8] = weightSum;
  pot[9] = Math.floor(world.time.day / 30); pot[10] = s.radius;
  return pot;
}

function depleteDeposits(world, s, civ, era, mineLvl, mods, months = 1) {
  const { f } = world;
  const sc = scratch(world);
  const k = Math.max(1, months);
  const mineRate = mineLvl ? 0.0005 * k * mineLvl * Math.min(2, mods.mining) : 0;
  for (let t = 0; t < sc.n; t++) {
    if (sc.fy[t] < 0) continue;
    const i = sc.idx[t];
    if (mineRate > 0 && f.mineral[i] > 0.2) f.mineral[i] = Math.max(0, f.mineral[i] - f.mineral[i] * mineRate);
    const res = f.resource[i];
    if (!res || !(f.resourceAmt[i] > 0)) continue;
    const R = RESOURCES[res];
    if (!R || R.era > era) continue;
    const use = 0.0005 * k * (1 + 0.15 * era) * (R.kind === 'luxury' ? 1 : 0.6 + 0.4 * mineLvl);
    f.resourceAmt[i] = Math.max(0, f.resourceAmt[i] - use);
    if (f.resourceAmt[i] <= 0.02) {
      f.resourceAmt[i] = 0;
      f.resource[i] = 0;
      if (rateOk(world, `exhaust:${s.id}`, 30)) {
        const what = { copper: 'copper mines', tin: 'tin mines', iron: 'iron mines', gold: 'gold seams', gems: 'gem pits', marble: 'marble quarries',
          horses: 'horse pastures', spices: 'spice groves', salt: 'salt pans', furs: 'fur trapping grounds', coal: 'coal pits', oil: 'oil wells',
          starmetal: 'starmetal diggings', dragonbone: 'dragonbone hoard' }[R.key] || 'deposits';
        const plural = !/hoard$/.test(what);
        const verb = R.key === 'horses' || R.key === 'spices' || R.key === 'furs' ? 'were exhausted'
          : plural ? pick(world, ['ran dry', 'were worked out', 'gave out']) : pick(world, ['was spent', 'was carried off to the last bone']);
        record(world, { cat: 'civ', imp: 1, key: 'deposit.exhausted', text: `The ${what} of ${s.name} ${verb}.`, s, tags: [R.key] });
      }
      emit(world, 'depositExhausted', { sid: s.id, i, resource: R.key, resourceId: res });
    }
  }
}

// ---------------------------------------------------------------------------
// Chronicle reports

function famineReport(world, s, civ, dead, fled) {
  const frac = div(dead, s.population + dead, 0);
  if (dead < 150 || (frac < 0.06 && dead < 1500)) return;
  if (!rateOk(world, `famine:${s.id}`, 15) || !rateOk(world, `famineCiv:${civ.id}`, 4)) return;
  const season = seasonWord(world, s.y);
  // the one disaster scale (core/util majorToll): 1,000 dead, or a tenth of the town and 300
  const imp = majorToll(dead, frac) ? 3 : 2;
  const text = pick(world, [
    `Famine gripped ${s.name} in the ${season}; ${peopleCount(world, dead)} perished${fled > 20 ? ' and many more fled' : ''}.`,
    `The granaries of ${s.name} stood empty, and hunger killed ${peopleCount(world, dead)}.`,
    `A hungry ${season} in ${s.name} claimed ${peopleCount(world, dead)}${fled > 20 ? ', while others took to the roads in search of bread' : ''}.`,
  ]);
  record(world, { cat: 'civ', imp, key: 'famine', text, s, tags: [season] });
  emitFx(world, { type: 'famine', x: s.x, y: s.y, civId: s.civId });
  if (civ.ruler?.deeds) civ.ruler.deeds.famines = (civ.ruler.deeds.famines || 0) + 1;
}

function famineEnded(world, s) {
  const dead = fin(s.flags.famineDeaths);
  if (dead < 400 || !rateOk(world, `famineEnd:${s.id}`, 12)) return;
  record(world, { cat: 'civ', imp: 1, key: 'famine.end', text: pick(world, [
    `The famine in ${s.name} ended at last, after it had claimed ${peopleCount(world, dead, 'lives')}.`,
    `Bread came back to ${s.name}; the hunger had taken ${peopleCount(world, dead, 'lives')} in ${s.famine} months.`,
  ]), s });
}

function tierReport(world, s, civ, tier) {
  const st = world.sys.civ;
  if (tier < 2) return;
  const tname = TIERS[tier].name.toLowerCase();
  if (tier <= 3) {
    if (rateOk(world, `tier:${s.civId}:${tier}`, tier === 3 ? 4 : 10)) {
      record(world, { cat: 'civ', imp: 1, key: `tier.${tier}`, text: pick(world, [`${s.name} grew into a ${tname}.`, `${s.name} had become a ${tname} of ${approx(s.population)} people.`]), s });
    }
    return;
  }
  const key = `firstTier${tier}`;
  const firstWorld = st && st.milestones[key] == null;
  if (firstWorld && st) st.milestones[key] = world.time.day;
  let text, imp;
  if (tier === 4) {
    imp = firstWorld ? 3 : 2;
    text = firstWorld
      ? `${s.name} of ${theName(civ)} became the first true city in the world, home to ${peopleCount(world, s.population)}.`
      : pick(world, [
        `${s.name}, swollen with artisans and traders, grew into a city of ${approx(s.population)}.`,
        `${s.name} became a city, the pride of ${peopleOf(civ)}.`,
        `With ${approx(s.population)} people within its walls, ${s.name} became a city.`,
      ]);
  } else if (tier === 5) {
    imp = firstWorld ? 5 : 3;
    text = firstWorld
      ? `${s.name} became the greatest city the world had yet known, a teeming capital of ${peopleCount(world, s.population)}.`
      : pick(world, [
        `${s.name} grew into a great city of ${approx(s.population)} souls, the jewel of ${theName(civ)}.`,
        `${s.name} became one of the great cities of the age.`,
      ]);
  } else {
    imp = firstWorld ? 5 : 3;
    text = firstWorld
      ? `${s.name} became the world's first metropolis, a sprawl of ${peopleCount(world, s.population)}.`
      : `With ${approx(s.population)} people, ${s.name} of ${theName(civ)} became a metropolis.`;
  }
  record(world, { cat: 'civ', imp, key: firstWorld ? `tier.${tier}.first` : `tier.${tier}`, text, s });
}

/** Abandon a settlement (people dead or gone). */
export function abandon(world, s, civ, why = 'dwindled') {
  if (!s.alive) return;
  const big = fin(s.peakPopulation) >= 2000;
  if (s.famine > 0) famineHook(world, s);
  const text = why === 'famine'
    ? `Famine emptied ${s.name}; its last people abandoned the ${big ? 'ruined streets' : 'huts'} and the place fell silent.`
    : big ? pick(world, [`${s.name}, once home to ${approx(s.peakPopulation)}, was abandoned and fell into ruin.`, `The streets of ${s.name}, where ${approx(s.peakPopulation)} had once lived, were left to the weeds.`])
      : pick(world, [`${s.name} was abandoned.`, `The last families left ${s.name}, and it was abandoned.`]);
  if (rateOk(world, `abandon:${s.civId}`, big ? 0 : 5)) record(world, { cat: 'civ', imp: big ? 2 : 1, key: why === 'famine' ? 'settlement.abandoned.famine' : 'settlement.abandoned', text, s });
  destroySettlement(world, s.id, 'abandoned');
}

export { allowedLevel, hasTech };
