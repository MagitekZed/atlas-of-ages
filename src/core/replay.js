// Replay: run a restored world forward through the intervention log, re-applying each logged
// act before the sim step of the day it was made — exactly what happened the first time, so
// the result is identical (or, with acts skipped, the history that would have been: undo).
//
//   const w2 = restoreKeyframe(kf, { ui: world.ui });  sim.setWorld(w2);
//   await replayTo(w2, sim, world.interventions, world.time.day, { skip: [seqToUndo] });
//
// While replaying, world.cache.replaying is true: UI hook subscribers ignore what they hear,
// and nothing new is logged except the replayed acts themselves (re-logged with fresh seqs).
// With acts skipped, refused entries (refused: true) logged after the first skipped one are
// skipped as well (see afterSkip).

import { applyIntervention } from './tools.js';
import { now } from './util.js';

/** Normalise skip (seq | [seq] | Set | (iv) => bool | null) into a predicate. */
function skipper(skip) {
  if (skip == null) return () => false;
  if (typeof skip === 'function') return skip;
  if (typeof skip === 'number') return (iv) => iv.seq === skip;
  const set = skip instanceof Set ? skip : new Set(Array.isArray(skip) ? skip : [skip]);
  return (iv) => set.has(iv.seq);
}

/**
 * Wrap a skip predicate so that, once an entry has been skipped (an undo), the refused applies
 * after it are skipped too: the player was told those came to nothing, and in the history
 * without the undone act they might now succeed — an act nobody chose, which nothing could undo.
 * Entries reach the predicate in seq order (replayTo walks the log in order).
 */
function afterSkip(base) {
  let skipped = false;
  return (iv) => {
    if (base(iv)) { skipped = true; return true; }
    return skipped && iv.refused === true;
  };
}

function applyDue(world, list, skip) {
  const isSkipped = skipper(skip);
  const day = world.time.day;
  const due = list.filter((iv) => iv && iv.day === day).sort((a, b) => a.seq - b.seq);
  for (const iv of due) if (!isSkipped(iv)) applyIntervention(world, iv, { relog: true });
  return due.length;
}

/**
 * Apply the entries of `log` whose day equals today (in seq order, except those skipped),
 * through the kernel apply calls (re-logging them), then run one sim step.
 * log: the pending interventions — those not already contained in the world.
 */
export function replayStep(world, sim, log, skip = null) {
  if (sim.world !== world) throw new Error('replayStep: sim is not running this world (call sim.setWorld(world) first)');
  const prev = world.cache.replaying;
  world.cache.replaying = true;
  try {
    applyDue(world, log || [], skip);
    sim.step();
  } finally {
    world.cache.replaying = prev || false;
  }
}

/**
 * Replay from the world's current day up to targetDay (async, in slices so a UI stays live).
 * log: the full intervention log of the timeline being replayed; entries with
 *      seq < opts.from (default world.interventions.length: what the restored world already
 *      contains) are ignored.
 * opts: { skip, from, onProgress({ day, fromDay, toDay, frac }) → false cancels,
 *         sliceDays (max days per slice, default 30), sliceMs (default 14),
 *         applyFinal (default true: also apply the acts logged on targetDay itself, which came
 *         after that day's last step) , signal ({ aborted }) }
 * Returns { days, cancelled, ms }.
 */
export async function replayTo(world, sim, log, targetDay, opts = {}) {
  const from = Number.isFinite(opts.from) ? opts.from : (world.interventions || []).length;
  const pending = (log || []).filter((iv) => iv && iv.seq >= from).sort((a, b) => a.seq - b.seq);
  const skip = afterSkip(skipper(opts.skip));
  const sliceDays = Math.max(1, opts.sliceDays ?? 30);
  const sliceMs = Math.max(1, opts.sliceMs ?? 14);
  const fromDay = world.time.day;
  const t0 = now();
  let cur = 0, days = 0, cancelled = false;
  // entries dated before the start day cannot be replayed faithfully: report and drop them
  while (cur < pending.length && pending[cur].day < fromDay) {
    console.warn(`[replay] intervention #${pending[cur].seq} (day ${pending[cur].day}) predates the keyframe (day ${fromDay}); dropped`);
    cur++;
  }
  const takeToday = () => {
    const day = world.time.day, out = [];
    while (cur < pending.length && pending[cur].day <= day) { if (pending[cur].day === day) out.push(pending[cur]); cur++; }
    return out;
  };
  while (world.time.day < targetDay) {
    const ts = now();
    for (let n = 0; n < sliceDays && world.time.day < targetDay; n++) {
      replayStep(world, sim, takeToday(), skip);
      days++;
      if (now() - ts > sliceMs) break;
    }
    const frac = targetDay > fromDay ? (world.time.day - fromDay) / (targetDay - fromDay) : 1;
    if (opts.onProgress && opts.onProgress({ day: world.time.day, fromDay, toDay: targetDay, frac }) === false) { cancelled = true; break; }
    if (opts.signal && opts.signal.aborted) { cancelled = true; break; }
    if (world.time.day < targetDay) await new Promise((r) => setTimeout(r, 0));
  }
  if (!cancelled && opts.applyFinal !== false && world.time.day === targetDay) {
    const prev = world.cache.replaying;
    world.cache.replaying = true;
    try { applyDue(world, takeToday(), skip); } finally { world.cache.replaying = prev || false; }
  }
  return { days, cancelled, ms: now() - t0 };
}
