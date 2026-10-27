// How armies are raised, and what they cost (chunk 2, docs/design/war-machine.md).
//
//   civ.forces = { sys, since, cand, candN, arrears, regs, vets, deserted }
//     sys      levy · feudal · standing · hired
//     cand     the way the realm leans toward, and candN the years running it has (a reform
//              needs three)
//     arrears  months running its treasury has stood below nothing after its expenses
//     regs     its standing regiments [{ id, name, role, n, gear, q, xp, founded, battles, won,
//              honours, out, levy, levyDay }] (out: the army it serves in while deployed; levy:
//              the shape of its men, who live out of the towns while they serve)
//     vets     veterans home from its wars (regiments.js), deserted  men who walked home this war
//
// Yearly, in the realm's month, it weighs its way of raising armies (the ext 'armySystem' may
// answer): tribes and the early ages raise a levy; feudal crowns a feudal host; a realm that has
// learned the drill of legions or of guns, fights often and can pay keeps a standing army; a
// merchant state hires. Held three years running, a new way is a reform.
//
// Every month the realm's bill (its armies in the field, its standing regiments, a share for its
// garrisons) reaches the civ module's treasury through the ext 'upkeep' (sum), so it counts in
// its expenses and chunk 3's borrowing sees it. A soldier's pay is a share of what the realm takes
// in per subject (PAY_K × income per head, × the ext 'armyPay'), so rich and poor realms alike
// feel a war (the user's choice: an average treasury carries a full war for three to five
// years). A realm whose treasury stands below nothing is in arrears: its armies lose heart, its
// levies drift home, and a standing army may overthrow its ruler (the armyCoup hook, answered by
// civ/rulers.js).
//
// A standing realm keeps regiments at peace, filled from its young men as its budget allows
// (about a fifth of its income), and sends them out first when war comes (war.js mobilize).
//
// Exports: forcesOf, soldierPay, armyBill, deployRegiments, regimentsHome, raisingMonthly,
//          SYS_WORDS, MAX_REGS

import { chronicle } from '../../core/chronicle.js';
import { emit } from '../../core/hooks.js';
import { liveCivs, damageArmy } from '../../core/entities.js';
import { registerProvider, firstOf, mulOf, hasProviders } from '../../core/ext.js';
import { takePeople, sliceLike, roundSlice, returnLevy } from '../../core/cohorts.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH } from '../../core/constants.js';
import { clamp, clamp01 } from '../../core/util.js';
import { civName, capFirst, capitalOf, townsOf, eraOf, hashPick, rateOk, rulerHas, finite } from './common.js';
import { govFamily } from './diplomacy.js';
import { mixFor, gearTier, gearQuality, coSync, NR } from './army.js';
import { regimentName, noteFirstRegiment, drill } from './regiments.js';

// A levied soldier's month costs what PAY_K of the realm's subjects pay in a month.
const PAY_K = 30;
const STANDING_SHARE = 0.2;    // of its income a standing realm spends on its regiments at peace
export const MAX_REGS = 12;
const FIELD = { levy: 1, feudal: 0.6, standing: 1, hired: 1 };

export const SYS_WORDS = { levy: 'a levy of its people', feudal: 'a feudal host', standing: 'a standing army', hired: 'hired swords' };

/** The realm's war footing, made when first asked (quietly, with no reform). */
export function forcesOf(world, civ) {
  if (civ.forces && typeof civ.forces === 'object') return civ.forces;
  const sys = chooseSystem(world, civ);
  civ.forces = { sys, since: world.time.day, cand: sys, candN: 0, arrears: 0, regs: [], vets: 0, deserted: 0 };
  return civ.forces;
}

/** A levied soldier's monthly pay in this realm: a share of what it takes in per subject. */
export function soldierPay(world, civ) {
  const perHead = (finite(civ.income) && civ.income > 0 ? civ.income : 0) / Math.max(1, civ.population || 0);
  const ext = hasProviders('armyPay') ? mulOf('armyPay', world, civ) : 1;
  return PAY_K * perHead * ext;
}

const isHunt = (a) => Boolean(a.flags && a.flags.hunt != null);
const isMerc = (a) => Boolean(a.flags && a.flags.merc != null);

/** The realm's bill this month: its armies in the field, its regiments at home, its garrisons. */
export function armyBill(world, civ) {
  const f = civ.forces;
  if (!f) return 0;
  const w = soldierPay(world, civ);
  if (!(w > 0)) return 0;
  const field = FIELD[f.sys] ?? 1;
  let men = 0;
  for (const a of world.armies) {
    if (a.civId !== civ.id || isHunt(a) || isMerc(a)) continue;
    const co = Array.isArray(a.co) ? a.co : null;
    if (!co) { men += (a.strength || 0) * field; continue; }
    for (const c of co) men += c[1] * (c[5] != null ? 2 : field);
  }
  for (const r of f.regs) if (r.out == null) men += 2 * r.n;
  let gar = 0;
  for (const sid of civ.settlementIds) { const s = world.settlements[sid]; if (s && s.alive) gar += s.garrison || 0; }
  return w * (men + 0.1 * gar);
}

// the civ module's treasury adds this to the realm's expenses (civmonth.js)
registerProvider('upkeep', 'geo.raising', (world, civ) => (civ && civ.forces ? armyBill(world, civ) : 0));

// ---------------------------------------------------------------------------
// The way a realm raises its armies

const knows = (civ, id) => Boolean(civ.tech && civ.tech.known && civ.tech.known[id] != null);

function chooseSystem(world, civ) {
  if (hasProviders('armySystem')) {
    const r = firstOf('armySystem', world, civ);
    if (r === 'levy' || r === 'feudal' || r === 'standing' || r === 'hired') return r;
  }
  const era = eraOf(civ);
  const fam = govFamily(civ.government);
  if (era <= 1 || fam === 'tribal' || civ.government === 'horde') return 'levy';
  if (era >= 6) return 'standing';
  const t = civ.traits || {};
  const st = world.sys.war || {};
  const life = (st.liveMonths && st.liveMonths[civ.id]) || 0;
  const fought = life >= 240 ? ((st.warMonths && st.warMonths[civ.id]) || 0) / life : 0.2;
  const rich = (civ.income || 0) > 0 && (civ.treasury || 0) > 6 * (civ.income || 0);
  if ((civ.government === 'merchant' || (fam === 'republic' && (t.commerce ?? 0.5) > 0.6)) && era >= 3) return 'hired';
  if ((knows(civ, 'tactics') || knows(civ, 'gunpowder')) && fought >= 0.2 && rich && (civ.government !== 'feudal' || knows(civ, 'gunpowder'))) return 'standing';
  if (knows(civ, 'feudalism') && (civ.government === 'feudal' || civ.government === 'kingdom' || civ.government === 'empire')) return 'feudal';
  return 'levy';
}

const REFORM_TEXT = {
  standing: (c) => [`${capFirst(civName(c))} raised a standing army of paid soldiers, drilled and ready in peace as in war.`, `No longer content with levies, ${civName(c)} kept soldiers under arms in time of peace.`],
  feudal: (c) => [`The lords of ${civName(c)} owed their crown service in arms, and its wars were fought by a feudal host.`, `${capFirst(civName(c))} came to raise its armies from its lords and their retinues.`],
  hired: (c) => [`${capFirst(civName(c))} came to trust its wars to hired swords.`, `The merchants of ${civName(c)} found it cheaper to buy soldiers than to raise them.`],
  levy: (c) => [`${capFirst(civName(c))} gave up its army and went back to raising levies when war came.`, `The standing army of ${civName(c)} was paid off, and its wars were left to levies.`],
};

function weighSystem(world, civ, f) {
  const want = chooseSystem(world, civ);
  if (want === f.sys) { f.cand = want; f.candN = 0; return; }
  if (want !== f.cand) { f.cand = want; f.candN = 1; return; }
  if (++f.candN < 3) return;
  const was = f.sys;
  f.sys = want; f.since = world.time.day; f.candN = 0;
  if (was === 'standing') for (const r of f.regs.slice()) if (r.out == null) disbandRegiment(world, civ, f, r, 'reform');
  const cap = capitalOf(world, civ);
  const big = (civ.settlementIds.length >= 10);
  if (rateOk(world, `reform:${civ.id}`, 20 * DAYS_PER_YEAR)) {
    chronicle(world, {
      cat: 'civ', imp: big ? 3 : 2, x: cap ? cap.x : null, y: cap ? cap.y : null, civId: civ.id, sid: cap ? cap.id : null, icon: 'army', key: 'army.reform', ref: { k: 'civ', id: civ.id }, tags: ['army', want],
      text: hashPick(REFORM_TEXT[want](civ), civ.id, world.time.day),
    });
  }
}

// ---------------------------------------------------------------------------
// Standing regiments

/** Recruit or trim the regiments toward what the realm can pay at peace (a fifth of its income). */
function keepRegiments(world, civ, f, atWar) {
  const w = soldierPay(world, civ);
  if (!(w > 0)) return;
  const want = Math.max(0, STANDING_SHARE * (civ.income || 0) / (2 * w));
  let have = 0;
  for (const r of f.regs) have += r.n;
  if (have > want * 1.25 && !atWar) {
    // cut the weakest regiment at home
    let weak = null;
    for (const r of f.regs) if (r.out == null && (!weak || r.n < weak.n)) weak = r;
    if (weak) disbandRegiment(world, civ, f, weak, 'cost');
    return;
  }
  if (have >= want || f.arrears > 0) return;
  // recruit a twelfth of the gap a month from the young men, into the role the realm lacks most
  const towns = townsOf(world, civ);
  if (!towns.length) return;
  const n = Math.min(want - have, Math.max(10, want / 12));
  const mix = mixFor(world, civ);
  const byRole = new Array(NR).fill(0);
  for (const r of f.regs) byRole[r.role] += r.n;
  let role = 0, gap = -Infinity;
  for (let k = 0; k < NR; k++) { const g = mix[k] * (have + n) - byRole[k]; if (mix[k] > 0 && g > gap) { gap = g; role = k; } }
  let reg = f.regs.find((r) => r.role === role && r.out == null && r.n < 2000);
  if (!reg) {
    if (f.regs.length >= MAX_REGS) return;
    f.nextReg = (f.nextReg || 0) + 1;
    reg = { id: f.nextReg, name: regimentName(world, civ, f, role), role, n: 0, gear: gearTier(civ), q: gearQuality(civ), xp: 0.2, founded: world.time.day, battles: 0, won: 0, honours: [], out: null, levy: null, levyDay: world.time.day };
    f.regs.push(reg);
    noteFirstRegiment(world, civ, reg);
  }
  const levy = sliceLike(towns[0]);
  const pop = towns.reduce((a, s) => a + s.population, 0);
  let got = 0;
  for (const s of towns) got += takePeople(world, s, Math.min(s.population * 0.05, n * s.population / Math.max(1, pop)), 'levy', levy, civ);
  if (!(got > 0)) return;
  reg.xp = (reg.xp * reg.n + 0.1 * got) / (reg.n + got);
  reg.n += got;
  reg.levy = roundSlice(levy);
  reg.levyDay = world.time.day;
  reg.gear = gearTier(civ); reg.q = gearQuality(civ);
}

/** A regiment leaves the realm's service: its men go home to the towns. */
function disbandRegiment(world, civ, f, reg, why) {
  const k = f.regs.indexOf(reg);
  if (k < 0) return;
  f.regs.splice(k, 1);
  const cap = capitalOf(world, civ);
  if (cap && reg.n > 0) returnLevy(world, cap, reg, reg.n);
  f.vets = (f.vets || 0) + reg.n * clamp01(reg.xp);
  emit(world, 'regimentDisbanded', civ, reg, why);
}

/**
 * War: the regiments at home march out together as one army's companies. Returns the companies
 * ([role, n, gear, q, xp, regId]) and their men, or null when none are home.
 */
export function deployRegiments(world, civ, armyId) {
  const f = civ.forces;
  if (!f || !f.regs.length) return null;
  const co = [];
  let men = 0;
  for (const r of f.regs) {
    if (r.out != null || !(r.n >= 1)) continue;
    r.out = armyId;
    co.push([r.role, r.n, Math.max(r.gear, gearTier(civ)), r.q, r.xp, r.id]);
    men += r.n;
  }
  return co.length ? { co, men } : null;
}

/**
 * An army leaves the field: its regiments come home with what is left of them, and regiments cut
 * down to a handful are gone. Returns the men of regiments in it (they do not go back to the towns).
 */
export function regimentsHome(world, army) {
  const civ = world.civs[army.civId];
  const f = civ && civ.forces;
  if (!f || !f.regs.length) return 0;
  let men = 0;
  const co = Array.isArray(army.co) ? coSync(world, army) : [];
  for (const r of f.regs.slice()) {
    if (r.out !== army.id) continue;
    const c = co.find((x) => x[5] === r.id);
    r.n = c ? c[1] : 0;
    if (c) { r.xp = c[4]; r.q = c[3]; }
    r.out = null;
    men += r.n;
    if (r.n < 20) { f.regs.splice(f.regs.indexOf(r), 1); emit(world, 'regimentLost', civ, r, army); }
  }
  return men;
}

// ---------------------------------------------------------------------------
// Monthly

/** Monthly, from war.js: the way of raising, arrears and their price, regiments at peace. */
export function raisingMonthly(world, st, atWar) {
  const rng = world.rng;
  const day = world.time.day;
  const month = Math.floor(day / DAYS_PER_MONTH);
  for (const civ of liveCivs(world)) {
    const f = forcesOf(world, civ);
    if ((civ.id + month) % 12 === 0) weighSystem(world, civ, f);
    const war = atWar.has(civ.id);
    if (!war) f.deserted = 0;
    f.arrears = (finite(civ.treasury) ? civ.treasury : 0) < 0 ? f.arrears + 1 : 0;
    if (f.arrears > 0) unpaid(world, st, civ, f);
    drill(f);
    if (f.sys === 'standing') { coupCheck(world, st, civ, f, rng); keepRegiments(world, civ, f, war); }
    else if (f.regs.length && !war) { const r = f.regs.find((x) => x.out == null); if (r) disbandRegiment(world, civ, f, r, 'reform'); }
  }
}

/** Unpaid: morale falls and levies drift home. */
function unpaid(world, st, civ, f) {
  const a = Math.min(3, f.arrears);
  for (const army of world.armies) {
    if (army.civId !== civ.id || isHunt(army) || isMerc(army)) continue;
    army.morale = clamp((finite(army.morale) ? army.morale : 1) - 0.05 * a, 0.05, 1.2);
    const co = coSync(world, army);
    let levy = 0;
    for (const c of co) if (c[5] == null) levy += c[1];
    // the levies wait two months for their pay, then drift home (1 % a month more each month, at most 3 %)
    const d = f.arrears >= 2 ? levy * Math.min(0.03, 0.01 * (f.arrears - 1)) : 0;
    if (!(d >= 1)) continue;
    const took = damageArmy(world, army, d, 'attrition');
    let left = took;
    for (const c of co) if (c[5] == null && left > 0) { const t = Math.min(c[1], took * c[1] / Math.max(1, levy)); c[1] -= t; left -= t; }
    const home = world.settlements[army.homeId];
    if (home && home.alive && home.civId === civ.id && army.flags) returnLevy(world, home, army.flags, took);
    f.deserted = (f.deserted || 0) + took;
    st.deserts = (st.deserts || 0) + took;
  }
  if (f.deserted > 500 && rateOk(world, `desert:${civ.id}`, 15 * DAYS_PER_YEAR)) {
    const cap = capitalOf(world, civ);
    chronicle(world, {
      cat: 'war', imp: 2, x: cap ? cap.x : null, y: cap ? cap.y : null, civId: civ.id, sid: cap ? cap.id : null, icon: 'army', key: 'army.desert', ref: { k: 'civ', id: civ.id }, tags: ['army'],
      text: hashPick([
        `Unpaid for months, the levies of ${civName(civ)} began to slip away home.`,
        `With its treasury empty, ${civName(civ)} watched its armies melt away for want of pay.`,
      ], civ.id, world.time.day),
    });
  }
}

/** A living great general of the realm whose ambition is power, or null. */
function powerSeeker(world, civ) {
  for (const id of (civ.flags && civ.flags.figs) || []) {
    const f = world.figures.find((o) => o.id === id);
    if (f && f.died == null && f.kind === 'general' && f.am && f.am.k === 'power' && world.time.day - f.am.since >= 3 * DAYS_PER_YEAR) return f;
  }
  return null;
}

/**
 * A standing army three months unpaid (0.6 % a month), or serving a realm in crisis (0.3 %), may
 * take power, more readily under a cruel or craven ruler, and never twice in twenty years.
 * civ/rulers.js answers the armyCoup hook.
 */
function coupCheck(world, st, civ, f, rng) {
  const unpaid = f.arrears >= 3, crisis = finite(civ.stability) && civ.stability < 0.25;
  if (!(unpaid || crisis) || !f.regs.some((r) => r.n > 0) || !civ.ruler) return;
  if (world.time.day - (finite(f.coupDay) ? f.coupDay : -1e9) < 20 * DAYS_PER_YEAR) return;
  let coup = unpaid ? 0.006 : 0.003;
  if (rulerHas(civ, 'cruel')) coup *= 1.6;
  if (rulerHas(civ, 'craven')) coup *= 1.3;
  // a great general who wants power (civ/ambitions.js) leads the soldiers' discontent (× 1.6;
  // one draw either way, and the realm's generals are looked over only when it might matter)
  const x = rng.next();
  if (x >= coup * 1.6) return;
  const gen = powerSeeker(world, civ);
  if (!gen && x >= coup) return;
  st.coups = (st.coups || 0) + 1;
  f.arrears = 0;
  f.coupDay = world.time.day;
  emit(world, 'armyCoup', civ, gen);
}
