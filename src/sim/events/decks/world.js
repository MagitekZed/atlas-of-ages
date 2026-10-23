// The world deck: black swans, the rare shocks that redraw the map. At most one every 200
// years (sys.events.swan), each scaled by params.fortune:
//   systems collapse   the trade web seizes: 3–6 trading realms lose stability (−0.25) and
//                      trade, their great cities empty, routes fall silent, raiders and hordes
//                      multiply (rates boosts), and their continents slide toward dark ages
//   great comet        an omen read for and against every ruler; faiths burn hotter, prophets
//                      and schisms multiply
//   pandemic of contact  the first sea road between continents carries a sickness neither
//                      shore has met (WP4 createPlague, lethality ×3)
//   great river flood  a great river drowns the towns along it, then leaves rich silt
//   messiah            a saviour preaches in a troubled city: a faith reborn or a new one
// and one consequence that is not a swan (no 200-year gap, no fortune): the hungry years that
// follow a veil of ash or dust over the sun (the climate module's Year Without Summer).

import { registerEvent } from '../../../core/events.js';
import { on } from '../../../core/hooks.js';
import { liveSettlements, liveCivs, civSettlements, damageSettlement, addOpinion } from '../../../core/entities.js';
import { emitFx, latitude } from '../../../core/world.js';
import { DAYS_PER_YEAR } from '../../../core/constants.js';
import { SWAN_GAP_YEARS } from '../data.js';
import { record, effect, heat, T, evState, startPlague, foundFaith, boostFaith, breakRouteSafe } from '../engine.js';
import { SUBJ, addHeat } from '../heat.js';
import { addBoost, forceAge } from '../ages.js';
import {
  pick, say, cap, civName, peopleOf, rulerName, rulerShort, rulerHas, personName, shortWord, featureNear,
  seasonWord, peopleCount, listJoin, countWord, shareWord,
} from '../prose.js';

const Y = DAYS_PER_YEAR;
const year = (world) => Math.floor(world.time.day / Y);
function swanReady(world) {
  const sw = world.sys.events.swan;
  return !sw || sw.last == null || world.time.day - sw.last >= SWAN_GAP_YEARS * Y;
}
/** A kind of swan the world has already seen comes again less readily (× 0.3). Pure. */
function fresh(world, id) {
  const h = world.sys.events.swan?.hist;
  if (!Array.isArray(h)) return 1;
  for (const e of h) if (e && e.id === id) return 0.3;
  return 1;
}
function swanFired(world, id, name) {
  const sw = evState(world).swan;
  sw.last = world.time.day;
  sw.hist.push({ id, day: world.time.day, name });
  if (sw.hist.length > 40) sw.hist.splice(0, sw.hist.length - 40);
}
function landsOf(world, civs) {
  const out = new Set();
  for (const c of civs) {
    const cs = c.capitalId != null ? world.settlements[c.capitalId] : null;
    if (cs) { const lm = world.f.landmass[cs.i]; if (lm >= 0) out.add(lm); }
  }
  return [...out];
}

// ash and dust over the sun (eruptions and impacts): the hungry years may follow
on('eruption', (world, p) => {
  if (!p || !world.sys.events) return;
  if (p.vei >= 6) { evState(world).pend.ash = world.time.day; addHeat(world, 'restless', SUBJ.world, 1); }
  else if (p.vei >= 5) addHeat(world, 'restless', SUBJ.world, 0.35);
});
on('impact', (world, p) => {
  if (!p || !world.sys.events) return;
  if (p.r >= 4) evState(world).pend.ash = world.time.day;
});

// ---------------------------------------------------------------------------
// Systems collapse

function tradeScore(world, civ) {
  let v = 0;
  for (const k in civ.relations) v += Math.max(0, civ.relations[k].trade || 0);
  return v;
}
registerEvent({
  id: 'world.systems_collapse', scale: 'world', family: 'swan', cat: 'disaster', imp: 5, minEra: 1, cooldownYears: 0,
  label: 'Systems collapse', icon: 'swan', hint: ['3–6 trading realms: stability −0.25, trade crippled (25 years)', 'cities empty; raiders and hordes multiply'],
  weight(ctx) {
    const { world } = ctx;
    if (!swanReady(world) || liveCivs(world).length < 4) return 0;
    let routes = 0;
    for (const r of world.tradeRoutes) if (r && r.active) routes++;
    return routes >= 5 ? 0.0015 * (1 + 0.5 * Math.min(2, ctx.heat('misery'))) * fresh(world, 'collapse') : 0;
  },
  fire(ctx) {
    const { world } = ctx;
    const civs = liveCivs(world).filter((c) => (c.tech?.era || 0) >= 1).map((c) => [tradeScore(world, c), c]).filter(([v]) => v > 0)
      .sort((a, b) => b[0] - a[0] || a[1].id - b[1].id).slice(0, 6).map(([, c]) => c);
    if (civs.length < 3) return false;
    const n = Math.max(3, Math.min(civs.length, 3 + Math.floor(world.rng.next() * 4)));
    const hit = civs.slice(0, n);
    const name = pick(world, ['the Great Unravelling', 'the Sundering of the Roads', `the Collapse of Year ${year(world)}`, 'the Time of Silence']);
    const big = hit.map((c) => civSettlements(world, c).sort((a, b) => b.population - a.population)[0]).filter(Boolean);
    const early = ctx.era <= 2;
    record(ctx, { civ: hit[0], s: big[0], ref: { k: 'civ', id: hit[0].id }, text: say(world, early ? [
      'In {name} the web of trade that bound {list} tore apart: caravans stopped, harvests rotted unsold, and raiders came out of every hill.',
      '{Name} began with three years of drought and a revolt of the palace servants at {city}; soon {list} were burning their own granaries, and raiders picked over what was left.',
      'No one could say afterwards how {name} began, only that {list} fell into it together: the tin stopped coming, the palaces emptied, and the hungry took to the roads.',
    ] : [
      'In {name} the web of trade that bound {list} tore apart: caravans stopped, harvests rotted unsold, and raiders came out of every hill.',
      '{Name} began with a bad harvest and a bank failure in {city}; within ten years {list} were bankrupt, their roads empty and their cities half deserted.',
      'No one could say afterwards how {name} began, only that {list} fell into it together: trade stopped, the coin failed, and the hungry took to the roads.',
    ], { name, Name: cap(name), list: listJoin(hit.map((c) => civName(c))), city: big[0] ? big[0].name : 'the great markets' }) });
    for (const c of hit) {
      effect(ctx, T.c(c), 'collapse', { stability: -0.25, trade: -0.4 }, 25, name);
      const towns = civSettlements(world, c).sort((a, b) => b.population - a.population || a.id - b.id).slice(0, 6);
      towns.forEach((s, k) => {
        if (k < 3) damageSettlement(world, s, { pop: world.rng.float(0.03, 0.08), wealth: 0.3, food: 0.25, cause: 'collapse' });
        if (s.alive) effect(ctx, T.s(s), 'collapse', { trade: 0.5, unrest: 0.1, foodYield: 0.85 }, 20, name);
      });
    }
    const ids = hit.map((c) => c.id);
    evState(world).collapse = { civs: ids, until: world.time.day + 25 * Y };
    let broken = 0;
    for (const r of world.tradeRoutes) {
      if (broken >= 6) break;
      if (r && r.active && (ids.includes(r.civA) || ids.includes(r.civB)) && world.rng.chance(0.5) && breakRouteSafe(world, r, 'collapse')) broken++;
    }
    addBoost(world, 'bandSpawn', 2.5, 30, name);
    addBoost(world, 'horde', 1.5, 30, name);
    for (const lm of landsOf(world, hit)) heat(ctx, 'misery', 1.2, SUBJ.land(lm));
    if (world.rng.chance(0.4)) forceAge(world, 'strife', { k: 'collapse' }, world.rng.int(120, 220), ctx.entry ? ctx.entry.seq : null);
    swanFired(world, 'collapse', name);
    return true;
  },
});

// ---------------------------------------------------------------------------
// Great comet

registerEvent({
  id: 'world.great_comet', scale: 'world', family: 'swan', cat: 'religion', imp: 4, cooldownYears: 0,
  label: 'Great comet', icon: 'comet', hint: ['every faith grows fervent; prophets and schisms multiply (20 years)', 'rulers blessed or doomed by the omen'],
  weight(ctx) { return swanReady(ctx.world) ? 0.0018 * fresh(ctx.world, 'comet') : 0; },
  fire(ctx) {
    const { world } = ctx;
    const civs = liveCivs(world);
    if (!civs.length) return false;
    // a world names each of its great comets afresh (a name it has used goes to a new star of its own)
    const used = new Set((evState(world).swan.hist || []).filter((h) => h && h.id === 'comet').map((h) => h.name));
    let name = pick(world, ['the Long-Haired Star', 'the Bearded Star', 'the Sword in the Sky', `the Star of ${shortWord(world, null)}`]);
    if (used.has(name)) name = `the Star of ${shortWord(world, null)}`;
    const cap0 = civs.slice().sort((a, b) => b.population - a.population)[0];
    const capTown = cap0 && cap0.capitalId != null ? world.settlements[cap0.capitalId] : null;
    const favoured = [], doomed = [];
    for (const c of civs) {
      if (!c.ruler) continue;
      let sign;
      if (rulerHas(c, 'pious') || rulerHas(c, 'charismatic')) sign = 1;
      else if (rulerHas(c, 'mad') || rulerHas(c, 'cruel')) sign = -1;
      else sign = world.rng.chance(0.5) ? 1 : -1;
      if (sign > 0) favoured.push(c); else doomed.push(c);
    }
    const f0 = favoured[0], d0 = doomed[0];
    record(ctx, { civ: cap0, s: capTown || undefined, ref: { k: 'event', id: 'swan:comet:' + year(world) }, text: say(world, [
      '{Name} blazed across the sky for {n} nights in Year {y}; in every land the priests read it, {f}{d}',
      'A great comet, called {name} by {people}, hung over the world for a whole {season}; {f}{d}',
    ], {
      Name: cap(name), name, n: countWord(world.rng.int(40, 90)), y: year(world), people: cap0 ? peopleOf(cap0) : 'all peoples', season: capTown ? seasonWord(world, capTown.y) : 'summer',
      f: f0 ? `the seers of ${civName(f0)} called it a blessing on ${rulerShort(f0.ruler)}` : 'and none called it a blessing',
      d: d0 ? `, while among ${peopleOf(d0)} it was whispered that ${rulerShort(d0.ruler)} would not live to see another.` : '.',
    }) });
    for (const c of favoured) effect(ctx, T.c(c), 'omen', { stability: 0.04 }, 10, name);
    for (const c of doomed) effect(ctx, T.c(c), 'omen', { stability: -0.05 }, 10, name);
    for (const r of world.religions) if (r && r.alive !== false) boostFaith(world, r.id, 0.12);
    addBoost(world, 'prophet', 2, 20, name);
    addBoost(world, 'schism', 1.5, 20, name);
    for (const lm of landsOf(world, civs)) heat(ctx, 'omen', 1, SUBJ.land(lm));
    heat(ctx, 'omen', 1);
    swanFired(world, 'comet', name);
    return true;
  },
});

// ---------------------------------------------------------------------------
// Pandemic of contact

registerEvent({
  id: 'world.pandemic_contact', scale: 'world', family: 'swan', cat: 'disease', imp: 4, cooldownYears: 0, luck: false,
  label: 'Pandemic of contact', icon: 'plague', hint: ['the first sea road between continents carries a new plague (lethality ×3)'],
  weight(ctx) {
    const st = ctx.world.sys.events;
    return st.pend.contact && !st.pend.contactDone && swanReady(ctx.world) ? 0.35 : 0;
  },
  fire(ctx) {
    const { world } = ctx;
    const st = evState(world);
    const c = st.pend.contact;
    if (!c) return false;
    const a = world.settlements[c.a], b = world.settlements[c.b];
    st.pend.contactDone = world.time.day;
    delete st.pend.contact;
    const port = b && b.alive ? b : a && a.alive ? a : null;
    if (!port) return false;
    const from = port === b ? a : b;
    const civF = from ? world.civs[from.civId] : null, civP = world.civs[port.civId];
    const p = startPlague(world, port, { lethalityMul: 3, cause: 'contact', civB: civF || null });
    const swan = 'the pandemic of contact';
    if (p) {
      record(ctx, { s: port, ref: { k: 'plague', id: p.id }, text: say(world, [
        'The ships that first crossed from {from} to {port} carried more than {cargo}: {plague}, a sickness neither shore had known, ran along the new sea road.',
        'Strangers from across the ocean landed at {port}, and with them came {plague}; {people} had no defence against it.',
      ], { from: from ? from.name : 'the far shore', port: port.name, cargo: pick(world, ['spices', 'silver', 'furs and amber', 'silk']), plague: p.name, people: civP ? peopleOf(civP) : 'its people' }) });
    } else {
      record(ctx, { s: port, imp: 3, text: say(world, [
        'Sailors from across the ocean brought a fever to {port} that its healers had never seen; for three years the harbour quarter buried its dead.',
      ], { port: port.name }) });
      effect(ctx, T.s(port), 'newfever', { mortality: 1.4, health: -0.08 }, 3, 'A new fever');
    }
    heat(ctx, 'blame', 0.6, SUBJ.town(port.id));
    swanFired(world, 'pandemic', p ? p.name : swan);
    return true;
  },
});

// ---------------------------------------------------------------------------
// Great river flood

function greatRiver(world) {
  const groups = new Map();
  for (const s of liveSettlements(world)) {
    if (!(world.f.river[s.i] >= 3)) continue;
    const name = featureNear(world, 'river', s.x, s.y, 16);
    if (!name) continue;
    let g = groups.get(name);
    if (!g) groups.set(name, (g = { name, towns: [], pop: 0 }));
    g.towns.push(s); g.pop += s.population;
  }
  let best = null;
  for (const g of groups.values()) if (g.towns.length >= 2 && (!best || g.pop > best.pop)) best = g;
  return best;
}
registerEvent({
  id: 'world.great_flood', scale: 'world', family: 'swan', cat: 'disaster', imp: 4, cooldownYears: 0,
  label: 'Great river flood', icon: 'flood', hint: ['the towns of a great river drown', 'then the silt makes them rich'],
  weight(ctx) {
    if (!swanReady(ctx.world)) return 0;
    return greatRiver(ctx.world) ? 0.0015 * fresh(ctx.world, 'flood') : 0;
  },
  fire(ctx) {
    const { world } = ctx;
    const g = greatRiver(world);
    if (!g) return false;
    const towns = g.towns.sort((a, b) => b.population - a.population || a.id - b.id).slice(0, 12);
    let dead = 0;
    const names = towns.slice(0, 3).map((s) => s.name);
    const first = towns[0];
    for (const s of towns) {
      dead += damageSettlement(world, s, { pop: world.rng.float(0.02, 0.07), food: 0.6, buildings: 0.15, wealth: 0.2, cause: 'flood' });
      if (s.alive) { effect(ctx, T.s(s), 'floodwrack', { foodYield: 0.75 }, 2, 'Flood'); }
    }
    const civ = world.civs[first.civId];
    record(ctx, { s: first, civ, text: say(world, [
      'In the {season} of Year {y} {river} rose higher than anyone living remembered; it swept through {list}, and {dead} drowned.',
      'After weeks of rain {river} burst its banks from end to end: {list} stood in water to the rooftops, and {dead} were lost.',
    ], { season: seasonWord(world, first.y), y: year(world), river: g.name, list: listJoin(names), dead: peopleCount(world, dead) }) });
    for (const s of towns) if (s.alive) heat(ctx, 'flood', 1, SUBJ.town(s.id));
    emitFx(world, { type: 'flood', x: first.x, y: first.y, r: 4 });
    swanFired(world, 'flood', `the flood of ${g.name}`);
    return true;
  },
});

// ---------------------------------------------------------------------------
// Messiah

function messiahCity(world) {
  let best = null, bv = 0;
  for (const s of liveSettlements(world)) {
    if (s.tier < 3) continue;
    const civ = world.civs[s.civId];
    if (!civ) continue;
    const trouble = 1.4 - Math.max(0, Math.min(1, civ.stability ?? 0.6)) + (s.unrest || 0);
    const v = trouble * Math.sqrt(s.population);
    if (v > bv) { bv = v; best = s; }
  }
  return best;
}
registerEvent({
  id: 'world.messiah', scale: 'world', family: 'swan', cat: 'religion', imp: 4, minEra: 1, cooldownYears: 0,
  label: 'A messiah', icon: 'faith', hint: ['a faith reborn or founded; its realm steadied', 'neighbours of other faiths grow hostile'],
  weight(ctx) {
    if (!swanReady(ctx.world)) return 0;
    return messiahCity(ctx.world) ? 0.0012 * (1 + 0.5 * Math.min(2, ctx.heat('omen'))) * fresh(ctx.world, 'messiah') : 0;
  },
  fire(ctx) {
    const { world } = ctx;
    const s = messiahCity(world);
    if (!s) return false;
    const civ = world.civs[s.civId];
    const who = personName(world, civ);
    let faith = s.dominantReligion != null ? world.religions[s.dominantReligion] : null;
    if (faith && faith.alive === false) faith = null;
    let founded = false;
    if (!faith) { faith = foundFaith(world, s, { prophet: who }); founded = Boolean(faith); }
    const v = { who, town: s.name, faith: faith ? faith.name : 'a new way', people: peopleOf(civ), ruler: rulerName(civ.ruler) };
    record(ctx, { s, civ, ref: faith ? { k: 'religion', id: faith.id } : undefined, text: founded
      ? say(world, [
        'In the troubled streets of {town} a water-carrier named {who} preached that the end of the world was near; those who listened became {faith}, and their numbers doubled every year.',
        '{who} of {town} healed the sick and fed the hungry, and the crowds called {him} the saviour; from them grew {faith}.',
      ], { ...v, him: world.rng.chance(0.5) ? 'him' : 'her' })
      : say(world, [
        'A preacher named {who} rose in {town}, calling the followers of {faith} back to its first purity; {ruler} knelt to {him} in the market.',
        'The faithful of {faith} hailed {who} of {town} as the promised one; pilgrims came from every land to touch {his} robe.',
      ], { ...v, him: world.rng.chance(0.5) ? 'him' : 'her', his: world.rng.chance(0.5) ? 'his' : 'her' }) });
    if (faith) boostFaith(world, faith.id, 0.3);
    effect(ctx, T.c(civ), 'messiah', { stability: 0.06, culture: 0.1 }, 30, `The preaching of ${who}`);
    effect(ctx, T.s(s), 'messiah', { culture: 1.15, happiness: 0.05, attract: 1.3 }, 30, `The preaching of ${who}`);
    for (const k in civ.relations) {
      const o = world.civs[k];
      if (!o || !o.alive || !faith || o.stateReligion === faith.id) continue;
      if (civ.relations[k].border > 0) { addOpinion(world, civ.id, o.id, -8); heat(ctx, 'feud', 0.4, SUBJ.pair(civ.id, o.id)); }
    }
    addBoost(world, 'prophet', 1.5, 40, who);
    addBoost(world, 'schism', 2, 40, who);
    swanFired(world, 'messiah', who);
    return true;
  },
});

// ---------------------------------------------------------------------------
// The hungry years (a consequence of the veil, not a swan)

registerEvent({
  id: 'world.hungry_years', scale: 'world', family: 'swan', cat: 'climate', imp: 4, cooldownYears: 30, luck: false,
  label: 'The hungry years', icon: 'famine', hint: ['harvests fail across the world: food −40% for 2 years', 'riots and relief follow'],
  weight(ctx) {
    const { world } = ctx;
    const st = world.sys.events;
    const veil = (world.climate.aerosol || 0) >= 0.15 || (st.pend.ash != null && world.time.day - st.pend.ash < 3 * Y);
    return veil ? 0.6 : 0;
  },
  fire(ctx) {
    const { world } = ctx;
    const st = evState(world);
    delete st.pend.ash;
    const towns = liveSettlements(world).filter((s) => { const la = Math.abs(latitude(world, s.y)); return la > 0.18 && la < 0.8; })
      .sort((a, b) => b.population - a.population || a.id - b.id).slice(0, 120);
    if (!towns.length) return false;
    for (const s of towns) {
      damageSettlement(world, s, { food: 0.3, cause: 'cold' });
      if (s.alive) effect(ctx, T.s(s), 'ashwinter', { foodYield: 0.6 }, 2, 'The hungry years');
    }
    const civs = new Set(towns.map((s) => s.civId));
    for (const id of civs) { const c = world.civs[id]; if (c && c.alive) effect(ctx, T.c(c), 'ashwinter', { stability: -0.03 }, 5, 'The hungry years'); }
    const src = world.climate.aerosolSource?.name || 'the veil of ash';
    record(ctx, { s: towns[0], text: say(world, [
      'The cold years that followed {src} emptied the granaries of the world: from {a} to {b}, people ate their seed corn and then their dogs.',
      'For two summers after {src} the crops failed in {share} of the world’s fields; in {a} bread cost a day’s wage, and in {b} there was none.',
      'After {src} the sun rose pale and the harvests did not ripen; the poor of {a} boiled grass, and in {b} the old gave up their bread to the young.',
      'Snow fell at midsummer in the years after {src}. From {a} to {b} the fields lay black and the roads filled with people looking for bread.',
    ], { src, a: towns[0].name, b: towns[Math.min(towns.length - 1, 5)].name, share: shareWord(0.5) }) });
    for (const s of towns.slice(0, 60)) heat(ctx, 'hunger', 1, SUBJ.town(s.id));
    return true;
  },
});

