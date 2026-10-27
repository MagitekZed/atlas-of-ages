// God tools: ways the user reaches into the world. Systems register their own tools at
// module load; the UI builds the palette from availableTools() / getTools().
//
// def = {
//   id, label, group (TOOL_GROUPS id), icon (key the UI maps to an SVG glyph), desc,
//   order?        sort order within group
//   target        'tile' | 'area' | 'settlement' | 'civ'   (what a click means)
//                 | 'pair'    pick two things (see pick), then applyPair
//                 | 'entity'  an act on one entity from its inspector view (see entity)
//   radius        default brush radius in tiles (0 = single point)
//   minRadius?, maxRadius?
//   continuous?   true → UI re-applies while dragging (~every 80 ms of real time)
//   strength?     { label, min, max, default }   optional second slider
//   apply(world, x, y, { radius, strength }) → { ok: boolean, message?: string }
//   finish?(world)  called once when a stroke ends (e.g. recompute hydrology)
//   pick?         ['civ'|'settlement'|'tile', 'civ'|'settlement'|'tile']   pair tools: what a and b are
//   entity?       { kinds: ['civ', 'settlement', …] }                      entity tools: valid targets
//   available?(world) → bool    hidden from availableTools() when false (e.g. needs mythLevel 2)
//   hidden?       true → never shown in the palette (driven by gestures or other UI)
//   charge?       optional cost / cooldown descriptor (UI-defined)
//   polarity      'boon' | 'bane' | 'neutral' (default)   tints previews and fx
//   danger?(opts) → bool        true asks for a second click unless undo is available
//   preview?(world, x, y, opts) → { ok, reason?, text?, targets?: [{kind, id}],
//                 rings?: [{x, y, r, tone}], threads?: [{x0, y0, x1, y1, tone}],
//                 estimate?: { deaths?: [lo, hi], towns? }, severity?,
//                 cards?: [{ id, label, p, effects: [string], actions: [{id, label}] }] }
//                 Must be pure: no rng, no mutation (previewTool checks rng.state).
//   applyPair?(world, a, b, opts)       a, b = { kind, id?, x?, y? }
//   applyEntity?(world, target, args)   target = { kind, id }
// }
// Tools write their own chronicle entries (cat 'divine') for notable acts.
//
// Every apply goes through applyTool / applyPairTool / applyEntityTool / finishTool, which
// log an intervention (world.interventions; see core/world.js logIntervention) and emit the
// toolApplying hook (just before; sim/hand.js measures the moment) and the toolApplied hook. That log is what undo and rewind replay (core/replay.js). An apply the
// world refused (result ok: false) is logged with refused: true; refusals must be pure (no
// rng, no mutation), so replaying or leaving one out comes to the same thing — and an undo
// leaves out those that follow the undone act, which might succeed in the changed history.

import { TOOL_GROUPS } from './constants.js';
import { logIntervention, canLogIntervention, setParam } from './world.js';
import { emit } from './hooks.js';

export { TOOL_GROUPS };

const TOOLS = [];
const BY_ID = Object.create(null);

/** Dev switches for previewTool's purity check (tests turn throwOnImpure on). */
export const TOOL_DEV = { assertPure: true, throwOnImpure: false };

export function registerTool(def) {
  if (!def || !def.id) throw new Error('registerTool: id required');
  const t = { target: 'tile', radius: 0, order: 50, icon: def.id, polarity: 'neutral', ...def };
  const fn = t.target === 'pair' ? t.applyPair : t.target === 'entity' ? t.applyEntity : t.apply;
  if (typeof fn !== 'function') throw new Error(`registerTool(${def.id}): ${t.target === 'pair' ? 'applyPair' : t.target === 'entity' ? 'applyEntity' : 'apply'}() required`);
  if (BY_ID[def.id]) { // re-registration (hot reload) replaces
    const k = TOOLS.indexOf(BY_ID[def.id]);
    if (k >= 0) TOOLS.splice(k, 1);
  }
  TOOLS.push(t);
  BY_ID[t.id] = t;
  return t;
}

export function getTools() {
  const gi = (g) => { const k = TOOL_GROUPS.findIndex((x) => x.id === g); return k < 0 ? 99 : k; };
  return TOOLS.slice().sort((a, b) => gi(a.group) - gi(b.group) || a.order - b.order || a.label.localeCompare(b.label));
}
export const getTool = (id) => BY_ID[id] || null;

/** Tools usable in this world now (available(world) not false), in palette order. Includes hidden tools. */
export function availableTools(world) {
  return getTools().filter((t) => {
    if (typeof t.available !== 'function') return true;
    try { return Boolean(t.available(world)); } catch (e) { console.error(`[tool:${t.id}:available]`, e); return false; }
  });
}

// --- logging plumbing -------------------------------------------------------

// logMode: 'auto' (log unless replaying / nested / opts.log === false), 'force' (replay
// re-logging), 'never'.
function begin(world, logMode, opts) {
  const log = logMode === 'force' || (logMode === 'auto' && !(opts && opts.log === false) && canLogIntervention(world));
  world.cache.ivDepth = (world.cache.ivDepth | 0) + 1;
  return log;
}
function end(world) {
  world.cache.ivDepth = Math.max(0, (world.cache.ivDepth | 0) - 1);
}
/** A JSON-safe copy (logged opts must survive save/load and keyframes). */
function plain(v) {
  if (v == null) return v ?? null;
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
}
/** Logged-entry marker for an apply the world refused (replay.js leaves these out of an undo). */
const refusal = (r) => (r && r.ok === false ? { refused: true } : null);
function stripLog(opts) {
  if (!opts || typeof opts !== 'object' || !('log' in opts)) return opts;
  const o = { ...opts };
  delete o.log;
  return o;
}

/**
 * Map-tool args as the tool will see them: non-finite numbers (NaN, ±Infinity) would reach the
 * tool but log as null (JSON), which a replay reads as "use the default". radius and strength
 * fall back to the tool's defaults and other non-finite numbers are dropped, so the logged
 * opts are exactly what the tool saw.
 */
function toolArgs(t, o) {
  const args = { radius: o.radius ?? t.radius ?? 0, strength: o.strength ?? t.strength?.default ?? 1, ...o };
  for (const k of Object.keys(args)) {
    const v = args[k];
    if (typeof v !== 'number' || Number.isFinite(v)) continue;
    if (k === 'radius') args.radius = t.radius ?? 0;
    else if (k === 'strength') args.strength = t.strength?.default ?? 1;
    else delete args[k];
  }
  return args;
}

/** Kinds whose id is an index into a world array (world.civs, settlements, religions, features). */
const INDEXED = new Set(['civ', 'settlement', 'religion', 'feature']);
/** False for a target naming an index-addressed kind by anything but a whole number ('__proto__', 'length', -1…). */
function okRef(p) {
  if (!p || !INDEXED.has(p.kind)) return true;
  const n = Number(p.id);
  return Number.isInteger(n) && n >= 0 && String(n) === String(p.id);
}
const onMap = (world, x, y) => x >= 0 && y >= 0 && x < world.W && y < world.H;

// --- tile / area tools ------------------------------------------------------

/**
 * Brush ticks join their stroke's entry: a continuous tool applied again on the same day with
 * the same opts, right after its last (successful) application, adds its point to that entry's
 * pts instead of a new entry (a held brush ticks every 80 ms; the log is saved and replayed).
 * Never across a keyframe (captureKeyframe seals the log: world.cache.ivSeal), a finish, another
 * act or a refusal. merge: 'auto' (the rule above), 'no' (always a fresh entry), 'force' (join
 * the last entry: replay rebuilding an entry's pts).
 */
function stroke(world, t, last, fx, fy, snap, r, merge) {
  if (merge === 'no' || !last || last.kind !== 'tool' || last.id !== t.id || r?.ok === false) return false;
  if (merge !== 'force') {
    if (!t.continuous || last.refused || last.day !== world.time.day) return false;
    if (last.seq < (world.cache.ivSeal ?? -1)) return false;
    if (JSON.stringify(last.opts) !== JSON.stringify(snap)) return false;
  }
  (last.pts ||= []).push([fx, fy]);
  return true;
}

function applyToolImpl(world, id, x, y, opts, logMode, merge = 'auto') {
  const t = BY_ID[id];
  if (!t) return { ok: false, message: `Unknown tool “${id}”.` };
  if (typeof t.apply !== 'function') return { ok: false, message: `The ${t.label} is not a map tool.` };
  if (!onMap(world, x, y)) return { ok: false, message: 'That spot is off the edge of the world.' };
  const fx = Math.floor(x), fy = Math.floor(y);
  const o = stripLog(opts) || {};
  const args = toolArgs(t, o);
  const snap = plain(args);   // taken before the apply, so a tool that edits its opts replays alike
  const log = begin(world, logMode, opts);
  emit(world, 'toolApplying', { kind: 'tool', id, x: fx, y: fy, opts: snap });   // (sim/hand.js measures the moment before)
  let r;
  try {
    r = t.apply(world, fx, fy, args) || { ok: true };
  } catch (e) {
    console.error(`[tool:${id}]`, e);
    r = { ok: false, message: `The ${t.label} tool failed: ${e.message}` };
  } finally { end(world); }
  let iv = null;
  if (log) {
    const list = world.interventions;
    const last = list && list.length ? list[list.length - 1] : null;
    iv = stroke(world, t, last, fx, fy, snap, r, merge) ? last : logIntervention(world, { kind: 'tool', id, x: fx, y: fy, opts: snap, ...refusal(r) }, true);
  }
  emit(world, 'toolApplied', { kind: 'tool', id, x: fx, y: fy, opts: plain(snap), result: plain(r), seq: iv ? iv.seq : null });
  return r;
}

/** Apply a map tool at (x, y). opts: { radius, strength, log? } (log: false skips the log). */
export function applyTool(world, id, x, y, opts = {}) {
  return applyToolImpl(world, id, x, y, opts, 'auto');
}

function finishToolImpl(world, id, logMode, opts) {
  const t = BY_ID[id];
  if (!t || !t.finish) return;
  const log = begin(world, logMode, opts);
  try { t.finish(world); } catch (e) { console.error(`[tool:${id}:finish]`, e); } finally { end(world); }
  if (log) logIntervention(world, { kind: 'finish', id }, true);
  emit(world, 'toolFinished', { id });   // (sim/hand.js: a held stroke is one act until here)
}

/** End a stroke of a continuous tool (runs def.finish once). opts: { log? }. */
export function finishTool(world, id, opts = {}) {
  finishToolImpl(world, id, 'auto', opts);
}

// --- pair and entity tools --------------------------------------------------

const pickPoint = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null);

function applyPairImpl(world, id, a, b, opts, logMode) {
  const t = BY_ID[id];
  if (!t) return { ok: false, message: `Unknown tool “${id}”.` };
  if (typeof t.applyPair !== 'function') return { ok: false, message: `The ${t.label} does not join two things.` };
  if (!okRef(a) || !okRef(b)) return { ok: false, message: `The ${t.label} cannot touch that.` };
  const o = stripLog(opts) || {};
  const snap = { a: plain(a), b: plain(b), opts: plain(o) };
  const log = begin(world, logMode, opts);
  emit(world, 'toolApplying', { kind: 'pair', id, a: snap.a, b: snap.b, opts: snap.opts });
  let r;
  try {
    r = t.applyPair(world, a, b, o) || { ok: true };
  } catch (e) {
    console.error(`[tool:${id}:pair]`, e);
    r = { ok: false, message: `The ${t.label} failed: ${e.message}` };
  } finally { end(world); }
  const iv = log ? logIntervention(world, { kind: 'pair', id, ...snap, ...refusal(r) }, true) : null;
  const pt = pickPoint(snap.b) || pickPoint(snap.a);
  emit(world, 'toolApplied', { kind: 'pair', id, x: pt ? pt.x : null, y: pt ? pt.y : null, opts: plain({ ...snap.opts, a: snap.a, b: snap.b }), result: plain(r), seq: iv ? iv.seq : null });
  return r;
}

/** Apply a pair tool to a and b ({ kind: 'civ'|'settlement'|'tile', id?, x?, y? }). opts: { log?, … }. */
export function applyPairTool(world, id, a, b, opts = {}) {
  return applyPairImpl(world, id, a, b, opts, 'auto');
}

function applyEntityImpl(world, id, target, args, logMode) {
  const t = BY_ID[id];
  if (!t) return { ok: false, message: `Unknown tool “${id}”.` };
  if (typeof t.applyEntity !== 'function') return { ok: false, message: `The ${t.label} is not an act on one thing.` };
  const kinds = t.entity?.kinds;
  if (Array.isArray(kinds) && kinds.length && !kinds.includes(target?.kind)) return { ok: false, message: `The ${t.label} cannot touch that.` };
  if (!okRef(target)) return { ok: false, message: `The ${t.label} cannot touch that.` };
  const a = stripLog(args) || {};
  const snap = { target: plain(target), args: plain(a) };
  const log = begin(world, logMode, args);
  emit(world, 'toolApplying', { kind: 'entity', id, target: snap.target, opts: snap.args });
  let r;
  try {
    r = t.applyEntity(world, target, a) || { ok: true };
  } catch (e) {
    console.error(`[tool:${id}:entity]`, e);
    r = { ok: false, message: `The ${t.label} failed: ${e.message}` };
  } finally { end(world); }
  const iv = log ? logIntervention(world, { kind: 'entity', id, ...snap, ...refusal(r) }, true) : null;
  const ent = target?.kind === 'civ' ? world.civs[target.id] : target?.kind === 'settlement' ? world.settlements[target.id] : null;
  const px = ent ? (target.kind === 'civ' ? world.settlements[ent.capitalId]?.x ?? ent.originX : ent.x) : null;
  const py = ent ? (target.kind === 'civ' ? world.settlements[ent.capitalId]?.y ?? ent.originY : ent.y) : null;
  emit(world, 'toolApplied', { kind: 'entity', id, x: px ?? null, y: py ?? null, opts: plain({ ...snap.args, target: snap.target }), result: plain(r), seq: iv ? iv.seq : null });
  return r;
}

/** Apply an entity tool (divine act) to target = { kind, id } with args. args: { log?, … }. */
export function applyEntityTool(world, id, target, args = {}) {
  return applyEntityImpl(world, id, target, args, 'auto');
}

// --- previews ---------------------------------------------------------------

/**
 * Ask a tool what it would do at (x, y) without doing it. Returns the tool's preview result,
 * or null when the tool has none. Errors become { ok: false, reason }. Previews must not draw
 * rng: the state is checked and, if a preview drew, restored (and reported; TOOL_DEV.throwOnImpure
 * turns that into an exception for tests).
 */
export function previewTool(world, id, x, y, opts = {}) {
  const t = BY_ID[id];
  if (!t || typeof t.preview !== 'function') return null;
  // a map tool's preview off the map (or at NaN) answers as its apply would
  const mapTool = t.target !== 'pair' && t.target !== 'entity';
  if (mapTool && !onMap(world, x, y)) return { ok: false, reason: 'That spot is off the edge of the world.' };
  if (!mapTool && opts && opts.target && !okRef(opts.target)) return { ok: false, reason: `The ${t.label} cannot touch that.` };
  const o = mapTool ? toolArgs(t, opts || {}) : { radius: opts.radius ?? t.radius ?? 0, strength: opts.strength ?? t.strength?.default ?? 1, ...opts };
  const rng = world.rng;
  const s0 = TOOL_DEV.assertPure && rng ? rng.state.slice() : null;
  let r;
  try {
    r = t.preview(world, Number.isFinite(x) ? Math.floor(x) : x, Number.isFinite(y) ? Math.floor(y) : y, o) || null;
  } catch (e) {
    console.error(`[tool:${id}:preview]`, e);
    r = { ok: false, reason: e.message };
  }
  if (s0) {
    const s1 = rng.state;
    if (s1[0] !== s0[0] || s1[1] !== s0[1] || s1[2] !== s0[2] || s1[3] !== s0[3]) {
      rng.state = s0;
      const msg = `[tool:${id}:preview] drew from world.rng — previews must be pure (state restored)`;
      if (TOOL_DEV.throwOnImpure) throw new Error(msg);
      console.error(msg);
    }
  }
  return r;
}

// --- replay -----------------------------------------------------------------

/**
 * Apply one logged intervention again (core/replay.js). relog: append it to world.interventions
 * even while world.cache.replaying is set (the default). Returns the apply result.
 */
export function applyIntervention(world, iv, { relog = true } = {}) {
  const mode = relog ? 'force' : 'never';
  switch (iv.kind) {
    case 'tool': {
      // one entry, as logged: its first point, then the stroke's further points (pts) in order
      const r = applyToolImpl(world, iv.id, iv.x, iv.y, iv.opts || {}, mode, 'no');
      if (Array.isArray(iv.pts)) for (const p of iv.pts) if (Array.isArray(p)) applyToolImpl(world, iv.id, p[0], p[1], iv.opts || {}, mode, 'force');
      return r;
    }
    case 'finish': finishToolImpl(world, iv.id, mode, null); return { ok: true };
    case 'pair': return applyPairImpl(world, iv.id, iv.a, iv.b, iv.opts || {}, mode);
    case 'entity': return applyEntityImpl(world, iv.id, iv.target, iv.args || {}, mode);
    case 'param': {
      setParam(world, iv.key, iv.value, { force: true });
      if (relog) logIntervention(world, { kind: 'param', id: iv.key, key: iv.key, value: world.params[iv.key], ...(iv.force ? { force: true } : {}) }, true);
      return { ok: true };
    }
    default:
      console.warn(`[replay] unknown intervention kind "${iv.kind}"`);
      return { ok: false };
  }
}
