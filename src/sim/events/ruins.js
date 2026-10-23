// Ruins and resettlement. When a town is destroyed, WP6's recorder leaves a 'ruin' site
// (core/sites.js; data { peak, maxTier, buildings, civId, originCivId, wonderIds, cause,
// fellDay, sid }). Here later peoples come back to it:
//   siteBonus  provider: settlers favour old foundations (+0.15 within a tile and a half,
//              +0.2 for the kin of its founders)
//   settleName provider: kin take the old name, strangers call it 'New X'
//   resettle   on settlementCreated: the ruin is marked resettled and the chronicle tells it
//   decks      looting (era ≥ 1) and excavation by library towns (era ≥ 4: culture, lost lore)
// This module only ever writes ruin data through updateSite (resettledBy, resettledDay,
// looted, excavated, lostTech). Providers are pure; the grid index lives in world.cache.

import { registerProvider } from '../../core/ext.js';
import { registerEvent } from '../../core/events.js';
import { updateSite } from '../../core/sites.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { record, effect, heat, T, canLearn, grantTechTo, techDef, recordFree } from './engine.js';
import { SUBJ } from './heat.js';
import { pick, say, civName, peopleOf, yearsWord } from './prose.js';

const CELL = 8;

/** Ruin sites with a coarse grid, rebuilt whenever the sites change. */
function ruinIndex(world) {
  const v = world.versions.sites || 0, n = world.sites.length;
  const c = world.cache.evRuins;
  if (c && c.v === v && c.n === n) return c;
  const bw = Math.ceil(world.W / CELL), bh = Math.ceil(world.H / CELL);
  const cells = new Map();
  const list = [];
  for (const site of world.sites) {
    if (site.kind !== 'ruin') continue;
    list.push(site);
    const k = Math.min(bh - 1, Math.max(0, (site.y / CELL) | 0)) * bw + Math.min(bw - 1, Math.max(0, (site.x / CELL) | 0));
    let a = cells.get(k);
    if (!a) cells.set(k, (a = []));
    a.push(site);
  }
  return (world.cache.evRuins = { v, n, bw, bh, cells, list });
}

const fellDay = (site) => (Number.isFinite(site.data?.fellDay) ? site.data.fellDay : site.firstDay);
const resettled = (site) => site.data && site.data.resettledBy != null;
/** The name the fallen town bore. */
export function ruinName(world, site) {
  const sid = site.data?.sid;
  const s = sid != null ? world.settlements[sid] : null;
  if (s && s.name) return s.name;
  return site.name ? String(site.name).replace(/^(the\s+)?ruins\s+of\s+/i, '') : null;
}

// What a search wants of a ruin (a mode, not a closure, so weight() never allocates).
const OPEN = 0, SETTLE = 1, LOOT = 2, DIG = 3;
const looted = (site) => site.data && site.data.looted != null;
const excavated = (site) => site.data && site.data.excavated != null;
const bigRuin = (site) => (site.data?.maxTier ?? 0) >= 2 || (site.data?.peak ?? 0) >= 600;
function fits(site, mode, day) {
  const age = day - fellDay(site);
  switch (mode) {
    case OPEN: return !resettled(site);
    case SETTLE: return !resettled(site) && age >= 10 * DAYS_PER_YEAR;
    case LOOT: return !looted(site) && !resettled(site) && bigRuin(site) && age >= 20 * DAYS_PER_YEAR;
    case DIG: return !excavated(site) && bigRuin(site) && age >= 150 * DAYS_PER_YEAR;
    default: return true;
  }
}

/** Nearest ruin within r of (x, y) that suits mode, or null. Allocation-free. */
export function nearRuin(world, x, y, r, mode = OPEN) {
  const g = ruinIndex(world);
  if (!g.list.length) return null;
  const day = world.time.day;
  const x0 = Math.max(0, ((x - r) / CELL) | 0), x1 = Math.min(g.bw - 1, ((x + r) / CELL) | 0);
  const y0 = Math.max(0, ((y - r) / CELL) | 0), y1 = Math.min(g.bh - 1, ((y + r) / CELL) | 0);
  let best = null, bd = r * r;
  for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) {
    const a = g.cells.get(by * g.bw + bx);
    if (!a) continue;
    for (const site of a) {
      const d = (site.x - x) ** 2 + (site.y - y) ** 2;
      if (d <= bd && fits(site, mode, day)) { bd = d; best = site; }
    }
  }
  return best;
}

function kinOf(world, civ, site) {
  if (!civ || !site.data) return false;
  const ids = [site.data.civId, site.data.originCivId];
  let c = civ, guard = 0;
  while (c && guard++ < 30) {
    if (ids.includes(c.id)) return true;
    c = c.parentId != null ? world.civs[c.parentId] : null;
  }
  return false;
}

function takenNames(world) {
  const v = world.versions.settlements || 0, n = world.settlements.length;
  const c = world.cache.evNames;
  if (c && c.v === v && c.n === n) return c.set;
  const set = new Set();
  for (const s of world.settlements) if (s && s.name) set.add(s.name);
  world.cache.evNames = { v, n, set };
  return set;
}

// --- providers (pure) --------------------------------------------------------

registerProvider('siteBonus', 'events.ruins', (world, civ, i) => {
  if (!world.sites || !world.sites.length) return 0;
  const x = i % world.W, y = (i / world.W) | 0;
  const site = nearRuin(world, x, y, 1.5, SETTLE);
  if (!site) return 0;
  return kinOf(world, civ, site) ? 0.2 : 0.15;
});

registerProvider('settleName', 'events.ruins', (world, civ, i) => {
  if (!world.sites || !world.sites.length) return null;
  const x = i % world.W, y = (i / world.W) | 0;
  const site = nearRuin(world, x, y, 1.5, SETTLE);
  if (!site) return null;
  const old = ruinName(world, site);
  if (!old) return null;
  if (kinOf(world, civ, site)) return old;
  const nu = /^New /.test(old) ? null : `New ${old}`;
  return nu && !takenNames(world).has(nu) ? nu : null;
});

// --- resettlement (settlementCreated) ----------------------------------------

const CAUSE_PHRASE = {
  razed: ['razed in war', 'put to the torch by its conquerors', 'sacked and burned'],
  sea: ['swallowed by the sea', 'drowned by the rising waters'],
  lava: ['buried by the fire mountain', 'overwhelmed by lava'],
  meteor: ['struck down by a falling star'],
  abandoned: ['abandoned', 'left to the weeds', 'emptied by hard times'],
  dwindled: ['emptied as its people drifted away', 'abandoned'],
  famine: ['emptied by famine'],
  plague: ['emptied by plague'],
  fire: ['burned to the ground'],
  flood: ['washed away by the river'],
  quake: ['thrown down by an earthquake'],
};
function causePhrase(world, cause) {
  const pool = CAUSE_PHRASE[cause] || CAUSE_PHRASE.abandoned;
  return pick(world, pool);
}

/** A new settlement on old foundations: mark the ruin and tell it. Returns the ruin or null. */
export function resettle(world, s) {
  if (!world.sites || !world.sites.length) return null;
  const site = nearRuin(world, s.x, s.y, 1.5, OPEN);
  if (!site) return null;
  const civ = world.civs[s.civId];
  const old = ruinName(world, site);
  const years = Math.max(1, Math.round((world.time.day - fellDay(site)) / DAYS_PER_YEAR));
  const kin = kinOf(world, civ, site);
  updateSite(world, site.id, { resettledBy: s.id, resettledDay: world.time.day });
  if (!old || !civ) return { site, old, kin, years };
  const was = causePhrase(world, site.data?.cause);
  const text = kin
    ? say(world, [
      '{people} came back to {old}, {was} {span} before, and raised {name} on the bones of their ancestors’ town.',
      'Descendants of its founders returned to the ruins of {old}, {was} {span} earlier; the town rose again as {name}.',
    ], { people: peopleOf(civ), old, was, span: yearsWord(years), name: s.name })
    : say(world, [
      'Settlers of {civ} raised {name} among the tumbled stones of {old}, a town {was} {span} before.',
      '{name} was founded on the ruins of {old}, {was} {span} earlier; its new people dug its old wells clear.',
      'Where {old} had stood before it was {was}, {people} built {name}.',
    ], { civ: civName(civ), people: peopleOf(civ), old, was, span: yearsWord(years), name: s.name });
  recordFree(world, 'ruins', 'resettled', { text, imp: (site.data?.maxTier ?? 0) >= 3 || years >= 150 ? 2 : 1, s, ref: { k: 'settlement', id: s.id } });
  return { site, old, kin, years };
}

// --- decks -------------------------------------------------------------------

registerEvent({
  id: 'town.looting', scale: 'town', minTier: 1, family: 'ruins', cat: 'trade', imp: 2, minEra: 1, cooldownYears: 25,
  label: 'Ruin looted', icon: 'trade',
  hint: ['trade +12% for 8 years', 'bandits gather in the region'],
  weight(ctx) {
    const s = ctx.s;
    if (s.tier < 1 || !ctx.world.sites.length) return 0;
    const site = nearRuin(ctx.world, s.x, s.y, 6, LOOT);
    return site ? 0.004 * (1 + ctx.heatLand('bandits')) : 0;
  },
  fire(ctx) {
    const { world, s } = ctx;
    const site = nearRuin(world, s.x, s.y, 6, LOOT);
    if (!site) return false;
    const old = ruinName(world, site) || 'a fallen town';
    const what = pick(world, ['bronze bowls and grave-gold', 'carved stones for their own walls', 'the copper roofs of its temples', 'treasure from its sealed vaults', 'the gilded idols of its old gods']);
    record(ctx, {
      text: say(world, [
        'Treasure-seekers from {town} picked over the ruins of {old}, carrying off {what}.',
        'The ruins of {old} gave up {what} to diggers from {town}, and the town grew rich on its neighbours’ dead.',
        'Men of {town} broke open the old tombs of {old} and came home with {what}.',
      ], { town: s.name, old, what }),
      imp: bigRuin(site) && (site.data?.maxTier ?? 0) >= 3 ? 2 : 1,
    });
    updateSite(world, site.id, { looted: world.time.day, lootedBy: s.id });
    effect(ctx, T.s(s), 'looting', { trade: 1.12 }, 8, 'Ruin gold');
    const lm = world.f.landmass[s.i];
    if (lm >= 0) heat(ctx, 'bandits', 0.4, SUBJ.land(lm));
    return true;
  },
});

registerEvent({
  id: 'town.excavation', scale: 'town', minTier: 3, family: 'learning', cat: 'tech', imp: 2, minEra: 4, cooldownYears: 40,
  label: 'Excavation', icon: 'scroll',
  hint: ['culture +15% for 15 years', 'may recover lost knowledge'],
  weight(ctx) {
    const s = ctx.s, b = s.buildings;
    if (s.tier < 3 || !b || !((+b.library || 0) + (+b.university || 0)) || !ctx.world.sites.length) return 0;
    const site = nearRuin(ctx.world, s.x, s.y, 10, DIG);
    return site ? 0.012 * (1 + ctx.heatCiv('learning')) : 0;
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const site = nearRuin(world, s.x, s.y, 10, DIG);
    if (!site || !civ) return false;
    const old = ruinName(world, site) || 'a forgotten city';
    const fallen = site.data?.civId != null ? world.civs[site.data.civId] : null;
    let lost = null;
    if (fallen && fallen.tech && fallen.tech.known && world.rng.chance(0.4)) {
      const cands = Object.keys(fallen.tech.known).filter((id) => canLearn(civ, id)).sort();
      if (cands.length) lost = world.rng.pick(cands);
    }
    const scholar = pick(world, ['scholars', 'antiquarians', 'the masters of its library', 'a band of students']);
    const span = yearsWord(Math.round((world.time.day - fellDay(site)) / DAYS_PER_YEAR));
    let text;
    const t = lost ? techDef(lost) : null;
    if (t && grantTechTo(world, civ, lost)) {
      text = say(world, [
        '{who} of {town} dug into the ruins of {old}, dead for {span}, and found tablets that taught {people} the lost art of {tech}.',
        'In the buried archive of {old} the {who2} of {town} rediscovered {tech}, known to {fallen} before their fall.',
      ], { who: scholar.replace(/^./, (c) => c.toUpperCase()), who2: scholar.replace(/^the /, ''), town: s.name, old, span, people: peopleOf(civ), tech: t.name.replace(/^The /, 'the '), fallen: peopleOf(fallen) });
      record(ctx, { text, imp: 3, tags: ['lost-lore'] });
      updateSite(world, site.id, { excavated: world.time.day, excavatedBy: s.id, lostTech: lost });
    } else {
      text = say(world, [
        '{who} of {town} uncovered the streets of {old}, a city dead for {span}, and its painted walls became the wonder of the age.',
        'Diggers sent by the library of {town} laid bare the palace of {old}; its statues were carried home in triumph.',
      ], { who: scholar.replace(/^./, (c) => c.toUpperCase()), town: s.name, old, span });
      record(ctx, { text, imp: 2 });
      updateSite(world, site.id, { excavated: world.time.day, excavatedBy: s.id });
    }
    effect(ctx, T.s(s), 'excavation', { culture: 1.15, research: 1.05 }, 15, 'Antiquities');
    heat(ctx, 'learning', 0.4, SUBJ.realm(civ.id));
    return true;
  },
});

