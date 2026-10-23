// The Fading: industry thins the weave of the world, and the age of myth ends — or does not.
// sys.myth.weave (0.15…1; WP2's beasts read it) relaxes 3 % a year toward
//   1 − 0.55·clamp01((co2 − 300) / 400) − 0.6·clamp01(pollution on owned land / 0.2)
//     − 0.2·(share of realms in the Industrial Age or later)
// floored at 0.15 (and held at 1 while params.fading is off). The weave scales the mana
// target (mana.js), divides arcane research costs (arcana.js) and the births of the elder
// races (races.js), and costs magic-heavy realms stability. Crossing 0.75, 0.5 and 0.25 is
// chronicled once each; a recovery of 0.3 from the lowest point is "the Return of Wonder".
// Yearly, O(N/16).

import { addEffect, removeEffect } from '../../core/effects.js';
import { liveCivs } from '../../core/entities.js';
import { WATER, DAYS_PER_YEAR } from '../../core/constants.js';
import { clamp01 } from '../../core/util.js';
import { fin } from './races.js';
import { pickT, fill, record, yearOfDay } from './prose.js';
import { leyNodes } from './mana.js';

const MARKS = [
  { at: 0.75, imp: 4, key: 'myth.fading.dim', texts: [
    'In Year {y} the ley-fires dimmed: at {node} the stones that had sung for a thousand years fell silent, and the hedge-witches of {city} found their charms gone thin.',
    'The weave of the world grew thin in Year {y}. Smoke lay over {city}, and the light went out of {node}.',
  ] },
  { at: 0.5, imp: 4, key: 'myth.fading.few', texts: [
    'By Year {y} the dragons had grown few and the wild magic slept; children in {city} were told that wizards had only ever been stories.',
    'In Year {y} the last spring of power near {city} ran dry, and {node} was only a ring of old stones on a hill.',
  ] },
  { at: 0.25, imp: 5, key: 'myth.fading.end', texts: [
    'The Age of Myth ended in Year {y}. Under the smoke of the great works of {city} no spell would take, and the elder peoples spoke of the old world as the lost one.',
    'In Year {y} the weave of the world failed. {node} went dark, and with it the last of the wonders the first ages had known.',
  ] },
];

const RETURN = [
  'In Year {y} wonder returned to the world: the smokestacks of {city} cooled, and once more {node} sang at midwinter.',
  'The weave mended in Year {y}. Lights were seen again at {node}, and the hedge-witches of {city} found their old charms working.',
];

/** Industrial share, pollution mean on owned land and the weave target. Pure. */
export function weaveTarget(world) {
  if (!world.params.fading) return { target: 1, poll: 0, ind: 0, co2: fin(world.climate?.co2, 280) };
  const { f, N } = world;
  let s = 0, n = 0;
  for (let i = 0; i < N; i += 16) {
    if (f.water[i] !== WATER.LAND || f.owner[i] < 0) continue;
    s += f.pollution[i]; n++;
  }
  const poll = n ? s / n : 0;
  const civs = liveCivs(world);
  const ind = civs.length ? civs.filter((c) => fin(c.tech?.era, 0) >= 6).length / civs.length : 0;
  const co2 = fin(world.climate?.co2, 280);
  const t = 1 - 0.55 * clamp01((co2 - 300) / 400) - 0.6 * clamp01(poll / 0.2) - 0.2 * ind;
  return { target: Math.max(0.15, Math.min(1, t)), poll, ind, co2 };
}

/** Where to set a fading entry: the greatest industrial city, and the most famous node. */
function scene(world) {
  let city = null;
  for (const s of world.settlements) {
    if (!s || !s.alive) continue;
    const civ = world.civs[s.civId];
    const sc = fin(s.population) * (1 + 2 * fin(civ?.mods?.industry, 0));
    if (!city || sc > city.sc) city = { s, sc };
  }
  let node = null;
  for (const n of leyNodes(world)) if (!node || fin(n.fame) > fin(node.fame)) node = n;
  return { city: city?.s || null, node };
}

/** Yearly: move the weave, chronicle thresholds, and weigh on magic-heavy realms. */
export function fadingYearly(world) {
  const st = world.sys.myth;
  const fd = st.fade;
  const { target } = weaveTarget(world);
  const prev = fin(st.weave, 1);
  const next = Math.max(0.15, Math.min(1, prev + (target - prev) * 0.03));
  st.weave = Math.round(next * 10000) / 10000;
  if (st.weave < fd.min) fd.min = st.weave;
  const y = yearOfDay(world.time.day);
  for (const m of MARKS) {
    if (prev >= m.at && st.weave < m.at && fd.marks[m.at] == null) {
      fd.marks[m.at] = world.time.day;
      fd.returned = false;
      const { city, node } = scene(world);
      record(world, {
        imp: m.imp, key: m.key, tags: ['fading'],
        text: fill(pickT(world.rng, m.texts), { y, city: city ? city.name : 'the great cities', node: node ? node.name : 'the old stones' }),
        x: node ? node.x : city?.x, y: node ? node.y : city?.y, sid: city?.id ?? null, civId: city?.civId ?? null,
        ref: node ? { k: 'site', id: node.id } : city ? { k: 'settlement', id: city.id } : null,
      });
    }
  }
  if (!fd.returned && fd.min < 0.7 && st.weave >= fd.min + 0.3) {
    fd.returned = true;
    fd.marks = {};
    const { city, node } = scene(world);
    record(world, {
      imp: 4, key: 'myth.fading.return', tags: ['fading'],
      text: fill(pickT(world.rng, RETURN), { y, city: city ? city.name : 'the old cities', node: node ? node.name : 'the old stones' }),
      x: node?.x, y: node?.y, ref: node ? { k: 'site', id: node.id } : null,
    });
    fd.min = st.weave;
  }
  // realms that lean on the arts feel the weave thin
  const thin = 1 - st.weave;
  for (const civ of liveCivs(world)) {
    const arc = fin(civ.mods?.arcana, 0);
    const tgt = { kind: 'civ', id: civ.id };
    if (thin > 0.08 && arc >= 0.25) {
      addEffect(world, tgt, { k: 'myth.fading', until: world.time.day + DAYS_PER_YEAR + 30, m: { stability: -Math.round(0.05 * thin * Math.min(1.5, arc / 0.5) * 1000) / 1000 }, label: 'The weave is thinning' });
    } else if (civ.effects?.length && civ.effects.some((e) => e.k === 'myth.fading')) {
      removeEffect(world, tgt, 'myth.fading');
    }
  }
}

/** Short words for the weave (HUD, Legends). */
export function weaveWord(w) {
  return w >= 0.9 ? 'Strong' : w >= 0.75 ? 'Steady' : w >= 0.5 ? 'Thinning' : w >= 0.25 ? 'Failing' : 'Faded';
}
