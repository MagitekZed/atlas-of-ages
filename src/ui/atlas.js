// The Atlas tab: a historical atlas of borders. Scrub the snapshots in world.history.atlas
// (taken every ten years), play them as a timelapse, and read who held the world then and
// what happened. The map itself switches to the snapshot (renderer.setAtlasSnapshot); this
// tab also draws its own plate (src/ui/plate.js drawAtlasPlate) so it works with any renderer.
// Looking into the past stops time (and leaving restores the pace), so the present does not
// run on beneath an old map; with the Chronoscope, "Rewind to this moment" makes the past the
// present again. The app events atlasGoto (k) and timeTravel (year) bring a plate up.

import { DAYS_PER_YEAR } from '../core/constants.js';
import { drawAtlasPlate } from './plate.js';
import { h, clear, svgEl, setText } from './dom.js';
import { glyph } from './icons.js';
import { tip, rangeInput, syncRange } from './widgets.js';
import { chartTheme, fitCanvas } from './charts.js';
import * as F from './format.js';
import { focusEntry } from './toasts.js';

const SPEEDS = [[600, '1×'], [300, '2×'], [140, '4×']];

export function createAtlas(app) {
  const el = h('div.tabpanel');
  let playing = null, speedMs = SPEEDS[0][0];

  const yearEl = h('div.atlas-year', { text: '—' });
  const ageEl = h('div.muted');
  const plateCanvas = h('canvas', { 'aria-label': 'Historical political map' });
  const cap = h('span.cap');
  const plate = h('div.atlas-plate.ticked', null, plateCanvas, cap);
  const timeline = h('canvas', { 'aria-label': 'Timeline of history. Click to travel.' });
  const tlWrap = h('div.timeline', null, timeline);
  const slider = rangeInput({ id: 'atlas-scrub', min: 0, max: 0, step: 1, value: 0, label: 'Atlas year', oninput: (v) => goto(v) });
  const prev = h('button.icon-btn', { type: 'button', 'aria-label': 'Previous decade' }, svgEl(glyph('back', 18)));
  const next = h('button.icon-btn', { type: 'button', 'aria-label': 'Next decade' }, svgEl(glyph('back', 18)));
  next.firstChild.style.transform = 'scaleX(-1)';
  const playBtn = h('button.btn.btn-sm', { type: 'button' });
  const speedSeg = h('div.seg', { role: 'group', 'aria-label': 'Timelapse speed' });
  for (const [ms, label] of SPEEDS) {
    const b = h('button', { type: 'button', text: label, 'aria-pressed': String(ms === speedMs) });
    b.addEventListener('click', () => { speedMs = ms; for (const x of speedSeg.children) x.setAttribute('aria-pressed', String(x === b)); if (playing) { stop(); play(); } });
    speedSeg.appendChild(b);
  }
  const presentBtn = h('button.btn.btn-sm.btn-brass', { type: 'button', text: 'Return to the present' });
  const rewindBtn = h('button.btn.btn-sm', { type: 'button', text: 'Rewind to this moment', hidden: true });
  tip(rewindBtn, 'Make this year the present again: history since is unwritten, or kept as a branch.', 'Chronoscope');
  rewindBtn.addEventListener('click', () => rewindHere());
  tip(prev, 'Ten years earlier'); tip(next, 'Ten years later');
  // from the present the latest plate is already on show, so "earlier" means the one before it
  prev.addEventListener('click', () => goto((app.atlasIndex ?? count() - 1) - 1));
  next.addEventListener('click', () => goto((app.atlasIndex ?? count() - 1) + 1));
  playBtn.addEventListener('click', () => (playing ? stop() : play()));
  presentBtn.addEventListener('click', () => exit());
  const nationsList = h('div.list');
  const eventsList = h('div');
  const emptyNote = h('p.empty-note', { hidden: true, text: 'The first plate is drawn at the dawn of history; more follow every ten years.' });

  el.append(
    h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' } }, yearEl, ageEl),
    plate,
    h('div.scrubber', null, tlWrap, slider,
      h('div.row', null, prev, playBtn, next, speedSeg, h('span', { style: { flex: '1' } }), rewindBtn, presentBtn)),
    emptyNote,
    h('section.ins-section', null, h('h4.rule-head', { text: 'Nations of the age' }), nationsList),
    h('section.ins-section', null, h('h4.rule-head', { text: 'Events of the decade' }), eventsList),
  );

  const banner = document.getElementById('atlas-banner');
  // the banner rides above the toolbelt, clear of the cartouche, drive and toasts
  const belt = document.getElementById('palette');
  if (belt && banner && banner.parentElement !== belt) belt.prepend(banner);
  const bannerYear = h('span.y');
  const bannerNote = h('span.k.banner-note', { text: 'time paused' });
  const bannerBack = h('button.btn.btn-sm.btn-brass', { type: 'button', text: 'Return to the present' });
  bannerBack.addEventListener('click', () => exit());
  const bannerRewind = h('button.btn.btn-sm', { type: 'button', text: 'Rewind to here', hidden: true });
  bannerRewind.addEventListener('click', () => rewindHere());
  clear(banner);
  banner.append(h('span.k', { text: 'Historical atlas' }), bannerYear, bannerNote, bannerRewind, bannerBack);

  // looking into the past stops time once; leaving brings the pace back
  let resumeSpeed = null;
  function holdTime() {
    if (resumeSpeed != null || !app.sim) return;
    resumeSpeed = app.speed;
    if (resumeSpeed > 0) app.pause();
  }
  function releaseTime() {
    const k = resumeSpeed;
    resumeSpeed = null;
    if (k > 0 && app.speed === 0 && app.world) app.setSpeed(k);
  }
  /** The Chronoscope can make a past plate the present again. */
  function canRewind() {
    const s = app.atlasIndex != null ? snaps()[app.atlasIndex] : null;
    const day = s ? (s.day ?? s.y * DAYS_PER_YEAR) : null;
    return Boolean(app.chrono && s && day < app.world.time.day && day >= app.chrono.earliestDay());
  }
  async function rewindHere() {
    const s = app.atlasIndex != null ? snaps()[app.atlasIndex] : null;
    if (!s || !app.chrono) return;
    const day = s.day ?? s.y * DAYS_PER_YEAR;
    const done = await app.chrono.rewindTo(day);
    if (done) { resumeSpeed = null; exit(); }
  }

  const snaps = () => app.world?.history?.atlas || [];
  let shownDay = null;   // the plate on screen, so thinning (which shifts indices) cannot swap it
  const count = () => snaps().length;

  function syncPlay() {
    clear(playBtn);
    playBtn.append(svgEl(glyph(playing ? 'pause' : 'play', 14)), playing ? 'Pause' : 'Play timelapse');
  }
  syncPlay();

  function goto(k) {
    const n = count();
    if (!n) return;
    k = Math.max(0, Math.min(n - 1, Math.round(k)));
    holdTime();
    app.atlasIndex = k;
    shownDay = snaps()[k].day ?? snaps()[k].y * 360;
    app.r('setAtlasSnapshot', snaps()[k]);
    app.emit('atlas', k);
    banner.hidden = false;
    draw();
  }

  function exit() {
    stop();
    if (app.atlasIndex == null) { releaseTime(); return; }
    app.atlasIndex = null;
    app.r('setAtlasSnapshot', null);
    app.emit('atlas', null);
    banner.hidden = true;
    releaseTime();
    draw();
  }

  /** The plate nearest a year (index), or -1 when there are none. */
  function nearestSnapshot(year) {
    const ss = snaps();
    let best = -1, bd = Infinity;
    ss.forEach((s, j) => { const d = Math.abs(s.y - year); if (d < bd) { bd = d; best = j; } });
    return best;
  }

  function play() {
    const n = count();
    if (n < 2) return;
    if (app.atlasIndex == null || app.atlasIndex >= n - 1) goto(0);
    playing = setInterval(() => {
      const k = (app.atlasIndex ?? 0) + 1;
      if (k >= count()) { stop(); return; }
      goto(k);
    }, speedMs);
    syncPlay();
  }
  function stop() { if (playing) clearInterval(playing); playing = null; syncPlay(); }

  // --- drawing ---------------------------------------------------------------------------
  function draw() {
    const w = app.world;
    const n = count();
    emptyNote.hidden = n > 1;
    slider.max = String(Math.max(0, n - 1));
    const k = app.atlasIndex ?? n - 1;
    slider.value = String(Math.max(0, k));
    syncRange(slider);
    prev.disabled = k <= 0; next.disabled = k >= n - 1;
    presentBtn.hidden = app.atlasIndex == null;
    if (!w || !n) { setText(yearEl, '—'); return; }
    const s = snaps()[k];
    setText(yearEl, `Year ${s.y}`);
    setText(ageEl, app.atlasIndex == null ? 'the latest plate' : `${F.span(w.time.day - (s.day ?? s.y * 360))} ago`);
    setText(bannerYear, `Year ${s.y}`);
    setText(cap, `Plate ${k + 1} of ${n} · Year ${s.y}`);
    const back = canRewind();
    rewindBtn.hidden = !back; bannerRewind.hidden = !back;
    try { drawAtlasPlate(plateCanvas, w, s); } catch (e) { app.reportError('atlas.plate', e); }
    drawTimeline(k);
    listNations(s);
    listEvents(k);
  }

  function drawTimeline(k) {
    const w = app.world;
    const cssW = timeline.clientWidth || 340, cssH = 44;
    const ctx = fitCanvas(timeline, cssW, cssH);
    const t = chartTheme();
    const ss = snaps();
    if (!ss.length) return;
    const y0 = ss[0].y, y1 = Math.max(y0 + 1, w.history.years.length ? Math.max(ss[ss.length - 1].y, w.history.years[w.history.years.length - 1].y) : ss[ss.length - 1].y);
    const X = (y) => 4 + ((y - y0) / Math.max(1, y1 - y0)) * (cssW - 8);
    // population curve
    const ys = w.history.years;
    let max = 0;
    for (const r of ys) if (r.pop > max) max = r.pop;
    if (ys.length > 1 && max > 0) {
      ctx.beginPath();
      ys.forEach((r, j) => { const x = X(r.y), y = cssH - 12 - (r.pop / max) * (cssH - 18); if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.lineWidth = 1.5; ctx.strokeStyle = t.c2; ctx.stroke();
    }
    // great events
    for (const e of w.chronicle.entries) {
      if (e.imp < 4) continue;
      const x = X(F.yearOfDay(e.day));
      ctx.fillStyle = e.imp >= 5 ? t.c3 : t.ink3;
      ctx.fillRect(Math.round(x), cssH - 9, 1, e.imp >= 5 ? 6 : 4);
    }
    // baseline + snapshot ticks
    ctx.fillStyle = t.axis; ctx.fillRect(4, cssH - 10, cssW - 8, 1);
    const sel = ss[Math.max(0, Math.min(ss.length - 1, k))];
    const x = X(sel.y);
    ctx.fillStyle = t.brass; ctx.fillRect(Math.round(x) - 1, 2, 2, cssH - 6);
    ctx.font = t.mono; ctx.fillStyle = t.ink3; ctx.textAlign = 'left'; ctx.fillText('Y' + y0, 4, cssH - 0.5);
    ctx.textAlign = 'right'; ctx.fillText('Y' + y1, cssW - 4, cssH - 0.5);
  }

  let tlDrag = false;
  const tlTravel = (e) => {
    const ss = snaps();
    if (!ss.length) return;
    const r = timeline.getBoundingClientRect();
    const y0 = ss[0].y, y1 = Math.max(y0 + 1, Math.max(ss[ss.length - 1].y, app.world.history.years.at(-1)?.y ?? 0));
    const yr = y0 + ((e.clientX - r.left - 4) / Math.max(1, r.width - 8)) * (y1 - y0);
    const best = nearestSnapshot(yr);
    if (best >= 0) goto(best);
  };
  timeline.addEventListener('pointerdown', (e) => { tlDrag = true; timeline.setPointerCapture(e.pointerId); stop(); tlTravel(e); });
  timeline.addEventListener('pointermove', (e) => { if (tlDrag) tlTravel(e); });
  timeline.addEventListener('pointerup', () => { tlDrag = false; });

  function listNations(s) {
    clear(nationsList);
    const w = app.world;
    const list = (s.civs || []).slice().sort((a, b) => (b[3] || 0) - (a[3] || 0)).slice(0, 14);
    if (!list.length) { nationsList.appendChild(h('p.empty-note', { text: 'No nation held land in this year.' })); return; }
    for (const [id, name, hex, area, pop] of list) {
      const c = w.civs[id];
      const row = h('button.row', { type: 'button' },
        h('i.swatch', { style: { '--c': hex || c?.colorHex } }), h('span.t', { text: name }),
        h('span.n', { text: F.area(area) }),
        h('span.s', { text: [pop ? F.people(pop) + ' people' : '', c ? (c.alive ? 'still stands' : `fell ${F.year(c.fallenDay)}`) : ''].filter(Boolean).join(' · ') }));
      row.addEventListener('click', () => app.select({ kind: 'civ', id }, { focus: false, openTab: false }));
      nationsList.appendChild(row);
    }
  }

  function listEvents(k) {
    clear(eventsList);
    const w = app.world;
    const ss = snaps();
    const yTo = ss[k].y, yFrom = k > 0 ? ss[k - 1].y : yTo - 10;
    const out = w.chronicle.entries.filter((e) => e.imp >= 3 && F.yearOfDay(e.day) > yFrom && F.yearOfDay(e.day) <= yTo).slice(-12).reverse();
    if (!out.length) { eventsList.appendChild(h('p.empty-note', { text: `Nothing of great note was recorded between Year ${yFrom} and Year ${yTo}.` })); return; }
    for (const e of out) {
      const row = h('div.ins-entry', { role: 'button', tabindex: '0', style: { cursor: 'pointer' } }, h('span.y', { text: 'Y' + F.yearOfDay(e.day) }), h('span', { text: e.text }));
      row.addEventListener('click', () => focusEntry(app, e, { openTab: false }));
      // a role="button" row must answer the keyboard too
      row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); focusEntry(app, e, { openTab: false }); } });
      eventsList.appendChild(row);
    }
  }

  app.on('tab', (id) => { if (id !== 'atlas') exit(); });
  app.on('atlasGoto', (k) => goto(k));
  app.on('timeTravel', (year) => { const k = nearestSnapshot(Number(year)); if (k >= 0) { app.setTab('atlas'); goto(k); } });
  app.atlasNearest = nearestSnapshot;
  app.on('theme', () => { if (el.offsetParent !== null && count()) draw(); });
  app.on('atlasExit', () => exit());
  app.on('world', () => { stop(); if (app.atlasIndex != null) app.r('setAtlasSnapshot', null); app.atlasIndex = null; resumeSpeed = null; banner.hidden = true; });
  new ResizeObserver(() => { if (el.offsetParent !== null && count()) drawTimeline(app.atlasIndex ?? count() - 1); }).observe(tlWrap);

  let lastN = -1;
  return {
    id: 'atlas', label: 'Atlas', title: 'Atlas', icon: 'atlas', el,
    show() { lastN = count(); draw(); },
    refresh() {
      if (count() === lastN) return;
      lastN = count();
      if (app.atlasIndex == null) { draw(); return; }
      const j = snaps().findIndex((q) => (q.day ?? q.y * 360) === shownDay);
      if (j >= 0 && j !== app.atlasIndex) app.atlasIndex = j;
      else if (j < 0) { goto(Math.min(app.atlasIndex, lastN - 1)); return; }
      draw();
    },
    onWorld() { lastN = -1; },
  };
}
