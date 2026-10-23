// Keyframes: in-memory snapshots of a whole world, for undo, rewind and branches (WP8's
// chronoscope). A keyframe plus the intervention log replays to any later day exactly
// (core/replay.js), because the sim is deterministic given state + rng + logged acts.
//
// keyframe = { day, ivSeq, check, rng: [4 × uint32], keys: [world key order],
//              fields: { name: TypedArray copy },
//              state: deep copy of world minus f, cache, fx, rng, history, chronicle, ui,
//              history: { years: slice, atlas: slice, events: slice, series: deep copy, … },
//              chronicle: { seq, entries: slice } }
// History records and chronicle entries are immutable once pushed (SPEC §1), so the slices
// share them by reference: a keyframe costs the fields plus one copy of the entity state.
// Keyframes are immutable once taken and live only in memory (except in branch saves, WP8).
//
// Shared copies. By Y1000 most of the entity state is closed: ended wars with their ledgers,
// inactive trade routes, fallen realms, frozen ledger series, fallen bands' summaries. They are
// (almost) never edited again, so their copies are cached by object identity and one copy is
// shared by every keyframe taken while the record stays untouched; a keyframe then copies
// little more than the living world. The same holds for historic sites (edited only by
// core/sites.js and sim/sites.js, which touch what they change) and for entity effects lists
// (core/effects.js stores a new list on every write). Every code path that edits a closed
// record afterwards (ledger compaction, shedding, pruning, late army summaries…) calls
// touchRecord(world, rec), which drops that record's copy; bumping world.versions.archive drops
// them all. Restores deep-copy the keyframe again, so a restored world never shares an object
// with a keyframe, and keyframes are never edited. KEYFRAME_DEV.verify = true checks every
// shared copy against its record at each capture (tools/headless.mjs --trial and
// --keyframe-check turn it on) and lists the misses.

import { RNG } from './rng.js';
import { SAVE_SKIP } from './serialize.js';
import { normalizeWorld, defaultUi } from './world.js';
import { emit } from './hooks.js';

/** World keys a keyframe does not deep-clone (the save SKIP set plus shared/viewer state). */
export const KEYFRAME_SKIP = new Set([...SAVE_SKIP, 'history', 'chronicle', 'ui']);

/**
 * Deep copy of plain JSON-like data (objects, arrays, primitives; also undefined, NaN, ±0 and
 * holes, as structuredClone keeps them). Several times faster than structuredClone on entity
 * state. Anything else (a typed array or Map that should not be there) goes to structuredClone.
 * World state has no shared or cyclic references (it must survive JSON), which a plain walk
 * relies on.
 */
export function cloneData(v) {
  if (typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) {
    const n = v.length;
    if (n >= 16) {
      // long lists of plain values (series samples, paths, battle rows): one slice, which keeps
      // holes, undefined, NaN and -0 exactly as they are
      let flat = true;
      for (let i = 0; i < n; i++) { const x = v[i]; if (typeof x === 'object' && x !== null) { flat = false; break; } }
      if (flat) return v.slice();
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = v[i];
      if (x === undefined && !(i in v)) continue;
      out[i] = typeof x === 'object' && x !== null ? cloneData(x) : x;
    }
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return structuredClone(v);
  const out = {};
  const ks = Object.keys(v);
  for (let j = 0; j < ks.length; j++) {
    const k = ks[j], x = v[k];
    out[k] = typeof x === 'object' && x !== null ? cloneData(x) : x;
  }
  return out;
}
const clone = cloneData;

// ---------------------------------------------------------------------------
// Shared copies

const NEVER = () => false, ALWAYS = () => true;
/**
 * World lists copied record by record: list → closed(record). A closed record's copy is shared
 * from the cache (wars that ended, routes that broke, realms that fell; every site, since the
 * site writers touch what they change); an open one is copied, its effects list shared (below).
 */
const LISTS = {
  wars: (w) => w.active === false,
  tradeRoutes: (r) => r.active === false,
  civs: (c) => c.alive === false,
  settlements: NEVER,
  sites: ALWAYS,
  caravans: NEVER,
  armies: NEVER,
  bands: NEVER,
};
/**
 * Arrays shared by identity wherever they sit on a copied record, because no code edits them
 * in place: core/effects.js stores a new effects list (of new effect objects) on every write,
 * and a path (a route's, a carrier's, an army's, a band's) is only ever replaced. A list's copy
 * holds for as long as the record keeps that very array.
 */
const SHARED_KEYS = new Set(['effects', 'path']);
/** sys[system][key] lists of immutable records (a fallen band's summary is never edited). */
const SYS_ARCHIVES = { bands: 'archive' };
/** Ledger series (history.series[kind][id]) freeze when their entity ends. */
const frozenSeries = (ser) => ser.e != null;

/** object → { w: world, v: versions.archive at copy time, c: the shared copy }. Cache only. */
const COPIES = new WeakMap();

/** Debug aid: verify every shared copy at capture (slow; tests only). misses: [{ list, id, path, day }]. */
export const KEYFRAME_DEV = { verify: false, misses: [], hits: 0, copies: 0 };

/**
 * A closed record (an ended war, an inactive route, a fallen realm, a frozen ledger series, a
 * historic site) was edited: the next keyframe copies it afresh. Cheap; safe on any object.
 */
export function touchRecord(world, rec) {
  if (rec && typeof rec === 'object') COPIES.delete(rec);
}

/** The shared copy of obj (made now if missing or stale). */
function copyOf(world, obj, where, id) {
  const v = world.versions.archive | 0;
  let e = COPIES.get(obj);
  if (e && e.w === world && e.v === v) {
    if (KEYFRAME_DEV.verify) {
      const path = firstDiff(obj, e.c, '');
      if (path != null) {
        KEYFRAME_DEV.misses.push({ list: where, id, path, day: world.time.day });
        e = null;
      }
    }
    if (e) { KEYFRAME_DEV.hits++; return e.c; }
  }
  KEYFRAME_DEV.copies++;
  e = { w: world, v, c: cloneData(obj) };
  COPIES.set(obj, e);
  return e.c;
}

/** Copy of an open record: like cloneData, but its SHARED_KEYS arrays come from the cache. */
function copyRecord(world, rec, where, id) {
  const proto = Object.getPrototypeOf(rec);
  if (Array.isArray(rec) || (proto !== Object.prototype && proto !== null)) return cloneData(rec);
  // one shallow spread (fast for records of fifty-odd keys), then the nested containers
  const out = { ...rec };
  const ks = Object.keys(rec);
  for (let j = 0; j < ks.length; j++) {
    const k = ks[j], x = rec[k];
    if (typeof x === 'object' && x !== null) out[k] = SHARED_KEYS.has(k) && Array.isArray(x) ? copyOf(world, x, `${where}.${k}`, id) : cloneData(x);
  }
  return out;
}

/** Copy of a world list: closed records shared, open ones copied (with their shared arrays). */
function copyList(world, list, closed, where) {
  const n = list.length, out = new Array(n);
  for (let k = 0; k < n; k++) {
    const x = list[k];
    if (x === undefined && !(k in list)) continue;
    if (typeof x !== 'object' || x === null) { out[k] = x; continue; }
    if (closed(x)) out[k] = copyOf(world, x, where, k);
    else { COPIES.delete(x); out[k] = copyRecord(world, x, where, k); }   // (records never reopen; if one did, its old copy goes)
  }
  return out;
}

/** world.sys: each system's state copied, its archive lists of immutable records shared. */
function copySys(world, sys) {
  if (typeof sys !== 'object' || sys === null || Array.isArray(sys)) return clone(sys);
  const out = {};
  for (const id of Object.keys(sys)) {
    const st = sys[id], ak = SYS_ARCHIVES[id];
    if (!ak || typeof st !== 'object' || st === null || Array.isArray(st) || !Array.isArray(st[ak])) { out[id] = clone(st); continue; }
    const o = {};
    for (const k of Object.keys(st)) o[k] = k === ak ? copyList(world, st[k], ALWAYS, `sys.${id}.${k}`) : clone(st[k]);
    out[id] = o;
  }
  return out;
}

/** history.series: frozen series shared from the cache, the rest copied. */
function copySeries(world, series) {
  if (typeof series !== 'object' || series === null || Array.isArray(series)) return clone(series);
  const out = {};
  for (const kind of Object.keys(series)) {
    const store = series[kind];
    if (typeof store !== 'object' || store === null || Array.isArray(store)) { out[kind] = clone(store); continue; }
    const o = {};
    for (const id of Object.keys(store)) {
      const ser = store[id];
      o[id] = typeof ser === 'object' && ser !== null && frozenSeries(ser) ? copyOf(world, ser, 'series.' + kind, id) : clone(ser);
    }
    out[kind] = o;
  }
  return out;
}

/**
 * Path of the first difference between two data trees ('' = the roots), or null when they
 * are the same data (key order, holes, undefined, NaN and -0 included).
 */
export function firstDiff(a, b, path = '') {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return Object.is(a, b) ? null : path;
  const aa = Array.isArray(a);
  if (aa !== Array.isArray(b)) return path;
  if (aa) {
    if (a.length !== b.length) return path + '.length';
    for (let i = 0; i < a.length; i++) {
      if ((i in a) !== (i in b)) return `${path}[${i}]`;
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d != null) return d;
    }
    return null;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return path + '{keys}';
  for (let j = 0; j < ka.length; j++) {
    if (ka[j] !== kb[j]) return path + '{order}';
    const d = firstDiff(a[ka[j]], b[ka[j]], path + '.' + ka[j]);
    if (d != null) return d;
  }
  return null;
}

/** Arrays are sliced (items shared), anything else copied (the ledger's series via the cache when a world is given). */
function snapHistory(h, world = null) {
  const out = {};
  for (const k of Object.keys(h || {})) out[k] = Array.isArray(h[k]) ? h[k].slice() : world && k === 'series' ? copySeries(world, h[k]) : clone(h[k]);
  return out;
}

/** Snapshot the world. Pure: never touches world state or rng (it seals the log in world.cache). */
export function captureKeyframe(world) {
  // a brush tick after this must not join an entry the keyframe already holds (core/tools.js)
  world.cache.ivSeal = (world.interventions || []).length;
  const state = {};
  for (const k of Object.keys(world)) {
    if (KEYFRAME_SKIP.has(k)) continue;
    const v = world[k];
    state[k] = LISTS[k] && Array.isArray(v) ? copyList(world, v, LISTS[k], k) : k === 'sys' ? copySys(world, v) : clone(v);
  }
  const fields = {};
  for (const [name, a] of Object.entries(world.f)) fields[name] = a.slice();
  const ch = world.chronicle || { seq: 0, entries: [] };
  const chron = {};
  for (const k of Object.keys(ch)) chron[k] = k === 'entries' ? ch.entries.slice() : clone(ch[k]);
  return {
    day: world.time.day,
    ivSeq: (world.interventions || []).length,
    check: worldChecksum(world),
    rng: world.rng.state.slice(),
    keys: Object.keys(world),
    fields,
    state,
    history: snapHistory(world.history, world),
    chronicle: chron,
  };
}

/**
 * Build a new live world from a keyframe (the keyframe stays reusable). opts.ui: the viewer
 * state to keep (pass the current world's ui; default empty). Versions are bumped, cache is {}
 * and fx is []; emits worldLoaded. Run system init next (sim.setWorld(world)).
 */
export function restoreKeyframe(kf, opts = {}) {
  // a full deep copy: the keyframe (and the closed-record copies it shares with other
  // keyframes) never meets the live world
  const state = cloneData(kf.state);
  const parts = {
    ...state,
    f: Object.fromEntries(Object.entries(kf.fields).map(([n, a]) => [n, a.slice()])),
    rng: RNG.fromState(kf.rng),
    history: snapHistory(kf.history),
    chronicle: (() => {
      const c = {};
      for (const k of Object.keys(kf.chronicle)) c[k] = k === 'entries' ? kf.chronicle.entries.slice() : clone(kf.chronicle[k]);
      return c;
    })(),
    ui: opts.ui !== undefined && opts.ui !== null ? opts.ui : defaultUi(),
    cache: {},
    fx: [],
  };
  // rebuild in the original key order, so a restored world serialises like the original
  const world = {};
  for (const k of kf.keys || Object.keys(parts)) if (k in parts) world[k] = parts[k];
  for (const k of Object.keys(parts)) if (!(k in world)) world[k] = parts[k];
  world.versions = { ...world.versions };
  for (const k of Object.keys(world.versions)) world.versions[k]++;
  normalizeWorld(world);
  emit(world, 'worldLoaded');
  return world;
}

// ---------------------------------------------------------------------------
// Checksum

/**
 * FNV-style hash (hex) over owner, elevation (every 7th tile), rounded popDensity, settlement
 * populations, civ treasuries, bands, armies, active wars, sites, the war and figure counts,
 * rng.state, chronicle.seq and day. Mixes 32-bit words (one
 * multiply each) so it is cheap enough to take with every keyframe (≈ 0.3 ms, medium map);
 * equal checksums mean two runs agree on everything that matters.
 */
export function worldChecksum(world) {
  const PRIME = 0x01000193;
  let h = 0x811c9dc5 | 0;
  const num = (v, scale = 1000) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) { h = Math.imul(h ^ 0x7fc00000, PRIME); return; }
    const q = Math.round(v * scale);
    h = Math.imul(h ^ (q | 0), PRIME);
    h = Math.imul(h ^ (Math.floor(q / 4294967296) | 0), PRIME);
  };
  const f = world.f;
  h = Math.imul(h ^ (world.time.day | 0), PRIME);
  for (const s of world.rng.state) h = Math.imul(h ^ (s | 0), PRIME);
  h = Math.imul(h ^ ((world.chronicle?.seq || 0) | 0), PRIME);
  const o = f.owner;
  if (o) {
    const n = o.length;
    let i = 0;
    for (; i + 1 < n; i += 2) h = Math.imul(h ^ ((o[i] & 0xffff) | (o[i + 1] << 16)), PRIME);
    if (i < n) h = Math.imul(h ^ (o[i] & 0xffff), PRIME);
  }
  if (f.elevation) for (let i = 0; i < f.elevation.length; i += 7) num(f.elevation[i], 1e5);
  const p = f.popDensity;
  if (p) for (let i = 0; i < p.length; i++) { const v = p[i]; h = Math.imul(h ^ (v === v ? Math.round(v) | 0 : 0x7fc00000), PRIME); }
  for (const s of world.settlements || []) { h = Math.imul(h ^ ((s.id << 1) | (s.alive ? 1 : 0)), PRIME); num(s.population); }
  for (const c of world.civs || []) { h = Math.imul(h ^ (c.alive ? 1 : 2), PRIME); num(c.treasury || 0); }
  // the moving and lesser entities too (O(entities), rounded like the rest): a save, restore or
  // replay that loses a band's step, an army's march, a war's score or a site's fame shows here
  for (const b of world.bands || []) { if (!b) continue; h = Math.imul(h ^ (b.id | 0), PRIME); num(b.x, 100); num(b.y, 100); num(b.hp || 0, 100); num((b.strength || 0) + (b.power || 0)); }
  for (const a of world.armies || []) { if (!a) continue; h = Math.imul(h ^ (a.id | 0), PRIME); num(a.x, 100); num(a.y, 100); num(a.strength || 0); }
  for (const war of world.wars || []) { if (!war || !war.active) continue; h = Math.imul(h ^ (war.id | 0), PRIME); num(war.warScore || 0); h = Math.imul(h ^ (war.battles | 0), PRIME); }
  h = Math.imul(h ^ ((world.wars?.length || 0) | 0), PRIME);
  for (const s of world.sites || []) { if (!s) continue; h = Math.imul(h ^ (s.id | 0), PRIME); h = Math.imul(h ^ (s.n | 0), PRIME); num(s.fame || 0, 100); }
  h = Math.imul(h ^ ((world.figures?.length || 0) | 0), PRIME);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** FNV-1a (hex) of any JSON-safe value (used by headless --determinism on serializeWorld output). */
export function jsonHash(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
