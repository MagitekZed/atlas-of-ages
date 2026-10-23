// Bands · movement. Daily motion for bands that are under way (roam, raid, return, settling):
//   land  a Bresenham line when every tile on it is dry land, else findPath (geo/pathfinding.js)
//         — the A* cache there is keyed by the grid version, so repeated trips are cheap
//   sea   the same over water (pirates, krakens); the goal may be a coastal town tile
//   fly   a straight line with a slow deterministic wobble (dragons, wyverns)
// Movement points accrue each day by the band's speed and are spent on the terrain cost of the
// next tile (path cost grid when the geo module is present, biome × relief otherwise).
//
// This module also holds the guarded links to other owners' published exports (SPEC §1), so
// the rest of the package never awaits an import inside a module cycle: pathfinding
// (findPath, costGrid), trade (breakRoute), diplomacy (civPower), ecology (ignite) and disease
// (createPlague). Each is null while its owner's module is missing; callers degrade.

import { WATER, BIOMES, BAND_KINDS } from '../../core/constants.js';
import { hash2 } from '../../core/rng.js';
import { clamp } from '../../core/util.js';

export const links = { path: null, trade: null, diplo: null, eco: null, disease: null };
try { links.path = await import('../geo/pathfinding.js'); } catch (e) { /* straight lines only */ }
try { links.trade = await import('../geo/trade.js'); } catch (e) { /* routes are never broken by bands */ }
try { links.diplo = await import('../geo/diplomacy.js'); } catch (e) { /* rough power estimate */ }
try { links.eco = await import('../ecology.js'); } catch (e) { /* dragonfire lights no fields */ }
try { links.disease = await import('../geo/disease.js'); } catch (e) { /* green wyrms carry no murrain */ }

/** Tiles per day on open, flat ground, by band kind. */
export const SPEED = {
  bandits: 0.95, pirates: 2.6, company: 0.85, horde: 1.55, migration: 0.6,
  dragon: 4.2, wyvern: 2.6, troll: 0.65, giant: 0.75, treant: 0.35, kraken: 1.4, behemoth: 0.55, undead: 0.55,
};

/** 'land' | 'sea' | 'fly' for a band. */
export function modeOf(band) {
  const fl = BAND_KINDS[band.kind]?.flags || {};
  return fl.fly ? 'fly' : fl.sea ? 'sea' : 'land';
}

export const tileOf = (world, x, y) => clamp(Math.round(y), 0, world.H - 1) * world.W + clamp(Math.round(x), 0, world.W - 1);
const passable = (world, i, mode) => (mode === 'sea' ? world.f.water[i] !== WATER.LAND : world.f.water[i] === WATER.LAND);

/** Entering cost of tile i for a walker (≥ 0.5). */
function landCost(world, i, grid) {
  if (grid && grid.land && grid.land[i] > 0) return grid.land[i];
  const b = BIOMES[world.f.biome[i]];
  const e = world.f.elevation[i];
  let c = b && b.move > 0 ? b.move : 1.5;
  if (e >= 0.88) c *= 4; else if (e >= 0.75) c *= 2.2; else if (e >= 0.62) c *= 1.3;
  return c;
}

/**
 * The tiles of a straight line from a to b (inclusive) if every interior one is passable for
 * the mode (the goal may be a coastal town for sea craft, the start anything), else null.
 */
function straightLine(world, a, b, mode) {
  const W = world.W;
  let x0 = a % W, y0 = (a / W) | 0;
  const x1 = b % W, y1 = (b / W) | 0;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const out = [a];
  for (let guard = 0; guard < 600; guard++) {
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
    const i = y0 * W + x0;
    if (i !== b && !passable(world, i, mode)) return null;
    out.push(i);
  }
  return out;
}

/**
 * Plan a route for the band to tile `to`: band.path (tile indices, JSON) and pathStep, or for
 * flyers just band.targetI. Returns false when no way exists (the caller picks another goal).
 */
export function planRoute(world, band, to, opts = {}) {
  band.targetI = to;
  band.pathStep = 0;
  const mode = modeOf(band);
  if (mode === 'fly') { band.path = null; return true; }
  const from = tileOf(world, band.x, band.y);
  if (from === to) { band.path = [to]; return true; }
  let p = straightLine(world, from, to, mode);
  if (!p && links.path && typeof links.path.findPath === 'function') {
    const W = world.W;
    const d = Math.hypot((from % W) - (to % W), ((from / W) | 0) - ((to / W) | 0));
    const maxNodes = Math.round(Math.min(opts.maxNodes || 9000, 700 + d * 140));
    let r = null;
    try { r = links.path.findPath(world, from, to, { mode: mode === 'sea' ? 'sea' : 'land', navigation: 2, maxNodes }); } catch (e) { r = null; }
    if (r && r.length) p = r.slice();
  }
  if (!p) { band.path = null; return false; }
  band.path = p;
  return true;
}

/** Point the band home (its lair, camp, cove or range centre). */
export function planHome(world, band) {
  return planRoute(world, band, band.homeI);
}

/**
 * Advance a band one day along its route. Returns true on the day it arrives (the caller
 * resolves what it came for). Never draws rng: the flyers' wobble is a hash of id and day.
 */
export function stepBand(world, band, grid, speedMul = 1) {
  const W = world.W;
  const fl = band.data;
  const speed = (SPEED[band.kind] || 1) * speedMul;
  // walkers and sailors without a route go nowhere (the engine settles them where they stand)
  if (modeOf(band) !== 'fly' && !band.path) return true;
  if (modeOf(band) === 'fly') {
    if (band.targetI < 0) return true;
    const tx = band.targetI % W, ty = (band.targetI / W) | 0;
    const dx = tx - band.x, dy = ty - band.y;
    const d = Math.hypot(dx, dy);
    if (d <= Math.max(0.6, speed)) { band.x = tx; band.y = ty; return true; }
    // a slow sideways sway, stronger mid-flight, from a hash rather than the rng
    const wob = (hash2(band.id, (world.time.day / 3) | 0, 917) - 0.5) * 0.9 * Math.min(1, d / 6);
    const ux = dx / d, uy = dy / d;
    band.x = clamp(band.x + ux * speed - uy * wob, 0, W - 1);
    band.y = clamp(band.y + uy * speed + ux * wob, 0, world.H - 1);
    return false;
  }
  const p = band.path;
  const last = p.length - 1;
  let step = band.pathStep | 0;
  if (step >= last) { const i = p[last]; band.x = i % W; band.y = (i / W) | 0; return true; }
  const sea = modeOf(band) === 'sea';
  let mp = (Number.isFinite(fl.mp) ? fl.mp : 0) + speed;
  let cost = 1;
  while (step < last) {
    const nx = p[step + 1];
    cost = sea ? 1 : landCost(world, nx, grid);
    const a = p[step];
    if ((a % W) !== (nx % W) && ((a / W) | 0) !== ((nx / W) | 0)) cost *= 1.41;
    if (mp < cost) break;
    mp -= cost;
    step++;
  }
  // points carry over, but never beyond what the next (possibly rugged) step needs
  fl.mp = Math.min(mp, Math.max(4, cost));
  band.pathStep = step;
  const i0 = p[step];
  let x = i0 % W, y = (i0 / W) | 0;
  if (step < last) {
    const t = clamp(mp / cost, 0, 1);
    const i1 = p[step + 1];
    x += ((i1 % W) - x) * t; y += (((i1 / W) | 0) - y) * t;
  }
  band.x = x; band.y = y;
  return step >= last;
}

/** Path cost grid for walkers, or null without the geo module. */
export function walkGrid(world) {
  if (!links.path || typeof links.path.costGrid !== 'function') return null;
  try { return links.path.costGrid(world); } catch (e) { return null; }
}

/** Distance in tiles between a band and a tile index. */
export const distTo = (world, band, i) => Math.hypot(band.x - (i % world.W), band.y - ((i / world.W) | 0));
