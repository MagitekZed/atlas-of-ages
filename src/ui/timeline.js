// The history timeline (Y): the whole of history in one strip, in five lanes —
//   1. world population as a line over bands of the most advanced age then reached,
//   2. wars as bars from first to last day, packed into lanes, thicker for deadlier wars,
//   3. plagues as spans,
//   4. the Chronicle's historic (4) and epochal (5) entries as ticks in their colours,
//   5. the moments the Chronoscope holds, as small diamonds.
// Hover reads a year, an event, a war or a plague; a click opens it and brings up that
// decade's plate in the Atlas (which stops time while you look into the past); dragging
// scrubs the plates; the wheel zooms the span of years and a double-click shows them all.
// With the Chronoscope, "Rewind to Year N" makes the year under the pointer the present.
// It draws only when its data, its size or the pointer change.

import { CATEGORIES, DAYS_PER_YEAR } from '../core/constants.js';
import { chronicleEntry } from '../core/chronicle.js';
import { registerKey, registerCommand, registerOverlay } from './registry.js';
import { openModal } from './widgets.js';
import { h, setText, cssVar, isCompact } from './dom.js';
import { iconEl } from './icons.js';
import { getPref, setPref } from './prefs.js';
import { focusEntry } from './toasts.js';
import * as F from './format.js';

const Y = DAYS_PER_YEAR;

// the event pins on the map (src/render/pins.js) are this module's other half
let pinsMod = null;
try { pinsMod = await import('../render/pins.js'); } catch (e) { /* no pins: the map just has none */ }
const LANES = { pop: [4, 30], war: [36, 64], plague: [68, 76], ticks: [80, 90], frames: [92, 96] };

export function mount(app) {
  const stage = document.getElementById('stage');
  const yearEl = h('span.hb-year');
  const rewindBtn = h('button.btn.btn-sm', { type: 'button', hidden: true });
  const closeBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Close the timeline (Y)' }, iconEl('close', { size: 16 }));
  const canvas = h('canvas', { 'aria-label': 'History timeline: population, wars, plagues and great events. Click to open, drag to travel.' });
  const tipEl = h('div.hb-tip', { hidden: true });
  const bar = h('div.history-bar.instrument', { hidden: true, role: 'region', 'aria-label': 'History timeline' },
    h('div.hb-head', null, h('b', { text: 'History' }), yearEl, h('span.sp'), rewindBtn, closeBtn), canvas, tipEl);
  stage.appendChild(bar);
  closeBtn.addEventListener('click', () => setOpen(false));
  rewindBtn.addEventListener('click', () => { if (rewindYear != null) app.chrono?.rewindTo(rewindYear * Y); });

  let open = false;
  let range = null;        // [y0, y1] when zoomed in, else null (all of history)
  let sig = '';
  let hover = null;        // { x, y } canvas px
  let items = [];          // hit targets drawn last: { x0, x1, y0, y1, kind, ... }
  let rewindYear = null;
  let drag = null;

  function setOpen(v) {
    open = Boolean(v) && Boolean(app.world);
    bar.hidden = !open;
    document.getElementById('app')?.classList.toggle('has-timeline', open);
    setPref('story.timeline', open);
    sig = '';
    if (open) draw();
  }
  app.toggleTimeline = () => setOpen(!open);

  // --- data ------------------------------------------------------------------------------
  const span = () => {
    const w = app.world;
    const now = w.time.day / Y;
    const first = w.history?.years?.[0]?.y ?? 0;
    const full = [Math.min(first, 0), Math.max(1, now)];
    if (!range) return full;
    return [Math.max(full[0], range[0]), Math.min(full[1], range[1])];
  };

  function packWars(w) {
    const lanes = [];
    const out = [];
    const now = w.time.day;
    const wars = w.wars.filter(Boolean).slice().sort((a, b) => a.startDay - b.startDay);
    for (const war of wars) {
      const end = war.active ? now : (war.endDay ?? war.startDay + Y);
      let lane = lanes.findIndex((e) => e <= war.startDay - Y);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      if (lane > 5) lane = 5;
      lanes[lane] = end;
      const dead = Object.values(war.casualties || {}).reduce((a, v) => a + (Number(v) || 0), 0);
      out.push({ war, lane, end, dead });
    }
    return { list: out, lanes: Math.min(6, Math.max(1, lanes.length)) };
  }

  // --- drawing ---------------------------------------------------------------------------
  function draw() {
    const w = app.world;
    if (!open || !w) return;
    const cssW = Math.max(200, canvas.clientWidth || 600);
    const cssH = isCompact() ? 80 : 96;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) { canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const sy = cssH / 96;
    const [y0, y1] = span();
    const X = (yr) => 4 + ((yr - y0) / Math.max(1e-6, y1 - y0)) * (cssW - 8);
    const ink3 = cssVar('--ink-3', '#8f8877'), brass = cssVar('--brass', '#c9a466'), axis = cssVar('--chart-axis', 'rgba(237,227,203,0.24)'), line = cssVar('--chart-2', '#16a085');
    items = [];
    // lane 1: ages and population
    const ys = (w.history?.years || []).filter((r) => r.y >= y0 - 1 && r.y <= y1 + 1);
    let maxPop = 0;
    for (const r of ys) if (r.pop > maxPop) maxPop = r.pop;
    let era = -1, eraX = X(y0);
    const eraBand = (from, to, e) => {
      if (e < 0) return;
      ctx.fillStyle = brass;
      ctx.globalAlpha = 0.05 + 0.035 * e;
      ctx.fillRect(from, LANES.pop[0] * sy, Math.max(0, to - from), (LANES.pop[1] - LANES.pop[0]) * sy);
      ctx.globalAlpha = 1;
      if (to - from > 60) { ctx.fillStyle = ink3; ctx.font = '10px "IM Fell English SC", Georgia, serif'; ctx.fillText(F.eraName(e), from + 4, LANES.pop[0] * sy + 10); }
    };
    for (const r of ys) {
      const e = r.era | 0;
      if (e !== era) { eraBand(eraX, X(r.y), era); era = e; eraX = X(r.y); }
    }
    eraBand(eraX, X(y1), era);
    if (ys.length > 1 && maxPop > 0) {
      ctx.beginPath();
      ys.forEach((r, j) => { const x = X(r.y), y = (LANES.pop[1] - (r.pop / maxPop) * (LANES.pop[1] - LANES.pop[0] - 2)) * sy; if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.lineWidth = 1.5; ctx.strokeStyle = line; ctx.stroke();
    }
    // lane 2: wars
    const { list: wars, lanes } = packWars(w);
    const lh = (LANES.war[1] - LANES.war[0]) / lanes;
    for (const q of wars) {
      const a = q.war.startDay / Y, b = q.end / Y;
      if (b < y0 || a > y1) continue;
      const x0 = X(a), x1 = Math.max(x0 + 2, X(b));
      const th = Math.max(2, Math.min(lh - 1, 2 + Math.log10(q.dead + 1) * 1.2));
      const yy = (LANES.war[0] + q.lane * lh + (lh - th) / 2) * sy;
      ctx.fillStyle = w.civs[q.war.attackers?.[0]]?.colorHex || CATEGORIES.war.color;
      ctx.globalAlpha = q.war.active ? 1 : 0.75;
      ctx.fillRect(x0, yy, x1 - x0, th * sy);
      ctx.globalAlpha = 1;
      items.push({ kind: 'war', x0, x1, y0: yy - 2, y1: yy + th * sy + 2, war: q.war, dead: q.dead });
    }
    // lane 3: plagues
    for (const p of w.plagues) {
      if (!p) continue;
      const a = p.startDay / Y, b = (p.active ? w.time.day : (p.endDay ?? p.startDay + Y)) / Y;
      if (b < y0 || a > y1) continue;
      const x0 = X(a), x1 = Math.max(x0 + 2, X(b));
      ctx.fillStyle = CATEGORIES.disease.color;
      ctx.globalAlpha = 0.45 + Math.min(0.5, Math.log10((p.deaths || 0) + 1) / 12);
      ctx.fillRect(x0, LANES.plague[0] * sy, x1 - x0, (LANES.plague[1] - LANES.plague[0]) * sy);
      ctx.globalAlpha = 1;
      items.push({ kind: 'plague', x0, x1, y0: LANES.plague[0] * sy - 2, y1: LANES.plague[1] * sy + 2, plague: p });
    }
    // lane 4: great events
    for (const e of w.chronicle.entries) {
      if (e.imp < 4 || e.fold) continue;
      const yr = e.day / Y;
      if (yr < y0 || yr > y1) continue;
      const x = Math.round(X(yr));
      const tall = e.imp >= 5;
      ctx.fillStyle = (CATEGORIES[e.cat] || {}).color || ink3;
      ctx.fillRect(x, (tall ? LANES.ticks[0] : LANES.ticks[0] + 4) * sy, tall ? 2 : 1, (tall ? 10 : 6) * sy);
      items.push({ kind: 'entry', x0: x - 2, x1: x + 3, y0: LANES.ticks[0] * sy - 2, y1: LANES.ticks[1] * sy + 2, entry: e });
    }
    // lane 5: the Chronoscope's moments
    const frames = app.chrono?.stats?.().frames || [];
    ctx.fillStyle = cssVar('--verdigris', '#63b5a3');
    for (const f of frames) {
      const yr = f.day / Y;
      if (yr < y0 || yr > y1) continue;
      const x = X(yr), cy = ((LANES.frames[0] + LANES.frames[1]) / 2) * sy, r = 2.5;
      ctx.beginPath(); ctx.moveTo(x, cy - r); ctx.lineTo(x + r, cy); ctx.lineTo(x, cy + r); ctx.lineTo(x - r, cy); ctx.closePath(); ctx.fill();
    }
    // the plate on show, the present, the axis
    ctx.fillStyle = axis;
    ctx.fillRect(4, (LANES.pop[1] + 2) * sy, cssW - 8, 1);
    if (app.atlasIndex != null) {
      const s = w.history.atlas[app.atlasIndex];
      if (s) { ctx.fillStyle = brass; ctx.fillRect(Math.round(X(s.y)) - 1, 0, 2, cssH); }
    }
    if (hover) {
      ctx.fillStyle = ink3;
      ctx.fillRect(Math.round(hover.x), 0, 1, cssH);
    }
    setText(yearEl, `Year ${F.int(Math.floor(y0))} – Year ${F.int(Math.floor(y1))}${range ? ' · wheel to zoom, double-click for all' : ''}`);
  }

  // --- pointer ---------------------------------------------------------------------------
  const yearAt = (x) => { const [y0, y1] = span(); const cssW = canvas.clientWidth || 600; return y0 + ((x - 4) / Math.max(1, cssW - 8)) * (y1 - y0); };
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function hitAt(p) {
    let best = null;
    for (const it of items) if (p.x >= it.x0 && p.x <= it.x1 && p.y >= it.y0 && p.y <= it.y1) { if (!best || it.kind === 'entry') best = it; }
    return best;
  }
  function showTip(p, it) {
    const w = app.world;
    const yr = Math.max(0, Math.floor(yearAt(p.x)));
    let title = `Year ${F.int(yr)}`, text = '';
    if (it?.kind === 'entry') { title = `Year ${F.int(F.yearOfDay(it.entry.day))} · ${(CATEGORIES[it.entry.cat] || {}).label || ''}`; text = it.entry.text; }
    else if (it?.kind === 'war') { title = it.war.name; text = `${F.lifespan(it.war.startDay, it.war.active ? null : it.war.endDay)}${it.dead ? ' · ' + F.people(it.dead) + ' dead' : ''}`; }
    else if (it?.kind === 'plague') { title = it.plague.name; text = `${F.lifespan(it.plague.startDay, it.plague.active ? null : it.plague.endDay)} · ${F.people(it.plague.deaths || 0)} dead`; }
    else {
      const rec = (w.history?.years || []).find((r) => r.y === yr);
      if (rec) text = `${F.people(rec.pop)} people · ${F.eraName(rec.era)}`;
    }
    tipEl.textContent = '';
    tipEl.append(h('b', { text: title }), text ? document.createTextNode(text) : '');
    tipEl.hidden = false;
    const br = bar.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
    const tx = Math.max(4, Math.min(br.width - tipEl.offsetWidth - 4, cr.left - br.left + p.x - tipEl.offsetWidth / 2));
    tipEl.style.left = tx + 'px';
    tipEl.style.bottom = (br.height + 6) + 'px';
    // rewinding is offered for the year under the pointer, if the Chronoscope reaches it
    const ok = app.chrono && yr * Y >= app.chrono.earliestDay() && yr * Y < w.time.day - Y;
    rewindYear = ok ? yr : null;
    rewindBtn.hidden = !ok;
    if (ok) rewindBtn.textContent = `Rewind to Year ${F.int(yr)}`;
  }
  function travel(p) {
    const k = app.atlasNearest?.(yearAt(p.x));
    if (k != null && k >= 0) { if (app.tab !== 'atlas') app.setTab('atlas'); app.emit('atlasGoto', k); }
  }
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    hover = p;
    if (drag) { drag.moved = drag.moved || Math.abs(p.x - drag.x) > 4; if (drag.moved) travel(p); }
    showTip(p, hitAt(p));
    draw();
  });
  canvas.addEventListener('pointerleave', () => { hover = null; tipEl.hidden = true; draw(); });
  canvas.addEventListener('pointerdown', (e) => { drag = { x: local(e).x, moved: false }; try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } });
  canvas.addEventListener('pointerup', (e) => {
    const d = drag; drag = null;
    if (!d || d.moved) return;
    const p = local(e);
    const it = hitAt(p);
    if (it?.kind === 'entry') { focusEntry(app, it.entry); app.emit('chronicleScrollTo', it.entry.seq); }
    else if (it?.kind === 'war') app.select({ kind: 'war', id: it.war.id }, { frame: true });
    else if (it?.kind === 'plague') app.select({ kind: 'plague', id: it.plague.id }, { frame: true });
    travel(p);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [y0, y1] = span();
    const full = [Math.min(app.world.history?.years?.[0]?.y ?? 0, 0), Math.max(1, app.world.time.day / Y)];
    const at = yearAt(local(e).x);
    const f = Math.exp(Math.max(-300, Math.min(300, e.deltaY)) * 0.002);
    let a = at - (at - y0) * f, b = at + (y1 - at) * f;
    if (b - a < 20) { const m = (a + b) / 2; a = m - 10; b = m + 10; }
    if (a <= full[0] && b >= full[1]) range = null; else range = [Math.max(full[0], a), Math.min(full[1], b)];
    sig = '';
    draw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { range = null; sig = ''; draw(); });

  // --- refresh -----------------------------------------------------------------------------
  app.on('tick', () => {
    if (!open || !app.world) return;
    const w = app.world;
    const s = `${w.history?.years?.length}|${w.wars.length}|${w.plagues.length}|${w.chronicle.seq}|${app.atlasIndex}|${app.chrono?.stats?.().frames.length || 0}|${Math.floor(w.time.day / Y)}`;
    if (s !== sig) { sig = s; draw(); }
  });
  app.on('world', () => { range = null; sig = ''; if (getPref('story.timeline', false) && !open) setOpen(true); else if (open) draw(); });
  app.on('atlas', () => { sig = ''; draw(); });
  app.on('theme', () => { sig = ''; draw(); });
  window.addEventListener('resize', () => { if (open) { sig = ''; draw(); } });

  // --- event pins: the overlay toggle, hover text and clicks --------------------------------
  if (pinsMod) {
    registerOverlay({ id: 'events', label: 'Events', desc: 'Pins where the great events of the last 25 years happened.', default: true });
    const entriesOf = (id) => {
      const t = pinsMod.pinTarget?.(id);
      const w = app.world;
      if (!t || !w) return null;
      return { t, list: t.seqs.map((q) => chronicleEntry(w, q)).filter(Boolean) };
    };
    app.pinInfo = (id) => {
      const r = entriesOf(id);
      if (!r || !r.list.length) return null;
      const e = r.list[0];
      const cat = (CATEGORIES[e.cat] || {}).label || '';
      if (r.list.length === 1) return { title: `${cat} · ${F.monthYear(e.day)}`, text: e.text };
      return { title: `${r.list.length} great events here`, text: `Latest: ${e.text}` };
    };
    app.on('pinPicked', (id) => {
      const r = entriesOf(id);
      if (!r || !r.list.length) return;
      if (r.list.length === 1) { focusEntry(app, r.list[0]); app.emit('chronicleScrollTo', r.list[0].seq); return; }
      const z = app.renderer?.camera?.zoom || 6;
      if (z < 20) { app.emit('userCamera', { how: 'pin' }); app.focus(r.t.x, r.t.y, Math.min(80, z * 2.5)); return; }
      // close in already: list them
      const list = h('div.saga-list');
      const m = openModal({ title: 'Here, in recent years', small: true, body: list, actions: [{ label: 'Close', cls: 'btn-brass', onClick: (mm) => mm.close() }] });
      for (const e of r.list.slice().sort((a, b) => b.day - a.day)) {
        const row = h('button.saga-entry', { type: 'button', class: `imp-${e.imp}` }, h('span.y', { text: 'Y' + F.yearOfDay(e.day) }), h('span.t', { text: e.text }));
        row.addEventListener('click', () => { m.close(); focusEntry(app, e); app.emit('chronicleScrollTo', e.seq); });
        list.appendChild(row);
      }
    });
  }

  registerKey({ key: 'y', label: 'The history timeline', group: 'Story', when: (a) => Boolean(a.world), run: () => setOpen(!open) });
  registerCommand({ id: 'timeline.toggle', label: 'History timeline', group: 'Story', icon: 'statistics', keys: 'Y', keywords: ['timeline', 'history', 'wars', 'eras', 'scrub', 'past'], menu: 'Story', when: (a) => Boolean(a.world), run: () => setOpen(!open) });
}
