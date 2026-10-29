// Health and sickness (chunk 11, docs/design/health-and-sickness.md): how each people, custom,
// faith and town keeps itself well or falls ill, so that plagues fall unevenly.
//
//   sys.health = { p: { [people]: { h, c, k, sh? } }, v }
//     people  a people key ('r:elf', 'f:12': geo/folk.js)
//     h   hardiness, 0 to H_MAX: what the plagues it lived through left behind; fades over about
//         three generations, down to a floor for a people of great cities
//     c   its custom of cleanliness (CUSTOMS)
//     k   the peoples whose sicknesses it has met (≤ KNOWN_MAX, the newest last)
//     sh  the day it shut its bathhouses in fear of a plague
//   s.sick = { im, ht, sl, b, fr, fv, sn, dr? } on each live town, written on its yearly pass:
//     im  × how readily sickness spreads in the town for how it lives (its faith, physicians,
//         slums, a holy city's crowds)
//     ht  added to its health (ext townHealth): its peoples' customs, physicians, slums, fever
//     sl  its slums (0..1), following overcrowding; b  what it is built of ('t' timber, 'm' mud
//         brick, 's' stone); fr  × its fire risk (events/decks/town.js)
//     fv  the fever of its ground (0..1: marsh, hot wet forest), sn  how seasoned
//         its people are to it (0..1), dr  the day its marshes are drained (then fv × 0.25)
//   civ.physic  its physicians' theory (PHYSIC)
//   army.flags.cf = { d, k, n }  camp fever: since, how hard, the men it has cost
//   plague.op   the people whose sickness it is (a contact plague: the strangers'); plague.byP
//               { [people]: [dead, exposed] }, the six with the most dead kept when it ends
//
// In a plague town (disease.js sirTick, every 5 days) each people catches the sickness by
// √frailty × its custom and dies of it by √frailty, frailty = ext 'frailty' (Mythic: by race) ×
// (1 − hardiness). A people that has never met the sickness's people, from a homeland far from
// theirs, takes it as virgin soil (up to × 1.4 catching and × 4.5 dying). The dead are taken from
// each people's own table (Mythic) or shift the town's mix (Historical). A people learns another's
// sicknesses by living in its towns, trading with it, and surviving its plagues.
//
// Draws from world.rng only in the yearly and plague-end passes, in a fixed order.
// Faiths (teachingOf) and physicians (PHYSIC, civ.physic: a ladder a realm climbs by its techs,
// Mythic peoples starting from lores of their own) change infection and deaths, and in a plague's
// months shut gates (quarantines), send nursing monks, flagellants and pilgrims.
//
// Exports: healthState, peopleRec, peekRec, frailOf, virginOf, plagueWeights, plagueToll,
//          noteExposed, originPeople, townInf, townCfr, teachingOf, physicKey, physicOf, feverAt,
//          campMonth, healthParts, sparedWhy, CUSTOMS, TEACH, PHYSIC, BUILD_WORD, system

import { on } from '../../core/hooks.js';
import { chronicle } from '../../core/chronicle.js';
import { registerProvider, mulOf, firstOf, hasProviders } from '../../core/ext.js';
import { liveSettlements, liveCivs, damageSettlement, settlementsNear } from '../../core/entities.js';
import { takePeople, takeOfPeople, isSet, cohortTotal } from '../../core/cohorts.js';
import { addEffect, getEffect } from '../../core/effects.js';
import { makePerson } from '../../core/names.js';
import { DAYS_PER_YEAR as DPY, DAYS_PER_MONTH, BIOME, WATER } from '../../core/constants.js';
import { seasonAt } from '../../core/world.js';
import { hasTech } from '../civ/tech.js';
import { civPeople, folkById, peopleName } from './folk.js';
import { routesOf } from './trade.js';
import { expose, createPlague, plagueRoom } from './disease.js';
import { boostFervor } from './religion.js';
import { hashPick, pickOne, rateOk, civName, capFirst, modsOf } from './common.js';

const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mythic = (world) => fin(world.params && world.params.mythLevel) >= 2;

const H_MAX = 0.4;              // the most hardiness old plagues leave
const H_FADE = 0.985;           // a year: about half gone in fifty years
const H_CITY = 0.12;            // what a great city's crowds harden its peoples toward, year by year
const KNOWN_MAX = 16;
const VIRGIN_NEAR = 0.12, VIRGIN_SPAN = 0.25;   // homelands this far apart (× the map's diagonal) meet as strangers

/**
 * Customs of cleanliness: × how readily a people catches a sickness (inf), + its towns' health (hp).
 * 'fear' is the belief that water opens the body to sickness.
 */
export const CUSTOMS = {
  bath: { inf: 0.85, hp: 0.02, label: 'bathing', desc: 'keep bathhouses and bathe often' },
  rite: { inf: 0.9, hp: 0.01, label: 'ritual washing', desc: 'wash by rite before prayer and meals' },
  wells: { inf: 0.9, hp: 0.015, label: 'wells apart', desc: 'keep their wells apart from the middens' },
  hearth: { inf: 0.92, hp: 0.02, label: 'clean hearths', desc: 'keep clean hearths and boil their water' },
  plain: { inf: 1, hp: 0, label: 'no custom', desc: 'keep no custom of cleanliness' },
  fear: { inf: 1.15, hp: -0.02, label: 'fear of water', desc: 'shun water, holding that it opens the body to sickness' },
};
const RACE_CUSTOM = { elf: 'bath', dwarf: 'wells', halfling: 'hearth', orc: 'fear', lizardfolk: 'bath' };
// a people's first custom by the warmth of its homeland: bathhouses in hot lands, steam-baths in the cold
const HOT = ['bath', 'bath', 'bath', 'rite', 'wells', 'plain', 'plain', 'fear'];
const MILD = ['bath', 'wells', 'wells', 'hearth', 'plain', 'plain', 'plain', 'fear'];
const COLD = ['bath', 'bath', 'wells', 'hearth', 'plain', 'plain', 'plain', 'fear'];

export function healthState(world) {
  const st = (world.sys.health ||= {});
  if (!st.p || typeof st.p !== 'object') st.p = {};
  st.v = fin(st.v);
  return st;
}
const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

function seedCustom(world, key) {
  const r = hasProviders('cleanRule') ? firstOf('cleanRule', world, key) : null;
  if (r && CUSTOMS[r]) return r;
  if (key[0] === 'r' && RACE_CUSTOM[key.slice(2)]) return RACE_CUSTOM[key.slice(2)];
  const P = key[0] === 'f' ? folkById(world, +key.slice(2)) : null;
  const x = clamp(Math.round(fin(P && P.x)), 0, world.W - 1), y = clamp(Math.round(fin(P && P.y)), 0, world.H - 1);
  const t = fin(world.f.temp && world.f.temp[y * world.W + x], 12);
  return hashPick(t > 18 ? HOT : t < 4 ? COLD : MILD, strHash(key), strHash(String(world.params.seed ?? '')), x, y);
}

/** A people's record, made at the first need (a new people takes its parent's custom, mostly, and what its parent knew). */
export function peopleRec(world, key) {
  const H = healthState(world);
  let r = H.p[key];
  if (r) return r;
  const P = key[0] === 'f' ? folkById(world, +key.slice(2)) : null;
  const pk = P && P.from != null ? 'f:' + P.from : null;
  const par = pk ? H.p[pk] : null;
  r = H.p[key] = { h: 0, c: par && hashPick([0, 0, 0, 1], strHash(key)) === 0 ? par.c : seedCustom(world, key), k: par ? par.k.slice() : [] };
  if (pk && !r.k.includes(pk)) r.k.push(pk);
  H.v++;
  return r;
}
/** A people's record if it has one (the interface reads through this: reading never makes one). */
export const peekRec = (world, key) => (world.sys.health && world.sys.health.p ? world.sys.health.p[key] || null : null);

/** How readily people `key` falls ill and dies of it (1 for an ordinary Historical people new to plagues). */
export function frailOf(world, key) {
  const base = hasProviders('frailty') ? mulOf('frailty', world, key) : 1;
  const r = peekRec(world, key);
  return base * (1 - (r ? r.h : 0));
}

/** Where a people began (Historical peoples; a Mythic race has no one homeland). */
function homeOf(world, key) {
  if (!key || key[0] !== 'f') return null;
  const P = folkById(world, +key.slice(2));
  return P ? P : null;
}
/** 0..1: how much a plague of people `op` meets people `key` as virgin soil. */
export function virginOf(world, key, op) {
  if (!op || !key || key === op) return 0;
  const r = peekRec(world, key);
  if (r && r.k.includes(op)) return 0;
  const A = homeOf(world, key), B = homeOf(world, op);
  if (!A || !B) return 0;
  const D = Math.hypot(fin(A.x) - fin(B.x), fin(A.y) - fin(B.y)) / Math.hypot(world.W, world.H);
  return clamp((D - VIRGIN_NEAR) / VIRGIN_SPAN, 0, 1);
}

/** People a learns the sicknesses of people b (and b of a). */
function learn(world, a, b) {
  if (!a || !b || a === b) return;
  const ra = peopleRec(world, a), rb = peopleRec(world, b);
  if (!ra.k.includes(b)) { ra.k.push(b); if (ra.k.length > KNOWN_MAX) ra.k.shift(); }
  if (!rb.k.includes(a)) { rb.k.push(a); if (rb.k.length > KNOWN_MAX) rb.k.shift(); }
}

/** The people whose sickness a plague is: the strangers' at a first meeting, else the town's main people. */
export function originPeople(world, s, civB = null) {
  if (civB) return civPeople(world, civB);
  if (!s) return null;
  if (mythic(world)) return s.race ? 'r:' + s.race : null;
  const m = s.folk;
  let best = null, bs = -1;
  if (m) for (const k in m) if (m[k] > bs) { bs = m[k]; best = k; }
  return best != null ? fkey(best) : civPeople(world, world.civs[s.civId]);
}

/** × how readily sickness spreads in town s for how it lives (its yearly pass). */
export const townInf = (s) => (s.sick && Number.isFinite(s.sick.im) ? s.sick.im : 1);

// ---------------------------------------------------------------------------
// A plague town's peoples

const WK = [], WD = [], WS = [], WI = [];   // scratch for the town being stepped: its peoples, each one's weight of the dead, its share, its id in the mix
let WN = 0;
const FKEY = [], RKEY = {};   // people keys, made once ('f:12', 'r:elf')
const fkey = (id) => FKEY[id] || (FKEY[id] = 'f:' + id);
const rkey = (r) => RKEY[r] || (RKEY[r] = 'r:' + r);
const OUT = { inf: 1, die: 1 };

/** Each people's share of town s: its own table (Mythic), else the mix (Historical). Fills WK / WS; returns the count. */
function sharesOf(world, s) {
  WN = 0;
  if (mythic(world)) {
    const c = s.cohorts;
    if (isSet(c)) {
      const tot = Math.max(1, fin(s.population));
      for (const r in c) { const n = cohortTotal(c[r]); if (n > 0) { WK[WN] = rkey(r); WI[WN] = r; WS[WN] = n / tot; WN++; } }
    } else if (s.race) { WK[0] = rkey(s.race); WI[0] = s.race; WS[0] = 1; WN = 1; }
    return WN;
  }
  const m = s.folk;
  if (m) for (const id in m) { const v = m[id]; if (v > 0) { WK[WN] = fkey(id); WI[WN] = id; WS[WN] = v; WN++; } }
  return WN;
}

/**
 * Plague p in town s: { inf, die }, × the town's infection and × its deaths for the peoples in it
 * (their frailty, customs and whether they have met the sickness); keeps each people's weight of
 * the dead for plagueToll (the same step).
 */
export function plagueWeights(world, s, p) {
  OUT.inf = 1; OUT.die = 1;
  if (!sharesOf(world, s)) return OUT;
  let si = 0, sd = 0, tot = 0;
  // mana-burn (myth/sickness.js) goes after the magic-touched, and no custom keeps it off
  const magic = p.cause === 'mana';
  for (let j = 0; j < WN; j++) {
    const key = WK[j], sh = WS[j];
    const fr = Math.sqrt(frailOf(world, key));
    const v = p.op ? virginOf(world, key, p.op) : 0;
    const r = peekRec(world, key);
    const c = magic ? CUSTOMS.plain : CUSTOMS[r ? r.c : 'plain'] || CUSTOMS.plain;
    const mk = magic ? mulOf('magicFrailty', world, key) : 1;
    const i = fr * c.inf * (1 + 0.4 * v) * mk;
    const d = fr * (1 + 3.5 * v) * Math.sqrt(mk);
    si += sh * i; sd += sh * i * d; tot += sh;
    WD[j] = sh * i * d;
  }
  if (!(tot > 0) || !(si > 0)) { WN = 0; return OUT; }
  OUT.inf = si / tot; OUT.die = sd / si;
  return OUT;
}

/** The plague's dead in town s (a fraction of its people), shared by its peoples as plagueWeights weighed them. Returns the number taken. */
export function plagueToll(world, s, p, frac) {
  const N = s.population;
  if (!(frac > 0) || !(N > 0)) return 0;
  if (!WN) return damageSettlement(world, s, { pop: frac, cause: 'plague' });
  let W = 0;
  for (let j = 0; j < WN; j++) W += WD[j];
  if (!(W > 0)) return damageSettlement(world, s, { pop: frac, cause: 'plague' });
  const by = (p.byP ||= {});
  let dead;
  if (mythic(world) && isSet(s.cohorts)) {
    const n = N * clamp(frac * (hasProviders('damage') ? mulOf('damage', world, s, 'plague') : 1), 0, 1);
    dead = 0;
    for (let j = 0; j < WN; j++) {
      const key = WK[j];
      const got = takeOfPeople(world, s, WI[j], n * WD[j] / W, 'frail');
      dead += got;
      const b = (by[key] ||= [0, 0]);
      b[0] += got;
    }
    if (n - dead > 0.01) dead += takePeople(world, s, n - dead, 'frail');
    damageSettlement(world, s, { pop: 0, cause: 'plague' });   // its tier, and the end of a town too small to stand
  } else {
    dead = damageSettlement(world, s, { pop: frac, cause: 'plague' });
    const m = s.folk;
    if (m && dead > 0 && s.alive) shiftMix(m, N, dead, W, by);
  }
  return dead;
}

/**
 * A Historical town's mix after `dead` of its N people died, shared by WD (total W); the shares
 * stay summing to 1 (a people fallen below the floor is folded in at the peoples' yearly pass).
 */
function shiftMix(m, N, dead, W, by) {
  const left = Math.max(1, N - dead);
  let sum = 0;
  for (let j = 0; j < WN; j++) {
    const d = dead * WD[j] / W;
    if (by) { const b = (by[WK[j]] ||= [0, 0]); b[0] += d; }
    const v = Math.max(0, (WS[j] * N - d) / left);
    WS[j] = v; sum += v;
  }
  if (sum > 0) for (let j = 0; j < WN; j++) m[WI[j]] = Math.round(WS[j] / sum * 1e4) / 1e4;
}

/** n of town s's people die of a sickness, shared by its peoples as WD weighs them (Mythic: their own tables). Returns the number taken. */
function takeShared(world, s, n, profile, cause) {
  const N = s.population;
  if (!(n > 0) || !(N > 0)) return 0;
  let W = 0;
  for (let j = 0; j < WN; j++) W += WD[j];
  if (!(W > 0)) return damageSettlement(world, s, { pop: n / N, cause });
  if (mythic(world) && isSet(s.cohorts)) {
    let dead = 0;
    for (let j = 0; j < WN; j++) dead += takeOfPeople(world, s, WI[j], n * WD[j] / W, profile);
    if (n - dead > 0.01) dead += takePeople(world, s, n - dead, profile);
    damageSettlement(world, s, { pop: 0, cause });
    return dead;
  }
  const dead = damageSettlement(world, s, { pop: n / N, cause });
  if (s.folk && dead > 0 && s.alive) shiftMix(s.folk, N, dead, W, null);
  return dead;
}

/** A new outbreak in town s: its peoples are counted as exposed to plague p. */
export function noteExposed(world, s, p) {
  if (p.qs && p.qs.includes(s.id)) { const qx = (p.qx ||= []); if (!qx.includes(s.id)) qx.push(s.id); }
  if (!sharesOf(world, s)) return;
  const by = (p.byP ||= {});
  const N = fin(s.population);
  for (let j = 0; j < WN; j++) { const b = (by[WK[j]] ||= [0, 0]); b[1] += WS[j] * N; }
}

// When a plague ends its survivors are hardier and know its people's sickness; a people that
// bathed and lost many may shut its bathhouses.
on('plagueEnded', (world, p) => {
  const by = p && p.byP;
  if (!by) return;
  const keys = Object.keys(by).sort();
  for (const key of keys) {
    const [dead, exp] = by[key];
    if (!(exp >= 50)) continue;
    const f = clamp(dead / exp, 0, 1);
    const r = peopleRec(world, key);
    r.h = Math.min(H_MAX, r.h + 0.8 * f);
    if (p.op && p.op !== key && f > 0) learn(world, key, p.op);
    if (r.c === 'bath' && p.notable && f >= 0.05 && world.rng.chance(0.35)) shutBaths(world, key, r, p, f);
  }
  // keep the six peoples with the most dead (the plague's account)
  if (keys.length > 6) {
    const keep = keys.slice().sort((a, b) => by[b][0] - by[a][0]).slice(0, 6);
    const o = {};
    for (const k of keep) o[k] = by[k].map((v) => Math.round(v));
    p.byP = o;
  } else for (const k of keys) by[k] = by[k].map((v) => Math.round(v));
});

function shutBaths(world, key, r, p, f) {
  r.c = f >= 0.15 ? 'fear' : 'plain';
  r.sh = world.time.day;
  const name = peopleName(world, key);
  const s = world.settlements[p.originSid];
  chronicle(world, {
    cat: 'disease', imp: 2, icon: 'plague', key: 'health.baths', ref: { k: 'folk', id: key }, tags: ['people'],
    ...(p.seq != null ? { cause: p.seq } : {}), ...(s ? { x: s.x, y: s.y } : {}),
    text: pickOne(world, [
      `In fear of ${p.name}, ${name} shut their bathhouses, holding that warm water opened the body to the sickness.`,
      `After ${p.name} ${name} pulled down their bathhouses as houses of contagion${r.c === 'fear' ? ', and learned to fear water itself' : ''}.`,
    ]).replace(/^./, (c) => c.toUpperCase()),
  });
}

// ---------------------------------------------------------------------------
// Fever country, housing

/** The fever of the ground around tile (x, y), 0..1: marsh and hot wet forest, by the heat. */
export function feverAt(world, x, y) {
  const f = world.f, W = world.W, H = world.H;
  const cx = clamp(Math.round(x), 0, W - 1), cy = clamp(Math.round(y), 0, H - 1);
  let v = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = cx + dx, yy = cy + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    const j = yy * W + xx;
    if (f.water[j] !== WATER.LAND) continue;
    const b = f.biome[j];
    if (b === BIOME.WETLAND) v += 1; else if (b === BIOME.TROPICAL_FOREST || b === BIOME.RAINFOREST) v += 0.15;
  }
  const heat = clamp((fin(f.temp[cy * W + cx], 10) - 8) / 14, 0.1, 1);
  return clamp(v / 9 * 1.2 * heat, 0, 1);
}
/** × how hard fever ground is on a people (ext feverRule: lizardfolk bear it, elves half). */
const bearOf = (world, key) => (key && hasProviders('feverRule') ? mulOf('feverRule', world, key) : 1);

/** A town's first material, by its land and people: timber in the woods, mud brick on the plains and in the dry lands, stone in the hills. */
function buildOf(world, s, civ) {
  const x = hasProviders('buildRule') ? firstOf('buildRule', world, s, civ) : null;
  if (x === 't' || x === 'm' || x === 's') return x;
  const f = world.f, b = f.biome[s.i];
  if (fin(f.elevation[s.i]) >= 0.62) return 's';
  if (b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT || b === BIOME.SHRUBLAND || b === BIOME.SAVANNA || b === BIOME.STEPPE) return 'm';
  return 't';
}
const FIRE = { t: 1.2, m: 0.8, s: 0.55 };
export const BUILD_WORD = { t: 'timber', m: 'mud brick', s: 'stone' };

/** Fever and housing for town s's year: updates sk (slums, material, fever, seasoning); returns { im, ht } terms. */
function groundYear(world, s, civ, sk, P, n) {
  // slums follow crowding in a great town (its people against its housing, which a town keeps
  // below about 0.8 by sending its young away), and clear slowly (sewers clear them faster)
  const N = fin(s.population);
  const ratio = N / Math.max(1, fin(s.housing, N));
  const want = N > 3000 ? clamp((ratio - 0.7) * 5, 0, 0.6) * clamp(Math.log10(N / 3000) / 1.5, 0, 1) : 0;
  const sl = fin(sk.sl);
  sk.sl = Math.round((sl + (want - sl) * (want > sl ? 0.3 : 0.08 * (s.buildings && s.buildings.sewers ? 2.5 : 1))) * 1e4) / 1e4;
  // what it is built of: stone in the great cities of a later age, and after a great fire
  if (!sk.b) sk.b = buildOf(world, s, civ);
  if (sk.b !== 's' && ((s.traits && s.traits.includes('rebuilt in stone')) || ((s.tier || 0) >= 4 && fin(civ && civ.tech && civ.tech.era) >= 3 && world.rng.chance(0.02)))) sk.b = 's';
  sk.fr = FIRE[sk.b] || 1;
  // fever ground: read again every century and when its marshes are drained
  if (sk.fv == null || (world.time.day - fin(s.foundedDay)) % (100 * DPY) < DPY) {
    sk.fv = Math.round(feverAt(world, s.x, s.y) * (sk.dd ? 0.25 : 1) * 1e3) / 1e3;
    if (sk.sn == null) {
      // a people born on fever ground arrives seasoned to it
      const own = originPeople(world, s);
      const home = homeOf(world, own);
      sk.sn = home && feverAt(world, home.x, home.y) >= 0.25 ? 0.8 : 0;
    }
  }
  sk.sn = Math.round(Math.min(1, fin(sk.sn) + (1 - fin(sk.sn)) / 15) * 1e3) / 1e3;
  if (sk.dr != null && !sk.dd && world.time.day >= sk.dr) drained(world, s, sk);
  let ht = -0.05 * sk.sl, im = (1 + 0.3 * sk.sl) * (sk.b === 't' ? 1.03 : 1);
  if (sk.fv > 0.02) {
    let harm = 0;
    for (let j = 0; j < n; j++) { const b = bearOf(world, WK[j]); WD[j] = WS[j] * b; harm += WD[j]; }
    harm *= (0.05 + 0.95 * (1 - sk.sn)) * P.fever;
    ht -= 0.04 * sk.fv * harm + 0.005 * sk.fv;
    const dead = fin(s.population) * sk.fv * harm * 0.005;
    if (dead >= 1) { WN = n; takeShared(world, s, dead, 'all', 'fever'); }
  }
  return { im, ht };
}

/** The marshes around town s are drained: the fever falls to a quarter, and fields take its place. */
function drained(world, s, sk) {
  sk.dd = 1;
  sk.fv = Math.round(fin(sk.fv) * 0.25 * 1e3) / 1e3;
  addEffect(world, { kind: 'settlement', id: s.id }, { k: 'drained', until: -1, m: { foodYield: 1.1 }, label: 'Drained marshes' });
  chronicle(world, {
    cat: 'disease', imp: 2, icon: 'cure', key: 'health.drained', civId: s.civId, sid: s.id, x: s.x, y: s.y, tags: ['work'],
    text: pickOne(world, [
      `The marshes around ${s.name} were drained at last; where the fever had bred, there were fields.`,
      `After years of dykes and ditches the fens of ${s.name} ran dry, and the ague that had haunted the town went with them.`,
    ]),
  });
}

/** A realm of the newer theories, with the craft and the coin, may drain its worst fever ground. */
function drainYear(world, civ) {
  if (!physicOf(world, civ).drain || !hasTech(civ, 'engineering')) return;
  let best = null, bv = 0;
  for (const id of civ.settlementIds || []) {
    const s = world.settlements[id];
    const sk = s && s.alive && s.sick;
    if (!sk || sk.dr != null || (s.tier || 0) < 2 || !(sk.fv >= 0.3)) continue;
    const v = sk.fv * fin(s.population);
    if (v > bv) { bv = v; best = s; }
  }
  if (!best) return;
  const cost = 6 * Math.max(1, fin(civ.income));
  if (!(fin(civ.treasury) > 1.5 * cost) || !world.rng.chance(0.05)) return;
  civ.treasury -= cost;
  best.sick.dr = world.time.day + 8 * DPY;
}

// ---------------------------------------------------------------------------
// Camp fever

const CAMP = { dead: 0, fled: 0 };
/**
 * Camp fever, once a month for an army in the field (war.js monthly): { dead, fled } this month
 * (the fled walk home). It comes with months in the field (little in a season's war), a siege's
 * lines, the size of the host, hunger, summer and fever ground, less with the army's people's
 * custom and its physicians; it runs a few months, and a great host may carry it home as a plague.
 */
export function campMonth(world, army) {
  CAMP.dead = 0; CAMP.fled = 0;
  const fl = army.flags;
  const civ = world.civs[army.civId];
  if (!fl) return CAMP;
  if (!civ || army.naval || !(army.strength >= 50)) { if (fl.cf) delete fl.cf; return CAMP; }
  const P = physicOf(world, civ);
  const cf = fl.cf;
  if (cf) {
    const loss = army.strength * 0.09 * fin(cf.k, 1) * P.cfr * clamp(fin(modsOf(world, civ).medicine, 1), 0.2, 1.5);
    CAMP.dead = loss * 0.8; CAMP.fled = loss * 0.2;
    cf.n = Math.round(fin(cf.n) + loss);
    army.morale = clamp(fin(army.morale, 1) - 0.02, 0.05, 1.2);
    if (world.rng.chance(0.28)) { delete fl.cf; if (cf.n >= 1000 && army.strength >= 2500 && !fl.cfh) carryHome(world, army, civ, cf); }
    return CAMP;
  }
  // months in the field: the host's own, or most of its war's (a long war's camps stay foul)
  const war = army.warId != null ? world.wars[army.warId] : null;
  if (!war || !war.active) return CAMP;
  const months = Math.max(world.time.day - fin(army.createdDay, world.time.day), 0.7 * (world.time.day - fin(war.startDay, world.time.day))) / DAYS_PER_MONTH;
  if (months < 2) return CAMP;
  const key = civPeople(world, civ);
  const r = key ? peekRec(world, key) : null;
  const fv = feverAt(world, army.x, army.y) * bearOf(world, key) * P.fever;
  const pr = 0.035 * clamp(months / 10, 0.1, 3) * clamp(Math.pow(army.strength / 2000, 0.35), 0.5, 2)
    * (army.state === 'sieging' ? 2 : 1) * (fin(army.supply, 1) < 0.5 ? 1.5 : 1) * (seasonAt(world, army.y) === 2 ? 1.3 : 1)
    * (1 + 2 * fv) * (CUSTOMS[r ? r.c : 'plain'] || CUSTOMS.plain).inf * P.inf
    * (hasProviders('campRule') ? mulOf('campRule', world, army, civ) : 1);
  if (!world.rng.chance(pr)) return CAMP;
  fl.cf = { d: world.time.day, k: Math.round((0.6 + 0.8 * world.rng.next()) * 100) / 100, n: 0 };
  const s = army.state === 'sieging' && army.targetId != null ? world.settlements[army.targetId] : null;
  // told for a great host, once a war, and seldom in the world
  if (army.strength >= 5000 && rateOk(world, `camp${army.warId}:${civ.id}`, 60 * DPY) && rateOk(world, 'campTold', 3 * DPY)) chronicle(world, {
    cat: 'war', imp: 2, icon: 'plague', key: 'health.camp', civId: civ.id, x: army.x, y: army.y, ...(s ? { sid: s.id } : {}), tags: ['army'],
    text: pickOne(world, [
      `Camp fever broke out in ${army.name || 'the host of ' + civName(civ)}${s ? ` before ${s.name}` : ''}; the flux went through the lines.`,
      `${capFirst(army.name || 'the host of ' + civName(civ))} began to sicken in its camps${s ? ` around ${s.name}` : ''}, and the dead were buried by the hundred.`,
    ]),
  });
  return CAMP;
}

/** A great host's fever, carried home: a named plague in its home town. */
function carryHome(world, army, civ, cf) {
  // rarely: a great host's fever, in a world with room for a new pestilence
  if (!(world.params.plagueRate > 0) || !world.rng.chance(0.04 * Math.min(1, plagueRoom(world))) || !rateOk(world, 'campPlague', 100 * DPY)) return;
  const home = world.settlements[army.homeId];
  const s = home && home.alive && home.civId === civ.id ? home : null;
  if (!s || s.disease) return;
  army.flags.cfh = 1;
  createPlague(world, s, 'camp', { lethalityMul: 0.75 });
}

// ---------------------------------------------------------------------------
// The yearly passes

/** A town's year: what its peoples' customs add to its health; its peoples learn each other's sicknesses, and its trading partners'. */
function townYear(world, s) {
  const n = sharesOf(world, s);
  let ht = 0;
  for (let j = 0; j < n; j++) {
    const r = peopleRec(world, WK[j]);
    ht += WS[j] * (CUSTOMS[r.c] || CUSTOMS.plain).hp;
  }
  // peoples of one town learn each other's sicknesses; a great city's crowds harden its peoples
  const city = (s.tier || 0) >= 4;
  for (let a = 0; a < n; a++) {
    const sa = WS[a];
    if (city) { const r = peopleRec(world, WK[a]); if (r.h < H_CITY) r.h += (H_CITY - r.h) * 0.05 * sa; }
    if (sa < 0.02) continue;
    for (let b = a + 1; b < n; b++) if (WS[b] >= 0.02) learn(world, WK[a], WK[b]);
  }
  // and its trading partners' realms
  const civ0 = world.civs[s.civId];
  const own = civ0 ? civPeople(world, civ0) : null;
  if (own) for (const r of routesOf(world, s.id)) {
    const t = world.settlements[r.aId === s.id ? r.bId : r.aId];
    const tc = t && t.alive ? world.civs[t.civId] : null;
    if (tc && tc !== civ0) learn(world, own, civPeople(world, tc));
  }
  // how the town lives: its faith's rites, its physicians, the crowds at a holy city, its slums,
  // what it is built of, its fever ground
  const civ = world.civs[s.civId];
  const P = physicOf(world, civ);
  let im = P.inf * (teachingOf(world, s.dominantReligion) === 'purity' ? 0.9 : 1);
  if (s.dominantReligion != null && world.religions[s.dominantReligion]?.holyCityId === s.id) im *= 1.1;
  ht += P.ht;
  const sk = s.sick && typeof s.sick === 'object' ? s.sick : (s.sick = {});
  const g = groundYear(world, s, civ, sk, P, n);
  if (!s.alive) return;
  sk.im = Math.round(im * g.im * 1e4) / 1e4;
  sk.ht = Math.round((ht + g.ht) * 1e4) / 1e4;
}

/** The world's year: hardiness fades (the great cities harden their peoples on their own passes); a vanished people is forgotten. */
function worldYear(world) {
  const H = healthState(world);
  for (const key of Object.keys(H.p)) {
    const r = H.p[key];
    r.h = Math.round(r.h * H_FADE * 1e4) / 1e4;
    // (its kin keep its name in what they know until it falls off)
    if (key[0] === 'f') { const P = folkById(world, +key.slice(2)); if (!P || P.gone != null) delete H.p[key]; }
  }
}

// ---------------------------------------------------------------------------
// Faiths: what each teaches about sickness

/**
 * heal: hospitals and nursing orders (a healing faith: deaths × 0.8; a monastic one × 0.9), and
 * monks who come to nurse a stricken town; purity: rites of washing and fasting (× 0.9 infection);
 * penance: sickness as punishment (processions of flagellants carry it from town to town); fate: none.
 */
export const TEACH = {
  heal: { label: 'tends the sick' }, purity: { label: 'rites of purity' }, penance: { label: 'sickness as punishment' }, fate: { label: 'no teaching on sickness' },
};
export function teachingOf(world, rid) {
  const r = rid != null ? world.religions[rid] : null;
  if (!r || r.alive === false) return 'fate';
  const x = hasProviders('faithHealing') ? firstOf('faithHealing', world, r) : null;
  if (x && TEACH[x]) return x;
  const t = Array.isArray(r.tenets) ? r.tenets : [];
  if (t.includes('healing') || t.includes('monastic')) return 'heal';
  if (t.includes('apocalyptic')) return 'penance';
  if (t.includes('ascetic')) return 'purity';
  return 'fate';
}
const faithCfr = (world, rid) => {
  const r = rid != null ? world.religions[rid] : null;
  if (!r || r.alive === false || !Array.isArray(r.tenets)) return 1;
  return r.tenets.includes('healing') ? 0.8 : r.tenets.includes('monastic') ? 0.9 : 1;
};

// ---------------------------------------------------------------------------
// Physicians and their theories

/**
 * A realm's theory of sickness. rank: the ladder (a realm climbs by its techs: medicine → the
 * humours, anatomy → bad air or contagion, vaccination → germs); inf / cfr: × infection and deaths
 * in its towns; ht: + health; q: how readily it shuts a town's gates against a plague; ill: × the
 * death hazard of a ruler in a lasting illness (the humours bleed them); fever: × fever ground's
 * harm; drain: it may drain a marsh. The Mythic lores are where each people starts.
 */
export const PHYSIC = {
  spirits: { rank: 0, label: 'spirits', inf: 1, cfr: 1, ht: 0, q: 0.1, ill: 1, fever: 1, held: 'sickness is the work of spirits, to be driven out with charms and smoke' },
  humours: { rank: 1, label: 'the humours', inf: 1, cfr: 1.04, ht: 0.01, q: 0.15, ill: 1.25, fever: 1, held: 'sickness is an imbalance of the four humours, mended by rest, diet and the lancet' },
  air: { rank: 2, label: 'bad air', inf: 0.93, cfr: 0.98, ht: 0.015, q: 0.5, ill: 1.1, fever: 0.8, drain: true, gate: 'the sickness rode the foul air out of the stricken towns', held: 'sickness rides the foul air of marsh and midden, and clean streets keep it off' },
  contagion: { rank: 2, label: 'contagion', inf: 0.94, cfr: 0.98, ht: 0.01, q: 1, ill: 1.1, fever: 1, drain: true, gate: 'the sickness passed from the sick to the well', held: 'sickness passes from the sick to the well, and the sick must be kept apart' },
  germs: { rank: 3, label: 'germs', inf: 0.85, cfr: 0.85, ht: 0.02, q: 1, ill: 0.7, fever: 0.6, drain: true, gate: 'the sickness was carried by living seeds', held: 'sickness is carried by living seeds too small to see' },
  herbs: { rank: 1, label: 'herb-lore', inf: 1, cfr: 0.92, ht: 0.01, q: 0.15, ill: 0.85, fever: 0.9, lore: 'elf', held: 'every sickness has its herb, if one knows the woods' },
  stone: { rank: 1, label: 'stone-physic', inf: 0.95, cfr: 1, ht: 0.005, q: 0.8, ill: 1, fever: 1, lore: 'dwarf', gate: 'the sick must be walled apart from the well', held: 'sickness rises from foul water, and the sick must be walled apart' },
  hearth: { rank: 1, label: 'hearth-remedies', inf: 1, cfr: 0.94, ht: 0.01, q: 0.2, ill: 0.9, fever: 1, lore: 'halfling', held: 'the sick are mended by broth, warmth and patient nursing' },
  shaman: { rank: 0, label: 'spirit-shamans', inf: 1, cfr: 1, ht: 0, q: 0.05, ill: 1, fever: 1, lore: 'orc', held: 'sickness is a spirit to be fought with drums and blood' },
  swamp: { rank: 1, label: 'swamp-physic', inf: 1, cfr: 0.95, ht: 0.005, q: 0.1, ill: 0.9, fever: 0.6, lore: 'lizardfolk', held: 'fevers are cured by the bitter barks and muds of the fen' },
};
const LORE = { elf: 'herbs', dwarf: 'stone', halfling: 'hearth', orc: 'shaman', lizardfolk: 'swamp' };

/** A realm's theory (read: its own, its parent's, or where its people starts; never written here). */
export function physicKey(world, civ) {
  if (!civ) return 'spirits';
  if (civ.physic && PHYSIC[civ.physic]) return civ.physic;
  const par = civ.parentId != null ? world.civs[civ.parentId] : null;
  if (par && par !== civ && par.physic && PHYSIC[par.physic]) return par.physic;
  const x = hasProviders('physicRule') ? firstOf('physicRule', world, civ) : null;
  if (x && PHYSIC[x]) return x;
  return (mythic(world) && LORE[civ.race]) || 'spirits';
}
export const physicOf = (world, civ) => PHYSIC[physicKey(world, civ)];

/** × deaths in town s for its faith and its realm's physicians (disease.js cfrFor). */
export function townCfr(world, s, civ) {
  return faithCfr(world, s.dominantReligion) * physicOf(world, civ).cfr * (s.disease && s.disease.nu != null ? 0.85 : 1);
}

const physician = (world, civ) => makePerson(civ.language || world.lang, world.rng);
const capitalName = (world, civ) => { const c = civ.capitalId != null ? world.settlements[civ.capitalId] : null; return c && c.alive ? c.name : null; };

/** The theory a realm takes when it learns anatomy: what its strongest neighbour holds, else its own school. */
function rivalPick(world, civ) {
  let best = null, bp = -1;
  for (const k in civ.relations || {}) {
    if (!(civ.relations[k] && civ.relations[k].border > 0)) continue;
    const o = world.civs[k];
    if (!o || !o.alive) continue;
    const ok = physicKey(world, o);
    if ((ok === 'air' || ok === 'contagion') && (o.population || 0) > bp) { bp = o.population || 0; best = ok; }
  }
  return best || hashPick(['air', 'air', 'air', 'contagion', 'contagion'], civ.id, strHash(String(world.params.seed ?? '')));
}

function adopt(world, civ, key, was) {
  civ.physic = key;
  if (was == null) return;
  const P = PHYSIC[key];
  const cap = capitalName(world, civ);
  const who = physician(world, civ);
  chronicle(world, {
    cat: 'disease', imp: key === 'germs' ? 2 : 1, icon: 'cure', key: 'health.theory', civId: civ.id, tags: ['physic', key],
    ...(civ.capitalId != null ? { sid: civ.capitalId } : {}),
    text: pickOne(world, [
      `${who}, a physician of ${cap || civName(civ)}, taught that ${P.held}; in time the physicians of ${civName(civ)} held with the teaching.`,
      `The physicians of ${civName(civ)} came to hold that ${P.held}${was ? `, and put aside the old teaching of ${PHYSIC[was].label}` : ''}.`,
    ]),
  });
}

/** A realm's year: its physicians' theory, and a reformer or a faith that changes its people's custom. */
function realmYear(world, civ) {
  const had = civ.physic && PHYSIC[civ.physic] ? civ.physic : null;
  const cur = physicKey(world, civ);
  if (!had) civ.physic = cur;
  const P = PHYSIC[cur];
  let nu = null;
  if (hasTech(civ, 'vaccines')) { if (cur !== 'germs') nu = 'germs'; }
  else if (hasTech(civ, 'anatomy') && P.rank < 2) nu = rivalPick(world, civ);
  else if (hasTech(civ, 'medicine') && P.rank < 1) nu = 'humours';
  else if (P.rank === 2 && world.rng.chance(0.03)) {
    // a rival school, from a stronger neighbour
    for (const k in civ.relations || {}) {
      const o = world.civs[k];
      if (!o || !o.alive || !(civ.relations[k] && civ.relations[k].border > 0)) continue;
      const ok = physicKey(world, o);
      if (PHYSIC[ok].rank === 2 && ok !== cur && (o.population || 0) > 1.5 * (civ.population || 0)) { nu = ok; break; }
    }
  }
  if (nu && nu !== cur) adopt(world, civ, nu, had ? cur : null);
  drainYear(world, civ);
  // customs: a reformer of the newer theories cleans a city; a faith of purity brings its rites
  const key = civPeople(world, civ);
  if (!key) return;
  const r = peopleRec(world, key);
  if (r.c !== 'fear' && r.c !== 'plain') return;
  const cap = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
  if (PHYSIC[civ.physic].rank >= 2 && cap && cap.alive && (cap.tier || 0) >= 3 && world.rng.chance(0.012)) {
    const was = r.c;
    r.c = r.sh != null ? 'bath' : 'wells';
    const who = physician(world, civ);
    chronicle(world, {
      cat: 'disease', imp: 2, icon: 'cure', key: 'health.reform', civId: civ.id, sid: cap.id, x: cap.x, y: cap.y, ref: { k: 'folk', id: key }, tags: ['people'],
      text: r.c === 'bath'
        ? `${who} of ${cap.name} persuaded ${peopleName(world, key)} to open their bathhouses again, ${was === 'fear' ? 'after generations of fearing water' : 'long shut in fear of plague'}.`
        : `The reformer ${who} cleaned ${cap.name}: the middens were carted off and the wells walled apart from them, and ${peopleName(world, key)} took up the custom.`,
    });
  } else if (teachingOf(world, civ.stateReligion) === 'purity' && world.rng.chance(0.02)) {
    r.c = 'rite';
    const f = world.religions[civ.stateReligion];
    chronicle(world, {
      cat: 'religion', imp: 1, icon: 'cure', key: 'health.rite', civId: civ.id, ref: { k: 'folk', id: key }, tags: ['people'],
      text: `${capFirst(peopleName(world, key))} took up the washings of ${f && f.name ? f.name : 'their faith'}, before prayer and before every meal.`,
    });
  }
}

// ---------------------------------------------------------------------------
// The month in a plague: quarantines, nursing monks, flagellants, pilgrims

const QUAR_DAYS = 180;
function monthly(world) {
  let any = false;
  for (const p of world.plagues) if (p && p.active) { any = true; break; }
  if (!any) return;
  const holy = new Map();
  for (const r of world.religions) if (r && r.alive !== false && r.holyCityId != null) holy.set(r.holyCityId, r);
  const day = world.time.day;
  for (const s of liveSettlements(world).slice()) {
    const d = s.disease;
    if (!d || !(d.I * s.population > 5)) continue;
    const p = world.plagues[d.pid];
    if (!p || !p.active) continue;
    const near = settlementsNear(world, s.x, s.y, 10);
    // gates shut against it, by the theory of each neighbour's physicians (none knows mana-burn)
    for (const n of near) {
      if (p.cause === 'mana') break;
      if (n === s || n.disease || (n.tier || 0) < 2) continue;
      const civ = world.civs[n.civId];
      if (!civ || Math.hypot(n.x - s.x, n.y - s.y) > 8) continue;
      const q = physicOf(world, civ).q;
      if (!(q > 0) || getEffect(world, { kind: 'settlement', id: n.id }, 'quarantine') || !world.rng.chance(0.2 * q)) continue;
      addEffect(world, { kind: 'settlement', id: n.id }, { k: 'quarantine', until: day + QUAR_DAYS, m: { plagueDose: 0.35, trade: 0.75, happiness: -0.03 }, label: 'Quarantine' });
      const qs = (p.qs ||= []);
      if (qs.length < 30 && !qs.includes(n.id)) qs.push(n.id);
      // told once or twice a plague, where a theory explains it
      const P = physicOf(world, civ);
      if (p.notable && P.gate && (n.tier || 0) >= 3 && rateOk(world, `quar${p.id}`, 4 * DPY)) chronicle(world, {
        cat: 'disease', imp: 2, icon: 'plague', key: 'health.quarantine', civId: civ.id, sid: n.id, x: n.x, y: n.y, ref: { k: 'plague', id: p.id }, ...(p.seq != null ? { cause: p.seq } : {}),
        text: `${n.name} shut its gates against ${p.name} and turned away every traveller from ${s.name}; its physicians held that ${P.gate}.`,
      });
    }
    // monks of a faith that tends the sick come to nurse a town of another faith
    if (d.nu == null && p.notable) {
      for (const n of near) {
        const rid = n.dominantReligion;
        if (n === s || rid == null || rid === s.dominantReligion || n.disease || teachingOf(world, rid) !== 'heal') continue;
        if (!world.rng.chance(0.06)) break;
        d.nu = rid;
        convert(s, rid, 0.06);
        boostFervor(world, rid, 0.02);
        const f = world.religions[rid];
        if (rateOk(world, `nurse${rid}:${p.id}`, 5 * DPY)) chronicle(world, {
          cat: 'religion', imp: 2, icon: 'cure', key: 'health.nurse', civId: s.civId, sid: s.id, x: s.x, y: s.y, ref: { k: 'plague', id: p.id }, ...(p.seq != null ? { cause: p.seq } : {}),
          text: pickOne(world, [
            `Monks of ${f.name} came from ${n.name} to nurse the sick of ${s.name} through ${p.name}; many there turned to their faith.`,
            `While ${p.name} raged in ${s.name}, the nursing brothers of ${f.name} tended its sick, and the town did not forget it.`,
          ]),
        });
        break;
      }
    }
    // flagellants of a faith of penance walk from town to town, and the sickness with them
    if (p.notable && d.I >= 0.01 && teachingOf(world, s.dominantReligion) === 'penance' && world.rng.chance(0.1)) {
      const to = settlementsNear(world, s.x, s.y, 14).filter((n) => n !== s && !n.disease && n.dominantReligion === s.dominantReligion).slice(0, 3);
      for (const n of to) expose(world, n, p.id, { kind: 'near', fromSid: s.id });
      if (to.length && rateOk(world, `flag${p.id}`, 3 * DPY)) {
        const f = world.religions[s.dominantReligion];
        chronicle(world, {
          cat: 'religion', imp: 2, icon: 'plague', key: 'health.flagellants', civId: s.civId, sid: s.id, x: s.x, y: s.y, ref: { k: 'plague', id: p.id }, ...(p.seq != null ? { cause: p.seq } : {}),
          text: `Holding ${p.name} a punishment for their sins, the faithful of ${f ? f.name : 'the old gods'} went in procession from ${s.name}, scourging themselves, and carried it to ${to[0].name}${to.length > 1 ? ' and beyond' : ''}.`,
        });
      }
    }
    // a holy city's pilgrims carry it home to the faith's far towns
    const r = holy.get(s.id);
    if (r && d.I * s.population > 10 && world.rng.chance(0.15)) {
      const far = [];
      for (const t of liveSettlements(world)) if (t !== s && !t.disease && t.dominantReligion === r.id && Math.hypot(t.x - s.x, t.y - s.y) > 12) far.push(t);
      if (far.length) {
        const t = far[Math.floor(world.rng.next() * far.length)];
        expose(world, t, p.id, { kind: 'near', fromSid: s.id });
        if (rateOk(world, `pilg${p.id}`, 4 * DPY)) chronicle(world, {
          cat: 'religion', imp: 2, icon: 'plague', key: 'health.pilgrims', civId: t.civId, sid: t.id, x: t.x, y: t.y, ref: { k: 'plague', id: p.id }, ...(p.seq != null ? { cause: p.seq } : {}),
          text: `Pilgrims home from ${s.name}, the holy city of ${r.name}, brought ${p.name} back with them to ${t.name}.`,
        });
      }
    }
  }
}

/** Raise faith rid's share of town s by g (the others give way). */
function convert(s, rid, g) {
  const sh = (s.religion ||= {});
  sh[rid] = fin(sh[rid]) + g;
  let tot = 0;
  for (const k in sh) tot += sh[k];
  if (tot > 1) for (const k in sh) if (+k !== rid) sh[k] *= Math.max(0, 1 - sh[rid]) / Math.max(1e-9, tot - sh[rid]);
}

// A town behind closed gates that the plague never reached: its physicians are remembered.
on('plagueEnded', (world, p) => {
  if (!p || !p.notable || !Array.isArray(p.qs)) return;
  const hit = new Set(p.qx || []);
  for (const sid of p.qs) {
    const s = world.settlements[sid];
    if (!s || !s.alive || hit.has(sid) || (s.tier || 0) < 4) continue;
    const civ = world.civs[s.civId];
    if (!civ || !physicOf(world, civ).gate) continue;
    const who = physician(world, civ);
    chronicle(world, {
      cat: 'disease', imp: 2, icon: 'cure', key: 'health.spared', civId: civ.id, sid: s.id, x: s.x, y: s.y, ref: { k: 'plague', id: p.id }, ...(p.seq != null ? { cause: p.seq } : {}),
      text: `Behind its shut gates ${s.name} was spared ${p.name}; its people credited the physician ${who}, who had held that ${physicOf(world, civ).held}.`,
    });
    break;
  }
});

// a conqueror's settlers and soldiers are newcomers to fever ground
on('settlementTransferred', (world, s) => { if (s && s.sick && s.sick.fv > 0.1) s.sick.sn = Math.round(fin(s.sick.sn) * 0.85 * 1e3) / 1e3; });

// ---------------------------------------------------------------------------
// For the interface (pure reads)

/** Why town s is healthy or sick: [{ k, v }], the parts of its health (as civ/settlement.js weighs them), largest first. */
export function healthParts(world, s) {
  const civ = world.civs[s.civId];
  const m = modsOf(world, civ);
  const b = s.buildings || {};
  const aq = fin(b.aqueduct) > 0 ? 1 : 0, sew = fin(b.sewers) > 0 ? 1 : 0, hosp = fin(b.hospital);
  const san = clamp(0.3 * aq + 0.4 * sew + 0.12 * hosp + (fin(m.sanitation, 1) - 1) * 0.6, 0, 1);
  const pop = fin(s.population);
  const out = [];
  const add = (k, v) => { if (Math.abs(v) >= 0.004) out.push({ k, v }); };
  add('Its realm\u2019s medicine', 0.8 * fin(m.health, 1) - 0.8);
  add('Crowding', -0.07 * Math.log10(Math.max(1, pop / 600)) * (1 - san));
  add('Aqueducts and hospitals', 0.02 * aq + 0.03 * hosp);
  if (s.famine > 0) add('Famine', -0.04 * Math.min(6, s.famine));
  if (s.disease) add('The plague', -0.6 * clamp(fin(s.disease.I), 0, 1));
  add('Foul air', -0.25 * fin(world.f.pollution && world.f.pollution[s.i]));
  add('War damage', -0.15 * fin(world.f.devastation && world.f.devastation[s.i]));
  const n = sharesOf(world, s);
  for (let j = 0; j < n; j++) {
    const r = peekRec(world, WK[j]);
    const c = CUSTOMS[r ? r.c : 'plain'] || CUSTOMS.plain;
    if (c.hp) add(`${capFirst(peopleName(world, WK[j], false))}: ${c.label}`, WS[j] * c.hp);
  }
  const P = physicOf(world, civ);
  add(`Physicians: ${P.label}`, P.ht);
  const sk = s.sick || {};
  add('Slums', -0.05 * fin(sk.sl));
  if (fin(sk.fv) > 0.02) {
    let harm = 0;
    for (let j = 0; j < n; j++) harm += WS[j] * bearOf(world, WK[j]);
    harm *= (0.05 + 0.95 * (1 - fin(sk.sn))) * P.fever;
    add('Fever ground', -(0.04 * sk.fv * harm + 0.005 * sk.fv));
  }
  return out.sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
}

/** Why people `key` died as it did of plague p: frailty, hardiness, virgin soil, custom (the interface). */
export function sparedWhy(world, key, p) {
  const r = peekRec(world, key);
  const base = hasProviders('frailty') ? mulOf('frailty', world, key) : 1;
  const why = [];
  if (p && p.op && p.op !== key && virginOf(world, key, p.op) > 0.3) why.push('had never met this sickness');
  if (base <= 0.75) why.push('seldom sicken'); else if (base >= 1.25) why.push('sicken readily');
  if (r && r.h >= 0.15) why.push('hardened by old plagues');
  const c = CUSTOMS[r ? r.c : 'plain'];
  if (c && c.inf < 0.95) why.push(c.label); else if (c && c.inf > 1.05) why.push(c.label);
  return why;
}

// ---------------------------------------------------------------------------
// Providers

// settlers shun fever ground they cannot bear (civ/expansion.js)
registerProvider('siteBonus', 'health', (world, civ, i) => {
  const W = world.W;
  const fv = feverAt(world, i % W, Math.floor(i / W));
  return fv > 0.1 ? -0.04 * fv * bearOf(world, civPeople(world, civ)) : 0;
});

// the customs of a town's peoples, its physicians (its yearly pass)
registerProvider('townHealth', 'health', (world, s) => (s && s.sick ? fin(s.sick.ht) : 0));
// the humours bleed a sick ruler; herb-lore and germs do better (civ/rulers.js)
registerProvider('illCure', 'health', (world, civ) => physicOf(world, civ).ill);

// ---------------------------------------------------------------------------
// System

export const system = {
  id: 'health',
  order: 56,
  init(world) { healthState(world); },
  update(world) {
    const day = world.time.day;
    const doy = day % DPY;
    // the towns due today: id · 29 ≡ day + 180 of the year (mod 360), half a year from the peoples' pass
    const T = world.settlements;
    for (let id = (149 * ((doy + 180) % DPY)) % DPY; id < T.length; id += DPY) { const s = T[id]; if (s && s.alive && s.id === id) townYear(world, s); }
    if (day % DPY === 3 * DAYS_PER_MONTH + 9) worldYear(world);
    if (day % DAYS_PER_MONTH === 17) {
      monthly(world);
      const mo = Math.floor(day / DAYS_PER_MONTH) % 12;
      for (const civ of liveCivs(world)) if (civ.id % 12 === mo) realmYear(world, civ);
    }
  },
};
