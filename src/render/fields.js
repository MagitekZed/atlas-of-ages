// Field systems: farmland at close zoom as a continuous tessellation of parcels instead of
// the raster's patchwork. Each 4 × 4-tile block has one lattice (an orientation from smooth
// hash noise, turned to follow the contours on slopes, and an origin); every farm tile draws
// the lattice cells that meet it, clipped to its own square, so parcels run on across tile
// edges and two systems meet along a clean field boundary. Cells are kept or dropped by the
// tile's farm intensity, so a frontier breaks up into scattered clearings, and never cross the
// coast or a town's footprint.
//
// The parcels show climate, people and age: rice paddies with their bunds in the wet tropics,
// vineyard and olive rows on dry shrubland, millet and maize on the savanna, date-palm oases in
// the desert, contour terraces on hills; small irregular plots in early ages, long open-field
// strips in classical and medieval temperate lands, hedged or stone-walled enclosures from the
// medieval to the industrial age, wide consolidated rectangles in the modern age. Colours follow
// the crop calendar of the chunk's season bucket; snow whitens them; worn-out soil lies fallow.
// Farmsteads dot the busiest country. Painted into the LOD chunks (./lod.js) from level 1.

import { BIOME, WATER } from '../core/constants.js';
import { hash2i } from '../core/rng.js';
import { cropColors, makeCanvas } from './terrain.js';
import { registerPainter } from './lod.js';
import { bil, townMask, townSig, hasCoast, shorePaths } from './detail.js';

const GRAIN = 0, PASTURE = 1, FALLOW = 2, RICE = 3, VINE = 4, MILLET = 5, ORCHARD = 6, OASIS = 7;
const BLOCK = 5;
// sub-parcels per base parcel by level (along, across)
const SUB_U = [1, 1, 2, 2, 3];
const SUB_V = [1, 1, 1, 2, 2];

const hf = (h, s, bits = 8) => ((h >>> s) & ((1 << bits) - 1)) / ((1 << bits) - 1);

/** The dominant crop a tile's climate favours. */
function cropClass(f, i, b) {
  const t = f.annTemp[i], r = f.annRain[i];
  if ((t > 18 && r > 0.55) || (b === BIOME.WETLAND && t > 14)) return RICE;
  if (b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT) return f.river[i] > 0 || f.distCoast[i] <= 1 ? OASIS : MILLET;
  if (b === BIOME.SAVANNA || (b === BIOME.TROPICAL_FOREST && r < 0.5)) return MILLET;
  if (b === BIOME.SHRUBLAND && t > 11 && r < 0.5) return VINE;
  return GRAIN;
}

/** Parcel shape for an age and climate: a (across), b (along) in tiles, vertex jitter, boundary kind. */
function systemFor(era, crop, f, i, hill) {
  if (hill) return { a: 0.07, b: 0.42, jit: 0.012, hedge: 0, terrace: true };
  if (crop === RICE) return { a: 0.1, b: 0.13, jit: 0.018, hedge: 0 };
  if (crop === OASIS) return { a: 0.09, b: 0.11, jit: 0.03, hedge: 0 };
  const t = f.annTemp[i], r = f.annRain[i];
  const temperate = t > 2 && t < 18;
  if (era >= 7) return { a: 0.28, b: 0.4, jit: 0.012, hedge: 0 };
  if (era >= 4 && temperate && (r > 0.38 || f.elevation[i] > 0.58 || t < 7)) return { a: 0.17, b: 0.23, jit: 0.022, hedge: r > 0.38 && f.elevation[i] <= 0.58 && t >= 7 ? 1 : 2 };
  if (era >= 3 && temperate) return { a: 0.07, b: 0.3, jit: 0.01, hedge: 0 };
  return { a: 0.15, b: 0.19, jit: 0.024, hedge: 0 };
}

/** Sutherland–Hodgman clip of polygon pts (flat [x, y, …]) against an axis-aligned box. */
function clipBox(pts, x0, y0, x1, y1) {
  let p = pts;
  const edge = (inside, cross) => {
    const out = [];
    const n = p.length / 2;
    for (let k = 0; k < n; k++) {
      const ax = p[k * 2], ay = p[k * 2 + 1], bx = p[((k + 1) % n) * 2], by = p[((k + 1) % n) * 2 + 1];
      const ia = inside(ax, ay), ib = inside(bx, by);
      if (ia) out.push(ax, ay);
      if (ia !== ib) { const c = cross(ax, ay, bx, by); out.push(c[0], c[1]); }
    }
    p = out;
  };
  edge((x) => x >= x0, (ax, ay, bx, by) => [x0, ay + (by - ay) * (x0 - ax) / (bx - ax)]);
  if (p.length < 6) return null;
  edge((x) => x <= x1, (ax, ay, bx, by) => [x1, ay + (by - ay) * (x1 - ax) / (bx - ax)]);
  if (p.length < 6) return null;
  edge((x, y) => y >= y0, (ax, ay, bx, by) => [ax + (bx - ax) * (y0 - ay) / (by - ay), y0]);
  if (p.length < 6) return null;
  edge((x, y) => y <= y1, (ax, ay, bx, by) => [ax + (bx - ax) * (y1 - ay) / (by - ay), y1]);
  return p.length >= 6 ? p : null;
}

/** Liang–Barsky clip of segment (x0, y0)–(x1, y1) to a box; [x0, y0, x1, y1] or null. */
function clipSeg(ax, ay, bx, by, x0, y0, x1, y1) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy], q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) { if (q[k] < 0) return null; continue; }
    const r = q[k] / p[k];
    if (p[k] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
}

/**
 * The land between the parcels: the terrain's own colours without its farm patchwork, one
 * pixel per tile with coverage by farm intensity, upscaled smoothly into the chunk so it fades
 * out across the farm frontier (the raster's coarse patchwork would show through otherwise).
 */
function paintUnderlay(g, info) {
  const { world: w, ax0, ay0, ax1, ay1, px, py, P } = info;
  const f = w.f, W = w.W, terr = info.terr;
  const tR = terr.tR, tG = terr.tG, tB = terr.tB, sh = terr.shade;
  const iw = ax1 - ax0 + 3, ih = ay1 - ay0 + 3;
  if (!paintUnderlay.c || paintUnderlay.c.width < iw || paintUnderlay.c.height < ih) {
    paintUnderlay.c = makeCanvas(Math.max(iw, 24), Math.max(ih, 24));
    paintUnderlay.g = paintUnderlay.c.getContext('2d', { willReadFrequently: true });
  }
  const c = paintUnderlay.c, cg = paintUnderlay.g;
  const img = cg.createImageData(iw, ih);
  const d = img.data;
  let any = false;
  for (let yy = 0; yy < ih; yy++) {
    const y = Math.max(0, Math.min(w.H - 1, ay0 - 1 + yy));
    for (let xx = 0; xx < iw; xx++) {
      const x = Math.max(0, Math.min(W - 1, ax0 - 1 + xx));
      const i = y * W + x;
      if (f.water[i] !== WATER.LAND) continue;
      const fa = f.farm[i];
      if (fa < 0.04) continue;
      const m = Math.max(0.6, Math.min(1.4, 1 + (sh[i] - 1) * 1.1));
      const sn = f.snow[i] > 0.15 ? Math.min(1, f.snow[i] * 1.4) : 0;
      const o = (yy * iw + xx) * 4;
      d[o] = (tR[i] * m) + (240 - tR[i] * m) * sn; d[o + 1] = (tG[i] * m) + (244 - tG[i] * m) * sn; d[o + 2] = (tB[i] * m) + (248 - tB[i] * m) * sn;
      d[o + 3] = Math.min(255, Math.max(0, (fa - 0.04) / 0.22) * 255);
      any = true;
    }
  }
  if (!any) return;
  cg.clearRect(0, 0, c.width, c.height);
  cg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'low';
  // pixel (xx, yy) is centred on tile (ax0 − 1 + xx, ay0 − 1 + yy)
  g.drawImage(c, 0, 0, iw, ih, px(ax0 - 1) - P / 2, py(ay0 - 1) - P / 2, iw * P, ih * P);
}

/**
 * Field blocks are the cells of a jittered Voronoi diagram over tiles (one seed point per
 * BLOCK × BLOCK cell, displaced by up to ±40 %), so the headlands between field systems wander
 * across the land instead of ruling it into a grid. Returns the owning cell packed as cx·4096 + cy.
 */
function blockOf(x, y, seed) {
  const cx = Math.floor(x / BLOCK), cy = Math.floor(y / BLOCK);
  let best = 0, bd = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const gx = cx + dx, gy = cy + dy;
    const h = hash2i(gx, gy, 5111 ^ seed);
    const px = (gx + 0.1 + 0.8 * ((h & 1023) / 1023)) * BLOCK, py = (gy + 0.1 + 0.8 * (((h >>> 10) & 1023) / 1023)) * BLOCK;
    const d = (x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2;
    if (d < bd) { bd = d; best = (gx + 2048) * 4096 + (gy + 2048); }
  }
  return best;
}

/** Smooth orientation (radians, mod π) from a hashed lattice of doubled-angle vectors. */
function blockAngle(bx, by, seed) {
  const C = 3;
  const gx = Math.floor(bx / C), gy = Math.floor(by / C), fx = (bx % C) / C, fy = (by % C) / C;
  let cx = 0, cy = 0;
  for (let q = 0; q < 4; q++) {
    const ox = q & 1, oy = q >> 1;
    const a = hash2i(gx + ox, gy + oy, 5051 ^ seed) / 4294967296 * Math.PI * 2;
    const wgt = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
    cx += Math.cos(a) * wgt; cy += Math.sin(a) * wgt;
  }
  return Math.atan2(cy, cx) / 2 + (hash2i(bx, by, 5059 ^ seed) / 4294967296 - 0.5) * 0.22;
}

function paintFields(g, info) {
  const { world: w, k, P, ax0, ay0, ax1, ay1, px, py, seed } = info;
  const f = w.f, W = w.W, H = w.H;
  const Lv = info.terr.Lv, el = f.elevation, wa = f.water, fm = f.farm;
  const towns = townMask(info);
  const civs = w.civs;
  const fills = new Map();          // colour → Path2D
  const lanes = [];
  const edges = new Path2D(), hedges = [new Path2D(), new Path2D(), new Path2D()], furrows = new Path2D(), dots = [];
  let nEdges = 0, nHedge = 0, nFur = 0;
  const crop = new Float32Array(9);
  const cellPts = new Array(8);
  // farmland stops at the water's edge
  if (hasCoast(info)) g.clip(shorePaths(info).land);
  paintUnderlay(g, info);
  for (let y = ay0; y <= ay1; y++) {
    const lat = 1 - (2 * (y + 0.5)) / H;
    cropColors(w, lat, info.localPhase(y), crop);
    for (let x = ax0; x <= ax1; x++) {
      const i = y * W + x;
      if (wa[i] !== WATER.LAND) continue;
      // tiles beside farmland draw too: parcels near their edge follow the smooth farm field
      let F0 = fm[i];
      if (F0 < 0.06) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && fm[yy * W + xx] > F0) F0 = fm[yy * W + xx];
        }
        if (F0 < 0.12) continue;
      }
      const b = f.biome[i];
      const o = f.owner[i];
      const era = o >= 0 && civs[o] ? (civs[o].tech?.era | 0) : 0;
      const cls = cropClass(f, i, b);
      const hill = el[i] > 0.62 && cls !== RICE && cls !== OASIS;
      const sys = systemFor(era, cls, f, i, hill);
      // the lattice of this tile's block (shared by the block's tiles: seamless inside it);
      // block edges step every couple of rows / columns so headlands do not run dead straight
      const blk = blockOf(x, y, seed);
      const bx = Math.floor(blk / 4096) - 2048, by = (blk % 4096) - 2048;
      // a lane along the headland where two field systems meet
      if (k >= 2) {
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx >= W || yy >= H || wa[yy * W + xx] !== WATER.LAND || fm[yy * W + xx] < 0.12 || F0 < 0.12) continue;
          if (blockOf(xx, yy, seed) === blk) continue;
          if (dx) lanes.push(px(x + 0.5), py(y - 0.5), px(x + 0.5), py(y + 0.5));
          else lanes.push(px(x - 0.5), py(y + 0.5), px(x + 0.5), py(y + 0.5));
        }
      }
      let th = blockAngle(bx, by, seed);
      if (sys.terrace) {
        // terraces follow the contours
        const gx = bil(el, W, H, x + 0.5, y) - bil(el, W, H, x - 0.5, y), gy = bil(el, W, H, x, y + 0.5) - bil(el, W, H, x, y - 0.5);
        if (Math.abs(gx) + Math.abs(gy) > 1e-5) th = Math.atan2(gy, gx) + Math.PI / 2;
      }
      const ca = Math.cos(th), sa = Math.sin(th);
      const hb = hash2i(bx, by, 5077 ^ seed);
      const ox = bx * BLOCK + hf(hb, 0) * 2, oy = by * BLOCK + hf(hb, 8) * 2;
      const A = sys.a, B = sys.b;
      // lattice range covering the tile square
      const sx0 = x - 0.5, sy0 = y - 0.5, sx1 = x + 0.5, sy1 = y + 0.5;
      let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
      for (const [cx, cy] of [[sx0, sy0], [sx1, sy0], [sx0, sy1], [sx1, sy1]]) {
        const dx = cx - ox, dy = cy - oy;
        const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
        if (u < umin) umin = u; if (u > umax) umax = u; if (v < vmin) vmin = v; if (v > vmax) vmax = v;
      }
      const iu0 = Math.floor(umin / B) - 1, iu1 = Math.floor(umax / B) + 1, iv0 = Math.floor(vmin / A) - 1, iv1 = Math.floor(vmax / A) + 1;
      const vtx = (iu, iv) => {
        const hv = hash2i(iu * 7919 + bx * 131, iv * 104729 + by * 137, 5081 ^ seed);
        const ju = (hf(hv, 0) - 0.5) * 2 * sys.jit, jv = (hf(hv, 8) - 0.5) * 2 * sys.jit;
        const u = iu * B + ju, v = iv * A + jv;
        return [ox + u * ca - v * sa, oy + u * sa + v * ca];
      };
      const snow = f.snow[i];
      const snowK = snow > 0.15 ? Math.min(1, snow * 1.4) : 0;
      const worn = f.soil[i] < 0.16;
      const herb = f.herb[i];
      for (let iu = iu0; iu <= iu1; iu++) {
        for (let iv = iv0; iv <= iv1; iv++) {
          const p00 = vtx(iu, iv), p10 = vtx(iu + 1, iv), p11 = vtx(iu + 1, iv + 1), p01 = vtx(iu, iv + 1);
          const cx = (p00[0] + p10[0] + p11[0] + p01[0]) / 4, cy = (p00[1] + p10[1] + p11[1] + p01[1]) / 4;
          const hc = hash2i(iu * 31 + bx * 977, iv * 37 + by * 983, 5099 ^ seed);
          // neighbouring strips of one furlong share a crop
          const hcrop = hash2i((iu >> 1) * 31 + bx * 977, (iv >> (sys.a < 0.1 ? 2 : 1)) * 37 + by * 983, 5101 ^ seed);
          // farm intensity at the parcel decides whether it is tilled at all
          const F = bil(fm, W, H, cx, cy);
          // (decided mostly per furlong, so thinning farmland breaks into clumps, not confetti)
          if (hf(hcrop, 0, 10) * 0.75 + hf(hc, 0, 10) * 0.25 > F * 1.3) continue;
          if (bil(Lv, W, H, cx, cy) < 0.03) continue;
          if (towns && towns(cx, cy)) continue;
          // closer in, a parcel divides into its holdings (the same lattice, so nothing jumps
          // between levels): strips split along their length, plots into quarters
          const nu = SUB_U[k] * (sys.a < 0.1 ? 2 : 1), nv = sys.a < 0.1 ? 1 : SUB_V[k];
          for (let su = 0; su < nu; su++) for (let sv = 0; sv < nv; sv++) {
            const lerp4 = (tu, tv) => [p00[0] + (p10[0] - p00[0]) * tu + (p01[0] - p00[0]) * tv + (p11[0] - p10[0] - p01[0] + p00[0]) * tu * tv,
              p00[1] + (p10[1] - p00[1]) * tu + (p01[1] - p00[1]) * tv + (p11[1] - p10[1] - p01[1] + p00[1]) * tu * tv];
            const q00 = lerp4(su / nu, sv / nv), q10 = lerp4((su + 1) / nu, sv / nv), q11 = lerp4((su + 1) / nu, (sv + 1) / nv), q01 = lerp4(su / nu, (sv + 1) / nv);
            const hsub = nu * nv > 1 ? hash2i(su + iu * 7, sv + iv * 7, hc) : hc;
            cellPts[0] = q00[0]; cellPts[1] = q00[1]; cellPts[2] = q10[0]; cellPts[3] = q10[1]; cellPts[4] = q11[0]; cellPts[5] = q11[1]; cellPts[6] = q01[0]; cellPts[7] = q01[1];
            const poly = clipBox(cellPts, sx0, sy0, sx1, sy1);
            if (!poly) continue;
            // crop of this parcel: mostly its furlong's, now and then a holding of its own
            let kind = cls;
            const roll = hf(nu * nv > 1 && hf(hsub, 26, 4) < 0.22 ? hsub : hcrop, 12, 8);
            if (cls === GRAIN || cls === MILLET) kind = roll < 0.6 ? cls : roll < 0.78 + Math.min(0.12, herb * 0.2) ? PASTURE : roll < 0.92 ? FALLOW : (b === BIOME.TEMPERATE_FOREST || b === BIOME.STEPPE ? ORCHARD : PASTURE);
            else if (cls === VINE) kind = roll < 0.55 ? VINE : roll < 0.75 ? GRAIN : roll < 0.9 ? ORCHARD : FALLOW;
            else if (cls === RICE) kind = roll < 0.82 ? RICE : roll < 0.94 ? PASTURE : FALLOW;
            else if (cls === OASIS) kind = roll < 0.5 ? OASIS : roll < 0.85 ? GRAIN : FALLOW;
            if (worn && roll > 0.55) kind = FALLOW;
            let R, G, Bc;
            switch (kind) {
              case PASTURE: R = crop[3]; G = crop[4]; Bc = crop[5]; break;
              case FALLOW: R = crop[6]; G = crop[7]; Bc = crop[8]; break;
              case RICE: {
                // paddies: green with the crop, mirror-blue when flooded for planting
                const grow = Math.max(0, Math.min(1, (crop[1] - crop[0]) / 50));
                R = 118 - 22 * grow; G = 150 + 2 * grow; Bc = 128 - 40 * grow; break;
              }
              case VINE: R = 176; G = 152; Bc = 106; break;
              case ORCHARD: R = crop[3] * 0.9; G = crop[4] * 0.92; Bc = crop[5] * 0.85; break;
              case OASIS: R = 160; G = 150; Bc = 98; break;
              case MILLET: R = crop[0] * 1.05; G = crop[1] * 0.98; Bc = crop[2] * 0.82; break;
              default: R = crop[0]; G = crop[1]; Bc = crop[2];
            }
            const jit = 0.93 + hf(hsub, 20, 2) * 0.05 + (sys.terrace ? ((iv & 1) ? -0.03 : 0.02) : 0);
            R *= jit; G *= jit; Bc *= jit;
            if (snowK) { R += (240 - R) * snowK; G += (244 - G) * snowK; Bc += (248 - Bc) * snowK; }
            const key = `${(R / 3) | 0},${(G / 3) | 0},${(Bc / 3) | 0}`;
            let path = fills.get(key);
            if (!path) { path = new Path2D(); fills.set(key, path); path._c = `rgb(${(((R / 3) | 0) * 3)},${(((G / 3) | 0) * 3)},${(((Bc / 3) | 0) * 3)})`; }
            const n = poly.length / 2;
            path.moveTo(px(poly[0]), py(poly[1]));
            for (let q = 1; q < n; q++) path.lineTo(px(poly[q * 2]), py(poly[q * 2 + 1]));
            path.closePath();
            if (k >= 2) {
              // the parcel's own edges (never the tile boundary the clip made)
              for (const [a0, a1] of [[q00, q10], [q10, q11], [q11, q01], [q01, q00]]) {
                const sg = clipSeg(a0[0], a0[1], a1[0], a1[1], sx0, sy0, sx1, sy1);
                if (sg) { edges.moveTo(px(sg[0]), py(sg[1])); edges.lineTo(px(sg[2]), py(sg[3])); }
              }
              nEdges++;
              // hedgerows / dry-stone walls on the parcel's long sides (and every other short one)
              if (sys.hedge && !snowK && su === 0 && sv === 0) {
                const hp = hedges[sys.hedge];
                const e1 = clipSeg(p00[0], p00[1], p10[0], p10[1], sx0, sy0, sx1, sy1);
                if (e1) { hp.moveTo(px(e1[0]), py(e1[1])); hp.lineTo(px(e1[2]), py(e1[3])); }
                if (!(iu & 1)) { const e2 = clipSeg(p00[0], p00[1], p01[0], p01[1], sx0, sy0, sx1, sy1); if (e2) { hp.moveTo(px(e2[0]), py(e2[1])); hp.lineTo(px(e2[2]), py(e2[3])); } }
                nHedge++;
              }
              if (sys.terrace && !snowK) { const e3 = clipSeg(q01[0], q01[1], q11[0], q11[1], sx0, sy0, sx1, sy1); if (e3) { hedges[2].moveTo(px(e3[0]), py(e3[1])); hedges[2].lineTo(px(e3[2]), py(e3[3])); nHedge++; } }
            }
            // furrows, vine rows, orchard and palm dots, livestock
            if (!snowK && k >= 3 && (kind === GRAIN || kind === MILLET || kind === FALLOW)) {
              const rows = Math.max(2, Math.round((A / nv * P) / (k >= 4 ? 7 : 9)));
              for (let q = 1; q < rows; q++) {
                const t = q / rows;
                const ax = q00[0] + (q01[0] - q00[0]) * t, ay = q00[1] + (q01[1] - q00[1]) * t;
                const bx2 = q10[0] + (q11[0] - q10[0]) * t, by2 = q10[1] + (q11[1] - q10[1]) * t;
                const seg = clipSeg(ax, ay, bx2, by2, sx0, sy0, sx1, sy1);
                if (!seg) continue;
                furrows.moveTo(px(seg[0]), py(seg[1])); furrows.lineTo(px(seg[2]), py(seg[3])); nFur++;
              }
            }
            if (!snowK && k >= 2 && (kind === VINE || kind === ORCHARD || kind === OASIS || (kind === PASTURE && k >= 3 && herb > 0.12))) {
              const step = kind === VINE ? Math.max(0.025, 5 / P) : kind === PASTURE ? 0.05 : Math.max(0.035, 7 / P);
              const du = Math.max(1, Math.floor(B / nu / step)), dv = Math.max(1, Math.floor(A / nv / (kind === VINE ? step * 1.6 : step)));
              const lim = kind === PASTURE ? 2 + (hc & 3) : 60;
              let cntd = 0;
              for (let a1 = 0; a1 < du && cntd < lim; a1++) for (let a2 = 0; a2 < dv && cntd < lim; a2++) {
                if (kind === PASTURE && hf(hash2i(a1, a2, hsub), 0) > 0.12) continue;
                const tu = (a1 + 0.5) / du, tv = (a2 + 0.5) / dv;
                const qx = q00[0] + (q10[0] - q00[0]) * tu + (q01[0] - q00[0]) * tv, qy = q00[1] + (q10[1] - q00[1]) * tu + (q01[1] - q00[1]) * tv;
                if (qx < sx0 || qx > sx1 || qy < sy0 || qy > sy1) continue;
                dots.push(px(qx), py(qy), kind);
                cntd++;
              }
            }
          }
        }
      }
      // farmsteads among the busiest fields
      const pop = f.popDensity[i];
      if (k >= 2 && pop > 160 && !(towns && towns(x, y, 0.2))) {
        const nf = Math.min(3, Math.floor(pop / 260) + 1);
        let hh = hash2i(x, y, 5101 ^ seed);
        for (let q = 0; q < nf; q++) {
          hh = Math.imul(hh ^ (hh >>> 13), 0x5bd1e995) >>> 0;
          const fx = x + (hf(hh, 0) - 0.5) * 0.8, fy = y + (hf(hh, 8) - 0.5) * 0.8;
          if (bil(Lv, W, H, fx, fy) < 0.03 || bil(fm, W, H, fx, fy) < 0.2) continue;
          dots.push(px(fx), py(fy), 100 + (hh >>> 28));
        }
      }
    }
  }
  // fills, then the baulks between parcels, hedges, furrows, dots
  for (const p of fills.values()) { g.fillStyle = p._c; g.fill(p); }
  if (nEdges) {
    g.strokeStyle = 'rgba(236,224,186,0.34)'; g.lineWidth = Math.max(0.7, P * 0.009); g.stroke(edges);
    g.strokeStyle = 'rgba(70,58,36,0.1)'; g.lineWidth = Math.max(0.5, P * 0.003); g.stroke(edges);
  }
  if (nFur) { g.strokeStyle = 'rgba(80,62,38,0.2)'; g.lineWidth = Math.max(0.6, P * 0.004); g.stroke(furrows); }
  if (lanes.length) {
    g.lineCap = 'round';
    g.beginPath();
    for (let q = 0; q < lanes.length; q += 4) { g.moveTo(lanes[q], lanes[q + 1]); g.lineTo(lanes[q + 2], lanes[q + 3]); }
    g.strokeStyle = 'rgba(90,96,54,0.22)'; g.lineWidth = Math.max(1, P * 0.01); g.stroke();
    g.strokeStyle = 'rgba(214,198,160,0.55)'; g.lineWidth = Math.max(0.7, P * 0.005); g.stroke();
  }
  if (nHedge) {
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(58,84,44,0.78)'; g.lineWidth = Math.max(0.9, P * 0.011); g.stroke(hedges[1]);
    g.strokeStyle = 'rgba(132,126,112,0.8)'; g.lineWidth = Math.max(0.8, P * 0.008); g.stroke(hedges[2]);
  }
  if (dots.length) {
    const r0 = Math.max(0.8, P * 0.009);
    const groups = { 4: ['rgba(64,92,46,0.85)', 0.9], 6: ['rgba(70,110,52,0.9)', 1.5], 7: ['rgba(70,112,56,0.95)', 1.6], 1: ['rgba(238,232,214,0.85)', 0.85] };
    for (const kk of [4, 6, 7, 1]) {
      const [col, rr] = groups[kk];
      g.fillStyle = col;
      g.beginPath();
      for (let q = 0; q < dots.length; q += 3) {
        if (dots[q + 2] !== kk) continue;
        g.moveTo(dots[q] + r0 * rr, dots[q + 1]); g.arc(dots[q], dots[q + 1], r0 * rr, 0, Math.PI * 2);
      }
      g.fill();
    }
    // farmsteads: a house and a barn under warm roofs, a shadow to the south-east
    const s = Math.max(2, P * 0.045);
    for (let q = 0; q < dots.length; q += 3) {
      const kk = dots[q + 2];
      if (kk < 100) continue;
      const x = dots[q], y = dots[q + 1], v = kk - 100;
      const rot = (v & 3) * 0.4 - 0.6;
      g.save(); g.translate(x, y); g.rotate(rot);
      g.fillStyle = 'rgba(30,24,16,0.25)'; g.fillRect(-s * 0.4, -s * 0.2, s * 1.1, s * 0.7);
      g.fillStyle = ['#a8573e', '#8e6a48', '#9a4a36', '#7e705c'][v & 3]; g.fillRect(-s * 0.55, -s * 0.38, s, s * 0.62);
      g.fillStyle = 'rgba(255,240,220,0.25)'; g.fillRect(-s * 0.55, -s * 0.38, s, s * 0.22);
      g.strokeStyle = 'rgba(50,34,24,0.7)'; g.lineWidth = Math.max(0.5, s * 0.08); g.strokeRect(-s * 0.55, -s * 0.38, s, s * 0.62);
      g.fillStyle = '#8a7a5e'; g.fillRect(s * 0.55, -s * 0.1, s * 0.5, s * 0.4);
      g.restore();
    }
  }
}

registerPainter('fields', 1, paintFields, { order: 30, families: ['full'], apron: 1, sig: (w, x0, y0, x1, y1, k, r) => townSig(r, x0, y0, x1, y1) });
