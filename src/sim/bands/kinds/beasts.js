// Bands · the bestiary (Mythic worlds only): wyverns over the peaks, trolls in the northern
// forests, giants in the hills, treants in the old woods, krakens in the deep ocean, behemoths
// on the grasslands. Capacity K = monsterAbundance × weave × land/800 (≤ 60) × rates
// 'beastSpawn'; newcomers appear on wild tiles at least 6 tiles from any owned land, by
// habitat. Each kind keeps its own habits:
//   wyvern    stoops on herds and caravans within 12 tiles
//   troll     raids only on long winter nights, away from the tropics
//   giant     now and then smashes a village (tier ≤ 2) within 8 tiles
//   treant    sleeps until its wood is cleared or farmed, then walks against the farms
//   kraken    drags ships under and mauls fleets that sail too near
//   behemoth  migrates between a summer and a winter range, trampling fields on the way
// Monsters retreat before civilisation: a home ploughed and settled around is abandoned for a
// wilder one, or the beast dies out. Realms whose beast-masters know taming (the WP5 mod key
// 'taming', ≥ 0.3) may bind tamable kinds; a tamed beast marches beside its master's strongest
// army (the battle provider in index.js) or rests at the capital. Nothing here runs, draws rng
// or allocates below mythLevel 2 (engine.js skips mythic kinds and spawners).

import { settlementsNear, getBand, nearestSettlement, damageArmy, liveCivs } from '../../../core/entities.js';
import { emit } from '../../../core/hooks.js';
import { emitFx } from '../../../core/world.js';
import { mulOf } from '../../../core/ext.js';
import { DAYS_PER_YEAR, WATER, BIOME, MONTH_SEASON } from '../../../core/constants.js';
import { latitude, monthOf } from '../../../core/world.js';
import { clamp, clamp01, weightedIndex } from '../../../core/util.js';
import { registerKind, spawnBand, endBand, state, ready, aliveOf } from '../engine.js';
import { planRoute, planHome, tileOf, modeOf } from '../move.js';
import { raidTown, robRoute, routesNear } from '../combat.js';
import { beastName } from '../names.js';
import { say, pick, cap, civName, count, when, placePhrase, whereFor, bandName, BandName } from '../prose.js';

export const BEAST_KINDS = ['wyvern', 'troll', 'giant', 'treant', 'kraken', 'behemoth'];
const POWER = { wyvern: [80, 200], troll: [40, 120], giant: [150, 400], treant: [120, 300], kraken: [300, 900], behemoth: [200, 500] };
const LIFE = { wyvern: 150, troll: 300, giant: 500, treant: 1000, kraken: 800, behemoth: 200 };
const RANGE = { wyvern: 12, troll: 8, giant: 8, treant: 5, kraken: 10, behemoth: 10 };
/** Kinds a people's beast-masters can bind, and which peoples have the knack (others at half odds). */
export const TAMABLE = { wyvern: ['orc'], troll: ['orc'], giant: ['orc'], behemoth: ['orc', 'lizardfolk'], treant: ['elf'] };
export const tamingOf = (civ) => (civ && civ.mods && Number.isFinite(civ.mods.taming) ? civ.mods.taming : 0);

const weave = (world) => (Number.isFinite(world.sys.myth?.weave) ? world.sys.myth.weave : 1);

/** Land tiles, cached by water version. */
export function landCount(world) {
  const c = world.cache;
  if (c.bandsLandV === world.versions.water && c.bandsLand > 0) return c.bandsLand;
  let n = 0;
  const w = world.f.water;
  for (let i = 0; i < world.N; i++) if (w[i] === WATER.LAND) n++;
  c.bandsLand = n; c.bandsLandV = world.versions.water;
  return n;
}

/** How many beasts (dragons aside) the wild can hold now. */
export function capacity(world) {
  const k = Math.max(0, world.params.monsterAbundance ?? 1) * weave(world) * landCount(world) / 800;
  return Math.min(60, k) * mulOf('rates', world, 'beastSpawn');
}

const beastCount = (world) => { let n = 0; for (const b of world.bands) if (b.family === 'beast' && b.kind !== 'dragon') n++; return n; };

/** No owned tile within r of (x, y)? */
export function wildAt(world, x, y, r = 6) {
  const { W, H, f } = world;
  for (let dy = -r; dy <= r; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= H) continue;
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= W) continue;
      if (f.owner[yy * W + xx] >= 0) return false;
    }
  }
  return true;
}

const FOREST = new Set([BIOME.TEMPERATE_FOREST, BIOME.TEMPERATE_RAINFOREST, BIOME.RAINFOREST, BIOME.TROPICAL_FOREST]);

/** Which beasts would make this tile their home: [[kind, weight]] (pure). */
function habitat(world, i) {
  const f = world.f;
  const b = f.biome[i], e = f.elevation[i];
  const lat = Math.abs(latitude(world, (i / world.W) | 0));
  if (f.water[i] !== WATER.LAND) return b === BIOME.DEEP_OCEAN ? [['kraken', 1]] : [];
  const out = [];
  if (e >= 0.82 || b === BIOME.ALPINE) out.push(['wyvern', 3], ['giant', 1], ['troll', 0.4]);
  else if (e >= 0.62) out.push(['giant', 2], ['troll', lat > 0.4 ? 1.5 : 0.4], ['wyvern', 0.5]);
  if (b === BIOME.TAIGA || b === BIOME.TUNDRA) out.push(['troll', lat > 0.35 ? 3 : 1], ['giant', 0.4]);
  if (FOREST.has(b) && f.veg[i] >= 0.6) out.push(['treant', 3], ['troll', b === BIOME.TEMPERATE_FOREST ? 0.4 : 0]);
  if (b === BIOME.WETLAND) out.push(['troll', 1], ['treant', 0.5]);
  if (b === BIOME.STEPPE || b === BIOME.SAVANNA || b === BIOME.SHRUBLAND) out.push(['behemoth', 3]);
  if (b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT) out.push(['behemoth', 0.5], ['giant', 0.4]);
  return out;
}

/** Deep water far from any coast (krakens keep away from the shallows). */
function deepSea(world, x, y) {
  const { W, H, f } = world;
  if (f.snow[y * W + x] > 0.4) return false;          // no kraken under the pack ice
  for (let dy = -4; dy <= 4; dy += 2) for (let dx = -4; dx <= 4; dx += 2) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) return false;
    if (f.water[yy * W + xx] === WATER.LAND) return false;
  }
  return true;
}

/** Bring a beast into the world at tile i. opts: { power, state, quiet, summoned } */
export function spawnBeast(world, kind, i, opts = {}) {
  const rng = world.rng;
  const x = i % world.W, y = (i / world.W) | 0;
  const [lo, hi] = POWER[kind] || [60, 200];
  const power = Math.round(opts.power || rng.float(lo, hi));
  const band = spawnBand(world, {
    kind, name: beastName(world, kind, x, y), x, y, homeI: i, homeR: RANGE[kind] || 8,
    state: opts.state || 'lair', strength: 0, power, morale: 1,
    data: { born: world.time.day - Math.round(rng.float(0, 0.6) * (LIFE[kind] || 200)) * DAYS_PER_YEAR, last: world.time.day, press: 0, summoned: Boolean(opts.summoned) },
  });
  if (kind === 'treant') band.data.veg0 = meanVeg(world, i, 2);
  if (kind === 'behemoth') {
    // a summer and a winter range, a dozen tiles apart on the grassland
    band.data.pa = i;
    band.data.pb = pole(world, i);
  }
  if (!opts.quiet && ready(world, `bs${kind}`, 6 * DAYS_PER_YEAR)) {
    const where = whereFor(kind === 'kraken' ? placePhrase(world, x, y, true) : placePhrase(world, x, y), band.name);
    const minor = kind === 'troll' || kind === 'wyvern' || kind === 'behemoth';
    say(world, band, {
      cat: 'myth', imp: minor ? 1 : 2, fold: minor, key: 'beast.rise', x, y,
      text: pick(world, {
        wyvern: [`Herdsmen began to speak of a wyvern nesting on the peaks${where ? ' ' + where.replace(/^in /, 'above ') : ''}: ${bandName(band)}.`, `A shadow with leather wings crossed the high pastures; men called it ${bandName(band)}.`],
        troll: [`In the long nights, villagers heard a troll moving ${where || 'in the northern woods'}: ${bandName(band)}.`, `${cap(bandName(band))} came down out of the fells to make its den ${where || 'in the far north'}.`],
        giant: [`A giant was seen striding ${where || 'among the hills'}: ${bandName(band)}.`, `${cap(bandName(band))}, a giant of the old world, made its home ${where || 'in the high country'}.`],
        treant: [`The oldest trees ${where || 'of the wild woods'} were said to walk: ${bandName(band)} stirred among them.`, `${cap(bandName(band))} slept ${where || 'in the deep forest'}, a tree older than any kingdom.`],
        kraken: [`Fishermen spoke of a kraken in the deep water${where ? ' ' + where : ''}: ${bandName(band)}.`, `${cap(bandName(band))} rose from the abyss${where ? ' ' + where : ''}.`],
        behemoth: [`The grass shook beneath ${bandName(band)}, a behemoth of the plains${where ? ' ' + where : ''}.`, `A behemoth wandered onto the grasslands${where ? ' ' + where : ''}, and men named it ${bandName(band)}.`],
      }[kind] || [`${cap(bandName(band))} appeared ${where || 'in the wild'}.`]),
    });
  }
  return band;
}

function meanVeg(world, i, r) {
  const { W, H, f } = world;
  const x = i % W, y = (i / W) | 0;
  let s = 0, n = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    const j = yy * W + xx;
    if (f.water[j] !== WATER.LAND) continue;
    s += f.veg[j]; n++;
  }
  return n ? s / n : 0;
}

function pole(world, i) {
  const { W, H, f } = world;
  const x = i % W, y = (i / W) | 0;
  // the other range lies along the latitude gradient (seasonal grazing), 8–14 tiles away
  for (let k = 0; k < 8; k++) {
    const d = 8 + world.rng.int(0, 6);
    const dir = y < H / 2 ? 1 : -1;
    const nx = clamp(x + world.rng.int(-4, 4), 0, W - 1), ny = clamp(y + dir * d, 0, H - 1);
    const j = ny * W + nx;
    if (f.water[j] === WATER.LAND && f.landmass[j] === f.landmass[i]) return j;
  }
  return i;
}

/** Try a few random tiles for a new beast; returns the band or null. */
function trySpawn(world, samples, quiet) {
  const { W, H, f } = world;
  const rng = world.rng;
  for (let k = 0; k < samples; k++) {
    const x = rng.int(2, W - 3), y = rng.int(2, H - 3);
    const i = y * W + x;
    if (f.water[i] !== WATER.LAND) {
      if (f.biome[i] !== BIOME.DEEP_OCEAN || aliveOf(world, 'kraken') >= Math.max(1, Math.round(capacity(world) / 10)) || !deepSea(world, x, y)) continue;
      return spawnBeast(world, 'kraken', i, { quiet });
    }
    if (f.settle[i] >= 0 || !wildAt(world, x, y, 6)) continue;
    const opts = habitat(world, i);
    if (!opts.length) continue;
    const kk = weightedIndex(rng, opts.map((o) => o[1]));
    if (kk < 0) continue;
    return spawnBeast(world, opts[kk][0], i, { quiet });
  }
  return null;
}

/** The first Mythic month: the wild is already full of old things. */
export function seedBestiary(world) {
  const want = Math.round(capacity(world) * 0.6);
  let made = 0;
  for (let t = 0; t < want * 6 && made < want; t++) if (trySpawn(world, 1, true)) made++;
}

function spawn(world) {
  if (beastCount(world) >= capacity(world)) return;
  trySpawn(world, 6, false);
}

// ---------------------------------------------------------------------------
// Habits

const winterNight = (world, y) => {
  const lat = latitude(world, clamp(Math.round(y), 0, world.H - 1));
  if (Math.abs(lat) < 0.35) return false;
  const s = MONTH_SEASON[monthOf(world)];
  return (lat >= 0 ? s : (s + 2) % 4) === 0;
};

function pickTown(world, band, reach, maxTier = 6) {
  let best = null, bs = 0;
  for (const s of settlementsNear(world, band.x, band.y, reach)) {
    if ((s.tier | 0) > maxTier) continue;
    const civ = world.civs[s.civId];
    if (band.state === 'tamed' && civ && civ.id === band.civId) continue;
    const d = Math.hypot(s.x - band.x, s.y - band.y);
    const sc = Math.sqrt(Math.max(1, s.population)) / (1 + d / 3);
    if (sc > bs) { bs = sc; best = s; }
  }
  return best;
}

function goRaid(world, band, s) {
  if (!s || !planRoute(world, band, s.i)) return false;
  band.state = 'raid'; band.targetSid = s.id; band.data.ambush = -1;
  return true;
}

function month(world, band) {
  const rng = world.rng;
  if (band.state === 'tamed') { tamedMonth(world, band); return; }
  if (band.state !== 'lair') return;
  const desperate = (band.data.press || 0) >= 6 ? 2 : 1;
  switch (band.kind) {
    case 'troll':
      if (winterNight(world, band.y) && rng.chance(0.5 * desperate)) goRaid(world, band, pickTown(world, band, 8, 3));
      break;
    case 'giant':
      if (rng.chance(0.08 * desperate)) goRaid(world, band, pickTown(world, band, 8, 2));
      break;
    case 'wyvern':
      if (rng.chance(0.15 * desperate)) {
        const roads = routesNear(world, band.x, band.y, 12, 'land');
        if (roads.length && rng.chance(0.5)) { band.data.ambush = roads[0].r.id; band.targetSid = -1; if (planRoute(world, band, roads[0].i)) band.state = 'raid'; }
        else goRaid(world, band, pickTown(world, band, 12, 4));
      }
      break;
    case 'treant':
      if (band.data.awake > 0) {
        band.data.awake--;
        if (rng.chance(0.4)) goRaid(world, band, pickTown(world, band, 6, 4));
      }
      break;
    case 'behemoth': {
      const summer = MONTH_SEASON[monthOf(world)] === 2 || MONTH_SEASON[monthOf(world)] === 1;
      const want = latitude(world, band.y) >= 0 === summer ? band.data.pa : band.data.pb;
      if (want != null && want !== tileOf(world, band.x, band.y) && rng.chance(0.5) && planRoute(world, band, want)) { band.state = 'roam'; band.homeI = want; }
      break;
    }
    case 'kraken': krakenMonth(world, band); break;
    default: break;
  }
  if (band.state === 'lair' && band.kind !== 'kraken' && (band.kind !== 'treant' || band.data.awake > 0) && rng.chance(0.07)) {
    // a prowl about the home range (it makes the wild feel inhabited)
    const W = world.W;
    const a = rng.next() * Math.PI * 2, r = rng.float(1, Math.max(2, (band.homeR || 6) * 0.6));
    const tx = clamp(Math.round((band.homeI % W) + Math.cos(a) * r), 0, W - 1), ty = clamp(Math.round(((band.homeI / W) | 0) + Math.sin(a) * r), 0, world.H - 1);
    const t = ty * W + tx;
    if ((modeOf(band) === 'fly' || world.f.water[t] === WATER.LAND) && planRoute(world, band, t)) band.state = 'roam';
  }
  // taming by a neighbouring people's beast-masters (only where some realm knows the art)
  if (TAMABLE[band.kind] && band.state !== 'tamed' && anyTamers(world)) tryTame(world, band);
}

function krakenMonth(world, band) {
  const rng = world.rng;
  // ships within reach
  for (const c of world.caravans) {
    if (c.kind !== 'ship' || Math.abs(c.x - band.x) > 10 || Math.abs(c.y - band.y) > 10 || Math.hypot(c.x - band.x, c.y - band.y) > 10) continue;
    const route = world.tradeRoutes[c.routeId];
    if (!route || !route.active || !rng.chance(0.15)) continue;
    const l = { r: route };
    robRoute(world, band, l.r, { quiet: true });
    // ships taken are tallied; a realm hears of its losses to this kraken once in thirty years
    const a = world.settlements[l.r.aId];
    const realm = a ? a.civId : -1;
    const n = rng.int(2, 4);
    const sunk = (band.data.ships ||= {});
    sunk[realm] = (sunk[realm] || 0) + n;
    if (ready(world, `kr${band.id}:${realm}`, 30 * DAYS_PER_YEAR)) {
      const total = sunk[realm];
      say(world, band, {
        cat: 'myth', imp: 1, fold: true, key: 'beast.ship', x: Math.round(c.x), y: Math.round(c.y), civId: realm >= 0 ? realm : null,
        text: total > n
          ? `${BandName(band)} dragged ${count(n)} more merchantmen of ${civName(world.civs[realm])} beneath the waves ${placePhrase(world, c.x, c.y, true)}; it had now taken ${count(total)} of their ships.`
          : pick(world, [
            `${cap(count(n))} merchantmen of ${civName(world.civs[realm])} were dragged beneath the waves ${placePhrase(world, c.x, c.y, true)} by ${bandName(band)}.`,
            `${BandName(band)} rose under a ship bound for ${world.settlements[l.r.bId]?.name || 'the far shore'} and broke it like kindling.`,
          ]),
      });
    }
    break;
  }
  // fleets that sail too near
  for (const a of world.armies) {
    if (!a.naval || Math.hypot(a.x - band.x, a.y - band.y) > 6 || !rng.chance(0.5)) continue;
    const lost = damageArmy(world, a, a.strength * rng.float(0.2, 0.6), 'beast');
    band.kills = (band.kills || 0) + lost;
    emit(world, 'battle', {
      day: world.time.day, x: Math.round(a.x), y: Math.round(a.y), i: tileOf(world, a.x, a.y), warId: a.warId ?? null, kind: 'beast',
      attackerId: -1, defenderId: a.civId, winnerCivId: -1, loserCivId: a.civId, bandId: band.id, dead: { a: 0, d: Math.round(lost) },
      engaged: Math.round(a.strength + lost + band.power), name: null, great: lost >= 300,
    });
    if (ready(world, `kra${band.id}`, 2 * DAYS_PER_YEAR)) {
      say(world, band, { cat: 'myth', imp: 2, key: 'beast.fleet', civId: a.civId, x: Math.round(a.x), y: Math.round(a.y), text: `${BandName(band)} fell upon the fleet of ${civName(world.civs[a.civId])}; ${count(lost)} sailors and soldiers went down with their ships.` });
    }
    break;
  }
}

function arrive(world, band) {
  if (band.state === 'roam' || band.state === 'return') { band.state = 'lair'; band.path = null; return; }
  if (band.data.ambush >= 0) {
    const r = world.tradeRoutes[band.data.ambush];
    if (r && r.active) robRoute(world, band, r);
    band.data.ambush = -1;
  } else if (band.targetSid >= 0) {
    const s = world.settlements[band.targetSid];
    if (s && s.alive) raidTown(world, band, s, {});
  }
  band.targetSid = -1;
  if (!getBand(world, band.id)) return;
  band.state = 'return';
  // no way home: it makes its lair where it stands (its haunts move with it)
  if (!planHome(world, band)) { band.state = 'lair'; band.path = null; band.homeI = tileOf(world, band.x, band.y); }
}

/** Behemoths trample what lies in their path; tamed beasts walk beside their masters. */
function day(world, band) {
  if (band.state === 'tamed') { tamedDay(world, band); return; }
  if (band.kind === 'behemoth' && band.state === 'roam' && (world.time.day + band.id) % 10 === 0) {
    const s = settlementsNear(world, band.x, band.y, 1.5)[0];
    if (s && ready(world, `bt${band.id}:${s.id}`, 2 * DAYS_PER_YEAR)) raidTown(world, band, s, { quiet: !ready(world, `btx${band.id}`, 4 * DAYS_PER_YEAR) });
  }
}

function year(world, band) {
  const rng = world.rng;
  const age = (world.time.day - (band.data.born ?? band.createdDay)) / DAYS_PER_YEAR;
  if (age > (LIFE[band.kind] || 300) && rng.chance(0.25)) {
    if (ready(world, `bd${band.kind}`, 20 * DAYS_PER_YEAR)) say(world, band, { cat: 'myth', imp: 1, fold: true, key: 'beast.death', text: `${BandName(band)} was found dead of great age ${placePhrase(world, band.x, band.y) || 'in the wild'}.` });
    endBand(world, band, 'age');
    return;
  }
  if (band.state === 'tamed') {
    const civ = world.civs[band.civId];
    if (!civ || !civ.alive || rng.chance(0.02 * (1 - clamp01(tamingOf(civ))))) feral(world, band, civ);
    return;
  }
  if (band.hp < 1) band.hp = clamp01(band.hp + 0.15);
  // the treant's wood: cleared or ploughed, it wakes
  if (band.kind === 'treant' && !(band.data.awake > 0)) {
    const v = meanVeg(world, band.homeI, 2);
    const W = world.W;
    const near = !wildAt(world, band.homeI % W, (band.homeI / W) | 0, 3);
    if (v < 0.6 * (band.data.veg0 || 0.7) || (near && rng.chance(0.1))) {
      band.data.awake = rng.int(18, 40);
      const told = ready(world, `tw${band.id}`, 30 * DAYS_PER_YEAR);
      say(world, band, {
        cat: 'myth', imp: told ? 2 : 1, fold: !told, key: 'beast.wake', text: pick(world, [
          `The axes came too close: ${bandName(band)} woke, and the wood began to walk.`,
          `${cap(bandName(band))} pulled its roots from the earth, angered by the clearing of its forest.`,
        ]),
      });
      band.data.veg0 = Math.max(v, 0.3);
    }
  }
  // civilisation closes in: move to wilder country, or fade away
  if (band.kind !== 'kraken') {
    const W = world.W;
    if (!wildAt(world, band.homeI % W, (band.homeI / W) | 0, 3)) band.data.press = (band.data.press || 0) + 1;
    else band.data.press = Math.max(0, (band.data.press || 0) - 1);
    if ((band.data.press || 0) >= 8) relocate(world, band);
  }
}

function relocate(world, band) {
  const { W, H, f } = world;
  const rng = world.rng;
  const x0 = band.homeI % W, y0 = (band.homeI / W) | 0;
  for (let k = 0; k < 12; k++) {
    const a = rng.next() * Math.PI * 2, r = rng.float(8, 25);
    const x = clamp(Math.round(x0 + Math.cos(a) * r), 2, W - 3), y = clamp(Math.round(y0 + Math.sin(a) * r), 2, H - 3);
    const i = y * W + x;
    if (f.water[i] !== WATER.LAND || !wildAt(world, x, y, 5)) continue;
    if (!habitat(world, i).some((o) => o[0] === band.kind)) continue;
    // its home moves only when it can get there (wilder country across the sea is no refuge)
    if (!planRoute(world, band, i)) { band.path = null; band.targetI = -1; continue; }
    band.homeI = i; band.data.press = 0;
    band.state = 'roam';
    return;
  }
  if (rng.chance(0.3)) {
    if (ready(world, `bl${band.kind}`, 15 * DAYS_PER_YEAR)) {
      say(world, band, { cat: 'myth', imp: 1, key: 'beast.gone', text: pick(world, [`The farms and roads crept up the valleys, and ${bandName(band)} was seen no more; it was said to be the last of its kind in those parts.`, `${BandName(band)} vanished from the country it had haunted; the woodsmen said it had gone to die.`]) });
    }
    endBand(world, band, 'retreated');
  }
}

// ---------------------------------------------------------------------------
// Taming

/** Does any living realm know taming (≥ 0.3)? */
function anyTamers(world) {
  for (const civ of liveCivs(world)) if (civ && civ.alive && tamingOf(civ) >= 0.3) return true;
  return false;
}

function tryTame(world, band) {
  const s = nearestSettlement(world, band.x, band.y, { maxDist: 15 });
  if (!s) return;
  const civ = world.civs[s.civId];
  const t = tamingOf(civ);
  if (!civ || t < 0.3) return;
  const aff = TAMABLE[band.kind].includes(civ.race) ? 1 : 0.5;
  // the town's beast-keepers (ext taming, Mythic) make the binding likelier
  if (world.rng.chance(0.04 * t * aff * mulOf('taming', world, civ, s))) tame(world, band, civ, {});
}

/** civ's beast-masters bind the beast. by: { divine } */
export function tame(world, band, civ, by = {}) {
  band.state = 'tamed';
  band.civId = civ.id;
  band.path = null;
  band.targetSid = -1;
  band.data.armyId = -1;
  band.data.tamedDay = world.time.day;
  band.data.tamedN = (band.data.tamedN || 0) + 1;
  band.data.pact = null;            // a bound dragon pays no heed to old bargains
  state(world).stats.tamed++;
  const cap0 = world.settlements[civ.capitalId];
  emitFx(world, { type: 'summon', x: band.x, y: band.y, r: 1.5, color: '#a98be6', ...(by.divine ? { src: 'tool' } : {}) });
  // a realm's first beast brought to heel is news; the rest are its beast-masters' trade
  const firstHere = !(civ.flags && civ.flags.tamedAny);
  (civ.flags ||= {}).tamedAny = 1;
  const timp = by.divine || band.kind === 'dragon' ? 3 : band.data.tamedN > 1 || !firstHere ? 1 : 2;
  say(world, band, {
    cat: 'myth', imp: timp, fold: timp < 2, key: 'beast.tamed', civId: civ.id, sid: cap0 ? cap0.id : null,
    text: by.divine
      ? pick(world, [`At an unseen command, ${bandName(band)} lowered its head before ${civName(civ)} and followed its banners from that day.`, `${cap(bandName(band))} came meekly to ${cap0 ? cap0.name : civName(civ)}, as if a god had led it by the horn.`])
      : pick(world, [
        `The beast-masters of ${civName(civ)} bound ${bandName(band)} with chains and songs; it ${band.kind === 'wyvern' ? 'nests' : 'sleeps'} now ${cap0 ? 'above ' + cap0.name : 'among them'}.`,
        `${when(world, band.y)}, ${civName(civ)} tamed ${bandName(band)}, and its enemies learned to fear it.`,
      ]),
  });
}

export function feral(world, band, civ) {
  band.state = 'roam';
  band.civId = -1;
  band.data.armyId = -1;
  // a dragon flies back to its lair; other beasts make a new home where they broke free
  band.homeI = Number.isFinite(band.data.lairI) ? band.data.lairI : tileOf(world, band.x, band.y);
  planHome(world, band);
  if (civ && civ.alive) say(world, band, { cat: 'myth', imp: band.kind === 'dragon' ? 2 : 1, key: 'beast.feral', civId: civ.id, text: `${BandName(band)} broke its chains and fled ${civName(civ)} for the wild.` });
}

/** Monthly: march with the master's strongest army, or rest at the capital. */
export function tamedMonth(world, band) {
  const civ = world.civs[band.civId];
  if (!civ || !civ.alive) { feral(world, band, civ); return; }
  let best = null;
  for (const a of world.armies) if (a.civId === civ.id && a.flags?.hunt == null && (!best || a.strength > best.strength)) best = a;
  band.data.armyId = best ? best.id : -1;
}

export function tamedDay(world, band) {
  const id = band.data.armyId;
  let army = null;
  if (id != null && id >= 0) for (const a of world.armies) if (a.id === id) { army = a; break; }
  if (army) { band.x = clamp(army.x + 0.9, 0, world.W - 1); band.y = clamp(army.y - 0.6, 0, world.H - 1); return; }
  if (id >= 0) band.data.armyId = -1;
  const civ = world.civs[band.civId];
  const cap0 = civ ? world.settlements[civ.capitalId] : null;
  if (cap0) { band.x = cap0.x + 0.8; band.y = cap0.y - 0.7; }
}

registerKind(BEAST_KINDS, { myth: true, spawn, month, arrive, day, year });

