// Prose for the Mythic chronicle: small helpers that keep myth entries in the same voice as
// the rest of the history (finished past-tense sentences with real names, places, seasons
// and rulers), and the shared chronicle writer that always sets cat, key and ref.
//
// Template filling: '{town} fell silent' with vars { town: 'Oskel' }. Picks draw from the rng
// passed in (world.rng in the sim), so text is reproducible.

import { chronicle } from '../../core/chronicle.js';
import { MONTH_NAMES, MONTH_SEASON, SEASONS, DAYS_PER_MONTH, DAYS_PER_YEAR, MONTHS_PER_YEAR } from '../../core/constants.js';
import { latitude } from '../../core/world.js';
import { capitalize } from '../../core/util.js';

/** One template from a list. */
export const pickT = (rng, list) => list[Math.floor(rng.next() * list.length)] ?? list[0];

/** Fill {placeholders}; a key given as '' empties its slot, an unknown key stays visible (tests catch it). */
export function fill(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars && vars[k] != null ? String(vars[k]) : m));
}

/** A finished sentence: capital first letter, one final full stop. */
export function sentence(s) {
  let t = String(s).trim().replace(/\s+/g, ' ').replace(/\s+([,.;])/g, '$1');
  if (!/[.!?]$/.test(t)) t += '.';
  return capitalize(t);
}

/** "the Sylvan Realm of Ithiliel" (styled names take the article, as in the civ prose). */
export const theName = (civ) => (!civ ? 'a forgotten people' : civ.flags?.styled ? 'the ' + civ.name : civ.name);
export const TheName = (civ) => capitalize(theName(civ));
/** "the Ithilieli" for the people of a nation. */
export const peopleOf = (civ) => (civ?.adjective ? 'the ' + civ.adjective : 'its people');
export const PeopleOf = (civ) => capitalize(peopleOf(civ));

/** "High Lady Aelwen" / "Under-King Thrain the Bold". */
export function rulerName(civ) {
  const r = civ?.ruler;
  if (!r) return null;
  const nm = r.regnal > 1 ? `${r.name} ${roman(r.regnal)}` : r.name;
  return `${r.title ? r.title + ' ' : ''}${nm}${r.epithet ? ' ' + r.epithet : ''}`.trim();
}
export function roman(n) {
  const v = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '', k = Math.max(1, Math.min(39, n | 0));
  for (const [a, b] of v) while (k >= a) { s += b; k -= a; }
  return s;
}

export const yearOfDay = (day) => Math.floor(day / DAYS_PER_YEAR);
export const monthNameOf = (day) => MONTH_NAMES[Math.floor(day / DAYS_PER_MONTH) % MONTHS_PER_YEAR];
/** Season word at a row (hemisphere-aware): "winter", "spring", … */
export function seasonAt(world, y, day = world.time.day) {
  const s = MONTH_SEASON[Math.floor(day / DAYS_PER_MONTH) % MONTHS_PER_YEAR];
  return SEASONS[latitude(world, y) >= 0 ? s : (s + 2) % 4].toLowerCase();
}

export const aAn = (w) => (/^[aeiou]/i.test(w) ? 'an ' + w : 'a ' + w);
export function listJoin(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a[0] || '';
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

/** Nearest named feature of some kinds to (x, y) within r tiles: "the Tiren", "the Varan Sea". */
export function nearFeature(world, x, y, kinds = null, r = 30) {
  let best = null, bd = r * r;
  for (const ft of world.features || []) {
    if (kinds && !kinds.includes(ft.kind)) continue;
    const d = (ft.x - x) ** 2 + (ft.y - y) ** 2;
    if (d < bd) { bd = d; best = ft; }
  }
  return best;
}
/** "in the Ashen Hills" / "by the Varan Sea" / "" for a place. */
export function placePhrase(world, x, y) {
  const ft = nearFeature(world, x, y, ['range', 'forest', 'desert', 'lake', 'river', 'sea'], 18);
  if (!ft || !ft.name) return '';
  const nm = ft.name;
  switch (ft.kind) {
    case 'range': return `in ${nm}`;
    case 'forest': return `in ${nm}`;
    case 'desert': return `in ${nm}`;
    case 'lake': case 'sea': return `by ${nm}`;
    case 'river': return `on ${nm}`;
    default: return '';
  }
}
/** The continent (or island) name a point lies on, or null. */
export function landName(world, x, y) {
  const ft = nearFeature(world, x, y, ['continent', 'island'], 60);
  return ft ? ft.name : null;
}

/**
 * Write a myth chronicle entry. e: { text, imp, cat?, key (required), x?, y?, civId?, sid?,
 * ref?, cause?, tags?, icon? }. cat defaults to 'myth'. Returns the entry.
 */
export function record(world, e) {
  return chronicle(world, {
    cat: e.cat || 'myth', imp: e.imp ?? 2, text: sentence(e.text), key: e.key,
    x: e.x ?? null, y: e.y ?? null, civId: e.civId ?? null, sid: e.sid ?? null,
    ref: e.ref || null, cause: e.cause ?? null, tags: e.tags || null, icon: e.icon || 'myth',
  });
}
