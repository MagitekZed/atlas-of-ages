// Temperament: how a people's character reads in the UI. Every nation carries eight traits
// (civ.traits, 0–1) that drift with what the people live through (src/sim/civ/temper.js,
// whose pure helpers temperBand, temperWords, temperShifts and TEMPER_LABELS this module reads
// through a guarded import). Each trait falls in one of five bands, 0 lowest … 4 highest; the
// middle band (2) is the people's ordinary temper, the outer four are its character. Here they
// become words and pictures:
//   temperBlock     the Inspector's "Temperament" section of a nation: a one-line reading, a
//                   bar per trait with its band word, a faint marker at the founding value and
//                   an arrow when it moved in the last fifty years; the latest shifts with
//                   their causes and years, linked to their chronicle entries; and a small
//                   chart of the traits that moved most (civ.flags.temperHist)
//   strongestBands  the strongest outer bands, ["warlike", "devout"] (ledger, hover card, lead)
//   driftWords      a race's drift speed in plain words ("change quickly", "slow to change")
//   leanings        a race's temperament offsets as words ("inventive, restless")
// Without the drift module, or in a world saved before it, the bands come from civ.traits
// alone and every part that needs history stays hidden. Read-only: nothing here writes the world.

import { DAYS_PER_YEAR } from '../core/constants.js';
import { h, svgEl, cssVar } from './dom.js';
import { glyph } from './icons.js';
import { tip } from './widgets.js';
import * as F from './format.js';
import { TimeChart } from './charts.js';

let temperMod = null;
try { temperMod = await import('../sim/civ/temper.js'); } catch (e) { /* no drift module: bands from civ.traits, no history */ }

const ok = Number.isFinite;
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);

/** The eight traits in core order (civ.traits keys; the order of temperHist samples). */
export const TEMPER_KEYS = ['aggression', 'expansion', 'religiosity', 'commerce', 'innovation', 'tolerance', 'militarism', 'isolation'];
const NAMES = { aggression: 'Aggression', expansion: 'Expansion', religiosity: 'Religiosity', commerce: 'Commerce', innovation: 'Innovation', tolerance: 'Tolerance', militarism: 'Militarism', isolation: 'Isolation' };
/** [low pole, high pole]: what a people grows more of when a trait falls or rises ("More devout"). */
const POLES = {
  aggression: ['peaceable', 'warlike'], expansion: ['home-loving', 'restless'], religiosity: ['worldly', 'devout'], commerce: ['self-sufficient', 'mercantile'],
  innovation: ['traditional', 'inventive'], tolerance: ['suspicious', 'tolerant'], militarism: ['', 'martial'], isolation: ['outward-looking', 'insular'],
};
/** A trait coming back to the middle band from below ("Less worldly"; plain words where "less" would stack negatives). */
const BACK_UP = {
  aggression: 'Less peaceable', expansion: 'Less home-loving', religiosity: 'Less worldly', commerce: 'Readier to trade',
  innovation: 'Less hidebound', tolerance: 'Less suspicious', militarism: 'Readier for war', isolation: 'Less outward-looking',
};
/** Band edges and words while the drift module is absent (its own table wins when present). */
const EDGES = [0.2, 0.38, 0.62, 0.8];
const FALLBACK = {
  aggression: ['peaceable', 'mild', 'even-tempered', 'combative', 'warlike'],
  expansion: ['home-loving', 'settled', 'steady', 'restless', 'expansionist'],
  religiosity: ['worldly', 'sceptical', 'observant', 'devout', 'zealous'],
  commerce: ['self-sufficient', 'frugal', 'trading', 'enterprising', 'mercantile'],
  innovation: ['hidebound', 'traditional', 'practical', 'inventive', 'ingenious'],
  tolerance: ['xenophobic', 'suspicious', 'guarded', 'tolerant', 'cosmopolitan'],
  militarism: ['unsoldierly', 'lightly armed', 'vigilant', 'martial', 'militaristic'],
  isolation: ['outward-looking', 'open', 'self-reliant', 'insular', 'reclusive'],
};
export const MID_BAND = 2;

/** Why a trait moved: [glyph, phrase after the change]. Keys from the drift module's log (cause). */
const CAUSES = {
  war: ['war', 'after years of war'], conquest: ['army', 'through conquest'], victory: ['battle', 'after victory upon victory'],
  defeat: ['ruin', 'after defeat'], ruin: ['devastate', 'amid the ruin of war'], weariness: ['war', 'out of war-weariness'],
  peace: ['peace', 'in a long peace'], trade: ['trade', 'through trade'], contact: ['contact', 'meeting new peoples'], solitude: ['eye', 'in long solitude'],
  plague: ['plague', 'after plague'], famine: ['drought', 'after famine'], golden: ['prosper', 'in a golden age'], dark: ['ruin', 'in a dark age'],
  wonder: ['wonder', 'raising great works'], discovery: ['enlighten', 'through discovery'], faith: ['faith', 'under the state faith'],
  ruler: ['crown', 'under a long reign'], reason: ['enlighten', 'in an age of reason'], industry: ['fire', 'with industry'],
  colonies: ['settle', 'settling new lands'], overreach: ['nations', 'under the strain of empire'], mixing: ['people', 'as peoples mingled'],
  enmity: ['hatred', 'through old enmities'], expulsion: ['hatred', 'after the expulsions'], time: ['hourglass', 'as the generations passed'],
};
const causeOf = (c) => CAUSES[c] || ['hourglass', c ? `(${F.humanize(c).toLowerCase()})` : ''];

/** The trait's display name (the drift module's words when it has them). */
export function traitName(k) {
  const L = temperMod?.TEMPER_LABELS?.[k];
  const s = typeof L === 'string' ? L : L && typeof L === 'object' && !Array.isArray(L) ? (L.name || L.label || null) : null;
  return typeof s === 'string' && s ? F.headName(s) : NAMES[k] || F.humanize(k);
}

/** Band index 0..4 of a trait value (2 is the middle). */
export function bandIndex(v) {
  if (typeof temperMod?.temperBand === 'function') {
    try { const b = temperMod.temperBand(v); if (ok(b)) return Math.max(0, Math.min(4, b)); } catch (e) { /* edges below */ }
  }
  const x = fin(v, 0.5);
  let b = 0;
  while (b < EDGES.length && x >= EDGES[b]) b++;
  return b;
}

/** The word for band b of trait k ("warlike"). */
export function bandWord(k, b) {
  const L = temperMod?.TEMPER_LABELS?.[k];
  const w = L && Array.isArray(L.bands) ? L.bands[b] : null;
  return typeof w === 'string' && w ? w : FALLBACK[k]?.[b] || '';
}

/** { trait: band word } for a traits object. */
export function bandsOf(traits) {
  const t = traits && typeof traits === 'object' ? traits : {};
  const out = {};
  for (const k of TEMPER_KEYS) out[k] = bandWord(k, bandIndex(t[k]));
  return out;
}

/** The strongest outer bands of a nation, strongest first: ["warlike", "devout"] (empty when every trait is middling). */
export function strongestBands(civ, n = 2) {
  if (!civ || !civ.traits) return [];
  if (typeof temperMod?.temperWords === 'function') {
    try { const r = temperMod.temperWords(civ, n); if (Array.isArray(r)) return r.filter((s) => typeof s === 'string' && s).slice(0, n); } catch (e) { /* ours below */ }
  }
  const t = civ.traits;
  return TEMPER_KEYS.map((k) => ({ k, v: fin(t[k], 0.5), b: bandIndex(t[k]) })).filter((x) => x.b !== MID_BAND)
    .sort((a, c) => Math.abs(c.v - 0.5) - Math.abs(a.v - 0.5)).slice(0, n).map((x) => bandWord(x.k, x.b));
}

/** "a" or "an" before a word. */
export const article = (wd) => (/^(?:[aeio]|u(?!ni|s[eu]))/i.test(String(wd || '')) ? 'an' : 'a');

// ---------------------------------------------------------------------------
// history: the founding temperament, the log of shifts and the 25-year samples

const scale01 = (vals) => { const m = Math.max(...vals.filter(ok)); return m > 1.5 ? vals.map((v) => v / 100) : vals; };

/** The temperament the people was born with ({ trait: 0–1 }), or null. */
function founding(civ) {
  const t0 = civ?.flags?.temper0;
  if (!t0 || typeof t0 !== 'object') return null;
  const raw = TEMPER_KEYS.map((k, j) => (Array.isArray(t0) ? t0[j] : t0[k]));
  if (!raw.every(ok)) return null;
  const v = scale01(raw);
  return Object.fromEntries(TEMPER_KEYS.map((k, j) => [k, v[j]]));
}

const cache = new WeakMap();   // civ → { sig, data }
/**
 * A nation's temperament history, normalised: { log: [{ day, trait, from, to, cause, seq? }]
 * (0–1, oldest first), hist: [[year, [8 values 0–100]]], base: { trait: 0–1 } | null }.
 * Read through the drift module's temperShifts when it exists; cached until the log or the
 * samples change.
 */
export function temperData(world, civ) {
  const rawLog = Array.isArray(civ?.temperLog) ? civ.temperLog : null;
  const rawHist = Array.isArray(civ?.flags?.temperHist) ? civ.flags.temperHist : null;
  const t0 = civ?.flags?.temper0;
  const sig = `${rawLog ? rawLog.length + ':' + (rawLog[0]?.day ?? '') + ':' + (rawLog[rawLog.length - 1]?.day ?? '') : '-'}|${rawHist ? rawHist.length + ':' + (rawHist[0]?.[0] ?? '') + ':' + (rawHist[rawHist.length - 1]?.[0] ?? '') : '-'}|${t0 ? 1 : 0}`;
  const hit = cache.get(civ);
  if (hit && hit.sig === sig) return hit.data;
  let log = rawLog, hist = rawHist;
  if (typeof temperMod?.temperShifts === 'function') {
    try {
      const r = temperMod.temperShifts(world, civ);
      if (Array.isArray(r)) log = r;
      else if (r && typeof r === 'object') {
        const L = r.log || r.temperLog || r.shifts;
        const H = r.hist || r.temperHist || r.history || r.samples;
        if (Array.isArray(L)) log = L;
        if (Array.isArray(H)) hist = H;
      }
    } catch (e) { /* read the civ's own fields */ }
  }
  const cleanLog = [];
  for (const e of log || []) {
    if (!e || !TEMPER_KEYS.includes(e.trait) || !ok(e.day) || !ok(e.from) || !ok(e.to)) continue;
    const big = Math.abs(e.from) > 1.5 || Math.abs(e.to) > 1.5;
    cleanLog.push({ day: e.day, trait: e.trait, from: big ? e.from / 100 : e.from, to: big ? e.to / 100 : e.to, cause: typeof e.cause === 'string' ? e.cause : '', seq: ok(e.seq) ? e.seq : null });
  }
  cleanLog.sort((a, b) => a.day - b.day);
  const cleanHist = [];
  for (const s of hist || []) {
    if (!Array.isArray(s) || !ok(s[0]) || !Array.isArray(s[1]) || s[1].length < TEMPER_KEYS.length) continue;
    const vals = s[1].slice(0, TEMPER_KEYS.length).map((v) => (ok(v) ? v : NaN));
    // samples are 0–100; accept 0–1 samples too
    const small = vals.every((v) => !ok(v) || Math.abs(v) <= 1.5);
    cleanHist.push([s[0], small ? vals.map((v) => v * 100) : vals]);
  }
  cleanHist.sort((a, b) => a[0] - b[0]);
  const data = { log: cleanLog, hist: cleanHist, base: founding(civ) };
  cache.set(civ, { sig, data });
  return data;
}

/** The year a nation's clock stops: now, or the year it fell. */
const civYear = (w, c) => yearOf(c.alive === false && ok(c.fallenDay) ? Math.min(w.time.day, c.fallenDay) : w.time.day);

/** How far each trait moved in the last `years` years (0–1 units), from the samples, or the log when there are none. */
function recentMoves(w, c, data, years = 50) {
  const now = civYear(w, c);
  const t0 = now - years;
  const out = {};
  const H = data.hist;
  if (H.length) {
    // the temperament at t0, interpolated between samples (the first sample when the record is younger)
    let ref = null;
    if (t0 <= H[0][0]) ref = H[0][1];
    else {
      for (let k = H.length - 1; k >= 0; k--) {
        if (H[k][0] <= t0) {
          const a = H[k], b = H[k + 1];
          if (!b) ref = a[1];
          else { const f = (t0 - a[0]) / Math.max(1, b[0] - a[0]); ref = a[1].map((v, j) => v + (b[1][j] - v) * f); }
          break;
        }
      }
    }
    // a record younger than ten years says nothing about recent change
    if (ref && now - Math.max(t0, H[0][0]) >= 10) {
      TEMPER_KEYS.forEach((k, j) => { if (ok(ref[j])) out[k] = fin(c.traits?.[k], 0.5) - ref[j] / 100; });
      return out;
    }
  }
  for (const e of data.log) if (yearOf(e.day) >= t0) out[e.trait] = fin(out[e.trait]) + (e.to - e.from);
  return out;
}

const ARROW_AT = 0.04, ARROW_STRONG = 0.1;

/**
 * One or two sentences reading a nation's temperament: its strongest bands, then how far it
 * has come from its founding. "Warlike and devout. Their founders were peaceable."
 */
export function temperReading(world, civ, data = null) {
  const t = civ?.traits || {};
  const top = strongestBands(civ, 2);
  const first = top.length ? `${F.headName(top.join(' and '))}.` : 'Even-tempered: no trait runs to an extreme.';
  const base = (data || temperData(world, civ)).base;
  if (!base) return first;
  let best = null;
  for (const k of TEMPER_KEYS) { const d = fin(t[k], 0.5) - base[k]; if (!best || Math.abs(d) > Math.abs(best.d) + 1e-9) best = { k, d }; }
  const ad = Math.abs(best.d);
  if (ad < 0.07) return `${first} Much as their founders were.`;
  const i0 = bandIndex(base[best.k]), i1 = bandIndex(t[best.k]);
  const pole = POLES[best.k][best.d > 0 ? 1 : 0];
  let second;
  // the founders' band, when the trait has left it (the middle band is the ordinary temper)
  if (i0 !== i1 && i0 !== MID_BAND) second = `Their founders were ${bandWord(best.k, i0)}.`;
  else if (i0 !== i1) second = `They were not ${bandWord(best.k, i1)} at their founding.`;
  else second = pole ? `${ad >= 0.2 ? 'Far more' : ad >= 0.12 ? 'More' : 'Somewhat more'} ${pole} than their founders.` : `${ad >= 0.2 ? 'Far less' : ad >= 0.12 ? 'Less' : 'Somewhat less'} ${POLES[best.k][1]} than their founders.`;
  return `${first} ${second}`;
}

/**
 * A logged shift as shown: { from, to, up }. A shift logged as it crossed into an outer band
 * starts from last year's value, so its ends can round alike ("80→80"); such a crossing always
 * moves outward, so its direction is its chronicle entry's tag or, without one, the side of the
 * middle it ended on.
 */
function shiftView(e, entry) {
  const tags = entry?.tags || [];
  const tagged = tags.includes('up') ? true : tags.includes('down') ? false : null;
  const up = Math.abs(e.to - e.from) >= 0.005 ? e.to > e.from : tagged ?? e.to >= 0.5;
  return { from: e.from, to: e.to, up };
}

/** "More peaceable" / "More warlike" for a move away from the middle (militarism has no plain low pole: "Less martial"). */
const morePole = (k, up) => (POLES[k][up ? 1 : 0] ? `More ${POLES[k][up ? 1 : 0]}` : `Less ${POLES[k][1]}`);
/** "Less warlike" / "Less peaceable" for a move back toward the middle. */
const lessPole = (k, fromHigh) => (fromHigh ? `Less ${POLES[k][1]}` : BACK_UP[k]);

/**
 * What a shift did, in words: "Became warlike" when it moved out into a band (or across the
 * middle), "Less devout" when it came back toward the middle, "More peaceable" within a band.
 */
export function shiftWords(e, v = null) {
  const { from, to, up } = v || shiftView(e, null);
  // the log keeps two decimals: nudge the end along the way it moved to recover a crossing at an edge
  const i1 = bandIndex(to + (up ? 0.005 : -0.005));
  // a crossing logged with ends that round alike came from the next band inward
  const i0 = Math.abs(to - from) < 0.015 ? Math.max(0, Math.min(4, i1 + (up ? -1 : 1))) : bandIndex(from);
  const d0 = i0 - MID_BAND, d1 = i1 - MID_BAND;
  if (i1 !== i0 && d1 !== 0 && (Math.sign(d1) !== Math.sign(d0) || Math.abs(d1) > Math.abs(d0))) return `Became ${bandWord(e.trait, i1)}`;
  // inward: back toward the middle from the side it was on
  if (d0 !== 0 && up === d0 < 0) return lessPole(e.trait, d0 > 0);
  return morePole(e.trait, up);
}

// ---------------------------------------------------------------------------
// chronicle links: the temper.shift entries about one nation, scanned incrementally

const entryCache = new WeakMap();   // civ → { w, seq, list }
const isTemperEntry = (e, id) => e && typeof e.key === 'string' && e.key.startsWith('temper') && ((e.ref && e.ref.k === 'civ' && e.ref.id === id) || (!e.ref && e.civId === id));
function temperEntries(w, civ) {
  const es = w.chronicle?.entries || [];
  const seq = w.chronicle?.seq ?? 0;
  let c = entryCache.get(civ);
  if (!c || c.w !== w || seq < c.seq) { c = { w, seq: -1, list: [] }; entryCache.set(civ, c); }
  if (seq !== c.seq) {
    const fresh = [];
    for (let k = es.length - 1; k >= 0; k--) { const e = es[k]; if (e.seq <= c.seq) break; if (isTemperEntry(e, civ.id)) fresh.push(e); }
    if (fresh.length) c.list = c.list.concat(fresh.reverse()).slice(-48);
    c.seq = seq;
  }
  return c.list;
}
/** The chronicle entry that tells of a shift (by seq, else the same trait within a year). */
function entryFor(w, civ, e) {
  const list = temperEntries(w, civ);
  if (!list.length) return null;
  if (e.seq != null) return list.find((q) => q.seq === e.seq) || null;
  const words = [POLES[e.trait][0], POLES[e.trait][1], bandWord(e.trait, bandIndex(e.to)), e.trait].filter(Boolean).map((q) => q.toLowerCase());
  let best = null, bd = Infinity;
  for (const q of list) {
    const d = Math.abs(q.day - e.day);
    if (d > DAYS_PER_YEAR) continue;
    const tags = (q.tags || []).map((s) => String(s).toLowerCase());
    const text = String(q.text || '').toLowerCase();
    const hit = tags.includes(e.trait) || words.some((wd) => tags.includes(wd) || text.includes(wd));
    const score = d + (hit ? 0 : DAYS_PER_YEAR * 2);
    if (score < bd) { bd = score; best = q; }
  }
  return best && bd <= DAYS_PER_YEAR ? best : null;
}

// ---------------------------------------------------------------------------
// the Inspector block

const ARROW_SVG = { up: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M5 1.5L9 7.5H1z" fill="currentColor"/></svg>', down: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M5 8.5L1 2.5h8z" fill="currentColor"/></svg>' };
const pts = (v) => Math.round(fin(v) * 100);
const signedPts = (v) => { const n = pts(v); return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0'; };

/**
 * The "Temperament" section's body for a nation: reading, trait bars, recent shifts, chart.
 * b: the record's Binder (live updates); returns the element.
 */
export function temperBlock(app, b, civ) {
  const w = app.world;
  const box = h('div.temper');
  const reading = h('p.tp-reading');
  b.text(reading, () => temperReading(w, civ));

  // --- a bar per trait
  const traits = h('div.tp-traits', { role: 'list', 'aria-label': 'Traits' });
  let lastMoves = null, lastMovesKey = '';
  const moves = () => {
    const d = temperData(w, civ);
    const key = `${civYear(w, civ)}:${d.hist.length}:${d.log.length}`;
    if (key !== lastMovesKey || !lastMoves) { lastMovesKey = key; lastMoves = recentMoves(w, civ, d); }
    return lastMoves;
  };
  b.list(traits, () => {
    const t = civ.traits || {};
    const base = temperData(w, civ).base;
    const mv = moves();
    return TEMPER_KEYS.map((k) => {
      const m = fin(mv[k]);
      return { k, v: fin(t[k], 0.5), bi: bandIndex(t[k]), b0: base ? base[k] : null, move: Math.abs(m) >= ARROW_AT ? m : 0 };
    });
  }, (x) => `${x.k}:${pts(x.v)}:${x.bi}:${x.b0 == null ? '' : pts(x.b0)}:${x.move ? Math.sign(x.move) * (Math.abs(x.move) >= ARROW_STRONG ? 2 : 1) : 0}`, (x) => traitRow(x));

  // --- recent shifts
  const shiftList = h('div.tp-shifts');
  b.list(shiftList, () => {
    const d = temperData(w, civ);
    return d.log.slice(-5).reverse().map((e) => { const entry = entryFor(w, civ, e); return { e, entry, v: shiftView(e, entry) }; });
  }, (x) => `${x.e.day}:${x.e.trait}:${pts(x.v.from)}:${pts(x.v.to)}:${x.v.up}:${x.e.cause}:${x.entry ? x.entry.seq : ''}`, (x) => shiftRow(app, x));
  const shiftBox = h('div.tp-part', null, h('h5.sub-head', { text: 'Recent shifts' }), shiftList);
  b.hide(shiftBox, () => !temperData(w, civ).log.length);

  // --- the traits that moved most, over the centuries
  const chart = new TimeChart({ title: '', height: 104, yMin: 0, yMax: 100, intTicks: true, yFormat: (v) => String(Math.round(v)), onPick: (y) => app.emit('timeTravel', y) });
  chart.el.classList.add('tp-chart');
  const chartHead = h('h5.sub-head');
  const chartBox = h('div.tp-part', null, chartHead, chart.el);
  let chartSig = null;
  const chartData = () => {
    const d = temperData(w, civ);
    const H = d.hist;
    if (H.length < 2) return null;
    const now = civYear(w, civ);
    // the samples, then today (or the fall), so every line ends at the present
    const xs = H.map((s) => s[0]);
    const cols = TEMPER_KEYS.map((k, j) => H.map((s) => s[1][j]));
    if (now > xs[xs.length - 1]) { xs.push(now); TEMPER_KEYS.forEach((k, j) => cols[j].push(fin(civ.traits?.[k], 0.5) * 100)); }
    const ranked = TEMPER_KEYS.map((k, j) => {
      const vals = cols[j].filter(ok);
      return { k, j, range: vals.length ? Math.max(...vals) - Math.min(...vals) : 0 };
    }).filter((r) => r.range >= 4).sort((a, b2) => b2.range - a.range || a.j - b2.j).slice(0, 3);
    if (!ranked.length) return null;
    return { xs, ranked, cols, d };
  };
  b.run(() => {
    const d = temperData(w, civ);
    const sig = `${d.hist.length}:${d.hist[d.hist.length - 1]?.[0] ?? ''}:${d.log.length}:${civYear(w, civ)}`;
    if (sig === chartSig) return;
    chartSig = sig;
    const cd = chartData();
    chartBox.hidden = !cd;
    if (!cd) return;
    const colors = [cssVar('--chart-1', '#bf8a2a'), cssVar('--chart-2', '#16a085'), cssVar('--chart-4', '#5a86e0')];
    const series = cd.ranked.map((r, n) => ({ label: traitName(r.k), color: colors[n], values: cd.cols[r.j] }));
    const colorOf = Object.fromEntries(cd.ranked.map((r, n) => [r.k, colors[n]]));
    const marks = cd.d.log.filter((e) => colorOf[e.trait]).map((e) => ({ y: yearOf(e.day), color: colorOf[e.trait], label: `${shiftWords(e, shiftView(e, null))} ${causeOf(e.cause)[1]}`.trim() }));
    // a window around the lines (at least 30 points tall) so a 15-point drift reads clearly
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const v of s.values) if (ok(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    lo = Math.max(0, Math.floor((lo - 4) / 10) * 10); hi = Math.min(100, Math.ceil((hi + 4) / 10) * 10);
    while (hi - lo < 30) { if (lo > 0) lo -= 10; if (hi - lo < 30 && hi < 100) hi += 10; }
    chart.o.yMin = lo; chart.o.yMax = hi;
    chartHead.textContent = cd.ranked.length === 1 ? 'The trait that moved most' : `The ${cd.ranked.length === 2 ? 'two' : 'three'} traits that moved most`;
    requestAnimationFrame(() => { chart.o.marks = marks; chart.setData({ xs: cd.xs, series }); });
  });

  box.append(reading, traits, shiftBox, chartBox);
  return box;
}

function traitRow(x) {
  const name = traitName(x.k);
  const vPct = (Math.max(0, Math.min(1, x.v)) * 100).toFixed(1) + '%';
  const bar = h('span.tp-bar', { 'aria-hidden': 'true', style: { '--v': vPct } }, h('span.tp-fill'));
  if (x.b0 != null) {
    const lo = Math.min(x.b0, x.v), hi = Math.max(x.b0, x.v);
    if (hi - lo >= 0.01) bar.appendChild(h('span.tp-gap', { class: x.v >= x.b0 ? 'is-gain' : 'is-loss', style: { left: (lo * 100).toFixed(1) + '%', width: ((hi - lo) * 100).toFixed(1) + '%' } }));
    bar.appendChild(h('span.tp-base', { style: { left: (Math.max(0, Math.min(1, x.b0)) * 100).toFixed(1) + '%' } }));
  }
  // the band word: the outer bands are the people's character, the middle its ordinary temper
  const word = bandWord(x.k, x.bi);
  const band = h('span.tp-band', { class: x.bi === MID_BAND ? 'is-mid' : x.bi === 0 || x.bi === 4 ? 'is-extreme' : '' }, h('span.tp-word', { text: word }));
  if (x.move) {
    const a = svgEl(ARROW_SVG[x.move > 0 ? 'up' : 'down']);
    const arrow = h('span.tp-arrow', { class: Math.abs(x.move) >= ARROW_STRONG ? 'is-strong' : '' }, a);
    band.appendChild(arrow);
  }
  const row = h('div.tp-row', { role: 'listitem' }, h('span.tp-name', { text: name }), bar, band);
  const parts = [`${pts(x.v)} of 100: ${word}.`];
  if (x.b0 != null) parts.push(`At the founding ${pts(x.b0)} (${bandWord(x.k, bandIndex(x.b0))}).`);
  if (x.move) parts.push(`${signedPts(x.move)} in the last fifty years.`);
  tip(row, parts.join(' '), name);
  return row;
}

function shiftRow(app, x) {
  const { e, entry, v } = x;
  const [icon, why] = causeOf(e.cause);
  const words = shiftWords(e, v);
  const kids = [
    h('span.y', { text: 'Y' + yearOf(e.day) }),
    h('span.ic', null, svgEl(glyph(icon, 16) || glyph('hourglass', 16))),
    h('span.t', null, h('b', { text: words }), why ? ` ${why}` : ''),
    h('span.n', { text: pts(v.from) === pts(v.to) ? `${v.up ? '↗' : '↘'}${pts(v.to)}` : `${pts(v.from)}→${pts(v.to)}` }),
  ];
  if (entry) kids.push(h('span.s', { text: entry.text }));
  const label = `${traitName(e.trait)}: ${words.toLowerCase()} ${why}, Year ${yearOf(e.day)}`.trim();
  if (!entry) return h('div.tp-shift', { 'aria-label': label }, ...kids);
  const row = h('button.tp-shift.is-link', { type: 'button' }, ...kids);
  tip(row, 'Read it in the Chronicle.', label);
  row.addEventListener('click', () => { app.setTab('chronicle'); app.emit('chronicleScrollTo', entry.seq); });
  return row;
}

// ---------------------------------------------------------------------------
// races (Mythic): how fast a people's temperament drifts, and which way it leans

/**
 * A race's drift multiplier (RACES[r].adapt) in plain words, or null when it has none:
 * { word: 'change quickly', phrase: 'they change quickly', speed: 'fast', detail: 'twice the common pace' }.
 */
export function driftWords(adapt) {
  if (!ok(adapt) || adapt <= 0) return null;
  const [word, phrase, speed] = adapt >= 1.6 ? ['change quickly', 'they change quickly', 'fast']
    : adapt >= 1.15 ? ['change readily', 'they change readily', 'brisk']
      : adapt > 0.85 ? ['change with the times', 'they change with the times', 'steady']
        : adapt >= 0.65 ? ['slow to change', 'they are slow to change', 'slow']
          : ['set in their ways', 'they are set in their ways', 'very slow'];
  const detail = Math.abs(adapt - 1) < 0.05 ? 'the common pace' : Math.abs(adapt - 2) < 0.05 ? 'twice the common pace' : Math.abs(adapt - 0.5) < 0.03 ? 'half the common pace' : `${F.num(adapt, 1)}× the common pace`;
  return { word, phrase, speed, detail };
}

/**
 * A race's temperament offsets ({ trait: ±delta from the middle }) as band words, strongest
 * first: ["inventive", "restless"] (a strong offset takes the outer band's word: "warlike").
 */
export function leanings(temper, n = 3) {
  if (!temper || typeof temper !== 'object') return [];
  return TEMPER_KEYS.map((k) => [k, fin(temper[k])]).filter(([, d]) => Math.abs(d) >= 0.075)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || TEMPER_KEYS.indexOf(a[0]) - TEMPER_KEYS.indexOf(b[0])).slice(0, n)
    .map(([k, d]) => bandWord(k, d > 0 ? (d >= 0.22 ? 4 : 3) : (d <= -0.22 ? 0 : 1)));
}
