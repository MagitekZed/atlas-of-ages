// Claims on land (chunk 3, docs/design/why-wars.md): every town a realm lost, remembered for
// generations.
//
//   civ.landClaims = { [sid]: [w, why, since, tau, from?] }
//     w      strength when the claim was last renewed (0..1)
//     why    f founded the town · l lost in war or at a treaty · s lost to a rising · i inherited
//     since  the day it was last renewed
//     tau    fading time in years: the live strength is w · exp(−years since / tau)
//     from   for an inherited claim, the fallen realm it came from
//
// A realm gains a claim when a town it founded, held ten years or more, or kept as its seat
// leaves it by conquest, treaty, secession or defection (unions and willing annexations leave
// none). The claim is dropped when the town is razed or abandoned, when the claimant takes it
// back, or when it fades under MIN at the realm's yearly pass; a claim renounced at a treaty
// (war.js) keeps a third of its strength, the people's memory of it. A fallen realm's claims pass
// at ×HEIR to its heir: the realm with the strongest claim on its crown, else a daughter realm,
// else its parent. A realm keeps its CAP strongest.
// Fading times come from the ext 'claimRule' (first; Mythic peoples answer for their own),
// defaulting to 60 years, and 120 for a town the realm founded.
//
// The war system reads the claims for its reconquest casus belli and its war aims; diplomacy
// for the opinion a claimant keeps of the holder (claimSums). Old saves are seeded once from
// every town's owner chain (s.own). No rng is drawn here; texts are picked by hash.
//
// Exports: claimStrength, claimOf, bestClaimOn, claimedTowns, claimSums, claimantsOf,
//          claimsOfCiv, renounceClaims, hardenClaims, claimsMonthly, CLAIM_WHY

import { chronicle } from '../../core/chronicle.js';
import { on } from '../../core/hooks.js';
import { liveCivs } from '../../core/entities.js';
import { touchRecord } from '../../core/keyframe.js';
import { firstOf, hasProviders } from '../../core/ext.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH } from '../../core/constants.js';
import { clamp01 } from '../../core/util.js';
import { ownCode } from '../ledger.js';
import { civName, peopleOf, capFirst, capitalOf, hashPick, rateOk, finite } from './common.js';

const MIN = 0.08;          // a claim weaker than this is forgotten
const CAP = 12;            // claims a realm keeps (the strongest)
const HEIR = 0.7;          // what an heir keeps of a fallen realm's claims
const HELD_MIN = 10;       // years a town must be held before its loss leaves a claim
const RENOUNCED = 0.35;    // what is left of a claim given up at a peace
const DEF = { tau: 60, foundedTau: 120 };

export const CLAIM_WHY = { f: 'founded it', l: 'lost it in war', s: 'lost it to a rising', i: 'inherited the claim' };

function rule(world, civ) {
  if (!hasProviders('claimRule')) return DEF;
  const r = firstOf('claimRule', world, civ);
  return r && finite(r.tau) && r.tau > 0 && finite(r.foundedTau) && r.foundedTau > 0 ? r : DEF;
}

/** Live strength of a claim record. */
export function claimStrength(world, c, day = world.time.day) {
  return c[0] * Math.exp(-(day - c[2]) / (c[3] * DAYS_PER_YEAR));
}

/** civ's live claim on town sid (0 when none). */
export function claimOf(world, civ, sid) {
  const c = civ && civ.landClaims ? civ.landClaims[sid] : null;
  return c ? claimStrength(world, c) : 0;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

function setClaim(world, civ, sid, w, why, tau, since = world.time.day, from = null) {
  const lc = civ.landClaims || (civ.landClaims = {});
  const old = lc[sid];
  if (old && claimStrength(world, old) >= w) return false;
  lc[sid] = from != null ? [round3(w), why, since, tau, from] : [round3(w), why, since, tau];
  const keys = Object.keys(lc);
  if (keys.length > CAP) {
    let weak = null, wv = Infinity;
    for (const k of keys) { const v = claimStrength(world, lc[k]); if (v < wv) { wv = v; weak = k; } }
    delete lc[weak];
  }
  return true;
}

/** Day civ came to hold s, from its owner chain (the founding day when the chain is silent). */
function tenureStart(s, civId) {
  const own = s.own;
  if (Array.isArray(own)) for (let k = own.length - 1; k >= 0; k--) if (own[k][1] === civId && own[k][2] !== 'x') return own[k][0];
  return finite(s.foundedDay) ? s.foundedDay : 0;
}

/** A claim's opening strength and fading time for a town lost after `held` years (null: no claim). */
function opening(world, civ, s, held, wasCap) {
  const R = rule(world, civ);
  if (s.originCivId === civ.id) return { w: 1, why: 'f', tau: R.foundedTau };
  if (held < HELD_MIN && !wasCap) return null;
  let w = 0.3 + 0.55 * clamp01((held - HELD_MIN) / 40);
  if (wasCap) w = Math.min(1, w * 1.25);
  return { w, why: null, tau: R.tau };
}

/** civ has just lost s (why 'l' or 's'): it claims the town, and a great loss is sworn over. */
function lose(world, civ, s, why) {
  const day = world.time.day;
  const held = (day - tenureStart(s, civ.id)) / DAYS_PER_YEAR;
  const wasCap = civ.flags?.capitalSid === s.id || s.flags?.wasCapital === civ.id;
  const o = opening(world, civ, s, held, wasCap);
  if (!o) return;
  if (!setClaim(world, civ, s.id, o.w, o.why || why, o.tau)) return;
  sworn(world, civ, s, wasCap);
}

function sworn(world, civ, s, wasCap) {
  if (!civ.alive || !civ.settlementIds.length || (!wasCap && (s.tier || 0) < 3)) return;
  const day = world.time.day;
  if (!rateOk(world, `claimSworn:${civ.id}`, 10 * DAYS_PER_YEAR)) return;
  if (!rateOk(world, 'claimSworn', 2 * DAYS_PER_YEAR)) return;
  const cap = capitalOf(world, civ);
  const seat = cap ? cap.name : null;
  const town = s.name, P = peopleOf(civ);
  const text = hashPick([
    seat ? `In ${seat} they swore that ${town} would be theirs again.` : `${capFirst(P)} swore that ${town} would be theirs again.`,
    `${capFirst(P)} mourned the loss of ${town}, and counted it theirs still.`,
    `The fall of ${town} was not forgotten${seat ? ` in ${seat}` : ''}: ${civName(civ)} would claim it for generations.`,
  ], s.id, civ.id, Math.floor(day / DAYS_PER_YEAR));
  chronicle(world, { cat: 'war', imp: 2, text, x: s.x, y: s.y, civId: civ.id, sid: s.id, icon: 'scroll', key: 'claim.sworn', ref: { k: 'civ', id: civ.id }, tags: ['claim'] });
}

// ---------------------------------------------------------------------------
// Queries

/** The strongest claim a holds on a town b holds now: { s, w } or null. */
export function bestClaimOn(world, a, b) {
  const lc = a.landClaims;
  if (!lc) return null;
  let best = null;
  for (const k in lc) {
    const s = world.settlements[k];
    if (!s || !s.alive || s.civId !== b.id) continue;
    const w = claimStrength(world, lc[k]);
    if (w >= MIN && (!best || w > best.w)) best = { s, w };
  }
  return best;
}

/** Up to n towns b holds that a claims, strongest first: [{ s, w }]. */
export function claimedTowns(world, a, b, n = 3) {
  const lc = a.landClaims;
  if (!lc) return [];
  const out = [];
  for (const k in lc) {
    const s = world.settlements[k];
    if (!s || !s.alive || s.civId !== b.id) continue;
    const w = claimStrength(world, lc[k]);
    if (w >= MIN) out.push({ s, w });
  }
  out.sort((p, q) => q.w - p.w || p.s.id - q.s.id);
  return out.slice(0, n);
}

/** For every live claimant, the sum of its claims on each holder's towns: Map(aId → { [holderId]: Σw }). */
export function claimSums(world) {
  const out = new Map();
  for (const a of liveCivs(world)) {
    const lc = a.landClaims;
    if (!lc) continue;
    let m = null;
    for (const k in lc) {
      const s = world.settlements[k];
      if (!s || !s.alive || s.civId === a.id) continue;
      const w = claimStrength(world, lc[k]);
      if (w < MIN) continue;
      (m ||= {})[s.civId] = (m[s.civId] || 0) + w;
    }
    if (m) out.set(a.id, m);
  }
  return out;
}

/** Realms claiming town s, strongest first: [{ civ, w, why, since, from }] (the town dossier). */
export function claimantsOf(world, s) {
  const out = [];
  for (const c of liveCivs(world)) {
    const r = c.landClaims ? c.landClaims[s.id] : null;
    if (!r || c.id === s.civId) continue;
    const w = claimStrength(world, r);
    if (w >= MIN) out.push({ civ: c, w, why: r[1], since: r[2], from: r[4] ?? null });
  }
  return out.sort((p, q) => q.w - p.w || p.civ.id - q.civ.id);
}

/** civ's claims, strongest first: [{ s, w, why, since, from }] (the realm dossier). */
export function claimsOfCiv(world, civ) {
  const lc = civ && civ.landClaims;
  if (!lc) return [];
  const out = [];
  for (const k in lc) {
    const s = world.settlements[k];
    if (!s) continue;
    const w = claimStrength(world, lc[k]);
    if (w >= MIN) out.push({ s, w, why: lc[k][1], since: lc[k][2], from: lc[k][4] ?? null });
  }
  return out.sort((p, q) => q.w - p.w || p.s.id - q.s.id);
}

// ---------------------------------------------------------------------------
// Treaties (war.js)

/**
 * civ gives up its claims on the towns sids at a peace it accepted. The crown's claim is gone, but
 * the memory of the towns lingers at RENOUNCED of its strength and keeps fading. Returns the
 * names given up.
 */
export function renounceClaims(world, civ, sids) {
  const lc = civ && civ.landClaims;
  const out = [];
  if (!lc) return out;
  for (const sid of sids) {
    const c = lc[sid];
    if (!c) continue;
    const w = claimStrength(world, c) * RENOUNCED;
    if (w < MIN) delete lc[sid];
    else { c[0] = round3(w); c[2] = world.time.day; }
    const s = world.settlements[sid];
    if (s) out.push(s.name);
  }
  return out;
}

/** A harsh peace: civ's claims on sids fade at half speed from now. */
export function hardenClaims(world, civ, sids) {
  const lc = civ && civ.landClaims;
  if (!lc) return;
  for (const sid of sids) {
    const c = lc[sid];
    if (!c) continue;
    const w = claimStrength(world, c);
    c[0] = round3(w); c[2] = world.time.day; c[3] *= 2;
  }
}

// ---------------------------------------------------------------------------
// Upkeep

function heirOf(world, dead) {
  let best = null, bw = 0;
  for (const c of liveCivs(world)) {
    const w = finite(c.claims?.[dead.id]) ? c.claims[dead.id] : 0;
    if (w >= 0.4 && w > bw) { bw = w; best = c; }
  }
  if (best) return best;
  for (const c of liveCivs(world)) if (c.parentId === dead.id && (!best || (c.population || 0) > (best.population || 0))) best = c;
  if (best) return best;
  const p = dead.parentId != null ? world.civs[dead.parentId] : null;
  return p && p.alive ? p : null;
}

/** Old saves: claims from every town's owner chain, once (the chain's past holders still alive). */
function seedClaims(world) {
  for (const s of world.settlements) {
    if (!s || !s.alive || !Array.isArray(s.own) || s.own.length < 2) continue;
    const own = s.own;
    for (let k = 0; k + 1 < own.length; k++) {
      const holder = world.civs[own[k][1]];
      if (!holder || !holder.alive || holder.id === s.civId) continue;
      const code = own[k + 1][2];
      if (code === 'u' || code === 'x' || own[k + 1][1] === holder.id) continue;
      const end = own[k + 1][0];
      const o = opening(world, holder, s, (end - own[k][0]) / DAYS_PER_YEAR, false);
      if (!o) continue;
      setClaim(world, holder, s.id, o.w, o.why || (code === 's' || code === 'r' ? 's' : 'l'), o.tau, end);
    }
  }
}

/**
 * Monthly, from diplomacy: seed an old save once, then each realm's yearly pass in its own month
 * drops the claims that have faded, with a line when a great one is forgotten after a century.
 */
export function claimsMonthly(world, st) {
  if (st.claimsV !== 1) { seedClaims(world); st.claimsV = 1; }
  const day = world.time.day;
  const month = Math.floor(day / DAYS_PER_MONTH);
  for (const c of liveCivs(world)) {
    if ((c.id + month) % 12 !== 0) continue;
    const lc = c.landClaims;
    if (!lc) continue;
    for (const k in lc) {
      const r = lc[k];
      const s = world.settlements[k];
      if (!s || !s.alive || s.civId === c.id) { delete lc[k]; continue; }
      if (claimStrength(world, r, day) >= MIN) continue;
      delete lc[k];
      if ((r[1] === 'f' || (s.tier || 0) >= 4) && day - r[2] > 100 * DAYS_PER_YEAR && rateOk(world, 'claimFaded', 5 * DAYS_PER_YEAR)) {
        const cap = capitalOf(world, c);
        const Y = Math.floor(day / DAYS_PER_YEAR);
        const text = hashPick([
          cap ? `By Year ${Y} no one in ${cap.name} remembered that ${s.name} had once been theirs.` : `By Year ${Y} ${peopleOf(c)} no longer remembered that ${s.name} had once been theirs.`,
          `The old claim of ${civName(c)} to ${s.name} was forgotten at last.`,
        ], s.id, c.id, Y);
        chronicle(world, { cat: 'war', imp: 1, text, x: s.x, y: s.y, civId: c.id, sid: s.id, icon: 'scroll', key: 'claim.faded', ref: { k: 'civ', id: c.id }, tags: ['claim'] });
      }
    }
  }
}

on('settlementTransferred', (world, s, oldId, newId, cause) => {
  if (!s) return;
  const nw = world.civs[newId];
  if (nw && nw.landClaims && nw.landClaims[s.id]) delete nw.landClaims[s.id];   // won back
  const old = world.civs[oldId];
  if (!old) return;
  const code = ownCode(cause);
  if (code === 'u') return;   // a union, an inheritance, a willing annexation: nothing was lost
  lose(world, old, s, code === 's' || code === 'r' ? 's' : 'l');
});

on('settlementDestroyed', (world, s) => {
  if (!s) return;
  for (const c of liveCivs(world)) if (c.landClaims && c.landClaims[s.id]) delete c.landClaims[s.id];
});

on('civDestroyed', (world, civ) => {
  const lc = civ && civ.landClaims;
  if (!lc) return;
  const keys = Object.keys(lc);
  if (!keys.length) return;
  const heir = heirOf(world, civ);
  if (heir) {
    const tau = rule(world, heir).tau;
    for (const k of keys) {
      const s = world.settlements[k];
      if (!s || !s.alive || s.civId === heir.id) continue;
      const w = claimStrength(world, lc[k]) * HEIR;
      if (w >= MIN) setClaim(world, heir, +k, w, 'i', tau, world.time.day, civ.id);
    }
  }
  civ.landClaims = {};
  touchRecord(world, civ);
});
