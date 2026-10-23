// Bands: roaming actors outside any state — bandits, pirates, free companies, hordes,
// migrations and (in Mythic worlds) beasts, dragons and the restless dead. The kernel owns the
// shape and the lifecycle; behaviour is WP2's (src/sim/bands/). Bands live in world.bands
// (ids from world.nextId.band) and never appear in areAtWar pairs.
//
// band = { id, kind (BAND_KINDS key), family, name, epithet: null,
//          x, y (float tiles), homeI, homeR, state ('lair'|'sleep'|'roam'|'raid'|'return'|
//          'hired'|'tamed'|'settling'),
//          strength (people; 0 for beasts), power (beasts; 0 for people), hp: 1, morale: 1, loot: 0,
//          leader: { name, skill, born, figureId? } | null,
//          civId: −1 (employer, tamer or patron), originCivId: −1,
//          targetSid: −1, targetI: −1, path: null, pathStep: 0,
//          createdDay, raids: 0, kills: 0, data: {} (kind-specific JSON) }

import { emit } from './hooks.js';
import { bumpVersion } from './world.js';
import { BAND_KINDS } from './constants.js';

/** Create a band from props (any band field), fill defaults, emit bandCreated. Returns the band. */
export function addBand(world, props = {}) {
  const meta = BAND_KINDS[props.kind] || null;
  const x = Number.isFinite(props.x) ? props.x : 0, y = Number.isFinite(props.y) ? props.y : 0;
  const homeI = Number.isFinite(props.homeI) ? props.homeI
    : Math.max(0, Math.min(world.H - 1, Math.round(y))) * world.W + Math.max(0, Math.min(world.W - 1, Math.round(x)));
  const band = {
    id: -1,
    kind: props.kind || 'bandits',
    family: meta ? meta.family : 'outlaw',
    name: null, epithet: null,
    x, y, homeI, homeR: 0,
    state: 'roam',
    strength: 0, power: 0, hp: 1, morale: 1, loot: 0,
    leader: null,
    civId: -1, originCivId: -1,
    targetSid: -1, targetI: -1,
    path: null, pathStep: 0,
    createdDay: world.time.day,
    raids: 0, kills: 0,
    data: {},
    ...props,
  };
  band.x = x; band.y = y; band.homeI = homeI;
  if (!band.data || typeof band.data !== 'object') band.data = {};
  world.nextId.band ??= 1;
  band.id = world.nextId.band++;
  world.bands.push(band);
  bumpVersion(world, 'bands');
  emit(world, 'bandCreated', band);
  return band;
}

/** Remove a band; emits bandDestroyed(world, band, cause) after removal. Returns the band or null. */
export function removeBand(world, id, cause = 'destroyed') {
  const k = world.bands.findIndex((b) => b.id === id);
  if (k < 0) return null;
  const band = world.bands[k];
  world.bands.splice(k, 1);
  bumpVersion(world, 'bands');
  emit(world, 'bandDestroyed', band, cause);
  return band;
}

/** The band with this id, or null. */
export function getBand(world, id) {
  if (id == null) return null;
  const bs = world.bands;
  for (let k = 0; k < bs.length; k++) if (bs[k].id === id) return bs[k];
  return null;
}

/** Bands within radius r (tiles) of (x, y), optionally filtered, in list order. */
export function bandsNear(world, x, y, r, filter = null) {
  const out = [];
  const r2 = r * r;
  for (const b of world.bands) {
    const dx = b.x - x, dy = b.y - y;
    if (dx * dx + dy * dy <= r2 && (!filter || filter(b))) out.push(b);
  }
  return out;
}
