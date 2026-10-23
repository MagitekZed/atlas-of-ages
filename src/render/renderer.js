// Atlas of Ages renderer — a living, hand-tinted atlas on a 2-D canvas.
//
//   const r = createRenderer(canvas, world);  r.render(nowMs) every animation frame.
//
// Layers, bottom to top: the ground (terrain raster: hillshade + micro-relief, biomes,
// seasons, snow, water; a paper tooth once magnified) → territory wash & glow → water glints →
// close-zoom detail from the LOD chunk pyramid (crisp shores, hills, fields, trees, graves) →
// graticule → rivers → coastline ink & water-lining → roads → town ground plans → trade routes
// → wonder walls, canals and dams → borders → selection, tool-preview and highlight outlines →
// cloud deck → fires, volcanoes, resources → historic sites and wonders → region names →
// settlements → caravans, ships, armies, locust swarms → particles → storms → effects and their
// off-screen pointers → place names → selection marker, brush, reticles → vignette, flash.
// All world-derived geometry is cached and rebuilt from world.versions; the terrain raster
// refreshes incrementally under a per-frame time budget, the territory raster and the border
// network rebuild as time-sliced jobs, and close detail is built chunk by chunk within a budget,
// so a fast-running world never stalls a frame.
// Other packages draw through the registries in ./layers.js (layer slots, effect types,
// map modes; contracts §14), loaded via ./plugins.js; with nothing registered the frame is
// exactly the built-in one. Chunk painters plug in through ./lod.js registerPainter.

import { WATER, TIERS, DAYS_PER_YEAR, DAYS_PER_MONTH } from '../core/constants.js';
import { base64ToTyped } from '../core/serialize.js';
import { clamp, smoothstep } from '../core/util.js';
import { hashString } from '../core/rng.js';
import { Camera } from './camera.js';
import { TerrainLayer, STYLE_FOR_MODE, makeCanvas, paintGround } from './terrain.js';
import { TerritoryLayer, CategoryVote, computeAnchors } from './territory.js';
import { contour, chainsToPath, coastDistance, buildRivers, buildRoads, traceEdges, edgesToPath, riverWidthK, drawDeltas } from './vectors.js';
import { SpriteCache } from './glyphs.js';
import { Labeler } from './labels.js';
import { FxSystem } from './fx.js';
import { Atmosphere } from './clouds.js';
import { LodCache, LOD_BANDS, pickLevel } from './lod.js';
import { drawCityPlans, planSmoke } from './cityplan.js';
import { drawSites, drawRuins, drawWonders, drawWonderWorks } from './sites.js';
import './detail.js';
import './fields.js';
import { MAP_MODES, MODE_IDS, MODE_PROFILE, buildLegend, mapModesFor, registeredStyle } from './modes.js';
import { layersFor, drawLayer, hasLayers, getMapMode } from './layers.js';
import * as P from './palette.js';
import {
  drawSettlements, drawRoutes, drawArmies, drawStorms, drawFires, drawVolcanoes, drawSwarms,
  fireLabels, drawResources, tierRadius, reserveCapitals,
} from './entities.js';
import { drawTraffic } from './traffic.js';
import { drawHighlightsWorld, drawHighlightsScreen, previewRefused } from './highlights.js';

export { MAP_MODES, mapModesFor };

// Other packages' render modules register their layers, effect types and map modes on import.
try { await import('./plugins.js'); } catch (e) { console.warn('[render] plugins unavailable:', e); }

/** The built-in overlays (all on at first); setOverlay also accepts the ids packages register. */
const OVERLAY_KEYS = ['borders', 'labels', 'rivers', 'roads', 'clouds', 'units', 'routes', 'features', 'grid'];
/** Geographic names lettered beneath the town icons (phase 1). */
const REGION_KINDS = new Set(['continent', 'ocean', 'sea', 'desert', 'forest', 'range']);
const perf = () => (globalThis.performance ? performance.now() : 0);
const KM_PER_TILE = 20;
/** Deepest zoom (CSS px per tile) once the chunk pyramid serves close detail; 80 without it. */
const MAX_ZOOM_LOD = 320;
const terrainStyleFor = (id) => STYLE_FOR_MODE[id] || registeredStyle(id) || 'natural';

/** A hit as pickEntity / pickAll report it: { kind, id } plus the place for kinds that lead somewhere. */
function pickOf(h) {
  const o = { kind: h.kind, id: h.id };
  if (Number.isFinite(h.ex) && Number.isFinite(h.ey)) { o.x = h.ex; o.y = h.ey; }
  if (h.sid != null) o.sid = h.sid;
  if (h.key != null) o.key = h.key;
  return o;
}

export function createRenderer(canvas, world) {
  return new Renderer(canvas, world);
}

class Renderer {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
    this.camera = new Camera();
    this.overlays = Object.fromEntries(OVERLAY_KEYS.map((k) => [k, true]));   // registered overlay ids join as they are set
    this._mode = 'terrain';
    this.selection = null;
    this.brush = null;
    this.snapshot = null;
    this.sprites = new SpriteCache(1600);
    this.labeler = new Labeler();
    this.fx = new FxSystem();
    this.hits = [];          // this frame's hit boxes { kind, id, x0, y0, x1, y1, pri } (screen CSS px); layers push here too
    this.toolPreview = null; // setToolPreview (drawn by WP7's highlights)
    this.highlights = [];    // setHighlights
    this.onFx = null;        // assignable: onFx(fx, { sx, sy, onScreen, dist }) as each effect starts
    this.lod = new LodCache();
    this.lodReady = true;    // the close-zoom chunk pyramid serves deep zoom (maxZoom 320)
    this.camera.maxZoomCap = MAX_ZOOM_LOD;
    this._regModeErr = null;
    this._routeCache = new Map();
    this.dpr = 1; this.viewW = 1; this.viewH = 1;
    this.now = perf(); this._lastNow = null;
    this.terrainBudgetMs = 3;
    this.stats = { fps: 0, frameMs: 0, terrainMs: 0, frames: 0, glyphs: 0, labels: 0 };
    this.reducedMotion = false;
    this.bg = P.MAP_BG;
    try {
      const mq = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
      if (mq) {
        this.reducedMotion = mq.matches;
        mq.addEventListener?.('change', (e) => { this.reducedMotion = e.matches; this.camera.reducedMotion = e.matches; });
      }
    } catch (e) { /* no matchMedia */ }
    this.camera.reducedMotion = this.reducedMotion;
    try {
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => { this._needResize = true; });
        this._ro.observe(canvas);
      }
    } catch (e) { /* no ResizeObserver */ }
    this.world = null;
    this.resize();
    this.setWorld(world);
  }

  // ---------------------------------------------------------------------------
  // World & view

  setWorld(world) {
    const prev = this.world;
    this.world = world || null;
    this.fx.clear();
    this._routeCache.clear();
    this._settleKey = null; this._settleList = null; this._ruins = null;
    this._fp = null; this._fpKey = null; this._planLast = null; this._styles = null; this._realmPaths = null;
    this._siteIdx = null; this._siteKey = null; this._ruinList = null; this._ruinKey = null;
    this._labelCache = null; this._regionSig = null; this._planRects = null; this._townNamed = null;
    if (this._plans) this._plans.clear();
    this._fireList = []; this._fireScanAt = -1e9; this._fireScanDay = -1;
    this.snapshot = null; this._snapSrc = null;
    this.vec = { vWater: null, vTerrain: null, vRoads: null, borderKey: null, borderAt: -1e9 };
    this._bjob = null; this._bvotes = null; this._bvote = null;
    this._own = null; this._ownKey = null;
    this._civAnchors = new Map();
    this._selKey = null; this._selPath = null;
    this._miniKey = null; this._miniAt = -1e9;
    this.terrain = null; this.territory = null; this.atmos = null;
    this.lod.setWorld(world || null);
    this.seedHash = world ? hashString(String(world.seed ?? '')) & 0xffff : 0;
    if (!world) return;
    this.terrain = new TerrainLayer(world, { style: terrainStyleFor(this._mode) });
    this.terrain.built = false;
    this.territory = new TerritoryLayer(world, this.terrain);
    this.atmos = new Atmosphere(world);
    this.camera.setWorld(world.W, world.H);
    this.camera.setView(this.viewW, this.viewH);
    if (!prev || prev.W !== world.W || prev.H !== world.H || !this._fitted) { this.camera.fit(); this._fitted = true; }
    else this.camera.clampPosition();
  }

  resize() {
    const c = this.canvas;
    const dpr = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1));
    let cssW = c.clientWidth, cssH = c.clientHeight;
    if (!cssW || !cssH) { cssW = c.width / dpr || 1; cssH = c.height / dpr || 1; }
    cssW = Math.max(1, Math.round(cssW)); cssH = Math.max(1, Math.round(cssH));
    const pw = Math.max(1, Math.round(cssW * dpr)), ph = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== pw) c.width = pw;
    if (c.height !== ph) c.height = ph;
    const dprChanged = dpr !== this.dpr;
    this.dpr = dpr; this.viewW = cssW; this.viewH = cssH;
    if (dprChanged) { this.sprites.clear(); this.labeler.cache.clear(); }
    this.camera.setView(cssW, cssH);
    this._needResize = false;
  }

  get mapMode() { return this._mode; }
  get profile() { return MODE_PROFILE[this.snapshot ? 'political' : this._mode] || MODE_PROFILE.terrain; }

  setMapMode(id) {
    if (!MODE_IDS.has(id)) return false;
    this._mode = id;
    if (this.terrain) this.terrain.setStyle(terrainStyleFor(id));
    this._miniKey = null;
    return true;
  }

  /** Overlay ids are dynamic: the built-ins (OVERLAY_KEYS) and any a package registers, read by its layer from r.overlays[id]. */
  setOverlay(name, on) {
    if (typeof name !== 'string' || !name) return false;
    this.overlays[name] = Boolean(on);
    return true;
  }

  setSelection(sel) {
    this.selection = sel && sel.kind ? { ...sel } : null;
    this._selKey = null;
  }

  setBrush(b) {
    this.brush = b && Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: b.x, y: b.y, radius: Math.max(0, Number(b.radius) || 0) } : null;
  }

  /** A god tool's hover preview (previewTool's result) or null. Stored for the highlight layer (WP7). */
  setToolPreview(p) { this.toolPreview = p && typeof p === 'object' ? p : null; }
  /** Extra highlight rings [{ x, y, r, tone, label? }] (entity coordinates). Stored for the highlight layer (WP7). */
  setHighlights(list) { this.highlights = Array.isArray(list) ? list.filter((q) => q && Number.isFinite(q.x) && Number.isFinite(q.y)) : []; }

  /** Show a historical atlas snapshot (stats §8) instead of live borders; null restores. */
  setAtlasSnapshot(snap) {
    if (!snap || !this.world) { this.snapshot = null; this._snapSrc = null; return; }
    if (snap === this._snapSrc && this.snapshot) return;
    const w = this.world, W = w.W, H = w.H, N = w.N;
    let grid = null;
    try {
      if (typeof snap.owner === 'string') grid = base64ToTyped(snap.owner, Int16Array);
      else if (snap.owner && (Array.isArray(snap.owner) || ArrayBuffer.isView(snap.owner))) grid = Int16Array.from(snap.owner);
    } catch (e) { grid = null; }
    const sw = Math.max(1, snap.w | 0 || Math.ceil(W / 2)), sh = Math.max(1, snap.h | 0 || Math.ceil(H / 2));
    const full = new Int16Array(N).fill(-1);
    if (grid && grid.length >= sw * sh) {
      for (let y = 0; y < H; y++) {
        const syy = Math.min(sh - 1, Math.floor((y * sh) / H));
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (w.f.water[i] !== WATER.LAND) continue;
          const v = grid[syy * sw + Math.min(sw - 1, Math.floor((x * sw) / W))];
          full[i] = v >= 0 && v < w.civs.length ? v : -1;
        }
      }
    }
    const towns = [];
    const best = new Map();
    (Array.isArray(snap.towns) ? snap.towns : []).forEach((t, k) => {
      if (!Array.isArray(t) || t.length < 4) return;
      const [x, y, civId, tier, name] = t;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const tt = Math.max(0, Math.min(6, tier | 0));
      const e = { id: -1 - k, s: null, x, y, civId, tier: tt, name: String(name ?? ''), capital: false, pop: TIERS[tt].minPop };
      towns.push(e);
      const b = best.get(civId);
      if (!b || e.tier > b.tier) best.set(civId, e);
    });
    for (const e of best.values()) e.capital = true;
    towns.sort((a, b) => a.y - b.y || a.x - b.x);
    this.snapshot = { y: snap.y, owner: full, towns, civIds: [...best.keys()] };
    this._snapSrc = snap;
  }

  /** The colour of the void around the world (the UI passes its theme's token). */
  setBackground(css) { this.bg = typeof css === 'string' && css.trim() ? css.trim() : P.MAP_BG; }

  fitWorld() { this.camera.fit(); }
  /** Frame a box of entity coordinates (inclusive), keeping pad CSS px clear around it. */
  frameBox(x0, y0, x1, y1, pad = 48) {
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    const c = this.camera;
    const bw = Math.abs(x1 - x0) + 1, bh = Math.abs(y1 - y0) + 1;
    // the strip left uncovered by the phone sheet / HUD insets is what must hold the box
    const iT = c.insetTop || 0, iB = c.insetBottom || 0;
    const openH = Math.max(48, this.viewH - iT - iB);
    const p = clamp(Number.isFinite(pad) ? pad : 48, 0, Math.min(this.viewW, openH) / 3);
    const z = clamp(Math.min((this.viewW - 2 * p) / bw, (openH - 2 * p) / bh), c.minZoom, c.maxZoom);
    const cy = (Math.min(y0, y1) + Math.max(y0, y1)) / 2 + 0.5 - (iT - iB) / 2 / z;
    this.camera.focusOn((Math.min(x0, x1) + Math.max(x0, x1)) / 2 + 0.5, cy, z);
  }
  /**
   * Where the camera sits on the zoom ladder: { z, name, band, kmPerPx, next, nextName,
   * nextHint, level } — next is the zoom where the next band begins (null at the deepest),
   * nextHint what appears there, level the detail pyramid level being drawn.
   */
  getZoomInfo() {
    const z = this.camera.zoom;
    let band = 0;
    for (let k = 1; k < LOD_BANDS.length; k++) if (z >= LOD_BANDS[k][0]) band = k;
    const nb = band + 1 < LOD_BANDS.length ? LOD_BANDS[band + 1] : null;
    return {
      z, name: LOD_BANDS[band][2], band, kmPerPx: KM_PER_TILE / Math.max(1e-6, z),
      next: nb ? nb[0] : null, nextName: nb ? nb[2] : null, nextHint: nb ? nb[3] : null,
      level: pickLevel(z * this.dpr), maxZoom: this.camera.maxZoom,
    };
  }
  /** Effects that started at or after sinceMs (the clock render(nowMs) runs on): [{ type, x, y, r, civId, t }]. */
  recentFx(sinceMs = -Infinity) { return this.fx.recentSince(Number.isFinite(sinceMs) ? sinceMs : -Infinity); }
  pan(dx, dy) { this.camera.pan(dx, dy); }
  zoomAt(sx, sy, factor, instant) { this.camera.zoomAt(sx, sy, factor, instant); }
  focusOn(x, y, zoom) { this.camera.focusOn(x, y, zoom); }
  /** CSS px at the top and bottom of the canvas covered by UI (e.g. a phone's bottom sheet). */
  setViewInsets(top = 0, bottom = 0) { this.camera.setInsets(top, bottom); }

  /** Screen (CSS px) → tile { x, y, i } (integers) plus fx, fy map coordinates; null off-map. */
  screenToTile(sx, sy) {
    const w = this.world;
    if (!w || !Number.isFinite(sx) || !Number.isFinite(sy)) return null;
    const p = this.camera.screenToWorld(sx, sy);
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= w.W || y >= w.H) return null;
    return { x, y, i: y * w.W + x, fx: p.x, fy: p.y };
  }
  /** Map coordinates (tile x spans [x, x+1)) → screen CSS px. */
  tileToScreen(x, y) { return this.camera.worldToScreen(x, y); }
  /** Entity coordinates (integer = tile centre, as used by settlements, armies, fx) → screen. */
  e2s(x, y) { return this.camera.worldToScreen(x + 0.5, y + 0.5); }

  /** Visible tile range (inclusive) with a margin in tiles. */
  viewBounds(m = 1) {
    const w = this.world, c = this.camera;
    const hw = this.viewW / 2 / c.zoom, hh = this.viewH / 2 / c.zoom;
    return {
      x0: Math.max(0, Math.floor(c.x - hw) - m), x1: Math.min(w.W - 1, Math.floor(c.x + hw) + m),
      y0: Math.max(0, Math.floor(c.y - hh) - m), y1: Math.min(w.H - 1, Math.floor(c.y + hh) + m),
    };
  }
  /** Is entity point (x, y) within the view plus a margin (tiles)? */
  isNear(x, y, marginTiles = 10) {
    const c = this.camera;
    const hw = this.viewW / 2 / c.zoom + marginTiles, hh = this.viewH / 2 / c.zoom + marginTiles;
    return Math.abs(x + 0.5 - c.x) < hw && Math.abs(y + 0.5 - c.y) < hh;
  }

  /**
   * Wait for the GPU to finish this canvas's drawing (profiling and perf tests). It reads one
   * pixel through a tiny side canvas: reading the map canvas itself would make the browser
   * move it off the GPU for good.
   */
  gpuFlush() {
    if (!this._flushCtx) {
      const c = makeCanvas(1, 1);
      this._flushCtx = c.getContext('2d', { willReadFrequently: true });
    }
    try { this._flushCtx.drawImage(this.canvas, 0, 0, 1, 1, 0, 0, 1, 1); this._flushCtx.getImageData(0, 0, 1, 1); } catch (e) { /* tainted or detached */ }
  }

  pickEntity(sx, sy) {
    let best = null, bp = -1, bd = Infinity;
    for (const h of this.hits) {
      if (sx < h.x0 || sx > h.x1 || sy < h.y0 || sy > h.y1) continue;
      const cx = (h.x0 + h.x1) / 2, cy = (h.y0 + h.y1) / 2;
      const d = (sx - cx) ** 2 + (sy - cy) ** 2;
      if (h.pri > bp || (h.pri === bp && d < bd)) { best = h; bp = h.pri; bd = d; }
    }
    return best ? pickOf(best) : null;
  }

  /** Where an off-screen act's edge pointer leads (pickEntity's fxPointer id): { type, x, y, text } or null. */
  fxPointer(id) { return this.fx.pointerTarget(id); }

  /** Everything stacked under a point, best first (the first is what pickEntity returns): [{ kind, id }]. */
  pickAll(sx, sy) {
    const found = [];
    for (const h of this.hits) {
      if (sx < h.x0 || sx > h.x1 || sy < h.y0 || sy > h.y1) continue;
      const cx = (h.x0 + h.x1) / 2, cy = (h.y0 + h.y1) / 2;
      found.push({ h, d: (sx - cx) ** 2 + (sy - cy) ** 2 });
    }
    found.sort((a, b) => b.h.pri - a.h.pri || a.d - b.d);
    const seen = new Set(), out = [];
    for (const { h } of found) {
      const k = h.kind + ':' + h.id;
      if (!seen.has(k)) { seen.add(k); out.push(pickOf(h)); }
    }
    return out;
  }

  getLegend() {
    const w = this.world;
    if (!w) return { title: 'Map', type: 'swatches', items: [] };
    if (this.snapshot) {
      const civs = this.snapshot.civIds.map((id) => w.civs[id]).filter(Boolean);
      return buildLegend(w, 'political', { snapshotCivs: civs, snapshotYear: this.snapshot.y });
    }
    return buildLegend(w, this._mode);
  }

  // ---------------------------------------------------------------------------
  // Cache synchronisation

  _syncVectors(force = false) {
    const w = this.world, v = w.versions, vec = this.vec;
    // coastline ink follows the land field (elevation edits move it; redrawn at most four
    // times a second while a brush is at work); water-lining and rivers follow the water
    // mask and drainage, which only change when hydrology reruns
    const waterChanged = force || v.water !== vec.vWater;
    if (waterChanged || (v.terrain !== vec.vTerrain && this.now - (vec.coastAt ?? -1e9) > 250)) {
      const t0 = perf();
      const W = w.W, H = w.H;
      vec.coast = chainsToPath(contour(W, H, this.terrain.Lv, 0, 3), 2, [W, H]);
      vec.vTerrain = v.terrain; vec.coastAt = this.now;
      if (waterChanged) {
        const D = coastDistance(w, 4);
        vec.waterlines = [0.42, 0.95, 1.65].map((lvl) => chainsToPath(contour(W, H, D, lvl, 2), 4, [W, H]));
        vec.rivers = buildRivers(w, 10, true, 2, this.terrain.Lv);
        vec.vWater = v.water;
      }
      this.stats.vectorMs = perf() - t0;
    }
    if (force || v.roads !== vec.vRoads) {
      vec.roads = buildRoads(w);
      vec.vRoads = v.roads;
    }
    // borders & civ label anchors: rebuilt at most every 300 ms while the map changes, as
    // a time-sliced job (the first build and atlas snapshots complete at once)
    const key = this.snapshot ? `snap|${this.snapshot.y}|${v.water}` : `${v.owner}|${v.civs}|${v.water}`;
    if (!this._bjob && key !== vec.borderKey && (force || !vec.borders || this.now - vec.borderAt > (this._hurried ? 1000 : 300) || this.snapshot)) {
      this._bjob = { key, it: this._borderSteps(key), work: 0 };
    }
    if (this._bjob) {
      const job = this._bjob;
      const sync = force || !vec.borders || this.snapshot;
      const t0 = perf();
      for (;;) {
        if (job.it.next().done) { this._bjob = null; break; }
        if (!sync && perf() - t0 >= 2.5) break;
      }
      job.work += perf() - t0;
      if (!this._bjob) this.stats.bordersMs = job.work;
    }
  }

  /** Border, frontier and civ-anchor rebuild as slices. Publishes everything at the end. */
  * _borderSteps(key) {
    const w = this.world, vec = this.vec;
    const W = w.W, H = w.H, N = w.N, wa = w.f.water, LAND = WATER.LAND;
    const own = this._ownerGrid();
    const cat = new Int32Array(N);
    for (let i = 0; i < N; i++) cat[i] = wa[i] !== LAND ? -2 : own[i];
    // borders follow the same rounded sub-tile vote as the territory wash, so ink and tint
    // agree; traced on a 2 px-per-tile grid and corner-cut. Two vote grids alternate so
    // the published one (used for the realm outline) is never half-written.
    const BF = 2;
    if (!this._bvotes || this._bvotes[0].W !== W || this._bvotes[0].H !== H) this._bvotes = [new CategoryVote(W, H, BF), new CategoryVote(W, H, BF)];
    const bv = this._bvotes[this._bvote === this._bvotes[0] ? 1 : 0];
    bv.prepare(cat);
    yield;
    const Lv = this.terrain.Lv, ch = bv.ch, cw = bv.cw;
    for (let py = 0; py < ch; py += 40) { bv.rows(cat, Lv, py, Math.min(ch, py + 40)); yield; }
    const pix = bv.pix;
    const strong = traceEdges(cw, ch, (i, j) => j >= 0 && pix[i] >= 0 && pix[j] >= 0 && pix[i] !== pix[j]);
    yield;
    const weak = traceEdges(cw, ch, (i, j) => j >= 0 && ((pix[i] === -1 && pix[j] >= 0) || (pix[j] === -1 && pix[i] >= 0)));
    yield;
    const borders = edgesToPath(strong, 2, [W, H], 1 / BF);
    const frontier = edgesToPath(weak, 2, [W, H], 1 / BF);
    yield;
    const anchors = computeAnchors(w, cat);
    vec.borders = borders; vec.frontier = frontier;
    this._civAnchors = anchors;
    this._bvote = bv;
    vec.borderKey = key; vec.borderAt = this.now;
    this._selKey = null;
  }

  /** Effective owner grid: live (dead civs cleared) or the atlas snapshot. */
  _ownerGrid() {
    const w = this.world;
    if (this.snapshot) return this.snapshot.owner;
    const v = w.versions;
    const key = `${v.owner}|${v.civs}`;
    if (this._ownKey === key && this._own && this._own.length === w.N) return this._own;
    const src = w.f.owner, N = w.N;
    const out = this._own && this._own.length === N ? this._own : new Int16Array(N);
    for (let i = 0; i < N; i++) {
      const o = src[i];
      out[i] = o >= 0 && o < w.civs.length && w.civs[o] && w.civs[o].alive ? o : -1;
    }
    // cartographic generalisation: fill unclaimed pinholes enclosed by one nation
    const W = w.W, H = w.H, wa = w.f.water;
    const fill = [];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (out[i] >= 0 || wa[i] !== WATER.LAND) continue;
        let c = -1, n = 0, other = false;
        for (let dy = -1; dy <= 1 && !other; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const o = out[i + dy * W + dx];
          if (o < 0) continue;
          if (c < 0) c = o; else if (o !== c) { other = true; break; }
          n++;
        }
        if (!other && n >= 6) fill.push(i, c);
      }
    }
    for (let k = 0; k < fill.length; k += 2) out[fill[k]] = fill[k + 1];
    this._own = out; this._ownKey = key;
    return out;
  }

  _territorySpec() {
    const w = this.world, prof = this.profile;
    // a registered map mode with its own wash (else its profile.region picks a built-in one)
    const reg = this.snapshot ? null : getMapMode(this._mode);
    if (reg && typeof reg.territory === 'function' && MODE_IDS.has(this._mode)) {
      let t = null;
      try { t = reg.territory(this); } catch (e) { if (this._regModeErr !== this._mode) { this._regModeErr = this._mode; console.error(`[mapmode:${this._mode}] territory`, e); } }
      if (!t || typeof t.catFn !== 'function' || typeof t.colorFn !== 'function') return null;
      return { fillA: 0.5, glowA: 0.3, glowTiles: 1.2, coastK: 0.3, ...t, key: `reg:${reg.id}|${t.key ?? ''}|${this.terrain.staticVersion}` };
    }
    const region = this.snapshot ? 'political' : prof.region;
    if (!region || !this.overlays.borders && (region === 'glow' || region === 'faint')) return null;
    const v = w.versions, sv = this.terrain.staticVersion;
    const month = Math.floor(w.time.day / DAYS_PER_MONTH), year = Math.floor(w.time.day / DAYS_PER_YEAR);
    const own = this._ownerGrid();
    const os = w.f.ownerSettle, S = w.settlements;
    const civColor = (c) => P.inkTint(P.civRgb(w, c), 0.12);
    switch (region) {
      case 'glow': return { key: `glow|${v.owner}|${v.civs}|${sv}`, catFn: (i) => own[i], colorFn: civColor, fillA: 0.04, glowA: 0.42, glowTiles: 1.4, coastK: 0.25 };
      case 'faint': return { key: `faint|${v.owner}|${v.civs}|${sv}`, catFn: (i) => own[i], colorFn: civColor, fillA: 0.08, glowA: 0.22, glowTiles: 1.3, coastK: 0.2 };
      case 'political': return {
        key: this.snapshot ? `snap|${this.snapshot.y}|${sv}` : `pol|${v.owner}|${v.civs}|${sv}`,
        catFn: (i) => own[i], colorFn: civColor, fillA: 0.3, glowA: 0.5, glowTiles: 2.2, coastK: 0.65,
      };
      case 'religion': return {
        key: `rel|${v.owner}|${v.settlements}|${month}|${sv}`,
        catFn: (i) => {
          const s = os[i] >= 0 ? S[os[i]] : null;
          if (!s || !s.alive) return -1;
          const d = s.dominantReligion;
          return d != null && d >= 0 && w.religions?.[d] ? d : 1e6;
        },
        colorFn: (c) => (c === 1e6 ? [178, 168, 148, 0.55] : P.religionRgb(w, c)),
        fillA: 0.5, glowA: 0.3, glowTiles: 1.2, coastK: 0.3,
      };
      case 'culture': return {
        key: `cul|${v.owner}|${v.settlements}|${v.civs}|${sv}`,
        catFn: (i) => { const s = os[i] >= 0 ? S[os[i]] : null; return s && s.alive ? (s.originCivId ?? s.civId) : -1; },
        colorFn: (c) => P.inkTint(P.civRgb(w, c), 0.1), fillA: 0.5, glowA: 0.3, glowTiles: 1.2, coastK: 0.3,
      };
      case 'tech': return {
        key: `tech|${v.owner}|${v.civs}|${year}|${sv}`,
        catFn: (i) => { const o = own[i]; return o >= 0 ? (w.civs[o]?.tech?.era || 0) : -1; },
        colorFn: (c) => P.eraColor(c), fillA: 0.55, glowA: 0.25, glowTiles: 1.0, coastK: 0.2,
      };
      case 'disease': return {
        key: `dis|${v.owner}|${v.settlements}|${month}|${Math.floor(this.now / 1500)}|${sv}`,
        catFn: (i) => {
          const s = os[i] >= 0 ? S[os[i]] : null;
          if (!s || !s.alive || !s.disease) return -1;
          const d = s.disease;
          const I = Number.isFinite(d.I) ? (d.I <= 1 ? d.I : d.I / Math.max(1, s.population)) : 0;
          return I > 0.001 ? s.id : 2e6 + s.id;
        },
        colorFn: (c) => {
          if (c >= 2e6) return [160, 176, 150, 0.45];
          const s = S[c];
          const d = s?.disease;
          const I = d && Number.isFinite(d.I) ? (d.I <= 1 ? d.I : d.I / Math.max(1, s.population)) : 0;
          const rgb = P.plagueRgb(w, d?.pid);
          return [rgb[0], rgb[1], rgb[2], Math.min(1, 0.45 + Math.sqrt(I) * 1.4)];
        },
        fillA: 0.55, glowA: 0.35, glowTiles: 1.0, coastK: 0.2,
      };
      default: return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Frame

  render(nowMs) {
    const tStart = perf();
    let now = Number.isFinite(nowMs) ? nowMs : tStart;
    const dt = this._lastNow == null ? 1 / 60 : clamp((now - this._lastNow) / 1000, 0, 0.1);
    this._lastNow = now;
    this.now = now;
    if (this._needResize) this.resize();
    const ctx = this.ctx, dpr = this.dpr, w = this.world;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!w || !this.terrain) return;
    if (!MODE_IDS.has(this._mode)) this.setMapMode('terrain');   // its package unregistered it
    const cam = this.camera;
    cam.update(now, dt * 1000);
    this.fx.reducedMotion = this.reducedMotion;
    this.fx.ingest(w, now, this);
    this.fx.update(dt, now);

    // --- caches
    const tT = perf();
    const vb2 = this.viewBounds(2);
    // at Max speed every row is a season behind every frame: the seasonal sweep, the territory
    // wash and the borders catch up at a gentler rate there, leaving the frame to the sim
    // (edits and style switches still repaint at once). main.js draws a still map only every
    // other frame at Max: a draw that stands for more than one ~30 fps frame runs the sweep
    // twice, so the raster falls no further behind
    const hurried = this.fx.dps > 600;
    this._hurried = hurried;
    if (!this.terrain.built) { this.terrain.buildAll(); this.terrain.built = true; }
    else if (hurried) for (let k = dt > 0.045 ? 2 : 1; k > 0; k--) this.terrain.update(Math.min(1, this.terrainBudgetMs), [vb2.y0, vb2.y1]);
    else this.terrain.update(this.terrainBudgetMs, [vb2.y0, vb2.y1]);
    this.stats.terrainMs = perf() - tT;
    this._syncVectors(!this.vec.coast);
    const spec = this._territorySpec();
    const forceTerr = spec && this.territory.key && this.territory.key.split('|')[0] !== spec.key.split('|')[0];
    if (spec) this.territory.update(spec, forceTerr || this.territory.empty, hurried ? 1000 : 350, hurried ? 2 : 3);
    this.stats.cachesMs = perf() - tT;

    const prof = this.profile;
    const z = cam.zoom;
    // optional per-layer profiling (debug): flush the raster after each layer and time it
    // (profileLayers waits for the GPU after each layer; profileJs times only the script)
    const lp = this.profileLayers || this.profileJs ? (this.stats.layers ||= {}) : null;
    const flushEach = Boolean(this.profileLayers);
    let lpT = perf();
    const mark = lp ? (name) => { if (flushEach) this.gpuFlush(); const t = perf(); lp[name] = (lp[name] || 0) * 0.8 + (t - lpT) * 0.2; lpT = t; } : () => {};
    mark('setup');
    const [shx, shy] = this.fx.shakeOffset(now);
    this.hits.length = 0;
    const W = w.W, H = w.H;
    // world transform: entity coordinates (tile centre = integer) → device pixels
    const worldT = () => ctx.setTransform(z * dpr, 0, 0, z * dpr, (this.viewW / 2 - (cam.x - 0.5) * z + shx) * dpr, (this.viewH / 2 - (cam.y - 0.5) * z + shy) * dpr);
    const screenT = () => ctx.setTransform(dpr, 0, 0, dpr, shx * dpr, shy * dpr);
    // registered layers (./layers.js): nothing at all happens in a slot nobody has filled
    const env = hasLayers() ? { z, dpr, prof, mode: this._mode, labels: null, vb: vb2, now, dt, worldT, screenT, snapshot: this.snapshot } : null;
    const slot = (name, inWorld) => {
      const list = layersFor(name);
      if (!list.length) return;
      if (inWorld) worldT(); else screenT();
      for (const d of list) drawLayer(d, this, ctx, env);
    };

    // world frame shadow
    worldT();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-0.5 + 3 / z, -0.5 + 4 / z, W, H);
    ctx.save();
    ctx.beginPath(); ctx.rect(-0.5, -0.5, W, H); ctx.clip();

    // --- the ground: terrain raster (with a relief tooth once magnified)
    paintGround(ctx, this.terrain, vb2, z, dpr, { tooth: this.snapshot ? 0.5 : prof.detail ? 1 : 0.6 });
    slot('ground', true);

    mark('terrain');
    // --- territory wash (beneath the detail: up close the chunks' shore band covers its
    //     soft bleed across the coast)
    if (spec && !this.territory.empty) {
      const tl = this.territory, F = tl.F, B = tl.B;
      ctx.imageSmoothingQuality = 'low';
      // the glow wash recedes as we zoom in and the ink borders take over
      ctx.globalAlpha = prof.region === 'glow' ? 1 - smoothstep(8, 22, z) * 0.82 : 1 - smoothstep(16, 40, z) * 0.35;
      // only the blocks that hold any tint, culled to the view
      for (const [bx0, by, bx1] of tl.runs) {
        const tx0 = bx0 * B, tx1 = Math.min(W, (bx1 + 1) * B), ty0 = by * B, ty1 = Math.min(H, (by + 1) * B);
        if (tx1 < vb2.x0 - 1 || tx0 > vb2.x1 + 1 || ty1 < vb2.y0 - 1 || ty0 > vb2.y1 + 1) continue;
        ctx.drawImage(tl.canvas, tx0 * F, ty0 * F, (tx1 - tx0) * F, (ty1 - ty0) * F, tx0 - 0.5, ty0 - 0.5, tx1 - tx0, ty1 - ty0);
      }
      ctx.globalAlpha = 1;
    }
    mark('territory');
    // --- water glints (screen space)
    if (prof.shimmer && !this.snapshot) {
      screenT();
      if (z < 26) this.atmos.drawGlints(ctx, this, now, 0.85 * (1 - smoothstep(12, 26, z)));
      if (z > 14 && !this.reducedMotion) this.atmos.drawWaves(ctx, this, now, smoothstep(14, 24, z));
      worldT();
    }
    mark('shimmer');
    // --- close-zoom detail (shores, relief, fields, trees …) from the chunk pyramid (./lod.js)
    if (prof.detail && z >= 8) {
      const tl = perf();
      this.lod.update(this, { family: `${prof.detail}:${this.terrain.style}`, zd: z * dpr, now, dps: this.fx.dps, maxSpeed: this.fx.dps > 600 });
      this.lod.draw(ctx, this, smoothstep(8, 11, z), shx, shy, now);
      this.stats.lodMs = perf() - tl;
      this.stats.lodBuilds = this.lod.stats.builds;
      worldT();
    } else this.stats.lodMs = 0;

    mark('detail');
    // --- graticule
    if (this.overlays.grid && this.overlays.features) this._drawGraticule(ctx, z, prof);

    mark('graticule');
    // --- rivers
    if (this.overlays.rivers && this.vec.rivers) this._drawRivers(ctx, z, prof);

    mark('rivers');
    // --- coast ink & water-lining
    this._drawCoast(ctx, z, prof);

    mark('coast');
    // --- roads
    if (this.overlays.roads && this.vec.roads && this.vec.roads.count) this._drawRoads(ctx, z, prof);

    mark('roads');
    // --- town plans (from Province zoom): over the roads they continue, under the borders
    if (!this.snapshot && (prof.settle ?? 1) > 0.5) {
      drawRuins(this, ctx, z);
      drawCityPlans(this, ctx, z);
    } else { if (this._planAlpha) this._planAlpha.clear(); if (this._planRects) this._planRects.length = 0; }
    mark('plans');
    // --- trade routes
    if (this.overlays.routes && !this.snapshot) drawRoutes(this, ctx, prof.routesK);

    mark('routes');
    // --- the great works: the Great Wall's course, the Grand Canal, the Great Dam
    drawWonderWorks(this, ctx, z);
    // --- borders
    if (this.overlays.borders) this._drawBorders(ctx, z, prof);
    slot('overTerritory', true);

    mark('borders');
    // --- selection outlines, the realms a tool would touch, a boxed region
    this._drawSelectionOutline(ctx, z);
    drawHighlightsWorld(this, ctx, z);
    // --- cloud deck (beneath icons and lettering, so names stay legible)
    if (this.overlays.clouds && !this.snapshot && prof.clouds) {
      // the deck thins out as we descend through it (and costs nothing once gone)
      const ca = 0.42 * (1 - smoothstep(5.5, 10.5, z));
      if (ca > 0.06) {
        this.atmos.updateClouds(now);
        ctx.imageSmoothingQuality = 'low';
        ctx.globalAlpha = ca;
        ctx.drawImage(this.atmos.comp, -0.5, -0.5, W, H);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();

    mark('clouds');
    // --- screen-space layers
    screenT();
    const labels = []; labels.blocks = []; labels.dynBlocks = [];
    if (env) env.labels = labels;
    if (!this.snapshot) {
      drawFires(this, ctx, dt);
      drawVolcanoes(this, ctx, dt, labels);
      if (prof.resources) drawResources(this, ctx);
    }
    slot('underIcons', false);
    // historic sites and ruins lie beneath the living towns
    drawSites(this, ctx, labels);
    mark('fires');
    this._drawRegionLabels(ctx, z, prof);
    mark('regionLabels');
    drawSettlements(this, ctx, prof, labels);
    if (!this.snapshot) drawWonders(this, ctx, labels);
    mark('settlements');
    if (this.overlays.units && !this.snapshot) {
      drawTraffic(this, ctx, prof.routesK);
      drawArmies(this, ctx, labels);
      drawSwarms(this, ctx);
    }
    slot('units', false);
    mark('units');
    planSmoke(this, dt);
    this.fx.particles.draw(ctx, this);

    mark('particles');
    // --- storms
    if (this.overlays.clouds && !this.snapshot) drawStorms(this, ctx, labels);
    slot('overUnits', false);

    mark('storms');
    // --- effects
    if (!this.snapshot) { this.fx.draw(ctx, this, now); this.fx.drawPointers(ctx, this, now); }

    mark('fx');
    // --- labels
    fireLabels(this, labels);
    slot('labels', false);
    this._drawPlaceLabels(ctx, labels, z, prof);

    mark('labels');
    // --- selection marker & brush
    this._drawSelectionMarker(ctx, z);
    drawHighlightsScreen(this, ctx, z);
    this._drawBrush(ctx, z);
    slot('hud', false);

    // --- the polarity vignette of the viewer's last act, then the flash
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.fx.drawVignette(ctx, this.canvas.width, this.canvas.height);
    if (this.fx.flash > 0 && !this.reducedMotion) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = Math.min(0.7, this.fx.flash);
      ctx.fillStyle = P.css(this.fx.flashColor);
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const ms = perf() - tStart;
    const s = this.stats;
    s.frames++;
    s.frameMs = s.frameMs ? s.frameMs * 0.9 + ms * 0.1 : ms;
    s.lastMs = ms;
    if (this._fpsT == null) { this._fpsT = now; this._fpsN = 0; }
    this._fpsN++;
    if (now - this._fpsT > 1000) { s.fps = (this._fpsN * 1000) / (now - this._fpsT); this._fpsT = now; this._fpsN = 0; }
  }

  // ---------------------------------------------------------------------------
  // Layer painters (world transform unless noted)

  _drawGraticule(ctx, z, prof) {
    const w = this.world, W = w.W, H = w.H;
    const lw = 1 / z;
    const night = prof.night;
    ctx.lineWidth = lw * 0.8;
    ctx.strokeStyle = night ? 'rgba(160,180,210,0.10)' : 'rgba(40,56,72,0.13)';
    const step = H / 12; // 15° of latitude
    ctx.beginPath();
    for (let k = 1; k < 12; k++) {
      if (k === 6) continue;
      const y = k * step - 0.5;
      ctx.moveTo(-0.5, y); ctx.lineTo(W - 0.5, y);
    }
    for (let x = step; x < W; x += step) { ctx.moveTo(x - 0.5, -0.5); ctx.lineTo(x - 0.5, H - 0.5); }
    ctx.stroke();
    // equator, tropics, polar circles (follow the live axial tilt)
    const tilt = clamp(Number(w.params?.axialTilt ?? 23), 0, 45);
    const yOfLat = (deg) => ((90 - deg) / 180) * H - 0.5;
    ctx.strokeStyle = night ? 'rgba(200,180,140,0.22)' : 'rgba(120,64,40,0.28)';
    ctx.lineWidth = lw * 1.1;
    ctx.beginPath(); ctx.moveTo(-0.5, yOfLat(0)); ctx.lineTo(W - 0.5, yOfLat(0)); ctx.stroke();
    if (tilt > 0.5) {
      ctx.setLineDash([6 / z, 4 / z]);
      ctx.beginPath();
      for (const d of [tilt, -tilt, 90 - tilt, -(90 - tilt)]) { ctx.moveTo(-0.5, yOfLat(d)); ctx.lineTo(W - 0.5, yOfLat(d)); }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _drawRivers(ctx, z, prof) {
    const rv = this.vec.rivers;
    if (!rv || !rv.count) return;
    const vb = this.viewBounds(1);
    const natural = this.terrain.style === 'natural';
    const st = this.terrain.style;
    const col = natural ? P.RIVER : st === 'muted' || st === 'resources' || st === 'devastation' || st === 'pollution' ? P.RIVER_MUTED : [70, 96, 122];
    // butt caps: where one width bucket hands over to the next the strokes meet end to end,
    // instead of overlapping round caps darkening into knobs (each bucket is one stroke at one
    // alpha, so nothing else overlaps)
    ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    for (const b of rv.buckets) {
      if (!b.n) continue;
      const t = b.t;
      // small streams fade in as we zoom in
      const vis = smoothstep(1.5 + (1 - t) * 5, 3 + (1 - t) * 8, z);
      if (vis <= 0.02) continue;
      const tiles = (0.05 + 0.26 * Math.pow(t, 1.15)) * riverWidthK(z);
      const minPx = 0.55 + 1.5 * t;
      const px = Math.max(minPx, tiles * z);
      const close = natural && !prof.night ? smoothstep(18, 32, z) : 0;
      if (close > 0.02 && px > 2.5) {
        // up close a river runs between darker banks
        ctx.globalAlpha = 0.5 * vis * close;
        ctx.strokeStyle = 'rgb(62,78,56)';
        ctx.lineWidth = (px + Math.max(1.4, px * 0.3)) / z;
        b.path.stroke(ctx, vb);
      }
      ctx.globalAlpha = Math.min(1, (0.55 + 0.4 * t) + close * 0.35) * vis * (prof.night ? 0.5 : 1);
      ctx.strokeStyle = P.css(col);
      ctx.lineWidth = px / z;
      b.path.stroke(ctx, vb);
      if (close > 0.02 && px > 5 && !this.reducedMotion) {
        // and its current runs downstream (paths run from the source to the mouth)
        ctx.globalAlpha = 0.2 * vis * close;
        ctx.strokeStyle = P.css(P.lighten(col, 0.3));
        ctx.lineWidth = Math.max(1, px * 0.12) / z;
        ctx.setLineDash([px * 0.45 / z, px * 3.2 / z]);
        ctx.lineDashOffset = -(this.now * 0.006 * (0.6 + t)) / z * 6;
        b.path.stroke(ctx, vb);
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
    }
    ctx.globalAlpha = 1;
    // great rivers fan out into deltas where they meet the sea
    if (rv.mouths && rv.mouths.length) {
      const widthPx = (t) => Math.max(0.55 + 1.5 * t, (0.05 + 0.26 * Math.pow(t, 1.15)) * riverWidthK(z) * z);
      drawDeltas(ctx, z, rv.mouths, vb, col, widthPx, prof.night ? 0.5 : 1, natural || st === 'muted');
    }
    ctx.lineCap = 'butt';
  }

  _drawCoast(ctx, z, prof) {
    const vec = this.vec;
    const vb = this.viewBounds(1);
    const style = this.terrain.style;
    const night = prof.night;
    if (vec.waterlines && z >= 3.2 && (style === 'natural' || style === 'muted' || style === 'resources')) {
      const a = smoothstep(3.2, 6, z);
      const base = style === 'natural' ? [28, 70, 96] : [70, 110, 130];
      ctx.lineWidth = Math.max(0.6, Math.min(1.1, z * 0.07)) / z;
      for (let k = 0; k < vec.waterlines.length; k++) {
        ctx.strokeStyle = P.css(base, (0.3 - k * 0.08) * a);
        vec.waterlines[k].stroke(ctx, vb);
      }
    }
    if (vec.waterlines && z >= 9 && style === 'natural' && !night && !this.snapshot && !this.reducedMotion) {
      // surf: white dashes rolling in along the first water-line offshore
      const a = smoothstep(9, 16, z) * 0.55;
      ctx.strokeStyle = `rgba(246,251,255,${a})`;
      ctx.lineWidth = clamp(z * 0.035, 1, 3.2) / z;
      ctx.setLineDash([clamp(z * 0.22, 3, 22) / z, clamp(z * 0.3, 4, 30) / z]);
      ctx.lineDashOffset = (this.now * 0.0035) % 1000 / z * 8;
      vec.waterlines[0].stroke(ctx, vb);
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
    if (vec.coast) {
      ctx.lineJoin = 'round';
      ctx.strokeStyle = night ? 'rgba(150,170,200,0.45)' : style === 'natural' ? 'rgba(34,40,40,0.78)' : 'rgba(44,52,58,0.7)';
      ctx.lineWidth = clamp(0.55 + z * 0.06, 0.7, 1.9) / z;
      vec.coast.stroke(ctx, vb);
    }
  }

  _drawRoads(ctx, z, prof) {
    const rp = this.vec.roads.paths;
    const vb = this.viewBounds(1);
    const emph = prof.routesK > 1;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const night = prof.night;
    for (let lvl = 1; lvl <= 3; lvl++) {
      const minZ = lvl === 1 ? (emph ? 3 : 5.5) : lvl === 2 ? (emph ? 2 : 3.2) : 1.5;
      if (z < minZ) continue;
      const a = smoothstep(minZ, minZ + 2, z) * (emph ? 1 : 0.85);
      const px = (lvl === 1 ? 0.9 : lvl === 2 ? 1.3 : 1.9) * (emph ? 1.4 : 1) * clamp(z / 10, 0.8, 1.8);
      if (lvl === 3) {
        ctx.setLineDash([]);
        ctx.strokeStyle = night ? 'rgba(255,200,120,0.25)' : 'rgba(250,240,220,0.6)';
        ctx.globalAlpha = a; ctx.lineWidth = (px + 1.6) / z; rp[3].stroke(ctx, vb);
      }
      ctx.strokeStyle = night ? 'rgba(255,196,110,0.75)' : lvl === 1 ? 'rgb(140,104,66)' : lvl === 2 ? 'rgb(128,78,46)' : 'rgb(136,52,36)';
      ctx.globalAlpha = a;
      ctx.lineWidth = px / z;
      if (lvl === 1) ctx.setLineDash([1.2 / z, 2.6 / z]);
      else if (lvl === 2) ctx.setLineDash([4 / z, 2.4 / z]);
      else ctx.setLineDash([]);
      rp[lvl].stroke(ctx, vb);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  _drawBorders(ctx, z, prof) {
    const vec = this.vec;
    if (!vec.borders) return;
    const vb = this.viewBounds(1);
    const a = prof.borders ?? 1;
    const night = prof.night;
    const px = clamp(0.8 + z * 0.06, 1, 2.6);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // soft dark underlay for contrast, then crisp ink
    ctx.strokeStyle = night ? `rgba(0,0,0,${0.35 * a})` : `rgba(250,244,228,${0.35 * a})`;
    ctx.lineWidth = (px + 2) / z;
    vec.borders.stroke(ctx, vb);
    ctx.strokeStyle = night ? `rgba(230,214,180,${0.7 * a})` : `rgba(48,30,24,${0.82 * a})`;
    ctx.lineWidth = px / z;
    ctx.setLineDash([px * 3.2 / z, px * 1.3 / z, px * 0.6 / z, px * 1.3 / z]);
    vec.borders.stroke(ctx, vb);
    ctx.setLineDash([]);
    // the frontier with unclaimed land: shown where no wash marks it, and in the natural
    // atlas once we are close enough that the soft glow has faded
    const wash = this.territory && !this.territory.empty && this.profile.region;
    const fa = !wash ? 1 : prof.region === 'glow' ? smoothstep(9, 16, z) : prof.region === 'political' || this.snapshot ? 0.75 : 0;
    if (vec.frontier && fa > 0.02) {
      ctx.strokeStyle = night ? `rgba(230,214,180,${0.35 * a * fa})` : `rgba(60,40,30,${0.42 * a * fa})`;
      ctx.lineWidth = (px * 0.75) / z;
      ctx.setLineDash([px * 1.4 / z, px * 1.8 / z]);
      vec.frontier.stroke(ctx, vb);
      ctx.setLineDash([]);
    }
    ctx.lineCap = 'butt';
  }

  _selectionPath() {
    const sel = this.selection, w = this.world;
    if (!sel || (sel.kind !== 'civ' && sel.kind !== 'settlement')) return null;
    const key = `${sel.kind}|${sel.id}|${this.vec.borderKey}|${w.versions.owner}`;
    if (key === this._selKey) return this._selPath;
    this._selKey = key;
    const W = w.W, H = w.H;
    let fn;
    if (sel.kind === 'civ' && this._bvote) {
      // the realm's rounded outline, from the border vote grid
      const pix = this._bvote.pix, id = sel.id, BF = this._bvote.F;
      fn = (i, j) => (pix[i] === id) !== (j >= 0 && pix[j] === id);
      this._selPath = edgesToPath(traceEdges(this._bvote.cw, this._bvote.ch, fn, true), 2, null, 1 / BF);
      return this._selPath;
    }
    if (sel.kind === 'civ') {
      const own = this._ownerGrid(), id = sel.id;
      fn = (i, j) => (own[i] === id) !== (j >= 0 && own[j] === id);
    } else {
      const os = w.f.ownerSettle, id = sel.id;
      fn = (i, j) => (os[i] === id) !== (j >= 0 && os[j] === id);
    }
    this._selPath = edgesToPath(traceEdges(W, H, fn, true), 2);
    return this._selPath;
  }

  _drawSelectionOutline(ctx, z) {
    const p = this._selectionPath();
    if (!p) return;
    const pulse = 0.75 + 0.25 * Math.sin(this.now * 0.004);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgba(255,236,170,${0.35 * pulse})`;
    ctx.lineWidth = 6 / z; ctx.stroke(p);
    ctx.strokeStyle = 'rgba(214,172,92,0.95)';
    ctx.lineWidth = 2 / z;
    if (this.selection.kind === 'settlement') ctx.setLineDash([5 / z, 3 / z]);
    ctx.stroke(p);
    ctx.setLineDash([]);
  }

  _drawSelectionMarker(ctx, z) {
    const sel = this.selection, w = this.world;
    if (!sel) return;
    let x = sel.x, y = sel.y, rad = 10;
    if (sel.kind === 'settlement') {
      const s = w.settlements[sel.id];
      if (s) { x = s.x; y = s.y; rad = tierRadius(s.tier || 0, z) * 1.6 + 6; }
    } else if (sel.kind === 'army') {
      const a = w.armies.find((q) => q.id === sel.id);
      if (a) { x = a.x; y = a.y; } else if (!Number.isFinite(x)) return;
      rad = 14;
    } else if (sel.kind === 'storm') {
      const s = w.storms.find((q) => q.id === sel.id);
      if (s) { x = s.x; y = s.y; rad = Math.max(14, (s.radius || 3) * z * 0.4); }
    } else if (sel.kind === 'tile') {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const { sx, sy } = this.e2s(Math.round(x), Math.round(y));
      const hs = Math.max(3, z / 2);
      ctx.strokeStyle = 'rgba(20,14,8,0.7)'; ctx.lineWidth = 3;
      ctx.strokeRect(sx - hs, sy - hs, hs * 2, hs * 2);
      ctx.strokeStyle = 'rgb(240,206,120)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(sx - hs, sy - hs, hs * 2, hs * 2);
      return;
    } else if (sel.kind === 'civ' || sel.kind === 'civs' || sel.kind === 'box') {
      return;
    } else if (!Number.isFinite(x) || !Number.isFinite(y)) {
      // registered kinds (bands, sites, wonders …) carry their place, or have none to mark
      return;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const { sx, sy } = this.e2s(x, y);
    const t = this.now * 0.002;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(20,14,8,0.6)';
    ctx.beginPath(); ctx.arc(sx, sy, rad + 1, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgb(240,206,120)';
    ctx.lineWidth = 1.6;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath(); ctx.arc(sx, sy, rad, t + k * Math.PI / 2, t + k * Math.PI / 2 + Math.PI / 3); ctx.stroke();
    }
  }

  _drawBrush(ctx, z) {
    const b = this.brush;
    if (!b) return;
    const { sx, sy } = this.e2s(b.x, b.y);
    const R = Math.max(3, (b.radius + 0.5) * z);
    if (previewRefused(this)) {
      // refused here: the highlight pass strikes it through in red
      ctx.fillStyle = 'rgba(220,64,52,0.08)';
      ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2); ctx.fill();
      return;
    }
    ctx.fillStyle = 'rgba(255,236,180,0.08)';
    ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(20,14,8,0.55)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(244,214,140,0.95)'; ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 4]); ctx.lineDashOffset = -this.now * 0.01;
    ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;
    ctx.fillStyle = 'rgba(244,214,140,0.95)';
    ctx.beginPath(); ctx.arc(sx, sy, 1.8, 0, Math.PI * 2); ctx.fill();
  }

  // ---------------------------------------------------------------------------
  // Labels

  /**
   * Lettering, phase 1 (drawn beneath the town icons): nation, faith and culture names and
   * the large geographic names. They may run across icons but never across each other.
   */
  _drawRegionLabels(ctx, z, prof) {
    const L = this.labeler;
    // while the zoom is changing, lettering stands in scaled copies rather than re-rendering
    const zoomMoving = this.camera.moving || Math.abs(z - (this._labelZ ?? z)) > z * 0.002;
    this._labelZ = z;
    L.begin(this.dpr, zoomMoving);
    this._regionPlaced = 0;
    if (!this.overlays.labels && !this.overlays.features) return;
    // town plans in view: minor lettering keeps off their footprints (region names prefer to)
    if (this._planRects) for (const p of this._planRects) L.plan(p[0], p[1], p[2]);
    if (this.overlays.labels) reserveCapitals(this, L, z);
    const cands = [];
    const w = this.world;
    const night = prof.night;
    // civ names
    if (this.overlays.labels && (prof.labelsCiv || this.snapshot) && z < 16) {
      const fadeCiv = 1 - smoothstep(9, 16, z);
      const political = prof.region === 'political' || this.snapshot;
      for (const [id, a] of this._civAnchors) {
        const civ = w.civs[id];
        if (!civ || a.n < 6) continue;
        const { sx, sy } = this.e2s(a.x, a.y);
        const spanPx = a.len * z * 0.85;
        let name = (civ.name || civ.baseName || '').toUpperCase();
        const maxFs = political ? 30 : 22;
        let fs = clamp(spanPx / Math.max(4, name.length * 0.95), 0, maxFs);
        if (fs < 10 && civ.baseName && civ.baseName !== civ.name) { name = civ.baseName.toUpperCase(); fs = clamp(spanPx / Math.max(3, name.length * 0.95), 0, maxFs); }
        if (fs < 9.5) continue;
        const rgb = P.civRgb(w, id);
        cands.push({
          pri: 76 + Math.log10(1 + a.n) * 4, text: name, x: sx, y: sy, angle: Math.abs(a.angle) > 0.1 ? a.angle : 0,
          alpha: fadeCiv * (political ? 0.92 : 0.78), alt: fs * 1.25,
          st: { size: fs, sc: true, color: night ? P.css(P.lighten(rgb, 0.4)) : P.css(P.darken(rgb, 0.55)), halo: night ? 'rgba(10,14,22,0.55)' : 'rgba(246,238,216,0.5)', haloW: Math.max(1.5, fs * 0.12), spacing: fs * 0.24 },
        });
      }
    }
    // region names (faiths, cultures)
    if (this.overlays.labels && !this.snapshot && (this._mode === 'religion' || this._mode === 'culture') && z < 18) {
      for (const [c, a] of this.territory.anchors) {
        if (a.n < 8) continue;
        let name = null, rgb = null;
        if (this._mode === 'religion') { const r = c < 1e6 ? w.religions?.[c] : null; if (!r) continue; name = r.name; rgb = P.religionRgb(w, c); }
        else { const civ = w.civs[c]; if (!civ) continue; name = civ.adjective || civ.name; rgb = P.civRgb(w, c); }
        if (!name) continue;
        const { sx, sy } = this.e2s(a.x, a.y);
        const fs = clamp((a.len * z * 0.8) / Math.max(4, name.length), 0, 24);
        if (fs < 9) continue;
        cands.push({ pri: 65 + Math.log10(1 + a.n) * 5, text: name, x: sx, y: sy, angle: Math.abs(a.angle) > 0.1 ? a.angle : 0, alt: fs * 1.2, st: { size: fs, italic: true, color: P.css(P.darken(rgb, 0.5)), halo: 'rgba(246,238,216,0.6)', haloW: 2, spacing: fs * 0.12 } });
      }
    }
    // large geographic names
    if (this.overlays.features && Array.isArray(w.features)) {
      for (const f of w.features) if (f && REGION_KINDS.has(f.kind)) this._featureCand(f, z, prof, cands);
    }
    this._regionPlaced = this._placeCands(ctx, cands, true);
  }

  /** Lettering, phase 2 (above icons): towns, small features, storms, volcanoes, fires. */
  _drawPlaceLabels(ctx, settleLabels, z, prof) {
    const L = this.labeler;
    if (!this.overlays.labels && !this.overlays.features) { this.stats.labels = 0; return; }
    const w = this.world;
    const cands = [];
    if (this.overlays.features && Array.isArray(w.features)) {
      for (const f of w.features) if (f && !REGION_KINDS.has(f.kind)) this._featureCand(f, z, prof, cands);
    }
    for (const s of settleLabels) cands.push(s);
    // icons and banners block town lettering
    for (const b of settleLabels.blocks || []) L.block(b[0], b[1], b[2], b[3]);
    for (const b of settleLabels.dynBlocks || []) L.block(b[0], b[1], b[2], b[3]);
    this.stats.labels = (this._regionPlaced || 0) + this._placeCands(ctx, cands, false, settleLabels.blocks);
  }

  /**
   * Place a phase's lettering. What stands still (towns, sites, features, region names) is
   * placed first, by priority, and the placement is reused while nothing that decides it has
   * changed (the camera, the lettering itself and its order, the plans, icons and reservations
   * it avoids, the fonts) for up to 600 ms (so it follows banners that have moved off a name).
   * What moves (armies, bands, storms, fires: `dyn`) is placed afresh every frame around it.
   */
  _placeCands(ctx, cands, regions, blocks = null) {
    const L = this.labeler;
    cands.sort((a, b) => b.pri - a.pri);
    const still = regions ? cands : cands.filter((c) => !c.dyn);
    const moving = regions ? null : cands.filter((c) => c.dyn);
    const phase = regions ? 'region' : 'place';
    const caches = (this._labelCache ||= { region: null, place: null });
    const sig = this._labelSig(still, regions, blocks);
    if (regions) this._regionSig = sig;
    const cache = caches[phase];
    let placed = 0;
    if (cache && cache.sig === sig && this.now >= cache.at && this.now - cache.at < 600) {
      for (const r of cache.rects) L._add(r[0], r[1], r[2], r[3]);
      for (const d of cache.draws) L.draw(ctx, d[0], d[1], d[2], d[3], d[4]);
      placed = cache.draws.length;
      this.stats.labelReuse = (this.stats.labelReuse || 0) + 1;
    } else {
      const draws = [];
      L.log = [];
      placed = this._placeList(ctx, still, regions, draws);
      // a placement lettered with stand-in sizes (mid-zoom) is not kept
      caches[phase] = draws.some((d) => d[0].scaled) ? null : { sig, at: this.now, rects: L.log, draws };
      L.log = null;
      this.stats.labelPlace = (this.stats.labelPlace || 0) + 1;
    }
    if (moving && moving.length) placed += this._placeList(ctx, moving, false, null);
    return placed;
  }

  /** A hash of everything a phase's placement depends on (see _placeCands). */
  _labelSig(list, regions, blocks) {
    let h = 2166136261 >>> 0;
    const n = (v) => { h = Math.imul(h ^ (Math.round(v) | 0), 16777619) >>> 0; };
    // strings hash once (lettering and colours repeat frame after frame)
    const memo = (this._sigStr ||= new Map());
    const str = (t) => {
      let v = memo.get(t);
      if (v === undefined) {
        const s = String(t); v = 2166136261;
        for (let k = 0; k < s.length; k++) v = Math.imul(v ^ s.charCodeAt(k), 16777619) >>> 0;
        if (memo.size > 4000) memo.clear();
        memo.set(t, v);
      }
      h = Math.imul(h ^ v, 16777619) >>> 0;
    };
    const L = this.labeler, cam = this.camera, w = this.world;
    n(cam.x * 4096); n(cam.y * 4096); n(cam.zoom * 4096); n(this.viewW); n(this.viewH); n(this.dpr * 100);
    n(L.fontEpoch); n(L.moving ? 1 : 2); n(regions ? 1 : 2); n(this.profile.night ? 1 : 0);
    n(w.versions.settlements); n(w.versions.civs);
    for (const p of this._planRects || []) { n(p[0] * 2); n(p[1] * 2); n(p[2] * 2); }
    if (!regions) {
      n(this._regionSig ?? 0);
      if (blocks) for (const b of blocks) { n(b[0] * 2); n(b[1] * 2); n(b[2] * 2); n(b[3] * 2); }
    }
    for (const c of list) {
      if (!c.text) continue;
      str(c.text); n(c.x * 2); n(c.y * 2); n((c.angle || 0) * 1000); n((c.alpha ?? 1) * 64);
      n(c.rad ? c.rad * 2 : 0); n(c.alt ? c.alt * 4 : 0); n(c.margin ?? 2); n(c.anchor === 'icon' ? 1 : 0); n(c.overPlan ? 1 : 0);
      const st = c.st; n(st.size * 8); str(st.color); n(st.italic ? 1 : 0); n(st.sc ? 2 : 0); n(st.bold ? 4 : 0); n((st.spacing || 0) * 16); n((st.haloW || 0) * 8); if (st.halo) str(st.halo);
    }
    return h;
  }

  _placeList(ctx, cands, regions, draws) {
    const L = this.labeler;
    const vw = this.viewW, vh = this.viewH;
    let placed = 0;
    for (const c of cands) {
      if (!c.text) continue;
      if (c.anchor === 'icon') {
        // try right, left, above, below the icon
        const sp0 = L.sprite(c.text, c.st);
        const half = sp0.tw / 2 + 2;
        const opts = [[c.x + c.rad + 3 + half, c.y], [c.x - c.rad - 3 - half, c.y], [c.x, c.y - c.rad * 1.4 - c.st.size * 0.75 - 2], [c.x, c.y + c.rad + c.st.size * 0.7 + 2]];
        for (const [x, y] of opts) {
          const sp = L.tryPlace(c.text, c.st, x, y, 0, 1, vw, vh, false, c.overPlan === true);
          if (sp) { L.draw(ctx, sp, x, y, 0, c.alpha ?? 1); if (draws) draws.push([sp, x, y, 0, c.alpha ?? 1]); placed++; break; }
        }
        continue;
      }
      // if the anchor is taken, try just above / below it; region names first try to keep
      // clear of capitals and their names, then settle for crossing them
      const offs = c.alt ? [0, -c.alt, c.alt, -2 * c.alt, 2 * c.alt] : [0];
      const ang = c.angle || 0;
      const modes = regions ? ['soft', 'over'] : [false];
      let done = false;
      for (const mode of modes) {
        for (let k = 0; k < offs.length && !done; k++) {
          if (mode === 'over' && k > 2) break;
          const dy = offs[k];
          const ax = c.x - Math.sin(ang) * dy, ay = c.y + Math.cos(ang) * dy;
          const sp = L.tryPlace(c.text, c.st, ax, ay, ang, c.margin ?? 2, vw, vh, mode, c.overPlan === true);
          if (sp) { L.draw(ctx, sp, ax, ay, ang, c.alpha ?? 1); if (draws) draws.push([sp, ax, ay, ang, c.alpha ?? 1]); placed++; done = true; }
        }
        if (done) break;
      }
    }
    return placed;
  }

  _featureCand(f, z, prof, out) {
    if (!f || !f.name || !Number.isFinite(f.x) || !Number.isFinite(f.y)) return;
    const size = Math.max(1, Number(f.size) || 1);
    // size = tiles covered; ranges and rivers also carry len (tiles along the long axis)
    const ext = Number.isFinite(f.len) && f.len > 0 ? f.len : Math.sqrt(size);
    const { sx, sy } = this.e2s(f.x, f.y);
    const night = prof.night;
    const angle = Number.isFinite(f.angle) ? clamp(((f.angle + Math.PI / 2) % Math.PI) - Math.PI / 2, -0.9, 0.9) : 0;
    const waterInk = night ? 'rgba(150,180,210,0.75)' : 'rgba(30,62,92,0.82)';
    const waterHalo = night ? 'rgba(8,12,20,0.4)' : 'rgba(214,232,236,0.45)';
    const landInk = night ? 'rgba(220,206,180,0.6)' : 'rgba(70,52,38,0.62)';
    const landHalo = night ? 'rgba(8,12,20,0.4)' : 'rgba(246,238,216,0.5)';
    let st = null, pri = 0, alpha = 1, ang = 0;
    switch (f.kind) {
      case 'ocean': {
        if (z > 14) return;
        const fs = clamp(ext * z * 0.07, 11, 30);
        st = { size: fs, italic: true, color: waterInk, halo: waterHalo, haloW: 2, spacing: fs * 0.32 };
        pri = 66 + ext * 0.05; alpha = 1 - smoothstep(9, 14, z);
        break;
      }
      case 'sea': {
        if (z > 20) return;
        const fs = clamp(ext * z * 0.08, 10, 22);
        st = { size: fs, italic: true, color: waterInk, halo: waterHalo, haloW: 2, spacing: fs * 0.22 };
        pri = 50 + ext * 0.05; alpha = 1 - smoothstep(13, 20, z);
        break;
      }
      case 'continent': {
        if (z > 7) return;
        const fs = clamp(ext * z * 0.06, 12, 34);
        st = { size: fs, sc: true, color: night ? 'rgba(220,206,180,0.4)' : 'rgba(60,44,32,0.42)', halo: null, spacing: fs * 0.55 };
        pri = 58 + ext * 0.04; alpha = 1 - smoothstep(4.5, 7, z);
        break;
      }
      case 'island': {
        if (z < 4.5) return;
        st = { size: clamp(8 + ext * 0.4, 9, 13), italic: true, color: landInk, halo: landHalo, haloW: 2 };
        pri = 24 + ext * 0.2;
        break;
      }
      case 'range': {
        if (z < 3.2 || z > 26) return;
        const fs = clamp(7 + ext * 0.35 + z * 0.15, 9, 15);
        st = { size: fs, sc: true, color: night ? 'rgba(220,200,170,0.7)' : 'rgba(96,66,44,0.8)', halo: landHalo, haloW: 2, spacing: fs * 0.3 };
        pri = 34 + Math.min(14, ext * 0.25); ang = angle;
        break;
      }
      case 'lake': {
        if (z < 4.5) return;
        st = { size: clamp(8 + ext * 0.3, 9, 13), italic: true, color: waterInk, halo: waterHalo, haloW: 2 };
        pri = 26 + ext * 0.2;
        break;
      }
      case 'river': {
        if (z < 6) return;
        st = { size: clamp(8.5 + z * 0.08, 9, 12), italic: true, color: night ? 'rgba(150,180,210,0.8)' : 'rgba(40,82,118,0.9)', halo: 'rgba(240,238,226,0.55)', haloW: 1.8, spacing: 0.6 };
        pri = 20 + ext * 0.1; ang = angle;
        break;
      }
      case 'desert': case 'forest': {
        if (z < 2.6 || z > 16) return;
        const fs = clamp(ext * z * 0.05, 9, 16);
        st = { size: fs, italic: true, color: f.kind === 'desert' ? (night ? 'rgba(220,190,140,0.7)' : 'rgba(126,86,44,0.7)') : (night ? 'rgba(160,200,150,0.7)' : 'rgba(40,72,40,0.72)'), halo: landHalo, haloW: 2, spacing: fs * 0.25 };
        pri = 30 + ext * 0.05; alpha = 1 - smoothstep(11, 16, z);
        break;
      }
      default: {
        if (z < 4) return;
        st = { size: 10, italic: true, color: landInk, halo: landHalo, haloW: 2 };
        pri = 15;
      }
    }
    if (!st || alpha <= 0.03) return;
    out.push({ pri, text: f.kind === 'continent' ? f.name.toUpperCase() : f.name, x: sx, y: sy, angle: ang, alpha, st });
  }

  // ---------------------------------------------------------------------------
  // Minimap

  /** Whole world small, with the viewport rectangle. (w, h) in the ctx's current units. */
  drawMinimap(ctx, mw, mh) {
    const w = this.world;
    if (!ctx || !w || !this.terrain) return;
    mw = Math.max(1, mw || 1); mh = Math.max(1, mh || 1);
    const W = w.W, H = w.H;
    const sc = Math.min(mw / W, mh / H);
    const dw = W * sc, dh = H * sc, ox = (mw - dw) / 2, oy = (mh - dh) / 2;
    const key = `${this.terrain.version}|${this.territory.version}|${this._mode}`;
    if (!this._mini || (key !== this._miniKey && this.now - this._miniAt > 500)) {
      const MW = Math.min(512, W * 2), MH = Math.round((MW * H) / W);
      if (!this._mini || this._mini.width !== MW) this._mini = makeCanvas(MW, MH);
      const g = this._mini.getContext('2d');
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'medium';
      g.drawImage(this.terrain.canvas, 0, 0, MW, MH);
      if (!this.territory.empty) g.drawImage(this.territory.canvas, 0, 0, MW, MH);
      this._miniKey = key; this._miniAt = this.now;
    }
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._mini, ox, oy, dw, dh);
    // viewport rectangle
    const c = this.camera;
    const hw = this.viewW / 2 / c.zoom, hh = this.viewH / 2 / c.zoom;
    let rx0 = ox + (c.x - hw) * sc, ry0 = oy + (c.y - hh) * sc;
    let rx1 = ox + (c.x + hw) * sc, ry1 = oy + (c.y + hh) * sc;
    rx0 = Math.max(ox, rx0); ry0 = Math.max(oy, ry0); rx1 = Math.min(ox + dw, rx1); ry1 = Math.min(oy + dh, ry1);
    ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(10,8,6,0.6)';
    ctx.strokeRect(rx0, ry0, Math.max(2, rx1 - rx0), Math.max(2, ry1 - ry0));
    ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgb(236,200,120)';
    ctx.strokeRect(rx0, ry0, Math.max(2, rx1 - rx0), Math.max(2, ry1 - ry0));
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Static preview for the genesis screen

/**
 * Paint a static natural-atlas image of `world` into `canvas` (letterboxed). The backing
 * store is sized to the canvas's displayed size × devicePixelRatio so the plate stays
 * crisp however large the layout shows it, and the terrain raster is built at that pixel
 * density (micro-relief included) rather than upscaled.
 */
export function renderPreview(world, canvas) {
  if (!world || !canvas) return;
  const dpr = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1));
  const cssW = canvas.clientWidth || 0, cssH = canvas.clientHeight || 0;
  if (cssW > 0 && cssH > 0) {
    const pw = Math.max(1, Math.min(2800, Math.round(cssW * dpr)));
    const ph = Math.max(1, Math.round((pw * cssH) / cssW));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
  }
  const cw = Math.max(1, canvas.width), ch = Math.max(1, canvas.height);
  const W = world.W, H = world.H;
  const sc = Math.min(cw / W, ch / H);
  const T = Math.max(2, Math.min(16, Math.ceil(sc - 0.05)));
  const layer = new TerrainLayer(world, { tpx: T, style: 'natural' });
  layer.buildAll();
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = P.MAP_BG;
  ctx.fillRect(0, 0, cw, ch);
  const dw = W * sc, dh = H * sc, ox = (cw - dw) / 2, oy = (ch - dh) / 2;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(layer.canvas, ox, oy, dw, dh);
  // vectors in tile coordinates
  const px = 1 / sc; // one device pixel in tile units
  ctx.setTransform(sc, 0, 0, sc, ox + 0.5 * sc, oy + 0.5 * sc);
  ctx.save();
  ctx.beginPath(); ctx.rect(-0.5, -0.5, W, H); ctx.clip();
  try {
    const k = Math.max(1, sc / 8); // stroke scale relative to an 8 px-per-tile plate
    // engraved water-lining offshore
    const D = coastDistance(world, 3);
    ctx.lineJoin = 'round';
    [0.45, 1.0].forEach((lvl, j) => {
      ctx.strokeStyle = P.css([28, 70, 96], 0.26 - j * 0.09);
      ctx.lineWidth = 0.9 * k * px;
      ctx.stroke(chainsToPath(contour(W, H, D, lvl, 2), 4));
    });
    const rv = buildRivers(world, 10, false, 4);
    ctx.lineCap = 'round';
    for (const b of rv.buckets) {
      if (!b.n || b.t < 0.2) continue;
      ctx.strokeStyle = P.css(P.RIVER, 0.45 + 0.5 * b.t);
      ctx.lineWidth = Math.max((0.5 + b.t * 1.7) * k * px, (0.05 + 0.24 * b.t));
      ctx.stroke(b.path);
    }
    const coast = chainsToPath(contour(W, H, layer.Lv, 0, 3), 2);
    ctx.strokeStyle = 'rgba(30,36,36,0.8)';
    ctx.lineWidth = Math.max(1, 1.1 * k) * px;
    ctx.stroke(coast);
  } catch (e) { /* vectors are decoration; the raster is already drawn */ }
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = 'rgba(214,172,92,0.55)';
  ctx.lineWidth = Math.max(1, dpr * 0.75);
  ctx.strokeRect(ox + 0.5, oy + 0.5, dw - 1, dh - 1);
}
