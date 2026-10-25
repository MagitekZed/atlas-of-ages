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
  /** pairing: a small surplus of women still finds partners (births fall below 1/1.1 of the usual ratio) */
  pairK: 1.1,
};
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
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (stable(mid, lam, out) < d) lo = mid; else hi = mid;
  }
  stable((lo + hi) / 2, lam, out);
  return out;
}

const dot = (w, n) => { let s = 0; for (let i = 0; i < NC; i++) s += w[i] * n[i]; return s; };
const span = (n, o, lo, hi) => { let s = 0; for (let b = lo; b <= hi; b++) s += n[o + b]; return s; };

const REF = stableShape(REF_DEATH, 0);
/** The shape of new towns and of arrivals: the stationary population at a crude death rate of 2.8 %. Read-only. */
export const REF_SHAPE = Object.freeze(REF.slice());
/** The default levy rule's share of the people at REF. */
export const REF_ELIGIBLE = dot(DEFAULT_RULES.levy, REF);

// the table: crude death rates on a geometric grid, growth 0–4 % a year; per cell Σ F·women,
// Σ M·n and the levy share of the reference shape (per head), and its partners per woman
const TD = Array.from({ length: 28 }, (_, k) => 0.003 * Math.pow(100, k / 27));   // 0.3 % … 30 %
const TR_MAX = 0.04, TR_N = 9;
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

export const emptySlice = () => new Array(NC).fill(0);
const SCR = new Array(NC).fill(0);
/** A zeroed shared slice, valid until the next call (take, then add straight away). */
export function scratchSlice() { SCR.fill(0); return SCR; }

export const cohortTotal = (c) => { let s = 0; for (let i = 0; i < NC; i++) s += c[i]; return s; };

/**
 * A new table of n people: shaped like `like` (any 34 numbers) when given and not empty, else
 * like the reference structure.
 */
export function seedCohorts(n, like = null) {
  const t = new Array(NC);
  const tot = like && like.length === NC ? cohortTotal(like) : 0;
  const src = tot > 0 ? like : REF, k = Math.max(0, n || 0) / (tot > 0 ? tot : 1);
  for (let i = 0; i < NC; i++) t[i] = src[i] * k;
  return t;
}

/** n people shaped like REF × a profile's weights (arrivals from elsewhere). Into `out` if given. */
export function shapedSlice(world, n, profile, civ, out = null) {
  const w = typeof profile === 'string' ? ruleOf(world, profile, civ) : profile;
  const t = out || new Array(NC);
  const tot = dot(w, REF);
  for (let i = 0; i < NC; i++) t[i] = tot > 0 ? n * w[i] * REF[i] / tot : n * REF[i];
  return t;
}

/** Whether s carries a cohort table the helpers keep (live towns do; ruins stay closed). */
const tracked = (s) => s.alive && Array.isArray(s.cohorts) && s.cohorts.length === NC;

/**
 * Take n people from table c shaped by weights w (applied to the counts there, so a profile
 * never takes people who are not there). A band asked for more than it holds gives all it has
 * and the shortfall comes from everyone left alike. Adds what was taken into `into` when given.
 * Returns the number taken (n, or everyone if fewer).
 */
function takeFrom(c, n, w, into) {
  const tot = cohortTotal(c);
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
    const rest = cohortTotal(c);
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

/**
 * Remove n people from town s with a profile ('all' | 'frail' | 'violent' | 'levy' | 'movers',
 * or a 34-number weight table) and lower s.population by as many. The realm's rule decides who
 * a profile names (civ defaults to the town's owner). Adds the people taken into `into` when
 * given. Returns the number taken.
 */
export function takePeople(world, s, n, profile = 'all', into = null, civ = undefined) {
  const pop = s.population;
  if (!(n > 0) || !(pop > 0)) return 0;
  if (n > pop) n = pop;
  if (!tracked(s)) { s.population = pop - n; return n; }
  const w = typeof profile === 'string' ? ruleOf(world, profile, civ === undefined ? world.civs[s.civId] : civ) : profile;
  takeFrom(s.cohorts, n, w, into);
  if (COHORT_DEV.verify) flow('take ' + (typeof profile === 'string' ? profile : 'table'), n);
  // a table that lags the population (a write since the last reconcile) gives what it has; the
  // population falls by n either way, and the reconcile settles the rest
  s.population = pop - n;
  return n;
}

/** Add a slice to town s (scaled to n people when n is given) and raise s.population to match. */
export function addPeople(world, s, slice, n = undefined) {
  const tot = slice ? cohortTotal(slice) : 0;
  const add = n === undefined ? tot : Math.max(0, n);
  if (!(add > 0)) return 0;
  s.population += add;
  if (!tracked(s)) return add;
  const c = s.cohorts;
  if (tot > 0) { const k = add / tot; for (let i = 0; i < NC; i++) c[i] += slice[i] * k; }
  else for (let i = 0; i < NC; i++) c[i] += add * REF[i];
  return add;
}

/** Add n people to town s shaped like REF × a profile (arrivals whose origin kept no slice). */
export function addShaped(world, s, n, profile = 'movers', civ = undefined) {
  if (!(n > 0)) return 0;
  return addPeople(world, s, shapedSlice(world, n, profile, civ === undefined ? world.civs[s.civId] : civ, SCR), n);
}

/**
 * Levies home: n people back in the bands they marched out with (fl.levy, aged by the months
 * since fl.levyDay), or shaped by the levy rule when the army kept no slice. They were drawn from
 * every town of the realm by its people, and go home the same way; s (the town they march to)
 * takes them all only when the realm has no other town.
 */
export function returnLevy(world, s, fl, n) {
  if (!(n > 0)) return 0;
  const sl = fl && Array.isArray(fl.levy) && fl.levy.length === NC ? fl.levy : null;
  const civ = world.civs[s.civId];
  if (COHORT_DEV.verify) flow('levy home', n);
  if (!sl || !(cohortTotal(sl) > 0)) shapedSlice(world, 1, 'levy', civ, SCR);
  else {
    for (let i = 0; i < NC; i++) SCR[i] = sl[i];
    ageSlice(SCR, (world.time.day - (Number.isFinite(fl.levyDay) ? fl.levyDay : world.time.day)) / 30);
  }
  const ids = civ && civ.alive && s.civId === civ.id ? civ.settlementIds : null;
  let tot = 0;
  if (ids) for (let k = 0; k < ids.length; k++) { const t = world.settlements[ids[k]]; if (t && t.alive) tot += Math.max(0, t.population); }
  if (!(tot > 0)) return addPeople(world, s, SCR, n);
  for (let k = 0; k < ids.length; k++) {
    const t = world.settlements[ids[k]];
    if (t && t.alive && t.population > 0) addPeople(world, t, SCR, n * t.population / tot);
  }
  return n;
}

/** Age a slice in place by `months` of ageing (no deaths): levies home from a long war. */
export function ageSlice(c, months) {
  const m = Math.min(600, Math.max(0, Math.round(months)));
  for (let k = 0; k < m; k++) ageOnce(c);
  return c;
}

function ageOnce(c) {
  for (let o = 0; o < NC; o += NB) {
    for (let b = NB - 2; b >= 0; b--) {
      const mv = c[o + b] * AGE_G;
      c[o + b] -= mv;
      c[o + b + 1] += mv;
    }
  }
}

/** hundredths: Math.round(x·100) / 100 for x ≥ 0 (by integer truncation below 2·10⁷, which is cheaper), else 0 */
const hund = (x) => (x > 0 ? (x < 2e7 ? ((x * 100 + 0.5) | 0) / 100 : Math.round(x * 100) / 100) : 0);
/**
 * The monthly ageing, rounding each band to hundredths as it is finished (the rounding is part
 * of the simulation, so a reloaded world continues exactly; settleCohorts then gives the largest
 * band the remainder).
 */
function ageAndRound(c) {
  for (let o = 0; o < NC; o += NB) {
    for (let b = NB - 2; b >= 0; b--) {
      const mv = c[o + b] * AGE_G;
      c[o + b] -= mv;
      c[o + b + 1] = hund(c[o + b + 1] + mv);
    }
    c[o] = hund(c[o]);
  }
}

/** Round a slice to hundredths (for slices kept on records, e.g. an army's levy). */
export function roundSlice(c) {
  for (let i = 0; i < NC; i++) c[i] = hund(c[i]);
  return c;
}

// ---------------------------------------------------------------------------
// The monthly pass (civ/settlement.js)

/**
 * Settle any difference between Σ cohorts and s.population left by writes elsewhere: a loss is
 * taken from everyone alike, a gain arrives shaped like movers. Seeds a missing table.
 */
export function reconcileCohorts(world, s) {
  const pop = Math.max(0, s.population || 0);
  let c = s.cohorts;
  if (!Array.isArray(c) || c.length !== NC) { s.cohorts = seedCohorts(pop); return; }
  const tot = cohortTotal(c);
  const diff = pop - tot;
  if (diff > -1e-6 && diff < 1e-6) return;
  if (!(tot > 0)) { s.cohorts = seedCohorts(pop); return; }
  if (diff < 0) { const k = pop / tot; for (let i = 0; i < NC; i++) c[i] *= k; return; }
  const w = ruleOf(world, 'movers', world.civs[s.civId]);
  const W = dot(w, REF);
  for (let i = 0; i < NC; i++) c[i] += W > 0 ? diff * w[i] * REF[i] / W : diff * REF[i];
}

/**
 * One month of births, natural deaths and ageing on the town's table, plus the famine dead
 * (frail) and the emigrants (movers), which leave before the births arrive. birthA / deathA
 * are today's crude annual rates, the rates of a town at its reference shape. Fills out with
 * the births, natural deaths, famine dead and emigrants (the caller sets s.population to
 * Σ cohorts).
 */
export function cohortMonth(world, s, civ, birthA, deathA, famineDead, emig, out) {
  const c = s.cohorts;
  const pop = cohortTotal(c);
  const ref = refIndices(birthA, deathA);
  // the levy share of the town's reference shape, for manpower (levyBase)
  s.flags.eref = Math.round(ref.elig * 1e4) / 1e4;
  // partners: men of 20–54 per woman of 15–44 against the reference's (x), and what the town is
  // used to (s.flags.mates, x averaged over about a century, never above 1): births fall when x
  // drops below 1 / pairK of that — a sudden loss of men hurts; a realm always at war has adapted
  const men = span(c, 0, MATE_LO, MATE_HI), women = span(c, NB, PAIR_LO, PAIR_HI);
  const x = women > 0 ? Math.min(1, men / (women * ref.mates)) : 1;
  let used = s.flags.mates;
  if (!(used > 0)) used = x;
  used += (x - used) / MATE_ADAPT;
  s.flags.mates = used;
  // births: today's crude rate, by the women of childbearing age against the reference, and by
  // partners
  let births = 0;
  if (pop > 0 && birthA > 0) {
    const fert = dot(ruleOf(world, 'fertility', civ), c) / pop;
    const K = ruleOf(world, 'pairK', civ);
    const pairing = Math.min(1, K * x / Math.max(0.2, used));
    births = birthA * pop / 12 * (fert / ref.fert) * pairing;
    if (COHORT_DEV.verify) { flow('births at crude', birthA * pop / 12); flow('births before pairing', births / pairing); }
  }
  // natural deaths: each band's hazard is deathA·M[b] / (Σ M·n per head at the reference) a year
  const mort = ruleOf(world, 'mortality', civ);
  const hz = deathA / (12 * ref.mort);
  let deaths = 0;
  for (let i = 0; i < NC; i++) {
    let h = hz * mort[i];
    if (h > 0.5) h = 0.5;
    const d = c[i] * h;
    c[i] -= d; deaths += d;
  }
  if (COHORT_DEV.verify) { flow('died', deaths); flow('died at crude', deathA * pop / 12); }
  let fam = 0, em = 0;
  if (famineDead > 0) fam = takeFrom(c, famineDead, ruleOf(world, 'frail', civ), null);
  if (emig > 0) em = takeFrom(c, emig, ruleOf(world, 'movers', civ), null);
  c[0] += births * BOY;
  c[NB] += births * (1 - BOY);
  ageAndRound(c);
  if (COHORT_DEV.verify) flow('births', births);
  out.births = births; out.deaths = deaths; out.famine = fam; out.emig = em;
  return out;
}

/**
 * End of the monthly pass (the bands were rounded to hundredths as they aged): the largest band
 * takes the remainder, so Σ cohorts = s.population exactly.
 */
export function settleCohorts(s) {
  const c = s.cohorts;
  if (c === undefined || c === null || c.length !== NC) return;
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

/**
 * The people town s counts for in manpower (today 3 % of them): its population at its reference
 * shape, more when the realm's levy rule names more of them (or the town has young men to spare),
 * fewer in a hollow generation. levy: ruleOf(world, 'levy', civ).
 */
export function levyBase(s, levy) {
  const c = s.cohorts;
  const pop = s.population || 0;
  if (!Array.isArray(c) || c.length !== NC) return pop;
  const tot = cohortTotal(c);
  const eref = s.flags && s.flags.eref > 0 ? s.flags.eref : REF_ELIGIBLE;
  return tot > 0 ? dot(levy, c) / tot * pop / eref : pop;
}

/**
 * A town's (or summed) table in numbers for the dossier: median age, children (< 15), elders
 * (65+), men and women of 15–44, working hands (15–64, plus half of 10–14 and 65–74 before era 4).
 */
export function cohortSummary(c, era = 0) {
  const tot = c ? cohortTotal(c) : 0;
  const out = { total: tot, median: 0, children: 0, elders: 0, men: 0, women: 0, working: 0 };
  if (!(tot > 0)) return out;
  const band = new Array(NB);
  for (let b = 0; b < NB; b++) band[b] = c[b] + c[NB + b];
  let acc = 0;
  for (let b = 0; b < NB; b++) {
    if (acc + band[b] >= tot / 2) { out.median = 5 * b + (band[b] > 0 ? 5 * (tot / 2 - acc) / band[b] : 0); break; }
    acc += band[b];
  }
  for (let b = 0; b < 3; b++) out.children += band[b];
  for (let b = 13; b < NB; b++) out.elders += band[b];
  out.men = span(c, 0, PAIR_LO, PAIR_HI);
  out.women = span(c, NB, PAIR_LO, PAIR_HI);
  for (let b = 3; b <= 12; b++) out.working += band[b];
  if (era < 4) out.working += 0.5 * (band[2] + band[13] + band[14]);
  return out;
}

/** Band labels for display. */
export const BAND_LABELS = Array.from({ length: NB }, (_, b) => (b === NB - 1 ? '80+' : `${5 * b}–${5 * b + 4}`));

/** Dev check (on in --trial and --cohort-check): the invariant after every monthly pass. */
export const COHORT_DEV = { verify: false, bad: 0, worst: 0, first: null, flows: {} };
function flow(key, n) { COHORT_DEV.flows[key] = (COHORT_DEV.flows[key] || 0) + n; }
export function verifyCohorts(world, s) {
  const c = s.cohorts;
  const d = Array.isArray(c) && c.length === NC ? Math.abs(cohortTotal(c) - (s.population || 0)) : Infinity;
  let neg = false;
  if (Array.isArray(c)) for (let i = 0; i < c.length; i++) if (!(c[i] >= 0)) neg = true;
  if (d >= 0.5 || neg) {
    COHORT_DEV.bad++;
    if (d > COHORT_DEV.worst) COHORT_DEV.worst = d;
    if (!COHORT_DEV.first) COHORT_DEV.first = { day: world.time.day, sid: s.id, pop: s.population, diff: d, neg };
  }
}
