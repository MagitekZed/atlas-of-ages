// Mythic map rendering — owner WP5 (src/sim/myth). Registered through ./layers.js at import:
//   map modes (shown while mythLevel ≥ 2)
//     arcane    muted ground, a violet mana wash with drained patches in charcoal, glowing
//               dashed ley lines drifting along their courses, standing-stone nodes
//     peoples   lands tinted by the dominant people of the town that holds them (RACE_META
//               hues); where a second people is a quarter or more of a town, its lands lean
//               toward that people's hue and are hatched in its colour (myth.mixhatch); race
//               symbols on the towns, a second, smaller one for such a minority
//     monsters  wild-distance shading from settled country to the deep wild (WP2 draws the
//               lairs, home ranges and raid arrows on top)
//   layers     myth.ground (ground slot: the mana and wild washes, and a faint ley glimmer in
//               the terrain atlas from zoom 3), myth.ley (overTerritory: the arcane lines),
//               myth.nodes (underIcons: node glyphs, clickable as sites), myth.labels (node
//               names), myth.towns (units: race symbols in the peoples mode), myth.mixhatch
//               (overTerritory: the minority hatching in the peoples mode, fading as plans
//               take over close in)
//   effects    spell { color } a turning rune circle · leyflare { x2, y2 } light running along
//               a line · awaken { r } an aurora ring sweeping out from the Awakening
// Caches key on world versions and the month, never on frame time (the hatching's paths, keyed
// the same way, are rebuilt at most every 400 ms while borders move). Never import ./renderer.js.

import { registerLayer, registerFxType, registerMapMode } from './layers.js';
import * as P from './palette.js';
import { RACE_META, RACE_KEYS, DAYS_PER_MONTH, WATER } from '../core/constants.js';
import { raceRgb } from '../sim/myth/races.js';

// the town mixes come from the sim's published peoples helpers (a town reads as one people,
// { [s.race]: 1 }, in a build without them)
let peoplesMod = null;
try { peoplesMod = await import('../sim/myth/index.js'); } catch (e) { /* one people per town */ }

const on2 = (w) => Boolean(w && w.params && w.params.mythLevel >= 2 && w.sys?.myth?.v != null);
const MANA_RAMP = P.makeRamp([[0, [54, 48, 66]], [0.2, [88, 72, 122]], [0.42, [128, 94, 196]], [0.66, [172, 132, 238]], [0.86, [214, 184, 252]], [1, [248, 236, 255]]]);
const WILD_RAMP = P.makeRamp([[0, [226, 220, 196]], [0.25, [176, 186, 150]], [0.5, [112, 140, 104]], [0.75, [64, 92, 70]], [1, [30, 48, 44]]]);
const LEY = [196, 160, 255];
const LEY_HOT = [244, 226, 255];
const NODE_TINT = {
  stone: [190, 176, 230], peak: [226, 230, 255], grove: [140, 220, 170], water: [140, 196, 250], fire: [255, 168, 96],
  glass: [250, 220, 150], tide: [130, 210, 220], rift: [220, 140, 200], well: [214, 190, 255],
};
const RACE_RGB = RACE_KEYS.map((k) => raceRgb(k));

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// ---------------------------------------------------------------------------
// Cached rasters (keyed by world identity, versions and month)

const cache = new WeakMap();   // world → { mana, wild, path, … }
const bag = (w) => { let b = cache.get(w); if (!b) cache.set(w, (b = {})); return b; };

/** The mana wash: one pixel per half-res cell (violet ramp; drained cells charcoal). */
function manaImage(w) {
  const b = bag(w);
  const month = Math.floor(w.time.day / DAYS_PER_MONTH);
  const key = `${month}|${w.versions.ley || 0}|${w.versions.load || 0}`;
  if (b.mana && b.manaKey === key) return b.mana;
  const W2 = w.W >> 1, H2 = w.H >> 1;
  const m = w.f.mana, base = w.f.manaBase;
  if (!m || m.length !== W2 * H2) return null;
  const cv = b.mana?.width === W2 && b.mana?.height === H2 ? b.mana : makeCanvas(W2, H2);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W2, H2);
  const d = img.data;
  for (let cy = 0; cy < H2; cy++) for (let cx = 0; cx < W2; cx++) {
    const c = cy * W2 + cx;
    const i = Math.min(w.H - 1, cy * 2) * w.W + Math.min(w.W - 1, cx * 2);
    const land = w.f.water[i] === WATER.LAND;
    const v = Math.max(0, Math.min(1, m[c] / 1.1));
    const drained = base[c] > 0.3 && m[c] < 0.35 * base[c];
    const rgb = drained ? P.CHARCOAL : P.rampAt(MANA_RAMP, v);
    const o = c * 4;
    d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2];
    // thin mana reads as a dusky veil, rich mana as bright lilac; drained ground goes charcoal
    d[o + 3] = Math.round(255 * (drained ? 0.7 : land ? 0.26 + 0.44 * Math.abs(v - 0.35) / 0.65 + 0.12 * v : 0.08 + 0.3 * v));
  }
  ctx.putImageData(img, 0, 0);
  b.mana = cv; b.manaKey = key;
  return cv;
}

/** Wild-distance: tiles from the nearest owned or settled ground (BFS at half resolution). */
function wildImage(w) {
  const b = bag(w);
  const key = `${w.versions.owner}|${w.versions.settlements}|${w.versions.load || 0}`;
  if (b.wild && b.wildKey === key) return b.wild;
  const W2 = w.W >> 1, H2 = w.H >> 1, M = W2 * H2;
  const D = new Int16Array(M).fill(-1);
  const q = new Int32Array(M);
  let qh = 0, qt = 0;
  for (let cy = 0; cy < H2; cy++) for (let cx = 0; cx < W2; cx++) {
    const i = Math.min(w.H - 1, cy * 2) * w.W + Math.min(w.W - 1, cx * 2);
    if (w.f.owner[i] >= 0 || w.f.popDensity[i] > 4) { const c = cy * W2 + cx; D[c] = 0; q[qt++] = c; }
  }
  while (qh < qt) {
    const c = q[qh++], cx = c % W2, cy = (c / W2) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= W2 || ny >= H2) continue;
      const n = ny * W2 + nx;
      if (D[n] >= 0) continue;
      D[n] = D[c] + 1; q[qt++] = n;
    }
  }
  const cv = b.wild?.width === W2 && b.wild?.height === H2 ? b.wild : makeCanvas(W2, H2);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W2, H2);
  const d = img.data;
  for (let c = 0; c < M; c++) {
    const cx = c % W2, cy = (c / W2) | 0;
    const i = Math.min(w.H - 1, cy * 2) * w.W + Math.min(w.W - 1, cx * 2);
    const o = c * 4;
    if (w.f.water[i] !== WATER.LAND) { d[o + 3] = 0; continue; }
    const t = D[c] < 0 ? 1 : Math.min(1, D[c] / 14);   // 14 cells ≈ 560 km from any town
    const rgb = P.rampAt(WILD_RAMP, t);
    d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = Math.round(255 * (0.25 + 0.5 * t));
  }
  ctx.putImageData(img, 0, 0);
  b.wild = cv; b.wildKey = key;
  return cv;
}

/** Ley lines as one Path2D in world coordinates (tile centre = integer), cached by versions.ley. */
function leyPaths(w) {
  const b = bag(w);
  const st = w.sys.myth;
  const key = `${w.versions.ley || 0}|${st.ley.edges.length}|${st.stroke ? st.stroke.pts.length : 0}|${w.versions.load || 0}`;
  if (b.path && b.pathKey === key) return b;
  const main = new Path2D(), user = new Path2D(), stroke = new Path2D();
  for (const e of st.ley.edges) {
    const p = e.pts;
    if (!p || p.length < 4) continue;
    const path = e.by === 'user' ? user : main;
    path.moveTo(p[0], p[1]);
    for (let k = 2; k + 1 < p.length; k += 2) path.lineTo(p[k], p[k + 1]);
  }
  if (st.stroke && st.stroke.pts.length >= 4) {
    const p = st.stroke.pts;
    stroke.moveTo(p[0], p[1]);
    for (let k = 2; k + 1 < p.length; k += 2) stroke.lineTo(p[k], p[k + 1]);
  }
  b.path = main; b.user = user; b.stroke = stroke; b.hasStroke = Boolean(st.stroke && st.stroke.pts.length >= 4); b.pathKey = key;
  return b;
}

const nodesOf = (w) => {
  const b = bag(w);
  const v = w.versions.sites;
  if (b.nodes && b.nodesV === v) return b.nodes;
  b.nodes = w.sites.filter((s) => s && s.kind === 'node'); b.nodesV = v;
  return b.nodes;
};

// ---------------------------------------------------------------------------
// Mixed peoples: per town, the dominant people and a second one of a quarter or more

const MINOR_MIN = 0.25;
const RACE_IDX = Object.fromEntries(RACE_KEYS.map((k, n) => [k, n]));
/** A town's peoples, [{ race, share }] by share (the helper, else s.peoples, else s.race). */
function mixOfTown(w, s) {
  const f = peoplesMod && typeof peoplesMod.townPeoples === 'function' ? peoplesMod.townPeoples : null;
  if (f) { try { const r = f(w, s); if (Array.isArray(r) && r.length) return r; } catch (e) { /* fall back */ } }
  if (s.peoples && typeof s.peoples === 'object') {
    const out = Object.entries(s.peoples).filter(([r, v]) => RACE_IDX[r] != null && v > 0).map(([race, share]) => ({ race, share }));
    if (out.length) return out.sort((a, b) => b.share - a.share);
  }
  const r = s.race || w.civs[s.civId]?.race;
  return r ? [{ race: r, share: 1 }] : [];
}

/**
 * Per settlement id: dom (race index of the dominant people, s.race, −1 none), minor (race
 * index of the largest other people ≥ 25 %, −1 none) and its share; sig changes whenever
 * any of them (the share by tenths) does. Cached per month and settlements/civs versions.
 */
function townPeoplesCats(w) {
  const b = bag(w);
  const v = w.versions;
  const key = `${Math.floor(w.time.day / DAYS_PER_MONTH)}|${v.settlements}|${v.civs}|${v.peoples || 0}|${v.load || 0}`;
  if (b.tp && b.tpKey === key) return b.tp;
  const n = w.settlements.length;
  const dom = new Int8Array(n).fill(-1), minor = new Int8Array(n).fill(-1), share = new Float32Array(n);
  let sig = 2166136261 >>> 0;
  for (let id = 0; id < n; id++) {
    const s = w.settlements[id];
    if (!s || !s.alive) continue;
    const mix = mixOfTown(w, s);
    const dr = s.race && RACE_IDX[s.race] != null ? s.race : mix[0]?.race;
    const d = dr != null ? RACE_IDX[dr] ?? -1 : -1;
    dom[id] = d;
    for (const it of mix) if (it.race !== dr && it.share >= MINOR_MIN && RACE_IDX[it.race] != null) { minor[id] = RACE_IDX[it.race]; share[id] = it.share; break; }
    if (minor[id] >= 0 || d >= 0) sig = Math.imul(sig ^ (id * 131 + (d + 1) * 17 + (minor[id] + 1) * 3 + Math.round(share[id] * 10)), 16777619) >>> 0;
  }
  b.tp = { dom, minor, share, sig: sig.toString(36) };
  b.tpKey = key;
  return b.tp;
}

/** Path2D per minority race: the tiles held by towns with a second people ≥ 25 % (rows of runs). */
function hatchPaths(w) {
  const b = bag(w);
  const tp = townPeoplesCats(w);
  const key = `${w.versions.owner}|${tp.sig}`;
  if (b.hatch && b.hatchKey === key) return b.hatch;
  // borders move often at speed: rebuild (≈ 3 ms on a medium map) at most a few times a second
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  if (b.hatch && now - (b.hatchAt || 0) < 400) return b.hatch;
  b.hatchAt = now;
  const W = w.W, H = w.H, os = w.f.ownerSettle, water = w.f.water;
  const paths = new Map();   // race index → { path, strong }
  const minorAt = (i) => { if (water[i] !== WATER.LAND) return -1; const sid = os[i]; return sid >= 0 && sid < tp.minor.length ? tp.minor[sid] : -1; };
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      const m = minorAt(y * W + x);
      if (m < 0) { x++; continue; }
      let x1 = x + 1;
      while (x1 < W && minorAt(y * W + x1) === m) x1++;
      let e = paths.get(m);
      if (!e) paths.set(m, (e = { path: new Path2D() }));
      e.path.rect(x - 0.5, y - 0.5, x1 - x, 1);
      x = x1;
    }
  }
  b.hatch = paths; b.hatchKey = key;
  return paths;
}

/** A diagonal hatch in a race's colour (device pixels; a dark seam keeps it legible on any hue). */
const hatchTiles = new Map();
function hatchPattern(ctx, k) {
  let cv = hatchTiles.get(k);
  if (!cv) {
    const S = 9;
    cv = makeCanvas(S, S);
    const g = cv.getContext('2d');
    const rgb = RACE_RGB[k] || [150, 140, 128];
    g.lineCap = 'square';
    for (const off of [-S, 0, S]) {
      g.strokeStyle = 'rgba(24,20,16,0.42)'; g.lineWidth = 3.4;
      g.beginPath(); g.moveTo(off, S); g.lineTo(off + S, 0); g.stroke();
      g.strokeStyle = P.css(rgb, 0.95); g.lineWidth = 2;
      g.beginPath(); g.moveTo(off, S); g.lineTo(off + S, 0); g.stroke();
    }
    hatchTiles.set(k, cv);
  }
  return ctx.createPattern(cv, 'repeat');
}

// ---------------------------------------------------------------------------
// Map modes

const when = (w) => w == null ? false : Boolean(w.params && w.params.mythLevel >= 2);

registerMapMode({
  id: 'arcane', label: 'Arcane', desc: 'Mana across the land, the ley lines that carry it and the places of power where they meet; drained country shows dark.',
  when,
  profile: { style: 'muted', region: null, borders: 0.45, settle: 0.85, labelsCiv: false, detail: 'peaks', routesK: 0, clouds: false },
  legend: () => ({
    title: 'Mana', type: 'gradient', stops: [0, 0.25, 0.5, 0.75, 1].map((t) => [t, P.css(P.rampAt(MANA_RAMP, t))]), minLabel: 'Dead', maxLabel: 'Blazing',
    items: [{ label: 'Ley line', color: P.css(LEY) }, { label: 'Drained', color: P.css(P.CHARCOAL) }, { label: 'Place of power', color: P.css(NODE_TINT.stone) }],
  }),
});

registerMapMode({
  id: 'peoples', label: 'Peoples', desc: 'Whose land it is by blood: elves, dwarves, orcs, halflings, lizardfolk and men, town by town.',
  when,
  profile: { style: 'muted', region: null, borders: 0.65, settle: 1, labelsCiv: true, detail: 'peaks', routesK: 0.2, clouds: false },
  territory(r) {
    const w = r.world;
    if (!on2(w)) return null;
    const v = w.versions;
    const os = w.f.ownerSettle;
    const tp = townPeoplesCats(w);
    const NRK = RACE_KEYS.length + 1;
    return {
      key: `${v.owner}|${v.settlements}|${v.civs}|${tp.sig}`,
      // category: dominant × (minority + 1), so mixed towns' lands are their own regions
      catFn: (i) => {
        const sid = os[i];
        if (!(sid >= 0) || sid >= tp.dom.length) return -1;
        const d = tp.dom[sid];
        return d < 0 ? -1 : d * NRK + (tp.minor[sid] + 1);
      },
      colorFn: (c) => {
        const d = Math.floor(c / NRK), m = (c % NRK) - 1;
        const rgb = RACE_RGB[d] || [150, 140, 128];
        // a second people of a quarter or more pulls the wash toward its own hue
        const mix = m >= 0 ? P.mix3(rgb, RACE_RGB[m] || rgb, 0.3) : rgb;
        return [mix[0], mix[1], mix[2], 0.62];
      },
      fillA: 0.55, glowA: 0.32, glowTiles: 1.4, coastK: 0.35,
    };
  },
  legend: (w) => {
    const seen = new Set();
    let mixed = null;
    if (w && on2(w)) {
      const tp = townPeoplesCats(w);
      for (let id = 0; id < tp.dom.length; id++) {
        if (tp.dom[id] >= 0) seen.add(RACE_KEYS[tp.dom[id]]);
        if (tp.minor[id] >= 0) { seen.add(RACE_KEYS[tp.minor[id]]); if (!mixed) mixed = [tp.dom[id], tp.minor[id]]; }
      }
      for (const s of w.settlements) if (s && s.alive) for (const it of mixOfTown(w, s)) if (it.share >= 0.1) seen.add(it.race);
    }
    const items = RACE_KEYS.filter((k) => !w || seen.has(k)).map((k) => ({ label: RACE_META[k].plural, color: P.css(raceRgb(k)) }));
    if (mixed) {
      const a = P.css(RACE_RGB[mixed[0]]), b2 = P.css(RACE_RGB[mixed[1]]);
      items.push({ label: 'Mixed towns', color: `repeating-linear-gradient(135deg, ${a} 0 3px, ${b2} 3px 5px)` });
    }
    return { title: 'Peoples', type: 'swatches', items: items.length ? items : [{ label: 'No peoples yet', color: 'rgba(150,140,128,0.6)' }] };
  },
});

registerMapMode({
  id: 'monsters', label: 'Monsters', desc: 'Where the wild things are: shading from settled country to the deep wild, where beasts keep their lairs and hunt.',
  when,
  profile: { style: 'muted', region: null, borders: 0.55, settle: 0.9, labelsCiv: false, detail: 'peaks', routesK: 0.3, clouds: false },
  legend: () => ({ title: 'The wild', type: 'gradient', stops: [0, 0.25, 0.5, 0.75, 1].map((t) => [t, P.css(P.rampAt(WILD_RAMP, t))]), minLabel: 'Settled', maxLabel: 'Deep wild' }),
});

// ---------------------------------------------------------------------------
// Layers

registerLayer({
  id: 'myth.ground', slot: 'ground', order: 30,
  draw(r, ctx, env) {
    const w = r.world;
    if (!on2(w) || env.snapshot) return;
    const z = env.z;
    if (env.mode === 'arcane') {
      const img = manaImage(w);
      if (img) {
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(img, -0.5, -0.5, (w.W >> 1) * 2, (w.H >> 1) * 2);
      }
    } else if (env.mode === 'monsters') {
      const img = wildImage(w);
      if (img) {
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(img, -0.5, -0.5, (w.W >> 1) * 2, (w.H >> 1) * 2);
      }
    } else if (env.mode === 'terrain' && z >= 3) {
      // a faint glimmer: the ley is there if you look for it
      const b = leyPaths(w);
      const fade = Math.min(1, (z - 3) / 3) * (1 - 0.5 * Math.min(1, Math.max(0, (z - 30) / 40)));
      const pulse = r.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(env.now / 1400);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = P.css(LEY, (0.1 + 0.07 * pulse) * fade);
      ctx.lineWidth = Math.max(0.35, 3.2 / z);
      ctx.stroke(b.path); ctx.stroke(b.user);
      ctx.strokeStyle = P.css(LEY_HOT, (0.12 + 0.1 * pulse) * fade);
      ctx.lineWidth = Math.max(0.12, 1 / z);
      ctx.stroke(b.path); ctx.stroke(b.user);
    }
    // a ley line being drawn with the tool shows in every mode, bright, as the hand moves
    const st = w.sys.myth;
    if (st.stroke && st.stroke.pts.length >= 4 && env.mode !== 'arcane') {
      const b = leyPaths(w);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = P.css(LEY, 0.35); ctx.lineWidth = Math.max(0.6, 7 / z); ctx.stroke(b.stroke);
      ctx.strokeStyle = P.css(LEY_HOT, 0.9); ctx.lineWidth = Math.max(0.25, 2.2 / z); ctx.stroke(b.stroke);
    }
  },
});

registerLayer({
  id: 'myth.mixhatch', slot: 'overTerritory', order: 30,
  draw(r, ctx, env) {
    const w = r.world;
    if (!on2(w) || env.snapshot || env.mode !== 'peoples') return;
    const z = env.z;
    // the hatch reads the land at a glance; up close the town plans and their quarters do
    const a = 1 - Math.min(1, Math.max(0, (z - 9) / 9));
    if (a <= 0.02) return;
    const paths = hatchPaths(w);
    if (!paths.size) return;
    const zd = z * (env.dpr || 1);
    const m = typeof DOMMatrix !== 'undefined' ? new DOMMatrix([1 / zd, 0, 0, 1 / zd, 0, 0]) : null;
    ctx.globalAlpha = 0.62 * a;
    for (const [k, e] of paths) {
      const pat = hatchPattern(ctx, k);
      if (!pat) continue;
      if (m && pat.setTransform) pat.setTransform(m);
      ctx.fillStyle = pat;
      ctx.fill(e.path);
    }
    ctx.globalAlpha = 1;
  },
});

registerLayer({
  id: 'myth.ley', slot: 'overTerritory', order: 40,
  draw(r, ctx, env) {
    const w = r.world;
    if (!on2(w) || env.snapshot || env.mode !== 'arcane') return;
    const b = leyPaths(w);
    const z = env.z;
    const t = r.reducedMotion ? 0 : env.now;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // soft glow, then a bright dashed core drifting along the line
    ctx.strokeStyle = P.css(LEY, 0.22);
    ctx.lineWidth = Math.max(0.8, 9 / z);
    ctx.stroke(b.path); ctx.stroke(b.user);
    ctx.strokeStyle = P.css(LEY, 0.5);
    ctx.lineWidth = Math.max(0.35, 3.6 / z);
    ctx.stroke(b.path); ctx.stroke(b.user);
    const dash = Math.max(0.8, 10 / z);
    ctx.setLineDash([dash * 1.6, dash]);
    ctx.lineDashOffset = -t / 90 / Math.max(1, z / 8);
    ctx.strokeStyle = P.css(LEY_HOT, 0.85);
    ctx.lineWidth = Math.max(0.15, 1.6 / z);
    ctx.stroke(b.path);
    ctx.lineDashOffset = t / 110 / Math.max(1, z / 8);
    ctx.stroke(b.user);
    ctx.setLineDash([]);
    if (b.hasStroke) { ctx.strokeStyle = P.css(LEY_HOT, 0.9); ctx.lineWidth = Math.max(0.3, 2.4 / z); ctx.stroke(b.stroke); }
  },
});

/** A standing-stone glyph: three stones on a glowing ring, tinted by the node's ground. */
function drawNode(ctx, sx, sy, s, kind, glowA, t) {
  const tint = NODE_TINT[kind] || NODE_TINT.stone;
  const pulse = 0.85 + 0.15 * Math.sin(t / 650);
  const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, s * 2.6);
  g.addColorStop(0, P.css(tint, 0.62 * glowA * pulse));
  g.addColorStop(0.45, P.css(tint, 0.22 * glowA));
  g.addColorStop(1, P.css(tint, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(sx, sy, s * 2.6, 0, Math.PI * 2); ctx.fill();
  // the ring the stones stand in
  ctx.lineWidth = Math.max(1.1, s * 0.16);
  ctx.strokeStyle = P.css([30, 24, 40], 0.55 * glowA);
  ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.42, s * 1.3, s * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = P.css(P.lighten(tint, 0.25), 0.95 * glowA);
  ctx.lineWidth = Math.max(0.8, s * 0.1);
  ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.42, s * 1.3, s * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
  const stone = [214, 208, 222], dark = [36, 30, 46];
  const wd = s * 0.46;
  for (const k of [-1, 1, 0]) {          // the tall middle stone last, in front
    const h = s * (k === 0 ? 1.6 : 1.12);
    const x = sx + k * s * 0.7 - wd / 2, y = sy + s * 0.42 - h;
    ctx.fillStyle = P.css(dark, 0.92);
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x - 1, y - 1, wd + 2, h + 2, wd * 0.5); else ctx.rect(x - 1, y - 1, wd + 2, h + 2); ctx.fill();
    ctx.fillStyle = P.css(P.mix3(stone, tint, 0.22));
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, wd, h, wd * 0.45); else ctx.rect(x, y, wd, h); ctx.fill();
    ctx.fillStyle = P.css([255, 255, 255], 0.35);
    ctx.fillRect(x + wd * 0.18, y + h * 0.15, Math.max(0.8, wd * 0.18), h * 0.55);
  }
  // a spark of power over the tallest stone
  const sp = s * (0.16 + 0.06 * pulse);
  ctx.fillStyle = P.css(P.lighten(tint, 0.6), 0.95 * glowA);
  ctx.beginPath(); ctx.arc(sx, sy - s * 1.45, sp, 0, Math.PI * 2); ctx.fill();
}

registerLayer({
  id: 'myth.nodes', slot: 'underIcons', order: 40,
  draw(r, ctx, env) {
    const w = r.world;
    if (!on2(w) || env.snapshot) return;
    const z = env.z;
    const arcane = env.mode === 'arcane';
    if (!arcane && z < 3) return;
    const vb = env.vb;
    const s = Math.max(4.2, Math.min(15, (arcane ? 4 : 3) + z * 0.42));
    const glowA = arcane ? 1 : Math.min(1, (z - 3) / 4) * 0.85;
    const t = r.reducedMotion ? 0 : env.now;
    for (const n of nodesOf(w)) {
      if (n.x < vb.x0 || n.x > vb.x1 || n.y < vb.y0 || n.y > vb.y1) continue;
      const { sx, sy } = r.e2s(n.x, n.y);
      drawNode(ctx, sx, sy, s * (0.85 + 0.25 * (n.data?.power ?? 0.8)), n.data?.nk || 'stone', glowA, t + n.id * 300);
      r.hits.push({ kind: 'site', id: n.id, x0: sx - s * 1.4, y0: sy - s * 1.7, x1: sx + s * 1.4, y1: sy + s * 1.0, pri: 3 });
    }
  },
});

registerLayer({
  id: 'myth.labels', slot: 'labels', order: 40,
  draw(r, ctx, env) {
    const w = r.world;
    if (!on2(w) || env.snapshot || !env.labels || !r.overlays.labels) return;
    const z = env.z;
    const arcane = env.mode === 'arcane';
    if (z < (arcane ? 4 : 9)) return;
    const vb = env.vb;
    for (const n of nodesOf(w)) {
      if (!n.name || n.x < vb.x0 || n.x > vb.x1 || n.y < vb.y0 || n.y > vb.y1) continue;
      const { sx, sy } = r.e2s(n.x, n.y);
      const s = Math.max(4.2, Math.min(15, (arcane ? 4 : 3) + z * 0.42));
      env.labels.push({
        pri: arcane ? 30 + 10 * (n.data?.power ?? 0.8) : 14, text: n.name, x: sx, y: sy - s * 0.2, anchor: 'icon', rad: s * 1.45,
        st: { size: arcane ? 11.5 : 10, italic: true, color: arcane ? 'rgb(58,36,102)' : 'rgb(84,60,122)', halo: 'rgba(246,240,255,0.85)', haloW: 2.2 },
      });
    }
  },
});

/** Small race symbols: round, leaf, diamond, spike, mound, scale. */
function raceSymbol(ctx, kind, x, y, s, rgb) {
  ctx.fillStyle = P.css(rgb);
  ctx.strokeStyle = 'rgba(24,20,16,0.85)';
  ctx.lineWidth = Math.max(0.8, s * 0.18);
  ctx.beginPath();
  switch (kind) {
    case 'leaf': ctx.ellipse(x, y, s * 0.42, s * 0.8, Math.PI / 4, 0, Math.PI * 2); break;
    case 'diamond': ctx.moveTo(x, y - s * 0.8); ctx.lineTo(x + s * 0.6, y); ctx.lineTo(x, y + s * 0.8); ctx.lineTo(x - s * 0.6, y); ctx.closePath(); break;
    case 'spike': ctx.moveTo(x, y - s * 0.9); ctx.lineTo(x + s * 0.7, y + s * 0.6); ctx.lineTo(x - s * 0.7, y + s * 0.6); ctx.closePath(); break;
    case 'mound': ctx.moveTo(x - s * 0.8, y + s * 0.45); ctx.quadraticCurveTo(x, y - s * 0.95, x + s * 0.8, y + s * 0.45); ctx.closePath(); break;
    case 'scale': ctx.moveTo(x - s * 0.7, y - s * 0.3); ctx.quadraticCurveTo(x, y + s * 1.05, x + s * 0.7, y - s * 0.3); ctx.quadraticCurveTo(x, y + s * 0.1, x - s * 0.7, y - s * 0.3); ctx.closePath(); break;
    default: ctx.arc(x, y, s * 0.55, 0, Math.PI * 2);
  }
  ctx.fill(); ctx.stroke();
}

registerLayer({
  id: 'myth.towns', slot: 'units', order: 40,
  draw(r, ctx, env) {
    const w = r.world;
    if (!on2(w) || env.snapshot || env.mode !== 'peoples') return;
    const z = env.z;
    if (z < 2.2) return;
    const vb = env.vb;
    const s = Math.max(3, Math.min(7, 2 + z * 0.22));
    const tp = townPeoplesCats(w);
    for (const st of w.settlements) {
      if (!st || !st.alive || st.x < vb.x0 || st.x > vb.x1 || st.y < vb.y0 || st.y > vb.y1) continue;
      if (z < 4 && st.tier < 3 && w.civs[st.civId]?.capitalId !== st.id) continue;
      const race = st.race || w.civs[st.civId]?.race;
      const meta = race && RACE_META[race];
      if (!meta) continue;
      const { sx, sy } = r.e2s(st.x, st.y);
      // a second people of a quarter or more: its symbol, smaller, tucked behind
      const mk = tp.minor[st.id] ?? -1;
      if (mk >= 0) { const mr = RACE_KEYS[mk]; raceSymbol(ctx, RACE_META[mr].symbol, sx + s * 2.55, sy - s * 0.75, s * 0.72, raceRgb(mr)); }
      raceSymbol(ctx, meta.symbol, sx + s * 1.5, sy - s * 1.4, s, raceRgb(race));
    }
  },
});

// ---------------------------------------------------------------------------
// Effects

const parse = (c, d) => (Array.isArray(c) ? c : typeof c === 'string' ? P.parseColor(c) || d : d);

registerFxType('spell', {
  dur: 2600, priority: 5, cap: 12,
  draw(fx, ctx, r, t) {
    const { sx, sy } = r.e2s(fx.x, fx.y);
    const z = r.camera.zoom;
    const R = Math.max(14, (fx.r || 2) * z);
    const rgb = parse(fx.color, [180, 140, 255]);
    const a = Math.sin(Math.PI * Math.min(1, t * 1.15));
    const rot = t * Math.PI * 1.4;
    ctx.globalAlpha = 1;
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 1.3);
    g.addColorStop(0, P.css(rgb, 0.35 * a)); g.addColorStop(1, P.css(rgb, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, R * 1.3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = P.css(P.lighten(rgb, 0.4), 0.9 * a);
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(sx, sy, R * 0.72, 0, Math.PI * 2); ctx.stroke();
    // runes: little marks between the rings, turning
    for (let k = 0; k < 12; k++) {
      const ang = rot + (k / 12) * Math.PI * 2;
      const x0 = sx + Math.cos(ang) * R * 0.86, y0 = sy + Math.sin(ang) * R * 0.86;
      ctx.save(); ctx.translate(x0, y0); ctx.rotate(ang + Math.PI / 2);
      ctx.beginPath();
      if (k % 3 === 0) { ctx.moveTo(-3, -3); ctx.lineTo(0, 3); ctx.lineTo(3, -3); }
      else if (k % 3 === 1) { ctx.moveTo(0, -3.5); ctx.lineTo(0, 3.5); ctx.moveTo(-2.5, 0); ctx.lineTo(2.5, -2); }
      else { ctx.arc(0, 0, 2.4, 0, Math.PI * 1.5); }
      ctx.stroke(); ctx.restore();
    }
    // a pentagram-like star inside, drawn on as the spell builds
    ctx.beginPath();
    const n = 5, prog = Math.min(1, t * 2.2);
    for (let k = 0; k <= Math.floor(n * prog); k++) {
      const ang = -rot * 0.6 + (k * 2 * (Math.PI * 2)) / n - Math.PI / 2;
      const x = sx + Math.cos(ang) * R * 0.66, y = sy + Math.sin(ang) * R * 0.66;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
});

registerFxType('leyflare', {
  dur: 2200, priority: 4, cap: 30,
  draw(fx, ctx, r, t) {
    const a = r.e2s(fx.x, fx.y);
    const b = r.e2s(Number.isFinite(fx.x2) ? fx.x2 : fx.x, Number.isFinite(fx.y2) ? fx.y2 : fx.y);
    const fade = Math.sin(Math.PI * Math.min(1, t));
    const len = Math.hypot(b.sx - a.sx, b.sy - a.sy);
    ctx.lineCap = 'round';
    if (len > 2) {
      ctx.strokeStyle = P.css(LEY, 0.35 * fade);
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
    }
    // the bright pulse runs from a to b, trailing sparks
    const u = Math.min(1, t * 1.25);
    const px = a.sx + (b.sx - a.sx) * u, py = a.sy + (b.sy - a.sy) * u;
    const g = ctx.createRadialGradient(px, py, 0, px, py, 16);
    g.addColorStop(0, P.css(LEY_HOT, 0.95 * fade)); g.addColorStop(1, P.css(LEY, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, 16, 0, Math.PI * 2); ctx.fill();
    for (let k = 1; k <= 6; k++) {
      const v = Math.max(0, u - k * 0.04);
      const x = a.sx + (b.sx - a.sx) * v + Math.sin(k * 7.1 + t * 9) * 3, y = a.sy + (b.sy - a.sy) * v + Math.cos(k * 5.3 + t * 8) * 3;
      ctx.fillStyle = P.css(LEY_HOT, fade * (1 - k / 7));
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
    }
  },
});

registerFxType('awaken', {
  dur: 5200, priority: 8, cap: 4,
  draw(fx, ctx, r, t) {
    const { sx, sy } = r.e2s(fx.x, fx.y);
    const z = r.camera.zoom;
    const maxR = Math.max(60, Math.min(Math.hypot(r.viewW, r.viewH), (fx.r || 20) * z));
    const e = 1 - Math.pow(1 - Math.min(1, t * 1.1), 3);
    const R = 8 + maxR * e;
    const fade = 1 - Math.min(1, Math.max(0, (t - 0.55) / 0.45));
    // aurora ring: three bands of colour
    const bands = [[150, 110, 255], [110, 210, 220], [230, 160, 255]];
    for (let k = 0; k < 3; k++) {
      const rr = R * (1 - k * 0.07);
      ctx.strokeStyle = P.css(bands[k], 0.5 * fade);
      ctx.lineWidth = 10 - k * 3;
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(1, rr), 0, Math.PI * 2); ctx.stroke();
    }
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(2, R));
    g.addColorStop(0, P.css([246, 232, 255], 0.28 * fade)); g.addColorStop(0.7, P.css([150, 110, 255], 0.08 * fade)); g.addColorStop(1, P.css([150, 110, 255], 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, Math.max(2, R), 0, Math.PI * 2); ctx.fill();
    // motes rising
    for (let k = 0; k < 28; k++) {
      const ang = (k / 28) * Math.PI * 2 + k * 0.37;
      const d = R * (0.35 + ((k * 0.618) % 0.6));
      const x = sx + Math.cos(ang) * d, y = sy + Math.sin(ang) * d - t * 30 * ((k % 5) + 1);
      ctx.fillStyle = P.css(LEY_HOT, fade * 0.8);
      ctx.beginPath(); ctx.arc(x, y, 1.2 + (k % 3) * 0.6, 0, Math.PI * 2); ctx.fill();
    }
  },
});
