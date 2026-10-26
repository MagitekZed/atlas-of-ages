// War (order 80): declarations, alliances called to arms, armies, battles, sieges, peace.
//
// Monthly, each realm first feels its appetite for war — temperament × params.aggression,
// ruler, faith (militant, pacifist), unrest at home, weariness, the number of its marches,
// and the reluctance of a people that only lately made peace or is already defending itself.
// A realm with appetite then weighs every contacted neighbour not under truce: hostility (low
// opinion), the balance of power (counting the target's allies and overlord), reach, the
// ext 'warAppetite' of the pair, and the strongest casus belli — border disputes, holy war
// against another faith, dynastic or secession claims, reconquest of the towns it claims
// (claims.js: lost in war, at a treaty or to a rising, fading over generations), coveted
// resources, trade quarrels, opportunism against a neighbour already at war, revenge, a
// vassal's bid for independence, or the claims other packages raise (ext 'casusBelli': dynastic
// claims, restorations, ancient enmities, prophecies …) — and attacks the most tempting one if
// the temptation passes a second roll. Wars get composed names (WAR_FORMS per casus belli: "The
// Oskel Salt War", "The Holy War of Ashen", "The War of Arven's Beard", "The Second Varathi–Oskel
// War"); defensive allies (and realms the ext 'allied'
// binds, such as personal unions) and vassals are summoned (refusing without excuse is
// betrayal).
//
// Armies are raised monthly from settlement manpower (treasury and population pay), led by
// commanders — plain { name, skill, born } leaders on army.general, promoted to great figures
// (flags.genId, enrolled in civ.flags.figs so the civ module ages them) only after a great
// victory or a third win. They muster for weeks and march daily along findPath routes
// (amphibious when navigation allows, `army.naval` while at sea) toward weak, wealthy or coveted
// enemy towns, or to intercept invaders and relieve sieges — first of all where a vision sent
// them (flags.divineGoal, the command_army act). Supply, forage, winter and camp fever wear
// them down; every loss goes through the kernel's damageArmy with its cause. Hostile armies
// within 1.5 tiles fight battles (terrain, morale, generals, the ext 'battle' multipliers,
// chance; an army needs a few days' rest between battles); losers retreat or are routed, and
// the great battles are named and chronicled. One army leads each siege, reinforced by every
// other besieger (each × the ext 'siege' multiplier); months against a stockade, a year or more
// against a walled capital (town defences × the settlement's 'defense' effects), until the town
// is stormed: sacked and transferred, or razed by cruel or zealous victors. Every battle and
// capture moves the war score; casualties and occupation build war weariness.
//
// Wars end when a beaten realm sues for terms before its last strongholds fall (unless a
// cruel, zealous or vengeful victor spurns it), when occupation is decisive, when the loser or
// both sides are exhausted, when the attacker holds its goal, in stalemate, or after a
// generation — in white peace, ceded towns, tribute or vassalage, with truces. Conquering a
// whole realm is therefore rare and notable. Civil wars started by the civ module are fought
// by the same machinery: storming the rebels' seat crushes the rising (the civ module then
// restores the realm), a crown brought to its knees grants independence.
//
// Every war keeps its full story in war.ledger (geo/ledger.js): battles, towns that changed
// hands, the armies that fought it; war.geo keeps terms, endReason and goalSid after the peace.
// Armies hunting beasts (flags.hunt) belong to the bands module and are never planned, moved,
// disbanded or fought here; hired companies (flags.merc) serve as ordinary soldiers.
//
// Hooks emitted: battle, siegeStarted, siegeEnded, armyDisbanded (and figureBorn / figureDied
// for generals the war raises to fame or kills).
// Exports: system, warScoreFor, sideOf, clearSiege(world, s, reason), startWarNamed(world,
//          attackers, defenders, cb, name, opts?), inciteWar, brokerPeace, commandArmy,
//          commandPreview, leaderName

import { chronicle } from '../../core/chronicle.js';
import { on, emit } from '../../core/hooks.js';
import {
  liveCivs, liveSettlements, settlementsNear, startWar, endWar, areAtWar, rel, addOpinion,
  createArmy, removeArmy, transferSettlement, destroySettlement, damageSettlement, damageArmy, addFigure, nearestSettlement,
} from '../../core/entities.js';
import { emitFx, bumpVersion, latitude, monthOf } from '../../core/world.js';
import { touchRecord } from '../../core/keyframe.js';
import { sliceLike, takePeople, roundSlice, returnLevy } from '../../core/cohorts.js';
import { mulOf, anyOf, concatOf, hasProviders } from '../../core/ext.js';
import { settlementMods } from '../../core/effects.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH, WATER, BIOME, RESOURCES, MONTH_SEASON } from '../../core/constants.js';
import { clamp01, clamp, dist, SQRT2 } from '../../core/util.js';
import { makePerson, makeEpithet, composeName, possessive } from '../../core/names.js';
import { findPath, costGrid } from './pathfinding.js';
import { civPower, addTribute, setVassal, releaseVassal, betrayal } from './diplomacy.js';
import { faithOf, boostFervor, imposeFaith } from './religion.js';
import { expose } from './disease.js';
import { ledgerOf, noteBattle, noteTransfer, serviceOf, notePeak, noteLoss, noteFight, archiveArmy } from './ledger.js';
import {
  modsOf, civName, civAdj, peopleOf, rulerName, rulerHas, hasTreaty, pickOne, rateOk, rateReady,
  eraOf, finite, capFirst, capitalOf, townsOf, civPopulation, fmtCount, listJoin, spanPhrase, countWord,
  ordinalWord, bare, landscapeAt, nearestFeature, hashPick, seasonWord, activeWarList, enemySet, civsAtWar, worldPopulation,
  emitHook, peekMods,
} from './common.js';
import { bestClaimOn, renounceClaims, hardenClaims, claimOf } from './claims.js';
import { remember, memoryOf } from './memory.js';
import { aimFor, defenderAim, aimsFromCause, aimMet, winnerAim, peaceAllows, takeHostage, hostageHeld, killHostage } from './terms.js';
import { addReparations, monthlyIncome, debtClaim, settleDebtClaim } from './debt.js';
import { bindWar } from './acts.js';   // the geopolitical divine acts (they call back into this module at use time)

const MONTH_DAY = 25;
const BATTLE_R2 = 1.5 * 1.5;
const BATTLE_REST = 6;                // days an army needs after a battle before it can fight another
const MAX_PLANS_PER_DAY = 4;
const BASE_SPEED = 1.15;              // cost units per day on foot
// Monthly chance that an average-tempered realm at rest looks for a war at all; whether it
// declares then depends on how tempting its best target is (hostility × power × casus belli).
const APPETITE = 0.115;
const REST_YEARS = 8;                 // e-folding of the post-war reluctance to fight again
const MAX_ARMIES = 6;
const GOAL_DAYS = 180;                // how long a vision drives an army (command_army)
const GENERAL_RETIRE = 70;            // great generals past this age are not given new hosts
const PROMOTE_WINS = 4;               // real wins (two of them named battles) that make a commander a great general
// The world's temper: realms see how much of the world is at war and how much of their own
// life they have spent fighting, and their appetite leans back toward this share (a soft
// governor, so worlds differ but none drifts into permanent war or permanent peace).
const WAR_SHARE = 0.23;

// ---------------------------------------------------------------------------
// State

function state(world) {
  const st = (world.sys.war ||= {});
  st.names ||= {};
  st.sites ||= {};
  st.warMonths ||= {};
  st.liveMonths ||= {};
  st.lastPeace ||= {};
  st.sieges ||= {};       // sid → [armyId, civId, startDay]: the sieges under way (for siegeEnded)
  st.declared ||= 0;
  st.battles ||= 0;
  st.captures ||= 0;
  st.razed ||= 0;
  st.capitulations ||= 0;
  st.promoted ||= 0;
  st.disbanded ||= 0;
  return st;
}

/** +1 attacker, −1 defender, 0 not a party. */
export const sideOf = (war, civId) => (war.attackers.includes(civId) ? 1 : war.defenders.includes(civId) ? -1 : 0);

/** War score from a civ's point of view (−100..100). */
export function warScoreFor(world, war, civId) {
  const s = sideOf(war, civId);
  return s * (finite(war.warScore) ? war.warScore : 0);
}

const isCivil = (war) => (war.geo && war.geo.civil) || /civil|rebel|secession|revolt|uprising|independence/i.test(String(war.cause || ''));

/**
 * Wars the civ module starts for a seceding people ('civil war' / 'independence', rebel a
 * child of the loyal realm). Its warEnded hook settles their politics (reabsorbing a crushed
 * rising, crowning a victorious claimant), so peace here only returns occupied towns.
 */
function civModuleWar(world, war) {
  if (war.cause !== 'civil war' && war.cause !== 'independence') return false;
  const r = world.civs[war.attackers[0]], p = world.civs[war.defenders[0]];
  return Boolean(r && p && r.parentId === p.id);
}

function geoOf(world, war) {
  if (war.geo) return war.geo;
  war.geo = {
    cb: war.cause || 'conquest', goalSid: null, rid: null, occupied: {}, log: [], lastNote: -1e9, bat: 0, razed: 0,
    joined: false, monthCas: {}, civil: /civil|rebel|secession|revolt|uprising|independence/i.test(String(war.cause || '')),
    external: true,
  };
  if (!finite(war.warScore)) war.warScore = 0;
  war.casualties ||= {};
  war.captured ||= [];
  ledgerOf(world, war);
  return war.geo;
}

/**
 * War score = battle momentum (±35, fades) + occupation: for every town held by the side that
 * did not found it, its share of its original realm (×1.5 for a capital) × 100, plus a
 * permanent mark for razed towns. Positive favours the attackers.
 */
function rescore(world, war) {
  const g = geoOf(world, war);
  const base = {};
  for (const sid in g.occupied) {
    const o = g.occupied[sid];
    if (base[o] == null) base[o] = civPopulation(world, world.civs[o]);
    const s = world.settlements[sid];
    if (s && s.alive && s.civId !== o) base[o] += Math.max(0, s.population);
  }
  let occ = 0;
  for (const sid in g.occupied) {
    const s = world.settlements[sid];
    if (!s || !s.alive) continue;
    const o = g.occupied[sid];
    const holder = sideOf(war, s.civId), orig = sideOf(war, o);
    if (!holder || !orig || holder === orig) continue;
    const oc = world.civs[o];
    const cap = oc && oc.capitalId == null ? 1.5 : 1;   // the captured seat leaves the realm headless
    occ += holder * 100 * Math.max(0, s.population) / Math.max(1, base[o]) * (s.flags && s.flags.wasCapital === o ? 1.5 : cap);
  }
  occ = clamp(occ, -90, 90);
  g.occ = occ;
  war.warScore = clamp((g.bat || 0) + occ + (g.razed || 0), -100, 100);
  return war.warScore;
}

const leader = (world, ids) => {
  for (const id of ids) { const c = world.civs[id]; if (c && c.alive) return c; }
  return null;
};
/** War name for mid-sentence use: "the Salt War" (adds the article when the name lacks one). */
const theWar = (war) => {
  const n = String(war.name || 'the war');
  return /^the\s/i.test(n) ? 'the' + n.slice(3) : 'the ' + n;
};

function warBetween(world, a, b, prefer = null) {
  if (prefer != null) {
    const w = world.wars[prefer];
    if (w && w.active && sideOf(w, a) * sideOf(w, b) === -1) return w;
  }
  for (const w of activeWarList(world)) if (w.active && sideOf(w, a) * sideOf(w, b) === -1) return w;
  return null;
}

/** True when a and b stand together: a defensive alliance, or any ext 'allied' bond (unions). */
function boundTogether(world, a, b) {
  if (hasTreaty(world, a, b, 'alliance')) return true;
  return hasProviders('allied') && anyOf('allied', world, a, b);
}

// ---------------------------------------------------------------------------
// Names

const RES_PLACE = { Gold: 'Gold Fields', Salt: 'Salt Pans', Horse: 'Horse Plains', Copper: 'Copper Mines', Tin: 'Tin Mines', Iron: 'Iron Hills', Jewel: 'Jewel Mines', Marble: 'Marble Quarries', Spice: 'Spice Groves', Fur: 'Fur Forests', Coal: 'Coal Pits', Oil: 'Oil Fields' };

/** 'House of Varath' / 'House Varath' / 'Varath dynasty' → 'Varath' (for "The Varath War of Succession"). */
function dynastyWord(d) {
  if (typeof d !== 'string' || !d) return null;
  const w = d.replace(/^the\s+/i, '').replace(/^House\s+(of\s+)?/i, '').replace(/\s+dynasty$/i, '').trim();
  return w || null;
}

/** Make a war name unique: an unused variant, else the base with an ordinal ("The Second …"). */
function uniqueWarName(st, pool, start) {
  for (let k = 0; k < pool.length; k++) {
    const nm = pool[(start + k) % pool.length];
    if (!st.names[nm]) { st.names[nm] = 1; return nm; }
  }
  const base = pool[start % pool.length];
  const n = (st.names[base] || 1) + 1;
  st.names[base] = n;
  return /^The /.test(base) ? base.replace(/^The /, `The ${ordinalWord(n)} `) : `The ${ordinalWord(n)} ${base}`;
}

// War names are composed per casus belli: forms over the contested place, the two peoples, the
// river, the god, the goods or the ruler's grievance, plus a few by-names a chronicler might
// coin ("The War of the Spilled Wine"). Fixed-only forms are rare, so worlds seldom share a war.
const LAND_PL = { hills: 'Hills', pass: 'Pass', fords: 'Fords', marsh: 'Marshes', sands: 'Sands', wood: 'Woods', snows: 'Snows', shore: 'Shore', field: 'Fields' };
const HERDS = ['Cattle', 'Horse', 'Goat', 'Sheep', 'Swine', 'Reindeer'];
const FEUDS = ['Boundary Stones', 'Stolen Cattle', 'Spring Pastures', 'Salt Lick', 'Broken Fence', 'Drowned Ford', 'Burned Byre', 'Hunting Grounds',
  'Sacred Spring', 'Red Heifer', 'Stolen Bride', 'Poisoned Well'];
const RELICS = ['Relics', 'Bones', 'Shroud', 'Chalice', 'Idol', 'Sacred Stone', 'Tooth', 'Lamp', 'Altar', 'Holy Spring', "Saint's Hand", 'Sacred Grove', 'Tablets', 'Holy Fire'];
const ZEAL = ['Wrath', 'Banner', 'Zeal', 'Sword', 'Vengeance', 'Fire', 'Judgement', 'Hammer'];
const CROWN_ADJ = ['Empty', 'Broken', 'Two', 'Stolen', 'Contested', 'Orphaned', 'Divided', 'Usurped'];
const CROWN_N = ['Crown', 'Throne', 'Chair', 'Circlet', 'Seat', 'Sceptre'];
const BLOODS = ['Blood', 'Iron', 'Fire', 'Tears', 'Ash'];
const GOODS = ['Salt', 'Wool', 'Amber', 'Spice', 'Silk', 'Wine', 'Grain', 'Timber', 'Silver', 'Tin', 'Pepper', 'Dye', 'Ivory', 'Fur', 'Copper',
  'Honey', 'Linen', 'Oil', 'Glass', 'Pearl', 'Incense', 'Indigo', 'Cloth', 'Herring', 'Cedar'];
const MARKETS = ['Markets', 'Wharves', 'Tolls', 'Scales', 'Counting-Houses', 'Bridges', 'Fairs', 'Staples', 'Harbour Dues', 'Weighbeams', 'Customs Houses', 'Caravanserais'];
const SCAVS = ['Jackal', 'Vulture', 'Crow', 'Kite', 'Hyena', 'Fox', 'Wolf', 'Magpie', 'Raven'];
const GRUDGES = ['Old Grudge', 'Blood Debt', 'Broken Oath', 'Murdered Envoy', 'Burned Fields', 'Unavenged Dead', 'Long Memory', 'Bitter Peace'];
const SLIGHTS = ['Beard', 'Cup', 'Letter', 'Hound', 'Ring', 'Horse', 'Hat', 'Feast', 'Seal', 'Glove', 'Jest', 'Falcon'];
const INSULTS = ['Torn Letters', 'Spilled Wine', 'Shaved Beard', 'Burned Banner', 'Slighted Envoy', 'Broken Cup', 'Insulted Herald', 'Unpaid Dowry',
  'Poisoned Feast', 'Muddy Boots', 'Bad Jest', 'Severed Ear', 'Lost Falcon', 'Second Chair', 'Spurned Suitor', 'Forged Seal'];

const WAR_FORMS = {
  feud: [[3, 'The {place} Feud'], [2, 'The Feud of {place}'], [2, 'The {A}–{B} Feud'], [1.5, 'The Blood-Feud of {place}'], [1.2, 'The {Herd} Raids of {place}'],
    [1, 'The Feud of the {place} {LandPl}'], [0.4, 'The Feud of the {Feud}']],
  border: [[2.5, 'The War of the {river}'], [2, 'The War of the {place} Marches'], [2, 'The {place} War'], [1.5, 'The Border War of {place}'],
    [1.2, 'The {A}–{B} Border War'], [1.4, 'The War of the {place} {LandPl}'], [1, 'The {place} Frontier War'], [0.8, 'The War of the Boundary Stones of {place}']],
  holy: [[2, 'The Holy War of {place}'], [2, 'The {deity} Crusade'], [1.5, 'The Holy War of {deity}'], [1, 'The War of the Two Faiths of {place}'], [1.5, 'The {A} Crusade'],
    [1.2, 'The War of the {Relic} of {place}'], [1, 'The Crusade for {place}'], [1, 'The War of {deityPos} {Zeal}'], [0.3, 'The War of the Two Faiths']],
  succession: [[2, 'The War of the {B} Succession'], [1.5, 'The {dyn} War of Succession'], [1.5, 'The War of the {B} Crown'], [1.2, 'The War of the {B} Throne'],
    [1, 'The War of {rulerPos} Claim'], [1, 'The {B} Throne War'], [0.8, 'The War of the {CrownAdj} {CrownN} of {capB}'], [0.3, 'The War of the {CrownAdj} {CrownN}']],
  reconquest: [[2, 'The War for {place}'], [2, 'The Reconquest of {place}'], [1.5, 'The {place} Reclamation'], [1, 'The Return to {place}'], [1, 'The War of {place} Regained'],
    [1.2, 'The {A} Reconquest'], [1, 'The Long War for {place}']],
  resource: [[0.8, 'The {res} War'], [2, 'The War of the {place} {ResPlace}'], [2, 'The {place} {res} War'], [1.2, 'The War for the {ResPlace} of {place}'],
    [1, 'The {A}–{B} {res} War'], [0.4, 'The War of {res} and {Blood}']],
  trade: [[1.2, "The Merchants' War of {place}"], [2, 'The {place} Toll War'], [1.5, 'The War of the {place} Markets'], [1.5, 'The {A}–{B} Tariff War'],
    [1.4, 'The {place} {Good} War'], [1.2, 'The War of the {Market} of {place}'], [1, 'The {A} Toll War'], [0.3, "The Merchants' War"], [0.4, 'The {Good} War']],
  opportunism: [[2, 'The War of {place}'], [1.5, 'The {Season} War of {place}'], [1.2, "The {Scav}'s War of {place}"], [2, 'The {place} Campaign'], [1.2, 'The Seizure of {place}'],
    [0.4, "The {Scav}'s War"], [0.3, 'The {Season} War']],
  revenge: [[0.4, 'The War of Vengeance'], [1.5, 'The War of Vengeance for {place}'], [2, 'The {A} War of Revenge'], [2, 'The War of {rulerPos} Wrath'], [1.5, 'The {place} Vendetta'],
    [1.2, 'The {A} Reckoning'], [1, 'The Reckoning of {place}'], [1, 'The Blood-Price of {place}'], [0.4, 'The War of the {Grudge}']],
  liberation: [[2, 'The {A} War of Liberation'], [1.5, 'The {A} Revolt'], [1.2, 'The War of {A} Freedom'], [1.5, 'The {place} Rising'], [1.2, 'The Revolt of {place}'],
    [1.2, 'The {place} Uprising'], [1, 'The Breaking of the {B} Yoke'], [1, 'The War of the {A} Banner']],
  provocation: [[1.5, 'The War of the {place} Insult'], [1, "The Envoys' War of {place}"], [1, 'The {A}–{B} War of Whispers'], [2, 'The {A}–{B} War'],
    [1, 'The Provoked War of {place}'], [1.2, 'The {place} Affront'], [1.5, 'The War of {rulerPos} {Slight}'], [0.5, 'The War of the {Insult}']],
  raids: [[2, 'The {A}–{B} Raids'], [2, 'The Raids on {place}'], [1.5, 'The {place} {Herd} Raids'], [1.2, 'The {A} Raids'], [1, 'The {Season} Raids on {place}']],
  conquest: [[2.5, 'The {A}–{B} War'], [2, 'The {A} Invasion of {place}'], [2, 'The War of {place}'], [1.5, 'The {A} Conquest of {place}'], [1.5, 'The {place} War'],
    [1, 'The {B} War'], [0.8, 'The War of the {place} {LandPl}']],
};

function warName(world, st, cb, a, b, ctx) {
  const rng = world.rng;
  const tribal = eraOf(a) === 0 && eraOf(b) === 0;
  const key = cb === 'border' && tribal ? 'feud' : WAR_FORMS[cb] ? cb : tribal ? 'raids' : 'conquest';
  const deity = ctx.deity || null;
  const ruler = ctx.ruler && ctx.ruler.split(' ')[0];
  const vocab = {
    place: ctx.place, A: civAdj(a), B: civAdj(b), river: ctx.river ? bare(ctx.river) : null, deity, deityPos: deity ? possessive(deity) : null,
    dyn: dynastyWord(a.dynasty) || civAdj(a), rulerPos: ruler ? possessive(ruler) : null, capB: ctx.capB || null,
    res: ctx.res || null, ResPlace: ctx.res ? RES_PLACE[ctx.res] || `${ctx.res} Lands` : null, Season: capFirst(ctx.season || 'summer'),
    LandPl: ctx.land ? LAND_PL[ctx.land] : null, Herd: HERDS, Feud: FEUDS, Relic: RELICS, Zeal: ZEAL, CrownAdj: CROWN_ADJ, CrownN: CROWN_N,
    Blood: BLOODS, Good: GOODS, Market: MARKETS, Scav: SCAVS, Grudge: GRUDGES, Slight: SLIGHTS, Insult: INSULTS,
  };
  // another package's casus belli may bring its own name; it comes first
  const pool = ctx.name ? [String(ctx.name)] : [];
  for (let k = 0; k < 6 && pool.length < 7; k++) {
    const n = composeName(rng, WAR_FORMS[key], vocab);
    if (n && !pool.includes(n)) pool.push(n);
  }
  if (!pool.length) pool.push(`The ${civAdj(a)}–${civAdj(b)} War`);
  return uniqueWarName(st, pool, 0);
}

const figureById = (world, id) => {
  if (id == null) return null;
  for (let k = world.figures.length - 1; k >= 0; k--) if (world.figures[k].id === id) return world.figures[k];
  return null;
};
const ageOf = (world, born) => (finite(born) ? (world.time.day - born) / DAYS_PER_YEAR : 40);

/** The commander's name ("Arven the Bold"), whatever the save stored on army.general. */
export function leaderName(army) {
  const g = army && army.general;
  if (!g) return null;
  if (typeof g === 'string') return g;
  return typeof g.name === 'string' ? g.name : null;
}

/**
 * A commander for a new army: an idle great general of the realm (a living figure under 70),
 * else a fresh leader — a plain { name, skill, born } who becomes a figure only by winning.
 * Returns { leader, genId }.
 */
function recruitGeneral(world, civ) {
  const rng = world.rng;
  const busy = new Set();
  for (const a of world.armies) if (a.flags && a.flags.genId != null) busy.add(a.flags.genId);
  const pickFig = (f) => f && f.kind === 'general' && f.civId === civ.id && f.died == null && !busy.has(f.id) && ageOf(world, f.born) < GENERAL_RETIRE;
  let fig = null;
  const figs = civ.flags && Array.isArray(civ.flags.figs) ? civ.flags.figs : [];
  for (const id of figs) { const f = figureById(world, id); if (pickFig(f)) { fig = f; break; } }
  if (!fig) for (let k = world.figures.length - 1; k >= 0 && k > world.figures.length - 300; k--) if (pickFig(world.figures[k])) { fig = world.figures[k]; break; }
  if (fig) {
    return { leader: { name: fig.name, skill: finite(fig.skill) ? fig.skill : 1.1, born: finite(fig.born) ? fig.born : world.time.day - 40 * DAYS_PER_YEAR, wins: fig.wins | 0, battles: fig.battles | 0, honours: PROMOTE_WINS }, genId: fig.id };
  }
  let name = makePerson(civ.language, rng);
  if (rng.chance(0.5)) name += ' ' + makeEpithet(rng, 'any');
  const skill = rng.chance(0.06) ? 1.35 + rng.next() * 0.15 : 0.82 + rng.next() * 0.4;
  const born = world.time.day - Math.round((25 + rng.next() * 20) * DAYS_PER_YEAR);
  return { leader: { name, skill: Math.round(skill * 1000) / 1000, born, wins: 0, battles: 0, honours: 0 }, genId: null };
}

/**
 * A commander who has earned fame (a great victory, or a third win) joins the great figures:
 * addFigure, enrolled in the realm's figures so the civ module ages them, flags.genId set.
 */
function promoteGeneral(world, st, army, civ, why, bname, causeSeq) {
  const g = army.general;
  if (!g || typeof g !== 'object' || army.flags.genId != null || !civ || !civ.alive) return null;
  const home = world.settlements[army.homeId];
  const deeds = [];
  if (bname) deeds.push(`won ${bname}`);
  const fig = addFigure(world, {
    name: g.name, kind: 'general', title: 'general', civId: civ.id, sid: home && home.alive ? home.id : capitalOf(world, civ)?.id ?? null,
    born: finite(g.born) ? g.born : world.time.day - 40 * DAYS_PER_YEAR, deeds, skill: g.skill, wins: g.wins | 0, battles: g.battles | 0,
    fame: why === 'great' ? 2 : 1,
  });
  army.flags.genId = fig.id;
  civ.flags ||= {};
  if (!Array.isArray(civ.flags.figs)) civ.flags.figs = [];
  if (!civ.flags.figs.includes(fig.id)) civ.flags.figs.push(fig.id);
  st.promoted++;
  emit(world, 'figureBorn', fig);
  const age = Math.round(ageOf(world, fig.born));
  const where = bname || 'the field';
  const text = why === 'great'
    ? pickOne(world, [
      `After ${where}, ${peopleOf(civ)} hailed ${g.name} as the greatest captain of the age.`,
      `${capFirst(where)} made ${g.name} a legend: at ${age}, the ${civAdj(civ)} commander was spoken of in every hall from ${home && home.alive ? home.name : 'the capital'} to the frontier.`,
      `Songs of ${where} carried the name of ${g.name} across ${civName(civ)}; the soldiers swore they would follow the general anywhere.`,
    ])
    : pickOne(world, [
      `A third victory, at ${where}, made ${g.name} the most feared general of ${civName(civ)}.`,
      `Victorious again at ${where}, ${g.name} won the unshakeable trust of the ${civAdj(civ)} host and a place among the great of ${civName(civ)}.`,
      `${g.name} had now beaten the enemy three times; after ${where} the soldiers of ${civName(civ)} called the general unconquerable.`,
    ]);
  const at = home && home.alive ? home : { x: Math.round(army.x), y: Math.round(army.y), id: null };
  // great people are the figures' story (as the civ module's heroes and scholars are), not the war's
  chronicle(world, {
    cat: 'culture', imp: 2, text, x: Math.round(army.x), y: Math.round(army.y), civId: civ.id, sid: at.id ?? null, icon: 'battle',
    key: 'figure.general', ref: { k: 'figure', id: fig.id }, ...(causeSeq != null ? { cause: causeSeq } : {}), tags: ['general'],
  });
  return fig;
}

function hostWord(str, era) {
  if (str < 150) return era === 0 ? 'war band' : 'warband';
  if (str < 2500) return 'host';
  if (str < 25000) return 'army';
  return 'grand army';
}

// ---------------------------------------------------------------------------
// Battle sites

function siteName(world, x, y) {
  const W = world.W;
  const xi = clamp(Math.round(x), 0, W - 1), yi = clamp(Math.round(y), 0, world.H - 1);
  const i = yi * W + xi;
  const land = landscapeAt(world, i);
  const near = nearestSettlement(world, xi, yi, { maxDist: 14 });
  const nm = near ? near.name : null;
  if (land === 'sea') {
    const sea = nearestFeature(world, xi, yi, ['sea', 'ocean'], 40);
    if (sea && (!nm || hashPick([0, 1], i) === 0)) return named([`the ${bare(sea.name)}`], land, i);
    return named(nm ? [`the Waters off ${nm}`, `the ${nm} Narrows`, `${nm} Roads`] : ['the Open Sea'], land, i);
  }
  if (land === 'fords') {
    const riv = nearestFeature(world, xi, yi, ['river'], 14);
    if (riv) return named([`the ${bare(riv.name).replace(/^River\s+/i, '')} Fords`], land, i);
  }
  if ((land === 'pass' || land === 'hills') && !nm) {
    const rg = nearestFeature(world, xi, yi, ['range'], 18);
    if (rg) return named([land === 'pass' ? `the Pass of ${bare(rg.name)}` : `the Foothills of ${bare(rg.name)}`], land, i);
  }
  if (!nm) {
    const any = nearestFeature(world, xi, yi, ['forest', 'desert', 'range', 'lake', 'river', 'island', 'continent'], 30);
    return named(any ? [`the Edge of ${bare(any.name)}`] : ['the Nameless Field', 'the Empty Wastes', 'the Lonely Plain'], land, i);
  }
  const T = {
    fords: [`the Fords of ${nm}`, `${nm} Ford`, `the Crossing at ${nm}`],
    pass: [`the Pass of ${nm}`, `${nm} Pass`, `the Gates of ${nm}`],
    hills: [`${nm} Heights`, `the Hills of ${nm}`, `${nm} Ridge`],
    marsh: [`the ${nm} Marshes`, `the Fens of ${nm}`],
    sands: [`the Sands of ${nm}`, `the Dunes of ${nm}`],
    wood: [`${nm} Wood`, `the Forest of ${nm}`],
    snows: [`the Snows of ${nm}`, `the Frozen Field of ${nm}`],
    shore: [`${nm} Strand`, `the Shore of ${nm}`, `${nm} Beach`],
    field: [`${nm}`, `${nm} Field`, `${nm} Plain`, `the Meadows of ${nm}`],
  };
  return named(T[land] || T.field, land, i);
}

/** Site names for a place, starting from a variant fixed by the tile so a place keeps its name. */
function named(list, land, i) {
  const k = hashPick(list.map((_, j) => j), i, 7);
  const alts = list.slice(k).concat(list.slice(0, k));
  return { site: alts[0], alts, land };
}

/**
 * The name a recorded battle goes down in history with: the plain name of the ground, then
 * its other names, then "the Second … Fourth Battle of", then the season, then the year.
 */
function battleName(world, st, alts, y) {
  for (const nm of alts) if (!st.sites[nm]) { st.sites[nm] = 1; return `the Battle of ${nm}`; }
  const base = alts[0];
  const n = (st.sites[base] || 1) + 1;
  if (n <= 4) { st.sites[base] = n; return `the ${ordinalWord(n)} Battle of ${base}`; }
  const season = capFirst(seasonWord(world, y));
  const key = `${season}|${base}`;
  if (!st.sites[key]) { st.sites[key] = 1; return `the ${season} Battle of ${base}`; }
  return `the Battle of ${base} in Year ${Math.floor(world.time.day / DAYS_PER_YEAR)}`;
}

// ---------------------------------------------------------------------------
// Declarations

function casusBelli(world, a, b, r, ctx) {
  const opts = [];
  if (a.vassalOf === b.id) {
    const pa = ctx.power[a.id] || 0, pb = ctx.power[b.id] || 1;
    if (pa > 0.5 * pb || (b.warWeariness || 0) > 0.5 || (finite(b.stability) && b.stability < 0.35)) opts.push({ key: 'liberation', w: 2.2 });
    return opts.length ? opts[0] : null;
  }
  // reconquest: the strongest claim a holds on a town b holds now (claims.js)
  const lost = bestClaimOn(world, a, b);
  if (lost) opts.push({ key: 'reconquest', w: 0.9 + 1.1 * lost.w, goalSid: lost.s.id, place: lost.s.name });
  // succession and secession claims
  if (b.parentId === a.id && (world.time.day - b.foundedDay) < 150 * DAYS_PER_YEAR) opts.push({ key: 'succession', w: 1.6 });
  else if (a.ruler && b.ruler && a.ruler.dynasty && a.ruler.dynasty === b.ruler.dynasty) opts.push({ key: 'succession', w: 1.5 });
  // holy war
  const fa = faithOf(world, a.stateReligion), fb = faithOf(world, b.stateReligion);
  if (fa && (!fb || fb.id !== fa.id)) {
    const hc = world.settlements[fa.holyCityId];
    const heldHoly = hc && hc.alive && hc.civId === b.id;
    const militant = fa.tenets.includes('militant');
    if (fb && (militant || heldHoly || fa.fervor > 0.7)) {
      let w = 0.35 + 0.6 * fa.fervor + (militant ? 0.45 : 0) + (heldHoly ? 0.8 : 0) + (fb.parentId === fa.id || fa.parentId === fb.id ? 0.3 : 0);
      if (rulerHas(a, 'pious')) w *= 1.25;
      if (fa.tenets.includes('tolerant')) w *= 0.6;
      opts.push({ key: 'holy', w: Math.min(1.9, w), rid: fa.id, goalSid: heldHoly ? hc.id : null, place: heldHoly ? hc.name : null });
    }
  }
  // borders
  if ((r.tension || 0) > 0.25) opts.push({ key: 'border', w: 0.8 + r.tension * 1.2 });
  // revenge
  if ((r.grievance || 0) > 25) opts.push({ key: 'revenge', w: 0.8 + r.grievance / 50 });
  // coveted resources near the border
  const res = covetedResource(world, a, b);
  if (res) opts.push({ key: 'resource', w: 1.1, goalSid: res.s.id, place: res.s.name, res: res.word });
  if ((r.trade || 0) > 5 && r.opinion < -20) opts.push({ key: 'trade', w: 1.1 });
  // debts b repudiated (debt.js): a lender may go to collect them
  const owed = debtClaim(world, a.id, b.id);
  if (owed) opts.push({ key: 'debt', w: owed.w });
  // opportunism
  const eb = ctx.enemies[b.id];
  if (eb && eb.size > 0 && !eb.has(a.id) && (b.warWeariness || 0) > 0.2) opts.push({ key: 'opportunism', w: 1.4 });
  opts.push({ key: 'conquest', w: 0.5 + (a.traits?.expansion ?? 0.5) * 0.6 + (rulerHas(a, 'warlike') ? 0.5 : 0) });
  // claims other packages raise (dynastic claims, restorations, ancient enmities, prophecies …)
  if (hasProviders('casusBelli')) {
    for (const c of concatOf('casusBelli', world, a, b)) {
      if (!c || typeof c.cb !== 'string' || !(finite(c.w) && c.w > 0)) continue;
      const goal = c.goalSid != null ? world.settlements[c.goalSid] : null;
      opts.push({ key: c.cb, w: Math.min(2.5, c.w), name: typeof c.name === 'string' && c.name ? c.name : null, goalSid: goal && goal.alive && goal.civId === b.id ? goal.id : null, place: goal && goal.alive ? goal.name : null, aim: typeof c.aim === 'string' ? c.aim : null, ext: true });
    }
  }
  let best = opts[0];
  for (const o of opts) if (o.w > best.w) best = o;
  return best;
}

const RES_WORD = { copper: 'Copper', tin: 'Tin', iron: 'Iron', gold: 'Gold', gems: 'Jewel', marble: 'Marble', horses: 'Horse', spices: 'Spice', salt: 'Salt', furs: 'Fur', coal: 'Coal', oil: 'Oil' };

function covetedResource(world, a, b) {
  const capA = capitalOf(world, a);
  if (!capA) return null;
  const { W, H, f } = world;
  let best = null, bd = Infinity;
  for (const sid of b.settlementIds) {
    const s = world.settlements[sid];
    if (!s || !s.alive) continue;
    const d = dist(capA.x, capA.y, s.x, s.y);
    if (d > 22 || d >= bd) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = s.x + dx, y = s.y + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      const rid = f.resource[i];
      if (!rid || rid >= RESOURCES.length || f.resourceAmt[i] < 0.1) continue;
      const R = RESOURCES[rid];
      if (R.era > eraOf(a) + 1 || R.value < 2 || hasResourceNear(world, capA, rid)) continue;
      best = { s, word: RES_WORD[R.key] || R.name }; bd = d;
    }
  }
  return best;
}

function hasResourceNear(world, s, rid) {
  const { W, H, f } = world;
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    if (f.resource[y * W + x] === rid) return true;
  }
  return false;
}

function frontDistance(world, a, b) {
  let best = Infinity;
  const ta = townsOf(world, a).slice(0, 24), tb = townsOf(world, b).slice(0, 24);
  for (const s of ta) for (const t of tb) {
    const d = (s.x - t.x) * (s.x - t.x) + (s.y - t.y) * (s.y - t.y);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Years since the civ last made peace (large when it never fought). */
function yearsAtPeace(world, st, civId) {
  const d = st.lastPeace[civId];
  return d == null ? 999 : (world.time.day - d) / DAYS_PER_YEAR;
}

/**
 * Two-stage declaration. First the realm's appetite for war this month — temperament ×
 * params.aggression, ruler, faith, unrest at home, weariness and the reluctance of a people
 * that only lately made peace (and of one already defending itself). Only then does its court
 * weigh every eligible neighbour: hostility, the balance of power (counting the friends who
 * would come to the target's aid), reach, the pair's ext 'warAppetite' and the strongest casus
 * belli. The most tempting target is attacked if its temptation passes a second roll, so
 * peaceful, wary or busy realms rarely start wars and bitter rivals with weak neighbours often do.
 */
function declarations(world, st, ctx) {
  const rng = world.rng;
  const day = world.time.day;
  const aggrP = world.params.aggression ?? 1;
  if (!(aggrP > 0)) return;
  const appetiteExt = hasProviders('warAppetite');
  const civs = liveCivs(world);
  const atWar = civsAtWar(world);
  let warring = 0;
  for (const c of civs) if (atWar.has(c.id)) warring++;
  const worldF = civs.length >= 3 ? clamp(Math.pow(WAR_SHARE / Math.max(0.05, warring / civs.length), 0.8), 0.4, 2.2) : 1;
  for (const a of civs) {
    if (!a.settlementIds.length) continue;
    const weary = a.warWeariness || 0;
    if (weary > 0.45) continue;
    let offensive = 0;
    for (const w of activeWarList(world)) if (w.active && w.attackers[0] === a.id) offensive++;
    if (offensive >= 1) continue;
    const ta = a.traits || {};
    const aggrF = (0.25 + 1.5 * (ta.aggression ?? 0.5)) * (0.6 + 0.8 * (ta.militarism ?? 0.5));
    let rulerF = 1;
    if (rulerHas(a, 'warlike')) rulerF *= 1.9;
    if (rulerHas(a, 'cruel')) rulerF *= 1.25;
    if (rulerHas(a, 'mad')) rulerF *= 1.4;
    if (rulerHas(a, 'ambitious')) rulerF *= 1.3;
    if (rulerHas(a, 'craven')) rulerF *= 0.4;
    if (rulerHas(a, 'just')) rulerF *= 0.8;
    if (rulerHas(a, 'wise')) rulerF *= 0.8;
    if (rulerHas(a, 'scholarly')) rulerF *= 0.85;
    if (rulerHas(a, 'cautious')) rulerF *= 0.7;
    if (rulerHas(a, 'generous')) rulerF *= 0.9;
    const fa = faithOf(world, a.stateReligion);
    let faithF = 1;
    if (fa) { if (fa.tenets.includes('pacifist')) faithF *= 0.4; if (fa.tenets.includes('tolerant')) faithF *= 0.8; if (fa.tenets.includes('militant')) faithF *= 1.35; }
    const stabF = finite(a.stability) && a.stability < 0.3 ? 1.3 : 1;     // a foreign war to quiet unrest at home
    const restF = 1 - 0.95 * Math.exp(-yearsAtPeace(world, st, a.id) / REST_YEARS);
    const defending = ctx.enemies[a.id] && ctx.enemies[a.id].size > 0;
    // a realm with many marches has many quarrels
    let fronts = 0;
    for (const k in a.relations) if ((a.relations[k].border || 0) > 0 && world.civs[k]?.alive) fronts++;
    const frontF = 0.7 + 0.3 * Math.min(4, fronts);
    // a realm that has spent much of its life at war grows tired of it, one long at peace restless
    const life = st.liveMonths[a.id] || 0;
    // (integration: a firmer pull toward the share, so war-prone and peaceful worlds both stay in the 15–35 % band)
    const ownF = life >= 120 ? clamp(Math.pow(WAR_SHARE / Math.max(0.04, (st.warMonths[a.id] || 0) / life), 1.5), 0.25, 3) : 1;
    const appetite = APPETITE * aggrP * aggrF * rulerF * faithF * stabF * (1 - weary) * (1 - weary) * restF * frontF
      * (defending ? 0.25 : 1) * (a.vassalOf != null ? 0.6 : 1) * worldF * ownF;
    if (!rng.chance(appetite)) continue;
    const pa = ctx.power[a.id] || 0;
    const nav = modsOf(world, a).navigation;
    // in a long quiet, old resentments surface: friendlier neighbours become thinkable targets
    const gov = Math.sqrt(worldF * ownF);
    const grudge = clamp(14 * (gov - 1), -8, 16);
    let best = null, bestCb = null, bestDesire = 0;
    for (const k in a.relations) {
      const b = world.civs[k];
      if (!b || !b.alive || b.id === a.id || !b.settlementIds.length) continue;
      const r = a.relations[k];
      if ((r.truceUntil ?? -1) > day) continue;
      if (areAtWar(world, a.id, b.id)) continue;
      if (b.vassalOf === a.id) continue;
      const vassalBid = a.vassalOf != null;
      if (vassalBid && a.vassalOf !== b.id) continue;          // vassals only fight their overlord
      if (!vassalBid && boundTogether(world, a.id, b.id)) continue;
      if (b.vassalOf != null && b.vassalOf !== a.id && world.civs[b.vassalOf]?.alive && (a.allies || []).includes(b.vassalOf)) continue;
      const host = clamp01((20 + grudge - (finite(r.opinion) ? r.opinion : 0)) / 120);
      if (host <= 0.02) continue;
      // power of the target and of the friends who would come to its aid
      let pb = ctx.power[b.id] || 0;
      for (const al of b.allies || []) if (al !== a.id && world.civs[al]?.alive) pb += 0.6 * (ctx.power[al] || 0);
      if (b.vassalOf != null && b.vassalOf !== a.id) pb += 0.8 * (ctx.power[b.vassalOf] || 0);
      const powerF = clamp(Math.pow(pa / Math.max(1, pb), 1.3), 0.05, 2.5);
      let reachF = 1;
      if ((r.border || 0) === 0) {
        if (frontDistance(world, a, b) > (nav >= 1 ? 55 : 30)) continue;
        reachF = 0.4;
      }
      const appF = appetiteExt ? mulOf('warAppetite', world, a, b) : 1;
      // a realm whose heir is held at b's court hardly thinks of war on b (terms.js)
      const pre = Math.pow(host, 1.2) * powerF * reachF * (vassalBid ? 1.5 : 1) * appF * (hostageHeld(world, a.id, b.id) ? 0.1 : 1);
      if (pre * 2.5 <= bestDesire) continue;                   // cannot beat the best even with the strongest claim
      const cb = casusBelli(world, a, b, r, ctx);
      if (!cb) continue;
      const desire = pre * cb.w;
      if (desire > bestDesire) { bestDesire = desire; best = b; bestCb = cb; }
    }
    if (!best || !rng.chance(clamp01(bestDesire * gov / 1.2))) continue;
    declare(world, st, a, best, bestCb, ctx);
  }
}

/** Declaration prose for every casus belli (several templates each). */
function declarationText(world, a, b, cb, ctx) {
  const { place, faith, wn } = ctx;
  const ruler = rulerName(a);
  const A = capFirst(civName(a)), B = civName(b), Ao = civName(a);
  const season = seasonWord(world, ctx.y);
  switch (cb.key) {
    case 'border': return pickOne(world, [
      `${A} declared war on ${B} over the disputed marches of ${place}, beginning ${wn}.`,
      `Border raids around ${place} hardened into open war between ${Ao} and ${B}: ${wn} had begun.`,
      `In the ${season} of Year ${ctx.year} the quarrel over ${place} came to blows, and ${Ao} marched against ${B} in ${wn}.`,
    ]);
    case 'holy': return pickOne(world, [
      `Zealots of ${faith.name} led ${Ao} into ${wn} against the unbelievers of ${B}.`,
      `${ruler || A} proclaimed ${wn}, swearing to bring ${faith.name} to ${B} by the sword.`,
      `The priests of ${faith.name} blessed the banners of ${Ao}, and ${wn} against ${B} began${place ? ` with a vow to free ${place}` : ''}.`,
    ]);
    case 'succession': return pickOne(world, [
      `Claiming the throne of ${B} by right of blood, ${ruler || `the rulers of ${Ao}`} marched to war; men would call it ${wn}.`,
      `${A} pressed its claim to the crown of ${B}, and ${wn} began.`,
    ]);
    case 'claim': return pickOne(world, [
      `Pressing an old claim to the crown of ${B}, ${ruler || `the court of ${Ao}`} went to war: ${wn}.`,
      `${A} sent heralds to ${B} demanding its crown by right of blood; they came back with a refusal, and ${wn} began.`,
    ]);
    case 'restoration': return pickOne(world, [
      `${A} took up the cause of an exiled house and marched on ${place || B} to restore it, beginning ${wn}.`,
      `Sheltering a deposed court, ${Ao} went to war to set it back on its throne in ${B}: ${wn}.`,
    ]);
    case 'reconquest': return pickOne(world, [
      `${A} went to war to win back ${place}, lost long ago to ${B}: ${wn} had begun.`,
      `Remembering that ${place} had once been theirs, ${peopleOf(a)} marched on ${B} in ${wn}.`,
      `${ruler || A} swore never to rest while ${place} flew the banners of ${B}, and ${wn} began.`,
    ]);
    case 'resource': return pickOne(world, [
      `Covetous of the ${cb.res.toLowerCase()} of ${place}, ${Ao} attacked ${B} in what became ${wn}.`,
      `${A} seized on a quarrel over the ${cb.res.toLowerCase()} of ${place} to make war on ${B}: ${wn}.`,
    ]);
    case 'trade': return pickOne(world, [
      `Quarrels between the merchants of ${Ao} and ${B} flared into ${wn}.`,
      `When ${B} doubled its tolls once too often, ${Ao} answered with spears: ${wn} had begun.`,
      `A merchant fleet seized in ${place} was the last straw; ${A} declared ${wn} on ${B}.`,
    ]);
    case 'debt': return pickOne(world, [
      `${A} went to war to recover the debts ${B} had repudiated, beginning ${wn}.`,
      `When ${B} refused to pay what it owed, ${Ao} sent armies to collect it: ${wn} had begun.`,
    ]);
    case 'opportunism': return pickOne(world, [
      `Seeing ${B} beset by enemies, ${Ao} struck in ${wn}.`,
      `${A} fell upon ${B} while its armies were busy elsewhere, beginning ${wn}.`,
    ]);
    case 'revenge': return pickOne(world, [
      `Nursing old grievances, ${Ao} fell upon ${B}; ${wn} had begun.`,
      `${ruler || A} swore to avenge old wrongs and led ${peopleOf(a)} against ${B} in ${wn}.`,
    ]);
    case 'liberation': return pickOne(world, [
      `${A} rose against its overlord ${B}, beginning ${wn}.`,
      `Refusing further tribute, ${Ao} took up arms against ${B} in ${wn}.`,
    ]);
    case 'enmity': return pickOne(world, [
      `An ancient hatred between ${peopleOf(a)} and ${peopleOf(b)} flared once more into ${wn}.`,
      `The old enmity of their peoples sent ${Ao} to war with ${B}: ${wn}.`,
    ]);
    case 'prophecy': return pickOne(world, [
      `A prophecy sent ${Ao} to war: ${ruler || 'its rulers'} marched on ${place || B}, and ${wn} began.`,
      `Seers had foretold that ${place || 'the city'} would fall to ${peopleOf(a)}, and ${A} set out to make it so in ${wn}.`,
    ]);
    case 'relic': return pickOne(world, [
      `${A} went to war to win back the relics carried off by ${B}, beginning ${wn}.`,
      `For the stolen relics of its temples, ${Ao} declared ${wn} on ${B}.`,
    ]);
    case 'witchstone': return pickOne(world, [
      `${A} coveted the stones of power in the lands of ${B}, and ${wn} began.`,
      `The magi of ${Ao} lusted after the old stones of ${B}; ${wn} was fought for them.`,
    ]);
    case 'provocation': return pickOne(world, [
      `Forged letters and murdered envoys did their work: ${Ao} declared ${wn} on ${B}.`,
      `Whispers of insult and treachery drove ${ruler ? `${ruler} of ${Ao}` : Ao} to war with ${B}: ${wn}.`,
      `An unseen hand set the courts of ${Ao} and ${B} at each other's throats, and ${wn} began.`,
    ]);
    default: {
      if (cb.ext) return pickOne(world, [
        `${A} declared war on ${B}, beginning ${wn}.`,
        `${ruler ? `${ruler} of ${Ao}` : A} took up arms against ${B} in ${wn}.`,
      ]);
      return pickOne(world, [
        `${ruler ? `${ruler} of ${Ao}` : A} launched ${wn} against ${B}, hungry for land.`,
        `${A} invaded ${B}, beginning ${wn}.`,
        `War came to ${place} as ${Ao} marched against ${B}: ${wn}.`,
      ]);
    }
  }
}

/** True when civ is among the n most populous living realms (ties by id). */
function topRealm(world, civ, n) {
  const p = civ.population || 0;
  let above = 0;
  for (const c of liveCivs(world)) {
    if (c === civ) continue;
    const q = c.population || 0;
    if (q > p || (q === p && c.id < civ.id)) { if (++above >= n) return false; }
  }
  return true;
}

/**
 * Open a war of a against b for casus belli cb: name, bookkeeping, the chronicle line, calls
 * to arms and the first levies. opts: { quiet, cause (seq), imp, textFn(world, war) → text }.
 */
function declare(world, st, a, b, cb, ctx, opts = {}) {
  const rng = world.rng;
  const capB = capitalOf(world, b), capA = capitalOf(world, a);
  // the contested place: the goal town, or b's town nearest a's capital
  let place = cb.place;
  let goal = cb.goalSid != null ? world.settlements[cb.goalSid] : null;
  if (!goal && capA) goal = nearestSettlement(world, capA.x, capA.y, { civId: b.id });
  if (!place) place = goal ? goal.name : capB ? capB.name : civAdj(b);
  const river = cb.key === 'border' && goal ? nearestFeature(world, goal.x, goal.y, ['river'], 10) : null;
  const faith = cb.rid != null ? faithOf(world, cb.rid) : null;
  const name = opts.name || warName(world, st, cb.key, a, b, {
    place, river: river && rng.chance(0.5) ? river.name : null, faith: faith ? faith.name : null, deity: faith ? faith.deity : null, res: cb.res,
    season: seasonWord(world, capA ? capA.y : 0), ruler: a.ruler ? a.ruler.name : null, name: cb.name || null,
    land: goal ? landscapeAt(world, goal.i) : null, capB: capB ? capB.name : null,
  });
  const napBroken = hasTreaty(world, a.id, b.id, 'nap');
  const war = startWar(world, [a.id], [b.id], cb.key, name);
  const g = geoOf(world, war);
  g.cb = cb.key; g.goalSid = goal ? goal.id : null; g.rid = cb.rid ?? null; g.external = false; g.civil = false;
  // what each side fights for (terms.js): the attacker's aim follows its casus belli
  const ratio = (ctx.power[a.id] || 0) / Math.max(1, ctx.power[b.id] || 0);
  g.aims = { a: aimFor(world, a, b, cb, goal, ratio), d: defenderAim(world, b, a) };
  if (g.aims.a.k === 'towns' && cb.key === 'reconquest' && g.aims.a.sids.length > 1) place = listJoin(g.aims.a.sids.map((sid) => world.settlements[sid].name));
  st.declared++;
  if (faith) boostFervor(world, faith.id, 0.05);
  let entry = null;
  if (!opts.quiet) {
    const wn = theWar(war);
    const text = opts.textFn ? opts.textFn(world, war) : declarationText(world, a, b, cb, { place, faith, wn, y: capA ? capA.y : 0, year: Math.floor(world.time.day / DAYS_PER_YEAR) });
    // a war between realms of weight is major news; a feud between chiefdoms is not
    const wp = worldPopulation(world);
    const weighty = (c) => c.settlementIds.length >= 4 || civPopulation(world, c) > Math.max(20000, 0.04 * wp);
    // major (imp 3) only when great powers meet: both among the four greatest realms of the age
    // (and at most one such declaration in five years: the world does not hold its breath twice a year)
    const big = weighty(a) && weighty(b) && topRealm(world, a, 4) && topRealm(world, b, 4) && rateReady(world, 'decl3', 5 * DAYS_PER_YEAR);
    if (big && opts.imp == null) rateOk(world, 'decl3', 5 * DAYS_PER_YEAR);
    const at = goal || capB;
    entry = chronicle(world, {
      cat: opts.cat || 'war', imp: opts.imp ?? (big ? 3 : 2), text, x: at ? at.x : null, y: at ? at.y : null, civId: a.id, sid: at ? at.id : null, icon: 'war',
      key: opts.key || 'war.declared', ref: { k: 'war', id: war.id }, ...(opts.cause != null ? { cause: opts.cause } : {}), tags: [cb.key],
    });
    g.seq = entry.seq;
  }
  if (napBroken) betrayal(world, a.id, b.id, 'nap');
  if (cb.key === 'liberation') betrayal(world, a.id, b.id, 'vassal');
  killHostage(world, a.id, b.id, war);   // its heir was held at b's court: b puts the hostage to death
  callToArms(world, st, war, ctx);
  g.joined = true;
  mobilize(world, a, war);
  mobilize(world, b, war);
  return war;
}

function monthCtx(world) {
  const ctx = { power: {}, enemies: {} };
  for (const c of liveCivs(world)) { ctx.power[c.id] = civPower(world, c); ctx.enemies[c.id] = enemySet(world, c.id); }
  return ctx;
}

/**
 * Published: begin a war under a given name (events, divine acts and other packages). The
 * caller writes its own chronicle line. cb is the casus belli key. opts: { goalSid }.
 * Allies and vassals are called to arms and the first levies raised. Returns the war or null.
 */
export function startWarNamed(world, attackers, defenders, cb = 'conquest', name = null, opts = {}) {
  const st = state(world);
  const att = (attackers || []).filter((id) => world.civs[id]?.alive);
  const def = (defenders || []).filter((id) => world.civs[id]?.alive && !att.includes(id));
  if (!att.length || !def.length) return null;
  const a = world.civs[att[0]], b = world.civs[def[0]];
  if (areAtWar(world, a.id, b.id)) return warBetween(world, a.id, b.id);
  const goal = opts.goalSid != null ? world.settlements[opts.goalSid] : null;
  const ctx = monthCtx(world);
  const war = declare(world, st, a, b, { key: String(cb || 'conquest'), w: 1, goalSid: goal && goal.alive ? goal.id : null, place: goal && goal.alive ? goal.name : null }, ctx, { quiet: true, name: name || null });
  for (const id of att.slice(1)) { const c = world.civs[id]; if (c && sideOf(war, id) === 0) { joinWar(world, war, c, 1); mobilize(world, c, war); } }
  for (const id of def.slice(1)) { const c = world.civs[id]; if (c && sideOf(war, id) === 0) { joinWar(world, war, c, -1); mobilize(world, c, war); } }
  return war;
}

// ---------------------------------------------------------------------------
// Allies and vassals

function joinWar(world, war, civ, side) {
  if (sideOf(war, civ.id) !== 0) return false;
  const list = side > 0 ? war.attackers : war.defenders;
  const foes = side > 0 ? war.defenders : war.attackers;
  list.push(civ.id);
  for (const f of foes) if (world.civs[f]) { rel(world, civ.id, f).lastWarDay = world.time.day; rel(world, f, civ.id).lastWarDay = world.time.day; }
  bumpVersion(world, 'wars');
  return true;
}

function callToArms(world, st, war, ctx) {
  const rng = world.rng;
  const extAllied = hasProviders('allied');
  for (const side of [-1, 1]) {
    const members = (side > 0 ? war.attackers : war.defenders).slice();
    const foes = side > 0 ? war.defenders : war.attackers;
    const foeLeader = leader(world, foes);
    if (!foeLeader) continue;
    for (const mid of members) {
      const m = world.civs[mid];
      if (!m || !m.alive) continue;
      // vassals follow their overlord; an overlord protects a vassal that is attacked
      for (const c of liveCivs(world)) {
        if (c.vassalOf === mid && sideOf(war, c.id) === 0 && !foes.includes(c.id)) joinWar(world, war, c, side);
      }
      if (side < 0 && m.vassalOf != null) {
        const o = world.civs[m.vassalOf];
        if (o && o.alive && sideOf(war, o.id) === 0 && o.id !== foeLeader.id) { joinWar(world, war, o, side); mobilize(world, o, war); }
      }
      // the allies of the member: treaty allies, and realms bound to it by other ties (unions)
      const friends = (m.allies || []).slice();
      if (extAllied) for (const c of liveCivs(world)) if (c.id !== mid && !friends.includes(c.id) && anyOf('allied', world, c.id, mid)) friends.push(c.id);
      for (const al of friends) {
        const c = world.civs[al];
        if (!c || !c.alive || sideOf(war, c.id) !== 0) continue;
        if ((c.allies || []).includes(foeLeader.id) || c.vassalOf != null) continue;   // torn loyalties: stay out
        const bond = !(m.allies || []).includes(al);          // bound by blood or crown, not by treaty
        const ro = rel(world, c.id, mid).opinion ?? 0;
        const weary = c.warWeariness || 0;
        const busy = enemySet(world, c.id).size;
        const defensive = side < 0;
        const excused = weary >= 0.6 || busy >= 2;          // honourable reasons to stay out
        const willing = (bond || ro > 20) && !excused && !rulerHas(c, 'craven');
        const pJoin = bond ? 0.9 : defensive ? 0.85 : 0.4 * (rel(world, c.id, foeLeader.id).opinion < 0 ? 1.5 : 0.5);
        if (willing && rng.chance(pJoin)) {
          joinWar(world, war, c, side);
          mobilize(world, c, war);
          const cap = capitalOf(world, c);
          chronicle(world, {
            cat: 'war', imp: 2, x: cap ? cap.x : null, y: cap ? cap.y : null, civId: c.id, sid: cap ? cap.id : null, icon: 'war',
            key: 'war.joined', ref: { k: 'war', id: war.id }, ...(war.geo && war.geo.seq != null ? { cause: war.geo.seq } : {}),
            text: bond
              ? pickOne(world, [
                `Bound to ${civName(m)} by crown and blood, ${peopleOf(c)} marched with it into ${theWar(war)}.`,
                `${capFirst(civName(c))} would not abandon ${civName(m)}, the realm that shared its throne, and joined ${theWar(war)}.`,
              ])
              : pickOne(world, [
                `Honouring their alliance, ${peopleOf(c)} joined ${theWar(war)} on the side of ${civName(m)}.`,
                `${capFirst(civName(c))} answered the call of its ally ${civName(m)} and declared war on ${civName(foeLeader)}.`,
                `True to its oaths, ${civName(c)} sent its host to stand beside ${civName(m)} in ${theWar(war)}.`,
              ]),
          });
        } else if (!bond && defensive && !excused && (ro <= 20 || rulerHas(c, 'craven'))) {
          betrayal(world, c.id, mid, 'abandon');
        } else if (defensive) {
          const r0 = rel(world, mid, c.id);
          r0.opinion = clamp((r0.opinion || 0) - 8, -100, 100);
        }
      }
    }
  }
  worldWarCheck(world, war);
}

/**
 * A war that draws in six or more nations (two or more a side) holding three fifths of a
 * sizeable humankind becomes a war of the whole world: once per war, at most once a century.
 */
function worldWarCheck(world, war) {
  const g = geoOf(world, war);
  if (g.worldWar) return;
  const sides = [war.attackers, war.defenders].map((ids) => ids.map((id) => world.civs[id]).filter((c) => c && c.alive));
  const n = sides[0].length + sides[1].length;
  if (n < 6 || sides[0].length < 2 || sides[1].length < 2) return;
  const wp = worldPopulation(world);
  if (wp < 150000) return;
  let inArms = 0;
  for (const side of sides) for (const c of side) inArms += civPopulation(world, c);
  if (!(inArms >= 0.6 * wp) || !rateOk(world, 'worldWar', 120 * DAYS_PER_YEAR)) return;
  g.worldWar = true;
  const lead = sides.map((side) => side.slice().sort((a, b) => civPopulation(world, b) - civPopulation(world, a))[0]);
  const share = inArms >= 0.85 * wp ? 'nearly all of humankind' : inArms >= 0.66 * wp ? 'two thirds of humankind' : 'three in five of all people';
  const cap = capitalOf(world, lead[0]);
  chronicle(world, {
    cat: 'war', imp: 5, x: cap ? cap.x : null, y: cap ? cap.y : null, civId: lead[0].id, sid: cap ? cap.id : null, icon: 'war',
    key: 'war.world', ref: { k: 'war', id: war.id }, ...(g.seq != null ? { cause: g.seq } : {}), tags: ['world-war'],
    text: pickOne(world, [
      `${capFirst(theWar(war))} became a war of the whole world: ${countWord(n)} nations and ${share} were now in arms, behind ${civName(lead[0])} and ${civName(lead[1])}.`,
      `One alliance after another was drawn in, until ${theWar(war)} set ${countWord(n)} nations against each other and ${share} lived under the shadow of war.`,
    ]),
  });
}

// ---------------------------------------------------------------------------
// Mobilisation

function armiesOf(world, civId) {
  const out = [];
  for (const a of world.armies) if (a.civId === civId && !(a.flags && a.flags.hunt != null)) out.push(a);
  return out;
}

function mobilize(world, civ, war) {
  if (!civ || !civ.alive) return;
  const towns = townsOf(world, civ);
  if (!towns.length) return;
  const m = modsOf(world, civ);
  const pop = civPopulation(world, civ);
  const manpower = civ.military && finite(civ.military.manpower) && civ.military.manpower > 0 ? civ.military.manpower : pop * 0.03 * m.military;
  const mob = manpower * (0.45 + 0.55 * (civ.traits?.militarism ?? 0.5)) * (1 - 0.6 * (civ.warWeariness || 0));
  const mine = armiesOf(world, civ.id);
  let field = 0;
  for (const a of mine) field += a.strength;
  const maxArmies = clamp(1 + Math.floor(Math.sqrt(towns.length)), 1, MAX_ARMIES);
  if (mine.length >= maxArmies || field >= mob * 0.7) return;
  const raised = civ.flags && civ.flags.levyMonth === Math.floor(world.time.day / DAYS_PER_MONTH) ? civ.flags.levyRaised || 0 : 0;
  const monthCap = Math.max(15, mob * 0.35);
  if (raised >= monthCap) return;
  // stage at the town nearest the enemy
  const enemies = [...enemySet(world, civ.id)].map((id) => world.civs[id]).filter((c) => c && c.alive);
  let stage = towns[0], bd = Infinity;
  for (const s of towns) {
    if (s.siege) continue;
    for (const e of enemies) {
      const cap = capitalOf(world, e);
      if (!cap) continue;
      const d = dist(s.x, s.y, cap.x, cap.y) - Math.sqrt(s.population) * 0.05;
      if (d < bd) { bd = d; stage = s; }
    }
  }
  let str = Math.min(Math.max(mob - field, 12), monthCap - raised, Math.max(20, stage.population * 0.15 + 0.05 * pop));
  const cost = str * 0.25;
  const treasury = finite(civ.treasury) ? civ.treasury : 0;
  if (treasury < cost) str *= Math.max(0.5, treasury / Math.max(1, cost));   // unpaid levies still march
  if (!(str >= 12)) return;
  civ.treasury = Math.max(0, treasury - str * 0.25);
  civ.flags ||= {};
  civ.flags.levyMonth = Math.floor(world.time.day / DAYS_PER_MONTH);
  civ.flags.levyRaised = raised + str;
  // levies leave the towns (most return when the army disbands): whoever the realm's rule calls
  // up, by default the young men; their bands ride with the army (flags.levy) and come home aged
  let drawn = 0;
  const levy = sliceLike(towns[0]);
  for (const s of towns) {
    const take = Math.min(s.population * 0.2, str * 0.6 * s.population / Math.max(1, pop));
    drawn += takePeople(world, s, take, 'levy', levy, civ);
  }
  const gen = recruitGeneral(world, civ);
  const era = eraOf(civ);
  const army = createArmy(world, { civId: civ.id, x: stage.x, y: stage.y, homeId: stage.id, strength: str, warId: war ? war.id : null, general: gen.leader, state: 'idle' });
  // levies take weeks to gather, arm and provision before they can march
  const muster = Math.round((40 + world.rng.next() * 60) / Math.max(0.5, m.movement));
  // merge: the kernel (damageArmy) and other packages may already keep things on flags
  army.flags = Object.assign(army.flags && typeof army.flags === 'object' ? army.flags : {}, {
    mp: 0, skill: gen.leader.skill, genId: gen.genId, startStr: str, drawn, bad: [], nextPlan: world.time.day + muster, war: war ? war.id : null,
    levy: roundSlice(levy), levyDay: world.time.day,
  });
  serviceOf(army);
  army.name = armyName(world, civ, stage, gen.leader, str, era);
}

function armyName(world, civ, s, gen, str, era) {
  const rng = world.rng;
  if (str < 150) return `the ${s.name} ${era === 0 ? 'War Band' : 'Levy'}`;
  const n = armiesOf(world, civ.id).length;
  return rng.pick([
    `the Host of ${s.name}`, `the ${ordinalWord(Math.max(1, n))} ${civAdj(civ)} ${era >= 3 ? 'Legion' : 'Host'}`,
    `the Army of ${s.name}`, `${String(gen.name || 'the General').split(' ')[0]}'s ${era >= 4 ? 'Army' : 'Host'}`, `the ${civAdj(civ)} Vanguard`,
  ]);
}

/**
 * An army leaves the field: armyDisbanded (before removal), its service summary into its war's
 * ledger, the surviving levies home (hired companies were never drawn from the towns), any
 * siege it led lifted. reason: 'peace' | 'home' | 'routed' | 'destroyed' | 'stranded' | 'realm fell' | string.
 */
function disband(world, army, reason = 'home') {
  if (!world.armies.includes(army)) return;
  const st = state(world);
  st.disbanded++;
  emitHook(world, 'armyDisbanded', army, reason);
  const warId = army.warId != null ? army.warId : army.flags ? army.flags.war : null;
  const war = warId != null ? world.wars[warId] : null;
  if (war) archiveArmy(world, war, army, reason);
  const home = world.settlements[army.homeId];
  const civ = world.civs[army.civId];
  let to = home && home.alive && home.civId === army.civId ? home : null;
  if (!to && civ && civ.alive) to = nearestSettlement(world, army.x, army.y, { civId: civ.id });
  // the surviving share of the levies drawn from the towns goes home, to every town of the realm
  // as they were drawn (core/cohorts.js returnLevy)
  const fl = army.flags || {};
  if (to && fl.merc == null && finite(army.strength) && army.strength > 0) {
    const start = finite(fl.startStr) && fl.startStr > 0 ? fl.startStr : army.strength;
    const drawn = finite(fl.drawn) ? fl.drawn : army.strength * 0.6;
    returnLevy(world, to, fl, Math.max(0, drawn * clamp01(army.strength / start)));
  }
  clearSiegeBy(world, army, reason === 'routed' || reason === 'destroyed' ? 'broken' : 'lifted');
  removeArmy(world, army.id);
}

// ---------------------------------------------------------------------------
// Sieges: one registry entry per siege under way, so every siege that ends — however it
// ends — emits siegeEnded exactly once.

function beginSiege(world, s, army) {
  const st = state(world);
  const cur = st.sieges[s.id];
  if (cur && cur[1] === army.civId) { cur[0] = army.id; return; }   // a new lead army takes over the lines
  if (cur) endSiege(world, s, 'lifted');
  st.sieges[s.id] = [army.id, army.civId, world.time.day];
  emitHook(world, 'siegeStarted', { sid: s.id, armyId: army.id, civId: army.civId });
}

/** Close the registry entry of the siege of s and emit siegeEnded. */
function endSiege(world, s, outcome) {
  const st = state(world);
  const cur = st.sieges[s.id];
  if (!cur) return false;
  delete st.sieges[s.id];
  emitHook(world, 'siegeEnded', { sid: s.id, armyId: cur[0], civId: cur[1], outcome, days: Math.max(0, world.time.day - cur[2]) });
  return true;
}

/** Sieges that vanished without an explicit end (transfers, harmony, a fallen besieger). */
function sweepSieges(world, st) {
  for (const k in st.sieges) {
    const s = world.settlements[k];
    const cur = st.sieges[k];
    if (s && s.alive && s.siege && s.siege.civId === cur[1]) continue;
    let outcome = 'lifted';
    if (s && !s.alive && (s.destroyCause === 'razed')) outcome = 'razed';
    else if (s && s.alive && s.civId === cur[1]) outcome = 'captured';
    if (s) endSiege(world, s, outcome);
    else delete st.sieges[k];
  }
}

/** Lift the siege an army leads (it was beaten, it left, or it was stood down). */
function clearSiegeBy(world, army, outcome = 'lifted') {
  const s = army.targetId != null ? world.settlements[army.targetId] : null;
  if (s && s.siege && s.siege.armyId === army.id) {
    // another army still in the lines takes up the siege at once (siegeTick); otherwise it ends
    let other = null;
    for (const a of world.armies) if (a !== army && a.state === 'sieging' && a.targetId === s.id && a.civId === army.civId) { other = a; break; }
    s.siege = null;
    if (!other) endSiege(world, s, outcome);
  }
}

/**
 * Published: lift the siege of settlement s (events, divine acts). Every army in the lines
 * withdraws to regroup. reason 'broken' marks a siege broken by force; anything else lifts it.
 * Returns true if s was under siege.
 */
export function clearSiege(world, s, reason = 'lifted') {
  if (typeof s === 'number') s = world.settlements[s];
  if (!s) return false;
  const was = Boolean(s.siege) || Boolean(state(world).sieges[s.id]);
  for (const a of world.armies) {
    if (a.targetId !== s.id || a.state !== 'sieging') continue;
    a.state = 'idle'; a.path = null; a.targetId = null;
    a.flags ||= {};
    a.flags.nextPlan = world.time.day + 20;
    (a.flags.bad ||= []).push(s.id);
    if (a.flags.bad.length > 12) a.flags.bad.shift();
  }
  s.siege = null;
  endSiege(world, s, reason === 'broken' ? 'broken' : 'lifted');
  return was;
}

// ---------------------------------------------------------------------------
// Planning (targets and paths)

function homeOf(world, army) {
  const h = world.settlements[army.homeId];
  if (h && h.alive && h.civId === army.civId) return h;
  const n = nearestSettlement(world, army.x, army.y, { civId: army.civId });
  if (n) army.homeId = n.id;
  return n;
}

/** A live vision (command_army) the army still follows: { sid?, x, y } or null. */
function liveGoal(world, army) {
  const fl = army.flags;
  const g = fl && fl.divineGoal;
  if (!g || typeof g !== 'object') return null;
  if (!(world.time.day < (fl.goalUntil || 0))) { delete fl.divineGoal; delete fl.goalUntil; return null; }
  if (g.sid != null) {
    const s = world.settlements[g.sid];
    if (!s || !s.alive || s.civId === army.civId) { delete fl.divineGoal; delete fl.goalUntil; return null; }
    return { sid: s.id, x: s.x, y: s.y };
  }
  return Number.isFinite(g.x) && Number.isFinite(g.y) ? { sid: null, x: g.x, y: g.y } : null;
}

function chooseTarget(world, army, civ, enemies) {
  const ax = army.x, ay = army.y;
  const owner = world.f.owner;
  // 0. a vision: the hand of a god drives the host
  const vision = liveGoal(world, army);
  if (vision) {
    if (vision.sid != null) {
      const s = world.settlements[vision.sid];
      return { kind: enemies.has(s.civId) ? 'town' : 'go', id: s.id, x: s.x, y: s.y, vision: true };
    }
    return { kind: 'tile', id: null, x: vision.x, y: vision.y, vision: true };
  }
  // 1. invaders on our soil
  let best = null, bs = 0;
  for (const e of world.armies) {
    if (!enemies.has(e.civId) || (e.flags && e.flags.hunt != null)) continue;
    const ei = Math.round(e.y) * world.W + Math.round(e.x);
    if (owner[ei] !== civ.id) continue;
    const d = dist(ax, ay, e.x, e.y);
    if (d > 28) continue;
    const sc = (e.strength < army.strength * 1.3 ? 3 : 0.8) / (1 + d / 10);
    if (sc > bs) { bs = sc; best = { kind: 'army', id: e.id, x: e.x, y: e.y }; }
  }
  // 2. relieve our besieged towns
  for (const s of townsOf(world, civ)) {
    if (!s.siege) continue;
    const d = dist(ax, ay, s.x, s.y);
    if (d > 40) continue;
    const sc = 3.5 / (1 + d / 10);
    if (sc > bs) { bs = sc; best = { kind: 'relieve', id: s.id, x: s.x, y: s.y }; }
  }
  if (best && bs > 1) return best;
  // 3. enemy towns
  const war = world.wars[army.warId];
  const goal = war && war.geo ? war.geo.goalSid : null;
  const bad = army.flags.bad || [];
  let cands = settlementsNear(world, ax, ay, 32, (s) => enemies.has(s.civId));
  if (!cands.length) {
    cands = [];
    for (const eid of enemies) for (const s of townsOf(world, world.civs[eid])) cands.push(s);
  }
  const nav = modsOf(world, civ).navigation;
  const lmA = world.f.landmass[Math.round(ay) * world.W + Math.round(ax)];
  for (const s of cands) {
    if (bad.includes(s.id)) continue;
    if (world.f.landmass[s.i] !== lmA && nav < 1) continue;
    const ec = world.civs[s.civId];
    const d = dist(ax, ay, s.x, s.y);
    const capBonus = ec && ec.capitalId === s.id ? (d < 15 ? 2 : -0.5) : 0;
    const value = 1 + Math.sqrt(Math.max(0, s.population)) / 20 + Math.max(0, s.wealth || 0) * 0.001
      + capBonus + (s.id === goal ? 3 : 0) + (s.originCivId === civ.id ? 1.5 : 0);
    const fort = 1 + clamp(s.defense || 0, 0, 40) * 0.12 + (s.garrison || 0) / (army.strength + 1);
    const sc = value / (fort * (1 + d / 12)) * (world.f.landmass[s.i] !== lmA ? 0.5 : 1);
    if (sc > bs) { bs = sc; best = { kind: 'town', id: s.id, x: s.x, y: s.y }; }
  }
  return best;
}

function planPath(world, army, toI, civ, peek = false) {
  const { W, f } = world;
  const from = clamp(Math.round(army.y), 0, world.H - 1) * W + clamp(Math.round(army.x), 0, W - 1);
  const nav = (peek ? peekMods(civ) : modsOf(world, civ)).navigation;
  const fromLand = f.water[from] === WATER.LAND;
  const sameLm = fromLand && f.water[toI] === WATER.LAND && f.landmass[from] === f.landmass[toI];
  const d = dist(from % W, (from / W) | 0, toI % W, (toI / W) | 0);
  let path = null;
  if (sameLm) path = findPath(world, from, toI, { mode: 'land', navigation: nav, maxNodes: Math.round(1500 + d * 160), peek });
  // by sea only when the goal lies across water, or the way overland is short but blocked
  if (!path && nav >= 1 && (!sameLm || d < 25)) path = findPath(world, from, toI, { mode: 'amphibious', navigation: nav, maxNodes: sameLm ? 3000 : 6000, peek });
  return path;
}

/** Local winter away from the tropics: armies keep to winter quarters. */
function inWinter(world, y) {
  const lat = latitude(world, clamp(Math.round(y), 0, world.H - 1));
  if (lat <= 0.35 && lat >= -0.35) return false;
  const s = MONTH_SEASON[monthOf(world)];
  return (lat >= 0 ? s : (s + 2) % 4) === 0;
}

/** Enemy armies on our soil near this army, or one of our towns under siege nearby. */
function threatened(world, army, civ, enemies) {
  const owner = world.f.owner, W = world.W;
  for (const e of world.armies) {
    if (!enemies.has(e.civId) || (e.flags && e.flags.hunt != null)) continue;
    if (owner[Math.round(e.y) * W + Math.round(e.x)] === civ.id && dist(army.x, army.y, e.x, e.y) < 30) return true;
  }
  return false;
}

function plan(world, army, st) {
  const civ = world.civs[army.civId];
  if (!civ || !civ.alive) { disband(world, army, 'realm fell'); return; }
  const day = world.time.day;
  if (!army.flags || typeof army.flags !== 'object') army.flags = {};
  army.flags.bad ||= [];
  if (army.state === 'returning' || army.state === 'retreating') {
    const home = homeOf(world, army);
    if (!home) { disband(world, army, 'stranded'); return; }
    if (dist(army.x, army.y, home.x, home.y) < 1.2) {
      if (army.state === 'returning' || enemySet(world, civ.id).size === 0) { disband(world, army, army.state === 'returning' ? 'peace' : 'home'); return; }
      army.state = 'idle';
      army.flags.nextPlan = day + 15;     // regroup before marching again
      return;
    }
    const path = planPath(world, army, home.i, civ);
    if (!path) { disband(world, army, 'stranded'); return; }
    army.path = path.slice(); army.pathStep = 0;
    return;
  }
  const enemies = enemySet(world, civ.id);
  if (!enemies.size) { army.state = 'returning'; army.warId = null; army.path = null; return; }
  const vision = liveGoal(world, army);
  if (!vision && inWinter(world, army.y) && !threatened(world, army, civ, enemies)) { army.flags.nextPlan = day + 30; return; }
  if (army.warId == null || !world.wars[army.warId]?.active) {
    const w = activeWarList(world).find((x) => x.active && sideOf(x, civ.id) !== 0);
    army.warId = w ? w.id : null;
  }
  if (army.warId != null) army.flags.war = army.warId;
  const tgt = chooseTarget(world, army, civ, enemies);
  if (!tgt) { army.flags.nextPlan = day + 30; return; }
  const ti = clamp(Math.round(tgt.y), 0, world.H - 1) * world.W + clamp(Math.round(tgt.x), 0, world.W - 1);
  const path = planPath(world, army, ti, civ);
  if (!path) {
    if (tgt.vision) { delete army.flags.divineGoal; delete army.flags.goalUntil; }
    else if (tgt.kind === 'town') { army.flags.bad.push(tgt.id); if (army.flags.bad.length > 12) army.flags.bad.shift(); }
    army.flags.nextPlan = day + 10;
    return;
  }
  army.path = path.slice();
  army.pathStep = 0;
  army.state = 'marching';
  army.targetId = tgt.kind === 'army' || tgt.kind === 'tile' ? null : tgt.id;
  army.flags.tArmy = tgt.kind === 'army' ? tgt.id : null;
  army.flags.tx = tgt.x; army.flags.ty = tgt.y;
  army.flags.lastPlan = day;
}

// ---------------------------------------------------------------------------
// Daily movement, supply and attrition

/**
 * Every loss an army takes: through the kernel's damageArmy (which keeps flags.loss by cause),
 * then the war's casualty rolls and the army's service record. Returns the men lost.
 */
function casualty(world, army, n, src, tally = true) {
  const d = damageArmy(world, army, n, src);
  if (!(d > 0)) return 0;
  noteLoss(army, d, src);
  const war = tally && army.warId != null ? world.wars[army.warId] : null;
  if (war && war.active) {
    const g = geoOf(world, war);
    g.monthCas[army.civId] = (g.monthCas[army.civId] || 0) + d;
    war.casualties[army.civId] = (war.casualties[army.civId] || 0) + d;
  }
  return d;
}

function move(world, army, grid) {
  const { W, f } = world;
  const civ = world.civs[army.civId];
  const m = modsOf(world, civ);
  const p = army.path;
  const fl = army.flags;
  if (p && army.pathStep < p.length - 1) {
    const ox = army.x, oy = army.y;
    const cur = p[army.pathStep];
    const atSea = f.water[cur] !== WATER.LAND;
    let speed = BASE_SPEED * m.movement * (0.6 + 0.4 * clamp01(army.supply));
    if (atSea) speed *= 2.2 * (m.navigation >= 2 ? 1.25 : 1);
    if (!atSea && inWinter(world, army.y)) speed *= 0.6;
    let step = army.pathStep, cost = 1;
    const last = p.length - 1;
    // movement points carry over, but never beyond what the next (possibly rugged) step needs
    const nx0 = p[step + 1];
    const need = f.water[nx0] !== WATER.LAND ? 1 : (grid.land[nx0] > 0 ? grid.land[nx0] : 2) * SQRT2;
    fl.mp = Math.min(Math.max(3, need), (fl.mp || 0) + speed);
    while (step < last) {
      const nx = p[step + 1];
      cost = f.water[nx] !== WATER.LAND ? 1 : (grid.land[nx] > 0 ? grid.land[nx] : 2);
      const a = p[step];
      if ((a % W) !== (nx % W) && ((a / W) | 0) !== ((nx / W) | 0)) cost *= SQRT2;
      if (fl.mp < cost) break;
      fl.mp -= cost;
      step++;
      trample(world, army, nx);
    }
    army.pathStep = step;
    const i0 = p[step];
    let x = i0 % W, y = (i0 / W) | 0;
    if (step < last) {
      const t = clamp01(fl.mp / cost);
      const i1 = p[step + 1];
      x += ((i1 % W) - x) * t; y += (((i1 / W) | 0) - y) * t;
    }
    army.x = x; army.y = y;
    army.naval = f.water[i0] !== WATER.LAND;
    const moved = Math.hypot(x - ox, y - oy);
    if (moved > 0 && moved < 20) { const l = serviceOf(army); l.distance = Math.round((l.distance + moved) * 10) / 10; }
  }
  // supply, forage and attrition
  const ti = clamp(Math.round(army.y), 0, world.H - 1) * W + clamp(Math.round(army.x), 0, W - 1);
  const own = f.owner[ti];
  const friendly = own === army.civId || (civ && (civ.allies || []).includes(own));
  let sup = finite(army.supply) ? army.supply : 1;
  if (army.naval) sup -= 0.004;
  else if (friendly) sup += 0.04;
  else sup += clamp01(f.farm[ti] * 0.8 + f.veg[ti] * 0.3) * 0.02 - 0.012;
  army.supply = clamp01(sup);
  let attr = 0.0002 + 0.001 * (1 - army.supply);
  if (!army.naval && f.temp[ti] < -5) attr += 0.0008;
  if (!army.naval && f.biome[ti] === BIOME.HOT_DESERT) attr += 0.0006;
  let sick = 0;
  if (fl.plague != null) {
    sick = 0.002;
    // camp fever runs its course in a few months, or ends with the plague itself
    const pl = world.plagues[fl.plague];
    if (!pl || !pl.active || world.rng.chance(0.012)) fl.plague = null;
  }
  const s0 = army.strength;
  casualty(world, army, s0 * attr, 'attrition');
  if (sick > 0) casualty(world, army, s0 * sick, 'plague');
  const mt = 0.45 + 0.55 * army.supply;
  army.morale = clamp((finite(army.morale) ? army.morale : 1) + (mt - army.morale) * 0.03, 0.05, 1.2);
}

function trample(world, army, i) {
  const f = world.f;
  if (f.water[i] !== WATER.LAND) return;
  const enemyLand = f.owner[i] >= 0 && f.owner[i] !== army.civId && areAtWar(world, army.civId, f.owner[i]);
  const size = Math.min(2, army.strength / 800);
  f.devastation[i] = Math.min(1, f.devastation[i] + (enemyLand ? 0.015 : 0.003) * size);
}

// ---------------------------------------------------------------------------
// Battles

function terrainBonus(world, army, i) {
  const f = world.f;
  if (f.water[i] !== WATER.LAND) return 1;
  let b = 1;
  const e = f.elevation[i];
  if (e >= 0.75) b *= 1.45; else if (e >= 0.62) b *= 1.25;
  const bi = f.biome[i];
  if (bi === BIOME.TEMPERATE_FOREST || bi === BIOME.TAIGA || bi === BIOME.RAINFOREST || bi === BIOME.TEMPERATE_RAINFOREST || bi === BIOME.TROPICAL_FOREST) b *= 1.12;
  if (bi === BIOME.WETLAND) b *= 1.1;
  if (f.river[i] >= 2) b *= 1.15;
  const sid = f.settle[i];
  if (sid >= 0) {
    const s = world.settlements[sid];
    if (s && s.alive && s.civId === army.civId) b *= 1 + 0.08 * clamp(s.defense || 0, 0, 20);
  }
  return b;
}

function battle(world, st, A, B) {
  const rng = world.rng;
  const day = world.time.day;
  const W = world.W;
  const ca = world.civs[A.civId], cb = world.civs[B.civId];
  if (!ca || !cb) return;
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
  const i = clamp(Math.round(my), 0, world.H - 1) * W + clamp(Math.round(mx), 0, W - 1);
  const owner = world.f.owner[i];
  const naval = A.naval && B.naval;
  const ma = modsOf(world, ca), mb = modsOf(world, cb);
  const homeA = owner === A.civId || (ca.allies || []).includes(owner);
  const homeB = owner === B.civId || (cb.allies || []).includes(owner);
  const ext = hasProviders('battle');
  const eff = (army, m, civ, other, enemy, home) => {
    let e = army.strength * m.military * (0.4 + 0.6 * clamp01(army.morale)) * (0.55 + 0.45 * clamp01(army.supply));
    e *= finite(army.flags?.skill) ? army.flags.skill : 1;
    e *= 1 + 0.15 * (eraOf(civ) - eraOf(other));
    if (naval) e *= 1 + 0.25 * m.navigation;
    else if (army.naval) e *= 0.6;                 // caught while landing
    if (home) e *= terrainBonus(world, army, i);
    if (ext) e *= mulOf('battle', world, { army, enemy, i, side: home ? 'defender' : 'attacker' });
    return Math.max(0.01, e * rng.float(0.7, 1.35));
  };
  const engaged = A.strength + B.strength;
  const eA = eff(A, ma, ca, cb, B, homeA), eB = eff(B, mb, cb, ca, A, homeB);
  const pA = eA / (eA + eB);
  const [Wn, L, cw, cl] = pA >= 0.5 ? [A, B, ca, cb] : [B, A, cb, ca];
  const d = Math.abs(pA - 0.5) * 2;
  const lossL = clamp(0.08 + 0.3 * d + rng.next() * 0.08, 0.04, 0.7);
  const lossW = clamp(0.03 + 0.1 * (1 - d) + rng.next() * 0.04, 0.02, 0.3);
  const deadL = casualty(world, L, L.strength * lossL, 'battle');
  const deadW = casualty(world, Wn, Wn.strength * lossW, 'battle');
  L.morale = clamp(L.morale - (0.25 + 0.35 * d), 0.05, 1.2);
  Wn.morale = clamp(Wn.morale + 0.08, 0.05, 1.2);
  L.flags.battleDay = Wn.flags.battleDay = day;
  noteFight(Wn, true, deadL);
  noteFight(L, false, deadW);
  const killed = deadL + deadW;
  st.battles++;
  // the leaders: a fallen general is remembered; the victor's grows in fame
  const wName = leaderName(Wn), lName = leaderName(L);
  let fallen = null, fallenSide = null;
  if (rng.chance(0.1) && L.general) { fallen = lName; fallenSide = cl; }
  else if (rng.chance(0.03) && Wn.general) { fallen = wName; fallenSide = cw; }
  // war score and bookkeeping
  const sizeF = clamp(Math.sqrt(killed) / 15, 0.4, 2.2);
  let war = null;
  for (const w of activeWarList(world)) {
    if (!w.active) continue;
    const sw = sideOf(w, Wn.civId), sl = sideOf(w, L.civId);
    if (sw === 0 || sl === 0 || sw === sl) continue;
    const gw = geoOf(world, w);
    gw.bat = clamp((gw.bat || 0) + sw * (0.8 + 4 * d) * sizeF, -35, 35);
    rescore(world, w);
    w.battles = (w.battles || 0) + 1;
    if (!war || w.id === Wn.warId) war = w;
  }
  // the field is ruined
  const f = world.f;
  const x0 = i % W, y0 = (i / W) | 0;
  const dv = 0.05 + 0.2 * Math.min(1, killed / 2000);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = x0 + dx, y = y0 + dy;
    if (x < 0 || y < 0 || x >= W || y >= world.H) continue;
    const j = y * W + x;
    if (f.water[j] === WATER.LAND) f.devastation[j] = Math.min(1, f.devastation[j] + dv * (dx || dy ? 0.5 : 1));
  }
  emitFx(world, { type: 'battle', x: mx, y: my, intensity: clamp01(0.2 + killed / 3000) });
  const rout = L.morale < 0.2 || lossL > 0.5 || L.strength < 20;
  // chronicle: great battles always, others at most once a season per war
  const { site, land, alts } = siteName(world, mx, my);
  const wp = worldPopulation(world);
  const great = killed >= Math.max(2500, 0.0015 * wp) || engaged >= Math.max(40000, 0.012 * wp) || (rout && killed >= 1500);
  const notable = great || engaged > 3000 || (fallen && engaged > 600);
  let bname = null, entry = null;
  if (war) {
    const g = geoOf(world, war);
    const record = engaged >= 60 && (great || day - g.lastNote > 150);
    if (record) bname = battleName(world, st, alts, my);
    g.log.push({ name: bname || `a skirmish at ${site}`, day, x: Math.round(mx), y: Math.round(my), winner: cw.id, loser: cl.id, dead: Math.round(killed) });
    if (g.log.length > 16) g.log.shift();
    noteBattle(world, war, { day, x: mx, y: my, winner: cw.id, loser: cl.id, dead: killed, name: bname });
    if (record) {
      g.lastNote = day;
      const text = battleProse(world, { site, land, bname, naval, W: Wn, L, cw, cl, killed, rout, d, fallen, fallenAdj: fallenSide ? civAdj(fallenSide) : null, total: engaged, wName, y: my });
      const key = great ? 'battle.great' : notable ? 'battle' : 'battle.minor';
      entry = chronicle(world, {
        cat: 'war', imp: great ? 3 : notable ? 2 : 1, text, x: Math.round(mx), y: Math.round(my), civId: cw.id, sid: null, icon: 'battle',
        key, ref: { k: 'war', id: war.id }, ...(g.seq != null ? { cause: g.seq } : {}), tags: naval ? ['naval'] : rout ? ['rout'] : undefined,
      });
      const wf = figureById(world, Wn.flags.genId);
      if (wf && wf.died == null) { wf.deeds = (wf.deeds || []).concat(`won ${bname}`).slice(-12); wf.wins = (wf.wins | 0) + 1; wf.battles = (wf.battles | 0) + 1; }
      const lf = figureById(world, L.flags.genId);
      if (lf && lf.died == null) { lf.deeds = (lf.deeds || []).concat(`lost ${bname}`).slice(-12); lf.battles = (lf.battles | 0) + 1; }
    }
  }
  // the hook: one plain payload per battle
  const kind = naval ? 'naval' : (A.state === 'sieging' || B.state === 'sieging' || f.settle[i] >= 0) ? 'siege' : 'field';
  const attFirst = war ? sideOf(war, A.civId) >= 0 : true;
  const [att, def] = attFirst ? [A, B] : [B, A];
  emitHook(world, 'battle', {
    day, x: Math.round(mx * 10) / 10, y: Math.round(my * 10) / 10, i, warId: war ? war.id : null, kind,
    attackerId: att.civId, defenderId: def.civId, winnerCivId: cw.id, loserCivId: cl.id,
    dead: { a: Math.round(att === L ? deadL : deadW), d: Math.round(def === L ? deadL : deadW) },
    engaged: Math.round(engaged), name: bname, great, seq: entry ? entry.seq : null,
  });
  // the commanders' fortunes
  if (fallen) killGeneral(world, fallenSide === cl ? L : Wn, bname || `a fight at ${site}`, entry);
  // fame: a great victory, or a third real win (a fight of hosts, not of war bands) crowned by
  // a battle men give a name to
  const g0 = Wn.general;
  if (g0 && typeof g0 === 'object') {
    g0.battles = (g0.battles | 0) + 1;
    if (engaged >= 500 || bname) g0.wins = (g0.wins | 0) + 1;
    if (bname) g0.honours = (g0.honours | 0) + 1;
    const decisive = great && d > 0.3 && engaged >= 3500;
    if (Wn.flags.genId == null && bname && (decisive || (g0.wins >= PROMOTE_WINS && g0.honours >= 2))) promoteGeneral(world, st, Wn, cw, decisive ? 'great' : 'wins', bname, entry ? entry.seq : null);
  }
  if (L.general && typeof L.general === 'object') L.general.battles = (L.general.battles | 0) + 1;
  // the town whose siege this victory breaks remembers who saved it (memory.js)
  const relieved = L.state === 'sieging' && L.targetId != null ? world.settlements[L.targetId] : null;
  if (relieved && relieved.alive && relieved.siege && relieved.siege.armyId === L.id) remember(world, relieved, Wn.civId, 0.4, 'r');
  if (rout) {
    if (L.strength > 40 && rng.chance(0.4)) { L.state = 'retreating'; L.path = null; clearSiegeBy(world, L, 'broken'); L.targetId = null; L.flags.nextPlan = 0; }
    else { casualty(world, L, L.strength * 0.5, 'battle', false); disband(world, L, 'routed'); }   // the routed scatter
  } else {
    clearSiegeBy(world, L, 'broken');
    L.state = 'retreating'; L.path = null; L.targetId = null; L.flags.nextPlan = 0;
  }
}

/** A commander falls: a great general dies as a figure (figureDied); a plain leader is simply gone. */
function killGeneral(world, army, where, entry) {
  const fig = figureById(world, army.flags.genId);
  if (fig && fig.died == null) {
    fig.died = world.time.day;
    fig.deeds = (fig.deeds || []).concat(`fell at ${where}`).slice(-12);
    fig.endCause = 'battle';
    emit(world, 'figureDied', fig);
  }
  army.general = null;
  army.flags.genId = null;
  army.flags.skill = 0.9;
  void entry;
}

function battleProse(world, b) {
  const { site, land, bname, naval, W: Wn, L, cw, cl, killed, rout, d, fallen, fallenAdj, wName, y } = b;
  const era = Math.max(eraOf(cw), eraOf(cl));
  const hw = hostWord(Wn.strength + killed, era), hl = hostWord(L.strength + killed, era);
  const gW = wName ? ` under ${wName}` : '';
  const adjW = civAdj(cw), adjL = civAdj(cl);
  const dead = fmtCount(killed);
  const season = seasonWord(world, y);
  const outcome = rout ? pickOne(world, ['broke and fled', 'was scattered to the winds', 'was cut to pieces']) : d > 0.4 ? pickOne(world, ['was driven from the field', 'fell back in disorder']) : pickOne(world, ['withdrew in good order', 'gave ground after a long day']);
  const fallenClause = fallen ? pickOne(world, [` The ${fallenAdj ? fallenAdj + ' ' : ''}general ${fallen} fell in the fighting.`, ` ${fallen}, who led the ${fallenAdj || ''} host, was among the slain.`.replace('  ', ' ')]) : '';
  let text;
  if (naval) {
    text = pickOne(world, [
      `The fleets of ${civName(cw)} and ${civName(cl)} met in ${bname}; the ${adjL} ships ${rout ? 'were sunk or scattered' : 'were driven off'}, and ${dead} sailors drowned.`,
      `Off ${site} the ${adjW} navy${gW} burned the ships of ${civName(cl)}; ${dead} men went down with them.`,
      `In ${bname}, fought in the ${season} swell, ${civName(cw)} won the mastery of the sea; ${dead} of the ${adjL} crews never came home.`,
    ]);
  } else {
    const T = {
      fords: [`At ${site} the ${adjW} ${hw}${gW} forced the crossing, and the ${adjL} ${hl} ${outcome}, leaving ${dead} dead in the reeds.`],
      hills: [`At ${site} the ${adjW} ${hw}${gW} stormed the heights; the ${adjL} ${hl} ${outcome}, and ${dead} fell on the slopes.`],
      pass: [`In ${site} the ${adjL} ${hl} was trapped between the rocks by ${peopleOf(cw)}${gW}; it ${outcome}, and ${dead} perished.`],
      marsh: [`The ${adjL} ${hl} floundered in ${site} as ${peopleOf(cw)} fell upon it; it ${outcome}, and ${dead} drowned or died.`],
      wood: [`${capFirst(peopleOf(cw))}${gW} ambushed the ${adjL} ${hl} in ${site}; it ${outcome}, and ${dead} died beneath the trees.`],
      sands: [`Under a burning sky at ${site}, the ${adjW} ${hw}${gW} crushed the ${adjL} ${hl}; ${dead} lay dead in the dunes.`],
      snows: [`At ${site} the ${adjW} ${hw}${gW} broke the ${adjL} ${hl} in driving snow; ${dead} froze where they fell.`],
      shore: [`At ${site} the ${adjW} ${hw}${gW} drove the ${adjL} ${hl} into the surf; it ${outcome}, and ${dead} were lost.`],
      field: [
        `${/^the |Plain$|Field$/.test(site) ? `On ${site}` : `On the field of ${site}`} the ${adjW} ${hw}${gW} met the ${adjL} ${hl}, which ${outcome}; ${dead} lay dead by nightfall.`,
        `${capFirst(bname)} ended in ${rout ? 'a rout' : d > 0.4 ? 'a decisive victory' : 'a bloody, narrow victory'} for ${civName(cw)}${gW ? ' and' + gW.replace(' under', '') : ''}; ${dead} died.`,
        `In the ${season} of Year ${Math.floor(world.time.day / DAYS_PER_YEAR)} the ${adjL} ${hl} gave battle near ${site} and ${outcome}; ${dead} were left on the field.`,
      ],
    };
    const pool = T[land] || T.field;
    text = pickOne(world, pool.concat([`${capFirst(bname)} went to ${civName(cw)}${gW}: the ${adjL} ${hl} ${outcome}, and ${dead} were slain.`]));
  }
  return text + fallenClause;
}

const rested = (army, day) => !(day - (army.flags && finite(army.flags.battleDay) ? army.flags.battleDay : -1e9) < BATTLE_REST);
const hunting = (a) => Boolean(a.flags && a.flags.hunt != null);

function battles(world, st) {
  const arr = world.armies;
  if (arr.length < 2) return;
  const day = world.time.day;
  const atWar = civsAtWar(world);
  for (let i = 0; i < arr.length; i++) {
    const A = arr[i];
    if (!atWar.has(A.civId) || hunting(A) || !rested(A, day)) continue;
    for (let j = i + 1; j < arr.length; j++) {
      const B = arr[j];
      if (A.civId === B.civId || hunting(B) || !rested(B, day)) continue;
      const dx = A.x - B.x, dy = A.y - B.y;
      if (dx * dx + dy * dy > BATTLE_R2) continue;
      if (!areAtWar(world, A.civId, B.civId)) continue;
      if (A.naval !== B.naval && !(A.state === 'sieging' || B.state === 'sieging')) continue;   // ships pass armies by
      battle(world, st, A, B);
      break;
    }
  }
  // remove armies destroyed in battle (disband already removed most)
  for (const a of arr.slice()) if (!hunting(a) && !(a.strength >= 8)) disband(world, a, 'destroyed');
}

// ---------------------------------------------------------------------------
// Sieges

function siegeTick(world, st, army, idx) {
  const s = army.targetId != null ? world.settlements[army.targetId] : null;
  const day = world.time.day;
  if (!s || !s.alive || s.civId === army.civId || !areAtWar(world, army.civId, s.civId)) {
    if (s && s.siege && s.siege.armyId === army.id) { s.siege = null; endSiege(world, s, 'lifted'); }
    army.state = 'idle'; army.targetId = null; army.path = null;
    return;
  }
  if (dist(army.x, army.y, s.x, s.y) > 1.6) {
    if (s.siege && s.siege.armyId === army.id) clearSiegeBy(world, army, 'lifted');
    army.state = 'idle'; army.path = null;
    return;
  }
  // One siege per town: the first army to invest it leads, later arrivals reinforce its lines.
  let lead = s.siege ? idx.byId.get(s.siege.armyId) : null;
  if (!lead || lead.state !== 'sieging' || lead.targetId !== s.id) {
    s.siege = { armyId: army.id, civId: army.civId, progress: s.siege ? (s.siege.progress || 0) * 0.5 : 0, startDay: s.siege && finite(s.siege.startDay) ? s.siege.startDay : day };
    lead = army;
    beginSiege(world, s, army);
  }
  // every army in the lines suffers the camp's privations
  casualty(world, army, army.strength * 0.0007, 'attrition');
  if (s.disease && army.flags.plague == null && world.rng.chance(0.02)) army.flags.plague = s.disease.pid;
  else if (army.flags.plague != null && !s.disease && world.rng.chance(0.01)) expose(world, s, army.flags.plague, { kind: 'army', civId: army.civId });
  if (lead !== army) return;
  const def = world.civs[s.civId];
  const md = modsOf(world, def);
  const ext = hasProviders('siege');
  let power = 0, navy = 0;
  for (const a of idx.lines.get(s.id) || [army]) {
    if (a.state !== 'sieging' || a.targetId !== s.id || !areAtWar(world, a.civId, s.civId)) continue;
    const ma = modsOf(world, world.civs[a.civId]);
    let p = a.strength * ma.siege * (finite(a.flags?.skill) ? a.flags.skill : 1) * (0.5 + 0.5 * clamp01(a.morale));
    if (ext) p *= mulOf('siege', world, { army: a, s });
    power += p;
    if (ma.navigation > navy) navy = ma.navigation;
  }
  const isCap = def && def.capitalId === s.id;
  // the town's own effects (a blessing on its walls, a curse on its gates) add to its defences
  const sdef = settlementMods(world, s).defense;
  const hold = (25 + Math.max(0, s.garrison || 0) + Math.max(0, s.population) * 0.05) * md.defense * (isCap ? 1.3 : 1) * Math.max(0.5, 1 + sdef);
  const fort = (1 + 0.6 * clamp((s.defense || 0) + 4 * sdef, 0, 20)) * (isCap ? 1.4 : 1);
  // a few months against a stockade, a year or more against the walls of a capital
  let rate = 0.0004 + 0.0055 * power / (power + hold * fort);
  if (!(s.food > 0)) rate *= 1.4;                       // starved into surrender
  if (s.harbor && navy < 1) rate *= 0.7;                // supplied from the sea
  // what the town remembers of the besieger (memory.js): it holds out against a realm it hates,
  // and may open its gates to one it remembers kindly when it is cold to its own crown
  if (s.mem && s.mem.length) {
    const m = memoryOf(world, s, army.civId);
    if (m < 0) rate *= Math.max(0.6, 1 + 0.5 * m);
    else if (m >= 0.3 && (memoryOf(world, s, s.civId) <= -0.2 || s.loyalty < 0.3) && world.rng.chance(0.03 * m / DAYS_PER_MONTH)) {
      st.gates = (st.gates || 0) + 1;
      capture(world, st, army, s, { gates: true });
      return;
    }
  }
  s.siege.progress = clamp01((s.siege.progress || 0) + rate);
  s.food = Math.max(0, (s.food || 0) - s.population * 0.006);
  if (finite(s.garrison)) s.garrison *= 0.997;
  if ((day + army.id) % 8 === 0) emitFx(world, { type: 'siege', x: s.x, y: s.y });
  if (s.siege.progress >= 1) capture(world, st, army, s);
}

function capture(world, st, army, s, opts = {}) {
  const rng = world.rng;
  const gates = opts.gates === true;   // the town opened its gates (siegeTick): taken without a sack
  const day = world.time.day;
  const att = world.civs[army.civId];
  const oldId = s.civId;
  const old = world.civs[oldId];
  if (!att || !att.alive || !old) return;
  const war = warBetween(world, att.id, oldId, army.warId);
  const g = war ? geoOf(world, war) : null;
  const side = war ? sideOf(war, att.id) : 0;
  const l = serviceOf(army);
  // The crown storms the rebels' seat: the rising is over. The civ module's warEnded hook
  // restores the rebel towns to the realm and writes the line.
  if (war && civModuleWar(world, war) && side < 0 && sideOf(war, oldId) > 0 && (old.settlementIds.length <= 1 || old.capitalId === s.id)) {
    g.endReason = 'crushed';
    st.captures++;
    l.captures++;
    emitFx(world, { type: 'capture', x: s.x, y: s.y, civId: att.id });
    s.siege = null;
    endSiege(world, s, 'captured');
    damageSettlement(world, s, { pop: 0.04 + rng.next() * 0.06, wealth: 0.25, food: 0.3, defense: 0.5, cause: 'sack' });
    if (war.active) makePeace(world, st, war, 'defenders');
    army.state = 'returning'; army.targetId = null; army.path = null;
    return;
  }
  const siegeDays = s.siege ? day - (s.siege.startDay ?? day) : 0;
  const wasCapital = old.capitalId === s.id;
  // standing of what falls, judged before the transfer (sets the chronicle's importance)
  const wp = worldPopulation(world);
  const oldPopBefore = civPopulation(world, old);
  let rivalPop = 0, biggestOther = 0;
  for (const c of liveCivs(world)) if (c.id !== old.id) rivalPop = Math.max(rivalPop, civPopulation(world, c));
  for (const o of liveSettlements(world)) if (o.id !== s.id && o.population > biggestOther) biggestOther = o.population;
  const wasLeading = oldPopBefore > rivalPop && oldPopBefore > 0.12 * wp;
  const greatestCity = s.population > biggestOther && s.population >= 20000;
  const share = clamp01(Math.max(0, s.population) / Math.max(1, civPopulation(world, old)));
  const gain = 4 + 70 * share + (wasCapital ? 12 : 0);
  const loot = Math.max(0, s.wealth || 0) * 0.3;
  att.treasury = (finite(att.treasury) ? att.treasury : 0) + loot;
  // raze or sack?
  const fa = faithOf(world, att.stateReligion);
  const holy = g && g.cb === 'holy' && fa && fa.tenets.includes('militant') && (s.dominantReligion !== fa.id);
  const grievance = rel(world, att.id, oldId).grievance || 0;
  let pRaze = 0.03 + (rulerHas(att, 'cruel') ? 0.22 : 0) + (holy ? 0.15 : 0) + (grievance > 60 ? 0.12 : 0) + (eraOf(att) === 0 ? 0.04 : 0);
  if ((s.tier || 0) >= 5 || rulerHas(att, 'just')) pRaze *= 0.3;
  // what the town remembers of its taker (memory.js), and whether this is its old realm come back
  const priorGrudge = Math.min(0, memoryOf(world, s, att.id));
  const freed = !gates && (s.originCivId === att.id || claimOf(world, att, s.id) >= 0.2);
  const thanks = gates ? (s.mem || []).find((m) => m[0] === att.id) : null;   // the memory that opened the gates
  const assim = finite(s.flags?.assim) ? s.flags.assim : 0;
  const name = s.name, popBefore = s.population;
  const wn = war ? theWar(war) : 'the war';
  const ruler = rulerName(att);
  const gName = leaderName(army);
  const fig = figureById(world, army.flags.genId);
  st.captures++;
  l.captures++;
  emitFx(world, { type: 'capture', x: s.x, y: s.y, civId: att.id });
  // scorched country around the walls
  const f = world.f, W = world.W;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= world.H) continue;
    const j = y * W + x;
    if (f.water[j] === WATER.LAND) f.devastation[j] = Math.min(1, f.devastation[j] + 0.12);
  }
  const r = rel(world, oldId, att.id);
  const cause = g && g.seq != null ? { cause: g.seq } : {};
  if (!gates && rng.chance(pRaze)) {
    st.razed++;
    // the towns around remember who razed their neighbour
    for (const t of settlementsNear(world, s.x, s.y, 8)) if (t.id !== s.id && (t.civId === oldId || t.originCivId === s.originCivId)) remember(world, t, att.id, -0.4, 'z');
    r.grievance = Math.min(100, (r.grievance || 0) + 25 + (s.tier || 0) * 3);
    if (war) { g.razed = clamp((g.razed || 0) + side * gain * 0.6, -60, 60); rescore(world, war); noteTransfer(world, war, s.id, oldId, -1, 'razed'); }
    const text = pickOne(world, [
      `${capFirst(peopleOf(att))} stormed ${name} after ${spanPhrase(siegeDays)} and razed it to the ground; of ${fmtCount(popBefore)} souls, few survived.`,
      `${ruler ? ruler : capFirst(civName(att))} ordered ${name} burned and its walls thrown down; the city was never seen again.`,
      `${capFirst(name)} fell to ${civName(att)} in ${wn}, and the victors left nothing standing but ash.`,
      `When ${name} fell at last${gName ? ` to ${gName}` : ''}, ${peopleOf(att)} sowed its fields with salt and left its streets to the crows.`,
    ]);
    const rimp = (s.tier || 0) >= 5 || (wasCapital && old.settlementIds.length >= 5) ? 4 : (s.tier || 0) <= 1 && !wasCapital ? 2 : 3;
    const re = chronicle(world, { cat: 'war', imp: rimp, text, x: s.x, y: s.y, civId: att.id, sid: s.id, icon: 'raze', key: 'war.razed', ref: war ? { k: 'war', id: war.id } : { k: 'settlement', id: s.id }, ...cause, tags: ['razed'] });
    (s.flags ||= {}).fallSeq = re.seq;   // the razing, for what rises from the ruins later
    if (fig && fig.died == null) fig.deeds = (fig.deeds || []).concat(`razed ${name}`).slice(-12);
    s.siege = null;
    endSiege(world, s, 'razed');
    destroySettlement(world, s.id, 'razed');
  } else {
    if (!gates) damageSettlement(world, s, { pop: 0.06 + rng.next() * 0.12 + (rulerHas(att, 'cruel') ? 0.1 : 0), wealth: 0.35, food: 0.5, buildings: 0.15, defense: 0.6, cause: 'sack' });
    if (!s.alive) { endSiege(world, s, 'razed'); return; }
    if (g && g.occupied[s.id] == null) g.occupied[s.id] = oldId;
    if (war && !war.captured.includes(s.id)) war.captured.push(s.id);
    r.grievance = Math.min(100, (r.grievance || 0) + 6 + (s.tier || 0) * 2);
    if (wasCapital) { s.flags ||= {}; s.flags.wasCapital = oldId; }
    endSiege(world, s, 'captured');
    transferSettlement(world, s.id, att.id, gates ? 'defection' : 'conquest');
    if (war) { rescore(world, war); noteTransfer(world, war, s.id, oldId, att.id, 'cap'); }
    // the town remembers: a sack, its old realm come back for it, or the gates it opened
    if (gates) remember(world, s, att.id, 0.1, 'g');
    else if (freed) remember(world, s, att.id, 0.4 * (1 - assim) - 0.15, 'f');
    else remember(world, s, att.id, -0.5, 'k');
    if (priorGrudge < 0) s.unrest = Math.max(s.unrest, 0.25 - 0.3 * priorGrudge);
    s.garrison = Math.max(s.garrison || 0, army.strength * 0.15);
    army.strength *= 0.85;   // the garrison stays behind (not a loss)
    const fallen = !old.alive;
    const text = gates ? gatesText(world, s, att, old, wn, thanks) : fallen
      ? pickOne(world, [
        `With the fall of ${name}, the last stronghold of ${peopleOf(old)}, ${civName(old)} passed from history into the hands of ${civName(att)}.`,
        `${capFirst(civName(att))} took ${name} after ${spanPhrase(siegeDays)}, and with it the last of ${civName(old)}.`,
        `The banners of ${civName(att)} rose over ${name}; nothing was left of ${civName(old)} but its songs.`,
      ])
      : wasCapital
        ? pickOne(world, [
          `${capFirst(name)}, the capital of ${civName(old)}, fell to ${civName(att)} after ${spanPhrase(siegeDays)} of siege, and its palaces were plundered.`,
          `The ${civAdj(att)} ${hostWord(army.strength, eraOf(att))}${gName ? ' under ' + gName : ''} breached the walls of ${name} and seized the seat of ${civName(old)}.`,
          `After ${spanPhrase(siegeDays)} behind its walls, ${name} opened its gates to ${civName(att)}; the court of ${civName(old)} fled into the night.`,
        ])
        : pickOne(world, [
          `After a siege of ${spanPhrase(siegeDays)}, ${peopleOf(att)} stormed ${name} and put it to the sack.`,
          `${capFirst(name)} surrendered to ${civName(att)}${gName ? ` and its general ${gName}` : ''} after ${spanPhrase(siegeDays)}, starving behind its walls.`,
          `${capFirst(civName(att))} captured ${name} from ${civName(old)} in ${wn}.`,
        ]);
    // the end of a realm is always worth a line; a great one is historic
    const greatFall = fallen && ((old.peakPopulation || 0) > Math.max(20000, 0.04 * worldPopulation(world)) || (old.peakTerritory || 0) > 400);
    // a major realm's first lost seat in half a century is historic; the seat of the world's
    // leading power, its greatest city, or the end of a realm that once held a fifth of
    // humankind is epochal
    const lastSeatFall = old.flags.seatFallDay ?? -1e9;
    if (wasCapital) old.flags.seatFallDay = day;
    const greatSeat = wasCapital && (oldPopBefore > Math.max(60000, 0.1 * wp) || old.settlementIds.length >= 12)
      && day - lastSeatFall > 50 * DAYS_PER_YEAR;
    const epochalSeat = wasCapital && !fallen && (wasLeading || greatestCity) && rateOk(world, 'epochalSeat', 60 * DAYS_PER_YEAR);
    const epochalFall = fallen && (old.peakPopulation || 0) >= Math.max(40000, 0.2 * wp);
    // a lost seat is major news only for a realm of some size (six towns or more before the fall)
    const imp = epochalSeat || epochalFall ? 5 : greatFall || greatSeat ? 4 : fallen || (wasCapital && old.settlementIds.length >= 5) || (s.tier || 0) >= 4 ? 3 : 2;
    const coda = epochalSeat ? (greatestCity ? ' It had been the greatest city in the world.' : ` It had been the seat of the mightiest realm on earth.`) : '';
    chronicle(world, {
      cat: 'war', imp, text: text + coda, x: s.x, y: s.y, civId: att.id, sid: s.id, icon: 'capture',
      key: gates ? 'town.gates' : fallen ? 'war.conquest' : wasCapital ? 'war.capital' : 'war.capture', ref: war ? { k: 'war', id: war.id } : { k: 'settlement', id: s.id }, ...cause,
      tags: gates ? ['memory'] : fallen ? ['realm-fell'] : wasCapital ? ['capital'] : undefined,
    });
    if (fig && fig.died == null) fig.deeds = (fig.deeds || []).concat(`took ${name}`).slice(-12);
  }
  army.state = 'idle'; army.targetId = null; army.path = null;
  army.flags.nextPlan = day + 10;
}

const GATES_DEED = { r: 'had saved it', f: 'had freed it', g: 'had spared it before' };
/** The line for a town that opened its gates to a realm it remembered kindly (memory.js). */
function gatesText(world, s, att, old, wn, mem) {
  const deed = GATES_DEED[mem ? mem[2] : ''] || 'had dealt well with it';
  const Y = mem ? ` in Year ${Math.floor(mem[3] / DAYS_PER_YEAR)}` : '';
  return hashPick([
    `Remembering how ${civName(att)} ${deed}${Y}, ${s.name} opened its gates to its army in ${wn}.`,
    `${capFirst(s.name)} would not fight for ${civName(old)}: its people threw open the gates to ${civName(att)}, who ${deed}${Y}.`,
  ], s.id, att.id, world.time.day);
}

// ---------------------------------------------------------------------------
// Monthly: weariness, occupation, peace

function weariness(world, st) {
  const atWar = civsAtWar(world);
  for (const civ of liveCivs(world)) {
    st.liveMonths[civ.id] = (st.liveMonths[civ.id] || 0) + 1;
    let w = finite(civ.warWeariness) ? civ.warWeariness : 0;
    if (atWar.has(civ.id)) {
      st.warMonths[civ.id] = (st.warMonths[civ.id] || 0) + 1;
      let cas = 0, occ = 0, losing = 0;
      for (const war of activeWarList(world)) {
        if (!war.active) continue;
        const sd = sideOf(war, civ.id);
        if (!sd) continue;
        const g = geoOf(world, war);
        cas += g.monthCas[civ.id] || 0;
        for (const sid in g.occupied) if (g.occupied[sid] === civ.id && world.settlements[sid]?.civId !== civ.id) occ++;
        losing = Math.max(losing, -sd * (war.warScore || 0));
      }
      const pop = Math.max(500, civPopulation(world, civ));
      let inc = 0.006 + 1.5 * cas / pop + 0.015 * occ + 0.02 * Math.max(0, losing) / 100;
      inc *= 1.25 - 0.6 * (civ.traits?.militarism ?? 0.5);
      if (rulerHas(civ, 'warlike')) inc *= 0.75;
      w += inc;
    } else {
      w *= 0.9;
    }
    civ.warWeariness = clamp01(w);
  }
  for (const war of activeWarList(world)) if (war.active) geoOf(world, war).monthCas = {};
}

function occupation(world) {
  for (const war of activeWarList(world)) {
    if (!war.active) continue;
    const g = geoOf(world, war);
    // momentum fades; a side with no army in the field slowly loses the initiative
    let bat = (g.bat || 0) * 0.96;
    const hasA = world.armies.some((a) => war.attackers.includes(a.civId) && !hunting(a));
    const hasD = world.armies.some((a) => war.defenders.includes(a.civId) && !hunting(a));
    if (hasA && !hasD) bat += 1.5; else if (hasD && !hasA) bat -= 1.5;
    g.bat = clamp(bat, -35, 35);
    rescore(world, war);
    // since when the attackers have held the upper hand (a score of 40), for terms.js aimMet
    if (war.warScore >= 40) { if (g.hiDay == null) g.hiDay = world.time.day; } else if (g.hiDay != null) g.hiDay = null;
  }
}

function sanitize(world) {
  for (const war of activeWarList(world).slice()) {
    if (!war.active) continue;
    geoOf(world, war);
    const a0 = war.attackers.length, d0 = war.defenders.length;
    war.attackers = war.attackers.filter((id) => world.civs[id]?.alive);
    war.defenders = war.defenders.filter((id) => world.civs[id]?.alive);
    if (war.attackers.length !== a0 || war.defenders.length !== d0) bumpVersion(world, 'wars');
    if (!war.attackers.length || !war.defenders.length) {
      war.geo.endReason ||= 'annihilation';
      endWar(world, war.id, war.attackers.length ? 'attackers' : war.defenders.length ? 'defenders' : 'annihilation', 15);
    }
  }
  // stale sieges
  for (const s of liveSettlements(world)) {
    if (!s.siege) continue;
    const a = world.armies.find((x) => x.id === s.siege.armyId);
    if (!a || a.state !== 'sieging' || a.targetId !== s.id) { s.siege = null; endSiege(world, s, 'lifted'); }
  }
}

/**
 * How desperate a side's leader is (0..1): its capital taken, most of its towns occupied,
 * or the siege of its seat close to breaking.
 */
function desperation(world, war, g, civ) {
  if (!civ || !civ.alive) return 0;
  const mySide = sideOf(war, civ.id);
  const held = civ.settlementIds.length;
  let lost = 0, capLost = false;
  for (const sid in g.occupied) {
    if (g.occupied[sid] !== civ.id) continue;
    const s = world.settlements[sid];
    if (!s || !s.alive || s.civId === civ.id) continue;
    lost++;
    if (s.flags && s.flags.wasCapital === civ.id) capLost = true;
  }
  let d = 0;
  if (lost && lost / (lost + held) >= 0.5) d = 0.6;
  if (capLost) d = Math.max(d, 0.7);
  const cap = capitalOf(world, civ);
  if (cap && cap.siege && sideOf(war, cap.siege.civId) === -mySide) {
    const p = cap.siege.progress || 0;
    if (p >= 0.6) d = Math.max(d, held <= 2 ? 0.3 + 0.6 * p : 0.15 + 0.4 * p);
  }
  // nobody sues for peace in the first season unless the seat itself is lost
  const dur = (world.time.day - war.startDay) / DAYS_PER_YEAR;
  if (!capLost) d *= clamp01(dur / 1.5);
  return clamp01(d);
}

/** Chance that a victor spurns a beaten foe's envoys and fights on to the end. */
function refusal(world, W, L, g) {
  const t = W.traits || {};
  let r = 0.12 + 0.4 * ((t.aggression ?? 0.5) - 0.5) + 0.2 * ((t.expansion ?? 0.5) - 0.5);
  if (rulerHas(W, 'cruel')) r += 0.25;
  if (rulerHas(W, 'warlike')) r += 0.12;
  if (rulerHas(W, 'mad')) r += 0.15;
  if (rulerHas(W, 'ambitious')) r += 0.08;
  if (rulerHas(W, 'just') || rulerHas(W, 'wise')) r -= 0.12;
  if (rulerHas(W, 'generous')) r -= 0.08;
  const fa = faithOf(world, W.stateReligion);
  if (fa && g.cb === 'holy' && fa.tenets.includes('militant')) r += 0.3;
  if (fa && fa.tenets.includes('pacifist')) r -= 0.15;
  if (g.cb === 'succession' || g.cb === 'reconquest' || g.cb === 'revenge') r += 0.12;
  if ((rel(world, W.id, L.id).grievance || 0) > 50) r += 0.15;
  return clamp(r * Math.sqrt(Math.max(0.1, world.params.aggression ?? 1)), 0.03, 0.9);
}

/**
 * Monthly peace talks. Wars end when one side is beaten and sues for terms (capitulation),
 * when a decisive occupation leaves nothing to discuss, when the loser or both sides are
 * exhausted, when the attacker holds what it went to war for, in stalemate, or — failing all
 * else — after a generation of fighting.
 */
function peace(world, st) {
  const rng = world.rng;
  const day = world.time.day;
  // in a world at war everywhere, envoys find readier ears; in a quiet one, wars drag on
  const civs = liveCivs(world);
  const atWar = civsAtWar(world);
  let warring = 0;
  for (const c of civs) if (atWar.has(c.id)) warring++;
  const pf = civs.length >= 3 ? clamp(Math.pow(Math.max(0.03, warring / civs.length) / WAR_SHARE, 0.8), 0.5, 2.0) : 1;
  for (const war of activeWarList(world).slice()) {
    if (!war.active) continue;
    const g = geoOf(world, war);
    const A = leader(world, war.attackers), D = leader(world, war.defenders);
    if (!A || !D) continue;
    const score = war.warScore || 0;
    const dur = (day - war.startDay) / DAYS_PER_YEAR;
    const wA = A.warWeariness || 0, wD = D.warWeariness || 0;
    const civMod = civModuleWar(world, war);
    let end = null, why = null;
    const occ = g.occ || 0;
    // a beaten side sues for peace before its last strongholds fall
    for (const [L, Wn, winEnd] of [[D, A, 'attackers'], [A, D, 'defenders']]) {
      if (end) break;
      const dl = desperation(world, war, g, L);
      if (dl <= 0 || !rng.chance(0.3 * dl)) continue;
      // rebels who beg for terms are simply put down; a crown on its knees lets them go
      if (civMod || !rng.chance(refusal(world, Wn, L, g))) { end = winEnd; why = 'capitulation'; st.capitulations++; }
      else if (rateOk(world, `spurn${war.id}`, 3 * DAYS_PER_YEAR)) spurnNote(world, war, Wn, L);
    }
    if (end) { /* settled above */ }
    else if (score >= 80 && occ >= 30 && rng.chance(0.6)) { end = 'attackers'; why = 'decisive'; }
    else if (score <= -80 && occ <= -30 && rng.chance(0.6)) { end = 'defenders'; why = 'decisive'; }
    else if (Math.abs(score) >= 55 && (score > 0 ? wD : wA) > 0.35 && rng.chance(0.15 * pf)) { end = score > 0 ? 'attackers' : 'defenders'; why = 'overwhelmed'; }
    else if (score > 25 && wD > 0.5 && rng.chance(0.1 * pf)) { end = 'attackers'; why = 'loser exhausted'; }
    else if (score < -25 && wA > 0.5 && rng.chance(0.1 * pf)) { end = 'defenders'; why = 'loser exhausted'; }
    else if (((wA > 0.65 && wD > 0.45) || (wD > 0.65 && wA > 0.45)) && rng.chance(0.15 * pf)) { end = Math.abs(score) < 20 ? 'white' : score > 0 ? 'attackers' : 'defenders'; why = 'mutual exhaustion'; }
    else if (dur >= 1 && aimMet(world, war, g, score) && rng.chance(0.07 * pf)) { end = 'attackers'; why = 'aim met'; }
    else if (dur > 3 && Math.abs(score) < 20 && rng.chance((0.008 + dur * 0.003) * pf)) { end = 'white'; why = 'stalemate'; }
    else if (dur > 25) { end = Math.abs(score) < 15 ? 'white' : score > 0 ? 'attackers' : 'defenders'; why = 'endless'; }
    if (end) { g.endReason = why; makePeace(world, st, war, end); }
  }
}

function spurnNote(world, war, W, L) {
  const capL = capitalOf(world, L);
  const ruler = rulerName(W);
  chronicle(world, {
    cat: 'war', imp: 2, x: capL ? capL.x : null, y: capL ? capL.y : null, civId: W.id, sid: capL ? capL.id : null, icon: 'war',
    key: 'war.spurned', ref: { k: 'war', id: war.id }, ...(war.geo && war.geo.seq != null ? { cause: war.geo.seq } : {}),
    text: pickOne(world, [
      `${ruler ? `${ruler} of ${civName(W)}` : capFirst(civName(W))} sent back the envoys of ${civName(L)} unheard, vowing to finish ${theWar(war)} at the gates of ${capL ? capL.name : 'their last stronghold'}.`,
      `${capFirst(civName(L))} sued for peace, but ${civName(W)} would accept nothing short of surrender.`,
      `The heralds of ${civName(L)} came to beg for terms and were turned away; ${civName(W)} meant to fight ${theWar(war)} to its end.`,
    ]),
  });
}

/**
 * Settle a war: occupied towns ceded or returned, tribute, vassalage, truce; the treaty line.
 * end: 'attackers' | 'defenders' | 'white'. opts: { divine: true } for a peace a god imposed.
 */
function makePeace(world, st, war, end, opts = {}) {
  const rng = world.rng;
  const g = geoOf(world, war);
  const civil = isCivil(war);
  const civMod = civModuleWar(world, war);
  const score = war.warScore || 0;
  const sc = Math.abs(score);
  // a realm that sues for terms with its seat about to fall pays as if soundly beaten
  const capit = g.endReason === 'capitulation';
  const terms = capit ? Math.max(sc, 55) : sc;
  const winners = end === 'attackers' ? war.attackers : end === 'defenders' ? war.defenders : [];
  const losers = end === 'attackers' ? war.defenders : end === 'defenders' ? war.attackers : [];
  const Wc = leader(world, winners), Lc = leader(world, losers);
  const A = leader(world, war.attackers), D = leader(world, war.defenders);
  const ceded = [], cededIds = [], returned = [];
  let tribute = false, vassal = false, reunified = false;
  // the terms this chunk adds (terms.js, debt.js, claims.js)
  let reparations = 0, hostageTerm = false, crown = null, faith = null, renounced = [], harsh = 0;
  const aim = winnerAim(g, end);
  const aimK = aim ? aim.k : null;
  const back = (sid, to) => {
    const s = world.settlements[sid];
    const c = world.civs[to];
    if (!s || !s.alive || !c || !c.alive || s.civId === to) return;
    if (world.civs[s.civId] && world.civs[s.civId].settlementIds.length <= 1) return;   // never strip a realm's last town in a treaty
    const from = s.civId;
    const assim = finite(s.flags?.assim) ? s.flags.assim : 0;
    if (transferSettlement(world, sid, to, 'treaty')) {
      returned.push(s.name); noteTransfer(world, war, sid, from, to, 'returned');
      remember(world, s, to, 0.4 * (1 - assim), 'f');   // handed back to its own realm (memory.js)
    }
  };
  if (end === 'white') {
    for (const sid in g.occupied) back(+sid, g.occupied[sid]);
  } else {
    for (const sid in g.occupied) {
      const s = world.settlements[sid];
      if (!s || !s.alive) continue;
      const orig = g.occupied[sid];
      const holderWins = winners.includes(s.civId);
      if (holderWins && losers.includes(orig)) { ceded.push(s.name); cededIds.push(+sid); }
      else if (losers.includes(s.civId) && winners.includes(orig)) back(+sid, orig);
    }
    if (civMod) {
      // the civ module reabsorbs or recognises the rebels on warEnded
    } else if (civil && Wc && Lc) {
      if (end === 'defenders') {
        // the rebellion is crushed: every rebel town returns to the crown
        for (const rid of war.attackers) {
          const rc = world.civs[rid];
          if (!rc || !rc.alive) continue;
          for (const sid of rc.settlementIds.slice()) { if (transferSettlement(world, sid, D.id, 'reconquest')) noteTransfer(world, war, sid, rid, D.id, 'returned'); }
        }
        reunified = true;
      }
    } else if (Wc && Lc) {
      if (aimK === 'towns') {
        // border changes: the aim's towns the winner does not hold yet, one for every 20 points above 30
        let n = Math.floor((terms - 30) / 20);
        for (const sid of aim.sids || []) {
          if (n <= 0) break;
          const s = world.settlements[sid];
          if (!s || !s.alive || !losers.includes(s.civId)) continue;
          const from = s.civId;
          if (world.civs[from].settlementIds.length <= 2) continue;
          if (transferSettlement(world, sid, Wc.id, 'treaty')) { ceded.push(s.name); cededIds.push(sid); noteTransfer(world, war, sid, from, Wc.id, 'ceded'); remember(world, s, from, -0.3, 'c'); n--; }
        }
      } else if (terms >= 85 && Lc.settlementIds.length > 2) {
        const capW = capitalOf(world, Wc);
        const t = capW ? nearestSettlement(world, capW.x, capW.y, { civId: Lc.id, filter: (s) => s.id !== Lc.capitalId }) : null;
        if (t && transferSettlement(world, t.id, Wc.id, 'treaty')) { ceded.push(t.name); cededIds.push(t.id); noteTransfer(world, war, t.id, Lc.id, Wc.id, 'ceded'); remember(world, t, Lc.id, -0.3, 'c'); }
      }
      // money: reparations for a war to humble or to recover debts (with what was owed), tribute
      // otherwise (sooner when tribute was the aim), and reparations on top of it after a crushing defeat
      const humble = aimK === 'humble' || aimK === 'debt';
      const owed = aimK === 'debt' ? settleDebtClaim(world, Wc.id, Lc.id) : 0;
      if (Lc.alive && ((humble && terms >= 30) || (!humble && terms >= 75)) && peaceAllows(world, Wc, Lc, 'reparations')) {
        const years = Math.min(15, 8 + Math.round(terms / 15));
        reparations = Math.round((clamp((terms - 30) / 20, 0.25, 3) * 12 * monthlyIncome(Lc) + owed) * 10) / 10;
        addReparations(world, Lc.id, Wc.id, reparations, years);
      }
      if (Lc.alive && !humble && (terms >= 45 || (aimK === 'tribute' && terms >= 25))) {
        const yrs = Math.round(10 + terms / 5);
        const t = addTribute(world, Lc.id, Wc.id, null, yrs);
        tribute = { amount: t && finite(t.amount) ? Math.round(t.amount * 10) / 10 : true, years: yrs };
      }
      hostageTerm = Lc.alive && (aimK === 'humble' || terms >= 50);
      const weak = civPower(world, Lc) < (capit ? 0.5 : 0.35) * civPower(world, Wc);
      if ((aimK === 'subjugate' && terms >= 45) || terms >= 65 || (capit && Lc.settlementIds.length <= 3)) {
        if (Lc.alive && Lc.vassalOf == null && weak && rng.chance(capit ? 0.6 : 0.5) && !liveCivs(world).some((c) => c.vassalOf === Lc.id)) {
          if (setVassal(world, Lc.id, Wc.id, 'conquest')) vassal = true;
        }
      }
      // a crown: the victor's ruler is crowned in the loser's realm as well (civ/dynasty.js, on crownWon)
      if (aimK === 'crown' && terms >= 55 && Lc.alive && !vassal && peaceAllows(world, Wc, Lc, 'crown')) {
        emit(world, 'crownWon', war, Wc, Lc);
        if (Lc.flags?.union && Lc.flags.union.withCivId === Wc.id) crown = 'union';
      }
      // a faith: the loser's crown takes the victor's (its towns keep their own, and follow slowly)
      if (aimK === 'faith' && terms >= 50 && Lc.alive && aim.rid != null && Lc.stateReligion !== aim.rid && peaceAllows(world, Wc, Lc, 'faith')) {
        if (imposeFaith(world, Lc, aim.rid, 10 + Math.round(terms / 6))) faith = aim.rid;
      }
      if (g.cb === 'liberation' && end === 'attackers' && A && A.vassalOf === D?.id) releaseVassal(world, A.id, 'independence', true);
    }
    // how harsh the peace was: towns beyond the aim, money, a hostage, a crown, a faith
    if (Lc && Wc && !civil) {
      const aimed = aimK === 'towns' ? aim.sids || [] : [];
      const beyond = cededIds.filter((sid) => !aimed.includes(sid)).length;
      harsh = clamp01(0.2 * beyond + (reparations ? 0.2 : 0) + (hostageTerm && Lc.ruler?.heir ? 0.1 : 0) + (vassal ? 0.3 : 0) + (crown ? 0.4 : 0) + (faith != null ? 0.3 : 0));
    }
    if (Lc && Wc && Lc.alive) {
      const r = rel(world, Lc.id, Wc.id);
      r.grievance = Math.min(100, (r.grievance || 0) + 15 + sc / 3 + ceded.length * 8 + (harsh > 0.5 ? 20 * harsh : 0));
      if (!civil && harsh > 0.5) hardenClaims(world, Lc, cededIds);   // a harsh peace is not forgiven
      else if (!civil && end === 'attackers') {
        // a fair peace the defender accepted: it gives up its claims on the towns the victors hold
        const held = [];
        for (const k in Lc.landClaims || {}) { const s = world.settlements[k]; if (s && s.alive && winners.includes(s.civId)) held.push(+k); }
        renounced = renounceClaims(world, Lc, held);
      }
    }
  }
  if (g.cb === 'debt' && A && D) settleDebtClaim(world, A.id, D.id);   // the quarrel is settled, whoever won
  const truce = Math.round((opts.truceYears ?? (10 + sc / 6)) + rng.int(0, 6));
  const hostage = hostageTerm && Wc && Lc ? takeHostage(world, Lc, Wc, truce) : null;
  const outcome = end === 'white' ? 'white_peace' : end;
  war.geo.terms = {
    ceded: ceded.slice(), returned: returned.slice(), tribute: tribute ? tribute.amount : false, tributeYears: tribute ? tribute.years : 0, vassal, reunified, truce,
    reparations, hostage: hostage ? hostage.name : null, faith, crown, renounced, harsh: Math.round(harsh * 100) / 100,
  };
  endWar(world, war.id, outcome, truce);
  // the treaty town
  const tSrc = Lc && Lc.alive ? capitalOf(world, Lc) : D && D.alive ? capitalOf(world, D) : null;
  const tname = tSrc ? tSrc.name : null;
  const treaty = tname ? rng.pick([`the Treaty of ${tname}`, `the Peace of ${tname}`]) : 'a hard peace';
  war.geo.treaty = tname ? treaty : null;
  const span = spanPhrase(world.time.day - war.startDay);
  const wn = capFirst(theWar(war));
  let text, imp = 3;
  // the civ module writes its own line when a rising is crushed or a claimant crowned
  if (civMod && (end === 'defenders' || (end === 'attackers' && war.cause === 'civil war' && /Succession|Revolution/.test(war.name || '')))) return;
  if (opts.textFn) {
    text = opts.textFn(world, war, { treaty, tname, span, returned, ceded });
    imp = opts.imp ?? 3;
  } else if (civil) {
    if (reunified) {
      text = pickOne(world, [
        `${wn} ended after ${span}: the rebellion was crushed and its towns returned to ${civName(D)}.`,
        `${capFirst(civName(D))} reunited the realm, ending ${theWar(war)} after ${span} of brother fighting brother.`,
      ]);
      imp = 4;
    } else if (end === 'attackers') {
      text = pickOne(world, [`${capFirst(civName(A))} won its independence from ${civName(D)} at ${treaty}, ending ${theWar(war)}.`, `${wn} ended in victory for the rebels: ${civName(A)} stood free of ${civName(D)}.`]);
      imp = A && (A.settlementIds.length >= 3 || civPopulation(world, A) > 20000) ? 4 : 3;
    } else {
      text = `${wn} ended in exhaustion after ${span}; ${civName(A)} and ${civName(D)} went their separate ways under ${treaty}.`;
    }
  } else if (end === 'white') {
    text = returned.length
      ? `${wn} ended in exhaustion with ${treaty}; after ${span} of fighting, ${listJoin(returned.slice(0, 3))} ${returned.length === 1 ? 'was' : 'were'} handed back and the old borders restored.`
      : pickOne(world, [
        `${wn} ended in exhaustion with ${treaty}; neither side gained a single town.`,
        `After ${span} of fighting, ${civName(A)} and ${civName(D)} made peace and the borders stood where they had been.`,
        `${wn} sputtered out after ${span}; at ${treaty} both sides swore to a peace neither had won.`,
      ]);
  } else {
    const more = ceded.length - 4;
    const towns = ceded.length ? `surrendered ${more > 0 ? `${ceded.slice(0, 4).join(', ')} and ${countWord(more)} other town${more === 1 ? '' : 's'}` : listJoin(ceded)} to ${civName(Wc)}` : `yielded to ${civName(Wc)}`;
    const extra = vassal ? ' and became its vassal' : tribute ? ` and paid tribute for ${countWord(tribute.years)} years` : '';
    const besieged = capit && tSrc && tSrc.alive ? tSrc.name : null;
    text = end === 'attackers'
      ? besieged
        ? pickOne(world, [
          `With enemy siege lines around ${besieged}, ${civName(Lc)} sued for peace; by ${treaty} it ${towns}${extra}, ending ${theWar(war)}.`,
          `Rather than see ${besieged} stormed, ${civName(Lc)} ${towns}${extra}; ${theWar(war)} was over.`,
        ])
        : `${wn} ended with ${treaty}: ${civName(Lc)} ${towns}${extra}.`
      : ceded.length || tribute || vassal
        ? `${wn} ended in defeat for ${civName(Lc)}, who sued for peace at ${tname || 'last'} and ${towns.replace(/^yielded to/, 'humbled itself before')}${extra}.`
        : `${capFirst(civName(Lc))}'s invasion failed, and ${theWar(war)} ended with ${treaty} after ${span}.`;
    const realms = (Wc ? Wc.settlementIds.length : 0) + (Lc && Lc.alive ? Lc.settlementIds.length : 0);
    if ((vassal && Lc && Lc.settlementIds.length >= 4) || ceded.length >= 5) imp = 4;
    else if (!ceded.length && !tribute && realms <= 5) imp = 2;
  }
  if (!opts.textFn && end === 'white' && !returned.length && (A ? A.settlementIds.length : 0) + (D ? D.settlementIds.length : 0) <= 5) imp = 2;
  // a peace is major news (imp 3) only when it settled something: three towns changed hands,
  // vassalage (or tribute with land) was imposed, or the war had dragged on a decade (a fallen
  // seat was major news when it fell: war.capital)
  if (!opts.textFn && imp === 3) {
    const changed = Math.max((war.captured || []).length, ceded.length + returned.length);
    const years = (world.time.day - war.startDay) / DAYS_PER_YEAR;
    if (!(changed >= 3 || vassal || years >= 10 || (tribute && changed >= 2))) imp = 2;
  }
  // the terms this chunk adds, in the treaty's own words
  if (!civil && Lc && Wc) {
    const more = [];
    const L = capFirst(civName(Lc));
    if (crown === 'union') more.push(`${rulerName(Wc) || capFirst(civName(Wc))} was crowned ruler of ${civName(Lc)} as well, and the two crowns were joined.`);
    if (faith != null) { const r = faithOf(world, faith); if (r) more.push(`${L} was made to take ${r.name} as its faith.`); }
    if (reparations > 0) more.push(`${L} was to pay reparations for years to come.`);
    if (hostage) more.push(`${hostage.name}, heir of ${civName(Lc)}, went to the court of ${civName(Wc)} as a hostage.`);
    if (renounced.length) more.push(`${L} gave up its claim to ${listJoin(renounced.slice(0, 3))}${renounced.length > 3 ? ' and other towns' : ''}.`);
    if (harsh > 0.5) more.push(hashPick([`It was a peace that shamed ${peopleOf(Lc)}.`, `${capFirst(peopleOf(Lc))} would not forget so hard a peace.`], war.id, Lc.id));
    if (more.length) text += ' ' + more.join(' ');
    if (crown) imp = Math.max(imp, 4); else if (faith != null) imp = Math.max(imp, 3);
  }
  const at = tSrc;
  chronicle(world, {
    cat: opts.cat || 'war', imp, text, x: at ? at.x : null, y: at ? at.y : null, civId: Wc ? Wc.id : A ? A.id : null, sid: at ? at.id : null, icon: 'peace',
    key: opts.key || 'war.peace', ref: { k: 'war', id: war.id }, ...(g.seq != null ? { cause: g.seq } : {}), tags: [end === 'white' ? 'white-peace' : 'victory'],
  });
}

// ---------------------------------------------------------------------------
// System

/** A great general who died in camp (of age or fever) leaves the host to a lesser captain. */
function commanders(world) {
  for (const a of world.armies) {
    const fl = a.flags;
    if (!fl || fl.genId == null || hunting(a)) continue;
    const fig = figureById(world, fl.genId);
    if (fig && fig.died == null) continue;
    a.general = null;
    fl.genId = null;
    fl.skill = Math.min(finite(fl.skill) ? fl.skill : 1, 0.95);
  }
}

function monthly(world, st) {
  sanitize(world);
  commanders(world);
  if (Math.floor(world.time.day / DAYS_PER_MONTH) % 12 === 0) {
    for (const k of Object.keys(st.lastPeace)) if (!world.civs[k] || !world.civs[k].alive) delete st.lastPeace[k];
  }
  const ctx = monthCtx(world);
  for (const war of activeWarList(world).slice()) {
    if (!war.active) continue;
    const g = geoOf(world, war);
    if (!g.joined) { g.joined = true; callToArms(world, st, war, ctx); }
  }
  weariness(world, st);
  occupation(world);
  peace(world, st);
  declarations(world, st, ctx);
  for (const war of activeWarList(world).slice()) {
    if (!war.active) continue;
    for (const id of war.attackers.concat(war.defenders)) mobilize(world, world.civs[id], war);
  }
}

function daily(world, st) {
  const day = world.time.day;
  const grid = costGrid(world);
  let plans = 0;
  // today's armies by id, and the siege lines around each town
  const idx = { byId: new Map(), lines: new Map() };
  for (const a of world.armies) {
    idx.byId.set(a.id, a);
    if (a.state === 'sieging' && a.targetId != null) { const l = idx.lines.get(a.targetId); if (l) l.push(a); else idx.lines.set(a.targetId, [a]); }
  }
  for (const army of world.armies.slice()) {
    if (hunting(army)) continue;                                  // the bands module's hunters
    if (!world.civs[army.civId]?.alive) { disband(world, army, 'realm fell'); continue; }
    if (!army.flags || typeof army.flags !== 'object') army.flags = {};
    if (!finite(army.strength) || army.strength < 8) { disband(world, army, 'destroyed'); continue; }
    if (army.state === 'sieging') { siegeTick(world, st, army, idx); continue; }
    const needs = !army.path || army.pathStep >= army.path.length - 1;
    // intercepting a moving army: re-plan every 20 days
    const chasing = army.state === 'marching' && army.flags.tArmy != null && day - (army.flags.lastPlan || 0) >= 20;
    if ((needs || chasing) && plans < MAX_PLANS_PER_DAY && day >= (army.flags.nextPlan || 0)) {
      if (needs && army.state === 'marching') arrive(world, st, army);
      if (!world.armies.includes(army) || army.state === 'sieging') continue;
      if (!army.path || army.pathStep >= army.path.length - 1 || chasing) { plan(world, army, st); plans++; }
      if (!world.armies.includes(army)) continue;
    }
    move(world, army, grid);
    notePeak(army);
  }
  battles(world, st);
}

function arrive(world, st, army) {
  const s = army.targetId != null ? world.settlements[army.targetId] : null;
  const fl = army.flags;
  // a vision fulfilled: the host stands where it was sent
  const g = fl.divineGoal;
  if (g) {
    const there = g.sid != null ? Boolean(s && s.id === g.sid && dist(army.x, army.y, s.x, s.y) <= 1.6) : dist(army.x, army.y, g.x, g.y) <= 1.6;
    if (there) { delete fl.divineGoal; delete fl.goalUntil; }
  }
  if (s && s.alive && dist(army.x, army.y, s.x, s.y) <= 1.6) {
    if (s.civId !== army.civId && areAtWar(world, army.civId, s.civId)) {
      army.state = 'sieging';
      if (!s.siege) { s.siege = { armyId: army.id, civId: army.civId, progress: 0, startDay: world.time.day }; beginSiege(world, s, army); }
      return;
    }
  }
  army.state = 'idle';
  army.path = null;
  army.targetId = null;
  army.flags.tArmy = null;
}

// ---------------------------------------------------------------------------
// Divine acts (geo/acts.js registers the tools; the war logic lives here)

/**
 * incite_war: a and b go to war over a 'provocation' — insulted envoys, forged letters — after
 * a hit to their opinion of each other. Refused for allies' wars, vassals and their overlords
 * (they would only rise), realms already at war, or a realm with no towns. Returns { ok, war?, reason? }.
 */
export function inciteWar(world, aId, bId, opts = {}) {
  const st = state(world);
  const why = inciteRefusal(world, aId, bId);
  if (why) return { ok: false, reason: why };
  const a = world.civs[aId], b = world.civs[bId];
  // allies set at each other's throats: the alliance dies first, in treachery
  const allied = hasTreaty(world, a.id, b.id, 'alliance') || (a.allies || []).includes(b.id);
  if (allied) betrayal(world, a.id, b.id, 'alliance');
  addOpinion(world, a.id, b.id, -35);
  for (const [p, q] of [[a.id, b.id], [b.id, a.id]]) { const r = rel(world, p, q); r.grievance = Math.min(100, (r.grievance || 0) + 20); r.trust = Math.min(r.trust ?? 0.5, 0.1); r.truceUntil = -1; }
  const capA = capitalOf(world, a);
  const goal = capA ? nearestSettlement(world, capA.x, capA.y, { civId: b.id }) : null;
  const ctx = monthCtx(world);
  const war = declare(world, st, a, b, { key: 'provocation', w: 1, goalSid: goal ? goal.id : null, place: goal ? goal.name : null }, ctx, {
    cat: 'divine', key: 'divine.incite_war', imp: 3, cause: opts.cause,
  });
  return { ok: true, war };
}

/**
 * A sworn ally takes up arms at once beside civ in every war civ is fighting that ally is not
 * already in (forge_alliance). Returns the wars joined.
 */
export function rallyAlly(world, civ, ally) {
  const joined = [];
  if (!civ || !ally || !civ.alive || !ally.alive) return joined;
  for (const war of activeWarList(world).slice()) {
    if (!war.active) continue;
    const side = sideOf(war, civ.id);
    if (!side || sideOf(war, ally.id) !== 0) continue;
    const foes = side > 0 ? war.defenders : war.attackers;
    if (foes.some((f) => boundTogether(world, ally.id, f) || world.civs[f]?.vassalOf === ally.id || ally.vassalOf === f)) continue;
    joinWar(world, war, ally, side);
    mobilize(world, ally, war);
    joined.push(war);
  }
  return joined;
}

/** Why a and b cannot be set against each other (null when they can). Pure. */
export function inciteRefusal(world, aId, bId) {
  const a = world.civs[aId], b = world.civs[bId];
  if (!a || !a.alive || !b || !b.alive) return 'Choose two living nations.';
  if (a.id === b.id) return 'A nation cannot make war on itself.';
  if (!a.settlementIds.length || !b.settlementIds.length) return 'One of them holds no towns to fight from.';
  if (areAtWar(world, a.id, b.id)) return `${capFirst(civName(a))} and ${civName(b)} are already at war.`;
  if (!a.relations[b.id] && !b.relations[a.id]) return `${capFirst(peopleOf(a))} have never heard of ${peopleOf(b)}.`;
  if (a.vassalOf === b.id || b.vassalOf === a.id) return 'Overlord and vassal: only a rising could part them (try Discord).';
  return null;
}

/**
 * broker_peace: the war between a and b ends at once in white peace with a long truce (a
 * minor party is released from a wider war). Returns { ok, war?, ended?, reason? }.
 */
export function brokerPeace(world, aId, bId, opts = {}) {
  const st = state(world);
  const a = world.civs[aId], b = world.civs[bId];
  if (!a || !a.alive || !b || !b.alive || a.id === b.id) return { ok: false, reason: 'Choose two living nations at war with each other.' };
  const war = warBetween(world, a.id, b.id);
  if (!war) return { ok: false, reason: `${capFirst(civName(a))} and ${civName(b)} are not at war.` };
  const g = geoOf(world, war);
  const lead = (war.attackers[0] === a.id || war.defenders[0] === a.id) && (war.attackers[0] === b.id || war.defenders[0] === b.id);
  const civMod = civModuleWar(world, war);
  for (const [p, q] of [[a.id, b.id], [b.id, a.id]]) { const r = rel(world, p, q); r.grievance = (r.grievance || 0) * 0.5; r.trust = Math.max(r.trust ?? 0.5, 0.45); }
  addOpinion(world, a.id, b.id, 20);
  a.warWeariness = (a.warWeariness || 0) * 0.5; b.warWeariness = (b.warWeariness || 0) * 0.5;
  if (lead || civMod) {
    g.endReason = 'divine';
    makePeace(world, st, war, 'white', {
      truceYears: 25, cat: 'divine', key: 'divine.broker_peace', imp: 3,
      textFn: (w, wr, t) => pickOne(w, [
        `An unseen hand stayed the swords of ${civName(a)} and ${civName(b)}; ${theWar(wr)} ended in ${t.treaty}${t.returned.length ? `, and ${listJoin(t.returned.slice(0, 3))} went home to their old masters` : ''}.`,
        t.tname ? `Envoys of ${civName(a)} and ${civName(b)} met at ${t.tname} as if summoned by a dream, and ${theWar(wr)} was over after ${t.span}.` : `Envoys of ${civName(a)} and ${civName(b)} met as if summoned by a dream, and ${theWar(wr)} was over after ${t.span}.`,
        `${capFirst(theWar(wr))} ended without victor or vanquished: heaven itself, men said, had brokered ${t.treaty}.`,
      ]),
    });
    return { ok: true, war, ended: true };
  }
  // one party of a wider war: it lays down its arms with its foe under a long truce
  const leave = war.attackers[0] === a.id || war.defenders[0] === a.id ? b : a;
  const other = leave === a ? b : a;
  const side = war.attackers.includes(leave.id) ? war.attackers : war.defenders;
  side.splice(side.indexOf(leave.id), 1);
  bumpVersion(world, 'wars');
  const until = world.time.day + 25 * DAYS_PER_YEAR;
  for (const o of side === war.attackers ? war.defenders : war.attackers) if (world.civs[o]) { rel(world, leave.id, o).truceUntil = until; rel(world, o, leave.id).truceUntil = until; }
  for (const ar of world.armies) {
    if (ar.civId !== leave.id || ar.warId !== war.id) continue;
    const s = ar.targetId != null ? world.settlements[ar.targetId] : null;
    if (s && s.siege && s.siege.armyId === ar.id) { s.siege = null; endSiege(world, s, 'lifted'); }
    ar.warId = null; ar.state = 'returning'; ar.path = null; ar.targetId = null;
  }
  const cap = capitalOf(world, leave);
  chronicle(world, {
    cat: 'divine', imp: 2, x: cap ? cap.x : null, y: cap ? cap.y : null, civId: leave.id, sid: cap ? cap.id : null, icon: 'peace',
    key: 'divine.broker_peace', ref: { k: 'war', id: war.id }, ...(g.seq != null ? { cause: g.seq } : {}),
    text: pickOne(world, [
      `Moved by a dream, ${rulerName(leave) || `the court of ${civName(leave)}`} made a separate peace with ${civName(other)} and withdrew from ${theWar(war)}.`,
      `${capFirst(civName(leave))} laid down its arms in ${theWar(war)}; its quarrel with ${civName(other)} was ended by a hand none could see.`,
    ]),
  });
  return { ok: true, war, ended: false };
}

/** Why army cannot be sent to (x, y) — null when it can. Pure. */
function commandRefusal(world, army) {
  if (!army) return 'That army has left the field.';
  if (hunting(army)) return 'These hunters answer only to the chase.';
  const civ = world.civs[army.civId];
  if (!civ || !civ.alive) return 'Its realm has fallen.';
  if (!enemySet(world, civ.id).size) return `${capFirst(civName(civ))} is at peace; its host is marching home.`;
  if (army.state === 'returning') return 'The host is already going home.';
  return null;
}

/** The goal a command at (x, y) would set: an enemy (or any) town near the spot, else the tile. */
function commandGoal(world, army, x, y) {
  const civ = world.civs[army.civId];
  const enemies = enemySet(world, civ.id);
  const W = world.W;
  const xi = clamp(Math.round(x), 0, W - 1), yi = clamp(Math.round(y), 0, world.H - 1);
  const s = nearestSettlement(world, xi, yi, { maxDist: 2.5, filter: (t) => t.civId !== army.civId });
  if (s) return { sid: s.id, x: s.x, y: s.y, enemy: enemies.has(s.civId), name: s.name };
  const i = yi * W + xi;
  if (world.f.water[i] !== WATER.LAND && peekMods(civ).navigation < 1) return null;
  return { sid: null, x: xi, y: yi, enemy: false, name: null };
}

/**
 * Pure forecast of command_army at (x, y): the march (a path through the pathfinder's cache,
 * without refreshing saved state), the days it would take, the target. { ok, reason?, path?,
 * days?, goal?, text? }
 */
export function commandPreview(world, army, x, y) {
  const why = commandRefusal(world, army);
  if (why) return { ok: false, reason: why };
  const goal = commandGoal(world, army, x, y);
  if (!goal) return { ok: false, reason: 'Its ships cannot cross open water yet.' };
  const civ = world.civs[army.civId];
  const ti = goal.y * world.W + goal.x;
  const path = planPath(world, army, ti, civ, true);
  if (!path) {
    const fromI = clamp(Math.round(army.y), 0, world.H - 1) * world.W + clamp(Math.round(army.x), 0, world.W - 1);
    const across = world.f.landmass[fromI] !== world.f.landmass[ti] || world.f.water[ti] !== WATER.LAND;
    const where = goal.name || 'that place';
    return { ok: false, reason: across && peekMods(civ).navigation < 1 ? `${capFirst(where)} lies across the water, and ${peopleOf(civ)} have no ships to carry a host.` : `No road leads from the host to ${where}.` };
  }
  const m = peekMods(civ);
  const land = world.f.pathLandCost;   // the saved snapshot, read as it stands
  let cost = 0;
  for (let k = 1; k < path.length; k++) { const j = path[k]; cost += world.f.water[j] !== WATER.LAND ? 1 / (2.2 * (m.navigation >= 2 ? 1.25 : 1)) : (land && land[j] > 0 ? land[j] : 2); }
  const days = Math.max(1, Math.round(cost / (BASE_SPEED * m.movement * (0.6 + 0.4 * clamp01(army.supply)))));
  const who = leaderName(army) ? `${leaderName(army)}'s host` : army.name || 'The host';
  const text = goal.name
    ? goal.enemy ? `${capFirst(who)} would march on ${goal.name}, about ${countWord(Math.max(1, Math.round(days / 30)))} month${Math.round(days / 30) === 1 ? '' : 's'} away, and lay siege to it` : `${capFirst(who)} would march to ${goal.name} (about ${days} days)`
    : `${capFirst(who)} would march here (about ${days} days)`;
  return { ok: true, path, days, goal, text };
}

/**
 * command_army: a vision drives the army toward (x, y) — the enemy town there, or the spot —
 * for half a year (flags.divineGoal, goalUntil); chooseTarget honours it before anything else.
 */
export function commandArmy(world, army, x, y) {
  const pv = commandPreview(world, army, x, y);
  if (!pv.ok) return { ok: false, message: pv.reason };
  const fl = army.flags || (army.flags = {});
  fl.divineGoal = { sid: pv.goal.sid, x: pv.goal.x, y: pv.goal.y };
  fl.goalUntil = world.time.day + GOAL_DAYS;
  fl.nextPlan = world.time.day;
  army.path = null;
  if (army.state === 'sieging') {
    const s = army.targetId != null ? world.settlements[army.targetId] : null;
    if (s && s.siege && s.siege.armyId === army.id && pv.goal.sid !== s.id) clearSiegeBy(world, army, 'lifted');
    army.targetId = null;
  }
  army.state = 'idle';
  const civ = world.civs[army.civId];
  const who = leaderName(army) ? `the host of ${leaderName(army)}` : army.name || `a ${civAdj(civ)} host`;
  const to = pv.goal.name || null;
  const war = army.warId != null ? world.wars[army.warId] : null;
  if (rateOk(world, `command${army.id}`, 60)) {
    chronicle(world, {
      cat: 'divine', imp: 2, x: pv.goal.x, y: pv.goal.y, civId: army.civId, sid: pv.goal.sid ?? null, icon: 'army',
      key: 'divine.command_army', ref: { k: 'army', id: army.id },
      text: to
        ? pickOne(world, [
          `A vision drove ${who} toward ${to}.`,
          `${capFirst(who)} dreamed of ${to} burning, and turned its march that way${war ? ` in ${theWar(war)}` : ''}.`,
          `Omens in the sky sent ${who} hurrying toward ${to}.`,
        ])
        : pickOne(world, [
          `A vision drove ${who} out across the land, to a place no map had named.`,
          `${capFirst(who)} broke camp at the command of a dream and marched where it pointed.`,
        ]),
    });
  }
  return { ok: true, message: to ? `${capFirst(who)} marches on ${to}.` : `${capFirst(who)} marches where you pointed.`, days: pv.days };
}

export const system = {
  id: 'war',
  order: 80,
  init(world) {
    const st = state(world);
    world.cache.wp4HookBase = tallies(world);
    for (const war of world.wars) {
      if (!war) continue;
      if (war.active) geoOf(world, war);
      else if (war.geo) ledgerOf(world, war);
    }
    for (const a of world.armies) {
      if (!a.flags || typeof a.flags !== 'object') a.flags = {};
      if (hunting(a)) continue;
      a.flags.bad ||= [];
      if (!finite(a.flags.mp)) a.flags.mp = 0;
      if (!finite(a.strength)) a.strength = 0;
      if (!finite(a.supply)) a.supply = 1;
      if (!finite(a.morale)) a.morale = 1;
      // older saves kept the commander as a bare name
      if (typeof a.general === 'string') {
        const fig = figureById(world, a.flags.genId);
        a.general = { name: a.general, skill: finite(a.flags.skill) ? a.flags.skill : 1, born: fig && finite(fig.born) ? fig.born : world.time.day - 40 * DAYS_PER_YEAR, wins: 0, battles: 0 };
      }
      serviceOf(a);
    }
    // sieges under way in older saves join the registry (no hook: they began long ago)
    for (const s of world.settlements) if (s && s.alive && s.siege && !st.sieges[s.id]) st.sieges[s.id] = [s.siege.armyId, s.siege.civId, finite(s.siege.startDay) ? s.siege.startDay : world.time.day];
  },
  update(world) {
    const st = state(world);
    const day = world.time.day;
    if (day % DAYS_PER_MONTH === MONTH_DAY) monthly(world, st);
    if (day % DAYS_PER_YEAR === MONTH_DAY + 3 * DAYS_PER_MONTH) compactOldWars(world);
    if (world.armies.length) daily(world, st);
    // sieges that vanished without an explicit end (transfers, harmony) are noticed within days
    if (day % 3 === 0) for (const k in st.sieges) { sweepSieges(world, st); break; }
  },
  report(world) {
    return warReport(world);
  },
};

/**
 * Yearly: a war half a century over keeps the gist of its ledger (saved for ever, copied into
 * every keyframe): its two greatest hosts, its eight bloodiest fights (named ones first, in
 * their order) and a dozen of the towns that changed hands (the first and the last six).
 * The ledger keeps its shape, so every reader works on it unchanged.
 */
const OLD_WAR_DAYS = 50 * DAYS_PER_YEAR;
function compactOldWars(world) {
  const day = world.time.day;
  for (const w of world.wars) {
    if (!w || w.active || !finite(w.endDay) || day - w.endDay < OLD_WAR_DAYS) continue;
    const L = w.ledger;
    if (!L || L.old) continue;
    touchRecord(world, w);   // an ended war's record changes: keyframes copy it afresh
    L.old = 1;
    if (Array.isArray(L.armies) && L.armies.length > 2) L.armies.length = 2;
    if (Array.isArray(L.t) && L.t.length > 12) L.t = L.t.slice(0, 6).concat(L.t.slice(-6));
    if (Array.isArray(L.b) && L.b.length > 8) {
      const deadOf = (r) => (r.length === 3 ? r[2] : r[5]) || 0;
      const named = (r) => (r.length > 3 && r[6] ? 1 : 0);
      const rows = L.b.map((r, k) => [r, k]);
      rows.sort((p, q) => named(q[0]) - named(p[0]) || deadOf(q[0]) - deadOf(p[0]) || p[1] - q[1]);
      L.b = rows.slice(0, 8).sort((p, q) => p[1] - q[1]).map((x) => x[0]);
    }
  }
}

// ---------------------------------------------------------------------------
// Report (headless): war share, ledgers, generals, hook counters

function warReport(world) {
  const st = state(world);
  const yrs = Math.max(1, world.time.day / DAYS_PER_YEAR);
  const shares = [];
  for (const k in st.liveMonths) if (st.liveMonths[k] >= 600) shares.push((st.warMonths[k] || 0) / st.liveMonths[k]);
  shares.sort((a, b) => a - b);
  const median = shares.length ? shares[shares.length >> 1] : null;
  let battlesRec = 0, named = 0, transfers = 0, armies = 0, wars = 0;
  for (const w of world.wars) {
    if (!w || !w.ledger) continue;
    wars++;
    for (const r of w.ledger.b) { if (r.length > 3) { battlesRec++; if (r[6]) named++; } }
    transfers += w.ledger.t.length; armies += w.ledger.armies.length;
  }
  const generals = world.figures.filter((f) => f.kind === 'general');
  const livingGenerals = generals.filter((f) => f.died == null).length;
  const flagsOk = world.armies.every((a) => a.flags && (a.flags.loss == null || typeof a.flags.loss === 'object'));
  const lossesKept = world.armies.filter((a) => a.flags && a.flags.loss).length;
  const lines = [
    `wars ${world.wars.length} (${st.declared} declared here), battles ${st.battles} (${(st.battles / yrs).toFixed(1)}/yr), captures ${st.captures}, razed ${st.razed}, capitulations ${st.capitulations}`,
    `typical civ at war ${median == null ? '—' : (100 * median).toFixed(0) + '%'} of its life (median over ${shares.length} civs that lived 50+ years)`,
    `ledgers: ${wars} wars, ${battlesRec} battle records (${named} named), ${transfers} towns changed hands, ${armies} army summaries`,
    `generals: ${generals.length} figures (${livingGenerals} living), ${st.promoted} promoted this run; armies in the field ${world.armies.length} (${lossesKept} with loss records), ${st.disbanded} stood down`,
  ];
  const checks = [
    { ok: median == null || world.time.day < 500 * DAYS_PER_YEAR || (median >= 0.15 && median <= 0.35), label: `typical civ at war 15–35% of the time${world.time.day < 500 * DAYS_PER_YEAR ? ' (judged from Y500)' : ''} (${median == null ? 'n/a' : (100 * median).toFixed(0) + '%'})` },
    { ok: flagsOk, label: 'army flags keep the kernel loss record (merged, never replaced)' },
    (() => {
      const base = world.cache.wp4HookBase || {};
      const made = (world.nextId?.figure || 0) - (base.figures || 0), promoted = (st.promoted || 0) - (base.promoted || 0);
      return { ok: promoted <= Math.max(30, 0.4 * made), label: `generals do not crowd the great figures (${promoted} of ${made} figures born this session were promoted generals)` };
    })(),
  ];
  return { title: 'War (WP4)', lines: lines.concat(geoHookLines(world)), checks: checks.concat(geoHookChecks(world)) };
}

// The hook counters of every WP4 emitter (geo and nature), shown once in the war report.
const HOOKS = ['battle', 'siegeStarted', 'siegeEnded', 'armyDisbanded', 'plagueStarted', 'plagueEnded', 'plagueDeaths', 'routeCreated', 'routeBroken',
  'religionFounded', 'schism', 'quake', 'tsunami', 'eruption', 'impact', 'flood', 'locusts', 'fireEnded', 'stormEnded'];

function geoHookLines(world) {
  const c = world.cache.wp4Hooks || {};
  return ['hooks: ' + HOOKS.map((h) => `${h} ${c[h] || 0}`).join(' · ')];
}

/** What the systems' own tallies said when this session began (taken in init; world.cache). */
function tallies(world) {
  const d = world.sys.disasters?.counts || {}, wx = world.sys.weather?.counts || {}, eco = world.sys.ecology?.counts || {};
  const war = world.sys.war || {}, dis = world.sys.disease || {}, tr = world.sys.trade || {}, re = world.sys.religion || {};
  let ended = 0, dead = 0;
  for (const p of world.plagues) { if (!p.active) ended++; dead += p.deaths || 0; }
  return {
    figures: world.nextId?.figure || 0, promoted: war.promoted || 0,
    battles: war.battles || 0, captures: war.captures || 0, razed: war.razed || 0, disbanded: war.disbanded || 0,
    outbreaks: dis.outbreaks || 0, plaguesEnded: ended, plagueDead: Math.floor(dead), routes: tr.created || 0, broken: tr.broken || 0,
    faiths: re.founded || 0, schisms: re.schisms || 0, quakes: d.quakes || 0, eruptions: d.eruptions || 0, meteors: d.meteors || 0,
    tsunamis: d.tsunamis || 0, floods: d.floods || 0, locusts: d.locusts || 0, fires: eco.fires || 0,
    storms: (wx.cyclones || 0) + (wx.blizzard || 0) + (wx.thunderstorm || 0) + (wx.sandstorm || 0),
  };
}

/** Every WP4 hook fired whenever its event happened this session (a hook may lag its event by days). */
function geoHookChecks(world) {
  const c = world.cache.wp4Hooks || {};
  const base = world.cache.wp4HookBase || {};
  const now = tallies(world);
  const grew = (k, by = 1) => (now[k] || 0) - (base[k] || 0) >= by;
  const out = [];
  const need = (name, happened, why) => out.push({ ok: !happened || (c[name] || 0) > 0, label: happened ? `hook ${name} fired ${c[name] || 0}×` : `hook ${name}: ${why}` });
  need('battle', grew('battles'), 'no battle this session');
  need('siegeStarted', grew('captures') || grew('razed'), 'no town stormed this session');
  need('siegeEnded', grew('captures') || grew('razed'), 'no siege ended this session');
  need('armyDisbanded', grew('disbanded'), 'no army stood down this session');
  need('plagueStarted', grew('outbreaks'), 'no outbreak this session');
  need('plagueEnded', grew('plaguesEnded'), 'no plague ended this session');
  need('plagueDeaths', grew('plagueDead', 30), 'no plague deaths this session');
  need('routeCreated', grew('routes'), 'no route opened this session');
  need('routeBroken', grew('broken'), 'no route broken this session');
  need('religionFounded', grew('faiths'), 'no faith founded this session');
  need('schism', grew('schisms'), 'no schism this session');
  need('quake', grew('quakes'), 'no quake this session');
  need('eruption', grew('eruptions'), 'no eruption this session');
  need('impact', grew('meteors'), 'no meteor this session');
  need('tsunami', grew('tsunamis'), 'no tsunami this session');
  need('flood', grew('floods'), 'no flood this session');
  need('locusts', grew('locusts', 2), 'no swarm finished this session');
  need('fireEnded', grew('fires', 50), 'few fires this session');
  need('stormEnded', grew('storms', 20), 'few storms this session');
  return out;
}

// ---------------------------------------------------------------------------
// Hooks

on('civDestroyed', (world, civ) => {
  if (!civ) return;
  let changed = false;
  for (const war of activeWarList(world).slice()) {
    if (!war.active) continue;
    const a0 = war.attackers.length, d0 = war.defenders.length;
    war.attackers = war.attackers.filter((id) => id !== civ.id);
    war.defenders = war.defenders.filter((id) => id !== civ.id);
    if (war.attackers.length !== a0 || war.defenders.length !== d0) changed = true;
    if (!war.attackers.length || !war.defenders.length) {
      bumpVersion(world, 'wars');
      if (war.geo) war.geo.endReason ||= 'annihilation';
      endWar(world, war.id, war.attackers.length ? 'attackers' : war.defenders.length ? 'defenders' : 'annihilation', 15);
    }
  }
  if (changed) bumpVersion(world, 'wars');
  for (const s of world.settlements) if (s && s.alive && s.siege && s.siege.civId === civ.id) { s.siege = null; endSiege(world, s, 'lifted'); }
  // (the realm's great generals pass with it: the civ module's yearly figure roll ends them)
});

on('warEnded', (world, war) => {
  if (!war) return;
  const st = state(world);
  for (const id of war.attackers.concat(war.defenders)) st.lastPeace[id] = world.time.day;
  // finished wars keep their story (name, sides, terms, ledger), not their working state
  if (war.geo) { war.geo.log = (war.geo.log || []).slice(-6); war.geo.monthCas = {}; war.geo.occupied = {}; }
  const L = ledgerOf(world, war);
  // (integration: every war ever fought is saved, so a finished war keeps a compact story)
  // the ledger now holds the battles, so the working log goes; casualty totals are kept whole
  if (war.geo && L && L.b.length) war.geo.log = [];
  if (war.casualties && typeof war.casualties === 'object') for (const k in war.casualties) war.casualties[k] = Math.round(finite(war.casualties[k]) ? war.casualties[k] : 0);
  if (L && Array.isArray(L.armies)) {
    let dead = 0;
    if (war.casualties && typeof war.casualties === 'object') for (const k in war.casualties) dead += war.casualties[k] || 0;
    const keep = dead >= 10000 ? 8 : dead >= 2000 ? 4 : 1;
    if (L.armies.length > keep) L.armies.length = keep;
    // a small war keeps its dozen bloodiest fights (merged skirmish months count as one row each)
    if (dead < 2000 && Array.isArray(L.b) && L.b.length > 12) {
      const rows = L.b.map((r, k) => [r, k]);
      rows.sort((p, q) => (q[0][q[0].length === 3 ? 2 : 5] || 0) - (p[0][p[0].length === 3 ? 2 : 5] || 0) || p[1] - q[1]);
      L.b = rows.slice(0, 12).sort((p, q) => p[1] - q[1]).map((x) => x[0]);
    }
  }
  for (const s of world.settlements) {
    if (!s || !s.alive || !s.siege) continue;
    const a = world.armies.find((x) => x.id === s.siege.armyId);
    if (!a || a.warId == null || !areAtWar(world, a.civId, s.civId)) {
      s.siege = null;
      endSiege(world, s, 'lifted');
      if (a && a.state === 'sieging') { a.state = 'returning'; a.path = null; }
    }
  }
});

on('settlementTransferred', (world, s, oldCivId, newCivId) => {
  if (!s) return;
  for (const a of world.armies) {
    if (a.targetId !== s.id || hunting(a)) continue;
    if (a.civId === newCivId || !areAtWar(world, a.civId, newCivId)) { a.targetId = null; if (a.state === 'sieging' || a.state === 'marching') { a.state = 'idle'; a.path = null; } }
  }
});

on('settlementDestroyed', (world, s) => {
  if (!s) return;
  for (const a of world.armies) {
    if (hunting(a)) continue;
    if (a.targetId === s.id) { a.targetId = null; if (a.state === 'sieging' || a.state === 'marching') { a.state = 'idle'; a.path = null; } }
    if (a.homeId === s.id) a.homeId = null;
  }
});

// Civil wars and other wars begun outside this module get our bookkeeping at once.
on('warStarted', (world, war) => {
  if (!war) return;
  const g = geoOf(world, war);
  if (!g.aims) g.aims = aimsFromCause(world, war);   // declare() replaces these with its own
});

// hand the divine acts (geo/acts.js) the war logic they call at use time
bindWar({ inciteWar, inciteRefusal, brokerPeace, commandArmy, commandPreview, rallyAlly, sideOf, leaderName });
