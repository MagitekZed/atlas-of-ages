// Timed effects on civs and settlements: the common currency of events, divine acts, ages
// and magic. An effect is a small bag of modifiers with an expiry day:
//
//   eff = { k, until, m: { key: number }, src?, label? }
//     k      unique key per entity; adding an effect with the same k replaces the old one
//     until  day it expires (exclusive), or −1 for permanent
//     m      modifiers. Civ effects use civ mods keys (DEFAULT_MODS + registered keys) with
//            applyFx semantics (WP3 computeMods). Settlement effects use SETTLEMENT_MOD_KEYS.
//     src    optional chronicle seq that caused it;  label  optional display text
//
// Stored on the entity: entity.effects = [eff] (≤ 12) and entity.effectsV (bumped on every
// write, with world.versions.effects). Only this module writes them.
// target = { kind: 'civ' | 'settlement', id }.

import { bumpVersion } from './world.js';
import { DAYS_PER_MONTH } from './constants.js';

export const MAX_EFFECTS = 12;

/**
 * Settlement modifier keys. add: summed then clamped (neutral 0); mul: multiplied then clamped
 * (neutral 1). Readers: WP3 all except trade/plagueDose/fireRisk/raidRisk; WP4 trade,
 * plagueDose, defense; WP1 fireRisk; WP2 raidRisk.
 */
export const SETTLEMENT_MOD_KEYS = Object.freeze({
  happiness: Object.freeze({ kind: 'add', limit: [-0.4, 0.4] }),
  unrest: Object.freeze({ kind: 'add', limit: [-0.5, 0.5] }),
  loyalty: Object.freeze({ kind: 'add', limit: [-0.5, 0.5] }),
  health: Object.freeze({ kind: 'add', limit: [-0.4, 0.4] }),
  defense: Object.freeze({ kind: 'add', limit: [-0.5, 1] }),
  foodYield: Object.freeze({ kind: 'mul', limit: [0.3, 2] }),
  production: Object.freeze({ kind: 'mul', limit: [0.3, 2] }),
  trade: Object.freeze({ kind: 'mul', limit: [0, 2.5] }),
  culture: Object.freeze({ kind: 'mul', limit: [0.3, 3] }),
  birth: Object.freeze({ kind: 'mul', limit: [0.3, 2] }),
  mortality: Object.freeze({ kind: 'mul', limit: [0.3, 3] }),
  attract: Object.freeze({ kind: 'mul', limit: [0.2, 3] }),
  housing: Object.freeze({ kind: 'mul', limit: [0.5, 1.6] }),
  research: Object.freeze({ kind: 'mul', limit: [0.5, 2] }),
  plagueDose: Object.freeze({ kind: 'mul', limit: [0, 3] }),
  fireRisk: Object.freeze({ kind: 'mul', limit: [0, 4] }),
  raidRisk: Object.freeze({ kind: 'mul', limit: [0, 4] }),
});
const SKEYS = Object.keys(SETTLEMENT_MOD_KEYS);

const NEUTRAL_SMODS = Object.freeze(Object.fromEntries(SKEYS.map((k) => [k, SETTLEMENT_MOD_KEYS[k].kind === 'add' ? 0 : 1])));
/** The neutral settlement aggregate (all add keys 0, all mul keys 1). Frozen. */
export const neutralSettlementMods = () => NEUTRAL_SMODS;

function entityOf(world, target) {
  if (!target) return null;
  if (target.kind === 'civ') return world.civs[target.id] || null;
  if (target.kind === 'settlement') return world.settlements[target.id] || null;
  return null;
}
const live = (e, day) => e.until < 0 || e.until > day;

function touch(world, ent) {
  ent.effectsV = (ent.effectsV | 0) + 1;
  bumpVersion(world, 'effects');
}

/**
 * Add (or replace, by k) an effect. Expired effects are pruned on write. Over 12 effects, the
 * existing effect expiring soonest is dropped (permanent ones count as never expiring; ties →
 * the oldest). Returns the stored effect, or null when the target does not exist.
 */
export function addEffect(world, target, eff) {
  const ent = entityOf(world, target);
  if (!ent || !eff || eff.k == null) return null;
  const day = world.time.day;
  const m = {};
  if (eff.m && typeof eff.m === 'object') for (const key of Object.keys(eff.m)) { const v = eff.m[key]; if (typeof v === 'number' && Number.isFinite(v)) m[key] = v; }
  const until = Number.isFinite(eff.until) && eff.until >= 0 ? Math.floor(eff.until) : -1;
  const e = { k: String(eff.k), until, m };
  if (eff.src != null) e.src = eff.src;
  if (eff.label != null) e.label = String(eff.label);
  const list = (Array.isArray(ent.effects) ? ent.effects : []).filter((x) => x.k !== e.k && live(x, day));
  while (list.length >= MAX_EFFECTS) {
    let worst = 0;
    for (let k = 1; k < list.length; k++) {
      const a = list[k].until < 0 ? Infinity : list[k].until, b = list[worst].until < 0 ? Infinity : list[worst].until;
      if (a < b) worst = k;
    }
    list.splice(worst, 1);
  }
  list.push(e);
  ent.effects = list;
  touch(world, ent);
  return e;
}

/** Remove the effect with key k. Returns true if one was removed. */
export function removeEffect(world, target, k) {
  const ent = entityOf(world, target);
  if (!ent || !Array.isArray(ent.effects)) return false;
  const day = world.time.day;
  const before = ent.effects.length;
  const list = ent.effects.filter((x) => x.k !== String(k) && live(x, day));
  const removed = ent.effects.some((x) => x.k === String(k) && live(x, day));
  if (list.length !== before) { ent.effects = list; touch(world, ent); }
  return removed;
}

/** Live effects of the target (until < 0 or until > today), oldest first. */
export function effectsOf(world, target) {
  const ent = entityOf(world, target);
  const list = ent && ent.effects;
  if (!list || !list.length) return [];
  const day = world.time.day;
  return list.filter((x) => live(x, day));
}

/** The live effect with key k, or null. */
export function getEffect(world, target, k) {
  const ent = entityOf(world, target);
  const list = ent && ent.effects;
  if (!list) return null;
  const day = world.time.day;
  for (const x of list) if (x.k === String(k) && live(x, day)) return x;
  return null;
}

/**
 * Aggregate settlement modifiers from its live effects: every SETTLEMENT_MOD_KEYS key, add keys
 * summed, mul keys multiplied, each clamped to its limit. Frozen; cached in world.cache.smods
 * by s.id | s.effectsV | month. An effect counts for the whole month in which it is live at
 * any point: liveness is judged at the month's first day, never at the day the cache happens
 * to fill, so a world loaded or restored mid-month reads exactly what a continuous run reads.
 * A settlement with no effects gets the shared neutral object at no cost.
 */
export function settlementMods(world, s) {
  if (!s || !s.effects || !s.effects.length) return NEUTRAL_SMODS;
  const month = Math.floor(world.time.day / DAYS_PER_MONTH);
  const cache = (world.cache.smods ||= {});
  const c = cache[s.id];
  const v = s.effectsV | 0;
  // the aggregate stays valid until the first month in which a live effect lapses
  if (c && c.v === v && month >= c.mo && month < c.mo1) return c.val;
  const monthStart = month * DAYS_PER_MONTH;
  const out = { ...NEUTRAL_SMODS };
  let any = false;
  let mo1 = Infinity;
  for (const e of s.effects) {
    if (!live(e, monthStart)) continue;
    if (typeof e.until === 'number' && e.until >= 0) { const m1 = Math.ceil(e.until / DAYS_PER_MONTH); if (m1 < mo1) mo1 = m1; }
    if (!e.m) continue;
    for (const key in e.m) {
      const spec = SETTLEMENT_MOD_KEYS[key];
      const x = e.m[key];
      if (!spec || typeof x !== 'number' || !Number.isFinite(x)) continue;
      if (spec.kind === 'add') out[key] += x; else out[key] *= x;
      any = true;
    }
  }
  let val = NEUTRAL_SMODS;
  if (any) {
    for (const key of SKEYS) {
      const [lo, hi] = SETTLEMENT_MOD_KEYS[key].limit;
      const x = out[key];
      out[key] = x < lo ? lo : x > hi ? hi : x;
    }
    val = Object.freeze(out);
  }
  cache[s.id] = { v, mo: month, mo1: Math.max(month + 1, mo1), val };
  return val;
}
