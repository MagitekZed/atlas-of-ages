// The neatline: the engraved frame around the map (docs/design/ui/kit/IDENTITY.md §8.2). A 16px
// band of the table's ground at the canvas edge carries a graduated bar of alternating degree
// segments, a fine keyline outside it and the 1.5px neatline inside it, with the degree lettered
// every third segment. It is measured from the camera, so it slides and rescales with the view:
// 10° segments over the whole world, finer as you zoom in. The selection gets a brass index on
// the top and left bands at its longitude and latitude.
//
// Latitude runs 90° N at the top row to 90° S at the bottom (core/world.js latitude), longitude
// 180° W to 180° E across the width.

import { registerLayer } from './layers.js';

export const NEAT = 16;                      // band width, CSS px
const STEPS = [30, 15, 10, 5, 2, 1, 0.5, 0.25];
const INK = '237, 227, 203';
const GROUND = '#0a1017';
const BRASS = '#e8cb90';
const FONT = '500 11px "Alegreya Sans", "Gill Sans", "Trebuchet MS", sans-serif';

const fmt = (v, pos, neg) => {
  const a = Math.round(Math.abs(v) * 100) / 100;
  return a === 0 ? '0°' : `${a}° ${v > 0 ? pos : neg}`;
};
const lonText = (v) => fmt(v, 'E', 'W');
const latText = (v) => fmt(v, 'N', 'S');

/** The finest degree step whose segments are at least 30px long at this scale (so 30–80px). */
function stepFor(pxPerDeg) {
  for (let i = STEPS.length - 1; i >= 0; i--) if (STEPS[i] * pxPerDeg >= 30) return STEPS[i];
  return STEPS[0];
}

/** Where the selection stands, in entity coordinates, or null. */
function selectionPoint(r) {
  const sel = r.selection, w = r.world;
  if (!sel || !w) return null;
  if (sel.kind === 'settlement') { const s = w.settlements[sel.id]; return s ? { x: s.x, y: s.y } : null; }
  if (sel.kind === 'army') { const a = w.armies.find((q) => q.id === sel.id); return a ? { x: a.x, y: a.y } : null; }
  if (sel.kind === 'storm') { const s = w.storms.find((q) => q.id === sel.id); return s ? { x: s.x, y: s.y } : null; }
  if (sel.kind === 'civ') {
    const c = w.civs?.[sel.id], cap = c && Number.isFinite(c.capital) ? w.settlements[c.capital] : null;
    if (cap) return { x: cap.x, y: cap.y };
  }
  return Number.isFinite(sel.x) && Number.isFinite(sel.y) ? { x: sel.x, y: sel.y } : null;
}

/**
 * One side's graduation, in a frame where x runs along the band (0..len) and y = 0 is the
 * band's outer edge. `posOf(deg)` is the position of a degree along the band; `lo..hi` are the
 * degrees the world covers. Returns the lettering to place (positions along the band).
 */
function graduate(ctx, len, degAt, posOf, lo, hi, text, idxDeg) {
  const d0 = degAt(0), d1 = degAt(len);
  const dmin = Math.max(lo, Math.min(d0, d1)), dmax = Math.min(hi, Math.max(d0, d1));
  if (!(dmax > dmin)) return { labels: [], idx: null };
  const step = stepFor(Math.abs(len / (d1 - d0)));
  ctx.fillStyle = `rgba(${INK}, 0.55)`;
  const labels = [];
  for (let k = Math.floor(dmin / step); k * step < dmax; k++) {
    const pa = posOf(Math.max(dmin, k * step)), pb = posOf(Math.min(dmax, (k + 1) * step));
    if (((k % 2) + 2) % 2 === 0) ctx.fillRect(Math.min(pa, pb), 6.5, Math.abs(pb - pa), 4);
    const deg = k * step;
    if (k % 3 === 0 && deg >= lo && deg <= hi) labels.push({ p: posOf(deg), t: text(deg) });
  }
  const pmin = Math.min(posOf(dmin), posOf(dmax)), pmax = Math.max(posOf(dmin), posOf(dmax));
  ctx.strokeStyle = `rgba(${INK}, 0.55)`; ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.moveTo(pmin, 6.5); ctx.lineTo(pmax, 6.5); ctx.moveTo(pmin, 10.5); ctx.lineTo(pmax, 10.5);
  ctx.stroke();
  let idx = null;
  if (idxDeg != null && idxDeg >= dmin && idxDeg <= dmax) {
    const p = posOf(idxDeg);
    if (p > NEAT + 6 && p < len - NEAT - 6) {
      // the brass index: its tip touches the neatline
      ctx.fillStyle = BRASS;
      ctx.beginPath(); ctx.moveTo(p - 5, 6); ctx.lineTo(p + 5, 6); ctx.lineTo(p, 14.5); ctx.closePath(); ctx.fill();
      idx = { p, t: text(idxDeg) };
    }
  }
  return { labels, idx };
}

/** Letter one side upright: `at(p)` gives the label's centre and rotation in screen space. */
function letter(ctx, len, res, at) {
  ctx.font = FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  const keep = (p) => p > 34 && p < len - 34;
  const idxW = res.idx ? ctx.measureText(res.idx.t).width + 8 : 0;
  // the index's value sits beside it, on the side with room
  const idxP = res.idx ? (res.idx.p + 9 + idxW > len - NEAT - 4 ? res.idx.p - 9 - idxW / 2 : res.idx.p + 9 + idxW / 2) : null;
  const put = (p, t, colour) => {
    const w = ctx.measureText(t).width + 8, [x, y, rot] = at(p);
    ctx.save(); ctx.translate(x, y); if (rot) ctx.rotate(rot);
    ctx.fillStyle = GROUND; ctx.fillRect(-w / 2, -6, w, 12);
    ctx.fillStyle = colour; ctx.fillText(t, 0, 0.5);
    ctx.restore();
  };
  for (const { p, t } of res.labels) {
    if (!keep(p)) continue;
    if (idxP != null && Math.abs(p - idxP) < idxW / 2 + 40) continue;
    put(p, t, `rgba(${INK}, 0.8)`);
  }
  if (res.idx) put(idxP, res.idx.t, BRASS);
}

export function drawNeatline(r, ctx) {
  const w = r.world, cam = r.camera;
  if (!w || !cam) return;
  const W = r.viewW, H = r.viewH, N = NEAT;
  const lonAt = (sx) => -180 + 360 * cam.screenToWorld(sx, 0).x / w.W;
  const xOfLon = (lon) => cam.worldToScreen((lon + 180) / 360 * w.W, 0).sx;
  const latAt = (sy) => 90 - 180 * cam.screenToWorld(0, sy).y / w.H;
  const yOfLat = (lat) => cam.worldToScreen(0, (90 - lat) / 180 * w.H).sy;
  const sp = selectionPoint(r);
  const selLon = sp ? -180 + 360 * (sp.x + 0.5) / w.W : null;
  const selLat = sp ? 90 - 180 * (sp.y + 0.5) / w.H : null;

  ctx.save();
  // the band, over the map's edge
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, W, N); ctx.fillRect(0, H - N, W, N);
  ctx.fillRect(0, N, N, H - 2 * N); ctx.fillRect(W - N, N, N, H - 2 * N);
  ctx.strokeStyle = `rgba(${INK}, 0.3)`; ctx.lineWidth = 1;
  ctx.strokeRect(2.5, 2.5, W - 5, H - 5);

  // each side in its own frame: x along the band, y = 0 at the outer edge
  const sides = [
    { len: W, frame: () => {}, degAt: lonAt, posOf: xOfLon, lo: -180, hi: 180, text: lonText, idx: selLon, at: (p) => [p, 8.5, 0] },
    { len: W, frame: () => { ctx.translate(0, H); ctx.scale(1, -1); }, degAt: lonAt, posOf: xOfLon, lo: -180, hi: 180, text: lonText, idx: null, at: (p) => [p, H - 8.5, 0] },
    { len: H, frame: () => { ctx.rotate(Math.PI / 2); ctx.scale(1, -1); }, degAt: latAt, posOf: yOfLat, lo: -90, hi: 90, text: latText, idx: selLat, at: (p) => [8.5, p, -Math.PI / 2] },
    { len: H, frame: () => { ctx.translate(W, 0); ctx.rotate(Math.PI / 2); }, degAt: latAt, posOf: yOfLat, lo: -90, hi: 90, text: latText, idx: null, at: (p) => [W - 8.5, p, Math.PI / 2] },
  ];
  for (const sd of sides) {
    ctx.save();
    sd.frame();
    ctx.beginPath(); ctx.rect(N, 0, sd.len - 2 * N, N); ctx.clip();
    const res = graduate(ctx, sd.len, sd.degAt, sd.posOf, sd.lo, sd.hi, sd.text, sd.idx);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    letter(ctx, sd.len, res, sd.at);
    ctx.restore();
  }
  // the neatline itself, then the corner squares
  ctx.strokeStyle = `rgba(${INK}, 0.85)`; ctx.lineWidth = 1.5;
  ctx.strokeRect(N - 0.75, N - 0.75, W - 2 * N + 1.5, H - 2 * N + 1.5);
  ctx.fillStyle = `rgba(${INK}, 0.55)`;
  for (const [x, y] of [[6.5, 6.5], [W - 10.5, 6.5], [6.5, H - 10.5], [W - 10.5, H - 10.5]]) ctx.fillRect(x, y, 4, 4);
  ctx.restore();
}

registerLayer({ id: 'neatline', slot: 'hud', order: 1000, draw: (r, ctx) => drawNeatline(r, ctx) });
