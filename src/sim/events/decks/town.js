// The town deck: city life. Towns burn (crowding, dry seasons, timber and the lack of stone
// set the odds; a town may rise again 'rebuilt in stone'), riot over bread, revolt through
// their guilds (a Free City through WP3's splitCiv at era ≥ 3), boom on a strike and go bust
// when the seam gives out, hold great fairs, shut their gates against plague or panic at it,
// feast the siege they endured, rebuild after the flood, draw pilgrims, keep their
// centenaries, raise great works, foul their wells, take in refugees and turn on their
// minorities. Every event changes the town through effects, damage or traits and heats what
// comes next (a fire heats 'blame' and 'rebuild', a boom 'crowding', a fair 'crowds').

import { registerEvent } from '../../../core/events.js';
import { ageShares, youthLean, eldersLean } from '../../../core/cohorts.js';
import { on } from '../../../core/hooks.js';
import { damageSettlement, settlementsNear } from '../../../core/entities.js';
import { settlementMods } from '../../../core/effects.js';
import { emitFx } from '../../../core/world.js';
import { BIOMES, DAYS_PER_YEAR, TIERS } from '../../../core/constants.js';
import { record, effect, heat, T, hasTech, splitAway, boostFaith, evState, routesOf } from '../engine.js';
import { SUBJ, addHeat, spendHeat } from '../heat.js';
import { addTrait, hasTrait, bumpHist, cityMem } from '../character.js';
import {
  pick, say, cap, civName, peopleOf, rulerName, rulerShort, his, shortWord,
  seasonWord, seasonIdx, countWord, ordinal, shareWord, peopleCount, quarter, riverAt, featureNear,
} from '../prose.js';

const Y = DAYS_PER_YEAR;
const TF = [0, 0.25, 0.5, 1, 1.4, 1.8, 2.2];
const tierName = (s) => (TIERS[s.tier]?.name || 'town').toLowerCase();
const isCapital = (world, s) => world.civs[s.civId]?.capitalId === s.id;
const lvl = (s, k) => (s.buildings && +s.buildings[k]) || 0;
const kind = (ruler) => ['generous', 'just', 'charismatic', 'wise', 'pious'].some((t) => ruler && ruler.traits && ruler.traits.includes(t));
const harsh = (ruler) => ['cruel', 'paranoid', 'warlike', 'mad'].some((t) => ruler && ruler.traits && ruler.traits.includes(t));

function minorityFaith(world, s) {
  const sh = s.religion;
  if (!sh) return null;
  let best = null, bv = 0.08;
  for (const k in sh) {
    const id = Number(k);
    if (id === s.dominantReligion) continue;
    if (sh[k] > bv) { bv = sh[k]; best = world.religions[id] || null; }
  }
  return best && best.alive !== false ? best : null;
}
/** Trade routes touching the town, as counted at New Year (engine.countRoutes). */
const routesAt = (ctx) => routesOf(ctx.world, ctx.s.id);
const activePlagueOf = (world, s) => {
  if (!s.disease) return null;
  const p = world.plagues[s.disease.pid];
  return p && p.active ? p : null;
};

// ---------------------------------------------------------------------------
// Hooks that prime towns

on('depositExhausted', (world, p) => {
  const s = p && world.settlements[p.sid];
  if (s && s.alive && world.sys.events) addHeat(world, 'bust', SUBJ.town(s.id), 1);
});
on('flood', (world, p) => {
  if (!p || !Array.isArray(p.towns) || !world.sys.events) return;
  for (const sid of p.towns.slice(0, 8)) {
    const s = world.settlements[sid];
    if (s && s.alive) addHeat(world, 'flood', SUBJ.town(s.id), 1);
  }
});
// raiders (WP2) leave fear behind them: towns raise walls and forts
on('bandRaid', (world, p) => {
  const s = p && p.sid != null ? world.settlements[p.sid] : null;
  if (!s || !s.alive || !world.sys.events) return;
  addHeat(world, 'fear', SUBJ.town(s.id), 0.5);
  if ((p.deaths || 0) > 0) addHeat(world, 'rebuild', SUBJ.town(s.id), 0.2);
});
on('famine', (world, p) => {
  const s = p && world.settlements[p.sid];
  if (!s || !s.alive || !world.sys.events) return;
  addHeat(world, 'hunger', SUBJ.town(s.id), 0.8);
  const lm = world.f.landmass[s.i];
  if (lm >= 0) addHeat(world, 'misery', SUBJ.land(lm), 0.08);
});

// ---------------------------------------------------------------------------
// Great fire

const FIRE_CAUSE = ['in a baker’s oven', 'from an overturned lamp', 'when lightning struck the granary', 'in a smith’s forge', 'at a wedding feast', 'from the sparks of a potter’s kiln', 'among the hay of a stable', 'in a dyer’s vat-house'];
function fireOdds(ctx) {
  const { world, s, civ } = ctx;
  if (s.tier < 2) return 0;
  const { f } = world;
  const crowd = Math.max(0.5, Math.min(2, s.population / Math.max(20, s.housing || s.population)));
  const dry = 1 + 1.5 * (1 - Math.max(0, Math.min(1, f.soilWater[s.i])));
  const si = seasonIdx(world, s.y);
  const season = si === 2 || si === 3 ? 1.4 : si === 0 ? 1.1 : 0.8;
  const wood = 0.4 + 0.6 * (BIOMES[f.biome[s.i]]?.wood || 0);
  let protect = 1;
  if (hasTech(civ, 'masonry')) protect *= 0.8;
  if (hasTech(civ, 'engineering')) protect *= 0.8;
  if (hasTech(civ, 'sanitation')) protect *= 0.6;
  return 0.003 * TF[s.tier] * crowd * dry * season * wood * protect * settlementMods(world, s).fireRisk * (s.sick && Number.isFinite(s.sick.fr) ? s.sick.fr : 1) * (1 + 0.5 * ctx.heat('crowding'));
}
registerEvent({
  id: 'town.great_fire', scale: 'town', minTier: 2, family: 'fire', cat: 'disaster', imp: 2, cooldownYears: 30, chain: ['crowding'],
  label: 'Great fire', icon: 'fire', hint: ['1–5% of the people die; wealth −20–50%', 'production −10% for 15 years', 'may be rebuilt in stone'],
  weight: fireOdds,
  fire(ctx) {
    const { world, s, civ } = ctx;
    const pop0 = s.population;
    const frac = world.rng.float(0.01, 0.05) * (s.tier >= 4 ? 0.7 : 1);
    const dead = damageSettlement(world, s, { pop: frac, wealth: world.rng.float(0.2, 0.5), buildings: 0.3, food: 0.15, cause: 'fire' });
    bumpHist(world, s, 'fires');
    const stone = s.alive && hasTech(civ, 'masonry') && !hasTrait(s, 'rebuilt in stone') && world.rng.chance(0.5);
    const days = world.rng.int(2, 9);
    const v = {
      town: s.name, quarter: quarter(world, s), cause: pick(world, FIRE_CAUSE), dead: peopleCount(world, dead), days: countWord(days),
      share: shareWord(world.rng.float(0.15, 0.5)), ruler: civ ? rulerName(civ.ruler) : 'the elders', season: cap(seasonWord(world, s.y)),
      wind: pick(world, ['east wind', 'summer gale', 'hot wind off the hills', 'north wind']), how: stone ? 'in stone' : 'in timber as before',
    };
    const text = say(world, [
      '{season} fire broke out {cause} in {quarter} of {town} and burned for {days} days; {dead} died and {share} of the {tier} lay in ashes.',
      'The Great Fire of {town} began {cause} and swept through {quarter}; when it was out, {dead} were dead and {ruler} ordered the {tier} rebuilt {how}.',
      'Fanned by a dry {wind}, a fire that began {cause} consumed {quarter} of {town}; {dead} perished in the smoke.',
    ], { ...v, tier: tierName(s) });
    record(ctx, { text, imp: s.tier >= 4 || dead >= 400 || dead >= 0.04 * pop0 ? 3 : 2, icon: 'fire' });
    if (!s.alive) return true;
    effect(ctx, T.s(s), 'rebuilding', { production: 0.9 }, 15, 'Rebuilding after the fire');
    if (stone) addTrait(world, s, 'rebuilt in stone', ctx.entry.seq);
    heat(ctx, 'rebuild', 1);
    spendHeat(world, 'crowding', ctx.subject, 0.7);
    if (minorityFaith(world, s)) { heat(ctx, 'blame', 0.8); cityMem(world, s.id).blame = 'fire'; }
    heat(ctx, 'unrest', 0.3);
    emitFx(world, { type: 'fire', x: s.x, y: s.y, r: 1.5 });
    return true;
  },
});

// ---------------------------------------------------------------------------
// Bread riot, guild revolt, persecution

function hungry(ctx) {
  const s = ctx.s;
  return s.famine >= 1 || (s.foodNeed > 0 && s.food < s.foodNeed) || ctx.heat('hunger') > 0.3;
}
registerEvent({
  id: 'town.bread_riot', scale: 'town', minTier: 2, family: 'unrest', cat: 'civ', imp: 2, minEra: 1, cooldownYears: 12, chain: ['hunger', 'tax', 'unrest'],
  label: 'Bread riot', icon: 'riot', hint: ['unrest +0.2 for 3 years, or crushed (deaths, loyalty −)', 'a generous ruler opens the granaries'],
  weight(ctx) {
    const { s, civ } = ctx;
    if (s.tier < 2 || !civ || !hungry(ctx)) return 0;
    const sore = (civ.taxRate || 0) > 0.12 || s.unrest > 0.35 || ctx.heatCiv('tax') > 0.3;
    if (!sore) return 0;
    // a youth bulge makes the crowd readier, an ageing town calmer (the town's age bands)
    const ag = ageShares(s.cohorts);
    return 0.03 * TF[s.tier] * (1 + ctx.heat('hunger') + ctx.heatCiv('tax')) * youthLean(ag.youth) / eldersLean(ag.elders);
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const r = civ.ruler;
    const v = { town: s.name, ruler: rulerName(r), short: rulerShort(r), market: pick(world, ['the grain market', 'the bakers’ row', 'the granary gates', 'the temple steps']), his: his(r) };
    bumpHist(world, s, 'riots');
    emitFx(world, { type: 'riot', x: s.x, y: s.y, r: 1 });
    if (harsh(r) && !kind(r)) {
      const dead = damageSettlement(world, s, { pop: world.rng.float(0.004, 0.01), cause: 'riot' });
      record(ctx, { text: say(world, [
        'When the hungry of {town} stormed {market}, {ruler} sent soldiers into the crowd; {dead} were cut down, and the town did not forget.',
        'A bread riot in {town} was drowned in blood on the orders of {short}; the bodies were left at {market} as a warning.',
      ], { ...v, dead: peopleCount(world, dead) }) });
      effect(ctx, T.s(s), 'riot', { loyalty: -0.15, unrest: -0.1 }, 6, 'Riot crushed');
      heat(ctx, 'grudge', 0.6, SUBJ.realm(civ.id));
    } else if (kind(r)) {
      record(ctx, { text: say(world, [
        'Hungry crowds broke into {market} of {town}; {ruler} answered by opening the royal granaries and cutting the bread tax.',
        'After a bread riot in {town}, {short} rode in without guards, ate the people’s bread with them and remitted a year of taxes.',
      ], v) });
      effect(ctx, T.s(s), 'riot', { happiness: 0.08, unrest: -0.12 }, 3, 'Granaries opened');
      effect(ctx, T.c(civ), 'relief_cost', { stability: -0.01 }, 3, 'Taxes remitted');
    } else {
      record(ctx, { text: say(world, [
        'Bread riots shook {town}: the crowd looted {market}, hanged a grain merchant and held the streets for three days.',
        'In {town} the price of bread doubled in a month, and the people rose; the governor fled and the riot spread to the villages around.',
      ], v) });
      effect(ctx, T.s(s), 'riot', { unrest: 0.2, happiness: -0.06 }, 3, 'Bread riots');
      effect(ctx, T.c(civ), 'riots', { stability: -0.03 }, 5, 'Bread riots');
      heat(ctx, 'unrest', 0.5, SUBJ.realm(civ.id));
    }
    spendHeat(world, 'hunger', ctx.subject, 0.5);
    return true;
  },
});

const GUILDS = ['Weavers', 'Dyers', 'Coopers', 'Smiths', 'Tanners', 'Masons', 'Fullers', 'Chandlers', 'Brewers', 'Goldsmiths', 'Shipwrights'];
registerEvent({
  id: 'town.guild_revolt', scale: 'town', minTier: 3, family: 'unrest', cat: 'civ', imp: 2, minEra: 3, cooldownYears: 40, chain: ['tax', 'unrest'],
  label: 'Guild revolt', icon: 'riot', hint: ['a charter of liberties (trade +10%, loyalty −)', 'or the town breaks away as a Free City'],
  weight(ctx) {
    const { world, s, civ } = ctx;
    if (s.tier < 3 || !civ || isCapital(world, s)) return 0;
    if (!(lvl(s, 'market') || lvl(s, 'workshop') || hasTrait(s, 'weavers') || hasTrait(s, 'market town'))) return 0;
    const sore = (civ.taxRate || 0) >= 0.12 || ctx.heatCiv('tax') >= 0.3 || s.unrest >= 0.3;
    if (!sore) return 0;
    const ag = ageShares(s.cohorts);
    return 0.01 * (1 + ctx.heatCiv('tax') + ctx.heat('unrest')) * (s.loyalty < 0.5 ? 2 : 1) * youthLean(ag.youth) / eldersLean(ag.elders);
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const guild = pick(world, GUILDS);
    const name = `the ${guild}’ Revolt of ${s.name}`;
    const cap0 = world.settlements[civ.capitalId];
    const far = cap0 ? Math.hypot(cap0.x - s.x, cap0.y - s.y) >= 8 : true;
    bumpHist(world, s, 'riots');
    if (ctx.era >= 3 && far && civ.settlementIds.length >= 3 && s.loyalty < 0.55 && world.rng.chance(0.45)) {
      const res = splitAway(world, civ, [s.id], { cause: 'secession', government: 'merchant', nameFrom: 'city' });
      if (res && res.civ) {
        addTrait(world, s, 'free city');
        record(ctx, { civ: res.civ, s, imp: 3, text: say(world, [
          'In {name}, the guilds threw out the governor of {ruler} and declared {town} a free city, answerable to no crown.',
          'The {guild} of {town} rang the town bell, barred the gates against {owner} and proclaimed the Free City of {town}.',
        ], { name: cap(name), ruler: rulerName(civ.ruler), town: s.name, guild, owner: civName(civ) }) });
        effect(ctx, T.c(civ), 'lost_city', { stability: -0.03 }, 10, 'A city lost');
        return true;
      }
    }
    record(ctx, { text: say(world, [
      '{Name}: the guildsmen barricaded the streets until {ruler} granted {town} a charter, and the guilds set their own tolls ever after.',
      'The {guild} of {town} downed tools and marched on the governor’s hall; they won their charter, and the crown never trusted the town again.',
    ], { Name: cap(name), ruler: rulerName(civ.ruler), town: s.name, guild }) });
    effect(ctx, T.s(s), 'charter', { trade: 1.1, production: 1.06, loyalty: -0.08 }, 30, 'Guild charter');
    effect(ctx, T.c(civ), 'guilds', { stability: -0.02 }, 10, 'Guild revolt');
    return true;
  },
});

registerEvent({
  id: 'town.persecution', scale: 'town', minTier: 2, family: 'unrest', cat: 'religion', imp: 2, cooldownYears: 30, chain: ['blame'], needs: ['blame'],
  label: 'Persecution', icon: 'faith', hint: ['a minority driven out; unrest, culture −10% for 10 years'],
  weight(ctx) {
    const { world, s } = ctx;
    if (s.tier < 2 || ctx.heat('blame') < 0.3) return 0;
    return minorityFaith(world, s) ? 0.15 * ctx.heat('blame') : 0;
  },
  fire(ctx) {
    const { world, s } = ctx;
    const faith = minorityFaith(world, s);
    if (!faith) return false;
    const blame = { fire: 'the great fire', plague: 'the sickness', famine: 'the hunger' }[cityMem(world, s.id).blame] || 'their misfortunes';
    damageSettlement(world, s, { pop: 0.015, cause: 'expulsion' });
    record(ctx, { text: say(world, [
      'Blaming {blame} on the followers of {faith}, a mob of {town} burned their shrine and drove them from the town.',
      'The preachers of {town} named the followers of {faith} as the cause of {blame}; their houses were marked, and those who could, fled.',
    ], { blame, faith: faith.name, town: s.name }), ref: { k: 'religion', id: faith.id }, s });
    effect(ctx, T.s(s), 'persecution', { unrest: 0.08, culture: 0.9, research: 0.92 }, 10, 'Persecution');
    spendHeat(world, 'blame', ctx.subject, 0.6);
    return true;
  },
});

// ---------------------------------------------------------------------------
// Boom, bust, fair

const STRIKES = {
  1: ['a rich seam of copper', 'green copper ore in the stream beds'], 2: ['tin in the river gravels'], 3: ['a hill of iron ore'],
  4: ['gold in the stream gravels', 'a reef of gold-bearing quartz'], 5: ['gems in the riverbank clay'], 6: ['a mountain of white marble'],
  9: ['new salt springs', 'a thick bed of rock salt'], 10: ['rich fur-grounds in the northern woods'], 8: ['wild spice groves'],
};
function strikeNear(world, s) {
  const { W, H, f } = world;
  const r = Math.max(2, s.radius | 0);
  let best = 0, ba = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x, res = f.resource[i];
    if (STRIKES[res] && f.resourceAmt[i] > ba) { ba = f.resourceAmt[i]; best = res; }
  }
  return best;
}
const pot = (s, k) => (Array.isArray(s.flags?.pot) && Number.isFinite(s.flags.pot[k]) ? s.flags.pot[k] : 0);

registerEvent({
  id: 'town.boom', scale: 'town', minTier: 1, family: 'fortune', cat: 'trade', imp: 2, minEra: 1, cooldownYears: 40,
  label: 'Boom', icon: 'trade', hint: ['trade +25%, newcomers flock in (15 years)', 'crowding: fire and plague grow likelier', 'busts when the seam gives out'],
  weight(ctx) {
    const s = ctx.s;
    if (s.tier < 1) return 0;
    const lode = pot(s, 5) + pot(s, 6);
    if (!(lode > 0.2)) return 0;
    return 0.003 * Math.min(2, lode / 3) * Math.max(0, 1 - ctx.heat('boom'));
  },
  fire(ctx) {
    const { world, s } = ctx;
    const res = strikeNear(world, s);
    const strike = res ? pick(world, STRIKES[res]) : pick(world, ['a vein of silver', 'a seam of good ore', 'amber on the beaches']);
    record(ctx, { text: say(world, [
      'Prospectors found {strike} in the hills above {town}; within a year the {tier} had doubled with diggers, traders and thieves.',
      '{Town} boomed after the discovery of {strike} nearby: tents spread over the meadows and the price of bread rose tenfold.',
      'Word of {strike} near {town} spread along every road, and the {tier} filled with fortune-seekers.',
    ], { strike, town: s.name, Town: s.name, tier: tierName(s) }) });
    effect(ctx, T.s(s), 'boom', { trade: 1.25, attract: 1.4, production: 1.1 }, 15, 'Boom');
    heat(ctx, 'boom', 1);
    heat(ctx, 'crowding', 0.6);
    cityMem(world, s.id).strike = res || 0;
    return true;
  },
});

registerEvent({
  id: 'town.bust', scale: 'town', family: 'fortune', cat: 'trade', imp: 2, cooldownYears: 30, luck: false, chain: ['bust', 'boom'], needs: ['bust', 'boom'],
  label: 'Bust', icon: 'trade', hint: ['wealth −35%, trade −30% for 12 years', 'small towns empty'],
  weight(ctx) {
    const b = ctx.heat('boom');
    return 0.4 * ctx.heat('bust') + (b > 0.12 && b < 0.45 ? 0.02 : 0);
  },
  fire(ctx) {
    const { world, s } = ctx;
    const res = cityMem(world, s.id).strike;
    const what = { 1: 'copper', 2: 'tin', 3: 'iron', 4: 'gold', 5: 'gems', 6: 'marble', 9: 'salt', 10: 'furs', 8: 'spice' }[res] || pick(world, ['ore', 'silver', 'seam']);
    damageSettlement(world, s, { wealth: 0.35, cause: 'bust' });
    let fled = 0;
    if (s.tier <= 2 && s.population < 600) fled = damageSettlement(world, s, { pop: 0.12, cause: 'emigration' });
    record(ctx, { text: say(world, [
      'The {what} of {town} gave out; the diggers drifted away, and grass grew in streets that had been crowded a decade before.',
      'When the last {what} was dug from the hills around {town}, the traders left with it{fled}.',
      // moneylenders and inns belong to an age of coin
      ...(ctx.era >= 2 ? ['{town} went bust: its {what} was spent, its moneylenders ruined, and its inns stood empty{fled}.'] : ['The {what} of {town} was spent, and the camps of the diggers stood empty{fled}.']),
    ], { what, town: s.name, fled: fled > 0 ? `, and ${peopleCount(world, fled)} followed them down the road` : '' }) });
    if (s.alive) effect(ctx, T.s(s), 'bust', { trade: 0.7, attract: 0.5, happiness: -0.06 }, 12, 'Bust');
    spendHeat(world, 'bust', ctx.subject, 1);
    spendHeat(world, 'boom', ctx.subject, 1);
    heat(ctx, 'unrest', 0.3);
    return true;
  },
});

const FAIR_GOODS = ['amber and salt fish', 'horses and hides', 'spices and silk', 'bronze and wine', 'wool and dyed cloth', 'furs and honey', 'pottery and olive oil', 'slaves and iron'];
registerEvent({
  id: 'town.great_fair', scale: 'town', minTier: 2, family: 'fortune', cat: 'trade', imp: 2, cooldownYears: 25,
  label: 'Great fair', icon: 'fair', hint: ['trade +20%, contentment (10 years)', 'crowds bring sickness'],
  weight(ctx) {
    const s = ctx.s;
    if (s.tier < 2) return 0;
    const n = routesAt(ctx);
    const market = lvl(s, 'market') > 0;
    if (!market && n < 3) return 0;
    return 0.0035 * (market ? 1.5 : 1) * Math.min(3, Math.max(1, n)) / 2;
  },
  fire(ctx) {
    const { world, s } = ctx;
    const nm = pick(world, [`the ${cap(seasonWord(world, s.y))} Fair of ${s.name}`, `the Great Fair of ${s.name}`, `the ${shortWord(world, ctx.civ)} Fair`, `the Horse Fair of ${s.name}`]);
    const cm = cityMem(world, s.id);
    cm.fairs = (cm.fairs || 0) + 1;
    const n = Math.max(3, routesAt(ctx));
    record(ctx, { text: say(world, [
      'Merchants from {n} roads came to {fair}; {goods} changed hands in the meadow below the walls.',
      '{Fair} was held for the {nth} time, and its booths stretched from the gates of {town} to the river.',
      'For a month each year {town} doubled in size as {fair} drew traders with {goods}.',
    ], { n: countWord(n), fair: nm, Fair: cap(nm), goods: pick(world, FAIR_GOODS), nth: ordinal(Math.min(10, cm.fairs + 1)), town: s.name }) });
    effect(ctx, T.s(s), 'fair', { trade: 1.2, happiness: 0.04 }, 10, nm);
    // crowds, not a boom: a fair is no strike of ore, and the bust that follows a seam's end is
    // not its consequence (no 'Because' from a fair to a bust)
    heat(ctx, 'crowds', 0.5);
    emitFx(world, { type: 'fair', x: s.x, y: s.y, r: 1.2 });
    return true;
  },
});

// ---------------------------------------------------------------------------
// Plague: quarantine, panic, foul wells

function plagueNear(world, s) {
  let any = false;
  for (let k = world.plagues.length - 1; k >= 0 && k >= world.plagues.length - 30; k--) if (world.plagues[k]?.active) { any = true; break; }
  if (!any) return null;
  for (const o of settlementsNear(world, s.x, s.y, 6)) {
    if (o.id === s.id) continue;
    const p = activePlagueOf(world, o);
    if (p) return { p, o };
  }
  return null;
}
const healing = (world, s) => {
  const r = s.dominantReligion != null ? world.religions[s.dominantReligion] : null;
  return Boolean(r && Array.isArray(r.tenets) && r.tenets.includes('healing'));
};
registerEvent({
  id: 'town.quarantine', scale: 'town', minTier: 2, family: 'plague', cat: 'disease', imp: 2, cooldownYears: 15,
  label: 'Quarantine', icon: 'plague', hint: ['plague dose ×0.2 and trade ×0.3 for 2 years', 'unrest while the gates are shut'],
  weight(ctx) {
    const { world, s, civ } = ctx;
    if (s.tier < 2 || s.disease) return 0;
    const able = lvl(s, 'hospital') > 0 || healing(world, s) || hasTech(civ, 'medicine') || ctx.era >= 3;
    if (!able) return 0;
    return plagueNear(world, s) ? 0.25 : 0;
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const near = plagueNear(world, s);
    if (!near) return false;
    record(ctx, { text: say(world, [
      'When {plague} reached {near}, the elders of {town} shut the gates and turned back every cart at the bridge; the town went hungry, but it lived.',
      '{ruler} ordered {town} sealed against {plague}: ships were burned at anchor, and travellers waited forty days outside the walls.',
      'Hearing that {plague} was in {near}, the people of {town} dug a ditch across the road and let no one cross it for a year.',
    ], { plague: near.p.name, near: near.o.name, town: s.name, ruler: civ ? rulerName(civ.ruler) : 'The council' }), ref: { k: 'plague', id: near.p.id }, s });
    effect(ctx, T.s(s), 'quarantine', { plagueDose: 0.2, trade: 0.3, unrest: 0.06 }, 2, 'Quarantine');
    return true;
  },
});

registerEvent({
  id: 'town.plague_panic', scale: 'town', minTier: 2, family: 'plague', cat: 'disease', imp: 2, cooldownYears: 12,
  label: 'Plague panic', icon: 'plague', hint: ['the rich flee; unrest +0.12, trade −30% (2 years)', 'scapegoats are sought'],
  weight(ctx) {
    const { world, s } = ctx;
    if (s.tier < 2) return 0;
    return activePlagueOf(world, s) ? 0.08 * (1 + ctx.heatLand('plague') + 0.5 * ctx.heat('crowds')) : 0;
  },
  fire(ctx) {
    const { world, s } = ctx;
    const p = activePlagueOf(world, s);
    if (!p) return false;
    const minor = minorityFaith(world, s);
    const scape = minor ? `the followers of ${minor.name}` : pick(world, ['the foreign merchants', 'the old women who sold herbs', 'the beggars at the gate', 'the moneylenders', 'the gravediggers']);
    const fled = damageSettlement(world, s, { pop: 0.02, cause: 'flight' });
    record(ctx, { text: say(world, [
      'Fearing {plague}, the rich of {town} fled to their country houses; the poor barred their doors, burned juniper in the streets and blamed {scape}.',
      'Panic seized {town} as {plague} spread: {fled} took to the roads, and those who stayed stoned {scape}.',
      'In {town} the bells tolled for {plague} day and night; the markets emptied, the healers went from door to door with smoking censers, and the crowd blamed {scape}.',
    ], { plague: p.name, town: s.name, scape, fled: peopleCount(world, fled) }), ref: { k: 'plague', id: p.id }, s });
    effect(ctx, T.s(s), 'panic', { unrest: 0.12, attract: 0.6, trade: 0.7 }, 2, 'Plague panic');
    heat(ctx, 'blame', 0.6);
    cityMem(world, s.id).blame = 'plague';
    return true;
  },
});

registerEvent({
  id: 'town.water_crisis', scale: 'town', minTier: 3, family: 'plague', cat: 'disease', imp: 2, cooldownYears: 40,
  label: 'Foul wells', icon: 'plague', hint: ['health −0.08, deaths ×1.15 for 6 years', 'sickness grows likelier'],
  weight(ctx) {
    const s = ctx.s;
    if (s.tier < 3 || lvl(s, 'aqueduct') || lvl(s, 'sewers')) return 0;
    const crowd = s.population / Math.max(20, s.housing || s.population);
    return crowd > 1.02 ? 0.006 * Math.min(2, crowd) * (1 + ctx.heat('crowding') + 0.5 * ctx.heat('crowds')) : 0;
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    record(ctx, { text: say(world, [
      'The wells of {town} turned foul in the {season} heat; children sickened, and the water-carriers charged a copper a jar.',
      'Too many people and too few wells: {town} drank from its own sewers that {season}, and the fevers came.',
    ], { town: s.name, season: seasonWord(world, s.y) }) });
    effect(ctx, T.s(s), 'foulwells', { health: -0.08, mortality: 1.15 }, 6, 'Foul wells');
    heat(ctx, 'crowds', 0.5);
    if (hasTech(civ, 'engineering')) heat(ctx, 'rebuild', 0.5);
    return true;
  },
});

// ---------------------------------------------------------------------------
// Pride: sieges endured, festivals, great works, rebuilding after floods

registerEvent({
  id: 'town.siege_endured', scale: 'town', minTier: 3, family: 'civic', cat: 'war', imp: 2, cooldownYears: 60, luck: false, chain: ['siege_held'], needs: ['siege_held'],
  label: 'Siege remembered', icon: 'walls', hint: ['walls raised: defence +0.3 for ever', 'loyalty and a yearly feast'],
  weight(ctx) { return ctx.s.tier >= 3 ? 0.15 * ctx.heat('siege_held') : 0; },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const cm = cityMem(world, s.id);
    const foe = cm.lb != null && world.civs[cm.lb] ? peopleOf(world.civs[cm.lb]) : 'the besiegers';
    record(ctx, { cat: 'culture', text: say(world, [
      'Every year on the day {foe} raised their siege, {town} feasted on its walls; the gates were rehung in bronze and the walls raised higher.',
      'The people of {town} built a shrine where the breach had been held against {foe}, and swore their walls would never fall.',
      '{ruler} rewarded {town} for holding out against {foe}: its walls were rebuilt twice as thick, and its guilds paid no tax for a generation.',
    ], { foe, town: s.name, ruler: civ ? rulerName(civ.ruler) : 'The council' }) });
    effect(ctx, T.s(s), 'unbowed', { defense: (cm.hc || 0) >= 2 ? 0.3 : 0.15 }, -1, 'Walls of pride');
    effect(ctx, T.s(s), 'siegefeast', { loyalty: 0.1, happiness: 0.05 }, 25, 'Siege feast');
    spendHeat(world, 'siege_held', ctx.subject, 1);
    return true;
  },
});

function hundredth(n) {
  const w = ['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  return n <= 1 ? 'hundredth' : n <= 10 ? `${w[n]} hundredth` : `${n}00th`;
}
registerEvent({
  id: 'town.festival', scale: 'town', minTier: 1, family: 'civic', cat: 'culture', imp: 1, cooldownYears: 8, chain: ['feast'],
  label: 'Festival', icon: 'fair', hint: ['contentment and culture for 3 years'],
  weight(ctx) {
    const { world, s } = ctx;
    if (s.tier < 1) return 0;
    const age = Math.floor((world.time.day - (s.foundedDay || 0)) / Y);
    if (age >= 100 && age % 100 === 0) return 0.9;
    return 0.008 * (1 + ctx.heat('feast')) * (s.food > (s.foodNeed || 1) * 6 ? 1.5 : 1) * eldersLean(ageShares(s.cohorts).elders);
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const age = Math.floor((world.time.day - (s.foundedDay || 0)) / Y);
    const centenary = age >= 100 && age % 100 === 0;
    const ruler = civ ? rulerName(civ.ruler) : 'the elders';
    if (centenary) {
      const c = age / 100;
      const grand = c >= 5 || (c >= 3 && s.tier >= 4);
      record(ctx, { imp: grand ? 2 : 1, fold: !grand, text: say(world, [
        '{town} kept the feast of its {nth} year: {ruler} came to light the fires on the walls, and the dancing lasted {days} days.',
        'For its {nth} year {town} hung every door with garlands; the founders’ names were read aloud in the market.',
      ], { town: s.name, nth: hundredth(c), ruler, days: countWord(world.rng.int(3, 9)) }) });
    } else {
      record(ctx, { imp: 1, fold: true, text: say(world, [
        'After a golden harvest {town} held a feast that was talked about for years.',
        'The people of {town} danced around the {season} fires for {days} nights.',
        'At the {season} feast of {town} the young men raced to the hilltop and back, and the winner was crowned with {crown}.',
        '{town} brewed so much ale for its {season} feast that the elders forbade it the next year.',
        'Masked dancers led a procession through {town} to honour the {season}, and pipers played until dawn.',
      ], { town: s.name, season: seasonWord(world, s.y), days: countWord(world.rng.int(3, 7)), crown: pick(world, ['oak leaves', 'barley', 'wild roses', 'a ram\u2019s horns']) }) });
    }
    effect(ctx, T.s(s), 'festival', { happiness: 0.06, culture: 1.05 }, 3, 'Festival');
    spendHeat(world, 'feast', ctx.subject, 1);
    return true;
  },
});

registerEvent({
  id: 'town.great_work', scale: 'town', minTier: 3, family: 'works', cat: 'culture', imp: 2, minEra: 2, cooldownYears: 80, chain: ['rebuild', 'boom'],
  label: 'Great work', icon: 'wonder', hint: ['a bridge, mole or wall: trade or defence for centuries'],
  weight(ctx) {
    const s = ctx.s;
    if (s.tier < 3) return 0;
    return 0.004 * (1 + ctx.heat('rebuild') + ctx.heat('boom')) * eldersLean(ageShares(s.cohorts).elders);
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const river = riverAt(world, s.x, s.y);
    const who = civ ? rulerShort(civ.ruler) : s.name;
    let text, k, m, nm;
    if (river && world.f.river[s.i] >= 2) {
      nm = pick(world, [`the Great Bridge of ${s.name}`, `the Bridge of ${who}`]);
      text = say(world, ['{Nm} was finished at {town}, {n} arches of dressed stone across {river}; tolls from it paid for the town’s walls.', 'Masons of {town} spanned {river} with {nm}, and the road from the coast no longer waited on the ferry.'], { Nm: cap(nm), nm, town: s.name, river, n: countWord(world.rng.int(5, 11)) });
      k = 'work:bridge'; m = { trade: 1.1 };
    } else if (world.f.coast[s.i]) {
      nm = pick(world, [`the Lantern of ${s.name}`, `the Great Mole of ${s.name}`]);
      text = say(world, ['{Nm} rose over the harbour of {town}, and ships came in by night guided by its fire.', 'The harbour of {town} was walled by {nm}, a breakwater of rubble and timber that tamed the winter seas.'], { Nm: cap(nm), nm, town: s.name });
      k = 'work:harbour'; m = { trade: 1.08, foodYield: 1.04 };
    } else {
      nm = pick(world, [`the Walls of ${who}`, `the Long Wall of ${s.name}`]);
      text = say(world, ['{town} was ringed by {nm}, with {n} towers and gates of bronze.', 'It took twenty summers to raise {nm} around {town}; it would stand for centuries.'], { town: s.name, nm, n: countWord(world.rng.int(8, 12)) });
      k = 'work:walls'; m = { defense: 0.15 };
    }
    record(ctx, { text });
    effect(ctx, T.s(s), k, m, 300, nm);
    spendHeat(world, 'rebuild', ctx.subject, 0.6);
    return true;
  },
});

registerEvent({
  id: 'town.flood_rebuild', scale: 'town', family: 'fire', cat: 'nature', imp: 2, cooldownYears: 30, luck: false, chain: ['flood'], needs: ['flood'],
  label: 'Rebuilt after the flood', icon: 'flood', hint: ['silt: food +12% for 20 years', 'levees raised'],
  weight(ctx) { return 0.4 * ctx.heat('flood'); },
  fire(ctx) {
    const { world, s } = ctx;
    const river = riverAt(world, s.x, s.y) || (world.f.coast[s.i] ? featureNear(world, 'sea', s.x, s.y, 50) : null) || 'the waters';
    record(ctx, { imp: s.tier >= 2 ? 2 : 1, text: say(world, [
      'When the waters went down, the people of {town} raised earthen levees along {river} and sowed the new silt; the harvests that followed were the richest anyone remembered.',
      '{town} rebuilt on higher ground after the flood, and the drowned fields below came back black and rich.',
    ], { town: s.name, river }) });
    if (ctx.era >= 1) addTrait(world, s, 'levees', ctx.entry.seq);
    effect(ctx, T.s(s), 'silt', { foodYield: 1.12 }, 20, 'Flood silt');
    spendHeat(world, 'flood', ctx.subject, 1);
    return true;
  },
});

// ---------------------------------------------------------------------------
// Pilgrims and refugees

registerEvent({
  id: 'town.pilgrim_influx', scale: 'town', minTier: 1, family: 'sacred', cat: 'religion', imp: 2, cooldownYears: 40,
  label: 'Pilgrims', icon: 'faith', hint: ['trade +15%, culture +10%, newcomers (15 years)', 'the faith grows fervent'],
  weight(ctx) {
    const { world, s } = ctx;
    if (s.tier < 1) return 0;
    let f = 0;
    const wq = world.sys.events.wq;
    if (wq && Array.isArray(wq.holy) && wq.holy.includes(s.id)) f += 2;
    if (hasTrait(s, 'sacred site')) f += 1.5;
    if (s.legend && s.legend.kind === 'spring') f += 1.3;
    if (lvl(s, 'temple') >= 2) f += 1;
    return f ? 0.0013 * f : 0;
  },
  fire(ctx) {
    const { world, s } = ctx;
    const holy = world.religions.find((r) => r && r.alive !== false && r.holyCityId === s.id);
    const faith = holy || (s.dominantReligion != null ? world.religions[s.dominantReligion] : null);
    const shrine = hasTrait(s, 'sacred site') ? 'the standing stones' : s.legend && s.legend.kind === 'spring' ? 'the healing spring' : holy ? `the tomb of ${holy.prophet || 'the prophet'}` : 'the great temple';
    record(ctx, { text: say(world, [
      'Pilgrims{of} came to {town} in their thousands that {season} to pray at {shrine}; the innkeepers grew rich and the priests richer.',
      'The roads to {town} filled with pilgrims{of}, barefoot and singing, bound for {shrine}.',
      'Word of a healing at {shrine} spread far, and {town} could not house the pilgrims{of} who came; they slept in the fields.',
    ], { of: faith ? ` of ${faith.name}` : '', town: s.name, season: seasonWord(world, s.y), shrine }), ref: faith ? { k: 'religion', id: faith.id } : undefined, s });
    effect(ctx, T.s(s), 'pilgrims', { trade: 1.15, culture: 1.1, attract: 1.2 }, 15, 'Pilgrims');
    if (faith) boostFaith(world, faith.id, 0.05);
    heat(ctx, 'crowds', 0.4);
    return true;
  },
});

function recentFall(world, s) {
  const st = evState(world);
  const n = st.fall.length;
  if (!n || world.time.day - st.fall[n - 1].day > 3 * Y) return null;
  let best = null;
  for (const f of st.fall) {
    if (f.r != null || world.time.day - f.day > 3 * Y || f.sid === s.id) continue;
    if ((f.x - s.x) ** 2 + (f.y - s.y) ** 2 > 144) continue;
    if (!best || f.day > best.day) best = f;
  }
  return best;
}
registerEvent({
  id: 'town.refugees', scale: 'town', minTier: 2, family: 'civic', cat: 'civ', imp: 2, cooldownYears: 20,
  label: 'Refugees', icon: 'migration', hint: ['newcomers swell the town; unrest and sickness (5 years)'],
  weight(ctx) {
    const s = ctx.s;
    if (s.tier < 2) return 0;
    return recentFall(ctx.world, s) ? 0.05 : 0;
  },
  fire(ctx) {
    const { world, s } = ctx;
    const f = recentFall(world, s);
    if (!f) return false;
    f.r = s.id; // one town takes in the refugees of each fall
    const old = world.settlements[f.sid];
    const oname = old ? old.name : 'the fallen town';
    const conq = f.to >= 0 && world.civs[f.to] ? peopleOf(world.civs[f.to]) : null;
    record(ctx, { text: say(world, [
      'Refugees from {fallen} streamed into {town} with their carts and children; the elders let them camp beneath the walls, but bread grew dear.',
      'Driven out of {old}{by}, whole families walked to {town} and begged at its gates; most of them stayed.',
      'The roads into {town} were choked with the carts of those who had fled {fallen}; a new quarter of huts grew up outside the walls.',
      '{town} took in the survivors of {fallen}, and for a generation its streets rang with two accents.',
    ], { fallen: f.k === 'x' ? `ruined ${oname}` : `fallen ${oname}`, old: oname, by: conq && f.k === 't' ? ` by ${conq}` : '', town: s.name }) });
    effect(ctx, T.s(s), 'refugees', { attract: 1.3, unrest: 0.05, health: -0.03 }, 5, 'Refugees');
    if (f.to >= 0 && f.to !== s.civId) heat(ctx, 'refugees', 0.8, SUBJ.pair(s.civId, f.to));
    return true;
  },
});

export { minorityFaith };
