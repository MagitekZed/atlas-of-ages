// Extension points: the second coupling channel after hooks (SPEC §1). An owner module asks a
// question at a fixed call site — "how habitable is tile i for this race?", "how much does
// fate multiply quake rates?" — and every registered provider answers. The helpers combine
// the answers and clamp them to the point's range, so no single provider can run away.
//
//   registerProvider(point, id, fn)   re-registering an id replaces it. Providers run in id
//                                     order, so the answer never depends on import order.
//   mulOf(point, w, a, b, c, d)       product of answers, default 1, clamped
//   sumOf(point, w, a, b, c, d)       sum of answers, default 0, clamped
//   firstOf(point, w, a, b, c, d)     first non-null answer (in id order), default null
//   anyOf(point, w, a, b, c, d)       true if any provider answers truthy, default false
//   concatOf(point, w, a, b, c, d)    answers concatenated (arrays are spread), default []
//   mulEachOf(point, w, a, b, c, d)   per-key product for object answers ({birth, mortality})
//   mergeOf(point, w, a, b, c, d)     { [providerId]: answer } for non-null answers, or null
//
// Providers are pure: no world.rng, no mutation, cheap (some points are asked per tile).
// They must return a neutral value (1 for mul, 0 for sum, null otherwise) when their feature
// is off — at mythLevel 0 every myth provider is neutral. A provider that throws counts as
// neutral (the error is logged a few times).
//
// Code registries (registerModKeys, registerTechs, registerBuildings, registerWonders) let
// packages add game data owned by another module; each registration bumps extVersion() so the
// owner can re-merge lazily. extVersion() is a process-local counter: fold it into caches kept
// in world.cache, never into saved state (a save must not depend on which modules loaded).

/**
 * Points and their combine rules. clamp applies to the combined value (mul / sum / mulEach).
 * See docs/design/expansion-contracts.md §7 for callers and providers.
 */
export const EXT_POINTS = {
  habitat: { combine: 'mul', clamp: [0, 4], sig: '(w, race|null, i)' },
  siteBonus: { combine: 'sum', clamp: [-0.5, 0.5], sig: '(w, civ, i)' },
  settleName: { combine: 'first', sig: '(w, civ, i) → string|null' },
  people: { combine: 'first', sig: '(w, {genesis, k?, i?, parentCivId?}) → {race, traits?, languageStyle?}|null' },
  demography: { combine: 'mulEach', keys: ['birth', 'mortality'], clamp: [0.3, 3], sig: '(w, s, civ) → {birth?, mortality?}' },
  lifespan: { combine: 'mul', clamp: [0.2, 8], sig: '(w, civ, person) → age divisor' },
  sickness: { combine: 'mul', clamp: [0.1, 4], sig: '(w, civ, person) → × a ruler’s chance of falling into a lasting illness (civ/rulers.js)' },
  cohortRule: { combine: 'first', sig: '(w, key, civ) → 34 weights (levy, movers, frail, violent, all, fertility, mortality, work) | number (pairK) | null' },
  strife: { combine: 'first', sig: "(w, people, civ) → { k: extra deaths a year at a whole town of that people, who: 'youngMen' | 'adults' | 'all' | 34 weights } | null (in-fighting, core/cohorts.js)" },
  peopleRates: { combine: 'first', sig: '(w, people, s|null) → { birth, mortality, life } | null (each people’s age bands in town s, core/cohorts.js)' },
  magicJobs: { combine: 'first', sig: '(w, s, civ) → 4 shares of the working hands (mages, healers, artificers, beast-keepers) | null (sim/civ/jobs.js)' },
  townHealth: { combine: 'sum', clamp: [-0.3, 0.12], sig: '(w, s, civ) → added to the town’s health' },
  townOutput: { combine: 'mulEach', keys: ['production', 'defense'], clamp: [0.8, 1.25], sig: '(w, s, civ) → {production?, defense?}' },
  researchMul: { combine: 'mul', clamp: [0.8, 1.25], sig: '(w, civ, techId) → × research on that tech' },
  taming: { combine: 'mul', clamp: [0.5, 2], sig: '(w, civ, s) → × the odds that the beast-masters of s bind a beast' },
  jobRule: { combine: 'first', sig: "(w, 'mix', civ, era) → 6 shares of the leftover hands (craftsmen, merchants, clergy, scholars, builders, labourers) | null" },
  mods: { combine: 'concat', sig: '(w, civ) → partial mods (applyFx)' },
  loyalty: { combine: 'sum', clamp: [-0.3, 0.3], sig: '(w, s, civ)' },
  nameStyle: { combine: 'first', sig: '(w, civ, govKey) → {styles?, titles?}|null' },
  archStyle: { combine: 'first', sig: '(w, civ) → partial style|null' },
  heroTarget: { combine: 'first', sig: '(w, civ, s) → {name, bandId?}|null' },
  battle: { combine: 'mul', clamp: [0.5, 1.6], sig: '(w, {army, enemy, i, side})' },
  siege: { combine: 'mul', clamp: [0.5, 1.5], sig: '(w, {army, s})' },
  opinion: { combine: 'sum', clamp: [-40, 40], sig: '(w, a, b)' },
  allied: { combine: 'any', sig: '(w, a, b)' },
  warAppetite: { combine: 'mul', clamp: [0.2, 3], sig: '(w, a, b)' },
  casusBelli: { combine: 'concat', sig: '(w, a, b) → [{cb, w, name?}]' },
  warAim: { combine: 'first', sig: "(w, a, b, cbKey) → { k: 'towns'|'crown'|'faith'|'tribute'|'subjugate'|'free'|'debt'|'humble'|'hold', sids?, rid?, civ? } | null (geo/terms.js)" },
  peaceTerms: { combine: 'first', sig: "(w, winner, loser, term: 'reparations'|'hostage'|'crown'|'faith') → false to forbid | null (geo/terms.js)" },
  lendingRule: { combine: 'first', sig: '(w, lenderCiv, borrowerCiv) → { allowed?, rateMul? } | null (geo/debt.js)' },
  upkeep: { combine: 'sum', clamp: [0, 1e12], sig: '(w, civ) → crowns a month the realm owes its armies, regiments and garrisons (geo/raising.js; civmonth.js adds it to the expenses)' },
  armySystem: { combine: 'first', sig: "(w, civ) → 'levy' | 'feudal' | 'standing' | 'hired' | null (geo/raising.js)" },
  // who holds power (chunk 7, civ/power.js)
  reserveRule: { combine: 'mul', clamp: [0.25, 6], sig: '(w, civ) → × the years of income the realm keeps in reserve' },
  courtSpend: { combine: 'mul', clamp: [0.2, 4], sig: '(w, civ) → × the share of income its court spends' },
  estates: { combine: 'first', sig: '(w, civ) → { names: [5], rights?: [5 deltas], unfree?: bool } | null (a people\'s own estates)' },
  lawStart: { combine: 'first', sig: '(w, civ) → partial { inherit, faith, bond, land } | null (the laws a realm starts with)' },
  factions: { combine: 'first', sig: '(w, civ) → [faction keys] | null (the factions a court may hold)' },
  // dynasties (chunk 9, civ/kin.js)
  heirRule: { combine: 'first', sig: "(w, civ) → 'male' (sons before daughters) | 'equal' (the eldest child) | 'strong' (the strongest grown child) | null" },
  houseRule: { combine: 'first', sig: "(w, civ) → 'father' | 'mother' (whose house a child belongs to) | null" },
  royalBirths: { combine: 'mul', clamp: [0.1, 3], sig: '(w, civ) → × how often a royal couple has a child' },
  bastardRule: { combine: 'first', sig: '(w, civ) → false for a people without bastards as a class | null' },
  // sieges and walls (chunk 6, geo/siege.js)
  wallKind: { combine: 'first', sig: '(w, civ) → { names?: [4], res?, mend?, burn?, water?, noMine? } | null (a people\'s walls)' },
  siegeCraft: { combine: 'first', sig: '(w, civ) → { storm?, escalade?, mine? } multipliers | null (how a people besieges)' },
  surrenderRule: { combine: 'first', sig: '(w, civ) → { mul (0 never, 2 readily), spare? } | null (when a starving town yields)' },
  slightRule: { combine: 'mul', clamp: [0, 4], sig: '(w, civ, s) → × the chance a conqueror tears down a taken town\'s walls' },
  // peoples and memory (chunk 8, geo/folk.js)
  townGrievance: { combine: 'sum', clamp: [0, 2], sig: '(w, s, civ) → added to a town\'s grievances (its unrest)' },
  kinRule: { combine: 'first', sig: '(w, peopleA, peopleB) → how a regards b at the start (−100…100) | null' },
  assimilateRule: { combine: 'first', sig: '(w, civ) → × how fast minorities take on the main people\'s ways | null' },
  minorityRule: { combine: 'first', sig: '(w, civ, people) → a standing (equal, tolerated, taxed, persecuted, expelled) | null' },
  migrateRule: { combine: 'first', sig: '(w, region) → × a region\'s migration pressure | null' },
  matchRule: { combine: 'first', sig: '(w, civ, other) → false (no match) | a number added to the match\'s appeal | null' },
  armyPay: { combine: 'mul', clamp: [0.25, 4], sig: '(w, civ) → × a soldier’s pay (geo/raising.js)' },
  armyMix: { combine: 'first', sig: '(w, civ) → 7 shares (spears, blades, bows, light horse, heavy horse, engineers, war beasts) | null (geo/army.js)' },
  claimRule: { combine: 'first', sig: '(w, civ) → { tau, foundedTau } years a lost town is claimed (e-folding) | null (geo/claims.js)' },
  revoltTo: { combine: 'first', sig: '(w, s, civ) → civId | null: the realm a rising town goes over to before its founders (geo/memory.js)' },
  temperRule: { combine: 'first', sig: '(_, civ, person) → 6 leans (ambition, mercy, piety, greed, honour, boldness; about −0.3 to 0.3) to a temperament made at first read, from civ and person alone (no world: core/character.js) | null' },
  ambitionRule: { combine: 'first', sig: '(w, civ, ruler) → { [kind | "none"]: × weight } for the ambitions a ruler draws (civ/ambitions.js) | null' },
  inventRule: { combine: 'first', sig: '(w, civ, techId) → true | false: whether the realm may invent an uncommon tech alone, instead of its land condition | null (civ/tech.js)' },
  learnRule: { combine: 'mul', clamp: [0.2, 3], sig: '(w, civ) → × the discounts a realm takes from those who know a tech (civ/tech.js)' },
  secretRule: { combine: 'first', sig: '(w, civ, artId) → false to let a rare art spread like common knowledge | null (civ/arts.js)' },
  // health and sickness (chunk 11, geo/health.js)
  frailty: { combine: 'mul', clamp: [0.1, 4], sig: '(w, people) → × how readily a people catches a plague and dies of it' },
  cleanRule: { combine: 'first', sig: "(w, people) → a people's first custom of cleanliness ('bath' | 'rite' | 'wells' | 'hearth' | 'plain' | 'fear') | null" },
  memoryRule: { combine: 'first', sig: '(w, s) → { grudge, thanks } years a town remembers (e-folding) | null (geo/memory.js)' },
  rates: { combine: 'mul', clamp: [0, 5], sig: '(w, key)' },
  vegCap: { combine: 'mul', clamp: [0.2, 1.5], sig: '(w, i)' },
  routeValue: { combine: 'mul', clamp: [0, 2], sig: '(w, route)' },
  damage: { combine: 'mul', clamp: [0, 2], sig: '(w, s, cause)' },
  yearRecord: { combine: 'merge', sig: '(w) → partial object' },
};

const EMPTY = Object.freeze([]);
const PROVIDERS = Object.create(null);   // point → [{ id, fn }] sorted by id
const ERRORS = Object.create(null);      // 'point|id' → count
let version = 1;

/** Process-local counter bumped by every provider or registry change. */
export const extVersion = () => version;

/** Register (or replace) provider `id` at `point`. fn(world, ...args). Pass fn = null to remove. */
export function registerProvider(point, id, fn) {
  if (!point || !id) throw new Error('registerProvider: point and id required');
  // a misspelt point would never be asked: say so (it is still registered, for wave-2 points)
  if (typeof fn === 'function' && !EXT_POINTS[point]) console.warn(`[ext] registerProvider: “${point}” is not a known extension point (EXT_POINTS)`);
  const list = (PROVIDERS[point] ||= []);
  const k = list.findIndex((p) => p.id === id);
  if (k >= 0) list.splice(k, 1);
  if (typeof fn === 'function') {
    list.push({ id: String(id), fn });
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  if (!list.length) delete PROVIDERS[point];
  version++;
}

/** Provider ids registered at a point (for reports and tests). */
export const providersOf = (point) => (PROVIDERS[point] || EMPTY).map((p) => p.id);
/** True when any provider is registered at the point (callers may skip work otherwise). */
export const hasProviders = (point) => Boolean(PROVIDERS[point]);

function fail(point, p, e) {
  const key = point + '|' + p.id;
  const n = (ERRORS[key] = (ERRORS[key] || 0) + 1);
  if (n <= 3) console.error(`[ext:${point}:${p.id}]`, e);
}
function clampTo(point, v) {
  const c = EXT_POINTS[point]?.clamp;
  return c ? (v < c[0] ? c[0] : v > c[1] ? c[1] : v) : v;
}

export function mulOf(point, w, a, b, c, d) {
  const list = PROVIDERS[point];
  if (!list) return 1;
  let m = 1;
  for (let k = 0; k < list.length; k++) {
    const p = list[k];
    let v;
    try { v = p.fn(w, a, b, c, d); } catch (e) { fail(point, p, e); continue; }
    if (typeof v === 'number' && Number.isFinite(v)) m *= v;
  }
  return clampTo(point, m);
}

export function sumOf(point, w, a, b, c, d) {
  const list = PROVIDERS[point];
  if (!list) return 0;
  let s = 0;
  for (let k = 0; k < list.length; k++) {
    const p = list[k];
    let v;
    try { v = p.fn(w, a, b, c, d); } catch (e) { fail(point, p, e); continue; }
    if (typeof v === 'number' && Number.isFinite(v)) s += v;
  }
  return clampTo(point, s);
}

export function firstOf(point, w, a, b, c, d) {
  const list = PROVIDERS[point];
  if (!list) return null;
  for (let k = 0; k < list.length; k++) {
    const p = list[k];
    let v;
    try { v = p.fn(w, a, b, c, d); } catch (e) { fail(point, p, e); continue; }
    if (v != null) return v;
  }
  return null;
}

export function anyOf(point, w, a, b, c, d) {
  const list = PROVIDERS[point];
  if (!list) return false;
  for (let k = 0; k < list.length; k++) {
    const p = list[k];
    let v;
    try { v = p.fn(w, a, b, c, d); } catch (e) { fail(point, p, e); continue; }
    if (v) return true;
  }
  return false;
}

/** Answers concatenated in provider-id order; arrays are spread, null/undefined skipped. */
export function concatOf(point, w, a, b, c, d) {
  const list = PROVIDERS[point];
  if (!list) return EMPTY;
  let out = null;
  for (let k = 0; k < list.length; k++) {
    const p = list[k];
    let v;
    try { v = p.fn(w, a, b, c, d); } catch (e) { fail(point, p, e); continue; }
    if (v == null) continue;
    out ||= [];
    if (Array.isArray(v)) { for (const x of v) if (x != null) out.push(x); } else out.push(v);
  }
  return out && out.length ? out : EMPTY;
}

const NEUTRAL_EACH = Object.create(null);
/** Per-key product of object answers over the point's keys, each clamped. Neutral: all 1 (frozen). */
export function mulEachOf(point, w, a, b, c, d) {
  const spec = EXT_POINTS[point];
  const keys = spec?.keys || EMPTY;
  const list = PROVIDERS[point];
  if (!list) return (NEUTRAL_EACH[point] ||= Object.freeze(Object.fromEntries(keys.map((k) => [k, 1]))));
  const out = {};
  for (const key of keys) out[key] = 1;
  for (let k = 0; k < list.length; k++) {
    const p = list[k];
    let v;
    try { v = p.fn(w, a, b, c, d); } catch (e) { fail(point, p, e); continue; }
    if (!v || typeof v !== 'object') continue;
    for (const key of keys) { const x = v[key]; if (typeof x === 'number' && Number.isFinite(x)) out[key] *= x; }
  }
  const cl = spec?.clamp;
  if (cl) for (const key of keys) out[key] = out[key] < cl[0] ? cl[0] : out[key] > cl[1] ? cl[1] : out[key];
  return out;
}

/** { [providerId]: answer } for non-null answers (yearRecord), or null when nobody answered. */
export function mergeOf(point, w, a, b, c, d) {
  const list = PROVIDERS[point];
  if (!list) return null;
  let out = null;
  for (let k = 0; k < list.length; k++) {
    const p = list[k];
    let v;
    try { v = p.fn(w, a, b, c, d); } catch (e) { fail(point, p, e); continue; }
    if (v != null) (out ||= {})[p.id] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Code registries. Owners merge these lazily, keyed by extVersion().

const MOD_KEYS = Object.create(null);   // key → { default, limit: [lo, hi], kind: 'add'|'mul'|'set' }
const TECHS = [];                        // tech defs (WP3 merges; branch 'arcane' excluded from eras)
const BUILDINGS = [];                    // building defs (WP3 merges; race / available gating)
const WONDERS = [];                      // wonder defs

const KINDS = new Set(['add', 'mul', 'set']);

/**
 * Register civ mod keys: { key: { default, limit: [lo, hi], kind: 'add'|'mul'|'set' } }.
 * WP3 merges them into DEFAULT_MODS and LIMITS. Re-registering a key replaces it.
 */
export function registerModKeys(defs) {
  if (!defs || typeof defs !== 'object') return;
  for (const [key, d] of Object.entries(defs)) {
    if (!d || typeof d !== 'object') continue;
    const kind = KINDS.has(d.kind) ? d.kind : 'mul';
    const def = Number.isFinite(d.default) ? d.default : kind === 'mul' ? 1 : 0;
    const limit = Array.isArray(d.limit) && d.limit.length === 2 && d.limit.every(Number.isFinite) ? [Math.min(...d.limit), Math.max(...d.limit)] : null;
    MOD_KEYS[key] = Object.freeze({ key, default: def, limit, kind });
  }
  version++;
}
/** Registered mod keys: { key: { key, default, limit, kind } } (read-only). */
export const getModKeys = () => MOD_KEYS;

function upsert(list, defs, what) {
  for (const d of Array.isArray(defs) ? defs : [defs]) {
    if (!d || !d.id) { console.error(`[ext:${what}] def without id`, d); continue; }
    const k = list.findIndex((x) => x.id === d.id);
    if (k >= 0) list[k] = d; else list.push(d);
  }
  version++;
}

/**
 * Register tech defs (same shape as src/sim/civ/tech.js TECHS). Extra fields: branch: 'arcane',
 * school, races: [race], minMana, available(w, civ) → bool. The arcane branch is excluded from
 * era computation, era grants, world knowledge and era pacing.
 */
export const registerTechs = (defs) => upsert(TECHS, defs, 'techs');
/** Register building defs; extra fields race, available(w, s, civ). */
export const registerBuildings = (defs) => upsert(BUILDINGS, defs, 'buildings');
/** Register wonder defs; extra fields race, available(w, s, civ). */
export const registerWonders = (defs) => upsert(WONDERS, defs, 'wonders');
/** Registered defs, in registration order (read-only arrays). */
export const getRegisteredTechs = () => TECHS;
export const getRegisteredBuildings = () => BUILDINGS;
export const getRegisteredWonders = () => WONDERS;
