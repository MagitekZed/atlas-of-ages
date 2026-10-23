// Bands · engine. The package's state (world.sys.bands), the kind registry, caps, power
// estimates, spawning and ending bands, the archive of fallen bands, and the daily / monthly /
// yearly loops that drive every kind:
//   daily    kind.day() hooks (hired companies follow their army, tamed beasts their tamer,
//            pirates lie in wait), then movement for bands under way (roam, raid, return,
//            settling); arriving bands call kind.arrive(). Every 10 days a scan for armies that
//            run into bands (combat.js clashScan).
//   monthly  kind.month() for every band, then each kind's spawner, the common-foe table and
//            the cap bookkeeping.
//   yearly   kind.year() (ageing, leaders, dispersal), strength history, pruning.
// Mythic kinds (BAND_KINDS flags.mythic) are skipped entirely below mythLevel 2: no rng is
// drawn and nothing is allocated for them (SPEC §1 mythic gate).
//
// sys.bands = { v, archive [≤200], press {routeId: {n, day, warned}}, raided {civId: {day,
//   bandId, n, kind}}, realms {civId: kind}, log [[day, bandId, x0, y0, x1, y1, kindIx, sev] ≤96],
//   disb [[armyId, civId, str, x, y, day, general]], snap [[id, civId, str, x, y, returning]],
//   foe {civId: [bandId]}, cd {key: day}, hunts [armyId], seeded, stats {…} } — plain JSON.

import { addBand, removeBand, getBand, liveCivs, liveSettlements } from '../../core/entities.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH, BAND_KINDS } from '../../core/constants.js';
import { mulOf } from '../../core/ext.js';
import { mythOn } from '../../core/params.js';
import { stepBand, walkGrid, planHome, links, modeOf, distTo, tileOf } from './move.js';
// (combat.js imports this module; it hands clashScan over through engineHooks instead of being
// imported here, so the two never form an import cycle — the single-file bundle cannot run one
// whose members wait on top-level awaits)

export const MAX_PEOPLE_BANDS = 40;
/** Share of all people of fighting age ("world manpower"), and the share of that bands may hold. */
export const MANPOWER_SHARE = 0.25;
export const BAND_SHARE = 0.03;
export const ARCHIVE_CAP = 200;
export const LOG_CAP = 96;
export const MONTH_DAY = 17;          // the day of each month the bands take stock
export const YEAR_DAY = 200;
export const KIND_INDEX = Object.keys(BAND_KINDS);
const MOVING = new Set(['roam', 'raid', 'return', 'settling']);
const LONG_CD = new Set(['pirateKingdom', 'dragonCome', 'clutch', 'hordeSteppe']);
export const isMoving = (band) => MOVING.has(band.state);

// ---------------------------------------------------------------------------
// State

const STATE_V = 2;
/** The package state, filled with defaults on first use (cheap afterwards). */
export function state(world) {
  const st0 = world.sys.bands;
  if (st0 && st0.v === STATE_V && st0.stats) return st0;
  const st = (world.sys.bands ||= {});
  st.v = STATE_V;
  st.archive ||= [];
  st.press ||= {};
  st.raided ||= {};
  st.realms ||= {};
  st.log ||= [];
  st.disb ||= [];
  st.snap ||= [];
  st.foe ||= {};
  st.cd ||= {};
  st.hunts ||= [];
  if (st.seeded == null) st.seeded = false;
  const s = (st.stats ||= {});
  s.spawned ||= {};
  s.cent ||= {};
  s.notable ||= {};
  for (const k of ['raids', 'kills', 'loot', 'sunk', 'robbed', 'realms', 'slain', 'tamed', 'hunts', 'heroes', 'ransoms', 'mutinies', 'hires', 'routesBroken', 'maxPeople', 'maxShare', 'maxDragons']) if (!Number.isFinite(s[k])) s[k] = 0;
  if (!('t300' in s)) s.t300 = null;
  return st;
}

// ---------------------------------------------------------------------------
// Kind registry

const KINDS = Object.create(null);    // kind → def
const SPAWNERS = [];                  // [{ id, myth, spawn(world) }] in registration order

/**
 * Register behaviour for one or more kinds. def: { myth?, spawn?(world), month?(world, band),
 * day?(world, band), rest?(band) → bool (day() also runs while the band rests in its lair),
 * arrive?(world, band), year?(world, band), slain?(world, band, civ, by), speed?(world, band) }.
 * A spawner is registered once per def.
 */
export function registerKind(kinds, def) {
  for (const k of [].concat(kinds)) KINDS[k] = def;
  if (typeof def.spawn === 'function' && !SPAWNERS.some((s) => s.def === def)) SPAWNERS.push({ def, id: [].concat(kinds)[0] });
}
export const kindDef = (kind) => KINDS[kind] || null;

/** Late-bound package hooks (set by hunts.js): slay(world, band, civ, by) ends a slain beast. */
export const engineHooks = { slay: null, clashScan: null };
/** A beast has fallen to civ: the kind's own ending, else the common one, else just remove it. */
export function slayBand(world, band, civ, by) {
  if (engineHooks.slay) engineHooks.slay(world, band, civ, by);
  else removeBand(world, band.id, 'slain');
}

const MYTHIC = new Set(Object.keys(BAND_KINDS).filter((k) => BAND_KINDS[k].flags?.mythic));
const mythicKind = (kind) => MYTHIC.has(kind);
export const isPeople = (band) => band.family === 'outlaw' || band.family === 'host';
export const isBeast = (band) => band.family === 'beast' || band.family === 'spirit';

// ---------------------------------------------------------------------------
// Power, people and caps

/** Fighting weight of a band in soldier-equivalents. */
export function bandPower(band) {
  if (!band) return 0;
  if (isPeople(band)) return Math.max(0, band.strength || 0) * (0.55 + 0.45 * clamp01(band.morale)) * (band.leader?.skill || 1);
  return Math.max(0, band.power || 0) * Math.max(0.05, clamp01(band.hp));
}
const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);

/**
 * World population, counted fresh (a few hundred towns, asked a few times a month). Not cached:
 * a cache filled between steps (by a report or a hook) could differ from one filled mid-step.
 */
export function worldPop(world) {
  let p = 0;
  for (const s of liveSettlements(world)) p += s.population > 0 ? s.population : 0;
  return p;
}

/** The most people all outlaw bands and hosts together may hold: 3 % of world manpower. */
export const peopleCap = (world) => worldPop(world) * MANPOWER_SHARE * BAND_SHARE;

export function peopleTotals(world) {
  let n = 0, str = 0;
  for (const b of world.bands) if (isPeople(b)) { n++; str += b.state === 'hired' ? 0 : Math.max(0, b.strength || 0); }
  return { n, str };
}

/** May a new people-band of this strength take the field? */
export function roomFor(world, strength) {
  const t = peopleTotals(world);
  return t.n < MAX_PEOPLE_BANDS && t.str + strength <= peopleCap(world);
}

/** Strength still free under the cap (never negative). */
export const capRoom = (world) => Math.max(0, peopleCap(world) - peopleTotals(world).str);

/** A realm's military and economic weight (geo/diplomacy civPower when present). */
export function civPowerOf(world, civ) {
  if (!civ || !civ.alive) return 0;
  if (links.diplo && typeof links.diplo.civPower === 'function') {
    try { const p = links.diplo.civPower(world, civ); if (Number.isFinite(p)) return p; } catch (e) { /* fall through */ }
  }
  const mp = civ.military?.manpower > 0 ? civ.military.manpower : (civ.population || 0) * 0.03;
  return mp * (1 + 0.3 * (civ.tech?.era || 0)) + Math.sqrt(Math.max(0, civ.treasury || 0)) * 3;
}
export const manpowerOf = (civ) => (civ?.military?.manpower > 0 ? civ.military.manpower : Math.max(0, civ?.population || 0) * 0.03);

/** rates × the banditry dial for people-bands (WP1 ages, black swans …). */
export const banditry = (world, key = 'bandSpawn') => Math.max(0, world.params.banditry ?? 1) * mulOf('rates', world, key);

// ---------------------------------------------------------------------------
// Lifecycle

const ORDINAL = ['', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];
/**
 * A name no living or remembered band carries: "the White Company" the first time, then
 * "the Second White Company", "the Third …" (pure; reads world.bands and the archive).
 */
export function uniqueName(world, name) {
  if (!name) return name;
  const taken = new Set();
  for (const b of world.bands) if (b.name) taken.add(b.name);
  for (const a of world.sys.bands?.archive || []) if (a.name) taken.add(a.name);
  if (!taken.has(name)) return name;
  // "the White Company" → "the Second White Company"; "Old Mossback" → "Old Mossback II"
  if (!/^the\s/i.test(name)) {
    for (let k = 2; k < 11; k++) { const n = `${name} ${ROMAN[k]}`; if (!taken.has(n)) return n; }
    return name;
  }
  const core = String(name).replace(/^the\s+/i, '');
  for (let k = 1; k < ORDINAL.length; k++) { const n = `the ${ORDINAL[k]} ${core}`; if (!taken.has(n)) return n; }
  return name;
}
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** Create a band, count it, and give it the bookkeeping every band carries. */
export function spawnBand(world, props) {
  const st = state(world);
  if (props.name && props.kind !== 'dragon') props = { ...props, name: uniqueName(world, props.name) };
  const band = addBand(world, props);
  band.data ||= {};
  band.data.peak = Math.max(band.strength || 0, band.power || 0);
  band.data.h = [[Math.floor(world.time.day / DAYS_PER_YEAR), Math.round(band.strength || band.power || 0)]];
  st.stats.spawned[band.kind] = (st.stats.spawned[band.kind] || 0) + 1;
  const c = Math.floor(world.time.day / (100 * DAYS_PER_YEAR));
  const cent = (st.stats.cent[c] ||= {});
  cent[band.kind] = (cent[band.kind] || 0) + 1;
  return band;
}

/** End a band (the bandDestroyed hook archives it). */
export const endBand = (world, band, cause = 'destroyed') => (band ? removeBand(world, band.id, cause) : null);

/** Archive summary of a band that has left the stage (from the bandDestroyed hook). */
export function archiveBand(world, band, cause) {
  if (!band) return;
  const st = state(world);
  st.archive.push({
    id: band.id, kind: band.kind, family: band.family, name: band.name, epithet: band.epithet || null,
    leader: band.leader ? band.leader.name : null, born: band.createdDay, died: world.time.day, cause: String(cause || 'gone'),
    raids: band.raids || 0, kills: Math.round(band.kills || 0), loot: Math.round(band.loot || 0),
    peak: Math.round(band.data?.peak || 0), x: Math.round(band.x), y: Math.round(band.y),
    civId: band.civId ?? -1, originCivId: band.originCivId ?? -1, slayer: band.data?.slayer || null,
    h: Array.isArray(band.data?.h) ? band.data.h.slice(-24) : [],
  });
  if (st.archive.length > ARCHIVE_CAP) st.archive.splice(0, st.archive.length - ARCHIVE_CAP);
}

/** Archived summary of a band id, or null. */
export function archived(world, id) {
  const a = world.sys.bands?.archive;
  if (!a) return null;
  for (let k = a.length - 1; k >= 0; k--) if (a[k].id === id) return a[k];
  return null;
}

export function aliveOf(world, kind) {
  let n = 0;
  for (const b of world.bands) if (b.kind === kind) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Bookkeeping helpers

/** Remember that a band struck a realm (hunts, heroes, pacts and the common-foe term read it). */
export function noteRaid(world, band, civId) {
  if (civId == null || civId < 0) return;
  const st = state(world);
  const r = st.raided[civId];
  if (r && r.bandId === band.id) { r.day = world.time.day; r.n++; }
  else st.raided[civId] = { day: world.time.day, bandId: band.id, n: 1, kind: band.kind };
}

/** A raid arrow for the map: from the band's home to where it struck. */
export function logRaid(world, band, x1, y1, sev = 1) {
  const st = state(world);
  const W = world.W;
  const hx = band.homeI % W, hy = (band.homeI / W) | 0;
  st.log.push([world.time.day, band.id, hx, hy, Math.round(x1), Math.round(y1), KIND_INDEX.indexOf(band.kind), Math.round(sev * 100) / 100]);
  if (st.log.length > LOG_CAP) st.log.splice(0, st.log.length - LOG_CAP);
}

/** Rate limiter: true (and arm it) when `key` has not fired within `days`. */
export function ready(world, key, days) {
  const cd = state(world).cd;
  const d = cd[key];
  if (d != null && world.time.day - d < days) return false;
  cd[key] = world.time.day;
  return true;
}
/** Read-only check of a rate limit. */
export function isReady(world, key, days) {
  const d = world.sys.bands?.cd?.[key];
  return d == null || world.time.day - d >= days;
}

/** A sample of the band's strength (or power) for its record, once a year. */
function sample(world, band) {
  const h = (band.data.h ||= []);
  const y = Math.floor(world.time.day / DAYS_PER_YEAR);
  const v = Math.round(isPeople(band) ? band.strength || 0 : (band.power || 0) * clamp01(band.hp));
  if (h.length && h[h.length - 1][0] === y) h[h.length - 1][1] = v; else h.push([y, v]);
  if (h.length > 30) { const keep = [h[0]]; for (let k = 2; k < h.length; k += 2) keep.push(h[k]); if (keep[keep.length - 1] !== h[h.length - 1]) keep.push(h[h.length - 1]); band.data.h = keep; }
  band.data.peak = Math.max(band.data.peak || 0, v);
}

// ---------------------------------------------------------------------------
// Loops

export function daily(world) {
  if (!world.bands.length) return;
  const myth = mythOn(world);
  let grid = null;
  const list = world.bands.slice();
  // only an addition or a removal bumps the bands version: rebuild the live set only then
  let v = world.versions.bands, live = null;
  const alive = (band) => {
    if (world.versions.bands !== v) { live = new Set(); for (const b of world.bands) live.add(b.id); v = world.versions.bands; }
    return !live || live.has(band.id);
  };
  for (let k = 0; k < list.length; k++) {
    const band = list[k];
    const def = KINDS[band.kind];
    const resting = band.state === 'lair' || band.state === 'sleep';
    if (resting && !(def && def.rest)) continue;          // most days most bands just rest
    if (!myth && MYTHIC.has(band.kind)) continue;
    if (!alive(band)) continue;
    if (def && def.day && (!resting || def.rest(band))) { def.day(world, band); if (!alive(band)) continue; }
    if (!MOVING.has(band.state)) continue;
    if (!grid && modeOf(band) === 'land') grid = walkGrid(world);
    const mul = def && def.speed ? def.speed(world, band) : 1;
    if (!stepBand(world, band, grid, mul)) continue;
    if (modeOf(band) !== 'fly' && band.targetI >= 0 && distTo(world, band, band.targetI) > 2.5) {
      // no way there (a route that failed, or ground that changed): rest where it stands
      band.state = 'lair'; band.path = null; band.targetSid = -1;
      band.homeI = tileOf(world, band.x, band.y);
      if (band.data) { band.data.seize = 0; band.data.ambush = -1; }
      continue;
    }
    if (def && def.arrive) def.arrive(world, band);
    else defaultArrive(world, band);
  }
  if (world.time.day % 10 === 3 && engineHooks.clashScan) engineHooks.clashScan(world);
}

/** Back home: rest. Elsewhere with nothing to do: go home. */
export function defaultArrive(world, band) {
  if (band.state === 'return' || band.targetI === band.homeI) { band.state = 'lair'; band.path = null; band.targetSid = -1; return; }
  band.state = 'return';
  if (!planHome(world, band)) { band.state = 'lair'; band.path = null; band.homeI = Math.round(band.y) * world.W + Math.round(band.x); }
}

export function monthly(world) {
  const st = state(world);
  const myth = mythOn(world);
  const list = world.bands.slice();
  let v = world.versions.bands, live = null;
  for (const band of list) {
    if (!myth && mythicKind(band.kind)) continue;
    const def = KINDS[band.kind];
    if (!def || !def.month) continue;
    if (world.versions.bands !== v) { live = new Set(); for (const b of world.bands) live.add(b.id); v = world.versions.bands; }
    if (live && !live.has(band.id)) continue;
    def.month(world, band);
  }
  for (const s of SPAWNERS) {
    if (s.def.myth && !myth) continue;
    s.def.spawn(world);
  }
  // the common-foe table: realms struck in the last three years by the same host, beast or dead
  const foe = {};
  const day = world.time.day;
  for (const civId in st.raided) {
    const r = st.raided[civId];
    if (day - r.day > 3 * DAYS_PER_YEAR) continue;
    const b = getBand(world, r.bandId);
    if (!b || !(b.kind === 'horde' || b.kind === 'undead' || b.kind === 'dragon' || b.kind === 'company')) continue;
    (foe[civId] ||= []).push(b.id);
  }
  st.foe = foe;
  // over the cap (a world that has lost people): deserters drift home from every band
  let t = peopleTotals(world);
  const capS = peopleCap(world);
  if (t.str > capS) {
    const k = capS / t.str;
    for (const b of world.bands) if (isPeople(b) && b.state !== 'hired') b.strength = Math.floor(b.strength * k);
    t = peopleTotals(world);
  }
  st.stats.maxPeople = Math.max(st.stats.maxPeople, t.n);
  const pop = worldPop(world);
  if (pop > 0) st.stats.maxShare = Math.max(st.stats.maxShare, Math.round((t.str / (pop * MANPOWER_SHARE)) * 10000) / 10000);
  if (myth) st.stats.maxDragons = Math.max(st.stats.maxDragons, aliveOf(world, 'dragon'));
}

export function yearly(world) {
  const st = state(world);
  const myth = mythOn(world);
  const day = world.time.day;
  for (const band of world.bands.slice()) {
    if (!myth && mythicKind(band.kind)) continue;
    if (!getBand(world, band.id)) continue;
    const def = KINDS[band.kind];
    if (def && def.year) def.year(world, band);
    const b = getBand(world, band.id);
    if (b) sample(world, b);
  }
  // forget old raids, decayed road pressure and stale rate limits
  for (const k of Object.keys(st.raided)) if (day - st.raided[k].day > 6 * DAYS_PER_YEAR || !world.civs[k]?.alive) delete st.raided[k];
  for (const k of Object.keys(st.press)) if (day - st.press[k].day > 8 * DAYS_PER_YEAR) delete st.press[k];
  // every rate limit is shorter than 40 years except these few world-wide ones
  for (const k of Object.keys(st.cd)) if (day - st.cd[k] > (LONG_CD.has(k) ? 300 : 40) * DAYS_PER_YEAR) delete st.cd[k];
  for (const k of Object.keys(st.realms)) if (!world.civs[k]?.alive) delete st.realms[k];
  if (st.stats.t300 == null && day >= 300 * DAYS_PER_YEAR) {
    let towns = 0, pop = 0;
    for (const s of liveSettlements(world)) { towns++; pop += s.population; }
    st.stats.t300 = { towns, pop: Math.round(pop), civs: liveCivs(world).length, myth: world.params.mythLevel ?? 0 };
  }
}

export { DAYS_PER_MONTH, DAYS_PER_YEAR };
