// The pair deck: diplomatic incidents between neighbours, so wars stop coming out of nowhere
// (and some never come). Border skirmishes, insulted envoys, spy scandals, embargoes, refugee
// quarrels and assassination plots build grievance and sour opinion; hostage exchanges,
// royal visits, embassies and royal marriages build trust. Incidents move only opinion,
// trust and grievance (the inputs WP4's diplomacy and war already read), plus 'feud' and
// 'amity' heat that our warAppetite provider reads. At most one incident per pair per 8
// years (engine); each names a real town or ruler. A royal marriage uses WP3's
// arrangeMarriage when it exists.

import { registerEvent } from '../../../core/events.js';
import { addOpinion, rel, areAtWar } from '../../../core/entities.js';
import { DAYS_PER_YEAR } from '../../../core/constants.js';
import { record, heat, effect, T, marry, evState } from '../engine.js';
import { spendHeat } from '../heat.js';
import { borderTowns } from './early.js';
import {
  pick, say, civName, CivName, peopleOf, rulerName, rulerShort, rulerHas, his, personName, countWord,
} from '../prose.js';

const Y = DAYS_PER_YEAR;
const op = (r) => (r && Number.isFinite(r.opinion) ? r.opinion : 0);
const has = (civ, ...t) => t.some((x) => rulerHas(civ, x));
const capOf = (world, civ) => (civ.capitalId != null ? world.settlements[civ.capitalId] || null : null);
const HEREDITARY = new Set(['tribe', 'chiefdom', 'kingdom', 'empire', 'horde', 'feudal', 'constitutional']);

function trust(world, a, b, d) {
  const r = rel(world, a.id, b.id);
  r.trust = Math.max(0, Math.min(1, (Number.isFinite(r.trust) ? r.trust : 0.5) + d));
}
function grieve(world, victim, culprit, d) {
  const r = rel(world, victim.id, culprit.id);
  r.grievance = Math.max(0, Math.min(100, (r.grievance || 0) + d));
}
/** Order the pair so the first is the side the trait test favours (ties: rng). */
function sideBy(world, a, b, score) {
  const x = score(a) + world.rng.next() * 0.3, y = score(b) + world.rng.next() * 0.3;
  return x >= y ? [a, b] : [b, a];
}
const peaceable = (ctx) => !areAtWar(ctx.world, ctx.a.id, ctx.b.id);

registerEvent({
  id: 'pair.border_skirmish', scale: 'pair', family: 'feud', cat: 'diplomacy', imp: 2, minEra: 2, cooldownYears: 12, chain: ['feud'],
  label: 'Border skirmish', icon: 'battle', hint: ['opinion −6, grievance +5', 'feud: war grows likelier'],
  weight(ctx) {
    if (!peaceable(ctx) || !(ctx.ra && ctx.ra.border > 0) || op(ctx.ra) > 20) return 0;
    return 0.015 * (1 + ctx.heat('feud')) * (1 + Math.max(0, Math.min(1, ctx.ra.tension || 0)));
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    const tw = borderTowns(world, a, b);
    if (!tw) return false;
    const [att, vic] = sideBy(world, a, b, (c) => (c.traits?.aggression ?? 0.5) + (has(c, 'warlike', 'ambitious') ? 0.3 : 0));
    const town = tw[att === a ? 1 : 0];
    const n = world.rng.int(4, 40);
    record(ctx, { civ: vic, s: town, text: say(world, [
      'Soldiers of {A} and {B} came to blows near {town}, on the border; {n} men died, and each side swore the other had struck first.',
      'A patrol of {A} crossed the stream that marked the border at {town} and burned a watchtower of {B}; {rv} demanded blood-money and got none.',
      'Herdsmen and border guards fought a pitched little battle outside {town}; {A} called it a skirmish, {B} an invasion.',
    ], { A: peopleOf(att), B: peopleOf(vic), town: town.name, n: countWord(n), rv: rulerName(vic.ruler) }) });
    addOpinion(world, a.id, b.id, -6);
    grieve(world, vic, att, 5);
    heat(ctx, 'feud', 0.5);
    return true;
  },
});

registerEvent({
  id: 'pair.insulted_envoy', scale: 'pair', family: 'envoys', cat: 'diplomacy', imp: 2, minEra: 1, cooldownYears: 15, chain: ['feud'],
  label: 'Envoy insulted', icon: 'scroll', hint: ['opinion −10', 'a grudge at the insulted court'],
  weight(ctx) {
    const { a, b } = ctx;
    if (!peaceable(ctx)) return 0;
    const proud = has(a, 'cruel', 'paranoid', 'ambitious', 'mad') || has(b, 'cruel', 'paranoid', 'ambitious', 'mad');
    return 0.012 * (proud ? 2 : 0.6);
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    const [rude, hurt] = sideBy(world, a, b, (c) => (has(c, 'cruel', 'paranoid', 'ambitious', 'mad') ? 1 : 0));
    const envoy = personName(world, hurt);
    const she = world.rng.chance(0.3);
    record(ctx, { civ: rude, text: say(world, [
      '{rr} had the beard of {envoy}, envoy of {B}, shaved off and sent him home on a donkey; {hr} swore it would not be forgotten.',
      'At the court of {rr}, the envoy {envoy} of {B} was seated below the grooms and laughed at; {he} left the same night.',
      '{rr} received the embassy of {B} with an insult to {hr}’s mother, and the gifts were thrown into the moat.',
    ], { rr: rulerName(rude.ruler), envoy, B: peopleOf(hurt), hr: rulerShort(hurt.ruler), he: she ? 'she' : 'he' }) });
    addOpinion(world, a.id, b.id, -10);
    grieve(world, hurt, rude, 3);
    heat(ctx, 'feud', 0.3);
    return true;
  },
});

registerEvent({
  id: 'pair.hostage_exchange', scale: 'pair', family: 'envoys', cat: 'diplomacy', imp: 1, minEra: 1, cooldownYears: 20, chain: ['amity'],
  label: 'Hostage exchange', icon: 'scroll', hint: ['trust +0.1, opinion +4'],
  weight(ctx) {
    const o = op(ctx.ra);
    if (!peaceable(ctx) || o < -30 || o > 40) return 0;
    return 0.015 * (1 + ctx.heat('feud') * 0.5);
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    record(ctx, { fold: true, text: say(world, [
      'To seal the peace, {A} and {B} exchanged hostages: the sons of {n} noble houses went to live at each other’s courts.',
      '{ra} sent {his} nephew to be raised at the court of {rb}, and took a daughter of {B} in return.',
    ], { A: peopleOf(a), B: peopleOf(b), n: countWord(world.rng.int(3, 8)), ra: rulerName(a.ruler), rb: rulerName(b.ruler), his: his(a.ruler) }) });
    trust(world, a, b, 0.1); trust(world, b, a, 0.1);
    addOpinion(world, a.id, b.id, 4);
    heat(ctx, 'amity', 0.3);
    spendHeat(world, 'feud', ctx.subject, 0.3);
    return true;
  },
});

registerEvent({
  id: 'pair.royal_visit', scale: 'pair', family: 'envoys', cat: 'diplomacy', imp: 2, minEra: 1, cooldownYears: 20, chain: ['amity'],
  label: 'Royal visit', icon: 'crown', hint: ['opinion +8, trust +0.05'],
  weight(ctx) {
    if (!peaceable(ctx) || op(ctx.ra) < -20) return 0;
    return 0.015 * (has(ctx.a, 'charismatic', 'generous') || has(ctx.b, 'charismatic', 'generous') ? 1.6 : 1) * (1 + ctx.heat('amity'));
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    const [host, guest] = sideBy(world, a, b, (c) => (c.population || 0) / 1e5);
    const c = capOf(world, host);
    const gift = pick(world, ['a white elephant', 'forty horses with silver bridles', 'a golden astrolabe', 'a chest of cinnamon', 'a pair of hunting leopards', 'a jewelled sword']);
    record(ctx, { civ: guest, text: say(world, [
      '{gr} crossed the border with a train of {n} wagons to visit {hr} at {cap}; the gift of {gift} was remembered for a generation.',
      '{hr} welcomed {gr} to {cap} with a week of games; the two rulers swore friendship over {gift}.',
    ], { gr: rulerName(guest.ruler), hr: rulerName(host.ruler), n: countWord(world.rng.int(20, 90)), cap: c ? c.name : 'the capital', gift }) });
    addOpinion(world, a.id, b.id, 8);
    trust(world, a, b, 0.05); trust(world, b, a, 0.05);
    heat(ctx, 'amity', 0.4);
    return true;
  },
});

registerEvent({
  id: 'pair.embassy', scale: 'pair', family: 'envoys', cat: 'diplomacy', imp: 1, minEra: 2, cooldownYears: 40,
  label: 'Embassy', icon: 'scroll', hint: ['trust +0.08, opinion +3'],
  weight(ctx) {
    if (!peaceable(ctx)) return 0;
    return 0.02 * ((ctx.ra && ctx.ra.trade > 0) ? 1.5 : 1);
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    const [from, to] = sideBy(world, a, b, () => 0);
    const c = capOf(world, to);
    record(ctx, { civ: from, fold: true, text: say(world, [
      '{A} sent a standing embassy to {cap}, and bought a house for it near the palace of {rb}.',
      'Envoys of {a} took up residence at {cap}; letters passed between the two courts every season.',
    ], { A: CivName(from), a: civName(from), cap: c ? c.name : civName(to), rb: rulerName(to.ruler) }) });
    trust(world, a, b, 0.08); trust(world, b, a, 0.08);
    addOpinion(world, a.id, b.id, 3);
    return true;
  },
});

registerEvent({
  id: 'pair.spy_scandal', scale: 'pair', family: 'envoys', cat: 'diplomacy', imp: 2, minEra: 2, cooldownYears: 20, chain: ['feud'],
  label: 'Spy scandal', icon: 'eye', hint: ['trust −0.2, opinion −8'],
  weight(ctx) {
    if (!peaceable(ctx)) return 0;
    return 0.01 * (op(ctx.ra) < 0 ? 1.5 : 1) * (has(ctx.a, 'paranoid') || has(ctx.b, 'paranoid') ? 1.5 : 1);
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    const [spy, mark] = sideBy(world, a, b, (c) => (c.traits?.aggression ?? 0.5));
    const tw = borderTowns(world, spy, mark);
    const town = tw ? tw[1] : capOf(world, mark);
    record(ctx, { civ: mark, s: town || undefined, text: say(world, [
      'A spy of {A} was caught copying the plans of the fortress at {town}; {mr} sent back his head in a basket.',
      'Letters in cipher found on a merchant at {town} revealed that {A} had bought half the council of {B}.',
    ], { A: peopleOf(spy), B: peopleOf(mark), town: town ? town.name : 'the capital', mr: rulerShort(mark.ruler) }) });
    trust(world, mark, spy, -0.2);
    addOpinion(world, a.id, b.id, -8);
    heat(ctx, 'feud', 0.4);
    return true;
  },
});

registerEvent({
  id: 'pair.embargo', scale: 'pair', family: 'envoys', cat: 'trade', imp: 2, minEra: 2, cooldownYears: 30, chain: ['feud'],
  label: 'Embargo', icon: 'trade', hint: ['trade between them all but stops for 10 years', 'opinion −6'],
  weight(ctx) {
    if (!peaceable(ctx) || !(ctx.ra && ctx.ra.trade > 0) || op(ctx.ra) >= 0) return 0;
    return 0.03 * (1 + ctx.heat('feud'));
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    const [closer, shut] = sideBy(world, a, b, (c) => (has(c, 'greedy', 'paranoid', 'ambitious') ? 1 : 0));
    const tw = borderTowns(world, closer, shut);
    const lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id);
    evState(world).emb[lo + '_' + hi] = world.time.day + 10 * Y;
    record(ctx, { civ: closer, s: tw ? tw[0] : undefined, text: say(world, [
      '{cr} closed the markets of {A} to the merchants of {B}; caravans stood idle at {town} for ten years.',
      'In a quarrel over tolls, {A} seized the goods of every {badj} trader in its ports; the trade between the two realms withered.',
    ], { cr: rulerName(closer.ruler), A: civName(closer), B: peopleOf(shut), badj: shut.adjective || 'foreign', town: tw ? tw[0].name : 'the border' }) });
    addOpinion(world, a.id, b.id, -6);
    heat(ctx, 'feud', 0.2);
    return true;
  },
});

registerEvent({
  id: 'pair.refugee_dispute', scale: 'pair', family: 'envoys', cat: 'diplomacy', imp: 2, minEra: 1, cooldownYears: 15, luck: false, chain: ['refugees'], needs: ['refugees'],
  label: 'Refugee quarrel', icon: 'migration', hint: ['opinion −5, grievance +4'],
  weight(ctx) { return ctx.heat('refugees') > 0.2 ? 0.3 * ctx.heat('refugees') : 0; },
  fire(ctx) {
    const { world, a, b } = ctx;
    const [host, claim] = sideBy(world, a, b, (c) => (c.population || 0) / 1e5);
    record(ctx, { civ: claim, text: say(world, [
      '{B} demanded the return of the families who had fled into {A}; {hr} refused, and the border guards were doubled.',
      '{cr} called the refugees in {A} runaways and rebels; {hr} called them guests, and the envoys went home angry.',
    ], { A: civName(host), B: CivName(claim), hr: rulerName(host.ruler), cr: rulerName(claim.ruler) }) });
    addOpinion(world, a.id, b.id, -5);
    grieve(world, claim, host, 4);
    spendHeat(world, 'refugees', ctx.subject, 1);
    return true;
  },
});

registerEvent({
  id: 'pair.assassination_plot', scale: 'pair', family: 'envoys', cat: 'diplomacy', imp: 3, minEra: 1, cooldownYears: 60, chain: ['feud'],
  label: 'Assassination plot', icon: 'dagger', hint: ['grievance +25 (a cause for war)', 'opinion −20, trust −0.3'],
  weight(ctx) {
    if (!peaceable(ctx) || op(ctx.ra) > -20) return 0;
    return 0.004 * (1 + ctx.heat('feud'));
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    const [plot, mark] = sideBy(world, a, b, (c) => (has(c, 'cruel', 'paranoid', 'mad', 'ambitious') ? 1 : 0));
    const c = capOf(world, mark);
    record(ctx, { civ: mark, text: say(world, [
      'Assassins in the pay of {A} were caught in the palace of {mr} at {cap} with daggers in their sleeves; {ms} swore vengeance before the gods.',
      'A poisoner sent by {pr} was taken in the kitchens of {cap}; under torture she named her master, and {B} cried out for war.',
    ], { A: peopleOf(plot), mr: rulerName(mark.ruler), ms: rulerShort(mark.ruler), cap: c ? c.name : 'the capital', pr: rulerName(plot.ruler), B: peopleOf(mark) }) });
    grieve(world, mark, plot, 25);
    addOpinion(world, a.id, b.id, -20);
    trust(world, mark, plot, -0.3);
    heat(ctx, 'feud', 1);
    return true;
  },
});

registerEvent({
  id: 'pair.royal_marriage', scale: 'pair', family: 'envoys', cat: 'diplomacy', imp: 2, minEra: 1, cooldownYears: 40, chain: ['amity'],
  label: 'Royal marriage', icon: 'marriage', hint: ['opinion +10, trust +0.1', 'crowns bound by blood'],
  weight(ctx) {
    const { a, b } = ctx;
    if (!peaceable(ctx) || op(ctx.ra) <= 0 || !a.ruler || !b.ruler || !HEREDITARY.has(a.government) || !HEREDITARY.has(b.government)) return 0;
    return 0.012 * (1 + ctx.heat('amity'));
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    const res = marry(world, a, b, { cause: ctx.cause ?? null });
    if (res) {
      // WP3 makes the match (claims, spouses) and tells it; when it refuses, there is no match
      if (!res.ok) return false;
      if (res.entry) ctx.entry = res.entry;
      heat(ctx, 'amity', 0.6);
      return true;
    }
    const [giver, taker] = sideBy(world, a, b, () => 0);
    const c = capOf(world, taker);
    record(ctx, { civ: giver, text: say(world, [
      '{who}, {kin} of {gr}, was married to the heir of {tr} at {cap}; for a generation the two crowns would be bound by blood.',
      'The wedding of a prince of {A} and a princess of {B} was celebrated at {cap} with three days of tourneys and a peace that held.',
    ], { who: personName(world, giver), kin: pick(world, ['daughter', 'sister', 'niece']), gr: rulerName(giver.ruler), tr: rulerName(taker.ruler), cap: c ? c.name : 'the capital', A: civName(giver), B: civName(taker) }) });
    addOpinion(world, a.id, b.id, 10);
    trust(world, a, b, 0.1); trust(world, b, a, 0.1);
    heat(ctx, 'amity', 0.6);
    return true;
  },
});

registerEvent({
  id: 'pair.border_market', scale: 'pair', family: 'fortune', cat: 'trade', imp: 2, maxEra: 2, cooldownYears: 40, chain: ['amity'],
  label: 'Border market', icon: 'fair', hint: ['opinion +5; trade +10% in both border towns (10 years)'],
  weight(ctx) {
    if (!peaceable(ctx) || op(ctx.ra) < -10) return 0;
    return 0.014 * (1 + ctx.heat('amity'));
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    const tw = borderTowns(world, a, b);
    if (!tw) return false;
    const [sa, sb] = tw;
    record(ctx, { civ: a, s: sa, text: say(world, [
      'Each spring {A} and {B} began to meet to trade at a ford between {ta} and {tb}; the market there kept the peace better than any oath.',
      'At the boundary stone between {ta} and {tb}, {A} and {B} set up a market where no blade might be drawn.',
    ], { A: peopleOf(a), B: peopleOf(b), ta: sa.name, tb: sb.name }) });
    addOpinion(world, a.id, b.id, 5);
    effect(ctx, T.s(sa), 'border_market', { trade: 1.1 }, 10, 'Border market');
    effect(ctx, T.s(sb), 'border_market', { trade: 1.1 }, 10, 'Border market');
    heat(ctx, 'amity', 0.3);
    return true;
  },
});
