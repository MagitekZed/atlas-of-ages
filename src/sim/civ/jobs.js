// Occupations: what a town's working hands do (docs/design/people-in-numbers.md, phase 2).
//
//   s.jobs   11 numbers, workers per trade in the order of TRADES, hundredths. Σ = the town's
//            working hands (core/cohorts.js workersIn). null until the town's first monthly pass.
//
// Each month, after the land scan (settlement.js), updateJobs works out the demand for each
// trade from what the town already knows, then moves the trades toward it:
//   - the food trades from need: farmers for the fields' labour; herders, hunters and fishers
//     are the full-time hands of the foraging that everyone not farming does part-time (the
//     food it brings in over 0.75 of a forager's best month, as settlement.js counts them);
//   - soldiers are the garrison; miners follow the mine and the ore and strategic deposits;
//   - the hands left over are split by the realm's era (the "where people work" rule), bent by
//     what the town has: temples and the realm's faith (clergy), libraries, universities and
//     observatories (scholars), markets, banks and a harbour (merchants), factories
//     (craftsmen), a building under way (builders); labourers take the rest, never under 15 %.
// The trades that take learning (miners, craftsmen, merchants, clergy, scholars, builders) move
// 8 % of the way toward their demand a month, so a loss or a new building shows for a year or
// two. Labourers fill the gap at once, and fields short of farmers take labourers straight away:
// a harvest goes short only when there are no hands left. The foragers and soldiers follow
// their need each month.
//
// Readers hold production and commerce at today's levels for a town whose trades stand at
// their demand without the buildings' bends (X.jobProd, X.jobTrade: actual over that), so what
// moves them is a lag, a loss, or a town that has built for a trade. The realm's research reads
// the scholars the same way (s.flags.sch, ±10 %, civmonth.js).
//
// The rule is a society's to vary: the ext point 'jobRule' (key 'mix', civ, era) may answer a
// 6-number split of the leftover hands (craftsmen, merchants, clergy, scholars, builders,
// labourers). In a Mythic world the ext point 'magicJobs' adds four rare trades after the
// eleven (mages, healers, artificers, beast-keepers: shares of the working hands, out of the
// labourers), so s.jobs has 15 numbers there; the myth module reads them. Pure arithmetic: no
// world.rng.

import { firstOf, hasProviders } from '../../core/ext.js';
import { fin } from './state.js';

export const TRADES = ['farmers', 'herders', 'fishers', 'miners', 'craftsmen', 'merchants', 'soldiers', 'clergy', 'scholars', 'builders', 'labourers'];
export const J = { farm: 0, herd: 1, fish: 2, mine: 3, craft: 4, merch: 5, soldier: 6, clergy: 7, scholar: 8, build: 9, labour: 10 };
export const NJ = 11;
/** The magical trades' slots, after the eleven (Mythic towns only; ext 'magicJobs'). */
export const NMAGIC = 4, J_MAGIC = NJ;
/** Labels for display. */
export const TRADE_LABELS = ['Farmers', 'Herders and hunters', 'Fishers', 'Miners and quarrymen', 'Craftsmen', 'Merchants', 'Soldiers', 'Clergy', 'Scholars and scribes', 'Builders', 'Labourers',
  'Mages', 'Healers', 'Artificers', 'Beast-keepers'];

/** The leftover hands by era: craftsmen, merchants, clergy, scholars, builders, labourers (each row sums to 1). */
const ERA_MIX = [
  [0.20, 0.02, 0.05, 0.00, 0.08, 0.65],   // Stone
  [0.24, 0.05, 0.06, 0.01, 0.10, 0.54],   // Bronze
  [0.27, 0.07, 0.06, 0.01, 0.10, 0.49],   // Iron
  [0.28, 0.10, 0.06, 0.02, 0.11, 0.43],   // Classical
  [0.30, 0.11, 0.07, 0.02, 0.10, 0.40],   // Medieval
  [0.32, 0.14, 0.05, 0.04, 0.10, 0.35],   // Renaissance
  [0.40, 0.14, 0.03, 0.05, 0.10, 0.28],   // Industrial
  [0.38, 0.18, 0.02, 0.08, 0.09, 0.25],   // Modern
];
const FARM_WORKERS = 250;      // hands per fully farmed tile, before better tools
const GATHER_K = 2.4;          // as settlement.js: most food a forager brings in a month
const INERTIA = 0.08;          // share of the gap each trade closes a month
const LABOUR_FLOOR = 0.15;     // labourers never fall below this share of the leftover hands
const PROD_W = { craft: 1, build: 0.6, labour: 0.3 };   // production per worker, relative

/** The realm's split of the leftover hands for its era (the 'jobRule' answer, else ERA_MIX). */
function mixOf(world, civ, era) {
  if (hasProviders('jobRule')) {
    const v = firstOf('jobRule', world, 'mix', civ, era);
    if (v != null && v.length === 6) return v;
  }
  return ERA_MIX[era < 0 ? 0 : era > 7 ? 7 : era];
}

const D = new Float64Array(NJ + NMAGIC);   // demand, scratch

/**
 * One month of a town's trades (settlement.js, after seasonAndLand: reads X.workers, X.farmLoad,
 * X.wildPot, X.fishPot, X.ore, X.strat, X.mods, X.era, the building vector). Sets s.jobs, X.fw,
 * and the readers' ratios X.jobProd, X.jobTrade, X.jobMine and s.flags.sch.
 */
export function updateJobs(world, s, civ, X, bv, bo, BV) {
  const mods = X.mods, era = X.era;
  const W = X.workers;   // the town's working hands (core/cohorts.js, counted by the reconcile)
  // the food trades
  const fw = FARM_WORKERS / Math.pow(Math.max(0.2, mods.production), 0.7);
  X.fw = fw;
  const farm = Math.min(0.95 * W, X.farmLoad * fw);
  const wild = X.wildPot * X.wildSeason, fish = X.fishPot;
  const gPot = X.wildPot + X.fishPot, spare = Math.max(0, W - farm);
  const gather = gPot > 0 ? Math.min(spare, gPot * (1 - Math.exp(-spare * GATHER_K / gPot)) / (GATHER_K * 0.75)) : 0;
  const wf = wild + fish > 0 ? wild / (wild + fish) : 1;
  let left = Math.max(0, W - farm - gather);
  const soldiers = Math.min(fin(s.garrison), 0.3 * W, left);
  left -= soldiers;
  const ml = bv[bo + BV.mine];
  const miners = Math.min(left, W * Math.min(0.08, 0.004 * ml + 0.005 * X.ore * (1 + ml) + 0.01 * X.strat));
  left -= miners;
  // the leftover hands by era, bent by what the town has
  const mix = mixOf(world, civ, era);
  const relig = civ && civ.traits ? fin(civ.traits.religiosity, 0.5) : 0.5;
  const bCraft = 1 + 0.3 * bv[bo + BV.factory];
  const bMerch = 1 + 0.3 * bv[bo + BV.market] + 0.25 * bv[bo + BV.bank] + (bv[bo + BV.harbor] > 0 ? 0.2 : 0);
  const bClergy = (1 + 0.3 * bv[bo + BV.temple]) * (0.6 + 0.8 * relig);
  const bSchol = 1 + 0.4 * (bv[bo + BV.library] + bv[bo + BV.university] + bv[bo + BV.observatory]);
  const bBuild = s.project ? 2 : 1;
  let craft = mix[0] * bCraft, merch = mix[1] * bMerch, clergy = mix[2] * bClergy, schol = mix[3] * bSchol, build = mix[4] * bBuild;
  const named = craft + merch + clergy + schol + build;
  const k = named > 1 - LABOUR_FLOOR ? (1 - LABOUR_FLOOR) / named : 1;
  craft *= k * left; merch *= k * left; clergy *= k * left; schol *= k * left; build *= k * left;
  D[J.farm] = farm; D[J.herd] = gather * wf; D[J.fish] = gather * (1 - wf); D[J.mine] = miners;
  D[J.craft] = craft; D[J.merch] = merch; D[J.soldier] = soldiers; D[J.clergy] = clergy; D[J.scholar] = schol; D[J.build] = build;
  // the magical trades (Mythic): a few of the leftover hands, out of the labourers
  const magic = hasProviders('magicJobs') ? firstOf('magicJobs', world, s, civ) : null;
  const nj = magic ? NJ + NMAGIC : NJ;
  if (magic) {
    const room = Math.max(0, left - craft - merch - clergy - schol - build);
    let mt = 0;
    for (let i = 0; i < NMAGIC; i++) mt += Math.max(0, fin(magic[i])) * W;
    const f = mt > room && mt > 0 ? room / mt : 1;
    for (let i = 0; i < NMAGIC; i++) D[J_MAGIC + i] = Math.max(0, fin(magic[i])) * W * f;
  }

  // move toward the demand (last month's trades first scaled to this month's hands)
  let jobs = s.jobs;
  if (jobs === null || jobs === undefined || jobs.length !== nj) {
    jobs = s.jobs = Array.from({ length: nj }, () => 0);
    for (let t = 0; t < nj; t++) if (t !== J.labour) jobs[t] = D[t];
  } else {
    let prev = 0;
    for (let t = 0; t < nj; t++) prev += jobs[t];
    const sc = prev > 0 ? W / prev : 0;
    for (let t = 0; t < nj; t++) { if (t === J.labour) continue; const v = jobs[t] * sc; jobs[t] = v + (D[t] - v) * INERTIA; }
    // the foragers and the garrison are what they are this month (part-time foraging, the
    // soldiers on the rolls); only the trades that take learning lag
    jobs[J.herd] = D[J.herd]; jobs[J.fish] = D[J.fish]; jobs[J.soldier] = D[J.soldier];
  }
  let named2 = 0;
  for (let t = 0; t < nj; t++) if (t !== J.labour) named2 += jobs[t];
  if (named2 > W) { const f = named2 > 0 ? W / named2 : 0; for (let t = 0; t < nj; t++) if (t !== J.labour) jobs[t] *= f; named2 = W; }
  let lab = W - named2;
  // fields short of hands take labourers at once (anyone can follow a plough); the fields go
  // short only when there are none left
  if (jobs[J.farm] < D[J.farm] && lab > 0) { const mv = Math.min(D[J.farm] - jobs[J.farm], lab); jobs[J.farm] += mv; lab -= mv; }
  jobs[J.labour] = lab;
  for (let t = 0; t < nj; t++) { const v = jobs[t]; jobs[t] = v > 0 ? (v < 2e7 ? ((v * 100 + 0.5) | 0) / 100 : Math.round(v * 100) / 100) : 0; }

  // the readers: actual over the demand without the buildings' bends
  const base = left;   // the leftover hands an unbuilt town of this era would split
  const kb = mix[0] + mix[1] + mix[2] + mix[3] + mix[4] > 1 - LABOUR_FLOOR ? (1 - LABOUR_FLOOR) / (mix[0] + mix[1] + mix[2] + mix[3] + mix[4]) : 1;
  const pExp = (PROD_W.craft * mix[0] + PROD_W.build * mix[4]) * kb * base + PROD_W.labour * (1 - (mix[0] + mix[1] + mix[2] + mix[3] + mix[4]) * kb) * base;
  const pAct = PROD_W.craft * jobs[J.craft] + PROD_W.build * jobs[J.build] + PROD_W.labour * jobs[J.labour];
  X.jobProd = ratio(pAct, pExp);
  X.jobTrade = ratio(jobs[J.merch], mix[1] * kb * base);
  X.jobMine = miners > 0 ? Math.min(1, jobs[J.mine] / miners) : 1;
  s.flags.sch = Math.round(ratio(jobs[J.scholar], mix[3] * kb * base) * 1000) / 1000;
}
const ratio = (a, b) => (b > 1e-9 ? Math.min(3, Math.max(0.25, a / b)) : 1);

/** A town's workers in a trade (0 before its first pass). */
export const jobsIn = (s, t) => (s.jobs && s.jobs.length > t ? s.jobs[t] : 0);
