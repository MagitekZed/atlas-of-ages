// Shared helpers for the geopolitics systems (religion, disease, trade, diplomacy, war):
// civ modifiers with safe defaults, symmetric treaty bookkeeping, rate limiting, and the
// small prose toolkit the chronicle entries are written with. DOM-free. No module-level
// mutable state: per-world scratch lives in world.cache, persistent state in world.sys.

import { DAYS_PER_YEAR, DAYS_PER_MONTH, BIOME } from '../../core/constants.js';
import { rel } from '../../core/entities.js';
import { seasonAt } from '../../core/world.js';
import { SEASONS } from '../../core/constants.js';
import { emit } from '../../core/hooks.js';

// ---------------------------------------------------------------------------
// Hooks (contracts §5): every WP4 emit goes through emitHook, which also counts it in
// world.cache (for system reports; lost on reload, never saved).

/** Emit a kernel hook and count it (world.cache.wp4Hooks[name]). */
export function emitHook(world, name, ...args) {
  const c = (world.cache.wp4Hooks ||= {});
  c[name] = (c[name] || 0) + 1;
  emit(world, name, ...args);
}
/** Counts of the WP4 hooks emitted in this session: { name: n }. */
export const hookCounts = (world) => world.cache.wp4Hooks || {};

let tech = null;
try { tech = await import('../civ/tech.js'); } catch (e) { /* civ module not available yet: defaults apply */ }

// ---------------------------------------------------------------------------
// Civ modifiers (SPEC §6.3 defaults)

export const DEFAULT_MODS = Object.freeze({
  farming: 0, farmYield: 1, gatherYield: 1, fishYield: 1, housing: 1, health: 1, birth: 1,
  research: 1, culture: 1, production: 1, trade: 1, tradeRange: 10, military: 1, defense: 1,
  siege: 1, movement: 1, navigation: 0, medicine: 1, sanitation: 1, mining: 1, stability: 0,
  expansionRange: 8, industry: 0, pollution: 0, plagueResist: 0,
  seaRange: 0,            // civ module extra: added sailing reach in tiles
});

// Sanity bounds so a bad upstream value can never explode a formula here.
const MOD_BOUNDS = {
  trade: [0, 20], tradeRange: [2, 250], military: [0.05, 50], defense: [0.05, 50], siege: [0.05, 50],
  movement: [0.2, 8], navigation: [0, 2], medicine: [0, 1], sanitation: [0.1, 20], plagueResist: [0, 0.9],
  health: [0.05, 20], stability: [-2, 2], seaRange: [0, 250],
};

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Full modifier object for a civ: the civ module's getMods() when available, else
 * civ.mods, else defaults — every key present and finite. Cached per sim-month and per
 * civ.mods object (the civ module replaces it on every refresh), so a mid-month refresh is
 * seen at once — exactly as by a world reloaded mid-month, whose cache starts empty.
 */
export function modsOf(world, civ) {
  if (!civ) return DEFAULT_MODS;
  const month = Math.floor(world.time.day / DAYS_PER_MONTH);
  let c = world.cache.geoMods;
  if (!c || c.month !== month) c = world.cache.geoMods = { month, byId: {}, src: {} };
  const hit = c.byId[civ.id];
  if (hit && c.src[civ.id] === civ.mods) return hit;
  let src = null;
  if (tech && typeof tech.getMods === 'function') {
    try { src = tech.getMods(world, civ); } catch (e) { src = null; }
  }
  const alt = civ.mods || {};
  if (!src || typeof src !== 'object') src = alt;
  const m = {};
  for (const k in DEFAULT_MODS) {
    let v = src[k];
    if (!finite(v)) v = finite(alt[k]) ? alt[k] : DEFAULT_MODS[k];
    const b = MOD_BOUNDS[k];
    if (b) v = v < b[0] ? b[0] : v > b[1] ? b[1] : v;
    m[k] = v;
  }
  m.navigation = Math.round(m.navigation);
  c.byId[civ.id] = m;
  c.src[civ.id] = civ.mods;
  return m;
}

/**
 * Modifiers for previews and providers: civ.mods as it stands (defaults filled, bounded), never
 * asking the civ module to recompute — so a preview cannot write saved state. Not cached.
 */
export function peekMods(civ) {
  const src = (civ && civ.mods) || {};
  const m = {};
  for (const k in DEFAULT_MODS) {
    let v = src[k];
    if (!finite(v)) v = DEFAULT_MODS[k];
    const b = MOD_BOUNDS[k];
    if (b) v = v < b[0] ? b[0] : v > b[1] ? b[1] : v;
    m[k] = v;
  }
  m.navigation = Math.round(m.navigation);
  return m;
}

/** Era index of a civ (0 when unknown). */
export const eraOf = (civ) => (civ && civ.tech && finite(civ.tech.era) ? civ.tech.era : 0);

// ---------------------------------------------------------------------------
// Persistent geo bookkeeping (world.sys.geo) and rate limiting

export function geoState(world) {
  const g = (world.sys.geo ||= {});
  g.rate ||= {};
  return g;
}

/** True (and records now) if `key` has not fired within the last `days` days. */
export function rateOk(world, key, days) {
  const r = geoState(world).rate;
  const last = r[key];
  if (last != null && world.time.day - last < days) return false;
  r[key] = world.time.day;
  return true;
}
/** Peek without recording. */
export function rateReady(world, key, days) {
  const last = geoState(world).rate[key];
  return last == null || world.time.day - last >= days;
}
/** Drop rate-limit keys older than maxAgeDays (diplomacy calls it yearly with the longest limit in use, 120 years). */
export function pruneRates(world, maxAgeDays = 60 * DAYS_PER_YEAR) {
  const r = geoState(world).rate;
  const now = world.time.day;
  for (const k of Object.keys(r)) if (now - r[k] > maxAgeDays) delete r[k];
}

// ---------------------------------------------------------------------------
// Civ queries

export const pairKey = (a, b) => (a < b ? a * 4096 + b : b * 4096 + a);
export const isAlive = (civ) => Boolean(civ && civ.alive);
export const civById = (world, id) => (id == null || id < 0 ? null : world.civs[id] || null);

export function rulerHas(civ, trait) {
  const t = civ && civ.ruler && civ.ruler.traits;
  return Array.isArray(t) && t.includes(trait);
}

/** "King Arven" / "Arven" / null. */
export function rulerName(civ) {
  const r = civ && civ.ruler;
  if (!r || !r.name) return null;
  return r.title ? `${r.title} ${r.name}` : r.name;
}

/** Plural people name: "the Varathians", "the Oskeli". */
export function peopleOf(civ) {
  if (!civ) return 'a vanished people';
  const adj = civ.adjective || civ.baseName || civ.name || 'Unknown';
  if (/(ese|ish|i|ch|sh|ss)$/i.test(adj)) return `the ${adj}`;
  if (/(an|ar|en|on|in)$/i.test(adj)) return `the ${adj}s`;
  if (/(ic|ene|y)$/i.test(adj)) return `the ${adj} folk`;
  return `the ${adj}s`;
}

/**
 * Display name of a civ for mid-sentence use. Styled names get an article ("the Kingdom of
 * Varath", "the Oskeli Chiefdom"); bare names stay bare ("Varath"). capFirst() at sentence start.
 */
export function civName(civ) {
  const n = civ ? civ.name || civ.baseName : null;
  if (!n) return 'a forgotten realm';
  if (/^the\s/i.test(n)) return 'the ' + n.slice(4);
  return /\s/.test(n) ? 'the ' + n : n;
}
export const civAdj = (civ) => (civ ? civ.adjective || civ.baseName || civ.name : 'Unknown');

export function capitalOf(world, civ) {
  if (!civ || civ.capitalId == null) return null;
  const s = world.settlements[civ.capitalId];
  return s && s.alive ? s : null;
}

/** Live settlements of a civ (no allocation-free variant needed at our call rates). */
export function townsOf(world, civ) {
  const out = [];
  if (!civ) return out;
  for (const sid of civ.settlementIds) {
    const s = world.settlements[sid];
    if (s && s.alive) out.push(s);
  }
  return out;
}

/**
 * World population (live settlements), cached per sim-day: a per-month value filled on first
 * use would differ in a world reloaded mid-month, and so would its history.
 */
export function worldPopulation(world) {
  const day = world.time.day;
  const c = world.cache.geoWorldPop;
  if (c && c.day === day) return c.pop;
  let p = 0;
  for (const s of world.settlements) if (s && s.alive && finite(s.population)) p += s.population;
  world.cache.geoWorldPop = { day, pop: p };
  return p;
}

export function civPopulation(world, civ) {
  if (!civ) return 0;
  if (finite(civ.population) && civ.population > 0) return civ.population;
  let p = 0;
  for (const sid of civ.settlementIds) { const s = world.settlements[sid]; if (s && s.alive) p += s.population || 0; }
  return p;
}

/**
 * Active trade routes (world.tradeRoutes only grows, so never scan it per query) and the map
 * settlementId → active routes touching it. Cached in world.cache and rebuilt only when the
 * route set changes: trade bumps world.cache.routeEpoch on every creation and break.
 */
function routeIndex(world) {
  const c = world.cache;
  const epoch = c.routeEpoch || 0;
  if (c.routeIdx && c.routeIdx.epoch === epoch && c.routeIdx.n === world.tradeRoutes.length) return c.routeIdx;
  const active = [];
  const adj = new Map();
  for (const r of world.tradeRoutes) {
    if (!r || !r.active) continue;
    active.push(r);
    let a = adj.get(r.aId); if (!a) adj.set(r.aId, (a = []));
    let b = adj.get(r.bId); if (!b) adj.set(r.bId, (b = []));
    a.push(r); b.push(r);
  }
  return (c.routeIdx = { epoch, n: world.tradeRoutes.length, active, adj });
}
/** settlementId → active routes (shared: do not mutate). */
export const routeAdjacency = (world) => routeIndex(world).adj;
/** All active routes (shared: do not mutate). */
export const activeRouteList = (world) => routeIndex(world).active;
export const touchRoutes = (world) => { world.cache.routeEpoch = (world.cache.routeEpoch || 0) + 1; };

// ---------------------------------------------------------------------------
// Active wars (cached on versions.wars — world.wars only grows, so never scan it per query)

function warIndex(world) {
  const v = world.versions.wars || 0;
  const c = world.cache.geoWars;
  if (c && c.v === v) return c;
  const active = [];
  const enemies = new Map();
  const add = (a, b) => { let s = enemies.get(a); if (!s) enemies.set(a, (s = new Set())); s.add(b); };
  for (const w of world.wars) {
    if (!w || !w.active) continue;
    active.push(w);
    for (const a of w.attackers) for (const d of w.defenders) { add(a, d); add(d, a); }
  }
  return (world.cache.geoWars = { v, active, enemies });
}
const NO_ENEMIES = new Set();
/** Active wars (shared array: do not mutate; copy before ending wars while iterating). */
export const activeWarList = (world) => warIndex(world).active;
/** Set of civ ids at war with civId (shared: do not mutate). */
export const enemySet = (world, civId) => warIndex(world).enemies.get(civId) || NO_ENEMIES;
/** Civs currently party to any war. */
export function civsAtWar(world) {
  const idx = warIndex(world);
  return idx.enemies;
}

// ---------------------------------------------------------------------------
// Treaties (kept symmetric on both relation objects)

export function hasTreaty(world, a, b, t) {
  const r = world.civs[a]?.relations[b];
  return Boolean(r && r.treaties && r.treaties.includes(t));
}
export function addTreaty(world, a, b, t) {
  for (const [x, y] of [[a, b], [b, a]]) {
    const r = rel(world, x, y);
    if (!r.treaties) r.treaties = [];
    if (!r.treaties.includes(t)) r.treaties.push(t);
  }
}
export function removeTreaty(world, a, b, t) {
  for (const [x, y] of [[a, b], [b, a]]) {
    const r = world.civs[x]?.relations[y];
    if (r && r.treaties) r.treaties = r.treaties.filter((k) => k !== t);
  }
}

// ---------------------------------------------------------------------------
// Prose toolkit

const SMALL = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const ORD = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth'];

export function withCommas(n) {
  const s = String(Math.round(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return (n < 0 ? '-' : '') + out;
}

/** Human count for prose: "seven", "340", "3,400", "84,000", "1.2 million". */
export function fmtCount(n) {
  if (!finite(n) || n <= 0) return 'no';
  n = Math.round(n);
  if (n <= 12) return SMALL[n];
  if (n < 100) return String(n);
  if (n < 1000) return String(Math.round(n / 10) * 10);
  if (n < 1e6) {
    const mag = Math.pow(10, Math.floor(Math.log10(n)) - 1);
    return withCommas(Math.round(n / mag) * mag);
  }
  const m = n / 1e6;
  return (m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')) + ' million';
}

/** Small integer as a word ("three") with a numeric fallback. */
export const countWord = (n) => (n >= 0 && n <= 12 ? SMALL[n] : String(n));
export function ordinalWord(n) {
  if (n >= 1 && n < ORD.length) return ORD[n];
  const t = n % 100, u = n % 10;
  return `${n}${t >= 11 && t <= 13 ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th'}`;
}

/** "A", "A and B", "A, B and C". */
export function listJoin(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a[0] || '';
  return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}

/** "eleven days", "five months", "three years", "nearly two decades". */
export function spanPhrase(days) {
  days = Math.max(0, Math.round(days));
  if (days < 45) return `${countWord(Math.max(1, days))} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / DAYS_PER_MONTH);
  if (months < 18) return `${countWord(months)} month${months === 1 ? '' : 's'}`;
  const years = Math.round(days / DAYS_PER_YEAR);
  if (years < 13) return `${countWord(years)} year${years === 1 ? '' : 's'}`;
  if (years < 19) return `${years} years`;
  if (years < 25) return 'two decades';
  if (years < 45) return `${years} years`;
  if (years < 80) return 'half a century and more';
  if (years < 130) return 'a century';
  return `${Math.round(years / 100)} centuries`;
}

export const capFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Fill "{key}" placeholders, then capitalise the first letter. */
export function fill(tpl, vars) {
  return capFirst(tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : '')));
}

/** Fill "{key}" placeholders without touching capitalisation (for proper names). */
export function fillRaw(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

/** Pick one template from a pool with the world RNG. */
export const pickOne = (world, arr) => arr[Math.floor(world.rng.next() * arr.length)];

/** Strip a leading "the " (for possessives and compounds). */
export const bare = (name) => (name ? name.replace(/^the\s+/i, '') : name);
/** Ensure a leading lower-case "the". */
export const theName = (name) => (!name ? name : /^the\s/i.test(name) ? 'the ' + name.slice(4) : name);

/** Local season name at row y ("winter"). */
export const seasonWord = (world, y) => SEASONS[seasonAt(world, Math.max(0, Math.min(world.H - 1, Math.round(y || 0))))].toLowerCase();

/** Biome-derived landscape word for a tile (for battle sites and prose). */
export function landscapeAt(world, i) {
  const f = world.f;
  const b = f.biome[i];
  const e = f.elevation[i];
  if (f.water[i]) return 'sea';
  if (e >= 0.8) return 'pass';
  if (e >= 0.64) return 'hills';
  if (f.river[i] >= 2) return 'fords';
  if (b === BIOME.WETLAND) return 'marsh';
  if (b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT) return 'sands';
  if (b === BIOME.TEMPERATE_FOREST || b === BIOME.TEMPERATE_RAINFOREST || b === BIOME.TAIGA || b === BIOME.RAINFOREST || b === BIOME.TROPICAL_FOREST) return 'wood';
  if (b === BIOME.TUNDRA || b === BIOME.ICE) return 'snows';
  if (f.coast[i]) return 'shore';
  return 'field';
}

/** Nearest named geographic feature of the given kinds within maxDist tiles. */
export function nearestFeature(world, x, y, kinds, maxDist = 30) {
  let best = null, bd = maxDist * maxDist;
  for (const ft of world.features || []) {
    if (!ft || !kinds.includes(ft.kind) || !ft.name) continue;
    const d = (ft.x - x) * (ft.x - x) + (ft.y - y) * (ft.y - y);
    if (d <= bd) { bd = d; best = ft; }
  }
  return best;
}

/** Deterministic small hash for picking flavour without consuming RNG draws. */
export function hashPick(arr, ...nums) {
  let h = 2166136261;
  for (const n of nums) { h ^= (n | 0); h = Math.imul(h, 16777619); h ^= h >>> 13; }
  return arr[(h >>> 0) % arr.length];
}

export { finite };
