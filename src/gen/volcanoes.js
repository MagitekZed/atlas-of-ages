// Stage 8 · Volcanoes. The relief stage plans volcanic sites along subduction arcs,
// island arcs, continental rifts, collision zones and hotspot heads (and builds their
// cones). Here the sites become world.volcanoes entries: snapped to the local summit,
// guaranteed to stand on land (a volcanic island if need be), named from world.lang.

import { RNG } from '../core/rng.js';
import { WATER } from '../core/constants.js';
import { makePlace } from '../core/names.js';
import { elevationMeters } from '../core/world.js';
import { clamp } from '../core/util.js';

const ACTIVITY = {
  arc: [0.25, 0.65], 'island arc': [0.3, 0.7], hotspot: [0.35, 0.75], rift: [0.15, 0.45], collision: [0.05, 0.25],
};
const KIND = { arc: 'stratovolcano', 'island arc': 'stratovolcano', hotspot: 'shield volcano', rift: 'fissure volcano', collision: 'caldera' };

/** Before hydrology: make sure every planned site breaks the surface (small volcanic island). */
export function raiseVolcanicIslands(world, ctx) {
  const { W, H, f } = world;
  const e = f.elevation;
  const r = Math.max(1, 0.011 * H);
  const strait = ctx.strait || null;          // channels between continents stay open
  for (const s of ctx.volcanoSites || []) {
    const cx = clamp(Math.floor(s.u * H), 0, W - 1), cy = clamp(Math.floor(s.v * H), 0, H - 1);
    if (e[cy * W + cx] >= 0.506) continue;
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      const d = Math.hypot(dx, dy) / r;
      if (d > 1) continue;
      const i = y * W + x;
      if (strait && strait[i]) continue;
      e[i] = Math.max(e[i], 0.508 + 0.056 * Math.pow(1 - d, 1.5));     // a cone ≈ 900 m high
    }
  }
}

/** After hydrology: build world.volcanoes from the planned sites. */
export function placeVolcanoes(world, ctx) {
  const { W, H, f } = world;
  const rng = new RNG(world.seed + ':volcanoes');
  const used = ctx.usedNames || new Set();
  const out = [];
  const taken = new Set();
  for (const s of ctx.volcanoSites || []) {
    const cx = clamp(Math.floor(s.u * H), 0, W - 1), cy = clamp(Math.floor(s.v * H), 0, H - 1);
    let best = -1, be = -1;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (f.water[i] !== WATER.LAND || taken.has(i)) continue;
      const v = f.elevation[i] - 0.004 * (dx * dx + dy * dy);
      if (v > be) { be = v; best = i; }
    }
    // name draws happen for every site so the sequence does not depend on placement
    let base = makePlace(world.lang, rng);
    for (let k = 0; k < 8 && used.has(base); k++) base = makePlace(world.lang, rng);
    const [lo, hi] = ACTIVITY[s.setting] || [0.2, 0.5];
    const activity = rng.float(lo, hi);
    if (best < 0) continue;
    used.add(base);
    taken.add(best);
    const x = best % W, y = (best / W) | 0;
    out.push({
      id: out.length, i: best, x, y,
      name: 'Mount ' + base,
      activity,
      erupting: 0,
      lastEruption: null,
      dormantSince: 0,
      kind: KIND[s.setting] || 'stratovolcano',
      setting: s.setting,
      island: f.landmass[best] >= 0 && isSmallLandmass(world, f.landmass[best]),
      heightM: Math.round(elevationMeters(world, best)),
    });
  }
  world.volcanoes = out;
  return out;
}

function isSmallLandmass(world, id) {
  const lm = world.cache.hydro?.landmasses;
  if (!lm || !lm[id]) return false;
  let land = 0;
  for (const m of lm) land += m.size;
  return lm[id].size < Math.max(30, land * 0.01);
}
