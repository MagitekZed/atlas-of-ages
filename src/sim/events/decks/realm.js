// The realm deck: life at court and in the treasury. An empty treasury forces a choice the
// ruler's character makes — raise taxes (and feed riots and guild revolts), borrow from the
// merchant houses (and perhaps default), or debase the coin (five fat years, then inflation).
// Courts breed intrigue and succession scandals; rulers hunt, wed and count their people;
// great roads and law codes bind a realm together; famine relief (or its refusal) is
// remembered; scholars flee tyrants for kinder courts. All effects are civ effects
// (applyFx deltas on mods keys) or settlement effects, with heat for what follows.

import { withArticle } from '../../../core/util.js';
import { registerEvent } from '../../../core/events.js';
import { on } from '../../../core/hooks.js';
import { civSettlements, areAtWar } from '../../../core/entities.js';
import { BIOME } from '../../../core/constants.js';
import { record, effect, heat, T, hasTech } from '../engine.js';
import { SUBJ, spendHeat } from '../heat.js';
import {
  pick, say, cap, civName, CivName, peopleOf, rulerName, rulerShort, rulerHas, rulerAge, his, he, personName, placeWord,
  countWord, fmtInt, placePhrase,
} from '../prose.js';

const HEREDITARY = new Set(['tribe', 'chiefdom', 'kingdom', 'empire', 'horde', 'feudal', 'constitutional']);
const has = (civ, ...traits) => traits.some((t) => rulerHas(civ, t));
const capitalOf = (world, civ) => (civ.capitalId != null ? world.settlements[civ.capitalId] || null : null);
function largest(world, civ, n) {
  return civSettlements(world, civ).sort((a, b) => b.population - a.population || a.id - b.id).slice(0, n);
}
const memo = (world, civ) => ((world.sys.events.rm ||= {})[civ.id] ||= {});
// a fallen realm's memory (census, lore) is not kept
on('civDestroyed', (world, civ) => { const rm = world.sys.events && world.sys.events.rm; if (rm && civ) delete rm[civ.id]; });
const GAME = (b) => (b === BIOME.SAVANNA || b === BIOME.SHRUBLAND ? ['lion', 'antelope', 'wild buffalo'] : b === BIOME.STEPPE ? ['wild horses', 'aurochs', 'wolves']
  : b === BIOME.TAIGA || b === BIOME.TUNDRA ? ['elk', 'bear', 'wolves'] : b === BIOME.RAINFOREST || b === BIOME.TROPICAL_FOREST ? ['tiger', 'leopard', 'wild boar']
    : b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT ? ['gazelle', 'oryx', 'lion'] : b === BIOME.WETLAND ? ['boar', 'wildfowl', 'crocodile'] : ['stag', 'boar', 'bear']);

// ---------------------------------------------------------------------------
// Treasury

registerEvent({
  id: 'realm.treasury_crisis', scale: 'realm', family: 'treasury', cat: 'civ', imp: 2, minEra: 1, cooldownYears: 25, chain: ['debt'],
  label: 'Treasury crisis', icon: 'coin', hint: ['the ruler raises taxes, borrows, or debases the coin', 'each has its price'],
  weight(ctx) {
    const civ = ctx.civ;
    if (civ.settlementIds.length < 3) return 0;
    const t = civ.treasury || 0, inc = civ.income || 0, exp = civ.expenses || 0;
    if (t < 0) return 0.25 * (1 + ctx.heat('debt'));
    if (exp > inc * 1.05 && t < Math.max(1, inc) * 6) return 0.04;
    return 0;
  },
  fire(ctx) {
    const { world, civ } = ctx;
    const cap0 = capitalOf(world, civ);
    const ruler = rulerName(civ.ruler);
    const v = { ruler, short: rulerShort(civ.ruler), cap: cap0 ? cap0.name : 'the capital', civ: civName(civ), people: peopleOf(civ), his: his(civ.ruler) };
    if (has(civ, 'greedy', 'cruel', 'ambitious', 'paranoid')) {
      const tax = pick(world, ['salt tax', 'hearth tax', 'grain tithe', 'toll on every bridge', 'tax on windows']);
      record(ctx, { text: say(world, [
        'Facing an empty treasury, {ruler} doubled the {tax}; the merchants of {cap} grumbled, and the poor went hungry.',
        '{short} sent tax-farmers into every province with soldiers at their backs; the coffers filled, and the people learned to hate the {tax}.',
      ], { ...v, tax }) });
      effect(ctx, T.c(civ), 'tax', { happiness: -0.05, stability: -0.03, taxEfficiency: 0.15 }, 8, 'Heavy taxes');
      heat(ctx, 'tax', 1);
    } else if (ctx.era >= 2 && has(civ, 'scholarly', 'wise', 'just', 'brilliant', 'cautious')) {
      const house = `the house of ${personName(world, civ)}`;
      record(ctx, { text: say(world, [
        '{ruler} borrowed heavily from {house}, the richest merchants of {cap}, against the next ten harvests.',
        'To pay {his} soldiers, {short} pledged the crown jewels to {house}; the loan would have to be repaid.',
      ], { ...v, house }) });
      effect(ctx, T.c(civ), 'loan', { trade: 0.05, taxEfficiency: 0.05 }, 6, 'Loans');
      heat(ctx, 'debt', 1);
    } else if (ctx.era >= 2) {
      record(ctx, { text: say(world, [
        '{ruler} ordered the mints to cut the silver with copper; for five years the treasury overflowed, and then prices began to climb.',
        'The coins of {civ} grew lighter year by year under {short}; the people called them tin, and bread doubled in price.',
      ], v) });
      effect(ctx, T.c(civ), 'debase', { taxEfficiency: 0.2 }, 5, 'Debased coin');
      effect(ctx, T.c(civ), 'inflation', { happiness: -0.04, trade: -0.12 }, 15, 'Inflation');
      heat(ctx, 'tax', 0.4);
    } else {
      record(ctx, { text: say(world, [
        'With the granaries of the chiefs empty, {short} seized the herds of the clan elders to feed {his} warriors; the elders did not forgive it.',
        '{ruler} demanded a tenth of every herd and harvest; the clans paid, and muttered.',
      ], v) });
      effect(ctx, T.c(civ), 'levy', { stability: -0.04, taxEfficiency: 0.1 }, 5, 'Levies');
      heat(ctx, 'tax', 0.5);
    }
    return true;
  },
});

registerEvent({
  id: 'realm.default', scale: 'realm', family: 'treasury', cat: 'trade', imp: 2, cooldownYears: 30, luck: false, chain: ['debt'], needs: ['debt'],
  label: 'Default', icon: 'coin', hint: ['trade −0.12, stability −0.05 for 10 years', 'the lenders’ city suffers'],
  weight(ctx) {
    const civ = ctx.civ;
    return ctx.heat('debt') >= 0.3 && (civ.treasury || 0) < 0 ? 0.4 * ctx.heat('debt') : 0;
  },
  fire(ctx) {
    const { world, civ } = ctx;
    const town = largest(world, civ, 3).find((s) => s.buildings && (+s.buildings.bank || +s.buildings.market)) || largest(world, civ, 1)[0];
    record(ctx, { text: say(world, [
      '{Civ} could not repay its loans: the banking houses of {town} closed their doors, and no merchant would lend to {ruler} again.',
      '{ruler} repudiated the crown’s debts; three great houses of {town} were ruined, and their creditors with them.',
    ], { Civ: CivName(civ), town: town ? town.name : 'the capital', ruler: rulerName(civ.ruler) }) });
    effect(ctx, T.c(civ), 'default', { trade: -0.12, stability: -0.05 }, 10, 'Default');
    if (town) effect(ctx, T.s(town), 'default', { trade: 0.8 }, 8, 'Ruined lenders');
    spendHeat(world, 'debt', ctx.subject, 1);
    return true;
  },
});

registerEvent({
  id: 'realm.great_census', scale: 'realm', family: 'treasury', cat: 'civ', imp: 1, minEra: 2, cooldownYears: 50,
  label: 'Census', icon: 'scroll', hint: ['tax efficiency +0.08 for 25 years', 'a little resentment'],
  weight(ctx) {
    const civ = ctx.civ;
    return hasTech(civ, 'writing') && civ.settlementIds.length >= 3 ? 0.02 : 0;
  },
  fire(ctx) {
    const { world, civ } = ctx;
    const m = memo(world, civ);
    const first = !m.census;
    m.census = world.time.day;
    const pop = Math.round(civ.population || 0);
    record(ctx, { imp: first ? 2 : 1, fold: !first, text: say(world, [
      'The scribes of {ruler} went from village to village and counted {pop} subjects in {n} towns; the tax rolls were rewritten.',
      '{Civ} took {first}census of its people: {pop} souls, every one of them now known to the tax-gatherers.',
    ], { ruler: rulerName(civ.ruler), pop: fmtInt(Math.round(pop / 100) * 100), n: countWord(civ.settlementIds.length), Civ: CivName(civ), first: first ? 'its first ' : 'a new ' }) });
    effect(ctx, T.c(civ), 'census', { taxEfficiency: 0.08 }, 25, 'Census');
    heat(ctx, 'tax', 0.3);
    return true;
  },
});

// ---------------------------------------------------------------------------
// Court

const HOUSE = (world, civ) => `the House of ${placeWord(world, civ)}`;
registerEvent({
  id: 'realm.court_intrigue', scale: 'realm', family: 'court', cat: 'civ', imp: 2, cooldownYears: 20, chain: ['faction', 'unrest'],
  label: 'Court intrigue', icon: 'crown', hint: ['a purge steadies the throne, or a faction seizes the seals'],
  weight(ctx) {
    const civ = ctx.civ;
    if (!civ.ruler) return 0;
    let w = 0.007 * (ctx.era >= 1 ? 1 : 0.5);
    if ((civ.legitimacy ?? 0.8) < 0.5) w *= 2;
    if (has(civ, 'craven', 'mad', 'paranoid', 'lazy', 'foolish')) w *= 1.8;
    return w * (1 + ctx.heat('faction') + 0.5 * ctx.heat('unrest') + 0.5 * ctx.heat('grudge'));
  },
  fire(ctx) {
    const { world, civ } = ctx;
    const ruler = rulerName(civ.ruler), short = rulerShort(civ.ruler);
    const courtier = personName(world, civ);
    const roll = world.rng.next();
    const cap0 = capitalOf(world, civ);
    if (ctx.era === 0) {
      const rival = personName(world, civ);
      const good = roll < 0.5;
      record(ctx, { text: good ? say(world, [
        '{rival}, a rival of {ruler}, plotted with the young hunters of {town}; when the plot was found out, {rival} was driven into the wilderness.',
        'The elders of {civ} met in secret to unseat {short}; {short} heard of it, and two of them were found in the river.',
      ], { rival, ruler, short, town: (pick(world, largest(world, civ, 4)) || cap0 || { name: 'the camp' }).name, civ: civName(civ) }) : say(world, [
        'The kin of {rival} won the ear of {ruler}, and the old families of {civ} found themselves left out of every council.',
        'A shaman named {rival} won such sway over {ruler} with dreams and omens that the elders muttered against {him}.',
      ], { rival, ruler, short, civ: civName(civ), him: world.rng.chance(0.5) ? 'him' : 'her' }) });
      effect(ctx, T.c(civ), good ? 'purge' : 'faction', { stability: good ? 0.02 : -0.04 }, good ? 5 : 10, good ? 'Plot foiled' : 'Faction');
      if (!good) heat(ctx, 'faction', 0.5); else spendHeat(world, 'faction', ctx.subject, 0.6);
      return true;
    }
    if (roll < 0.35) {
      record(ctx, { text: say(world, [
        'The chancellor {who} was found to be plotting with the nobles of {town}; {ruler} had him strangled in the palace gardens.',
        '{short} uncovered a conspiracy among {his} own guard; {n} officers were executed and their families exiled.',
      ], { who: courtier, town: (pick(world, largest(world, civ, 4)) || cap0 || { name: 'the provinces' }).name, ruler, short, his: his(civ.ruler), n: countWord(world.rng.int(3, 9)) }) });
      effect(ctx, T.c(civ), 'purge', { stability: 0.02 }, 5, 'Purge');
      spendHeat(world, 'faction', ctx.subject, 0.6);
    } else if (roll < 0.75) {
      const house = HOUSE(world, civ);
      record(ctx, { text: say(world, [
        'At the court of {ruler}, {house} took hold of the treasury and the seals; the old counsellors were sent home.',
        '{who} of {house} became the favourite of {short}, and through {him} the house ruled in all but name.',
      ], { ruler, house, short, who: courtier, him: world.rng.chance(0.5) ? 'him' : 'her' }) });
      effect(ctx, T.c(civ), 'faction', { stability: -0.04 }, 10, 'Faction at court');
      heat(ctx, 'faction', 0.6);
    } else {
      record(ctx, { text: say(world, [
        '{ruler} survived a cup of poisoned wine at a feast in {cap}; the taster died in {his} place, and three cooks were hanged.',
        'An arrow loosed from the crowd missed {short} by a hand’s breadth; the bowman was never found.',
      ], { ruler, short, his: his(civ.ruler), cap: cap0 ? cap0.name : 'the capital' }) });
      effect(ctx, T.c(civ), 'plot', { stability: -0.02 }, 5, 'Assassination attempt');
      heat(ctx, 'faction', 0.3);
    }
    return true;
  },
});

registerEvent({
  id: 'realm.succession_scandal', scale: 'realm', family: 'court', cat: 'civ', imp: 2, cooldownYears: 40, chain: ['faction'],
  label: 'Succession scandal', icon: 'crown', hint: ['stability −0.05 for 12 years', 'the court takes sides'],
  weight(ctx) {
    const { world, civ } = ctx;
    if (!civ.ruler || !HEREDITARY.has(civ.government)) return 0;
    const age = rulerAge(world, civ);
    if (age == null || age < 55) return 0;
    return 0.01 * (age >= 65 ? 2 : 1) * (1 + ctx.heat('faction'));
  },
  fire(ctx) {
    const { world, civ } = ctx;
    const ruler = rulerName(civ.ruler);
    const age = Math.round(rulerAge(world, civ) || 60);
    record(ctx, { text: say(world, [
      'Whispers that the heir of {ruler} was a changeling spread from {cap} to every village; the nobles began to choose sides.',
      'At {age}, {short} named a younger child heir over the eldest, and the court of {civ} split into two camps.',
      'The aged {short} would name no heir at all; {people} waited, and the great houses armed.',
    ], { ruler, short: rulerShort(civ.ruler), age: countWord(age), cap: capitalOf(world, civ)?.name || 'the capital', civ: civName(civ), people: peopleOf(civ) }) });
    effect(ctx, T.c(civ), 'scandal', { stability: -0.05 }, 12, 'Succession scandal');
    heat(ctx, 'faction', 0.5);
    return true;
  },
});

registerEvent({
  id: 'realm.royal_hunt', scale: 'realm', family: 'court', cat: 'civ', imp: 1, cooldownYears: 10,
  label: 'Royal hunt', icon: 'hunt', hint: ['a little prestige, or a crippling fall'],
  weight(ctx) {
    const civ = ctx.civ;
    if (!civ.ruler) return 0;
    return has(civ, 'warlike', 'ambitious', 'charismatic') ? 0.03 : 0.015;
  },
  fire(ctx) {
    const { world, civ } = ctx;
    const cap0 = capitalOf(world, civ);
    const place = cap0 ? placePhrase(world, cap0.x, cap0.y) : 'in the royal forest';
    const game = pick(world, cap0 ? GAME(world.f.biome[cap0.i]) : ['stag', 'boar']);
    const short = rulerShort(civ.ruler);
    if (world.rng.chance(0.15)) {
      record(ctx, { imp: 2, text: say(world, [
        '{short} was thrown from {his} horse while hunting {game} {place} and never walked straight again; the court began to look to the heir.',
        'A wounded {game} gored {short} on the royal hunt; {he} lived, but the realm whispered of omens.',
      ], { short, his: his(civ.ruler), he: he(civ.ruler), game, place }) });
      effect(ctx, T.c(civ), 'lamed', { stability: -0.03 }, 8, 'The ruler lamed');
      heat(ctx, 'faction', 0.4);
    } else {
      record(ctx, { imp: 1, fold: true, text: say(world, [
        '{ruler} hunted {game} {place} with a hundred companions; the feast lasted three days.',
        '{short} rode out after {game} {place}, and brought home a trophy for the great hall.',
      ], { ruler: rulerName(civ.ruler), short, game, place }) });
      effect(ctx, T.c(civ), 'hunt', { stability: 0.01 }, 3, 'Royal hunt');
    }
    return true;
  },
});

registerEvent({
  id: 'realm.royal_wedding', scale: 'realm', family: 'court', cat: 'civ', imp: 1, cooldownYears: 15,
  label: 'Royal wedding', icon: 'marriage', hint: ['stability +0.02 for 10 years'],
  weight(ctx) {
    const { world, civ } = ctx;
    const age = rulerAge(world, civ);
    return civ.ruler && age != null && age < 45 && HEREDITARY.has(civ.government) ? 0.02 : 0;
  },
  fire(ctx) {
    const { world, civ } = ctx;
    const town = pick(world, largest(world, civ, 5));
    const v = { ruler: rulerName(civ.ruler), short: rulerShort(civ.ruler), who: personName(world, civ), town: town ? town.name : 'the provinces', cap: capitalOf(world, civ)?.name || 'the capital' };
    record(ctx, { imp: 1, fold: true, text: ctx.era <= 1 ? say(world, [
      '{ruler} took {who} of {town} to wife; the clans feasted for a week and exchanged gifts of cattle.',
      'The marriage of {short} and {who} of {town} joined two of the great families of the land.',
    ], v) : say(world, [
      '{ruler} married {who} of {town}; the feasting lasted a week, and every debtor in the realm was pardoned.',
      'The wedding of {short} and {who}, of the lords of {town}, was celebrated in {cap}.',
    ], v) });
    effect(ctx, T.c(civ), 'wedding', { stability: 0.02 }, 10, 'Royal wedding');
    return true;
  },
});

// ---------------------------------------------------------------------------
// Chiefs (era ≤ 1)

registerEvent({
  id: 'realm.giving_feast', scale: 'realm', family: 'court', cat: 'civ', imp: 2, maxEra: 1, cooldownYears: 25,
  label: 'Giving-feast', icon: 'fair', hint: ['stability +0.02 and contentment for 6 years'],
  weight(ctx) {
    const civ = ctx.civ;
    if (!civ.ruler || civ.settlementIds.length < 2) return 0;
    return 0.011 * (has(civ, 'generous', 'charismatic', 'ambitious') ? 1.6 : 1);
  },
  fire(ctx) {
    const { world, civ } = ctx;
    const town = capitalOf(world, civ);
    record(ctx, { text: say(world, [
      '{ruler} held a giving-feast at {town}: {n} cattle were slaughtered and every guest went home with a gift; no chief of the age could match it.',
      'For nine days {ruler} fed every family of {people} at {town}, and gave away so much that {he} slept on the bare ground after.',
      'The chiefs of every clan of {people} came to {town} for the feast of {short}; the songs about it were still sung a century later.',
      '{short} gave a feast at {town} for the naming of {his} heir, and broke the finest pots of the land on the hearthstone to show {his} wealth.',
    ], { ruler: rulerName(civ.ruler), short: rulerShort(civ.ruler), town: town ? town.name : 'the great camp', n: pick(world, ['forty', 'sixty', 'a hundred']), people: peopleOf(civ), he: he(civ.ruler), his: his(civ.ruler) }) });
    effect(ctx, T.c(civ), 'feast', { stability: 0.02, happiness: 0.02 }, 6, 'Giving-feast');
    return true;
  },
});

registerEvent({
  id: 'realm.oral_law', scale: 'realm', family: 'works', cat: 'civ', imp: 2, maxEra: 1, cooldownYears: 150,
  label: 'Laws of the elders', icon: 'scroll', hint: ['stability +0.03 for 80 years'],
  weight(ctx) {
    const civ = ctx.civ;
    if (civ.settlementIds.length < 2) return 0;
    return 0.005 * (has(civ, 'just', 'wise') ? 2 : 1);
  },
  fire(ctx) {
    const { world, civ } = ctx;
    const town = capitalOf(world, civ);
    record(ctx, { text: say(world, [
      'The elders of the clans met at the sacred grove of {town} and agreed the laws of {people}: a blood-price for a man, for a woman and for a cow.',
      '{ruler} had the old customs of {people} recited before the assembly at {town}, and from that day they were the law.',
    ], { town: town ? town.name : 'the meeting-stone', people: peopleOf(civ), ruler: rulerName(civ.ruler) }) });
    effect(ctx, T.c(civ), 'oral_law', { stability: 0.03 }, 80, 'Laws of the elders');
    return true;
  },
});

// ---------------------------------------------------------------------------
// Works and mercy

registerEvent({
  id: 'realm.great_road', scale: 'realm', family: 'works', cat: 'trade', imp: 2, minEra: 2, cooldownYears: 120,
  label: 'Great road', icon: 'road', hint: ['trade +0.06, movement and reach for two centuries'],
  weight(ctx) {
    const civ = ctx.civ;
    return hasTech(civ, 'wheel') && civ.settlementIds.length >= 4 ? 0.008 : 0;
  },
  fire(ctx) {
    const { world, civ } = ctx;
    const a = capitalOf(world, civ);
    if (!a) return false;
    let b = null, bv = 0;
    for (const s of civSettlements(world, civ)) {
      const d = Math.hypot(s.x - a.x, s.y - a.y);
      if (d < 6) continue;
      const v = d * Math.sqrt(s.population);
      if (v > bv) { bv = v; b = s; }
    }
    if (!b) return false;
    const road = pick(world, [`the ${rulerShort(civ.ruler)} Road`, `the ${civ.adjective} Way`, `the Road of ${placeWord(world, civ)}`, `the King’s Highway`]);
    record(ctx, { text: say(world, [
      '{ruler} built {road} from {a} to {b}, paved and ditched, with a post-house every day’s march.',
      'Ten thousand labourers laid {road} between {a} and {b}; armies and merchants would use it for centuries.',
    ], { ruler: rulerName(civ.ruler), road, a: a.name, b: b.name }) });
    effect(ctx, T.c(civ), 'road', { trade: 0.06, movement: 0.05, adminRange: 2 }, 200, road);
    effect(ctx, T.s(a), 'road', { trade: 1.06 }, 100, road);
    effect(ctx, T.s(b), 'road', { trade: 1.06 }, 100, road);
    return true;
  },
});

registerEvent({
  id: 'realm.law_code', scale: 'realm', family: 'works', cat: 'civ', imp: 2, minEra: 2, cooldownYears: 200,
  label: 'Law code', icon: 'scroll', hint: ['stability +0.04, tax efficiency +0.04 for 150 years'],
  weight(ctx) {
    const civ = ctx.civ;
    if (!hasTech(civ, 'writing')) return 0;
    return 0.006 * (has(civ, 'just', 'wise') ? 2 : 1) * (hasTech(civ, 'laws') ? 1.5 : 1);
  },
  fire(ctx) {
    const { world, civ } = ctx;
    const code = `the Code of ${rulerShort(civ.ruler)}`;
    record(ctx, { text: say(world, [
      '{ruler} had the laws of {people} carved on a pillar of black stone in the market of {cap}: {n} judgements, from the price of a stolen ox to the penalty for treason.',
      '{Code} was proclaimed in {cap}; for the first time {people0} could know the law before a judge pronounced it.',
    ], { ruler: rulerName(civ.ruler), people: peopleOf(civ), people0: withArticle(civ.adjective || 'subject'), cap: capitalOf(world, civ)?.name || 'the capital', n: fmtInt(world.rng.int(18, 28) * 10), Code: cap(code) }) });
    effect(ctx, T.c(civ), 'laws', { stability: 0.04, taxEfficiency: 0.04 }, 150, code);
    return true;
  },
});

function famineTowns(world, civ) {
  const out = [];
  for (const id of civ.settlementIds) { const s = world.settlements[id]; if (s && s.alive && s.famine > 0) out.push(s); }
  return out.sort((a, b) => b.famine - a.famine || b.population - a.population);
}
registerEvent({
  id: 'realm.famine_relief', scale: 'realm', family: 'works', cat: 'civ', imp: 2, cooldownYears: 15, chain: ['hunger'],
  label: 'Famine relief', icon: 'farm', hint: ['granaries opened: health, contentment and food in hungry towns', 'or refused, and remembered'],
  weight(ctx) {
    const { world, civ } = ctx;
    for (const id of civ.settlementIds) { const s = world.settlements[id]; if (s && s.alive && s.famine > 0) return 0.15; }
    return 0;
  },
  fire(ctx) {
    const { world, civ } = ctx;
    const towns = famineTowns(world, civ).slice(0, 6);
    if (!towns.length) return false;
    const ruler = rulerName(civ.ruler);
    if (has(civ, 'greedy', 'cruel') && !has(civ, 'generous', 'just')) {
      record(ctx, { text: say(world, [
        'While {town} starved, {ruler} kept the royal granaries locked; the hungry remembered whose wheat had rotted in them.',
        '{ruler} refused to remit the grain tithe of famine-struck {town}, and sent soldiers to collect it.',
      ], { town: towns[0].name, ruler }) });
      for (const s of towns) effect(ctx, T.s(s), 'relief', { unrest: 0.12, loyalty: -0.08 }, 6, 'Relief refused');
      heat(ctx, 'unrest', 0.6);
    } else {
      record(ctx, { text: say(world, [
        '{ruler} opened the royal granaries to the starving of {list}; carts of grain rolled out of {cap} all winter.',
        'Grain bought from far markets saved {town} from the famine; {ruler} paid for it from {his} own treasure.',
      ], { ruler, list: towns.slice(0, 3).map((s) => s.name).join(', ').replace(/, ([^,]*)$/, ' and $1'), cap: capitalOf(world, civ)?.name || 'the capital', town: towns[0].name, his: his(civ.ruler) }) });
      for (const s of towns) effect(ctx, T.s(s), 'relief', { health: 0.05, happiness: 0.05, unrest: -0.1, foodYield: 1.1 }, 2, 'Famine relief');
      effect(ctx, T.c(civ), 'relief', { stability: 0.02 }, 5, 'Famine relief');
      for (const s of towns) spendHeat(world, 'hunger', SUBJ.town(s.id), 0.5);
    }
    return true;
  },
});

registerEvent({
  id: 'realm.flight_of_scholars', scale: 'realm', family: 'learning', cat: 'tech', imp: 2, minEra: 2, cooldownYears: 40,
  label: 'Flight of scholars', icon: 'scroll', hint: ['research −12% here and +12% in the realm that takes them in (20 years)'],
  weight(ctx) {
    const { world, civ } = ctx;
    const tyrant = has(civ, 'cruel', 'mad', 'paranoid');
    if (!((civ.stability ?? 1) < 0.4 || tyrant)) return 0;
    const learned = civSettlements(world, civ).some((s) => s.buildings && (+s.buildings.library || +s.buildings.university));
    return learned ? 0.012 * (tyrant ? 1.5 : 1) : 0;
  },
  fire(ctx) {
    const { world, civ } = ctx;
    let dest = null, dv = -1;
    for (const k in civ.relations) {
      const o = world.civs[k];
      if (!o || !o.alive || o.id === civ.id || areAtWar(world, civ.id, o.id) || (o.tech?.era || 0) < 2) continue;
      const v = (o.stability ?? 0.5) + 0.1 * (o.tech?.era || 0) + (rulerHas(o, 'scholarly') ? 0.3 : 0);
      if (v > dv && (o.stability ?? 0.5) > (civ.stability ?? 0.5)) { dv = v; dest = o; }
    }
    if (!dest) return false;
    const src = civSettlements(world, civ).find((s) => s.buildings && (+s.buildings.university || +s.buildings.library)) || capitalOf(world, civ);
    const dst = capitalOf(world, dest);
    const why = has(civ, 'cruel', 'mad', 'paranoid') ? `the cruelty of ${rulerName(civ.ruler)}` : `the troubles of ${civName(civ)}`;
    record(ctx, { text: say(world, [
      'Fleeing {why}, the scholars of {src} carried their books across the border to {dst}, where {dr} gave them a hall of their own.',
      'The masters of {src} left by night with their pupils and their manuscripts; within a year they were teaching in {dst}.',
    ], { why, src: src ? src.name : 'the capital', dst: dst ? dst.name : civName(dest), dr: rulerName(dest.ruler) }) });
    effect(ctx, T.c(civ), 'exodus', { research: -0.12 }, 20, 'Scholars fled');
    effect(ctx, T.c(dest), 'scholars', { research: 0.12, culture: 0.05 }, 20, 'Refugee scholars');
    heat(ctx, 'learning', 0.6, SUBJ.realm(dest.id));
    return true;
  },
});

