// Rare arts (chunk 5, docs/design/inventions.md): secrets outside the ages (data.js ARTS), found
// by realms that meet a recipe, practised in one workshop town, hoarded, and carried off or lost.
//
//   sys.civ.arts[artId] = { first: [civId, sid, day] | null, held: [[civId, sid, since]],
//                           lost: [[civId, sid, day, why]] (the last 6) }
//   civ.tech.arts       = { artId: workshop sid } a holder's own view (tech.js reads it for the mods)
//
// Yearly, per living realm (midsummer, civ/index.js):
//   found      a realm that meets an art's recipe has its chance a year (data.js) to find it, at
//              the town the recipe points to (a quarter as likely while another realm still
//              holds it); at most 3 holders at once. A people's art (Mythic)
//              is found only by realms of that people, at a town where they are a quarter or more
//   defection  a holder's master craftsman may go abroad (0.05 % a year per contact, more in a dark age or
//              under a cruel ruler) to a contact that draws them; the secret then has two holders
//   theft      a realm whose ruler has intrigue 0.6 or more may steal an art from a neighbour or
//              a trading partner (0.3 % a year × intrigue, half again for a neighbour)
//   alliance   an ally of a holder may be given it (0.2 % a year)
//   humans     (Mythic) a human realm may learn a people's art outright: 0.2 % a year when it
//              trades with or borders a holder, five times as likely with that people a tenth or
//              more of one of its own towns; humans then practise it anywhere
//   keeping    a holder of another people's art keeps it only while its workshop town is a
//              quarter or more of that people
// A people's art passes to another people only through humans, or with the town: a conqueror
// holds it while the people stays. Theft, defection and gifts of a people's art go to humans only.
// Events: settlementTransferred (the workshop taken: the taker learns it 60 %, the craftsmen flee
// home or to a friend 25 %, it dies with them 15 %), settlementDestroyed (half flee to another
// town of the holder), civDestroyed. When no holder remains the art is lost; a dig in its
// workshop's ruin may find it again (events/ruins.js reads `lost`).
// Ext: secretRule (w, civ, artId) → false lets a holder's art spread to its trading partners
// like common knowledge (2 % a year each).
//
// Exports: artsYearly, artHeld, artsOf, ART_WORDS

import { on } from '../../core/hooks.js';
import { firstOf, hasProviders } from '../../core/ext.js';
import { BIOME, RACE_META, RESOURCES } from '../../core/constants.js';
import { ARTS, ART_IDS } from './data.js';
import { hasTech, refreshMods, LAND } from './tech.js';
import { fin, record, rateOk, atWarSet } from './state.js';
import { theName, TheName, pick } from './prose.js';

const MAX_HOLDERS = 3;
const B = (...keys) => keys.reduce((m, k) => m | (1 << BIOME[k]), 0);
const FOREST = B('TEMPERATE_FOREST', 'TEMPERATE_RAINFOREST', 'TAIGA', 'TROPICAL_FOREST', 'RAINFOREST');
const WARM_FOREST = B('TEMPERATE_FOREST', 'TROPICAL_FOREST', 'TEMPERATE_RAINFOREST');
const WARM = B('SAVANNA', 'SHRUBLAND', 'HOT_DESERT', 'TROPICAL_FOREST', 'RAINFOREST');
const GRASS = B('STEPPE', 'SAVANNA');

/** Does civ hold art a? */
export const artHeld = (civ, a) => Boolean(civ && civ.tech && civ.tech.arts && civ.tech.arts[a] != null);
/** The arts civ holds: [[artId, sid]]. */
export const artsOf = (civ) => (civ && civ.tech && civ.tech.arts ? Object.entries(civ.tech.arts) : []);

const stateOf = (world) => (world.sys.civ.arts ||= {});
const recOf = (world, a) => (stateOf(world)[a] ||= { first: null, held: [], lost: [] });
const RES_ID = Object.fromEntries(RESOURCES.map((r) => [r.key, r.id]));
const res = (civ, key) => (fin(civ.flags?.res) & (1 << RES_ID[key])) !== 0;

/** The share of people p in town s (Mythic peoples' mix, else the town's single people). */
const shareOf = (s, p) => (s.peoples && typeof s.peoples === 'object' ? fin(s.peoples[p]) : s.race === p ? 1 : 0);

/** The towns of civ, largest first (stable). */
function townsOf(world, civ) {
  const out = [];
  for (const sid of civ.settlementIds) { const s = world.settlements[sid]; if (s && s.alive) out.push(s); }
  return out.sort((a, b) => fin(b.population) - fin(a.population) || a.id - b.id);
}
/** The largest town of civ with any of the land bits (and, for a people's art, a quarter of that people). */
function townWith(world, civ, mask, people = null, pred = null) {
  for (const s of townsOf(world, civ)) {
    if (mask && !(fin(s.flags?.lnd) & mask)) continue;
    if (people && shareOf(s, people) < 0.25) continue;
    if (pred && !pred(s)) continue;
    return s;
  }
  return null;
}
const coastTown = (world, civ, mask = 0, people = null) => townWith(world, civ, mask, people, (s) => s.coastal);

/** The size of each land mass (tiles), cached per world. */
function landSize(world, lm) {
  const c = (world.cache.arts ||= {});
  if (!c.lmSize) {
    const m = new Map(), f = world.f.landmass;
    if (f) for (let i = 0; i < world.N; i++) if (f[i] >= 0) m.set(f[i], (m.get(f[i]) || 0) + 1);
    c.lmSize = m;
  }
  return c.lmSize.get(lm) || 0;
}

/** Recipes: the workshop town where civ could find the art now, or null. */
const RECIPE = {
  greekfire: (w, c) => hasTech(c, 'galley') && res(c, 'oil') && atWarSet(w).has(c.id) ? coastTown(w, c) : null,
  steel: (w, c) => {
    if (!hasTech(c, 'iron') || !res(c, 'iron')) return null;
    const cap = w.settlements[c.capitalId];
    if (!cap) return null;
    for (const k in c.relations) {
      const o = w.civs[k], oc = o && o.alive ? w.settlements[o.capitalId] : null;
      if (oc && fin(c.relations[k].trade) > 0 && Math.hypot(oc.x - cap.x, oc.y - cap.y) > 40) return townWith(w, c, 0);
    }
    return null;
  },
  silk: (w, c) => hasTech(c, 'weaving') && hasTech(c, 'husbandry') ? townWith(w, c, WARM_FOREST) : null,
  porcelain: (w, c) => hasTech(c, 'pottery') && hasTech(c, 'engineering') ? townWith(w, c, LAND.hills) : null,
  concrete: (w, c) => {
    if (!hasTech(c, 'engineering')) return null;
    const cap = w.settlements[c.capitalId];
    if (!cap) return null;
    for (const v of w.volcanoes || []) if (v && Math.hypot(fin(v.x) - cap.x, fin(v.y) - cap.y) <= 12) return cap;
    return null;
  },
  purple: (w, c) => hasTech(c, 'fishing') && hasTech(c, 'weaving') ? coastTown(w, c, WARM) : null,
  wayfinding: (w, c) => {
    if (!hasTech(c, 'canoes') || !hasTech(c, 'calendar') || hasTech(c, 'navigation')) return null;
    const cap = w.settlements[c.capitalId];
    if (!cap || !cap.coastal || !w.f.landmass) return null;
    return landSize(w, w.f.landmass[cap.i]) < 0.01 * w.N ? cap : null;   // an island people
  },
  compositebow: (w, c) => hasTech(c, 'bow') && hasTech(c, 'husbandry') && hasTech(c, 'horseback') ? townWith(w, c, GRASS) : null,
  clockwork: (w, c) => hasTech(c, 'astronomy') && hasTech(c, 'bronze') && fin(c.flags?.figureCounts?.scholar) > 0 ? townWith(w, c, 0) : null,
  glass: (w, c) => hasTech(c, 'pottery') && hasTech(c, 'guilds') ? townWith(w, c, 0, null, (s) => s.coastal && s.tier >= 3 && fin(s.buildings?.market) > 0) : null,
  shipsinging: (w, c) => hasTech(c, 'wood_singing') && hasTech(c, 'shipbuilding') ? coastTown(w, c, FOREST, 'elf') : null,
  stonebinding: (w, c) => hasTech(c, 'rune_carving') && hasTech(c, 'masonry') ? townWith(w, c, LAND.mountains, 'dwarf') : null,
  warbeasts: (w, c) => hasTech(c, 'beast_calling') && hasTech(c, 'husbandry') ? townWith(w, c, B('STEPPE'), 'orc') : null,
  everkeeping: (w, c) => hasTech(c, 'bountiful_hearth') && hasTech(c, 'pottery') ? townWith(w, c, LAND.river, 'halfling') : null,
  swampphysic: (w, c) => hasTech(c, 'venom_lore') && hasTech(c, 'medicine') ? townWith(w, c, B('WETLAND'), 'lizardfolk') : null,
  dragonbone: (w, c) => hasTech(c, 'bronze') && res(c, 'dragonbone') ? townWith(w, c, 0) : null,
  leyglass: (w, c) => {
    if (!hasTech(c, 'pottery')) return null;
    const nodes = w.sys.myth && w.sys.myth.ley && w.sys.myth.ley.nodes;
    if (!Array.isArray(nodes)) return null;
    for (const nd of nodes) if (nd && w.f.owner[nd.i] === c.id) return townWith(w, c, 0);
    return null;
  },
};

/** May an art be in this world (people's and open arts only in a Mythic world)? */
const inWorld = (world, a) => ARTS[a].kind === 'hist' || world.params.mythLevel >= 2;
/** May civ practise art a with its workshop at s? Humans anywhere; others need the art's people there. */
const canPractise = (civ, a, s) => ARTS[a].kind !== 'people' || civ.race === 'human' || (s && shareOf(s, ARTS[a].people) >= 0.25);

// ---------------------------------------------------------------------------
// Holding and losing

function gain(world, civ, a, s, how, from = null) {
  if (!civ || !civ.alive || artHeld(civ, a)) return false;
  const r = recOf(world, a);
  if (r.held.length >= MAX_HOLDERS) return false;
  const sid = s ? s.id : civ.capitalId;
  r.held.push([civ.id, sid, world.time.day]);
  (civ.tech.arts ||= {})[a] = sid;
  refreshMods(world, civ);
  const first = !r.first;
  if (first) r.first = [civ.id, sid, world.time.day];
  tell(world, civ, a, how, from, first, s);
  return true;
}

function drop(world, civ, a, why) {
  if (!civ || !civ.tech || !civ.tech.arts || civ.tech.arts[a] == null) return;
  const sid = civ.tech.arts[a];
  delete civ.tech.arts[a];
  if (!Object.keys(civ.tech.arts).length) delete civ.tech.arts;
  if (civ.alive) refreshMods(world, civ);
  const r = recOf(world, a);
  r.held = r.held.filter((h) => h[0] !== civ.id);
  if (!r.held.length) {
    r.lost = r.lost.concat([[civ.id, sid, world.time.day, why]]).slice(-6);
    const s = world.settlements[sid];
    if (rateOk(world, `artLost:${a}`, 30)) {
      record(world, { cat: 'tech', imp: 3, key: 'art.lost', civ, s: s || undefined, tags: [a, 'art'], text: pick(world, why === 'sickness' ? [
        `The secret of ${nameOf(a)} died in ${s ? s.name : theName(civ)} with the last who knew it, taken by sickness.`,
        `${capName(a)} passed out of the world when the sickness took the last who knew it in ${s ? s.name : theName(civ)}.`,
      ] : [
        `The secret of ${nameOf(a)} was lost with the ${why === 'razed' ? 'burning' : why === 'fled' ? 'scattering' : 'fall'} of ${s ? s.name : theName(civ)}; no one living knew it any more.`,
        `${capName(a)} passed out of the world: the last who knew it in ${theName(civ)} ${why === 'razed' ? 'died in the flames of ' + (s ? s.name : 'their town') : 'took the secret to their graves'}.`,
      ]) });
    }
  }
}

/** Published: realm civ loses rare art a (why: 'sickness' for one whose last keepers died, myth/sickness.js). */
export function loseArt(world, civ, a, why) { drop(world, civ, a, why); }

const nameOf = (a) => ARTS[a].name.replace(/^The /, 'the ');
const capName = (a) => ARTS[a].name;

function tell(world, civ, a, how, from, first, s) {
  const art = ARTS[a];
  const place = s ? s.name : null;
  let text, imp = 2, key = 'art.found';
  if (how === 'found') {
    imp = first ? 3 : 2;
    text = first
      ? `${place ? `At ${place}, ` : ''}${theName(civ)} became the first ${art.first}.`.replace(/^./, (x) => x.toUpperCase())
      : `${TheName(civ)} found again the secret of ${nameOf(a)}${place ? `, at ${place}` : ''}.`;
  } else if (how === 'taken') {
    key = 'art.taken';
    text = `With ${place || 'the town'}, ${theName(civ)} took the secret of ${nameOf(a)} from ${from ? theName(from) : 'its makers'}.`;
  } else if (how === 'fled') {
    key = 'art.fled';
    text = `The masters of ${nameOf(a)} fled ${from ? theName(from) : 'their homeland'} and carried the secret to ${theName(civ)}.`;
  } else if (how === 'stolen') {
    key = 'art.stolen';
    text = pick(world, [
      `Agents of ${theName(civ)} stole the secret of ${nameOf(a)} from ${from ? theName(from) : 'its keepers'}.`,
      `Smuggled out of ${from ? theName(from) : 'a rival realm'} in hollow canes and false-bottomed chests, the secret of ${nameOf(a)} reached ${theName(civ)}.`,
    ]);
  } else if (how === 'gift') {
    key = 'art.gift';
    text = `${from ? TheName(from) : 'An ally'} shared the secret of ${nameOf(a)} with ${theName(civ)}, an ally of long standing.`;
  } else if (how === 'dug') {
    key = 'art.found';
    imp = 3;
    text = `Digging in old ruins, the scholars of ${place || theName(civ)} found the lost secret of ${nameOf(a)}, and ${theName(civ)} practised it again.`;
  } else if (how === 'learned') {
    key = 'art.learned';
    const pp = art.people && RACE_META[art.people] ? RACE_META[art.people].plural.toLowerCase() : 'its makers';
    text = `${TheName(civ)}, ever quick to learn from others, mastered ${nameOf(a)}, an art of the ${pp}.`;
  } else return;
  const scope = how === 'found' ? (first ? `artFirst:${a}` : `artAgain:${a}`) : `art:${a}:${civ.id}`;
  if (!rateOk(world, scope, how === 'found' && first ? 0 : 10)) return;
  record(world, { cat: 'tech', imp, key, civ, s: s || undefined, tags: [a, 'art'], text });
}

// ---------------------------------------------------------------------------
// Towns change hands, burn, realms fall

on('settlementTransferred', (world, s, oldId, newId) => {
  if (!world.sys.civ || !world.sys.civ.arts) return;
  const old = world.civs[oldId], nu = world.civs[newId];
  for (const a of ART_IDS) {
    if (!old || !artHeld(old, a) || old.tech.arts[a] !== s.id) continue;
    const x = world.rng.next();
    drop(world, old, a, 'taken');
    if (x < 0.6) {
      if (nu && canPractise(nu, a, s)) gain(world, nu, a, s, 'taken', old);
    } else if (x < 0.85) {
      // the craftsmen flee home, if home still stands and can keep them, else to its best friend
      const home = old.alive && old.settlementIds.length ? townWith(world, old, 0, ARTS[a].kind === 'people' && old.race !== 'human' ? ARTS[a].people : null) : null;
      if (home) gain(world, old, a, home, 'moved', null);
      else { const f = friendOf(world, old); if (f && canPractise(f, a, null)) gain(world, f, a, null, 'fled', old); }
    }
  }
});

on('settlementDestroyed', (world, s) => {
  if (!world.sys.civ || !world.sys.civ.arts) return;
  const civ = world.civs[s.civId];
  if (!civ || !civ.tech || !civ.tech.arts) return;
  for (const a of ART_IDS) {
    if (!civ.tech.arts || civ.tech.arts[a] !== s.id) continue;   // (drop clears an emptied list)
    drop(world, civ, a, 'razed');
    if (world.rng.chance(0.5)) {
      const home = townWith(world, civ, 0, ARTS[a].kind === 'people' && civ.race !== 'human' ? ARTS[a].people : null, (t) => t.id !== s.id);
      if (home) gain(world, civ, a, home, 'moved', null);
    }
  }
});

on('civDestroyed', (world, civ) => {
  if (!world.sys.civ || !civ || !civ.tech || !civ.tech.arts) return;
  for (const a of Object.keys(civ.tech.arts)) drop(world, civ, a, 'fall');
});

/** The realm civ's craftsmen would flee to: its friendliest living neighbour. */
function friendOf(world, civ) {
  let best = null, bw = -Infinity;
  for (const k in civ.relations || {}) {
    const o = world.civs[k];
    if (!o || !o.alive || o.id === civ.id || !o.settlementIds.length) continue;
    const w = fin(civ.relations[k].opinion) + (fin(civ.relations[k].border) > 0 ? 10 : 0);
    if (w > bw || (w === bw && best && o.id < best.id)) { bw = w; best = o; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The year

/** Yearly (midsummer, civ/index.js): arts found, kept, carried abroad, stolen, given, learned. */
export function artsYearly(world) {
  if (!world.sys.civ) return;
  const rng = world.rng;
  const civs = world.civs.filter((c) => c && c.alive && c.tech && c.settlementIds.length);
  for (const civ of civs) {
    for (const a of ART_IDS) {
      if (!inWorld(world, a)) continue;
      const art = ARTS[a];
      if (artHeld(civ, a)) {
        // another people's art is kept only while its people stay in the workshop town
        if (art.kind === 'people' && civ.race !== 'human') {
          const s = world.settlements[civ.tech.arts[a]];
          if (!s || !s.alive || s.civId !== civ.id || shareOf(s, art.people) < 0.25) drop(world, civ, a, 'fled');
        }
        continue;
      }
      // found: a people's art only by its own people
      if (art.kind === 'people' && civ.race !== art.people) continue;
      const s = RECIPE[a](world, civ);
      const kept = stateOf(world)[a] && stateOf(world)[a].held.length > 0;
      if (s && rng.chance(art.chance * (kept ? 0.25 : 1))) gain(world, civ, a, s, 'found');
    }
  }
  // the secrets move: defection, theft, alliance, the human gift, open societies
  for (const a of ART_IDS) {
    if (!inWorld(world, a)) continue;
    const r = stateOf(world)[a];
    if (!r || !r.held.length) continue;
    const art = ARTS[a];
    for (const [hid] of r.held.slice()) {
      const h = world.civs[hid];
      if (!h || !h.alive) continue;
      const open = hasProviders('secretRule') && firstOf('secretRule', world, h, a) === false;
      let push = 1;
      if (fin(h.darkAge) > 0) push *= 3;
      if (h.ruler && (h.ruler.traits || []).includes('cruel')) push *= 2;
      for (const k in h.relations) {
        const o = world.civs[k];
        if (!o || !o.alive || !o.tech || artHeld(o, a) || !o.settlementIds.length) continue;
        const rel = h.relations[k];
        const border = fin(rel.border) > 0, trade = fin(rel.trade) > 0;
        const allied = (h.allies || []).includes(o.id);
        const human = o.race === 'human' && world.params.mythLevel >= 2;
        const peopleArt = art.kind === 'people';
        // another people's art goes abroad only to humans (or by conquest, with its town)
        if (peopleArt && !human) continue;
        if (open && trade && rng.chance(0.02)) { gain(world, o, a, null, 'gift', h); continue; }
        if (rng.chance(0.0005 * push)) { gain(world, o, a, null, 'fled', h); continue; }
        const int = o.ruler && Array.isArray(o.ruler.sk) ? o.ruler.sk[3] : 0;
        if (int >= 0.6 && (border || trade) && rng.chance(0.003 * int * (border ? 1.5 : 1))) { gain(world, o, a, null, 'stolen', h); continue; }
        if (allied && rng.chance(0.002)) { gain(world, o, a, null, 'gift', h); continue; }
        if (peopleArt && human && (border || trade)) {
          const near = townWith(world, o, 0, null, (t) => shareOf(t, art.people) >= 0.1);
          if (rng.chance(0.002 * (near ? 5 : 1))) gain(world, o, a, null, 'learned', h);
        }
      }
    }
  }
}

/**
 * A dig in the ruin of town sid (events/ruins.js): a rare art lost there, with no holder now, is
 * found again by the diggers' realm (30 %), if it may practise it. Returns true when found.
 */
export function rediscoverArt(world, civ, s, sid) {
  if (!world.sys.civ || !world.sys.civ.arts || !civ || !civ.alive) return false;
  for (const a of ART_IDS) {
    const r = world.sys.civ.arts[a];
    if (!r || r.held.length || !r.lost.some((l) => l[1] === sid) || !inWorld(world, a)) continue;
    if (!canPractise(civ, a, s) || !world.rng.chance(0.3)) continue;
    if (!gain(world, civ, a, s, 'dug')) continue;
    return true;
  }
  return false;
}

/** Words for the dossiers: what each art gives. */
export const ART_WORDS = Object.fromEntries(ART_IDS.map((a) => [a, ARTS[a].what]));
