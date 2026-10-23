// The app context shared by every UI module: the live world, simulation and renderer, the
// UI state (tool, selection, tab, speed, follow), an event bus, and the actions modules call.
//
// Events: world (new/loaded world) · tick (≤ 4 Hz panel refresh) · select · tool · speed ·
//         tab · mapmode · overlays · atlas · theme · layout · params · follow
// Expansion events (contracts §15):
//   userCamera { how }                the viewer moved the map (drag, wheel, pinch, keys, minimap)
//   mapContext { sx, sy, tile, picks } right-click without a drag, or a long-press in Inspect
//   mapDblClick { sx, sy, tile, pick } a double-click (or double-tap) on the map
//   leapDone { fromDay, toDay, seq0, hit, cancelled }  after Menu › Leap ahead
//   worldRestored { reason, fromDay, toDay }           after app.restoreWorld
//   toolApplied { kind, id, x, y, opts, result, seq }  relayed from the kernel hook
//   chronicleScrollTo (seq) · timeTravel (year) · atlasGoto (k)   requests other panels answer
// Selection kinds beyond the built-in ones reach the map through their registered view
// (src/ui/registry.js registerView: point, frame, rendererSel).
//
// Follow (app.follow = { kind, id } | null) keeps the camera on something: a mover (army,
// storm, band…) is kept centred; a region (a nation, a war's theatre, a plague's front) is
// re-framed every two seconds. Selecting something else keeps it; moving the map yourself
// ends it (a zoom keeps following a mover, around it). Setting app.follow emits 'follow'.

import { SPEEDS, CATEGORIES } from '../core/constants.js';
import { getTool } from '../core/tools.js';
import { dateString } from '../core/world.js';
import { getPref, setPref } from './prefs.js';
import { BUILTIN_TABS, BUILTIN_VIEW_KINDS, getTabs, getView, onRegistryChange } from './registry.js';
import * as F from './format.js';

/** Tab ids: the built-ins, then registered tabs in rail order. Kept up to date in place, so importers may hold it. */
export const TABS = BUILTIN_TABS.map((t) => t.id);
export const MAX_SPEED = SPEEDS.length - 1;

function syncTabs() {
  const ids = [...BUILTIN_TABS.map((t) => t.id), ...getTabs().map((t) => t.id)];
  TABS.length = 0;
  TABS.push(...ids);
}
onRegistryChange((kind) => { if (kind === 'tab') syncTabs(); });
syncTabs();

const BUILTIN_KINDS = new Set(BUILTIN_VIEW_KINDS);
/** Kinds that move about the map: following one keeps it centred (others are framed as regions). */
const MOVER_KINDS = new Set(['army', 'storm', 'band', 'caravan', 'swarm', 'fire']);
export const isMoverKind = (kind) => MOVER_KINDS.has(kind);

export function createApp() {
  const handlers = Object.create(null);
  let follow = null;

  const app = {
    world: null,
    sim: null,
    renderer: null,
    renderInfo: { fallback: false, error: null },
    modules: { render: null, gen: null, fallbackGen: null },
    systems: [],
    loadErrors: [],           // [{ path, message }]
    errors: [],               // runtime errors shown in the engine room
    running: false,           // a world is live and the loop may advance it
    tool: 'inspect',
    toolSettings: getPref('toolSettings', {}) || {},
    selection: null,          // { kind, id, x, y }
    history: [],              // inspector back stack
    tab: getPref('tab', 'inspector'),
    lastSpeed: 2,
    atlasIndex: null,         // index into world.history.atlas while viewing the past
    autoPause: getPref('autoPause', true),
    autosave: getPref('autosave', false),
    measured: { dps: 0 },

    /** { kind, id } the camera keeps in view, or null. Assigning it emits 'follow'. */
    get follow() { return follow; },
    set follow(v) {
      const next = v && v.kind != null && v.id != null ? { kind: v.kind, id: v.id } : null;
      if ((next && follow && next.kind === follow.kind && next.id === follow.id) || (!next && !follow)) return;
      follow = next;
      app.emit('follow', follow);
    },

    /** Every tab id (built-in and registered). */
    get TABS() { return TABS; },

    on(ev, fn) { (handlers[ev] ||= []).push(fn); return () => { handlers[ev] = handlers[ev].filter((h) => h !== fn); }; },
    /** Is anyone listening for this event? (Gestures that would otherwise do nothing, such as a long-press, ask first.) */
    hasListeners(ev) { return Boolean(handlers[ev] && handlers[ev].length); },
    emit(ev, ...args) {
      const hs = handlers[ev];
      if (!hs) return;
      for (const h of hs.slice()) {
        try { h(...args); } catch (e) { app.reportError(`ui:${ev}`, e); }
      }
    },

    reportError(where, e) {
      const msg = (e && e.message) || String(e);
      console.error(`[${where}]`, e);
      app.errors.push({ where, message: msg, day: app.world?.time?.day ?? null });
      if (app.errors.length > 50) app.errors.shift();
    },

    // --- renderer access, guarded (the renderer is another owner's module) ---------
    r(method, ...args) {
      const r = app.renderer;
      if (!r || typeof r[method] !== 'function') return undefined;
      try { return r[method](...args); } catch (e) { app.reportError(`renderer.${method}`, e); return undefined; }
    },

    // --- speed ---------------------------------------------------------------------
    get speed() { return app.sim ? app.sim.speedIndex : 0; },
    setSpeed(i) {
      if (!app.sim) return;
      const k = Math.max(0, Math.min(MAX_SPEED, i | 0));
      if (k > 0) app.lastSpeed = k;
      app.sim.setSpeed(k);
      app.emit('speed', k);
    },
    togglePause() {
      if (!app.sim) return;
      app.setSpeed(app.sim.speedIndex === 0 ? (app.lastSpeed || 2) : 0);
    },
    pause() { if (app.sim && app.sim.speedIndex !== 0) app.setSpeed(0); },

    // --- tools -----------------------------------------------------------------------
    lastTool: null,           // the god tool used last (the context menu offers it again)
    setTool(id) {
      const next = id && id !== 'inspect' && getTool(id) ? id : 'inspect';
      if (next === app.tool) return;
      app.tool = next;
      if (next !== 'inspect') app.lastTool = next;
      if (next === 'inspect') { app.r('setBrush', null); app.r('setToolPreview', null); }
      app.emit('tool', next);
    },
    toolOptions(id) {
      const t = getTool(id);
      if (!t) return { radius: 0, strength: 1 };
      const saved = app.toolSettings[id] || {};
      const radius = Number.isFinite(saved.radius) ? saved.radius : (t.radius ?? 0);
      const strength = Number.isFinite(saved.strength) ? saved.strength : (t.strength?.default ?? 1);
      return { radius, strength };
    },
    setToolOption(id, key, value) {
      const s = (app.toolSettings[id] ||= {});
      s[key] = value;
      setPref('toolSettings', app.toolSettings);
    },

    // --- selection & camera ------------------------------------------------------------
    /** sel: { kind, id, x?, y? } | null. opts: { focus, zoom, keepHistory, fromHistory, openTab, frame } */
    select(sel, opts = {}) {
      sel = canonicalSel(app, sel);
      const prev = app.selection;
      if (sel && prev && sel.kind === prev.kind && sel.id === prev.id && !opts.force) {
        if (opts.frame) app.frameSelection();
        else if (opts.focus) app.focusSelection(opts.zoom);
        if (opts.openTab !== false) app.setTab('inspector');
        return;
      }
      if (prev && !opts.fromHistory && sel) {
        app.history.push(prev);
        if (app.history.length > 30) app.history.shift();
      }
      if (!sel) app.history.length = 0;
      app.selection = sel ? { ...sel } : null;
      // following survives a new selection (contracts §15): only moving the map ends it
      app.r('setSelection', rendererSelection(app, app.selection));
      app.emit('select', app.selection);
      if (sel && opts.frame) app.frameSelection();
      else if (sel && opts.focus) app.focusSelection(opts.zoom);
      if (sel && opts.openTab !== false) app.setTab('inspector');
    },
    back() {
      const prev = app.history.pop();
      if (prev) app.select(prev, { fromHistory: true, focus: true });
    },
    focusSelection(zoom) {
      const p = selectionPoint(app, app.selection);
      if (p) app.focus(p.x, p.y, zoom);
    },
    /** Frame the whole selection (a nation's lands, a war's theatre…), or focus on its point. */
    frameSelection(pad) {
      const b = selectionFrame(app, app.selection);
      if (b) app.frameBox(b, pad);
      else app.focusSelection();
    },
    /**
     * Fly to frame a box of entity coordinates (inclusive) in the open part of the map: on a
     * phone with the sheet open that is the strip above it. pad: CSS px kept clear (default 48).
     */
    frameBox(b, pad = 48) {
      const r = app.renderer, cam = r?.camera;
      if (!b || ![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite)) return;
      if (!cam || !(r.viewW > 0)) { app.r('frameBox', b.x0, b.y0, b.x1, b.y1, pad); return; }
      let bias = (typeof app.viewBias === 'function' && app.viewBias()) || 0;
      let strip = typeof app.openStripHeight === 'function' ? app.openStripHeight() : null;
      if (!(Number.isFinite(strip) && strip > 0)) {
        // desktop: frame between the instruments at the top (cartouche, drive) and the tool belt below
        const band = clearBand();
        if (band) { strip = band.h; bias = band.bias; }
      }
      const vw = r.viewW, vh = Number.isFinite(strip) && strip > 0 ? strip : r.viewH;
      const p = Math.max(0, Math.min(Number.isFinite(pad) ? pad : 48, Math.min(vw, vh) / 3));
      const bw = Math.abs(b.x1 - b.x0) + 1, bh = Math.abs(b.y1 - b.y0) + 1;
      let z = Math.min((vw - 2 * p) / bw, (vh - 2 * p) / bh);
      z = Math.max(cam.minZoom || 0.25, Math.min(cam.maxZoom || 80, z));
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      app.r('focusOn', cx + 0.5, cy + 0.5 - (Number.isFinite(bias) ? bias : 0) / Math.max(1e-6, z), z);
    },
    /** Where the followed entity is now (tile coords), or null. */
    followPoint() { return follow ? selectionPoint(app, follow) : null; },
    /** Is { kind, id } the entity being followed? */
    isFollowing(sel) { return Boolean(follow && sel && follow.kind === sel.kind && follow.id === sel.id); },
    /** Start following sel (or stop, with null): a mover is centred, a region framed. */
    setFollow(sel) {
      app.follow = sel || null;
      if (!follow) return;
      if (followMode(follow) === 'frame') { const b = selectionFrame(app, follow); if (b) app.frameBox(b); }
      else { const p = app.followPoint(); if (p) app.focus(p.x, p.y, Math.max(app.renderer?.camera?.zoom || 8, 8)); }
    },
    focus(x, y, zoom) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const z = zoom ?? Math.max(app.renderer?.camera?.zoom || 6, 7);
      // on a phone with the sheet open, frame the target in the strip of map above the sheet
      const bias = (typeof app.viewBias === 'function' && app.viewBias()) || 0;
      app.r('focusOn', x + 0.5, y + 0.5 - (Number.isFinite(bias) ? bias : 0) / Math.max(1e-6, z), z);
    },

    // --- tabs & panels -------------------------------------------------------------------
    setTab(id) {
      if (!TABS.includes(id)) return;
      // a registered tab this world has no use for (Legends in a Historical world) is not on the rail
      if (!tabOpen(app, getTabs().find((t) => t.id === id))) return;
      const changed = app.tab !== id;
      app.tab = id;
      setPref('tab', id);
      app.emit('tab', id, changed);
    },
  };

  // the viewer moving the map ends a follow; a zoom (or pinch) keeps a mover in view around it
  app.on('userCamera', (e) => {
    if (!follow) return;
    const how = e?.how;
    if ((how === 'zoom' || how === 'pinch') && followMode(follow) === 'point') return;
    app.follow = null;
  });
  return app;
}

/** Is a tab open to this world (a registered tab's when(app) holds)? Built-in tabs always are. */
export function tabOpen(app, tab) {
  if (!tab || typeof tab.when !== 'function' || !app) return true;
  try { return Boolean(tab.when(app)); } catch (e) { return false; }
}

/** 'point' (keep it centred) or 'frame' (keep its whole extent in view) for a followed selection. */
export function followMode(sel) {
  if (!sel) return 'point';
  if (MOVER_KINDS.has(sel.kind)) return 'point';
  if (sel.kind === 'civ' || sel.kind === 'war' || sel.kind === 'plague' || sel.kind === 'religion') return 'frame';
  if (BUILTIN_KINDS.has(sel.kind)) return 'point';
  const v = getView(sel.kind);
  return v && typeof v.frame === 'function' && typeof v.point !== 'function' ? 'frame' : 'point';
}

/** Where a selection lives on the map (tile coords), or null. */
export function selectionPoint(app, sel) {
  const w = app.world;
  if (!w || !sel) return null;
  switch (sel.kind) {
    case 'tile': {
      if (sel.x != null && sel.y != null) return { x: sel.x, y: sel.y };
      return Number.isFinite(sel.id) ? { x: sel.id % w.W, y: Math.floor(sel.id / w.W) } : null;
    }
    case 'settlement': { const s = w.settlements[sel.id]; return s ? { x: s.x, y: s.y } : null; }
    case 'civ': {
      const c = w.civs[sel.id];
      if (!c) return null;
      const cap = c.capitalId != null ? w.settlements[c.capitalId] : null;
      if (cap) return { x: cap.x, y: cap.y };
      return Number.isFinite(c.originX) ? { x: c.originX, y: c.originY } : null;
    }
    case 'army': { const a = w.armies.find((q) => q.id === sel.id); return a ? { x: a.x, y: a.y } : (sel.x != null ? { x: sel.x, y: sel.y } : null); }
    case 'storm': {
      const s = w.storms.find((q) => q.id === sel.id);
      if (s) return { x: s.x, y: s.y };
      const e = (w.history?.events || []).find((q) => q.t === 'storm' && q.sid === sel.id);   // an archived storm: where it was catalogued
      return e && Number.isFinite(e.x) && Number.isFinite(e.y) ? { x: e.x, y: e.y } : null;
    }
    case 'volcano': { const v = w.volcanoes.find((q) => q.id === sel.id); return v ? { x: v.x, y: v.y } : null; }
    case 'religion': {
      const r = w.religions[sel.id];
      const s = r && r.holyCityId != null ? w.settlements[r.holyCityId] : null;
      return s ? { x: s.x, y: s.y } : null;
    }
    case 'plague': {
      const p = w.plagues[sel.id];
      const s = p && p.originSid != null ? w.settlements[p.originSid] : null;
      return s ? { x: s.x, y: s.y } : null;
    }
    case 'war': {
      const war = w.wars[sel.id];
      if (!war) return null;
      const a = w.armies.find((q) => q.warId === war.id);
      if (a) return { x: a.x, y: a.y };
      const c = w.civs[war.defenders?.[0]];
      const cap = c && c.capitalId != null ? w.settlements[c.capitalId] : null;
      return cap ? { x: cap.x, y: cap.y } : null;
    }
    default: {
      const v = BUILTIN_KINDS.has(sel.kind) ? null : getView(sel.kind);
      if (v) {
        try {
          const p = typeof v.point === 'function' ? v.point(w, sel.id) : null;
          if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
          const b = typeof v.frame === 'function' ? v.frame(w, sel.id) : null;
          if (b && [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite)) return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
        } catch (e) { app.reportError(`view.${sel.kind}.point`, e); }
      }
      return sel.x != null ? { x: sel.x, y: sel.y } : null;
    }
  }
}

const boxOf = (pts, m) => {
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
};

/**
 * The box (entity coords, inclusive) that frames a selection: a registered view's frame(),
 * a nation's towns, a war's armies and capitals, a plague's sick towns, a faith's towns, a
 * settlement's lands, a storm's reach; else a small box around its point.
 */
export function selectionFrame(app, sel) {
  const w = app.world;
  if (!w || !sel) return null;
  const v = BUILTIN_KINDS.has(sel.kind) ? null : getView(sel.kind);
  if (v && typeof v.frame === 'function') {
    try { const b = v.frame(w, sel.id); if (b && [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite)) return b; } catch (e) { app.reportError(`view.${sel.kind}.frame`, e); }
  }
  if (sel.kind === 'civ') {
    const c = w.civs[sel.id];
    const towns = (c?.settlementIds || []).map((id) => w.settlements[id]).filter((s) => s && s.alive);
    const b = boxOf(towns, 4);
    if (b) return b;
  } else if (sel.kind === 'war') {
    const war = w.wars[sel.id];
    if (war) {
      const ids = new Set([...(war.attackers || []), ...(war.defenders || [])]);
      const pts = w.armies.filter((a) => a.warId === war.id);
      for (const s of w.settlements) if (s && s.alive && s.siege && ids.has(s.civId)) pts.push(s);
      for (const id of ids) { const c = w.civs[id]; const cap = c && c.capitalId != null ? w.settlements[c.capitalId] : null; if (cap) pts.push(cap); }
      const b = boxOf(pts, 4);
      if (b) return b;
    }
  } else if (sel.kind === 'plague') {
    const p = w.plagues[sel.id];
    if (p) {
      const pts = [];
      for (const s of w.settlements) if (s && s.alive && s.disease && s.disease.pid === p.id) pts.push(s);
      const o = p.originSid != null ? w.settlements[p.originSid] : null;
      if (!pts.length && o) pts.push(o);
      const b = boxOf(pts, 4);
      if (b) return b;
    }
  } else if (sel.kind === 'religion') {
    const pts = [];
    for (const s of w.settlements) if (s && s.alive && s.dominantReligion === sel.id) pts.push(s);
    const b = boxOf(pts, 4);
    if (b) return b;
  } else if (sel.kind === 'settlement') {
    const s = w.settlements[sel.id];
    if (s) { const r = Math.max(3, (s.radius || 2) + 2); return { x0: s.x - r, y0: s.y - r, x1: s.x + r, y1: s.y + r }; }
  } else if (sel.kind === 'storm') {
    const s = w.storms.find((q) => q.id === sel.id);
    if (s) { const r = Math.max(6, (s.radius || 4) * 1.6); return { x0: s.x - r, y0: s.y - r, x1: s.x + r, y1: s.y + r }; }
  }
  const p = selectionPoint(app, sel);
  return p ? { x0: p.x - 6, y0: p.y - 6, x1: p.x + 6, y1: p.y + 6 } : null;
}

/** Is the record a selection points at still there (a fallen nation or a razed town still counts: its record stays readable)? */
export function selectionExists(app, sel) {
  const w = app.world;
  if (!w || !sel) return false;
  switch (sel.kind) {
    case 'tile': return Number.isFinite(sel.id) && sel.id >= 0 && sel.id < w.N;
    case 'settlement': return Boolean(w.settlements[sel.id]);
    case 'civ': return Boolean(w.civs[sel.id]);
    case 'war': return Boolean(w.wars[sel.id]);
    case 'religion': return Boolean(w.religions[sel.id]);
    case 'plague': return Boolean(w.plagues[sel.id]);
    case 'army': return w.armies.some((q) => q.id === sel.id);
    // an ended storm lives on in the catalogue, and its record opens there
    case 'storm': return w.storms.some((q) => q.id === sel.id) || (w.history?.events || []).some((e) => e.t === 'storm' && e.sid === sel.id);
    case 'volcano': return w.volcanoes.some((q) => q.id === sel.id);
    default: {
      const v = getView(sel.kind);
      if (!v) return false;
      // world-wide records (the ages of the world) have no place on the map, yet they open
      if (sel.kind === 'event' && /^age:/.test(String(sel.id))) return true;
      return Boolean(selectionPoint(app, sel));
    }
  }
}

const KIND_ICON = { tile: 'pin', settlement: 'town', civ: 'nations', army: 'army', war: 'war', religion: 'faith', plague: 'plague', storm: 'storm', volcano: 'volcano' };
const KIND_LABEL = { tile: 'Ground', settlement: 'Settlement', civ: 'Nation', army: 'Army', war: 'War', religion: 'Faith', plague: 'Plague', storm: 'Storm', volcano: 'Volcano' };
export const kindLabel = (kind) => KIND_LABEL[kind] || getView(kind)?.label || F.humanize(kind);

/**
 * A short description of any selection, for chips, menus and search rows:
 * { name, sub, color, icon, alive } (color null when the thing has no colour of its own).
 */
export function describeSel(app, sel) {
  const w = app.world;
  if (sel && (sel.kind === 'landmark' || sel.kind === 'caravan' || sel.kind === 'swarm')) {
    const c = canonicalSel(app, sel);
    if (c && c.kind !== sel.kind) {
      const d = describeSel(app, c);
      if (sel.kind === 'landmark' && sel.key && c.kind === 'settlement') d.sub = `${String(sel.key).replace(/[_:]/g, ' ')} · ${d.name}`;
      if (sel.kind === 'swarm') { d.name = 'Locust swarm'; d.sub = 'Eating its way across the land'; }
      return d;
    }
  }
  const out = { name: kindLabel(sel?.kind), sub: '', color: null, icon: KIND_ICON[sel?.kind] || sel?.kind || 'pin', alive: true };
  if (!w || !sel) return out;
  try {
    switch (sel.kind) {
      case 'civ': {
        const c = w.civs[sel.id];
        if (!c) break;
        out.name = c.name; out.color = c.colorHex || null; out.alive = c.alive !== false;
        out.sub = c.alive === false ? `Fell ${F.year(c.fallenDay)}` : `${F.titleCase(c.government || 'tribe')} · ${F.eraName(c.tech?.era)}`;
        break;
      }
      case 'settlement': {
        const s = w.settlements[sel.id];
        if (!s) break;
        const c = w.civs[s.civId];
        out.name = s.name; out.color = c?.colorHex || null; out.alive = s.alive !== false;
        out.sub = s.alive === false ? `Ruins · ${s.destroyCause ? F.humanize(s.destroyCause).toLowerCase() + ' ' : ''}${F.year(s.destroyedDay)}` : `${F.tierName(s.tier)} · ${F.people(s.population)}${c ? ' · ' + c.name : ''}`;
        break;
      }
      case 'war': {
        const war = w.wars[sel.id];
        if (!war) break;
        out.name = war.name; out.alive = Boolean(war.active);
        out.sub = war.active ? `Ongoing since ${F.year(war.startDay)}` : F.lifespan(war.startDay, war.endDay);
        out.color = w.civs[war.attackers?.[0]]?.colorHex || null;
        break;
      }
      case 'army': {
        const a = w.armies.find((q) => q.id === sel.id);
        if (!a) { out.alive = false; out.sub = 'Disbanded'; break; }
        const c = w.civs[a.civId];
        out.name = `${c?.adjective || ''} ${a.naval ? 'fleet' : 'army'}`.trim();
        out.name = out.name[0].toUpperCase() + out.name.slice(1);
        out.color = c?.colorHex || null; out.icon = a.naval ? 'ship' : 'army';
        out.sub = `${F.people(Math.round(a.strength || 0))} strong · ${a.state || 'marching'}`;
        break;
      }
      case 'religion': {
        const r = w.religions[sel.id];
        if (!r) break;
        out.name = r.name; out.alive = r.alive !== false; out.color = r.colorHex || null;
        out.sub = r.alive === false ? 'A dead faith' : `Founded ${F.year(r.foundedDay)}`;
        break;
      }
      case 'plague': {
        const p = w.plagues[sel.id];
        if (!p) break;
        out.name = p.name; out.alive = Boolean(p.active);
        out.sub = p.active ? `Spreading since ${F.year(p.startDay)}` : `${F.lifespan(p.startDay, p.endDay)} · ${F.people(p.deaths || 0)} dead`;
        break;
      }
      case 'storm': {
        const s = w.storms.find((q) => q.id === sel.id);
        if (!s) { out.alive = false; out.sub = 'Spent'; break; }
        out.name = s.name || F.humanize(s.kind || 'storm');
        out.icon = s.kind === 'blizzard' ? 'blizzard' : s.kind === 'thunderstorm' ? 'lightning' : 'storm';
        out.sub = `${F.humanize(s.kind || 'storm')} · intensity ${Math.round((s.intensity || 0) * 100)}%`;
        break;
      }
      case 'volcano': {
        const v = w.volcanoes.find((q) => q.id === sel.id);
        if (!v) break;
        out.name = v.name; out.sub = v.erupting > 0 ? 'Erupting' : v.activity > 0.5 ? 'Restless' : 'Volcano';
        break;
      }
      case 'tile': {
        const p = selectionPoint(app, sel);
        if (!p) break;
        const i = Math.round(p.y) * w.W + Math.round(p.x);
        out.name = F.biomeName(w.f.biome[i]);
        const o = w.f.owner[i] >= 0 ? w.civs[w.f.owner[i]] : null;
        out.sub = `${F.latLon(w, p.x, p.y)}${o ? ' · ' + o.name : ''}`;
        out.color = o?.colorHex || null;
        break;
      }
      default: {
        const v = getView(sel.kind);
        if (!v) break;
        out.icon = v.icon || sel.kind;
        out.name = v.label || sel.kind;
        if (typeof v.describe === 'function') {
          const d = v.describe(app, sel) || {};
          if (d.name) out.name = d.name;
          if (d.sub) out.sub = d.sub;
          if (d.color) out.color = d.color;
          if (d.icon) out.icon = d.icon;
          if (d.alive === false) out.alive = false;
        }
      }
    }
  } catch (e) { app.reportError(`describe.${sel.kind}`, e); }
  return out;
}

/** The selection a chronicle reference ({ k, id }) opens, or null when no view knows the kind. */
/** The part of the map not under the top instruments and the tool belt (desktop): { h, bias } in CSS px, or null. */
function clearBand() {
  if (typeof document === 'undefined') return null;
  const map = document.getElementById('map');
  const cr = map?.getBoundingClientRect();
  if (!cr || !(cr.height > 0)) return null;
  const hud = document.querySelector('.hud-top')?.getBoundingClientRect();
  const pal = document.getElementById('palette');
  const pr = pal && !pal.hidden && pal.offsetParent !== null ? pal.getBoundingClientRect() : null;
  const top = hud && hud.height > 0 && hud.bottom > cr.top ? Math.min(cr.height * 0.4, hud.bottom - cr.top + 8) : 0;
  const bottom = pr && pr.height > 0 && pr.top < cr.bottom ? Math.max(cr.height * 0.6, pr.top - cr.top - 8) : cr.height;
  const h = bottom - top;
  if (!(h >= 200) || (top <= 0 && bottom >= cr.height)) return null;
  return { h, bias: (top + bottom) / 2 - cr.height / 2 };
}

/**
 * Map-only hit kinds (render hits with no record of their own) become the record they belong to:
 * a landmark → its town (or the wonder it is), a caravan → its trade route, a locust swarm or an
 * unknown pick with a place → that tile. Everything else passes through unchanged.
 */
export function canonicalSel(app, sel) {
  if (!sel || sel.kind == null) return sel;
  const w = app.world;
  if (!w) return sel;
  switch (sel.kind) {
    case 'landmark': {
      const m = /^(\d+):wonder:(\d+)$/.exec(String(sel.id));
      if (m && getView('wonder') && w.wonders?.[+m[2]]) return { kind: 'wonder', id: +m[2] };
      const sid = Number.isFinite(sel.sid) ? sel.sid : parseInt(String(sel.id), 10);
      return Number.isFinite(sid) && w.settlements[sid] ? { kind: 'settlement', id: sid } : null;
    }
    case 'caravan': {
      const c = (w.caravans || []).find((q) => q.id === sel.id);
      if (c && c.routeId != null && getView('route') && w.tradeRoutes?.[c.routeId]) return { kind: 'route', id: c.routeId };
      return c ? tileSel(w, c.x, c.y) : null;
    }
    case 'swarm': {
      const sw = (w.sys?.disasters?.swarms || []).find((q) => q.id === sel.id);
      const x = sw ? sw.x : sel.x, y = sw ? sw.y : sel.y;
      return Number.isFinite(x) && Number.isFinite(y) ? tileSel(w, x, y) : null;
    }
    default: return sel;
  }
}
const tileSel = (w, x, y) => {
  const tx = Math.max(0, Math.min(w.W - 1, Math.round(x))), ty = Math.max(0, Math.min(w.H - 1, Math.round(y)));
  return { kind: 'tile', id: ty * w.W + tx, x: tx, y: ty };
};

export function refToSel(ref) {
  if (!ref || ref.k == null || ref.id == null) return null;
  if (BUILTIN_KINDS.has(ref.k) && ref.k !== 'tile') return { kind: ref.k, id: ref.id };
  return getView(ref.k) ? { kind: ref.k, id: ref.id } : null;
}

/** What a chronicle entry is about, as a selection: its ref, else its settlement, nation or place. */
export function entrySel(app, e) {
  const w = app.world;
  if (!w || !e) return null;
  const r = refToSel(e.ref);
  if (r && selectionExists(app, r)) return r;
  if (e.sid != null && w.settlements[e.sid]) return { kind: 'settlement', id: e.sid };
  if (e.x != null && e.y != null) {
    const x = Math.round(e.x), y = Math.round(e.y);
    if (x >= 0 && y >= 0 && x < w.W && y < w.H) return { kind: 'tile', id: y * w.W + x, x, y };
  }
  if (e.civId != null && w.civs[e.civId]) return { kind: 'civ', id: e.civId };
  return null;
}

/** Where a chronicle entry happened (tile coords), or null. */
export function entryPoint(app, e) {
  const w = app.world;
  if (!w || !e) return null;
  if (e.x != null && e.y != null && Number.isFinite(e.x) && Number.isFinite(e.y)) return { x: e.x, y: e.y };
  if (e.sid != null && w.settlements[e.sid]) { const s = w.settlements[e.sid]; return { x: s.x, y: s.y }; }
  const r = refToSel(e.ref);
  if (r) { const p = selectionPoint(app, r); if (p) return p; }
  if (e.civId != null && w.civs[e.civId]) return selectionPoint(app, { kind: 'civ', id: e.civId });
  return null;
}

/** A chronicle entry's category label and colour. */
export const categoryOf = (cat) => CATEGORIES[cat] || { label: F.humanize(cat || 'event'), color: 'var(--brass)' };

/** "Spring of Year 312" style date for a day, from the kernel's calendar. */
export const dayText = (w, day) => (w ? dateString(w, day) : '');

/**
 * The renderer understands tile / settlement / civ / army; a registered kind passes its
 * view's rendererSel (for example { kind: 'civs', ids } or { kind: 'box', … }); other kinds
 * highlight their place.
 */
function rendererSelection(app, sel) {
  if (!sel) return null;
  if (sel.kind === 'tile' || sel.kind === 'settlement' || sel.kind === 'civ' || sel.kind === 'army') {
    const p = selectionPoint(app, sel) || {};
    return { kind: sel.kind, id: sel.id, x: p.x ?? sel.x ?? null, y: p.y ?? sel.y ?? null };
  }
  const v = BUILTIN_KINDS.has(sel.kind) ? null : getView(sel.kind);
  if (v && typeof v.rendererSel === 'function' && app.world) {
    try { const r = v.rendererSel(app.world, sel.id); if (r && r.kind) return r; } catch (e) { app.reportError(`view.${sel.kind}.rendererSel`, e); }
  }
  const p = selectionPoint(app, sel);
  if (!p || !app.world) return null;
  const x = Math.round(p.x), y = Math.round(p.y);
  return { kind: 'tile', id: y * app.world.W + x, x, y };
}
