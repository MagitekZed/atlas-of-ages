// Bands (order 82): roaming powers outside any state. Always: outlaw bands in war-wasted and
// disloyal country, pirate fleets on busy sea lanes beside weak navies, free companies formed
// from disbanded armies (hired by realms at war, dangerous when unpaid), and steppe hordes
// that ride against the richest settled towns and found horde states. In Mythic worlds
// (mythLevel 2) also the bestiary — wyverns, trolls, giants, treants, krakens, behemoths —
// the restless dead of great battlefields, and the dragons: named lairs, long sleeps,
// terrible raids, hoards, clutches, pacts and slayers who become legends.
//
// Owned by WP2 (docs/design/expansion-packages.md). Built on the kernel band shape and lifecycle
// (core/bands.js: addBand, removeBand, getBand, bandsNear; BAND_KINDS). Modules:
//   engine (state, caps, loops) · move (routes, links to other owners) · combat (raids, roads,
//   clashes, realms) · hire (free companies) · hunts (hunts, heroes, slaying) · names · prose ·
//   tools (summon_beast, slay_beast, tame_beast) · kinds/* (one per family).
//
// Couplings: hooks bandDestroyed (archive), armyDisbanded (companies), battle (graves),
// eruption (fire drakes), and emits battle (kind band | beast), armyDisbanded, bandRaid.
// Providers (all pure, neutral when nothing applies): routeValue (road pressure), heroTarget
// (a real beast for a hero's deed), battle (a tamed beast beside an army), opinion (a common
// foe), nameStyle (realms founded by bands), yearRecord ({ kind: n } of bands abroad).
//
// Published exports (contracts §12): bandSummary(world, band), BEAST_LORE. Also (for the UI and
// WP3's heroes): bandOrArchive, heroOdds, heroDeed(world, civ, bandId, fig), tamingOf, pressureOf.

import { on } from '../../core/hooks.js';
import { registerProvider } from '../../core/ext.js';
import { mythOn } from '../../core/params.js';
import { BAND_KINDS, DAYS_PER_YEAR, DAYS_PER_MONTH } from '../../core/constants.js';
import { getBand } from '../../core/entities.js';
import {
  state, daily, monthly, yearly, archiveBand, archived, MONTH_DAY, YEAR_DAY, isPeople, isBeast, bandPower,
  peopleTotals, peopleCap, aliveOf, KIND_INDEX,
} from './engine.js';
import { huntsDaily, huntsMonthly, heroOdds, heroDeed } from './hunts.js';
import { onArmyDisbanded, snapshotArmies, formCompanies, hiring, contracts, syncHired } from './hire.js';
import { pressureOf } from './combat.js';
import { bandName } from './prose.js';
import './kinds/outlaws.js';
import './kinds/pirates.js';
import './kinds/companies.js';
import './kinds/hordes.js';
import { seedBestiary, tamingOf, TAMABLE, feral } from './kinds/beasts.js';
import { seedDragons } from './kinds/dragons.js';
import './kinds/undead.js';
import './tools.js';

// ---------------------------------------------------------------------------
// Published: the bestiary's lore (for the band view, tooltips and other packages)

export const BEAST_LORE = Object.freeze({
  bandits: { label: 'Outlaws', habitat: 'Woods and hills near troubled towns', power: [12, 400], behaviour: 'Waylay caravans and strip weak villages; break up in quiet years.', answer: 'Hunted by the realms they rob.' },
  pirates: { label: 'Pirates', habitat: 'Hidden coves beside busy sea lanes', power: [15, 260], behaviour: 'Take merchantmen, raid coastal towns, hold harbours to ransom; may found a pirate kingdom.', answer: 'Squadrons of realms that know the sea.' },
  company: { label: 'Free Company', habitat: 'Wherever there is a war to sell swords to', power: [25, 2000], behaviour: 'Hired by realms at war; unpaid, they turn on their paymaster and may seize a town.', answer: 'Pay them, or fight them.' },
  horde: { label: 'Horde', habitat: 'The grasslands and horde realms', power: [80, 9000], behaviour: 'Ride on the richest settled towns, burning lesser ones on the way; a captured city becomes a horde state.', answer: 'Walls, hosts, ransom.' },
  dragon: { label: 'Dragon', habitat: 'Lairs on the highest peaks and fire-mountains', power: [600, 12000], behaviour: 'Sleeps for generations; awake, burns the richest town within 35 leagues every few months and hoards its gold. Grows with age; Elders past 500 years.', answer: 'Great hunts, lone heroes, tribute pacts.', tame: false },
  wyvern: { label: 'Wyvern', habitat: 'Alpine peaks', power: [80, 200], behaviour: 'Stoops on herds and caravans.', answer: 'Hunts and heroes; orc beast-masters tame them.', tame: true },
  troll: { label: 'Troll', habitat: 'Taiga, tundra and northern hills', power: [40, 120], behaviour: 'Raids only on long winter nights in the far north and south.', answer: 'Fire, spears and sunlight.', tame: true },
  giant: { label: 'Giant', habitat: 'Hills and mountains', power: [150, 400], behaviour: 'Smashes villages and their walls.', answer: 'Large hunts; orcs may bind them.', tame: true },
  treant: { label: 'Treant', habitat: 'Old forest', power: [120, 300], behaviour: 'Sleeps until its wood is cleared, then walks against the farms that ate it.', answer: 'Leave the forest be; elves can calm them.', tame: true },
  kraken: { label: 'Kraken', habitat: 'Deep ocean', power: [300, 900], behaviour: 'Drags ships under and mauls fleets; sea lanes near it are shunned.', answer: 'Heroes alone.' },
  behemoth: { label: 'Behemoth', habitat: 'Steppe and savanna', power: [200, 500], behaviour: 'Migrates with the seasons, trampling the fields in its path.', answer: 'Hunts; tamed by beast-masters.', tame: true },
  undead: { label: 'Restless Dead', habitat: 'The graves of great battles', power: [60, 4000], behaviour: 'Rise from mass graves, march on the living and grow with every town they take; fade without slaughter.', answer: 'Holy hosts fight them best.' },
});

// ---------------------------------------------------------------------------
// Published: a plain summary of a band (for the UI and other packages)

const STATE_TEXT = {
  lair: 'at rest', sleep: 'asleep', roam: 'on the move', raid: 'raiding', return: 'returning home',
  hired: 'under contract', tamed: 'tamed', settling: 'marching to take a town',
};

/** A plain, JSON-safe description of a band (or of an archived one when band is an archive record). */
export function bandSummary(world, band) {
  if (!band) return null;
  const meta = BAND_KINDS[band.kind] || {};
  const live = Boolean(getBand(world, band.id));
  const lairSite = band.data?.lair != null ? band.data.lair : null;
  return {
    id: band.id, kind: band.kind, label: meta.label || band.kind, family: band.family || meta.family, glyph: meta.glyph || band.kind,
    name: band.name, epithet: band.epithet || null, title: bandName(band), live,
    state: live ? band.state : 'gone', stateText: live ? STATE_TEXT[band.state] || band.state : 'gone',
    strength: Math.round(band.strength || 0), power: Math.round(band.power || 0), hp: band.hp ?? 1, morale: band.morale ?? 1,
    weight: Math.round(live ? bandPower(band) : band.peak || 0), loot: Math.round(band.loot || 0),
    leader: band.leader ? (typeof band.leader === 'string' ? band.leader : band.leader.name) : null,
    civId: band.civId ?? -1, originCivId: band.originCivId ?? -1, x: band.x, y: band.y, homeI: band.homeI ?? null,
    lair: lairSite, raids: band.raids || 0, kills: Math.round(band.kills || 0),
    born: band.createdDay ?? band.born ?? null, died: band.died ?? null, cause: band.cause ?? null,
    people: isPeople(band), beast: isBeast(band),
  };
}

/** A band, or its archive record, by id. */
export const bandOrArchive = (world, id) => getBand(world, id) || archived(world, id);
export { heroOdds, heroDeed, tamingOf, TAMABLE, pressureOf };

// ---------------------------------------------------------------------------
// Providers (pure; neutral when nothing applies)

// a robbed road loses value while the memory of its robberies is fresh
registerProvider('routeValue', 'bands', (w, route) => {
  if (!route || !w.sys.bands) return 1;
  const p = pressureOf(w, route.id);
  return p > 0 ? 1 / (1 + 0.35 * p) : 1;
});

// a real beast near the town for a hero's deed (Mythic worlds only)
registerProvider('heroTarget', 'bands', (w, civ, s) => {
  if (!mythOn(w) || !s || !w.bands.length) return null;
  let best = null, bd = 25 * 25;
  for (const b of w.bands) {
    if (!isBeast(b) || b.state === 'tamed' || b.kind === 'dragon' || b.kind === 'kraken') continue;
    const d = (b.x - s.x) ** 2 + (b.y - s.y) ** 2;
    if (d < bd) { bd = d; best = b; }
  }
  return best ? { name: bandName(best), bandId: best.id } : null;
});

// a tamed beast marching beside an army: + half its power to the army's weight
registerProvider('battle', 'bands', (w, q) => {
  const army = q && q.army;
  if (!army || !w.bands.length || army.flags?.hunt != null) return 1;
  let add = 0;
  for (const b of w.bands) if (b.state === 'tamed' && b.data?.armyId === army.id) add += 0.5 * (b.power || 0) * Math.max(0.1, b.hp ?? 1);
  return add > 0 ? 1 + add / Math.max(20, army.strength || 0) : 1;
});

// a common foe: realms raided by the same horde, company, dragon or host of the dead
registerProvider('opinion', 'bands', (w, a, b) => {
  const foe = w.sys.bands?.foe;
  if (!foe) return 0;
  const ia = typeof a === 'object' && a ? a.id : a, ib = typeof b === 'object' && b ? b.id : b;
  const fa = foe[ia], fb = foe[ib];
  if (!fa || !fb) return 0;
  for (const id of fa) if (fb.includes(id)) return 15;
  return 0;
});

const REALM_STYLES = {
  company: { styles: ['Free Company of {name}', 'Free State of {name}', 'Condotta of {name}'], titles: { m: ['Captain-General', 'Condottiere'], f: ['Captain-General', 'Condottiera'] } },
  pirates: { styles: ['Pirate Kingdom of {name}', 'Brethren of {name}', 'Sea-Kingdom of {name}'], titles: { m: ['Pirate King', 'Sea-Lord'], f: ['Pirate Queen', 'Sea-Lady'] } },
};
// realms founded by companies and pirates keep the names their founders gave them
registerProvider('nameStyle', 'bands', (w, civ) => {
  const k = civ && w.sys.bands?.realms?.[civ.id];
  if (!k || !REALM_STYLES[k]) return null;
  return REALM_STYLES[k];
});

// bands abroad this year, by kind
registerProvider('yearRecord', 'bands', (w) => {
  if (!w.bands.length) return null;
  const out = {};
  for (const b of w.bands) out[b.kind] = (out[b.kind] || 0) + 1;
  return out;
});

// ---------------------------------------------------------------------------
// Hooks

on('bandDestroyed', (world, band, cause) => { if (world.sys.bands) archiveBand(world, band, cause); });
// a fallen realm's beasts go back to the wild at once, and the companies it hired take the
// field (killCiv has removed its armies), rather than serving a dead master till their next tick
on('civDestroyed', (world, civ) => {
  if (!world.sys.bands || !civ) return;
  for (const band of world.bands.slice()) {
    if (band.civId !== civ.id) continue;
    if (band.state === 'tamed') { feral(world, band, civ); if (band.kind === 'dragon') { band.state = 'return'; band.data.pact = null; } }
    else if (band.state === 'hired' && band.kind === 'company') syncHired(world, band);
  }
});
on('armyDisbanded', (world, army, reason) => onArmyDisbanded(world, army, reason));

// ---------------------------------------------------------------------------
// System

export const system = {
  id: 'bands',
  order: 82,
  init(world) {
    state(world);
    for (const b of world.bands) { b.data ||= {}; if (!Number.isFinite(b.hp)) b.hp = 1; if (!Number.isFinite(b.morale)) b.morale = 1; }
  },
  update(world) {
    if (!world.sys.civ) return;
    const day = world.time.day;
    if (!world.sys.bands) state(world);
    daily(world);
    if (world.sys.bands.hunts.length) huntsDaily(world);
    if (day % DAYS_PER_MONTH === MONTH_DAY) {
      const st = world.sys.bands;
      if (mythOn(world) && !st.seeded) { st.seeded = true; seedDragons(world); seedBestiary(world); }
      snapshotArmies(world);
      formCompanies(world);
      contracts(world);
      monthly(world);
      hiring(world);
      huntsMonthly(world);
    }
    if (day % DAYS_PER_YEAR === YEAR_DAY) yearly(world);
  },
  report(world) {
    const st = state(world);
    const s = st.stats;
    const years = Math.max(1, world.time.day / DAYS_PER_YEAR);
    const lines = [];
    const cents = Object.keys(s.cent).map(Number).sort((a, b) => a - b);
    for (const c of cents) {
      const row = s.cent[c];
      const parts = KIND_INDEX.filter((k) => row[k]).map((k) => `${k} ${row[k]}`);
      lines.push(`Y${c * 100}–${c * 100 + 99}: ${parts.join(' · ') || '—'}  (notable ${s.notable[c] || 0})`);
    }
    const alive = {};
    for (const b of world.bands) alive[b.kind] = (alive[b.kind] || 0) + 1;
    lines.push(`alive now: ${Object.entries(alive).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none'}; archive ${st.archive.length}`);
    lines.push(`raids ${s.raids} · kills ${Math.round(s.kills)} · loot ${Math.round(s.loot)} · caravans robbed ${s.robbed} · ships taken ${s.sunk} · roads abandoned ${s.routesBroken}`);
    lines.push(`hunts ${s.hunts} · heroes ${s.heroes} · slain ${s.slain} · tamed ${s.tamed} · hires ${s.hires} · mutinies ${s.mutinies} · ransoms ${s.ransoms} · realms founded ${s.realms}`);
    const t = peopleTotals(world);
    lines.push(`people-bands ${t.n} (max ${s.maxPeople}, cap 40) · strength ${Math.round(t.str)} of cap ${Math.round(peopleCap(world))} · peak share ${(s.maxShare * 100).toFixed(2)}% of manpower (cap 3%)`);
    if (s.t300) lines.push(`towns at Y300: ${s.t300.towns} (pop ${s.t300.pop}, ${s.t300.civs} nations) at mythLevel ${s.t300.myth}`);
    if (mythOn(world)) lines.push(`dragons alive ${aliveOf(world, 'dragon')} (max ${s.maxDragons}, 0–6) · beasts ${world.bands.filter((b) => b.family === 'beast' && b.kind !== 'dragon').length}`);
    const checks = [
      { ok: s.maxPeople <= 40, label: `at most 40 people-bands (max ${s.maxPeople})` },
      { ok: s.maxShare <= 0.0301, label: `people-band strength ≤ 3% of world manpower (peak ${(s.maxShare * 100).toFixed(2)}%)` },
    ];
    // notable band events per century after Y200 (only whole centuries that have been lived)
    const full = Math.floor(years / 100);
    if (full >= 3) {
      let worst = Infinity, worstC = -1;
      for (let c = 2; c < full; c++) { const n = s.notable[c] || 0; if (n < worst) { worst = n; worstC = c; } }
      checks.push({ ok: worst >= 3, label: `≥3 band events of imp≥2 per century after Y200 (lowest ${worst} in Y${worstC * 100})` });
    }
    if (mythOn(world)) checks.push({ ok: s.maxDragons <= 6, label: `0–6 dragons alive (max ${s.maxDragons})` });
    return { title: 'Bands (roaming powers)', lines, checks };
  },
};
