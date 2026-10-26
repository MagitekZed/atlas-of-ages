// Battles in full (chunk 2, docs/design/war-machine.md): the ground, the weather, each side's plan,
// and the moment that decided the day.
//
// The ground is the site's landscape (fords, hills, pass, marsh, wood, sands, snows, shore, field);
// the weather is the tile's that day (rain, snow, heat, fog or clear). Both bend each role's worth
// (horse founders in marsh and forest, bows fail in the rain, spears hold a ford). Each side picks
// the plan that suits its companies, its general and the ground best among those it knows: every
// realm knows the plain ones, the steppe its feigned retreat, the legions the hammer and anvil,
// the gunpowder ages the pike square and volley fire, and a realm beaten in a named battle by a
// plan it did not know learns it (forces.learned). A plan lifts its side by 5 to 20 %. The account
// is kept with the battle in the war's ledger as codes ([ground, weather, plan won, plan lost,
// moment, prisoners]) and told in the Chronicle. No rng is drawn here.
//
// Exports: GROUNDS, WEATHERS, PLANS, groundCode, weatherAt, roleFactor, choosePlan, planBonus,
//          momentOf, momentText, learnPlan, planWord

import { ROLE, roleName } from './army.js';
import { clamp } from '../../core/util.js';

export const GROUNDS = ['field', 'fords', 'hills', 'pass', 'marsh', 'wood', 'sands', 'snows', 'shore', 'sea'];
export const WEATHERS = ['clear', 'rain', 'snow', 'heat', 'fog'];
const GROUND_WORDS = ['open ground', 'a ford', 'high ground', 'a pass', 'marshland', 'woodland', 'sand', 'snow', 'the shore', 'the sea'];
const WEATHER_WORDS = ['fair weather', 'driving rain', 'falling snow', 'burning heat', 'thick fog'];
export const groundWord = (g) => GROUND_WORDS[g] || 'open ground';
export const weatherWord = (x) => WEATHER_WORDS[x] || 'fair weather';

export const groundCode = (land) => Math.max(0, GROUNDS.indexOf(land));

/** The weather on tile i today. */
export function weatherAt(world, i) {
  const f = world.f;
  const t = f.temp[i], rain = f.rain[i];
  if (t < 0 && (f.snow[i] > 0.2 || rain >= 0.3)) return 2;
  if (rain >= 0.45) return 1;
  if (t >= 30) return 3;
  if (f.humidity && f.humidity[i] >= 0.92 && t > 2 && t < 18) return 4;
  return 0;
}

const HORSE = (r) => r === ROLE.LHORSE || r === ROLE.HHORSE;
const FOOT_HEAVY = (r) => r === ROLE.BLADE || r === ROLE.HHORSE;

/** × a role's worth on this ground in this weather. */
export function roleFactor(g, wx) {
  return (r) => {
    let m = 1;
    const G = GROUNDS[g];
    if (HORSE(r)) { if (G === 'wood' || G === 'marsh' || G === 'hills' || G === 'pass' || G === 'snows') m *= 0.6; else if (G === 'field' || G === 'sands') m *= 1.15; }
    if (r === ROLE.BOW && (G === 'hills')) m *= 1.2;
    if (r === ROLE.SPEAR && (G === 'fords' || G === 'pass')) m *= 1.15;
    if (r === ROLE.BOW && (wx === 1 || wx === 2)) m *= 0.75;
    if (r === ROLE.BOW && wx === 4) m *= 0.7;
    if (HORSE(r) && (wx === 1 || wx === 2)) m *= 0.8;
    if (FOOT_HEAVY(r) && wx === 3) m *= 0.9;
    return m;
  };
}

// plans: [key, bonus, words for the winner's deed]
export const PLANS = [
  { k: 'line', b: 0.05, w: 'held the line' },
  { k: 'shieldwall', b: 0.10, w: 'locked shields' },
  { k: 'pikes', b: 0.15, w: 'formed pike squares' },
  { k: 'arrows', b: 0.12, w: 'loosed storm after storm of arrows' },
  { k: 'flank', b: 0.12, w: 'turned the flank' },
  { k: 'feint', b: 0.15, w: 'feigned flight and turned' },
  { k: 'hammer', b: 0.18, w: 'struck as hammer and anvil' },
  { k: 'volley', b: 0.15, w: 'fired in volleys' },
  { k: 'night', b: 0.20, w: 'attacked by night' },
];
const P = Object.fromEntries(PLANS.map((p, k) => [p.k, k]));
export const planWord = (k) => PLANS[k]?.w || 'fought';

const knows = (civ, id) => Boolean(civ && civ.tech && civ.tech.known && civ.tech.known[id] != null);

/** Whether a realm can use a plan: the plain ones always; the rest by its knowledge, its land or what it has learned. */
function canUse(civ, k, sh) {
  const learned = civ && civ.forces && Array.isArray(civ.forces.learned) ? civ.forces.learned : null;
  if (learned && learned.includes(k)) return true;
  switch (k) {
    case 'line': case 'shieldwall': case 'arrows': case 'flank': case 'night': return true;
    case 'feint': return sh[ROLE.LHORSE] >= 0.25;
    case 'hammer': return knows(civ, 'tactics');
    case 'pikes': return knows(civ, 'gunpowder') || knows(civ, 'feudalism');
    case 'volley': return knows(civ, 'gunpowder');
    default: return false;
  }
}

/**
 * The plan a side fights by (an index into PLANS): the one that suits it best of those it knows.
 * sh, eh: its and the enemy's shares by role; skill: its general's; ratio: its strength over the enemy's.
 */
export function choosePlan(civ, sh, eh, g, wx, skill, ratio, home, tier) {
  const G = GROUNDS[g];
  const open = G === 'field' || G === 'sands' || G === 'shore';
  const horse = sh[ROLE.LHORSE] + sh[ROLE.HHORSE];
  let best = P.line, bs = 0.05;
  const fit = (k, v) => { if (v > bs && canUse(civ, k, sh)) { bs = v; best = P[k]; } };
  if (sh[ROLE.SPEAR] + sh[ROLE.BLADE] >= 0.6 && home && tier <= 2) fit('shieldwall', 0.10);
  if (tier >= 4 && sh[ROLE.SPEAR] >= 0.15 && eh[ROLE.LHORSE] + eh[ROLE.HHORSE] >= 0.15) fit('pikes', 0.15);
  if (sh[ROLE.BOW] >= 0.35 && G !== 'wood' && wx !== 1 && wx !== 2 && wx !== 4) fit('arrows', tier >= 4 ? 0.06 : 0.12);
  if (horse >= 0.2 && open) fit('flank', 0.12);
  if (sh[ROLE.LHORSE] >= 0.25 && open && skill >= 1.0) fit('feint', 0.15);
  if (sh[ROLE.HHORSE] >= 0.1 && sh[ROLE.SPEAR] + sh[ROLE.BLADE] >= 0.4 && skill >= 1.05 && open) fit('hammer', 0.18);
  if (tier >= 4 && sh[ROLE.BOW] >= 0.35 && wx !== 1) fit('volley', 0.15);
  if (skill >= 1.15 && ratio < 0.7) fit('night', 0.20);
  return best;
}

/** × on a side's power from its plan against the enemy's mix (the feigned retreat undoes heavy foot; pikes stop horse). */
export function planBonus(k, eh) {
  const p = PLANS[k];
  if (!p) return 1;
  let b = p.b;
  if (p.k === 'feint') b *= 1 + eh[ROLE.BLADE] + eh[ROLE.SPEAR] * 0.5;
  if (p.k === 'pikes') b *= 1 + eh[ROLE.HHORSE] * 2;
  if (p.k === 'arrows' || p.k === 'volley') b *= 1 - 0.5 * (eh[ROLE.LHORSE]);
  return 1 + clamp(b, 0, 0.3);
}

/**
 * What decided the day, as a code: the winner's plan when it was not the plain line, else the
 * clash where the winner's companies were strongest against the loser's (0–5 by role pairs).
 */
export function momentOf(planW, shW, shL) {
  if (planW !== P.line) return 10 + planW;
  if (shL[ROLE.HHORSE] + shL[ROLE.LHORSE] >= 0.2 && shW[ROLE.SPEAR] >= 0.3) return 1;   // horse on the spears
  if (shW[ROLE.HHORSE] >= 0.12 && shL[ROLE.BOW] + shL[ROLE.BLADE] >= 0.4) return 2;   // the knights rode down the foot
  if (shW[ROLE.BOW] >= 0.3) return 3;                                                // the archers
  if (shW[ROLE.BEAST] >= 0.08) return 4;                                             // the beasts
  return 0;                                                                          // the line broke
}

/** The decisive moment in words, for the Chronicle and the account. */
export function momentText(code, adjW, adjL, tierW, tierL) {
  if (code >= 10) {
    const k = PLANS[code - 10]?.k;
    switch (k) {
      case 'shieldwall': return `the ${adjL} host broke itself on the ${adjW} shield wall`;
      case 'pikes': return `the ${adjL} horse broke on the ${adjW} pikes`;
      case 'arrows': return `${adjW} arrows thinned the ${adjL} ranks before ever they closed`;
      case 'flank': return `the ${adjW} horse turned the ${adjL} flank`;
      case 'feint': return `the ${adjW} horsemen feigned flight, drew the ${adjL} foot into the open, and turned on it`;
      case 'hammer': return `the ${adjW} foot held while their ${roleName(ROLE.HHORSE, tierW)} fell on the ${adjL} rear`;
      case 'volley': return `${adjW} ${roleName(ROLE.BOW, tierW)} fired volley after volley into the ${adjL} lines`;
      case 'night': return `the ${adjW} host struck by night and caught the ${adjL} camp asleep`;
      default: break;
    }
  }
  switch (code) {
    case 1: return `the ${adjL} ${roleName(ROLE.HHORSE, tierL)} spent themselves on the ${adjW} spears`;
    case 2: return `the ${adjW} ${roleName(ROLE.HHORSE, tierW)} rode down the ${adjL} foot`;
    case 3: return `the ${adjW} ${roleName(ROLE.BOW, tierW)} carried the day`;
    case 4: return `the ${adjW} war beasts broke the ${adjL} line`;
    default: return `the ${adjL} line broke`;
  }
}

/** A realm beaten in a named battle by a plan it did not know takes it up. */
export function learnPlan(civ, k) {
  const p = PLANS[k];
  if (!civ || !civ.forces || !p || p.k === 'line') return false;
  const L = (civ.forces.learned ||= []);
  if (L.includes(p.k)) return false;
  L.push(p.k);
  return true;
}
