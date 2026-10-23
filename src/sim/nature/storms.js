// Named storms (world.storms): tropical cyclones with tracks and landfalls, blizzards
// over winter land, summer thunderstorms whose lightning kindles wildfires, and desert
// sandstorms. Storms steer on the prevailing winds, feed on (or starve for) warm water,
// pour rain into the moisture grid, and damage what they cross. Spawning is scaled by the
// ext 'rates' key 'storm'.
//
// Each storm keeps a decimated track (st.track, at most 24 points [x, y, intensity]: when it
// fills, every other point goes and the sampling interval doubles), its landfalls, deaths and
// the towns it struck; when it ends, stormEnded carries all of it. A god's push (st.push
// { vx, vy, days }, the steer_storm act) is blended into the steering while it lasts and then
// fades. forecastTrack(world, storm, days, push) runs the same steering without chance, as a
// pure forecast for previews.
//
// Exports: stormNameList, spawnStorm, updateStorms, forecastTrack, catOf, stormRadius
import { WATER, BIOME, BIOMES, DAYS_PER_YEAR } from '../../core/constants.js';
import { latitude, emitFx } from '../../core/world.js';

import { addEntity, settlementsNear, damageSettlement } from '../../core/entities.js';
import { chronicle } from '../../core/chronicle.js';
import { makePerson } from '../../core/names.js';
import { ignite } from '../ecology.js';
import { fin, clampR, ss, cl01, rateOk, pick, listJoin, deathsClause, poisson, profStart, profEnd, numberWord, emitHook, rateMul } from './common.js';
import { WX_CELL, coarseDims, regionOf, landList } from './grid.js';
import { placePhrase, withArticle, featureAt } from './places.js';

const CAP = { cyclone: 9, blizzard: 8, thunderstorm: 26, sandstorm: 6 };
const TRACK_MAX = 24;   // points kept per storm (decimated as it ages)
/** Biomes whose trees a cyclone can flatten. */
const WOODY = new Uint8Array(BIOMES.map((b) => (b.wood > 0.5 ? 1 : 0)));
const LABEL = { cyclone: 'Cyclone', blizzard: 'Blizzard', thunderstorm: 'Thunderstorm', sandstorm: 'Sandstorm' };

// ---------------------------------------------------------------------------
// Names

/** A rotating list of storm names in the world's tongue (plus borrowed words). */
export function stormNameList(world) {
  const rng = world.rng.fork('storm-names');
  const out = [];
  const seen = new Set();
  for (let k = 0; out.length < 26 && k < 200; k++) {
    let n = makePerson(world.lang, rng);
    n = n.replace(/'/g, '');
    if (n.length < 3 || n.length > 9 || seen.has(n)) continue;
    seen.add(n); out.push(n);
  }
  return out.sort();
}

function nextName(world, sys) {
  if (!Array.isArray(sys.names) || !sys.names.length) sys.names = stormNameList(world);
  // Prefer the language of the people living nearest the storm's birthplace now and then.
  const n = sys.names[(sys.nameIdx || 0) % sys.names.length];
  sys.nameIdx = ((sys.nameIdx || 0) + 1) % (sys.names.length * 1000);
  return n;
}

// ---------------------------------------------------------------------------
// Spawn candidates (cached by water / biome versions)

function candidates(world) {
  const key = world.versions.water;
  let c = world.cache.natStormCand;
  if (c && c.key === key && c.N === world.N) return c;
  const { W, H, f } = world;
  // tropical sea N/S (all, and those with a coast 8–70 tiles to the west, toward which
  // the trade winds carry them), cold land N/S, warm land N/S
  const lists = [[], [], [], [], [], [], [], []];
  const water = f.water;
  for (let y = 0; y < H; y++) {
    const lat = latitude(world, y), al = Math.abs(lat), north = lat > 0;
    const trop = al > 0.06 && al < 0.33, hi = al > 0.38, warm = al < 0.62;
    let lastLand = -1e9;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const w = water[i];
      if (w === WATER.OCEAN) {
        if (trop) {
          lists[north ? 0 : 1].push(i);
          const dl = x - lastLand;
          if (dl >= 8 && dl <= 70) lists[north ? 6 : 7].push(i);
        }
      } else if (w === WATER.LAND) {
        lastLand = x;
        if (hi) lists[north ? 2 : 3].push(i);
        if (warm) lists[north ? 4 : 5].push(i);
      }
    }
  }
  const I = (a) => Int32Array.from(a);
  // Prefer basins with a coast downwind; open-ocean worlds fall back to every warm sea.
  c = world.cache.natStormCand = {
    key, N: world.N,
    tropN: I(lists[6].length > 40 ? lists[6] : lists[0]), tropS: I(lists[7].length > 40 ? lists[7] : lists[1]),
    hiN: I(lists[2]), hiS: I(lists[3]), warmN: I(lists[4]), warmS: I(lists[5]),
  };
  return c;
}

const count = (world, kind) => { let n = 0; for (const s of world.storms) if (s.kind === kind) n++; return n; };
/** Seasonal weight: Gaussian in (circular) month distance from the peak month c. */
function circ(m, c) { let d = Math.abs(m - c); d = Math.min(d, 12 - d); return Math.exp(-(d * d) / (2 * 1.6 * 1.6)); }

/** Create a storm entity. */
export function spawnStorm(world, kind, x, y, intensity, extra = {}) {
  if (count(world, kind) >= CAP[kind] && !extra.forced) return null;
  const sys = world.sys.weather;
  const lat = latitude(world, Math.round(y));
  const rng = world.rng;
  const life = kind === 'cyclone' ? rng.float(11, 24) : kind === 'blizzard' ? rng.float(3, 7) : kind === 'thunderstorm' ? rng.float(1, 3) : rng.float(2, 5);
  const st = {
    id: -1, kind,
    name: kind === 'cyclone' ? nextName(world, sys) : LABEL[kind],
    x, y, vx: 0, vy: 0,
    intensity: cl01(intensity), radius: 2, age: 0, maxAge: life,
    hemisphere: lat >= 0 ? 1 : -1,
    category: 0, peak: cl01(intensity), startDay: world.time.day,
    origin: { x: Math.round(x), y: Math.round(y) },
    landfalls: 0, hit: [], deaths: 0, damaged: [], track: [[Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(cl01(intensity) * 100) / 100]], trackStep: 1,
    strikes: 0, overLand: world.f.water[Math.round(y) * world.W + Math.round(x)] === WATER.LAND,
    divine: Boolean(extra.divine),
  };
  st.radius = stormRadius(st);
  addEntity(world, 'storms', st, 'storm');
  if (kind === 'cyclone') sys.counts.cyclones = (sys.counts.cyclones || 0) + 1;
  else sys.counts[kind] = (sys.counts[kind] || 0) + 1;
  return st;
}

/** Radius (tiles) of a storm of its kind and intensity. */
export function stormRadius(st) {
  switch (st.kind) {
    case 'cyclone': return 2 + 4.5 * st.intensity;
    case 'blizzard': return 3 + 3 * st.intensity;
    case 'thunderstorm': return 1 + 1.2 * st.intensity;
    default: return 2 + 3 * st.intensity;
  }
}

function catOf(I) { return I < 0.25 ? 0 : Math.min(5, 1 + Math.floor((I - 0.25) / 0.15)); }

/**
 * Pure forecast: the course storm st would take over the next `days` days under the steady
 * steering of the winds (no chance), with an optional push { vx, vy, days } from a god.
 * Returns [{ x, y, r, I, day }] (day 0 = now), stopping when the storm would die or leave the map.
 */
export function forecastTrack(world, st, days = 30, push = null) {
  const { W, H } = world;
  const out = [];
  if (!st || !Number.isFinite(st.x) || !Number.isFinite(st.y)) return out;
  const ws = clampR(fin(world.params.windStrength, 1), 0, 2);
  let x = st.x, y = st.y, vx = fin(st.vx), vy = fin(st.vy), I = fin(st.intensity, 0.3), age = fin(st.age);
  const maxAge = fin(st.maxAge, 12);
  let p = push ? { vx: fin(push.vx), vy: fin(push.vy), days: fin(push.days) } : st.push ? { vx: fin(st.push.vx), vy: fin(st.push.vy), days: fin(st.push.days) } : null;
  const probe = { kind: st.kind, intensity: I };
  out.push({ x, y, r: stormRadius({ kind: st.kind, intensity: I }), I, day: 0 });
  const aim = { tx: 0, ty: 0, blend: 0 };
  for (let d = 1; d <= Math.min(90, days); d++) {
    const xi = clampR(Math.floor(x), 0, W - 1), yi = clampR(Math.floor(y), 0, H - 1);
    const i = yi * W + xi;
    age += 1;
    steerTarget(world, st.kind, st.hemisphere || (latitude(world, yi) >= 0 ? 1 : -1), i, ws, aim);
    let tx = aim.tx, ty = aim.ty, blend = aim.blend;
    const pw = pushWeight(p);
    if (pw > 0) { tx = tx * (1 - pw) + p.vx * pw; ty = ty * (1 - pw) + p.vy * pw; blend = Math.max(blend, 0.5 * pw); }
    if (p) { p.days -= 1; if (!(p.days > 0)) p = null; }
    vx += (tx - vx) * blend; vy += (ty - vy) * blend;
    if (st.kind === 'cyclone') { const sp = Math.hypot(vx, vy); if (sp < 1.2) { const k = 1.2 / Math.max(0.01, sp); vx *= k; vy *= k; } }
    vx = clampR(vx, -7, 7); vy = clampR(vy, -7, 7);
    x += vx; y += vy;
    if (!(x >= 0 && y >= 0 && x < W && y < H)) break;
    const ni = clampR(Math.floor(y), 0, H - 1) * W + clampR(Math.floor(x), 0, W - 1);
    I = intensityStep(world, st.kind, I, age, maxAge, ni, latitude(world, clampR(Math.floor(y), 0, H - 1)));
    probe.intensity = I;
    out.push({ x, y, r: stormRadius(probe), I, day: d });
    if (I < 0.05 || age > maxAge + 4) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Daily spawning

function trySpawn(world) {
  const p = world.params;
  const rate = clampR(fin(p.stormRate, 1), 0, 3) * rateMul(world, 'storm');
  if (rate <= 0) return;
  const rng = world.rng, f = world.f;
  const temp = f.temp, snow = f.snow, hum = f.humidity, soilW = f.soilWater, rain = f.rain, biome = f.biome, windX = f.windX, windY = f.windY;
  const cand = candidates(world);
  const doy = world.time.day % DAYS_PER_YEAR;
  const mf = doy / 30; // fractional month
  // Tropical cyclones: late summer / autumn of each hemisphere, over water ≥ 26.5 °C.
  for (let h = 0; h < 2; h++) {
    const hemi = h ? -1 : 1;
    const list = hemi > 0 ? cand.tropN : cand.tropS;
    if (!list.length) continue;
    const w = circ(mf, hemi > 0 ? 8 : 2);
    if (!rng.chance(0.04 * rate * w)) continue;
    for (let k = 0; k < 6; k++) {
      const i = list[Math.floor(rng.next() * list.length)];
      if (temp[i] < 26.5 || snow[i] > 0) continue;
      const st = spawnStorm(world, 'cyclone', (i % world.W) + 0.5, ((i / world.W) | 0) + 0.5, rng.float(0.12, 0.3));
      if (st) { st.vx = -2.5; st.vy = -0.4 * hemi; }
      break;
    }
  }
  // Blizzards over cold land in each hemisphere's winter.
  for (let h = 0; h < 2; h++) {
    const hemi = h ? -1 : 1;
    const list = hemi > 0 ? cand.hiN : cand.hiS;
    if (!list.length) continue;
    const w = circ(mf, hemi > 0 ? 0.5 : 6.5);
    if (!rng.chance(0.045 * rate * w)) continue;
    const i = list[Math.floor(rng.next() * list.length)];
    if (temp[i] > -5 || hum[i] < 0.4) continue;
    spawnStorm(world, 'blizzard', (i % world.W) + 0.5, ((i / world.W) | 0) + 0.5, rng.float(0.35, 1));
  }
  // Thunderstorms over hot, humid summer land.
  for (let h = 0; h < 2; h++) {
    const hemi = h ? -1 : 1;
    const list = hemi > 0 ? cand.warmN : cand.warmS;
    if (!list.length) continue;
    const w = 0.25 + 0.75 * circ(mf, hemi > 0 ? 6.5 : 0.5);
    const n = poisson(rng, 1.3 * rate * w);
    for (let k = 0; k < n; k++) {
      const i = list[Math.floor(rng.next() * list.length)];
      if (temp[i] < 19 || (hum[i] < 0.35 && soilW[i] < 0.2 && rain[i] < 0.08)) continue;
      spawnStorm(world, 'thunderstorm', (i % world.W) + 0.5, ((i / world.W) | 0) + 0.5, rng.float(0.3, 1));
    }
  }
  // Sandstorms over parched deserts (a few land tiles are tested each day).
  const land = landList(world);
  if (land.length && rng.chance(0.5 * rate)) {
    for (let k = 0; k < 3; k++) {
      const i = land[Math.floor(rng.next() * land.length)];
      const b = biome[i];
      if (b !== BIOME.HOT_DESERT && b !== BIOME.COLD_DESERT) continue;
      const wind = Math.hypot(fin(windX[i]), fin(windY[i])) * clampR(fin(p.windStrength, 1), 0, 2);
      if (soilW[i] < 0.14 && wind > 0.25 && rng.chance(0.4)) spawnStorm(world, 'sandstorm', (i % world.W) + 0.5, ((i / world.W) | 0) + 0.5, rng.float(0.4, 1));
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Daily movement and effects

export function updateStorms(world) {
  let tp = profStart(world);
  trySpawn(world);
  profEnd(world, 'wst.spawn', tp);
  const sys = world.sys.weather;
  sys.fxToday = 0;
  for (let k = world.storms.length - 1; k >= 0; k--) {
    const st = world.storms[k];
    let alive = false;
    try { alive = stepStorm(world, st); } catch (e) { console.error('[weather] storm step failed', e); alive = false; }
    if (!alive) {
      try { finishStorm(world, st); } catch (e) { console.error('[weather] storm finish failed', e); }
      world.storms.splice(k, 1);
    }
  }
}

/** The wind a storm of this kind steers toward at tile i (no chance), written into out { tx, ty, blend }. */
function steerTarget(world, kind, hemisphere, i, ws, out) {
  const f = world.f;
  const wx = fin(f.windX[i]), wy = fin(f.windY[i]);
  switch (kind) {
    case 'cyclone': out.tx = wx * ws * 3.2 - 0.35; out.ty = wy * ws * 3.2 - 0.85 * hemisphere; out.blend = 0.3; break;
    case 'blizzard': out.tx = wx * ws * 2.4 + 0.6; out.ty = wy * ws * 2.4; out.blend = 0.45; break;
    case 'thunderstorm': out.tx = wx * ws * 1.3; out.ty = wy * ws * 1.3; out.blend = 0.5; break;
    default: out.tx = wx * ws * 3.0; out.ty = wy * ws * 3.0; out.blend = 0.5;
  }
  return out;
}

/** The day's change of intensity at tile ni (no chance). */
function intensityStep(world, kind, I, age, maxAge, ni, lat) {
  const f = world.f;
  const nowLand = f.water[ni] === WATER.LAND;
  if (kind === 'cyclone') {
    const sst = f.temp[ni];
    if (nowLand) I -= 0.26;
    else I += 0.09 * clampR((sst - 26) / 3, -1.6, 1.4) * (1 - I * 0.5);
    if (Math.abs(lat) > 0.45) I -= 0.08;
    if (age > maxAge * 0.8) I -= 0.08;
  } else if (kind === 'blizzard') {
    I += (f.temp[ni] < -4 && nowLand ? 0.02 : -0.2) - (age > maxAge * 0.6 ? 0.15 : 0);
  } else if (kind === 'thunderstorm') {
    I -= age >= maxAge ? 0.6 : 0.15;
  } else {
    const b = f.biome[ni];
    I += (b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT ? 0 : -0.3) - (age > maxAge * 0.6 ? 0.2 : 0);
  }
  return cl01(I);
}

/** A reusable { tx, ty, blend } for the daily steering (world.cache; holds nothing between calls). */
const scratch = (world) => (world.cache.natSteer ||= { tx: 0, ty: 0, blend: 0 });

/** A god's push, blended into the steering while it lasts: weight 1 fading to 0 over its days. */
function pushWeight(push) {
  if (!push || !(push.days > 0)) return 0;
  return Math.min(1, push.days / 6);
}

/** Keep the track to TRACK_MAX points: when full, drop every other one and sample half as often. */
function trackPoint(st) {
  const t = st.track || (st.track = []);
  st.trackStep = Math.max(1, st.trackStep | 0 || 1);
  if ((st.age | 0) % st.trackStep !== 0) return;
  t.push([Math.round(st.x * 10) / 10, Math.round(st.y * 10) / 10, Math.round(st.intensity * 100) / 100]);
  if (t.length > TRACK_MAX) {
    const keep = [];
    for (let k = 0; k < t.length; k++) if (k % 2 === 0 || k === t.length - 1) keep.push(t[k]);
    st.track = keep;
    st.trackStep *= 2;
  }
}

function stepStorm(world, st) {
  const { W, H, f } = world;
  const water = f.water;
  const rng = world.rng;
  const ws = clampR(fin(world.params.windStrength, 1), 0, 2);
  if (!Number.isFinite(st.x) || !Number.isFinite(st.y) || !Number.isFinite(st.vx) || !Number.isFinite(st.vy) || !Number.isFinite(st.intensity) || !Number.isFinite(st.age)) return false;
  const xi = clampR(Math.floor(st.x), 0, W - 1), yi = clampR(Math.floor(st.y), 0, H - 1);
  const i = yi * W + xi;
  const lat = latitude(world, yi);
  st.age += 1;
  // Steering (a god's push, while it lasts, bends the course)
  const aim = steerTarget(world, st.kind, st.hemisphere, i, ws, scratch(world));
  let tx = aim.tx, ty = aim.ty, blend = aim.blend;
  const pw = pushWeight(st.push);
  if (pw > 0) { tx = tx * (1 - pw) + st.push.vx * pw; ty = ty * (1 - pw) + st.push.vy * pw; blend = Math.max(blend, 0.5 * pw); }
  st.vx += (tx - st.vx) * blend + rng.normal(0, 0.25) * (1 - 0.7 * pw);
  st.vy += (ty - st.vy) * blend + rng.normal(0, 0.2) * (1 - 0.7 * pw);
  if (st.push) { st.push.days -= 1; if (!(st.push.days > 0)) st.push = null; }
  if (st.kind === 'cyclone') {
    const sp = Math.hypot(st.vx, st.vy);
    if (sp < 1.2) { const k = 1.2 / Math.max(0.01, sp); st.vx *= k; st.vy *= k; if (!Number.isFinite(st.vx)) { st.vx = -1.2; st.vy = 0; } }
  }
  st.vx = clampR(st.vx, -7, 7); st.vy = clampR(st.vy, -7, 7);
  const ox = st.x, oy = st.y;
  st.x += st.vx; st.y += st.vy;
  if (st.x < 0 || st.y < 0 || st.x >= W || st.y >= H) return false;
  const nxI = clampR(Math.floor(st.x), 0, W - 1), nyI = clampR(Math.floor(st.y), 0, H - 1);
  const ni = nyI * W + nxI;
  const nowLand = water[ni] === WATER.LAND;
  // Intensity
  const I = st.intensity = intensityStep(world, st.kind, st.intensity, st.age, st.maxAge, ni, lat);
  st.peak = Math.max(st.peak, I);
  st.category = st.kind === 'cyclone' ? catOf(I) : 0;
  st.radius = stormRadius(st);
  if (st.kind !== 'thunderstorm') trackPoint(st);
  // Landfall
  if (st.kind === 'cyclone' && nowLand && !st.overLand && I > 0.2) {
    st.landfalls++;
    const pl = placePhrase(world, nxI, nyI, { settleDist: 8 });
    if (!st.firstLandfall) st.firstLandfall = { x: nxI, y: nyI, day: world.time.day, place: pl.text, cat: st.category };
    emitFx(world, { type: 'landfall', x: st.x, y: st.y, r: st.radius, intensity: I });
  }
  st.overLand = nowLand;
  const tp = profStart(world);
  effects(world, st, ox, oy);
  profEnd(world, 'wst.fx.' + st.kind, tp);
  if (I < 0.05 || st.age > st.maxAge + 4) return false;
  return true;
}

/** Rain, wind and snow under the storm; settlement damage once per storm. */
function effects(world, st, ox, oy) {
  const { W, H, f } = world;
  const I = st.intensity, R = st.radius;
  const C = WX_CELL;
  const { cw, ch } = coarseDims(W, H, C);
  const rainC = f.wxRain, cloudC = f.wxCloud;
  const bM = world.cache.natWx?.bM;
  // Coarse rain & cloud (max, so daily re-application is idempotent). The rain grid is
  // relative to each cell's climatology, so absolute storm rain is divided by it.
  if (rainC && cloudC && bM && st.kind !== 'sandstorm') {
    const rc = R / C + 0.6;
    const cx0 = Math.max(0, Math.floor(st.x / C - rc)), cx1 = Math.min(cw - 1, Math.ceil(st.x / C + rc));
    const cy0 = Math.max(0, Math.floor(st.y / C - rc)), cy1 = Math.min(ch - 1, Math.ceil(st.y / C + rc));
    const peakRain = st.kind === 'cyclone' ? 1.8 * I + 0.2 : st.kind === 'thunderstorm' ? 0.9 * I : 0.5 * I;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const dx = (cx + 0.5) * C - st.x, dy = (cy + 0.5) * C - st.y;
      const d = Math.sqrt(dx * dx + dy * dy) / Math.max(1, R + C * 0.5);
      if (d > 1) continue;
      const g = 1 - d * d;
      const c = cy * cw + cx;
      rainC[c] = Math.max(rainC[c], (peakRain * g) / Math.max(0.06, bM[c]));
      cloudC[c] = Math.max(cloudC[c], Math.min(1, (0.55 + 0.45 * I) * Math.sqrt(g)));
    }
  }
  // Tile effects.
  const x0 = Math.max(0, Math.floor(st.x - R)), x1 = Math.min(W - 1, Math.ceil(st.x + R));
  const y0 = Math.max(0, Math.floor(st.y - R)), y1 = Math.min(H - 1, Math.ceil(st.y + R));
  const R2 = R * R;
  const water = f.water, soilW = f.soilWater, dev = f.devastation, veg = f.veg, biome = f.biome, fire = f.fire, snow = f.snow, herb = f.herb;
  const kind = st.kind === 'cyclone' ? 0 : st.kind === 'blizzard' ? 1 : st.kind === 'thunderstorm' ? 2 : 3;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x + 0.5 - st.x, dy = y + 0.5 - st.y, d2 = dx * dx + dy * dy;
    if (d2 > R2) continue;
    const i = y * W + x;
    if (water[i] !== WATER.LAND) continue;
    const g = 1 - d2 / R2;
    if (kind === 0) {
      soilW[i] = Math.min(1, soilW[i] + 0.09 * I * g);
      if (I > 0.35) {
        dev[i] = Math.min(1, dev[i] + 0.035 * I * I * g);
        if (WOODY[biome[i]]) veg[i] = Math.max(0, veg[i] - 0.025 * I * I * g);
      }
      if (fire[i] > 0) fire[i] = 0;
    } else if (kind === 1) {
      snow[i] = Math.min(1, snow[i] + 0.16 * I * g);
      herb[i] *= 1 - 0.02 * I * g;
    } else if (kind === 2) {
      soilW[i] = Math.min(1, soilW[i] + 0.03 * I * g);
    } else {
      const b = biome[i];
      if (b !== BIOME.HOT_DESERT && b !== BIOME.COLD_DESERT) veg[i] = Math.max(0, veg[i] - 0.008 * I * g);
    }
  }
  if (st.kind === 'thunderstorm') lightning(world, st);
  hitSettlements(world, st);
}

function lightning(world, st) {
  const { W, H, f } = world;
  const water = f.water, veg = f.veg, soilW = f.soilWater, rain = f.rain, biome = f.biome;
  const rng = world.rng;
  const sys = world.sys.weather;
  const n = poisson(rng, 0.9 + 2.4 * st.intensity);
  const fireRate = clampR(fin(world.params.wildfireRate, 1), 0, 3);
  let emitted = 0;
  for (let k = 0; k < n; k++) {
    const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * st.radius;
    const x = clampR(Math.floor(st.x + Math.cos(a) * r), 0, W - 1), y = clampR(Math.floor(st.y + Math.sin(a) * r), 0, H - 1);
    const i = y * W + x;
    st.strikes++;
    sys.counts.strikes = (sys.counts.strikes || 0) + 1;
    if (emitted < 2 && sys.fxToday < 10) { emitFx(world, { type: 'lightning', x: x + 0.5, y: y + 0.5 }); emitted++; sys.fxToday++; }
    if (water[i] !== WATER.LAND || fireRate <= 0) continue;
    const v = veg[i];
    if (v < 0.15) continue;
    const dry = 1 - ss(0.12, 0.42, soilW[i]);
    const wetNow = Math.min(1, rain[i] * 2.5);
    const p = 0.4 * BIOMES[biome[i]].fire * dry * (1 - 0.8 * wetNow) * Math.min(1.5, fireRate) * ss(0.1, 0.5, v);
    if (p > 0 && rng.chance(p)) {
      ignite(world, i, 0.35 + 0.45 * st.intensity, { cause: 'lightning' });
      sys.counts.lightningFires = (sys.counts.lightningFires || 0) + 1;
    }
  }
}

function hitSettlements(world, st) {
  if (st.kind === 'thunderstorm') return;
  const I = st.intensity;
  if (I < 0.15) return;
  const R = st.radius + (st.kind === 'cyclone' ? 0.5 : 0);
  const near = settlementsNear(world, st.x, st.y, R);
  for (const s of near) {
    if (st.hit.includes(s.id)) continue;
    const d = Math.hypot(s.x + 0.5 - st.x, s.y + 0.5 - st.y) / Math.max(1, R);
    let sev, dmg;
    if (st.kind === 'cyclone') {
      if (world.f.water[Math.floor(st.y) * world.W + Math.floor(st.x)] !== WATER.LAND && !s.coastal) continue; // still at sea: only coasts feel it
      const surge = s.coastal ? 1.35 + (s.harbor ? 0.25 : 0) : 0.55;
      sev = Math.pow(I, 1.4) * Math.pow(Math.max(0, 1 - d), 0.7) * surge;
      if (sev < 0.05) continue;
      dmg = { pop: 0.032 * sev, buildings: 0.22 * sev, food: 0.3 * sev, wealth: 0.14 * sev, defense: 0.08 * sev, cause: 'storm' };
    } else if (st.kind === 'blizzard') {
      sev = I * (1 - d);
      if (sev < 0.15) continue;
      dmg = { pop: 0.003 * sev, food: 0.05 * sev, cause: 'blizzard' };
    } else {
      sev = I * (1 - d);
      if (sev < 0.2) continue;
      dmg = { food: 0.035 * sev, wealth: 0.02 * sev, cause: 'sandstorm' };
    }
    st.hit.push(s.id);
    const pop0 = s.population, tier = s.tier, name = s.name, harbor = s.harbor, coastal = s.coastal;
    const killed = damageSettlement(world, s, dmg);
    world.f.devastation[s.i] = Math.min(1, world.f.devastation[s.i] + 0.25 * sev);
    st.deaths += killed;
    if (st.damaged.length < 10) st.damaged.push({ sid: s.id, name, killed: Math.round(killed), pop: Math.round(pop0), tier, harbor, coastal, sev: Math.round(sev * 100) / 100, x: s.x, y: s.y, gone: !s.alive });
  }
}

// ---------------------------------------------------------------------------
// End of a storm: one chronicle sentence for the storms that mattered.

function finishStorm(world, st) {
  const sys = world.sys.weather;
  const day = world.time.day;
  const dmg = st.damaged || [];
  const deaths = Math.round(st.deaths || 0);
  const entry = stormChronicle(world, sys, st, dmg, deaths, day);
  // the storm's whole story, once, as it leaves the map
  if (st.kind !== 'thunderstorm') {
    emitHook(world, 'stormEnded', {
      id: st.id, kind: st.kind, name: st.name, deaths, landfalls: st.landfalls | 0,
      towns: dmg.slice(0, 8).map((d) => d.sid), peak: Math.round(fin(st.peak) * 100) / 100, category: st.kind === 'cyclone' ? catOf(fin(st.peak)) : 0,
      track: (st.track || []).slice(0, TRACK_MAX).map((p) => [p[0], p[1], p[2] ?? 0]),
      startDay: st.startDay ?? null, endDay: day, divine: Boolean(st.divine), seq: entry ? entry.seq : null,
    });
  }
}

/** One chronicle sentence for the storms that mattered (returns the entry, or null). */
function stormChronicle(world, sys, st, dmg, deaths, day) {
  const ref = { k: 'storm', id: st.id };
  if (st.kind === 'cyclone') {
    sys.counts.cycloneDeaths = (sys.counts.cycloneDeaths || 0) + deaths;
    if (st.landfalls) sys.counts.landfalls = (sys.counts.landfalls || 0) + st.landfalls;
    if (!dmg.length) {
      if (st.peak >= 0.85 && st.landfalls && rateOk(sys, 'cycWild', day, 6)) {
        const lf = st.firstLandfall;
        return chronicle(world, { cat: 'disaster', imp: 1, x: lf?.x, y: lf?.y, key: 'storm.cyclone', ref, text: pick(world, [
          `The great cyclone ${st.name} came ashore ${lf?.place || 'on an empty coast'}, flattening forests where no one lived to see it.`,
          `${st.name}, a storm of the ${catOf(st.peak) >= 5 ? 'fifth' : catOf(st.peak) >= 4 ? 'fourth' : 'third'} degree, spent its fury ${lf?.place || 'on an empty shore'}, uprooting whole forests.`,
        ]) });
      }
      return null;
    }
    const worst = dmg.slice().sort((a, b) => b.killed - a.killed || b.sev - a.sev)[0];
    const names = dmg.map((d) => d.name);
    const big = dmg.some((d) => d.tier >= 5) || deaths >= 2000 || dmg.some((d) => d.gone);
    // once coasts are lined with towns nearly every landfall hits one: only real tolls are
    // notable, and the same harbour is not written up again for a few years
    const notable = big || deaths >= 250 || (deaths >= 60 && (dmg.length >= 3 || worst.tier >= 4));
    let imp = big ? 3 : notable ? 2 : 1;
    if (imp === 2 && deaths < 1000 && !rateOk(sys, `cyc2:${worst.sid}`, day, 4)) imp = 1;
    if (imp === 1 && !rateOk(sys, `cyc1:${regionOf(world, worst.x, worst.y)}`, day, 8)) return null;
    const cat = st.peak >= 0.25 ? `a category ${catOf(st.peak)} storm` : 'a tropical storm';
    const dc = deathsClause(deaths);
    const others = names.filter((n) => n !== worst.name);
    const rest = others.length ? ` and battered ${listJoin(others.slice(0, 3))}` : '';
    const gone = dmg.filter((d) => d.gone).map((d) => d.name);
    const lead = st.divine ? `Summoned by an unseen hand, the cyclone ${st.name}` : `The cyclone ${st.name}`;
    let text;
    if (gone.length) text = `${lead}, ${cat}, wiped ${listJoin(gone)} from the map${rest}${dc ? ', ' + dc : ''}.`;
    else if (worst.harbor || (worst.coastal && worst.sev > 0.6)) text = pick(world, [
      `${lead} drowned the harbour of ${worst.name}${rest}${dc ? ', ' + dc : ''}.`,
      `${lead}, ${cat}, drove the sea into the streets of ${worst.name}${rest}${dc ? ', ' + dc : ''}.`,
    ]);
    else text = pick(world, [
      `${lead}, ${cat}, tore across ${worst.name}${rest}${dc ? ', ' + dc : ''}.`,
      `${lead} lashed ${listJoin(names.slice(0, 3))} with wind and flood${dc ? ', ' + dc : ''}.`,
      `${lead} made ${st.landfalls > 1 ? `${numberWord(st.landfalls)} landfalls` : 'landfall'} and fell hardest on ${worst.name}${rest}${dc ? ', ' + dc : ''}.`,
    ]);
    return chronicle(world, { cat: st.divine ? 'divine' : 'disaster', imp, text, x: worst.x, y: worst.y, sid: worst.sid, key: st.divine ? 'divine.storm' : 'storm.cyclone', ref, tags: [`category-${catOf(st.peak)}`] });
  } else if (st.kind === 'blizzard') {
    const worst = dmg.slice().sort((a, b) => b.pop - a.pop)[0];
    if (!worst || worst.pop < 1500 || st.peak < 0.65) return null;
    if (!rateOk(sys, `bliz:${regionOf(world, worst.x, worst.y)}`, day, 12)) return null;
    const dc = deathsClause(deaths);
    return chronicle(world, { cat: 'disaster', imp: deaths >= 100 ? 2 : 1, x: worst.x, y: worst.y, sid: worst.sid, key: 'storm.blizzard', ref, text: pick(world, [
      `A great blizzard buried ${worst.name} in snow to the eaves${dc ? ', ' + dc : ''}, and the herds froze in their pens.`,
      `For ${Math.max(2, Math.round(st.age))} days a howling blizzard cut ${listJoin(dmg.slice(0, 3).map((d) => d.name))} off from the world${dc ? ', ' + dc : ''}.`,
    ]) });
  } else if (st.kind === 'sandstorm') {
    const worst = dmg.slice().sort((a, b) => b.pop - a.pop)[0];
    if (!worst || worst.pop < 2000 || st.peak < 0.75) return null;
    if (!rateOk(sys, `sand:${worst.sid}`, day, 25)) return null;
    const fa = featureAt(world, st.origin.x, st.origin.y);
    const src = fa && fa.ft.kind === 'desert' ? withArticle(fa.ft.name) : 'the desert';
    return chronicle(world, { cat: 'disaster', imp: 1, x: worst.x, y: worst.y, sid: worst.sid, key: 'storm.sandstorm', ref, text: pick(world, [
      `A great sandstorm boiled out of ${src} and buried the fields of ${worst.name} under a hand's depth of sand.`,
      `Red dust from ${src} turned noon to dusk over ${worst.name} for ${Math.max(2, Math.round(st.age))} days.`,
    ]) });
  }
  return null;
}

export { catOf };
