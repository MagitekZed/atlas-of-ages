// Splitting and merging peoples: secession, civil-war factions, collapse fragments and
// unions all go through here so names, treasuries, loyalties and wars stay consistent.
// A breakaway realm inherits its parent's race (the kernel's createCiv), unless the ext
// 'people' answer for its new seat says otherwise (elven towns under a human crown rise as
// elves). Published: splitCiv (contracts §12).

import { createCiv, transferSettlement, startWar, civSettlements } from '../../core/entities.js';
import { adjectiveOf, makeCivName, createLanguage } from '../../core/names.js';
import { emitFx } from '../../core/world.js';
import { firstOf, hasProviders } from '../../core/ext.js';
import { fin } from './state.js';
import { refreshMods } from './tech.js';
import { goodName, civNameTaken } from './prose.js';

const ORDINALS = ['', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];
const ORD_RE = /^The\s+((Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth)\s+)?/;

/**
 * A war name not yet used in this world. `bases` is one name or a list in order of
 * preference ("Varathi War of Succession", "War of the Varathi Succession", …): the first
 * unused one wins; when all are taken, the least-used gets an ordinal ("The Second …").
 */
export function uniqueWarName(world, bases) {
  const list = (Array.isArray(bases) ? bases : [bases]).filter(Boolean).map((b) => String(b).replace(/^The\s+/, ''));
  if (!list.length) return 'The War';
  const used = new Map();
  for (const w of world.wars) {
    if (!w || typeof w.name !== 'string') continue;
    const k = w.name.replace(ORD_RE, '');
    used.set(k, (used.get(k) || 0) + 1);
  }
  for (const b of list) if (!used.has(b)) return `The ${b}`;
  let best = list[0], bn = Infinity;
  for (const b of list) { const n = used.get(b) || 0; if (n < bn) { bn = n; best = b; } }
  return `The ${ORDINALS[Math.min(bn, ORDINALS.length - 1)]} ${best}`;
}

/**
 * Split settlements away from `parent` into a new civ.
 * opts: { cause, government, nameFrom: 'city'|'new',
 *         war: { cause, name | names: string[] | (rebelCiv) => string[] } | null,
 *         loyalty, keepCapital (never move the parent's capital unless allowTotal), allowTotal }
 * Returns { civ, war } or null.
 */
export function splitCiv(world, parent, sids, opts = {}) {
  let list = sids.map((id) => world.settlements[id]).filter((s) => s && s.alive && s.civId === parent.id);
  if (!opts.allowTotal) list = list.filter((s) => s.id !== parent.capitalId);
  if (!list.length) return null;
  if (!opts.allowTotal && list.length >= parent.settlementIds.length) return null;
  list.sort((a, b) => b.population - a.population);
  const cap = list[0];
  const useCity = (opts.nameFrom === 'city' || (opts.nameFrom !== 'new' && world.rng.chance(0.75)))
    && goodName(cap.name) && !civNameTaken(world, cap.name);
  let lang = JSON.parse(JSON.stringify(parent.language));
  const civOpts = { language: lang, parentId: parent.id, x: cap.x, y: cap.y, government: opts.government || parent.government };
  if (hasProviders('people')) {
    const who = firstOf('people', world, { genesis: false, i: cap.i, parentCivId: parent.id });
    if (who && typeof who === 'object' && who.race !== undefined) {
      civOpts.race = who.race;
      // another people breaking away speaks its own tongue, not its old masters'
      if ((who.race ?? null) !== (parent.race ?? null)) civOpts.language = lang = createLanguage(world.rng, who.languageStyle ?? null);
    }
  }
  if (useCity) { civOpts.name = cap.name; civOpts.adjective = adjectiveOf(cap.name, lang); }
  else {
    for (let k = 0; k < 8; k++) {
      const nm = makeCivName(lang, world.rng);
      if (goodName(nm.name) && !civNameTaken(world, nm.name)) { civOpts.name = nm.name; civOpts.adjective = nm.adjective; break; }
    }
  }
  const parentPop = Math.max(1, fin(parent.population, 1));
  const civ = createCiv(world, civOpts);
  let moved = 0;
  for (const s of list) { moved += s.population; transferSettlement(world, s.id, civ.id, opts.cause || 'secession'); }
  const share = Math.min(0.9, moved / parentPop);
  if (parent.alive && parent.treasury > 0) {
    const t = parent.treasury * share * 0.6;
    parent.treasury -= t; civ.treasury += t;
  }
  for (const s of civSettlements(world, civ)) {
    s.loyalty = opts.loyalty ?? 0.72;
    s.unrest = Math.min(s.unrest, 0.15);
    s.flags.assim = Math.max(fin(s.flags.assim), 0.85);
    s.flags.seceded = world.time.day;
  }
  civ.stability = 0.62;
  civ.legitimacy = 0.5;
  civ.flags.independence = world.time.day;
  refreshMods(world, civ);
  let war = null;
  if (opts.war && parent.alive) {
    const names = typeof opts.war.names === 'function' ? opts.war.names(civ) : opts.war.names || [opts.war.name];
    war = startWar(world, [civ.id], [parent.id], opts.war.cause || 'civil war', uniqueWarName(world, names));
  }
  emitFx(world, { type: 'rebellion', x: cap.x, y: cap.y, civId: civ.id });
  return { civ, war };
}

/** Rough strength estimate (people under arms, era, wealth) without the geo module. */
export function roughPower(world, civ) {
  if (!civ || !civ.alive) return 0;
  const m = civ.mods || {};
  return fin(civ.population) * 0.03 * fin(m.military, 1) * (1 + 0.35 * fin(civ.tech?.era)) + Math.sqrt(Math.max(0, fin(civ.treasury))) * 4;
}

/** Root ancestor id of a civ (follows parentId chains, cycle-safe). */
export function rootOf(world, civ) {
  let c = civ, guard = 0;
  while (c && c.parentId != null && world.civs[c.parentId] && guard++ < 50) c = world.civs[c.parentId];
  return c ? c.id : null;
}
