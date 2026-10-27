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
//   Loss (phase 4): in a collapse (a dark age after defeat or collapse, a realm fallen to a fifth
//   of its towns within a dozen years, its capital lost with its library) each invention of its
//   newest age may be lost (20 %; the age before 10 %), × 0.2 for a realm that prints, never one
//   an archive in its lands still holds or another invention it knows rests on; at most three.
//   A lost invention is remembered (civ.tech.lost): relearnt at half the cost (tech.js).
//   Archives: a town with a library keeps its realm's newest 12 inventions (24 with paper), a
//   Great Library all of them: s.archive = [TECHS indices], yearly. A library burns when its
//   town is razed, and one time in seven when it is taken by force (the Chronicle tells of a Great
//   Library's or a capital's); a lost capital with a library costs knowledge only when the realm
//   is down to a third of its towns as well. A ruin keeps the archive of
//   a town that fell any other way (sites.js), for the digs (events/ruins.js).
//   Crossings: the Chronicle tells when an invention first reaches a land mass, and in a Mythic
//   world a people, it had not reached (sys.civ.reach[techId] = [landmass ids, 'r:race' …],
//   filled lazily from the realms that know it in an older save).
//
// Exports: HOW, fromOf, knowledgeYearly

import { on } from '../../core/hooks.js';
import { DAYS_PER_YEAR as DPY, RACE_META } from '../../core/constants.js';
import { TECH_BY_ID, TECH_INDEX, TECHS, techDef, hasTech, headStart, isArcane, allTechs, refreshMods, forgetTechs } from './tech.js';
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

// a town taken by force or treaty teaches its new masters what its old ones knew; a library taken
// by force may burn; a realm that loses a capital with a library may lose knowledge with it
on('settlementTransferred', (world, s, oldId, newId, cause) => {
  if (!s || !s.flags || oldId == null || !world.civs[oldId]) return;
  const old = world.civs[oldId];
  if (TEACH.has(cause)) s.flags.tb = [oldId, world.time.day];
  const lib = fin(s.buildings?.library);
  if (lib > 0 && (cause === 'conquest' || cause === 'reconquest') && world.rng.chance(1 / 7)) burn(world, s, old, world.civs[newId]);
  // a capital and its library lost by a realm already down to a third of its towns: a collapse
  const th = old.flags && old.flags.townHist;
  if (lib > 0 && old.flags && old.flags.capitalSid === s.id && Array.isArray(th) && th.length && old.settlementIds.length * 3 <= Math.max(...th)) loseKnowledge(world, old, 'capital');
});

// a razed town's library burns with it
on('settlementDestroyed', (world, s, cause) => {
  if (s && cause === 'razed' && fin(s.buildings?.library) > 0) burn(world, s, world.civs[s.civId], null);
});

on('darkAge', (world, civ, why) => {
  if (why === 'defeat' || why === 'collapse') loseKnowledge(world, civ, 'dark');
});

/** A library burns: its archive is gone, and the Chronicle says so. */
function burn(world, s, owner, by) {
  const great = fin(s.buildings?.library) >= 2;
  const n = Array.isArray(s.archive) ? s.archive.length : 0;
  s.archive = [];
  // the Chronicle tells of a Great Library, or a capital's; lesser libraries burn unremarked
  const capital = owner && owner.flags && owner.flags.capitalSid === s.id;
  if (!(great || capital) || n < 6) return;
  if (!rateOk(world, `burn:${s.id}`, 50)) return;
  const name = great ? `the Great Library of ${s.name}` : `the library of ${s.name}`;
  record(world, { cat: 'culture', imp: great ? 3 : 2, key: 'library.burned', s, tags: ['library'], text: pick(world, [
    `${name.replace(/^./, (x) => x.toUpperCase())} burned${by ? ` when ${theName(by)} took the town` : ''}, and with it the learning of ${owner ? theName(owner) : 'its makers'}.`,
    `${by ? `The soldiers of ${theName(by)} set fire to ${name}` : `Fire took ${name}`}; ${n} works of learning were lost.`,
  ]) });
}

/**
 * A collapse costs knowledge: each invention of the realm's newest age may be lost (20 %; the age
 * before, 10 %), a fifth as likely for a realm that prints, never one an archive in its lands
 * holds or another known invention rests on; at most three. Once in 50 years.
 */
export function loseKnowledge(world, civ, why) {
  if (!civ || !civ.alive || !civ.tech) return;
  const fl = (civ.flags ||= {});
  if (world.time.day - fin(fl.lostDay, -1e9) < 50 * DPY) return;
  fl.lostDay = world.time.day;
  const era = fin(civ.tech.era, 0);
  if (era < 1) return;
  const kept = new Set();
  for (const sid of civ.settlementIds) { const s = world.settlements[sid]; if (s && s.alive && Array.isArray(s.archive)) for (const k of s.archive) if (TECHS[k]) kept.add(TECHS[k].id); }
  const needed = new Set();
  for (const id in civ.tech.known) { const t = TECH_BY_ID[id]; if (t) for (const p of t.prereqs) needed.add(p); }
  const press = hasTech(civ, 'printing') ? 0.2 : 1;
  const out = [];
  for (const t of TECHS) {
    if (out.length >= 3) break;
    if (!hasTech(civ, t.id) || kept.has(t.id) || needed.has(t.id) || (t.era !== era && t.era !== era - 1)) continue;
    if (world.rng.chance((t.era === era ? 0.2 : 0.1) * press)) out.push(t.id);
  }
  if (!out.length) return;
  forgetTechs(world, civ, out);
  if (rateOk(world, `techLost:${civ.id}`, 30)) {
    const names = out.map((id) => techDef(id).name.replace(/^The /, 'the '));
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    const when = why === 'capital' ? 'With the fall of its capital and its library' : 'In the dark years';
    record(world, { cat: 'tech', imp: 2, key: 'tech.lost', civ, tags: ['lost'], text: `${when}, ${theName(civ)} forgot the arts of ${list}.` });
  }
}

/** Yearly: every library keeps its realm's newest inventions (a Great Library all of them). */
function archivesYearly(world) {
  for (const civ of world.civs) {
    if (!civ || !civ.alive || !civ.tech) continue;
    let ids = null;
    for (const sid of civ.settlementIds) {
      const s = world.settlements[sid];
      const lib = s && s.alive ? fin(s.buildings?.library) : 0;
      if (lib <= 0) { if (s && s.archive) delete s.archive; continue; }
      ids ||= Object.keys(civ.tech.known).filter((id) => TECH_INDEX[id] != null).sort((a, b) => civ.tech.known[b] - civ.tech.known[a] || TECH_INDEX[a] - TECH_INDEX[b]);
      const n = lib >= 2 ? ids.length : hasTech(civ, 'paper') ? 24 : 12;
      s.archive = ids.slice(0, n).map((id) => TECH_INDEX[id]).sort((a, b) => a - b);
    }
    // a realm fallen to a fifth of its towns within a dozen years has collapsed
    const th = civ.flags && civ.flags.townHist;
    if (Array.isArray(th) && th.length) {
      const top = Math.max(...th);
      if (top >= 5 && civ.settlementIds.length * 5 <= top) loseKnowledge(world, civ, 'collapse');
    }
  }
}

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
  archivesYearly(world);
}
