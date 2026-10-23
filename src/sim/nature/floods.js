// River floods and locust plagues.
//   Floods: in very wet months, towns on large rivers may see the water burst its banks —
//   drowned fields and granaries, some deaths, and a gift of silt that enriches the soil.
//   Locusts: hot, semi-arid grasslands breed swarms (more often in droughts); swarms ride
//   the wind for weeks, stripping vegetation and devouring the food stores of every town
//   they pass over.
// Hooks emitted: flood { x, y, deaths, towns } (one per river in flood), locusts { swarmId, x,
// y, foodEaten, towns } when a swarm dies. Swarms live in world.sys.disasters.swarms as
// { id, x, y, r, vx, vy, size, … } (r: the radius they strip, for drawing and previews).

import { WATER, BIOME, DAYS_PER_YEAR } from '../../core/constants.js';
import { emitFx } from '../../core/world.js';
import { liveSettlements, settlementsNear, damageSettlement } from '../../core/entities.js';
import { chronicle } from '../../core/chronicle.js';
import { DX4, DY4 } from '../../core/util.js';
import { fin, clampR, cl01, ss, rateOk, ratePeek, pick, listJoin, deathsClause, yearNum, forDisc, emitHook } from './common.js';
import { regionOf } from './grid.js';
import { regionName, withArticle } from './places.js';

const SEASON = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];

function riverClassNear(world, s) {
  const { W, H, f } = world;
  let rc = f.river[s.i];
  for (let d = 0; d < 4; d++) {
    const nx = s.x + DX4[d], ny = s.y + DY4[d];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    rc = Math.max(rc, f.river[ny * W + nx]);
  }
  return rc;
}

function riverName(world, x, y) {
  let best = null, bd = 30 * 30;
  for (const ft of world.features || []) {
    if (!ft || ft.kind !== 'river' || !ft.name) continue;
    const d = (fin(ft.x) - x) ** 2 + (fin(ft.y) - y) ** 2;
    if (d < bd) { bd = d; best = ft; }
  }
  return best ? withArticle(best.name) : null;
}

/** Monthly flood checks for river towns. */
export function floodMonth(world, sys, month) {
  const dr = clampR(fin(world.params.disasterRate, 1), 0, 3);
  if (dr <= 0) return;
  const f = world.f, rng = world.rng, day = world.time.day;
  const reg = world.sys.weather?.reg || null;
  const groups = new Map();
  for (const s of liveSettlements(world)) {
    const rc = riverClassNear(world, s);
    if (rc < 2) continue;
    if (!ratePeek(sys, `flood:${s.id}`, day, 6)) continue;
    const r = regionOf(world, s.x, s.y);
    const wet = reg && Array.isArray(reg.wet) ? fin(reg.wet[r]) : 0;
    const local = f.rain[s.i] / Math.max(0.05, f.annRain[s.i]);
    const sat = ss(0.65, 0.95, f.soilWater[s.i]);
    const melt = month >= 2 && month <= 4 || month >= 8 && month <= 10 ? ss(0.2, 0.6, f.snow[s.i] + 0.5 * (f.annTemp[s.i] < 5 ? 1 : 0)) * 0.3 : 0;
    const wetF = sat * (0.4 * ss(1.2, 2.5, local) + 0.6 * ss(0.15, 0.6, wet)) + melt;
    if (wetF <= 0.02) continue;
    const p = 0.04 * wetF * ((rc - 1) / 3) * dr;
    if (!rng.chance(p)) continue;
    rateOk(sys, `flood:${s.id}`, day, 6);
    const sev = clampR(0.25 + 0.2 * (rc - 2) + 0.4 * wetF + 0.2 * rng.next(), 0.2, 1);
    const low = 1 + 2 * (1 - ss(0.5, 0.56, f.elevation[s.i] - world.climate.seaLevel + 0.5));
    const name = s.name, tier = s.tier;
    const killed = damageSettlement(world, s, { pop: Math.min(0.08, (0.004 + 0.016 * sev) * low), food: 0.2 + 0.35 * sev, buildings: 0.12 * sev, wealth: 0.1 * sev, cause: 'flood' });
    forDisc(world, s.x, s.y, 2 + 2 * sev, (i, tx, ty, d) => {
      if (f.water[i] !== WATER.LAND) return;
      if (f.river[i] < 1 && f.elevation[i] > f.elevation[s.i] + 0.01) return;
      const g = sev * (1 - d);
      f.devastation[i] = Math.min(1, f.devastation[i] + 0.15 * g);
      f.soil[i] = Math.min(1, f.soil[i] + 0.06 * g);
      f.soilWater[i] = 1;
      f.veg[i] *= 1 - 0.1 * g;
    });
    emitFx(world, { type: 'flood', x: s.x + 0.5, y: s.y + 0.5, r: 2 + 2 * sev });
    sys.counts.floods = (sys.counts.floods || 0) + 1;
    sys.century.floods = (sys.century.floods || 0) + 1;
    sys.counts.floodDeaths = (sys.counts.floodDeaths || 0) + killed;
    const river = riverName(world, s.x, s.y);
    const key = river || `r${r}`;
    const g = groups.get(key) || { river, towns: [], sids: [], deaths: 0, tier: 0, x: s.x, y: s.y, sid: s.id, sev: 0, gone: [] };
    g.towns.push(name); g.sids.push(s.id); g.deaths += killed; g.tier = Math.max(g.tier, tier); g.sev = Math.max(g.sev, sev);
    if (!s.alive) g.gone.push(name);
    groups.set(key, g);
  }
  const season = SEASON[month] || 'spring';
  const yr = yearNum(world);
  for (const g of groups.values()) {
    const imp = g.deaths >= 500 || g.gone.length || (g.tier >= 5 && g.sev > 0.6) ? 3 : g.deaths >= 30 || g.tier >= 4 || g.towns.length >= 3 ? 2 : 1;
    const emitFlood = (seq) => emitHook(world, 'flood', { x: g.x, y: g.y, deaths: Math.round(g.deaths), towns: g.sids.slice(0, 8), river: g.river || null, seq });
    if (imp === 1 && !rateOk(sys, `flood1:${g.river || g.x}`, day, 10)) { emitFlood(null); continue; }
    const dc = deathsClause(g.deaths);
    const rv = g.river ? `${g.river[0].toUpperCase()}${g.river.slice(1)}` : 'The river';
    const text = g.gone.length
      ? `${rv} rose in the ${season} floods of Year ${yr} and washed ${listJoin(g.gone)} away${dc ? ', ' + dc : ''}.`
      : pick(world, [
        `${rv} burst its banks in the ${season} of Year ${yr}, drowning the fields of ${listJoin(g.towns.slice(0, 3))}${dc ? ' and ' + dc : ''}.`,
        `Floodwaters from ${g.river || 'the swollen river'} swept through ${listJoin(g.towns.slice(0, 3))}${dc ? ', ' + dc : ''}, though the silt they left behind would feed the next harvests.`,
        `After weeks of ${season} rain ${g.river || 'the river'} spilled over its levees around ${listJoin(g.towns.slice(0, 3))}${dc ? ', ' + dc : ''}.`,
      ]);
    const e = chronicle(world, { cat: 'disaster', imp, text, x: g.x, y: g.y, sid: g.sid, key: 'flood', ref: { k: 'settlement', id: g.sid } });
    emitFlood(e.seq);
  }
}

// ---------------------------------------------------------------------------
// Locusts

const LOCUST_BIOMES = new Set([BIOME.STEPPE, BIOME.SAVANNA, BIOME.SHRUBLAND, BIOME.HOT_DESERT, BIOME.TROPICAL_FOREST]);
const LOCUST_OK = new Uint8Array(32);
for (const b of LOCUST_BIOMES) LOCUST_OK[b] = 1;

function breedingGrounds(world) {
  // Rebuilt each year (it reads the annual climate) and when the coastline moves or the land
  // is reshaped (each terraform application shifts annTemp by the lapse rate at once, so a list
  // kept from before an unfinished stroke would differ from one a reloaded world builds).
  const v = world.versions;
  const key = `${Math.floor(world.time.day / DAYS_PER_YEAR)}|${v.water}|${v.terrain}`;
  let c = world.cache.natLocust;
  if (c && c.key === key && c.N === world.N) return c.list;
  const { N, f } = world;
  const water = f.water, biome = f.biome, annT = f.annTemp, annR = f.annRain;
  const out = [];
  for (let i = 0; i < N; i++) {
    if (water[i] !== WATER.LAND || !LOCUST_OK[biome[i]]) continue;
    const t = annT[i], r = annR[i];
    if (t > 18 && r > 0.06 && r < 0.42) out.push(i);
  }
  c = world.cache.natLocust = { key, N: world.N, list: Int32Array.from(out) };
  return c.list;
}

export function locustMonth(world, sys) {
  const dr = clampR(fin(world.params.disasterRate, 1), 0, 3);
  if (dr <= 0) return;
  sys.swarms ||= [];
  if (sys.swarms.length >= 3) return;
  const list = breedingGrounds(world);
  if (list.length < 20) return;
  const p = 0.03 * dr * Math.min(1, list.length / 250) * (0.35 + 2.2 * fin(world.climate.droughtIndex));
  if (!world.rng.chance(p)) return;
  const i = list[Math.floor(world.rng.next() * list.length)];
  const f = world.f;
  if (f.temp[i] < 22 || f.veg[i] < 0.08) return;
  spawnSwarm(world, sys, i % world.W, (i / world.W) | 0, world.rng.float(0.35, 0.8));
}

/** Radius (tiles) a swarm of this size strips. */
export const swarmRadius = (size) => 1.5 + 3 * cl01(size);

export function spawnSwarm(world, sys, x, y, size, opts = {}) {
  sys.swarms ||= [];
  const sw = { id: (sys.nextSwarm = (sys.nextSwarm || 0) + 1), x: x + 0.5, y: y + 0.5, r: Math.round(swarmRadius(size) * 10) / 10, vx: 0, vy: 0, size: cl01(size), age: 0, life: world.rng.int(25, 60), sea: 0, hit: [], deaths: 0, food: 0, origin: { x, y }, divine: Boolean(opts.divine) };
  sys.swarms.push(sw);
  sys.counts.locusts = (sys.counts.locusts || 0) + 1;
  sys.century.locusts = (sys.century.locusts || 0) + 1;
  return sw;
}

export function locustDay(world, sys) {
  if (!sys.swarms || !sys.swarms.length) return;
  const { W, H, f } = world;
  const ws = clampR(fin(world.params.windStrength, 1), 0, 2);
  const rng = world.rng;
  for (let k = sys.swarms.length - 1; k >= 0; k--) {
    const sw = sys.swarms[k];
    const xi = clampR(Math.floor(sw.x), 0, W - 1), yi = clampR(Math.floor(sw.y), 0, H - 1);
    const i = yi * W + xi;
    sw.vx += (fin(f.windX[i]) * ws * 2.4 - sw.vx) * 0.5 + rng.normal(0, 0.5);
    sw.vy += (fin(f.windY[i]) * ws * 2.4 - sw.vy) * 0.5 + rng.normal(0, 0.5);
    sw.vx = clampR(sw.vx, -5, 5); sw.vy = clampR(sw.vy, -5, 5);
    sw.x += sw.vx; sw.y += sw.vy; sw.age++;
    let dead = !Number.isFinite(sw.x + sw.y) || sw.x < 0 || sw.y < 0 || sw.x >= W || sw.y >= H;
    if (!dead) {
      const j = clampR(Math.floor(sw.y), 0, H - 1) * W + clampR(Math.floor(sw.x), 0, W - 1);
      if (f.water[j] !== WATER.LAND) { sw.sea++; sw.size -= 0.04; } else sw.sea = 0;
      if (f.temp[j] < 15) sw.size -= 0.06;
      if (f.rain[j] > 0.55) sw.size -= 0.04;
      const R = swarmRadius(sw.size);
      let eaten = 0;
      forDisc(world, sw.x, sw.y, R, (t, tx, ty, d) => {
        if (f.water[t] !== WATER.LAND) return;
        const g = (1 - d) * sw.size;
        const take = f.veg[t] * 0.25 * g;
        f.veg[t] -= take; eaten += take;
      });
      sw.size = cl01(sw.size + 0.004 * eaten - 0.012);
      sw.r = Math.round(swarmRadius(sw.size) * 10) / 10;
      if (sw.size > 0.1) {
        for (const s of settlementsNear(world, sw.x, sw.y, R)) {
          if (sw.hit.includes(s.id)) continue;
          sw.hit.push(s.id);
          const food0 = s.food;
          damageSettlement(world, s, { food: 0.25 + 0.4 * sw.size, wealth: 0.04 * sw.size, cause: 'locusts' });
          sw.food += Math.max(0, food0 - (s.food || 0));
          emitFx(world, { type: 'famine', x: s.x + 0.5, y: s.y + 0.5 });
        }
      }
      dead = sw.sea > 3 || sw.size < 0.08 || sw.age > sw.life;
    }
    if (dead) {
      sys.swarms.splice(k, 1);
      const e = locustChronicle(world, sys, sw);
      // where it did its harm (the first town it stripped), else where it rose
      const at = sw.hit.length ? world.settlements[sw.hit[0]] : null;
      emitHook(world, 'locusts', { swarmId: sw.id, x: at ? at.x : Math.round(sw.origin.x), y: at ? at.y : Math.round(sw.origin.y), originX: sw.origin.x, originY: sw.origin.y, foodEaten: Math.round(sw.food || 0), towns: sw.hit.slice(0, 8), lastX: Number.isFinite(sw.x) ? Math.round(sw.x) : null, lastY: Number.isFinite(sw.y) ? Math.round(sw.y) : null, divine: Boolean(sw.divine), seq: e ? e.seq : null });
    }
  }
}

function locustChronicle(world, sys, sw) {
  const towns = sw.hit.map((sid) => world.settlements[sid]).filter(Boolean);
  if (!towns.length) return null;
  const day = world.time.day;
  const big = towns.reduce((a, s) => Math.max(a, s.tier || 0), 0);
  const imp = towns.length >= 4 || big >= 5 ? 3 : towns.length >= 2 || big >= 3 ? 2 : 1;
  if (imp === 1 && !rateOk(sys, `loc1:${regionOf(world, sw.origin.x, sw.origin.y)}`, day, 10)) return null;
  // The same towns stripped again within a few years make one story, not two.
  if (imp === 2 && !sw.divine && !rateOk(sys, `loc2:${towns[0].id}`, day, 8)) return null;
  const src = regionName(world, sw.origin.x, sw.origin.y, { settleDist: 6 });
  const names = towns.sort((a, b) => b.population - a.population).map((s) => s.name);
  const lead = sw.divine ? 'Summoned by an unseen hand, locusts' : 'Locusts';
  const text = pick(world, [
    `${lead} rose out of ${src} and darkened the skies over ${listJoin(names.slice(0, 2))}, devouring ${names.length > 2 ? `the granaries of ${listJoin(names.slice(2, 5))} and more` : 'the harvest to the last stalk'}.`,
    `${lead} swept over ${listJoin(names.slice(0, 4))} in a living cloud, and when they had passed not a green leaf remained.`,
    `For ${sw.age >= 45 ? 'two months' : sw.age >= 25 ? 'a month' : 'weeks'} the sky hummed over ${listJoin(names.slice(0, 3))}; ${lead === 'Locusts' ? 'the locusts' : 'the swarm'} left granaries empty and fields bare.`,
  ]);
  return chronicle(world, { cat: sw.divine ? 'divine' : 'disaster', imp, text, x: towns[0].x, y: towns[0].y, sid: towns[0].id, key: sw.divine ? 'divine.locusts' : 'locusts', ref: { k: 'settlement', id: towns[0].id } });
}
