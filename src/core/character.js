// Character (chunk 4, docs/design/character.md): the temperament and skills of the notable
// people — rulers and their heirs, commanders, great people — read by the decisions they make.
//
//   person.tp = [amb, mer, pie, gre, hon, bol]   temperament, 0..1: ambition, mercy (low is
//                cruelty), piety, greed, honour, boldness (low is caution)
//   person.sk = [war, dip, ste, int, lea]        skills, 0..1: war, diplomacy, stewardship,
//                intrigue, learning
//
// Both are made at the first read, never by world.rng: the person's named traits set the
// temperament they speak of (a cruel ruler's mercy is low, a warlike one bold and ambitious),
// the realm's own temper leans the rest, and a hash of the person (name and birth) gives each
// their own grain. So an old save's rulers keep their traits and gain a nature to match, and
// the world's mix of named traits stays as it was. Skills start from age, traits and nature;
// growSkills moves them yearly (fastest at 20 to 40, a little lost after 60), and use adds to
// them (useSkill: battles, years on the throne).
//
//   person.bd = { w: [code], ill: code|null, illDay, mad: day|null }   the body: wounds (eye, hand,
//                lame, scar), a lasting illness, madness (bodyOf; the civ module rolls illness and
//                madness, the war module the wounds)
//
// Exports: TP, SK, temperOf, skillsOf, growSkills, useSkill, warTemper, natureWords, whyWords,
//          bodyOf, wound, WOUND_WORDS, WOUND_EPITHETS, ILLNESSES, madTemper, ambitionPull
//
//   person.am = { k, t, since, by }   an ambition (civ/ambitions.js draws, meets and fails them);
//   person.done = [[k, outcome, day, t]]   the last four resolved

import { DAYS_PER_YEAR } from './constants.js';
import { firstOf, hasProviders } from './ext.js';

export const TP = { AMB: 0, MER: 1, PIE: 2, GRE: 3, HON: 4, BOL: 5 };
export const SK = { WAR: 0, DIP: 1, STE: 2, INT: 3, LEA: 4 };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
const r2 = (v) => Math.round(v * 100) / 100;

/** A stable number in [0, 1) for a person and a salt. */
function grain(person, salt) {
  let h = 2166136261 ^ salt;
  const s = String(person.name || '') + ':' + fin(person.born, 0) + ':' + fin(person.id, -1);
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
// a spread around 0 (about ±0.12), from two grains
const jitter = (person, salt) => (grain(person, salt) + grain(person, salt + 97) - 1) * 0.17;

// what each named trait says of the temperament: [axis, value]
const TRAIT_TP = {
  cruel: [[TP.MER, 0.1]], just: [[TP.MER, 0.8], [TP.HON, 0.8]], pious: [[TP.PIE, 0.85]],
  warlike: [[TP.BOL, 0.82], [TP.AMB, 0.7]], craven: [[TP.BOL, 0.12]], greedy: [[TP.GRE, 0.85]],
  generous: [[TP.GRE, 0.12]], ambitious: [[TP.AMB, 0.85]], lazy: [[TP.AMB, 0.15]], cautious: [[TP.BOL, 0.28]],
  paranoid: [[TP.HON, 0.4]], industrious: [[TP.AMB, 0.62]],
};

/**
 * A person's temperament, made at the first read. civ (optional) leans it by the realm's temper:
 * aggression toward boldness, religiosity toward piety, commerce toward greed, tolerance toward mercy.
 */
export function temperOf(person, civ = null) {
  if (!person) return [0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  if (Array.isArray(person.tp) && person.tp.length === 6) return person.tp;
  const t = civ && civ.traits ? civ.traits : {};
  const lean = [0, 0.3 * (fin(t.tolerance, 0.5) - 0.5), 0.3 * (fin(t.religiosity, 0.5) - 0.5), 0.3 * (fin(t.commerce, 0.5) - 0.5), 0, 0.3 * (fin(t.aggression, 0.5) - 0.5)];
  // how a society raises its people (ext 'temperRule'; by default its traits alone)
  const rule = hasProviders('temperRule') ? firstOf('temperRule', null, civ, person) : null;
  if (Array.isArray(rule)) for (let k = 0; k < 6; k++) lean[k] += Math.max(-0.4, Math.min(0.4, fin(rule[k], 0)));
  const tp = [0, 1, 2, 3, 4, 5].map((k) => 0.5 + lean[k] + jitter(person, 11 + k));
  for (const tr of person.traits || []) for (const [k, v] of TRAIT_TP[tr] || []) tp[k] = v + jitter(person, 31 + k) * 0.5;
  person.tp = tp.map((v) => r2(clamp01(v)));
  return person.tp;
}

const ageOf = (person, day, life) => (fin(day) - fin(person.born, day)) / DAYS_PER_YEAR / (life || 1);

/**
 * A person's skills, made at the first read from age, traits and temperament. day: today;
 * life: the people's age divisor (an elf of 150 is a human of 30).
 */
export function skillsOf(person, day, life = 1) {
  if (!person) return [0.3, 0.3, 0.3, 0.3, 0.3];
  if (Array.isArray(person.sk) && person.sk.length === 5) return person.sk;
  const tp = temperOf(person);
  const tr = new Set(person.traits || []);
  const ripe = clamp01((ageOf(person, day, life) - 15) / 30);
  const base = 0.12 + 0.32 * ripe;
  const sk = [
    base + 0.15 * (tp[TP.BOL] - 0.5) + (tr.has('warlike') ? 0.12 : 0),
    base + (tr.has('charismatic') ? 0.15 : 0) + (tr.has('wise') ? 0.08 : 0) + 0.1 * (tp[TP.HON] - 0.5),
    base + (tr.has('wise') ? 0.1 : 0) + (tr.has('industrious') ? 0.12 : 0) - (tr.has('lazy') ? 0.12 : 0),
    base + (tr.has('paranoid') ? 0.15 : 0) + 0.1 * (0.5 - tp[TP.HON]),
    base + (tr.has('scholarly') ? 0.18 : 0) + (tr.has('brilliant') ? 0.15 : 0),
  ].map((v, k) => r2(clamp01(v + jitter(person, 51 + k) - (tr.has('foolish') ? 0.1 : 0))));
  person.sk = sk;
  return sk;
}

/** Each skill's ceiling for this person (0.45–0.95): talent, and what they are inclined to. */
function ceiling(person, k) {
  const tr = person.traits || [];
  let c = 0.55 + 0.35 * grain(person, 71 + k);
  if (k === SK.LEA && (tr.includes('scholarly') || tr.includes('brilliant'))) c += 0.15;
  if (k === SK.WAR && tr.includes('warlike')) c += 0.1;
  if (tr.includes('foolish')) c -= 0.15;
  return Math.max(0.45, Math.min(0.95, c));
}

/** A year older: each skill grows toward its ceiling, fastest at 20 to 40; a little is lost after 60. */
export function growSkills(person, day, life = 1) {
  const sk = skillsOf(person, day, life);
  const a = ageOf(person, day, life);
  const rate = a < 20 ? 0.06 : a < 40 ? 0.08 : a < 60 ? 0.03 : 0;
  for (let k = 0; k < 5; k++) {
    let v = sk[k] + rate * (ceiling(person, k) - sk[k]);
    if (a > 60) v -= 0.006 * (a - 60) / 10;
    sk[k] = r2(clamp01(v));
  }
}

/** Experience in one skill (a battle led, a year of rule): up to its ceiling. */
export function useSkill(person, k, amt) {
  if (!person || !Array.isArray(person.sk)) return;
  person.sk[k] = r2(Math.min(ceiling(person, k), person.sk[k] + amt));
}

/**
 * × on a ruler's appetite for war from their nature and their skill at it (about 1 for an
 * ordinary ruler; ≈ 1.9 for a bold, ambitious one, ≈ 0.6 for a timid one).
 */
export function warTemper(person, civ) {
  const tp = temperOf(person, civ);
  return Math.exp(1.1 * (tp[TP.AMB] - 0.5) + 1.3 * (tp[TP.BOL] - 0.5) - 0.6 * (tp[TP.MER] - 0.5));
}

const WORDS = [
  [TP.AMB, 0.72, 'ambitious'], [TP.BOL, 0.72, 'bold'], [TP.MER, -0.28, 'ruthless'], [TP.GRE, 0.75, 'greedy'],
  [TP.PIE, 0.8, 'zealous'], [TP.HON, -0.25, 'faithless'], [TP.MER, 0.78, 'merciful'], [TP.HON, 0.8, 'honourable'],
  [TP.BOL, -0.25, 'cautious'], [TP.GRE, -0.2, 'open-handed'], [TP.AMB, -0.2, 'unambitious'], [TP.PIE, -0.15, 'worldly'],
];

/** The words for a person's nature, strongest first: ["ambitious", "ruthless"]. */
export function natureWords(person, civ = null, n = 2) {
  const tp = temperOf(person, civ);
  const out = [];
  for (const [k, edge, w] of WORDS) {
    const v = tp[k];
    const by = edge < 0 ? -edge - v : v - edge;
    if (by >= 0) out.push([by, w]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, n).map((x) => x[1]);
}

/** The words that drove a ruler to war (their ambition, boldness, cruelty), or [] for an ordinary one. */
export function whyWords(person, civ = null) {
  const tp = temperOf(person, civ);
  const out = [];
  if (tp[TP.AMB] >= 0.7) out.push('ambitious');
  if (tp[TP.BOL] >= 0.7) out.push('restless');
  if (tp[TP.MER] <= 0.25) out.push('ruthless');
  if (tp[TP.GRE] >= 0.8) out.push('greedy for land');
  return out.slice(0, 2);
}

// ---------------------------------------------------------------------------
// The body

export const WOUND_WORDS = { eye: 'lost an eye', hand: 'lost a hand', lame: 'was lamed', scar: 'took a wound to the face' };
export const WOUND_EPITHETS = { eye: 'the One-Eyed', hand: 'the One-Handed', lame: 'the Lame', scar: 'the Scarred' };
export const ILLNESSES = { wasting: 'the wasting sickness', falling: 'the falling sickness', shaking: 'the shaking palsy', lungs: 'a sickness of the lungs' };

/** A person's body record, made when first needed. */
export function bodyOf(person) {
  if (!person.bd || typeof person.bd !== 'object') person.bd = { w: [], ill: null, illDay: null, mad: null };
  return person.bd;
}

/** A wound: an eye or a hand costs skill at arms, lameness boldness in the field. */
export function wound(person, code) {
  const bd = bodyOf(person);
  if (bd.w.includes(code) && code !== 'scar') return false;
  bd.w.push(code);
  if (bd.w.length > 4) bd.w.shift();
  if (Array.isArray(person.sk) && (code === 'eye' || code === 'hand')) person.sk[SK.WAR] = r2(clamp01(person.sk[SK.WAR] - 0.1));
  if (Array.isArray(person.tp) && code === 'lame') person.tp[TP.BOL] = r2(clamp01(person.tp[TP.BOL] - 0.15));
  return true;
}

/** A mad person's temperament for the year: their own, thrown about by the year (no rng). */
export function madTemper(person, year) {
  const tp = temperOf(person);
  person.tp = tp.map((v, k) => r2(clamp01(v + (grain(person, 900 + year * 7 + k) - 0.5) * 0.8)));
  return person.tp;
}

// ---------------------------------------------------------------------------
// Ambitions (civ/ambitions.js keeps them; the war system feels them here)

/**
 * × on a ruler's desire for war on realm bId from their ambition: to take a town it holds (× 2),
 * to avenge themselves on it (× 2.5), to unite their people with it (× 2), to bring it their faith
 * in a holy war (× 1.5). world: for the town's holder.
 */
export function ambitionPull(world, person, bId, cbKey) {
  const am = person && person.am;
  if (!am) return 1;
  switch (am.k) {
    case 'town': { const s = world.settlements[am.t]; return s && s.alive && s.civId === bId ? 2 : 1; }
    case 'avenge': return am.t === bId ? 2.5 : 1;
    case 'unite': return am.t === bId ? 2 : 1;
    case 'convert': return am.t === bId && cbKey === 'holy' ? 1.5 : 1;
    default: return 1;
  }
}

/** An ambition's words: {t} a town, {c} a realm, {f} a faith, {p} a people (filled in by the reader). */
export const AMBITION_WORDS = {
  town: 'to take {t}', avenge: 'to be avenged on {c}', unite: 'to unite {p} under one crown', convert: 'to bring {f} to {c}',
  wonder: 'to raise a great work', golden: 'to see a golden age', throne: 'the throne', glory: 'glory in battle', power: 'power',
  masterpiece: 'a masterpiece', discovery: 'a great discovery', voyage: 'a great voyage', fortune: 'a fortune', beast: 'to slay a great beast',
};

/** Resolve a person's ambition: moved to person.done (the last four) as met, failed or gone. */
export function settleAmbition(person, outcome, day) {
  const am = person && person.am;
  if (!am) return null;
  person.am = null;
  person.done = (person.done || []).concat([[am.k, outcome, day, am.t ?? null]]).slice(-4);
  return am;
}
