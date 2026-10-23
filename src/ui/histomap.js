// Histomap: the stream of empires, after John Sparks' 1931 chart. Every nation is a coloured
// stream whose width is its share of humankind (or of the claimed land) in each year; breakaway
// realms flow beside the parents they split from, so colour continuity reads as lineage. An era
// strip runs along the top, epochal events are pinned above the streams, and each stream is
// named where it runs widest. Hover reads a year; a click selects the nation and travels the
// Atlas and Chronicle to that year. Drawn from world.history.years (the itemised nations) and
// filled in from the entity ledger (sim/ledger.js) for nations not itemised in a record.
//
//   createHistomap(app) → { el, update(), redraw() }

import { DAYS_PER_YEAR, ERAS } from '../core/constants.js';
import { h, clear, cssVar } from './dom.js';
import { fitCanvas, chartTheme } from './charts.js';
import * as F from './format.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ERA_TINT = ['#7d6a52', '#b07a3c', '#7d8794', '#b59a5c', '#8a6f9e', '#5e8fa8', '#6c6c6c', '#3f7f8f'];

/** Nations in lineage order: roots by founding, each followed by the realms that broke from it. */
function lineageOrder(w, ids) {
  const set = new Set(ids);
  const kids = new Map();
  const roots = [];
  for (const id of ids) {
    const c = w.civs[id];
    let p = c?.parentId;
    while (p != null && !set.has(p)) p = w.civs[p]?.parentId ?? null;
    if (p == null) roots.push(id); else { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(id); }
  }
  const byFound = (a, b) => fin(w.civs[a]?.foundedDay) - fin(w.civs[b]?.foundedDay) || a - b;
  roots.sort(byFound);
  const out = [];
  const visit = (id) => { out.push(id); for (const k of (kids.get(id) || []).sort(byFound)) visit(k); };
  for (const r of roots) visit(r);
  return out;
}

/** A civ's people at a year from its ledger (nearest sample at or before), or NaN. */
function ledgerPop(w, id, year) {
  const raw = w.history?.series?.c?.[id];
  if (!raw || !Array.isArray(raw.v)) return NaN;
  const d = year * DAYS_PER_YEAR;
  if (d < raw.t0 || (raw.e != null && d > raw.e)) return NaN;
  const C = 10, n = Math.floor(raw.v.length / C);
  const k = Math.min(n - 1, Math.floor((d - raw.t0) / raw.st));
  return k >= 0 ? raw.v[k * C] : NaN;
}

export function createHistomap(app) {
  const canvas = h('canvas.histomap', { role: 'img', 'aria-label': 'The stream of empires' });
  const tipEl = h('div.chart-tip', { hidden: true });
  const modeSeg = h('div.seg', { role: 'group', 'aria-label': 'Measure' });
  let mode = 'pop';
  for (const [k, label] of [['pop', 'Share of people'], ['land', 'Share of land']]) {
    const b = h('button', { type: 'button', text: label, 'aria-pressed': String(k === mode) });
    b.addEventListener('click', () => { mode = k; for (const x of modeSeg.children) x.setAttribute('aria-pressed', String(x === b)); sig = ''; redraw(); });
    modeSeg.appendChild(b);
  }
  const caption = h('p.rec-caption');
  const el = h('figure.histomap-card', { style: { position: 'relative', margin: '0' } }, h('div.ch-head', null, h('span.ch-title', { text: 'The stream of empires' }), modeSeg), canvas, tipEl, caption);
  let sig = '', model = null;

  function build() {
    const w = app.world;
    const ys = w?.history?.years || [];
    if (ys.length < 3) return null;
    // which nations ever mattered: the itemised ones (and those whose ledgers say they lived)
    const ever = new Set();
    for (const r of ys) for (const id of Object.keys(r.civ || {})) ever.add(Number(id));
    const order = lineageOrder(w, [...ever]);
    const xs = ys.map((r) => r.y);
    const vals = order.map(() => new Float64Array(xs.length));
    const tot = new Float64Array(xs.length);
    let landTiles = 0;
    if (mode === 'land') for (let i = 0; i < w.N; i++) if (w.f.water[i] === 0) landTiles++;
    for (let k = 0; k < ys.length; k++) {
      const r = ys[k];
      let sum = 0;
      for (let j = 0; j < order.length; j++) {
        const id = order[j];
        const c = w.civs[id];
        let v = r.civ?.[id] ? (mode === 'pop' ? r.civ[id][0] : r.civ[id][1]) : NaN;
        if (!Number.isFinite(v) && mode === 'pop' && c && fin(c.foundedDay) <= r.y * DAYS_PER_YEAR && (c.alive || fin(c.fallenDay) >= r.y * DAYS_PER_YEAR)) v = ledgerPop(w, id, r.y);
        vals[j][k] = Number.isFinite(v) && v > 0 ? v : 0;
        sum += vals[j][k];
      }
      tot[k] = Math.max(1, mode === 'pop' ? Math.max(fin(r.pop), sum) : Math.max(sum, landTiles));
    }
    // drop streams too thin to ever see (they fold into "others")
    const keep = [];
    for (let j = 0; j < order.length; j++) { let mx = 0; for (let k = 0; k < xs.length; k++) mx = Math.max(mx, vals[j][k] / tot[k]); if (mx >= 0.012) keep.push(j); }
    const marks = [];
    for (const e of w.chronicle.entries) if (e.imp >= 5) marks.push({ y: F.yearOfDay(e.day), text: e.text });
    return { xs, ids: keep.map((j) => order[j]), vals: keep.map((j) => vals[j]), tot, eras: ys.map((r) => fin(r.era)), marks };
  }

  function redraw() {
    const w = app.world;
    if (!w || el.offsetParent === null) return;
    const ys = w.history?.years || [];
    const s = `${ys.length}:${ys[ys.length - 1]?.y}:${mode}:${canvas.clientWidth}`;
    if (s === sig && model) return;
    sig = s;
    model = build();
    const W = canvas.clientWidth || el.clientWidth || 360, H = Math.max(260, Math.min(520, Math.round(W * 0.78)));
    const ctx = fitCanvas(canvas, W, H);
    const t = chartTheme();
    if (!model) { ctx.fillStyle = t.ink3; ctx.font = t.mono; ctx.fillText('The stream begins once a few years of history are written.', 4, 24); caption.textContent = ''; return; }
    const { xs, ids, vals, tot, eras, marks } = model;
    const top = 18, eraH = 8, bot = 18, l = 2, r = 2;
    const pw = W - l - r, ph = H - top - eraH - bot - 4;
    const y0 = top + eraH + 4;
    const x0 = xs[0], x1 = xs[xs.length - 1];
    const X = (yr) => l + ((yr - x0) / Math.max(1, x1 - x0)) * pw;
    // era strip
    for (let k = 0; k < xs.length; k++) {
      const xa = X(xs[k]), xb = k + 1 < xs.length ? X(xs[k + 1]) : xa + 1;
      ctx.fillStyle = ERA_TINT[eras[k]] || ERA_TINT[0];
      ctx.fillRect(xa, top, Math.max(1, xb - xa + 0.5), eraH);
    }
    ctx.font = '10px "IM Fell English SC", Georgia, serif'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.fillStyle = t.ink3;
    let lastEra = -1, lastX = -1e9;
    for (let k = 0; k < xs.length; k++) if (eras[k] !== lastEra) { lastEra = eras[k]; const x = X(xs[k]); if (x - lastX > 60) { ctx.fillText(ERAS[eras[k]]?.name || '', Math.min(W - 70, x + 2), top - 4); lastX = x; } }
    // streams, from the bottom up ("others" at the bottom)
    const n = xs.length;
    const base = new Float64Array(n).fill(0);
    const bands = [];
    for (let j = 0; j < ids.length; j++) {
      const lo = base.slice();
      for (let k = 0; k < n; k++) base[k] += vals[j][k] / tot[k];
      bands.push({ id: ids[j], lo, hi: base.slice() });
    }
    const Y = (f) => y0 + ph - f * ph;
    // others fill the top remainder
    ctx.fillStyle = cssVar('--slate-3', '#1e2c3b');
    ctx.fillRect(l, y0, pw, ph);
    for (const bd of bands) {
      const c = w.civs[bd.id];
      ctx.beginPath();
      for (let k = 0; k < n; k++) { const x = X(xs[k]); if (k) ctx.lineTo(x, Y(bd.hi[k])); else ctx.moveTo(x, Y(bd.hi[k])); }
      for (let k = n - 1; k >= 0; k--) ctx.lineTo(X(xs[k]), Y(bd.lo[k]));
      ctx.closePath();
      // muted like an old printed chart: the nation's hue over a parchment ground
      ctx.fillStyle = '#d9cfb4'; ctx.fill();
      ctx.fillStyle = c?.colorHex || '#888'; ctx.globalAlpha = 0.74; ctx.fill(); ctx.globalAlpha = 1;
      ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(20,16,10,0.55)'; ctx.stroke();
    }
    // labels where each stream runs widest
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const placed = [];
    for (const bd of bands) {
      let best = -1, bh = 0;
      for (let k = 0; k < n; k++) { const th = (bd.hi[k] - bd.lo[k]) * ph; if (th > bh) { bh = th; best = k; } }
      if (best < 0 || bh < 12) continue;
      const c = w.civs[bd.id];
      const name = (c?.baseName || c?.name || '').replace(/^the\s/i, '');
      const size = Math.max(10, Math.min(18, bh * 0.55));
      ctx.font = `${size}px "IM Fell English", Georgia, serif`;
      const tw = ctx.measureText(name).width;
      const cx = Math.max(l + tw / 2 + 2, Math.min(W - r - tw / 2 - 2, X(xs[best])));
      const cy = Y((bd.hi[best] + bd.lo[best]) / 2);
      if (placed.some((p) => Math.abs(p.x - cx) < (p.w + tw) / 2 && Math.abs(p.y - cy) < (p.h + size) / 2)) continue;
      placed.push({ x: cx, y: cy, w: tw, h: size });
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,14,20,0.55)'; ctx.strokeText(name, cx, cy);
      ctx.fillStyle = '#f6eedb'; ctx.fillText(name, cx, cy);
    }
    // epochal pins
    for (const m of marks) {
      if (m.y < x0 || m.y > x1) continue;
      const x = X(m.y);
      ctx.fillStyle = t.brass; ctx.beginPath(); ctx.moveTo(x, y0 - 1); ctx.lineTo(x - 3, y0 - 5); ctx.lineTo(x + 3, y0 - 5); ctx.closePath(); ctx.fill();
    }
    // year axis
    ctx.font = t.mono; ctx.fillStyle = t.ink3; ctx.textBaseline = 'alphabetic';
    const step = Math.max(50, Math.ceil((x1 - x0) / Math.max(2, Math.floor(pw / 90)) / 50) * 50);
    for (let yr = Math.ceil(x0 / step) * step; yr <= x1; yr += step) { ctx.textAlign = 'center'; ctx.fillText('Y' + yr, Math.max(14, Math.min(W - 16, X(yr))), H - 4); }
    model.layout = { X, Y, x0, x1, l, pw, y0, ph, bands };
    caption.textContent = `${F.int(ids.length)} nations drawn; the grey above them holds every realm too small to show. Hover to read a year, click a stream to open the nation and travel there.`;
  }

  function at(e) {
    if (!model?.layout) return null;
    const { xs } = model, { x0, x1, l, pw, y0, ph, bands } = model.layout;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const yr = x0 + ((px - l) / Math.max(1, pw)) * (x1 - x0);
    let k = 0, bd = Infinity;
    for (let j = 0; j < xs.length; j++) { const d = Math.abs(xs[j] - yr); if (d < bd) { bd = d; k = j; } }
    const f = (y0 + ph - py) / ph;
    let hit = null;
    for (const b of bands) if (f >= b.lo[k] && f <= b.hi[k]) { hit = b; break; }
    return { k, year: xs[k], band: hit, f, px };
  }
  canvas.addEventListener('pointermove', (e) => {
    const p = at(e);
    if (!p) return;
    clear(tipEl);
    tipEl.appendChild(h('div.yr', { text: 'Year ' + p.year }));
    if (p.band) {
      const c = app.world.civs[p.band.id];
      const share = p.band.hi[p.k] - p.band.lo[p.k];
      tipEl.appendChild(h('div.r', null, h('i', { style: { '--c': c?.colorHex } }), h('span', { text: c?.name || '—' }), h('b', { text: F.pct(share, share < 0.1 ? 1 : 0) })));
    } else tipEl.appendChild(h('div.r', null, h('span'), h('span', { text: 'Smaller realms and wilds' }), h('b', { text: '' })));
    tipEl.hidden = false;
    const cw = el.clientWidth, tw = tipEl.offsetWidth;
    tipEl.style.left = Math.max(0, Math.min(cw - tw, p.px > cw / 2 ? p.px - tw - 12 : p.px + 12)) + 'px';
    tipEl.style.top = (canvas.offsetTop + 30) + 'px';
  });
  canvas.addEventListener('pointerleave', () => { tipEl.hidden = true; });
  canvas.addEventListener('click', (e) => {
    const p = at(e);
    if (!p) return;
    const atlas = app.world.history?.atlas || [];
    let snap = -1;
    for (let k = 0; k < atlas.length; k++) if (atlas[k].y <= p.year) snap = k;
    if (p.band) app.select({ kind: 'civ', id: p.band.id }, { focus: false, openTab: false });
    if (snap >= 0) app.emit('atlasGoto', snap);
    app.emit('timeTravel', p.year);
  });
  canvas.style.cursor = 'pointer';
  new ResizeObserver(() => { sig = ''; redraw(); }).observe(canvas);
  app.on('theme', () => { sig = ''; redraw(); });

  return { el, update: redraw, redraw: () => { sig = ''; redraw(); } };
}
