// Bands · pirates. Where busy sea lanes pass coasts whose masters are weak at sea, captains
// turn to plunder. A fleet keeps a hidden cove on an empty shore or an island, and every few
// months sails out: to lie in wait on a sea lane for a merchantman (each prize raises the
// lane's pressure until shipmasters abandon it) or to land on a weakly held coastal town.
// Rich and bold fleets may seize a town of their own and found a pirate kingdom (rarely: at
// most once in 150 years). Spawning is one rng draw a month over the world's sea routes.

import { settlementsNear, getBand } from '../../../core/entities.js';
import { DAYS_PER_YEAR, WATER } from '../../../core/constants.js';
import { DX8, DY8, clamp, weightedIndex } from '../../../core/util.js';
import { registerKind, spawnBand, endBand, banditry, roomFor, capRoom, peopleTotals, MAX_PEOPLE_BANDS, ready, isReady } from '../engine.js';
import { planRoute, planHome, tileOf } from '../move.js';
import { raidTown, robRoute, routesNear, liveRoutes, looksSoft, ransom, carrierOf, assault, foundRealm, attackOf, townDefence } from '../combat.js';
import { makeLeader, pirateName, featureNear } from '../names.js';
import { say, pick, cap, civName, placePhrase, bandName, BandName, isTold } from '../prose.js';
import { wintry } from './outlaws.js';

const K = 1.7e-5;               // monthly spawn chance per unit of lane weight (√value × weakness)
const KINGDOM_GAP = 150 * DAYS_PER_YEAR;

const navOf = (civ) => (civ && civ.mods && Number.isFinite(civ.mods.navigation) ? civ.mods.navigation : 0);

function spawn(world) {
  const rate = banditry(world);
  if (rate <= 0 || peopleTotals(world).n >= MAX_PEOPLE_BANDS) return;
  // (integration, perf: draw first; the odds never pass 2 % × banditry, so most months stop here)
  const roll = world.rng.next();
  if (roll >= 0.02 * rate) return;
  const lanes = [], ws = [];
  let W = 0;
  for (const r of liveRoutes(world)) {
    if (!r || !r.active || r.kind !== 'sea' || !r.path || r.path.length < 6) continue;
    const a = world.settlements[r.aId], b = world.settlements[r.bId];
    if (!a || !b) continue;
    const weak = 1.6 - 0.5 * Math.min(navOf(world.civs[a.civId]), navOf(world.civs[b.civId]));
    let w = Math.sqrt(Math.max(0, r.value || 0)) * weak;
    const mid = r.path[r.path.length >> 1];
    const mx = mid % world.W, my = (mid / world.W) | 0;
    for (const p of world.bands) if (p.kind === 'pirates' && Math.abs(p.x - mx) < 20 && Math.abs(p.y - my) < 20) { w *= 0.1; break; }
    if (w <= 0) continue;
    lanes.push(r); ws.push(w); W += w;
  }
  if (!lanes.length) return;
  if (roll >= Math.min(0.02, W * K) * rate) return;
  const r = lanes[weightedIndex(world.rng, ws)];
  if (r) raise(world, r);
}

/** A cove: an empty coastal tile near (x, y) and the sea tile beside it. { land, sea } or null. */
function findCove(world, x, y) {
  const { W, H, f } = world;
  const rng = world.rng;
  let best = null, bs = -Infinity;
  for (let k = 0; k < 18; k++) {
    const a = rng.next() * Math.PI * 2, rr = 2 + rng.next() * 12;
    const cx = Math.round(x + Math.cos(a) * rr), cy = Math.round(y + Math.sin(a) * rr);
    if (cx < 1 || cy < 1 || cx >= W - 1 || cy >= H - 1) continue;
    const i = cy * W + cx;
    if (f.water[i] !== WATER.LAND || !f.coast[i] || f.settle[i] >= 0) continue;
    let sea = -1;
    for (let d = 0; d < 8; d++) { const j = (cy + DY8[d]) * W + cx + DX8[d]; if (f.water[j] === WATER.OCEAN) { sea = j; break; } }
    if (sea < 0) continue;
    let sc = (f.owner[i] < 0 ? 1 : 0) + (featureNear(world, cx, cy, ['island'], 4) ? 0.6 : 0) + (f.veg[i] || 0) * 0.3 - (f.road[i] || 0) * 0.4;
    if (sc > bs) { bs = sc; best = { land: i, sea }; }
  }
  return best;
}

/** Fit out a pirate fleet on sea route r. */
export function raise(world, r, opts = {}) {
  const rng = world.rng;
  const p = r.path;
  const at = p[clamp((p.length >> 1) + rng.int(-2, 2), 1, p.length - 2)];
  const x = at % world.W, y = (at / world.W) | 0;
  const cove = findCove(world, x, y);
  const a = world.settlements[r.aId];
  const civ = a ? world.civs[a.civId] : null;
  let strength = Math.round(clamp(rng.float(20, 55) + Math.sqrt(Math.max(0, r.value || 0)) * 6, 15, 260) * (opts.mul || 1));
  strength = Math.min(strength, Math.round(capRoom(world)));
  if (strength < 15 || !roomFor(world, strength)) return null;
  const leader = makeLeader(world, civ?.language || world.lang, { epithet: 0.7, theme: 'sea', place: a && a.alive ? a.name : null });
  const home = cove ? cove.sea : at;
  const hx = home % world.W, hy = (home / world.W) | 0;
  const isle = featureNear(world, hx, hy, ['island'], 6);
  const band = spawnBand(world, {
    kind: 'pirates', name: pirateName(world, hx, hy, leader, { port: a && a.alive ? a.name : null, lang: civ?.language }), leader, x: hx, y: hy, homeI: home, homeR: 18, state: 'lair', strength, morale: 0.9,
    originCivId: civ ? civ.id : -1,
    data: { cove: cove ? cove.land : -1, last: world.time.day, ambush: -1, wait: 0, isle: isle ? String(isle.name).replace(/^the\s+/i, '').replace(/^Isle of\s+/i, '').replace(/\s+Isle$/i, '') : null },
  });
  const lane = r.name || `the sea road between ${a ? a.name : 'the coast'} and ${world.settlements[r.bId]?.name || 'the far shore'}`;
  say(world, band, {
    cat: 'trade', imp: strength >= 45 ? 2 : 1, fold: strength < 45, key: 'band.rise', x: hx, y: hy, civId: civ ? civ.id : null,
    text: pick(world, [
      `${cap(bandName(band))} began to prey on the shipping of ${lane}, sailing from a hidden cove${isle ? ' on ' + isle.name : ''}.`,
      `${cap(leader.name)} turned pirate ${placePhrase(world, hx, hy, true)}: ${bandName(band)} waited for the merchantmen of ${lane}.`,
      `Black sails were seen on ${lane}: ${bandName(band)}, under ${leader.name}, had come for the trade of ${civName(civ)}.`,
    ]),
  });
  return band;
}

function month(world, band) {
  if (band.strength < 8) { endBand(world, band, 'dwindled'); return; }
  if (band.state !== 'lair' || band.data.wait > 0) return;
  const rng = world.rng;
  if (wintry(world, band.y) && rng.chance(0.6)) return;
  // a kingdom of their own: rich, proven fleets near a weakly held coast
  if ((band.loot || 0) >= 250 && (band.raids || 0) >= 6 && band.strength >= 50 && isReady(world, 'pirateKingdom', KINGDOM_GAP)) {
    let best = null, bs = 0;
    for (const s of settlementsNear(world, band.x, band.y, 20)) {
      if (!s.coastal || (s.tier | 0) > 3) continue;
      const civ = world.civs[s.civId];
      if (civ && civ.capitalId === s.id && civ.settlementIds.length > 1) continue;
      if (attackOf(band) < townDefence(world, s) * 1.6) continue;
      const sc = (featureNear(world, s.x, s.y, ['island'], 5) ? 2 : 1) * Math.sqrt(s.population) / (1 + Math.hypot(s.x - band.x, s.y - band.y) / 8);
      if (sc > bs) { bs = sc; best = s; }
    }
    if (best && rng.chance(0.35) && planRoute(world, band, best.i)) { band.state = 'settling'; band.targetSid = best.id; band.data.seize = 1; return; }
  }
  if (!rng.chance(0.35 + 0.2 * clamp(band.morale ?? 1, 0, 1.2))) return;
  const lanes = routesNear(world, band.x, band.y, 14, 'sea');
  let town = null, ts = 0;
  const atk = attackOf(band);
  for (const s of settlementsNear(world, band.x, band.y, 18)) {
    if (!s.coastal || !looksSoft(world, band, s, 0.7, atk)) continue;
    const sc = Math.sqrt(Math.max(0, (s.wealth || 0) + 0.05 * s.population)) / (1 + Math.hypot(s.x - band.x, s.y - band.y) / 6);
    if (sc > ts) { ts = sc; town = s; }
  }
  if (lanes.length && (!town || rng.chance(0.6))) {
    const l = lanes[Math.min(lanes.length - 1, rng.int(0, 1))];
    band.data.ambush = l.r.id;
    band.targetSid = -1;
    if (planRoute(world, band, l.i)) band.state = 'raid'; else band.data.ambush = -1;
    return;
  }
  if (town && planRoute(world, band, town.i)) { band.state = 'raid'; band.targetSid = town.id; band.data.ambush = -1; }
}

/** Lying in wait on a lane: take the first ship that comes within reach. */
function day(world, band) {
  if (band.state !== 'lair' || !(band.data.wait > 0)) return;
  band.data.wait--;
  const r = world.tradeRoutes[band.data.ambush];
  const c = r && r.active ? carrierOf(world, r) : null;
  let done = band.data.wait <= 0 || !r || !r.active;
  if (c && Math.abs(c.x - band.x) <= 2.5 && Math.abs(c.y - band.y) <= 2.5) { robRoute(world, band, r); done = true; }
  if (!done) return;
  band.data.wait = 0; band.data.ambush = -1;
  if (!getBand(world, band.id)) return;
  band.state = 'return';
  if (!planHome(world, band)) { band.state = 'lair'; band.path = null; }
}

function arrive(world, band) {
  if (band.state === 'return') { band.state = 'lair'; band.path = null; return; }
  if (band.data.seize && band.targetSid >= 0) {
    const s = world.settlements[band.targetSid];
    band.data.seize = 0;
    if (s && s.alive) {
      const r = assault(world, band, s);
      if (r.won) { world.sys.bands.cd.pirateKingdom = world.time.day; if (foundRealm(world, band, s, 'pirates')) return; }
      else raidTown(world, band, s, {});
    }
  } else if (band.data.ambush >= 0) {
    band.state = 'lair';
    band.data.wait = 25;
    band.path = null;
    return;
  } else if (band.targetSid >= 0) {
    const s = world.settlements[band.targetSid];
    if (s && s.alive) {
      const paid = s.tier >= 3 ? ransom(world, band, s) : null;
      if (paid !== 'paid') raidTown(world, band, s, { sevBonus: paid === 'refused' ? 0.25 : 0 });
    }
  }
  band.targetSid = -1;
  if (!getBand(world, band.id)) return;
  if (band.strength < 8) { endBand(world, band, 'dwindled'); return; }
  band.state = 'return';
  if (!planHome(world, band)) { band.state = 'lair'; band.path = null; band.homeI = tileOf(world, band.x, band.y); }
}

function year(world, band) {
  const rng = world.rng;
  const quiet = (world.time.day - (band.data.last ?? band.createdDay)) / DAYS_PER_YEAR;
  if (quiet >= 6 && rng.chance(0.4)) {
    if ((band.raids || 0) >= 4) say(world, band, { cat: 'trade', imp: isTold(band) ? 2 : 1, fold: !isTold(band), key: 'band.disperse', text: pick(world, [`${BandName(band)} sailed away and were not seen again in those waters.`, `The last ships of ${bandName(band)} were broken up for timber on the shore of their cove.`]) });
    endBand(world, band, 'dispersed');
    return;
  }
  // prizes buy ships and crews (within the cap)
  if ((band.loot || 0) > band.strength * 2) {
    const add = Math.min(band.strength * 0.15, capRoom(world) * 0.4, Math.max(0, 400 - band.strength));
    if (add >= 1 && roomFor(world, add)) band.strength += add;
  }
  if (band.leader && rng.chance(0.05)) {
    band.leader = makeLeader(world, world.civs[band.originCivId]?.language || world.lang, { epithet: 0.7, theme: 'sea' });
    if ((band.raids || 0) >= 4 && ready(world, `ldr${band.id}`, 10 * DAYS_PER_YEAR)) {
      say(world, band, { cat: 'trade', imp: 1, fold: true, key: 'band.leader', text: `${cap(bandName(band))} elected a new captain, ${band.leader.name}, ${pick(world, ['after the old one was hanged in a harbour town', 'when the old captain drowned', 'by acclaim on the deck'])}.` });
    }
  }
}

registerKind('pirates', { spawn, month, day, rest: (b) => b.data.wait > 0, arrive, year });
