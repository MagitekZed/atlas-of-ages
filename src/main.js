// Atlas of Ages — bootstrap and main loop.
//
// Loads the kernel statically and every other owner's module behind a guard (renderer,
// world generator, simulation systems), so a missing or broken piece degrades to a
// fallback with a clear notice instead of a blank page. Then: Genesis screen → generate →
// simulate. Each animation frame: sim.advance(dt, budget) → renderer.render(t); panels
// refresh at most four times a second. window.atlas exposes the live objects.
// The expansion packages' UI modules (src/ui/mounts.js) load with the others and mount once
// the built-in instruments are up; the app API they build on (contracts §15) lives here:
// app.fastForward(years, prog, { until }), app.restoreWorld(world, { reason }), and the
// leapDone / worldRestored / toolApplied events.

import { createWorld, yearOf } from './core/world.js';
import { Simulation } from './core/sim.js';
import { loadSystems } from './systems.js';
import { DAYS_PER_YEAR } from './core/constants.js';
import { deserializeWorld } from './core/serialize.js';
import { liveCivs, liveSettlements } from './core/entities.js';
import { PRESETS, PARAM_BY_KEY, coerceParam, defaultParams } from './core/params.js';
import { getTool } from './core/tools.js';
import { createApp, TABS, MAX_SPEED, selectionExists } from './ui/app.js';
import { urlOptions } from './ui/prefs.js';
import { installTooltips, showProgress, msText } from './ui/widgets.js';
import { installThemeWatch } from './ui/theme.js';
import { mountGenesis, randomSeed } from './ui/genesis.js';
import { mountTitle } from './ui/title.js';
import { forgeWorld } from './ui/forging.js';
import { getPref } from './ui/prefs.js';
import { mountHud, showHelp } from './ui/hud.js';
import { mountMapDock } from './ui/mapdock.js';
import { mountPalette } from './ui/palette.js';
import { mountInput } from './ui/input.js';
import { mountPanel } from './ui/panel.js';
import { mountToasts, statusToast } from './ui/toasts.js';
import { initSaves, openSaves, autosaveTick, offerResume } from './ui/saves.js';
import { createFallbackRenderer, renderFallbackPreview, FALLBACK_MAP_MODES } from './ui/fallback-renderer.js';
import { h, clear, oneFrame, yieldTask, isHidden, cssVar } from './ui/dom.js';
import { chronicleSince } from './core/chronicle.js';
import { on as onHook } from './core/hooks.js';
import { int, span } from './ui/format.js';
import * as uiRegistry from './ui/registry.js';

const app = createApp();
const url = urlOptions();
const appEl = document.getElementById('app');

// ---------------------------------------------------------------------------
// Guarded loading of other owners' modules (in parallel)

const note = (path) => (e) => {
  app.loadErrors.push({ path, message: (e && e.message ? e.message : String(e)).split('\n')[0] });
  console.warn(`[atlas] ${path} unavailable:`, e);
  return null;
};
const systemsReady = loadSystems({ onError: (p, e) => note('src/' + p.replace(/^\.\//, ''))(e) })
  .catch((e) => { note('src/systems.js')(e); return []; });
const [renderMod, genMod, mountsMod, layersMod] = await Promise.all([
  import('./render/renderer.js').catch(note('src/render/renderer.js')),
  import('./gen/worldgen.js').catch(note('src/gen/worldgen.js')),
  // package UI modules: imported now (tabs they register at import are on the rail from the start), mounted after the instruments
  import('./ui/mounts.js').then(async (m) => { await m.loadMounts({ onError: (path, e) => note(path)(e) }); return m; }).catch(note('src/ui/mounts.js')),
  import('./render/layers.js').catch(() => null),
]);
app.modules.render = renderMod?.createRenderer && url.renderer !== 'fallback' ? renderMod : null;
app.modules.gen = genMod?.generateWorld && url.gen !== 'fallback' ? genMod : null;
if (renderMod && !renderMod.createRenderer) note('src/render/renderer.js')(new Error('createRenderer is not exported'));
if (genMod && !genMod.generateWorld) note('src/gen/worldgen.js')(new Error('generateWorld is not exported'));
let fallbackGen = null;
if (!app.modules.gen) {
  const m = await import('../tools/fallback-gen.mjs').catch(note('tools/fallback-gen.mjs'));
  fallbackGen = m?.fallbackGenerate || null;
}
app.modules.fallbackGen = fallbackGen;

/** Map modes on offer: the renderer's own (with registered modes whose when(world) holds), or the fallback set. */
app.mapModes = () => {
  if (app.renderInfo.fallback || !Array.isArray(app.modules.render?.MAP_MODES) || !app.modules.render.MAP_MODES.length) return FALLBACK_MAP_MODES;
  const forWorld = app.modules.render.mapModesFor;
  if (typeof forWorld === 'function') {
    try { const list = forWorld(app.world); if (Array.isArray(list) && list.length) return list; } catch (e) { app.reportError('mapModesFor', e); }
  }
  return app.modules.render.MAP_MODES;
};

function generate(world, opts = {}) {
  if (app.modules.gen) return app.modules.gen.generateWorld(world, opts);
  if (fallbackGen) { opts.onStage?.('Raising a simplified world'); return fallbackGen(world); }
  throw new Error('No world generator could be loaded (src/gen/worldgen.js and tools/fallback-gen.mjs are both missing).');
}

function drawPreview(world, canvas) {
  if (app.modules.render?.renderPreview) {
    try { app.modules.render.renderPreview(world, canvas); return; } catch (e) { app.reportError('renderPreview', e); }
  }
  renderFallbackPreview(world, canvas);
}

// ---------------------------------------------------------------------------
// Renderer lifecycle

const canvas = document.getElementById('map');

function useFallbackRenderer(world, reason) {
  app.renderer = createFallbackRenderer(canvas, world);
  app.renderInfo = { fallback: true, error: reason ? String(reason.message || reason) : null };
  app.emit('renderer');
}

function attachRenderer(world, { fit = true } = {}) {
  if (app.renderer && !app.renderInfo.fallback) {
    try { app.renderer.setWorld(world); } catch (e) { app.reportError('renderer.setWorld', e); useFallbackRenderer(world, e); }
  } else if (app.renderer && app.renderInfo.fallback && !app.modules.render) {
    app.renderer.setWorld(world);
  } else if (app.modules.render) {
    try {
      app.renderer = app.modules.render.createRenderer(canvas, world);
      app.renderInfo = { fallback: false, error: null };
      app.emit('renderer');
    } catch (e) {
      app.reportError('createRenderer', e);
      useFallbackRenderer(world, e);
    }
  } else {
    // ?renderer=fallback asks for the stand-in on purpose; otherwise the real renderer failed to load
    useFallbackRenderer(world, url.renderer === 'fallback' && renderMod?.createRenderer ? 'requested with ?renderer=fallback' : 'src/render/renderer.js did not load');
  }
  app.r('resize');
  if (fit) app.r('fitWorld');
}

/**
 * On a tall, narrow screen the fitted world is a thin band. Zoom so the world's height fills
 * the open strip between the HUD and the toolbelt, and centre it there.
 */
function fillTallScreen(world) {
  const r = canvas.getBoundingClientRect();
  if (!(r.width > 0) || r.height < r.width * 1.25 || !app.renderer?.camera) return;
  const hud = document.querySelector('.hud-top')?.getBoundingClientRect();
  const belt = document.querySelector('.hud-bottom')?.getBoundingClientRect();
  const top = hud && hud.height ? hud.bottom - r.top + 6 : 0;
  const bottom = belt && belt.height ? belt.top - r.top - 6 : r.height;
  const strip = bottom - top;
  if (strip < 120) return;
  const z0 = app.renderer.camera.zoom;
  const want = Math.min(strip / world.H, (r.width * 2.6) / world.W);
  if (!(z0 > 0) || want <= z0 * 1.02) return;
  app.r('zoomAt', r.width / 2, r.height / 2, want / z0, true);
  app.r('pan', 0, (top + bottom) / 2 - r.height / 2);
}

new ResizeObserver(() => { if (app.renderer) app.r('resize'); }).observe(canvas);

// the void around the world follows the theme (a parchment page in light, the night sky in dark)
const syncMapVoid = () => app.r('setBackground', cssVar('--map-void', ''));
app.on('renderer', syncMapVoid);
app.on('theme', syncMapVoid);

// ---------------------------------------------------------------------------
// Worlds: create, install, fast-forward, load

let genesis = null;
let creating = false;
const FF_SLICE_MS = 50;       // work per slice while fast-forwarding; a frame is painted between slices
const FF_SLICE_DAYS = 360;    // and never more days than this per slice (keeps pace even if the clock stalls)

/** Build the simulation for a world. Every system's init runs here: the first tribes are seeded now. */
function prepareSim(world, systems) {
  const sim = new Simulation(world, systems);
  sim.init();
  return sim;
}

/**
 * Make a world live. It stays stopped (run = false) until the caller has finished setting up.
 * keepView (a restored world) keeps the camera where the viewer left it.
 */
function installWorld(world, sim, { run = true, keepPause = false, keepView = false } = {}) {
  const prevSpeed = app.sim ? app.sim.speedIndex : null;
  // A new world keeps the pace the viewer last chose (New world pauses the old one itself, which
  // is not the viewer's pause). An opened save keeps a pause the viewer chose, so nothing
  // happens unseen.
  const viewerPaused = prevSpeed === 0 && !(app.resumeSpeed > 0);
  sim.setSpeed(keepPause && viewerPaused ? 0 : prevSpeed > 0 ? prevSpeed : (app.resumeSpeed || app.lastSpeed || 2));
  app.resumeSpeed = 0;
  app.sim = sim;
  app.world = world;
  app.simStartDay = world.time.day;   // sim.timing counts from here (a loaded world starts late)
  app.atlasIndex = null;
  app.history.length = 0;
  attachRenderer(world, { fit: !keepView });
  app.follow = null;
  app.select(null);
  app.running = run;
  genesis?.hide();
  appEl.dataset.mode = 'world';
  appEl.classList.remove('is-booting');
  app.emit('world', world);
  app.emit('speed', app.sim.speedIndex);
  if (!keepView) fillTallScreen(world);   // after the HUD and toolbelt are laid out for this world
}

/**
 * Run `years` of history as fast as the device allows, in slices of ~50 ms with a painted
 * frame between them, so the progress bar moves, the map keeps drawing and Stop works.
 * In a background tab (no frames) it yields through a message channel instead of timers,
 * which browsers throttle there. `until` stops it early: a function (world) → hit | null,
 * or { test(world, state), state }, tested after every simulated day (cheap and read-only).
 * Returns { days, cancelled, hit, ms } (hit: what until returned, or null).
 */
async function fastForward(years, prog, { cancellable = true, until = null } = {}) {
  const world = app.world, sim = app.sim;
  if (!world || !sim || app.fastForwarding) return { days: 0, cancelled: false, hit: null, ms: 0 };
  let test = typeof until === 'function' ? until : until && typeof until.test === 'function' ? (w) => until.test(w, until.state) : null;
  let hit = null;
  const wasRunning = app.running;
  app.running = false;          // the frame loop must not advance the world meanwhile
  app.fastForwarding = true;
  let cancelled = false;
  const cancel = () => { if (!cancelled) { cancelled = true; prog?.note('Stopping at the end of this day…'); } };
  app.cancelLeap = cancel;
  if (cancellable) prog?.onCancel('Stop here', cancel);
  const total = Math.max(0, Math.round(years * DAYS_PER_YEAR));
  const start = world.time.day;
  const endYear = Math.floor((start + total) / DAYS_PER_YEAR);
  const t0 = performance.now();
  try {
    while (!cancelled && !hit && world.time.day - start < total && app.world === world) {
      const hidden = isHidden();
      const sliceMs = hidden ? 250 : FF_SLICE_MS;
      const s0 = performance.now();
      let n = 0;
      while (world.time.day - start < total && n < FF_SLICE_DAYS && performance.now() - s0 < sliceMs) {
        sim.step(); n++;
        if (test) {
          let r = null;
          try { r = test(world); } catch (e) { app.reportError('fastForward.until', e); test = null; }
          if (r) { hit = r; break; }
        }
      }
      const done = world.time.day - start;
      const elapsed = performance.now() - t0;
      const rate = done / Math.max(1, elapsed);   // days per ms of wall time
      prog?.fraction(done / Math.max(1, total));
      if (!cancelled) prog?.note(`Year ${yearOf(world)} of ${endYear}`);
      const left = done < total && elapsed > 1200 ? ` · about ${msText((total - done) / Math.max(1e-6, rate))} left` : '';
      prog?.detail(`${liveCivs(world).length} nations · ${int(liveSettlements(world).length)} settlements · ${((rate * 1000) / DAYS_PER_YEAR).toFixed(1)} years a second${left}`);
      await (hidden ? yieldTask() : oneFrame());
    }
  } finally {
    app.fastForwarding = false;
    app.cancelLeap = null;
    app.running = wasRunning && app.world === world;
  }
  return { days: world.time.day - start, cancelled, hit, ms: performance.now() - t0 };
}

/**
 * app.fastForward(years, prog?, { until?, cancellable? }) → { days, cancelled, hit, ms }
 * The leap engine for other modules (run-until, replays): prog is an optional
 * showProgress() handle; afterwards the toasts skip the leapt-over entries and panels refresh.
 */
app.fastForward = async (years, prog = null, opts = {}) => {
  if (creating || app.fastForwarding || !app.world) return { days: 0, cancelled: false, hit: null, ms: 0 };
  const r = await fastForward(years, prog, opts);
  app.emit('historySkipped');
  app.emit('tick');
  return r;
};

async function beginWorld(params, { years = 0, speed = null } = {}) {
  if (creating || app.fastForwarding) return null;
  creating = true;
  genesis?.setBusy(true);
  const prevRunning = app.running;
  app.running = false;
  years = Math.max(0, Math.min(5000, Math.round(Number(years) || 0)));
  let prog = null;
  let installed = false;
  try {
    let world = createWorld(params);
    const sub = [];
    let tS = performance.now(), last = null;
    const snaps = {};
    const onStage = (label) => {
      const t = performance.now();
      if (last) sub.push({ label: last, ms: t - tS });
      last = String(label); tS = t;
      // the relief as it rose, before the land weathered: the forging shows the continents rising
      if (label === 'Weathering the land') snaps.rawElev = world.f.elevation.slice();
    };
    // the generator runs in a breath; the forging below plays its stages back at a watchable pace
    await oneFrame();
    try {
      generate(world, { onStage });
    } catch (e) {
      if (!fallbackGen) {
        const m = await import('../tools/fallback-gen.mjs').catch(() => null);
        fallbackGen = m?.fallbackGenerate || null;
        app.modules.fallbackGen = fallbackGen;
      }
      app.reportError('generateWorld', e);
      if (!fallbackGen) throw e;
      world = createWorld(params);
      fallbackGen(world);
      statusToast(app, `The world generator failed (${e.message}); a simplified world was made instead.`, 'error');
    }
    if (last) sub.push({ label: last, ms: performance.now() - tS });
    const systems = await systemsReady;
    const sim = prepareSim(world, systems);
    // the forging: the plate engraved stage by stage; Cancel throws the world away
    let forged = null;
    if (!getPref('skipForging', false) && !isHidden()) {
      const after = ['Waking the systems', 'Seeding the first peoples', 'Opening the atlas'];
      forged = await forgeWorld(app, world, { stages: sub, after, snaps, drawColour: drawPreview });
      if (forged.cancelled) {
        app.running = prevRunning;
        if (!app.world) title?.show();
        return null;
      }
    }
    installWorld(world, sim, { run: false });
    installed = true;
    if (forged) await arrive(forged);
    if (years > 0) {
      prog = showProgress('Forging a world', [`Running ${int(years)} years of history`]);
      await prog.stage(0, `Running ${int(years)} years of history…`);
      const r = await fastForward(years, prog);
      app.emit('historySkipped');
      app.emit('tick');
      if (r.cancelled) statusToast(app, `History was stopped early, in Year ${yearOf(world)}.`, 'info', { icon: 'pause' });
    }
    if (speed != null && Number.isFinite(speed)) app.setSpeed(speed);
    app.running = true;
    prog?.close();
    return world;
  } catch (e) {
    prog?.close();
    app.running = installed || prevRunning;
    app.reportError('beginWorld', e);
    showFatal('The world could not be created', e, { canReturn: true });
    return null;
  } finally {
    creating = false;
    genesis?.setBusy(false);
  }
}

/**
 * From the forging into the world: the map opens under the finished plate at the plate's own
 * framing, the plate melts away, the camera eases out to the whole world, and the instruments
 * come in one after another (the app's is-arriving class).
 */
async function arrive(forged) {
  const cam = app.renderer?.camera;
  if (cam) {
    cam.fit();
    cam.zoom = Math.max(cam.viewW / cam.worldW, cam.viewH / cam.worldH);
    cam.x = cam.worldW / 2; cam.y = cam.worldH / 2;
  }
  appEl.classList.add('is-arriving');
  await oneFrame();
  const melt = forged.dissolve();
  setTimeout(() => { if (cam) cam.focusOn(cam.worldW / 2, cam.worldH / 2, cam.fitZoom()); }, 700);
  await melt;
  setTimeout(() => appEl.classList.remove('is-arriving'), 1600);
}

/** Leap ahead from the running world (Menu › Leap ahead). */
async function leapAhead(years) {
  const w = app.world;
  if (!w || creating || app.fastForwarding) return;
  const seq0 = w.chronicle.seq, y0 = yearOf(w), fromDay = w.time.day;
  const prog = showProgress(`Leaping ${int(years)} years ahead`, [`From Year ${y0} to Year ${y0 + years}`]);
  await prog.stage(0);
  let r;
  try { r = await fastForward(years, prog); } finally { prog.close(); }
  app.emit('historySkipped');
  app.emit('tick');
  const major = chronicleSince(w, seq0).filter((e) => e.imp >= 3).length;
  statusToast(app, `${r.cancelled ? 'Stopped' : 'Arrived'} in Year ${yearOf(w)} after ${span(r.days)} of history (${msText(r.ms)}). ${major ? `${int(major)} major event${major === 1 ? ' was' : 's were'} written in the Chronicle.` : 'Nothing of great note happened.'}`,
    'ok', { icon: 'chronicle', ms: 7000, onClick: major ? () => { app.setTab('chronicle'); app.emit('layout', 'open-panel'); } : null });
  app.emit('leapDone', { fromDay, toDay: w.time.day, seq0, hit: r.hit ?? null, cancelled: r.cancelled });
}
app.leapAhead = leapAhead;

/** Is the record a selection points at still there in this world? */
const stillThere = (w, sel) => Boolean(w && sel) && w === app.world && selectionExists(app, sel);

/**
 * app.restoreWorld(world, { reason }) — install a world that stands in for the current one
 * (an undo, a rewind, a branch): its systems wake (prepareSim), it is installed keeping the
 * viewer's pause, the camera and, when it still exists, the selection and the follow; then
 * 'worldRestored' { reason, fromDay, toDay } is emitted. While it installs, app.restoring holds
 * the reason, so 'world' listeners can keep what belongs to the viewer rather than the world.
 * opts.sim: a Simulation already running this world (its systems initialised) to reuse.
 * Resolves to true when installed.
 */
async function restoreWorld(world, { reason = 'restore', sim: ready = null } = {}) {
  if (!world || creating || app.fastForwarding) return false;
  const fromDay = app.world?.time?.day ?? null;
  const prevSel = app.selection;
  try {
    const systems = await systemsReady;
    // a caller that already woke the world's systems (the Chronoscope, after a replay) hands its simulation over
    const sim = ready && ready.world === world ? ready : prepareSim(world, systems);
    app.restoring = reason;     // 'world' listeners can tell a restored moment from a new world
    try { installWorld(world, sim, { keepPause: true, keepView: true }); } finally { app.restoring = null; }
  } catch (e) {
    app.reportError('restoreWorld', e);
    statusToast(app, `That moment could not be restored: ${e.message}`, 'error');
    return false;
  }
  const prevFollow = app.follow;
  if (prevSel && stillThere(world, prevSel)) app.select(prevSel, { openTab: false });
  if (prevFollow && stillThere(world, prevFollow)) app.follow = prevFollow;
  app.emit('worldRestored', { reason, fromDay, toDay: world.time.day });
  return true;
}
app.restoreWorld = restoreWorld;

// the kernel's toolApplied hook, relayed to the UI (never while a replay re-applies the log)
onHook('toolApplied', (world, payload) => {
  if (world !== app.world || world?.cache?.replaying) return;
  app.emit('toolApplied', payload);
});

/** Install a world from a deserialised save object. */
async function loadWorldData(obj, label = 'saved world') {
  if (creating || app.fastForwarding) return false;
  creating = true;
  const prog = showProgress('Opening a ' + label, ['Reading the record', 'Waking the systems', 'Opening the atlas']);
  try {
    await prog.stage(0);
    const world = deserializeWorld(obj);
    await prog.stage(1);
    const systems = await systemsReady;
    const sim = prepareSim(world, systems);
    await prog.stage(2);
    installWorld(world, sim, { keepPause: true });
    prog.close();
    statusToast(app, `Opened “${world.name}” at Year ${yearOf(world)}.${app.speed === 0 ? ' Time is paused: press Space to continue.' : ''}`, 'ok', { icon: 'open' });
    return true;
  } catch (e) {
    prog.close();
    app.reportError('loadWorld', e);
    statusToast(app, `That world could not be opened: ${e.message}`, 'error');
    return false;
  } finally {
    creating = false;
  }
}
app.loadWorldData = loadWorldData;

app.newWorld = () => {
  if (app.fastForwarding || creating) return;
  app.resumeSpeed = app.speed;      // so "Return to …" picks up where the viewer left off
  app.pause();
  genesis.show({ canReturn: Boolean(app.world) });
};
app.returnToWorld = () => {
  if (!app.world) return;
  genesis.hide();
  appEl.dataset.mode = 'world';
  app.r('resize');
  if (app.resumeSpeed > 0 && app.speed === 0) app.setSpeed(app.resumeSpeed);
  app.resumeSpeed = 0;
};

// ---------------------------------------------------------------------------
// Errors

function showFatal(title, err, { canReturn = false } = {}) {
  const el = document.getElementById('fatal');
  clear(el);
  const list = app.loadErrors.length ? h('ul.fatal-list', null, app.loadErrors.map((x) => h('li', { text: `${x.path}: ${x.message}` }))) : null;
  const actions = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
  if (canReturn) actions.appendChild(h('button.btn', { type: 'button', text: 'Back to genesis', onclick: () => { el.hidden = true; genesis?.show({ canReturn: Boolean(app.world) }); } }));
  if (app.world) actions.appendChild(h('button.btn', { type: 'button', text: 'Keep watching', onclick: () => { el.hidden = true; } }));
  actions.appendChild(h('button.btn.btn-brass', { type: 'button', text: 'Reload', onclick: () => location.reload() }));
  el.appendChild(h('div.fatal-box', null,
    h('h2', { text: title }),
    h('p.fatal-msg', { text: err ? (err.stack || err.message || String(err)).split('\n').slice(0, 6).join('\n') : '' }),
    list ? h('p', { text: 'Modules that did not load:' }) : null, list,
    actions,
  ));
  el.hidden = false;
}
app.showFatal = showFatal;

let errToastAt = 0;
window.addEventListener('error', (e) => {
  if (!window.__atlasBooted || !(e instanceof ErrorEvent)) return;
  app.reportError('window', e.error || e.message);
  if (performance.now() - errToastAt > 8000) { errToastAt = performance.now(); statusToast(app, `Something went wrong: ${e.message}. The world keeps running; details are in World › Engine room.`, 'error'); }
});
window.addEventListener('unhandledrejection', (e) => {
  if (!window.__atlasBooted) return;
  app.reportError('promise', e.reason);
});

// ---------------------------------------------------------------------------
// Main loop

let lastT = performance.now(), lastTick = 0, renderFails = 0, lastFFDraw = 0, lastDraw = 0;
const meter = { days: 0, t: 0 };
// Running means of render and UI cost (and of an undrawn frame's upkeep, renderer.skipFrame);
// at Max speed the sim gets what remains of a ~30 fps frame.
let renderMs = 12, otherMs = 2, skipMs = 0.3;
app.perf = { renderMs: 0, otherMs: 0, budget: 0 };
let input = null;
// a new pace is measured afresh: the last second's figure belongs to the old speed
app.on('speed', () => { meter.days = 0; meter.t = 0; app.measured.dps = 0; });
// At Max speed a still map is drawn again only once MAX_DRAW_GAP ms have passed (every other
// ~30 fps frame, about 15 draws a second), and the frames between give the sim the time the
// drawing would have taken. smoothFrame() says when every frame must still be drawn;
// drawnView is the camera as last drawn.
const MAX_DRAW_GAP = 50;
const drawnView = { x: NaN, y: NaN, zoom: NaN, w: 0, h: 0 };

/**
 * Must this frame be drawn, even at Max speed? Yes while the view moves (a pan, zoom, flight or
 * Director cut, a resize, a follow), while the viewer is at work on the map (input.busy: a drag,
 * a pinch, held keys, a stroke, the pointer moving over it), while a tool's brush, preview or
 * highlights show (they animate) and while close-zoom detail is still filling in after a move
 * (renderer.detailPending: it builds a chunk or two per draw). The stand-in renderer is cheap:
 * it always draws.
 */
function smoothFrame(t) {
  const r = app.renderer, c = r?.camera;
  if (!c || app.renderInfo.fallback || app.follow || c.animating) return true;
  if (c.x !== drawnView.x || c.y !== drawnView.y || c.zoom !== drawnView.zoom || c.viewW !== drawnView.w || c.viewH !== drawnView.h) return true;
  return Boolean(r.detailPending || r.brush || r.toolPreview || r.highlights?.length || input?.busy(t));
}

function frame(t) {
  requestAnimationFrame(frame);
  const f0 = performance.now();
  const dt = Math.max(0, Math.min(0.25, (t - lastT) / 1000));
  lastT = t;
  const max = Boolean(app.running && app.sim && app.sim.speedIndex === MAX_SPEED);
  // while fast-forwarding the map sits under the progress scrim: redraw it a few times a second, not every slice
  const drawNow = app.fastForwarding ? t - lastFFDraw >= 240 : !max || t - lastDraw >= MAX_DRAW_GAP || smoothFrame(t);
  if (app.running && app.sim) {
    // a frame that will not be drawn gives the sim the render's share too
    const budget = max ? Math.max(6, Math.min(24, 27 - (drawNow ? renderMs : skipMs) - otherMs)) : 12;
    app.perf.budget = budget;
    try { meter.days += app.sim.advance(dt, budget); } catch (e) { app.reportError('sim.advance', e); }
  }
  if (app.running) meter.t += dt;   // a leap or the Genesis screen is not part of the pace
  if (meter.t >= 1) { app.measured.dps = app.speed > 0 ? meter.days / meter.t : 0; meter.days = 0; meter.t = 0; }
  try { input?.frame(dt); } catch (e) { app.reportError('input.frame', e); }
  const onMap = Boolean(app.renderer && app.world && appEl.dataset.mode === 'world');
  if (!drawNow && max && onMap && typeof app.renderer.skipFrame === 'function') {
    // an undrawn frame still takes in the effects its days queued, as a drawn one would: by the
    // next draw, two frames of Max speed have passed and most of them would read as stale
    const s0 = performance.now();
    try { app.renderer.skipFrame(t); } catch (e) { app.reportError('renderer.skipFrame', e); }
    skipMs = skipMs * 0.9 + (performance.now() - s0) * 0.1;
  }
  if (drawNow && onMap) {
    if (app.fastForwarding) lastFFDraw = t;
    lastDraw = t;
    const r0 = performance.now();
    try {
      app.renderer.render(t); renderFails = 0; renderMs = renderMs * 0.9 + (performance.now() - r0) * 0.1;
      const c = app.renderer.camera;
      if (c) { drawnView.x = c.x; drawnView.y = c.y; drawnView.zoom = c.zoom; drawnView.w = c.viewW; drawnView.h = c.viewH; }
    }
    catch (e) {
      renderFails++;
      if (renderFails === 1) app.reportError('renderer.render', e);
      if (renderFails >= 20 && !app.renderInfo.fallback) {
        useFallbackRenderer(app.world, e);
        app.r('resize'); app.r('fitWorld');
        statusToast(app, 'The map renderer kept failing, so the atlas switched to a simplified map.', 'error');
        renderFails = 0;
      }
    }
  }
  const u0 = performance.now();
  if (t - lastTick >= 250 && app.world) {
    lastTick = t;
    app.emit('tick');
    autosaveTick(app);
  }
  const u1 = performance.now();
  otherMs = otherMs * 0.9 + (u1 - u0) * 0.1;
  app.perf.renderMs = renderMs; app.perf.otherMs = otherMs; app.perf.frameMs = u1 - f0;
}

// ---------------------------------------------------------------------------
// Boot

installThemeWatch(app);
installTooltips();
initSaves(app);
mountHud(app);
mountMapDock(app);
mountPalette(app);
input = mountInput(app, canvas);
mountPanel(app);
mountToasts(app);

const initialGenesis = {};
if (url.seed) initialGenesis.seed = url.seed;
if (url.preset && PRESETS.some((p) => p.id === url.preset)) initialGenesis.preset = url.preset;
if (url.size && PARAM_BY_KEY.worldSize.options.some(([v]) => v === url.size)) initialGenesis.worldSize = url.size;
// ?set=key:value,key:value overrides individual parameters
if (url.set) for (const pair of url.set.split(',')) {
  const [k, v] = pair.split(':');
  if (PARAM_BY_KEY[k]) initialGenesis[k] = coerceParam(k, v === 'true' ? true : v === 'false' ? false : v);
}

genesis = mountGenesis(app, {
  generate: (w, o) => generate(w, o),
  renderPreview: drawPreview,
  genAvailable: Boolean(app.modules.gen),
  initial: initialGenesis,
  onBegin: (params, o = {}) => beginWorld(params, { years: o.years || 0 }),
  onLoad: () => openSaves(app),
  onReturn: () => app.returnToWorld(),
  // leaving the rite: back to the world if one is open, else to the title
  onClose: () => { if (app.world) app.returnToWorld(); else title?.show(); },
});

// the title screen stands over the Genesis screen until something is chosen
let title = null;
function randomWorldParams() {
  const preset = PRESETS[Math.floor(Math.random() * PRESETS.length)];
  return { ...defaultParams(), ...(preset?.params || {}), seed: randomSeed(), mythLevel: Math.floor(Math.random() * 3) };
}
title = mountTitle(app, {
  backdrop: (canvas) => {
    if (!app.modules.gen) return;
    const w = createWorld({ ...defaultParams(), ...initialGenesis, seed: initialGenesis.seed || randomSeed() });
    generate(w, { preview: true });
    canvas.width = Math.round(w.W * 6); canvas.height = Math.round(w.H * 6);
    drawPreview(w, canvas);
  },
  onNew: () => {},
  onDefault: () => beginWorld({ ...defaultParams(), seed: randomSeed() }),
  onRandom: () => beginWorld(randomWorldParams()),
  onLoad: () => openSaves(app),
  onKeys: () => showHelp(app),
});
app.showTitle = () => title.show();

requestAnimationFrame(frame);
window.__atlasBooted = true;
appEl.classList.remove('is-booting');

window.atlas = {
  app,
  get world() { return app.world; },
  get sim() { return app.sim; },
  get renderer() { return app.renderer; },
  /** Run n days immediately (debugging). */
  run(days = DAYS_PER_YEAR) { if (app.sim) { app.sim.run(days); app.emit('tick'); } },
  select: (kind, id) => app.select({ kind, id }, { focus: true }),
  tool: (id) => app.setTool(id),
  speed: (i) => app.setSpeed(i),
  begin: (params = {}, years = 0) => beginWorld({ ...defaultParams(), ...params }, { years }),
  /** Leap ahead n years at full speed (as Menu › Leap ahead). */
  leap: (years = 100) => leapAhead(years),
  /** The UI registries (src/ui/registry.js) and render registries (src/render/layers.js), for the console. */
  registry: uiRegistry,
  layers: layersMod,
};

// the package UI modules mount now that the instruments are up, before any world begins
if (mountsMod) { try { mountsMod.mountAll(app); } catch (e) { app.reportError('mounts', e); } }

// ?autostart=1&seed=x&years=40&tab=nations — skip Genesis, fast-forward, open a tab
if (url.autostart === '1' || url.autostart === 'true') {
  // a shared URL must make the same world for everyone: defaults + preset + URL settings only,
  // never the viewer's remembered Genesis choices
  const preset = PRESETS.find((p) => p.id === initialGenesis.preset);
  const params = { ...defaultParams(), ...(preset ? preset.params : {}), ...initialGenesis };
  delete params.preset;
  if (!url.seed) params.seed = 'atlas';
  const years = Math.max(0, Math.min(5000, Number(url.years) || 0));
  const speed = url.speed != null && url.speed !== '' && Number.isFinite(Number(url.speed)) ? Number(url.speed) : null;
  await beginWorld(params, { years, speed });
  applyUrlView();
} else {
  // a returning viewer is offered the world they left (the resume slot, saves.js)
  offerResume(app).catch(() => {});
  if (!url.seed && !url.preset && !url.size && !url.set && url.title !== '0') title.show();
}
document.documentElement.dataset.ready = '1';
window.atlasReady = true;

function applyUrlView() {
  if (!app.world) return;
  if (url.speed != null && Number.isFinite(Number(url.speed))) app.setSpeed(Number(url.speed));
  if (url.mode) { app.r('setMapMode', url.mode); app.emit('mapmode', url.mode); }
  if (url.tool && getTool(url.tool)) app.setTool(url.tool);
  if (url.panel) app.emit('layout', url.panel);
  const sel = parseSelect(url.select);
  if (sel) app.select(sel, { focus: url.focus !== '0', zoom: Number(url.zoom) || undefined });
  if (url.tab && TABS.includes(url.tab)) app.setTab(url.tab);
  if (url.atlas != null && app.world.history?.atlas?.length) {
    const n = app.world.history.atlas.length;
    const k = url.atlas === 'last' ? n - 1 : url.atlas === 'first' ? 0 : Math.max(0, Math.min(n - 1, Number(url.atlas) || 0));
    app.setTab('atlas');
    app.emit('atlasGoto', k);
  }
  if (url.ui === 'hidden') app.emit('layout', 'hide-ui');
  app.emit('tick');
}

function parseSelect(s) {
  if (!s || !app.world) return null;
  const w = app.world;
  const [kind, rest] = s.split(':');
  const byPop = (list) => list.slice().sort((a, b) => (b.population || 0) - (a.population || 0))[0];
  if (kind === 'top') { const c = byPop(liveCivs(w)); return c ? { kind: 'civ', id: c.id } : null; }
  if (kind === 'city') { const st = byPop(liveSettlements(w)); return st ? { kind: 'settlement', id: st.id } : null; }
  if (kind === 'tile') { const [x, y] = (rest || '').split(',').map(Number); if (Number.isFinite(x) && Number.isFinite(y)) return { kind: 'tile', id: y * w.W + x, x, y }; return null; }
  if (kind === 'war') {
    const list = w.wars.filter((q) => rest === 'active' ? q.active : true);
    const war = rest === 'first' ? list[0] : list[list.length - 1];
    return war ? { kind: 'war', id: war.id } : null;
  }
  if (kind === 'army') { const a = w.armies[0]; return a ? { kind: 'army', id: a.id } : null; }
  if (kind === 'religion') { const r = w.religions.find((q) => q.alive !== false); return r ? { kind: 'religion', id: r.id } : null; }
  if (kind === 'plague') { const p = w.plagues[w.plagues.length - 1]; return p ? { kind: 'plague', id: p.id } : null; }
  const id = Number(rest);
  if (Number.isFinite(id) && ['civ', 'settlement', 'storm', 'volcano'].includes(kind)) return { kind, id };
  return null;
}

