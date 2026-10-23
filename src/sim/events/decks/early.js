// The early-age deck (Stone and Bronze Ages, era ≤ 1–2): the first centuries are the part
// every new player watches, so they get their own drama. Named great beasts roam each
// continent (sys.events.beasts: a 64-tile range sample, a population that follows the grazing
// and falls to hunting pressure) until the last of them is speared; herds are tamed, boats
// launched and wild grain first sown (tech grants through WP3); cattle raids and hunting
// feuds sour neighbours (opinion and grievance feed the revenge casus belli) while bride
// exchanges sweeten them; standing stones make a sacred site, and a shaman's vision can found
// the world's first faith (WP4 foundReligion). Every event leaves an effect, a trait or heat.

import { registerEvent } from '../../../core/events.js';
import { damageSettlement, addOpinion, rel, liveSettlements } from '../../../core/entities.js';
import { emitFx } from '../../../core/world.js';
import { BIOME, BIOMES, DAYS_PER_YEAR, WATER } from '../../../core/constants.js';
import { BEAST_KINDS, BEAST_BY_KEY } from '../data.js';
import { record, effect, heat, T, hasTech, canLearn, grantTechTo, foundFaith, evState } from '../engine.js';
import { SUBJ } from '../heat.js';
import { addTrait, hasTrait } from '../character.js';
import {
  pick, say, cap, peopleOf, PeopleOf, adjOf, rulerName, rulerShort, rulerHas, personName,
  placeWord, placePhrase, featureNear, seasonWord, countWord, riverAt, his, peopleCount,
} from '../prose.js';

const Y = DAYS_PER_YEAR;
const TF = [0.5, 1, 1.2, 1.2, 1.2, 1.2, 1.2];      // early events favour hamlets and villages
const anyKnows = (world, id) => world.civs.some((c) => c && hasTech(c, id));

// ---------------------------------------------------------------------------
// Great beasts

/** At genesis: 2–4 named herds of megafauna per continent. Idempotent. */
export function seedBeasts(world) {
  const st = evState(world);
  if (Array.isArray(st.beasts)) return;
  st.beasts = [];
  const { W, H, N, f } = world;
  const conts = (world.features || []).filter((ft) => ft && ft.kind === 'continent');
  if (!conts.length) return;
  // biome counts per landmass in one pass
  const lms = new Map();
  for (const ft of conts) {
    const j = Math.round(ft.y) * W + Math.round(ft.x);
    const lm = j >= 0 && j < N && f.landmass[j] >= 0 ? f.landmass[j] : ft.landmass;
    if (lm != null && lm >= 0 && !lms.has(lm)) lms.set(lm, { ft, counts: new Float64Array(BIOMES.length), tiles: 0 });
  }
  for (let i = 0; i < N; i++) {
    const e = lms.get(f.landmass[i]);
    if (!e) continue;
    e.counts[f.biome[i]]++; e.tiles++;
  }
  let id = 1;
  for (const [lm, e] of lms) {
    const fits = BEAST_KINDS.map((k) => {
      let n = 0;
      for (const b of k.biomes) n += e.counts[b];
      return [k, n];
    }).filter(([, n]) => n >= 40);
    if (!fits.length) continue;
    const want = Math.min(fits.length, e.tiles > 2500 ? 4 : e.tiles > 900 ? 3 : 2);
    const chosen = [];
    while (chosen.length < want && fits.length) {
      let tot = 0;
      for (const x of fits) tot += Math.sqrt(x[1]);
      let r = world.rng.next() * tot, k = 0;
      for (; k < fits.length - 1; k++) { r -= Math.sqrt(fits[k][1]); if (r < 0) break; }
      chosen.push(fits[k][0]);
      fits.splice(k, 1);
    }
    for (const kind of chosen) {
      const biomes = new Set(kind.biomes);
      // a centre: a random tile of the right country on this landmass
      let ci = -1;
      for (let t = 0; t < 400 && ci < 0; t++) {
        const i = Math.floor(world.rng.next() * N);
        if (f.landmass[i] === lm && biomes.has(f.biome[i])) ci = i;
      }
      if (ci < 0) continue;
      const cx = ci % W, cy = (ci / W) | 0;
      const cand = [];
      const R = 14;
      for (let y = Math.max(0, cy - R); y <= Math.min(H - 1, cy + R); y++) for (let x = Math.max(0, cx - R); x <= Math.min(W - 1, cx + R); x++) {
        const i = y * W + x;
        if (f.landmass[i] === lm && biomes.has(f.biome[i]) && (x - cx) ** 2 + (y - cy) ** 2 <= R * R) cand.push(i);
      }
      if (cand.length < 12) continue;
      const step = cand.length / Math.min(64, cand.length);
      const range = [];
      for (let k = 0; k < Math.min(64, cand.length); k++) range.push(cand[Math.floor(k * step)]);
      let x0 = W, y0 = H, x1 = 0, y1 = 0, h = 0;
      for (const i of range) {
        const x = i % W, y = (i / W) | 0;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        h += kind.pred ? f.pred[i] : f.herb[i];
      }
      const place = featureNear(world, 'range', cx, cy, 14) || featureNear(world, 'forest', cx, cy, 14) || featureNear(world, 'desert', cx, cy, 14)
        || featureNear(world, 'lake', cx, cy, 12) || featureNear(world, 'river', cx, cy, 10) || e.ft.name;
      st.beasts.push({
        id: id++, kind: kind.key, name: `the ${kind.name} of ${place}`, lm, cx, cy, x0, y0, x1, y1,
        r: range, k0: Math.max(0.005, h / range.length), pop: 1, ext: null, hunts: 0,
      });
    }
  }
}

const living = (b) => b && b.ext == null;
/** A living beast herd whose range (padded) holds (x, y), or null. */
function beastNear(world, x, y, pad = 4, minPop = 0) {
  const bs = evState(world).beasts;
  if (!bs) return null;
  let best = null;
  for (const b of bs) {
    if (!living(b) || b.pop < minPop) continue;
    if (x < b.x0 - pad || x > b.x1 + pad || y < b.y0 - pad || y > b.y1 + pad) continue;
    if (!best || b.pop > best.pop) best = b;
  }
  return best;
}

/** Yearly: grazing sets each herd's carrying capacity; hunters (and their era) wear it down. */
export function beastsYear(world) {
  const bs = evState(world).beasts;
  if (!bs || !bs.length) return;
  const { f } = world;
  for (const b of bs) {
    if (!living(b)) continue;
    const kind = BEAST_BY_KEY[b.kind];
    let h = 0, ppl = 0;
    for (const i of b.r) {
      h += kind && kind.pred ? f.pred[i] : f.herb[i];
      const d = f.popDensity[i];
      if (d > 0) {
        const o = f.owner[i];
        const era = o >= 0 && world.civs[o] ? world.civs[o].tech?.era || 0 : 0;
        ppl += d * (1 + 0.7 * era) + (f.farm[i] || 0) * 20;
      }
    }
    const n = b.r.length || 1;
    const K = Math.max(0.15, Math.min(1.3, h / n / b.k0));
    const hunt = 0.06 * (ppl / n) / 7;
    const p = b.pop + 0.06 * b.pop * (1 - b.pop / K) - hunt * b.pop;
    b.pop = Math.round(Math.max(0, Math.min(1.5, p)) * 1e4) / 1e4;
  }
}

export const beastsOf = (world) => evState(world).beasts || [];

// ---------------------------------------------------------------------------
// Town defs

const HERDS = {
  [BIOME.STEPPE]: 'the wild aurochs', [BIOME.SAVANNA]: 'the wild cattle', [BIOME.SHRUBLAND]: 'wild goats and sheep',
  [BIOME.TEMPERATE_FOREST]: 'the wild boar', [BIOME.COLD_DESERT]: 'the wild camels', [BIOME.TUNDRA]: 'the reindeer', [BIOME.TAIGA]: 'the reindeer',
};
const PREDS = (b) => (b === BIOME.SAVANNA || b === BIOME.SHRUBLAND ? 'lions' : b === BIOME.TROPICAL_FOREST || b === BIOME.RAINFOREST ? 'leopards'
  : b === BIOME.HOT_DESERT || b === BIOME.COLD_DESERT ? 'hyenas' : b === BIOME.ALPINE ? 'snow leopards' : 'wolves');

registerEvent({
  id: 'town.great_hunt', scale: 'town', minTier: 1, family: 'wild', cat: 'nature', imp: 2, maxEra: 1, cooldownYears: 15,
  label: 'Great hunt', icon: 'hunt', hint: ['food +10% and a feast for 3 years', 'the great herd thins'],
  weight(ctx) {
    const s = ctx.s;
    if (s.tier < 1) return 0;
    const b = beastNear(ctx.world, s.x, s.y, 4, 0.25);
    return b ? 0.0035 * b.pop * TF[s.tier] * (1 + ctx.heat('hunger')) : 0;
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const b = beastNear(world, s.x, s.y, 4, 0.2);
    if (!b) return false;
    const kind = BEAST_BY_KEY[b.kind];
    const hunter = personName(world, civ);
    b.pop = Math.max(0, Math.round((b.pop - 0.06) * 1e4) / 1e4);
    b.hunts = (b.hunts || 0) + 1;
    const v = { town: s.name, hunter, one: kind.one, many: kind.name.toLowerCase(), herd: b.name, place: placePhrase(world, s.x, s.y), season: seasonWord(world, s.y), people: peopleOf(civ) };
    const text = kind.pred
      ? say(world, [
        'A {one} that had taken children from the herds of {town} was tracked for nine days and killed by {hunter}, who wore its pelt for the rest of {his} life.',
        'The hunters of {town} cornered the last great {one} of the valley in its den; {hunter} went in with a torch and came out with its skull.',
      ], { ...v, his: world.rng.chance(0.5) ? 'his' : 'her' })
      : say(world, [
        'The hunters of {town} drove a herd of {many} over the cliffs {place}; {hunter} carried home the great bull’s tusks, and the village feasted through the {season}.',
        '{hunter} of {town} speared the old {one} that had led {herd} for twenty winters; its bones were set above the chieftain’s door.',
        'All {people} of {town} turned out for the great hunt of {herd}; there was meat enough for the whole {season}.',
      ], v);
    record(ctx, { text });
    effect(ctx, T.s(s), 'hunt', { foodYield: 1.1, happiness: 0.04 }, 3, 'Great hunt');
    heat(ctx, 'feast', 0.5);
    return true;
  },
});

function domesticable(world, s, civ) {
  if (!civ) return null;
  const { f } = world;
  const b = f.biome[s.i];
  if (!hasTech(civ, 'husbandry') && canLearn(civ, 'husbandry') && HERDS[b] && f.herb[s.i] >= 0.18) return 'husbandry';
  if (hasTech(civ, 'husbandry') && !hasTech(civ, 'horseback') && canLearn(civ, 'horseback')) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = s.x + dx, y = s.y + dy;
      if (x >= 0 && y >= 0 && x < world.W && y < world.H && f.resource[y * world.W + x] === 7) return 'horseback';
    }
  }
  return null;
}

registerEvent({
  id: 'town.domestication', scale: 'town', minTier: 1, family: 'dawn', cat: 'tech', imp: 2, maxEra: 1, cooldownYears: 30,
  label: 'Herds tamed', icon: 'herd', hint: ['learns Animal Husbandry (or Horseback Riding)', 'food +8% for ever'],
  weight(ctx) {
    const { world, s, civ } = ctx;
    if (s.tier < 1) return 0;
    const t = domesticable(world, s, civ);
    if (!t) return 0;
    return t === 'horseback' ? 0.003 : 0.004 * Math.min(2, world.f.herb[s.i] / 0.25) * TF[s.tier];
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const t = domesticable(world, s, civ);
    if (!t) return false;
    const first = !anyKnows(world, t);
    if (!grantTechTo(world, civ, t)) return false;
    const place = placePhrase(world, s.x, s.y);
    let text;
    if (t === 'horseback') {
      text = say(world, [
        'The riders of {town} were the first {who} to break the wild horses that ran {place}; {people} would never walk to war again.',
        'A girl of {town} named {name} gentled a wild mare with salt and patience; within a generation {people} rode everywhere.',
      ], { town: s.name, place, people: peopleOf(civ), name: personName(world, civ), who: first ? 'in all the world' : 'of their people' });
      addTrait(world, s, 'horse-tamers');
    } else {
      const herd = HERDS[world.f.biome[s.i]] || 'the wild cattle';
      text = say(world, [
        'At {town}, {people} penned {herd} and bred them tame; within a generation every hearth {place} kept a herd.',
        'The herders of {town} {learned} to keep {herd} in folds instead of hunting them, and the hungry winters grew fewer.',
      ], { town: s.name, people: peopleOf(civ), herd, place, learned: first ? 'were the first in the world to learn' : 'learned' });
      addTrait(world, s, 'herders');
    }
    record(ctx, { text, imp: first ? 3 : 2 });
    effect(ctx, T.s(s), 'tamed', { foodYield: 1.05 }, 30, 'Tame herds');
    emitFx(world, { type: 'discovery', x: s.x, y: s.y, civId: civ.id });
    return true;
  },
});

function boatTech(world, s, civ) {
  if (!civ) return null;
  const { f } = world;
  const wet = f.coast[s.i] || f.river[s.i] >= 2;
  if (!wet) return null;
  if (!hasTech(civ, 'fishing') && canLearn(civ, 'fishing')) return 'fishing';
  if (f.coast[s.i] && !hasTech(civ, 'sailing') && canLearn(civ, 'sailing')) return 'sailing';
  return null;
}
registerEvent({
  id: 'town.first_boats', scale: 'town', family: 'dawn', cat: 'tech', imp: 2, maxEra: 1, cooldownYears: 30,
  label: 'First boats', icon: 'ship', hint: ['learns Fishing (or Sailing)', 'boatwrights: food and trade for ever'],
  weight(ctx) {
    const t = boatTech(ctx.world, ctx.s, ctx.civ);
    return t ? (t === 'fishing' ? 0.004 : 0.0025 * (1 + ctx.heatCiv('sea'))) * TF[ctx.s.tier] : 0;
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const t = boatTech(world, s, civ);
    if (!t) return false;
    const first = !anyKnows(world, t);
    if (!grantTechTo(world, civ, t)) return false;
    const water = world.f.coast[s.i] ? featureNear(world, 'sea', s.x, s.y, 50) || 'the sea' : riverAt(world, s.x, s.y) || 'the river';
    const text = t === 'fishing'
      ? say(world, [
        'The fishers of {town} hollowed the first dugouts from great trunks and paddled out onto {water}; that winter there was fish in every pot.',
        'At {town}, {name} knotted the first net of twisted bark and cast it into {water}{first}.',
      ], { town: s.name, water, name: personName(world, civ), first: first ? ', the first net the world had seen' : '' })
      : say(world, [
        'A boatwright of {town} stretched a hide sail between two poles, and {people} rode the wind across {water} for the first time.',
        'From {town} the first sailed boats of {people} beat out across {water}, and the far headlands were far no longer.',
      ], { town: s.name, water, people: peopleOf(civ) });
    record(ctx, { text, imp: first ? 3 : 2 });
    addTrait(world, s, 'boatwrights');
    heat(ctx, 'sea', 0.5, SUBJ.realm(civ.id));
    return true;
  },
});

registerEvent({
  id: 'town.wild_grain', scale: 'town', family: 'dawn', cat: 'tech', imp: 2, maxEra: 0, cooldownYears: 30,
  label: 'Wild grain sown', icon: 'farm', hint: ['learns Agriculture', 'first fields: food +8% for ever'],
  weight(ctx) {
    const { world, s, civ } = ctx;
    if (!civ || hasTech(civ, 'agriculture') || !canLearn(civ, 'agriculture')) return 0;
    const farm = BIOMES[world.f.biome[s.i]]?.farm || 0;
    return farm >= 0.55 ? 0.0025 * farm * TF[s.tier] : 0;
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const first = !anyKnows(world, 'agriculture');
    if (!grantTechTo(world, civ, 'agriculture')) return false;
    record(ctx, {
      text: say(world, [
        'The women of {town} noticed that the wild grasses grew again where their seeds were spilled {place}; {people} became sowers and reapers.',
        'At {town} {name} scratched a field with a digging stick and sowed it with gathered seed; the next year the whole village did the same.',
        '{People} of {town} cleared the first fields {place} and sowed wild barley, and hunger loosened its grip.',
      ], { town: s.name, place: placePhrase(world, s.x, s.y), people: peopleOf(civ), People: PeopleOf(civ), name: personName(world, civ) }),
      imp: first ? 3 : 2,
    });
    addTrait(world, s, 'first fields');
    return true;
  },
});

/** Hills within two tiles (memoised for the current check when a context is given). */
const hillsNear = (world, s, ctx = null) => {
  if (ctx && ctx._hills >= 0) return ctx._hills === 1;
  const v = hillScan(world, s);
  if (ctx) ctx._hills = v ? 1 : 0;
  return v;
};
const hillScan = (world, s) => {
  const { W, H, f } = world;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x >= 0 && y >= 0 && x < W && y < H && f.water[y * W + x] === WATER.LAND && f.elevation[y * W + x] >= 0.62) return true;
  }
  return false;
};

registerEvent({
  id: 'town.standing_stones', scale: 'town', minTier: 1, family: 'sacred', cat: 'culture', imp: 2, maxEra: 2, cooldownYears: 200,
  label: 'Standing stones', icon: 'stones', hint: ['sacred site: culture +12% for ever', 'the realm’s legitimacy rises', 'seers dream there'],
  weight(ctx) {
    const { world, s, civ } = ctx;
    if (s.tier < 1 || !civ || hasTrait(s, 'sacred site') || (s.traits && s.traits.length >= 3) || ctx.heatCiv('stones') >= 1) return 0;
    // a people raises at most three great stone monuments
    const rm = world.sys.events.rm && world.sys.events.rm[civ.id];
    if (rm && rm.stones >= 3) return 0;
    const rel0 = Number(world.params.religiosity);
    const piety = (Number.isFinite(rel0) ? rel0 : 1) * (0.5 + (civ.traits?.religiosity ?? 0.5));
    return 0.0015 * piety * TF[s.tier] * (hillsNear(world, s, ctx) ? 1.3 : 1) * Math.max(0, 1 - ctx.heatCiv('stones'));
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const word = placeWord(world, civ);
    const n = world.rng.int(7, 12);
    const kind = pick(world, ['ring', 'ring', 'barrow', 'avenue']);
    const name = kind === 'ring' ? pick(world, [`the Ring of ${word}`, `the Sun Circle of ${word}`, `the ${cap(countWord(n))} Maidens`])
      : kind === 'barrow' ? `the Long Barrow of ${word}` : `the Stones of ${word}`;
    const what = kind === 'ring' ? `a ring of ${countWord(n)} grey stones set to catch the midsummer sunrise`
      : kind === 'barrow' ? 'a great mound of earth and stone where the chiefs were laid to rest'
        : 'an avenue of standing stones a mile long, climbing to the hilltop';
    const first = !(world.sys.events.counts['town.standing_stones'] > 0);
    record(ctx, {
      text: say(world, [
        'On the hill above {town} {people} raised {name}, {what}; the dead were carried there to be honoured.',
        'It took {people} of {town} three generations to drag the stones of {name} from the far quarry; when the last was raised, the whole valley danced.',
        '{Name} rose beside {town}, {what}, and there {ruler} was proclaimed before the people.',
      ], { town: s.name, people: peopleOf(civ), name, Name: cap(name), what, ruler: rulerName(civ.ruler) }) + (first ? ' Nothing like it had been raised in the world before.' : ''),
      imp: first ? 3 : 2,
    });
    addTrait(world, s, 'sacred site', ctx.entry ? ctx.entry.seq : null);
    effect(ctx, T.c(civ), 'stones', { stability: 0.02 }, 50, name);
    heat(ctx, 'vision', 0.6);
    heat(ctx, 'stones', 1, SUBJ.realm(civ.id));
    const rm = ((world.sys.events.rm ||= {})[civ.id] ||= {});
    rm.stones = (rm.stones || 0) + 1;
    return true;
  },
});

const DOCTRINE_POOL = ['spirits', 'spirits', 'ancestors', 'mother', 'moon', 'sun', 'storm'];
registerEvent({
  id: 'town.shaman_vision', scale: 'town', family: 'sacred', cat: 'religion', imp: 3, maxEra: 2, cooldownYears: 40, chain: ['vision'],
  label: 'Shaman’s vision', icon: 'faith', hint: ['may found a new faith', 'culture and contentment'],
  weight(ctx) {
    const { world, s, civ } = ctx;
    if (!civ || s.dominantReligion != null || world.time.day < 8 * Y) return 0;
    const rel0 = Number(world.params.religiosity);
    let w = 0.0008 * (Number.isFinite(rel0) ? rel0 : 1) * (0.5 + (civ.traits?.religiosity ?? 0.5)) * TF[s.tier];
    if (hasTrait(s, 'sacred site')) w *= 3;
    w *= 1 + ctx.heat('vision') + ctx.heatLand('omen');
    let faiths = 0;
    for (const r of world.religions) if (r && r.alive !== false) faiths++;
    if (!faiths) w *= 4;
    else w /= 1 + 1.5 * faiths;
    if (civ.stateReligion != null) w *= 0.3;
    return w;
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const shaman = personName(world, civ);
    const firstFaith = !world.religions.some((r) => r);
    const r = foundFaith(world, s, { doctrine: pick(world, DOCTRINE_POOL), prophet: shaman });
    const where = hasTrait(s, 'sacred site') ? 'among the standing stones' : pick(world, ['beside a smoking fire', 'in a cave above the river', 'under a lightning-struck oak', 'at the edge of the marsh']);
    if (r) {
      record(ctx, {
        text: say(world, [
          'In a fever-dream {where} at {town}, the shaman {shaman} saw the spirits of sky and water; those who listened became {faith}.',
          '{shaman}, a shaman of {town}, came back from three days lost {place} speaking with the voice of {deity}, and {faith} was born.',
          'The visions of {shaman} of {town} spread from hearth to hearth among {people}: so began {faith}.',
        ], { where, town: s.name, shaman, faith: r.name, deity: r.deity || 'a god', place: placePhrase(world, s.x, s.y), people: peopleOf(civ) })
          + (firstFaith ? ' It was the first faith of the world.' : ''),
        imp: firstFaith ? 4 : 3, cat: 'religion', ref: { k: 'religion', id: r.id },
      });
      heat(ctx, 'faith', 0.5, SUBJ.realm(civ.id));
    } else {
      record(ctx, {
        text: say(world, [
          'The shaman {shaman} of {town} danced {where} until {he} fell, and woke with new songs for the spirits; the whole village learned them.',
          'A cult of the {thing} grew up at {town} around the visions of {shaman}.',
        ], { shaman, town: s.name, where, he: world.rng.chance(0.5) ? 'he' : 'she', thing: pick(world, ['white stag', 'river mother', 'thunder bird', 'sleeping bear']) }),
        imp: 2,
      });
      effect(ctx, T.s(s), 'cult', { culture: 1.08, happiness: 0.03 }, 80, 'Folk cult');
    }
    effect(ctx, T.s(s), 'vision', { happiness: 0.03 }, 20, 'Visions');
    return true;
  },
});

registerEvent({
  id: 'town.painted_caves', scale: 'town', minTier: 1, family: 'dawn', cat: 'culture', imp: 2, maxEra: 1, cooldownYears: 100,
  label: 'Painted caves', icon: 'culture', hint: ['painted caves: culture +10% for ever'],
  weight(ctx) {
    const { world, s } = ctx;
    if (s.tier < 1 || hasTrait(s, 'painted caves') || (s.traits && s.traits.length >= 3) || !hillsNear(world, s, ctx)) return 0;
    return 0.0018 * TF[s.tier];
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const b = beastNear(world, s.x, s.y, 8, 0);
    const subj = b ? `herds of ${BEAST_BY_KEY[b.kind].name.toLowerCase()}` : pick(world, ['galloping horses and red handprints', 'hunters under the stars of the winter sky', 'a great bull with a hundred spears in it']);
    const many = (world.sys.events.counts['town.painted_caves'] || 0) >= 3;
    record(ctx, {
      text: say(world, [
        'In the caves above {town}, painters of {people} covered the walls with {subj} by torchlight; their children’s children came to see them.',
        'Someone at {town} found how to grind ochre and charcoal into paint, and the cave behind the village filled with {subj}.',
      ], { town: s.name, people: peopleOf(civ), subj }),
      imp: many ? 1 : 2,
    });
    addTrait(world, s, 'painted caves');
    return true;
  },
});

registerEvent({
  id: 'town.wolf_winter', scale: 'town', maxTier: 2, family: 'wild', cat: 'nature', imp: 2, maxEra: 2, cooldownYears: 20,
  label: 'Beasts in the fold', icon: 'wolf', hint: ['a few deaths and lost flocks', 'food −6% for 2 years'],
  weight(ctx) {
    const { world, s } = ctx;
    if (s.tier > 2) return 0;
    const p = world.f.pred[s.i];
    const winter = seasonWord(world, s.y) === 'winter';
    if (p < 0.015 || (!winter && p < 0.035)) return 0;
    return 0.0007 * Math.min(2.5, p / 0.025) * (winter ? 1.5 : 1);
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const preds = PREDS(world.f.biome[s.i]);
    const dead = damageSettlement(world, s, { pop: Math.min(world.rng.float(0.008, 0.02), world.rng.int(2, 9) / Math.max(1, s.population)), food: 0.08, cause: 'beasts' });
    const n = Math.max(2, Math.round(dead));
    record(ctx, {
      text: say(world, [
        'In the hungry {season} of Year {y}, {preds} came down {place} and took {n} of the people of {town} and half its flocks.',
        'Packs of {preds} haunted the folds of {town} all {season}; {n} herders were killed before {ruler} led the men out with fire and spears.',
        'The {preds} grew so bold that {season} that they took a child from the doorway of a hut in {town}; the village kept fires burning every night until the thaw.',
        'Half the flocks of {town} were lost to {preds} in Year {y}, and {n} shepherds with them; the hides of the pack leaders were nailed over the gate.',
      ], { season: seasonWord(world, s.y), y: Math.floor(world.time.day / Y), preds, place: placePhrase(world, s.x, s.y), n: countWord(n), town: s.name, ruler: civ ? rulerShort(civ.ruler) : 'the chief' }),
    });
    effect(ctx, T.s(s), 'wolves', { foodYield: 0.94 }, 2, 'Flocks lost');
    heat(ctx, 'fear', 0.5);
    return true;
  },
});


// --- more of village life: forts, goods, quarrels, hearth fires, the first calendars -------

registerEvent({
  id: 'town.hillfort', scale: 'town', minTier: 1, family: 'works', cat: 'culture', imp: 2, maxEra: 1, cooldownYears: 150, chain: ['feud', 'fear'],
  label: 'Hillfort', icon: 'walls', hint: ['ditches and a palisade: defence +0.15 for two centuries'],
  weight(ctx) {
    const { world, s, civ } = ctx;
    if (s.tier < 1 || !civ) return 0;
    const threat = 1 + ctx.heatCiv('feud') + ctx.heat('fear') + (civ.warWeariness > 0 ? 0.5 : 0);
    return 0.0018 * TF[s.tier] * (hillsNear(world, s, ctx) ? 1.5 : 1) * threat;
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const name = pick(world, [`the Dyke of ${placeWord(world, civ)}`, `the Ring-fort of ${s.name}`, `the Fort of ${placeWord(world, civ)}`]);
    record(ctx, { text: say(world, [
      'The people of {town} dug a ring of ditches and a timber palisade on the hill above their fields; in bad years the whole valley could shelter inside {name}.',
      'Fearing raiders, {ruler} set the men of {town} to raising {name}: three banks of earth, a gate of oak and a well that never ran dry.',
      'Every family of {town} owed ten days’ digging a year until {name} was finished; its banks still showed a thousand years later.',
      'After a bad raid the elders of {town} moved the granary inside a stockade on the bluff, and called it {name}.',
    ], { town: s.name, name, ruler: rulerName(civ.ruler) }) });
    effect(ctx, T.s(s), 'hillfort', { defense: 0.15 }, 200, name);
    return true;
  },
});

const GOODS = { 9: 'salt', 10: 'furs', 4: 'river gold', 5: 'bright stones', 1: 'green copper', 2: 'tin', 8: 'spices', 7: 'horses', 6: 'white stone' };
function goodsAt(world, s) {
  const { W, H, f } = world;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = s.x + dx, y = s.y + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const g = GOODS[f.resource[y * W + x]];
    if (g) return g;
  }
  if (f.coast[s.i]) return 'shells and dried fish';
  if (f.elevation[s.i] >= 0.6) return 'flint';
  return null;
}
registerEvent({
  id: 'town.trade_goods', scale: 'town', minTier: 1, family: 'fortune', cat: 'trade', imp: 2, maxEra: 1, cooldownYears: 50,
  label: 'Traders come', icon: 'trade', hint: ['trade +12% and contentment for 15 years'],
  weight(ctx) {
    const { world, s } = ctx;
    if (s.tier < 1) return 0;
    return goodsAt(world, s) ? 0.0025 * TF[s.tier] : 0;
  },
  fire(ctx) {
    const { world, s } = ctx;
    const g = goodsAt(world, s);
    if (!g) return false;
    const from = pick(world, ['over the mountains', 'from the far coast', 'down the river', 'across the grass sea', 'from beyond the forest']);
    record(ctx, { text: say(world, [
      'Traders came {from} for the {goods} of {town}, bringing {pay}; the village grew fat on the bargain.',
      'Word of the {goods} of {town} spread {from}, and every summer strangers camped by its spring to barter {pay} for it.',
      'The {goods} of {town} went {from} from hand to hand, and {pay} came back the same way.',
      'A trader called {name} came {from} with {pay} and went home with the {goods} of {town}; the next year he brought his brothers.',
    ], { from, goods: g, town: s.name, name: personName(world, ctx.civ), pay: pick(world, ['amber and obsidian', 'polished axes', 'dyed cloth and beads', 'copper rings', 'salt and honey', 'seashell necklaces']) }) });
    effect(ctx, T.s(s), 'goods', { trade: 1.12, happiness: 0.02 }, 15, `The ${g} trade`);
    return true;
  },
});

const QUARRELS = ['a stolen ox', 'a broken betrothal', 'the best grazing by the river', 'the bones of a murdered man', 'who should be chief after the old chief', 'a witch’s curse'];
registerEvent({
  id: 'town.clan_quarrel', scale: 'town', minTier: 1, family: 'unrest', cat: 'civ', imp: 2, maxEra: 1, cooldownYears: 30,
  label: 'Clan quarrel', icon: 'riot', hint: ['unrest +0.1, loyalty −0.05 for 5 years', 'a few deaths'],
  weight(ctx) {
    const s = ctx.s;
    if (s.tier < 1) return 0;
    return 0.0019 * TF[s.tier] * (1 + 2 * (s.unrest || 0)) * (1 + ctx.heat('hunger'));
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const a = placeWord(world, civ), b = placeWord(world, civ);
    damageSettlement(world, s, { pop: Math.min(0.004, 4 / Math.max(1, s.population)), cause: 'feud' });
    record(ctx, { text: say(world, [
      'The {a} and {b} families of {town} fell out over {why}; blood was shed, and for a generation they would not sit at the same fire.',
      'A quarrel over {why} split {town} into two camps; {ruler} came to judge it, and neither side forgave the judgement.',
      'In {town} the sons of {a} killed a son of {b} over {why}; the blood-price was paid in cattle, but the feud outlived everyone who began it.',
      'Half the families of {town} would not dance at the {season} feast because of {why}, and the elders could not make peace between them.',
    ], { a, b, town: s.name, why: pick(world, QUARRELS), ruler: rulerName(civ.ruler), season: seasonWord(world, s.y) }) });
    effect(ctx, T.s(s), 'quarrel', { unrest: 0.1, loyalty: -0.05 }, 5, 'Clan quarrel');
    heat(ctx, 'unrest', 0.3);
    return true;
  },
});

registerEvent({
  id: 'town.hearth_fire', scale: 'town', minTier: 1, maxTier: 2, family: 'fire', cat: 'disaster', imp: 2, maxEra: 1, cooldownYears: 25,
  label: 'Longhouse fire', icon: 'fire', hint: ['the winter stores burn: food −30%', 'production −8% for 3 years'],
  weight(ctx) {
    const { world, s } = ctx;
    if (s.tier < 1 || s.tier > 2) return 0;
    const wood = 0.4 + 0.6 * (BIOMES[world.f.biome[s.i]]?.wood || 0);
    return 0.0018 * wood * (seasonWord(world, s.y) === 'winter' ? 1.6 : 1);
  },
  fire(ctx) {
    const { world, s } = ctx;
    const dead = damageSettlement(world, s, { pop: Math.min(0.01, world.rng.int(2, 12) / Math.max(1, s.population)), food: 0.3, cause: 'fire' });
    record(ctx, { text: say(world, [
      'In the dead of {season} the great longhouse of {town} caught fire; the stores burned with it, and {n} died in the smoke.',
      'Sparks from a hearth set the thatch of {town} alight one windy night; by dawn half the village was ash, and {n} were dead.',
      'Lightning struck the granary of {town} at the end of {season}; the people saved their children and lost their seed corn.',
      'A cooking fire got loose among the reed huts of {town}; {n} died, and the rest wintered in caves {place}.',
    ], { season: seasonWord(world, s.y), town: s.name, n: peopleCount(world, Math.max(2, dead)), place: placePhrase(world, s.x, s.y) }) });
    if (s.alive) effect(ctx, T.s(s), 'hearthfire', { production: 0.92 }, 3, 'Rebuilding');
    heat(ctx, 'rebuild', 0.4);
    return true;
  },
});

// Old lore: each realm learns each of these once, in one of its villages.
const LORES = [
  { key: 'calendar', label: 'the first calendar', m: { research: 1.1 }, civ: { research: 0.03 }, ok: () => true, tpl: [
    'The elders of {town} marked the midwinter sunrise with a notched pole and counted the days between; {people} had their first calendar{first}.',
    'A star-watcher of {town} named {name} learned to tell the planting time from the rising of the Seven Sisters, and taught it to {people}{first}.',
  ] },
  { key: 'herbs', label: 'herb lore', m: { health: 0.04 }, civ: { health: 0.02 }, ok: () => true, tpl: [
    'The wise-women of {town} learned which roots eased a fever and which moss closed a wound; children there lived who would have died elsewhere{first}.',
    '{name} of {town} kept a garden of healing herbs and taught their uses to anyone who brought a gift; it was the beginning of {people}’ healing craft{first}.',
  ] },
  { key: 'tally', label: 'tally marks', m: { research: 1.08 }, civ: { taxEfficiency: 0.04 }, ok: (civ) => !hasTech(civ, 'writing'), tpl: [
    'The headmen of {town} began to keep count of herds and harvests with notches on sticks and knots on cords; nothing owed was forgotten again{first}.',
    'At {town}, {name} pressed marks into clay to count the jars in the storehouse; the marks spread to every village of {people}{first}.',
  ] },
  { key: 'smithing', label: 'the smith’s secret', m: { production: 1.06 }, civ: { production: 0.03 }, ok: (civ) => hasTech(civ, 'bronze') || hasTech(civ, 'toolmaking'), tpl: [
    'A smith of {town} found that a blade quenched in cold water came out harder; he told only his sons, and {town} grew famous for its edges{first}.',
    'The flint-knappers of {town} learned to work a finer edge by pressing rather than striking, and their blades were traded far and wide{first}.',
  ] },
];
function loreFor(world, civ) {
  const known = ((world.sys.events.rm ||= {})[civ.id] ||= {}).lore || [];
  return LORES.filter((l) => !known.includes(l.key) && l.ok(civ));
}
registerEvent({
  id: 'town.old_lore', scale: 'town', minTier: 1, family: 'learning', cat: 'tech', imp: 2, maxEra: 2, cooldownYears: 60,
  label: 'Old lore', icon: 'stars', hint: ['a calendar, herb lore, tally marks or a smith’s secret', 'research, health or production for two centuries'],
  weight(ctx) {
    const { world, s, civ } = ctx;
    if (s.tier < 1 || !civ) return 0;
    const rm = world.sys.events.rm && world.sys.events.rm[civ.id];
    if (rm && rm.lore && rm.lore.length >= LORES.length) return 0;
    return 0.0014 * TF[s.tier] * (hasTrait(s, 'sacred site') ? 1.8 : 1) * (1 + ctx.heatCiv('learning'));
  },
  fire(ctx) {
    const { world, s, civ } = ctx;
    const pool = loreFor(world, civ);
    if (!pool.length) return false;
    const lore = pick(world, pool);
    const rm = (world.sys.events.rm ||= {})[civ.id] ||= {};
    (rm.lore ||= []).push(lore.key);
    const seen = (world.sys.events.pend.lore ||= {});
    seen[lore.key] = (seen[lore.key] || 0) + 1;
    const first = seen[lore.key] === 1;
    record(ctx, { imp: first ? 3 : 2, tags: [lore.key], text: say(world, lore.tpl, {
      town: s.name, people: peopleOf(civ), name: personName(world, civ), first: first ? ', the first people in the world to do so' : '',
    }) });
    effect(ctx, T.s(s), 'lore:' + lore.key, lore.m, 200, cap(lore.label));
    effect(ctx, T.c(civ), 'lore:' + lore.key, lore.civ, 60, cap(lore.label));
    return true;
  },
});

// ---------------------------------------------------------------------------
// Pair defs (tribes on a shared border)

function borderTowns(world, a, b) {
  let best = null, bd = Infinity;
  for (const ia of a.settlementIds) {
    const sa = world.settlements[ia];
    if (!sa || !sa.alive) continue;
    for (const ib of b.settlementIds) {
      const sb = world.settlements[ib];
      if (!sb || !sb.alive) continue;
      const d = (sa.x - sb.x) ** 2 + (sa.y - sb.y) ** 2;
      if (d < bd) { bd = d; best = [sa, sb]; }
    }
  }
  return best;
}
const opinionOf = (r) => (r && Number.isFinite(r.opinion) ? r.opinion : 0);
export { borderTowns };

registerEvent({
  id: 'pair.cattle_raid', scale: 'pair', family: 'feud', cat: 'diplomacy', imp: 2, maxEra: 1, cooldownYears: 10, chain: ['feud'],
  label: 'Cattle raid', icon: 'raid', hint: ['stolen herds; grievance +10', 'opinion −8, or a bride given to end it'],
  weight(ctx) {
    const { a, b, ra } = ctx;
    if (!ra || !(ra.border > 0) || opinionOf(ra) > 30) return 0;
    const fierce = 1 + 0.5 * (rulerHas(a, 'warlike') || rulerHas(b, 'warlike') || rulerHas(a, 'cruel') || rulerHas(b, 'cruel') ? 1 : 0);
    return 0.03 * fierce * (1 + ctx.heat('feud'));
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    const ag = (x) => (x.traits?.aggression ?? 0.5) + (rulerHas(x, 'warlike') ? 0.3 : 0) + world.rng.next() * 0.4;
    const [raider, victim] = ag(a) >= ag(b) ? [a, b] : [b, a];
    const tw = borderTowns(world, raider, victim);
    if (!tw) return false;
    const [from, to] = tw;
    if (world.rng.chance(0.3)) {
      record(ctx, {
        civ: raider, s: to,
        text: say(world, [
          'Young men of {from} drove off the herds of {to}, but the elders met at the ford and settled it: the cattle came back, and a daughter of {victim} was given in marriage to the raiders’ chief.',
          'A cattle raid by {raiders} on {to} ended not in blood but in a feast, when {vr} offered {his} sister to the raiders’ headman.',
        ], { from: from.name, to: to.name, victim: peopleOf(victim), raiders: peopleOf(raider), vr: rulerShort(victim.ruler), his: his(victim.ruler) }),
      });
      addOpinion(world, raider.id, victim.id, 6);
      rel(world, raider.id, victim.id).trust = Math.min(1, (rel(world, raider.id, victim.id).trust ?? 0.5) + 0.1);
      rel(world, victim.id, raider.id).trust = Math.min(1, (rel(world, victim.id, raider.id).trust ?? 0.5) + 0.1);
      heat(ctx, 'amity', 0.5);
      return true;
    }
    damageSettlement(world, to, { food: 0.15, cause: 'raid' });
    record(ctx, {
      civ: raider, s: to,
      text: say(world, [
        'Raiders of {raiders} fell on the herds of {to} by night and drove {n} head of cattle back across the border to {from}; {vr} swore to have them back.',
        'In a cattle raid on {to}, warriors of {raiders} killed two herdsmen and took the best of the herds; the grudge passed from father to son.',
        'The {radj} came over the hills to {to} at the {season} round-up and went home with its cattle; {victim} called it theft, the raiders called it the old custom.',
      ], { raiders: peopleOf(raider), radj: adjOf(raider), to: to.name, from: from.name, n: pick(world, ['thirty', 'forty', 'fifty', 'sixty', 'eighty', 'a hundred']), vr: rulerShort(victim.ruler), victim: peopleOf(victim), season: seasonWord(world, to.y) }),
    });
    effect(ctx, T.s(from), 'raid_spoils', { foodYield: 1.06 }, 2, 'Stolen herds');
    addOpinion(world, raider.id, victim.id, -8);
    const rv = rel(world, victim.id, raider.id);
    rv.grievance = Math.min(100, (rv.grievance || 0) + 10);
    heat(ctx, 'feud', 0.6);
    return true;
  },
});

registerEvent({
  id: 'pair.hunting_feud', scale: 'pair', family: 'feud', cat: 'diplomacy', imp: 2, maxEra: 1, cooldownYears: 20, chain: ['feud'],
  label: 'Hunting-ground feud', icon: 'raid', hint: ['a few hunters killed', 'opinion −10, grievance +6 on both sides'],
  weight(ctx) {
    const { ra } = ctx;
    if (!ra || !(ra.border > 0) || opinionOf(ra) > 20) return 0;
    return 0.018 * (1 + ctx.heat('feud'));
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    const tw = borderTowns(world, a, b);
    if (!tw) return false;
    const [sa, sb] = tw;
    const beast = beastNear(world, (sa.x + sb.x) / 2, (sa.y + sb.y) / 2, 10, 0);
    const game = beast ? BEAST_BY_KEY[beast.kind].name.toLowerCase() : pick(world, ['deer', 'wild horses', 'elk', 'boar']);
    damageSettlement(world, sa, { pop: 0.004, cause: 'feud' });
    damageSettlement(world, sb, { pop: 0.004, cause: 'feud' });
    record(ctx, {
      civ: a, s: sa,
      text: say(world, [
        'Hunters of {A} and {B} came to blows over the {game} between {ta} and {tb}; men died on both sides, and the old friendship of the two peoples was broken.',
        'A quarrel over who might hunt the {game} {place} became a feud between {A} and {B}; a son of {ra} was among the dead.',
      ], { A: peopleOf(a), B: peopleOf(b), game, ta: sa.name, tb: sb.name, place: placePhrase(world, sb.x, sb.y), ra: rulerShort(a.ruler) }),
    });
    addOpinion(world, a.id, b.id, -10);
    const r1 = rel(world, a.id, b.id), r2 = rel(world, b.id, a.id);
    r1.grievance = Math.min(100, (r1.grievance || 0) + 6);
    r2.grievance = Math.min(100, (r2.grievance || 0) + 6);
    heat(ctx, 'feud', 0.5);
    return true;
  },
});

registerEvent({
  id: 'pair.bride_exchange', scale: 'pair', family: 'envoys', cat: 'diplomacy', imp: 2, maxEra: 1, cooldownYears: 25, chain: ['amity'],
  label: 'Bride exchange', icon: 'marriage', hint: ['opinion +8, trust +0.1', 'old grievances eased'],
  weight(ctx) {
    const { ra } = ctx;
    if (!ra || opinionOf(ra) < -10) return 0;
    return 0.016 * (1 + ctx.heat('amity'));
  },
  fire(ctx) {
    const { world, a, b } = ctx;
    const tw = borderTowns(world, a, b);
    record(ctx, {
      civ: a, s: tw ? tw[0] : undefined,
      text: say(world, [
        'The daughter of {ra} was given to the son of {rb}, and for a generation the herds of {A} and {B} grazed the same valleys.',
        '{A} and {B} sealed their friendship with a double wedding at {town}; the bride-price was paid in cattle and amber.',
        'To end the old quarrels, the chiefs of {A} and {B} exchanged daughters at a feast by {town}, and the grandchildren were kin to both peoples.',
      ], { ra: rulerName(a.ruler, false), rb: rulerName(b.ruler, false), A: peopleOf(a), B: peopleOf(b), town: tw ? tw[1].name : 'the border' }),
    });
    addOpinion(world, a.id, b.id, 8);
    for (const [x, y] of [[a, b], [b, a]]) {
      const r = rel(world, x.id, y.id);
      r.trust = Math.min(1, (r.trust ?? 0.5) + 0.1);
      r.grievance = Math.max(0, (r.grievance || 0) - 5);
    }
    heat(ctx, 'amity', 0.6);
    return true;
  },
});

// ---------------------------------------------------------------------------
// Land defs

function townsOnLand(world, lm) {
  const out = [];
  for (const s of liveSettlements(world)) if (world.f.landmass[s.i] === lm) out.push(s);
  return out;
}

registerEvent({
  id: 'land.herd_migration', scale: 'land', family: 'wild', cat: 'nature', imp: 2, maxEra: 2, cooldownYears: 60,
  label: 'Herds migrate', icon: 'herd', hint: ['hunters on one side go hungry, the other side feasts (12 years)'],
  weight(ctx) {
    const l = ctx.land;
    return l.hunters >= 2 ? 0.015 : 0;
  },
  fire(ctx) {
    const { world, land } = ctx;
    const towns = townsOnLand(world, land.lm).filter((s) => (world.civs[s.civId]?.tech?.era || 0) <= 1);
    if (towns.length < 2) return false;
    const ns = world.rng.chance(0.5);
    let mid = 0;
    for (const s of towns) mid += ns ? s.y : s.x;
    mid /= towns.length;
    const toward = world.rng.chance(0.5);
    const gain = towns.filter((s) => ((ns ? s.y : s.x) >= mid) === toward).sort((p, q) => q.population - p.population).slice(0, 24);
    const lose = towns.filter((s) => ((ns ? s.y : s.x) >= mid) !== toward).sort((p, q) => q.population - p.population).slice(0, 24);
    if (!gain.length || !lose.length) return false;
    const dir = ns ? (toward ? 'south' : 'north') : (toward ? 'east' : 'west');
    const herdKind = beastNear(world, land.feature.x, land.feature.y, 40, 0);
    // (no article here: each template supplies its own; 'great herds' was read as 'The the great herds')
    const herds = herdKind ? BEAST_BY_KEY[herdKind.kind].name.toLowerCase().replace(/^the\s+/, '') : 'great herds';
    record(ctx, {
      civ: world.civs[gain[0].civId], s: gain[0], ref: { k: 'settlement', id: gain[0].id },
      text: say(world, [
        'The {herds} of {land} turned {dir} and did not come back; the hunters of {lost} went hungry while {gained} feasted.',
        'For reasons no shaman could read, the {herds} abandoned their old paths across {land} and wintered far to the {dir}, by {gained}.',
        'The hunters of {lost} waited at the old crossing-places, but the {herds} never came; that year they grazed the valleys around {gained} instead.',
      ], { herds, land: land.feature.name, dir, lost: lose[0].name, gained: gain[0].name }),
    });
    for (const s of gain) effect(ctx, T.s(s), 'herds', { foodYield: 1.1 }, 12, 'Herds came');
    for (const s of lose) effect(ctx, T.s(s), 'herds', { foodYield: 0.88 }, 12, 'Herds gone');
    for (const s of lose.slice(0, 6)) heat(ctx, 'hunger', 0.4, SUBJ.town(s.id));
    return true;
  },
});

registerEvent({
  id: 'land.extinction', scale: 'land', family: 'wild', cat: 'nature', imp: 3, cooldownYears: 0, luck: false,
  label: 'Extinction', icon: 'bones', hint: ['the last of a great beast dies', 'hunters nearby lose food for 30 years'],
  weight(ctx) {
    const bs = ctx.world.sys.events.beasts;
    if (!bs) return 0;
    for (const b of bs) if (b.lm === ctx.land.lm && living(b) && b.pop < 0.05) return 0.6;
    return 0;
  },
  fire(ctx) {
    const { world, land } = ctx;
    let b = null;
    for (const x of world.sys.events.beasts) if (x.lm === land.lm && living(x) && x.pop < 0.05 && (!b || x.pop < b.pop)) b = x;
    if (!b) return false;
    b.ext = world.time.day;
    b.pop = 0;
    const kind = BEAST_BY_KEY[b.kind];
    let hunter = null, hd = Infinity;
    for (const s of liveSettlements(world)) {
      const d = (s.x - b.cx) ** 2 + (s.y - b.cy) ** 2;
      if (d < hd && world.f.landmass[s.i] === b.lm) { hd = d; hunter = s; }
    }
    const civ = hunter ? world.civs[hunter.civId] : null;
    const years = Math.round(world.time.day / Y);
    const name = cap(b.name);
    const text = hunter
      ? say(world, [
        'The last of {name} was speared by hunters from {town} in the {season} of Year {y}; the herds that had fed the tribes since the world was young were gone for ever.',
        'Hunters of {town} brought down the last {one} of {land}, an old {one} too lame to flee; when the elders understood that no more would come, they wept.',
        '{name} were no more: the last of them died {place}, and the hunters of {town} went home with empty hands for the first time in memory.',
      ], { name, town: hunter.name, season: seasonWord(world, hunter.y), y: years, one: kind.one, land: land.feature.name, place: placePhrase(world, b.cx, b.cy) })
      : `${name} died out, unseen by any people.`;
    record(ctx, { text, civ: civ || undefined, s: hunter || undefined, ref: hunter ? { k: 'settlement', id: hunter.id } : undefined, tags: ['extinction'] });
    for (const s of liveSettlements(world)) {
      if (world.f.landmass[s.i] !== b.lm) continue;
      if (s.x < b.x0 - 3 || s.x > b.x1 + 3 || s.y < b.y0 - 3 || s.y > b.y1 + 3) continue;
      const era = world.civs[s.civId]?.tech?.era || 0;
      effect(ctx, T.s(s), 'beast:' + b.id, { foodYield: era <= 1 ? 0.9 : 0.96 }, 30, `No more ${kind.name.toLowerCase()}`);
      heat(ctx, 'hunger', 0.3, SUBJ.town(s.id));
    }
    return true;
  },
});

