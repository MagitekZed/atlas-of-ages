// Rulers: persons with age, gender, traits, deeds and epithets; dynasties with regnal
// numbers; death by age, illness, battle, assassination (or the hand of heaven); succession by
// heir, kin, council, election or coup; succession crises that end in usurpation, civil war
// or a personal union; regencies for child rulers (dynasty.js).
//
// civ.ruler = { id, name, title, epithet, regnal, born, reignStart, traits: [string],
//               dynasty (string | null), gender 'f'|'m', relation, elected, termEnd (day|null),
//               deeds: { conquests, losses, techs, built, wonders, famines, colonies, reforms, golden },
//               display (full styled name, e.g. "Queen Ilsa II the Wise"),
//               predecessorId, spouse { name, fromCivId, house } | null (dynasty.js),
//               heir { name, gender, born, relation } | null (dynasty.js),
//               flags { blessed?, cursed?, reelected?, union? } }
// civ.rulerHistory: past rulers (cap 60), each { id, name, title, epithet, regnal, dynasty,
//               gender, born, reignStart, reignEnd, cause, traits, deeds, relation, predecessorId }
// civ.dynasty: display name of the reigning house ("House of Arkel") or null;
// civ.flags.dynasty = { name, since, rulers, founder }. When a house loses the throne its
// record goes to the sys.civ.dynasties ledger (cap 400): { name, civId, start, end, rulers,
// founder, last, endCause }.
// Ages are divided by the ext 'lifespan' answer (an elven queen may reign three centuries).
// Hooks: rulerDied (world, civ, ruler, cause) for deaths; succession (world, civ, prev, next,
// how) for every change of ruler, how = heir | kin | regency | council | election | coup |
// usurper | civil war | union | revolution | divine | restoration | deposed.

import { makePerson, makeWord, isEnglishWord } from '../../core/names.js';
import { civSettlements, enemiesOf } from '../../core/entities.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { emit, on } from '../../core/hooks.js';
import { mulOf, hasProviders } from '../../core/ext.js';
import { RULER_TRAITS, GOVERNMENTS, isDynastic } from './data.js';
import { rulerTitle, govDef, adoptGovernment, revolutionTarget } from './government.js';
import { refreshMods, getMods } from './tech.js';
import { splitCiv } from './peoples.js';
import { fin, record, rateOk, rulerRef, DYNASTY_CAP } from './state.js';
import { theName, TheName, PeopleOf, peopleOf, rulerName, rulerShort, pick, roman } from './prose.js';
import { heirOnInstall, takeHeir, unionSuccession, onRulerGone, startRegency, unionPartner } from './dynasty.js';
import { epithetFor, EPITHET_THEMES } from './epithets.js';

const HISTORY_CAP = 60;
const TRAIT_KEYS = Object.keys(RULER_TRAITS);

function rollTraits(world, civ, inherit = null) {
  const out = [];
  const n = world.rng.chance(0.3) ? 3 : world.rng.chance(0.75) ? 2 : 1;
  const tr = civ.traits || {};
  for (let k = 0; k < n * 4 && out.length < n; k++) {
    let key;
    if (inherit && inherit.length && world.rng.chance(0.3)) key = world.rng.pick(inherit);
    else {
      const ws = TRAIT_KEYS.map((t) => {
        let w = RULER_TRAITS[t].w;
        if (t === 'warlike' || t === 'cruel') w *= 0.6 + fin(tr.aggression, 0.5);
        if (t === 'pious') w *= 0.5 + fin(tr.religiosity, 0.5);
        if (t === 'scholarly' || t === 'brilliant') w *= 0.6 + fin(tr.innovation, 0.5);
        if (t === 'greedy' || t === 'generous') w *= 0.7 + fin(tr.commerce, 0.5) * 0.5;
        return w;
      });
      let tot = 0; for (const w of ws) tot += w;
      let r = world.rng.next() * tot, j = 0;
      for (; j < ws.length - 1; j++) { r -= ws[j]; if (r <= 0) break; }
      key = TRAIT_KEYS[j];
    }
    if (!RULER_TRAITS[key] || out.includes(key)) continue;
    if (out.some((o) => RULER_TRAITS[o].opp.includes(key) || RULER_TRAITS[key].opp.includes(o))) continue;
    out.push(key);
  }
  return out;
}

export function syncRulerDisplay(r) {
  if (r) r.display = rulerName(r);
  return r;
}

/** Lifespan divisor of a realm's people (ext 'lifespan'; 1 in a Historical world). */
export function lifeOf(world, civ, person = null) {
  if (!hasProviders('lifespan')) return 1;
  const v = mulOf('lifespan', world, civ, person);
  return v > 0 ? v : 1;
}
/** A ruler's age in years of their people. */
export function rulerAge(world, civ, r) {
  return (world.time.day - fin(r?.born, world.time.day)) / DAYS_PER_YEAR / lifeOf(world, civ, r);
}

// Dynasty forms. Every name keeps one of the three shapes the other modules parse — "House of R",
// "House R", "R dynasty" (no leading article: "The House of Arkel War of Succession") — but the
// root R varies: a word of the people's tongue, the founder's name, a patronymic of it
// (Arkelid, Arkeling), the seat of the house, or a heraldic compound (Greymantle, Ravenhold).
const PATRONYM = ['id', 'ides', 'ing', 'en', 'ar', 'ovar', 'son', 'sen', 'ez', 'ian', 'ard', 'eth', 'ung', 'ac', 'ir', 'esco'];
const HERALD_A = ['Grey', 'Black', 'Gold', 'Silver', 'Red', 'White', 'Iron', 'Storm', 'Ash', 'Oak', 'Raven', 'Wolf', 'Stag', 'Hawk', 'Thorn', 'Frost',
  'Sun', 'Moon', 'Star', 'Stone', 'Bright', 'High', 'Swift', 'Dawn', 'Dusk', 'Ember', 'Elm', 'Briar', 'Lark', 'Boar', 'Bear', 'Rose',
  'Falcon', 'Heron', 'Otter', 'Lynx', 'Hart', 'Yew', 'Rowan', 'Holly', 'Copper', 'Amber', 'Salt', 'Cloud', 'Wind', 'Flint'];
const HERALD_B = ['mantle', 'crown', 'helm', 'hold', 'brand', 'shield', 'hand', 'wood', 'vale', 'ford', 'crest', 'heart', 'spear', 'thorn', 'wing',
  'fall', 'gate', 'hall', 'ward', 'stone', 'mere', 'blade', 'horn', 'field', 'water', 'barrow', 'tower', 'march', 'dale', 'cliff', 'brook', 'moor', 'keep', 'reach'];

function patronymic(world, root) {
  const base = root.replace(/[aeiouy]+$/i, '') || root;
  const w = (base + pick(world, PATRONYM)).replace(/(.)\1\1/g, '$1$1');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Every house name this world has used (ledger and reigning houses), for within-world uniqueness. */
function housesUsed(world) {
  const set = new Set();
  for (const d of world.sys.civ?.dynasties || []) if (d && d.name) set.add(d.name);
  for (const c of world.civs) if (c && c.dynasty) set.add(c.dynasty);
  return set;
}

/**
 * A fresh dynasty name for civ. founder: the founding ruler's name, if known. opts.from:
 * 'founder' names the house after the founder (a usurping regent, a prince of its own).
 */
export function newDynastyName(world, civ, founder = null, opts = {}) {
  const lang = civ.language;
  const used = housesUsed(world);
  const f = founder ? String(founder).replace(/'/g, '') : null;
  let name = null;
  for (let k = 0; k < 5 && (!name || used.has(name)); k++) {
    const r = world.rng.next();
    if (f && (opts.from === 'founder' || r < 0.22)) {
      name = world.rng.chance(0.35) ? pick(world, [`${patronymic(world, f)} dynasty`, `House ${patronymic(world, f)}`]) : pick(world, [`House of ${f}`, `House ${f}`]);
    } else if (r < 0.62) {
      let root = makeWord(lang, world.rng, 1, 2);
      if (root.length < 3 || isEnglishWord(root)) root = makeWord(lang, world.rng, 2, 2);
      name = pick(world, [`House of ${root}`, `House ${root}`, `${root} dynasty`, `${patronymic(world, root)} dynasty`]);
    } else if (r < 0.85) {
      const seat = world.settlements[civ.capitalId];
      name = seat && seat.alive ? `House of ${seat.name.replace(/'/g, '')}` : `House ${makeWord(lang, world.rng, 1, 2)}`;
    } else {
      name = `House ${pick(world, HERALD_A)}${pick(world, HERALD_B)}`;
    }
  }
  return name;
}

/** Close the reigning house's record into the sys.civ.dynasties ledger (immutable once pushed). */
export function endDynasty(world, civ, cause = 'ended') {
  const d = civ.flags?.dynasty;
  if (!d || !d.name) return;
  const st = world.sys.civ;
  if (st && Array.isArray(st.dynasties)) {
    const last = civ.ruler && civ.ruler.dynasty === d.name ? civ.ruler : [...(civ.rulerHistory || [])].reverse().find((h) => h.dynasty === d.name);
    st.dynasties.push({
      name: d.name, civId: civ.id, start: fin(d.since, world.time.day), end: world.time.day,
      rulers: Math.max(1, fin(d.rulers, 1)), founder: d.founder || null, last: last ? rulerName(last) : null, endCause: cause,
    });
    if (st.dynasties.length > DYNASTY_CAP) st.dynasties.splice(0, st.dynasties.length - DYNASTY_CAP);
  }
  civ.flags.dynasty = null;
}

/** A new house takes the throne (the old one, if any, goes to the ledger). */
export function startDynasty(world, civ, name, endCause = 'usurped', founder = null) {
  if (civ.flags?.dynasty && civ.flags.dynasty.name !== name) endDynasty(world, civ, endCause);
  civ.dynasty = name;
  civ.flags.dynasty = { name, since: world.time.day, rulers: 0, founder: founder ? founder.name : null };
}

/**
 * Create (but do not install) a ruler. opts: { dynasty, age: [lo, hi], gender, relation,
 * inherit (traits), elected, person: { name, born, gender } (an heir who was already born) }
 */
export function makeRuler(world, civ, opts = {}) {
  const st = world.sys.civ;
  const p = opts.person || null;
  const gender = p?.gender || opts.gender || (world.rng.chance(0.32) ? 'f' : 'm');
  let name = p?.name || makePerson(civ.language, world.rng);
  const hist = civ.rulerHistory || [];
  if (!p && opts.dynasty && opts.dynasty === civ.dynasty && hist.length && world.rng.chance(0.35)) {
    const same = hist.filter((h) => h.dynasty === civ.dynasty && h.gender === gender);
    if (same.length) name = world.rng.pick(same).name;
  }
  let born;
  if (p && Number.isFinite(p.born)) born = p.born;
  else {
    const [lo, hi] = opts.age || [20, 45];
    const age = world.rng.int(lo, hi) * lifeOf(world, civ, null);
    born = world.time.day - Math.round(age * DAYS_PER_YEAR) - world.rng.int(0, 359);
  }
  const r = {
    id: st ? st.nextPersonId++ : 0,
    name, title: '', epithet: null, regnal: 1,
    born,
    reignStart: world.time.day,
    traits: rollTraits(world, civ, opts.inherit || null),
    dynasty: opts.dynasty ?? null,
    gender, relation: opts.relation || p?.relation || null,
    elected: Boolean(opts.elected), termEnd: null,
    deeds: { conquests: 0, losses: 0, techs: 0, built: 0, wonders: 0, famines: 0, colonies: 0, reforms: 0, golden: 0 },
    display: '',
    predecessorId: null, spouse: p?.spouse ? { ...p.spouse } : null, heir: null, flags: {},
  };
  return r;
}

/**
 * Install a ruler; the previous one (if any) goes to history with `prevCause`.
 * opts: { how } — the succession hook's `how` (default from prevCause).
 */
export function installRuler(world, civ, r, prevCause = null, opts = {}) {
  const prev = civ.ruler;
  // a realm born today replaces its placeholder ruler silently (a split crowning its claimant)
  const placeholder = prev && prev.reignStart === world.time.day && fin(civ.foundedDay, -1) === world.time.day && !opts.how;
  if (prev && !placeholder) archiveRuler(world, civ, prev, prevCause || 'succeeded');
  r.title = rulerTitle(world, civ, r.gender);
  r.reignStart = world.time.day;
  r.predecessorId = prev && !placeholder ? prev.id ?? null : r.predecessorId ?? null;
  r.flags ||= {};
  if (isDynastic(civ.government) || govDef(civ).succession === 'council') {
    const used = (civ.flags.regnal[r.name] || 0) + 1;
    civ.flags.regnal[r.name] = used;
    r.regnal = used;
  } else r.regnal = 1;
  const g = GOVERNMENTS[civ.government];
  if (g && g.succession === 'elective') {
    const [a, b] = g.term || [5, 8];
    r.elected = true;
    r.termEnd = world.time.day + world.rng.int(a, b) * DAYS_PER_YEAR;
  } else r.termEnd = null;
  // a non-hereditary ruler ends the old house's hold on the throne
  if (civ.flags.dynasty && !isDynastic(civ.government) && r.dynasty !== civ.flags.dynasty.name) {
    endDynasty(world, civ, govDef(civ).succession === 'elective' ? 'elections' : govDef(civ).succession === 'council' ? 'council' : 'overthrown');
    civ.dynasty = null;
  }
  if (civ.flags.dynasty && r.dynasty === civ.dynasty) {
    civ.flags.dynasty.rulers++;
    if (!civ.flags.dynasty.founder) civ.flags.dynasty.founder = r.name;
  }
  civ.ruler = r;
  syncRulerDisplay(r);
  heirOnInstall(world, civ, r);
  refreshMods(world, civ);
  if (prev && !placeholder) emit(world, 'succession', civ, prev, r, opts.how || HOW[prevCause] || 'heir');
  return r;
}
const HOW = { 'term ended': 'election', revolution: 'revolution', deposed: 'deposed', coup: 'coup', divine: 'divine', union: 'union', restoration: 'restoration' };

/** The deeds that happened (saved for every reign ever: zero counters are left out; readers default them). */
function liveDeeds(d) {
  const out = {};
  if (d && typeof d === 'object') for (const k in d) if (d[k]) out[k] = d[k];
  return out;
}

export function archiveRuler(world, civ, r, cause) {
  civ.rulerHistory.push({
    id: r.id ?? null, name: r.name, title: r.title, epithet: r.epithet, ...(r.gloss ? { gloss: r.gloss } : {}), regnal: r.regnal, dynasty: r.dynasty, gender: r.gender,
    born: r.born, reignStart: r.reignStart, reignEnd: world.time.day, cause, traits: (r.traits || []).slice(),
    deeds: liveDeeds(r.deeds), relation: r.relation || null, predecessorId: r.predecessorId ?? null,
    ...(r.spouse ? { spouse: { ...r.spouse } } : {}), ...(r.flags?.blessed ? { blessed: true } : {}), ...(r.flags?.cursed ? { cursed: true } : {}),
  });
  if (civ.rulerHistory.length > HISTORY_CAP) civ.rulerHistory.splice(0, civ.rulerHistory.length - HISTORY_CAP);
}

/** First ruler and dynasty of a new civ (silent). */
export function setupRuler(world, civ) {
  if (civ.ruler && civ.ruler.name) { syncRulerDisplay(civ.ruler); return civ.ruler; }
  civ.flags ||= {};
  civ.flags.regnal ||= {};
  let dyn = null;
  if (isDynastic(civ.government)) { dyn = newDynastyName(world, civ); startDynasty(world, civ, dyn); }
  const r = makeRuler(world, civ, { dynasty: dyn, age: [22, 45] });
  return installRuler(world, civ, r, null);
}

const pron = (r) => (r.gender === 'f' ? 'her' : 'his');
const ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
const ordinal = (n) => ORD[n] || `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
const obj = (r) => (r.gender === 'f' ? 'her' : 'him');

// ---------------------------------------------------------------------------
// Monthly lifecycle

/** Aging, death, assassination, terms of office. agg: { n, atWar } */
export function rulersMonthly(world, civ, agg) {
  if (!civ.ruler || !civ.ruler.name) { setupRuler(world, civ); return; }
  const r = civ.ruler;
  // a crown worn by the ruler of another realm lives and dies with that realm's ruler
  if (unionPartner(world, civ, false)) { if (world.time.day % DAYS_PER_YEAR < 30) considerEpithet(world, civ, r); return; }
  const a = rulerAge(world, civ, r);
  const era = fin(civ.tech?.era, 0);
  const mods = getMods(world, civ);
  // annual mortality: accidents and illness, the steep climb of old age, and the hazards of
  // pre-modern medicine (reigns average a couple of decades)
  let haz = 0.011 + 0.0006 * Math.exp((a - 30) / 8) + 0.014 * Math.max(0, 1 - era / 6) * (1.2 - Math.min(1, mods.health * 0.8));
  if (r.flags?.blessed) haz *= 0.6;
  if (r.flags?.cursed) haz *= 2.5;
  let cause = null;
  if (world.rng.chance(haz / 12)) cause = a > 62 ? 'old age' : 'illness';
  if (!cause && agg.atWar && r.traits.includes('warlike') && world.rng.chance(0.008 / 12)) cause = 'battle';
  if (!cause) {
    const coup = r.traits.reduce((m, t) => m * (RULER_TRAITS[t]?.coup || 1), 1);
    const sf = Math.max(0.3, fin(world.params.stabilityFactor, 1));
    const pA = 0.0035 * (1 + 4 * Math.max(0, 0.5 - civ.stability)) * coup * (govDef(civ).succession === 'strongman' ? 2.5 : 1) / sf * (r.flags?.cursed ? 1.5 : 1);
    if (world.rng.chance(pA / 12)) cause = 'assassinated';
  }
  if (cause) { succession(world, civ, cause, agg); return; }
  if (r.termEnd != null && world.time.day >= r.termEnd) { election(world, civ); return; }
  // yearly: legitimacy drift and epithets
  if (world.time.day % DAYS_PER_YEAR < 30) considerEpithet(world, civ, r);
}

/** Legitimacy drifts toward a target set by reign length, dynasty age and government. */
export function updateLegitimacy(world, civ) {
  const r = civ.ruler;
  const reign = r ? (world.time.day - r.reignStart) / DAYS_PER_YEAR : 0;
  const dynYears = civ.flags.dynasty ? (world.time.day - civ.flags.dynasty.since) / DAYS_PER_YEAR : 0;
  let t = 0.5 + 0.18 * Math.min(1, reign / 15) + 0.12 * Math.min(1, dynYears / 120);
  if (r?.traits.includes('charismatic')) t += 0.1;
  if (r?.traits.includes('mad')) t -= 0.12;
  if (r?.elected) t += 0.15;
  if (r?.flags?.blessed) t += 0.08;
  if (r?.flags?.cursed) t -= 0.1;
  if (civ.flags?.regent) t -= 0.08;
  if (civ.goldenAge > 0) t += 0.08;
  if (civ.darkAge > 0) t -= 0.1;
  t -= 0.04 * Math.min(4, fin(civ.flags.losses));
  t += 0.02 * Math.min(4, fin(civ.flags.conquests));
  if (civ.treasury < 0) t -= 0.08;
  t = Math.max(0.05, Math.min(0.98, t));
  civ.legitimacy = Math.max(0, Math.min(1, fin(civ.legitimacy, 0.6) + (t - fin(civ.legitimacy, 0.6)) * 0.03));
}

function causePhrase(world, cause, a) {
  switch (cause) {
    case 'old age': return pick(world, [`in old age at ${Math.round(a)}`, `full of years at ${Math.round(a)}`, `peacefully at the age of ${Math.round(a)}`]);
    case 'illness': return pick(world, ['of a fever', 'of a wasting sickness', `of an illness at ${Math.round(a)}`, 'of a lingering illness']);
    case 'battle': return pick(world, ['in battle', 'at the head of the army', 'of wounds taken in battle']);
    case 'assassinated': return pick(world, ['at the hands of assassins', 'by poison', 'in a palace conspiracy', "by an assassin's blade"]);
    case 'murdered': return pick(world, ['in the night, smothered in the royal bedchamber', 'by poison in the cup of a regent', 'in a locked tower, and no one was ever punished']);
    case 'smitten': return pick(world, ['by a bolt from a clear sky', 'by an unseen hand in the middle of a feast', 'between one word and the next, as if the gods had snuffed a candle', 'by the wrath of heaven before the whole court']);
    default: return '';
  }
}

/** The relation word of a successor who was not an heir in waiting (kin from the wider house). */
function kinWord(world, prev, heir) {
  const r = world.rng.next();
  const rel = r < 0.5 ? (heir.gender === 'f' ? 'sister' : 'brother') : r < 0.78 ? (heir.gender === 'f' ? 'niece' : 'nephew') : 'cousin';
  heir.relation = rel;
  return `${pron(prev)} ${rel}`;
}

/**
 * The ruler is gone; find a successor according to the government's custom. Returns the
 * chronicle entry. opts: { cat, key, imp, tags, cause (seq), ref } — a divine smiting tells
 * the tale under the Divine Hand.
 */
export function succession(world, civ, cause, agg = {}, opts = {}) {
  const prev = civ.ruler;
  if (!prev) { setupRuler(world, civ); return null; }
  // the junior crown of a personal union: the person is the senior realm's ruler
  const senior = unionPartner(world, civ, false);
  if (senior && senior.ruler) return succession(world, senior, cause, agg, opts);
  const a = rulerAge(world, civ, prev);
  const reign = Math.max(0, (world.time.day - prev.reignStart) / DAYS_PER_YEAR);
  if (!prev.epithet) posthumousEpithet(world, civ, prev, a, reign);
  emit(world, 'rulerDied', civ, prev, cause);
  const g = govDef(civ);
  const sf = Math.max(0.3, fin(world.params.stabilityFactor, 1));
  const n = civ.settlementIds.length;
  const bigImp = fin(civ.population) >= 20000 || prev.epithet ? 2 : 1;
  const assassinImp = fin(civ.population) >= 30000 ? 3 : 2;
  const verb = cause === 'assassinated' || cause === 'murdered' ? 'was killed' : cause === 'smitten' ? 'was struck down' : 'died';
  const reignWords = reign >= 2 ? (cause === 'smitten' ? ` in the ${ordinal(Math.ceil(reign))} year of ${pron(prev)} reign` : ` after a reign of ${Math.round(reign)} years`) : '';
  const died = cause === 'smitten'
    ? `${rulerName(prev)} of ${theName(civ)} ${verb}${reignWords} ${causePhrase(world, cause, a)}`
    : `${rulerName(prev)} of ${theName(civ)} ${verb} ${causePhrase(world, cause, a)}${reignWords}`;
  const divine = cause === 'smitten';
  const base = {
    cat: opts.cat || 'civ', civ, ref: opts.ref || rulerRef(civ, prev), cause: opts.cause ?? null,
  };
  const tagsOf = (extra = []) => {
    const t = [...(opts.tags || []), ...extra];
    if (prev.epithet && !t.includes('epithet')) t.push('epithet');
    return t.length ? t.slice(0, 4) : null;
  };
  const keyOf = (k) => opts.key || k;
  const impOf = (i) => Math.max(opts.imp ?? 0, i);
  const done = (r, how) => { onRulerGone(world, civ, prev, r, how); };

  // a realm in personal union: the shared crown passes on (or the union breaks)
  const shared = unionSuccession(world, civ, prev, cause, died, base);
  if (shared) return shared;

  if (g.succession === 'hereditary') {
    // an heir in waiting, else kin of the wider house, else a crisis (a secured heir averts it)
    const secured = Boolean(civ.flags.heirSecured);
    civ.flags.heirSecured = false;
    const heirP = takeHeir(world, civ, prev);
    const kin = !heirP && world.rng.chance(0.6);
    const hasHeir = Boolean(heirP) || kin || secured;
    const pCrisis = secured ? 0 : (hasHeir ? 0.02 : 0.3) * g.crisis * (1.4 - civ.legitimacy) * (cause === 'assassinated' ? 1.6 : 1) / sf;
    if (world.rng.chance(Math.min(0.9, pCrisis))) {
      const res = successionCrisis(world, civ, prev, cause, died, n, heirP, base, tagsOf, keyOf, impOf);
      if (res) return res;
    }
    const heir = makeRuler(world, civ, { dynasty: prev.dynasty || civ.dynasty, age: [16, 40], inherit: prev.traits, person: heirP });
    const relw = heirP ? `${pron(prev)} ${heirP.relation || (heir.gender === 'f' ? 'daughter' : 'son')}` : kinWord(world, prev, heir);
    installRuler(world, civ, heir, cause, { how: heirP ? 'heir' : 'kin' });
    civ.legitimacy = Math.min(1, 0.55 * civ.legitimacy + 0.35);
    const child = startRegency(world, civ, heir, prev);
    let text = `${died}; ${relw} ${rulerShort(heir)} took the throne`;
    if (child) {
      text += child.long
        ? `, still a child by the long reckoning of ${peopleOf(civ)}, with ${child.regentPhrase} ruling in ${heir.gender === 'f' ? 'her' : 'his'} name`
        : pick(world, [`, a child of ${child.age}, with ${child.regentPhrase} ruling in ${heir.gender === 'f' ? 'her' : 'his'} name`, ` at the age of ${child.age}, under the regency of ${child.regentPhrase}`]);
    }
    const key = cause === 'assassinated' ? 'succession.assassination' : divine ? 'divine.smite_ruler' : 'succession';
    const e = record(world, { ...base, imp: impOf(divine ? 3 : cause === 'assassinated' ? assassinImp : child ? 2 : bigImp), key: keyOf(key), text: `${text}.`, tags: tagsOf(child ? ['regency'] : []) });
    done(heir, heirP ? 'heir' : 'kin');
    return e;
  }
  if (g.succession === 'council') {
    const nr = makeRuler(world, civ, { age: [40, 65] });
    installRuler(world, civ, nr, cause, { how: 'council' });
    civ.legitimacy = Math.min(1, 0.5 * civ.legitimacy + 0.35);
    const who = civ.government === 'theocracy' ? 'the priesthood' : civ.government === 'merchant' ? 'the great merchant houses' : 'the council';
    const e = record(world, { ...base, imp: impOf(divine ? 3 : cause === 'assassinated' ? assassinImp : bigImp), key: keyOf(cause === 'assassinated' ? 'succession.assassination' : 'succession'), text: pick(world, [
      `${died}; ${who} chose ${rulerShort(nr)} to succeed ${obj(prev)}.`,
      `${died}, and after long deliberation ${who} raised ${rulerShort(nr)} in ${pron(prev)} place.`,
    ]), tags: tagsOf() });
    done(nr, 'council');
    return e;
  }
  if (g.succession === 'elective') {
    const nr = makeRuler(world, civ, { age: [38, 65], elected: true });
    installRuler(world, civ, nr, cause, { how: 'election' });
    civ.legitimacy = Math.min(1, 0.5 * civ.legitimacy + 0.4);
    const e = record(world, { ...base, imp: impOf(divine ? 3 : cause === 'assassinated' ? assassinImp : 1), key: keyOf(cause === 'assassinated' ? 'succession.assassination' : 'succession'), text: `${died}; ${rulerShort(nr)} was elected ${nr.title} in ${pron(prev)} place.`, tags: tagsOf(['election']) });
    done(nr, 'election');
    return e;
  }
  // strongman: a coup, a new strongman, or the regime falls
  const pFall = 0.35 * (1.3 - civ.stability) / sf;
  if (world.rng.chance(Math.min(0.85, pFall))) {
    const target = revolutionTarget(world, civ) || 'republic';
    const nr = makeRuler(world, civ, { age: [35, 60] });
    adoptGovernment(world, civ, target, { silent: true, keepTitle: true });
    if (isDynastic(target)) { const dn = newDynastyName(world, civ, nr.name); startDynasty(world, civ, dn, 'overthrown', nr); nr.dynasty = dn; }
    installRuler(world, civ, nr, cause, { how: 'revolution' });
    if (!isDynastic(target)) { civ.dynasty = null; civ.flags.dynasty = null; }
    civ.legitimacy = 0.45;
    const e = record(world, { ...base, imp: impOf(3), key: keyOf('succession.coup'), text: `${died}, and the regime died with ${obj(prev)}: ${theName(civ)} was proclaimed under ${rulerName(nr, false)}.`, tags: tagsOf(['coup']) });
    done(nr, 'revolution');
    return e;
  }
  const nr = makeRuler(world, civ, { age: [35, 60], inherit: ['warlike', 'cruel', 'paranoid'] });
  installRuler(world, civ, nr, cause, { how: 'coup' });
  civ.legitimacy = 0.4;
  const e = record(world, { ...base, imp: impOf(divine ? 3 : cause === 'assassinated' ? assassinImp : bigImp), key: keyOf('succession.coup'), text: pick(world, [
    `${died}; the generals raised ${rulerShort(nr)} to power.`,
    `${died}, and before the funeral was done the army had put ${rulerShort(nr)} in ${pron(prev)} chair.`,
  ]), tags: tagsOf(['coup']) });
  done(nr, 'coup');
  return e;
}

function election(world, civ) {
  const prev = civ.ruler;
  const reelect = world.rng.chance(prev.traits.includes('charismatic') ? 0.45 : 0.2) && !prev.flags?.reelected;
  if (reelect) {
    const g = govDef(civ);
    const [a, b] = g.term || [5, 8];
    prev.termEnd = world.time.day + world.rng.int(a, b) * DAYS_PER_YEAR;
    prev.flags = { ...(prev.flags || {}), reelected: true };
    return;
  }
  const nr = makeRuler(world, civ, { age: [38, 65], elected: true });
  installRuler(world, civ, nr, 'term ended', { how: 'election' });
  onRulerGone(world, civ, prev, nr, 'election');
  civ.legitimacy = Math.min(1, 0.6 * civ.legitimacy + 0.35);
  if (rateOk(world, `elect:${civ.id}`, 15)) {
    record(world, { cat: 'civ', imp: 1, key: 'succession', civ, ref: rulerRef(civ, nr), tags: ['election'], text: pick(world, [
      `${rulerShort(nr)} was elected ${nr.title} of ${theName(civ)}, succeeding ${rulerShort(prev)}.`,
      `${TheName(civ)} chose ${rulerShort(nr)} as ${nr.title}.`,
      `The voters of ${theName(civ)} turned out ${rulerShort(prev)} and raised ${rulerShort(nr)} to be ${nr.title}.`,
    ]) });
  }
}

/** War names for a disputed succession (all contain "Succession": the war module keys on it). */
export function succNames(civ) {
  const house = String(civ.dynasty || '').replace(/^(the\s+)?House( of)?\s+/i, '').replace(/^the\s+/i, '').replace(/\s+dynasty$/i, '');
  const out = [`${civ.adjective} War of Succession`, `War of the ${civ.adjective} Succession`];
  if (house && house.length <= 14) out.push(`War of the ${house} Succession`);
  return out;
}

/**
 * No clear heir: a usurper seizes the throne, or the realm splits in a war of succession.
 * heirP: the heir in waiting, if any (a child heir faces a stronger pretender).
 */
function successionCrisis(world, civ, prev, cause, died, n, heirP, base, tagsOf, keyOf, impOf) {
  const st = world.sys.civ;
  const heir = makeRuler(world, civ, { dynasty: prev.dynasty || civ.dynasty, age: [12, 35], inherit: prev.traits, person: heirP });
  const claimant = makeRuler(world, civ, { dynasty: prev.dynasty || civ.dynasty, age: [20, 50] });
  const realmYears = (world.time.day - Math.max(fin(civ.foundedDay, 0), fin(civ.flags.independence, -1e9))) / DAYS_PER_YEAR;
  const civilWarOk = n >= 5 && realmYears >= 40 && world.time.day - fin(civ.flags.lastCivilWarDay, -1e9) >= 60 * DAYS_PER_YEAR;
  if (civilWarOk && world.rng.chance(0.45)) {
    const mods = getMods(world, civ);
    const cap = civ.capitalId != null ? world.settlements[civ.capitalId] : null;
    const ss = civSettlements(world, civ).filter((s) => s.id !== civ.capitalId).map((s) => {
      const d = cap ? Math.hypot(s.x - cap.x, s.y - cap.y) : 0;
      return [s, (1 - s.loyalty) + 0.4 * d / Math.max(4, mods.adminRange) + 0.5 * s.unrest + world.rng.next() * 0.3];
    }).sort((a, b) => b[1] - a[1]);
    const k = Math.max(1, Math.min(ss.length, Math.round(ss.length * world.rng.float(0.3, 0.5))));
    // keep the faction geographically coherent: take the top seed and its nearest peers
    const seed = ss[0][0];
    const faction = ss.map(([s]) => s).sort((a, b) => Math.hypot(a.x - seed.x, a.y - seed.y) - Math.hypot(b.x - seed.x, b.y - seed.y)).slice(0, k);
    const relw = heirP ? `${pron(prev)} ${heirP.relation || (heir.gender === 'f' ? 'daughter' : 'son')}` : kinWord(world, prev, heir);
    installRuler(world, civ, heir, cause, { how: heirP ? 'heir' : 'kin' });
    civ.legitimacy = 0.35;
    const res = splitCiv(world, civ, faction.map((s) => s.id), {
      cause: 'civil war', government: civ.government, nameFrom: 'city',
      war: { cause: 'civil war', names: succNames(civ) }, loyalty: 0.7,
    });
    if (res) {
      civ.flags.lastCivilWarDay = world.time.day;
      const rebel = res.civ;
      claimant.dynasty = rebel.dynasty || claimant.dynasty;
      installRuler(world, rebel, claimant, 'deposed');
      rebel.legitimacy = 0.45;
      if (st) st.counters.civilWars++;
      const seat = world.settlements[rebel.capitalId];
      const e = record(world, {
        ...base, cat: base.cat === 'divine' ? 'divine' : 'war', imp: impOf(4), key: keyOf('succession.crisis'),
        text: `${died}, leaving the succession in dispute: while ${relw} ${rulerShort(heir)} was crowned, ${rulerShort(claimant)} raised a rival banner at ${seat ? seat.name : 'the frontier'}, and ${res.war ? res.war.name.replace(/^The /, 'the ') : 'a war of succession'} began.`,
        tags: tagsOf(['crisis', 'civil-war', 'pretender']),
      });
      onRulerGone(world, civ, prev, heir, 'civil war');
      return e;
    }
  }
  // usurpation: a new house takes the throne
  const usurper = makeRuler(world, civ, { age: [28, 55], inherit: ['ambitious', 'cruel', 'warlike'] });
  const dyn = newDynastyName(world, civ, usurper.name);
  startDynasty(world, civ, dyn, 'usurped', usurper);
  usurper.dynasty = dyn;
  installRuler(world, civ, usurper, cause, { how: 'usurper' });
  civ.legitimacy = 0.32;
  civ.stability = Math.max(0, civ.stability - 0.08);
  const e = record(world, {
    ...base, imp: impOf(3), key: keyOf('succession.crisis'),
    text: `${died} without a worthy heir; ${rulerShort(usurper)} seized the throne, founding ${/^the /i.test(dyn) ? dyn : 'the ' + dyn}.`,
    tags: tagsOf(['usurper', 'new-dynasty']),
  });
  onRulerGone(world, civ, prev, usurper, 'usurper');
  return e;
}

/**
 * A coup or revolution that removes the ruler outright (stability collapse, divine unrest).
 * newGov: the government that follows (null keeps it). Returns { prev, ruler }.
 */
export function overthrow(world, civ, newGov, how = 'revolution') {
  const prev = civ.ruler;
  if (newGov && newGov !== civ.government) adoptGovernment(world, civ, newGov, { silent: true, keepTitle: true });
  const nr = makeRuler(world, civ, { age: [32, 58], elected: govDef(civ).succession === 'elective' });
  if (isDynastic(civ.government)) {
    const dn = newDynastyName(world, civ, nr.name);
    startDynasty(world, civ, dn, how === 'divine' ? 'deposed by heaven' : 'overthrown', nr);
    nr.dynasty = dn;
  }
  installRuler(world, civ, nr, how, { how: how === 'divine' ? 'divine' : how === 'coup' ? 'coup' : 'revolution' });
  if (!isDynastic(civ.government)) { civ.dynasty = null; civ.flags.dynasty = null; }
  civ.legitimacy = 0.45;
  onRulerGone(world, civ, prev, nr, how);
  return { prev, ruler: nr };
}

/**
 * A standing army seizes power (geo/raising.js emits armyCoup: three months unpaid, or a realm in
 * crisis). A republic falls to a dictatorship; a crown passes to the soldiers' man.
 */
on('armyCoup', (world, civ) => {
  if (!civ || !civ.alive || !civ.ruler) return;
  const prev = civ.ruler;
  const toDictator = GOVERNMENTS.dictatorship && ['republic', 'democracy', 'constitutional', 'merchant'].includes(civ.government) ? 'dictatorship' : null;
  const { ruler } = overthrow(world, civ, toDictator, 'coup');
  record(world, {
    cat: 'civ', imp: 3, key: 'army.coup', civ, tags: ['coup', 'army'], ref: rulerRef(civ, ruler),
    text: pick(world, [
      `The army of ${theName(civ)}, unpaid and unruly, overthrew ${rulerShort(prev)} and set ${rulerName(ruler)} in power.`,
      `Soldiers marched on the palace of ${theName(civ)}; ${rulerShort(prev)} was deposed, and the generals raised ${rulerName(ruler)}${toDictator ? ' as dictator' : ''}.`,
    ]),
  });
});

// ---------------------------------------------------------------------------
// Epithets (the words themselves come from epithets.js: themed, combinatorial, world-specific)

/** The deed a reign is remembered for, as an epithet theme, or null. */
function deedTheme(r) {
  const d = r.deeds;
  if (d.conquests >= 4) return 'conquest';
  if (d.golden >= 120) return 'golden';
  if (d.wonders >= 1 || d.built >= 18) return 'builder';
  if (d.colonies >= 2) return 'colonies';
  if (d.reforms >= 1) return 'reform';
  if (d.techs >= 6) return r.traits.includes('wise') ? 'wise' : 'learning';
  if (d.losses >= 3) return 'losses';
  if (d.famines >= 3) return 'famine';
  return null;
}
const TEXT_KIND = { wise: 'learning' };

/** Give ruler r an epithet in a theme (and its gloss, for a word of the people's own tongue). */
function bestow(world, civ, r, theme) {
  const { epithet, gloss } = epithetFor(world, civ, r, theme);
  r.epithet = epithet;
  if (gloss) r.gloss = gloss; else delete r.gloss;
  syncRulerDisplay(r);
}

function considerEpithet(world, civ, r) {
  if (r.epithet || r.elected) return;
  const reign = (world.time.day - r.reignStart) / DAYS_PER_YEAR;
  let theme = deedTheme(r), kind = theme ? TEXT_KIND[theme] || theme : null;
  if (!theme && reign >= 8 && r.traits.length && world.rng.chance(0.12)) {
    const t = world.rng.pick(r.traits);
    if (EPITHET_THEMES.includes(t)) { theme = t; kind = 'trait'; }
  }
  if (!theme) return;
  bestow(world, civ, r, theme);
  const who = `${r.title} ${rulerShort(r)}`;
  const d = r.deeds;
  const named = `${rulerShort(r)} ${r.epithet}${r.gloss ? ` (“${r.gloss}” in the ${civ.adjective} tongue)` : ''}`;
  const text = {
    conquest: `Having taken ${d.conquests} cities, ${who} of ${theName(civ)} was hailed as ${named}.`,
    golden: `For the glories of ${pron(r)} reign, ${who} of ${theName(civ)} became known as ${named}.`,
    builder: `For the great works raised in ${pron(r)} reign, ${who} of ${theName(civ)} was remembered as ${named}.`,
    colonies: `${who} of ${theName(civ)}, whose ships planted colonies across the sea, was called ${named}.`,
    reform: `${who}, who remade the laws of ${theName(civ)}, was named ${named}.`,
    learning: `${who} of ${theName(civ)}, patron of scholars, became known as ${named}.`,
    losses: `After losing city after city, ${who} of ${theName(civ)} was mocked as ${named}.`,
    famine: `${who} of ${theName(civ)}, whose reign was haunted by hunger, was called ${named}.`,
    trait: `${PeopleOf(civ)} came to call their ${r.title.toLowerCase()} ${named}.`,
  }[kind];
  const imp = kind === 'trait' || fin(civ.population) < 5000 ? 1 : 2;
  record(world, { cat: 'civ', imp, key: 'ruler.epithet', text, civ, ref: rulerRef(civ, r), tags: [kind] });
}

function posthumousEpithet(world, civ, r, a, reign) {
  if (r.elected) return;
  let theme = r.flags?.cursed ? 'accursed' : deedTheme(r);
  if (!theme) {
    if (a >= 82) theme = 'old';
    else if (reign < 1 && world.rng.chance(0.5)) theme = 'brief';
    else if (a < 24 && world.rng.chance(0.5)) theme = 'young';
    else if (reign >= 6 && r.traits.length && world.rng.chance(0.3)) {
      const t = world.rng.pick(r.traits);
      if (EPITHET_THEMES.includes(t)) theme = t;
    }
  }
  if (theme) bestow(world, civ, r, theme);
  else syncRulerDisplay(r);
}

/** Deeds bookkeeping helpers used by hooks. */
export function noteDeed(civ, key, n = 1) {
  if (civ?.ruler?.deeds) civ.ruler.deeds[key] = fin(civ.ruler.deeds[key]) + n;
}

export { roman, enemiesOf };
