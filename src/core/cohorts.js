// Age cohorts: every town's people by five-year band and sex (docs/design/people-in-numbers.md).
//
//   s.cohorts    34 numbers: 17 bands (0–4, 5–9 … 75–79, then 80+) × 2 sexes, men first —
//                index b is the men of band b, NB + b the women. Plain JSON, saved with the town.
//   s.population stays the total every system reads; the cohorts are its shape. After each
//                monthly pass |Σ cohorts − population| < 0.5: reconcileCohorts settles writes
//                made elsewhere (a loss is taken from everyone alike, a gain arrives shaped like
//                movers), and the helpers below move people with a profile and keep both in step.
//
// Rules (societies vary): who serves, who moves, who is born, who dies are each read through
// ruleOf(world, key, civ). The ext point 'cohortRule' answers first (a 34-number weight table,
// or a number for 'pairK'); with no answer the default table here applies. Births, deaths and
// manpower are calibrated against the default rules' reference shapes (below), so a realm whose
// rule differs feels the difference (twice the people called up is about twice the manpower).
//
// Pure arithmetic: no world.rng, no allocation in the monthly pass (except slices a caller keeps).

import { firstOf, hasProviders } from './ext.js';
import { RACE_KEYS } from './constants.js';

/** Bands per sex, cells per table, and the first band of each age span used below. */
export const NB = 17, NC = 34;
/** Ageing: the share of a five-year band that moves up each month. */
const AGE_G = 1 / 60;
/** Boys per girl at birth. */
const SEX_RATIO = 1.05, BOY = SEX_RATIO / (1 + SEX_RATIO);
/** Ages 15–44 (bands 3–8): the women who bear children, and the dossier's men and women of those years. */
const PAIR_LO = 3, PAIR_HI = 8;
/** Partners: men of 20–54 (bands 4–10) for the women of 15–44 — husbands are older, widows remarry. */
const MATE_LO = 4, MATE_HI = 10;
/**
 * Months over which a town gets used to its partner ratio (remarriage, later marriage, more
 * wives): about a century, so a war-torn people carries the loss for generations.
 */
const MATE_ADAPT = 1200;
/**
 * …but after a sudden loss (a war, a plague) new marriages come fast: the adaptation speeds up
 * by 1 + REMARRY × drop², drop the share of the partners the town was used to that it lost. A
 * slight, lasting shortage still takes about a century; losing a third of the men, about a decade.
 */
const REMARRY = 100;
/** Crude death rate of the reference structure (a pre-modern life expectancy of about 36). */
const REF_DEATH = 0.028;

/** Annual risk by band relative to an adult of 40–44: deadly infancy, safe youth, rising after 50. */
const M = [3.0, 0.5, 0.35, 0.5, 0.7, 0.75, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0, 2.8, 4.0, 5.5, 7.5, 12];
/** Fertility by band, women only. */
const F = [0, 0, 0, 0.5, 1.0, 1.0, 0.85, 0.6, 0.3, 0, 0, 0, 0, 0, 0, 0, 0];

const both = (fm, ff) => { const t = new Array(NC); for (let b = 0; b < NB; b++) { t[b] = fm(b); t[NB + b] = ff(b); } return t; };

/** The default rules: weight tables per band and sex (see the design's "societies vary" table). */
const DEFAULT_RULES = {
  mortality: both((b) => M[b], (b) => M[b]),
  fertility: both(() => 0, (b) => F[b]),
  /** who serves: men 15–44, the 15–19s at half */
  levy: both((b) => (b === 3 ? 0.5 : b >= 4 && b <= 8 ? 1 : 0), () => 0),
  /** who moves: the young most, families with children, the old least */
  movers: both(mv, mv),
  /** who dies of hunger and plague: children under 10 and people over 60 */
  frail: both(fr, fr),
  /** who dies by the sword: men of fighting age, then women of the same years */
  violent: both((b) => (b >= 3 && b <= 8 ? 3 : 1), (b) => (b >= 3 && b <= 8 ? 1.5 : 1)),
  all: both(() => 1, () => 1),
  /** who dies in a people's in-fighting: its young men, or its men and women of 15–44 */
  youngMen: both((b) => (b >= 3 && b <= 8 ? 1 : 0), () => 0),
  adults: both((b) => (b >= 3 && b <= 8 ? 1 : 0), (b) => (b >= 3 && b <= 8 ? 1 : 0)),
  /** pairing: a small surplus of women still finds partners (births fall below 1/1.1 of the usual ratio) */
  pairK: 1.1,
};
/** who works: ages 15–64, with children of 10–14 and elders of 65–74 at half before the Medieval Age */
const WORK_EARLY = both(wk, wk), WORK_LATE = both(wkLate, wkLate);
function wk(b) { return b >= 3 && b <= 12 ? 1 : b === 2 || b === 13 || b === 14 ? 0.5 : 0; }
function wkLate(b) { return b >= 3 && b <= 12 ? 1 : 0; }
function mv(b) { return b < 3 ? 1 : b <= 6 ? 2 : b <= 10 ? 0.6 : 0.2; }
function fr(b) { return b < 2 || b >= 12 ? 3 : 1; }

/** Damage causes and the people they take (damageSettlement); any other cause takes everyone alike. */
const CAUSE_PROFILE = {
  sack: 'violent', raid: 'violent', feud: 'violent', riot: 'violent', bandits: 'violent', pirates: 'violent', horde: 'violent',
  plague: 'frail', locusts: 'frail', famine: 'frail',
  emigration: 'movers', flight: 'movers', bust: 'movers', expulsion: 'movers',
};
export const profileForCause = (cause) => CAUSE_PROFILE[cause] || 'all';

/**
 * A rule's table (or number) for a realm: the first 'cohortRule' provider's answer, else the
 * default. Tables must have 34 entries; a malformed answer falls back to the default.
 */
export function ruleOf(world, key, civ) {
  if (hasProviders('cohortRule')) {
    const v = firstOf('cohortRule', world, key, civ || null);
    if (v != null && (typeof v === 'number' ? Number.isFinite(v) : v.length === NC)) return v;
  }
  if (key === 'work') return civ && civ.tech && civ.tech.era >= 4 ? WORK_LATE : WORK_EARLY;
  return DEFAULT_RULES[key] || DEFAULT_RULES.all;
}

// ---------------------------------------------------------------------------
// Reference structures. Today's crude rates are the rates of a town whose bands have the shape
// those rates imply: the stable population of the default schedules growing at r = birth − death
// with crude death rate d, under the same monthly step the towns run (deaths, births into band
// 0, then ageing). With monthly hazard c·M[b], growth λ = 1 + r/12 a month and one birth a
// month, the steady state is
//   n0 = (1−g)β / (λ − (1−g)q0),  n_b = g·n'_{b−1} / (λ − (1−g)q_b),  n_80+ = g·n'_75 / (λ − q_80+)
// (q = 1 − c·M, n' = n·q plus the births in band 0); c is found by bisection so that the crude
// death rate is d. A town at its own reference shape gets exactly today's births, deaths and
// manpower; a hollow, a boom or a town of widows moves them. The references are tabulated once
// (pure arithmetic, the same on every machine) over d and r and read by interpolation.

function stable(c, lam, out) {
  let total = 0, deaths = 0;
  for (let sex = 0; sex < 2; sex++) {
    const beta = sex === 0 ? BOY : 1 - BOY, o = sex * NB;
    let prev = 0;   // n'_{b−1}
    for (let b = 0; b < NB; b++) {
      const q = 1 - c * M[b];
      let n;
      if (b === 0) n = (1 - AGE_G) * beta / (lam - (1 - AGE_G) * q);
      else if (b < NB - 1) n = AGE_G * prev / (lam - (1 - AGE_G) * q);
      else n = AGE_G * prev / (lam - q);
      out[o + b] = n;
      total += n; deaths += n * c * M[b];
      prev = n * q + (b === 0 ? beta : 0);
    }
  }
  for (let i = 0; i < NC; i++) out[i] /= total;
  return 12 * deaths / total;   // the crude death rate
}
/** The stable shape (shares summing to 1) for crude death rate d and growth r a year, into out. */
export function stableShape(d, r, out = new Array(NC)) {
  const lam = 1 + Math.max(0, r) / 12;
  let lo = 1e-8, hi = 0.08;
  for (let k = 0; k < 44; k++) {
    const mid = (lo + hi) / 2;
    if (stable(mid, lam, out) < d) lo = mid; else hi = mid;
  }
  stable((lo + hi) / 2, lam, out);
  return out;
}

/**
 * Life expectancy at birth, in years, of the default schedules at crude death rate d growing at r
 * (the reference shape's hazards c·M[b], each band left at the ageing pace): the statistics'
 * "as if this year's death rates held".
 */
export function lifeExpectancy(d, r) {
  const sh = new Array(NC);
  const lam = 1 + Math.max(0, r) / 12;
  let lo = 1e-8, hi = 0.08;
  for (let k = 0; k < 44; k++) { const mid = (lo + hi) / 2; if (stable(mid, lam, sh) < d) lo = mid; else hi = mid; }
  const c = (lo + hi) / 2;
  let E = 1 / (c * M[NB - 1]);   // months left in the open band
  for (let b = NB - 2; b >= 0; b--) E = (1 + AGE_G * E) / (c * M[b] + AGE_G);
  return E / 12;
}

const dot = (w, n) => { let s = 0; for (let i = 0; i < NC; i++) s += w[i] * n[i]; return s; };
const span = (n, o, lo, hi) => { let s = 0; for (let b = lo; b <= hi; b++) s += n[o + b]; return s; };

const REF = stableShape(REF_DEATH, 0);
/** The shape of new towns and of arrivals: the stationary population at a crude death rate of 2.8 %. Read-only. */
export const REF_SHAPE = Object.freeze(REF.slice());
/** The default levy rule's share of the people at REF. */
export const REF_ELIGIBLE = dot(DEFAULT_RULES.levy, REF);
/** Hands per working-age person (by the early rule), so a town at REF has 0.8 × its people working, as before. */
const LABOUR_K = 0.8 / dot(WORK_EARLY, REF);

// the table: crude death rates on a geometric grid, growth 0–12 % a year (a long-lived people's
// rates are read in its own stages of life, so an elf's 2 % a year is 10 % a stage-year); per
// cell Σ F·women, Σ M·n and the levy share of the reference shape (per head), and its partners
// per woman
const TD = Array.from({ length: 28 }, (_, k) => 0.003 * Math.pow(100, k / 27));   // 0.3 % … 30 %
const TR_MAX = 0.12, TR_N = 25;
const TK = 4, TAB = new Float64Array(TD.length * TR_N * TK);
{
  const sh = new Array(NC);
  for (let i = 0; i < TD.length; i++) for (let j = 0; j < TR_N; j++) {
    stableShape(TD[i], TR_MAX * j / (TR_N - 1), sh);
    const o = (i * TR_N + j) * TK;
    TAB[o] = dot(DEFAULT_RULES.fertility, sh);
    TAB[o + 1] = dot(DEFAULT_RULES.mortality, sh);
    TAB[o + 2] = dot(DEFAULT_RULES.levy, sh);
    TAB[o + 3] = span(sh, 0, MATE_LO, MATE_HI) / span(sh, NB, PAIR_LO, PAIR_HI);
  }
}
const REFX = { fert: 0, mort: 0, elig: 0, mates: 1 };
/** The reference indices for crude birth and death rates b, d (a year), into REFX. */
export function refIndices(b, d) {
  const dd = d < TD[0] ? TD[0] : d > TD[TD.length - 1] ? TD[TD.length - 1] : d;
  let i = 0, hi = TD.length - 2;
  while (i < hi) { const m = (i + hi + 1) >> 1; if (TD[m] <= dd) i = m; else hi = m - 1; }
  const fi = (dd - TD[i]) / (TD[i + 1] - TD[i]);
  let r = b - d;
  r = r < 0 ? 0 : r > TR_MAX ? TR_MAX : r;
  const x = r / TR_MAX * (TR_N - 1);
  const j = x >= TR_N - 1 ? TR_N - 2 : Math.floor(x), fj = x - j;
  const o00 = (i * TR_N + j) * TK, o01 = o00 + TK, o10 = o00 + TR_N * TK, o11 = o10 + TK;
  const w00 = (1 - fi) * (1 - fj), w01 = (1 - fi) * fj, w10 = fi * (1 - fj), w11 = fi * fj;
  REFX.fert = w00 * TAB[o00] + w01 * TAB[o01] + w10 * TAB[o10] + w11 * TAB[o11];
  REFX.mort = w00 * TAB[o00 + 1] + w01 * TAB[o01 + 1] + w10 * TAB[o10 + 1] + w11 * TAB[o11 + 1];
  REFX.elig = w00 * TAB[o00 + 2] + w01 * TAB[o01 + 2] + w10 * TAB[o10 + 2] + w11 * TAB[o11 + 2];
  REFX.mates = w00 * TAB[o00 + 3] + w01 * TAB[o01 + 3] + w10 * TAB[o10 + 3] + w11 * TAB[o11 + 3];
  return REFX;
}

// ---------------------------------------------------------------------------
// Tables and slices
//
// A town's cohorts are one table (34 numbers), or in a Mythic world a set of tables, one per
// people present: { human: [...], elf: [...] }, keys in RACE_KEYS order. A people's bands are
// stages of its own life (an elf's first band is its first 25 years); its births, deaths and
// ageing come from the ext point 'peopleRates' (w, people) → { birth, mortality, life }. Every
// helper here takes either form, and a slice taken from a set is a set. Only the myth module
// makes sets, so a Historical world never sees one.

const zeros = () => Array.from({ length: NC }, () => 0);
export const emptySlice = zeros;
const SCR = zeros();
/** A zeroed shared slice, valid until the next call (take, then add straight away). */
export function scratchSlice() { SCR.fill(0); return SCR; }

/** Is c a set of tables (one per people) rather than one table? */
export const isSet = (c) => c !== null && typeof c === 'object' && !Array.isArray(c);
const isTable = (c) => Array.isArray(c) && c.length === NC;
const total1 = (t) => { let s = 0; for (let i = 0; i < NC; i++) s += t[i]; return s; };
export const cohortTotal = (c) => {
  if (!isSet(c)) return total1(c);
  let s = 0;
  for (const k in c) s += total1(c[k]);
  return s;
};
const ALL = DEFAULT_RULES.all;
/** to[i] += from[i] × k */
function addTo(to, from, k) { for (let i = 0; i < NC; i++) to[i] += from[i] * k; }

/** set, with a (zero) table for people key added if it has none, keys kept in RACE_KEYS order (a new object then). */
export function withTable(set, key) {
  if (set[key]) return set;
  const out = {};
  let placed = false;
  for (const k of RACE_KEYS) {
    if (k === key) { out[k] = zeros(); placed = true; } else if (set[k]) out[k] = set[k];
  }
  for (const k in set) if (!(k in out)) out[k] = set[k];   // keys outside RACE_KEYS keep their place at the end
  if (!placed) out[key] = zeros();
  return out;
}

/** A people's rates in town s (ext 'peopleRates'; s may be null), or a human's. */
const HUMAN_RATES = { birth: 1, mortality: 1, life: 1 };
export function ratesOf(world, key, s = null) {
  if (!hasProviders('peopleRates')) return HUMAN_RATES;
  const v = firstOf('peopleRates', world, key, s);
  return v && v.life > 0 ? v : HUMAN_RATES;
}

/**
 * A new table of n people: shaped like `like` (34 numbers, or a set) when given and not empty,
 * else like the reference structure. A set gives a set.
 */
export function seedCohorts(n, like = null) {
  const m = Math.max(0, n || 0);
  if (isSet(like)) {
    const tot = cohortTotal(like);
    if (tot > 0) {
      const out = {};
      for (const key in like) { const t = zeros(); addTo(t, like[key], m / tot); out[key] = t; }
      return out;
    }
    like = null;
  }
  const t = zeros();
  const tot = like && like.length === NC ? total1(like) : 0;
  addTo(t, tot > 0 ? like : REF, m / (tot > 0 ? tot : 1));
  return t;
}

/** n people shaped like REF × a profile's weights (arrivals from elsewhere). Into `out` if given. */
export function shapedSlice(world, n, profile, civ, out = null) {
  const w = typeof profile === 'string' ? ruleOf(world, profile, civ) : profile;
  const t = out || zeros();
  const tot = dot(w, REF);
  for (let i = 0; i < NC; i++) t[i] = tot > 0 ? n * w[i] * REF[i] / tot : n * REF[i];
  return t;
}

/** Whether s carries cohorts the helpers keep (live towns do; ruins stay closed). */
const tracked = (s) => s.alive && (isTable(s.cohorts) || isSet(s.cohorts));

/**
 * Take n people from table c shaped by weights w (applied to the counts there, so a profile
 * never takes people who are not there). A band asked for more than it holds gives all it has
 * and the shortfall comes from everyone left alike. Adds what was taken into `into` (a table)
 * when given. Returns the number taken (n, or everyone if fewer).
 */
function takeFrom(c, n, w, into) {
  const tot = total1(c);
  if (!(n > 0) || !(tot > 0)) return 0;
  if (n >= tot) {
    for (let i = 0; i < NC; i++) { if (into) into[i] += c[i]; c[i] = 0; }
    return tot;
  }
  const W = dot(w, c);
  let left = n;
  if (W > 0) {
    const k = n / W;
    for (let i = 0; i < NC; i++) {
      let t = c[i] * w[i] * k;
      if (t > c[i]) t = c[i];
      c[i] -= t; left -= t;
      if (into) into[i] += t;
    }
  }
  if (left > 1e-9) {
    const rest = total1(c);
    const k = rest > 0 ? Math.min(1, left / rest) : 0;
    for (let i = 0; i < NC; i++) {
      const t = c[i] * k;
      c[i] -= t;
      if (into) into[i] += t;
    }
    left -= rest * k;
  }
  return n - Math.max(0, left);
}
const SCR2 = zeros();
/**
 * takeFrom for a table or a set: from a set, each people gives in proportion to the profile's
 * weight on it, and a shortfall comes from everyone left alike. into: a table, a set (each
 * people into its own table; a plain table's people go under asKey) or null. Returns the number
 * taken.
 */
function takeAny(c, n, w, into, asKey, label = null) {
  if (!isSet(c)) {
    if (!isSet(into)) return takeFrom(c, n, w, into);
    SCR2.fill(0);
    const got = takeFrom(c, n, w, SCR2);
    const key = asKey || RACE_KEYS[0];
    if (!into[key]) into[key] = zeros();
    addTo(into[key], SCR2, 1);
    return got;
  }
  let W = 0, any = false;
  for (const k in c) { W += dot(w, c[k]); any = true; }
  if (!any || !(n > 0)) return 0;
  const useW = W > 0 ? w : ALL, Wt = W > 0 ? W : cohortTotal(c);
  if (!(Wt > 0)) return 0;
  const sink = (k) => (isSet(into) ? (into[k] || (into[k] = zeros())) : into);
  let got = 0;
  for (const k in c) { const g = takeFrom(c[k], n * dot(useW, c[k]) / Wt, useW, sink(k)); got += g; if (COHORT_DEV.verify && label) flow(k + ' taken ' + label, g); }
  let left = n - got;
  if (left > 1e-9) {
    const rest = cohortTotal(c);
    if (rest > 0) for (const k in c) got += takeFrom(c[k], left * total1(c[k]) / rest, ALL, sink(k));
  }
  return got;
}

/**
 * Remove n people from town s with a profile ('all' | 'frail' | 'violent' | 'levy' | 'movers',
 * or a 34-number weight table) and lower s.population by as many. The realm's rule decides who
 * a profile names (civ defaults to the town's owner). Adds the people taken into `into` (a
 * table or a set) when given. Returns the number taken.
 */
export function takePeople(world, s, n, profile = 'all', into = null, civ = undefined) {
  const pop = s.population;
  if (!(n > 0) || !(pop > 0)) return 0;
  if (n > pop) n = pop;
  if (!tracked(s)) { s.population = pop - n; return n; }
  const w = typeof profile === 'string' ? ruleOf(world, profile, civ === undefined ? world.civs[s.civId] : civ) : profile;
  takeAny(s.cohorts, n, w, into, s.race, COHORT_DEV.verify ? (typeof profile === 'string' ? profile : 'table') : null);
  if (COHORT_DEV.verify) flow('take ' + (typeof profile === 'string' ? profile : 'table'), n);
  // a table that lags the population (a write since the last reconcile) gives what it has; the
  // population falls by n either way, and the reconcile settles the rest
  s.population = pop - n;
  return n;
}

/**
 * Add a slice (a table or a set) to town s, scaled to n people when n is given, and raise
 * s.population to match. Into a town of several peoples, a set's peoples join their own tables
 * and a plain table is shared by the town's peoples as they stand.
 */
export function addPeople(world, s, slice, n = undefined) {
  const tot = slice ? cohortTotal(slice) : 0;
  const add = n === undefined ? tot : Math.max(0, n);
  if (!(add > 0)) return 0;
  s.population += add;
  if (!tracked(s)) return add;
  let c = s.cohorts;
  if (isSet(c)) {
    if (isSet(slice) && tot > 0) {
      for (const key in slice) {
        if (!c[key]) c = s.cohorts = withTable(c, key);
        addTo(c[key], slice[key], add / tot);
        if (COHORT_DEV.verify) flow(key + ' added', total1(slice[key]) * add / tot);
      }
      return add;
    }
    const src = tot > 0 ? slice : REF, k0 = add / (tot > 0 ? tot : 1);
    const ct = cohortTotal(c);
    if (ct > 0) { for (const key in c) addTo(c[key], src, k0 * total1(c[key]) / ct); return add; }
    let key = null;
    for (const k in c) { key = k; break; }
    if (key === null) { key = s.race || RACE_KEYS[0]; c = s.cohorts = withTable(c, key); }
    addTo(c[key], src, k0);
    return add;
  }
  if (isSet(slice) && tot > 0) { for (const key in slice) addTo(c, slice[key], add / tot); return add; }
  if (tot > 0) addTo(c, slice, add / tot);
  else addTo(c, REF, add);
  return add;
}

/**
 * Move n people from town a to town b with a profile (urban drift): from a town of several
 * peoples each people goes into its own table at b, with no slice kept. Returns the number moved.
 */
export function movePeople(world, a, b, n, profile = 'movers', civ = undefined) {
  if (!(n > 0)) return 0;
  const c = a.cohorts;
  if (!isSet(c) || !tracked(a) || !tracked(b)) {
    SCR3.fill(0);
    const got = takePeople(world, a, n, profile, SCR3, civ);
    return addPeople(world, b, SCR3, got);
  }
  const w = typeof profile === 'string' ? ruleOf(world, profile, civ === undefined ? world.civs[a.civId] : civ) : profile;
  let W = 0;
  for (const k in c) W += dot(w, c[k]);
  if (!(W > 0)) return 0;
  let moved = 0;
  for (const k in c) {
    SCR2.fill(0);
    const got = takeFrom(c[k], n * dot(w, c[k]) / W, w, SCR2);
    if (got > 0) { addKeyed(world, b, k, SCR2, got); moved += got; }
  }
  a.population -= moved;
  if (COHORT_DEV.verify) flow('take ' + (typeof profile === 'string' ? profile : 'table'), moved);
  return moved;
}
const SCR3 = zeros();

/** An empty slice of the same form as town s's cohorts (a set for a town of several peoples), for takePeople's `into`. */
export const sliceLike = (s) => (s && isSet(s.cohorts) ? {} : zeros());

// One people's table in a set (myth/peoples.js: migration, expulsion, conquest, settlers).

/** Take n people of people `key` from town s (a set), shaped by a profile, into a table; lowers s.population. Returns the number taken. */
export function takeOfPeople(world, s, key, n, profile = 'all', into = null, civ = undefined) {
  const c = s.cohorts;
  if (!isSet(c) || !c[key] || !(n > 0)) return 0;
  const w = typeof profile === 'string' ? ruleOf(world, profile, civ === undefined ? world.civs[s.civId] : civ) : profile;
  const got = takeFrom(c[key], n, w, into);
  s.population -= got;
  if (COHORT_DEV.verify) flow(key + ' left (own table)', got);
  return got;
}

/** Add n people of people `key` to town s (a set), shaped like `like` (a table) or REF × movers; raises s.population. */
export function addOfPeople(world, s, key, n, like = null, civ = undefined) {
  let c = s.cohorts;
  if (!isSet(c) || !(n > 0)) return 0;
  if (!c[key]) c = s.cohorts = withTable(c, key);
  const src = like && total1(like) > 0 ? like : shapedSlice(world, 1, 'movers', civ === undefined ? world.civs[s.civId] : civ, SCR);
  addTo(c[key], src, n / total1(src));
  s.population += n;
  if (COHORT_DEV.verify) flow(key + ' arrived (own table)', n);
  return n;
}

/** A turning: a share f of every people's table joins people `to`'s, in the same bands (conquest, settlers). */
export function turnPeople(s, to, f) {
  let c = s.cohorts;
  if (!isSet(c) || !(f > 0)) return;
  if (!c[to]) c = s.cohorts = withTable(c, to);
  const dst = c[to];
  for (const k in c) {
    if (k === to) continue;
    const t = c[k];
    if (COHORT_DEV.verify) { const v = total1(t) * f; flow(k + ' turned away', v); flow(to + ' turned in', v); }
    for (let i = 0; i < NC; i++) { const v = t[i] * f; t[i] -= v; dst[i] += v; }
  }
}

/** Fold people `from`'s table into `to`'s (same bands) and drop it: a small people joins the town's main one. */
export function foldPeople(s, from, to) {
  let c = s.cohorts;
  if (!isSet(c) || !c[from] || from === to) return;
  if (!c[to]) c = s.cohorts = withTable(c, to);
  if (COHORT_DEV.verify) { const v = total1(c[from]); flow(from + ' folded away', v); flow(to + ' folded in', v); }
  addTo(c[to], c[from], 1);
  delete c[from];
  // keep the object's keys in order (a deleted key would leave the set's shape behind)
  const out = {};
  for (const k in c) out[k] = c[k];
  s.cohorts = out;
}

/** Split town s's single table into a set by shares { people: share } (a Mythic town gaining its peoples' tables). */
export function splitByPeoples(s, shares) {
  const c = s.cohorts;
  if (isSet(c)) return;
  const base = isTable(c) ? c : seedCohorts(s.population || 0);
  let sum = 0;
  for (const k in shares) if (shares[k] > 0) sum += shares[k];
  if (!(sum > 0)) return;
  const out = {};
  for (const k of RACE_KEYS) if (shares[k] > 0) { const t = zeros(); addTo(t, base, shares[k] / sum); out[k] = t; }
  for (const k in shares) if (!(k in out) && shares[k] > 0) { const t = zeros(); addTo(t, base, shares[k] / sum); out[k] = t; }
  s.cohorts = out;
}

/** Add n people to town s shaped like REF × a profile (arrivals whose origin kept no slice). */
export function addShaped(world, s, n, profile = 'movers', civ = undefined) {
  if (!(n > 0)) return 0;
  return addPeople(world, s, shapedSlice(world, n, profile, civ === undefined ? world.civs[s.civId] : civ, SCR), n);
}

/** A copy of a slice (a table or a set). */
function copySlice(sl) {
  if (!isSet(sl)) return sl.slice();
  const o = {};
  for (const k in sl) o[k] = sl[k].slice();
  return o;
}

/**
 * Levies home: n people back in the bands they marched out with (fl.levy, a table or a set,
 * aged by the months since fl.levyDay, each people at its own pace), or shaped by the levy rule
 * when the army kept no slice. They were drawn from every town of the realm by its people, and
 * go home the same way; s (the town they march to) takes them all only when the realm has no
 * other town.
 */
export function returnLevy(world, s, fl, n) {
  if (!(n > 0)) return 0;
  const sl = fl && (isTable(fl.levy) || isSet(fl.levy)) ? fl.levy : null;
  const civ = world.civs[s.civId];
  if (COHORT_DEV.verify) flow('levy home', n);
  let back;
  if (!sl || !(cohortTotal(sl) > 0)) back = shapedSlice(world, 1, 'levy', civ, SCR);
  else {
    const months = (world.time.day - (Number.isFinite(fl.levyDay) ? fl.levyDay : world.time.day)) / 30;
    if (isSet(sl)) { back = copySlice(sl); for (const k in back) ageSlice(back[k], months, ratesOf(world, k).life); }
    else { for (let i = 0; i < NC; i++) SCR[i] = sl[i]; back = ageSlice(SCR, months); }
  }
  const ids = civ && civ.alive && s.civId === civ.id ? civ.settlementIds : null;
  if (isSet(back)) {
    // each people goes home to the towns where its own people lives, by their numbers there
    const all = cohortTotal(back);
    if (!(all > 0)) return 0;
    for (const key in back) {
      const nk = n * total1(back[key]) / all;
      let wt = 0;
      if (ids) for (let k = 0; k < ids.length; k++) { const t = world.settlements[ids[k]]; if (t && t.alive && isSet(t.cohorts) && t.cohorts[key]) wt += total1(t.cohorts[key]); }
      if (!(wt > 0)) { addKeyed(world, s, key, back[key], nk); continue; }
      for (let k = 0; k < ids.length; k++) {
        const t = world.settlements[ids[k]];
        if (t && t.alive && isSet(t.cohorts) && t.cohorts[key]) addKeyed(world, t, key, back[key], nk * total1(t.cohorts[key]) / wt);
      }
    }
    return n;
  }
  let tot = 0;
  if (ids) for (let k = 0; k < ids.length; k++) { const t = world.settlements[ids[k]]; if (t && t.alive) tot += Math.max(0, t.population); }
  if (!(tot > 0)) return addPeople(world, s, back, n);
  for (let k = 0; k < ids.length; k++) {
    const t = world.settlements[ids[k]];
    if (t && t.alive && t.population > 0) addPeople(world, t, back, n * t.population / tot);
  }
  return n;
}

/** Add n people of people `key` shaped like table `tb` to town t (into its own table, or its one table). */
function addKeyed(world, t, key, tb, n) {
  const tot = total1(tb);
  if (!(n > 0) || !(tot > 0)) return;
  t.population += n;
  if (!tracked(t)) return;
  let c = t.cohorts;
  if (COHORT_DEV.verify) flow(key + ' levy home', n);
  if (isSet(c)) { if (!c[key]) c = t.cohorts = withTable(c, key); addTo(c[key], tb, n / tot); }
  else addTo(c, tb, n / tot);
}

/** Age a table in place by `months` of ageing (no deaths) for a people of the given life: levies home from a long war. */
export function ageSlice(c, months, life = 1) {
  const m = Math.min(600, Math.max(0, Math.round(months)));
  const g = AGE_G / life;
  for (let k = 0; k < m; k++) {
    for (let o = 0; o < NC; o += NB) {
      for (let b = NB - 2; b >= 0; b--) {
        const mv = c[o + b] * g;
        c[o + b] -= mv;
        c[o + b + 1] += mv;
      }
    }
  }
  return c;
}

/** hundredths: Math.round(x·100) / 100 for x ≥ 0 (by integer truncation below 2·10⁷, which is cheaper), else 0 */
const hund = (x) => (x > 0 ? (x < 2e7 ? ((x * 100 + 0.5) | 0) / 100 : Math.round(x * 100) / 100) : 0);
/**
 * The monthly ageing (a share g of each band moves up), rounding each band to hundredths as it
 * is finished (the rounding is part of the simulation, so a reloaded world continues exactly;
 * settleCohorts then gives the largest band the remainder).
 */
function ageAndRound(c, g) {
  let sum = 0;
  for (let o = 0; o < NC; o += NB) {
    for (let b = NB - 2; b >= 0; b--) {
      const mv = c[o + b] * g;
      c[o + b] -= mv;
      const v = hund(c[o + b + 1] + mv);
      c[o + b + 1] = v; sum += v;
      if (v > LAST.top) { LAST.top = v; LAST.t = c; LAST.i = o + b + 1; }
    }
    const v = hund(c[o]);
    c[o] = v; sum += v;
    if (v > LAST.top) { LAST.top = v; LAST.t = c; LAST.i = o; }
  }
  return sum;
}
/**
 * The last monthly step's rounded total and largest band (cohortMonth → settleCohorts, within one
 * town's pass): if nothing moved the town's people since, the settle needs no second pass.
 */
const LAST = { s: null, total: 0, top: -1, t: null, i: 0 };

/** Round a slice (a table or a set) to hundredths (for slices kept on records, e.g. an army's levy). */
export function roundSlice(c) {
  if (isSet(c)) { for (const k in c) roundSlice(c[k]); return c; }
  for (let i = 0; i < NC; i++) c[i] = hund(c[i]);
  return c;
}

// ---------------------------------------------------------------------------
// The monthly pass (civ/settlement.js)

/**
 * Settle any difference between Σ cohorts and s.population left by writes elsewhere: a loss is
 * taken from everyone alike, a gain arrives shaped like movers (shared by a town's peoples as
 * they stand). Seeds a missing table. Returns the town's working hands (workersIn), counted in
 * the same pass.
 */
export function reconcileCohorts(world, s, civ) {
  const pop = Math.max(0, s.population || 0);
  let c = s.cohorts;
  if (!isTable(c) && !isSet(c)) c = s.cohorts = seedCohorts(pop);
  const work = ruleOf(world, 'work', civ);
  let tot = 0, wk = 0;
  if (isSet(c)) { for (const key in c) { const t = c[key]; for (let i = 0; i < NC; i++) { const v = t[i]; tot += v; wk += work[i] * v; } } }
  else for (let i = 0; i < NC; i++) { const v = c[i]; tot += v; wk += work[i] * v; }
  const diff = pop - tot;
  if (diff > -1e-6 && diff < 1e-6) return LABOUR_K * wk;
  if (!(tot > 0)) {
    if (isSet(c)) { s.cohorts = c; s.population = 0; addPeople(world, s, REF, pop); }
    else s.cohorts = seedCohorts(pop);
  } else if (diff < 0) {
    const k = pop / tot;
    if (isSet(c)) { for (const key in c) { const t = c[key]; for (let i = 0; i < NC; i++) t[i] *= k; } }
    else for (let i = 0; i < NC; i++) c[i] *= k;
  } else {
    const w = ruleOf(world, 'movers', civ);
    const W = dot(w, REF);
    const arr = shapedSlice(world, diff, w, civ, SCR);
    if (isSet(c)) { for (const key in c) addTo(c[key], arr, total1(c[key]) / tot); }
    else if (W > 0) addTo(c, arr, 1);
    else addTo(c, REF, diff);
  }
  return workersIn(world, s, civ);
}

const BIRTHS = new Float64Array(RACE_KEYS.length + 4), LIVES = new Float64Array(RACE_KEYS.length + 4);   // per table, scratch
/**
 * One month of births, natural deaths and ageing on the town's table (or each of its peoples'
 * tables, at that people's rates and pace), plus the famine dead (frail) and the emigrants
 * (movers), which leave before the births arrive. birthA / deathA are today's crude annual rates,
 * the rates of a town at its reference shape. In a town of several peoples each people also
 * fights among itself (ext 'strife'): k × its share of the town × crowd of it die a year, taken
 * by its `who` (its young men, its men and women, or all ages). The more a people fills a town,
 * and the harder the town presses on its land (crowd, 0–1: a young town with room to grow
 * hardly feuds), the more it feuds, so a fast-breeding people's head start is spent in its own
 * feuds once land runs short and no people swamps the rest unchecked. Fills out with the births,
 * natural deaths, famine dead, emigrants and in-fighting dead (the caller sets s.population to
 * Σ cohorts).
 */
export function cohortMonth(world, s, civ, birthA, deathA, famineDead, emig, out, crowd = 1) {
  const c = s.cohorts, fl = s.flags;
  const fertR = ruleOf(world, 'fertility', civ), mort = ruleOf(world, 'mortality', civ), levyR = ruleOf(world, 'levy', civ);
  const K = ruleOf(world, 'pairK', civ);
  let births = 0, deaths = 0, crudeB = 0, crudeD = 0, beforeP = 0;
  let eNum = 0, eDen = 0, feud = 0, lv = 0, all = 0, yth = 0;
  const set = isSet(c);
  if (set && (typeof fl.mates !== 'object' || fl.mates === null)) fl.mates = {};
  const strife = set && crowd > 0 && hasProviders('strife');
  const town = strife ? cohortTotal(c) : 0;
  let j = 0;
  for (const key in (set ? c : ONE)) {
    const t = set ? c[key] : c;
    const R = set ? ratesOf(world, key, s) : HUMAN_RATES;
    const bA = birthA * R.birth, dA = deathA * R.mortality, L = R.life;
    // one pass: the people, the fertility rule's weight, the partners, the women of 15–44 and
    // the young men the default levy names
    let pop = 0, fertSum = 0, men = 0, women = 0, el = 0;
    for (let b = 0; b < NB; b++) {
      const m = t[b], f = t[NB + b];
      pop += m + f;
      fertSum += fertR[b] * m + fertR[NB + b] * f;
      if (b >= MATE_LO && b <= MATE_HI) men += m;
      if (b >= PAIR_LO && b <= PAIR_HI) women += f;
      if (b === 3) el += 0.5 * m; else if (b >= 4 && b <= 8) el += m;
      lv += levyR[b] * m + levyR[NB + b] * f;
      if (b === 3 || b === 4) yth += m + f;
    }
    all += pop;
    // the reference shape for this people's rates, read in its own stages of life
    const ref = refIndices(bA * L, dA * L);
    if (ref.elig > 0) { eNum += el; eDen += el / ref.elig; }
    // partners: men of 20–54 per woman of 15–44 against the reference's (x), and what the town is
    // used to (s.flags.mates, x averaged over about a century, never above 1): births fall when x
    // drops below 1 / pairK of that — a sudden loss of men hurts; a realm always at war has adapted
    const x = women > 0 ? Math.min(1, men / (women * ref.mates)) : 1;
    let used = set ? fl.mates[key] : fl.mates;
    if (!(used > 0)) used = x;
    const drop = x < used ? (used - x) / used : 0;
    used += (x - used) / (MATE_ADAPT * L) * (1 + REMARRY * drop * drop);
    if (set) fl.mates[key] = used; else fl.mates = used;
    // births: today's crude rate, by the women of childbearing age against the reference, and
    // by partners
    let bt = 0;
    if (pop > 0 && bA > 0) {
      const pairing = Math.min(1, K * x / Math.max(0.2, used));
      const base = bA * pop / 12 * (fertSum / pop / ref.fert);
      bt = base * pairing;
      if (COHORT_DEV.verify) { crudeB += bA * pop / 12; beforeP += base; if (set) { flow(key + ' births at crude', bA * pop / 12); flow(key + ' births before pairing', base); flow(key + ' births', bt); } }
    }
    LIVES[j] = L;
    BIRTHS[j++] = bt;
    births += bt;
    // natural deaths: each band's hazard is dA·M[b] / (Σ M·n per head at the reference) a year
    // in-fighting (k a year at a crowded town wholly of this people, by its share and the
    // crowding), taken in the same pass by who fights: fw[i] × fk of each band
    let fk = 0, fw = null;
    if (strife && town > 0 && pop > 0) {
      const st = firstOf('strife', world, key, civ);
      if (st && st.k > 0) {
        fw = typeof st.who === 'string' ? ruleOf(world, st.who, civ) : st.who && st.who.length === NC ? st.who : ALL;
        const W = dot(fw, t);
        if (W > 0) fk = pop * st.k * (pop / town) * crowd / 12 / W;
      }
    }
    const hz = dA / (12 * ref.mort);
    const d0 = deaths, f0 = feud;
    for (let i = 0; i < NC; i++) {
      let h = hz * mort[i];
      if (h > 0.5) h = 0.5;
      const d = t[i] * h;
      let fd = fk > 0 ? t[i] * fw[i] * fk : 0;
      if (fd > t[i] - d) fd = t[i] - d;
      t[i] -= d + fd; deaths += d; feud += fd;
    }
    if (COHORT_DEV.verify && fk > 0) flow(key + ' feuds', feud - f0);
    if (COHORT_DEV.verify && set) flow(key + ' died', deaths - d0);
    if (COHORT_DEV.verify) { crudeD += dA * pop / 12; if (set) { flow(key + ' died at crude', dA * pop / 12); flow(key + ' people-months', pop); } }
  }
  // the levy share of the town's reference shape, for manpower (levyBase); for several peoples,
  // what makes Σ eligible / eref = Σ eligible_people / eref_people
  fl.eref = eDen > 0 ? Math.round(eNum / eDen * 1e4) / 1e4 : REF_ELIGIBLE;
  // the people the town counts for in manpower (levyBase), from this same pass: the realm's
  // monthly pass sums them instead of reading every table again
  fl.lb = all > 0 ? Math.round(lv / all * (s.population || 0) / fl.eref) : 0;
  fl.yt = all > 0 ? Math.round(yth / all * 1000) / 1000 : 0;   // its share of 15–24s (the realm's youth lean)
  let fam = 0, em = 0;
  if (famineDead > 0) fam = takeAny(c, famineDead, ruleOf(world, 'frail', civ), null, null, 'famine');
  if (emig > 0) em = takeAny(c, emig, ruleOf(world, 'movers', civ), null, null, 'emigrants');
  j = 0;
  LAST.s = s; LAST.top = -1; LAST.t = null;
  let total = 0;
  for (const key in (set ? c : ONE)) {
    const t = set ? c[key] : c;
    const L = LIVES[j], bt = BIRTHS[j++];
    t[0] += bt * BOY;
    t[NB] += bt * (1 - BOY);
    total += ageAndRound(t, L === 1 ? AGE_G : AGE_G / L);
  }
  LAST.total = total;
  out.total = total;
  if (COHORT_DEV.verify) { flow('births', births); flow('births at crude', crudeB); flow('births before pairing', beforeP); flow('died', deaths); flow('died at crude', crudeD); if (feud > 0) flow('died in feuds', feud); }
  out.births = births; out.deaths = deaths; out.famine = fam; out.emig = em; out.feud = feud;
  return out;
}
const ONE = { one: 1 };   // a single table iterates once

/**
 * End of the monthly pass (the bands were rounded to hundredths as they aged): the largest band
 * (of any people) takes the remainder, so Σ cohorts = s.population exactly.
 */
export function settleCohorts(s) {
  // nothing moved since this town's monthly step: its rounded total and largest band are known
  if (LAST.s === s && LAST.t && LAST.total === s.population) {
    const v = (s.population || 0) - (LAST.total - LAST.top);
    LAST.t[LAST.i] = v > 0 ? v : 0;
    LAST.s = null;
    return;
  }
  LAST.s = null;
  const c = s.cohorts;
  if (isSet(c)) {
    let bt = null, big = 0, top = -1, sum = 0;
    for (const k in c) {
      const t = c[k];
      for (let i = 0; i < NC; i++) { const v = t[i]; sum += v; if (v > top) { top = v; big = i; bt = t; } }
    }
    if (bt) { const v = (s.population || 0) - (sum - top); bt[big] = v > 0 ? v : 0; }
    return;
  }
  if (!isTable(c)) return;
  let big = 0, top = -1, sum = 0;
  for (let i = 0; i < NC; i++) {
    const v = c[i];
    sum += v;
    if (v > top) { top = v; big = i; }
  }
  const v = (s.population || 0) - (sum - top);
  c[big] = v > 0 ? v : 0;
}

// ---------------------------------------------------------------------------
// Readers

/** Σ over a table or a set of w · n. */
const dotAny = (w, c) => { if (!isSet(c)) return dot(w, c); let s = 0; for (const k in c) s += dot(w, c[k]); return s; };

/**
 * The working hands of town s: its people weighted by the realm's who-works rule (by default
 * 15–64, and before the Medieval Age half of 10–14 and of 65–74; each people by its own stages
 * of life), 0.8 × the people at REF. Scaled to s.population if the table lags; 0.8 × the people
 * without a table.
 */
export function workersIn(world, s, civ) {
  const c = s.cohorts, pop = s.population || 0;
  if (!isTable(c) && !isSet(c)) return 0.8 * pop;
  const tot = cohortTotal(c);
  return tot > 0 ? LABOUR_K * dotAny(ruleOf(world, 'work', civ), c) * pop / tot : 0.8 * pop;
}

/**
 * The people town s counts for in manpower (today 3 % of them): its population at its reference
 * shape, more when the realm's levy rule names more of them (or the town has young men to spare),
 * fewer in a hollow generation. levy: ruleOf(world, 'levy', civ).
 */
export function levyBase(s, levy) {
  const c = s.cohorts;
  const pop = s.population || 0;
  if (!isTable(c) && !isSet(c)) return pop;
  const tot = cohortTotal(c);
  const eref = s.flags && s.flags.eref > 0 ? s.flags.eref : REF_ELIGIBLE;
  return tot > 0 ? dotAny(levy, c) / tot * pop / eref : pop;
}

/**
 * A town's (or summed) cohorts in numbers for the dossier: median age in years, children (the
 * first three stages, under 15 for humans), elders (from 65), men and women of 15–44, working
 * hands (15–64, plus half of 10–14 and 65–74 before era 4). For a set, each people by its own
 * stages of life; lifeOf(people) gives its life (1 for humans).
 */
export function cohortSummary(c, era = 0, lifeOf = null) {
  const out = { total: 0, median: 0, children: 0, elders: 0, men: 0, women: 0, working: 0 };
  if (!c) return out;
  const tabs = isSet(c) ? Object.keys(c).map((k) => [c[k], lifeOf ? lifeOf(k) : 1]) : [[c, 1]];
  const iv = [];
  for (const [t, L] of tabs) {
    for (let b = 0; b < NB; b++) {
      const n = t[b] + t[NB + b];
      out.total += n;
      if (b < 3) out.children += n;
      if (b >= 13) out.elders += n;
      if (b >= 3 && b <= 12) out.working += n;
      if (era < 4 && (b === 2 || b === 13 || b === 14)) out.working += 0.5 * n;
      if (n > 0) iv.push([5 * b * L, (b === NB - 1 ? 5 * (b + 1) : 5 * (b + 1)) * L, n]);
    }
    out.men += span(t, 0, PAIR_LO, PAIR_HI);
    out.women += span(t, NB, PAIR_LO, PAIR_HI);
  }
  if (!(out.total > 0)) return out;
  // the median age: bands as spans of years (a long-lived people's spans are longer), people
  // spread evenly within each
  const half = out.total / 2;
  let lo = 0, hi = 0;
  for (const v of iv) if (v[1] > hi) hi = v[1];
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2;
    let below = 0;
    for (const [a, z, n] of iv) below += mid <= a ? 0 : mid >= z ? n : n * (mid - a) / (z - a);
    if (below < half) lo = mid; else hi = mid;
  }
  out.median = (lo + hi) / 2;
  return out;
}

/** A town's cohorts summed by band into out (34 numbers; a set's peoples by their own stages of life). Returns the total. */
export function bandTotals(c, out) {
  out.fill(0);
  if (!c) return 0;
  if (!isSet(c)) {
    if (!isTable(c)) return 0;
    let tot = 0;
    for (let i = 0; i < NC; i++) { out[i] = c[i]; tot += c[i]; }
    return tot;
  }
  let tot = 0;
  for (const k in c) {
    const t = c[k];
    if (!isTable(t)) continue;
    for (let i = 0; i < NC; i++) { out[i] += t[i]; tot += t[i]; }
  }
  return tot;
}

/**
 * The young (15–24) and the old (65 and over) of a town's cohorts as shares of it, into a shared
 * object ({ youth, elders }, valid until the next call; zeros without a table). A set's peoples
 * by their own stages of life.
 */
const AGES = { youth: 0, elders: 0 };
export function ageShares(c) {
  AGES.youth = 0; AGES.elders = 0;
  if (!c) return AGES;
  let y = 0, e = 0, tot = 0;
  const one = (t) => {
    if (!isTable(t)) return;
    y += t[3] + t[4] + t[NB + 3] + t[NB + 4];
    for (let b = 13; b < NB; b++) e += t[b] + t[NB + b];
    tot += total1(t);
  };
  if (isSet(c)) { for (const k in c) one(c[k]); } else one(c);
  if (tot > 0) { AGES.youth = y / tot; AGES.elders = e / tot; }
  return AGES;
}
/** The event deck's lean for a youth bulge (15–24 above 20 %): × up to 1.2 on riots, revolts and border skirmishes. */
export const youthLean = (youth) => 1 + Math.min(0.2, 2 * Math.max(0, youth - 0.2));
/** …and for an ageing town (65+ above 8 %): × up to 1.2 on festivals and great works, ÷ as much on riots. */
export const eldersLean = (elders) => 1 + Math.min(0.2, 2 * Math.max(0, elders - 0.08));

/** Band labels for display. */
export const BAND_LABELS = Array.from({ length: NB }, (_, b) => (b === NB - 1 ? '80+' : `${5 * b}–${5 * b + 4}`));

/** Dev check (on in --trial and --cohort-check): the invariant after every monthly pass. */
export const COHORT_DEV = { verify: false, bad: 0, worst: 0, first: null, flows: {} };
function flow(key, n) { COHORT_DEV.flows[key] = (COHORT_DEV.flows[key] || 0) + n; }
export function verifyCohorts(world, s) {
  const c = s.cohorts;
  const ok = isTable(c) || (isSet(c) && Object.values(c).every(isTable));
  const d = ok ? Math.abs(cohortTotal(c) - (s.population || 0)) : Infinity;
  let neg = false;
  if (ok) for (const t of isSet(c) ? Object.values(c) : [c]) for (let i = 0; i < NC; i++) if (!(t[i] >= 0)) neg = true;
  if (d >= 0.5 || neg) {
    COHORT_DEV.bad++;
    if (d > COHORT_DEV.worst) COHORT_DEV.worst = d;
    if (!COHORT_DEV.first) COHORT_DEV.first = { day: world.time.day, sid: s.id, pop: s.population, diff: d, neg };
  }
}
