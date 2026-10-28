// Disease (order 55): named plagues with per-settlement SIR dynamics.
//
// Plagues emerge in crowded, unhealthy towns, among herders living close to their beasts,
// at first contact between peoples, and as returns of old strains to peoples who have
// forgotten them (× params.plagueRate). Emergence is a world-level, saturating process, and
// for decades after a notable plague the world is quieter, so a millennium sees a handful of
// great pestilences rather than a constant drizzle. Most new sicknesses are mild; perhaps one
// in eight is a killer. Every 5 days each infected settlement advances an SIR step
// (s.disease = { pid, I, R } as fractions of its people); deaths scale with the strain's
// lethality × params.plagueLethality × civ medicine. Sickness travels to nearby towns, along
// trade routes, on caravans and ships (trade.js) and with armies (war.js) through expose().
// Survivors keep waning immunity in s.immunity[pid] (half of it guards against a returning
// strain). Strains attenuate after their natural duration so every plague ends; a safety
// valve keeps any single plague from killing more than about a third of the world.
// Emergence is scaled by the ext 'rates' key 'plagueEmergence'; a settlement's 'plagueDose'
// effects (quarantine, crowded fairs) scale what reaches it from outside.
//
// Names are composed (plagueName): a colour, participle, trade, season, the land, the town, the
// people or the god it is blamed on, joined to a word for the symptom ("the Fen Ague").
//
// Hooks emitted: plagueStarted(plague), plagueEnded(plague), plagueDeaths { pid, sid, deaths }
// (monthly per settlement, when at least one died). Chronicle keys 'plague.start',
// 'plague.spread', 'plague.end', 'divine.plague', 'divine.cure' (ref: the plague).
// Exports: system, expose(world, s, pid, via?), seedContactPlague(world, civA, civB),
//          createPlague(world, s|sid, cause|{ lethalityMul, name, cause, strength, quiet }, opts?),
//          cureTown(world, s), plagueAt(world, s), PLAGUE_TICK

import { chronicle } from '../../core/chronicle.js';
import { on } from '../../core/hooks.js';
import { registerTool } from '../../core/tools.js';
import { liveSettlements, settlementsNear, nearestSettlement, addIndexed } from '../../core/entities.js';
import { emitFx } from '../../core/world.js';
import { mulOf, hasProviders } from '../../core/ext.js';
import { settlementMods } from '../../core/effects.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH } from '../../core/constants.js';
import { clamp01, rgbToHex, dist } from '../../core/util.js';
import {
  modsOf, civById, civName, peopleOf, fmtCount, listJoin, spanPhrase, pickOne, rateOk,
  countWord, bare, finite, routeAdjacency, emitHook, nearestFeature,
} from './common.js';
import { composeName, possessive, nameWord, terrainAt, isEnglishWord } from '../../core/names.js';
import { plagueTarget, cureTargets, plaguePreview, curePreview, toolLabel } from './previews.js';
import { plagueWeights, plagueToll, noteExposed, originPeople, townInf } from './health.js';

export const PLAGUE_TICK = 5;          // days between SIR steps
const TICK_PHASE = 2;
const BETA0 = 0.36;                    // contact rate per tick at infectivity 1, crowd 1
const GAMMA = 0.3;                     // recovery/death per tick (≈ 16-day infectious period)
const DEADLY = 0.12;                  // base lethality from which a strain may be named for death
const MAX_ACTIVE = 4;
const NEAR_RADIUS = 6;

// ---------------------------------------------------------------------------
// Naming

// A plague's name is composed (plagueName): a colour, a participle, a body part, a season, a
// trade, the land, the town or the people it is blamed on, or the god who sent it, joined to one
// of the words for its symptom ("the Sallow Croup", "the Weaver's Sweat", "the Fen Ague", "the
// Oskel Pox", "Vashti's Kiss"). The colour drawn also tints the plague on the map.
const COLORS = [
  ['Grey', [150, 150, 158]], ['Red', [196, 64, 56]], ['Black', [104, 92, 108]], ['White', [210, 206, 196]],
  ['Yellow', [206, 182, 72]], ['Blue', [92, 128, 196]], ['Pale', [196, 190, 170]], ['Green', [112, 168, 88]],
  ['Crimson', [178, 44, 70]], ['Ashen', [136, 128, 120]], ['Scarlet', [214, 72, 64]], ['Purple', [150, 94, 170]],
  ['Brown', [134, 98, 64]], ['Golden', [212, 170, 64]], ['Sallow', [196, 180, 120]], ['Livid', [116, 104, 150]],
  ['Copper', [184, 112, 64]], ['Ruddy', [188, 92, 72]], ['Saffron', [226, 160, 40]], ['Violet', [138, 90, 180]],
  ['Russet', [160, 82, 52]], ['Leaden', [120, 124, 136]], ['Rose', [214, 120, 140]], ['Amber', [212, 148, 52]],
  ['Dun', [160, 140, 104]], ['Sable', [70, 62, 70]], ['Silver', [190, 196, 206]], ['Bruised', [112, 86, 140]],
];
// noun: the symptom's key (saved as plague.symptom); alt: the other words a name may use for it
const SYMPTOMS = [
  { noun: 'Cough', alt: ['Croup', 'Rattle', 'Hack'], desc: 'a racking cough', verb: 'cough blood' },
  { noun: 'Sweat', alt: ['Sweats'], desc: 'a sweating fever', verb: 'sweat and shiver through the night' },
  { noun: 'Pox', alt: ['Spots', 'Blains', 'Pocks'], desc: 'a disfiguring pox', verb: 'break out in weeping sores' },
  { noun: 'Fever', alt: ['Burning', 'Heat', 'Fevers'], desc: 'a burning fever', verb: 'burn with fever' },
  { noun: 'Flux', alt: ['Gripe', 'Scour', 'Purge'], desc: 'a bloody flux', verb: 'waste away with the flux' },
  { noun: 'Rot', alt: ['Canker', 'Gangrene'], desc: 'a creeping rot of the flesh', verb: 'rot where they lay', deadly: true },
  { noun: 'Wasting', alt: ['Consumption', 'Decline', 'Dwindling'], desc: 'a wasting sickness', verb: 'waste to skin and bone' },
  { noun: 'Shakes', alt: ['Palsy', 'Trembling', 'Jitters'], desc: 'a shaking palsy', verb: 'shake until they could not stand' },
  { noun: 'Death', alt: ['Doom', 'Dying', 'Mortality'], desc: 'a swift and terrible death', verb: 'die within a day of the first chill', deadly: true },
  { noun: 'Blight', alt: ['Blisters', 'Scald', 'Scab'], desc: 'a blistering blight', verb: 'blister and blacken' },
  { noun: 'Ague', alt: ['Chill', 'Chills', 'Rigors'], desc: 'a marsh ague', verb: 'tremble with ague' },
];
const PARTICIPLES = ['Weeping', 'Shaking', 'Sleeping', 'Burning', 'Creeping', 'Bleeding', 'Choking', 'Rattling', 'Falling', 'Laughing', 'Withering',
  'Sweating', 'Spotted', 'Dancing', 'Wandering', 'Yawning', 'Gasping', 'Staring', 'Swooning', 'Sneezing', 'Blistering', 'Coughing', 'Mumbling', 'Itching',
  'Raving', 'Shivering', 'Silent', 'Stinking'];
const BODY = ['Bone', 'Throat', 'Lung', 'Blood', 'Belly', 'Brain', 'Skin', 'Eye', 'Joint', 'Marrow', 'Chest', 'Gut', 'Liver', 'Tongue'];
const SEASON = ['Spring', 'Summer', 'Autumn', 'Winter', 'Harvest', 'Midsummer', 'Thaw', 'Hungry-Month', 'Lambing', 'Rain'];
const DAYS = ['Three-Day', 'Five-Day', 'Seven-Day', 'Nine-Day', 'Ten-Day', 'Twelve-Day', 'One-Night', 'Fortnight', 'Forty-Day'];
const TRADES = ["Weaver's", "Miller's", "Sailor's", "Tanner's", "Soldier's", "Beggar's", "Potter's", "Fuller's", "Dyer's", "Collier's", "Smith's",
  "Carter's", "Ferryman's", "Mason's", "Scribe's", "Baker's", "Cooper's", "Porter's", "Pilgrim's", "Washerwoman's", "Gravedigger's", "Chandler's"];
const NICK_ADJ = ['Grey', 'Quiet', 'Thin', 'Cold', 'Red', 'Pale', 'Black', 'Long', 'Hungry', 'Patient', 'Sweet', 'Silent', 'Yellow', 'Crooked', 'Smiling', 'Barefoot'];
const NICK = ['Visitor', 'Guest', 'Neighbour', 'Stranger', 'Sleep', 'Hand', 'Kiss', 'Wind', 'Breath', 'Shadow', 'Mist', 'Lady', 'Rider', 'Fog'];
const NICK_DEADLY = ['Reaper', 'Harvester', 'Ferryman', 'Gravedigger', 'Widow-Maker'];
const WRATH = ['Breath', 'Kiss', 'Hand', 'Wrath', 'Curse', 'Scourge', 'Lash', 'Tears', 'Arrows', 'Judgement', 'Sorrow', 'Rod', 'Frown', 'Whip'];
const LAND = {
  marsh: ['Marsh', 'Fen', 'Bog', 'Mire'], sands: ['Sand', 'Dust', 'Desert', 'Oasis'], shore: ['Harbour', 'Dockside', 'Tide', 'Quay'],
  hills: ['Hill', 'Mountain', 'Highland', 'Valley'], snows: ['Snow', 'Frost', 'Ice', 'Pine'], plains: ['Steppe', 'Grass', 'Prairie', 'Plains'],
  river: ['River', 'Ford', 'Reed', 'Bridge'], wood: ['Forest', 'Woodland', 'Timber', 'Charcoal'],
};
const BEASTS = ['Cattle', 'Swine', 'Goat', 'Sheep', 'Horse', 'Byre', 'Fowl', 'Hound', 'Ox', 'Camel', 'Mule', 'Herd', 'Pigsty', 'Stable'];
const HERDERS = ["Herdsman's", "Drover's", "Shepherd's", "Goatherd's", "Swineherd's", "Milkmaid's", "Byreman's", "Stable-Boy's", "Cowherd's", "Butcher's"];
const STRANGERS = ["Strangers'", 'Foreign', 'Far', 'Outland', "Travellers'", "Newcomers'", "Sailors'", 'Ship', 'Sea', "Merchants'", "Caravan", 'Overseas'];

const PLAGUE_FORMS = [
  [3, 'the {Color} {Sym}'], [0.5, '{Color} {Sym}'], [1.8, 'the {Part} {Sym}'], [2.2, 'the {town} {Sym}'], [1.1, 'the {Sym} of {town}'],
  [0.7, 'the {Season} {Sym}'], [0.7, 'the {Days} {Sym}'], [1, 'the {Body} {Sym}'], [0.9, 'the {NickAdj} {Nick}'], [0.9, 'the {Trade} {Sym}'],
  [1.2, 'the {Land} {Sym}'], [0.8, 'the {native} {Sym}'], [1, 'the {people} {Sym}'], [1, 'the {region} {Sym}'],
];
const CAUSE_FORMS = {
  livestock: [[3, 'the {Beast} {Sym}'], [2, 'the {Herder} {Sym}'], [1, 'the {Beast} Murrain'], [0.8, 'the {town} Murrain']],
  contact: [[2.5, 'the {civB} {Sym}'], [1.6, 'the {Stranger} {Sym}'], [1.2, 'the {Sym} from {far}']],
  divine: [[2.5, '{deityPos} {Wrath}'], [1.5, 'the {Wrath} of {deity}'], [1, 'the Heaven-Sent {Sym}'], [1, "the Gods' {Sym}"]],
};
const stems = (n) => n.toLowerCase().split(/[\s'-]+/).filter((w) => w.length > 3 && w !== 'the').map((w) => w.slice(0, 4));
const stemClash = (n) => { const a = stems(n); return a.some((x, k) => a.indexOf(x) !== k); };

// names that promise death ("the Red Death") are kept for strains that can deliver it
const MILD_SYMPTOMS = SYMPTOMS.filter((x) => !x.deadly);

/** The god a town's people would blame: the deity of its dominant faith, else its realm's state faith. */
function blamedGod(world, s) {
  const r = s && s.dominantReligion != null ? world.religions[s.dominantReligion] : null;
  if (r && r.alive !== false && r.deity) return r.deity;
  const c = s ? civById(world, s.civId) : null;
  const q = c && c.stateReligion != null ? world.religions[c.stateReligion] : null;
  return q && q.deity ? q.deity : null;
}

function plagueName(world, s, cause, civB, deadly = true) {
  const rng = world.rng;
  const st = state(world);
  const pool = deadly ? SYMPTOMS : MILD_SYMPTOMS;
  const civ = s ? civById(world, s.civId) : null;
  const land = s ? terrainAt(world, s.i) : null;
  const region = s ? nearestFeature(world, s.x, s.y, ['forest', 'range', 'lake', 'river', 'desert'], 8) : null;
  const deity = cause === 'divine' && s ? blamedGod(world, s) : null;
  const farTown = civB && civB.capitalId != null ? world.settlements[civB.capitalId] : null;
  const forms = CAUSE_FORMS[cause] ? PLAGUE_FORMS.concat(CAUSE_FORMS[cause].map(([w, f]) => [w * 2, f])) : PLAGUE_FORMS;
  const adjOk = (a) => (a && !isEnglishWord(a) ? a : null);
  for (let attempt = 0; attempt < 8; attempt++) {
    const sym = rng.pick(pool);
    const col = rng.pick(COLORS);
    const words = [sym.noun, sym.noun, ...sym.alt];
    const name = composeName(rng, forms, {
      Color: col[0], Sym: words, Part: PARTICIPLES, Season: SEASON, Days: DAYS, Body: BODY, Trade: TRADES, NickAdj: NICK_ADJ,
      Nick: deadly ? NICK.concat(NICK_DEADLY) : NICK, Land: land ? LAND[land] : null, town: s ? s.name : null,
      native: () => nameWord(civ ? civ.language : world.lang, rng, 1, 2), people: adjOk(civ && civ.adjective),
      region: region ? bare(region.name).replace(/^(Lake|Mount|Isle of)\s+/, '').replace(/\s+(River|Mountains|Hills|Range|Forest|Wood|Desert|Lake)$/, '') : null,
      Beast: BEASTS, Herder: HERDERS, civB: adjOk(civB && civB.adjective), Stranger: STRANGERS, far: farTown && farTown.alive ? farTown.name : civB ? civB.name : null,
      deity, deityPos: deity ? possessive(deity) : null, Wrath: WRATH,
    });
    if (!name || stemClash(name) || name.split(' ').length > 5) continue;
    if (!st.names[name]) { st.names[name] = 1; return { name, color: col[1], symptom: sym }; }
  }
  const sym = rng.pick(pool);
  const base = `the Great ${rng.pick(COLORS)[0]} ${sym.noun}`;
  st.names[base] = (st.names[base] || 0) + 1;
  return { name: st.names[base] > 1 ? `${base} of ${s ? s.name : 'the World'}` : base, color: [150, 150, 150], symptom: sym };
}

// ---------------------------------------------------------------------------
// State

/**
 * How ready the world is for a new pestilence (0..1): for decades after a notable plague the
 * survivors' hardiness and the thinned crowds keep new sicknesses from taking hold.
 */
function quiet(world, st) {
  return 1 - Math.exp(-(world.time.day - st.lastNotableDay) / (70 * DAYS_PER_YEAR));
}

function state(world) {
  const st = (world.sys.disease ||= {});
  st.names ||= {};
  st.pdm ||= {};          // 'pid|sid' → deaths this month (plagueDeaths; saved so a reload pays the same)
  if (st.lastNotableDay == null) st.lastNotableDay = -1e9;
  st.notable ||= 0;
  st.outbreaks ||= 0;
  st.deaths ||= 0;
  return st;
}

function worldPop(world) {
  let p = 0;
  for (const s of liveSettlements(world)) p += s.population || 0;
  return p;
}

/** The plague currently afflicting a settlement (or null). */
export function plagueAt(world, s) {
  if (!s || !s.disease) return null;
  const p = world.plagues[s.disease.pid];
  return p && p.active ? p : null;
}

// ---------------------------------------------------------------------------
// Creation and exposure

const KNOWN_CAUSES = new Set(['crowd', 'livestock', 'contact', 'divine', 'return']);

/**
 * Published: start a new plague in settlement s (or its id). Either createPlague(world, s, cause,
 * opts) with cause 'crowd' | 'livestock' | 'contact' | 'divine' | 'return', or the contract form
 * createPlague(world, sid, { lethalityMul, name, cause, strength, quiet, seq }) where cause may be
 * any word (an event's 'siege', 'famine', 'curse' …). opts: { civB, strength, quiet, strainOf,
 * lethalityMul, name, seq (the chronicle entry that caused it) }. Emits plagueStarted. Returns
 * the plague or null.
 */
export function createPlague(world, sIn, causeIn = 'crowd', optsIn = {}) {
  const s = typeof sIn === 'number' ? world.settlements[sIn] : sIn;
  let cause = causeIn, opts = optsIn || {};
  if (causeIn && typeof causeIn === 'object') { opts = causeIn; cause = typeof causeIn.cause === 'string' && causeIn.cause ? causeIn.cause : 'divine'; }
  if (!s || !s.alive) return null;
  const rng = world.rng;
  const st = state(world);
  const str = finite(opts.strength) ? Math.max(0.1, opts.strength) : 1;
  const parent = opts.strainOf != null ? world.plagues[opts.strainOf] : null;
  // most new sicknesses are mild; perhaps one in eight is a true killer
  let infectivity = 0.9 + Math.pow(rng.next(), 1.4) * 1.7;
  let lethality = 0.02 + Math.pow(rng.next(), 2.8) * 0.4;
  if (cause === 'contact') { infectivity = Math.min(2.9, infectivity + 0.2); lethality = Math.max(lethality, 0.1); }
  if (cause === 'livestock') lethality *= 0.8;
  if (cause === 'divine') { infectivity = Math.max(infectivity, 1.6) * Math.min(1.6, 0.6 + 0.4 * str); lethality = Math.min(0.6, Math.max(lethality, 0.15) * str); }
  // a returning strain meets bodies that half remember it
  if (parent) { infectivity = parent.infectivity * rng.float(0.8, 1.0); lethality = parent.lethality * rng.float(0.35, 0.75); }
  if (finite(opts.lethalityMul) && opts.lethalityMul > 0) lethality = Math.min(0.9, lethality * opts.lethalityMul);
  const deadly = lethality >= DEADLY;
  let nm;
  if (typeof opts.name === 'string' && opts.name) {
    const name = st.names[opts.name] ? `${opts.name} of ${s.name}` : opts.name;
    st.names[name] = (st.names[name] || 0) + 1;
    const col = rng.pick(COLORS);
    nm = { name, color: col[1], symptom: rng.pick(deadly ? SYMPTOMS : MILD_SYMPTOMS) };
  } else if (parent) {
    const name = /^the /i.test(parent.name) ? `the Return of the ${bare(parent.name)}` : `the Return of ${parent.name}`;
    st.names[name] = (st.names[name] || 0) + 1;
    nm = { name, color: parent.rgb || [150, 150, 150], symptom: SYMPTOMS.find((x) => x.noun === parent.symptom) || SYMPTOMS[0] };
  } else nm = plagueName(world, s, KNOWN_CAUSES.has(cause) ? cause : 'crowd', opts.civB, deadly);
  const p = {
    id: -1,
    name: nm.name,
    originSid: s.id,
    startDay: world.time.day, endDay: null, active: true,
    infectivity, lethality,
    duration: Math.round((2 + rng.next() * 8) * DAYS_PER_YEAR),
    deaths: 0,
    color: rgbToHex(nm.color),
    rgb: nm.color.slice(),
    symptom: nm.symptom.noun,
    cause,
    originCivId: s.civId,
    strainOf: parent ? parent.id : null,
    att: 1,
    towns: 0, infected: 0, peakInfected: 0,
    hit: 0, hitIds: [], civsHit: [s.civId],
    worst: null,
    notable: false,
    worldPopAtStart: Math.max(1, worldPop(world)),
    lastNote: world.time.day,
    op: originPeople(world, s, opts.civB || null),   // whose sickness it is (geo/health.js)
    byP: {},                                          // { people: [dead, exposed] }
  };
  addIndexed(world, 'plagues', p);
  st.outbreaks++;
  infect(world, s, p, cause === 'divine' ? 0.02 : 0.004);
  emitFx(world, { type: 'plague', x: s.x, y: s.y, color: p.color, ...(cause === 'divine' ? { src: 'tool' } : {}) });
  if (!opts.quiet) {
    const sym = nm.symptom;
    const civ = civById(world, s.civId);
    let text;
    if (parent) {
      text = pickOne(world, [
        `${capName(p.name)} returned to ${s.name} a generation after it was thought gone, finding a people who no longer remembered its touch.`,
        `In ${s.name} the old dread came back: ${p.name} had returned.`,
      ]);
    } else if (cause === 'livestock') {
      text = pickOne(world, [
        `${capName(p.name)} appeared among the herders of ${s.name}, passing from their beasts to their children.`,
        `A sickness of the byres leapt from the herds of ${s.name} to their keepers; men called it ${p.name}.`,
      ]);
    } else if (cause === 'contact') {
      const ob = opts.civB;
      text = pickOne(world, [
        `Strangers from ${ob ? civName(ob) : 'distant lands'} brought ${p.name} to ${s.name}, a sickness its people had never known.`,
        `The first meeting with ${ob ? peopleOf(ob) : 'strangers'} carried ${sym.desc} into ${s.name}; it became known as ${p.name}.`,
      ]);
    } else if (cause === 'divine') {
      text = pickOne(world, [
        `By the wrath of heaven ${p.name} fell upon ${s.name}.`,
        `A curse descended on ${s.name}: within days its people began to ${sym.verb}, and ${p.name} was named.`,
        `Out of a clear sky a sickness came to ${s.name}; the priests called it ${p.name} and spoke of a god's anger.`,
      ]);
    } else if (!KNOWN_CAUSES.has(cause)) {
      text = pickOne(world, [
        `${capName(p.name)} broke out in ${s.name}${cause ? ` in the wake of ${/^(a|an|the) /i.test(cause) ? cause : 'the ' + cause}` : ''}; its people began to ${sym.verb}.`,
        `In ${s.name} the sick began to ${sym.verb}; men named the new sickness ${p.name}.`,
      ]);
    } else {
      // "the sick began to die…" only where a killer has enough victims to take hold
      const vivid = !sym.deadly || (deadly && s.population >= 750);
      text = pickOne(world, [
        `${capFirstWord(sym.desc)} broke out in the crowded lanes of ${s.name}; the healers named it ${p.name}.`,
        vivid ? `In ${s.name} the sick began to ${sym.verb}, and fear of ${p.name} spread faster than the sickness itself.` : `In ${s.name} the healers whispered of ${p.name}, and fear spread faster than the sickness itself.`,
        `${capName(p.name)} first appeared in the teeming quarters of ${s.name}${civ ? `, in the lands of ${peopleOf(civ)}` : ''}.`,
      ]);
    }
    const e = chronicle(world, {
      cat: cause === 'divine' ? 'divine' : 'disease', imp: cause === 'divine' ? 3 : 2, text, x: s.x, y: s.y, civId: s.civId, sid: s.id, icon: 'plague',
      key: cause === 'divine' ? 'divine.plague' : 'plague.start', ref: { k: 'plague', id: p.id }, ...(Number.isFinite(opts.seq) ? { cause: opts.seq } : {}), tags: [String(cause)],
    });
    p.seq = e.seq;
  }
  emitHook(world, 'plagueStarted', p);
  return p;
}

const capName = (n) => n[0].toUpperCase() + n.slice(1);
const capFirstWord = (s) => s[0].toUpperCase() + s.slice(1);

/** Immunity of a town to plague p: its own survivors, or half-remembered from the strain it descends from. */
function immunityTo(s, p) {
  const im = s.immunity;
  if (!im) return 0;
  let v = im[p.id] || 0;
  if (p.strainOf != null) v = Math.max(v, 0.5 * (im[p.strainOf] || 0));
  return clamp01(v);
}

function infect(world, s, p, dose) {
  const immune = immunityTo(s, p);
  s.disease = { pid: p.id, I: Math.min(0.5, Math.max(1e-4, dose)), R: Math.min(0.95, immune) };
  noteExposed(world, s, p);
  p.hitIds ||= [];
  if (!p.hitIds.includes(s.id)) { p.hitIds.push(s.id); p.hit = p.hitIds.length; }
  if (s.civId != null && !p.civsHit.includes(s.civId)) p.civsHit.push(s.civId);
}

/**
 * Expose settlement s to plague pid. via: { kind: 'near'|'route'|'caravan'|'ship'|'army', fromSid, routeId, civId }.
 * Returns true if a new local outbreak began.
 */
export function expose(world, s, pid, via = null) {
  if (!s || !s.alive || s.population < 1) return false;
  const p = world.plagues[pid];
  if (!p || !p.active) return false;
  if (s.disease) {
    if (s.disease.pid === pid) s.disease.I = Math.min(0.5, s.disease.I + 0.0005);
    return false;
  }
  // a quarantined town keeps most of it out; a crowded fair lets more in (settlement effects)
  const dose = settlementMods(world, s).plagueDose;
  const immune = dose === 1 ? immunityTo(s, p) : 1 - (1 - immunityTo(s, p)) * Math.min(1, dose);
  if (immune > 0.85 || world.rng.chance(immune)) return false;
  const newCiv = s.civId != null && !p.civsHit.includes(s.civId);
  infect(world, s, p, (0.002 + world.rng.next() * 0.003) * Math.max(0.25, dose));
  if (newCiv || (p.notable && rateOk(world, `plg${p.id}`, 2 * DAYS_PER_YEAR))) spreadNote(world, s, p, via, newCiv);
  return true;
}

function spreadNote(world, s, p, via, newCiv) {
  const from = via && via.fromSid != null ? world.settlements[via.fromSid] : null;
  const route = via && via.routeId != null ? world.tradeRoutes[via.routeId] : null;
  const civ = civById(world, s.civId);
  let how = '';
  if (via) {
    if (via.kind === 'caravan') how = route && route.name ? `by caravans along ${route.name}` : 'by merchant caravans';
    else if (via.kind === 'ship') how = route && route.name ? `aboard ships plying ${route.name}` : 'aboard merchant ships';
    else if (via.kind === 'route') how = route && route.name ? `along ${route.name}` : 'along the trade roads';
    else if (via.kind === 'army') { const ac = civById(world, via.civId); how = ac ? `with the soldiers of ${civName(ac)}` : 'with marching soldiers'; }
    else how = 'by travellers and refugees';
  }
  const crossing = newCiv && civ && from && from.civId !== s.civId;
  // only the plague's first reach into a new people, or a notable plague, is worth a line
  if (!crossing && !p.notable) return;
  if (!rateOk(world, `plgn${p.id}`, DAYS_PER_YEAR)) return;
  const text = crossing
    ? pickOne(world, [
      `${capName(p.name)} crossed into the lands of ${peopleOf(civ)}, reaching ${s.name}${how ? ' ' + how : ''}.`,
      `${capName(p.name)} spread from ${from.name} to ${s.name}${how ? ', carried ' + how : ''}.`,
    ])
    : pickOne(world, [
      `${capName(p.name)} reached ${s.name}${how ? ', carried ' + how : ''}.`,
      `${capName(p.name)} spread on to ${s.name}${from ? ` from ${from.name}` : ''}.`,
    ]);
  chronicle(world, { cat: 'disease', imp: p.notable ? 3 : 2, text, x: s.x, y: s.y, civId: s.civId, sid: s.id, icon: 'plague', key: 'plague.spread', ref: { k: 'plague', id: p.id }, ...(p.seq != null ? { cause: p.seq } : {}) });
  emitFx(world, { type: 'plague', x: s.x, y: s.y, color: p.color });
}

/** Virgin-soil epidemic at the first meeting of two peoples (diplomacy calls this). */
export function seedContactPlague(world, civA, civB) {
  if (!civA || !civB || !civA.alive || !civB.alive) return null;
  if (!(world.params.plagueRate > 0)) return null;
  const st = state(world);
  if (st.lastContactPlagueDay != null && world.time.day - st.lastContactPlagueDay < 25 * DAYS_PER_YEAR) return null;
  if (!world.rng.chance(Math.max(0.25, quiet(world, st)))) return null;
  if (world.plagues.reduce((n, p) => n + (p.active ? 1 : 0), 0) >= MAX_ACTIVE) return null;
  // the sick town is the one of A nearest to B's capital (or B's centre)
  const capB = civB.capitalId != null ? world.settlements[civB.capitalId] : null;
  const bx = capB ? capB.x : civB.originX, by = capB ? capB.y : civB.originY;
  const s = nearestSettlement(world, bx, by, { civId: civA.id });
  if (!s || s.disease || s.population < 60) return null;
  const p = createPlague(world, s, 'contact', { civB });
  // the strangers carry it home too
  const t = nearestSettlement(world, s.x, s.y, { civId: civB.id });
  if (p && t && !t.disease) expose(world, t, p.id, { kind: 'near', fromSid: s.id });
  st.lastContactPlagueDay = world.time.day;
  return p;
}

// ---------------------------------------------------------------------------
// SIR step

function crowdFactor(pop) {
  const v = 0.45 + 0.2 * Math.log10(Math.max(10, pop) / 100);
  return v < 0.3 ? 0.3 : v > 1.5 ? 1.5 : v;
}

function cfrFor(world, s, p, civ) {
  const m = modsOf(world, civ);
  let cfr = p.lethality * (world.params.plagueLethality ?? 1) * m.medicine * (1 - m.plagueResist);
  cfr *= 1.25 - 0.5 * clamp01(finite(s.health) ? s.health : 0.7);
  if (s.famine > 0) cfr *= 1.3;
  if (healingFaith(world, s)) cfr *= 0.8;
  cfr *= p.lethalAtt ?? 1;
  return cfr < 0 ? 0 : cfr > 0.9 ? 0.9 : cfr;
}

function healingFaith(world, s) {
  const rid = s.dominantReligion;
  if (rid == null) return false;
  const r = world.religions[rid];
  return Boolean(r && r.alive !== false && Array.isArray(r.tenets) && r.tenets.includes('healing'));
}
function apocalypticFaith(world, s) {
  const rid = s.dominantReligion;
  if (rid == null) return false;
  const r = world.religions[rid];
  return Boolean(r && r.alive !== false && Array.isArray(r.tenets) && r.tenets.includes('apocalyptic'));
}

function sirTick(world, st) {
  const towns = liveSettlements(world).slice(); // a plague toll may destroy entries
  for (const p of world.plagues) if (p.active) { p.towns = 0; p.infected = 0; }
  const spreaders = [];
  for (const s of towns) {
    const d = s.disease;
    if (!d) continue;
    const p = world.plagues[d.pid];
    if (!p || !p.active || !s.alive) { s.disease = null; continue; }
    const N = s.population;
    if (!(N >= 1)) { s.disease = null; continue; }
    const civ = civById(world, s.civId);
    const m = modsOf(world, civ);
    let I = finite(d.I) ? d.I : 0, R = finite(d.R) ? d.R : 0;
    const S = Math.max(0, 1 - I - R);
    const healthF = 1.35 - 0.7 * clamp01(finite(s.health) ? s.health : 0.7);
    // its peoples: their frailty, customs, and whether they have met this sickness (health.js)
    const W = plagueWeights(world, s, p);
    const beta = p.infectivity * BETA0 * crowdFactor(N) * healthF / Math.max(0.3, m.sanitation) * p.att * (s.siege ? 1.3 : 1) * W.inf * townInf(s);
    const newInf = Math.min(S, beta * S * I);
    const leaving = GAMMA * I;
    const cfr = Math.min(0.9, cfrFor(world, s, p, civ) * W.die);
    const deadFrac = leaving * cfr;
    I = I + newInf - leaving;
    R = R + leaving * (1 - cfr);
    // renormalise to the surviving population
    const surv = Math.max(1e-6, 1 - deadFrac);
    I /= surv; R /= surv;
    if (I < 0) I = 0;
    if (R > 1 - I) R = 1 - I;
    const deaths = N * deadFrac;
    if (deaths > 0) {
      p.deaths += deaths;
      st.deaths += deaths;
      const dk = p.id + '|' + s.id;
      st.pdm[dk] = (st.pdm[dk] || 0) + deaths;
      const frac = deaths / N;
      s.flags ||= {};
      const tf = (s.flags.plagueLoss || 0) + frac;
      s.flags.plagueLoss = tf;
      if (!p.worst || tf > p.worst.frac) p.worst = { sid: s.id, name: s.name, frac: tf };
      plagueToll(world, s, p, frac);
    }
    if (!s.alive) continue;
    // panic and misery
    const fear = I * (apocalypticFaith(world, s) ? 1.6 : 1);
    s.unrest = clamp01((s.unrest || 0) + fear * 0.35);
    s.happiness = clamp01((s.happiness ?? 0.6) - fear * 0.25);
    if (I * s.population < 0.4 || I < 2e-5) {
      // the local outbreak has burned out
      s.immunity ||= {};
      s.immunity[p.id] = Math.max(s.immunity[p.id] || 0, clamp01(R));
      s.disease = null;
      if (s.flags) s.flags.plagueLoss = 0;
      continue;
    }
    d.I = I; d.R = R;
    p.towns++;
    p.infected += I * s.population;
    if (I * s.population > 2) spreaders.push(s);
  }
  for (const p of world.plagues) if (p.active && p.infected > p.peakInfected) p.peakInfected = p.infected;
  spreadFrom(world, spreaders);
}

function spreadFrom(world, spreaders) {
  if (!spreaders.length) return;
  const rng = world.rng;
  const adj = routeAdjacency(world);
  for (const s of spreaders) {
    if (!s.alive || !s.disease) continue;
    const p = world.plagues[s.disease.pid];
    if (!p || !p.active) continue;
    const Ic = s.disease.I * s.population;
    const k = p.infectivity * p.att;
    // nearby towns: travellers, refugees, markets
    for (const n of settlementsNear(world, s.x, s.y, NEAR_RADIUS)) {
      if (n === s || n.disease) continue;
      const d = dist(s.x, s.y, n.x, n.y);
      const foreign = n.civId !== s.civId ? 0.6 : 1;
      const lam = Ic * k * 0.0009 * foreign / (1 + d);
      if (rng.chance(1 - Math.exp(-lam))) expose(world, n, p.id, { kind: 'near', fromSid: s.id });
    }
    // trade partners
    const routes = adj.get(s.id);
    if (routes) for (const r of routes) {
      const otherId = r.aId === s.id ? r.bId : r.aId;
      const n = world.settlements[otherId];
      if (!n || !n.alive || n.disease) continue;
      const lam = Ic * k * 0.0005 * Math.min(2, 0.5 + (r.value || 0) / 30);
      if (rng.chance(1 - Math.exp(-lam))) expose(world, n, p.id, { kind: 'route', fromSid: s.id, routeId: r.id });
    }
  }
}

// ---------------------------------------------------------------------------
// Monthly: emergence, attenuation, endings

/** Monthly: each town's toll from each plague (plagueDeaths), then the tally starts afresh. */
function deathTolls(world, st) {
  const keys = Object.keys(st.pdm);
  if (!keys.length) return;
  for (const k of keys) {
    const n = Math.round(st.pdm[k]);
    const bar = k.indexOf('|');
    if (n >= 1) emitHook(world, 'plagueDeaths', { pid: +k.slice(0, bar), sid: +k.slice(bar + 1), deaths: n });
  }
  st.pdm = {};
}

function monthly(world, st) {
  const day = world.time.day;
  deathTolls(world, st);
  const rate = (world.params.plagueRate ?? 1) * (hasProviders('rates') ? mulOf('rates', world, 'plagueEmergence') : 1);
  const towns = liveSettlements(world);
  const active = world.plagues.filter((p) => p.active);
  let wp = 0;
  for (const s of towns) wp += s.population || 0;

  // attenuation, safety valve, endings
  for (const p of active) {
    const age = day - p.startDay;
    if (age > p.duration) p.att *= 0.85;
    if (p.deaths > 0.3 * p.worldPopAtStart) p.lethalAtt = (p.lethalAtt ?? 1) * 0.8;
    // notable: a plague that spread through many towns with real loss, or a great killer
    // (integration: crowded late worlds made the old 0.4 % bar too low; a notable plague now kills 0.5 % of the
    // world across ten towns, or 1.2 % anywhere)
    if (!p.notable && ((p.hit >= 10 && p.deaths >= 0.005 * p.worldPopAtStart) || p.deaths >= Math.max(500, 0.012 * p.worldPopAtStart))) {
      p.notable = true;
      st.notable++;
      st.lastNotableDay = day;
    }
    if (p.towns === 0 || age > p.duration * 3 + DAYS_PER_YEAR) endPlague(world, p, wp);
  }

  if (!(rate > 0) || active.length >= MAX_ACTIVE) return;
  // Emergence is a world-level process: the more crowded, unhealthy towns (and herding
  // villages) there are, the likelier an outbreak — saturating, so a world of great cities
  // does not drown in plagues. Decades after a notable plague the world is quieter.
  const cool = quiet(world, st);
  const busy = active.length ? 0.35 : 1;
  const crowd = [], herd = [];
  let S = 0, L = 0;
  for (const s of towns) {
    if (s.disease || !(s.population > 0)) continue;
    const tier = s.tier || 0;
    if (tier < 1) continue;
    const m = modsOf(world, civById(world, s.civId));
    if (tier >= 2) {
      const health = clamp01(finite(s.health) ? s.health : 0.7);
      let w = Math.min(3, Math.max(0.2, Math.sqrt(s.population / 5000))) * (1.4 - health) / Math.sqrt(Math.max(0.3, m.sanitation));
      if (s.famine > 0) w *= 1.6;
      if (s.siege) w *= 2;
      if (w > 0) { crowd.push(s, w); S += w; }
    }
    const herb = world.f.herb[s.i] || 0;
    const wz = herb * (m.farming > 0 ? 1.5 : 0.5) * Math.min(2, Math.max(0.3, Math.sqrt(s.population / 2000)));
    if (wz > 0) { herd.push(s, wz); L += wz; }
  }
  const rng = world.rng;
  const pick = (list, total) => {
    let x = rng.next() * total;
    for (let k = 0; k < list.length; k += 2) { if (x < list[k + 1]) return list[k]; x -= list[k + 1]; }
    return list[list.length - 2];
  };
  if (S > 0 && rng.chance(0.0009 * rate * (1 - Math.exp(-S / 8)) * cool * busy)) { createPlague(world, pick(crowd, S), 'crowd'); return; }
  if (L > 0 && rng.chance(0.0003 * rate * (1 - Math.exp(-L / 10)) * cool * busy)) createPlague(world, pick(herd, L), 'livestock');
}

function endPlague(world, p, wp) {
  p.active = false;
  p.endDay = world.time.day;
  p.hitIds = [];            // the count (p.hit) is the record; the list only served the outbreak
  for (const s of liveSettlements(world)) {
    if (s.disease && s.disease.pid === p.id) {
      s.immunity ||= {};
      s.immunity[p.id] = Math.max(s.immunity[p.id] || 0, clamp01(s.disease.R));
      s.disease = null;
    }
  }
  const origin = world.settlements[p.originSid];
  const deaths = Math.round(p.deaths);
  const civs = p.civsHit.map((id) => civById(world, id)).filter(Boolean);
  const peoples = civs.length > 3 ? `${countWord(civs.length)} nations` : listJoin(civs.map((c) => peopleOf(c)));
  const span = spanPhrase(p.endDay - p.startDay);
  const worstFrac = p.worst ? p.worst.frac : 0;
  let imp = 1, text;
  const share = deaths / Math.max(1, p.worldPopAtStart);
  if (p.notable || deaths >= 2000) {
    imp = share >= 0.1 ? 5 : share > 0.05 || deaths > 250000 ? 4 : 3;
    const worstClause = p.worst && worstFrac >= 0.15
      ? `; in ${p.worst.name} ${worstFrac >= 0.5 ? 'more than half' : worstFrac >= 0.33 ? 'a third' : worstFrac >= 0.25 ? 'a quarter' : 'one in six'} of the people were gone`
      : '';
    text = pickOne(world, [
      `When ${p.name} finally burned out after ${span}, it had claimed some ${fmtCount(deaths)} lives among ${peoples || 'the peoples of the world'}${worstClause}.`,
      `${capName(p.name)} passed at last, leaving ${fmtCount(deaths)} dead in ${countWord(p.hit)} towns${worstClause}.`,
      `After ${span} ${p.name} faded away; ${fmtCount(deaths)} had perished${worstClause}.`,
    ]);
    if (imp === 5) text += ` No pestilence before it had killed so many: ${share >= 0.25 ? 'a quarter' : share >= 0.2 ? 'one in five' : share >= 0.14 ? 'one in seven' : 'one in ten'} of all the living.`;
  } else if (deaths >= 20) {
    text = pickOne(world, [
      `${capName(p.name)} burned itself out in ${origin ? origin.name : 'the stricken towns'} after claiming ${fmtCount(deaths)} lives.`,
      `The last cases of ${p.name} recovered${origin ? ` in ${origin.name}` : ''}; it had taken ${fmtCount(deaths)} lives.`,
    ]);
  } else {
    text = `${capName(p.name)} faded in ${origin ? origin.name : 'its birthplace'} before it could take hold.`;
  }
  chronicle(world, { cat: 'disease', imp, text, x: origin ? origin.x : null, y: origin ? origin.y : null, civId: p.originCivId, sid: p.originSid, icon: 'plague', key: 'plague.end', ref: { k: 'plague', id: p.id }, ...(p.seq != null ? { cause: p.seq } : {}) });
  emitHook(world, 'plagueEnded', p);
}

// Yearly: waning immunity; old strains may return to peoples who have forgotten them.
function yearly(world, st) {
  for (const s of liveSettlements(world)) {
    const im = s.immunity;
    if (!im) continue;
    for (const k of Object.keys(im)) {
      im[k] *= 0.93;
      if (!(im[k] >= 0.02)) delete im[k];
    }
  }
  const rate = world.params.plagueRate ?? 1;
  if (!(rate > 0)) return;
  const activeN = world.plagues.reduce((n, p) => n + (p.active ? 1 : 0), 0);
  if (activeN >= MAX_ACTIVE - 1) return;
  for (const p of world.plagues) {
    if (p.active || !p.notable || p.strainOf != null || p.returned) continue;
    if (world.time.day - p.endDay < 40 * DAYS_PER_YEAR) continue;
    if (!world.rng.chance(0.0015 * rate * quiet(world, st))) continue;   // (integration: 0.0025 → 0.0015, fewer returns)
    const towns = liveSettlements(world).filter((s) => s.tier >= 3 && !s.disease && !(s.immunity && s.immunity[p.id] > 0.2));
    if (!towns.length) continue;
    const s = world.rng.pick(towns);
    if (createPlague(world, s, 'return', { strainOf: p.id })) p.returned = true;
    return;
  }
}

// ---------------------------------------------------------------------------
// System

export const system = {
  id: 'disease',
  order: 55,
  init(world) {
    state(world);
    for (const s of world.settlements) {
      if (!s || !s.alive) continue;
      if (s.disease) {
        const p = world.plagues[s.disease.pid];
        if (!p || !p.active || !finite(s.disease.I) || !finite(s.disease.R)) s.disease = null;
      }
      if (!s.immunity || typeof s.immunity !== 'object') s.immunity = {};
    }
  },
  update(world) {
    const st = state(world);
    const day = world.time.day;
    if (day % PLAGUE_TICK === TICK_PHASE) sirTick(world, st);
    if (day % DAYS_PER_MONTH === 12) monthly(world, st);
    if (day % DAYS_PER_YEAR === 47) yearly(world, st);
  },
};

// Destroyed settlements release their sickness; conquered ones keep it.
on('settlementDestroyed', (world, s) => { if (s) s.disease = null; });

// ---------------------------------------------------------------------------
// Healing

/**
 * Published: lift the plague from settlement s (or its id), leaving its survivors immune for a
 * while and its people calmer. Returns the plague that was lifted, or null when s was well.
 */
export function cureTown(world, s) {
  if (typeof s === 'number') s = world.settlements[s];
  if (!s || !s.alive || !s.disease) return null;
  const p = world.plagues[s.disease.pid] || null;
  if (p) { s.immunity ||= {}; s.immunity[p.id] = Math.max(s.immunity[p.id] || 0, 0.6); }
  s.disease = null;
  if (s.flags) s.flags.plagueLoss = 0;
  s.unrest = clamp01((s.unrest || 0) - 0.1);
  return p;
}

// ---------------------------------------------------------------------------
// Tools (targets shared with their previews in previews.js)

registerTool({
  id: 'plague', label: 'Plague', group: 'catastrophe', icon: 'plague', order: 70, polarity: 'bane',
  desc: 'Loose a new plague upon the nearest town. Virulence sets how deadly it is.',
  target: 'settlement', radius: 0,
  strength: { label: 'Virulence', min: 0.2, max: 2, default: 1 },
  danger: (opts) => (opts?.strength ?? 1) > 1.6,
  preview: plaguePreview,
  apply(world, x, y, { strength }) {
    const s = plagueTarget(world, x, y);
    if (!s) return { ok: false, message: 'No town lies close enough to sicken.' };
    if (s.disease) {
      const p = plagueAt(world, s);
      if (p) {
        s.disease.I = Math.min(0.5, s.disease.I * 3 + 0.01); p.att = Math.max(p.att, 1);
        emitFx(world, { type: 'curse', x: s.x, y: s.y, r: 3, color: p.color, src: 'tool' });
        toolLabel(world, s.x, s.y, capName(p.name), 'bane');
        return { ok: true, message: `${capName(p.name)} rages anew in ${s.name}.` };
      }
    }
    const p = createPlague(world, s, 'divine', { strength });
    if (!p) return { ok: false, message: 'The sickness found no purchase.' };
    emitFx(world, { type: 'curse', x: s.x, y: s.y, r: 3, color: p.color, src: 'tool' });
    toolLabel(world, s.x, s.y, capName(p.name), 'bane');
    return { ok: true, message: `${capName(p.name)} descends upon ${s.name}.` };
  },
});

registerTool({
  id: 'cure', label: 'Cure', group: 'fate', icon: 'cure', order: 60, polarity: 'boon',
  desc: 'Lift every plague from the towns within the brush, leaving their people immune.',
  target: 'area', radius: 8, minRadius: 2, maxRadius: 40,
  preview: curePreview,
  apply(world, x, y, { radius }) {
    const { towns, r } = cureTargets(world, x, y, radius);
    const names = new Map();
    for (const s of towns) { const p = cureTown(world, s); if (p && !names.has(p.name)) names.set(p.name, p.id); }
    const n = towns.length;
    emitFx(world, { type: 'bless', x, y, r, src: 'tool' });
    if (!n) return { ok: true, message: 'No sickness stirs here.' };
    toolLabel(world, x, y, `${n} town${n === 1 ? '' : 's'} healed`, 'boon');
    if (rateOk(world, `cure${Math.round(x / 8)}:${Math.round(y / 8)}`, DAYS_PER_YEAR)) {
      const s0 = nearestSettlement(world, x, y, { maxDist: r + 2 });
      const list = [...names.keys()];
      const pid = list.length ? names.get(list[0]) : null;
      chronicle(world, {
        cat: 'divine', imp: 2, x, y, civId: s0 ? s0.civId : null, sid: s0 ? s0.id : null, icon: 'cure', key: 'divine.cure', ...(pid != null ? { ref: { k: 'plague', id: pid } } : {}),
        text: pickOne(world, [
          `A miraculous healing swept ${s0 ? 'the country around ' + s0.name : 'the land'}, and ${listJoin(list.slice(0, 2))} lifted from ${countWord(n)} town${n === 1 ? '' : 's'}.`,
          `The fevers broke in a single night ${s0 ? 'around ' + s0.name : 'across the land'}; ${listJoin(list.slice(0, 2))} ${list.length > 1 ? 'were' : 'was'} gone from ${countWord(n)} town${n === 1 ? '' : 's'}.`,
        ]),
      });
    }
    return { ok: true, message: `Healed ${n} town${n === 1 ? '' : 's'}.` };
  },
});
