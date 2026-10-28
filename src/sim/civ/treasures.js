// Named treasures (chunk 9, docs/design/dynasties.md): crowns, swords of state, seals and
// sceptres a realm forges for its throne; named blades its great captains and heroes carry; the
// holy relics of each faith; and in Mythic worlds each people's treasures of power. Each has a
// maker, a story and a place, and moves when the world does: carried off when a capital falls,
// lost in a sack or a razing, carried into exile and home again, buried with a hero, found again
// in a ruin, given back at a peace.
//
//   sys.civ.art = { t: [treasure], n: next id, v: changes }
//   treasure = { id, n, k, made, by, f, at, h: [[day, verb, civId | -1]], pw?, ra? }
//     name, kind (crown, sword, seal, sceptre, blade, relic, runeblade, starglass, totem,
//     eggstone, book), the day made, who made it (words), the realm it was made for, where it is
//     (at: { k: 'civ', id } a realm's treasury, { k: 'fig', id } borne by a great figure,
//     { k: 'faith', id } kept by a faith in its holy city, { k: 'exile', id } with a court in
//     exile, { k: 'lost', x, y, sid? } lost (in a ruin, a grave, a battlefield)), its last eight
//     turns, a power (a realm modifier and its size: Mythic treasures), the people who made it
//
// Effects: a realm crowned with its own regalia (at each succession) gains a little legitimacy;
// one that loses them to a conqueror loses some, and hates the taker; a treasure of power lends
// its holder its modifier (mods provider). Hooks: succession, settlementTransferred (a capital
// taken), settlementDestroyed (a capital razed), figureBorn, figureDied, religionFounded,
// warEnded (a victor takes back its own). Yearly at the realm's month (treasuresYearly): regalia
// forged, treasures of power made; the world's year (treasuresWorldYear): the fallen realms'
// treasures go to their capital's taker, into exile or into the ground; courts come home; lost
// things are found. Draws from world.rng.

import { on } from '../../core/hooks.js';
import { registerProvider } from '../../core/ext.js';
import { makeWord } from '../../core/names.js';
import { DAYS_PER_YEAR as DPY } from '../../core/constants.js';
import { addOpinion, rel, nearestSettlement } from '../../core/entities.js';
import { isDynastic } from './data.js';
import { fin, record } from './state.js';
import { theName, TheName, rulerShort, pick } from './prose.js';
import { refreshMods } from './tech.js';

const CAP = 300, HIST = 8;
const REGALIA = new Set(['crown', 'sword', 'seal', 'sceptre']);
const THRONES = new Set(['kingdom', 'empire', 'feudal', 'theocracy']);

// Mythic treasures of power: the kind each people makes, its name and its gift (a realm modifier)
const POWER = {
  dwarf: { k: 'runeblade', w: 3, m: 'military', v: 0.06, name: (W) => `the runeblade ${W}`, by: 'the rune-smiths' },
  elf: { k: 'starglass', w: 1.5, m: 'research', v: 0.06, name: (W, P) => `the Starglass of ${P}`, by: 'the glass-singers' },
  orc: { k: 'totem', w: 1, m: 'military', v: 0.05, name: (W) => `the War-Totem of ${W}`, by: 'the shamans' },
  lizardfolk: { k: 'eggstone', w: 1, m: 'birth', v: 0.05, name: (W) => `the Egg-Stone of ${W}`, by: 'the egg-priests' },
  halfling: { k: 'book', w: 0.7, m: 'happiness', v: 0.03, name: (W) => `the Book of ${W}`, by: 'an old family' },
};

export function artState(world) {
  const st = world.sys.civ;
  if (!st) return null;
  if (!st.art || !Array.isArray(st.art.t)) st.art = { t: [], n: 1, v: 0 };
  return st.art;
}
const touch = (a) => { a.v = fin(a.v) + 1; };
const heldBy = (t, civId) => t.at && t.at.k === 'civ' && t.at.id === civId;

/** The treasures a realm holds now (cached per change). */
export function treasuresOf(world, civId) {
  const a = artState(world);
  if (!a) return [];
  const c = world.cache.artByCiv;
  let m = c && c.v === a.v && c.a === a ? c.m : null;
  if (!m) {
    m = new Map();
    for (const t of a.t) if (t.at && t.at.k === 'civ') { let l = m.get(t.at.id); if (!l) m.set(t.at.id, (l = [])); l.push(t); }
    world.cache.artByCiv = { v: a.v, a, m };
  }
  return m.get(civId) || [];
}
export const treasureById = (world, id) => (artState(world)?.t || []).find((t) => t.id === id) || null;

/** The name of a treasure as a sentence reads it ("the Iron Crown of Vask", "the sword Gramnir"). */
export const treasureName = (t) => (t ? t.n : 'a treasure');

function note(t, day, verb, civId) {
  t.h.push([day, verb, civId ?? -1]);
  if (t.h.length > HIST) t.h.splice(0, t.h.length - HIST);
}

function addTreasure(world, o) {
  const a = artState(world);
  const t = { id: a.n++, n: o.n, k: o.k, made: world.time.day, by: o.by || null, f: o.f ?? null, at: o.at, h: [] };
  if (o.pw) { t.pw = o.pw; t.pv = o.pv; }
  if (o.ra) t.ra = o.ra;
  note(t, world.time.day, 'made', o.f ?? null);
  a.t.push(t);
  // the cap: the longest lost go first
  if (a.t.length > CAP) {
    let k = a.t.findIndex((x) => x.at.k === 'lost');
    if (k < 0) k = 0;
    a.t.splice(k, 1);
  }
  touch(a);
  if (o.at.k === 'civ') { const c = world.civs[o.at.id]; if (c && t.pw) refreshMods(world, c); }
  return t;
}

/** Move a treasure (and refresh the holders' gifts). */
function moveTo(world, t, at, verb, civId = null) {
  const was = t.at && t.at.k === 'civ' ? world.civs[t.at.id] : null;
  t.at = at;
  note(t, world.time.day, verb, civId);
  touch(artState(world));
  if (t.pw) {
    if (was && was.alive) refreshMods(world, was);
    const now = at.k === 'civ' ? world.civs[at.id] : null;
    if (now && now.alive) refreshMods(world, now);
  }
}

// ---------------------------------------------------------------------------
// Making

const MATERIAL = [['Bronze', 'Amber', 'Copper', 'Bone'], ['Iron', 'Golden', 'Silver', 'Jewelled', 'Thorn', 'Pearl']];

function forgeRegalia(world, civ) {
  const rng = world.rng, lang = civ.language;
  const era = fin(civ.tech?.era, 0);
  const mat = rng.pick(MATERIAL[era >= 2 ? 1 : 0]);
  const base = civ.baseName || civ.name;
  const r = civ.ruler;
  const crown = pick(world, [`the Crown of ${base}`, `the ${mat} Crown of ${base}`, `the ${mat} Crown`, r ? `the Crown of ${r.name}` : `the Crown of ${base}`]);
  const made = [addTreasure(world, { n: crown, k: 'crown', by: `the smiths of ${world.settlements[civ.capitalId]?.name || base}`, f: civ.id, at: { k: 'civ', id: civ.id } })];
  if (rng.chance(0.35)) {
    const w = capWord(makeWord(lang, rng, 2, 3));
    made.push(addTreasure(world, { n: `${w}, the Sword of State`, k: 'sword', by: 'the royal armourers', f: civ.id, at: { k: 'civ', id: civ.id } }));
  }
  if (rng.chance(0.25)) made.push(addTreasure(world, { n: rng.chance(0.5) ? `the Great Seal of ${base}` : `the Sceptre of ${base}`, k: rng.chance(0.5) ? 'seal' : 'sceptre', by: 'the royal goldsmiths', f: civ.id, at: { k: 'civ', id: civ.id } }));
  const big = fin(civ.population) >= 60000;
  record(world, { cat: 'civ', imp: big ? 2 : 1, key: 'treasure.made', civ, tags: ['treasure', 'regalia'], ref: { k: 'treasure', id: made[0].id }, text: pick(world, [
    `${TheName(civ)} had a crown made for its throne: ${made[0].n}${made.length > 1 ? `, with ${made.slice(1).map((t) => t.n).join(' and ')}` : ''}.`,
    `For the crowning of ${r ? rulerShort(r) : 'its ruler'}, the smiths of ${theName(civ)} made ${made[0].n}, and every ruler after was crowned with it.`,
  ]) });
}
const capWord = (w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w);

function forgePower(world, civ, P) {
  const lang = civ.language, rng = world.rng;
  const W = capWord(makeWord(lang, rng, 2, 3));
  const place = world.settlements[civ.capitalId]?.name || civ.baseName || civ.name;
  const t = addTreasure(world, { n: P.name(W, place), k: P.k, by: `${P.by} of ${place}`, f: civ.id, at: { k: 'civ', id: civ.id }, pw: P.m, pv: P.v, ra: civ.race ?? null });
  record(world, { cat: 'myth', imp: 2, key: 'treasure.power', civ, tags: ['treasure'], ref: { k: 'treasure', id: t.id }, text: pick(world, [
    `${P.by.charAt(0).toUpperCase() + P.by.slice(1)} of ${place} made ${t.n} for ${theName(civ)}, and its power was felt at once.`,
    `${TheName(civ)} gained a treasure of power: ${t.n}, made by ${P.by} of ${place}.`,
  ]) });
}

/** Yearly at the realm's month: a throne without a crown forges one; Mythic peoples make treasures of power. */
export function treasuresYearly(world, civ) {
  if (!civ.alive || !civ.ruler) return;
  const era = fin(civ.tech?.era, 0);
  const own = treasuresOf(world, civ.id);
  if (isDynastic(civ.government) && THRONES.has(civ.government) && era >= 1 && fin(civ.population) >= 15000
    && !own.some((t) => t.k === 'crown' && t.f === civ.id) && !(artState(world).t.some((t) => t.k === 'crown' && t.f === civ.id))
    && world.rng.chance(0.12)) forgeRegalia(world, civ);
  const P = civ.race && POWER[civ.race];
  if (P && fin(world.params?.mythLevel) >= 2 && era >= 1 && own.filter((t) => t.pw).length < 3 && world.rng.chance(0.008 * P.w)) forgePower(world, civ, P);
}

// the gifts of treasures of power, to whoever holds them
registerProvider('mods', 'treasures', (world, civ) => {
  if (!civ) return null;
  const list = treasuresOf(world, civ.id);
  if (!list.length) return null;
  let m = null;
  // several of a kind lend no more than about two of them
  for (const t of list) if (t.pw) { m ||= {}; m[t.pw] = Math.min(2 * fin(t.pv), (m[t.pw] || 0) + fin(t.pv)); }
  return m;
});

// ---------------------------------------------------------------------------
// The world's turns

// crowned with the realm's own crown: a little legitimacy
on('succession', (world, civ, prev, next, how) => {
  if (!civ || !civ.alive || !next || how === 'union') return;
  if (treasuresOf(world, civ.id).some((t) => t.f === civ.id && t.k === 'crown')) civ.legitimacy = Math.min(1, fin(civ.legitimacy, 0.6) + 0.03);
});

/** A capital falls (taken, not razed): its realm's treasures are carried off, lost in the sack, or saved. */
on('settlementTransferred', (world, s, oldId, newId, cause) => {
  if (cause !== 'conquest' || !s || !s.flags || s.flags.wasCapital !== oldId) return;
  const old = world.civs[oldId], taker = world.civs[newId];
  if (!old || !taker) return;
  const list = treasuresOf(world, oldId).slice();
  if (!list.length) return;
  const rng = world.rng;
  const taken = [], lost = [];
  for (const t of list) {
    const r = rng.next();
    if (r < 0.45) { moveTo(world, t, { k: 'civ', id: taker.id }, 'taken', taker.id); taken.push(t); }
    else if (r < 0.6) { moveTo(world, t, { k: 'lost', x: s.x, y: s.y, sid: s.id }, 'lost', null); lost.push(t); }
  }
  if (taken.some((t) => t.f === oldId && REGALIA.has(t.k))) {
    old.legitimacy = Math.max(0, fin(old.legitimacy, 0.6) - 0.08);
    addOpinion(world, oldId, taker.id, -20);
    const q = rel(world, oldId, taker.id);
    q.grievance = Math.min(100, fin(q.grievance) + 15);
  }
  if (taken.length || lost.length) record(world, { cat: 'war', imp: 2, key: taken.length ? 'treasure.taken' : 'treasure.lost', civ: taker, sid: s.id, tags: ['treasure'], ref: { k: 'treasure', id: (taken[0] || lost[0]).id }, text: taken.length
    ? `When ${s.name} fell, ${theName(taker)} carried off ${taken.map((t) => t.n).join(' and ')}${lost.length ? `; ${lost.map((t) => t.n).join(' and ')} vanished in the sack` : ''}.`
    : `In the sack of ${s.name}, ${lost.map((t) => t.n).join(' and ')} of ${theName(old)} ${lost.length > 1 ? 'were' : 'was'} lost.` });
});

/** A capital razed: what its realm kept there is lost in the ruins, unless saved in time. */
on('settlementDestroyed', (world, s, cause) => {
  if (!s || cause !== 'razed') return;
  const civ = world.civs[s.civId];
  if (!civ || civ.capitalId !== s.id) return;
  const list = treasuresOf(world, civ.id).slice();
  const lost = [];
  for (const t of list) if (world.rng.chance(0.6)) { moveTo(world, t, { k: 'lost', x: s.x, y: s.y, sid: s.id }, 'lost in the ruins', null); lost.push(t); }
  if (lost.length) record(world, { cat: 'war', imp: 2, key: 'treasure.lost', civ, sid: s.id, tags: ['treasure'], ref: { k: 'treasure', id: lost[0].id }, text: `${lost.map((t) => t.n).join(' and ')} of ${theName(civ)} ${lost.length > 1 ? 'were' : 'was'} lost in the ruins of ${s.name}.` });
});

// a great captain or hero carries a named blade
on('figureBorn', (world, fig) => {
  if (!fig || (fig.kind !== 'general' && fig.kind !== 'hero')) return;
  if (!world.rng.chance(fig.kind === 'hero' ? 0.5 : 0.2)) return;
  const civ = world.civs[fig.civId];
  if (!civ) return;
  const W = capWord(makeWord(civ.language, world.rng, 2, 3));
  addTreasure(world, { n: `the sword ${W}`, k: 'blade', by: `the smiths of ${world.settlements[fig.sid]?.name || theName(civ)}`, f: civ.id, at: { k: 'fig', id: fig.id } });
});
on('figureDied', (world, fig) => {
  if (!fig) return;
  const a = artState(world);
  const t = a && a.t.find((x) => x.at.k === 'fig' && x.at.id === fig.id);
  if (!t) return;
  const civ = world.civs[fig.civId];
  const s = world.settlements[fig.sid];
  const x = s ? s.x : 0, y = s ? s.y : 0;
  const fell = /battle|fell|slain|killed/.test(String(fig.fate || ''));
  const r = world.rng.next();
  if (civ && civ.alive && r < (fell ? 0.3 : 0.55)) moveTo(world, t, { k: 'civ', id: civ.id }, 'passed to the treasury', civ.id);
  else moveTo(world, t, { k: 'lost', x, y }, fell ? 'lost on the field' : 'buried with its bearer', null);
});

// a new faith keeps a holy relic of its prophet in its holy city
const RELIC = ['the Bones of', 'the Staff of', 'the Robe of', 'the Cup of', 'the Tablets of', 'the Sandals of', 'the Lamp of'];
on('religionFounded', (world, r) => {
  if (!r || !r.prophet || !world.rng.chance(0.6)) return;
  addTreasure(world, { n: `${world.rng.pick(RELIC)} ${r.prophet}`, k: 'relic', by: `the first followers of ${r.name}`, f: r.founderCivId ?? null, at: { k: 'faith', id: r.id } });
});
// the holy city taken by a realm of another faith: its relics are seized
on('settlementTransferred', (world, s, oldId, newId, cause) => {
  if (cause !== 'conquest' || !s) return;
  const a = artState(world);
  if (!a || !a.t.length) return;
  for (const t of a.t) {
    if (t.at.k !== 'faith') continue;
    const r = world.religions && world.religions[t.at.id];
    const taker = world.civs[newId];
    if (!r || r.holyCityId !== s.id || !taker || taker.stateReligion === r.id) continue;
    moveTo(world, t, { k: 'civ', id: taker.id }, 'seized', taker.id);
    record(world, { cat: 'religion', imp: 3, key: 'treasure.relic', civ: taker, sid: s.id, tags: ['treasure', 'faith'], ref: { k: 'treasure', id: t.id }, text: `${TheName(taker)} took ${s.name} and carried off ${t.n}, holiest relic of ${r.name}; its faithful swore to win it back.` });
  }
});

// a victor takes back its own regalia from the beaten
on('warEnded', (world, war) => {
  if (!war || (war.outcome !== 'attackers' && war.outcome !== 'defenders')) return;
  const winners = war.outcome === 'attackers' ? war.attackers : war.defenders;
  const losers = war.outcome === 'attackers' ? war.defenders : war.attackers;
  for (const lid of losers || []) {
    for (const t of treasuresOf(world, lid).slice()) {
      if (t.f == null || !(winners || []).includes(t.f) || (!REGALIA.has(t.k) && t.k !== 'relic')) continue;
      const own = world.civs[t.f];
      if (!own || !own.alive) continue;
      moveTo(world, t, { k: 'civ', id: own.id }, 'given back', own.id);
      record(world, { cat: 'war', imp: 2, key: 'treasure.returned', civ: own, tags: ['treasure'], ref: { k: 'treasure', id: t.id }, text: `By the peace, ${theName(world.civs[lid])} gave back ${t.n} to ${theName(own)}.` });
    }
  }
});

/** The world's year: the fallen realms' treasures find their way; courts come home; lost things are found. */
export function treasuresWorldYear(world) {
  const a = artState(world);
  if (!a || !a.t.length) return;
  const st = world.sys.civ, rng = world.rng, day = world.time.day;
  for (const t of a.t) {
    if (t.at.k === 'civ') {
      const c = world.civs[t.at.id];
      if (!c || c.alive) continue;
      // a fallen realm: into exile with its court, to the taker of its last seat, or into the ground
      const ex = (st.exiles || []).find((e) => e.civId === c.id && !e.used);
      if (ex && rng.chance(0.7)) { moveTo(world, t, { k: 'exile', id: ex.id }, 'carried into exile', null); continue; }
      const seat = world.settlements[c.flags?.capitalSid ?? c.capitalId];
      const holder = seat && seat.alive ? world.civs[seat.civId] : null;
      if (holder && holder.alive && holder.id !== c.id) moveTo(world, t, { k: 'civ', id: holder.id }, c.fallCause === 'union' ? 'passed with the crown' : 'taken', holder.id);
      else moveTo(world, t, { k: 'lost', x: seat ? seat.x : 0, y: seat ? seat.y : 0, ...(seat ? { sid: seat.id } : {}) }, 'lost', null);
    } else if (t.at.k === 'exile') {
      const ex = (st.exiles || []).find((e) => e.id === t.at.id);
      const home = ex && ex.used ? world.civs.find((c) => c && c.alive && c.flags?.restored === ex.civId) : null;
      if (home) {
        moveTo(world, t, { k: 'civ', id: home.id }, 'brought home', home.id);
        record(world, { cat: 'civ', imp: 2, key: 'treasure.home', civ: home, tags: ['treasure', 'restoration'], ref: { k: 'treasure', id: t.id }, text: `${TheName(home)} was restored, and ${t.n} came home from exile with its court.` });
      } else if (!ex || day - ex.since > 150 * DPY) moveTo(world, t, { k: 'lost', x: 0, y: 0 }, 'lost in exile', null);
    } else if (t.at.k === 'fig') {
      const fig = (world.figures || []).find((f) => f.id === t.at.id) || null;
      if (!fig || fig.died != null) {
        const civ = world.civs[fig ? fig.civId : t.f];
        if (civ && civ.alive) moveTo(world, t, { k: 'civ', id: civ.id }, 'passed to the treasury', civ.id);
        else moveTo(world, t, { k: 'lost', x: 0, y: 0 }, 'lost', null);
      }
    } else if (t.at.k === 'lost' && (t.at.x || t.at.y)) {
      // found again: diggers and looters in the old places, now and then a wanderer
      const near = nearestSettlement(world, t.at.x, t.at.y, { maxDist: 6 });
      if (!rng.chance(near ? 0.006 : 0.001)) continue;
      const finder = near ? world.civs[near.civId] : null;
      if (!finder || !finder.alive) continue;
      const since = t.h.length ? t.h[t.h.length - 1][0] : t.made;
      moveTo(world, t, { k: 'civ', id: finder.id }, 'found', finder.id);
      const own = t.f != null ? world.civs[t.f] : null;
      if (own && own.alive && own.id !== finder.id) addOpinion(world, own.id, finder.id, -8);
      record(world, { cat: 'civ', imp: REGALIA.has(t.k) || t.k === 'relic' || t.pw ? 3 : 2, key: 'treasure.found', civ: finder, sid: near ? near.id : null, tags: ['treasure'], ref: { k: 'treasure', id: t.id }, text: pick(world, [
        `Near ${near ? near.name : 'an old ruin'}, ${theName(finder)} found ${t.n}, lost since Year ${Math.floor(since / DPY)}${own && own.alive && own.id !== finder.id ? `; ${theName(own)} wanted it back` : ''}.`,
        `Diggers at ${near ? near.name : 'the old places'} turned up ${t.n}, missing for ${Math.max(1, Math.round((day - since) / DPY))} years, and carried it to ${theName(finder)}.`,
      ]) });
    }
  }
}
