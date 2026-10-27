// Debt between crowns (chunk 3, docs/design/why-wars.md): loans and reparations.
//
//   world.sys.diplomacy.loans = [{ id, from, to, owed, pay, rate, start, until, arrears, kind }]
//     from     the lender: a realm id (a banking house: −1 − its id)
//     owed     what is still owed · pay  the monthly payment · rate  yearly interest
//     arrears  months in a row the debtor could not pay in full · kind  'reparations' | 'loan'
//
//   world.sys.diplomacy.houses = [{ id, name, civ, seat, capital, founded, failed }]
//   world.sys.diplomacy.debtCb = [{ a, b, owed, until }]   a may make war on b to recover owed
//
// Borrowing: monthly, a realm of the Bronze Age or later that is at war or short of money (its
// treasury under six months of expenses at war, three at peace), with fewer than three debts and
// no default in thirty years, may borrow 12 to 24 months of its income (15 % a month). The lender
// is the cheapest offer among realms in contact, at peace with it, well disposed (+10) and twice
// as rich as the loan, and the banking houses of realms at peace with it: 8 % a year, +10 % × its
// instability, +6 % for each default in the last century, −2 % between allies, +2 % from a house,
// × the ext 'lendingRule' (first; it may forbid a lender). Repaid monthly over 10 to 20 years.
//
// Paying: interest, then the payment from the treasury, never more than half of it; a payment it
// cannot make in full adds to its arrears. A loan taken at war is repaid once the debtor is at
// peace again (the interest runs on meanwhile). After a year in arrears the debtor may default (4 % a
// month, more the longer it runs, under a cruel or mad ruler, in a weak state, under a crushing
// debt): it loses legitimacy and stability and its credit for thirty years; a realm it cheated
// turns hostile and gains the 'debt' casus belli (war.js) for thirty years; a house that loses
// more than half its capital fails, and its seat is ruined. Reparations are a loan from the
// victor at no interest (war.js), defaulted on the same way. No payment crosses a battle line, a
// debt dies with either party, and one unpaid ten years after it fell due is written off.
//
// Banking houses: yearly, a realm of the Medieval Age or later may found one (5 %) in its richest
// trade town (tier 3 or more, trade in the world's top tenth); at most one per realm and eight in
// the world. Its capital starts at a year of the seat's trade and grows by a twelfth of it each
// month, with the interest it is paid. A house whose seat changes hands or falls moves to its
// realm's next-richest town, and closes with its realm.
//
// Exports: addReparations, debtsMonthly, housesMonthly, loansOf, owedBy, debtClaim,
//          settleDebtClaim, housesOf, houseName, monthlyIncome (and the yearRecord 'debt')

import { chronicle } from '../../core/chronicle.js';
import { on } from '../../core/hooks.js';
import { areAtWar, liveCivs, liveSettlements, rel, addOpinion } from '../../core/entities.js';
import { firstOf, hasProviders, registerProvider } from '../../core/ext.js';
import { makePerson } from '../../core/names.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH } from '../../core/constants.js';
import { clamp } from '../../core/util.js';
import { civName, capFirst, capitalOf, eraOf, hashPick, rateOk, rulerHas, hasTreaty, finite } from './common.js';

const MAX_LOANS = 3;          // debts a realm may carry at once
const CREDIT_YEARS = 30;      // years a defaulter can borrow from no one
const MAX_HOUSES = 8;

/** A realm's monthly income (a floor from its people when the treasury has not run yet). */
export function monthlyIncome(civ) {
  if (finite(civ.income) && civ.income > 0) return civ.income;
  return Math.max(1, (civ.population || 0) * 0.002);
}

function debtState(world) {
  const st = (world.sys.diplomacy ||= {});
  st.loans ||= [];
  st.houses ||= [];
  st.debtCb ||= [];
  st.ctr ||= {};
  if (!finite(st.nextLoan)) st.nextLoan = 1;
  return st;
}
const count = (st, k) => { st.ctr[k] = (st.ctr[k] || 0) + 1; };

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * The loser owes the victor `sum`, paid monthly over `years` at no interest. Returns the record.
 */
export function addReparations(world, from, to, sum, years) {
  const st = debtState(world);
  const day = world.time.day;
  const n = Math.max(12, Math.round(years * 12));
  const rec = { id: st.nextLoan++, from: to, to: from, owed: round2(sum), pay: round2(sum / n), rate: 0, start: day, until: day + Math.round(years * DAYS_PER_YEAR), arrears: 0, kind: 'reparations' };
  st.loans.push(rec);
  return rec;
}

/** Debts owed by (to = civId) or to (from = civId) a realm (the realm dossier). */
export function loansOf(world, civId) {
  const ls = (world.sys.diplomacy && world.sys.diplomacy.loans) || [];
  return ls.filter((l) => l.to === civId || l.from === civId);
}

/** What a realm owes in all, and the part of it in reparations. */
export function owedBy(world, civId) {
  let all = 0, rep = 0;
  for (const l of (world.sys.diplomacy && world.sys.diplomacy.loans) || []) {
    if (l.to !== civId) continue;
    all += l.owed;
    if (l.kind === 'reparations') rep += l.owed;
  }
  return { all, rep };
}

const houseOf = (st, from) => (from < 0 ? st.houses.find((h) => h.id === -1 - from) || null : null);
const yearIncome = (civ) => 12 * monthlyIncome(civ);

/** Defaults by civ in the last century (its credit record). */
function defaultsOf(world, civ) {
  const d = civ.flags && civ.flags.dflts;
  if (!Array.isArray(d)) return 0;
  let n = 0;
  for (const day of d) if (world.time.day - day < 100 * DAYS_PER_YEAR) n++;
  return n;
}

/**
 * Monthly, from diplomacy: new loans, then interest, payments, arrears and defaults.
 * Every draw is on world.rng in a fixed order: realms by id, then debts in the order made.
 */
export function debtsMonthly(world) {
  const st = debtState(world);
  borrowing(world, st);
  if (!st.loans.length) return;
  const day = world.time.day;
  const keep = [];
  const warring = new Set(warringIds(world));
  for (const l of st.loans) {
    const debtor = world.civs[l.to];
    const lender = l.from >= 0 ? world.civs[l.from] : null;
    const house = houseOf(st, l.from);
    if (!debtor || !debtor.alive || (l.from >= 0 && (!lender || !lender.alive)) || (l.from < 0 && (!house || house.failed != null))) continue;
    if (day > l.until + 10 * DAYS_PER_YEAR) continue;   // written off
    if (l.from >= 0 && areAtWar(world, l.to, l.from)) { keep.push(l); continue; }
    if (l.rate > 0) l.owed = round2(l.owed * (1 + l.rate / 12));
    // a war loan is repaid once the war is over; the interest runs on meanwhile
    if (l.kind === 'loan' && warring.has(l.to)) { keep.push(l); continue; }
    const due = Math.min(l.owed, l.pay);
    const can = Math.max(0, finite(debtor.treasury) ? debtor.treasury : 0) * 0.5;
    const paid = Math.min(due, can);
    if (paid > 0) {
      debtor.treasury -= paid;
      if (lender) lender.treasury = (finite(lender.treasury) ? lender.treasury : 0) + paid;
      else if (house) house.capital = round2(house.capital + paid);
      l.owed = round2(l.owed - paid);
    }
    l.arrears = paid >= due * 0.999 ? 0 : clamp((l.arrears || 0) + 1, 0, 600);
    if (l.arrears >= 12 && defaults(world, st, l, debtor, lender, house)) continue;
    if (l.owed > 0.01) keep.push(l);
  }
  st.loans = keep;
}

/** A realm short of money borrows from the cheapest willing lender. */
function borrowing(world, st) {
  const rng = world.rng;
  const day = world.time.day;
  const atWar = new Set(warringIds(world));
  for (const c of liveCivs(world)) {
    if (eraOf(c) < 1 || !c.settlementIds.length) continue;
    if (finite(c.flags.dflt) && day - c.flags.dflt < CREDIT_YEARS * DAYS_PER_YEAR) continue;
    const war = atWar.has(c.id);
    const need = (war ? 6 : 3) * Math.max(1, finite(c.expenses) ? c.expenses : 0);
    if (!((finite(c.treasury) ? c.treasury : 0) < need)) continue;
    let mine = 0;
    for (const l of st.loans) if (l.to === c.id) mine++;
    if (mine >= MAX_LOANS || !rng.chance(0.15)) continue;
    const P = round2(rng.float(12, 24) * monthlyIncome(c));
    const offer = bestOffer(world, st, c, P);
    if (!offer) continue;
    const years = rng.int(10, 20), n = years * 12, rm = offer.rate / 12;
    const pay = round2(rm > 0 ? (P * rm) / (1 - Math.pow(1 + rm, -n)) : P / n);
    st.loans.push({ id: st.nextLoan++, from: offer.from, to: c.id, owed: P, pay, rate: Math.round(offer.rate * 1000) / 1000, start: day, until: day + years * DAYS_PER_YEAR, arrears: 0, kind: 'loan' });
    if (offer.civ) offer.civ.treasury -= P; else offer.house.capital = round2(offer.house.capital - P);
    c.treasury = (finite(c.treasury) ? c.treasury : 0) + P;
    count(st, 'loans');
    if (P >= yearIncome(c) && rateOk(world, `loan:${c.id}`, 30 * DAYS_PER_YEAR) && rateOk(world, 'loan', 2 * DAYS_PER_YEAR)) {
      const cap = capitalOf(world, c);
      const who = offer.civ ? civName(offer.civ) : houseName(world, offer.house);
      chronicle(world, {
        cat: 'civ', imp: 1, x: cap ? cap.x : null, y: cap ? cap.y : null, civId: c.id, sid: cap ? cap.id : null, icon: 'coin', key: 'debt.loan', ref: { k: 'civ', id: c.id }, tags: ['debt'],
        text: hashPick([
          `${capFirst(civName(c))} borrowed heavily from ${who}${war ? ' to pay for its war' : ''}.`,
          `With its coffers empty, ${civName(c)} took a great loan from ${who}.`,
        ], c.id, day),
      });
    }
  }
}

function warringIds(world) {
  const out = [];
  for (const w of world.wars) if (w && w.active) { for (const id of w.attackers) out.push(id); for (const id of w.defenders) out.push(id); }
  return out;
}

/** The cheapest lender for c, or null: { from, rate, civ? , house? }. */
function bestOffer(world, st, c, P) {
  const risk = 0.08 + 0.1 * (1 - clamp(finite(c.stability) ? c.stability : 0.5, 0, 1)) + 0.06 * defaultsOf(world, c);
  let best = null;
  const consider = (from, rate, lenderCiv, house) => {
    if (hasProviders('lendingRule')) {
      const r = firstOf('lendingRule', world, lenderCiv, c);
      if (r && r.allowed === false) return;
      if (r && finite(r.rateMul) && r.rateMul > 0) rate *= r.rateMul;
    }
    if (!best || rate < best.rate - 1e-9) best = { from, rate, civ: house ? null : lenderCiv, house };
  };
  for (const k in c.relations) {
    const L = world.civs[k];
    if (!L || !L.alive || L.id === c.id || eraOf(L) < 1 || areAtWar(world, L.id, c.id)) continue;
    if (!((finite(L.treasury) ? L.treasury : 0) >= 2 * P)) continue;
    const rl = L.relations[c.id];
    if (!rl || !(rl.opinion >= 10)) continue;
    consider(L.id, risk - (hasTreaty(world, L.id, c.id, 'alliance') ? 0.02 : 0), L, null);
  }
  for (const h of st.houses) {
    if (h.failed != null || !(h.capital >= 2 * P)) continue;
    const L = world.civs[h.civ];
    if (!L || !L.alive || (L.id !== c.id && areAtWar(world, L.id, c.id))) continue;
    consider(-1 - h.id, risk + 0.02, L, h);
  }
  return best;
}

/** l is a year or more in arrears: the debtor may repudiate it. Returns true if it did. */
function defaults(world, st, l, debtor, lender, house) {
  let p = 0.04 * (1 + (l.arrears - 12) / 12);
  if (rulerHas(debtor, 'cruel') || rulerHas(debtor, 'mad')) p *= 1.5;
  if (finite(debtor.stability) && debtor.stability < 0.3) p *= 1.5;
  if (l.owed > 5 * yearIncome(debtor)) p *= 1.5;
  if (!world.rng.chance(Math.min(0.5, p))) return false;
  const day = world.time.day;
  debtor.legitimacy = clamp((finite(debtor.legitimacy) ? debtor.legitimacy : 0.6) - 0.1, 0, 1);
  debtor.stability = clamp((finite(debtor.stability) ? debtor.stability : 0.6) - 0.05, 0, 1);
  debtor.flags.dflt = day;
  debtor.flags.dflts = (Array.isArray(debtor.flags.dflts) ? debtor.flags.dflts : []).filter((d) => day - d < 100 * DAYS_PER_YEAR).concat(day).slice(-5);
  count(st, 'defaults');
  let failed = false;
  if (lender) {
    addOpinion(world, lender.id, debtor.id, -40, false);
    const r = rel(world, lender.id, debtor.id);
    r.grievance = Math.min(100, (r.grievance || 0) + 30);
    st.debtCb = st.debtCb.filter((d) => !(d.a === lender.id && d.b === debtor.id));
    st.debtCb.push({ a: lender.id, b: debtor.id, owed: l.owed, until: day + CREDIT_YEARS * DAYS_PER_YEAR });
  } else if (house) {
    const before = house.capital + l.owed;
    house.capital = round2(Math.max(0, house.capital));
    if (l.owed > 0.5 * before) failed = failHouse(world, st, house, debtor);
  }
  const big = topRealm(world, debtor, 5);
  if (rateOk(world, `default:${debtor.id}`, 20 * DAYS_PER_YEAR)) {
    const cap = capitalOf(world, debtor);
    const who = lender ? civName(lender) : house ? houseName(world, house) : 'its creditors';
    const kind = l.kind === 'reparations' ? 'the reparations it owed' : 'its debts';
    chronicle(world, {
      cat: 'civ', imp: big ? 3 : 2, x: cap ? cap.x : null, y: cap ? cap.y : null, civId: debtor.id, sid: cap ? cap.id : null, icon: 'coin', key: 'debt.default', ref: { k: 'civ', id: debtor.id }, tags: ['debt'],
      text: hashPick([
        `${capFirst(civName(debtor))} repudiated ${kind} to ${who}${failed ? ', and the house was ruined' : ''}.`,
        `Unable to pay, ${civName(debtor)} defaulted on ${kind} to ${who}${lender ? `, who swore to have its due` : ''}.`,
      ], debtor.id, day),
    });
  }
  return true;
}

function topRealm(world, civ, n) {
  const p = civ.population || 0;
  let above = 0;
  for (const c of liveCivs(world)) if (c !== civ && (c.population || 0) > p && ++above >= n) return false;
  return true;
}

function failHouse(world, st, house, debtor) {
  house.failed = world.time.day;
  const seat = world.settlements[house.seat];
  if (seat && seat.alive) seat.wealth = Math.max(0, (finite(seat.wealth) ? seat.wealth : 0) * 0.5);
  count(st, 'houseFails');
  chronicle(world, {
    cat: 'civ', imp: 2, x: seat ? seat.x : null, y: seat ? seat.y : null, civId: house.civ, sid: seat ? seat.id : null, icon: 'coin', key: 'bank.failed', ref: seat ? { k: 'settlement', id: seat.id } : { k: 'civ', id: house.civ }, tags: ['debt'],
    text: `${capFirst(houseName(world, house))} failed, ruined by the debts of ${civName(debtor)}.`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// The debt casus belli (war.js)

/** a's claim on b's purse: { owed, w } while a may make war on b to recover it, else null. */
export function debtClaim(world, aId, bId) {
  const list = world.sys.diplomacy && world.sys.diplomacy.debtCb;
  if (!list || !list.length) return null;
  const day = world.time.day;
  for (const d of list) {
    if (d.a !== aId || d.b !== bId || day > d.until) continue;
    const a = world.civs[aId];
    return { owed: d.owed, w: clamp(1 + d.owed / Math.max(1, a ? yearIncome(a) : 1), 1, 2) };
  }
  return null;
}

/** The war over a's debt is settled: forget the claim, and return what was owed (0 when none). */
export function settleDebtClaim(world, aId, bId) {
  const st = world.sys.diplomacy;
  if (!st || !st.debtCb) return 0;
  let owed = 0;
  st.debtCb = st.debtCb.filter((d) => { if (d.a === aId && d.b === bId) { owed = d.owed; return false; } return true; });
  return owed;
}

// ---------------------------------------------------------------------------
// Banking houses

/** "the House of Vell of Oskel". */
export function houseName(world, h) {
  const seat = world.settlements[h.seat];
  return `the House of ${h.name}${seat ? ` of ${seat.name}` : ''}`;
}

/** Houses of realm civId (the realm dossier). */
export function housesOf(world, civId) {
  const hs = (world.sys.diplomacy && world.sys.diplomacy.houses) || [];
  return hs.filter((h) => h.civ === civId && h.failed == null);
}

/** Monthly, from diplomacy: houses earn from their seats' trade; once a year new ones are founded. */
export function housesMonthly(world) {
  const st = debtState(world);
  for (const h of st.houses) {
    if (h.failed != null) continue;
    const seat = world.settlements[h.seat];
    if (seat && seat.alive) h.capital = round2(h.capital + Math.max(0, finite(seat.tradeIncome) ? seat.tradeIncome : 0) / 12);
  }
  const month = Math.floor(world.time.day / DAYS_PER_MONTH);
  if (month % 12 === 4) housesYearly(world, st);
  if (month % 120 === 4) st.debtCb = st.debtCb.filter((d) => world.time.day <= d.until && world.civs[d.a]?.alive && world.civs[d.b]?.alive);
}

function housesYearly(world, st) {
  let open = 0;
  for (const h of st.houses) if (h.failed == null) open++;
  if (open >= MAX_HOUSES) return;
  const towns = liveSettlements(world);
  const trade = [];
  for (const s of towns) if (finite(s.tradeIncome) && s.tradeIncome > 0) trade.push(s.tradeIncome);
  if (trade.length < 10) return;
  trade.sort((p, q) => p - q);
  const top = trade[Math.floor(trade.length * 0.9)];
  for (const c of liveCivs(world)) {
    if (open >= MAX_HOUSES) break;
    if (eraOf(c) < 4 || st.houses.some((h) => h.civ === c.id && h.failed == null)) continue;
    let seat = null;
    for (const sid of c.settlementIds) { const s = world.settlements[sid]; if (s && s.alive && (s.tier || 0) >= 3 && fin0(s.tradeIncome) >= top && (!seat || s.tradeIncome > seat.tradeIncome)) seat = s; }
    // double-entry books found houses, chartered companies grow them (civ/tech.js)
    const known = (id) => Boolean(c.tech && c.tech.known && c.tech.known[id] != null);
    if (!seat || !world.rng.chance(0.05 * (known('bookkeeping') ? 1.5 : 1))) continue;
    const name = makePerson(c.language, world.rng);
    const h = { id: st.houses.length, name, civ: c.id, seat: seat.id, capital: round2(12 * seat.tradeIncome * (known('company') ? 1.5 : 1)), founded: world.time.day, failed: null };
    st.houses.push(h);
    open++;
    count(st, 'houses');
    if (rateOk(world, 'bankFounded', 10 * DAYS_PER_YEAR)) {
      chronicle(world, {
        cat: 'civ', imp: 1, x: seat.x, y: seat.y, civId: c.id, sid: seat.id, icon: 'coin', key: 'bank.founded', ref: { k: 'settlement', id: seat.id }, tags: ['debt'],
        text: `In ${seat.name} the merchant family of ${name} began to lend to crowns; ${houseName(world, h)} would be heard of.`,
      });
    }
  }
}
const fin0 = (v) => (finite(v) ? v : 0);

/** A house whose seat changed hands or fell moves to its realm's next-richest town, or closes. */
function reseat(world, s) {
  const st = world.sys.diplomacy;
  if (!st || !st.houses || !st.houses.length) return;
  for (const h of st.houses) {
    if (h.failed != null || h.seat !== s.id) continue;
    const c = world.civs[h.civ];
    let best = null;
    if (c && c.alive) for (const sid of c.settlementIds) { const t = world.settlements[sid]; if (t && t.alive && t.id !== s.id && (!best || fin0(t.tradeIncome) > fin0(best.tradeIncome))) best = t; }
    if (best) h.seat = best.id; else h.failed = world.time.day;
  }
}
on('settlementTransferred', (world, s, oldId) => { if (s && world.sys.diplomacy?.houses?.some((h) => h.seat === s.id && h.civ === oldId)) reseat(world, s); });
on('settlementDestroyed', (world, s) => { if (s) reseat(world, s); });
on('civDestroyed', (world, civ) => {
  const hs = civ && world.sys.diplomacy && world.sys.diplomacy.houses;
  if (hs) for (const h of hs) if (h.civ === civ.id && h.failed == null) h.failed = world.time.day;
});

// the world's debt for the yearly record (the statistics' treasuries chart)
registerProvider('yearRecord', 'debt', (world) => {
  const st = world.sys.diplomacy;
  let owed = 0;
  for (const l of (st && st.loans) || []) owed += l.owed;
  const ctr = (st && st.ctr) || {};
  if (!(owed > 0) && !ctr.loans) return null;
  return { owed: Math.round(owed), loans: ctr.loans || 0, defaults: ctr.defaults || 0, houses: (st && st.houses ? st.houses.filter((h) => h.failed == null).length : 0) };
});
