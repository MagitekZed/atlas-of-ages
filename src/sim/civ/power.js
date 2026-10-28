// Who holds power (chunk 7, docs/design/who-holds-power.md): where a realm's money goes in peace
// as well as war. Phase A, the purse:
//
//   civ.purse = { court (share of income spent on the court), graft (share of the taxes officials
//                 keep), coin (debasement 0..0.6), ruin ({ k, from, until } after a revolt or a
//                 sack) | null, clean (the day corruption was last cut back), m (last month's
//                 accounts for the dossier: [taxes, graft, ruin and coin, court, kept]) }
//
// Monthly (purseMonthly, from civmonth.js's treasury step): the taxes come in; corruption, ruin
// and a debased coin take their share; the court takes its share of what is left, and above the
// realm's own reserve (reserveYears: four years of income × its thrift) four tenths a year of the
// excess. A crown in arrears may clip its coin. Yearly (purseYearly, at the realm's own month):
// the court's share and corruption drift toward their targets, and the coin recovers.
//
// The rules a society may vary (ext): 'reserveRule' (mul on the reserve), 'courtSpend' (mul on
// the court's share). Draws from world.rng only for the clipping of the coin.

import { temperOf, TP } from '../../core/character.js';
import { mulOf, firstOf, hasProviders } from '../../core/ext.js';
import { DAYS_PER_YEAR as DPY } from '../../core/constants.js';
import { fin, record, rateOk } from './state.js';
import { theName, TheName, rulerName, pick } from './prose.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r3 = (v) => Math.round(fin(v) * 1000) / 1000;

/** The court's share of income by government (the rest of the realm's character bends it). */
const COURT = { tribe: 0.03, chiefdom: 0.05, kingdom: 0.07, theocracy: 0.06, horde: 0.06, empire: 0.1, republic: 0.04, merchant: 0.04, feudal: 0.07, constitutional: 0.05, democracy: 0.03, dictatorship: 0.09 };
/** How much each government keeps in reserve, against the four years of the default. */
const THRIFT = { tribe: 0.75, chiefdom: 0.85, horde: 0.5, merchant: 2, republic: 1.2, democracy: 1, constitutional: 1.1 };
/** Corruption by government: added to its target. */
const GRAFT = { empire: 0.03, dictatorship: 0.04, horde: 0.02, democracy: -0.04, constitutional: -0.02, republic: -0.01, merchant: -0.01 };

export const COIN_MAX = 0.6;

/** The realm's purse, made on first use (old saves too). */
export function purseOf(civ) {
  let p = civ.purse;
  if (!p || typeof p !== 'object') p = civ.purse = { court: COURT[civ.government] ?? 0.1, graft: 0.05, coin: 0, ruin: null, clean: null, m: null, ry: 4 };
  return p;
}

/** The ruler's temperament, or the middle of every axis. */
const temper = (civ) => (civ.ruler ? temperOf(civ.ruler, civ) : [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
const steward = (civ) => (civ.ruler && Array.isArray(civ.ruler.sk) ? fin(civ.ruler.sk[2], 0.5) : 0.5);

/**
 * Years of income the realm keeps in reserve: four × its thrift (its government, a miser or a
 * spender on the throne, its people's own rule 'reserveRule'). Most realms keep three to five;
 * a merchant state, a miserly king or a hoarding people far more.
 */
export function reserveYears(world, civ) {
  const tp = temper(civ);
  let k = THRIFT[civ.government] ?? 1;
  k *= 0.55 + 0.9 * tp[TP.GRE] * (1.2 - 0.4 * tp[TP.AMB]);
  if (hasProviders('reserveRule')) k *= mulOf('reserveRule', world, civ);
  return clamp(4 * k, 1, 40);
}

/** The government's base share for the court (the ruler and the court's age bend it). */
export const courtBase = (civ) => COURT[civ.government] ?? 0.1;

/** The court's share of income it is drifting toward: the government's, bent by the ruler and the court's age. */
function courtTarget(world, civ) {
  const tp = temper(civ);
  const base = COURT[civ.government] ?? 0.1;
  // ambition spends on display, largesse on favourites; a skilled steward wastes less
  const ruler = (0.5 + 0.7 * tp[TP.AMB] + 0.5 * (1 - tp[TP.GRE])) * (1.15 - 0.3 * steward(civ));
  // a court grows grander with the generations under one government
  const age = (world.time.day - fin(civ.flags.govSince, 0)) / DPY;
  const grand = 1 + 0.4 * Math.min(1, age / 200);
  let t = base * ruler * grand;
  if (hasProviders('courtSpend')) t *= mulOf('courtSpend', world, civ);
  return clamp(t, 0.01, 0.4);
}

/** The share of the taxes officials keep that corruption drifts toward. */
function graftTarget(world, civ) {
  const p = purseOf(civ);
  const since = (world.time.day - Math.max(fin(civ.flags.govSince, 0), fin(p.clean, 0))) / DPY;
  const n = civ.settlementIds.length;
  const tp = temper(civ);
  return clamp(0.02 + 0.06 * Math.min(2, fin(civ.flags.overext)) + 0.03 * Math.log2(1 + since / 60) + 0.03 * Math.log2(Math.max(1, n / 12))
    - 0.1 * (steward(civ) - 0.5) - 0.03 * (tp[TP.HON] - 0.5) + (GRAFT[civ.government] ?? 0), 0.01, 0.4);
}

/** The share of income a ruin still takes today (it eases to nothing by its end). */
export function ruinNow(world, civ) {
  const r = civ.purse && civ.purse.ruin;
  if (!r || !(r.until > world.time.day)) return 0;
  return fin(r.k) * (r.until - world.time.day) / Math.max(1, r.until - r.from);
}

/** A revolt, civil war or sacked capital leaves the realm poorer for years: k (share of income), years. */
export function addRuin(world, civ, k, years) {
  if (!civ || !civ.alive) return;
  const p = purseOf(civ);
  const day = world.time.day;
  const left = ruinNow(world, civ);
  const kk = clamp(Math.max(left, 0) + k, 0, 0.45);
  p.ruin = { k: r3(kk), from: day, until: day + Math.round(Math.max(1, years) * DPY) };
}

/**
 * One month of the purse. gross: the taxes come in. Returns { income, court }: what reaches the
 * treasury after corruption, ruin and the coin, and what the court spends (an expense).
 */
export function purseMonthly(world, civ, gross, treasury) {
  const p = purseOf(civ);
  // the land law (laws.js): crown land yields more taxes, land held in fiefs less
  gross *= civ.laws?.land === 'crown' ? 1.08 : civ.laws?.land === 'nobles' ? 0.9 : 1;
  const graft = gross * fin(p.graft);
  const net = gross - graft;
  const lost = net * Math.min(0.6, ruinNow(world, civ) + 0.25 * fin(p.coin));
  const income = net - lost;
  // the court: its share, and above the reserve four tenths of the excess a year (the reserve's
  // years are worked out once a year: p.ry)
  const reserve = Math.max(100, income * 12 * fin(p.ry, 4));
  const excess = Math.max(0, fin(treasury) - reserve);
  const court = income * fin(p.court) + excess * (0.4 / 12);
  p.m = [Math.round(gross), Math.round(graft), Math.round(lost), Math.round(court), Math.round(reserve)];
  return { income, court };
}

/** A crown in arrears may clip its coin: six months of income at once, a debased coin for years. */
export function maybeDebase(world, civ, income) {
  const p = purseOf(civ);
  if (!(civ.treasury < -income * 6) || fin(civ.forces?.arrears) < 6 || fin(p.coin) >= COIN_MAX - 0.01 || !(income > 0)) return;
  const tp = temper(civ);
  if (!world.rng.chance(0.015 * (0.5 + tp[TP.GRE] + 0.5 * (1 - tp[TP.HON])))) return;
  if (!rateOk(world, `debase:${civ.id}`, 10)) return;   // at most once a decade
  civ.treasury += income * 6;
  p.coin = r3(Math.min(COIN_MAX, fin(p.coin) + 0.15));
  {
    const who = civ.ruler ? rulerName(civ.ruler) : TheName(civ);
    record(world, { cat: 'civ', imp: p.coin >= 0.3 ? 3 : 2, key: 'realm.debase', civ, tags: ['coin'], text: pick(world, [
      `${who} had the coin of ${theName(civ)} clipped and mixed with base metal to pay ${civ.ruler ? 'the crown’s' : 'its'} debts; prices began to climb.`,
      `With the treasury empty, ${theName(civ)} struck its coin light and grey: the soldiers were paid, and the markets learned to weigh every piece.`,
    ]) });
  }
}

/** Once a year, at the realm's own month: the court and corruption drift; the coin recovers. */
export function purseYearly(world, civ) {
  const p = purseOf(civ);
  p.ry = r3(reserveYears(world, civ));
  p.court = r3(fin(p.court) + (courtTarget(world, civ) - fin(p.court)) * 0.2);
  const before = fin(p.graft);
  p.graft = r3(before + (graftTarget(world, civ) - before) * 0.1);
  if (before < 0.25 && p.graft >= 0.25 && rateOk(world, `graft:${civ.id}`, 50)) {
    record(world, { cat: 'civ', imp: 2, key: 'realm.corruption', civ, tags: ['corruption'], text: pick(world, [
      `In ${theName(civ)} a quarter of the taxes now stuck to the fingers of the officials who gathered them.`,
      `The tax-farmers of ${theName(civ)} grew rich while its treasury grew thin.`,
    ]) });
  }
  // a debased coin regains its name slowly; a sound steward with money to spare restores it
  if (fin(p.coin) > 0) {
    p.coin = r3(Math.max(0, fin(p.coin) - 0.015));
    const income = fin(civ.income);
    if (p.coin >= 0.2 && steward(civ) > 0.6 && civ.treasury > income * 12 * 2) {
      civ.treasury -= income * 12 * p.coin;
      p.coin = r3(Math.max(0, p.coin - 0.3));
      if (rateOk(world, `recoin:${civ.id}`, 20)) record(world, { cat: 'civ', imp: 2, key: 'realm.recoin', civ, tags: ['coin'], text: `${civ.ruler ? rulerName(civ.ruler) : TheName(civ)} called in the clipped coin of ${theName(civ)} and struck it anew in good silver.` });
    }
  }
  if (p.ruin && !(p.ruin.until > world.time.day)) p.ruin = null;
}

/** Cut corruption back (a reform, a purge): its share falls by part, and the clock restarts. */
export function cleanGraft(world, civ, part = 0.4) {
  const p = purseOf(civ);
  p.graft = r3(fin(p.graft) * (1 - part));
  p.clean = world.time.day;
}

// ---------------------------------------------------------------------------
// Phase B, the estates:
//
//   civ.est = [[people share, wealth share, rights 0..1, loyalty 0..1] × 5] in the order of ROLES:
//             the great (nobles), clergy, townsfolk, commoners, the unfree.
//
// Yearly (estatesYearly, at the realm's own month): their sizes from the towns' trades (clergy
// from the clergy; townsfolk from craftsmen, merchants, scholars and builders in towns; the great
// a share by government; the unfree a share under serfdom or slavery; commoners the rest); their
// wealth (the great hold far more than their numbers); their rights drifting toward what the
// government and laws give; their loyalty drifting toward content (rights matching power) or
// angry, by taxes, hunger, coin, faith, land and the court. Read by stability ('estates') and by
// each town's grievance (estateGrievance). A people may name and bend its own estates (ext
// 'estates': { names: [5], rights: [5 deltas], unfree: bool }).

export const ROLES = ['great', 'clergy', 'towns', 'commons', 'unfree'];
const URBAN = [4, 5, 8, 9];   // craftsmen, merchants, scholars, builders (civ/jobs.js TRADES)
const GREAT = { tribe: 0.03, chiefdom: 0.035, horde: 0.04, kingdom: 0.025, feudal: 0.03, empire: 0.02, theocracy: 0.015, dictatorship: 0.01, republic: 0.012, merchant: 0.01, constitutional: 0.012, democracy: 0.006 };
/** The rights each government gives [great, clergy, towns, commons, unfree]. */
const RIGHTS = {
  tribe: [0.6, 0.5, 0.4, 0.6, 0.05], chiefdom: [0.7, 0.5, 0.35, 0.45, 0.05], kingdom: [0.75, 0.6, 0.4, 0.3, 0.05], theocracy: [0.5, 0.9, 0.4, 0.3, 0.05],
  horde: [0.85, 0.4, 0.2, 0.35, 0.05], empire: [0.65, 0.55, 0.45, 0.3, 0.05], republic: [0.5, 0.4, 0.7, 0.5, 0.05], merchant: [0.45, 0.35, 0.85, 0.35, 0.05],
  feudal: [0.9, 0.6, 0.35, 0.2, 0.05], constitutional: [0.55, 0.45, 0.65, 0.55, 0.1], democracy: [0.35, 0.35, 0.75, 0.75, 0.2], dictatorship: [0.4, 0.35, 0.35, 0.3, 0.05],
};
const WEALTH = [25, 3, 2.5, 1, 0.15];

/** A people's own estates (ext 'estates'), or null. */
function ownEstates(world, civ) {
  if (!hasProviders('estates')) return null;
  const e = firstOf('estates', world, civ);
  return e && typeof e === 'object' ? e : null;
}

/** The estates' names for the realm (a people's own, else by era and government; null: none). */
export function estateNames(world, civ) {
  const own = ownEstates(world, civ);
  if (own && Array.isArray(own.names) && own.names.length === 5) return own.names;
  const era = fin(civ.tech?.era, 0), g = civ.government, bond = civ.laws?.bond;
  return [
    g === 'tribe' || g === 'chiefdom' ? 'the chiefs’ kin' : g === 'horde' ? 'the khans’ kin' : g === 'republic' || g === 'merchant' ? 'patricians' : era >= 6 ? 'the aristocracy' : 'nobles',
    era <= 0 ? 'seers' : g === 'theocracy' ? 'the priesthood' : 'clergy',
    era <= 1 ? 'craftsfolk' : g === 'merchant' ? 'burghers' : era >= 6 ? 'the middle class' : 'townsfolk',
    era <= 1 ? 'tribesfolk' : era >= 6 ? 'workers' : 'peasants',
    bond === 'slave' ? 'slaves' : bond === 'serf' ? 'serfs' : null,
  ];
}

/** The people, wealth and rights each estate would have now: [[p, w, rT] × 5], or null (no towns counted). */
function estateShape(world, civ, agg) {
  let all = 0, cl = 0, ur = 0;
  for (const s of agg.ss) {
    const j = s.jobs;
    if (!Array.isArray(j)) continue;
    let t = 0;
    for (const v of j) t += v;
    if (!(t > 0)) continue;
    const k = Math.max(0, fin(s.population)) / t;
    all += t * k;
    cl += fin(j[7]) * k;
    if ((s.tier | 0) >= 2) { let u = 0; for (const i of URBAN) u += fin(j[i]); for (let i = 11; i < j.length; i++) u += fin(j[i]); ur += u * k; }
  }
  if (!(all > 0)) return null;
  const law = civ.laws || {};
  const own = ownEstates(world, civ);
  let g = GREAT[civ.government] ?? 0.02;
  if (law.land === 'nobles') g *= 1.4; else if (law.land === 'freeholds') g *= 0.7;
  const c = cl / all, t = ur / all;
  let rest = Math.max(0.05, 1 - g - c - t);
  let u = 0;
  if (!(own && own.unfree === false)) {
    if (law.bond === 'serf') u = rest * 0.4;
    else if (law.bond === 'slave') u = Math.min(0.3, 0.06 + 0.04 * Math.min(5, fin(civ.flags.conquests)));
  }
  rest = Math.max(0.02, rest - u);
  const p = [g, c, t, rest, u];
  const sum = p.reduce((a, v) => a + v, 0);
  const rT = (RIGHTS[civ.government] || RIGHTS.kingdom).slice();
  // the laws move rights (phase C): elective crowns and fiefs raise the great, freeholds the commons
  if (law.inherit === 'elective') rT[0] += 0.1;
  if (law.land === 'nobles') { rT[0] += 0.1; rT[3] -= 0.05; } else if (law.land === 'crown') rT[0] -= 0.1; else if (law.land === 'freeholds') rT[3] += 0.1;
  if (law.faith === 'one') rT[1] += 0.1; else if (law.faith === 'free') rT[1] -= 0.1;
  if (law.bond === 'serf') rT[3] -= 0.1;
  if (own && Array.isArray(own.rights)) for (let i = 0; i < 5; i++) rT[i] += fin(own.rights[i]);
  let wsum = 0;
  const w = p.map((x, i) => { const v = (x / sum) * WEALTH[i] * (i === 2 ? 0.7 + 0.6 * fin(civ.traits?.commerce, 0.5) : 1); wsum += v; return v; });
  return p.map((x, i) => [x / sum, wsum > 0 ? w[i] / wsum : 0, clamp(rT[i], 0, 1)]);
}

/** Each estate's power (sums to 1): its wealth and its rights, and the great their arms. */
export function estatePower(civ) {
  const e = civ.est;
  if (!Array.isArray(e) || e.length !== 5) return null;
  const arms = civ.forces?.sys === 'feudal' || civ.government === 'horde' || civ.government === 'feudal' ? 0.15 : 0.06;
  const raw = e.map(([p, w, r], i) => (p > 0 ? Math.pow(Math.max(0, w), 0.7) * (0.3 + r) + (i === 0 ? arms : 0) : 0));
  const s = raw.reduce((a, v) => a + v, 0);
  return s > 0 ? raw.map((v) => v / s) : raw;
}

/** Once a year: the estates' sizes, wealth, rights and loyalty. */
export function estatesYearly(world, civ, agg) {
  const shape = estateShape(world, civ, agg);
  if (!shape) return;
  const fresh = !Array.isArray(civ.est) || civ.est.length !== 5;
  const est = fresh ? shape.map(([p, w, r]) => [p, w, r, 0.55]) : civ.est;
  for (let i = 0; i < 5; i++) {
    const [p, w, rT] = shape[i];
    est[i][0] = p; est[i][1] = w;
    est[i][2] = fresh ? rT : est[i][2] + (rT - est[i][2]) * 0.1;
  }
  civ.est = est;
  const pw = estatePower(civ);
  const tp = temper(civ);
  const law = civ.laws || {};
  const tax = fin(civ.taxRate, 0.08), coin = fin(civ.purse?.coin), court = fin(civ.purse?.court, 0.06);
  const hunger = div0(agg.ss.filter((s) => fin(s.famine) >= 2).length, agg.ss.length);
  const weary = Math.min(1, fin(civ.warWeariness));
  const purged = fin(civ.court?.purged) > world.time.day ? 0.2 : 0;
  const why = (civ.estWhy = Array.isArray(civ.estWhy) && civ.estWhy.length === 5 ? civ.estWhy : [null, null, null, null, null]);
  for (let i = 0; i < 5; i++) {
    const [p, , r, l] = est[i];
    if (!(p > 0)) { est[i][3] = 0.55; why[i] = null; continue; }
    // content by default; angry when its rights fall short of what its power claims. Each term
    // is kept by name, so a rising can say what it rose over (estWhy: the worst of them)
    const want = 0.1 + 0.9 * pw[i];
    const terms = { rights: 0.4 * clamp(r - want, -0.5, 0.3) };
    if (i === 0) Object.assign(terms, { court: 0.8 * (court - 0.06), land: law.land === 'nobles' ? 0.08 : law.land === 'crown' ? -0.1 : 0, ruler: 0.1 * (tp[TP.HON] - 0.5), purge: -purged });
    else if (i === 1) Object.assign(terms, { faith: (law.faith === 'one' ? 0.08 : law.faith === 'free' ? -0.15 : 0) - 0.2 * fin(civ.flags.faithDis), ruler: 0.3 * (tp[TP.PIE] - 0.5) });
    else if (i === 2) Object.assign(terms, { tax: -1.5 * Math.max(0, tax - 0.1), coin: -0.6 * coin, rights2: civ.government === 'merchant' || civ.government === 'republic' ? 0.05 : 0, war: -0.1 * weary });
    else if (i === 3) Object.assign(terms, { tax: -2.0 * Math.max(0, tax - 0.08), hunger: -0.8 * hunger, court: tax > 0.12 ? -0.6 * Math.max(0, court - 0.08) : 0,
      land: law.land === 'freeholds' ? 0.08 : 0, bond: law.bond === 'serf' ? -0.12 : 0, ruler: 0.1 * (tp[TP.MER] - 0.5), war: -0.2 * weary });
    else Object.assign(terms, { rights: 0, bond: law.bond === 'slave' ? -0.4 : -0.3, ruler: 0.2 * (tp[TP.MER] - 0.5), hunger: -0.2 * hunger });
    let t = 0.6, worst = null, wv = -0.02;
    for (const k in terms) { t += terms[k]; if (terms[k] < wv) { wv = terms[k]; worst = k === 'rights2' ? 'rights' : k; } }
    why[i] = worst;
    // anger rises faster than it fades
    const tt = clamp(t, 0, 1);
    est[i][3] = l + (tt - l) * (tt < l ? 0.25 : 0.12);
  }
  for (const row of est) for (let k = 0; k < 4; k++) row[k] = r3(row[k]);
}
const div0 = (a, b) => (b > 0 ? a / b : 0);

/** The estates' part of stability: each estate's loyalty against content, weighed by its power. */
export function estatesStability(civ) {
  const pw = estatePower(civ);
  if (!pw) return 0;
  let s = 0;
  for (let i = 0; i < 5; i++) s += pw[i] * (fin(civ.est[i][3], 0.55) - 0.55);
  return 0.3 * s;
}

/** A town's grievance from its own estates' anger: its commoners, unfree and townsfolk, by its trades. */
export function estateGrievance(civ, s) {
  const e = civ.est, j = s.jobs;
  if (!Array.isArray(e) || e.length !== 5 || !Array.isArray(j)) return 0;
  // content estates (loyalty 0.4 and above) add nothing: most months, most realms
  if (!(fin(e[2][3], 0.55) < 0.4 || fin(e[3][3], 0.55) < 0.4 || (e[4][0] > 0 && fin(e[4][3], 0.55) < 0.4))) return 0;
  let t = 0;
  for (const v of j) t += v;
  if (!(t > 0)) return 0;
  let urb = 0;
  if ((s.tier | 0) >= 2) { for (const i of URBAN) urb += fin(j[i]); for (let i = 11; i < j.length; i++) urb += fin(j[i]); }
  const towns = urb / t, rest = Math.max(0, 1 - towns - fin(j[7]) / t);
  const bound = e[3][0] + e[4][0] > 0 ? e[4][0] / (e[3][0] + e[4][0]) : 0;
  const anger = (i) => Math.max(0, 0.4 - fin(e[i][3], 0.55));
  return 0.6 * (towns * anger(2) + rest * ((1 - bound) * anger(3) + bound * anger(4)));
}
