// Climate (order 10): the planet's thermostat.
//   monthly  global offset = baseTemperature + drift + orbital + greenhouse − aerosol + ice albedo;
//            regional anomaly field (AR(1)), global means, ice volume, dynamic sea level
//            (→ recomputeWater, drowned coasts and land bridges), Year Without Summer
//   daily    row stripes (land every 5 days, water every 20): tile temperature with
//            hemisphere-aware seasons scaled by axial tilt and continentality; snow pack,
//            lake and sea ice; meltwater
//   yearly   annual means (annTemp, annRain), glaciers, classifyBiomes with chronicled
//            biome shifts, ice-age / warm-age state, heat and cold records, greenhouse milestones

import { WATER, BIOME, DAYS_PER_YEAR, MONTHS_PER_YEAR } from '../core/constants.js';
import { ensureField, latitude, monthOf, isMonthStart, isYearStart } from '../core/world.js';
import { liveSettlements } from '../core/entities.js';
import { chronicle } from '../core/chronicle.js';
import { on } from '../core/hooks.js';
import { ss, fin, clampR, rateOk, rateprune, cap, pick, fmtArea, listJoin, yearNum, profStart, profEnd, primeCache } from './nature/common.js';
import { ANOM_CELL, coarseDims, upsampleField, regionDims, regionOf, regionCentre, tileRuns } from './nature/grid.js';
import { tiltFactor, seasonPhase, ampCache } from './nature/climateModel.js';
import { recomputeWaterSafe, classifyBiomesSafe, hasHydrology } from './nature/external.js';
import { annualRain } from './nature/moisture.js';
import { regionName, featureAt, withArticle } from './nature/places.js';

const ID = 'climate';
const K = 5;                 // land temperature stripe: each row every 5 days
const KW = 20;               // water temperature stripe: seas warm and cool slowly
const K_ICE = 0.10;          // sea-level drop per unit of ice-sheet land fraction
const SEA_STEP = 0.01;       // max sea-level change per month (gradual flooding)
const GLACIER_GROW = 0.03;   // yearly approach of glaciers toward equilibrium (~30-year ice sheets)
const GLACIER_MELT = 0.05;
const SEA_RECOMPUTE = 0.003; // recompute hydrology past this drift
const SEA_LAG = 200;         // years: the oceans follow the ice sheets' mass slowly (no metre-a-decade swings from weather noise)
const SPIN_YEARS = 2;        // seasonal cycles run at genesis so snow pack and sea ice start in equilibrium
const FOREST = new Set([BIOME.TAIGA, BIOME.TEMPERATE_FOREST, BIOME.TEMPERATE_RAINFOREST, BIOME.TROPICAL_FOREST, BIOME.RAINFOREST]);
const DESERT = new Set([BIOME.HOT_DESERT, BIOME.COLD_DESERT]);
const IS_FOREST = new Uint8Array(32), IS_DESERT = new Uint8Array(32);
for (const b of FOREST) IS_FOREST[b] = 1;
for (const b of DESERT) IS_DESERT[b] = 1;
const LAND = WATER.LAND, OCEAN = WATER.OCEAN;

export const system = { id: ID, order: 10, init, update };

// Hydrology recompute changes distCoast → amplitude cache rebuilds lazily by version.
on('waterChanged', (world) => { if (world.cache) world.cache.natPrevBiome = null; });

// ---------------------------------------------------------------------------
// Init

function init(world) {
  primeCache(world);
  const { W, H, N } = world;
  ensureField(world, 'glacier', Float32Array, N);
  ensureField(world, 'tAcc', Float32Array, N);
  ensureField(world, 'climAnom', Float32Array, coarseDims(W, H, ANOM_CELL).cn);
  sanitize(world);
  if (!world.sys[ID]) seed(world);
  const sys = world.sys[ID];
  if (!Array.isArray(sys.accL) || sys.accL.length !== H) sys.accL = new Array(H).fill(0);
  if (!Array.isArray(sys.accW) || sys.accW.length !== H) sys.accW = new Array(H).fill(0);
  if (!Array.isArray(sys.mLand)) sys.mLand = [];
  if (!Array.isArray(sys.mAll)) sys.mAll = [];
  // Per-row snow / sea-ice tallies from the stripe (saved, so a reload continues exactly).
  if (!Array.isArray(sys.rowSnow) || sys.rowSnow.length !== H) sys.rowSnow = new Array(H).fill(0);
  if (!Array.isArray(sys.rowIce) || sys.rowIce.length !== H) sys.rowIce = new Array(H).fill(0);
  ampCache(world);
  refreshAnomTile(world);
  // The global offset is a monthly quantity: recompute only if a save predates it.
  if (!Number.isFinite(world.climate.orbital)) computeOffset(world, false);
}

function sanitize(world) {
  const c = world.climate;
  const defs = { seaLevel: 0.5, baseSeaLevel: 0.5, appliedSeaLevel: 0.5, tempOffset: 0, drift: 0, aerosol: 0, co2: 280, iceVolume: 0, iceBaseline: 0, avgTemp: 0, avgLandTemp: 0, droughtIndex: 0 };
  for (const [k, d] of Object.entries(defs)) c[k] = fin(c[k], d);
  c.iceSea = fin(c.iceSea, c.iceVolume);
  c.aerosol = clampR(c.aerosol, 0, 1);
  c.co2 = clampR(c.co2, 100, 20000);
}

function seed(world) {
  const { N, f } = world;
  const rng = world.rng;
  const c = world.climate;
  let land = 0, tSum = 0;
  { const water = f.water, annT = f.annTemp; for (let i = 0; i < N; i++) if (water[i] === WATER.LAND) { land++; tSum += annT[i]; } }
  // Orbital cycles: start near the mean of the main cycle, heading up or down.
  const sys = world.sys[ID] = {
    orb: {
      // Both cycles start at their mean (no anomaly at genesis), heading up or down.
      p1: rng.float(2600, 4400), ph1: rng.chance(0.5) ? 0 : Math.PI,
      p2: rng.float(900, 1500), ph2: rng.chance(0.5) ? 0 : Math.PI,
    },
    landTiles0: Math.max(1, land),
    genesis: { landTemp: land ? tSum / land : 0, day: world.time.day },
    accL: new Array(world.H).fill(0), accW: new Array(world.H).fill(0),
    rowSnow: new Array(world.H).fill(0), rowIce: new Array(world.H).fill(0),
    mLand: [], mAll: [],
    state: 'normal', stateSince: world.time.day,
    records: { hi: null, lo: null },
    flags: {},
    biomeNet: null,
    seaAcc: { lost: 0, gained: 0, drowned: [], since: world.time.day, cause: '' },
    offsetAtApply: world.params.seaLevelOffset,
    rl: {},
  };
  // Glaciers start in equilibrium with the genesis climate.
  const g = world.f.glacier, water = f.water, snow = f.snow, annT = f.annTemp, annR = f.annRain, elev = f.elevation;
  for (let i = 0; i < N; i++) {
    g[i] = water[i] === WATER.LAND ? glacierTarget(annT[i], annR[i], elev[i]) : 0;
    if (g[i] > snow[i]) snow[i] = g[i];
  }
  c.iceVolume = iceVolumeOf(world);
  c.iceBaseline = c.iceVolume;
  c.iceSea = c.iceVolume;
  c.drift = 0;
  computeOffset(world, false);
  // Spin the seasonal snow pack and sea ice up to the genesis climate (the generator only
  // paints perennial snow): without it the first winters look like an advance of the ice.
  const day0 = world.time.day;
  for (let d = 0; d < SPIN_YEARS * DAYS_PER_YEAR; d++) { world.time.day = day0 + d; stripe(world, day0 + d, false); }
  world.time.day = day0;
  // One full pass so day-0 temperatures already carry the season.
  stripe(world, 0, false, true);
  sys.accL.fill(0); sys.accW.fill(0);
  world.f.tAcc.fill(0);
  sys.genesis.temp = meanOf(world, f.annTemp, false);
}

/** Equilibrium glacier cover for an annual climate: ice sheets below −3.5 °C, alpine ice on high peaks. */
function glacierTarget(t, r, e) {
  const g = Math.min(1, Math.max(0, (-3.5 - t) * (1 / 7))) * ss(0.02, 0.12, r);
  const alp = ss(0.84, 0.95, e) * Math.min(1, Math.max(0, (1.5 - t) * 0.125)) * ss(0.03, 0.15, r);
  return Math.max(g, alp);
}

function iceVolumeOf(world) {
  const { N, f } = world;
  const g = f.glacier, water = f.water;
  let s = 0;
  for (let i = 0; i < N; i++) if (water[i] === WATER.LAND) s += g[i];
  return s / Math.max(1, world.sys[ID]?.landTiles0 || 1);
}

function meanOf(world, arr, all) {
  const { N, f } = world;
  const water = f.water;
  let s = 0, n = 0;
  for (let i = 0; i < N; i++) if (all || water[i] === WATER.LAND) { s += arr[i]; n++; }
  return n ? s / n : 0;
}

// ---------------------------------------------------------------------------
// Update

function update(world) {
  const day = world.time.day;
  let t = profStart(world);
  if (isYearStart(world) && day > 0) yearly(world);
  profEnd(world, 'clim.yearly', t); t = profStart(world);
  if (isMonthStart(world)) monthly(world);
  profEnd(world, 'clim.monthly', t); t = profStart(world);
  stripe(world, day, true);
  profEnd(world, 'clim.stripe', t);
}

/**
 * Daily stripe: land rows y ≡ day (mod K) and water rows y ≡ day (mod KW) get today's
 * temperature (seasonal, hemisphere-aware, plus regional anomaly), its annual-mean sample,
 * and their snow pack / lake and sea ice. Pass `all` to refresh every row at once.
 */
function stripe(world, day, accumulate, all = false) {
  const { H, f } = world;
  const sys = world.sys[ID];
  const c = world.climate;
  const ph = seasonPhase(world);
  const tf = tiltFactor(world);
  const dim = 1 - 0.45 * Math.min(1, Math.max(0, c.aerosol));
  const off = fin(c.tempOffset, 0);
  const ac = ampCache(world);
  const anom = world.cache.natAnomTile || ZERO(world);
  const rs = rowStats(world);
  const lr = tileRuns(world, 'land'), wr = tileRuns(world, 'water');
  landKernel(lr.runs, lr.rowStart, all ? 0 : day % K, all ? 1 : K, H, accumulate, sys.accL, ph.sL, ph.sW, tf, dim, off,
    K / DAYS_PER_YEAR, f.baseTemp, ac.amp, ac.mar, anom, f.temp, f.tAcc, f.snow, f.rain, f.glacier, f.soilWater, rs.tl, sys.rowSnow);
  waterKernel(wr.runs, wr.rowStart, all ? 0 : day % KW, all ? 1 : KW, H, accumulate, sys.accW, ph.sL, ph.sW, tf, dim, off,
    KW / DAYS_PER_YEAR, f.baseTemp, ac.amp, ac.mar, anom, f.temp, f.tAcc, f.snow, f.water, rs.tw, sys.rowIce);
  if (!accumulate) f.tAcc.fill(0);
}

/** Land rows y ≡ y0 (mod K): temperature, annual-mean sample, snow pack and meltwater. */
function landKernel(R, st, y0, K, H, accumulate, accL, phL, phW, tf, dim, off, dtY, base, amp, mar, anom, temp, tAcc, snow, rain, glacier, soilW, rsTl, rsSnow) {
  const fallK = 16 * dtY, meltK = 2.6 * dtY, meltR = 4 * dtY;
  for (let y = y0; y < H; y += K) {
    const hm = Math.min(1, Math.max(-1, (1 - (2 * (y + 0.5)) / H) * 8));
    let sL = hm * phL * tf, sW = hm * phW * tf;
    if (sL > 0) sL *= dim;
    if (sW > 0) sW *= dim;
    const sD = sW - sL;
    if (accumulate) accL[y]++;
    let sumT = 0, snowL = 0;
    for (let q = st[y]; q < st[y + 1]; q++) {
      const b = R[2 * q + 1];
      for (let i = R[2 * q]; i < b; i++) {
        const t = base[i] + off + amp[i] * (sL + sD * mar[i]) + anom[i];
        temp[i] = t;
        tAcc[i] += t;
        sumT += Math.fround(t);   // the stored value, as rowStats() sums it after a reload
        const sn = snow[i];
        if (sn > 0 || t < 1.6) {
          // Snow pack (never below the glacier beneath it).
          const gl = glacier[i];
          const r = rain[i];
          const cold = Math.min(1, Math.max(0, (1.5 - t) * 0.25));
          const ns = Math.min(1, Math.max(gl, sn + r * fallK * cold * cold * (3 - 2 * cold) - Math.max(0, t) * (meltK + meltR * r)));
          const m = sn - ns;
          if (m > 0) soilW[i] = Math.min(1, soilW[i] + 0.35 * m);
          snow[i] = ns;
          if (ns > 0.3) snowL++;
        }
      }
    }
    rsTl[y] = sumT; rsSnow[y] = snowL;
  }
}

/** Water rows y ≡ y0 (mod K): sea and lake temperature, lake ice and sea ice. */
function waterKernel(R, st, y0, K, H, accumulate, accW, phL, phW, tf, dim, off, dtY, base, amp, mar, anom, temp, tAcc, snow, water, rsTw, rsIce) {
  const iceK = 0.7 * dtY, thawK = 1.6 * dtY;
  for (let y = y0; y < H; y += K) {
    const hm = Math.min(1, Math.max(-1, (1 - (2 * (y + 0.5)) / H) * 8));
    let sL = hm * phL * tf, sW = hm * phW * tf;
    if (sL > 0) sL *= dim;
    if (sW > 0) sW *= dim;
    const sD = sW - sL;
    if (accumulate) accW[y]++;
    let sumT = 0, seaIce = 0;
    for (let q = st[y]; q < st[y + 1]; q++) {
      const b = R[2 * q + 1];
      for (let i = R[2 * q]; i < b; i++) {
        const t = base[i] + off + amp[i] * (sL + sD * mar[i]) + anom[i];
        temp[i] = t;
        tAcc[i] += t;
        sumT += Math.fround(t);   // the stored value, as rowStats() sums it after a reload
        const sn = snow[i];
        if (sn > 0 || t < 0.2) {
          const ocean = water[i] === OCEAN;
          const thr = ocean ? -1.8 : 0;
          const ns = Math.min(1, Math.max(0, sn + iceK * Math.max(0, thr - t) - thawK * Math.max(0, t - thr)));
          snow[i] = ns;
          if (ns > 0.5 && ocean) seaIce++;
        }
      }
    }
    rsTw[y] = sumT; rsIce[y] = seaIce;
  }
}

/**
 * Per-row running sums written by the stripe (each row refreshed every K or 2K days).
 * Rebuilt from the temperature field when the coastline or the terrain changes: terrain
 * edits shift tile temperatures (lapse rate) between stripes, and a reloaded world sums them.
 */
function rowStats(world) {
  const v = world.versions.water * 1e6 + world.versions.terrain;
  let r = world.cache.natClimRows;
  if (r && r.v === v && r.H === world.H) return r;
  const { W, H, f } = world;
  r = world.cache.natClimRows = { v, H, tl: new Float64Array(H), tw: new Float64Array(H), nl: new Float64Array(H), no: new Float64Array(H) };
  const water = f.water, temp = f.temp;
  for (let y = 0; y < H; y++) {
    let nl = 0, no = 0, tl = 0, tw = 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, w = water[i];
      if (w === LAND) { nl++; tl += temp[i]; } else { tw += temp[i]; if (w === OCEAN) no++; }
    }
    r.nl[y] = nl; r.no[y] = no; r.tl[y] = tl; r.tw[y] = tw;
  }
  return r;
}

/** A shared all-zero tile array for when the anomaly field has not been built yet. */
function ZERO(world) {
  let z = world.cache.natZero;
  if (!z || z.length !== world.N) z = world.cache.natZero = new Float32Array(world.N);
  return z;
}

// ---------------------------------------------------------------------------
// Monthly

function computeOffset(world, advance) {
  const c = world.climate, p = world.params, sys = world.sys[ID];
  const vol = clampR(fin(p.climateVolatility, 0.3), 0, 1);
  if (advance) {
    const theta = 1 / (12 * 40);
    const sigma = 1.6 * vol * Math.sqrt(2 * theta);
    c.drift = clampR(c.drift * (1 - theta) + (sigma > 0 ? world.rng.normal(0, sigma) : 0), -8, 8);
    c.co2 = clampR(280 + (fin(c.co2, 280) - 280) * Math.exp(-1 / (12 * 150)), 100, 20000);
    c.aerosol = c.aerosol * Math.exp(-1 / 15);
    if (c.aerosol < 0.002) c.aerosol = 0;
  }
  const tY = world.time.day / DAYS_PER_YEAR;
  const o = sys.orb;
  const orbital = 3.0 * vol * (0.7 * Math.sin((2 * Math.PI * tY) / o.p1 + o.ph1) + 0.3 * Math.sin((2 * Math.PI * tY) / o.p2 + o.ph2));
  const greenhouse = clampR(3 * Math.log2(Math.max(100, c.co2) / 280), -4, 15);
  const cooling = 4 * Math.min(1, c.aerosol);
  const albedo = clampR(-6 * (c.iceVolume - c.iceBaseline), -2.5, 2.5);
  c.orbital = orbital; c.greenhouse = greenhouse; c.aerosolCooling = cooling; c.albedo = albedo;
  c.tempOffset = clampR(fin(p.baseTemperature, 0) + c.drift + orbital + greenhouse - cooling + albedo, -40, 40);
}

function monthly(world) {
  sanitize(world);
  const sys = world.sys[ID];
  computeOffset(world, true);
  stepAnomaly(world);
  refreshAnomTile(world);
  monthlyStats(world);
  seaLevel(world);
  yearWithoutSummer(world);
}

/** Regional temperature anomalies: spatially smooth AR(1) noise on an 8-tile grid. */
function stepAnomaly(world) {
  const { cw, ch, cn } = coarseDims(world.W, world.H, ANOM_CELL);
  const a = world.f.climAnom;
  const vol = clampR(fin(world.params.climateVolatility, 0.3), 0, 1);
  const sd = 0.5 + 1.4 * vol;
  const rho = Math.exp(-1 / 30);
  const innov = sd * Math.sqrt(1 - rho * rho);
  let n = world.cache.natAnomNoise;
  if (!n || n.length !== cn) n = world.cache.natAnomNoise = new Float32Array(cn);
  let b = world.cache.natAnomBlur;
  if (!b || b.length !== cn) b = world.cache.natAnomBlur = new Float32Array(cn);
  for (let k = 0; k < cn; k++) n[k] = world.rng.normal(0, 1);
  // 3×3 binomial blur, renormalised to unit variance (Σw² = 0.1406 → sd 0.375).
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = Math.min(ch - 1, Math.max(0, y + dy)), wy = dy === 0 ? 2 : 1;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(cw - 1, Math.max(0, x + dx)), wx = dx === 0 ? 2 : 1;
        s += n[yy * cw + xx] * wx * wy;
      }
    }
    b[y * cw + x] = s / 16 / 0.375;
  }
  for (let k = 0; k < cn; k++) a[k] = clampR(fin(a[k]) * rho + innov * b[k], -6, 6);
}

function refreshAnomTile(world) {
  let t = world.cache.natAnomTile;
  if (!t || t.length !== world.N) t = world.cache.natAnomTile = new Float32Array(world.N);
  upsampleField(world, ANOM_CELL, world.f.climAnom, t, -8, 8);
}

function monthlyStats(world) {
  const c = world.climate, sys = world.sys[ID];
  const r = rowStats(world);
  let sAll = 0, sLand = 0, nLand = 0, seaIce = 0, nOcean = 0, snowLand = 0;
  for (let y = 0; y < world.H; y++) {
    sAll += r.tl[y] + r.tw[y]; sLand += r.tl[y]; nLand += r.nl[y]; seaIce += fin(sys.rowIce[y]); nOcean += r.no[y]; snowLand += fin(sys.rowSnow[y]);
  }
  const allNow = sAll / Math.max(1, world.N), landNow = nLand ? sLand / nLand : allNow;
  c.avgTempNow = allNow; c.avgLandTempNow = landNow;
  sys.mAll.push(allNow); sys.mLand.push(landNow);
  if (sys.mAll.length > MONTHS_PER_YEAR) sys.mAll.shift();
  if (sys.mLand.length > MONTHS_PER_YEAR) sys.mLand.shift();
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  // Until a full year is sampled, report the genesis normals rather than a seasonal snapshot.
  if (sys.mLand.length >= MONTHS_PER_YEAR) { c.avgTemp = mean(sys.mAll); c.avgLandTemp = mean(sys.mLand); }
  else { c.avgTemp = fin(sys.genesis.temp, allNow); c.avgLandTemp = fin(sys.genesis.landTemp, landNow); }
  // Ice volume: glaciers change yearly (and with the coastline), so recount only when stale.
  const iv = world.cache.natIceV;
  if (!iv || iv.wv !== world.versions.water || iv.day !== sys.glacierDay) {
    c.iceVolume = iceVolumeOf(world);
    world.cache.natIceV = { wv: world.versions.water, day: sys.glacierDay };
  }
  c.seaIce = nOcean ? seaIce / nOcean : 0;
  c.snowCover = nLand ? snowLand / nLand : 0;
}

// ---------------------------------------------------------------------------
// Sea level

function seaLevel(world) {
  const c = world.climate, p = world.params;
  const dyn = Boolean(p.dynamicSeaLevel);
  // the ocean volume answers the ice sheets' mass with a lag of centuries (monthly step)
  c.iceSea = fin(c.iceSea, c.iceVolume) + (c.iceVolume - fin(c.iceSea, c.iceVolume)) * (1 - Math.exp(-1 / (MONTHS_PER_YEAR * SEA_LAG)));
  let target = c.baseSeaLevel + fin(p.seaLevelOffset, 0) - (dyn ? K_ICE * (c.iceSea - c.iceBaseline) : 0);
  target = clampR(target, 0.3, 0.7);
  c.seaLevel = clampR(c.seaLevel + clampR(target - c.seaLevel, -SEA_STEP, SEA_STEP), 0.3, 0.7);
  if (Math.abs(c.seaLevel - c.appliedSeaLevel) > SEA_RECOMPUTE && hasHydrology()) applySeaLevel(world);
}

/** Big landmasses: id → representative interior tile. */
function bigLandmasses(world) {
  const { N, f } = world;
  const landmass = f.landmass, water = f.water, distCoast = f.distCoast;
  const size = new Map(), rep = new Map(), best = new Map();
  let land = 0;
  for (let i = 0; i < N; i++) {
    const lm = landmass[i];
    if (lm < 0 || water[i] !== WATER.LAND) continue;
    land++;
    size.set(lm, (size.get(lm) || 0) + 1);
    const d = distCoast[i];
    if (!best.has(lm) || d > best.get(lm)) { best.set(lm, d); rep.set(lm, i); }
  }
  const thr = Math.max(60, land * 0.015);
  const out = [];
  for (const [lm, n] of size) if (n >= thr) out.push({ lm, i: rep.get(lm), n });
  return { list: out, land };
}

function landName(world, i) {
  const x = i % world.W, y = (i / world.W) | 0;
  const fa = featureAt(world, x, y);
  if (fa && (fa.ft.kind === 'continent' || fa.ft.kind === 'island')) return withArticle(fa.ft.name);
  return regionName(world, x, y, { settleDist: 14 });
}

function applySeaLevel(world) {
  const { N, f } = world;
  const c = world.climate, sys = world.sys[ID], p = world.params;
  const rising = c.seaLevel > c.appliedSeaLevel;
  const before = bigLandmasses(world);
  const lmBefore = Int32Array.from(f.landmass);
  const atRisk = liveSettlements(world).filter((s) => f.elevation[s.i] < Math.max(c.seaLevel, c.appliedSeaLevel) + 0.004).map((s) => s.id);
  const old = c.appliedSeaLevel;
  c.appliedSeaLevel = c.seaLevel;
  if (!recomputeWaterSafe(world)) { c.appliedSeaLevel = old; return; }
  classifyBiomesSafe(world);
  const after = bigLandmasses(world);
  const delta = after.land - before.land;
  const acc = sys.seaAcc;
  const offsetMoved = Math.abs(fin(p.seaLevelOffset) - fin(sys.offsetAtApply)) > 1e-6;
  sys.offsetAtApply = p.seaLevelOffset;
  acc.cause = offsetMoved ? 'divine' : rising ? 'melt' : 'ice';
  if (delta < 0) acc.lost += -delta; else acc.gained += delta;
  for (const sid of atRisk) {
    const s = world.settlements[sid];
    if (s && (!s.alive || f.water[s.i] !== WATER.LAND) && acc.drowned.length < 12 && !acc.drowned.includes(s.name)) acc.drowned.push(s.name);
  }
  // Land bridges: big landmasses that merged, or split apart (at most two entries per change).
  const day = world.time.day;
  const reps = before.list;
  let told = 0;
  for (let a = 0; a < reps.length && told < 2; a++) for (let b = a + 1; b < reps.length && told < 2; b++) {
    const ia = reps[a].i, ib = reps[b].i;
    if (f.landmass[ia] >= 0 && f.landmass[ia] === f.landmass[ib] && rateOk(sys, `bridge:${Math.min(ia, ib)}:${Math.max(ia, ib)}`, day, 60)) {
      const A = landName(world, ia), B = landName(world, ib);
      if (A === B) continue;
      told++;
      const mx = ((ia % world.W) + (ib % world.W)) / 2, my = (((ia / world.W) | 0) + ((ib / world.W) | 0)) / 2;
      chronicle(world, { cat: 'climate', key: 'climate.landbridge', imp: 3, x: Math.round(mx), y: Math.round(my), text: pick(world, [
        `As the seas fell, the shallows between ${A} and ${B} dried into a land bridge, and beasts and wanderers crossed where boats had once been needed.`,
        `The retreating ocean laid bare a bridge of land joining ${A} to ${B}.`,
      ]) });
    }
  }
  const repsAfter = after.list;
  told = 0;
  for (let a = 0; a < repsAfter.length && told < 2; a++) for (let b = a + 1; b < repsAfter.length && told < 2; b++) {
    const ia = repsAfter[a].i, ib = repsAfter[b].i;
    if (lmBefore[ia] >= 0 && lmBefore[ia] === lmBefore[ib] && rateOk(sys, `split:${Math.min(ia, ib)}:${Math.max(ia, ib)}`, day, 60)) {
      const A = landName(world, ia), B = landName(world, ib);
      if (A === B) continue;
      told++;
      const mx = ((ia % world.W) + (ib % world.W)) / 2, my = (((ia / world.W) | 0) + ((ib / world.W) | 0)) / 2;
      chronicle(world, { cat: 'climate', key: 'climate.strait', imp: 3, x: Math.round(mx), y: Math.round(my), text: pick(world, [
        `The rising sea broke through the land bridge between ${A} and ${B}, and the two lands were parted by water.`,
        `Waves swallowed the last neck of land linking ${A} with ${B}, cutting the old crossing forever.`,
      ]) });
    }
  }
  seaChronicle(world);
}

function seaChronicle(world) {
  const sys = world.sys[ID], acc = sys.seaAcc, day = world.time.day;
  const thr = Math.max(40, sys.landTiles0 * 0.005);
  const big = acc.lost >= thr || acc.gained >= thr || acc.drowned.length > 0;
  if (!big || !rateOk(sys, 'seaChron', day, 15)) return;
  const metres = Math.round(seaMetres(world));
  const lvl = metres === 0 ? 'back to their ancient mark' : `${Math.abs(metres)} m ${metres > 0 ? 'above' : 'below'} their ancient mark`;
  let text;
  if (acc.lost >= acc.gained) {
    const why = acc.cause === 'divine' ? 'At an unseen command the oceans swelled' : acc.cause === 'melt' ? 'As the ice sheets melted the seas rose' : 'The seas rose';
    const towns = acc.drowned.length ? `, swallowing ${listJoin(acc.drowned.slice(0, 4))}` : '';
    text = `${why} to ${lvl} and drowned ${fmtArea(acc.lost)} of coast${towns}.`;
  } else {
    const why = acc.cause === 'divine' ? 'At an unseen command the oceans drew back' : acc.cause === 'ice' ? 'As the glaciers grew the seas withdrew' : 'The seas withdrew';
    text = `${why} to ${lvl}, laying bare ${fmtArea(acc.gained)} of new shore.`;
  }
  chronicle(world, { cat: 'climate', key: 'climate.sealevel', imp: acc.drowned.length >= 2 || Math.max(acc.lost, acc.gained) >= thr * 4 ? 3 : 2, text });
  sys.seaAcc = { lost: 0, gained: 0, drowned: [], since: day, cause: '' };
}

/** Sea level relative to genesis, in metres (ocean-depth scale near the shore). */
export function seaMetres(world) {
  const c = world.climate;
  return ((c.seaLevel - c.baseSeaLevel) / Math.max(1e-6, c.baseSeaLevel)) * 8000 * 0.5 + ((c.seaLevel - c.baseSeaLevel) / Math.max(1e-6, 1 - c.baseSeaLevel)) * 7000 * 0.5;
}

// ---------------------------------------------------------------------------
// Aerosol veil: the Year Without Summer

function yearWithoutSummer(world) {
  const c = world.climate, sys = world.sys[ID];
  if (c.aerosol < 0.06) { sys.flags.yws = false; return; }
  if (sys.flags.yws || c.aerosol < 0.18) return;
  const m = monthOf(world);
  const north = m >= 5 && m <= 7, south = m === 11 || m <= 1;
  if (!north && !south) return;
  sys.flags.yws = true;
  const hemi = north ? 1 : -1;
  const towns = liveSettlements(world).filter((s) => { const la = latitude(world, s.y) * hemi; return la > 0.25 && la < 0.75; }).sort((a, b) => b.population - a.population);
  const src = c.aerosolSource?.name ? c.aerosolSource.name : 'a veil of dust';
  const y = yearNum(world);
  const half = hemi > 0 ? 'north' : 'south';
  const text = towns.length
    ? pick(world, [
      `${cap(src)} veiled the sun; snow fell at midsummer in ${towns[0].name}, the harvests of the ${half} rotted in the fields, and Year ${y} was remembered as the Year Without Summer.`,
      `Under the pall left by ${src} the summer never came: frost blackened the crops around ${listJoin(towns.slice(0, 2).map((s) => s.name))}, and the chroniclers named Year ${y} the Year Without Summer.`,
    ])
    : `${cap(src)} dimmed the sun so deeply that Year ${y} passed without a summer in the ${half}.`;
  chronicle(world, { cat: 'climate', key: 'climate.summerless', imp: 4, text, sid: towns[0]?.id ?? null, x: towns[0]?.x ?? null, y: towns[0]?.y ?? null });
}

// ---------------------------------------------------------------------------
// Yearly

function yearly(world) {
  const { W, H, N, f } = world;
  const sys = world.sys[ID];
  const accL = sys.accL, accW = sys.accW;
  // Annual rainfall from the weather system's coarse accumulator (weather falls back to
  // doing this itself when climate is absent).
  let tp = profStart(world);
  const wx = world.sys.weather;
  if (wx && wx.rainN > 0 && annualRain(world, wx.rainN)) wx.rainN = 0;
  profEnd(world, 'cy.rain', tp); tp = profStart(world);
  const ice = annualKernel(W, H, accL, accW, f.annTemp, f.tAcc, f.glacier, f.water, f.annRain, f.elevation);
  f.tAcc.fill(0);
  accL.fill(0); accW.fill(0);
  world.climate.iceVolume = ice / Math.max(1, sys.landTiles0);
  sys.glacierDay = world.time.day;
  profEnd(world, 'cy.temp', tp); tp = profStart(world);
  reclassify(world);
  profEnd(world, 'cy.biome', tp); tp = profStart(world);
  climateState(world);
  profEnd(world, 'cy.state', tp);
  rateprune(sys, world.time.day, 300);
}

/**
 * Annual means: annTemp moves toward this year's sampled mean; glaciers creep toward the
 * climate's equilibrium (grow slowly, melt a little faster). Returns the total glacier cover.
 */
function annualKernel(W, H, accL, accW, annT, tAcc, g, water, annR, elev) {
  let ice = 0;
  for (let y = 0; y < H; y++) {
    const nL = accL[y], nW = accW[y];
    const invL = nL > 0 ? 1 / nL : 0, invW = nW > 0 ? 1 / nW : 0;
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const land = water[i] === LAND;
      const inv = land ? invL : invW;
      if (inv > 0) annT[i] = Math.min(70, Math.max(-90, annT[i] + (tAcc[i] * inv - annT[i]) * 0.6));
      if (!land) { g[i] = 0; continue; }
      const t = annT[i], e = elev[i], gi = g[i];
      // No ice can form above −3.5 °C below the high peaks: skip the formula.
      if (t >= -3.5 && (e <= 0.84 || t >= 1.5)) {
        if (gi > 0) { const ng = Math.max(0, gi - gi * GLACIER_MELT); g[i] = ng < 1e-4 ? 0 : ng; ice += g[i]; }
        continue;
      }
      const tgt = glacierTarget(t, annR[i], e);
      const ng = Math.min(1, Math.max(0, gi + (tgt - gi) * (tgt > gi ? GLACIER_GROW : GLACIER_MELT)));
      g[i] = ng;
      ice += ng;
    }
  }
  return ice;
}

/** Yearly biome reclassification with net-change bookkeeping per region (flicker cancels out). */
function reclassify(world) {
  const { N, W, f } = world;
  const sys = world.sys[ID];
  let prev = world.cache.natPrevBiome;
  if (!prev || prev.length !== N) prev = world.cache.natPrevBiome = new Uint8Array(N);
  prev.set(f.biome);
  const changed = classifyBiomesSafe(world);
  if (!changed) return;
  const { rn } = regionDims(world);
  let bn = sys.biomeNet;
  if (!bn || !Array.isArray(bn.net) || bn.net.length !== rn * 3) bn = sys.biomeNet = { net: new Array(rn * 3).fill(0), sx: new Array(rn * 3).fill(0), sy: new Array(rn * 3).fill(0), n: new Array(rn * 3).fill(0) };
  const biome = f.biome, water = f.water;
  for (let i = 0; i < N; i++) {
    const a = prev[i], b = biome[i];
    if (a === b || water[i] !== WATER.LAND || a <= BIOME.LAKE) continue;
    const x = i % W, y = (i / W) | 0;
    const r = regionOf(world, x, y);
    for (let k = 0; k < 3; k++) {
      const d = k === 0 ? IS_DESERT[b] - IS_DESERT[a] : k === 1 ? (b === BIOME.ICE ? 1 : 0) - (a === BIOME.ICE ? 1 : 0) : IS_FOREST[b] - IS_FOREST[a];
      if (!d) continue;
      const j = r * 3 + k;
      bn.net[j] += d; bn.sx[j] += x; bn.sy[j] += y; bn.n[j]++;
    }
  }
  const thr = Math.max(30, sys.landTiles0 * 0.004);
  const day = world.time.day;
  for (let j = 0; j < bn.net.length; j++) {
    const v = bn.net[j];
    if (Math.abs(v) < thr) continue;
    const r = (j / 3) | 0, k = j % 3;
    if (!rateOk(sys, `biome:${j}:${v > 0 ? 1 : 0}`, day, 30)) continue;
    const cx = bn.n[j] ? Math.round(bn.sx[j] / bn.n[j]) : regionCentre(world, r).x;
    const cy = bn.n[j] ? Math.round(bn.sy[j] / bn.n[j]) : regionCentre(world, r).y;
    const where = regionName(world, cx, cy, { settleDist: 12 });
    const area = fmtArea(Math.abs(v));
    const y = yearNum(world);
    // The cause the chroniclers give follows the world's temperature trend.
    const dT = fin(world.climate.avgLandTemp) - fin(sys.genesis?.landTemp);
    const trend = dT < -1.2 ? 'cold' : dT > 1.2 ? 'warm' : 'rain';
    let text;
    if (k === 0 && v > 0) text = trend === 'warm' ? pick(world, [
      `Under a hotter sun the desert crept outward across ${where}, claiming ${area} of once-living land.`,
      `The heat of Year ${y} parched ${where} until ${area} of grass and scrub had withered into desert.`,
    ]) : trend === 'cold' ? pick(world, [
      `The cold, dry winds of the ice age scoured ${where}, and ${area} of grassland turned to barren steppe and sand.`,
    ]) : pick(world, [
      `Year after year the rains failed ${where}, and by Year ${y} some ${area} of grass and scrub had withered into desert.`,
      `The desert crept outward across ${where}, claiming ${area} of once-living land.`,
    ]);
    else if (k === 0) text = trend === 'cold' ? pick(world, [
      `With the sun gentler in the colder age, ${area} of the deserts of ${where} quickened into grass and scrub.`,
    ]) : pick(world, [
      `Kinder rains returned to ${where}, and ${area} of desert quickened into grass and scrub.`,
      `The sands of ${where} greened as the rains came back, ${area} of barren ground bursting into life.`,
    ]);
    else if (k === 1 && v > 0) text = pick(world, [
      `The ice sheets advanced over ${where}, burying ${area} of land beneath the glaciers.`,
      `Glaciers ground forward across ${where}, and ${area} of land vanished under the ice.`,
    ]);
    else if (k === 1) text = pick(world, [
      `The glaciers of ${where} retreated, laying bare ${area} of stone and meltwater meadow for the first time in memory.`,
      `As the cold loosened its grip, the ice withdrew from ${area} of ${where}.`,
    ]);
    else if (v > 0) text = trend === 'warm' ? pick(world, [
      `Forests spread across ${area} of ${where} as the climate softened.`,
      `Over a generation of warmer seasons, young forest claimed ${area} of ${where}.`,
    ]) : trend === 'cold' ? pick(world, [
      `Hardy pine and birch marched over ${area} of ${where} as the colder age set in.`,
    ]) : pick(world, [
      `Woodland marched over ${where}, ${area} of open country closing into forest.`,
      `Over a generation of kinder seasons, young forest claimed ${area} of ${where}.`,
    ]);
    else text = trend === 'cold' ? pick(world, [
      `The bitter winters of the ice age killed the forests of ${where}, and ${area} of woodland gave way to tundra and steppe.`,
    ]) : trend === 'warm' ? pick(world, [
      `The forests of ${where} faltered in the heat, and ${area} of woodland gave way to open country.`,
    ]) : pick(world, [
      `The forests of ${where} faltered as the climate turned, and ${area} of woodland gave way to open country.`,
      `Across ${where} the old forests thinned and died back over ${area}.`,
      `Drier decades thinned the woods of ${where}, and ${area} of forest opened into scrub and grass.`,
    ]);
    // Natural decadal swings flip a few dozen tiles back and forth; only big shifts are notable.
    chronicle(world, { cat: 'climate', key: 'climate.biomes', imp: Math.abs(v) >= thr * 3 ? 3 : Math.abs(v) >= thr * 1.6 ? 2 : 1, text, x: cx, y: cy });
    bn.net[j] = 0; bn.sx[j] = 0; bn.sy[j] = 0; bn.n[j] = 0;
  }
}

/** Ice ages, warm ages, records and greenhouse milestones. */
function climateState(world) {
  const c = world.climate, sys = world.sys[ID], day = world.time.day;
  const y = yearNum(world);
  const anomL = c.avgLandTemp - sys.genesis.landTemp;
  const dIce = c.iceVolume - c.iceBaseline;
  const yearsIn = (day - sys.stateSince) / DAYS_PER_YEAR;
  if (yearsIn >= 25) {
    if (sys.state === 'normal' && anomL < -2.0 && dIce > 0.01) {
      sys.state = 'ice'; sys.stateSince = day;
      chronicle(world, { cat: 'climate', key: 'climate.iceage', imp: 4, text: pick(world, [
        `The long winters of Year ${y} deepened into an ice age: glaciers crept down from the poles and the world grew ${Math.abs(anomL).toFixed(1)} °C colder than in the age of genesis.`,
        `An ice age gripped the world in Year ${y}; snow lingered into summer and the great ice sheets began to advance.`,
      ]) });
    } else if (sys.state === 'ice' && anomL > -1.0) {
      sys.state = 'normal'; sys.stateSince = day;
      chronicle(world, { cat: 'climate', key: 'climate.iceage.end', imp: 4, text: pick(world, [
        `The ice age ended in Year ${y}; the glaciers drew back toward the poles and meltwater rivers ran full across the thawing lands.`,
        `Warmth returned to the world in Year ${y}, and the great ice sheets began their slow retreat.`,
      ]) });
    } else if (sys.state === 'normal' && anomL > 2.0) {
      sys.state = 'warm'; sys.stateSince = day;
      const why = c.greenhouse > 1 ? 'as smoke from countless furnaces thickened the air' : 'as the sun seemed to burn hotter year by year';
      chronicle(world, { cat: 'climate', key: 'climate.warm', imp: 3, text: `A warm age began in Year ${y} ${why}; the world was ${anomL.toFixed(1)} °C hotter than in the age of genesis.` });
    } else if (sys.state === 'warm' && anomL < 1.0) {
      sys.state = 'normal'; sys.stateSince = day;
      chronicle(world, { cat: 'climate', key: 'climate.warm.end', imp: 2, text: `The warm age waned in Year ${y}, and the seasons settled back toward their ancient measure.` });
    }
  }
  // Records (after a generation of record-keeping).
  if ((day - sys.genesis.day) / DAYS_PER_YEAR >= 30) {
    const rec = sys.records;
    const v = c.avgLandTemp;
    if (rec.hi == null || v > rec.hi + 0.1) {
      const old = rec.hi;
      rec.hi = v;
      if (old != null && anomL > 0.8 && rateOk(sys, 'recordHi', day, 25)) {
        chronicle(world, { cat: 'climate', key: 'climate.record.heat', imp: 2, text: pick(world, [
          `Year ${y} was the hottest in living memory; rivers shrank in their beds and the old folk swore the sun had come nearer.`,
          `Heat without precedent baked the lands in Year ${y}, the warmest year the chroniclers had ever recorded.`,
        ]) });
      }
    }
    if (rec.lo == null || v < rec.lo - 0.1) {
      const old = rec.lo;
      rec.lo = v;
      if (old != null && anomL < -0.8 && rateOk(sys, 'recordLo', day, 25)) {
        const veil = c.aerosol > 0.08 && c.aerosolSource?.name ? ` beneath the veil cast by ${c.aerosolSource.name}` : '';
        chronicle(world, { cat: 'climate', key: 'climate.record.cold', imp: 2, text: `Year ${y} was the coldest the chroniclers had ever recorded${veil}; ice formed on the wells and the herds starved in the snow.` });
      }
    }
  } else if (sys.records.hi == null) {
    sys.records.hi = c.avgLandTemp; sys.records.lo = c.avgLandTemp;
  }
  // Greenhouse milestones.
  const gh = c.greenhouse || 0;
  const fl = sys.flags;
  if (gh >= 1 && !fl.gh1) {
    fl.gh1 = true;
    chronicle(world, { cat: 'climate', key: 'climate.greenhouse', imp: 3, text: `By Year ${y} the smoke of furnaces had thickened the air to ${Math.round(c.co2)} parts in a million, and the world had grown a full degree warmer for it.` });
  }
  if (gh >= 2.5 && !fl.gh2) {
    fl.gh2 = true;
    chronicle(world, { cat: 'climate', key: 'climate.greenhouse', imp: 4, text: `The burning of coal and oil had warmed the world by ${gh.toFixed(1)} °C by Year ${y}; glaciers wept, and the seas began to climb.` });
  }
  if (gh >= 5 && !fl.gh3) {
    fl.gh3 = true;
    chronicle(world, { cat: 'climate', key: 'climate.greenhouse', imp: 5, text: `By Year ${y} the choked sky had made a hothouse of the world, ${gh.toFixed(1)} °C warmer than the age of genesis.` });
  }
}
