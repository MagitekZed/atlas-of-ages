// Simulation driver: runs registered systems once per simulated day, isolates their errors,
// measures their cost and paces itself against real time.
//
// system = {
//   id: string, order: number (lower runs first),
//   init?(world)      after generation and after load: seed initial state, rebuild caches
//   update(world)     once per simulated day; decide internally what to do today
// }

import { SPEEDS } from './constants.js';
import { now } from './util.js';

export class Simulation {
  constructor(world, systems = []) {
    this.world = world;
    this.systems = systems.slice().sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    this.speedIndex = 2;
    this.acc = 0;
    this.errors = {};      // systemId → { count, last }
    this.timing = {};      // systemId → total ms
    this.disabled = new Set();
    this.lastStepMs = 0;
    this.daysThisSecond = 0;
  }

  init() {
    for (const s of this.systems) {
      if (!s.init) continue;
      try { s.init(this.world); } catch (e) { this._err(s, e, 'init'); }
    }
  }

  setWorld(world) { this.world = world; this.acc = 0; this.init(); }

  /** Advance exactly one day. */
  step() {
    const w = this.world;
    const t0 = now();
    for (const s of this.systems) {
      if (this.disabled.has(s.id)) continue;
      const ts = now();
      try { s.update?.(w); } catch (e) { this._err(s, e, 'update'); }
      this.timing[s.id] = (this.timing[s.id] || 0) + (now() - ts);
    }
    w.time.day++;
    this.lastStepMs = now() - t0;
  }

  /** Advance by n days immediately (headless / fast-forward). */
  run(days) { for (let d = 0; d < days; d++) this.step(); }

  /**
   * Called each animation frame with real elapsed seconds. Runs as many days as the
   * current speed asks for, within budgetMs of wall time. Returns days simulated.
   */
  advance(dtSec, budgetMs = 12) {
    const dps = SPEEDS[this.speedIndex]?.dps ?? 0;
    if (!dps) { this.acc = 0; return 0; }
    const start = now();
    let n = 0;
    if (dps === Infinity) {
      while (now() - start < budgetMs) { this.step(); n++; }
      return n;
    }
    this.acc += dps * Math.min(dtSec, 0.25);
    while (this.acc >= 1) {
      if (now() - start >= budgetMs) { this.acc = Math.min(this.acc, dps * 0.1 + 1); break; }
      this.step(); this.acc -= 1; n++;
    }
    return n;
  }

  setSpeed(i) { this.speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, i)); this.acc = 0; }
  get paused() { return this.speedIndex === 0; }

  _err(s, e, phase) {
    const rec = (this.errors[s.id] ||= { count: 0, last: null });
    rec.count++;
    rec.last = `${phase}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`;
    if (rec.count <= 3) console.error(`[system:${s.id}] ${phase} failed`, e);
    if (rec.count === 3) console.warn(`[system:${s.id}] further errors suppressed`);
  }
}
