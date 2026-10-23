// Ley lines: the rivers of power that cross a Mythic world. Generated once (at genesis, or
// when magic is awakened) from an rng seeded by the world seed and ':ley', so the genesis
// preview (preview.js) draws the same network the world will have:
//   18–24 nodes on the strongest plate boundaries, high relief, old forest and volcanoes,
//   spaced √(land / 22) tiles apart; joined by a minimum spanning tree (water crossings cost
//   extra) plus about 25 % extra short edges; each edge a gently bowed curve.
// Nodes become pinned 'node' sites (core/sites.js) with names such as "the Weeping Stones of
// Pozuto" or "the Pozuto Menhir" (kind × qualifier × noun × a place word, NODE_WORDS); edges
// live in sys.myth.ley.edges as flat point lists and are rasterised into f.ley (U8, full
// resolution: 255 on the line, fading over a tile). Users add edges with the
// Ley Line tool and nodes with the Wellspring (tools.js).
//
// Pure helpers here never touch world.rng: generation takes its own RNG.

import { RNG, hashString } from '../../core/rng.js';
import { WATER, BIOME, BIOMES } from '../../core/constants.js';
import { makePlace, isEnglishWord } from '../../core/names.js';
import { pickT } from './prose.js';
import { fin } from './races.js';

export const leyRng = (world) => new RNG(hashString(String(world.seed) + ':ley'));

const FORESTS = new Set([BIOME.TAIGA, BIOME.TEMPERATE_FOREST, BIOME.TEMPERATE_RAINFOREST, BIOME.TROPICAL_FOREST, BIOME.RAINFOREST]);
const DESERTS = new Set([BIOME.HOT_DESERT, BIOME.COLD_DESERT]);

/**
 * Node names by the ground a node rises from: a themed qualifier (a) and noun (n) of the kind,
 * a place word of the world's tongue ({p}), in four forms. short: what a war is named after
 * ("The War of the Pozuto Stones"), mostly carrying the place word so wars differ between worlds.
 */
const NODE_WORDS = {
  stone: { a: ['Witch', 'King', 'Grey', 'Hollow', 'Weeping', 'Whispering', 'Old', 'Moon', 'Thunder', 'Raven', 'Hag', 'Giant', 'Listening', 'Leaning', 'Dancing', 'Blind', 'Wishing', 'Speaking', 'Sleeping'],
    n: ['Stone', 'Stones', 'Ring', 'Circle', 'Menhir', 'Dolmen', 'Cairn', 'Henge'] },
  peak: { a: ['Singing', 'Star', 'Thunder', 'Cloud', 'White', 'Eagle', 'Wind', 'Storm', 'Silver', 'Lonely', 'Horned', 'Bright', 'Watching', 'Moon'],
    n: ['Spire', 'Peak', 'Crown', 'Seat', 'Throne', 'Horn', 'Tor', 'Pinnacle', 'Needle'] },
  grove: { a: ['Elder', 'Moon', 'Whispering', 'Heart', 'Silver', 'Dreaming', 'Old', 'Green', 'Night', 'Mother', 'Mossy', 'Weeping', 'Hidden', 'Singing'],
    n: ['Grove', 'Oak', 'Wood', 'Moonpool', 'Glade', 'Yew', 'Thicket', 'Bower', 'Tree', 'Heartwood'] },
  water: { a: ['Singing', 'Mirror', 'Silver', 'Moon', 'Laughing', 'Weeping', 'Bright', 'Deep', 'Clear', 'Healing', 'Speaking', 'Star'],
    n: ['Falls', 'Mere', 'Spring', 'Wellhead', 'Pool', 'Fount', 'Cascade', 'Tarn', 'Waters'] },
  fire: { a: ['Ember', 'Burning', 'Ashen', 'Red', 'Smoking', 'Molten', 'Cinder', 'Sulphur', 'Flame', 'Dragon'],
    n: ['Throne', 'Well', 'Gate', 'Mouth', 'Forge', 'Hearth', 'Pit', 'Altar', 'Crown'] },
  glass: { a: ['Glass', 'Sun', 'Mirage', 'Shimmering', 'Burning', 'Salt', 'Dune', 'White', 'Thirsting', 'Golden'],
    n: ['Stones', 'Well', 'Gate', 'Pillars', 'Mirror', 'Tower', 'Spire', 'Eye'] },
  tide: { a: ['Tide', 'Sea', 'Drowned', 'Foam', 'Salt', 'Grey', 'Storm', 'Pearl', 'Moon', 'Sunken', 'Whale'],
    n: ['Stone', 'Gate', 'Ring', 'Rock', 'Arch', 'Stair', 'Pillar', 'Altar'] },
  rift: { a: ['Riven', 'Rift', 'Deep', 'Broken', 'Shaking', 'Split', 'Black', 'Groaning', 'Weeping', 'Burning'],
    n: ['Stone', 'Gate', 'Seam', 'Cleft', 'Chasm', 'Scar', 'Rent', 'Throat'] },
  well: { a: ['Bright', 'Rising', 'Living', 'Silver', 'Wonder', 'Star', 'Dawn', 'Fair', 'New', 'Blessed'],
    n: ['Well', 'Spring', 'Wellspring', 'Fount', 'Source', 'Pool', 'Rising'] },
};
// generated words that read as English next to the node's own words ("the Weeping Tree of Fool")
const PLAIN = new Set(('fool pool moon soon noon boon loom doom room mood food good wood hood book look took cook hook nook '
  + 'bush push rush hush mush lush dish fish wish mash cash bash dash gash hash lash rash wash mesh bone cone done gone lone '
  + 'none tone zone dune tune rune mine fine line nine pine vine wine sale tale pale male dale gale bell sell tell well fell '
  + 'dell dull hull gull pull bull full fun gun nun run bun ban fan man pan ran can bin din pin sin tin win bar car far jar '
  + 'tar star scar mill hill kill till will pill rot hot lot not pot dot cot bog dog fog hog log mud bud dud hum gum rum sum '
  + 'tub rub dub hub cub sob rob mob job lob nod god pod rod sod ham jam ram dam yam bam hem den hen men pen ten').split(' '));
const plainWord = (w) => isEnglishWord(w) || PLAIN.has(String(w).toLowerCase());

/** One candidate name for a node of a kind: { name, short } (draws from rng). */
function nodeNameOnce(world, rng, kind) {
  const W = NODE_WORDS[kind] || NODE_WORDS.stone;
  const n = pickT(rng, W.n);
  let a = pickT(rng, W.a);
  if (a === n || n.toLowerCase().startsWith(a.toLowerCase())) a = W.a[(W.a.indexOf(a) + 1) % W.a.length];   // never "the Rising Rising"
  let p = makePlace(world.lang, rng);
  for (let k = 0; k < 3 && plainWord(p); k++) p = makePlace(world.lang, rng);
  const f = rng.next();
  if (f < 0.45) return { name: `the ${a} ${n} of ${p}`, short: rng.next() < 0.6 ? `the ${p} ${n}` : `the ${a} ${n}` };  // the Weeping Stones of Pozuto
  if (f < 0.7) return { name: `the ${p} ${n}`, short: `the ${p} ${n}` };                                                 // the Pozuto Menhir
  if (f < 0.88) return { name: `the ${a} ${n} at ${p}`, short: `the ${p} ${n}` };                                        // the Singing Falls at Ourou
  return { name: `${p}'s ${a} ${n}`, short: `${p}'s ${n}` };                                                             // Pozuto's Ember Throne
}

export const NODE_KIND_LABEL = {
  stone: 'standing stones', peak: 'a singing peak', grove: 'an elder grove', water: 'a spring of power', fire: 'a fire-well',
  glass: 'desert glass-stones', tide: 'a tide-stone', rift: 'a riven stone', well: 'a wellspring',
};

/** What kind of node a tile makes (for its name and glyph). */
export function nodeKindAt(world, i) {
  const { f, W, H } = world;
  const x = i % W, y = (i / W) | 0;
  for (const v of world.volcanoes || []) if (v && (v.x - x) ** 2 + (v.y - y) ** 2 <= 9) return 'fire';
  const h = f.elevation[i] - fin(world.climate?.seaLevel, 0.5);
  if (h >= 0.22) return 'peak';
  const b = f.biome[i];
  if (FORESTS.has(b) && f.veg[i] > 0.55) return 'grove';
  let lake = false;
  for (let dy = -1; dy <= 1 && !lake; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx >= 0 && yy >= 0 && xx < W && yy < H && f.water[yy * W + xx] === WATER.LAKE) { lake = true; break; }
  }
  if (f.river[i] >= 2 || lake) return 'water';
  if (DESERTS.has(b)) return 'glass';
  if (f.coast[i]) return 'tide';
  if (f.plateBoundary[i] > 0.5) return 'rift';
  return 'stone';
}

/** A node name: { name, short }, unique against `taken`. Draws from rng (the ley rng at genesis, world.rng for tools). */
export function nodeName(world, rng, kind, taken = null) {
  let nm = null;
  for (let k = 0; k < 8; k++) {
    nm = nodeNameOnce(world, rng, kind);
    if (!taken || !taken.has(nm.name)) { taken?.add(nm.name); return nm; }
  }
  const W = NODE_WORDS[kind] || NODE_WORDS.stone;
  const p = makePlace(world.lang, rng) + 'ar';
  nm = { name: `the ${W.a[0]} ${W.n[0]} of ${p}`, short: `the ${p} ${W.n[0]}` };
  taken?.add(nm.name);
  return nm;
}

// ---------------------------------------------------------------------------
// Generation

function relief(world, x, y) {
  const { f, W, H } = world;
  let lo = Infinity, hi = -Infinity;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    const e = f.elevation[yy * W + xx];
    if (e < lo) lo = e; if (e > hi) hi = e;
  }
  return Math.min(1, (hi - lo) / 0.15);
}

/** Candidate score of land tile i for a node (higher is more magical ground). */
function nodeScore(world, i, vd) {
  const { f, W } = world;
  const x = i % W, y = (i / W) | 0;
  const b = f.biome[i];
  const forest = FORESTS.has(b) ? Math.min(1, f.veg[i] / Math.max(0.1, BIOMES[b].vegMax)) : 0;
  const volcano = vd[i] < 255 ? Math.exp(-vd[i] / 3) : 0;
  return 1.2 * f.plateBoundary[i] + 1.4 * relief(world, x, y) + 1.0 * forest + 0.9 * volcano + (f.river[i] >= 3 ? 0.35 : 0);
}

/**
 * Generate the network on this world. Returns { nodes: [{ x, y, i, kind, name, short, power }],
 * edges: [{ a, b, pts: [x0, y0, x1, y1, …], w }] } with a, b node indices. Pure.
 */
export function generateLey(world, rng = leyRng(world)) {
  const { W, H, N, f } = world;
  // distance to the nearest volcano (tiles, capped) for scoring
  const vd = new Uint8Array(N).fill(255);
  for (const v of world.volcanoes || []) {
    if (!v) continue;
    const vx = Math.round(v.x), vy = Math.round(v.y);
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const x = vx + dx, y = vy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const d = Math.round(Math.hypot(dx, dy));
      const i = y * W + x;
      if (d < vd[i]) vd[i] = d;
    }
  }
  let land = 0;
  const cands = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (f.water[i] !== WATER.LAND) continue;
    land++;
    if ((x + y) & 1) continue;                          // half the tiles are plenty
    if (f.biome[i] === BIOME.ICE) continue;
    cands.push([i, nodeScore(world, i, vd) + 0.6 * rng.next()]);
  }
  cands.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (cands.length > 6000) cands.length = 6000;               // the best ground is enough
  const kinds = cands.map(([i]) => nodeKindAt(world, i));
  const want = 18 + rng.int(0, 6);
  let spacing = Math.sqrt(Math.max(1, land) / 22);
  let picked = [];
  for (let attempt = 0; attempt < 5 && picked.length < want; attempt++) {
    // greedy, with a gentle penalty on kinds already chosen so a network is not all fire-wells
    picked = [];
    const used = {};
    const taken = new Uint8Array(cands.length);
    while (picked.length < want) {
      let bk = -1, bs = -Infinity;
      for (let k = 0; k < cands.length; k++) {
        if (taken[k]) continue;
        const sc = cands[k][1] * Math.pow(0.72, used[kinds[k]] || 0);
        if (sc <= bs) continue;
        const i = cands[k][0], x = i % W, y = (i / W) | 0;
        let ok = true;
        for (const p of picked) { const dx = x - (p % W), dy = y - ((p / W) | 0); if (dx * dx + dy * dy < spacing * spacing) { ok = false; break; } }
        if (!ok) { taken[k] = 1; continue; }
        bs = sc; bk = k;
      }
      if (bk < 0) break;
      taken[bk] = 1;
      picked.push(cands[bk][0]);
      used[kinds[bk]] = (used[kinds[bk]] || 0) + 1;
    }
    spacing *= 0.82;
  }
  const taken = new Set();
  const nodes = picked.map((i) => {
    const kind = nodeKindAt(world, i);
    const nm = nodeName(world, rng, kind, taken);
    return { x: i % W, y: (i / W) | 0, i, kind, name: nm.name, short: nm.short, power: Math.round((0.6 + 0.4 * rng.next()) * 100) / 100 };
  });
  return { nodes, edges: connect(world, nodes, rng) };
}

/** Fraction of the straight segment a→b that lies over water. */
function waterFrac(world, ax, ay, bx, by) {
  const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 2));
  let w = 0;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const x = Math.round(ax + (bx - ax) * t), y = Math.round(ay + (by - ay) * t);
    if (world.f.water[y * world.W + x] !== WATER.LAND) w++;
  }
  return w / (n + 1);
}

/** Minimum spanning tree (water crossings cost more) plus ~25 % extra short edges, as bowed curves. */
function connect(world, nodes, rng) {
  const n = nodes.length;
  if (n < 2) return [];
  const cost = new Float64Array(n * n), len = new Float64Array(n * n);
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const A = nodes[a], Bn = nodes[b];
    const d = Math.hypot(A.x - Bn.x, A.y - Bn.y);
    const c = d * (1 + 1.6 * waterFrac(world, A.x, A.y, Bn.x, Bn.y));
    cost[a * n + b] = cost[b * n + a] = c;
    len[a * n + b] = len[b * n + a] = d;
  }
  // Prim
  const inTree = new Uint8Array(n), best = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1);
  best[0] = 0;
  const pairs = [];
  for (let it = 0; it < n; it++) {
    let u = -1;
    for (let v = 0; v < n; v++) if (!inTree[v] && (u < 0 || best[v] < best[u])) u = v;
    inTree[u] = 1;
    if (from[u] >= 0) pairs.push([from[u], u, 1]);
    for (let v = 0; v < n; v++) if (!inTree[v] && cost[u * n + v] < best[v]) { best[v] = cost[u * n + v]; from[v] = u; }
  }
  const lens = pairs.map(([a, b]) => len[a * n + b]).sort((p, q) => p - q);
  const median = lens[lens.length >> 1] || 1;
  const has = new Set(pairs.map(([a, b]) => Math.min(a, b) * 4096 + Math.max(a, b)));
  const extra = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    if (has.has(a * 4096 + b)) continue;
    const c = cost[a * n + b];
    if (len[a * n + b] <= median * 1.35) extra.push([a, b, c]);
  }
  extra.sort((p, q) => p[2] - q[2] || p[0] - q[0] || p[1] - q[1]);
  const nExtra = Math.max(1, Math.round((n - 1) * 0.25));
  const deg = new Int32Array(n);
  for (const [a, b] of pairs) { deg[a]++; deg[b]++; }
  for (const [a, b] of extra) {
    if (pairs.length >= n - 1 + nExtra) break;
    if (deg[a] >= 4 || deg[b] >= 4) continue;
    pairs.push([a, b, 0.75]); deg[a]++; deg[b]++;
  }
  return pairs.map(([a, b, w]) => ({ a, b, w, pts: bowed(nodes[a].x, nodes[a].y, nodes[b].x, nodes[b].y, (rng.next() - 0.5) * 0.36) }));
}

/** A quadratic curve from (ax, ay) to (bx, by) bowed sideways by `bow` × its length: flat [x, y, …] (0.1 tile precision). */
export function bowed(ax, ay, bx, by, bow) {
  const d = Math.hypot(bx - ax, by - ay);
  const mx = (ax + bx) / 2 - ((by - ay) / Math.max(1e-6, d)) * bow * d;
  const my = (ay + by) / 2 + ((bx - ax) / Math.max(1e-6, d)) * bow * d;
  const steps = Math.max(2, Math.ceil(d / 1.5));
  const out = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps, u = 1 - t;
    const x = u * u * ax + 2 * u * t * mx + t * t * bx;
    const y = u * u * ay + 2 * u * t * my + t * t * by;
    out.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Raster

/** Burn one polyline into a U8 ley field (strength 0..1 → 255 on the line, ~45 % a tile off). */
export function rasterLine(world, ley, pts, w = 1) {
  const { W, H } = world;
  const core = Math.round(255 * Math.max(0.3, Math.min(1, w)));
  const side = Math.round(core * 0.45);
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const ax = pts[k], ay = pts[k + 1], bx = pts[k + 2], by = pts[k + 3];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = Math.round(ax + (bx - ax) * t), y = Math.round(ay + (by - ay) * t);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const i = yy * W + xx;
        const v = dx === 0 && dy === 0 ? core : side;
        if (ley[i] < v) ley[i] = v;
      }
    }
  }
}

/** Rebuild the whole ley field from the stored edges and nodes. */
export function rasterAll(world, ley, edges, nodes) {
  ley.fill(0);
  for (const e of edges) rasterLine(world, ley, e.pts, e.w);
  for (const s of nodes) {
    const i = s.i;
    if (i >= 0 && i < ley.length) ley[i] = 255;
  }
}

/** Number of tiles the ley field touches (≥ half strength). */
export function leyTiles(ley) {
  let n = 0;
  for (let i = 0; i < ley.length; i++) if (ley[i] >= 128) n++;
  return n;
}

/** Point-to-polyline distance (tiles) and the nearest edge index. */
export function nearestEdge(edges, x, y) {
  let best = -1, bd = Infinity;
  for (let e = 0; e < edges.length; e++) {
    const p = edges[e].pts;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k], ay = p[k + 1], bx = p[k + 2], by = p[k + 3];
      const vx = bx - ax, vy = by - ay;
      const L = vx * vx + vy * vy;
      const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L)) : 0;
      const dx = ax + vx * t - x, dy = ay + vy * t - y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = e; }
    }
  }
  return { edge: best, dist: Math.sqrt(bd) };
}

/** Thin a stroke of points (drawn with the Ley Line tool) into a smooth-enough polyline. */
export function simplifyStroke(pts, minStep = 1.2) {
  if (pts.length < 4) return pts.slice();
  const out = [pts[0], pts[1]];
  for (let k = 2; k + 1 < pts.length; k += 2) {
    const lx = out[out.length - 2], ly = out[out.length - 1];
    if (Math.hypot(pts[k] - lx, pts[k + 1] - ly) >= minStep || k + 2 >= pts.length) out.push(pts[k], pts[k + 1]);
  }
  return out;
}
