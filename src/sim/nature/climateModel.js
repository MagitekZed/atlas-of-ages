// The climate formulas shared by climate.js (tile temperatures) and weather.js
// (coarse-cell temperatures for the moisture model): seasonal phase per row,
// seasonal amplitude per tile (latitude × continentality), saturation humidity
// and potential evapotranspiration. Keeping them here guarantees both systems
// agree on what the temperature of a place is on a given day.

import { WATER } from '../../core/constants.js';
import { latitude } from '../../core/world.js';
import { ss, fin } from './common.js';

const TAU = Math.PI * 2;
const REF_TILT = Math.sin((23.44 * Math.PI) / 180);
/** Thermal lag (fraction of a year) of land and open water behind the solar cycle. */
export const LAG_LAND = 0.045;
export const LAG_WATER = 0.12;

/** Seasonal strength from axial tilt (1 at Earth's 23.4°, 0 at no tilt, ~1.75 at 45°). */
export function tiltFactor(world) {
  const t = Math.min(60, Math.max(0, fin(world.params.axialTilt, 23)));
  return Math.sin((t * Math.PI) / 180) / REF_TILT;
}

/** Smooth hemisphere sign: 0 at the equator, ±1 beyond ~11° latitude. */
export const hemiOf = (lat) => Math.min(1, Math.max(-1, lat * 8));

/**
 * Global seasonal phase values for a day: sL / sW = −cos(phase − lag) for land / water
 * (−1 at northern midwinter, +1 at northern midsummer, lagged).
 */
export function seasonPhase(world, day = world.time.day) {
  const yp = ((day + 15) % 360) / 360;
  return { sL: -Math.cos(TAU * (yp - LAG_LAND)), sW: -Math.cos(TAU * (yp - LAG_WATER)), yp };
}

/**
 * Row factors: the seasonal multiplier for land / water tiles in row y, including
 * hemisphere sign, tilt, and the summer-dimming of a stratospheric aerosol veil.
 */
export function rowSeason(world, y, ph, tf, aerosol) {
  const h = hemiOf(latitude(world, y));
  let L = h * ph.sL, Wt = h * ph.sW;
  const dim = 1 - 0.45 * Math.min(1, Math.max(0, aerosol));
  if (L > 0) L *= dim;
  if (Wt > 0) Wt *= dim;
  return { L: L * tf, W: Wt * tf };
}

/**
 * Seasonal amplitude (°C, half the summer–winter swing, before tilt) and maritime lag
 * weight per tile. Cached; rebuilt when the water mask changes.
 */
export function ampCache(world) {
  const v = world.versions.water;
  let c = world.cache.natAmp;
  if (c && c.v === v && c.N === world.N) return c;
  const { W, H, N, f } = world;
  const amp = new Float32Array(N), mar = new Float32Array(N);
  const water = f.water, distCoast = f.distCoast;
  for (let y = 0; y < H; y++) {
    const al = Math.abs(latitude(world, y));
    const latTerm = Math.pow(al, 1.25);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const w = water[i];
      if (w === WATER.OCEAN) {
        amp[i] = 0.8 + 6.5 * latTerm;
        mar[i] = 1;
      } else if (w === WATER.LAKE) {
        amp[i] = (1.0 + 20 * latTerm) * 0.75;
        mar[i] = 0.55;
      } else {
        const dc = distCoast[i];
        const cont = 0.38 + 0.62 * ss(0, 18, dc);
        amp[i] = (1.2 + 22.5 * latTerm) * cont;
        mar[i] = 0.5 * (1 - ss(0, 5, dc));
      }
    }
  }
  c = world.cache.natAmp = { v, N, amp, mar };
  return c;
}

// ---------------------------------------------------------------------------
// Moisture physics

/** Saturation vapour capacity (relative units, 1 at 25 °C; Clausius–Clapeyron-like). */
export const QS_LO = -70, QS_HI = 60, QS_STEP = 0.25, QS_INV = 1 / QS_STEP;
const QS_TABLE = (() => {
  const n = Math.round((QS_HI - QS_LO) / QS_STEP) + 2;
  const t = new Float64Array(n);
  for (let k = 0; k < n; k++) t[k] = 0.03 + Math.exp(0.052 * (QS_LO + k * QS_STEP - 25));
  return t;
})();
/** The table itself, for loops that inline the lookup (read-only). */
export const QS_TAB = QS_TABLE;
export function qsat(T) {
  const u = (Math.min(QS_HI, Math.max(QS_LO, T)) - QS_LO) / QS_STEP;
  const k = Math.floor(u);
  const a = QS_TABLE[k];
  return a + (QS_TABLE[k + 1] - a) * (u - k);
}

/** Potential evapotranspiration in rain units per year (1 ≈ 3000 mm). */
export const pet = (T) => 0.05 + 0.022 * Math.max(0, T);

/** Soil-water tendency (per year, before the capacity divisor). Shared by weather and its init. */
export function soilTendency(r, T, s, veg, snow) {
  const frozen = ss(1, -3, T);
  const inf = r * (0.85 - 0.6 * s * s * s) * (1 - 0.75 * frozen);
  const e = pet(T) * (1 - 0.9 * frozen) * (1 - 0.8 * snow) * Math.min(1, s / 0.7) * (0.45 + 0.55 * veg);
  const s2 = s * s;
  return inf - e - 0.25 * s2 * s2;
}
/** Soil column capacity in rain-years (≈ 360 mm). */
export const SOIL_CAP = 0.12;

/** Equilibrium soil water for annual-mean inputs (bisection; used at genesis). */
export function soilEquilibrium(r, T, veg) {
  let lo = 0, hi = 1;
  for (let k = 0; k < 18; k++) {
    const m = 0.5 * (lo + hi);
    if (soilTendency(r, T, m, veg, 0) > 0) lo = m; else hi = m;
  }
  return 0.5 * (lo + hi);
}
