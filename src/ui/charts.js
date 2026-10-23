// Canvas charts drawn from world.history: thin 2 px lines over a faint wash, hairline
// grids, one y-axis per chart, a crosshair that snaps to the nearest year (shared across
// charts), and a tooltip that leads with values. Colours come from the theme tokens; a
// nation's series always wears that nation's colour.
//   TimeChart  years on x: lines or stacks, event marks (ticks or bands), click a year to
//              travel there (onPick), drag across a span to zoom (onRange), log scale
//   MiniChart  the Inspector's whole-life chart of one entity's ledger: channel chips, a
//              readout that names now, the peak and the hovered year, and event ticks

import { h, cssVar, clear } from './dom.js';
import { num } from './format.js';
import { getPref, setPref } from './prefs.js';

export function chartTheme() {
  return {
    ink: cssVar('--ink', '#ede3cb'),
    ink2: cssVar('--ink-2', '#c3b9a1'),
    ink3: cssVar('--ink-3', '#8f8877'),
    grid: cssVar('--chart-grid', 'rgba(237,227,203,0.07)'),
    axis: cssVar('--chart-axis', 'rgba(237,227,203,0.24)'),
    surface: cssVar('--slate-1', '#101923'),
    brass: cssVar('--brass', '#c9a466'),
    c1: cssVar('--chart-1', '#bf8a2a'),
    c2: cssVar('--chart-2', '#16a085'),
    c3: cssVar('--chart-3', '#e0603f'),
    c4: cssVar('--chart-4', '#5a86e0'),
    mono: '10.5px "IBM Plex Mono", ui-monospace, Menlo, monospace',
  };
}

/** Size a canvas to its CSS box at device resolution; returns a ready 2D context in CSS px. */
export function fitCanvas(canvas, cssW, cssH) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cssW)), hh = Math.max(1, Math.round(cssH));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
  }
  canvas.style.height = hh + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hh);
  return ctx;
}

/** Round tick values covering [lo, hi]. */
export function niceTicks(lo, hi, count = 4, minStep = 0) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi - lo < 1e-9) { hi = lo + 1; }
  const raw = (hi - lo) / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = Math.max(minStep, (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p);
  const start = Math.floor(lo / step) * step;
  const out = [];
  for (let v = start; v <= hi + step * 0.5 && out.length < 12; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function lowerBound(xs, x) {
  let lo = 0, hi = xs.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x)) return lo - 1;
  return lo;
}

/** A tiny trend line with a wash and an end dot. values: number[] */
export function drawSparkline(canvas, values, color, { height = 46, width = null } = {}) {
  const cssW = width || canvas.clientWidth || 300;
  const ctx = fitCanvas(canvas, cssW, height);
  const t = chartTheme();
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) {
    ctx.fillStyle = t.ink3; ctx.font = t.mono; ctx.fillText('Not enough history yet', 2, height / 2 + 4);
    return;
  }
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { hi += 1; lo = Math.max(0, lo - 1); }
  lo = Math.min(lo, 0);
  const pad = 4;
  const X = (k) => pad + (k / (values.length - 1)) * (cssW - pad * 2);
  const Y = (v) => height - pad - ((v - lo) / (hi - lo)) * (height - pad * 2);
  ctx.beginPath();
  let started = false;
  values.forEach((v, k) => { if (!Number.isFinite(v)) return; if (!started) { ctx.moveTo(X(k), Y(v)); started = true; } else ctx.lineTo(X(k), Y(v)); });
  ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = color; ctx.stroke();
  ctx.lineTo(X(values.length - 1), height - pad); ctx.lineTo(X(0), height - pad); ctx.closePath();
  ctx.globalAlpha = 0.12; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
  const lv = values[values.length - 1];
  if (Number.isFinite(lv)) {
    ctx.beginPath(); ctx.arc(X(values.length - 1), Y(lv), 4, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = t.surface; ctx.stroke();
  }
}

/**
 * TimeChart: years on x, one value scale on y.
 * opts: { title, sub, height, mode: 'line'|'stack', yFormat(v), yMin (default 0, null = auto),
 *         yMax (a fixed top, e.g. 100 for 0–100 scores; default auto), onHover(year|null),
 *         agg: 'mean'|'max', intTicks (counts: whole-number gridlines only) }
 * setData({ xs: years[], series: [{ label, color, values[] }] })
 */
export class TimeChart {
  constructor(opts) {
    this.o = { height: 150, mode: 'line', yMin: 0, yFormat: (v) => num(v), agg: 'mean', ...opts };
    this.data = { xs: [], series: [] };
    this.hoverYear = null;
    this.canvas = h('canvas', { role: 'img', 'aria-label': opts.title || 'Chart' });
    this.legend = h('div.chart-legend');
    this.tip = h('div.chart-tip', { hidden: true });
    this.sub = h('span.ch-sub', { text: opts.sub || '' });
    this.el = h('figure.chart-card', { style: { position: 'relative', margin: '0' } },
      h('div.ch-head', null, h('span.ch-title', { text: opts.title || '' }), this.sub),
      this.canvas, this.legend, this.tip,
    );
    this.canvas.addEventListener('pointermove', (e) => {
      if (this._down && e.pointerType === 'mouse' && this.o.onRange && Math.abs(e.clientX - this._down.x) > 6) this._dragTo(e);
      this._hover(e);
    });
    this.canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; this.o.onHover?.(null); });
    this.canvas.addEventListener('pointerdown', (e) => { this._down = { x: e.clientX, year: this._yearAt(e) }; this._drag = null; this._hover(e); });
    this.canvas.addEventListener('pointerup', (e) => {
      const d = this._down, g = this._drag;
      this._down = null; this._drag = null;
      if (g && this.o.onRange) { this.draw(); const a = Math.min(g.a, g.b), b = Math.max(g.a, g.b); if (b - a >= 2) this.o.onRange(Math.round(a), Math.round(b)); return; }
      if (d && this.o.onPick && Math.abs(e.clientX - d.x) <= 6) {
        const y = this._yearAt(e);
        const xs = this.data.xs;
        if (y != null && xs.length) { const k = lowerBound(xs, y); this.o.onPick(Math.round(xs[k] ?? y)); }
      }
    });
    this.canvas.addEventListener('pointercancel', () => { this._down = null; this._drag = null; this.draw(); });
    if (this.o.onPick) this.canvas.style.cursor = 'pointer';
  }

  /** Event marks [{ y, y2?, color, label }] (ticks, or bands when y2 is set). */
  setMarks(marks) { this.o.marks = Array.isArray(marks) ? marks : []; this.draw(); }
  setLog(on) { this.o.log = Boolean(on); this.draw(); }

  _yearAt(e) {
    const s = this._scale;
    if (!s) return null;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const yr = s.x0 + ((px - s.L.l) / Math.max(1, r.width - s.L.l - s.L.r)) * (s.x1 - s.x0);
    return Math.max(s.x0, Math.min(s.x1, yr));
  }
  _dragTo(e) {
    const y = this._yearAt(e);
    if (y == null || !this._down || this._down.year == null) return;
    this._drag = { a: this._down.year, b: y };
    this.draw();
  }

  setSub(text) { if (this.sub.textContent !== text) this.sub.textContent = text; }

  setData(d) {
    this.data = d;
    this._legend();
    this.draw();
  }

  setHoverYear(y) {
    if (this.hoverYear === y) return;
    this.hoverYear = y;
    this.draw();
  }

  _legend() {
    clear(this.legend);
    const ser = this.data.series;
    if (ser.length < 2) return;
    for (const s of ser) {
      this.legend.appendChild(h('span', null, h(this.o.mode === 'stack' ? 'i.key-box' : 'i.key-line', { style: { '--c': s.color } }), s.label));
    }
  }

  _layout() {
    const w = this.canvas.clientWidth || this.el.clientWidth || 340;
    return { w, hgt: this.o.height, l: 44, r: 8, t: 8, b: 20 };
  }

  _range() {
    const { xs, series } = this.data;
    let lo = Infinity, hi = -Infinity;
    if (this.o.mode === 'stack') {
      for (let k = 0; k < xs.length; k++) {
        let s = 0;
        for (const se of series) { const v = se.values[k]; if (Number.isFinite(v)) s += v; }
        if (s > hi) hi = s;
      }
      lo = 0;
    } else {
      for (const se of series) for (const v of se.values) { if (!Number.isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (this.o.log && this.o.mode !== 'stack') {
      const L0 = Math.log10(Math.max(1, lo)), L1 = Math.log10(Math.max(10, hi));
      return { lo: Math.floor(L0), hi: Math.max(Math.floor(L0) + 1, L1 + (L1 - L0) * 0.04) };
    }
    if (this.o.yMin != null) lo = Math.min(lo, this.o.yMin);
    if (Number.isFinite(this.o.yMax) && this.o.mode !== 'stack') hi = Math.max(hi, this.o.yMax);
    if (hi - lo < 1e-9) { hi = lo + (Math.abs(lo) > 1 ? Math.abs(lo) * 0.1 : 1); }
    const span = hi - lo;
    if (this.o.yMin == null) lo -= span * 0.06;
    if (!(Number.isFinite(this.o.yMax) && hi <= this.o.yMax)) hi += span * 0.06;
    return { lo, hi };
  }

  draw() {
    const L = this._layout();
    const ctx = fitCanvas(this.canvas, L.w, L.hgt);
    const t = chartTheme();
    const { xs, series } = this.data;
    const pw = L.w - L.l - L.r, ph = L.hgt - L.t - L.b;
    ctx.font = t.mono;
    if (xs.length < 2) {
      ctx.fillStyle = t.ink3;
      ctx.fillText('The record begins: a year or two more is needed.', L.l, L.t + ph / 2);
      return;
    }
    const x0 = xs[0], x1 = xs[xs.length - 1];
    const { lo, hi } = this._range();
    const logY = Boolean(this.o.log && this.o.mode !== 'stack');
    const X = (yr) => L.l + ((yr - x0) / Math.max(1e-9, x1 - x0)) * pw;
    const Yl = (v) => L.t + ph - ((v - lo) / Math.max(1e-9, hi - lo)) * ph;
    const Y = logY ? (v) => Yl(Math.log10(Math.max(1, v))) : Yl;
    this._scale = { X, Y, x0, x1, L };

    // event bands beneath everything
    const marks = Array.isArray(this.o.marks) ? this.o.marks : [];
    for (const m of marks) {
      if (!Number.isFinite(m.y2) || m.y2 < x0 || m.y > x1) continue;
      const a = X(Math.max(x0, m.y)), b = X(Math.min(x1, m.y2));
      ctx.globalAlpha = 0.1; ctx.fillStyle = m.color || t.ink3; ctx.fillRect(a, L.t, Math.max(1, b - a), ph); ctx.globalAlpha = 1;
    }
    // grid + y labels
    ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const yTicks = logY ? Array.from({ length: Math.max(1, Math.ceil(hi) - Math.floor(lo) + 1) }, (_, k) => Math.floor(lo) + k) : niceTicks(lo, hi, 4, this.o.intTicks ? 1 : 0);
    for (const v of yTicks) {
      if (v < lo - 1e-9 || v > hi + 1e-9) continue;
      const y = Math.round(Yl(v)) + 0.5;
      ctx.strokeStyle = t.grid; ctx.beginPath(); ctx.moveTo(L.l, y); ctx.lineTo(L.l + pw, y); ctx.stroke();
      ctx.fillStyle = t.ink3; ctx.fillText(this.o.yFormat(logY ? Math.pow(10, v) : v), L.l - 6, y);
    }
    // x labels
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const xt = niceTicks(x0, x1, Math.max(2, Math.floor(pw / 80)));
    for (const yr of xt) {
      if (yr < x0 || yr > x1) continue;
      const x = X(yr);
      ctx.fillStyle = t.ink3; ctx.fillText('Y' + Math.round(yr), Math.max(L.l + 12, Math.min(L.l + pw - 14, x)), L.hgt - 5);
    }
    // baseline
    ctx.strokeStyle = t.axis; ctx.beginPath(); ctx.moveTo(L.l, Math.round(L.t + ph) + 0.5); ctx.lineTo(L.l + pw, Math.round(L.t + ph) + 0.5); ctx.stroke();

    // bucket indices so we draw at most ~1 point per 1.5 px
    const n = xs.length;
    const stride = Math.max(1, Math.ceil(n / (pw / 1.5)));
    const idx = [];
    for (let k = 0; k < n; k += stride) idx.push(k);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    const agg = (vals, k) => {
      if (stride === 1) return vals[k];
      const end = Math.min(n, k + stride);
      let s = 0, c = 0, m = -Infinity;
      for (let j = k; j < end; j++) { const v = vals[j]; if (Number.isFinite(v)) { s += v; c++; if (v > m) m = v; } }
      return c ? (this.o.agg === 'max' ? m : s / c) : NaN;
    };

    if (this.o.mode === 'stack') {
      const base = new Float64Array(idx.length);
      for (const se of series) {
        const top = idx.map((k, j) => base[j] + (Number.isFinite(agg(se.values, k)) ? agg(se.values, k) : 0));
        ctx.beginPath();
        idx.forEach((k, j) => { const x = X(xs[k]), y = Y(top[j]); if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        for (let j = idx.length - 1; j >= 0; j--) ctx.lineTo(X(xs[idx[j]]), Y(base[j]));
        ctx.closePath();
        ctx.globalAlpha = 0.78; ctx.fillStyle = se.color; ctx.fill(); ctx.globalAlpha = 1;
        // 1 px surface gap between layers
        ctx.beginPath();
        idx.forEach((k, j) => { const x = X(xs[k]), y = Y(top[j]); if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        ctx.lineWidth = 1; ctx.strokeStyle = t.surface; ctx.stroke();
        for (let j = 0; j < idx.length; j++) base[j] = top[j];
      }
    } else {
      const single = series.length === 1;
      for (const se of series) {
        ctx.beginPath();
        let started = false, lastX = 0;
        for (const k of idx) {
          const v = agg(se.values, k);
          if (!Number.isFinite(v)) { started = false; continue; }
          const x = X(xs[k]), y = Y(v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          lastX = x;
        }
        ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.setLineDash(se.dash || []);
        ctx.strokeStyle = se.color; ctx.stroke();
        ctx.setLineDash([]);
        if (single && started) {
          const firstK = idx.find((k) => Number.isFinite(agg(se.values, k)));
          ctx.lineTo(lastX, Y(Math.max(lo, Math.min(hi, 0 >= lo && 0 <= hi ? 0 : lo))));
          ctx.lineTo(X(xs[firstK ?? 0]), Y(Math.max(lo, Math.min(hi, 0 >= lo && 0 <= hi ? 0 : lo))));
          ctx.closePath();
          ctx.globalAlpha = 0.1; ctx.fillStyle = se.color; ctx.fill(); ctx.globalAlpha = 1;
        }
        // end dot with a surface ring
        const lv = se.values[n - 1];
        if (Number.isFinite(lv)) {
          ctx.beginPath(); ctx.arc(X(xs[n - 1]), Y(lv), 4, 0, Math.PI * 2);
          ctx.fillStyle = se.color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = t.surface; ctx.stroke();
        }
      }
    }

    // event ticks along the top edge
    for (const m of marks) {
      if (Number.isFinite(m.y2) || m.y < x0 || m.y > x1) continue;
      const x = Math.round(X(m.y)) + 0.5;
      ctx.strokeStyle = m.color || t.ink3; ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, L.t); ctx.lineTo(x, L.t + ph); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = m.color || t.ink3;
      ctx.beginPath(); ctx.moveTo(x - 3.5, L.t); ctx.lineTo(x + 3.5, L.t); ctx.lineTo(x, L.t + 5); ctx.closePath(); ctx.fill();
    }
    // a span being dragged out for zooming
    if (this._drag) {
      const a = X(Math.min(this._drag.a, this._drag.b)), b = X(Math.max(this._drag.a, this._drag.b));
      ctx.globalAlpha = 0.16; ctx.fillStyle = t.brass; ctx.fillRect(a, L.t, Math.max(1, b - a), ph); ctx.globalAlpha = 1;
      ctx.strokeStyle = t.brass; ctx.strokeRect(Math.round(a) + 0.5, L.t + 0.5, Math.max(1, Math.round(b - a)), ph - 1);
    }
    // crosshair
    if (this.hoverYear != null && this.hoverYear >= x0 && this.hoverYear <= x1) {
      const x = Math.round(X(xs[lowerBound(xs, this.hoverYear)])) + 0.5;
      ctx.strokeStyle = t.ink3; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, L.t); ctx.lineTo(x, L.t + ph); ctx.stroke();
    }
  }

  _hover(e) {
    const s = this._scale;
    const { xs, series } = this.data;
    if (!s || xs.length < 2) return;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const yr = s.x0 + ((px - s.L.l) / Math.max(1, r.width - s.L.l - s.L.r)) * (s.x1 - s.x0);
    const k = lowerBound(xs, yr);
    if (k < 0) return;
    this.o.onHover?.(xs[k]);
    this.setHoverYear(xs[k]);
    clear(this.tip);
    this.tip.appendChild(h('div.yr', { text: 'Year ' + xs[k] }));
    const rows = this.o.mode === 'stack' ? series.slice().reverse() : series;
    for (const se of rows) {
      const v = se.values[k];
      this.tip.appendChild(h('div.r', null, h('i', { style: { '--c': se.color } }), h('span', { text: se.label }), h('b', { text: Number.isFinite(v) ? (this.o.tipFormat || this.o.yFormat)(v) : '—' })));
    }
    if (this.o.mode === 'stack' && series.length > 1) {
      const tot = series.reduce((a, se) => a + (Number.isFinite(se.values[k]) ? se.values[k] : 0), 0);
      this.tip.appendChild(h('div.r', null, h('span'), h('span', { text: 'Total' }), h('b', { text: (this.o.tipFormat || this.o.yFormat)(tot) })));
    }
    // the events marked near this year
    const near = (this.o.marks || []).filter((m) => m.label && (Number.isFinite(m.y2) ? xs[k] >= m.y && xs[k] <= m.y2 : Math.abs(m.y - xs[k]) <= Math.max(1, (s.x1 - s.x0) / 120)));
    for (const m of near.slice(0, 3)) this.tip.appendChild(h('div.mk', { text: m.label, style: { '--c': m.color || 'var(--ink-3)' } }));
    if (this.o.onPick) this.tip.appendChild(h('div.hint', { text: 'Click to travel to this year' }));
    this.tip.hidden = false;
    const cw = this.el.clientWidth;
    const tw = this.tip.offsetWidth;
    const cx = px + this.canvas.offsetLeft;
    this.tip.style.left = Math.max(0, Math.min(cw - tw, cx > cw / 2 ? cx - tw - 12 : cx + 12)) + 'px';
    this.tip.style.top = (this.canvas.offsetTop + 4) + 'px';
  }

  hideTip() { this.tip.hidden = true; }
}

/**
 * MiniChart: one entity's whole life from its ledger series (sim/ledger.js), one channel at a
 * time, chosen with chips. The readout names the latest value and the peak, and the hovered
 * year while a pointer is over it. Marks [{ day, color, label? }] become ticks (battles,
 * conquests). Redraws only when its data signature changes.
 *   new MiniChart({ channels: [{ key, label, color?, fmt(v) }], height?, prefKey?, onPick?(day) })
 *   chart.setData({ days: [], rows: [[value per channel]], marks?, live? })
 */
export class MiniChart {
  constructor({ channels, height = 72, prefKey = null, initial = null, onPick = null, zero = false }) {
    this.channels = channels || [];
    this.height = height;
    this.prefKey = prefKey;
    this.onPick = onPick;
    this.zero = zero;
    const saved = prefKey ? getPref('records.mini.' + prefKey, null) : null;
    const pick = (k) => this.channels.findIndex((c) => c.key === k);
    this.sel = Math.max(0, pick(saved) >= 0 ? pick(saved) : pick(initial) >= 0 ? pick(initial) : 0);
    this.data = { days: [], rows: [], marks: [] };
    this.hover = -1;
    this.sig = '';
    this.canvas = h('canvas.mc-canvas', { role: 'img', 'aria-label': 'Life chart' });
    this.read = h('div.mc-read');
    this.chips = h('div.mc-chips', { role: 'group', 'aria-label': 'Measure' });
    if (this.channels.length > 1) {
      this.channels.forEach((c, k) => {
        const b = h('button.mc-chip', { type: 'button', text: c.label, 'aria-pressed': String(k === this.sel) });
        b.addEventListener('click', () => this.select(k));
        this.chips.appendChild(b);
      });
    }
    this.el = h('figure.mini-chart', null, this.channels.length > 1 ? this.chips : null, this.canvas, this.read);
    this.canvas.addEventListener('pointermove', (e) => this._move(e));
    this.canvas.addEventListener('pointerdown', (e) => this._move(e));
    this.canvas.addEventListener('pointerleave', () => { this.hover = -1; this.draw(); });
    this.canvas.addEventListener('click', (e) => {
      if (!this.onPick || !this._scale) return;
      const k = this._index(e);
      if (k >= 0) this.onPick(this.data.days[k]);
    });
    if (onPick) this.canvas.style.cursor = 'pointer';
  }

  select(k) {
    if (k === this.sel || k < 0 || k >= this.channels.length) return;
    this.sel = k;
    for (const [j, b] of Array.from(this.chips.children).entries()) b.setAttribute('aria-pressed', String(j === k));
    if (this.prefKey) setPref('records.mini.' + this.prefKey, this.channels[k].key);
    this.draw();
  }

  /** data: { days, rows, marks?, live? }; redraws only when it changed. */
  setData(d) {
    const days = d?.days || [], rows = d?.rows || [];
    const last = rows[rows.length - 1];
    const sig = `${days.length}:${days[0]}:${days[days.length - 1]}:${last ? last.join(',') : ''}:${(d?.marks || []).length}`;
    this.data = { days, rows, marks: d?.marks || [], live: d?.live !== false };
    if (sig === this.sig && this.canvas.width > 1) return;
    this.sig = sig;
    this.draw();
  }

  _index(e) {
    const s = this._scale;
    if (!s) return -1;
    const r = this.canvas.getBoundingClientRect();
    const day = s.d0 + ((e.clientX - r.left - s.l) / Math.max(1, s.w)) * (s.d1 - s.d0);
    const ds = this.data.days;
    let best = -1, bd = Infinity;
    for (let k = 0; k < ds.length; k++) { const q = Math.abs(ds[k] - day); if (q < bd) { bd = q; best = k; } }
    return best;
  }
  _move(e) { const k = this._index(e); if (k !== this.hover) { this.hover = k; this.draw(); } }

  draw() {
    const W = this.canvas.clientWidth || this.el.clientWidth || 300;
    const H = this.height;
    const ctx = fitCanvas(this.canvas, W, H);
    const t = chartTheme();
    const ch = this.channels[this.sel] || { label: '', fmt: (v) => num(v) };
    const color = ch.color || t.c1;
    const { days, rows, marks } = this.data;
    ctx.font = t.mono;
    if (rows.length < 2) {
      ctx.fillStyle = t.ink3;
      ctx.fillText(rows.length ? 'The ledger has only begun: a few more years are needed.' : 'No ledger entries for these years.', 2, H / 2 + 4);
      clear(this.read);
      if (rows.length === 1) this.read.append(h('b', { text: ch.fmt(rows[0][this.sel]) }), ` ${ch.label.toLowerCase()} · Year ${Math.floor(days[0] / 360)}`);
      this._scale = null;
      return;
    }
    const vals = rows.map((r) => r[this.sel]);
    let lo = Infinity, hi = -Infinity;
    for (const v of vals) { if (!Number.isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (lo > 0 && !this.zero) lo = 0;
    if (this.zero) { const m = Math.max(Math.abs(lo), Math.abs(hi), 1); lo = -m; hi = m; }
    if (hi - lo < 1e-9) hi = lo + 1;
    const l = 4, r = 4, top = 8, bot = 14;
    const pw = W - l - r, ph = H - top - bot;
    const d0 = days[0], d1 = days[days.length - 1];
    const X = (d) => l + ((d - d0) / Math.max(1, d1 - d0)) * pw;
    const Y = (v) => top + ph - ((v - lo) / (hi - lo)) * ph;
    this._scale = { d0, d1, l, w: pw };
    // zero line for signed measures
    if (this.zero) { ctx.strokeStyle = t.axis; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(l, Math.round(Y(0)) + 0.5); ctx.lineTo(l + pw, Math.round(Y(0)) + 0.5); ctx.stroke(); }
    // marks: a bead under the axis each (a faint rule only when there are few, or when hovered)
    const hovDay = this.hover >= 0 && this.hover < days.length ? days[this.hover] : null;
    const near = Math.max(30, (d1 - d0) / 80);
    const few = (marks || []).length <= 8;
    for (const m of marks || []) {
      if (!Number.isFinite(m.day) || m.day < d0 || m.day > d1) continue;
      const x = Math.round(X(m.day)) + 0.5;
      const lit = hovDay != null && Math.abs(m.day - hovDay) <= near;
      if (few || lit) {
        ctx.strokeStyle = m.color || t.ink3; ctx.globalAlpha = lit ? 0.85 : 0.35; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.stroke(); ctx.globalAlpha = 1;
      }
      ctx.fillStyle = m.color || t.ink3; ctx.globalAlpha = lit ? 1 : 0.75;
      ctx.beginPath(); ctx.arc(x, top + ph + 4, lit ? 3 : 2, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    }
    // line + wash
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < vals.length; k++) {
      const v = vals[k];
      if (!Number.isFinite(v)) { started = false; continue; }
      const x = X(days[k]), y = Y(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = color; ctx.stroke();
    const base = Y(this.zero ? 0 : Math.max(lo, 0));
    ctx.lineTo(X(days[days.length - 1]), base); ctx.lineTo(X(days[0]), base); ctx.closePath();
    ctx.globalAlpha = 0.12; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
    // peak marker
    let pk = 0;
    for (let k = 1; k < vals.length; k++) if (vals[k] > vals[pk]) pk = k;
    // end years
    ctx.fillStyle = t.ink3; ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left'; ctx.fillText('Y' + Math.floor(d0 / 360), l, H - 2);
    ctx.textAlign = 'right'; ctx.fillText(this.data.live ? 'now' : 'Y' + Math.floor(d1 / 360), l + pw, H - 2);
    const k = this.hover >= 0 && this.hover < vals.length ? this.hover : vals.length - 1;
    // hover / latest dot
    if (Number.isFinite(vals[k])) {
      ctx.beginPath(); ctx.arc(X(days[k]), Y(vals[k]), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = t.surface; ctx.stroke();
    }
    if (this.hover >= 0) { ctx.strokeStyle = t.ink3; ctx.lineWidth = 1; const x = Math.round(X(days[k])) + 0.5; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.stroke(); }
    // readout
    clear(this.read);
    const yr = (d) => 'Y' + Math.floor(d / 360);
    if (this.hover >= 0) {
      this.read.append(h('span.yr', { text: yr(days[k]) }));
      const row = rows[k];
      this.channels.forEach((c, j) => {
        if (!Number.isFinite(row[j]) || (j !== this.sel && this.channels.length > 4 && j > 3 && j !== this.sel)) return;
        this.read.append(h(j === this.sel ? 'b' : 'span', { text: `${c.label} ${c.fmt(row[j])}` }));
      });
      const near = (marks || []).filter((m) => m.label && Math.abs(m.day - days[k]) <= Math.max(30, (d1 - d0) / 80));
      if (near.length) this.read.append(h('span.mk', { text: near.slice(0, 2).map((m) => m.label).join(' · ') }));
    } else {
      // the samples are dated records (often a year's average), not the live figure the header
      // shows beside it: say which year the latest one is
      this.read.append(h('b', { text: ch.fmt(vals[vals.length - 1]) }), h('span', { text: `${ch.label.toLowerCase()} ${this.data.live ? 'in the record of ' + yr(d1) : 'at the end'}` }));
      if (pk !== vals.length - 1 && Number.isFinite(vals[pk])) this.read.append(h('span', { text: `highest record ${ch.fmt(vals[pk])} in ${yr(days[pk]).replace('Y', 'Year ')}` }));
    }
  }
}
