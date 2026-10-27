// Highlights: what the viewer's hand is about to touch, and what the interface points at.
// A god tool's hover preview (renderer.setToolPreview with previewTool's result) puts a
// rotating dashed reticle and name tag on each town, army or other thing it would strike, an
// outline round each realm it would touch tinted by its tone (gold for a blessing, crimson for
// a curse), its danger rings (crater and blast, quake reach, lava), threads between the
// nations it would set against or beside each other, and a red slash over the brush when the
// act cannot be done here. renderer.setHighlights rings any places with optional lettering, and
// the selection kinds { kind: 'civs', ids } and { kind: 'box', x0, y0, x1, y1 } outline several
// realms or a region; a war that is selected or watched has its sides outlined and its front
// drawn (drawFronts). Screen and world passes; purely cosmetic.

import { traceEdges, edgesToPath } from './vectors.js';
import { tierRadius } from './entities.js';
import { footprints } from './cityplan.js';
import { css } from './palette.js';

const TAU = Math.PI * 2;
/** Tone → [r, g, b]. */
const TONE = {
  bane: [214, 58, 50], danger: [214, 58, 50], curse: [196, 46, 80], hate: [214, 58, 50], war: [214, 58, 50],
  boon: [240, 198, 96], bless: [240, 198, 96], peace: [236, 240, 236], trade: [226, 176, 70],
  alliance: [104, 160, 226], marriage: [230, 150, 180], neutral: [232, 226, 206], info: [140, 210, 220],
};
export const toneRgb = (t, fallback = TONE.neutral) => (Array.isArray(t) ? t : TONE[t] || fallback);

/** A realm's rounded outline from the border vote grid (cached by the border network's key). */
function realmPath(r, id) {
  if (!r._bvote) return null;
  const key = `${id}|${r.vec.borderKey}`;
  r._realmPaths = r._realmPaths || new Map();
  let p = r._realmPaths.get(key);
  if (p) return p;
  const pix = r._bvote.pix, BF = r._bvote.F;
  p = edgesToPath(traceEdges(r._bvote.cw, r._bvote.ch, (i, j) => (pix[i] === id) !== (j >= 0 && pix[j] === id), true), 2, null, 1 / BF);
  r._realmPaths.set(key, p);
  if (r._realmPaths.size > 48) r._realmPaths.delete(r._realmPaths.keys().next().value);
  return p;
}

/** Where a preview target or highlight stands: { x, y, rad (screen px), name } or null. */
function targetPlace(r, t) {
  const w = r.world, z = r.camera.zoom;
  const id = t.id;
  switch (t.kind) {
    case 'settlement': {
      const s = w.settlements[id];
      if (!s) return null;
      const fp = footprints(r).byId.get(s.id);
      const planR = r._planAlpha?.get(s.id) > 0.5 && fp ? fp.r * z : 0;
      return { x: s.x, y: s.y, rad: Math.max(tierRadius(s.tier || 0, z) * 1.6 + 6, planR * 1.08), name: s.name };
    }
    case 'army': { const a = (w.armies || []).find((q) => q && q.id === id); return a ? { x: a.x, y: a.y, rad: 16, name: null } : null; }
    case 'band': { const b = (w.bands || []).find((q) => q && q.id === id); return b ? { x: b.x, y: b.y, rad: 16, name: b.name || null } : null; }
    case 'volcano': { const v = (w.volcanoes || []).find((q) => q && q.id === id); return v ? { x: v.x, y: v.y, rad: Math.max(12, z * 0.5), name: v.name || null } : null; }
    case 'storm': { const s = (w.storms || []).find((q) => q && q.id === id); return s ? { x: s.x, y: s.y, rad: Math.max(14, (s.radius || 3) * z * 0.4), name: s.name || null } : null; }
    case 'site': { const s = (w.sites || []).find((q) => q && q.id === id); return s ? { x: s.x, y: s.y, rad: 12, name: s.name || null } : null; }
    case 'wonder': { const wd = (w.wonders || [])[id]; const s = wd ? w.settlements[wd.sid] : null; return s ? { x: s.x, y: s.y, rad: 18, name: wd.name || null } : null; }
    case 'tile': {
      const x = Number.isFinite(t.x) ? t.x : Number.isFinite(id) ? id % w.W : null, y = Number.isFinite(t.y) ? t.y : Number.isFinite(id) ? (id / w.W) | 0 : null;
      return x == null ? null : { x, y, rad: Math.max(6, z * 0.6), name: null, tile: true };
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// A war's front (chunk 10, docs/design/seeing-and-hand.md): while a war is selected or on the
// watchlist (world.ui.watch), each side's realms are outlined in its leader's colour, the
// border between the two sides is drawn as the front, and the towns its armies besiege ringed.

const hexRgb = (hex) => { const v = parseInt(String(hex || '#c9a466').replace('#', ''), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };

/** The active wars to draw: the selected one and the watched ones (at most four). */
function frontWars(r) {
  const w = r.world, sel = r.selection, out = [];
  const add = (id) => { const war = w.wars && w.wars[id]; if (war && war.active && !out.includes(war)) out.push(war); };
  if (sel && sel.kind === 'war') add(sel.id);
  const wl = w.ui && Array.isArray(w.ui.watch) ? w.ui.watch : [];
  for (const q of wl) if (q && q.kind === 'war') add(q.id);
  return out.slice(0, 4);
}

/** The border between a war's two sides, from the border vote grid (cached by sides and borders). */
function frontPath(r, war) {
  if (!r._bvote) return null;
  const key = `${war.id}|${war.attackers.join(',')}|${war.defenders.join(',')}|${r.vec.borderKey}`;
  r._frontPaths = r._frontPaths || new Map();
  let p = r._frontPaths.get(key);
  if (p !== undefined) return p;
  const A = new Set(war.attackers), D = new Set(war.defenders);
  const pix = r._bvote.pix, BF = r._bvote.F;
  const chains = traceEdges(r._bvote.cw, r._bvote.ch, (i, j) => j >= 0 && ((A.has(pix[i]) && D.has(pix[j])) || (D.has(pix[i]) && A.has(pix[j]))), false);
  p = chains.length ? edgesToPath(chains, 1, null, 1 / BF) : null;
  r._frontPaths.set(key, p);
  if (r._frontPaths.size > 16) r._frontPaths.delete(r._frontPaths.keys().next().value);
  return p;
}

function drawFronts(r, ctx, z) {
  const w = r.world;
  const wars = frontWars(r);
  if (!wars.length) return;
  for (const war of wars) {
    const lead = (ids) => { for (const id of ids) { const c = w.civs[id]; if (c && c.alive) return c; } return null; };
    const sides = [[war.attackers, lead(war.attackers)], [war.defenders, lead(war.defenders)]];
    for (const [ids, leader] of sides) {
      const rgb = hexRgb(leader && leader.colorHex);
      for (const id of ids.slice(0, 12)) {
        const c = w.civs[id];
        if (!c || !c.alive) continue;
        const path = realmPath(r, id);
        if (!path) continue;
        ctx.fillStyle = css(rgb, 0.07); ctx.fill(path);
        ctx.strokeStyle = css(rgb, 0.75); ctx.lineWidth = 1.6 / z; ctx.stroke(path);
      }
    }
    // the front itself: a dark band, then the two sides' colours in alternating dashes
    const fp = frontPath(r, war);
    if (fp) {
      ctx.strokeStyle = 'rgba(16,10,8,0.6)'; ctx.lineWidth = 6 / z; ctx.stroke(fp);
      ctx.lineWidth = 3 / z;
      ctx.setLineDash([6 / z, 6 / z]);
      ctx.strokeStyle = css(hexRgb(sides[0][1] && sides[0][1].colorHex), 0.95); ctx.lineDashOffset = -r.now * 0.006 / z; ctx.stroke(fp);
      ctx.strokeStyle = css(hexRgb(sides[1][1] && sides[1][1].colorHex), 0.95); ctx.lineDashOffset = -r.now * 0.006 / z + 6 / z; ctx.stroke(fp);
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
    // towns under siege by the war's armies
    for (const a of w.armies || []) {
      if (!a || a.warId !== war.id || a.targetId == null) continue;
      const s = w.settlements[a.targetId];
      if (!s || !s.alive || !s.siege || s.siege.armyId !== a.id) continue;
      ctx.strokeStyle = css(hexRgb(w.civs[a.civId] && w.civs[a.civId].colorHex), 0.9); ctx.lineWidth = 2 / z;
      ctx.setLineDash([3 / z, 3 / z]); ctx.lineDashOffset = -r.now * 0.01 / z;
      ctx.beginPath(); ctx.arc(s.x, s.y, 1.6, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
  }
}

/** World pass (entity-coordinate transform): realm outlines (preview and civs selection), box selection, war fronts. */
export function drawHighlightsWorld(r, ctx, z) {
  const sel = r.selection, p = r.toolPreview;
  const pulse = 0.75 + 0.25 * Math.sin(r.now * 0.004);
  ctx.lineJoin = 'round';
  drawFronts(r, ctx, z);
  // several realms selected at once
  if (sel && sel.kind === 'civs' && Array.isArray(sel.ids)) {
    for (const id of sel.ids.slice(0, 24)) {
      const path = realmPath(r, id);
      if (!path) continue;
      ctx.strokeStyle = `rgba(255,236,170,${0.32 * pulse})`; ctx.lineWidth = 6 / z; ctx.stroke(path);
      ctx.strokeStyle = 'rgba(214,172,92,0.95)'; ctx.lineWidth = 2 / z; ctx.stroke(path);
    }
  }
  // a region boxed out
  if (sel && sel.kind === 'box' && [sel.x0, sel.y0, sel.x1, sel.y1].every(Number.isFinite)) {
    const x0 = Math.min(sel.x0, sel.x1) - 0.5, y0 = Math.min(sel.y0, sel.y1) - 0.5, x1 = Math.max(sel.x0, sel.x1) + 0.5, y1 = Math.max(sel.y0, sel.y1) + 0.5;
    ctx.fillStyle = 'rgba(255,236,170,0.06)'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = 'rgba(20,14,8,0.5)'; ctx.lineWidth = 3 / z; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = 'rgba(240,206,120,0.95)'; ctx.lineWidth = 1.4 / z;
    ctx.setLineDash([6 / z, 4 / z]); ctx.lineDashOffset = -r.now * 0.01 / z; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]); ctx.lineDashOffset = 0;
    // corner brackets
    const L = Math.min((x1 - x0) * 0.2, (y1 - y0) * 0.2, 18 / z);
    ctx.lineWidth = 3 / z; ctx.strokeStyle = 'rgb(240,206,120)';
    ctx.beginPath();
    for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]]) { ctx.moveTo(cx + sx * L, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + sy * L); }
    ctx.stroke();
  }
  // the realms a tool would touch, outlined in its tone
  if (p && Array.isArray(p.targets)) {
    const rgb = toneRgb(p.tone || p.polarity, p.ok === false ? TONE.danger : TONE.neutral);
    for (const t of p.targets) {
      if (!t || t.kind !== 'civ') continue;
      const path = realmPath(r, t.id);
      if (!path) continue;
      ctx.strokeStyle = css(rgb, 0.3 * pulse); ctx.lineWidth = 7 / z; ctx.stroke(path);
      ctx.strokeStyle = css(rgb, 0.95); ctx.lineWidth = 2 / z;
      ctx.setLineDash([7 / z, 4 / z]); ctx.lineDashOffset = -r.now * 0.012 / z; ctx.stroke(path); ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
  }
}

/** A rotating dashed reticle with an optional name tag (screen space). */
function reticle(r, ctx, sx, sy, rad, rgb, name, square = false) {
  const t = r.now * 0.0025;
  ctx.lineWidth = 3.2; ctx.strokeStyle = 'rgba(14,10,8,0.55)';
  if (square) { ctx.strokeRect(sx - rad, sy - rad, rad * 2, rad * 2); } else { ctx.beginPath(); ctx.arc(sx, sy, rad, 0, TAU); ctx.stroke(); }
  ctx.strokeStyle = css(rgb); ctx.lineWidth = 1.8;
  ctx.setLineDash([rad * 0.42, rad * 0.24]); ctx.lineDashOffset = -t * rad * 2;
  if (square) ctx.strokeRect(sx - rad, sy - rad, rad * 2, rad * 2); else { ctx.beginPath(); ctx.arc(sx, sy, rad, 0, TAU); ctx.stroke(); }
  ctx.setLineDash([]); ctx.lineDashOffset = 0;
  // four ticks closing in
  const k = 1 + 0.12 * Math.sin(r.now * 0.008);
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (let q = 0; q < 4; q++) { const a = t * 0.6 + q * Math.PI / 2; ctx.moveTo(sx + Math.cos(a) * (rad + 3) * k, sy + Math.sin(a) * (rad + 3) * k); ctx.lineTo(sx + Math.cos(a) * (rad + 9) * k, sy + Math.sin(a) * (rad + 9) * k); }
  ctx.stroke();
  if (name) {
    const sp = r.labeler.sprite(name, { size: 11, italic: true, color: 'rgb(250,240,214)', halo: 'rgba(14,10,8,0.82)', haloW: 3 });
    ctx.globalAlpha = 0.95; ctx.drawImage(sp.canvas, sx - sp.w / 2, sy - rad - 12 - sp.h / 2, sp.w, sp.h); ctx.globalAlpha = 1;
  }
}

/** Screen pass: reticles on targets, danger rings, threads, the invalid slash, highlight rings. */
export function drawHighlightsScreen(r, ctx, z) {
  const p = r.toolPreview;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (p) {
    const bad = p.ok === false;
    const rgb = toneRgb(p.tone || p.polarity, bad ? TONE.danger : TONE.neutral);
    // danger rings: crater and blast, quake reach, lava …
    for (const g of Array.isArray(p.rings) ? p.rings.slice(0, 12) : []) {
      if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y) || !(g.r > 0)) continue;
      const { sx, sy } = r.e2s(g.x, g.y);
      const R = g.r * z;
      const c = toneRgb(g.tone, rgb);
      ctx.fillStyle = css(c, 0.08); ctx.beginPath(); ctx.arc(sx, sy, R, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(14,10,8,0.45)'; ctx.lineWidth = 3; ctx.stroke();
      ctx.strokeStyle = css(c, 0.95); ctx.lineWidth = 1.6; ctx.setLineDash([8, 5]); ctx.lineDashOffset = r.now * 0.02; ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
    // threads between the realms it would bind or divide
    for (const th of Array.isArray(p.threads) ? p.threads.slice(0, 16) : []) {
      if (!th || ![th.x0, th.y0, th.x1, th.y1].every(Number.isFinite)) continue;
      const a = r.e2s(th.x0, th.y0), b = r.e2s(th.x1, th.y1);
      const c = toneRgb(th.tone, rgb);
      const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2 - Math.min(60, Math.hypot(b.sx - a.sx, b.sy - a.sy) * 0.2);
      ctx.strokeStyle = 'rgba(14,10,8,0.5)'; ctx.lineWidth = 4.5;
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.quadraticCurveTo(mx, my, b.sx, b.sy); ctx.stroke();
      ctx.strokeStyle = css(c); ctx.lineWidth = 2;
      ctx.setLineDash([9, 6]); ctx.lineDashOffset = -r.now * 0.03; ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
      // arrowhead at the far end
      const ang = Math.atan2(b.sy - my, b.sx - mx);
      ctx.fillStyle = css(c); ctx.beginPath(); ctx.moveTo(b.sx, b.sy); ctx.lineTo(b.sx - Math.cos(ang - 0.4) * 10, b.sy - Math.sin(ang - 0.4) * 10); ctx.lineTo(b.sx - Math.cos(ang + 0.4) * 10, b.sy - Math.sin(ang + 0.4) * 10); ctx.closePath(); ctx.fill();
    }
    // reticles on everything it would strike
    let n = 0;
    for (const t of Array.isArray(p.targets) ? p.targets : []) {
      if (!t || t.kind === 'civ') continue;
      if (++n > 24) break;
      const pl = targetPlace(r, t);
      if (!pl) continue;
      const { sx, sy } = r.e2s(pl.x, pl.y);
      if (sx < -60 || sy < -60 || sx > r.viewW + 60 || sy > r.viewH + 60) continue;
      reticle(r, ctx, sx, sy, pl.rad, rgb, n <= 6 ? pl.name : null, pl.tile);
    }
    // cannot be done here: the brush goes red and is struck through
    if (bad && r.brush) {
      const { sx, sy } = r.e2s(r.brush.x, r.brush.y);
      const R = Math.max(10, (r.brush.radius + 0.5) * z);
      ctx.strokeStyle = 'rgba(14,10,8,0.6)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(sx - R * 0.7, sy + R * 0.7); ctx.lineTo(sx + R * 0.7, sy - R * 0.7); ctx.stroke();
      ctx.strokeStyle = 'rgb(220,64,52)'; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(sx, sy, R, 0, TAU); ctx.moveTo(sx - R * 0.7, sy + R * 0.7); ctx.lineTo(sx + R * 0.7, sy - R * 0.7); ctx.stroke();
    }
  }
  // highlight rings asked for by the interface
  for (const h of r.highlights || []) {
    const { sx, sy } = r.e2s(h.x, h.y);
    const R = Math.max(8, (Number(h.r) > 0 ? h.r : 0.6) * z);
    if (sx < -R - 40 || sy < -R - 40 || sx > r.viewW + R + 40 || sy > r.viewH + R + 40) continue;
    const c = toneRgb(h.tone, TONE.boon);
    const pulse = 0.5 + 0.5 * Math.sin(r.now * 0.006 + h.x);
    ctx.strokeStyle = 'rgba(14,10,8,0.5)'; ctx.lineWidth = 3.4; ctx.beginPath(); ctx.arc(sx, sy, R + pulse * 3, 0, TAU); ctx.stroke();
    ctx.strokeStyle = css(c, 0.95); ctx.lineWidth = 1.8; ctx.stroke();
    if (h.label) {
      const sp = r.labeler.sprite(String(h.label), { size: 11, italic: true, color: 'rgb(250,240,214)', halo: 'rgba(14,10,8,0.82)', haloW: 3 });
      ctx.drawImage(sp.canvas, sx - sp.w / 2, sy - R - 12 - sp.h / 2, sp.w, sp.h);
    }
  }
}

/** True when the brush should draw as refused (the preview says the act cannot be done). */
export const previewRefused = (r) => Boolean(r.toolPreview && r.toolPreview.ok === false);
