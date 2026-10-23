// Territory: a competitive multi-source Dijkstra from every live settlement.
//
// Each settlement spreads influence over land with per-tile travel cost (biome move cost,
// relief, great rivers) scaled by its strength σ (tier, culture, capital status), up to a
// raw-cost reach that grows with tier. Narrow sea straits can be crossed (longer with
// navigation); lakes are crossable. A tile goes to whichever settlement reaches it with the
// lowest scaled cost, so regions stay contiguous and big cities push borders outward.
// Incumbent owners get a small discount, which keeps borders from flickering.
//
// claimAround gives a new settlement its own tile and the free ground around it at once (no
// full pass is needed for a founding).
// Writes f.owner / f.ownerSettle on land (water is never owned), cache.civ.waterSettle
// (fishing grounds for water tiles), cache.civ.borders (Map pairKey → shared border
// length, pairKey = min·4096 + max), civ.territory / peakTerritory and civ.flags.steppe.
// Bumps versions.owner only if anything changed.

import { WATER, BIOME } from '../../core/constants.js';
import { SQRT2 } from '../../core/util.js';
import { bumpVersion, ensureField } from '../../core/world.js';
import { liveSettlements } from '../../core/entities.js';
import { civCache, fin } from './state.js';
import { landCostGrid } from './land.js';
import { getMods } from './tech.js';

const REACH = [4.5, 6.5, 8.5, 10.5, 12.5, 14.5, 16.5];
const WATER_STEP = [3.4, 2.8, 2.4];
const MAX_RUN = [2, 3, 5];
const LAKE_STEP = 1.8, LAKE_RUN = 10;
const LAND = WATER.LAND, OCEAN = WATER.OCEAN;
const DSTEP = Float64Array.from([1, SQRT2, 1, SQRT2, 1, SQRT2, 1, SQRT2]);
// Bucket queue (Dial's algorithm): priorities are bounded (≤ reach / σ), so tiles are kept
// in buckets of width 1/Q — O(1) push and pop, exact up to the bucket width.
const Q = 24, NB = 40 * Q;

class BucketQueue {
  constructor(cap) {
    this.head = new Int32Array(NB).fill(-1);
    this.next = new Int32Array(cap); this.tile = new Int32Array(cap); this.pri = new Float32Array(cap);
    this.n = 0; this.cur = 0; this.size = 0;
  }
  clear() { if (this.n) this.head.fill(-1); this.n = 0; this.cur = 0; this.size = 0; }
  grow() {
    const cap = this.next.length * 2;
    const nx = new Int32Array(cap); nx.set(this.next); this.next = nx;
    const t = new Int32Array(cap); t.set(this.tile); this.tile = t;
    const p = new Float32Array(cap); p.set(this.pri); this.pri = p;
  }
  push(i, p) {
    if (this.n >= this.next.length) this.grow();
    let b = (p * Q) | 0;
    if (b >= NB) b = NB - 1;
    if (b < this.cur) b = this.cur;
    const e = this.n++;
    this.tile[e] = i; this.pri[e] = p; this.next[e] = this.head[b]; this.head[b] = e;
    this.size++;
  }
  /** Pop an entry index (tile in .tile[e], priority in .pri[e]) or -1. */
  pop() {
    if (!this.size) return -1;
    const head = this.head;
    while (this.cur < NB && head[this.cur] < 0) this.cur++;
    if (this.cur >= NB) { this.size = 0; return -1; }
    const e = head[this.cur];
    head[this.cur] = this.next[e];
    this.size--;
    return e;
  }
}

function buffers(world) {
  const c = civCache(world);
  const N = world.N;
  if (!c.terr || c.terr.best.length !== N) {
    c.terr = {
      best: new Float32Array(N), raw: new Float32Array(N), lab: new Int32Array(N),
      stamp: new Int32Array(N), done: new Int32Array(N), wrun: new Uint8Array(N), heap: new BucketQueue(16384),
      gen: 0, list: new Int32Array(N), listN: 0, prev: new Int32Array(N), prevN: -1,
    };
  }
  // fishing grounds (water tiles each settlement's territory reached) are saved state
  if (!c.waterSettle || c.waterSettle.length !== N) c.waterSettle = ensureField(world, 'civWaterSettle', Int32Array, N, -1);
  const ns = world.settlements.length + 1;
  if (!c.terrS || c.terrS.sig.length < ns) {
    const cap = Math.max(64, Math.ceil(ns * 1.5));
    c.terrS = { sig: new Float32Array(cap), reach: new Float32Array(cap), civ: new Int32Array(cap), nav: new Uint8Array(cap) };
  }
  return c;
}

/** Settlement influence strength. */
export function settlementSigma(world, s) {
  const civ = world.civs[s.civId];
  const cap = civ && civ.capitalId === s.id;
  return (1 + 0.55 * (s.tier || 0)) * (1 + 0.08 * Math.log10(1 + Math.max(0, fin(s.culture))))
    * (cap ? 1.15 : 1) * (s.siege ? 0.7 : 1);
}

/**
 * Recompute territory for the whole world. Work is proportional to the tiles reached
 * (generation stamps instead of full-grid clears; last pass's tiles are remembered so
 * abandoned ground is released). Returns true if ownership changed.
 */
export function computeTerritory(world) {
  const { W, H, N, f } = world;
  const c = buffers(world);
  const T = c.terr;
  const { best, raw, lab, stamp, done, wrun, heap, list, prev } = T;
  const { sig, reach, civ: civOf, nav } = c.terrS;
  const lc = landCostGrid(world);
  const own = f.owner, ownS = f.ownerSettle, water = f.water;
  const gen = ++T.gen;
  const OFF = Int32Array.of(1, W + 1, W, W - 1, -1, -W - 1, -W, -W + 1);
  heap.clear();
  let ln = 0;

  // first run after load/creation: remember whatever is currently owned so it can be released
  if (T.prevN < 0) {
    let n = 0;
    for (let i = 0; i < N; i++) if (own[i] >= 0 || ownS[i] >= 0 || c.waterSettle[i] >= 0) prev[n++] = i;
    T.prevN = n;
  }

  const ss = liveSettlements(world);
  for (const s of ss) {
    const civ = world.civs[s.civId];
    if (!civ || !civ.alive) continue;
    const mods = getMods(world, civ);
    const isCap = civ.capitalId === s.id;
    sig[s.id] = settlementSigma(world, s);
    reach[s.id] = Math.min(22, REACH[Math.max(0, Math.min(6, s.tier | 0))]
      + 0.7 * Math.log10(1 + Math.max(0, fin(s.culture)) / 40)
      + (isCap ? 1.2 : 0) + 0.12 * Math.max(0, mods.expansionRange - 8));
    civOf[s.id] = s.civId;
    nav[s.id] = Math.max(0, Math.min(2, mods.navigation | 0));
    const i = s.i;
    if (stamp[i] === gen) continue; // two settlements on one tile (should not happen)
    stamp[i] = gen; best[i] = 0; raw[i] = 0; lab[i] = s.id; wrun[i] = 0;
    heap.push(i, 0);
  }

  ln = searchKernel(heap, W, H, gen, OFF, best, raw, lab, stamp, done, wrun, list, sig, reach, civOf, nav, lc, own, water);

  // release tiles held last pass but not reached now, then claim the reached ones
  const ws = c.waterSettle;
  const nc = world.civs.length;
  const terr = new Int32Array(nc), steppe = new Int32Array(nc);
  let changed = releaseKernel(prev, T.prevN, done, gen, own, ownS, ws);
  if (claimKernel(list, ln, lab, civOf, water, own, ownS, ws, f.biome, terr, steppe)) changed = true;
  // remember this pass's tiles
  prev.set(list.subarray(0, ln));
  T.prevN = ln;

  // shared land borders between civs (each adjacent owned pair counted once)
  const borders = new Map();
  bordersKernel(list, ln, own, W, N, borders);
  c.borders = borders;

  const civs = world.civs;
  for (let k = 0; k < civs.length; k++) {
    const civ = civs[k];
    if (!civ.alive) { civ.territory = 0; continue; }
    const t = terr[civ.id] || 0;
    civ.territory = t;
    if (t > (civ.peakTerritory || 0)) civ.peakTerritory = t;
    civ.flags ||= {};
    civ.flags.steppe = t > 0 ? steppe[civ.id] / t : 0;
  }

  if (world.sys.civ) { world.sys.civ.terrDirty = false; world.sys.civ.lastTerrDay = world.time.day; }
  if (changed) bumpVersion(world, 'owner');
  c.bordersV = world.versions.owner;
  return changed;
}

// The passes' hot loops, as kernels over typed arrays and numbers only (plus the queue, one
// class): their type feedback never changes, so they stay optimised however the world's
// objects change shape between passes (computeTerritory itself is thrown out of optimised
// code now and then by the civ objects it updates, and a search left inside it then ran
// interpreted until on-stack replacement caught up).

/** The competitive Dijkstra from the seeded queue. Returns the number of tiles settled (list). */
function searchKernel(heap, W, H, gen, OFF, best, raw, lab, stamp, done, wrun, list, sig, reach, civOf, nav, lc, own, water) {
  const W1 = W - 1, H1 = H - 1;
  let ln = 0;
  for (;;) {
    const e = heap.pop();
    if (e < 0) break;
    const i = heap.tile[e];
    if (done[i] === gen || heap.pri[e] > best[i]) continue;
    done[i] = gen;
    list[ln++] = i;
    const sid = lab[i];
    const sg = sig[sid], rc = reach[sid], cv = civOf[sid], nv = nav[sid];
    const y = (i / W) | 0, x = i - y * W;
    const bi = best[i], ri = raw[i], wr = wrun[i];
    const edge = x === 0 || x === W1 || y === 0 || y === H1;
    const xl = x > 0, xr = x < W1, yu = y > 0, yd = y < H1;
    const maxRun = MAX_RUN[nv], wstep = WATER_STEP[nv];
    for (let d = 0; d < 8; d++) {
      // DIR8 order: E, SE, S, SW, W, NW, N, NE (bounds are only checked on the map edge)
      if (edge && (d === 0 ? !xr : d === 1 ? !(xr && yd) : d === 2 ? !yd : d === 3 ? !(xl && yd) : d === 4 ? !xl : d === 5 ? !(xl && yu) : d === 6 ? !yu : !(xr && yu))) continue;
      const j = i + OFF[d];
      if (done[j] === gen) continue;
      const wj = water[j];
      const dm = DSTEP[d];
      let step, run = 0;
      if (wj === LAND) {
        step = lc[j] * dm;
        if (own[j] === cv) step *= 0.88;
      } else {
        run = wr + 1;
        if (wj === OCEAN) { if (run > maxRun) continue; step = wstep * dm; }
        else { if (run > LAKE_RUN) continue; step = LAKE_STEP * dm; }
      }
      const r = ri + step;
      if (r > rc) continue;
      const np = bi + step / sg;
      if (stamp[j] !== gen || np < best[j]) {
        stamp[j] = gen; best[j] = np; raw[j] = r; lab[j] = sid; wrun[j] = run;
        heap.push(j, np);
      }
    }
  }
  return ln;
}

/** Release the tiles held last pass (prev) that this pass did not reach. Returns true if any owner changed. */
function releaseKernel(prev, prevN, done, gen, own, ownS, ws) {
  let changed = false;
  for (let k = 0; k < prevN; k++) {
    const i = prev[k];
    if (done[i] === gen) continue;
    if (own[i] !== -1 || ownS[i] !== -1) { own[i] = -1; ownS[i] = -1; changed = true; }
    ws[i] = -1;
  }
  return changed;
}

/** Shared land borders among the reached tiles: pairKey → length (each adjacent owned pair once). */
function bordersKernel(list, ln, own, W, N, borders) {
  for (let k = 0; k < ln; k++) {
    const i = list[k];
    const a = own[i];
    if (a < 0) continue;
    const x = i % W;
    if (x + 1 < W) {
      const b = own[i + 1];
      if (b >= 0 && b !== a) { const key = a < b ? a * 4096 + b : b * 4096 + a; borders.set(key, (borders.get(key) || 0) + 1); }
    }
    if (i + W < N) {
      const b = own[i + W];
      if (b >= 0 && b !== a) { const key = a < b ? a * 4096 + b : b * 4096 + a; borders.set(key, (borders.get(key) || 0) + 1); }
    }
  }
}

/** Shared land borders over the whole owner grid (bordersMap), tile by tile in index order. */
function gridBordersKernel(own, W, N, borders) {
  for (let i = 0; i < N; i++) {
    const a = own[i];
    if (a < 0) continue;
    if ((i % W) + 1 < W) {
      const b = own[i + 1];
      if (b >= 0 && b !== a) { const key = a < b ? a * 4096 + b : b * 4096 + a; borders.set(key, (borders.get(key) || 0) + 1); }
    }
    if (i + W < N) {
      const b = own[i + W];
      if (b >= 0 && b !== a) { const key = a < b ? a * 4096 + b : b * 4096 + a; borders.set(key, (borders.get(key) || 0) + 1); }
    }
  }
}

const B_STEPPE = BIOME.STEPPE, B_SAVANNA = BIOME.SAVANNA, B_COLD_DESERT = BIOME.COLD_DESERT, B_SHRUB = BIOME.SHRUBLAND;
/** Claim the reached tiles (land to its settlement and civ, water as fishing grounds); tallies land and steppe per civ. */
function claimKernel(list, ln, lab, civOf, water, own, ownS, ws, biome, terr, steppe) {
  let changed = false;
  for (let k = 0; k < ln; k++) {
    const i = list[k];
    const sid = lab[i];
    if (water[i] === LAND) {
      const o = civOf[sid];
      if (ownS[i] !== sid || own[i] !== o) { ownS[i] = sid; own[i] = o; changed = true; }
      ws[i] = -1;
      terr[o]++;
      const b = biome[i];
      if (b === B_STEPPE || b === B_SAVANNA || b === B_COLD_DESERT || b === B_SHRUB) steppe[o]++;
    } else {
      ws[i] = sid;
      if (own[i] !== -1 || ownS[i] !== -1) { own[i] = -1; ownS[i] = -1; changed = true; }
    }
  }
  return changed;
}

/**
 * A new settlement takes up its own tile and the free or kindred ground around it at once
 * (land that is unclaimed or already its realm's, never a foreign realm's, never nearer to
 * another town), so it can work its fields before the next territory pass settles the
 * borders properly. Claimed tiles join the last pass's list, so a pass that no longer
 * reaches them releases them — exactly as a reloaded world (which rebuilds that list from
 * every owned tile) would. Returns true if anything changed.
 */
export function claimAround(world, s) {
  if (!s || !s.alive) return false;
  const { W, H, N, f } = world;
  const T = buffers(world).terr;
  let changed = false;
  for (let dy = -1; dy <= 1; dy++) {
    const y = s.y + dy;
    if (y < 0 || y >= H) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const x = s.x + dx;
      if (x < 0 || x >= W) continue;
      const i = y * W + x;
      if (f.water[i] !== LAND) continue;
      if (i !== s.i && f.settle[i] >= 0) continue;
      const o = f.owner[i], os = f.ownerSettle[i];
      if (o >= 0 && o !== s.civId) continue;
      if (os >= 0 && os !== s.id && i !== s.i) {
        const t = world.settlements[os];
        if (t && t.alive && (t.x - x) ** 2 + (t.y - y) ** 2 <= dx * dx + dy * dy) continue;
      }
      if (os !== s.id || o !== s.civId) { f.ownerSettle[i] = s.id; f.owner[i] = s.civId; changed = true; }
      if (T.prevN >= 0 && T.prevN < N) T.prev[T.prevN++] = i;
    }
  }
  if (changed) bumpVersion(world, 'owner');
  return changed;
}

/**
 * Shared land borders (Map pairKey → length) for the owner grid as it is now. Conquests and
 * razings change owners between territory passes; the map follows them (and is rebuilt the
 * same way after a reload).
 */
export function bordersMap(world) {
  const c = civCache(world);
  if (c.borders && c.bordersV === world.versions.owner) return c.borders;
  const { W, N, f } = world;
  const borders = new Map();
  gridBordersKernel(f.owner, W, N, borders);
  c.borders = borders; c.bordersV = world.versions.owner;
  return borders;
}

/** civId → [neighbour civ ids] in border-map order, rebuilt with the border map. */
export function borderNeighbourMap(world) {
  const b = bordersMap(world);
  const c = civCache(world);
  if (c.nbrSrc === b && c.nbr) return c.nbr;
  const m = new Map();
  for (const [k, len] of b) {
    if (len <= 0) continue;
    const x = Math.floor(k / 4096), y = k % 4096;
    let lx = m.get(x); if (!lx) m.set(x, (lx = [])); lx.push(y);
    let ly = m.get(y); if (!ly) m.set(y, (ly = [])); ly.push(x);
  }
  c.nbr = m; c.nbrSrc = b;
  return m;
}
const NO_NBRS = Object.freeze([]);
/** Civ ids sharing a land border with civId (from the owner grid as it is now). */
export function borderNeighbours(world, civId) {
  return borderNeighbourMap(world).get(civId) || NO_NBRS;
}

/** Length of the shared border between two civs (tiles). */
export function borderLength(world, a, b) {
  const m = bordersMap(world);
  if (!m || a === b) return 0;
  return m.get(a < b ? a * 4096 + b : b * 4096 + a) || 0;
}
