// Previews for the "Shape the Land" brushes (contracts §11), and the per-tile shaping rules the
// brushes themselves apply (terraform.js imports them), so the forecast is the stroke's own
// arithmetic: how far one application lifts or lowers the ground, how many applications until
// rock breaks the surface of the sea (Raise Island, Raise Land over water) or a coast goes under
// (Drown Land, Lower Land), the towns that would be drowned, the level Flatten works toward.
//
// Pure: no world.rng, no mutation of saved state (the brush noise lives in world.cache).
//
// Exports: brush, noiseFor, seaOf, raiseStep, lowerStep, mountainLift, sinkTarget, sinkStep,
//          islandTarget, islandStep, flattenLevel, and raisePreview, lowerPreview,
//          flattenPreview, mountainPreview, sinkPreview, islandPreview.

import { createNoise2D } from '../core/rng.js';
import { settlementsNear } from '../core/entities.js';
import { WATER } from '../core/constants.js';
import { clamp, DX8, DY8 } from '../core/util.js';
import { ridgedL, num } from './grid.js';

const KM2_PER_TILE = 400;
const MAX_STEPS = 60;

// ---------------------------------------------------------------------------
// Shared shaping rules

export const seaOf = (world) => { const v = Number(world.climate?.seaLevel); return Number.isFinite(v) ? v : 0.5; };
export const radiusOf = (opts, def) => clamp(num(opts?.radius, def), 0.75, 40);
export const strengthOf = (opts) => clamp(num(opts?.strength, 0.5), 0.01, 1);

/** Visit tiles within radius r of (cx, cy) with a smooth (1 − d²)² falloff weight. */
export function brush(world, cx, cy, r, fn) {
  const { W, H } = world;
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++) {
    const y = cy + dy; if (y < 0 || y >= H) continue;
    for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx; if (x < 0 || x >= W) continue;
      const d = Math.sqrt(dx * dx + dy * dy) / r;
      if (d >= 1) continue;
      const w = (1 - d * d) * (1 - d * d);
      fn(y * W + x, w, x, y);
    }
  }
}

/** The brush noise of this world (cache). */
export function noiseFor(world) {
  const c = world.cache;
  if (!c.terraNoise || c.terraNoiseSeed !== world.seed) {
    c.terraNoise = createNoise2D(world.seed + ':terraform');
    c.terraNoiseSeed = world.seed;
  }
  return c.terraNoise;
}

/** Raise Land: the new height of a tile at v under weight w (strength factor k = 0.014 × strength). */
export const raiseStep = (v, w, k) => v + k * w * clamp((1.04 - v) / 0.5, 0.08, 1.2);
/** Lower Land. */
export const lowerStep = (v, w, k) => v - k * w;
/** Raise Mountains: the lift at a tile (rid: the ridged noise there, 0..1). */
export const mountainLift = (v, w, k, rid, sea) => k * w * (0.4 + 0.8 * rid) * clamp((1.03 - v) / 0.45, 0.05, 1.6) * (v < sea ? 1.6 : 1);
/** Drown Land: the depth the sea is pulled down to. */
export const sinkTarget = (sea, str) => sea - (0.02 + 0.05 * str);
export const sinkStep = (v, w, str, target) => (v > target ? v - (v - target) * Math.min(1, w * (0.12 + 0.3 * str)) : v);
/** Raise Island: the height a tile is drawn toward (noise-shaped isle with a rocky heart). */
/**
 * True when tile i is a settled or claimed shore that a rising island leaves alone (with a strait
 * of sea beside it), so a new isle never dams a bay into a lake over a town. Wild coast and the
 * land this stroke raised (isle: { tile: 1 }) do not count: an island may grow onto them.
 */
export function isleShore(world, i, sea, isle = null) {
  const f = world.f;
  return f.elevation[i] >= sea && !(isle && isle[i]) && (f.owner[i] >= 0 || f.ownerSettle[i] >= 0);
}

/** True when a tile next to i (8-neighbours) is such a shore. */
export function besideIsleShore(world, i, sea, isle = null) {
  const W = world.W, H = world.H, x0 = i % W, y0 = (i / W) | 0;
  for (let d = 0; d < 8; d++) { const nx = x0 + DX8[d], ny = y0 + DY8[d]; if (nx >= 0 && ny >= 0 && nx < W && ny < H && isleShore(world, ny * W + nx, sea, isle)) return true; }
  return false;
}

export function islandTarget(world, tx, ty, w, sea, str) {
  const peak = sea + 0.025 + 0.14 * str;
  const n = 0.75 + 0.35 * ridgedL(noiseFor(world), (tx + 0.5) / world.H * 11 + 40, (ty + 0.5) / world.H * 11, 3);
  return sea + 0.006 + (peak - sea) * Math.pow(w, 0.8) * n;
}
export const islandStep = (v, t) => (v < t ? v + (t - v) * 0.45 : v);
/** Flatten: the level a stroke beginning here works toward (the weighted mean under the brush). */
export function flattenLevel(world, x, y, r) {
  const e = world.f.elevation;
  let sw = 0, se = 0;
  brush(world, x, y, r, (i, w) => { sw += w; se += w * e[i]; });
  return sw > 0 ? se / sw : e[y * world.W + x];
}

// ---------------------------------------------------------------------------
// Forecast helpers

const metres = (world, de) => Math.round(Math.abs(de) / Math.max(1e-6, 1 - seaOf(world)) * 7000).toLocaleString('en-US');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ringOf = (x, y, r, tone) => [{ x, y, r, tone }];

/** Applications until a tile at v first reaches the sea (rising) — null if it never would. */
function stepsUp(v, sea, step) {
  for (let n = 1; n <= MAX_STEPS; n++) { v = step(v); if (v >= sea) return n; }
  return null;
}
/** Applications until a tile at v first sinks below the sea — null if it never would. */
function stepsDown(v, sea, step) {
  for (let n = 1; n <= MAX_STEPS; n++) { v = step(v); if (v < sea) return n; }
  return null;
}

/** Towns under the brush that one stroke of `steps` applications (or fewer) would drown. */
function drowned(world, x, y, r, sea, stepFor) {
  const out = [];
  for (const s of settlementsNear(world, x, y, r)) {
    const d = Math.hypot(s.x - x, s.y - y) / r;
    if (d >= 1) continue;
    const w = (1 - d * d) * (1 - d * d);
    const n = stepsDown(world.f.elevation[s.i], sea, (v) => stepFor(v, w));
    if (n != null) out.push({ s, n });
  }
  return out.sort((a, b) => a.n - b.n || b.s.population - a.s.population);
}

function counts(world, x, y, r) {
  let land = 0, water = 0;
  brush(world, x, y, r, (i) => { if (world.f.water[i] === WATER.LAND) land++; else water++; });
  return { land, water };
}

// ---------------------------------------------------------------------------
// Previews

export function raisePreview(world, x, y, opts = {}) {
  const r = radiusOf(opts, 4), k = 0.014 * strengthOf(opts), sea = seaOf(world);
  const v = world.f.elevation[y * world.W + x];
  if (v < sea) {
    const n = stepsUp(v, sea, (e) => raiseStep(e, 1, k));
    return { ok: true, tone: 'neutral', severity: 0, text: n ? `Hold to raise: about ${plural(n, 'application')} to break the surface` : 'The sea is too deep here for this brush', rings: ringOf(x, y, r, 'neutral') };
  }
  const dm = metres(world, raiseStep(v, 1, k) - v);
  const c = counts(world, x, y, r);
  return { ok: true, tone: 'neutral', severity: 0, text: `Lifts the ground about ${dm} m per application over ${plural(c.land + c.water, 'tile')}`, rings: ringOf(x, y, r, 'neutral') };
}

export function lowerPreview(world, x, y, opts = {}) {
  const r = radiusOf(opts, 4), k = 0.014 * strengthOf(opts), sea = seaOf(world);
  const dm = metres(world, k);
  const lost = drowned(world, x, y, r, sea, (e, w) => lowerStep(e, w, k));
  const towns = lost.slice(0, 6);
  return {
    ok: true, tone: lost.length ? 'bane' : 'neutral', severity: lost.length ? 3 : 0,
    text: `Presses the ground down about ${dm} m per application${towns.length ? ` · ${towns[0].s.name} would drown after about ${plural(towns[0].n, 'application')}${towns.length > 1 ? ` (and ${towns.length - 1} more town${towns.length > 2 ? 's' : ''})` : ''}` : ''}`,
    targets: towns.map((q) => ({ kind: 'settlement', id: q.s.id })), rings: ringOf(x, y, r, lost.length ? 'bane' : 'neutral'),
    // the people at risk, as Sink's forecast gives them (a drowned town's people die or flee)
    estimate: { deaths: towns.length ? [0, Math.round(towns.reduce((a, q) => a + q.s.population, 0))] : undefined, towns: lost.length },
  };
}

export function flattenPreview(world, x, y, opts = {}) {
  const r = radiusOf(opts, 4);
  const st = world.sys.terraform?.stroke;
  const level = st && st.tool === 'flatten' && st.level != null ? st.level : flattenLevel(world, x, y, r);
  const sea = seaOf(world);
  const h = level >= sea ? `${metres(world, level - sea)} m above the sea` : `${Math.round((sea - level) / Math.max(1e-6, sea) * 8000).toLocaleString('en-US')} m below the sea`;
  return { ok: true, tone: 'neutral', severity: 0, text: `Levels the land toward ${h}`, rings: ringOf(x, y, r, 'neutral') };
}

export function mountainPreview(world, x, y, opts = {}) {
  const r = radiusOf(opts, 3), k = 0.04 * strengthOf(opts), sea = seaOf(world);
  const v = world.f.elevation[y * world.W + x];
  const rid = ridgedL(noiseFor(world), (x + 0.5) / world.H * 16, (y + 0.5) / world.H * 16, 3);
  const dm = metres(world, mountainLift(v, 1, k, rid, sea));
  return { ok: true, tone: 'neutral', severity: 0, text: `Folds the crust into peaks, about ${dm} m per application; drag to draw a range`, rings: ringOf(x, y, r, 'neutral') };
}

export function sinkPreview(world, x, y, opts = {}) {
  const r = radiusOf(opts, 5), str = strengthOf(opts), sea = seaOf(world);
  const target = sinkTarget(sea, str);
  const c = counts(world, x, y, r);
  if (!c.land) return { ok: false, reason: 'Only land can be drowned.', rings: ringOf(x, y, r, 'neutral') };
  const lost = drowned(world, x, y, r, sea, (e, w) => sinkStep(e, w, str, target));
  let firstPass = 0;
  brush(world, x, y, r, (i, w) => { const v = world.f.elevation[i]; if (v >= sea && sinkStep(v, w, str, target) < sea) firstPass++; });
  const towns = lost.slice(0, 6);
  return {
    ok: true, tone: 'bane', severity: towns.length ? 3 : 1,
    text: `${firstPass ? `${firstPass * KM2_PER_TILE} km² go under at the first application` : 'The coast sinks with every application'}${towns.length ? ` · would drown ${towns.map((q) => q.s.name).slice(0, 3).join(', ')}${lost.length > 3 ? ` and ${lost.length - 3} more` : ''}` : ''}`,
    targets: towns.map((q) => ({ kind: 'settlement', id: q.s.id })), rings: ringOf(x, y, r, 'bane'),
    estimate: { deaths: towns.length ? [0, Math.round(towns.reduce((a, q) => a + q.s.population, 0))] : undefined, towns: lost.length },
  };
}

export function islandPreview(world, x, y, opts = {}) {
  const r = radiusOf(opts, 3), str = strengthOf(opts), sea = seaOf(world);
  const v = world.f.elevation[y * world.W + x];
  if (v >= sea) return { ok: true, tone: 'neutral', severity: 0, text: 'Already land: an island rises only from the sea', rings: ringOf(x, y, r, 'neutral') };
  // the isle keeps a strait from a settled shore it rises beside (terraform's island brush)
  if (besideIsleShore(world, y * world.W + x, sea)) return { ok: true, tone: 'neutral', severity: 0, text: 'Beside a settled shore: an island keeps a strait from the coast, so it would rise only further out', rings: ringOf(x, y, r, 'neutral') };
  const t = islandTarget(world, x, y, 1, sea, str);
  const n = stepsUp(v, sea, (e) => islandStep(e, t));
  return { ok: true, tone: 'neutral', severity: 0, text: n ? `Hold to raise: about ${plural(n, 'application')} to break the surface` : 'The sea is too deep here for this brush', rings: ringOf(x, y, r, 'neutral') };
}
