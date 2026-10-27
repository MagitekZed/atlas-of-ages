// Knowledge that travels (chunk 5, docs/design/inventions.md): how realms come by what they know,
// beside research and the discounts of trade and borders (tech.js).
//
//   HOW codes in civ.tech.from[techId] ('h' or 'h:civId'):
//     r own research (not stored)  t trade or alliance  b a border or contact  c towns taken from
//     the teacher  a the arms race  s a foreign scholar  f refugees  u a ruin  d the gods
//     i inherited (a split, a restored crown)  g given at birth (a new people, a start age)
//
//   Channels kept here:
//     conquest   a town taken from another realm (conquest, treaty, annexation, defection) teaches
//                its new masters for a century: s.flags.tb = [oldCivId, day], summed per realm by
//                civmonth.js into civ.flags.taught and read by tech.js effectiveCost
//     arms race  a realm beaten in a named battle by better-armed foes gains 15 % toward the foe's
//                next military invention (hook outgunned, from geo/war.js); once in 5 years
//     scholars   a great scholar may go abroad (yearly: 0.6 %, more in a dark age, at war, under a
//                cruel or mad ruler) to a contact with a university, a learned ruler or a golden
//                age, giving it 40 % toward two inventions of the homeland
//     refugees   when a realm falls, its learned flee to its friendliest neighbour: 30 % toward two
//                inventions it did not know
//   Crossings: the Chronicle tells when an invention first reaches a land mass, and in a Mythic
//   world a people, it had not reached (sys.civ.reach[techId] = [landmass ids, 'r:race' …],
//   filled lazily from the realms that know it in an older save).
//
// Exports: HOW, fromOf, knowledgeYearly

import { on } from '../../core/hooks.js';
import { DAYS_PER_YEAR as DPY, RACE_META } from '../../core/constants.js';
import { TECH_BY_ID, techDef, hasTech, headStart, isArcane, allTechs, refreshMods } from './tech.js';
import { fin, record, rateOk, KNOW_VERSION } from './state.js';
import { theName, TheName, pick } from './prose.js';

export const HOW = { r: 'research', t: 'trade', b: 'a neighbour', c: 'conquest', a: 'the arms race', s: 'a scholar', f: 'refugees', u: 'a ruin', d: 'the gods', i: 'inheritance', g: 'its founding' };

/** How civ came by tech id: [code, teacher civ id | null] (own research when unrecorded). */
export function fromOf(civ, id) {
  const f = civ && civ.tech && civ.tech.from && civ.tech.from[id];
  if (!f) return ['r', null];
  const [h, t] = String(f).split(':');
  return [h, t != null && t !== '' ? +t : null];
}

const TEACH = new Set(['conquest', 'reconquest', 'treaty', 'annexation', 'defection']);

// a town taken by force or treaty teaches its new masters what its old ones knew
on('settlementTransferred', (world, s, oldId, newId, cause) => {
  if (!s || !s.flags || !TEACH.has(cause) || oldId == null || !world.civs[oldId]) return;
  s.flags.tb = [oldId, world.time.day];
});

// ---------------------------------------------------------------------------
// The arms race

/** A realm beaten by better-armed foes takes up their arms: 15 % toward the foe's cheapest military invention it can study. */
on('outgunned', (world, loser, winner) => {
  if (!loser || !winner || !loser.alive || !loser.tech || !winner.tech) return;
  const fl = (loser.flags ||= {});
  if (world.time.day - fin(fl.armsDay, -1e9) < 5 * DPY) return;
  let best = null;
  for (const id in winner.tech.known) {
    const t = TECH_BY_ID[id];
    if (!t || t.cat !== 'military' || isArcane(t) || hasTech(loser, id) || !t.prereqs.every((p) => hasTech(loser, p))) continue;
    if (!best || t.cost < best.cost || (t.cost === best.cost && t.id < best.id)) best = t;
  }
  if (best && headStart(loser, best.id, 0.15, `a:${winner.id}`)) fl.armsDay = world.time.day;
});

// ---------------------------------------------------------------------------
// Scholars abroad, refugees from a fallen realm

/** Up to n inventions `from` knows that `to` can study now, oldest first. */
function teachable(from, to, n) {
  const out = [];
  for (const t of allTechs()) {
    if (out.length >= n) break;
    if (isArcane(t) || !hasTech(from, t.id) || hasTech(to, t.id) || !t.prereqs.every((p) => hasTech(to, p))) continue;
    out.push(t.id);
  }
  return out;
}

/** How strongly a realm draws scholars: a university, a learned ruler, a golden age. */
function draw(world, c) {
  let w = 1;
  for (const sid of c.settlementIds) { const s = world.settlements[sid]; if (s && fin(s.buildings?.university) > 0) { w += 1; break; } }
  if (c.ruler && Array.isArray(c.ruler.sk) && c.ruler.sk[4] >= 0.6) w += 0.5;
  if (fin(c.goldenAge) > 0) w += 0.5;
  return w;
}

function scholarsAbroad(world) {
  for (const civ of world.civs) {
    if (!civ || !civ.alive || !civ.flags || !Array.isArray(civ.flags.figs) || !civ.flags.figs.length) continue;
    let push = 1;
    if (fin(civ.darkAge) > 0) push *= 4;
    if (civ.ruler && (civ.ruler.traits || []).some((t) => t === 'cruel' || t === 'mad')) push *= 2;
    if (fin(civ.warWeariness) > 0.5) push *= 1.5;
    for (const fid of civ.flags.figs.slice()) {
      const f = world.figures.find((o) => o.id === fid);
      if (!f || f.kind !== 'scholar' || f.died != null || f.civId !== civ.id) continue;
      if (!world.rng.chance(0.006 * push)) continue;
      // where to: a contact that draws scholars and knows less
      let dest = null, dw = 0;
      for (const k in civ.relations) {
        const o = world.civs[k];
        if (!o || !o.alive || o.id === civ.id || !o.settlementIds.length) continue;
        const w = draw(world, o) * (teachable(civ, o, 1).length ? 1 : 0);
        if (w > dw || (w === dw && dest && o.id < dest.id)) { dw = w; dest = o; }
      }
      if (!dest || dw <= 0) continue;
      const ids = teachable(civ, dest, 2);
      for (const id of ids) headStart(dest, id, 0.4, `s:${civ.id}`);
      // the scholar goes: enrolled with the new realm, dwelling at its seat
      civ.flags.figs = civ.flags.figs.filter((x) => x !== f.id);
      (dest.flags.figs ||= []).push(f.id);
      f.civId = dest.id;
      if (dest.capitalId != null) f.sid = dest.capitalId;
      f.deeds = (f.deeds || []).concat(`went abroad to ${theName(dest)}`).slice(-12);
      if (rateOk(world, `scholarFled:${civ.id}`, 15)) {
        const why = fin(civ.darkAge) > 0 ? 'fleeing the darkness of the age' : civ.ruler && (civ.ruler.traits || []).includes('cruel') ? 'fleeing a cruel master' : 'drawn by its learning';
        record(world, {
          cat: 'tech', imp: 2, key: 'scholar.fled', civ: dest, ref: { k: 'figure', id: f.id }, tags: ['scholar'],
          text: pick(world, [
            `The scholar ${f.name} left ${theName(civ)} for ${theName(dest)}, ${why}, and brought ${TECH_BY_ID[ids[0]] ? `the knowledge of ${techDef(ids[0]).name.replace(/^The /, 'the ')}` : 'much learning'} with them.`,
            `${f.name}, the greatest mind of ${theName(civ)}, went over to ${theName(dest)}, ${why}.`,
          ]),
        });
      }
    }
  }
}

// when a realm falls, its learned flee to the friendliest neighbour still standing
on('civDestroyed', (world, civ) => {
  if (!civ || !civ.tech || !world.sys.civ) return;
  let dest = null, best = -Infinity;
  for (const k in civ.relations || {}) {
    const o = world.civs[k];
    if (!o || !o.alive || o.id === civ.id || !o.settlementIds.length) continue;
    const op = fin(civ.relations[k].opinion) + (fin(civ.relations[k].border) > 0 ? 10 : 0);
    if (op > best || (op === best && dest && o.id < dest.id)) { best = op; dest = o; }
  }
  if (!dest) return;
  for (const id of teachable(civ, dest, 2)) headStart(dest, id, 0.3, `f:${civ.id}`);
});

// ---------------------------------------------------------------------------
// Crossings: an invention reaching a new land or people

const landOf = (world, civ) => {
  const cap = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
  const lm = world.f.landmass;
  if (!lm) return -1;
  if (cap) return lm[cap.i];
  const i = Math.round(fin(civ.originY)) * world.W + Math.round(fin(civ.originX));
  return i >= 0 && i < world.N ? lm[i] : -1;
};

/** The lands and peoples an invention has reached, built from the realms that know it when not yet kept. */
function reachOf(world, id, except) {
  const st = world.sys.civ;
  const r = (st.reach ||= {});
  if (r[id]) return r[id];
  const out = [];
  const mythic = world.params.mythLevel >= 2;
  for (const c of world.civs) {
    if (!c || c === except || !c.tech || c.tech.known[id] == null) continue;
    const lm = landOf(world, c);
    if (lm >= 0 && !out.includes(lm)) out.push(lm);
    if (mythic && c.race && !out.includes('r:' + c.race)) out.push('r:' + c.race);
  }
  return (r[id] = out);
}

on('techDiscovered', (world, civ, id, how, first) => {
  if (!world.sys.civ || !civ) return;
  const tech = TECH_BY_ID[id];
  if (!tech) return;
  const reach = reachOf(world, id, civ);
  const lm = landOf(world, civ);
  const newLand = lm >= 0 && !reach.includes(lm);
  const race = world.params.mythLevel >= 2 && civ.race ? 'r:' + civ.race : null;
  const newPeople = race && !reach.includes(race);
  if (newLand) reach.push(lm);
  if (newPeople) reach.push(race);
  if (first || how === 'grant' || !(newLand || newPeople)) return;
  const [h, tid] = fromOf(civ, id);
  const T = tid != null && world.civs[tid] ? world.civs[tid] : null;
  const whence = T && h !== 'r' ? `, learning it from ${theName(T)}` : '';
  const arcane = isArcane(tech);
  if (newPeople && RACE_META[civ.race] && rateOk(world, `reachP:${civ.race}`, 2)) {
    record(world, { cat: arcane ? 'myth' : 'tech', imp: 2, key: 'tech.reached', civ, tags: [id, 'reached'], text: `${TheName(civ)} were the first ${RACE_META[civ.race].plural.toLowerCase()} ${tech.first}${whence}.` });
  } else if (newLand && rateOk(world, `reachL:${lm}`, 2)) {
    record(world, { cat: arcane ? 'myth' : 'tech', imp: 2, key: 'tech.reached', civ, tags: [id, 'reached'], text: pick(world, [
      `${TheName(civ)} were the first in their land ${tech.first}${whence}.`,
      `${tech.name.replace(/^The /, 'The ')} came to a new land: ${theName(civ)} were the first there ${tech.first}${whence}.`,
    ]) });
  }
});

// a revolution in a realm that prints stirs its printing neighbours: pamphlets cross borders
on('succession', (world, civ, prev, next, how) => {
  if (how !== 'revolution' || !civ || !civ.tech || civ.tech.known.printing == null) return;
  let told = false;
  for (const k in civ.relations) {
    const o = world.civs[k];
    if (!o || !o.alive || !(fin(civ.relations[k].border) > 0) || !o.tech || o.tech.known.printing == null) continue;
    o.stability = Math.max(0, fin(o.stability, 0.6) - 0.04);
    if (!told && rateOk(world, `pamphlets:${civ.id}`, 20)) {
      told = true;
      record(world, { cat: 'civ', imp: 1, key: 'realm.ideas', civ: o, tags: ['printing'], text: `Pamphlets printed in ${theName(civ)} carried its revolution across the border, and ${theName(o)} grew restless.` });
    }
  }
});

/**
 * An older world (no tree version): every realm learns the new inventions of the ages before
 * its own, as it would have, with no story but its founding ('g').
 */
export function upgradeKnowledge(world) {
  const st = world.sys.civ;
  if (!st || st.kv === KNOW_VERSION) return;
  for (const c of world.civs) {
    if (!c || !c.tech || !c.tech.known) continue;
    const era = fin(c.tech.era, 0);
    for (const t of allTechs()) {
      if (t.era >= era || isArcane(t) || c.tech.known[t.id] != null) continue;
      c.tech.known[t.id] = world.time.day;
      (c.tech.from ||= {})[t.id] = 'g';
    }
    if (c.alive) refreshMods(world, c);
  }
  st.kv = KNOW_VERSION;
}

/** Yearly (midsummer, civ/index.js): scholars who go abroad. */
export function knowledgeYearly(world) {
  if (!world.sys.civ) return;
  scholarsAbroad(world);
}
