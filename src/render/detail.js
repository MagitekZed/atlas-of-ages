// Close-zoom detail, painted into the LOD chunks (./lod.js) at device px per tile P: ranges
// of peaks (the highest point of each lattice cell, majors over foothills), hill symbols that
// become slope-following hachures up close, trees by biome, density and season (bare in
// winter, snow-capped under snow, charred snags on burn scars), dunes set across the wind,
// grass tufts, reeds, lichen and scree. Every glyph is placed by a hash of its tile and the
// level, so neighbouring chunks agree to the pixel; each level is a fixed set of sprite sizes.
// Glyphs within a chunk are depth-sorted so nearer (lower) ones overlap those behind.

import { BIOME, WATER } from '../core/constants.js';
import { hash2i } from '../core/rng.js';
import { treeSprite, peakSprite, qpx } from './glyphs.js';
import { makeCanvas } from './terrain.js';
import { registerPainter, mix } from './lod.js';
import { townsIn } from './cityplan.js';

/** Peak height : half-width, in three steps (few sprite shapes per size, so the caches settle). */
const peakRatio = (v) => (v < 1.0 ? 0.85 : v < 1.32 ? 1.15 : 1.5);

const TREE_FOR = [];
TREE_FOR[BIOME.TAIGA] = 'conifer';
TREE_FOR[BIOME.TEMPERATE_FOREST] = 'broadleaf';
TREE_FOR[BIOME.TEMPERATE_RAINFOREST] = 'conifer';
TREE_FOR[BIOME.RAINFOREST] = 'jungle';
TREE_FOR[BIOME.TROPICAL_FOREST] = 'broadleaf';
TREE_FOR[BIOME.SAVANNA] = 'acacia';
TREE_FOR[BIOME.SHRUBLAND] = 'shrub';
TREE_FOR[BIOME.WETLAND] = 'shrub';
TREE_FOR[BIOME.TUNDRA] = 'shrub';
const TREE_DENSITY = new Float32Array(20);
TREE_DENSITY[BIOME.TAIGA] = 1; TREE_DENSITY[BIOME.TEMPERATE_FOREST] = 1; TREE_DENSITY[BIOME.TEMPERATE_RAINFOREST] = 1.1;
TREE_DENSITY[BIOME.RAINFOREST] = 1.2; TREE_DENSITY[BIOME.TROPICAL_FOREST] = 0.85; TREE_DENSITY[BIOME.SAVANNA] = 0.25;
TREE_DENSITY[BIOME.SHRUBLAND] = 0.35; TREE_DENSITY[BIOME.WETLAND] = 0.28; TREE_DENSITY[BIOME.TUNDRA] = 0.1;

const PEAK_MIN = 0.7;
const HILL_MIN = 0.63;
// per level: trees per fully wooded tile, tree size (tiles), peak lattice (tiles)
const TREE_MAX = [1.6, 3.2, 5.5, 9, 14];
const TREE_SIZE = [0.42, 0.3, 0.21, 0.155, 0.115];
const PEAK_CELL = [2, 1, 1, 0.5, 0.5];

const hashF = (h, shift, bits = 8) => ((h >>> shift) & ((1 << bits) - 1)) / ((1 << bits) - 1);

/** Bilinear sample of a per-tile field at entity coordinates (integer = tile centre). */
export function bil(F, W, H, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const cx0 = x0 < 0 ? 0 : x0 > W - 1 ? W - 1 : x0, cx1 = x0 + 1 < 0 ? 0 : x0 + 1 > W - 1 ? W - 1 : x0 + 1;
  const cy0 = y0 < 0 ? 0 : y0 > H - 1 ? H - 1 : y0, cy1 = y0 + 1 < 0 ? 0 : y0 + 1 > H - 1 ? H - 1 : y0 + 1;
  return F[cy0 * W + cx0] * (1 - fx) * (1 - fy) + F[cy0 * W + cx1] * fx * (1 - fy) + F[cy1 * W + cx0] * (1 - fx) * fy + F[cy1 * W + cx1] * fx * fy;
}

/** Season of deciduous trees for a local year phase: 0 leafy, 1 autumn, 2 bare. */
export function leafSeason(ph, lat) {
  if (Math.abs(lat) <= 0.18) return 0;
  return ph > 0.76 && ph < 0.92 ? 1 : ph >= 0.92 || ph < 0.2 ? 2 : 0;
}

/** A point-in-footprint test for the towns near a chunk (fields and trees keep out of towns). */
export function townMask(info) {
  const towns = townsIn(info.r, info.ax0, info.ay0, info.ax1, info.ay1);
  if (!towns.length) return null;
  return (x, y, pad = 0) => {
    for (const t of towns) { const dx = x - t.x, dy = y - t.y, rr = t.r * 1.04 + pad; if (dx * dx + dy * dy < rr * rr) return true; }
    return false;
  };
}
/** Signature of the town footprints over a box (so a growing town re-masks its chunk). */
export function townSig(r, x0, y0, x1, y1) {
  let h = 17;
  for (const t of townsIn(r, x0, y0, x1, y1)) { h = mix(h, t.id); h = mix(h, Math.round(t.r * 40)); }
  return h;
}

// ---------------------------------------------------------------------------
// Ground marks: hills, dunes, tufts, reeds, lichen, scree

function paintMarks(g, info) {
  const { world: w, k, P, ax0, ay0, ax1, ay1, px, py, full, seed } = info;
  const f = w.f, W = w.W, H = w.H, el = f.elevation, wa = f.water, bi = f.biome;
  const Lv = info.terr.Lv;
  const arches = [], hach = [], hachDark = [], strokes = [[], [], [], [], []];
  const hillP = [0.34, 0.5, 1, 1, 1][k];
  const nHach = [0, 0, 3, 5, 8][k];
  const markN = [0.125, 0.45, 1.1, 2.2, 4][k];
  const wx = f.windX, wy = f.windY;
  for (let y = ay0; y <= ay1; y++) {
    for (let x = ax0; x <= ax1; x++) {
      const i = y * W + x;
      if (wa[i] !== WATER.LAND) continue;
      const e = el[i];
      if (e > PEAK_MIN) continue;
      const h = hash2i(x, y, 4242 ^ seed);
      if (e > HILL_MIN) {
        if (k <= 1) {
          if (hashF(h, 20) < hillP) arches.push(px(x + (hashF(h, 0) - 0.5) * 0.4), py(y + (hashF(h, 8) - 0.5) * 0.3), P * Math.min(0.5, 0.26 + (e - HILL_MIN) * 2.4) * (k ? 0.82 : 1));
        } else {
          // hachures: short strokes down the fall line, darker on the shaded (south-east) flanks
          let hh = h;
          for (let q = 0; q < nHach; q++) {
            hh = Math.imul(hh ^ (hh >>> 13), 0x5bd1e995) >>> 0;
            const sx = x + ((q % 3) + hashF(hh, 0)) / 3 - 0.5, sy = y + (((q / 3) | 0) % 3 + hashF(hh, 8)) / 3 - 0.5;
            const gx = bil(el, W, H, sx + 0.35, sy) - bil(el, W, H, sx - 0.35, sy);
            const gy = bil(el, W, H, sx, sy + 0.35) - bil(el, W, H, sx, sy - 0.35);
            const sl = Math.hypot(gx, gy);
            if (sl < 0.004 || bil(Lv, W, H, sx, sy) < 0.03) continue;
            const L = Math.min(0.3, 0.06 + sl * 4) * (0.8 + hashF(hh, 16) * 0.4);
            const ux = -gx / sl, uy = -gy / sl;          // downhill
            const arr = gx + gy > 0 ? hachDark : hach;    // faces away from the north-west light
            arr.push(px(sx), py(sy), px(sx + ux * L), py(sy + uy * L));
          }
        }
      }
      if (!full) continue;
      const b = bi[i];
      const kind = b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT ? 0 : b === BIOME.STEPPE || b === BIOME.SAVANNA ? 1 : b === BIOME.WETLAND ? 2 : b === BIOME.TUNDRA ? 3 : b === BIOME.ALPINE ? 4 : -1;
      if (kind < 0) continue;
      if (kind === 1 && f.farm[i] > 0.25) continue;
      let cnt = markN * (kind === 3 || kind === 4 ? 1.4 : 1);
      let hh = h;
      for (let q = 0; cnt > 0; q++, cnt--) {
        hh = Math.imul(hh ^ (hh >>> 15), 0x2c1b3c6d) >>> 0;
        if (cnt < 1 && hashF(hh, 24) > cnt) break;
        const sx = x + (hashF(hh, 0) - 0.5) * 0.9, sy = y + (hashF(hh, 8) - 0.5) * 0.9;
        if (bil(Lv, W, H, sx, sy) < 0.03) continue;
        // dunes lie across the wind
        const ang = kind === 0 ? Math.atan2(wy[i] || 0, wx[i] || 1) + Math.PI / 2 : 0;
        strokes[kind].push(px(sx), py(sy), ang, hashF(hh, 16));
      }
    }
  }
  const lw = Math.max(0.8, P * 0.03);
  g.lineCap = 'round';
  // small marks first (beneath the hills)
  const MARK_COL = ['rgba(150,112,62,0.5)', 'rgba(96,92,46,0.45)', 'rgba(52,86,90,0.55)', 'rgba(110,114,96,0.42)', 'rgba(96,90,84,0.45)'];
  for (let kind = 0; kind < 5; kind++) {
    const s = strokes[kind];
    if (!s.length) continue;
    g.strokeStyle = MARK_COL[kind]; g.lineWidth = kind >= 3 ? lw * 1.2 : lw;
    g.beginPath();
    const z = P * (k >= 3 ? 0.55 : 1);
    for (let q = 0; q < s.length; q += 4) {
      const x = s[q], y = s[q + 1], a = s[q + 2], j = s[q + 3];
      if (kind === 0) {
        const c = Math.cos(a), sn = Math.sin(a), L = z * (0.24 + j * 0.12), B = z * 0.14;
        g.moveTo(x - c * L, y - sn * L); g.quadraticCurveTo(x + sn * B, y - c * B, x + c * L, y + sn * L);
      } else if (kind === 1) {
        const gg = z * (0.1 + j * 0.05);
        g.moveTo(x - gg * 0.5, y); g.lineTo(x - gg * 0.8, y - gg); g.moveTo(x, y); g.lineTo(x, y - gg * 1.2); g.moveTo(x + gg * 0.5, y); g.lineTo(x + gg * 0.8, y - gg);
      } else if (kind === 2) {
        g.moveTo(x - z * 0.2, y); g.lineTo(x + z * 0.2, y); g.moveTo(x - z * 0.08, y); g.lineTo(x - z * 0.1, y - z * 0.15); g.moveTo(x + z * 0.06, y); g.lineTo(x + z * 0.08, y - z * 0.17);
      } else {
        const d = z * (0.025 + j * 0.02);
        g.moveTo(x, y); g.lineTo(x + d, y + d * 0.3);
        g.moveTo(x + z * 0.08, y + z * 0.05); g.lineTo(x + z * 0.08 + d * 0.8, y + z * 0.05);
      }
    }
    g.stroke();
  }
  if (arches.length) {
    // hill symbols: a low open arch with a few shading strokes on its south-east flank
    g.strokeStyle = 'rgba(84,62,40,0.55)'; g.lineWidth = Math.max(0.8, P * 0.035);
    g.beginPath();
    for (let q = 0; q < arches.length; q += 3) {
      const x = arches[q], y = arches[q + 1], hw = arches[q + 2];
      g.moveTo(x - hw, y);
      g.bezierCurveTo(x - hw * 0.55, y - hw * 0.62, x + hw * 0.35, y - hw * 0.66, x + hw, y);
    }
    g.stroke();
    g.strokeStyle = 'rgba(84,62,40,0.32)'; g.lineWidth = Math.max(0.6, P * 0.025);
    g.beginPath();
    for (let q = 0; q < arches.length; q += 3) {
      const x = arches[q], y = arches[q + 1], hw = arches[q + 2];
      for (let j = 1; j <= 3; j++) {
        const t = 0.2 + j * 0.2;
        const ax = x - hw + hw * 2 * t, ay = y - hw * 0.5 * Math.sin(Math.PI * t) - hw * 0.04;
        g.moveTo(ax, ay + hw * 0.08); g.lineTo(ax + hw * 0.1, ay + hw * 0.36);
      }
    }
    g.stroke();
  }
  if (hach.length || hachDark.length) {
    for (const [arr, col, wd] of [[hach, 'rgba(96,72,48,0.32)', 0.9], [hachDark, 'rgba(70,50,34,0.5)', 1.15]]) {
      if (!arr.length) continue;
      g.strokeStyle = col; g.lineWidth = Math.max(0.7, P * 0.012) * wd;
      g.beginPath();
      for (let q = 0; q < arr.length; q += 4) { g.moveTo(arr[q], arr[q + 1]); g.lineTo(arr[q + 2], arr[q + 3]); }
      g.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// Peaks and trees (one depth-sorted pass)

function paintFlora(g, info) {
  const { world: w, k, P, ax0, ay0, ax1, ay1, px, py, full, sprites, seed } = info;
  const f = w.f, W = w.W, H = w.H, el = f.elevation, wa = f.water, sn = f.snow;
  const terr = info.terr, Lv = terr.Lv;
  const items = [];   // [baseY, x, sprite, ox, oy]
  const push = (by, bx, sp, dx, dy) => items.push(by, bx, sp, dx, dy);

  // --- peaks
  const cs = PEAK_CELL[k];
  if (cs >= 1) {
    const bx0 = Math.floor(ax0 / cs) - 1, bx1 = Math.floor(ax1 / cs) + 1, by0 = Math.floor(ay0 / cs) - 1, by1 = Math.floor(ay1 / cs) + 1;
    const gw = bx1 - bx0 + 1, gh = by1 - by0 + 1;
    const cellBest = new Int32Array(gw * gh).fill(-1), cellE = new Float32Array(gw * gh);
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        let best = -1, be = PEAK_MIN;
        for (let yy = by * cs; yy < by * cs + cs; yy++) {
          if (yy < 0 || yy >= H) continue;
          for (let xx = bx * cs; xx < bx * cs + cs; xx++) {
            if (xx < 0 || xx >= W) continue;
            const i = yy * W + xx;
            if (wa[i] === WATER.LAND && el[i] > be) { be = el[i]; best = i; }
          }
        }
        const gi = (by - by0) * gw + (bx - bx0);
        cellBest[gi] = best; cellE[gi] = best >= 0 ? be : 0;
      }
    }
    for (let gy = 1; gy < gh - 1; gy++) {
      for (let gx = 1; gx < gw - 1; gx++) {
        const gi = gy * gw + gx, best = cellBest[gi];
        if (best < 0) continue;
        const be = cellE[gi];
        const major = be >= cellE[gi - 1] && be >= cellE[gi + 1] && be >= cellE[gi - gw] && be >= cellE[gi + gw];
        const x = best % W, y = (best / W) | 0;
        const h = hash2i(x, y, 911 ^ seed);
        if (!major && ((h >>> 12) & 3) === 0) continue;
        const kk = Math.min(1, (be - PEAK_MIN) / (1 - PEAK_MIN));
        const scale = major ? 1.2 + kk * 0.35 : 0.72;
        const pw = qpx(P * cs * (0.42 + kk * 0.3) * scale * (0.88 + ((h >>> 24) & 15) / 60), 5);
        const pht = pw * peakRatio(major ? 1.0 + kk * 0.7 : 0.8 + kk * 0.4);
        const jx = (hashF(h, 0) - 0.5) * cs * 0.4, jy = (hashF(h, 8) - 0.5) * cs * 0.3;
        const snow = Math.max(sn[best], be > 0.86 ? 0.75 : 0);
        const sp = peakSprite(sprites, pw, pht, 1, snow, h >>> 16);
        const sx = px(x + jx), sy = py(y + jy) + P * 0.3;
        push(sy, sx, sp, sx - sp.ox, sy - sp.oy);
      }
    }
  } else {
    // close up: several crags per high tile at sub-tile points, the tile's crown the tallest
    for (let y = ay0 - 1; y <= ay1 + 1; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = ax0 - 1; x <= ax1 + 1; x++) {
        if (x < 0 || x >= W) continue;
        const i = y * W + x;
        if (wa[i] !== WATER.LAND || el[i] < PEAK_MIN - 0.015) continue;
        const h0 = hash2i(x, y, 917 ^ seed);
        let hh = h0;
        for (let q = 0; q < 4; q++) {
          hh = Math.imul(hh ^ (hh >>> 13), 0x5bd1e995) >>> 0;
          const sx = x + ((q & 1) + 0.15 + hashF(hh, 0) * 0.7) / 2 - 0.5, sy = y + ((q >> 1) + 0.15 + hashF(hh, 8) * 0.7) / 2 - 0.5;
          const e = bil(el, W, H, sx, sy);
          if (e < PEAK_MIN || bil(Lv, W, H, sx, sy) < 0.03) continue;
          const kk = Math.min(1, (e - PEAK_MIN) / (1 - PEAK_MIN));
          const pw = qpx(P * (0.2 + kk * 0.2) * (0.85 + hashF(hh, 16) * 0.35), 5);
          const pht = pw * peakRatio(0.95 + kk * 0.8);
          const snow = Math.max(bil(sn, W, H, sx, sy), e > 0.86 ? 0.75 : 0);
          const sp = peakSprite(sprites, pw, pht, 1, snow, hh >>> 20);
          const bx = px(sx), by = py(sy) + P * 0.12;
          push(by, bx, sp, bx - sp.ox, by - sp.oy);
        }
      }
    }
  }

  // --- trees
  if (full) {
    const towns = townMask(info);
    const lat0 = (y) => 1 - (2 * (y + 0.5)) / H;
    const tmax = TREE_MAX[k], tsz = TREE_SIZE[k];
    const vegS = terr.sm.veg || f.veg;
    const grid = Math.ceil(Math.sqrt(tmax * 1.3));
    const cells = grid * grid;
    for (let y = ay0; y <= ay1; y++) {
      const lat = lat0(y);
      const season = leafSeason(info.localPhase(y), lat);
      for (let x = ax0; x <= ax1; x++) {
        const i = y * W + x;
        if (wa[i] !== WATER.LAND) continue;
        if (el[i] > PEAK_MIN) continue;
        const b = f.biome[i];
        let kind = TREE_FOR[b];
        const dens = TREE_DENSITY[b] || 0;
        if (!kind || dens <= 0) continue;
        const farm = f.farm[i];
        const vv = terr.vegMissing ? 0.7 : Math.min(1, vegS[i] / 0.8);
        const burnt = f.burnScar[i] > 0.25 && dens >= 0.8;
        const clear = 1 - Math.min(1, Math.max(0, (farm - 0.08) * (k >= 1 ? 2.6 : 1.4)));
        const h = hash2i(x, y, 4243 ^ seed ^ (k << 20));
        let cnt = Math.floor(tmax * dens * vv * clear * 1.15 + hashF(h, 20, 4) - 0.2);
        if (burnt) cnt = Math.max(cnt, Math.round(tmax * 0.35));
        if (cnt <= 0) continue;
        if (cnt > cells) cnt = cells;
        const snowy = sn[i] > 0.3;
        const deciduous = kind === 'broadleaf' && b === BIOME.TEMPERATE_FOREST;
        const sea2 = deciduous ? season : 0;
        // candidate cells in a fixed hashed order: as a stand thins or thickens, the
        // surviving trees stay where they were
        const start = h % cells, step = [1, 3, 5, 7][(h >>> 8) & 3];
        let hh = h;
        for (let t = 0; t < cnt; t++) {
          const cell = (start + t * (step % cells === 0 ? 1 : step)) % cells;
          hh = Math.imul(hh ^ (hh >>> 13), 0x5bd1e995) >>> 0;
          const ox = ((cell % grid) + 0.2 + hashF(hh, 0) * 0.6) / grid - 0.5;
          const oy = (((cell / grid) | 0) + 0.2 + hashF(hh, 10) * 0.6) / grid - 0.5;
          const tx = x + ox * 0.96, ty = y + oy * 0.96;
          if (bil(Lv, W, H, tx, ty) < 0.03) continue;
          if (towns && towns(tx, ty, tsz * 0.3)) continue;
          let tk = kind;
          if (burnt) tk = 'bare';
          else if (kind === 'broadleaf' && b === BIOME.TROPICAL_FOREST && (hh >>> 28) > 10) tk = 'palm';
          else if (b === BIOME.TEMPERATE_RAINFOREST && (hh >>> 28) > 9) tk = 'rain';
          const size = qpx(P * tsz * (tk === 'shrub' ? 0.65 : 1) * (0.82 + hashF(hh, 22, 4) * 0.3), 6);
          const sp = treeSprite(sprites, tk, size, 1, sea2, snowy, hh >>> 30);
          const bx = px(tx), by = py(ty) + size * 0.45;
          push(by, bx, sp, bx - sp.ox, by - sp.oy);
        }
      }
    }
  }

  // depth sort (ties by x, so neighbouring chunks agree on overlaps)
  const n = items.length / 5;
  const order = new Int32Array(n);
  for (let q = 0; q < n; q++) order[q] = q;
  order.sort((a, b) => items[a * 5] - items[b * 5] || items[a * 5 + 1] - items[b * 5 + 1]);
  for (let q = 0; q < n; q++) {
    const o = order[q] * 5;
    const sp = items[o + 2];
    g.drawImage(sp.canvas, items[o + 3], items[o + 4], sp.w, sp.h);
  }
}

// ---------------------------------------------------------------------------
// Shores: a crisp coastline up close. The raster's land/sea boundary is 8 px per tile, so at
// close zoom the coast melts into a tile-wide blur; this paints, in a band either side of the
// coast, the sea's colour on the sea side and the land's on the land side of the very contour
// the coast ink follows (marching squares on the land field, 3 cells per tile), fading out a
// tile or two inland and offshore.

const SHORE_S = 3;
function paintShore(g, info) {
  const { world: w, ax0, ay0, ax1, ay1, px, py, P } = info;
  const f = w.f, W = w.W, H = w.H, wa = f.water, terr = info.terr;
  const Lv = terr.Lv, tR = terr.tR, tG = terr.tG, tB = terr.tB, wR = terr.wR, wG = terr.wG, wB = terr.wB, sh = terr.shade, shore = terr.shoreT;
  if (!hasCoast(info)) return;
  // colour images, one pixel per tile (+1 ring), each side extrapolated across the coast so the
  // smooth upscale never mixes land into sea; alpha fades with distance from the coast
  const iw = ax1 - ax0 + 3, ih = ay1 - ay0 + 3;
  const mk = (n) => { let c = paintShore['c' + n]; if (!c || c.width < iw || c.height < ih) { c = paintShore['c' + n] = makeCanvas(Math.max(iw, 16), Math.max(ih, 16)); paintShore['g' + n] = c.getContext('2d', { willReadFrequently: true }); } return [c, paintShore['g' + n]]; };
  const [cl, gl] = mk(0), [cs, gs] = mk(1);
  const il = gl.createImageData(iw, ih), is = gs.createImageData(iw, ih);
  const dl = il.data, ds = is.data;
  const near = (x, y, land) => {   // nearest-ring distance to the other surface, 0..2
    for (let r = 1; r <= 2; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if ((wa[yy * W + xx] === WATER.LAND) !== land) return r;
    }
    return 3;
  };
  for (let yy = 0; yy < ih; yy++) {
    const y = clampI(ay0 - 1 + yy, 0, H - 1);
    for (let xx = 0; xx < iw; xx++) {
      const x = clampI(ax0 - 1 + xx, 0, W - 1);
      const i = y * W + x, o = (yy * iw + xx) * 4;
      const land = wa[i] === WATER.LAND;
      const dd = near(x, y, land);
      const a = dd <= 1 ? 255 : dd === 2 ? 110 : 0;
      // land colour here (own or the land neighbours')
      let lr = 0, lg = 0, lb = 0, ln = 0, sr = 0, sg = 0, sb = 0, sn = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x2 = x + dx, y2 = y + dy;
        if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
        const j = y2 * W + x2, wgt = dx === 0 && dy === 0 ? 4 : 1;
        if (wa[j] === WATER.LAND) { const m = Math.max(0.7, Math.min(1.3, 1 + (sh[j] - 1) * 1.1)); lr += tR[j] * m * wgt; lg += tG[j] * m * wgt; lb += tB[j] * m * wgt; ln += wgt; }
        else { const k1 = shore[j] * shore[j] * 0.34; sr += (wR[j] + (150 - wR[j]) * k1) * wgt; sg += (wG[j] + (198 - wG[j]) * k1) * wgt; sb += (wB[j] + (192 - wB[j]) * k1) * wgt; sn += wgt; }
      }
      if (ln) { dl[o] = lr / ln; dl[o + 1] = lg / ln; dl[o + 2] = lb / ln; dl[o + 3] = a; }
      if (sn) { ds[o] = sr / sn; ds[o + 1] = sg / sn; ds[o + 2] = sb / sn; ds[o + 3] = a; }
    }
  }
  gl.clearRect(0, 0, cl.width, cl.height); gl.putImageData(il, 0, 0);
  gs.clearRect(0, 0, cs.width, cs.height); gs.putImageData(is, 0, 0);
  // the two sides of the contour
  const { land: landP, sea: seaP } = shorePaths(info);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'low';
  const dx = px(ax0 - 1) - P / 2, dy = py(ay0 - 1) - P / 2;
  g.save(); g.clip(seaP); g.drawImage(cs, 0, 0, iw, ih, dx, dy, iw * P, ih * P); g.restore();
  // the land side only on the natural atlas (thematic maps keep their wash on the land)
  if (info.full) { g.save(); g.clip(landP); g.drawImage(cl, 0, 0, iw, ih, dx, dy, iw * P, ih * P); g.restore(); }
}
const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Does the chunk's aproned box hold any coast? */
export function hasCoast(info) {
  const { world: w, ax0, ay0, ax1, ay1 } = info;
  const W = w.W, H = w.H, wa = w.f.water;
  for (let y = Math.max(0, ay0 - 1); y <= Math.min(H - 1, ay1 + 1); y++) {
    let prev = -1;
    for (let x = Math.max(0, ax0 - 1); x <= Math.min(W - 1, ax1 + 1); x++) {
      const l = wa[y * W + x] === WATER.LAND ? 1 : 0;
      if (prev >= 0 && l !== prev) return true;
      if (y > 0 && (wa[(y - 1) * W + x] === WATER.LAND ? 1 : 0) !== l) return true;
      prev = l;
    }
  }
  return false;
}

/**
 * The land and sea sides of the coast over a chunk's aproned box, as chunk-px paths: the
 * contour of the land field the coast ink follows (marching squares, 3 cells per tile).
 */
export function shorePaths(info) {
  const { world: w, ax0, ay0, ax1, ay1, px, py, P } = info;
  const W = w.W, H = w.H, Lv = info.terr.Lv;
  const land = new Path2D(), sea = new Path2D();
  const S = SHORE_S, v = new Float32Array((S + 1) * (S + 1));
  for (let cy = Math.max(0, ay0 - 1); cy <= Math.min(H - 2, ay1); cy++) {
    for (let cx = Math.max(0, ax0 - 1); cx <= Math.min(W - 2, ax1); cx++) {
      const i = cy * W + cx;
      const v00 = Lv[i], v10 = Lv[i + 1], v01 = Lv[i + W], v11 = Lv[i + W + 1];
      if (v00 >= 0 && v10 >= 0 && v01 >= 0 && v11 >= 0) { land.rect(px(cx), py(cy), P, P); continue; }
      if (v00 < 0 && v10 < 0 && v01 < 0 && v11 < 0) { sea.rect(px(cx), py(cy), P, P); continue; }
      for (let sy = 0; sy <= S; sy++) for (let sx = 0; sx <= S; sx++) { const fx = sx / S, fy = sy / S; v[sy * (S + 1) + sx] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy; }
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const c = [v[sy * (S + 1) + sx], v[sy * (S + 1) + sx + 1], v[(sy + 1) * (S + 1) + sx + 1], v[(sy + 1) * (S + 1) + sx]];
        const X = [cx + sx / S, cx + (sx + 1) / S, cx + (sx + 1) / S, cx + sx / S], Y = [cy + sy / S, cy + sy / S, cy + (sy + 1) / S, cy + (sy + 1) / S];
        cellPoly(land, c, X, Y, true, px, py);
        cellPoly(sea, c, X, Y, false, px, py);
      }
    }
  }
  return { land, sea };
}
/** Append the part of a marching-squares cell on one side of the zero contour. */
function cellPoly(path, c, X, Y, landSide, px, py) {
  const inside = (v) => (landSide ? v >= 0 : v < 0);
  const pts = [];
  for (let k = 0; k < 4; k++) {
    const a = c[k], b = c[(k + 1) & 3];
    if (inside(a)) pts.push(X[k], Y[k]);
    if (inside(a) !== inside(b)) {
      const t = Math.abs(b - a) < 1e-12 ? 0.5 : a / (a - b);
      pts.push(X[k] + (X[(k + 1) & 3] - X[k]) * t, Y[k] + (Y[(k + 1) & 3] - Y[k]) * t);
    }
  }
  if (pts.length < 6) return;
  path.moveTo(px(pts[0]), py(pts[1]));
  for (let q = 2; q < pts.length; q += 2) path.lineTo(px(pts[q]), py(pts[q + 1]));
  path.closePath();
}

registerPainter('shore', 2, paintShore, { order: 5, apron: 2 });
registerPainter('marks', 0, paintMarks, { order: 20, apron: 1 });
registerPainter('flora', 0, paintFlora, { order: 60, apron: [3, 2, 2, 1, 1], sig: (w, x0, y0, x1, y1, k, r) => townSig(r, x0, y0, x1, y1) });
