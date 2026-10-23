// Earthquakes and tsunamis. Quakes strike along plate boundaries with Gutenberg–Richter
// magnitudes (b ≈ 1: ten M5 for every M6), damage settlements within a magnitude-scaled
// radius, scar the land, nudge the crust up or down along the fault and wake nearby
// volcanoes. Undersea quakes of M7.5+ near coasts — and ocean meteor impacts — raise
// tsunamis that race across connected ocean and break on the shores they reach. Natural
// quakes are scaled by the ext 'rates' key 'quake'.
//
// Hooks emitted: quake { x, y, mag, deaths, towns, undersea }, tsunami { x, y, height, deaths,
// towns } (towns: the sids struck, at most 8). The reach of a quake and of a wave is computed
// by the same pure helpers (quakeStrike, tsunamiReach, tsunamiStrikes) that the tool previews use.

import { WATER, DAYS_PER_YEAR } from '../../core/constants.js';
import { emitFx, bumpVersion } from '../../core/world.js';
import { settlementsNear, damageSettlement } from '../../core/entities.js';
import { chronicle } from '../../core/chronicle.js';
import { DX8, DY8 } from '../../core/util.js';
import { fin, clampR, cl01, rateOk, pick, listJoin, deathsClause, yearNum, forDisc, emitHook, rateMul } from './common.js';
import { regionOf } from './grid.js';
import { placePhrase, regionName } from './places.js';

/** Cumulative distribution of quake likelihood over tiles (∝ plateBoundary²). */
function quakeCdf(world) {
  const key = world.versions.terrain;
  let c = world.cache.natQuakeCdf;
  if (c && c.key === key && c.N === world.N) return c;
  const { N, f } = world;
  const pbF = f.plateBoundary;
  const idx = [], w = [];
  let tot = 0;
  for (let i = 0; i < N; i++) {
    const pb = fin(pbF[i]);
    if (pb < 0.05) continue;
    tot += pb * pb;
    idx.push(i); w.push(tot);
  }
  c = world.cache.natQuakeCdf = { key, N, idx: Int32Array.from(idx), cum: Float64Array.from(w), tot };
  return c;
}

function pickQuakeTile(world) {
  const c = quakeCdf(world);
  if (!c.idx.length || c.tot <= 0) return Math.floor(world.rng.next() * world.N);
  const u = world.rng.next() * c.tot;
  let lo = 0, hi = c.cum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c.cum[m] < u) lo = m + 1; else hi = m; }
  return c.idx[lo];
}

/** Daily roll for natural quakes. */
export function quakeTick(world, sys) {
  const p = world.params;
  const rate = 3.0 * clampR(fin(p.seismicity, 1), 0, 3) * clampR(fin(p.disasterRate, 1), 0, 3) * rateMul(world, 'quake');
  if (rate <= 0 || !world.rng.chance(rate / DAYS_PER_YEAR)) return;
  const i = pickQuakeTile(world);
  const pb = cl01(fin(world.f.plateBoundary[i], 0.3));
  const mMax = 6.4 + 3.2 * pb;
  let M = 4.5 - Math.log10(Math.max(1e-9, 1 - world.rng.next()));
  if (M > mMax) M = mMax - 0.3 * world.rng.next();
  M = Math.round(M * 10) / 10;
  quake(world, sys, i % world.W, (i / world.W) | 0, M);
}

export const quakeRadius = (M) => 0.9 * Math.pow(1.8, M - 5);
/** Ground shaking 0..1 of a quake of magnitude M. */
export const quakeSeverity = (M) => cl01((M - 4.8) / 3.2);

/**
 * How hard a quake of magnitude M at (x, y) strikes settlement s: the intensity I (0..1, after
 * the solid building of industrial ages) and the share of its people it would kill. Pure.
 */
export function quakeStrike(world, s, x, y, M) {
  const R = quakeRadius(M);
  const d = Math.hypot(s.x - x, s.y - y) / Math.max(0.5, R);
  let I = Math.pow(Math.max(0, 1 - d), 1.3) * quakeSeverity(M);
  const civ = world.civs[s.civId];
  if (civ && fin(civ.tech?.era) >= 6) I *= 0.6;
  return { I, pop: 0.2 * Math.pow(I, 1.5) };
}

/** An earthquake of magnitude M centred on (x, y). Returns { deaths, hit } */
export function quake(world, sys, x, y, M, opts = {}) {
  const { W, f } = world;
  const i0 = y * W + x;
  M = clampR(fin(M, 6), 3, 10);
  sys.counts.quakes = (sys.counts.quakes || 0) + 1;
  if (M >= 6) sys.counts.quakes6 = (sys.counts.quakes6 || 0) + 1;
  if (M >= 7) sys.counts.quakes7 = (sys.counts.quakes7 || 0) + 1;
  if (M >= 8) sys.counts.quakes8 = (sys.counts.quakes8 || 0) + 1;
  sys.century.quakes = (sys.century.quakes || 0) + (M >= 5 ? 1 : 0);
  if (M < 5 && !opts.divine) return { deaths: 0, hit: [] };
  const R = quakeRadius(M);
  const sev = quakeSeverity(M);
  emitFx(world, { type: 'quake', x: x + 0.5, y: y + 0.5, r: R, intensity: sev, ...(opts.divine ? { src: 'tool' } : {}) });
  // Ground damage, landslides on steep slopes.
  forDisc(world, x, y, R, (i, tx, ty, d) => {
    const I = Math.pow(1 - d, 1.3) * sev;
    if (f.water[i] !== WATER.LAND) return;
    f.devastation[i] = Math.min(1, f.devastation[i] + 0.3 * I);
    if (f.elevation[i] > 0.66) f.veg[i] *= 1 - 0.3 * I;
  });
  // Uplift on one side of the fault, subsidence on the other.
  if (M >= 7) {
    const ang = world.rng.next() * Math.PI;
    const nx = Math.cos(ang), ny = Math.sin(ang);
    const amp = 0.004 * (M - 6.5);
    forDisc(world, x, y, R * 0.6, (i, tx, ty, d) => {
      const side = (tx - x) * nx + (ty - y) * ny >= 0 ? 1 : -1;
      f.elevation[i] = clampR(f.elevation[i] + side * amp * (1 - d), 0, 1);
    });
    world.pending.hydro = true;
    bumpVersion(world, 'terrain');
  }
  // Settlements.
  const hit = [];
  let deaths = 0;
  for (const s of settlementsNear(world, x + 0.5, y + 0.5, R)) {
    const { I, pop } = quakeStrike(world, s, x, y, M);
    if (I < 0.04) continue;
    const name = s.name, pop0 = s.population, tier = s.tier;
    const killed = damageSettlement(world, s, { pop, buildings: 0.6 * I, defense: 0.5 * I, wealth: 0.25 * I, food: 0.08 * I, cause: 'earthquake' });
    deaths += killed;
    hit.push({ sid: s.id, name, killed, pop0, tier, I, gone: !s.alive, x: s.x, y: s.y });
  }
  // Wake nearby volcanoes.
  for (const v of world.volcanoes) {
    const dv = Math.hypot(v.x - x, v.y - y);
    if (dv < R * 2.5) v.activity = cl01(fin(v.activity) + 0.08 * sev * (1 - dv / (R * 2.5)));
  }
  sys.counts.quakeDeaths = (sys.counts.quakeDeaths || 0) + deaths;
  const rec = { day: world.time.day, M, x, y, deaths: Math.round(deaths) };
  (sys.recent ||= []).push({ kind: 'quake', ...rec });
  if (sys.recent.length > 40) sys.recent.shift();
  // Tsunami from an undersea rupture near land.
  let wave = null;
  const undersea = f.water[i0] === WATER.OCEAN;
  if (undersea && M >= 7.5 && landWithin(world, x, y, 8)) wave = tsunami(world, sys, x, y, { range: 25 * (M - 7), height: cl01((M - 7) / 2.2 + 0.3), source: `the M${M.toFixed(1)} quake`, quiet: true });
  const entry = quakeChronicle(world, sys, x, y, M, deaths, hit, wave, opts);
  emitHook(world, 'quake', { x, y, mag: M, deaths: Math.round(deaths + (wave ? wave.deaths : 0)), towns: hit.slice().sort((a, b) => b.killed - a.killed || b.I - a.I).slice(0, 8).map((h) => h.sid), undersea, divine: Boolean(opts.divine), seq: entry ? entry.seq : null });
  return { deaths, hit, wave };
}

/** True when there is land within r tiles of (x, y) (an undersea quake there can raise a wave). */
export function landWithin(world, x, y, r) {
  let found = false;
  forDisc(world, x, y, r, (i) => { if (!found && world.f.water[i] === WATER.LAND) found = true; });
  return found;
}

function quakeChronicle(world, sys, x, y, M, deaths, hit, wave, opts) {
  const day = world.time.day, yr = yearNum(world);
  const Ms = `M${M.toFixed(1)}`;
  const worst = hit.slice().sort((a, b) => b.killed - a.killed || b.I - a.I);
  const gone = hit.filter((h) => h.gone).map((h) => h.name);
  const badly = worst.filter((h) => h.I > 0.35).map((h) => h.name);
  const wd = wave ? wave.deaths : 0;
  const total = deaths + wd;
  let imp = 0;
  if (M >= 8 || total >= 5000 || gone.length) imp = 4;
  else if (M >= 7 || total >= 500) imp = 3;
  else if (total >= 20 || hit.some((h) => h.tier >= 3 && h.I > 0.25)) imp = 2;
  else if (M >= 6 && hit.length) imp = 1;
  else if (M >= 7) imp = 1;
  if (opts.divine) imp = Math.max(imp, 2);
  if (!imp) return null;
  if (imp === 1 && !rateOk(sys, `q1:${regionOf(world, x, y)}`, day, 10)) return null;
  const great = M >= 8 || total >= 5000;
  const name = great ? `The Great Quake of Year ${yr} (${Ms})` : worst[0] && worst[0].killed > 0 ? `The ${worst[0].name} earthquake (${Ms})` : `An earthquake of ${Ms}`;
  const lead = opts.divine ? `${name}, loosed by an unseen hand,` : name;
  const dc = deathsClause(deaths);
  const tw = wave && wave.hit.length ? `; the wave that followed struck ${listJoin(wave.hit.slice(0, 3))}${wd ? `, drowning ${Math.round(wd) > 60 ? 'some ' : ''}${fmtN(wd)} more` : ''}` : wave ? '; a great wave raced out across the sea' : '';
  let text;
  if (gone.length) text = `${lead} levelled ${listJoin(gone.slice(0, 3))}${badly.filter((n) => !gone.includes(n)).length ? ` and shattered ${listJoin(badly.filter((n) => !gone.includes(n)).slice(0, 2))}` : ''}${dc ? ', ' + dc : ''}${tw}.`;
  else if (badly.length) text = pick(world, [
    `${lead} levelled ${listJoin(badly.slice(0, 3))}${dc ? ', ' + dc : ''}${tw}.`,
    `${lead} shook ${listJoin(badly.slice(0, 3))} to rubble${dc ? ', ' + dc : ''}${tw}.`,
  ]);
  else if (hit.length) text = `${lead} rattled ${listJoin(worst.slice(0, 3).map((h) => h.name))}${dc ? ', ' + dc : ''}${tw}.`;
  else {
    const pl = placePhrase(world, x, y, { settleDist: 0, useSettlement: false });
    const sea = world.f.water[y * world.W + x] !== WATER.LAND;
    const where = sea && /^on /.test(pl.text) ? 'beneath ' + pl.text.slice(3) : pl.text;
    text = sea
      ? pick(world, [`${lead} shook the sea floor ${where}${tw || ', far from any shore that anyone called home'}.`, `${lead} split the seabed ${where}${tw}.`])
      : pick(world, [`${lead} tore the earth ${where}, where no one lived to fall${tw}.`, `${lead} split the empty land ${where}${tw}.`]);
  }
  return chronicle(world, {
    cat: opts.divine ? 'divine' : 'disaster', imp, text, x, y, sid: worst[0]?.sid ?? null, key: opts.divine ? 'divine.quake' : great ? 'quake.great' : 'quake',
    ...(worst[0] ? { ref: { k: 'settlement', id: worst[0].sid } } : {}), tags: [Ms],
  });
}

const fmtN = (n) => { n = Math.round(n); return n >= 1000 ? String(Math.round(n / 100) * 100).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(n); };

// ---------------------------------------------------------------------------
// Tsunami

function bfsScratch(world) {
  let c = world.cache.natBfs;
  if (c && c.N === world.N) return c;
  c = world.cache.natBfs = { N: world.N, q: new Int32Array(world.N), dist: new Int16Array(world.N).fill(-1), touched: new Int32Array(world.N) };
  return c;
}

/**
 * The reach of a wave from (x0, y0): it floods across connected ocean from the nearest ocean
 * tile (land shadows it). Returns { start, coastHit: Map(land tile → wave height) } or null when
 * no ocean lies within 10 tiles. Pure (scratch buffers live in world.cache).
 */
export function tsunamiReach(world, x0, y0, range, h0) {
  const { W, H, f } = world;
  let start = y0 * W + x0;
  if (f.water[start] !== WATER.OCEAN) {
    let best = -1, bd = 1e9;
    forDisc(world, x0, y0, 10, (i, tx, ty) => { if (f.water[i] === WATER.OCEAN) { const d = (tx - x0) ** 2 + (ty - y0) ** 2; if (d < bd) { bd = d; best = i; } } });
    if (best < 0) return null;
    start = best;
  }
  const sc = bfsScratch(world);
  const { q, dist, touched } = sc;
  let qh = 0, qt = 0, nt = 0;
  q[qt++] = start; dist[start] = 0; touched[nt++] = start;
  const coastHit = new Map(); // land tile → wave height
  while (qh < qt) {
    const i = q[qh++];
    const d = dist[i];
    const x = i % W, y = (i / W) | 0;
    const hh = h0 * Math.pow(Math.max(0, 1 - d / range), 0.8) / Math.sqrt(1 + d / 15);
    for (let k = 0; k < 8; k++) {
      const nx = x + DX8[k], ny = y + DY8[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (f.water[j] === WATER.LAND) {
        if (hh > 0.02 && hh > (coastHit.get(j) || 0)) coastHit.set(j, hh);
        continue;
      }
      if (f.water[j] !== WATER.OCEAN || dist[j] >= 0 || d + 1 > range) continue;
      dist[j] = d + 1; q[qt++] = j; touched[nt++] = j;
    }
  }
  for (let k = 0; k < nt; k++) dist[touched[k]] = -1;
  return { start, coastHit };
}

/** The settlements a wave's coastHit would drown, sid → strength g (0..1). Pure. */
export function tsunamiStrikes(world, coastHit) {
  const { W, f } = world;
  const sea = world.climate.seaLevel;
  const struck = new Map();
  for (const [j, hh] of coastHit) {
    const x = j % W, y = (j / W) | 0;
    forDisc(world, x, y, hh > 0.6 ? 2 : 1, (i, tx, ty, dd) => {
      if (f.water[i] !== WATER.LAND) return;
      const low = 1 - ss01((f.elevation[i] - sea) / 0.03);
      const g = hh * low * (1 - 0.5 * dd);
      if (g <= 0.02) return;
      const sid = f.settle[i];
      if (sid >= 0) struck.set(sid, Math.max(struck.get(sid) || 0, g));
    });
  }
  return struck;
}

/** The share of a struck town's people a wave of strength g would drown. */
export const tsunamiToll = (s, g) => Math.min(0.6, 0.25 * g + (s.harbor ? 0.04 : 0));

/**
 * A tsunami from (x0, y0). opts: { range (tiles), height 0..1, source, divine, quiet }
 * The wave floods across connected ocean (land shadows it) and breaks on the coasts it
 * reaches. Emits tsunami. Returns { deaths, hit: [names], reached, sids }.
 */
export function tsunami(world, sys, x0, y0, opts = {}) {
  const { W, f } = world;
  const range = clampR(fin(opts.range, 20), 4, 140);
  const h0 = clampR(fin(opts.height, 0.6), 0.05, 1.5);
  sys.counts.tsunamis = (sys.counts.tsunamis || 0) + 1;
  sys.century.tsunamis = (sys.century.tsunamis || 0) + 1;
  const reach = tsunamiReach(world, x0, y0, range, h0);
  if (!reach) return { deaths: 0, hit: [], reached: 0, sids: [] };
  const { coastHit } = reach;
  emitFx(world, { type: 'tsunami', x: x0 + 0.5, y: y0 + 0.5, r: range, ...(opts.divine ? { src: 'tool' } : {}) });
  // Inundate low coasts.
  const sea = world.climate.seaLevel;
  const struck = new Map();
  for (const [j, hh] of coastHit) {
    const x = j % W, y = (j / W) | 0;
    forDisc(world, x, y, hh > 0.6 ? 2 : 1, (i, tx, ty, dd) => {
      if (f.water[i] !== WATER.LAND) return;
      const low = 1 - ss01((f.elevation[i] - sea) / 0.03);
      const g = hh * low * (1 - 0.5 * dd);
      if (g <= 0.02) return;
      f.devastation[i] = Math.min(1, f.devastation[i] + 0.45 * g);
      f.veg[i] *= 1 - 0.35 * g;
      f.soil[i] = Math.max(0, f.soil[i] - 0.04 * g);
      const sid = f.settle[i];
      if (sid >= 0) struck.set(sid, Math.max(struck.get(sid) || 0, g));
    });
  }
  let deaths = 0;
  const hit = [], sids = [];
  let worst = null;
  for (const [sid, g] of struck) {
    const s = world.settlements[sid];
    if (!s || !s.alive) continue;
    const name = s.name;
    const killed = damageSettlement(world, s, { pop: tsunamiToll(s, g), buildings: 0.5 * g, food: 0.4 * g, wealth: 0.3 * g, defense: 0.2 * g, cause: 'tsunami' });
    deaths += killed;
    hit.push(name);
    sids.push({ sid, killed });
    if (!worst || killed > worst.killed) worst = { sid, name, killed, x: s.x, y: s.y };
  }
  sys.counts.tsunamiDeaths = (sys.counts.tsunamiDeaths || 0) + deaths;
  const out = { deaths, hit, reached: coastHit.size, sids: sids.map((q) => q.sid) };
  const entry = !opts.quiet ? tsunamiChronicle(world, sys, x0, y0, out, worst, opts) : null;
  emitHook(world, 'tsunami', { x: x0, y: y0, height: Math.round(h0 * 100) / 100, deaths: Math.round(deaths), towns: sids.sort((a, b) => b.killed - a.killed).slice(0, 8).map((q) => q.sid), source: opts.source || null, divine: Boolean(opts.divine), seq: entry ? entry.seq : null });
  return out;
}

const ss01 = (t) => { const u = Math.min(1, Math.max(0, t)); return u * u * (3 - 2 * u); };

function tsunamiChronicle(world, sys, x, y, w, worst, opts) {
  const day = world.time.day;
  const src = opts.source ? ` raised by ${opts.source}` : '';
  let imp = w.deaths >= 10000 ? 4 : w.deaths >= 500 || w.hit.length >= 3 ? 3 : w.hit.length ? 2 : 1;
  if (opts.divine) imp = Math.max(imp, 2);
  if (imp === 1 && !rateOk(sys, `ts1:${regionOf(world, x, y)}`, day, 20)) return null;
  const dc = deathsClause(w.deaths);
  let text;
  if (w.hit.length) text = pick(world, [
    `The sea drew back from the shores of ${w.hit[0]}, then returned as a wall of water${src}, sweeping over ${listJoin(w.hit.slice(0, 4))}${dc ? ' and ' + dc : ''}.`,
    `A great wave${src} broke upon ${listJoin(w.hit.slice(0, 4))}${dc ? ', ' + dc : ''}.`,
  ]);
  else text = pick(world, [
    `A great wave${src} raced across ${regionName(world, x, y)} but broke only upon empty shores.`,
    `The sea heaved${src}, and a great wave crossed ${regionName(world, x, y)} to spend itself on empty beaches.`,
  ]);
  return chronicle(world, { cat: opts.divine ? 'divine' : 'disaster', imp, text, x: worst?.x ?? x, y: worst?.y ?? y, sid: worst?.sid ?? null, key: opts.divine ? 'divine.tsunami' : 'tsunami', ...(worst ? { ref: { k: 'settlement', id: worst.sid } } : {}) });
}
