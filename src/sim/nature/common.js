// Shared helpers for the nature systems (climate, weather, ecology, disasters):
// branch-free maths for hot loops, chronicle rate limiting, prose formatting and
// small JSON-safe utilities. DOM-free, no module-level mutable state.

import { DAYS_PER_YEAR, KM_PER_TILE } from '../../core/constants.js';
import { now } from '../../core/util.js';
import { emit } from '../../core/hooks.js';
import { mulOf, hasProviders } from '../../core/ext.js';

/** Branch-free clamp (Math.min/max compile to min/max instructions; ternaries can mispredict). */
export const cl01 = (v) => Math.min(1, Math.max(0, v));
export const clampR = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Smoothstep that also works reversed (e0 > e1). Callers never pass e0 === e1. */
export const ss = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** Finite-or-default. */
export const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** Gaussian bump centred on c with half-width w. */
export const bell = (x, c, w) => { const d = (x - c) / w; return Math.exp(-d * d); };

export const yearNum = (world, day = world.time.day) => Math.floor(day / DAYS_PER_YEAR);
export const tileAreaKm2 = KM_PER_TILE * KM_PER_TILE;

// ---------------------------------------------------------------------------
// Chronicle rate limiting. Each system keeps `world.sys[id].rl = { key: lastDay }`.

/** True (and records today) if `key` has not fired within `gapYears`. */
export function rateOk(sys, key, day, gapYears) {
  const rl = (sys.rl ||= {});
  const last = rl[key];
  if (last != null && day - last < gapYears * DAYS_PER_YEAR) return false;
  rl[key] = day;
  return true;
}
/** Check without recording. */
export function ratePeek(sys, key, day, gapYears) {
  const last = sys.rl?.[key];
  return !(last != null && day - last < gapYears * DAYS_PER_YEAR);
}
/** Drop limiter keys older than maxYears so the object never grows without bound. */
export function rateprune(sys, day, maxYears = 200) {
  if (!sys.rl) return;
  const cut = maxYears * DAYS_PER_YEAR;
  for (const k of Object.keys(sys.rl)) if (day - sys.rl[k] > cut) delete sys.rl[k];
}

// ---------------------------------------------------------------------------
// Prose helpers

export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** 12345 → "12,345" (deterministic, locale-free). */
export function fmtInt(n) {
  n = Math.round(fin(n));
  const neg = n < 0; let s = String(Math.abs(n));
  for (let k = s.length - 3; k > 0; k -= 3) s = s.slice(0, k) + ',' + s.slice(k);
  return neg ? '-' + s : s;
}
/** Rounded to a "chronicler's" figure: 1,234 → "1,200", 87 → "90". */
export function fmtRough(n) {
  n = Math.max(0, fin(n));
  if (n < 20) return String(Math.round(n));
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return fmtInt(Math.round(n / mag) * mag);
}
/** Tile count → "6,400 km²". */
export const fmtArea = (tiles) => fmtRough(tiles * tileAreaKm2) + ' km²';
/** ["A","B","C"] → "A, B and C". */
export function listJoin(items, conj = 'and') {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a[0] || '';
  return a.slice(0, -1).join(', ') + ' ' + conj + ' ' + a[a.length - 1];
}
/** Pick a template from a pool with the world RNG. */
export const pick = (world, arr) => arr[Math.floor(world.rng.next() * arr.length)] ?? arr[0];
/** Ordinal words for small counts. */
export const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export const numberWord = (n) => (['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][n] ?? fmtInt(n));

/** Deaths phrasing for a chronicle clause, e.g. "killing some 1,200". */
export function deathsClause(n) {
  n = Math.round(fin(n));
  if (n <= 0) return '';
  if (n < 10) return 'killing a handful';
  if (n < 60) return `killing ${fmtRough(n)}`;
  return `killing some ${fmtRough(n)}`;
}

// ---------------------------------------------------------------------------
// Misc

/** Poisson sample (small means) from the world RNG. */
export function poisson(rng, mean) {
  if (!(mean > 0)) return 0;
  if (mean > 30) return Math.max(0, Math.round(rng.normal(mean, Math.sqrt(mean))));
  const L = Math.exp(-mean);
  let k = 0, p = 1;
  do { k++; p *= rng.next(); } while (p > L && k < 200);
  return k - 1;
}

/** Iterate integer tiles in a disc: fn(i, x, y, d) with d = distance / radius in [0, 1]. */
export function forDisc(world, cx, cy, r, fn) {
  const { W, H } = world;
  const R = Math.max(0, r);
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
  const inv = 1 / Math.max(0.5, R);
  const R2 = (R + 0.5) * (R + 0.5);
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > R2) continue;
      fn(y * W + x, x, y, Math.min(1, Math.sqrt(d2) * inv));
    }
  }
}

/**
 * Every derived-data key the nature systems keep in world.cache. Creating them all up
 * front (as null) keeps the cache object's shape stable after init, so optimised code
 * that reads it is not thrown away when a cache is first built months into a run.
 */
const NAT_CACHE_KEYS = ['natAmp', 'natAnomBlur', 'natAnomNoise', 'natAnomTile', 'natBands', 'natBfs', 'natCapStatic', 'natCellW',
  'natClimRows', 'natEcoWater', 'natEcoZero', 'natFire', 'natHunt', 'natIceV', 'natLandList', 'natLandRuns', 'natLocust',
  'natPrevBiome', 'natQuakeCdf', 'natRegionIdx', 'natSteer', 'natStormCand', 'natUp8', 'natVegRep', 'natUpwell', 'natUpTmp', 'natWaterRuns', 'natWx', 'natWxDirty', 'natWxInit',
  'natWxSeed', 'natZero'];
export function primeCache(world) {
  const c = world.cache || (world.cache = {});
  for (const k of NAT_CACHE_KEYS) if (!(k in c)) c[k] = null;
}

/** Ensure world.sys[id] exists and return it. */
export function sysOf(world, id) { return (world.sys[id] ||= {}); }

// ---------------------------------------------------------------------------
// Opt-in phase timing for development: set world.cache.natProf = {} to collect
// milliseconds per phase. Measurement only — never affects the simulation.

export const profStart = (world) => (world.cache.natProf ? now() : 0);
export function profEnd(world, key, t0) {
  const p = world.cache.natProf;
  if (p) p[key] = (p[key] || 0) + (now() - t0);
}

// ---------------------------------------------------------------------------
// Hooks (contracts §5). Every nature emit goes through emitHook, which also counts it in
// world.cache.wp4Hooks (shared with the geo systems' counters; for reports, never saved).

/** Emit a kernel hook and count it. */
export function emitHook(world, name, ...args) {
  const c = (world.cache.wp4Hooks ||= {});
  c[name] = (c[name] || 0) + 1;
  emit(world, name, ...args);
}

/** The ext 'rates' multiplier for a nature key ('quake', 'volcano', 'meteor', 'storm', 'wildfire'). */
export const rateMul = (world, key) => (hasProviders('rates') ? mulOf('rates', world, key) : 1);
