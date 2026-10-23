// Previews for the life tools (contracts §11): bloom, forest, herds, predators, fish and
// wildfire — how much land or water they would touch, the towns a fire could reach, how dry
// the country is. Kept apart from previews.js so ecology imports them without the disaster
// modules. Pure: no world.rng, no mutation.

import { WATER, BIOME, KM_PER_TILE } from '../../core/constants.js';
import { settlementsNear } from '../../core/entities.js';
import { fin, cl01, forDisc, listJoin, fmtRough, numberWord } from './common.js';
import { placePhrase } from './places.js';

const tgt = (sids) => sids.slice(0, 24).map((id) => ({ kind: 'settlement', id }));
const plural = (n, w) => `${numberWord(n)} ${w}${n === 1 ? '' : 's'}`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "on the plains near Oskel" when the brush is over land, else nothing (a sea says nothing of where). */
const where = (world, x, y) => (world.f.water[y * world.W + x] === WATER.LAND ? ' ' + placePhrase(world, x, y).text : '');

export function wildfirePreview(world, x, y, opts = {}) {
  const f = world.f, R = Math.max(0, fin(opts.radius, 2));
  let n = 0, dry = 0;
  forDisc(world, x, y, R, (i) => {
    if (f.water[i] !== WATER.LAND || f.veg[i] < 0.06 || f.snow[i] > 0.6) return;
    n++; dry += 1 - cl01((f.soilWater[i] - 0.1) / 0.35);
  });
  if (!n) return { ok: false, reason: 'Nothing here will burn.', rings: [{ x, y, r: Math.max(1, R), tone: 'neutral' }] };
  const d = dry / n;
  const near = settlementsNear(world, x, y, R + 5);
  return {
    ok: true, tone: 'bane', severity: d > 0.6 && near.length ? 3 : 2,
    text: `${cap(plural(n, 'tile'))} would catch${d > 0.6 ? '; tinder-dry, it could spread far on the wind' : d < 0.25 ? '; damp ground, it may soon gutter out' : ''}${near.length ? ` · ${listJoin(near.slice(0, 2).map((s) => s.name))} within reach` : ''}`,
    targets: tgt(near.map((s) => s.id)), rings: [{ x, y, r: Math.max(1, R), tone: 'bane' }, { x, y, r: R + 5, tone: 'danger' }],
  };
}

/** Tiles a life tool would touch: water tiles for fish, else land (forests never on ice). */
function lifeTiles(world, x, y, R, water, noIce) {
  let n = 0;
  forDisc(world, x, y, Math.max(0.5, R), (i) => {
    if ((world.f.water[i] !== WATER.LAND) !== water) return;
    if (noIce && world.f.biome[i] === BIOME.ICE) return;
    n++;
  });
  return n;
}

function lifePreview(world, x, y, opts, def, water, word, reason, tone = 'boon', noIce = false) {
  const R = Math.max(0.5, fin(opts.radius, def));
  const n = lifeTiles(world, x, y, R, water, noIce);
  if (!n) return { ok: false, reason, rings: [{ x, y, r: R, tone: 'neutral' }] };
  const km = fmtRough(n * KM_PER_TILE * KM_PER_TILE);
  return { ok: true, tone, severity: 0, text: word(km, n), rings: [{ x, y, r: R, tone }] };
}

export const bloomPreview = (world, x, y, opts = {}) => lifePreview(world, x, y, opts, 6, false, (km) => `Lush growth and richer soil over ${km} km²${where(world, x, y)}`, 'Nothing grows on open water.');
export const forestPreview = (world, x, y, opts = {}) => lifePreview(world, x, y, opts, 5, false, (km) => `Woodland would rise over ${km} km², holding the soil and the rain`, 'Trees will not take root here.', 'boon', true);
export const herdsPreview = (world, x, y, opts = {}) => lifePreview(world, x, y, opts, 6, false, (km) => `Grazing herds would spread over ${km} km²${where(world, x, y)}`, 'The herds would drown.');
export const predatorsPreview = (world, x, y, opts = {}) => lifePreview(world, x, y, opts, 6, false, (km) => `Wolves and great cats would hunt ${km} km², thinning the herds`, 'There is nothing to hunt at sea.', 'neutral');
export const fishPreview = (world, x, y, opts = {}) => lifePreview(world, x, y, opts, 8, true, (km) => { const p = placePhrase(world, x, y); return `${p.kind === 'sea' || p.kind === 'ocean' || p.kind === 'lake' ? `The waters of ${p.name}` : 'The waters'} would teem with fish over ${km} km²`; }, 'Fish need water.');
