// Bands · the restless dead (Mythic worlds only). Great battles leave mass graves (pinned to
// the map as 'grave' sites: the battle hook, when the dead number at least max(250, 0.2 % of
// the world's people)), and razed cities leave theirs. Decades later a grave may rise — more
// readily in the long winter nights away from the tropics, and the more dead it holds. The
// host (power ∝ dead^0.8, capped at 0.4 % of the world's people) marches on the nearest living
// town, then the next (never the same one twice in a year); every town it overruns feeds it a
// share of its slain, but after three months without slaughter it fades (0.6 % a day, 1.5 % in
// a low-latitude summer) until nothing walks. Realms raided by the same host count it a common
// foe (the opinion provider in index.js); holy hosts fight it best.

import { settlementsNear, getBand } from '../../../core/entities.js';
import { addSite, getSite, updateSite } from '../../../core/sites.js';
import { on } from '../../../core/hooks.js';
import { mythOn } from '../../../core/params.js';
import { DAYS_PER_YEAR, MONTH_SEASON } from '../../../core/constants.js';
import { latitude, monthOf } from '../../../core/world.js';
import { clamp } from '../../../core/util.js';
import { registerKind, spawnBand, endBand, ready, isReady as readyCheck, aliveOf, worldPop } from '../engine.js';
import { planRoute } from '../move.js';
import { raidTown } from '../combat.js';
import { beastName, undeadTitle } from '../names.js';
import { say, pick, cap, count, when, placePhrase, bandName, BandName } from '../prose.js';

const MAX_UNDEAD = 3;
const Y = DAYS_PER_YEAR;

const graveFloor = (world) => Math.max(250, worldPop(world) * 0.002);
const powerCap = (world) => Math.max(60, worldPop(world) * 0.004);

/** Remember a mass grave (from the battle hook or a razed city). */
function grave(world, x, y, dead, name, civIds, seq = null) {
  // seq: the chronicle entry of the slaughter that dug it (the first one, when graves merge)
  addSite(world, { kind: 'grave', x, y, dead, name, civIds, data: Number.isFinite(seq) ? { risen: 0, seq } : { risen: 0 } });
}

on('battle', (world, b) => {
  if (!b || !mythOn(world) || !world.sys.bands || b.kind === 'beast' || b.kind === 'band') return;
  const dead = (b.dead?.a || 0) + (b.dead?.d || 0);
  if (dead < graveFloor(world)) return;
  const field = b.name ? String(b.name).replace(/^the\s+/i, '').replace(/^(battle|fight|slaughter|siege|sack|storming)\s+(of|at|on)\s+/i, '') : null;
  grave(world, b.x, b.y, dead, field ? `the Graves of ${field}` : null, [b.attackerId, b.defenderId].filter((v) => v != null && v >= 0), b.seq);
});

on('settlementDestroyed', (world, s, cause) => {
  if (!s || !mythOn(world) || !world.sys.bands || !/raz|sack|burn|dragon|undead/i.test(String(cause || ''))) return;
  const dead = Math.max(0, (s.peakPopulation || 0) * 0.3);
  if (dead < 150) return;
  grave(world, s.x, s.y, dead, `the Haunted Ruins of ${s.name}`, [s.civId], s.flags?.fallSeq);
});

const winterNight = (world, y) => {
  const lat = latitude(world, clamp(Math.round(y), 0, world.H - 1));
  if (Math.abs(lat) < 0.35) return false;
  const s = MONTH_SEASON[monthOf(world)];
  return (lat >= 0 ? s : (s + 2) % 4) === 0;
};

function spawn(world) {
  if (aliveOf(world, 'undead') >= MAX_UNDEAD) return;
  const rng = world.rng;
  const abund = Math.max(0, world.params.monsterAbundance ?? 1);
  if (abund <= 0) return;
  const day = world.time.day;
  // (integration: at most one rising a generation, world-wide; ready() is checked before any draw)
  if (!readyCheck(world, 'undead.rise', 25 * Y)) return;
  for (const site of world.sites) {
    if (site.kind !== 'grave' || site.data?.risen || day - site.firstDay < 10 * Y) continue;
    const p = 0.00012 * Math.sqrt(site.dead / 500) * abund * (winterNight(world, site.y) ? 1.8 : 1);
    if (!rng.chance(p)) continue;
    ready(world, 'undead.rise', 25 * Y);
    rise(world, site);
    return;
  }
}

/** A grave rises. */
export function rise(world, site, opts = {}) {
  const power = Math.round(Math.min(powerCap(world), 6 * Math.pow(Math.max(50, site.dead), 0.8)) * (opts.mul || 1));
  const band = spawnBand(world, {
    kind: 'undead', name: site.name ? site.name.replace(/^the (Graves|Haunted Ruins) of /, () => `the ${undeadTitle(world)} of `) : beastName(world, 'undead', site.x, site.y),
    x: site.x, y: site.y, homeI: site.i, homeR: 25, state: 'lair', strength: 0, power, morale: 1,
    data: { grave: site.id, start: power, lastKill: world.time.day, last: world.time.day },
  });
  updateSite(world, site.id, { risen: world.time.day, bandId: band.id });
  say(world, band, {
    cat: 'myth', imp: opts.divine || power >= 2000 ? 3 : 2, key: 'undead.rise', x: site.x, y: site.y, ref: { k: 'band', id: band.id },
    cause: Number.isFinite(site.data?.seq) ? site.data.seq : null,
    text: opts.divine
      ? `At a word no living tongue could speak, the dead of ${site.name ? site.name.replace(/^the /, 'the ') : 'the old battlefield'} clawed their way up into the light.`
      : pick(world, [
        `${when(world, site.y)}, the earth of ${site.name || 'an old battlefield'} broke open, and ${count(site.dead)} dead rose as ${bandName(band)}.`,
        `Mist lay over ${site.name || 'the old killing ground'} for a week, and when it lifted the dead were walking: ${bandName(band)}.`,
        `${cap(bandName(band))} rose from ${site.name || 'the graves of the old war'}${placePhrase(world, site.x, site.y) ? ' ' + placePhrase(world, site.x, site.y) : ''} and turned toward the living.`,
      ]),
  });
  return band;
}

function nearestLiving(world, band, reach) {
  let best = null, bd = Infinity;
  const hit = band.data.hit || {};
  for (const s of settlementsNear(world, band.x, band.y, reach)) {
    if (hit[s.id] != null && world.time.day - hit[s.id] < Y) continue;
    const d = Math.hypot(s.x - band.x, s.y - band.y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

function month(world, band) {
  if (band.power < 20) { fade(world, band); return; }
  if (band.state === 'lair' || (band.state === 'roam' && (band.targetSid < 0 || !world.settlements[band.targetSid]?.alive))) {
    const s = nearestLiving(world, band, 20);
    if (s && planRoute(world, band, s.i)) { band.targetSid = s.id; band.state = 'raid'; }
  }
}

/** The dead fade without slaughter, faster in a southern summer. */
function day(world, band) {
  const lat = Math.abs(latitude(world, clamp(Math.round(band.y), 0, world.H - 1)));
  const summer = MONTH_SEASON[monthOf(world)] === 2;
  const since = world.time.day - (band.data.lastKill ?? band.createdDay);
  if (since > 90) band.power *= lat < 0.35 && summer ? 0.985 : 0.994;
  if (band.power < 20) fade(world, band);
}

function arrive(world, band) {
  const s = band.targetSid >= 0 ? world.settlements[band.targetSid] : null;
  band.targetSid = -1;
  if (s && s.alive) {
    (band.data.hit ||= {})[s.id] = world.time.day;
    const r = raidTown(world, band, s, {});
    if (!getBand(world, band.id)) return;
    if (r.ok && r.deaths > 0) {
      band.power = Math.min(powerCap(world), band.power + 0.3 * r.deaths * 3);
      band.data.lastKill = world.time.day;
    }
  }
  band.state = 'lair';
  band.path = null;
}

function fade(world, band) {
  if (!getBand(world, band.id)) return;
  const site = getSite(world, band.data.grave);
  if (site) updateSite(world, site.id, { laid: world.time.day });
  if ((band.raids || 0) >= 1 || ready(world, 'undeadFade', 30 * Y)) {
    say(world, band, {
      cat: 'myth', imp: 2, key: 'undead.fade',
      text: pick(world, [`${BandName(band)} crumbled at last into dust and old iron ${placePhrase(world, band.x, band.y) || 'where it had stopped'}.`, `The last of ${bandName(band)} lay down in the fields and did not rise again.`]),
    });
  }
  endBand(world, band, 'faded');
}

registerKind('undead', { myth: true, spawn, month, day, rest: () => true, arrive });

