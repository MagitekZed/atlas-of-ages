// Debt between crowns (chunk 3, docs/design/why-wars.md): loans and reparations.
//
//   world.sys.diplomacy.loans = [{ id, from, to, owed, pay, rate, start, until, arrears, kind }]
//     from     the lender: a realm id (a banking house: −1 − its id)
//     owed     what is still owed · pay  the monthly payment · rate  yearly interest
//     arrears  months in a row the debtor could not pay in full · kind  'reparations' | 'loan'
//
// Reparations are a loan from the victor at no interest, imposed at the peace (war.js). Each
// month the debtor pays from its treasury, never more than half of it; a payment it cannot make
// in full adds to its arrears. No payment crosses a battle line, and a debt dies with either
// party. A debt still unpaid ten years after it fell due is written off.
//
// Exports: addReparations, debtsMonthly, loansOf, owedBy, monthlyIncome

import { DAYS_PER_YEAR } from '../../core/constants.js';
import { areAtWar } from '../../core/entities.js';
import { clamp } from '../../core/util.js';
import { finite } from './common.js';

/** A realm's monthly income (a floor from its people when the treasury has not run yet). */
export function monthlyIncome(civ) {
  if (finite(civ.income) && civ.income > 0) return civ.income;
  return Math.max(1, (civ.population || 0) * 0.002);
}

function debtState(world) {
  const st = (world.sys.diplomacy ||= {});
  st.loans ||= [];
  if (!finite(st.nextLoan)) st.nextLoan = 1;
  return st;
}

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

/** Monthly, from diplomacy: interest, payments and arrears. */
export function debtsMonthly(world) {
  const st = world.sys.diplomacy;
  if (!st || !st.loans || !st.loans.length) return;
  const day = world.time.day;
  const keep = [];
  for (const l of st.loans) {
    const debtor = world.civs[l.to];
    const lender = l.from >= 0 ? world.civs[l.from] : null;
    if (!debtor || !debtor.alive || (l.from >= 0 && (!lender || !lender.alive))) continue;
    if (day > l.until + 10 * DAYS_PER_YEAR) continue;   // written off
    if (l.from >= 0 && areAtWar(world, l.to, l.from)) { keep.push(l); continue; }
    if (l.rate > 0) l.owed = round2(l.owed * (1 + l.rate / 12));
    const due = Math.min(l.owed, l.pay);
    const can = Math.max(0, finite(debtor.treasury) ? debtor.treasury : 0) * 0.5;
    const paid = Math.min(due, can);
    if (paid > 0) {
      debtor.treasury -= paid;
      if (lender) lender.treasury = (finite(lender.treasury) ? lender.treasury : 0) + paid;
      l.owed = round2(l.owed - paid);
    }
    l.arrears = paid >= due * 0.999 ? 0 : clamp((l.arrears || 0) + 1, 0, 600);
    if (l.owed > 0.01) keep.push(l);
  }
  st.loans = keep;
}
