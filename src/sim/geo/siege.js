// Sieges and walls (chunk 6, docs/design/sieges-and-walls.md): what a town's walls are made of
// and in what state, the stores it lays by against a siege, and what the besieger presses each
// day. war.js siegeTick calls siegeStep with the lines' power and the town's hold; the outcome
// (a storming, a surrender, a betrayal) goes back to war.js capture.
//
//   s.wall = { c, tw, mo, cit, br, st, n }   condition 0–1, towers 0–4, moat (0 none, 1 dug,
//            2 water: a river, a marsh, the sea), a citadel, a breach not yet mended (0/1),
//            siege stores laid by (months of food for the town), the ground (bits: 1 a hill,
//            2 a crag, 4 a river, 8 a marsh, 16 the sea), made at the first read
//   s.siege also keeps { s0, br, mine, hun, as, lost, m, mined, by }: the lead army's strength at
//            the start, whether the walls are breached, a mine's progress, the town's hunger,
//            assaults made, men lost in them, the method now pressed, a mine sprung, a gate bought
//
// The wall's type stays s.buildings.walls (0 none, 1 palisade, 2 stone walls, 3 castle, 4 star
// fort; a people's own names through the ext 'wallKind'). Engines (engineers × the realm's siege
// knowledge; guns × 4 against walls built before them) wear the condition down; a breach opens
// below 0.4; a mine (not through rock or water) opens one at once. A town eats its food, then its
// stores; once both are gone it starves and, unless its people never yield ('surrenderRule'),
// surrenders on terms. Monthly the besieger may storm the breach or (bold) the walls, the town
// may sally, a mine may be found, a gate may be opened by a traitor or bought.
//
// Monthly over walled towns (wallsMonthly): mending while paid for, neglect in arrears, stores
// laid by while the realm is at war (paid from the town's wealth) and sold off in peace.
// Draws from world.rng in siegeStep (monthly choices) and wallsMonthly (none).

import { firstOf, hasProviders } from '../../core/ext.js';
import { BIOME, WATER } from '../../core/constants.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// per type: base strength against assault, resistance to engines (days × 30 at engines of worth 1),
// stores laid by in war (months), towers to start with
export const WALL = [
  { bs: 0, res: 0, store: 0, tw: 0 },
  { bs: 1, res: 3, store: 1, tw: 0 },     // palisade
  { bs: 2.2, res: 12, store: 3, tw: 1 },  // stone walls
  { bs: 3.2, res: 28, store: 5, tw: 2 },  // castle
  { bs: 3.8, res: 60, store: 6, tw: 4 },  // star fort
];
export const WALL_NAMES = ['Open', 'Palisade', 'Stone Walls', 'Castle', 'Star Fort'];
const BREACH = 0.4;

/** A people's walls (ext 'wallKind'): { names?: [4], res?: ×, mend?: ×, burn?: bool, water?: bool, noMine?: bool }. */
export function wallKind(world, civ) {
  const own = hasProviders('wallKind') ? firstOf('wallKind', world, civ) : null;
  return own && typeof own === 'object' ? own : null;
}
/** The name of a town's walls in its people's words ("Stone Walls", "Thorn-wall"). */
export function wallName(world, s) {
  const lv = fin(s && s.buildings && s.buildings.walls);
  const k = wallKind(world, world.civs[s.civId]);
  return (k && k.names && k.names[lv - 1]) || WALL_NAMES[lv] || 'Walls';
}

/** The ground a town stands on: bits 1 hill, 2 crag, 4 river, 8 marsh, 16 sea. */
function groundOf(world, s) {
  const f = world.f, W = world.W, H = world.H;
  const i = s.y * W + s.x;
  let n = 0, lo = Infinity, sea = false, river = false, wet = 0;
  const e0 = fin(f.elevation[i]);
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const j = y * W + x;
    if (f.water[j] !== WATER.LAND) { if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) sea = true; continue; }
    lo = Math.min(lo, fin(f.elevation[j]));
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
      if (f.river && f.river[j]) river = true;
      if (f.biome && f.biome[j] === BIOME.WETLAND) wet++;
    }
  }
  const rise = Number.isFinite(lo) ? e0 - lo : 0;
  if (rise >= 0.025 || e0 >= 0.62) n |= 1;
  if (rise >= 0.06 || e0 >= 0.72) n |= 2;
  if (river) n |= 4;
  if (wet >= 4) n |= 8;   // a town in the marsh, not beside one
  if (sea || s.coastal) n |= 16;
  return n;
}

/** The town's walls record, made at the first read (old saves, new walls). */
export function wallOf(world, s) {
  if (!s) return null;
  const lv = fin(s.buildings && s.buildings.walls);
  let w = s.wall;
  if (!w || typeof w !== 'object') {
    const n = groundOf(world, s);
    const civ = world.civs[s.civId];
    const k = wallKind(world, civ);
    const tier = fin(s.tier);
    w = s.wall = {
      c: 1, tw: Math.min(4, WALL[lv].tw + (lv >= 2 ? Math.floor(tier / 3) : 0)),
      mo: n & (8 | 16) || (k && k.water) ? 2 : n & 4 || lv >= 4 || (lv >= 3 && tier >= 4) ? 1 : 0,
      cit: lv >= 3 || (lv >= 2 && civ && civ.capitalId === s.id) ? 1 : 0, br: 0, st: 0, n, lv,
    };
  } else if (w.lv !== lv) {
    // new walls raised (or old ones torn down): fresh, with what the new kind brings
    if (lv > fin(w.lv)) { w.c = 1; w.br = 0; w.tw = Math.max(fin(w.tw), WALL[lv].tw); if (lv >= 3) w.cit = 1; if (lv >= 4 && !w.mo) w.mo = 1; }
    w.lv = lv;
  }
  return w;
}

/** How strongly the walls stand against an assault (0 open … about 6 a great castle on a crag). */
export function wallStand(world, s, breached) {
  const w = wallOf(world, s);
  const lv = fin(s.buildings && s.buildings.walls);
  if (!lv) return 0;
  const hill = w.n & 2 ? 1.5 : w.n & 1 ? 1.25 : 1;
  return WALL[lv].bs * (breached ? 0.3 : Math.max(0.25, w.c)) * (1 + 0.12 * fin(w.tw)) * hill * (w.cit ? 1.15 : 1) * (w.mo && !breached ? 1.15 : 1);
}

/** A people's way of siegecraft (ext 'siegeCraft'): multipliers on storming, escalade, mining, patience. */
export function craftOf(world, civ) {
  const own = hasProviders('siegeCraft') ? firstOf('siegeCraft', world, civ) : null;
  return { storm: 1, escalade: 1, mine: 1, ...(own && typeof own === 'object' ? own : {}) };
}
/** How readily a starving town yields (ext 'surrenderRule'): 0 never, 1 the usual, 2 readily; spare: terms always kept. */
export function surrenderOf(world, civ) {
  const own = hasProviders('surrenderRule') ? firstOf('surrenderRule', world, civ) : null;
  return own && typeof own === 'object' ? { mul: fin(own.mul, 1), spare: Boolean(own.spare) } : { mul: 1, spare: false };
}

/** Months of food a walled town lays by against a siege, by its walls, wealth, seat and granary. */
export function storeTarget(world, s, civ) {
  const lv = fin(s.buildings && s.buildings.walls);
  if (!lv) return 0;
  const rich = 0.6 + 0.2 * Math.min(6, fin(s.tier)) + Math.min(0.6, fin(s.tradeIncome) / Math.max(50, fin(s.population)) * 20);
  const cap = civ && civ.capitalId === s.id ? 1.5 : 1;
  const gran = 1 + 0.25 * fin(s.buildings && s.buildings.granary);
  return Math.min(14, WALL[lv].store * rich * cap * gran);
}

/**
 * Monthly over the walled towns: walls mend while their realm pays (faster for walls that mend
 * themselves), crumble a little in arrears, and a breach closes once mended past 0.6; stores are
 * laid by while the realm is at war (a month's worth a month, paid from the town's wealth at the
 * grain price), and sold off or spoiled in peace (3 % a month).
 */
export function wallsMonthly(world, atWar) {
  for (const s of world.settlements) {
    if (!s || !s.alive) continue;
    const lv = fin(s.buildings && s.buildings.walls);
    if (!lv && !s.wall) continue;
    const w = wallOf(world, s);
    if (!lv) { w.st = 0; continue; }
    const civ = world.civs[s.civId];
    if (!s.siege) {
      const k = wallKind(world, civ);
      const paid = !civ || fin(civ.treasury) >= 0;
      if (paid) w.c = Math.min(1, w.c + 0.008 * (k && k.mend ? k.mend : 1));
      else w.c = Math.max(0.2, w.c - 0.004);
      if (w.br && w.c >= 0.6) w.br = 0;
    }
    const want = civ && atWar.has(civ.id) ? storeTarget(world, s, civ) : 0;
    if (w.st < want && !s.siege) {
      const cost = Math.max(1, fin(s.population)) / 40;   // a month's grain at settlement.js's price
      const n = Math.min(1, want - w.st, fin(s.wealth) > 0 ? fin(s.wealth) / cost : 0);
      if (n > 0) { w.st += n; s.wealth -= n * cost; }
    } else if (!want && w.st > 0) w.st = w.st * 0.97 < 0.05 ? 0 : Math.round(w.st * 0.97 * 1000) / 1000;
  }
}

/**
 * A siege has ended: is it one to remember? A year and a half or more, many thousands lost before
 * the walls, or a great capital taken after half a year. Named "the Siege of X" (the Second, the Third … at the same
 * town), "the Great Siege of X" when it outlasts every famous siege before it (and ran two
 * years). Kept in sys.war.famous (cap 200). Returns the record or null.
 */
export function famousSiege(world, s, attId, defId, outcome, how, days, lost) {
  const st = (world.sys.war ||= {});
  const def = world.civs[defId];
  const taken = outcome === 'captured' || outcome === 'razed';
  const isCap = Boolean(def && def.capitalId === s.id);
  if (!(days >= 540 || lost >= 5000 || (isCap && taken && days >= 180 && fin(s.tier) >= 3))) return null;
  const list = (st.famous ||= []);
  let prior = 0, longest = 0;
  for (const f of list) { if (f.sid === s.id) prior++; if (f.days > longest) longest = f.days; }
  const great = days >= 720 && days > longest;
  const ord = ['', 'Second ', 'Third ', 'Fourth ', 'Fifth ', 'Sixth '][prior];
  const name = great ? `the Great Siege of ${s.name}` : `the ${ord ?? 'Last '}Siege of ${s.name}`;
  const day = world.time.day;
  const rec = { sid: s.id, name, start: day - days, end: day, outcome, how: how || null, att: attId, def: defId ?? null, days, lost: Math.round(lost || 0) };
  list.push(rec);
  if (list.length > 200) list.splice(0, list.length - 200);
  return rec;
}

/** The walls are torn down (a conqueror slights them): a town open again. */
export function slight(world, s) {
  if (!s || !s.buildings) return;
  s.buildings.walls = 0;
  const w = wallOf(world, s);
  if (w) { w.lv = 0; w.c = 1; w.br = 0; w.st = 0; w.tw = 0; w.cit = 0; if (w.mo === 1) w.mo = 0; }
}

export { BREACH };
