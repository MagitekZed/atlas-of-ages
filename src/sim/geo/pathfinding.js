// A* pathfinding over the tile grid for armies, caravans and ships.
//
//   findPath(world, fromI, toI, { mode: 'land'|'sea'|'amphibious', civId?, navigation?, maxNodes?, peek? })
//     → tile indices from start to goal inclusive, or null. The returned array is shared
//       with the cache: treat it as read-only (copy before mutating). peek: true for previews
//       — never refreshes the saved cost snapshot (a stale one is searched as it stands, and
//       its answers are not memoised); null when no snapshot exists yet.
//   travelCost(world, i, mode) → cost of entering tile i (Infinity when impassable).
//
// Land cost per tile = biome move × altitude (hills ×1.3, mountains ×2.2, peaks ×4) × local
// relief × ice, + river fords, × road discount (track 0.6, road 0.35, highway 0.2). It is
// snapshotted into world.f.pathLandCost (saved with the world) and refreshed when roads or
// biomes have changed (checked yearly; at least every three years) or terrain / water
// versions change, so a reloaded world finds exactly the same paths. Sea cost depends on
// distance from land: navigation 1 hugs the coast (≤ COASTAL_REACH tiles out), navigation 2
// crosses open ocean. Amphibious paths pay an embark / disembark penalty. The search is a
// mildly weighted A* (octile heuristic × H_SCALE): paths within a few percent of optimal for
// a fraction of the work. Results (including failures) are memoised in an LRU keyed by (mode,
// navigation, from, to) — each answering only the node budgets that reproduce it — and dropped
// whenever the grid changes.

import { MinHeap, DX8, DY8, SQRT2, clamp } from '../../core/util.js';
import { BIOMES, BIOME, WATER, DAYS_PER_YEAR } from '../../core/constants.js';
import { ensureField } from '../../core/world.js';
import { modsOf } from './common.js';

export const ROAD_FACTOR = [1, 0.6, 0.35, 0.2];
export const COASTAL_REACH = 4;       // tiles from land that coastal (navigation 1) craft may sail
const EMBARK = 8;                     // amphibious: cost of boarding ships
const DISEMBARK = 3;                  // amphibious: cost of landing
const OPEN_SEA = 0.85, COAST_SEA = 1.0, LAKE_COST = 1.2;
const LRU_CAP = 900;
const DEFAULT_MAX_NODES = 16000;
const HARD_MAX_NODES = 60000;
const H_SCALE = { land: 1.4, sea: 1.0, amphibious: 1.15 };   // weighted A*: near-optimal paths, far fewer nodes
const MODE_CODE = { land: 0, sea: 1, amphibious: 2 };

// ---------------------------------------------------------------------------
// Cost grid

function pathSys(world) {
  return (world.sys.path ||= { gridV: 0, builtDay: -1 });
}

/** Rebuild the land cost snapshot from current biome, elevation, rivers and roads. */
function buildLandCost(world, cost) {
  const { W, H, N, f } = world;
  const elev = f.elevation, water = f.water, biome = f.biome, river = f.river, road = f.road;
  for (let i = 0; i < N; i++) {
    if (water[i] !== WATER.LAND) { cost[i] = 0; continue; }
    const b = BIOMES[biome[i]];
    let c = b && b.move > 0 ? b.move : 1.5;
    const e = elev[i];
    if (e >= 0.88) c *= 4; else if (e >= 0.75) c *= 2.2; else if (e >= 0.62) c *= 1.3;
    // local relief (largest step to a 4-neighbour land tile)
    const x = i % W, y = (i / W) | 0;
    let relief = 0;
    if (x > 0 && !water[i - 1]) relief = Math.max(relief, Math.abs(elev[i - 1] - e));
    if (x < W - 1 && !water[i + 1]) relief = Math.max(relief, Math.abs(elev[i + 1] - e));
    if (y > 0 && !water[i - W]) relief = Math.max(relief, Math.abs(elev[i - W] - e));
    if (y < H - 1 && !water[i + W]) relief = Math.max(relief, Math.abs(elev[i + W] - e));
    c *= 1 + Math.min(2, relief * 30);
    if (biome[i] === BIOME.ICE) c *= 2;
    const rd = road[i] & 3;
    const rv = river[i];
    if (rv >= 2 && rd < 2) c += 0.4 * (rv - 1);   // fords; real roads bring bridges
    c *= ROAD_FACTOR[rd];
    cost[i] = c < 0.15 ? 0.15 : c > 40 ? 40 : c;
  }
}

/** Multi-source BFS: distance (tiles, capped 255) from every water tile to the nearest land. */
function buildSeaDist(world) {
  const { W, H, N, f } = world;
  const d = new Uint8Array(N).fill(255);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND) { d[i] = 0; q[qt++] = i; }
  while (qh < qt) {
    const i = q[qh++];
    const nd = d[i] + 1;
    if (nd >= 255) continue;
    const x = i % W, y = (i / W) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX8[k], ny = y + DY8[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (d[j] <= nd) continue;
      d[j] = nd; q[qt++] = j;
    }
  }
  return d;
}

/** Connected water bodies (8-neighbour) and, per landmass, the set of bodies it touches. */
function buildBodies(world) {
  const { W, H, N, f } = world;
  const body = new Int32Array(N).fill(-1);
  const q = new Int32Array(N);
  let id = 0;
  for (let s = 0; s < N; s++) {
    if (f.water[s] === WATER.LAND || body[s] >= 0) continue;
    let qh = 0, qt = 0;
    q[qt++] = s; body[s] = id;
    while (qh < qt) {
      const i = q[qh++], x = i % W, y = (i / W) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k], ny = y + DY8[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (f.water[j] === WATER.LAND || body[j] >= 0) continue;
        body[j] = id; q[qt++] = j;
      }
    }
    id++;
  }
  const lmBodies = new Map();
  for (let i = 0; i < N; i++) {
    if (f.water[i] !== WATER.LAND) continue;
    const lm = f.landmass[i];
    const x = i % W, y = (i / W) | 0;
    for (let k = 0; k < 8; k += 2) {
      const nx = x + DX8[k], ny = y + DY8[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const b = body[ny * W + nx];
      if (b < 0) continue;
      let set = lmBodies.get(lm);
      if (!set) lmBodies.set(lm, (set = new Set()));
      set.add(b);
    }
  }
  return { body, lmBodies, count: id };
}

/** True when the saved cost snapshot is current (a search now would not refresh it). Pure. */
export function gridCurrent(world) {
  const cost = world.f.pathLandCost;
  const ps = world.sys.path;
  if (!ps || !cost || cost.length !== world.N || !(cost instanceof Float32Array)) return false;
  return ps.costTV == null || (ps.costTV === stableV(world, 'terrain') && ps.costWV === stableV(world, 'water'));
}

/**
 * Current grid (land cost snapshot + derived sea data), rebuilding what is stale. peek: never
 * touch saved state — use the snapshot as it stands (null when there is none); the derived sea
 * data is cache only and is rebuilt as usual.
 */
function grid(world, peek = false) {
  const c = world.cache;
  const v = world.versions;
  let pg = c.pathGrid;
  let cost = world.f.pathLandCost;
  const fresh = !cost || cost.length !== world.N || !(cost instanceof Float32Array);
  if (peek && (fresh || !world.sys.path)) return null;
  const ps = pathSys(world);
  // the terrain / water versions the snapshot was built for live in saved state, so a world
  // saved between an edit and the next refresh still refreshes on the same day after a reload
  const tv = stableV(world, 'terrain'), wv = stableV(world, 'water');
  if (peek) { /* the snapshot stays as it is */ } else if (fresh) {
    cost = ensureField(world, 'pathLandCost', Float32Array, world.N);
    buildLandCost(world, cost);
    ps.gridV++; ps.builtDay = world.time.day;
  } else if (ps.costTV != null && (ps.costTV !== tv || ps.costWV !== wv)) {
    // terrain or coastline edited mid-run → refresh the snapshot
    buildLandCost(world, cost);
    ps.gridV++; ps.builtDay = world.time.day;
  }
  if (!peek) { ps.costTV = tv; ps.costWV = wv; }
  // sea distance and water bodies depend on the water mask alone: elevation-only edits
  // (quakes, lava, craters — several a year on restless worlds) keep them
  if (!pg || pg.waterV !== v.water) {
    const bodies = buildBodies(world);
    pg = c.pathGrid = {
      terrainV: v.terrain, waterV: v.water,
      seaDist: buildSeaDist(world), body: bodies.body, lmBodies: bodies.lmBodies,
    };
  } else if (pg.terrainV !== v.terrain) pg.terrainV = v.terrain;
  pg.land = cost;
  return pg;
}

/** Rebuild the land cost snapshot now (biome drift, new roads). Clears the path cache. */
export function refreshPathGrid(world) {
  const pg = grid(world);
  buildLandCost(world, pg.land);
  const ps = pathSys(world);
  ps.gridV++; ps.builtDay = world.time.day;
  ps.roadsV = stableV(world, 'roads'); ps.biomeV = stableV(world, 'biome');
}

/**
 * A version number that survives save/load: deserializeWorld bumps every version (including
 * versions.load) by one, so the difference to versions.load is the same before and after.
 */
const stableV = (world, key) => (world.versions[key] || 0) - (world.versions.load || 0);

/**
 * Call daily from one system: refreshes the snapshot when roads or biomes have changed since
 * it was built (checked yearly), and at least every three years.
 */
export function maintainPaths(world) {
  const ps = pathSys(world);
  const day = world.time.day;
  if (ps.builtDay >= 0 && day - Math.max(ps.builtDay, ps.checkDay ?? -1) < DAYS_PER_YEAR) return;
  const v = world.versions;
  const changed = ps.roadsV !== stableV(world, 'roads') || ps.biomeV !== stableV(world, 'biome');
  if (ps.builtDay < 0 || changed || day - ps.builtDay >= 3 * DAYS_PER_YEAR) refreshPathGrid(world);
  else ps.checkDay = day;   // nothing to redo; look again next year
}

// ---------------------------------------------------------------------------
// Per-tile costs

function seaCost(pg, water, i, nav) {
  const w = water[i];
  if (w === WATER.LAKE) return LAKE_COST;
  if (w !== WATER.OCEAN) return Infinity;
  if (pg.seaDist[i] > COASTAL_REACH) return nav >= 2 ? OPEN_SEA : Infinity;
  return COAST_SEA;
}

/** Cost of entering tile i in the given mode (Infinity when impassable). */
export function travelCost(world, i, mode = 'land', navigation = 2) {
  if (!(i >= 0 && i < world.N)) return Infinity;
  const pg = grid(world);
  const water = world.f.water;
  if (mode === 'sea') return seaCost(pg, water, i, navigation);
  if (water[i] !== WATER.LAND) return mode === 'amphibious' ? seaCost(pg, water, i, navigation) : Infinity;
  const c = pg.land[i];
  return c > 0 ? c : Infinity;
}

/** Sum of entry costs along a path (diagonal steps × √2). */
export function pathCost(world, path, mode = 'land', navigation = 2) {
  if (!path || path.length < 2) return 0;
  const W = world.W;
  let total = 0;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    const diag = (a % W) !== (b % W) && ((a / W) | 0) !== ((b / W) | 0);
    const c = travelCost(world, b, mode, navigation);
    total += (Number.isFinite(c) ? c : 1) * (diag ? SQRT2 : 1);
  }
  return total;
}

/** Water bodies touching tile i (i itself if water), written into out[]; returns the count. */
function bodiesAt(world, pg, i, out) {
  const { W, H, f } = world;
  if (f.water[i] !== WATER.LAND) { out[0] = pg.body[i]; return 1; }
  const x = i % W, y = (i / W) | 0;
  let n = 0;
  for (let k = 0; k < 8; k++) {
    const nx = x + DX8[k], ny = y + DY8[k];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const b = pg.body[ny * W + nx];
    if (b < 0) continue;
    let dup = false;
    for (let q = 0; q < n; q++) if (out[q] === b) { dup = true; break; }
    if (!dup) out[n++] = b;
  }
  return n;
}

const BODY_A = new Int32Array(8), BODY_B = new Int32Array(8);   // scratch, no state across calls

/** True when tiles a and b touch (or lie in) a common body of water. */
export function sharesSea(world, a, b) {
  if (!(a >= 0 && a < world.N && b >= 0 && b < world.N)) return false;
  return sharesSeaIn(world, grid(world), a, b);
}

/** sharesSea for previews: reads the grid without refreshing saved state (false when none). */
export function sharesSeaPeek(world, a, b) {
  const pg = grid(world, true);
  return pg ? sharesSeaIn(world, pg, a, b) : false;
}

function sharesSeaIn(world, pg, a, b) {
  if (!(a >= 0 && a < world.N && b >= 0 && b < world.N)) return false;
  const na = bodiesAt(world, pg, a, BODY_A);
  if (!na) return false;
  const nb = bodiesAt(world, pg, b, BODY_B);
  for (let p = 0; p < nb; p++) for (let q = 0; q < na; q++) if (BODY_B[p] === BODY_A[q]) return true;
  return false;
}

/** True when land tiles a and b sit on landmasses that border a common sea. */
function landmassesShareSea(world, pg, a, b) {
  const la = pg.lmBodies.get(world.f.landmass[a]), lb = pg.lmBodies.get(world.f.landmass[b]);
  if (!la || !lb) return false;
  for (const x of lb) if (la.has(x)) return true;
  return false;
}

/**
 * Raw cost arrays for per-day movers (caravans, armies): { land, seaDist }. land[i] is the
 * entry cost of land tile i (0 on water). Read-only.
 */
export function costGrid(world) {
  const pg = grid(world);
  return { land: pg.land, seaDist: pg.seaDist };
}

/** Distance from water tile i to the nearest land (0 on land). */
export function seaDistance(world, i) {
  return i >= 0 && i < world.N ? grid(world).seaDist[i] : 0;
}

// ---------------------------------------------------------------------------
// LRU cache and search buffers (world.cache only — safe to lose)

function lru(world) {
  const ps = pathSys(world);
  let c = world.cache.pathLRU;
  if (!c || c.gridV !== ps.gridV || c.waterV !== world.versions.water || c.terrainV !== world.versions.terrain) {
    c = world.cache.pathLRU = { gridV: ps.gridV, waterV: world.versions.water, terrainV: world.versions.terrain, map: new Map() };
  }
  return c.map;
}

function buffers(world) {
  let b = world.cache.pathBuf;
  if (!b || b.N !== world.N) {
    b = world.cache.pathBuf = {
      N: world.N, g: new Float64Array(world.N), par: new Int32Array(world.N),
      seen: new Uint32Array(world.N), closed: new Uint32Array(world.N), stamp: 0, heap: new MinHeap(4096),
    };
  }
  if (b.stamp >= 0xfffffff0) { b.seen.fill(0); b.closed.fill(0); b.stamp = 0; }
  b.stamp++;
  return b;
}

export function pathStats(world) {
  return (world.cache.pathStats ||= { calls: 0, hits: 0, searches: 0, nodes: 0, fails: 0 });
}

// ---------------------------------------------------------------------------
// Search

/**
 * Find a path between two tiles. See the header for options and conventions.
 * Land mode needs both ends on the same landmass; sea mode needs both ends in or beside a
 * shared body of water (coastal land tiles are allowed only as the start and the goal).
 */
export function findPath(world, fromI, toI, opts = {}) {
  const N = world.N;
  if (!(fromI >= 0 && fromI < N && toI >= 0 && toI < N)) return null;
  fromI = Math.floor(fromI); toI = Math.floor(toI);
  let mode = opts.mode === 'sea' || opts.mode === 'amphibious' ? opts.mode : 'land';
  let nav = opts.navigation;
  if (nav == null) nav = opts.civId != null && world.civs[opts.civId] ? modsOf(world, world.civs[opts.civId]).navigation : 2;
  nav = clamp(Math.round(Number(nav) || 0), 0, 2);
  const stats = pathStats(world);
  stats.calls++;
  const peek = Boolean(opts.peek);
  const current = !peek || gridCurrent(world);
  const pg = grid(world, peek);
  if (!pg) return null;
  if (fromI === toI) return [fromI];
  const f = world.f, water = f.water;
  if (mode === 'amphibious' && nav < 1) mode = 'land';
  if (mode === 'land') {
    if (water[fromI] !== WATER.LAND || water[toI] !== WATER.LAND) return null;
    if (f.landmass[fromI] !== f.landmass[toI]) return null;
  } else if (mode === 'sea') {
    if (nav < 1 || !sharesSeaIn(world, pg, fromI, toI)) return null;
  } else if (water[fromI] === WATER.LAND && water[toI] === WATER.LAND && f.landmass[fromI] !== f.landmass[toI]) {
    if (!landmassesShareSea(world, pg, fromI, toI)) return null;
  }
  const key = ((MODE_CODE[mode] * 3 + nav) * N + fromI) * N + toI;
  // a stale snapshot (peek before the day's refresh) is searched but never memoised
  if (!current) return astar(world, pg, fromI, toI, mode, nav, clamp(Math.floor(opts.maxNodes ?? DEFAULT_MAX_NODES), 50, HARD_MAX_NODES), stats);
  const map = lru(world);
  const maxNodes = clamp(Math.floor(opts.maxNodes ?? DEFAULT_MAX_NODES), 50, HARD_MAX_NODES);
  // An entry answers only budgets that would reproduce it — a path found after n expansions
  // for any maxNodes ≥ n, a failure for budgets up to the one that failed — so a result never
  // depends on which caller asked first, or on a reload having emptied the cache.
  const hit = map.get(key);
  if (hit && (hit.path ? maxNodes >= hit.n : maxNodes <= hit.n)) {
    map.delete(key); map.set(key, hit);   // refresh recency
    stats.hits++;
    return hit.path;
  }
  const path = astar(world, pg, fromI, toI, mode, nav, maxNodes, stats);
  if (hit) map.delete(key);
  map.set(key, { path, n: path ? stats.lastExpanded : stats.lastExhausted ? Infinity : maxNodes });
  if (map.size > LRU_CAP) map.delete(map.keys().next().value);
  if (!path) stats.fails++;
  return path;
}

function astar(world, pg, from, to, mode, nav, maxNodes, stats) {
  const { W, H } = world;
  const water = world.f.water, land = pg.land, seaDist = pg.seaDist;
  const b = buffers(world);
  const g = b.g, par = b.par, seen = b.seen, closed = b.closed, stamp = b.stamp, heap = b.heap;
  const tx = to % W, ty = (to / W) | 0;
  const W1 = W - 1, H1 = H - 1;
  const hs = H_SCALE[mode];
  const isSea = mode === 'sea', isLand = mode === 'land';
  heap.clear();
  g[from] = 0; par[from] = -1; seen[from] = stamp;
  heap.push(from, 0);
  stats.searches++;
  stats.lastExhausted = false;
  let expanded = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur] === stamp) continue;
    closed[cur] = stamp;
    if (cur === to) {
      stats.nodes += expanded;
      stats.lastExpanded = expanded;
      const out = [];
      for (let k = to; k >= 0; k = par[k]) { out.push(k); if (k === from) break; }
      out.reverse();
      return out;
    }
    if (++expanded > maxNodes) { stats.nodes += expanded; return null; }
    const cx = cur % W, cy = (cur / W) | 0;
    const curLand = water[cur] === WATER.LAND;
    const gc = g[cur];
    // (the bounds are checked only for tiles on the map's edge)
    const edge = cx === 0 || cy === 0 || cx === W1 || cy === H1;
    for (let d = 0; d < 8; d++) {
      const nx = cx + DX8[d], ny = cy + DY8[d];
      if (edge && (nx < 0 || ny < 0 || nx >= W || ny >= H)) continue;
      const j = ny * W + nx;
      if (closed[j] === stamp) continue;
      const jLand = water[j] === WATER.LAND;
      let step;
      if (isLand) {
        step = land[j];
        if (!(step > 0)) continue;
      } else if (isSea) {
        if (jLand) { if (j !== to) continue; step = COAST_SEA; }
        else {
          const w = water[j];
          step = w === WATER.LAKE ? LAKE_COST : seaDist[j] > COASTAL_REACH ? (nav >= 2 ? OPEN_SEA : 0) : COAST_SEA;
          if (!step) continue;
        }
      } else { // amphibious
        if (jLand) {
          step = land[j];
          if (!(step > 0)) continue;
          if (!curLand) step += DISEMBARK;
        } else {
          const w = water[j];
          step = w === WATER.LAKE ? LAKE_COST : seaDist[j] > COASTAL_REACH ? (nav >= 2 ? OPEN_SEA : 0) : COAST_SEA;
          if (!step) continue;
          if (curLand) step += EMBARK;
        }
      }
      if (d & 1) {
        // diagonal: no slipping between two blocked orthogonal tiles
        const o1 = cy * W + nx, o2 = ny * W + cx;
        if (isLand) {
          if (water[o1] !== WATER.LAND && water[o2] !== WATER.LAND) continue;
        } else if (isSea) {
          if (water[o1] === WATER.LAND && water[o2] === WATER.LAND && j !== to && cur !== from) continue;
        }
        step *= SQRT2;
      }
      const ng = gc + step;
      if (seen[j] === stamp && ng >= g[j]) continue;
      g[j] = ng; par[j] = cur; seen[j] = stamp;
      const dx = nx > tx ? nx - tx : tx - nx, dy = ny > ty ? ny - ty : ty - ny;
      const oct = dx > dy ? dx + (SQRT2 - 1) * dy : dy + (SQRT2 - 1) * dx;
      heap.push(j, ng + hs * oct);
    }
  }
  stats.nodes += expanded;
  stats.lastExhausted = true;   // unreachable: no budget would find it
  return null;
}
