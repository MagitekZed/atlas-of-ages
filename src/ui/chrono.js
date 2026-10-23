// The Chronoscope: rewind history, undo the hand of god, keep what-if branches.
//
// A ring of keyframes (core/keyframe.js) is kept in memory: one when a world opens (its
// origin), one every ten sim-years for the last century and one per fifty years before that,
// and one just before every act — a tool stroke, a pair or entity act, a run of changes to a
// live setting. Frames are packed in idle time: each typed field is hashed and deflated
// (CompressionStream), and a field that has not changed since an earlier frame shares its
// packed bytes, so the ring fits a memory budget (64 MB desktop, 24 MB phone; oldest
// unneeded frames go first).
//
// Undo (Ctrl/Cmd Z) restores the newest frame from before the last act and replays the
// intervention log (core/replay.js) to the present with that act skipped; redo (Ctrl/Cmd
// Shift Z) puts the act back, instantly when nothing has happened since. 'Rewind to here'
// (the Atlas, the palette, the timeline) replays to any day the ring reaches, after asking
// whether to keep the unwritten future as a branch save. Every restore ends in
// app.restoreWorld(world, { reason }), with a rewind effect and a notice.
//
// app.chrono = { beginAct, endAct, noteParam, canProtect, canUndo, canRedo, undo, redo,
//                rewindTo, openRewind, lastAct, acts, stats, selfTest }

import { Simulation } from '../core/sim.js';
import { captureKeyframe, restoreKeyframe, worldChecksum } from '../core/keyframe.js';
import { replayTo } from '../core/replay.js';
import { emitFx, yearOf } from '../core/world.js';
import { DAYS_PER_YEAR } from '../core/constants.js';
import { registerKey, registerCommand } from './registry.js';
import { h } from './dom.js';
import { showProgress, openModal, msText, rangeInput } from './widgets.js';
import { statusToast, actionToast } from './toasts.js';
import { isCompact } from './dom.js';
import { int } from './format.js';
import { saveBranch } from './saves.js';

const Y = DAYS_PER_YEAR;
const MAX_ACTS = 10;              // interventions that can be undone
const PERIOD_DAYS = 10 * Y;       // a frame every ten years…
const RECENT_DAYS = 100 * Y;      // …for the last century,
const OLD_BUCKET = 50 * Y;        // and one per fifty years before that
const PARAM_ACT_MS = 1500;        // changes to one setting within this run together as one act
const PROGRESS_DAYS = Y;          // a replay longer than this shows a progress card
const STATE_WEIGHT = 3;           // heap bytes per byte of entity JSON (budget estimate)
const REPLAY_SLICE_MS = 45;       // replay works in slices this long, yielding between them

export function mount(app) {
  const budget = () => (isCompact() ? 24 : 64) * 1e6;
  const canPack = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

  let frames = [];                // [{ id, day, ivSeq, check, tag, raw, packed, bytes }], oldest first
  let nextFrameId = 1;
  const pool = new Map();         // packed field blobs shared between frames: key → { bytes, n }
  let acts = [];                  // undo stack (oldest first): { seq0, seq1, day, label, icon, x, y, kind, id, key? }
  let redo = [];                  // [{ act, log, present, day, len }]
  let open = null;                // the act being made: { …, seq0, ok }
  let paramAct = null;            // { key, timer }
  let ivSeen = 0;                 // interventions accounted for (acts or seen by the scan)
  const refused = new Set();      // seqs of logged applies that were refused (ok: false): an undo's replay leaves those after the undone act out
  let lastPeriodic = -Infinity;
  let busy = false;               // undo / redo / rewind in flight
  let restoring = false;          // our own app.restoreWorld: keep the ring
  let packing = false;
  let failed = null;              // why the Chronoscope is off, or null
  /** busy changes are announced ('chronoBusy'), so panels can hold their controls while history is re-written */
  function setBusy(v) { if (busy === v) return; busy = v; app.emit('chronoBusy', v); }

  // ---------------------------------------------------------------------------
  // Frames

  function frameAt(w) {
    const last = frames[frames.length - 1];
    return last && last.day === w.time.day && last.ivSeq === (w.interventions || []).length ? last : null;
  }

  /**
   * Snap the world now. tag: origin | periodic | act. Synchronous: at Y1000 on a medium map about
   * 5 ms after a recent capture, about 7.5 ms ten sim-years after one, about 16 ms for the first
   * capture after a load or restore (nothing is shared yet; it runs once, as the world opens).
   * Keyframes share their copies of closed records between frames (core/keyframe.js), so kf.state
   * and everything in it is read-only: packing only stringifies it, restores go through
   * restoreKeyframe, which deep-copies again.
   */
  function capture(tag) {
    const w = app.world;
    if (!w || failed) return null;
    const have = frameAt(w);
    if (have) { if (tag === 'origin') have.tag = 'origin'; return have; }
    let kf;
    try { kf = captureKeyframe(w); } catch (e) { app.reportError('chrono.capture', e); return null; }
    let fb = 0;
    for (const a of Object.values(kf.fields)) fb += a.byteLength;
    const f = { id: nextFrameId++, day: kf.day, ivSeq: kf.ivSeq, check: kf.check, tag, raw: kf, packed: null, bytes: fb + stateEstimate };
    frames.push(f);
    schedulePack();
    return f;
  }
  let stateEstimate = 2e6;   // heap bytes of a frame's entity state, measured as frames are packed
  let packCost = 0;          // what packing the last frame cost the ring (its state, history and new field blobs), 0 until measured
  /**
   * What a frame counts against the budget. A raw frame waiting to be packed is charged what
   * packing it is expected to cost, not its passing heap size: charged raw, a late world's frame
   * (fields plus three times its state JSON) outweighs a phone's whole budget and would be
   * dropped before it is ever packed. Where frames cannot be packed they count as they are.
   */
  const charge = (f) => (f.packed || !canPack ? f.bytes : Math.min(f.bytes, packCost || f.bytes / 4));

  /** The frame an act was snapped in, if it is still held; else the newest one from before it. */
  function frameForAct(a) {
    const own = a.frameId != null ? frames.find((f) => f.id === a.frameId) : null;
    if (own && own.ivSeq <= a.seq0 && own.day <= a.day && (own.raw || own.packed)) return own;
    return frameBefore(a.seq0, a.day);
  }

  /** The newest frame from before seq (ivSeq ≤ seq) and at or before day. */
  function frameBefore(seq, day = Infinity) {
    for (let k = frames.length - 1; k >= 0; k--) {
      const f = frames[k];
      if (f.ivSeq <= seq && f.day <= day && (f.raw || f.packed)) return f;
    }
    return null;
  }

  // --- packing ---------------------------------------------------------------------------
  let packTimer = 0;
  function schedulePack() {
    if (packTimer || !canPack) { enforceBudget(); return; }
    const run = () => { packTimer = 0; packSome().catch((e) => app.reportError('chrono.pack', e)); };
    packTimer = typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 1500 }) : setTimeout(run, 400);
  }

  async function packSome() {
    if (packing || busy) { if (!busy) schedulePack(); return; }
    enforceBudget();   // thin first: a frame about to be dropped is not worth packing (raw frames count at their packed cost)
    packing = true;
    try {
      // every raw frame but the newest act frame (kept raw for a quick undo of the last act)
      const keepRaw = acts.length ? frameForAct(acts[acts.length - 1]) : null;
      for (const f of frames.slice()) {
        if (!f.raw || f === keepRaw || busy) continue;
        if (!frames.includes(f)) continue;
        await packFrame(f);
      }
    } finally { packing = false; }
    enforceBudget();
  }

  async function packFrame(f) {
    const kf = f.raw;
    const fields = [];
    let fresh = 0;
    for (const [name, a] of Object.entries(kf.fields)) {
      const [h1, h2] = hashArray(a);
      const key = `${name}|${a.constructor.name}|${a.length}|${h1}|${h2}`;
      let blob = pool.get(key);
      if (!blob) {
        const bytes = await deflate(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
        blob = pool.get(key);
        if (!blob) { blob = { key, bytes, n: 0 }; pool.set(key, blob); fresh += bytes.byteLength; }
      }
      blob.n++;
      fields.push({ name, type: a.constructor.name, length: a.length, blob });
    }
    // history arrays are shared slices; the rest of history (the ledger's series, a clone per
    // frame) is packed with the entity state rather than held as a megabyte of live objects
    const lists = {}, rest = {};
    for (const [k, v] of Object.entries(kf.history || {})) (Array.isArray(v) ? lists : rest)[k] = v;
    const json = JSON.stringify({ s: kf.state, h: rest });
    stateEstimate = json.length * STATE_WEIGHT;
    const state = await deflate(new TextEncoder().encode(json));
    if (!frames.includes(f)) { for (const q of fields) release(q.blob); return; }
    f.packed = { rng: kf.rng, keys: kf.keys, history: lists, chronicle: kf.chronicle, state, fields };
    f.raw = null;
    f.bytes = state.byteLength + historyBytes(lists, kf.chronicle);
    packCost = f.bytes + fresh;
  }
  const historyBytes = (hist, chron) => {
    let n = chron?.entries?.length || 0;
    for (const v of Object.values(hist || {})) if (Array.isArray(v)) n += v.length;
    return n * 8;
  };
  function release(blob) { if (blob && --blob.n <= 0) pool.delete(blob.key); }
  function dropFrame(f) {
    const k = frames.indexOf(f);
    if (k >= 0) frames.splice(k, 1);
    if (f.packed) for (const q of f.packed.fields) release(q.blob);
    f.raw = null; f.packed = null;
  }

  /** A frame as a keyframe object restoreKeyframe accepts (unpacking if needed). */
  async function unpack(f) {
    if (f.raw) return f.raw;
    const p = f.packed;
    if (!p) throw new Error('that moment is no longer held');
    const fields = {};
    for (const q of p.fields) {
      const bytes = await inflate(q.blob.bytes);
      const Type = globalThis[q.type];
      const a = new Type(q.length);
      new Uint8Array(a.buffer).set(bytes.subarray(0, a.byteLength));
      fields[q.name] = a;
    }
    const packed = JSON.parse(new TextDecoder().decode(await inflate(p.state)));
    return { day: f.day, ivSeq: f.ivSeq, check: f.check, rng: p.rng, keys: p.keys, fields, state: packed.s, history: { ...packed.h, ...p.history }, chronicle: p.chronicle };
  }

  function usedBytes() {
    let n = 0;
    for (const f of frames) n += charge(f);
    for (const b of pool.values()) n += b.bytes.byteLength;
    return n;
  }

  /** Thin the ring to its schedule, then drop the oldest frames nobody needs until it fits the budget. */
  function enforceBudget() {
    if (busy) return;
    const w = app.world;
    if (!w) return;
    const now = w.time.day;
    const pinned = new Set();
    for (const a of acts) { const f = frameForAct(a); if (f) pinned.add(f); }
    for (const r of redo) { const f = frameForAct(r.act); if (f) pinned.add(f); }
    if (open) { const f = frameForAct(open); if (f) pinned.add(f); }
    // schedule: one frame per ten-year bucket in the last century, one per fifty years before
    // (the newest of each bucket stays: it leaves the least history to re-live)
    const seen = new Set();
    for (const f of frames.slice().reverse()) {
      if (f.tag === 'origin' || pinned.has(f)) continue;
      const recent = now - f.day <= RECENT_DAYS;
      const bucket = (recent ? 'r' : 'o') + Math.floor(f.day / (recent ? PERIOD_DAYS : OLD_BUCKET));
      if (seen.has(bucket)) dropFrame(f); else seen.add(bucket);
    }
    // frames waiting to be packed are a passing cost; should packing fall behind, only the newest two wait
    if (canPack) {
      const waiting = frames.filter((f) => f.raw && f.tag !== 'origin' && !pinned.has(f));
      for (const f of waiting.slice(0, -2)) dropFrame(f);
    }
    let used = usedBytes();
    const cap = budget();
    if (used <= cap) return;
    // over budget, thin by the schedule rather than by age: each time drop the frame whose loss
    // leaves the narrowest gap (gaps older than a century count a fifth, as the schedule keeps
    // them five times wider), so what stays is spread like the schedule, only sparser
    const drop = (list) => {
      const cand = new Set(list);
      while (used > cap && cand.size) {
        let best = null, bestCost = Infinity;
        for (let k = 0; k < frames.length; k++) {
          const f = frames[k];
          if (!cand.has(f)) continue;
          const gap = (k + 1 < frames.length ? frames[k + 1].day : now) - (k > 0 ? frames[k - 1].day : f.day);
          const cost = now - f.day <= RECENT_DAYS ? gap : gap / (OLD_BUCKET / PERIOD_DAYS);
          if (cost < bestCost) { bestCost = cost; best = f; }
        }
        if (!best) return;
        cand.delete(best);
        dropFrame(best);
        used = usedBytes();
      }
    };
    drop(frames.filter((f) => f.tag !== 'origin' && !pinned.has(f)));
    // last resort: older act frames (undo then replays from further back)
    const keep = new Set(frames.slice(-3));
    drop(frames.filter((f) => f.tag !== 'origin' && !keep.has(f)));
  }

  // ---------------------------------------------------------------------------
  // Acts

  /** Called just before an act's first touch (input.js strokes, pair acts, divine acts). */
  function beginAct(info = {}) {
    const w = app.world;
    if (!w || busy) return;
    if (paramAct && info.kind !== 'param') closeParamAct();
    if (open) endAct();
    scan();
    const f = capture('act');
    open = { kind: info.kind || 'tool', id: info.id || '', label: info.label || 'Divine act', icon: info.icon || 'miracle', x: info.x ?? null, y: info.y ?? null, key: info.key || null, seq0: w.interventions.length, day: w.time.day, ok: info.kind === 'param', frameId: f ? f.id : null };
  }
  /** Close the act begun last: it becomes undoable if it logged anything and did something. */
  function endAct() {
    const w = app.world;
    const a = open;
    open = null;
    if (!a || !w) return;
    const seq1 = w.interventions.length;
    ivSeen = Math.max(ivSeen, seq1);
    if (seq1 <= a.seq0) return;
    // an act that came to nothing is not offered for undo, and its entries (the stroke's finish
    // too) are never replayed into a history an undo changes, where they might succeed after all
    if (!a.ok) { for (let s = a.seq0; s < seq1; s++) refused.add(s); return; }
    pushAct({ ...a, seq1 });
  }
  function pushAct(a) {
    acts.push(a);
    if (acts.length > MAX_ACTS) acts.shift();
    redo = [];
    app.emit('chrono', { what: 'act', act: a });
  }

  /** A live setting is about to change (worldtab.js): one act per run of changes to one key. */
  function noteParam(key, label) {
    if (!app.world || busy) return;
    if (paramAct && paramAct.key === key) { clearTimeout(paramAct.timer); paramAct.timer = setTimeout(closeParamAct, PARAM_ACT_MS); return; }
    if (paramAct) closeParamAct();
    beginAct({ kind: 'param', id: key, key, label: `${label} setting`, icon: 'world' });
    paramAct = { key, timer: setTimeout(closeParamAct, PARAM_ACT_MS) };
  }
  function closeParamAct() {
    if (!paramAct) return;
    clearTimeout(paramAct.timer);
    paramAct = null;
    if (open && open.kind === 'param') endAct();
  }

  /**
   * Interventions logged outside any act (another package's panel, a console call) become acts
   * of their own: one per stroke (a run of one map tool's applies on one day and its finish),
   * one per pair, entity or setting change. A stroke's finish logged just after its act closed
   * joins that act; a run that was refused throughout is not offered.
   */
  function scan() {
    const w = app.world;
    if (!w || busy) return;
    const log = w.interventions || [];
    if (open) return;
    if (ivSeen > log.length) ivSeen = log.length;
    while (ivSeen < log.length) {
      const first = log[ivSeen];
      const last = acts[acts.length - 1];
      if (first.kind === 'finish' && last && last.seq1 === ivSeen && last.id === first.id && last.day === first.day) {
        last.seq1 = ++ivSeen;
        continue;
      }
      const stroke = first.kind === 'tool' || first.kind === 'finish';
      let end = ivSeen + 1;
      if (stroke) while (end < log.length && (log[end].kind === 'tool' || log[end].kind === 'finish') && log[end].id === first.id && log[end].day === first.day && log[end - 1].kind !== 'finish') end++;
      let ok = false;
      for (let s = ivSeen; s < end && !ok; s++) ok = log[s].kind !== 'finish' && !isRefused(log[s]);
      if (!ok) for (let s = ivSeen; s < end; s++) refused.add(s);
      else {
        const label = toolLabel(first);
        pushAct({ kind: first.kind === 'finish' ? 'tool' : first.kind, id: first.id, label, icon: first.kind === 'param' ? 'world' : 'miracle', x: first.x ?? null, y: first.y ?? null, seq0: ivSeen, seq1: end, day: first.day });
      }
      ivSeen = end;
    }
  }
  /** Was this logged apply refused? (the kernel may mark it; else what toolApplied told us) */
  const isRefused = (iv) => Boolean(iv) && (iv.refused === true || refused.has(iv.seq));
  const toolLabel = (iv) => (iv.kind === 'param' ? `${iv.key} setting` : String(iv.id || 'divine act').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));

  // an act that came to nothing (refused everywhere) is not offered for undo
  app.on('toolApplied', (p) => {
    if (p?.result?.ok === false) { if (Number.isInteger(p.seq)) refused.add(p.seq); }
    else if (open) open.ok = true;
  });

  // ---------------------------------------------------------------------------
  // Restoring

  /**
   * Restore frame f and replay `log` to targetDay (skip: seqs left out). Returns the new world,
   * or null when stopped or failed. The live world stands still meanwhile.
   */
  async function rebuild(f, log, targetDay, { skip = null, title = 'Rewinding', applyFinal = true } = {}) {
    lastSim = null;
    const w = app.world;
    const kf = await unpack(f);
    const w2 = restoreKeyframe(kf, { ui: w.ui });
    const sim2 = new Simulation(w2, app.sim.systems);
    sim2.init();
    const days = Math.max(0, targetDay - w2.time.day);
    let prog = null, cancelled = false;
    if (days > PROGRESS_DAYS) {
      prog = showProgress(title, [`Re-living ${lapse(days)} of history`]);
      prog.onCancel('Stop', () => { cancelled = true; });
      await prog.stage(0);
    }
    const t0 = performance.now();
    try {
      const r = await replayTo(w2, sim2, log, targetDay, {
        skip, from: f.ivSeq, applyFinal, sliceMs: REPLAY_SLICE_MS, sliceDays: 360,
        onProgress: ({ day, frac }) => {
          if (prog) {
            prog.fraction(frac);
            prog.note(`Year ${Math.floor(day / Y)} of ${Math.floor(targetDay / Y)}`);
            const el = performance.now() - t0;
            if (el > 900 && frac > 0.02) prog.detail(`about ${msText((el / frac) * (1 - frac))} left`);
          }
          return !cancelled;
        },
      });
      if (r.cancelled || cancelled) return null;
    } finally { prog?.close(); }
    lastSim = sim2;
    return w2;
  }
  let lastSim = null;   // the simulation rebuild() woke, handed to app.restoreWorld so the systems wake only once

  async function install(w2, reason) {
    restoring = true;
    const sim = lastSim && lastSim.world === w2 ? lastSim : null;
    lastSim = null;
    try { return await app.restoreWorld(w2, { reason, sim }); } finally { restoring = false; }
  }

  function guard(what) {
    if (!app.world || !app.sim) return false;
    if (failed) { statusToast(app, `The Chronoscope is off: ${failed}`, 'warn', { icon: 'hourglass' }); return false; }
    if (busy) return false;
    if (app.fastForwarding) { statusToast(app, `History is being written at full speed; ${what} when it stops.`, 'warn', { icon: 'hourglass' }); return false; }
    return true;
  }

  /**
   * Close whatever the hand is in the middle of before history is re-written: a stroke still
   * held first (its finish then joins its own act), then a run of setting changes, then any
   * other open act; and account for anything logged outside an act.
   */
  function settle() {
    app.cancelStroke?.();
    closeParamAct();
    if (open) endAct();
    scan();
  }

  /** Bring the hand back: undo the last act. */
  async function undo() {
    if (!guard('undo')) return false;
    settle();
    const act = acts[acts.length - 1];
    if (!act) { statusToast(app, 'There is nothing of yours to undo.', 'info', { icon: 'hourglass' }); return false; }
    const w = app.world;
    const f = frameForAct(act);
    if (!f) { statusToast(app, `${act.label} lies beyond what the Chronoscope remembers.`, 'warn', { icon: 'hourglass' }); acts.pop(); return false; }
    setBusy(true);
    const wasRunning = app.running;
    app.running = false;
    const targetDay = w.time.day;
    const t0 = performance.now();
    try {
      // the act is left out, and so is every refused apply after it: in the history without the
      // act it might succeed, handing the viewer an act they were told was refused
      const skip = (iv) => iv.seq >= act.seq0 && (iv.seq < act.seq1 || isRefused(iv));
      const log = w.interventions.slice();
      const w2 = await rebuild(f, log, targetDay, { skip, title: `Undoing ${act.label}` });
      if (!w2) { statusToast(app, 'The undo was stopped; nothing changed.', 'info', { icon: 'hourglass' }); return false; }
      const present = captureKeyframe(w);
      acts.pop();
      for (const q of redo) q.present = null;   // only the newest redo keeps its instant snapshot
      redo.push({ act, log, present, day: targetDay, len: w2.interventions.length, refused: [...refused] });
      if (redo.length > MAX_ACTS) redo.shift();
      for (const q of frames.slice()) if (q.ivSeq > act.seq0) dropFrame(q);
      for (const s of [...refused]) if (s >= act.seq0) refused.delete(s);   // those seqs were not replayed
      ivSeen = w2.interventions.length;
      app.running = wasRunning;
      setBusy(false);
      if (!(await install(w2, 'undo'))) return false;
      flourish(act);
      const ms = performance.now() - t0;
      app.chrono.lastUndoMs = ms;
      actionToast(app, {
        icon: 'hourglass', kicker: 'The hand was stayed', title: `${act.label}, ${yearText(act.day)}`,
        text: targetDay > act.day ? `${since(targetDay - act.day)} lived again without it.` : 'Undone before time moved on.',
        actions: [{ label: 'Redo', run: () => redoAct() }], ms: 7000, cls: 'is-chrono',
      });
      app.emit('chrono', { what: 'undo', act });
      return true;
    } catch (e) {
      app.reportError('chrono.undo', e);
      statusToast(app, `The undo failed: ${e.message}`, 'error');
      return false;
    } finally {
      setBusy(false);
      if (!app.running && wasRunning && app.world) app.running = true;
      schedulePack();
    }
  }

  /** Put back the act undone last. */
  async function redoAct() {
    if (!guard('redo')) return false;
    settle();
    const r = redo[redo.length - 1];
    if (!r) { statusToast(app, 'There is nothing to redo.', 'info', { icon: 'hourglass' }); return false; }
    const w = app.world;
    if (w.interventions.length !== r.len) { redo = []; statusToast(app, 'History has moved on since; the undone act cannot be put back.', 'warn', { icon: 'hourglass' }); return false; }
    setBusy(true);
    const wasRunning = app.running;
    app.running = false;
    try {
      let w2;
      if (w.time.day === r.day && r.present) w2 = restoreKeyframe(r.present, { ui: w.ui });
      else {
        const f = frameForAct(r.act);
        if (!f) { redo.pop(); statusToast(app, 'That act lies beyond what the Chronoscope remembers.', 'warn', { icon: 'hourglass' }); return false; }
        w2 = await rebuild(f, r.log, w.time.day, { title: `Restoring ${r.act.label}` });
        if (!w2) { statusToast(app, 'The redo was stopped; nothing changed.', 'info', { icon: 'hourglass' }); return false; }
      }
      redo.pop();
      acts.push(r.act);
      if (acts.length > MAX_ACTS) acts.shift();
      refused.clear();
      for (const s of r.refused || []) refused.add(s);   // the log is the undone timeline's again
      ivSeen = w2.interventions.length;
      app.running = wasRunning;
      setBusy(false);
      if (!(await install(w2, 'redo'))) return false;
      if (w2.time.day === r.day) capture('periodic');
      flourish(r.act);
      statusToast(app, `${r.act.label} was done again.`, 'ok', { icon: 'hourglass' });
      app.emit('chrono', { what: 'redo', act: r.act });
      return true;
    } catch (e) {
      app.reportError('chrono.redo', e);
      statusToast(app, `The redo failed: ${e.message}`, 'error');
      return false;
    } finally {
      setBusy(false);
      if (!app.running && wasRunning && app.world) app.running = true;
      schedulePack();
    }
  }

  /** The earliest day the ring can reach. */
  const earliestDay = () => (frames.length ? frames[0].day : app.world?.time.day ?? 0);

  /**
   * Rewind to day (asks first unless opts.ask === false): the future after it is unwritten —
   * kept as a branch save if the viewer wishes. Resolves true when rewound.
   */
  async function rewindTo(day, opts = {}) {
    if (!guard('rewind')) return false;
    const w = app.world;
    day = Math.round(Number(day));
    if (!Number.isFinite(day)) return false;
    if (day >= w.time.day) { statusToast(app, 'That moment is still to come.', 'info', { icon: 'hourglass' }); return false; }
    settle();
    const f = frameBefore(Infinity, day);
    if (!f) { statusToast(app, `The Chronoscope reaches back only to ${yearText(earliestDay())}.`, 'warn', { icon: 'hourglass' }); return false; }
    let keep = false;
    if (opts.ask !== false) {
      const choice = await askRewind(day);
      if (!choice) return false;
      keep = choice === 'branch';
    }
    settle();   // the hand may have moved while the question was open
    setBusy(true);
    const wasRunning = app.running;
    app.running = false;
    try {
      if (keep) {
        try { await saveBranch(app, w, { branchDay: day }); }
        catch (e) { statusToast(app, `The branch could not be saved (${e.message}); the rewind was cancelled.`, 'error'); return false; }
      }
      const fromDay = w.time.day;
      const w2 = await rebuild(f, w.interventions.slice(), day, { title: `Rewinding to ${yearText(day)}`, applyFinal: false });
      if (!w2) { statusToast(app, 'The rewind was stopped; nothing changed.', 'info', { icon: 'hourglass' }); return false; }
      const len = w2.interventions.length;
      for (const q of frames.slice()) if (q.day > day || q.ivSeq > len) dropFrame(q);
      acts = acts.filter((a) => a.seq1 <= len);
      redo = [];
      for (const s of [...refused]) if (s >= len) refused.delete(s);
      ivSeen = len;
      setBusy(false);
      app.running = wasRunning;
      if (!(await install(w2, 'rewind'))) return false;
      app.pause();
      flourish(null);
      actionToast(app, {
        icon: 'hourglass', kicker: 'Rewound', title: yearText(day),
        text: `${cap(lapse(fromDay - day))} of history ${keep ? 'wait as a branch in Save and load' : 'were unwritten'}. Time is paused: press Space to let it run again.`,
        ms: 8000, cls: 'is-chrono',
      });
      app.emit('chrono', { what: 'rewind', day });
      return true;
    } catch (e) {
      app.reportError('chrono.rewind', e);
      statusToast(app, `The rewind failed: ${e.message}`, 'error');
      return false;
    } finally {
      setBusy(false);
      if (!app.running && wasRunning && app.world) app.running = true;
      schedulePack();
    }
  }

  function askRewind(day) {
    return new Promise((resolve) => {
      const w = app.world;
      let choice = null;
      const lost = acts.filter((a) => a.day >= day).length;
      openModal({
        title: `Rewind to ${yearText(day)}?`, small: true,
        body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('p', { text: `History after ${yearText(day)} will be unwritten: ${lapse(w.time.day - day)} of it${lost ? `, and ${lost} of your act${lost === 1 ? '' : 's'}` : ''}.` }),
          h('p.muted', { text: 'Keep it as a branch to open that future again later from Save and load.' })),
        onClose: () => resolve(choice),
        actions: [
          { label: 'Cancel', onClick: (m) => m.close() },
          { label: 'Discard it', cls: 'btn-danger', onClick: (m) => { choice = 'discard'; m.close(); } },
          { label: 'Keep as branch', cls: 'btn-brass', onClick: (m) => { choice = 'branch'; m.close(); } },
        ],
      });
    });
  }

  /** The rewind effect (a kit fx type drawn by the renderer) where the act was done, or over the view. */
  function flourish(act) {
    const w = app.world;
    if (!w) return;
    let x = act?.x, y = act?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { const c = app.renderer?.camera; x = c ? c.x - 0.5 : w.W / 2; y = c ? c.y - 0.5 : w.H / 2; }
    try { emitFx(w, { type: 'rewind', x, y, r: 6, src: 'tool' }); } catch (e) { /* transient only */ }
    document.getElementById('stage')?.classList.add('is-rewinding');
    setTimeout(() => document.getElementById('stage')?.classList.remove('is-rewinding'), 520);
  }

  const yearText = (day) => `Year ${int(Math.floor(day / Y))}`;
  /** "30 years", "a month", "12 days". */
  function lapse(days) {
    const y = Math.floor(days / Y), m = Math.floor(days / 30);
    if (y >= 1) return y === 1 ? 'a year' : `${int(y)} years`;
    if (m >= 1) return m === 1 ? 'a month' : `${m} months`;
    return days === 1 ? 'a day' : `${Math.max(0, days)} days`;
  }
  const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
  /** "The 5 years since were", "The month since was" — how much history an undo re-lived. */
  function since(days) {
    const y = Math.floor(days / Y), m = Math.floor(days / 30);
    const [n, unit] = y >= 1 ? [y, 'year'] : m >= 1 ? [m, 'month'] : [Math.max(1, days), 'day'];
    return n === 1 ? `The ${unit} since was` : `The ${int(n)} ${unit}s since were`;
  }

  /** A modal to pick a year to rewind to (the palette's and menu's "Rewind…"). */
  function openRewind(initialDay) {
    const w = app.world;
    if (!w || !guard('rewind')) return;
    const lo = Math.ceil(earliestDay() / Y), hi = Math.max(lo, yearOf(w) - 1);
    if (hi <= lo && earliestDay() >= w.time.day) { statusToast(app, 'The Chronoscope holds no earlier moment yet.', 'info', { icon: 'hourglass' }); return; }
    let year = Math.max(lo, Math.min(hi, Number.isFinite(initialDay) ? Math.floor(initialDay / Y) : hi));
    const out = h('output.rewind-year', { text: yearText(year * Y) });
    const note = h('p.muted');
    const sync = () => {
      out.textContent = yearText(year * Y);
      const f = frameBefore(Infinity, year * Y);
      note.textContent = f ? `From the moment held at ${yearText(f.day)}: ${year * Y - f.day <= 0 ? 'no history to re-live' : lapse(year * Y - f.day) + ' to re-live'}.` : '';
    };
    const slider = rangeInput({ id: 'rewind-year', min: lo, max: hi, step: 1, value: year, label: 'Year to rewind to', oninput: (v) => { year = v; sync(); } });
    sync();
    openModal({
      title: 'Rewind history', small: true,
      body: h('div.rewind-pick', null,
        h('p', { text: `Choose a year between ${yearText(lo * Y)} and ${yearText(hi * Y)}. Everything after it will be unwritten (or kept as a branch).` }),
        h('div.rewind-row', null, slider, out), note),
      actions: [
        { label: 'Cancel', onClick: (m) => m.close() },
        { label: 'Rewind…', cls: 'btn-brass', onClick: (m) => { m.close(); rewindTo(year * Y); } },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  function reset(w) {
    for (const f of frames) { f.raw = null; f.packed = null; }
    frames = []; pool.clear(); acts = []; redo = []; open = null; refused.clear();
    if (paramAct) { clearTimeout(paramAct.timer); paramAct = null; }
    ivSeen = (w?.interventions || []).length;
    lastPeriodic = w ? w.time.day : -Infinity;
    failed = null;
  }

  app.on('world', (w) => {
    if (restoring) return;
    reset(w);
    capture('origin');     // the moment the world opened: everything can go back to here
  });
  app.on('tick', () => {
    const w = app.world;
    if (!w || busy || restoring) return;
    scan();
    // a redo's instant snapshot is good only on the day it was taken: once time moves, let it go
    const top = redo[redo.length - 1];
    if (top && top.present && w.time.day !== top.day) top.present = null;
    if (w.time.day - lastPeriodic >= PERIOD_DAYS && !open) {
      lastPeriodic = w.time.day;
      const take = () => { if (app.world === w && !busy) capture('periodic'); };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(take, { timeout: 600 }); else setTimeout(take, 0);
    }
  });

  /**
   * Debugging and tests: restore a held frame (the oldest, so the replay covers as much of the
   * session as the ring reaches; opts.newest: the newest) and replay to now without skipping;
   * equal checksums mean replay is faithful.
   */
  async function selfTest(opts = {}) {
    const w = app.world;
    if (!w || busy) return null;
    const held = frames.filter((q) => q.ivSeq <= w.interventions.length && q.day <= w.time.day && (q.raw || q.packed));
    const f = opts.newest ? held[held.length - 1] : held[0];
    if (!f) return null;
    setBusy(true);
    const wasRunning = app.running;
    app.running = false;
    try {
      const w2 = await rebuild(f, w.interventions.slice(), w.time.day, { title: 'Checking the Chronoscope' });
      return { from: f.day, to: w.time.day, live: worldChecksum(w), replayed: w2 ? worldChecksum(w2) : null };
    } finally { setBusy(false); app.running = wasRunning; }
  }

  const describeAct = (a) => (a ? `${a.label} (${yearText(a.day)})` : '');
  app.chrono = {
    ready: true,
    beginAct, endAct, noteParam,
    /** Can a dangerous act be taken back? */
    canProtect: () => Boolean(app.world) && !failed,
    canUndo: () => { scan(); return acts.length > 0 && !busy; },
    canRedo: () => redo.length > 0 && !busy,
    undo, redo: redoAct, rewindTo, openRewind,
    lastAct: () => { scan(); return acts[acts.length - 1] || null; },
    acts: () => { scan(); return acts.slice(); },
    get busy() { return busy; },
    earliestDay,
    stats: () => ({ frames: frames.map((f) => ({ day: f.day, ivSeq: f.ivSeq, tag: f.tag, packed: Boolean(f.packed), bytes: f.bytes })), pool: pool.size, usedMB: usedBytes() / 1e6, rawMB: frames.reduce((n, f) => n + (f.raw ? f.bytes : 0), 0) / 1e6, budgetMB: budget() / 1e6, acts: acts.length, redo: redo.length, refused: refused.size }),
    selfTest,
    describeAct,
  };

  // --- keys and commands -------------------------------------------------------------------
  registerKey({ key: 'z', mod: true, label: 'Undo your last act', group: 'Chronoscope', run: () => undo() });
  registerKey({ key: 'z', mod: true, shift: true, label: 'Redo', group: 'Chronoscope', run: () => redoAct() });
  registerCommand({ id: 'chrono.undo', label: 'Undo', group: 'Chronoscope', icon: 'hourglass', keys: 'Ctrl Z', keywords: ['undo', 'take back', 'stay the hand'], menu: 'Chronoscope', when: (a) => Boolean(a.world), run: () => undo() });
  registerCommand({ id: 'chrono.redo', label: 'Redo', group: 'Chronoscope', icon: 'hourglass', keys: 'Ctrl Shift Z', keywords: ['redo'], when: (a) => Boolean(a.world) && redo.length > 0, run: () => redoAct() });
  registerCommand({ id: 'chrono.rewind', label: 'Rewind history…', group: 'Chronoscope', icon: 'hourglass', keywords: ['rewind', 'go back', 'past', 'branch', 'what if'], menu: 'Chronoscope', when: (a) => Boolean(a.world), run: (a, arg) => (Number.isFinite(arg) ? rewindTo(arg) : openRewind()) });
}

// --- helpers -------------------------------------------------------------------------------

/** Two 32-bit FNV-style lanes over an array's bytes (equal lanes: the same contents, for sharing packed fields). */
function hashArray(a) {
  const n4 = a.byteLength >> 2;
  const u = new Uint32Array(a.buffer, a.byteOffset, n4);
  let h1 = 0x811c9dc5 | 0, h2 = 0x9747b28c | 0;
  for (let i = 0; i < n4; i++) {
    const v = u[i];
    h1 = Math.imul(h1 ^ v, 0x01000193);
    h2 = Math.imul(h2 ^ v, 0x5bd1e995) ^ (h2 >>> 15);
  }
  const tail = new Uint8Array(a.buffer, a.byteOffset + n4 * 4, a.byteLength - n4 * 4);
  for (let i = 0; i < tail.length; i++) { h1 = Math.imul(h1 ^ tail[i], 0x01000193); h2 = Math.imul(h2 ^ tail[i], 0x5bd1e995); }
  return [(h1 >>> 0).toString(36), (h2 >>> 0).toString(36)];
}

async function deflate(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function inflate(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
