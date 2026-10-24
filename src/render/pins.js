// Event pins (WP8): where did that happen? The Chronicle's major entries (importance 3+) of
// the last 25 sim-years stand on the map as small pins in their category's colour, fading
// with age; an epochal one wears a gilded ring. Viewing a past plate in the Atlas shows that
// decade's events instead. Pins that would overlap at the current zoom gather into one
// numbered medallion. Pins and medallions stand on a stem above their place, never on it, so
// a click on a town still selects the town; once a town's ground plan has taken over (close
// zoom) they stand above its walls. Each pin or medallion is clickable (hit kind 'pin'): the UI
// resolves it through pinTarget(id) — one entry, or a cluster to open.
// Drawn in the overUnits slot while the 'events' overlay is on (the UI registers the toggle).
// Never imports ./renderer.js.

import { registerLayer } from './layers.js';
import { CATEGORIES, DAYS_PER_YEAR } from '../core/constants.js';
import { footprints } from './cityplan.js';
import { settlementAt } from '../core/entities.js';

const WINDOW_YEARS = 25;
const MAX_PINS = 140;
const CELL = 28;            // clustering cell, CSS px
const R = 6;

let cache = { key: '', list: [] };      // candidate entries with positions
let lastFrame = new Map();              // hit id → { seqs, x, y } from the last frame drawn

/** What a pin hit stands for: { seqs: [entry seq…], x, y } (entity coords), or null. */
export function pinTarget(id) {
  return lastFrame.get(String(id)) || null;
}

/** The Atlas plate on view: drawn over today's map (past) or in its place (snapshot). */
const plateOf = (r) => r.past || r.snapshot;

function candidates(r) {
  const w = r.world;
  if (!w) return [];
  const snap = plateOf(r);
  const key = `${w.seed}|${w.chronicle.seq}|${snap ? snap.y : 'live'}|${Math.floor(w.time.day / DAYS_PER_YEAR)}`;
  if (cache.key === key) return cache.list;
  const es = w.chronicle.entries;
  let from, to;
  if (snap && Number.isFinite(snap.y)) { to = snap.y * DAYS_PER_YEAR; from = to - 10 * DAYS_PER_YEAR; }
  else { to = Infinity; from = w.time.day - WINDOW_YEARS * DAYS_PER_YEAR; }
  const list = [];
  for (let k = es.length - 1; k >= 0 && list.length < MAX_PINS; k--) {
    const e = es[k];
    if (e.day < from) break;
    if (e.day > to || e.imp < 3 || e.fold) continue;
    let x = e.x, y = e.y;
    const s = e.sid != null ? w.settlements[e.sid] : null;
    if (!(Number.isFinite(x) && Number.isFinite(y))) {
      if (!s) continue;
      x = s.x; y = s.y;
    }
    // the town it happened in (when it happened at the town), to stand above its plan up close
    let sid = s && Math.abs(s.x - x) < 1 && Math.abs(s.y - y) < 1 ? s.id : null;
    if (sid == null) {
      const tx = Math.round(x), ty = Math.round(y);
      const at = tx >= 0 && ty >= 0 && tx < w.W && ty < w.H ? settlementAt(w, ty * w.W + tx) : null;
      if (at && at.alive) sid = at.id;
    }
    list.push({ seq: e.seq, x, y, imp: e.imp, cat: e.cat, day: e.day, sid });
  }
  cache = { key, list };
  return list;
}

function draw(r, ctx, env) {
  if (!r.overlays || !r.overlays.events) { lastFrame = new Map(); return; }
  const w = r.world;
  const list = candidates(r);
  const frame = new Map();
  if (!list.length) { lastFrame = frame; return; }
  const plate = plateOf(r);
  const now = plate && Number.isFinite(plate.y) ? plate.y * DAYS_PER_YEAR : w.time.day;
  const span = (plate ? 10 : WINDOW_YEARS) * DAYS_PER_YEAR;
  const vw = r.viewW, vh = r.viewH;
  const z = r.camera?.zoom || 1;
  // a town drawn as its ground plan: the pin stands above the plan's edge rather than on it
  const planTop = (sid) => {
    if (sid == null || !r._planAlpha || !((r._planAlpha.get(sid) || 0) > 0.5)) return null;
    const fp = footprints(r).byId.get(sid);
    if (!fp) return null;
    const c = r.e2s(fp.x, fp.y);
    // on the walls up and to the right: the town's name stands above them
    return c ? { sx: c.sx + fp.r * z * 0.7071, sy: c.sy - fp.r * z * 0.7071 } : null;
  };
  // bin by screen cell (greedy)
  const bins = new Map();
  for (const p of list) {
    const s = r.e2s(p.x, p.y);
    if (!s || s.sx < -20 || s.sy < -20 || s.sx > vw + 20 || s.sy > vh + 20) continue;
    const k = Math.floor(s.sx / CELL) + ':' + Math.floor(s.sy / CELL);
    let b = bins.get(k);
    if (!b) { b = { pins: [], sx: 0, sy: 0 }; bins.set(k, b); }
    b.pins.push({ ...p, sx: s.sx, sy: s.sy });
  }
  const pri = 3;
  let n = 0;
  for (const b of bins.values()) {
    b.pins.sort((a, c) => c.imp - a.imp || c.day - a.day);
    const top = b.pins[0];
    // the place the stem points at: the pin's own place, a cluster's centre, or the top of a town's plan
    let px = 0, py = 0;
    for (const p of b.pins) { px += p.sx; py += p.sy; }
    px /= b.pins.length; py /= b.pins.length;
    if (b.pins.length === 1) { px = top.sx; py = top.sy; }
    const pt = planTop(top.sid);
    if (pt && b.pins.every((p) => p.sid === top.sid)) { px = pt.sx; py = pt.sy; }
    const rr = b.pins.length === 1 ? R : R + 3 + Math.min(5, Math.log2(b.pins.length));
    const sx = px, sy = py - rr - 6;
    const age = Math.max(0, Math.min(1, (now - top.day) / span));
    const alpha = 1 - age * 0.6;
    const color = (CATEGORIES[top.cat] || {}).color || '#c9a466';
    const id = b.pins.length === 1 ? String(top.seq) : `c${n++}`;
    ctx.globalAlpha = alpha;
    // a stem down to the place
    ctx.strokeStyle = 'rgba(15,12,8,0.75)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(sx, sy + rr - 1); ctx.lineTo(px, py); ctx.stroke();
    if (b.pins.length === 1) {
      // a pin: a disc in the category's colour
      ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(15,12,8,0.85)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(sx, sy, R * 0.38, 0, Math.PI * 2); ctx.fillStyle = 'rgba(243,234,210,0.9)'; ctx.fill();
      if (top.imp >= 5) { ctx.beginPath(); ctx.arc(sx, sy, R + 3, 0, Math.PI * 2); ctx.lineWidth = 1.6; ctx.strokeStyle = '#e8cb90'; ctx.stroke(); }
    } else {
      // a medallion: how many happened here
      ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(16,25,35,0.88)'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
      if (b.pins.some((p) => p.imp >= 5)) { ctx.beginPath(); ctx.arc(sx, sy, rr + 2.5, 0, Math.PI * 2); ctx.lineWidth = 1.2; ctx.strokeStyle = '#e8cb90'; ctx.stroke(); }
      ctx.fillStyle = '#ede3cb';
      ctx.font = '600 10px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(b.pins.length), sx, sy + 0.5);
    }
    ctx.globalAlpha = 1;
    // the disc alone answers clicks: the place under the stem stays the town's
    const hr = rr + 2;
    r.hits.push({ kind: 'pin', id, x0: sx - hr, y0: sy - hr, x1: sx + hr, y1: sy + hr, pri });
    frame.set(id, { seqs: b.pins.map((p) => p.seq), x: top.x, y: top.y });
  }
  lastFrame = frame;
}

registerLayer({ id: 'story.pins', slot: 'overUnits', order: 60, draw });
