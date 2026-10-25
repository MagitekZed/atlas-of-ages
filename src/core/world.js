// The World: one plain object holding every piece of simulation state.
//   world.f.*      typed-array fields, one value per tile (index i = y * W + x)
//   world.<lists>  entity arrays (civs, settlements, armies, ...)
//   world.cache    transient derived data, never saved (rebuild lazily or in system.init)
//   world.fx       transient visual-effect queue drained by the renderer, never saved
//   world.interventions  the log of every user act (tools, logged params) — see logIntervention
//   world.ui       viewer state (watch list, pins, patron): saved, never read by the sim, kept
//                  as-is across keyframe restores
// Everything else must stay JSON-serialisable (see serialize.js). normalizeWorld() fills every
// default, so old saves gain new fields without changing what they already hold.

import { RNG } from './rng.js';
import { createLanguage, makePlace } from './names.js';
import { MAP_SIZES, DAYS_PER_MONTH, DAYS_PER_YEAR, MONTHS_PER_YEAR, MONTH_NAMES, MONTH_SEASON, SEASONS, WATER } from './constants.js';
import { defaultParams, coerceParam, PARAM_BY_KEY, PARAMS, mythLevel, mythOn } from './params.js';
import { emit } from './hooks.js';

export { mythLevel, mythOn };

/** [name, TypedArray constructor, initial value]. See SPEC.md §Fields for owners and units. */
export const FIELD_DEFS = [
  // terrain & hydrology (gen; terraform/disasters may edit elevation)
  ['elevation', Float32Array, 0],
  ['plate', Uint8Array, 0],
  ['plateBoundary', Float32Array, 0],
  ['water', Uint8Array, 0],
  ['coast', Uint8Array, 0],
  ['distCoast', Uint16Array, 0],
  ['landmass', Int32Array, -1],
  ['flowDir', Int32Array, -1],
  ['flow', Float32Array, 0],
  ['river', Uint8Array, 0],
  ['mineral', Float32Array, 0],
  ['resource', Uint8Array, 0],
  ['resourceAmt', Float32Array, 0],
  // climate & weather
  ['baseTemp', Float32Array, 0],
  ['temp', Float32Array, 0],
  ['annTemp', Float32Array, 0],
  ['baseMoisture', Float32Array, 0],
  ['rain', Float32Array, 0],
  ['annRain', Float32Array, 0],
  ['soilWater', Float32Array, 0],
  ['humidity', Float32Array, 0],
  ['cloud', Float32Array, 0],
  ['snow', Float32Array, 0],
  ['windX', Float32Array, 0],
  ['windY', Float32Array, 0],
  ['biome', Uint8Array, 0],
  // ecology
  ['soil', Float32Array, 0],
  ['veg', Float32Array, 0],
  ['vegCap', Float32Array, 0],
  ['fire', Float32Array, 0],
  ['burnScar', Float32Array, 0],
  ['herb', Float32Array, 0],
  ['pred', Float32Array, 0],
  ['fish', Float32Array, 0],
  // human
  ['owner', Int16Array, -1],
  ['ownerSettle', Int32Array, -1],
  ['settle', Int32Array, -1],
  ['farm', Float32Array, 0],
  ['road', Uint8Array, 0],
  ['popDensity', Float32Array, 0],
  ['devastation', Float32Array, 0],
  ['pollution', Float32Array, 0],
];

/** Create an empty world (fields allocated, no terrain). Call generateWorld() next. */
export function createWorld(paramsIn = {}) {
  const params = { ...defaultParams(), ...paramsIn };
  for (const k of Object.keys(params)) params[k] = coerceParam(k, params[k]);
  const size = MAP_SIZES[paramsIn.worldSize === 'preview' ? 'preview' : params.worldSize] || MAP_SIZES.medium;
  if (paramsIn.worldSize === 'preview') params.worldSize = 'preview';
  const W = size.w, H = size.h, N = W * H;
  const seed = String(params.seed ?? 'atlas');
  const rng = new RNG(seed);

  const f = {};
  for (const [name, Type, init] of FIELD_DEFS) {
    const a = new Type(N);
    if (init !== 0) a.fill(init);
    f[name] = a;
  }

  const lang = createLanguage(rng.fork('world-language'));
  // the generated name is always drawn (so a chosen worldName never shifts the rng stream)
  const genName = makePlace(lang, rng.fork('world-name'));
  const world = {
    version: 1,
    seed,
    name: typeof params.worldName === 'string' && params.worldName ? params.worldName : genName,
    params,
    genesisParams: { ...params },
    W, H, N,
    time: { day: 0 },
    rng,
    lang,
    f,
    // entities
    civs: [],          // index = id; never removed (alive flag)
    settlements: [],   // index = id; never removed (alive flag)
    religions: [],     // index = id
    plagues: [],       // index = id
    wars: [],          // index = id
    armies: [],        // transient units; removed when disbanded (ids from nextId)
    caravans: [],
    tradeRoutes: [],   // index = id; inactive routes keep active=false
    storms: [],
    volcanoes: [],
    fires: [],
    figures: [],
    wonders: [],
    features: [],      // named geography for map labels
    bands: [],         // roaming bands and beasts (core/bands.js; WP2 runs them)
    sites: [],         // historic sites (core/sites.js API only)
    interventions: [], // log of user acts, replayed by undo / rewind (core/tools.js, setParam)
    ui: defaultUi(),   // viewer state; the sim never reads it
    nextId: { army: 1, caravan: 1, storm: 1, fire: 1, figure: 1, misc: 1, band: 1, site: 1 },
    climate: {
      seaLevel: 0.5, baseSeaLevel: 0.5, appliedSeaLevel: 0.5,
      tempOffset: 0, drift: 0, aerosol: 0, co2: 280,
      iceVolume: 0, iceBaseline: 0, avgTemp: 0, avgLandTemp: 0, droughtIndex: 0,
    },
    chronicle: { seq: 0, entries: [] },
    history: { years: [], atlas: [] },
    pending: {},       // small JSON flags shared between systems (e.g. hydrology dirty)
    sys: {},           // per-system persistent state: world.sys[systemId] = {...} (JSON only)
    versions: { terrain: 1, water: 1, biome: 1, owner: 1, settlements: 1, roads: 1, civs: 1, wars: 1, features: 1, load: 1, sites: 1, bands: 1, effects: 1, ext: 1 },
    stats: {},         // last computed summary numbers (JSON)
    cache: {},
    fx: [],
  };
  normalizeWorld(world);
  return world;
}

/** Viewer state saved with the world (WP8). The sim never reads it. */
export function defaultUi() {
  return { watch: [], pins: [], patron: null, lineage: [] };
}

const SETTLEMENT_HIST = ['sieges', 'held', 'fires', 'quakes', 'plagues', 'conquered', 'riots'];
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
function maxId(list) { let m = 0; for (const o of list) if (o && Number.isFinite(o.id) && o.id > m) m = o.id; return m; }

// Hidden classes. createCiv and createSettlement (core/entities.js) declare every field of the
// record, the late ones undefined until another module sets them, so new records share one V8
// hidden class and the code that walks them stays monomorphic. A record from a save (or a
// keyframe) lacks the fields that were undefined when it was saved; normalizeWorld rebuilds it
// through these literals — the same keys in the same order, hence the same class — but only
// when its keys are a prefix of that order, so its saved key order and the place of every field
// set later stay exactly what they were (undefined is never saved). Keep in step with entities.js.
const CIV_SHAPE = (c) => ({
  id: c.id, alive: c.alive, name: c.name, baseName: c.baseName, adjective: c.adjective, language: c.language, race: c.race,
  hue: c.hue, color: c.color, colorHex: c.colorHex, foundedDay: c.foundedDay, fallenDay: c.fallenDay, fallCause: c.fallCause,
  parentId: c.parentId, originX: c.originX, originY: c.originY, capitalId: c.capitalId, settlementIds: c.settlementIds,
  government: c.government, ruler: c.ruler, rulerHistory: c.rulerHistory, dynasty: c.dynasty, traits: c.traits, tech: c.tech,
  mods: c.mods, treasury: c.treasury, taxRate: c.taxRate, income: c.income, expenses: c.expenses,
  stability: c.stability, legitimacy: c.legitimacy, warWeariness: c.warWeariness, prestige: c.prestige, military: c.military,
  relations: c.relations, allies: c.allies, vassalOf: c.vassalOf, stateReligion: c.stateReligion, goldenAge: c.goldenAge,
  darkAge: c.darkAge, population: c.population, territory: c.territory, wealth: c.wealth, peakPopulation: c.peakPopulation,
  peakTerritory: c.peakTerritory, effects: c.effects, effectsV: c.effectsV, style: c.style, claims: c.claims, flags: c.flags,
  culture: c.culture, temperLog: c.temperLog, arcane: c.arcane,
});
const SETTLEMENT_SHAPE = (s) => ({
  id: s.id, name: s.name, civId: s.civId, originCivId: s.originCivId, alive: s.alive, x: s.x, y: s.y, i: s.i,
  foundedDay: s.foundedDay, destroyedDay: s.destroyedDay, destroyCause: s.destroyCause,
  population: s.population, peakPopulation: s.peakPopulation, tier: s.tier, food: s.food, foodProd: s.foodProd, foodNeed: s.foodNeed,
  wealth: s.wealth, production: s.production, tradeIncome: s.tradeIncome, housing: s.housing,
  health: s.health, happiness: s.happiness, unrest: s.unrest, loyalty: s.loyalty, culture: s.culture,
  defense: s.defense, garrison: s.garrison, buildings: s.buildings, religion: s.religion, dominantReligion: s.dominantReligion,
  disease: s.disease, immunity: s.immunity, coastal: s.coastal, harbor: s.harbor, siege: s.siege, famine: s.famine, radius: s.radius,
  race: s.race, effects: s.effects, effectsV: s.effectsV, traits: s.traits, epithet: s.epithet, legend: s.legend,
  hist: s.hist, own: s.own, flags: s.flags, cohorts: s.cohorts,
  project: s.project, farmland: s.farmland, growth: s.growth, capacity: s.capacity,
  foodImport: s.foodImport, emigrants: s.emigrants, taxes: s.taxes,
  peoples: s.peoples, peoplesPast: s.peoplesPast,
});
const CIV_KEYS = Object.keys(CIV_SHAPE({})), SETTLEMENT_KEYS = Object.keys(SETTLEMENT_SHAPE({}));
/** rec through shape when its own keys are a prefix of keys, else rec itself. */
function reshape(rec, keys, shape) {
  const ks = Object.keys(rec);
  if (ks.length > keys.length) return rec;
  for (let j = 0; j < ks.length; j++) if (ks[j] !== keys[j]) return rec;
  return shape(rec);
}

/**
 * Fill every kernel default (docs/design/expansion-contracts.md §3) without touching values that are
 * already present. Idempotent; never draws rng. Called by createWorld, deserializeWorld and
 * restoreKeyframe, so an old save gains the new fields and plays on unchanged.
 */
export function normalizeWorld(world) {
  // params added since the world was made take their (neutral) defaults
  world.params = obj(world.params);
  world.genesisParams = obj(world.genesisParams);
  for (const p of PARAMS) {
    if (!(p.key in world.params)) world.params[p.key] = p.default;
    if (!(p.key in world.genesisParams)) world.genesisParams[p.key] = p.default;
  }
  world.bands = arr(world.bands);
  world.sites = arr(world.sites);
  world.interventions = arr(world.interventions);
  const ui = (world.ui = obj(world.ui));
  ui.watch = arr(ui.watch);
  ui.pins = arr(ui.pins);
  if (!('patron' in ui)) ui.patron = null;
  ui.lineage = arr(ui.lineage);
  const nid = (world.nextId = obj(world.nextId));
  for (const k of ['army', 'caravan', 'storm', 'fire', 'figure', 'misc']) if (!Number.isFinite(nid[k])) nid[k] = 1;
  if (!Number.isFinite(nid.band)) nid.band = maxId(world.bands) + 1;
  if (!Number.isFinite(nid.site)) nid.site = maxId(world.sites) + 1;
  const v = (world.versions = obj(world.versions));
  for (const k of ['sites', 'bands', 'effects', 'ext']) if (!Number.isFinite(v[k])) v[k] = 1;
  world.chronicle = obj(world.chronicle);
  if (!Number.isFinite(world.chronicle.seq)) world.chronicle.seq = 0;
  world.chronicle.entries = arr(world.chronicle.entries);
  world.history = obj(world.history);
  world.history.years = arr(world.history.years);
  world.history.atlas = arr(world.history.atlas);
  // WP6's ledger and catalogue shapes, so a world restored without the stats system still has what the UI reads
  if (!world.history.series || typeof world.history.series !== 'object' || Array.isArray(world.history.series)) world.history.series = {};
  for (const k of ['s', 'c', 'r', 'w', 'p', 'a', 'b']) if (!world.history.series[k] || typeof world.history.series[k] !== 'object') world.history.series[k] = {};
  world.history.events = arr(world.history.events);
  world.pending = obj(world.pending);
  world.sys = obj(world.sys);
  world.stats = obj(world.stats);
  if (!world.cache || typeof world.cache !== 'object') world.cache = {};
  if (!Array.isArray(world.fx)) world.fx = [];
  const civs = arr(world.civs), settlements = arr(world.settlements);
  for (let n = 0; n < civs.length; n++) {
    const c = civs[n];
    if (!c) continue;
    if (!('race' in c)) c.race = null;
    if (!Array.isArray(c.effects)) c.effects = [];
    if (!Number.isFinite(c.effectsV)) c.effectsV = 0;
    if (!('style' in c)) c.style = null;
    if (!c.claims || typeof c.claims !== 'object') c.claims = {};
    civs[n] = reshape(c, CIV_KEYS, CIV_SHAPE);
  }
  for (let n = 0; n < settlements.length; n++) {
    const s = settlements[n];
    if (!s) continue;
    if (!('race' in s)) s.race = null;
    if (!Array.isArray(s.effects)) s.effects = [];
    if (!Number.isFinite(s.effectsV)) s.effectsV = 0;
    if (!Array.isArray(s.traits)) s.traits = [];
    if (!('epithet' in s)) s.epithet = null;
    if (!('legend' in s)) s.legend = null;
    const h = (s.hist = obj(s.hist));
    for (const k of SETTLEMENT_HIST) if (!Number.isFinite(h[k])) h[k] = 0;
    if (!Array.isArray(s.own)) s.own = [];
    settlements[n] = reshape(s, SETTLEMENT_KEYS, SETTLEMENT_SHAPE);
  }
  return world;
}

/** Allocate an extra typed-array field (e.g. a coarse weather grid). Idempotent; survives save/load. */
export function ensureField(world, name, Type = Float32Array, length = world.N, init = 0) {
  const cur = world.f[name];
  if (cur && cur.length === length && cur instanceof Type) return cur;
  const a = new Type(length);
  if (init !== 0) a.fill(init);
  world.f[name] = a;
  return a;
}

// ---------------------------------------------------------------------------
// Indexing & geometry

export const idx = (world, x, y) => y * world.W + x;
export const xOf = (world, i) => i % world.W;
export const yOf = (world, i) => (i / world.W) | 0;
export const inBounds = (world, x, y) => x >= 0 && y >= 0 && x < world.W && y < world.H;
/** Latitude in [-1, 1]: +1 at the north pole (y = 0), -1 at the south pole. */
export const latitude = (world, y) => 1 - (2 * (y + 0.5)) / world.H;
export const isWater = (world, i) => world.f.water[i] !== WATER.LAND;
export const isLand = (world, i) => world.f.water[i] === WATER.LAND;
export const isOcean = (world, i) => world.f.water[i] === WATER.OCEAN;

/** Elevation in metres relative to current sea level (negative = depth). */
export function elevationMeters(world, i) {
  const e = world.f.elevation[i];
  const s = world.climate.seaLevel;
  return e >= s ? ((e - s) / Math.max(1e-6, 1 - s)) * 7000 : -((s - e) / Math.max(1e-6, s)) * 8000;
}

// ---------------------------------------------------------------------------
// Calendar

export const yearOf = (world) => Math.floor(world.time.day / DAYS_PER_YEAR);
export const monthOf = (world) => Math.floor(world.time.day / DAYS_PER_MONTH) % MONTHS_PER_YEAR;
export const dayOfYear = (world) => world.time.day % DAYS_PER_YEAR;
export const dayOfMonth = (world) => world.time.day % DAYS_PER_MONTH;
export const isMonthStart = (world) => world.time.day % DAYS_PER_MONTH === 0;
export const isYearStart = (world) => world.time.day % DAYS_PER_YEAR === 0;
/** True once every n days, at the given phase offset (spread load between systems). */
export const everyDays = (world, n, offset = 0) => (world.time.day + offset) % n === 0;
/** Row-stripe helper: process rows y ≡ stripeRow (mod K) today; each row is visited every K days. */
export const stripeRow = (world, K, offset = 0) => (world.time.day + offset) % K;
/** Season index (0 Winter … 3 Autumn) for a row, accounting for hemisphere. */
export function seasonAt(world, y) {
  const s = MONTH_SEASON[monthOf(world)];
  return latitude(world, y) >= 0 ? s : (s + 2) % 4;
}
/** Phase of the year in [0, 1): 0 = northern midwinter, 0.5 = northern midsummer. */
export const yearPhase = (world) => ((world.time.day + 15) % DAYS_PER_YEAR) / DAYS_PER_YEAR;

export function dateString(world, day = world.time.day) {
  const y = Math.floor(day / DAYS_PER_YEAR);
  const m = Math.floor(day / DAYS_PER_MONTH) % MONTHS_PER_YEAR;
  return `${MONTH_NAMES[m]} ${(day % DAYS_PER_MONTH) + 1}, Year ${y}`;
}
export const yearString = (day) => `Year ${Math.floor(day / DAYS_PER_YEAR)}`;
export const seasonName = (world, y = 0) => SEASONS[seasonAt(world, y)];

// ---------------------------------------------------------------------------
// Params, versions, fx

/**
 * Change a parameter (validated). Returns the stored value.
 * opts.force — also allow a non-live param (genesis-only params are refused otherwise and the
 *              current value is returned unchanged). The Awaken Magic act uses
 *              setParam(world, 'mythLevel', 2, { force: true, log: true }); a bare call like it
 *              wakes the myth at once too (the paramChanged hook), with the old peoples human.
 * opts.log   — record a 'param' intervention (every user change of a param should log, so undo
 *              and rewind can replay it). Nested inside a logged tool apply it is not logged
 *              again: the tool's own entry replays it.
 */
export function setParam(world, key, value, opts = {}) {
  const p = PARAM_BY_KEY[key];
  if (p && !p.live && !opts.force) return world.params[key];
  const v = coerceParam(key, value);
  const prev = world.params[key];
  const changed = prev !== v;
  world.params[key] = v;
  world.versions.params = (world.versions.params || 0) + 1;
  if (opts.log && changed) logIntervention(world, { kind: 'param', id: key, key, value: v, ...(p && !p.live ? { force: true } : {}) });
  if (changed) emit(world, 'paramChanged', key, v, prev);
  return v;
}
export const isLiveParam = (key) => Boolean(PARAM_BY_KEY[key]?.live);

// ---------------------------------------------------------------------------
// Interventions: the log of user acts (docs/design/expansion-contracts.md §11)
//
// intervention = { seq (index in the log), day, kind: 'tool'|'finish'|'pair'|'entity'|'param',
//                  id, x?, y?, opts?, pts?, a?, b?, target?, args?, key?, value?, refused? }
// pts: the further points of one brush stroke on one day (core/tools.js joins the ticks);
// refused: true when the world refused the apply (an undo replay leaves those out after the
// undone act, core/replay.js).
// The kernel appends one on every apply (core/tools.js) and on setParam(..., { log: true }),
// unless world.cache.replaying is set, the call passed opts.log === false, or it is nested
// inside another logged apply (world.cache.ivDepth > 0). day is world.time.day at the call;
// on replay the entry is applied before that day's sim.step (core/replay.js).

/** True when a kernel apply happening now should be logged. */
export function canLogIntervention(world) {
  const c = world.cache;
  return !(c && (c.replaying || c.ivDepth > 0));
}

/**
 * Append an intervention (fields as above; seq and day are assigned here). force: log even
 * while replaying (replay re-logs what it applies). Returns the entry, or null if not logged.
 */
export function logIntervention(world, iv, force = false) {
  if (!force && !canLogIntervention(world)) return null;
  const log = (world.interventions ||= []);
  const entry = { seq: log.length, day: world.time.day, ...iv };
  entry.seq = log.length;
  entry.day = world.time.day;
  log.push(entry);
  return entry;
}

export function bumpVersion(world, key) {
  world.versions[key] = (world.versions[key] || 0) + 1;
}

const FX_CAP = 400;
/**
 * Queue a transient visual effect for the renderer. Never affects simulation.
 * fx: { type, x, y, r?, civId?, intensity?, text?, color?, x2?, y2?, tone?, sign?, glyph?,
 *       size?, src? } — see SPEC.md §6.5 for types. src: 'tool' marks an effect a god tool
 *       caused: never time-scaled, priority 10, gets an off-screen pointer.
 */
export function emitFx(world, fx) {
  fx.day = world.time.day;
  world.fx.push(fx);
  // batched truncation: nothing drains the queue headless, so trim rarely (amortised O(1))
  if (world.fx.length > 2 * FX_CAP) world.fx.splice(0, world.fx.length - FX_CAP);
}
