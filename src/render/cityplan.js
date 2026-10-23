// City ground plans: from Province zoom down, a town is drawn as a plan grown from its own
// record instead of a single icon. Arterial streets leave along the town's real roads, river
// and harbour; blocks fill the footprint in growth order (rings around a market square, or a
// grid, by the founders' layout), built out to the peak population and lived in up to today's —
// the rest stand roofless and overgrown, so decline shows. Walls follow the walls level
// (palisade, stone walls with towers, castle and keep, star fort with bastions), with gates
// where the streets cross them and breaches growing with a siege. Landmarks come from the
// buildings: palace, temple roofed in its faith's colour (shrine, temple, cathedral in the
// founders' temple form), market stalls or a bazaar, library, university, theatre, barracks,
// granary, guildhall, bank, hospital, aqueduct toward the hills, harbour piers with ships moored
// by its sea trade, mine headframe, observatory, factories smoking downwind, station and
// railway, power station, airport along the wind; a standing wonder; scaffolding on the
// current project; a siege camp in the besieger's colours. Roofs and walls follow the founding
// people's style (civ.style of the origin civ, or one derived from its homeland), and Mythic
// races build their own way on the same geometry (raceplan.js): halfling smials in terraced
// hills, dwarven terraces below a hold gate cut in the rock, elven tree-halls round a great
// tree, an orcish war-camp round its war-pit, lizardfolk stilt houses round a ziggurat. A
// Mythic world's human towns are planned like any other. A town whose second people is a
// quarter or more of it gives them a wedge of its blocks to build their own way (a quarter:
// raceplan.js quarterOf / paintQuarter). Ruined towns keep their foundations, reclaimed by
// green over the centuries.
//
// Plans are geometry (buildPlan, cached by a coarse key so monthly noise never rebuilds them)
// painted into a canvas at the LOD level's pixel density (cached, LRU by bytes) and blitted
// in world space each frame; smoke and the like are spawned live. The footprint radius is
// clamped to 0.45 × the distance to the nearest neighbour so suburbs never overlap.

import { WATER, BIOME, RESOURCES, RACE_META } from '../core/constants.js';
import { liveSettlements } from '../core/entities.js';
import { hash2i } from '../core/rng.js';
import { clamp, smoothstep } from '../core/util.js';
import { makeCanvas } from './terrain.js';
import { LOD_P, pickLevel } from './lod.js';
import { css, darken, lighten, mix3, civRgb, religionRgb, INK, MATERIAL, ROOF_COLOR } from './palette.js';
import { RACE_CORE, raceLandmarks, paintRaceTown, quarterOf, paintQuarter } from './raceplan.js';

export { MATERIAL };

const TAU = Math.PI * 2;
const hf = (h, s = 0, bits = 8) => ((h >>> s) & ((1 << bits) - 1)) / ((1 << bits) - 1);
const perf = () => (globalThis.performance ? performance.now() : 0);

// ---------------------------------------------------------------------------
// Footprints

/**
 * Footprint radius in tiles for a population: a cartographic exaggeration of a town's built
 * area (a village ≈ 0.13 tile, a town of 15,000 ≈ 0.46, a metropolis ≈ 0.85, at most 0.9).
 */
export function footprintR(pop) {
  const p = Math.max(0, Number(pop) || 0);
  return Math.max(0.07, Math.min(0.9, 0.07 + 0.09 * Math.log2(1 + p / 800)));
}

/** Footprints of the living towns, cached per settlements version: [{ id, x, y, r }] plus a coarse grid. */
export function footprints(r) {
  const w = r.world;
  const key = `${w.versions.settlements}|${w.settlements.length}`;
  if (r._fpKey === key && r._fp) return r._fp;
  const list = [];
  const G = 8, gw = Math.ceil(w.W / G), gh = Math.ceil(w.H / G);
  const grid = new Map();
  for (const s of liveSettlements(w)) {
    const t = { id: s.id, x: s.x, y: s.y, r: footprintR(Math.max(s.peakPopulation || 0, s.population || 0)), nn: Infinity, tx: s.x, ty: s.y };
    list.push(t);
    const k = Math.floor(t.y / G) * gw + Math.floor(t.x / G);
    let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(t);
  }
  // nearest neighbour: suburbs stop short of the next town
  for (const t of list) {
    const gx = Math.floor(t.x / G), gy = Math.floor(t.y / G);
    for (let yy = gy - 1; yy <= gy + 1; yy++) for (let xx = gx - 1; xx <= gx + 1; xx++) {
      const a = grid.get(yy * gw + xx);
      if (!a) continue;
      for (const o of a) if (o !== t) { const d = Math.hypot(o.x - t.x, o.y - t.y); if (d < t.nn) t.nn = d; }
    }
    t.r = Math.min(t.r, Math.max(0.06, 0.45 * t.nn));
    // the plan centres on its square, which a river may push off the town's tile centre
    const s = w.settlements[t.id];
    const rv = riversNear(r, s);
    if (rv.length) {
      const d = clamp(t.r / (3.0 + 2.2 * Math.log10(1 + Math.max(1, s.peakPopulation || 0) / 2000)), 0.018, 0.075);
      const rCore = (s.tier | 0) >= 2 ? d * (0.75 + 0.22 * Math.min(3, (s.tier | 0) - 2)) : d * 0.3;
      const [ox, oy] = coreOffset(rv, t.r, rCore);
      t.x = s.x + ox; t.y = s.y + oy;
    }
  }
  r._fp = { list, grid, G, gw, gh, byId: new Map(list.map((t) => [t.id, t])) };
  r._fpKey = key;
  return r._fp;
}

/** Towns whose footprint meets the tile box (inclusive). */
export function townsIn(r, x0, y0, x1, y1) {
  const fp = footprints(r);
  const out = [];
  const G = fp.G;
  for (let gy = Math.max(0, Math.floor((y0 - 1) / G)); gy <= Math.min(fp.gh - 1, Math.floor((y1 + 1) / G)); gy++) {
    for (let gx = Math.max(0, Math.floor((x0 - 1) / G)); gx <= Math.min(fp.gw - 1, Math.floor((x1 + 1) / G)); gx++) {
      const a = fp.grid.get(gy * fp.gw + gx);
      if (!a) continue;
      for (const t of a) if (t.x + t.r >= x0 - 0.5 && t.x - t.r <= x1 + 0.5 && t.y + t.r >= y0 - 0.5 && t.y - t.r <= y1 + 0.5) out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Architectural style (civ.style, else derived from the founders' homeland)

const ROOFS = ['pitched', 'flat', 'dome', 'pagoda', 'thatch', 'longhouse'];
const WALLS = ['mudbrick', 'timber', 'whitewash', 'stone', 'brick'];
const TEMPLES = ['ziggurat', 'stupa', 'basilica', 'onion', 'pyramid'];
const LAYOUTS = ['organic', 'grid', 'ring'];
function pick(arr, h) { return arr[h % arr.length]; }

/** A full style for the people who founded a town: civ.style when present, else one derived from their homeland. */
export function styleOf(r, civId, raceHint = null) {
  const w = r.world;
  if (!r._styles || r._stylesKey !== w.versions.civs) { r._styles = new Map(); r._stylesKey = w.versions.civs; }
  const key = `${civId}|${raceHint || ''}`;
  let st = r._styles.get(key);
  if (st) return st;
  const civ = civId != null && civId >= 0 ? w.civs[civId] : null;
  const h = hash2i(civId ?? -1, 17, 7001 ^ (r.seedHash || 0));
  // homeland climate
  let b = BIOME.STEPPE, t = 12;
  if (civ) {
    const cap = civ.capitalId != null ? w.settlements[civ.capitalId] : null;
    const ox = Math.round(clamp(Number.isFinite(civ.originX) && civ.originX ? civ.originX : cap ? cap.x : w.W / 2, 0, w.W - 1));
    const oy = Math.round(clamp(Number.isFinite(civ.originY) && civ.originY ? civ.originY : cap ? cap.y : w.H / 2, 0, w.H - 1));
    const i = oy * w.W + ox;
    b = w.f.biome[i]; t = w.f.annTemp ? w.f.annTemp[i] : 12;
  }
  const hot = t > 19, cold = t < 5;
  const dry = b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT || b === BIOME.SAVANNA || b === BIOME.SHRUBLAND || b === BIOME.STEPPE;
  const wet = b === BIOME.RAINFOREST || b === BIOME.TROPICAL_FOREST || b === BIOME.WETLAND;
  let roof, wall, temple;
  if (hot && dry) { roof = pick(['flat', 'flat', 'dome'], h); wall = pick(['mudbrick', 'whitewash', 'mudbrick'], h >>> 4); temple = pick(['ziggurat', 'pyramid', 'onion'], h >>> 8); }
  else if (hot && wet) { roof = pick(['thatch', 'pagoda', 'thatch'], h); wall = pick(['timber', 'mudbrick'], h >>> 4); temple = pick(['stupa', 'pyramid', 'ziggurat'], h >>> 8); }
  else if (cold) { roof = pick(['pitched', 'longhouse', 'pitched'], h); wall = pick(['timber', 'stone', 'timber'], h >>> 4); temple = pick(['basilica', 'onion', 'stupa'], h >>> 8); }
  else { roof = pick(['pitched', 'pitched', 'pagoda', 'flat'], h); wall = pick(['timber', 'stone', 'brick', 'whitewash'], h >>> 4); temple = pick(['basilica', 'onion', 'stupa', 'ziggurat'], h >>> 8); }
  const layout = pick(['organic', 'organic', 'grid', 'ring', 'organic'], h >>> 12);
  st = { roof, wall, temple, layout, palette: null, race: null };
  // the people's own record wins
  const cs = civ && civ.style && typeof civ.style === 'object' ? civ.style : null;
  if (cs) {
    if (ROOFS.includes(cs.roof)) st.roof = cs.roof;
    if (WALLS.includes(cs.wall)) st.wall = cs.wall;
    if (TEMPLES.includes(cs.temple)) st.temple = cs.temple;
    if (LAYOUTS.includes(cs.layout)) st.layout = cs.layout;
    if (Array.isArray(cs.palette) && cs.palette.length >= 3 && cs.palette.every(Number.isFinite)) st.palette = cs.palette.slice(0, 3);
  }
  // the town's own people build it (its race), else its founders' style and race; humans build
  // the ordinary way (a Mythic world's human towns keep their full plans)
  {
    const known = (rc) => (rc && RACE_META[rc] ? rc : null);
    const rc = known(raceHint) || known(cs?.race) || known(civ?.race);
    st.race = rc && rc !== 'human' ? rc : null;
  }
  if (!st.palette) {
    const base = ROOF_COLOR[st.roof] || ROOF_COLOR.pitched;
    const j = (hf(h, 20) - 0.5) * 0.16;
    st.palette = [base[0] * (1 + j), base[1] * (1 + j * 0.6), base[2] * (1 - j * 0.4)];
  }
  st.key = `${st.roof}|${st.wall}|${st.temple}|${st.layout}|${st.palette.map((v) => v | 0).join(',')}|${st.race || ''}`;
  r._styles.set(key, st);
  return st;
}

// ---------------------------------------------------------------------------
// Geometry helpers (plan-local tile coordinates around the town centre)

function bilLv(r, x, y) {
  const w = r.world, W = w.W, H = w.H, Lv = r.terrain.Lv;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const cx0 = clamp(x0, 0, W - 1), cx1 = clamp(x0 + 1, 0, W - 1), cy0 = clamp(y0, 0, H - 1), cy1 = clamp(y0 + 1, 0, H - 1);
  return Lv[cy0 * W + cx0] * (1 - fx) * (1 - fy) + Lv[cy0 * W + cx1] * fx * (1 - fy) + Lv[cy1 * W + cx0] * (1 - fx) * fy + Lv[cy1 * W + cx1] * fx * fy;
}
/** Distance from point to segment. */
function dSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / L, 0, 1) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}
function dPoly(px, py, pts) {
  let d = Infinity;
  for (let k = 0; k + 3 < pts.length; k += 2) d = Math.min(d, dSeg(px, py, pts[k], pts[k + 1], pts[k + 2], pts[k + 3]));
  return d;
}
/** Remove the arc th ± hw from each [b0, b1] (radians, b1 > b0). */
function cutArc(segs, th, hw) {
  const out = [];
  for (const [b0, b1] of segs) {
    let c = th;
    while (c < b0 - hw) c += TAU;
    while (c >= b0 - hw + TAU) c -= TAU;
    if (c - hw >= b1) { out.push([b0, b1]); continue; }
    if (c - hw > b0) out.push([b0, c - hw]);
    if (c + hw < b1) out.push([c + hw, b1]);
  }
  return out;
}
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** Rivers near the town as polylines (local coords), following the renderer's river curves. */
function riversNear(r, s) {
  const w = r.world, f = w.f, W = w.W, H = w.H, N = w.N;
  const out = [];
  const CLS_T = [0, 0.15, 0.3, 0.55, 0.8];
  // streams (class 1) pass under a town; real rivers (class 2+) run through it
  const isR = (i) => i >= 0 && i < N && f.river[i] >= 2 && f.water[i] === WATER.LAND;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    if (!isR(i)) continue;
    const j = f.flowDir[i];
    if (j < 0 || j >= N) continue;
    // the piece from this tile's centre-ish to its downstream neighbour, as the renderer curves it
    const jx = j % W, jy = (j / W) | 0;
    const ux = (x - s.x), uy = (y - s.y), vx = (jx - s.x), vy = (jy - s.y);
    // upstream main neighbour (largest flow into i)
    let up = -1, uf = -1;
    for (const [ax, ay] of N8) {
      const k = (y + ay) * W + (x + ax);
      if (x + ax < 0 || y + ay < 0 || x + ax >= W || y + ay >= H || !isR(k) || f.flowDir[k] !== i) continue;
      if (f.flow[k] > uf) { uf = f.flow[k]; up = k; }
    }
    const pts = [];
    const sx0 = up >= 0 ? ((up % W) + x) / 2 - s.x : ux, sy0 = up >= 0 ? (((up / W) | 0) + y) / 2 - s.y : uy;
    const ex = (ux + vx) / 2, ey = (uy + vy) / 2;
    for (let q = 0; q <= 6; q++) {
      const t = q / 6, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      pts.push(a * sx0 + b * ux + c * ex, a * sy0 + b * uy + c * ey);
    }
    if (f.water[j] !== WATER.LAND) pts.push(vx * 0.5 + ux * 0.5, vy * 0.5 + uy * 0.5);
    const t = CLS_T[Math.min(4, f.river[i])];
    out.push({ pts, hw: ((0.05 + 0.26 * Math.pow(t, 1.15)) / 2) * RIVER_CLOSE_K });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plan

const WALL_CAP = [0, 5000, 25000, 60000, 160000];
const WALL_N = 72;
/** Star forts: bastions pointing out between the curtains. */
const starK = (a) => { const ph = ((a / TAU) * 7) % 1; return 1 + 0.16 * Math.max(0, 1 - Math.abs(((ph + 1) % 1) - 0.5) * 4); };
/** Rivers narrow toward their true width at close zoom (the renderer's riverWidthK floor). */
const RIVER_CLOSE_K = 0.35;

/** Where a town's square sits: off the river when one runs through the centre (local tiles). */
function coreOffset(rivers, R, rCore) {
  let ox = 0, oy = 0;
  for (let it = 0; it < 4; it++) {
    let best = null, bd = Infinity;
    for (const rv of rivers) {
      for (let k = 0; k + 3 < rv.pts.length; k += 2) {
        const ax = rv.pts[k], ay = rv.pts[k + 1], bx = rv.pts[k + 2], by = rv.pts[k + 3];
        const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
        const t = L > 0 ? clamp(((ox - ax) * dx + (oy - ay) * dy) / L, 0, 1) : 0;
        const qx = ax + dx * t, qy = ay + dy * t;
        const dd = Math.hypot(ox - qx, oy - qy) - rv.hw;
        if (dd < bd) { bd = dd; best = [qx, qy, rv.hw, dx, dy]; }
      }
    }
    const need = rCore * 1.25 + 0.012;
    if (!best || bd >= need) break;
    // step away from the river, across its course
    let nx = ox - best[0], ny = oy - best[1];
    let nl = Math.hypot(nx, ny);
    if (nl < 1e-6) { nx = -best[4]; ny = best[3]; nl = Math.hypot(nx, ny) || 1; }
    ox += (nx / nl) * (need - bd + 0.004); oy += (ny / nl) * (need - bd + 0.004);
    const m = Math.hypot(ox, oy), cap = Math.max(0.03, R * 0.42);
    if (m > cap) { ox *= cap / m; oy *= cap / m; break; }
  }
  return [ox, oy];
}
const qpop = (p) => Math.round(Math.pow(2, Math.round(Math.log2(Math.max(1, p)) * 4) / 4));

/** The landmarks a town's buildings give it, most prominent first: [{ key, level, size (× block depth) }]. */
function landmarkList(s, capital, era, race = null) {
  const B = s.buildings || {};
  const L = [];
  if (race) return raceLandmarks(race, B, capital, s.tier | 0);
  if (capital) L.push({ key: 'palace', level: (s.tier | 0) >= 4 ? 2 : 1, size: (s.tier | 0) >= 4 ? 1.15 : 0.8 });
  if (B.temple) L.push({ key: 'temple', level: B.temple, size: [0, 0.38, 0.62, 0.95][Math.min(3, B.temple)] });
  if (B.market >= 2) L.push({ key: 'bazaar', level: B.market, size: 0.72 });
  if (B.university) L.push({ key: 'university', level: 1, size: 0.78 });
  if (B.library) L.push({ key: 'library', level: B.library, size: B.library >= 2 ? 0.75 : 0.5 });
  if (B.theatre) L.push({ key: 'theatre', level: B.theatre, size: B.theatre >= 2 ? 0.62 : 0.72 });
  if (B.bank) L.push({ key: 'bank', level: B.bank, size: 0.48 });
  if (B.hospital) L.push({ key: 'hospital', level: B.hospital, size: 0.55 });
  if (B.barracks) L.push({ key: 'barracks', level: B.barracks, size: B.barracks >= 2 ? 0.8 : 0.62 });
  if (B.workshop) L.push({ key: 'workshop', level: 1, size: 0.5 });
  if (B.railway) L.push({ key: 'station', level: 1, size: 0.7 });
  if (B.granary) L.push({ key: 'granary', level: B.granary, size: B.granary >= 2 ? 0.6 : 0.42 });
  if (B.magetower) L.push({ key: 'magetower', level: B.magetower, size: B.magetower >= 2 ? 0.6 : 0.46 });
  return L;
}

/** Build the plan geometry of a town (or of a ruin from its last record). */
export function buildPlan(r, s, opts = {}) {
  const w = r.world, f = w.f, W = w.W;
  const ruin = opts.ruin || null;
  const seed = (r.seedHash || 0) ^ Math.imul(s.id + 1, 0x9e3779b1);
  const H = (a, b = 0) => hash2i(a, b, seed);
  const civId = ruin ? (ruin.originCivId ?? ruin.civId ?? s.originCivId) : (s.originCivId ?? s.civId);
  const style = styleOf(r, civId, s.race);
  const peak = Math.max(1, ruin ? (ruin.peak || s.peakPopulation || 500) : Math.max(s.peakPopulation || 0, s.population || 0));
  const pop = ruin ? 0 : Math.max(0, s.population || 0);
  const tier = ruin ? (ruin.maxTier ?? s.tier ?? 2) : (s.tier | 0);
  const fp = footprints(r).byId.get(s.id);
  let R = footprintR(peak);
  if (fp) R = Math.min(R, fp.r);
  else if (ruin) R = Math.min(R, 0.5);
  if (opts.maxR) R = Math.min(R, opts.maxR);
  const rNow = ruin ? 0 : Math.min(R, footprintR(pop) * (R / footprintR(peak)));
  const owner = w.civs[s.civId];
  const era = ruin ? (ruin.era ?? 3) : (owner?.tech?.era | 0);
  const capital = !ruin && owner && owner.capitalId === s.id;
  const B = ruin ? (ruin.buildings || {}) : (s.buildings || {});
  const landAbs = (x, y) => bilLv(r, s.x + x, s.y + y) > 0.025;

  const plan = { sid: s.id, R, rNow, style, era, tier, capital, ruin: Boolean(ruin), B, blocks: [], arterials: [], walls: null, landmarks: [], piers: [], ships: [], extras: [], chimneys: [], rivers: [], ext: R * 1.12 };
  plan.d = clamp(R / (3.0 + 2.2 * Math.log10(1 + peak / 2000)), 0.018, 0.075);
  const d = plan.d, wS = d * 0.2, wA = d * 0.42;
  plan.wS = wS; plan.wA = wA;
  plan.rCore = tier >= 2 ? d * (0.75 + 0.22 * Math.min(3, tier - 2)) : d * 0.3;

  // rivers, sea; the square stands clear of a river that runs through the town
  const riversAbs = riversNear(r, s);
  const [ox, oy] = coreOffset(riversAbs, R, plan.rCore);
  plan.ox = ox; plan.oy = oy;
  plan.rivers = riversAbs.map((rv) => ({ hw: rv.hw, pts: rv.pts.map((v, q) => v - (q & 1 ? oy : ox)) }));
  // from here on, local coordinates are centred on the square
  const land = (x, y) => landAbs(ox + x, oy + y);
  const riverD = (x, y) => { let best = Infinity; for (const rv of plan.rivers) best = Math.min(best, dPoly(x, y, rv.pts) - rv.hw); return best; };
  // Mythic races build round a centrepiece of their own (the halflings' party field, the
  // elves' great tree, the orcs' war-pit, the lizardfolk's ziggurat, the dwarves' forecourt)
  // that takes a wider heart than a square; dwarves cut their hold into the rock on the
  // town's high side, and nothing else is built there
  const race = !ruin && style.race ? style.race : null;
  plan.race = race;
  plan.rHub = race ? Math.max(plan.rCore, Math.min(plan.rCore * (RACE_CORE[race] || 1), plan.rivers.length ? riverD(0, 0) - wS : Infinity)) : plan.rCore;
  const hub = plan.rHub;
  plan.mountA = null;
  if (race === 'dwarf') {
    let hiA = null, hiE = -Infinity;
    for (const [dx, dy] of N8) {
      const xx = s.x + dx, yy = s.y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= w.H) continue;
      const j = yy * W + xx;
      if (f.water[j] === WATER.LAND && f.elevation[j] > hiE) { hiE = f.elevation[j]; hiA = Math.atan2(dy, dx); }
    }
    plan.mountA = hiA ?? -Math.PI / 2 + (hf(H(5, 5)) - 0.5);
    plan.mountW = 0.6;
    plan.mountR = hub + d * 0.55;
  }
  const inMount = (x, y) => plan.mountA != null && Math.hypot(x, y) > plan.mountR - d * 0.3 && Math.abs(angDiff(Math.atan2(y, x), plan.mountA)) < plan.mountW;
  let sx = 0, sy = 0, sn = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    if (!dx && !dy) continue;
    const xx = s.x + dx, yy = s.y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= w.H) continue;
    if (f.water[yy * W + xx] !== WATER.LAND) { const g = 1 / Math.hypot(dx, dy); sx += dx * g; sy += dy * g; sn += g; }
  }
  const seaDir = sn > 0.3 ? Math.atan2(sy, sx) : null;
  plan.seaDir = seaDir;

  // arterials: the town's real roads, its river banks and the way to its harbour
  const dirs = [];
  for (const [dx, dy] of N8) {
    const xx = s.x + dx, yy = s.y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= w.H) continue;
    const j = yy * W + xx;
    if (f.road[j] > 0 && f.water[j] === WATER.LAND) dirs.push({ a: Math.atan2(dy, dx), main: f.road[j] });
  }
  if (seaDir != null) dirs.push({ a: seaDir, main: 0.5 });
  for (const rv of plan.rivers) {
    const n = rv.pts.length / 2;
    if (dPoly(0, 0, rv.pts) < 0.4) { dirs.push({ a: Math.atan2(rv.pts[1], rv.pts[0]), main: 0.3 }); dirs.push({ a: Math.atan2(rv.pts[n * 2 - 1], rv.pts[n * 2 - 2]), main: 0.3 }); }
  }
  dirs.sort((a, b) => b.main - a.main);
  const art = [];
  for (const dd of dirs) if (art.every((a) => Math.abs(angDiff(a, dd.a)) > 0.62)) art.push(dd.a);
  const want = ruin ? 2 : tier >= 4 ? 4 : tier >= 2 ? 3 : 2;
  let guard = 0;
  while (art.length < want && guard++ < 24) {
    const a = (art.length ? art[0] + Math.PI * (art.length % 2 ? 1 : 0.5) : 0) + (hf(H(guard, 1)) - 0.5) * 1.1;
    if (art.every((b) => Math.abs(angDiff(a, b)) > 0.7)) art.push(a);
  }
  const grid = style.layout === 'grid' && tier >= 2 && !style.race;
  const bendOf = (k) => (grid ? 0 : (hf(H(k, 2)) - 0.5) * 0.7);
  plan.artAngle = (k, rho) => art[k] + bendOf(k) * (rho / Math.max(0.05, R)) ** 2;
  for (let k = 0; k < art.length; k++) {
    const pts = [];
    const L = R * 1.3;
    for (let q = 0; q <= 10; q++) {
      const rho = (q / 10) * L;
      const a = plan.artAngle(k, rho);
      const x = Math.cos(a) * rho, y = Math.sin(a) * rho;
      if (q > 1 && (!land(x, y) || inMount(x, y))) break;
      pts.push(x, y);
    }
    if (pts.length >= 4) plan.arterials.push({ pts, a: art[k], k, main: k === 0 });
  }
  const nearArterial = (x, y, pad) => {
    for (const a of plan.arterials) if (dPoly(x, y, a.pts) < wA / 2 + pad) return true;
    return false;
  };

  // organic wobble of the town's rings
  const p1 = hf(H(3, 3)) * TAU, p2 = hf(H(4, 4)) * TAU;
  const wobAmp = grid ? 0 : style.layout === 'ring' ? 0.03 : 0.075;
  const wob = (a) => 1 + wobAmp * (Math.sin(3 * a + p1) * 0.65 + Math.sin(5 * a + p2) * 0.35);
  plan.wob = wob;

  // landmarks around the square (before blocks: they take their lots first)
  const lms = ruin ? [] : landmarkList({ ...s, buildings: B }, capital, era, race);
  if (!ruin) {
    for (const wd of w.wonders || []) {
      if (!wd || wd.sid !== s.id) continue;
      if (wd.kind === 'great_wall' || wd.kind === 'grand_canal' || wd.kind === 'great_dam') continue;
      lms.splice(Math.min(2, lms.length), 0, { key: 'wonder', kind: wd.kind, id: wd.id, ruined: wd.destroyedDay != null, size: 1.35 });
    }
    if (s.project && s.project.key && !lms.some((l) => l.key === s.project.key || (s.project.kind === 'wonder' && l.kind === s.project.key))) {
      lms.push({ key: 'project', size: s.project.kind === 'wonder' ? 1.2 : 0.55 });
    }
  }
  const placed = [];
  let lmIdx = 0;
  for (const lm of lms) {
    const size = lm.size * d;
    let done = false;
    for (let ringK = 0; ringK < 6 && !done; ringK++) {
      const rho = hub + wS + size + ringK * d * 0.9;
      if (rho + size > R * 0.98 && ringK > 0) break;
      const a0 = hf(H(lmIdx, 7)) * TAU;
      for (let q = 0; q < 18 && !done; q++) {
        const a = a0 + q * 0.37 + ringK * 0.19;
        const x = Math.cos(a) * rho * wob(a), y = Math.sin(a) * rho * wob(a);
        if (!land(x, y) || !land(x + Math.cos(a) * size, y + Math.sin(a) * size)) continue;
        if (riverD(x, y) < size + wS) continue;
        if (inMount(x, y) || inMount(x + Math.cos(a) * size, y + Math.sin(a) * size)) continue;
        if (nearArterial(x, y, size * 0.85)) continue;
        if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.size + size + wS * 1.5)) continue;
        const rot = grid ? art[0] : a + Math.PI / 2;
        const o = { ...lm, x, y, size, rot };
        placed.push(o); plan.landmarks.push(o); done = true;
      }
    }
    lmIdx++;
  }

  // walls
  const wl = Math.min(4, B.walls | 0);
  let rw = 0;
  if (wl > 0) {
    rw = Math.min(R + d * 0.35, footprintR(Math.min(peak, WALL_CAP[wl])) * (R / footprintR(peak)) + d * 0.35);
    rw = Math.max(rw, hub + d * 1.6);
    // gates where the (bending) streets cross the wall
    plan.walls = { level: wl, r: rw, gates: plan.arterials.map((a) => plan.artAngle(a.k, rw)), breaches: [], open: new Uint8Array(WALL_N + 1) };
    // fallen walls: long stretches robbed out for their stone
    if (ruin) for (let q = 0; q < 6; q++) plan.walls.breaches.push(hf(H(q, 61)) * TAU);
    // no wall over the sea or the river (the river gets a water gate)
    for (let q = 0; q <= WALL_N; q++) {
      const a = (q / WALL_N) * TAU;
      const k = wl >= 4 ? starK(a) : 1;
      const x = Math.cos(a) * rw * wob(a) * k, y = Math.sin(a) * rw * wob(a) * k;
      if (!land(x, y) || riverD(x, y) < 0.004 || inMount(x, y)) plan.walls.open[q] = 1;
    }
  }

  // blocks
  const blockOk = (pts, cx, cy) => {
    if (!land(cx, cy)) return false;
    if (inMount(cx, cy)) return false;
    for (let q = 0; q < pts.length; q += 2) if (!land(pts[q], pts[q + 1])) return false;
    if (riverD(cx, cy) < wS * 1.2 + d * 0.3) return false;
    for (let q = 0; q < pts.length; q += 2) if (riverD(pts[q], pts[q + 1]) < wS) return false;
    for (const p of placed) if (Math.hypot(p.x - cx, p.y - cy) < p.size + d * 0.45) return false;
    if (rw) {
      const a = Math.atan2(cy, cx), rr = Math.hypot(cx, cy) / wob(a);
      if (Math.abs(rr - rw) < d * 0.45) return false;
    }
    return true;
  };
  const blocks = [];
  if (grid) {
    const th = art[0], ca = Math.cos(th), sa = Math.sin(th);
    const cu = d * 1.45, cv = d * 0.95;
    const n = Math.ceil(R / Math.min(cu, cv)) + 1;
    const offs = (i, c) => Math.sign(i) * (wA / 2 + wS / 2 + (Math.abs(i) - 0.5) * (c + wS));
    for (let iu = -n; iu <= n; iu++) {
      if (iu === 0) continue;
      for (let iv = -n; iv <= n; iv++) {
        if (iv === 0) continue;
        const u = offs(iu, cu), v = offs(iv, cv);
        const cx = u * ca - v * sa, cy = u * sa + v * ca;
        const a = Math.atan2(cy, cx);
        const lim = R * (1 + 0.1 * (hf(H(iu + 50, iv + 50)) - 0.5));
        if (Math.hypot(cx, cy) > lim) continue;
        const hu = cu / 2, hv = cv / 2;
        const pts = [];
        for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const uu = u + su * hu, vv = v + sv * hv; pts.push(uu * ca - vv * sa, uu * sa + vv * ca); }
        if (Math.hypot(cx, cy) < plan.rCore + d * 0.4) continue;
        if (nearArterial(cx, cy, Math.min(hu, hv) * 0.7) && Math.abs(iu) > 1 && Math.abs(iv) > 1) continue;
        if (!blockOk(pts, cx, cy)) continue;
        blocks.push({ pts, cx, cy, rho: Math.hypot(cx, cy), a, rot: th, u: cu, v: cv });
      }
    }
  } else {
    let rho = hub + wS, band = 0;
    while (rho < R && band < 40) {
      const depth = d * (0.82 + 0.36 * hf(H(band, 11)));
      const outer = Math.min(R * 1.04, rho + depth);
      const ringRoad = style.layout === 'ring' ? band % 2 === 1 : band % 3 === 2 && R > 0.16;
      const midR = (rho + outer) / 2;
      const nseg = Math.max(3, Math.round((TAU * midR) / (d * (1.25 + 0.75 * hf(H(band, 12))))));
      const phi0 = hf(H(band, 13)) * TAU;
      for (let sgi = 0; sgi < nseg; sgi++) {
        const gap = wS / midR;
        let segs = [[phi0 + (sgi * TAU) / nseg + gap / 2, phi0 + ((sgi + 1) * TAU) / nseg - gap / 2]];
        for (const ar of plan.arterials) segs = cutArc(segs, plan.artAngle(ar.k, midR), (wA / 2 + wS / 2) / midR);
        for (const [b0, b1] of segs) {
          if ((b1 - b0) * midR < d * 0.35) continue;
          const np = Math.max(2, Math.ceil(((b1 - b0) * midR) / (d * 0.45)));
          // each block keeps its own line a little back from the street (organic towns)
          const hj = H(band * 131 + sgi, 15);
          const ri = rho + (grid || style.layout === 'ring' ? 0 : hf(hj, 0) * d * 0.16), ro = outer - (grid || style.layout === 'ring' ? 0 : hf(hj, 8) * d * 0.16);
          const pts = [];
          for (let q = 0; q <= np; q++) { const a = b0 + ((b1 - b0) * q) / np; pts.push(Math.cos(a) * ri * wob(a), Math.sin(a) * ri * wob(a)); }
          for (let q = np; q >= 0; q--) { const a = b0 + ((b1 - b0) * q) / np; pts.push(Math.cos(a) * ro * wob(a), Math.sin(a) * ro * wob(a)); }
          const am = (b0 + b1) / 2;
          const cx = Math.cos(am) * midR * wob(am), cy = Math.sin(am) * midR * wob(am);
          if (midR > R * (0.92 + 0.12 * hf(H(band * 97 + sgi, 14)))) continue;
          if (!blockOk(pts, cx, cy)) continue;
          blocks.push({ pts, cx, cy, rho: midR, a: am, a0: b0, a1: b1, r0: ri, r1: ro, band, green: band > 0 && hf(hj, 16) < 0.05 });
        }
      }
      rho = outer + (ringRoad ? d * 0.3 : wS);
      band++;
    }
  }
  // growth order: nearer first, a little jitter, then lived / abandoned by population
  for (const b of blocks) b.pri = b.rho / Math.max(0.01, R) + (hf(H(Math.round(b.cx * 997), Math.round(b.cy * 991))) - 0.5) * 0.22;
  blocks.sort((a, b) => a.pri - b.pri);
  const lived = ruin ? 0 : Math.round(blocks.length * Math.min(1, (rNow / Math.max(1e-6, R)) ** 2));
  blocks.forEach((b, k) => { b.state = k < lived ? 1 : 0; b.h = H(k, 21); });
  plan.blocks = blocks;
  if (race === 'dwarf') {
    // forges among the houses (and the rune-forge's), the innermost few smoking: every forge
    // glows in the picture, but smoke is live particles each frame, and a great hold has a
    // hundred forges (uncapped, a late Mythic world's frame cost ~1 ms more at z 20–40)
    let smokes = 0;
    for (const b of blocks) if (b.state && hf(b.h, 26) < 0.16) { b.forge = true; if (smokes++ < 6) plan.chimneys.push(b.cx, b.cy); }
  } else if (race === 'lizardfolk') {
    // houses on stilts out over the water along the shore, as many as the town's people fill
    plan.stilts = [];
    const n = Math.max(8, Math.round((TAU * R) / (d * 0.5)));
    const share = Math.min(1, (rNow / Math.max(1e-6, R)) ** 2);
    for (let q = 0; q < n; q++) {
      const a = (q / n) * TAU + (hf(H(q, 71)) - 0.5) * 0.2;
      const ca = Math.cos(a), sa = Math.sin(a);
      let shore = -1;
      for (let t = hub; t < R * 1.15; t += d * 0.25) if (!land(ca * t, sa * t)) { shore = t; break; }
      if (shore < 0) continue;
      const out = shore + d * (0.25 + 0.35 * hf(H(q, 72)));
      const x = ca * out, y = sa * out;
      if (land(x, y)) continue;
      plan.stilts.push({ x, y, a, shore, h: H(q, 73), lived: hf(H(q, 74)) < share + 0.08 });
    }
  }

  // factories downwind, on the outskirts
  if (!ruin && B.factory) {
    const i = s.i;
    const wa = Math.atan2(f.windY[i] || 0.0001, f.windX[i] || 0.0001);
    let n = 2 + B.factory * 2;
    for (const b of blocks.slice().sort((p, q) => Math.abs(angDiff(p.a, wa)) - Math.abs(angDiff(q.a, wa)) || q.rho - p.rho)) {
      if (n <= 0) break;
      if (b.rho < R * 0.45 || Math.abs(angDiff(b.a, wa)) > 0.9) continue;
      b.kind = 'factory'; b.state = 1; n--;
      plan.chimneys.push(b.cx, b.cy);
    }
    plan.windA = wa;
  }

  // a second people's quarter (Mythic): a wedge of the town's ring blocks, about as large as
  // their share, facing away from the dwarves' rock and the sea; never in a gridded town
  const q = ruin || grid ? null : quarterOf(w, s);
  if (q && q.race !== (race || 'human')) {
    const cand = blocks.filter((b) => b.a0 != null && !b.green && b.kind !== 'factory' && b.rho > hub + d * 0.3);
    const livedN = cand.filter((b) => b.state).length;
    const want = Math.round(livedN * clamp(q.share, 0.2, 0.5));
    if (want >= 1) {
      // the wedge's heading: hashed, then turned away from the hold's rock and the open sea
      let aq = hf(H(97, 97)) * TAU;
      for (let t = 0; t < 8; t++) {
        const bad = (plan.mountA != null && Math.abs(angDiff(aq, plan.mountA)) < plan.mountW + 0.5) || (seaDir != null && Math.abs(angDiff(aq, seaDir)) < 0.6);
        if (!bad) break;
        aq += TAU / 8;
      }
      cand.sort((a, b) => Math.abs(angDiff(a.a, aq)) - Math.abs(angDiff(b.a, aq)) || a.rho - b.rho);
      const picked = new Set();
      let n = 0, span = 0;
      for (const b of cand) {
        if (n >= want) break;
        picked.add(b);
        if (b.state) n++;
        span = Math.max(span, Math.abs(angDiff(b.a, aq)));
      }
      // the rest of the wedge (its empty blocks too), so the quarter reads as one piece
      for (const b of cand) if (Math.abs(angDiff(b.a, aq)) <= span) picked.add(b);
      for (const b of picked) {
        b.q = q.race;
        if (q.race === 'dwarf' && b.state && hf(b.h, 26) < 0.16) b.forge = true;
      }
      plan.quarter = { race: q.race, share: q.share, a: aq, blocks: [...picked], style: q.race === 'human' ? styleOf(r, civId, 'human') : null };
    }
  }

  // the outskirts: aqueduct, mine, observatory, power station, airport, railway
  if (!ruin) outskirts(r, s, plan, B, land);

  // harbour, piers and ships
  if (seaDir != null && (B.harbor || s.harbor || s.coastal)) {
    let shore = null;
    for (let t = 0; t < R * 1.8 + 0.3; t += 0.01) { const x = Math.cos(seaDir) * t, y = Math.sin(seaDir) * t; if (!land(x, y)) { shore = [x, y, t]; break; } }
    if (shore) {
      const lvl = B.harbor || (s.harbor ? 1 : 0);
      const nP = lvl ? 2 + lvl * 2 : 1;
      const tx = -Math.sin(seaDir), ty = Math.cos(seaDir);
      for (let k = 0; k < nP; k++) {
        const off = (k - (nP - 1) / 2) * d * 0.9;
        const bx = shore[0] + tx * off, by = shore[1] + ty * off;
        const L = d * (0.9 + 0.5 * hf(H(k, 31))) * (lvl ? 1 : 0.6);
        const ex = bx + Math.cos(seaDir) * L, ey = by + Math.sin(seaDir) * L;
        if (land(ex, ey)) continue;
        plan.piers.push(bx - Math.cos(seaDir) * d * 0.2, by - Math.sin(seaDir) * d * 0.2, ex, ey);
      }
      let routes = 0;
      for (const rt of w.tradeRoutes || []) if (rt && rt.active && rt.kind === 'sea' && (rt.aId === s.id || rt.bId === s.id)) routes++;
      const nShips = Math.min(8, (lvl ? 1 : 0) + routes);
      for (let k = 0; k < nShips && plan.piers.length; k++) {
        const pq = (k % (plan.piers.length / 4)) * 4;
        const side = (k & 1) ? 1 : -1;
        const along = 0.45 + 0.4 * hf(H(k, 33));
        const px = plan.piers[pq] + (plan.piers[pq + 2] - plan.piers[pq]) * along + tx * side * d * 0.32;
        const py = plan.piers[pq + 1] + (plan.piers[pq + 3] - plan.piers[pq + 1]) * along + ty * side * d * 0.32;
        if (land(px, py)) continue;
        plan.ships.push(px, py, seaDir + (hf(H(k, 34)) - 0.5) * 0.3, hf(H(k, 35)));
      }
      plan.shore = shore;
      plan.harborLevel = lvl;
    }
  }

  // siege: camp ring and breaches
  if (!ruin && s.siege) {
    const sg = s.siege;
    const prog = clamp(Number(sg.progress) || 0, 0, 1);
    const army = (w.armies || []).find((a) => a && a.id === sg.armyId);
    const aa = army ? Math.atan2(army.y - s.y, army.x - s.x) : hf(H(41, 41)) * TAU;
    if (plan.walls) {
      const nb = Math.ceil(prog * 3.5);
      for (let k = 0; k < nb; k++) plan.walls.breaches.push(aa + (k - (nb - 1) / 2) * 0.5 + (hf(H(k, 42)) - 0.5) * 0.2);
    }
    const scv = sg.civId ?? army?.civId ?? -1;
    plan.siege = { civId: scv, rgb: civRgb(w, scv), a: aa, r: Math.max(rw || 0, R) + d * 1.1, prog, era: w.civs[scv]?.tech?.era | 0 };
    plan.ext = Math.max(plan.ext, plan.siege.r + d * 0.8);
  }
  if (!ruin && s.project) plan.project = { kind: s.project.kind, key: s.project.key, p: clamp((s.project.progress || 0) / Math.max(1, s.project.cost || 1), 0, 1) };
  plan.plague = !ruin && Boolean(s.disease);
  plan.famine = !ruin && (s.famine || 0) > 0;
  plan.religion = !ruin && s.dominantReligion != null && w.religions?.[s.dominantReligion] ? religionRgb(w, s.dominantReligion) : null;
  plan.civRgb = civRgb(w, s.civId);
  plan.ruinAge = ruin ? Math.max(0, (w.time.day - (ruin.fellDay ?? s.destroyedDay ?? w.time.day)) / 360) : 0;
  for (const e of plan.extras) plan.ext = Math.max(plan.ext, Math.hypot(e.x, e.y) + (e.len || e.size || d) + d);
  if (plan.stilts) for (const q of plan.stilts) plan.ext = Math.max(plan.ext, Math.hypot(q.x, q.y) + d * 0.6);
  plan.ext = Math.min(1.9, plan.ext + d);
  // the land under the plan, sampled 14 to a tile (a soft-edged alpha mask: see applyLandMask)
  {
    const ext = plan.ext, n = Math.max(8, Math.ceil(ext * 2 * 14));
    const a = new Uint8ClampedArray(n * n);
    let all = true;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = -ext + ((i + 0.5) / n) * ext * 2, y = -ext + ((j + 0.5) / n) * ext * 2;
      const lv = bilLv(r, s.x + ox + x, s.y + oy + y);
      const v = clamp((lv + 0.01) / 0.03, 0, 1);
      a[j * n + i] = Math.round(v * 255);
      if (v < 1) all = false;
    }
    plan.mask = { n, a, ext, all };
  }
  return plan;
}

/** Things beyond the blocks: aqueduct, mine, observatory, power station, airport, railway. */
function outskirts(r, s, plan, B, land) {
  const w = r.world, f = w.f, W = w.W, R = plan.R, d = plan.d;
  const el = f.elevation;
  // highest neighbouring land
  let hiA = null, hiE = -1;
  for (const [dx, dy] of N8) {
    const xx = s.x + dx, yy = s.y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= w.H) continue;
    const j = yy * W + xx;
    if (f.water[j] === WATER.LAND && el[j] > hiE) { hiE = el[j]; hiA = Math.atan2(dy, dx); }
  }
  if (B.aqueduct && hiA != null) {
    const len = Math.min(1.25, R + 0.45);
    let L = plan.rCore;
    while (L < len && land(Math.cos(hiA) * L, Math.sin(hiA) * L)) L += 0.02;
    plan.extras.push({ key: 'aqueduct', x: 0, y: 0, a: hiA, r0: plan.rCore, len: L });
  }
  if (B.mine) {
    let best = null, bd = 9;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = s.x + dx, yy = s.y + dy;
      if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= W || yy >= w.H) continue;
      const j = yy * W + xx;
      const res = RESOURCES[f.resource[j]];
      const dd = Math.hypot(dx, dy);
      if (f.water[j] === WATER.LAND && ((res && res.id && res.kind !== 'luxury') || f.mineral[j] > 0.5) && dd < bd) { bd = dd; best = [dx, dy]; }
    }
    const a = best ? Math.atan2(best[1], best[0]) : hiA ?? 0;
    const dist = best ? Math.min(1.5, Math.max(R + d * 2, Math.hypot(best[0], best[1]) * 0.8)) : R + d * 2.2;
    const x = Math.cos(a) * dist, y = Math.sin(a) * dist;
    if (land(x, y)) plan.extras.push({ key: 'mine', x, y, size: d * (B.mine >= 2 ? 1.1 : 0.8), level: B.mine });
  }
  if (B.observatory && hiA != null) {
    const dist = R * 0.95 + d;
    const x = Math.cos(hiA + 0.4) * dist, y = Math.sin(hiA + 0.4) * dist;
    if (land(x, y)) plan.extras.push({ key: 'observatory', x, y, size: d * 0.55 });
  }
  const wa = Math.atan2(f.windY[s.i] || 0.0001, f.windX[s.i] || 0.0001);
  if (B.powerplant) {
    for (const da of [0, 0.6, -0.6, 1.2, -1.2]) {
      const a = wa + da, dist = R + d * 1.4;
      const x = Math.cos(a) * dist, y = Math.sin(a) * dist;
      if (land(x, y)) { plan.extras.push({ key: 'power', x, y, size: d * 0.9, level: B.powerplant, a }); plan.chimneys.push(x, y); break; }
    }
  }
  if (B.airport) {
    const len = 0.22 + 0.08 * B.airport;
    for (let q = 0; q < 12; q++) {
      const a = wa + Math.PI / 2 + q * 0.52;
      const dist = R + 0.12 + len * 0.35;
      const cx = Math.cos(a) * dist, cy = Math.sin(a) * dist;
      const ca = Math.cos(wa) * len / 2, sa = Math.sin(wa) * len / 2;
      if (land(cx, cy) && land(cx + ca, cy + sa) && land(cx - ca, cy - sa)) { plan.extras.push({ key: 'airport', x: cx, y: cy, a: wa, len, level: B.airport }); break; }
    }
  }
  if (B.railway && plan.arterials.length) {
    const st = plan.landmarks.find((l) => l.key === 'station');
    const sa = st ? Math.atan2(st.y, st.x) : plan.arterials[0].a;
    // through-line along the two arterials nearest the station
    const arts = plan.arterials.slice().sort((p, q) => Math.abs(angDiff(p.a, sa)) - Math.abs(angDiff(q.a, sa)));
    const lines = [];
    for (const a of arts.slice(0, 2)) {
      const pts = [];
      const off = d * 0.5;
      for (let q = 0; q <= 12; q++) {
        const rho = (st ? Math.hypot(st.x, st.y) * 0.7 : plan.rCore) + (q / 12) * (R * 1.5);
        const an = (plan.artAngle ? plan.artAngle(a.k, rho) : a.a) + off / Math.max(rho, 0.01);
        const x = Math.cos(an) * rho, y = Math.sin(an) * rho;
        if (q > 2 && !land(x, y)) break;
        pts.push(x, y);
      }
      if (pts.length >= 4) lines.push(pts);
    }
    if (lines.length) plan.extras.push({ key: 'rail', x: 0, y: 0, lines, len: R * 1.5 });
  }
}

// ---------------------------------------------------------------------------
// Painting (g's transform: plan-local tiles → canvas px)

const ROOF_SHADE = 0.2;

function polyPath(g, pts) {
  g.moveTo(pts[0], pts[1]);
  for (let k = 2; k < pts.length; k += 2) g.lineTo(pts[k], pts[k + 1]);
  g.closePath();
}

/** Roof colour of a block / building: style palette or material, jittered, washed grey in plague. */
function roofOf(plan, h) {
  const st = plan.style;
  let c = st.roof === 'flat' || st.roof === 'dome' ? MATERIAL[st.wall]?.flat || st.palette : st.palette;
  const j = (hf(h, 3) - 0.5) * 0.18;
  c = [c[0] * (1 + j), c[1] * (1 + j * 0.8), c[2] * (1 + j * 0.6)];
  if (hf(h, 11) < 0.12) c = mix3(c, MATERIAL[st.wall]?.flat || c, 0.5);
  if (plan.plague) { const l = (c[0] + c[1] + c[2]) / 3; c = mix3(c, [l, l, l * 1.02], 0.45); }
  return c;
}

/** Paint a plan at P px per tile. detail: 0 province (masses), 1 town (blocks), 2 street (buildings). */
export function paintPlan(g, plan, P, detail, opts = {}) {
  const st = plan.style, d = plan.d;
  const mat = MATERIAL[st.wall] || MATERIAL.stone;
  const px = 1 / P;                // one canvas pixel in tiles
  const lw = (v) => Math.max(px * 0.8, v);
  if (plan.race) {
    // Mythic races build their own way (raceplan.js), on the same plan geometry
    paintRaceTown(g, plan, P, detail, RACE_API, opts);
    return;
  }
  const groundC = plan.ruin ? mix3(mat.ground, [150, 156, 110], clamp(plan.ruinAge / 400, 0.2, 0.8)) : mat.ground;
  // --- the town's ground: streets between dilated blocks, the square, the arterials
  g.fillStyle = css(groundC); g.strokeStyle = css(groundC);
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath();
  for (const b of plan.blocks) polyPath(g, b.pts);
  g.lineWidth = plan.wS * 2.4;
  g.fill(); g.stroke();
  g.beginPath(); g.arc(0, 0, plan.rCore + plan.wS, 0, TAU); g.fill();
  g.lineWidth = plan.wA * 1.05;
  g.beginPath();
  for (const a of plan.arterials) { g.moveTo(a.pts[0], a.pts[1]); for (let k = 2; k < Math.min(a.pts.length, 18); k += 2) g.lineTo(a.pts[k], a.pts[k + 1]); }
  g.stroke();
  // each landmark stands in a forecourt shaped like itself
  for (const lm of plan.landmarks) {
    g.save(); g.translate(lm.x, lm.y); g.rotate(lm.rot || 0);
    const m = plan.wS * 1.2;
    g.beginPath(); g.rect(-lm.size - m, -lm.size * 0.85 - m, (lm.size + m) * 2, (lm.size * 0.85 + m) * 2); g.fill();
    g.restore();
  }
  // arterial paving
  if (detail >= 1 && !plan.ruin) {
    g.strokeStyle = css(lighten(groundC, 0.12), 0.75); g.lineWidth = plan.wA * 0.6;
    g.beginPath();
    for (const a of plan.arterials) { g.moveTo(a.pts[0], a.pts[1]); for (let k = 2; k < a.pts.length; k += 2) g.lineTo(a.pts[k], a.pts[k + 1]); }
    g.stroke();
    g.fillStyle = css(lighten(groundC, 0.14)); g.beginPath(); g.arc(0, 0, plan.rCore, 0, TAU); g.fill();
    g.strokeStyle = css(darken(groundC, 0.25), 0.5); g.lineWidth = lw(d * 0.03); g.stroke();
  }
  // --- the river through town, at its close-zoom width, with stone embankments, and a
  //     bridge where each street crosses it
  paintTownRivers(g, plan, P, detail, opts.river, mat.ground, plan.era >= 6 ? [124, 120, 116] : st.wall === 'timber' ? [142, 108, 72] : [196, 186, 166]);
  // --- blocks (a second people's quarter builds its own: raceplan.js paintQuarter)
  paintHumanBlocks(g, plan, P, detail, plan.quarter ? plan.blocks.filter((b) => !b.q) : plan.blocks, groundC);
  if (plan.quarter) paintQuarter(g, plan, P, detail, RACE_API);
  // --- landmarks
  for (const lm of plan.landmarks) paintLandmark(g, plan, lm, P, detail);
  // --- walls
  if (plan.walls) paintWalls(g, plan, P, detail);
  // --- outskirts
  for (const e of plan.extras) paintExtra(g, plan, e, P, detail);
  // --- siege camp
  if (plan.siege) paintSiege(g, plan, P, detail);
  // --- ruins: reclaimed by green
  if (plan.ruin) {
    const k = clamp(plan.ruinAge / 300, 0.15, 0.85);
    let hh = plan.sid * 7919 + 13;
    g.fillStyle = css([92, 120, 72], 0.5 + k * 0.3);
    g.beginPath();
    const n = Math.round(plan.blocks.length * (0.6 + k * 1.5));
    for (let q = 0; q < n; q++) {
      hh = Math.imul(hh ^ (hh >>> 13), 0x5bd1e995) >>> 0;
      const b = plan.blocks[hh % Math.max(1, plan.blocks.length)];
      if (!b) break;
      const rr = d * (0.12 + hf(hh, 8) * 0.22);
      const x = b.cx + (hf(hh, 16) - 0.5) * d, y = b.cy + (hf(hh, 24) - 0.5) * d;
      g.moveTo(x + rr, y); g.arc(x, y, rr, 0, TAU);
    }
    g.fill();
  }
  // nothing of the town stands in the sea …
  applyLandMask(g, plan);
  // … but its quays, piers and moored ships
  if (plan.piers.length) paintHarbour(g, plan, P, detail);
}

/** The ordinary town's blocks (roofs, lots, greens, the abandoned and factories) at a detail level. */
function paintHumanBlocks(g, plan, P, detail, blocks, groundC) {
  const d = plan.d;
  const lw = (v) => Math.max(0.8 / P, v);
  const sh = d * 0.12;
  if (detail === 0) {
    // province: masses of roofs, no outlines
    g.fillStyle = 'rgba(30,24,16,0.22)';
    g.beginPath(); for (const b of blocks) if (b.state) polyPath(g, shiftPts(b.pts, sh, sh)); g.fill();
    for (const b of blocks) {
      g.beginPath(); polyPath(g, b.pts);
      if (b.green && !plan.ruin) { g.fillStyle = 'rgb(122,150,92)'; g.fill(); }
      else if (b.state || b.kind === 'factory') { g.fillStyle = css(b.kind === 'factory' ? [120, 108, 100] : roofOf(plan, b.h)); g.fill(); }
      else { g.fillStyle = css(mix3(groundC, [128, 140, 92], 0.5), 0.9); g.fill(); }
    }
  } else {
    // shadows
    g.fillStyle = 'rgba(30,24,16,0.24)';
    g.beginPath();
    for (const b of blocks) if (b.state && detail === 1) polyPath(g, shiftPts(b.pts, sh, sh * 1.2));
    g.fill();
    for (const b of blocks) {
      if (b.kind === 'factory') { paintFactoryBlock(g, plan, b, P, detail); continue; }
      if (!b.state) { paintAbandoned(g, plan, b, P, groundC); continue; }
      if (b.green && !plan.ruin) { paintGreen(g, plan, b, P); continue; }
      if (detail === 2) { paintLots(g, plan, b, P); continue; }
      const c = roofOf(plan, b.h);
      g.beginPath(); polyPath(g, b.pts);
      g.fillStyle = css(c); g.fill();
      g.strokeStyle = css(darken(c, 0.45), 0.7); g.lineWidth = lw(d * 0.025); g.stroke();
      // roof ridges along the block, and the light side
      roofRidges(g, plan, b, c, P);
    }
  }
}

/** Erase whatever the plan painted over water (destination-in with the plan's sampled land mask). */
function applyLandMask(g, plan) {
  const m = plan.mask;
  if (!m || m.all) return;
  let c = applyLandMask.c;
  if (!c || c.width < m.n || c.height < m.n) { c = applyLandMask.c = makeCanvas(Math.max(64, m.n), Math.max(64, m.n)); applyLandMask.g = c.getContext('2d', { willReadFrequently: true }); }
  const cg = applyLandMask.g;
  const img = cg.createImageData(m.n, m.n);
  for (let k = 0; k < m.n * m.n; k++) { img.data[k * 4 + 3] = m.a[k]; }
  cg.clearRect(0, 0, c.width, c.height);
  cg.putImageData(img, 0, 0);
  g.save();
  g.globalCompositeOperation = 'destination-in';
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'low';
  // sample (i, j) sits at plan-local (−ext + (i + 0.5)·step, …)
  g.drawImage(c, 0, 0, m.n, m.n, -m.ext, -m.ext, m.ext * 2, m.ext * 2);
  g.restore();
}

/** The rivers through a town (embanked from Town zoom) and its bridges, in the given materials. */
function paintTownRivers(g, plan, P, detail, river, bank, bridge) {
  const d = plan.d, lw = (v) => Math.max(1 / P, v);
  if (plan.rivers.length) {
    const rc = river || [66, 112, 146];
    g.lineCap = 'butt'; g.lineJoin = 'round';
    if (detail >= 1 && !plan.ruin) {
      g.strokeStyle = css(darken(bank, 0.25));
      for (const rv of plan.rivers) { g.lineWidth = rv.hw * 2 + d * 0.08; g.beginPath(); polyline(g, rv.pts); g.stroke(); }
    }
    g.strokeStyle = css(rc);
    for (const rv of plan.rivers) { g.lineWidth = rv.hw * 2; g.beginPath(); polyline(g, rv.pts); g.stroke(); }
  }
  if (plan.ruin) return;
  for (const a of plan.arterials) {
    for (const rv of plan.rivers) {
      const hit = polyCross(a.pts, rv.pts);
      if (!hit) continue;
      const [mx, my, ang] = hit;
      g.save(); g.translate(mx, my); g.rotate(ang);
      const L = rv.hw * 2 + plan.wA * 1.4, Wd = plan.wA * 0.85;
      g.fillStyle = 'rgba(20,24,30,0.3)'; g.fillRect(-L / 2 + d * 0.04, -Wd / 2 + d * 0.06, L, Wd);
      g.fillStyle = css(bridge);
      g.fillRect(-L / 2, -Wd / 2, L, Wd);
      g.strokeStyle = css(INK, 0.65); g.lineWidth = lw(d * 0.03); g.strokeRect(-L / 2, -Wd / 2, L, Wd);
      if (detail >= 1) {
        // piers of the arches
        g.fillStyle = css(darken(bank, 0.15));
        const n = Math.max(1, Math.round((rv.hw * 2) / (d * 0.5)));
        for (let q = 1; q <= n; q++) { const x = -rv.hw + (q * rv.hw * 2) / (n + 1); g.fillRect(x - d * 0.035, -Wd / 2 - d * 0.04, d * 0.07, Wd + d * 0.08); }
      }
      g.restore();
    }
  }
}

function polyline(g, pts) {
  g.moveTo(pts[0], pts[1]);
  for (let k = 2; k < pts.length; k += 2) g.lineTo(pts[k], pts[k + 1]);
}
/** First crossing of polylines a and b: [x, y, angle of a there] or null. */
function polyCross(a, b) {
  for (let i = 0; i + 3 < a.length; i += 2) {
    const ax = a[i], ay = a[i + 1], bx = a[i + 2], by = a[i + 3];
    for (let j = 0; j + 3 < b.length; j += 2) {
      const cx = b[j], cy = b[j + 1], dx = b[j + 2], dy = b[j + 3];
      const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
      if (Math.abs(den) < 1e-12) continue;
      const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
      const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return [ax + (bx - ax) * t, ay + (by - ay) * t, Math.atan2(by - ay, bx - ax)];
    }
  }
  return null;
}

function shiftPts(pts, dx, dy) {
  const out = new Array(pts.length);
  for (let k = 0; k < pts.length; k += 2) { out[k] = pts[k] + dx; out[k + 1] = pts[k + 1] + dy; }
  return out;
}

function roofRidges(g, plan, b, c, P) {
  const d = plan.d;
  g.strokeStyle = css(lighten(c, 0.25), 0.55); g.lineWidth = Math.max(1 / P, d * 0.03);
  g.beginPath();
  if (b.a0 != null) {
    // a ridge along the middle of the arc
    const rm = (b.r0 + b.r1) / 2, np = 6;
    for (let q = 0; q <= np; q++) {
      const a = b.a0 + (b.a1 - b.a0) * (0.08 + 0.84 * q / np);
      const x = Math.cos(a) * rm * plan.wob(a), y = Math.sin(a) * rm * plan.wob(a);
      if (q) g.lineTo(x, y); else g.moveTo(x, y);
    }
  } else if (b.rot != null) {
    const ca = Math.cos(b.rot), sa = Math.sin(b.rot);
    g.moveTo(b.cx - ca * b.u * 0.42, b.cy - sa * b.u * 0.42); g.lineTo(b.cx + ca * b.u * 0.42, b.cy + sa * b.u * 0.42);
  }
  g.stroke();
}

/** Street level: a block as a row of houses with gardens behind. */
function paintLots(g, plan, b, P) {
  const d = plan.d, st = plan.style;
  const px = 1 / P;
  const lots = [];
  let hh = b.h;
  if (b.a0 != null) {
    const rm = (b.r0 + b.r1) / 2;
    const arc = (b.a1 - b.a0) * rm;
    const n = Math.max(1, Math.round(arc / (d * (0.42 + 0.2 * hf(hh, 2)))));
    const rows = b.r1 - b.r0 > d * 0.7 ? 2 : 1;
    for (let q = 0; q < n; q++) for (let row = 0; row < rows; row++) {
      hh = Math.imul(hh ^ (hh >>> 13), 0x5bd1e995) >>> 0;
      const a0 = b.a0 + ((b.a1 - b.a0) * q) / n, a1 = b.a0 + ((b.a1 - b.a0) * (q + 1)) / n;
      const r0 = row === 0 ? b.r0 : (b.r0 + b.r1) / 2, r1 = row === 0 && rows === 2 ? (b.r0 + b.r1) / 2 : b.r1;
      lots.push({ a0, a1, r0, r1, h: hh, front: row === 0 ? r0 : r1 });
    }
  } else {
    const n = Math.max(1, Math.round(b.u / (d * 0.45)));
    for (let q = 0; q < n; q++) for (let row = 0; row < 2; row++) {
      hh = Math.imul(hh ^ (hh >>> 13), 0x5bd1e995) >>> 0;
      lots.push({ grid: true, q, n, row, h: hh });
    }
  }
  const ca = b.rot != null ? Math.cos(b.rot) : 0, sa = b.rot != null ? Math.sin(b.rot) : 0;
  for (const L of lots) {
    // building footprint: the front part of the lot; the back is garden
    let pts;
    const depthK = 0.55 + 0.3 * hf(L.h, 4);
    if (L.grid) {
      const u0 = -b.u / 2 + (b.u * L.q) / L.n, u1 = -b.u / 2 + (b.u * (L.q + 1)) / L.n;
      const v0 = L.row ? 0 : -b.v / 2, v1 = L.row ? b.v / 2 : 0;
      const vf0 = L.row ? v1 - (v1 - v0) * depthK : v0, vf1 = L.row ? v1 : v0 + (v1 - v0) * depthK;
      const m = d * 0.03;
      pts = [];
      for (const [uu, vv] of [[u0 + m, vf0 + m], [u1 - m, vf0 + m], [u1 - m, vf1 - m], [u0 + m, vf1 - m]]) pts.push(b.cx + uu * ca - vv * sa, b.cy + uu * sa + vv * ca);
      // garden
      g.fillStyle = 'rgba(112,140,84,0.55)';
      g.beginPath();
      const gv0 = L.row ? v0 : vf1, gv1 = L.row ? vf0 : v1;
      for (const [uu, vv] of [[u0 + m, gv0 + m], [u1 - m, gv0 + m], [u1 - m, gv1 - m], [u0 + m, gv1 - m]]) g.lineTo(b.cx + uu * ca - vv * sa, b.cy + uu * sa + vv * ca);
      g.closePath(); g.fill();
    } else {
      const outerFront = L.front === L.r1;
      const fr0 = outerFront ? L.r1 - (L.r1 - L.r0) * depthK : L.r0, fr1 = outerFront ? L.r1 : L.r0 + (L.r1 - L.r0) * depthK;
      const ma = (d * 0.03) / Math.max(0.01, L.r0);
      const w0 = plan.wob;
      const P4 = (a, rr) => [Math.cos(a) * rr * w0(a), Math.sin(a) * rr * w0(a)];
      pts = [...P4(L.a0 + ma, fr0 + d * 0.02), ...P4(L.a1 - ma, fr0 + d * 0.02), ...P4(L.a1 - ma, fr1 - d * 0.02), ...P4(L.a0 + ma, fr1 - d * 0.02)];
      const gr0 = outerFront ? L.r0 : fr1, gr1 = outerFront ? fr0 : L.r1;
      g.fillStyle = 'rgba(112,140,84,0.5)';
      g.beginPath();
      const gp = [...P4(L.a0 + ma, gr0 + d * 0.02), ...P4(L.a1 - ma, gr0 + d * 0.02), ...P4(L.a1 - ma, gr1 - d * 0.02), ...P4(L.a0 + ma, gr1 - d * 0.02)];
      polyPath(g, gp); g.fill();
      if (hf(L.h, 20) < 0.35) { g.fillStyle = 'rgba(70,104,58,0.85)'; g.beginPath(); g.arc((gp[0] + gp[4]) / 2, (gp[1] + gp[5]) / 2, d * 0.07, 0, TAU); g.fill(); }
    }
    const c = roofOf(plan, L.h);
    g.fillStyle = 'rgba(30,24,16,0.28)';
    g.beginPath(); polyPath(g, shiftPts(pts, d * 0.05, d * 0.065)); g.fill();
    g.beginPath(); polyPath(g, pts);
    g.fillStyle = css(c); g.fill();
    g.strokeStyle = css(darken(c, 0.5), 0.75); g.lineWidth = Math.max(px, d * 0.018); g.stroke();
    // ridge: pitched roofs show a ridge and a lit / shaded pitch; flat roofs a parapet; domes a disc
    const cx = (pts[0] + pts[2] + pts[4] + pts[6]) / 4, cy = (pts[1] + pts[3] + pts[5] + pts[7]) / 4;
    if (st.roof === 'flat') {
      g.strokeStyle = css(darken(c, 0.2), 0.6); g.lineWidth = Math.max(px, d * 0.012);
      g.beginPath(); polyPath(g, shrinkTo(pts, cx, cy, 0.78)); g.stroke();
    } else if (st.roof === 'dome' && hf(L.h, 24) < 0.4) {
      g.fillStyle = css(lighten(c, 0.15)); g.beginPath(); g.arc(cx, cy, d * 0.08, 0, TAU); g.fill();
      g.strokeStyle = css(darken(c, 0.4), 0.7); g.stroke();
    } else if (st.roof === 'thatch') {
      g.strokeStyle = css(darken(c, 0.3), 0.5); g.lineWidth = Math.max(px, d * 0.01);
      g.beginPath(); polyPath(g, shrinkTo(pts, cx, cy, 0.5)); g.stroke();
    } else {
      const mx0 = (pts[0] + pts[6]) / 2, my0 = (pts[1] + pts[7]) / 2, mx1 = (pts[2] + pts[4]) / 2, my1 = (pts[3] + pts[5]) / 2;
      g.fillStyle = 'rgba(20,16,10,0.16)';
      g.beginPath(); g.moveTo(mx0, my0); g.lineTo(mx1, my1); g.lineTo(pts[4], pts[5]); g.lineTo(pts[6], pts[7]); g.closePath(); g.fill();
      g.strokeStyle = css(lighten(c, 0.3), 0.7); g.lineWidth = Math.max(px, d * 0.016);
      g.beginPath(); g.moveTo(mx0, my0); g.lineTo(mx1, my1); g.stroke();
      if (st.roof === 'pagoda') { g.strokeStyle = css(darken(c, 0.35), 0.8); g.beginPath(); polyPath(g, shrinkTo(pts, cx, cy, 1.06)); g.stroke(); }
    }
    if (plan.plague && hf(L.h, 28) < 0.1) {
      // a red cross on a stricken door
      g.strokeStyle = 'rgba(176,40,34,0.95)'; g.lineWidth = Math.max(px, d * 0.02);
      const s0 = d * 0.05;
      g.beginPath(); g.moveTo(cx - s0, cy); g.lineTo(cx + s0, cy); g.moveTo(cx, cy - s0); g.lineTo(cx, cy + s0); g.stroke();
    }
  }
}

function shrinkTo(pts, cx, cy, k) {
  const out = [];
  for (let q = 0; q < pts.length; q += 2) out.push(cx + (pts[q] - cx) * k, cy + (pts[q + 1] - cy) * k);
  return out;
}

/** A green: a square of grass and trees kept open among the houses. */
function paintGreen(g, plan, b, P) {
  const d = plan.d;
  g.beginPath(); polyPath(g, b.pts);
  g.fillStyle = 'rgb(122,150,92)'; g.fill();
  g.strokeStyle = 'rgba(70,90,50,0.6)'; g.lineWidth = Math.max(1 / P, d * 0.02); g.stroke();
  g.fillStyle = 'rgba(30,24,16,0.22)';
  g.beginPath();
  for (let q = 0; q < 4; q++) { const rr = d * 0.09, x = b.cx + (hf(b.h, q * 6) - 0.5) * d * 0.7 + d * 0.03, y = b.cy + (hf(b.h, q * 6 + 3) - 0.5) * d * 0.5 + d * 0.04; g.moveTo(x + rr, y); g.arc(x, y, rr, 0, TAU); }
  g.fill();
  g.fillStyle = 'rgb(76,116,62)';
  g.beginPath();
  for (let q = 0; q < 4; q++) { const rr = d * 0.09, x = b.cx + (hf(b.h, q * 6) - 0.5) * d * 0.7, y = b.cy + (hf(b.h, q * 6 + 3) - 0.5) * d * 0.5; g.moveTo(x + rr, y); g.arc(x, y, rr, 0, TAU); }
  g.fill();
}

function paintAbandoned(g, plan, b, P, groundC) {
  const d = plan.d;
  g.beginPath(); polyPath(g, b.pts);
  g.fillStyle = css(mix3(groundC, [124, 140, 92], 0.55), 0.92); g.fill();
  g.setLineDash([d * 0.12, d * 0.07]);
  g.strokeStyle = css([110, 96, 80], 0.75); g.lineWidth = Math.max(1 / P, d * 0.03);
  g.beginPath(); polyPath(g, shrinkTo(b.pts, b.cx, b.cy, 0.8)); g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(78,110,62,0.85)';
  g.beginPath();
  for (let q = 0; q < 2; q++) { const rr = d * (0.08 + 0.05 * hf(b.h, 4 + q * 6)); const x = b.cx + (hf(b.h, 8 + q * 7) - 0.5) * d * 0.6, y = b.cy + (hf(b.h, 12 + q * 5) - 0.5) * d * 0.6; g.moveTo(x + rr, y); g.arc(x, y, rr, 0, TAU); }
  g.fill();
}

function paintFactoryBlock(g, plan, b, P, detail) {
  const d = plan.d;
  g.beginPath(); polyPath(g, b.pts);
  g.fillStyle = css([118, 106, 98]); g.fill();
  g.strokeStyle = css(INK, 0.6); g.lineWidth = Math.max(1 / P, d * 0.025); g.stroke();
  if (detail >= 1) {
    // sawtooth roof: stripes across the block, each lit on one side
    g.save(); g.beginPath(); polyPath(g, b.pts); g.clip();
    const a = (b.a ?? 0) + Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
    const n = 6;
    for (let q = -n; q <= n; q++) {
      const off = (q / n) * d * 0.8;
      const x = b.cx - sa * off, y = b.cy + ca * off;
      g.strokeStyle = q & 1 ? 'rgba(220,214,206,0.55)' : 'rgba(40,34,30,0.5)';
      g.lineWidth = d * 0.06;
      g.beginPath(); g.moveTo(x - ca * d, y - sa * d); g.lineTo(x + ca * d, y + sa * d); g.stroke();
    }
    g.restore();
  }
  // chimney
  g.fillStyle = css([92, 70, 60]); g.beginPath(); g.arc(b.cx + d * 0.15, b.cy - d * 0.1, d * 0.09, 0, TAU); g.fill();
  g.strokeStyle = css(INK, 0.8); g.lineWidth = Math.max(1 / P, d * 0.02); g.stroke();
  g.fillStyle = '#2a2420'; g.beginPath(); g.arc(b.cx + d * 0.15, b.cy - d * 0.1, d * 0.045, 0, TAU); g.fill();
}

// --- landmarks (top-down architectural plans)

function paintLandmark(g, plan, lm, P, detail) {
  const st = plan.style, d = plan.d, s = lm.size;
  const px = 1 / P, lw = (v) => Math.max(px, v);
  const mat = MATERIAL[st.wall] || MATERIAL.stone;
  g.save();
  g.translate(lm.x, lm.y); g.rotate(lm.rot || 0);
  const shadow = (fn) => { g.save(); g.translate(d * 0.1, d * 0.13); g.fillStyle = 'rgba(30,24,16,0.28)'; g.beginPath(); fn(); g.fill(); g.restore(); };
  const ink = css(INK, 0.8);
  switch (lm.key) {
    case 'palace': {
      const W2 = s, H2 = s * 0.72;
      shadow(() => g.rect(-W2, -H2, W2 * 2, H2 * 2));
      g.fillStyle = css(lighten(st.palette, 0.08)); g.fillRect(-W2, -H2, W2 * 2, H2 * 2);
      g.fillStyle = css(mat.ground); g.fillRect(-W2 * 0.55, -H2 * 0.5, W2 * 1.1, H2 * 1.0);
      if (detail >= 1) {
        // parterre garden in the court
        g.fillStyle = 'rgba(96,136,78,0.9)'; g.fillRect(-W2 * 0.45, -H2 * 0.4, W2 * 0.9, H2 * 0.8);
        g.strokeStyle = 'rgba(232,224,196,0.8)'; g.lineWidth = lw(d * 0.03);
        g.beginPath(); g.moveTo(-W2 * 0.45, 0); g.lineTo(W2 * 0.45, 0); g.moveTo(0, -H2 * 0.4); g.lineTo(0, H2 * 0.4); g.stroke();
        g.beginPath(); g.arc(0, 0, H2 * 0.18, 0, TAU); g.stroke();
      }
      g.strokeStyle = ink; g.lineWidth = lw(d * 0.04); g.strokeRect(-W2, -H2, W2 * 2, H2 * 2); g.strokeRect(-W2 * 0.55, -H2 * 0.5, W2 * 1.1, H2);
      // corner pavilions with gilded roofs
      g.fillStyle = css([214, 172, 92]);
      for (const [cx, cy] of [[-W2, -H2], [W2, -H2], [W2, H2], [-W2, H2]]) { g.beginPath(); g.rect(cx - s * 0.16, cy - s * 0.16, s * 0.32, s * 0.32); g.fill(); g.stroke(); }
      break;
    }
    case 'temple': paintTemple(g, plan, lm, P, detail); break;
    case 'bazaar': {
      shadow(() => g.rect(-s, -s * 0.5, s * 2, s));
      g.fillStyle = css(mat.flat); g.fillRect(-s, -s * 0.5, s * 2, s);
      g.strokeStyle = ink; g.lineWidth = lw(d * 0.035); g.strokeRect(-s, -s * 0.5, s * 2, s);
      g.fillStyle = css(lighten(st.palette, 0.25));
      for (let q = 0; q < 5; q++) { g.beginPath(); g.arc(-s * 0.8 + q * s * 0.4, 0, s * 0.15, 0, TAU); g.fill(); g.stroke(); }
      break;
    }
    case 'library': case 'university': case 'bank': case 'hospital': case 'workshop': case 'granary': case 'barracks': case 'station': {
      paintCivic(g, plan, lm, P, detail);
      break;
    }
    case 'theatre': {
      shadow(() => g.ellipse(0, 0, s, s * 0.75, 0, 0, TAU));
      g.fillStyle = css(lm.level >= 2 ? lighten(mat.face, 0.1) : [206, 196, 176]);
      g.beginPath(); g.ellipse(0, 0, s, s * 0.75, 0, 0, TAU); g.fill();
      g.strokeStyle = ink; g.lineWidth = lw(d * 0.035); g.stroke();
      g.fillStyle = css([176, 150, 110]); g.beginPath(); g.ellipse(0, 0, s * 0.45, s * 0.3, 0, 0, TAU); g.fill(); g.stroke();
      if (detail >= 1) {
        g.strokeStyle = 'rgba(80,64,48,0.45)'; g.lineWidth = lw(d * 0.015);
        for (let q = 1; q <= 3; q++) { g.beginPath(); g.ellipse(0, 0, s * (0.45 + q * 0.14), s * (0.3 + q * 0.11), 0, 0, TAU); g.stroke(); }
      }
      break;
    }
    case 'wonder': paintWonderPlan(g, plan, lm, P, detail); break;
    case 'magetower': {
      // a round tower of study: its ring wall, the slate cone, a star at the crown
      shadow(() => g.arc(0, 0, s * 0.62, 0, TAU));
      g.fillStyle = css(lighten(mat.face, 0.05)); g.beginPath(); g.arc(0, 0, s * 0.62, 0, TAU); g.fill();
      g.strokeStyle = ink; g.lineWidth = lw(d * 0.035); g.stroke();
      g.fillStyle = css([92, 78, 138]); g.beginPath(); g.arc(0, 0, s * 0.42, 0, TAU); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(200,190,240,0.55)'; g.lineWidth = lw(d * 0.02);
      g.beginPath(); for (let q = 0; q < 8; q++) { const a = (q / 8) * TAU; g.moveTo(Math.cos(a) * s * 0.12, Math.sin(a) * s * 0.12); g.lineTo(Math.cos(a) * s * 0.4, Math.sin(a) * s * 0.4); } g.stroke();
      g.fillStyle = css([240, 214, 120]); g.beginPath();
      for (let q = 0; q < 10; q++) { const a = -Math.PI / 2 + (q * Math.PI) / 5, rr = q & 1 ? s * 0.07 : s * 0.17; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      g.closePath(); g.fill();
      break;
    }
    case 'project': {
      // scaffolding over the rising work, filled as it nears completion
      const p = plan.project ? plan.project.p : 0.3;
      g.fillStyle = css([210, 196, 168]); g.fillRect(-s, -s * 0.7, s * 2, s * 1.4);
      g.fillStyle = css(darken(st.palette, 0.1), 0.85); g.fillRect(-s, -s * 0.7, s * 2 * p, s * 1.4);
      g.strokeStyle = 'rgba(110,80,50,0.9)'; g.lineWidth = lw(d * 0.025);
      g.strokeRect(-s, -s * 0.7, s * 2, s * 1.4);
      g.beginPath();
      for (let q = -3; q <= 3; q++) { g.moveTo(q * s / 3, -s * 0.7); g.lineTo(q * s / 3, s * 0.7); }
      g.moveTo(-s, -s * 0.7); g.lineTo(s, s * 0.7); g.moveTo(-s, s * 0.7); g.lineTo(s, -s * 0.7);
      g.stroke();
      // crane
      g.strokeStyle = 'rgba(176,120,40,0.95)'; g.lineWidth = lw(d * 0.04);
      g.beginPath(); g.moveTo(s * 0.6, s * 0.5); g.lineTo(s * 0.6 - s * 1.3, s * 0.5 - s * 0.9); g.stroke();
      break;
    }
    default: break;
  }
  g.restore();
}

function paintTemple(g, plan, lm, P, detail) {
  const st = plan.style, d = plan.d, s = lm.size;
  const px = 1 / P, lw = (v) => Math.max(px, v);
  const mat = MATERIAL[st.wall] || MATERIAL.stone;
  const roof = plan.religion ? mix3(plan.religion, [200, 180, 140], 0.25) : lighten(st.palette, 0.1);
  const ink = css(INK, 0.85);
  g.fillStyle = 'rgba(30,24,16,0.28)';
  g.save(); g.translate(d * 0.1, d * 0.13); g.beginPath(); g.rect(-s, -s * 0.8, s * 2, s * 1.6); g.fill(); g.restore();
  g.lineWidth = lw(d * 0.035); g.strokeStyle = ink;
  const form = lm.level <= 1 ? 'shrine' : st.temple;
  switch (form) {
    case 'shrine': {
      g.fillStyle = css(mat.face); g.fillRect(-s * 0.7, -s * 0.7, s * 1.4, s * 1.4); g.strokeRect(-s * 0.7, -s * 0.7, s * 1.4, s * 1.4);
      g.fillStyle = css(roof); g.beginPath(); g.arc(0, 0, s * 0.45, 0, TAU); g.fill(); g.stroke();
      break;
    }
    case 'basilica': {
      // a cross: nave, transepts, apse; a dome or tower at the crossing
      g.fillStyle = css(roof);
      g.beginPath(); g.rect(-s, -s * 0.28, s * 2, s * 0.56); g.rect(s * 0.15, -s * 0.75, s * 0.45, s * 1.5); g.fill(); g.stroke();
      g.beginPath(); g.arc(s, 0, s * 0.28, -Math.PI / 2, Math.PI / 2); g.fill(); g.stroke();
      g.strokeStyle = css(lighten(roof, 0.3), 0.7); g.lineWidth = lw(d * 0.02);
      g.beginPath(); g.moveTo(-s, 0); g.lineTo(s, 0); g.moveTo(s * 0.375, -s * 0.75); g.lineTo(s * 0.375, s * 0.75); g.stroke();
      g.strokeStyle = ink; g.lineWidth = lw(d * 0.03);
      g.fillStyle = css(lm.level >= 3 ? [214, 172, 92] : lighten(roof, 0.2)); g.beginPath(); g.arc(s * 0.375, 0, s * 0.24, 0, TAU); g.fill(); g.stroke();
      if (lm.level >= 3) { g.fillStyle = css(mat.face); g.fillRect(-s * 1.12, -s * 0.36, s * 0.3, s * 0.3); g.fillRect(-s * 1.12, s * 0.06, s * 0.3, s * 0.3); g.strokeRect(-s * 1.12, -s * 0.36, s * 0.3, s * 0.3); g.strokeRect(-s * 1.12, s * 0.06, s * 0.3, s * 0.3); }
      break;
    }
    case 'onion': {
      g.fillStyle = css(mat.face); g.fillRect(-s * 0.8, -s * 0.8, s * 1.6, s * 1.6); g.strokeRect(-s * 0.8, -s * 0.8, s * 1.6, s * 1.6);
      g.fillStyle = css(roof);
      for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) { g.beginPath(); g.arc(x * s, y * s, s * 0.2, 0, TAU); g.fill(); g.stroke(); }
      g.beginPath(); g.arc(0, 0, s * 0.42, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = css([214, 172, 92]); g.beginPath(); g.arc(0, 0, s * 0.1, 0, TAU); g.fill();
      break;
    }
    case 'stupa': {
      g.fillStyle = css(mat.ground); g.fillRect(-s * 0.9, -s * 0.9, s * 1.8, s * 1.8); g.strokeRect(-s * 0.9, -s * 0.9, s * 1.8, s * 1.8);
      g.fillStyle = css(lighten(mat.face, 0.15)); g.beginPath(); g.arc(0, 0, s * 0.7, 0, TAU); g.fill(); g.stroke();
      g.strokeStyle = css(roof, 0.9); g.lineWidth = lw(d * 0.04);
      g.beginPath(); g.arc(0, 0, s * 0.45, 0, TAU); g.stroke();
      g.fillStyle = css([214, 172, 92]); g.strokeStyle = ink; g.lineWidth = lw(d * 0.03); g.beginPath(); g.arc(0, 0, s * 0.16, 0, TAU); g.fill(); g.stroke();
      break;
    }
    case 'ziggurat': case 'pyramid': {
      const n = form === 'ziggurat' ? 4 : 5;
      for (let q = 0; q < n; q++) {
        const k = 1 - q / n;
        g.fillStyle = css(q === n - 1 ? roof : lighten(mat.face, q * 0.06));
        g.fillRect(-s * k, -s * k, s * 2 * k, s * 2 * k); g.strokeRect(-s * k, -s * k, s * 2 * k, s * 2 * k);
      }
      if (form === 'ziggurat') { g.strokeStyle = 'rgba(60,44,30,0.6)'; g.lineWidth = lw(d * 0.04); g.beginPath(); g.moveTo(0, s); g.lineTo(0, -s * 0.2); g.stroke(); }
      break;
    }
    default: {
      g.fillStyle = css(roof); g.fillRect(-s * 0.8, -s * 0.5, s * 1.6, s); g.strokeRect(-s * 0.8, -s * 0.5, s * 1.6, s);
    }
  }
}

function paintCivic(g, plan, lm, P, detail) {
  const st = plan.style, d = plan.d, s = lm.size;
  const px = 1 / P, lw = (v) => Math.max(px, v);
  const mat = MATERIAL[st.wall] || MATERIAL.stone;
  const ink = css(INK, 0.8);
  const roof = st.roof === 'flat' || st.roof === 'dome' ? mat.flat : darken(st.palette, 0.05);
  g.fillStyle = 'rgba(30,24,16,0.28)'; g.save(); g.translate(d * 0.1, d * 0.13); g.fillRect(-s, -s * 0.7, s * 2, s * 1.4); g.restore();
  g.lineWidth = lw(d * 0.035); g.strokeStyle = ink;
  switch (lm.key) {
    case 'library': case 'university': {
      // wings round a green court; the great library under a dome
      g.fillStyle = css(roof); g.fillRect(-s, -s * 0.7, s * 2, s * 1.4); g.strokeRect(-s, -s * 0.7, s * 2, s * 1.4);
      g.fillStyle = 'rgba(102,140,84,0.95)'; g.fillRect(-s * 0.62, -s * 0.36, s * 1.24, s * 0.72);
      if (detail >= 1) { g.fillStyle = 'rgba(232,224,196,0.9)'; for (let q = -2; q <= 2; q++) { g.beginPath(); g.arc(q * s * 0.26, -s * 0.36, d * 0.03, 0, TAU); g.arc(q * s * 0.26, s * 0.36, d * 0.03, 0, TAU); g.fill(); } }
      if (lm.key === 'library' && lm.level >= 2) { g.fillStyle = css([170, 186, 176]); g.beginPath(); g.arc(0, 0, s * 0.3, 0, TAU); g.fill(); g.stroke(); }
      break;
    }
    case 'bank': {
      g.fillStyle = css(lighten(mat.face, 0.1)); g.fillRect(-s, -s * 0.7, s * 2, s * 1.4); g.strokeRect(-s, -s * 0.7, s * 2, s * 1.4);
      g.fillStyle = css([186, 196, 188]); g.beginPath(); g.arc(0, 0, s * 0.42, 0, TAU); g.fill(); g.stroke();
      if (detail >= 1) { g.fillStyle = 'rgba(240,234,220,0.9)'; for (let q = -3; q <= 3; q++) { g.beginPath(); g.arc(q * s * 0.26, s * 0.62, d * 0.03, 0, TAU); g.fill(); } }
      break;
    }
    case 'hospital': {
      g.fillStyle = css([236, 232, 222]);
      g.beginPath(); g.rect(-s, -s * 0.25, s * 2, s * 0.5); g.rect(-s * 0.25, -s * 0.8, s * 0.5, s * 1.6); g.fill(); g.stroke();
      if (detail >= 1) { g.strokeStyle = 'rgba(176,48,40,0.9)'; g.lineWidth = lw(d * 0.06); g.beginPath(); g.moveTo(-s * 0.18, 0); g.lineTo(s * 0.18, 0); g.moveTo(0, -s * 0.18); g.lineTo(0, s * 0.18); g.stroke(); }
      break;
    }
    case 'workshop': {
      g.fillStyle = css(darken(roof, 0.08)); g.fillRect(-s, -s * 0.55, s * 2, s * 1.1); g.strokeRect(-s, -s * 0.55, s * 2, s * 1.1);
      g.fillStyle = css(mat.ground); g.fillRect(-s * 0.2, -s * 0.3, s * 0.9, s * 0.6);
      g.strokeStyle = css(lighten(roof, 0.25), 0.7); g.beginPath(); g.moveTo(-s, 0); g.lineTo(-s * 0.2, 0); g.stroke();
      break;
    }
    case 'granary': {
      const n = lm.level >= 2 ? 3 : 2;
      for (let q = 0; q < n; q++) {
        const y = (q - (n - 1) / 2) * s * 0.55;
        g.fillStyle = css([190, 170, 130]); g.fillRect(-s, y - s * 0.2, s * 2, s * 0.4); g.strokeRect(-s, y - s * 0.2, s * 2, s * 0.4);
        g.strokeStyle = 'rgba(250,240,210,0.6)'; g.beginPath(); g.moveTo(-s, y); g.lineTo(s, y); g.stroke(); g.strokeStyle = ink;
      }
      break;
    }
    case 'barracks': {
      g.fillStyle = css([186, 166, 128]); g.fillRect(-s, -s * 0.75, s * 2, s * 1.5); g.strokeRect(-s, -s * 0.75, s * 2, s * 1.5);
      g.fillStyle = css(roof); g.fillRect(-s, -s * 0.75, s * 2, s * 0.35); g.fillRect(-s, s * 0.4, s * 2, s * 0.35);
      g.strokeRect(-s, -s * 0.75, s * 2, s * 0.35); g.strokeRect(-s, s * 0.4, s * 2, s * 0.35);
      if (detail >= 1) {
        g.fillStyle = css(plan.civRgb);
        for (let q = -3; q <= 3; q++) for (let r2 = -1; r2 <= 1; r2++) { g.beginPath(); g.arc(q * s * 0.2, r2 * s * 0.12, d * 0.022, 0, TAU); g.fill(); }
      }
      break;
    }
    case 'station': {
      g.fillStyle = css([170, 184, 192]); g.fillRect(-s, -s * 0.4, s * 2, s * 0.8); g.strokeRect(-s, -s * 0.4, s * 2, s * 0.8);
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = lw(d * 0.015);
      g.beginPath(); for (let q = -4; q <= 4; q++) { g.moveTo(q * s / 4.5, -s * 0.4); g.lineTo(q * s / 4.5, s * 0.4); } g.stroke();
      g.fillStyle = css(darken(roof, 0.1)); g.strokeStyle = ink; g.lineWidth = lw(d * 0.035);
      g.fillRect(-s * 0.4, s * 0.4, s * 0.8, s * 0.35); g.strokeRect(-s * 0.4, s * 0.4, s * 0.8, s * 0.35);
      break;
    }
  }
}

// --- wonders drawn into a plan (Town zoom and closer)

export function paintWonderPlan(g, plan, lm, P, detail) {
  const d = plan.d, s = lm.size;
  const px = 1 / P, lw = (v) => Math.max(px, v);
  const ink = css(INK, 0.85), gold = [222, 180, 84], stone = [214, 202, 176];
  g.lineWidth = lw(d * 0.04); g.strokeStyle = ink;
  const sh = () => { g.fillStyle = 'rgba(30,24,16,0.3)'; };
  if (lm.ruined) {
    g.fillStyle = css([170, 158, 136]);
    let hh = (lm.id ?? 1) * 7919 + 3;
    for (let q = 0; q < 14; q++) { hh = Math.imul(hh ^ (hh >>> 13), 0x5bd1e995) >>> 0; const x = (hf(hh, 0) - 0.5) * s * 1.8, y = (hf(hh, 8) - 0.5) * s * 1.4, rr = s * (0.08 + hf(hh, 16) * 0.12); g.beginPath(); g.rect(x - rr, y - rr * 0.7, rr * 2, rr * 1.4); g.fill(); g.stroke(); }
    return;
  }
  switch (lm.kind) {
    case 'pyramid': {
      sh(); g.beginPath(); g.moveTo(-s, -s); g.lineTo(s + s * 0.9, s * 1.2); g.lineTo(-s, s); g.closePath(); g.fill();
      for (const [k, c] of [[0, lighten(stone, 0.12)], [1, darken(stone, 0.12)], [2, darken(stone, 0.25)], [3, stone]]) {
        g.fillStyle = css(c); g.beginPath(); g.moveTo(0, 0);
        const A = [[-s, -s], [s, -s], [s, s], [-s, s]];
        g.lineTo(...A[k]); g.lineTo(...A[(k + 1) % 4]); g.closePath(); g.fill(); g.stroke();
      }
      break;
    }
    case 'ziggurat': case 'stone_circle': {
      if (lm.kind === 'stone_circle') {
        g.fillStyle = css([170, 168, 160]);
        for (let q = 0; q < 14; q++) { const a = (q / 14) * TAU; g.beginPath(); g.rect(Math.cos(a) * s * 0.8 - s * 0.07, Math.sin(a) * s * 0.8 - s * 0.05, s * 0.14, s * 0.1); g.fill(); g.stroke(); }
        g.beginPath(); g.rect(-s * 0.1, -s * 0.06, s * 0.2, s * 0.12); g.fill(); g.stroke();
        break;
      }
      for (let q = 0; q < 5; q++) { const k = 1 - q * 0.18; g.fillStyle = css(lighten([196, 160, 112], q * 0.05)); g.fillRect(-s * k, -s * k * 0.8, s * 2 * k, s * 1.6 * k); g.strokeRect(-s * k, -s * k * 0.8, s * 2 * k, s * 1.6 * k); }
      g.strokeStyle = 'rgba(70,50,30,0.7)'; g.beginPath(); g.moveTo(0, s * 0.8); g.lineTo(0, -s * 0.2); g.stroke();
      break;
    }
    case 'colossus': case 'lighthouse': {
      g.fillStyle = css(stone); g.beginPath(); g.arc(0, 0, s * 0.6, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = css(lm.kind === 'colossus' ? [176, 128, 72] : [236, 230, 214]); g.beginPath(); g.arc(0, 0, s * 0.35, 0, TAU); g.fill(); g.stroke();
      if (lm.kind === 'lighthouse') { g.fillStyle = css([255, 214, 120]); g.beginPath(); g.arc(0, 0, s * 0.14, 0, TAU); g.fill(); }
      break;
    }
    case 'gardens': {
      for (let q = 0; q < 4; q++) { const k = 1 - q * 0.2; g.fillStyle = css(q % 2 ? [92, 140, 78] : [118, 160, 92]); g.fillRect(-s * k, -s * k, s * 2 * k, s * 2 * k); g.strokeRect(-s * k, -s * k, s * 2 * k, s * 2 * k); }
      g.fillStyle = css([110, 160, 200]); g.beginPath(); g.arc(0, 0, s * 0.15, 0, TAU); g.fill();
      break;
    }
    case 'colosseum': {
      g.fillStyle = css(stone); g.beginPath(); g.ellipse(0, 0, s, s * 0.8, 0, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = css([196, 168, 120]); g.beginPath(); g.ellipse(0, 0, s * 0.5, s * 0.35, 0, 0, TAU); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(80,64,48,0.5)'; for (let q = 1; q <= 3; q++) { g.beginPath(); g.ellipse(0, 0, s * (0.5 + q * 0.12), s * (0.35 + q * 0.11), 0, 0, TAU); g.stroke(); }
      break;
    }
    case 'iron_tower': case 'skyspire': {
      g.fillStyle = 'rgba(30,24,16,0.35)'; g.beginPath(); g.moveTo(-s * 0.4, 0); g.lineTo(s * 2.4, s * 1.3); g.lineTo(s * 0.4, 0); g.fill();
      g.fillStyle = css(lm.kind === 'skyspire' ? [176, 196, 210] : [124, 104, 88]);
      g.beginPath(); g.moveTo(-s * 0.6, -s * 0.6); g.lineTo(s * 0.6, -s * 0.6); g.lineTo(s * 0.6, s * 0.6); g.lineTo(-s * 0.6, s * 0.6); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(-s * 0.6, -s * 0.6); g.lineTo(s * 0.6, s * 0.6); g.moveTo(s * 0.6, -s * 0.6); g.lineTo(-s * 0.6, s * 0.6); g.stroke();
      g.fillStyle = css(gold); g.beginPath(); g.arc(0, 0, s * 0.14, 0, TAU); g.fill(); g.stroke();
      break;
    }
    default: {
      // the great halls: library, cathedral, citadel, observatory, palace, opera, exchange,
      // crystal palace, archive, seed vault — a grand court under a gilded dome
      g.fillStyle = 'rgba(30,24,16,0.3)'; g.fillRect(-s + d * 0.12, -s * 0.75 + d * 0.15, s * 2, s * 1.5);
      const body = lm.kind === 'crystal_palace' ? [196, 220, 228] : lm.kind === 'citadel' ? [176, 168, 154] : lighten(stone, 0.06);
      g.fillStyle = css(body); g.fillRect(-s, -s * 0.75, s * 2, s * 1.5); g.strokeRect(-s, -s * 0.75, s * 2, s * 1.5);
      if (lm.kind === 'citadel') { for (const [cx, cy] of [[-s, -s * 0.75], [s, -s * 0.75], [s, s * 0.75], [-s, s * 0.75]]) { g.beginPath(); g.arc(cx, cy, s * 0.22, 0, TAU); g.fill(); g.stroke(); } }
      g.fillStyle = 'rgba(102,140,84,0.9)'; g.fillRect(-s * 0.6, -s * 0.38, s * 0.5, s * 0.76); g.fillRect(s * 0.1, -s * 0.38, s * 0.5, s * 0.76);
      g.fillStyle = css(gold); g.beginPath(); g.arc(0, 0, s * 0.3, 0, TAU); g.fill(); g.stroke();
    }
  }
}

/**
 * The wall's course: runs of points between gates, breaches and open stretches (over water,
 * across a river, into a dwarven hold's rock), with the tests that cut them. Shared by the
 * ordinary walls and the races' own (raceplan.js).
 */
export function wallGeometry(plan) {
  const wl = plan.walls;
  const R = wl.r, wob = plan.wob;
  const N = WALL_N;
  const isOpen = (a) => { const q = Math.round((((a % TAU) + TAU) % TAU) / TAU * N); return wl.open ? wl.open[Math.min(N, q)] === 1 : false; };
  const gateHW = (plan.wA * 0.9) / R;
  const isGate = (a) => wl.gates.some((ga) => Math.abs(angDiff(a, ga)) < gateHW);
  const isBreach = (a) => wl.breaches.some((ba) => Math.abs(angDiff(a, ba)) < 0.12);
  const pt = (a, rr = R) => {
    const k = wl.level >= 4 ? starK(a) : 1;
    return [Math.cos(a) * rr * wob(a) * k, Math.sin(a) * rr * wob(a) * k];
  };
  const runs = [];
  let cur = null;
  for (let q = 0; q <= N; q++) {
    const a = (q / N) * TAU;
    const open = isGate(a) || isBreach(a) || isOpen(a);
    if (open) { if (cur && cur.length > 2) runs.push(cur); cur = null; continue; }
    if (!cur) cur = [];
    cur.push(...pt(a));
  }
  if (cur && cur.length > 2) runs.push(cur);
  return { wl, R, N, runs, pt, isOpen, isGate, isBreach };
}

function paintWalls(g, plan, P, detail) {
  const wl = plan.walls, d = plan.d, px = 1 / P;
  const st = plan.style;
  const { R, N, runs, pt, isOpen, isGate, isBreach } = wallGeometry(plan);
  const col = plan.ruin ? [156, 148, 132] : wl.level === 1 ? [126, 96, 64] : st.wall === 'mudbrick' ? [190, 158, 112] : st.wall === 'brick' ? [168, 104, 82] : [170, 164, 152];
  const width = wl.level === 1 ? d * 0.08 : wl.level === 2 ? d * 0.14 : d * 0.18;
  g.lineCap = 'butt'; g.lineJoin = 'round';
  g.strokeStyle = 'rgba(30,24,16,0.35)'; g.lineWidth = width * 1.6;
  g.beginPath(); for (const rn of runs) { g.moveTo(rn[0] + d * 0.06, rn[1] + d * 0.08); for (let k = 2; k < rn.length; k += 2) g.lineTo(rn[k] + d * 0.06, rn[k + 1] + d * 0.08); } g.stroke();
  g.strokeStyle = css(darken(col, 0.4)); g.lineWidth = width * 1.35;
  g.beginPath(); for (const rn of runs) { g.moveTo(rn[0], rn[1]); for (let k = 2; k < rn.length; k += 2) g.lineTo(rn[k], rn[k + 1]); } g.stroke();
  g.strokeStyle = css(col); g.lineWidth = width;
  g.stroke();
  if (wl.level === 1 && detail >= 1) {
    // palisade stakes
    g.setLineDash([d * 0.03, d * 0.03]); g.strokeStyle = css(darken(col, 0.3)); g.lineWidth = width * 0.5; g.stroke(); g.setLineDash([]);
  } else if (wl.level >= 2 && detail >= 1) {
    // crenellations
    g.setLineDash([d * 0.05, d * 0.05]); g.strokeStyle = css(lighten(col, 0.3), 0.8); g.lineWidth = width * 0.35; g.stroke(); g.setLineDash([]);
  }
  // towers and gatehouses
  if (wl.level >= 2) {
    const nT = Math.max(6, Math.round((TAU * R) / (d * 1.4)));
    g.fillStyle = css(col); g.strokeStyle = css(INK, 0.8); g.lineWidth = Math.max(px, d * 0.03);
    for (let q = 0; q < nT; q++) {
      const a = (q / nT) * TAU + 0.11;
      if (isGate(a) || isBreach(a) || isOpen(a)) continue;
      const [x, y] = pt(a);
      g.beginPath();
      if (wl.level >= 4) { const k = ((a / TAU) * 7) % 1; if (Math.abs(k - 0.5) > 0.12) continue; g.moveTo(x, y); }
      g.arc(x, y, width * (wl.level >= 3 ? 1.15 : 0.95), 0, TAU); g.fill(); g.stroke();
    }
  }
  for (const ga of wl.gates) {
    if (isOpen(ga)) continue;
    const [x, y] = pt(ga);
    g.save(); g.translate(x, y); g.rotate(ga);
    g.fillStyle = css(darken(col, 0.1)); g.strokeStyle = css(INK, 0.85); g.lineWidth = Math.max(px, d * 0.03);
    const gw = plan.wA * 0.9;
    g.fillRect(-width, -gw - width * 0.9, width * 2, width * 1.6); g.strokeRect(-width, -gw - width * 0.9, width * 2, width * 1.6);
    g.fillRect(-width, gw - width * 0.7, width * 2, width * 1.6); g.strokeRect(-width, gw - width * 0.7, width * 2, width * 1.6);
    g.restore();
  }
  // breaches: rubble spilling outward
  for (const ba of wl.breaches) {
    const [x, y] = pt(ba, R * 1.03);
    g.fillStyle = css([150, 138, 120]);
    for (let q = 0; q < 6; q++) { const aa = ba + (q - 2.5) * 0.04, rr = R * (1.02 + (q % 3) * 0.03); g.beginPath(); g.arc(Math.cos(aa) * rr, Math.sin(aa) * rr, width * 0.5, 0, TAU); g.fill(); }
  }
  // castle: a keep at the heart
  if (wl.level === 3) {
    const k = plan.rCore * 0.9;
    const a = 0.8, x = Math.cos(a) * (plan.rCore + d * 0.7), y = Math.sin(a) * (plan.rCore + d * 0.7);
    g.fillStyle = css(col); g.strokeStyle = css(INK, 0.85); g.lineWidth = Math.max(px, d * 0.035);
    g.fillRect(x - k * 0.45, y - k * 0.45, k * 0.9, k * 0.9); g.strokeRect(x - k * 0.45, y - k * 0.45, k * 0.9, k * 0.9);
    for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { g.beginPath(); g.arc(x + cx * k * 0.45, y + cy * k * 0.45, k * 0.14, 0, TAU); g.fill(); g.stroke(); }
  }
  g.lineCap = 'round';
}

function paintHarbour(g, plan, P, detail) {
  const d = plan.d, px = 1 / P;
  const pw = d * (plan.harborLevel >= 2 ? 0.16 : 0.12);
  g.lineCap = 'butt';
  g.strokeStyle = 'rgba(30,24,16,0.4)'; g.lineWidth = pw * 1.5;
  g.beginPath(); for (let k = 0; k < plan.piers.length; k += 4) { g.moveTo(plan.piers[k], plan.piers[k + 1]); g.lineTo(plan.piers[k + 2], plan.piers[k + 3]); } g.stroke();
  g.strokeStyle = plan.harborLevel >= 2 ? css([176, 168, 152]) : css([134, 100, 66]); g.lineWidth = pw;
  g.stroke();
  if (detail >= 1) { g.strokeStyle = 'rgba(255,240,210,0.35)'; g.lineWidth = pw * 0.3; g.stroke(); }
  // ships at their moorings
  for (let k = 0; k < plan.ships.length; k += 4) {
    const x = plan.ships[k], y = plan.ships[k + 1], a = plan.ships[k + 2], v = plan.ships[k + 3];
    paintHull(g, x, y, a, d * (0.36 + v * 0.16), plan.era, plan.civRgb, detail, px);
  }
  g.lineCap = 'round';
}

/** A ship seen from above: hull, deck and (by age) sails, oars or funnels. */
export function paintHull(g, x, y, a, L, era, rgb, detail, px = 0.01) {
  g.save(); g.translate(x, y); g.rotate(a);
  const Wd = L * 0.32;
  g.fillStyle = 'rgba(20,30,40,0.25)'; g.beginPath(); g.ellipse(L * 0.06, L * 0.08, L * 0.55, Wd * 0.62, 0, 0, TAU); g.fill();
  g.fillStyle = era >= 6 ? '#5a5a5e' : '#7a5634'; g.strokeStyle = 'rgba(30,22,16,0.9)'; g.lineWidth = Math.max(px, L * 0.04);
  g.beginPath(); g.moveTo(L * 0.55, 0); g.quadraticCurveTo(L * 0.2, -Wd, -L * 0.45, -Wd * 0.75); g.lineTo(-L * 0.45, Wd * 0.75); g.quadraticCurveTo(L * 0.2, Wd, L * 0.55, 0); g.closePath(); g.fill(); g.stroke();
  if (detail >= 1) {
    if (era >= 6) { g.fillStyle = css(rgb || [180, 60, 40]); g.beginPath(); g.arc(-L * 0.05, 0, Wd * 0.35, 0, TAU); g.fill(); }
    else {
      g.fillStyle = '#f2ead6'; g.fillRect(-L * 0.08, -Wd * 0.95, L * 0.12, Wd * 1.9);
      if (era >= 4) g.fillRect(L * 0.18, -Wd * 0.75, L * 0.1, Wd * 1.5);
      if (rgb) { g.fillStyle = css(rgb); g.fillRect(-L * 0.42, -Wd * 0.25, L * 0.1, Wd * 0.5); }
    }
  }
  g.restore();
}

function paintExtra(g, plan, e, P, detail) {
  const d = plan.d, px = 1 / P, lw = (v) => Math.max(px, v);
  const ink = css(INK, 0.85);
  switch (e.key) {
    case 'aqueduct': {
      const ca = Math.cos(e.a), sa = Math.sin(e.a);
      g.strokeStyle = css([196, 186, 166]); g.lineWidth = d * 0.12; g.lineCap = 'butt';
      g.beginPath(); g.moveTo(ca * e.r0, sa * e.r0); g.lineTo(ca * e.len, sa * e.len); g.stroke();
      if (detail >= 1) {
        g.strokeStyle = 'rgba(70,56,40,0.6)'; g.lineWidth = lw(d * 0.025);
        g.beginPath();
        for (let t = e.r0; t < e.len; t += d * 0.22) { const x = ca * t, y = sa * t; g.moveTo(x - sa * d * 0.06, y + ca * d * 0.06); g.lineTo(x + sa * d * 0.06, y - ca * d * 0.06); }
        g.stroke();
      }
      g.lineCap = 'round';
      break;
    }
    case 'mine': {
      g.fillStyle = 'rgba(70,64,58,0.8)';
      g.beginPath(); g.arc(e.x + e.size * 0.5, e.y + e.size * 0.3, e.size * 0.7, 0, TAU); g.arc(e.x - e.size * 0.2, e.y + e.size * 0.55, e.size * 0.45, 0, TAU); g.fill();
      g.strokeStyle = ink; g.lineWidth = lw(d * 0.035);
      g.beginPath(); g.moveTo(e.x - e.size * 0.4, e.y + e.size * 0.3); g.lineTo(e.x, e.y - e.size * 0.5); g.lineTo(e.x + e.size * 0.4, e.y + e.size * 0.3); g.moveTo(e.x - e.size * 0.3, e.y); g.lineTo(e.x + e.size * 0.3, e.y); g.stroke();
      g.fillStyle = css([150, 120, 90]); g.fillRect(e.x - e.size * 0.9, e.y - e.size * 0.2, e.size * 0.45, e.size * 0.4); g.strokeRect(e.x - e.size * 0.9, e.y - e.size * 0.2, e.size * 0.45, e.size * 0.4);
      break;
    }
    case 'observatory': {
      g.fillStyle = css([210, 202, 186]); g.beginPath(); g.arc(e.x, e.y, e.size, 0, TAU); g.fill();
      g.strokeStyle = ink; g.lineWidth = lw(d * 0.03); g.stroke();
      g.fillStyle = css([150, 168, 176]); g.beginPath(); g.arc(e.x, e.y, e.size * 0.6, 0, TAU); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(40,40,50,0.9)'; g.beginPath(); g.moveTo(e.x - e.size * 0.1, e.y - e.size * 0.55); g.lineTo(e.x - e.size * 0.1, e.y + e.size * 0.1); g.stroke();
      break;
    }
    case 'power': {
      const n = e.level >= 2 ? 0 : 2;
      g.fillStyle = css([150, 146, 140]); g.fillRect(e.x - e.size * 0.6, e.y - e.size * 0.3, e.size * 1.2, e.size * 0.6);
      g.strokeStyle = ink; g.lineWidth = lw(d * 0.03); g.strokeRect(e.x - e.size * 0.6, e.y - e.size * 0.3, e.size * 1.2, e.size * 0.6);
      for (let q = 0; q < n; q++) {
        const cx = e.x + (q - 0.5) * e.size * 1.1, cy = e.y + e.size * 0.75;
        g.fillStyle = css([196, 192, 186]); g.beginPath(); g.arc(cx, cy, e.size * 0.42, 0, TAU); g.fill(); g.stroke();
        g.fillStyle = css([90, 90, 92]); g.beginPath(); g.arc(cx, cy, e.size * 0.26, 0, TAU); g.fill();
      }
      if (n === 0) { g.fillStyle = css([60, 80, 120]); for (let q = 0; q < 6; q++) g.fillRect(e.x - e.size * 0.6 + q * e.size * 0.22, e.y + e.size * 0.45, e.size * 0.16, e.size * 0.4); }
      break;
    }
    case 'airport': {
      g.save(); g.translate(e.x, e.y); g.rotate(e.a);
      const L = e.len, Wd = d * 0.32;
      g.fillStyle = css([96, 98, 102]); g.fillRect(-L / 2, -Wd / 2, L, Wd);
      g.strokeStyle = 'rgba(240,240,240,0.85)'; g.lineWidth = lw(d * 0.03);
      g.setLineDash([L * 0.04, L * 0.03]); g.beginPath(); g.moveTo(-L * 0.45, 0); g.lineTo(L * 0.45, 0); g.stroke(); g.setLineDash([]);
      g.fillStyle = css([190, 192, 196]); g.fillRect(-L * 0.2, Wd * 0.8, L * 0.4, Wd * 0.8);
      g.strokeStyle = ink; g.strokeRect(-L * 0.2, Wd * 0.8, L * 0.4, Wd * 0.8);
      g.restore();
      break;
    }
    case 'rail': {
      g.strokeStyle = 'rgba(70,60,52,0.9)'; g.lineWidth = lw(d * 0.05);
      g.beginPath();
      for (const pts of e.lines) { g.moveTo(pts[0], pts[1]); for (let k = 2; k < pts.length; k += 2) g.lineTo(pts[k], pts[k + 1]); }
      g.stroke();
      if (detail >= 1) { g.setLineDash([d * 0.03, d * 0.07]); g.strokeStyle = 'rgba(70,60,52,0.8)'; g.lineWidth = d * 0.14; g.stroke(); g.setLineDash([]); }
      break;
    }
  }
}

function paintSiege(g, plan, P, detail) {
  const sg = plan.siege, px = 1 / P;
  // the camp is drawn at a scale of its own (block depth caps out in big cities)
  const u = clamp(plan.R * 0.075, 0.018, 0.05);
  const col = sg.rgb || [176, 64, 50];
  const n = Math.round(14 + sg.prog * 14);
  g.strokeStyle = css(INK, 0.8); g.lineWidth = Math.max(px, u * 0.12);
  // trampled ground of the siege lines
  g.strokeStyle = 'rgba(120,96,66,0.45)'; g.lineWidth = u * 2.4;
  g.beginPath(); g.arc(0, 0, sg.r, sg.a - Math.PI * 0.85, sg.a + Math.PI * 0.85); g.stroke();
  g.strokeStyle = css(INK, 0.8); g.lineWidth = Math.max(px, u * 0.12);
  for (let q = 0; q < n; q++) {
    const a = sg.a + (q / (n - 1) - 0.5) * Math.PI * 1.6;
    const rr = sg.r * (1 + 0.06 * Math.sin(q * 2.3));
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    g.fillStyle = css(q % 3 === 0 ? col : [228, 218, 196]);
    g.beginPath(); g.moveTo(x, y - u * 0.7); g.lineTo(x + u * 0.6, y + u * 0.4); g.lineTo(x - u * 0.6, y + u * 0.4); g.closePath(); g.fill(); g.stroke();
  }
  // standards of the besieger
  for (let q = 0; q < 3; q++) {
    const a = sg.a + (q - 1) * 0.5, x = Math.cos(a) * sg.r * 1.08, y = Math.sin(a) * sg.r * 1.08;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - u * 1.6); g.stroke();
    g.fillStyle = css(col); g.beginPath(); g.moveTo(x, y - u * 1.6); g.lineTo(x + u, y - u * 1.35); g.lineTo(x, y - u * 1.1); g.closePath(); g.fill(); g.stroke();
  }
  // siege engines facing the walls: rams and towers, trebuchets, then guns
  const ne = 2 + Math.round(sg.prog * 3);
  for (let q = 0; q < ne; q++) {
    const a = sg.a + (q - (ne - 1) / 2) * 0.3;
    const rr = sg.r * 0.88;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    g.save(); g.translate(x, y); g.rotate(a + Math.PI);
    g.fillStyle = sg.era >= 5 ? '#3a3632' : '#7a5634';
    g.fillRect(-u * 0.5, -u * 0.4, u, u * 0.8); g.strokeRect(-u * 0.5, -u * 0.4, u, u * 0.8);
    g.beginPath(); g.moveTo(0, 0); g.lineTo(u * (sg.era >= 5 ? 1.1 : 0.85), 0); g.stroke();
    g.restore();
  }
}

// --- Mythic races build their own way: raceplan.js paints them with these shared pieces

const RACE_API = { polyPath, polyline, shiftPts, shrinkTo, wallGeometry, paintTownRivers, paintLandmark, paintExtra, paintSiege, paintHarbour, applyLandMask, paintWonderPlan, paintHumanBlocks, MATERIAL };

// ---------------------------------------------------------------------------
// Cache, drawing, hits, smoke

const PLAN_BYTES_CAP = (() => {
  try { return (globalThis.matchMedia?.('(pointer: coarse)').matches && Math.min(globalThis.screen?.width || 1e4, globalThis.screen?.height || 1e4) < 900 ? 16 : 40) * 1024 * 1024; } catch (e) { return 40 * 1024 * 1024; }
})();

/** The plan's geometry, cached by a coarse key (monthly noise never rebuilds it). */
function geometryKey(r, s) {
  const w = r.world;
  const B = s.buildings || {};
  let bk = '';
  for (const k of Object.keys(B).sort()) bk += k[0] + k[1] + B[k];
  const civ = w.civs[s.civId];
  const wk = (w.wonders || []).filter((x) => x && x.sid === s.id).map((x) => x.kind + (x.destroyedDay != null ? 'x' : '')).join(',');
  const pj = s.project ? `${s.project.key}:${Math.floor(clamp((s.project.progress || 0) / Math.max(1, s.project.cost || 1), 0, 1) * 5)}` : '';
  const sg = s.siege ? `${s.siege.armyId}:${Math.floor(clamp(Number(s.siege.progress) || 0, 0, 1) * 4)}` : '';
  const st = styleOf(r, s.originCivId ?? s.civId, s.race);
  const fp = footprints(r).byId.get(s.id);
  const q = quarterOf(w, s);
  return `${s.id}|${q ? q.race + q.share : ''}|${qpop(s.peakPopulation)}|${qpop(s.population)}|${bk}|${wk}|${civ?.tech?.era | 0}|${civ?.capitalId === s.id ? 1 : 0}|${st.key}|${sg}|${pj}|${s.dominantReligion ?? ''}|${s.disease ? 1 : 0}|${fp ? Math.round(fp.r * 50) : 0}|${w.versions.water}|${w.versions.roads}`;
}

export class PlanCache {
  constructor() { this.geo = new Map(); this.pics = new Map(); this.bytes = 0; this.buildMs = 0; this.builds = 0; }
  clear() { this.geo.clear(); this.pics.clear(); this.bytes = 0; }
  geometry(r, s, key, opts) {
    let e = this.geo.get(s.id);
    if (e && e.key === key) return e.plan;
    const plan = buildPlan(r, s, opts);
    this.geo.set(s.id, { key, plan });
    if (this.geo.size > 256) this.geo.delete(this.geo.keys().next().value);
    return plan;
  }
  picture(r, plan, key, k, detail, river) {
    const pk = `${key}|${k}|${detail}|${river.join(',')}`;
    let e = this.pics.get(pk);
    if (e) { this.pics.delete(pk); this.pics.set(pk, e); return e; }
    const P = LOD_P[k];
    const ext = plan.ext;
    const S = Math.max(4, Math.ceil(ext * 2 * P));
    const c = makeCanvas(S, S);
    const g = c.getContext('2d');
    g.setTransform(P, 0, 0, P, S / 2, S / 2);
    g.lineJoin = 'round'; g.lineCap = 'round';
    try { paintPlan(g, plan, P, detail, { river }); } catch (err) { if (!PlanCache._warned) { PlanCache._warned = true; console.error('[cityplan]', err); } }
    e = { canvas: c, ext, bytes: S * S * 4 };
    this.pics.set(pk, e);
    this.bytes += e.bytes;
    while (this.bytes > PLAN_BYTES_CAP && this.pics.size > 4) {
      const [k0, v0] = this.pics.entries().next().value;
      this.pics.delete(k0); this.bytes -= v0.bytes;
    }
    while (this.pics.size > 64) { const [k0, v0] = this.pics.entries().next().value; this.pics.delete(k0); this.bytes -= v0.bytes; }
    return e;
  }
}

/** Plan detail for a zoom: 0 province masses, 1 town blocks, 2 street buildings. */
export const planDetail = (z) => (z >= 150 ? 2 : z >= 56 ? 1 : 0);
/** How visible a plan is for its on-screen radius (px): it takes over from the icon as it grows. */
export const planAlpha = (rpx) => smoothstep(7, 13, rpx);

/**
 * Draw the plans of the towns in view (world transform, entity coordinates), building at most
 * a couple of new pictures a frame. Records r._planAlpha (sid → alpha) for the icon crossfade
 * and pushes landmark hits.
 */
export function drawCityPlans(r, ctx, z, worldT) {
  const w = r.world;
  r._planAlpha = r._planAlpha || new Map();
  r._planAlpha.clear();
  // the footprints on screen ([cx, cy, radius] CSS px) that minor lettering keeps off
  r._planRects = r._planRects || [];
  r._planRects.length = 0;
  r._plansPending = 0;   // towns in view left with no picture at all this frame (renderer.detailPending)
  if (z < 14 || r.snapshot) return;
  if (!r._plans) r._plans = new PlanCache();
  const pc = r._plans;
  const fp = footprints(r);
  const vb = r.viewBounds(2);
  const k = pickLevel(z * r.dpr);
  const detail = planDetail(z);
  const st = r.terrain?.style || 'natural';
  const river = st === 'natural' ? [66, 112, 146] : st === 'muted' || st === 'resources' || st === 'devastation' || st === 'pollution' ? [112, 148, 170] : [70, 96, 122];
  const t0 = perf();
  // town pictures share the frame's build budget (2 builds, 3 ms) with the detail chunks; a town
  // with nothing at all to show still gets one build
  const lodBuilt = r.lod ? r.lod.stats.frameBuilds | 0 : 0;
  const lodMs = lodBuilt ? r.lod.stats.buildMs || 0 : 0;
  let built = 0;
  const canBuild = (fallback) => {
    const spent = lodMs + perf() - t0;
    if (built >= 2) return false;
    if (!fallback) return built === 0 || spent < 3;
    return lodBuilt + built < 2 && spent < 3;
  };
  const vis = [];
  for (const t of fp.list) {
    if (t.x < vb.x0 - 2 || t.x > vb.x1 + 2 || t.y < vb.y0 - 2 || t.y > vb.y1 + 2) continue;
    const a = planAlpha(t.r * z);
    if (a <= 0.01) continue;
    vis.push(t);
  }
  // nearest the view centre first
  const cx = r.camera.x - 0.5, cy = r.camera.y - 0.5;
  vis.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'medium';
  const hits = [];
  for (const t of vis) {
    const s = w.settlements[t.id];
    if (!s || !s.alive) continue;
    const key = geometryKey(r, s);
    const pk = `${key}|${k}|${detail}|${river.join(',')}`;
    let pic = pc.pics.get(pk), shown = pk;
    if (!pic) {
      // the picture this town showed last, while the byte-capped cache still holds it
      const lastE = r._planLast?.get(s.id) || null;
      const last = lastE ? pc.pics.get(lastE.pk) || null : null;
      if (!canBuild(last)) {
        // not built yet: show the nearest picture of this town at another level, if any
        pic = last;
        shown = lastE?.pk;
        if (!pic) { r._plansPending++; continue; }
        // it is on screen, so in use: the cache must not evict it while this town's build waits
        // (the town would blink out until built, and main.js would draw every frame meanwhile)
        pc.pics.delete(shown); pc.pics.set(shown, pic);
      } else {
        const s0 = perf();
        const plan = pc.geometry(r, s, key);
        pic = pc.picture(r, plan, key, k, detail, river);
        pic.plan = plan;
        pc.buildMs = perf() - s0; pc.builds++; pc.maxBuildMs = Math.max(pc.maxBuildMs || 0, pc.buildMs);
        built++;
      }
    } else pc.pics.delete(pk), pc.pics.set(pk, pic);
    // only the key and the plan are remembered, never the canvas: pictures live in the cache
    // alone, within its byte cap (planSmoke and the wonders need just the plan)
    (r._planLast ||= new Map()).set(s.id, { pk: shown, plan: pic.plan || null });
    if (r._planLast.size > 300) r._planLast.delete(r._planLast.keys().next().value);
    const a = planAlpha(t.r * z);
    r._planAlpha.set(s.id, a);
    ctx.globalAlpha = a;
    const e = pic.ext;
    const pox = pic.plan ? pic.plan.ox : 0, poy = pic.plan ? pic.plan.oy : 0;
    ctx.drawImage(pic.canvas, s.x + pox - e, s.y + poy - e, e * 2, e * 2);
    if (pic.plan && a > 0.5) {
      hits.push([s, pic.plan]);
      const pl = pic.plan, c = r.e2s(s.x + pox, s.y + poy);
      r._planRects.push([c.sx, c.sy, Math.max(pl.R, pl.walls ? pl.walls.r * 1.04 : 0) * z + 3]);
    }
  }
  ctx.globalAlpha = 1;
  // landmark hits (screen space)
  for (const [s, plan] of hits) {
    for (const lm of plan.landmarks) {
      const { sx, sy } = r.e2s(s.x + plan.ox + lm.x, s.y + plan.oy + lm.y);
      const rr = Math.max(4, lm.size * z);
      r.hits.push({ kind: 'landmark', id: `${s.id}:${lm.key === 'wonder' ? 'wonder:' + lm.id : lm.key}`, sid: s.id, key: lm.key, x0: sx - rr, y0: sy - rr, x1: sx + rr, y1: sy + rr, pri: 2.5 });
    }
  }
  r.stats.plans = vis.length; r.stats.planBuilds = built; r.stats.planMB = pc.bytes / 1048576;
}

/**
 * Foundations of ruined towns (world transform): the town's last plan, roofless and grown
 * over, fading toward green with the centuries. ruins: sites.js ruinList entries in view.
 * Records r._ruinPlanAlpha / r._ruinPlanR for the ruin symbols and their lettering.
 */
export function drawRuinPlans(r, ctx, z, ruins) {
  const w = r.world;
  if (!r._plans) r._plans = new PlanCache();
  const pc = r._plans;
  const fp = footprints(r);
  const k = pickLevel(z * r.dpr);
  const detail = planDetail(z);
  const st = r.terrain?.style || 'natural';
  const river = st === 'natural' ? [66, 112, 146] : [112, 148, 170];
  r._ruinPlanAlpha = r._ruinPlanAlpha || new Map();
  r._ruinPlanR = r._ruinPlanR || new Map();
  let built = 0;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'medium';
  for (const rn of ruins) {
    // a ruin keeps clear of the living: never under a town, never into one's suburbs
    let nn = Infinity;
    const G = fp.G;
    for (let gy = Math.floor(rn.y / G) - 1; gy <= Math.floor(rn.y / G) + 1; gy++) for (let gx = Math.floor(rn.x / G) - 1; gx <= Math.floor(rn.x / G) + 1; gx++) {
      const a = fp.grid.get(gy * fp.gw + gx);
      if (a) for (const t of a) nn = Math.min(nn, Math.hypot(t.x - rn.x, t.y - rn.y) - t.r);
    }
    if (nn < 0.12) continue;
    const R = Math.min(footprintR(rn.peak), 0.5, nn * 0.8);
    const a = planAlpha(R * z) * 0.95;
    if (a <= 0.01) continue;
    const sl = rn.s || { id: -100000 - rn.id, x: Math.round(rn.x), y: Math.round(rn.y), i: Math.round(rn.y) * w.W + Math.round(rn.x), tier: rn.tier, race: null };
    const age = Math.floor(Math.max(0, (w.time.day - (rn.fell ?? 0)) / 360) / 50);
    const key = `ruin|${rn.id}|${qpop(rn.peak)}|${age}|${Math.round(R * 50)}|${w.versions.water}`;
    const pk = `${key}|${k}|${detail}|${river.join(',')}`;
    let pic = pc.pics.get(pk);
    if (!pic) {
      if (built >= 1) continue;
      const ruin = { ...(rn.data || {}), peak: rn.peak, maxTier: rn.tier, fellDay: rn.fell, buildings: rn.data?.buildings || {} };
      const plan = pc.geometry(r, sl, key, { ruin, maxR: R });
      pic = pc.picture(r, plan, key, k, detail, river);
      pic.plan = plan;
      built++;
    }
    r._ruinPlanAlpha.set(rn.id, a);
    r._ruinPlanR.set(rn.id, R);
    ctx.globalAlpha = a;
    const e = pic.ext, pox = pic.plan ? pic.plan.ox : 0, poy = pic.plan ? pic.plan.oy : 0;
    ctx.drawImage(pic.canvas, sl.x + pox - e, sl.y + poy - e, e * 2, e * 2);
  }
  ctx.globalAlpha = 1;
}

/**
 * Live touches on the plans in view: smoke from factory chimneys and power stations, drifting
 * downwind with the pollution's weight (particles; cosmetic).
 */
export function planSmoke(r, dt) {
  const w = r.world;
  if (!r._plans || r.camera.zoom < 20 || !r._planAlpha || !r._planAlpha.size) return;
  const P = r.fx.particles;
  for (const [sid, a] of r._planAlpha) {
    if (a < 0.5) continue;
    const e = r._planLast?.get(sid);
    const plan = e?.plan;
    if (!plan || !plan.chimneys.length) continue;
    const s = w.settlements[sid];
    if (!s) continue;
    const pol = Math.max(0.15, Math.min(1, w.f.pollution[s.i] * 2 + 0.2));
    const wx = (w.f.windX[s.i] || 0) * 0.25, wy = (w.f.windY[s.i] || 0) * 0.25;
    for (let k = 0; k < plan.chimneys.length; k += 2) {
      if (Math.random() > dt * 6 * pol) continue;
      P.spawn(0, s.x + plan.ox + plan.chimneys[k], s.y + plan.oy + plan.chimneys[k + 1], wx + (Math.random() - 0.5) * 0.04, wy - 0.06, plan.d * 0.5, 2.5 + Math.random() * 2, plan.d * 0.6, 0.45);
    }
  }
}
