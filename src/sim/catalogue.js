// The catastrophe catalogue: nature's fury remembered. Every great quake, wave, eruption,
// falling star, flood, storm, fire, famine and swarm is written here at the moment it happens,
// with its magnitude, toll, the towns it struck and (for storms) its track, so that "the
// strongest quake ever" or "the storm that drowned Kel" can still be answered centuries
// later. Hook-driven (contracts §5); run from the stats system's module, no rng.
//
//   world.history.events = [{ id, t, d, x, y, m, dead, n, towns: [sid ≤ 4], ref?, k?, tr?, … }]
//     t type (quake | tsunami | eruption | impact | flood | storm | fire | famine | locusts)
//     d day · m magnitude (Richter, wave height 0..1, VEI, crater radius in tiles, storm
//     category, burned tiles, famine months, food eaten) · n name or null · tr storm track
//     [[x, y, intensity]] ≤ 24 · ref the entity it belongs to (volcano, storm, fire, settlement)
// At most 500 events: past the cap the lowest score — log1p(dead) + a weight for the
// magnitude − age in millennia, ties to the older — is forgotten. Events are immutable once
// pushed (keyframes share them). Each one also feeds the Hall of Records (records.js).
//
// Also exported for the other recorders: placeName(world, x, y) and seasonAt(world, day, y).

import { DAYS_PER_YEAR, DAYS_PER_MONTH, MONTH_SEASON, SEASONS, WATER } from '../core/constants.js';
import { on } from '../core/hooks.js';
import { noteRecord } from './records.js';

export const MAX_EVENTS = 500;
export const EVENT_TYPES = {
  quake: { label: 'Earthquake', cat: 'disaster' },
  tsunami: { label: 'Great wave', cat: 'disaster' },
  eruption: { label: 'Eruption', cat: 'disaster' },
  impact: { label: 'Falling star', cat: 'disaster' },
  flood: { label: 'Flood', cat: 'disaster' },
  storm: { label: 'Storm', cat: 'disaster' },
  fire: { label: 'Wildfire', cat: 'nature' },
  famine: { label: 'Famine', cat: 'civ' },
  locusts: { label: 'Locust swarm', cat: 'nature' },
};

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r1 = (v) => Math.round(fin(v) * 10) / 10;
const r2 = (v) => Math.round(fin(v) * 100) / 100;

// ---------------------------------------------------------------------------
// Naming helpers (shared with sites.js and records.js)

/** The season at a day for a row (hemisphere-aware): 'Winter' … 'Autumn'. */
export function seasonAt(world, day, y = 0) {
  const m = Math.floor(day / DAYS_PER_MONTH) % 12;
  const s = MONTH_SEASON[m];
  const north = y == null || !world?.H ? true : y < world.H / 2;
  return SEASONS[north ? s : (s + 2) % 4];
}

const FEATURE_NEAR = { continent: 1, island: 1, range: 0.8, desert: 0.8, forest: 0.8, lake: 0.6, sea: 0.6, ocean: 0.4, river: 0.6 };
/**
 * A human name for a place: the nearest settlement (living or ruined) within 6 tiles, else the
 * nearest named feature, else null. Pure.
 */
export function placeName(world, x, y, { maxTown = 6, ruins = true } = {}) {
  let best = null, bd = maxTown * maxTown;
  for (const s of world.settlements) {
    if (!s || (!s.alive && !ruins)) continue;
    const dx = s.x - x, dy = s.y - y, d = dx * dx + dy * dy;
    if (d < bd || (d === bd && best && s.alive && !best.alive)) { bd = d; best = s; }
  }
  if (best) return best.name;
  let fb = null, fd = Infinity;
  for (const ft of world.features || []) {
    const w = FEATURE_NEAR[ft.kind];
    if (!w || !ft.name) continue;
    const d = Math.hypot(ft.x - x, ft.y - y) / w;
    if (d < fd) { fd = d; fb = ft; }
  }
  return fb && fd < 60 ? fb.name : null;
}

// ---------------------------------------------------------------------------
// Store

/** The catalogue array (created on demand; old saves have none). */
export function eventStore(world) {
  const h = world.history || (world.history = { years: [], atlas: [] });
  if (!Array.isArray(h.events)) h.events = [];
  return h.events;
}

function stats(world) { return (world.sys.stats ||= {}); }

const WEIGHT = {
  quake: (e) => Math.max(0, e.m - 6) * 1.5,
  tsunami: (e) => 1 + 2 * e.m,
  eruption: (e) => e.m * 0.8,
  impact: (e) => 3 + e.m,
  flood: () => 0.5,
  storm: (e) => e.m * 0.6 + (e.lf ? 0.3 : 0),
  fire: (e) => Math.log1p(e.m) / 2,
  famine: (e) => 0.5 + Math.log1p(e.m) / 3,
  locusts: (e) => Math.log1p(e.m) / 5,
};

/** Eviction score: higher survives. */
export function eventScore(world, e) {
  const w = WEIGHT[e.t] ? WEIGHT[e.t](e) : 0;
  return Math.log1p(fin(e.dead)) + w - (world.time.day - e.d) / DAYS_PER_YEAR / 1000;
}

/** Push an event (assigns its id) and enforce the cap. Returns the event (possibly evicted at once). */
export function pushEvent(world, ev) {
  const st = stats(world);
  st.evId = (st.evId | 0) + 1;
  const e = { id: st.evId, t: ev.t, d: world.time.day, x: r1(ev.x), y: r1(ev.y), m: r2(ev.m), dead: Math.round(fin(ev.dead)), n: ev.n || null };
  const towns = Array.isArray(ev.towns) ? ev.towns.map((t) => (t && typeof t === 'object' ? t.sid : t)).filter((t) => Number.isFinite(t)) : [];
  if (towns.length) e.towns = towns.slice(0, 4);
  if (ev.ref && ev.ref.k) e.ref = { k: ev.ref.k, id: ev.ref.id ?? null };
  for (const k of ['k', 'lf', 'u', 'o', 'sid', 'mo', 'pk']) if (ev[k] != null) e[k] = ev[k];
  if (Array.isArray(ev.tr) && ev.tr.length) e.tr = ev.tr;
  const list = eventStore(world);
  list.push(e);
  if (list.length > MAX_EVENTS) {
    let worst = -1, ws = Infinity;
    for (let k = 0; k < list.length; k++) {
      const sc = eventScore(world, list[k]);
      if (sc < ws || (sc === ws && (list[k].d < list[worst].d || (list[k].d === list[worst].d && list[k].id < list[worst].id)))) { ws = sc; worst = k; }
    }
    if (worst >= 0) list.splice(worst, 1);
  }
  return e;
}

/** A catalogue event by id, or null. */
export function getEvent(world, id) {
  const list = world?.history?.events;
  if (!Array.isArray(list) || id == null) return null;
  const n = Number(id);
  for (const e of list) if (e.id === n) return e;
  return null;
}

/** The catalogued storm with this storm id (archived after it blew out), or null. */
export function stormRecord(world, stormId) {
  const list = world?.history?.events;
  if (!Array.isArray(list)) return null;
  for (let k = list.length - 1; k >= 0; k--) { const e = list[k]; if (e.t === 'storm' && e.sid === stormId) return e; }
  return null;
}

/** Decimate a storm track to ≤ 24 points of [x, y, intensity] (rounded). */
function trackOf(track) {
  if (!Array.isArray(track) || !track.length) return null;
  const n = track.length, keep = Math.min(24, n);
  const out = [];
  for (let k = 0; k < keep; k++) {
    const p = track[Math.round((k * (n - 1)) / Math.max(1, keep - 1))];
    if (!Array.isArray(p)) continue;
    out.push([r1(p[0]), r1(p[1]), r2(p[2] ?? 0)]);
  }
  return out.length ? out : null;
}

const lbl = (world, x, y) => placeName(world, x, y);
/** "the Kizark Mountains" + "quake" → "the Kizark Mountains quake" (one article, never "the the"). */
const theNamed = (place, what) => `the ${String(place).replace(/^the\s+/i, '')} ${what}`;

// ---------------------------------------------------------------------------
// Handlers (hook payloads per contracts §5; also called by stats.js fallbacks)

export const HANDLERS = {
  quake(world, q) {
    if (!q) return;
    const mag = fin(q.mag), dead = fin(q.deaths);
    if (mag < 6 && dead < 10) return;
    const place = lbl(world, q.x, q.y);
    const e = pushEvent(world, { t: 'quake', x: q.x, y: q.y, m: mag, dead, n: place ? theNamed(place, 'quake') : null, towns: q.towns, u: q.undersea ? 1 : undefined });
    const meta = { label: e.n || `a quake of magnitude ${mag.toFixed(1)}`, ref: { k: 'event', id: e.id }, x: q.x, y: q.y, place };
    noteRecord(world, 'quake.mag', mag, meta);
    if (dead > 0) noteRecord(world, 'quake.dead', dead, meta);
  },
  tsunami(world, q) {
    if (!q) return;
    const dead = fin(q.deaths);
    const place = lbl(world, q.x, q.y);
    const e = pushEvent(world, { t: 'tsunami', x: q.x, y: q.y, m: q.height, dead, n: place ? `the great wave off ${place}` : null, towns: q.towns });
    if (dead > 0) noteRecord(world, 'wave.dead', dead, { label: e.n || 'a great wave', ref: { k: 'event', id: e.id }, x: q.x, y: q.y, place });
  },
  eruption(world, q) {
    if (!q) return;
    const vei = fin(q.vei), dead = fin(q.deaths);
    if (vei < 3 && dead < 10) return;
    const v = q.volcanoId != null ? world.volcanoes.find((o) => o.id === q.volcanoId) : null;
    const e = pushEvent(world, { t: 'eruption', x: q.x ?? v?.x, y: q.y ?? v?.y, m: vei, dead, n: v?.name || q.name || null, towns: q.towns, ref: v ? { k: 'volcano', id: v.id } : null });
    const meta = { label: e.n || 'a fire mountain', ref: v ? { k: 'volcano', id: v.id } : { k: 'event', id: e.id }, x: e.x, y: e.y, place: e.n, holder: null };
    noteRecord(world, 'eruption.vei', vei + Math.min(0.9, Math.log10(1 + dead) / 10), { ...meta, shown: vei });
    if (dead > 0) noteRecord(world, 'eruption.dead', dead, meta);
  },
  impact(world, q) {
    if (!q) return;
    const place = lbl(world, q.x, q.y);
    const e = pushEvent(world, { t: 'impact', x: q.x, y: q.y, m: q.r, dead: q.deaths, n: place ? theNamed(place, 'star-fall') : null, towns: q.towns, o: q.ocean ? 1 : undefined });
    noteRecord(world, 'impact.r', fin(q.r), { label: e.n || 'a falling star', ref: { k: 'event', id: e.id }, x: q.x, y: q.y, place });
  },
  flood(world, q) {
    if (!q) return;
    const dead = fin(q.deaths);
    if (dead < 1 && !(q.towns && q.towns.length)) return;
    const place = lbl(world, q.x, q.y);
    const e = pushEvent(world, { t: 'flood', x: q.x, y: q.y, m: (q.towns || []).length, dead, n: place ? theNamed(place, 'flood') : null, towns: q.towns });
    if (dead > 0) noteRecord(world, 'flood.dead', dead, { label: e.n || 'a flood', ref: { k: 'event', id: e.id }, x: q.x, y: q.y, place });
  },
  locusts(world, q) {
    if (!q) return;
    const eaten = fin(q.foodEaten);
    if (eaten < 500) return;
    pushEvent(world, { t: 'locusts', x: q.x, y: q.y, m: eaten, dead: 0, n: null });
  },
  stormEnded(world, q) {
    if (!q) return;
    const dead = fin(q.deaths), lf = fin(q.landfalls);
    const towns = Array.isArray(q.towns) ? q.towns : [];
    if (!(dead > 0 || towns.length || (q.kind === 'cyclone' && lf > 0))) return;
    const tr = trackOf(q.track);
    const mid = tr ? tr[tr.length >> 1] : null;
    const peakPt = tr ? tr.reduce((a, p) => (p[2] > a[2] ? p : a), tr[0]) : null;
    const at = peakPt || mid;
    const x = fin(q.x, at ? at[0] : 0), y = fin(q.y, at ? at[1] : 0);
    const e = pushEvent(world, { t: 'storm', k: q.kind || 'storm', x, y, m: fin(q.category), dead, n: q.name || null, towns, lf: lf || undefined, sid: q.id, pk: r2(q.peak), tr, ref: q.id != null ? { k: 'storm', id: q.id } : null });
    const meta = { label: e.n || `a ${q.kind || 'storm'}`, ref: q.id != null ? { k: 'storm', id: q.id } : { k: 'event', id: e.id }, x, y, place: lbl(world, x, y) };
    if (dead > 0) noteRecord(world, 'storm.dead', dead, meta);
    if (q.kind === 'cyclone' || fin(q.category) > 0) noteRecord(world, 'storm.cat', fin(q.category) + Math.min(0.99, fin(q.peak) / 1.01), { ...meta, shown: fin(q.category) });
  },
  fireEnded(world, fire) {
    if (!fire) return;
    const tiles = fin(fire.tiles);
    if (!fire.name || tiles < 20) return;
    if (eventStore(world).some((e) => e.t === 'fire' && e.ref && e.ref.id === fire.id)) return;
    const e = pushEvent(world, { t: 'fire', x: fire.x, y: fire.y, m: tiles, dead: fire.deaths, n: fire.name, towns: (fire.hit || []).map((h) => (h && typeof h === 'object' ? h.sid : h)), ref: { k: 'fire', id: fire.id } });
    noteRecord(world, 'fire.tiles', tiles, { label: e.n, ref: { k: 'fire', id: fire.id }, x: fire.x, y: fire.y, place: lbl(world, fire.x, fire.y) });
  },
  famine(world, q) {
    if (!q) return;
    const s = world.settlements[q.sid];
    const dead = fin(q.deaths);
    if (!s || dead < 50) return;
    const e = pushEvent(world, { t: 'famine', x: s.x, y: s.y, m: fin(q.months), dead, n: `the hunger in ${s.name}`, towns: [s.id], mo: fin(q.months) || undefined, ref: { k: 'settlement', id: s.id } });
    noteRecord(world, 'famine.dead', dead, { label: e.n, ref: { k: 'settlement', id: s.id }, x: s.x, y: s.y, place: s.name, civId: s.civId });
  },
};

for (const [name, fn] of Object.entries(HANDLERS)) on(name, fn);

// ---------------------------------------------------------------------------

/** Counts per type (reports, the Annals). */
export function catalogueStats(world) {
  const out = { n: 0, byType: {}, bytes: 0 };
  const list = world?.history?.events || [];
  out.n = list.length;
  for (const e of list) out.byType[e.t] = (out.byType[e.t] || 0) + 1;
  out.bytes = JSON.stringify(list).length;
  return out;
}

/** Is a tile on water? (fallbacks decide ocean impacts with it) */
export const isWaterAt = (world, x, y) => {
  const xi = Math.max(0, Math.min(world.W - 1, Math.round(x))), yi = Math.max(0, Math.min(world.H - 1, Math.round(y)));
  return world.f.water[yi * world.W + xi] !== WATER.LAND;
};
