// The civ-level monthly pass: aggregates settlements into civ caches (population,
// territory, wealth, peaks, military.manpower ≈ 3 % of pop × mods.military (read from the
// people the levy rule names, core/cohorts.js),
// military.strength = Σ strength of the realm's armies in the field), refreshes
// mods, researches, runs the treasury and tax policy, shares food through the granary
// network, updates legitimacy and stability, handles rulers and great figures, ages, and
// (quarterly / yearly) rebellions, reforms, revolutions, collapses and unions; once a year, at
// its own month (civ.id % 12), the people's temperament drifts with its history (temper.js).
//
// civ.income / civ.expenses are last month's taxes and state spending (wealth units).

import { civSettlements, killCiv } from '../../core/entities.js';
import { monthOf } from '../../core/world.js';
import { ruleOf, levyBase, scratchSlice, isSet, takePeople, addPeople, ageShares } from '../../core/cohorts.js';
import { DAYS_PER_YEAR as DPY, RESOURCES } from '../../core/constants.js';
import { refreshMods, researchMonthly, hasTech, getMods } from './tech.js';
import { targetTax, evaluateGovernment, styleName, canReformNow } from './government.js';
import { rulersMonthly, updateLegitimacy, setupRuler } from './rulers.js';
import { updateStability, rebellionCheck, collapseCheck, revolutionCheck, unionCheck, ageCheck, ageTick, crisisTick } from './stability.js';
import { figuresMonthly } from './culture.js';
import { fin, div, record, rateOk, ensureCivFields, civCache, atWarSet } from './state.js';
import { theName, TheName, pick } from './prose.js';
import { buildingVec, BV, townMods } from './settlement.js';
import { dynastyMonthly } from './dynasty.js';
import { temperMonthly, temperYearly } from './temper.js';

/** Σ army strength per civ this month (built once per month from world.armies). */
export function armyStrength(world, civId) {
  const c = civCache(world);
  const month = Math.floor(world.time.day / 30);
  if (c.armyStrMonth !== month || !c.armyStr) {
    const m = new Map();
    for (const a of world.armies) {
      if (!a || a.civId == null) continue;
      const v = Number.isFinite(a.strength) && a.strength > 0 ? a.strength : 0;
      m.set(a.civId, (m.get(a.civId) || 0) + v);
    }
    c.armyStr = m; c.armyStrMonth = month;
  }
  return c.armyStr.get(civId) || 0;
}

const RES_BIT = Object.fromEntries(RESOURCES.map((r) => [r.key, 1 << r.id]));

/** Aggregate a civ's settlements. Returns agg or null if the civ has none (then killed). */
export function aggregate(world, civ) {
  const ss = civSettlements(world, civ);
  if (!ss.length) return null;
  const cap = world.settlements[civ.capitalId] && world.settlements[civ.capitalId].alive ? world.settlements[civ.capitalId] : ss[0];
  let pop = 0, wealth = 0, happy = 0, loyal = 0, unrest = 0, culture = 0, faithOff = 0, lib = 0, coast = 0, dist = 0, plagued = false, res = 0, foreign = 0, nEff = 0, resW = 0;
  const sms = new Array(ss.length);
  let k = 0;
  const mods = getMods(world, civ);
  const levy = ruleOf(world, 'levy', civ);
  let levyPop = 0, sch = 0, youth = 0;
  for (const s of ss) {
    const p = Math.max(0, fin(s.population));
    pop += p; wealth += fin(s.wealth); culture += fin(s.culture);
    levyPop += levyBase(s, levy);
    sch += p * fin(s.flags?.sch, 1);
    youth += p * ageShares(s.cohorts).youth;
    happy += p * fin(s.happiness, 0.5); loyal += p * fin(s.loyalty, 0.5); unrest += p * fin(s.unrest);
    if (civ.stateReligion != null && s.dominantReligion != null && s.dominantReligion !== civ.stateReligion) faithOff += p;
    if (fin(s.flags?.assim, 1) < 0.5) foreign += p;
    const bo = buildingVec(world, s);
    const bv = civCache(world).bv;
    lib += p * (0.15 * bv[bo + BV.library] + 0.35 * bv[bo + BV.university] + 0.1 * bv[bo + BV.observatory]);
    const sm = (sms[k++] = townMods(world, s));
    resW += p * sm.research;
    if (s.coastal) coast++;
    // administrative weight: hamlets and villages are cheaper to govern than towns and cities
    nEff += s.tier >= 3 ? 1 : s.tier === 2 ? 0.7 : 0.4;
    if (s.disease) plagued = true;
    res |= fin(s.flags?.res, 0);
    dist += Math.hypot(s.x - cap.x, s.y - cap.y);
  }
  const n = ss.length;
  return {
    ss, sms, n, nEff, cap, pop, levyPop, youth: div(youth, pop, 0),
    wealth, culture,
    avgHappy: div(happy, pop, 0.5), avgLoyal: div(loyal, pop, 0.5), avgUnrest: div(unrest, pop, 0),
    // research: the towns' own modifiers, and their scholars against an unbuilt town's (jobs.js, ±10 %)
    faithDis: div(faithOff, pop, 0), libBonus: div(lib, pop, 0), diversity: div(foreign, pop, 0),
    resMul: div(resW, pop, 1) * Math.max(0.9, Math.min(1.1, 1 + 0.25 * (div(sch, pop, 1) - 1))),
    coastShare: n ? coast / n : 0, plagued,
    hasOre: Boolean(res & (RES_BIT.copper | RES_BIT.tin)), hasHorses: Boolean(res & RES_BIT.horses),
    distRatio: n > 1 ? div(dist / (n - 1), Math.max(4, mods.adminRange), 0) : 0,
    atWar: atWarSet(world).has(civ.id),
  };
}

/**
 * The granary network: food flows from well-stocked settlements to hungry ones and to the
 * towns and cities that live on their hinterland. Efficiency rises with transport tech.
 */
function shareFood(world, civ, agg) {
  if (agg.n < 2) return;
  const mods = getMods(world, civ);
  let eff = 0.35 + (hasTech(civ, 'wheel') ? 0.12 : 0) + (hasTech(civ, 'horseback') ? 0.08 : 0)
    + (hasTech(civ, 'engineering') ? 0.12 : 0) + (hasTech(civ, 'railways') ? 0.2 : 0) + (hasTech(civ, 'combustion') ? 0.1 : 0);
  if (!mods.farming) eff *= 0.5;
  eff = Math.min(0.88, eff);
  const lm = world.f.landmass;
  const capLm = lm[agg.cap.i];
  let pool = 0, need = 0;
  const donors = [], takers = [];
  for (const s of agg.ss) {
    s.foodImport = 0;
    if (s.siege) continue;
    if (mods.navigation < 1 && lm[s.i] !== capLm) continue;
    const pop = Math.max(1, s.population);
    const months = s.food / pop;
    const urban = s.tier >= 3 || s.id === civ.capitalId;
    if (months < 1.2 || s.famine > 0) { const q = 2 * pop - s.food; takers.push([s, q * 1.5]); need += q * 1.5; }
    else if (urban && months < 3.5) { const q = 3.5 * pop - s.food; takers.push([s, q]); need += q; }
    else if (months > 2 && !urban) { const g = (s.food - 2 * pop) * 0.45; donors.push([s, g]); pool += g; }
    else if (months > 5) { const g = (s.food - 5 * pop) * 0.45; donors.push([s, g]); pool += g; }
  }
  if (pool <= 0 || need <= 0) return;
  const deliver = Math.min(pool * eff, need);
  const takeFrac = deliver / (eff * pool);
  for (const [s, g] of donors) s.food = Math.max(0, s.food - g * takeFrac);
  const giveFrac = deliver / need;
  for (const [s, q] of takers) { const got = q * giveFrac; s.food += got; s.foodImport = got; }
}

/**
 * Urban drift: villagers move to the towns and cities that can feed and house them —
 * slowly before industry, faster after. Cities rarely sustain themselves by births alone.
 */
function urbanDrift(world, civ, agg) {
  if (agg.n < 2) return;
  const mods = getMods(world, civ);
  const era = fin(civ.tech?.era, 0);
  const rate = 0.0005 * (1 + 0.25 * era) * (era >= 6 ? 2 : 1) * fin(world.params.migration, 1);
  if (!(rate > 0)) return;
  const cities = [], cityAttract = [];
  agg.ss.forEach((s, k) => {
    if ((s.tier >= 3 || s.id === civ.capitalId) && !s.siege && s.food >= 1.5 * s.population && s.population < 0.92 * s.housing) { cities.push(s); cityAttract.push(agg.sms[k].attract); }
  });
  if (!cities.length) return;
  const range = Math.max(6, mods.adminRange * 1.2);
  for (let k = 0; k < agg.ss.length; k++) {
    const v = agg.ss[k];
    if (v.tier >= 3 || v.siege || v.population < 60) continue;
    let best = null, bs = -Infinity, ba = 1;
    for (let j = 0; j < cities.length; j++) {
      const c = cities[j];
      const d = Math.hypot(c.x - v.x, c.y - v.y);
      if (d > range) continue;
      const sc = c.tier + c.happiness + (c.id === civ.capitalId ? 0.5 : 0) - d / range;
      if (sc > bs) { bs = sc; best = c; ba = cityAttract[j]; }
    }
    if (!best) continue;
    // a town's draw (fairs, booms, plague fear: the attract modifier) pulls or holds its people
    const pull = Math.max(0.2, Math.min(3, ba / Math.max(0.2, agg.sms[k].attract)));
    const n = v.population * rate * (0.5 + best.happiness) * pull;
    const sl = isSet(v.cohorts) ? {} : scratchSlice();
    takePeople(world, v, n, 'movers', sl, civ);
    addPeople(world, best, sl, n);
  }
}

/**
 * The state keeps about two years of income in reserve and spends the rest on public
 * works: it pays toward the projects (buildings, wonders) of its settlements.
 */
function spendSurplus(world, civ, agg, income) {
  const reserve = Math.max(100, income * 24);
  if (!(civ.treasury > reserve)) return;
  let budget = (civ.treasury - reserve) * 0.08;
  let w = 0;
  for (const s of agg.ss) if (s.project && !s.siege) w += Math.max(1, s.population);
  if (w <= 0) return;
  let spent = 0;
  for (const s of agg.ss) {
    const p = s.project;
    if (!p || s.siege) continue;
    const give = Math.min(budget * Math.max(1, s.population) / w, Math.max(0, p.cost - p.progress));
    p.progress += give;
    spent += give;
  }
  civ.treasury -= spent;
  civ.expenses += spent;
}

/** One civ, one month. */
export function monthlyCiv(world, civ) {
  ensureCivFields(civ);
  if (!civ.ruler) setupRuler(world, civ);
  if (!civ.flags.styled) styleName(civ, world);
  const agg = aggregate(world, civ);
  if (!agg) { killCiv(world, civ.id, 'vanished'); return; }
  const month = monthOf(world);
  // caches
  civ.population = agg.pop;
  civ.wealth = agg.wealth;
  civ.culture = agg.culture;
  if (agg.pop > civ.peakPopulation) civ.peakPopulation = agg.pop;
  civ.flags.avgHappy = agg.avgHappy; civ.flags.avgLoyal = agg.avgLoyal; civ.flags.avgUnrest = agg.avgUnrest;
  civ.flags.faithDis = agg.faithDis; civ.flags.coastShare = agg.coastShare;
  civ.flags.conquests = fin(civ.flags.conquests) * 0.99;
  civ.flags.losses = fin(civ.flags.losses) * 0.99;
  if (civ.capitalId == null || !world.settlements[civ.capitalId]?.alive) civ.capitalId = agg.cap.id;
  civ.flags.capitalSid = civ.capitalId;
  // styled single-city names ("Free City of …") follow the settlement count
  styleName(civ, world);

  const mods = refreshMods(world, civ);
  // manpower: 3 % of the people, counted by those the realm's levy rule names (by default the
  // young men) against the town's reference shape (core/cohorts.js levyBase)
  civ.military.manpower = agg.levyPop * 0.03 * mods.military;
  civ.flags.mpr = agg.pop > 0 ? Math.round(agg.levyPop / agg.pop * 1000) / 1000 : 1;   // its young men against its people (peoplenews.js manpowerReason)
  civ.flags.yth = Math.round(agg.youth * 1000) / 1000;   // its share of 15–24s (the event deck's youth lean)
  civ.military.strength = Math.round(armyStrength(world, civ.id));

  researchMonthly(world, civ, agg);
  if (!civ.alive) return;

  // treasury
  const income = fin(civ.flags.taxAcc);
  civ.flags.taxAcc = 0;
  const expenses = income * 0.35 * (1 + 0.5 * fin(civ.flags.overext)) + 0.02 * agg.n * (1 + 0.3 * fin(civ.tech?.era));
  civ.income = income;
  civ.expenses = expenses;
  civ.treasury = fin(civ.treasury) + income - expenses;
  if (civ.treasury < -Math.max(50, income * 24)) {
    civ.treasury = -Math.max(50, income * 24);
    civ.stability = Math.max(0, civ.stability - 0.01);
    if (rateOk(world, `bankrupt:${civ.id}`, 40)) {
      record(world, { cat: 'civ', imp: 2, key: 'realm.bankrupt', civ, text: pick(world, [
        `The treasury of ${theName(civ)} stood empty, and its soldiers and officials went unpaid.`,
        `${TheName(civ)} could no longer pay its debts.`,
        `The coffers of ${theName(civ)} ran dry${civ.ruler ? `, and the creditors of ${civ.ruler.name} went away empty-handed` : ''}.`,
      ]) });
    }
  }
  civ.taxRate = fin(civ.taxRate, 0.08) + (targetTax(world, civ, agg.atWar) - fin(civ.taxRate, 0.08)) * 0.05;
  spendSurplus(world, civ, agg, income);

  urbanDrift(world, civ, agg);
  shareFood(world, civ, agg);
  updateLegitimacy(world, civ);
  updateStability(world, civ, agg);
  rulersMonthly(world, civ, agg);
  if (!civ.alive) return;
  dynastyMonthly(world, civ, agg);
  if (!civ.alive) return;
  figuresMonthly(world, civ, agg);
  ageTick(world, civ);
  // temperament: tallied monthly, drifts once a year at the people's own month (temper.js)
  temperMonthly(world, civ, agg);
  if (civ.id % 12 === month) temperYearly(world, civ, agg);
  civ.prestige = fin(civ.prestige) * 0.9995;

  if (month === 4) { rebellionCheck(world, civ); if (!civ.alive) return; }
  if (month === 0) {
    crisisTick(civ);
    civ.flags.popHist.push(Math.round(agg.pop));
    civ.flags.townHist.push(agg.n);
    if (civ.flags.popHist.length > 12) civ.flags.popHist.shift();
    if (civ.flags.townHist.length > 12) civ.flags.townHist.shift();
    if (canReformNowSoft(world, civ)) evaluateGovernment(world, civ, agg);
    if (!civ.alive) return;
    if (collapseCheck(world, civ, agg)) return;
    if (!civ.alive) return;
    revolutionCheck(world, civ);
    if (!civ.alive) return;
    ageCheck(world, civ, agg);
    unionCheck(world, civ);
  }
}

function canReformNowSoft(world, civ) {
  return world.time.day - fin(civ.flags.govSince, 0) >= 25 * DPY;
}

export { canReformNow };
