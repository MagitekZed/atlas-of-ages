// Level-of-detail chunk pyramid: camera-independent caches of the static close-zoom detail
// (relief, trees, fields, graves …), so zooming and panning cost a few dozen blits a frame
// instead of thousands of glyphs.
//
// Level k paints at P = 16·2^k device px per tile (k = 0..4) into chunks of 256 × 256 device
// px, so a chunk covers 16, 8, 4, 2 or 1 tiles a side. The level is chosen so a chunk is
// always shown at a scale in (0.5, 1] (crisp, never magnified) up to level 4. Chunks are
// transparent: the live terrain raster shows beneath them, so the seasons sweep seamlessly.
//
// Painters (registerPainter) draw into a chunk in its own device pixels with no camera
// dependence; static scatter is keyed by tile (hash2i), never by chunk, and every painter
// covers an apron of tiles beyond the chunk edge, so glyphs that cross a seam are drawn in
// both neighbours and meet exactly. Each chunk carries an FNV signature over the quantised
// tile data it depends on (biome, farm, vegetation, snow, people, roads, scars, fire, rivers,
// owner era) plus a season bucket and whatever extra the painters sign for; visible chunks are
// re-signed every 300 ms and rebuilt nearest-first within a per-frame budget (stale chunks
// keep drawing until their replacement fades in over 120 ms). A missing chunk falls back to
// its parent level, then its children, then nothing (the raster). LRU-capped by bytes.
//
// Purely cosmetic and read-only: painters never touch world state or world.rng.

import { WATER } from '../core/constants.js';
import { clamp } from '../core/util.js';
import { yearPhase } from '../core/world.js';
import { makeCanvas } from './terrain.js';
import { SpriteCache } from './glyphs.js';

/** Device px per tile for each level. */
export const LOD_P = [16, 32, 64, 128, 256];
export const LOD_MAX = LOD_P.length - 1;
/** Chunk side in device px. */
export const CHUNK_PX = 256;
/** The zoom ladder: [from z, to z, name, what appears next as you descend]. */
export const LOD_BANDS = [
  [0, 6, 'World', 'nations and seas'],
  [6, 12, 'Continent', 'roads, wonders and great battlefields'],
  [12, 24, 'Region', 'forests, fields and ruins'],
  [24, 64, 'Province', 'town plans and graves'],
  [64, 160, 'Town', 'town blocks, walls and temples'],
  [160, 320, 'Street', 'streets and single buildings'],
];

const perf = () => (globalThis.performance ? performance.now() : 0);

/** The level for z·dpr device px per tile: the smallest k with P_k ≥ z·dpr (capped at 4). */
export function pickLevel(zd) {
  if (!(zd > 16)) return 0;
  return clamp(Math.ceil(Math.log2(zd / 16) - 1e-9), 0, LOD_MAX);
}

// ---------------------------------------------------------------------------
// Painter registry

const painters = [];
let painterVersion = 1;

/**
 * registerPainter(id, minLevel, paint, opts?) → unregister()
 * paint(g, info) draws into a chunk's 2-D context in chunk device px (see LodCache._info for
 * info). opts: { order = 50, maxLevel = 4, families: ['full', 'peaks'] | null (all),
 * apron = 1 (tiles of overlap it needs; a number or one per level), sig(world, x0, y0, x1,
 * y1, k, r) → uint32 (extra
 * dependencies over the aproned tile box) }. Same id replaces. Wave-2 painters (enchantment,
 * blight, scars, roads) plug in here.
 */
export function registerPainter(id, minLevel, paint, opts = {}) {
  if (!id || typeof paint !== 'function') { console.warn('[lod] registerPainter(id, minLevel, paint) needs an id and a paint()'); return () => {}; }
  const d = { id, minLevel: clamp(minLevel | 0, 0, LOD_MAX), maxLevel: clamp(opts.maxLevel ?? LOD_MAX, 0, LOD_MAX), order: opts.order ?? 50,
    families: Array.isArray(opts.families) ? opts.families : null, apron: opts.apron ?? 1, sig: typeof opts.sig === 'function' ? opts.sig : null,
    paint, fails: 0, off: false };
  const k = painters.findIndex((p) => p.id === id);
  if (k >= 0) painters.splice(k, 1);
  painters.push(d);
  painters.sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
  painterVersion++;
  return () => { const j = painters.indexOf(d); if (j >= 0) { painters.splice(j, 1); painterVersion++; } };
}
export const listPainters = () => painters.map((p) => ({ id: p.id, minLevel: p.minLevel, maxLevel: p.maxLevel, order: p.order, off: p.off }));
/** A chunk family is "detail:style" (e.g. "full:natural"); painters list the detail kinds they serve. */
const detailOf = (family) => String(family).split(':')[0];
const activePainters = (k, family) => painters.filter((p) => !p.off && k >= p.minLevel && k <= p.maxLevel && (!p.families || p.families.includes(detailOf(family))));

// ---------------------------------------------------------------------------
// Signature helpers (32-bit word mixing, FNV-style)

export const mix = (h, v) => Math.imul(h ^ (v | 0), 16777619);
const finalMix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; return h >>> 0; };

const isPhone = () => {
  try { return Boolean(globalThis.matchMedia?.('(pointer: coarse)').matches) && Math.min(globalThis.screen?.width || 1e4, globalThis.screen?.height || 1e4) < 900; } catch (e) { return false; }
};

// ---------------------------------------------------------------------------
// The cache

export class LodCache {
  constructor(opts = {}) {
    this.map = new Map();        // key → chunk record
    this.bytes = 0;
    this.cap = opts.capBytes || (isPhone() ? 24 : 48) * 1024 * 1024;
    this.pool = [];              // spare chunk canvases for reuse: counted in the cap with the live ones
    this.poolMax = isPhone() ? 4 : 16;
    this.world = null;
    this.frameNo = 0;
    this.budgetMs = 3;
    this.signBudgetMs = 0.6;
    this.k = 0; this.family = null;
    this.vis = null;             // { k, n, cx0, cy0, cx1, cy1 } this frame
    this.sprites = LOD_P.map(() => new SpriteCache(420));
    this.stats = { k: 0, visible: 0, builds: 0, buildMs: 0, blits: 0, fallback: 0, chunks: 0, mb: 0, queue: 0, signMs: 0, lastBuildMs: 0 };
    this._signAt = new Map();    // key → last sign time
    this._ownerEra = new Int8Array(0); this._eraKey = '';
    this._errs = new Set();
  }

  setWorld(world) { this.purge(); this.world = world; this._eraKey = ''; }

  purge() {
    for (const c of this.map.values()) { this._release(c.canvas); this._release(c.old); }
    this.map.clear(); this._signAt.clear();
    this.bytes = 0;
  }

  _alloc() {
    const c = this.pool.pop() || makeCanvas(CHUNK_PX, CHUNK_PX);
    this.bytes += CHUNK_PX * CHUNK_PX * 4;
    return c;
  }
  _release(canvas) {
    if (!canvas) return;
    this.bytes -= CHUNK_PX * CHUNK_PX * 4;
    if (this.pool.length < this.poolMax && this._held() + CHUNK_PX * CHUNK_PX * 4 <= this.cap) this.pool.push(canvas);
  }
  /** Bytes held: live chunk canvases and the spare ones in the pool. */
  _held() { return this.bytes + this.pool.length * CHUNK_PX * CHUNK_PX * 4; }

  /** Per-civ era lookup for the tile signature (fields follow their owner's age). */
  _eras(w) {
    const key = `${w.versions.civs}|${Math.floor(w.time.day / 360)}|${w.civs.length}`;
    if (key === this._eraKey) return this._ownerEra;
    if (this._ownerEra.length < w.civs.length) this._ownerEra = new Int8Array(w.civs.length + 32);
    for (let k = 0; k < w.civs.length; k++) { const c = w.civs[k]; this._ownerEra[k] = c && c.alive ? (c.tech?.era | 0) : 0; }
    this._eraKey = key;
    return this._ownerEra;
  }

  /** Season bucket shared by all chunks this frame: −1 frozen (racing), else 0..nb−1. */
  _season(w, dps) {
    if (dps > 250) return { b: -1, nb: 1, phase: 0.45 };
    const nb = dps > 60 ? 4 : 12;
    const ph = yearPhase(w);
    const b = Math.floor(ph * nb) % nb;
    return { b, nb, phase: (b + 0.5) / nb };
  }

  /** The tile range a chunk paints (its own tiles plus an apron), clamped to the world. */
  _box(c, apron) {
    const w = this.world, n = CHUNK_PX / LOD_P[c.k];
    const x0 = c.cx * n, y0 = c.cy * n;
    return { x0, y0, n, ax0: Math.max(0, x0 - apron), ay0: Math.max(0, y0 - apron), ax1: Math.min(w.W - 1, x0 + n - 1 + apron), ay1: Math.min(w.H - 1, y0 + n - 1 + apron) };
  }

  /** Signature of a chunk's inputs. */
  _sign(c, r, season, list) {
    const w = this.world, f = w.f, W = w.W, H = w.H;
    const { ax0, ay0, ax1, ay1, y0, n } = this._box(c, 1);
    let h = 0x811c9dc5;
    h = mix(h, c.k);
    for (let q = 0; q < c.fam.length; q++) h = mix(h, c.fam.charCodeAt(q));
    h = mix(h, w.versions.terrain | 0); h = mix(h, w.versions.water | 0); h = mix(h, painterVersion);
    // the season matters only away from the tropics
    const latMax = Math.max(Math.abs(1 - (2 * (y0 + 0.5)) / H), Math.abs(1 - (2 * (y0 + n - 0.5)) / H));
    h = mix(h, latMax > 0.16 ? season.b + 7 : 3);
    const era = this._eras(w);
    const bi = f.biome, fm = f.farm, vg = f.veg, sn = f.snow, pd = f.popDensity, rd = f.road, bs = f.burnScar, dv = f.devastation, fi = f.fire, rv = f.river, wa = f.water, ow = f.owner;
    for (let y = ay0; y <= ay1; y++) {
      let i = y * W + ax0;
      for (let x = ax0; x <= ax1; x++, i++) {
        if (wa[i] !== WATER.LAND) { h = mix(h, 0x7fff0000 | wa[i]); continue; }
        const farm = fm[i];
        const fq = farm > 0 ? Math.min(7, (farm * 8) | 0) : 0;
        const p = pd[i];
        const pq = p > 1 ? Math.min(7, (Math.log2(p) * 0.5) | 0) : 0;
        const o = ow[i];
        const eq = fq > 0 && o >= 0 && o < era.length ? era[o] : 0;
        const code = bi[i] | (fq << 5) | (Math.min(7, (vg[i] * 8) | 0) << 8) | (Math.min(3, (sn[i] * 4) | 0) << 11) | (pq << 13)
          | ((rd[i] & 3) << 16) | (Math.min(3, (bs[i] * 4) | 0) << 18) | (Math.min(3, (dv[i] * 4) | 0) << 20) | ((fi[i] > 0.02 ? 1 : 0) << 22)
          | ((rv[i] & 7) << 23) | ((eq & 7) << 26);
        h = mix(h, code);
      }
    }
    for (const p of list) {
      if (!p.sig) continue;
      try { h = mix(h, p.sig(w, ax0, ay0, ax1, ay1, c.k, r) | 0); } catch (e) { this._report(p, e); }
    }
    return finalMix(h);
  }

  _report(p, e) {
    if (this._errs.has(p.id)) return;
    this._errs.add(p.id);
    console.error(`[lod painter:${p.id}]`, e);
  }

  /** Everything a painter needs, for one chunk. */
  _info(c, r, season, apron) {
    const w = this.world, P = LOD_P[c.k];
    const b = this._box(c, apron);
    const x0 = b.x0, y0 = b.y0, H = w.H;
    const frozen = season.b < 0, phase = season.phase;
    return {
      world: w, r, terr: r.terrain, k: c.k, P, n: b.n, x0, y0, x1: x0 + b.n - 1, y1: y0 + b.n - 1,
      ax0: b.ax0, ay0: b.ay0, ax1: b.ax1, ay1: b.ay1, apron, family: c.fam, full: detailOf(c.fam) === 'full',
      sprites: this.sprites[c.k], seed: r.seedHash || 0,
      /** chunk px of an entity coordinate (integer = tile centre) */
      px: (x) => (x + 0.5 - x0) * P,
      py: (y) => (y + 0.5 - y0) * P,
      /** local phase of the year for row y (0 midwinter, 0.5 midsummer), by hemisphere */
      localPhase: (y) => { if (frozen) return 0.45; const lat = 1 - (2 * (y + 0.5)) / H; let ph = phase + (lat < 0 ? 0.5 : 0); return ph - Math.floor(ph); },
      frozenSeason: frozen,
    };
  }

  _build(c, r, season, now) {
    const list = activePainters(c.k, c.fam);
    c.sig = this._sign(c, r, season, list);
    this._signAt.set(c.key, now);
    const canvas = this._alloc();
    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, CHUNK_PX, CHUNK_PX);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'medium';
    g.lineJoin = 'round'; g.lineCap = 'round';
    for (const p of list) {
      const ap = Math.max(0, Array.isArray(p.apron) ? (p.apron[c.k] ?? 1) : p.apron);
      const info = this._info(c, r, season, ap);
      g.save();
      try { p.paint(g, info); p.fails = 0; } catch (e) {
        this._report(p, e);
        if (++p.fails >= 3) { p.off = true; painterVersion++; console.warn(`[lod painter:${p.id}] switched off after repeated failures`); }
      }
      g.restore();
    }
    if (this.measureGpu) {
      // (profiling) wait for the GPU to raster this chunk, to see its real cost
      const t0 = perf();
      if (!this._probe) this._probe = makeCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      this._probe.drawImage(canvas, 0, 0, 1, 1, 0, 0, 1, 1); this._probe.getImageData(0, 0, 1, 1);
      this.stats.gpuBuildMs = (this.stats.gpuBuildMs || 0) + perf() - t0;
    }
    // keep the previous picture for the cross-fade
    if (c.canvas) { this._release(c.old); c.old = c.canvas; }
    c.canvas = canvas;
    c.builtAt = now;
    c.stale = false;
  }

  /**
   * Per-frame upkeep: choose the level, re-sign visible chunks, build the nearest missing or
   * stale ones within the budget. opts: { family, zd (z·dpr), now, dps, maxSpeed }.
   */
  update(r, opts) {
    const w = this.world;
    if (!w) return;
    const t0 = perf();
    this.frameNo++;
    this.stats.gpuBuildMs = 0;
    const { family, zd, now, dps = 0, maxSpeed = false } = opts;
    const k = pickLevel(zd), P = LOD_P[k], n = CHUNK_PX / P;
    this.k = k; this.family = family;
    const vb = r.viewBounds(0);
    const gw = Math.ceil(w.W / n), gh = Math.ceil(w.H / n);
    const cx0 = clamp(Math.floor(vb.x0 / n), 0, gw - 1), cx1 = clamp(Math.floor(vb.x1 / n), 0, gw - 1);
    const cy0 = clamp(Math.floor(vb.y0 / n), 0, gh - 1), cy1 = clamp(Math.floor(vb.y1 / n), 0, gh - 1);
    this.vis = { k, n, cx0, cy0, cx1, cy1, gw, gh };
    const season = this._season(w, dps);
    this._seasonNow = season;
    const cam = r.camera;
    const ccx = cam.x / n - 0.5, ccy = cam.y / n - 0.5;
    // re-sign visible chunks round-robin (each at least every 300 ms), queue missing / stale
    const queue = [];
    const list = activePainters(k, family);
    let signT = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${family}|${k}|${cx}|${cy}`;
        let c = this.map.get(key);
        if (!c) { c = { key, k, cx, cy, fam: family, canvas: null, old: null, sig: 0, builtAt: -1e9, stale: true, used: 0 }; this.map.set(key, c); }
        c.used = this.frameNo;
        if (c.canvas && !c.stale && signT < this.signBudgetMs && now - (this._signAt.get(key) ?? -1e9) > 300) {
          const s0 = perf();
          const sig = this._sign(c, r, season, list);
          this._signAt.set(key, now);
          if (sig !== c.sig) c.stale = true;
          signT += perf() - s0;
        }
        if (!c.canvas || c.stale) queue.push({ c, d: (cx - ccx) ** 2 + (cy - ccy) ** 2, empty: !c.canvas });
      }
    }
    this.stats.signMs = signT;
    queue.sort((a, b) => (b.empty - a.empty) || a.d - b.d);
    // build within the budget (at least one when a visible chunk is still empty)
    const maxBuilds = maxSpeed ? 1 : 2;
    let built = 0;
    const tb = perf();
    for (const q of queue) {
      if (built >= maxBuilds) break;
      const el = perf() - t0;
      if (built > 0 && el >= this.budgetMs) break;
      if (built === 0 && el >= this.budgetMs && !q.empty) break;
      const s0 = perf();
      this._build(q.c, r, season, now);
      this.stats.lastBuildMs = perf() - s0;
      built++;
    }
    // idle: prefetch the ring around the view
    if (!queue.length && perf() - t0 < this.budgetMs * 0.5) {
      let best = null, bd = Infinity;
      for (let cy = cy0 - 1; cy <= cy1 + 1; cy++) for (let cx = cx0 - 1; cx <= cx1 + 1; cx++) {
        if (cx < 0 || cy < 0 || cx >= gw || cy >= gh || (cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1)) continue;
        const key = `${family}|${k}|${cx}|${cy}`;
        const c = this.map.get(key);
        if (c && c.canvas) { c.used = this.frameNo; continue; }
        const d = (cx - ccx) ** 2 + (cy - ccy) ** 2;
        if (d < bd) { bd = d; best = { key, cx, cy }; }
      }
      if (best) {
        let c = this.map.get(best.key);
        if (!c) { c = { key: best.key, k, cx: best.cx, cy: best.cy, fam: family, canvas: null, old: null, sig: 0, builtAt: -1e9, stale: true, used: this.frameNo }; this.map.set(best.key, c); }
        this._build(c, r, season, now - 1000);   // prefetched chunks need no fade
        built++;
      }
    }
    if (built) { this.stats.builds += built; this.stats.buildMs = perf() - tb; } else this.stats.buildMs = 0;
    this.stats.frameBuilds = built;
    this.stats.queue = Math.max(0, queue.length - built);
    this._evict();
    this.stats.k = k; this.stats.visible = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    this.stats.chunks = this.map.size; this.stats.mb = this._held() / 1048576;
  }

  _evict() {
    // spare canvases go first: they hold memory and show nothing
    while (this.pool.length && this._held() > this.cap) this.pool.pop();
    if (this.bytes <= this.cap) return;
    const cam = this.vis;
    const cands = [];
    for (const c of this.map.values()) {
      if (c.used === this.frameNo) continue;
      // older first, then farther (in this level's chunk units)
      const n = CHUNK_PX / LOD_P[c.k];
      const d = cam ? Math.hypot((c.cx + 0.5) * n - (cam.cx0 + cam.cx1 + 1) * cam.n / 2, (c.cy + 0.5) * n - (cam.cy0 + cam.cy1 + 1) * cam.n / 2) : 0;
      cands.push({ c, age: this.frameNo - c.used, d });
    }
    cands.sort((a, b) => b.age - a.age || b.d - a.d);
    for (const { c } of cands) {
      if (this.bytes <= this.cap * 0.9) break;
      this._release(c.canvas); this._release(c.old);
      this.map.delete(c.key); this._signAt.delete(c.key);
    }
    // chunks that were never built and are out of view are just records: drop them too
    if (this.map.size > 4000) for (const c of [...this.map.values()]) if (!c.canvas && c.used !== this.frameNo) this.map.delete(c.key);
  }

  /** The chunk record at (k, cx, cy) with a picture, or null. */
  _get(k, cx, cy) {
    const c = this.map.get(`${this.family}|${k}|${cx}|${cy}`);
    if (c && c.canvas) { c.used = this.frameNo; return c; }
    return null;
  }

  /**
   * Blit the visible chunks (device px, inside the caller's world clip). alpha: overall
   * opacity of the detail layer; shx / shy: screen shake in CSS px.
   */
  draw(ctx, r, alpha = 1, shx = 0, shy = 0, now = perf()) {
    const v = this.vis;
    if (!v || alpha <= 0.01) return;
    const cam = r.camera, z = cam.zoom, dpr = r.dpr;
    const ox = r.viewW / 2 + shx, oy = r.viewH / 2 + shy;
    const X = (mx) => Math.round(((mx - cam.x) * z + ox) * dpr);
    const Y = (my) => Math.round(((my - cam.y) * z + oy) * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    const n = v.n, k = v.k;
    let blits = 0, fb = 0;
    const S = CHUNK_PX;
    for (let cy = v.cy0; cy <= v.cy1; cy++) {
      const dy0 = Y(cy * n), dy1 = Y(cy * n + n);
      for (let cx = v.cx0; cx <= v.cx1; cx++) {
        const dx0 = X(cx * n), dx1 = X(cx * n + n);
        const dw = dx1 - dx0, dh = dy1 - dy0;
        const c = this._get(k, cx, cy);
        const fade = c ? clamp((now - c.builtAt) / 120, 0, 1) : 0;
        if (!c || fade < 1) {
          // what to show beneath: the previous picture, else a coarser (or finer) level
          if (c && c.old) {
            ctx.globalAlpha = alpha * (1 - fade);
            ctx.drawImage(c.old, 0, 0, S, S, dx0, dy0, dw, dh); blits++;
          } else if (this._fallback(ctx, k, cx, cy, dx0, dy0, dw, dh, alpha * (c ? 1 - fade : 1))) fb++;
        }
        if (c) {
          if (fade >= 1 && c.old) { this._release(c.old); c.old = null; }
          ctx.globalAlpha = alpha * fade;
          ctx.drawImage(c.canvas, 0, 0, S, S, dx0, dy0, dw, dh); blits++;
        }
      }
    }
    ctx.globalAlpha = 1;
    this.stats.blits = blits; this.stats.fallback = fb;
  }

  _fallback(ctx, k, cx, cy, dx0, dy0, dw, dh, a) {
    if (a <= 0.01) return false;
    // parent, grandparent: the matching quadrant of a coarser chunk, magnified
    for (let up = 1; up <= 2 && k - up >= 0; up++) {
      const f = 1 << up;
      const p = this._get(k - up, Math.floor(cx / f), Math.floor(cy / f));
      if (!p) continue;
      const sub = CHUNK_PX / f;
      ctx.globalAlpha = a;
      ctx.drawImage(p.canvas, (cx % f) * sub, (cy % f) * sub, sub, sub, dx0, dy0, dw, dh);
      return true;
    }
    // children: four finer chunks, shrunk (zooming out)
    if (k < LOD_MAX) {
      let any = false;
      for (let q = 0; q < 4; q++) {
        const ch = this._get(k + 1, cx * 2 + (q & 1), cy * 2 + (q >> 1));
        if (!ch) continue;
        const hx = dx0 + ((q & 1) ? Math.round(dw / 2) : 0), hy = dy0 + ((q >> 1) ? Math.round(dh / 2) : 0);
        const hw = (q & 1) ? dw - Math.round(dw / 2) : Math.round(dw / 2), hh = (q >> 1) ? dh - Math.round(dh / 2) : Math.round(dh / 2);
        ctx.globalAlpha = a;
        ctx.drawImage(ch.canvas, 0, 0, CHUNK_PX, CHUNK_PX, hx, hy, hw, hh);
        any = true;
      }
      return any;
    }
    return false;
  }

  /** Drop every chunk whose box meets the tile rectangle (e.g. after an edit the signature cannot see). */
  invalidateBox(x0, y0, x1, y1) {
    for (const c of this.map.values()) {
      const n = CHUNK_PX / LOD_P[c.k];
      if (c.cx * n > x1 + 3 || (c.cx + 1) * n < x0 - 3 || c.cy * n > y1 + 3 || (c.cy + 1) * n < y0 - 3) continue;
      c.stale = true;
    }
  }
}
