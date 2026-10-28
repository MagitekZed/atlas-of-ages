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
//   s.sick = { im, ht } on each live town, rewritten on its yearly pass:
//     im  × how readily sickness spreads in the town for how it lives (1 for now)
//     ht  added to its health (ext townHealth): its peoples' customs
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
// Exports: healthState, peopleRec, peekRec, frailOf, virginOf, plagueWeights, plagueToll,
//          noteExposed, originPeople, townInf, CUSTOMS, system

import { on } from '../../core/hooks.js';
import { chronicle } from '../../core/chronicle.js';
import { registerProvider, mulOf, firstOf, hasProviders } from '../../core/ext.js';
import { liveSettlements, damageSettlement } from '../../core/entities.js';
import { takePeople, takeOfPeople, isSet, cohortTotal } from '../../core/cohorts.js';
import { DAYS_PER_YEAR as DPY, DAYS_PER_MONTH } from '../../core/constants.js';
import { civPeople, folkById, peopleName, FOLK_MIN } from './folk.js';
import { routesOf } from './trade.js';
import { hashPick, pickOne } from './common.js';

const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mythic = (world) => fin(world.params && world.params.mythLevel) >= 2;

const H_MAX = 0.4;              // the most hardiness old plagues leave
const H_FADE = 0.985;           // a year: about half gone in fifty years
const H_CITY = 0.12;            // the floor for a people living wholly in great cities
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
const MILD = ['bath', 'wells', 'wells', 'hearth', 'plain', 'plain', 'plain', 'fear', 'fear'];
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
  return best != null ? 'f:' + best : civPeople(world, world.civs[s.civId]);
}

/** × how readily sickness spreads in town s for how it lives (its yearly pass). */
export const townInf = (s) => (s.sick && Number.isFinite(s.sick.im) ? s.sick.im : 1);

// ---------------------------------------------------------------------------
// A plague town's peoples

const WK = [], WD = [], WS = [];   // scratch for the town being stepped: its peoples, each one's weight of the dead, its share
let WN = 0;
const OUT = { inf: 1, die: 1 };

/** Each people's share of town s: its own table (Mythic), else the mix (Historical). Fills WK / WS; returns the count. */
function sharesOf(world, s) {
  WN = 0;
  if (mythic(world)) {
    const c = s.cohorts;
    if (isSet(c)) {
      const tot = Math.max(1, fin(s.population));
      for (const r in c) { const n = cohortTotal(c[r]); if (n > 0) { WK[WN] = 'r:' + r; WS[WN] = n / tot; WN++; } }
    } else if (s.race) { WK[0] = 'r:' + s.race; WS[0] = 1; WN = 1; }
    return WN;
  }
  const m = s.folk;
  if (m) for (const id in m) if (m[id] > 0) { WK[WN] = 'f:' + id; WS[WN] = m[id]; WN++; }
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
  for (let j = 0; j < WN; j++) {
    const key = WK[j], sh = WS[j];
    const fr = Math.sqrt(frailOf(world, key));
    const v = p.op ? virginOf(world, key, p.op) : 0;
    const r = peekRec(world, key);
    const c = CUSTOMS[r ? r.c : 'plain'] || CUSTOMS.plain;
    const i = fr * c.inf * (1 + 0.4 * v);
    const d = fr * (1 + 3.5 * v);
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
      const got = takeOfPeople(world, s, key.slice(2), n * WD[j] / W, 'frail');
      dead += got;
      const b = (by[key] ||= [0, 0]);
      b[0] += got;
    }
    if (n - dead > 0.01) dead += takePeople(world, s, n - dead, 'frail');
    damageSettlement(world, s, { pop: 0, cause: 'plague' });   // its tier, and the end of a town too small to stand
  } else {
    dead = damageSettlement(world, s, { pop: frac, cause: 'plague' });
    const m = s.folk;
    if (m && dead > 0 && s.alive) {
      const left = Math.max(1, N - dead);
      let sum = 0, main = null, ms = -1;
      for (let j = 0; j < WN; j++) {
        const id = WK[j].slice(2), d = dead * WD[j] / W;
        const b = (by[WK[j]] ||= [0, 0]);
        b[0] += d;
        m[id] = Math.max(0, (fin(m[id]) * N - d) / left);
      }
      for (const id in m) if (m[id] > ms) { ms = m[id]; main = id; }
      for (const id in m) if (!(m[id] >= FOLK_MIN) && id !== main) { m[main] = fin(m[main]) + fin(m[id]); delete m[id]; }
      for (const id in m) sum += m[id];
      if (sum > 0) for (const id in m) m[id] = Math.round(m[id] / sum * 1e4) / 1e4;
    }
  }
  return dead;
}

/** A new outbreak in town s: its peoples are counted as exposed to plague p. */
export function noteExposed(world, s, p) {
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
// The yearly passes

/** A town's year: what its peoples' customs add to its health; its peoples learn each other's sicknesses, and its trading partners'. */
function townYear(world, s) {
  const n = sharesOf(world, s);
  let ht = 0;
  for (let j = 0; j < n; j++) {
    const r = peopleRec(world, WK[j]);
    ht += WS[j] * (CUSTOMS[r.c] || CUSTOMS.plain).hp;
  }
  const keys = WK.slice(0, n), sh = WS.slice(0, n);
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (sh[a] >= 0.02 && sh[b] >= 0.02) learn(world, keys[a], keys[b]);
  const own = originPeople(world, s);
  if (own) for (const r of routesOf(world, s.id)) {
    const t = world.settlements[r.aId === s.id ? r.bId : r.aId];
    if (t && t.alive) learn(world, own, originPeople(world, t));
  }
  const sk = s.sick && typeof s.sick === 'object' ? s.sick : (s.sick = {});
  sk.im = 1;
  sk.ht = Math.round(ht * 1e4) / 1e4;
}

/** The world's year: hardiness fades, down to a floor for the peoples of great cities. */
function worldYear(world) {
  const H = healthState(world);
  const tot = {}, urb = {};
  for (const s of liveSettlements(world)) {
    const n = sharesOf(world, s), N = fin(s.population);
    for (let j = 0; j < n; j++) {
      const k = WK[j], v = WS[j] * N;
      tot[k] = fin(tot[k]) + v;
      if ((s.tier || 0) >= 4) urb[k] = fin(urb[k]) + v;
    }
  }
  for (const key of Object.keys(H.p)) {
    const r = H.p[key];
    const floor = tot[key] > 0 ? H_CITY * fin(urb[key]) / tot[key] : 0;
    r.h = Math.round(Math.max(r.h * H_FADE, floor) * 1e4) / 1e4;
    // a vanished people is forgotten (its kin keep its name in what they know until it falls off)
    if (!(tot[key] > 0) && key[0] === 'f') { const P = folkById(world, +key.slice(2)); if (!P || P.gone != null) delete H.p[key]; }
  }
}

// ---------------------------------------------------------------------------
// Providers

// the customs of a town's peoples (its yearly pass)
registerProvider('townHealth', 'health', (world, s) => (s && s.sick ? fin(s.sick.ht) : 0));

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
  },
};
