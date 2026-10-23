// mythPreview(world): what a Mythic world will hold, for the genesis plate — its ley network
// (the same seeded generator the world uses at its first day) and the likely homelands of
// each race (where the land suits it best, weighted by plain habitability). Pure: no
// world.rng, no mutation; about 3–5 ms on the 128×80 preview world.

import { WATER, BIOMES } from '../../core/constants.js';
import { generateLey, leyRng } from './ley.js';
import { RACE_LIST, RACE_IDX, raceAff, mixOf, fin } from './races.js';

const HAB = Float32Array.from(BIOMES, (b) => b.habit);
const FARM = Float32Array.from(BIOMES, (b) => b.farm);

/**
 * { nodes: [{ x, y, name, kind, power }], edges: [{ pts }], homelands: [{ race, x, y, share }],
 *   shares: { race: 0..1 } } — or null for a world below mythLevel 2.
 */
export function mythPreview(world) {
  if (!world || !(world.params?.mythLevel >= 2) || !world.f?.water) return null;
  const { W, H, f } = world;
  const ley = generateLey(world, leyRng(world));
  const w0 = mixOf(world).genesis;
  const races = RACE_LIST.filter((r) => (w0[r] || 0) > 0);
  const n = races.length;
  const best = new Int8Array(W * H).fill(-1);
  const score = new Float32Array(W * H);
  const count = new Int32Array(n);
  let land = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (f.water[i] !== WATER.LAND) continue;
    land++;
    let br = -1, bv = 0;
    for (let k = 0; k < n; k++) {
      const v = raceAff(world, RACE_IDX[races[k]], i);
      if (v > bv) { bv = v; br = k; }
    }
    if (br < 0) continue;
    best[i] = br;
    count[br]++;
    const b = f.biome[i];
    const hab = 0.4 * HAB[b] + 0.3 * FARM[b] * Math.min(1.2, fin(f.soil[i]) / 0.6) + (f.river[i] > 0 ? 0.15 : 0) + (f.coast[i] ? 0.06 : 0);
    score[i] = bv * hab;
  }
  // smooth the score a little so a marker sits in a heartland, not on a lone tile
  const homelands = [];
  for (let k = 0; k < n; k++) {
    const picks = [];
    for (let rep = 0; rep < 2; rep++) {
      let bi = -1, bs = 0;
      for (let y = 2; y < H - 2; y += 2) for (let x = 2; x < W - 2; x += 2) {
        const i = y * W + x;
        if (best[i] !== k) continue;
        let s = 0, same = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const j = (y + dy) * W + x + dx;
          if (best[j] === k) { s += score[j]; same++; }
        }
        if (same < 9) continue;
        let near = false;
        for (const p of picks) if ((p.x - x) ** 2 + (p.y - y) ** 2 < (W * 0.22) ** 2) { near = true; break; }
        if (near) continue;
        if (s > bs) { bs = s; bi = i; }
      }
      if (bi < 0) break;
      picks.push({ x: bi % W, y: (bi / W) | 0 });
      if (rep === 0 && count[k] / Math.max(1, land) < 0.12) break;   // a small niche gets one marker
    }
    for (const p of picks) homelands.push({ race: races[k], x: p.x, y: p.y, share: count[k] / Math.max(1, land) });
  }
  const shares = Object.fromEntries(races.map((r, k) => [r, count[k] / Math.max(1, land)]));
  return {
    nodes: ley.nodes.map((nd) => ({ x: nd.x, y: nd.y, name: nd.name, kind: nd.kind, power: nd.power })),
    edges: ley.edges.map((e) => ({ pts: e.pts, w: e.w })),
    homelands, shares,
  };
}
