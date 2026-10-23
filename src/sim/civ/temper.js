// Temperament drift (docs/design/temperament-and-names.md §1): a people's eight traits (civ.traits,
// 0–1: aggression, expansion, religiosity, commerce, innovation, tolerance, militarism,
// isolation) are no longer fixed at birth. Once a year each people takes stock of what it lived
// through and its temperament moves a little, in Historical and Mythic worlds alike.
//
// State (plain JSON, saved; ensureTemper fills it for older saves):
//   civ.flags.temper0     the temperament the people was born with (the reversion baseline)
//   civ.flags.temperHist  every 25 years a sample of all eight traits, [[year, [8 ints 0–100]]]
//                         (at most 40: past that the older half is thinned by halving)
//   civ.temperLog         the last 24 notable shifts [{ day, trait, from, to, cause, seq? }]
//                         (seq: the chronicle entry that told it, when one did)
//   civ.flags.tacc        this year's tallies (reset at the yearly tick): months counted, months
//                         at war, Σ war weariness, battles won / lost, towns taken / lost, own towns
//                         razed, war dead, plague and famine dead, wonders, discoveries, foundings,
//                         wars won / lost, the foes fought ({ civId: n })
//   civ.flags.twhy        { trait: { cause: contribution } } decayed ×0.96 a year: why it moved
//   civ.flags.tctx        { foe, faith, ruler, others } names the prose can cite
//   civ.flags.tlast       { trait: day } the last notable shift of each trait
//   civ.flags.tpeace      years in a row without a month of war;  tmet  peoples met last year
//   civ.flags.tmix        { race: share } the realm's other peoples last year, tmixN its towns (Mythic)
//   world.sys.civ.trecent days of the latest temper.shift entries (≤ 3 a decade world-wide)
//
// Model (yearly per civ at its own month, civ.id % 12; no rng except to word the chronicle):
//   delta = adapt × GAIN × Σ signals, then a soft wall near the bounds, a cap of ±0.03 a year, and
//   reversion toward temper0 at 1.5 % of the gap a year; traits stay in [0.05, 0.95].
//   adapt is the race's drift speed, RACES[race].adapt (myth/races.js, guarded import; 1 for
//   Historical peoples). Signals are of two kinds: impulses from the year's events (victories,
//   conquests, defeats, ruin, plague, famine, discoveries, wonders, new contacts, expulsions)
//   and pulls toward a target while a condition lasts (war, peace, trade, a golden or dark age,
//   the state faith and its tenets, a long reign, the era, the mix of peoples in the realm).
//   A pull never overshoots its target, which is what keeps the loops damped: trade raises
//   commerce only toward what that trade justifies, and victory raises aggression while
//   weariness, defeats and ruin pull it down, so war does not breed war without end.
// Chronicle: when a trait has moved ≥ 0.15 from its value 50 years earlier, or crosses into an
// extreme band, one imp-2 entry (key temper.shift, ref the civ) names the cause; per civ and
// trait once per 60 years, world-wide at most 3 a decade, peoples of 1,000 or more. A move with
// no recorded cause is the pull of old custom when it heads back toward temper0 (told as such),
// otherwise it is only logged ('time').
//
// Published (pure): TEMPER_TRAITS, TEMPER_LABELS, TEMPER_BANDS, TEMPER_CAUSES, temperBand, temperBands,
// temperWords, temperShifts. Runtime: ensureTemper, temperMonthly, temperYearly (civmonth.js).

import { on } from '../../core/hooks.js';
import { DAYS_PER_YEAR, RACE_META } from '../../core/constants.js';
import { fin, record } from './state.js';
import { peopleOf, PeopleOf, rulerName, listJoin, pick } from './prose.js';

// the race table (drift speed, kinship) of a Mythic world; absent: every people drifts at 1
let races = null;
try { races = await import('../myth/races.js'); } catch (e) { /* myth module absent: adapt 1 */ }

/** The eight traits, in the kernel's order (core/entities.js TRAIT_KEYS). */
export const TEMPER_TRAITS = ['aggression', 'expansion', 'religiosity', 'commerce', 'innovation', 'tolerance', 'militarism', 'isolation'];
const NT = TEMPER_TRAITS.length;
const TI = Object.fromEntries(TEMPER_TRAITS.map((k, n) => [k, n]));

/** Band edges: below 0.2, 0.2–0.38, 0.38–0.62, 0.62–0.8, from 0.8. */
export const TEMPER_BANDS = [0.2, 0.38, 0.62, 0.8];

/**
 * The human words for each trait and band (index 0 lowest … 4 highest; 2 is the middle).
 * name: the trait as a noun; low / high: the poles in plain words (for tooltips).
 */
export const TEMPER_LABELS = {
  aggression: { name: 'Aggression', low: 'peaceable', high: 'warlike', bands: ['peaceable', 'mild', 'even-tempered', 'combative', 'warlike'] },
  expansion: { name: 'Expansion', low: 'home-loving', high: 'expansionist', bands: ['home-loving', 'settled', 'steady', 'restless', 'expansionist'] },
  religiosity: { name: 'Religiosity', low: 'worldly', high: 'zealous', bands: ['worldly', 'sceptical', 'observant', 'devout', 'zealous'] },
  commerce: { name: 'Commerce', low: 'self-sufficient', high: 'mercantile', bands: ['self-sufficient', 'frugal', 'trading', 'enterprising', 'mercantile'] },
  innovation: { name: 'Innovation', low: 'hidebound', high: 'ingenious', bands: ['hidebound', 'traditional', 'practical', 'inventive', 'ingenious'] },
  tolerance: { name: 'Tolerance', low: 'xenophobic', high: 'cosmopolitan', bands: ['xenophobic', 'suspicious', 'guarded', 'tolerant', 'cosmopolitan'] },
  militarism: { name: 'Militarism', low: 'unsoldierly', high: 'militaristic', bands: ['unsoldierly', 'lightly armed', 'vigilant', 'martial', 'militaristic'] },
  isolation: { name: 'Isolation', low: 'outward-looking', high: 'reclusive', bands: ['outward-looking', 'open', 'self-reliant', 'insular', 'reclusive'] },
};

/** Short human words for the cause keys of civ.temperLog (for lists: "warlike — conquest, Y412"). */
export const TEMPER_CAUSES = {
  war: 'years of war', conquest: 'conquest', victory: 'victories', defeat: 'defeats', ruin: 'ruinous war', weariness: 'war-weariness',
  peace: 'long peace', trade: 'trade', contact: 'new contacts', solitude: 'solitude', autarky: 'no trade', plague: 'plague',
  famine: 'famine', golden: 'a golden age', dark: 'a dark age', wonder: 'great works', discovery: 'discoveries', faith: 'the state faith',
  ruler: 'a long reign', reason: 'the new learning', industry: 'industry', colonies: 'new settlements', overreach: 'overreach',
  mixing: 'mingling of peoples', enmity: 'old enmities', expulsion: 'expulsions', custom: 'old custom', time: 'the years',
};

const LO = 0.05, HI = 0.95;          // hard bounds
const BIRTH_LO = 0.08, BIRTH_HI = 0.92; // a newborn people is never pinned at a bound
const CAP = 0.03;                    // most a trait moves in a year
const LINEAGE = 0.75;                // share of a parent's drift a splinter people does not inherit
const GAIN = 1.6;                    // overall strength of the year's signals (before adapt)
const REVERT = 0.015;                // share of the gap to temper0 closed each year
const WALL = 0.12;                   // drift slows within this distance of a bound
const WHY_DECAY = 0.96;
const HIST_EVERY = 25, HIST_MAX = 40, LOG_MAX = 24;
const SHIFT_MIN = 0.15, SHIFT_YEARS = 50, TRAIT_GAP = 60, WORLD_N = 3, WORLD_YEARS = 10, TELL_POP = 1000;

const clampT = (v) => (v < LO ? LO : v > HI ? HI : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const yearNow = (world) => Math.floor(world.time.day / DAYS_PER_YEAR);

// ---------------------------------------------------------------------------
// Published helpers (pure)

/** Band index 0..4 of a trait value (TEMPER_BANDS). */
export function temperBand(v) {
  const x = fin(v, 0.5);
  let b = 0;
  while (b < TEMPER_BANDS.length && x >= TEMPER_BANDS[b]) b++;
  return b;
}

/** { trait: 'band label' } for a traits object, e.g. aggression 0.8 → 'warlike', 0.2 → 'mild'. */
export function temperBands(traits) {
  const out = {};
  for (const k of TEMPER_TRAITS) out[k] = TEMPER_LABELS[k].bands[temperBand(traits?.[k])];
  return out;
}

/**
 * The n strongest band words of a people ("warlike · pious" in hover cards): the traits furthest
 * from the middle, outer bands only, strongest first. Returns [] when every trait is middling.
 */
export function temperWords(civ, n = 2) {
  const t = civ?.traits;
  if (!t) return [];
  const list = [];
  for (const k of TEMPER_TRAITS) {
    const b = temperBand(t[k]);
    if (b !== 2) list.push([Math.abs(fin(t[k], 0.5) - 0.5), TEMPER_LABELS[k].bands[b]]);
  }
  list.sort((a, b) => b[0] - a[0]);
  return list.slice(0, n).map((x) => x[1]);
}

/**
 * Everything the UI needs about a people's temperament, or null for a people without one:
 * { traits, temper0, bands, moved: { trait: now − birth }, log (oldest first, copies),
 *   hist: [[year, [8 ints]]] (copies), recent: { trait: change over the last 25 years } }.
 */
export function temperShifts(world, civ) {
  if (!civ || !civ.traits) return null;
  const fl = civ.flags || {};
  const t0 = fl.temper0 || civ.traits;
  const traits = {}, temper0 = {}, moved = {}, recent = {};
  const hist = Array.isArray(fl.temperHist) ? fl.temperHist.map((h) => [h[0], h[1].slice()]) : [];
  const last = hist.length ? hist[hist.length - 1] : null;
  const back = hist.length >= 2 ? hist[hist.length - 2] : null;
  for (let k = 0; k < NT; k++) {
    const key = TEMPER_TRAITS[k];
    traits[key] = fin(civ.traits[key], 0.5);
    temper0[key] = fin(t0[key], traits[key]);
    moved[key] = Math.round((traits[key] - temper0[key]) * 1000) / 1000;
    recent[key] = last && back ? (last[1][k] - back[1][k]) / 100 : 0;
  }
  const log = Array.isArray(civ.temperLog) ? civ.temperLog.map((e) => ({ ...e })) : [];
  return { traits, temper0, bands: temperBands(traits), moved, log, hist, recent };
}

// ---------------------------------------------------------------------------
// State

function newAcc() {
  return { m: 0, wm: 0, wy: 0, bw: 0, bl: 0, tk: 0, tl: 0, rz: 0, dead: 0, pl: 0, fa: 0, wo: 0, tc: 0, nf: 0, vw: 0, vl: 0, foes: {} };
}

/**
 * Fill a living people's temperament state (idempotent; birth, older saves). A fallen realm is
 * a closed record whose working fields index.js sheds; nothing here may recreate them.
 */
export function ensureTemper(world, civ) {
  if (!civ || !civ.traits || civ.alive === false) return;
  const fl = civ.flags || (civ.flags = {});
  if (!fl.temper0 || typeof fl.temper0 !== 'object') {
    const born = fin(civ.foundedDay, world.time.day) >= world.time.day - 1;
    // a people breaking away from its own kin keeps the ancestral temperament and a quarter of
    // what its parent became (the kernel drew it around the parent's present traits), so drift
    // does not compound down a line of splinter realms and a world keeps its range of peoples
    const par = born && civ.parentId != null ? world.civs[civ.parentId] : null;
    const kin = par && par.flags?.temper0 && par.traits && (par.race ?? null) === (civ.race ?? null) ? par : null;
    const t0 = {};
    for (const k of TEMPER_TRAITS) {
      let v = fin(civ.traits[k], 0.5);
      if (kin) v -= LINEAGE * (fin(kin.traits[k], 0.5) - fin(kin.flags.temper0[k], fin(kin.traits[k], 0.5)));
      v = born ? (v < BIRTH_LO ? BIRTH_LO : v > BIRTH_HI ? BIRTH_HI : v) : clampT(v);
      civ.traits[k] = r4(v);
      t0[k] = civ.traits[k];
    }
    fl.temper0 = t0;
  }
  if (!Array.isArray(civ.temperLog)) civ.temperLog = [];
  if (!Array.isArray(fl.temperHist)) fl.temperHist = [];
  if (!fl.temperHist.length) sampleHist(world, civ, true);
  if (!fl.tacc || typeof fl.tacc !== 'object') fl.tacc = newAcc();
  if (!fl.twhy || typeof fl.twhy !== 'object') fl.twhy = {};
  if (!fl.tctx || typeof fl.tctx !== 'object') fl.tctx = {};
  if (!fl.tlast || typeof fl.tlast !== 'object') fl.tlast = {};
  if (!Number.isFinite(fl.tpeace)) fl.tpeace = 0;
  if (!Number.isFinite(fl.tmet)) fl.tmet = countMet(world, civ);
}

function sampleHist(world, civ, force = false) {
  const fl = civ.flags;
  const h = fl.temperHist;
  const y = yearNow(world);
  if (!force && h.length && y - h[h.length - 1][0] < HIST_EVERY) return;
  h.push([y, TEMPER_TRAITS.map((k) => Math.round(100 * fin(civ.traits[k], 0.5)))]);
  if (h.length > HIST_MAX) {
    // thin the older half by halving: keep its every other sample, the recent half whole
    const half = h.length >> 1;
    fl.temperHist = h.filter((_, k) => k >= half || k % 2 === 0);
  }
}

/** The value of each trait about 50 years ago (the latest sample at least that old), or null. */
function refSample(civ, y) {
  const h = civ.flags.temperHist;
  for (let k = h.length - 1; k >= 0; k--) if (y - h[k][0] >= SHIFT_YEARS) return h[k];
  return null;
}

function countMet(world, civ) {
  let n = 0;
  for (const k in civ.relations || {}) { const o = world.civs[k]; if (o && o.alive && o.id !== civ.id) n++; }
  return n;
}

const accOf = (world, id) => {
  const c = id != null && id >= 0 ? world.civs[id] : null;
  if (!c || !c.alive || !c.flags) return null;
  return c.flags.tacc || (c.flags.tacc = newAcc());
};
const noteFoe = (a, id) => { if (a && id != null && id >= 0) a.foes[id] = (a.foes[id] || 0) + 1; };

// ---------------------------------------------------------------------------
// Tallies from the year's events (hooks; plain counters on the civ, saved with it)

on('battle', (world, b) => {
  if (!world.sys.civ || !b) return;
  const w = accOf(world, b.winnerCivId), l = accOf(world, b.loserCivId);
  if (w) { w.bw++; noteFoe(w, b.loserCivId); }
  if (l) { l.bl++; noteFoe(l, b.winnerCivId); }
  const a = accOf(world, b.attackerId), d = accOf(world, b.defenderId);
  if (a) a.dead += Math.max(0, fin(b.dead?.a));
  if (d) d.dead += Math.max(0, fin(b.dead?.d));
});

const TAKEN = { conquest: 1, treaty: 1, reconquest: 0.5 };
on('settlementTransferred', (world, s, oldId, newId, cause) => {
  if (!world.sys.civ) return;
  const w = TAKEN[cause];
  if (!w) return;
  const n = accOf(world, newId), o = accOf(world, oldId);
  if (n) { n.tk += w; noteFoe(n, oldId); }
  if (o) { o.tl += w; noteFoe(o, newId); }
});

on('settlementDestroyed', (world, s, cause) => {
  if (!world.sys.civ || !s || (cause !== 'razed' && cause !== 'sack')) return;
  const a = accOf(world, s.civId);
  if (a) a.rz++;
});

on('settlementCreated', (world, s) => {
  if (!world.sys.civ || !s) return;
  const civ = world.civs[s.civId];
  if (!civ || !civ.alive || world.time.day - fin(civ.foundedDay, 0) < DAYS_PER_YEAR) return;
  const a = accOf(world, civ.id);
  if (a) a.nf++;
});

on('plagueDeaths', (world, p) => {
  if (!world.sys.civ || !p) return;
  const s = world.settlements[p.sid];
  const a = s ? accOf(world, s.civId) : null;
  if (a) a.pl += Math.max(0, fin(p.deaths));
});

on('famine', (world, p) => {
  if (!world.sys.civ || !p) return;
  const s = world.settlements[p.sid];
  const a = s ? accOf(world, s.civId) : null;
  if (a) a.fa += Math.max(0, fin(p.deaths));
});

on('wonderBuilt', (world, w) => {
  if (!world.sys.civ || !w) return;
  const a = accOf(world, w.civId);
  if (a) a.wo++;
});

on('techDiscovered', (world, civ, id, how, first) => {
  if (!world.sys.civ || !civ || how === 'grant') return;
  const a = accOf(world, civ.id);
  if (a) a.tc += first ? 2 : how === 'diffusion' ? 0.5 : 1;
});

on('warEnded', (world, war) => {
  if (!world.sys.civ || !war) return;
  const out = war.outcome;
  if (out !== 'attackers' && out !== 'defenders') return;
  const [win, lose] = out === 'attackers' ? [war.attackers, war.defenders] : [war.defenders, war.attackers];
  for (const id of win || []) { const a = accOf(world, id); if (a) a.vw++; }
  for (const id of lose || []) { const a = accOf(world, id); if (a) a.vl++; }
});

// ---------------------------------------------------------------------------
// The yearly model

/** Monthly bookkeeping for the yearly tick (civmonth.js). agg: the month's aggregate. */
export function temperMonthly(world, civ, agg) {
  const a = civ.flags.tacc || (civ.flags.tacc = newAcc());
  a.m++;
  if (agg.atWar) a.wm++;
  a.wy += clamp01(fin(civ.warWeariness));
}

// ruler traits: [trait, strength share, target]. Up pulls aim at 0.85 and down pulls at 0.15, and
// the weights are balanced so that over the usual mix of ruler traits (RULER_TRAITS w) each trait
// is pushed up about as often as down: a long reign marks a people, but rulers as a whole do not
// tilt every people the same way.
const UP = 0.85, DN = 0.15;
const RULER_PULL = {
  warlike: [['aggression', 1, UP], ['militarism', 1, UP], ['expansion', 0.3, UP], ['commerce', 0.3, DN]],
  cruel: [['tolerance', 1, DN], ['aggression', 0.5, UP], ['militarism', 0.3, UP], ['innovation', 0.2, DN]],
  just: [['tolerance', 0.7, UP], ['aggression', 0.3, DN], ['religiosity', 0.2, UP]],
  generous: [['tolerance', 0.5, UP], ['aggression', 0.3, DN], ['militarism', 0.3, DN], ['isolation', 0.3, DN]],
  pious: [['religiosity', 1, UP], ['innovation', 0.3, DN], ['expansion', 0.2, DN]],
  scholarly: [['innovation', 0.8, UP], ['religiosity', 0.4, DN], ['militarism', 0.3, DN]],
  brilliant: [['innovation', 0.8, UP], ['commerce', 0.3, UP], ['religiosity', 0.5, DN], ['isolation', 0.3, DN]],
  wise: [['innovation', 0.4, UP], ['aggression', 0.5, DN], ['militarism', 0.3, DN], ['expansion', 0.3, DN]],
  greedy: [['commerce', 0.7, UP], ['tolerance', 0.3, DN], ['religiosity', 0.4, DN], ['isolation', 0.2, DN]],
  craven: [['militarism', 1, DN], ['aggression', 0.6, DN], ['expansion', 0.4, DN], ['isolation', 0.3, UP]],
  cautious: [['isolation', 0.6, UP], ['aggression', 0.5, DN], ['expansion', 0.5, DN], ['commerce', 0.2, DN], ['innovation', 0.3, DN]],
  paranoid: [['isolation', 1, UP], ['tolerance', 0.6, DN], ['militarism', 0.3, UP], ['commerce', 0.3, DN], ['innovation', 0.3, DN], ['expansion', 0.3, DN]],
  ambitious: [['expansion', 1, UP], ['aggression', 0.3, UP], ['militarism', 0.3, UP], ['isolation', 0.3, DN], ['religiosity', 0.3, DN]],
  industrious: [['commerce', 0.5, UP], ['innovation', 0.4, UP]],
  lazy: [['innovation', 0.6, DN], ['militarism', 0.5, DN], ['expansion', 0.5, DN], ['religiosity', 0.3, DN], ['commerce', 0.3, DN]],
  charismatic: [['expansion', 0.4, UP], ['tolerance', 0.3, UP], ['isolation', 0.4, DN]],
  mad: [['aggression', 0.3, UP], ['religiosity', 0.3, UP], ['tolerance', 0.3, DN]],
  foolish: [['innovation', 0.8, DN]],
};
// state-faith tenets: [trait, strength share, target]
const TENET_PULL = {
  militant: [['aggression', 1, 0.75], ['militarism', 1, 0.75], ['tolerance', 0.7, 0.3]],
  pacifist: [['aggression', 1, 0.2], ['militarism', 0.8, 0.25]],
  tolerant: [['tolerance', 1, 0.8]],
  mercantile: [['commerce', 1, 0.75]],
  ascetic: [['commerce', 0.7, 0.3]],
  proselytizing: [['expansion', 0.6, 0.7]],
  monastic: [['isolation', 0.6, 0.7], ['innovation', 0.4, 0.65]],
  mystic: [['religiosity', 0.5, 0.85]],
  hierarchical: [['religiosity', 0.5, 0.85]],
  apocalyptic: [['religiosity', 0.6, 0.85], ['tolerance', 0.6, 0.3]],
  healing: [['tolerance', 0.5, 0.7]],
  ancestral: [['isolation', 0.5, 0.65]],
};

/** The race's drift speed (RACES[race].adapt; 1 for Historical peoples or when absent). */
function adaptOf(civ) {
  const v = civ.race && races?.RACES ? races.RACES[civ.race]?.adapt : null;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(4, v) : 1;
}

/**
 * Test switch (like core/keyframe.js KEYFRAME_DEV): frozen = true makes the yearly tick a no-op
 * but for its bookkeeping, so a tool can compare a world with and without drift. Never set by
 * the simulation itself.
 */
export const TEMPER_DEV = { frozen: false };

/** One people, one year: read the signals, move the traits, sample, tell notable shifts. */
export function temperYearly(world, civ, agg) {
  ensureTemper(world, civ);
  const fl = civ.flags;
  if (TEMPER_DEV.frozen) { fl.tacc = newAcc(); return; }
  const a = fl.tacc;
  const tr = civ.traits, t0 = fl.temper0;
  const months = Math.max(1, a.m);
  const pop = Math.max(1, fin(agg.pop, fin(civ.population, 1)));
  const x = TEMPER_TRAITS.map((k) => fin(tr[k], 0.5));
  const dv = new Array(NT).fill(0);
  const why = {};                     // cause → [8 contributions] this year
  const add = (key, v, cause) => {
    if (!v) return;
    const k = TI[key];
    dv[k] += v;
    (why[cause] ||= new Array(NT).fill(0))[k] += v;
  };
  // a pull toward target with strength s (dir +1 only up, −1 only down, 0 both ways)
  const pull = (key, s, target, cause, dir = 0) => {
    if (!(s > 0)) return;
    const g = target - x[TI[key]];
    if ((dir > 0 && g <= 0) || (dir < 0 && g >= 0)) return;
    add(key, s * g, cause);
  };

  // --- war and peace
  const wm = clamp01(a.wm / months);
  const weary = clamp01(a.wy / months);
  const victory = clamp01((a.tk + 0.25 * a.bw + 0.8 * a.vw) / 3);
  const defeat = clamp01((a.tl + 0.25 * a.bl + 0.8 * a.vl) / 3);
  const ruin = clamp01(20 * a.dead / pop + 0.5 * a.rz);
  fl.tpeace = a.wm > 0 ? 0 : Math.min(500, fin(fl.tpeace) + 1);
  const peace = clamp01((fl.tpeace - 5) / 25);
  const won = a.tk >= 1 || a.vw > 0 ? 'conquest' : 'victory';
  add('aggression', 0.012 * victory * (1 - weary), won);
  add('aggression', -0.010 * defeat, 'defeat');
  add('aggression', -0.010 * ruin, 'ruin');
  add('aggression', -0.008 * weary * wm, 'weariness');
  pull('militarism', 0.006 * wm, 0.85, 'war', 1);
  add('militarism', 0.004 * victory, won);
  add('militarism', 0.004 * defeat * (1 - ruin), 'defeat');
  pull('militarism', 0.010 * peace, 0.2, 'peace', -1);
  add('isolation', 0.006 * weary * wm, 'weariness');
  add('isolation', 0.004 * defeat, 'defeat');
  add('isolation', 0.006 * ruin, 'ruin');
  add('expansion', 0.006 * victory, won);
  add('expansion', -0.004 * defeat, 'defeat');
  pull('tolerance', 0.006 * wm, 0.25, 'war', -1);
  pull('tolerance', 0.006 * peace, 0.65, 'peace', 1);
  // the foe of the year (most battles and towns), for the prose
  let foe = null, fn = 0;
  for (const k in a.foes) { if (a.foes[k] > fn || (a.foes[k] === fn && +k < foe)) { fn = a.foes[k]; foe = +k; } }
  if (foe != null && fn >= 2) fl.tctx.foe = foe;

  // --- trade and contact
  const towns = agg.ss || [];
  let trade = 0, base = 0;
  for (const s of towns) { trade += Math.max(0, fin(s.tradeIncome)); base += 0.012 * Math.pow(Math.max(1, fin(s.population)), 0.8); }
  // trade income against what the towns' own markets make: a median trading people has about
  // as much again (R ≈ 1.1), so R / (R + 1.2) puts it near 0.5
  const R = base > 0 ? trade / base : 0;
  const tradeS = R > 0 ? R / (R + 1.2) : 0;
  let partners = 0;
  for (const k in civ.relations || {}) { const r = civ.relations[k]; if (fin(r?.trade) > 0 && world.civs[k]?.alive) partners++; }
  const linked = Math.max(tradeS, clamp01(partners / 4));
  // trade sets the level of commerce it justifies (both ways: a people trading little loses
  // its merchant habits), warms the people to strangers and draws it out into the world
  pull('commerce', 0.02 * tradeS, 0.15 + 0.65 * tradeS, 'trade');
  pull('tolerance', 0.008 * tradeS, 0.65, 'trade', 1);
  pull('isolation', 0.008 * linked, 0.25, 'trade', -1);
  const met = countMet(world, civ);
  const fresh = clamp01((met - fin(fl.tmet, met)) / 2);
  fl.tmet = met;
  add('tolerance', 0.004 * fresh, 'contact');
  add('isolation', -0.006 * fresh, 'contact');
  add('innovation', 0.002 * fresh, 'contact');
  const age = (world.time.day - fin(civ.foundedDay, 0)) / DAYS_PER_YEAR;
  if (met === 0 && age >= 30) pull('isolation', 0.006, 0.75, 'solitude', 1);
  // a people of some learning that trades with no one grows self-sufficient
  if (tradeS < 0.05 && partners === 0 && fin(civ.tech?.era, 0) >= 2) pull('commerce', 0.004, 0.35, 'autarky', -1);

  // --- plague, famine, ages, works and learning
  const plague = clamp01(10 * a.pl / pop), famine = clamp01(15 * a.fa / pop);
  add('religiosity', 0.015 * plague, 'plague');
  add('tolerance', -0.005 * plague, 'plague');
  add('religiosity', 0.010 * famine, 'famine');
  add('expansion', 0.004 * famine, 'famine');
  if (fin(civ.goldenAge) > 0) {
    pull('innovation', 0.02, 0.85, 'golden', 1);
    pull('tolerance', 0.006, 0.65, 'golden', 1);
    pull('religiosity', 0.006, 0.45, 'golden', -1);     // plenty breeds worldliness
  }
  if (fin(civ.darkAge) > 0) {
    pull('innovation', 0.02, 0.2, 'dark', -1);
    pull('religiosity', 0.012, 0.75, 'dark', 1);
    pull('isolation', 0.01, 0.7, 'dark', 1);
  }
  add('innovation', 0.004 * Math.min(1, a.wo), 'wonder');
  add('innovation', 0.008 * clamp01(a.tc / 3), 'discovery');
  add('expansion', 0.003 * clamp01(a.nf / 2), 'colonies');
  pull('expansion', 0.012 * clamp01(fin(fl.overext)), 0.3, 'overreach', -1);

  // --- faith: zeal pulls piety up (a cooling faith lets it settle), tenets pull their traits
  const faith = civ.stateReligion != null ? world.religions[civ.stateReligion] : null;
  if (faith && faith.alive !== false) {
    const f = clamp01(fin(faith.fervor, 0.4));
    pull('religiosity', 0.012 * f, 0.2 + 0.7 * f, 'faith');    // fervour ~0.4 is neutral
    for (const t of Array.isArray(faith.tenets) ? faith.tenets : []) {
      for (const [key, w, target] of TENET_PULL[t] || []) pull(key, 0.014 * f * w, target, 'faith');
    }
    fl.tctx.faith = faith.id;
  }

  // --- the ruler: a long reign leaves the ruler's mark
  const r = civ.ruler;
  if (r && Array.isArray(r.traits) && r.traits.length) {
    const reign = (world.time.day - fin(r.reignStart, world.time.day)) / DAYS_PER_YEAR;
    const rf = clamp01((reign - 4) / 12);
    if (rf > 0) {
      let any = false;
      for (const t of r.traits) for (const [key, w, target] of RULER_PULL[t] || []) { pull(key, 0.009 * rf * w, target, 'ruler'); any = true; }
      if (any && reign >= 10) fl.tctx.ruler = rulerName(r);
    }
  }

  // --- the age: reason and industry cool the old piety
  const era = fin(civ.tech?.era, 0);
  if (era >= 5) {
    pull('religiosity', 0.004 * (era - 4), 0.3, 'reason', -1);
    pull('innovation', 0.006 * (era - 4), 0.75, 'reason', 1);
  }
  const ind = clamp01(fin(civ.mods?.industry, 0));
  if (ind > 0) pull('religiosity', 0.01 * ind, 0.25, 'industry', -1);

  // --- Mythic worlds: the other peoples of the realm (s.peoples, docs/design/mixed-peoples.md)
  mixSignals(world, civ, towns, agg, add, pull);

  // --- apply: adapt, soft walls, cap, reversion
  const adapt = adaptOf(civ);
  const prev = x.slice();
  for (let k = 0; k < NT; k++) {
    let d = dv[k] * GAIN * adapt;
    const room = d > 0 ? HI - x[k] : x[k] - LO;
    if (room < WALL) d *= Math.max(0, room / WALL);
    if (d > CAP) d = CAP; else if (d < -CAP) d = -CAP;
    d += REVERT * (fin(t0[TEMPER_TRAITS[k]], x[k]) - x[k]);
    x[k] = clampT(x[k] + d);
    tr[TEMPER_TRAITS[k]] = r4(x[k]);
  }
  // why each trait moved (decayed, small values dropped)
  const W = fl.twhy;
  for (const key of TEMPER_TRAITS) {
    const o = W[key];
    if (!o) continue;
    for (const c in o) { const v = o[c] * WHY_DECAY; if (Math.abs(v) < 2e-4) delete o[c]; else o[c] = Math.round(v * 1e5) / 1e5; }
  }
  for (const c in why) {
    const v = why[c];
    for (let k = 0; k < NT; k++) {
      if (!v[k]) continue;
      const o = (W[TEMPER_TRAITS[k]] ||= {});
      o[c] = Math.round((fin(o[c]) + v[k] * GAIN * adapt) * 1e5) / 1e5;
    }
  }
  sampleHist(world, civ);
  noteShifts(world, civ, prev, x);
  fl.tacc = newAcc();
}

/** Mixing with the other peoples of the realm (Mythic): kin soften, enemies harden. */
function mixSignals(world, civ, towns, agg, add, pull) {
  const own = civ.race;
  if (!own || !towns.length || !towns[0].peoples) return;
  const sum = {};
  let pop = 0;
  for (const s of towns) {
    const p = s.peoples;
    if (!p || typeof p !== 'object') continue;
    const n = Math.max(0, fin(s.population));
    pop += n;
    for (const r in p) sum[r] = (sum[r] || 0) + n * fin(p[r]);
  }
  if (!(pop > 0)) return;
  const fl = civ.flags;
  const before = fl.tmix || {};
  const mix = {};
  let other = 0, kin = 0;
  for (const r in sum) {
    if (r === own) continue;
    const sh = sum[r] / pop;
    if (sh < 0.01) continue;
    mix[r] = Math.round(sh * 1000) / 1000;
    other += sh;
    kin += sh * (races?.raceRel ? fin(races.raceRel(own, r)) : 0);
  }
  kin = other > 0 ? kin / other : 0;
  const calm = (1 - clamp01(fin(agg.avgUnrest))) * (agg.atWar ? 0.5 : 1);
  const m = clamp01(other);
  if (kin >= -5) {
    pull('tolerance', 0.03 * m * calm, 0.8, 'mixing', 1);
    pull('isolation', 0.02 * m * calm, 0.2, 'mixing', -1);
  } else pull('tolerance', 0.02 * m * clamp01(-kin / 25), 0.25, 'enmity', -1);
  // a minority that halved in a year while the realm kept its towns was driven out
  let expelled = false;
  if (towns.length >= fin(fl.tmixN, 0)) {
    for (const r in before) {
      const was = fin(before[r]), now = fin(mix[r]);
      if (was >= 0.03 && now < was * 0.65) expelled = true;
    }
  }
  if (expelled) { add('tolerance', -0.01, 'expulsion'); add('isolation', 0.005, 'expulsion'); }
  const top = Object.keys(mix).sort((p, q) => mix[q] - mix[p] || (p < q ? -1 : 1)).slice(0, 2);
  if (top.length) fl.tctx.others = top;
  fl.tmix = mix;
  fl.tmixN = towns.length;
}

// ---------------------------------------------------------------------------
// Notable shifts: the log and the chronicle

/**
 * The cause that moved a trait most in direction dir (decayed contributions). Without one the
 * move is the pull of the birth temperament ('custom') or, if away from it, unexplained ('time').
 */
function mainCause(civ, key, dir, x) {
  const o = civ.flags.twhy?.[key] || {};
  let best = null, bv = 0;
  for (const c in o) {
    const v = o[c] * dir;
    if (v > bv || (v === bv && best != null && c < best)) { bv = v; best = c; }
  }
  if (best) return best;
  const t0 = fin(civ.flags.temper0?.[key], x);
  return (t0 - x) * dir >= 0 ? 'custom' : 'time';
}

function noteShifts(world, civ, prev, x) {
  const fl = civ.flags;
  const day = world.time.day, y = yearNow(world);
  const ref = refSample(civ, y);
  for (let k = 0; k < NT; k++) {
    const key = TEMPER_TRAITS[k];
    const bNow = temperBand(x[k]), bPrev = temperBand(prev[k]);
    const extreme = (bNow === 4 || bNow === 0) && bNow !== bPrev;
    const from = ref ? ref[1][k] / 100 : null;
    const moved = from != null && Math.abs(x[k] - from) >= SHIFT_MIN;
    if (!extreme && !moved) continue;
    const last = fl.tlast[key];
    if (last != null && day - last < TRAIT_GAP * DAYS_PER_YEAR) continue;
    const base = moved ? from : prev[k];
    const dir = x[k] >= base ? 1 : -1;
    if (extreme && !moved && dir !== (bNow === 4 ? 1 : -1)) continue;
    fl.tlast[key] = day;
    const cause = mainCause(civ, key, dir, x[k]);
    const entry = { day, trait: key, from: Math.round(base * 100) / 100, to: Math.round(x[k] * 100) / 100, cause };
    const seq = tell(world, civ, key, dir, bNow, extreme, cause);
    if (seq != null) entry.seq = seq;
    civ.temperLog.push(entry);
    if (civ.temperLog.length > LOG_MAX) civ.temperLog.splice(0, civ.temperLog.length - LOG_MAX);
  }
}

/** Write the chronicle entry for a shift when the world-wide limit allows. Returns its seq. */
function tell(world, civ, key, dir, band, extreme, cause) {
  if (fin(civ.population) < TELL_POP || cause === 'time') return null;
  const st = world.sys.civ;
  const day = world.time.day;
  const recent = (Array.isArray(st.trecent) ? st.trecent : []).filter((d) => day - d < WORLD_YEARS * DAYS_PER_YEAR);
  if (recent.length >= WORLD_N) { st.trecent = recent; return null; }
  const text = shiftText(world, civ, key, dir, band, extreme, cause);
  recent.push(day);
  st.trecent = recent;
  const e = record(world, { cat: 'civ', imp: 2, key: 'temper.shift', civ, ref: { k: 'civ', id: civ.id }, tags: [key, cause, dir > 0 ? 'up' : 'down'], text });
  return e ? e.seq : null;
}

// ---------------------------------------------------------------------------
// Prose

const SPANS = ['Decades', 'Two generations', 'Half a century', 'Long years', 'A lifetime'];

// per trait and direction: verbs ("had hardened the Varathi"), the people they became (np) and
// comparatives ("had grown fiercer")
const TRAIT_PROSE = {
  aggression: {
    up: { verb: ['hardened', 'emboldened', 'inflamed'], np: ['a warlike people', 'a people quick to the sword', 'a nation of warriors'], cmp: ['fiercer', 'quicker to anger', 'more warlike'] },
    down: { verb: ['chastened', 'humbled', 'sobered'], np: ['a peaceable people', 'a people slow to anger', 'a people who wanted no more wars'], cmp: ['gentler', 'slower to anger', 'less warlike'] },
  },
  expansion: {
    up: { verb: ['stirred', 'unsettled', 'emboldened'], np: ['a restless people', 'a people of wanderers and settlers', 'a people forever looking past the frontier'], cmp: ['more restless', 'hungrier for new lands'] },
    down: { verb: ['tamed', 'sobered', 'chastened'], np: ['a home-loving people', 'a people content with their own fields'], cmp: ['more settled', 'less eager for new lands'] },
  },
  religiosity: {
    up: { verb: ['humbled', 'sobered', 'stirred'], np: ['a devout people', 'a people of temples and prayers', 'a zealous people'], cmp: ['more devout', 'quicker to pray'] },
    down: { verb: ['disenchanted', 'changed', 'emboldened'], np: ['a worldly people', 'a people who seldom troubled the gods'], cmp: ['more worldly', 'less devout'] },
  },
  commerce: {
    up: { verb: ['enriched', 'changed', 'schooled'], np: ['a nation of merchants', 'a mercantile people', 'a people who lived by trade'], cmp: ['more mercantile', 'keener on trade'] },
    down: { verb: ['impoverished', 'chastened', 'changed'], np: ['a self-sufficient people', 'a people who cared little for trade'], cmp: ['less mercantile', 'warier of merchants'] },
  },
  innovation: {
    up: { verb: ['quickened', 'awakened', 'inspired'], np: ['an inventive people', 'a people of tinkerers and scholars', 'an ingenious people'], cmp: ['more inventive', 'readier for new ideas'] },
    down: { verb: ['dulled', 'cowed', 'wearied'], np: ['a hidebound people', 'a people who distrusted anything new'], cmp: ['more set in their ways', 'warier of new ideas'] },
  },
  tolerance: {
    up: { verb: ['softened', 'broadened', 'mellowed'], np: ['a tolerant people', 'a people who welcomed strangers', 'a cosmopolitan people'], cmp: ['more tolerant', 'kinder to strangers'] },
    down: { verb: ['embittered', 'hardened', 'soured'], np: ['a suspicious, closed people', 'a people who hated strangers', 'a people wary of every foreigner'], cmp: ['less tolerant', 'harder on strangers'] },
  },
  militarism: {
    up: { verb: ['steeled', 'hardened', 'schooled'], np: ['a martial people', 'a nation under arms', 'a people of soldiers'], cmp: ['more martial', 'readier to take up arms'] },
    down: { verb: ['softened', 'gentled', 'changed'], np: ['an unmartial people', 'a people who had hung up their swords'], cmp: ['less martial', 'slower to muster'] },
  },
  isolation: {
    up: { verb: ['wearied', 'embittered', 'chastened'], np: ['an insular people', 'a people who kept to themselves', 'a people turned in upon themselves'], cmp: ['more insular', 'warier of the wider world'] },
    down: { verb: ['broadened', 'changed', 'emboldened'], np: ['an outward-looking people', 'a people open to the world'], cmp: ['more outward-looking', 'more open to the world'] },
  },
};

const raceWords = (keys) => listJoin((keys || []).map((r) => (RACE_META[r]?.plural || r).toLowerCase()));

/**
 * A noun phrase for a cause ("Two generations of war against the Oskeli"), capitalised, and
 * whether it reads as a stretch of time (only those follow "After …").
 */
function causePhrase(world, civ, cause, key = null, dir = 1) {
  const ctx = civ.flags.tctx || {};
  const span = pick(world, SPANS);
  const foeCiv = ctx.foe != null ? world.civs[ctx.foe] : null;
  const foe = foeCiv && foeCiv.id !== civ.id ? peopleOf(foeCiv) : null;
  const faith = ctx.faith != null ? world.religions[ctx.faith] : null;
  const fname = faith?.name ? String(faith.name).replace(/^The /, 'the ') : null;
  const others = ctx.others && ctx.others.length ? raceWords(ctx.others) : null;
  const opts = {
    war: [`${span} of war`, foe ? `${span} of war against ${foe}` : 'Endless campaigning', `${span} of fighting on every border`],
    conquest: [`${span} of conquest`, 'Victory upon victory', foe ? `Conquests won from ${foe}` : 'A string of conquests', 'The spoils of conquest'],
    victory: ['Victory upon victory', `${span} of triumph in the field`, foe ? `A run of victories over ${foe}` : 'A run of victories'],
    defeat: [`${span} of defeat`, foe ? `Defeat at the hands of ${foe}` : 'A string of defeats', 'Lost wars and lost towns'],
    ruin: ['Ruinous war', 'Burned fields and emptied towns', 'The ruin of war', 'War that left their towns in ashes'],
    weariness: [`${span} of wearying war`, 'Endless, thankless war', foe ? `Wars with ${foe} that never seemed to end` : 'Wars that never seemed to end'],
    peace: [`${span} of peace`, 'A long peace', `${span} of quiet borders`],
    trade: key === 'commerce' && dir < 0
      ? ['Dwindling trade', 'Thin caravans and empty wharves', `${span} of meagre trade`]
      : [`${span} of trade`, 'Busy markets and far-travelling caravans', 'The wealth of their trade routes', `${span} of commerce with their neighbours`],
    contact: ['Contact with strangers', 'New neighbours and their envoys', 'The coming of foreign envoys'],
    solitude: [`${span} alone in the world`, 'Long solitude', `${span} without word from any other people`],
    autarky: [`${span} without trade`, 'Empty market squares', `${span} of living off their own fields`],
    plague: ['Plague', `${span} of pestilence`, 'The plague pits', 'Sickness after sickness'],
    famine: ['Famine', 'Hunger and failed harvests', `${span} of hunger`, 'The lean years'],
    golden: ['A golden age', `${span} of plenty`, 'Prosperity', 'The glories of a golden age'],
    dark: ['A dark age', `${span} of misfortune`, 'Hard times', 'The long darkness'],
    wonder: ['The raising of great works', 'The building of wonders'],
    discovery: [`${span} of discovery`, 'The new learning', 'One discovery after another'],
    faith: key === 'religiosity' && dir < 0
      ? (fname ? [`The cooling of ${fname}`, `The tired rites of ${fname}`, `${span} of lukewarm faith`] : ['A cooling faith', 'Tired rites and empty temples'])
      : fname ? [`The preaching of ${fname}`, `${span} under ${fname}`, `The zeal of ${fname}`] : ['The faith of their fathers', 'The priests and their teaching'],
    ruler: ctx.ruler ? [`The long reign of ${ctx.ruler}`, `${span} under ${ctx.ruler}`, `The example of ${ctx.ruler}`] : ['Their rulers', 'The long reigns of their kings'],
    reason: ['The new learning', 'The age of reason', 'The questions of the philosophers'],
    industry: ['Smoke and steam', 'The factories', 'The clatter of the machine age'],
    colonies: [`${span} of settling new lands`, 'The founding of new towns', 'The lure of the frontier'],
    overreach: ['The strain of empire', 'Lands too wide to hold', 'The burdens of a sprawling realm'],
    mixing: others ? [`${span} of living beside ${others}`, `Life among ${others}`, 'The mingling of peoples in their towns'] : ['The mingling of peoples in their towns'],
    enmity: others ? [`Old hatred of ${others}`, `Bitter dealings with ${others}`] : ['Old hatreds'],
    expulsion: others ? ['The expulsions', `The driving-out of ${others}`] : ['The expulsions'],
    custom: ['Old custom', "The pull of their ancestors' ways", 'The slow return of old habits', 'The weight of old custom'],
    time: [`${span} of change`, 'The slow work of the years', 'The passing generations'],
  }[cause] || [`${span} of change`];
  const text = pick(world, opts);
  return { text, span: text.startsWith(span) || /^(A long|Endless|Long|Victory upon|A run|A string|Lost wars|Wars )/.test(text) || TIMELY.has(cause) };
}
// causes whose every phrase is an event or a stretch of time (they read well after "After")
const TIMELY = new Set(['plague', 'famine', 'golden', 'dark', 'expulsion', 'ruin']);

const lc = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The sentence for a shift: cause → what the people became (extreme band) or grew (moved). */
export function shiftText(world, civ, key, dir, band, extreme, cause) {
  const P = TRAIT_PROSE[key][dir > 0 ? 'up' : 'down'];
  const cp = causePhrase(world, civ, cause, key, dir);
  const C = cp.text;
  const c = lc(C);
  const ppl = peopleOf(civ), Ppl = PeopleOf(civ);
  const verb = pick(world, P.verb);
  const y = yearNow(world);
  if (extreme) {
    const np = pick(world, P.np);
    return pick(world, [
      `${C} had ${verb} ${ppl}; they had become ${np}.`,
      `${C} had made ${ppl} ${np}.`,
      `By Year ${y}, ${c} had made ${ppl} ${np}.`,
      `${Ppl}, ${verb} by ${c}, had become ${np}.`,
    ]);
  }
  const cmp = pick(world, P.cmp);
  const frames = [
    `${C} had ${verb} ${ppl}, who had grown ${cmp}.`,
    `${C} left a mark on ${ppl}: they were ${cmp} than their grandparents had been.`,
    `${Ppl}, ${verb} by ${c}, had grown ${cmp}.`,
  ];
  if (cp.span) frames.push(`After ${c}, ${ppl} had grown ${cmp}.`);
  return pick(world, frames);
}

/** Internals for the headless report and tests. */
export const _temper = { adaptOf, mainCause, refSample, TRAIT_PROSE };
