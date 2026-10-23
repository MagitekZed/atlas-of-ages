// Bands · outlaws (bandits). Men with nothing left to lose take to the woods and hills where
// war has wasted the land, loyalty has failed, dark ages have fallen or a realm totters. A
// band keeps a camp a few leagues from the town that bred it, and every few months it rides
// out: to waylay the caravans of a nearby road (raising its pressure until merchants abandon
// it) or to strip a village too weak to stop it. Success brings recruits; repulse, hunts and
// long quiet years break bands up. Spawning is one rng draw a month (plus one weighted pick
// when it fires) over every troubled settlement.

import { liveSettlements, settlementsNear, getBand } from '../../../core/entities.js';
import { DAYS_PER_YEAR, WATER, BIOME, MONTH_SEASON } from '../../../core/constants.js';
import { latitude, monthOf } from '../../../core/world.js';
import { clamp } from '../../../core/util.js';
import { weightedIndex } from '../../../core/util.js';
import {
  registerKind, spawnBand, endBand, banditry, roomFor, capRoom, peopleTotals, MAX_PEOPLE_BANDS, ready,
} from '../engine.js';
import { planRoute, planHome, tileOf } from '../move.js';
import { raidTown, robRoute, routesNear, looksSoft, ransom, attackOf } from '../combat.js';
import { makeLeader, outlawName } from '../names.js';
import { say, pick, cap, civName, rulerOf, count, when, placePhrase, whereFor, bandName, BandName, isTold } from '../prose.js';

const K = 0.0014;                // monthly spawn chance per trouble^0.4: troubled worlds breed more bands, never without bound
const OUTLAW_MAX = 450;          // the most men an outlaw band holds together
const FOREST = new Set([BIOME.TEMPERATE_FOREST, BIOME.TAIGA, BIOME.RAINFOREST, BIOME.TEMPERATE_RAINFOREST, BIOME.TROPICAL_FOREST, BIOME.WETLAND]);

/** Is it a winter month at this row, away from the tropics (outlaws lie low)? */
export function wintry(world, y) {
  const lat = latitude(world, clamp(Math.round(y), 0, world.H - 1));
  if (Math.abs(lat) < 0.35) return false;
  const s = MONTH_SEASON[monthOf(world)];
  return (lat >= 0 ? s : (s + 2) % 4) === 0;
}

/** Recent war: any relation of the realm saw war in the last 8 years. */
function postWar(world, civ) {
  const day = world.time.day;
  for (const k in civ.relations) { const r = civ.relations[k]; if (r && r.lastWarDay >= 0 && day - r.lastWarDay < 8 * DAYS_PER_YEAR) return true; }
  return false;
}

/** How fertile the ground around s is for outlaws (0.05 in peaceful country). */
export function trouble(world, s, civ, war) {
  const f = world.f;
  let t = 0.05;
  t += 3 * (f.devastation[s.i] || 0);
  t += 2 * Math.max(0, 0.55 - (s.loyalty ?? 0.8));
  t += 1.2 * (s.unrest || 0);
  if (civ) {
    if ((civ.darkAge || 0) > 0) t += 0.8;
    if ((civ.stability ?? 0.7) < 0.35) t += 0.5;
    if (war) t += 0.4;
  }
  if (s.famine > 0) t += 0.4;
  return t;
}

/**
 * A hideout: the best of a few sampled dry tiles rMin..rMax from (x, y), preferring woods,
 * hills and empty ground. Returns a tile index or -1.
 */
export function findCamp(world, x, y, rMin = 3, rMax = 7, samples = 10) {
  const { W, H, f } = world;
  const rng = world.rng;
  let best = -1, bs = -Infinity;
  for (let k = 0; k < samples; k++) {
    const a = rng.next() * Math.PI * 2, r = rMin + rng.next() * (rMax - rMin);
    const cx = Math.round(x + Math.cos(a) * r), cy = Math.round(y + Math.sin(a) * r);
    if (cx < 1 || cy < 1 || cx >= W - 1 || cy >= H - 1) continue;
    const i = cy * W + cx;
    if (f.water[i] !== WATER.LAND || f.settle[i] >= 0) continue;
    let sc = (f.veg[i] || 0) * 1.5 + (FOREST.has(f.biome[i]) ? 0.5 : 0) + (f.elevation[i] >= 0.62 ? 0.6 : 0) - (f.road[i] || 0) * 0.3 - (f.farm[i] || 0) * 0.8;
    if (f.biome[i] === BIOME.ICE) sc -= 3;
    if (sc > bs) { bs = sc; best = i; }
  }
  return best;
}

function spawn(world) {
  const rate = banditry(world);
  if (rate <= 0 || world.time.day < 5 * DAYS_PER_YEAR) return;
  const totals = peopleTotals(world);
  if (totals.n >= MAX_PEOPLE_BANDS) return;
  const towns = liveSettlements(world);
  if (!towns.length) return;
  let outlaws = 0;
  for (const b of world.bands) if (b.kind === 'bandits') outlaws++;
  if (outlaws >= 6 + Math.floor(towns.length / 50)) return;
  // (integration, perf: the month's one draw comes first; the odds can never pass 3 % × banditry,
  // so most months end here without weighing every town)
  const roll = world.rng.next();
  if (roll >= 0.03 * rate) return;
  const wars = new Map();
  const cand = [], ws = [];
  let W = 0;
  for (const s of towns) {
    if ((s.tier | 0) < 1 || s.population < 120) continue;
    const civ = world.civs[s.civId];
    let war = wars.get(s.civId);
    if (war === undefined) { war = civ ? postWar(world, civ) : false; wars.set(s.civId, war); }
    let w = trouble(world, s, civ, war) * clamp(Math.sqrt(s.population / 600), 0.4, 3);
    if (w <= 0.06 * 0.4) continue;
    for (const b of world.bands) if (b.kind === 'bandits' && Math.abs(b.x - s.x) < 12 && Math.abs(b.y - s.y) < 12) { w *= 0.15; break; }
    cand.push(s); ws.push(w); W += w;
  }
  if (!cand.length) return;
  if (roll >= Math.min(0.03, K * Math.pow(W, 0.4)) * rate) return;
  const s = cand[weightedIndex(world.rng, ws)];
  if (!s) return;
  raise(world, s);
}

/** Raise an outlaw band in the hills and woods near town s. Returns the band or null. */
export function raise(world, s, opts = {}) {
  const civ = world.civs[s.civId];
  const rng = world.rng;
  let strength = Math.round(clamp(s.population * rng.float(0.018, 0.045) + 8, 12, 400) * (opts.mul || 1));
  strength = Math.min(strength, Math.round(capRoom(world)));
  if (strength < 12 || !roomFor(world, strength)) return null;
  const camp = findCamp(world, s.x, s.y);
  if (camp < 0) return null;
  const lang = civ?.language || world.lang;
  const leader = makeLeader(world, lang, { place: s.name });
  const cx = camp % world.W, cy = (camp / world.W) | 0;
  const band = spawnBand(world, {
    kind: 'bandits', name: outlawName(world, cx, cy, leader, lang, { town: s.name, civ }), leader,
    x: cx, y: cy, homeI: camp, homeR: 10, state: 'lair', strength, morale: 0.85,
    originCivId: s.civId, data: { town: s.id, last: world.time.day, hit: {} },
  });
  const war = civ ? postWar(world, civ) : false;
  const where = whereFor(placePhrase(world, cx, cy), band.name) || pick(world, ['in the wild country', 'in the hills nearby', 'in the woods beyond the fields']);
  const B = bandName(band), L = leader.name;
  const reason = (civ?.darkAge || 0) > 0 ? 'dark' : (world.f.devastation[s.i] || 0) > 0.2 || war ? 'war' : (s.loyalty ?? 1) < 0.45 ? 'loyal' : 'plain';
  const text = pick(world, {
    dark: [`In the dark years, the desperate of ${s.name} took to the woods: ${B}, led by ${L}, began to prey on the roads ${where}.`, `As ${civName(civ)} sank into darkness, ${L} gathered the hungry of ${s.name} into ${B}.`],
    war: [`War had wasted the country around ${s.name}, and men with nothing left to lose took to the hills as ${B}, under ${L}.`, `After the fighting, some of the levies of ${s.name} never went home; they became ${B}, and ${L} led them ${where}.`],
    loyal: [`${cap(L)} raised ${B} among the disaffected of ${s.name}, who no longer cared what ${civ ? rulerOf(civ) : 'their lords'} decreed.`, `${cap(s.name)} had lost faith in ${civName(civ)}; out of its discontent came ${B}, camped ${where}.`],
    plain: [`${cap(L)} and a few dozen broken men made a camp ${where} and called themselves ${B}.`, `${BandName(band)} began to rob travellers on the roads near ${s.name}.`],
  }[reason]);
  // a band worth the name is news; a few dozen desperate men are only a rumour
  const told = strength >= 40 || (strength >= 20 && reason !== 'plain');
  say(world, band, { cat: 'civ', imp: told ? 2 : 1, fold: !told, key: 'band.rise', text, x: cx, y: cy, civId: s.civId, sid: s.id });
  return band;
}

function month(world, band) {
  if (band.strength < 8) { disperse(world, band, 'dwindled'); return; }
  if (band.state !== 'lair') return;
  const rng = world.rng;
  if (wintry(world, band.y) && rng.chance(0.8)) return;
  if (!rng.chance(0.15 + 0.1 * clamp(band.morale ?? 1, 0, 1.2))) return;
  const day = world.time.day;
  const hit = band.data.hit || (band.data.hit = {});
  // a soft town within ten tiles, richer and nearer first
  let town = null, ts = 0;
  const atk = attackOf(band);
  for (const s of settlementsNear(world, band.x, band.y, 10)) {
    if (hit[s.id] != null && day - hit[s.id] < 2 * DAYS_PER_YEAR) continue;
    if (!looksSoft(world, band, s, 0.75, atk)) continue;
    const d = Math.hypot(s.x - band.x, s.y - band.y);
    const sc = Math.sqrt(Math.max(0, (s.wealth || 0) + 0.05 * s.population)) / (1 + d / 4);
    if (sc > ts) { ts = sc; town = s; }
  }
  const roads = routesNear(world, band.x, band.y, 6, 'land');
  const road = roads.length ? roads[Math.min(roads.length - 1, rng.int(0, 2))] : null;
  if (road && (!town || rng.chance(0.5))) {
    band.data.ambush = road.r.id;
    band.targetSid = -1;
    if (planRoute(world, band, road.i)) band.state = 'raid'; else band.data.ambush = -1;
    return;
  }
  if (town) {
    band.data.ambush = -1;
    band.targetSid = town.id;
    if (planRoute(world, band, town.i)) band.state = 'raid'; else band.targetSid = -1;
  }
}

function arrive(world, band) {
  const day = world.time.day;
  if (band.state === 'return') { band.state = 'lair'; band.path = null; return; }
  if (band.data.ambush >= 0) {
    const r = world.tradeRoutes[band.data.ambush];
    if (r && r.active) robRoute(world, band, r);
    band.data.ambush = -1;
  } else if (band.targetSid >= 0) {
    const s = world.settlements[band.targetSid];
    if (s && s.alive && Math.hypot(s.x - band.x, s.y - band.y) <= 2) {
      (band.data.hit ||= {})[s.id] = day;
      const paid = band.strength >= 120 ? ransom(world, band, s) : null;
      const r = paid === 'paid' ? null : raidTown(world, band, s, { sevBonus: paid === 'refused' ? 0.25 : 0 });
      if (r && r.ok) {
        // plunder draws recruits from the desperate, within the cap (an outlaw band stays a band)
        const add = Math.min(band.strength * 0.12, capRoom(world) * 0.5, Math.max(0, OUTLAW_MAX - band.strength));
        if (add >= 1 && roomFor(world, add)) band.strength += add;
      }
    }
    band.targetSid = -1;
  }
  if (!getBand(world, band.id)) return;
  band.state = 'return';
  if (!planHome(world, band)) { band.state = 'lair'; band.path = null; }
}

/** The band breaks up. */
export function disperse(world, band, why = 'quiet') {
  // the end of a band is notable only when the chronicle had told of it (its rise or a raid)
  const notable = isTold(band);
  const L = band.leader?.name;
  const text = pick(world, why === 'leader'
    ? [`${BandName(band)} did not survive the death of ${L || 'its captain'}; its men slipped back into the villages.`, `With ${L || 'their captain'} dead, ${bandName(band)} scattered and were heard of no more.`]
    : why === 'dwindled'
      ? [`What was left of ${bandName(band)} melted away into the hills.`, `${BandName(band)} dwindled to a handful and broke up.`]
      : [`${BandName(band)} broke up after ${count((world.time.day - band.createdDay) / DAYS_PER_YEAR)} years on the roads; ${L ? L + ' was last seen' : 'its last men were seen'} ${placePhrase(world, band.x, band.y) || 'far from home'}.`,
        `Times grew quieter, and ${bandName(band)} went home to their fields.`]);
  if (notable || ready(world, `dsp${band.originCivId}`, 20 * DAYS_PER_YEAR)) {
    say(world, band, { cat: 'civ', imp: notable ? 2 : 1, fold: !notable, key: 'band.disperse', text, civId: band.originCivId >= 0 ? band.originCivId : null });
  }
  endBand(world, band, 'dispersed');
}

function year(world, band) {
  const rng = world.rng;
  const day = world.time.day;
  const quiet = (day - (band.data.last ?? band.createdDay)) / DAYS_PER_YEAR;
  if (quiet >= 5 && rng.chance(0.4)) { disperse(world, band, 'quiet'); return; }
  const owner = world.f.owner[tileOf(world, band.x, band.y)];
  const civ = owner >= 0 ? world.civs[owner] : null;
  if (civ && (civ.stability ?? 0) > 0.75 && quiet >= 2 && rng.chance(0.12)) { disperse(world, band, 'quiet'); return; }
  if (band.leader && rng.chance(0.04 + Math.max(0, (day - band.leader.born) / DAYS_PER_YEAR - 50) * 0.01)) {
    if (band.strength < 30 || rng.chance(0.45)) { disperse(world, band, 'leader'); return; }
    const old = band.leader.name;
    band.leader = makeLeader(world, world.civs[band.originCivId]?.language || world.lang);
    if ((band.raids || 0) >= 3 && ready(world, `ldr${band.id}`, 10 * DAYS_PER_YEAR)) {
      say(world, band, { cat: 'civ', imp: 1, fold: true, key: 'band.leader', text: `${cap(old)} of ${bandName(band)} was killed in a quarrel over the spoils, and ${band.leader.name} took the captaincy.` });
    }
  }
  // the camp follows the band's fortunes: an old haunt now ploughed or watched is abandoned
  const f = world.f;
  if (f.settle[band.homeI] >= 0 || f.water[band.homeI] !== WATER.LAND) {
    const c = findCamp(world, band.x, band.y, 2, 6, 6);
    if (c >= 0) band.homeI = c;
  }
  band.morale = clamp((band.morale ?? 1) + ((band.morale ?? 1) < 0.8 ? 0.1 : 0), 0.05, 1.2);
}

registerKind('bandits', { spawn, month, arrive, year });
