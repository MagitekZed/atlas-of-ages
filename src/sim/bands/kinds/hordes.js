// Bands · steppe hordes. Two sources: a horde-governed realm sends its riders out under a war
// khan against the richest settled neighbour, or (once the world knows the horse) a people of
// the empty grasslands gathers around a conqueror and rides out of nowhere. A horde marches on
// the richest settled town within reach, burning the lesser towns along its road, cutting up
// the armies sent against it; at its goal it takes a ransom, sacks the place, or takes it —
// and then it does not leave: the captured city becomes the seat of a horde state (combat.js
// foundRealm, government 'horde'). Hordes that are bled white or grow old break apart.
// At most two ride at once, the steppe gives birth to one at most every 45 years.

import { liveCivs, settlementsNear, getBand } from '../../../core/entities.js';
import { DAYS_PER_YEAR, WATER, BIOME } from '../../../core/constants.js';
import { clamp } from '../../../core/util.js';
import { registerKind, spawnBand, endBand, banditry, roomFor, capRoom, manpowerOf, aliveOf, isReady, ready } from '../engine.js';
import { planRoute, tileOf } from '../move.js';
import { raidTown, ransom, assault, foundRealm } from '../combat.js';
import { makeLeader, hordeName, steppeTongue, featureNear, featName } from '../names.js';
import { makeWord } from '../../../core/names.js';
import { say, pick, cap, civName, rulerOf, count, when, bandName, BandName } from '../prose.js';

const STEPPE = new Set([BIOME.STEPPE, BIOME.SAVANNA, BIOME.COLD_DESERT, BIOME.SHRUBLAND]);
const MAX_HORDES = 2;
const STEPPE_GAP = 45 * DAYS_PER_YEAR;
const CIV_GAP = 30 * DAYS_PER_YEAR;
const P_STEPPE = 0.0009;        // monthly chance of a steppe rising, × banditry × rates('horde')

const settled = (civ) => civ && civ.alive && civ.government !== 'horde';

/** The richest settled town within reach of (x, y) on the same land: wealth^0.7 / distance. */
function richestTarget(world, x, y, reach, exceptCiv = -1, hit = null) {
  const lm = world.f.landmass[tileOf(world, x, y)];
  let best = null, bs = 0;
  for (const s of settlementsNear(world, x, y, reach)) {
    if (s.civId === exceptCiv || !settled(world.civs[s.civId]) || world.f.landmass[s.i] !== lm || (s.tier | 0) < 2) continue;
    if (hit && hit[s.id] != null && world.time.day - hit[s.id] < 3 * DAYS_PER_YEAR) continue;   // sacked or paid lately
    const d = Math.hypot(s.x - x, s.y - y);
    const sc = Math.pow(Math.max(1, (s.wealth || 0) + 0.1 * s.population), 0.7) / (4 + d);
    if (sc > bs) { bs = sc; best = s; }
  }
  return best;
}

function spawn(world) {
  const rate = banditry(world, 'horde');
  if (rate <= 0 || aliveOf(world, 'horde') >= MAX_HORDES) return;
  const rng = world.rng;
  const civs = liveCivs(world);
  // (a) the war khans of horde realms, considered once a year
  if (Math.floor(world.time.day / 30) % 12 === 4) {
    for (const civ of civs) {
      if (civ.government !== 'horde' || (civ.tech?.era || 0) < 1 || manpowerOf(civ) < 150) continue;
      if (!isReady(world, `hk${civ.id}`, CIV_GAP)) continue;
      if (!rng.chance(clamp(0.04 * rate * (0.5 + (civ.traits?.aggression ?? 0.5)), 0, 0.5))) continue;
      const cap0 = world.settlements[civ.capitalId];
      if (!cap0) continue;
      const target = richestTarget(world, cap0.x, cap0.y, 45, civ.id);
      if (!target) continue;
      ready(world, `hk${civ.id}`, CIV_GAP);
      riseFromRealm(world, civ, cap0, target);
      if (aliveOf(world, 'horde') >= MAX_HORDES) return;
    }
  }
  // (b) out of the empty steppe, once horses are known among the settled peoples
  if (!isReady(world, 'hordeSteppe', STEPPE_GAP)) return;
  let horsed = 0;
  for (const c of civs) if ((c.tech?.era || 0) >= 1) horsed++;
  if (!horsed) return;
  if (rng.next() >= P_STEPPE * rate) return;
  const { W, H, f } = world;
  for (let k = 0; k < 24; k++) {
    const x = rng.int(2, W - 3), y = rng.int(2, H - 3);
    const i = y * W + x;
    if (f.water[i] !== WATER.LAND || !STEPPE.has(f.biome[i]) || f.owner[i] >= 0) continue;
    if (settlementsNear(world, x, y, 8).length) continue;
    const target = richestTarget(world, x, y, 45);
    if (!target) continue;
    ready(world, 'hordeSteppe', STEPPE_GAP);
    riseFromSteppe(world, x, y, target);
    return;
  }
}

function hordeStrength(world, target, mul) {
  const civ = world.civs[target.civId];
  const s = Math.round(clamp(manpowerOf(civ) * mul, 80, 9000));
  return Math.min(s, Math.round(capRoom(world)));
}

function riseFromRealm(world, civ, cap0, target) {
  const rng = world.rng;
  const strength = Math.min(hordeStrength(world, target, rng.float(0.5, 0.9)), Math.round(manpowerOf(civ) * 0.5));
  if (strength < 80 || !roomFor(world, strength)) return null;
  const leader = makeLeader(world, civ.language, { title: rng.chance(0.5) ? 'Khan' : 'Noyan', lo: 0.95, hi: 1.4 });
  const word = makeWord(civ.language, rng, 1, 2);
  const probe = { kind: 'horde', x: cap0.x, y: cap0.y, data: {} };
  if (!planRoute(world, probe, target.i)) return null;
  // the riders leave their camps: the realm is lighter by their families' share of hands
  for (const id of civ.settlementIds) { const s = world.settlements[id]; if (s && s.alive) s.population = Math.max(8, s.population - strength * 0.4 * s.population / Math.max(1, civ.population)); }
  const band = spawnBand(world, {
    kind: 'horde', name: hordeName(world, leader, civ.language, cap0.x, cap0.y), leader, x: cap0.x, y: cap0.y, homeI: cap0.i, homeR: 60,
    state: 'roam', strength, morale: 1.05, originCivId: civ.id, targetSid: target.id, targetI: target.i, path: probe.path, pathStep: 0,
    data: { start: strength, word, hit: {}, sacks: 0, last: world.time.day },
  });
  const tc = world.civs[target.civId];
  say(world, band, {
    cat: 'war', imp: 3, key: 'band.horde.rise', civId: civ.id, x: cap0.x, y: cap0.y,
    text: pick(world, [
      `${cap(rulerOf(civ))} unleashed ${bandName(band)} upon the rich lands of ${civName(tc)}: ${count(strength)} riders under ${leader.name}.`,
      `${when(world, cap0.y)}, ${count(strength)} riders of ${civName(civ)} gathered under ${leader.name} and rode out for the plunder of ${target.name}.`,
      `${cap(leader.name)} led ${bandName(band)} out of ${civName(civ)}, swearing that the horses of the steppe would drink from the wells of ${target.name}.`,
    ]),
  });
  return band;
}

function riseFromSteppe(world, x, y, target) {
  const rng = world.rng;
  const strength = hordeStrength(world, target, rng.float(0.6, 1.2));
  if (strength < 80 || !roomFor(world, strength)) return null;
  const lang = steppeTongue(world);
  const leader = makeLeader(world, lang, { epithet: 0.3, lo: 1, hi: 1.45, theme: 'khan' });
  const word = makeWord(lang, rng, 1, 2);
  const i = y * world.W + x;
  const probe = { kind: 'horde', x, y, data: {} };
  if (!planRoute(world, probe, target.i)) return null;
  const band = spawnBand(world, {
    kind: 'horde', name: hordeName(world, leader, lang, x, y), leader, x, y, homeI: i, homeR: 60,
    state: 'roam', strength, morale: 1.1, targetSid: target.id, targetI: target.i, path: probe.path, pathStep: 0,
    data: { start: strength, lang, word, hit: {}, sacks: 0, last: world.time.day },
  });
  const steppe = featureNear(world, x, y, ['desert'], 25);
  say(world, band, {
    cat: 'war', imp: 3, key: 'band.horde.rise', x, y, civId: target.civId,
    text: pick(world, [
      `Out of ${steppe ? featName(steppe) : 'the empty grasslands'} came ${bandName(band)}: ${count(strength)} riders under ${leader.name}, who had never bowed to any king.`,
      `${when(world, y)}, the herdsmen of the steppe united under ${leader.name}, and ${bandName(band)} turned its horses toward ${target.name}.`,
      `A people no chronicle had named rode out of the east: ${bandName(band)}, ${count(strength)} strong, bound for the riches of ${civName(world.civs[target.civId])}.`,
    ]),
  });
  return band;
}

/** Burn the lesser towns along the road (every twelfth day of the march). */
function day(world, band) {
  if (band.state !== 'roam' || (world.time.day + band.id) % 12) return;
  const hit = band.data.hit || (band.data.hit = {});
  for (const s of settlementsNear(world, band.x, band.y, 2.5)) {
    if (s.id === band.targetSid || hit[s.id] != null || !settled(world.civs[s.civId])) continue;
    hit[s.id] = world.time.day;
    raidTown(world, band, s, { sevBonus: 0.15 });
    if (!getBand(world, band.id)) return;
    break;
  }
}

function retarget(world, band) {
  const t = richestTarget(world, band.x, band.y, 40, band.originCivId, band.data.hit);
  if (t && planRoute(world, band, t.i)) { band.targetSid = t.id; band.state = 'roam'; return true; }
  return false;
}

function arrive(world, band) {
  const s = band.targetSid >= 0 ? world.settlements[band.targetSid] : null;
  if (!s || !s.alive || !settled(world.civs[s.civId])) { if (!retarget(world, band)) breakUp(world, band, 'lost'); return; }
  const rng = world.rng;
  const paid = ransom(world, band, s);
  (band.data.hit ||= {})[s.id] = world.time.day;
  if (paid === 'paid') { band.data.sacks++; if (!retarget(world, band)) breakUp(world, band, 'sated'); return; }
  const r = assault(world, band, s);
  if (r.won && (s.tier | 0) >= 2 && rng.chance(0.65)) {
    if (foundRealm(world, band, s, 'horde')) return;
  }
  if (r.won) {
    raidTown(world, band, s, { sevBonus: 0.4 });
    band.data.sacks++;
  } else if (getBand(world, band.id)) {
    say(world, band, {
      cat: 'war', imp: 3, key: 'band.horde.repulsed', x: s.x, y: s.y, civId: s.civId, sid: s.id,
      text: pick(world, [
        `${cap(s.name)} held against ${bandName(band)}; the riders broke on its walls and left their dead in the ditches.`,
        `The walls of ${s.name} saved ${civName(world.civs[s.civId])}: ${bandName(band)} could not take it and turned away.`,
      ]),
    });
  }
  if (!getBand(world, band.id)) return;
  if (band.strength < 0.3 * (band.data.start || band.strength) || (band.morale ?? 1) < 0.3) { breakUp(world, band, 'bled'); return; }
  if (!retarget(world, band)) breakUp(world, band, 'sated');
}

function month(world, band) {
  if (band.state === 'lair') { if (!retarget(world, band)) breakUp(world, band, 'sated'); return; }
  band.morale = clamp((band.morale ?? 1) - 0.01, 0.05, 1.2);
  const s = band.targetSid >= 0 ? world.settlements[band.targetSid] : null;
  if (!s || !s.alive || !settled(world.civs[s.civId])) { if (!retarget(world, band)) breakUp(world, band, 'lost'); }
}

function year(world, band) {
  const age = (world.time.day - band.createdDay) / DAYS_PER_YEAR;
  if (age > 12 && world.rng.chance(0.3 + (age - 12) * 0.1)) breakUp(world, band, 'old');
}

/** The horde breaks apart and its riders scatter. */
function breakUp(world, band, why) {
  const L = band.leader?.name;
  const text = pick(world, why === 'bled'
    ? [`${BandName(band)} had been bled white; its riders scattered back to the steppe.`, `After its defeats ${bandName(band)} broke apart, and ${L || 'its khan'} was murdered by the clan chiefs.`]
    : why === 'old'
      ? [`${L ? cap(L) + ' died' : 'Its khan died'}, and ${bandName(band)} broke into quarrelling clans that drifted home.`, `${BandName(band)} melted away at last; its riders had grown old in the saddle.`]
      : [`Sated with plunder, ${bandName(band)} turned for home and was seen no more.`, `${BandName(band)} rode back into the grasslands with ${band.data.sacks ? 'the wealth of ' + count(band.data.sacks) + ' sacked towns' : 'its plunder'}.`]);
  say(world, band, { cat: 'war', imp: 2, key: 'band.horde.end', text, civId: band.originCivId >= 0 ? band.originCivId : null });
  endBand(world, band, 'dispersed');
}

registerKind('horde', { spawn, month, day, arrive, year });
