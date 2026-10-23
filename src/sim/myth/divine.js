// The gods answer (Mythic worlds): each faith's god has a domain drawn from its doctrine and
// a favour earned from fervour, followers, temples and an unbroken holy city. When a town
// whose faith stands high in favour is besieged, starving or plague-struck, its god may
// answer — rarely (1.6 % × favour × divineIntervention × how well the domain fits the crisis,
// a month), never twice in thirty years for one town or in twenty-five years for one faith,
// and at most once a decade in the whole world. Miracles act through the owners' published exports (WP4 clearSiege, cureTown,
// boostFervor) and settlement effects, and each one rekindles the faith's fervour.
//
// sys.myth.favor[rid] 0..1 (monthly) · sys.myth.divine { cd: { sid: day }, n, last, byDomain }.

import { addEffect } from '../../core/effects.js';
import { emitFx } from '../../core/world.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH } from '../../core/constants.js';
import { fin } from './races.js';
import { pickT, fill, record, yearOfDay, seasonAt, monthNameOf } from './prose.js';

let war = null, disease = null, religion = null;
try { war = await import('../geo/war.js'); } catch (e) { /* war module unavailable: sieges are only endured */ }
try { disease = await import('../geo/disease.js'); } catch (e) { /* disease module unavailable */ }
try { religion = await import('../geo/religion.js'); } catch (e) { /* religion module unavailable */ }

/** Domain of a faith's god, from its doctrine key (geo/religion.js DOCTRINES). */
export const DOMAINS = {
  sun: 'sun', storm: 'storm', mother: 'harvest', moon: 'night', ancestors: 'death', spirits: 'nature',
  pantheon: 'war', mystery: 'secrets', dualism: 'light', monotheism: 'order', stars: 'fate', way: 'balance', reason: null,
};
export const DOMAIN_LABEL = {
  sun: 'the Sun', storm: 'the Storm', harvest: 'the Harvest', night: 'the Night', death: 'the Dead', nature: 'the Wild',
  war: 'War', secrets: 'Secrets', light: 'Light', order: 'Order', fate: 'Fate', balance: 'the Balance',
};
export const domainOf = (r) => (r ? DOMAINS[r.doctrine] ?? null : null);

// how well a domain answers each crisis
const FIT = {
  siege: { storm: 2, war: 1.7, sun: 1.3, order: 1.2, light: 1.2, fate: 1, night: 1, secrets: 1, death: 0.8, nature: 0.8, harvest: 0.6, balance: 0.7 },
  famine: { harvest: 2, nature: 1.6, sun: 1.3, storm: 1.2, night: 0.9, balance: 0.9, order: 0.8, light: 0.8, fate: 0.7, death: 0.6, war: 0.5, secrets: 0.6 },
  plague: { sun: 1.5, harvest: 1.3, nature: 1.3, light: 1.3, order: 1, balance: 1, night: 0.8, fate: 0.8, secrets: 0.8, death: 0.5, storm: 0.6, war: 0.5 },
};

/** Favour targets, monthly: fervour × followers × temples × an unbroken holy city. */
export function favourMonthly(world) {
  const st = world.sys.myth;
  const fav = st.favor;
  const towns = new Map();   // rid → [dominant towns, with temples]
  for (const s of world.settlements) {
    if (!s || !s.alive || s.dominantReligion == null) continue;
    const t = towns.get(s.dominantReligion) || [0, 0];
    t[0]++; if (fin(s.buildings?.temple, 0) > 0) t[1]++;
    towns.set(s.dominantReligion, t);
  }
  for (const r of world.religions || []) {
    if (!r) continue;
    const key = String(r.id);
    if (r.alive === false || !domainOf(r)) { if (key in fav) delete fav[key]; continue; }
    const t = towns.get(r.id) || [0, 0];
    const temples = t[0] ? t[1] / t[0] : 0;
    const holy = world.settlements[r.holyCityId];
    const intact = holy && holy.alive && holy.dominantReligion === r.id;
    const target = Math.min(1, Math.max(0, fin(r.fervor, 0.5))) * Math.min(1, Math.log10(1 + fin(r.followers, 0)) / 6.2) * (0.5 + 0.5 * temples) * (intact ? 1 : 0.7);
    const cur = fin(fav[key], target * 0.5);
    fav[key] = Math.round((cur + (target - cur) * 0.1) * 1000) / 1000;
  }
}

const SIEGE_TEXT = {
  storm: [
    'Thunder split the siege lines before {town} in the {season} of Year {y}, and the faithful praised {deity} of the Storm.',
    'A storm out of a clear sky broke over the camp before {town}; the {foe} host fled in the hail, and every bell in the city rang for {deity}.',
    'Lightning walked through the {foe} siege engines before {town} one night in Year {y}; by morning the besiegers were gone, and the people sang to {deity}.',
    'The rains of {deity} turned the {foe} trenches before {town} into rivers, and the host went home through the mud.',
  ],
  war: [
    'At {town} the defenders swore they saw {deity} walk the walls with a spear of light, and the {foe} besiegers broke before dawn.',
    'In Year {y} {deity}, god of war, was seen in the gate of {town}; the {foe} host would not storm it, and the siege was raised.',
    'A sally from {town} led by a stranger in bronze broke the {foe} lines in Year {y}; the priests said it was {deity} himself, and no one gainsaid them.',
  ],
  sun: [
    'The sun stood so fierce over the camp before {town} that the {foe} host struck its tents; the priests of {deity} called it judgement.',
    'For nine days the sun burned without a cloud over the besiegers of {town}, until they marched away; the city gave thanks to {deity}.',
    'The wells of the {foe} camp before {town} dried up in the {season} of Year {y}, while the cisterns of the city stayed full; the faithful of {deity} needed no other sign.',
    'At noon on the longest day of Year {y} the light over {town} grew too bright to look at, and the {foe} host, half-blind, broke camp in fear of {deity}.',
  ],
  default: [
    'The prayers of besieged {town} were answered in Year {y}: {deity} {act}, and the siege was lifted.',
    'Before {town}, {deity} {act}; the {foe} host broke camp, and pilgrims still climb to the temple where the city prayed.',
    'Besieged {town} kept a vigil to {deity} through the {season} of Year {y}; the god {act}, and the {foe} host melted away.',
  ],
};
/** A god's later answers recall the first (the faithful keep count). */
const AGAIN = [
  ' As at {prevTown} in Year {prevY}, {deity} had not forsaken the faithful.',
  ' It was said in the temples that {deity} had done no less for {prevTown} in Year {prevY}.',
  ' The priests of {deity} counted it the god’s {nth} answer since {prevTown}.',
];
const NTH = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const SIEGE_ACT = {
  night: 'sent a fog so thick the besiegers lost one another', nature: 'loosed the beasts of the forest on the besiegers’ camp',
  death: 'sent a sickness through the besiegers’ camp and spared the city', harvest: 'rotted the besiegers’ stores in a single night',
  fate: 'turned every omen against the besiegers', order: 'struck the besiegers’ captains with confusion', light: 'blinded the besiegers with a light from the temple',
  balance: 'stilled the anger of the besiegers', secrets: 'showed the defenders a hidden way out to burn the siege engines',
  storm: 'sent the storm', war: 'stood upon the walls', sun: 'burned the camp',
};
const SIEGE_HOLD = [
  'Besieged {town} prayed to {deity}, and the defenders fought as if the god stood beside them; the walls held through the {season}.',
  'In the siege of {town}, the priests of {deity} walked the walls with the god’s image, and not one gate gave way.',
  'The besieged of {town} slept in the temple of {deity} and woke each morning to fight again; the {foe} host never found the way in.',
];
const FAMINE_TEXT = {
  harvest: [
    'In the famine of Year {y}, {deity} answered the prayers of {town}: the barley stood tall again before {month}.',
    'The hungry of {town} carried {deity}’s image into the empty fields, and they say the grain rose behind it.',
  ],
  default: [
    'The starving of {town} prayed to {deity} in the famine of Year {y}, and {miracle}.',
    'When famine gripped {town}, {deity} heard the people: {miracle}, and the town lived.',
  ],
};
const FAMINE_ACT = {
  storm: 'rain came at last to the parched fields', sun: 'the late fields ripened in a single week of sun', nature: 'the woods about the town filled with game',
  night: 'the fish crowded the shallows under every full moon', death: 'the ancestors showed the elders where the old grain stores lay',
  default: 'the granaries were found full one morning, though no one would say who had filled them',
};
const PLAGUE_TEXT = [
  '{Plague} lifted from {town} in a single night, and pilgrims came from far and wide to give thanks to {deity}.',
  'When {plague} reached {town}, the priests of {deity} carried the god’s image through the streets, and from that day no one else fell sick.',
  'In the {season} of Year {y} the sick of {town} were laid before the altar of {deity}, and rose healed; {plague} went no further.',
];

/** Monthly: favour, then the gods' answers to towns in crisis. */
export function divineMonthly(world) {
  favourMonthly(world);
  const k = fin(world.params.divineIntervention, 1);
  if (k <= 0) return;
  const st = world.sys.myth;
  const dv = st.divine;
  const day = world.time.day;
  // miracles are rare: ten years between any two in the world, forty for one faith
  if (dv.last != null && day - dv.last < 10 * DAYS_PER_YEAR) return;
  const rng = world.rng;
  for (const s of world.settlements) {
    if (!s || !s.alive || s.dominantReligion == null) continue;
    const crisis = s.siege ? 'siege' : fin(s.famine, 0) >= 2 ? 'famine' : s.disease && fin(s.disease.I, 0) > 0.02 ? 'plague' : null;
    if (!crisis) continue;
    const r = world.religions?.[s.dominantReligion];
    const dom = domainOf(r);
    if (!r || r.alive === false || !dom) continue;
    const fav = fin(st.favor[String(r.id)], 0);
    if (fav <= 0.3) continue;
    const lastF = dv.byFaithDay?.[String(r.id)];
    if (lastF != null && day - lastF < 40 * DAYS_PER_YEAR) continue;
    const cd = dv.cd[s.id];
    if (cd != null && day - cd < 30 * DAYS_PER_YEAR) continue;
    const p = 0.016 * fav * k * (FIT[crisis][dom] || 0.7) * (crisis === 'plague' ? 0.3 : crisis === 'famine' ? 0.6 : 1) * ((r.tenets || []).includes('healing') && crisis === 'plague' ? 1.5 : 1);
    if (!rng.chance(p)) continue;
    answer(world, s, r, dom, crisis);
    return;   // one miracle at a time
  }
}

function answer(world, s, r, dom, crisis) {
  const st = world.sys.myth;
  const dv = st.divine;
  const day = world.time.day;
  const rng = world.rng;
  const civ = world.civs[s.civId];
  const foeCiv = crisis === 'siege' && s.siege ? world.civs[s.siege.civId] : null;
  const vars = {
    town: s.name, deity: r.deity || 'the god', y: yearOfDay(day), season: seasonAt(world, s.y), month: monthNameOf(day + 3 * DAYS_PER_MONTH),
    foe: foeCiv?.adjective || 'enemy', act: SIEGE_ACT[dom] || 'answered', miracle: FAMINE_ACT[dom] || FAMINE_ACT.default,
    // a plague's name with one article ("the Withering Sickness"), never "the the"
    plague: 'the ' + String(world.plagues?.[s.disease?.pid]?.name || 'sickness').replace(/^the\s+/i, ''),
  };
  vars.Plague = vars.plague.charAt(0).toUpperCase() + vars.plague.slice(1);
  let text;
  const until = (y) => day + Math.round(y * DAYS_PER_YEAR);
  if (crisis === 'siege') {
    let lifted = false;
    if (typeof war?.clearSiege === 'function') { try { war.clearSiege(world, s, 'divine'); lifted = !s.siege; } catch (e) { lifted = false; } }
    addEffect(world, { kind: 'settlement', id: s.id }, { k: 'myth.divine.ward', until: until(3), m: { defense: 0.3, happiness: 0.05 }, label: `Under the hand of ${vars.deity}` });
    text = fill(pickT(rng, lifted ? (SIEGE_TEXT[dom] || SIEGE_TEXT.default) : SIEGE_HOLD), vars);
  } else if (crisis === 'famine') {
    addEffect(world, { kind: 'settlement', id: s.id }, { k: 'myth.divine.harvest', until: until(2), m: { foodYield: 1.6, happiness: 0.05 }, label: `The harvest of ${vars.deity}` });
    text = fill(pickT(rng, FAMINE_TEXT[dom] || FAMINE_TEXT.default), vars);
  } else {
    let cured = false;
    if (typeof disease?.cureTown === 'function') { try { disease.cureTown(world, s); cured = !s.disease; } catch (e) { cured = false; } }
    if (!cured) addEffect(world, { kind: 'settlement', id: s.id }, { k: 'myth.divine.healing', until: until(1), m: { plagueDose: 0.3, health: 0.08 }, label: `The healing of ${vars.deity}` });
    text = fill(pickT(rng, PLAGUE_TEXT), vars);
  }
  // a faith's later miracles remember its first; only the first is a great event
  dv.byFaithAt ||= {};
  const prev = dv.byFaithAt[String(r.id)];
  const nth = fin(dv.byFaith?.[String(r.id)], 0) + 1;
  if (prev && prev.town && prev.town !== s.name) text += fill(pickT(rng, AGAIN), { ...vars, prevTown: prev.town, prevY: prev.y, nth: NTH[nth - 1] || `${nth}th` });
  if (!prev) dv.byFaithAt[String(r.id)] = { town: s.name, y: vars.y };
  if (typeof religion?.boostFervor === 'function') { try { religion.boostFervor(world, r.id, 0.06); } catch (e) { /* fervour unchanged */ } }
  st.favor[String(r.id)] = Math.max(0, fin(st.favor[String(r.id)], 0) - 0.25);
  dv.cd[s.id] = day;
  dv.last = day;
  dv.n = fin(dv.n, 0) + 1;
  dv.byDomain[dom] = fin(dv.byDomain[dom], 0) + 1;
  dv.byFaith ||= {};
  dv.byFaithDay ||= {};
  dv.byFaithDay[String(r.id)] = day;
  dv.byFaith[String(r.id)] = fin(dv.byFaith[String(r.id)], 0) + 1;
  emitFx(world, { type: 'spell', x: s.x, y: s.y, r: 3, color: [240, 214, 140] });
  const entry = record(world, {
    cat: 'religion', imp: nth > 1 ? 2 : 3, key: `myth.divine.${crisis}`, tags: ['miracle', dom],
    text, x: s.x, y: s.y, sid: s.id, civId: civ?.id ?? null, ref: { k: 'religion', id: r.id },
  });
  dv.lastAt = { x: s.x, y: s.y, sid: s.id, rid: r.id, seq: entry ? entry.seq : null };
}

/** Drop cooldowns older than thirty years (yearly), so the state stays small. */
export function pruneDivine(world) {
  const dv = world.sys.myth?.divine;
  if (!dv) return;
  const day = world.time.day;
  for (const k of Object.keys(dv.cd)) if (day - dv.cd[k] >= 30 * DAYS_PER_YEAR) delete dv.cd[k];
}
