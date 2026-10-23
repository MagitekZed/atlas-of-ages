// Volume governor: keeps the deck from crowding the Chronicle. Two budgets of imp ≥ 2 entries
// per decade, both growing a little with the world:
//   per family  2 + realms/10 + towns/200 (≤ 6): over it the family's weights halve, over twice
//               it they quarter, over three times they drop to a tenth
//   in all      10 + realms (≤ 26): over it every weight drops to 35 %, past 1.5× to 12 %, past
//               twice the budget to 4 %
// so a crowded late world reads about as busily as a young one. State:
// sys.events.gov = { dec, n: { family: count }, all }, reset when the decade turns.

import { GOV_BASE } from './data.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { liveCivs, liveSettlements } from '../../core/entities.js';

const decadeOf = (world) => Math.floor(world.time.day / (DAYS_PER_YEAR * 10));
function gov(world) {
  const st = world.sys.events;
  const dec = decadeOf(world);
  if (!st.gov || st.gov.dec !== dec) st.gov = { dec, n: {}, all: 0 };
  if (!Number.isFinite(st.gov.all)) st.gov.all = 0;
  return st.gov;
}

/** imp ≥ 2 entries a family may write this decade before its weights halve. */
export function govBudget(world) {
  const civs = liveCivs(world).length, towns = liveSettlements(world).length;
  return Math.min(6, GOV_BASE + Math.round(civs / 10) + Math.round(towns / 200));
}
/** imp ≥ 2 entries the whole deck may write this decade before every weight halves. */
export function govTotal(world) {
  return Math.min(26, 10 + liveCivs(world).length);
}

const step = (n, b) => (n >= 3 * b ? 0.1 : n >= 2 * b ? 0.25 : n >= b ? 0.5 : 1);
const stepAll = (n, b) => (n >= 2 * b ? 0.04 : n >= 1.5 * b ? 0.12 : n >= b ? 0.35 : 1);

/** Weight factor for a family now (family budget × deck budget). Pure. */
export function govFactor(world, family) {
  const g = world.sys.events.gov;
  if (!g || g.dec !== decadeOf(world)) return 1;
  const n = g.n[family] || 0, all = g.all || 0;
  const tot = all ? stepAll(all, govTotal(world)) : 1;
  return (n ? step(n, govBudget(world)) : 1) * tot;
}

/** Count an entry the family wrote (only notable, unfolded ones spend budget). */
export function govNote(world, family, entry) {
  if (!entry || entry.imp < 2 || entry.fold) return;
  const g = gov(world);
  g.n[family] = (g.n[family] || 0) + 1;
  g.all += 1;
}
