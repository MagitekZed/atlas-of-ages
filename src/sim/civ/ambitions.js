// Ambitions (chunk 4, docs/design/character.md): what the notable want, and what comes of it.
//
//   person.am   = { k, t, since, by }      the ambition: its kind, its target, since, the year it
//                                          is given up by
//   person.done = [[k, outcome, day, t]]   the last four resolved (met · failed · gone)
//
// Rulers draw one yearly in their realm's month when they have none, weighted by temperament
// (core/character.js) among those that fit: take a town the realm claims, avenge a wrong (the
// realm it bears the deepest grievance), unite its people (a bordering realm of its own root or,
// in Mythic worlds, race), bring its faith to a neighbour, raise a great work, see a golden age;
// many want nothing in particular. The war system feels them (ambitionPull: appetite against the
// target) and tells them in its declarations. Met, given up when the year comes, or lost with
// the target; on a ruler's death a vengeance, a town or a union passes half the time to the heir,
// who swears to finish it. A met ambition may give an epithet.
//
// Heirs: an ambitious heir with little honour, under a ruler who reigns long, may set their heart
// on the throne and, after three years, plot (the user's choice: rarely). Success crowns them
// (succession by deposition); failure costs them their life or their place.
// Great people: their life's work (a masterpiece, a discovery, a voyage, a fortune, a beast slain)
// is the deed the civ module already gives them, now told as an ambition met. Great generals
// want glory (met by their next named victory: war.js) or power (they lead a standing army's
// coup, and are crowned by it: rulers.js armyCoup).
//
// Exports: rulerAmbitionYear, ambitionWords, heirPlotYear

import { on } from '../../core/hooks.js';
import { firstOf, hasProviders } from '../../core/ext.js';
import { temperOf, skillsOf, settleAmbition, AMBITION_WORDS, TP, SK } from '../../core/character.js';
import { DAYS_PER_YEAR as DPY } from '../../core/constants.js';
import { fin, record, rateOk, rulerRef } from './state.js';
import { theName, peopleOf, rulerName, rulerShort, pick } from './prose.js';
import { rootOf } from './peoples.js';
import { kinDied, kinSetAside, syncHeir } from './kin.js';

const EPITHET_OF = { avenge: 'the Avenger', unite: 'the Uniter', wonder: 'the Builder', golden: 'the Magnificent' };

/** An ambition in words: "to take Varn", "to be avenged on the Oskel". */
export function ambitionWords(world, am, civ = null) {
  if (!am) return '';
  const t = am.t;
  const town = am.k === 'town' && world.settlements[t] ? world.settlements[t].name : '';
  const c = (am.k === 'avenge' || am.k === 'unite' || am.k === 'convert') && world.civs[t] ? theName(world.civs[t]) : '';
  const f = am.k === 'convert' && civ && civ.stateReligion != null && world.religions[civ.stateReligion] ? world.religions[civ.stateReligion].name : 'the faith';
  return (AMBITION_WORDS[am.k] || '').replace('{t}', town).replace('{c}', c).replace('{f}', f).replace('{p}', civ ? peopleOf(civ) : 'the people');
}

/** A fallen realm's last seat is now civ's (it was conquered, not lost to another). */
const heldSeat = (world, o, civ) => { const s = o && o.capitalId != null ? world.settlements[o.capitalId] : null; return Boolean(s && s.alive && s.civId === civ.id); };
const hasWonder = (world, civ) => (world.wonders || []).some((w) => w && w.civId === civ.id && w.destroyedDay == null);

// ---------------------------------------------------------------------------
// Rulers

/** The ambitions that fit a ruler now, weighted by temperament: [{ k, t, w }]. */
function choices(world, civ, r) {
  const tp = temperOf(r, civ), sk = skillsOf(r, world.time.day);
  const out = [];
  // a town the realm claims, held by another
  let best = null, bw = 0;
  for (const k in civ.landClaims || {}) { const s = world.settlements[k]; const c = civ.landClaims[k]; if (s && s.alive && s.civId !== civ.id && c[0] > bw) { bw = c[0]; best = s; } }
  if (best) out.push({ k: 'town', t: best.id, w: (tp[TP.AMB] + tp[TP.BOL]) * (0.5 + bw) });
  // a wrong to avenge: the deepest grievance against a living realm
  let foe = null, gw = 40;
  for (const k in civ.relations) { const g = fin(civ.relations[k].grievance); const o = world.civs[k]; if (g > gw && o && o.alive) { gw = g; foe = o; } }
  if (foe) out.push({ k: 'avenge', t: foe.id, w: 2 * (1 - tp[TP.MER]) * (gw / 60) });
  // a bordering realm of the same people
  const root = rootOf(world, civ);
  for (const k in civ.relations) {
    const o = world.civs[k];
    if (!o || !o.alive || !(fin(civ.relations[k].border) > 0)) continue;
    if ((civ.race && o.race === civ.race && world.params.mythLevel >= 2) || rootOf(world, o) === root) { out.push({ k: 'unite', t: o.id, w: 1.5 * tp[TP.AMB] * tp[TP.BOL] }); break; }
  }
  // a neighbour of another faith
  if (civ.stateReligion != null && tp[TP.PIE] >= 0.7) {
    for (const k in civ.relations) { const o = world.civs[k]; if (o && o.alive && fin(civ.relations[k].border) > 0 && o.stateReligion != null && o.stateReligion !== civ.stateReligion) { out.push({ k: 'convert', t: o.id, w: 2 * tp[TP.PIE] }); break; } }
  }
  // a great work, a golden age
  if (fin(civ.tech?.era) >= 1 && !hasWonder(world, civ) && civ.settlementIds.length >= 3) out.push({ k: 'wonder', t: null, w: 0.6 * (tp[TP.AMB] + sk[SK.STE]) });
  if (!(civ.goldenAge > 0) && sk[SK.LEA] + sk[SK.STE] >= 0.9) out.push({ k: 'golden', t: null, w: 0.3 * (sk[SK.LEA] + sk[SK.STE]) });
  out.push({ k: null, t: null, w: 1.6 });   // many rulers want nothing in particular
  // what a society lets a ruler want (ext 'ambitionRule'; by default the list above as weighed)
  const rule = hasProviders('ambitionRule') ? firstOf('ambitionRule', world, civ, r) : null;
  if (rule && typeof rule === 'object') for (const c of out) { const m = rule[c.k || 'none']; if (Number.isFinite(m)) c.w *= Math.max(0, m); }
  return out;
}

function draw(world, civ, r) {
  const cs = choices(world, civ, r);
  let tot = 0; for (const c of cs) tot += c.w;
  let x = world.rng.next() * tot, pickC = cs[cs.length - 1];
  for (const c of cs) { x -= c.w; if (x <= 0) { pickC = c; break; } }
  if (!pickC.k) return;
  const day = world.time.day;
  r.am = { k: pickC.k, t: pickC.t, since: day, by: day + Math.round((10 + world.rng.next() * 20) * DPY) };
  if ((pickC.k === 'avenge' || pickC.k === 'convert') && rateOk(world, `sworn:${civ.id}`, 25)) {
    record(world, { cat: 'civ', imp: 1, key: 'ambition.sworn', civ, ref: rulerRef(civ, r), tags: ['ambition'], text: `${rulerName(r)} of ${theName(civ)} swore ${ambitionWords(world, r.am, civ)}.` });
  }
}

function met(world, civ, r) {
  const am = r.am;
  if (!am) return null;
  switch (am.k) {
    case 'town': { const s = world.settlements[am.t]; if (!s || !s.alive) return 'gone'; return s.civId === civ.id ? 'met' : null; }
    case 'avenge': { const o = world.civs[am.t]; return o && o.alive ? null : heldSeat(world, o, civ) ? 'met' : 'gone'; }   // or a war won (warEnded)
    case 'unite': {
      const o = world.civs[am.t];
      if (o && o.alive) return o.vassalOf === civ.id || (o.flags?.union && o.flags.union.withCivId === civ.id) ? 'met' : null;
      return heldSeat(world, o, civ) ? 'met' : 'gone';
    }
    case 'convert': { const o = world.civs[am.t]; if (!o || !o.alive) return 'gone'; return o.stateReligion === civ.stateReligion ? 'met' : null; }
    case 'golden': return civ.goldenAge > 0 ? 'met' : null;
    default: return null;   // a great work is met by wonderBuilt
  }
}

function resolve(world, civ, r, outcome) {
  const am = settleAmbition(r, outcome, world.time.day);
  if (outcome === 'met') {
    if (!r.epithet && EPITHET_OF[am.k]) { r.epithet = EPITHET_OF[am.k]; r.display = rulerName(r); }
    if (rateOk(world, `amMet:${civ.id}`, 15)) {
      const big = am.k === 'avenge' || am.k === 'unite' || am.k === 'town';
      record(world, { cat: 'civ', imp: big ? 2 : 1, key: 'ambition.met', civ, ref: rulerRef(civ, r), tags: ['ambition'], text: pick(world, [
        `${rulerName(r)} of ${theName(civ)} had sworn ${ambitionWords(world, am, civ)}, and lived to see it done.`,
        `What ${rulerShort(r)} of ${theName(civ)} had wanted above all was done at last: ${ambitionWords(world, am, civ).replace(/^to /, '')}.`,
      ]) });
    }
  } else if (outcome === 'failed' && (am.k === 'avenge' || am.k === 'town' || am.k === 'unite') && rateOk(world, `amFail:${civ.id}`, 25)) {
    record(world, { cat: 'civ', imp: 1, key: 'ambition.failed', civ, ref: rulerRef(civ, r), tags: ['ambition'], text: `${rulerName(r)} of ${theName(civ)} had sworn ${ambitionWords(world, am, civ)}; the years went by, and it was never done.` });
  }
}

/** Yearly, in the realm's month: a ruler's ambition drawn, met, given up or lost. */
export function rulerAmbitionYear(world, civ, r) {
  if (!r || !civ.alive) return;
  if (r.am) {
    const out = met(world, civ, r);
    if (out) { resolve(world, civ, r, out); return; }
    if (world.time.day > fin(r.am.by, Infinity)) resolve(world, civ, r, 'failed');
    return;
  }
  // a ruler takes stock in the first year of the reign and every eighth year after
  if (Math.floor((world.time.day - fin(r.reignStart, world.time.day)) / DPY) % 8 === 0) draw(world, civ, r);
}

// a great work raised fulfils that ambition
on('wonderBuilt', (world, w) => {
  const civ = w && world.civs[w.civId];
  const r = civ && civ.ruler;
  if (r && r.am && r.am.k === 'wonder') resolve(world, civ, r, 'met');
});

// a war won against the realm a ruler swore to avenge themselves on
on('warEnded', (world, war) => {
  const win = war.outcome === 'attackers' ? war.attackers : war.outcome === 'defenders' ? war.defenders : null;
  if (!win) return;
  const lose = win === war.attackers ? war.defenders : war.attackers;
  for (const id of win) {
    const civ = world.civs[id], r = civ && civ.ruler;
    if (r && r.am && r.am.k === 'avenge' && lose.includes(r.am.t)) resolve(world, civ, r, 'met');
  }
});

// a vengeance, a town or a union passes half the time to the next ruler, who swears to finish it
on('succession', (world, civ, prev, next) => {
  if (!prev || !next || !prev.am || next.am) return;
  const am = prev.am;
  if (!(am.k === 'avenge' || am.k === 'town' || am.k === 'unite') || !world.rng.chance(0.5)) return;
  const day = world.time.day;
  next.am = { k: am.k, t: am.t, since: day, by: day + Math.round(20 * DPY) };
  if (rateOk(world, `inherit:${civ.id}`, 25)) {
    record(world, { cat: 'civ', imp: 1, key: 'ambition.sworn', civ, ref: rulerRef(civ, next), tags: ['ambition'], text: `${rulerName(next)} of ${theName(civ)} swore to finish what ${rulerShort(prev)} had begun: ${ambitionWords(world, next.am, civ).replace(/^to /, '')}.` });
  }
});

// ---------------------------------------------------------------------------
// Heirs who want the throne

/**
 * Yearly: an ambitious heir with little honour, grown and kept waiting by a long reign, may set
 * their heart on the throne; after three years they may plot (6 % a year × their intrigue), and
 * succeed against the ruler's intrigue (succession: rulers.js). Returns true when the throne changed
 * hands.
 */
export function heirPlotYear(world, civ, r, succession) {
  const h = r && r.heir;
  if (!h || !h.name || (civ.flags && civ.flags.union)) return false;
  const day = world.time.day;
  const age = (day - fin(h.born, day)) / DPY;
  const reign = (day - fin(r.reignStart, day)) / DPY;
  const tp = temperOf(h, civ);
  if (!h.am) {
    if (age >= 18 && reign >= 8 && tp[TP.AMB] >= 0.58 && tp[TP.HON] <= 0.47) h.am = { k: 'throne', t: civ.id, since: day, by: day + Math.round(25 * DPY) };
    return false;
  }
  if (h.am.k !== 'throne' || day - h.am.since < 3 * DPY) return false;
  const hi = skillsOf(h, day)[SK.INT], ri = skillsOf(r, day)[SK.INT];
  if (!world.rng.chance(0.06 * (0.5 + hi))) return false;
  if (world.rng.chance(Math.max(0.1, Math.min(0.8, 0.35 + 0.4 * (hi - ri))))) {
    // the heir takes the crown by the ordinary path, told as an overthrow (rulers.js 'usurped')
    h.am = null;
    succession(world, civ, 'usurped', {}, { key: 'plot.usurp', imp: 3, tags: ['plot', 'ambition'] });
    return true;
  }
  const fate = world.rng.chance(0.5) ? 'put to death' : 'sent into exile';
  record(world, { cat: 'civ', imp: 2, key: 'plot.foiled', civ, ref: rulerRef(civ, r), tags: ['plot'], text: `A plot by ${h.name}, heir of ${theName(civ)}, against ${rulerShort(r)} was uncovered; the heir was ${fate}.` });
  if (h.id != null) { if (fate === 'put to death') kinDied(world, h.id, 'executed'); else kinSetAside(world, h.id); }
  r.heir = null;
  syncHeir(world, civ);
  civ.stability = Math.max(0, fin(civ.stability, 0.6) - 0.03);
  return false;
}

// ---------------------------------------------------------------------------
// Great people

const LIFE_WORK = { artist: 'masterpiece', scholar: 'discovery', explorer: 'voyage', merchant: 'fortune', hero: 'beast' };

// a great person's life's work is the deed the civ module gives them, told as an ambition met;
// a great general wants glory, or (ambitious and without honour) power
on('figureBorn', (world, fig) => {
  if (!fig || fig.am || fig.done) return;
  const day = world.time.day;
  const civ = world.civs[fig.civId];
  if (fig.kind === 'general') {
    const tp = temperOf(fig, civ);
    fig.am = { k: tp[TP.AMB] >= 0.58 && tp[TP.HON] <= 0.45 ? 'power' : 'glory', t: null, since: day, by: day + Math.round(30 * DPY) };
    return;
  }
  const k = LIFE_WORK[fig.kind];
  if (k) fig.done = [[k, 'met', day, null]];
});
