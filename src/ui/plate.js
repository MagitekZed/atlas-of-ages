// Atlas plates: a small political map of the world (or of one part of it) drawn into a
// canvas from an atlas snapshot (world.history.atlas, stats §8) or from the live borders.
// Extracted from the Atlas tab's plate so the Inspector (a war's theatre), the digest and
// other panels can draw the same plate: land tinted by height, seas by depth, each holder's
// lands in its colour with darker edges where two holders meet, towns as dots.
//
//   drawAtlasPlate(canvas, world, snapshot | null, { box?, marks?, scale? }) → { scale, cx0, cy0, cells, toPx }

import { WATER } from '../core/constants.js';
import { base64ToTyped } from '../core/serialize.js';

const SC = 3;                       // canvas px per snapshot cell (the Atlas tab's plate)
const decoded = new WeakMap();      // snapshot → Int16Array owner grid

const rgbOf = (hex) => { const v = parseInt(String(hex || '#888').replace('#', ''), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };

/** The snapshot's owner grid (half resolution), decoded once per snapshot object. */
function snapshotGrid(s) {
  if (decoded.has(s)) return decoded.get(s);
  let g = null;
  try {
    if (typeof s.owner === 'string') g = base64ToTyped(s.owner, Int16Array);
    else if (s.owner && (Array.isArray(s.owner) || ArrayBuffer.isView(s.owner))) g = Int16Array.from(s.owner);
  } catch (e) { g = null; }
  if (!g || g.length !== s.w * s.h) g = new Int16Array(Math.max(1, s.w * s.h)).fill(-1);
  decoded.set(s, g);
  return g;
}

/** A snapshot-shaped view of today's borders and towns (half resolution, as stats records them). */
function liveSnapshot(world) {
  const w = Math.ceil(world.W / 2), h = Math.ceil(world.H / 2);
  const owner = new Int16Array(w * h).fill(-1);
  const f = world.f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = f.owner[Math.min(world.H - 1, y * 2) * world.W + Math.min(world.W - 1, x * 2)];
      owner[y * w + x] = o >= 0 && world.civs[o]?.alive !== false ? o : -1;
    }
  }
  const towns = [];
  for (const s of world.settlements) if (s && s.alive) towns.push([s.x, s.y, s.civId, s.tier || 0, s.name]);
  const civs = world.civs.filter((c) => c && c.alive !== false).map((c) => [c.id, c.name, c.colorHex]);
  const snap = { y: null, w, h, owner: null, towns, civs };
  decoded.set(snap, owner);
  return snap;
}

/**
 * Draw an atlas plate into `canvas` (its backing store is resized; CSS decides how big it shows).
 *   snapshot  an entry of world.history.atlas, or null for the live borders
 *   box       { x0, y0, x1, y1 } in tile coordinates: draw only that part of the world
 *   marks     [{ x, y, kind?: 'battle' | 'capture' | 'razed' | 'dot', color?, r? }] in tile
 *             coordinates, drawn over the plate (battle and razed as crosses, capture as a ring)
 *   scale     canvas px per snapshot cell (default 3; a box defaults to about 360 px across)
 * Returns { scale, cx0, cy0, cells: [cw, ch], toPx(x, y) → [px, py] } for drawing more on top.
 */
export function drawAtlasPlate(canvas, world, snapshot = null, { box = null, marks = null, scale = null } = {}) {
  const s = snapshot || liveSnapshot(world);
  const grid = snapshotGrid(s);
  let cx0 = 0, cy0 = 0, cx1 = s.w - 1, cy1 = s.h - 1;
  if (box && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) {
    cx0 = Math.max(0, Math.floor(Math.min(box.x0, box.x1) / 2)); cx1 = Math.min(s.w - 1, Math.ceil(Math.max(box.x0, box.x1) / 2));
    cy0 = Math.max(0, Math.floor(Math.min(box.y0, box.y1) / 2)); cy1 = Math.min(s.h - 1, Math.ceil(Math.max(box.y0, box.y1) / 2));
  }
  const cw = Math.max(1, cx1 - cx0 + 1), ch = Math.max(1, cy1 - cy0 + 1);
  const k = Number.isFinite(scale) && scale > 0 ? scale : box ? Math.max(SC, Math.min(12, Math.round(360 / Math.max(cw, ch)))) : SC;
  canvas.width = cw * k; canvas.height = ch * k;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cw, ch);
  const civColor = new Map();
  for (const [id, , hex] of s.civs || []) civColor.set(id, hex);
  const cache = new Map();
  const colorFor = (id) => {
    if (cache.has(id)) return cache.get(id);
    const c = rgbOf(civColor.get(id) || world.civs[id]?.colorHex || '#999999');
    cache.set(id, c);
    return c;
  };
  const f = world.f;
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      const gi = y * s.w + x;
      const ti = Math.min(world.H - 1, y * 2) * world.W + Math.min(world.W - 1, x * 2);
      const water = f.water[ti] !== WATER.LAND;
      const o = grid[gi];
      let r, g, b;
      if (water) { const d = Math.max(0, Math.min(1, (0.5 - f.elevation[ti]) * 3)); r = 34 - d * 14; g = 66 - d * 26; b = 96 - d * 28; }
      else { const e = f.elevation[ti]; r = 176 + (e - 0.5) * 60; g = 166 + (e - 0.5) * 40; b = 134 + (e - 0.5) * 30; }
      if (o >= 0 && !water) {
        const c = colorFor(o);
        // darken cells on a border with another holder
        const edge = (x > 0 && grid[gi - 1] !== o) || (x < s.w - 1 && grid[gi + 1] !== o) || (y > 0 && grid[gi - s.w] !== o) || (y < s.h - 1 && grid[gi + s.w] !== o);
        const t = edge ? 0.92 : 0.58;
        r = r * (1 - t) + c[0] * t; g = g * (1 - t) + c[1] * t; b = b * (1 - t) + c[2] * t;
        if (edge) { r *= 0.72; g *= 0.72; b *= 0.72; }
      }
      const p = ((y - cy0) * cw + (x - cx0)) * 4;
      img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
    }
  }
  const tmp = document.createElement('canvas');
  tmp.width = cw; tmp.height = ch;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, cw * k, ch * k);
  const toPx = (x, y) => [(x / 2 - cx0) * k, (y / 2 - cy0) * k];
  // towns
  const dot = k / SC;
  for (const [x, y, , tier] of s.towns || []) {
    if (tier < 2) continue;
    const [px, py] = toPx(x, y);
    if (px < -4 || py < -4 || px > cw * k + 4 || py > ch * k + 4) continue;
    const r0 = (1.2 + tier * 0.45) * Math.max(1, Math.sqrt(dot));
    ctx.beginPath(); ctx.arc(px, py, r0, 0, Math.PI * 2);
    ctx.fillStyle = '#f3ead2'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(20,16,10,0.85)'; ctx.stroke();
  }
  // marks
  for (const m of Array.isArray(marks) ? marks : []) {
    if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
    const [px, py] = toPx(m.x, m.y);
    const rr = Number.isFinite(m.r) && m.r > 0 ? m.r : 3 + dot;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = m.color || '#b8322a';
    ctx.fillStyle = m.color || '#b8322a';
    ctx.beginPath();
    if (m.kind === 'battle' || m.kind === 'razed') { ctx.moveTo(px - rr, py - rr); ctx.lineTo(px + rr, py + rr); ctx.moveTo(px + rr, py - rr); ctx.lineTo(px - rr, py + rr); ctx.stroke(); }
    else if (m.kind === 'capture') { ctx.arc(px, py, rr, 0, Math.PI * 2); ctx.stroke(); }
    else { ctx.arc(px, py, rr * 0.6, 0, Math.PI * 2); ctx.fill(); }
  }
  return { scale: k, cx0, cy0, cells: [cw, ch], toPx };
}
