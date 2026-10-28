// Town memory (chunk 3, docs/design/why-wars.md): what a town remembers of the realms that
// sacked it, saved it, besieged it, freed it or gave it away.
//
//   s.mem = [[civId, v, why, day] …]   at most CAP, the strongest
//     v    −1..+1 when last renewed: a grudge below 0, gratitude above
//     why  k sacked · z a neighbour razed · h held out against a siege · r relieved · f freed by
//          its old realm · c ceded away by its own crown · g opened its gates
//     day  when it was last renewed
//
// The live value is v · exp(−years / tau), tau from the ext 'memoryRule' (first; Mythic peoples
// answer for their own), 40 years for a grudge and 25 for gratitude by default. A new memory of a
// realm merges with the old one. war.js writes the memories (captures, razings, reliefs, the
// cessions of a peace) and asks them in the siege tick: a town holds out against a realm it hates,
// and may open its gates to one it remembers kindly when it is cold to its own crown. This module
// answers the ext 'loyalty' (a town's memory of its own crown) and 'revoltTo' (the realm a rising
// town goes over to), and remembers the long sieges it saw end. No rng is drawn here.
//
// Exports: remember, memoryOf, memoriesOf, MEM_WHY, MEM_DAYS

import { chronicle } from '../../core/chronicle.js';
import { on } from '../../core/hooks.js';
import { registerProvider, firstOf, hasProviders } from '../../core/ext.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { clamp } from '../../core/util.js';
import { civName, capFirst, hashPick, rateOk, finite } from './common.js';

const CAP = 4;
const MIN = 0.03;           // a memory fainter than this is forgotten
const LOYAL_K = 0.25;       // loyalty from a town's memory of its own crown
const DEF = { grudge: 40, thanks: 25 };

export const MEM_WHY = { k: 'sacked by', z: 'saw its neighbours razed by', h: 'held out against', r: 'saved by', f: 'freed by', c: 'ceded away by', g: 'opened its gates to', s: 'surrendered to' };
/** Sieges a town holds out this long are remembered (days). */
export const MEM_DAYS = 180;

function rule(world, s) {
  if (!hasProviders('memoryRule')) return DEF;
  const r = firstOf('memoryRule', world, s);
  return r && finite(r.grudge) && r.grudge > 0 && finite(r.thanks) && r.thanks > 0 ? r : DEF;
}

function live(m, day, R) {
  const tau = (m[1] < 0 ? R.grudge : R.thanks) * DAYS_PER_YEAR;
  return m[1] * Math.exp(-(day - m[3]) / tau);
}

/** Town s's memory of realm civId now (−1..1; 0 when none). */
export function memoryOf(world, s, civId) {
  const mem = s && s.mem;
  if (!mem || !mem.length) return 0;
  for (const m of mem) if (m[0] === civId) return live(m, world.time.day, rule(world, s));
  return 0;
}

/** Everything s remembers, strongest first: [{ civId, v, why, day }] (the town dossier). */
export function memoriesOf(world, s) {
  const mem = s && s.mem;
  if (!mem || !mem.length) return [];
  const day = world.time.day, R = rule(world, s);
  const out = [];
  for (const m of mem) { const v = live(m, day, R); if (Math.abs(v) >= MIN) out.push({ civId: m[0], v, why: m[2], day: m[3] }); }
  return out.sort((p, q) => Math.abs(q.v) - Math.abs(p.v) || p.civId - q.civId);
}

const round3 = (v) => Math.round(v * 1000) / 1000;

/** s remembers realm civId: v (−1..1) for reason why. Merges with what it already holds. */
export function remember(world, s, civId, v, why) {
  if (!s || !s.alive || civId == null || civId < 0 || !(Math.abs(v) > 0)) return;
  const day = world.time.day, R = rule(world, s);
  const mem = s.mem || (s.mem = []);
  let k = -1;
  for (let j = 0; j < mem.length; j++) if (mem[j][0] === civId) { k = j; break; }
  if (k >= 0) {
    const old = live(mem[k], day, R);
    const nv = clamp(old + v, -1, 1);
    mem[k] = [civId, round3(nv), Math.abs(v) >= Math.abs(old) ? why : mem[k][2], day];
  } else mem.push([civId, round3(clamp(v, -1, 1)), why, day]);
  // keep the strongest, forget the faint
  for (let j = mem.length - 1; j >= 0; j--) if (Math.abs(live(mem[j], day, R)) < MIN) mem.splice(j, 1);
  if (mem.length > CAP) {
    mem.sort((p, q) => Math.abs(live(q, day, R)) - Math.abs(live(p, day, R)) || p[0] - q[0]);
    mem.length = CAP;
  }
}

// ---------------------------------------------------------------------------
// What memory does elsewhere

// a town's loyalty moves with its memory of its own crown (the civ module's loyalty target)
registerProvider('loyalty', 'geo.memory', (world, s, civ) => {
  if (!s || !civ || !s.mem || !s.mem.length) return 0;
  return LOYAL_K * memoryOf(world, s, civ.id);
});

// a rising town goes over to the realm it remembers best (≥ +0.3), before the one that founded it
registerProvider('revoltTo', 'geo.memory', (world, s, civ) => {
  if (!s || !s.mem || !s.mem.length) return null;
  let best = null, bv = 0.3;
  for (const m of memoriesOf(world, s)) {
    if (m.civId === s.civId || m.v < bv) continue;
    const c = world.civs[m.civId];
    if (c && c.alive && (!civ || c.id !== civ.id)) { best = c.id; bv = m.v; }
  }
  return best;
});

// a long siege the town saw end without falling: a grudge against the besieger, and a line when
// an old grudge kept it fighting
on('siegeEnded', (world, e) => {
  if (!e || (e.outcome !== 'lifted' && e.outcome !== 'broken') || !(e.days >= MEM_DAYS)) return;
  const s = world.settlements[e.sid];
  if (!s || !s.alive || s.civId === e.civId) return;
  const before = memoryOf(world, s, e.civId);
  const old = (s.mem || []).find((q) => q[0] === e.civId);
  const Y = old ? Math.floor(old[3] / DAYS_PER_YEAR) : null;
  remember(world, s, e.civId, -0.2, 'h');
  if (before > -0.3 || e.days < DAYS_PER_YEAR) return;
  if (!rateOk(world, `memHeld:${s.civId}`, 10 * DAYS_PER_YEAR)) return;
  const foe = world.civs[e.civId];
  chronicle(world, {
    cat: 'war', imp: 2, x: s.x, y: s.y, civId: s.civId, sid: s.id, icon: 'walls', key: 'town.held', ref: { k: 'settlement', id: s.id }, tags: ['memory'],
    text: hashPick([
      `${capFirst(s.name)} remembered what ${civName(foe)} had done to it${Y != null ? ` in Year ${Y}` : ''}, and held out until the besiegers gave up.`,
      `The people of ${s.name} would not open their gates to ${civName(foe)}, whom they had good cause to hate; the siege was given up.`,
    ], s.id, e.civId, e.days),
  });
});
