// Mana: ambient magic as a field on the map, and the life cycle of the myth state.
//
//   f.manaBase  F32, half resolution (W>>1)·(H>>1): the geographic base — high on and near
//               ley lines (0.85·e^(−d/6)), lifted by old forest and by nodes, faint at sea.
//   f.mana      F32, same grid: what is there now. Monthly it relaxes 4 % toward
//               manaBase × magicStrength × weave × (1 − 0.8·pollution), then arcane towns draw
//               it down (mage towers, arcane learning) and moonwells feed it, so greedy
//               capitals sit in charcoal-dark drained patches that take years to heal.
//   civ.arcane  { mana, school, known, nodes, research }: each realm's territory sample,
//               refreshed monthly (the arcane techs' minMana gate reads it).
//
// Exports manaAt(world, x, y) (bilinear, 0 outside Mythic worlds), the vegCap provider
// (vegetation capacity × (1 + 0.15·mana)) and the casusBelli provider: coveted nodes ("The War
// of the Pozuto Stones") and old enmities between peoples ("The War of Leaf and Tusk", "The
// Bitter Grudge of the Ithili and the Grukashi"). Monthly cost ≈ 0.2 ms on a medium map.

import { ensureField, bumpVersion } from '../../core/world.js';
import { registerProvider } from '../../core/ext.js';
import { addSite } from '../../core/sites.js';
import { createNoise2D, hash2i } from '../../core/rng.js';
import { WATER, BIOMES, DAYS_PER_YEAR } from '../../core/constants.js';
import { isMythic, fin, RACES, setManaReader } from './races.js';
import { generateLey, rasterAll, leyRng } from './ley.js';
let folk = null;
try { folk = await import('../geo/folk.js'); } catch (e) { /* no peoples module: the old enmities alone */ }

export const RELAX = 0.04;
const VEGMAX = Float32Array.from(BIOMES, (b) => b.vegMax);

/** The myth state of a world, or null (Historical and Legendary worlds have none). */
export const mythState = (world) => world?.sys?.myth || null;

function newState(world) {
  return {
    v: 1,
    bornDay: world.time.day,
    weave: 1,
    favor: {},
    awakenedDay: null,
    ley: { edges: [] },
    stroke: null,
    fade: { min: 1, marks: {}, returned: false },
    divine: { cd: {}, n: 0, last: null, byDomain: {} },
    first: {},
    counts: { lines: 0, wells: 0, spells: 0 },
    niche: null,
    peak: {},
  };
}
/** Fill defaults on an older state (idempotent). */
function normaliseState(st) {
  st.v ??= 1;
  if (!Number.isFinite(st.weave)) st.weave = 1;
  st.favor ||= {};
  st.ley ||= { edges: [] };
  st.ley.edges ||= [];
  st.fade ||= { min: 1, marks: {}, returned: false };
  st.fade.marks ||= {};
  st.divine ||= { cd: {}, n: 0, last: null, byDomain: {} };
  st.divine.cd ||= {};
  st.divine.byDomain ||= {};
  st.first ||= {};
  st.counts ||= { lines: 0, wells: 0, spells: 0 };
  st.peak ||= {};
  if (!('awakenedDay' in st)) st.awakenedDay = null;
  if (!('stroke' in st)) st.stroke = null;
  return st;
}

/** Ley nodes of the world (pinned sites of kind 'node'), in id order. Cached by the sites version. */
export function leyNodes(world) {
  const c = world.cache;
  const v = world.versions.sites;
  if (c.mythNodes && c.mythNodesV === v) return c.mythNodes;
  const out = [];
  for (const s of world.sites) if (s && s.kind === 'node') out.push(s);
  c.mythNodes = out; c.mythNodesV = v;
  return out;
}

/** Half-resolution grid size. */
export const gridOf = (world) => ({ W2: Math.max(1, world.W >> 1), H2: Math.max(1, world.H >> 1) });

/**
 * Start (or resume) the myth on a Mythic world: state, fields and the ley network. Idempotent
 * and safe after load: a saved world keeps its network and fields; a world missing them
 * (an old save) rebuilds them from the stored edges. Returns { st, fresh }.
 */
export function startMyth(world) {
  let st = world.sys.myth;
  // a Legendary world keeps only its folklore under sys.myth; awakening it starts afresh
  const fresh = !st || st.v == null;
  if (fresh) st = world.sys.myth = Object.assign(newState(world), st && st.folk ? { folk: st.folk } : {});
  normaliseState(st);
  const { N } = world;
  const { W2, H2 } = gridOf(world);
  const M = W2 * H2;
  const had = world.f.ley?.length === N && world.f.mana?.length === M && world.f.manaBase?.length === M;
  const ley = ensureField(world, 'ley', Uint8Array, N);
  ensureField(world, 'manaBase', Float32Array, M);
  ensureField(world, 'mana', Float32Array, M);
  if (fresh && !leyNodes(world).length && !st.ley.edges.length) {
    buildNetwork(world, st);
    computeManaBase(world);
    resetMana(world);
  } else if (!had) {
    rasterAll(world, ley, st.ley.edges, leyNodes(world));
    computeManaBase(world);
    resetMana(world);
  }
  return { st, fresh };
}

/** Generate the network and store it: node sites plus edges by site id. */
function buildNetwork(world, st) {
  const gen = generateLey(world, leyRng(world));
  const ids = gen.nodes.map((n) => addSite(world, {
    kind: 'node', x: n.x, y: n.y, i: n.i, name: n.name, pinned: true, fame: 1 + n.power,
    data: { power: n.power, nk: n.kind, short: n.short, origin: 'gen' },
  }).id);
  st.ley.edges = gen.edges.map((e) => ({ a: ids[e.a], b: ids[e.b], w: e.w, pts: e.pts, by: 'gen', day: world.time.day }));
  rasterAll(world, world.f.ley, st.ley.edges, leyNodes(world));
  bumpVersion(world, 'ley');
}

/** Distance (tiles) from each half-res cell to the nearest strong ley tile: a two-pass chamfer. */
function leyDistance(world) {
  const { W, H, f } = world;
  const { W2, H2 } = gridOf(world);
  const D = new Float32Array(W2 * H2).fill(1e6);
  const ley = f.ley;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (ley[y * W + x] < 128) continue;
    const cx = Math.min(W2 - 1, x >> 1), cy = Math.min(H2 - 1, y >> 1);
    D[cy * W2 + cx] = 0;
  }
  const S = 2, Dg = 2 * Math.SQRT2;   // cell steps in tiles
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
    const c = y * W2 + x;
    let d = D[c];
    if (x > 0 && D[c - 1] + S < d) d = D[c - 1] + S;
    if (y > 0) {
      if (D[c - W2] + S < d) d = D[c - W2] + S;
      if (x > 0 && D[c - W2 - 1] + Dg < d) d = D[c - W2 - 1] + Dg;
      if (x < W2 - 1 && D[c - W2 + 1] + Dg < d) d = D[c - W2 + 1] + Dg;
    }
    D[c] = d;
  }
  for (let y = H2 - 1; y >= 0; y--) for (let x = W2 - 1; x >= 0; x--) {
    const c = y * W2 + x;
    let d = D[c];
    if (x < W2 - 1 && D[c + 1] + S < d) d = D[c + 1] + S;
    if (y < H2 - 1) {
      if (D[c + W2] + S < d) d = D[c + W2] + S;
      if (x < W2 - 1 && D[c + W2 + 1] + Dg < d) d = D[c + W2 + 1] + Dg;
      if (x > 0 && D[c + W2 - 1] + Dg < d) d = D[c + W2 - 1] + Dg;
    }
    D[c] = d;
  }
  return D;
}

/** Recompute f.manaBase from the ley field, the nodes and the land (after any ley edit). */
export function computeManaBase(world) {
  const { W, H, f } = world;
  const { W2, H2 } = gridOf(world);
  const base = f.manaBase;
  if (!base || base.length !== W2 * H2) return;
  const D = leyDistance(world);
  const noise = createNoise2D(String(world.seed) + ':mana');
  const nodes = leyNodes(world);
  for (let cy = 0; cy < H2; cy++) for (let cx = 0; cx < W2; cx++) {
    const c = cy * W2 + cx;
    const x = Math.min(W - 1, cx * 2), y = Math.min(H - 1, cy * 2);
    let land = 0, vm = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const xx = Math.min(W - 1, x + dx), yy = Math.min(H - 1, y + dy);
      const j = yy * W + xx;
      if (f.water[j] === WATER.LAND) { land++; vm += VEGMAX[f.biome[j]]; }
    }
    vm = land ? vm / land : 0;
    let m = 0.8 * Math.exp(-D[c] / 5.5) + 0.2 * vm + 0.05 * noise(cx * 0.11, cy * 0.11);
    for (const n of nodes) {
      const dx = n.x - (cx * 2 + 0.5), dy = n.y - (cy * 2 + 0.5);
      const d2 = dx * dx + dy * dy;
      if (d2 > 144) continue;
      m += 0.3 * fin(n.data?.power, 0.8) * Math.exp(-Math.sqrt(d2) / 3.5);
    }
    if (!land) m *= 0.55;
    base[c] = m < 0 ? 0 : m > 1.25 ? 1.25 : m;
  }
  bumpVersion(world, 'ley');
}

/** Set the current mana to its target (genesis, awakening, an old save). */
export function resetMana(world) {
  const { f } = world;
  const st = world.sys.myth;
  const k = fin(world.params.magicStrength, 1) * fin(st?.weave, 1);
  for (let c = 0; c < f.mana.length; c++) f.mana[c] = f.manaBase[c] * k;
}

// ---------------------------------------------------------------------------
// Sampling

/** Mana at a point (bilinear on the half-res grid), 0 outside Mythic worlds. */
export function manaAt(world, x, y) {
  if (!isMythic(world)) return 0;
  const m = world.f.mana;
  if (!m) return 0;
  const { W2, H2 } = gridOf(world);
  if (m.length !== W2 * H2) return 0;
  const u = Math.max(0, Math.min(W2 - 1.001, x / 2 - 0.25)), v = Math.max(0, Math.min(H2 - 1.001, y / 2 - 0.25));
  const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
  const x1 = Math.min(W2 - 1, x0 + 1), y1 = Math.min(H2 - 1, y0 + 1);
  const a = m[y0 * W2 + x0], b = m[y0 * W2 + x1], c = m[y1 * W2 + x0], d = m[y1 * W2 + x1];
  const r = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  return Number.isFinite(r) ? r : 0;
}
/** Mana of the cell holding tile i (no interpolation: for per-tile providers). */
export function manaCell(world, i) {
  const m = world.f.mana;
  if (!m) return 0;
  const W2 = world.W >> 1;
  const x = (i % world.W) >> 1, y = ((i / world.W) | 0) >> 1;
  const c = Math.min((world.H >> 1) - 1, y) * W2 + Math.min(W2 - 1, x);
  const v = m[c];
  return v > 0 ? v : 0;
}

/** Land-mean mana and the share of land cells above 0.6 (for reports and records). */
export function manaStats(world) {
  const { f, W, H } = world;
  const { W2, H2 } = gridOf(world);
  if (!f.mana || f.mana.length !== W2 * H2) return { mean: 0, rich: 0, drained: 0, cells: 0 };
  let s = 0, n = 0, rich = 0, drained = 0;
  for (let cy = 0; cy < H2; cy++) for (let cx = 0; cx < W2; cx++) {
    const i = Math.min(H - 1, cy * 2) * W + Math.min(W - 1, cx * 2);
    if (f.water[i] !== WATER.LAND) continue;
    const c = cy * W2 + cx;
    const v = f.mana[c];
    s += v; n++;
    if (v > 0.6) rich++;
    if (f.manaBase[c] > 0.3 && v < 0.35 * f.manaBase[c]) drained++;
  }
  return { mean: n ? s / n : 0, rich: n ? rich / n : 0, drained: n ? drained / n : 0, cells: n };
}

// ---------------------------------------------------------------------------
// Monthly

let ARCANE_IDS = [];       // set by arcana.js (tech ids of the arcane branch), code not state
let ARCANE_SET = new Set();
export function setArcaneIds(ids) { ARCANE_IDS = ids.slice(); ARCANE_SET = new Set(ids); }
export const isArcaneTech = (id) => ARCANE_SET.has(id);
setManaReader(manaAt);   // races.js: elves breed with the magic around them

/**
 * What a town's mages (trades.js, s.jobs[11]) are to its drain on mana: their number over a plain
 * town's (0.4 % of the hands × arts ÷ 4, up to 1.5, × the weave: full mana, no tower, no lean),
 * 0.5–2; 1 for a town without them.
 */
function mageDrainF(world, s, kn) {
  const j = s.jobs;
  if (!j || j.length < 15) return 1;
  let W = 0;
  for (let t = 0; t < j.length; t++) W += j[t];
  const plain = 0.004 * Math.min(1.5, kn / 4) * Math.max(0, Math.min(1, fin(world.sys.myth?.weave, 1))) * W;
  return plain > 0 ? Math.max(0.5, Math.min(2, j[11] / plain)) : 1;
}

/** How many arcane arts a realm knows. */
export function arcaneKnown(civ) {
  const k = civ?.tech?.known;
  if (!k) return 0;
  let n = 0;
  for (const id of ARCANE_IDS) if (k[id] != null) n++;
  return n;
}

/**
 * The monthly pass: relax toward the target, arcane drains and moonwell sources, then the
 * per-realm territory sample into civ.arcane. Costs O(cells + settlements).
 */
export function monthlyMana(world) {
  const st = world.sys.myth;
  const { f, W, H } = world;
  const { W2, H2 } = gridOf(world);
  const M = W2 * H2;
  const mana = f.mana, base = f.manaBase;
  if (!mana || mana.length !== M || !base) return;
  const k = fin(world.params.magicStrength, 1) * fin(st.weave, 1);
  relaxKernel(mana, base, f.pollution, k, W, H, W2, H2);
  // the arcane towns: mage towers and learned realms draw on the weave, moonwells feed it
  const civs = world.civs;
  const known = new Map();
  for (const s of world.settlements) {
    if (!s || !s.alive) continue;
    const civ = civs[s.civId];
    if (!civ || !civ.alive) continue;
    let kn = known.get(civ.id);
    if (kn == null) { kn = arcaneKnown(civ); known.set(civ.id, kn); }
    const tower = fin(s.buildings?.magetower, 0), well = fin(s.buildings?.moonwell, 0);
    if (!kn && !tower && !well) continue;
    const popF = Math.sqrt(Math.min(1.6, fin(s.population, 0) / 8000));
    // the town's mages (trades.js): a tower or a people of mages draws harder, a town where the
    // weave runs thin has fewer to draw (their number over a plain town's, 0.5–2)
    const drain = 0.0012 * kn * popF * mageDrainF(world, s, kn) + 0.009 * tower - 0.008 * well;
    if (!drain) continue;
    const cx0 = Math.min(W2 - 1, s.x >> 1), cy0 = Math.min(H2 - 1, s.y >> 1);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = cx0 + dx, cy = cy0 + dy;
      if (cx < 0 || cy < 0 || cx >= W2 || cy >= H2) continue;
      const c = cy * W2 + cx;
      const v = mana[c] - drain * (dx === 0 && dy === 0 ? 1 : 0.45);
      mana[c] = v < 0 ? 0 : v > 1.5 ? 1.5 : v;
    }
  }
  sampleRealms(world, known);
}

/** The realms' mana sample over the half-resolution grid (typed arrays only; see sampleRealms). */
function realmKernel(owner, mana, W, H, W2, H2, n, researching, sum, cnt) {
  for (let cy = 0; cy < H2; cy++) {
    const ty = Math.min(H - 1, cy * 2) * W;
    for (let cx = 0; cx < W2; cx++) {
      const o = owner[ty + Math.min(W - 1, cx * 2)];
      if (o < 0 || o >= n) continue;
      const c = cy * W2 + cx;
      if (researching[o]) { const v = mana[c] - 0.0015; mana[c] = v < 0 ? 0 : v; }
      sum[o] += mana[c]; cnt[o]++;
    }
  }
}
/** The monthly relaxation of mana toward its base (typed arrays only; see monthlyMana). */
function relaxKernel(mana, base, poll, k, W, H, W2, H2) {
  for (let cy = 0; cy < H2; cy++) {
    const ty = Math.min(H - 1, cy * 2) * W;
    for (let cx = 0; cx < W2; cx++) {
      const c = cy * W2 + cx;
      const p = poll[ty + Math.min(W - 1, cx * 2)];
      const target = base[c] * k * (1 - 0.8 * (p > 1 ? 1 : p));
      mana[c] += (target - mana[c]) * RELAX;
    }
  }
}

/** civ.arcane for every live realm: mean mana over its land (and an arcane-research drain). */
function sampleRealms(world, known) {
  const { f, W, H } = world;
  const { W2, H2 } = gridOf(world);
  const mana = f.mana;
  const civs = world.civs;
  const n = civs.length;
  const sum = new Float64Array(n), cnt = new Int32Array(n);
  const researching = new Uint8Array(n);
  for (const c of civs) if (c && c.alive && isArcaneTech(c.tech?.research)) researching[c.id] = 1;
  realmKernel(f.owner, mana, W, H, W2, H2, n, researching, sum, cnt);
  const nodes = leyNodes(world);
  const nodeCount = new Int32Array(n);
  for (const s of nodes) { const o = f.owner[s.i]; if (o >= 0 && o < n) nodeCount[o]++; }
  for (const civ of civs) {
    if (!civ || !civ.alive) continue;
    const cap = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
    const m = cnt[civ.id] ? sum[civ.id] / cnt[civ.id] : cap ? manaAt(world, cap.x, cap.y) : manaAt(world, fin(civ.originX), fin(civ.originY));
    civ.arcane = {
      mana: Math.round(m * 1000) / 1000,
      school: RACES[civ.race]?.school || 'wizardry',
      known: known.get(civ.id) ?? arcaneKnown(civ),
      nodes: nodeCount[civ.id],
      research: Boolean(researching[civ.id]),
    };
  }
}

/** A fresh civ.arcane for a realm just born (before its first monthly sample). */
export function seedArcane(world, civ) {
  const cap = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
  const x = cap ? cap.x : fin(civ.originX), y = cap ? cap.y : fin(civ.originY);
  civ.arcane = { mana: Math.round(manaAt(world, x, y) * 1000) / 1000, school: RACES[civ.race]?.school || 'wizardry', known: arcaneKnown(civ), nodes: 0, research: false };
}

// ---------------------------------------------------------------------------
// Providers

registerProvider('vegCap', 'myth', (world, i) => {
  if (!isMythic(world)) return 1;
  return 1 + 0.15 * manaCell(world, i);
});

/** Nodes held by civ b that civ a could reach: [{ site, d }] (pure). */
function covetedNodes(world, a, b) {
  const f = world.f;
  const out = [];
  const towns = a.settlementIds || [];
  for (const s of leyNodes(world)) {
    if (f.owner[s.i] !== b.id) continue;
    let d = Infinity;
    for (const sid of towns) {
      const t = world.settlements[sid];
      if (!t || !t.alive) continue;
      const dd = Math.hypot(t.x - s.x, t.y - s.y);
      if (dd < d) d = dd;
    }
    if (d <= 26) out.push({ site: s, d });
  }
  return out;
}

// Ancient enmities between peoples (the pairs that raise the claim) and how their wars are
// named: each people's emblems, a feud word and the peoples' own names, plus a few old songs
// ({A}, {B} the peoples, {a}, {b} their lands; the realm making the claim is a, its foe b; a
// 'race:' prefix keeps a song for a foe of that race: only elves have woods to fell).
const ENMITY_NAMES = {
  'elf|orc': ['The War of Root and Tusk', 'The Burning of the Green', 'The Long Hunt of the {A} and the {B}', 'elf:The Felling of the {B} Woods', 'elf:The Burning of {b}'],
  'dwarf|orc': ['The War of Axe and Tusk', 'The War of the Deep Gates', 'The Long Feud of the Holds', 'dwarf:The Siege of the {B} Gates', 'The Harrowing of {b}'],
  'dwarf|elf': ['The War of Leaf and Stone', 'The Quarrel of the Mountain and the Wood', 'The Old Grudge of the {A} and the {B}'],
  'halfling|orc': ['The War of the Burned Shires', 'The Harrowing of {b}', 'halfling:The Trampling of the {B} Fields'],
};
const HATRED_NAMES = ['The War of Old Hatred', 'The Hatred of the {A} and the {B}', 'The Long Grudge of the {A} and the {B}'];
const EMBLEMS = {
  human: ['Sword', 'Crown', 'Plough', 'Banner', 'Torch', 'Wheel'],
  elf: ['Leaf', 'Root', 'Bough', 'Bow', 'Star', 'Thorn', 'Willow'],
  dwarf: ['Axe', 'Hammer', 'Stone', 'Anvil', 'Beard', 'Pick'],
  orc: ['Tusk', 'Skull', 'Fang', 'Spear', 'Drum', 'Wolf'],
  halfling: ['Hearth', 'Plough', 'Pipe', 'Hedge', 'Kettle', 'Apple'],
  lizardfolk: ['Scale', 'Coil', 'Egg', 'Reed', 'Fang', 'Sun'],
};
const FEUD = ['Long', 'Bitter', 'Old', 'Red', 'Black', 'Grey', 'Hundred-Year', 'Unending', 'Blood', 'Ancient'];
const FEUD_N = ['Feud', 'War', 'Hatred', 'Reckoning', 'Grudge', 'Vendetta'];
const enmityKey = (r1, r2) => [r1, r2].sort().join('|');

/** The name of a war of old enmity between realms a and b (pure: hashed by the pair and the year). */
function enmityName(world, a, b, pool) {
  const h = hash2i(a.id, b.id, Math.floor(world.time.day / DAYS_PER_YEAR) * 7 + 3);
  const u = (k) => hash2i(h, k, 0x5e11);
  const A = a.adjective || a.name, B = b.adjective || b.name;
  const ea = EMBLEMS[a.race] || EMBLEMS.human, eb = EMBLEMS[b.race] || EMBLEMS.human;
  let e1 = ea[u(1) % ea.length], e2 = eb[u(2) % eb.length];
  if (e1 === e2) e2 = eb[(u(2) + 1) % eb.length];
  switch (h % 8) {
    case 0: return `The War of ${e1} and ${e2}`;                                   // The War of Leaf and Tusk
    case 1: case 2: return `The ${FEUD[u(3) % FEUD.length]} ${FEUD_N[u(4) % FEUD_N.length]} of the ${A} and the ${B}`;
    case 3: return `The ${A}–${B} ${u(3) & 1 ? 'Blood-Feud' : 'Blood-War'}`;
    case 4: case 5: return `The ${A} War of ${e1} and ${e2}`;                      // The Ithili War of Leaf and Tusk
    default: {
      const songs = pool.filter((t) => !/^[a-z]+:/.test(t) || t.startsWith(b.race + ':')).map((t) => t.replace(/^[a-z]+:/, ''));
      return songs[u(5) % songs.length].replace('{A}', A).replace('{B}', B).replace('{a}', a.baseName || A).replace('{b}', b.baseName || B);
    }
  }
}

/** The name of a war over a coveted place of power ("The War of the Pozuto Stones"). */
function nodeWarName(a, b, site) {
  const raw = String(site.data?.short || 'the Stones');
  const short = raw.replace(/^The /, 'the ');
  const h = hash2i(a.id * 131 + b.id, site.id, 0x1e7);
  const forms = [`The War of ${short}`, `The War of ${short}`, `The War for ${short}`, `The Struggle for ${short}`];
  const nm = forms[h % forms.length];
  return nm.charAt(0).toUpperCase() + nm.slice(1);
}

function casusBelli(world, a, b) {
  if (!isMythic(world)) return null;
  if (typeof a === 'number') a = world.civs[a];
  if (typeof b === 'number') b = world.civs[b];
  if (!a || !b || !a.alive || !b.alive) return null;
  let out = null;
  // a coveted place of power
  const learned = fin(a.arcane?.known, 0) > 0 || a.race === 'elf' || fin(a.mods?.arcana, 0) > 0;
  if (learned) {
    let best = null;
    for (const c of covetedNodes(world, a, b)) {
      const sc = fin(c.site.data?.power, 0.8) - c.d / 60;
      if (!best || sc > best.sc) best = { ...c, sc };
    }
    if (best) {
      (out ||= []).push({ cb: 'witchstone', w: 0.35 + 0.35 * fin(best.site.data?.power, 0.8), name: nodeWarName(a, b, best.site), siteId: best.site.id });
    }
  }
  // an ancient enmity between peoples: a people that hates another (−50 or worse, geo/folk.js)
  // goes to war over it, the more readily the deeper the hatred; the old named feuds otherwise
  // need an aggressive realm
  if (a.race && b.race && a.race !== b.race) {
    const pool = ENMITY_NAMES[enmityKey(a.race, b.race)] || HATRED_NAMES;
    const f = folk ? folk.feel(world, 'r:' + a.race, 'r:' + b.race) : 0;
    const aggr = fin(a.traits?.aggression, 0.5) >= 0.55;
    if (f <= -50) (out ||= []).push({ cb: 'enmity', w: 0.45 + 0.6 * Math.min(1, (-f - 50) / 50) + (aggr ? 0.15 : 0), name: enmityName(world, a, b, pool) });
    else if (ENMITY_NAMES[enmityKey(a.race, b.race)] && aggr) (out ||= []).push({ cb: 'enmity', w: 0.45, name: enmityName(world, a, b, pool) });
  }
  return out;
}
registerProvider('casusBelli', 'myth', casusBelli);
