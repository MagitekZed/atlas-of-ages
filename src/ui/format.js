// Humanising the world's numbers: people, degrees, millimetres, kilometres, dates and
// spans, latitude and longitude, winds, parameter readouts. Every function tolerates
// null, NaN and Infinity and returns an em dash rather than garbage.

import { formatNumber, capitalize } from '../core/util.js';
import { DAYS_PER_YEAR, DAYS_PER_MONTH, MONTHS_PER_YEAR, MONTH_NAMES, KM_PER_TILE, ERAS, TIERS, BIOMES, RESOURCES } from '../core/constants.js';
import { latitude } from '../core/world.js';

export const DASH = '—';
const MINUS = '−';
const ok = (v) => typeof v === 'number' && Number.isFinite(v);

/** Compact count: 12.4k, 3.1M (thousands below 10,000 grouped like the counts beside them: 2,020). */
export function num(v, digits = 1) {
  if (!ok(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 999.5 && a < 1e4) return int(v);
  return formatNumber(v, digits).replace('-', MINUS);
}

/** Grouped integer: 12,480. */
export function int(v) {
  if (!ok(v)) return DASH;
  return Math.round(v).toLocaleString('en-US').replace('-', MINUS);
}

/** People: grouped below 100k, compact above (122.1k, 3.45M). */
export function people(v) {
  if (!ok(v)) return DASH;
  const a = Math.abs(v);
  return a < 1e5 ? int(v) : num(v, a < 1e6 ? 1 : 2);
}

/** Axis labels: compact without trailing zeros (100k, 2.5M, 1200). */
export function axis(v) {
  if (!ok(v)) return DASH;
  return num(v, 1).replace(/\.0(?=[kMB]|$)/, '');
}

export function pct(v, digits = 0) {
  if (!ok(v)) return DASH;
  return (v * 100).toFixed(digits).replace('-', MINUS) + '%';
}

export function signed(v, digits = 1, unit = '') {
  if (!ok(v)) return DASH;
  const a = Math.abs(v);
  const zero = Number(a.toFixed(digits)) === 0;
  // grouped from a thousand up, like the counts beside it (+4,886%)
  const s = a >= 999.5 ? a.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : a.toFixed(digits);
  return (zero ? '±' : v > 0 ? '+' : MINUS) + s + unit;
}

export function fixed(v, digits = 1) { return ok(v) ? v.toFixed(digits).replace('-', MINUS) : DASH; }

export function temp(c, digits = 1) { return ok(c) ? fixed(c, digits) + '\u00a0°C' : DASH; }   // no break before the unit

/** Precipitation index (1 ≈ 3000 mm/yr) → mm per year. */
export function rain(v) { return ok(v) ? int(v * 3000) + ' mm/yr' : DASH; }

export function meters(m) { return ok(m) ? int(m) + ' m' : DASH; }

export function km(tiles) { return ok(tiles) ? int(tiles * KM_PER_TILE) + ' km' : DASH; }

/** Tiles → square kilometres (one tile ≈ 20 × 20 km). */
export function area(tiles) {
  if (!ok(tiles)) return DASH;
  const a = tiles * KM_PER_TILE * KM_PER_TILE;
  return (a >= 1e6 ? num(a, 2) : int(a)) + ' km²';
}

/** Compact area for tight spaces: 9,600 km² · 20.8k km² · 220k km² · 1.2M km² */
export function areaShort(tiles) {
  if (!ok(tiles)) return DASH;
  const a = tiles * KM_PER_TILE * KM_PER_TILE;
  return (a >= 1e6 ? num(a, 1) : a >= 1e5 ? num(a, 0) : a >= 1e4 ? num(a, 1) : int(a)) + ' km²';
}

export function money(v) { return ok(v) ? num(v, 1) + ' crowns' : DASH; }

export const yearOfDay = (day) => Math.floor((day || 0) / DAYS_PER_YEAR);

/** "Year 412" */
export function year(day) { return ok(day) ? 'Year ' + yearOfDay(day) : DASH; }

/** "Bloomtide, Year 412" */
export function monthYear(day) {
  if (!ok(day)) return DASH;
  const m = Math.floor(day / DAYS_PER_MONTH) % MONTHS_PER_YEAR;
  return `${MONTH_NAMES[m]}, Year ${yearOfDay(day)}`;
}

/** Short month name for a day. */
export function monthName(day) {
  if (!ok(day)) return '';
  return MONTH_NAMES[Math.floor(day / DAYS_PER_MONTH) % MONTHS_PER_YEAR];
}

/** Duration in days → "3 yrs", "7 months", "12 days", "1,204 yrs". */
export function span(days) {
  if (!ok(days)) return DASH;
  const d = Math.max(0, days);
  if (d >= DAYS_PER_YEAR) { const y = Math.floor(d / DAYS_PER_YEAR); return int(y) + (y === 1 ? ' yr' : ' yrs'); }
  if (d >= DAYS_PER_MONTH) { const m = Math.floor(d / DAYS_PER_MONTH); return m + (m === 1 ? ' month' : ' months'); }
  const n = Math.floor(d);
  return n + (n === 1 ? ' day' : ' days');
}

/** "Y12–Y488 (476 yrs)" */
export function lifespan(from, to) {
  if (!ok(from)) return DASH;
  const a = 'Y' + yearOfDay(from);
  if (!ok(to)) return a + '–present';
  return `${a}–Y${yearOfDay(to)} (${span(to - from)})`;
}

/** camelCase / snake_case → "Sentence case". */
export function humanize(key) {
  if (key == null) return '';
  const s = String(key).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().toLowerCase();
  return capitalize(s);
}

/** Title Case for names like government kinds. */
export function titleCase(key) {
  return humanize(key).replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Of|The|And)\b/g, (m) => m.toLowerCase());
}

/** Latitude / longitude of a tile: "41.2° N, 12.0° E". */
export function latLon(world, x, y) {
  if (!world) return DASH;
  const lat = latitude(world, y) * 90;
  const lon = ((x + 0.5) / world.W) * 360 - 180;
  const la = Math.abs(lat).toFixed(1) + '° ' + (lat >= 0 ? 'N' : 'S');
  const lo = Math.abs(lon).toFixed(1) + '° ' + (lon >= 0 ? 'E' : 'W');
  return `${la}, ${lo}`;
}

const COMPASS = ['E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW', 'N', 'NNE', 'NE', 'ENE'];
/**
 * Wind vector (tiles/day, +y = south) → { from, toward, strength word, label }.
 * The simulation's wind is a relative drift (~±1), so it is described in words.
 */
export function wind(wx, wy) {
  if (!ok(wx) || !ok(wy)) return { toward: DASH, from: DASH, strength: DASH, label: DASH, speed: 0 };
  const speed = Math.hypot(wx, wy);
  if (speed < 0.05) return { toward: '', from: '', strength: 'Calm', label: 'Calm', speed };
  const ang = Math.atan2(wy, wx);
  const k = ((Math.round((ang / (2 * Math.PI)) * 16) % 16) + 16) % 16;
  const toward = COMPASS[k];
  const from = COMPASS[(k + 8) % 16];
  const strength = speed < 0.35 ? 'Light' : speed < 0.75 ? 'Moderate' : speed < 1.2 ? 'Fresh' : speed < 1.7 ? 'Strong' : 'Gale';
  return { toward, from, strength, speed, label: `${strength}, from the ${from}` };
}

export const eraName = (e) => ERAS[Math.max(0, Math.min(ERAS.length - 1, e | 0))]?.name || ERAS[0].name;
export const tierName = (t) => TIERS[Math.max(0, Math.min(TIERS.length - 1, t | 0))]?.name || TIERS[0].name;
export const biomeName = (b) => BIOMES[b]?.name || 'Unknown ground';
export const resourceName = (r) => (r > 0 && RESOURCES[r] ? RESOURCES[r].name : 'None');

const RIVER_CLASSES = ['None', 'Stream', 'River', 'Broad river', 'Great river'];
export const riverName = (c) => RIVER_CLASSES[Math.max(0, Math.min(4, c | 0))];
const ROAD_LEVELS = ['None', 'Track', 'Road', 'Highway'];
export const roadName = (c) => ROAD_LEVELS[Math.max(0, Math.min(3, c | 0))];

// Readouts for parameters whose stored unit means little to a reader.
const PARAM_READOUTS = {
  // sea level shift is in normalised elevation units; one unit spans 14,000 m above the genesis shore
  seaLevelOffset: (v) => signed(v * 14000, 0, ' m'),
};

/** Parameter readout per its display hint. */
export function paramValue(p, v) {
  if (!p) return String(v);
  if (PARAM_READOUTS[p.key] && Number.isFinite(Number(v))) return PARAM_READOUTS[p.key](Number(v));
  if (p.type === 'bool') return v ? 'On' : 'Off';
  if (p.type === 'select') {
    const o = p.options.find(([k]) => String(k) === String(v));
    return o ? o[1] : String(v);
  }
  const n = Number(v);
  if (!ok(n)) return DASH;
  const stepDigits = Math.max(0, Math.min(3, Math.ceil(-Math.log10(p.step || 1) - 1e-9)));
  switch (p.display) {
    case 'percent': return Math.round(n * 100) + '%';
    case 'multiplier': return '×' + n.toFixed(Math.max(2, stepDigits)).replace(/0$/, '');
    case 'signed': return signed(n, stepDigits, p.unit ? (p.unit === '°C' ? ' °C' : p.unit) : '');
    default: return n.toFixed(stepDigits) + (p.unit ? (p.unit === '°' ? '°' : ' ' + p.unit) : '');
  }
}

/** Opinion −100..100 → a word. */
export function opinionWord(o) {
  if (!ok(o)) return DASH;
  if (o >= 60) return 'Devoted';
  if (o >= 30) return 'Friendly';
  if (o >= 10) return 'Cordial';
  if (o > -10) return 'Neutral';
  if (o > -30) return 'Wary';
  if (o > -60) return 'Hostile';
  return 'Hateful';
}

/** Treaty code → label. */
export function treatyName(t) {
  return ({ nap: 'Non-aggression pact', alliance: 'Alliance', trade: 'Trade pact', vassal: 'Vassalage', tribute: 'Tribute', overlord: 'Overlordship' })[t] || humanize(t);
}

/** War outcome code → sentence fragment. */
export function outcomeName(o) {
  return ({ attackers: 'Attackers victorious', defenders: 'Defenders held', white_peace: 'White peace', annihilation: 'Annihilation' })[o] || (o ? humanize(o) : 'Ongoing');
}

/** Short English list: "A, B and C". */
export function listing(items, max = 4) {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs[0] || '';
  if (xs.length > max) return xs.slice(0, max).join(', ') + ` and ${xs.length - max} more`;
  return xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
}

// ---------------------------------------------------------------------------
// Records and ledgers (WP6)

const ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
/** 1 → "first", 14 → "14th". */
export function ordinal(n) {
  if (!ok(n)) return DASH;
  const k = Math.round(n);
  if (k >= 0 && k < ORD.length) return ORD[k];
  const t = k % 100, u = k % 10;
  return int(k) + (t >= 11 && t <= 13 ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th');
}

/** A plague's infectivity as a reproduction number and a word: "R ≈ 2.8 · spreads fast". */
export function rNumber(v) {
  if (!ok(v)) return DASH;
  const w = v >= 2.4 ? 'spreads like fire' : v >= 1.8 ? 'spreads fast' : v >= 1.3 ? 'spreads steadily' : v >= 1 ? 'spreads slowly' : 'dies out';
  return `R ≈ ${v.toFixed(1)} · ${w}`;
}

/** A plague's lethality as a word: "kills one in eight". */
export function lethalWord(v) {
  if (!ok(v) || v <= 0) return DASH;
  if (v >= 0.5) return 'kills one in two';
  const k = Math.max(2, Math.round(1 / v));
  return `kills one in ${k >= 100 ? int(Math.round(k / 10) * 10) : k}`;
}

/** Storm category → "Category 4 cyclone" style word. */
export function stormClass(kind, cat) {
  const k = humanize(kind || 'storm').toLowerCase();
  return ok(cat) && cat > 0 ? `Category ${Math.round(cat)} ${k}` : capitalize(k);
}

/** Volcanic explosivity → words. */
export function veiWord(v) {
  if (!ok(v)) return DASH;
  const n = Math.max(0, Math.min(8, Math.round(v)));
  return `VEI ${n} · ${['gentle', 'gentle', 'explosive', 'severe', 'cataclysmic', 'paroxysmal', 'colossal', 'super-colossal', 'apocalyptic'][n]}`;
}

/** Quake magnitude with a word. */
export function magWord(m) {
  if (!ok(m)) return DASH;
  return `M${m.toFixed(1)} · ${m >= 8.5 ? 'world-shaking' : m >= 8 ? 'great' : m >= 7 ? 'major' : m >= 6 ? 'strong' : 'moderate'}`;
}

/** "the Salt War" for a sentence middle; "The Salt War" stays for headings. */
export const midName = (s) => (typeof s === 'string' ? s.replace(/^The\s/, 'the ') : s);
/** Capitalise the first letter (names like "the Red Death" as headings). */
export const headName = (s) => (typeof s === 'string' && s ? s[0].toUpperCase() + s.slice(1) : s);

/** Owner-chain code → words. */
export function ownHow(code) {
  return ({ f: 'Founded', c: 'Conquered', r: 'Rose in rebellion', s: 'Seceded', t: 'Ceded by treaty', u: 'Joined by union', d: 'Given by the gods', x: 'Destroyed' })[code] || 'Changed hands';
}

/** Year span "Y120–Y480" (or "Y120–" when open). */
export function yearSpan(from, to) {
  if (!ok(from)) return DASH;
  return `Y${yearOfDay(from)}–${ok(to) ? 'Y' + yearOfDay(to) : 'now'}`;
}

/** A record value per its RECORDS fmt (sim/records.js). */
export function recordValue(fmt, v, unit = '') {
  if (!ok(v)) return DASH;
  switch (fmt) {
    case 'people': return people(v) + (unit ? ' ' + unit : '');
    case 'years': return span(v);
    case 'area': return areaShort(v);
    case 'mag': return 'M' + v.toFixed(1);
    case 'vei': return 'VEI ' + Math.floor(v);
    case 'cat': return 'Category ' + Math.floor(v);
    case 'crater': return km(v * 2) + ' crater';
    default: return int(v) + (unit ? ' ' + unit : '');
  }
}

/** A nation's name as it reads mid-sentence: "the Kingdom of Varath", "Varath" (styled names take an article). */
export function theCiv(c) {
  if (!c) return 'a forgotten people';
  const n = c.name || c.baseName || 'a forgotten people';
  if (/^the\s/i.test(n)) return 'the ' + n.slice(4);
  return c.flags?.styled || /\s/.test(n) ? 'the ' + n : n;
}
/** The same at the start of a sentence. */
export const TheCiv = (c) => capitalize(theCiv(c));
/** Does a nation's name take a plural verb ("the Varathi Clans have…")? */
export const civPlural = (c) => Boolean(c && /\b(Tribes|Clans|Cities|Provinces|Peoples)\b|^People of\b/.test(c.name || ''));
