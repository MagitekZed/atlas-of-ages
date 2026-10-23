// Bands · hunts and heroes: how realms answer the bands that prey on them.
//   hunt   a realm struck within the last three years that is at least 1.5× the band's power
//          raises a hunt — an army with flags.hunt = bandId and no war (createArmy). This
//          module moves it (its own route in flags.hp; army.path stays null and flags.nextPlan
//          far away, so war code never plans or marches it), fights the band when it closes
//          (combat.js clash), and brings it home and disbands it (the armyDisbanded hook, then
//          removeArmy), returning the surviving levies to their town.
//   hero   against beasts, a lone champion may try where no army can: the odds (heroOdds, pure)
//          favour small, wounded and sleeping beasts and the arcane arts; success makes a
//          hero figure with an epithet, failure feeds the beast's legend.
//   slay   the common end of a slain beast (dragons register their own, richer ending).

import { createArmy, removeArmy, getBand, nearestSettlement, addFigure } from '../../core/entities.js';
import { emit } from '../../core/hooks.js';
import { emitFx } from '../../core/world.js';
import { DAYS_PER_YEAR, WATER } from '../../core/constants.js';
import { clamp, clamp01 } from '../../core/util.js';
import { makePerson } from '../../core/names.js';
import { mythOn } from '../../core/params.js';
import { state, bandPower, civPowerOf, manpowerOf, isBeast, isPeople, kindDef, endBand, engineHooks, ready, isReady } from './engine.js';
import { links, tileOf, modeOf, walkGrid, planHome } from './move.js';
import { findCamp } from './kinds/outlaws.js';
import { clash } from './combat.js';
import { heroName, slayerTitle } from './names.js';
import { say, pick, cap, civName, CivName, count, when, placePhrase, bandName, BandName, ordinal, isTold } from './prose.js';

export const MAX_HUNTS = 6;
const HUNT_DAYS = 540;
const FAR = 1e15;               // flags.nextPlan: war code never plans a hunt

/** The hunts in the field (sys.bands.hunts keeps their army ids, so idle days cost nothing). */
export function huntArmies(world) {
  const ids = world.sys.bands?.hunts;
  if (!ids || !ids.length) return [];
  const out = [];
  for (const a of world.armies) if (a.flags && a.flags.hunt != null && ids.includes(a.id)) out.push(a);
  if (out.length !== ids.length) world.sys.bands.hunts = out.map((a) => a.id);
  return out;
}
const armyNear = (army, band, r) => (army.x - band.x) ** 2 + (army.y - band.y) ** 2 <= r * r;

// ---------------------------------------------------------------------------
// Raising hunts

function huntName(world, civ, home, band) {
  const era = civ.tech?.era || 0;
  const T = home.name;
  switch (band.kind) {
    case 'dragon': return pick(world, [`the Wyrm-hunt of ${T}`, `the Dragon-hunters of ${T}`, `the Host of the ${civ.adjective} Spears`]);
    case 'pirates': return pick(world, [`the ${T} Squadron`, `the Sea-Watch of ${T}`, `the ${civ.adjective} Coast Fleet`]);
    case 'horde': return pick(world, [`the Host of ${T}`, `the ${civ.adjective} Levy`, `the Army of ${T}`]);
    case 'undead': return pick(world, [`the Lantern-bearers of ${T}`, `the Host of the Living`, `the Gravewardens of ${T}`]);
    default:
      if (isBeast(band)) return pick(world, [`the Hunt of ${T}`, `the ${T} ${cap(band.kind)}-hunters`, `the Beast-hunters of ${T}`]);
      return era >= 4 ? pick(world, [`the Wardens of ${T}`, `the ${T} Constabulary`, `the Riders of ${T}`]) : pick(world, [`the ${T} Levy`, `the Riders of ${T}`, `the Hue and Cry of ${T}`]);
  }
}

/** Raise a hunt of civ against band. Returns the army or null. */
export function raiseHunt(world, civ, band) {
  const rng = world.rng;
  const st = state(world);
  const bp = bandPower(band);
  const mp = manpowerOf(civ);
  const str = Math.round(clamp(1.6 * bp, 20, 0.6 * mp));
  if (str < 1.15 * bp || str < 20) return null;
  const home = nearestSettlement(world, band.x, band.y, { civId: civ.id });
  if (!home) return null;
  const nav = civ.mods?.navigation || 0;
  if (modeOf(band) === 'sea' && nav < 1) return null;
  // levies leave the towns, as for war (they come home when the hunt does)
  let drawn = 0;
  const pop = Math.max(1, civ.population || 0);
  for (const id of civ.settlementIds) {
    const s = world.settlements[id];
    if (!s || !s.alive) continue;
    const take = Math.min(s.population * 0.15, str * 0.6 * s.population / pop);
    s.population -= take; drawn += take;
  }
  civ.treasury = Math.max(0, (civ.treasury || 0) - str * 0.2);
  const general = makePerson(civ.language || world.lang, rng);
  const skill = Math.round(rng.float(0.9, 1.25) * 100) / 100;
  const army = createArmy(world, { civId: civ.id, x: home.x, y: home.y, homeId: home.id, strength: str, warId: null, general: { name: general, skill, born: world.time.day - 40 * DAYS_PER_YEAR, wins: 0, battles: 0, honours: 0 }, state: 'hunting' });
  Object.assign(army.flags, { hunt: band.id, mp: 0, skill, bad: [], nextPlan: FAR, startStr: str, drawn, hp: null, hs: 0, hday: world.time.day, hpd: -1, hret: 0 });
  army.name = huntName(world, civ, home, band);
  (st.hunts ||= []).push(army.id);
  st.stats.hunts++;
  // the first hunt raised against a horde is major news (later ones notable); the first against
  // a dragon or an elder beast notable; against a free company, or outlaws the chronicle had told
  // of twice, the first is notable; every other hunt is routine
  band.data.hunted = (band.data.hunted || 0) + 1;
  const firstHunt = band.data.hunted === 1;
  const elder = band.kind === 'dragon' || Boolean(band.data.elder);
  let imp = 1;
  if (band.kind === 'horde') imp = firstHunt ? 3 : 2;
  else if (isBeast(band)) imp = firstHunt && elder ? (band.kind === 'dragon' && band.data.elder ? 3 : 2) : 1;
  else if (firstHunt && (band.kind === 'company' || (band.data.told || 0) >= 2)) imp = 2;
  const minor = imp < 2;
  const hunt = say(world, band, {
    cat: isBeast(band) ? 'myth' : band.kind === 'horde' ? 'war' : 'civ', imp, fold: minor, key: 'band.hunt', civId: civ.id, x: home.x, y: home.y, sid: home.id,
    cause: Number.isFinite(band.data.rseq) ? band.data.rseq : null,
    text: isBeast(band)
      ? pick(world, [
        `${CivName(civ)} would suffer ${bandName(band)} no longer: ${army.name}, ${count(str)} strong, marched out of ${home.name} under ${general}.`,
        `${when(world, home.y)}, ${general} led ${count(str)} spearmen out of ${home.name} to hunt ${bandName(band)}.`,
      ])
      : pick(world, [
        `${CivName(civ)} sent ${army.name} after ${bandName(band)}: ${count(str)} men under ${general}.`,
        `${cap(general)} rode out of ${home.name} with ${count(str)} men to put an end to ${bandName(band)}.`,
        `The roads around ${home.name} were raised against ${bandName(band)}, and ${army.name} took the field.`,
      ]),
  });
  if (hunt) army.flags.hseq = hunt.seq;
  return army;
}

/** Monthly: realms struck lately raise hunts, or a hero sets out against a beast. */
export function huntsMonthly(world) {
  const st = state(world);
  const rng = world.rng;
  const day = world.time.day;
  const myth = mythOn(world);
  let live = huntArmies(world);
  for (const key of Object.keys(st.raided)) {
    const r = st.raided[key];
    if (day - r.day > 3 * DAYS_PER_YEAR) continue;
    const civ = world.civs[key];
    const band = getBand(world, r.bandId);
    if (!civ || !civ.alive || !band || band.civId === civ.id) continue;
    if (band.state === 'hired' || band.state === 'tamed' || band.kind === 'kraken') continue;
    if (isBeast(band) && !myth) continue;
    if (live.some((a) => a.flags.hunt === band.id && (a.civId === civ.id || isPeople(band)))) continue;
    if (!isReady(world, `hu${band.id}`, (isPeople(band) && band.kind !== 'horde' ? 2 : 1) * DAYS_PER_YEAR)) continue;
    const strong = civPowerOf(world, civ) >= 1.5 * bandPower(band);
    // outlaws must make a nuisance of themselves first; hosts, beasts and the dead at once
    const petty = isPeople(band) && band.kind !== 'horde' && band.kind !== 'company';
    const vexed = !petty || ((r.n >= 2 || (band.raids || 0) >= 3) && day - band.createdDay >= DAYS_PER_YEAR);
    if (strong && vexed && live.length < MAX_HUNTS && rng.chance(petty ? 0.12 : 0.25)) {
      const a = raiseHunt(world, civ, band);
      if (a) { ready(world, `hu${band.id}`, 0); live = huntArmies(world); continue; }
    }
    // a champion now and then, never more than one against a beast in three years
    if (isBeast(band) && rng.chance(band.kind === 'dragon' ? 0.025 : 0.015) && ready(world, `he${band.id}`, 3 * DAYS_PER_YEAR)) heroAttempt(world, civ, band);
  }
}

// ---------------------------------------------------------------------------
// Marching and fighting

function passable(world, i, sea) { return sea || world.f.water[i] === WATER.LAND; }

function planArmy(world, army, to) {
  const W = world.W;
  const civ = world.civs[army.civId];
  const from = tileOf(world, army.x, army.y);
  army.flags.hpd = world.time.day;
  army.flags.hs = 0;
  if (from === to) { army.flags.hp = [to]; return true; }
  const nav = civ?.mods?.navigation || 0;
  let p = null;
  if (links.path && typeof links.path.findPath === 'function') {
    const sameLand = world.f.water[from] === WATER.LAND && world.f.water[to] === WATER.LAND && world.f.landmass[from] === world.f.landmass[to];
    const d = Math.hypot((from % W) - (to % W), ((from / W) | 0) - ((to / W) | 0));
    try {
      if (sameLand) p = links.path.findPath(world, from, to, { mode: 'land', navigation: nav, maxNodes: Math.round(800 + d * 140) });
      if (!p && nav >= 1) p = links.path.findPath(world, from, to, { mode: 'amphibious', navigation: nav, maxNodes: 6000 });
    } catch (e) { p = null; }
  }
  if (!p) {
    // straight march as a last resort, if the ground allows it
    const line = [from];
    const x0 = from % W, y0 = (from / W) | 0, x1 = to % W, y1 = (to / W) | 0;
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let k = 1; k <= n; k++) {
      const i = Math.round(y0 + (y1 - y0) * k / n) * W + Math.round(x0 + (x1 - x0) * k / n);
      if (!passable(world, i, nav >= 1)) { army.flags.hp = null; return false; }
      line.push(i);
    }
    p = line;
  }
  army.flags.hp = p.slice();
  return true;
}

function stepArmy(world, army, grid) {
  const W = world.W, f = world.f;
  const p = army.flags.hp;
  if (!p || p.length < 2) return true;
  const civ = world.civs[army.civId];
  const last = p.length - 1;
  let step = army.flags.hs | 0;
  if (step >= last) return true;
  const atSea = f.water[p[step]] !== WATER.LAND;
  const speed = 1.1 * (civ?.mods?.movement || 1) * (atSea ? 2.2 : 1);
  let mp = (Number.isFinite(army.flags.mp) ? army.flags.mp : 0) + speed;
  let cost = 1;
  while (step < last) {
    const nx = p[step + 1];
    cost = f.water[nx] !== WATER.LAND ? 1 : grid && grid.land && grid.land[nx] > 0 ? grid.land[nx] : 1.5;
    if (mp < cost) break;
    mp -= cost;
    step++;
  }
  army.flags.mp = Math.min(mp, Math.max(4, cost));
  army.flags.hs = step;
  const i0 = p[step];
  let x = i0 % W, y = (i0 / W) | 0;
  if (step < last) { const t = clamp01(mp / cost), i1 = p[step + 1]; x += ((i1 % W) - x) * t; y += (((i1 / W) | 0) - y) * t; }
  army.x = x; army.y = y;
  army.naval = f.water[i0] !== WATER.LAND;
  return step >= last;
}

/** Stand a hunt down at home: the surviving levies go back to their town. */
export function disbandHunt(world, army, reason = 'hunt') {
  const home = world.settlements[army.homeId];
  if (home && home.alive && home.civId === army.civId && army.strength > 0) {
    const start = army.flags.startStr > 0 ? army.flags.startStr : army.strength;
    home.population += Math.max(0, (army.flags.drawn || 0) * clamp01(army.strength / start));
  }
  emit(world, 'armyDisbanded', army, reason);
  removeArmy(world, army.id);
}

/** Daily: every hunt marches, closes and fights, or comes home. */
export function huntsDaily(world) {
  const ids = world.sys.bands?.hunts;
  if (!ids || !ids.length) return;
  const day = world.time.day;
  let grid = null;
  for (const army of huntArmies(world)) {
    const fl = army.flags;
    if (!world.armies.includes(army)) continue;
    if (!world.civs[army.civId]?.alive) { removeArmy(world, army.id); continue; }
    if (!(army.strength >= 8)) { disbandHunt(world, army, 'destroyed'); continue; }
    grid ||= walkGrid(world);
    const band = getBand(world, fl.hunt);
    const home = world.settlements[army.homeId];
    const goHome = () => {
      fl.hret = 1;
      if (!home || !home.alive || !planArmy(world, army, home.i)) disbandHunt(world, army, 'hunt');
    };
    if (fl.hret) {
      if (!fl.hp || stepArmy(world, army, grid)) disbandHunt(world, army, 'hunt');
      continue;
    }
    if (!band || band.civId === army.civId || band.state === 'hired' || band.state === 'tamed' || day - fl.hday > HUNT_DAYS) { goHome(); continue; }
    // flyers abroad are met at their lair; everything else is followed where it is
    const flyerAway = modeOf(band) === 'fly' && band.state !== 'lair' && band.state !== 'sleep';
    const to = flyerAway ? band.homeI : tileOf(world, band.x, band.y);
    const end = fl.hp && fl.hp.length ? fl.hp[fl.hp.length - 1] : -1;
    const W = world.W;
    const drift = end < 0 ? Infinity : Math.hypot((end % W) - (to % W), ((end / W) | 0) - ((to / W) | 0));
    // re-plan when the quarry has moved on (and after a failed plan, not before twelve days)
    if ((!fl.hp || drift > 3) && day - (fl.hpd ?? -1e9) >= 12) {
      if (!planArmy(world, army, to) && day - fl.hday > 60) { goHome(); continue; }
    }
    stepArmy(world, army, grid);
    const petty = isPeople(band) && band.kind !== 'horde' && band.kind !== 'company';
    // outlaws who see the hunt coming may melt into the woods: the trail goes cold
    if (fl.lost != null) {
      if (day - fl.lost > 20) {
        if (ready(world, `hl${army.civId}`, 6 * DAYS_PER_YEAR)) {
          say(world, band, { cat: 'civ', imp: 1, fold: true, key: 'band.hunt.lost', civId: army.civId, text: pick(world, [`${cap(army.name)} searched ${placePhrase(world, band.x, band.y).replace(/^in /, '').replace(/^by /, 'the shores of ') || 'the wild country'} for ${bandName(band)} but found only cold campfires.`, `${BandName(band)} slipped away from ${army.name}, who went home empty-handed.`]) });
        }
        goHome();
      }
      continue;
    }
    if (petty && !fl.ev && armyNear(army, band, 3)) {
      fl.ev = 1;
      const i = tileOf(world, band.x, band.y), f = world.f;
      const cover = f.veg[i] > 0.55 || f.elevation[i] >= 0.62 ? 0.2 : 0;
      if (world.rng.chance(0.45 + cover - (army.strength > 3 * bandPower(band) ? 0.1 : 0))) {
        const camp = findCamp(world, band.x, band.y, 6, 12, 8);
        if (camp >= 0) { band.homeI = camp; band.state = 'return'; band.targetSid = -1; planHome(world, band); }
        fl.lost = day;
        continue;
      }
    }
    if (!flyerAway && armyNear(army, band, 1.6)) {
      const r = clash(world, army, band, { hunt: true });
      if (r.bandGone || !getBand(world, band.id)) { goHome(); continue; }
      // a posse fights once; hunts of beasts and hosts keep after a beaten quarry
      if (petty || (!r.armyWon && army.strength < 0.45 * (fl.startStr || army.strength))) { goHome(); continue; }
      if (army.strength < 8) { disbandHunt(world, army, 'destroyed'); continue; }
    }
  }
}

// ---------------------------------------------------------------------------
// Heroes and slaying

/** By-names for a beast that has killed three champions (picked by band id: no draw). */
const HEROBANE = ['Herobane', 'Knightsbane', 'Champion-Bane', 'Hero-Eater', 'Spear-Breaker', 'Widow-Maker', 'Shieldbiter'];

/** A hero's chance against a beast (pure): small, wounded and sleeping beasts fall more easily. */
export function heroOdds(world, civ, band) {
  if (!band || !isBeast(band)) return 0;
  const arcana = Number.isFinite(civ?.mods?.arcana) ? civ.mods.arcana : 0;
  const small = (band.power || 0) < 150 ? 0.2 : 0;
  const dragon = band.kind === 'dragon' ? 0.08 + (band.data?.elder ? 0.05 : 0) : 0;
  const wounded = 0.25 * (1 - clamp01(band.hp ?? 1));
  const asleep = band.state === 'sleep' ? 0.1 : 0;
  const big = (band.power || 0) >= 400 && band.kind !== 'dragon' ? 0.05 : 0;
  return clamp(0.15 + 0.1 * arcana + small - dragon - big + wounded + asleep, 0.03, 0.75);
}

/**
 * A champion of civ goes alone against a beast. opts: { divine, name, p (odds override) }. Returns
 * { ok, slain, hero }. Failure kills the hero and feeds the beast's legend.
 */
export function heroAttempt(world, civ, band, opts = {}) {
  const st = state(world);
  const p = Number.isFinite(opts.p) ? opts.p : heroOdds(world, civ, band);
  const name = opts.name || heroName(world, civ);
  st.stats.heroes++;
  if (world.rng.chance(p)) {
    slay(world, band, civ, { how: opts.divine ? 'divine' : 'hero', name });
    return { ok: true, slain: true, hero: name, p };
  }
  band.data.heroes = (band.data.heroes || 0) + 1;
  if (band.data.heroes >= 3 && !band.epithet && band.kind !== 'dragon') band.epithet = HEROBANE[band.id % HEROBANE.length];
  const where = placePhrase(world, band.homeI % world.W, (band.homeI / world.W) | 0);
  // a champion lost to a dragon is told (once in five years); lesser beasts' victims are folded
  // (integration: a champion's fall is folded too; Elders and first challenges excepted)
  const told = band.kind === 'dragon' && (!band.data.heroFell || (band.data.elder && ready(world, `hf${band.id}`, 25 * DAYS_PER_YEAR)));
  band.data.heroFell = (band.data.heroFell || 0) + 1;
  say(world, band, {
    cat: 'myth', imp: told ? 2 : 1, fold: !told, key: 'hero.fall', civId: civ ? civ.id : null,
    // the champion went out because of what the beast had done (its last told raid)
    cause: Number.isFinite(band.data.rseq) ? band.data.rseq : null,
    text: pick(world, [
      `The hero ${name} of ${civName(civ)} went up alone against ${bandName(band)}${where ? ' ' + where : ''} and did not come back.`,
      `${cap(name)} swore to rid ${civName(civ)} of ${bandName(band)}; only the shield was ever found.`,
      `${when(world, band.y)}, ${name} challenged ${bandName(band)} and was slain${band.data.heroes > 1 ? `, the ${ordinal(band.data.heroes)} champion to die so` : ''}.`,
    ]),
  });
  return { ok: true, slain: false, hero: name, p };
}

/**
 * A beast is slain by civ. by: { how: 'army'|'hero'|'divine', name?, army?, cause? }. Kinds with
 * their own ending (dragons) take over; otherwise the slayer becomes a hero figure.
 */
export function slay(world, band, civ, by = {}) {
  const def = kindDef(band.kind);
  if (def && def.slain && !by.generic) { def.slain(world, band, civ, by); return; }
  const st = state(world);
  const town = civ ? nearestSettlement(world, band.x, band.y, { civId: civ.id }) : null;
  const name = by.name || (civ ? heroName(world, civ) : null);
  let fig = by.figure || null;
  if (fig) { fig.epithet ||= slayerTitle(band, world); (fig.deeds ||= []).push(`slew ${bandName(band)}`); }
  else if (civ && name && isBeast(band)) {
    fig = addFigure(world, {
      name, kind: 'hero', title: 'hero', epithet: slayerTitle(band, world), civId: civ.id, sid: town ? town.id : null,
      born: world.time.day - world.rng.int(22, 40) * DAYS_PER_YEAR, deeds: [`slew ${bandName(band)}`],
    });
  }
  if (civ) civ.prestige = (civ.prestige || 0) + (band.kind === 'dragon' ? 10 : 2);
  band.data.slayer = { name, civId: civ ? civ.id : -1, day: world.time.day, figureId: fig ? fig.id : null };
  st.stats.slain++;
  emitFx(world, { type: 'slay', x: band.x, y: band.y, r: 2, intensity: 0.9 });
  // the end of a beast is news when the chronicle had told of it, or it was a great one
  const great = (band.power || 0) >= (band.kind === 'undead' ? 2000 : 600);
  const imp = great ? 3 : isTold(band) || (band.power || 0) >= 400 || by.how === 'divine' ? 2 : 1;
  say(world, band, {
    cat: 'myth', imp, fold: imp < 2, key: 'beast.slain', civId: civ ? civ.id : null, sid: town ? town.id : null,
    cause: by.cause ?? (Number.isFinite(band.data.rseq) ? band.data.rseq : null),
    text: by.how === 'army'
      ? pick(world, [`${cap(by.army?.name || 'the hunters of ' + civName(civ))} slew ${bandName(band)}${name ? `; it was ${name} who struck the last blow, and was called ${slayerTitle(band, world)} ever after` : ''}.`,
        `${BandName(band)} died on the spears of ${civName(civ)}${placePhrase(world, band.x, band.y) ? ' ' + placePhrase(world, band.x, band.y) : ''}.`])
      : pick(world, [`${cap(name)} of ${civName(civ)} slew ${bandName(band)}, and was called ${slayerTitle(band, world)} ever after.`,
        `${when(world, band.y)}, the hero ${name} killed ${bandName(band)}${town ? ` and brought its head to ${town.name}` : ''}.`,
        `${cap(bandName(band))} is dead: ${name} of ${civName(civ)} sought it out alone and came back ${slayerTitle(band, world)}.`]),
  });
  endBand(world, band, 'slain');
}

engineHooks.slay = slay;

/**
 * A hero figure's deed against a real beast (for culture.js heroes that got a heroTarget):
 * rolls the hero's odds (+0.1, these are the age's champions). Slain: the beast dies and the
 * figure gains its epithet and deed. Otherwise the beast lives and the hero fought it off.
 * Returns { slain, deed } (a past-tense phrase for the hero's deeds), or null without a beast.
 */
export function heroDeed(world, civ, bandId, fig = null) {
  const band = getBand(world, bandId);
  if (!band || !isBeast(band) || !civ) return null;
  const p = Math.min(0.85, heroOdds(world, civ, band) + 0.1);
  if (world.rng.chance(p)) {
    const name = bandName(band);
    slay(world, band, civ, { how: 'hero', name: fig?.name || null, figure: fig });
    return { slain: true, deed: `slew ${name}` };
  }
  band.hp = Math.max(0.1, (band.hp ?? 1) - 0.25);
  return { slain: false, deed: `drove ${bandName(band)} back into the wild` };
}
