// Terraform: the "Shape the Land" god tools and the system that keeps hydrology in step
// with terrain edits.
//
// Tools (group 'terrain', continuous brushes with soft falloff and a strength slider):
//   raise · lower · flatten · mountain (drag to draw a ridge) · sink (drown land) ·
//   island (raise an isle from the sea).
// Each application edits elevation, re-derives the tile's genesis temperature from the
// lapse rate (so a new peak is cold at once), bumps versions.terrain and marks
// world.pending.hydro. finish() — once per stroke — recomputes water and biomes, gives
// fresh land a thin soil, names notable creations (new islands and ranges join
// world.features) and writes a rate-limited Divine Hand chronicle entry.
// The per-tile shaping rules live in previews.js, beside each brush's preview (how far one
// application lifts or lowers the ground, how many until rock breaks the surface or a town
// drowns), so the hover forecast is the stroke's own arithmetic. Every application throws a
// 'terraform' effect (sign: up or down, src: 'tool').
//
// The system (order 5) also services world.pending.hydro set by other systems (quakes,
// lava, craters): at most once every 5 days it recomputes water and biomes.

import { registerTool } from '../core/tools.js';
import { bumpVersion } from '../core/world.js';
import { emit } from '../core/hooks.js';
import { chronicle } from '../core/chronicle.js';
import { RNG } from '../core/rng.js';
import { makePlace } from '../core/names.js';
import { nearestSettlement } from '../core/entities.js';
import { WATER } from '../core/constants.js';
import { clamp, clamp01, DX8, DY8 } from '../core/util.js';
import { ridgedL, num } from './grid.js';
import { recomputeWater } from './hydrology.js';
import { emitFx } from '../core/world.js';
import {
  brush, noiseFor, seaOf, radiusOf, strengthOf, raiseStep, lowerStep, mountainLift, sinkTarget, sinkStep, islandTarget, islandStep, flattenLevel,
  raisePreview, lowerPreview, flattenPreview, mountainPreview, sinkPreview, islandPreview,
} from './previews.js';
import { classifyBiomes } from './biomes.js';
import { LAPSE, heightKm } from './climate-base.js';

const HYDRO_EVERY = 5;          // days between automatic hydrology refreshes
const CHRONICLE_GAP = 20;       // days between chronicle entries from the same tool
const KM2_PER_TILE = 400;
const STALE_STROKE = 60;        // days without an application before hydrology stops waiting for finish()

export const system = {
  id: 'terraform',
  order: 5,
  init(world) {
    const st = (world.sys.terraform ||= {});
    if (!Number.isFinite(st.lastHydroDay)) st.lastHydroDay = -1e9;
    if (!st.lastChronicle || typeof st.lastChronicle !== 'object') st.lastChronicle = {};
    if (!Number.isFinite(st.strokes)) st.strokes = 0;
    if (!Number.isFinite(st.created)) st.created = 0;
    world.pending ||= {};
  },
  update(world) {
    const p = world.pending;
    if (!p || !p.hydro) return;
    const st = (world.sys.terraform ||= { lastHydroDay: -1e9, lastChronicle: {}, strokes: 0, created: 0 });
    if (world.time.day - st.lastHydroDay < HYDRO_EVERY) return;
    // a brush stroke in progress refreshes on finish(); one held still for long (fast
    // speeds) or never finished refreshes here, keeping its bookkeeping for finish()
    const s = st.stroke;
    if (s && world.time.day - s.lastDay <= STALE_STROKE) return;
    refreshTerrain(world);
  },
};

/** Recompute hydrology, lapse temperatures and biomes after elevation edits. */
export function refreshTerrain(world) {
  const st = (world.sys.terraform ||= { lastHydroDay: -1e9, lastChronicle: {}, strokes: 0, created: 0 });
  syncLapse(world);
  recomputeWater(world, { keepSea: true });
  classifyBiomes(world);
  world.pending ||= {};
  world.pending.hydro = false;
  st.lastHydroDay = world.time.day;
  emit(world, 'terrainChanged');
}

/** Re-derive baseTemp from the genesis sea-level temperature wherever elevation moved
 *  (edits by other systems); shifts annTemp and temp by the same amount. */
function syncLapse(world) {
  const { N, f } = world;
  const slt = f.seaLevelTemp;
  if (!slt || slt.length !== N) return 0;
  let n = 0;
  for (let i = 0; i < N; i++) {
    const want = slt[i] - LAPSE * heightKm(f.elevation[i]);
    const d = want - f.baseTemp[i];
    if (!(Math.abs(d) > 1e-3) || !Number.isFinite(want)) continue;
    shiftTemp(f, i, d);
    n++;
  }
  return n;
}

/** Move a tile's genesis, current, annual and biome-normal temperatures by dT. */
function shiftTemp(f, i, dT) {
  f.baseTemp[i] += dT;
  if (Number.isFinite(f.annTemp[i])) f.annTemp[i] += dT;
  if (Number.isFinite(f.temp[i])) f.temp[i] += dT;
  if (f.biomeTemp && Number.isFinite(f.biomeTemp[i])) f.biomeTemp[i] += dT;
}

// ---------------------------------------------------------------------------- strokes

// The stroke in progress is saved state (world.sys.terraform.stroke, plain JSON): it holds
// back the hydrology refresh until finish(), so a world saved mid-stroke must keep it.
function stroke(world, tool) {
  const st = (world.sys.terraform ||= { lastHydroDay: -1e9, lastChronicle: {}, strokes: 0, created: 0 });
  let s = st.stroke;
  if (!s || s.tool !== tool) {
    s = st.stroke = {
      tool, applies: 0, level: null, lastX: null, lastY: null,
      x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9,
      newLand: 0, drowned: 0, touched: 0, high: 0, sx: 0, sy: 0, sunk: {},   // sunk: { tile: 1 }
    };
  }
  return s;
}

/** Write one tile's new elevation, keeping temperatures and stroke bookkeeping in step. */
function setElev(world, s, i, v) {
  const f = world.f;
  const old = f.elevation[i];
  if (!Number.isFinite(v)) return;
  v = clamp(v, 0.002, 1);
  if (Math.abs(v - old) < 1e-7) return;
  f.elevation[i] = v;
  const sea = seaOf(world);
  if (old < sea && v >= sea) { s.newLand++; delete s.sunk[i]; }
  else if (old >= sea && v < sea) { s.drowned++; s.sunk[i] = 1; }
  const dT = -LAPSE * (heightKm(v) - heightKm(old));
  if (dT) shiftTemp(f, i, dT);
  const x = i % world.W, y = (i / world.W) | 0;
  if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x;
  if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
  s.touched++;
}


function begin(world, tool, x, y) {
  const s = stroke(world, tool);
  s.applies++;
  s.lastDay = world.time.day;
  s.sx += x; s.sy += y;
  return s;
}

function after(world, x, y, r, sign, str) {
  bumpVersion(world, 'terrain');
  world.pending ||= {};
  world.pending.hydro = true;
  emitFx(world, { type: 'terraform', x, y, r, sign, intensity: str, src: 'tool' });
}

/** The toast after one application: speak when rock first breaks the sea, or the sea first takes land. */
function shapeNote(s, newBefore, drownedBefore, first, firstWords) {
  if (s.newLand > 0 && newBefore === 0) return 'Rock breaks the surface of the sea.';
  if (s.drowned > 0 && drownedBefore === 0) return 'The sea pours in over the land.';
  return first ? firstWords : undefined;
}

// ------------------------------------------------------------------------------ tools

const STRENGTH = { label: 'Strength', min: 0.05, max: 1, default: 0.5 };
const COMMON = { group: 'terrain', target: 'area', continuous: true, minRadius: 1, maxRadius: 24, strength: STRENGTH };

registerTool({
  ...COMMON, id: 'raise', label: 'Raise Land', icon: 'raise', order: 10, radius: 4,
  desc: 'Lift the ground. Hold and drag to build hills; keep going and the sea gives way to new land.',
  preview: raisePreview,
  apply(world, x, y, opts) {
    const s = begin(world, 'raise', x, y);
    const nb = s.newLand, db = s.drowned;
    const k = 0.014 * strengthOf(opts);
    const e = world.f.elevation;
    const r = radiusOf(opts, 4);
    brush(world, x, y, r, (i, w) => setElev(world, s, i, raiseStep(e[i], w, k)));
    after(world, x, y, r, 1, strengthOf(opts));
    return { ok: true, message: shapeNote(s, nb, db, s.applies === 1, 'The ground swells upward.') };
  },
  finish: (world) => finishStroke(world, 'raise'),
});

registerTool({
  ...COMMON, id: 'lower', label: 'Lower Land', icon: 'lower', order: 20, radius: 4,
  desc: 'Press the ground down into valleys and basins. Low enough and the sea or a lake fills it.',
  preview: lowerPreview,
  apply(world, x, y, opts) {
    const s = begin(world, 'lower', x, y);
    const nb = s.newLand, db = s.drowned;
    const k = 0.014 * strengthOf(opts);
    const e = world.f.elevation;
    const r = radiusOf(opts, 4);
    brush(world, x, y, r, (i, w) => setElev(world, s, i, lowerStep(e[i], w, k)));
    after(world, x, y, r, -1, strengthOf(opts));
    return { ok: true, message: shapeNote(s, nb, db, s.applies === 1, 'The earth subsides.') };
  },
  finish: (world) => finishStroke(world, 'lower'),
});

registerTool({
  ...COMMON, id: 'flatten', label: 'Flatten', icon: 'flatten', order: 30, radius: 4,
  desc: 'Level the land toward the height where the stroke began: plains, plateaus, causeways.',
  preview: flattenPreview,
  apply(world, x, y, opts) {
    const s = begin(world, 'flatten', x, y);
    const nb = s.newLand, db = s.drowned;
    const e = world.f.elevation;
    const r = radiusOf(opts, 4);
    if (s.level == null) s.level = flattenLevel(world, x, y, r);
    const k = 0.35 * strengthOf(opts);
    const target = s.level;
    brush(world, x, y, r, (i, w) => setElev(world, s, i, e[i] + (target - e[i]) * Math.min(1, k * w)));
    after(world, x, y, r, target >= e[y * world.W + x] ? 1 : -1, strengthOf(opts) * 0.5);
    return { ok: true, message: shapeNote(s, nb, db, s.applies === 1, 'The land is laid level.') };
  },
  finish: (world) => finishStroke(world, 'flatten'),
});

registerTool({
  ...COMMON, id: 'mountain', label: 'Raise Mountains', icon: 'mountain', order: 40, radius: 3,
  desc: 'Fold the crust into craggy peaks. Drag to draw a whole range along your stroke.',
  preview: mountainPreview,
  apply(world, x, y, opts) {
    const s = begin(world, 'mountain', x, y);
    const nb = s.newLand, db = s.drowned;
    const { W, H, f } = world;
    const e = f.elevation;
    const r = radiusOf(opts, 3);
    const k = 0.04 * strengthOf(opts);
    const nz = noiseFor(world);
    // ridge along the segment from the previous stroke point (a drawn range)
    let ax = x, ay = y;
    if (s.lastX != null && Math.hypot(x - s.lastX, y - s.lastY) <= Math.max(6, r * 4)) { ax = s.lastX; ay = s.lastY; }
    s.lastX = x; s.lastY = y;
    const sx = x - ax, sy = y - ay, L2 = sx * sx + sy * sy;
    const R = Math.ceil(r);
    const x0 = Math.max(0, Math.min(ax, x) - R), x1 = Math.min(W - 1, Math.max(ax, x) + R);
    const y0 = Math.max(0, Math.min(ay, y) - R), y1 = Math.min(H - 1, Math.max(ay, y) + R);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      let t = L2 > 0 ? ((tx - ax) * sx + (ty - ay) * sy) / L2 : 0;
      t = clamp(t, 0, 1);
      const d = Math.hypot(tx - (ax + sx * t), ty - (ay + sy * t)) / r;
      if (d >= 1) continue;
      const w = Math.pow((1 - d * d) * (1 - d * d), 1.3);
      const i = ty * W + tx;
      const rid = ridgedL(nz, (tx + 0.5) / H * 16, (ty + 0.5) / H * 16, 3);
      const v = e[i];
      setElev(world, s, i, v + mountainLift(v, w, k, rid, seaOf(world)));
      if (e[i] >= 0.72) f.mineral[i] = Math.max(f.mineral[i], clamp01(0.35 + 0.45 * w));
    }
    after(world, x, y, r, 1, strengthOf(opts) * 1.4);
    return { ok: true, message: shapeNote(s, nb, db, s.applies === 1, 'The crust buckles into peaks.') };
  },
  finish: (world) => finishStroke(world, 'mountain'),
});

registerTool({
  ...COMMON, id: 'sink', label: 'Drown Land', icon: 'sink', order: 50, radius: 5,
  desc: 'Let the sea in. Coasts and lowlands under the brush sink beneath the waves.',
  polarity: 'bane',
  preview: sinkPreview,
  apply(world, x, y, opts) {
    const s = begin(world, 'sink', x, y);
    const nb = s.newLand, db = s.drowned;
    const e = world.f.elevation;
    const str = strengthOf(opts);
    const target = sinkTarget(seaOf(world), str);
    const r = radiusOf(opts, 5);
    brush(world, x, y, r, (i, w) => {
      const v = e[i];
      if (v > target) setElev(world, s, i, sinkStep(v, w, str, target));
    });
    after(world, x, y, r, -1, str);
    return { ok: true, message: shapeNote(s, nb, db, false, undefined) || (s.applies === 1 ? 'The coast begins to sink.' : undefined) };
  },
  finish: (world) => finishStroke(world, 'sink'),
});

registerTool({
  ...COMMON, id: 'island', label: 'Raise Island', icon: 'island', order: 60, radius: 3,
  desc: 'Call an island up from the sea floor: a green isle with a rocky heart.',
  preview: islandPreview,
  apply(world, x, y, opts) {
    const s = begin(world, 'island', x, y);
    s.isle ||= {};   // tiles this stroke has raised out of the sea: { tile: 1 }
    const nb = s.newLand, db = s.drowned;
    const e = world.f.elevation, W = world.W, H = world.H;
    const sea = seaOf(world);
    const str = strengthOf(opts);
    const r = radiusOf(opts, 3);
    // An island rises from the sea alone: the shore it rises beside keeps its height, and a strait
    // of sea stays between them, so a new isle never dams a bay over the towns on its shore.
    const shore = (i) => e[i] >= sea && !s.isle[i];
    const besideShore = (i) => {
      const x0 = i % W, y0 = (i / W) | 0;
      for (let d = 0; d < 8; d++) { const nx = x0 + DX8[d], ny = y0 + DY8[d]; if (nx >= 0 && ny >= 0 && nx < W && ny < H && shore(ny * W + nx)) return true; }
      return false;
    };
    brush(world, x, y, r, (i, w, tx, ty) => {
      const v = e[i];
      if (shore(i)) return;
      let t = islandTarget(world, tx, ty, w, sea, str);
      if (t >= sea && besideShore(i)) t = Math.min(t, sea - 0.0005);
      if (v < t) { setElev(world, s, i, islandStep(v, t)); if (v < sea && e[i] >= sea) s.isle[i] = 1; }
    });
    after(world, x, y, r, 1, str);
    // only claim the surface is broken when a tile actually crossed sea level
    return { ok: true, message: shapeNote(s, nb, db, false, undefined) || (s.applies === 1 ? 'The sea floor stirs and rises.' : undefined) };
  },
  finish: (world) => finishStroke(world, 'island'),
});

// ------------------------------------------------------------------------ finishing

function finishStroke(world, tool) {
  const st = (world.sys.terraform ||= { lastHydroDay: -1e9, lastChronicle: {}, strokes: 0, created: 0 });
  const s = st.stroke;
  st.stroke = null;
  if (!s || s.tool !== tool || !s.touched) {
    if (world.pending?.hydro) refreshTerrain(world);
    return;
  }
  st.strokes++;
  refreshTerrain(world);
  const { W, f } = world;
  // fresh land gets a thin soil; new peaks count toward a named range
  const fert = Math.max(0, num(world.params?.soilFertility, 1));
  let high = 0, landNow = 0;
  for (let y = s.y0; y <= s.y1; y++) for (let x = s.x0; x <= s.x1; x++) {
    const i = y * W + x;
    if (f.water[i] !== WATER.LAND) continue;
    landNow++;
    if (f.soil[i] < 0.05) f.soil[i] = clamp01(0.3 * fert);
    if (f.elevation[i] >= 0.72) high++;
  }
  s.high = high;
  pruneFeatures(world, s);
  s.toSea = 0; s.toLake = 0;
  for (const k in s.sunk) { const i = +k; if (f.water[i] === WATER.OCEAN) s.toSea++; else if (f.water[i] === WATER.LAKE) s.toLake++; }
  narrate(world, s, st, landNow);
}

function narrate(world, s, st, landNow) {
  const day = world.time.day;
  const last = Math.max(st.lastChronicle[s.tool] ?? -1e9, st.lastChronicle.any ?? -1e9);
  if (day - last < CHRONICLE_GAP) return;
  const cx = Math.round(s.sx / Math.max(1, s.applies)), cy = Math.round(s.sy / Math.max(1, s.applies));
  const rng = new RNG(`${world.seed}:divine:${day}:${st.strokes}`);
  const near = placeNear(world, cx, cy);
  const at = near ? ` near ${near}` : '';
  const pick = (a) => a[Math.floor(rng.next() * a.length)];
  let text = null, imp = 2, feature = null;
  if (s.tool === 'island' || (s.tool === 'raise' && s.newLand >= 6)) {
    if (s.newLand >= 3 && landNow >= 3) {
      const base = makePlace(world.lang, rng);
      const name = pick([base, `the Isle of ${base}`, `${base} Isle`]);
      text = pick([
        `At the gods' command ${name} rose steaming from the sea${at}.`,
        `The sea floor heaved${at}, and ${name} broke the waves where only water had been.`,
        `A new land, ${name}, was lifted from the deep${at}.`,
      ]);
      feature = { kind: 'island', base, name, size: s.newLand };
      imp = s.newLand >= 30 ? 3 : 2;
    }
  } else if (s.tool === 'mountain' && s.high >= 4) {
    const base = makePlace(world.lang, rng);
    const name = pick([`the ${base} Mountains`, `the ${base} Peaks`, `the ${base} Range`]);
    text = pick([
      `The earth groaned${at}, and ${name} were thrust toward the sky.`,
      `In a single season ${name} rose${at}, raw stone where there had been fields.`,
      `The crust folded${at} and a new range, ${name}, stood against the clouds.`,
    ]);
    feature = { kind: 'range', base, name, size: s.high };
    imp = s.high >= 25 ? 3 : 2;
  } else if (s.toSea >= 4) {
    const km = (s.toSea * KM2_PER_TILE).toLocaleString('en-US');
    text = pick([
      `The sea rose against the land${at} and swallowed ${km} km² beneath the waves.`,
      `By the gods' will the coast${at} sank, and ${km} km² of land became sea.`,
      `Waters closed over the lowlands${at}; ${km} km² were lost to the deep.`,
    ]);
    imp = s.toSea >= 30 ? 3 : 2;
  } else if (s.toLake >= 4) {
    const km = (s.toLake * KM2_PER_TILE).toLocaleString('en-US');
    text = pick([
      `The ground sank${at}, and a new lake of ${km} km² filled the hollow.`,
      `The earth gave way${at}; rain and rivers filled the basin with a lake of ${km} km².`,
    ]);
    imp = 2;
  }
  if (!text) return;
  st.lastChronicle[s.tool] = day;
  st.lastChronicle.any = day - Math.round(CHRONICLE_GAP / 2);   // other tools may speak again sooner
  chronicle(world, { cat: 'divine', imp, text, x: cx, y: cy, icon: s.tool, key: `divine.${s.tool}`, tags: [feature ? feature.kind : s.toSea >= 4 ? 'drowned' : 'lake'] });
  if (feature) {
    const angle = s.tool === 'mountain' && s.x1 > s.x0 ? clamp(Math.atan2(s.y1 - s.y0, s.x1 - s.x0), -Math.PI / 2, Math.PI / 2) : undefined;
    world.features.push({ id: world.features.length, ...feature, x: cx, y: cy, ...(angle != null ? { angle, len: Math.round(Math.hypot(s.x1 - s.x0, s.y1 - s.y0)) } : {}), divine: true });
    bumpVersion(world, 'features');
    st.created++;
  }
}

/** Drop labels whose anchor the stroke turned to the wrong element (a drowned island or
 *  range, a lake filled in). Feature ids are re-indexed. */
function pruneFeatures(world, s) {
  const { W, H, f } = world;
  const fs = world.features || [];
  const keep = fs.filter((ft) => {
    const x = Math.round(ft.x), y = Math.round(ft.y);
    if (x < s.x0 - 2 || x > s.x1 + 2 || y < s.y0 - 2 || y > s.y1 + 2 || x < 0 || y < 0 || x >= W || y >= H) return true;
    const wt = f.water[y * W + x];
    if (ft.kind === 'lake') return wt === WATER.LAKE;
    if (ft.kind === 'island' || ft.kind === 'range' || ft.kind === 'desert' || ft.kind === 'forest') return wt === WATER.LAND;
    return true;
  });
  if (keep.length === fs.length) return;
  keep.forEach((ft, k) => { ft.id = k; });
  world.features = keep;
  bumpVersion(world, 'features');
}

/** A name for prose: the nearest settlement within reach, else the nearest landmark. */
function placeNear(world, x, y) {
  try {
    const s = nearestSettlement(world, x, y, { maxDist: 14 });
    if (s && s.name) return s.name;
  } catch (e) { /* settlement index unavailable: fall back to features */ }
  let best = null, bd = 30 * 30;
  for (const ft of world.features || []) {
    if (!ft || !ft.name || ft.kind === 'river' || ft.kind === 'continent') continue;
    const d = (ft.x - x) ** 2 + (ft.y - y) ** 2;
    if (d < bd) { bd = d; best = ft; }
  }
  return best ? best.name : null;
}
