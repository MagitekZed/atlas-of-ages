// Bands · dragons (Mythic worlds only) — the headline story.
//   lairs     pinned 'lair' sites on fire-mountains and the highest peaks (or old forest, or
//             sea cliffs), named after the place: "the Wyrmhold of Mount Veist". At most six
//             dragons live at once (about one per 5,000 land tiles at monsterAbundance 1).
//   sleep     20–120 years; awake for 5–30. An eruption nearby wakes a fire drake early.
//   raids     every 4–18 months while awake, on the town within 35 tiles that maximises
//             wealth^0.7 / distance (a town it burned in the last four years is spared,
//             its master's towns too). Fire lights the fields around it; the gold goes to the
//             hoard. A big hoard sends it back to sleep early.
//   age       power × (1 + age/300); past 500 years a dragon becomes an Elder.
//   clutches  two dragons awake within 60 tiles may breed; the wyrmling hatches a decade on.
//   pacts     a greedy or craven ruler burned by a dragon may buy it off: 5 % of the treasury
//             a year, and its fire falls on that realm's rivals instead, until the ruler dies.
//   slain     by hunt, hero or a god's hand: the hoard to the slayer's treasury, prestige, a
//             one-in-four chance of a golden age, dragonbone on the lair tile, the lair renamed
//             "the Bones of X", and the slayer a hero figure called Dragonsbane (or Wyrmslayer …).

import { settlementsNear, getBand, nearestSettlement, addFigure, enemiesOf } from '../../../core/entities.js';
import { addSite, getSite, updateSite, renameSite } from '../../../core/sites.js';
import { addEffect } from '../../../core/effects.js';
import { on } from '../../../core/hooks.js';
import { emitFx } from '../../../core/world.js';
import { mythOn } from '../../../core/params.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH, WATER, BIOME } from '../../../core/constants.js';
import { latitude } from '../../../core/world.js';
import { clamp, clamp01 } from '../../../core/util.js';
import { registerKind, spawnBand, endBand, state, ready, isReady, aliveOf } from '../engine.js';
import { planRoute, planHome, links } from '../move.js';
import { raidTown } from '../combat.js';
import { dragonName, lairName, heroName, slayerTitle } from '../names.js';
import { wildAt, tamedMonth, tamedDay, feral, landCount } from './beasts.js';
import { say, pick, pickFresh, cap, civName, CivName, rulerOf, count, money, when, bandName, BandName } from '../prose.js';

export const MAX_DRAGONS = 6;
const POWER = { fire: [1800, 3600], frost: [1500, 3200], green: [1300, 2800], sea: [1600, 3400] };
const LAIR_GAP = 20;
const HOARD_SLEEP = 2500;          // gold gained in one waking that sends a dragon back to sleep
const Y = DAYS_PER_YEAR, M = DAYS_PER_MONTH;

const weave = (world) => (Number.isFinite(world.sys.myth?.weave) ? world.sys.myth.weave : 1);
const ageOf = (world, band) => (world.time.day - (band.data.born ?? band.createdDay)) / Y;

/** How many dragons this world holds (1–6). */
export function dragonTarget(world) {
  const land = landCount(world);
  return clamp(Math.round(Math.max(0, world.params.monsterAbundance ?? 1) * weave(world) * land / 5000), 1, MAX_DRAGONS);
}

function lairsNear(world, x, y, r) {
  for (const s of world.sites) if (s.kind === 'lair' && !s.data?.slain && (s.x - x) ** 2 + (s.y - y) ** 2 < r * r) return true;
  return false;
}

/** A place for a lair: { i, variety, volcano }. Fire-mountains first, then the highest wild peaks, then deep woods. */
function findLair(world, near = null) {
  const { W, H, f } = world;
  const rng = world.rng;
  const vols = (world.volcanoes || []).slice();
  if (!near) {
    for (let k = vols.length - 1; k > 0; k--) { const j = Math.floor(rng.next() * (k + 1)); const t = vols[k]; vols[k] = vols[j]; vols[j] = t; }
    for (const v of vols) {
      const i = Number.isFinite(v.i) ? v.i : v.y * W + v.x;
      if (f.water[i] !== WATER.LAND || lairsNear(world, v.x, v.y, LAIR_GAP) || !wildAt(world, v.x, v.y, 4)) continue;
      return { i, variety: 'fire', volcano: v };
    }
  }
  let best = null, be = 0;
  for (let k = 0; k < 260; k++) {
    let x, y;
    if (near) { x = clamp(Math.round(near.x + rng.float(-15, 15)), 2, W - 3); y = clamp(Math.round(near.y + rng.float(-15, 15)), 2, H - 3); }
    else { x = rng.int(2, W - 3); y = rng.int(2, H - 3); }
    const i = y * W + x;
    if (f.water[i] !== WATER.LAND || f.settle[i] >= 0) continue;
    const e = f.elevation[i];
    if (e < 0.74 || e <= be) continue;
    if (lairsNear(world, x, y, near ? 6 : LAIR_GAP) || !wildAt(world, x, y, near ? 3 : 5)) continue;
    best = i; be = e;
  }
  if (best != null) {
    const lat = Math.abs(latitude(world, (best / W) | 0));
    const coast = f.coast[best] || (f.distCoast && f.distCoast[best] <= 2);
    const variety = lat > 0.55 || f.biome[best] === BIOME.ICE ? 'frost' : coast && rng.chance(0.5) ? 'sea' : rng.chance(0.65) ? 'fire' : 'frost';
    return { i: best, variety, volcano: null };
  }
  for (let k = 0; k < 120; k++) {
    const x = rng.int(2, W - 3), y = rng.int(2, H - 3);
    const i = y * W + x;
    if (f.water[i] !== WATER.LAND || f.settle[i] >= 0 || f.veg[i] < 0.7) continue;
    if (lairsNear(world, x, y, LAIR_GAP) || !wildAt(world, x, y, 5)) continue;
    return { i, variety: 'green', volcano: null };
  }
  return null;
}

/** A dragon in its lair. opts: { asleep, young, parent, quiet } */
export function spawnDragon(world, lair, opts = {}) {
  const rng = world.rng;
  const day = world.time.day;
  const x = lair.i % world.W, y = (lair.i / world.W) | 0;
  const variety = opts.variety || lair.variety;
  const [lo, hi] = POWER[variety] || POWER.fire;
  const base = Math.round(rng.float(lo, hi) * (opts.young ? 0.3 : 1));
  const age = opts.young ? 0 : rng.int(60, 480);
  const nm = dragonName(world, variety, x, y);
  const site = addSite(world, { kind: 'lair', x, y, i: lair.i, name: lairName(world, variety, x, y, lair.volcano, nm.name), data: { bandId: -1, variety, hoard: 0 } });
  const asleep = opts.asleep ?? rng.chance(0.65);
  const band = spawnBand(world, {
    kind: 'dragon', name: nm.name, epithet: age >= 500 ? 'the Elder' : nm.epithet, x, y, homeI: lair.i, homeR: 35,
    state: asleep ? 'sleep' : 'lair', strength: 0, power: Math.round(base * (1 + age / 300)), morale: 1,
    loot: opts.young ? 0 : Math.round(rng.float(200, 1500)),
    data: {
      lair: site.id, lairI: lair.i, variety, base, born: day - age * Y, elder: age >= 500, pact: null, clutch: null, towns: {}, gained: 0,
      sleepUntil: asleep ? day + rng.int(5, 120) * Y : 0, awakeUntil: asleep ? 0 : day + rng.int(5, 30) * Y,
      nextRaid: day + rng.int(1, 6) * M, parent: opts.parent ?? null, wakings: asleep ? 0 : 1, heroes: 0, last: day,
    },
  });
  updateSite(world, site.id, { bandId: band.id, hoard: band.loot });
  return band;
}

/** The first Mythic month: the old dragons are already in their lairs. */
export function seedDragons(world) {
  const n = dragonTarget(world) - aliveOf(world, 'dragon');
  const made = [];
  for (let k = 0; k < n; k++) {
    const lair = findLair(world);
    if (!lair) break;
    made.push(spawnDragon(world, lair, {}));
  }
  if (!made.length) return;
  const parts = made.map((b) => `${bandName(b)} in ${getSite(world, b.data.lair)?.name || 'a lair of its own'}`);
  const list = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  const first = made[0];
  say(world, first, {
    cat: 'myth', imp: 3, key: 'dragon.lairs',
    text: pick(world, [
      `Dragons lair in the high places of ${world.name}: ${list}.`,
      `The old songs named the dragons of ${world.name}, and they were not wrong: ${list}.`,
    ]),
  });
}

function spawn(world) {
  // once in a long while a new dragon comes, when the world has fewer than it can hold
  if (aliveOf(world, 'dragon') >= Math.min(MAX_DRAGONS, dragonTarget(world))) return;
  if (!isReady(world, 'dragonCome', 150 * Y) || !world.rng.chance(0.004)) return;
  const lair = findLair(world);
  if (!lair) return;
  state(world).cd.dragonCome = world.time.day;
  const band = spawnDragon(world, lair, { asleep: false });
  say(world, band, {
    cat: 'myth', imp: 3, key: 'dragon.come', ref: { k: 'band', id: band.id },
    text: pick(world, [
      `A dragon came out of the north and made its lair in ${getSite(world, band.data.lair)?.name}: ${bandName(band)}.`,
      `${when(world, band.y)}, ${bandName(band)} flew in from beyond the edge of the maps and settled in ${getSite(world, band.data.lair)?.name}.`,
    ]),
  });
}

// ---------------------------------------------------------------------------
// Waking, sleeping, raiding

export function wake(world, band, cause = 'time', causeSeq = null) {
  const rng = world.rng;
  const day = world.time.day;
  band.state = 'lair';
  band.data.woke = day;
  band.data.awakeUntil = day + rng.int(5, 30) * Y;
  band.data.nextRaid = day + rng.int(1, 6) * M;
  band.data.gained = 0;
  band.data.wakings = (band.data.wakings || 0) + 1;
  band.data.first = 1;
  const lair = getSite(world, band.data.lair);
  const near = nearestSettlement(world, band.x, band.y, { maxDist: 40 });
  const slept = Math.max(1, Math.round((day - (band.data.slept || band.createdDay)) / Y));
  emitFx(world, { type: 'dragonfire', x: band.x, y: band.y, r: 1.5, intensity: 0.5, x2: band.x, y2: band.y - 2 });
  // a sleep of generations broken is major news, one of a lifetime notable; a doze of a few
  // decades is told only in the folded annals
  const imp = slept >= 80 ? 3 : slept >= 40 ? 2 : 1;
  const L = lair?.name || 'its lair';
  say(world, band, {
    cat: 'myth', imp, fold: imp < 2, key: 'dragon.wake', cause: causeSeq,
    text: cause === 'eruption'
      ? pickFresh(world, band, 'wake', [
        `The mountain's fire woke ${bandName(band)}; it rose out of ${L} in a pillar of smoke.`,
        `As the earth burst open, ${bandName(band)} stirred in ${L} and came out hungry.`,
        `Ash and thunder roused ${bandName(band)} from a sleep of ${count(slept)} years${near ? `, and the people of ${near.name} watched two fires on the mountain` : ''}.`,
        `${when(world, band.y)}, the burning mountain shook ${bandName(band)} awake in ${L}.`,
      ])
      : pickFresh(world, band, 'wake', [
        `After ${count(slept)} years of sleep, ${bandName(band)} stirred in ${L}${near ? `; the herdsmen of ${near.name} saw smoke on the peak` : ''}.`,
        `${when(world, band.y)}, ${bandName(band)} woke${near ? ', and the people of ' + near.name + ' prayed it would fly the other way' : ''}.`,
        `${cap(bandName(band))} came out of ${L} for the first time in ${count(slept)} years.`,
        `The shepherds above ${near ? near.name : 'the high valleys'} found their flocks scattered and the snow on ${L} melted: ${bandName(band)} was awake.`,
        `${slept >= 80 ? `No one living remembered ${bandName(band)} but from songs` : `${cap(bandName(band))} had slept ${count(slept)} years`}; ${when(world, band.y).replace(/^In/, 'in')} it spread its wings over ${near ? near.name : 'the land'} again.`,
      ]),
  });
}

function sleep(world, band, why = 'sated') {
  const rng = world.rng;
  band.state = 'sleep';
  band.path = null;
  band.data.sleepUntil = world.time.day + rng.int(20, 120) * Y;
  band.data.slept = world.time.day;
  band.data.first = 0;
  const lair = getSite(world, band.data.lair);
  if (lair) updateSite(world, lair.id, { hoard: Math.round(band.loot || 0) });
  if (ready(world, `dsl${band.id}`, 5 * Y)) {
    say(world, band, {
      cat: 'myth', imp: 1, fold: true, key: 'dragon.sleep',
      text: why === 'wounded'
        ? `${BandName(band)} crawled back into ${lair?.name || 'its lair'} to sleep off its wounds.`
        : pick(world, [`${BandName(band)} withdrew into ${lair?.name || 'its lair'} and slept upon its gold.`, `Sated, ${bandName(band)} coiled about a hoard of ${money(band.loot)} and slept.`]),
    });
  }
}

/** The town within 35 tiles that maximises wealth^0.7 / distance (with the pact's preferences). */
function chooseTarget(world, band) {
  const day = world.time.day;
  const pact = band.data.pact;
  const patron = pact ? world.civs[pact.civId] : null;
  const foes = patron ? new Set(enemiesOf(world, patron.id)) : null;
  const towns = band.data.towns || (band.data.towns = {});
  const loot = band.data.tl || (band.data.tl = {});
  // the memory of old raids fades after fifteen years
  for (const k of Object.keys(towns)) if (day - towns[k] >= 15 * Y) { delete towns[k]; delete loot[k]; }
  let best = null, bs = 0;
  for (const s of settlementsNear(world, band.x, band.y, 35)) {
    if ((s.tier | 0) < 1 || (towns[s.id] != null && day - towns[s.id] < 4 * Y)) continue;
    if (patron && s.civId === patron.id) continue;
    let sc = Math.pow(Math.max(1, (s.wealth || 0) + 0.05 * s.population), 0.7) / Math.max(3, Math.hypot(s.x - band.x, s.y - band.y));
    // a town burned lately has less to give, the more so if it gave little last time
    if (towns[s.id] != null) sc *= 0.25;
    if (loot[s.id] != null && loot[s.id] < 100) sc *= 0.5;
    if (patron) {
      const op = patron.relations?.[s.civId]?.opinion ?? 0;
      if (foes.has(s.civId)) sc *= 3; else if (op < 0) sc *= 1.5; else sc *= 0.3;
    }
    if (sc > bs) { bs = sc; best = s; }
  }
  return best;
}

function month(world, band) {
  const day = world.time.day;
  const d = band.data;
  if (band.state === 'tamed') { tamedMonth(world, band); return; }
  if (band.state === 'sleep') { if (day >= (d.sleepUntil || 0)) wake(world, band); return; }
  if (band.state !== 'lair') return;
  if ((band.hp ?? 1) < 0.4) { sleep(world, band, 'wounded'); return; }
  if (day >= (d.awakeUntil || 0) || (d.gained || 0) >= HOARD_SLEEP) { sleep(world, band); return; }
  if (day < (d.nextRaid || 0)) return;
  const s = chooseTarget(world, band);
  if (!s) { d.nextRaid = day + 6 * M; return; }
  band.targetSid = s.id;
  planRoute(world, band, s.i);
  band.state = 'raid';
}

function arrive(world, band) {
  if (band.state === 'return' || band.state === 'roam') { band.state = 'lair'; band.path = null; band.x = band.homeI % world.W; band.y = (band.homeI / world.W) | 0; return; }
  const s = band.targetSid >= 0 ? world.settlements[band.targetSid] : null;
  if (s && s.alive) dragonRaid(world, band, s);
  band.targetSid = -1;
  if (!getBand(world, band.id)) return;
  band.data.nextRaid = world.time.day + world.rng.int(4, 18) * M;
  band.state = 'return';
  planHome(world, band);
}

function dragonRaid(world, band, s) {
  const rng = world.rng;
  const civ = world.civs[s.civId];
  const pop0 = s.population;
  const hoard0 = band.loot || 0;
  const r = raidTown(world, band, s, { quiet: true, sevBonus: 0.15 });
  (band.data.towns ||= {})[s.id] = world.time.day;
  const first = band.data.first;
  band.data.first = 0;
  const lair = getSite(world, band.data.lair);
  const from = { x: band.homeI % world.W, y: (band.homeI / world.W) | 0 };
  emitFx(world, { type: 'dragonfire', x: s.x, y: s.y, r: 2.2, intensity: r.ok ? 1 : 0.6, x2: s.x + (from.x - s.x) * 0.15 + 1.5, y2: s.y + (from.y - s.y) * 0.15 - 1.5 });
  if (!r.ok) {
    if (ready(world, `drp${band.id}`, 3 * Y)) {
      say(world, band, {
        cat: 'myth', imp: 3, key: 'dragon.repulsed', x: s.x, y: s.y, civId: s.civId, sid: s.id,
        text: pickFresh(world, band, 'raid', [
          `${BandName(band)} came down upon ${s.name}, but the great bows on its walls drove it off, bleeding.`,
          `The people of ${s.name} stood their walls against ${bandName(band)}; it burned the outer fields and fled wounded to ${lair?.name || 'its lair'}.`,
        ]),
      });
    }
    return;
  }
  // fire takes the fields and roofs around the town
  const eco = links.eco;
  if (eco && typeof eco.ignite === 'function') {
    const n = rng.int(3, 6);
    for (let k = 0; k < n; k++) {
      const x = clamp(Math.round(s.x + rng.float(-2.5, 2.5)), 0, world.W - 1), y = clamp(Math.round(s.y + rng.float(-2.5, 2.5)), 0, world.H - 1);
      const i = y * world.W + x;
      if (world.f.water[i] === WATER.LAND && world.f.veg[i] > 0.08) { try { eco.ignite(world, i, 0.8); } catch (e) { break; } }
    }
  }
  const gold = (band.loot || 0) - hoard0;
  band.data.gained = (band.data.gained || 0) + gold;
  (band.data.tl ||= {})[s.id] = Math.round(gold);
  if (lair) updateSite(world, lair.id, { hoard: Math.round(band.loot || 0) });
  // the waking itself was news; a raid is great news only when it burns a city or a great many,
  // and notable only as the first of a waking, or when it kills many or strikes a real town
  // (and then once in twelve years); the rest go to the folded annals
  const big = r.destroyed || ((s.tier | 0) >= 4 && r.deaths >= 40) || r.deaths >= 150;
  let imp = big && ready(world, `dr3${band.id}`, 25 * Y) ? 3 : 2;
  if (imp === 2 && !first && !(r.deaths >= 30 || (s.tier | 0) >= 3)) imp = 1;
  if (imp === 2 && !first && !ready(world, `dr2${band.id}`, 12 * Y)) imp = 1;
  const dead = count(r.deaths);
  const many = Math.round(r.deaths) >= 2;
  const L = lair?.name || 'its lair';
  const place = (s.tier | 0) >= 4 ? 'city' : (s.tier | 0) === 3 ? 'town' : (s.tier | 0) === 2 ? 'village' : 'hamlet';
  const text = r.destroyed
    ? pickFresh(world, band, 'raid', [`${BandName(band)} burned ${s.name} to the ground; of ${count(pop0)} souls, none remained.`, `${when(world, s.y)}, ${bandName(band)} came to ${s.name}, and in the morning there was no ${s.name}.`])
    : pickFresh(world, band, 'raid', [
      `${BandName(band)} came down upon ${s.name} in the night; its granaries burned and its gold was carried off to ${L}.`,
      `${when(world, s.y)}, ${bandName(band)} fell on ${s.name}${many ? `, killing ${dead}` : ''}, and flew back to ${L} with ${money(gold)} in its claws.`,
      `Fire fell on ${s.name}: ${bandName(band)} burned its ${s.tier >= 4 ? 'palaces and temples' : 'roofs and barns'}${many ? `, and ${dead} died in the flames` : ''}.`,
      `The bells of ${s.name} rang too late; ${bandName(band)} was already over the walls${civ ? `, and ${rulerOf(civ)} could only watch the ${place} burn` : ''}.`,
      `A shadow crossed the sun over ${s.name}, and then the fire came: ${bandName(band)} took ${gold >= 1 ? money(gold) : 'what little there was'} and left the ${place} smoking.`,
      `${cap(when(world, s.y))}, ${bandName(band)} circled ${s.name} three times before it stooped${many ? `; ${dead} of its people burned` : ''}, and its treasure went up to ${L}.`,
      `The watchmen of ${s.name} saw the glow on ${L} too late; by dawn ${bandName(band)} had emptied the ${place}'s strongrooms${many ? ` and ${dead} lay dead` : ''}.`,
    ]);
  const entry = say(world, band, { cat: 'myth', imp, fold: imp < 2, key: imp < 2 ? 'dragon.raid.minor' : 'dragon.raid', x: s.x, y: s.y, civId: s.civId, sid: s.id, text });
  if (civ && civ.alive && s.alive) maybePact(world, band, civ, entry);
}

/** A greedy or craven ruler, burned once, offers tribute: the fire falls on the realm's rivals. */
function maybePact(world, band, civ, cause) {
  if (band.data.pact) return;
  const tr = civ.ruler?.traits || [];
  if (!(tr.includes('greedy') || tr.includes('craven')) || (civ.treasury || 0) < 200) return;
  if (!world.rng.chance(0.4)) return;
  band.data.pact = { civId: civ.id, ruler: civ.ruler?.id ?? civ.ruler?.name ?? null, since: world.time.day };
  band.civId = civ.id;
  const R = rulerOf(civ);
  say(world, band, {
    cat: 'myth', imp: 3, key: 'dragon.pact', civId: civ.id, cause: cause ? cause.seq : null,
    text: pick(world, [
      `Rather than see ${civName(civ)} burn again, ${tr.includes('greedy') ? 'the greedy' : 'the fearful'} ${R} bowed before ${bandName(band)} and paid it tribute; thereafter the dragon's fire fell upon the realm's enemies.`,
      `${cap(R)} made a pact with ${bandName(band)}: gold every year, and the dragon would burn the towns of ${civName(civ)}'s rivals instead.`,
    ]),
  });
}

function endPact(world, band, why) {
  const pact = band.data.pact;
  if (!pact) return;
  const civ = world.civs[pact.civId];
  band.data.pact = null;
  band.civId = -1;
  if (civ && civ.alive) {
    say(world, band, {
      cat: 'myth', imp: 2, key: 'dragon.pact.end', civId: civ.id,
      text: why === 'poor'
        ? `${CivName(civ)} could no longer pay ${bandName(band)} its tribute, and the pact was broken; the dragon remembered where the gold had come from.`
        : `The new ruler of ${civName(civ)} would not pay tribute to ${bandName(band)}, and the old pact died with the old ruler.`,
    });
  }
}

function year(world, band) {
  const rng = world.rng;
  const d = band.data;
  const age = ageOf(world, band);
  band.power = Math.round((d.base || 1500) * (1 + age / 300));
  if (band.state === 'tamed') {
    // a bound dragon strains at its chains: each year it may break them
    const civ = world.civs[band.civId];
    if (!civ || !civ.alive || rng.chance(0.06)) { feral(world, band, civ); band.state = 'return'; band.data.pact = null; }
    return;
  }
  if (band.hp < 1) band.hp = clamp01(band.hp + (band.state === 'sleep' ? 0.25 : 0.08));
  if (!d.elder && age >= 500) {
    d.elder = true;
    band.epithet = 'the Elder';
    say(world, band, { cat: 'myth', imp: 3, key: 'dragon.elder', text: pick(world, [`${cap(band.name)} had lived five hundred years; men began to call it ${band.name} the Elder, and spoke its name in whispers.`, `${cap(band.name)} became an Elder of its kind, vast beyond the measure of any living dragon.`]) });
  }
  // the pact's tribute, or its end
  if (d.pact) {
    const civ = world.civs[d.pact.civId];
    const rid = civ?.ruler?.id ?? civ?.ruler?.name ?? null;
    if (!civ || !civ.alive) { d.pact = null; band.civId = -1; }
    else if (rid !== d.pact.ruler) endPact(world, band, 'ruler');
    else {
      const t = Math.round(Math.max(0, civ.treasury || 0) * 0.05);
      if (t < 5) endPact(world, band, 'poor');
      else { civ.treasury -= t; band.loot = (band.loot || 0) + t; }
    }
  }
  // clutches: two dragons awake within 60 tiles
  if (d.clutch && world.time.day >= d.clutch.due) { hatch(world, band); d.clutch = null; }
  else if (!d.clutch && band.state !== 'sleep' && aliveOf(world, 'dragon') < MAX_DRAGONS && isReady(world, 'clutch', 80 * Y)) {
    const mate = world.bands.find((o) => o !== band && o.kind === 'dragon' && o.state !== 'sleep' && Math.hypot(o.x - band.x, o.y - band.y) < 60);
    if (mate && rng.chance(0.12)) {
      state(world).cd.clutch = world.time.day;
      d.clutch = { due: world.time.day + rng.int(8, 15) * Y, mate: mate.id };
      const ft = getSite(world, d.lair);
      say(world, band, { cat: 'myth', imp: 2, key: 'dragon.clutch', text: pick(world, [`${BandName(band)} and ${bandName(mate)} were seen circling together above ${ft?.name || 'the peaks'}; the herdsmen feared what it meant.`, `Two dragons, ${bandName(band)} and ${bandName(mate)}, shared ${ft?.name || 'a lair'} for a season, and a clutch of eggs was left in the warm ash.`]) });
    }
  }
}

function hatch(world, band) {
  if (aliveOf(world, 'dragon') >= MAX_DRAGONS) return;
  const lair = findLair(world, { x: band.homeI % world.W, y: (band.homeI / world.W) | 0 });
  if (!lair) return;
  const young = spawnDragon(world, lair, { young: true, asleep: false, variety: band.data.variety, parent: band.id });
  say(world, young, {
    cat: 'myth', imp: 3, key: 'dragon.hatch',
    text: pick(world, [
      `From the clutch in ${getSite(world, band.data.lair)?.name || 'the old lair'} hatched ${bandName(young)}, a wyrmling of the brood of ${band.name}; it flew to ${getSite(world, young.data.lair)?.name || 'a lair of its own'}.`,
      `A new dragon was born: ${bandName(young)}, child of ${bandName(band)}, small as yet and already hungry.`,
    ]),
  });
}

// ---------------------------------------------------------------------------
// Slain

/** The end of a dragon. by: { how: 'army'|'hero'|'divine', name?, army?, cause? } */
function slain(world, band, civ, by = {}) {
  const st = state(world);
  const lair = getSite(world, band.data.lair);
  const town = civ ? nearestSettlement(world, band.x, band.y, { civId: civ.id }) : null;
  const name = by.name || (civ ? heroName(world, civ) : null);
  const hoard = Math.round(band.loot || 0);
  let golden = false;
  if (civ && civ.alive) {
    civ.treasury = (civ.treasury || 0) + hoard;
    civ.prestige = (civ.prestige || 0) + 10;
    if (world.rng.chance(0.25)) {
      golden = true;
      addEffect(world, { kind: 'civ', id: civ.id }, {
        k: 'dragon_gold', until: world.time.day + 20 * Y, label: `The gold of ${band.name}`,
        m: { research: 0.1, culture: 0.25, production: 0.1, trade: 0.1, stability: 0.06, happiness: 0.05 },
      });
    }
  }
  let fig = by.figure || null;
  const title = slayerTitle(band, world);
  if (fig) { fig.epithet = title; (fig.deeds ||= []).push(`slew ${bandName(band)}`); }
  else if (civ && name) {
    fig = addFigure(world, {
      name, kind: 'hero', title: 'hero', epithet: title, civId: civ.id, sid: town ? town.id : null,
      born: world.time.day - world.rng.int(22, 40) * Y, deeds: [`slew ${bandName(band)}`, hoard > 0 ? `brought home a hoard of ${money(hoard)}` : 'won a dragon’s hoard'],
    });
  }
  const L = lair?.name || 'its lair';     // its name before the bones rename it
  if (lair) {
    const i = lair.i;
    world.f.resource[i] = 14;            // dragonbone
    if (world.f.resourceAmt) world.f.resourceAmt[i] = 1;
    renameSite(world, lair.id, `the Bones of ${band.name}`);
    updateSite(world, lair.id, { slain: world.time.day, slayer: name, slayerCivId: civ ? civ.id : -1, hoard: 0, bones: true, bandId: band.id });
  }
  band.data.slayer = { name, civId: civ ? civ.id : -1, day: world.time.day, figureId: fig ? fig.id : null };
  st.stats.slain++;
  emitFx(world, { type: 'slay', x: band.x, y: band.y, r: 3, intensity: 1, ...(by.how === 'divine' ? { src: 'tool' } : {}) });
  const C = civName(civ);
  const text = by.how === 'army'
    ? pick(world, [
      `${when(world, band.y)}, ${by.army?.name || 'the host of ' + C} cornered ${bandName(band)} in ${L} and killed it${name ? `; ${name}, who struck the last blow, was called ${title} ever after` : ''}. Its hoard of ${money(hoard)} was carried down to ${town ? town.name : C}.`,
      `${cap(C)} slew ${bandName(band)}: a thousand spears went up to ${L}, and ${name || 'their captain'} came down with the dragon's head and ${money(hoard)} in gold.`,
    ])
    : by.how === 'divine'
      ? `${cap(name || 'A champion')} of ${C}, guided by a hand not their own, found the one soft scale of ${bandName(band)} in ${L}; the dragon died, and its hoard of ${money(hoard)} went to ${town ? town.name : C}.`
      : pick(world, [
        `${when(world, band.y)}, ${name} of ${town ? town.name : C} drove a spear into the heart of ${bandName(band)} in ${L}; the dragon's hoard was carried down to ${town ? town.name : C}, and men called ${name} ${title} ever after.`,
        `${cap(name)} climbed alone to ${L} and came down a legend: ${bandName(band)} was dead, and ${money(hoard)} of its gold went home to ${C}.`,
        `The hero ${name} of ${C} slew ${bandName(band)}${band.data.elder ? ', the Elder, oldest of its kind,' : ''} in ${L}. They called the place the Bones of ${band.name} after that.`,
      ]);
  // the hunt that cornered it, else the last raid that made the slayer go
  const entry = say(world, band, { cat: 'myth', imp: band.data.elder ? 5 : 4, key: 'dragon.slain', civId: civ ? civ.id : null, sid: town ? town.id : null, cause: by.cause ?? (Number.isFinite(band.data.rseq) ? band.data.rseq : null), text });
  if (golden && civ) {
    say(world, null, {
      cat: 'civ', imp: 3, key: 'dragon.gold', civId: civ.id, sid: town ? town.id : null, cause: entry ? entry.seq : null, ref: { k: 'civ', id: civ.id },
      text: pick(world, [`The dragon's gold flowed through ${C}, and a golden age of building and learning began.`, `With the hoard of ${band.name} in its coffers, ${C} entered a golden age.`]),
    });
  }
  endBand(world, band, 'slain');
}

// ---------------------------------------------------------------------------

/** An eruption wakes the fire drakes that sleep within 25 tiles of it (once they have slept 25 years). */
on('eruption', (world, e) => {
  if (!e || !mythOn(world) || !world.sys.bands) return;
  const day = world.time.day;
  for (const b of world.bands) {
    if (b.kind !== 'dragon' || b.state !== 'sleep' || b.data?.variety !== 'fire') continue;
    if (day - (b.data.slept || b.createdDay || 0) < 25 * Y) continue;
    if (Math.hypot(b.x - e.x, b.y - e.y) <= 25) wake(world, b, 'eruption', Number.isFinite(e.seq) ? e.seq : null);
  }
});

registerKind('dragon', {
  myth: true, spawn, month, arrive, year, slain,
  day(world, band) { if (band.state === 'tamed') tamedDay(world, band); },
});

