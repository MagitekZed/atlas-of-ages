// Heat: how much a subject is primed for a kind of event. A fire heats 'blame' and 'rebuild'
// in its town, a riot heats 'unrest' in its realm, a border skirmish heats 'feud' between two
// realms; later weights read that heat, so causal chains emerge without scripts. Saved as
// sys.events.heat['tag|subject'] (with the chronicle seq that lit it in sys.events.hsrc),
// decays ×0.9 a year and is forgotten below 0.05.
//
// Subject keys: town 's<id>', realm 'c<id>', pair 'p<lo>_<hi>', land 'l<landmass>', world 'w'.
// Reads go through a per-subject index kept in world.cache (rebuilt from the saved map after a
// load, updated on every write), so weight() can ask ctx.heat(tag) without allocating.

import { HEAT_DECAY, HEAT_MIN } from './data.js';

// subject keys are asked for thousands of times a year: keep one string per id
const TOWN_KEYS = [], REALM_KEYS = [];
export const SUBJ = {
  town: (id) => TOWN_KEYS[id] || (TOWN_KEYS[id] = 's' + id),
  realm: (id) => REALM_KEYS[id] || (REALM_KEYS[id] = 'c' + id),
  pair: (a, b) => (a < b ? 'p' + a + '_' + b : 'p' + b + '_' + a),
  land: (lm) => 'l' + lm,
  world: 'w',
};

const NONE = Object.freeze({});

function store(world) {
  const st = world.sys.events;
  st.heat ||= {};
  st.hsrc ||= {};
  return st;
}

/** subject → { tag: value }, mirrored from the saved flat map. */
function index(world) {
  const c = world.cache;
  if (c.evHeat) return c.evHeat;
  const idx = Object.create(null);
  const h = store(world).heat;
  for (const k in h) {
    const bar = k.indexOf('|');
    if (bar < 0) continue;
    const tag = k.slice(0, bar), subj = k.slice(bar + 1);
    (idx[subj] ||= Object.create(null))[tag] = h[k];
  }
  c.evHeat = idx;
  return idx;
}

/** The heat map of one subject (frozen empty object when cold). Never mutate it. */
export const heatMap = (world, subj) => index(world)[subj] || NONE;
/** Heat of a tag on a subject (0 when cold). */
export function heatOf(world, tag, subj) {
  const m = index(world)[subj];
  return (m && m[tag]) || 0;
}
/** Chronicle seq of the entry that last heated tag on subj, or null. */
export function heatSource(world, tag, subj) {
  const v = store(world).hsrc[tag + '|' + subj];
  return Number.isFinite(v) ? v : null;
}

/** Add heat (clamped to 0..3); src is the chronicle seq that caused it (for "Because …"). */
export function addHeat(world, tag, subj, amt, src = null) {
  if (!tag || subj == null || !Number.isFinite(amt) || amt === 0) return 0;
  const st = store(world);
  const k = tag + '|' + subj;
  const v = Math.max(0, Math.min(3, (st.heat[k] || 0) + amt));
  const idx = index(world);
  if (v < HEAT_MIN) {
    delete st.heat[k]; delete st.hsrc[k];
    if (idx[subj]) delete idx[subj][tag];
    return 0;
  }
  st.heat[k] = Math.round(v * 1e4) / 1e4;
  if (src != null && amt > 0) st.hsrc[k] = src;
  (idx[subj] ||= Object.create(null))[tag] = st.heat[k];
  return st.heat[k];
}

/** Cool a tag on a subject by a fraction (0..1) — an event that spends the heat it fed on. */
export function spendHeat(world, tag, subj, frac = 1) {
  const cur = heatOf(world, tag, subj);
  if (cur > 0) addHeat(world, tag, subj, -cur * Math.max(0, Math.min(1, frac)));
}

/** Yearly: decay every heat ×0.9 and forget the cold ones. */
export function decayHeat(world) {
  const st = store(world);
  for (const k of Object.keys(st.heat)) {
    const v = st.heat[k] * HEAT_DECAY;
    if (v < HEAT_MIN) { delete st.heat[k]; delete st.hsrc[k]; } else st.heat[k] = Math.round(v * 1e4) / 1e4;
  }
  for (const k of Object.keys(st.hsrc)) if (!(k in st.heat)) delete st.hsrc[k];
  world.cache.evHeat = null;
}

/** Forget every heat of a subject (a destroyed town, a fallen realm). */
export function clearSubject(world, subj) {
  const st = store(world);
  const tail = '|' + subj;
  let any = false;
  for (const k of Object.keys(st.heat)) if (k.endsWith(tail)) { delete st.heat[k]; delete st.hsrc[k]; any = true; }
  if (any) world.cache.evHeat = null;
}
