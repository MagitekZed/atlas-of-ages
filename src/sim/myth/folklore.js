// Folklore: the Legendary deck (mythLevel ≥ 1). Omens, saints and relics, witch-hunts,
// haunted ruins, holy wells, cursed houses, prophecies that come true. Everything acts
// through belief and politics, never physics: small timed effects (core/effects.js), a
// holy site or two (core/sites.js), opinion between realms, and the chronicle.
//
// Registered at import in the core event registry (core/events.js) with minMyth 1, family
// 'folklore'; WP1's engine schedules the checks (town, realm and world scales, yearly), sums
// the pure weights and fires one def per hit. Rates aim at roughly ten folklore entries a
// century on a medium world, half of them notable: each tale rests for some years after it is
// told anywhere (so three towns never meet the Fair Folk in one summer), and a tale is never
// told in the same words twice running. The sea-serpent and fairy tales stay at the Legendary
// level (in a Mythic world the krakens are real).
//
// State: sys.myth.folk { saints: { figId: day }, prophecies: [...], grudges: { 'a|b': day },
// last: { id: day }, lastT: { id: template }, n } (created lazily at level ≥ 1). A prophecy
// names a city and a span; the casusBelli provider (this module) gives its prophet-realm a
// claim on the city, and the settlementTransferred hook closes the loop when it falls.

import { registerEvent } from '../../core/events.js';
import { registerProvider } from '../../core/ext.js';
import { on } from '../../core/hooks.js';
import { addEffect, removeEffect, getEffect } from '../../core/effects.js';
import { addSite, updateSite } from '../../core/sites.js';
import { addOpinion, areAtWar, damageSettlement, liveCivs } from '../../core/entities.js';
import { BIOME, DAYS_PER_YEAR, DAYS_PER_MONTH, MONTH_SEASON } from '../../core/constants.js';
import { hash2i } from '../../core/rng.js';
import { fin } from './races.js';
import { fill, record, theName, TheName, peopleOf, rulerName, yearOfDay, seasonAt, monthNameOf, landName, placePhrase } from './prose.js';

const Y = DAYS_PER_YEAR;
export const FOLK_FAMILY = 'folklore';

/** The folklore state (created on first use; only ever at mythLevel ≥ 1). */
export function folkState(world) {
  const m = (world.sys.myth ||= {});
  const f = (m.folk ||= { saints: {}, prophecies: [], grudges: {}, last: {}, lastT: {}, n: 0 });
  f.saints ||= {}; f.prophecies ||= []; f.grudges ||= {}; f.last ||= {}; f.lastT ||= {};
  return f;
}
const peekFolk = (world) => world.sys.myth?.folk || null;
// Legendary worlds live on their tales (×2.5); in a Mythic world real magic crowds them out a little
const lvl = (ctx) => (ctx.mythLevel >= 2 ? 0.7 : 2.5);
/** The Legendary-only tales are weighted for mythLevel 1 at the same lift. */
const LEGEND = 2.5;
const divine = (ctx) => Math.max(0, fin(ctx.world.params.divineIntervention, 1));
const capitalOf = (world, civ) => (civ && civ.capitalId != null ? world.settlements[civ.capitalId] : null);
/** Years since this tale was last told anywhere (Infinity if never). Pure. */
const since = (world, id) => { const d = peekFolk(world)?.last?.[id]; return d == null ? Infinity : (world.time.day - d) / Y; };
/** A tale rests for `gap` years after it is told anywhere in the world. */
const rested = (ctx, id, gap) => since(ctx.world, id) >= gap;

/** "from as far as Bax" — the farthest notable town within reach — or a vaguer distance. */
function farFrom(world, s) {
  let best = null, bd = 0;
  for (const t of world.settlements) {
    if (!t || !t.alive || t.id === s.id || t.tier < 2) continue;
    const d = (t.x - s.x) ** 2 + (t.y - s.y) ** 2;
    if (d > bd && d < 1600) { bd = d; best = t; }
  }
  return best ? `from as far as ${best.name}` : 'from far beyond its borders';
}

/** A template from the pool, never the one this tale used last time. */
function pickFresh(world, id, pool) {
  const f = folkState(world);
  const prev = f.lastT[id];
  let k = Math.floor(world.rng.next() * pool.length);
  if (pool.length > 1 && k === prev) k = (k + 1 + Math.floor(world.rng.next() * (pool.length - 1))) % pool.length;
  f.lastT[id] = k;
  return pool[k];
}
const tell = (ctx, id, pool, vars) => fill(pickFresh(ctx.world, id, pool), vars);

const write = (ctx, id, e) => {
  const f = folkState(ctx.world);
  f.n = fin(f.n, 0) + 1;
  // in a Legendary world the first telling of each kind of tale is major news (it is what sets
  // the world apart from a Historical one)
  const first = f.last[id] == null && ctx.mythLevel === 1;
  f.last[id] = ctx.world.time.day;
  const imp = first ? Math.max(3, fin(e.imp, 2)) : e.imp;
  const entry = record(ctx.world, { cause: ctx.cause ?? null, key: 'event.' + id, ...e, imp, tags: ['folklore', ...(e.tags || [])].slice(0, 4) });
  if (!ctx.entry) ctx.entry = entry;
  if (entry) f.lastAt = { x: entry.x, y: entry.y, seq: entry.seq };
  return entry;
};
const isWinter = (world, s) => {
  const m = Math.floor(world.time.day / DAYS_PER_MONTH) % 12;
  const ns = MONTH_SEASON[m];
  return (s.y < world.H / 2 ? ns : (ns + 2) % 4) === 0;
};

// ---------------------------------------------------------------------------
// World: the great comet

const COMET = [
  'A bearded star hung over {land} for forty nights in Year {y}; in {cap} {ruler} {react}, and the people whispered that a reign was ending.',
  'In the {season} of Year {y} a comet with a tail like a torn banner crossed the sky above {cap}. The priests of {realm} named it a judgement, and the crowds in the markets grew restless.',
  'For a month of Year {y} a fiery star burned beside the moon. From {cap} to the furthest villages of {realm} men read doom in it, and three crowns sat uneasily.',
  'The star the shepherds called the Sword hung over {land} through the {season} of Year {y}. {ruler} {react}; in the taverns of {cap} men wagered on whose crown would fall.',
  'A long-haired star rose over {cap} in Year {y}, and for weeks no one in {realm} would marry, sow or sail beneath it.',
];
registerEvent({
  id: 'folk_comet', scale: 'world', family: FOLK_FAMILY, cat: 'myth', imp: 3, minMyth: 1, cooldownYears: 70, tags: ['omen'],
  weight: (ctx) => 0.012 * lvl(ctx),
  fire(ctx) {
    const { world } = ctx;
    const big = liveCivs(world).slice().sort((a, b) => fin(b.population) - fin(a.population) || a.id - b.id).slice(0, 3);
    if (!big.length) return false;
    const lead = big[0];
    const cap = capitalOf(world, lead);
    for (const c of big) addEffect(world, { kind: 'civ', id: c.id }, { k: 'folk.omen', until: world.time.day + 4 * Y, m: { stability: -0.04 }, label: 'A bearded star in the sky' });
    const react = ['shut the palace gates', 'called the astrologers to court', 'made great offerings at every temple', 'had the comet-watchers flogged', 'rode out to show the people a calm face'];
    return write(ctx, 'folk_comet', {
      imp: 3, tags: ['omen'],
      text: tell(ctx, 'folk_comet', COMET, {
        land: cap ? landName(world, cap.x, cap.y) || 'the world' : 'the world', y: yearOfDay(world.time.day), cap: cap ? cap.name : 'the capitals',
        ruler: rulerName(lead) || 'the ruler', react: react[Math.floor(world.rng.next() * react.length)],
        season: cap ? seasonAt(world, cap.y) : 'spring', realm: theName(lead),
      }),
      x: cap?.x, y: cap?.y, civId: lead.id, sid: cap?.id ?? null, ref: { k: 'civ', id: lead.id },
    });
  },
});

// ---------------------------------------------------------------------------
// Realm: eclipse, cursed house, prophecy

const ECLIPSE_CALM = [
  'The sun went dark over {cap} at midday in Year {y}. {ruler} walked out into the square and stood bareheaded until the light returned, and the people loved {pron} for it.',
  'When the sun was swallowed above {cap} in the {season} of Year {y}, {ruler} named it a blessing; the temples of {realm} were full for a year after.',
  'Darkness fell on {cap} at noon in Year {y}. {ruler} had the great drums beaten until the sun came back, and {realm} took it for a sign of {pron2} favour.',
];
const ECLIPSE_FEAR = [
  'The sun went dark over {cap} at midday in Year {y}; {ruler} hid in the temple, and the people of {realm} whispered of an ending.',
  'In the {season} of Year {y} the sun was eaten above {cap}. Mobs smashed the shrines of foreign gods, and the court of {ruler} took months to restore order.',
  'A black sun hung over {cap} in Year {y}. The priests said the gods had turned their faces from {ruler}, and in the markets of {realm} men began to say it aloud.',
];
registerEvent({
  id: 'folk_eclipse', scale: 'realm', family: FOLK_FAMILY, cat: 'myth', imp: 2, minMyth: 1, cooldownYears: 60, tags: ['omen'],
  weight: (ctx) => (ctx.civ && ctx.civ.capitalId != null && ctx.civ.ruler && rested(ctx, 'folk_eclipse', 12) ? 0.0012 * lvl(ctx) : 0),
  fire(ctx) {
    const { world, civ } = ctx;
    const cap = capitalOf(world, civ);
    if (!cap) return false;
    const calm = (civ.ruler?.traits || []).some((t) => t === 'pious' || t === 'wise' || t === 'charismatic');
    addEffect(world, { kind: 'civ', id: civ.id }, { k: 'folk.eclipse', until: world.time.day + 3 * Y, m: { stability: calm ? 0.02 : -0.03 }, label: calm ? 'Calm in the darkness' : 'The sun went dark' });
    const f = civ.ruler?.gender === 'f';
    return write(ctx, 'folk_eclipse', {
      imp: 2, tags: ['omen'],
      text: tell(ctx, calm ? 'folk_eclipse.calm' : 'folk_eclipse', calm ? ECLIPSE_CALM : ECLIPSE_FEAR, { cap: cap.name, y: yearOfDay(world.time.day), ruler: rulerName(civ) || 'the ruler', pron: f ? 'her' : 'him', pron2: f ? 'her' : 'his', realm: theName(civ), season: seasonAt(world, cap.y) }),
      x: cap.x, y: cap.y, civId: civ.id, sid: cap.id, ref: { k: 'civ', id: civ.id },
    });
  },
});

const VIOLENT = /assassin|battle|murder|execut|coup|killed|slain|poison/;
function violentDeaths(civ) {
  const h = civ.rulerHistory;
  if (!Array.isArray(h) || h.length < 3) return 0;
  let n = 0;
  for (let k = Math.max(0, h.length - 4); k < h.length; k++) if (VIOLENT.test(String(h[k]?.cause || ''))) n++;
  return n;
}
/** "House of Zin", "House Zin" or "Zin dynasty" → "Zin" (printed as 'the House of Zin'). */
const houseRoot = (d) => String(d || '').replace(/^(the )?house (of )?/i, '').replace(/\s+dynasty$/i, '').trim() || 'its kings';
const CURSE = [
  'After {n} of its rulers died by knife or sword, the people of {cap} said the House of {dyn} was cursed, and mothers would not let their daughters marry into it.',
  'A hedge-witch was hanged in {cap} in Year {y} for laying a curse on the House of {dyn}; the people believed the curse outlived her.',
  'In {cap} they began to call it the Red Crown: {n} of the House of {dyn} had worn it to an early grave, and by Year {y} no cousin wanted it.',
];
registerEvent({
  id: 'folk_cursed_house', scale: 'realm', family: FOLK_FAMILY, cat: 'myth', imp: 2, minMyth: 1, cooldownYears: 100, tags: ['curse'],
  weight: (ctx) => (ctx.civ && ctx.civ.dynasty && violentDeaths(ctx.civ) >= 2 ? 0.02 * lvl(ctx) : 0),
  fire(ctx) {
    const { world, civ } = ctx;
    const cap = capitalOf(world, civ);
    const n = violentDeaths(civ);
    const dyn = houseRoot(civ.dynasty);
    addEffect(world, { kind: 'civ', id: civ.id }, { k: 'folk.curse', until: world.time.day + 30 * Y, m: { stability: -0.03 }, label: `The curse of the House of ${dyn}` });
    return write(ctx, 'folk_cursed_house', {
      imp: 2, tags: ['curse'],
      text: tell(ctx, 'folk_cursed_house', CURSE, { n: n === 2 ? 'two' : n === 3 ? 'three' : 'four', cap: cap ? cap.name : 'the capital', dyn, y: yearOfDay(world.time.day) }),
      x: cap?.x, y: cap?.y, civId: civ.id, sid: cap?.id ?? null, ref: { k: 'civ', id: civ.id },
    });
  },
});

/** The bitterest rival of civ with a city worth prophesying about (pure; no allocation). */
function rivalOf(world, civ) {
  let best = null, bo = -20;
  for (const k in civ.relations || {}) {
    const o = world.civs[+k];
    if (!o || !o.alive || o.id === civ.id || o.capitalId == null) continue;
    const op = fin(civ.relations[k]?.opinion, 0);
    if (op < bo) { bo = op; best = o; }
  }
  return best;
}
const PROPHECY = [
  'A seer in {cap} foretold that {city} would fall to {realm} before {years} years were out; {ruler} had the words cut into the palace wall.',
  'In Year {y} a blind prophetess came to the court at {cap} and named the day {city} would burn. {ruler} gave her a house and a guard, and began to gather spears.',
  'The oracle of {cap} spoke in Year {y}: within {years} years the banners of {realm} would fly over {city}.',
  'Smoke from the sacred fire at {cap} bent toward {city} three nights running in Year {y}; the priests said it would be {realm}’s within {years} years, and no one at court argued.',
];
registerEvent({
  id: 'folk_prophecy', scale: 'realm', family: FOLK_FAMILY, cat: 'myth', imp: 2, minMyth: 1, cooldownYears: 80, tags: ['prophecy'],
  weight: (ctx) => (ctx.civ && ctx.civ.capitalId != null && rivalOf(ctx.world, ctx.civ) ? 0.0015 * lvl(ctx) : 0),
  fire(ctx) {
    const { world, civ } = ctx;
    const rival = rivalOf(world, civ);
    const cap = capitalOf(world, civ);
    if (!rival || !cap) return false;
    // the rival's greatest city within reach
    let city = null;
    for (const sid of rival.settlementIds || []) {
      const s = world.settlements[sid];
      if (!s || !s.alive) continue;
      const d = Math.hypot(s.x - cap.x, s.y - cap.y);
      if (d > 45) continue;
      if (!city || s.population > city.population) city = s;
    }
    if (!city) return false;
    const years = world.rng.int(20, 40);
    const e = write(ctx, 'folk_prophecy', {
      imp: 2, tags: ['prophecy'],
      text: tell(ctx, 'folk_prophecy', PROPHECY, { cap: cap.name, city: city.name, people: peopleOf(civ), years, ruler: rulerName(civ) || 'the ruler', y: yearOfDay(world.time.day), realm: theName(civ) }),
      x: cap.x, y: cap.y, civId: civ.id, sid: cap.id, ref: { k: 'settlement', id: city.id },
    });
    const f = folkState(world);
    f.prophecies.push({ civId: civ.id, sid: city.id, until: world.time.day + years * Y, seq: e ? e.seq : null, day: world.time.day });
    if (f.prophecies.length > 12) f.prophecies.shift();
    return e;
  },
});

// ---------------------------------------------------------------------------
// Town: saints and relics, relic theft, holy wells, weeping statues

const SAINTLY = new Set(['prophet', 'hero', 'scholar', 'artist']);
/**
 * Dead great figures by town (prophets, heroes, scholars, artists), rebuilt at most once a
 * year or when the figure list changes: a derived cache, so each town check is a lookup.
 */
function figuresByTown(world) {
  const c = world.cache;
  const key = `${world.nextId.figure}|${world.figures.length}|${Math.floor(world.time.day / Y)}`;
  if (c.mythSaintIdx && c.mythSaintKey === key) return c.mythSaintIdx;
  const idx = new Map();
  for (const fig of world.figures) {
    if (fig.sid == null || fig.died == null || !SAINTLY.has(fig.kind)) continue;
    let list = idx.get(fig.sid);
    if (!list) idx.set(fig.sid, (list = []));
    list.push(fig);
  }
  c.mythSaintIdx = idx; c.mythSaintKey = key;
  return idx;
}
/** A dead great figure of this town, gone twenty years and not yet a saint. */
function saintFor(world, s) {
  const list = figuresByTown(world).get(s.id);
  if (!list) return null;
  const f = peekFolk(world);
  const day = world.time.day;
  for (const fig of list) {
    if (day - fig.died < 20 * Y) continue;
    if (f && f.saints[fig.id] != null) continue;
    return fig;
  }
  return null;
}
const SAINT = [
  'The bones of {fig}{deed} were enshrined at {town}; within a generation pilgrims were walking {far} to pray to Saint {fig}.',
  'In Year {y} the people of {town} began to call {fig} a saint. A finger-bone in a silver box drew pilgrims {far}, and the innkeepers of {town} grew rich.',
  'A lame girl walked again at the grave of {fig} in Year {y}, or so {town} said; soon there was a shrine, and Saint {fig} had pilgrims {far}.',
  'The monks of {town} dug up the coffin of {fig}{deed} and found the body uncorrupted. Saint {fig} was carried through the streets every {season} after.',
];
registerEvent({
  id: 'folk_saint', scale: 'town', family: FOLK_FAMILY, cat: 'religion', imp: 2, minMyth: 1, cooldownYears: 80, tags: ['saint'],
  weight: (ctx) => {
    const s = ctx.s;
    if (!s || s.tier < 2 || !(fin(s.buildings?.temple, 0) > 0) || !rested(ctx, 'folk_saint', 12)) return 0;
    return saintFor(ctx.world, s) ? 0.004 * lvl(ctx) * (0.5 + 0.5 * divine(ctx)) : 0;
  },
  fire(ctx) {
    const { world, s } = ctx;
    const fig = saintFor(world, s);
    if (!fig) return false;
    const f = folkState(world);
    f.saints[fig.id] = world.time.day;
    const deed = Array.isArray(fig.deeds) && fig.deeds.length ? String(fig.deeds[0]) : null;
    const site = addSite(world, { kind: 'holy', x: s.x, y: s.y, name: `the Shrine of Saint ${fig.name}`, civIds: [s.civId], ref: { k: 'figure', id: fig.id }, data: { relic: fig.id, folk: 'saint' } });
    addEffect(world, { kind: 'settlement', id: s.id }, { k: 'folk.relics', until: world.time.day + 60 * Y, m: { culture: 1.15, trade: 1.08, attract: 1.1 }, label: `The relics of Saint ${fig.name}` });
    return write(ctx, 'folk_saint', {
      imp: 2, tags: ['saint'], cat: 'religion',
      text: tell(ctx, 'folk_saint', SAINT, { fig: fig.name, deed: deed ? `, who ${deed},` : '', town: s.name, far: farFrom(world, s), y: yearOfDay(world.time.day), season: seasonAt(world, s.y) }),
      x: s.x, y: s.y, sid: s.id, civId: s.civId, ref: { k: 'site', id: site.id },
    });
  },
});

function relicFig(s) {
  for (const e of s.effects || []) if (e.k === 'folk.relics') return e;
  return null;
}
/** A hostile realm with a town within 15 tiles of s (pure). */
function raiderOf(world, s) {
  for (const t of world.settlements) {
    if (!t || !t.alive || t.civId === s.civId) continue;
    if ((t.x - s.x) ** 2 + (t.y - s.y) ** 2 > 225) continue;
    if (areAtWar(world, s.civId, t.civId)) return t;
  }
  return null;
}
const THEFT = [
  'Raiders of {thief} carried the relics of {saint} out of {town} in Year {y}; for a generation the bells of {victim} rang for vengeance.',
  'In the {season} of Year {y} soldiers of {thief} broke open the shrine at {town} and bore {saint} away to {cap}. {Victim} swore it would be answered.',
  'The shrine of {saint} at {town} was found empty after the soldiers of {thief} passed through; in {cap} they put the relics on show, and {victim} never forgave it.',
];
registerEvent({
  id: 'folk_relic_theft', scale: 'town', family: FOLK_FAMILY, cat: 'myth', imp: 2, minMyth: 1, cooldownYears: 50, tags: ['saint', 'grievance'],
  weight: (ctx) => (ctx.s && relicFig(ctx.s) && raiderOf(ctx.world, ctx.s) ? 0.02 * lvl(ctx) : 0),
  fire(ctx) {
    const { world, s } = ctx;
    const eff = relicFig(s), t = raiderOf(world, s);
    if (!eff || !t) return false;
    const thief = world.civs[t.civId], victim = world.civs[s.civId];
    const cap = capitalOf(world, thief);
    const saint = String(eff.label || 'the relics').replace(/^The relics of /, '');
    removeEffect(world, { kind: 'settlement', id: s.id }, 'folk.relics');
    if (cap) addEffect(world, { kind: 'settlement', id: cap.id }, { k: 'folk.relics', until: world.time.day + 40 * Y, m: { culture: 1.12, trade: 1.06, attract: 1.08 }, label: eff.label });
    addOpinion(world, victim.id, thief.id, -25, false);
    folkState(world).grudges[`${victim.id}|${thief.id}`] = world.time.day;
    return write(ctx, 'folk_relic_theft', {
      imp: 2, tags: ['saint', 'grievance'],
      text: tell(ctx, 'folk_relic_theft', THEFT, { thief: theName(thief), saint, town: s.name, y: yearOfDay(world.time.day), victim: theName(victim), Victim: TheName(victim), cap: cap ? cap.name : 'their capital', season: seasonAt(world, s.y) }),
      x: s.x, y: s.y, sid: s.id, civId: victim.id, ref: { k: 'civ', id: thief.id },
    });
  },
});

const WATERY = (world, s) => world.f.river[s.i] > 0 || s.coastal || world.f.biome[s.i] === BIOME.WETLAND;
const WELL = [
  'A spring at {town} was said to cure the blind; by Year {y} the sick were coming {far} to bathe in it.',
  'In Year {y} a shepherd girl of {town} saw a lady of light at the spring below the town. The water healed fevers, people said, and a chapel was raised over it.',
  'The well in the square at {town} began to taste of iron and honey in Year {y}; the lame drank and walked, and the town put a roof of gold leaf over it.',
  'Pilgrims {far} came to the healing pool at {town} after Year {y}, hanging rags on the thorn beside it for every fever it took away.',
];
registerEvent({
  id: 'folk_holy_well', scale: 'town', family: FOLK_FAMILY, cat: 'religion', imp: 2, minMyth: 1, cooldownYears: 120, tags: ['miracle'],
  weight: (ctx) => (ctx.s && ctx.s.tier >= 1 && WATERY(ctx.world, ctx.s) && rested(ctx, 'folk_holy_well', 25) && !getEffect(ctx.world, { kind: 'settlement', id: ctx.s.id }, 'folk.well') ? 0.0003 * lvl(ctx) * divine(ctx) : 0),
  fire(ctx) {
    const { world, s } = ctx;
    const site = addSite(world, { kind: 'holy', x: s.x, y: s.y, name: `the Holy Well of ${s.name}`, civIds: [s.civId], data: { folk: 'well' } });
    addEffect(world, { kind: 'settlement', id: s.id }, { k: 'folk.well', until: world.time.day + 50 * Y, m: { health: 0.05, attract: 1.12 }, label: 'A holy well' });
    return write(ctx, 'folk_holy_well', {
      imp: 2, tags: ['miracle'], cat: 'religion',
      text: tell(ctx, 'folk_holy_well', WELL, { town: s.name, y: yearOfDay(world.time.day), far: farFrom(world, s) }),
      x: s.x, y: s.y, sid: s.id, civId: s.civId, ref: { k: 'site', id: site.id },
    });
  },
});

const STATUE = [
  'In the siege of {town} a statue of {deity} in the temple wept tears of blood, and the defenders took heart.',
  'During the siege of {town} the image of {deity} was seen to weep; the people of {town} swore never to yield.',
  'The besieged of {town} found the image of {deity} turned on its plinth to face the enemy camp, and fought the harder for it.',
];
registerEvent({
  id: 'folk_weeping_statue', scale: 'town', family: FOLK_FAMILY, cat: 'religion', imp: 1, minMyth: 1, cooldownYears: 60, tags: ['miracle'],
  weight: (ctx) => (ctx.s && ctx.s.siege && fin(ctx.s.buildings?.temple, 0) > 0 && ctx.s.dominantReligion != null && rested(ctx, 'folk_weeping_statue', 10) ? 0.015 * lvl(ctx) * divine(ctx) : 0),
  fire(ctx) {
    const { world, s } = ctx;
    const r = world.religions?.[s.dominantReligion];
    addEffect(world, { kind: 'settlement', id: s.id }, { k: 'folk.statue', until: world.time.day + 5 * Y, m: { happiness: 0.04, loyalty: 0.05 }, label: 'The statue that wept' });
    return write(ctx, 'folk_weeping_statue', {
      imp: 1, tags: ['miracle'], cat: 'religion',
      text: tell(ctx, 'folk_weeping_statue', STATUE, { town: s.name, deity: r?.deity || 'the god' }),
      x: s.x, y: s.y, sid: s.id, civId: s.civId, ref: { k: 'settlement', id: s.id },
    });
  },
});

// ---------------------------------------------------------------------------
// Town: fear — witch-hunts, haunted ruins, winter wolves, sea serpents, the Fair Folk

/** Share of the town's people who keep a faith that is not the town's own (pure). */
function minorityShare(s) {
  const rel = s.religion;
  if (!rel || s.dominantReligion == null) return 0;
  let m = 0;
  for (const k in rel) if (+k !== s.dominantReligion) m += fin(rel[k], 0);
  return m;
}
function minorityFaith(world, s) {
  let best = null, bv = 0;
  for (const k in s.religion || {}) {
    if (+k === s.dominantReligion) continue;
    const v = fin(s.religion[k], 0);
    if (v > bv) { bv = v; best = world.religions?.[+k] || null; }
  }
  return best;
}
const inCrisis = (s) => (s.disease && fin(s.disease.I, 0) > 0.02) || fin(s.famine, 0) >= 2;
const HUNT_PLAGUE = [
  'When the {plague} came to {town}, the townsfolk blamed the followers of {faith}; {n} were driven into the wilderness or burned in the market square.',
  'In {town} the {plague} was laid at the door of witches. Through the {season} of Year {y} the pyres burned, and {n} of {faith} died on them.',
  'The {plague} made {town} mad with fear: the houses of {faith} were marked with chalk, and {n} people were dragged from them before the magistrates could stop it.',
];
const HUNT_FAMINE = [
  'In the hungry year {y} the people of {town} hunted witches among the followers of {faith}; {n} were hanged before the harvest came.',
  'Famine made {town} cruel: the followers of {faith} were accused of cursing the fields, and {n} of them were stoned outside the walls.',
  'With the granaries of {town} empty in Year {y}, a preacher named the followers of {faith} as the cause; {n} died before the rains returned.',
];
registerEvent({
  id: 'folk_witch_hunt', scale: 'town', family: FOLK_FAMILY, cat: 'culture', imp: 2, minMyth: 1, cooldownYears: 40, tags: ['persecution'],
  weight: (ctx) => (ctx.s && ctx.s.tier >= 2 && inCrisis(ctx.s) && minorityShare(ctx.s) > 0.12 && rested(ctx, 'folk_witch_hunt', 8) ? 0.01 * lvl(ctx) : 0),
  fire(ctx) {
    const { world, s } = ctx;
    const minority = minorityFaith(world, s);
    const plague = s.disease ? world.plagues?.[s.disease.pid]?.name : null;
    const dead = damageSettlement(world, s, { pop: world.rng.float(0.003, 0.009), cause: 'witch-hunt' });
    addEffect(world, { kind: 'settlement', id: s.id }, { k: 'folk.witches', until: world.time.day + 2 * Y, m: { unrest: 0.08, happiness: -0.06 }, label: 'Witch-hunts' });
    const n = Math.max(3, Math.round(dead));
    return write(ctx, 'folk_witch_hunt', {
      imp: 2, tags: ['persecution'], cat: 'culture',
      text: tell(ctx, plague ? 'folk_witch_hunt.plague' : 'folk_witch_hunt', plague ? HUNT_PLAGUE : HUNT_FAMINE, { plague: plague || 'sickness', town: s.name, faith: minority?.name || 'the old gods', n: String(n), y: yearOfDay(world.time.day), season: seasonAt(world, s.y) }),
      x: s.x, y: s.y, sid: s.id, civId: s.civId, ref: { k: 'settlement', id: s.id },
    });
  },
});

/** Ruin sites not yet haunted (a derived cache keyed by the sites version). */
/** Unhaunted ruins in list order, bucketed in 8-tile cells (the town weight asks every check). */
const RC = 8;
function ruins(world) {
  const c = world.cache;
  const v = world.versions.sites;
  if (c.mythRuins && c.mythRuinsV === v) return c.mythRuins;
  const list = world.sites.filter((x) => x.kind === 'ruin' && !x.data?.haunted);
  const cw = Math.ceil(world.W / RC), grid = new Map();
  list.forEach((site, k) => {
    const key = Math.floor(site.y / RC) * cw + Math.floor(site.x / RC);
    let b = grid.get(key); if (!b) grid.set(key, (b = []));
    b.push(k);
  });
  c.mythRuins = { list, grid, cw };
  c.mythRuinsV = v;
  return c.mythRuins;
}
/** The first ruin (in list order) within six tiles that is not yet haunted. */
function ruinNear(world, s) {
  const { list, grid, cw } = ruins(world);
  if (!list.length) return null;
  const cx0 = Math.floor((s.x - 6) / RC), cx1 = Math.floor((s.x + 6) / RC);
  const cy0 = Math.floor((s.y - 6) / RC), cy1 = Math.floor((s.y + 6) / RC);
  let best = -1;
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
    if (cx < 0 || cy < 0 || cx >= cw) continue;
    const b = grid.get(cy * cw + cx);
    if (!b) continue;
    for (const k of b) {
      if (best >= 0 && k >= best) break;   // buckets hold list indices in order
      const site = list[k];
      if ((site.x - s.x) ** 2 + (site.y - s.y) ** 2 <= 36) { best = k; break; }
    }
  }
  return best >= 0 ? list[best] : null;
}
const HAUNT = [
  'Shepherds of {town} would not graze near the ruins of {ruin}; they said lights moved among the stones on {month} nights, and that {old} still kept their watch.',
  'Children of {town} dared one another to spend a night in the ruins of {ruin}. None who tried would say what they had heard there.',
  'A traveller who slept in the ruins of {ruin} came into {town} at dawn babbling of a feast of the dead; after that the road was moved to the far side of the hill.',
];
registerEvent({
  id: 'folk_haunted_ruin', scale: 'town', family: FOLK_FAMILY, cat: 'myth', imp: 1, minMyth: 1, cooldownYears: 80, tags: ['haunting'],
  weight: (ctx) => (ctx.s && rested(ctx, 'folk_haunted_ruin', 12) && ruinNear(ctx.world, ctx.s) ? 0.0025 * lvl(ctx) : 0),
  fire(ctx) {
    const { world, s } = ctx;
    const ruin = ruinNear(world, s);
    if (!ruin) return false;
    updateSite(world, ruin.id, { haunted: world.time.day });
    addEffect(world, { kind: 'settlement', id: s.id }, { k: 'folk.haunted', until: world.time.day + 30 * Y, m: { attract: 0.92, culture: 1.08 }, label: 'A haunted ruin nearby' });
    const old = ruin.data?.civId != null ? world.civs[ruin.data.civId] : null;
    return write(ctx, 'folk_haunted_ruin', {
      imp: ruin.fame > 2 || s.tier >= 2 ? 2 : 1, tags: ['haunting'],
      text: tell(ctx, 'folk_haunted_ruin', HAUNT, { town: s.name, ruin: ruin.name || 'the old town', month: monthNameOf(world.time.day), old: old ? peopleOf(old) : 'its dead' }),
      x: ruin.x, y: ruin.y, sid: s.id, civId: s.civId, ref: { k: 'site', id: ruin.id },
    });
  },
});

const COLD = new Set([BIOME.TAIGA, BIOME.TUNDRA, BIOME.COLD_DESERT, BIOME.ALPINE]);
const WOLVES = [
  'Wolves came into {town} in the hungry winter of Year {y}; the people swore one of them walked upright, and no one went out after dark until spring.',
  'In the long nights of Year {y} something took sheep from the folds of {town} and left tracks too large for any wolf. The town kept fires burning on the walls until the thaw.',
  'A white wolf was seen at the gate of {town} three nights running in the winter of Year {y}; the old women said it was a dead chieftain come for his due.',
];
registerEvent({
  id: 'folk_winter_wolves', scale: 'town', family: FOLK_FAMILY, cat: 'myth', imp: 1, minMyth: 1, cooldownYears: 40, tags: ['beast'],
  weight: (ctx) => (ctx.s && COLD.has(ctx.world.f.biome[ctx.s.i]) && isWinter(ctx.world, ctx.s) && rested(ctx, 'folk_winter_wolves', 15) ? 0.0016 * lvl(ctx) : 0),
  fire(ctx) {
    const { world, s } = ctx;
    addEffect(world, { kind: 'settlement', id: s.id }, { k: 'folk.wolves', until: world.time.day + Y, m: { unrest: 0.05 }, label: 'Wolves at the gates' });
    return write(ctx, 'folk_winter_wolves', {
      imp: 1, tags: ['beast'],
      text: tell(ctx, 'folk_winter_wolves', WOLVES, { town: s.name, y: yearOfDay(world.time.day) }),
      x: s.x, y: s.y, sid: s.id, civId: s.civId, ref: { k: 'settlement', id: s.id },
    });
  },
});

const SERPENT = [
  'Fishermen of {town} swore a serpent longer than three ships rose {sea}; for a season no boat would leave the harbour.',
  'A sailor came into {town} in Year {y} with his hair gone white, telling of coils in the water as wide as a road. The merchants of {town} did not sail that year.',
  'Nets came up torn to rags {sea} all through Year {y}; the fishermen of {town} blamed the old serpent and stayed ashore.',
];
registerEvent({
  id: 'folk_sea_serpent', scale: 'town', family: FOLK_FAMILY, cat: 'myth', imp: 1, minMyth: 1, maxMyth: 1, cooldownYears: 40, tags: ['beast'],
  weight: (ctx) => (ctx.s && ctx.s.coastal && ctx.s.tier >= 2 && rested(ctx, 'folk_sea_serpent', 20) ? 0.0007 * LEGEND : 0),
  fire(ctx) {
    const { world, s } = ctx;
    addEffect(world, { kind: 'settlement', id: s.id }, { k: 'folk.serpent', until: world.time.day + Y, m: { trade: 0.85, foodYield: 0.95 }, label: 'Talk of a sea serpent' });
    const sea = placePhrase(world, s.x, s.y);
    // a harbour that will not sail is news (the town is at least a village: weight above)
    return write(ctx, 'folk_sea_serpent', {
      imp: 2, tags: ['beast'],
      text: tell(ctx, 'folk_sea_serpent', SERPENT, { town: s.name, sea: sea && sea.startsWith('by ') ? 'off ' + sea.slice(3) : 'beyond the harbour mouth', y: yearOfDay(world.time.day) }),
      x: s.x, y: s.y, sid: s.id, civId: s.civId, ref: { k: 'settlement', id: s.id },
    });
  },
});

const WOODS = new Set([BIOME.TEMPERATE_FOREST, BIOME.TEMPERATE_RAINFOREST, BIOME.TAIGA]);
const FEY = [
  'Children of {town} who strayed into the toadstool rings of the wood came home with tales of the Fair Folk; the elders hung iron over every door.',
  'A boy of {town} vanished in the woods on Midsummer Eve of Year {y} and walked home seven years later, not a day older, speaking of a hall under the hill.',
  'Milk left out for the Good Neighbours at {town} was found drunk every morning of Year {y}; the harvest that autumn was the best in memory.',
  'A bride of {town} danced away into the wood on her wedding night in Year {y}. They still leave a lamp lit for her on the anniversary.',
];
registerEvent({
  id: 'folk_fair_folk', scale: 'town', family: FOLK_FAMILY, cat: 'myth', imp: 1, minMyth: 1, maxMyth: 1, cooldownYears: 60, tags: ['fey'],
  weight: (ctx) => (ctx.s && WOODS.has(ctx.world.f.biome[ctx.s.i]) && ctx.s.tier <= 3 && rested(ctx, 'folk_fair_folk', 25) ? 0.0006 * LEGEND : 0),
  fire(ctx) {
    const { world, s } = ctx;
    addEffect(world, { kind: 'settlement', id: s.id }, { k: 'folk.fey', until: world.time.day + 20 * Y, m: { culture: 1.05 }, label: 'Tales of the Fair Folk' });
    return write(ctx, 'folk_fair_folk', {
      imp: s.tier >= 2 ? 2 : 1, tags: ['fey'],
      text: tell(ctx, 'folk_fair_folk', FEY, { town: s.name, y: yearOfDay(world.time.day) }),
      x: s.x, y: s.y, sid: s.id, civId: s.civId, ref: { k: 'settlement', id: s.id },
    });
  },
});

// ---------------------------------------------------------------------------
// Prophecies and grudges: claims for the war machinery, and closing the loop

/** The name of a war to take back stolen relics (pure: hashed by the pair and the theft). */
function relicWarName(a, b, day) {
  const A = a.adjective || a.name, B = b.adjective || b.name;
  const forms = [
    'The War of the Stolen Relics', `The ${A} Relic War`, `The War of the ${B} Reliquary`, 'The War of the Holy Bones',
    `The War for the Relics of ${a.baseName || A}`, `The ${A}–${B} Relic War`, 'The War of the Plundered Shrines', `The Pilgrims' War of ${a.baseName || A}`,
  ];
  return forms[hash2i(a.id * 97 + b.id, Math.floor(day), 0x7e1c) % forms.length];
}

function folkCasus(world, a, b) {
  if (!(world.params?.mythLevel >= 1)) return null;
  const f = peekFolk(world);
  if (!f) return null;
  if (typeof a === 'number') a = world.civs[a];
  if (typeof b === 'number') b = world.civs[b];
  if (!a || !b) return null;
  let out = null;
  for (const p of f.prophecies) {
    if (p.civId !== a.id || p.done || world.time.day > p.until) continue;
    const s = world.settlements[p.sid];
    if (s && s.alive && s.civId === b.id) (out ||= []).push({ cb: 'prophecy', w: 1, name: `The War of the Prophecy of ${s.name}` });
  }
  const g = f.grudges[`${a.id}|${b.id}`];
  if (g != null && world.time.day - g < 40 * Y) (out ||= []).push({ cb: 'relic', w: 0.45, name: relicWarName(a, b, g) });
  return out;
}
registerProvider('casusBelli', 'myth-folk', folkCasus);

on('settlementTransferred', (world, s, oldCivId, newCivId) => {
  const f = peekFolk(world);
  if (!f || !f.prophecies.length || !(world.params?.mythLevel >= 1)) return;
  for (const p of f.prophecies) {
    if (p.done || p.sid !== s.id || p.civId !== newCivId || world.time.day > p.until) continue;
    p.done = world.time.day;
    const civ = world.civs[newCivId];
    const lines = [
      '{city} fell to {realm} in Year {y}, as the seers had foretold.',
      'And so the prophecy was fulfilled: in Year {y} the banners of {realm} were raised over {city}.',
    ];
    const k = hash2i(s.id, world.time.day, 77) % lines.length;
    record(world, {
      imp: 3, key: 'event.folk_prophecy.fulfilled', tags: ['folklore', 'prophecy'],
      text: fill(lines[k], { city: s.name, people: peopleOf(civ), y: yearOfDay(world.time.day), realm: theName(civ) }),
      x: s.x, y: s.y, sid: s.id, civId: newCivId, ref: { k: 'settlement', id: s.id }, cause: p.seq ?? null,
    });
    f.n = fin(f.n, 0) + 1;
  }
});

/** Yearly at mythLevel ≥ 1: prophecies whose time ran out are mocked, and old grudges forgotten. */
export function folkYearly(world) {
  const f = peekFolk(world);
  if (!f) return;
  const day = world.time.day;
  for (const p of f.prophecies) {
    if (p.done || p.failed || day <= p.until) continue;
    p.failed = day;
    const civ = world.civs[p.civId], s = world.settlements[p.sid];
    if (!civ || !s) continue;
    const lines = [
      'The years named by the seers of {realm} ran out, and {city} still stood; in {cap} the prophecy was quietly scraped from the wall.',
      'The prophecy against {city} came to nothing. The oracle of {cap} was turned out of the court, and children of {city} sang mocking songs about her.',
    ];
    const cap = capitalOf(world, civ);
    record(world, {
      imp: 1, key: 'event.folk_prophecy.failed', tags: ['folklore', 'prophecy'],
      text: fill(lines[hash2i(p.sid, day, 91) % lines.length], { realm: theName(civ), city: s.name, cap: cap ? cap.name : 'the capital' }),
      x: s.x, y: s.y, sid: s.id, civId: civ.id, ref: { k: 'settlement', id: s.id }, cause: p.seq ?? null,
    });
  }
  f.prophecies = f.prophecies.filter((p) => !(p.done || p.failed) || day - (p.done || p.failed) < 50 * Y);
  for (const k of Object.keys(f.grudges)) if (day - f.grudges[k] >= 40 * Y) delete f.grudges[k];
}

export const FOLK_IDS = ['folk_comet', 'folk_eclipse', 'folk_cursed_house', 'folk_prophecy', 'folk_saint', 'folk_relic_theft', 'folk_holy_well', 'folk_weeping_statue', 'folk_witch_hunt', 'folk_haunted_ruin', 'folk_winter_wolves', 'folk_sea_serpent', 'folk_fair_folk'];
/** True: this module has registered the Legendary deck (the genesis switch reads it). */
export const FOLKLORE_READY = true;
