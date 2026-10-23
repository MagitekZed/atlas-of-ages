// The atmospheric moisture cycle on a coarse grid (WX_CELL × WX_CELL tiles per cell).
// Each step: semi-Lagrangian advection of water vapour along the prevailing wind (plus
// the swirl of travelling mid-latitude lows), evaporation from warm seas and from wet,
// vegetated land (transpiration ∝ vegetation, so clearing forests dries the land
// downwind), and precipitation from large-scale saturation, orographic lift on windward
// slopes, tropical convection (an ITCZ that follows the sun) and frontal uplift. Air
// descending a lee slope is dried — rain shadows emerge on their own.
//
// Downscaling: the model's rain is expressed relative to its own climatology (wxRain ≈ 1
// on an average day), and tile rain = baseMoisture × relative rain. The generator's fine
// rainfall pattern is therefore kept exactly in the long run, while the model supplies
// seasons, fronts, storms, droughts and every lasting change (warming, deforestation).
// The climatology (wxCorr = 1 / mean model rain) is fitted by a spin-up at genesis and
// refined over the first simulated years, once the land surface has settled.
//
// Saved coarse fields: wxQ vapour, wxRain relative rain, wxCloud cover, wxRH relative
// humidity, wxSurf evaporating fraction of the surface (monthly), wxCorr inverse climatology, wxPA regional precipitation anomaly, wxCal
// calibration accumulator, wxAcc annual sum of relative rain (→ annRain = baseMoisture ×
// annual mean).
//
// Tile fields are refreshed in bands of BAND rows (see upBands): cloud and humidity are
// interpolated bilinearly along each row and to the band centre vertically, then copied
// to the band's rows natively; rain is the band's relative rain × baseMoisture per land
// tile. Each band is refreshed every 2 days; rain over water (read only for display) is
// refreshed monthly.

import { WATER, BIOMES } from '../../core/constants.js';
import { ensureField, latitude } from '../../core/world.js';
import { hash2, hashString } from '../../core/rng.js';
import { WX_CELL, REGION, coarseDims, upTables, regionDims, tileRuns } from './grid.js';
import { seasonPhase, tiltFactor, ampCache, qsat, hemiOf, QS_TAB, QS_LO, QS_HI, QS_INV } from './climateModel.js';
import { ss, fin, bell, clampR, profStart, profEnd } from './common.js';

export const C = WX_CELL;
const TRANSPORT = 2.6;     // moisture transport speed per unit of prevailing wind (tiles/day)
const K_EVAP = 0.6;        // per day, toward saturation, over open water
const K_COND = 0.45;       // large-scale condensation rate beyond the RH threshold
const K_ORO = 14;          // orographic condensation per unit of lift
const K_CONV = 0.3;        // tropical convection
const K_FRONT = 0.8;       // frontal uplift
const RAIN_SCALE = 6.5;    // q-units per day → annualised rain units (1 ≈ 3000 mm/yr)
export const CAL_YEARS = 4; // in-simulation refinement of the climatology
const MOIST_DT = 0.25;     // share of global temperature change felt by the moisture model
// Regional rain anomalies (log-space AR(1), monthly): sd at volatility v = SD0 + SDV·v.
const ANOM_SD0 = 0.27, ANOM_SDV = 0.4, ANOM_RHO = 0.95;

/** Allocate the saved coarse fields (idempotent). */
export function ensureWxFields(world) {
  const d = coarseDims(world.W, world.H, C);
  const r = regionDims(world);
  ensureField(world, 'wxQ', Float32Array, d.cn);
  ensureField(world, 'wxRain', Float32Array, d.cn, 1);
  ensureField(world, 'wxCloud', Float32Array, d.cn);
  ensureField(world, 'wxCorr', Float32Array, d.cn, 1);
  ensureField(world, 'wxPA', Float32Array, r.rn);
  ensureField(world, 'wxCal', Float32Array, d.cn);
  ensureField(world, 'wxAcc', Float32Array, d.cn);
  ensureField(world, 'wxRH', Float32Array, d.cn, 0.6);
  ensureField(world, 'wxSurf', Float32Array, d.cn);
  ensureField(world, 'wxEv0', Float32Array, d.cn);
  ensureField(world, 'wxE', Float32Array, d.cn);
  return d;
}

const reliefKey = (world) => { const v = world.versions; return ((v.water || 0) - (v.load || 0)) * 1e6 + ((v.terrain || 0) - (v.load || 0)); };
/** Save the coarse relief in use (wxE) once a reloaded world first uses it outside init. */
function writeRelief(world, s) {
  if (world.cache.natWxInit) return;
  s.eDue = false;
  const savedE = world.f.wxE, wsys = world.sys.weather;
  if (!savedE || savedE.length !== s.cn || !wsys) return;
  savedE.set(s.e);
  wsys.wxESaved = true;
  wsys.wxEKey = reliefKey(world);
}

/** Static per-cell geography (ocean fraction, relief, wind, temperature normals). */
export function wxStatics(world) {
  const key = world.versions.water * 1e6 + world.versions.terrain;
  let s = world.cache.natWx;
  if (s && s.key === key && s.N === world.N) {
    if (s.eDue) writeRelief(world, s);
    return s;
  }
  const old = s && s.N === world.N ? s : null;
  const { W, H, N, f } = world;
  const { cw, ch, cn } = coarseDims(W, H, C);
  // The level hydrology last ran at (changes only with versions.water, so a rebuild after a
  // reload reproduces the same geography).
  const sea = fin(world.climate.appliedSeaLevel, 0.5);
  const ac = ampCache(world);
  s = {
    key, N, cw, ch, cn,
    fo: new Float32Array(cn), e: new Float32Array(cn), gx: new Float32Array(cn), gy: new Float32Array(cn),
    u0: new Float32Array(cn), v0: new Float32Array(cn), bT: new Float32Array(cn), amp: new Float32Array(cn), mar: new Float32Array(cn),
    bM: new Float32Array(cn), ctr: new Int32Array(cn), rowLat: new Float32Array(ch), subs: new Float32Array(ch), rowHemi: new Float32Array(ch),
    cellX: new Int32Array(W), cellY: new Int32Array(H),
    // scratch
    q2: new Float32Array(cn), uE: new Float32Array(cn), vE: new Float32Array(cn), front: new Float32Array(cn),
    instA: new Float32Array(cn), instB: new Float32Array(cn), instKey: -1e9, scratch: new Float32Array(cn),
    anomC: new Float32Array(cn), anomKey: -1e9, anomSrc: null, nAll: new Float32Array(cn), nLand: new Float32Array(cn),
    // monthly dynamic inputs
    surfL: ensureField(world, 'wxSurf', Float32Array, cn), snowM: new Float32Array(cn), swM: new Float32Array(cn), vegM: new Float32Array(cn), pMult: new Float32Array(cn).fill(1),
    landN: new Float32Array(cn), cnt: new Float32Array(cn),
  };
  for (let x = 0; x < W; x++) s.cellX[x] = Math.min(cw - 1, (x / C) | 0);
  for (let y = 0; y < H; y++) s.cellY[y] = Math.min(ch - 1, (y / C) | 0) * cw;
  const cnt = s.cnt;
  const water = f.water, elev = f.elevation, windX = f.windX, windY = f.windY, baseT = f.baseTemp, baseM = f.baseMoisture, aAmp = ac.amp, aMar = ac.mar;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const c = s.cellY[y] + s.cellX[x];
    cnt[c]++;
    if (water[i] !== WATER.LAND) s.fo[c]++; else s.landN[c]++;
    s.e[c] += Math.max(elev[i], sea);
    s.u0[c] += fin(windX[i]); s.v0[c] += fin(windY[i]);
    s.bT[c] += fin(baseT[i]); s.amp[c] += aAmp[i]; s.mar[c] += aMar[i];
    s.bM[c] += fin(baseM[i]);
  }
  for (let c = 0; c < cn; c++) {
    const n = Math.max(1, cnt[c]);
    s.fo[c] /= n; s.e[c] /= n; s.u0[c] /= n; s.v0[c] /= n; s.bT[c] /= n; s.amp[c] /= n; s.mar[c] /= n; s.bM[c] /= n;
    const cx = c % cw, cy = (c / cw) | 0;
    s.ctr[c] = Math.min(H - 1, cy * C + (C >> 1)) * W + Math.min(W - 1, cx * C + (C >> 1));
  }
  // Coarse relief is saved (wxE): eruptions and lava nudge the elevation between terrain
  // version bumps, so the first build after a reload must reuse the relief the running world
  // was using rather than resample today's elevation (save → load → continue stays identical).
  // The saved relief is reused only if it was sampled for the current terrain / coastline
  // (versions taken relative to versions.load, which a reload bumps along with them): a world
  // saved between an edit and the rebuild resamples, as the running world does.
  // A reload whose saved relief predates the last edit resamples here but writes the relief
  // back only at its first use after init (eDue), as the running world does when it rebuilds
  // at that use, so a save taken in between holds the same wxE in both.
  const savedE = world.f.wxE;
  const wsys = world.sys.weather;
  const eKey = reliefKey(world);
  if (savedE && savedE.length === cn) {
    if (!old && wsys && wsys.wxESaved && (wsys.wxEKey == null || wsys.wxEKey === eKey)) { s.e.set(savedE); wsys.wxEKey = eKey; }
    else if (!old && wsys && wsys.wxESaved && world.cache.natWxInit) s.eDue = true;
    else { savedE.set(s.e); if (wsys) { wsys.wxESaved = true; wsys.wxEKey = eKey; } }
  }
  // Terrain / coastline edits rebuild the geography; the month's dynamic state carries over.
  if (old && old.cn === cn) {
    for (const k of ['snowM', 'swM', 'vegM', 'pMult', 'instA', 'instB']) s[k].set(old[k]);
    s.instKey = old.instKey;
  }
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    const c = cy * cw + cx;
    const xl = Math.max(0, cx - 1), xr = Math.min(cw - 1, cx + 1), yu = Math.max(0, cy - 1), yd = Math.min(ch - 1, cy + 1);
    s.gx[c] = (s.e[cy * cw + xr] - s.e[cy * cw + xl]) / Math.max(1, (xr - xl) * C);
    s.gy[c] = (s.e[yd * cw + cx] - s.e[yu * cw + cx]) / Math.max(1, (yd - yu) * C);
  }
  for (let cy = 0; cy < ch; cy++) {
    const y = Math.min(H - 1, cy * C + (C >> 1));
    const lat = latitude(world, y);
    s.rowLat[cy] = lat;
    s.rowHemi[cy] = hemiOf(lat);
    // Subtropical highs: sinking dry air around 20–35° latitude.
    s.subs[cy] = 0.75 * bell(Math.abs(lat), 0.3, 0.1);
  }
  world.cache.natWx = s;
  return s;
}

/**
 * Monthly: coarse means of the land surface that drive evaporation (vegetation, soil
 * water, snow and sea ice). Cell means are estimated from every third tile in each
 * direction, the sampling offset rotating month by month; pass `full` for an exact pass.
 */
export function refreshDyn(world, ecologyReady, full = false) {
  const s = wxStatics(world);
  const { W, H, f } = world;
  const { cn, cellX, cellY } = s;
  const vegM = s.vegM, swM = s.swM, snowM = s.snowM;
  const nAll = s.nAll, nLand = s.nLand;
  vegM.fill(0); swM.fill(0); snowM.fill(0); nAll.fill(0); nLand.fill(0);
  const veg = f.veg, sw = f.soilWater, snow = f.snow, water = f.water, biome = f.biome;
  const step = full ? 1 : 3;
  const m = Math.floor(world.time.day / 30);
  const ox = full ? 0 : m % 3, oy = full ? 0 : Math.floor(m / 3) % 3;
  for (let y = oy; y < H; y += step) {
    const cy = cellY[y], row = y * W;
    for (let x = ox; x < W; x += step) {
      const i = row + x, c = cy + cellX[x];
      snowM[c] += snow[i];
      nAll[c]++;
      if (water[i] !== WATER.LAND) continue;
      vegM[c] += ecologyReady ? veg[i] : (BIOMES[biome[i]]?.vegMax || 0) * 0.8;
      swM[c] += sw[i];
      nLand[c]++;
    }
  }
  // Land evaporation responds to vegetation and soil water, but only as the square root of
  // its change since genesis (wxEv0): forests cleared still dry the land downwind, while the
  // land–rain feedback cannot run away (e.g. a windless world recycling its own moisture).
  const ev0 = world.f.wxEv0;
  for (let c = 0; c < cn; c++) {
    const n = nLand[c];
    snowM[c] /= Math.max(1, nAll[c]);
    if (n > 0) { vegM[c] /= n; swM[c] /= n; } else if (s.landN[c] > 0) { vegM[c] = 0.3; swM[c] = 0.4; }
    const snowF = 1 - 0.85 * Math.min(1, snowM[c]);
    const ev = (0.08 + 0.85 * vegM[c]) * ss(0.02, 0.5, swM[c]);
    if (ev0 && !(ev0[c] > 0) && s.landN[c] > 0) ev0[c] = Math.max(0.01, ev);
    const landEvap = (ev0 && ev0[c] > 0 ? Math.sqrt(ev0[c] * Math.max(0, ev)) : ev) * snowF;
    s.surfL[c] = s.fo[c] * (1 - 0.7 * Math.min(1, snowM[c])) + (1 - s.fo[c]) * landEvap;
  }
}

/** Monthly: regional precipitation anomaly (AR(1)) → per-cell rain multiplier. */
export function stepAnomaly(world, advance) {
  const s = wxStatics(world);
  const { rw, rh, rn } = regionDims(world);
  const a = world.f.wxPA;
  if (advance) {
    const vol = clampR(fin(world.params.climateVolatility, 0.3), 0, 1);
    const sd = ANOM_SD0 + ANOM_SDV * vol;
    const rho = ANOM_RHO;
    const innov = sd * Math.sqrt(1 - rho * rho);
    for (let r = 0; r < rn; r++) a[r] = clampR(fin(a[r]) * rho + innov * world.rng.normal(0, 1), -2.5, 2.5);
  }
  const anomT = world.cache.natAnomTile;
  const { cw, cn } = s;
  const vol0 = clampR(fin(world.params.climateVolatility, 0.3), 0, 1);
  const sd0 = ANOM_SD0 + ANOM_SDV * vol0;
  const var0 = sd0 * sd0;
  for (let c = 0; c < cn; c++) {
    const cx = c % cw, cy = (c / cw) | 0;
    const fx = Math.min(rw - 1, Math.max(0, (cx * C + C * 0.5) / REGION - 0.5));
    const fy = Math.min(rh - 1, Math.max(0, (cy * C + C * 0.5) / REGION - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(rw - 1, x0 + 1), y1 = Math.min(rh - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    const v = a[y0 * rw + x0] * w00 + a[y0 * rw + x1] * w10 + a[y1 * rw + x0] * w01 + a[y1 * rw + x1] * w11;
    // The interpolated anomaly has variance σ²·Σw² (independent regions; coincident corners
    // at the map edge add their weights), so E[exp(v − ½σ²Σw²)] = 1 exactly.
    const sx0 = x1 === x0 ? 1 : 0, sy0 = y1 === y0 ? 1 : 0;
    let sw2;
    if (sx0 && sy0) sw2 = 1;
    else if (sx0) sw2 = (1 - ty) * (1 - ty) + ty * ty;
    else if (sy0) sw2 = (1 - tx) * (1 - tx) + tx * tx;
    else sw2 = w00 * w00 + w10 * w10 + w01 * w01 + w11 * w11;
    const heat = anomT ? anomT[s.ctr[c]] : 0;
    s.pMult[c] = clampR(Math.exp(v - 0.5 * var0 * sw2 - 0.07 * heat), 0.12, 3.5);
  }
  s.pVol = vol0;   // step() re-derives the multipliers when the volatility slider moves
}

// ---------------------------------------------------------------------------
// Travelling lows (extratropical cyclones / fronts). Internal to weather; JSON in sys.

function spawnLows(world, lows, dt, day) {
  const ph = seasonPhase(world, day);
  for (let h = 0; h < 2; h++) {
    const hemi = h === 0 ? 1 : -1;
    // More, deeper lows in each hemisphere's winter.
    const winter = 0.5 - 0.5 * hemi * ph.sL; // 1 at local midwinter
    const lam = (0.42 + 0.5 * winter) * dt;
    let k = 0;
    const u = world.rng.next();
    let p = Math.exp(-lam), cum = p;
    while (u > cum && k < 4) { k++; p *= lam / k; cum += p; }
    for (let n = 0; n < k; n++) {
      if (lows.length >= 28) return;
      const al = world.rng.float(0.32, 0.74);
      const lat = al * hemi;
      const y = Math.round(((1 - lat) * world.H) / 2 - 0.5);
      lows.push({
        x: world.rng.float(0, world.W - 1), y: clampR(y, 1, world.H - 2),
        h: hemi, s: 0, smax: world.rng.float(0.45, 1) * (0.7 + 0.5 * winter),
        r: world.rng.float(13, 24), age: 0, life: world.rng.float(6, 13),
      });
    }
  }
}

function moveLows(world, lows, dt) {
  const { W, H, f } = world;
  const ws = clampR(fin(world.params.windStrength, 1), 0, 2);
  for (let k = lows.length - 1; k >= 0; k--) {
    const L = lows[k];
    const i = clampR(Math.round(L.y), 0, H - 1) * W + clampR(Math.round(L.x), 0, W - 1);
    const vx = fin(f.windX[i]) * ws * 2.6 + 0.9;
    const vy = fin(f.windY[i]) * ws * 2.6 - 0.3 * L.h;
    L.x += vx * dt; L.y += vy * dt; L.age += dt;
    L.s = L.smax * Math.sin(Math.PI * Math.min(1, L.age / Math.max(1, L.life)));
    if (L.age >= L.life || L.x < -8 || L.x > W + 8 || L.y < 1 || L.y > H - 2 || !Number.isFinite(L.x + L.y)) lows.splice(k, 1);
  }
}

/** Velocity field (tiles/day) and frontal uplift for this step. */
function buildFlow(world, s, lows) {
  const ws = clampR(fin(world.params.windStrength, 1), 0, 2);
  const { cw, ch, cn, uE, vE, front, u0, v0 } = s;
  const k0 = ws * TRANSPORT;
  for (let c = 0; c < cn; c++) { uE[c] = u0[c] * k0; vE[c] = v0[c] * k0; }
  front.fill(0);
  for (const L of lows) {
    if (L.s <= 0.02) continue;
    const R = L.r, Rc = R / C, R2i = 1 / (R * R);
    const lx = L.x / C - 0.5, ly = L.y / C - 0.5;
    const x0 = Math.max(0, Math.floor(lx - Rc * 1.6)), x1 = Math.min(cw - 1, Math.ceil(lx + Rc * 1.6));
    const y0 = Math.max(0, Math.floor(ly - Rc * 1.6)), y1 = Math.min(ch - 1, Math.ceil(ly + Rc * 1.6));
    const spin = 3.2 * L.s * Math.max(0.4, ws) * 0.8;
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const dx = (cx - lx) * C, dy = (cy - ly) * C;
      const d2 = (dx * dx + dy * dy) * R2i;
      if (d2 >= 3.5) continue;
      // Compact bell, ≈ exp(−d²) over the core and exactly 0 at the rim.
      const gq = 1 - d2 * (1 / 3.5);
      const g = gq * gq * gq;
      const c = cy * cw + cx;
      const rn = Math.sqrt(d2) + 0.15;
      // Counter-clockwise (map view, north up) in the north, clockwise in the south.
      uE[c] += spin * g * (L.h * dy / R) / rn;
      vE[c] += spin * g * (-L.h * dx / R) / rn;
      // Rain is heaviest ahead of (east of) and equatorward of the centre: the warm front.
      const ahead = 1 + 0.6 * ss(-0.3, 0.8, dx / R) + 0.3 * ss(-0.5, 0.8, L.h * dy / R);
      const v = L.s * g * ahead;
      if (v > front[c]) front[c] = v;
    }
  }
}

/** Convective instability noise: smooth in time, refreshed every 4 days. */
function instability(world, s, day) {
  const key = Math.floor(day / 4);
  if (s.instKey !== key) {
    const seedN = (world.cache.natWxSeed ??= hashString(String(world.seed) + ':wx') & 0xffff);
    const { cw, cn, instA, instB } = s;
    if (s.instKey === key - 1) instA.set(instB);
    else for (let c = 0; c < cn; c++) instA[c] = hash2(c % cw, (c / cw) | 0, key + seedN);
    for (let c = 0; c < cn; c++) instB[c] = hash2(c % cw, (c / cw) | 0, key + 1 + seedN);
    s.instKey = key;
  }
  return day / 4 - key;
}

/**
 * Advance the moisture cycle by dt days.
 * opts: { day, lows, accumulate (Float32Array: raw model rain), noLows, calibrate (Float32Array) }
 */
export function step(world, dt, opts = {}) {
  const s = wxStatics(world);
  const f = world.f;
  // The rain multipliers are a function of the saved anomaly field and the live volatility: a
  // world reloaded after the slider moved derives them afresh, so the running world must too.
  if (s.pVol !== clampR(fin(world.params.climateVolatility, 0.3), 0, 1)) stepAnomaly(world, false);
  const day = opts.day ?? world.time.day;
  const lows = opts.lows || [];
  const c0 = world.climate;
  const hp = clampR(fin(world.params.humidity, 1), 0.05, 3);
  let tp = profStart(world);
  if (!opts.noLows) { spawnLows(world, lows, dt, day); moveLows(world, lows, dt); }
  profEnd(world, 'wxs.lows', tp); tp = profStart(world);
  buildFlow(world, s, lows);
  profEnd(world, 'wxs.flow', tp); tp = profStart(world);
  const nf = instability(world, s, day);
  const anomC = cellAnomaly(world, s, day);
  profEnd(world, 'wxs.inst', tp); tp = profStart(world);
  const ph = seasonPhase(world, day);
  const tf = tiltFactor(world);
  // The moisture physics sees a quarter of any global temperature change since the
  // climatology was fitted: raw Clausius–Clapeyron scaling made rain swing ~11 %/°C; damped,
  // a warmer world is ~3 %/°C wetter (and a colder one drier), as on Earth.
  const off0 = fin(c0.tempOffset, 0);
  const ref = fin(world.sys.weather?.offRef, off0);
  const off = ref + MOIST_DT * (off0 - ref);
  const dim = 1 - 0.45 * Math.min(1, Math.max(0, fin(c0.aerosol)));
  // Live rainfall slider acts relative to the genesis value the climatology was fitted at.
  const hpRel = Math.pow(hp / clampR(fin(world.genesisParams?.humidity, 1), 0.05, 3), 0.7);
  // ITCZ follows the sun (±~8° latitude).
  const itcz = 0.09 * -Math.cos(2 * Math.PI * (ph.yp - 0.08));
  const acc = opts.accumulate || null, cal = opts.calibrate || null;
  stepKernel(s.cw, s.ch, dt, nf, ph.sL * tf, ph.sW * tf, dim, off, hpRel, itcz, K_EVAP * hp,
    s.rowLat, s.subs, s.rowHemi, s.uE, s.vE, s.front, s.instA, s.instB, s.gx, s.gy, s.bT, s.amp, s.mar, anomC,
    s.pMult, s.surfL, s.bM, f.wxQ, s.q2, f.wxRain, f.wxCloud, f.wxRH, f.wxCorr,
    acc || s.scratch, acc ? 1 : 0, cal || s.scratch, cal ? 1 : 0);
  f.wxQ.set(s.q2);
  profEnd(world, 'wxs.loop', tp);
}

/**
 * One moisture step over every coarse cell (typed arrays and numbers only, so the kernel
 * keeps stable type feedback). phL / phW: season phase × tilt for land / water.
 */
function stepKernel(cw, ch, dt, nf, phL, phW, dim, off, hpRel, itcz, kE, rowLat, subsA, rowHemi, uE, vE, front, instA, instB,
  gx, gy, bT, amp, mar, anomC, pMult, surfL, bM, q, q2, rainF, cloudF, rh, corr, acc, useAcc, cal, useCal) {
  const dtc = dt / C, pCap = 0.9 / dt;
  const qsT = QS_TAB;
  for (let cy = 0; cy < ch; cy++) {
    const lat = rowLat[cy];
    const subs = subsA[cy];
    const dl = (lat - itcz) / 0.075;
    const itczB = 1 + 0.9 * Math.exp(-dl * dl);
    const rhc = 0.8 + 0.15 * subs;
    const sink = 1 - 0.7 * subs;
    const kCond = K_COND * sink, kFront = K_FRONT * sink;
    const convK = K_CONV * (1 - subs) * itczB;
    const hm = rowHemi[cy];
    let sL = hm * phL, sW = hm * phW;
    if (sL > 0) sL *= dim;
    if (sW > 0) sW *= dim;
    const sD = sW - sL;
    const row = cy * cw;
    for (let cx = 0; cx < cw; cx++) {
      const c = row + cx;
      // Temperature from the shared climate formula (+ this month's regional anomaly).
      const t = bT[c] + off + amp[c] * (sL + sD * mar[c]) + anomC[c];
      // Semi-Lagrangian back-trace and bilinear sample.
      const u = uE[c], v = vE[c];
      const sx = Math.min(cw - 1, Math.max(0, cx - u * dtc)), sy = Math.min(ch - 1, Math.max(0, cy - v * dtc));
      const x0 = Math.min(cw - 2, Math.floor(sx)), y0 = Math.min(ch - 2, Math.floor(sy));
      const tx = sx - x0, ty = sy - y0;
      const k00 = y0 * cw + x0;
      const qa = q[k00] + (q[k00 + 1] - q[k00]) * tx, qb = q[k00 + cw] + (q[k00 + cw + 1] - q[k00 + cw]) * tx;
      let qq = qa + (qb - qa) * ty;
      // Saturation capacity (inlined table lookup of qsat).
      const uq = (Math.min(QS_HI, Math.max(QS_LO, t)) - QS_LO) * QS_INV;
      const kq = Math.floor(uq), q0 = qsT[kq];
      const qs = q0 + (qsT[kq + 1] - q0) * (uq - kq);
      const iqs = 1 / qs;
      const r = qq * iqs;
      const lift = u * gx[c] + v * gy[c];
      const dryF = 1 - Math.min(0.85, Math.max(0, -lift) * 30);
      const ia = instA[c];
      const conv = Math.min(1, Math.max(0, (t - 15) * 0.0769)) * Math.max(0, r - 0.5) * (0.35 + ia + (instB[c] - ia) * nf);
      let P = (kCond * Math.max(0, qq - rhc * qs)
        + qq * (K_ORO * Math.max(0, lift) * Math.min(1, r * 1.6) + convK * conv + kFront * front[c] * Math.min(1, r * 2))) * dryF;
      P = Math.min(P, qq * pCap);
      const E = kE * surfL[c] * Math.max(0, qs - qq);
      qq = Math.max(0, qq + (E - P) * dt);
      const q2c = Math.min(qq, qs * 1.6);
      q2[c] = q2c;
      const raw = P * RAIN_SCALE;
      const relClim = raw * corr[c];
      const rel = relClim * pMult[c];
      rainF[c] = Math.min(25, rel * hpRel);
      if (useAcc) acc[c] += raw;
      if (useCal) cal[c] += relClim;
      const rhv = Math.min(1, q2c * iqs);
      rh[c] = rhv;
      const sr = Math.min(1, Math.max(0, (rhv - 0.62) * 2.7777778));
      const cl = sr * sr * (3 - 2 * sr) * 0.55 + Math.min(0.6, rel * bM[c] * 0.9) + front[c] * 0.25;
      cloudF[c] = Math.min(1, cl * (0.55 + 0.45 * dryF));
    }
  }
}

/** This month's regional temperature anomaly at each cell centre (cached per month). */
function cellAnomaly(world, s, day) {
  const key = Math.floor(day / 30);
  const a = s.anomC;
  const anomT = world.cache.natAnomTile;
  if (s.anomKey !== key || s.anomSrc !== anomT) {
    if (anomT && anomT.length === world.N) for (let c = 0; c < s.cn; c++) a[c] = fin(anomT[s.ctr[c]]);
    else a.fill(0);
    s.anomKey = key; s.anomSrc = anomT || null;
  }
  return a;
}

/**
 * Genesis spin-up: run the model for ~1.3 years, then set the climatology so that each
 * cell's mean relative rain is 1.
 */
export function spinUp(world, lows) {
  const s = wxStatics(world);
  const f = world.f;
  const { cn } = s;
  const corr = f.wxCorr;
  corr.fill(1);
  s.pMult.fill(1);
  for (let c = 0; c < cn; c++) f.wxQ[c] = qsat(s.bT[c] + fin(world.climate.tempOffset)) * (0.5 + 0.3 * s.fo[c]);
  const acc = new Float32Array(cn);
  const DT = 2, warm = 60, measure = 180;
  const d0 = world.time.day - (warm + measure) * DT;
  for (let k = 0; k < warm + measure; k++) step(world, DT, { day: d0 + k * DT, lows, accumulate: k >= warm ? acc : null });
  let lo = 0;
  for (let c = 0; c < cn; c++) {
    const m = acc[c] / measure;
    if (m < 0.003) lo++;
    corr[c] = 1 / Math.max(0.003, m);
  }
  f.wxRain.fill(1);
  return { lo };
}

/**
 * In-simulation refinement (first CAL_YEARS years): nudge the climatology so mean relative
 * rain (anomalies excluded) returns to 1 once vegetation and soils have settled.
 */
export function calibrateYear(world, sys) {
  const f = world.f;
  const n = sys.calSteps || 0;
  if (n < 30) return;
  const k = [0.85, 0.7, 0.55, 0.4][Math.min(3, sys.calYears || 0)];
  const cal = f.wxCal, corr = f.wxCorr;
  for (let c = 0; c < cal.length; c++) {
    const m = cal[c] / n;
    if (m > 0.02) corr[c] = clampR(corr[c] * Math.pow(1 / m, k), 1e-3, 400);
  }
  cal.fill(0);
  sys.calSteps = 0;
  sys.calYears = (sys.calYears || 0) + 1;
}

// ---------------------------------------------------------------------------
// Upsampling to tiles.
//   upsample(): exact bilinear interpolation of a coarse field over every tile (used yearly
//               for the annual rain normal).
//   upBands():  the frequent refresh of cloud, humidity and rain, in bands of BAND rows.

/** Tile rows per refresh band. */
export const BAND = 4;

function cellWeights(world) {
  let w = world.cache.natCellW;
  if (w && w.length === C) return w;
  w = world.cache.natCellW = new Float64Array(C);
  for (let k = 0; k < C; k++) w[k] = (k + 0.5) / C - 0.5; // offset from the cell centre, in cells
  return w;
}

/** Interpolate one row of coarse values rb (length cw) into dst[o .. o + cw·C), × fac, clamped to [0, hi]. */
function cellRowScaled(rb, cw, wk, dst, fac, hi, o) {
  const half = C >> 1;
  for (let c = 0; c < cw; c++) {
    const b = rb[c];
    const a = c > 0 ? rb[c - 1] : b, d = c < cw - 1 ? rb[c + 1] : b;
    const ab = b - a, bd = d - b;
    for (let k = 0; k < half; k++) dst[o + k] = Math.min(hi, Math.max(0, (b + ab * wk[k]) * fac[o + k]));
    for (let k = half; k < C; k++) dst[o + k] = Math.min(hi, Math.max(0, (b + bd * wk[k]) * fac[o + k]));
    o += C;
  }
}

function vertical(u, src, rb, y) {
  const cw = u.cw, r0 = u.cy0[y] * cw, r1 = r0 + cw, ty = u.wy[y];
  for (let c = 0; c < cw; c++) { const a = src[r0 + c]; rb[c] = a + (src[r1 + c] - a) * ty; }
}

function genericUp(world, src, dst, lo, hi, fac) {
  const u = upTables(world, C);
  const { W, H } = world;
  const cx0 = u.cx0, wx = u.wx, rb = u.rowA;
  for (let y = 0; y < H; y++) {
    vertical(u, src, rb, y);
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const c = cx0[x], a = rb[c];
      const v = a + (rb[c + 1] - a) * wx[x];
      dst[row + x] = Math.min(hi, Math.max(lo, fac ? v * fac[row + x] : v));
    }
  }
}

/** Upsample a coarse field into every tile, × a per-tile factor (or 1), clamped to [0, hi]. */
export function upsample(world, src, dst, hi = 1, fac = null) {
  const u = upTables(world, C);
  const { W, H } = world;
  if (u.cw * C !== W || !fac) { genericUp(world, src, dst, 0, hi, fac); return; }
  const wk = cellWeights(world), rb = u.rowA, cw = u.cw;
  for (let y = 0; y < H; y++) {
    vertical(u, src, rb, y);
    cellRowScaled(rb, cw, wk, dst, fac, hi, y * W);
  }
}

/** Vertical position (coarse row, weight) of a tile-row centre yc (may be fractional). */
function vpos(yc, ch) {
  const fy = (yc + 0.5) / C - 0.5;
  let r = Math.floor(fy), t = fy - r;
  if (r < 0) { r = 0; t = 0; }
  if (r > ch - 2) { r = ch - 2; t = 1; }
  return [r, Math.min(1, Math.max(0, t))];
}

/**
 * Band geometry (cache). Bands are BAND = 4 rows; humidity and rain use the band centre,
 * cloud (the visible field) the centres of the band's two row pairs.
 */
function bandTables(world) {
  let b = world.cache.natBands;
  if (b && b.W === world.W && b.H === world.H) return b;
  const u = upTables(world, C);
  const { W, H } = world;
  const nb = Math.ceil(H / BAND);
  const y0 = new Int32Array(nb), c0 = new Int32Array(nb), wv = new Float32Array(nb);
  const pc = new Int32Array(nb * 2), pw = new Float32Array(nb * 2);
  for (let k = 0; k < nb; k++) {
    const a = k * BAND, e = Math.min(H, a + BAND);
    const [r, t] = vpos((a + e - 1) / 2, u.ch);
    y0[k] = a; c0[k] = r; wv[k] = t;
    for (let p = 0; p < 2; p++) {
      const pa = Math.min(e - 1, a + 2 * p), pe = Math.min(e, pa + 2);
      const [rp, tp] = vpos((pa + pe - 1) / 2, u.ch);
      pc[2 * k + p] = rp; pw[2 * k + p] = tp;
    }
  }
  const cw = u.cw;
  b = world.cache.natBands = {
    W, H, nb, y0, c0, wv, pc, pw, fast: C === 8 && cw * C === W,
    rowC: new Float32Array(W), rowH: new Float32Array(W), rowR: new Float32Array(W), rb: new Float64Array(cw),
  };
  return b;
}

/**
 * One tile row of a coarse field: rows r and r + 1 blended by t, then interpolated
 * bilinearly along x into out. Fast path for 8-tile cells with fixed sub-cell weights.
 */
function bandRow(src, r, t, out, rb, cw, fast, cx0, wx) {
  const r0 = r * cw, r1 = r0 + cw;
  for (let c = 0; c < cw; c++) { const a = src[r0 + c]; rb[c] = a + (src[r1 + c] - a) * t; }
  if (fast) {
    let o = 0;
    for (let c = 0; c < cw; c++) {
      const b = rb[c];
      const ab = c > 0 ? b - rb[c - 1] : 0, bd = c < cw - 1 ? rb[c + 1] - b : 0;
      out[o] = b - 0.4375 * ab; out[o + 1] = b - 0.3125 * ab; out[o + 2] = b - 0.1875 * ab; out[o + 3] = b - 0.0625 * ab;
      out[o + 4] = b + 0.0625 * bd; out[o + 5] = b + 0.1875 * bd; out[o + 6] = b + 0.3125 * bd; out[o + 7] = b + 0.4375 * bd;
      o += 8;
    }
    return;
  }
  const W = out.length;
  for (let x = 0; x < W; x++) { const c = cx0[x], a = rb[c]; out[x] = a + (rb[c + 1] - a) * wx[x]; }
}

/**
 * Refresh tile cloud, humidity and land rain for bands k ≡ phase (mod K). Interpolated
 * rows are computed once per band (per row pair for cloud) and copied to the band's rows
 * natively; rain is the relative rain × baseMoisture on every land tile. With `water`,
 * only rain over water is refreshed (display only; done monthly). Inputs are convex
 * combinations of in-range coarse values, so no clamping is needed for cloud/humidity.
 */
export function upBands(world, phase = 0, K = 1, water = false) {
  const f = world.f;
  if (!f.wxRH || !f.wxRain || !f.wxCloud) return;
  const u = upTables(world, C), bt = bandTables(world);
  const runs = tileRuns(world, water ? 'water' : 'land');
  bandsKernel(phase, K, water ? 1 : 0, bt.nb, world.W, world.H, u.cw, bt.fast ? 1 : 0, u.cx0, u.wx, bt.y0, bt.c0, bt.wv, bt.pc, bt.pw,
    bt.rb, bt.rowC, bt.rowH, bt.rowR, f.wxCloud, f.wxRH, f.wxRain, f.cloud, f.humidity, f.rain, f.baseMoisture, runs.runs, runs.rowStart);
}

function bandsKernel(phase, K, water, nb, W, H, cw, fast, cx0, wx, y0s, c0s, wvs, pcs, pws, rb, rowC, rowH, rowR,
  srcC, srcH, srcR, cloud, hum, rain, bM, R, rs) {
  for (let k = phase; k < nb; k += K) {
    const yA = y0s[k], yE = Math.min(H, yA + BAND);
    bandRow(srcR, c0s[k], wvs[k], rowR, rb, cw, fast, cx0, wx);
    if (!water) {
      bandRow(srcH, c0s[k], wvs[k], rowH, rb, cw, fast, cx0, wx);
      for (let y = yA; y < yE; y++) hum.set(rowH, y * W);
      for (let p = 0; p < 2; p++) {
        const pa = yA + 2 * p;
        if (pa >= yE) break;
        bandRow(srcC, pcs[2 * k + p], pws[2 * k + p], rowC, rb, cw, fast, cx0, wx);
        cloud.set(rowC, pa * W);
        if (pa + 1 < yE) cloud.set(rowC, (pa + 1) * W);
      }
    }
    for (let y = yA; y < yE; y++) {
      const row = y * W;
      for (let q = rs[y]; q < rs[y + 1]; q++) {
        const b = R[2 * q + 1];
        for (let i = R[2 * q]; i < b; i++) rain[i] = Math.min(1, rowR[i - row] * bM[i]);
      }
    }
  }
}

/** Sample the coarse relative rain into the annual accumulator (wxAcc). */
export function sampleRain(world) {
  const acc = world.f.wxAcc, r = world.f.wxRain;
  for (let c = 0; c < acc.length; c++) acc[c] += Math.min(25, Math.max(0, r[c]));
}

/**
 * Yearly: annRain moves toward this year's mean (baseMoisture × mean relative rain).
 * n = number of samples accumulated in wxAcc. Returns true if applied.
 */
export function annualRain(world, n) {
  const { N, f } = world;
  if (!(n > 0) || !f.wxAcc) return false;
  let tmp = world.cache.natUpTmp;
  if (!tmp || tmp.length !== N) tmp = world.cache.natUpTmp = new Float32Array(N);
  const acc = f.wxAcc;
  const inv = 1 / n;
  for (let c = 0; c < acc.length; c++) acc[c] *= inv;
  upsample(world, acc, tmp, 25, f.baseMoisture);
  const ar = f.annRain;
  for (let i = 0; i < N; i++) ar[i] = Math.min(1, Math.max(0, ar[i] + (tmp[i] - ar[i]) * 0.5));
  acc.fill(0);
  return true;
}
