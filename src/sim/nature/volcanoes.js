// Volcanoes (world.volcanoes, created by the generator). Each mountain's restlessness
// wanders around its own temperament; eruptions draw a VEI 1–7 (long-dormant and
// agitated peaks blow bigger). Lava creeps downhill day by day — building new rock and
// even new shoreline, burning and burying what lies in its path — while ash rains out
// downwind (killing crops now, enriching soil later) and great eruptions throw a veil of
// aerosol into the sky that cools the whole world. Occasionally a new fire-mountain is
// born at a hotspot or along a subduction arc. Eruptions and new volcanoes are scaled by the
// ext 'rates' key 'volcano'.
//
// Hook emitted: eruption { volcanoId, x, y, vei, deaths, towns } (towns: sids struck, ≤ 8).
// The burning clouds and the ash plume are traced by the same pure helpers (pyroclasticRadius,
// forAsh) that the tool's preview uses.

import { WATER, DAYS_PER_YEAR } from '../../core/constants.js';
import { emitFx, bumpVersion } from '../../core/world.js';
import { settlementsNear, damageSettlement, destroySettlement } from '../../core/entities.js';
import { chronicle } from '../../core/chronicle.js';
import { properPlace } from '../../core/names.js';
import { DX8, DY8 } from '../../core/util.js';
import { ignite } from '../ecology.js';
import { fin, clampR, cl01, rateOk, pick, listJoin, deathsClause, yearNum, forDisc, emitHook, rateMul } from './common.js';
import { regionName } from './places.js';
import { recomputeWaterSafe, classifyBiomesSafe } from './external.js';

const AEROSOL = [0, 0, 0, 0.003, 0.012, 0.06, 0.22, 0.55];
const LAVA = [0, 3, 6, 9, 6, 5, 4, 3];
const VEI_FORCE = ['', 'a gentle outpouring of lava', 'a modest burst of ash and fire', 'violent explosions', 'cataclysmic force', 'paroxysmal fury', 'colossal violence', 'world-shaking fury'];

/** Normalise generator-made volcano records (idempotent). */
export function normaliseVolcanoes(world) {
  const { W, H } = world;
  for (let k = 0; k < world.volcanoes.length; k++) {
    const v = world.volcanoes[k];
    if (!v) continue;
    v.id ??= k;
    if (!Number.isFinite(v.i)) v.i = clampR(Math.round(fin(v.y)), 0, H - 1) * W + clampR(Math.round(fin(v.x)), 0, W - 1);
    v.x = v.i % W; v.y = (v.i / W) | 0;
    v.activity = cl01(fin(v.activity, 0.25));
    v.erupting = Math.max(0, fin(v.erupting, 0));
    if (v.lastEruption !== null && !Number.isFinite(v.lastEruption)) v.lastEruption = null;
    v.dormantSince = fin(v.dormantSince, 0);
    if (!Number.isFinite(v.temper)) v.temper = clampR(0.2 + 0.45 * hashUnit(world, k), 0.15, 0.7);
    v.eruptions = fin(v.eruptions, 0);
    v.name ||= 'Mount ' + properPlace(world.lang, world.rng);
  }
}

function hashUnit(world, k) {
  // Deterministic per-volcano temperament (no RNG draw so load/init stays idempotent).
  let h = 2166136261 ^ k;
  const s = String(world.seed);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Monthly: restlessness and eruption chances. */
export function volcanoMonth(world, sys) {
  const p = world.params;
  const vol = clampR(fin(p.volcanism, 1), 0, 3);
  const dr = clampR(fin(p.disasterRate, 1), 0, 3) * rateMul(world, 'volcano');
  const rng = world.rng;
  for (const v of world.volcanoes) {
    if (!v) continue;
    v.activity = cl01(v.activity + 0.03 * (v.temper * Math.min(1.5, 0.5 + vol * 0.5) - v.activity) + 0.035 * rng.normal(0, 1));
    if (v.erupting > 0 || vol <= 0 || dr <= 0) continue;
    const pr = 0.0006 * Math.pow(v.activity / 0.5, 3) * vol * dr;
    if (rng.chance(pr)) erupt(world, sys, v, null);
  }
  // A new fire-mountain, rarely.
  if (rng.chance(0.003 / 12 * vol * dr)) newVolcano(world, sys, null, null, {});
}

/** Draw a VEI: long dormancy and high agitation push toward the big ones. */
function drawVEI(world, v) {
  const yrs = v.lastEruption == null ? 400 : (world.time.day - v.lastEruption) / DAYS_PER_YEAR;
  const boost = (yrs > 300 ? 0.6 : yrs > 100 ? 0.3 : 0) + (v.activity > 0.8 ? 0.4 : 0);
  const u = Math.max(1e-9, world.rng.next());
  const vei = 1 + Math.floor(-Math.log(u) / Math.log(2.4) + boost);
  return clampR(vei, 1, 7);
}

/** Radius (tiles) of the burning clouds of an eruption of this VEI (0 below VEI 4). */
export const pyroclasticRadius = (vei) => (vei >= 4 ? 1 + 0.7 * (vei - 3) : 0);

/**
 * Visit the land tiles an eruption's ash would fall on: fn(i, thickness 0..1). The plume runs
 * downwind (a short tail upwind) and thins with distance. Pure; the callback may mutate.
 */
export function forAsh(world, v, vei, fn) {
  const { W, H, f } = world;
  const L = 1.6 * Math.pow(vei, 1.6);
  const wx = fin(f.windX[v.i]), wy = fin(f.windY[v.i]);
  const wl = Math.hypot(wx, wy);
  const ux = wl > 0.05 ? wx / wl : 1, uy = wl > 0.05 ? wy / wl : 0;
  const thick0 = vei / 7;
  const x0 = Math.max(0, Math.floor(v.x - L)), x1 = Math.min(W - 1, Math.ceil(v.x + L));
  const y0 = Math.max(0, Math.floor(v.y - L)), y1 = Math.min(H - 1, Math.ceil(v.y + L));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x - v.x, dy = y - v.y;
    const along = dx * ux + dy * uy, across = -dx * uy + dy * ux;
    const a = along >= 0 ? along / L : -along / (L * 0.25);
    const b = across / (L * 0.32 * (0.4 + 0.6 * Math.min(1, Math.max(0, along) / L + 0.3)));
    const e = a * a + b * b;
    if (e > 1) continue;
    const th = thick0 * (1 - Math.sqrt(e)) * (1 - 0.5 * Math.max(0, along) / L);
    if (th <= 0.01) continue;
    const i = y * W + x;
    if (f.water[i] !== WATER.LAND) continue;
    fn(i, th);
  }
  return { L, ux, uy };
}

/** The volcano a tool at (x, y) would wake (within 12 tiles), or null. */
export function nearestVolcano(world, x, y, maxD = 12) {
  let best = null, bd = maxD * maxD;
  for (const v of world.volcanoes) {
    if (!v) continue;
    const d = (v.x - x) ** 2 + (v.y - y) ** 2;
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

/** Erupt volcano v (VEI drawn if null). Emits eruption. */
export function erupt(world, sys, v, veiIn, opts = {}) {
  const { W, H, f } = world;
  const vei = veiIn ? clampR(Math.round(veiIn), 1, 7) : drawVEI(world, v);
  const day = world.time.day;
  const yrs = v.lastEruption == null ? null : Math.round((day - v.lastEruption) / DAYS_PER_YEAR);
  v.erupting = vei <= 2 ? world.rng.int(12, 40) : vei <= 4 ? world.rng.int(6, 22) : world.rng.int(4, 12);
  v.lastEruption = day;
  v.lastVEI = vei;
  v.eruptions = (v.eruptions || 0) + 1;
  v.activity = cl01(v.activity * 0.35);
  sys.counts.eruptions = (sys.counts.eruptions || 0) + 1;
  if (vei >= 4) sys.counts.eruptions4 = (sys.counts.eruptions4 || 0) + 1;
  if (vei >= 6) sys.counts.eruptions6 = (sys.counts.eruptions6 || 0) + 1;
  sys.century.eruptions = (sys.century.eruptions || 0) + 1;
  // Sky veil
  const c = world.climate;
  if (AEROSOL[vei] > 0) {
    c.aerosol = cl01(fin(c.aerosol) + AEROSOL[vei]);
    if (vei >= 5 || !c.aerosolSource || c.aerosol < 0.05) c.aerosolSource = { name: `the eruption of ${v.name}`, day };
  }
  if (vei >= 5) c.co2 = fin(c.co2, 280) + (vei - 4) * 1.2;
  // The cone grows.
  if (f.water[v.i] === WATER.LAND) {
    f.elevation[v.i] = Math.min(1, f.elevation[v.i] + 0.0015 * vei);
    // every elevation edit bumps the terrain version, so caches derived from elevation
    // (weather relief, travel costs) rebuild now, exactly as they would after a reload
    bumpVersion(world, 'terrain');
  }
  emitFx(world, { type: 'eruption', x: v.x + 0.5, y: v.y + 0.5, r: 1 + vei * 1.2, intensity: vei / 7, ...(opts.divine ? { src: 'tool' } : {}) });
  let deaths = 0;
  const hit = new Map(); // sid → { name, killed, gone }
  const note = (s, killed, gone, name) => { const h = hit.get(s) || { name, killed: 0, gone: false }; h.killed += killed; h.gone ||= gone; hit.set(s, h); };
  // Pyroclastic flows
  if (vei >= 4) {
    const r = pyroclasticRadius(vei);
    forDisc(world, v.x, v.y, r, (i, x, y, d) => {
      if (f.water[i] !== WATER.LAND) return;
      f.veg[i] *= d * 0.5; f.herb[i] = 0; f.pred[i] = 0;
      f.devastation[i] = Math.min(1, f.devastation[i] + 0.8 * (1 - d));
      f.burnScar[i] = 1;
      if (d > 0.6) ignite(world, i, 0.7, { cause: 'lava' });
    });
    for (const s of settlementsNear(world, v.x, v.y, r)) {
      const d = Math.hypot(s.x - v.x, s.y - v.y) / r;
      const name = s.name;
      const k = damageSettlement(world, s, { pop: clampR(0.75 * (1 - d) + 0.1, 0, 0.95), buildings: 0.8, food: 0.8, wealth: 0.5, defense: 0.6, cause: 'eruption' });
      deaths += k; note(s.id, k, !s.alive, name);
    }
  }
  // Ash fall downwind
  const ash = f.ash;
  const ashTowns = new Map();
  forAsh(world, v, vei, (i, th) => {
    if (ash) ash[i] = Math.min(1, ash[i] + th);
    f.veg[i] *= 1 - 0.55 * th;
    f.devastation[i] = Math.min(1, f.devastation[i] + 0.25 * th);
    if (f.soilBase) f.soilBase[i] = Math.min(1, f.soilBase[i] + 0.04 * th);
    const sid = f.settle[i];
    if (sid >= 0) ashTowns.set(sid, Math.max(ashTowns.get(sid) || 0, th));
  });
  for (const [sid, th] of ashTowns) {
    const s = world.settlements[sid];
    if (!s || !s.alive) continue;
    const name = s.name;
    const k = damageSettlement(world, s, { pop: vei >= 4 ? 0.03 * th : 0.004 * th, food: 0.5 * th, wealth: 0.15 * th, buildings: vei >= 4 ? 0.2 * th : 0, cause: 'eruption' });
    deaths += k; note(sid, k, !s.alive, name);
  }
  // Lava fronts, advanced day by day while the mountain erupts.
  const budget = Math.round(LAVA[vei] * world.rng.float(0.6, 1.4));
  if (budget > 0) {
    (sys.lava ||= []).push({ v: v.id, fronts: [v.i], left: budget, branches: vei <= 3 ? 3 : 2 });
  }
  sys.counts.eruptionDeaths = (sys.counts.eruptionDeaths || 0) + deaths;
  (sys.recent ||= []).push({ kind: 'eruption', day, vei, x: v.x, y: v.y, deaths: Math.round(deaths), name: v.name });
  if (sys.recent.length > 40) sys.recent.shift();
  const entry = eruptionChronicle(world, sys, v, vei, deaths, hit, yrs, opts);
  const towns = [...hit.entries()].sort((a, b) => b[1].killed - a[1].killed).slice(0, 8).map(([sid]) => sid);
  emitHook(world, 'eruption', { volcanoId: v.id, x: v.x, y: v.y, vei, deaths: Math.round(deaths), towns, name: v.name, divine: Boolean(opts.divine), seq: entry ? entry.seq : null });
  return { vei, deaths, towns };
}

function eruptionChronicle(world, sys, v, vei, deaths, hit, yrs, opts) {
  if (opts.quiet) return null;
  const near = settlementsNear(world, v.x, v.y, 10);
  const towns = [...hit.values()].sort((a, b) => b.killed - a.killed);
  const gone = towns.filter((t) => t.gone).map((t) => t.name);
  let imp = vei >= 7 ? 5 : vei >= 6 ? 4 : vei >= 5 ? 3 : vei >= 4 ? (deaths > 100 || gone.length ? 3 : 2) : vei >= 3 ? (near.length || towns.length ? 2 : 1) : towns.length || near.length ? 1 : 0;
  if (opts.divine) imp = Math.max(imp, 2);
  if (!imp) return null;
  if (imp === 1 && !rateOk(sys, `erupt1:${v.id}`, world.time.day, 15)) return null;
  const yr = yearNum(world);
  const wake = yrs == null ? 'awoke for the first time in memory' : yrs > 150 ? `awoke after ${yrs} years of silence` : 'erupted';
  const lead = opts.divine ? `, at a god's command, ${v.name} ${yrs == null || yrs > 150 ? 'awoke' : 'erupted'}` : ` ${v.name} ${wake}`;
  const dc = deathsClause(deaths);
  const ashed = towns.filter((t) => !t.gone).map((t) => t.name);
  let tail = '';
  if (gone.length) tail = `; burning clouds swallowed ${listJoin(gone.slice(0, 3))}`;
  else if (ashed.length) tail = `; ash buried the fields of ${listJoin(ashed.slice(0, 3))}`;
  if (dc) tail += `, ${dc}`;
  let sky = '';
  if (vei >= 6) sky = ', and a pall of ash spread around the world, dimming the sun for years';
  else if (vei === 5) sky = ', and red sunsets burned across the sky for many months';
  const head = lead.replace(/^,?\s+/, '');
  const text = pick(world, [
    `In Year ${yr}${lead} with ${VEI_FORCE[vei]} (VEI ${vei})${tail}${sky}.`,
    `${head[0].toUpperCase()}${head.slice(1)} in Year ${yr} with ${VEI_FORCE[vei]} (VEI ${vei})${tail}${sky}.`,
  ]);
  return chronicle(world, { cat: opts.divine ? 'divine' : 'disaster', imp, text, x: v.x, y: v.y, key: opts.divine ? 'divine.volcano' : 'eruption', ref: { k: 'volcano', id: v.id }, tags: [`VEI ${vei}`] });
}

/** Daily: count down eruptions, advance lava, emit fx. */
export function volcanoDay(world, sys) {
  for (const v of world.volcanoes) {
    if (!v || !(v.erupting > 0)) continue;
    v.erupting--;
    if (v.erupting % 4 === 0) emitFx(world, { type: 'eruption', x: v.x + 0.5, y: v.y + 0.5, r: 1.5 + (v.lastVEI || 2) * 0.8, intensity: Math.min(1, (v.lastVEI || 2) / 7) * 0.7 });
    if (v.erupting <= 0) { v.erupting = 0; v.dormantSince = world.time.day; }
  }
  if (sys.lava && sys.lava.length) advanceLava(world, sys);
}

function advanceLava(world, sys) {
  const { W, H, f } = world;
  const sea = world.climate.seaLevel;
  let hydro = false, laid = false;
  for (let k = sys.lava.length - 1; k >= 0; k--) {
    const flow = sys.lava[k];
    const v = world.volcanoes.find((o) => o && o.id === flow.v);
    if (!v || flow.left <= 0 || !flow.fronts.length) { sys.lava.splice(k, 1); continue; }
    const next = [];
    for (const i of flow.fronts) {
      const x = i % W, y = (i / W) | 0;
      // Steepest descent among neighbours (lava pools and spreads on flats).
      let best = -1, be = f.elevation[i] + 0.0005, alt = -1;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (f.elevation[j] < be) { alt = best; be = f.elevation[j]; best = j; }
      }
      if (best < 0) best = (y + (world.rng.int(-1, 1))) * W + clampR(x + world.rng.int(-1, 1), 0, W - 1);
      if (best < 0 || best >= world.N) continue;
      lavaTile(world, sys, v, best, sea) && (hydro = true);
      laid = true;
      if (f.water[best] === WATER.LAND) next.push(best);
      if (alt >= 0 && next.length < flow.branches && world.rng.chance(0.25)) { lavaTile(world, sys, v, alt, sea) && (hydro = true); if (f.water[alt] === WATER.LAND) next.push(alt); }
      flow.left--;
      if (flow.left <= 0) break;
    }
    flow.fronts = next.slice(0, flow.branches);
  }
  if (hydro) world.pending.hydro = true;
  // lava raised the ground (a few days per flow, so this is cheap)
  if (hydro || laid) bumpVersion(world, 'terrain');
}

/** Lava covers tile i. Returns true if the water mask may need recomputing. */
function lavaTile(world, sys, v, i, sea) {
  const f = world.f;
  const wasWater = f.water[i] !== WATER.LAND;
  f.elevation[i] = Math.min(1, f.elevation[i] + (wasWater ? 0.007 : 0.003));
  f.veg[i] = 0; f.herb[i] = 0; f.pred[i] = 0;
  // lava hissing into the sea leaves no scorched ground (only new rock below the waves)
  if (!wasWater) { f.devastation[i] = 1; f.burnScar[i] = 1; }
  f.soil[i] = Math.min(f.soil[i], 0.05);
  if (f.soilBase) f.soilBase[i] = Math.max(f.soilBase[i], 0.55);
  if (f.fire[i] > 0) f.fire[i] = 0;
  // Kindle the neighbours.
  const W = world.W, x = i % W, y = (i / W) | 0;
  for (let d = 0; d < 8; d += 2) {
    const nx = x + DX8[d], ny = y + DY8[d];
    if (nx < 0 || ny < 0 || nx >= W || ny >= world.H) continue;
    const j = ny * W + nx;
    if (f.veg[j] > 0.15 && world.rng.chance(0.4)) ignite(world, j, 0.7, { cause: 'lava' });
  }
  const sid = f.settle[i];
  if (sid >= 0) {
    const s = world.settlements[sid];
    if (s && s.alive) {
      const name = s.name, pop = Math.round(s.population);
      destroySettlement(world, sid, 'lava');
      sys.counts.lavaTowns = (sys.counts.lavaTowns || 0) + 1;
      chronicle(world, { cat: 'disaster', imp: pop >= 2000 ? 3 : 2, x: s.x, y: s.y, sid, key: 'eruption.lava', ref: { k: 'volcano', id: v.id }, text: pick(world, [
        `Lava from ${v.name} crept into ${name} and swallowed it street by street; its ${pop >= 1000 ? 'people' : 'few folk'} fled with what they could carry.`,
        `A river of fire from ${v.name} buried ${name} beneath black stone.`,
      ]) });
    }
  }
  return wasWater && f.elevation[i] >= world.climate.seaLevel;
}

/**
 * Raise a new volcano. At (x, y) if given (tool), else at a convergent arc or hotspot.
 */
export function newVolcano(world, sys, x, y, opts) {
  opts = opts || {};
  const { W, H, f } = world;
  const rng = world.rng;
  let i = -1;
  if (x != null && y != null) i = y * W + x;
  else {
    for (let k = 0; k < 60 && i < 0; k++) {
      const cand = Math.floor(rng.next() * world.N);
      const arc = rng.chance(0.6);
      if (arc && fin(f.plateBoundary[cand]) < 0.6) continue;
      const cx = cand % W, cy = (cand / W) | 0;
      if (cx < 3 || cy < 3 || cx > W - 4 || cy > H - 4) continue;
      if (world.volcanoes.some((v) => v && Math.hypot(v.x - cx, v.y - cy) < 8)) continue;
      i = cand;
    }
  }
  if (i < 0) return null;
  const vx = i % W, vy = (i / W) | 0;
  const sea = world.climate.seaLevel;
  const wasWater = f.water[i] !== WATER.LAND;
  const shallow = f.elevation[i] > sea - 0.07;
  forDisc(world, vx, vy, 2.5, (j, tx, ty, d) => {
    const lift = 0.035 * (1 - d) * (1 - d);
    f.elevation[j] = Math.min(1, f.elevation[j] + lift);
  });
  if (wasWater && shallow) f.elevation[i] = Math.max(f.elevation[i], sea + 0.03);
  const name = 'Mount ' + properPlace(world.lang, rng);
  const v = { id: world.volcanoes.length, i, x: vx, y: vy, name, activity: 0.7, erupting: 0, lastEruption: null, dormantSince: world.time.day, temper: rng.float(0.35, 0.7), eruptions: 0, born: world.time.day };
  world.volcanoes.push(v);
  bumpVersion(world, 'terrain');
  if (wasWater && shallow) {
    if (recomputeWaterSafe(world)) classifyBiomesSafe(world);
    else world.pending.hydro = true;
  } else world.pending.hydro = true;
  sys.counts.newVolcanoes = (sys.counts.newVolcanoes || 0) + 1;
  const where = regionName(world, vx, vy, { settleDist: 12 });
  const isIsland = wasWater && shallow;
  const text = opts.divine
    ? `At a god's command the earth split open in ${where}, and a new fire-mountain, ${name}, rose smoking from the ${wasWater ? 'sea' : 'ground'}.`
    : isIsland
      ? `The sea boiled off ${where} as a new volcano, ${name}, heaved itself out of the waves as an island of fire.`
      : wasWater
        ? `A new volcano, ${name}, stirred beneath the sea in ${where}, raising steam and pumice to the surface.`
        : `The earth split open in ${where}, and a new fire-mountain, ${name}, rose from the fields.`;
  chronicle(world, { cat: opts.divine ? 'divine' : 'disaster', imp: 3, x: vx, y: vy, text, key: opts.divine ? 'divine.volcano' : 'volcano.new', ref: { k: 'volcano', id: v.id } });
  erupt(world, sys, v, opts.vei || rng.int(2, 3), { divine: opts.divine, quiet: true });
  return v;
}
