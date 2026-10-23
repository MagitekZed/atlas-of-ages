// Great figures: scholars, artists, generals, explorers, merchants and (in early ages)
// heroes. They arise in cultured, populous, prosperous states (more in golden ages), do
// one notable deed that is chronicled, lend their civ a bonus while they live (see
// computeMods: figureCounts), and die of age. Prophets belong to the religion module.
//
// figure = { id, name, kind, civId, sid, born, died, deeds: [string], title, fame, fate? }
// civ.flags.figs = [living figure ids]; civ.flags.figureCounts = { kind: n }.
// Ageing: every figure in civ.flags.figs (including generals the war module promotes and
// enrols there) ages monthly; a yearly sweep ages the living figures nobody enrolled (the
// war module's commanders, the bands' slayers) so no one is immortal. Age is divided by the
// ext 'lifespan' answer (an elf of 300 is in her prime); generals retire from the world by 90,
// everyone by 100. Figures of a fallen realm pass with it (index.js civDestroyed).
// Hooks: figureBorn (world, fig), figureDied (world, fig). Ext: rates 'figureBirth',
// heroTarget (a real beast near the town; else a beast of the town's own land).

import { addFigure, civSettlements, enemiesOf } from '../../core/entities.js';
import { makePerson, makeWord } from '../../core/names.js';
import { DAYS_PER_YEAR, RESOURCES, BIOME } from '../../core/constants.js';
import { emit } from '../../core/hooks.js';
import { mulOf, firstOf, hasProviders } from '../../core/ext.js';
import { capitalize } from '../../core/util.js';
import { TECH_BY_ID, researchBurst, getMods } from './tech.js';
import { findSite, foundSettlement } from './expansion.js';
import { fin, record } from './state.js';
import { theName, peopleOf, rulerShort, pick, seaNameNear } from './prose.js';

// WP2's published heroDeed (contracts §12 change request): a hero who goes after a real beast
// rolls against it, and the world remembers what truly happened
let bandsMod = null;
try { bandsMod = await import('../bands/index.js'); } catch (e) { /* bands module absent: heroes face the beasts of legend only */ }

function figureById(world, id) {
  const a = world.figures;
  let lo = 0, hi = a.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = a[mid].id;
    if (v === id) return a[mid];
    if (v < id) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

/** Age a figure in years of its people (the ext lifespan divisor: elves age slowly). */
export function figureAge(world, civ, fg) {
  const yrs = (world.time.day - fin(fg.born, world.time.day)) / DAYS_PER_YEAR;
  const div = hasProviders('lifespan') ? mulOf('lifespan', world, civ, fg) : 1;
  return yrs / (div > 0 ? div : 1);
}
/** Annual chance of death at an (effective) age. */
const figureHazard = (age) => 0.008 + 0.0004 * Math.exp((age - 30) / 9);
/** The age by which a figure has left the world at the latest (generals retire by 90). */
const ageCap = (kind) => (kind === 'general' ? 90 : 100);

/** A figure's death: mark, note its fate, tell the hooks (and, for the renowned, the chronicle). */
export function figureDies(world, fg, fate = 'old age', civ = null) {
  if (!fg || fg.died != null) return;
  fg.died = world.time.day;
  fg.fate = fate;
  const deeds = Array.isArray(fg.deeds) ? fg.deeds.length : 0;
  if (fate === 'old age' && deeds >= 2 && fg.kind !== 'general') {
    const s = fg.sid != null ? world.settlements[fg.sid] : null;
    const age = Math.round((world.time.day - fin(fg.born, world.time.day)) / DAYS_PER_YEAR);
    record(world, {
      cat: fg.kind === 'scholar' ? 'tech' : 'culture', imp: 1, key: 'figure.died',
      text: pick(world, [
        `The ${fg.title || fg.kind} ${fg.name}${s ? ` of ${s.name}` : ''} died full of years and honours${age > 0 ? ` at ${age}` : ''}.`,
        `${fg.name}, the ${fg.title || fg.kind}${civ ? ` of ${theName(civ)}` : ''}, was laid to rest${s ? ` in ${s.name}` : ''}.`,
      ]),
      x: s ? s.x : null, y: s ? s.y : null, sid: s ? s.id : null, civId: fg.civId ?? null, ref: { k: 'figure', id: fg.id },
    });
  }
  emit(world, 'figureDied', fg);
}

/** Monthly: deaths of living figures, recount, maybe a new figure. agg: { pop, atWar, coastShare } */
export function figuresMonthly(world, civ, agg) {
  const fl = civ.flags;
  if (!Array.isArray(fl.figs)) fl.figs = [];
  const counts = { scholar: 0, artist: 0, general: 0, explorer: 0, merchant: 0, hero: 0 };
  const keep = [];
  for (const id of fl.figs) {
    const fg = figureById(world, id);
    if (!fg || fg.died != null) continue;
    if (fg.civId !== civ.id) { figureDies(world, fg, 'went abroad and was lost to history', civ); continue; }
    const age = figureAge(world, civ, fg);
    if (age >= ageCap(fg.kind) || world.rng.chance(figureHazard(age) / 12)) { figureDies(world, fg, 'old age', civ); continue; }
    keep.push(id);
    if (counts[fg.kind] != null) counts[fg.kind]++;
  }
  fl.figs = keep;
  fl.figureCounts = counts;
  fl.figureTotal = keep.length;
  const pop = agg.pop;
  if (pop < 300) return;
  const rate = hasProviders('rates') ? mulOf('rates', world, 'figureBirth') : 1;
  const p = 0.0013 * Math.min(1.6, Math.max(0, (Math.log10(pop) - 3) / 1.5))
    * (civ.goldenAge > 0 ? 2.5 : 1) * (civ.darkAge > 0 ? 0.4 : 1) * (keep.length >= 6 ? 0.3 : 1) * rate;
  if (world.rng.chance(p)) spawnFigure(world, civ, agg);
}

/**
 * Yearly: the living figures no realm enrolled (the war module's commanders, bands'
 * slayers, figures of other packages) age too, so none outlives its century. Prophets are
 * the religion module's. A figure whose realm has fallen passes with it.
 */
export function figuresYearly(world) {
  const enrolled = new Set();
  for (const c of world.civs) if (c && c.alive && Array.isArray(c.flags?.figs)) for (const id of c.flags.figs) enrolled.add(id);
  for (const fg of world.figures) {
    if (!fg || fg.died != null || fg.kind === 'prophet' || enrolled.has(fg.id)) continue;
    if (!Number.isFinite(fg.born)) continue;
    const civ = fg.civId != null ? world.civs[fg.civId] : null;
    if (!civ || !civ.alive) { figureDies(world, fg, 'fell with the realm', civ); continue; }
    const age = figureAge(world, civ, fg);
    if (age >= ageCap(fg.kind) || world.rng.chance(figureHazard(age))) figureDies(world, fg, 'old age', civ);
  }
}

function pickHome(world, civ) {
  const ss = civSettlements(world, civ);
  if (!ss.length) return null;
  const ws = ss.map((s) => Math.sqrt(Math.max(1, s.population)) * (1 + Math.log10(1 + fin(s.culture)) * 0.3) * (s.buildings.university ? 1.5 : 1));
  let tot = 0; for (const w of ws) tot += w;
  let r = world.rng.next() * tot;
  for (let k = 0; k < ss.length; k++) { r -= ws[k]; if (r <= 0) return ss[k]; }
  return ss[ss.length - 1];
}

/** Who makes the breakthrough in each technology. */
const SCHOLAR_WHO = {
  toolmaking: 'flint-knapper', fishing: 'fisher', mysticism: 'shaman', agriculture: 'wise woman', husbandry: 'herder',
  pottery: 'potter', bronze: 'smith', masonry: 'mason', wheel: 'wheelwright', sailing: 'boatwright', writing: 'scribe',
  irrigation: 'water-master', iron: 'smith', mathematics: 'mathematician', currency: 'moneyer', horseback: 'horse-tamer',
  laws: 'lawgiver', philosophy: 'philosopher', engineering: 'engineer', medicine: 'physician', shipbuilding: 'shipwright',
  drama: 'playwright', tactics: 'strategist', feudalism: 'jurist', theology: 'theologian', astronomy: 'astronomer',
  croprotation: 'agronomist', guilds: 'master craftsman', scholasticism: 'scholar', navigation: 'navigator', printing: 'printer',
  gunpowder: 'alchemist', banking: 'banker', anatomy: 'anatomist', science: 'natural philosopher', steam: 'inventor',
  railways: 'engineer', sanitation: 'physician', chemistry: 'chemist', vaccines: 'physician', electricity: 'physicist',
  combustion: 'engineer', flight: 'aviator', antibiotics: 'microbiologist', massmedia: 'broadcaster', computers: 'mathematician',
  greenrev: 'agronomist', renewables: 'engineer',
};
/** The beasts a hero of each land might face (by the town's biome). */
const BEASTS_BY_BIOME = {
  [BIOME.ICE]: ['great white bear', 'white wolf'],
  [BIOME.TUNDRA]: ['great white bear', 'white wolf', 'mammoth bull'],
  [BIOME.TAIGA]: ['great cave bear', 'grey wolf of the pines', 'giant elk'],
  [BIOME.STEPPE]: ['man-eating lion', 'sabre-toothed cat', 'wild bull'],
  [BIOME.SHRUBLAND]: ['giant boar', 'spotted hyena pack', 'man-eating lion'],
  [BIOME.TEMPERATE_FOREST]: ['giant boar', 'great cave bear', 'white wolf'],
  [BIOME.TEMPERATE_RAINFOREST]: ['great cave bear', 'giant boar'],
  [BIOME.HOT_DESERT]: ['sand lion', 'great scorpion', 'desert jackal pack'],
  [BIOME.COLD_DESERT]: ['snow leopard', 'wild camel bull'],
  [BIOME.SAVANNA]: ['man-eating lion', 'rogue elephant', 'sabre-toothed cat'],
  [BIOME.TROPICAL_FOREST]: ['great serpent', 'man-eating tiger'],
  [BIOME.RAINFOREST]: ['great serpent', 'jungle cat', 'man-eating tiger'],
  [BIOME.WETLAND]: ['marsh serpent', 'giant crocodile'],
  [BIOME.ALPINE]: ['snow leopard', 'great eagle'],
};
const BEASTS_ANY = ['great cave bear', 'white wolf', 'giant boar'];

// Figure titles and works (docs/design/temperament-and-names.md §3): era- and calling-appropriate
// titles in place of one fixed word each, and epics named from the people's own tongue.
const GENERAL_TITLES = [
  ['war-leader', 'war-chief', 'champion', 'battle-captain', 'warlord'],                   // Stone–Iron
  ['general', 'captain', 'marshal', 'commander', 'captain-general', 'strategos'],          // Classical–Renaissance
  ['field marshal', 'general', 'commander', 'marshal'],                                   // Industrial on
];
const EXPLORER_TITLES = { sea: ['explorer', 'navigator', 'voyager', 'sea-captain', 'mariner'], land: ['explorer', 'wayfinder', 'pathfinder', 'traveller', 'wanderer'] };
const MERCHANT_TITLES = [['merchant', 'trader', 'caravan-master'], ['merchant', 'trader', 'caravan-master', 'merchant prince', 'moneylender'], ['merchant', 'merchant prince', 'banker', 'financier', 'shipowner']];
const HERO_TITLES = ['hero', 'hero', 'champion', 'warrior'];
const EPIC_FORMS = ['the Song of {hero}', 'the Lay of {hero}', 'the Saga of {hero}', 'the Ballad of {hero}', 'the Deeds of {hero}', 'the Lament for {hero}',
  'the Book of {word}', 'the {adj} Epic', 'the {word} Cycle', 'the Tale of {word}', 'the Hymn of {word}', 'the Chronicle of {city}'];

function epicName(world, civ, hero, city = null) {
  const tpl = pick(world, city ? EPIC_FORMS : EPIC_FORMS.slice(0, -1));
  return tpl.replace('{hero}', hero).replace('{adj}', civ.adjective).replace('{city}', city || '')
    .replace('{word}', () => makeWord(civ.language, world.rng, 1, 2));
}

function spawnFigure(world, civ, agg) {
  const s = pickHome(world, civ);
  if (!s) return;
  const era = fin(civ.tech?.era, 0);
  const mods = getMods(world, civ);
  const tr = civ.traits || {};
  const atWar = agg.atWar;
  const kinds = ['scholar', 'artist', 'general', 'explorer', 'merchant', 'hero'];
  const w = [
    era >= 1 ? 1 + 2 * fin(tr.innovation, 0.5) : 0.3,
    1 + 1.5 * fin(tr.religiosity, 0.5) * 0.5 + fin(tr.tolerance, 0.5),
    (atWar ? 3 : 0.4) * (0.5 + fin(tr.militarism, 0.5)),
    mods.navigation >= 1 && s.coastal ? 1 + 1.5 * fin(tr.expansion, 0.5) : era >= 1 ? 0.3 : 0,
    era >= 1 ? 0.6 + 2 * fin(tr.commerce, 0.5) : 0,
    era <= 1 ? 2.2 : 0,
  ];
  let tot = 0; for (const x of w) tot += x;
  let r = world.rng.next() * tot, k = 0;
  for (; k < w.length - 1; k++) { r -= w[k]; if (r <= 0) break; }
  const kind = kinds[k];
  const name = makePerson(civ.language, world.rng);
  const age = world.rng.int(25, 45);
  const fig = { name, kind, civId: civ.id, sid: s.id, born: world.time.day - age * DAYS_PER_YEAR, died: null, deeds: [], title: kind, fame: 2 };
  let text = null, cat = 'culture';
  let heroFoe = null;
  const who = `${name} of ${s.name}`;
  switch (kind) {
    case 'scholar': {
      const t = researchTarget(civ);
      const title = (t && SCHOLAR_WHO[t.id]) || (era >= 3 ? 'scholar' : 'sage');
      fig.title = title;
      cat = 'tech';
      if (t) {
        text = `${capitalize(article(title))} ${title}, ${who}, ${t.deed}.`;
        fig.deeds.push(t.deed);
      } else text = `The ${title} ${who} gathered the learning of ${peopleOf(civ)} into a great compendium.`;
      break;
    }
    case 'artist': {
      const roles = era <= 1 ? ['storyteller', 'carver', 'singer'] : era <= 4 ? ['poet', 'sculptor', 'architect', 'playwright'] : era <= 6 ? ['painter', 'composer', 'novelist', 'architect'] : ['filmmaker', 'composer', 'novelist', 'architect'];
      const role = world.rng.pick(roles);
      fig.title = role;
      const ruler = civ.ruler ? rulerShort(civ.ruler) : s.name;
      const deeds = {
        storyteller: [`first told ${epicName(world, civ, ruler)} around the hearth-fires`, `wove the old tales of ${peopleOf(civ)} into ${epicName(world, civ, ruler)}`],
        carver: [`carved the great beasts upon the cliffs near ${s.name}`, `shaped the ancestor-figures that guarded ${s.name}`],
        singer: [`sang the songs by which ${peopleOf(civ)} remembered their ancestors`],
        poet: [`composed ${epicName(world, civ, ruler, s.name)}, the great epic of ${peopleOf(civ)}`, `wrote verses that were still recited a thousand years later`],
        sculptor: [`carved a statue of ${ruler} that stood in ${s.name} for centuries`, `filled the temples of ${s.name} with marble gods`],
        architect: [`raised the great domed hall of ${s.name}`, `laid out the broad avenues of ${s.name}`],
        playwright: [`wrote tragedies that filled the theatres of ${s.name}`],
        painter: [`painted the frescoes of the great hall of ${s.name}`, `painted portraits so lifelike they were said to breathe`],
        composer: [`wrote the ${civ.adjective} Symphony`, `composed music that was played in every court of the age`],
        novelist: [`wrote a novel of ${s.name} that every ${civ.adjective} child would read`],
        filmmaker: [`made moving pictures that were watched across the world`],
      }[role] || ['made works of lasting beauty'];
      const d = world.rng.pick(deeds);
      fig.deeds.push(d);
      text = `The ${role} ${who} ${d}.`;
      s.culture = fin(s.culture) + 150 + 50 * era;
      civ.prestige = fin(civ.prestige) + 2;
      break;
    }
    case 'general': {
      fig.title = world.rng.pick(GENERAL_TITLES[era >= 6 ? 2 : era >= 3 ? 1 : 0]);
      const wars = enemiesOf(world, civ.id).length ? world.wars.filter((x) => x.active && (x.attackers.includes(civ.id) || x.defenders.includes(civ.id))) : [];
      const war = wars.length ? world.rng.pick(wars) : null;
      const d = war ? `won renown in ${war.name.replace(/^The /, 'the ')}` : pick(world, [`rose to command the armies of ${theName(civ)}`, `drilled the warriors of ${s.name} into a feared host`]);
      fig.deeds.push(d);
      text = `The ${fig.title} ${who} ${d}.`;
      cat = 'civ';
      break;
    }
    case 'explorer': {
      cat = 'civ';
      fig.title = world.rng.pick(EXPLORER_TITLES[mods.navigation >= 1 && s.coastal ? 'sea' : 'land']);
      if (mods.navigation >= 1 && s.coastal) {
        const sea = seaNameNear(world, s.x, s.y) || 'the western sea';
        const d = `sailed beyond ${sea} and returned with charts of unknown coasts`;
        fig.deeds.push(d);
        text = `The ${fig.title} ${who} ${d}.`;
        const site = findSite(world, s, civ, { overseas: true, range: mods.seaRange + 18 });
        if (site && s.population > 400) {
          const n = Math.min(s.population * 0.08, 1500);
          s.population -= n;
          spawnLater(world, civ, s, site, n);
        }
      } else {
        const d = pick(world, ['crossed the wilderness and mapped the lands beyond the frontier', 'travelled for years and brought back tales of distant peoples']);
        fig.deeds.push(d);
        text = `The ${fig.title} ${who} ${d}.`;
      }
      break;
    }
    case 'merchant': {
      fig.title = world.rng.pick(MERCHANT_TITLES[era >= 5 ? 2 : era >= 3 ? 1 : 0]);
      cat = 'trade';
      const goods = goodsOf(world, s);
      const d = pick(world, [
        `grew rich on ${goods}`,
        `built a trading house on ${goods} whose agents reached far beyond ${theName(civ)}`,
        `made ${s.name} the hub of ${goods}`,
        `lent gold to princes and grew richer than any of them`,
      ]);
      fig.deeds.push(d);
      text = pick(world, [`The ${fig.title} ${who} ${d}.`, `${capitalize(article(fig.title))} ${fig.title} of ${s.name}, ${name}, ${d}.`]);
      s.wealth = fin(s.wealth) + s.population * 0.08;
      civ.treasury = fin(civ.treasury) + s.population * 0.03;
      break;
    }
    default: { // hero
      fig.title = world.rng.pick(HERO_TITLES);
      // a real beast abroad near the town (Mythic worlds), else one of the town's own land
      const foe = hasProviders('heroTarget') ? firstOf('heroTarget', world, civ, s) : null;
      const beasts = BEASTS_BY_BIOME[world.f.biome[s.i]] || BEASTS_ANY;
      if (foe && foe.bandId != null && typeof bandsMod?.heroDeed === 'function') {
        // the deed is rolled once the hero exists (below): heroDeed slays or wounds the real beast
        heroFoe = foe;
        civ.legitimacy = Math.min(1, fin(civ.legitimacy) + 0.04);
        civ.stability = Math.min(1, fin(civ.stability) + 0.02);
        break;
      }
      const d = foe && foe.name
        ? pick(world, [`stood alone against ${foe.name} and drove it back from the herds`, `wounded ${foe.name} and sent it howling into the wild`])
        : pick(world, [
          `slew the ${world.rng.pick(beasts)} that preyed upon the herds`,
          `led ${peopleOf(civ)} through the long hungry winter`,
          `drove off the raiders who fell upon the town by night`,
          `found the hidden spring that saved the town in a year of drought`,
        ]);
      if (foe && foe.bandId != null) fig.foeBandId = foe.bandId;
      fig.deeds.push(d);
      text = pick(world, [`The ${fig.title} ${who} ${d}, and was sung of for generations.`, `${capitalize(who)} ${d}; the songs of ${peopleOf(civ)} never forgot it.`]);
      civ.legitimacy = Math.min(1, fin(civ.legitimacy) + 0.04);
      civ.stability = Math.min(1, fin(civ.stability) + 0.02);
    }
  }
  const f = addFigure(world, fig);
  civ.flags.figs.push(f.id);
  if (heroFoe) {
    f.foeBandId = heroFoe.bandId;
    let res = null;
    try { res = bandsMod.heroDeed(world, civ, heroFoe.bandId, f); } catch (e) { res = null; }
    if (res && res.slain) text = null;   // the slaying is chronicled by the bands module, with the hero's name
    else {
      const d = res ? res.deed : pick(world, [`stood alone against ${heroFoe.name} and drove it back from the herds`, `wounded ${heroFoe.name} and sent it howling into the wild`]);
      (f.deeds ||= []).push(d);
      text = pick(world, [`The ${f.title || 'hero'} ${who} ${d}, and was sung of for generations.`, `${capitalize(who)} ${d}; the songs of ${peopleOf(civ)} never forgot it.`]);
    }
  }
  if (text) record(world, { cat, imp: 2, key: `figure.${kind}`, text, s, ref: { k: 'figure', id: f.id } });
  emit(world, 'figureBorn', f);
  if (kind === 'scholar') researchBurst(world, civ, 0.5);
}

function spawnLater(world, civ, from, site, n) {
  foundSettlement(world, civ, site.x, site.y, n * 0.9, { from, overseas: true });
}

function researchTarget(civ) {
  const id = civ.tech?.research;
  return id ? TECH_BY_ID[id] || null : null;
}

function article(word) {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function goodsOf(world, s) {
  const { W, H, f } = world;
  const found = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const r = f.resource[y * W + x];
    if (r) found.push(RESOURCES[r].name.toLowerCase());
  }
  if (found.length) return `the ${world.rng.pick(found)} trade`;
  return pick(world, ['the grain trade', 'the wool trade', 'the caravan trade', 'the river trade', 'trade in fine cloth']);
}
