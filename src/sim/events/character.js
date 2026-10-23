// City character: what makes one town unlike another. The sole writer of s.traits, s.epithet,
// s.legend and s.hist (contracts §3).
//   legend     rolled on settlementCreated: a founder, an omen, a ford, a holy spring, the ruins
//              it was raised on …  { kind, text }
//   specialty  1 on reaching Town tier, a 2nd at City, chosen from the catchment potentials and
//              buildings (data.js SPECIALTIES) as permanent effects within ±15 %
//   traits     earned by events ('sacred site', 'rebuilt in stone', 'horse-tamers' …) — ≤ 3 keys
//   hist       counters fed by sieges, fires, quakes, plagues, conquests and riots, from hooks
//              and a siege watch that also works when the war module emits no siege hooks
//   epithet    earned from hist and standing ('the Unbowed', 'the Twice-Burned', 'the Golden'),
//              lost when contradicted ('the Unbowed' falls with its walls); its words are composed
//              (data.js EPITHET_FORMS, epithetText): 'the Shield of the Varathi', 'of the Hundred Stalls'
// Per-town memory beyond the kernel shape lives in sys.events.cm[sid] (holds since the last
// conquest, fairs held, the day of its worst plague, the last epithet change, the key of the
// epithet it carries: ek).

import { on } from '../../core/hooks.js';
import { addEffect, removeEffect } from '../../core/effects.js';
import { liveSettlements } from '../../core/entities.js';
import { DAYS_PER_YEAR, TIERS, WATER } from '../../core/constants.js';
import { SPECIALTIES, SPECIALTY_BY_KEY, TRAITS, EPITHETS, EPITHET_BY_TEXT, EPITHET_BY_KEY, EPITHET_FORMS, EPITHET_SIG, isSpecialty } from './data.js';
import { composeName, isEnglishWord } from '../../core/names.js';
import { evState, recordFree, routesOf } from './engine.js';
import { govFactor } from './governor.js';
import { SUBJ, addHeat, clearSubject } from './heat.js';
import { resettle } from './ruins.js';
import {
  pick, say, peopleOf, rulerName, personName, riverAt, featureNear, terrainNoun,
  countWord, ordinal, shareWord, yearsWord, isLakeside,
} from './prose.js';

const MAX_TRAITS = 3;
const yearNow = (world) => Math.floor(world.time.day / DAYS_PER_YEAR);
export const cityMem = (world, sid) => (evState(world).cm[sid] ||= {});

// ---------------------------------------------------------------------------
// hist and traits (the only writers)

const HIST = ['sieges', 'held', 'fires', 'quakes', 'plagues', 'conquered', 'riots'];
export function bumpHist(world, s, key, n = 1) {
  if (!s || !HIST.includes(key)) return;
  const h = (s.hist && typeof s.hist === 'object') ? s.hist : (s.hist = {});
  for (const k of HIST) if (!Number.isFinite(h[k])) h[k] = 0;
  h[key] += n;
}

/** Add a trait (or specialty) key with its permanent effect; ≤ 3 per town. Returns true if added. */
export function addTrait(world, s, key, src = null) {
  if (!s || !s.alive || !key) return false;
  if (!Array.isArray(s.traits)) s.traits = [];
  if (s.traits.includes(key)) return false;
  const spec = SPECIALTY_BY_KEY[key];
  if (s.traits.length >= MAX_TRAITS) {
    // a specialty may displace the oldest event trait; an event trait never displaces anything
    const k = spec ? s.traits.findIndex((t) => !isSpecialty(t)) : -1;
    if (k < 0) return false;
    const old = s.traits[k];
    s.traits.splice(k, 1);
    removeEffect(world, { kind: 'settlement', id: s.id }, 'trait:' + old);
  }
  s.traits.push(key);
  const m = spec ? spec.m : TRAITS[key]?.m;
  if (m) addEffect(world, { kind: 'settlement', id: s.id }, { k: (spec ? 'spec:' : 'trait:') + key, until: -1, m, src: src ?? undefined });   // (the key is its own label: s.traits shows it)
  return true;
}
export const hasTrait = (s, key) => Array.isArray(s.traits) && s.traits.includes(key);

// ---------------------------------------------------------------------------
// Legends

const OMENS = [
  'a white stag drinking at dawn', 'an eagle that dropped a fish at the feet of the elders', 'a falling star that struck the hill',
  'two ravens that circled the spring three times', 'a she-wolf that would not leave the clearing', 'a lightning-split oak that still bore leaves',
  'a swarm of bees that settled on the chieftain’s spear', 'a child who dreamed of a house with a hundred hearths',
  'a heron that stood three days on one leg in the ford', 'a red fox that led the children to a hidden spring', 'an owl that spoke the founder’s name at midnight',
  'a cairn of white stones no one remembered raising', 'a rainbow that ended on the hilltop', 'a stallion that would go no further and lay down in the grass',
  'a boar that broke its tusk on a buried stone', 'smoke from a fire that no hand had kindled',
];
const ROLES = ['hunter', 'herdswoman', 'smith', 'outcast', 'widow', 'boatman', 'shaman', 'potter', 'exile'];
const ORE_NAMES = { 1: 'copper', 2: 'tin', 3: 'iron', 4: 'gold', 5: 'gems', 6: 'marble', 9: 'salt' };

function nearestKin(world, s) {
  const civ = world.civs[s.civId];
  if (!civ) return null;
  let best = null, bd = 30 * 30;
  for (const id of civ.settlementIds) {
    if (id === s.id) continue;
    const o = world.settlements[id];
    if (!o || !o.alive) continue;
    const d = (o.x - s.x) ** 2 + (o.y - s.y) ** 2;
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}
function oreNear(world, s) {
  const { W, H, f } = world;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const r = f.resource[y * W + x];
    if (ORE_NAMES[r]) return ORE_NAMES[r];
  }
  return null;
}

function makeLegend(world, s, ruin) {
  const civ = world.civs[s.civId];
  const { f } = world;
  if (ruin && ruin.old && ruin.old !== s.name) {
    return { kind: 'ruin', text: ruin.kin
      ? `Raised by the children of its founders on the ruins of ${ruin.old}.`
      : `Raised on the tumbled stones of ${ruin.old}, a town of another people.` };
  }
  if (ruin && ruin.old) return { kind: 'ruin', text: `Raised again on its own ruins after ${ruin.years >= 100 ? 'centuries' : 'long years'} of silence.` };
  const parent = nearestKin(world, s);
  const people = peopleOf(civ);
  const name = s.name;
  const founder = personName(world, civ);
  const opts = [];
  if (!civ || civ.settlementIds.length <= 1) opts.push(['first', 3]);
  const river = riverAt(world, s.x, s.y);
  if (river && f.river[s.i] >= 2) opts.push(['ford', 2]);
  if (f.coast[s.i]) opts.push(['harbor', 2]);
  else if (isLakeside(world, s)) opts.push(['lake', 1.5]);
  const ore = oreNear(world, s);
  if (ore) opts.push(['mine', 1.5]);
  if (parent) opts.push(['colony', 2]);
  opts.push(['omen', 2], ['founder', 2]);
  if (!river && !f.coast[s.i]) opts.push(['spring', 1.2]);
  if (civ && civ.ruler && civ.ruler.name && civ.settlementIds.length > 2) opts.push(['vow', 1]);
  if (parent && (parent.famine > 0 || (civ && civ.warWeariness > 0.2))) opts.push(['refuge', 2]);
  let total = 0;
  for (const o of opts) total += o[1];
  let r = world.rng.next() * total, kind = opts[0][0];
  for (const o of opts) { if (r < o[1]) { kind = o[0]; break; } r -= o[1]; }
  const came = { 'the coast': 'came in boats from beyond the sea', 'the river': 'followed the river down from the hills', 'the hills': 'came down from the high pastures',
    'the plains': 'came out of the grass sea', 'the marshes': 'found a dry island in the marshes', 'the woods': 'came out of the deep woods' }[terrainNoun(world, s)] || 'came from far away';
  const v = { people, name, founder, river, parent: parent ? parent.name : null, ore, came, role: pick(world, ROLES), omen: pick(world, OMENS),
    sea: f.coast[s.i] ? featureNear(world, 'sea', s.x, s.y, 50) || 'the sea' : null, ruler: civ && civ.ruler ? rulerName(civ.ruler, false) : null };
  let text;
  switch (kind) {
    case 'first': text = say(world, [
      'The first hearth of {people}: the old songs said their ancestors {came} and kindled a fire here at the dawn of the world.',
      'Here, {people} said, the first of their mothers planted her digging stick and claimed the land for her children.',
    ], v); break;
    case 'ford': text = say(world, [
      'It grew up around a ford of {river}, where herders drove their beasts across in the dry months.',
      'Its people told that {founder} the {role} waded {river} here with a lamb on {his} shoulders, and built on the far bank.',
    ], { ...v, his: world.rng.chance(0.5) ? 'his' : 'her' }); break;
    case 'harbor': text = say(world, [
      'Fishers of {people} found a sheltered cove on {sea} and drew their boats up on its shingle; {name} grew around their huts.',
      'A storm drove the boats of {founder} into the bay, and {founder} swore never to leave the shelter that had saved them.',
    ], v); break;
    case 'lake': text = say(world, [
      'Founded on the lake shore by eel-fishers, who said the waters gave more than the land ever would.',
      'Reed-cutters of {people} camped on the shore here each summer, until {founder} the {role} built the first house that stayed.',
      '{founder} the {role} built the first stilt-house over the shallows here, and others followed.',
    ], v); break;
    case 'mine': text = say(world, [
      'Prospectors following a seam of {ore} into the hills founded it, and for generations its people dug.',
      '{founder} found {ore} glinting in a stream bed here, and the camp of diggers became a town.',
    ], v); break;
    case 'colony': text = say(world, [
      'Settlers from {parent} founded it, led by {founder} the {role}.',
      'When {parent} grew crowded, {founder} led the young families out to found {name}.',
      'Its founders came from {parent}, driving their herds before them, and named the place for the first spring they found.',
    ], v); break;
    case 'omen': text = say(world, [
      'Its founders told how {omen} showed them the place.',
      'They built where they did because of {omen}, or so the grandmothers said.',
    ], v); break;
    case 'founder': text = say(world, [
      '{founder} the {role} founded it after driving a spear into the earth and swearing to go no further.',
      '{founder} the {role}, quarrelling with the elders of {home}, walked out with a dozen kin and built {name}.',
      'It was founded by {founder}, a {role} who followed a lost goat over the hills and found a valley worth keeping.',
    ], { ...v, home: v.parent || 'the old camp' }); break;
    case 'spring': text = say(world, [
      'It was built around a spring the elders held sacred; its water was said to cure fevers.',
      'The well of {founder} the {role}, dug where a hazel rod twitched, still stood in the oldest square of {name}.',
      'A spring that never froze drew the first families here, and they hung offerings on the alders beside it.',
    ], v); break;
    case 'vow': text = say(world, [
      '{ruler} founded it in fulfilment of a vow: a new town for every year without war.',
      '{ruler} ordered it built to guard the road to {home}.',
    ], { ...v, home: v.parent || 'the capital' }); break;
    case 'refuge': text = say(world, parent.famine > 0 ? [
      'Families fleeing hunger in {parent} built it in haste, and for a century it kept the look of a camp.',
      'It was founded by the starving of {parent}, who walked until they found land no one had yet ploughed.',
    ] : [
      'It was founded by refugees from the troubles of {parent}, who wanted nothing but to be left alone.',
      'Families weary of the wars around {parent} slipped away to found it, as far from the marching roads as they could get.',
    ], v); break;
    default: text = `Founded by ${people}.`;
  }
  return { kind, text };
}

function onCreated(world, s) {
  evState(world);
  const ruin = resettle(world, s);
  if (!s.legend) s.legend = makeLegend(world, s, ruin);
}

// ---------------------------------------------------------------------------
// Specialties

function specCtx(world, s) {
  const { W, H, f } = world;
  const r = Math.max(1, Math.min(6, s.radius | 0 || 2));
  const res = new Set();
  let hills = f.elevation[s.i] >= 0.62;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    if (f.resource[i] > 0 && f.resourceAmt[i] > 0.05) res.add(f.resource[i]);
    if (!hills && Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && f.water[i] === WATER.LAND && f.elevation[i] >= 0.66) hills = true;
  }
  const routes = routesOf(world, s.id);
  const holy = world.religions.some((x) => x && x.alive !== false && x.holyCityId === s.id);
  const civ = world.civs[s.civId];
  return {
    s, pot: s.flags?.pot, b: s.buildings || {}, res, biome: f.biome[s.i], coastal: Boolean(f.coast[s.i]), lake: isLakeside(world, s),
    river: f.river[s.i] >= 2, hills, routes, holy, sacred: hasTrait(s, 'sacred site'), era: civ?.tech?.era || 0,
  };
}

/** Give a town its specialties when it reaches Town (one) and City (two). Returns keys added. */
export function assignSpecialties(world, s) {
  if (!s || !s.alive || s.tier < 3) return [];
  const want = s.tier >= 4 ? 2 : 1;
  const have = (s.traits || []).filter(isSpecialty);
  if (have.length >= want) return [];
  const c = specCtx(world, s);
  const scored = [];
  for (const sp of SPECIALTIES) {
    if (have.includes(sp.key)) continue;
    let v = 0;
    try { v = sp.score(c); } catch (e) { v = 0; }
    if (v >= 0.5) scored.push([v, sp]);
  }
  scored.sort((a, b) => b[0] - a[0] || (a[1].key < b[1].key ? -1 : 1));
  const added = [];
  for (const [, sp] of scored) {
    if (have.length + added.length >= want) break;
    if (addTrait(world, s, sp.key)) added.push(sp);
  }
  if (added.length) {
    const tier = TIERS[s.tier]?.name.toLowerCase() || 'town';
    const what = added.map((sp) => sp.phrase).join(' and ');
    const all = (s.traits || []).filter(isSpecialty).map((k) => SPECIALTY_BY_KEY[k].phrase);
    recordFree(world, 'character', 'specialty', {
      s, imp: 1,
      text: say(world, all.length > added.length ? [
        'Now a {tier}, {name} was known for {all}.',
        '{name} had grown into a {tier}; travellers spoke of {all}.',
      ] : [
        '{name} had grown into a {tier}, known far and wide for {what}.',
        'Travellers who came to {name}, now a {tier}, remembered {what}.',
        'By Year {year} {name} was a {tier}, and its pride was {what}.',
      ], { name: s.name, tier, what, all: all.join(' and '), year: yearNow(world) }),
    });
  }
  return added.map((sp) => sp.key);
}

// ---------------------------------------------------------------------------
// Epithets (checked once a year per town, on its check day)

/** Yearly standing for epithets, fixed at the year's start (sys.events.wq): wealth thresholds
 * for 'the Golden' and the holy cities of living faiths. */
export function wealthQuantiles(world) {
  const towns = liveSettlements(world).filter((s) => s.tier >= 3);
  const w = towns.map((s) => (Number.isFinite(s.wealth) ? s.wealth : 0)).sort((a, b) => b - a);
  const at = (q) => (w.length ? w[Math.min(w.length - 1, Math.floor(w.length * q))] : -1);
  const holy = [];
  for (const r of world.religions) if (r && r.alive !== false && r.holyCityId != null && (r.followers || 0) > 0) holy.push(r.holyCityId);
  evState(world).wq = { y: yearNow(world), p95: w.length >= 8 ? at(0.05) : -1, p85: w.length >= 8 ? at(0.15) : -1, holy };
}

function epithetCtx(world, s) {
  const st = evState(world);
  const cm = st.cm[s.id] || {};
  const wq = st.wq || { p95: -1, p85: -1, holy: [] };
  const wealth = Number.isFinite(s.wealth) ? s.wealth : 0;
  return {
    s, hist: s.hist || {}, cm, traits: s.traits || [], year: yearNow(world),
    holy: Array.isArray(wq.holy) && wq.holy.includes(s.id),
    wealthRank: wealth > 0 && wq.p95 > 0 && wealth >= wq.p95 ? 0.04 : wealth > 0 && wq.p85 > 0 && wealth >= wq.p85 ? 0.12 : 1,
    age: (world.time.day - (s.foundedDay || 0)) / DAYS_PER_YEAR,
  };
}

// {ep} is the epithet the town earned, composed by epithetText (e.g. "the Unbowed", "the Shield of the Varathi")
const EARN = {
  holy: ['As the holy city of {faith}, {name} came to be called {name} {ep}.', 'Pilgrims of {faith} named their holy city {name} {ep}.'],
  unbowed: ['{name}, which had thrown back {n} sieges, was hailed as {name} {ep}.', 'Its walls had never fallen: men began to call it {name} {ep}.'],
  unbowedAgain: ['{name}, taken once, had since thrown back {n} sieges; men began to call it {name} {ep}.', 'Since its walls last fell, {name} had held against {n} sieges, and it was hailed as {name} {ep}.'],
  free: ['{name}, which had cast off its overlords, was proud to be called {name} {ep}.', 'Free of its old masters, {name} took a new name for itself: {name} {ep}.'],
  great: ['{name} had grown so vast that travellers called it {name} {ep}.', 'No city of the age could match it: {name} {ep}.'],
  golden: ['So rich had {name} become that men called it {name} {ep}.', 'Gold flowed through its markets until {name} was known as {name} {ep}.'],
  phoenix: ['Burned {n} times and each time rebuilt, {name} was called {name} {ep}.', 'Out of its {n} fires {name} rose each time in stone, and the songs named it {name} {ep}.'],
  thriceburned: ['After a third great fire, {name} was known as {name} {ep}.', 'Three times the flames had taken {name}; it was called {name} {ep} thereafter.'],
  weeping: ['{name}, which had buried {share} of its people in a single plague, was remembered as {name} {ep}.', 'The plague left {name} so bereft that it was called {name} {ep} for a century.'],
  twiceburned: ['Twice laid waste by fire, {name} became {name} {ep}.', 'A second great fire gave {name} a name it did not want: {name} {ep}.'],
  ofttaken: ['Having changed masters {n} times, {name} was mocked as {name} {ep}.', 'Every army that passed seemed to take {name}; it was called {name} {ep}.'],
  learned: ['Its scriptoria and schools made it known as {name} {ep}.', 'Scholars came from far realms to the schools of {name} {ep}.'],
  fair: ['Merchants from every road came to {name} {ep}.', '{name} was called {name} {ep} for the great markets it held.'],
  shaken: ['Cracked by earthquake after earthquake, {name} was called {name} {ep}.', 'The ground beneath {name} would not lie still, and men called it {name} {ep}.'],
  restless: ['After its {nth} riot, {name} was called {name} {ep}.', 'No governor could hold {name} for long; after its {nth} riot it was known as {name} {ep}.'],
  ancient: ['{name} had stood for {n} centuries and was called {name} {ep}.', 'Old beyond memory, {name} was known simply as {name} {ep}.'],
};
const LOSE = {
  unbowed: ['{name}, called {epc} for {span}, bowed at last to {by}.', 'The walls of {name} {ep} fell at last; none called it so again.'],
  holy: ['With its faith gone, {name} was no longer called {epc}.'],
  golden: ['The gold had gone from {name}; men no longer called it {epc}.'],
  great: ['Shrunk within its old walls, {name} was no longer called {name} {ep}.'],
  weeping: ['A new generation forgot the old grief, and men no longer called it {name} {ep}.'],
};

/** Names of the land around a town an epithet may borrow ("the Varan Sea", "the Hul Spine"). */
function regionsNear(world, s) {
  const out = [];
  for (const k of ['sea', 'range', 'forest', 'lake', 'river', 'desert']) {
    const n = featureNear(world, k, s.x, s.y, k === 'sea' ? 10 : 12);
    if (n && n.length <= 20) out.push(n);
  }
  return out;
}

/**
 * The epithet a town earns for epithet e, composed from EPITHET_FORMS: a plain one, a fixed
 * combination, or one in the town's own words (its people, realm, region, god). At most 30
 * letters; the canonical text when nothing fits. Draws world.rng (wording only).
 */
export function epithetText(world, s, e) {
  const def = EPITHET_FORMS[e.key];
  if (!def) return e.text;
  const civ = world.civs[s.civId];
  const live = civ && civ.alive !== false;
  const faith = e.key === 'holy' ? world.religions.find((x) => x && x.alive !== false && x.holyCityId === s.id) : null;
  const realm = live ? (civ.baseName || civ.name) : null;
  const vocab = {
    ...def.words,
    people: live && civ.adjective && !isEnglishWord(civ.adjective) ? peopleOf(civ) : null,
    realm: realm && realm.length <= 14 && !/\s/.test(realm) ? realm : null,
    region: regionsNear(world, s),
    deity: faith && faith.deity ? faith.deity : null,
  };
  for (let k = 0; k < 4; k++) {
    const t = composeName(world.rng, def.forms, vocab);
    if (t && t.length <= 30) return t;
  }
  return e.text;
}

function epithetVars(world, s, key, c) {
  const h = c.hist;
  const faith = world.religions.find((x) => x && x.alive !== false && x.holyCityId === s.id);
  return {
    name: s.name, faith: faith ? faith.name : 'its faith',
    n: key === 'unbowed' ? countWord(c.cm.hc || 2) : key === 'ofttaken' ? countWord(h.conquered || 3) : key === 'phoenix' ? countWord(h.fires || 2) : key === 'ancient' ? countWord(Math.floor(c.age / 100)) : 'many',
    nth: ordinal(h.riots || 3), share: shareWord(c.cm.pfrac || 0.25), ep: c.ep || '',
  };
}

/** Remember an epithet a town lost (forever: -1) or had displaced, with its counter then (EPITHET_SIG). */
function noteLost(world, s, key, c, forever = false) {
  const sig = EPITHET_SIG[key];
  const cm = cityMem(world, s.id);
  // an epithet of standing (the Golden, the Great …) may come back, but not within a lifetime
  if (!sig && !forever) { (cm.ly ||= {})[key] = c.year; return; }
  (cm.lost ||= {})[key] = forever ? -1 : sig(c);
}
/** May the town take this epithet (again)? Not if it was lost for good, or its counter has not grown since. */
function mayEarn(c, e) {
  const ly = c.cm.ly && c.cm.ly[e.key];
  if (ly != null && c.year - ly < 80) return false;
  const was = c.cm.lost && c.cm.lost[e.key];
  if (was == null) return true;
  if (was < 0) return false;
  const sig = EPITHET_SIG[e.key];
  return !sig || sig(c) > was;
}

/** Earn, keep or lose an epithet (deterministic; no rng except the wording). */
export function updateEpithet(world, s) {
  if (!s || !s.alive) return;
  // only towns earn epithets (and a Free City of any size): nothing to weigh for the rest
  if (s.tier < 3 && !s.epithet && !(s.traits && s.traits.includes('free city'))) return;
  const c = epithetCtx(world, s);
  const cm = c.cm;
  const day = world.time.day;
  // the epithet's key is kept in city memory (older saves stored only the canonical text)
  const cur = s.epithet ? (cm.ek && EPITHET_BY_KEY[cm.ek]) || EPITHET_BY_TEXT[s.epithet] || null : null;
  if (cur) {
    const ok = cur.keep ? cur.keep(c) : cur.test(c);
    if (!ok) {
      const span = Math.round((day - (cm.eday ?? s.foundedDay ?? day)) / DAYS_PER_YEAR);
      const by = world.civs[s.civId];
      const was = s.epithet;
      s.epithet = null;
      cityMem(world, s.id).eday = day;
      delete cityMem(world, s.id).ek;
      // the walls fell: 'none called it so again' (and its count of sieges held starts over)
      noteLost(world, s, cur.key, c, cur.key === 'unbowed');
      if (cur.key === 'unbowed') cityMem(world, s.id).hc = 0;
      const pool = LOSE[cur.key];
      if (pool && s.tier >= 3) {
        recordFree(world, 'character', 'epithet', {
          s, imp: (cur.key === 'unbowed' || cur.key === 'holy') && s.tier >= 4 ? 2 : 1, tags: ['epithet-lost'],
          text: say(world, pool, { name: s.name, ep: was, epc: /^of\s/.test(String(was)) ? `${s.name} ${was}` : was, span: span >= 2 ? yearsWord(span) : 'a time', by: by ? peopleOf(by) : 'its enemies' }),
        });
      }
      return;
    }
  }
  let best = null, bestIdx = EPITHETS.length;
  for (let k = 0; k < EPITHETS.length; k++) {
    if (cur && cur.key === EPITHETS[k].key) { best = cur; bestIdx = k; break; }
    if (EPITHETS[k].test(c) && mayEarn(c, EPITHETS[k])) { best = EPITHETS[k]; bestIdx = k; break; }
  }
  if (!best || (cur && cur.key === best.key)) return;
  const curIdx = cur ? EPITHETS.indexOf(cur) : EPITHETS.length;
  if (bestIdx >= curIdx) return;
  // new epithets wait for a quieter year when the Chronicle is crowded (rare ones a little less)
  const gf = govFactor(world, 'character');
  if (gf < (best.rare ? 0.5 : 1)) return;
  // a town's name changes at most once a generation (earned, replaced or lost)
  if (cm.eday != null && day - cm.eday < 30 * DAYS_PER_YEAR) return;
  if (cur) noteLost(world, s, cur.key, c);
  s.epithet = epithetText(world, s, best);
  const mem = cityMem(world, s.id);
  mem.eday = day;
  mem.ek = best.key;
  c.ep = s.epithet;
  const pool = best.key === 'unbowed' && (c.hist.conquered || 0) > 0 ? EARN.unbowedAgain : EARN[best.key];
  recordFree(world, 'character', 'epithet', {
    s, imp: best.rare || s.tier >= 4 ? 2 : 1, tags: ['epithet'],
    text: say(world, pool || ['{name} was called {name} {ep}.'], epithetVars(world, s, best.key, c)),
  });
}

/** Once a year per town (its check day): specialties that are due, then the epithet. */
export function townYear(world, s) {
  if (s.tier >= 3) {
    const want = s.tier >= 4 ? 2 : 1;
    let have = 0;
    for (const t of s.traits || []) if (isSpecialty(t)) have++;
    if (have < want) assignSpecialties(world, s);
  }
  updateEpithet(world, s);
}

// ---------------------------------------------------------------------------
// Siege watch: sys.events.sg[sid] = { d: start day, o: owner at start, c: besieger }

function siegeBegan(world, s, besieger) {
  const st = evState(world);
  if (st.sg[s.id]) return;
  st.sg[s.id] = { d: world.time.day, o: s.civId, c: besieger ?? -1 };
}
/** A siege lifted with the town still in its owner's hands. Only real sieges (a month or more)
 * count toward 'held', the Unbowed and the siege-endured event; days unknown counts as real. */
function siegeHeld(world, s, besieger = null, days = null) {
  const st = evState(world);
  const g = st.sg[s.id];
  delete st.sg[s.id];
  const len = days ?? (g ? world.time.day - g.d : 60);
  if (len < 30) return; // a raid at the gates, not a siege
  bumpHist(world, s, 'sieges');
  // a long siege leaves more pride (and more chance of a siege-endured story) than a short one
  const by = besieger ?? (g ? g.c : null);
  const cm = cityMem(world, s.id);
  if (by != null && by >= 0) cm.lb = by;
  bumpHist(world, s, 'held');
  cm.hc = (cm.hc || 0) + 1;
  addHeat(world, 'siege_held', SUBJ.town(s.id), Math.min(1, len / 240));
}
/** Every few days: notice sieges that began or were lifted (works without WP4's siege hooks). */
export function watchSieges(world) {
  const st = evState(world);
  for (const s of liveSettlements(world)) if (s.siege && !st.sg[s.id]) siegeBegan(world, s, s.siege.civId);
  for (const k of Object.keys(st.sg)) {
    const s = world.settlements[k];
    const g = st.sg[k];
    if (!s || !s.alive) { delete st.sg[k]; continue; }
    if (s.siege) continue;
    if (s.civId === g.o) siegeHeld(world, s); else delete st.sg[k];
  }
}

// ---------------------------------------------------------------------------
// Hooks

on('settlementCreated', onCreated);

on('tierChanged', (world, s, from, to) => {
  if (!s || !s.alive || !(to >= 3) || !world.sys.events) return;
  assignSpecialties(world, s);
});

on('siegeStarted', (world, p) => {
  const s = p && world.settlements[p.sid];
  if (s && s.alive) siegeBegan(world, s, p.civId);
});
on('siegeEnded', (world, p) => {
  const s = p && world.settlements[p.sid];
  if (!s || !s.alive) return;
  if (p.outcome === 'lifted' || p.outcome === 'broken') {
    siegeHeld(world, s, p.civId, Number.isFinite(p.days) ? p.days : null);
  }
});

on('settlementTransferred', (world, s, oldId, newId, cause) => {
  if (!s) return;
  const st = evState(world);
  if (st.sg[s.id]) { bumpHist(world, s, 'sieges'); delete st.sg[s.id]; } // a siege that ended in its fall
  if (cause === 'conquest' || cause === 'conquered' || cause === 'capture') {
    bumpHist(world, s, 'conquered');
    if (st.cm[s.id]) st.cm[s.id].hc = 0;
  }
  st.fall.push({ sid: s.id, day: world.time.day, from: oldId, to: newId, x: s.x, y: s.y, k: cause === 'conquest' ? 't' : 'o' });
  if (st.fall.length > 24) st.fall.splice(0, st.fall.length - 24);
});

on('settlementDestroyed', (world, s, cause) => {
  if (!s) return;
  const st = evState(world);
  delete st.sg[s.id];
  delete st.cm[s.id];
  clearSubject(world, SUBJ.town(s.id));
  st.fall.push({ sid: s.id, day: world.time.day, from: s.civId, to: -1, x: s.x, y: s.y, k: 'x', cause: String(cause || '') });
  if (st.fall.length > 24) st.fall.splice(0, st.fall.length - 24);
});

on('fireEnded', (world, fire) => {
  if (!fire) return;
  const towns = Array.isArray(fire.hit) ? fire.hit : Array.isArray(fire.towns) ? fire.towns : [];
  const big = (fire.deaths || 0) >= 20 || (fire.tiles || 0) >= 40;
  if (!big) return;
  for (const sid of towns.slice(0, 8)) {
    const s = world.settlements[sid];
    if (s && s.alive && s.tier >= 1) { bumpHist(world, s, 'fires'); addHeat(world, 'rebuild', SUBJ.town(s.id), 0.6); }
  }
});

on('quake', (world, q) => {
  if (!q || !(q.mag >= 6) || !Array.isArray(q.towns)) return;
  for (const sid of q.towns.slice(0, 8)) {
    const s = world.settlements[sid];
    if (s && s.alive) { bumpHist(world, s, 'quakes'); addHeat(world, 'rebuild', SUBJ.town(s.id), 0.5); }
  }
});

on('plagueDeaths', (world, p) => {
  if (!p || !(p.deaths > 0) || p.pid == null || p.sid == null) return;
  const st = evState(world);
  const k = p.pid + '|' + p.sid;
  st.pd[k] = Math.round((st.pd[k] || 0) + p.deaths);
});

function plagueClosed(world, plague) {
  if (!plague) return;
  const st = evState(world);
  const done = (st.pend.pdone ||= []);
  if (done.includes(plague.id)) return;
  done.push(plague.id);
  if (done.length > 60) done.splice(0, done.length - 60);
  const prefix = plague.id + '|';
  let any = false;
  for (const k of Object.keys(st.pd)) {
    if (!k.startsWith(prefix)) continue;
    any = true;
    const s = world.settlements[k.slice(prefix.length)];
    const dead = st.pd[k];
    delete st.pd[k];
    if (!s || !s.alive) continue;
    const frac = dead / Math.max(1, dead + s.population);
    if (frac >= 0.25) markWeeping(world, s, frac);
  }
  if (!any && plague.worst && plague.worst.frac >= 0.25) {
    const s = world.settlements[plague.worst.sid];
    if (s && s.alive) markWeeping(world, s, plague.worst.frac);
  }
}
function markWeeping(world, s, frac) {
  bumpHist(world, s, 'plagues');
  const cm = cityMem(world, s.id);
  cm.pday = yearNow(world);
  cm.pfrac = Math.round(frac * 100) / 100;
}
on('plagueEnded', (world, plague) => plagueClosed(world, plague));

/** Yearly: plagues that ended without a hook, and stale plague tallies. */
export function plagueSweep(world) {
  const st = evState(world);
  const day = world.time.day;
  // the last few dozen plagues cover every one that can have ended since the last sweep
  for (let k = world.plagues.length - 1; k >= 0 && k >= world.plagues.length - 40; k--) {
    const p = world.plagues[k];
    if (p && !p.active && p.endDay != null && p.endDay >= day - 2 * DAYS_PER_YEAR) plagueClosed(world, p);
  }
  for (const k of Object.keys(st.pd)) {
    const pid = Number(k.slice(0, k.indexOf('|')));
    const p = world.plagues[pid];
    if (!p || !p.active) delete st.pd[k];
  }
}

export { HIST };
