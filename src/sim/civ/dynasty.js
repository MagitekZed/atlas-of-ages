// Royal houses beyond the throne itself: spouses and heirs, marriages between crowns and the
// claims they leave, personal unions (two realms, one ruler), regencies for child rulers,
// courts in exile and the restorations they plot. Everything is plain JSON:
//
//   ruler.spouse       { name, fromCivId, house, gender } | null
//   ruler.heir         { name, gender, born, relation } | null   (hereditary realms only)
//   civ.claims         { [civId]: 0..1 } claims on another crown by marriage (+0.35 / +0.2 at
//                      the match, +0.25 when a child of a foreign match is born; × 0.98 a year)
//   civ.flags.union    { withCivId, since, senior } a personal union; the junior realm's
//                      ruler is a copy of the senior's (same person id), and lives and dies
//                      with it: when the shared ruler goes, the junior crown merges into the
//                      senior (cause 'union') or breaks away under a ruler of its own.
//   civ.flags.regent   { name, kind, since, until, forId } a regency for a child ruler
//   civ.flags.heirSecured  the next succession cannot fall into crisis (Grant an Heir)
//   sys.civ.exiles     courts in exile (cap 24): { id, civId, name, adjective, hue, colorHex,
//                      dynasty, ruler, hostCivId, homeSids, since, used }
//   sys.civ.marriages  recent matches (cap 60): { a, b, day, house }
//
// Exports: arrangeMarriage(world, a, b, opts) (published, contracts §12), the hooks rulers.js
// calls (heirOnInstall, takeHeir, startRegency, unionSuccession, onRulerGone, unionPartner),
// dynastyMonthly / dynastyYearly, exileOnFall, onCivFall. Providers: casusBelli (claim,
// restoration) and allied (realms sharing a crown).

import { createCiv, transferSettlement, addOpinion, rel, areAtWar, startWar, liveCivs } from '../../core/entities.js';
import { on } from '../../core/hooks.js';
import { makePerson } from '../../core/names.js';
import { emitFx } from '../../core/world.js';
import { registerProvider } from '../../core/ext.js';
import { DAYS_PER_YEAR as DPY } from '../../core/constants.js';
import { isDynastic, GOVERNMENTS } from './data.js';
import { fin, record, rulerRef } from './state.js';
import { theName, TheName, rulerName, rulerShort, pick, listJoin, seasonWord } from './prose.js';
import { makeRuler, installRuler, rulerAge, lifeOf, syncRulerDisplay, startDynasty, succession, newDynastyName } from './rulers.js';
import { roughPower } from './peoples.js';
import { grantTech, computeEra, refreshMods } from './tech.js';

const EXILE_CAP = 24, MARRIAGE_CAP = 60;
const UNION_GAP = 100 * DPY;
const civOf = (world, x) => (x == null ? null : typeof x === 'object' ? x : world.civs[x] || null);
const opposite = (g) => (g === 'f' ? 'm' : 'f');

// ---------------------------------------------------------------------------
// Heirs and spouses

function newHeir(world, civ, parent, ageYears) {
  const gender = world.rng.chance(0.5) ? 'm' : 'f';
  let name = makePerson(civ.language, world.rng);
  const hist = civ.rulerHistory || [];
  if (hist.length && world.rng.chance(0.35)) {
    const same = hist.filter((h) => h.dynasty && h.dynasty === parent.dynasty && h.gender === gender);
    if (same.length) name = world.rng.pick(same).name;
  }
  const born = world.time.day - Math.round(Math.max(0, ageYears) * lifeOf(world, civ, parent) * DPY);
  return { name, gender, born, relation: gender === 'f' ? 'daughter' : 'son' };
}

/** A newly crowned ruler's family: often a spouse already, sometimes an heir. */
export function heirOnInstall(world, civ, r) {
  r.heir ??= null;
  r.spouse ??= null;
  if (!isDynastic(civ.government)) return;
  const a = rulerAge(world, civ, r);
  if (!r.spouse && a >= 20 && world.rng.chance(0.7)) {
    r.spouse = { name: makePerson(civ.language, world.rng), fromCivId: civ.id, house: null, gender: opposite(r.gender) };
  }
  if (!r.heir && a >= 19) {
    const p = Math.min(0.8, (a - 18) / 22);
    if (world.rng.chance(p)) r.heir = newHeir(world, civ, r, world.rng.float(0, Math.min(a - 18, 30)));
  }
}

/** The heir in waiting at a succession (or null); the heir record is consumed. */
export function takeHeir(world, civ, prev) {
  const h = prev?.heir;
  if (!h || !h.name) return null;
  prev.heir = null;
  return { name: h.name, gender: h.gender, born: h.born, relation: h.relation, spouse: h.spouse ? { ...h.spouse } : null };
}

/**
 * A child on the throne gets a regent. Returns { age, regentPhrase } or null (an adult).
 */
export function startRegency(world, civ, heir, prev) {
  const age = rulerAge(world, civ, heir);
  if (!(age < 16)) { civ.flags.regent = null; return null; }
  const life = lifeOf(world, civ, heir);
  const kinds = prev?.spouse ? ['mother', 'uncle', 'chancellor', 'general'] : ['uncle', 'chancellor', 'general'];
  const kind = world.rng.pick(kinds);
  const name = kind === 'mother' ? prev.spouse.name : makePerson(civ.language, world.rng);
  const fem = kind === 'mother' ? (prev.spouse.gender ?? 'f') === 'f' : false;
  civ.flags.regent = {
    // a long-lived people's child is long a child, but no regency outlasts sixteen years
    name, kind, since: world.time.day, until: world.time.day + Math.round(Math.min(16, (16 - age) * life) * DPY), forId: heir.id,
    title: kind === 'mother' ? (fem ? 'the queen mother' : 'the king father') : kind === 'uncle' ? `${heir.gender === 'f' ? 'her' : 'his'} uncle` : kind === 'chancellor' ? 'the chancellor' : 'the general',
  };
  const st = world.sys.civ;
  if (st) st.counters.regencies = fin(st.counters.regencies) + 1;
  return { age: Math.max(1, Math.floor(age)), long: life > 1.5, regentPhrase: `${civ.flags.regent.title} ${name}` };
}

// ---------------------------------------------------------------------------
// Personal unions

/**
 * The other realm of a personal union: senior = false → civ's senior partner when civ is the
 * junior (null otherwise); senior = true → the junior partner when civ is the senior.
 */
export function unionPartner(world, civ, senior = false) {
  const u = civ?.flags?.union;
  if (!u) return null;
  if (Boolean(u.senior) !== Boolean(senior)) return null;
  const o = world.civs[u.withCivId];
  if (!o || !o.alive || !o.flags?.union || o.flags.union.withCivId !== civ.id) return null;
  return o;
}

/**
 * Hereditary realm, no heir in waiting: a realm holding a strong marriage claim (≥ 0.5) and
 * at least 0.6 × its power may inherit the crown in a personal union. Returns the chronicle
 * entry, or null when the ordinary succession should go on.
 */
export function unionSuccession(world, civ, prev, cause, died, base) {
  if (!isDynastic(civ.government) || prev.heir || civ.flags.heirSecured || civ.flags.union) return null;
  const day = world.time.day;
  if (day - fin(civ.flags.lastUnionDay, -1e9) < UNION_GAP) return null;
  const myPow = Math.max(1, roughPower(world, civ));
  let best = null, bs = 0;
  for (const c of liveCivs(world)) {
    if (c.id === civ.id || !c.ruler || !isDynastic(c.government) || c.flags?.union) continue;
    const claim = fin(c.claims?.[civ.id], 0);
    if (claim < 0.5 || areAtWar(world, c.id, civ.id)) continue;
    if (day - fin(c.flags?.lastUnionDay, -1e9) < UNION_GAP) continue;
    const pow = roughPower(world, c);
    if (pow < 0.6 * myPow) continue;
    const sc = claim * Math.min(3, pow / myPow);
    if (sc > bs) { bs = sc; best = c; }
  }
  if (!best || !world.rng.chance(0.6)) return null;
  const shared = makeRuler(world, civ, { person: { name: best.ruler.name, born: best.ruler.born, gender: best.ruler.gender }, dynasty: best.ruler.dynasty || best.dynasty });
  shared.id = best.ruler.id;                         // one person, two crowns
  shared.traits = (best.ruler.traits || []).slice();
  shared.epithet = best.ruler.epithet || null;
  if (best.ruler.gloss) shared.gloss = best.ruler.gloss;
  shared.relation = 'kinsman by marriage';
  shared.flags = { ...(best.ruler.flags || {}), union: true };
  if (shared.dynasty) startDynasty(world, civ, shared.dynasty, 'union', shared);
  installRuler(world, civ, shared, cause, { how: 'union' });
  shared.heir = null;
  shared.spouse = best.ruler.spouse ? { ...best.ruler.spouse } : null;
  syncRulerDisplay(shared);
  civ.flags.union = { withCivId: best.id, since: day, senior: false };
  best.flags.union = { withCivId: civ.id, since: day, senior: true };
  civ.flags.lastUnionDay = day; best.flags.lastUnionDay = day;
  civ.legitimacy = Math.max(0.45, fin(civ.legitimacy) * 0.8);
  delete best.claims[civ.id];
  addOpinion(world, civ.id, best.id, 20);
  const st = world.sys.civ;
  if (st) st.counters.personalUnions = fin(st.counters.personalUnions) + 1;
  const capB = world.settlements[best.capitalId];
  const e = record(world, {
    ...base, imp: 3, key: base.cat === 'divine' ? 'divine.smite_ruler' : 'succession.union', tags: ['union'],
    text: pick(world, [
      `${died} with no heir of ${prev.gender === 'f' ? 'her' : 'his'} body; by right of an old marriage the crown passed to ${rulerName(best.ruler)} of ${theName(best)}, and the two realms were joined under one ruler.`,
      `${died}, and the throne fell to ${rulerShort(best.ruler)} of ${theName(best)}, whose claim by marriage none could match; from ${capB ? capB.name : 'abroad'} one ruler now governed both crowns.`,
    ]),
  });
  const cap = world.settlements[civ.capitalId];
  if (cap && capB) emitFx(world, { type: 'thread', x: capB.x, y: capB.y, x2: cap.x, y2: cap.y, tone: 'marriage' });
  return e;
}

/**
 * A crown won in war (geo/war.js makePeace emits crownWon): the victor's ruler is crowned in the
 * loser's realm as well, a personal union like one by marriage, resolved the same way when the
 * shared ruler is gone. Only between hereditary crowns, neither already joined to another;
 * otherwise the peace names no crown. The treaty line tells of it.
 */
on('crownWon', (world, war, W, L) => {
  if (!W || !L || !W.alive || !L.alive || !W.ruler || !isDynastic(W.government) || !isDynastic(L.government)) return;
  if (W.flags?.union || L.flags?.union) return;
  const day = world.time.day;
  const shared = makeRuler(world, L, { person: { name: W.ruler.name, born: W.ruler.born, gender: W.ruler.gender }, dynasty: W.ruler.dynasty || W.dynasty });
  shared.id = W.ruler.id;                         // one person, two crowns
  shared.traits = (W.ruler.traits || []).slice();
  shared.epithet = W.ruler.epithet || null;
  if (W.ruler.gloss) shared.gloss = W.ruler.gloss;
  shared.relation = 'conqueror';
  shared.flags = { ...(W.ruler.flags || {}), union: true };
  if (shared.dynasty) startDynasty(world, L, shared.dynasty, 'union', shared);
  installRuler(world, L, shared, 'deposed', { how: 'union' });
  shared.heir = null;
  shared.spouse = W.ruler.spouse ? { ...W.ruler.spouse } : null;
  syncRulerDisplay(shared);
  L.flags.union = { withCivId: W.id, since: day, senior: false };
  W.flags.union = { withCivId: L.id, since: day, senior: true };
  L.flags.lastUnionDay = day; W.flags.lastUnionDay = day;
  L.legitimacy = Math.max(0.35, fin(L.legitimacy) * 0.7);
  if (W.claims) delete W.claims[L.id];
  const st = world.sys.civ;
  if (st) st.counters.unionsByWar = fin(st.counters.unionsByWar) + 1;
});

/** After any change of ruler: union bookkeeping, regencies of the old reign. */
export function onRulerGone(world, civ, prev, next, how) {
  const fl = civ.flags || {};
  if (fl.regent && fl.regent.forId !== next?.id) fl.regent = null;
  const u = fl.union;
  if (!u) return;
  const other = world.civs[u.withCivId];
  if (!other || !other.alive || other.flags?.union?.withCivId !== civ.id) { fl.union = null; return; }
  if (u.senior) resolveUnion(world, civ, other, prev, u.since);
  else {
    // the junior crown threw off the shared ruler (a coup, a revolution, a divine deposition)
    fl.union = null; other.flags.union = null;
    record(world, { cat: 'civ', imp: 3, key: 'dynasty.union.broken', civ, tags: ['union'], text: pick(world, [
      `${TheName(civ)} broke its union with ${theName(other)}; ${next ? rulerName(next) : 'a new ruler'} wore its crown alone.`,
      `The personal union of ${theName(civ)} and ${theName(other)} ended when ${theName(civ)} cast off ${prev ? rulerShort(prev) : 'the shared ruler'}.`,
    ]) });
  }
}

/** The shared ruler is gone: the junior realm merges into the senior, or breaks away. */
function resolveUnion(world, senior, junior, prev, since) {
  senior.flags.union = null;
  junior.flags.union = null;
  const day = world.time.day;
  const years = Math.max(1, Math.round((day - fin(since, day)) / DPY));
  const loyal = fin(junior.stability, 0.5) > 0.4 && fin(junior.flags.avgLoyal, 0.6) > 0.45;
  const st = world.sys.civ;
  if (loyal && world.rng.chance(0.55) && junior.settlementIds.length) {
    const oldName = theName(junior);
    const ids = junior.settlementIds.slice();
    for (const sid of ids) transferSettlement(world, sid, senior.id, 'union');
    for (const sid of ids) {
      const s = world.settlements[sid];
      if (s?.alive && s.civId === senior.id) { s.loyalty = Math.max(s.loyalty, 0.62); s.unrest = Math.min(s.unrest, 0.2); s.flags.assim = Math.max(fin(s.flags.assim), 0.6); s.flags.pacified = day; }
    }
    if (st) st.counters.unions++;
    record(world, { cat: 'civ', imp: 4, key: 'dynasty.union.merge', civ: senior, tags: ['union'], text: pick(world, [
      `With the passing of ${prev ? rulerShort(prev) : 'the shared ruler'}, the crowns of ${theName(senior)} and ${oldName} were united for good after ${years} years: ${oldName} passed into ${theName(senior)}.`,
      `After ${years} years under one ruler, ${oldName} was folded into ${theName(senior)}, and its own crown was laid up in the treasury of ${world.settlements[senior.capitalId]?.name || 'the capital'}.`,
    ]) });
    return;
  }
  // the junior crown goes its own way under a prince of its own
  const r = makeRuler(world, junior, { age: [24, 50] });
  if (isDynastic(junior.government)) {
    r.dynasty = junior.dynasty && junior.dynasty !== senior.dynasty ? junior.dynasty : null;
    if (!r.dynasty) { const name = newDynastyName(world, junior, r.name, { from: 'founder' }); startDynasty(world, junior, name, 'union ended', r); r.dynasty = name; }
  }
  installRuler(world, junior, r, 'union ended', { how: 'restoration' });
  junior.legitimacy = 0.5;
  let tail = '';
  const sp = roughPower(world, senior), jp = roughPower(world, junior);
  const warlike = (senior.ruler?.traits || []).some((t) => t === 'warlike' || t === 'ambitious' || t === 'cruel');
  if (sp > 1.4 * jp && warlike && world.rng.chance(0.5) && !areAtWar(world, senior.id, junior.id)) {
    const war = startWar(world, [senior.id], [junior.id], 'claim', `The War of the ${junior.adjective} Succession`);
    tail = `; ${theName(senior)} would not let it go, and ${war.name.replace(/^The /, 'the ')} began`;
  }
  record(world, { cat: 'civ', imp: tail ? 4 : 3, key: 'dynasty.union.end', civ: junior, ref: rulerRef(junior, r), tags: ['union', 'restoration'], text: `When ${prev ? rulerShort(prev) : 'the shared ruler'} was gone, ${theName(junior)} refused the heir of ${theName(senior)} and crowned ${rulerName(r)} of its own${tail}.` });
}

// ---------------------------------------------------------------------------
// Marriages and claims

/**
 * A royal match between two crowns (a, b: civs or ids). The stronger crown's ruler (or heir)
 * weds a prince or princess of the other: opinion and trust rise, and each house gains a
 * claim on the other's throne (the stronger 0.35, the weaker 0.2). opts: { divine, cause }.
 * Returns { ok, entry, seq, a, b, message } or { ok: false, reason }.
 */
export function arrangeMarriage(world, a, b, opts = {}) {
  const A0 = civOf(world, a), B0 = civOf(world, b);
  const chk = marriageCheck(world, A0, B0);
  if (!chk.ok) return chk;
  const [A, B] = roughPower(world, A0) >= roughPower(world, B0) ? [A0, B0] : [B0, A0];
  const day = world.time.day;
  // who stands at the altar on the stronger side: the ruler if unwed, else the heir, else a
  // prince or princess of the house (a cadet match still joins the bloodlines)
  const cadet = A.ruler.spouse && !(A.ruler.heir && !A.ruler.heir.spouse);
  const groomSide = !A.ruler.spouse ? A.ruler : !cadet ? A.ruler.heir
    : { name: makePerson(A.language, world.rng), gender: world.rng.chance(0.5) ? 'm' : 'f', born: A.ruler.born, cadet: true };
  const bride = { name: makePerson(B.language, world.rng), fromCivId: B.id, house: B.dynasty || null, gender: opposite(groomSide.gender) };
  if (!groomSide.cadet) groomSide.spouse = bride;
  for (const [x, y, v] of [[A, B, 0.35], [B, A, 0.2]]) {
    x.claims ||= {};
    x.claims[y.id] = Math.min(1, fin(x.claims[y.id], 0) + v);
  }
  addOpinion(world, A.id, B.id, opts.divine ? 30 : 15);
  for (const [x, y] of [[A, B], [B, A]]) { const r = rel(world, x.id, y.id); r.trust = Math.min(1, fin(r.trust, 0.5) + 0.1); }
  const st = world.sys.civ;
  if (st) {
    st.marriages.push({ a: A.id, b: B.id, day, house: B.dynasty || null });
    if (st.marriages.length > MARRIAGE_CAP) st.marriages.splice(0, st.marriages.length - MARRIAGE_CAP);
    st.counters.marriages = fin(st.counters.marriages) + 1;
  }
  const capA = world.settlements[A.capitalId], capB = world.settlements[B.capitalId];
  const where = capA || capB;
  const season = where ? seasonWord(world, where.y) : 'spring';
  const who = groomSide === A.ruler ? rulerName(A.ruler)
    : groomSide.cadet ? `${groomSide.name}, ${groomSide.gender === 'f' ? 'sister' : 'brother'} of ${rulerShort(A.ruler)}`
      : `${groomSide.name}, heir of ${rulerShort(A.ruler)}`;
  const houseB = houseOf(B);
  // a child is betrothed, not wed
  const young = rulerAge(world, A, groomSide) < 14;
  const wed = young ? 'betrothed' : 'wed';
  const kin = bride.gender === 'f' ? pick(world, ['daughter', 'sister', 'niece']) : pick(world, ['son', 'brother', 'nephew']);
  const text = opts.divine
    ? pick(world, [
      `Heaven made the match: ${who} of ${theName(A)} was ${wed} to ${bride.name}, ${kin} of ${rulerShort(B.ruler)} of ${theName(B)}, at ${where ? where.name : 'the border'}, and the two crowns were bound by blood.`,
      young ? `As if by a sign from the sky, ${theName(A)} and ${theName(B)} were joined by a betrothal: ${bride.name} ${houseB} was promised to the young ${who}.`
        : `As if by a sign from the sky, ${theName(A)} and ${theName(B)} were joined in marriage: ${bride.name} ${houseB} became the consort of ${who}.`,
    ])
    : pick(world, [
      `In the ${season} ${who} of ${theName(A)} ${young ? 'was betrothed to' : 'married'} ${bride.name}, ${kin} of ${rulerName(B.ruler)} of ${theName(B)}; the children of the match would have a claim to both crowns.`,
      `${bride.name} ${houseB} was ${young ? 'promised' : 'given in marriage'} to ${who} at ${where ? where.name : 'the border'}, binding ${theName(A)} and ${theName(B)} by blood.`,
      `The courts of ${theName(A)} and ${theName(B)} were joined when ${who} ${young ? 'was betrothed to' : 'wed'} ${bride.name}, ${kin} of ${rulerShort(B.ruler)}, with ${pick(world, ['three days of feasting', 'tourneys and a great hunt', 'gifts of horses and gold'])}.`,
    ]);
  const entry = record(world, {
    cat: opts.divine ? 'divine' : 'diplomacy', imp: opts.divine ? 3 : 2, key: opts.divine ? 'divine.arrange_marriage' : 'dynasty.marriage',
    civ: A, ref: rulerRef(A, A.ruler), tags: ['marriage'], cause: opts.cause ?? null,
    text,
  });
  if (capA && capB) emitFx(world, { type: 'thread', x: capA.x, y: capA.y, x2: capB.x, y2: capB.y, tone: 'marriage', ...(opts.divine ? { src: 'tool' } : {}) });
  return { ok: true, entry, seq: entry.seq, a: A.id, b: B.id, betrothal: young, message: `${TheName(A)} and ${theName(B)} are bound by ${young ? 'a betrothal' : 'marriage'}.` };
}

/** "of the House of Arkel", "of House Arkel", "of the Arkel dynasty", else "of the Kingdom of X". */
export function houseOf(civ) {
  const d = civ?.dynasty;
  if (!d) return `of ${theName(civ)}`;
  if (/^House of /i.test(d) || /dynasty$/i.test(d)) return `of the ${d.replace(/^the\s+/i, '')}`;
  return `of ${d}`;
}

/** Can these two crowns marry now? { ok, reason? } (pure). */
export function marriageCheck(world, A, B) {
  if (!A || !B || !A.alive || !B.alive) return { ok: false, reason: 'Two living realms are needed for a royal match.' };
  if (A.id === B.id) return { ok: false, reason: 'A crown cannot marry itself.' };
  if (!A.ruler || !B.ruler) return { ok: false, reason: 'Both realms need a ruler.' };
  if (!isDynastic(A.government) && !isDynastic(B.government)) return { ok: false, reason: `Neither ${theName(A)} nor ${theName(B)} is ruled by a royal house.` };
  if (areAtWar(world, A.id, B.id)) return { ok: false, reason: `${TheName(A)} and ${theName(B)} are at war.` };
  const st = world.sys.civ;
  const recent = st?.marriages?.find((m) => ((m.a === A.id && m.b === B.id) || (m.a === B.id && m.b === A.id)) && world.time.day - m.day < 25 * DPY);
  if (recent) return { ok: false, reason: `The houses of ${theName(A)} and ${theName(B)} were joined in Year ${Math.floor(recent.day / DPY)}; the courts will not marry again so soon.` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Monthly and yearly

/** Monthly: heirs are born and die, regencies run their course. */
export function dynastyMonthly(world, civ) {
  const r = civ.ruler;
  if (!r) return;
  const day = world.time.day;
  // heirs belong to a ruler's own crown (a junior realm in union wears a copy of the senior's ruler)
  const junior = civ.flags.union && !civ.flags.union.senior;
  if (isDynastic(civ.government) && !junior) {
    const a = rulerAge(world, civ, r);
    if (!r.heir) {
      if (a >= 18 && a < 55 && world.rng.chance(0.02)) {
        r.heir = newHeir(world, civ, r, 0);
        // a child of a foreign match carries a claim to its mother's or father's crown
        const home = r.spouse && r.spouse.fromCivId != null && r.spouse.fromCivId !== civ.id ? world.civs[r.spouse.fromCivId] : null;
        if (home && home.alive) { civ.claims ||= {}; civ.claims[home.id] = Math.min(1, fin(civ.claims[home.id], 0) + 0.25); }
      }
    } else {
      const ha = rulerAge(world, civ, r.heir);
      if (world.rng.chance(ha < 5 ? 0.004 : 0.0012)) {
        const lost = r.heir;
        r.heir = null;
        if (fin(civ.population) >= 50000 && world.rng.chance(0.25)) {
          record(world, { cat: 'civ', imp: 1, key: 'dynasty.heir.died', civ, ref: rulerRef(civ, r), text: pick(world, [
            `${lost.name}, the ${lost.relation} and heir of ${rulerName(r)}, died of a fever${ha < 12 ? ' in childhood' : ''}, and the court went into mourning.`,
            `The heir of ${theName(civ)}, ${lost.name}, was lost${ha < 12 ? ' as a child' : ''}; ${rulerShort(r)} had no other.`,
          ]) });
        }
      }
    }
  }
  const reg = civ.flags.regent;
  if (reg) {
    if (r.id !== reg.forId) { civ.flags.regent = null; return; }
    if (day >= reg.until) {
      civ.flags.regent = null;
      if (fin(civ.population) >= 8000) record(world, { cat: 'civ', imp: 1, key: 'dynasty.regency.end', civ, ref: rulerRef(civ, r), text: pick(world, [
        `${rulerName(r)} of ${theName(civ)} came of age and took the reins from ${reg.title} ${reg.name}.`,
        `The regency of ${reg.title} ${reg.name} ended; ${rulerShort(r)} of ${theName(civ)} now ruled in ${r.gender === 'f' ? 'her' : 'his'} own name.`,
      ]) });
      return;
    }
    civ.stability = Math.max(0, fin(civ.stability) - 0.003);
    if (Math.floor(day / 30) % 12 !== 0) return;
    // yearly perils of a minority: the regent reaches for the crown, or the child dies young
    const greedy = reg.kind === 'uncle' || reg.kind === 'general' ? 1.5 : 1;
    const pU = 0.02 * greedy * (1.3 - fin(civ.legitimacy, 0.5));
    if (world.rng.chance(pU)) { regentUsurps(world, civ, r, reg); return; }
    if (world.rng.chance(0.012)) murderedChild(world, civ, r, reg);
  }
}

function regentUsurps(world, civ, child, reg) {
  const nr = makeRuler(world, civ, { age: [30, 52], inherit: ['ambitious', 'cruel', 'paranoid'], person: { name: reg.name, gender: reg.kind === 'mother' ? 'f' : undefined } });
  const keep = reg.kind === 'uncle' || reg.kind === 'mother';
  const st = world.sys.civ;
  if (!keep) {
    const dn = newDynastyName(world, civ, reg.name, { from: 'founder' });
    startDynasty(world, civ, dn, 'usurped by a regent', nr);
    nr.dynasty = dn;
  } else nr.dynasty = child.dynasty || civ.dynasty;
  civ.flags.regent = null;
  installRuler(world, civ, nr, 'deposed', { how: 'usurper' });
  civ.legitimacy = 0.3;
  civ.stability = Math.max(0, fin(civ.stability) - 0.06);
  if (st) st.counters.regencyCoups = fin(st.counters.regencyCoups) + 1;
  record(world, { cat: 'civ', imp: 3, key: 'succession.crisis', civ, ref: rulerRef(civ, nr), tags: ['regency', 'usurper'], text: pick(world, [
    `${reg.title.charAt(0).toUpperCase() + reg.title.slice(1)} ${reg.name} set aside the young ${child.title.toLowerCase()} ${rulerShort(child)} and took the crown of ${theName(civ)}; the child was never seen outside the tower again.`,
    `The regency in ${theName(civ)} ended in usurpation: ${reg.name} crowned ${reg.kind === 'mother' ? 'herself' : 'himself'}, and ${rulerShort(child)} vanished from the record.`,
  ]) });
}

/** The child ruler is murdered: the succession runs its normal course (kin, crisis or war). */
function murderedChild(world, civ, child, reg) {
  civ.flags.regent = null;
  child.flags = { ...(child.flags || {}), murderedBy: reg.name };
  return succession(world, civ, 'murdered', {});
}

/** Yearly: claims fade, courts in exile plot their return. */
export function dynastyYearly(world) {
  const day = world.time.day;
  for (const c of world.civs) {
    if (!c || !c.alive || !c.claims) continue;
    for (const k of Object.keys(c.claims)) {
      const v = fin(c.claims[k], 0) * 0.98;
      const o = world.civs[+k];
      if (v < 0.05 || !o || !o.alive) delete c.claims[k]; else c.claims[k] = Math.round(v * 1000) / 1000;
    }
  }
  const st = world.sys.civ;
  if (!st || !st.exiles.length) return;
  for (const ex of st.exiles) {
    if (ex.used || day - ex.since > 150 * DPY) continue;
    const cands = [];
    for (const sid of ex.homeSids) {
      const s = world.settlements[sid];
      if (!s || !s.alive || s.civId === ex.hostCivId) continue;
      const holder = world.civs[s.civId];
      if (!holder || holder.capitalId === s.id) continue;
      if (s.originCivId === ex.civId && fin(s.flags?.assim, 1) < 0.5 && s.unrest > 0.4) cands.push(s);
    }
    if (!cands.length || !world.rng.chance(0.05)) continue;
    restoration(world, ex, cands);
    break; // one restoration a year at most
  }
}

function restoration(world, ex, cands) {
  const old = world.civs[ex.civId];
  if (!old) return;
  cands.sort((a, b) => b.population - a.population || a.id - b.id);
  const seed = cands[0];
  const holder = world.civs[seed.civId];
  const cluster = [seed, ...cands.slice(1).filter((s) => s.civId === seed.civId && Math.hypot(s.x - seed.x, s.y - seed.y) <= 10)].slice(0, 4);
  const gov = GOVERNMENTS[old.government] && isDynastic(old.government) ? old.government : 'kingdom';
  const civ = createCiv(world, {
    name: old.baseName, adjective: old.adjective, language: JSON.parse(JSON.stringify(old.language)),
    x: seed.x, y: seed.y, government: gov, race: old.race ?? null, traits: old.traits,
  });
  // the old colours, when no living realm wears them
  if (Number.isFinite(ex.hue) && !world.civs.some((c) => c.alive && c.id !== civ.id && Math.min(Math.abs(c.hue - ex.hue), 360 - Math.abs(c.hue - ex.hue)) < 20)) {
    civ.hue = ex.hue; civ.color = old.color.slice(); civ.colorHex = old.colorHex;
  }
  // the towns lived under their masters' learning: the restored crown keeps it
  const teacher = holder && holder.tech ? holder : old;
  for (const id in teacher.tech?.known || {}) grantTech(civ, id, world.time.day, `i:${teacher.id}`);
  civ.tech.era = Math.max(fin(civ.tech.era, 0), computeEra(civ));
  refreshMods(world, civ);
  for (const s of cluster) transferSettlement(world, s.id, civ.id, 'rebellion');
  for (const s of cluster) if (s.alive && s.civId === civ.id) { s.loyalty = 0.75; s.unrest = 0.15; s.flags.assim = 1; s.flags.seceded = world.time.day; }
  civ.flags.restored = old.id;
  civ.flags.independence = world.time.day;
  civ.stability = 0.6; civ.legitimacy = 0.6;
  if (ex.dynasty && civ.ruler) {
    startDynasty(world, civ, ex.dynasty, 'restored', civ.ruler);
    civ.ruler.dynasty = ex.dynasty;
    civ.flags.dynasty.rulers = 1;
    syncRulerDisplay(civ.ruler);
  }
  ex.used = world.time.day;
  const st = world.sys.civ;
  st.counters.restorations = fin(st.counters.restorations) + 1;
  const host = world.civs[ex.hostCivId];
  const years = Math.round((world.time.day - ex.since) / DPY);
  let tail = '';
  if (holder && holder.alive && roughPower(world, holder) > 1.3 * roughPower(world, civ) && world.rng.chance(0.4) && !areAtWar(world, holder.id, civ.id)) {
    const war = startWar(world, [holder.id], [civ.id], 'restoration', `The War of the ${civ.adjective} Restoration`);
    tail = `; ${theName(holder)} marched to crush it, and ${war.name.replace(/^The /, 'the ')} began`;
  }
  const names = cluster.map((s) => s.name);
  record(world, {
    cat: 'civ', imp: 4, key: 'dynasty.restoration', civ, tags: ['restoration'],
    text: pick(world, [
      years >= 2
        ? `After ${years} years in exile${host ? ` at the court of ${theName(host)}` : ''}, ${ex.dynasty || 'the old royal house'} came home: ${listJoin(names)} rose for the old crown, and ${theName(civ)} was restored${tail}.`
        : `Scarcely a year after its fall, ${listJoin(names)} rose for ${ex.dynasty || 'the old royal house'}${host ? `, still in exile at the court of ${theName(host)},` : ''} and ${theName(civ)} was restored${tail}.`,
      `${listJoin(names)} threw off ${holder ? theName(holder) : 'their masters'} and called back the exiled heirs of ${ex.ruler || ex.name}; ${theName(civ)} lived again${tail}.`,
    ]),
  });
  emitFx(world, { type: 'rebellion', x: seed.x, y: seed.y, civId: civ.id });
}

// ---------------------------------------------------------------------------
// Falls: exiled courts, broken unions

const EXILE_CAUSES = new Set(['conquest', 'razed', 'sack', 'annexation', 'capture']);

/** A conquered royal realm's court flees to a friend or kinsman, if it has one. */
export function exileOnFall(world, civ, cause) {
  const st = world.sys.civ;
  if (!st || !EXILE_CAUSES.has(cause) || !civ.ruler || !civ.dynasty) return;
  const conqueror = world.settlements[civ.flags?.capitalSid]?.civId ?? null;
  const homeSids = world.settlements.filter((s) => s.alive && s.originCivId === civ.id).sort((a, b) => b.population - a.population || a.id - b.id).slice(0, 8).map((s) => s.id);
  if (homeSids.length < 2) return;
  let host = null, bs = 29;
  for (const k in civ.relations || {}) {
    const o = world.civs[+k];
    if (!o || !o.alive || o.id === conqueror || o.id === civ.id) continue;
    const kin = o.parentId === civ.id || civ.parentId === o.id;
    const sc = fin(civ.relations[k]?.opinion, 0) + (kin ? 40 : 0) + (fin(civ.relations[k]?.trust, 0.5) - 0.5) * 30;
    if (sc > bs) { bs = sc; host = o; }
  }
  if (!host) return;
  const ex = {
    id: st.exiles.length ? st.exiles[st.exiles.length - 1].id + 1 : 1, civId: civ.id, name: civ.baseName, adjective: civ.adjective,
    hue: civ.hue, colorHex: civ.colorHex, dynasty: civ.dynasty, ruler: rulerName(civ.ruler), hostCivId: host.id, homeSids, since: world.time.day, used: null,
  };
  st.exiles.push(ex);
  while (st.exiles.length > EXILE_CAP) {
    const k = st.exiles.findIndex((e) => e.used || world.time.day - e.since > 150 * DPY);
    st.exiles.splice(k >= 0 ? k : 0, 1);
  }
  const capH = world.settlements[host.capitalId];
  record(world, {
    cat: 'civ', imp: 2, key: 'dynasty.exile', civ: host, tags: ['exile'], ref: { k: 'civ', id: civ.id },
    text: pick(world, [
      `${rulerName(civ.ruler)} and the remnant of the court of ${theName(civ)} fled to ${capH ? capH.name : 'a foreign court'}, where ${theName(host)} gave them shelter and their banners were kept unfurled.`,
      `The fallen ${civ.dynasty} went into exile at the court of ${theName(host)}, swearing to return.`,
    ]),
  });
}

/** A realm falls: its union partner rules alone again. */
export function onCivFall(world, civ) {
  const u = civ.flags?.union;
  if (!u) return;
  const other = world.civs[u.withCivId];
  civ.flags.union = null;
  if (!other || !other.alive || other.flags?.union?.withCivId !== civ.id) return;
  other.flags.union = null;
  if (!u.senior) return;
  // the senior fell: the junior crown keeps the person, now its own ruler alone
  if (other.ruler) { other.ruler.flags = { ...(other.ruler.flags || {}) }; delete other.ruler.flags.union; }
}

// ---------------------------------------------------------------------------
// Providers (pure; neutral when no claim, exile or union applies)

registerProvider('allied', 'civ.dynasty', (world, a, b) => {
  const A = civOf(world, a), B = civOf(world, b);
  return Boolean(A && B && A.flags?.union && A.flags.union.withCivId === B.id && B.flags?.union?.withCivId === A.id);
});

registerProvider('casusBelli', 'civ.dynasty', (world, a, b) => {
  const A = civOf(world, a), B = civOf(world, b);
  if (!A || !B || A.id === B.id) return null;
  let out = null;
  const claim = fin(A.claims?.[B.id], 0);
  if (claim >= 0.4 && !(A.flags?.union && A.flags.union.withCivId === B.id)) (out ||= []).push({ cb: 'claim', w: 0.8 + claim, name: `The War of the ${B.adjective} Succession` });
  const ex = world.sys.civ?.exiles;
  if (ex && ex.length) {
    for (const e of ex) {
      if (e.used || e.hostCivId !== A.id || world.time.day - e.since > 150 * DPY) continue;
      let goal = null;
      for (const sid of e.homeSids) { const s = world.settlements[sid]; if (s && s.alive && s.civId === B.id) { goal = s; break; } }
      if (goal) { (out ||= []).push({ cb: 'restoration', w: 1.4, name: `The War of the ${e.adjective} Restoration`, goalSid: goal.id }); break; }
    }
  }
  return out;
});
