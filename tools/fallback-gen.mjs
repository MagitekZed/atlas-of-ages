// A deliberately simple world generator used only by the headless runner when the real
// generator (src/gen/worldgen.js) is missing or explicitly bypassed (--gen fallback).
// It fills every gen-owned field so simulation systems can be tested in isolation.

import { createNoise2D, fbm, ridged } from '../src/core/rng.js';
import { BIOME, WATER } from '../src/core/constants.js';
import { latitude } from '../src/core/world.js';
import { DX8, DY8, clamp01 } from '../src/core/util.js';

export function fallbackGenerate(world) {
  const { W, H, N, f, params } = world;
  const ne = createNoise2D(world.seed + ':e'), nm = createNoise2D(world.seed + ':m'), nr = createNoise2D(world.seed + ':r');
  const aspect = W / H;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const nx = (x / W) * 3 * aspect, ny = (y / H) * 3;
    let e = fbm(ne, nx, ny, 6) * 0.5 + 0.5;
    e += ridged(nr, nx * 1.3, ny * 1.3, 4) * 0.25 * params.mountainHeight;
    const edge = Math.min(x, y, W - 1 - x, H - 1 - y) / (Math.min(W, H) * 0.12);
    e *= 0.55 + 0.45 * clamp01(edge);
    f.elevation[i] = e;
  }
  const sorted = Float32Array.from(f.elevation).sort();
  const sea = sorted[Math.floor(N * params.oceanCoverage)];
  Object.assign(world.climate, { seaLevel: sea, baseSeaLevel: sea, appliedSeaLevel: sea });
  let max = sorted[N - 1];
  for (let i = 0; i < N; i++) {
    const e = f.elevation[i];
    f.elevation[i] = e < sea ? (e / sea) * 0.5 : 0.5 + ((e - sea) / (max - sea)) * 0.5;
  }
  Object.assign(world.climate, { seaLevel: 0.5, baseSeaLevel: 0.5, appliedSeaLevel: 0.5 });

  for (let i = 0; i < N; i++) f.water[i] = f.elevation[i] < 0.5 ? WATER.OCEAN : WATER.LAND;

  // coast, distance to coast, landmass
  const q = new Int32Array(N); let qh = 0, qt = 0;
  f.distCoast.fill(65535);
  for (let i = 0; i < N; i++) {
    if (f.water[i]) continue;
    const x = i % W, y = (i / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && f.water[ny * W + nx] === WATER.OCEAN) { f.coast[i] = 1; break; }
    }
    if (f.coast[i]) { f.distCoast[i] = 0; q[qt++] = i; }
  }
  while (qh < qt) {
    const i = q[qh++], x = i % W, y = (i / W) | 0;
    for (let d = 0; d < 8; d += 2) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (f.water[j] || f.distCoast[j] <= f.distCoast[i] + 1) continue;
      f.distCoast[j] = f.distCoast[i] + 1; q[qt++] = j;
    }
  }
  for (let i = 0; i < N; i++) if (f.water[i]) f.distCoast[i] = 0;
  f.landmass.fill(-1);
  let lm = 0;
  for (let s = 0; s < N; s++) {
    if (f.water[s] || f.landmass[s] >= 0) continue;
    qh = qt = 0; q[qt++] = s; f.landmass[s] = lm;
    while (qh < qt) {
      const i = q[qh++], x = i % W, y = (i / W) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (f.water[j] || f.landmass[j] >= 0) continue;
        f.landmass[j] = lm; q[qt++] = j;
      }
    }
    lm++;
  }

  // climate baseline
  for (let y = 0; y < H; y++) {
    const lat = latitude(world, y), al = Math.abs(lat);
    const wx = al < 0.33 ? -0.6 : al < 0.66 ? 0.8 : -0.4;
    const wy = (al < 0.33 ? 0.2 : -0.2) * Math.sign(lat);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // land heights follow a hypsometric curve (mostly lowland, few peaks), as in the real
      // generator; a linear 0–7 km ramp made most land a frozen plateau
      const h = f.water[i] ? 0 : (f.elevation[i] - 0.5) / 0.5;
      const elevKm = 7 * h * h;
      // baseTemp excludes params.baseTemperature (climate adds it); temp/annTemp include it
      const t = 28 - 52 * Math.pow(al, 1.35) - 6.5 * elevKm;
      f.baseTemp[i] = t;
      f.temp[i] = f.annTemp[i] = t + params.baseTemperature;
      f.windX[i] = wx; f.windY[i] = wy;
      let m = fbm(nm, (x / W) * 4, (y / H) * 4, 4) * 0.5 + 0.5;
      m *= 1 - clamp01(f.distCoast[i] / 45) * 0.6;
      if (al < 0.15) m += 0.25;
      if (al > 0.2 && al < 0.38) m -= 0.2;
      m = clamp01(m * params.humidity);
      f.baseMoisture[i] = f.rain[i] = f.annRain[i] = m;
      f.soilWater[i] = m; f.humidity[i] = 0.5; f.cloud[i] = m * 0.5;
    }
  }

  // rivers: steepest descent + accumulation
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => f.elevation[b] - f.elevation[a]);
  for (let i = 0; i < N; i++) {
    f.flowDir[i] = -1;
    if (f.water[i]) continue;
    const x = i % W, y = (i / W) | 0;
    let best = -1, be = f.elevation[i];
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (f.elevation[j] < be) { be = f.elevation[j]; best = j; }
    }
    f.flowDir[i] = best;
  }
  for (const i of order) {
    if (f.water[i]) continue;
    f.flow[i] += f.baseMoisture[i];
    if (f.flowDir[i] >= 0) f.flow[f.flowDir[i]] += f.flow[i];
  }
  for (let i = 0; i < N; i++) {
    const v = f.flow[i];
    f.river[i] = f.water[i] ? 0 : v > 120 ? 4 : v > 50 ? 3 : v > 20 ? 2 : v > 9 ? 1 : 0;
  }

  // biomes, soil, resources, plates
  const nb = createNoise2D(world.seed + ':plates');
  const plates = Array.from({ length: params.plateCount }, () => [world.rng.next() * W, world.rng.next() * H]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let bp = 0, bd = Infinity;
    const jx = x + nb(x * 0.05, y * 0.05) * 8, jy = y + nb(x * 0.05 + 50, y * 0.05) * 8;
    plates.forEach(([px, py], k) => { const d = (jx - px) ** 2 + (jy - py) ** 2; if (d < bd) { bd = d; bp = k; } });
    f.plate[i] = bp;
    f.biome[i] = classify(f, i);
    f.soil[i] = clamp01(0.35 + f.baseMoisture[i] * 0.4 + (f.river[i] ? 0.2 : 0)) * params.soilFertility;
    f.mineral[i] = f.water[i] ? 0 : clamp01((f.elevation[i] - 0.5) * 2.5 + world.rng.next() * 0.2);
    if (!f.water[i] && world.rng.chance(0.025)) { f.resource[i] = world.rng.int(1, 12); f.resourceAmt[i] = 1; }
  }
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (f.plate[i] !== f.plate[i + 1] || f.plate[i] !== f.plate[i + W]) f.plateBoundary[i] = 1;
  }
  for (let k = 0; k < 8; k++) {
    const i = world.rng.int(0, N - 1);
    if (!f.water[i] && f.elevation[i] > 0.6) world.volcanoes.push({ id: world.volcanoes.length, i, x: i % W, y: (i / W) | 0, name: 'Mount ' + k, activity: 0.2, lastEruption: null, erupting: 0, dormantSince: 0 });
  }
}

function classify(f, i) {
  if (f.water[i] === WATER.OCEAN) return f.elevation[i] < 0.4 ? BIOME.DEEP_OCEAN : BIOME.OCEAN;
  if (f.water[i] === WATER.LAKE) return BIOME.LAKE;
  const t = f.annTemp[i], m = f.annRain[i];
  if (f.elevation[i] > 0.86) return BIOME.ALPINE;
  if (t < -10) return BIOME.ICE;
  if (t < -2) return BIOME.TUNDRA;
  if (t < 5) return m > 0.35 ? BIOME.TAIGA : BIOME.COLD_DESERT;
  if (t < 18) return m < 0.18 ? BIOME.COLD_DESERT : m < 0.35 ? BIOME.STEPPE : m < 0.5 ? BIOME.SHRUBLAND : m < 0.75 ? BIOME.TEMPERATE_FOREST : BIOME.TEMPERATE_RAINFOREST;
  return m < 0.15 ? BIOME.HOT_DESERT : m < 0.35 ? BIOME.SAVANNA : m < 0.6 ? BIOME.TROPICAL_FOREST : BIOME.RAINFOREST;
}
