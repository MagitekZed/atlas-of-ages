// War ledgers: the full story of every war, kept compact on the war itself (war.ledger), and
// the service record of every army (army.flags.l). Written by war.js; read by the Inspector's
// war and army views, the theatre map and the Hall of Records.
//
//   war.ledger = {
//     b: battles, oldest first (cap 64)
//        [day, x, y, winnerCivId, loserCivId, dead, name]  a named or sizeable engagement
//                                                         (name null when the fight was unnamed)
//        [day, n, dead]                                   the small fry of one month merged:
//                                                         n skirmishes, dead in all
//        Full: the smallest merged record goes first, then the smallest unnamed battle; named
//        battles are kept longest (the smallest of them goes only when nothing else is left).
//     t: towns that changed hands, oldest first (cap 48)
//        [day, sid, fromCivId, toCivId, code]   code 'cap' (stormed and taken), 'razed',
//                                              'ceded' (by treaty) or 'returned' (at the peace)
//     armies: service summaries of the armies that fought it (cap 12, largest first)
//        { name, gen, genId, civ, raised, peak, bat, won, dead, inflicted, battle, attr, sick,
//          band, beast, dist, caps, fate, from, to }
//   }
//   army.flags.l = { raised, peak, battles, won, dead, inflicted, attrition, sick, distance,
//                    captures }   distance in tiles; dead counts men lost in battle (the kernel's
//                                 flags.loss splits every loss by cause)
//
// Worlds saved before ledgers existed rebuild them from war.geo.log (the last battles the war
// module kept) and war.captured. Everything here is plain JSON and draws no rng.

import { DAYS_PER_MONTH } from '../../core/constants.js';
import { touchRecord } from '../../core/keyframe.js';

const MAX_BATTLES = 64;
const MAX_TRANSFERS = 48;
const MAX_ARMIES = 8;
/** An unnamed engagement with at least this many dead keeps its own record and place. */
export const SIZEABLE_DEAD = 100;

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const month = (day) => Math.floor(day / DAYS_PER_MONTH);

/** The war's ledger, created (or rebuilt from an older save's battle log) on first use. */
export function ledgerOf(world, war) {
  if (!war) return null;
  const L = war.ledger;
  if (L && Array.isArray(L.b) && Array.isArray(L.t) && Array.isArray(L.armies)) return L;
  war.ledger = { b: [], t: [], armies: [] };
  touchRecord(world, war);   // (an ended war's record changes: keyframes copy it afresh)
  if (!L) rebuild(world, war);
  else {
    if (Array.isArray(L.b)) war.ledger.b = L.b;
    if (Array.isArray(L.t)) war.ledger.t = L.t;
    if (Array.isArray(L.armies)) war.ledger.armies = L.armies;
  }
  return war.ledger;
}

/** Old saves: the battles the war module remembered, and the towns its war took. */
function rebuild(world, war) {
  const L = war.ledger;
  const log = war.geo && Array.isArray(war.geo.log) ? war.geo.log : [];
  for (const e of log) {
    if (!e || !Number.isFinite(e.day)) continue;
    const skirmish = !e.name || /^a skirmish/i.test(String(e.name));
    if (skirmish && fin(e.dead) < SIZEABLE_DEAD) mergeSkirmish(L, e.day, fin(e.dead), 1);
    else L.b.push([e.day, fin(e.x), fin(e.y), e.winner ?? -1, e.loser ?? -1, Math.round(fin(e.dead)), skirmish ? null : String(e.name)]);
  }
  for (const sid of Array.isArray(war.captured) ? war.captured : []) {
    const s = world.settlements[sid];
    if (!s) continue;
    // the town's own chain of owners dates the change when it is still remembered
    let day = null, from = null;
    const own = Array.isArray(s.own) ? s.own : [];
    for (let k = own.length - 1; k >= 1; k--) {
      const d = own[k][0];
      if (d >= war.startDay && (war.endDay == null || d <= war.endDay + DAYS_PER_MONTH)) { day = d; from = own[k - 1][1]; break; }
    }
    const code = !s.alive && s.destroyCause === 'razed' ? 'razed' : 'cap';
    L.t.push([day ?? war.endDay ?? war.startDay, sid, from, code === 'razed' ? -1 : s.civId, code]);
  }
  trimBattles(L);
}

function mergeSkirmish(L, day, dead, n) {
  // merge into this month's skirmish record (always among the newest few)
  for (let k = L.b.length - 1; k >= 0 && k >= L.b.length - 4; k--) {
    const r = L.b[k];
    if (r.length === 3 && month(r[0]) === month(day)) { r[1] += n; r[2] = Math.round(r[2] + dead); return; }
    if (r[0] < day - DAYS_PER_MONTH) break;
  }
  L.b.push([day, n, Math.round(dead)]);
}

/** Drop the least memorable records until the battle list fits its cap. */
function trimBattles(L) {
  const b = L.b;
  while (b.length > MAX_BATTLES) {
    let k = -1, kd = Infinity;
    for (let j = 0; j < b.length; j++) if (b[j].length === 3 && b[j][2] < kd) { kd = b[j][2]; k = j; }
    if (k < 0) for (let j = 0; j < b.length; j++) if (b[j].length > 3 && b[j][6] == null && b[j][5] < kd) { kd = b[j][5]; k = j; }
    if (k < 0) for (let j = 0; j < b.length; j++) if (b[j][5] < kd) { kd = b[j][5]; k = j; }
    b.splice(k < 0 ? 0 : k, 1);
  }
}

/**
 * Record a battle of the war. rec: { day, x, y, winner, loser, dead, name|null, acct? }. Named
 * fights and sizeable ones keep their own record; the rest merge into the month's skirmish record.
 * acct (geo/battlefield.js): [ground, weather, the victor's plan, the beaten's, the moment,
 * prisoners], kept as the record's eighth entry.
 */
export function noteBattle(world, war, rec) {
  const L = ledgerOf(world, war);
  if (!L) return;
  touchRecord(world, war);
  const dead = Math.max(0, Math.round(fin(rec.dead)));
  if (!rec.name && dead < SIZEABLE_DEAD) mergeSkirmish(L, rec.day, dead, 1);
  else {
    const r = [rec.day, Math.round(fin(rec.x) * 10) / 10, Math.round(fin(rec.y) * 10) / 10, rec.winner ?? -1, rec.loser ?? -1, dead, rec.name ? String(rec.name) : null];
    if (Array.isArray(rec.acct)) r.push(rec.acct);
    L.b.push(r);
  }
  trimBattles(L);
}

/** Record a town changing hands. code: 'cap' | 'razed' | 'ceded' | 'returned'. */
export function noteTransfer(world, war, sid, from, to, code) {
  const L = ledgerOf(world, war);
  if (!L) return;
  touchRecord(world, war);   // (towns returned at the peace, armies home after it: the war may have ended)
  L.t.push([world.time.day, sid, from ?? null, to ?? null, code]);
  if (L.t.length > MAX_TRANSFERS) L.t.splice(0, L.t.length - MAX_TRANSFERS);
}

// ---------------------------------------------------------------------------
// Army service records

/** The army's service counters (created on first use; never replaces what is there). */
export function serviceOf(army) {
  const fl = army.flags && typeof army.flags === 'object' ? army.flags : (army.flags = {});
  let l = fl.l;
  if (!l || typeof l !== 'object') {
    const s0 = Math.round(fin(army.strength));
    l = fl.l = { raised: s0, peak: s0, battles: 0, won: 0, dead: 0, inflicted: 0, attrition: 0, sick: 0, distance: 0, captures: 0 };
  }
  return l;
}

/** After the strength changed upward (reinforcement): keep the peak. */
export function notePeak(army) {
  const l = serviceOf(army);
  const s = fin(army.strength);
  if (s > l.peak) l.peak = Math.round(s);
}

/** A loss already applied through the kernel's damageArmy, by source. */
export function noteLoss(army, n, src) {
  if (!(n > 0)) return;
  const l = serviceOf(army);
  if (src === 'battle') l.dead += n;
  else if (src === 'plague') l.sick += n;
  else if (src === 'attrition') l.attrition += n;
}

/** One fight: won or lost, and the enemy dead it accounts for. */
export function noteFight(army, won, inflicted) {
  const l = serviceOf(army);
  l.battles++;
  if (won) l.won++;
  l.inflicted += Math.max(0, fin(inflicted));
}

/** The army's summary for the war ledger. fate: why it left the field. */
export function armySummary(world, army, fate) {
  const l = serviceOf(army);
  const loss = army.flags.loss || {};
  const r = (v) => Math.round(fin(v));
  const gen = army.general && typeof army.general === 'object' ? army.general.name : typeof army.general === 'string' ? army.general : null;
  const out = {
    name: army.name || null, gen: gen || null, genId: army.flags.genId ?? null, civ: army.civId,
    raised: r(l.raised), peak: r(l.peak), bat: l.battles | 0, won: l.won | 0,
    dead: r(fin(loss.battle) + fin(loss.attrition) + fin(loss.plague) + fin(loss.band) + fin(loss.beast)),
    inflicted: r(l.inflicted), battle: r(loss.battle), attr: r(loss.attrition), sick: r(loss.plague), band: r(loss.band), beast: r(loss.beast),
    dist: r(l.distance), caps: l.captures | 0, fate: fate || null, from: army.createdDay ?? null, to: world.time.day,
  };
  // saved for every war ever fought: keep only what is not zero or empty (readers default them)
  for (const k of OPTIONAL_KEYS) if (out[k] === 0 || out[k] == null) delete out[k];
  return out;
}
const OPTIONAL_KEYS = ['gen', 'genId', 'bat', 'won', 'inflicted', 'battle', 'attr', 'sick', 'band', 'beast', 'dist', 'caps', 'fate'];

/** Archive an army leaving the field into its war's ledger (largest first, cap 12). */
export function archiveArmy(world, war, army, fate) {
  if (!war || !army) return null;
  const l = serviceOf(army);
  // a levy that never fought and barely marched is not worth a line
  if (!l.battles && !l.captures && (l.distance < 8 || fin(l.peak) < 200) && fin(army.strength) < 200) return null;
  const L = ledgerOf(world, war);
  touchRecord(world, war);   // (most armies stand down after their war has ended)
  const sum = armySummary(world, army, fate);
  L.armies.push(sum);
  L.armies.sort((p, q) => fin(q.peak) - fin(p.peak) || fin(q.bat) - fin(p.bat) || fin(p.from) - fin(q.from));
  // every war is saved for ever: a border feud keeps its three greatest hosts, a great war eight
  let dead = 0;
  if (war.casualties && typeof war.casualties === 'object') for (const k in war.casualties) dead += fin(war.casualties[k]);
  const keep = Math.min(MAX_ARMIES, dead >= 10000 ? 8 : dead >= 2000 ? 4 : 1);
  if (L.armies.length > keep) L.armies.length = keep;
  return sum;
}

/** Totals for reports and previews: { battles, named, skirmishes, dead, towns }. */
export function ledgerTotals(war) {
  const L = war && war.ledger;
  const out = { battles: 0, named: 0, skirmishes: 0, dead: 0, towns: 0 };
  if (!L) return out;
  for (const r of L.b) {
    if (r.length === 3) { out.skirmishes += r[1]; out.dead += r[2]; }
    else { out.battles++; out.dead += r[5]; if (r[6]) out.named++; }
  }
  out.towns = L.t.length;
  return out;
}
