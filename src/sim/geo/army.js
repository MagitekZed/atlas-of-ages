// Armies by company (chunk 2, docs/design/war-machine.md): what an army is made of, what it
// carries, and what that is worth against what it meets.
//
//   army.co = [[role, n, gear, q, xp, reg?] …]   at most one company per role, and regiments
//     role  SPEAR · BLADE · BOW (crossbows from tier 3, shot from 4) · LHORSE · HHORSE ·
//           ENG (engineers; guns from tier 4) · BEAST (Mythic war beasts)
//     n     men in it; the army's strength stays the sum, so every reader of strength keeps
//           working. A loss applied elsewhere (the kernel's damageArmy) is spread over the
//           companies at the next read (coSync)
//     gear  tier 0–6 (gearTier) · q  quality and condition 0.4–1.2 · xp  experience 0–1
//     reg   a standing regiment's id (raising.js)
//
// A realm's mix comes from its era, its knowledge, its land and its temper, or from the ext
// 'armyMix' (first; Mythic peoples answer for their own). Battle power is the sum over the
// companies of men × worth × gear against the enemy's × the match-up against the enemy's mix ×
// experience × quality; losses fall where the enemy was strong. Engineers speed a siege. No rng
// is drawn here.
//
// Exports: ROLE, NR, ROLE_NAMES, roleName, GEAR_NAMES, gearTier, gearQuality, mixFor, coFor, coSync,
//          coShares, coGear, forcePower, companyShares, coTake, siegeMul, hireMix

import { firstOf, hasProviders } from '../../core/ext.js';
import { BIOME } from '../../core/constants.js';
import { clamp, clamp01 } from '../../core/util.js';
import { eraOf, finite } from './common.js';

export const ROLE = { SPEAR: 0, BLADE: 1, BOW: 2, LHORSE: 3, HHORSE: 4, ENG: 5, BEAST: 6 };
export const NR = 7;

const BASE = [1.0, 1.1, 0.9, 1.4, 2.2, 0.4, 3.0];
// a row's worth against each enemy role (engineers fight at their base everywhere)
const MATCH = [
  //  spear blade  bow lhorse hhorse eng beast
  [1.0, 0.85, 0.8, 1.2, 1.45, 1, 1.2],    // spears
  [1.2, 1.0, 1.15, 0.9, 0.8, 1, 0.9],     // blades
  [1.2, 1.1, 1.0, 0.75, 0.85, 1, 1.1],    // bows
  [0.75, 1.0, 1.35, 1.0, 0.8, 1.2, 0.8],  // light horse
  [0.65, 1.3, 1.35, 1.15, 1.0, 1.2, 0.9], // heavy horse
  [1, 1, 1, 1, 1, 1, 1],                  // engineers
  [1.0, 1.2, 1.0, 1.2, 1.15, 1.2, 1.0],   // beasts
];
const GEAR_STEP = 1.18;   // × per tier above the enemy's average gear

export const GEAR_NAMES = ['stone and hide', 'bronze', 'iron', 'steel and mail', 'early guns and plate', 'rifles', 'modern arms'];
const ROLE_WORDS = [
  ['spearmen', 'spearmen', 'spearmen', 'spearmen', 'pikemen', 'riflemen', 'infantry'],
  ['warriors', 'swordsmen', 'swordsmen', 'men-at-arms', 'swordsmen', 'grenadiers', 'assault troops'],
  ['archers', 'archers', 'archers', 'crossbowmen', 'musketeers', 'riflemen', 'riflemen'],
  ['skirmishers', 'charioteers', 'light horse', 'light horse', 'light horse', 'cavalry', 'motor troops'],
  ['champions', 'chariots', 'heavy horse', 'knights', 'cuirassiers', 'dragoons', 'armour'],
  ['sappers', 'engineers', 'engineers', 'engineers', 'gunners', 'artillery', 'artillery'],
  ['war beasts', 'war beasts', 'war beasts', 'war beasts', 'war beasts', 'war beasts', 'war beasts'],
];
export const ROLE_NAMES = ROLE_WORDS.map((r) => r[2]);
/** A role's word at a gear tier: "crossbowmen", "knights", "artillery". */
export const roleName = (role, tier) => ROLE_WORDS[role]?.[clamp(tier | 0, 0, 6)] || 'soldiers';

const knows = (civ, id) => Boolean(civ && civ.tech && civ.tech.known && civ.tech.known[id] != null);

/** The best gear a realm can put in the field (GEAR_NAMES). */
export function gearTier(civ) {
  if (!civ) return 0;
  if (knows(civ, 'combustion')) return 6;
  if (knows(civ, 'chemistry') || knows(civ, 'railways')) return 5;
  if (knows(civ, 'gunpowder')) return 4;
  if (knows(civ, 'iron') && (knows(civ, 'feudalism') || knows(civ, 'engineering'))) return 3;
  if (knows(civ, 'iron')) return 2;
  if (knows(civ, 'bronze')) return 1;
  return 0;
}

/** How well its gear is made: its mines and its workshops (0.6–1.15). */
export function gearQuality(civ) {
  const m = civ && civ.mods ? civ.mods : null;
  const mining = m && finite(m.mining) ? m.mining : 1, prod = m && finite(m.production) ? m.production : 1;
  return clamp(0.85 + 0.15 * (prod - 1) + 0.12 * (mining - 1), 0.6, 1.15);
}

const ERA_MIX = [
  // spear blade  bow lhorse hhorse  eng beast
  [0.55, 0.15, 0.30, 0, 0, 0, 0],
  [0.45, 0.20, 0.25, 0.08, 0.02, 0, 0],
  [0.35, 0.25, 0.20, 0.13, 0.05, 0.02, 0],
  [0.30, 0.30, 0.15, 0.12, 0.08, 0.05, 0],
  [0.30, 0.20, 0.20, 0.10, 0.15, 0.05, 0],
  [0.25, 0.10, 0.40, 0.10, 0.08, 0.07, 0],
  [0.06, 0.03, 0.62, 0.08, 0.06, 0.15, 0],
  [0.05, 0.03, 0.60, 0.07, 0.10, 0.15, 0],
];

/** The land a realm fights from: its towns' share on open plains, in forest, in the hills. */
function landOf(world, civ) {
  let open = 0, wood = 0, high = 0, n = 0;
  const f = world.f;
  for (const sid of civ.settlementIds) {
    const s = world.settlements[sid];
    if (!s || !s.alive) continue;
    n++;
    const b = f.biome[s.i];
    if (b === BIOME.STEPPE || b === BIOME.SAVANNA || b === BIOME.SHRUBLAND || b === BIOME.COLD_DESERT || b === BIOME.HOT_DESERT) open++;
    else if (b === BIOME.TEMPERATE_FOREST || b === BIOME.TAIGA || b === BIOME.RAINFOREST || b === BIOME.TEMPERATE_RAINFOREST || b === BIOME.TROPICAL_FOREST) wood++;
    if (f.elevation[s.i] >= 0.62 || b === BIOME.ALPINE) high++;
  }
  return n ? { open: open / n, wood: wood / n, high: high / n } : { open: 0, wood: 0, high: 0 };
}

const norm = (v) => { let t = 0; for (const x of v) t += x; if (!(t > 0)) return [1, 0, 0, 0, 0, 0, 0]; return v.map((x) => x / t); };

/**
 * A realm's army by role (shares summing to 1): the ext 'armyMix' when a provider answers
 * (a Mythic people's own way of war), else its era's mix bent by its knowledge, land and temper.
 */
export function mixFor(world, civ) {
  if (hasProviders('armyMix')) {
    const r = firstOf('armyMix', world, civ);
    // a people's own way of war brings its own mounts (wolves, ponies, elk), tamed or not
    if (Array.isArray(r) && r.length === NR) return norm(r.map((x) => Math.max(0, finite(x) ? x : 0)));
  }
  const era = clamp(eraOf(civ), 0, ERA_MIX.length - 1);
  const v = ERA_MIX[era].slice();
  const land = landOf(world, civ);
  const t = civ.traits || {};
  v[ROLE.LHORSE] *= 1 + 1.2 * land.open - 0.4 * land.wood;
  v[ROLE.HHORSE] *= (1 + 0.6 * land.open - 0.4 * land.wood) * (0.7 + 0.6 * (t.militarism ?? 0.5));
  v[ROLE.BOW] *= 1 + 0.5 * land.wood;
  v[ROLE.SPEAR] *= 1 + 0.4 * land.high;
  v[ROLE.BLADE] *= (1 + 0.3 * land.high) * (0.8 + 0.4 * (t.aggression ?? 0.5));
  if (!knows(civ, 'engineering') && !knows(civ, 'mathematics') && era < 5) v[ROLE.ENG] = 0;
  return horseless(civ, norm(v));
}

/** A people that has not tamed the horse fights on foot (its horse becomes spearmen and blades). */
function horseless(civ, v) {
  if (knows(civ, 'horseback') || knows(civ, 'wheel') || eraOf(civ) >= 3) return v;
  const h = v[ROLE.LHORSE] + v[ROLE.HHORSE];
  if (!(h > 0)) return v;
  const out = v.slice();
  out[ROLE.LHORSE] = 0; out[ROLE.HHORSE] = 0;
  out[ROLE.SPEAR] += h * 0.6; out[ROLE.BLADE] += h * 0.4;
  return out;
}

/** Free companies fight as professionals: blades, crossbows or shot, light horse, some pikes. */
export function hireMix() { return [0.15, 0.35, 0.3, 0.2, 0, 0, 0]; }

/** n men split by shares into companies (largest remainder, so the counts sum to n). */
export function coFor(n, shares, gear, q, xp) {
  const out = [];
  let left = Math.max(0, Math.round(n));
  const want = shares.map((s, r) => ({ r, v: s * left }));
  const base = want.map((w) => Math.floor(w.v));
  let rest = left - base.reduce((a, b) => a + b, 0);
  const order = want.map((w, k) => ({ k, f: w.v - base[k] })).sort((a, b) => b.f - a.f || a.k - b.k);
  for (const o of order) { if (rest <= 0) break; base[o.k]++; rest--; }
  for (let r = 0; r < NR; r++) if (base[r] > 0) out.push([r, base[r], gear, Math.round(q * 100) / 100, Math.round(xp * 100) / 100]);
  return out;
}

/** The army's companies, made from its realm when it has none, and kept summing to its strength. */
export function coSync(world, army) {
  const str = finite(army.strength) ? Math.max(0, army.strength) : 0;
  let co = army.co;
  if (!Array.isArray(co) || !co.length) {
    const civ = world.civs[army.civId];
    const merc = army.flags && army.flags.merc != null;
    co = army.co = coFor(str, merc ? hireMix() : civ ? mixFor(world, civ) : [1, 0, 0, 0, 0, 0, 0], civ ? gearTier(civ) : 0, merc ? 1 : civ ? gearQuality(civ) : 0.8, merc ? 0.4 : 0.1);
    return co;
  }
  let sum = 0;
  for (const c of co) sum += c[1];
  if (Math.abs(sum - str) < 0.5) return co;
  if (!(sum > 0)) { for (const c of co) c[1] = 0; if (co.length) co[0][1] = str; return co; }
  const k = str / sum;
  for (const c of co) c[1] *= k;
  return co;
}

/** Shares of the army by role (length NR). */
export function coShares(co) {
  const v = new Array(NR).fill(0);
  let t = 0;
  for (const c of co) { v[c[0]] += c[1]; t += c[1]; }
  if (t > 0) for (let r = 0; r < NR; r++) v[r] /= t;
  return v;
}

/** The army's average gear tier, by men. */
export function coGear(co) {
  let g = 0, t = 0;
  for (const c of co) { g += c[2] * c[1]; t += c[1]; }
  return t > 0 ? g / t : 0;
}

/**
 * What an army's companies are worth in a fight against `enemy` (its mix and gear), before
 * morale, supply, the general and the realm's doctrine. rf(role) is the ground and weather's
 * factor for a role (1 when absent).
 */
export function forcePower(co, enemyShares, enemyGear, rf = null) {
  let p = 0;
  for (const c of co) {
    const r = c[0], n = c[1];
    if (!(n > 0)) continue;
    let m = 0;
    for (let j = 0; j < NR; j++) if (enemyShares[j] > 0) m += enemyShares[j] * MATCH[r][j];
    if (!(m > 0)) m = 1;
    const gear = Math.pow(GEAR_STEP, c[2] - enemyGear);
    const xp = 1 + 0.35 * clamp01(c[4]);
    p += n * BASE[r] * m * gear * xp * clamp(c[3], 0.4, 1.2) * (rf ? rf(r) : 1);
  }
  return p;
}

/** Each company's share of the army's power against an enemy (forcePower's terms, summing to 1). */
export function companyShares(co, enemyShares, enemyGear) {
  const out = co.map((c) => forcePower([c], enemyShares, enemyGear));
  const t = out.reduce((x, y) => x + y, 0);
  return t > 0 ? out.map((x) => x / t) : out;
}

/**
 * Take n men from the army's companies, most from those the enemy was strong against (a battle
 * loss, enemyShares given), or evenly (enemyShares null). Updates army.co; strength is the
 * caller's (damageArmy). Returns the men taken by role (length NR).
 */
export function coTake(co, n, enemyShares = null) {
  const by = new Array(NR).fill(0);
  if (!(n > 0) || !co.length) return by;
  const w = co.map((c) => {
    if (!enemyShares) return c[1];
    let m = 0;
    for (let j = 0; j < NR; j++) if (enemyShares[j] > 0) m += enemyShares[j] * MATCH[j][c[0]];
    return c[1] * (m > 0 ? m : 1);
  });
  let left = n;
  for (let pass = 0; pass < 3 && left > 1e-6; pass++) {
    let tw = 0;
    for (let k = 0; k < co.length; k++) if (co[k][1] > 0) tw += w[k];
    if (!(tw > 0)) break;
    let took = 0;
    for (let k = 0; k < co.length; k++) {
      if (!(co[k][1] > 0)) continue;
      const t = Math.min(co[k][1], left * w[k] / tw);
      co[k][1] -= t; by[co[k][0]] += t; took += t;
    }
    left -= took;
  }
  return by;
}

/**
 * × on an army's siege work from its engineers, against the share usual in its era: an ordinary
 * army sieges as before, one with more sappers (a dwarf host) faster, one with none slower.
 */
export function siegeMul(co, era) {
  const s = coShares(co)[ROLE.ENG];
  const norm = ERA_MIX[clamp(era | 0, 0, ERA_MIX.length - 1)][ROLE.ENG];
  return clamp((1 + 4 * s) / (1 + 4 * norm), 0.75, 1.4);
}
