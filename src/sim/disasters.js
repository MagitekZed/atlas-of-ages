// Disasters (order 25): the restless planet. All rates scale with params.disasterRate and
// their own parameter.
//   daily     earthquake roll (Gutenberg–Richter along plate boundaries; tsunamis), meteor roll,
//             eruption countdowns and lava fronts, locust swarms on the wind
//   monthly   volcano restlessness and eruptions (VEI 1–7, ash, aerosol), new volcanoes,
//             river floods in wet months, locust outbreaks in hot semi-arid grassland
//   century   tallies of every disaster kind (sys.centuries) for the UI and for balance checks
// God tools (group 'catastrophe'): quake, volcano, meteor, tsunami, flood, locusts — each with
// a pure preview (nature/previews.js), a polarity and, for the world-breakers, a danger test;
// their effects carry src: 'tool' and a floating label (magnitude, VEI, coasts struck).
// Natural events are scaled by the ext 'rates' keys quake, volcano and meteor; the nature hooks
// (quake, tsunami, eruption, impact, flood, locusts) are emitted by the nature modules.

import { WATER } from '../core/constants.js';
import { ensureField, isMonthStart, isYearStart, monthOf, emitFx } from '../core/world.js';
import { settlementsNear, damageSettlement } from '../core/entities.js';
import { chronicle } from '../core/chronicle.js';
import { registerTool } from '../core/tools.js';
import { fin, clampR, rateprune, yearNum, forDisc, listJoin, deathsClause, primeCache, emitHook, fmtRough, pick } from './nature/common.js';
import { quakeTick, quake, tsunami } from './nature/quakes.js';
import { normaliseVolcanoes, volcanoMonth, volcanoDay, erupt, newVolcano, nearestVolcano } from './nature/volcanoes.js';
import { meteorTick, impact } from './nature/meteors.js';
import { floodMonth, locustMonth, locustDay, spawnSwarm } from './nature/floods.js';
import { placePhrase } from './nature/places.js';
import { quakePreview, volcanoPreview, meteorPreview, tsunamiPreview, floodPreview, locustsPreview } from './nature/previews.js';

/** A floating label over the map for a god's act. */
const label = (world, x, y, text, tone = 'bane', size = 1) => emitFx(world, { type: 'label', x: x + 0.5, y: y + 0.5, text: String(text), tone, size, src: 'tool' });
const toll = (n) => (n >= 1 ? `−${fmtRough(n)}` : null);

const ID = 'disasters';

export const system = { id: ID, order: 25, init, update };

function S(world) { return world.sys[ID]; }

function init(world) {
  primeCache(world);
  ensureField(world, 'ash', Float32Array, world.N);
  if (!world.sys[ID]) {
    world.sys[ID] = { counts: {}, century: { start: yearNum(world) }, centuries: [], swarms: [], lava: [], recent: [], craters: [], rl: {} };
  }
  const sys = world.sys[ID];
  sys.counts ||= {}; sys.century ||= { start: yearNum(world) }; sys.centuries ||= []; sys.swarms ||= []; sys.lava ||= []; sys.recent ||= []; sys.rl ||= {};
  if (!Array.isArray(world.volcanoes)) world.volcanoes = [];
  normaliseVolcanoes(world);
}

function update(world) {
  const sys = S(world);
  const day = world.time.day;
  quakeTick(world, sys);
  meteorTick(world, sys);
  volcanoDay(world, sys);
  locustDay(world, sys);
  if (isMonthStart(world)) {
    const m = monthOf(world);
    volcanoMonth(world, sys);
    floodMonth(world, sys, m);
    locustMonth(world, sys);
  }
  if (isYearStart(world) && day > 0) {
    const y = yearNum(world);
    if (y - fin(sys.century.start, 0) >= 100) {
      sys.centuries.push(sys.century);
      if (sys.centuries.length > 60) sys.centuries.shift();
      sys.century = { start: y };
    }
    rateprune(sys, day, 300);
  }
}

// ---------------------------------------------------------------------------
// God tools

const notReady = { ok: false, message: 'The deep earth is not yet listening.' };

registerTool({
  id: 'quake', label: 'Earthquake', group: 'catastrophe', icon: 'quake', order: 10, polarity: 'bane',
  desc: 'Split the earth. Strength is the magnitude; undersea quakes of 7.5 and more raise tsunamis.',
  target: 'tile', radius: 0,
  strength: { label: 'Magnitude', min: 5, max: 9.5, default: 7 },
  danger: (opts) => (opts?.strength ?? 7) > 8.5,
  preview: quakePreview,
  apply(world, x, y, { strength }) {
    const sys = S(world);
    if (!sys) return notReady;
    const M = Math.round(clampR(fin(strength, 7), 4, 9.8) * 10) / 10;
    const r = quake(world, sys, x, y, M, { divine: true });
    const n = r.hit.length;
    label(world, x, y, `M${M.toFixed(1)}`, 'bane', 1 + Math.max(0, M - 7) * 0.2);
    const dead = toll(r.deaths + (r.wave ? r.wave.deaths : 0));
    if (dead) label(world, x, y + 1.2, dead, 'bane');
    if (r.wave && r.wave.hit.length) label(world, x, y + 2.4, `${r.wave.hit.length} coast${r.wave.hit.length === 1 ? '' : 's'} struck`, 'bane', 0.9);
    return { ok: true, message: `M${M.toFixed(1)} earthquake${n ? `: ${n} settlement${n > 1 ? 's' : ''} struck` : ''}${r.wave ? ', and a tsunami races outward' : ''}.` };
  },
});

registerTool({
  id: 'volcano', label: 'Volcano', group: 'catastrophe', icon: 'volcano', order: 20, polarity: 'bane',
  desc: 'Wake the nearest volcano, or raise a new one here if none is close. Strength is the eruption size (VEI).',
  target: 'tile', radius: 0,
  strength: { label: 'VEI', min: 1, max: 7, default: 4 },
  danger: (opts) => (opts?.strength ?? 4) >= 6.5,
  preview: volcanoPreview,
  apply(world, x, y, { strength }) {
    const sys = S(world);
    if (!sys) return notReady;
    const vei = clampR(Math.round(fin(strength, 4)), 1, 7);
    const best = nearestVolcano(world, x, y, 12);
    if (best) {
      const r = erupt(world, sys, best, vei, { divine: true });
      label(world, best.x, best.y, `VEI ${r.vei}`, 'bane', 1 + Math.max(0, r.vei - 4) * 0.15);
      if (toll(r.deaths)) label(world, best.x, best.y + 1.2, toll(r.deaths), 'bane');
      return { ok: true, message: `${best.name} erupts (VEI ${r.vei}).` };
    }
    const v = newVolcano(world, sys, x, y, { divine: true, vei });
    if (v) label(world, v.x, v.y, v.name, 'bane');
    return v ? { ok: true, message: `${v.name} rises from the ${world.f.water[v.i] === WATER.LAND ? 'earth' : 'sea'}.` } : { ok: false, message: 'The earth would not open here.' };
  },
});

registerTool({
  id: 'meteor', label: 'Falling Star', group: 'catastrophe', icon: 'meteor', order: 30, polarity: 'bane',
  desc: 'Call down a meteor. Strength is the crater radius in tiles; large strikes bring an impact winter, ocean strikes a mega-tsunami.',
  target: 'tile', radius: 0,
  strength: { label: 'Size', min: 0.5, max: 12, default: 2 },
  danger: (opts) => (opts?.strength ?? 2) > 6,
  preview: meteorPreview,
  apply(world, x, y, { strength }) {
    const sys = S(world);
    if (!sys) return notReady;
    const R = clampR(fin(strength, 2), 0.4, 20);
    const r = impact(world, sys, x, y, R, { divine: true });
    const dead = toll(r.deaths + (r.wave ? r.wave.deaths : 0));
    if (dead) label(world, x, y, dead, 'bane', 1 + Math.min(1, R / 8));
    if (r.wave && r.wave.hit.length) label(world, x, y + 1.3, `${r.wave.hit.length} coast${r.wave.hit.length === 1 ? '' : 's'} struck`, 'bane', 0.9);
    return { ok: true, message: `A star falls${r.gone.length ? `, obliterating ${listJoin(r.gone.slice(0, 3))}` : ''}.` };
  },
});

registerTool({
  id: 'tsunami', label: 'Tsunami', group: 'catastrophe', icon: 'tsunami', order: 40, polarity: 'bane',
  desc: 'Raise a great wave from the nearest sea. It crosses open water and breaks on every coast in reach.',
  target: 'tile', radius: 0,
  strength: { label: 'Height', min: 0.2, max: 1.2, default: 0.7 },
  preview: tsunamiPreview,
  apply(world, x, y, { strength }) {
    const sys = S(world);
    if (!sys) return notReady;
    const h = clampR(fin(strength, 0.7), 0.1, 1.5);
    const r = tsunami(world, sys, x, y, { range: 20 + 45 * h, height: h, divine: true, source: 'no storm or quake that any sailor could name' });
    if (!r.reached && !r.hit.length) return { ok: false, message: 'There is no sea here to raise.' };
    label(world, x, y, r.hit.length ? `${r.hit.length} coast${r.hit.length === 1 ? '' : 's'} struck` : 'Empty shores', 'bane');
    if (toll(r.deaths)) label(world, x, y + 1.2, toll(r.deaths), 'bane');
    return { ok: true, message: r.hit.length ? `The wave strikes ${listJoin(r.hit.slice(0, 3))}${r.hit.length > 3 ? ' and more' : ''}.` : 'The wave breaks on empty shores.' };
  },
});

registerTool({
  id: 'flood', label: 'Flood', group: 'catastrophe', icon: 'flood', order: 50, polarity: 'bane',
  desc: 'Swell the rivers and drown the lowlands. Floods kill and ruin harvests but leave fertile silt.',
  target: 'area', radius: 6, minRadius: 1, maxRadius: 25, continuous: true,
  strength: { label: 'Depth', min: 0.1, max: 1, default: 0.6 },
  preview: floodPreview,
  apply(world, x, y, { radius, strength }) {
    const sys = S(world);
    if (!sys) return notReady;
    const f = world.f, s = clampR(fin(strength, 0.6), 0.05, 1), R = Math.max(1, fin(radius, 6));
    const sea = world.climate.seaLevel;
    let n = 0;
    forDisc(world, x, y, R, (i, tx, ty, d) => {
      if (f.water[i] !== WATER.LAND) return;
      const lowland = 1 - Math.min(1, Math.max(0, (f.elevation[i] - sea) / 0.12));
      const g = s * (1 - d * d) * (0.3 + 0.7 * Math.max(lowland, f.river[i] ? 1 : 0));
      if (g < 0.05) return;
      f.soilWater[i] = 1;
      f.devastation[i] = Math.min(1, f.devastation[i] + 0.2 * g);
      f.soil[i] = Math.min(1, f.soil[i] + 0.04 * g);
      f.veg[i] *= 1 - 0.12 * g;
      if (f.fire[i] > 0) f.fire[i] = 0;
      n++;
    });
    if (!n) return { ok: false, message: 'Only dry land can flood.' };
    const day = world.time.day;
    const st = (sys.stroke && sys.stroke.tool === 'flood' && day - sys.stroke.day < 30) ? sys.stroke : (sys.stroke = { tool: 'flood', day, hit: [], deaths: 0, x, y, chron: false });
    st.day = day;
    for (const sett of settlementsNear(world, x, y, R)) {
      if (st.hit.includes(sett.id)) continue;
      st.hit.push(sett.id);
      const d = Math.hypot(sett.x - x, sett.y - y) / R;
      const g = s * (1 - d * d);
      st.deaths += damageSettlement(world, sett, { pop: 0.02 * g, food: 0.45 * g, buildings: 0.15 * g, wealth: 0.1 * g, cause: 'flood' });
      emitFx(world, { type: 'flood', x: sett.x + 0.5, y: sett.y + 0.5, r: 2, src: 'tool' });
    }
    if (!st.chron) {
      st.chron = true;
      emitFx(world, { type: 'curse', x, y, r: R, src: 'tool' });
      emitFx(world, { type: 'flood', x, y, r: R, src: 'tool' });
    }
    return { ok: true, message: 'The waters rise.' };
  },
  finish(world) {
    const sys = S(world);
    const st = sys?.stroke;
    if (!st || st.tool !== 'flood') return;
    sys.stroke = null;
    sys.counts.floods = (sys.counts.floods || 0) + 1;
    sys.counts.floodDeaths = (sys.counts.floodDeaths || 0) + st.deaths;
    const names = st.hit.map((sid) => world.settlements[sid]?.name).filter(Boolean);
    const dc = deathsClause(st.deaths);
    const where = placePhrase(world, st.x, st.y).text;
    if (toll(st.deaths)) label(world, st.x, st.y, toll(st.deaths), 'bane');
    const e = chronicle(world, { cat: 'divine', imp: names.length ? 2 : 1, x: st.x, y: st.y, key: 'divine.flood', ...(st.hit.length ? { ref: { k: 'settlement', id: st.hit[0] } } : {}), text: names.length
      ? pick(world, [
        `A flood sent by no earthly rain drowned the lowlands ${where}, swamping ${listJoin(names.slice(0, 3))}${dc ? ' and ' + dc : ''}.`,
        `The rivers rose against all reason ${where}; ${listJoin(names.slice(0, 3))} stood waist-deep in water${dc ? ', ' + dc : ''}.`,
      ])
      : `The waters rose unbidden ${where} and drowned the empty lowlands.` });
    emitHook(world, 'flood', { x: st.x, y: st.y, deaths: Math.round(st.deaths), towns: st.hit.slice(0, 8), river: null, divine: true, seq: e.seq });
  },
});

registerTool({
  id: 'locusts', label: 'Locusts', group: 'catastrophe', icon: 'locusts', order: 60, polarity: 'bane',
  desc: 'Loose a locust swarm that rides the wind, stripping fields and devouring the granaries of every town it passes.',
  target: 'tile', radius: 0,
  strength: { label: 'Swarm', min: 0.2, max: 1, default: 0.7 },
  preview: locustsPreview,
  apply(world, x, y, { strength }) {
    const sys = S(world);
    if (!sys) return notReady;
    if (world.f.water[y * world.W + x] !== WATER.LAND) return { ok: false, message: 'The swarm must rise from land.' };
    if ((sys.swarms || []).length >= 8) return { ok: false, message: 'The skies are already thick with locusts.' };
    const sw = spawnSwarm(world, sys, x, y, clampR(fin(strength, 0.7), 0.15, 1), { divine: true });
    emitFx(world, { type: 'curse', x, y, r: sw.r, src: 'tool' });
    label(world, x, y, 'Locusts', 'bane');
    return { ok: true, message: 'A swarm of locusts takes wing.' };
  },
});

/** Read-only summary for the UI / stats: disaster tallies this century and all-time. */
export function disasterSummary(world) {
  const sys = world.sys[ID];
  if (!sys) return null;
  return { counts: { ...sys.counts }, century: { ...sys.century }, centuries: sys.centuries.slice(), swarms: sys.swarms.length, erupting: world.volcanoes.filter((v) => v && v.erupting > 0).length };
}

