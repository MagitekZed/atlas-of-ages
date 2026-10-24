// The map dock: map-mode picker and legend, overlay toggles, the minimap (click or drag to
// travel), a readout of the ground under the cursor, and the zoom ladder: a cartographic
// scale bar (1-2-5 km) with a badge naming how far down the view is (World … Street, from
// renderer.getZoomInfo) and what appears closer in. Overlays other packages register
// (src/ui/registry.js registerOverlay) follow the built-in toggles; the renderer keeps them
// in r.overlays[id] for the package's layer to read.

import { elevationMeters } from '../core/world.js';
import { WATER, KM_PER_TILE } from '../core/constants.js';
import { h, clear, svgEl, setText } from './dom.js';
import { glyph } from './icons.js';
import { tip, openPopover, closePopover, graduationSVG } from './widgets.js';
import { latLon, temp, int, biomeName } from './format.js';
import { getPref, setPref } from './prefs.js';
import { getOverlays, onRegistryChange } from './registry.js';
import { fixtureFrame } from './frame.js';

export const OVERLAYS = [
  ['borders', 'Borders', 'National borders.'],
  ['labels', 'Names', 'Settlement names.'],
  ['features', 'Geography', 'Seas, ranges, rivers and continents.'],
  ['rivers', 'Rivers', 'Rivers and streams.'],
  ['roads', 'Roads', 'Tracks, roads and highways.'],
  ['routes', 'Trade', 'Trade routes, caravans and ships.'],
  ['units', 'Armies', 'Armies, fleets and storms.'],
  ['clouds', 'Clouds', 'The drifting cloud layer.'],
];

/** Every overlay toggle: the built-ins, then the registered ones ([key, label, desc, default]). */
const allOverlays = () => [...OVERLAYS, ...getOverlays().map((o) => [o.id, o.label, o.desc || '', Boolean(o.default)])];

export function mountMapDock(app) {
  const dock = document.getElementById('mapdock');
  clear(dock);
  fixtureFrame(dock);

  const modeVal = h('span.val', { text: 'Terrain' });
  const modeBtn = h('button.mode-btn', { type: 'button', 'aria-haspopup': 'true', 'aria-label': 'Map mode' },
    h('span', { style: { display: 'flex', flexDirection: 'column', minWidth: '0', flex: '1' } }, h('span.lbl', { text: 'Map' }), modeVal),
    svgEl(glyph('chevron', 16)));
  tip(modeBtn, 'Choose what the map shows.', 'Map mode', 'M');
  modeBtn.addEventListener('click', () => openModeList());
  const layersBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Overlays', 'aria-haspopup': 'true' }, svgEl(glyph('layers', 18)));
  tip(layersBtn, 'Borders, names, roads, armies and other layers.', 'Overlays');
  layersBtn.addEventListener('click', () => openOverlays(layersBtn));
  const minBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Fold the map dock' }, svgEl(glyph('chevron', 16)));
  minBtn.addEventListener('click', () => {
    dock.classList.toggle('is-min');
    setPref('dockMin', dock.classList.contains('is-min'));
    syncMin();
  });
  const syncMin = () => {
    clear(minBtn);
    const min = dock.classList.contains('is-min');
    minBtn.appendChild(svgEl(glyph(min ? 'chevronUp' : 'chevron', 16)));
    tip(minBtn, min ? 'Show the legend and minimap.' : 'Fold away the legend and minimap.', min ? 'Unfold' : 'Fold');
  };
  if (getPref('dockMin', false)) dock.classList.add('is-min');
  syncMin();

  const legend = h('div.legend');
  const mini = h('canvas', { width: 236, height: 148, 'aria-label': 'Minimap. Click or drag to move the view.' });
  const miniWrap = h('div.minimap-wrap', null, mini, h('div.grat', { html: graduationSVG(0) }));
  const readout = h('div.dock-readout', { 'aria-live': 'off' });
  const zoomBadge = h('span.zoom-badge');
  const scaleBar = h('i.scale-bar');
  const scaleText = h('span.scale-km');
  const zoomNext = h('span.zoom-next');
  const scaleRow = h('div.scale-row', { 'aria-label': 'Map scale' }, zoomBadge, h('span.scale', null, scaleBar, scaleText), zoomNext);
  dock.append(h('div.dock-head', null, modeBtn, layersBtn, minBtn), legend, miniWrap, readout, scaleRow);

  // --- map modes ----------------------------------------------------------------------
  const currentMode = () => app.renderer?.mapMode || getPref('mapMode', 'terrain');
  function setMode(id) {
    app.r('setMapMode', id);
    setPref('mapMode', id);
    app.emit('mapmode', id);
  }
  app.cycleMapMode = (dir = 1) => {
    const modes = app.mapModes();
    const k = modes.findIndex((m) => m.id === currentMode());
    const next = modes[(k + dir + modes.length) % modes.length];
    if (next) setMode(next.id);
  };
  function openModeList() {
    const modes = app.mapModes();
    const list = h('div.mode-list', { role: 'listbox', 'aria-label': 'Map modes' });
    for (const m of modes) {
      const b = h('button.menu-item', { type: 'button', role: 'option', 'aria-selected': m.id === currentMode() ? 'true' : 'false', class: m.id === currentMode() ? 'is-on' : '' },
        h('span.t', { text: m.label }), m.desc ? h('span.d', { text: m.desc }) : null);
      b.addEventListener('click', () => { closePopover(); setMode(m.id); modeBtn.focus(); });
      list.appendChild(b);
    }
    if (openPopover(modeBtn, list, { side: 'above' })) {
      // start on the mode in use (the list scrolls; it may be far down)
      setTimeout(() => { const on = list.querySelector('.is-on'); if (on) { on.focus({ preventScroll: true }); on.scrollIntoView({ block: 'nearest' }); } }, 0);
    }
  }

  function openOverlays(anchor) {
    const ov = readOverlays();
    const grid = h('div.overlay-grid');
    for (const [key, label, desc] of allOverlays()) {
      const b = h('button.chip', { type: 'button', 'aria-pressed': ov[key] !== false ? 'true' : 'false' }, label);
      tip(b, desc, label);
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        app.r('setOverlay', key, on);
        const saved = getPref('overlays', {}) || {};
        saved[key] = on;
        setPref('overlays', saved);
        app.emit('overlays');
      });
      grid.appendChild(b);
    }
    openPopover(anchor, h('div', null, h('div.menu-label', { text: 'Overlays' }), grid), { side: 'above' });
  }

  function readOverlays() {
    const o = app.renderer?.overlays;
    const out = {};
    if (!o) return out;
    const list = allOverlays();
    if (o instanceof Set) { for (const [k] of list) out[k] = o.has(k); }
    else if (Array.isArray(o)) { for (const [k] of list) out[k] = o.includes(k); }
    else if (typeof o === 'object') { for (const [k, , , def] of list) if (k in o) out[k] = Boolean(o[k]); else if (def != null) out[k] = def; }
    return out;
  }

  function applySavedView() {
    const mode = getPref('mapMode', null);
    if (mode && app.mapModes().some((m) => m.id === mode)) app.r('setMapMode', mode);
    const saved = getPref('overlays', {}) || {};
    for (const [k, v] of Object.entries(saved)) app.r('setOverlay', k, Boolean(v));
    applyOverlayDefaults();
  }
  /** Registered overlays the viewer has never toggled start at their default. */
  function applyOverlayDefaults() {
    const saved = getPref('overlays', {}) || {};
    for (const o of getOverlays()) if (!(o.id in saved)) app.r('setOverlay', o.id, Boolean(o.default));
  }
  onRegistryChange((kind) => { if (kind === 'overlay' && app.renderer) applyOverlayDefaults(); });

  // --- legend ---------------------------------------------------------------------------
  let legendSig = '';
  function refreshLegend(force = false) {
    const modes = app.mapModes();
    const m = modes.find((q) => q.id === currentMode()) || modes[0];
    setText(modeVal, m ? m.label : 'Terrain');
    const lg = app.r('getLegend');
    const sig = lg ? JSON.stringify(lg).slice(0, 2000) : '';
    if (!force && sig === legendSig) return;
    legendSig = sig;
    clear(legend);
    if (!lg) return;
    if (lg.type === 'gradient' && Array.isArray(lg.stops) && lg.stops.length) {
      const stops = lg.stops.map(([t, c]) => `${c} ${(Math.max(0, Math.min(1, Number(t) || 0)) * 100).toFixed(1)}%`).join(', ');
      legend.appendChild(h('div.bar', { style: { background: `linear-gradient(90deg, ${stops})` } }));
      if (Array.isArray(lg.ticks) && lg.ticks.length >= 2) {
        // labelled ticks at their own positions; the outermost hug the ends
        const row = h('div.ticks');
        for (const [t, label] of lg.ticks) {
          const f = Math.max(0, Math.min(1, Number(t) || 0));
          const shift = f < 0.04 ? '0%' : f > 0.96 ? '-100%' : '-50%';
          row.appendChild(h('span', { text: String(label), style: { left: (f * 100).toFixed(1) + '%', transform: `translateX(${shift})` } }));
        }
        legend.appendChild(row);
      } else {
        const lo = lg.minLabel ?? lg.min ?? lg.low ?? lg.labels?.[0] ?? '';
        const hi = lg.maxLabel ?? lg.max ?? lg.high ?? lg.labels?.[lg.labels.length - 1] ?? '';
        if (lo !== '' || hi !== '') legend.appendChild(h('div.ends', null, h('span', { text: String(lo) }), h('span', { text: String(hi) })));
      }
    }
    if (Array.isArray(lg.items) && lg.items.length) {
      const sw = h('div.sw');
      for (const it of lg.items.slice(0, 24)) {
        const lab = String(it.label ?? '');
        sw.appendChild(h('span', null, h('i.swatch', { style: { '--c': it.color } }), h('b', { text: lab ? lab[0].toUpperCase() + lab.slice(1) : lab })));
      }
      if (lg.items.length > 24) sw.appendChild(h('span', null, h('b', { text: `and ${lg.items.length - 24} more` })));
      legend.appendChild(sw);
    }
  }

  // --- minimap --------------------------------------------------------------------------
  const mctx = mini.getContext('2d');
  function sizeMini() {
    const w = app.world;
    if (!w) return;
    const cssW = Math.max(120, Math.round(mini.clientWidth || 236));
    const cssH = Math.round(cssW * (w.H / w.W));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (mini.width !== Math.round(cssW * dpr) || mini.height !== Math.round(cssH * dpr)) {
      mini.width = Math.round(cssW * dpr);
      mini.height = Math.round(cssH * dpr);
      mini.style.height = cssH + 'px';
    }
  }
  function drawMini() {
    // getClientRects is empty when the dock (or an ancestor) is display:none; offsetParent would also be null for position:fixed
    if (!app.world || dock.classList.contains('is-min') || dock.getClientRects().length === 0) return;
    sizeMini();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.clearRect(0, 0, mini.width, mini.height);
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    app.r('drawMinimap', mctx, mini.width / dpr, mini.height / dpr);
  }
  let dragging = false, dragZoom = null;
  // a click flies to the spot; dragging then follows the pointer directly, at the zoom the drag began with
  // (a flight restarted on every move would barely move, and would sink to its mid-flight zoom)
  const travel = (e, direct = false) => {
    const w = app.world;
    const cam = app.renderer?.camera;
    if (!w || !cam) return;
    const r = mini.getBoundingClientRect();
    const x = Math.max(0, Math.min(w.W, ((e.clientX - r.left) / Math.max(1, r.width)) * w.W));
    const y = Math.max(0, Math.min(w.H, ((e.clientY - r.top) / Math.max(1, r.height)) * w.H));
    app.emit('userCamera', { how: 'minimap' });
    if (!direct) { app.r('focusOn', x, y, dragZoom); return; }
    const view = canvasEl.getBoundingClientRect();
    if (dragZoom > 0 && cam.zoom > 0 && Math.abs(cam.zoom - dragZoom) > 1e-6) app.r('zoomAt', view.width / 2, view.height / 2, dragZoom / cam.zoom, true);
    app.r('pan', (cam.x - x) * cam.zoom, (cam.y - y) * cam.zoom);
  };
  const canvasEl = document.getElementById('map');
  mini.addEventListener('pointerdown', (e) => { dragging = true; dragZoom = app.renderer?.camera?.zoom; try { mini.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ } travel(e); });
  mini.addEventListener('pointermove', (e) => { if (dragging) travel(e, true); });
  mini.addEventListener('pointerup', () => { dragging = false; });
  mini.addEventListener('pointercancel', () => { dragging = false; });

  // --- cursor readout -----------------------------------------------------------------------
  function showReadout(t) {
    const w = app.world;
    clear(readout);
    if (!w || !t) { readout.appendChild(h('span.muted', { text: 'Point at the map to survey the ground.' })); return; }
    const f = w.f, i = t.i;
    const water = f.water[i] !== WATER.LAND;
    const m = elevationMeters(w, i);
    const owner = f.owner[i] >= 0 ? w.civs[f.owner[i]] : null;
    const sid = f.settle[i];
    const place = sid >= 0 ? w.settlements[sid]?.name : null;
    readout.appendChild(h('div.place', { text: place ? `${place}${owner ? ' · ' + owner.name : ''}` : owner ? owner.name : water ? (f.water[i] === WATER.LAKE ? 'Lake' : 'Open sea') : 'Unclaimed land' }));
    readout.appendChild(h('div', { text: `${latLon(w, t.x, t.y)}` }));
    readout.appendChild(h('div', { text: `${water ? 'Depth ' + int(-m) : int(m)} m · ${biomeName(f.biome[i])} · ${temp(f.temp[i])}` }));
  }
  showReadout(null);

  // --- the zoom ladder: scale bar and badge -------------------------------------------------
  const NEXT_HINT = { World: 'nations and seas', Continent: 'towns and ranges', Region: 'roads and fields', Province: 'walls and districts', Town: 'streets and buildings', Street: '' };
  let scaleZ = -1, scaleAt = 0;
  function syncScale(t) {
    requestAnimationFrame(syncScale);
    if (t - scaleAt < 100) return;
    scaleAt = t;
    const r = app.renderer;
    if (!r || !app.world || dock.getClientRects().length === 0) return;
    const z = r.camera?.zoom;
    if (!Number.isFinite(z) || Math.abs(z - scaleZ) < 1e-3) return;
    scaleZ = z;
    let info = null;
    try { info = typeof r.getZoomInfo === 'function' ? r.getZoomInfo() : null; } catch (e) { info = null; }
    const kmPerPx = info && Number.isFinite(info.kmPerPx) ? info.kmPerPx : KM_PER_TILE / z;
    const want = 110 * kmPerPx;
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, want))));
    const nice = [5, 2, 1].map((m) => m * p).find((v) => v <= want) || p;
    scaleBar.style.width = Math.max(12, Math.round(nice / kmPerPx)) + 'px';
    setText(scaleText, nice >= 1 ? `${int(nice)} km` : `${Math.round(nice * 1000)} m`);
    const name = info?.name || '';
    setText(zoomBadge, name);
    zoomBadge.hidden = !name;
    // the renderer's own ladder says what its next band draws; this table only stands in for a renderer without it
    const hint = info && typeof info.nextHint === 'string' ? info.nextHint : NEXT_HINT[name];
    setText(zoomNext, hint ? `closer: ${hint}` : '');
  }
  requestAnimationFrame(syncScale);

  // --- wiring -----------------------------------------------------------------------------
  app.on('hover', (t) => showReadout(t));
  app.on('mapmode', () => refreshLegend(true));
  app.on('renderer', () => { applySavedView(); refreshLegend(true); });
  app.on('world', () => { applySavedView(); refreshLegend(true); sizeMini(); drawMini(); });
  app.on('atlas', () => refreshLegend(true));
  app.on('theme', () => refreshLegend(true));
  let n = 0;
  app.on('tick', () => { drawMini(); if (++n % 8 === 0) refreshLegend(); });
  app.on('toggleDockPhone', () => { dock.classList.toggle('is-open-phone'); requestAnimationFrame(() => { refreshLegend(true); drawMini(); }); });
}
