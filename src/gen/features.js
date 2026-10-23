// Stage 9 · Features: named geography for map labels and chronicle prose.
// world.features[] = { id, kind, name, base, x, y, size, angle?, ... }
//   kind   'continent' | 'ocean' | 'sea' | 'island' | 'range' | 'lake' | 'river' | 'desert' | 'forest'
//   name   display name with its English kind ("the Varan Sea", "Lake Oskel", "the Tirenwood")
//   base   the bare proper name ("Varan") for prose
//   x, y   label anchor in tile coordinates (a deep interior point / mid-course)
//   size   tiles covered (rivers and ranges: also `len`, tiles along the course / long axis)
//   angle  radians in [-π/2, π/2] for labels that follow a long axis (ranges, rivers)

import { RNG } from '../core/rng.js';
import { BIOME, WATER } from '../core/constants.js';
import { makePlace, isEnglishWord } from '../core/names.js';
import { MinHeap, DX8, DY8 } from '../core/util.js';
import { chamfer, labelComponents, axisAngle, REF_N, REF_H } from './grid.js';
import { lakeList, riverThresholds } from './hydrology.js';

export function nameFeatures(world, ctx = {}) {
  const { W, H, N, f } = world;
  const rng = new RNG(world.seed + ':features');
  const used = ctx.usedNames || new Set([world.name]);
  const scale = N / REF_N;            // tile-count thresholds scale with map area
  const lin = H / REF_H;              // and lengths with map height
  const out = [];
  const freshName = () => {
    // never an English word: "the The Uplands", "Lake Bug"
    let n = makePlace(world.lang, rng);
    for (let k = 0; k < 10 && (used.has(n) || isEnglishWord(n)); k++) n = makePlace(world.lang, rng);
    used.add(n);
    return n;
  };
  const pick = (arr) => arr[Math.floor(rng.next() * arr.length)];
  const add = (kind, base, name, x, y, size, extra = {}) => {
    out.push({ id: out.length, kind, name, base, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, size, ...extra });
  };
  const queue = new Int32Array(N), labels = new Int32Array(N), mark = new Uint8Array(N), dist = new Float32Array(N);

  // ---------------------------------------------------------------- land
  const lm = f.landmass;
  let nLm = 0;
  for (let i = 0; i < N; i++) if (lm[i] + 1 > nLm) nLm = lm[i] + 1;
  const lmSize = new Float64Array(nLm), lmSx = new Float64Array(nLm), lmSy = new Float64Array(nLm);
  const lmBest = new Int32Array(nLm).fill(-1);
  for (let i = 0; i < N; i++) {
    const k = lm[i]; if (k < 0) continue;
    lmSize[k]++; lmSx[k] += i % W; lmSy[k] += (i / W) | 0;
    if (lmBest[k] < 0 || f.distCoast[i] > f.distCoast[lmBest[k]]) lmBest[k] = i;
  }
  let landTotal = 0;
  for (let k = 0; k < nLm; k++) landTotal += lmSize[k];
  const minIsland = Math.max(4, Math.round(10 * scale));
  const order = Array.from({ length: nLm }, (_, k) => k).sort((a, b) => lmSize[b] - lmSize[a] || a - b);
  let continents = 0, islands = 0;
  const small = [];
  for (const k of order) {
    const sz = lmSize[k];
    const b = lmBest[k];
    const ax = f.distCoast[b] > 0 ? b % W : lmSx[k] / sz, ay = f.distCoast[b] > 0 ? (b / W) | 0 : lmSy[k] / sz;
    if (sz >= landTotal * 0.02 && continents < 9 && sz >= minIsland * 6) {
      const n = freshName();
      add('continent', n, n, ax, ay, sz, { landmass: k });
      continents++;
    } else if (sz >= minIsland && islands < 24) {
      const n = freshName();
      const name = pick([n, n, `${n} Isle`, `the Isle of ${n}`, `${n} Island`]);
      add('island', n, name, ax, ay, sz, { landmass: k });
      islands++;
    } else if (sz < minIsland * 2) small.push(k);
  }
  // archipelagos: clusters of small islands (the largest few hundred are enough)
  if (small.length > 600) small.length = 600;
  {
    const R = 0.07 * H;
    const cl = new Int32Array(nLm).fill(-1);
    const groups = [];
    for (const k of small) {
      if (cl[k] >= 0) continue;
      const g = [k]; cl[k] = groups.length;
      for (let q = 0; q < g.length; q++) {
        const a = g[q], ax = lmSx[a] / lmSize[a], ay = lmSy[a] / lmSize[a];
        for (const j of small) {
          if (cl[j] >= 0) continue;
          if (Math.hypot(lmSx[j] / lmSize[j] - ax, lmSy[j] / lmSize[j] - ay) < R) { cl[j] = groups.length; g.push(j); }
        }
      }
      groups.push(g);
    }
    groups.sort((a, b) => b.length - a.length);
    let named = 0;
    for (const g of groups) {
      if (g.length < 4 || named >= 8) break;
      let sx = 0, sy = 0, sz = 0;
      for (const k of g) { sx += lmSx[k]; sy += lmSy[k]; sz += lmSize[k]; }
      const n = freshName();
      add('island', n, pick([`the ${n} Isles`, `the ${n} Islands`, `the ${n} Archipelago`]), sx / sz, sy / sz, sz, { group: g.length });
      named++;
    }
  }

  // ---------------------------------------------------------- oceans & seas
  // Depth of open water = distance to the nearest land or map frame. A watershed from
  // well-spaced deep seeds splits the sea at narrow straits; neighbouring regions joined
  // by wide-open water are then merged, so oceans come out whole and seas are the
  // bodies behind straits, gulfs and enclosed basins.
  {
    for (let i = 0; i < N; i++) dist[i] = f.water[i] === WATER.LAND ? 0 : 1e9;
    chamfer(W, H, dist);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const fr = Math.min(x + 1, y + 1, W - x, H - y) * 1.15;
      if (fr < dist[i]) dist[i] = fr;
    }
    const region = labels; region.fill(-1);
    const cand = [];
    for (let i = 0; i < N; i++) if (f.water[i] === WATER.OCEAN && dist[i] >= 2.5 * lin) cand.push(i);
    cand.sort((a, b) => dist[b] - dist[a] || a - b);
    const seeds = [];
    const R2 = (0.15 * H) ** 2;
    for (const i of cand) {
      if (seeds.length >= 60) break;
      const x = i % W, y = (i / W) | 0;
      if (seeds.every((s) => (s.x - x) ** 2 + (s.y - y) ** 2 > R2)) seeds.push({ i, x, y, d: dist[i] });
    }
    const heap = new MinHeap(Math.max(1024, N >> 2));
    const grow = () => {
      while (heap.size) {
        const c = heap.pop(), x = c % W, y = (c / W) | 0, rc = region[c];
        for (let d = 0; d < 8; d++) {
          const nx = x + DX8[d], ny = y + DY8[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (region[j] >= 0 || f.water[j] !== WATER.OCEAN) continue;
          region[j] = rc; heap.push(j, -dist[j]);
        }
      }
    };
    seeds.forEach((s, k) => { region[s.i] = k; heap.push(s.i, -s.d); });
    grow();
    // enclosed seas the seeds never reached get a seed at their deepest tile
    for (let i = 0; i < N; i++) {
      if (f.water[i] !== WATER.OCEAN || region[i] >= 0) continue;
      let qh = 0, qt = 0, best = i;
      queue[qt++] = i; mark[i] = 1;
      while (qh < qt) {
        const c = queue[qh++], x = c % W, y = (c / W) | 0;
        if (dist[c] > dist[best]) best = c;
        for (let d = 0; d < 8; d++) {
          const nx = x + DX8[d], ny = y + DY8[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (mark[j] || region[j] >= 0 || f.water[j] !== WATER.OCEAN) continue;
          mark[j] = 1; queue[qt++] = j;
        }
      }
      const k = seeds.length;
      seeds.push({ i: best, x: best % W, y: (best / W) | 0, d: dist[best] });
      region[best] = k; heap.push(best, -dist[best]);
      grow();
    }
    mark.fill(0);
    // saddles: the widest water joining each pair of neighbouring regions
    const nr = seeds.length;
    const saddle = new Map();
    const area = new Float64Array(nr), coastT = new Float64Array(nr);
    for (let i = 0; i < N; i++) {
      const r = region[i]; if (r < 0) continue;
      area[r]++;
      const x = i % W, y = (i / W) | 0;
      for (let d = 0; d < 8; d += 2) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (f.water[j] === WATER.LAND) { coastT[r]++; continue; }
        const q = region[j];
        if (q < 0 || q === r) continue;
        const key = r < q ? r * 4096 + q : q * 4096 + r;
        const v = Math.min(dist[i], dist[j]);
        if (v > (saddle.get(key) ?? 0)) saddle.set(key, v);
      }
    }
    const par = seeds.map((_, k) => k);
    const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    const deep = seeds.map((s) => s.d);
    const pairs = [...saddle.entries()].map(([key, v]) => [v, (key / 4096) | 0, key % 4096]).sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
    for (const [v, a, b] of pairs) {
      const ra = find(a), rb = find(b);
      if (ra === rb) continue;
      // open water: the connection is nearly as wide as the shallower basin is deep
      if (v >= 0.62 * Math.min(deep[ra], deep[rb])) {
        const keepA = deep[ra] >= deep[rb];
        par[keepA ? rb : ra] = keepA ? ra : rb;
      }
    }
    const groups = new Map();
    for (let k = 0; k < nr; k++) {
      const r = find(k);
      const gq = groups.get(r) || { root: r, area: 0, coast: 0, sx: 0, sy: 0, dmax: 0, ax: seeds[r].x, ay: seeds[r].y, ad: Infinity };
      gq.area += area[k]; gq.coast += coastT[k];
      groups.set(r, gq);
    }
    // label anchor: among a body's deep tiles (≥ 75 % of its depth) the one nearest its centroid
    for (let i = 0; i < N; i++) {
      const r = region[i]; if (r < 0) continue;
      const gq = groups.get(find(r));
      gq.sx += i % W; gq.sy += (i / W) | 0;
      if (dist[i] > gq.dmax) gq.dmax = dist[i];
    }
    for (let i = 0; i < N; i++) {
      const r = region[i]; if (r < 0) continue;
      const gq = groups.get(find(r));
      if (dist[i] < 0.75 * gq.dmax) continue;
      const d2 = (i % W - gq.sx / gq.area) ** 2 + (((i / W) | 0) - gq.sy / gq.area) ** 2;
      if (d2 < gq.ad) { gq.ad = d2; gq.ax = i % W; gq.ay = (i / W) | 0; }
    }
    let oceanArea = 0;
    for (let k = 0; k < nr; k++) oceanArea += area[k];
    const list = [...groups.values()].sort((a, b) => b.area - a.area || a.root - b.root);
    let oceans = 0, seas = 0;
    for (const gq of list) {
      const s = seeds[gq.root];
      if (gq.area < Math.max(12 * scale, oceanArea * 0.01)) continue;
      if (oceans < 4 && gq.area >= oceanArea * 0.12 && s.d >= 0.06 * H) {
        const n = freshName();
        add('ocean', n, `the ${n} Ocean`, gq.ax, gq.ay, gq.area, { depth: Math.round(gq.dmax) });
        oceans++;
      } else if (seas < 8) {
        const n = freshName();
        const enclosed = gq.coast / Math.max(1, Math.sqrt(gq.area)) > 3.2;
        const name = gq.area < oceanArea * 0.04 && enclosed
          ? pick([`the Gulf of ${n}`, `the Bay of ${n}`, `${n} Bay`])
          : pick([`the ${n} Sea`, `the ${n} Sea`, `the Sea of ${n}`]);
        add('sea', n, name, gq.ax, gq.ay, gq.area, { depth: Math.round(gq.dmax) });
        seas++;
      }
    }
  }

  // ---------------------------------------------------------- mountain ranges
  {
    const hi = new Uint8Array(N);
    for (let i = 0; i < N; i++) hi[i] = f.water[i] === WATER.LAND && f.elevation[i] >= 0.68 ? 1 : 0;
    // dilate so neighbouring peaks join one range
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; let m = hi[i];
      if (!m) for (let d = 0; d < 8 && !m; d++) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && hi[ny * W + nx]) m = 1;
      }
      mark[i] = m;
    }
    const sizes = labelComponents(W, H, mark, labels, queue);
    const st = sizes.map(() => ({ n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, peak: -1, emax: 0, esum: 0 }));
    for (let i = 0; i < N; i++) {
      if (!hi[i]) continue;
      const c = labels[i]; if (c < 0) continue;
      const s = st[c], x = i % W, y = (i / W) | 0, el = f.elevation[i];
      s.n++; s.sx += x; s.sy += y; s.sxx += x * x; s.syy += y * y; s.sxy += x * y; s.esum += el;
      if (el > s.emax) { s.emax = el; s.peak = i; }
    }
    const minRange = Math.max(5, Math.round(10 * scale));
    const ids = st.map((_, k) => k).filter((k) => st[k].n >= minRange).sort((a, b) => st[b].n - st[a].n || a - b).slice(0, 14);
    // anchor: the high tile nearest each range's centroid
    const anchor = new Map(ids.map((k) => [k, { i: -1, d: Infinity }]));
    for (let i = 0; i < N; i++) {
      if (!hi[i]) continue;
      const a = anchor.get(labels[i]); if (!a) continue;
      const s = st[labels[i]];
      const d = (i % W - s.sx / s.n) ** 2 + (((i / W) | 0) - s.sy / s.n) ** 2;
      if (d < a.d) { a.d = d; a.i = i; }
    }
    for (const k of ids) {
      const s = st[k], n = s.n;
      const mx = s.sx / n, my = s.sy / n;
      const cxx = s.sxx / n - mx * mx, cyy = s.syy / n - my * my, cxy = s.sxy / n - mx * my;
      const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
      const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const len = Math.max(2, Math.sqrt(Math.max(0, l1)) * 3.5);
      const a = anchor.get(k);
      const base = freshName();
      const high = s.emax >= 0.8;
      const name = high
        ? pick([`the ${base} Mountains`, `the ${base} Mountains`, `the ${base} Range`, `the ${base} Peaks`, `the ${base} Spine`])
        : pick([`the ${base} Highlands`, `the ${base} Hills`, `the ${base} Uplands`]);
      add('range', base, name, a.i >= 0 ? a.i % W : mx, a.i >= 0 ? (a.i / W) | 0 : my, n, {
        angle: Math.round(axisAngle(cxx, cyy, cxy) * 1000) / 1000, len: Math.round(len),
        peak: { x: s.peak % W, y: (s.peak / W) | 0, m: Math.round((s.emax - 0.5) / 0.5 * 7000) },
      });
    }
  }

  // ---------------------------------------------------------------- lakes
  {
    const minLake = Math.max(3, Math.round(6 * scale));
    const lakes = lakeList(world).filter((l) => l.tiles >= minLake).sort((a, b) => b.tiles - a.tiles || a.id - b.id).slice(0, 12);
    for (const l of lakes) {
      const n = freshName();
      add('lake', n, rng.next() < 0.82 ? `Lake ${n}` : `${n} Mere`, l.x, l.y, l.tiles, { terminal: Boolean(l.terminal) });
    }
  }

  // ---------------------------------------------------------------- rivers
  {
    const t1 = riverThresholds(world)[0];
    const mouths = [];
    for (let i = 0; i < N; i++) {
      if (f.water[i] !== WATER.LAND || f.river[i] < 3) continue;
      const d = f.flowDir[i];
      if (d < 0 || f.water[d] !== WATER.LAND) mouths.push(i);
    }
    mouths.sort((a, b) => f.flow[b] - f.flow[a] || a - b);
    const minLen = Math.max(6, Math.round(14 * lin));
    let named = 0;
    for (const m of mouths) {
      if (named >= 14) break;
      // main stem: follow the largest tributary upstream
      const stem = [m];
      let cur = m;
      for (let guard = 0; guard < 4 * (W + H); guard++) {
        const x = cur % W, y = (cur / W) | 0;
        let up = -1, uf = 0;
        for (let d = 0; d < 8; d++) {
          const nx = x + DX8[d], ny = y + DY8[d];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (f.flowDir[j] !== cur || f.water[j] !== WATER.LAND) continue;
          if (f.flow[j] > uf) { uf = f.flow[j]; up = j; }
        }
        if (up < 0 || uf < t1) break;
        stem.push(up); cur = up;
      }
      if (stem.length < minLen) continue;
      const k = Math.floor(stem.length * 0.45);
      const a = stem[Math.max(0, k - 4)], b = stem[Math.min(stem.length - 1, k + 4)];
      let ang = Math.atan2(((b / W) | 0) - ((a / W) | 0), (b % W) - (a % W));
      if (ang > Math.PI / 2) ang -= Math.PI;
      if (ang < -Math.PI / 2) ang += Math.PI;
      const n = freshName();
      const mid = stem[k];
      add('river', n, rng.next() < 0.7 ? `the ${n} River` : `the ${n}`, mid % W, (mid / W) | 0, stem.length, {
        angle: Math.round(ang * 1000) / 1000, len: stem.length,
        mouth: { x: m % W, y: (m / W) | 0 }, source: { x: cur % W, y: (cur / W) | 0 },
        flow: Math.round(f.flow[m]),
      });
      named++;
    }
  }

  // ------------------------------------------------------ deserts & forests
  const regionNames = (kindName, member, cap, minSize, nameFor) => {
    const sizes = labelComponents(W, H, member, labels, queue);
    for (let i = 0; i < N; i++) dist[i] = member[i] ? 1e9 : 0;
    chamfer(W, H, dist);
    const best = sizes.map(() => -1);
    const cnt = sizes.map(() => new Map());
    for (let i = 0; i < N; i++) {
      const c = labels[i]; if (c < 0) continue;
      if (best[c] < 0 || dist[i] > dist[best[c]]) best[c] = i;
      if (sizes[c] >= minSize) { const b = f.biome[i]; cnt[c].set(b, (cnt[c].get(b) || 0) + 1); }
    }
    const ids = sizes.map((_, k) => k).filter((k) => sizes[k] >= minSize).sort((a, b) => sizes[b] - sizes[a] || a - b).slice(0, cap);
    for (const k of ids) {
      let dom = -1, dn = -1;
      for (const [b, n] of cnt[k]) if (n > dn || (n === dn && b < dom)) { dn = n; dom = b; }
      const base = freshName();
      const i = best[k];
      add(kindName, base, nameFor(base, dom), i % W, (i / W) | 0, sizes[k], { biome: dom });
    }
  };
  let land = 0;
  for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND) land++;
  const minRegion = Math.max(Math.round(40 * scale), Math.round(land * 0.005));
  for (let i = 0; i < N; i++) { const b = f.biome[i]; mark[i] = b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT ? 1 : 0; }
  regionNames('desert', mark, 6, minRegion, (n, b) => b === BIOME.COLD_DESERT
    ? pick([`the ${n} Barrens`, `the ${n} Waste`, `${n} Desert`])
    : pick([`the ${n} Desert`, `${n} Desert`, `the ${n} Sands`, `the ${n} Waste`]));
  for (let i = 0; i < N; i++) {
    const b = f.biome[i];
    mark[i] = b === BIOME.TEMPERATE_FOREST || b === BIOME.TEMPERATE_RAINFOREST || b === BIOME.TAIGA || b === BIOME.RAINFOREST || b === BIOME.TROPICAL_FOREST ? 1 : 0;
  }
  regionNames('forest', mark, 8, minRegion, (n, b) => {
    if (b === BIOME.RAINFOREST) return pick([`the ${n} Jungle`, `the ${n} Rainforest`, `the ${n} Jungle`]);
    if (b === BIOME.TROPICAL_FOREST) return pick([`the ${n} Forest`, `the ${n} Wilds`, `the ${n} Jungle`]);
    if (b === BIOME.TAIGA) return pick([`the ${n} Taiga`, `the ${n}wood`, `the ${n} Pinewood`]);
    return pick([`the ${n}wood`, `the ${n} Forest`, `the ${n} Weald`, `the ${n}wood`]);
  });

  world.features = out;
  return out;
}
