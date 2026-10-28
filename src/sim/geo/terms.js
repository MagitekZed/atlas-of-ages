// War aims and peace terms (chunk 3, docs/design/why-wars.md): what each side fights for, and
// the hostages a peace leaves behind.
//
//   war.geo.aims = { a: aim, d: aim }   aim = { k, sids?, back?, rid?, civ? }
//     k     towns · crown · faith · tribute · subjugate · free · debt · humble · hold
//     sids  up to three goal towns (back: towns it claims, a war to win them back) · rid  a faith
//     civ   the crown sought
//   world.sys.diplomacy.hostages = [{ civ, at, name, since, until }]
//
// The attacker's aim follows its casus belli (AIM_OF); a casus belli from another package may
// name its own (cb.aim), and the ext 'warAim' (first) may replace any. The defender holds its
// own, or fights for the towns it claims of the attacker (claims.js). war.js asks aimMet in its
// monthly peace talks and writes the terms from the winner's aim (makePeace); the ext
// 'peaceTerms' (first) may forbid a term to a pair. This module keeps the hostages: an heir held
// at the victor's court keeps its realm from attacking (war.js), dies if it does, comes home to
// be crowned, or returns when the truce ends, fond of the court that raised it.
//
// Exports: AIM_KINDS, aimFor, defenderAim, aimsFromCause, aimMet, winnerAim, aimWords,
//          peaceAllows, takeHostage, hostageHeld, killHostage, hostagesOf, hostagesMonthly

import { chronicle } from '../../core/chronicle.js';
import { on } from '../../core/hooks.js';
import { addOpinion, rel } from '../../core/entities.js';
import { firstOf, hasProviders } from '../../core/ext.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { claimedTowns } from './claims.js';
import { faithOf } from './religion.js';
import { kinDied, syncHeir } from '../civ/kin.js';
import { civName, capFirst, capitalOf, listJoin, hashPick, rateOk, finite } from './common.js';

export const AIM_KINDS = new Set(['towns', 'crown', 'faith', 'tribute', 'subjugate', 'free', 'debt', 'humble', 'hold']);

const AIM_OF = {
  reconquest: 'towns', border: 'towns', resource: 'towns', prophecy: 'towns', relic: 'towns', witchstone: 'towns', restoration: 'towns',
  holy: 'faith', succession: 'crown', claim: 'crown', 'civil war': 'crown',
  trade: 'tribute', opportunism: 'tribute',
  revenge: 'humble', enmity: 'humble', provocation: 'humble',
  liberation: 'free', independence: 'free', debt: 'debt',
  league: 'humble', dread: 'humble', blight: 'humble', cure: 'towns',
};

function cleanAim(x) {
  const aim = { k: x.k };
  if (Array.isArray(x.sids) && x.sids.length) aim.sids = x.sids.filter(Number.isFinite).slice(0, 3);
  if (x.rid != null) aim.rid = x.rid;
  if (x.civ != null) aim.civ = x.civ;
  if (x.back) aim.back = true;
  return aim;
}

/**
 * The attacker a's aim against b for casus belli cb ({ key, goalSid?, rid?, aim? }). goal is the
 * war's contested town (declare's goal); ratio is a's power over b's (with b's friends).
 */
export function aimFor(world, a, b, cb, goal = null, ratio = 1) {
  if (hasProviders('warAim')) {
    const x = firstOf('warAim', world, a, b, cb.key);
    if (x && AIM_KINDS.has(x.k)) return cleanAim(x);
  }
  let k = typeof cb.aim === 'string' && AIM_KINDS.has(cb.aim) ? cb.aim : AIM_OF[cb.key];
  if (!k) k = cb.key === 'conquest' ? (ratio >= 2.5 ? 'subjugate' : 'towns') : goal ? 'towns' : 'tribute';
  const aim = { k };
  if (k === 'towns') {
    const sids = [];
    if (goal && goal.alive && goal.civId === b.id) sids.push(goal.id);
    for (const q of claimedTowns(world, a, b, 3)) if (sids.length < 3 && !sids.includes(q.s.id)) sids.push(q.s.id);
    if (!sids.length) return { k: 'tribute' };
    aim.sids = sids;
    if (sids.some((sid) => a.landClaims && a.landClaims[sid])) aim.back = true;   // towns it lost: a war to win them back
  } else if (k === 'faith') {
    aim.rid = cb.rid ?? a.stateReligion ?? null;
    if (aim.rid == null) return { k: 'humble' };
    const hc = cb.goalSid != null ? world.settlements[cb.goalSid] : null;
    if (hc && hc.alive && hc.civId === b.id) aim.sids = [hc.id];
  } else if (k === 'crown') aim.civ = b.id;
  return aim;
}

/** The defender d's aim: the towns of the attacker a it claims, or to hold its own. */
export function defenderAim(world, d, a) {
  const sids = claimedTowns(world, d, a, 3).map((q) => q.s.id);
  return sids.length ? { k: 'towns', sids, back: true } : { k: 'hold' };
}

/** Aims for a war begun outside war.js's declarations (events, acts, the civ module). */
export function aimsFromCause(world, war, ratio = 1) {
  const a = world.civs[war.attackers[0]], d = world.civs[war.defenders[0]];
  if (!a || !d) return { a: { k: 'hold' }, d: { k: 'hold' } };
  const g = war.geo || {};
  const goal = g.goalSid != null ? world.settlements[g.goalSid] : null;
  return { a: aimFor(world, a, d, { key: war.cause || 'conquest', goalSid: g.goalSid, rid: g.rid }, goal, ratio), d: defenderAim(world, d, a) };
}

const lead = (world, ids) => { for (const id of ids) { const c = world.civs[id]; if (c && c.alive) return c; } return null; };

/**
 * Has the attacker what it went to war for? towns: it holds every goal town still standing
 * (or the first, the prize, with a score above 30);
 * tribute, humble, debt: the score has stood at 40 or more for a year (g.hiDay, war.js); subjugate:
 * a score of 60; free: 40; crown and faith: 55 with the defender's seat besieged or fallen.
 * Wars from before aims existed keep the old rule (the goal town held, a score above 15).
 */
export function aimMet(world, war, g, score) {
  const aim = g.aims && g.aims.a;
  if (!aim) return g.goalSid != null && score > 15 && war.attackers.includes(world.settlements[g.goalSid]?.civId);
  switch (aim.k) {
    case 'towns': {
      // every goal town still standing is held, or the first (the war's prize) with the upper hand
      let any = false, all = true, first = null;
      for (const sid of aim.sids || []) {
        const s = world.settlements[sid];
        if (!s || !s.alive) continue;
        any = true;
        const held = war.attackers.includes(s.civId);
        if (first == null) first = held;
        if (!held) all = false;
      }
      return any && ((all && score > 15) || (first && score > 30));
    }
    case 'tribute': case 'humble': case 'debt':
      return score >= 40 && g.hiDay != null && world.time.day - g.hiDay >= DAYS_PER_YEAR;
    case 'subjugate': return score >= 60;
    case 'free': return score >= 40;
    case 'crown': case 'faith': {
      if (score < 55) return false;
      const D = lead(world, war.defenders);
      if (!D) return true;
      if (finite(D.flags?.seatFallDay) && D.flags.seatFallDay >= war.startDay) return true;
      const cap = capitalOf(world, D);
      return Boolean(cap && cap.siege && war.attackers.includes(cap.siege.civId));
    }
    default: return false;
  }
}

/** The winning side's aim (null for a white peace, or a war from before aims). */
export function winnerAim(g, end) {
  const aims = g && g.aims;
  if (!aims) return null;
  return end === 'attackers' ? aims.a || null : end === 'defenders' ? aims.d || null : null;
}

/** An aim in words, for the war's dossier: "To win back Varn and Oskel", "The crown of Tessaly". */
export function aimWords(world, war, side) {
  const g = war.geo || {};
  const aim = g.aims ? (side > 0 ? g.aims.a : g.aims.d) : null;
  const foe = lead(world, side > 0 ? war.defenders : war.attackers) || world.civs[(side > 0 ? war.defenders : war.attackers)[0]];
  const F = foe ? civName(foe) : 'the enemy';
  if (!aim) return side > 0 && g.goalSid != null && world.settlements[g.goalSid] ? `To take ${world.settlements[g.goalSid].name}` : side > 0 ? '' : 'To hold its own';
  const names = (aim.sids || []).map((sid) => world.settlements[sid]).filter(Boolean).map((s) => s.name);
  switch (aim.k) {
    case 'towns': {
      if (!names.length) return `Land from ${F}`;
      return `To ${aim.back ? 'win back' : 'take'} ${listJoin(names)}`;
    }
    case 'crown': return `The crown of ${F}`;
    case 'faith': { const r = faithOf(world, aim.rid); return `To bring ${r ? r.name : 'its faith'} to ${F}${names.length ? ` and free ${names[0]}` : ''}`; }
    case 'tribute': return `Tribute from ${F}`;
    case 'humble': return `To humble ${F}`;
    case 'subjugate': return `To make ${F} its vassal`;
    case 'free': return `Freedom from ${F}`;
    case 'debt': return `To recover what ${F} owes`;
    default: return 'To hold its own';
  }
}

/** False when a provider forbids the victor this term against the loser. */
export function peaceAllows(world, winner, loser, term) {
  if (!hasProviders('peaceTerms')) return true;
  return firstOf('peaceTerms', world, winner, loser, term) !== false;
}

// ---------------------------------------------------------------------------
// Hostages

function hostageList(world) {
  const st = (world.sys.diplomacy ||= {});
  return (st.hostages ||= []);
}

/** The loser's heir goes to the victor's court for `years`. Returns the record, or null without an heir. */
export function takeHostage(world, loser, victor, years) {
  const h = loser.ruler && loser.ruler.heir;
  if (!h || !h.name || !peaceAllows(world, victor, loser, 'hostage')) return null;
  if (hostageList(world).some((q) => q.civ === loser.id)) return null;   // its heir is already held abroad
  const day = world.time.day;
  const rec = { civ: loser.id, at: victor.id, name: h.name, since: day, until: day + Math.round(years * DAYS_PER_YEAR) };
  hostageList(world).push(rec);
  return rec;
}

/** True while a hostage of realm civId is held at the court of atId. */
export function hostageHeld(world, civId, atId) {
  const hs = world.sys.diplomacy && world.sys.diplomacy.hostages;
  if (!hs || !hs.length) return false;
  for (const h of hs) if (h.civ === civId && h.at === atId) return true;
  return false;
}

/** Hostages held from or at realm civId (the realm dossier). */
export function hostagesOf(world, civId) {
  const hs = (world.sys.diplomacy && world.sys.diplomacy.hostages) || [];
  return hs.filter((h) => h.civ === civId || h.at === civId);
}

/**
 * Realm civId has gone to war on atId while its heir was held there: the heir is put to death.
 * Returns the record, or null. The line and the grievance are written here.
 */
export function killHostage(world, civId, atId, war = null) {
  const hs = hostageList(world);
  const k = hs.findIndex((h) => h.civ === civId && h.at === atId);
  if (k < 0) return null;
  const h = hs[k];
  hs.splice(k, 1);
  const a = world.civs[civId], b = world.civs[atId];
  if (!a || !b) return h;
  if (a.ruler && a.ruler.heir && a.ruler.heir.name === h.name) {
    if (a.ruler.heir.id != null) kinDied(world, a.ruler.heir.id, 'executed');
    a.ruler.heir = null;
    syncHeir(world, a);
  }
  const r = rel(world, civId, atId);
  r.grievance = Math.min(100, (r.grievance || 0) + 40);
  addOpinion(world, civId, atId, -30);
  const capB = capitalOf(world, b);
  chronicle(world, {
    cat: 'war', imp: 3, x: capB ? capB.x : null, y: capB ? capB.y : null, civId: atId, sid: capB ? capB.id : null, icon: 'war', key: 'hostage.killed',
    ref: war ? { k: 'war', id: war.id } : { k: 'civ', id: atId }, tags: ['hostage'],
    text: hashPick([
      `When ${civName(a)} broke the peace, ${civName(b)} put its hostage ${h.name} to death${capB ? ` in ${capB.name}` : ''}.`,
      `${capFirst(civName(a))} marched to war though its heir ${h.name} was held${capB ? ` in ${capB.name}` : ''}; the hostage paid with their life.`,
    ], civId, atId, h.since),
  });
  return h;
}

/** Monthly, from diplomacy: hostages whose truce has run out go home; the fallen keep none. */
export function hostagesMonthly(world) {
  const hs = world.sys.diplomacy && world.sys.diplomacy.hostages;
  if (!hs || !hs.length) return;
  const day = world.time.day;
  for (let k = hs.length - 1; k >= 0; k--) {
    const h = hs[k];
    const a = world.civs[h.civ], b = world.civs[h.at];
    if (!a || !b || !a.alive || !b.alive) { hs.splice(k, 1); continue; }
    if (day < h.until) continue;
    hs.splice(k, 1);
    addOpinion(world, h.civ, h.at, 10);
    if (rateOk(world, 'hostageHome', 4 * DAYS_PER_YEAR)) {
      const capA = capitalOf(world, a);
      chronicle(world, {
        cat: 'diplomacy', imp: 1, x: capA ? capA.x : null, y: capA ? capA.y : null, civId: a.id, sid: capA ? capA.id : null, icon: 'diplomacy', key: 'hostage.home', ref: { k: 'civ', id: a.id }, tags: ['hostage'],
        text: `${h.name}, held at the court of ${civName(b)} since the peace, came home to ${civName(a)}.`,
      });
    }
  }
}

// A realm whose ruler changes while its heir is held abroad calls the hostage home; one crowned
// after years at a foreign court keeps a fondness for it.
on('succession', (world, civ, prev, next) => {
  const hs = civ && world.sys.diplomacy && world.sys.diplomacy.hostages;
  if (!hs || !hs.length) return;
  for (let k = hs.length - 1; k >= 0; k--) {
    const h = hs[k];
    if (h.civ !== civ.id) continue;
    hs.splice(k, 1);
    const at = world.civs[h.at];
    if (next && next.name === h.name && at && at.alive) {
      addOpinion(world, civ.id, h.at, 15, false);
      if (rateOk(world, 'hostageCrowned', 3 * DAYS_PER_YEAR)) {
        const cap = capitalOf(world, civ);
        chronicle(world, {
          cat: 'diplomacy', imp: 2, x: cap ? cap.x : null, y: cap ? cap.y : null, civId: civ.id, sid: cap ? cap.id : null, icon: 'crown', key: 'hostage.crowned', ref: { k: 'civ', id: civ.id }, tags: ['hostage'],
          text: `${h.name} came home from the court of ${civName(at)}, where they had been held since the peace, to be crowned in ${cap ? cap.name : civName(civ)}.`,
        });
      }
    }
  }
});
