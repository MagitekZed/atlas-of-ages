// Shared plumbing for the civilization module: persistent system state (world.sys.civ),
// derived caches (world.cache.civ), the chronicle wrapper with per-place rate limiting,
// field defaults for civ / settlement objects, and numeric guards.
//
// world.sys.civ (JSON, saved):
//   v               state format version
//   terrDirty       territory must be recomputed soon (settlement created/destroyed/moved)
//   lastTerrDay     day territory last ran
//   firstTech       { techId: civId } first civ in the world to learn each tech
//   eraReached      { era: count } how many civs have entered each era
//   rl              { key: day } rate-limit stamps for chronicle entries (pruned yearly)
//   wonderKinds     { kind: wonderId } wonders currently standing, one per kind
//   milestones      { key: day } one-off world firsts (first city, first metropolis…)
//   counters        { emerged, rebellions, suppressed, civilWars, collapses, colonies, unions, revolutions }
//   nextPersonId    running id for rulers
//   eraFirst        { era: { civId, day } } the first realm to enter each era (contracts §3)
//   dynasties       ended royal houses, oldest first (cap 400; immutable once pushed):
//                   { name, civId, start, end, rulers (count), founder, last, endCause }
//   exiles          courts in exile [{ id, civId, name, adjective, hue, colorHex, dynasty,
//                   ruler, hostCivId, homeSids, since, used }] (dynasty.js; cap 24)
//   marriages       recent royal matches [{ a, b, day, house }] (dynasty.js; cap 60)

import { chronicle } from '../../core/chronicle.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';

export const STATE_VERSION = 2;
export const DYNASTY_CAP = 400;

/** Finite-or-default. */
export const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** Guarded division. */
export const div = (a, b, d = 0) => {
  if (!b) return d;
  const q = a / b;
  return Number.isFinite(q) ? q : d;
};

export function newCivState() {
  return {
    v: STATE_VERSION,
    terrDirty: true,
    lastTerrDay: -9999,
    firstTech: {},
    eraReached: {},
    rl: {},
    wonderKinds: {},
    milestones: {},
    counters: { emerged: 0, rebellions: 0, suppressed: 0, civilWars: 0, collapses: 0, colonies: 0, unions: 0, revolutions: 0,
      personalUnions: 0, restorations: 0, regencies: 0, marriages: 0, divine: 0 },
    nextPersonId: 1,
    eraFirst: {},
    dynasties: [],
    exiles: [],
    marriages: [],
  };
}

/** Upgrade an older / partial state object in place (saves from earlier builds). */
export function normaliseCivState(st) {
  const d = newCivState();
  for (const k of Object.keys(d)) if (st[k] == null) st[k] = d[k];
  for (const k of Object.keys(d.counters)) if (st.counters[k] == null) st.counters[k] = 0;
  for (const k of ['dynasties', 'exiles', 'marriages']) if (!Array.isArray(st[k])) st[k] = [];
  if (!st.eraFirst || typeof st.eraFirst !== 'object') st.eraFirst = {};
  st.v = STATE_VERSION;
  return st;
}

export const civState = (world) => world.sys.civ || null;
export const civCache = (world) => (world.cache.civ ||= {});

/**
 * Live settlements of a civ, cached until the month or the settlement set changes (a list
 * kept from earlier in the month would differ in a world reloaded mid-month).
 */
export function civTowns(world, civ) {
  const c = civCache(world);
  const month = Math.floor(world.time.day / 30);
  const v = world.versions.settlements || 0;
  if (c.townsMonth !== month || c.townsV !== v || !c.towns) { c.towns = new Map(); c.townsMonth = month; c.townsV = v; }
  let list = c.towns.get(civ.id);
  if (!list) {
    list = [];
    for (const id of civ.settlementIds) { const s = world.settlements[id]; if (s && s.alive) list.push(s); }
    c.towns.set(civ.id, list);
  }
  return list;
}

/** Civ ids at war now (any active war), cached by versions.wars. */
export function atWarSet(world) {
  const c = civCache(world);
  const v = world.versions.wars || 0;
  if (c.atWarV === v && c.atWar) return c.atWar;
  const set = new Set();
  for (const w of world.wars) {
    if (!w || !w.active) continue;
    for (const id of w.attackers) set.add(id);
    for (const id of w.defenders) set.add(id);
  }
  c.atWar = set; c.atWarV = v;
  return set;
}

export function markTerritoryDirty(world) {
  if (world.sys.civ) world.sys.civ.terrDirty = true;
}

/**
 * Sparse set of tiles that hold civ-written state (farm, popDensity, pollution), so the
 * monthly landscape upkeep touches only those instead of the whole grid. Rebuilt from the
 * fields after load (it lives in the cache).
 */
export function touched(world) {
  const c = civCache(world);
  const N = world.N;
  if (!c.touch || c.touch.flag.length !== N) {
    const flag = new Uint8Array(N), list = new Int32Array(N);
    const f = world.f;
    let n = 0;
    for (let i = 0; i < N; i++) if (f.farm[i] > 0 || f.popDensity[i] !== 0 || f.pollution[i] > 0) { flag[i] = 1; list[n++] = i; }
    c.touch = { flag, list, n };
  }
  return c.touch;
}
export function touchTile(world, i) {
  const t = touched(world);
  if (!t.flag[i]) { t.flag[i] = 1; t.list[t.n++] = i; }
}

/**
 * Rate limiter for chronicle entries: true at most once per `years` for a key.
 * Use place- or civ-specific keys ("famine:12", "tier:4:3").
 */
export function rateOk(world, key, years) {
  const st = world.sys.civ;
  if (!st) return true;
  const last = st.rl[key];
  if (last != null && world.time.day - last < years * DAYS_PER_YEAR) return false;
  st.rl[key] = world.time.day;
  return true;
}

/** Drop rate-limit stamps older than 80 years so the object never grows without bound. */
export function pruneRateLimits(world) {
  const st = world.sys.civ;
  if (!st) return;
  const cut = world.time.day - 80 * DAYS_PER_YEAR;
  for (const k of Object.keys(st.rl)) if (st.rl[k] < cut) delete st.rl[k];
}

/**
 * Chronicle wrapper. e: { cat, imp, text, key, s (settlement), civ, x, y, icon, ref, cause, tags, fold }.
 * Location defaults to the settlement, then the civ's capital, then its origin. A civ-wide
 * entry takes the capital's position but not its sid (it is about the realm, not the town).
 * ref defaults to the settlement, else the civ. Returns the chronicle entry (for cause chains).
 */
export function record(world, e) {
  let x = e.x ?? null, y = e.y ?? null, civId = e.civId ?? null, sid = e.sid ?? null;
  if (e.s) { x ??= e.s.x; y ??= e.s.y; sid ??= e.s.id; civId ??= e.s.civId; }
  if (e.civ) {
    civId ??= e.civ.id;
    if (x == null) {
      const cap = e.civ.capitalId != null ? world.settlements[e.civ.capitalId] : null;
      if (cap) { x = cap.x; y = cap.y; } else { x = e.civ.originX; y = e.civ.originY; }
    }
  }
  let ref = e.ref ?? null;
  if (!ref) {
    if (e.s) ref = { k: 'settlement', id: e.s.id };
    else if (e.civ) ref = { k: 'civ', id: e.civ.id };
    else if (sid != null) ref = { k: 'settlement', id: sid };
    else if (civId != null) ref = { k: 'civ', id: civId };
  }
  return chronicle(world, {
    cat: e.cat || 'civ', imp: e.imp ?? 2, text: e.text, x, y, civId, sid, icon: e.icon ?? null,
    ref, key: e.key || null, cause: e.cause ?? null, tags: e.tags || null, fold: e.fold || false,
  });
}

/** The 'ruler' ref id the Inspector understands ("civId:reignStart"). */
export const rulerRefId = (civ, r) => (civ && r && Number.isFinite(r.reignStart) ? `${civ.id}:${r.reignStart}` : r?.id ?? null);
/** A chronicle ref to a ruler of civ. */
export const rulerRef = (civ, r) => ({ k: 'ruler', id: rulerRefId(civ, r) });

// ---------------------------------------------------------------------------
// Entity field defaults (idempotent; safe on loaded saves and on entities other modules made)

/**
 * Civ fields added by this module (beyond the kernel shape):
 *   culture          accumulated culture of all its settlements (monthly)
 *   flags.style      index of the chosen name style for the current government
 *   flags.titleVar   index of the chosen ruler-title variant
 *   flags.govSince   day the current government was adopted
 *   flags.popHist    last ~12 yearly population samples (oldest first)
 *   flags.townHist   last ~12 yearly settlement-count samples
 *   flags.taxAcc     taxes collected by settlements since the last civ month
 *   flags.avgHappy / avgLoyal / avgUnrest / faithDis   monthly aggregates (0..1)
 *   flags.capacity   settlements the government can administer without strain
 *   flags.overext    0.. overextension pressure
 *   flags.steppe / coastShare   share of territory that is open grassland / coastal towns
 *   flags.generals   living great generals (military bonus)
 *   flags.conquests  settlements taken by conquest in the last decade (decays)
 *   flags.losses     settlements lost in the last decade (decays)
 *   flags.lastSettlerDay, lastCollapseDay
 *   flags.dynasty    { name, since, rulers } — civ.dynasty mirrors the display name
 *   flags.regnal     { personalName: count } for regnal numbers
 *   flags.stab       parts of the stability target, e.g. { legitimacy, happiness, institutions,
 *                    war, overextension, faith, unrest, debt, losses, size, diversity, target }
 *                    (signed contributions; useful for the inspector)
 *   flags.crisisYears  consecutive-ish years with stability < 0.25 (collapse / revolution gate)
 *   flags.independence day the civ broke away (realm age for rebellion / union / civil-war gates)
 *   flags.lastRebelDay, lastIndepWarDay, lastCivilWarDay   cooldowns of the fates of states
 *   flags.prevGov    government before the current one (revolutions rarely restore it)
 *   flags.ageEndDay  day the last golden or dark age ended (40-year gap before a dark age)
 *   flags.noRoomDay / roomFails, noSeaDay / seaFails   settler-search back-off
 */
export function ensureCivFields(civ) {
  civ.flags ||= {};
  const fl = civ.flags;
  if (!Number.isFinite(civ.culture)) civ.culture = 0;
  if (!Array.isArray(fl.popHist)) fl.popHist = [];
  if (!Array.isArray(fl.townHist)) fl.townHist = [];
  if (!Number.isFinite(fl.taxAcc)) fl.taxAcc = 0;
  if (!Number.isFinite(fl.avgHappy)) fl.avgHappy = 0.6;
  if (!Number.isFinite(fl.avgLoyal)) fl.avgLoyal = 0.8;
  if (!Number.isFinite(fl.avgUnrest)) fl.avgUnrest = 0;
  if (!Number.isFinite(fl.faithDis)) fl.faithDis = 0;
  if (!Number.isFinite(fl.overext)) fl.overext = 0;
  if (!Number.isFinite(fl.conquests)) fl.conquests = 0;
  if (!Number.isFinite(fl.losses)) fl.losses = 0;
  if (!Number.isFinite(fl.generals)) fl.generals = 0;
  if (!Number.isFinite(fl.lastSettlerDay)) fl.lastSettlerDay = -1e9;
  if (!fl.regnal || typeof fl.regnal !== 'object') fl.regnal = {};
  civ.tech ||= { known: {}, points: 0, research: null, progress: 0, era: 0 };
  civ.tech.known ||= {};
  if (!Number.isFinite(civ.tech.points)) civ.tech.points = 0;
  if (!Number.isFinite(civ.tech.progress)) civ.tech.progress = 0;
  if (!Number.isFinite(civ.tech.era)) civ.tech.era = 0;
  civ.military ||= { manpower: 0, strength: 0 };
  if (!Array.isArray(civ.rulerHistory)) civ.rulerHistory = [];
  for (const k of ['treasury', 'income', 'expenses', 'prestige', 'warWeariness', 'goldenAge', 'darkAge', 'population', 'territory', 'wealth', 'peakPopulation', 'peakTerritory']) {
    if (!Number.isFinite(civ[k])) civ[k] = 0;
  }
  if (!Number.isFinite(civ.taxRate)) civ.taxRate = 0.08;
  if (!Number.isFinite(civ.stability)) civ.stability = 0.8;
  if (!Number.isFinite(civ.legitimacy)) civ.legitimacy = 0.8;
  return civ;
}

/**
 * Keep a civ's yearly population / town history comparable after settlements change hands:
 * people who leave or join by transfer are not births or deaths, so the dark-age and
 * golden-age tests (which compare with ten years ago) only see real demographic change.
 * popShare: fraction of the civ's people that left (> 0) or absolute people that joined
 * (joined > 0); dTowns adjusts the town history (political splits are not defeats).
 */
export function adjustHistory(civ, { leftShare = 0, joined = 0, dTowns = 0 } = {}) {
  const fl = civ?.flags;
  if (!fl || !Array.isArray(fl.popHist)) return;
  const keep = 1 - Math.max(0, Math.min(0.95, leftShare));
  for (let k = 0; k < fl.popHist.length; k++) fl.popHist[k] = Math.max(0, Math.round(fin(fl.popHist[k]) * keep + Math.max(0, joined)));
  if (dTowns && Array.isArray(fl.townHist)) for (let k = 0; k < fl.townHist.length; k++) fl.townHist[k] = Math.max(0, fin(fl.townHist[k]) + dTowns);
}

/**
 * Settlement fields added by this module (beyond the SPEC §5 shared fields):
 *   project        { kind: 'building'|'wonder', key, level, cost, progress } | null
 *   farmland       Σ farm intensity over the catchment (tile units)
 *   growth         annualised net population growth rate of the last month
 *   capacity       sustainable population of the catchment at current yields
 *   foodImport     food received from the civ granary network last month
 *   emigrants      people who left last month (famine / overcrowding)
 *   taxes          taxes paid last month
 *   flags.assim    0..1 assimilation into the current owner's culture
 *   flags.maxTier  highest tier ever reached (tier chronicles fire once)
 *   flags.conqueredDay, lastSettler, famineDeaths, wonders (count), grieve (months of
 *                  disaffection), seceded / pacified (day), brev (buildings revision),
 *                  pot / ep (catchment potentials and land-use plan), planDay, noSiteDay / noSeaDay
 *   flags.tierSeen last tier announced through the tierChanged hook
 *   flags.famPop0  population when the current famine began (the famine hook's 5 % test)
 */
const SETTLE_FIELDS_V = 3;
/** Flags every settlement carries from birth, in one order, so their objects share a shape. */
const SETTLE_FLAG_DEFAULTS = [['res', 0], ['pot', null], ['ep', null], ['grieve', 0], ['planDay', -1], ['noSiteDay', -1], ['noSiteN', 0],
  ['noSeaDay', -1], ['famineDeaths', 0], ['brev', 0], ['emig', 0], ['conqueredDay', null], ['seceded', null], ['pacified', null], ['famPop0', 0]];
export function ensureSettlementFields(s) {
  if (s.flags && s.flags.fv === SETTLE_FIELDS_V && Number.isFinite(s.population)) return s;
  s.flags ||= {};
  if (s.project === undefined) s.project = null;
  if (!Number.isFinite(s.farmland)) s.farmland = 0;
  if (!Number.isFinite(s.growth)) s.growth = 0;
  if (!Number.isFinite(s.capacity)) s.capacity = s.population || 0;
  if (!Number.isFinite(s.foodImport)) s.foodImport = 0;
  if (!Number.isFinite(s.emigrants)) s.emigrants = 0;
  if (!Number.isFinite(s.taxes)) s.taxes = 0;
  if (!Number.isFinite(s.flags.assim)) s.flags.assim = s.originCivId === s.civId ? 1 : 0.3;
  if (!Number.isFinite(s.flags.maxTier)) s.flags.maxTier = s.tier || 0;
  if (!Number.isFinite(s.flags.lastSettler)) s.flags.lastSettler = -1e9;
  if (!Number.isFinite(s.flags.wonders)) s.flags.wonders = 0;
  if (!Number.isFinite(s.flags.tierSeen)) s.flags.tierSeen = s.tier || 0;
  for (const [k, v] of SETTLE_FLAG_DEFAULTS) if (!(k in s.flags)) s.flags[k] = v;
  s.buildings ||= {};
  for (const k of ['population', 'food', 'wealth', 'production', 'tradeIncome', 'housing', 'culture', 'defense', 'garrison', 'famine', 'foodProd', 'foodNeed']) {
    if (!Number.isFinite(s[k])) s[k] = 0;
  }
  for (const k of ['health', 'happiness', 'loyalty']) if (!Number.isFinite(s[k])) s[k] = 0.6;
  if (!Number.isFinite(s.unrest)) s.unrest = 0;
  if (!Number.isFinite(s.radius) || s.radius < 1) s.radius = 2;
  if (!Number.isFinite(s.peakPopulation)) s.peakPopulation = s.population;
  s.flags.fv = SETTLE_FIELDS_V;
  return s;
}
