// A plain stand-in for src/render/renderer.js, implementing the same interface (SPEC §7)
// with simple per-tile colour maps. The UI uses it only when the real renderer cannot be
// loaded, so the atlas stays usable (and the problem is reported) instead of going blank.

import { BIOMES, WATER } from '../core/constants.js';
import { liveSettlements } from '../core/entities.js';
import { base64ToTyped } from '../core/serialize.js';
import { clamp01, lerp } from '../core/util.js';

export const FALLBACK_MAP_MODES = [
  { id: 'terrain', label: 'Terrain', desc: 'Land, sea and living cover.' },
  { id: 'political', label: 'Political', desc: 'Nations and their borders.' },
  { id: 'elevation', label: 'Elevation', desc: 'Height above and depth below the sea.' },
  { id: 'temperature', label: 'Temperature', desc: 'Current surface temperature.' },
  { id: 'rainfall', label: 'Rainfall', desc: 'Mean annual precipitation.' },
  { id: 'biome', label: 'Biomes', desc: 'Climate zones of plant life.' },
  { id: 'vegetation', label: 'Vegetation', desc: 'Living plant biomass.' },
  { id: 'population', label: 'Population', desc: 'Where people live.' },
];

const DEEP = [16, 34, 62], SHELF = [52, 108, 140], LOW = [92, 126, 70], HIGH = [150, 128, 96], PEAK = [236, 236, 232];
const TEMP_STOPS = [[-30, [70, 90, 190]], [-10, [120, 170, 230]], [0, [225, 235, 240]], [12, [150, 200, 110]], [24, [235, 190, 80]], [38, [200, 60, 40]]];
const RAIN_STOPS = [[0, [214, 190, 140]], [0.25, [200, 200, 120]], [0.5, [110, 170, 110]], [0.8, [50, 120, 150]], [1.2, [30, 60, 130]]];

function ramp(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) {
    if (v <= stops[k][0]) {
      const [a, ca] = stops[k - 1], [b, cb] = stops[k];
      const t = (v - a) / Math.max(1e-6, b - a);
      return [lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t)];
    }
  }
  return stops[stops.length - 1][1];
}
const css = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

export function createFallbackRenderer(canvas, worldIn) {
  let world = worldIn;
  const ctx = canvas.getContext('2d');
  const base = document.createElement('canvas');
  const bctx = base.getContext('2d');
  let img = null;
  let builtKey = '';
  let lastBuild = 0;
  let cssW = 1, cssH = 1, dpr = 1;
  const camera = { x: world.W / 2, y: world.H / 2, zoom: 4 };
  let goal = null;
  let selection = null, brush = null, snapshot = null, snapGrid = null;
  const overlays = { borders: true, labels: true, rivers: true, roads: true, clouds: false, units: true, routes: true, features: true };
  const r = { camera, overlays, mapMode: 'terrain', fallback: true, hits: [] };

  function sizeBase() {
    base.width = world.W; base.height = world.H;
    img = bctx.createImageData(world.W, world.H);
    builtKey = '';
  }
  sizeBase();

  function tileColor(i, mode, out) {
    const f = world.f;
    const water = f.water[i] !== WATER.LAND;
    const e = f.elevation[i];
    const sea = world.climate?.seaLevel ?? 0.5;
    let c;
    if (mode === 'elevation') {
      c = water ? ramp([[0, DEEP], [sea, SHELF]], e) : ramp([[sea, LOW], [0.75, HIGH], [1, PEAK]], e);
    } else if (mode === 'temperature') {
      c = ramp(TEMP_STOPS, f.temp[i]);
    } else if (mode === 'rainfall') {
      c = water ? [40, 70, 110] : ramp(RAIN_STOPS, f.annRain[i]);
    } else if (mode === 'biome') {
      c = BIOMES[f.biome[i]]?.color || [128, 128, 128];
    } else if (mode === 'vegetation') {
      c = water ? [30, 50, 80] : ramp([[0, [190, 170, 130]], [0.5, [120, 160, 80]], [1, [30, 100, 40]]], f.veg[i]);
    } else if (mode === 'population') {
      const p = f.popDensity[i];
      c = water ? [24, 36, 56] : ramp([[0, [60, 64, 60]], [5, [130, 110, 70]], [50, [220, 160, 70]], [500, [255, 240, 200]]], p);
    } else {
      // terrain: biome colour, vegetation tint, elevation shading, snow
      const b = BIOMES[f.biome[i]]?.color || [120, 120, 100];
      if (water) {
        c = ramp([[0, DEEP], [sea - 0.06, [28, 66, 104]], [sea, SHELF]], e);
      } else {
        const v = clamp01(f.veg[i]);
        c = [lerp(178, b[0], 0.45 + 0.55 * v), lerp(160, b[1], 0.45 + 0.55 * v), lerp(118, b[2], 0.45 + 0.55 * v)];
        const lit = 0.85 + (e - sea) * 0.6;
        c = [c[0] * lit, c[1] * lit, c[2] * lit];
        const s = clamp01(f.snow[i]);
        if (s > 0.05) c = [lerp(c[0], 240, s * 0.9), lerp(c[1], 242, s * 0.9), lerp(c[2], 246, s * 0.9)];
      }
      if (mode === 'political') {
        const o = snapGrid ? snapOwner(i) : f.owner[i];
        const civ = o >= 0 ? world.civs[o] : null;
        const g = (c[0] + c[1] + c[2]) / 3;
        c = water ? c : [lerp(c[0], g, 0.6), lerp(c[1], g, 0.6), lerp(c[2], g, 0.6)];
        if (civ && civ.color) c = [lerp(c[0], civ.color[0], 0.55), lerp(c[1], civ.color[1], 0.55), lerp(c[2], civ.color[2], 0.55)];
      }
    }
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
  }

  function snapOwner(i) {
    const x = i % world.W, y = (i / world.W) | 0;
    const sx = Math.min(snapshot.w - 1, x >> 1), sy = Math.min(snapshot.h - 1, y >> 1);
    return snapGrid[sy * snapshot.w + sx];
  }

  function rebuild(now) {
    const v = world.versions;
    const key = [r.mapMode, v.terrain, v.water, v.biome, v.owner, v.load, snapshot ? snapshot.y : -1, world.W].join(':');
    const dynamic = r.mapMode !== 'elevation' && r.mapMode !== 'biome';
    if (key === builtKey && !(dynamic && now - lastBuild > 700)) return;
    builtKey = key; lastBuild = now;
    if (base.width !== world.W || base.height !== world.H) sizeBase();
    const d = img.data, out = [0, 0, 0];
    for (let i = 0; i < world.N; i++) {
      tileColor(i, r.mapMode, out);
      const k = i * 4;
      d[k] = out[0]; d[k + 1] = out[1]; d[k + 2] = out[2]; d[k + 3] = 255;
    }
    bctx.putImageData(img, 0, 0);
  }

  r.setWorld = (w) => {
    world = w; snapshot = null; snapGrid = null; selection = null; brush = null;
    sizeBase(); r.fitWorld();
  };

  r.resize = () => {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, rect.width); cssH = Math.max(1, rect.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  };

  const clampCam = () => {
    camera.zoom = Math.max(1, Math.min(48, camera.zoom));
    camera.x = Math.max(0, Math.min(world.W, camera.x));
    camera.y = Math.max(0, Math.min(world.H, camera.y));
  };

  r.pan = (dx, dy) => { goal = null; camera.x -= dx / camera.zoom; camera.y -= dy / camera.zoom; clampCam(); };
  r.zoomAt = (sx, sy, factor) => {
    goal = null;
    const before = r.screenToTileF(sx, sy);
    camera.zoom *= factor; clampCam();
    const after = r.screenToTileF(sx, sy);
    camera.x += before.x - after.x; camera.y += before.y - after.y; clampCam();
  };
  r.focusOn = (x, y, zoom) => { goal = { x, y, zoom: zoom ?? Math.max(camera.zoom, 8) }; };
  r.fitWorld = () => {
    if (!cssW || cssW < 2) r.resize();
    camera.x = world.W / 2; camera.y = world.H / 2;
    camera.zoom = Math.max(1, Math.min(cssW / world.W, cssH / world.H) * 0.96);
    goal = null;
  };
  r.screenToTileF = (sx, sy) => ({ x: camera.x + (sx - cssW / 2) / camera.zoom, y: camera.y + (sy - cssH / 2) / camera.zoom });
  r.screenToTile = (sx, sy) => {
    const p = r.screenToTileF(sx, sy);
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= world.W || y >= world.H) return null;
    return { x, y, i: y * world.W + x };
  };
  r.tileToScreen = (x, y) => ({ sx: (x - camera.x) * camera.zoom + cssW / 2, sy: (y - camera.y) * camera.zoom + cssH / 2 });

  // the parts of the expansion's renderer API the instruments lean on (contracts §14), kept simple
  Object.defineProperty(r, 'viewW', { get: () => cssW });
  Object.defineProperty(r, 'viewH', { get: () => cssH });
  camera.minZoom = 1; camera.maxZoom = 48;
  r.frameBox = (x0, y0, x1, y1, pad = 48) => {
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    const p = Math.max(0, Math.min(pad, Math.min(cssW, cssH) / 3));
    const z = Math.min((cssW - 2 * p) / (Math.abs(x1 - x0) + 1), (cssH - 2 * p) / (Math.abs(y1 - y0) + 1));
    r.focusOn((x0 + x1) / 2 + 0.5, (y0 + y1) / 2 + 0.5, Math.max(1, Math.min(48, z)));
  };
  r.getZoomInfo = () => {
    const bands = [['World', 0], ['Continent', 2.5], ['Region', 6], ['Province', 12], ['Town', 24]];
    let band = 0;
    for (let k = 1; k < bands.length; k++) if (camera.zoom >= bands[k][1]) band = k;
    return { z: camera.zoom, name: bands[band][0], band, kmPerPx: 20 / Math.max(1e-6, camera.zoom), next: band + 1 < bands.length ? bands[band + 1][1] : null };
  };
  r.pickAll = (sx, sy) => { const p = r.pickEntity(sx, sy); return p ? [p] : []; };
  r.recentFx = () => [];
  r.setToolPreview = () => {};
  r.setHighlights = () => {};
  r.e2s = (x, y) => r.tileToScreen(x + 0.5, y + 0.5);
  r.setMapMode = (id) => { if (FALLBACK_MAP_MODES.some((m) => m.id === id)) { r.mapMode = id; builtKey = ''; } };
  r.setOverlay = (name, on) => { overlays[name] = Boolean(on); };
  r.setSelection = (s) => { selection = s; };
  r.setBrush = (b) => { brush = b; };
  r.setAtlasSnapshot = (s) => {
    snapshot = s || null;
    snapGrid = null;
    if (snapshot) { try { snapGrid = base64ToTyped(snapshot.owner, Int16Array); } catch (e) { snapshot = null; } }
    builtKey = '';
  };

  r.pickEntity = (sx, sy) => {
    let best = null, bd = 12 * 12;
    if (snapshot) return null;
    for (const s of liveSettlements(world)) {
      const p = r.tileToScreen(s.x + 0.5, s.y + 0.5);
      const d = (p.sx - sx) ** 2 + (p.sy - sy) ** 2;
      if (d < bd) { bd = d; best = { kind: 'settlement', id: s.id }; }
    }
    if (overlays.units) {
      for (const a of world.armies) {
        const p = r.tileToScreen(a.x + 0.5, a.y + 0.5);
        const d = (p.sx - sx) ** 2 + (p.sy - sy) ** 2;
        if (d < bd) { bd = d; best = { kind: 'army', id: a.id }; }
      }
      for (const st of world.storms) {
        const p = r.tileToScreen(st.x + 0.5, st.y + 0.5);
        const d = (p.sx - sx) ** 2 + (p.sy - sy) ** 2;
        if (d < bd) { bd = d; best = { kind: 'storm', id: st.id }; }
      }
    }
    return best;
  };

  r.render = (now = 0) => {
    if (goal) {
      const k = 0.18;
      camera.x = lerp(camera.x, goal.x, k); camera.y = lerp(camera.y, goal.y, k); camera.zoom = lerp(camera.zoom, goal.zoom, k);
      if (Math.abs(camera.x - goal.x) < 0.02 && Math.abs(camera.y - goal.y) < 0.02 && Math.abs(camera.zoom - goal.zoom) < 0.02) goal = null;
      clampCam();
    }
    rebuild(now);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b121a';
    ctx.fillRect(0, 0, cssW, cssH);
    const o = r.tileToScreen(0, 0);
    ctx.imageSmoothingEnabled = camera.zoom < 3;
    ctx.drawImage(base, o.sx, o.sy, world.W * camera.zoom, world.H * camera.zoom);
    drawSettlements();
    if (overlays.units && !snapshot) drawUnits();
    drawSelection();
    if (brush) {
      const p = r.tileToScreen(brush.x + 0.5, brush.y + 0.5);
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, Math.max(4, (brush.radius || 0.5) * camera.zoom), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(240,220,170,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  };

  function drawSettlements() {
    const list = snapshot
      ? snapshot.towns.map(([x, y, civId, tier, name]) => ({ x, y, civId, tier, name, population: 0 }))
      : liveSettlements(world);
    ctx.font = '12px "IM Fell English", Georgia, serif';
    ctx.textAlign = 'center';
    for (const s of list) {
      const p = r.tileToScreen(s.x + 0.5, s.y + 0.5);
      if (p.sx < -40 || p.sy < -40 || p.sx > cssW + 40 || p.sy > cssH + 40) continue;
      const civ = world.civs[s.civId];
      const rad = 1.5 + (s.tier || 0) * 0.7;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, rad, 0, Math.PI * 2);
      ctx.fillStyle = civ?.colorHex || '#ddd'; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(10,14,20,0.8)'; ctx.stroke();
      if (overlays.labels && (camera.zoom > 6 || (s.tier || 0) >= 3)) {
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,14,20,0.75)';
        ctx.strokeText(s.name, p.sx, p.sy - rad - 4);
        ctx.fillStyle = '#efe6cf'; ctx.fillText(s.name, p.sx, p.sy - rad - 4);
      }
    }
  }

  function drawUnits() {
    for (const a of world.armies) {
      const p = r.tileToScreen(a.x + 0.5, a.y + 0.5);
      const civ = world.civs[a.civId];
      ctx.fillStyle = civ?.colorHex || '#c33';
      ctx.fillRect(p.sx - 3, p.sy - 8, 7, 5);
      ctx.fillStyle = '#efe6cf'; ctx.fillRect(p.sx - 3, p.sy - 8, 1, 10);
    }
    for (const st of world.storms) {
      const p = r.tileToScreen(st.x + 0.5, st.y + 0.5);
      ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(4, (st.radius || 2) * camera.zoom), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(220,230,240,0.55)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  function drawSelection() {
    if (!selection) return;
    let x = selection.x, y = selection.y;
    if (selection.kind === 'settlement') { const s = world.settlements[selection.id]; if (s) { x = s.x; y = s.y; } }
    if (selection.kind === 'army') { const a = world.armies.find((q) => q.id === selection.id); if (a) { x = a.x; y = a.y; } }
    if (x == null || y == null) return;
    const p = r.tileToScreen(x + 0.5, y + 0.5);
    ctx.strokeStyle = '#e3c58a'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, Math.max(7, camera.zoom * 0.9), 0, Math.PI * 2); ctx.stroke();
  }

  r.drawMinimap = (mctx, w, h) => {
    rebuild(performance.now());
    mctx.imageSmoothingEnabled = true;
    mctx.drawImage(base, 0, 0, w, h);
    const tl = r.screenToTileF(0, 0), br = r.screenToTileF(cssW, cssH);
    const sx = w / world.W, sy = h / world.H;
    mctx.strokeStyle = 'rgba(240,220,170,0.95)'; mctx.lineWidth = 1;
    mctx.strokeRect(tl.x * sx, tl.y * sy, (br.x - tl.x) * sx, (br.y - tl.y) * sy);
  };

  r.getLegend = () => {
    switch (r.mapMode) {
      case 'elevation': return { title: 'Elevation', type: 'gradient', stops: [[0, css(DEEP)], [0.45, css(SHELF)], [0.55, css(LOW)], [0.8, css(HIGH)], [1, css(PEAK)]], min: '−8,000 m', max: '7,000 m' };
      case 'temperature': return { title: 'Temperature', type: 'gradient', stops: TEMP_STOPS.map(([v, c]) => [(v + 30) / 68, css(c)]), min: '−30 °C', max: '38 °C' };
      case 'rainfall': return { title: 'Rainfall', type: 'gradient', stops: RAIN_STOPS.map(([v, c]) => [v / 1.2, css(c)]), min: '0 mm', max: '3,600 mm' };
      case 'vegetation': return { title: 'Vegetation', type: 'gradient', stops: [[0, 'rgb(190,170,130)'], [0.5, 'rgb(120,160,80)'], [1, 'rgb(30,100,40)']], min: 'Bare', max: 'Dense' };
      case 'population': return { title: 'Population', type: 'gradient', stops: [[0, 'rgb(60,64,60)'], [0.4, 'rgb(130,110,70)'], [0.7, 'rgb(220,160,70)'], [1, 'rgb(255,240,200)']], min: 'Empty', max: 'Crowded' };
      case 'biome': return { title: 'Biomes', type: 'swatches', items: BIOMES.filter((b) => !b.water).map((b) => ({ label: b.name, color: css(b.color) })) };
      case 'political': return { title: snapshot ? `Nations in Year ${snapshot.y}` : 'Nations', type: 'swatches', items: (snapshot ? snapshot.civs.map(([id, name, hex]) => ({ label: name, color: hex })) : world.civs.filter((c) => c.alive).map((c) => ({ label: c.name, color: c.colorHex }))).slice(0, 12) };
      default: return { title: 'Terrain', type: 'swatches', items: [{ label: 'Deep sea', color: css(DEEP) }, { label: 'Shelf sea', color: css(SHELF) }, { label: 'Lowland', color: css(LOW) }, { label: 'Highland', color: css(HIGH) }, { label: 'Snow and ice', color: css(PEAK) }] };
    }
  };

  r.resize();
  r.fitWorld();
  return r;
}

/** Static terrain image for the Genesis screen. */
export function renderFallbackPreview(world, canvas) {
  const r = { W: world.W, H: world.H };
  canvas.width = r.W; canvas.height = r.H;
  const c = canvas.getContext('2d');
  const img = c.createImageData(r.W, r.H);
  const f = world.f, sea = world.climate?.seaLevel ?? 0.5;
  for (let i = 0; i < world.N; i++) {
    const water = f.water[i] !== WATER.LAND;
    const e = f.elevation[i];
    let col;
    if (water) col = ramp([[0, DEEP], [sea - 0.06, [28, 66, 104]], [sea, SHELF]], e);
    else {
      const b = BIOMES[f.biome[i]]?.color || [120, 120, 100];
      const lit = 0.85 + (e - sea) * 0.6;
      col = [b[0] * lit, b[1] * lit, b[2] * lit];
      const s = clamp01(f.snow[i]);
      if (s > 0.05) col = [lerp(col[0], 240, s), lerp(col[1], 242, s), lerp(col[2], 246, s)];
    }
    const k = i * 4;
    img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}

