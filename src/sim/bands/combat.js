// Bands · combat. Everything that happens when a band meets the settled world:
//   raidTown     a band against a town's garrison (and any of its owner's armies close by):
//                damageSettlement × settlementMods(s).raidRisk, loot, the raided-realm note,
//                a raid arrow, the bandRaid hook, a 'raid' effect and a chronicle line whose
//                weight follows the harm done (routine raids on hamlets are folded)
//   ransom       a strong host before a rich town may be bought off instead
//   robRoute     outlaws and pirates waylay a caravan or take a ship; the road's pressure
//                rises (routeValue provider), it is called perilous, and after four raids in a
//                few years it is abandoned (geo/trade breakRoute)
//   clash        an army against a band (hunts, armies stumbling on outlaws, beasts mauling
//                columns): kernel damageArmy, the 'battle' hook with kind 'band' or 'beast'
//   clashScan    every ten days, armies within reach of a band in the field fight it
//   assault / foundRealm   companies, hordes and pirates storm a town and make it a state
//                (createCiv + transferSettlement; the realm is styled by the nameStyle provider)

import { createCiv, killCiv, transferSettlement, damageSettlement, damageArmy, settlementsNear, removeEntity } from '../../core/entities.js';
import { settlementMods } from '../../core/effects.js';
import { mulOf } from '../../core/ext.js';
import { emit } from '../../core/hooks.js';
import { emitFx } from '../../core/world.js';
import { addShaped } from '../../core/cohorts.js';
import { DAYS_PER_YEAR, WATER, BIOME } from '../../core/constants.js';
import { clamp, clamp01 } from '../../core/util.js';
import { adjectiveOf } from '../../core/names.js';
import {
  state, bandPower, noteRaid, logRaid, isPeople, isBeast, ready, isReady, endBand, slayBand,
  engineHooks,
} from './engine.js';
import { links, tileOf } from './move.js';
import { say, pick, pickFresh, cap, civName, rulerOf, count, money, when, placePhrase, bandName, BandName, peopleOf, isTold } from './prose.js';
import { featureNear, featName } from './names.js';

/** Raid harm at full severity, before raidRisk: fractions for damageSettlement; lootK = share carried off. */
export const RAID = {
  bandits: { pop: 0.008, wealth: 0.18, food: 0.12, buildings: 0, defense: 0.04, lootK: 0.7 },
  pirates: { pop: 0.012, wealth: 0.3, food: 0.12, buildings: 0.03, defense: 0.08, lootK: 0.8 },
  company: { pop: 0.02, wealth: 0.3, food: 0.25, buildings: 0.05, defense: 0.12, lootK: 0.7 },
  horde: { pop: 0.055, wealth: 0.5, food: 0.45, buildings: 0.14, defense: 0.4, lootK: 0.6 },
  migration: { pop: 0.004, wealth: 0.05, food: 0.2, buildings: 0, defense: 0, lootK: 0.5 },
  troll: { pop: 0.015, wealth: 0, food: 0.3, buildings: 0.02, defense: 0.05, lootK: 0 },
  giant: { pop: 0.02, wealth: 0.05, food: 0.2, buildings: 0.25, defense: 0.5, lootK: 0.1 },
  wyvern: { pop: 0.006, wealth: 0, food: 0.18, buildings: 0, defense: 0, lootK: 0 },
  treant: { pop: 0.004, wealth: 0, food: 0.2, buildings: 0.2, defense: 0.3, lootK: 0 },
  behemoth: { pop: 0.01, wealth: 0, food: 0.35, buildings: 0.05, defense: 0.1, lootK: 0 },
  kraken: { pop: 0.01, wealth: 0.05, food: 0.1, buildings: 0.05, defense: 0.1, lootK: 0 },
  undead: { pop: 0.07, wealth: 0, food: 0.1, buildings: 0.05, defense: 0.3, lootK: 0 },
  dragon: { pop: 0.05, wealth: 0.65, food: 0.3, buildings: 0.15, defense: 0.4, lootK: 0.9 },
};
/** Attack weight multipliers by kind (horse archers, the terror of a dragon). */
const ATTACK = { horde: 1.25, dragon: 1.6, giant: 1.2, undead: 1.1, pirates: 1.1 };

// ---------------------------------------------------------------------------
// Defence of a town

/** The town's defenders: garrison behind its works, plus its owner's armies within 2.5 tiles. */
export function townDefence(world, s, armies = true) {
  let d = Math.max(3, s.garrison || 0) * (1 + 0.45 * clamp(s.defense || 0, 0, 6));
  if (!armies) return d;
  for (const a of world.armies) {
    if (a.civId !== s.civId) continue;
    const dx = a.x - s.x, dy = a.y - s.y;
    if (dx * dx + dy * dy <= 6.25 && a.strength > 0) d += a.strength * 0.8;
  }
  return d;
}

const raidRiskOf = (world, s) => {
  const m = settlementMods(world, s);
  const v = m && Number.isFinite(m.raidRisk) ? m.raidRisk : 1;
  return v < 0 ? 0 : v;
};

/** Attack weight of a band against a town. */
export const attackOf = (band) => bandPower(band) * (ATTACK[band.kind] || 1);

/** Can this band hope to take something from s? (pure; used to pick targets) */
/** Screening only: the garrison behind its walls, without searching for armies nearby. */
export function looksSoft(world, band, s, margin = 0.7, attack = attackOf(band)) {
  return attack >= townDefence(world, s, false) * margin;
}

// ---------------------------------------------------------------------------
// Raids

/**
 * A band strikes town s. opts: { sevBonus, quiet, verb }. Returns
 * { ok, repulsed, deaths, loot, sev, destroyed, entry }.
 */
export function raidTown(world, band, s, opts = {}) {
  const rng = world.rng;
  const st = state(world);
  const out = { ok: false, repulsed: false, deaths: 0, loot: 0, sev: 0, destroyed: false, entry: null };
  if (!s || !s.alive) return out;
  const civ = world.civs[s.civId];
  const risk = raidRiskOf(world, s);
  const A = attackOf(band) * rng.float(0.6, 1.4);
  const D = townDefence(world, s) * rng.float(0.6, 1.4);
  const q = (A / Math.max(1e-6, A + D)) * Math.sqrt(Math.min(4, risk));
  noteRaid(world, band, s.civId);
  if (risk <= 0 || q < 0.5) {
    out.repulsed = true;
    const lost = isPeople(band) ? band.strength * rng.float(0.08, 0.25) : 0;
    if (isPeople(band)) band.strength = Math.max(0, band.strength - lost);
    else band.hp = clamp01((band.hp ?? 1) - rng.float(0.04, 0.15));
    band.morale = clamp((band.morale ?? 1) - 0.2, 0.05, 1.2);
    damageSettlement(world, s, { defense: 0.05, cause: band.kind });
    if (!opts.quiet) out.entry = repulseText(world, band, s, lost);
    return out;
  }
  const sev = clamp01((q - 0.5) * 2 + (opts.sevBonus || 0));
  const mul = (0.45 + 0.8 * sev) * Math.min(4, risk);
  const R = RAID[band.kind] || RAID.bandits;
  const w0 = s.wealth || 0, f0 = s.food || 0;
  const deaths = damageSettlement(world, s, {
    pop: R.pop * mul, wealth: R.wealth * mul, food: R.food * mul,
    buildings: R.buildings * mul, defense: R.defense * mul, cause: band.kind,
  });
  const loot = (Math.max(0, w0 - (s.wealth || 0)) + Math.max(0, f0 - (s.food || 0)) * 0.004) * R.lootK;
  band.loot = (band.loot || 0) + loot;
  band.raids = (band.raids || 0) + 1;
  band.kills = (band.kills || 0) + deaths;
  band.morale = clamp((band.morale ?? 1) + 0.08, 0.05, 1.2);
  band.data.last = world.time.day;
  st.stats.raids++;
  st.stats.kills += deaths;
  st.stats.loot += loot;
  Object.assign(out, { ok: true, deaths, loot, sev, destroyed: !s.alive });
  logRaid(world, band, s.x, s.y, sev);
  emit(world, 'bandRaid', { bandId: band.id, sid: s.id, routeId: null, loot, deaths, sunk: 0 });
  emitFx(world, { type: 'raid', x: s.x, y: s.y, r: 1.2 + sev * 1.5, intensity: 0.5 + sev * 0.5, x2: band.homeI % world.W, y2: (band.homeI / world.W) | 0, tone: band.family });
  if (!opts.quiet) out.entry = raidText(world, band, s, civ, out);
  return out;
}

const SIZE = ['camp', 'hamlet', 'village', 'town', 'city', 'great city', 'metropolis'];
const sizeWord = (s) => SIZE[Math.max(0, Math.min(6, s.tier | 0))];

function raidImp(band, s, r) {
  if (r.destroyed) return 3;
  if (band.kind === 'horde') return r.deaths >= 40 || s.tier >= 3 ? 3 : 2;
  // the dead are told as a great event only when they empty a town or kill hundreds
  if (band.kind === 'undead') return r.deaths >= 300 ? 3 : 2;
  // a beast's raid is notable when it kills or strikes a town; carried-off sheep are local talk
  if (isBeast(band)) return r.deaths >= 10 || s.tier >= 3 ? 2 : 1;
  // outlaws, pirates and companies make local news; only a sacked city is told as a great event
  if ((s.tier >= 3 && r.deaths >= 10) || r.deaths >= 30 || s.tier >= 4) return 2;
  return 1;
}

function raidText(world, band, s, civ, r) {
  let imp = raidImp(band, s, r);
  const undead = band.kind === 'undead';
  // a host on the march burns many towns: one of them a year is told as a great event (the
  // dead, one a decade)
  if (imp === 3 && !r.destroyed && !ready(world, `r3${band.id}`, (undead ? 10 : 1) * DAYS_PER_YEAR)) imp = 2;
  // routine outlaw raids on small places are folded and rate-limited per town
  if (imp <= 1 && !ready(world, `rt${s.id}`, 3 * DAYS_PER_YEAR)) return null;
  // notable raids: one per band every few years (beasts eight), and a town is told of once in
  // eight years (the dead too, however great the raid, unless the town is gone)
  const rn = (isBeast(band) ? 8 : 3) * DAYS_PER_YEAR, rs = 8 * DAYS_PER_YEAR;
  if (imp === 2 && (!isReady(world, `rn${band.id}`, rn) || !isReady(world, `rs${s.id}`, rs))) return null;
  if (imp === 3 && undead && !r.destroyed && !isReady(world, `rs${s.id}`, rs)) return null;
  if (imp >= 2) { ready(world, `rn${band.id}`, rn); ready(world, `rs${s.id}`, rs); }
  const lossFrac = r.deaths / Math.max(1, r.deaths + (s.population || 0));
  const B = BandName(band), b = bandName(band), T = s.name;
  const where = placePhrase(world, band.homeI % world.W, (band.homeI / world.W) | 0);
  const dead = count(r.deaths);
  const W = when(world, s.y);
  let text;
  if (r.destroyed) {
    text = pickFresh(world, band, 'raid', [
      `${W}, ${b} fell upon ${T} and left nothing standing; the ${sizeWord(s)} was not rebuilt.`,
      `${B} put ${T} to the torch, and its last people fled into the hills.`,
    ]);
  } else switch (band.kind) {
    case 'pirates':
      text = pickFresh(world, band, 'raid', [
        r.deaths >= 2 ? `${B} came ashore at ${T} under a black sail, looted its quays and carried off ${dead} captives.` : `${B} came ashore at ${T} under a black sail and looted its quays.`,
        `Pirates of ${b} raided the harbour of ${T} and burned the boats at anchor.`,
        `${W}, ${b} sacked ${T}${r.deaths > 5 ? `; ${dead} of its people died on the strand` : ''}.`,
      ]);
      break;
    case 'company':
      text = pickFresh(world, band, 'raid', [
        `Without a paymaster, ${b} lived off the country around ${T}, stripping its fields and granaries bare.`,
        `${B} plundered ${T}, taking by the sword the pay no prince would give them.`,
      ]);
      break;
    case 'horde':
      text = pickFresh(world, band, 'raid', [
        `${B} swept over ${T}; ${r.deaths > 5 ? `${dead} of its people died, and ` : ''}the riders rode on laden with its wealth.`,
        `${W}, the riders of ${b} burned ${T} and drove its herds before them.`,
        `${T} could not hold against ${b}: its gates were broken and its storehouses emptied.`,
      ]);
      break;
    case 'troll':
      text = pickFresh(world, band, 'raid', [
        `On a long winter night ${b} came down to ${T} and carried off sheep and herders alike.`,
        `${B} broke into the byres of ${T} in the dark of winter${Math.round(r.deaths) >= 2 ? `, and ${dead} villagers did not see the spring` : ''}.`,
      ]);
      break;
    case 'giant':
      text = pickFresh(world, band, 'raid', [
        `${B} strode down upon ${T} and stamped its houses flat${Math.round(r.deaths) >= 2 ? `, killing ${dead}` : ''}.`,
        `${W}, ${b} tore the roofs from ${T} and scattered its walls like kindling.`,
      ]);
      break;
    case 'wyvern':
      text = pickFresh(world, band, 'raid', [
        `${B} stooped on the herds of ${T}, and the shepherds learned to watch the sky.`,
        `${B} took cattle and children from the fields of ${T}.`,
      ]);
      break;
    case 'treant':
      text = pickFresh(world, band, 'raid', [
        `The forest woke: ${b} tore up the fields and fences of ${T} that had been cut from its wood.`,
        `${B} walked out of the trees and crushed the new farms of ${T} beneath its roots.`,
      ]);
      break;
    case 'behemoth':
      text = pickFresh(world, band, 'raid', [
        `${B} trampled the fields of ${T} on its long migration, and the harvest was lost.`,
        `The ground shook as ${b} passed through ${T}, leaving a road of ruin a mile wide.`,
      ]);
      break;
    case 'kraken':
      text = `${B} rose in the harbour of ${T} and dragged its fishing fleet beneath the waves.`;
      break;
    case 'undead':
      // the streets fall silent only when the town has lost a great share of its people
      text = lossFrac >= 0.4
        ? pickFresh(world, band, 'raid', [
          `${W}, ${b} fell upon ${T} in a grey mist, and in the morning its streets were silent.`,
          `The dead came to ${T}: ${b} overran its walls, and of every ten who had lived there, scarcely five saw the dawn.`,
        ])
        : pickFresh(world, band, 'raid', [
          `The dead came to ${T}: ${b} overran its walls${Math.round(r.deaths) >= 2 ? `, and ${dead} of the living rose again to march with them` : ''}.`,
          `${W}, ${b} came out of the mist against ${T}; its people held the inner streets with fire until the grey host drew off${Math.round(r.deaths) >= 2 ? `, taking ${dead} of them along` : ''}.`,
          `Bells rang all night in ${T} as ${b} beat upon its gates${Math.round(r.deaths) >= 2 ? `; by morning ${dead} of its people had joined the dead` : ''}.`,
        ]);
      break;
    default: // bandits
      text = imp <= 1
        ? pickFresh(world, band, 'raid', [
          `Outlaws of ${b} fell on ${T} by night and drove off its cattle.`,
          `${B} robbed the market of ${T} and vanished${where ? ' ' + where : ' into the wild'}.`,
          `${band.leader ? band.leader.name + "'s men" : B} burned the barns of ${T} and carried off its grain.`,
        ])
        : pickFresh(world, band, 'raid', [
          `${W}, ${b} sacked ${T}${Math.round(r.deaths) >= 2 ? `; ${dead} of its people were killed` : ''} and its storehouses emptied.`,
          `${B}${band.leader ? ` under ${band.leader.name}` : ''} plundered ${T}, and ${civ ? rulerOf(civ) : 'its lords'} could do nothing.`,
          `${T} was stripped by ${b}, who came out of ${where ? where.replace(/^in /, '') : 'the wild country'} in the dead of night.`,
        ]);
  }
  return say(world, band, {
    cat: isBeast(band) ? 'myth' : band.kind === 'horde' ? 'war' : 'civ', imp, text, x: s.x, y: s.y, civId: s.civId, sid: s.id,
    key: imp <= 1 ? 'band.raid.minor' : undead ? 'undead.raid' : isBeast(band) ? 'beast.raid' : 'band.raid', fold: imp <= 1,
  });
}

function repulseText(world, band, s, lost) {
  const notable = band.kind === 'horde' || band.kind === 'dragon' || (isBeast(band) && s.tier >= 3) || (lost >= 30 && isTold(band));
  if (!notable) {
    if (!ready(world, `rp${s.id}`, 4 * DAYS_PER_YEAR)) return null;
    return say(world, band, {
      cat: 'civ', imp: 1, fold: true, key: 'band.repulsed', x: s.x, y: s.y, civId: s.civId, sid: s.id,
      text: isBeast(band)
        ? pick(world, [`The people of ${s.name} drove ${bandName(band)} off with fire and spears.`, `${cap(bandName(band))} prowled about ${s.name} but found its gates barred.`])
        : pick(world, [`The garrison of ${s.name} beat off ${bandName(band)} at the gate.`, `${BandName(band)} tried ${s.name} and were driven off with loss.`]),
    });
  }
  if (!ready(world, `rpb${band.id}`, 2 * DAYS_PER_YEAR)) return null;
  return say(world, band, {
    cat: isBeast(band) ? 'myth' : band.kind === 'horde' ? 'war' : 'civ', imp: 2, key: 'band.repulsed', x: s.x, y: s.y, civId: s.civId, sid: s.id,
    text: isBeast(band)
      ? pick(world, [`${s.name} stood against ${bandName(band)}: its people fought it from the walls until it turned away, wounded.`, `The archers of ${s.name} drove ${bandName(band)} from the town.`])
      : pick(world, [`${cap(s.name)} held: ${bandName(band)} broke against its walls and left ${count(lost)} dead in the ditch.`, `The defenders of ${s.name} threw back ${bandName(band)}, who lost ${count(lost)} men beneath the walls.`]),
  });
}

// ---------------------------------------------------------------------------
// Ransom

/**
 * A strong host before a rich town demands to be bought off. Returns 'paid', 'refused' or null
 * (no demand made). Paid gold goes to the band and the town is spared.
 */
export function ransom(world, band, s) {
  const civ = world.civs[s.civId];
  if (!civ || !civ.alive || s.tier < 3) return null;
  if (band.kind === 'bandits' && band.strength < 200) return null;
  const D = townDefence(world, s);
  if (attackOf(band) < 1.4 * D) return null;
  if (!ready(world, `rx${band.id}`, 4 * DAYS_PER_YEAR)) return null;
  const rng = world.rng;
  const demand = Math.round(Math.min(Math.max(0, civ.treasury || 0) * 0.3, (s.wealth || 0) * 0.6 + 20));
  if (demand < 30) return null;
  const tr = civ.ruler?.traits || [];
  let p = 0.55;
  if (tr.includes('craven')) p *= 1.5;
  if (tr.includes('greedy')) p *= 0.55;
  if (tr.includes('warlike') || tr.includes('ambitious') || tr.includes('cruel')) p *= 0.55;
  if (tr.includes('cautious') || tr.includes('wise')) p *= 1.2;
  const st = state(world);
  if (rng.chance(clamp01(p))) {
    civ.treasury = Math.max(0, (civ.treasury || 0) - demand);
    band.loot = (band.loot || 0) + demand;
    st.stats.ransoms++;
    noteRaid(world, band, civ.id);
    logRaid(world, band, s.x, s.y, 0.3);
    say(world, band, {
      cat: band.kind === 'horde' ? 'war' : 'civ', imp: band.kind === 'bandits' && demand < 300 ? 2 : 3, key: 'band.ransom', x: s.x, y: s.y, civId: civ.id, sid: s.id,
      text: pick(world, [
        `${BandName(band)} encamped before ${s.name} and demanded ${money(demand)}; ${rulerOf(civ)} paid, and the ${sizeWord(s)} was spared.`,
        `${cap(s.name)} was held to ransom by ${bandName(band)}: ${money(demand)} in coin and plate went out of its gates, and the raiders rode away.`,
        `${when(world, s.y)}, ${rulerOf(civ)} bought off ${bandName(band)} at the gates of ${s.name} for ${money(demand)}.`,
      ]),
    });
    return 'paid';
  }
  // the refusal is told with the sack that follows; only a horde's is news in itself
  const told = band.kind === 'horde';
  say(world, band, {
    cat: told ? 'war' : 'civ', imp: told ? 2 : 1, fold: !told, key: 'band.ransom.refused', x: s.x, y: s.y, civId: civ.id, sid: s.id,
    text: pick(world, [
      `${cap(rulerOf(civ))} would not pay the ${money(demand)} that ${bandName(band)} demanded for ${s.name}.`,
      `${cap(s.name)} refused ${bandName(band)} its ransom and shut its gates.`,
    ]),
  });
  return 'refused';
}

// ---------------------------------------------------------------------------
// Roads and sea lanes

/** Route pressure 0.. from recent robberies (decays over two years). Pure. */
export function pressureOf(world, routeId) {
  const p = world.sys.bands?.press?.[routeId];
  if (!p) return 0;
  const age = (world.time.day - p.day) / DAYS_PER_YEAR;
  return age >= 2 ? 0 : p.n * (1 - age / 2);
}

/** The carrier (caravan or ship) on a route, or null. */
export function carrierOf(world, r) {
  if (!r || r.carrierId == null) return null;
  for (const c of world.caravans) if (c.id === r.carrierId) return c;
  return null;
}

/** Breaks the route through geo/trade (route id first, the older object form second). */
function breakRouteSafe(world, r, cause) {
  const t = links.trade;
  if (!t || typeof t.breakRoute !== 'function') return false;
  try { t.breakRoute(world, r.id, cause); } catch (e) { /* older signature */ }
  if (r.active) { try { t.breakRoute(world, r, cause); } catch (e) { return false; } }
  return !r.active;
}

/**
 * A band waylays route r: robs its carrier when there is one (else harasses travellers).
 * Raises the road's pressure; at the second robbery it is called perilous, at the fourth within
 * two years it is abandoned. Returns the loot.
 */
export function robRoute(world, band, r, opts = {}) {
  const st = state(world);
  if (!r || !r.active) return 0;
  const c = carrierOf(world, r);
  let loot = 0;
  const sea = r.kind === 'sea';
  if (c) {
    loot = Math.max(1, (c.value || r.value || 1) * (sea ? 4 : 3));
    removeEntity(world, 'caravans', c.id);
    // trade.js only sends a new carrier down a route whose carrier slot is empty
    if (r.carrierId === c.id) r.carrierId = null;
    if (sea) st.stats.sunk++; else st.stats.robbed++;
    emit(world, 'bandRaid', { bandId: band.id, sid: null, routeId: r.id, loot, deaths: sea ? world.rng.int(3, 20) : world.rng.int(1, 6), sunk: sea ? 1 : 0 });
  } else loot = Math.max(0.5, (r.value || 1) * 0.6);
  band.loot = (band.loot || 0) + loot;
  band.raids = (band.raids || 0) + 1;
  band.data.last = world.time.day;
  st.stats.loot += loot;
  const p = (st.press[r.id] ||= { n: 0, day: world.time.day, warned: 0 });
  p.n = pressureOf(world, r.id) + 1;
  p.day = world.time.day;
  const a = world.settlements[r.aId], b = world.settlements[r.bId];
  const px = c ? c.x : band.x, py = c ? c.y : band.y;
  logRaid(world, band, px, py, 0.4);
  emitFx(world, { type: 'raid', x: px, y: py, r: 1, intensity: 0.45, tone: band.family });
  for (const s of [a, b]) if (s && s.alive) noteRaid(world, band, s.civId);
  const A = a ? a.name : 'the coast', Bn = b ? b.name : 'the far markets';
  const lane = r.name || (sea ? `the sea road from ${A} to ${Bn}` : `the road from ${A} to ${Bn}`);
  // a road is given up at the third robbery in two years, and one band closes at most one road in six years
  const famousRoad = Boolean(r.name) || (r.value || 0) >= 20;
  if (p.n >= 4 && isReady(world, `rb${band.id}`, 6 * DAYS_PER_YEAR) && breakRouteSafe(world, r, band.kind === 'pirates' ? 'pirates' : 'bandits')) {
    ready(world, `rb${band.id}`, 6 * DAYS_PER_YEAR);
    st.stats.routesBroken++;
    delete st.press[r.id];
    say(world, band, {
      cat: 'trade', imp: famousRoad ? 2 : 1, fold: !famousRoad, key: 'band.road.closed', x: Math.round(px), y: Math.round(py), civId: a ? a.civId : null, sid: a ? a.id : null,
      text: sea
        ? pick(world, [`The merchants of ${A} gave up ${lane}; ${bandName(band)} had taken too many of their ships.`, `No more ships sailed ${lane}: ${bandName(band)} owned those waters now.`])
        : pick(world, [`The merchants of ${A} gave up ${lane}, which ${bandName(band)} had made a road of graves.`, `Caravans no longer dared ${lane}; ${bandName(band)} had robbed them once too often.`]),
    });
    return loot;
  }
  if (p.n >= 2 && !p.warned) {
    p.warned = 1;
    say(world, band, {
      cat: 'trade', imp: famousRoad && isTold(band) ? 2 : 1, fold: !(famousRoad && isTold(band)), key: 'band.road.perilous', x: Math.round(px), y: Math.round(py), civId: a ? a.civId : null, sid: a ? a.id : null,
      text: sea
        ? pick(world, [`${cap(lane)} grew perilous: ${bandName(band)} had taken ${c ? 'another' : 'a'} merchantman, and shipmasters sailed only in convoy.`, `Insurers in ${A} would no longer cover ships bound for ${Bn} while ${bandName(band)} roamed the lane.`])
        : pick(world, [`${cap(lane)} grew perilous; ${bandName(band)} preyed on its caravans, and merchants began to travel armed.`, `Travellers between ${A} and ${Bn} learned to fear ${bandName(band)}, who robbed the road again and again.`]),
    });
  } else if (c && !opts.quiet && ready(world, `rr${band.id}`, 2 * DAYS_PER_YEAR)) {
    const beast = isBeast(band);
    say(world, band, {
      cat: beast ? 'myth' : 'trade', imp: 1, fold: true, key: sea ? 'band.ship.taken' : 'band.ambush', x: Math.round(px), y: Math.round(py), civId: c.civId ?? null,
      text: beast
        ? sea
          ? `${BandName(band)} dragged a ship bound for ${Bn} beneath the waves.`
          : pick(world, [`${BandName(band)} fell upon a caravan on the road from ${A} to ${Bn} and left nothing but bones.`, `${BandName(band)} carried off the pack animals of a caravan bound for ${Bn}.`])
        : sea
          ? pick(world, [`${BandName(band)} took a merchantman bound for ${Bn}.`, `A ship out of ${A} was boarded and burned by ${bandName(band)}.`])
          : pick(world, [`Outlaws of ${bandName(band)} waylaid a caravan on the road from ${A} to ${Bn}.`, `${BandName(band)} robbed a caravan of its ${world.rng.chance(0.5) ? 'silver' : 'cloth and salt'} on the way to ${Bn}.`]),
    });
  }
  return loot;
}

/** Active routes whose path passes within r tiles of (x, y), nearest first: [{ r, i, d }]. */
/** Active routes, in id order: trade's live index when it is loaded (world.tradeRoutes holds every route ever made). */
export function liveRoutes(world) {
  const t = links.trade;
  return t && typeof t.activeRouteList === 'function' ? t.activeRouteList(world) : world.tradeRoutes;
}

export function routesNear(world, x, y, rad, kind = null) {
  const out = [];
  const W = world.W, r2 = rad * rad;
  for (const r of liveRoutes(world)) {
    if (!r || !r.active || !r.path || r.path.length < 2) continue;
    if (kind && r.kind !== kind) continue;
    let best = -1, bd = r2;
    const p = r.path;
    const stride = p.length > 40 ? 2 : 1;
    for (let k = 1; k < p.length - 1; k += stride) {
      const i = p[k];
      const dx = (i % W) - x, dy = ((i / W) | 0) - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) out.push({ r, i: best, d: Math.sqrt(bd) });
  }
  out.sort((a, b) => a.d - b.d || a.r.id - b.r.id);
  return out;
}

// ---------------------------------------------------------------------------
// Armies against bands

/** The ground's help to a band (outlaws in woods and hills, beasts at their lairs). */
function bandTerrain(world, band, i) {
  const f = world.f;
  if (f.water[i] !== WATER.LAND) return 1;
  let t = 1;
  const b = f.biome[i];
  if (isPeople(band)) {
    if (b === BIOME.TEMPERATE_FOREST || b === BIOME.TAIGA || b === BIOME.RAINFOREST || b === BIOME.TEMPERATE_RAINFOREST || b === BIOME.TROPICAL_FOREST || b === BIOME.WETLAND) t *= 1.25;
    if (f.elevation[i] >= 0.62) t *= 1.15;
  } else if (i === band.homeI) t *= 1.25;
  return t;
}

/**
 * An army fights a band. opts: { hunt, quiet, name }. Returns { armyWon, d, deadA, deadB,
 * bandGone, slain, entry }. The band's family decides the kernel loss source.
 */
const scourge = (band) => band.kind === 'undead' && Boolean(band.data && band.data.sc && band.data.sc.named);

export function clash(world, army, band, opts = {}) {
  const rng = world.rng;
  const civ = world.civs[army.civId];
  const i = tileOf(world, band.x, band.y);
  const m = civ?.mods || {};
  const holy = band.kind === 'undead' && civ && civ.stateReligion != null ? 1.3 : 1;
  let eA = Math.max(1, army.strength) * (m.military || 1) * (0.4 + 0.6 * clamp01(army.morale ?? 1)) * (army.flags?.skill || 1) * holy;
  eA *= mulOf('battle', world, { army, enemy: band, i, side: 'a' });
  eA *= rng.float(0.75, 1.3);
  const eB = Math.max(1, bandPower(band)) * bandTerrain(world, band, i) * (band.kind === 'horde' ? 1.15 : 1) * rng.float(0.75, 1.3);
  const p = eA / (eA + eB);
  const armyWon = p >= 0.5;
  const d = Math.abs(p - 0.5) * 2;
  const s0 = army.strength;
  let deadA, deadB = 0, bandGone = false, slain = false;
  if (armyWon) {
    deadA = s0 * clamp(0.03 + 0.12 * (1 - d) + rng.next() * 0.05, 0.02, 0.35);
    if (isPeople(band)) {
      deadB = band.strength * clamp(0.25 + 0.5 * d + rng.next() * 0.1, 0.15, 0.95);
      band.strength -= deadB;
      band.morale = clamp((band.morale ?? 1) - 0.35, 0.05, 1.2);
      if (d > 0.35 || band.strength < 12) bandGone = true;
    } else if (scourge(band)) {
      // a Scourge (myth/sickness.js) is ground down, not felled: each defeat costs it a share of its dead
      band.power *= 1 - clamp(0.12 + 0.3 * d + rng.next() * 0.05, 0.1, 0.5);
      if (band.power < 20) { bandGone = true; slain = true; }
    } else {
      band.hp = clamp01((band.hp ?? 1) - (0.3 + 0.7 * d) * (band.kind === 'dragon' ? 0.6 : 1));
      if (band.hp <= 0.08) { bandGone = true; slain = true; }
    }
  } else {
    deadA = s0 * clamp(0.15 + 0.45 * d + rng.next() * 0.1, 0.1, 0.85);
    if (isPeople(band)) { deadB = band.strength * rng.float(0.04, 0.14); band.strength -= deadB; band.morale = clamp((band.morale ?? 1) + 0.1, 0.05, 1.2); }
    else if (scourge(band)) band.power *= 1 - rng.float(0.02, 0.08);
    else band.hp = clamp01((band.hp ?? 1) - rng.float(0.04, 0.18));
    army.morale = clamp((army.morale ?? 1) - (0.25 + 0.35 * d), 0.05, 1.2);
  }
  deadA = damageArmy(world, army, deadA, isBeast(band) ? 'beast' : 'band');
  if (scourge(band) && !slain) band.power += 0.6 * deadA;   // the fallen rise into it
  band.kills = (band.kills || 0) + deadA;
  state(world).stats.kills += deadA;
  if (civ) noteRaid(world, band, civ.id);
  const great = band.kind === 'dragon' || band.kind === 'horde' || deadA + deadB >= 400;
  const name = great ? opts.name || fightName(world, band, i) : null;
  emit(world, 'battle', {
    day: world.time.day, x: Math.round(band.x), y: Math.round(band.y), i, warId: army.warId ?? null,
    kind: isBeast(band) ? 'beast' : 'band',
    attackerId: opts.hunt ? army.civId : -1, defenderId: opts.hunt ? -1 : army.civId,
    winnerCivId: armyWon ? army.civId : -1, loserCivId: armyWon ? -1 : army.civId, bandId: band.id,
    dead: { a: Math.round(opts.hunt ? deadA : deadB), d: Math.round(opts.hunt ? deadB : deadA) },
    engaged: Math.round(s0 + (isPeople(band) ? band.strength + deadB : band.power || 0)), name, great,
  });
  emitFx(world, { type: 'battle', x: band.x, y: band.y, intensity: Math.min(1, (deadA + deadB) / 300 + 0.3) });
  const out = { armyWon, d, deadA, deadB, bandGone, slain, entry: null, name };
  if (!opts.quiet) out.entry = clashText(world, army, band, civ, out);
  if (bandGone) {
    if (slain) slayBand(world, band, civ, { how: 'army', army, name: (army.general && typeof army.general === 'object' ? army.general.name : army.general) || null, cause: out.entry ? out.entry.seq : Number.isFinite(army.flags?.hseq) ? army.flags.hseq : null });
    else endBand(world, band, opts.hunt ? 'hunted' : 'destroyed');
  }
  return out;
}

function fightName(world, band, i) {
  const x = i % world.W, y = (i / world.W) | 0;
  const near = settlementsNear(world, x, y, 6);
  let s = null, bd = Infinity;
  for (const t of near) { const d = (t.x - x) ** 2 + (t.y - y) ** 2; if (d < bd) { bd = d; s = t; } }
  const ft = featureNear(world, x, y, ['range', 'forest', 'river', 'lake', 'desert'], 8);
  if (band.kind === 'dragon') return pick(world, [`the Wyrm-fight ${ft ? 'of ' + featName(ft) : s ? 'of ' + s.name : 'on the Heights'}`, `the Burning of the Host${s ? ' at ' + s.name : ''}`]);
  const place = s ? s.name : ft ? featName(ft) : null;
  return place ? pick(world, [`the Battle of ${place}`, `the Fight at ${place}`, `the Slaughter at ${place}`]) : null;
}

function clashText(world, army, band, civ, r) {
  const where = placePhrase(world, band.x, band.y);
  const A = army.name || `the soldiers of ${civName(civ)}`;
  const B = bandName(band);
  const famous = (band.raids || 0) >= 15 && (band.loot || 0) >= 1500;
  let imp = band.kind === 'horde' ? 3
    : isPeople(band) ? ((r.bandGone && famous) || r.deadA >= 150 ? 3 : 2)
      : r.deadA >= 800 || (band.kind === 'dragon' && r.deadA >= 500) ? 3 : 2;
  if (r.slain) return null; // the kind's slaying writes the epitaph
  // an indecisive skirmish is routine, and so is the end of a band the chronicle never told of,
  // or a beast's mauling of a few levies
  const obscure = (r.bandGone && isPeople(band) && imp < 3 && !isTold(band)) || (isBeast(band) && imp < 3 && r.deadA < 100);
  // a beast wounded and driven off is the hunt's middle, not its end: a dragon's wounding is
  // told once in five years, a horde's mauling as before, the rest are routine
  if (r.armyWon && !r.bandGone && isBeast(band)) imp = band.kind === 'dragon' && ready(world, `dw${band.id}`, 5 * DAYS_PER_YEAR) ? 2 : 1;
  const routine = (r.armyWon && !r.bandGone && imp < 3 && !(isBeast(band) && imp === 2)) || obscure;
  if (routine) { if (!obscure && !ready(world, `cl${band.id}`, DAYS_PER_YEAR)) return null; imp = 1; }
  else if (!r.armyWon && imp < 3 && !ready(world, `ca${band.id}`, 2 * DAYS_PER_YEAR)) return null;
  let text;
  if (r.armyWon && r.bandGone) {
    text = isPeople(band)
      ? pick(world, [
        `${cap(A)} ran ${B} to ground${where ? ' ' + where : ''}; ${count(r.deadB)} of them died in the fighting and their captains were hanged.`,
        `${when(world, band.y)}, ${A} caught ${B}${where ? ' ' + where : ''} and destroyed them${band.leader ? `; ${band.leader.name} was taken in chains to ${civ ? civName(civ) : 'the capital'}` : ''}.`,
        `${cap(civName(civ))} was rid of ${B}: ${A} scattered them${where ? ' ' + where : ''} and burned their camp.`,
      ])
      : `${cap(A)} destroyed ${B}${where ? ' ' + where : ''}.`;
  } else if (r.armyWon) {
    text = isPeople(band)
      ? pick(world, [`${cap(A)} mauled ${B}${where ? ' ' + where : ''}, but the survivors slipped away.`, `${BandName(band)} lost ${count(r.deadB)} men to ${A} and fled.`])
      : pick(world, [`${cap(A)} wounded ${B}${where ? ' ' + where : ''} and drove it back to its lair.`, `${BandName(band)} was driven off by ${A}, bleeding, but it lived.`]);
  } else {
    text = isPeople(band)
      ? pick(world, [`${BandName(band)} ambushed ${A}${where ? ' ' + where : ''} and cut it to pieces; ${count(r.deadA)} soldiers fell.`, `${cap(A)} went after ${B} and came back with ${count(r.deadA)} fewer men.`])
      : pick(world, [`${BandName(band)} fell upon ${A}${where ? ' ' + where : ''}; ${count(r.deadA)} soldiers died before the rest broke and ran.`, `${cap(A)} met ${B}, and ${count(r.deadA)} of them never came home.`]);
  }
  if (r.name && imp >= 3) text = text.replace(/\.$/, `, in what was afterwards called ${r.name}.`);
  // outlaws against the realm's levies are a matter of law and order; hosts and beasts are not
  const cat = isBeast(band) ? 'myth' : band.kind === 'horde' || band.kind === 'company' ? 'war' : 'civ';
  // the hunt that set out against the band is the cause of its end (and of its fights)
  const hseq = Number.isFinite(army.flags?.hseq) ? army.flags.hseq : null;
  return say(world, band, { cat, imp, fold: routine, text, key: r.bandGone ? 'band.destroyed' : r.armyWon ? 'band.skirmish' : 'band.ambush.army', civId: army.civId, x: Math.round(band.x), y: Math.round(band.y), cause: hseq });
}

/** Who may fight whom: the band's employer, tamer or patron is never its enemy. */
export const hostile = (band, civId) => band.civId !== civId;

/**
 * Every ten days: armies that come within 1.5 tiles of a band in the field fight it (hunts
 * are resolved by hunts.js; hired and tamed bands march with their own side; sleeping
 * dragons and krakens are left alone). People-bands that are clearly outmatched usually slip
 * away instead.
 */
/** Registered with the engine (engineHooks.clashScan): see engine.js on why it is not imported there. */
export function clashScan(world) {
  const armies = world.armies;
  if (!armies.length || !world.bands.length) return;
  let v = world.versions.bands, live = null;
  for (const band of world.bands.slice()) {
    if (band.state === 'hired' || band.state === 'tamed' || band.state === 'sleep' || band.kind === 'kraken') continue;
    if (world.versions.bands !== v) { live = new Set(); for (const b of world.bands) live.add(b.id); v = world.versions.bands; }
    if (live && !live.has(band.id)) continue;
    const bx = band.x, by = band.y;
    const wet = world.f.water[tileOf(world, bx, by)] !== WATER.LAND;
    for (const a of armies) {
      const dx = a.x - bx, dy = a.y - by;
      if (dx * dx + dy * dy > 2.25) continue;
      if (a.flags?.hunt != null || a.flags?.merc === band.id || !hostile(band, a.civId)) continue;
      if (Boolean(a.naval) !== wet || !(a.strength >= 8)) continue;
      if (isPeople(band) && a.strength > 2 * bandPower(band) && world.rng.chance(0.7)) break;   // they melt away
      clash(world, a, band, {});
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Storming a town and founding a state

/** Storm town s: { won, ratio }. The band takes losses either way. */
export function assault(world, band, s) {
  const rng = world.rng;
  const A = attackOf(band) * rng.float(0.75, 1.25);
  const D = townDefence(world, s) * rng.float(0.75, 1.25) * 1.15;
  const ratio = A / Math.max(1, D);
  const won = ratio >= 1.25;
  if (isPeople(band)) band.strength = Math.max(0, band.strength * (1 - clamp(0.25 / Math.max(0.5, ratio), 0.04, 0.5)));
  band.morale = clamp((band.morale ?? 1) + (won ? 0.1 : -0.3), 0.05, 1.2);
  noteRaid(world, band, s.civId);
  return { won, ratio };
}

const REALM_GOV = { company: 'chiefdom', horde: 'horde', pirates: 'chiefdom' };

/**
 * The band makes town s the seat of its own state. realmKind: 'company' | 'horde' | 'pirates'.
 * Returns the new civ, or null (when the town cannot change hands).
 */
/** The one-word root of a horde's name ("the Great Horde of Elouly", "the Taru Host"), or null. */
function hordeRoot(band) {
  const m = /^the (?:Great )?Horde of (\S+)$/.exec(band.name || '') || /^the (\S+) (?:Horde|Host)$/.exec(band.name || '') || /^the Riders of (\S+)$/.exec(band.name || '');
  const w = m ? m[1] : null;
  return w && /^[A-Z][\w'’-]*$/.test(w) && w !== 'Golden' ? w : null;
}

export function foundRealm(world, band, s, realmKind, cause = null) {
  const old = world.civs[s.civId];
  if (!s || !s.alive || !old) return null;
  const st = state(world);
  const lang = band.data.lang || old.language;
  let baseName = s.name;
  // a horde's realm takes the name the riders were known by ("the Horde of Elouly" → Elouly)
  if (realmKind === 'horde') baseName = hordeRoot(band) || band.data.word || baseName;
  if (realmKind === 'pirates' && band.data.isle) baseName = band.data.isle;
  const era = old.tech?.era || 0;
  const gov = realmKind === 'horde' && era < 1 ? 'chiefdom' : REALM_GOV[realmKind] || 'chiefdom';
  // the new state descends from the host's homeland when it has one, else from the realm it
  // tore the town from (so the civ module hands it that realm's knowledge and faith)
  const origin = band.originCivId >= 0 && world.civs[band.originCivId]?.alive ? band.originCivId : old.id;
  const civ = createCiv(world, {
    name: baseName, adjective: adjectiveOf(baseName, lang), language: JSON.parse(JSON.stringify(lang)),
    government: gov, parentId: origin, x: s.x, y: s.y,
  });
  st.realms[civ.id] = realmKind;
  const ok = transferSettlement(world, s.id, civ.id, 'conquest');
  if (!ok) { delete st.realms[civ.id]; killCiv(world, civ.id, 'collapse'); return null; }
  civ.treasury = (civ.treasury || 0) + (band.loot || 0) * 0.6;
  addShaped(world, s, Math.max(0, band.strength || 0) * 0.45, 'levy', civ);   // the host settles: fighting men
  st.stats.realms++;
  emitFx(world, { type: 'rebellion', x: s.x, y: s.y, civId: civ.id });
  const L = band.leader ? band.leader.name : null;
  const OLD = civName(old), NEW = civName(civ);
  const text = realmKind === 'horde'
    ? pick(world, [
      `${when(world, s.y)}, ${bandName(band)} took ${s.name}, and ${L ? L + ' proclaimed' : 'its khans proclaimed'} ${NEW} from its walls; ${OLD} had lost one of its jewels to the steppe.`,
      `${cap(s.name)} fell to ${bandName(band)}. The riders did not leave: ${L || 'their khan'} made it the seat of ${NEW}.`,
    ])
    : realmKind === 'pirates'
      ? pick(world, [
        `${BandName(band)} made ${s.name} their own, and ${L || 'their captain'} took the title of ${world.rng.chance(0.5) ? 'Sea-Lord' : 'Pirate King'} of ${NEW}.`,
        `The pirates of ${bandName(band)} took ${s.name} from ${OLD} and founded ${NEW}, a haven for every outlaw of the sea.`,
      ])
      : pick(world, [
        `${when(world, s.y)}, the unpaid captains of ${bandName(band)} seized ${s.name} from ${OLD} and proclaimed it a free state, ${NEW}.`,
        `${BandName(band)} turned on the realm that had hired them: they took ${s.name}${L ? `, and ${L} ruled it as ${NEW}` : ` and made it ${NEW}`}.`,
      ]);
  say(world, band, { cat: 'civ', imp: 4, key: 'band.realm', x: s.x, y: s.y, civId: civ.id, sid: s.id, text, cause, ref: { k: 'civ', id: civ.id } });
  endBand(world, band, 'settled');
  return civ;
}

export { peopleOf };

engineHooks.clashScan = clashScan;
