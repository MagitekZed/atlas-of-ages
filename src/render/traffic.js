// Traffic: the trade that plies the routes, drawn as its land and age would carry it. Ships
// leave a wake built from their own route (so it never cuts across a headland): reed boats and
// oared galleys in the early ages, triremes, longships and cogs in the north or lateen-rigged
// dhows in the tropics, carracks and galleons, then steamers trailing smoke and container
// ships. On land a caravan walks as a string of beasts along its road: camels in the desert,
// mules in the hills, porters in the rainforest, pack horses or an ox-cart on country tracks,
// wagons on made roads, steam trains on the railways of the industrial age, lorries in the
// modern one. From afar, the amber dots and little ships the atlas has always drawn.
// Hits: kind 'caravan'. Purely cosmetic.

import { WATER, BIOME } from '../core/constants.js';
import { clamp, smoothstep } from '../core/util.js';
import { makeCanvas } from './terrain.js';
import { qpx } from './glyphs.js';
import { css, civRgb, darken, lighten, INK } from './palette.js';
import { PK } from './fx.js';

const TAU = Math.PI * 2;

/** The caravan's way behind it (entity coords, newest first), at most `len` tiles long. */
function trailOf(w, c, len) {
  const W = w.W, path = c.path;
  const out = [c.x, c.y];
  if (!Array.isArray(path) || path.length < 2) return out;
  const last = path.length - 1;
  const step = clamp(c.pathStep | 0, 0, last);
  const dir = c.dir < 0 ? -1 : 1;
  let px = c.x, py = c.y, acc = 0;
  // moving up the path the points behind are step, step−1 …; moving down, step+1, step+2 …
  for (let k = dir > 0 ? step : step + 1; k >= 0 && k <= last; k -= dir) {
    const i = path[k];
    if (!Number.isInteger(i)) break;
    const x = i % W, y = (i / W) | 0;
    const d = Math.hypot(x - px, y - py);
    if (d > 3) break;   // a jump: a new leg
    if (acc + d > len) {
      const t = (len - acc) / Math.max(1e-6, d);
      out.push(px + (x - px) * t, py + (y - py) * t);
      break;
    }
    acc += d; out.push(x, y); px = x; py = y;
  }
  return out;
}

/** A point arc-length s along a trail (entity coords) with the heading there. */
function along(tr, s) {
  let acc = 0;
  for (let k = 0; k + 3 < tr.length; k += 2) {
    const dx = tr[k + 2] - tr[k], dy = tr[k + 3] - tr[k + 1], d = Math.hypot(dx, dy);
    if (acc + d >= s && d > 0) { const t = (s - acc) / d; return [tr[k] + dx * t, tr[k + 1] + dy * t, Math.atan2(-dy, -dx)]; }
    acc += d;
  }
  if (tr.length >= 4) { const n = tr.length; return [tr[n - 2], tr[n - 1], Math.atan2(tr[1] - tr[n - 1], tr[0] - tr[n - 2])]; }
  return [tr[0], tr[1], 0];
}

// ---------------------------------------------------------------------------
// Sprites

function sprite(cache, key, w, h, ox, oy, dpr, draw) {
  return cache.get(key, () => {
    const c = makeCanvas(Math.ceil(w * dpr), Math.ceil(h * dpr));
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, ox * dpr, oy * dpr);
    g.lineJoin = 'round'; g.lineCap = 'round';
    draw(g);
    return { canvas: c, w, h, ox, oy };
  });
}

/** Ship kind for an age and latitude. */
function shipKind(era, lat) {
  if (era >= 7) return 'container';
  if (era >= 6) return 'steamer';
  if (era >= 5) return 'galleon';
  if (era >= 4) return Math.abs(lat) > 0.45 ? 'cog' : Math.abs(lat) < 0.28 ? 'dhow' : 'cog';
  if (era >= 2) return 'trireme';
  return 'galley';
}

/** A ship seen from the side, heading right (flipped by the caller). s = hull half-length px. */
function shipSprite(cache, kind, s, dpr, rgb) {
  const sb = Math.max(3, qpx(s, 6));
  const col = rgb ? css(rgb) : '#c8b48a';
  return sprite(cache, `TS${kind}|${sb.toFixed(2)}|${col}|${dpr}`, sb * 2.6, sb * 2.6, sb * 1.3, sb * 1.7, dpr, (g) => {
    const lw = Math.max(0.7, sb * 0.09), ink = css(INK, 0.9);
    g.strokeStyle = ink; g.lineWidth = lw;
    const hull = (c, deck = 0.22) => { g.fillStyle = c; g.beginPath(); g.moveTo(-sb, -sb * 0.05); g.lineTo(sb * 1.05, -sb * 0.12); g.lineTo(sb * 0.7, sb * deck); g.lineTo(-sb * 0.75, sb * deck); g.closePath(); g.fill(); g.stroke(); };
    const mast = (x, h) => { g.beginPath(); g.moveTo(x, -sb * 0.08); g.lineTo(x, -sb * h); g.stroke(); };
    const square = (x, top, bot, w2, c = '#f2ead6') => { g.fillStyle = c; g.beginPath(); g.moveTo(x - w2, -sb * top); g.quadraticCurveTo(x + w2 * 0.2, -sb * (top + bot) / 2, x - w2, -sb * bot); g.lineTo(x + w2, -sb * bot); g.quadraticCurveTo(x + w2 * 1.2, -sb * (top + bot) / 2, x + w2, -sb * top); g.closePath(); g.fill(); g.stroke(); };
    switch (kind) {
      case 'galley': case 'trireme': {
        hull('#8a6238', 0.16);
        g.strokeStyle = 'rgba(60,40,24,0.9)'; g.lineWidth = lw * 0.8;
        const banks = kind === 'trireme' ? 2 : 1;
        for (let b = 0; b < banks; b++) for (let k = -4; k <= 4; k++) { const x = k * sb * 0.18; g.beginPath(); g.moveTo(x, sb * (0.12 + b * 0.04)); g.lineTo(x - sb * 0.12, sb * (0.42 + b * 0.08)); g.stroke(); }
        g.strokeStyle = ink; g.lineWidth = lw;
        mast(0, 1.0); square(0, 0.95, 0.35, sb * 0.42, col);
        break;
      }
      case 'dhow': {
        hull('#94683a');
        mast(sb * 0.1, 1.15);
        g.fillStyle = '#f2ead6'; g.beginPath(); g.moveTo(-sb * 0.6, -sb * 0.25); g.lineTo(sb * 0.55, -sb * 1.3); g.lineTo(sb * 0.55, -sb * 0.2); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = col; g.fillRect(-sb * 0.9, -sb * 0.2, sb * 0.18, sb * 0.12);
        break;
      }
      case 'cog': {
        hull('#7a5634', 0.28);
        g.fillStyle = '#7a5634'; g.fillRect(-sb * 0.95, -sb * 0.32, sb * 0.32, sb * 0.28); g.strokeRect(-sb * 0.95, -sb * 0.32, sb * 0.32, sb * 0.28);
        mast(0, 1.25); square(0, 1.15, 0.38, sb * 0.5, col);
        break;
      }
      case 'galleon': {
        hull('#6e4a2c', 0.3);
        g.fillStyle = '#6e4a2c'; g.fillRect(-sb * 1.0, -sb * 0.42, sb * 0.42, sb * 0.38); g.strokeRect(-sb * 1.0, -sb * 0.42, sb * 0.42, sb * 0.38);
        for (const [x, h] of [[-sb * 0.45, 1.15], [sb * 0.1, 1.45], [sb * 0.62, 1.05]]) { mast(x, h); square(x, h - 0.08, 0.48, sb * 0.3); }
        g.fillStyle = col; g.fillRect(sb * 0.1, -sb * 1.55, sb * 0.3, sb * 0.12);
        break;
      }
      case 'steamer': {
        hull('#4a4a4e', 0.24);
        g.fillStyle = '#e8e2d2'; g.fillRect(-sb * 0.45, -sb * 0.42, sb * 0.9, sb * 0.32); g.strokeRect(-sb * 0.45, -sb * 0.42, sb * 0.9, sb * 0.32);
        g.fillStyle = col; g.fillRect(-sb * 0.05, -sb * 0.85, sb * 0.22, sb * 0.45); g.strokeRect(-sb * 0.05, -sb * 0.85, sb * 0.22, sb * 0.45);
        g.fillStyle = '#222'; g.fillRect(-sb * 0.05, -sb * 0.9, sb * 0.22, sb * 0.1);
        break;
      }
      default: { // container ship
        hull('#3e4a5a', 0.24);
        const cols = ['#c0533e', '#3e7cb0', '#d6a640', '#5b9a5a', col];
        for (let k = 0; k < 7; k++) { g.fillStyle = cols[k % cols.length]; g.fillRect(-sb * 0.75 + k * sb * 0.2, -sb * 0.36, sb * 0.18, sb * 0.28); }
        g.fillStyle = '#e8e2d2'; g.fillRect(-sb * 0.98, -sb * 0.6, sb * 0.22, sb * 0.52); g.strokeRect(-sb * 0.98, -sb * 0.6, sb * 0.22, sb * 0.52);
      }
    }
  });
}

/** One beast (or vehicle) of a land caravan, side view heading right. s = body length px. */
function beastSprite(cache, kind, s, dpr, rgb) {
  const sb = Math.max(3, qpx(s, 6));
  const col = rgb ? css(rgb) : '#c8a060';
  return sprite(cache, `TB${kind}|${sb.toFixed(2)}|${col}|${dpr}`, sb * 2.2, sb * 2.0, sb * 1.1, sb * 1.4, dpr, (g) => {
    const lw = Math.max(0.6, sb * 0.08), ink = css(INK, 0.9);
    g.strokeStyle = ink; g.lineWidth = lw;
    const legs = (x0, x1, y, h) => { g.beginPath(); g.moveTo(x0, y); g.lineTo(x0, y + h); g.moveTo(x1, y); g.lineTo(x1, y + h); g.stroke(); };
    switch (kind) {
      case 'camel': {
        g.fillStyle = '#c8a26a';
        g.beginPath(); g.moveTo(-sb * 0.5, -sb * 0.05); g.quadraticCurveTo(-sb * 0.3, -sb * 0.65, -sb * 0.05, -sb * 0.2); g.quadraticCurveTo(sb * 0.2, -sb * 0.6, sb * 0.42, -sb * 0.1); g.lineTo(sb * 0.62, -sb * 0.55); g.lineTo(sb * 0.8, -sb * 0.5); g.lineTo(sb * 0.6, -sb * 0.05); g.closePath(); g.fill(); g.stroke();
        legs(-sb * 0.35, sb * 0.35, -sb * 0.05, sb * 0.5);
        g.fillStyle = col; g.fillRect(-sb * 0.25, -sb * 0.42, sb * 0.3, sb * 0.16);
        break;
      }
      case 'mule': case 'horse': {
        g.fillStyle = kind === 'mule' ? '#8a6c50' : '#7a5236';
        g.beginPath(); g.ellipse(0, -sb * 0.2, sb * 0.5, sb * 0.2, 0, 0, TAU); g.fill(); g.stroke();
        g.beginPath(); g.moveTo(sb * 0.4, -sb * 0.25); g.lineTo(sb * 0.62, -sb * 0.55); g.lineTo(sb * 0.76, -sb * 0.45); g.lineTo(sb * 0.5, -sb * 0.15); g.closePath(); g.fill(); g.stroke();
        legs(-sb * 0.32, sb * 0.32, -sb * 0.05, sb * 0.42);
        g.fillStyle = col; g.fillRect(-sb * 0.25, -sb * 0.55, sb * 0.42, sb * 0.22); g.strokeRect(-sb * 0.25, -sb * 0.55, sb * 0.42, sb * 0.22);
        break;
      }
      case 'porter': {
        g.fillStyle = '#6a4a34'; g.beginPath(); g.arc(0, -sb * 0.75, sb * 0.13, 0, TAU); g.fill();
        g.beginPath(); g.moveTo(0, -sb * 0.6); g.lineTo(0, -sb * 0.2); g.lineTo(-sb * 0.15, sb * 0.3); g.moveTo(0, -sb * 0.2); g.lineTo(sb * 0.15, sb * 0.3); g.stroke();
        g.fillStyle = col; g.fillRect(-sb * 0.3, -sb * 0.72, sb * 0.26, sb * 0.32); g.strokeRect(-sb * 0.3, -sb * 0.72, sb * 0.26, sb * 0.32);
        break;
      }
      case 'oxcart': case 'wagon': {
        g.fillStyle = kind === 'wagon' ? '#d8cfb8' : '#9a7650';
        if (kind === 'wagon') { g.beginPath(); g.moveTo(-sb * 0.7, -sb * 0.2); g.quadraticCurveTo(-sb * 0.15, -sb * 0.95, sb * 0.4, -sb * 0.2); g.closePath(); g.fill(); g.stroke(); }
        g.fillStyle = '#8a6440'; g.fillRect(-sb * 0.7, -sb * 0.25, sb * 1.1, sb * 0.2); g.strokeRect(-sb * 0.7, -sb * 0.25, sb * 1.1, sb * 0.2);
        g.fillStyle = '#4a3624'; for (const x of [-sb * 0.5, sb * 0.2]) { g.beginPath(); g.arc(x, 0, sb * 0.15, 0, TAU); g.fill(); }
        g.fillStyle = '#7a5a3c'; g.beginPath(); g.ellipse(sb * 0.75, -sb * 0.15, sb * 0.28, sb * 0.14, 0, 0, TAU); g.fill(); g.stroke();
        break;
      }
      case 'train': {
        g.fillStyle = '#3a3a3e'; g.fillRect(-sb * 0.7, -sb * 0.45, sb * 1.2, sb * 0.4); g.strokeRect(-sb * 0.7, -sb * 0.45, sb * 1.2, sb * 0.4);
        g.fillStyle = col; g.fillRect(-sb * 0.7, -sb * 0.6, sb * 0.45, sb * 0.18);
        g.fillStyle = '#222'; g.fillRect(sb * 0.25, -sb * 0.72, sb * 0.14, sb * 0.3);
        for (const x of [-sb * 0.5, -sb * 0.1, sb * 0.3]) { g.beginPath(); g.arc(x, 0, sb * 0.1, 0, TAU); g.fill(); }
        break;
      }
      case 'car': {
        g.fillStyle = '#8a8e96'; g.fillRect(-sb * 0.6, -sb * 0.42, sb * 1.1, sb * 0.36); g.strokeRect(-sb * 0.6, -sb * 0.42, sb * 1.1, sb * 0.36);
        g.fillStyle = '#4a4e56'; g.fillRect(sb * 0.5, -sb * 0.34, sb * 0.28, sb * 0.28); g.strokeRect(sb * 0.5, -sb * 0.34, sb * 0.28, sb * 0.28);
        g.fillStyle = '#222'; for (const x of [-sb * 0.4, sb * 0.1, sb * 0.6]) { g.beginPath(); g.arc(x, -sb * 0.02, sb * 0.09, 0, TAU); g.fill(); }
        break;
      }
      default: { // railway carriage
        g.fillStyle = col; g.fillRect(-sb * 0.7, -sb * 0.42, sb * 1.3, sb * 0.36); g.strokeRect(-sb * 0.7, -sb * 0.42, sb * 1.3, sb * 0.36);
        g.fillStyle = '#222'; for (const x of [-sb * 0.5, sb * 0.4]) { g.beginPath(); g.arc(x, 0, sb * 0.1, 0, TAU); g.fill(); }
      }
    }
  });
}

/** How a land caravan travels here, in this age. */
function landKind(w, c, era) {
  const W = w.W, f = w.f;
  const i = clamp(Math.round(c.y), 0, w.H - 1) * W + clamp(Math.round(c.x), 0, W - 1);
  const road = f.road[i] | 0, b = f.biome[i];
  if (road >= 3 && era >= 7) return ['car', 'car'];
  if (road >= 3 && era >= 6) return ['train', 'carriage'];
  if (b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT) return ['camel', 'camel'];
  if (f.elevation[i] > 0.66 || b === BIOME.ALPINE) return ['mule', 'mule'];
  if (b === BIOME.RAINFOREST) return ['porter', 'porter'];
  if (road >= 2 && era >= 2) return ['wagon', 'wagon'];
  return road >= 1 ? ['oxcart', 'horse'] : ['horse', 'horse'];
}

/**
 * Caravans and ships (screen space). emphasis: the mode's route weight (0 hides at world zoom).
 */
export function drawTraffic(r, ctx, emphasis) {
  const w = r.world, z = r.camera.zoom, dpr = r.dpr;
  const list = w.caravans;
  if (!list || !list.length) return;
  if (z < 3 && emphasis < 1) return;
  const vw = r.viewW, vh = r.viewH;
  const P = r.fx.particles;
  const H = w.H;
  for (const c of list) {
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    const { sx, sy } = r.e2s(c.x, c.y);
    if (sx < -40 || sy < -40 || sx > vw + 40 || sy > vh + 40) continue;
    const ship = c.kind === 'ship' || (w.f.water[Math.round(clamp(c.y, 0, H - 1)) * w.W + Math.round(clamp(c.x, 0, w.W - 1))] ?? 0) !== WATER.LAND;
    const civ = c.civId != null ? w.civs[c.civId] : null;
    const era = civ?.tech?.era | 0;
    const rgb = c.civId != null ? civRgb(w, c.civId) : null;
    if (ship) {
      const tr = trailOf(w, c, Math.min(2.4, 1.2 + 24 / Math.max(4, z)));
      const head = tr.length >= 4 ? Math.atan2(tr[1] - tr[3], tr[0] - tr[2]) : 0;
      // the wake, along the ship's own course
      if (tr.length >= 4 && z >= 4) {
        ctx.strokeStyle = 'rgba(236,246,250,0.6)'; ctx.lineWidth = Math.max(0.8, Math.min(2.4, z * 0.05)); ctx.lineCap = 'round';
        ctx.beginPath();
        for (let k = 0; k < tr.length; k += 2) { const q = r.e2s(tr[k], tr[k + 1]); if (k) ctx.lineTo(q.sx, q.sy); else ctx.moveTo(q.sx, q.sy); }
        ctx.stroke();
        if (z >= 24) {
          // a V of foam spreading behind
          const L = Math.min(40, z * 0.35), spread = 0.32;
          ctx.strokeStyle = 'rgba(240,248,252,0.45)'; ctx.lineWidth = 1;
          ctx.beginPath();
          for (const sgn of [-1, 1]) { ctx.moveTo(sx, sy); ctx.lineTo(sx - Math.cos(head + sgn * spread) * L, sy - Math.sin(head + sgn * spread) * L); }
          ctx.stroke();
        }
      }
      const s = clamp(2.5 + z * 0.2, 3, z >= 48 ? 14 : 10);
      if (z >= 6) {
        const lat = 1 - (2 * (c.y + 0.5)) / H;
        const kind = shipKind(era, lat);
        const sp = shipSprite(r.sprites, kind, s, dpr, rgb);
        const flip = Math.cos(head) < 0;
        const k = s / qpx(s, 6);
        ctx.save(); ctx.translate(sx, sy); if (flip) ctx.scale(-1, 1);
        ctx.drawImage(sp.canvas, -sp.ox * k, -sp.oy * k, sp.w * k, sp.h * k);
        ctx.restore();
        if (kind === 'steamer' && z >= 10 && Math.random() < 0.06) P.spawn(PK.SMOKE, c.x, c.y - 0.15, -Math.cos(head) * 0.1, -0.2, 0.1, 2, 0.12, 0.35);
      } else {
        ctx.fillStyle = 'rgb(244,238,222)'; ctx.strokeStyle = 'rgba(40,40,50,0.8)'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.4, s * 0.4), 0, TAU); ctx.fill(); ctx.stroke();
      }
      r.hits.push({ kind: 'caravan', id: c.id, x0: sx - s - 2, y0: sy - s * 1.6, x1: sx + s + 2, y1: sy + 4, pri: 1.8 });
    } else {
      const s = Math.max(1.5, Math.min(4, 1.1 + z * 0.12)) * (emphasis > 1 ? 1.25 : 1);
      const beasts = smoothstep(11, 15, z);
      if (beasts < 1) {
        ctx.globalAlpha = 1 - beasts;
        if (z >= 8) {
          const tr = trailOf(w, c, 0.8);
          if (tr.length >= 4) { ctx.strokeStyle = 'rgba(232,170,60,0.35)'; ctx.lineWidth = s * 0.8; const q = r.e2s(tr[tr.length - 2], tr[tr.length - 1]); ctx.beginPath(); ctx.moveTo(q.sx, q.sy); ctx.lineTo(sx, sy); ctx.stroke(); }
        }
        ctx.fillStyle = 'rgb(236,176,62)'; ctx.strokeStyle = 'rgba(60,36,16,0.9)'; ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.arc(sx, sy, s, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (beasts > 0) {
        // a string of beasts (or a train) walking its road
        const [lead, follow] = landKind(w, c, era);
        const n = clamp(Math.round(Math.log2(Math.max(2, c.value || 4)) + 1), 3, 6) + (lead === 'train' ? 1 : 0);
        const bs = clamp(z * 0.11, 5, 13);
        const gap = (bs * 1.25) / z;
        const tr = trailOf(w, c, gap * (n + 1));
        ctx.globalAlpha = beasts;
        for (let q = n - 1; q >= 0; q--) {
          const [x, y, ang] = along(tr, q * gap);
          const p = r.e2s(x, y);
          const kind = q === 0 ? lead : follow;
          const sp = beastSprite(r.sprites, kind, bs, dpr, rgb);
          const k = bs / qpx(bs, 6);
          const flip = Math.cos(ang) < 0;
          ctx.save(); ctx.translate(p.sx, p.sy); if (flip) ctx.scale(-1, 1);
          ctx.drawImage(sp.canvas, -sp.ox * k, -sp.oy * k, sp.w * k, sp.h * k);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        if (lead === 'train' && Math.random() < 0.08) P.spawn(PK.SMOKE, c.x, c.y - 0.1, 0, -0.25, 0.08, 1.6, 0.1, 0.4);
      }
      r.hits.push({ kind: 'caravan', id: c.id, x0: sx - Math.max(s, 8) - 2, y0: sy - Math.max(s, 8) - 2, x1: sx + Math.max(s, 8) + 2, y1: sy + Math.max(s, 8) + 2, pri: 1.8 });
    }
  }
}
