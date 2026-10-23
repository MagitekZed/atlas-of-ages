// Bands · prose. Small phrase helpers (nations, rulers, dates and seasons, places, numbers
// and money) and the one chronicle writer every band module uses: say() stamps the entry with
// a ref to the band, a dotted key ('band.raid', 'dragon.slain' …), tags and an icon, and
// counts the notable ones (imp ≥ 2 after the news filter) per century for the report. Each
// event has several templates; callers pick with world.rng so phrasing varies run to run.

import { chronicle } from '../../core/chronicle.js';
import { MONTH_NAMES, SEASONS, DAYS_PER_YEAR, DAYS_PER_MONTH, MONTHS_PER_YEAR } from '../../core/constants.js';
import { seasonAt } from '../../core/world.js';
import { capitalize } from '../../core/util.js';
import { featureNear, featName } from './names.js';

export const pick = (world, arr) => arr[Math.floor(world.rng.next() * arr.length)];
/** Like pick, but never the same template twice running for this band and event (one rng draw). */
export function pickFresh(world, band, key, arr) {
  let k = Math.floor(world.rng.next() * arr.length);
  if (band && band.data && arr.length > 1) {
    const pk = (band.data.pk ||= {});
    if (pk[key] === k) k = (k + 1) % arr.length;
    pk[key] = k;
  }
  return arr[k];
}
export const cap = capitalize;

/** Mid-sentence name of a nation ("the Kingdom of Tlae", "Tlae"). */
export function civName(civ) {
  if (!civ) return 'a fallen people';
  return civ.flags?.styled && !/^the\s/i.test(civ.name) ? 'the ' + civ.name : civ.name;
}
export const CivName = (civ) => cap(civName(civ));
/** "the Tlaeans" style collective (adjective based). */
export function peopleOf(civ) {
  if (!civ) return 'the people';
  const a = civ.adjective || civ.baseName || civ.name;
  return /(s|ese|i|sh|ch)$/i.test(a) ? `the ${a}` : `the ${a}s`;
}
/** The reigning ruler's display name, or a fallback that still reads. */
export function rulerOf(civ) {
  const r = civ?.ruler;
  if (!r) return `the lords of ${civName(civ)}`;
  return r.display || [r.title, r.name].filter(Boolean).join(' ') || `the lords of ${civName(civ)}`;
}

const SMALL = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** People counts as a chronicler writes them: "eleven", "forty", "1,240". */
export function count(n) {
  const v = Math.max(0, Math.round(n || 0));
  if (v <= 12) return SMALL[v];
  if (v < 100) return String(Math.round(v / 5) * 5 || v);
  if (v < 1000) return String(Math.round(v / 10) * 10);
  return commas(Math.round(v / 50) * 50);
}
const ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
/** 3 → "third", 21 → "21st" (exact, never rounded like count()). */
export function ordinal(n) {
  const v = Math.max(0, Math.round(n || 0));
  if (v < ORD.length) return ORD[v];
  const t = v % 100, u = v % 10;
  return v + (t >= 11 && t <= 13 ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th');
}
/** "one villager" / "two villagers": a plural noun only when count() says two or more. */
export const plural = (n, one, many = one + 's') => (Math.round(n || 0) === 1 ? one : many);

/** 1240 → "1,240" (locale-free, so every runtime writes the same text). */
export function commas(n) {
  const s = String(Math.max(0, Math.round(n || 0)));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
export const money = (n) => `${commas(n)} crowns`;
export const year = (day) => `Year ${Math.floor(day / DAYS_PER_YEAR)}`;

/** "In the winter of Year 412" / "In Harvest of Year 412" / "In Year 412". */
export function when(world, y = 0) {
  const day = world.time.day;
  const yr = Math.floor(day / DAYS_PER_YEAR);
  const r = world.rng.next();
  if (r < 0.4) return `In the ${SEASONS[seasonAt(world, Math.round(y || 0))].toLowerCase()} of Year ${yr}`;
  if (r < 0.7) return `In ${MONTH_NAMES[Math.floor(day / DAYS_PER_MONTH) % MONTHS_PER_YEAR]} of Year ${yr}`;
  return `In Year ${yr}`;
}
/** "winter", "summer" … at that row today. */
export const seasonWord = (world, y) => SEASONS[seasonAt(world, Math.max(0, Math.min(world.H - 1, Math.round(y || 0))))].toLowerCase();

/** "in the Fowulwood", "on the slopes of the Hul Spine", "off the Lyfona Sea", or "" when nothing is named nearby. */
export function placePhrase(world, x, y, sea = false) {
  if (sea) {
    const s = featureNear(world, x, y, ['sea', 'ocean'], 30);
    return s ? `on ${featName(s)}` : 'on the open sea';
  }
  const ft = featureNear(world, x, y, ['forest', 'range', 'desert', 'lake'], 9);
  if (!ft) return '';
  if (ft.kind === 'range') return /(hills|mountains|peaks|range|spine|heights)$/i.test(ft.name) ? `in ${featName(ft)}` : `in the hills of ${featName(ft)}`;
  if (ft.kind === 'lake') return `by ${ft.name}`;
  return `in ${featName(ft)}`;
}

/** A war's name mid-sentence ("the Salt War"), or "the war". */
export function warName(war) {
  if (!war || !war.name) return 'the war';
  return /^the\s/i.test(war.name) ? 'the ' + war.name.replace(/^the\s+/i, '') : 'the ' + war.name;
}

/** A place phrase, dropped when the name already says it ("the Wyvern of the Hul Spine … in the Hul Spine"). */
export function whereFor(where, name) {
  if (!where || !name) return where || '';
  const core = where.replace(/^(in the hills of|in|on|by|off)\s+/i, '').replace(/^the\s+/i, '');
  return core && String(name).includes(core) ? '' : where;
}

/** A band's name with its epithet when it has one ("Vharokh the Ashen"). */
export function bandName(band) {
  if (!band) return 'the raiders';
  if (!band.epithet) return band.name;
  // a title or an already-epitheted name takes a by-name: "the Giantess of Lake Beim, called Herobane"
  return /^the\s|\sthe\s/i.test(band.name) && !/^the\s/i.test(band.epithet) ? `${band.name}, called ${band.epithet}` : `${band.name} ${band.epithet}`;
}
export const BandName = (band) => cap(bandName(band));

const ICON = {
  bandits: 'outlaw', pirates: 'pirate', company: 'company', horde: 'horde', migration: 'horde',
  dragon: 'dragon', wyvern: 'beast', troll: 'beast', giant: 'beast', treant: 'beast', kraken: 'beast', behemoth: 'beast', undead: 'undead',
};
export const bandIcon = (band) => ICON[band?.kind] || 'outlaw';

/** Notable (imp 2) band entries per decade before routine ones are folded (imp ≥ 3 always told). */
const BAND_BUDGET = 15;
/** Keys whose visible entry makes a band known to the chronicle (band.data.told). */
const TOLD_KEY = /^(band|beast|undead|dragon)\.(rise|raid)$|^band\.horde\.rise$|^dragon\.come$/;

/**
 * Write a chronicle entry about a band (or with band = null, about a realm or place).
 * e: { text, cat, imp, key, x?, y?, civId?, sid?, cause?, fold?, ref?, tags? }. Returns the entry.
 * Band news has its own volume budget (BAND_BUDGET notable entries a decade; past it imp-2
 * entries are folded), and a band whose rise or a raid was told counts as known (data.told):
 * only a known band's end is notable news.
 */
export function say(world, band, e) {
  const st = world.sys.bands;
  const tags = ['bands'];
  if (band) tags.push(band.kind);
  if (Array.isArray(e.tags)) for (const t of e.tags) if (tags.length < 4) tags.push(t);
  let imp = e.imp ?? 2, fold = Boolean(e.fold);
  const dec = Math.floor(world.time.day / (10 * DAYS_PER_YEAR));
  const gov = st ? (st.gov && st.gov.dec === dec ? st.gov : (st.gov = { dec, n: 0 })) : null;
  if (gov && imp === 2 && !fold && gov.n >= BAND_BUDGET) { imp = 1; fold = true; }
  // a by-name opened mid-sentence is closed: "the Restless Dead of Chi, called Herobane, overran…"
  const text = typeof e.text === 'string' ? e.text.replace(/(, called [A-Z][\w'’-]*)(?= [a-z])/g, '$1,') : e.text;
  const entry = chronicle(world, {
    cat: e.cat || 'civ', imp, text,
    x: e.x ?? (band ? Math.round(band.x) : null), y: e.y ?? (band ? Math.round(band.y) : null),
    civId: e.civId ?? null, sid: e.sid ?? null, icon: e.icon || (band ? bandIcon(band) : 'outlaw'),
    ref: e.ref || (band ? { k: 'band', id: band.id } : null),
    key: e.key || 'band.event', cause: e.cause ?? null, tags, fold,
  });
  if (st && entry && entry.imp >= 2 && !entry.fold) {
    const c = Math.floor(world.time.day / (100 * DAYS_PER_YEAR));
    const n = (st.stats.notable ||= {});
    n[c] = (n[c] || 0) + 1;
    if (gov && entry.imp === 2) gov.n++;
    if (band && band.data && TOLD_KEY.test(entry.key || '')) {
      band.data.told = (band.data.told || 0) + 1;
      band.data.rseq = entry.seq;   // the last told raid or rise (cause for the hunt it provokes)
    }
  }
  return entry;
}

/** Has the chronicle told of this band (its rise or a raid)? Only then is its end notable. */
export const isTold = (band) => Boolean(band && band.data && band.data.told);
