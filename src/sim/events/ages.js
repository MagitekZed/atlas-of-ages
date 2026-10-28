// Ages of the world. Every run rolls 1–2 ages at genesis (Age of Prophets, Long Winter, Age of
// the Horse Lords …, data.js AGES), weighted by its params and geography; each lasts 250–500
// years and is re-rolled when it ends, or replaced early when the world itself calls for one
// (an ice age brings the Long Winter, three great plagues the Age of Plagues, a hegemon the
// Long Peace, a world at war the Age of Iron and Blood, ocean-going ships the Age of Discovery).
// The worldAges param switches them off (providers neutral, nothing new rolled).
//
// Ages act through the ext providers this module registers — rates (prophet, quake, horde …),
// warAppetite and routeValue — through a civ effect every living realm carries while the age
// lasts ('age:<key>', e.g. farmYield −0.1 in the Long Winter), and through the deck's own
// family weights (engine.js). Black
// swans add timed rate boosts (sys.events.boosts) through the same providers; embargoes and
// systems collapse cut route values. currentAges(world) is the HUD's view (pure).
// Each age is named from data.js AGE_FORMS ("the Red Summers", "the Varathi Peace"), its HUD label
// kept as `short` on the record.
// State: sys.events.ages = { cur: [{ key, name, short, from, until, why }], past: [...], trig, strife }.

import { registerProvider } from '../../core/ext.js';
import { addEffect, removeEffect, getEffect } from '../../core/effects.js';
import { liveCivs } from '../../core/entities.js';
import { weightedIndex } from '../../core/util.js';
import { DAYS_PER_YEAR, BIOME, WATER } from '../../core/constants.js';
import { AGES, AGE_KEYS, AGE_CLASH, AGE_FORMS } from './data.js';
import { composeName } from '../../core/names.js';
import { evState, recordFree, hasTech } from './engine.js';
import { SUBJ, heatOf } from './heat.js';
import { pick, cap, peopleOf, civName, adjOf } from './prose.js';

const Y = DAYS_PER_YEAR;
const MAX_AGES = 2;
const clashes = (a, b) => AGE_CLASH.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
const agesOn = (world) => world.params.worldAges !== false;

// ---------------------------------------------------------------------------
// Facts the age weights read

function worldEra(world) {
  let e = 0;
  for (const c of liveCivs(world)) e = Math.max(e, c.tech?.era || 0);
  return e;
}
function steppeShare(world) {
  const c = world.cache;
  if (c.evSteppe && c.evSteppe.v === world.versions.biome) return c.evSteppe.share;
  const { f, N } = world;
  let land = 0, st = 0;
  for (let i = 0; i < N; i += 3) {
    if (f.water[i] !== WATER.LAND) continue;
    land++;
    if (f.biome[i] === BIOME.STEPPE || f.biome[i] === BIOME.COLD_DESERT) st++;
  }
  const share = land ? st / land : 0;
  c.evSteppe = { v: world.versions.biome, share };
  return share;
}
function rollFacts(world) {
  const p = world.params;
  const num = (k, d = 1) => (Number.isFinite(Number(p[k])) ? Number(p[k]) : d);
  const civs = liveCivs(world);
  return {
    religiosity: num('religiosity'), seismicity: num('seismicity'), volcanism: num('volcanism'), plagueRate: num('plagueRate'),
    aggression: num('aggression'), volatility: num('climateVolatility', 0.3), wildfire: num('wildfireRate'), techRate: num('techRate'),
    emergence: num('emergenceRate'), meteorRate: num('meteorRate', 0.5),
    cold: (world.climate.tempOffset || 0) <= -1.2 || num('baseTemperature', 0) <= -3,
    hot: (world.climate.tempOffset || 0) >= 1.2 || num('baseTemperature', 0) >= 3,
    steppe: steppeShare(world),
    navigators: civs.some((c) => hasTech(c, 'sailing')),
    oceanGoing: civs.some((c) => hasTech(c, 'navigation')),
  };
}

// ---------------------------------------------------------------------------
// Rolling, beginning and ending

function agesState(world) {
  const st = evState(world);
  if (!st.ages || typeof st.ages !== 'object') st.ages = { cur: [], past: [], trig: -1e9, strife: 0, once: {} };
  const a = st.ages;
  if (!Array.isArray(a.cur)) a.cur = [];
  if (!Array.isArray(a.past)) a.past = [];
  if (!a.once || typeof a.once !== 'object') a.once = {};
  if (!Number.isFinite(a.trig)) a.trig = -1e9;
  return a;
}

function rollKey(world, exclude) {
  const f = rollFacts(world);
  const era = worldEra(world);
  const a = agesState(world);
  const last = a.past.length ? a.past[a.past.length - 1].key : null;
  const keys = [], w = [];
  for (const k of AGE_KEYS) {
    const def = AGES[k];
    if (exclude.includes(k) || k === last) continue;
    if (era < def.era[0] || era > def.era[1]) continue;
    if (exclude.some((x) => clashes(x, k))) continue;
    let v = 0;
    try { v = def.weight(world, f); } catch (e) { v = 0; }
    if (v > 0 && Number.isFinite(v)) { keys.push(k); w.push(v); }
  }
  const i = weightedIndex(world.rng, w);
  return i >= 0 ? keys[i] : null;
}

/**
 * A composed name for an age (data.js AGE_FORMS): the people that called it up ({adj}: a hegemon's
 * Peace, a navigator's Voyages), the plague that brought it ({plague}), or themed words.
 */
function ageName(world, key, why) {
  const def = AGE_FORMS[key];
  const civ = why && why.civ != null ? world.civs[why.civ] : null;
  if (!def) return civ && key === 'peace' ? `the ${adjOf(civ)} Peace` : AGES[key].name;
  const pl = key === 'plagues' ? deadliestRecentPlague(world) : null;
  return composeName(world.rng, def.forms, { ...def.words, adj: civ ? adjOf(civ) : null, plague: pl }) || AGES[key].name;
}
/** The name (article dropped) of the deadliest plague of the last 60 years, if it was notable. Pure. */
function deadliestRecentPlague(world) {
  let best = null;
  for (let k = world.plagues.length - 1; k >= 0 && k > world.plagues.length - 40; k--) {
    const p = world.plagues[k];
    if (!p || !p.name || world.time.day - (p.startDay || 0) > 60 * Y) continue;
    if ((p.deaths || 0) >= 2000 && (!best || p.deaths > best.deaths)) best = p;
  }
  return best ? best.name.replace(/^the\s+/i, 'the ') : null;
}
/** The HUD label of an age name: "the Age of the Horse Lords" → "Horse Lords", "the Red Summers" → "Red Summers". */
const shortOf = (name) => {
  const n = String(name || '').replace(/^the\s+/i, '');
  const m = /^Age of the (.+)$/.exec(n);
  return m ? m[1] : n.charAt(0).toUpperCase() + n.slice(1);
};

const BEGIN = {
  prophets: ['Seers began to wander the roads of the world, preaching of gods no one had named before; chroniclers would call these centuries {name}.'],
  restless: ['The earth would not lie still: quakes split the hills and fire mountains woke one after another. It was the beginning of {name}.'],
  plagues: ['Sickness after sickness swept the crowded towns, and the years that followed were remembered as {name}.'],
  horselords: ['Out of the grass seas came riders without number, and {name} began.'],
  peace: ['With {hegemon} the master of half the world, a long quiet settled on the lands; men called it {name}.', 'The great wars burned out, and {name} began: merchants travelled where armies had marched.'],
  winter: ['Summers grew short and the ice crept down from the north; {name} had begun.', 'Year after year the harvests came in late and thin; it was the beginning of {name}.'],
  searovers: ['Black sails appeared off every coast, and no harbour slept easy: {name} had begun.'],
  discovery: ['{who} sailed beyond sight of land and came home with tales of far shores; so dawned {name}.'],
  fire: ['Hot winds and red skies came with {name}; the forests burned and the wells ran low.'],
  strife: ['Every border bled at once, and the chroniclers called the age that followed {name}.'],
  learning: ['Schools and libraries multiplied, and scholars were honoured above generals: {name} had begun.'],
  wanderings: ['Whole peoples took to the roads with their herds and their gods, and {name} began.'],
  omens: ['Comets and falling stars filled the skies, and every seer read doom in them: it was {name}.'],
  plenty: ['Mild seasons filled the granaries year after year; men would remember it as {name}.'],
  dead: ['The dead marched beyond their own lands, and town after town fell silent; it was the beginning of {name}.'],
};
const GENESIS = ['In the first years of the world, ', 'While the world was young, ', 'From the very dawn of history, '];
const END = [
  '{Name} drew to {its} close after {span}.',
  '{Name} passed into memory after {span}.',
];
/** Age names that read as plurals ('the Burning Years' drew to their close). */
const pluralAge = (name) => /\b(Years|Summers|Winters|Seasons|Skies|Centuries|Harvests|Migrations|Wanderings|Snows|Voyages|Treks)$/.test(name) && !/^the (Age|Time|Years) of\b/i.test(name);
const CAT = { winter: 'climate', fire: 'climate', plenty: 'climate', prophets: 'religion', restless: 'disaster', omens: 'disaster', plagues: 'disease', dead: 'myth' };

function beginText(world, key, name, why, genesis) {
  const hegemon = why && why.civ != null && world.civs[why.civ] ? civName(world.civs[why.civ]) : 'one great realm';
  const who = why && why.civ != null && world.civs[why.civ] ? cap(peopleOf(world.civs[why.civ])) : 'Bold captains';
  const line = pick(world, BEGIN[key] || ['{name} began.']).replace('{name}', name).replace('{hegemon}', hegemon).replace('{who}', who);
  if (genesis) return pick(world, GENESIS) + line.charAt(0).toLowerCase() + line.slice(1);
  return cap(line);
}

/** Begin an age (writes its entry). why: { k: 'roll'|'genesis'|trigger, civ? }. */
function beginAge(world, key, why, opts = {}) {
  const a = agesState(world);
  const day = world.time.day;
  const years = opts.years ?? world.rng.int(250, 500);
  const name = ageName(world, key, why);
  const age = { key, name, short: shortOf(name), from: day, until: day + years * Y, why: why?.k || 'roll' };
  if (why && why.civ != null) age.civ = why.civ;
  a.cur.push(age);
  let text = beginText(world, key, name, why, opts.genesis);
  if (opts.prefix) text = `${opts.prefix} ${text}`;
  const civ = why && why.civ != null ? world.civs[why.civ] : null;
  recordFree(world, 'ages', 'age', {
    text, imp: opts.genesis ? 3 : 4, cat: CAT[key] || 'civ', civ: civ || undefined,
    ref: { k: 'event', id: 'age:' + key }, tags: ['age', key], icon: 'age', cause: opts.cause,
  });
  return age;
}

function endAge(world, age, quiet = false) {
  const a = agesState(world);
  const k = a.cur.indexOf(age);
  if (k >= 0) a.cur.splice(k, 1);
  a.past.push({ key: age.key, name: age.name, ...(age.short ? { short: age.short } : {}), from: age.from, to: world.time.day, why: age.why });
  if (a.past.length > 40) a.past.splice(0, a.past.length - 40);
  const span = Math.max(1, Math.round((world.time.day - age.from) / Y));
  const Name = cap(age.name);
  const line = pick(world, END).replace('{Name}', Name).replace('{its}', pluralAge(age.name) ? 'their' : 'its').replace('{span}', `${span} year${span === 1 ? '' : 's'}`);
  if (!quiet) recordFree(world, 'ages', 'age.end', { text: line, imp: 3, cat: CAT[age.key] || 'civ', ref: { k: 'event', id: 'age:' + age.key }, tags: ['age', age.key] });
  return line;
}

/** At genesis (init): the world's first one or two ages. */
export function seedAges(world) {
  const a = agesState(world);
  if (a.seeded) return;
  a.seeded = true;
  if (!agesOn(world)) return;
  // a world loaded from before the ages existed starts one now, not 'in the first years'
  const genesis = world.time.day < Y;
  const k1 = rollKey(world, []);
  if (k1) beginAge(world, k1, { k: genesis ? 'genesis' : 'roll' }, { genesis });
  if (k1 && world.rng.chance(0.4)) {
    const k2 = rollKey(world, [k1]);
    if (k2) beginAge(world, k2, { k: genesis ? 'genesis' : 'roll' }, { genesis, years: world.rng.int(150, 350) });
  }
  syncAgeEffects(world);
}

// ---------------------------------------------------------------------------
// Triggers (yearly): the world calls for an age

function hegemon(world) {
  const civs = liveCivs(world);
  if (civs.length < 4) return null;
  let tot = 0, best = null;
  for (const c of civs) { tot += c.population || 0; if (!best || (c.population || 0) > (best.population || 0)) best = c; }
  return best && tot > 0 && best.population / tot >= 0.4 ? best : null;
}
function warringShare(world) {
  const civs = liveCivs(world);
  if (civs.length < 4) return 0;
  const set = new Set();
  for (const w of world.wars) if (w && w.active) { for (const x of w.attackers) set.add(x); for (const x of w.defenders) set.add(x); }
  let n = 0;
  for (const c of civs) if (set.has(c.id)) n++;
  return n / civs.length;
}
function notablePlagues(world, years) {
  const from = world.time.day - years * Y;
  let n = 0;
  for (let k = world.plagues.length - 1; k >= 0; k--) {
    const p = world.plagues[k];
    if (!p) continue;
    if (p.startDay < from) break;
    if (p.notable || (p.deaths || 0) >= 0.03 * (p.worldPopAtStart || 1e9)) n++;
  }
  return n;
}

function triggered(world) {
  const a = agesState(world);
  const day = world.time.day;
  const active = (k) => a.cur.some((x) => x.key === k);
  // an age that ended within the last half-century is not called for again yet
  const taken = (k) => active(k) || a.past.some((x) => x.key === k && day - x.to < 50 * Y);
  if ((world.climate.tempOffset || 0) <= -1.5 && !taken('winter')) return ['winter', { k: 'ice' }];
  if (!taken('plagues') && notablePlagues(world, 50) >= 3) return ['plagues', { k: 'plagues' }];
  const h = hegemon(world);
  if (h && !taken('peace') && !active('strife')) return ['peace', { k: 'hegemon', civ: h.id }];
  if (a.strife >= 5 && !taken('strife') && !active('peace')) return ['strife', { k: 'wars' }];
  if (!a.once.discovery && !taken('discovery')) {
    const c = liveCivs(world).find((x) => hasTech(x, 'navigation'));
    if (c) { a.once.discovery = world.time.day; return ['discovery', { k: 'navigation', civ: c.id }]; }
  }
  if (!a.once.learning && !taken('learning')) {
    const c = liveCivs(world).find((x) => hasTech(x, 'printing'));
    if (c) { a.once.learning = world.time.day; return ['learning', { k: 'printing', civ: c.id }]; }
  }
  if (!taken('restless') && heatOf(world, 'restless', SUBJ.world) >= 1) return ['restless', { k: 'eruption' }];
  return null;
}

/** Every living realm carries the civ effect of each running age ('age:<key>', until it ends);
 * effects of ages that are over are taken away. Writes only when something changed. */
function syncAgeEffects(world) {
  const a = agesState(world);
  const on = agesOn(world);
  const day = world.time.day;
  for (const civ of liveCivs(world)) {
    for (const e of civ.effects || []) {
      if (!e.k.startsWith('age:')) continue;
      const key = e.k.slice(4);
      if (!on || !a.cur.some((x) => x.key === key)) removeEffect(world, { kind: 'civ', id: civ.id }, e.k);
    }
    if (!on) continue;
    for (const age of a.cur) {
      const m = AGES[age.key] && AGES[age.key].civ;
      if (!m || age.until <= day) continue;
      const cur = getEffect(world, { kind: 'civ', id: civ.id }, 'age:' + age.key);
      if (!cur || cur.until !== age.until) addEffect(world, { kind: 'civ', id: civ.id }, { k: 'age:' + age.key, until: age.until, m, label: cap(age.name) });
    }
  }
}

/** Yearly (day 180): expire ages, roll replacements, answer triggers, prune boosts. */
export function agesYear(world) {
  const st = evState(world);
  const day = world.time.day;
  st.boosts = st.boosts.filter((b) => b.until > day);
  for (const k of Object.keys(st.emb)) if (!(st.emb[k] > day)) delete st.emb[k];
  if (st.collapse && !(st.collapse.until > day)) st.collapse = null;
  const a = agesState(world);
  a.strife = warringShare(world) >= 0.5 ? (a.strife || 0) + 1 : 0;
  if (!agesOn(world)) { syncAgeEffects(world); return; }
  if (!a.seeded) { seedAges(world); syncAgeEffects(world); return; }
  // ages that ran their course (a year in which an age ended or began answers no trigger: the
  // world does not end an age and start another, or the same one, in a single breath)
  let turned = false;
  for (const age of a.cur.slice()) {
    if (age.until > day) continue;
    turned = true;
    const ended = endAge(world, age, true);
    const others = a.cur.map((x) => x.key);
    if (a.cur.length === 0 || world.rng.chance(0.4)) {
      const nk = rollKey(world, others.concat([age.key]));
      if (nk) { beginAge(world, nk, { k: 'roll' }, { prefix: ended }); continue; }
    }
    recordFree(world, 'ages', 'age.end', { text: ended, imp: 3, cat: CAT[age.key] || 'civ', ref: { k: 'event', id: 'age:' + age.key }, tags: ['age', age.key] });
  }
  // switched on mid-run, or every age ended without a successor: the world is never ageless
  if (!a.cur.length) {
    const nk = rollKey(world, []);
    if (nk) { beginAge(world, nk, { k: 'roll' }); turned = true; }
  }
  // the world calls for an age (at most one a century)
  const t = !turned && day - a.trig >= 100 * Y ? triggered(world) : null;
  if (!t) { syncAgeEffects(world); return; }
  const [key, why] = t;
  a.trig = day;
  const out = a.cur.filter((x) => clashes(x.key, key));
  let prefix = null;
  for (const x of out) prefix = endAge(world, x, true);
  if (a.cur.length >= MAX_AGES) prefix = endAge(world, a.cur[0], true);
  beginAge(world, key, why, { years: world.rng.int(120, 260), prefix });
  syncAgeEffects(world);
}

/** Start an age now (black swans and fate use this; replaces a clashing or the oldest age). */
export function forceAge(world, key, why, years, cause = null) {
  if (!agesOn(world) || !AGES[key]) return null;
  const a = agesState(world);
  if (a.cur.some((x) => x.key === key)) return null;
  let prefix = null;
  for (const x of a.cur.filter((y) => clashes(y.key, key))) prefix = endAge(world, x, true);
  if (a.cur.length >= MAX_AGES) prefix = endAge(world, a.cur[0], true);
  const age = beginAge(world, key, why, { years, prefix, cause });
  syncAgeEffects(world);
  return age;
}

/** A timed multiplier on a rates key (black swans): sys.events.boosts. */
export function addBoost(world, key, mul, years, why = null) {
  const st = evState(world);
  st.boosts.push({ key, mul, until: world.time.day + Math.round(years * Y), why });
  if (st.boosts.length > 24) st.boosts.splice(0, st.boosts.length - 24);
}

// ---------------------------------------------------------------------------
// HUD view (pure)

/** The ages now running: [{ key, name, short, desc, tone, from, until, years, why }]. */
export function currentAges(world) {
  const a = world?.sys?.events?.ages;
  if (!a || !Array.isArray(a.cur) || !agesOn(world)) return [];
  const day = world.time.day;
  return a.cur.map((x) => {
    const d = AGES[x.key] || {};
    return { key: x.key, name: x.name, short: x.short || d.short || x.name, desc: d.desc || '', tone: d.tone || 'neutral', from: x.from, until: x.until, years: Math.floor((day - x.from) / Y), why: x.why };
  });
}
/** Every age the world has known, oldest first (for timelines): [{ key, name, from, to }]. */
export function agesHistory(world) {
  const a = world?.sys?.events?.ages;
  if (!a) return [];
  const out = (a.past || []).map((x) => ({ key: x.key, name: x.name, from: x.from, to: x.to }));
  for (const x of a.cur || []) out.push({ key: x.key, name: x.name, from: x.from, to: null });
  return out.sort((p, q) => p.from - q.from);
}

// ---------------------------------------------------------------------------
// Providers (pure, cheap; neutral when nothing applies)

registerProvider('rates', 'events.ages', (world, key) => {
  const st = world.sys && world.sys.events;
  if (!st) return 1;
  let m = 1;
  const a = st.ages;
  if (a && a.cur && a.cur.length && agesOn(world)) {
    for (let k = 0; k < a.cur.length; k++) {
      const def = AGES[a.cur[k].key];
      const v = def && def.rates ? def.rates[key] : undefined;
      if (typeof v === 'number') m *= v;
    }
  }
  const b = st.boosts;
  if (b && b.length) {
    const day = world.time.day;
    for (let k = 0; k < b.length; k++) if (b[k].key === key && b[k].until > day) m *= b[k].mul;
  }
  return m;
});

const idOf = (c) => (c && typeof c === 'object' ? c.id : c);

registerProvider('warAppetite', 'events.ages', (world, a, b) => {
  const st = world.sys && world.sys.events;
  if (!st) return 1;
  let m = 1;
  const ag = st.ages;
  if (ag && ag.cur && ag.cur.length && agesOn(world)) {
    for (let k = 0; k < ag.cur.length; k++) { const def = AGES[ag.cur[k].key]; if (def && typeof def.war === 'number') m *= def.war; }
  }
  const ia = idOf(a), ib = idOf(b);
  if (ia != null && ib != null && ia !== ib) {
    // feuds between the two (border skirmishes, plots, cattle raids) whet the appetite
    const feud = heatOf(world, 'feud', SUBJ.pair(ia, ib));
    if (feud > 0) m *= 1 + Math.min(1, feud) * 0.4;
    const amity = heatOf(world, 'amity', SUBJ.pair(ia, ib));
    if (amity > 0) m *= 1 - Math.min(1, amity) * 0.3;
  }
  return m;
});

registerProvider('routeValue', 'events.ages', (world, route) => {
  const st = world.sys && world.sys.events;
  if (!st || !route) return 1;
  let m = 1;
  const ag = st.ages;
  if (ag && ag.cur && ag.cur.length && agesOn(world)) {
    for (let k = 0; k < ag.cur.length; k++) {
      const def = AGES[ag.cur[k].key];
      if (!def) continue;
      if (typeof def.route === 'number') m *= def.route;
      if (route.kind === 'sea' && typeof def.routeSea === 'number') m *= def.routeSea;
    }
  }
  const day = world.time.day;
  const col = st.collapse;
  if (col && col.until > day && Array.isArray(col.civs) && (col.civs.includes(route.civA) || col.civs.includes(route.civB))) m *= 0.5;
  if (route.civA != null && route.civB != null && route.civA !== route.civB) {
    const lo = Math.min(route.civA, route.civB), hi = Math.max(route.civA, route.civB);
    const until = st.emb[lo + '_' + hi];
    if (until && until > day) m *= 0.1;
  }
  return m;
});

