// Stability and the fates of states.
//   updateStability  monthly target from legitimacy, happiness, war weariness, overextension
//                    vs government capacity, faith disunity, unrest, debt, hegemony, ages, mods
//                    (negative pressures ÷ params.stabilityFactor)
//   rebellionCheck   restless, disloyal settlements (and, from the Renaissance on, estranged
//                    subject peoples) defect to their old masters or secede, sometimes
//                    fighting a war of independence
//   collapseCheck    a failing state breaks into successor fragments (sometimes totally)
//   revolutionCheck  the government is overthrown (sometimes with a loyalist civil war)
//   unionCheck       tiny states join a much larger kin / friendly neighbour
//   ageCheck         golden ages (prosperity, wonders, figures) and dark ages (plague,
//                    famine, defeat, collapse)

import { civSettlements, transferSettlement, areAtWar, settlementsNear, enemiesOf, addOpinion, liveSettlements } from '../../core/entities.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { emitFx } from '../../core/world.js';
import { getMods, refreshMods } from './tech.js';
import { govCapacity, revolutionTarget, govDef } from './government.js';
import { overthrow, noteDeed } from './rulers.js';
import { splitCiv, roughPower, rootOf } from './peoples.js';
import { borderNeighbours, borderLength } from './territory.js';
import { fin, div, record, rateOk } from './state.js';
import { theName, TheName, peopleOf, rulerName, listJoin, pick } from './prose.js';

const sfOf = (world) => Math.max(0.3, fin(world.params.stabilityFactor, 1));

/**
 * Monthly stability drift toward a target set by legitimacy, happiness and the state's
 * pressures. agg: { n, nEff (tier-weighted settlement count), avgHappy, avgUnrest, faithDis,
 * distRatio, diversity }.
 * The target's parts are kept on civ.flags.stab (for the inspector and for tuning).
 */
export function updateStability(world, civ, agg) {
  const mods = getMods(world, civ);
  const sf = sfOf(world);
  const cap = govCapacity(civ, mods);
  civ.flags.capacity = cap;
  const over = Math.max(0, fin(agg.nEff, agg.n) / Math.max(1, cap) - 1) + 0.5 * Math.max(0, agg.distRatio - 1);
  civ.flags.overext = over;
  const tr = civ.traits || {};
  const parts = {
    legitimacy: 0.2 * (fin(civ.legitimacy, 0.6) - 0.5),
    happiness: 0.35 * (agg.avgHappy - 0.52),
    institutions: 0.6 * mods.stability,
    war: -0.22 * Math.min(1, fin(civ.warWeariness)) / sf,
    overextension: -0.15 * Math.min(2.5, over) / sf,
    faith: -0.08 * agg.faithDis * (0.5 + fin(tr.religiosity, 0.5)) / sf,
    unrest: -0.25 * agg.avgUnrest / sf,
    debt: (civ.treasury < 0 ? -0.08 : 0) / sf,
    losses: -0.03 * Math.min(3, fin(civ.flags.losses)) / sf,
    size: -0.02 * Math.log2(Math.max(1, agg.n / 12)) / sf,
    diversity: -0.1 * fin(agg.diversity) / sf,
    // from the Medieval age on, a realm holding a large share of the world's towns breeds
    // rivals, rebels and pretenders (earlier ages have collapse and conquest enough)
    hegemony: -0.5 * Math.max(0, Math.min(1, (fin(civ.tech?.era, 0) - 3) / 2))
      * Math.max(0, div(agg.n, liveSettlements(world).length, 0) - 0.2) / sf,
  };
  let target = 0.6;
  for (const k in parts) target += parts[k];
  target = Math.max(0, Math.min(1, target));
  const st = {};
  for (const k in parts) st[k] = Math.round(parts[k] * 1000) / 1000;
  st.target = Math.round(target * 1000) / 1000;
  civ.flags.stab = st;
  civ.stability = Math.max(0, Math.min(1, fin(civ.stability, 0.6) + (target - fin(civ.stability, 0.6)) * 0.08));
}

/** Years since the realm was founded or last won its independence. */
function realmAge(world, civ) {
  const since = Math.max(fin(civ.foundedDay, 0), fin(civ.flags?.independence, -1e9));
  return (world.time.day - since) / DAYS_PER_YEAR;
}

/**
 * The government a breakaway province chooses, from its own conditions: a lone trading city
 * becomes a free city or merchant republic; rich, coastal provinces lean to merchant rule;
 * towns of another faith than their old crown's priests never keep a theocracy; a devout
 * province of the state faith may; great empires and hordes break into kingdoms.
 * cluster: the settlements that rise (optional).
 */
export function rebelGovernment(world, civ, single, cluster = null) {
  const era = fin(civ.tech?.era, 0);
  const g = civ.government;
  const ss = Array.isArray(cluster) ? cluster.filter((s) => s && s.alive) : [];
  let pop = 0, wealth = 0, coast = 0, temples = 0, sameFaith = 0, otherFaith = 0;
  for (const s of ss) {
    const p = Math.max(1, fin(s.population));
    pop += p; wealth += fin(s.wealth);
    if (s.coastal) coast += p;
    temples += fin(s.buildings?.temple);
    if (civ.stateReligion != null && s.dominantReligion != null) { if (s.dominantReligion === civ.stateReligion) sameFaith += p; else otherFaith += p; }
  }
  const coastShare = pop ? coast / pop : 0;
  const rich = pop ? wealth / pop : 0;
  const traders = coastShare > 0.5 && rich > 0.06;
  if (single && era >= 3 && world.rng.chance(0.5 + (traders ? 0.2 : 0))) return world.rng.chance(0.5 + fin(civ.traits?.commerce, 0.5) * 0.3 + (traders ? 0.15 : 0)) ? 'merchant' : 'republic';
  if (g === 'tribe') return 'tribe';
  if (g === 'chiefdom') return 'chiefdom';
  if (g === 'empire' || g === 'feudal' || g === 'horde') return era >= 1 ? 'kingdom' : 'chiefdom';
  if (g === 'dictatorship') return era >= 6 ? 'democracy' : 'republic';
  if (g === 'theocracy') {
    // only a devout province of the priests' own faith keeps their rule
    const devout = pop > 0 && sameFaith / pop > 0.6 && temples >= ss.length && otherFaith === 0;
    if (devout && world.rng.chance(0.45)) return 'theocracy';
    if (era >= 3 && traders && hasCurrency(civ)) return 'merchant';
    return era >= 3 && world.rng.chance(0.3) ? 'republic' : era >= 1 ? 'kingdom' : 'chiefdom';
  }
  if ((g === 'kingdom' || g === 'constitutional') && era >= 3 && traders && hasCurrency(civ) && world.rng.chance(0.35)) return 'merchant';
  return g;
}
const hasCurrency = (civ) => Boolean(civ?.tech?.known && civ.tech.known.currency != null);

/**
 * Does the old realm fight to keep its rebels? Proud, martial states with a warlike ruler
 * often do; weak, war-weary or already embattled ones let the province go, and a crown
 * hardly stronger than the rising thinks twice. At most one war of independence per realm
 * in sixty years.
 */
function willFight(world, civ, parentPow, rebelPow) {
  const ratio = div(parentPow, rebelPow, 0);
  if (ratio < 0.9) return false;
  if (world.time.day - fin(civ.flags.lastIndepWarDay, -1e9) < 60 * DAYS_PER_YEAR) return false;
  if (fin(civ.warWeariness) > 0.5) return false;
  const rt = civ.ruler?.traits || [];
  let p = 0.22;
  if (rt.includes('warlike')) p += 0.2;
  if (rt.includes('cruel')) p += 0.12;
  if (rt.includes('ambitious')) p += 0.08;
  if (rt.includes('craven')) p -= 0.12;
  if (rt.includes('cautious')) p -= 0.06;
  if (civ.government === 'empire' || civ.government === 'horde' || civ.government === 'dictatorship') p += 0.1;
  if (enemiesOf(world, civ.id).length) p -= 0.15;
  p *= 0.6 + 0.8 * fin(civ.traits?.militarism, 0.5);
  // a crown barely stronger than its rebels thinks twice (but when it fights, it may lose)
  p *= Math.max(0.25, Math.min(1, (ratio - 0.9) / 1.6));
  return world.rng.chance(Math.max(0, Math.min(0.7, p)));
}

/**
 * A settlement rises against its civ: it defects to the people it was taken from, or
 * secedes with nearby disaffected towns. opts: { divine }. Returns true if it happened.
 */
export function revolt(world, civ, s, opts = {}) {
  if (!s || !s.alive || s.civId !== civ.id) return false;
  const st = world.sys.civ;
  const day = world.time.day;
  // return to the old masters?
  const origin = world.civs[s.originCivId];
  if (origin && origin.alive && origin.id !== civ.id && !areAtWar(world, origin.id, civ.id)
    && (borderLength(world, origin.id, civ.id) > 0 || settlementsNear(world, s.x, s.y, 14, (o) => o.civId === origin.id).length)
    && world.rng.chance(0.55)) {
    transferSettlement(world, s.id, origin.id, 'defection');
    s.loyalty = 0.7; s.unrest = 0.1; s.flags.assim = 1; s.flags.grieve = 0; s.flags.seceded = day;
    civ.flags.losses = fin(civ.flags.losses) + 1;
    civ.flags.lastRebelDay = day;
    noteDeed(civ, 'losses');
    record(world, { cat: opts.divine ? 'divine' : 'civ', imp: s.tier >= 3 || opts.divine ? 3 : 2, key: opts.divine ? 'divine.unrest' : 'rebellion.defect', s, tags: ['rebellion'], cause: opts.cause ?? null, text: opts.divine ? pick(world, [
      `Strange portents walked the streets of ${s.name}; its people rose against ${theName(civ)} and went back to ${theName(origin)}.`,
      `Omens in the sky over ${s.name} turned its people against ${theName(civ)}: they opened their gates to ${theName(origin)}, their old masters.`,
    ]) : pick(world, [
      `Weary of ${theName(civ)}, the people of ${s.name} rose up and returned their allegiance to ${theName(origin)}.`,
      `${s.name} threw off the rule of ${theName(civ)} and went back to ${theName(origin)}.`,
      `The old loyalties of ${s.name} won out: it drove out the officers of ${theName(civ)} and opened its gates to ${theName(origin)}.`,
    ]) });
    emitFx(world, { type: 'rebellion', x: s.x, y: s.y, civId: origin.id });
    if (st) st.counters.rebellions++;
    return true;
  }
  if (civ.settlementIds.length < 2 || s.id === civ.capitalId) return false;
  const cluster = [s];
  for (const o of civSettlements(world, civ)) {
    if (cluster.length >= 5) break;
    if (o.id === s.id || o.id === civ.capitalId) continue;
    if (Math.hypot(o.x - s.x, o.y - s.y) > 10) continue;
    if (day - fin(o.flags?.pacified, -1e9) < 30 * DAYS_PER_YEAR) continue;
    if (o.loyalty < 0.5 && o.unrest > 0.4) cluster.push(o);
  }
  if (cluster.length >= civ.settlementIds.length) cluster.length = Math.max(1, civ.settlementIds.length - 1);
  const rebelPop = cluster.reduce((a, o) => a + o.population, 0);
  const share = Math.min(1, div(rebelPop, civ.population, 0));
  // a lone small town cannot stand on its own: it goes over to a neighbour, or the rising
  // is put down; only a province of weight proclaims a realm of its own
  if (!opts.divine && cluster.length === 1 && rebelPop < 4000 && share < 0.08) {
    const haven = world.rng.chance(0.6) ? pickHaven(world, civ, s) : null;
    if (haven) return defectTo(world, civ, s, haven);
    return suppressRising(world, civ, s);
  }
  const pow = roughPower(world, civ);
  const parentPow = pow * Math.max(0, 1 - share);
  const rebelPow = Math.max(1, pow * share);
  const fight = !opts.divine && willFight(world, civ, parentPow, rebelPow);
  const res = splitCiv(world, civ, cluster.map((o) => o.id), {
    cause: 'rebellion', government: rebelGovernment(world, civ, cluster.length === 1, cluster), nameFrom: 'city',
    war: fight ? { cause: 'independence', names: (rebel) => [
      `${s.name} War of Independence`, `${rebel.adjective} War of Independence`, `${s.name} Rising`,
      `Revolt of ${s.name}`, `${rebel.adjective} Revolt`, `War of ${rebel.adjective} Independence`, `${s.name} Rebellion`,
    ] } : null,
  });
  if (!res) return false;
  civ.flags.losses = fin(civ.flags.losses) + cluster.length;
  civ.flags.lastRebelDay = day;
  if (res.war) civ.flags.lastIndepWarDay = day;
  noteDeed(civ, 'losses', cluster.length);
  if (st) st.counters.rebellions++;
  const others = cluster.slice(1).map((o) => o.name);
  const lead = opts.divine
    ? `Stirred by omens and agitators, ${s.name} rose against ${theName(civ)}`
    : pick(world, [`${s.name} rose in revolt against ${theName(civ)}`, `The people of ${s.name} drove out the governors of ${theName(civ)}`, `Long restless, ${s.name} broke with ${theName(civ)}`]);
  const join = others.length ? `; ${listJoin(others)} joined the rising` : '';
  const tail = res.war
    ? `, and ${res.war.name.replace(/^The /, 'the ')} began`
    : pick(world, [`; ${theName(civ)} let them go`, '', `, and ${theName(civ)} was too weak to stop them`]);
  const big = rebelPop >= 20000 || share >= 0.25;
  record(world, { cat: opts.divine ? 'divine' : 'civ', imp: big || res.war || opts.divine ? 3 : 2, key: opts.divine ? 'divine.unrest' : 'rebellion.secede', s, tags: ['rebellion'], cause: opts.cause ?? null, text: `${lead}${join}. The rebels proclaimed ${theName(res.civ)}${tail}.` });
  return true;
}

/** A neighbouring realm at peace with civ that a defecting town would join (or null). */
function pickHaven(world, civ, s) {
  let best = null, bs = 0;
  const seen = new Set();
  for (const o of settlementsNear(world, s.x, s.y, 9, (t) => t.civId !== civ.id)) {
    if (seen.has(o.civId)) continue;
    seen.add(o.civId);
    const nb = world.civs[o.civId];
    if (!nb || !nb.alive || areAtWar(world, nb.id, civ.id)) continue;
    let sc = 0.4 + 0.6 * fin(nb.stability, 0.5) - Math.hypot(o.x - s.x, o.y - s.y) / 30;
    if (s.dominantReligion != null && nb.stateReligion === s.dominantReligion) sc += 0.4;
    if (s.dominantReligion != null && civ.stateReligion === s.dominantReligion) sc -= 0.2;
    if (nb.vassalOf === civ.id) sc -= 1;
    if (sc > bs) { bs = sc; best = nb; }
  }
  return bs > 0.5 ? best : null;
}

/** A restless town goes over to a neighbouring realm. */
function defectTo(world, civ, s, nb) {
  const day = world.time.day;
  const st = world.sys.civ;
  transferSettlement(world, s.id, nb.id, 'defection');
  s.loyalty = 0.55; s.unrest = 0.15; s.flags.grieve = 0; s.flags.seceded = day;
  s.flags.assim = Math.min(fin(s.flags.assim, 0.5), 0.5);
  civ.flags.losses = fin(civ.flags.losses) + 1;
  civ.flags.lastRebelDay = day;
  noteDeed(civ, 'losses');
  addOpinion(world, civ.id, nb.id, -12, false);
  record(world, { cat: 'civ', imp: s.tier >= 3 ? 3 : 2, key: 'rebellion.defect', s, tags: ['rebellion'], text: pick(world, [
    `Despairing of ${theName(civ)}, the elders of ${s.name} offered the town to ${theName(nb)}, which gladly took it in.`,
    `${s.name} broke from ${theName(civ)} and placed itself under the protection of ${theName(nb)}.`,
    `The people of ${s.name} drove out the officers of ${theName(civ)} and swore allegiance to ${theName(nb)}.`,
  ]) });
  emitFx(world, { type: 'rebellion', x: s.x, y: s.y, civId: nb.id });
  if (st) st.counters.rebellions++;
  return true;
}

/** The rising is crushed: some die, the ringleaders hang, and the town is quiet for a generation. */
function suppressRising(world, civ, s) {
  const day = world.time.day;
  const st = world.sys.civ;
  const dead = s.population * world.rng.float(0.01, 0.04);
  s.population = Math.max(8, s.population - dead);
  s.unrest = 0.3; s.loyalty = Math.max(s.loyalty, 0.3); s.flags.grieve = 0; s.flags.pacified = day;
  // other provinces take note: the next rising waits a while (half the usual quiet)
  civ.flags.lastRebelDay = day - 12 * DAYS_PER_YEAR;
  if (st) st.counters.suppressed = fin(st.counters.suppressed) + 1;
  if (rateOk(world, `crushed:${civ.id}`, 15)) {
    record(world, { cat: 'civ', imp: 2, key: 'rebellion.crushed', s, text: pick(world, [
      `A rising in ${s.name} was crushed by the soldiers of ${theName(civ)}, and its ringleaders were hanged.`,
      `${s.name} rose against ${theName(civ)}, but the revolt was put down within the season.`,
      `Riots in ${s.name} were drowned in blood by the garrison of ${theName(civ)}.`,
    ]) });
  }
  return true;
}

/**
 * Yearly: one long-disaffected settlement of a weakened realm may revolt. Young realms
 * (founded or freed within 30 years) are still consolidating and do not split; a realm
 * that has just lost a province gets 20 quiet years; towns that seceded or were pacified
 * recently do not rise again.
 */
export function rebellionCheck(world, civ) {
  if (civ.settlementIds.length < 2) return false;
  const day = world.time.day;
  if (realmAge(world, civ) < 30) return false;
  if (day - fin(civ.flags.lastRebelDay, -1e9) < 25 * DAYS_PER_YEAR) return false;
  let weak = Math.max(0, Math.min(1, (0.55 - civ.stability) / 0.4));
  // modern nationalism: even a steady state of many provinces can face an independence rising
  const nat = Math.max(0, Math.min(1, (fin(civ.tech?.era, 0) - 4) / 3));
  if (nat > 0 && civ.settlementIds.length >= 12) weak = Math.max(weak, 0.45 * nat);
  if (weak <= 0) return false;
  let best = null, bw = 0;
  for (const s of civSettlements(world, civ)) {
    if (s.id === civ.capitalId) continue;
    const g = fin(s.flags.grieve);
    // restless: years of hardship and disloyalty; estranged: a contented but alienated subject people
    const restless = g >= 36 && s.unrest > 0.55 && s.loyalty < 0.42;
    const estranged = nat > 0 && fin(s.flags.natl) >= 60 && s.loyalty < 0.25;
    if (!restless && !estranged) continue;
    if (day - fin(s.flags.seceded, -1e9) < 60 * DAYS_PER_YEAR || day - fin(s.flags.pacified, -1e9) < 40 * DAYS_PER_YEAR) continue;
    const w = Math.max(restless ? (s.unrest - 0.5) * (0.45 - s.loyalty) * Math.min(2, g / 36) : 0,
      estranged ? (0.28 - s.loyalty) * 1.2 * nat : 0);
    if (w > bw) { bw = w; best = s; }
  }
  if (!best) return false;
  const p = Math.min(0.3, 6 * bw) * Math.pow(weak, 1.5) * 0.4 / sfOf(world);
  if (!world.rng.chance(p)) return false;
  return revolt(world, civ, best);
}

/** Yearly bookkeeping of sustained crisis (stability below 0.25). */
export function crisisTick(civ) {
  civ.flags.crisisYears = civ.stability < 0.25 ? fin(civ.flags.crisisYears) + 1 : Math.max(0, fin(civ.flags.crisisYears) - 2);
}

/** Yearly: a state in prolonged crisis may break apart. Returns true if it collapsed. */
export function collapseCheck(world, civ, agg) {
  const n = civ.settlementIds.length;
  if (n < 6 || civ.stability > 0.25 || fin(civ.flags.crisisYears) < 5) return false;
  if (realmAge(world, civ) < 60) return false;
  if (world.time.day - fin(civ.flags.lastCollapseDay, -1e9) < 80 * DAYS_PER_YEAR) return false;
  const sf = sfOf(world);
  const p = 0.08 * ((0.25 - civ.stability) / 0.25 + 0.3) * (civ.darkAge > 0 ? 1.5 : 1) * (civ.legitimacy < 0.35 ? 1.4 : 1) / sf;
  if (!world.rng.chance(p)) return false;
  const st = world.sys.civ;
  const ss = civSettlements(world, civ);
  const cap = world.settlements[civ.capitalId] || ss[0];
  // the far provinces break away (one or two successor states; three from a vast realm)
  const k = n >= 40 ? 4 : n >= 18 ? 3 : 2;
  // farthest-point seeds among the larger settlements, starting from the capital
  const big = ss.slice().sort((a, b) => b.population - a.population).slice(0, Math.max(k * 3, 6));
  const seeds = [cap];
  while (seeds.length < k) {
    let best = null, bd = -1;
    for (const s of big) {
      if (seeds.includes(s)) continue;
      let dm = Infinity;
      for (const q of seeds) dm = Math.min(dm, Math.hypot(s.x - q.x, s.y - q.y));
      if (dm > bd) { bd = dm; best = s; }
    }
    if (!best || bd < 4) break;
    seeds.push(best);
  }
  if (seeds.length < 2) return false;
  const groups = seeds.map(() => []);
  for (const s of ss) {
    let bi = 0, bd = Infinity;
    seeds.forEach((q, j) => { const d = Math.hypot(s.x - q.x, s.y - q.y); if (d < bd) { bd = d; bi = j; } });
    groups[bi].push(s.id);
  }
  const total = world.rng.chance(0.2);
  // how much the world notices: a great empire's fall is epochal, a chiefdom's is not
  const worldPop = liveSettlements(world).reduce((a, s) => a + s.population, 0);
  const popShare = div(fin(civ.population), worldPop, 0);
  const greatness = n >= 20 || (popShare >= 0.2 && n >= 8) ? 2 : n >= 10 ? 1 : 0;
  // an empire's break-up is epochal only for a true colossus, and rarely
  const colossus = n >= 40 && popShare >= 0.25;
  const reasons = [];
  if (civ.treasury < 0) reasons.push('ruinous debts');
  if (fin(civ.warWeariness) > 0.4) reasons.push('endless war');
  if (civ.flags.overext > 0.4) reasons.push('provinces too far-flung to govern');
  if (agg.avgUnrest > 0.4) reasons.push('rebellion');
  if (civ.darkAge > 0) reasons.push('the miseries of a dark age');
  if (!reasons.length) reasons.push('misrule');
  const oldName = theName(civ);
  const names = [];
  for (let j = 1; j < groups.length; j++) {
    if (!groups[j].length) continue;
    if (groups[j].length === 1 && fin(world.settlements[groups[j][0]]?.population) < 20000) continue; // too small to stand alone
    const res = splitCiv(world, civ, groups[j], { cause: 'collapse', government: rebelGovernment(world, civ, groups[j].length === 1, groups[j].map((id) => world.settlements[id])), nameFrom: 'city' });
    if (res) names.push(theName(res.civ));
  }
  if (!names.length) return false;
  civ.flags.lastCollapseDay = world.time.day;
  civ.flags.lastRebelDay = world.time.day;
  civ.flags.crisisYears = 0;
  if (st) st.counters.collapses++;
  if (total && groups[0].length) {
    const res = splitCiv(world, civ, groups[0], { cause: 'collapse', government: rebelGovernment(world, civ, groups[0].length === 1, groups[0].map((id) => world.settlements[id])), nameFrom: 'city', allowTotal: true });
    if (res) names.unshift(theName(res.civ));
    record(world, { cat: 'civ', imp: 3 + greatness, key: 'realm.collapse', x: cap.x, y: cap.y, civId: civ.id, ref: { k: 'civ', id: civ.id }, tags: ['collapse'], text: `Brought low by ${listJoin(reasons)}, ${oldName} collapsed entirely; from its ruins rose ${listJoin(names)}.` });
  } else {
    civ.stability = 0.5; civ.legitimacy = Math.max(civ.legitimacy, 0.4);
    if (!(civ.darkAge > 0)) startDark(world, civ, 'collapse', true);
    record(world, { cat: 'civ', imp: colossus && rateOk(world, 'epochalBreakup', 80) ? 5 : greatness === 2 ? 4 : 3, key: 'realm.breakup', civ, tags: ['collapse'], text: `Torn by ${listJoin(reasons)}, ${oldName} broke apart: ${listJoin(names)} went their own way, leaving only a rump state around ${cap.name}.` });
  }
  return true;
}

/** Yearly: a desperate state may be overthrown. */
export function revolutionCheck(world, civ) {
  if (civ.stability > 0.2 || fin(civ.flags.crisisYears) < 3) return false;
  if (world.time.day - fin(civ.flags.govSince, 0) < 20 * DAYS_PER_YEAR) return false;
  const sf = sfOf(world);
  if (!world.rng.chance(0.08 * ((0.2 - civ.stability) / 0.2 + 0.25) / sf)) return false;
  const target = revolutionTarget(world, civ);
  if (!target) return false;
  const st = world.sys.civ;
  const oldGov = civ.government;
  const oldName = theName(civ);
  const n = civ.settlementIds.length;
  const prevName = civ.ruler ? rulerName(civ.ruler) : 'the old rulers';
  const { ruler } = overthrow(world, civ, target, 'revolution');
  civ.stability = 0.45;
  civ.flags.crisisYears = 0;
  if (st) st.counters.revolutions++;
  let tail = '';
  if (n >= 6 && realmAge(world, civ) >= 40 && world.time.day - fin(civ.flags.lastCivilWarDay, -1e9) >= 60 * DAYS_PER_YEAR && world.rng.chance(0.3)) {
    const cap = world.settlements[civ.capitalId];
    const loyal = civSettlements(world, civ).filter((s) => s.id !== civ.capitalId)
      .sort((a, b) => (b.loyalty - a.loyalty) || 0).slice(0, Math.max(1, Math.round(n * 0.3)));
    const res = splitCiv(world, civ, loyal.map((s) => s.id), {
      cause: 'civil war', government: oldGov === 'tribe' ? 'chiefdom' : oldGov, nameFrom: 'city',
      war: { cause: 'civil war', names: [`${civ.adjective} Revolution`, `Revolution of ${cap ? cap.name : civ.baseName}`] },
    });
    if (res) {
      civ.flags.lastCivilWarDay = world.time.day;
      tail = ` Loyalists of the old order held out in ${world.settlements[res.civ.capitalId]?.name || cap?.name || 'the provinces'}, and ${res.war ? res.war.name.replace(/^The /, 'the ') : 'civil war'} began.`;
    }
  }
  record(world, { cat: 'civ', imp: tail || fin(civ.population) >= 20000 ? 4 : 3, key: 'realm.revolution', civ, tags: ['coup'], text: `Revolution overthrew ${prevName} and ${oldName}; ${rulerName(ruler, false)} came to power in ${theName(civ)}.${tail}` });
  return true;
}

/**
 * Yearly: a small state may merge into a far larger kin or friendly neighbour — but not
 * while the wounds of a war between them are fresh, nor in its first forty years.
 */
export function unionCheck(world, civ) {
  if (civ.settlementIds.length > 2 || fin(civ.population) > 25000) return false;
  if (realmAge(world, civ) < 40) return false;
  const myRoot = rootOf(world, civ);
  const day = world.time.day;
  for (const nid of borderNeighbours(world, civ.id)) {
    const nb = world.civs[nid];
    if (!nb || !nb.alive || areAtWar(world, civ.id, nid)) continue;
    if (fin(nb.population) < 6 * Math.max(1, fin(civ.population))) continue;
    const r = civ.relations?.[nid];
    if (r && r.lastWarDay != null && r.lastWarDay >= 0 && day - r.lastWarDay < 25 * DAYS_PER_YEAR) continue;
    const kin = rootOf(world, nb) === myRoot;
    const faith = civ.stateReligion != null && civ.stateReligion === nb.stateReligion;
    const opinion = fin(r?.opinion, 0);
    const vassal = civ.vassalOf === nid;
    if (!kin && !faith && opinion < 40 && !vassal) continue;
    const p = 0.008 * (1.35 - civ.stability) * (kin ? 2 : 1) * (vassal ? 3 : 1) * (faith ? 1.3 : 1) * (opinion > 50 ? 1.3 : 1);
    if (!world.rng.chance(p)) continue;
    const oldName = theName(civ);
    const st = world.sys.civ;
    const ids = civ.settlementIds.slice();
    for (const sid of ids) transferSettlement(world, sid, nid, 'union');
    for (const sid of ids) { const s = world.settlements[sid]; if (s?.alive) { s.loyalty = 0.7; s.unrest = Math.min(s.unrest, 0.2); s.flags.assim = Math.max(s.flags.assim, kin ? 0.9 : 0.5); s.flags.pacified = day; } }
    if (st) st.counters.unions++;
    const years = Math.max(1, Math.round((day - fin(civ.foundedDay)) / DAYS_PER_YEAR));
    record(world, { cat: 'civ', imp: fin(civ.peakPopulation) >= 20000 ? 3 : 2, key: 'realm.union', civ: nb, tags: ['union'], text: kin
      ? `After ${years} years apart, ${oldName} rejoined ${theName(nb)}, reuniting the ${nb.adjective} peoples.`
      : vassal ? `Long a vassal, ${oldName} was absorbed into ${theName(nb)}.`
        : `${oldName.charAt(0).toUpperCase() + oldName.slice(1)} joined ${theName(nb)} by treaty and marriage.` });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Golden and dark ages (civ.goldenAge / civ.darkAge = years remaining)

function startDark(world, civ, why, silent = false) {
  civ.darkAge = world.rng.int(12, 30);
  civ.goldenAge = 0;
  civ.flags.darkCause = why;
  refreshMods(world, civ);
  if (silent) return;
  const reason = {
    plague: pick(world, [', its cities emptied by hunger and plague', ', its people decimated']),
    defeat: pick(world, [', its provinces lost to its enemies', ' after a string of defeats']),
    strife: pick(world, [', torn by strife and misrule', ' amid feuds and broken oaths']),
    collapse: '',
  }[why] || '';
  record(world, { cat: 'civ', imp: fin(civ.population) >= 20000 ? 3 : 2, key: 'age.dark', civ, tags: [why], text: `${TheName(civ)} sank into a dark age${reason}.` });
}

/** Yearly age transitions. agg: { pop, n, avgHappy } */
export function ageCheck(world, civ, agg) {
  if (civ.goldenAge > 0 || civ.darkAge > 0) return;
  const ph = civ.flags.popHist, th = civ.flags.townHist;
  const pop10 = ph.length ? ph[Math.max(0, ph.length - 11)] : agg.pop;
  const town10 = th.length ? th[Math.max(0, th.length - 11)] : agg.n;
  // (histories are adjusted for towns gained or lost by transfer, so these are real losses)
  const popDrop = pop10 > 1500 ? 1 - agg.pop / pop10 : 0;
  const townDrop = town10 >= 4 ? 1 - agg.n / town10 : 0;
  // a people that has just come through a dark age does not fall into another at once
  const sinceAge = (world.time.day - fin(civ.flags.ageEndDay, -1e9)) / DAYS_PER_YEAR;
  if (sinceAge >= 40) {
    if (townDrop > 0.4 && world.rng.chance(0.4)) { startDark(world, civ, 'defeat'); return; }
    if (popDrop > 0.35 && world.rng.chance(0.4)) { startDark(world, civ, 'plague'); return; }
    if (civ.stability < 0.2 && civ.legitimacy < 0.35 && fin(civ.flags.crisisYears) >= 3 && world.rng.chance(0.2)) { startDark(world, civ, 'strife'); return; }
  }
  if (sinceAge < 15 || agg.pop < 2000) return; // golden ages belong to peoples of some size
  const growth = pop10 > 0 ? agg.pop / pop10 - 1 : 0;
  const recentWonder = civ.flags.lastWonderDay != null && world.time.day - civ.flags.lastWonderDay < 20 * DAYS_PER_YEAR;
  const figs = fin(civ.flags.figureTotal);
  const score = (civ.stability - 0.65) * 2 + (agg.avgHappy - 0.6) * 2 + (growth > 0.1 ? 0.1 : 0)
    + (recentWonder ? 0.25 : 0) + 0.05 * Math.min(3, figs) + (agg.atWar ? -0.1 : 0.05) + (agg.pop > 8000 ? 0.05 : -0.4);
  const p = Math.max(0, Math.min(0.012, score * 0.04));
  if (!world.rng.chance(p)) return;
  civ.goldenAge = world.rng.int(15, 40);
  refreshMods(world, civ);
  const who = civ.ruler ? `Under ${rulerName(civ.ruler)}, ` : '';
  const era = fin(civ.tech?.era, 0);
  const flourish = pick(world, era <= 1 ? [
    'its herds multiplied and its storytellers prospered',
    'its people knew peace and plenty',
    'its villages grew fat on good harvests',
  ] : [
    'its cities filled with poets, builders and scholars',
    'trade and learning flourished as never before',
    'its arts and markets flourished',
    'its people knew peace and plenty',
  ]);
  record(world, { cat: 'culture', imp: agg.pop >= 20000 ? 3 : 2, key: 'age.golden', civ, text: `${who}${theName(civ)} entered a golden age; ${flourish}.`.replace(/^the /, 'The ') });
}

/** Monthly countdown of ages; chronicles their end. */
export function ageTick(world, civ) {
  if (civ.goldenAge > 0) {
    civ.goldenAge = Math.max(0, civ.goldenAge - 1 / 12);
    noteDeed(civ, 'golden'); // months of golden age in this reign
    if (civ.goldenAge <= 0) {
      civ.flags.ageEndDay = world.time.day;
      refreshMods(world, civ);
      record(world, { cat: 'culture', imp: 1, key: 'age.golden.end', civ, text: pick(world, [`The golden age of ${theName(civ)} drew to a close.`, `The brilliance of ${peopleOf(civ)} faded as their golden age ended.`]) });
    }
  }
  if (civ.darkAge > 0) {
    civ.darkAge = Math.max(0, civ.darkAge - 1 / 12);
    if (civ.darkAge <= 0) {
      civ.flags.ageEndDay = world.time.day;
      refreshMods(world, civ);
      record(world, { cat: 'civ', imp: 2, key: 'age.dark.end', civ, text: pick(world, [`${TheName(civ)} emerged from its dark age.`, `The dark age of ${peopleOf(civ)} lifted at last.`]) });
    }
  }
}

export { govDef };
