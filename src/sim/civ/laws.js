// Who holds power, phase C: the laws (chunk 7, docs/design/who-holds-power.md).
//
//   civ.laws = { inherit: 'eldest' | 'divided' | 'elective' | 'seniority',
//                faith: 'one' | 'tolerated' | 'free',
//                bond: 'none' | 'serf' | 'slave',
//                land: 'crown' | 'nobles' | 'freeholds',
//                since: { law: day }, gov (the day of the government they were set under) }
//
// A realm starts with laws from its government, era and temperament (ext 'lawStart' lets a people
// set its own). Yearly at the realm's own month (lawsYearly) a law may change: a ruler's bent, an
// estate's power, the age (later ages free the bound), or a new government; at most one a year,
// and none within fifteen years of its last change. What they do:
//   - inherit: under 'divided', a realm of eight or more towns is split between two heirs at about
//     a third of successions (35 %; the 'succession' hook marks it, partitionMonthly splits it at
//     the end of the month): the heir keeps the capital and the towns nearest it, a younger heir
//     of the same house takes the rest; the two are kin, allied (geo/diplomacy.js hears
//     'realmPartition') and hold claims on each other. A realm once split drops the custom
//     readily (10 % a year). 'elective' raises the great's rights (power.js); 'seniority' gives
//     the throne to grown heirs (a little legitimacy at each succession).
//   - faith: the realm's tolerance trait drifts toward it (one 0.15, tolerated 0.5, free 0.85),
//     which the faith code and town happiness already read; the clergy's loyalty follows it.
//   - bond: serfdom binds two fifths of the commoners to the land (harvests +4 %), slavery holds
//     captives of war (work +5 %): an unfree estate (power.js) that can rise.
//   - land: crown land raises the taxes (+8 %), fiefs lower them (−10 %) and please the great,
//     freeholds please the commoners (harvests +3 %).
// Draws from world.rng: the starting laws, the yearly reforms, the partition's odds.

import { on, emit } from '../../core/hooks.js';
import { registerProvider, firstOf, hasProviders } from '../../core/ext.js';
import { temperOf, TP } from '../../core/character.js';
import { civSettlements, rel } from '../../core/entities.js';
import { DAYS_PER_YEAR as DPY } from '../../core/constants.js';
import { fin, record } from './state.js';
import { theName, TheName, rulerName, pick } from './prose.js';
import { splitCiv } from './peoples.js';
import { makeRuler, installRuler } from './rulers.js';
import { estatePower } from './power.js';

export const LAWS = {
  inherit: ['eldest', 'divided', 'elective', 'seniority'],
  faith: ['one', 'tolerated', 'free'],
  bond: ['none', 'serf', 'slave'],
  land: ['crown', 'nobles', 'freeholds'],
};
const TOLERANCE = { one: 0.15, tolerated: 0.5, free: 0.85 };
const SPLIT_MIN = 8, SPLIT_P = 0.35, GAP = 15;

const temper = (civ) => (civ.ruler ? temperOf(civ.ruler, civ) : [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
const elective = (g) => g === 'republic' || g === 'democracy' || g === 'theocracy' || g === 'merchant';

/** The laws a realm would start with now (its government, era, temperament; a people's own first). */
function startLaws(world, civ) {
  const g = civ.government, era = fin(civ.tech?.era, 0), rng = world.rng;
  const tol = fin(civ.traits?.tolerance, 0.5);
  const L = {};
  L.inherit = elective(g) ? 'elective'
    : g === 'tribe' || g === 'chiefdom' || g === 'horde' ? (rng.chance(0.4) ? 'divided' : 'eldest')
    : g === 'kingdom' || g === 'feudal' ? (era <= 4 && rng.chance(0.15) ? 'divided' : rng.chance(0.1) ? 'seniority' : rng.chance(0.08) ? 'elective' : 'eldest')
    : 'eldest';
  L.faith = g === 'theocracy' || tol < 0.35 ? 'one' : tol > 0.65 ? 'free' : 'tolerated';
  L.bond = era >= 5 || g === 'democracy' || g === 'constitutional' ? 'none'
    : g === 'feudal' ? (rng.chance(0.7) ? 'serf' : 'none')
    : era <= 3 && (g === 'kingdom' || g === 'empire' || g === 'chiefdom' || g === 'horde') ? (rng.chance(0.45) ? 'slave' : 'none')
    : era <= 1 && g === 'tribe' ? (rng.chance(0.3) ? 'slave' : 'none') : 'none';
  L.land = g === 'feudal' ? 'nobles'
    : g === 'empire' || g === 'dictatorship' || g === 'horde' || g === 'theocracy' ? 'crown'
    : g === 'kingdom' ? (rng.chance(0.5) ? 'nobles' : 'crown')
    : g === 'tribe' || g === 'chiefdom' ? (rng.chance(0.6) ? 'freeholds' : 'nobles') : 'freeholds';
  const own = hasProviders('lawStart') ? firstOf('lawStart', world, civ) : null;
  if (own && typeof own === 'object') for (const k in LAWS) if (LAWS[k].includes(own[k])) L[k] = own[k];
  return L;
}

/** The realm's laws, set on first use (old saves too). */
export function lawsOf(world, civ) {
  if (civ.laws && typeof civ.laws === 'object' && civ.laws.inherit) return civ.laws;
  const L = startLaws(world, civ);
  const day = world.time.day;
  civ.laws = { ...L, since: { inherit: day, faith: day, bond: day, land: day }, gov: fin(civ.flags?.govSince, day) };
  return civ.laws;
}

// --- what a change of law says -------------------------------------------------------------------

const WORDS = {
  inherit: {
    eldest: ['that the crown would pass whole to the eldest heir', 'that the realm would never again be shared among heirs'],
    divided: ['that the realm would be shared among all the ruler’s heirs, as the old custom held'],
    elective: ['that the great of the realm would choose each new ruler'],
    seniority: ['that the crown would pass to the eldest of the house, not to a child'],
  },
  faith: {
    one: ['that the realm would hold one faith only, and the others were forbidden'],
    tolerated: ['that the other faiths of the realm would be suffered, if not loved'],
    free: ['that every faith in the realm would be free to worship as it would'],
  },
  bond: {
    none: ['that the bound folk of the realm were free', 'the end of bondage in the realm'],
    serf: ['that the peasants were bound to the land and the lords who held it'],
    slave: ['that the captives of its wars would be held as slaves'],
  },
  land: {
    crown: ['that the great estates of the realm belonged to the crown', 'the seizure of the nobles’ lands for the crown'],
    nobles: ['that the land of the realm would be held in fiefs by its nobles'],
    freeholds: ['that the land would belong to those who worked it'],
  },
};
const WHY = {
  ruler: (civ) => (civ.ruler ? `${rulerName(civ.ruler)} of ${theName(civ)}` : TheName(civ)),
};

/** Change a law: why is a short clause ("pressed by its townsfolk"). Returns the chronicle entry. */
export function setLaw(world, civ, key, value, why = '', opts = {}) {
  const L = lawsOf(world, civ);
  if (!LAWS[key] || !LAWS[key].includes(value) || L[key] === value) return null;
  const was = L[key];
  L[key] = value;
  L.since[key] = world.time.day;
  if (opts.silent) return null;
  const words = pick(world, WORDS[key][value]);
  const lead = WHY.ruler(civ);
  const text = /^that /.test(words) ? `${lead} decreed ${words}${why ? `, ${why}` : ''}.` : `${lead} proclaimed ${words}${why ? `, ${why}` : ''}.`;
  const imp = key === 'bond' || (key === 'inherit' && (value === 'divided' || was === 'divided')) ? 3 : 2;
  return record(world, { cat: 'civ', imp, key: `law.${key}`, civ, tags: ['law', `law.${key}.${value}`], text });
}

/** Once a year at the realm's own month: the faith drifts toward its law; a law may change. */
export function lawsYearly(world, civ) {
  const L = lawsOf(world, civ);
  const day = world.time.day, rng = world.rng;
  civ.traits ||= {};
  const tol = fin(civ.traits.tolerance, 0.5);
  civ.traits.tolerance = Math.round((tol + (TOLERANCE[L.faith] - tol) * 0.1) * 1000) / 1000;
  // a new government brings its own laws
  const govSince = fin(civ.flags?.govSince, 0);
  if (govSince > fin(L.gov, 0)) {
    L.gov = govSince;
    const g = civ.government;
    if (elective(g)) setLaw(world, civ, 'inherit', 'elective', 'as the new order demanded', { silent: true });
    else if (L.inherit === 'elective') setLaw(world, civ, 'inherit', 'eldest', '', { silent: true });
    if (g === 'feudal' && L.land !== 'nobles') setLaw(world, civ, 'land', 'nobles', '', { silent: true });
    if ((g === 'republic' || g === 'democracy') && L.land === 'nobles') setLaw(world, civ, 'land', 'freeholds', '', { silent: true });
    if (g === 'theocracy') setLaw(world, civ, 'faith', 'one', '', { silent: true });
    return;
  }
  const ready = (k) => (day - fin(L.since[k], 0)) / DPY >= GAP;
  const tp = temper(civ);
  const era = fin(civ.tech?.era, 0);
  const pw = estatePower(civ) || [0.3, 0.05, 0.15, 0.4, 0.1];
  const est = civ.est || [];
  const loyal = (i) => fin(est[i]?.[3], 0.55);
  const g = civ.government;
  const tries = [];
  // bondage: later ages, merciful rulers and strong townsfolk free the bound; conquerors take slaves
  if (ready('bond')) {
    if (L.bond !== 'none' && era >= 5) tries.push(['bond', 'none', 0.02 * (1 + 3 * pw[2]), 'as the new age demanded']);
    else if (L.bond !== 'none' && era >= 3 && tp[TP.MER] > 0.7) tries.push(['bond', 'none', 0.01, 'out of mercy']);
    else if (L.bond === 'none' && era <= 3 && fin(civ.flags.conquests) >= 2 && (tp[TP.GRE] > 0.6 || tp[TP.MER] < 0.35)) tries.push(['bond', 'slave', 0.03, 'after its conquests']);
    else if (L.bond === 'none' && era >= 2 && era <= 4 && (g === 'feudal' || L.land === 'nobles') && loyal(3) < 0.5) tries.push(['bond', 'serf', 0.02, 'at the urging of its lords']);
  }
  if (ready('land')) {
    if (L.land !== 'crown' && tp[TP.AMB] > 0.65 && loyal(0) < 0.5 && (g === 'kingdom' || g === 'empire' || g === 'dictatorship' || g === 'constitutional')) tries.push(['land', 'crown', 0.02, 'to curb its nobles']);
    else if (L.land !== 'nobles' && pw[0] > 0.35 && fin(civ.legitimacy, 0.6) < 0.5 && era >= 2 && era <= 4) tries.push(['land', 'nobles', 0.02, 'to buy the loyalty of its nobles']);
    else if (L.land !== 'freeholds' && era >= 5 && pw[3] > 0.25 && (g === 'republic' || g === 'democracy' || g === 'constitutional')) tries.push(['land', 'freeholds', 0.02, 'pressed by its commoners']);
  }
  if (ready('faith')) {
    if (L.faith !== 'one' && tp[TP.PIE] > 0.7 && pw[1] > 0.08) tries.push(['faith', 'one', 0.02, 'at the urging of its clergy']);
    else if (L.faith === 'one' && fin(civ.flags.faithDis) > 0.3) tries.push(['faith', 'tolerated', 0.02, 'to quiet its many faiths']);
    else if (L.faith === 'tolerated' && era >= 4 && tp[TP.PIE] < 0.4 && fin(civ.flags.faithDis) > 0.2) tries.push(['faith', 'free', 0.015, '']);
  }
  if (ready('inherit') && !elective(g)) {
    if (L.inherit === 'divided' && fin(civ.flags.partitions) >= 1) tries.push(['inherit', 'eldest', 0.1, 'so that the realm would not be torn apart again']);
    else if (L.inherit === 'divided' && era >= 3 && tp[TP.AMB] > 0.55) tries.push(['inherit', 'eldest', 0.04, 'so that the realm would not be torn apart']);
    else if (L.inherit === 'eldest' && pw[0] > 0.4 && fin(civ.legitimacy, 0.6) < 0.4) tries.push(['inherit', 'elective', 0.01, 'forced by its nobles']);
    else if (L.inherit === 'eldest' && rng.chance(0.2)) tries.push(['inherit', 'seniority', 0.005, '']);
  }
  for (const [k, v, p, why] of tries) {
    if (rng.chance(p)) { setLaw(world, civ, k, v, why); break; }
  }
}

// --- divided inheritance ---------------------------------------------------------------------------

// a ruler dies under the divided law: the realm will be split between two heirs (at month's end)
on('succession', (world, civ, prev, r, how) => {
  if (!civ || !civ.alive || !civ.laws || civ.laws.inherit !== 'divided') return;
  if (how !== 'heir' && how !== 'kin') return;
  if (civ.settlementIds.length < SPLIT_MIN || civ.flags?.union) return;
  if (!world.rng.chance(SPLIT_P)) return;
  civ.flags.partition = { day: world.time.day, prev: prev ? rulerName(prev) : null };
});

// the seniority law: grown heirs, a little more legitimacy
on('succession', (world, civ, prev, r, how) => {
  if (civ && civ.laws && civ.laws.inherit === 'seniority' && (how === 'heir' || how === 'kin')) civ.legitimacy = Math.min(1, fin(civ.legitimacy, 0.6) + 0.03);
});

/** At the end of a month a realm marked for partition is split between its heirs. */
export function partitionMonthly(world, civ) {
  const pt = civ.flags && civ.flags.partition;
  if (!pt) return;
  delete civ.flags.partition;
  if (!civ.alive || civ.settlementIds.length < SPLIT_MIN || civ.flags.union) return;
  const cap = world.settlements[civ.capitalId];
  if (!cap || !cap.alive) return;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const towns = civSettlements(world, civ).filter((s) => s.id !== cap.id).sort((a, b) => d(b, cap) - d(a, cap));
  if (towns.length < 4) return;
  // the younger heir takes the towns nearer the farthest town than the capital: a block of the realm
  const far = towns[0];
  let share = towns.filter((s) => d(s, far) < d(s, cap));
  const half = Math.floor(towns.length / 2);
  if (share.length < 2 || share.length > towns.length - 2) share = towns.slice(0, half);
  const heir = civ.ruler;
  const res = splitCiv(world, civ, share.map((s) => s.id), { cause: 'partition', government: civ.government, nameFrom: 'city', loyalty: 0.75 });
  if (!res) return;
  const kid = res.civ;
  // a younger heir of the same house; the two crowns kin, allied, each with a claim on the other
  const house = civ.dynasty || heir?.dynasty || null;
  if (house) kid.dynasty = house;
  const r = makeRuler(world, kid, { dynasty: house, age: [16, 36], inherit: heir?.traits });
  installRuler(world, kid, r, null);
  kid.laws = { ...lawsOf(world, civ), since: { ...civ.laws.since } };
  for (const [a, b] of [[civ, kid], [kid, civ]]) {
    const q = rel(world, a.id, b.id);
    q.opinion = Math.max(fin(q.opinion), 40);
    q.trust = Math.max(fin(q.trust, 0.5), 0.7);
    a.claims ||= {};
    a.claims[b.id] = Math.max(fin(a.claims[b.id]), 0.5);
  }
  civ.flags.partitions = fin(civ.flags.partitions) + 1;
  emit(world, 'realmPartition', civ, kid);
  const kc = world.settlements[kid.capitalId];
  const others = Math.max(0, kid.settlementIds.length - 1);
  record(world, { cat: 'civ', imp: 3, key: 'realm.partition', civ, tags: ['partition', 'law'], text: pick(world, [
    `${pt.prev ? `On the death of ${pt.prev}, ` : ''}${theName(civ)} was divided between heirs as its law required: ${heir ? rulerName(heir) : 'the elder'} kept ${cap.name}, and ${rulerName(r)} took ${kc ? kc.name : 'the far provinces'}${others ? ` and ${others} other town${others > 1 ? 's' : ''}` : ''} as ${theName(kid)}.`,
    `By the old custom of shares, ${theName(civ)} was split in two${pt.prev ? ` when ${pt.prev} died` : ''}: ${kc ? kc.name : 'the far provinces'} went to ${rulerName(r)}, who ruled it as ${theName(kid)}.`,
  ]) });
}

// --- the laws' effects on the realm's work -----------------------------------------------------------

/** Harvests and work under the realm's laws (ext 'mods'): serfdom and freeholds farm more, slaves work more. */
registerProvider('mods', 'laws', (world, civ) => {
  const L = civ && civ.laws;
  if (!L) return null;
  const m = {};
  if (L.bond === 'serf') m.farmYield = 0.04;
  else if (L.bond === 'slave') m.production = 0.05;
  if (L.land === 'freeholds') m.farmYield = (m.farmYield || 0) + 0.03;
  return Object.keys(m).length ? m : null;
});

