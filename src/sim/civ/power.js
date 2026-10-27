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
import { mulOf, hasProviders } from '../../core/ext.js';
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
  if (!p || typeof p !== 'object') p = civ.purse = { court: COURT[civ.government] ?? 0.1, graft: 0.05, coin: 0, ruin: null, clean: null, m: null };
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
  const graft = gross * fin(p.graft);
  const net = gross - graft;
  const lost = net * Math.min(0.6, ruinNow(world, civ) + 0.25 * fin(p.coin));
  const income = net - lost;
  // the court: its share, and above the reserve four tenths of the excess a year
  const reserve = Math.max(100, income * 12 * reserveYears(world, civ));
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
