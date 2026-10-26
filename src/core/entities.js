// Entity lifecycle shared by every system. Always create, transfer and destroy civs and
// settlements through these functions so tile fields, civ membership lists, caches,
// versions and hooks stay consistent. Bands (core/bands.js) are re-exported here so one
// import serves every entity kind.

import { createLanguage, makeCivName, makePlace } from './names.js';
import { hslToRgb, rgbToHex, clamp01 } from './util.js';
import { emit } from './hooks.js';
import { tierForPop, WATER, DAYS_PER_YEAR } from './constants.js';
import { bumpVersion } from './world.js';
import { DX8, DY8 } from './util.js';
import { mulOf } from './ext.js';
import { seedCohorts, takePeople, profileForCause } from './cohorts.js';

export { addBand, removeBand, getBand, bandsNear } from './bands.js';

// ---------------------------------------------------------------------------
// Generic helpers

/** Append to an index-as-id list (civs, settlements, religions, plagues, wars, tradeRoutes). */
export function addIndexed(world, list, obj) {
  obj.id = world[list].length;
  world[list].push(obj);
  return obj;
}
/** Append to a transient list whose ids come from world.nextId (armies, caravans, storms, fires, figures). */
export function addEntity(world, list, obj, idKey = list) {
  const key = world.nextId[idKey] != null ? idKey : 'misc';
  obj.id = world.nextId[key]++;
  world[list].push(obj);
  return obj;
}
export function removeEntity(world, list, id) {
  const arr = world[list];
  const k = arr.findIndex((o) => o.id === id);
  if (k >= 0) arr.splice(k, 1);
  return k >= 0;
}

// ---------------------------------------------------------------------------
// Civilizations

function pickCivColor(world) {
  const used = world.civs.filter((c) => c.alive).map((c) => c.hue);
  let best = 0, bestScore = -1;
  for (let k = 0; k < 24; k++) {
    const h = world.rng.next() * 360;
    let minD = 360;
    for (const u of used) { let d = Math.abs(h - u); d = Math.min(d, 360 - d); if (d < minD) minD = d; }
    if (minD > bestScore) { bestScore = minD; best = h; }
  }
  const s = 0.55 + world.rng.next() * 0.3;
  const l = 0.46 + world.rng.next() * 0.12;
  const color = hslToRgb(best, s, l);
  return { hue: best, color, colorHex: rgbToHex(color) };
}

const TRAIT_KEYS = ['aggression', 'expansion', 'religiosity', 'commerce', 'innovation', 'tolerance', 'militarism', 'isolation'];

/**
 * Create a civilization (no settlements yet — call createSettlement next).
 * opts: { name, adjective, language, languageStyle, parentId, x, y, traits, government, race }
 *   race          RACE_META key or null; when omitted a split inherits its parent's race
 *   languageStyle phonology bias passed to createLanguage (core/names.js) for a fresh tongue
 */
export function createCiv(world, opts = {}) {
  const rng = world.rng;
  const parent = opts.parentId != null ? world.civs[opts.parentId] : null;
  const race = opts.race !== undefined ? opts.race : parent ? parent.race ?? null : null;
  // a splinter keeps its parent's tongue (70%) only when it is the parent's own people: a
  // halfling shire breaking from an orc realm speaks as halflings do (opts.languageStyle)
  const kin = parent && (parent.race ?? null) === (race ?? null);
  const language = opts.language || (kin && rng.chance(0.7) ? { ...parent.language, placeSuffixes: parent.language.placeSuffixes.slice() } : createLanguage(rng, opts.languageStyle ?? null));
  const nm = opts.name ? { name: opts.name, adjective: opts.adjective || opts.name + 'ian' } : makeCivName(language, rng);
  const traits = {};
  for (const k of TRAIT_KEYS) {
    const base = parent ? parent.traits[k] + rng.normal(0, 0.15) : rng.float(0.1, 0.9);
    traits[k] = clamp01(opts.traits?.[k] ?? base);
  }
  const col = pickCivColor(world);
  const civ = {
    id: -1,
    alive: true,
    name: nm.name,          // display name; the civ module restyles it ("Kingdom of X")
    baseName: nm.name,
    adjective: nm.adjective,
    language,
    race,
    hue: col.hue, color: col.color, colorHex: col.colorHex,
    foundedDay: world.time.day, fallenDay: null, fallCause: null,
    parentId: opts.parentId ?? null,
    originX: opts.x ?? 0, originY: opts.y ?? 0,
    capitalId: null,
    settlementIds: [],
    government: opts.government || 'tribe',
    ruler: null,            // { name, title, epithet, born, reignStart, traits: [], dynasty }
    rulerHistory: [],
    dynasty: null,
    traits,
    tech: { known: {}, points: 0, research: null, progress: 0, era: 0 },
    mods: {},               // derived modifiers, see SPEC.md §Mods (civ module computes)
    treasury: 0, taxRate: 0.1, income: 0, expenses: 0,
    stability: 0.8, legitimacy: 0.8, warWeariness: 0, prestige: 0,
    military: { manpower: 0, strength: 0 },
    relations: {},          // { [otherCivId]: relation } — see rel()
    allies: [],
    vassalOf: null,
    stateReligion: null,
    goldenAge: 0, darkAge: 0,
    population: 0, territory: 0, wealth: 0, peakPopulation: 0, peakTerritory: 0,
    effects: [], effectsV: 0, // timed effects (core/effects.js only)
    style: null,            // architecture style (WP3 style.js)
    claims: {},             // dynastic claims { [civId]: 0..1 } (WP3)
    flags: {},
    // fields other modules add, declared here in the order they arrive so every civ keeps one
    // hidden class (undefined until set, and never saved; keep in step with CIV_SHAPE, world.js)
    culture: undefined,     // civ module (ensureCivFields), as the civ is created
    temperLog: undefined,   // temper.js (ensureTemper), as the civ is created
    arcane: undefined,      // Mythic arcana (myth/mana.js), at birth or its first monthly sample
  };
  addIndexed(world, 'civs', civ);
  invalidate(world);
  bumpVersion(world, 'civs');
  emit(world, 'civCreated', civ);
  return civ;
}

function pickCapital(world, civ) {
  let best = null;
  for (const sid of civ.settlementIds) {
    const s = world.settlements[sid];
    if (s && s.alive && (!best || s.population > best.population)) best = s;
  }
  return best ? best.id : null;
}

/** Mark a civ fallen. Any remaining settlements are destroyed; prefer transferring them first. */
export function killCiv(world, civId, cause = 'collapse') {
  const civ = world.civs[civId];
  if (!civ || !civ.alive) return;
  for (const sid of civ.settlementIds.slice()) destroySettlement(world, sid, cause, { skipCivCheck: true });
  civ.alive = false;
  civ.fallenDay = world.time.day;
  civ.fallCause = cause;
  civ.capitalId = null;
  civ.settlementIds = [];
  // a fallen nation holds no people, land or arms (its peaks and history remain)
  civ.population = 0; civ.territory = 0; civ.wealth = 0; civ.income = 0; civ.expenses = 0;
  civ.military = { ...(civ.military || {}), manpower: 0, strength: 0 };
  civ.allies = [];
  civ.vassalOf = null;
  world.armies = world.armies.filter((a) => a.civId !== civId);
  for (const other of world.civs) {
    if (other.allies.length) other.allies = other.allies.filter((id) => id !== civId);
    if (other.vassalOf === civId) other.vassalOf = null;
  }
  invalidate(world);
  bumpVersion(world, 'civs');
  emit(world, 'civDestroyed', civ, cause);
}

// ---------------------------------------------------------------------------
// Settlements

function isCoastal(world, i) {
  const { W, H, f } = world;
  const x = i % W, y = (i / W) | 0;
  for (let d = 0; d < 8; d++) {
    const nx = x + DX8[d], ny = y + DY8[d];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    if (f.water[ny * W + nx] === WATER.OCEAN) return true;
  }
  return false;
}

/**
 * Found a settlement at (x, y) for civId. Returns null if the tile is water or occupied.
 * opts: { name, population, food, race }   race defaults to the founding civ's race
 */
export function createSettlement(world, civId, x, y, opts = {}) {
  const { W, f } = world;
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= world.H) return null;
  const i = y * W + x;
  if (f.water[i] !== WATER.LAND || f.settle[i] >= 0) return null;
  const civ = world.civs[civId];
  if (!civ || !civ.alive) return null;
  let name = opts.name;
  if (!name) {
    const taken = settlementNames(world);
    for (let k = 0; k < 6; k++) { name = makePlace(civ.language, world.rng); if (!taken.has(name)) break; }
  }
  const population = opts.population ?? 100;
  const s = {
    id: -1, name, civId, originCivId: civId, alive: true,
    x, y, i,
    foundedDay: world.time.day, destroyedDay: null, destroyCause: null,
    population, peakPopulation: population, tier: tierForPop(population),
    food: opts.food ?? population * 1.5,     // stock, in person-months
    foodProd: 0, foodNeed: 0,
    wealth: 0, production: 0, tradeIncome: 0,
    housing: 0,
    health: 0.8, happiness: 0.6, unrest: 0, loyalty: 0.9, culture: 0,
    defense: 0, garrison: 0,
    buildings: {},
    religion: {}, dominantReligion: null,
    disease: null, immunity: {},
    coastal: isCoastal(world, i), harbor: false,
    siege: null, famine: 0, radius: 2,
    race: opts.race ?? civ.race ?? null,
    effects: [], effectsV: 0, // timed effects (core/effects.js only)
    traits: [],             // up to 3 specialty / trait keys (WP1 character.js only)
    epithet: null,          // earned epithet, e.g. "the Unbowed" (WP1)
    legend: null,           // founding legend { kind, text, figId? } (WP1)
    hist: { sieges: 0, held: 0, fires: 0, quakes: 0, plagues: 0, conquered: 0, riots: 0 }, // WP1 counters
    own: [],                // owner chain [[day, civId, code]] ≤ 16 (WP6)
    flags: {},
    // its people by age band and sex (core/cohorts.js): the slice the founders came with, or the
    // reference shape
    cohorts: seedCohorts(population, opts.cohorts),
    // fields other modules add, declared here in the order they arrive so every settlement keeps
    // one hidden class (undefined until set, and never saved; keep in step with SETTLEMENT_SHAPE,
    // world.js): the civ module's (ensureSettlementFields) as the town is founded, then in Mythic
    // worlds its mix of peoples (myth/peoples.js) and, a decade on, that mix's history
    project: undefined, farmland: undefined, growth: undefined, capacity: undefined,
    foodImport: undefined, emigrants: undefined, taxes: undefined, jobs: undefined,
    peoples: undefined, peoplesPast: undefined,
  };
  addIndexed(world, 'settlements', s);
  // the name set holds exactly the names of every settlement ever founded — what a reload
  // rebuilds — whoever chose the name
  settlementNames(world).add(name);
  f.settle[i] = s.id;
  civ.settlementIds.push(s.id);
  if (civ.capitalId == null) civ.capitalId = s.id;
  invalidate(world);
  bumpVersion(world, 'settlements');
  emit(world, 'settlementCreated', s);
  return s;
}

// Whole-grid passes over the owner fields, kept apart from the entity code around them so
// they stay optimised (a transfer is rare, and the function around it sees entity objects of
// every shape, which kept throwing it back to the interpreter mid-loop).
/** Tiles of settlement sid go to civId. */
function retagTiles(ownerSettle, owner, sid, civId, N) {
  for (let i = 0; i < N; i++) if (ownerSettle[i] === sid) owner[i] = civId;
}
/** Tiles of settlement sid become unowned. */
function releaseTiles(ownerSettle, owner, sid, N) {
  for (let i = 0; i < N; i++) if (ownerSettle[i] === sid) { ownerSettle[i] = -1; owner[i] = -1; }
}

/** Move a settlement to another civ (conquest, rebellion, defection, purchase). */
export function transferSettlement(world, sid, newCivId, cause = 'conquest') {
  const s = world.settlements[sid];
  const nc = world.civs[newCivId];
  if (!s || !s.alive || !nc || !nc.alive || s.civId === newCivId) return false;
  const oldId = s.civId;
  const old = world.civs[oldId];
  old.settlementIds = old.settlementIds.filter((id) => id !== sid);
  if (old.capitalId === sid) old.capitalId = pickCapital(world, old);
  s.civId = newCivId;
  s.loyalty = Math.min(s.loyalty, 0.35);
  s.unrest = Math.max(s.unrest, 0.25);
  s.siege = null;
  nc.settlementIds.push(sid);
  if (nc.capitalId == null) nc.capitalId = sid;
  retagTiles(world.f.ownerSettle, world.f.owner, sid, newCivId, world.N);
  invalidate(world);
  bumpVersion(world, 'owner');
  bumpVersion(world, 'settlements');
  emit(world, 'settlementTransferred', s, oldId, newCivId, cause);
  if (old.alive && old.settlementIds.length === 0) killCiv(world, oldId, cause);
  return true;
}

/** Destroy a settlement (razed, abandoned, swallowed by the sea, struck by a meteor…). */
export function destroySettlement(world, sid, cause = 'abandoned', opts = {}) {
  const s = world.settlements[sid];
  if (!s || !s.alive) return false;
  s.alive = false;
  s.destroyedDay = world.time.day;
  s.destroyCause = cause;
  s.siege = null;
  const f = world.f;
  if (f.settle[s.i] === sid) f.settle[s.i] = -1;
  releaseTiles(f.ownerSettle, f.owner, sid, world.N);
  const civ = world.civs[s.civId];
  if (civ) {
    civ.settlementIds = civ.settlementIds.filter((id) => id !== sid);
    if (civ.capitalId === sid) civ.capitalId = pickCapital(world, civ);
  }
  invalidate(world);
  bumpVersion(world, 'owner');
  bumpVersion(world, 'settlements');
  emit(world, 'settlementDestroyed', s, cause);
  if (!opts.skipCivCheck && civ && civ.alive && civ.settlementIds.length === 0) killCiv(world, civ.id, cause);
  return true;
}

/**
 * Apply damage to a settlement. All fractions 0..1.
 * dmg: { pop, wealth, food, defense, buildings, cause }
 * Every fraction is scaled by the ext 'damage' providers (mulOf('damage', world, s, cause),
 * neutral 1 — wards and luck in Mythic worlds); the number of rng draws never depends on it.
 * The dead are taken from the town's age bands by the cause's profile (core/cohorts.js).
 * Returns the number of people killed. Destroys the settlement if fewer than 8 remain.
 */
export function damageSettlement(world, s, dmg = {}) {
  if (!s || !s.alive) return 0;
  const dmgMul = mulOf('damage', world, s, dmg.cause ?? null);
  const sc = dmgMul === 1 ? (v) => v : (v) => v * dmgMul;
  // who dies depends on the cause: the sword takes the young men, hunger the children and the old
  const deaths = takePeople(world, s, s.population * clamp01(sc(dmg.pop || 0)), profileForCause(dmg.cause));
  if (dmg.wealth) s.wealth *= 1 - clamp01(sc(dmg.wealth));
  if (dmg.food) s.food *= 1 - clamp01(sc(dmg.food));
  if (dmg.defense) s.defense *= 1 - clamp01(sc(dmg.defense));
  if (dmg.buildings) {
    let lost = false;
    const pb = clamp01(sc(dmg.buildings));
    for (const k of Object.keys(s.buildings)) {
      if (world.rng.chance(pb)) {
        s.buildings[k] = Math.max(0, (s.buildings[k] || 0) - 1);
        if (!s.buildings[k]) delete s.buildings[k];
        lost = true;
      }
    }
    // buildings revision: the civ module caches building levels by it (a stale cache
    // would also make a saved-and-reloaded world diverge from the uninterrupted one)
    if (lost && s.flags) s.flags.brev = (s.flags.brev | 0) + 1;
  }
  s.tier = tierForPop(s.population);
  if (s.population < 8) destroySettlement(world, s.id, dmg.cause || 'ruin');
  return deaths;
}

// ---------------------------------------------------------------------------
// Queries (cached; caches invalidate on create/transfer/destroy)

function invalidate(world) {
  world.cache.liveCivs = null;
  world.cache.liveSettlements = null;
  world.cache.settleGrid = null;
}

function settlementNames(world) {
  if (!world.cache.settleNames) world.cache.settleNames = new Set(world.settlements.map((s) => s.name));
  return world.cache.settleNames;
}

export function liveCivs(world) {
  return (world.cache.liveCivs ||= world.civs.filter((c) => c.alive));
}
export function liveSettlements(world) {
  return (world.cache.liveSettlements ||= world.settlements.filter((s) => s.alive));
}
export const getCiv = (world, id) => (id == null || id < 0 ? null : world.civs[id] || null);
export const getSettlement = (world, id) => (id == null || id < 0 ? null : world.settlements[id] || null);
export function settlementAt(world, i) {
  const sid = world.f.settle[i];
  return sid >= 0 ? world.settlements[sid] : null;
}
export function civSettlements(world, civ) {
  return civ.settlementIds.map((id) => world.settlements[id]).filter((s) => s && s.alive);
}

const BUCKET = 8;
function settleGrid(world) {
  if (world.cache.settleGrid) return world.cache.settleGrid;
  const bw = Math.ceil(world.W / BUCKET), bh = Math.ceil(world.H / BUCKET);
  const cells = Array.from({ length: bw * bh }, () => []);
  for (const s of liveSettlements(world)) cells[((s.y / BUCKET) | 0) * bw + ((s.x / BUCKET) | 0)].push(s);
  return (world.cache.settleGrid = { bw, bh, cells });
}

/** Live settlements within radius r of (x, y), optionally filtered. */
export function settlementsNear(world, x, y, r, filter = null) {
  const g = settleGrid(world);
  const out = [];
  const x0 = Math.max(0, ((x - r) / BUCKET) | 0), x1 = Math.min(g.bw - 1, ((x + r) / BUCKET) | 0);
  const y0 = Math.max(0, ((y - r) / BUCKET) | 0), y1 = Math.min(g.bh - 1, ((y + r) / BUCKET) | 0);
  const r2 = r * r;
  for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) {
    for (const s of g.cells[by * g.bw + bx]) {
      const dx = s.x - x, dy = s.y - y;
      if (dx * dx + dy * dy <= r2 && (!filter || filter(s))) out.push(s);
    }
  }
  return out;
}

/** Nearest live settlement to (x, y). opts: { maxDist, civId, filter } */
export function nearestSettlement(world, x, y, opts = {}) {
  const maxDist = opts.maxDist ?? Infinity;
  let best = null, bd = maxDist * maxDist;
  const list = Number.isFinite(maxDist) ? settlementsNear(world, x, y, maxDist) : liveSettlements(world);
  for (const s of list) {
    if (opts.civId != null && s.civId !== opts.civId) continue;
    if (opts.filter && !opts.filter(s)) continue;
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d <= bd) { bd = d; best = s; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Relations & wars

/**
 * Civ a's view of civ b (created on first access).
 * { opinion -100..100, trust 0..1, contactDay, tension 0..1, trade (monthly value),
 *   lastWarDay, truceUntil (day), treaties: string[] ('nap'|'alliance'|'trade'|'vassal'|'tribute') }
 */
export function rel(world, a, b) {
  const ca = world.civs[a];
  let r = ca.relations[b];
  if (!r) r = ca.relations[b] = { opinion: 0, trust: 0.5, contactDay: world.time.day, tension: 0, trade: 0, lastWarDay: -1, truceUntil: -1, treaties: [] };
  return r;
}
export const hasContact = (world, a, b) => Boolean(world.civs[a]?.relations[b]);
export function addOpinion(world, a, b, delta, mutual = true) {
  const r = rel(world, a, b);
  r.opinion = Math.max(-100, Math.min(100, r.opinion + delta));
  if (mutual) {
    const r2 = rel(world, b, a);
    r2.opinion = Math.max(-100, Math.min(100, r2.opinion + delta));
  }
}

/**
 * The active wars in id order (shared: never mutate). world.wars only grows, so queries never
 * scan it: a war turns active only in startWar and inactive only in endWar, and both bump
 * versions.wars, so the list is cached on that version. Membership (attackers / defenders) is
 * read live from the war objects.
 */
function activeWarIdx(world) {
  const v = world.versions.wars || 0;
  const c = world.cache;
  if (c.activeWarsV === v && c.activeWars) return c.activeWars;
  const list = [];
  for (const w of world.wars) if (w.active) list.push(w);
  c.activeWars = list; c.activeWarsV = v;
  return list;
}
function warPairs(world) {
  const v = world.versions.wars || 0;
  if (world.cache.warPairsV === v && world.cache.warPairs) return world.cache.warPairs;
  const set = new Set();
  for (const w of activeWarIdx(world)) {
    if (!w.active) continue;
    for (const a of w.attackers) for (const d of w.defenders) { set.add(a * 4096 + d); set.add(d * 4096 + a); }
  }
  world.cache.warPairs = set; world.cache.warPairsV = v;
  return set;
}
export const areAtWar = (world, a, b) => a !== b && warPairs(world).has(a * 4096 + b);
export function enemiesOf(world, civId) {
  const out = new Set();
  for (const w of activeWarIdx(world)) {
    if (!w.active) continue;
    if (w.attackers.includes(civId)) w.defenders.forEach((d) => out.add(d));
    else if (w.defenders.includes(civId)) w.attackers.forEach((a) => out.add(a));
  }
  return [...out];
}
/** Active wars in id order (a fresh array the caller may keep or edit). */
export const activeWars = (world) => activeWarIdx(world).filter((w) => w.active);

/**
 * Begin a war. The caller writes the chronicle entry. Returns the war object.
 * war: { id, name, attackers, defenders, startDay, endDay, active, cause, warScore (-100..100, + favours attackers),
 *        battles, casualties: {civId: n}, captured: [sid], outcome }
 */
export function startWar(world, attackers, defenders, cause = 'conquest', name = null) {
  const a0 = world.civs[attackers[0]], d0 = world.civs[defenders[0]];
  const war = {
    id: -1,
    name: name || `${a0?.adjective || 'Unknown'}–${d0?.adjective || 'Unknown'} War`,
    attackers: attackers.slice(), defenders: defenders.slice(),
    startDay: world.time.day, endDay: null, active: true,
    cause, warScore: 0, battles: 0, casualties: {}, captured: [], outcome: null,
  };
  addIndexed(world, 'wars', war);
  for (const a of attackers) for (const d of defenders) { rel(world, a, d).lastWarDay = world.time.day; rel(world, d, a).lastWarDay = world.time.day; }
  bumpVersion(world, 'wars');
  emit(world, 'warStarted', war);
  return war;
}

/** End a war. outcome: 'attackers' | 'defenders' | 'white_peace' | 'annihilation' | string. Sets truces. */
export function endWar(world, warId, outcome = 'white_peace', truceYears = 12) {
  const war = world.wars[warId];
  if (!war || !war.active) return;
  war.active = false;
  war.endDay = world.time.day;
  war.outcome = outcome;
  const until = world.time.day + truceYears * DAYS_PER_YEAR;
  for (const a of war.attackers) for (const d of war.defenders) {
    if (world.civs[a] && world.civs[d]) { rel(world, a, d).truceUntil = until; rel(world, d, a).truceUntil = until; }
  }
  for (const army of world.armies) if (army.warId === warId) { army.warId = null; army.targetId = null; army.state = 'returning'; army.path = null; }
  bumpVersion(world, 'wars');
  emit(world, 'warEnded', war);
}

// ---------------------------------------------------------------------------
// Armies

/**
 * props: { civId, x, y, homeId, strength, warId, targetId, general }
 * army.flags (JSON): loss { battle, attrition, plague, band, beast } is kept by damageArmy;
 * hunt / merc = bandId (WP2), genId, divineGoal / goalUntil, l (WP4). Merge into flags
 * (Object.assign) rather than replacing it once damage may have been recorded.
 */
export function createArmy(world, props) {
  const army = {
    id: -1, civId: props.civId, warId: props.warId ?? null,
    x: props.x, y: props.y, homeId: props.homeId ?? null, targetId: props.targetId ?? null,
    strength: props.strength ?? 100, morale: props.morale ?? 1, supply: 1,
    path: null, pathStep: 0, state: props.state || 'idle', naval: false,
    general: props.general ?? null, createdDay: world.time.day, flags: {},
  };
  return addEntity(world, 'armies', army, 'army');
}
export const removeArmy = (world, id) => removeEntity(world, 'armies', id);

const LOSS_SOURCES = ['battle', 'attrition', 'plague', 'band', 'beast'];
/**
 * Remove n soldiers from an army (clamped to its strength) and add them to
 * army.flags.loss[src] (src: 'battle' | 'attrition' | 'plague' | 'band' | 'beast').
 * Never removes the army — war code removes empty armies. Returns the loss applied.
 */
export function damageArmy(world, army, n, src = 'battle') {
  if (!army) return 0;
  const cur = Number.isFinite(army.strength) ? Math.max(0, army.strength) : 0;
  const want = Number(n);
  if (!Number.isFinite(want) || want <= 0) return 0;
  const d = Math.min(cur, want);
  army.strength = cur - d;
  const fl = army.flags && typeof army.flags === 'object' ? army.flags : (army.flags = {});
  let loss = fl.loss;
  if (!loss || typeof loss !== 'object') { loss = fl.loss = {}; for (const k of LOSS_SOURCES) loss[k] = 0; }
  const key = src || 'battle';
  loss[key] = (Number.isFinite(loss[key]) ? loss[key] : 0) + d;
  return d;
}

// ---------------------------------------------------------------------------
// Figures (great people)

const MAX_FIGURES = 1500;

/** props: { name, kind: 'ruler'|'general'|'prophet'|'scholar'|'artist'|'explorer'|'merchant'|'hero', civId, sid, born, deeds } */
export function addFigure(world, props) {
  const fig = { id: -1, died: null, deeds: [], ...props };
  addEntity(world, 'figures', fig, 'figure');
  while (world.figures.length > MAX_FIGURES) evictFigure(world);
  return fig;
}

/**
 * Over the cap, forget the least memorable figure: first a dead general with no deeds (the
 * oldest such), then the figure dead longest; never the prophet of a living faith. If every
 * figure still lives, the oldest unprotected one goes (as before the expansion).
 */
function evictFigure(world) {
  const figs = world.figures;
  const prophets = new Set();
  for (const r of world.religions) if (r && r.alive !== false && r.prophetId != null) prophets.add(r.prophetId);
  let general = -1, dead = -1, deadDay = Infinity, any = -1;
  for (let k = 0; k < figs.length - 1; k++) { // never the figure just added
    const f = figs[k];
    if (prophets.has(f.id)) continue;
    if (any < 0) any = k;
    if (f.died == null) continue;
    if (general < 0 && f.kind === 'general' && !(f.deeds && f.deeds.length)) general = k;
    const dd = Number.isFinite(f.died) ? f.died : -Infinity;
    if (dd < deadDay) { deadDay = dd; dead = k; }
  }
  const k = general >= 0 ? general : dead >= 0 ? dead : any >= 0 ? any : 0;
  figs.splice(k, 1);
}

export const yearsSince = (world, day) => (world.time.day - day) / DAYS_PER_YEAR;
