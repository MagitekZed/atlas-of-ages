// Bands · free companies when no prince pays them. Hired companies march as armies (hire.js);
// a free company idles in its camp, drifts toward the nearest war in search of an employer,
// and, when the months without pay grow long, lives off the land like any brigand band. A
// company that has turned on its paymaster marches to storm the town it chose and, if it wins,
// makes it a free state (combat.js foundRealm, 'company'). Long idleness breaks them up.

import { settlementsNear, enemiesOf, nearestSettlement, getBand, liveCivs } from '../../../core/entities.js';
import { DAYS_PER_YEAR } from '../../../core/constants.js';
import { clamp } from '../../../core/util.js';
import { registerKind, endBand, ready } from '../engine.js';
import { planRoute, tileOf } from '../move.js';
import { raidTown, looksSoft, ransom, assault, foundRealm, attackOf } from '../combat.js';
import { syncHired } from '../hire.js';
import { makeLeader } from '../names.js';
import { say, pick, cap, count, bandName, BandName, isTold } from '../prose.js';

function month(world, band) {
  if (band.state === 'hired') return;
  if (band.strength < 10) { endBand(world, band, 'dwindled'); return; }
  if (band.state !== 'lair') return;
  const rng = world.rng;
  band.data.idle = (band.data.idle || 0) + 1;
  const idle = band.data.idle;
  // hungry companies plunder the country
  if (idle >= 4 && rng.chance(0.18)) {
    let town = null, ts = 0;
    const atk = attackOf(band);
    for (const s of settlementsNear(world, band.x, band.y, 10)) {
      if (!looksSoft(world, band, s, 0.8, atk)) continue;
      const sc = Math.sqrt(Math.max(0, (s.wealth || 0) + 0.05 * s.population)) / (1 + Math.hypot(s.x - band.x, s.y - band.y) / 4);
      if (sc > ts) { ts = sc; town = s; }
    }
    if (town && planRoute(world, band, town.i)) { band.state = 'raid'; band.targetSid = town.id; return; }
  }
  // drift toward a war where swords are wanted
  if (idle >= 3 && rng.chance(0.25)) {
    let best = null, bd = Infinity;
    const lm = world.f.landmass[tileOf(world, band.x, band.y)];
    for (const civ of liveCivs(world)) {
      if (!civ || !civ.alive || civ.id === band.data.foe || !enemiesOf(world, civ.id).length) continue;
      const s = nearestSettlement(world, band.x, band.y, { civId: civ.id, maxDist: 60 });
      if (!s || world.f.landmass[s.i] !== lm) continue;
      const d = Math.hypot(s.x - band.x, s.y - band.y);
      if (d > 3 && d < bd) { bd = d; best = s; }
    }
    if (best && planRoute(world, band, best.i)) { band.state = 'roam'; band.targetSid = -1; }
  }
}

function arrive(world, band) {
  if (band.state === 'return' || band.state === 'roam') { band.state = 'lair'; band.path = null; band.homeI = tileOf(world, band.x, band.y); return; }
  const s = band.targetSid >= 0 ? world.settlements[band.targetSid] : null;
  if (band.data.seize) {
    band.data.seize = 0;
    if (s && s.alive) {
      const r = assault(world, band, s);
      if (r.won && foundRealm(world, band, s, 'company', band.data.cause ?? null)) return;
      if (!r.won && getBand(world, band.id)) {
        say(world, band, {
          cat: 'war', imp: 2, key: 'band.repulsed', x: s.x, y: s.y, civId: s.civId, sid: s.id,
          text: pick(world, [`${cap(s.name)} shut its gates against ${bandName(band)}, and the mutineers broke on its walls.`, `The townsmen of ${s.name} threw back ${bandName(band)}, who went off to plunder easier country.`]),
        });
      }
    }
  } else if (s && s.alive) {
    const paid = s.tier >= 3 ? ransom(world, band, s) : null;
    if (paid !== 'paid') raidTown(world, band, s, { sevBonus: paid === 'refused' ? 0.25 : 0 });
  }
  band.targetSid = -1;
  if (!getBand(world, band.id)) return;
  // a company keeps no fixed camp: it makes one wherever the last march ended
  band.homeI = tileOf(world, band.x, band.y);
  band.state = 'lair';
  band.path = null;
}

function year(world, band) {
  if (band.state === 'hired') return;
  const rng = world.rng;
  const idle = band.data.idle || 0;
  if (idle >= 96 && rng.chance(0.35)) {
    if ((band.data.served || 0) >= 12 || (band.raids || 0) >= 3) {
      const notable = isTold(band) || (band.data.served || 0) >= 24;
      say(world, band, {
        cat: 'war', imp: notable ? 2 : 1, fold: !notable, key: 'band.disperse', civId: band.originCivId >= 0 ? band.originCivId : null,
        text: pick(world, [
          `${BandName(band)} broke up at last; its veterans sold their horses and drifted home after ${count((world.time.day - band.createdDay) / DAYS_PER_YEAR)} years under arms.`,
          `No war would have them, and ${bandName(band)} dissolved; ${band.leader ? band.leader.name + ' bought a farm' : 'its captains bought farms'} with the plunder.`,
        ]),
      });
    }
    endBand(world, band, 'dispersed');
    return;
  }
  if (band.leader && rng.chance(0.03 + Math.max(0, (world.time.day - band.leader.born) / DAYS_PER_YEAR - 55) * 0.02)) {
    const old = band.leader.name;
    band.leader = makeLeader(world, world.civs[band.originCivId]?.language || world.lang, { title: 'Captain', lo: 0.9, hi: 1.3 });
    if (ready(world, `ldr${band.id}`, 10 * DAYS_PER_YEAR)) {
      say(world, band, { cat: 'war', imp: 1, fold: true, key: 'band.leader', text: `${cap(old)} of ${bandName(band)} died ${pick(world, ['of a fever', 'of old wounds', 'in a duel'])}; the company chose ${band.leader.name} to lead it.` });
    }
  }
  band.morale = clamp((band.morale ?? 1) + 0.05, 0.05, 1.2);
}

registerKind('company', {
  month, arrive, year,
  day(world, band) { if (band.state === 'hired') syncHired(world, band); },
});
