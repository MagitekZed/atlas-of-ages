// Who holds power, phase D: the court and the risings of the estates (chunk 7,
// docs/design/who-holds-power.md).
//
//   civ.court = { f: [{ k, sway 0..1, lead: { name, since }, want: { kind, law?, value?, on?,
//                 since } | null, grudge }], purged (the day a purge stops weighing on the great),
//                 cut (the day a tax cut granted ends) }
//
// Factions (ext 'factions' may name a people's own): the army, the church (the clergy), the old
// blood (the great), the guilds (the townsfolk), the reformers (scholars, from the Renaissance).
// Yearly at the realm's own month (courtYearly): sway follows its estate's power and the realm's
// state; a faction without a demand finds one (a law, lower taxes, a war on a hated neighbour, a
// lavish court, a cleaner government); the ruler grants or refuses it by temperament. Granted: the
// faction's estate warms and the policy swings. Refused twice by a strong faction of an angry
// estate: a coup (the army, the old blood), an interdict (the church), a rising (the guilds), or a
// revolution (the reformers). A cruel or ruthless ruler may purge a hostile faction instead.
//
// Risings (risingsYearly): an estate whose loyalty falls under 0.3 may rise (a peasant rising, a
// noble rebellion, a townsmen's revolution, an interdict, a revolt of the bound), told with its
// cause (power.js estWhy) and leaving ruin behind. Draws from world.rng.

import { temperOf, TP } from '../../core/character.js';
import { firstOf, hasProviders } from '../../core/ext.js';
import { makePerson } from '../../core/names.js';
import { civSettlements, damageSettlement, rel } from '../../core/entities.js';
import { DAYS_PER_YEAR as DPY } from '../../core/constants.js';
import { fin, record, rateOk } from './state.js';
import { theName, TheName, rulerName, pick } from './prose.js';
import { overthrow } from './rulers.js';
import { revolt } from './stability.js';
import { setLaw, lawsOf } from './laws.js';
import { estatePower, estateNames, addRuin, cleanGraft, purseOf, courtBase } from './power.js';

const KEYS = ['army', 'church', 'old', 'guilds', 'reform'];
const ESTATE = { army: null, church: 1, old: 0, guilds: 2, reform: null };
const temper = (civ) => (civ.ruler ? temperOf(civ.ruler, civ) : [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r3 = (v) => Math.round(fin(v) * 1000) / 1000;

/** A faction's name in the realm: its estate's own name where it has one. */
export function factionName(world, civ, k) {
  const names = estateNames(world, civ);
  switch (k) {
    case 'army': return 'the army';
    case 'church': return `the ${names[1] && !/^the /.test(names[1]) ? names[1] : 'church'}`.replace(/^the the /, 'the ');
    case 'old': return names[0] && /^the /.test(names[0]) ? names[0] : `the ${names[0] || 'old blood'}`;
    case 'guilds': return names[2] && !/^(craftsfolk|townsfolk|burghers|the middle class)$/.test(names[2]) ? `the ${names[2].replace(/^the /, '')}` : 'the guilds';
    default: return 'the reformers';
  }
}

/** The factions this realm's court may hold. */
function factionKeys(world, civ) {
  if (hasProviders('factions')) { const own = firstOf('factions', world, civ); if (Array.isArray(own)) return own.filter((k) => KEYS.includes(k)); }
  const era = fin(civ.tech?.era, 0), est = civ.est || [];
  return KEYS.filter((k) => (k === 'reform' ? era >= 4 : k === 'guilds' ? fin(est[2]?.[0]) > 0.05 : k === 'church' ? fin(est[1]?.[0]) > 0.005 : true));
}

function courtOf(world, civ) {
  let c = civ.court;
  if (!c || typeof c !== 'object' || !Array.isArray(c.f)) c = civ.court = { f: [], purged: null, cut: null };
  return c;
}

function newLeader(world, civ) {
  return { name: makePerson(civ.language, world.rng), since: world.time.day };
}

/** What a faction wants now, or null. */
function demandOf(world, civ, f, atWar) {
  const L = lawsOf(world, civ), g = civ.government;
  switch (f.k) {
    case 'army': {
      if (atWar) return null;
      // a neighbour the realm has long hated
      let worst = null, wv = -20;
      for (const k in civ.relations || {}) { const o = world.civs[k]; const q = civ.relations[k]; if (!o || !o.alive || o.id === civ.id) continue; const v = fin(q.opinion) - fin(q.grievance); if (v < wv) { wv = v; worst = o; } }
      return worst ? { kind: 'war', on: worst.id } : null;
    }
    case 'church': return L.faith !== 'one' ? { kind: 'law', law: 'faith', value: 'one' } : null;
    case 'old':
      if (L.land !== 'nobles' && g !== 'republic' && g !== 'democracy') return { kind: 'law', law: 'land', value: 'nobles' };
      if (L.inherit === 'eldest' && fin(estatePower(civ)?.[0]) > 0.45 && fin(civ.legitimacy, 0.6) < 0.4) return { kind: 'law', law: 'inherit', value: 'elective' };
      return fin(purseOf(civ).court) < courtBase(civ) * 1.1 && fin(civ.est?.[0]?.[3], 0.55) < 0.55 ? { kind: 'court' } : null;
    case 'guilds': return fin(civ.taxRate, 0.08) > 0.1 ? { kind: 'tax' } : L.land === 'nobles' && fin(civ.tech?.era) >= 4 ? { kind: 'law', law: 'land', value: 'freeholds' } : null;
    default:
      if (L.bond !== 'none') return { kind: 'law', law: 'bond', value: 'none' };
      if (fin(purseOf(civ).graft) > 0.15) return { kind: 'graft' };
      if (L.faith === 'one' && g !== 'theocracy') return { kind: 'law', law: 'faith', value: 'tolerated' };
      return null;
  }
}

/** How readily the ruler grants a demand (0..1), by its weight and the ruler's own bent. */
function grantOdds(civ, f, want) {
  const tp = temper(civ);
  const bent = want.kind === 'war' ? tp[TP.BOL]
    : want.kind === 'tax' ? 1 - tp[TP.GRE]
    : want.kind === 'court' ? 0.5 * tp[TP.AMB] + 0.5 * (1 - tp[TP.GRE])
    : want.kind === 'graft' ? (civ.ruler && Array.isArray(civ.ruler.sk) ? fin(civ.ruler.sk[2], 0.5) : 0.5)
    : want.law === 'faith' ? (want.value === 'one' ? tp[TP.PIE] : 1 - tp[TP.PIE])
    : want.law === 'land' ? (want.value === 'nobles' ? 1 - tp[TP.AMB] : tp[TP.MER])
    : want.law === 'bond' ? tp[TP.MER]
    : want.law === 'inherit' ? 1 - tp[TP.AMB] : 0.5;
  const k = want.kind === 'law' ? 0.6 : 1;   // a law is a weightier thing to give
  return clamp(k * (0.05 + 0.35 * fin(f.sway) + 0.35 * (bent - 0.5)), 0.02, 0.6);
}

const WANT_WORDS = {
  war: (world, w) => `war on ${theName(world.civs[w.on] || { name: 'its enemies' })}`,
  tax: () => 'lower taxes', court: () => 'a grander court', graft: () => 'an end to the officials’ thieving',
};
export const wantWords = (world, w) => (w.kind === 'law' ? { faith: { one: 'one faith for the realm', tolerated: 'tolerance of the other faiths', free: 'freedom of worship' }, land: { nobles: 'the land in fiefs', freeholds: 'the land for those who work it', crown: 'the land for the crown' }, bond: { none: 'the end of bondage' }, inherit: { elective: 'the right to choose the ruler' } }[w.law]?.[w.value] || 'a change of law' : (WANT_WORDS[w.kind] || (() => 'its due'))(world, w));

/** Grant a faction's demand. */
function grant(world, civ, f, w) {
  const name = factionName(world, civ, f.k);
  if (w.kind === 'law') { setLaw(world, civ, w.law, w.value, `at the demand of ${name}`); return; }
  const court = courtOf(world, civ);
  if (w.kind === 'tax') { court.cut = world.time.day + 10 * DPY; civ.taxRate = Math.max(0.02, fin(civ.taxRate, 0.08) - 0.03); }
  else if (w.kind === 'court') { const p = purseOf(civ); p.court = r3(Math.min(0.4, fin(p.court) + 0.03)); }
  else if (w.kind === 'graft') cleanGraft(world, civ, 0.4);
  else if (w.kind === 'war') { const o = world.civs[w.on]; if (o) { const q = rel(world, civ.id, o.id); q.grievance = Math.min(100, fin(q.grievance) + 20); } }
  if (rateOk(world, `grant:${civ.id}:${f.k}`, 8)) record(world, { cat: 'civ', imp: w.kind === 'court' || w.kind === 'tax' ? 1 : 2, key: 'court.grant', civ, tags: ['court', `court.${f.k}`], text: `${civ.ruler ? rulerName(civ.ruler) : TheName(civ)} gave way to ${name} of ${theName(civ)}${f.lead ? ` and their leader ${f.lead.name}` : ''}, granting ${wantWords(world, w)}.` });
}

/** A strong faction refused once too often acts. Returns true if the realm's ruler fell. */
function act(world, civ, f, w) {
  const name = factionName(world, civ, f.k);
  const prev = civ.ruler ? rulerName(civ.ruler) : TheName(civ);
  const tp = temper(civ);
  if ((f.k === 'army' || f.k === 'old') && fin(civ.stability, 0.6) < 0.55) {
    const { ruler } = overthrow(world, civ, null, 'coup');
    f.grudge = 0; f.want = null; f.sway = r3(Math.min(1, fin(f.sway) + 0.1));
    record(world, { cat: 'civ', imp: 3, key: 'court.coup', civ, tags: ['coup', 'court', `court.${f.k}`], text: `Denied ${wantWords(world, w)}, ${name} of ${theName(civ)} overthrew ${prev}${f.lead ? `; ${f.lead.name} and their friends` : ''} set ${rulerName(ruler, false)} on the throne.` });
    return true;
  }
  if (f.k === 'church') {
    civ.legitimacy = Math.max(0, fin(civ.legitimacy, 0.6) - 0.15);
    civ.stability = Math.max(0, fin(civ.stability, 0.6) - 0.05);
    f.grudge = 0;
    record(world, { cat: 'civ', imp: 2, key: 'court.interdict', civ, tags: ['court', 'court.church'], text: `${name.replace(/^./, (c) => c.toUpperCase())} of ${theName(civ)} laid the realm under interdict when ${prev} refused ${wantWords(world, w)}: no bells rang, and no one was wed or buried in the faith.` });
    return false;
  }
  if (f.k === 'reform' && fin(civ.tech?.era) >= 5 && fin(civ.stability, 0.6) < 0.45 && civ.government !== 'republic' && civ.government !== 'democracy') {
    const gov = fin(civ.tech?.era) >= 6 ? 'democracy' : 'constitutional';
    const { ruler } = overthrow(world, civ, gov, 'revolution');
    f.grudge = 0; f.want = null;
    record(world, { cat: 'civ', imp: 3, key: 'court.revolution', civ, tags: ['coup', 'court', 'court.reform'], text: `The reformers of ${theName(civ)}, refused ${wantWords(world, w)} once too often, turned the realm upside down: ${prev} fell, and ${rulerName(ruler, false)} took power under a new constitution.` });
    return true;
  }
  void tp;
  return false;
}

/** A cruel or ruthless ruler breaks a hostile faction. */
function purge(world, civ, f) {
  const name = factionName(world, civ, f.k);
  const court = courtOf(world, civ);
  const lead = f.lead ? f.lead.name : null;
  f.sway = r3(fin(f.sway) * 0.2); f.grudge = 0; f.want = null; f.lead = newLeader(world, civ);
  cleanGraft(world, civ, 0.3);
  const i = ESTATE[f.k];
  if (i != null && Array.isArray(civ.est)) civ.est[i][3] = r3(Math.max(0, fin(civ.est[i][3], 0.55) - 0.2));
  if (f.k === 'old') court.purged = world.time.day + 10 * DPY;
  record(world, { cat: 'civ', imp: 2, key: 'court.purge', civ, tags: ['court', 'purge', `court.${f.k}`], text: pick(world, [
    `${civ.ruler ? rulerName(civ.ruler) : TheName(civ)} purged ${name} of ${theName(civ)}${lead ? `: ${lead} was put to death` : ''}, and the rest went quiet.`,
    `In a night of arrests, ${civ.ruler ? rulerName(civ.ruler) : TheName(civ)} broke ${name} of ${theName(civ)}${lead ? `; ${lead} did not live to see the morning` : ''}.`,
  ]) });
}

/** Once a year at the realm's own month: sway, demands, grants and refusals, purges. */
export function courtYearly(world, civ, agg) {
  if (civ.settlementIds.length < 2 || fin(civ.tech?.era, 0) < 1 || !Array.isArray(civ.est)) return;
  const court = courtOf(world, civ);
  const keys = factionKeys(world, civ);
  court.f = court.f.filter((f) => keys.includes(f.k));
  for (const k of keys) if (!court.f.some((f) => f.k === k)) court.f.push({ k, sway: 0.1, lead: newLeader(world, civ), want: null, grudge: 0 });
  // sway: the estate's power, the soldiers and wars, the scholars
  const pw = estatePower(civ) || [];
  const sold = agg && agg.ss ? soldierShare(agg.ss) : 0.02;
  const atWar = Boolean(agg && agg.atWar);
  const raw = court.f.map((f) => f.k === 'army' ? 0.08 + 2 * sold + (atWar ? 0.15 : 0) + (civ.forces?.sys === 'standing' ? 0.1 : 0)
    : f.k === 'reform' ? 0.05 + 0.1 * Math.max(0, fin(civ.tech?.era) - 4) : fin(pw[ESTATE[f.k]]));
  const sum = raw.reduce((a, v) => a + v, 0) || 1;
  court.f.forEach((f, k) => { f.sway = r3(fin(f.sway) + (raw[k] / sum - fin(f.sway)) * 0.2); });
  // leaders grow old and are replaced
  for (const f of court.f) if (!f.lead || world.time.day - fin(f.lead.since) > (15 + 20 * world.rng.next()) * DPY) f.lead = newLeader(world, civ);
  if (court.cut && !(court.cut > world.time.day)) court.cut = null;
  if (court.purged && !(court.purged > world.time.day)) court.purged = null;
  // a ruthless ruler purges the strongest hostile faction
  const tp = temper(civ);
  const hostile = court.f.filter((f) => f.grudge >= 1 && f.sway >= 0.3).sort((a, b) => b.sway - a.sway)[0];
  if (hostile && hostile.grudge >= 2 && (tp[TP.MER] < 0.3 || (tp[TP.AMB] > 0.7 && tp[TP.HON] < 0.4)) && world.rng.chance(0.06) && rateOk(world, `purge:${civ.id}`, 20)) { purge(world, civ, hostile); return; }
  // one demand weighed a year: the strongest faction that wants something (and is not resting)
  const day = world.time.day;
  for (const f of court.f) if (!f.want && !(fin(f.next) > day)) { const w = demandOf(world, civ, f, atWar); if (w) f.want = { ...w, since: day }; }
  const f = court.f.filter((q) => q.want && !(fin(q.next) > day)).sort((a, b) => b.sway - a.sway)[0];
  if (!f) return;
  const w = f.want;
  // a stale demand (a dead enemy, a law already so) is dropped
  if ((w.kind === 'war' && !world.civs[w.on]?.alive) || (w.kind === 'law' && lawsOf(world, civ)[w.law] === w.value)) { f.want = null; return; }
  if (world.rng.chance(grantOdds(civ, f, w))) {
    grant(world, civ, f, w);
    f.want = null; f.grudge = 0;
    f.next = day + Math.round((8 + 8 * world.rng.next()) * DPY);   // satisfied for a while
    const i = ESTATE[f.k];
    if (i != null) civ.est[i][3] = r3(Math.min(1, fin(civ.est[i][3], 0.55) + 0.1));
    return;
  }
  f.grudge = fin(f.grudge) + 1;
  f.next = day + 3 * DPY;   // it will press again in a few years
  const i = ESTATE[f.k];
  if (i != null) civ.est[i][3] = r3(Math.max(0, fin(civ.est[i][3], 0.55) - 0.04));
  const angry = i == null ? fin(civ.stability, 0.6) < 0.5 : fin(civ.est[i][3], 0.55) < 0.4;
  if (f.grudge >= 2 && f.sway >= 0.3 && angry && rateOk(world, `faction:${civ.id}`, 15)) { act(world, civ, f, w); f.next = day + 10 * DPY; }
}

function soldierShare(ss) {
  let all = 0, sol = 0;
  for (const s of ss) { const j = s.jobs; if (!Array.isArray(j)) continue; for (const v of j) all += v; sol += fin(j[6]); }
  return all > 0 ? sol / all : 0;
}

// ---------------------------------------------------------------------------
// Risings of the estates

const CAUSE = {
  tax: 'against the crushing taxes', hunger: 'in a year of hunger', court: 'against the spending of the court', coin: 'over the debased coin',
  war: 'weary of war', faith: 'over the crown’s faith', land: 'over the land', bond: 'against their bondage', rights: 'for rights long denied',
  ruler: 'against their ruler', purge: 'after the purge of their own', dark: 'in horror at the crown’s dark arts',
};
const MIN_POW = [0.15, 0.06, 0.12, 0.15, 0];
const RISE_AT = [0.3, 0.3, 0.3, 0.3, 0.15];   // the bound rise only in desperation

/** Once a year: an angry estate may rise. Returns true if the realm fell. */
export function risingsYearly(world, civ) {
  const e = civ.est;
  if (!Array.isArray(e) || e.length !== 5 || civ.settlementIds.length < 2) return false;
  const pw = estatePower(civ) || [];
  for (let i = 0; i < 5; i++) {
    const [p, , , l] = e[i];
    if (!(p > 0) || !(l < RISE_AT[i])) continue;
    if (i === 4 ? p < 0.08 : fin(pw[i]) < MIN_POW[i]) continue;
    if (!world.rng.chance(0.3 * (RISE_AT[i] - l) / RISE_AT[i])) continue;
    if (!rateOk(world, `rising:${civ.id}`, 10)) return false;
    return rise(world, civ, i);
  }
  return false;
}

function rise(world, civ, i) {
  const names = estateNames(world, civ);
  const who = names[i] || ['the great', 'the clergy', 'the townsfolk', 'the commoners', 'the unfree'][i];
  const why = CAUSE[(civ.estWhy || [])[i]] || CAUSE.rights;
  const st = world.sys.civ;
  const towns = civSettlements(world, civ);
  const lead = `The ${who.replace(/^the /, '')} of ${theName(civ)} rose ${why}`;
  const L = lawsOf(world, civ);
  if (i === 3 || i === 4) {
    // a peasant rising, a revolt of the bound: the worst towns burn
    const worst = towns.filter((s) => s.id !== civ.capitalId || towns.length === 1).sort((a, b) => b.unrest - a.unrest).slice(0, 3);
    let dead = 0;
    for (const s of worst) { dead += damageSettlement(world, s, { pop: 0.01 + 0.02 * world.rng.next() + (i === 4 ? 0.02 : 0), food: 0.3, buildings: 0.1, wealth: 0.1, cause: 'revolt' }); s.unrest = Math.min(1, s.unrest + 0.25); }
    addRuin(world, civ, 0.08, 5);
    if (st) st.counters.risings = fin(st.counters.risings) + 1;
    const weak = fin(civ.stability, 0.6) < 0.45;
    let tail;
    if (weak && (i === 4 || L.bond === 'serf') && L.bond !== 'none') {
      setLaw(world, civ, 'bond', 'none', 'forced by the rising', { silent: true });
      civ.est[i][3] = r3(Math.min(1, civ.est[i][3] + 0.3));
      tail = i === 4 ? `; the crown could not hold them, and their chains were struck off` : `; the lords gave way, and the serfs were freed`;
    } else if (weak) {
      courtOf(world, civ).cut = world.time.day + 10 * DPY;
      civ.taxRate = Math.max(0.02, fin(civ.taxRate, 0.08) - 0.03);
      civ.est[i][3] = r3(Math.min(1, civ.est[i][3] + 0.2));
      tail = `; the crown bought peace with lower taxes`;
    } else {
      civ.est[i][3] = r3(Math.min(1, civ.est[i][3] + 0.05));
      tail = pick(world, [`; the rising was put down in blood`, `, and were cut down by the crown’s soldiers`]);
    }
    const where = worst.length ? ` in ${worst.map((s) => s.name).slice(0, 2).join(' and ')}` : '';
    record(world, { cat: 'civ', imp: dead >= 2000 || weak ? 3 : 2, key: i === 4 ? 'rising.unfree' : 'rising.commons', civ, s: worst[0], tags: ['rising', `rising.${i}`], text: `${lead}${where}${dead >= 20 ? `, and ${Math.round(dead / 10) * 10} died` : ''}${tail}.` });
    return false;
  }
  if (i === 0) {
    // a noble rebellion: a pretender where the crown is weak, else a province breaks away
    if (st) st.counters.risings = fin(st.counters.risings) + 1;
    if (fin(civ.legitimacy, 0.6) < 0.45) {
      const prev = civ.ruler ? rulerName(civ.ruler) : TheName(civ), pron = civ.ruler && civ.ruler.gender === 'f' ? 'her' : 'his';
      const { ruler } = overthrow(world, civ, null, 'coup');
      addRuin(world, civ, 0.12, 6);
      record(world, { cat: 'civ', imp: 3, key: 'rising.great', civ, tags: ['rising', 'coup', 'rising.0'], text: `${lead}: they cast down ${prev} and raised up ${rulerName(ruler, false)} in ${pron} place.` });
      return false;
    }
    const cap = world.settlements[civ.capitalId];
    const far = towns.filter((s) => s.id !== civ.capitalId).sort((a, b) => (cap ? Math.hypot(b.x - cap.x, b.y - cap.y) - Math.hypot(a.x - cap.x, a.y - cap.y) : 0) || b.population - a.population)[0];
    if (far) {
      record(world, { cat: 'civ', imp: 2, key: 'rising.great', civ, s: far, tags: ['rising', 'rising.0'], text: `${lead}, and the lords of ${far.name} raised their banners against the crown.` });
      far.unrest = Math.max(far.unrest, 0.7); far.loyalty = Math.min(far.loyalty, 0.3);
      revolt(world, civ, far, { cause: null });
      return !civ.alive;
    }
    return false;
  }
  if (i === 2) {
    // a townsmen's revolution: a charter where the crown is weak and the age is ripe, else a free city
    if (st) st.counters.risings = fin(st.counters.risings) + 1;
    const era = fin(civ.tech?.era, 0), g = civ.government;
    const already = g === 'republic' || g === 'merchant' || g === 'democracy' || g === 'constitutional';
    if (!already && era >= 3 && fin(civ.stability, 0.6) < 0.45) {
      const prev = civ.ruler ? rulerName(civ.ruler) : TheName(civ);
      const gov = era >= 5 ? 'constitutional' : 'merchant';
      const { ruler } = overthrow(world, civ, gov, 'revolution');
      record(world, { cat: 'civ', imp: 3, key: 'rising.towns', civ, tags: ['rising', 'coup', 'rising.2'], text: `${lead}: ${prev} fell, and ${rulerName(ruler, false)} ruled under a charter of the towns.` });
      return false;
    }
    const rich = towns.filter((s) => s.id !== civ.capitalId && (s.tier | 0) >= 3).sort((a, b) => b.wealth - a.wealth)[0];
    if (rich) {
      record(world, { cat: 'civ', imp: 2, key: 'rising.towns', civ, s: rich, tags: ['rising', 'rising.2'], text: `${lead}, and ${rich.name} shut its gates on the crown’s officers.` });
      rich.unrest = Math.max(rich.unrest, 0.7); rich.loyalty = Math.min(rich.loyalty, 0.3);
      revolt(world, civ, rich, { cause: null });
      return !civ.alive;
    }
    civ.est[i][2] = r3(Math.min(1, civ.est[i][2] + 0.1));
    record(world, { cat: 'civ', imp: 2, key: 'rising.towns', civ, tags: ['rising', 'rising.2'], text: `${lead}, and won new rights for the towns.` });
    return false;
  }
  // the clergy: an interdict
  civ.legitimacy = Math.max(0, fin(civ.legitimacy, 0.6) - 0.15);
  civ.stability = Math.max(0, fin(civ.stability, 0.6) - 0.05);
  if (st) st.counters.risings = fin(st.counters.risings) + 1;
  record(world, { cat: 'civ', imp: 2, key: 'rising.clergy', civ, tags: ['rising', 'rising.1'], text: `${lead}: from every pulpit the faithful were told to withhold their obedience from the crown.` });
  return false;
}
