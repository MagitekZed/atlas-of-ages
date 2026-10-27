// Previews for the nature tools (contracts §11): what a quake, eruption, falling star, wave,
// flood, swarm, storm, rain, drought, bolt, fire or new life would do at the cursor, before the
// click — the towns in reach (targets), danger rings (quake reach, crater and blast, burning
// clouds and ash plume, a storm's forecast cone), threads along forecast tracks, a one-line
// forecast with names and places, and a rough toll (estimate.deaths as a [lo, hi] range).
//
// Every number comes from the same helpers the tools apply with (quakeStrike, tsunamiReach /
// tsunamiStrikes / tsunamiToll, pyroclasticRadius / forAsh, impactStrike / blastRadius,
// forecastTrack, swarmRadius), so the hover promises what the click does. All pure: no world.rng,
// no mutation of saved state (scratch buffers and caches only).
//
// Exports: one preview per tool id (quakePreview, volcanoPreview, meteorPreview, tsunamiPreview,
// floodPreview, locustsPreview, stormPreview, rainPreview, droughtPreview, lightningPreview,
// blizzardPreview, steerPreview) and stormKindAt, forecastTowns, steerPush. The previews of the
// life tools live in previews-life.js (ecology imports them without the disaster modules).

import { WATER, BIOME, BIOMES, KM_PER_TILE } from '../../core/constants.js';
import { settlementsNear } from '../../core/entities.js';
import { mulOf, hasProviders } from '../../core/ext.js';
import { latitude } from '../../core/world.js';
import { fin, clampR, cl01, forDisc, listJoin, fmtRough, numberWord } from './common.js';
import { quakeRadius, quakeStrike, tsunamiReach, tsunamiStrikes, tsunamiToll } from './quakes.js';
import { nearestVolcano, pyroclasticRadius, forAsh } from './volcanoes.js';
import { impactStrike, blastRadius } from './meteors.js';
import { forecastTrack, stormRadius } from './storms.js';
import { swarmRadius } from './floods.js';
import { placePhrase, regionName, featureAt, withArticle } from './places.js';

const people = (n) => fmtRough(Math.max(0, n));
const dmgMul = (world, s, cause) => (hasProviders('damage') ? mulOf('damage', world, s, cause) : 1);
const tgt = (sids) => sids.slice(0, 24).map((id) => ({ kind: 'settlement', id }));
/** estimate.deaths as a [lo, hi] range — left out when no one would die. */
const range = (lo, hi) => (hi >= 1 ? { deaths: [Math.round(lo), Math.max(Math.round(lo), Math.round(hi))] } : {});
const plural = (n, w) => `${numberWord(n)} ${w}${n === 1 ? '' : 's'}`;

/** "Oshanun (2,821) and 3 more" for the towns at greatest risk. */
function townList(world, list, n = 2) {
  const names = list.slice(0, n).map((q) => `${world.settlements[q.sid].name} (${people(world.settlements[q.sid].population)})`);
  const more = list.length - names.length;
  return more > 0 ? `${names.join(', ')} and ${more} more` : listJoin(names);
}

// ---------------------------------------------------------------------------
// Waves (shared by quakes and ocean strikes)

function waveForecast(world, x, y, rng, h) {
  const reach = tsunamiReach(world, x, y, rng, h);
  if (!reach) return null;
  const struck = tsunamiStrikes(world, reach.coastHit);
  const list = [];
  let dead = 0;
  for (const [sid, g] of struck) {
    const s = world.settlements[sid];
    if (!s || !s.alive) continue;
    const d = s.population * tsunamiToll(s, g) * dmgMul(world, s, 'tsunami');
    dead += d;
    list.push({ sid, d });
  }
  list.sort((a, b) => b.d - a.d);
  return { list, dead, coasts: reach.coastHit.size };
}

// ---------------------------------------------------------------------------
// Catastrophes

export function quakePreview(world, x, y, opts = {}) {
  const M = Math.round(clampR(fin(opts.strength, 7), 4, 9.8) * 10) / 10;
  const R = quakeRadius(M);
  const list = [];
  let dead = 0;
  for (const s of settlementsNear(world, x + 0.5, y + 0.5, R)) {
    const k = quakeStrike(world, s, x, y, M);
    if (k.I < 0.04) continue;
    const d = s.population * Math.min(1, k.pop * dmgMul(world, s, 'earthquake'));
    dead += d;
    list.push({ sid: s.id, d });
  }
  list.sort((a, b) => b.d - a.d);
  const i = y * world.W + x;
  const undersea = world.f.water[i] === WATER.OCEAN;
  const wave = undersea && M >= 7.5 ? waveForecast(world, x, y, 25 * (M - 7), cl01((M - 7) / 2.2 + 0.3)) : null;
  const towns = list.length + (wave ? wave.list.length : 0);
  const bits = [`M${M.toFixed(1)}`];
  if (list.length) bits.push(`would shake ${townList(world, list)}`);
  else bits.push(`would ${undersea ? 'split the sea floor' : 'tear empty land'} ${placePhrase(world, x, y, { settleDist: 0, useSettlement: false }).text}`);
  if (wave) bits.push(wave.list.length ? `a tsunami would break on ${plural(wave.list.length, 'town')}` : 'a tsunami would race out to empty shores');
  const total = dead + (wave ? wave.dead : 0);
  return {
    ok: true, tone: 'bane', severity: M >= 8.5 ? 5 : M >= 7.5 ? 4 : M >= 6.5 ? 3 : 2,
    text: bits.join(' · '),
    targets: tgt(list.map((q) => q.sid).concat(wave ? wave.list.map((q) => q.sid) : [])),
    rings: [{ x: x + 0.5, y: y + 0.5, r: R, tone: 'bane' }, ...(wave ? [{ x: x + 0.5, y: y + 0.5, r: 25 * (M - 7), tone: 'danger' }] : [])],
    estimate: { ...range(total * 0.75, total * 1.1), towns },
  };
}

/** The burning clouds and ash plume of an eruption of this VEI at volcano v: { list, dead, rings }. */
function eruptionForecast(world, v, vei) {
  const hits = new Map();
  let dead = 0;
  const r = pyroclasticRadius(vei);
  if (r > 0) for (const s of settlementsNear(world, v.x, v.y, r)) {
    const d = Math.hypot(s.x - v.x, s.y - v.y) / r;
    const k = s.population * clampR(0.75 * (1 - d) + 0.1, 0, 0.95) * dmgMul(world, s, 'eruption');
    hits.set(s.id, k); dead += k;
  }
  const { L, ux, uy } = forAsh(world, v, vei, (i, th) => {
    const sid = world.f.settle[i];
    if (sid < 0 || hits.has(sid)) return;
    const s = world.settlements[sid];
    if (!s || !s.alive) return;
    const k = s.population * (vei >= 4 ? 0.03 * th : 0.004 * th) * dmgMul(world, s, 'eruption');
    hits.set(sid, k); dead += k;
  });
  const list = [...hits.entries()].map(([sid, d]) => ({ sid, d })).sort((a, b) => b.d - a.d);
  const rings = [];
  if (r > 0) rings.push({ x: v.x + 0.5, y: v.y + 0.5, r, tone: 'bane' });
  rings.push({ x: v.x + 0.5 + ux * L * 0.45, y: v.y + 0.5 + uy * L * 0.45, r: L * 0.55, tone: 'danger' });
  return { list, dead, rings };
}

export function volcanoPreview(world, x, y, opts = {}) {
  const vei = clampR(Math.round(fin(opts.strength, 4)), 1, 7);
  const v = nearestVolcano(world, x, y, 12);
  const at = v || { x, y, i: y * world.W + x, name: null };
  const f = eruptionForecast(world, at, vei);
  const sky = vei >= 6 ? '; years of volcanic winter' : vei === 5 ? '; red sunsets for months' : '';
  const where = v ? `Will wake ${v.name} (${Math.max(0, Math.round(Math.hypot(v.x - x, v.y - y)))} tiles)` : `Will raise a new volcano here, ${world.f.water[at.i] === WATER.LAND ? 'out of the fields' : 'out of the sea'}`;
  return {
    ok: true, tone: 'bane', severity: vei >= 6 ? 5 : vei >= 5 ? 4 : vei >= 4 ? 3 : 2,
    text: `${where} · VEI ${vei}${f.list.length ? ` · ${townList(world, f.list)} under ash and fire` : ''}${sky}`,
    targets: [...(v ? [{ kind: 'volcano', id: v.id }] : [{ kind: 'tile', x, y }]), ...tgt(f.list.map((q) => q.sid))],
    rings: f.rings, estimate: { ...range(f.dead * 0.7, f.dead * 1.2), towns: f.list.length },
  };
}

export function meteorPreview(world, x, y, opts = {}) {
  const R = clampR(fin(opts.strength, 2), 0.4, 20);
  const list = [], gone = [];
  let dead = 0;
  for (const s of settlementsNear(world, x + 0.5, y + 0.5, blastRadius(R))) {
    const k = impactStrike(s, x, y, R);
    const d = k.gone ? s.population : s.population * Math.min(1, k.pop * dmgMul(world, s, 'meteor'));
    if (k.gone) gone.push({ sid: s.id, d }); else if (d >= 1 || k.g > 0.2) list.push({ sid: s.id, d });
    dead += d;
  }
  gone.sort((a, b) => b.d - a.d); list.sort((a, b) => b.d - a.d);
  const ocean = world.f.water[y * world.W + x] !== WATER.LAND;
  const wave = ocean ? waveForecast(world, x, y, 30 + 12 * R, cl01(0.5 + 0.12 * R)) : null;
  const km = fmtRough(2 * R * KM_PER_TILE);
  const bits = [];
  const pl = ocean ? placePhrase(world, x, y, { settleDist: 6 }) : null;
  const strikes = pl && (pl.kind === 'sea' || pl.kind === 'ocean') ? `Strikes ${pl.name}` : pl ? `Strikes the sea ${pl.text}` : '';
  if (ocean) bits.push(wave && wave.list.length ? `${strikes}; a wave would reach ${plural(wave.list.length, 'town')}: ${townList(world, wave.list)}` : 'Strikes the open sea; its wave would break on empty shores');
  else bits.push(`Crater ${km} km${gone.length ? ` · would obliterate ${townList(world, gone)}` : ''}${list.length ? ` · blast reaches ${plural(list.length, 'town')}` : ''}`);
  if (R >= 6) bits.push('dust would hide the sun and the beasts of the world would perish');
  else if (R >= 4) bits.push('an impact winter and a great die-off of herds');
  else if (R >= 2) bits.push('an impact winter');
  const total = dead + (wave ? wave.dead : 0);
  return {
    ok: true, tone: 'bane', severity: R >= 6 ? 5 : R >= 3 ? 4 : R >= 1.2 ? 3 : 2,
    text: bits.join(' · '),
    targets: tgt(gone.concat(list).map((q) => q.sid).concat(wave ? wave.list.map((q) => q.sid) : [])),
    rings: [{ x: x + 0.5, y: y + 0.5, r: R, tone: 'bane' }, { x: x + 0.5, y: y + 0.5, r: blastRadius(R), tone: 'danger' }],
    estimate: { ...range(total * 0.85, total * 1.1), towns: gone.length + list.length + (wave ? wave.list.length : 0) },
  };
}

export function tsunamiPreview(world, x, y, opts = {}) {
  const h = clampR(fin(opts.strength, 0.7), 0.1, 1.5);
  const rg = 20 + 45 * h;
  const w = waveForecast(world, x, y, rg, h);
  if (!w) return { ok: false, reason: 'There is no sea here to raise.' };
  const fa = featureAt(world, x, y);
  const sea = fa && (fa.ft.kind === 'ocean' || fa.ft.kind === 'sea') ? withArticle(fa.ft.name) : 'the sea';
  return {
    ok: true, tone: 'bane', severity: w.dead >= 5000 ? 4 : w.list.length >= 3 ? 3 : 2,
    text: w.list.length ? `Waves from ${sea} would reach ${plural(w.list.length, 'town')}: ${townList(world, w.list)}` : `Waves from ${sea} would break only on empty shores`,
    targets: tgt(w.list.map((q) => q.sid)), rings: [{ x: x + 0.5, y: y + 0.5, r: rg, tone: 'bane' }],
    estimate: { ...range(w.dead * 0.75, w.dead * 1.1), towns: w.list.length },
  };
}

export function floodPreview(world, x, y, opts = {}) {
  const f = world.f, s0 = clampR(fin(opts.strength, 0.6), 0.05, 1), R = Math.max(1, fin(opts.radius, 6));
  const sea = world.climate.seaLevel;
  let n = 0;
  forDisc(world, x, y, R, (i, tx, ty, d) => {
    if (f.water[i] !== WATER.LAND) return;
    const lowland = 1 - Math.min(1, Math.max(0, (f.elevation[i] - sea) / 0.12));
    if (s0 * (1 - d * d) * (0.3 + 0.7 * Math.max(lowland, f.river[i] ? 1 : 0)) >= 0.05) n++;
  });
  if (!n) return { ok: false, reason: 'Only dry land can flood.', rings: [{ x, y, r: R, tone: 'neutral' }] };
  const list = [];
  let dead = 0;
  for (const s of settlementsNear(world, x, y, R)) {
    const d = Math.hypot(s.x - x, s.y - y) / R;
    const g = s0 * (1 - d * d);
    const k = s.population * 0.06 * g * dmgMul(world, s, 'flood');
    dead += k; list.push({ sid: s.id, d: k });
  }
  list.sort((a, b) => b.d - a.d);
  return {
    ok: true, tone: 'bane', severity: list.length >= 3 ? 3 : 2,
    text: `Would drown ${fmtRough(n * KM_PER_TILE * KM_PER_TILE)} km² of lowland${list.length ? ` and the harvests of ${townList(world, list)}` : ''}; the silt left behind enriches the soil`,
    targets: tgt(list.map((q) => q.sid)), rings: [{ x, y, r: R, tone: 'bane' }], estimate: { ...range(dead * 0.6, dead * 1.1), towns: list.length },
  };
}

/** The wind-borne drift of a new swarm (no chance): points and the towns under it. */
function swarmForecast(world, x, y, size) {
  const { W, H, f } = world;
  const ws = clampR(fin(world.params.windStrength, 1), 0, 2);
  let px = x + 0.5, py = y + 0.5, vx = 0, vy = 0, sz = cl01(size), sea = 0;
  const pts = [[px, py]], hit = new Set(), list = [];
  for (let d = 0; d < 42; d++) {
    const i = clampR(Math.floor(py), 0, H - 1) * W + clampR(Math.floor(px), 0, W - 1);
    vx += (fin(f.windX[i]) * ws * 2.4 - vx) * 0.5; vy += (fin(f.windY[i]) * ws * 2.4 - vy) * 0.5;
    vx = clampR(vx, -5, 5); vy = clampR(vy, -5, 5);
    px += vx; py += vy;
    if (!(px >= 0 && py >= 0 && px < W && py < H)) break;
    const j = clampR(Math.floor(py), 0, H - 1) * W + clampR(Math.floor(px), 0, W - 1);
    if (f.water[j] !== WATER.LAND) { sea++; sz -= 0.04; } else sea = 0;
    if (f.temp[j] < 15) sz -= 0.06;
    sz -= 0.006;
    if (d % 3 === 2) pts.push([px, py]);
    if (sz < 0.08 || sea > 3) break;
    if (sz > 0.1) for (const s of settlementsNear(world, px, py, swarmRadius(sz))) if (!hit.has(s.id)) { hit.add(s.id); list.push({ sid: s.id, d: s.food || 0 }); }
  }
  pts.push([px, py]);
  return { pts, list };
}

function trackThreads(pts, tone, n = 10) {
  const out = [];
  const step = Math.max(1, Math.floor((pts.length - 1) / n));
  for (let k = 0; k + step < pts.length; k += step) out.push({ x0: pts[k][0], y0: pts[k][1], x1: pts[k + step][0], y1: pts[k + step][1], tone });
  return out.slice(0, 14);
}

export function locustsPreview(world, x, y, opts = {}) {
  if (world.f.water[y * world.W + x] !== WATER.LAND) return { ok: false, reason: 'The swarm must rise from land.' };
  if ((world.sys.disasters?.swarms || []).length >= 8) return { ok: false, reason: 'The skies are already thick with locusts.' };
  const size = clampR(fin(opts.strength, 0.7), 0.15, 1);
  const fc = swarmForecast(world, x, y, size);
  return {
    ok: true, tone: 'bane', severity: fc.list.length >= 4 ? 3 : 2,
    text: fc.list.length ? `The swarm would ride the wind over ${townList(world, fc.list, 3)}, devouring their granaries` : 'The swarm would ride the wind over empty country',
    targets: tgt(fc.list.map((q) => q.sid)), threads: trackThreads(fc.pts, 'bane'), rings: [{ x: x + 0.5, y: y + 0.5, r: swarmRadius(size), tone: 'bane' }],
    estimate: { towns: fc.list.length },
  };
}

// ---------------------------------------------------------------------------
// Storms

/** The storm the Storm tool would raise at tile i. */
export function stormKindAt(world, i) {
  const f = world.f, b = f.biome[i];
  if (f.water[i] !== WATER.LAND) return f.temp[i] < 0 ? 'blizzard' : 'cyclone';
  if (b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT) return 'sandstorm';
  if (f.temp[i] < 2) return 'blizzard';
  return 'thunderstorm';
}

/** Towns under a forecast track (within its radius), with the day the storm reaches each. */
export function forecastTowns(world, track, kind) {
  const seen = new Map();
  for (const p of track) {
    for (const s of settlementsNear(world, p.x, p.y, p.r + (kind === 'cyclone' ? 0.5 : 0))) {
      if (seen.has(s.id)) continue;
      const i = Math.floor(p.y) * world.W + Math.floor(p.x);
      if (kind === 'cyclone' && world.f.water[i] !== WATER.LAND && !s.coastal) continue;
      seen.set(s.id, { sid: s.id, day: p.day, d: s.population });
    }
  }
  return [...seen.values()].sort((a, b) => a.day - b.day || b.d - a.d);
}

/** Rings along a forecast: the storm's reach, widening with the forecast's doubt. */
function coneRings(track, tone, n = 6) {
  const out = [];
  const step = Math.max(1, Math.floor(track.length / n));
  for (let k = step; k < track.length; k += step) out.push({ x: track[k].x, y: track[k].y, r: track[k].r + 0.5 * Math.sqrt(track[k].day), tone });
  return out.slice(0, 8);
}

function landfall(world, track) {
  for (let k = 1; k < track.length; k++) {
    const p = track[k], q = track[k - 1];
    const a = world.f.water[Math.floor(q.y) * world.W + Math.floor(q.x)] === WATER.LAND, b = world.f.water[Math.floor(p.y) * world.W + Math.floor(p.x)] === WATER.LAND;
    if (b && !a) return p;
  }
  return null;
}

function stormForecastPreview(world, st, days, word, extra = '') {
  const track = forecastTrack(world, st, days, st.push || null);
  const towns = forecastTowns(world, track.slice(1), st.kind);
  const lf = st.kind === 'cyclone' ? landfall(world, track) : null;
  const where = lf ? placePhrase(world, Math.floor(lf.x), Math.floor(lf.y), { settleDist: 8 }).text : null;
  const bits = [word];
  if (lf) bits.push(`landfall ${where} in about ${plural(Math.max(1, lf.day), 'day')}`);
  if (towns.length) bits.push(`${townList(world, towns)} in its path`);
  else bits.push('no town in its path');
  return {
    ok: true, tone: 'bane', severity: st.kind === 'cyclone' ? (st.intensity >= 0.7 ? 4 : 3) : 2,
    text: bits.join(' · ') + extra,
    targets: tgt(towns.map((q) => q.sid)),
    threads: trackThreads(track.map((p) => [p.x, p.y]), 'bane', 8),
    rings: [{ x: st.x, y: st.y, r: st.radius, tone: 'bane' }, ...coneRings(track, 'danger')],
    estimate: { towns: towns.length },
  };
}

/** A storm as the tool would raise it, for its forecast (never added to the world). */
function provisionalStorm(world, kind, x, y, s) {
  const lat = latitude(world, y);
  const hemi = lat >= 0 ? 1 : -1;
  const I = kind === 'cyclone' ? 0.35 + 0.65 * s : 0.3 + 0.7 * s;
  const st = {
    kind, x: x + 0.5, y: y + 0.5, vx: kind === 'cyclone' ? -2 : 0, vy: kind === 'cyclone' ? -0.6 * hemi : 0, intensity: I, age: 0, hemisphere: hemi,
    maxAge: kind === 'cyclone' ? 17.5 + 6 : kind === 'blizzard' ? 5 : kind === 'thunderstorm' ? 2 + 2 : 3.5,
  };
  st.radius = stormRadius(st);
  return st;
}

const STORM_WORD = { cyclone: 'A cyclone would gather', blizzard: 'A blizzard would rise', sandstorm: 'A sandstorm would boil up', thunderstorm: 'A thunderstorm would break' };

export function stormPreview(world, x, y, opts = {}) {
  const kind = stormKindAt(world, y * world.W + x);
  const s = clampR(fin(opts.strength, 0.75), 0.05, 1);
  const st = provisionalStorm(world, kind, x, y, s);
  if (kind === 'thunderstorm') {
    const dry = 1 - cl01((world.f.soilWater[y * world.W + x] - 0.12) / 0.3);
    return { ok: true, tone: 'bane', severity: 1, text: `${STORM_WORD[kind]}${dry > 0.5 ? '; its lightning could kindle the dry country' : ''}`, rings: [{ x: x + 0.5, y: y + 0.5, r: st.radius + 1, tone: 'bane' }] };
  }
  return stormForecastPreview(world, st, kind === 'cyclone' ? 24 : 8, STORM_WORD[kind]);
}

export function blizzardPreview(world, x, y, opts = {}) {
  const st = provisionalStorm(world, 'blizzard', x, y, clampR(fin(opts.strength, 0.8), 0.05, 1));
  return stormForecastPreview(world, st, 8, 'A blizzard would drift on the wind');
}

/** The push steer_storm gives a storm toward (tx, ty): { vx, vy, days }. */
export function steerPush(st, tx, ty) {
  const dx = tx - st.x, dy = ty - st.y, d = Math.hypot(dx, dy);
  if (!(d > 0.5)) return null;
  const sp = st.kind === 'cyclone' ? 2.6 : st.kind === 'sandstorm' ? 2.4 : 2;
  return { vx: Math.round((dx / d) * sp * 100) / 100, vy: Math.round((dy / d) * sp * 100) / 100, days: Math.min(24, Math.max(6, Math.round(d / sp) + 4)) };
}

export function steerPreview(world, x, y, opts = {}) {
  const t = opts.target;
  const st = t && t.kind === 'storm' ? world.storms.find((q) => q.id === t.id) : null;
  if (!st) return { ok: false, reason: 'That storm has blown itself out.' };
  const to = Number.isFinite(opts.x) ? { x: opts.x, y: opts.y } : Number.isFinite(x) ? { x, y } : null;
  const push = to ? steerPush(st, to.x, to.y) : null;
  if (!push) return { ok: true, text: `Drag ${st.kind === 'cyclone' ? st.name : 'the storm'} where it should go`, targets: [{ kind: 'storm', id: st.id }] };
  const pv = stormForecastPreview(world, { ...st, push }, 36, `${st.kind === 'cyclone' ? st.name : 'The storm'} would turn`);
  pv.targets = [{ kind: 'storm', id: st.id }, ...pv.targets];
  return pv;
}

// ---------------------------------------------------------------------------
// Sky

export function rainPreview(world, x, y, opts = {}) {
  const R = Math.max(1, fin(opts.radius, 8));
  let fires = 0;
  forDisc(world, x, y, R, (i, tx, ty, d) => { if (world.f.fire[i] > 0 && 1 - d * d > 0.15) fires++; });
  const towns = settlementsNear(world, x, y, R);
  return {
    ok: true, tone: 'boon', severity: 1,
    text: `Rain over ${towns.length ? plural(towns.length, 'town') : regionName(world, x, y)}${fires ? `; ${plural(fires, 'burning tile')} quenched` : ''}; the land stays wetter for months`,
    targets: tgt(towns.map((s) => s.id)), rings: [{ x, y, r: R, tone: 'boon' }],
  };
}

export function droughtPreview(world, x, y, opts = {}) {
  const R = Math.max(1, fin(opts.radius, 10));
  const towns = settlementsNear(world, x, y, R).sort((a, b) => b.population - a.population);
  let farm = 0;
  forDisc(world, x, y, R, (i) => { if (world.f.farm[i] > 0.2) farm++; });
  const overSea = world.f.water[y * world.W + x] !== WATER.LAND;
  return {
    ok: true, tone: 'bane', severity: towns.length >= 3 ? 3 : 2,
    text: `Would parch ${overSea ? `the skies over ${regionName(world, x, y)}` : regionName(world, x, y)}${towns.length ? ` and the fields of ${listJoin(towns.slice(0, 2).map((s) => s.name))}${towns.length > 2 ? ` and ${numberWord(towns.length - 2)} more` : ''}` : ''}${farm ? `; ${fmtRough(farm * KM_PER_TILE * KM_PER_TILE)} km² of farmland would wither` : ''}`,
    targets: tgt(towns.map((s) => s.id)), rings: [{ x, y, r: R, tone: 'bane' }], estimate: { towns: towns.length },
  };
}

export function lightningPreview(world, x, y) {
  const f = world.f, i = y * world.W + x;
  if (f.water[i] !== WATER.LAND) return { ok: true, tone: 'neutral', severity: 0, text: 'The bolt would hiss into the water' };
  if (f.veg[i] < 0.08) return { ok: true, tone: 'neutral', severity: 0, text: 'The bolt would scorch bare ground' };
  const dry = 1 - cl01((f.soilWater[i] - 0.1) / 0.35);
  const near = settlementsNear(world, x, y, 4);
  return {
    ok: true, tone: 'bane', severity: dry > 0.6 ? 2 : 1,
    text: `Would set the ${(BIOMES[f.biome[i]]?.name || 'land').toLowerCase()} alight${dry > 0.6 ? '; the country is dry and the fire may run far' : dry < 0.25 ? '; the wet ground should hold it' : ''}${near.length ? ` · ${listJoin(near.slice(0, 2).map((s) => s.name))} nearby` : ''}`,
    targets: tgt(near.map((s) => s.id)), rings: [{ x: x + 0.5, y: y + 0.5, r: 2, tone: 'bane' }],
  };
}
