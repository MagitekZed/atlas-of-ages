// Magical sicknesses (chunk 12, docs/design/magical-sicknesses.md), Mythic worlds only.
//
//   The grave-plague  A realm that knows Necromancy, under a ruler of little mercy (ext
//                     'darkArtRule'), losing a war, lays a plague (cause 'grave', geo/disease.js)
//                     on an enemy city: the one it besieges, else the greatest in reach. Once
//                     enough have died, its dead rise as a host bound to the caster
//                     (bands/kinds/undead.js) that marches only on the war's enemy towns and
//                     fights beside the caster's armies, until the caster is at peace, its
//                     ruler dies or three years pass. The world dreads the caster (opinion −30 fading over a
//                     century, a casus belli for forty years, a league of its neighbours at
//                     once); at home stability −0.06 for 25 years, the clergy's horror
//                     (civ/power.js) and its towns' fear (ext townGrievance) for a decade.
//
//   Mana-burn         Once a year, a town with mages whose land's magic is drawn far below
//                     what the weave would hold there (strainOf: its mana against that target)
//                     may break out with mana-burn (cause 'mana'), more often the harder it
//                     strains, × the wild-magic setting × plagueRoom. It falls on each people by
//                     ext 'magicFrailty' (geo/health.js: elves 1, dwarves and lizardfolk 0.4,
//                     orcs 0.15, men and halflings 0.12), and no custom or quarantine keeps it
//                     off; wards and the healing arts ease its deaths. When it ends, its first
//                     town's land is burnt (mana and its base halved for 25 years, so its mages
//                     dwindle) and a rare art worked in a stricken town may die with its keepers.
//                     As the weave thins every land holds less, so it flares again late, and
//                     the magical peoples blame the realms of smoke (opinion). At most one
//                     outbreak in BURN_GAP years, world-wide.
//
//   The Wasting       A ruler takes a wound that will not close: a necromancer's curse (a dark
//                     realm at war, desperate), a dragon's or the dead's raid on their seat, an
//                     oath broken (diplomacy.js betrayal), a holy city or a ley-node town razed
//                     (war.js townRazed), the hand's curse. A year or two later the realm's
//                     harvests begin to fail around its seat (settlement effect foodYield, worse
//                     each year and spreading outward, up to half), and no one knows why: each
//                     year the realm blames something (ext 'blameRule': its least-liked
//                     minority, persecuted through ext 'minorityRule'; its mages, hunted; a hated
//                     neighbour, opinion and a war cause; its gods, its faith's fervour). A
//                     yearly chance reveals it (scrying, healers, a prophet, a sage, a god of
//                     secrets, fate or the harvest, an honest ruler's confession); a proud or
//                     greedy ruler may learn it first and silence the seers, and is shamed when
//                     it comes out. Once known (r.flags.wound.k: plots × 4, civ/ambitions.js) the
//                     ruler steps down, seeks a cure (a healing cup, civ/treasures.js, at home,
//                     lent by a friend, or taken in war; healers; a pilgrimage) or endures.
//                     Whoever ends the reign, the land heals over a few years; a murderer bears
//                     guilt (legitimacy, civ/rulers.js), and a kinslayer, one time in three, a
//                     second, lighter Wasting.
//
//   The Scourge       Every risen host gets a potential (undeadRisen hook): its maker's art (a
//                     caster's Necromancy + ½ arcana; the hand's virulence; the land's own magic
//                     for a natural rising) × (½ + the mana where it rose) × log10(the dead to hand
//                     / 500) (its own and the unrisen graves within 20 tiles). From 0.25 it has the
//                     makings of a scourge: a ceiling × (1 + 4 × potential, ≤ 5) and more power from
//                     each death (bands/kinds/undead.js). At 1 % of the world's people, three towns
//                     overrun, it is named the Scourge: a master holds it only by great art (most
//                     break free), it blights the towns within 8 tiles, the realms within 25 hunt
//                     it together (bands/hunts.js) and want war less with each other; a year
//                     without new dead and it sleeps, weakening, until fresh foes wake it. A
//                     company of heroes may end it (better while it sleeps; a lone champion has no
//                     chance, bands/hunts.js); realms strong enough near a sleeping one send
//                     expeditions. After 25 years named, with 8 towns or a realm destroyed or 6 %
//                     of the world's people dead by it, an age of darkness falls on its region (35
//                     tiles: dark ages, blight); carried far beyond, it brings the Age of the Dead.
//
//   world.sys.myth.sick = {
//     g      the grave-plague now raging: { pid, by, w, r, sid, x, y, day, pop, risen?, band? }
//     dread  { [civId]: the day it last laid one }
//     burns  [{ c: [mana cells], u: day it heals }]
//     dark   { [bandId]: { x, y, r, day } } each Scourge's age of darkness (lifted 15 years after its end)
//     wast   { [civId]: { r, c, by, d, s0, k, lv, rad, x, y, kn, bl, bk, path, cy, yrs, gone, how, cause } }
//            the wounded ruler's id, the wound's cause and dealer, its day, the day the land began
//            to fail, its strength, the loss and its reach, its centre; known (0 hidden, 1 the
//            ruler alone, 2 all), what is blamed and whom, the reckoning and the years of seeking
//            a cure; the day the reign ended and how
//     n      counts for the report
//   }
//   civ.flags.grave   the day the realm last laid one
//
// Monthly on day 21 (the rising each month; each realm's own checks in its month, civ.id % 12).
// Draws from world.rng only there, in a fixed order.

import { on } from '../../core/hooks.js';
import { chronicle } from '../../core/chronicle.js';
import { registerProvider, firstOf, hasProviders } from '../../core/ext.js';
import { liveCivs, liveSettlements, settlementsNear, areAtWar } from '../../core/entities.js';
import { addEffect, removeEffect } from '../../core/effects.js';
import { cohortTotal, isSet } from '../../core/cohorts.js';
import { DAYS_PER_YEAR as Y, DAYS_PER_MONTH, WATER } from '../../core/constants.js';
import { dayOfMonth, monthOf } from '../../core/world.js';
import { temperOf, TP } from '../../core/character.js';
import { isMythic, fin } from './races.js';
import { knowsSchool } from './arcana.js';
import { manaAt } from './mana.js';
import { activeWarList, enemySet, civName, capFirst, capitalOf, listJoin, rateOk, rateReady } from '../geo/common.js';
import { rulerShort, theName } from '../civ/prose.js';

let war = null, disease = null, health = null, undead = null;
try { war = await import('../geo/war.js'); } catch (e) { /* no war module: no one is desperate */ }
try { disease = await import('../geo/disease.js'); } catch (e) { /* no plagues */ }
try { health = await import('../geo/health.js'); } catch (e) { /* no faiths' teachings */ }
try { undead = await import('../bands/kinds/undead.js'); } catch (e) { /* the dead stay down */ }
let arts = null, rulers = null, treasures = null, folk = null, divine = null;
try { arts = await import('../civ/arts.js'); } catch (e) { /* no rare arts to lose */ }
try { rulers = await import('../civ/rulers.js'); } catch (e) { /* no abdication */ }
try { treasures = await import('../civ/treasures.js'); } catch (e) { /* no healing cups */ }
try { folk = await import('../geo/folk.js'); } catch (e) { /* no peoples to blame */ }
try { divine = await import('./divine.js'); } catch (e) { /* no gods' domains */ }
let engine = null, hunts = null, ages = null, stability = null;
try { engine = await import('../bands/engine.js'); } catch (e) { /* no bands */ }
try { hunts = await import('../bands/hunts.js'); } catch (e) { /* no heroes */ }
try { ages = await import('../events/ages.js'); } catch (e) { /* no world ages */ }
try { stability = await import('../civ/stability.js'); } catch (e) { /* no dark ages */ }

const MONTH_DAY = 21;
const GRAVE_GAP = 80;        // years between grave-plagues, world-wide
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const idOf = (x) => (typeof x === 'object' && x ? x.id : x);

function state(world) {
  const st = (world.sys.myth.sick ||= {});
  st.dread ||= {};
  st.wast ||= {};
  st.n ||= {};
  if (st.g === undefined) st.g = null;
  return st;
}
/** The state if there is one (providers and the interface read through this: reading never makes one). */
const peek = (world) => (world.sys.myth && world.sys.myth.sick) || null;

const healFaith = (world, civ) => Boolean(health && civ && civ.stateReligion != null && health.teachingOf(world, civ.stateReligion) === 'heal');

// ---------------------------------------------------------------------------
// The grave-plague

/** Would this realm lay a grave-plague? It must know the art, and its ruler must be without mercy. */
function wouldCast(world, civ) {
  if (hasProviders('darkArtRule')) {
    const x = firstOf('darkArtRule', world, civ);
    if (x != null) return Boolean(x);
  }
  if (!knowsSchool(civ, 'necromancy')) return false;
  const r = civ.ruler;
  if (!r) return false;
  const tr = r.traits || [];
  if (!tr.includes('cruel') && !tr.includes('mad') && temperOf(r, civ)[TP.MER] >= 0.3) return false;
  return !healFaith(world, civ);   // a faith that tends the sick forbids it
}

/** How desperate a realm is in its worst war (0..1+), and that war: losing, besieged, or its own siege stalled. */
function despair(world, civ) {
  const day = world.time.day;
  let best = null, bv = 0;
  for (const w of activeWarList(world)) {
    const side = war.sideOf(w, civ.id);
    if (!side) continue;
    let v = clamp((-war.warScoreFor(world, w, civ.id) - 15) / 45, 0, 1);
    for (const sid of civ.settlementIds) {
      const s = world.settlements[sid];
      if (s && s.siege && day - fin(s.siege.startDay, day) >= 180 && war.sideOf(w, s.siege.civId) === -side) v += 0.25;
    }
    if (v > bv) { bv = v; best = w; }
  }
  return { v: Math.min(1.2, bv), w: best };
}

/** The city to strike: the greatest enemy town it besieges, else the greatest within reach of its seat. */
function graveTarget(world, civ, w) {
  const side = war.sideOf(w, civ.id);
  let best = null;
  for (const s of liveSettlements(world)) {
    if (s.siege && s.siege.civId === civ.id && war.sideOf(w, s.civId) === -side && !s.disease && (!best || s.population > best.population)) best = s;
  }
  if (best) return best;
  const cap = capitalOf(world, civ);
  if (!cap) return null;
  for (const s of settlementsNear(world, cap.x, cap.y, 35)) {
    if (war.sideOf(w, s.civId) === -side && (s.tier || 0) >= 2 && !s.disease && (!best || s.population > best.population)) best = s;
  }
  return best;
}

function graveYear(world, st, civ) {
  if (st.g || !war || !disease || !wouldCast(world, civ)) return;
  const d = despair(world, civ);
  if (d.v < 0.3 || !d.w) return;
  const day = world.time.day;
  if (st.dread[civ.id] != null && day - st.dread[civ.id] < 30 * Y) return;   // once a generation at most
  if (!rateReady(world, 'gravePlague', GRAVE_GAP * Y)) return;
  const nec = fin(civ.mods && civ.mods.necromancy, 0.25);
  const tr = civ.ruler.traits || [];
  const p = 0.3 * d.v * (0.6 + 1.6 * nec) * (tr.includes('cruel') || tr.includes('mad') ? 1.3 : 1);
  if (!world.rng.chance(clamp(p, 0, 0.6))) return;
  const s = graveTarget(world, civ, d.w);
  if (s && rateOk(world, 'gravePlague', GRAVE_GAP * Y)) cast(world, st, civ, d.w, s, nec);
}

function cast(world, st, civ, w, s, nec) {
  const victim = world.civs[s.civId];
  const pop = s.population;
  const p = disease.createPlague(world, s, 'grave', { civB: civ, strength: 1 + nec });
  if (!p) return;
  const day = world.time.day;
  st.g = { pid: p.id, by: civ.id, w: w.id, r: civ.ruler.id, sid: s.id, x: s.x, y: s.y, day, pop: Math.round(pop) };
  st.dread[civ.id] = day;
  (civ.flags ||= {}).grave = day;
  st.n.grave = (st.n.grave || 0) + 1;
  addEffect(world, { kind: 'civ', id: civ.id }, { k: 'myth.grave', until: day + 25 * Y, m: { stability: -0.06 }, label: 'Dread of the dark art' });
  league(world, st, civ, victim, p);
}

/** The caster's neighbours, and its victim's, who hate it and are free to fight, band together against it. */
function league(world, st, caster, victim, p) {
  const members = [];
  for (const c of liveCivs(world)) {
    if (c.id === caster.id || (victim && c.id === victim.id) || areAtWar(world, c.id, caster.id)) continue;
    if ((c.allies || []).includes(caster.id) || c.vassalOf === caster.id || caster.vassalOf === c.id || knowsSchool(c, 'necromancy')) continue;
    const near = (c.relations[caster.id] && c.relations[caster.id].border > 0) || (victim && c.relations[victim.id] && c.relations[victim.id].border > 0);
    if (!near) continue;
    const op = fin(c.relations[caster.id] && c.relations[caster.id].opinion, 0);
    if (op > 10 || fin(c.warWeariness) > 0.5 || enemySet(world, c.id).size >= 1) continue;
    if (world.rng.chance(clamp(0.35 + (healFaith(world, c) ? 0.2 : 0) - op / 100, 0.1, 0.7))) members.push(c);
  }
  if (!members.length) return;
  members.sort((a, b) => fin(b.population) - fin(a.population) || a.id - b.id);
  const wr = war.startWarNamed(world, members.map((c) => c.id), [caster.id], 'league', `the League against ${caster.name}`);
  if (!wr) return;
  st.n.league = (st.n.league || 0) + 1;
  const cap = capitalOf(world, members[0]);
  chronicle(world, {
    cat: 'war', imp: 3, icon: 'war', key: 'myth.league', civId: members[0].id, ...(cap ? { sid: cap.id, x: cap.x, y: cap.y } : {}),
    ref: { k: 'war', id: wr.id }, ...(p.seq != null ? { cause: p.seq } : {}),
    text: members.length > 1
      ? `In horror at ${p.name}, ${listJoin(members.map((c) => civName(c)))} swore a league against ${civName(caster)} and its necromancers.`
      : `${capFirst(civName(members[0]))} would not suffer the necromancers of ${civName(caster)} beside it after ${p.name}, and went to war against them.`,
  });
}

/** Each month: once enough of a grave-plague's victims have died, they rise. */
function graveMonth(world, st) {
  const g = st.g;
  if (!g) return;
  const p = world.plagues[g.pid];
  if (!p) { st.g = null; return; }
  if (g.risen == null) {
    const months = (world.time.day - g.day) / DAYS_PER_MONTH;
    if (fin(p.deaths) >= Math.max(60, 0.03 * g.pop) && months >= 1) raise(world, st, g, p);
    else if (!p.active) st.g = null;   // it burnt out before enough had died
    return;
  }
  if (!p.active) st.g = null;          // the host, bound or not, goes on in bands/kinds/undead.js
}

function raise(world, st, g, p) {
  g.risen = world.time.day;
  if (!undead) return;
  const s = world.settlements[g.sid];
  const place = s ? s.name : 'the stricken city';
  const civ = world.civs[g.by];
  const bound = civ && civ.alive && civ.ruler && civ.ruler.id === g.r && enemySet(world, civ.id).size > 0 ? { c: civ.id, w: g.w, r: g.r, u: world.time.day + 3 * Y } : null;
  const site = undead.digGrave(world, g.x, g.y, fin(p.deaths), `the Plague-Pits of ${place}`, [s ? s.civId : -1, g.by].filter((v) => v >= 0), p.seq);
  if (!site) return;
  // the maker's art, for the host's potential (the Scourge): a caster's, else the hand's virulence
  const art = civ && civ.alive ? fin(civ.mods && civ.mods.necromancy) + 0.5 * fin(civ.mods && civ.mods.arcana) : g.by < 0 ? Math.max(0, fin(p.lethality) / 0.375 - 0.8) : 0.15;
  const band = undead.rise(world, site, {
    mul: 1.5, bound, art,
    text: (host) => bound
      ? `The dead of ${p.name} would not lie in the plague-pits of ${place}: they rose as ${host}, and marched for ${civName(civ)}.`
      : `The dead of ${p.name} rose from the plague-pits of ${place} as ${host}, and no one living was their master.`,
  });
  if (band) { g.band = band.id; p.risen = world.time.day; p.band = band.id; st.n.risen = (st.n.risen || 0) + 1; }
}

// ---------------------------------------------------------------------------
// Mana-burn

/** How hard mana-burn falls on each race (the magic-touched hardest). */
export const MAGIC_FRAIL = { elf: 1, dwarf: 0.4, lizardfolk: 0.4, orc: 0.15, halfling: 0.12, human: 0.12 };
const BURN = 0.009;          // the yearly chance at full strain, for a town of twenty mages of the magic-touched
const BURN_GAP = 25;         // years between outbreaks, world-wide
const BURN_K = 0.5;          // what is left of a burnt land's magic
const BURN_YEARS = 25;

/**
 * 0..1: how far town s draws its land's magic below what the land would hold (its mana against
 * the target the weave, the setting and the smoke set there; mana.js monthlyMana). Pure.
 */
export function strainOf(world, s) {
  const f = world.f;
  if (!s || !f.mana || !f.manaBase) return 0;
  const W2 = world.W >> 1, H2 = world.H >> 1;
  const cx = Math.min(W2 - 1, s.x >> 1), cy = Math.min(H2 - 1, s.y >> 1);
  const c = cy * W2 + cx;
  if (!(c < f.mana.length)) return 0;
  const k = fin(world.params.magicStrength, 1) * fin(world.sys.myth && world.sys.myth.weave, 1);
  const poll = f.pollution ? f.pollution[Math.min(world.H - 1, cy * 2) * world.W + Math.min(world.W - 1, cx * 2)] : 0;
  const target = f.manaBase[c] * k * (1 - 0.8 * Math.min(1, poll));
  if (!(target > 0.03)) return 0;   // a land with almost no magic has none to overdraw
  return clamp(1 - f.mana[c] / target, 0, 1);
}

/** Once a year: an overdrawn town may break out with mana-burn (one a year in the world at most). */
function manaYear(world, st) {
  healBurns(world, st);
  const wild = fin(world.params.wildMagic, 1);
  if (!disease || !(wild > 0)) return;
  const room = disease.plagueRoom(world);
  if (!(room > 0)) return;
  for (const s of liveSettlements(world)) {
    const mages = s.jobs && s.jobs.length >= 15 ? s.jobs[11] : 0;
    if (!(mages >= 1) || s.disease) continue;
    const sg = strainOf(world, s);
    if (sg < 0.5) continue;
    const x = (sg - 0.5) / 0.5;
    if (!world.rng.chance(BURN * x * x * wild * room * Math.min(2, Math.sqrt(mages / 20)) * touchedOf(world, s))) continue;
    if (!rateOk(world, 'manaBurn', BURN_GAP * Y)) return;
    const p = disease.createPlague(world, s, 'mana', { strength: 0.8 + 0.5 * sg });
    if (p) st.n.mana = (st.n.mana || 0) + 1;
    return;
  }
}

/** 0..1: how magic-touched a town's people are (its peoples' shares × MAGIC_FRAIL; a mana-burn takes hold only among them). */
function touchedOf(world, s) {
  const c = s.cohorts;
  if (!isSet(c)) return MAGIC_FRAIL[s.race] ?? MAGIC_FRAIL.human;
  let t = 0, n = 0;
  for (const r in c) {
    const k = cohortTotal(c[r]);
    t += k * (MAGIC_FRAIL[r] ?? MAGIC_FRAIL.human); n += k;
  }
  return n > 0 ? t / n : MAGIC_FRAIL[s.race] ?? MAGIC_FRAIL.human;
}

/** A burnt land: the magic of the nine cells around (x, y) halved, its base too, for a generation. */
function burnLand(world, st, x, y) {
  const f = world.f;
  if (!f.mana || !f.manaBase) return;
  const W2 = world.W >> 1, H2 = world.H >> 1;
  const cx0 = Math.min(W2 - 1, x >> 1), cy0 = Math.min(H2 - 1, y >> 1);
  const cells = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = cx0 + dx, cy = cy0 + dy;
    if (cx < 0 || cy < 0 || cx >= W2 || cy >= H2) continue;
    const c = cy * W2 + cx;
    f.manaBase[c] *= BURN_K;
    f.mana[c] *= BURN_K;
    cells.push(c);
  }
  (st.burns ||= []).push({ c: cells, u: world.time.day + BURN_YEARS * Y });
  st.n.burnt = (st.n.burnt || 0) + 1;
}

function healBurns(world, st) {
  if (!st.burns || !st.burns.length) return;
  const day = world.time.day, base = world.f.manaBase;
  st.burns = st.burns.filter((b) => {
    if (day < b.u) return true;
    if (base) for (const c of b.c) base[c] /= BURN_K;
    return false;
  });
}

on('plagueEnded', (world, p) => {
  if (!p || p.cause !== 'mana' || !isMythic(world) || !world.sys.myth || world.sys.myth.v == null) return;
  const st = state(world);
  const s = world.settlements[p.originSid];
  if (s) burnLand(world, st, s.x, s.y);
  // a rare art worked in a stricken town may die with the last who knew it
  if (!arts) return;
  for (const sid of p.hitIds || []) {
    const t = world.settlements[sid];
    const civ = t && t.alive ? world.civs[t.civId] : null;
    const held = civ && civ.tech && civ.tech.arts;
    if (!held) continue;
    for (const a of Object.keys(held)) {
      if (held[a] === sid && world.rng.chance(0.35)) { arts.loseArt(world, civ, a, 'sickness'); st.n.artsLost = (st.n.artsLost || 0) + 1; }
    }
  }
});


// ---------------------------------------------------------------------------
// The Wasting

const WOUND_GAP = 150;       // years between wounds, world-wide
const pron = (r) => (r && r.gender === 'f' ? 'her' : 'his');
const tellCiv = (world, civ, e) => {
  const cap = capitalOf(world, civ);
  return chronicle(world, { civId: civ.id, ...(cap ? { sid: cap.id, x: cap.x, y: cap.y } : {}), icon: 'plague', tags: ['wasting'], ...e });
};

/** A wound that will not close on civ's ruler (cause: 'curse' | 'beast' | 'oath' | 'desecration' | 'hand' | 'kinslaying'). Returns true if dealt. */
export function woundRuler(world, civ, cause, by = null, opts = {}) {
  if (!isMythic(world) || !world.sys.myth || world.sys.myth.v == null) return false;
  const st = state(world);
  const r = civ && civ.alive ? civ.ruler : null;
  if (!r || st.wast[civ.id] || (r.flags && r.flags.wound)) return false;
  if (!opts.force && !rateOk(world, 'wasting', WOUND_GAP * Y)) return false;
  const day = world.time.day;
  const cap = capitalOf(world, civ);
  (r.flags ||= {}).wound = { c: cause, d: day };
  st.wast[civ.id] = {
    r: r.id, c: cause, by: by != null ? by : null, d: day, s0: day + Math.round((1 + world.rng.next()) * Y),
    k: cause === 'kinslaying' ? 0.5 : 1, lv: fin(opts.lv), rad: fin(opts.rad, 3), x: cap ? cap.x : 0, y: cap ? cap.y : 0,
    kn: 0, bl: null, bk: null, path: null, cy: 0, yrs: 0, gone: null, how: null, cause: null,
  };
  st.n.wast = (st.n.wast || 0) + 1;
  st.n['w.' + cause] = (st.n['w.' + cause] || 0) + 1;
  const dealer = by != null ? world.civs[by] : null;
  const who = rulerShort(r);
  const text = {
    curse: `The necromancers of ${dealer ? civName(dealer) : 'its enemies'} laid a curse on ${who} of ${theName(civ)}; a wound opened that would not close.`,
    beast: `${capFirst(who)} of ${theName(civ)} was wounded ${opts.what ? `by ${opts.what}` : 'by a beast of legend'}${cap ? ` at ${cap.name}` : ''}, and the wound would not close.`,
    oath: `${capFirst(who)} of ${theName(civ)} broke faith with ${dealer ? civName(dealer) : 'an ally'}; within the month a wound opened on ${pron(r)} hand that would not close.`,
    desecration: `${capFirst(who)} of ${theName(civ)} razed ${opts.place || 'a holy place'}; afterwards a sore opened on ${pron(r)} side that would not heal.`,
    hand: `A curse from beyond the world fell on ${who} of ${theName(civ)}: a wound opened that would not close.`,
    kinslaying: `The blood of ${opts.victim || 'kin'} was on the hands of ${who} of ${theName(civ)}, and a wound opened on them that would not close.`,
  }[cause] || `${capFirst(who)} of ${theName(civ)} took a wound that would not close.`;
  tellCiv(world, civ, { cat: 'myth', imp: 2, key: 'myth.wound', text });
  return true;
}

/** Each year in the realm's month: the land, the blame, the revelation, the reckoning; healing after the reign. */
function wastYear(world, st, civ) {
  const w = st.wast[civ.id];
  if (!w) return;
  const day = world.time.day;
  if (w.gone == null && (!civ.ruler || civ.ruler.id !== w.r)) { w.gone = day; w.how ||= 'gone'; }
  if (w.gone != null) { healYear(world, st, civ, w); return; }
  if (day < w.s0) return;
  w.lv = Math.min(0.5 * w.k, w.lv + 0.07 * w.k);
  w.rad = Math.min(40, w.rad + 4);
  w.yrs++;
  landYear(world, civ, w);
  if (w.yrs === 1) {
    const cap = capitalOf(world, civ);
    tellCiv(world, civ, { cat: 'myth', imp: 2, key: 'myth.wasting', text: pickT(world, [
      `The harvests failed around ${cap ? cap.name : 'the seat'} of ${theName(civ)}: the grain stood thin and grey, the cattle sickened, and no one could say why.`,
      `In ${theName(civ)} the fields near ${cap ? cap.name : 'the seat'} began to fail, a little worse each year, though the rains came as they always had.`,
    ]) });
  }
  if (w.kn < 2) { blameYear(world, st, civ, w); revealYear(world, st, civ, w); } else reckonYear(world, st, civ, w);
}

/** The towns of the realm grow less food, worst near the wound's centre, out to its reach. */
function landYear(world, civ, w) {
  const until = world.time.day + Y + 60;
  for (const sid of civ.settlementIds) {
    const s = world.settlements[sid];
    if (!s || !s.alive) continue;
    const d = Math.hypot(s.x - w.x, s.y - w.y);
    const loss = d <= w.rad ? w.lv * clamp(1 - 0.6 * d / Math.max(1, w.rad), 0.4, 1) : 0;
    const t = { kind: 'settlement', id: s.id };
    if (loss > 0.01) addEffect(world, t, { k: 'myth.wasting', until, m: { foodYield: Math.round((1 - loss) * 100) / 100 }, label: 'The Wasting' });
    else removeEffect(world, t, 'myth.wasting');
  }
}

function healYear(world, st, civ, w) {
  w.lv = Math.max(0, w.lv - 0.15);
  if (w.lv > 0.01) { landYear(world, civ, w); return; }
  for (const sid of civ.settlementIds) removeEffect(world, { kind: 'settlement', id: sid }, 'myth.wasting');
  delete st.wast[civ.id];
  st.n.wYrs = (st.n.wYrs || 0) + w.yrs;
  st.n['w.end.' + (w.how || 'gone')] = (st.n['w.end.' + (w.how || 'gone')] || 0) + 1;
  if (w.yrs >= 1) {
    tellCiv(world, civ, { cat: 'myth', imp: 2, key: 'myth.healed', text: pickT(world, [
      `The fields of ${theName(civ)} bore again; the old folk called the years of the blight the Wasted Years, and told their grandchildren why.`,
      `The land of ${theName(civ)} healed at last. For generations its people spoke of the Wasted Years, and of the wound that had caused them.`,
    ]) });
  }
}

/** What a realm might blame: its least-liked minority, its mages, a hated neighbour, its gods. */
function blameChoices(world, civ) {
  const out = {};
  const ruling = folk ? folk.civPeople(world, civ) : null;
  if (ruling && civ.minor) {
    let best = null, bf = Infinity;
    for (const k in civ.minor) {
      if (k === ruling || !Array.isArray(civ.minor[k]) || civ.minor[k][0] === 'expelled') continue;
      const f = folk.feel(world, ruling, k);
      if (f < bf) { bf = f; best = k; }
    }
    if (best) out.minority = { k: best, w: bf < -10 ? 1.4 : 0.7 };
  }
  let mages = 0;
  for (const sid of civ.settlementIds) { const s = world.settlements[sid]; if (s && s.jobs && s.jobs.length >= 15) mages += fin(s.jobs[11]); }
  if (mages >= 5) out.mages = { w: 0.9 };
  let nb = null, no = -15;
  for (const k in civ.relations) {
    const r = civ.relations[k], o = world.civs[k];
    if (!r || !(r.border > 0) || !o || !o.alive) continue;
    if (fin(r.opinion) < no) { no = fin(r.opinion); nb = o.id; }
  }
  if (nb != null) out.neighbour = { k: nb, w: 1.1 };
  out.gods = { w: 0.5 };
  return out;
}

function blameYear(world, st, civ, w) {
  if (!w.bl || world.rng.chance(0.12)) {
    const ch = blameChoices(world, civ);
    let key = hasProviders('blameRule') ? firstOf('blameRule', world, civ, ch) : null;
    if (!ch[key]) {
      let tot = 0;
      for (const k in ch) tot += ch[k].w;
      let x = world.rng.next() * tot;
      key = 'gods';
      for (const k in ch) { x -= ch[k].w; if (x <= 0) { key = k; break; } }
    }
    const bk = ch[key].k != null ? ch[key].k : null;
    if (key !== w.bl || bk !== w.bk) {
      w.bl = key; w.bk = bk;
      const nb = key === 'neighbour' ? world.civs[bk] : null;
      const who = key === 'minority' && folk ? folk.peopleName(world, bk, false) : null;
      tellCiv(world, civ, { cat: 'myth', imp: 2, key: 'myth.blame', text: {
        minority: `${capFirst(theName(civ))} blamed the ${who || 'strangers'} among its people for the failing harvests; the old mistrust hardened into hatred.`,
        mages: `${capFirst(theName(civ))} blamed its mages for the blight on its fields, and hunted them through the towns.`,
        neighbour: `${capFirst(theName(civ))} said that ${nb ? civName(nb) : 'its neighbour'} had poisoned its fields, and wanted vengeance.`,
        gods: `${capFirst(theName(civ))} believed its gods had turned from it, and the temples emptied as the fields failed.`,
      }[key] });
    }
  }
  if (w.bl === 'minority' && folk && w.bk) { const ruling = folk.civPeople(world, civ); if (ruling) folk.nudgeFeel(world, ruling, w.bk, -6); }
  else if (w.bl === 'mages') addEffect(world, { kind: 'civ', id: civ.id }, { k: 'myth.witchhunt', until: world.time.day + Y + 60, m: { research: -0.06 }, label: 'Mages hunted' });
  else if (w.bl === 'gods') {
    const rel = civ.stateReligion != null ? world.religions[civ.stateReligion] : null;
    if (rel && Number.isFinite(rel.fervor)) rel.fervor = Math.max(0, rel.fervor - 0.04);
    addEffect(world, { kind: 'civ', id: civ.id }, { k: 'myth.godless', until: world.time.day + Y + 60, m: { stability: -0.03 }, label: 'The gods turned away' });
  }
}

function revealYear(world, st, civ, w) {
  const r = civ.ruler;
  const tp = temperOf(r, civ);
  // a proud or greedy ruler may learn it first, and silence the seers
  if (w.kn === 0 && w.yrs >= 2 && tp[TP.HON] < 0.35 && (tp[TP.AMB] > 0.6 || tp[TP.GRE] > 0.6) && world.rng.chance(0.3)) {
    w.kn = 1;
    addEffect(world, { kind: 'civ', id: civ.id }, { k: 'myth.seers', until: world.time.day + 3 * Y, m: { research: -0.08 }, label: 'The seers silenced' });
    tellCiv(world, civ, { cat: 'myth', imp: 2, key: 'myth.hidden', text: `The seers of ${theName(civ)} told ${rulerShort(r)} that the land was failing with ${pron(r)} wound; ${rulerShort(r)} had them silenced, and told no one.` });
  }
  const scry = fin(civ.mods && civ.mods.scrying);
  let healers = 0, hands = 0;
  for (const sid of civ.settlementIds) {
    const s = world.settlements[sid];
    const j = s && s.jobs;
    if (!j || j.length < 15) continue;
    healers += fin(j[12]);
    for (let t = 0; t < j.length; t++) hands += fin(j[t]);
  }
  const hf = hands > 0 ? clamp(healers / hands / 0.003, 0, 1) : 0;
  let prophet = false, sage = false;
  for (const f of world.figures || []) {
    if (!f || f.died != null || f.civId !== civ.id) continue;
    if (f.kind === 'prophet') prophet = true; else if (f.kind === 'scholar' || f.kind === 'hero') sage = true;
  }
  const rel = civ.stateReligion != null ? world.religions[civ.stateReligion] : null;
  const dom = divine && rel ? divine.domainOf(rel) : null;
  const god = dom === 'secrets' || dom === 'fate' || dom === 'harvest';
  const confess = w.kn === 0 && tp[TP.HON] > 0.65 && w.yrs >= 3;
  // the longer the blight, the more who suspect
  let p = 0.03 + 0.01 * Math.min(15, w.yrs) + 0.3 * scry + 0.1 * hf + (prophet ? 0.06 : 0) + (sage ? 0.05 : 0) + (god ? 0.06 : 0);
  if (w.kn === 1) p *= 0.4;
  if (confess) p += 0.08;
  if (!world.rng.chance(clamp(p, 0, 0.6))) return;
  const was = w.kn;
  w.kn = 2;
  r.flags.wound.k = 1;
  const how = was === 1 ? `the court learned that ${rulerShort(r)} had known for years, and had silenced the seers`
    : confess ? `${rulerShort(r)} confessed it before the court`
    : scry > 0.2 ? 'its seers read it in the scrying-pools'
    : prophet ? 'a prophet of its faith proclaimed it in the market'
    : god && rel ? `${rel.deity || 'its god'} showed it in a dream to the priests`
    : hf > 0.3 ? 'its healers traced the blight to the wound'
    : sage ? 'a sage of the realm traced the blight to its source' : 'a whisper became a cry in every village';
  if (was === 1) civ.legitimacy = Math.max(0, fin(civ.legitimacy, 0.5) - 0.2);
  tellCiv(world, civ, { cat: 'myth', imp: 3, key: 'myth.revealed', text: `The cause of the blight on ${theName(civ)} came out at last: the land was failing with the wound of ${rulerShort(r)}. ${capFirst(how)}.` });
}

function pickPath(world, civ, r) {
  const tp = temperOf(r, civ);
  const wA = Math.max(0.05, (tp[TP.MER] + tp[TP.HON]) / 2 - 0.3) * (r.elected ? 2 : 1);
  const wC = 0.15 + 0.5 * Math.max(tp[TP.PIE], tp[TP.BOL]);
  const wE = 0.1 + 0.5 * Math.max(tp[TP.AMB], 1 - tp[TP.MER]);
  const x = world.rng.next() * (wA + wC + wE);
  return x < wA ? 'abdicate' : x < wA + wC ? 'cure' : 'endure';
}

function reckonYear(world, st, civ, w) {
  const r = civ.ruler;
  if (!w.path) {
    const own = hasProviders('reckonRule') ? firstOf('reckonRule', world, civ, r) : null;
    w.path = ['abdicate', 'cure', 'endure', 'murder'].includes(own) ? own : pickPath(world, civ, r);
    if (w.path === 'cure') tellCiv(world, civ, { cat: 'myth', imp: 2, key: 'myth.cure', text: `${capFirst(rulerShort(r))} of ${theName(civ)} sent far and wide for a cure for the wound, so that the land might live.` });
    else if (w.path === 'endure' || w.path === 'murder') tellCiv(world, civ, { cat: 'myth', imp: 2, key: 'myth.endure', text: `${capFirst(rulerShort(r))} of ${theName(civ)} would not give up the throne for a failing harvest, and the court began to whisper.` });
  }
  if (w.path === 'abdicate') {
    if (!rulers || !world.rng.chance(0.6)) return;
    w.how = 'abdicated';
    rulers.succession(world, civ, 'abdicated', {}, { key: 'myth.abdicate', imp: 3, tags: ['wasting'] });
    return;
  }
  if (w.path === 'cure') { cureYear(world, st, civ, w); return; }
  // enduring: the realm loses faith in its ruler, the knives come out (civ/ambitions.js), and in
  // the end the great of the realm may depose them
  addEffect(world, { kind: 'civ', id: civ.id }, { k: 'myth.endure', until: world.time.day + Y + 60, m: { stability: -0.05 }, label: 'A wounded ruler' });
  civ.legitimacy = Math.max(0, fin(civ.legitimacy, 0.5) - 0.03);
  w.ky = (w.ky || 0) + 1;
  if (!rulers || !world.rng.chance(Math.min(0.3, 0.05 + 0.02 * w.ky))) return;
  const res = rulers.overthrow(world, civ, null, 'coup');
  if (res && res.ruler) tellCiv(world, civ, { cat: 'civ', imp: 3, key: 'myth.deposed', text: `The great of ${theName(civ)} would wait no longer: they deposed ${rulerShort(r)}, whose wound was wasting the land, and raised ${rulerShort(res.ruler)} in ${pron(r)} place.` });
}

function cureYear(world, st, civ, w) {
  const r = civ.ruler;
  const cups = treasures ? treasures.healingCups(world) : [];
  const mine = cups.find((c) => c.civId === civ.id);
  const lent = !mine ? cups.find((c) => c.civId !== civ.id && world.civs[c.civId] && world.civs[c.civId].alive && !areAtWar(world, civ.id, c.civId) && fin(world.civs[c.civId].relations[civ.id] && world.civs[c.civId].relations[civ.id].opinion) > 25) : null;
  const known = civ.tech && civ.tech.known;
  const healArt = Boolean(known && (known.moonweaving != null || knowsSchool(civ, 'hearth')));
  const rel = civ.stateReligion != null ? world.religions[civ.stateReligion] : null;
  const holy = rel && rel.holyCityId != null && world.settlements[rel.holyCityId] && world.settlements[rel.holyCityId].alive ? world.settlements[rel.holyCityId] : null;
  const src = [];
  if (mine) src.push([0.5, `with ${mine.t.n}`]);
  if (lent) src.push([0.25, `with ${lent.t.n}, lent by ${civName(world.civs[lent.civId])}`]);
  if (healArt) src.push([0.12, 'by the healing arts of its own wise ones']);
  if (holy) src.push([0.06, `on a pilgrimage to ${holy.name}`]);
  for (const [p, how] of src) {
    if (!world.rng.chance(p)) continue;
    w.gone = world.time.day; w.how = 'cured';
    r.flags.wound.h = world.time.day;
    r.flags.wound.k = 0;   // healed: no more plots for it
    tellCiv(world, civ, { cat: 'myth', imp: 3, key: 'myth.cured', text: `The wound of ${rulerShort(r)} of ${theName(civ)} was healed ${how}, and the land began to heal with ${r.gender === 'f' ? 'her' : 'him'}.` });
    return;
  }
  // a cup held by a realm that will not lend it may be taken
  if (!mine && !lent && war && enemySet(world, civ.id).size === 0) {
    const far = cups.find((c) => { const o = world.civs[c.civId]; return o && o.alive && c.civId !== civ.id && o.relations[civ.id] && o.relations[civ.id].border > 0; });
    const hc = far ? capitalOf(world, world.civs[far.civId]) : null;
    if (far && hc && world.rng.chance(0.25)) {
      const wr = war.startWarNamed(world, [civ.id], [far.civId], 'cure', `the War for ${far.t.n}`, { goalSid: hc.id });
      if (wr) tellCiv(world, civ, { cat: 'war', imp: 3, key: 'myth.cureWar', ref: { k: 'war', id: wr.id }, text: `${capFirst(civName(world.civs[far.civId]))} would not lend ${far.t.n}, and ${theName(civ)} went to war to take the cup that might heal its ruler.` });
    }
  }
  if (++w.cy >= 6) {
    w.path = 'endure';
    tellCiv(world, civ, { cat: 'myth', imp: 2, key: 'myth.endure', text: `No healer could close the wound of ${rulerShort(r)} of ${theName(civ)}; ${pron(r)} court gave up hope of a cure, and began to whisper.` });
  }
}

// the reign of a wounded ruler ends: how (a murder leaves guilt, and a kinslayer may be wounded too)
on('rulerDied', (world, civ, prev, cause) => {
  const st = peek(world);
  const w = st && st.wast && civ ? st.wast[civ.id] : null;
  if (w && prev && prev.id === w.r && w.gone == null) w.cause = cause;
});
on('succession', (world, civ, prev, nr, how) => {
  const st = peek(world);
  const w = st && st.wast && civ ? st.wast[civ.id] : null;
  if (!w || !prev || prev.id !== w.r || w.gone != null) return;
  const day = world.time.day;
  w.gone = day;
  const kin = w.cause === 'usurped' || how === 'usurper';
  w.how = w.how === 'abdicated' || w.cause === 'abdicated' ? 'abdicated' : kin ? 'murder' : how === 'coup' ? 'coup' : w.cause || how || 'gone';
  if (!nr || !(kin || how === 'coup') || w.lv <= 0) return;
  (nr.flags ||= {}).guilt = day;
  if (kin && world.rng.chance(1 / 3)) {
    const lv = w.lv * 0.6, rad = w.rad, x = w.x, y = w.y;
    delete st.wast[civ.id];
    if (woundRuler(world, civ, 'kinslaying', null, { force: true, lv, rad, victim: rulerShort(prev) })) Object.assign(st.wast[civ.id], { x, y, s0: day });
  }
});

// the hand's: a curse on a ruler (civ/acts.js Curse Ruler), and a grave-plague with no caster (the Plague power)
on('handWound', (world, civ) => { woundRuler(world, civ, 'hand', null, { force: true }); });
on('plagueStarted', (world, p) => {
  if (!p || p.cause !== 'grave' || p.by != null || !isMythic(world) || !world.sys.myth || world.sys.myth.v == null) return;
  const st = state(world);
  const s = world.settlements[p.originSid];
  if (!st.g && s) st.g = { pid: p.id, by: -1, w: -1, r: -1, sid: s.id, x: s.x, y: s.y, day: world.time.day, pop: Math.round(s.population) };
});

// an oath broken
on('betrayal', (world, a, b) => {
  if (!a || !isMythic(world) || !world.sys.myth || world.sys.myth.v == null || !world.rng.chance(0.012)) return;
  woundRuler(world, a, 'oath', b ? b.id : null);
});
// a holy city, or a town on a ley node, razed
on('townRazed', (world, q) => {
  if (!q || !isMythic(world) || !world.sys.myth || world.sys.myth.v == null) return;
  const s = world.settlements[q.sid], att = world.civs[q.att];
  if (!s || !att) return;
  const holy = world.religions.some((r) => r && r.alive !== false && r.holyCityId === s.id);
  const node = !holy && (world.sites || []).some((x) => x && x.kind === 'node' && Math.abs(x.x - s.x) <= 2 && Math.abs(x.y - s.y) <= 2);
  if ((holy || node) && world.rng.chance(holy ? 0.05 : 0.03)) woundRuler(world, att, 'desecration', s.civId, { place: holy ? `the holy city of ${s.name}` : `${s.name} on the ley-stones` });
});
// a dragon or a host of the dead at the gates of the seat
on('bandRaid', (world, q) => {
  if (!q || q.sid == null || !isMythic(world) || !world.sys.myth || world.sys.myth.v == null) return;
  const s = world.settlements[q.sid];
  const civ = s ? world.civs[s.civId] : null;
  if (!civ || civ.capitalId !== s.id) return;
  const band = (world.bands || []).find((b) => b && b.id === q.bandId);
  if (!band || (band.kind !== 'dragon' && band.kind !== 'undead') || !world.rng.chance(band.kind === 'dragon' ? 0.012 : 0.008)) return;
  woundRuler(world, civ, 'beast', null, { what: band.kind === 'dragon' ? 'a dragon' : 'the walking dead' });
});

/** A desperate dark realm with no city to strike may curse the enemy's ruler instead. */
function curseYear(world, st, civ) {
  if (!war || !wouldCast(world, civ)) return;
  const d = despair(world, civ);
  if (d.v < 0.3 || !d.w || !world.rng.chance(0.05 * d.v)) return;
  const side = war.sideOf(d.w, civ.id);
  const foeId = (side > 0 ? d.w.defenders : d.w.attackers)[0];
  const foe = foeId != null ? world.civs[foeId] : null;
  if (foe && foe.alive) woundRuler(world, foe, 'curse', civ.id);
}

const pickT = (world, arr) => arr[Math.floor(world.rng.next() * arr.length)];


// ---------------------------------------------------------------------------
// The Scourge

const SCOURGE_AT = 0.01;     // its power as a share of the world's people, to be named
const DARK_YEARS = 25;       // years named before its darkness can fall
const DARK_R = 35;           // the reach of its region

/** A risen host's potential: its maker's art × the magic where it rose × the dead to hand. Pure. */
function potentialOf(world, site, art) {
  const mana = manaAt(world, site.x, site.y);
  let dead = fin(site.dead);
  for (const g of world.sites) {
    if (g.kind !== 'grave' || g.id === site.id || (g.data && g.data.risen) || Math.abs(g.x - site.x) > 20 || Math.abs(g.y - site.y) > 20) continue;
    dead += fin(g.dead);
  }
  return art * (0.5 + mana) * clamp(Math.log10(Math.max(1, dead) / 500), 0, 2);
}

on('undeadRisen', (world, band, site, opts) => {
  if (!band || !site || !isMythic(world) || !world.sys.myth || world.sys.myth.v == null) return;
  const pot = potentialOf(world, site, Number.isFinite(opts && opts.art) ? opts.art : 0.15);
  if (pot < 0.25) return;
  band.data.sc = { pot: Math.round(pot * 100) / 100, cm: 1 + 4 * Math.min(1, pot), n: 0, born: world.time.day };
  const st = state(world);
  st.n.scBorn = (st.n.scBorn || 0) + 1;
});

const scourges = (world) => (world.bands || []).filter((b) => b && b.kind === 'undead' && b.data && b.data.sc);
const placeOf = (world, band) => {
  const site = band.data.grave != null ? world.sites.find((x) => x && x.id === band.data.grave) : null;
  const m = site && site.name ? /^the (?:Plague-Pits|Graves|Haunted Ruins) of (.+)$/.exec(site.name) : null;
  if (m) return m[1];
  const t = settlementsNear(world, band.x, band.y, 12)[0];
  return t ? t.name : 'the Waste';
};
const tellBand = (world, band, e) => chronicle(world, { x: band.x, y: band.y, ref: { k: 'band', id: band.id }, icon: 'plague', tags: ['scourge'], ...e });

/** The art a master holds a Scourge by, as a share of the world's people it can hold. */
const holdOf = (civ) => (civ && civ.alive ? (fin(civ.mods && civ.mods.necromancy) + 0.5 * fin(civ.mods && civ.mods.arcana)) * 0.03 : 0);

function nameScourge(world, st, band, wp) {
  const sc = band.data.sc;
  sc.named = world.time.day;
  const old = band.name;
  band.name = `the Scourge of ${placeOf(world, band)}`;
  st.n.scourge = (st.n.scourge || 0) + 1;
  const b = band.data.bound;
  const master = b ? world.civs[b.c] : null;
  let held = false;
  if (master && master.alive) {
    // a master holds it only by great art; most Scourges break free
    const art = fin(master.mods && master.mods.necromancy) + 0.5 * fin(master.mods && master.mods.arcana);
    held = world.rng.chance(clamp((art - 0.5) / 1, 0, 0.6)) && band.power <= holdOf(master) * wp;
    if (held) { b.hold = 1; b.u = world.time.day + 500 * Y; sc.held = master.id; }
    else { band.data.bound = null; delete band.data.bound; band.civId = -1; }
  }
  tellBand(world, band, {
    cat: 'myth', imp: 4, key: 'myth.scourge',
    text: `${capFirst(old)} had grown past all reckoning: ${sc.n} towns had fallen to it, and the living began to call it ${band.name}.${master && master.alive ? held ? ` The necromancers of ${civName(master)} still held it in their grip.` : ` It no longer answered to ${civName(master)}.` : ''}`,
  });
}

function scourgeMonth(world, st) {
  const day = world.time.day, yearly = monthOf(world) === 9;
  // a darkness lifts slowly, fifteen years after its Scourge's end
  if (yearly && st.dark) for (const id of Object.keys(st.dark)) {
    const D = st.dark[id];
    if (world.bands.some((b) => b && b.id === +id)) continue;
    delete st.dark[id];
    darkLand(world, D, day + 15 * Y);
    chronicle(world, { x: D.x, y: D.y, icon: 'cure', tags: ['scourge'], cat: 'myth', imp: 3, key: 'myth.dawn', text: `The dead no longer walked the lands where the darkness had fallen; it would be a generation before the fields and roads came back.` });
  }
  const list = scourges(world);
  if (!list.length) return;
  const wp = engine ? engine.worldPop(world) : 1e6;
  for (const band of list) {
    const sc = band.data.sc;
    if (!sc.named) {
      if (band.state !== 'sleep' && band.power >= SCOURGE_AT * wp && fin(sc.n) >= 3) nameScourge(world, st, band, wp);
      continue;
    }
    if (yearly) heroesYear(world, st, band, wp);
    if (!world.bands.includes(band)) continue;   // destroyed
    if (yearly && sc.dark) darkLand(world, sc.dark, day + 2 * Y);   // its region stays dark while it lives, waking or sleeping
    if (band.state === 'sleep') { if (yearly) expeditionYear(world, band, wp); continue; }
    // a held Scourge that outgrows its master's art breaks free
    const b = band.data.bound;
    if (b && b.hold && band.power > holdOf(world.civs[b.c]) * wp) {
      const m = world.civs[b.c];
      band.data.bound = null; delete band.data.bound; band.civId = -1; sc.held = null;
      tellBand(world, band, { cat: 'myth', imp: 3, key: 'myth.scourgeFree', text: `${capFirst(band.name)} outgrew the art that bound it, and turned on ${m ? civName(m) : 'its makers'} first.` });
    }
    // it blights the land around it, and its neighbours hunt it together
    const th = [];
    for (const s of settlementsNear(world, band.x, band.y, 25)) {
      const d = Math.hypot(s.x - band.x, s.y - band.y);
      if (d <= 8) addEffect(world, { kind: 'settlement', id: s.id }, { k: 'myth.scourge', until: day + 3 * Y, m: { foodYield: 0.7, attract: 0.4, happiness: -0.1, unrest: 0.1 }, label: `Under ${band.name}` });
      if (s.civId >= 0 && s.civId !== band.civId && !th.includes(s.civId)) th.push(s.civId);
    }
    const f = world.f, W = world.W;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = Math.round(band.x) + dx, y = Math.round(band.y) + dy;
      if (x < 0 || y < 0 || x >= W || y >= world.H) continue;
      const j = y * W + x;
      if (f.devastation && f.water[j] === WATER.LAND) f.devastation[j] = Math.min(1, f.devastation[j] + 0.05);
    }
    sc.th = th.slice(0, 12);
    if (engine) for (const id of sc.th) engine.noteRaid(world, band, id);
    if (!sc.ally && th.length >= 2) {
      sc.ally = day;
      st.n.alliance = (st.n.alliance || 0) + 1;
      const names = th.slice(0, 4).map((id) => civName(world.civs[id]));
      tellBand(world, band, { cat: 'war', imp: 3, key: 'myth.alliance', text: `Old quarrels were set aside as ${listJoin(names)} made common cause against ${band.name}.` });
    }
    if (yearly) darknessYear(world, st, band, wp);
  }
}

/** An age of darkness on its region, and the Age of the Dead if it carries its war far beyond. */
function darknessYear(world, st, band, wp) {
  const sc = band.data.sc, day = world.time.day;
  if (!sc.dark) {
    if (day - sc.named < DARK_YEARS * Y || !(fin(sc.razed) >= 8 || fin(sc.realms) >= 1 || fin(sc.dead) >= 0.06 * wp)) return;
    sc.dark = { x: Math.round(band.x), y: Math.round(band.y), r: DARK_R, day };
    (st.dark ||= {})[band.id] = sc.dark;
    st.n.dark = (st.n.dark || 0) + 1;
    tellBand(world, band, { cat: 'myth', imp: 5, key: 'myth.darkness', text: `For a generation ${band.name} had walked unchecked; now a darkness fell on all the lands around ${placeOf(world, band)}. The fields went to thorn, the roads emptied, and the realms there sank into an age of darkness.` });
  }
  const D = sc.dark;
  for (const civ of liveCivs(world)) {
    const cap = capitalOf(world, civ);
    if (cap && Math.hypot(cap.x - D.x, cap.y - D.y) <= D.r && stability) stability.beginDarkAge(world, civ, 'dead');
  }
  // carried far beyond its region, or grown beyond all measure: the Age of the Dead
  if (!sc.age && ages && (band.power >= 0.018 * wp || (sc.civs || []).length >= 6 || Math.hypot(band.x - D.x, band.y - D.y) > D.r + 10)) {
    sc.age = day;
    st.n.age = (st.n.age || 0) + 1;
    ages.forceAge(world, 'dead', {}, 40);
  }
}
function darkLand(world, D, until) {
  for (const s of settlementsNear(world, D.x, D.y, D.r)) addEffect(world, { kind: 'settlement', id: s.id }, { k: 'myth.darkness', until, m: { foodYield: 0.8, attract: 0.6, happiness: -0.05 }, label: 'The age of darkness' });
}

/** Now and then a company of heroes of a threatened realm goes against it, with better odds while it sleeps. */
function heroesYear(world, st, band, wp) {
  if (!hunts || !engine) return;
  const sc = band.data.sc;
  if (sc.hy != null && world.time.day - sc.hy < 5 * Y) return;
  const near = settlementsNear(world, band.x, band.y, 25).filter((s) => s.civId >= 0 && s.civId !== band.civId);
  if (!near.length || !world.rng.chance(0.3)) return;
  sc.hy = world.time.day;
  near.sort((a, b) => b.population - a.population || a.id - b.id);
  const civ = world.civs[near[0].civId];
  const base = Math.max(60, 0.004 * wp);
  const asleep = band.state === 'sleep';
  const p = clamp(0.3 * Math.sqrt(base / Math.max(1, band.power)) + (asleep ? 0.15 : 0) + 0.1 * fin(civ.mods && civ.mods.arcana), 0.02, 0.6);
  const n = 3 + Math.floor(world.rng.next() * 4);
  if (world.rng.chance(p)) {
    st.n.heroes = (st.n.heroes || 0) + 1;
    hunts.slay(world, band, civ, { how: 'hero', company: n - 1, lost: Math.floor(world.rng.next() * (n - 1)) });
    return;
  }
  band.data.heroes = (band.data.heroes || 0) + 1;
  tellBand(world, band, { cat: 'myth', imp: 2, key: 'myth.heroesFell', civId: civ.id, text: `A company of ${n} heroes of ${civName(civ)} went ${asleep ? 'down into the barrow of' : 'against'} ${band.name}, and none of them came back.` });
}

/** A sleeping Scourge that has weakened enough draws an expedition from a strong realm nearby (bands/hunts.js). */
function expeditionYear(world, band, wp) {
  if (!engine) return;
  const bp = engine.bandPower(band);
  let best = null, bpow = 0;
  for (const s of settlementsNear(world, band.x, band.y, 20)) {
    const civ = world.civs[s.civId];
    if (!civ || !civ.alive) continue;
    const p = engine.civPowerOf(world, civ);
    if (p > bpow) { bpow = p; best = civ; }
  }
  if (best && bpow >= 1.5 * bp && world.rng.chance(0.3)) engine.noteRaid(world, band, best.id);
}

// ---------------------------------------------------------------------------
// Providers (pure, neutral outside a Mythic world)

// realms that a Scourge threatens want war with each other less
registerProvider('warAppetite', 'myth-scourge', (w, a, b) => {
  if (!w.bands || !w.bands.length || !isMythic(w)) return 1;
  const ia = idOf(a), ib = idOf(b);
  for (const band of w.bands) {
    const sc = band && band.kind === 'undead' && band.data && band.data.sc;
    if (sc && sc.named && band.state !== 'sleep' && sc.th && sc.th.includes(ia) && sc.th.includes(ib)) return 0.6;
  }
  return 1;
});

// the Wasting's blame, while the cause is hidden: a minority persecuted, a neighbour hated
const blamed = (w, civ) => { const st = peek(w); const x = st && st.wast && civ ? st.wast[civ.id] : null; return x && x.kn < 2 && x.gone == null ? x : null; };
registerProvider('minorityRule', 'myth-wasting', (w, civ, people) => { const x = blamed(w, civ); return x && x.bl === 'minority' && x.bk === people ? 'persecuted' : null; });
registerProvider('opinion', 'myth-wasting', (w, a, b) => {
  const A = typeof a === 'object' ? a : w.civs[a];
  const x = blamed(w, A);
  return x && x.bl === 'neighbour' && x.bk === idOf(b) ? -25 : 0;
});
registerProvider('casusBelli', 'myth-wasting', (w, a, b) => {
  const x = blamed(w, a);
  return x && b && x.bl === 'neighbour' && x.bk === b.id ? { cb: 'blight', w: 1.5, aim: 'humble' } : null;
});

// mana-burn goes after the magic-touched (geo/health.js plagueWeights)
registerProvider('magicFrailty', 'myth', (w, key) => {
  if (!isMythic(w) || typeof key !== 'string') return 1;
  const r = key.startsWith('r:') ? key.slice(2) : null;
  return r && MAGIC_FRAIL[r] != null ? MAGIC_FRAIL[r] : MAGIC_FRAIL.human;
});

// wards ease the magical sicknesses' deaths; the healing arts ease mana-burn's
registerProvider('damage', 'myth-sick', (w, s, cause) => {
  if (cause !== 'plague' || !s || !s.disease || !isMythic(w)) return 1;
  const p = w.plagues[s.disease.pid];
  if (!p || (p.cause !== 'mana' && p.cause !== 'grave')) return 1;
  const civ = w.civs[s.civId];
  const wards = Math.min(0.9, fin(civ && civ.mods && civ.mods.wards, 0));
  const known = civ && civ.tech && civ.tech.known;
  const heal = p.cause === 'mana' && known && (known.moonweaving != null || knowsSchool(civ, 'hearth')) ? 0.8 : 1;
  return (1 - 0.5 * wards) * heal;
});

// late in the age the magical peoples blame the realms whose smoke is fraying the weave
registerProvider('opinion', 'myth-burn', (w, a, b) => {
  if (!isMythic(w)) return 0;
  const weave = fin(w.sys.myth && w.sys.myth.weave, 1);
  if (weave >= 0.75) return 0;
  const A = typeof a === 'object' ? a : w.civs[a], B = typeof b === 'object' ? b : w.civs[b];
  if (!A || !B || A.id === B.id || fin(B.tech && B.tech.era, 0) < 6) return 0;
  const fr = MAGIC_FRAIL[A.race];
  if (!(fr >= 0.4)) return 0;
  return -20 * fr * Math.min(1, (0.75 - weave) / 0.5);
});

// a bound host near its master's army in battle: + half its power to the army's weight
registerProvider('battle', 'myth-grave', (w, q) => {
  const army = q && q.army;
  if (!army || !w.bands || !w.bands.length || !isMythic(w)) return 1;
  let add = 0;
  for (const b of w.bands) {
    const bd = b.data && b.data.bound;
    if (!bd || bd.c !== army.civId || b.kind !== 'undead') continue;
    if ((b.x - army.x) ** 2 + (b.y - army.y) ** 2 > 100) continue;
    add += 0.5 * (b.power || 0);
  }
  return add > 0 ? 1 + add / Math.max(20, army.strength || 0) : 1;
});

// the world dreads a realm that laid a grave-plague, for about a century
registerProvider('opinion', 'myth-grave', (w, a, b) => {
  const st = peek(w);
  if (!st) return 0;
  const ia = idOf(a), ib = idOf(b);
  const d = st.dread[ib];
  if (d == null || ia === ib) return 0;
  const age = (w.time.day - d) / (100 * Y);
  return age >= 1 ? 0 : -30 * (1 - age);
});

// and may make war on it, for forty years
registerProvider('casusBelli', 'myth-grave', (w, a, b) => {
  const st = peek(w);
  if (!st || !a || !b) return null;
  const d = st.dread[b.id];
  if (d == null || w.time.day - d > 40 * Y || knowsSchool(a, 'necromancy')) return null;
  return { cb: 'dread', w: 1.3 + (healFaith(w, a) ? 0.4 : 0), aim: 'humble' };
});

// its own towns fear their crown for a decade
registerProvider('townGrievance', 'myth-grave', (w, s, civ) => {
  const d = civ && civ.flags ? civ.flags.grave : null;
  if (d == null) return 0;
  const age = (w.time.day - d) / (10 * Y);
  return age >= 1 ? 0 : 0.12 * (1 - age);
});

// ---------------------------------------------------------------------------
// System

export const system = {
  id: 'mythSickness',
  order: 87,

  update(world) {
    if (!isMythic(world) || !world.sys.myth || world.sys.myth.v == null) return;
    if (dayOfMonth(world) !== MONTH_DAY) return;
    const st = state(world);
    graveMonth(world, st);
    scourgeMonth(world, st);
    const m = monthOf(world);
    if (m === 6) manaYear(world, st);
    for (const civ of liveCivs(world).slice()) {
      if (civ.id % 12 !== m || !civ.alive) continue;
      graveYear(world, st, civ);
      curseYear(world, st, civ);
      wastYear(world, st, civ);
    }
    // a fallen realm's Wasting ends with it (its towns' effects run out on their own)
    if (m === 0) for (const id of Object.keys(st.wast)) if (!world.civs[id] || !world.civs[id].alive) delete st.wast[id];
  },

  report(world) {
    const st = peek(world);
    if (!isMythic(world) || !st) return { title: 'Magical sicknesses', lines: ['Not a Mythic world (or nothing yet)'], checks: [] };
    const n = st.n;
    return {
      title: 'Magical sicknesses',
      lines: [
        `Grave-plagues ${fin(n.grave)} (risen ${fin(n.risen)}, leagues ${fin(n.league)}) · mana-burn ${fin(n.mana)} (lands burnt ${fin(n.burnt)}, arts lost ${fin(n.artsLost)}, burnt now ${(st.burns || []).length})`,
        `The Wasting: ${fin(n.wast)} wounds, ${Object.keys(st.wast || {}).length} now`,
        `Scourges: ${fin(n.scBorn)} hosts with the makings, ${fin(n.scourge)} named, ${fin(n.dark)} ages of darkness, ${fin(n.age)} Ages of the Dead, ${fin(n.heroes)} slain by heroes`,
      ],
      checks: [{ ok: !st.g || world.plagues[st.g.pid] != null, label: 'the raging grave-plague is a real plague' }],
    };
  },
};
