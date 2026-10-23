// Weather (order 15): the water cycle and the sky.
//   every 2 days   coarse moisture step (evaporation, advection along the winds and travelling
//                  lows, condensation, orographic rain and rain shadows; see nature/moisture.js)
//   daily          half of the tile bands get fresh cloud, humidity and land rain (so every
//                  tile is refreshed every 2 days); soil-water stripe (K = 12); named storms
//                  (nature/storms.js)
//   monthly        land-surface means for evaporation, regional rain anomalies, drought
//                  tracking, rain over water (display)
// God tools: rain, drought, storm, lightning, blizzard (each with a pure preview from
// nature/previews.js and its own effect: raincall, parch, swirl, lightning), and the hidden
// steer_storm act behind dragging a storm (st.push, with a forecast of its new course).

import { WATER, BIOME, BIOMES, DAYS_PER_YEAR } from '../core/constants.js';
import { isMonthStart, isYearStart, monthOf, emitFx } from '../core/world.js';
import { chronicle } from '../core/chronicle.js';
import { registerTool } from '../core/tools.js';
import { on } from '../core/hooks.js';
import { fin, clampR, rateOk, rateprune, pick, listJoin, yearNum, forDisc, cap, profStart, profEnd, primeCache } from './nature/common.js';
import { WX_CELL, REGION, coarseDims, regionDims, regionOf, regionCentre, tileRuns } from './nature/grid.js';
import { ensureWxFields, wxStatics, refreshDyn, stepAnomaly, step, spinUp, upBands, sampleRain, annualRain, calibrateYear, CAL_YEARS } from './nature/moisture.js';
import { soilEquilibrium, SOIL_CAP } from './nature/climateModel.js';
import { updateStorms, spawnStorm, stormNameList, forecastTrack } from './nature/storms.js';
import { rainPreview, droughtPreview, stormPreview, lightningPreview, blizzardPreview, steerPreview, steerPush, forecastTowns } from './nature/previews.js';
import { regionName, placePhrase, biggestNear } from './nature/places.js';
import { ignite } from './ecology.js';

const ID = 'weather';
const K_SOIL = 12;

export const system = { id: ID, order: 15, init, update };

// Coastline or terrain edits: the coarse geography is rebuilt on next use (the month's
// dynamic state carries over) and the land-surface means are refreshed right away. The
// refresh request is saved state (world.pending), so a world saved in between still runs it.
on('waterChanged', (world) => { if (world.cache) world.cache.natStormCand = null; (world.pending ||= {}).wxDirty = true; });
on('terrainChanged', (world) => { (world.pending ||= {}).wxDirty = true; });

// ---------------------------------------------------------------------------
// Init

function init(world) {
  primeCache(world);
  ensureWxFields(world);
  // geography built while waking does not write the saved relief (see moisture.js writeRelief)
  world.cache.natWxInit = true;
  try { initWx(world); } finally { world.cache.natWxInit = false; }
}

function initWx(world) {
  const fresh = !world.sys[ID];
  if (fresh) {
    world.sys[ID] = {
      lows: [], rainN: 0, names: stormNameList(world), nameIdx: 0,
      reg: null, counts: {}, rl: {}, stroke: null, fxToday: 0, calYears: 0, calSteps: 0,
    };
  }
  const sys = world.sys[ID];
  if (!Array.isArray(sys.lows)) sys.lows = [];
  sys.counts ||= {};
  // Global temperature offset the rain climatology is fitted at (see moisture.step).
  if (!Number.isFinite(sys.offRef)) sys.offRef = fin(world.climate.tempOffset, 0);
  const wxs = wxStatics(world);
  // the coarse relief in use is saved (wxE) so a reload rebuilds the same geography
  if (!sys.wxESaved && world.f.wxE && world.f.wxE.length === wxs.cn) { world.f.wxE.set(wxs.e); sys.wxESaved = true; }
  // Land-surface means are monthly state (saved in wxSurf); compute them only when absent.
  if (fresh || !world.f.wxSurf.some((v) => v > 0)) refreshDyn(world, Boolean(world.sys.ecology), true);
  stepAnomaly(world, false);
  if (fresh) {
    const st = spinUp(world, sys.lows);
    sys.corrStats = st;
    initSoil(world);
    upBands(world, 0, 1);
    upBands(world, 0, 1, true);
    world.f.wxAcc.fill(0);
    sys.rainN = 0;
  }
  if (!Number.isFinite(sys.rainN)) sys.rainN = 0;
  ensureRegions(world);
}

/** Soil water starts at equilibrium with the genesis climate, so vegetation does not lurch. */
function initSoil(world) {
  const { N, f } = world;
  const eco = Boolean(world.sys.ecology);
  for (let i = 0; i < N; i++) {
    if (f.water[i] !== WATER.LAND) { f.soilWater[i] = 1; continue; }
    const veg = eco ? f.veg[i] : (BIOMES[f.biome[i]]?.vegMax || 0) * 0.8;
    f.soilWater[i] = soilEquilibrium(fin(f.annRain[i], fin(f.baseMoisture[i])), fin(f.annTemp[i]), veg);
  }
}

function ensureRegions(world) {
  const sys = world.sys[ID];
  const { rn } = regionDims(world);
  const r = sys.reg;
  if (r && Array.isArray(r.lvl) && r.lvl.length === rn && Array.isArray(r.clim) && r.clim.length === rn * 12) return;
  sys.reg = {
    clim: new Array(rn * 12).fill(-1), lvl: new Array(rn).fill(0), wet: new Array(rn).fill(0),
    months: new Array(rn).fill(0), calm: new Array(rn).fill(0), active: new Array(rn).fill(0), great: new Array(rn).fill(0),
    start: new Array(rn).fill(0), peak: new Array(rn).fill(0), land: new Array(rn).fill(0), cur: new Array(rn).fill(0),
    seen: 0,
  };
}

// ---------------------------------------------------------------------------
// Update

function update(world) {
  const day = world.time.day;
  const sys = world.sys[ID];
  const f = world.f;
  let t = profStart(world);
  if (world.pending?.wxDirty) {
    world.pending.wxDirty = false;
    refreshDyn(world, true, true);
    stepAnomaly(world, false);
  }
  if (isMonthStart(world)) {
    refreshDyn(world, true);
    stepAnomaly(world, true);
    droughts(world);
    upBands(world, 0, 1, true);
  }
  profEnd(world, 'wx.monthly', t); t = profStart(world);
  if ((day & 1) === 0) {
    // The rain of the last two days (model + storms + tools) counts toward the annual normal.
    sampleRain(world);
    sys.rainN++;
    const calibrating = (sys.calYears || 0) < CAL_YEARS;
    step(world, 2, { lows: sys.lows, calibrate: calibrating ? f.wxCal : null });
    if (calibrating) sys.calSteps = (sys.calSteps || 0) + 1;
  }
  profEnd(world, 'wx.step', t); t = profStart(world);
  upBands(world, day & 1, 2);
  profEnd(world, 'wx.bands', t); t = profStart(world);
  soilStripe(world, day);
  profEnd(world, 'wx.soil', t); t = profStart(world);
  updateStorms(world);
  profEnd(world, 'wx.storms', t);
  if (isYearStart(world) && day > 0 && sys.rainN > 0 && !world.sys.climate) {
    // Climate is absent: keep the annual rainfall normal current ourselves.
    annualRain(world, sys.rainN);
    sys.rainN = 0;
  }
  if (isYearStart(world) && day > 0 && (sys.calYears || 0) < CAL_YEARS) calibrateYear(world, sys);
  if (isYearStart(world)) rateprune(sys, day, 200);
}

/** Soil water budget for one row stripe: infiltration − evapotranspiration − drainage. */
function soilStripe(world, day) {
  const f = world.f;
  const runs = tileRuns(world, 'land');
  soilKernel(runs.runs, runs.rowStart, (day + 2) % K_SOIL, K_SOIL, world.H, (K_SOIL / DAYS_PER_YEAR) / SOIL_CAP,
    f.rain, f.temp, f.soilWater, f.veg, f.snow);
}

/** Same physics as climateModel.soilTendency, inlined for the stripe. */
function soilKernel(R, rs, y0, K, H, k, rain, temp, sw, veg, snow) {
  for (let y = y0; y < H; y += K) {
    for (let q = rs[y]; q < rs[y + 1]; q++) {
      const a = R[2 * q], b = R[2 * q + 1];
      for (let i = a; i < b; i++) {
        const r = rain[i], T = temp[i], s = sw[i];
        const fz = Math.min(1, Math.max(0, (1 - T) * 0.25));
        const frozen = fz * fz * (3 - 2 * fz);
        const inf = r * (0.85 - 0.6 * s * s * s) * (1 - 0.75 * frozen);
        const e = (0.05 + 0.022 * Math.max(0, T)) * (1 - 0.9 * frozen) * (1 - 0.8 * snow[i]) * Math.min(1, s * 1.4285714) * (0.45 + 0.55 * veg[i]);
        const s2 = s * s;
        sw[i] = Math.min(1, Math.max(0, s + k * (inf - e - 0.25 * s2 * s2)));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Droughts: regional soil-water anomalies against a learned seasonal climatology.

function droughts(world) {
  ensureRegions(world);
  const sys = world.sys[ID], R = sys.reg;
  const s = wxStatics(world);
  const { rn } = regionDims(world);
  const m = monthOf(world);
  const day = world.time.day;
  const C = WX_CELL;
  const sw = new Float64Array(rn), land = new Float64Array(rn), sx = new Float64Array(rn), sy = new Float64Array(rn);
  for (let c = 0; c < s.cn; c++) {
    const ln = s.landN[c];
    if (ln <= 0) continue;
    const cx = c % s.cw, cy = (c / s.cw) | 0;
    const r = regionOf(world, Math.min(world.W - 1, cx * C + 1), Math.min(world.H - 1, cy * C + 1));
    sw[r] += s.swM[c] * ln; land[r] += ln;
    sx[r] += (cx * C + C / 2) * ln; sy[r] += (cy * C + C / 2) * ln;
  }
  // Land centroid of each region (drought prose names the land, not the sea beside it).
  R.cx = Array.from(sx, (v, r) => (land[r] > 0 ? Math.round(v / land[r]) : regionCentre(world, r).x));
  R.cy = Array.from(sy, (v, r) => (land[r] > 0 ? Math.round(v / land[r]) : regionCentre(world, r).y));
  R.seen = (R.seen || 0) + 1;
  const learning = R.seen <= 36;
  let wSum = 0, dSum = 0;
  for (let r = 0; r < rn; r++) {
    R.land[r] = land[r];
    if (land[r] < REGION * REGION * 0.12) { R.lvl[r] = 0; R.wet[r] = 0; continue; }
    const cur = sw[r] / land[r];
    R.cur[r] = cur;
    const ci = r * 12 + m;
    let cl = R.clim[ci];
    if (!(cl >= 0)) cl = R.clim[ci] = cur;
    const anomaly = (cl - cur) / (cl + 0.05);
    R.lvl[r] = clampR(0.65 * R.lvl[r] + 0.35 * anomaly, -3, 3);
    R.clim[ci] = cl + (cur - cl) * (learning ? 0.35 : 0.06);
    R.wet[r] = Math.max(0, -R.lvl[r]);
    wSum += land[r]; dSum += land[r] * Math.max(0, R.lvl[r]);
    if (learning) continue;
    let climMean = 0;
    for (let k = 0; k < 12; k++) climMean += Math.max(0, R.clim[r * 12 + k]);
    climMean /= 12;
    const lv = R.lvl[r];
    if (lv > 0.28 && climMean > 0.12) { R.months[r]++; R.calm[r] = 0; }
    else if (lv < 0.12) { R.calm[r]++; if (!R.active[r]) R.months[r] = 0; }
    if (R.active[r]) R.peak[r] = Math.max(R.peak[r], lv);
    if (!R.active[r] && R.months[r] >= 6) {
      R.active[r] = 1; R.great[r] = 0; R.start[r] = day - 6 * 30; R.peak[r] = lv;
      sys.counts.droughts = (sys.counts.droughts || 0) + 1;
      if (rateOk(sys, `drought:${r}`, day, 12) && rateOk(sys, 'droughtAny', day, 2)) droughtStart(world, r);
    } else if (R.active[r] && !R.great[r] && R.months[r] >= 12 && R.peak[r] > 0.38) {
      R.great[r] = 1;
      sys.counts.greatDroughts = (sys.counts.greatDroughts || 0) + 1;
      if (rateOk(sys, 'greatAny', day, 3)) droughtGreat(world, r);
    } else if (R.active[r] && R.calm[r] >= 2) {
      const years = (day - R.start[r]) / DAYS_PER_YEAR;
      if (years >= 1.5 || R.great[r]) droughtEnd(world, r, years);
      R.active[r] = 0; R.great[r] = 0; R.months[r] = 0;
    }
  }
  world.climate.droughtIndex = wSum > 0 ? clampR(dSum / wSum, 0, 1) : 0;
}

/** A land tile near the region's land centroid. */
function droughtCentre(world, r) {
  const R = world.sys[ID].reg;
  const c = R && Array.isArray(R.cx) && R.cx[r] != null ? { x: R.cx[r], y: R.cy[r] } : regionCentre(world, r);
  const { W, H, f } = world;
  let best = null, bd = 1e9;
  for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
    const x = c.x + dx, y = c.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H || f.water[y * W + x] !== WATER.LAND) continue;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = { x, y }; }
  }
  return best || { x: Math.max(0, Math.min(W - 1, c.x)), y: Math.max(0, Math.min(H - 1, c.y)) };
}

function droughtStart(world, r) {
  const { x, y } = droughtCentre(world, r);
  const towns = biggestNear(world, x, y, REGION * 0.75, 3);
  const where = regionName(world, x, y, { settleDist: REGION * 0.6 });
  const yr = yearNum(world);
  let text;
  const named = towns.length && where.includes(towns[0].name);
  if (towns.length) text = pick(world, [
    `In the drought of Year ${yr} the wells of ${towns[0].name} ran dry, and the fields around it cracked under a pitiless sun.`,
    towns.length > 1
      ? `The rains failed ${where} in Year ${yr}; ${listJoin(towns.map((t) => t.name))} watched their rivers shrink to stony trickles.`
      : `The rains failed ${where} in Year ${yr}, and the river of ${towns[0].name} shrank to a stony trickle.`,
    named ? `A hard drought settled over ${where}, and its granaries were opened early.` : `A hard drought settled over ${where}, and the granaries of ${towns[0].name} were opened early.`,
  ]);
  else text = pick(world, [
    `The rains failed ${where} in Year ${yr}, and the grasslands burned brown beneath a cloudless sky.`,
    `Drought gripped ${where}; the herds wandered far in search of water.`,
  ]);
  chronicle(world, { cat: 'climate', imp: towns.length ? 2 : 1, x: towns[0]?.x ?? x, y: towns[0]?.y ?? y, sid: towns[0]?.id ?? null, text, key: 'drought', ...(towns[0] ? { ref: { k: 'settlement', id: towns[0].id } } : {}) });
}

function droughtGreat(world, r) {
  const { x, y } = droughtCentre(world, r);
  const R = world.sys[ID].reg;
  const towns = biggestNear(world, x, y, REGION * 0.8, 3);
  const where = regionName(world, x, y, { settleDist: REGION * 0.6 });
  const y0 = Math.floor(R.start[r] / DAYS_PER_YEAR);
  const tn = listJoin(towns.slice(0, 2).map((t) => t.name));
  const text = towns.length
    ? pick(world, [
      `The Great Drought that began in Year ${y0} tightened its grip on ${where}; harvests failed around ${tn} and dust storms rolled across the dead fields.`,
      `Year upon year without rain made the drought over ${where} a great one: the rivers around ${tn} dwindled to cracked mud and the herds died at the dry waterholes.`,
    ])
    : pick(world, [
      `The drought that began over ${where} in Year ${y0} became a great one; the grasslands withered to dust and the herds died at the dry waterholes.`,
      `Year upon year without rain parched ${where}: lakes shrank, rivers ran dry and the wild herds wandered far in search of water.`,
    ]);
  chronicle(world, { cat: 'climate', imp: 3, x: towns[0]?.x ?? x, y: towns[0]?.y ?? y, sid: towns[0]?.id ?? null, text, key: 'drought.great', ...(towns[0] ? { ref: { k: 'settlement', id: towns[0].id } } : {}) });
}

function droughtEnd(world, r, years) {
  const { x, y } = droughtCentre(world, r);
  const R = world.sys[ID].reg;
  const where = regionName(world, x, y, { settleDist: REGION * 0.6 });
  const y0 = Math.floor(R.start[r] / DAYS_PER_YEAR);
  const yr = yearNum(world);
  chronicle(world, { cat: 'climate', imp: R.great[r] || years >= 3 ? 2 : 1, x, y, key: 'drought.end', text: pick(world, [
    `The drought that had gripped ${where} since Year ${y0} broke at last in Year ${yr}, when the rains returned.`,
    `After ${Math.max(2, Math.round(years))} parched years the rains came back to ${where}, and green returned to the fields.`,
  ]) });
}

// ---------------------------------------------------------------------------
// God tools

function strokeStart(world, id) {
  const sys = world.sys[ID];
  if (!sys) return false;
  const day = world.time.day;
  const s = sys.stroke;
  if (s && s.tool === id && day - s.day < 30) { s.day = day; return false; }
  sys.stroke = { tool: id, day };
  return true;
}
function strokeEnd(world) { if (world.sys[ID]) world.sys[ID].stroke = null; }

/** Visit coarse cells within a tile radius: fn(c, g) with g = 1 − (d/R)². */
function forCells(world, x, y, R, fn) {
  const C = WX_CELL;
  const { cw, ch } = coarseDims(world.W, world.H, C);
  const rc = R / C + 1;
  for (let cy = Math.max(0, Math.floor(y / C - rc)); cy <= Math.min(ch - 1, Math.ceil(y / C + rc)); cy++) {
    for (let cx = Math.max(0, Math.floor(x / C - rc)); cx <= Math.min(cw - 1, Math.ceil(x / C + rc)); cx++) {
      const dx = (cx + 0.5) * C - x, dy = (cy + 0.5) * C - y;
      const d = Math.sqrt(dx * dx + dy * dy) / Math.max(1, R + C * 0.5);
      if (d <= 1) fn(cy * cw + cx, 1 - d * d);
    }
  }
}

function nudgeRegions(world, x, y, R, delta) {
  const a = world.f.wxPA;
  if (!a) return;
  const { rw, rh } = regionDims(world);
  const seen = new Set();
  forDisc(world, x, y, Math.max(1, R), (i, tx, ty) => {
    const r = regionOf(world, tx, ty);
    if (seen.has(r) || r < 0 || r >= rw * rh) return;
    seen.add(r);
    a[r] = clampR(fin(a[r]) + delta, -2.5, 2.5);
  });
  // apply at once (as a reloaded world would, deriving its multipliers from the field)
  stepAnomaly(world, false);
}

registerTool({
  id: 'rain', label: 'Rain', group: 'weather', icon: 'rain', order: 10, polarity: 'boon',
  desc: 'Open the heavens: soak the soil, quench fires and leave the region wetter for months to come.',
  target: 'area', radius: 8, minRadius: 2, maxRadius: 40, continuous: true,
  strength: { label: 'Downpour', min: 0.1, max: 1, default: 0.6 },
  preview: rainPreview,
  apply(world, x, y, { radius, strength }) {
    if (!world.sys[ID]) return { ok: false, message: 'The skies are not yet stirring.' };
    const f = world.f, s = clampR(fin(strength, 0.6), 0, 1), R = Math.max(1, fin(radius, 8));
    let quenched = 0;
    forDisc(world, x, y, R, (i, tx, ty, d) => {
      const g = 1 - d * d;
      if (f.water[i] === WATER.LAND) f.soilWater[i] = Math.min(1, f.soilWater[i] + 0.12 * s * g);
      f.humidity[i] = Math.max(f.humidity[i], 0.85 * g);
      f.rain[i] = Math.max(f.rain[i], Math.min(1, 0.9 * s * g + 0.1));
      f.cloud[i] = Math.max(f.cloud[i], 0.9 * g);
      if (f.fire[i] > 0 && g > 0.15) { f.fire[i] = 0; quenched++; }
    });
    const bM = world.cache.natWx?.bM;
    forCells(world, x, y, R, (c, g) => {
      f.wxRain[c] = Math.max(f.wxRain[c], (1.2 * s * g) / Math.max(0.06, bM ? bM[c] : 0.3));
      f.wxCloud[c] = Math.max(f.wxCloud[c], 0.95 * Math.sqrt(g));
      f.wxRH[c] = Math.max(f.wxRH[c], 0.9 * Math.sqrt(g));
      f.wxQ[c] = Math.max(f.wxQ[c], 0.9 * f.wxQ[c] + 0.35 * s * g);
    });
    nudgeRegions(world, x, y, R, 0.06 * s);
    if (strokeStart(world, 'rain')) {
      emitFx(world, { type: 'raincall', x, y, r: R, src: 'tool' });
      const pl = placePhrase(world, x, y);
      chronicle(world, { cat: 'divine', imp: 1, x, y, key: 'divine.rain', text: pick(world, [
        `Rain fell from a clear sky ${pl.text}, summoned by an unseen hand${quenched ? ', and the wildfires hissed out' : ''}.`,
        `Clouds gathered out of nothing ${pl.text} and the rain came down in sheets${quenched ? '; the fires died in clouds of steam' : ''}.`,
      ]) });
    }
    if (quenched) emitFx(world, { type: 'label', x, y, text: `${quenched} fire${quenched === 1 ? '' : 's'} quenched`, tone: 'boon', size: 0.9, src: 'tool' });
    return { ok: true, message: quenched ? `Rain falls; ${quenched} burning tiles quenched.` : 'Rain falls.' };
  },
  finish(world) { strokeEnd(world); },
});

registerTool({
  id: 'drought', label: 'Drought', group: 'weather', icon: 'drought', order: 20, polarity: 'bane',
  desc: 'Withhold the rain: parch the soil and leave a lasting dry spell over the region.',
  target: 'area', radius: 10, minRadius: 2, maxRadius: 40, continuous: true,
  strength: { label: 'Severity', min: 0.1, max: 1, default: 0.6 },
  preview: droughtPreview,
  apply(world, x, y, { radius, strength }) {
    if (!world.sys[ID]) return { ok: false, message: 'The skies are not yet stirring.' };
    const f = world.f, s = clampR(fin(strength, 0.6), 0, 1), R = Math.max(1, fin(radius, 10));
    forDisc(world, x, y, R, (i, tx, ty, d) => {
      const g = 1 - d * d;
      if (f.water[i] === WATER.LAND) f.soilWater[i] = Math.max(0, f.soilWater[i] * (1 - 0.22 * s * g));
      f.humidity[i] *= 1 - 0.5 * s * g;
      f.rain[i] *= 1 - s * g;
      f.cloud[i] *= 1 - 0.8 * s * g;
    });
    forCells(world, x, y, R, (c, g) => {
      f.wxQ[c] *= 1 - 0.45 * s * g;
      f.wxRain[c] *= 1 - s * g;
      f.wxCloud[c] *= 1 - 0.8 * s * g;
      f.wxRH[c] *= 1 - 0.5 * s * g;
    });
    nudgeRegions(world, x, y, R, -0.12 * s);
    if (strokeStart(world, 'drought')) {
      emitFx(world, { type: 'parch', x, y, r: R, src: 'tool' });
      const where = regionName(world, x, y);
      chronicle(world, { cat: 'divine', imp: 2, x, y, key: 'divine.drought', text: pick(world, [
        `A curse of drought was laid upon ${where}; the sky turned hard and brazen, and no rain would fall.`,
        `The rains forsook ${where} as if forbidden; wells sank, and the priests could not say what god they had angered.`,
      ]) });
    }
    return { ok: true, message: 'The land dries and the sky clears.' };
  },
  finish(world) { strokeEnd(world); },
});

registerTool({
  id: 'storm', label: 'Storm', group: 'catastrophe', icon: 'storm', order: 70, polarity: 'bane',
  desc: 'Raise a storm here: a cyclone over warm sea, a blizzard over frozen land, a sandstorm in the desert, a thunderstorm elsewhere.',
  target: 'tile', radius: 0,
  strength: { label: 'Fury', min: 0.2, max: 1, default: 0.75 },
  preview: stormPreview,
  apply(world, x, y, { strength }) {
    if (!world.sys[ID]) return { ok: false, message: 'The skies are not yet stirring.' };
    const f = world.f, i = y * world.W + x, s = clampR(fin(strength, 0.75), 0.05, 1);
    const b = f.biome[i];
    let kind;
    if (f.water[i] !== WATER.LAND) kind = f.temp[i] < 0 ? 'blizzard' : 'cyclone';
    else if (b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT) kind = 'sandstorm';
    else if (f.temp[i] < 2) kind = 'blizzard';
    else kind = 'thunderstorm';
    return raise(world, kind, x, y, s);
  },
});

registerTool({
  id: 'blizzard', label: 'Blizzard', group: 'weather', icon: 'blizzard', order: 40, polarity: 'bane',
  desc: 'Loose a howling snowstorm that drifts on the wind, burying fields and freezing herds.',
  target: 'tile', radius: 0,
  strength: { label: 'Fury', min: 0.2, max: 1, default: 0.8 },
  preview: blizzardPreview,
  apply(world, x, y, { strength }) {
    if (!world.sys[ID]) return { ok: false, message: 'The skies are not yet stirring.' };
    return raise(world, 'blizzard', x, y, clampR(fin(strength, 0.8), 0.05, 1));
  },
});

registerTool({
  id: 'lightning', label: 'Lightning', group: 'weather', icon: 'lightning', order: 30, polarity: 'bane',
  desc: 'Hurl a thunderbolt. Dry forests and grass may catch fire.',
  target: 'tile', radius: 0,
  strength: { label: 'Heat', min: 0.2, max: 1, default: 0.8 },
  preview: lightningPreview,
  apply(world, x, y, { strength }) {
    const f = world.f, i = y * world.W + x, s = clampR(fin(strength, 0.8), 0.05, 1);
    emitFx(world, { type: 'lightning', x: x + 0.5, y: y + 0.5, src: 'tool' });
    if (f.water[i] !== WATER.LAND) return { ok: true, message: 'The bolt hisses into the water.' };
    if (f.veg[i] < 0.08) return { ok: true, message: 'The bolt scorches bare ground.' };
    ignite(world, i, 0.5 + 0.5 * s, { cause: 'divine' });
    if (strokeStart(world, 'lightning')) {
      const pl = placePhrase(world, x, y);
      chronicle(world, { cat: 'divine', imp: 1, x, y, key: 'divine.lightning', text: `A thunderbolt out of a clear sky set the land ablaze ${pl.text}.` });
    }
    return { ok: true, message: 'Lightning strikes; the land catches fire.' };
  },
  finish(world) { strokeEnd(world); },
});

// The hand that turns a storm: drag a storm (or choose a direction from its record) and it is
// pushed that way for a while (st.push), then the winds take it back. Hidden from the palette.
const DIRS = [['n', 'North', 0, -1], ['ne', 'North-east', 0.71, -0.71], ['e', 'East', 1, 0], ['se', 'South-east', 0.71, 0.71], ['s', 'South', 0, 1], ['sw', 'South-west', -0.71, 0.71], ['w', 'West', -1, 0], ['nw', 'North-west', -0.71, -0.71]];

/** Where a steer points: the dragged-to spot, else 20 tiles off in the chosen direction. */
function steerGoal(st, args) {
  if (Number.isFinite(args?.x) && Number.isFinite(args?.y)) return { x: args.x, y: args.y };
  const d = DIRS.find((q) => q[0] === args?.dir);
  return d ? { x: st.x + d[2] * 20, y: st.y + d[3] * 20 } : null;
}

registerTool({
  id: 'steer_storm', label: 'Steer Storm', group: 'weather', icon: 'storm', order: 90, polarity: 'neutral', hidden: true,
  desc: 'Take a storm in hand: drag it where it should go, and for a few weeks it follows, then the winds take it back.',
  target: 'entity', entity: { kinds: ['storm'] },
  args: [{ key: 'dir', type: 'select', label: 'Push toward', options: () => DIRS.map((d) => [d[0], d[1]]) }],
  preview(world, x, y, opts = {}) {
    const st = opts.target && opts.target.kind === 'storm' ? world.storms.find((q) => q.id === opts.target.id) : null;
    if (!st) return { ok: false, reason: 'That storm has blown itself out.' };
    const to = steerGoal(st, opts);
    return steerPreview(world, to ? to.x : x, to ? to.y : y, { ...opts, x: to ? to.x : undefined, y: to ? to.y : undefined });
  },
  applyEntity(world, target, args = {}) {
    const st = target && target.kind === 'storm' ? world.storms.find((q) => q.id === target.id) : null;
    if (!st) return { ok: false, message: 'That storm has blown itself out.' };
    const to = steerGoal(st, args);
    const push = to ? steerPush(st, to.x, to.y) : null;
    if (!push) return { ok: false, message: 'Point the storm somewhere farther off.' };
    st.push = push;
    st.divine = true;
    const track = forecastTrack(world, st, 30);
    const towns = forecastTowns(world, track.slice(1), st.kind);
    emitFx(world, { type: 'swirl', x: st.x, y: st.y, r: st.radius, src: 'tool' });
    emitFx(world, { type: 'thread', x: st.x, y: st.y, x2: to.x, y2: to.y, tone: 'neutral', src: 'tool' });
    const what = st.kind === 'cyclone' ? `the cyclone ${st.name}` : `a ${st.kind}`;
    if (world.sys[ID] && rateOk(world.sys[ID], `steer${st.id}`, world.time.day, 0.1)) {
      const pl = placePhrase(world, Math.round(to.x), Math.round(to.y), { settleDist: 8 });
      chronicle(world, {
        cat: 'divine', imp: towns.length ? 2 : 1, x: Math.round(st.x), y: Math.round(st.y), key: 'divine.steer_storm', ref: { k: 'storm', id: st.id },
        ...(towns[0] ? { sid: towns[0].sid } : {}),
        text: pick(world, [
          `Against every wind, ${what} turned ${pl.text}${towns.length ? `, toward ${listJoin(towns.slice(0, 2).map((q) => world.settlements[q.sid].name))}` : ''}.`,
          `Sailors swore a hand had turned ${what}; it bore away ${pl.text} as if called there.`,
        ]),
      });
    }
    return { ok: true, message: `${cap(what)} turns${towns.length ? ` toward ${world.settlements[towns[0].sid].name}` : ''}.` };
  },
});

function raise(world, kind, x, y, s) {
  const st = spawnStorm(world, kind, x + 0.5, y + 0.5, kind === 'cyclone' ? 0.35 + 0.65 * s : 0.3 + 0.7 * s, { forced: true, divine: true });
  if (!st) return { ok: false, message: 'The sky would not answer.' };
  if (kind === 'cyclone') { st.vx = -2; st.vy = -0.6 * st.hemisphere; st.maxAge += 6; }
  if (kind === 'thunderstorm') st.maxAge += 2;
  emitFx(world, { type: 'swirl', x, y, r: st.radius, src: 'tool' });
  const pl = placePhrase(world, x, y, { settleDist: 8 });
  const what = kind === 'cyclone' ? `the cyclone ${st.name}` : kind === 'blizzard' ? 'a blizzard' : kind === 'sandstorm' ? 'a sandstorm' : 'a thunderstorm';
  if (kind === 'cyclone') emitFx(world, { type: 'label', x: x + 0.5, y: y + 0.5, text: st.name, tone: 'bane', size: 1, src: 'tool' });
  if (strokeStart(world, 'storm:' + kind)) {
    chronicle(world, { cat: 'divine', imp: kind === 'cyclone' ? 2 : 1, x, y, key: 'divine.storm', ref: { k: 'storm', id: st.id }, text: pick(world, [
      `At an unseen command ${what} gathered ${pl.text}.`,
      `Out of a still sky ${what} was born ${pl.text}, as if called up by name.`,
    ]) });
  }
  return { ok: true, message: `${cap(what)} gathers.` };
}
