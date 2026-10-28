// Peoples and memory (chunk 8, docs/design/peoples-and-memory.md): the peoples of a Historical
// world and every town's mix of them; how each people regards the others and how long it
// remembers; how alike two realms are. (A Mythic world's peoples are its races: their mixes are
// myth/peoples.js's; the feelings here serve both, keyed 'r:elf' or 'f:12'.)
//
//   sys.civ.folk = { p: [people], fe: { 'a>b': n }, waves: [], v }
//     people = { id, name, adj, root, born, from, lang: { o, c, v }, x, y, gone?, peak? }
//       its name ("Tians") and adjective, the realm it began with, when, the people it grew out of
//       (a realm long apart from its kin: ethnogenesis), its tongue's sounds (for distance), its
//       birthplace, when it vanished, its greatest number
//     fe   how people a regards people b, −100 to 100, for pairs that have met (directed)
//   civ.folk  the realm's people (id), decided at its founding (a split keeps its parent's; a
//             restored realm its old one; a new realm its towns' main people, or a new people)
//   s.folk    a Historical town's mix { [id]: share }, shares ≥ FOLK_MIN summing to 1
//
// Yearly per town (spread over the year by id, as Mythic towns): the mix relaxes toward its
// neighbours' and trade partners' mixes, each people weighted by how welcome it is (the town's
// people's feelings toward it, the realm's standing for it); a minority takes on the town's main
// people's ways at about a third a generation × how alike the two are × how small it is × the
// town's size × its standing (Historical only: races do not turn into one another). Settlers,
// migrants and conquerors carry their mixes (hooks). Yearly per realm: a realm three centuries
// apart from its kin, far away, may become a people of its own; a young realm takes its towns'
// people, and a people that had lost every realm may rise again. Yearly for the world: feelings
// move with wars, trade and time, and fade at each people's memory; peoples that vanish are told.
//
// Draws from world.rng (conquerors' settlers, ethnogenesis, the told lines) in a fixed order.
// Exports: folkState, peopleKey, peopleName, civPeople, townMix, feel, nudgeFeel, cultDist,
//          folkDist, realmMix, system

import { on } from '../../core/hooks.js';
import { registerProvider, firstOf, hasProviders } from '../../core/ext.js';
import { settlementsNear, liveCivs, liveSettlements } from '../../core/entities.js';
import { DAYS_PER_YEAR as DPY, DAYS_PER_MONTH } from '../../core/constants.js';
import { chronicle } from '../../core/chronicle.js';
import { routesOf } from './trade.js';
import { civName, peopleOf, capFirst, hashPick, activeWarList } from './common.js';

export const FOLK_MIN = 0.005;
const ASSIM = 1 / 28;                 // a small minority in a town of its own kind: about a third a generation
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mythic = (world) => fin(world.params && world.params.mythLevel) >= 2;

export function folkState(world) {
  const st = world.sys.civ;
  if (!st) return null;
  if (!st.folk || !Array.isArray(st.folk.p)) st.folk = { p: [], fe: {}, waves: [], v: 0 };
  return st.folk;
}
const touch = (F) => { F.v = fin(F.v) + 1; };

// ---------------------------------------------------------------------------
// Peoples

function newPeople(world, civ, from = null) {
  const F = folkState(world);
  const id = F.p.length;
  const cap = world.settlements[civ.capitalId];
  const L = civ.language || {};
  const p = {
    id, name: peopleOf(civ).replace(/^the\s+/i, ''), adj: civ.adjective || civ.name, root: civ.id, born: world.time.day, from,
    lang: { o: (L.onsets || []).slice(), c: (L.codas || []).slice(), v: (L.vowels || []).slice() },
    x: cap ? cap.x : fin(civ.originX), y: cap ? cap.y : fin(civ.originY),
  };
  F.p.push(p);
  touch(F);
  return p;
}
export const folkById = (world, id) => (id == null ? null : folkState(world)?.p[id] || null);

/** The realm's people id (Historical), decided at the first read. */
export function civFolk(world, civ) {
  if (!civ || mythic(world)) return null;
  if (civ.folk != null && folkById(world, civ.folk)) return civ.folk;
  const parent = civ.parentId != null ? world.civs[civ.parentId] : null;
  const old = civ.flags && civ.flags.restored != null ? world.civs[civ.flags.restored] : null;
  if (old && old.folk != null && folkById(world, old.folk)) civ.folk = old.folk;
  else if (parent && parent.id !== civ.id && civFolk(world, parent) != null) civ.folk = parent.folk;
  else civ.folk = newPeople(world, civ).id;
  return civ.folk;
}
/** A people's key for feelings and standings: 'r:elf' (a Mythic race) or 'f:12'. */
export function civPeople(world, civ) {
  if (!civ) return null;
  if (mythic(world)) return civ.race ? 'r:' + civ.race : null;
  const id = civFolk(world, civ);
  return id == null ? null : 'f:' + id;
}
/** A people's name ("the Tians", "elves"). */
export function peopleName(world, key, article = true) {
  if (!key) return 'a forgotten people';
  if (key[0] === 'r') { const r = key.slice(2); return { human: 'men', elf: 'elves', dwarf: 'dwarves', orc: 'orcs', halfling: 'halflings', lizardfolk: 'lizardfolk' }[r] || r; }
  const p = folkById(world, +key.slice(2));
  return p ? (article ? 'the ' : '') + p.name : 'a forgotten people';
}

// ---------------------------------------------------------------------------
// Town mixes (Historical)

/** A Historical town's mix { id: share } (made at the first read: its realm's people). */
export function townFolk(world, s) {
  if (!s || mythic(world)) return null;
  if (s.folk && typeof s.folk === 'object') return s.folk;
  const civ = world.civs[s.civId];
  const id = civ ? civFolk(world, civ) : null;
  s.folk = id == null ? {} : { [id]: 1 };
  return s.folk;
}
/** The mix as people keys → shares (both kinds of world). */
export function townMix(world, s) {
  if (!s) return {};
  if (mythic(world)) { const o = {}; for (const r in s.peoples || {}) o['r:' + r] = s.peoples[r]; if (!Object.keys(o).length && s.race) o['r:' + s.race] = 1; return o; }
  const m = townFolk(world, s), o = {};
  for (const id in m) o['f:' + id] = m[id];
  return o;
}
const mainOf = (m) => { let best = null, bs = -1; for (const k in m) if (m[k] > bs) { bs = m[k]; best = k; } return best; };
function tidy(m, main) {
  let sum = 0;
  for (const k in m) { if (!(m[k] >= FOLK_MIN)) { if (main != null && k !== main) m[main] = fin(m[main]) + fin(m[k]); delete m[k]; } }
  for (const k in m) sum += m[k];
  if (!(sum > 0)) return m;
  for (const k in m) m[k] = Math.round(m[k] / sum * 1e4) / 1e4;
  return m;
}
/** Blend n newcomers of mix `src` into town s (Historical). */
function blendInto(world, s, src, n) {
  const m = townFolk(world, s);
  if (!m || !src) return;
  const w = clamp(n / Math.max(1, fin(s.population) + n), 0, 1);
  if (!(w > 0)) return;
  for (const k in m) m[k] *= 1 - w;
  for (const k in src) m[k] = fin(m[k]) + src[k] * w;
  tidy(m, mainOf(m));
}
/** Settlers from `from` (or the nearest town of the realm within 30 tiles), nudged toward the realm's people. */
function seedTown(world, s, from = null) {
  if (mythic(world)) return;
  const civ = world.civs[s.civId];
  const id = civ ? civFolk(world, civ) : null;
  if (!from) {
    let bd = 900;
    for (const t of settlementsNear(world, s.x, s.y, 30, (t) => t.alive && t.id !== s.id && t.civId === s.civId)) {
      const d = (t.x - s.x) ** 2 + (t.y - s.y) ** 2;
      if (d < bd) { bd = d; from = t; }
    }
  }
  const src = from ? townFolk(world, from) : null;
  const m = {};
  if (src) for (const k in src) m[k] = src[k] * 0.85;
  if (id != null) m[id] = fin(m[id]) + (src ? 0.15 : 1);
  s.folk = tidy(m, id != null ? String(id) : mainOf(m));
}

/** The realm's mix, by people: { key: people } (cached per month). */
export function realmMix(world, civ) {
  const c = world.cache.folkRealm;
  const mo = Math.floor(world.time.day / DAYS_PER_MONTH);
  let map = c && c.mo === mo ? c.m : null;
  if (!map) { map = new Map(); world.cache.folkRealm = { mo, m: map }; }
  let r = map.get(civ.id);
  if (r) return r;
  r = {};
  for (const sid of civ.settlementIds || []) {
    const s = world.settlements[sid];
    if (!s || !s.alive) continue;
    const m = townMix(world, s), pop = fin(s.population);
    for (const k in m) r[k] = fin(r[k]) + m[k] * pop;
  }
  map.set(civ.id, r);
  return r;
}

// ---------------------------------------------------------------------------
// Distance and feelings

/** How unlike two Historical peoples are, 0 to 1: kin (one grew out of the other) 0.25, else by tongue. */
export function folkDist(world, a, b) {
  if (a === b) return 0;
  const A = folkById(world, a), B = folkById(world, b);
  if (!A || !B) return 0.8;
  if (A.from === b || B.from === a || (A.from != null && A.from === B.from)) return 0.25;
  const set = (p) => new Set([...p.lang.o, ...p.lang.c, ...p.lang.v]);
  const x = set(A), y = set(B);
  let both = 0;
  for (const s of x) if (y.has(s)) both++;
  const J = both / Math.max(1, x.size + y.size - both);
  return 0.3 + 0.7 * (1 - J);
}
const keyDist = (world, a, b) => (a === b ? 0 : a[0] === 'f' && b[0] === 'f' ? folkDist(world, +a.slice(2), +b.slice(2)) : 1);

/**
 * How alike two realms are, 0 to 1 (0 the same): their peoples (0.35), tongues (0.25), faiths
 * (0.2) and customs (0.2). Cached for the year.
 */
export function cultDist(world, A, B) {
  if (!A || !B || A.id === B.id) return 0;
  const yr = Math.floor(world.time.day / DPY);
  let c = world.cache.folkDist;
  if (!c || c.yr !== yr) c = world.cache.folkDist = { yr, m: new Map() };
  const k = A.id < B.id ? A.id * 100003 + B.id : B.id * 100003 + A.id;
  let d = c.m.get(k);
  if (d != null) return d;
  const pa = civPeople(world, A), pb = civPeople(world, B);
  const dp = pa && pb ? keyDist(world, pa, pb) : 0.8;
  const la = A.language || {}, lb = B.language || {};
  const sa = new Set([...(la.onsets || []), ...(la.codas || []), ...(la.vowels || [])]), sb = new Set([...(lb.onsets || []), ...(lb.codas || []), ...(lb.vowels || [])]);
  let both = 0;
  for (const s of sa) if (sb.has(s)) both++;
  const dt = 1 - both / Math.max(1, sa.size + sb.size - both);
  const fa = A.stateReligion, fb = B.stateReligion;
  const R = world.religions || [];
  const df = fa == null || fb == null ? 0.5 : fa === fb ? 0 : (R[fa]?.parentId === fb || R[fb]?.parentId === fa) ? 0.5 : 1;
  let dc = 0, n = 0;
  for (const t in A.traits || {}) { if (B.traits && Number.isFinite(B.traits[t])) { dc += Math.abs(fin(A.traits[t]) - B.traits[t]); n++; } }
  dc = n ? Math.min(1, 2 * dc / n) : 0.5;
  d = Math.round((0.35 * dp + 0.25 * dt + 0.2 * df + 0.2 * dc) * 1000) / 1000;
  c.m.set(k, d);
  return d;
}

// a Mythic world's races start from their old fixed table (myth/races.js 'kinRule'); Historical
// peoples from kinship and distance
function baseFeel(world, a, b) {
  if (a === b) return 10;
  if (hasProviders('kinRule')) { const v = firstOf('kinRule', world, a, b); if (Number.isFinite(v)) return v; }
  if (a[0] === 'f' && b[0] === 'f') { const d = keyDist(world, a, b); return d <= 0.25 ? 15 : Math.round(6 - 15 * d); }
  return 0;
}
/** How people a regards people b, −100 to 100. */
export function feel(world, a, b) {
  if (!a || !b) return 0;
  const F = folkState(world);
  const v = F && F.fe[a + '>' + b];
  return Number.isFinite(v) ? v : baseFeel(world, a, b);
}
/** Move how a regards b by dv (both kept within −100 … 100). */
export function nudgeFeel(world, a, b, dv) {
  if (!a || !b || a === b || !(dv !== 0)) return;
  const F = folkState(world);
  F.fe[a + '>' + b] = Math.round(clamp(feel(world, a, b) + dv, -100, 100) * 100) / 100;
}
/** How long people `key` remembers (years): a grudge, a kindness (ext 'memoryRule', as towns). */
function memOf(world, key) {
  const r = hasProviders('memoryRule') && key[0] === 'r' ? firstOf('memoryRule', world, { race: key.slice(2) }) : null;
  return r && Number.isFinite(r.grudge) ? r : { grudge: 40, thanks: 25 };
}

// ---------------------------------------------------------------------------
// The year of a town (Historical)

function townYear(world, s) {
  const m = townFolk(world, s);
  if (!m) return;
  const civ = world.civs[s.civId];
  if (!civ) return;
  const main = mainOf(m);
  const mainKey = main != null ? 'f:' + main : null;
  // neighbours within 12 tiles and trade partners; each people as welcome as the town's people
  // feel toward it, and the realm's standing for it (policy: phase C)
  const target = {};
  let wsum = 0, links = 0;
  const add = (t, w) => {
    const tm = townFolk(world, t);
    for (const k in tm) { const wk = w * tm[k] * welcome(world, civ, mainKey, 'f:' + k); target[k] = fin(target[k]) + wk; wsum += wk; }
  };
  for (const t of settlementsNear(world, s.x, s.y, 12, (t) => t.alive && t.id !== s.id)) add(t, fin(t.population) / (1 + Math.hypot(t.x - s.x, t.y - s.y)));
  for (const r of routesOf(world, s.id)) {
    const o = world.settlements[r.aId === s.id ? r.bId : r.aId];
    if (!o || !o.alive) continue;
    links++;
    add(o, fin(o.population) * 0.05 * Math.min(1, fin(r.value) / 10));
  }
  if (wsum > 0) {
    const rate = 0.004 * (1 + 0.5 * Math.min(4, links)) * (0.6 + 0.25 * Math.min(6, fin(s.tier))) * fin(world.params.migration, 1);
    for (const k in target) target[k] /= wsum;
    for (const k of new Set([...Object.keys(m), ...Object.keys(target)])) m[k] = fin(m[k]) + rate * (fin(target[k]) - fin(m[k]));
  }
  // assimilation: the minorities take on the main people's tongue and ways
  if (main != null) {
    const size = 0.6 + 0.15 * Math.min(6, fin(s.tier));
    let gain = 0;
    for (const k in m) {
      if (k === main) continue;
      const share = m[k];
      const small = share < 0.1 ? 1 : Math.max(0.25, 1 - 1.5 * (share - 0.1));
      const close = 1 - 0.8 * folkDist(world, +k, +main);
      const take = share * ASSIM * close * small * size * standingAssim(civ, 'f:' + k) * assimMul(world, civ);
      m[k] = share - take;
      gain += take;
    }
    m[main] = fin(m[main]) + gain;
  }
  tidy(m, main);
}

// ---------------------------------------------------------------------------
// Standings (policy toward minorities: phase C fills these in)

const STAND_WELCOME = { equal: 1.3, tolerated: 1, taxed: 0.8, persecuted: 0.35, expelled: 0.1 };
const STAND_ASSIM = { equal: 1.3, tolerated: 1, taxed: 0.85, persecuted: 0.4, expelled: 0.4 };
export const standingOf = (civ, key) => (civ && civ.minor && civ.minor[key] ? civ.minor[key][0] : 'tolerated');
const standingAssim = (civ, key) => STAND_ASSIM[standingOf(civ, key)] || 1;
function welcome(world, civ, mainKey, key) {
  const f = mainKey && key !== mainKey ? feel(world, mainKey, key) : 20;
  return clamp(1 + f / 100, 0.2, 1.5) * (STAND_WELCOME[standingOf(civ, key)] || 1);
}
const assimMul = (world, civ) => (hasProviders('assimilateRule') ? clamp(fin(firstOf('assimilateRule', world, civ), 1), 0, 4) : 1);

// ---------------------------------------------------------------------------
// The year of a realm

function realmYear(world, civ) {
  if (mythic(world)) return;
  const id = civFolk(world, civ);
  const P = folkById(world, id);
  if (!P) return;
  const day = world.time.day;
  // a young realm takes the people of its towns (a revolt of another people's towns founds that
  // people's realm; a people that had lost every realm rises again)
  const age = (day - fin(civ.foundedDay, day)) / DPY;
  if (age < 2 && !civ.flags?.folkSet) {
    civ.flags.folkSet = 1;
    const mix = realmMix(world, civ);
    const top = mainOf(mix);
    if (top && top !== 'f:' + id) {
      const tid = +top.slice(2);
      const lost = !liveCivs(world).some((c) => c.id !== civ.id && c.folk === tid);
      civ.folk = tid;
      const T = folkById(world, tid);
      if (lost && T && fin(mix[top]) > 2000) {
        chronicle(world, { cat: 'civ', imp: 3, text: hashPick([`With ${civName(civ)}, ${'the ' + T.name} rose again as a people with a realm of their own.`, `${capFirst('the ' + T.name)}, long ruled by others, had a realm again: ${civName(civ)}.`], civ.id, day), civId: civ.id, key: 'folk.reborn', ref: { k: 'folk', id: 'f:' + tid }, tags: ['people'] });
      }
    }
    return;
  }
  // a realm three centuries apart from its kin, far away, becomes a people of its own
  const since = (day - Math.max(fin(civ.foundedDay, day), fin(civ.flags?.independence, -1e9))) / DPY;
  if (since < 300 || !civ.adjective || civ.adjective === P.adj || !(world.rng.chance(0.02))) return;
  const cap = world.settlements[civ.capitalId];
  if (!cap) return;
  let near = Infinity, kin = 0;
  for (const c of liveCivs(world)) {
    if (c.id === civ.id || c.folk !== id) continue;
    kin++;
    const cc = world.settlements[c.capitalId];
    if (cc) near = Math.min(near, Math.hypot(cc.x - cap.x, cc.y - cap.y));
  }
  if (!kin || near < 40) return;
  const N = newPeople(world, civ, id);
  civ.folk = N.id;
  for (const sid of civ.settlementIds || []) {
    const s = world.settlements[sid];
    const m = s && townFolk(world, s);
    if (!m || !(m[id] > 0)) continue;
    m[N.id] = fin(m[N.id]) + m[id];
    delete m[id];
  }
  nudgeFeel(world, 'f:' + N.id, 'f:' + id, 10);
  chronicle(world, { cat: 'civ', imp: 3, text: hashPick([
    `Three centuries and more apart from their kin, the people of ${civName(civ)} had become a people of their own: the ${N.name}, of ${P.adj} stock.`,
    `Far from the lands of the ${P.name}, their own tongue and ways had grown apart: the ${N.name} of ${civName(civ)} were a people of their own.`,
  ], civ.id, day), civId: civ.id, key: 'folk.born', ref: { k: 'folk', id: 'f:' + N.id }, tags: ['people'] });
}

// ---------------------------------------------------------------------------
// The world's year: feelings, and peoples that vanish

function worldYear(world) {
  const F = folkState(world);
  const day = world.time.day;
  // wars: each side's people sours on the other's; those fighting side by side warm
  for (const war of activeWarList(world)) {
    const att = war.attackers.map((id) => civPeople(world, world.civs[id])).filter(Boolean);
    const def = war.defenders.map((id) => civPeople(world, world.civs[id])).filter(Boolean);
    for (const a of new Set(att)) for (const d of new Set(def)) { if (a === d) continue; nudgeFeel(world, d, a, -4); nudgeFeel(world, a, d, -2); }
    for (const side of [att, def]) { const u = [...new Set(side)]; for (const a of u) for (const b of u) if (a !== b) nudgeFeel(world, a, b, 1.5); }
  }
  // trade between realms warms their peoples a little
  for (const c of liveCivs(world)) {
    const pa = civPeople(world, c);
    for (const k in c.relations || {}) {
      const r = c.relations[k], o = world.civs[+k];
      if (!o || !o.alive || !(fin(r.trade) > 0)) continue;
      const pb = civPeople(world, o);
      if (pa && pb && pa !== pb) nudgeFeel(world, pa, pb, 0.5 * Math.min(1, fin(r.trade) / 25));
    }
  }
  // feelings fade toward where they began, at each people's memory
  for (const k of Object.keys(F.fe)) {
    const [a, b] = k.split('>');
    const base = baseFeel(world, a, b), v = F.fe[k];
    const mem = memOf(world, a);
    const tau = v < base ? mem.grudge : mem.thanks;
    const nv = base + (v - base) * Math.exp(-1 / Math.max(1, tau));
    if (Math.abs(nv - base) < 1) delete F.fe[k]; else F.fe[k] = Math.round(nv * 100) / 100;
  }
  if (mythic(world)) return;
  // the peoples' numbers; a people gone from the world is told
  const tot = new Map();
  for (const s of liveSettlements(world)) { const m = townFolk(world, s); for (const id in m) tot.set(+id, fin(tot.get(+id)) + m[id] * fin(s.population)); }
  for (const P of F.p) {
    if (P.gone != null) continue;
    const n = fin(tot.get(P.id));
    if (n > fin(P.peak)) P.peak = Math.round(n);
    if (n >= 1 || liveCivs(world).some((c) => c.folk === P.id)) continue;
    P.gone = day;
    if (fin(P.peak) >= 5000) chronicle(world, { cat: 'civ', imp: 2, text: hashPick([
      `The last who called themselves ${P.name} were gone: their tongue and ways had passed into those of their neighbours.`,
      `No one now spoke as the ${P.name} had spoken; the people had been absorbed by others.`,
    ], P.id, day), key: 'folk.absorbed', ref: { k: 'folk', id: 'f:' + P.id }, tags: ['people'] });
  }
  touch(F);
}

// ---------------------------------------------------------------------------
// Hooks

on('civCreated', (world, civ) => { if (civ && !mythic(world) && civ.parentId != null) civFolk(world, civ); });
on('settlementCreated', (world, s) => { if (s && !mythic(world)) seedTown(world, s); });
// settlers from a town (civ/expansion.js foundSettlement), migrants within a realm (routeMigrants)
on('settled', (world, s, from) => { if (s && from && !mythic(world)) seedTown(world, s, from); });
on('migrants', (world, from, to, n) => { if (from && to && !mythic(world)) blendInto(world, to, townFolk(world, from), n); });
// a conqueror's people settles in the towns it takes; the conquered people sours on it, and a
// town freed by its own people warms to them
on('settlementTransferred', (world, s, oldId, newId, cause) => {
  if (!s) return;
  const nu = world.civs[newId], old = world.civs[oldId];
  const pn = civPeople(world, nu), po = civPeople(world, old);
  const mk = mainOf(townMix(world, s));
  if (mk && pn && mk !== pn && cause === 'conquest') nudgeFeel(world, mk, pn, -4);
  if (mk && pn && mk === pn && po && po !== pn && (cause === 'conquest' || cause === 'rebellion')) nudgeFeel(world, mk, pn, 4);
  if (mythic(world) || cause !== 'conquest' || !nu) return;
  const id = civFolk(world, nu);
  const m = townFolk(world, s);
  if (id == null || !m) return;
  const g = 0.04 + 0.08 * world.rng.next();
  for (const k in m) m[k] *= 1 - g;
  m[id] = fin(m[id]) + g;
  tidy(m, mainOf(m));
});
// a town razed: its people's hatred of the razer (geo/war.js)
on('townRazed', (world, q) => {
  const s = q && world.settlements[q.sid];
  const att = q && world.civs[q.att];
  if (!s || !att) return;
  const pa = civPeople(world, att), mk = mainOf(townMix(world, s));
  if (pa && mk && pa !== mk) nudgeFeel(world, mk, pa, -15);
});
// a royal match warms the two peoples (civ/dynasty.js)
on('royalMatch', (world, A, B) => { const a = civPeople(world, A), b = civPeople(world, B); if (a && b && a !== b) { nudgeFeel(world, a, b, 3); nudgeFeel(world, b, a, 3); } });

// realms marry nearer their own kind (civ/dynasty.js matchYearly)
registerProvider('matchRule', 'folk', (world, A, B) => -0.6 * cultDist(world, A, B));

// a minority's grievances in its town (civ/settlement.js): taxed or persecuted (phase C)
registerProvider('townGrievance', 'folk', (world, s, civ) => {
  if (!civ || !civ.minor) return 0;
  const m = townMix(world, s);
  let g = 0;
  for (const k in m) { const st = standingOf(civ, k); if (st === 'taxed') g += 0.06 * m[k]; else if (st === 'persecuted' || st === 'expelled') g += 0.2 * m[k]; }
  return g;
});

// ---------------------------------------------------------------------------
// System

export const system = {
  id: 'folk',
  order: 72,
  init(world) { folkState(world); },
  update(world) {
    const day = world.time.day;
    const doy = day % DPY;
    if (!mythic(world)) for (const s of world.settlements) if (s && s.alive && (s.id * 29) % DPY === doy) townYear(world, s);
    if (day % DAYS_PER_MONTH === 5) {
      const mo = Math.floor(day / DAYS_PER_MONTH) % 12;
      for (const civ of liveCivs(world)) if (civ.id % 12 === mo) realmYear(world, civ);
      if (mo === 8) worldYear(world);
    }
  },
};
