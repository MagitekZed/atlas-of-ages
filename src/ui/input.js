// Map input: mouse, keyboard and touch.
//   Inspect: click selects, drag pans, double-click zooms in (and opens the nation that holds
//   the ground; on a town it dives in); dragging a selected storm or army sends it there when
//   the world has the steering tools (steer_storm, command_army).  God tool: press applies; continuous tools re-apply
//   every ~80 ms while held and finish once on release.  Pair tools pick a source, draw a
//   rubber band to the cursor, then pick the target (Esc lets go of the source).  Right/middle
//   drag or Space+drag always pans.  Wheel and pinch zoom at the pointer; with a brush tool
//   Shift+wheel sizes the brush and Alt+wheel sets its strength.  Tab walks the largest towns
//   in view (a dozen at most, then the armies there), then lets focus leave the map.
//   Keys: see hud.showHelp().
// While a tool is in hand its preview (previewTool, at most every 120 ms) is drawn by the
// renderer (setToolPreview) and read out in the hover card; a refusal turns the cursor
// into a "no" sign. A tool whose danger(opts) holds asks for a second click unless the
// Chronoscope can undo it. Every stroke is bracketed as one act for undo (app.chrono).
// App events for the expansion (contracts §15): userCamera whenever the viewer moves the
// map; mapContext on a right-click without a drag, or a 550 ms touch long-press in Inspect
// (only while someone listens, so the tap still selects otherwise); mapDblClick after a
// double-click. Keys other packages register (src/ui/registry.js) and registered tabs'
// keys are consulted after the built-ins.

import { getTool, applyTool, finishTool } from '../core/tools.js';
import * as kernelTools from '../core/tools.js';
import { matchKey, getTabs, registerKey } from './registry.js';
import { settlementAt } from '../core/entities.js';
import { isTyping } from './dom.js';
import { modalOpen } from './widgets.js';
import { statusToast } from './toasts.js';
import { showHelp, openLeap } from './hud.js';
import { quickSave } from './saves.js';
import { tierName, people, int } from './format.js';
import { describeSel, followMode, selectionFrame, tabOpen } from './app.js';
import { peoplesOn, townMix, realmMix, hoverPeoples } from './peoples.js';
import { strongestBands } from './temper.js';

const APPLY_MS = 80;
const DRAG_PX = 5;
const TOUCH_TOOL_DELAY = 90;  // ms a touch waits to see whether it becomes a pinch
const KEY_PAN = 620;          // screen px per second
const TAB_KEYS = { i: 'inspector', c: 'chronicle', n: 'nations', t: 'statistics', p: 'world', l: 'atlas' };
const LONG_PRESS_MS = 550;    // a still touch this long in Inspect opens the map context menu
const PREVIEW_MS = 120;       // tool hover previews (previewTool) at most this often
const DANGER_MS = 5000;       // a dangerous act's second click must come within this
const FOLLOW_POINT_MS = 200;  // a followed mover is re-centred this often
const FOLLOW_FRAME_MS = 2000; // a followed region is re-framed this often (when it changed)
const DIVE_ZOOM = 28;         // a double-click on a town dives at least this close
const TAB_TOWNS = 12, TAB_ARMIES = 4;   // Tab walks this many of the largest towns and armies in view, then leaves the map
const BUSY_MS = 250;          // the pointer moving over the map, a key or a click keeps it busy() this long after (main.js draws every frame then)

const TONE = { boon: 'peace', bane: 'hate', neutral: 'trade' };
const PICK_WORD = { civ: 'a nation’s lands', settlement: 'a settlement', tile: 'a spot on the map' };

export function mountInput(app, canvas) {
  const pointers = new Map();
  let mode = null;            // null | 'pending' | 'pan' | 'tool-wait' | 'tool' | 'pinch' | 'context'
  let start = null, last = null;
  let pinch = null;
  let spaceDown = false, spaceUsed = false;
  let stroke = null;          // { tool, pos, lastApply, applied }
  let toolWait = 0;           // timer while a touch with a tool might still become a pinch
  let hoverPos = null, hoverDirty = false, hoverAt = 0;
  let touchedAt = -1e9;       // the last pointer move, press or wheel over the map (busy())
  const held = new Set();
  const msgAt = new Map();
  const hoverCard = document.getElementById('hover-card');
  let followAt = 0, followBox = null;
  let lastClick = null;
  let ctxPress = null;        // { id, x, y, moved } while a right button is down
  let longPress = 0;          // timer while a touch in Inspect might become a long-press
  let previewAt = 0, previewOn = false, lastPreview = null;
  let pair = null;            // { tool, a: { kind, id?, x, y, label } } once a pair tool's source is chosen
  let armed = null;           // { toolId, x, y, t } a dangerous act waiting for its second click
  let wheelNote = null;       // { text, until } brush readout after a modified wheel
  let tabIndex = -1, tabKeys = '';
  const camMoved = (how) => app.emit('userCamera', { how });

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function setCursor() {
    canvas.classList.toggle('is-panning', mode === 'pan' || mode === 'pinch' || mode === 'grab');
    canvas.classList.toggle('is-grab', mode !== 'pan' && (spaceDown || app.tool === 'inspect'));
    canvas.classList.toggle('is-invalid', !mode && app.tool !== 'inspect' && Boolean(lastPreview && lastPreview.ok === false));
  }

  // --- pointers ---------------------------------------------------------------------------
  canvas.addEventListener('pointerdown', (e) => {
    if (!app.world) return;
    canvas.focus({ preventScroll: true });
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    touchedAt = performance.now();
    const p = local(e);
    pointers.set(e.pointerId, p);
    hideHoverCard();
    if (pointers.size === 2) {
      cancelToolWait();
      cancelLongPress();
      endStroke();
      if (grab) { grab = null; clearPreview(); }
      mode = 'pinch';
      pinch = pinchState();
      setCursor();
      return;
    }
    if (pointers.size > 2) return;
    if (e.button === 1 || e.button === 2 || spaceDown) {
      e.preventDefault();
      mode = 'pan'; last = p; spaceUsed = spaceDown;
      ctxPress = e.button === 2 && !spaceDown ? { id: e.pointerId, x: p.x, y: p.y, moved: false } : null;
      setCursor();
      return;
    }
    if (e.button !== 0) return;
    if (app.tool === 'inspect') {
      mode = 'pending'; start = p; last = p;
      grab = e.altKey ? null : grabbable(p);
      if ((e.pointerType === 'touch' || e.pointerType === 'pen') && app.hasListeners('mapContext')) {
        cancelLongPress();
        longPress = setTimeout(() => {
          longPress = 0;
          if (mode !== 'pending' || pointers.size !== 1) return;
          mode = 'context';          // the release must not also select
          // (browsers refuse haptics before the first completed tap and log it: ask only once allowed)
          try { if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8); } catch (err) { /* no haptics */ }
          emitContext(start);
        }, LONG_PRESS_MS);
      }
    } else if (e.pointerType === 'touch') {
      // a second finger may be on its way (pinch): hold the tool back for a moment
      mode = 'tool-wait'; start = p; last = p;
      toolWait = setTimeout(() => {
        toolWait = 0;
        if (mode === 'tool-wait') { mode = 'tool'; beginStroke(start); if (stroke) stroke.pos = last; }
      }, TOUCH_TOOL_DELAY);
    } else {
      mode = 'tool';
      beginStroke(p);
    }
    setCursor();
  });
  function cancelToolWait() { if (toolWait) { clearTimeout(toolWait); toolWait = 0; } }
  function cancelLongPress() { if (longPress) { clearTimeout(longPress); longPress = 0; } }

  /** Tell the context menu what lies at a canvas point. */
  function emitContext(p) {
    const tile = app.r('screenToTile', p.x, p.y) || null;
    let picks = app.r('pickAll', p.x, p.y);
    if (!Array.isArray(picks)) { const one = app.r('pickEntity', p.x, p.y); picks = one ? [one] : []; }
    app.emit('mapContext', { sx: p.x, sy: p.y, tile, picks });
  }

  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    hoverPos = p; hoverDirty = true; touchedAt = performance.now();
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, p);
    if (mode === 'pinch') { movePinch(); return; }
    if (mode === 'tool-wait') { last = p; return; }
    if (mode === 'context') return;
    if (mode === 'pending') {
      if (Math.hypot(p.x - start.x, p.y - start.y) > DRAG_PX) { mode = grab ? 'grab' : 'pan'; cancelLongPress(); setCursor(); }
      else return;
    }
    if (mode === 'grab') { grabMove(p); return; }
    if (mode === 'pan') {
      if (ctxPress && !ctxPress.moved && Math.hypot(p.x - ctxPress.x, p.y - ctxPress.y) > DRAG_PX) ctxPress.moved = true;
      const dx = p.x - last.x, dy = p.y - last.y;
      app.r('pan', dx, dy);
      last = p;
      if (dx || dy) camMoved('pan');
    } else if (mode === 'tool' && stroke) {
      stroke.pos = p;
    }
  });

  const release = (e) => {
    const p = pointers.get(e.pointerId) || local(e);
    pointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    cancelLongPress();
    // a right-click that never became a drag asks for the context menu
    if (ctxPress && ctxPress.id === e.pointerId) {
      const c = ctxPress; ctxPress = null;
      if (!c.moved && e.type === 'pointerup') emitContext({ x: c.x, y: c.y });
    }
    if (mode === 'pinch') {
      if (pointers.size === 1) { mode = 'pan'; last = [...pointers.values()][0]; }
      else if (pointers.size === 0) mode = null;
      pinch = null;
      setCursor();
      return;
    }
    if (mode === 'pending' && e.type === 'pointerup') {
      const t = performance.now();
      const dbl = lastClick && t - lastClick.t < 380 && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < 8;
      lastClick = dbl ? null : { t, x: p.x, y: p.y };
      if (dbl) doubleClick(p);
      else selectAt(p, false);
      if (dbl) app.emit('mapDblClick', { sx: p.x, sy: p.y, tile: app.r('screenToTile', p.x, p.y) || null, pick: app.r('pickEntity', p.x, p.y) || null });
    }
    if (mode === 'tool-wait') {        // a quick tap with a tool: apply it once
      cancelToolWait();
      if (e.type === 'pointerup') { mode = 'tool'; beginStroke(start); }
    }
    if (mode === 'tool') endStroke();
    if (mode === 'grab') grabRelease(p, e.type === 'pointerup');
    if (pointers.size === 0) mode = null;
    setCursor();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('lostpointercapture', (e) => { if (pointers.has(e.pointerId)) release(e); });
  canvas.addEventListener('pointerleave', () => {
    hoverPos = null; hoverDirty = true;
    if (mode === null) app.r('setBrush', null);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('dblclick', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    if (!app.world) return;
    e.preventDefault();
    touchedAt = performance.now();
    const p = local(e);
    // with a brush in hand, Shift+wheel sizes it and Alt+wheel sets its strength
    if ((e.shiftKey || e.altKey) && !e.ctrlKey && app.tool !== 'inspect' && wheelAdjust(e, p)) return;
    const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : (e.ctrlKey ? 0.01 : 0.0016);
    const factor = Math.exp(-Math.max(-600, Math.min(600, e.deltaY)) * unit);
    // following a mover, the zoom closes in on it rather than on the cursor
    const around = app.follow && followMode(app.follow) === 'point' ? centre() : p;
    app.r('zoomAt', around.x, around.y, factor);
    camMoved('zoom');
  }, { passive: false });

  let wheelAcc = 0;
  /** Shift+wheel: brush radius; Alt+wheel: strength. Returns true when it changed something. */
  function wheelAdjust(e, p) {
    const t = getTool(app.tool);
    if (!t) return false;
    const d = e.deltaY || e.deltaX || 0;
    wheelAcc += d;
    const step = e.deltaMode === 0 ? 60 : 1;
    if (Math.abs(wheelAcc) < step) return true;
    const dir = wheelAcc > 0 ? -1 : 1;
    wheelAcc = 0;
    if (e.shiftKey) {
      if (!((t.radius ?? 0) > 0 || t.target === 'area' || t.maxRadius != null)) return false;
      app.adjustBrush?.(dir);
      wheelNote = { text: `Radius ${app.toolOptions(t.id).radius}`, until: performance.now() + 900 };
    } else if (e.altKey) {
      const s = t.strength;
      if (!s || !Number.isFinite(s.min) || !Number.isFinite(s.max)) return false;
      const stepV = s.step ?? (s.max - s.min) / 20;
      const cur = app.toolOptions(t.id).strength;
      const next = Math.max(s.min, Math.min(s.max, Math.round((cur + dir * stepV) / stepV) * stepV));
      app.setToolOption(t.id, 'strength', Number(next.toFixed(4)));
      app.emit('toolOptions', t.id);
      wheelNote = { text: `${s.label || 'Strength'} ${s.max <= 1.0001 && s.min >= 0 ? Math.round(next * 100) + '%' : Math.abs(next) >= 10 ? Math.round(next) : next.toFixed(1)}`, until: performance.now() + 900 };
    }
    hoverPos = p; hoverDirty = true; hoverAt = 0; previewAt = 0;
    return true;
  }

  function centre() {
    const r = canvas.getBoundingClientRect();
    return { x: r.width / 2, y: r.height / 2 };
  }

  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }
  function movePinch() {
    if (pointers.size < 2 || !pinch) return;
    const now = pinchState();
    const keep = app.follow && followMode(app.follow) === 'point';
    if (!keep) app.r('pan', now.mx - pinch.mx, now.my - pinch.my);
    const f = now.d / pinch.d;
    const at = keep ? centre() : { x: now.mx, y: now.my };
    if (Number.isFinite(f) && f > 0) app.r('zoomAt', at.x, at.y, f);
    pinch = now;
    camMoved('pinch');
  }

  // --- selection --------------------------------------------------------------------------
  function selectAt(p, dbl) {
    const w = app.world;
    if (!w) return;
    const pick = app.r('pickEntity', p.x, p.y);
    if (pick && pick.kind === 'pin') { app.emit('pinPicked', pick.id); return; }
    if (pick && pick.kind === 'fxPointer') { app.emit('fxPointerPicked', pick.id); return; }
    if (pick && pick.kind != null && pick.id != null) { app.select({ kind: pick.kind, id: pick.id }); return; }
    const t = app.r('screenToTile', p.x, p.y);
    if (!t) { app.select(null); return; }
    const s = settlementAt(w, t.i);
    if (s && s.alive) { app.select({ kind: 'settlement', id: s.id }); return; }
    if (dbl && w.f.owner[t.i] >= 0) { app.select({ kind: 'civ', id: w.f.owner[t.i] }); return; }
    app.select({ kind: 'tile', id: t.i, x: t.x, y: t.y });
  }

  /** Double-click: dive into a town, else zoom ×2 at the cursor and open the nation that holds the ground. */
  function doubleClick(p) {
    const w = app.world;
    const pick = app.r('pickEntity', p.x, p.y);
    const t = app.r('screenToTile', p.x, p.y);
    const s = pick?.kind === 'settlement' ? w.settlements[pick.id] : t ? settlementAt(w, t.i) : null;
    const z = app.renderer?.camera?.zoom || 6;
    if (s && s.alive) {
      app.select({ kind: 'settlement', id: s.id });
      app.focus(s.x, s.y, Math.max(z * 2, DIVE_ZOOM));
    } else {
      app.r('zoomAt', p.x, p.y, 2);
      selectAt(p, true);
    }
    camMoved('dblclick');
  }

  // --- tool strokes -------------------------------------------------------------------------
  function beginStroke(p) {
    const tool = getTool(app.tool);
    if (!tool) { app.setTool('inspect'); return; }
    if (app.chrono?.busy) return;    // history is being re-written: the hand waits
    if (tool.target === 'pair') { pairClick(tool, p); return; }
    if (tool.target === 'entity') { app.setTool('inspect'); return; }
    if (!confirmDanger(tool, p)) return;
    stroke = { tool, pos: p, lastApply: performance.now(), applied: 0, act: false, world: app.world };
    applyAt(p, true);
  }
  function endStroke() {
    if (!stroke) return;
    const t = stroke.tool;
    const applied = stroke.applied;
    const act = stroke.act;
    const same = stroke.world === app.world;   // a stroke whose world was replaced (undo, rewind, load) just ends
    stroke = null;
    if (!same) return;
    if (applied > 0 && app.world) finishTool(app.world, t.id);
    if (act) app.chrono?.endAct?.();
    app.emit('worldEdited');
  }
  function applyAt(p, first) {
    const w = app.world;
    if (!w || !stroke) return;
    // the world was replaced, or is being (undo, rewind): the hand lets go without touching it again
    if (stroke.world !== w || app.chrono?.busy) { stroke = null; mode = null; setCursor(); return; }
    const t = stroke.tool;
    let tile = app.r('screenToTile', p.x, p.y);
    if (!tile) return;
    if (t.target === 'settlement') {
      const pick = app.r('pickEntity', p.x, p.y);
      if (pick?.kind === 'settlement') {
        const s = w.settlements[pick.id];
        if (s) tile = { x: s.x, y: s.y, i: s.i };
      }
    }
    const o = app.toolOptions(t.id);
    // the act begins (and the Chronoscope snaps the world) just before its first touch
    if (!stroke.act && app.chrono?.beginAct) { stroke.act = true; app.chrono.beginAct({ kind: 'tool', id: t.id, label: t.label, icon: t.icon || t.id, x: tile.x, y: tile.y }); }
    const res = applyTool(w, t.id, tile.x, tile.y, { radius: o.radius, strength: o.strength });
    stroke.applied++;
    report(t, res, first);
    if (first) app.emit('worldEdited');
  }

  /** Tell the viewer how an act went (the deed card takes the successes when it is there). */
  function report(t, res, first) {
    if (!res || !res.message || !(first || !res.ok)) return;
    if (res.ok && app.deedCards) return;
    const key = (res.ok ? 'ok:' : 'no:') + res.message;
    const nowT = performance.now();
    if (!msgAt.has(key) || nowT - msgAt.get(key) > 1600) {
      msgAt.set(key, nowT);
      statusToast(app, res.message, res.ok ? 'ok' : 'warn', { icon: t.icon || t.id });
    }
  }

  /** A dangerous act asks for a second click, unless it can be undone. Returns true to go ahead. */
  function confirmDanger(tool, p) {
    if (typeof tool.danger !== 'function') return true;
    let risky = false;
    try { risky = Boolean(tool.danger(app.toolOptions(tool.id))); } catch (e) { risky = false; }
    if (!risky || app.chrono?.canProtect?.()) { armed = null; return true; }
    const nowT = performance.now();
    if (armed && armed.toolId === tool.id && nowT - armed.t < DANGER_MS && Math.hypot(p.x - armed.x, p.y - armed.y) < 24) { armed = null; return true; }
    armed = { toolId: tool.id, x: p.x, y: p.y, t: nowT };
    statusToast(app, `${tool.label} at this strength cannot be undone here. Click the same spot again to unleash it.`, 'warn', { icon: tool.icon || tool.id, ms: DANGER_MS });
    return false;
  }

  // --- pair tools: source, rubber band, target ------------------------------------------------
  /** What a click picks for one side of a pair tool: { kind, id?, x, y, label } or null. */
  function pickFor(kind, p) {
    const w = app.world;
    const t = app.r('screenToTile', p.x, p.y);
    if (!t) return null;
    const hit = app.r('pickEntity', p.x, p.y);
    const town = hit?.kind === 'settlement' ? w.settlements[hit.id] : settlementAt(w, t.i);
    if (kind === 'settlement') return town && town.alive ? { kind: 'settlement', id: town.id, x: town.x, y: town.y, label: town.name } : null;
    if (kind === 'civ') {
      const cid = town && town.alive ? town.civId : w.f.owner[t.i];
      const c = cid >= 0 ? w.civs[cid] : null;
      if (!c || c.alive === false) return null;
      const cap = c.capitalId != null ? w.settlements[c.capitalId] : null;
      return { kind: 'civ', id: c.id, x: cap ? cap.x : t.x, y: cap ? cap.y : t.y, label: c.name };
    }
    return { kind: 'tile', x: t.x, y: t.y, label: `the ground at ${t.x}, ${t.y}` };
  }
  function pairKinds(tool) {
    const pk = Array.isArray(tool.pick) && tool.pick.length ? tool.pick : ['civ', 'civ'];
    return [pk[0] || 'civ', pk[1] || pk[0] || 'civ'];
  }
  function pairClick(tool, p) {
    const [ka, kb] = pairKinds(tool);
    if (!pair || pair.tool.id !== tool.id) {
      const a = pickFor(ka, p);
      if (!a) { statusToast(app, `${tool.label}: first choose ${PICK_WORD[ka] || ka}.`, 'warn', { icon: tool.icon || tool.id }); return; }
      pair = { tool, a };
      hoverDirty = true; previewAt = 0;
      app.emit('pairSource', pair);
      return;
    }
    const b = pickFor(kb, p);
    if (!b) { statusToast(app, `${tool.label}: now choose ${PICK_WORD[kb] || kb}. Esc lets go of ${pair.a.label}.`, 'warn', { icon: tool.icon || tool.id }); return; }
    if (b.kind === pair.a.kind && b.id != null && b.id === pair.a.id) { statusToast(app, `${pair.a.label} cannot be joined to itself. Choose another.`, 'warn', { icon: tool.icon || tool.id }); return; }
    if (!confirmDanger(tool, p)) return;
    const a = pair.a;
    pair = null;
    app.emit('pairSource', null);
    applyPair(tool, a, b);
  }
  function applyPair(tool, a, b) {
    const w = app.world;
    if (!w || typeof kernelTools.applyPairTool !== 'function' || app.chrono?.busy) return;
    const strip = (q) => (q.kind === 'tile' ? { kind: 'tile', x: q.x, y: q.y } : { kind: q.kind, id: q.id, x: q.x, y: q.y });
    app.chrono?.beginAct?.({ kind: 'pair', id: tool.id, label: tool.label, icon: tool.icon || tool.id, x: b.x, y: b.y });
    let res = null;
    try { res = kernelTools.applyPairTool(w, tool.id, strip(a), strip(b), { ...app.toolOptions(tool.id) }); }
    finally { app.chrono?.endAct?.(); }
    report(tool, res, true);
    clearPreview();
    app.emit('worldEdited');
  }
  function cancelPair() {
    if (!pair) return false;
    pair = null;
    app.emit('pairSource', null);
    hoverDirty = true; previewAt = 0;
    return true;
  }

  // --- hover: readout, brush, previews, cards ---------------------------------------------------
  function processHover() {
    if (!hoverDirty) return;
    const nowT = performance.now();
    if (nowT - hoverAt < 40) return;
    hoverAt = nowT; hoverDirty = false;
    const w = app.world;
    if (!w || !hoverPos) { app.emit('hover', null); hideHoverCard(); clearPreview(); return; }
    const t = app.r('screenToTile', hoverPos.x, hoverPos.y);
    app.emit('hover', t || null);
    const tool = app.tool !== 'inspect' ? getTool(app.tool) : null;
    if (tool && t && tool.target !== 'pair') {
      const o = app.toolOptions(tool.id);
      const rad = (tool.radius ?? 0) > 0 || tool.target === 'area' ? (o.radius || tool.radius || 1) : 0;
      app.r('setBrush', { x: t.x, y: t.y, radius: rad });
    } else app.r('setBrush', null);
    const pv = hoverPreview(tool, t);
    if (mode && mode !== 'tool') { hideHoverCard(); return; }
    if (wheelNote && nowT < wheelNote.until) { showHoverText(tool?.label || 'Brush', wheelNote.text); hoverDirty = true; return; }
    if (tool) { toolCard(tool, t, pv); return; }
    if (mode) { hideHoverCard(); return; }
    const pick = t ? app.r('pickEntity', hoverPos.x, hoverPos.y) : null;
    if (pick && pick.kind === 'settlement' && w.settlements[pick.id]) showHoverCard(w.settlements[pick.id]);
    else if (pick && pick.kind === 'army') {
      const a = w.armies.find((q) => q.id === pick.id);
      if (a) showHoverText(`${w.civs[a.civId]?.adjective || ''} ${a.naval ? 'fleet' : 'army'}`.trim(), `${people(Math.round(a.strength))} strong · ${a.state || 'marching'}`);
      else hideHoverCard();
    } else if (pick && pick.kind === 'storm') {
      const s = w.storms.find((q) => q.id === pick.id);
      // an unnamed storm is titled by its kind; do not repeat the kind beneath it
      const kind = String(s?.kind || 'storm');
      if (s) showHoverText(s.name || kind[0].toUpperCase() + kind.slice(1), `${s.name && s.name.toLowerCase() !== kind.toLowerCase() ? kind + ' · ' : ''}intensity ${Math.round((s.intensity || 0) * 100)}%`);
      else hideHoverCard();
    } else if (pick && pick.kind != null && pick.kind !== 'pin' && pick.kind !== 'fxPointer') {
      const d = describeSel(app, pick);
      if (d && d.name) showHoverText(d.name, d.sub || ''); else hideHoverCard();
    } else if (pick && pick.kind === 'pin') {
      const e = app.pinInfo?.(pick.id);
      if (e) showHoverText(e.title, e.text); else hideHoverCard();
    } else if (t && (app.renderer?.camera?.zoom || 99) <= 6 && w.f.owner[t.i] >= 0) {
      // over a nation's lands at low zoom: who rules here
      const c = w.civs[w.f.owner[t.i]];
      if (c) {
        const wars = w.wars.filter((q) => q.active && (q.attackers.includes(c.id) || q.defenders.includes(c.id))).length;
        const ruler = c.ruler ? `${c.ruler.title ? c.ruler.title + ' ' : ''}${c.ruler.name}` : '';
        // its two strongest temperament bands ("warlike · devout"), then its peoples (Mythic)
        const extra = document.createDocumentFragment();
        const bands = strongestBands(c, 2);
        if (bands.length) { const tb = document.createElement('div'); tb.className = 'hc-temper'; tb.textContent = bands.join(' · '); extra.append(tb); }
        if (peoplesOn(w)) { const pp = hoverPeoples(realmMix(w, c)); if (pp) extra.append(pp); }
        showHoverText(c.name, [ruler, `${people(c.population)} people`, wars ? `${wars} war${wars === 1 ? '' : 's'}` : 'at peace'].filter(Boolean).join(' · '), '', extra.childNodes.length ? extra : null);
      } else hideHoverCard();
    } else hideHoverCard();
  }
  function showHoverCard(s) {
    const w = app.world;
    const civ = w.civs[s.civId];
    // in a Mythic world, the town's first peoples with their shares
    showHoverText(s.name, `${tierName(s.tier)} · ${people(s.population)} people${civ ? ' · ' + civ.name : ''}`, '', peoplesOn(w) ? hoverPeoples(townMix(w, s)) : null);
  }
  function showHoverText(title, sub, cls = '', extra = null) {
    if (!hoverPos || !hoverCard) return;
    hoverCard.textContent = '';
    hoverCard.className = 'hover-card' + (cls ? ' ' + cls : '');
    const t = document.createElement('div'); t.className = 't'; t.textContent = title;
    hoverCard.append(t);
    if (sub) { const s = document.createElement('div'); s.className = 's'; s.textContent = sub; hoverCard.append(s); }
    if (extra) hoverCard.append(extra);
    hoverCard.hidden = false;
    const stage = canvas.getBoundingClientRect();
    const x = Math.min(stage.width - hoverCard.offsetWidth - 8, hoverPos.x + 16);
    const y = Math.max(8, hoverPos.y - hoverCard.offsetHeight - 10);
    hoverCard.style.left = Math.max(8, x) + 'px';
    hoverCard.style.top = y + 'px';
  }
  function hideHoverCard() { if (hoverCard && !hoverCard.hidden) hoverCard.hidden = true; }

  /** The hover card while a tool is in hand: its forecast, or why it cannot be used here. */
  function toolCard(tool, t, pv) {
    if (!t) { hideHoverCard(); return; }
    if (tool.target === 'pair') {
      const [ka, kb] = pairKinds(tool);
      if (!pair) { showHoverText(tool.label, `Choose ${PICK_WORD[ka] || ka} first`); return; }
      const b = pickFor(kb, hoverPos);
      const head = `${pair.a.label} → ${b ? b.label : '…'}`;
      showHoverText(head, pv && pv.ok === false && pv.reason ? pv.reason : pv?.text || (b ? `Click to ${tool.label.toLowerCase()}` : `Now choose ${PICK_WORD[kb] || kb} · Esc lets go`), pv && pv.ok === false ? 'is-refused' : '');
      return;
    }
    if (!pv) { hideHoverCard(); return; }
    if (pv.ok === false) { showHoverText(tool.label, pv.reason || 'Cannot be used here', 'is-refused'); return; }
    const bits = [];
    if (pv.text) bits.push(pv.text);
    const est = pv.estimate;
    if (est && Array.isArray(est.deaths) && est.deaths.length === 2 && est.deaths[1] > 0) bits.push(`${est.deaths[0] === est.deaths[1] ? 'about ' + people(est.deaths[1]) : people(est.deaths[0]) + '–' + people(est.deaths[1])} at risk`);
    if (est && Number.isFinite(est.towns) && est.towns > 0 && !(pv.text || '').includes('town')) bits.push(`${int(est.towns)} town${est.towns === 1 ? '' : 's'} in reach`);
    if (!bits.length) { hideHoverCard(); return; }
    showHoverText(tool.label, bits.join(' · '), pv.severity >= 3 ? 'is-grave' : '');
  }

  function clearPreview() {
    if (previewOn) { previewOn = false; app.r('setToolPreview', null); }
    if (lastPreview) { lastPreview = null; app.emit('toolPreview', null); setCursor(); }
  }

  /** A tool with a preview (contracts §11) shows what it would do under the cursor (renderer.setToolPreview). Returns the last result. */
  function hoverPreview(tool, t) {
    if (!tool || !t || !app.world) { clearPreview(); return null; }
    const hasPreview = typeof tool.preview === 'function' && typeof kernelTools.previewTool === 'function';
    const band = tool.target === 'pair' && pair ? pair.a : null;
    if (!hasPreview && !band) { clearPreview(); return null; }
    const nowT = performance.now();
    if (nowT - previewAt < PREVIEW_MS) { hoverDirty = true; return lastPreview; }
    previewAt = nowT;
    const o = app.toolOptions(tool.id);
    let res = null;
    if (hasPreview) {
      const opts = { radius: o.radius, strength: o.strength };
      if (band) { opts.a = { kind: band.kind, id: band.id, x: band.x, y: band.y }; const b = pickFor(pairKinds(tool)[1], hoverPos); if (b) opts.b = { kind: b.kind, id: b.id, x: b.x, y: b.y }; }
      try { res = kernelTools.previewTool(app.world, tool.id, t.x, t.y, opts); } catch (e) { res = null; }
    }
    if (band) {
      // the rubber band from the chosen source to the cursor
      const thread = { x0: band.x, y0: band.y, x1: t.x, y1: t.y, tone: TONE[tool.polarity] || 'trade' };
      res = { ok: res ? res.ok !== false : true, ...(res || {}), threads: [thread, ...((res && res.threads) || [])] };
    }
    previewOn = true;
    // the renderer tints reticles and realm outlines by the act's polarity (or the preview's own tone)
    if (res && res.polarity == null) res = { ...res, polarity: tool.polarity || 'neutral' };
    app.r('setToolPreview', res || null);
    const changed = (lastPreview?.ok === false) !== (res?.ok === false) || (lastPreview?.text || lastPreview?.reason) !== (res?.text || res?.reason);
    lastPreview = res;
    if (changed) app.emit('toolPreview', res);
    setCursor();
    return res;
  }

  // --- grab: drag a selected storm or army where the hand would send it ------------------------
  // Uses the steer_storm / command_army tools when this world has them (entity tools take
  // { x, y } as args; pair tools take the destination as a tile). Alt+drag always pans.
  const GRAB_TOOL = { storm: 'steer_storm', army: 'command_army' };
  let grab = null;   // { kind, id, tool, x, y, to }
  function grabbable(p) {
    const sel = app.selection;
    const id = sel ? GRAB_TOOL[sel.kind] : null;
    const t = id ? getTool(id) : null;
    if (!t || !app.world || app.chrono?.busy) return null;
    if (typeof t.available === 'function') { try { if (!t.available(app.world)) return null; } catch (e) { return null; } }
    const pick = app.r('pickEntity', p.x, p.y);
    if (!pick || pick.kind !== sel.kind || pick.id !== sel.id) return null;
    const from = describeSel(app, sel).name;
    const pt = selectionPointOf(sel);
    return pt ? { kind: sel.kind, id: sel.id, tool: t, x: pt.x, y: pt.y, from, to: null } : null;
  }
  function selectionPointOf(sel) {
    const w = app.world;
    const q = sel.kind === 'storm' ? w.storms.find((o) => o.id === sel.id) : w.armies.find((o) => o.id === sel.id);
    return q ? { x: q.x, y: q.y } : null;
  }
  function grabMove(p) {
    const t = app.r('screenToTile', p.x, p.y);
    if (!grab || !t) return;
    grab.to = { x: t.x, y: t.y };
    let res = null;
    if (typeof grab.tool.preview === 'function') {
      try { res = kernelTools.previewTool(app.world, grab.tool.id, t.x, t.y, { target: { kind: grab.kind, id: grab.id } }); } catch (e) { res = null; }
    }
    const thread = { x0: grab.x, y0: grab.y, x1: t.x, y1: t.y, tone: grab.kind === 'army' ? 'hate' : 'trade' };
    const pv = { ok: res ? res.ok !== false : true, polarity: grab.tool.polarity || 'neutral', ...(res || {}), threads: [thread, ...((res && res.threads) || [])] };
    app.r('setToolPreview', pv);
    previewOn = true;
    showHoverText(`${grab.tool.label}: ${grab.from}`, pv.ok === false ? pv.reason || 'It cannot go there.' : pv.text || 'Let go to send it here; Esc cancels.', pv.ok === false ? 'is-refused' : '');
  }
  function grabRelease(p, apply) {
    const g = grab;
    grab = null;
    clearPreview();
    hideHoverCard();
    if (!apply || !g || !g.to || !app.world || app.chrono?.busy) return;
    const w = app.world, t = g.tool;
    app.chrono?.beginAct?.({ kind: t.target === 'pair' ? 'pair' : 'entity', id: t.id, label: t.label, icon: t.icon || t.id, x: g.to.x, y: g.to.y });
    let res = null;
    try {
      if (t.target === 'pair' && typeof kernelTools.applyPairTool === 'function') res = kernelTools.applyPairTool(w, t.id, { kind: g.kind, id: g.id, x: g.x, y: g.y }, { kind: 'tile', x: g.to.x, y: g.to.y }, {});
      else if (typeof kernelTools.applyEntityTool === 'function') res = kernelTools.applyEntityTool(w, t.id, { kind: g.kind, id: g.id }, { x: g.to.x, y: g.to.y });
    } finally { app.chrono?.endAct?.(); }
    report(t, res, true);
    app.emit('worldEdited');
  }

  // --- Tab: walk the towns in view ------------------------------------------------------------
  function tabCycle(back) {
    const w = app.world;
    const hits = app.renderer?.hits;
    if (!w || !Array.isArray(hits)) return false;
    const seen = new Set();
    const towns = [], armies = [];
    for (const h of hits) {
      const k = h.kind + ':' + h.id;
      if (seen.has(k)) continue;
      seen.add(k);
      if (h.kind === 'settlement' && w.settlements[h.id]?.alive) towns.push(w.settlements[h.id]);
      else if (h.kind === 'army') { const a = w.armies.find((q) => q.id === h.id); if (a) armies.push(a); }
    }
    towns.sort((a, b) => (b.population || 0) - (a.population || 0) || a.id - b.id);
    armies.sort((a, b) => (b.strength || 0) - (a.strength || 0) || a.id - b.id);
    const list = [...towns.slice(0, TAB_TOWNS).map((s) => ({ kind: 'settlement', id: s.id })), ...armies.slice(0, TAB_ARMIES).map((a) => ({ kind: 'army', id: a.id }))];
    if (!list.length) return false;
    const keys = list.map((q) => q.kind + q.id).join(',');
    if (keys !== tabKeys) {
      tabKeys = keys;
      const cur = app.selection ? list.findIndex((q) => q.kind === app.selection.kind && q.id === app.selection.id) : -1;
      tabIndex = cur;
    }
    // from outside the walk (just entered, or the selection is not in it) Shift+Tab starts at its end
    const next = tabIndex < 0 && back ? list.length - 1 : tabIndex + (back ? -1 : 1);
    if (next < 0 || next >= list.length) { tabIndex = -1; return false; }   // let focus leave the map at either end
    tabIndex = next;
    app.select(list[next], { openTab: false });
    return true;
  }

  // --- keyboard -------------------------------------------------------------------------------
  const isControl = (t) => t && t !== canvas && t !== document.body && t.closest?.('input, select, textarea, button, summary, [role="button"], [role="slider"], [contenteditable="true"]');

  // Space pauses and resumes time wherever focus is (held while dragging, it pans), except
  // while typing in a text field. It is taken in the capture phase, before any focused
  // button, switch, toast or row can treat it as a click. Enter still activates controls.
  const typingField = (t) => Boolean(t && (t.isContentEditable || t.tagName === 'TEXTAREA'
    || (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(t.type))));
  const spaceIsOurs = (e) => e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey && !typingField(e.target)
    && !app.fastForwarding && Boolean(app.world) && document.getElementById('app').dataset.mode === 'world';
  window.addEventListener('keydown', (e) => {
    if (!spaceIsOurs(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) { spaceDown = true; spaceUsed = false; setCursor(); }
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key !== ' ' || !spaceDown) return;
    e.preventDefault();
    e.stopPropagation();
    spaceDown = false;
    if (!spaceUsed && !typingField(e.target)) app.togglePause();
    setCursor();
  }, true);

  window.addEventListener('keydown', (e) => {
    if (app.fastForwarding) {            // the progress overlay owns the screen; Esc stops the leap
      if (e.key === 'Escape') { e.preventDefault(); app.cancelLeap?.(); }
      return;
    }
    if (modalOpen()) return;
    if (isTyping(e)) return;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (k === 's' || k === 'S')) { e.preventDefault(); if (app.world) quickSave(app); return; }
    const inWorld = Boolean(app.world) && document.getElementById('app').dataset.mode === 'world';
    if (mod && !e.altKey && inWorld && registeredKey(e)) return;
    if (mod || e.altKey) return;
    if (!inWorld) return;
    const onControl = isControl(e.target);
    if (k === 'Escape') {
      if (mode === 'grab') { grab = null; mode = null; clearPreview(); hideHoverCard(); setCursor(); return; }
      if (cancelPair()) return;
      if (armed) { armed = null; return; }
      if (app.tool !== 'inspect') app.setTool('inspect');
      else if (app.atlasIndex != null) app.emit('atlasExit');
      else if (app.selection) app.select(null);
      return;
    }
    if (k === 'Tab' && e.target === canvas) { if (tabCycle(e.shiftKey)) e.preventDefault(); return; }
    if (onControl && (k.startsWith('Arrow') || k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown')) return;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    if (k >= '1' && k <= '6' && !e.shiftKey) { app.setSpeed(Number(k)); return; }
    if (k === '0' && !e.shiftKey) { app.pause(); return; }
    if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(lower) && !(e.shiftKey && lower.length === 1)) { e.preventDefault(); held.add(lower); return; }
    if (k === '+' || k === '=') { zoomCenter(1.25); return; }
    if (k === '-' || k === '_') { zoomCenter(0.8); return; }
    if (lower === 'm') { app.cycleMapMode?.(e.shiftKey ? -1 : 1); return; }
    if (lower === 'h' && !e.shiftKey) { app.emit('layout', 'toggle-ui'); return; }
    if (lower === 'f' && !e.shiftKey) { app.r('fitWorld'); camMoved('fit'); return; }
    if (k === '[') { app.adjustBrush?.(-1); return; }
    if (k === ']') { app.adjustBrush?.(1); return; }
    if (k === '?') { showHelp(app); return; }
    if (lower === 'j' && !e.shiftKey) { openLeap(app); return; }
    if (k === '\\') { app.emit('layout', 'toggle-panel'); return; }
    if (TAB_KEYS[lower] && !e.shiftKey) { app.setTab(TAB_KEYS[lower]); app.emit('layout', 'open-panel'); return; }
    // then what other packages registered: their tabs' keys, then their shortcuts
    if (k.length === 1 && !e.shiftKey && !e.repeat) {
      const tab = getTabs().find((t) => t.key && String(t.key).toLowerCase() === lower);
      if (tab) {
        // a tab this world has no use for (Legends in a Historical world) is not on the rail: say so
        if (!tabOpen(app, tab)) { statusToast(app, tab.unavailable || `${tab.label} has nothing to show in this world.`, 'info', { icon: tab.icon || 'help' }); return; }
        app.setTab(tab.id); app.emit('layout', 'open-panel'); return;
      }
    }
    registeredKey(e);
  });

  /** Run the registered shortcut this keydown matches (src/ui/registry.js), if any. */
  function registeredKey(e) {
    if (e.repeat) return false;
    const d = matchKey(app, e);
    if (!d) return false;
    e.preventDefault();
    try { d.run(app, e); } catch (err) { app.reportError(`key:${d.label}`, err); }
    return true;
  }
  window.addEventListener('keyup', (e) => {
    const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    held.delete(lower);
  });
  window.addEventListener('blur', () => { held.clear(); spaceDown = false; setCursor(); });
  // a key or a click anywhere (M, Esc, Tab, a panel toggle) shows its change in the next frame (busy);
  // typing into a field (Find, a name) changes nothing on the map, so it leaves the throttle alone
  for (const ty of ['keydown', 'click']) window.addEventListener(ty, (e) => {
    if (ty === 'keydown' && typingField(e.target)) return;
    touchedAt = performance.now();
  }, true);

  function zoomCenter(f) {
    const r = canvas.getBoundingClientRect();
    app.r('zoomAt', r.width / 2, r.height / 2, f);
    camMoved('zoom');
  }

  // Z: frame whatever is selected (a nation's lands, a war's theatre, a town and its fields)
  registerKey({ key: 'z', label: 'Frame the selection', group: 'Map', when: (a) => Boolean(a.selection), run: (a) => a.frameSelection() });

  app.on('tool', () => { cancelPair(); armed = null; clearPreview(); setCursor(); hoverDirty = true; previewAt = 0; if (app.tool === 'inspect') app.r('setBrush', null); });
  app.on('brush', () => { hoverDirty = true; hoverAt = 0; previewAt = 0; });
  app.on('toolOptions', () => { hoverDirty = true; hoverAt = 0; previewAt = 0; });
  app.on('follow', () => { followAt = 0; followBox = null; });
  // an off-screen act's edge pointer (renderer hit kind 'fxPointer'): fly to where it happened
  app.on('fxPointerPicked', (id) => {
    const t = app.renderer?.fxPointer?.(id);
    if (t && Number.isFinite(t.x) && Number.isFinite(t.y)) app.focus(t.x, t.y, Math.max(app.renderer?.camera?.zoom || 6, 8));
  });
  app.on('world', () => {
    held.clear(); cancelToolWait(); cancelLongPress(); ctxPress = null; mode = null; pointers.clear(); stroke = null; pair = null; armed = null; lastPreview = null; previewOn = false; tabKeys = ''; setCursor();
    // a replaced world (undo, rewind, load) must not keep describing what was under the pointer
    // in the old one: hide the card and read the spot again once the new world has been drawn
    hideHoverCard(); hoverDirty = true; hoverAt = performance.now(); previewAt = 0;
  });
  setCursor();
  /** Use a god tool once at a canvas point (the context menu's "… here"). */
  app.useToolAt = (id, p) => {
    const t = getTool(id);
    if (!app.world || !t || !p) return;
    const prev = app.tool;
    app.setTool(id);
    if (stroke) endStroke();
    mode = 'tool';
    beginStroke(p);
    endStroke();
    mode = null;
    // a single use from the context menu hands the map back to the tool held before (a pair tool stays, waiting for its second pick)
    if (t.target !== 'pair' && prev !== id) app.setTool(prev);
    setCursor();
  };
  /** End a stroke in progress (the Chronoscope does before it undoes). */
  app.cancelStroke = () => { if (stroke) { endStroke(); mode = null; setCursor(); } };

  /** Keep the followed thing in view: a mover centred, a region re-framed when it changes. */
  function followTick(nowT) {
    const f = app.follow;
    if (!f) return;
    const frame = followMode(f) === 'frame';
    if (nowT - followAt < (frame ? FOLLOW_FRAME_MS : FOLLOW_POINT_MS)) return;
    followAt = nowT;
    if (frame) {
      const b = selectionFrame(app, f);
      if (!b) { app.follow = null; return; }
      const fb = followBox;
      const moved = !fb || Math.abs(b.x0 - fb.x0) + Math.abs(b.x1 - fb.x1) + Math.abs(b.y0 - fb.y0) + Math.abs(b.y1 - fb.y1) > 2;
      if (moved) { followBox = b; app.frameBox(b); }
      return;
    }
    const p = app.followPoint();
    if (!p) {
      const d = describeSel(app, f);
      app.follow = null;
      statusToast(app, `${d.name} is gone; the camera stays here.`, 'info', { icon: d.icon || 'eye' });
      return;
    }
    app.focus(p.x, p.y, app.renderer?.camera?.zoom);
  }

  return {
    frame(dt) {
      if (!app.world) return;
      // keyboard panning
      if (held.size) {
        let dx = 0, dy = 0;
        if (held.has('a') || held.has('ArrowLeft')) dx += 1;
        if (held.has('d') || held.has('ArrowRight')) dx -= 1;
        if (held.has('w') || held.has('ArrowUp')) dy += 1;
        if (held.has('s') || held.has('ArrowDown')) dy -= 1;
        if (dx || dy) { app.r('pan', dx * KEY_PAN * dt, dy * KEY_PAN * dt); camMoved('keys'); }
      }
      // continuous tools
      if (mode === 'tool' && stroke && stroke.tool.continuous && stroke.pos) {
        const nowT = performance.now();
        if (nowT - stroke.lastApply >= APPLY_MS) { stroke.lastApply = nowT; applyAt(stroke.pos, false); }
      }
      if (stroke && mode === 'tool') { hoverDirty = true; }
      processHover();
      followTick(performance.now());
    },
    /** Let go of a pair tool's source (Esc does the same). */
    cancelPair,
    /** Is the viewer at work: a press, drag, pinch or stroke, held pan keys, the pointer over the map, a key or click lately? */
    busy(nowT = performance.now()) { return mode !== null || held.size > 0 || nowT - touchedAt < BUSY_MS; },
  };
}
