// The magical trades (Mythic; docs/design/people-in-numbers.md, phase 3): four rare trades after
// a town's eleven (sim/civ/jobs.js, ext 'magicJobs'), each a fraction of a percent of its working
// hands and never more than CAP, all thinned by the weave as the Fading closes.
//
//   mages          0.4 % × mana here (≤ 1) × arts known (÷ 4, ≤ 1.5) × (1 + ½ × mage-tower level)
//   healers        0.3 % × mana here, × 1.5 where hearth-craft or the sylvan arts are known
//   artificers     0.2 % × mana here × (mine + guildhall levels), where runecraft or wizardry is known
//   beast-keepers  0.1 %, where great beasts range within BEAST_R or the realm has bound one
//
// Each people leans toward its own arts (LEAN, weighted by the town's mix). What they do, at CAP
// (f = workers / (CAP × hands), up to 1):
//   mages          the town's drain on mana (mana.js) follows them; arcane research of the realm
//                  up to +10 % (ext researchMul, the realm's mages over its hands)
//   healers        health up to +0.04 (ext townHealth); plague deaths down to × 0.9 (ext damage)
//   artificers     production up to +3 %, the walls' defence up to +5 % (ext townOutput)
//   beast-keepers  the odds of binding a beast near the town up to +15 % (ext taming)
// Every provider is neutral below mythLevel 2. Pure: no world.rng.

import { registerProvider } from '../../core/ext.js';
import { bandsNear } from '../../core/bands.js';
import { BAND_KINDS } from '../../core/constants.js';
import { isMythic, fin } from './races.js';
import { manaAt, arcaneKnown, isArcaneTech } from './mana.js';
import { knowsSchool } from './arcana.js';

export const M = { mage: 0, healer: 1, artificer: 2, keeper: 3 };
/** The trades' slots in s.jobs, after the eleven (as sim/civ/jobs.js J_MAGIC, NMAGIC; the myth module does not import the civ module). */
const J_MAGIC = 11, NMAGIC = 4;
const CAP = 0.015;
const BASE = [0.004, 0.003, 0.002, 0.001];
const BEAST_R = 15;
/** Each people's lean toward the four trades (× on its share of the town). */
const LEAN = {
  human: [1.2, 1, 1, 1], elf: [1.5, 2, 1, 1], dwarf: [1, 1, 2.5, 1],
  orc: [1.3, 1, 1, 2], halfling: [1, 2, 1, 1], lizardfolk: [1.3, 1, 1, 1.5],
};

const OUT = new Float64Array(NMAGIC);
const weaveOf = (world) => Math.max(0, Math.min(1, fin(world.sys.myth?.weave, 1)));

/** Do great beasts range near town s this year? (cached per town per year: bands move slowly) */
function beastsNear(world, s) {
  const c = (world.cache.mtBeasts ||= { y: -1, m: new Map() });
  const y = Math.floor(world.time.day / 360);
  if (c.y !== y) { c.y = y; c.m.clear(); }
  let v = c.m.get(s.id);
  if (v === undefined) {
    v = bandsNear(world, s.x, s.y, BEAST_R, (b) => BAND_KINDS[b.kind]?.family === 'beast').length > 0;
    c.m.set(s.id, v);
  }
  return v;
}

/** The four trades' shares of town s's working hands (ext 'magicJobs'). */
function magicJobs(world, s, civ) {
  if (!isMythic(world) || !s || !civ) return null;
  const mana = Math.max(0, Math.min(1, manaAt(world, s.x, s.y)));
  const weave = weaveOf(world);
  const lean = [0, 0, 0, 0];
  let tot = 0;
  for (const r in s.peoples || {}) {
    const L = LEAN[r], sh = s.peoples[r];
    if (!L || !(sh > 0)) continue;
    for (let i = 0; i < NMAGIC; i++) lean[i] += sh * L[i];
    tot += sh;
  }
  for (let i = 0; i < NMAGIC; i++) lean[i] = tot > 0 ? lean[i] / tot : 1;
  const b = s.buildings || {};
  const arts = arcaneKnown(civ);
  OUT[M.mage] = arts > 0 ? BASE[0] * mana * Math.min(1.5, arts / 4) * (1 + 0.5 * fin(b.magetower)) : 0;
  OUT[M.healer] = BASE[1] * mana * (knowsSchool(civ, 'hearth') || knowsSchool(civ, 'sylvan') ? 1.5 : 1);
  OUT[M.artificer] = knowsSchool(civ, 'runecraft') || knowsSchool(civ, 'wizardry') ? BASE[2] * mana * (fin(b.mine) + fin(b.workshop)) : 0;
  OUT[M.keeper] = (civ.flags && civ.flags.tamedAny) || beastsNear(world, s) ? BASE[3] : 0;
  for (let i = 0; i < NMAGIC; i++) OUT[i] = Math.min(CAP, OUT[i] * lean[i] * weave);
  return OUT;
}

/** f for trade i in town s: its workers over CAP of the town's hands, up to 1 (0 without them). */
function capF(s, i) {
  const j = s.jobs;
  if (!j || j.length < J_MAGIC + NMAGIC) return 0;
  let W = 0;
  for (let t = 0; t < j.length; t++) W += j[t];
  return W > 0 ? Math.min(1, j[J_MAGIC + i] / (CAP * W)) : 0;
}

registerProvider('magicJobs', 'myth', magicJobs);
registerProvider('townHealth', 'myth', (world, s) => (isMythic(world) && s ? 0.04 * capF(s, M.healer) : 0));
registerProvider('townOutput', 'myth', (world, s) => {
  if (!isMythic(world) || !s) return null;
  const f = capF(s, M.artificer);
  return f > 0 ? { production: 1 + 0.03 * f, defense: 1 + 0.05 * f } : null;
});
registerProvider('damage', 'myth-trades', (world, s, cause) => (isMythic(world) && s && cause === 'plague' ? 1 - 0.1 * capF(s, M.healer) : 1));
registerProvider('taming', 'myth', (world, civ, s) => (isMythic(world) && s ? 1 + 0.15 * capF(s, M.keeper) : 1));
registerProvider('researchMul', 'myth', (world, civ, techId) => {
  if (!isMythic(world) || !civ || !techId || !isArcaneTech(techId)) return 1;
  // the realm's mages over its hands, against CAP
  let mg = 0, W = 0;
  for (const id of civ.settlementIds || []) {
    const s = world.settlements[id];
    const j = s && s.alive ? s.jobs : null;
    if (!j || j.length < J_MAGIC + NMAGIC) continue;
    for (let t = 0; t < j.length; t++) W += j[t];
    mg += j[J_MAGIC + M.mage];
  }
  return W > 0 ? 1 + 0.1 * Math.min(1, mg / (CAP * W)) : 1;
});
