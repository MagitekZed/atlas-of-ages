// Governments: styled nation names, ruler titles, administrative capacity, tax policy,
// and yearly evolution — peaceful reforms when a state outgrows its institutions, and
// revolutions when stability collapses. civ.government holds a GOVERNMENTS key.
// Names and titles consult the ext 'nameStyle' providers first (a people's own forms: the
// Under-Kingdom of a dwarven hold, the Free Company of a mercenary state); the government
// tables are the fallback. A theocracy is no trap: crises of legitimacy, merchant wealth,
// learning and unrest all open ways out of it.

import { firstOf, hasProviders } from '../../core/ext.js';
import { GOVERNMENTS, isDynastic } from './data.js';
import { hasTech, refreshMods, getMods } from './tech.js';
import { fin, record, rateOk } from './state.js';
import { theName, TheName, rulerName, pick, demonym } from './prose.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';

export const govDef = (civ) => GOVERNMENTS[civ?.government] || GOVERNMENTS.tribe;
export const govLabel = (civ) => govDef(civ).label;

/** A people's own forms of name and title for a government (ext 'nameStyle'), or null. */
function nameStyleOf(world, civ, govKey) {
  if (!world || !hasProviders('nameStyle')) return null;
  const st = firstOf('nameStyle', world, civ, govKey || civ.government);
  return st && typeof st === 'object' ? st : null;
}
const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.length) : []);

/** Restyle civ.name from its base name, government and chosen style (world: for nameStyle). */
export function styleName(civ, world = null) {
  const g = govDef(civ);
  const own = nameStyleOf(world, civ, civ.government);
  const ownStyles = strs(own?.styles);
  const single = !ownStyles.length && g.singleStyle && civ.settlementIds && civ.settlementIds.length === 1;
  const styles = ownStyles.length ? ownStyles : g.styles;
  const k = Math.abs(fin(civ.flags?.style, 0)) % styles.length;
  const tpl = single ? g.singleStyle : styles[k];
  civ.name = tpl.replace('{name}', civ.baseName).replace('{adj}', civ.adjective).replace('{dem}', demonym(civ.adjective)).replace(/^the\s+/i, '');
  civ.flags ||= {};
  civ.flags.styled = true;
  return civ.name;
}

/** Title for a ruler of this civ (gender 'f'|'m'); a people's own titles come first. */
export function rulerTitle(world, civ, gender) {
  const own = nameStyleOf(world, civ, civ.government);
  if (own && own.titles) {
    const list = strs(gender === 'f' ? own.titles.f || own.titles.m : own.titles.m);
    if (list.length) return list[Math.abs(fin(civ.flags?.titleVar, 0)) % list.length];
  }
  const g = govDef(civ);
  const v = g.titles[Math.abs(fin(civ.flags?.titleVar, 0)) % g.titles.length];
  return v[gender === 'f' ? 1 : 0];
}

/**
 * Settlements (tier-weighted: villages count less) the state can administer before overextension.
 * Administrative reach improves through the Medieval age, then levels off, so late empires
 * still strain at their edges instead of growing without limit.
 */
export function govCapacity(civ, mods) {
  const g = govDef(civ);
  const era = Math.min(4, fin(civ.tech?.era, 0));
  return g.capacity * (1 + 0.2 * era) + (fin(mods?.adminRange, 12) - 12) * 0.4;
}

/** Tax rate the state drifts toward (government, ruler, war, debt). */
export function targetTax(world, civ, atWar) {
  let t = govDef(civ).tax;
  for (const tr of civ.ruler?.traits || []) {
    if (tr === 'greedy') t += 0.04;
    else if (tr === 'cruel') t += 0.02;
    else if (tr === 'generous') t -= 0.02;
  }
  if (atWar) t += 0.04;
  if (civ.treasury < 0) t += 0.05;
  else if (civ.treasury > 200 + civ.population * 0.05) t -= 0.03;
  return Math.max(0.02, Math.min(0.45, t));
}

/**
 * Switch government. opts: { silent, cause: 'reform'|'revolution'|'founding', text, imp,
 *   keepTitle (the sitting ruler is about to be replaced: leave the old title for the record) }
 * Ruler titles follow; dynastic → elective ends the dynasty's hold on the title.
 */
export function adoptGovernment(world, civ, key, opts = {}) {
  if (!GOVERNMENTS[key]) key = 'tribe';
  const prevName = civ.name;
  const prev = civ.government;
  civ.government = key;
  civ.flags ||= {};
  if (prev !== key) civ.flags.prevGov = prev;
  const nStyles = GOVERNMENTS[key].styles.length;
  civ.flags.style = world.rng.int(0, nStyles - 1);
  civ.flags.titleVar = world.rng.int(0, GOVERNMENTS[key].titles.length - 1);
  civ.flags.govSince = world.time.day;
  styleName(civ, world);
  // a new form of government should read as one ("Realm of Bara became the Realm of Bara")
  for (let k = 1; k < nStyles && prev !== key && civ.name === prevName; k++) {
    civ.flags.style = (civ.flags.style + 1) % nStyles;
    styleName(civ, world);
  }
  if (civ.ruler && !opts.keepTitle) {
    civ.ruler.title = rulerTitle(world, civ, civ.ruler.gender);
    if (!isDynastic(key)) civ.ruler.dynasty = civ.ruler.dynasty || null;
  }
  refreshMods(world, civ);
  if (!opts.silent && prev !== key) {
    const text = opts.text || (opts.cause === 'revolution'
      ? pick(world, [
        `Revolution swept ${prevName.startsWith('the ') ? prevName : 'the ' + prevName}; from its ruins rose ${theName(civ)}.`,
        `The old order of ${civ.baseName} was overthrown, and ${theName(civ)} was proclaimed.`,
      ])
      : prev === 'tribe'
        ? pick(world, [
          `The ${civ.adjective} clans united under a single ruler, and ${theName(civ)} was born.`,
          `${civ.ruler ? rulerName(civ.ruler) : 'A great chief'} bound the ${civ.adjective} clans together as ${theName(civ)}.`,
        ])
        : civ.name === prevName
          ? `${TheName(civ)} remade itself as ${/^[aeiou]/i.test(GOVERNMENTS[key].label) ? 'an' : 'a'} ${GOVERNMENTS[key].label.toLowerCase()}.`
          : pick(world, [
          `The ${prevName} became ${theName(civ)}.`,
          `${civ.ruler ? rulerName(civ.ruler) : 'The council'} proclaimed ${theName(civ)}, ending the old ${GOVERNMENTS[prev]?.label.toLowerCase() || 'order'}.`,
          `${TheName(civ)} rose from the ${prevName}, with new laws and a new name.`,
        ]));
    record(world, { cat: 'civ', imp: opts.imp ?? (prev === 'tribe' || fin(civ.population) < 20000 ? 2 : 3), key: opts.cause === 'revolution' ? 'gov.revolution' : prev === 'tribe' ? 'gov.unite' : 'gov.reform', text, civ, tags: [key] });
    if (civ.ruler?.deeds) civ.ruler.deeds.reforms = (civ.ruler.deeds.reforms || 0) + 1;
  }
  return civ;
}

/**
 * Yearly: should the state reform? Peaceful evolution by size, era, traits and events.
 * agg: { pop, n, coastShare, conquests } monthly aggregates.
 */
export function evaluateGovernment(world, civ, agg) {
  const g = civ.government;
  const tr = civ.traits || {};
  const era = fin(civ.tech?.era, 0);
  const yrs = (world.time.day - fin(civ.flags.govSince, 0)) / DAYS_PER_YEAR;
  if (yrs < 25) return false;
  const n = agg.n, pop = agg.pop;
  const relig = fin(tr.religiosity, 0.5), comm = fin(tr.commerce, 0.5), tol = fin(tr.tolerance, 0.5), aggr = fin(tr.aggression, 0.5);
  const holy = civ.stateReligion != null;
  const steppe = fin(civ.flags.steppe, 0);
  const options = [];
  const add = (key, w) => { if (w > 0 && key !== g && era >= GOVERNMENTS[key].minEra) options.push([key, w]); };
  switch (g) {
    case 'tribe':
      if (n >= 3 || pop >= 2500) {
        add('chiefdom', 1);
        if (steppe > 0.45 && hasTech(civ, 'horseback') && aggr > 0.5) add('horde', 0.8);
      }
      break;
    case 'chiefdom':
      if ((n >= 5 || pop >= 9000) && (hasTech(civ, 'writing') || hasTech(civ, 'bronze'))) {
        add('kingdom', 1);
        if (relig > 0.6) add('theocracy', 0.3 + (holy ? 0.35 : 0));
        if (steppe > 0.4 && hasTech(civ, 'horseback')) add('horde', 0.6 + aggr * 0.4);
      }
      break;
    case 'horde':
      if (hasTech(civ, 'writing') && (n >= 8 || fin(civ.flags.conquests) >= 3)) add('empire', 0.8);
      if (hasTech(civ, 'laws') && steppe < 0.35) add('kingdom', 0.8);
      break;
    case 'kingdom':
      if ((n >= 12 || fin(civ.flags.conquests) >= 4) && era >= 2) add('empire', 0.9);
      if (hasTech(civ, 'feudalism') && n >= 7) add('feudal', 0.7);
      if (hasTech(civ, 'philosophy') && comm + tol > 1.2) add('republic', 0.35);
      if (hasTech(civ, 'currency') && comm > 0.65 && agg.coastShare > 0.4 && n <= 10) add('merchant', 0.5);
      if (hasTech(civ, 'printing') && tol > 0.5) add('constitutional', 0.6);
      if (relig > 0.75 && holy) add('theocracy', 0.3);
      break;
    case 'theocracy': {
      // the ways out of priestly rule: learning, a crisis of faith in the priests, merchant money
      if (hasTech(civ, 'philosophy') && relig < 0.55) add('kingdom', 0.5);
      if (hasTech(civ, 'printing') && tol > 0.6) add('republic', 0.4);
      if (fin(civ.legitimacy, 0.6) < 0.42) add(era >= 1 ? 'kingdom' : 'chiefdom', 0.5 + (0.42 - fin(civ.legitimacy, 0.6)) * 2);
      if (hasTech(civ, 'currency') && comm > 0.55 && (agg.coastShare > 0.3 || n <= 6)) add('merchant', 0.35 + (comm - 0.55));
      if (era >= 3 && fin(civ.flags?.avgUnrest) > 0.3) add('republic', 0.3);
      if (!holy && relig < 0.65) add(era >= 2 && n >= 12 ? 'empire' : 'kingdom', 0.35);
      // a warrior on the throne of the priests, or a realm grown great by the sword
      if ((civ.ruler?.traits || []).some((t) => t === 'warlike' || t === 'ambitious')) add('kingdom', 0.3);
      if (era >= 2 && fin(civ.flags.conquests) >= 3) add('empire', 0.4);
      break;
    }
    case 'empire':
      if (hasTech(civ, 'feudalism') && civ.stability < 0.55) add('feudal', 0.6);
      if (hasTech(civ, 'printing')) add('constitutional', 0.35 + tol * 0.4);
      break;
    case 'feudal':
      if (hasTech(civ, 'printing')) add('constitutional', 0.6);
      if (n >= 14 && civ.stability > 0.6) add('empire', 0.4);
      break;
    case 'republic':
      if (era >= 6) add('democracy', 0.9);
      if (comm > 0.65 && agg.coastShare > 0.4) add('merchant', 0.3);
      if (n >= 14 && fin(civ.flags.conquests) >= 3) add('empire', 0.4);
      break;
    case 'merchant':
      if (era >= 6) add('democracy', 0.7);
      if (n > 12) add('republic', 0.5);
      break;
    case 'constitutional':
      if (era >= 6 && tol > 0.45) add('democracy', 0.5);
      break;
    case 'democracy':
      break;
    case 'dictatorship':
      if (civ.stability > 0.65 && yrs > 30) {
        add(era >= 6 ? 'democracy' : 'republic', 0.6);
        if (n >= 12) add('empire', 0.3);
      }
      break;
    default:
      add('chiefdom', 1);
  }
  if (!options.length) return false;
  const p = Math.min(0.12, 0.03 + 0.002 * (yrs - 25)) * (civ.stability > 0.4 ? 1 : 0.4);
  if (!world.rng.chance(p)) return false;
  let tot = 0;
  for (const [, w] of options) tot += w;
  let r = world.rng.next() * tot;
  let pickKey = options[0][0];
  for (const [k, w] of options) { r -= w; if (r <= 0) { pickKey = k; break; } }
  adoptGovernment(world, civ, pickKey, { cause: 'reform' });
  return true;
}

/**
 * A revolution when the state is failing: the government is overthrown in favour of an
 * era-appropriate alternative. Returns the new government key (caller handles rulers).
 */
export function revolutionTarget(world, civ) {
  const era = fin(civ.tech?.era, 0);
  const tr = civ.traits || {};
  const g = civ.government;
  const opts = [];
  const add = (k, w) => { if (k !== g && era >= GOVERNMENTS[k].minEra && w > 0) opts.push([k, w]); };
  const holy = civ.stateReligion != null;
  const n = civ.settlementIds?.length || 0;
  if (era >= 6) { add('democracy', 1 + fin(tr.tolerance)); add('dictatorship', 0.6 + fin(tr.militarism)); add('constitutional', 0.3); }
  else if (era >= 3) {
    add('republic', 0.6 + fin(tr.tolerance)); add('dictatorship', 0.4 + fin(tr.militarism) * 0.8); add('kingdom', 0.5);
    if (holy) add('theocracy', 0.4 * fin(tr.religiosity));
    if (era >= 5) add('constitutional', 0.4 + 0.4 * fin(tr.tolerance));
  } else if (era >= 1) {
    add('kingdom', 1);
    add('theocracy', fin(tr.religiosity) * (holy ? 0.8 : 0.25));
    add('chiefdom', 0.35);                       // central authority breaks down
    if (n >= 10) add('empire', 0.5 * (0.5 + fin(tr.militarism)));
  } else { add('chiefdom', 1); add('tribe', 0.3); }
  if (!opts.length) return null;
  // a revolution rarely restores the order the last one overthrew
  const back = civ.flags?.prevGov;
  for (const o of opts) if (o[0] === back) o[1] *= 0.25;
  let tot = 0;
  for (const [, w] of opts) tot += w;
  let r = world.rng.next() * tot;
  for (const [k, w] of opts) { r -= w; if (r <= 0) return k; }
  return opts[0][0];
}

export function canReformNow(world, civ) {
  return rateOk(world, `gov:${civ.id}`, 20);
}

export { getMods };
