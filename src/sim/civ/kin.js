// Royal kin (chunk 9, docs/design/dynasties.md): the families of the ruling houses. Each kept
// person is a small plain record in sys.civ.kin.p, linked to the others by id (no shared
// objects: a ruler's own record stays civ.ruler, under the same id):
//
//   person = { id, n, g, b, d?, dc?, f?, m?, h, c, sp: [ids], ch: [ids], bas?, leg?, dep?, nb?, ra?, r?, am? }
//     name, sex, born, died and how, father, mother, house (a dynasty name; null for the nobles
//     who marry in), court (the realm they live at; for the dead, the last one), spouses (the
//     latest last), children (by birth), a bastard, legitimised, set aside (a deposed ruler or
//     an heir sent into exile: alive, out of the line), a noble married in (not followed
//     further), their people (Mythic, when not the realm's), ruled (the realm's id), the
//     ambition of an heir who stepped back from the head of the line
//   kin = { p: { [id]: person }, v }   v counts changes (the court index in world.cache)
//
// Who is kept: the living of a ruling house within four steps of blood from its ruler
// (children and grandchildren, brothers and sisters, nephews, uncles, cousins; at most 40),
// their spouses, the dead between them, and the realm's last thirty rulers; the rest are let go
// at the yearly prune. The world's yearly sweep lets go the courts of fallen realms (save a
// court in exile) and of realms no longer ruled by a house.
//
// Yearly at the realm's own month (kinYearly): deaths, births, marriages at home, bastards, the
// prune, then the heir (ruler.heir, the shape the rest of the code reads) is filled from the line.
// Draws from world.rng in a fixed order (the court by id).
//
// The line (lineOf): the holder's lawful children in order by the heir rule, each followed by
// their own line; then the holder's brothers and sisters and their lines; then uncles and
// cousins. A realm under 'seniority' takes the eldest grown member of the house first. Members
// living at another court come after all those at home (a princess married abroad, her
// children): the next in blood abroad is reached only when the house at home has died out.
//
// Ext: heirRule (world, civ) → 'male' (sons before daughters), 'equal' (the eldest child) or
// 'strong' (the strongest grown child); houseRule (world, civ) → 'father' | 'mother';
// royalBirths (mul); bastardRule (world, civ) → false for a people without bastards.

import { makePerson } from '../../core/names.js';
import { DAYS_PER_YEAR as DPY } from '../../core/constants.js';
import { temperOf, skillsOf, TP, SK } from '../../core/character.js';
import { firstOf, hasProviders, mulOf } from '../../core/ext.js';
import { on } from '../../core/hooks.js';
import { isDynastic } from './data.js';
import { fin, record, rulerRef } from './state.js';
import { theName, rulerName, rulerShort, pick } from './prose.js';

const KEEP_DEPTH = 4, COURT_CAP = 40, RULERS_KEPT = 30;
const opposite = (g) => (g === 'f' ? 'm' : 'f');

export function kinState(world) {
  const st = world.sys.civ;
  if (!st) return null;
  if (!st.kin || typeof st.kin !== 'object' || !st.kin.p) st.kin = { p: {}, v: 0 };
  return st.kin;
}
export function kinOf(world, id) {
  if (id == null) return null;
  const k = world.sys.civ && world.sys.civ.kin;
  return (k && k.p[id]) || null;
}
const alive = (p) => Boolean(p) && p.d == null;
const touched = (kin) => { kin.v = fin(kin.v) + 1; };

/** A person's people's years divisor (elves count slowly). */
function lifeOfP(world, civ, p) {
  if (!hasProviders('lifespan')) return 1;
  const v = mulOf('lifespan', world, civ, p && p.ra ? { race: p.ra } : null);
  return v > 0 ? v : 1;
}
const ageOf = (world, civ, p) => (world.time.day - fin(p.b, world.time.day)) / DPY / lifeOfP(world, civ, p);

/** The living members of each court: Map civId → [person] (cached until the kin change). */
export function courts(world) {
  const kin = kinState(world);
  if (!kin) return new Map();
  const c = world.cache.kinCourts;
  if (c && c.v === kin.v && c.kin === kin) return c.m;
  const m = new Map();
  for (const id in kin.p) {
    const p = kin.p[id];
    if (!alive(p)) continue;
    let a = m.get(p.c);
    if (!a) m.set(p.c, (a = []));
    a.push(p);
  }
  world.cache.kinCourts = { v: kin.v, kin, m };
  return m;
}
export const courtOf = (world, civId) => courts(world).get(civId) || [];

/** Who comes first among a parent's children: the realm's heir rule. */
export function heirRuleOf(world, civ) {
  const own = hasProviders('heirRule') ? firstOf('heirRule', world, civ) : null;
  if (own === 'male' || own === 'equal' || own === 'strong') return own;
  return fin(civ?.tech?.era, 0) >= 5 ? 'equal' : 'male';
}
const houseRuleOf = (world, civ) => (hasProviders('houseRule') && firstOf('houseRule', world, civ) === 'mother' ? 'mother' : 'father');
const bastardsOk = (world, civ) => !(hasProviders('bastardRule') && firstOf('bastardRule', world, civ) === false);

/** A stable number in [0, 1) for a person (the strongest child under 'strong'). */
function grain(p) {
  let h = 2166136261 ^ 0x9e37;
  const s = `${p.n}:${p.b}:${p.id}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/** A person as the character module reads them (temperament from name, birth and id). */
export function personView(p) {
  return p ? { id: p.id, name: p.n, born: p.b, gender: p.g, traits: [], ...(p.ra ? { race: p.ra } : {}) } : null;
}

const lawful = (p) => !p.bas || p.leg;

/** A parent's lawful children, in the order the heir rule puts them. */
function kidsInOrder(world, civ, kin, p, rule) {
  const out = [];
  for (const id of p.ch || []) { const k = kin.p[id]; if (k && lawful(k)) out.push(k); }
  if (out.length < 2) return out;
  if (rule === 'male') out.sort((a, b) => (a.g === b.g ? a.b - b.b : a.g === 'm' ? -1 : 1));
  else if (rule === 'strong') {
    const grown = (k) => ageOf(world, civ, k) >= 16;
    out.sort((a, b) => {
      const ga = grown(a), gb = grown(b);
      if (ga !== gb) return ga ? -1 : 1;
      return ga ? grain(b) - grain(a) || a.b - b.b : a.b - b.b;
    });
  } else out.sort((a, b) => a.b - b.b);
  return out;
}

/** The parent through whom the house came down (the father, or the royal parent of a noble match). */
function houseParent(kin, p, mode) {
  const fa = p.f != null ? kin.p[p.f] : null, mo = p.m != null ? kin.p[p.m] : null;
  const first = mode === 'mother' ? mo : fa, second = mode === 'mother' ? fa : mo;
  if (first && !first.nb) return first;
  if (second && !second.nb) return second;
  return first || second || null;
}

/**
 * The line of succession after `holder` (a person record; the ruler, alive or just dead):
 * person records, the first in line first. Only the living, lawful and not set aside; those at
 * home first, then those at other courts (opts.abroad false: home only). opts.max (default 12).
 */
export function lineOf(world, civ, holder, opts = {}) {
  const kin = kinState(world);
  if (!kin || !holder) return [];
  const rule = heirRuleOf(world, civ), mode = houseRuleOf(world, civ);
  const max = opts.max || 12;
  const seen = new Set([holder.id]);
  const order = [];
  const walk = (p, depth) => {
    for (const k of kidsInOrder(world, civ, kin, p, rule)) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      if (alive(k) && !k.dep) order.push(k);
      if (depth < 4) walk(k, depth + 1);
    }
  };
  walk(holder, 0);
  let cur = holder;
  for (let up = 0; up < 3; up++) {
    const par = houseParent(kin, cur, mode);
    if (!par || seen.has(par.id)) break;
    seen.add(par.id);
    if (alive(par) && !par.dep && lawful(par)) order.push(par);
    walk(par, 0);
    cur = par;
  }
  const home = civ ? civ.id : holder.c;
  let out = order.filter((p) => p.c === home);
  if ((civ?.laws?.inherit) === 'seniority' && holder.h) {
    const grown = out.filter((p) => p.h === holder.h && ageOf(world, civ, p) >= 16).sort((a, b) => a.b - b.b);
    if (grown.length) out = [...grown, ...out.filter((p) => !grown.includes(p))];
  }
  if (opts.abroad !== false) for (const p of order) if (p.c !== home) out.push(p);
  return out.slice(0, max);
}

/** How q is kin to p, in words ("son", "niece", "cousin", "bastard son"); null when not near. */
export function relationWords(world, p, q) {
  if (!p || !q) return null;
  const kin = kinState(world);
  const m = q.g === 'f';
  if ((p.sp || []).includes(q.id)) return m ? 'wife' : 'husband';
  const up = (x) => [x.f, x.m].map((id) => (id != null ? kin.p[id] : null)).filter(Boolean);
  // ancestors of p by depth (p itself at 0)
  const anc = new Map([[p.id, 0]]);
  let ring = [p];
  for (let d = 1; d <= 3; d++) { const nx = []; for (const x of ring) for (const a of up(x)) if (!anc.has(a.id)) { anc.set(a.id, d); nx.push(a); } ring = nx; }
  let best = null;
  const seen = new Set([q.id]);
  ring = [q];
  if (anc.has(q.id)) best = [anc.get(q.id), 0];
  for (let j = 1; j <= 3 && !best; j++) {
    const nx = [];
    for (const x of ring) for (const a of up(x)) {
      if (seen.has(a.id)) continue;
      seen.add(a.id); nx.push(a);
      if (anc.has(a.id) && (!best || anc.get(a.id) + j < best[0] + best[1])) best = [anc.get(a.id), j];
    }
    ring = nx;
  }
  if (!best) return null;
  const [i, j] = best;
  const bas = q.bas && !q.leg ? 'bastard ' : '';
  if (i === 0) return bas + (j === 1 ? (m ? 'daughter' : 'son') : j === 2 ? (m ? 'granddaughter' : 'grandson') : (m ? 'great-granddaughter' : 'great-grandson'));
  if (j === 0) return i === 1 ? (m ? 'mother' : 'father') : i === 2 ? (m ? 'grandmother' : 'grandfather') : (m ? 'great-grandmother' : 'great-grandfather');
  if (i === 1 && j === 1) return bas + (m ? 'sister' : 'brother');
  if (i === 1 && j === 2) return m ? 'niece' : 'nephew';
  if (i === 1 && j === 3) return m ? 'grandniece' : 'grandnephew';
  if (i === 2 && j === 1) return m ? 'aunt' : 'uncle';
  if (i === 3 && j === 1) return m ? 'great-aunt' : 'great-uncle';
  if (i === 2 && j === 2) return 'cousin';
  return m ? 'kinswoman' : 'kinsman';
}

// ---------------------------------------------------------------------------
// Making people

/** A new kept person (no links made beyond the ones given). */
export function addPerson(world, o) {
  const kin = kinState(world);
  const st = world.sys.civ;
  const id = o.id != null ? o.id : st.nextPersonId++;
  const p = { id, n: o.n, g: o.g, b: Math.round(o.b), h: o.h ?? null, c: o.c, sp: [], ch: [] };
  if (o.f != null) p.f = o.f;
  if (o.m != null) p.m = o.m;
  if (o.bas) p.bas = 1;
  if (o.nb) p.nb = 1;
  if (o.ra != null) p.ra = o.ra;
  if (o.d != null) { p.d = Math.round(o.d); if (o.dc) p.dc = o.dc; }
  if (o.r != null) p.r = o.r;
  kin.p[id] = p;
  touched(kin);
  return p;
}
const wed = (a, b) => { if (!a.sp.includes(b.id)) a.sp.push(b.id); if (!b.sp.includes(a.id)) b.sp.push(a.id); };
const linkChild = (par, k) => { if (par && !par.ch.includes(k.id)) par.ch.push(k.id); };

/** The person's living spouse, if any. */
export function spouseOf(world, p) {
  if (!p || !p.sp || !p.sp.length) return null;
  for (let i = p.sp.length - 1; i >= 0; i--) { const s = kinOf(world, p.sp[i]); if (alive(s)) return s; }
  return null;
}

/** A child's name: often a grandparent's or a past ruler's of the house. */
function childName(world, civ, kin, g, fa, mo) {
  const rng = world.rng;
  if (rng.chance(0.4)) {
    const pool = [];
    for (const par of [fa, mo]) {
      if (!par) continue;
      for (const id of [par.f, par.m]) { const a = id != null ? kin.p[id] : null; if (a && a.g === g) pool.push(a.n); }
      if (par.g === g) pool.push(par.n);
    }
    for (const h of civ.rulerHistory || []) if (h.gender === g && h.dynasty && h.dynasty === (fa?.h || mo?.h)) pool.push(h.name);
    // never the name of another living at court (a son may take his father's, once)
    const taken = new Set();
    for (const k of courtOf(world, (fa || mo)?.c ?? civ.id)) if (k !== fa && k !== mo) taken.add(k.n);
    const free = pool.filter((n) => !taken.has(n));
    if (free.length) return rng.pick(free);
  }
  return makePerson(civ.language, rng);
}

/** A child born to a couple (or a father alone: a bastard). Returns the child. */
export function kinBorn(world, civ, mo, fa, opts = {}) {
  const kin = kinState(world);
  const g = opts.g || (world.rng.chance(0.51) ? 'm' : 'f');
  const mode = houseRuleOf(world, civ);
  const royal = mode === 'mother' ? (mo && !mo.nb ? mo : fa) : (fa && !fa.nb ? fa : mo);
  const k = addPerson(world, {
    n: childName(world, civ, kin, g, fa, mo), g, b: opts.b ?? world.time.day, h: royal ? royal.h : (civ.dynasty || null),
    c: (fa && fa.c) ?? (mo && mo.c) ?? civ.id, f: fa ? fa.id : null, m: mo ? mo.id : null, bas: opts.bas,
    ra: (mo && mo.ra) ?? (fa && fa.ra) ?? null,
  });
  linkChild(fa, k); linkChild(mo, k);
  return k;
}

/** A name of the realm's tongue that is not `not` (a spouse is never their partner's namesake). */
function otherName(world, civ, not) {
  let n = makePerson(civ.language, world.rng);
  for (let k = 0; k < 3 && n === not; k++) n = makePerson(civ.language, world.rng);
  return n;
}

/** A noble of the realm married to p (made now). */
export function marryNoble(world, civ, p) {
  const age = ageOf(world, civ, p);
  const life = lifeOfP(world, civ, p);
  const gap = p.g === 'm' ? -world.rng.int(0, 8) : world.rng.int(0, 8);
  const sAge = Math.max(15, age + gap);
  const s = addPerson(world, { n: otherName(world, civ, p.n), g: opposite(p.g), b: world.time.day - sAge * life * DPY - world.rng.int(0, 359), h: null, nb: 1, c: p.c, ra: p.ra ?? null });
  wed(p, s);
  return s;
}

/**
 * A royal match between crowns A (the stronger, whose court the bride or groom joins) and B:
 * the kept person on A's side (the ruler, the heir, or a prince or princess of the house) and
 * one of B's house (unwed, lawful, of age, not its ruler or heir; one is made, a kinswoman or
 * kinsman of its ruler, when the court has none), wed. B's match moves to A's court.
 * side: the ruler or heir object at the altar, or null for a cadet. Returns { groom, bride } or null.
 */
export function matchKin(world, A, B, side, gender) {
  if (!isDynastic(A.government) || !A.ruler) return null;
  const meA = personOfRuler(world, A, A.ruler);
  if (!meA) return null;
  const day = world.time.day;
  const unwed = (civ, p, g, lo, hi) => {
    if (!alive(p) || p.nb || p.dep || !lawful(p) || p.g !== g || spouseOf(world, p)) return false;
    const a = ageOf(world, civ, p);
    return a >= lo && a < hi;
  };
  // an heir from before the tree was seeded: find them in it by name and birth
  if (side && side.id == null) { const q = courtOf(world, A.id).find((p) => p.n === side.name && p.b === Math.round(fin(side.born, -1))); if (q) side.id = q.id; }
  let groom = side && side.id != null ? kinOf(world, side.id) : null;
  if (!groom) {
    const g = gender || 'm';
    groom = courtOf(world, A.id).filter((p) => p.id !== A.ruler.id && unwed(A, p, g, 14, 40)).sort((a, b) => a.b - b.b)[0] || null;
    if (!groom) groom = addPerson(world, { n: makePerson(A.language, world.rng), g, b: day - world.rng.int(16, 30) * lifeOfP(world, A, null) * DPY, h: A.dynasty || null, c: A.id, f: meA.f ?? null });
    const fa = groom.f != null ? kinOf(world, groom.f) : null;
    if (fa) linkChild(fa, groom);
  }
  const bg = opposite(groom.g);
  let bride = null;
  if (isDynastic(B.government) && B.ruler) {
    const meB = personOfRuler(world, B, B.ruler);
    const heirB = B.ruler.heir ? B.ruler.heir.id : null;
    bride = courtOf(world, B.id).filter((p) => p.id !== B.ruler.id && p.id !== heirB && unwed(B, p, bg, 14, 36)).sort((a, b) => a.b - b.b)[0] || null;
    if (!bride) bride = addPerson(world, { n: makePerson(B.language, world.rng), g: bg, b: day - world.rng.int(15, 26) * lifeOfP(world, B, null) * DPY, h: B.dynasty || null, c: B.id, f: meB ? meB.f ?? null : null });
    const fa = bride.f != null ? kinOf(world, bride.f) : null;
    if (fa) linkChild(fa, bride);
  } else bride = addPerson(world, { n: makePerson(B.language, world.rng), g: bg, b: groom.b + world.rng.int(-4, 6) * DPY, h: null, nb: 1, c: A.id });
  bride.c = A.id;
  wed(groom, bride);
  touched(kinState(world));
  return { groom, bride };
}

/** The person is dead (cause: 'old age', 'illness', 'childbed', 'battle', 'executed' …). */
export function kinDied(world, id, cause = null) {
  const p = kinOf(world, id);
  if (!p || p.d != null) return p;
  p.d = world.time.day;
  if (cause) p.dc = cause;
  touched(kinState(world));
  return p;
}
/** The person is set aside (deposed, exiled): alive but out of every line. */
export function kinSetAside(world, id) {
  const p = kinOf(world, id);
  if (p && p.d == null && !p.dep) { p.dep = 1; touched(kinState(world)); }
  return p;
}

/** The kin record of a ruler, made (with the family around them) if the tree lacks it. */
export function personOfRuler(world, civ, r) {
  if (!r || r.id == null) return null;
  return kinOf(world, r.id) || seedFamily(world, civ, r);
}

/**
 * A ruler with no family on record (an old save, a new realm, a usurper's new house): make the
 * ruler's record and a family to fit: a spouse (r.spouse, or one made), children for the years
 * married (r.heir among them), brothers and sisters, and dead parents to join them (the
 * predecessor, when the history says the ruler was their child).
 */
export function seedFamily(world, civ, r) {
  const rng = world.rng, day = world.time.day;
  const life = Math.max(0.2, lifeOfP(world, civ, r.race ? { ra: r.race } : null));
  const yrs = (n) => n * life * DPY;
  const house = r.dynasty || civ.dynasty || null;
  const me = addPerson(world, { id: r.id, n: r.name, g: r.gender === 'f' ? 'f' : 'm', b: fin(r.born, day - yrs(30)), h: house, c: civ.id, r: civ.id });
  const age = (day - me.b) / DPY / life;
  // the parents: the predecessor if the ruler was their child, else a father of the house
  const hist = civ.rulerHistory || [];
  const pred = hist.length ? hist[hist.length - 1] : null;
  const child = /^(son|daughter|heir)$/.test(String(r.relation || ''));
  let fa = null, mo = null;
  if (pred && child && pred.id != null && pred.id !== r.id && !kinOf(world, pred.id)) {
    const pg = pred.gender === 'f' ? 'f' : 'm';
    const par = addPerson(world, { id: pred.id, n: pred.name, g: pg, b: fin(pred.born, me.b - yrs(28)), h: pred.dynasty || house, c: civ.id, d: fin(pred.reignEnd, day), dc: pred.cause || null, r: civ.id });
    const other = addPerson(world, { n: pred.spouse?.name || makePerson(civ.language, rng), g: opposite(pg), b: par.b + yrs(rng.int(-2, 6)), h: null, nb: 1, c: civ.id, d: day - yrs(rng.int(0, 10)) });
    wed(par, other);
    [fa, mo] = pg === 'm' ? [par, other] : [other, par];
  } else if (age > 12) {
    fa = addPerson(world, { n: makePerson(civ.language, rng), g: 'm', b: me.b - yrs(rng.int(22, 38)), h: house, c: civ.id, d: day - yrs(rng.int(0, Math.max(1, Math.floor(age - 12)))) });
    mo = addPerson(world, { n: makePerson(civ.language, rng), g: 'f', b: fa.b + yrs(rng.int(0, 8)), h: null, nb: 1, c: civ.id, d: day - yrs(rng.int(0, Math.max(1, Math.floor(age - 10)))) });
    wed(fa, mo);
  }
  if (fa) { me.f = fa.id; linkChild(fa, me); }
  if (mo) { me.m = mo.id; linkChild(mo, me); }
  // brothers and sisters
  if (fa || mo) {
    const n = rng.int(0, 3);
    for (let i = 0; i < n; i++) {
      const sb = kinBorn(world, civ, mo, fa, { b: me.b + yrs(rng.int(-6, 10)) });
      const sAge = (day - sb.b) / DPY / life;
      if (sAge < 0) { removePerson(world, sb); continue; }
      if (sAge > 18 && rng.chance(0.6)) {
        const sp = marryNoble(world, civ, sb);
        const [w, h] = sb.g === 'f' ? [sb, sp] : [sp, sb];
        const kids = Math.min(rng.int(0, 3), Math.floor((sAge - 18) / 2));
        for (let k = 0; k < kids; k++) kinBorn(world, civ, w, h, { b: day - yrs(rng.int(0, Math.max(1, Math.floor(sAge - 19)))) });
      }
    }
  }
  // spouse and children
  let sp = null;
  if (r.spouse && r.spouse.name) {
    sp = addPerson(world, { n: r.spouse.name, g: r.spouse.gender || opposite(me.g), b: me.b + yrs(me.g === 'm' ? rng.int(0, 8) : -rng.int(0, 8)), h: r.spouse.house || null, nb: r.spouse.house ? undefined : 1, c: civ.id });
    wed(me, sp);
  } else if (age >= 20 && rng.chance(0.7)) {
    sp = marryNoble(world, civ, me);
    r.spouse = { name: sp.n, fromCivId: civ.id, house: null, gender: sp.g };
  }
  if (sp) {
    const [w, h] = me.g === 'f' ? [me, sp] : [sp, me];
    const wAge = (day - w.b) / DPY / life;
    const span = Math.max(0, Math.min(wAge, 44) - 18);
    const kids = Math.min(5, Math.floor(span * rng.float(0.05, 0.22)));
    const heir = r.heir && r.heir.name ? r.heir : null;
    for (let k = 0; k < kids; k++) kinBorn(world, civ, w, h, { b: day - yrs(rng.float(0, span)) });
    if (heir) {
      const hk = kinBorn(world, civ, w, h, { g: heir.gender === 'f' ? 'f' : 'm', b: Math.min(day, fin(heir.born, day)) });
      hk.n = heir.name;
    }
  }
  return me;
}

function removePerson(world, p) {
  const kin = kinState(world);
  for (const id of [p.f, p.m]) { const par = id != null ? kin.p[id] : null; if (par) par.ch = par.ch.filter((x) => x !== p.id); }
  for (const id of p.sp || []) { const s = kin.p[id]; if (s) s.sp = s.sp.filter((x) => x !== p.id); }
  delete kin.p[p.id];
  touched(kin);
}

// ---------------------------------------------------------------------------
// The heir

/** Fill ruler.heir from the line (home only): the same object while the same person leads it. */
export function syncHeir(world, civ) {
  const r = civ.ruler;
  if (!r || !isDynastic(civ.government) || (civ.flags.union && !civ.flags.union.senior)) return;
  const me = kinOf(world, r.id);
  if (!me) return;
  const first = lineOf(world, civ, me, { abroad: false, max: 1 })[0] || null;
  const h = r.heir;
  if (h && first && h.id === first.id) { h.relation = relationWords(world, me, first) || h.relation; return; }
  if (h && h.id != null && h.am) { const was = kinOf(world, h.id); if (was && was.d == null) was.am = { ...h.am }; }
  if (!first) { r.heir = null; return; }
  const sp = spouseOf(world, first);
  r.heir = {
    id: first.id, name: first.n, gender: first.g, born: first.b, relation: relationWords(world, me, first) || (first.g === 'f' ? 'daughter' : 'son'),
    ...(sp ? { spouse: { name: sp.n, fromCivId: sp.c, house: sp.h || null, gender: sp.g } } : {}),
    ...(first.am ? { am: { ...first.am } } : {}),
  };
  if (first.am) delete first.am;
}

/** Keep the ruler's spouse record in step with the tree (a widow, a new match). */
export function syncSpouse(world, civ, r, me) {
  const sp = spouseOf(world, me);
  if (!sp) { if (r.spouse) r.spouse = null; return; }
  if (r.spouse && r.spouse.name === sp.n) return;
  r.spouse = { name: sp.n, fromCivId: sp.nb ? civ.id : (world.civs[sp.c] ? sp.c : civ.id), house: sp.h || null, gender: sp.g };
}

/**
 * A ruler is crowned (installRuler → heirOnInstall): their record (if the tree has it) moves to
 * this court as its ruler, and the spouse and heir come from the tree. Returns the record or null.
 */
export function crownKin(world, civ, r) {
  const me = kinOf(world, r.id);
  if (!me) return null;
  // crowned at another court: the spouse and the children there come too
  if (me.c !== civ.id) {
    const from = me.c;
    const move = (p, depth) => {
      if (!p || p.c !== from || p.d != null) return;
      p.c = civ.id;
      if (depth < 3) for (const id of p.ch || []) move(kinOf(world, id), depth + 1);
    };
    for (const id of me.sp || []) { const s = kinOf(world, id); if (alive(s) && s.c === from) s.c = civ.id; }
    for (const id of me.ch || []) move(kinOf(world, id), 1);
  }
  me.c = civ.id;
  me.r = civ.id;
  if (me.dep) delete me.dep;
  if (r.dynasty) me.h = r.dynasty;
  touched(kinState(world));
  syncSpouse(world, civ, r, me);
  syncHeir(world, civ);
  return me;
}

// ---------------------------------------------------------------------------
// Successions

/** A kept person in the shape makeRuler takes (opts.person), with their relation to the holder. */
export function asPerson(world, civ, holder, p) {
  if (!p) return null;
  const sp = spouseOf(world, p);
  return {
    id: p.id, name: p.n, gender: p.g, born: p.b, house: p.h || null,
    relation: (holder && relationWords(world, holder, p)) || (p.g === 'f' ? 'kinswoman' : 'kinsman'),
    spouse: sp ? { name: sp.n, fromCivId: sp.nb ? civ.id : sp.c, house: sp.h || null, gender: sp.g } : null,
    ...(p.bas ? { bastard: true } : {}),
  };
}

/** Grown, by the person's people's years. */
export const grownKin = (world, civ, p, at = 16) => ageOf(world, civ, p) >= at;

/**
 * Who follows the holder by the realm's law: { first, how ('heir' | 'kin' | 'elected'), home,
 * abroad, rival, bastard, danger }. Under an elective law the great choose the ablest grown
 * member of the royal blood (of the first six at home). danger multiplies the odds of a crisis:
 * a child or a legitimised bastard first, a woman first under a law that prefers sons while a
 * grown man waits behind, and above all an ambitious, unscrupulous grown kinsman close behind.
 */
export function pickSuccessor(world, civ, holder) {
  const line = lineOf(world, civ, holder, { max: 14 });
  const home = line.filter((p) => p.c === civ.id), abroad = line.filter((p) => p.c !== civ.id);
  let first = home[0] || null, how = 'heir';
  if (first && civ.laws && civ.laws.inherit === 'elective') {
    const day = world.time.day;
    let best = null, bs = -1;
    for (const p of home.slice(0, 6)) {
      if (!grownKin(world, civ, p, 18)) continue;
      const sk = skillsOf(personView(p), day, lifeOfP(world, civ, p));
      const sc = sk[SK.WAR] + sk[SK.DIP] + sk[SK.STE] + 0.2 * world.rng.next();
      if (sc > bs) { bs = sc; best = p; }
    }
    if (best) { first = best; how = 'elected'; }
  }
  if (first && how === 'heir' && first.f !== holder.id && first.m !== holder.id) how = 'kin';
  // the danger behind the first in line
  let danger = 1;
  if (first) {
    if (!grownKin(world, civ, first)) danger *= 3;
    if (first.leg) danger *= 1.8;
    if (heirRuleOf(world, civ) === 'male' && first.g === 'f' && home.some((p) => p.g === 'm' && p !== first && grownKin(world, civ, p, 18))) danger *= 1.6;
  }
  let rival = null, rs = 0.15;
  const near = home.filter((p) => p !== first).slice(0, 5);
  const bastard = (holder.ch || []).map((id) => kinOf(world, id)).filter((k) => k && alive(k) && k.bas && !k.leg && !k.dep && k.c === civ.id && grownKin(world, civ, k, 18)).sort((a, b) => a.b - b.b)[0] || null;
  if (bastard) near.push(bastard);
  for (const p of near) {
    if (!grownKin(world, civ, p, 20)) continue;
    const tp = temperOf(personView(p), civ);
    const sc = tp[TP.AMB] - tp[TP.HON] + (first && !grownKin(world, civ, first) ? 0.15 : 0);
    if (sc > rs) { rs = sc; rival = p; }
  }
  if (rival) danger *= 1 + 4 * (rs - 0.15);
  return { first, how, home, abroad, rival, bastard, danger };
}

// ---------------------------------------------------------------------------
// The year

/** Annual hazard of death at an age (in the people's years), by era. */
function hazard(age, era) {
  const e = Math.max(0, 1 - era / 6);
  if (age < 1) return 0.03 + 0.12 * e;
  if (age < 5) return 0.01 + 0.03 * e;
  if (age < 15) return 0.004 + 0.006 * e;
  return 0.008 + 0.0006 * Math.exp((age - 30) / 8) + 0.01 * e;
}
/** Chance of a child in a year for a wife of this age. */
function fertility(age) {
  return age < 16 || age >= 45 ? 0 : age < 20 ? 0.2 : age < 30 ? 0.27 : age < 35 ? 0.2 : age < 40 ? 0.12 : 0.05;
}

/**
 * The family's year at the realm's own month: deaths, births, marriages, bastards; the prune;
 * the ruler's spouse and heir brought into step. Royal houses only.
 */
export function kinYearly(world, civ) {
  if (!civ.ruler || !isDynastic(civ.government) || (civ.flags.union && !civ.flags.union.senior)) return;
  const r = civ.ruler;
  const me = personOfRuler(world, civ, r);
  if (!me) return;
  const rng = world.rng, day = world.time.day;
  const era = fin(civ.tech?.era, 0);
  const court = courtOf(world, civ.id).slice().sort((a, b) => a.id - b.id);
  const big = fin(civ.population) >= 50000;
  const heirId = r.heir ? r.heir.id : null;
  // deaths (the ruler's own death is the monthly pass's)
  for (const p of court) {
    if (p.id === r.id || p.d != null) continue;
    const life = lifeOfP(world, civ, p);
    const age = (day - p.b) / DPY / life;
    if (!rng.chance(hazard(age, era) / life)) continue;
    kinDied(world, p.id, age < 15 ? 'childhood' : age > 62 ? 'old age' : 'illness');
    if (p.id === heirId && big && rng.chance(0.4)) {
      record(world, { cat: 'civ', imp: 1, key: 'dynasty.heir.died', civ, ref: rulerRef(civ, r), text: pick(world, [
        `${p.n}, the ${r.heir.relation} and heir of ${rulerName(r)}, died ${age < 12 ? 'in childhood' : 'of a fever'}, and the court went into mourning.`,
        `The heir of ${theName(civ)}, ${p.n}, was lost${age < 12 ? ' as a child' : ''}.`,
      ]) });
    }
  }
  // births, marriages, bastards
  const mul = hasProviders('royalBirths') ? mulOf('royalBirths', world, civ) : 1;
  const eraF = 1 - 0.05 * Math.max(0, era - 4);
  const bastards = bastardsOk(world, civ);
  for (const p of court) {
    if (p.d != null) continue;
    const life = lifeOfP(world, civ, p);
    const age = (day - p.b) / DPY / life;
    const sp = spouseOf(world, p);
    if (p.g === 'f' && sp && sp.c === p.c) {
      const last = p.ch.length ? kinOf(world, p.ch[p.ch.length - 1]) : null;
      if ((!last || day - last.b > 300) && rng.chance(fertility(age) * mul * eraF / life)) {
        const k = kinBorn(world, civ, p, sp);
        if (rng.chance(0.012)) kinBorn(world, civ, p, sp, { g: k.g });
        if (rng.chance(era < 4 ? 0.015 : 0.008)) kinDied(world, p.id, 'childbed');
      }
    } else if (!sp && !p.nb && age >= (p.g === 'f' ? 16 : 18) && age < 50 && !p.dep) {
      if (rng.chance(age < 24 ? 0.3 : age < 40 ? 0.2 : 0.06)) marryNoble(world, civ, p);
    }
    if (bastards && p.g === 'm' && !p.nb && age >= 18 && age < 60 && (p.id === r.id || (me.f != null && p.f === me.f && lawful(p)))) {
      const hon = temperOf(p.id === r.id ? r : personView(p), civ)[TP.HON];
      if (hon < 0.5 && rng.chance(0.07 * Math.min(1, (0.5 - hon) / 0.3) / life)) kinBorn(world, civ, null, p, { bas: true });
    }
  }
  // a ruler with no lawful child may make a grown bastard lawful
  if (bastards && me.ch.length) {
    const kids = me.ch.map((id) => kinOf(world, id)).filter((k) => alive(k) && !k.dep);
    const base = kids.find((k) => k.bas && !k.leg && k.c === civ.id && grownKin(world, civ, k, 14));
    if (base && !kids.some(lawful) && rng.chance(0.12)) {
      base.leg = 1;
      touched(kinState(world));
      record(world, { cat: 'civ', imp: 2, key: 'dynasty.legitimised', civ, ref: rulerRef(civ, r), tags: ['bastard', 'heir'], text: pick(world, [
        `Without a lawful child, ${rulerName(r)} of ${theName(civ)} declared ${r.gender === 'f' ? 'her' : 'his'} natural ${base.g === 'f' ? 'daughter' : 'son'} ${base.n} legitimate, and heir.`,
        `${rulerShort(r)} of ${theName(civ)} made the bastard ${base.n} lawful by decree; not all the great of the realm would kneel to ${base.g === 'f' ? 'her' : 'him'}.`,
      ]) });
    }
  }
  prune(world, civ, me);
  syncSpouse(world, civ, r, me);
  syncHeir(world, civ);
  lineClaims(world, civ, me);
}

/**
 * Claims from the line: a realm whose people stand in this realm's line from abroad holds a
 * claim on its crown, the stronger the fewer heirs it has at home (0.65 with none, 0.45 with
 * one, 0.38 with two; less for the second and third abroad). Raised each year while it holds
 * (the world's yearly fade, dynasty.js, takes it down once it no longer does).
 */
function lineClaims(world, civ, me) {
  const line = lineOf(world, civ, me, { max: 14 });
  let homeN = 0;
  for (const p of line) if (p.c === civ.id) homeN++;
  let k = 0;
  const done = new Set();
  for (const p of line) {
    if (p.c === civ.id || done.has(p.c)) continue;
    const A = world.civs[p.c];
    if (!A || !A.alive || A.id === civ.id) continue;
    done.add(A.id);
    const v = Math.round((0.25 + 0.4 / (1 + homeN) - 0.05 * k) * 1000) / 1000;
    A.claims ||= {};
    if (v > fin(A.claims[civ.id])) A.claims[civ.id] = v;
    if (++k >= 3) break;
  }
}

/** Blood steps from the ruler (f, m, ch), up to KEEP_DEPTH. Map id → depth. */
function bloodDepths(kin, me) {
  const depth = new Map([[me.id, 0]]);
  let ring = [me];
  for (let d = 1; d <= KEEP_DEPTH; d++) {
    const nx = [];
    for (const x of ring) {
      for (const id of [x.f, x.m, ...(x.ch || [])]) {
        if (id == null || depth.has(id)) continue;
        const y = kin.p[id];
        if (!y) continue;
        depth.set(id, d);
        nx.push(y);
      }
    }
    ring = nx;
  }
  return depth;
}

/** Let go the court's members beyond reach (and the dead no one needs). */
function prune(world, civ, me) {
  const kin = kinState(world);
  const depth = bloodDepths(kin, me);
  const keep = new Set();
  const live = [];
  for (const [id, d] of depth) { const p = kin.p[id]; if (!p) continue; keep.add(id); if (alive(p) && p.c === civ.id) live.push([p, d]); }
  if (live.length > COURT_CAP) {
    live.sort((a, b) => a[1] - b[1] || a[0].b - b[0].b);
    for (const [p] of live.slice(COURT_CAP)) keep.delete(p.id);
  }
  for (const id of [...keep]) { const p = kin.p[id]; if (alive(p)) for (const s of p.sp || []) if (kin.p[s]) keep.add(s); }
  const rulers = [];
  const drop = [];
  for (const id in kin.p) {
    const p = kin.p[id];
    if (p.c !== civ.id || keep.has(p.id)) continue;
    if (p.d != null && p.r === civ.id) { rulers.push(p); continue; }
    drop.push(p);
  }
  if (rulers.length > RULERS_KEPT) { rulers.sort((a, b) => a.d - b.d); drop.push(...rulers.slice(0, rulers.length - RULERS_KEPT)); }
  if (!drop.length) return;
  const gone = new Set(drop.map((p) => p.id));
  for (const p of drop) delete kin.p[p.id];
  for (const id of keep) {
    const p = kin.p[id];
    if (!p || p.d != null) continue;
    if (p.ch.some((x) => gone.has(x))) p.ch = p.ch.filter((x) => !gone.has(x));
    if (p.sp.some((x) => gone.has(x))) p.sp = p.sp.filter((x) => !gone.has(x));
  }
  touched(kin);
}

/** The world's year: let go the courts of fallen realms (save courts in exile) and of realms no longer royal. */
export function kinSweep(world) {
  const kin = kinState(world);
  if (!kin) return;
  const st = world.sys.civ;
  const exiled = new Set();
  for (const ex of st.exiles || []) if (!ex.used && world.time.day - ex.since <= 150 * DPY) exiled.add(ex.civId);
  let n = 0;
  for (const id in kin.p) {
    const p = kin.p[id];
    const c = world.civs[p.c];
    if (c && c.alive && isDynastic(c.government)) continue;
    if (c && !c.alive && exiled.has(c.id) && p.d == null) continue;
    delete kin.p[id];
    n++;
  }
  if (n) touched(kin);
}

// a ruler's death ends their record; a ruler put aside alive (deposed, a broken union) leaves the line
on('rulerDied', (world, civ, ruler, cause) => { if (ruler && ruler.id != null) kinDied(world, ruler.id, cause || null); });
on('succession', (world, civ, prev) => { if (prev && prev.id != null && !(prev.flags && prev.flags.union)) kinSetAside(world, prev.id); });
