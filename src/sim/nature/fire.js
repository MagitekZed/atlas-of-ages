// Wildfire: ignition, daily spread and burnout. A fire is a set of burning tiles
// sharing an event id (f.fireId). Spread to each neighbour depends on fuel,
// flammability, dryness, rain and wind direction; every event is slowly
// "contained" by its age and size, so all fires die out. Big events become entries in
// world.fires (map labels) and are chronicled with their burned area when they end.
// Spontaneous ignition is scaled by the ext 'rates' key 'wildfire'.
// Hook emitted: fireEnded(fire) for every fire that grew notable or reached a town — a fresh
// { id (world.fires id or null), name, x, y, startDay, endDay, tiles, deaths, towns, hit, gone,
// cause, great } (towns and hit: the sids it burned).

import { WATER, BIOME, BIOMES } from '../../core/constants.js';
import { emitFx } from '../../core/world.js';
import { addEntity, damageSettlement } from '../../core/entities.js';
import { chronicle } from '../../core/chronicle.js';
import { DX8, DY8, majorToll } from '../../core/util.js';
import { fin, clampR, ss, rateOk, pick, fmtArea, listJoin, deathsClause, yearNum, cap, emitHook, rateMul } from './common.js';
import { landList, regionOf } from './grid.js';
import { placePhrase, featureAt, withArticle } from './places.js';

const FLAM = new Float32Array(BIOMES.map((b) => b.fire));
const SPREAD = 0.14;  // daily ignition chance per neighbour at full intensity, fuel and dryness
const NOTABLE = 12;   // tiles (4,800 km²) → world.fires entry
const GREAT = 36;     // tiles (14,400 km²) → a named great fire
const DIR_X = new Float32Array(8), DIR_Y = new Float32Array(8);
for (let d = 0; d < 8; d++) { const l = Math.hypot(DX8[d], DY8[d]); DIR_X[d] = DX8[d] / l; DIR_Y[d] = DY8[d] / l; }

function ecoSys(world) {
  const s = (world.sys.ecology ||= {});
  s.fireEv ||= {};
  s.nextEv ||= 1;
  s.counts ||= {};
  s.fireYear ||= { year: yearNum(world), ignitions: 0, tiles: 0, biggest: 0, events: 0 };
  return s;
}

/**
 * Burning-tile list (cache). Rebuilt from the fire field after load, in the canonical state
 * compact() leaves: sorted, burning tiles only, no event id on tiles that are out.
 */
export function fireList(world) {
  let c = world.cache.natFire;
  if (c && c.N === world.N) return c;
  const { N, f } = world;
  const fireId = f.fireId;
  let list = new Int32Array(Math.max(256, (N / 8) | 0));
  let n = 0;
  // Tiles quenched since the last compact (fire 0, id still set) join the list too: the running
  // world holds them there until its next compact() clears their ids, so a restored world must
  // keep the ids until the same moment (a save in between then matches byte for byte).
  for (let i = 0; i < N; i++) {
    if (f.fire[i] > 0 || (fireId && fireId[i])) {
      if (n >= list.length) { const grown = new Int32Array(list.length * 2); grown.set(list); list = grown; }
      list[n++] = i;
    }
  }
  c = world.cache.natFire = { N, list, n, dirty: false };
  return c;
}

function pushBurning(world, i) {
  const c = fireList(world);
  if (c.n >= c.list.length) {
    const grown = new Int32Array(c.list.length * 2);
    grown.set(c.list);
    c.list = grown;
  }
  c.list[c.n++] = i;
  c.dirty = true;
}

/**
 * Start or strengthen a fire on land tile i. No-op on water or bare ground.
 * opts: { cause: 'lightning'|'heat'|'divine'|'lava'|'meteor'|string, eventId }
 * Returns true if the tile is burning afterwards.
 */
export function ignite(world, i, intensity = 0.6, opts = {}) {
  const f = world.f;
  i |= 0;
  if (i < 0 || i >= world.N || f.water[i] !== WATER.LAND) return false;
  const I = clampR(fin(intensity, 0.6), 0.05, 1);
  if (f.veg[i] < 0.06 || f.snow[i] > 0.6) return false;
  const fireId = world.f.fireId;
  if (f.fire[i] > 0) { f.fire[i] = Math.min(1, Math.max(f.fire[i], I)); return true; }
  const sys = ecoSys(world);
  let ev = null;
  // Join a neighbouring fire, else start a new event.
  let id = opts.eventId != null && sys.fireEv[opts.eventId] ? opts.eventId : 0;
  if (!id && fireId) {
    const W = world.W, x = i % W, y = (i / W) | 0;
    for (let d = 0; d < 8 && !id; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= world.H) continue;
      const j = ny * W + nx;
      if (f.fire[j] > 0 && sys.fireEv[fireId[j]]) id = fireId[j];
    }
  }
  if (id) ev = sys.fireEv[id];
  else {
    id = sys.nextEv++;
    if (sys.nextEv > 2e9) sys.nextEv = 1;
    const x = i % world.W, y = (i / world.W) | 0;
    ev = sys.fireEv[id] = { id, x, y, start: world.time.day, tiles: 0, burning: 0, sx: 0, sy: 0, cause: opts.cause || 'heat', hit: [], deaths: 0, entity: null, gone: [] };
    sys.counts.fires = (sys.counts.fires || 0) + 1;
    sys.fireYear.ignitions++;
  }
  f.fire[i] = I;
  if (fireId) fireId[i] = id;
  ev.burning++;
  ev.tiles++;
  ev.sx += i % world.W; ev.sy += (i / world.W) | 0;
  sys.fireYear.tiles++;
  pushBurning(world, i);
  return true;
}

/** Daily spontaneous ignitions: a few random land tiles are tested each day (Monte-Carlo). */
export function spontaneous(world) {
  const rate = clampR(fin(world.params.wildfireRate, 1), 0, 3) * rateMul(world, 'wildfire');
  if (rate <= 0) return;
  const list = landList(world);
  const L = list.length;
  if (!L) return;
  const f = world.f, rng = world.rng;
  const veg = f.veg, fire = f.fire, biome = f.biome, soilW = f.soilWater, temp = f.temp, rain = f.rain, snow = f.snow;
  const M = 8;
  const scale = (L / M) * 2.2e-3 * rate;
  for (let k = 0; k < M; k++) {
    const i = list[Math.floor(rng.next() * L)];
    const v = veg[i];
    if (v < 0.1 || fire[i] > 0) { rng.next(); continue; }
    const p = scale * FLAM[biome[i]] * (1 - ss(0.1, 0.45, soilW[i])) * ss(14, 32, temp[i]) * ss(0.04, 0.35, v) * (1 - ss(0.06, 0.35, rain[i])) * (1 - snow[i]);
    if (rng.next() < p) ignite(world, i, 0.35 + 0.4 * rng.next(), { cause: 'heat' });
  }
}

/** Daily fire step: intensity, burning, spread, burnout, settlement damage. */
export function updateFires(world) {
  const c = fireList(world);
  if (!c.n) { const sys0 = ecoSys(world); for (const id in sys0.fireEv) sys0.fireEv[id].burning = 0; closeEvents(world); return; }
  const { W, H, f } = world;
  const sys = ecoSys(world);
  const rng = world.rng;
  const rate = clampR(fin(world.params.wildfireRate, 1), 0, 3);
  const rateF = Math.sqrt(Math.min(2, rate));
  const ws = clampR(fin(world.params.windStrength, 1), 0, 2);
  const fireId = f.fireId;
  const fire = f.fire, veg = f.veg, soilW = f.soilWater, rain = f.rain, snow = f.snow, hum = f.humidity;
  const herb = f.herb, pred = f.pred, scar = f.burnScar, dev = f.devastation, settle = f.settle, soil = f.soil;
  const water = f.water, biome = f.biome, river = f.river, windX = f.windX, windY = f.windY;
  const day = world.time.day;
  // Tiles lit since the last pass (lava, meteors, tools) were appended out of order, perhaps
  // twice: restore the canonical order first, which a reloaded world has from its rebuild.
  if (c.dirty) compact(world, c, sys);
  const n0 = c.n;
  // Tiles ignited today are appended past n0 and start burning tomorrow. (The list
  // may be reallocated by ignite(); its first n0 entries are preserved.)
  for (let k = 0; k < n0; k++) {
    const i = c.list[k];
    let I = fire[i];
    if (!(I > 0)) continue;
    const ev = sys.fireEv[fireId ? fireId[i] : 0] || null;
    const v = veg[i];
    const dry = 1 - ss(0.1, 0.45, soilW[i]);
    const wet = ss(0.06, 0.35, rain[i]);
    const hh = hum[i];
    I += 0.25 * (0.3 + 0.9 * Math.min(1, v * 1.8) * dry - I) - 1.2 * wet - 2 * snow[i] - 0.3 * hh * hh * (1 - dry);
    I = Math.min(1, I);
    const burn = 0.22 * Math.max(0.2, I) * (0.3 + v);
    const nv = Math.max(0, v - burn);
    veg[i] = nv;
    herb[i] *= 0.85;
    pred[i] *= 0.9;
    scar[i] = Math.max(scar[i], 0.6);
    dev[i] = Math.min(1, dev[i] + 0.01);
    // Settlement on the tile.
    const sid = settle[i];
    if (sid >= 0 && ev && !ev.hit.includes(sid)) {
      const s = world.settlements[sid];
      if (s && s.alive) {
        ev.hit.push(sid);
        const name = s.name;
        const killed = damageSettlement(world, s, { pop: 0.015 + 0.03 * I, buildings: 0.15 + 0.2 * I, food: 0.15 + 0.2 * I, wealth: 0.08, cause: 'fire' });
        ev.deaths += killed;
        if (!s.alive) ev.gone.push(name);
      }
    }
    // A town beside the fire: the flames reach into it once, by how dry the land is.
    if (ev && I >= 0.15) {
      const x = i % W, y = (i / W) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const sj = settle[ny * W + nx];
        if (sj < 0 || ev.hit.includes(sj)) continue;
        const s = world.settlements[sj];
        if (!s || !s.alive) continue;
        ev.hit.push(sj);
        const k = (0.5 + 0.5 * dry) * I, name = s.name;
        ev.deaths += damageSettlement(world, s, { pop: 0.01 + 0.03 * k, buildings: 0.1 + 0.2 * k, food: 0.1 + 0.2 * k, wealth: 0.06 * k, cause: 'fire' });
        if (!s.alive) ev.gone.push(name);
      }
    }
    if (nv < 0.05 || I < 0.04) {
      // Burnt out (or drowned by rain).
      fire[i] = 0;
      if (nv < 0.06) { veg[i] = 0.02 + 0.03 * rng.next(); scar[i] = 1; soil[i] = Math.min(1, soil[i] + 0.03); }
      continue;
    }
    fire[i] = I;
    if (I < 0.08) continue;
    // Spread: each unburnt neighbour may catch, by its fuel, flammability and dryness, the
    // wind (downwind favoured) and rivers (wide ones are firebreaks). Every event is slowly
    // contained as it ages and grows, so all fires end.
    const age = ev ? day - ev.start : 0;
    const size = ev ? ev.tiles : 1;
    const supp = Math.exp(-age / 45) / (1 + size / 350);
    const x = i % W, y = (i / W) | 0;
    const wx = fin(windX[i]) * ws, wy = fin(windY[i]) * ws;
    const wl = Math.hypot(wx, wy) + 0.3;
    const base = SPREAD * (0.35 + 0.65 * I) * supp * rateF;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (water[j] !== WATER.LAND || fire[j] > 0) continue;
      const vj = veg[j];
      if (vj < 0.1) continue;
      const rv = river[j];
      const windF = 1 + 0.9 * (DIR_X[d] * wx + DIR_Y[d] * wy) / wl;
      const p = base * FLAM[biome[j]] * ss(0.04, 0.35, vj) * (1 - ss(0.1, 0.45, soilW[j])) * (1 - ss(0.06, 0.35, rain[j])) * (1 - snow[j])
        * windF * (d & 1 ? 0.7 : 1) * (rv >= 3 ? 0.1 : rv === 2 ? 0.5 : 1);
      if (p > 0 && rng.next() < p) ignite(world, j, Math.max(0.25, I * 0.8), { eventId: ev ? ev.id : undefined, cause: ev?.cause });
    }
  }
  compact(world, c, sys);
  trackNotable(world);
  closeEvents(world);
}

/**
 * Drop extinguished tiles (burnt out, rained out, or quenched by a tool or storm),
 * keep a canonical sorted order (so a reloaded world replays identically) and
 * recount each event's burning tiles exactly.
 */
function compact(world, c, sys) {
  const f = world.f, fireId = f.fireId;
  const list = c.list;
  if (c.n > 1) list.subarray(0, c.n).sort();
  for (const id in sys.fireEv) sys.fireEv[id].burning = 0;
  let m = 0, prev = -1;
  for (let k = 0; k < c.n; k++) {
    const i = list[k];
    if (i === prev) continue;
    prev = i;
    const ev = fireId ? sys.fireEv[fireId[i]] : null;
    if (f.fire[i] > 0) { list[m++] = i; if (ev) ev.burning++; }
    else if (fireId) fireId[i] = 0;
  }
  c.n = m;
  c.dirty = false;
}

/** Promote big fires to world.fires (labels) and keep their numbers current. */
function trackNotable(world) {
  const sys = ecoSys(world);
  for (const id of Object.keys(sys.fireEv)) {
    const ev = sys.fireEv[id];
    if (ev.tiles < NOTABLE) continue;
    const cx = Math.round(ev.sx / Math.max(1, ev.tiles)), cy = Math.round(ev.sy / Math.max(1, ev.tiles));
    let ent = ev.entity != null ? world.fires.find((o) => o.id === ev.entity) : null;
    if (!ent) {
      ent = addEntity(world, 'fires', { name: fireName(world, ev, cx, cy, false), x: cx, y: cy, startDay: ev.start, tiles: ev.tiles, active: true, endDay: null, cause: ev.cause }, 'fire');
      ev.entity = ent.id;
      emitFx(world, { type: 'fire', x: cx, y: cy, r: Math.sqrt(ev.tiles) });
      pruneFires(world);
    }
    if (ev.tiles >= GREAT && !ev.great) { ev.great = true; ent.name = fireName(world, ev, cx, cy, true); }
    ent.x = cx; ent.y = cy; ent.tiles = ev.tiles;
    if ((world.time.day - ev.start) % 10 === 0 && ev.burning > 0) emitFx(world, { type: 'fire', x: cx, y: cy, r: Math.sqrt(ev.tiles) });
  }
}

function pruneFires(world) {
  if (world.fires.length <= 80) return;
  const old = world.fires.filter((o) => !o.active).sort((a, b) => (a.endDay ?? 0) - (b.endDay ?? 0));
  const drop = new Set(old.slice(0, world.fires.length - 80).map((o) => o.id));
  world.fires = world.fires.filter((o) => !drop.has(o.id));
}

function fireName(world, ev, x, y, great) {
  const fa = featureAt(world, x, y);
  const s = (world.settlements[ev.hit[0]]) || null;
  const yr = yearNum(world, ev.start);
  const taken = (n) => world.fires.some((o) => o.name === n && o.id !== ev.entity);
  const cands = [];
  if (great) {
    if (fa && (fa.ft.kind === 'forest' || fa.ft.kind === 'range' || fa.ft.kind === 'desert')) cands.push(`the Burning of ${withArticle(fa.ft.name)}`);
    if (s) cands.push(`the Great Fire of ${s.name}`);
    cands.push(`the Great Fire of Year ${yr}`);
    if (fa && fa.ft.name) cands.push(`the ${(fa.ft.base || fa.ft.name.replace(/^the\s+/i, '').split(' ')[0])} Firestorm`);
    cands.push(`the Ash Summer of Year ${yr}`);
  } else {
    const base = fa && fa.ft.name ? (fa.ft.base || fa.ft.name.replace(/^the\s+/i, '')) : null;
    if (s) cands.push(`the ${s.name} Fire`);
    if (fa && fa.ft.kind === 'forest') cands.push(`the ${fa.ft.name.replace(/^the\s+/i, '')} Fire`);
    if (base && fa.ft.kind !== 'lake' && fa.ft.kind !== 'sea' && fa.ft.kind !== 'ocean') cands.push(`the ${base} Fire of Year ${yr}`);
    if (s) cands.push(`the ${s.name} Fire of Year ${yr}`);
    cands.push(`the Fire of Year ${yr}`);
  }
  for (const n of cands) if (!taken(n)) return n;
  const base = cands[cands.length - 1];
  for (let k = 1; k < ORDS.length; k++) {
    const n = base.replace(/^the /, `the ${ORDS[k]} `);
    if (!taken(n)) return n;
  }
  return base;
}
const ORDS = ['', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

/** Finished events: close their world.fires entry and chronicle the notable ones. */
function closeEvents(world) {
  const sys = ecoSys(world);
  const day = world.time.day;
  for (const id of Object.keys(sys.fireEv)) {
    const ev = sys.fireEv[id];
    if (ev.burning > 0) continue;
    delete sys.fireEv[id];
    const fy = sys.fireYear;
    fy.events++;
    if (ev.tiles > fy.biggest) fy.biggest = ev.tiles;
    sys.counts.burnedTiles = (sys.counts.burnedTiles || 0) + ev.tiles;
    // Size classes: 1, 2–4, 5–11, notable 12–44, great 45+ tiles.
    const hist = Array.isArray(sys.counts.fireHist) && sys.counts.fireHist.length === 5 ? sys.counts.fireHist : (sys.counts.fireHist = [0, 0, 0, 0, 0]);
    hist[ev.tiles >= GREAT ? 4 : ev.tiles >= NOTABLE ? 3 : ev.tiles >= 5 ? 2 : ev.tiles >= 2 ? 1 : 0]++;
    if (ev.tiles > (sys.counts.biggestFire || 0)) sys.counts.biggestFire = ev.tiles;
    let ent = null;
    if (ev.entity != null) {
      ent = world.fires.find((o) => o.id === ev.entity);
      if (ent) { ent.active = false; ent.endDay = day; ent.tiles = ev.tiles; ent.deaths = Math.round(ev.deaths || 0); ent.towns = ev.hit.slice(0, 8); }
    }
    const e = chronicleFire(world, ev, ent);
    if (ent || ev.hit.length) {
      const cx = Math.round(ev.sx / Math.max(1, ev.tiles)), cy = Math.round(ev.sy / Math.max(1, ev.tiles));
      emitHook(world, 'fireEnded', {
        id: ent ? ent.id : null, name: ent ? ent.name : null, x: cx, y: cy, startDay: ev.start, endDay: day, tiles: ev.tiles,
        deaths: Math.round(ev.deaths || 0), towns: ev.hit.slice(0, 8), hit: ev.hit.slice(0, 8), gone: ev.gone.slice(0, 8), cause: ev.cause || 'heat',
        great: ev.tiles >= GREAT || ev.gone.length > 0, seq: e ? e.seq : null,
      });
    }
  }
}

/** What burned, by the biome at the fire's heart: "grass fire", "forest fire", … */
function fuelWord(world, i) {
  switch (world.f.biome[i]) {
    case BIOME.STEPPE: case BIOME.SAVANNA: return 'grass fire';
    case BIOME.SHRUBLAND: case BIOME.HOT_DESERT: case BIOME.COLD_DESERT: return 'brush fire';
    case BIOME.TAIGA: return 'forest fire';
    case BIOME.TEMPERATE_FOREST: case BIOME.TEMPERATE_RAINFOREST: case BIOME.TROPICAL_FOREST: case BIOME.RAINFOREST: return 'forest fire';
    case BIOME.TUNDRA: case BIOME.ALPINE: return 'moorland fire';
    default: return 'wildfire';
  }
}

function chronicleFire(world, ev, ent) {
  const sys = ecoSys(world), day = world.time.day;
  const cx = Math.round(ev.sx / Math.max(1, ev.tiles)), cy = Math.round(ev.sy / Math.max(1, ev.tiles));
  const towns = ev.hit.map((sid) => world.settlements[sid]?.name).filter(Boolean);
  const hitTowns = towns.length > 0;
  if (ev.tiles < NOTABLE && !hitTowns) return null;
  const great = ev.tiles >= GREAT || ev.gone.length > 0;
  // the toll is weighed on the one scale every disaster uses (core/util majorToll)
  let left = 0;
  for (const sid of ev.hit) { const s = world.settlements[sid]; if (s && s.alive) left += s.population; }
  const imp = great || majorToll(ev.deaths, ev.deaths / Math.max(1, ev.deaths + left)) ? 3 : ev.tiles >= 20 || ev.deaths >= 50 || (hitTowns && ev.tiles >= NOTABLE) ? 2 : 1;
  if (!great && !rateOk(sys, `fire:${regionOf(world, cx, cy)}`, day, imp >= 2 ? 6 : 10)) return null;
  const ci = Math.max(0, Math.min(world.N - 1, cy * world.W + cx));
  const area = fmtArea(ev.tiles);
  const where = placePhrase(world, cx, cy, { settleDist: 6 }).text;
  const days = Math.max(1, day - ev.start);
  const dur = days >= 45 ? `${Math.round(days / 30)} months` : `${days} days`;
  const tropic = Math.abs(1 - (2 * (cy + 0.5)) / world.H) < 0.35;
  const src = ev.cause === 'lightning' ? 'Lightning kindled' : ev.cause === 'divine' ? 'A god-sent bolt kindled' : ev.cause === 'lava' ? 'Lava kindled'
    : ev.cause === 'meteor' ? 'The falling star kindled' : tropic ? 'The dry season kindled' : 'Summer heat kindled';
  const end = world.f.rain[ci] > 0.15 ? 'before the rains quenched it' : 'before it burned itself out';
  const fuel = fuelWord(world, ci);
  const dc = deathsClause(ev.deaths);
  const nm = ent?.name || (great ? fireName(world, ev, cx, cy, true) : null);
  let text;
  if (ev.gone.length) {
    text = `${cap(nm || 'a great fire')} burned ${area} ${where} and reduced ${listJoin(ev.gone)} to ash${dc ? ', ' + dc : ''}.`;
  } else if (great) {
    text = pick(world, [
      `${cap(nm)} raged ${where} for ${dur}, devouring ${area} ${end}${hitTowns ? `, and scorched ${listJoin(towns.slice(0, 3))}` : ''}${dc ? ', ' + dc : ''}.`,
      `${src} ${nm}, a ${fuel} that burned ${area} ${where} over ${dur}${hitTowns ? ` and swept through ${listJoin(towns.slice(0, 3))}` : ''}${dc ? ', ' + dc : ''}.`,
    ]);
  } else if (hitTowns) {
    text = pick(world, [
      `A ${fuel} swept into ${listJoin(towns.slice(0, 3))}${dc ? ', ' + dc : ''}, after burning ${area} of the surrounding country.`,
      `Flames from a ${ev.tiles >= NOTABLE ? 'great ' : ''}${fuel} licked the walls of ${listJoin(towns.slice(0, 3))}${dc ? ', ' + dc : ''}.`,
    ]);
  } else {
    text = pick(world, [
      `${src} a ${fuel} that burned ${area} ${where} ${end}.`,
      `A ${fuel} smouldered ${where} for ${dur}, leaving ${area} of blackened land.`,
      `Fire ran unchecked ${where} for ${dur} and blackened ${area}.`,
    ]);
  }
  const sid = ev.hit[0] ?? null;
  const ref = ent ? { k: 'fire', id: ent.id } : sid != null ? { k: 'settlement', id: sid } : null;
  return chronicle(world, { cat: ev.cause === 'divine' ? 'divine' : 'nature', imp, text, x: cx, y: cy, sid, key: ev.cause === 'divine' ? 'divine.wildfire' : great ? 'fire.great' : 'fire', ...(ref ? { ref } : {}), tags: [String(ev.cause || 'heat')] });
}
