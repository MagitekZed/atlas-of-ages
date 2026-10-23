// Event registry: the deck of things that can happen to a town, a realm, a pair of realms, a
// land, the world or a figure. Packages register defs at import; the engine (WP1,
// src/sim/events/engine.js) schedules checks and fires them. The kernel only stores the defs.
//
// def = { id, scale, family, cat, imp,
//         minEra?, maxEra?, minMyth? (default 0), maxMyth? (default 2),
//         cooldownYears, tags?: [string],
//         weight(ctx) → expected firings per check   pure: no rng, no allocation
//         fire(ctx)                                  uses world.rng, addEffect, kernel functions and
//                                                    published exports; writes its chronicle entry
//                                                    with key 'event.' + id, a ref and a cause }
// ctx = { world, day, era, scale, s?, civ?, a?, b?, land?: { feature, lm }, heat(tag), mythLevel }
// The engine excludes defs outside their myth / era bounds before summing weights, and each
// check draws exactly one rng.next() (plus one weightedIndex pick only when it fires) — so a
// def that is out of bounds (e.g. a folklore deck at mythLevel 0) never changes history.

export const EVENT_SCALES = ['town', 'realm', 'pair', 'land', 'world', 'figure'];

const BY_SCALE = Object.fromEntries(EVENT_SCALES.map((s) => [s, []]));
const BY_ID = Object.create(null);
let version = 1;

/** Register (or replace, by id) an event def. Lists stay sorted by id (import order never matters). */
export function registerEvent(def) {
  if (!def || !def.id) throw new Error('registerEvent: id required');
  if (!BY_SCALE[def.scale]) throw new Error(`registerEvent(${def.id}): unknown scale "${def.scale}"`);
  if (typeof def.weight !== 'function' || typeof def.fire !== 'function') throw new Error(`registerEvent(${def.id}): weight() and fire() required`);
  const d = {
    family: 'misc', cat: 'civ', imp: 2, cooldownYears: 0, tags: [],
    ...def,
    minMyth: Number.isFinite(def.minMyth) ? def.minMyth : 0,
    maxMyth: Number.isFinite(def.maxMyth) ? def.maxMyth : 2,
  };
  const old = BY_ID[d.id];
  if (old) {
    const list = BY_SCALE[old.scale];
    const k = list.indexOf(old);
    if (k >= 0) list.splice(k, 1);
  }
  BY_ID[d.id] = d;
  const list = BY_SCALE[d.scale];
  list.push(d);
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  version++;
  return d;
}

/** Defs of one scale, sorted by id. The array is shared: read it, never mutate it. */
export const getEvents = (scale) => BY_SCALE[scale] || [];
/** A def by id, or null. */
export const getEvent = (id) => BY_ID[id] || null;
/** Every def, grouped by scale order then id. */
export const allEvents = () => EVENT_SCALES.flatMap((s) => BY_SCALE[s]);
/** Process-local counter bumped by every registration (for lazily built engine tables). */
export const eventsVersion = () => version;
