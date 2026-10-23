// Falling stars. Rare impacts with power-law sizes, from village-wreckers to world-
// enders: annihilation inside the crater, a blast ring, fires beyond it, a real crater
// carved into the elevation (centre depressed, rim raised; big ones become crater lakes
// once hydrology runs), ocean strikes raising mega-tsunamis, and large impacts throwing
// up an impact winter and a mass die-off of beasts. Natural strikes are scaled by the ext
// 'rates' key 'meteor'.
//
// Hook emitted: impact { x, y, r, deaths, ocean, towns } (towns: the sids destroyed or struck,
// ≤ 8). impactStrike() — what the blast does to a town — is shared with the tool's preview.

import { WATER, DAYS_PER_YEAR, KM_PER_TILE } from '../../core/constants.js';
import { emitFx, bumpVersion } from '../../core/world.js';
import { settlementsNear, damageSettlement, destroySettlement } from '../../core/entities.js';
import { chronicle } from '../../core/chronicle.js';
import { ignite } from '../ecology.js';
import { fin, clampR, cl01, pick, listJoin, deathsClause, yearNum, forDisc, fmtRough, emitHook, rateMul } from './common.js';
import { placePhrase } from './places.js';
import { recomputeWaterSafe, classifyBiomesSafe } from './external.js';
import { tsunami } from './quakes.js';

/** Daily roll. */
export function meteorTick(world, sys) {
  const p = world.params;
  // ≈ 0.45 strikes per 1000 years at the default meteorRate (0.5), so a millennium very
  // rarely sees more than two (SPEC §9: 0–2).
  const rate = 0.0009 * clampR(fin(p.meteorRate, 0.5), 0, 3) * clampR(fin(p.disasterRate, 1), 0, 3) * rateMul(world, 'meteor');
  if (rate <= 0 || !world.rng.chance(rate / DAYS_PER_YEAR)) return;
  const u = Math.max(1e-6, world.rng.next());
  const R = clampR(0.6 * Math.pow(u, -1 / 1.6), 0.5, 22);
  const i = Math.floor(world.rng.next() * world.N);
  impact(world, sys, i % world.W, (i / world.W) | 0, R);
}

/** Reach (tiles) of the blast around a crater of radius R: towns within it are struck. */
export const blastRadius = (R) => R * 2.5 + 0.5;

/**
 * What a strike of crater radius R at (x, y) does to settlement s: { gone } inside the crater,
 * else the blast strength g (0..1) and the share of its people it kills. Pure.
 */
export function impactStrike(s, x, y, R) {
  const d = Math.hypot(s.x - x, s.y - y);
  if (d <= R + 0.3) return { gone: true, g: 1, pop: 1 };
  const g = cl01(1 - (d - R) / (1.5 * R + 0.5));
  return { gone: false, g, pop: 0.5 * g * g + 0.05 * g };
}

/** A meteor of crater radius R (tiles) strikes (x, y). Emits impact. */
export function impact(world, sys, x, y, R, opts = {}) {
  const { W, f } = world;
  R = clampR(fin(R, 1), 0.4, 25);
  const i0 = y * W + x;
  const ocean = f.water[i0] !== WATER.LAND;
  sys.counts.meteors = (sys.counts.meteors || 0) + 1;
  sys.century.meteors = (sys.century.meteors || 0) + 1;
  emitFx(world, { type: 'meteor', x: x + 0.5, y: y + 0.5, r: R, ...(opts.divine ? { src: 'tool' } : {}) });
  const place = placePhrase(world, x, y, { settleDist: Math.max(4, R * 3) });
  let deaths = 0;
  const gone = [], hurt = [], struck = [];
  // Annihilation and blast.
  for (const s of settlementsNear(world, x + 0.5, y + 0.5, blastRadius(R))) {
    const hitS = impactStrike(s, x, y, R);
    const name = s.name, pop = s.population;
    if (hitS.gone) {
      deaths += pop;
      destroySettlement(world, s.id, 'meteor');
      gone.push(name);
      struck.push([s.id, pop]);
    } else {
      const g = hitS.g;
      const k = damageSettlement(world, s, { pop: hitS.pop, buildings: 0.7 * g, food: 0.5 * g, wealth: 0.4 * g, defense: 0.6 * g, cause: 'meteor' });
      deaths += k;
      if (!s.alive) gone.push(name); else if (g > 0.2) hurt.push(name);
      if (k > 0 || g > 0.2) struck.push([s.id, k]);
    }
  }
  // Ground: crater, blast scar, fires.
  if (!ocean) {
    const D = Math.min(0.2, 0.015 + 0.006 * R);
    forDisc(world, x, y, R * 1.6, (i, tx, ty, d) => {
      const r = d * 1.6; // in crater radii
      if (r <= 1) f.elevation[i] = clampR(f.elevation[i] - D * (1 - r * r), 0, 1);
      else if (r <= 1.6) f.elevation[i] = clampR(f.elevation[i] + 0.35 * D * Math.max(0, 1 - Math.abs(r - 1.2) / 0.3), 0, 1);
    });
  }
  forDisc(world, x, y, R * 2.5 + 0.5, (i, tx, ty, d) => {
    if (f.water[i] !== WATER.LAND) { f.fish[i] *= 1 - 0.8 * (1 - d); return; }
    const r = d * 2.5;
    if (r <= 1) { f.veg[i] = 0; f.herb[i] = 0; f.pred[i] = 0; f.soil[i] *= 0.3; f.devastation[i] = 1; f.burnScar[i] = 1; f.fire[i] = 0; }
    else {
      const g = 1 - (r - 1) / 1.5;
      f.veg[i] *= 1 - 0.7 * g; f.herb[i] *= 1 - 0.8 * g; f.pred[i] *= 1 - 0.8 * g;
      f.devastation[i] = Math.min(1, f.devastation[i] + 0.7 * g);
      f.burnScar[i] = Math.max(f.burnScar[i], 0.7 * g);
    }
  });
  forDisc(world, x, y, R * 3.5 + 1, (i, tx, ty, d) => {
    if (d * 3.5 < 1.2 || f.water[i] !== WATER.LAND) return;
    if (world.rng.chance(0.35 * (1 - d))) ignite(world, i, 0.8, { cause: 'meteor' });
  });
  // Sky and life.
  const c = world.climate;
  if (R >= 2) {
    c.aerosol = cl01(fin(c.aerosol) + Math.min(1, 0.045 * R * R));
    c.aerosolSource = { name: 'the falling star', day: world.time.day };
  }
  let dieoff = 0;
  if (R >= 4) {
    dieoff = Math.min(0.6, 0.06 * R);
    const { N } = world;
    const kp = Math.max(0, 1 - dieoff * 1.2), kh = 1 - dieoff, kf = 1 - dieoff * 0.4;
    for (let i = 0; i < N; i++) { f.herb[i] *= kh; f.pred[i] *= kp; f.fish[i] *= kf; }
  }
  // Terrain and water.
  bumpVersion(world, 'terrain');
  if (!ocean && R >= 1.5) { if (recomputeWaterSafe(world)) classifyBiomesSafe(world); else world.pending.hydro = true; }
  else if (!ocean) world.pending.hydro = true;
  let wave = null;
  if (ocean) wave = tsunami(world, sys, x, y, { range: 30 + 12 * R, height: cl01(0.5 + 0.12 * R), source: 'the falling star', quiet: true });
  sys.counts.meteorDeaths = (sys.counts.meteorDeaths || 0) + deaths + (wave?.deaths || 0);
  (sys.recent ||= []).push({ kind: 'meteor', day: world.time.day, R: Math.round(R * 10) / 10, x, y, deaths: Math.round(deaths + (wave?.deaths || 0)) });
  if (sys.recent.length > 40) sys.recent.shift();
  (sys.craters ||= []).push({ x, y, R: Math.round(R * 10) / 10, day: world.time.day, ocean });
  if (sys.craters.length > 30) sys.craters.shift();
  const lake = !ocean && f.water[i0] !== WATER.LAND;
  const entry = meteorChronicle(world, sys, x, y, R, ocean, place, lake, deaths, gone, hurt, wave, dieoff, opts);
  const towns = struck.sort((a, b) => b[1] - a[1]).map((q) => q[0]);
  for (const sid of wave ? wave.sids || [] : []) if (!towns.includes(sid)) towns.push(sid);
  emitHook(world, 'impact', { x, y, r: Math.round(R * 10) / 10, deaths: Math.round(deaths + (wave ? wave.deaths : 0)), ocean, towns: towns.slice(0, 8), lake, divine: Boolean(opts.divine), seq: entry ? entry.seq : null });
  return { deaths, gone, wave };
}

function meteorChronicle(world, sys, x, y, R, ocean, place, lake, deaths, gone, hurt, wave, dieoff, opts) {
  const yr = yearNum(world);
  const km = fmtRough(2 * R * KM_PER_TILE);
  let imp = R >= 6 ? 5 : R >= 3 ? 4 : R >= 1.2 || gone.length ? 3 : hurt.length ? 2 : 1;
  if (opts.divine) imp = Math.max(imp, 3);
  const totalDeaths = deaths + (wave?.deaths || 0);
  const dc = deathsClause(totalDeaths);
  const lead = opts.divine ? `Hurled down by an unseen hand, a star fell ${place.text} in Year ${yr}` : `In Year ${yr} a star fell ${place.text}`;
  // the lake belongs with the crater it fills, before the toll (not after it)
  const lk = lake ? ' that slowly filled into a round lake' : '';
  let text;
  if (ocean) {
    const shores = wave && wave.hit.length ? `; the mountain of water it raised drowned ${listJoin(wave.hit.slice(0, 4))}` : '; the great wave it raised broke on empty shores';
    text = `${lead}, striking the sea${shores}${dc ? ', ' + dc : ''}`;
  } else if (gone.length) {
    text = pick(world, [
      `${lead}; ${listJoin(gone.slice(0, 3))} vanished in a single flash, leaving a smoking crater ${km} km across${lk}${hurt.length ? `, and the walls of ${listJoin(hurt.slice(0, 2))} thrown down` : ''}${dc ? ', ' + dc : ''}`,
      `${lead} and blotted out ${listJoin(gone.slice(0, 3))}${dc ? ', ' + dc : ''}; where they had stood lay a crater ${km} km wide${lk}`,
    ]);
  } else if (hurt.length) {
    text = `${lead}, leaving a crater ${km} km across${lk}; the blast threw down the walls of ${listJoin(hurt.slice(0, 3))}${dc ? ', ' + dc : ''}`;
  } else {
    text = `${lead}, gouging a crater ${km} km across${lk}`;
  }
  if (R >= 6) text += ', and dust and smoke hid the sun as the beasts of the world perished in their multitudes';
  else if (dieoff > 0) text += ', and in the impact winter that followed the herds of half a world died in the long dark';
  else if (R >= 3) text += ', and its dust veiled the sky in an impact winter';
  return chronicle(world, { cat: opts.divine ? 'divine' : 'disaster', imp, text: text + '.', x, y, key: opts.divine ? 'divine.meteor' : 'impact', ...(place.sid != null ? { ref: { k: 'settlement', id: place.sid } } : {}), tags: [ocean ? 'ocean' : 'land'] });
}
