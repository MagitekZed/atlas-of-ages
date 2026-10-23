// Stir the Uncanny: the myth god tools (group 'myth'). Every apply goes through the kernel
// (core/tools.js), so each stroke is logged and replays exactly.
//   ley_line      drag a river of magic across the land (continuous; finish() turns the
//                 stroke into a ley edge, links it to nodes at its ends, recomputes manaBase)
//   wellspring    raise a new place of power, joined to the nearest nodes
//   awaken_magic  (Historical and Legendary worlds only) the Awakening, one-way for history (undo can take it back): mythLevel 2
//                 through setParam({ force, log }), the ley network and mana, the old peoples
//                 counted as human, elder races rising in the wild places for fifty years,
//                 an epochal chronicle entry and the mythAwakened hook

import { registerTool } from '../../core/tools.js';
import { setParam, emitFx, bumpVersion } from '../../core/world.js';
import { emit } from '../../core/hooks.js';
import { addSite } from '../../core/sites.js';
import { createCiv, createSettlement, liveCivs, settlementsNear } from '../../core/entities.js';
import { mythLevel } from '../../core/params.js';
import { WATER, RACE_META } from '../../core/constants.js';
import { isMythic, fin, RACES, RACE_IDX, raceAff, PHONOLOGY, traitsFor, enabledRaces, raceLabel } from './races.js';
import { rasterLine, nearestEdge, bowed, nodeName, nodeKindAt, simplifyStroke } from './ley.js';
import { leyNodes, computeManaBase, manaAt, gridOf, seedArcane, mythState } from './mana.js';
import { activateMyth } from './arcana.js';
import { pickT, fill, record, sentence, placePhrase, landName, seasonAt, yearOfDay, listJoin } from './prose.js';

let civTech = null;
try { civTech = await import('../civ/tech.js'); } catch (e) { /* tech table unavailable: new peoples start in the Stone Age */ }

const MAX_EDGES = 160;
const ok = (message) => ({ ok: true, message });
const no = (message) => ({ ok: false, message });

/** Nearest node site within r tiles of (x, y), or null. */
function nodeNear(world, x, y, r) {
  let best = null, bd = r * r;
  for (const n of leyNodes(world)) {
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d <= bd) { bd = d; best = n; }
  }
  return best;
}

/** After an edit: raise the local mana toward its new base so the change is felt at once. */
function quicken(world, pts) {
  const { W2, H2 } = gridOf(world);
  const f = world.f;
  const k = fin(world.params.magicStrength, 1) * fin(world.sys.myth?.weave, 1);
  for (let p = 0; p + 1 < pts.length; p += 2) {
    const cx0 = Math.round(pts[p] / 2), cy0 = Math.round(pts[p + 1] / 2);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const cx = cx0 + dx, cy = cy0 + dy;
      if (cx < 0 || cy < 0 || cx >= W2 || cy >= H2) continue;
      const c = cy * W2 + cx;
      const t = f.manaBase[c] * k;
      if (f.mana[c] < t) f.mana[c] += (t - f.mana[c]) * 0.6;
    }
  }
}

// ---------------------------------------------------------------------------
// Ley Line

registerTool({
  id: 'ley_line', label: 'Ley Line', group: 'myth', icon: 'ley', order: 10, target: 'tile', radius: 0,
  continuous: true, polarity: 'boon',
  desc: 'Drag a river of magic across the land. Mana gathers along it; towns near it grow wizards. Ends drawn near a place of power join it.',
  available: (world) => isMythic(world),
  apply(world, x, y) {
    if (!isMythic(world) || !mythState(world)) return no('There is no magic in this world to draw.');
    const st = world.sys.myth;
    const s = (st.stroke ||= { pts: [], day: world.time.day });
    const n = s.pts.length;
    const px = x, py = y;   // tile centres (entity coordinates)
    const msg = { ok: true, message: 'A river of magic follows your hand; let go to bind it into the land.' };
    if (n >= 2) {
      const lx = s.pts[n - 2], ly = s.pts[n - 1];
      if (Math.hypot(px - lx, py - ly) < 0.9) return msg;
      if (s.pts.length >= 400) return msg;
      rasterLine(world, world.f.ley, [lx, ly, px, py], 0.85);
      bumpVersion(world, 'ley');
    }
    s.pts.push(px, py);
    return msg;
  },
  finish(world) {
    const st = mythState(world);
    if (!st || !st.stroke) return;
    const raw = st.stroke.pts;
    st.stroke = null;
    let len = 0;
    for (let k = 2; k + 1 < raw.length; k += 2) len += Math.hypot(raw[k] - raw[k - 2], raw[k + 1] - raw[k - 1]);
    if (raw.length < 4 || len < 4) { bumpVersion(world, 'ley'); return; }
    if (st.ley.edges.length >= MAX_EDGES) { bumpVersion(world, 'ley'); return; }
    const pts = simplifyStroke(raw, 1.4);
    const a = nodeNear(world, pts[0], pts[1], 3.5), b = nodeNear(world, pts[pts.length - 2], pts[pts.length - 1], 3.5);
    if (a) pts.unshift(a.x, a.y);
    if (b) pts.push(b.x, b.y);
    st.ley.edges.push({ a: a ? a.id : null, b: b ? b.id : null, w: 0.85, pts, by: 'user', day: world.time.day });
    rasterLine(world, world.f.ley, pts, 0.85);
    computeManaBase(world);
    quicken(world, pts);
    st.counts.lines = fin(st.counts.lines, 0) + 1;
    const x0 = pts[0], y0 = pts[1], x1 = pts[pts.length - 2], y1 = pts[pts.length - 1];
    const from = a ? a.name : placeLabel(world, x0, y0), to = b ? b.name : placeLabel(world, x1, y1);
    const towns = new Set();
    for (let k = 0; k + 1 < pts.length; k += 6) for (const t of settlementsNear(world, pts[k], pts[k + 1], 4)) towns.add(t.name);
    const tw = [...towns].slice(0, 3);
    record(world, {
      cat: 'divine', imp: 2, key: 'myth.tool.ley_line', tags: ['ley'],
      text: fill(pickT(world.rng, [
        'In the {season} of Year {y} a new ley line ran across {land}, from {from} to {to}{towns}.',
        'An unseen hand drew a river of power from {from} to {to}{towns}, and the stones along it hummed.',
      ]), { season: seasonAt(world, y0), y: yearOfDay(world.time.day), land: landName(world, x0, y0) || 'the land', from, to, towns: tw.length ? `, passing ${listJoin(tw)}` : '' }),
      x: (x0 + x1) / 2, y: (y0 + y1) / 2, ref: a ? { k: 'site', id: a.id } : b ? { k: 'site', id: b.id } : null,
    });
    emitFx(world, { type: 'leyflare', x: x0, y: y0, x2: x1, y2: y1, src: 'tool', intensity: 1 });
  },
  preview(world, x, y) {
    if (!isMythic(world)) return { ok: false, reason: 'Magic sleeps in this world. Awaken it first.' };
    const n = nodeNear(world, x, y, 3.5);
    const near = nearestEdge(world.sys.myth?.ley?.edges || [], x, y);
    const m = manaAt(world, x, y);
    return {
      ok: true,
      text: n ? `Begin at ${n.name}` : near.dist < 2 ? `Branch from a ley line (mana ${Math.round(m * 100)})` : `Mana here ${Math.round(m * 100)}`,
      rings: [{ x, y, r: n ? 3.5 : 1.2, tone: 'boon' }],
      targets: n ? [{ kind: 'site', id: n.id }] : [],
    };
  },
});

function placeLabel(world, x, y) {
  const t = settlementsNear(world, x, y, 5)[0];
  if (t) return t.name;
  const p = placePhrase(world, x, y);
  return p ? `the wilds ${p}` : 'the wilds';
}

// ---------------------------------------------------------------------------
// Wellspring

function wellspringCheck(world, x, y) {
  if (!isMythic(world) || !mythState(world)) return 'Magic sleeps in this world. Awaken it first.';
  const i = y * world.W + x;
  if (world.f.water[i] !== WATER.LAND) return 'A wellspring must rise from dry land.';
  const n = nodeNear(world, x, y, 5);
  if (n) return `Too near ${n.name}: places of power keep their distance.`;
  if (leyNodes(world).length >= 60) return 'The world holds as many places of power as it can bear.';
  return null;
}

/** The one or two nodes a new wellspring links to. */
function wellLinks(world, x, y) {
  return leyNodes(world).map((n) => ({ n, d: Math.hypot(n.x - x, n.y - y) })).sort((p, q) => p.d - q.d || p.n.id - q.n.id).slice(0, 2).filter((e, k) => k === 0 || e.d < 40);
}

registerTool({
  id: 'wellspring', label: 'Wellspring', group: 'myth', icon: 'wellspring', order: 20, target: 'tile', radius: 0, polarity: 'boon',
  desc: 'Raise a new place of power from the earth. Ley lines run from it to the nearest nodes, and mana floods the country around.',
  available: (world) => isMythic(world),
  apply(world, x, y) {
    const why = wellspringCheck(world, x, y);
    if (why) return no(why);
    const st = world.sys.myth;
    const i = y * world.W + x;
    const kind = nodeKindAt(world, i) === 'fire' ? 'fire' : 'well';
    const nm = nodeName(world, world.rng, kind, new Set(leyNodes(world).map((n) => n.name)));
    const links = wellLinks(world, x, y);
    const site = addSite(world, { kind: 'node', x, y, i, name: nm.name, pinned: true, fame: 2, data: { power: 0.9, nk: kind, short: nm.short, origin: 'tool' } });
    for (const { n } of links) {
      const pts = bowed(x, y, n.x, n.y, (world.rng.next() - 0.5) * 0.3);
      st.ley.edges.push({ a: site.id, b: n.id, w: 0.85, pts, by: 'user', day: world.time.day });
      rasterLine(world, world.f.ley, pts, 0.85);
    }
    world.f.ley[i] = 255;
    computeManaBase(world);
    quicken(world, [x, y, ...links.flatMap(({ n }) => [n.x, n.y])]);
    st.counts.wells = fin(st.counts.wells, 0) + 1;
    const to = links.map(({ n }) => n.name);
    record(world, {
      cat: 'divine', imp: 2, key: 'myth.tool.wellspring', tags: ['ley'],
      text: fill(pickT(world.rng, [
        'A wellspring of power broke from the earth {place} in the {season} of Year {y}: {name}{links}.',
        'In Year {y} light welled up out of the ground {place}, and {name} was named{links}.',
      ]), { place: placePhrase(world, x, y) || 'in the wilds', season: seasonAt(world, y), y: yearOfDay(world.time.day), name: nm.name, links: to.length ? `, and new ley lines ran from it to ${listJoin(to)}` : '' }),
      x, y, ref: { k: 'site', id: site.id },
    });
    emitFx(world, { type: 'awaken', x, y, r: 6, src: 'tool', intensity: 0.6 });
    for (const { n } of links) emitFx(world, { type: 'leyflare', x, y, x2: n.x, y2: n.y, src: 'tool' });
    return ok(`${nm.name} rises${to.length ? `, linked to ${listJoin(to)}` : ''}.`);
  },
  preview(world, x, y) {
    const why = wellspringCheck(world, x, y);
    if (why) return { ok: false, reason: why };
    const links = wellLinks(world, x, y);
    return {
      ok: true,
      text: links.length ? `A new place of power, linked to ${listJoin(links.map(({ n }) => n.name))}` : 'A new place of power',
      rings: [{ x, y, r: 6, tone: 'boon' }],
      threads: links.map(({ n }) => ({ x0: x, y0: y, x1: n.x, y1: n.y, tone: 'trade' })),
    };
  },
});

// ---------------------------------------------------------------------------
// Awaken Magic

const AWAKEN_TEXT = [
  'In the {season} of Year {y}, magic woke in the world. Light ran along {n} hidden lines between the places of power; the greatest, {node}, burned like a second moon over {land}, and the old peoples stirred in the wild places.',
  'The Awakening came in Year {y}: the stones of {node} began to sing, ley lines kindled across {land} and beyond, and in the deep woods and under the mountains the elder peoples woke.',
];
const ELDER_TEXT = {
  elf: ['{People} stepped out from beneath the trees {place}, where no one had known they dwelt, and raised {town}.', 'Elves came out of the deep wood {place} as the ley-light kindled, and their kindred founded {town}.'],
  dwarf: ['The doors of the mountain opened {place}, and {people} came down to found {town}.', 'Dwarves who had slept beneath the hills {place} came up into the light and built {town}.'],
  halfling: ['{People} came up out of the green hollows {place} and dug the first smials of {town}.', 'Small folk no one had ever counted came out of the hillocks {place}; {people} called their first village {town}.'],
  lizardfolk: ['From the steaming fens {place} rose {people}, and the egg-mothers raised {town}.', 'Scaled folk crept out of the reeds {place}; the broods of {people} built {town} on stilts above the water.'],
  orc: ['{People} poured out of the barren hills {place}, and their war-camp at {town} grew into a town.', 'Tusked warbands came down out of the wastes {place}; {people} made {town} their stronghold.'],
};

/** The best unclaimed, unpeopled tile for race r, at least 9 tiles from any town. Pure. */
function wildSite(world, race, avoid) {
  const { W, H, f } = world;
  const r = RACE_IDX[race];
  let best = -1, bs = 0;
  for (let y = 2; y < H - 2; y += 2) for (let x = 2; x < W - 2; x += 2) {
    const i = y * W + x;
    if (f.water[i] !== WATER.LAND || f.owner[i] >= 0 || f.settle[i] >= 0) continue;
    let far = true;
    for (const p of avoid) if ((p.x - x) ** 2 + (p.y - y) ** 2 < 144) { far = false; break; }
    if (!far || settlementsNear(world, x, y, 9).length) continue;
    const a = raceAff(world, r, i);
    const food = 0.4 + f.soil[i] + 0.4 * f.veg[i] + (f.river[i] > 0 ? 0.3 : 0) - 0.6 * f.snow[i];
    const s = a * a * food;
    if (s > bs) { bs = s; best = i; }
  }
  return best;
}

/** Knowledge most living peoples share (to the age before the median), for a newcomer. */
function commonKnowledge(world, civ) {
  const T = civTech?.TECHS;
  if (!Array.isArray(T) || typeof civTech.grantTech !== 'function') return;
  const civs = liveCivs(world).filter((c) => c.id !== civ.id && c.tech?.known);
  if (!civs.length) return;
  const eras = civs.map((c) => fin(c.tech.era, 0)).sort((a, b) => a - b);
  const maxEra = Math.max(0, eras[eras.length >> 1] - 1);
  for (let pass = 0; pass < 2; pass++) {
    for (const t of T) {
      if (t.era > maxEra || civ.tech.known[t.id] != null || !t.prereqs.every((p) => civ.tech.known[p] != null)) continue;
      let n = 0;
      for (const c of civs) if (c.tech.known[t.id] != null) n++;
      if (n / civs.length >= 0.6) civTech.grantTech(civ, t.id, world.time.day);
    }
  }
}

/** Raise an elder people of `race` at tile i. Returns { civ, s } or null. */
function raiseElder(world, race, i) {
  const x = i % world.W, y = (i / world.W) | 0;
  const civ = createCiv(world, { race, languageStyle: PHONOLOGY[race] || null, traits: traitsFor(world, race, i * 31 + 17), x, y });
  if (typeof civTech?.getMods === 'function') commonKnowledge(world, civ);
  const pop = race === 'orc' ? 220 : race === 'elf' ? 150 : 180;
  const s = createSettlement(world, civ.id, x, y, { population: pop, food: pop * 6, race });
  if (!s) return null;
  s.housing = Math.max(fin(s.housing, 0), pop * 1.6);
  seedArcane(world, civ);
  return { civ, s };
}

function awaken(world, x, y) {
  const day = world.time.day;
  // the act wakes the myth itself, below (not the paramChanged hook's quiet wake)
  world.cache.mythAwakening = true;
  try { setParam(world, 'mythLevel', 2, { force: true, log: true }); } finally { world.cache.mythAwakening = false; }
  // the peoples of the old world were always human
  for (const c of world.civs) if (c && c.race == null) c.race = 'human';
  for (const s of world.settlements) if (s && s.race == null) s.race = 'human';
  const { st } = activateMyth(world);
  st.awakenedDay = day;
  st.awakenedAt = { x, y };
  for (const c of liveCivs(world)) seedArcane(world, c);
  const nodes = leyNodes(world);
  const great = nodes.slice().sort((a, b) => fin(b.data?.power) - fin(a.data?.power) || a.id - b.id)[0] || null;
  const e = record(world, {
    cat: 'myth', imp: 5, key: 'myth.awakening', tags: ['awakening'],
    text: fill(pickT(world.rng, AWAKEN_TEXT), { season: seasonAt(world, y), y: yearOfDay(day), n: st.ley.edges.length, node: great ? great.name : 'the oldest stones', land: great ? landName(world, great.x, great.y) || 'the land' : 'the land' }),
    x: great ? great.x : x, y: great ? great.y : y, ref: great ? { k: 'site', id: great.id } : null,
  });
  // the elder peoples come out of the wild places
  const order = ['elf', 'dwarf', 'halfling', 'lizardfolk', 'orc'].filter((r) => enabledRaces(world).includes(r));
  const want = Math.max(2, Math.min(4, Math.round(liveCivs(world).length / 3)));
  const raised = [];
  for (const race of order) {
    if (raised.length >= want) break;
    const i = wildSite(world, race, raised.map((r) => r.s));
    if (i < 0) continue;
    const r = raiseElder(world, race, i);
    if (!r) continue;
    raised.push(r);
    record(world, {
      cat: 'myth', imp: 3, key: 'myth.awakening.people', tags: ['awakening', race], cause: e.seq,
      text: fill(pickT(world.rng, ELDER_TEXT[race]), { People: `The ${RACE_META[race].plural} of ${r.civ.baseName}`, people: `the ${RACE_META[race].plural} of ${r.civ.baseName}`, place: placePhrase(world, r.s.x, r.s.y) || 'in the wild country', town: r.s.name }),
      x: r.s.x, y: r.s.y, sid: r.s.id, civId: r.civ.id, ref: { k: 'civ', id: r.civ.id },
    });
    emitFx(world, { type: 'newcivs', x: r.s.x, y: r.s.y, civId: r.civ.id });
  }
  emitFx(world, { type: 'awaken', x, y, r: Math.max(world.W, world.H) * 0.5, src: 'tool', intensity: 1 });
  for (const ed of st.ley.edges.slice(0, 24)) {
    const p = ed.pts;
    emitFx(world, { type: 'leyflare', x: p[0], y: p[1], x2: p[p.length - 2], y2: p[p.length - 1], src: 'tool' });
  }
  emit(world, 'mythAwakened');
  return { raised, entry: e };
}

registerTool({
  id: 'awaken_magic', label: 'Awaken Magic', group: 'myth', icon: 'awaken', order: 5, target: 'tile', radius: 0, polarity: 'neutral',
  desc: 'Wake the old magic in a world of history: ley lines kindle, mana rises, and the elder races come out of the wild places. History will never put it back to sleep; only undo can.',
  available: (world) => mythLevel(world) < 2,
  danger: () => true,
  apply(world, x, y) {
    if (mythLevel(world) >= 2) return no('Magic is already awake in this world.');
    const { raised } = awaken(world, x, y);
    const names = raised.map((r) => raceLabel(r.civ.race, true));
    return ok(sentence(`Magic wakes. ${names.length ? listJoin(names) + ' come out of the wild places' : 'The ley lines kindle'}`));
  },
  preview(world) {
    if (mythLevel(world) >= 2) return { ok: false, reason: 'Magic is already awake.' };
    return { ok: true, severity: 'epochal', text: 'Wake magic in this world: ley lines, mana and the elder races. History will never put it back to sleep (only your undo can).' };
  },
});

/** For tests and reports: the elder peoples raised by an awakening (civ ids). */
export function awakenedPeoples(world) {
  const st = mythState(world);
  if (!st || st.awakenedDay == null) return [];
  return liveCivs(world).filter((c) => c.foundedDay === st.awakenedDay && c.race && RACES[c.race]?.elder).map((c) => c.id);
}
