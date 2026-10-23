// Stage 5 · Climate baseline. Genesis winds, temperature and precipitation:
//   - wind bands: trade winds (E→W) 0–30°, westerlies 30–60°, polar easterlies, with a
//     gentle meridional component, belts that meander by ≈ ±5° of latitude, noise, and
//     deflection along mountain flanks;
//   - moisture: a steady-state advection model on a half-resolution grid — ocean
//     evaporation by temperature, transport along the wind, rain-out by latitude band
//     (ITCZ, subtropical highs, storm tracks), orographic lift on windward slopes, dry
//     descending air in the lee, condensation of air pushed over colder ground, and
//     recycling by land vegetation. Rain shadows and dry interiors emerge from it;
//   - temperature: latitude profile (≈ 27 °C equator → −25 °C poles), −6.5 °C/km lapse,
//     maritime moderation from an advected "ocean air" tracer.
// baseTemp excludes params.baseTemperature (climate adds it at run time). Genesis snow is
// the perennial cover only (polar caps, glaciated peaks); the climate system builds the
// seasonal pack from there.

import { createNoise2D } from '../core/rng.js';
import { clamp, clamp01, smoothstep } from '../core/util.js';
import { WATER } from '../core/constants.js';
import { ensureField, latitude } from '../core/world.js';
import { fbmL, octavesFor, boxBlur, num } from './grid.js';

export const LAPSE = 6.5;              // °C per km
const KM_PER_E = 14;                   // (e − 0.5) × 14 = km above genesis sea level

/** Sea-level annual mean temperature (°C) at |latitude| alat ∈ [0, 1]. */
export const latitudeTemp = (alat) => 27 - 52 * Math.pow(alat, 1.8);
/** Height above the genesis sea level, km (0 for anything at or below it). */
export const heightKm = (e) => (e > 0.5 ? (e - 0.5) * KM_PER_E : 0);

const g = (x, mu, s) => { const t = (x - mu) / s; return Math.exp(-t * t); };

const PR_SEA = 3.6;      // rain-out per normalised time over the sea
const PR_LAND = 3.6;     // … and over land
const RECYCLE = 0.62;    // share of land rain returned by evapotranspiration (more in the deep tropics)
const KM = 0.2;          // precipitation rate → moisture index (1 ≈ 3000 mm/yr)

/** Zonal wind profile at |latitude| (fraction of 90°): + eastward. Easterlies persist
 *  (weaker) right across the equator; calm belts near 30° and 60°. */
const zonal = (alat) => (alat < 1 / 6 ? -(0.6 + 0.4 * Math.sin(3 * Math.PI * alat)) : -Math.sin(3 * Math.PI * alat));

/** Precipitation efficiency by latitude band (φ in degrees). */
function rainBand(phi) {
  return Math.max(0.12, 1 + 1.15 * g(phi, 0, 10) - 0.72 * g(phi, 26, 8) + 0.6 * g(phi, 51, 12) - 0.3 * smoothstep(62, 88, phi));
}

export function buildClimate(world) {
  const { W, H, N, f, params, seed } = world;
  const e = f.elevation, water = f.water;
  const windK = Math.max(0, num(params.windStrength, 1));
  const humid = Math.max(0, num(params.humidity, 1));

  // ------------------------------------------------------------------ winds
  const nwa = createNoise2D(seed + ':wind-angle'), nws = createNoise2D(seed + ':wind-speed');
  const oW = octavesFor(H, 2.2, 3);
  const land = new Float32Array(N), sm = new Float32Array(N), tmp = new Float32Array(N);
  for (let i = 0; i < N; i++) land[i] = e[i] > 0.5 ? e[i] : 0.5;
  boxBlur(W, H, land, sm, tmp, Math.max(1, Math.round(H / 80)));
  const bwx = new Float32Array(N), bwy = new Float32Array(N);    // unscaled wind
  const nwb = createNoise2D(seed + ':wind-belts');
  const oB = octavesFor(H, 1.8, 3);
  for (let y = 0; y < H; y++) {
    const lat = latitude(world, y), alat0 = Math.abs(lat);
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, u = (x + 0.5) / H;
      // the belts meander (± ≈ 5° of latitude), so calm lines and fronts are never ruled
      const alat = clamp01(alat0 + 0.055 * fbmL(nwb, u * 1.8, v * 1.8, 3, oB));
      const u0 = zonal(alat);
      const veq = -0.4 * u0;                       // + toward the equator
      const vy0 = lat >= 0 ? veq : -veq;
      const ang = 0.42 * fbmL(nwa, u * 2.2, v * 2.2, 3, oW);
      const sp = 1 + 0.2 * fbmL(nws, u * 2.2, v * 2.2, 3, oW);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let wx = (u0 * ca - vy0 * sa) * sp, wy = (u0 * sa + vy0 * ca) * sp;
      // deflect along mountain flanks: remove part of the upslope component
      const xm = x > 0 ? i - 1 : i, xp = x < W - 1 ? i + 1 : i;
      const ym = y > 0 ? i - W : i, yp = y < H - 1 ? i + W : i;
      const gx = (sm[xp] - sm[xm]) * H / ((xp - xm) || 1), gy = (sm[yp] - sm[ym]) * H / (((yp - ym) / W) || 1);
      const gm = Math.hypot(gx, gy);
      if (gm > 1e-4) {
        const up = (wx * gx + wy * gy) / gm;
        if (up > 0) {
          const a = 0.75 * clamp01(gm / 8) * clamp01((sm[i] - 0.55) / 0.15);
          wx -= a * up * gx / gm; wy -= a * up * gy / gm;
        }
      }
      bwx[i] = wx; bwy[i] = wy;
      f.windX[i] = wx * windK; f.windY[i] = wy * windK;
    }
  }

  // ------------------------------------------------- coarse moisture model
  const CW = Math.ceil(W / 2), CH = Math.ceil(H / 2), CN = CW * CH;
  const dt = 2 / H;                                    // normalised time (and length) per step
  const cLand = new Float32Array(CN), cE = new Float32Array(CN), cWx = new Float32Array(CN), cWy = new Float32Array(CN);
  const cnt = new Float32Array(CN);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = (y >> 1) * CW + (x >> 1);
    cnt[c]++;
    if (water[i] !== WATER.OCEAN) cLand[c]++;
    cE[c] += e[i] > 0.5 ? e[i] : 0.5;
    cWx[c] += bwx[i]; cWy[c] += bwy[i];
  }
  const cT = new Float32Array(CN), cCap = new Float32Array(CN), cRate = new Float32Array(CN), cPhi = new Float32Array(CN);
  const cUp = new Float32Array(CN), cSub = new Float32Array(CN), cMix = new Float32Array(CN), cRec = new Float32Array(CN);
  for (let c = 0; c < CN; c++) {
    const k = cnt[c] || 1;
    cLand[c] /= k; cE[c] /= k;
    // transport wind (cells per step): scaled by windStrength with a convective floor
    let wx = cWx[c] / k * windK, wy = cWy[c] / k * windK;
    const wm = Math.hypot(wx, wy);
    if (wm > 1e-6 && wm < 0.25) { wx *= 0.25 / wm; wy *= 0.25 / wm; }
    cWx[c] = wx; cWy[c] = wy;
  }
  for (let cy = 0; cy < CH; cy++) {
    const v = (2 * cy + 1) / H;
    const alat = Math.abs(1 - 2 * v);
    const phi = alat * 90;
    for (let cx = 0; cx < CW; cx++) {
      const c = cy * CW + cx;
      cPhi[c] = phi;
      const T = latitudeTemp(alat) - LAPSE * heightKm(cE[c]);
      cT[c] = T;
      cSub[c] = g(phi, 26, 8);
      // deep tropical convection mixes moisture inland; eddies along the subtropical and
      // polar fronts carry it across the calm belts
      cMix[c] = 1 + 1.6 * g(phi, 0, 14) + 0.5 * g(phi, 30, 7) + 1.1 * g(phi, 60, 8);
      cRec[c] = (RECYCLE + 0.18 * g(phi, 0, 15)) * clamp01((T + 6) / 24);
      cCap[c] = Math.exp(0.04 * (T - 27)) * (1 - 0.38 * g(phi, 27, 9));
      cRate[c] = rainBand(phi);
      // slope along the wind, per normalised unit of distance
      const xm = cx > 0 ? c - 1 : c, xp = cx < CW - 1 ? c + 1 : c;
      const ym = cy > 0 ? c - CW : c, yp = cy < CH - 1 ? c + CW : c;
      const gx = (cE[xp] - cE[xm]) / (((xp - xm) || 1) * dt), gy = (cE[yp] - cE[ym]) / ((((yp - ym) / CW) || 1) * dt);
      const wm = Math.hypot(cWx[c], cWy[c]);
      cUp[c] = wm > 1e-6 ? (cWx[c] * gx + cWy[c] * gy) / wm : 0;
    }
  }
  let M = new Float32Array(CN), O = new Float32Array(CN), Mn = new Float32Array(CN), On = new Float32Array(CN);
  const Pacc = new Float32Array(CN);
  for (let c = 0; c < CN; c++) { M[c] = cLand[c] < 0.5 ? cCap[c] * 0.9 : 0.1; O[c] = cLand[c] < 0.5 ? 1 : 0; }
  const kappa = clamp(0.00225 * H / 2, 0.02, 0.36);    // eddy mixing per step (×cMix ≤ 2.6 → stays < 1)
  const iters = CH + 24, accFrom = iters - 16;
  const sample = (A, x, y) => {
    if (x < 0) x = 0; else if (x > CW - 1) x = CW - 1;
    if (y < 0) y = 0; else if (y > CH - 1) y = CH - 1;
    const x0 = x | 0, y0 = y | 0, x1 = x0 < CW - 1 ? x0 + 1 : x0, y1 = y0 < CH - 1 ? y0 + 1 : y0;
    const fx = x - x0, fy = y - y0;
    const a = A[y0 * CW + x0], b = A[y0 * CW + x1], cc = A[y1 * CW + x0], d = A[y1 * CW + x1];
    return (a + (b - a) * fx) * (1 - fy) + (cc + (d - cc) * fx) * fy;
  };
  for (let it = 0; it < iters; it++) {
    for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
      const c = cy * CW + cx;
      const bx = cx - cWx[c], by = cy - cWy[c];
      let m = sample(M, bx, by), o = sample(O, bx, by);
      // convective mixing with neighbours
      const l = cx > 0 ? M[c - 1] : M[c], r = cx < CW - 1 ? M[c + 1] : M[c];
      const t = cy > 0 ? M[c - CW] : M[c], b = cy < CH - 1 ? M[c + CW] : M[c];
      const kp = kappa * cMix[c];
      m = m * (1 - kp) + kp * 0.25 * (l + r + t + b);
      const cap = cCap[c];
      const isSea = cLand[c] < 0.5;
      if (isSea) { m += (cap * 0.92 - m) * 0.6; o = 1; }
      else o *= 1 - 2.0 * dt;
      // rain-out
      const up = cUp[c];
      const oro = up > 0 ? 1 + 1.8 * Math.min(2, up / 5) : 1 - 0.55 * Math.min(1, -up / 5);
      let band = cRate[c];
      if (!isSea) band += 0.45 * o * cSub[c];             // coasts in the dry belt still catch showers
      const rate = Math.min(0.9, (isSea ? PR_SEA : PR_LAND) * band * oro * dt);
      let p = m * rate + (m > cap ? (m - cap) * 0.35 : 0);
      if (p > m) p = m;
      m -= p;
      // evapotranspiration returns part of the rain to the air (less over cold ground)
      if (!isSea) m += p * cRec[c] * cLand[c];
      Mn[c] = m > 0 ? m : 0; On[c] = o;
      if (it >= accFrom) Pacc[c] += p;
    }
    let s = M; M = Mn; Mn = s;
    s = O; O = On; On = s;
  }
  const accN = iters - accFrom;
  for (let c = 0; c < CN; c++) Pacc[c] = Pacc[c] / accN / dt;           // per normalised time
  const cRH = new Float32Array(CN);
  for (let c = 0; c < CN; c++) cRH[c] = clamp01(M[c] / Math.max(1e-4, cCap[c]));

  // ----------------------------------------------------- tiles: T and rain
  const nT = createNoise2D(seed + ':temp-anom'), nP = createNoise2D(seed + ':rain-anom');
  const oT = octavesFor(H, 3, 3), oP = octavesFor(H, 3.5, 4);
  const slt = ensureField(world, 'seaLevelTemp', Float32Array);
  const upT = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const xm = x > 0 ? i - 1 : i, xp = x < W - 1 ? i + 1 : i;
    const ym = y > 0 ? i - W : i, yp = y < H - 1 ? i + W : i;
    const gx = (sm[xp] - sm[xm]) * H / ((xp - xm) || 1), gy = (sm[yp] - sm[ym]) * H / (((yp - ym) / W) || 1);
    const wm = Math.hypot(bwx[i], bwy[i]);
    upT[i] = wm > 1e-6 ? (bwx[i] * gx + bwy[i] * gy) / wm : 0;
  }
  let sumT = 0, sumLT = 0, nL = 0;
  const baseT = params.baseTemperature != null ? num(params.baseTemperature, 0) : 0;
  for (let y = 0; y < H; y++) {
    const lat = latitude(world, y), alat = Math.abs(lat);
    const Tl = latitudeTemp(alat);
    const v = (y + 0.5) / H;
    const cyf = (y - 0.5) / 2;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, u = (x + 0.5) / H;
      const cxf = (x - 0.5) / 2;
      const mar = clamp01(sample(O, cxf, cyf));
      const sea = water[i] === WATER.OCEAN;
      let T0;
      if (sea) T0 = Tl + 3 * smoothstep(0.45, 0.95, alat);
      else {
        T0 = Tl + mar * (4.5 * smoothstep(0.3, 0.8, alat) - 1.2 * (1 - smoothstep(0.1, 0.45, alat)))
          - (1 - mar) * 2.5 * smoothstep(0.35, 0.85, alat);
      }
      T0 += 0.9 * fbmL(nT, u * 3, v * 3, 3, oT);
      slt[i] = T0;
      const bt = T0 - (sea ? 0 : LAPSE * heightKm(e[i]));
      f.baseTemp[i] = bt;
      const at = bt + baseT;
      f.temp[i] = at; f.annTemp[i] = at;
      sumT += at;
      if (!sea && water[i] === WATER.LAND) { sumLT += at; nL++; }

      // precipitation: coarse field, sharpened by tile-scale orography, with noise
      const pc = sample(Pacc, cxf, cyf);
      const uc = sample(cUp, cxf, cyf);
      const ot = clamp(upT[i] / 5, -1, 2), oc = clamp(uc / 5, -1, 2);
      const fac = clamp(1 + 0.45 * (ot - oc), 0.55, 1.8);
      const nz = 1 + 0.14 * fbmL(nP, u * 3.5, v * 3.5, 4, oP);
      const m = clamp01(KM * pc * fac * nz * humid);
      f.baseMoisture[i] = m;
      f.rain[i] = m; f.annRain[i] = m; f.soilWater[i] = m;
      const rh = clamp01(sample(cRH, cxf, cyf));
      f.humidity[i] = clamp01(0.15 + 0.8 * rh * Math.min(1, 0.4 + humid * 0.6));
      f.cloud[i] = clamp01((0.08 + 0.72 * Math.sqrt(m)) * (0.55 + 0.45 * rh));
      // perennial snow and sea ice at genesis (polar caps, glaciated peaks): land needs a
      // cold annual mean (≈ −8 °C for full cover) and some snowfall; the seasonal pack is
      // the climate system's to build from here
      let snow;
      if (sea) snow = clamp01((-3 - at) / 9);
      else snow = smoothstep(-3, -11, at) * (0.35 + 0.65 * clamp01(m / 0.12));
      f.snow[i] = snow;
    }
  }
  if (world.climate) {
    world.climate.avgTemp = sumT / Math.max(1, N);
    world.climate.avgLandTemp = nL ? sumLT / nL : world.climate.avgTemp;
  }
}
