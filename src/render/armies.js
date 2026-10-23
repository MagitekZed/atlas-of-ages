// Armies as hosts you can watch. From afar a nation's banner with its strength; from Region
// zoom a strip of unit marks beneath it; from Province zoom the host itself as a formation of
// blocks, one per few hundred to a few thousand men: a two-abreast column marching along its
// road in its own dust, a camp of blocks and tents when it halts, an arc drawn round the walls
// of a town it besieges, a loose scatter when it breaks and runs, a wedge of hulls at sea. Its
// blocks are the arms of its age — spears, legion squares, knights and levies, pike and shot,
// line infantry with cannon, tanks and lorries — and its banner hangs in tatters when its
// morale fails; its general rides beneath it, named. Hits: kind 'army'. Purely cosmetic.

import { WATER, BIOME } from '../core/constants.js';
import { hash2i } from '../core/rng.js';
import { clamp, smoothstep } from '../core/util.js';
import { bannerSprite } from './glyphs.js';
import { css, civRgb, darken, lighten, INK } from './palette.js';
import { footprints } from './cityplan.js';
import { paintHull } from './cityplan.js';
import { PK } from './fx.js';

const TAU = Math.PI * 2;
const hf = (h, s = 0, bits = 8) => ((h >>> s) & ((1 << bits) - 1)) / ((1 << bits) - 1);

/** An army's strength as the Inspector prints it: whole numbers, then thousands as k. */
export function fmtStrength(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 10000) return (Math.round(v / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'k';
  if (v < 1e6) return Math.round(v / 1000) + 'k';
  return (Math.round(v / 1e5) / 10).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** The arms of each block for an age: 'inf' | 'cav' | 'art' | 'tank' | 'truck'. */
function armsOf(era, k, n, h) {
  const r = hf(h, (k * 5) % 24);
  if (era >= 7) return k === 0 ? 'tank' : r < 0.4 ? 'tank' : r < 0.6 ? 'truck' : r < 0.8 ? 'art' : 'inf';
  if (era >= 5) return r < 0.18 ? 'art' : r < 0.42 ? 'cav' : 'inf';
  if (era >= 1) return r < 0.28 ? 'cav' : 'inf';
  return 'inf';
}

/** Where the host is heading (radians) from its path, or null when it holds still. */
function headingOf(w, a) {
  const p = a.path;
  if (!Array.isArray(p) || p.length < 2) return null;
  const k = clamp((a.pathStep | 0) + 1, 0, p.length - 1);
  const i = p[k];
  if (!Number.isInteger(i)) return null;
  const tx = i % w.W, ty = (i / w.W) | 0;
  const dx = tx - a.x, dy = ty - a.y;
  return Math.hypot(dx, dy) < 1e-3 ? null : Math.atan2(dy, dx);
}

/** One block of the formation, top-down, its long side across the heading (screen px). */
function block(ctx, x, y, ang, L, rgb, arms, era, a) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  const W2 = L * 0.62, H2 = L * 0.38;
  ctx.globalAlpha = a;
  ctx.fillStyle = 'rgba(24,18,12,0.3)'; ctx.fillRect(-H2 + L * 0.1, -W2 + L * 0.12, H2 * 2, W2 * 2);
  ctx.strokeStyle = css(INK, 0.9); ctx.lineWidth = Math.max(0.7, L * 0.07);
  switch (arms) {
    case 'cav': {
      ctx.fillStyle = css(lighten(rgb, 0.12)); ctx.fillRect(-H2, -W2, H2 * 2, W2 * 2); ctx.strokeRect(-H2, -W2, H2 * 2, W2 * 2);
      ctx.beginPath(); ctx.moveTo(-H2 * 0.6, -W2 * 0.7); ctx.lineTo(H2 * 0.6, 0); ctx.lineTo(-H2 * 0.6, W2 * 0.7); ctx.stroke();
      break;
    }
    case 'art': {
      ctx.fillStyle = css(darken(rgb, 0.25)); ctx.fillRect(-H2 * 0.7, -W2 * 0.7, H2 * 1.4, W2 * 1.4); ctx.strokeRect(-H2 * 0.7, -W2 * 0.7, H2 * 1.4, W2 * 1.4);
      ctx.fillStyle = '#2a2622'; ctx.fillRect(0, -L * 0.06, L * 0.55, L * 0.12);
      break;
    }
    case 'tank': {
      ctx.fillStyle = css(darken(rgb, 0.15)); ctx.beginPath(); ctx.rect(-H2, -W2 * 0.8, H2 * 2, W2 * 1.6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = css(darken(rgb, 0.35)); ctx.beginPath(); ctx.arc(0, 0, W2 * 0.45, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#2a2622'; ctx.fillRect(W2 * 0.3, -L * 0.05, L * 0.6, L * 0.1);
      break;
    }
    case 'truck': {
      ctx.fillStyle = css(lighten(rgb, 0.05)); ctx.fillRect(-H2, -W2 * 0.6, H2 * 2, W2 * 1.2); ctx.strokeRect(-H2, -W2 * 0.6, H2 * 2, W2 * 1.2);
      ctx.fillStyle = '#3a3a3e'; ctx.fillRect(H2 * 0.4, -W2 * 0.6, H2 * 0.6, W2 * 1.2);
      break;
    }
    default: {
      ctx.fillStyle = css(rgb); ctx.fillRect(-H2, -W2, H2 * 2, W2 * 2); ctx.strokeRect(-H2, -W2, H2 * 2, W2 * 2);
      // the arms of the age: spear rows, a legion's shields, pike and shot, a line of muskets
      ctx.strokeStyle = era >= 6 ? 'rgba(250,244,230,0.85)' : era >= 5 ? 'rgba(60,46,34,0.8)' : 'rgba(250,244,230,0.6)';
      ctx.lineWidth = Math.max(0.6, L * 0.05);
      ctx.beginPath();
      const rows = era >= 2 && era < 5 ? 3 : 2;
      for (let q = 1; q <= rows; q++) { const xx = -H2 + (q * H2 * 2) / (rows + 1); ctx.moveTo(xx, -W2 * 0.8); ctx.lineTo(xx, W2 * 0.8); }
      ctx.stroke();
      if (era >= 2 && era < 4) { ctx.fillStyle = css(darken(rgb, 0.3)); ctx.fillRect(H2 * 0.55, -W2, H2 * 0.45, W2 * 2); }
    }
  }
  ctx.restore();
}

/** A tent of a camp or siege line (screen px). */
function tent(ctx, x, y, s, rgb, k) {
  ctx.fillStyle = k % 3 === 0 ? css(rgb) : 'rgb(232,222,198)';
  ctx.strokeStyle = css(INK, 0.85); ctx.lineWidth = Math.max(0.6, s * 0.12);
  ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.8, y + s * 0.5); ctx.lineTo(x - s * 0.8, y + s * 0.5); ctx.closePath(); ctx.fill(); ctx.stroke();
}

/** The armies in view (screen space), with their marches, formations, banners and strengths. */
export function drawArmies(r, ctx, labels) {
  const w = r.world, z = r.camera.zoom, dpr = r.dpr;
  const list = w.armies;
  if (!list || !list.length) return;
  const vw = r.viewW, vh = r.viewH;
  const sel = r.selection;
  const P = r.fx.particles;
  const strip = smoothstep(9, 11, z) * (1 - smoothstep(20, 26, z));
  const host = smoothstep(20, 26, z);
  for (const a of list) {
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
    const { sx, sy } = r.e2s(a.x, a.y);
    const reach = host > 0 ? Math.max(40, z * 1.2) : 40;
    if (sx < -reach || sy < -reach || sx > vw + reach || sy > vh + reach) continue;
    const rgb = civRgb(w, a.civId);
    const civ = w.civs[a.civId];
    const era = civ?.tech?.era | 0;
    const str = Math.max(0, a.strength || 0);
    const s = Math.max(5, Math.min(14, 4 + Math.log10(str + 10) * 2.2)) * Math.max(0.8, Math.min(1.7, Math.pow(z / 8, 0.4)));
    const selected = sel && sel.kind === 'army' && sel.id === a.id;
    const naval = Boolean(a.naval);
    const h = hash2i(a.id, 5, 6007);
    // planned march
    if ((selected || z >= 9) && Array.isArray(a.path) && a.path.length > 1) {
      const W = w.W;
      ctx.strokeStyle = css(rgb, selected ? 0.9 : 0.45); ctx.lineWidth = selected ? 2 : 1.2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(sx, sy);
      const start = Math.max(0, a.pathStep | 0), end = Math.min(a.path.length, start + (selected ? 400 : 14));
      for (let k = start; k < end; k++) {
        const i = a.path[k];
        if (!Number.isInteger(i)) continue;
        const q = r.e2s(i % W, (i / W) | 0);
        ctx.lineTo(q.sx, q.sy);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    if (a.state === 'sieging' || a.state === 'siege') {
      const pulse = 0.5 + 0.5 * Math.sin(r.now * 0.01 + a.id);
      ctx.strokeStyle = `rgba(206,62,46,${(0.4 + 0.4 * pulse) * (1 - host * 0.7)})`; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(sx, sy, s * 1.1 + pulse * 2, 0, TAU); ctx.stroke();
    }
    // the host as a formation (Province zoom and closer)
    let bannerX = sx, bannerY = sy;
    if (host > 0.01) {
      const n = clamp(Math.round(Math.log2(Math.max(1, str / 250))), 1, 24);
      const L = clamp(z * (0.03 + 0.006 * Math.log2(1 + str / 2000)), 4, 26);
      const head = headingOf(w, a);
      const st = a.state;
      const ca = head != null ? Math.cos(head) : 1, sa = head != null ? Math.sin(head) : 0;
      if (naval) {
        // a wedge of hulls
        const nh = Math.max(1, Math.round(1 + n / 2));
        for (let k = 0; k < nh; k++) {
          const row = Math.ceil(k / 2), side = k === 0 ? 0 : k % 2 ? 1 : -1;
          const bx = sx - ca * row * L * 1.4 - sa * side * row * L * 0.9, by = sy - sa * row * L * 1.4 + ca * side * row * L * 0.9;
          ctx.globalAlpha = host;
          paintHull(ctx, bx, by, head ?? 0, L * 1.1, era, rgb, 1, 0.8);
        }
        ctx.globalAlpha = 1;
      } else if (st === 'sieging' && a.targetId != null && w.settlements[a.targetId]) {
        // an arc round the walls, facing the town
        const t = w.settlements[a.targetId];
        const fp = footprints(r).byId.get(t.id);
        const rr = ((fp ? fp.r : 0.2) + 0.18) * z;
        const c0 = r.e2s(t.x, t.y);
        const base = Math.atan2(sy - c0.sy, sx - c0.sx);
        const spread = Math.min(Math.PI * 1.2, (n * L * 1.5) / Math.max(10, rr));
        for (let k = 0; k < n; k++) {
          const an = base + (n > 1 ? (k / (n - 1) - 0.5) * spread : 0);
          const bx = c0.sx + Math.cos(an) * rr, by = c0.sy + Math.sin(an) * rr;
          block(ctx, bx, by, an + Math.PI, L, rgb, armsOf(era, k, n, h), era, host);
          if (k % 3 === 1) tent(ctx, c0.sx + Math.cos(an) * (rr + L * 1.6), c0.sy + Math.sin(an) * (rr + L * 1.6), L * 0.45, rgb, k);
        }
        bannerX = c0.sx + Math.cos(base) * (rr + L * 2.4); bannerY = c0.sy + Math.sin(base) * (rr + L * 2.4);
      } else if (st === 'retreating') {
        // broken: a loose scatter streaming away
        for (let k = 0; k < n; k++) {
          const hh = hash2i(a.id, k, 6011);
          const d = (0.5 + hf(hh, 0) * 1.8) * L, an = (head ?? 0) + Math.PI + (hf(hh, 8) - 0.5) * 1.8;
          block(ctx, sx + Math.cos(an) * d, sy + Math.sin(an) * d, (head ?? 0) + (hf(hh, 16) - 0.5) * 1.4, L * 0.75, rgb, armsOf(era, k, n, h), era, host * 0.85);
        }
      } else if (head != null && (st === 'marching' || st === 'returning')) {
        // a column two abreast along the road
        for (let k = 0; k < n; k++) {
          const row = (k / 2) | 0, side = k % 2 ? 0.5 : -0.5;
          const bx = sx - ca * row * L * 1.35 - sa * side * L * 1.05, by = sy - sa * row * L * 1.35 + ca * side * L * 1.05;
          block(ctx, bx, by, head, L, rgb, armsOf(era, k, n, h), era, host);
        }
        // dust behind the column on dry ground (mud on wet)
        const i = clamp(Math.round(a.y), 0, w.H - 1) * w.W + clamp(Math.round(a.x), 0, w.W - 1);
        const b = w.f.biome[i];
        const dry = b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT || b === BIOME.STEPPE || b === BIOME.SAVANNA || b === BIOME.SHRUBLAND;
        if (dry && w.f.water[i] === WATER.LAND && Math.random() < 0.25) {
          const back = (n / 2) * 1.35 * L / z;
          P.spawn(PK.DUST, a.x - ca * back, a.y - sa * back, -ca * 0.15, -sa * 0.15 - 0.05, 0.15 + Math.random() * 0.15, 1.6, 0.25, 0.45);
        }
      } else {
        // camped: blocks in ranks with tents behind
        const cols = Math.ceil(Math.sqrt(n));
        for (let k = 0; k < n; k++) {
          const cx = (k % cols) - (cols - 1) / 2, cy = ((k / cols) | 0) - (Math.ceil(n / cols) - 1) / 2;
          block(ctx, sx + cx * L * 1.25, sy + cy * L * 1.4, 0, L, rgb, armsOf(era, k, n, h), era, host);
        }
        for (let k = 0; k < Math.min(8, n); k++) tent(ctx, sx + ((k % 4) - 1.5) * L * 1.3, sy - (Math.ceil(n / cols) / 2 + 1.1) * L * 1.4 - (k >> 2) * L * 0.9, L * 0.42, rgb, k);
      }
      ctx.globalAlpha = 1;
    } else if (strip > 0.01 && !naval) {
      // a strip of unit marks beneath the banner
      const m = clamp(Math.round(Math.log10(Math.max(10, str)) * 1.3) - 1, 1, 5);
      const L = clamp(s * 0.62, 4, 8);
      for (let k = 0; k < m; k++) block(ctx, sx - ((m - 1) / 2 - k) * L * 1.05 + s * 0.35, sy + s * 0.55, Math.PI / 2, L, rgb, armsOf(era, k, m, h), era, strip);
    }
    // the banner, ragged when the host's heart fails
    const sp = bannerSprite(r.sprites, rgb, s, dpr, naval && host < 0.5);
    ctx.globalAlpha = naval && host >= 0.5 ? 0.85 : 1;
    ctx.drawImage(sp.canvas, bannerX - sp.ox, bannerY - sp.oy, sp.w, sp.h);
    if ((a.morale ?? 1) < 0.4 && !naval) {
      // tatters: bites out of the fly
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); ctx.moveTo(bannerX + s * 0.98, bannerY - s * 1.85); ctx.lineTo(bannerX + s * 0.55, bannerY - s * 1.55); ctx.lineTo(bannerX + s * 1.0, bannerY - s * 1.3); ctx.closePath(); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
    r.hits.push({ kind: 'army', id: a.id, x0: bannerX - s * 0.6, y0: bannerY - s * 2.1, x1: bannerX + s * 1.1, y1: bannerY + s * 0.4, pri: 4 });
    if (host > 0.5) r.hits.push({ kind: 'army', id: a.id, x0: sx - z * 0.3, y0: sy - z * 0.3, x1: sx + z * 0.3, y1: sy + z * 0.3, pri: 3.5 });
    // a host on the move is lettered around the still map (its label placed afresh every frame);
    // one camped, garrisoned or at a siege stands with the towns, by priority
    const mv = a.state === 'marching' || a.state === 'returning' || a.state === 'retreating';
    (mv && labels.dynBlocks ? labels.dynBlocks : labels.blocks).push([bannerX - s * 0.4, bannerY - s * 2, bannerX + s * 1.0, bannerY + 2]);
    if (z >= 5 && str > 0 && r.overlays.labels) {
      // strength, lettered through the label placer so neighbouring armies do not overprint
      const fs = Math.max(9.5, Math.min(12, 8 + z * 0.14));
      labels.push({ pri: selected ? 58 : 36 + Math.log10(str + 1), text: fmtStrength(str), x: bannerX + 1, y: bannerY + fs * 0.7 + 3, alt: fs * 1.1, overPlan: true, dyn: mv,
        st: { size: fs, bold: true, figures: true, color: 'rgb(30,22,16)', halo: 'rgba(248,240,220,0.9)', haloW: 2.2 } });
      const gname = a.general && typeof a.general === 'object' ? a.general.name : a.general;
      if (z >= 24 && gname) {
        labels.push({ pri: selected ? 50 : 26, text: String(gname), x: bannerX + 1, y: bannerY + fs * 1.9 + 5, overPlan: true, dyn: mv, st: { size: Math.max(9, fs * 0.85), italic: true, color: 'rgb(48,36,26)', halo: 'rgba(248,240,220,0.85)', haloW: 2 } });
      }
    }
  }
  ctx.globalAlpha = 1;
}
