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
import { on, emit } from '../../../core/hooks.js';
import { mythOn } from '../../../core/params.js';
import { DAYS_PER_YEAR, MONTH_SEASON } from '../../../core/constants.js';
import { latitude, monthOf } from '../../../core/world.js';
import { clamp } from '../../../core/util.js';
import { enemySet } from '../../geo/common.js';
import { registerKind, spawnBand, endBand, ready, isReady as readyCheck, aliveOf, worldPop } from '../engine.js';
import { planRoute } from '../move.js';
import { raidTown } from '../combat.js';
import { beastName, undeadTitle } from '../names.js';
import { say, pick, cap, count, when, placePhrase, bandName, BandName } from '../prose.js';

const MAX_UNDEAD = 3;
const Y = DAYS_PER_YEAR;

const graveFloor = (world) => Math.max(250, worldPop(world) * 0.002);
const powerCap = (world) => Math.max(60, worldPop(world) * 0.004);
/** A host's ceiling: the ordinary one, × its potential if it was raised with the makings of a scourge (myth/sickness.js: data.sc.cm). */
const capOf = (world, band) => powerCap(world) * (band.data && band.data.sc && Number.isFinite(band.data.sc.cm) ? band.data.sc.cm : 1);

/** Remember a mass grave (from the battle hook or a razed city). Returns the site. */
function grave(world, x, y, dead, name, civIds, seq = null) {
  // seq: the chronicle entry of the slaughter that dug it (the first one, when graves merge)
  return addSite(world, { kind: 'grave', x, y, dead, name, civIds, data: Number.isFinite(seq) ? { risen: 0, seq } : { risen: 0 } });
}
/** Published: a grave dug by other means (a grave-plague's dead, myth/sickness.js). Returns the site. */
export const digGrave = grave;

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

/**
 * A grave rises. opts: { mul (× power), divine, text (the line told, or a function of the host's name), bound: { c, w, r, u } (a
 * host bound to realm c in war w while ruler r reigns, until day u: myth/sickness.js) }.
 */
export function rise(world, site, opts = {}) {
  const power = Math.round(Math.min(powerCap(world), 6 * Math.pow(Math.max(50, site.dead), 0.8)) * (opts.mul || 1));
  const band = spawnBand(world, {
    kind: 'undead', name: site.name ? site.name.replace(/^the (Graves|Haunted Ruins|Plague-Pits) of /, () => `the ${undeadTitle(world)} of `) : beastName(world, 'undead', site.x, site.y),
    x: site.x, y: site.y, homeI: site.i, homeR: 25, state: 'lair', strength: 0, power, morale: 1,
    data: { grave: site.id, start: power, lastKill: world.time.day, last: world.time.day, ...(opts.bound ? { bound: { ...opts.bound } } : {}) },
  });
  if (opts.bound) band.civId = opts.bound.c;
  updateSite(world, site.id, { risen: world.time.day, bandId: band.id });
  emit(world, 'undeadRisen', band, site, opts);   // its potential (myth/sickness.js)
  say(world, band, {
    cat: 'myth', imp: opts.divine || power >= 2000 ? 3 : 2, key: 'undead.rise', x: site.x, y: site.y, ref: { k: 'band', id: band.id },
    cause: Number.isFinite(site.data?.seq) ? site.data.seq : null,
    text: opts.text ? (typeof opts.text === 'function' ? opts.text(bandName(band)) : opts.text) : opts.divine
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

// ---------------------------------------------------------------------------
// A host bound to a realm (a grave-plague's dead, myth/sickness.js): it marches only on the towns
// of its master's enemies, and the binding breaks when its master is at peace, its master's
// ruler dies or its time runs out. Then it is a host like any other.

function stillBound(world, b) {
  const civ = world.civs[b.c];
  // (a master who holds a Scourge holds it at peace too: b.hold, myth/sickness.js)
  return Boolean(civ && civ.alive && civ.ruler && civ.ruler.id === b.r && world.time.day < b.u && (b.hold || enemySet(world, b.c).size > 0));
}

function unbind(world, band) {
  const b = band.data.bound;
  delete band.data.bound;
  band.civId = -1;
  band.data.lastKill = world.time.day;   // a few months' grace before it starts to fade
  const civ = world.civs[b.c];
  say(world, band, {
    cat: 'myth', imp: 2, key: 'undead.unbound', ...(civ && civ.alive ? { civId: civ.id } : {}),
    text: pick(world, [
      `The binding on ${bandName(band)} broke${civ && civ.alive ? `, and the dead no longer knew ${civ.name} for their master` : ''}; they turned toward the nearest living.`,
      `${BandName(band)} was bound no longer. It stood a night where it was, and then it walked toward whoever was nearest.`,
    ]),
  });
}

/** The nearest town of the bound host's master's enemies (not hit in the last year). */
function nearestFoe(world, band, b, reach) {
  const foes = enemySet(world, b.c);
  let best = null, bd = Infinity;
  const hit = band.data.hit || {};
  for (const s of settlementsNear(world, band.x, band.y, reach)) {
    if (!foes.has(s.civId)) continue;
    if (hit[s.id] != null && world.time.day - hit[s.id] < Y) continue;
    const d = Math.hypot(s.x - band.x, s.y - band.y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// A Scourge (myth/sickness.js names it): a host raised with great potential grows past the
// ordinary ceiling, swallows the graves it passes, and does not fade while it kills; a year
// without new dead and it sleeps where it stands, weakening slowly (about 5 % a year) until
// fresh foes come near and wake it, or armies and heroes end it in its barrow.

/** The unrisen graves within 4 tiles rise into the host. */
function absorbGraves(world, band) {
  const day = world.time.day;
  for (const site of world.sites) {
    if (site.kind !== 'grave' || site.data?.risen || day - site.firstDay < Y || Math.abs(site.x - band.x) > 4 || Math.abs(site.y - band.y) > 4) continue;
    band.power = Math.min(capOf(world, band), band.power + 3 * Math.pow(Math.max(50, site.dead), 0.8));
    updateSite(world, site.id, { risen: day, bandId: band.id });
    band.data.sc.graves = (band.data.sc.graves || 0) + 1;
  }
}

function goSleep(world, band) {
  band.state = 'sleep';
  band.path = null;
  band.targetSid = -1;
  band.data.slept = world.time.day;
  const lair = addSite(world, { kind: 'grave', x: band.x, y: band.y, dead: 0, name: `the Barrow of ${bandName(band).replace(/^the /, '')}`, civIds: [], data: { risen: world.time.day, barrow: band.id } });
  if (lair) band.data.lair = lair.id;
  say(world, band, {
    cat: 'myth', imp: 3, key: 'undead.sleep',
    text: pick(world, [
      `No new dead came to ${bandName(band)}, and it lay down ${placePhrase(world, band.x, band.y) || 'where it stood'} to sleep; the barrow it made there was shunned for a generation.`,
      `${BandName(band)} went to ground ${placePhrase(world, band.x, band.y) || 'in the wastes'}: it slept, and the living who remembered it did not.`,
    ]),
  });
}

function sleepMonth(world, band) {
  band.power *= 0.996;
  // fresh foes near its barrow wake it: a grown town, or an army passing close
  let near = false;
  for (const s of settlementsNear(world, band.x, band.y, 12)) if (fin0(s.population) >= 1000) { near = true; break; }
  let army = false;
  for (const a of world.armies) if (a.civId !== band.civId && Math.abs(a.x - band.x) <= 4 && Math.abs(a.y - band.y) <= 4 && a.flags?.hunt == null) { army = true; break; }
  if (!army && !(near && world.rng.chance(0.06))) return;
  band.state = 'lair';
  band.data.lastKill = world.time.day;
  band.data.woke = (band.data.woke || 0) + 1;
  say(world, band, {
    cat: 'myth', imp: 3, key: 'undead.wake',
    text: `${BandName(band)} woke in its barrow ${placePhrase(world, band.x, band.y) || ''} after ${Math.max(1, Math.round((world.time.day - band.data.slept) / Y))} years, and turned toward the living again.`.replace(/ {2,}/g, ' '),
  });
}
const fin0 = (v) => (Number.isFinite(v) ? v : 0);

function month(world, band) {
  if (band.power < 20) { fade(world, band); return; }
  if (band.state === 'sleep') { sleepMonth(world, band); return; }
  if (band.data.bound && !stillBound(world, band.data.bound)) unbind(world, band);
  const b = band.data.bound;
  const sc = band.data.sc;
  if (sc) absorbGraves(world, band);
  if (band.state === 'lair' || (band.state === 'roam' && (band.targetSid < 0 || !world.settlements[band.targetSid]?.alive))) {
    const s = b ? nearestFoe(world, band, b, 30) : nearestLiving(world, band, sc && sc.named ? 30 : 20);
    if (s && planRoute(world, band, s.i)) { band.targetSid = s.id; band.state = 'raid'; }
  }
}

/** The dead fade without slaughter, faster in a southern summer. */
function day(world, band) {
  if (band.state === 'sleep') return;
  const sc = band.data.sc;
  if (sc && sc.named) {
    // a Scourge does not fade: a year without new dead and it sleeps
    if (world.time.day - (band.data.lastKill ?? band.createdDay) > Y) goSleep(world, band);
    return;
  }
  const lat = Math.abs(latitude(world, clamp(Math.round(band.y), 0, world.H - 1)));
  const summer = MONTH_SEASON[monthOf(world)] === 2;
  const since = world.time.day - (band.data.lastKill ?? band.createdDay);
  // its master's art holds a bound host together longer
  if (since > 90) band.power *= band.data.bound ? 0.997 : lat < 0.35 && summer ? 0.985 : 0.994;
  if (band.power < 20) fade(world, band);
}

function arrive(world, band) {
  const s = band.targetSid >= 0 ? world.settlements[band.targetSid] : null;
  band.targetSid = -1;
  if (s && s.alive) {
    (band.data.hit ||= {})[s.id] = world.time.day;
    const cid = s.civId;
    const r = raidTown(world, band, s, {});
    if (!getBand(world, band.id)) return;
    if (r.ok && r.deaths > 0) {
      const sc = band.data.sc;
      // a host with the makings of a scourge feeds more on its dead (myth/sickness.js)
      band.power = Math.min(capOf(world, band), band.power + (sc ? 1.44 : 0.9) * r.deaths);
      band.data.lastKill = world.time.day;
      if (sc) {
        sc.n = (sc.n || 0) + 1;
        sc.dead = (sc.dead || 0) + r.deaths;
        if (!s.alive) sc.razed = (sc.razed || 0) + 1;
        if (cid >= 0 && !(sc.civs ||= []).includes(cid)) { sc.civs.push(cid); if (sc.civs.length > 16) sc.civs.shift(); }
        if (cid >= 0 && world.civs[cid] && !world.civs[cid].alive) sc.realms = (sc.realms || 0) + 1;
      }
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

