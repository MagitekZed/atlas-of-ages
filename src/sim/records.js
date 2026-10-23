// The Hall of Records: the superlatives of a run — the largest city ever, the greatest empire,
// the bloodiest battle, the strongest quake, the longest reign — each with its five greatest
// holders and the history of the record being broken. Event records (battles, quakes, storms,
// famines…) are noted from hooks the moment they happen; standing records (cities, realms,
// reigns, dynasties, wars, faiths, plagues, roads, generals) by a yearly O(entities) scan.
// When a record falls by a clear margin after Year 100, the Chronicle says so (at most once
// per record every 25 years; the sentence is picked by day % n, never by rng).
//
//   world.sys.stats.records = { [key]: { top: [{ v, d, l, r, x, y, h?, c?, s? }] (≤ 5, best
//     first), br: [[day, v, label]] (≤ 8, oldest first), lb (day last announced), pa (an
//     overtaking waiting for its margin) } }
//     v value (days for spans) · d day · l label · r ref { k, id } · h holder key (standing
//     records: one entry per holder) · c civId · s value to show when v carries a tie-break
//
// Published (contracts §12): getRecords(world) → [{ key, group, label, fmt, top, br }].
// Also noteRecord(world, key, v, meta) for the other recorders (catalogue.js).

import { DAYS_PER_YEAR, DAYS_PER_MONTH, MONTH_SEASON, SEASONS } from '../core/constants.js';
import { chronicle } from '../core/chronicle.js';
import { on } from '../core/hooks.js';
import { nearestSettlement } from '../core/entities.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const TOP = 5, BREAKS = 8;
const MIN_YEAR = 100, COOLDOWN = 25 * DAYS_PER_YEAR, GLOBAL_GAP = 3 * DAYS_PER_YEAR;

/**
 * Record definitions. fmt: people | int | years (v in days) | area (tiles) | mag | vei | cat |
 * tiles | wars. margin: relative (or abs) lead needed before the Chronicle speaks; chron:
 * the record is headline news, and floor the size it must reach before it is (no one writes
 * of "the bloodiest battle ever" over a skirmish of tribesmen). cat: chronicle category.
 */
export const RECORDS = {
  'battle.dead': { group: 'war', label: 'Bloodiest battle', fmt: 'people', unit: 'dead', chron: true, margin: 0.15, floor: 800, cat: 'war' },
  'battle.engaged': { group: 'war', label: 'Greatest clash of arms', fmt: 'people', unit: 'engaged' },
  'war.dead': { group: 'war', label: 'Deadliest war', fmt: 'people', unit: 'dead', chron: true, margin: 0.2, floor: 8000, cat: 'war' },
  'war.long': { group: 'war', label: 'Longest war', fmt: 'years' },
  'war.battles': { group: 'war', label: 'Most battles in one war', fmt: 'int', unit: 'battles' },
  'rivals': { group: 'war', label: 'Eternal rivals', fmt: 'int', unit: 'wars' },
  'siege.days': { group: 'war', label: 'Longest siege', fmt: 'years' },
  'razer': { group: 'war', label: 'Most cities razed', fmt: 'int', unit: 'razed' },
  'general.wins': { group: 'war', label: 'Most victorious general', fmt: 'int', unit: 'victories' },
  'civ.peakPop': { group: 'realms', label: 'Most populous realm', fmt: 'people', unit: 'people', chron: true, margin: 0.2, floor: 100000, cat: 'civ' },
  'civ.peakLand': { group: 'realms', label: 'Greatest empire', fmt: 'area', chron: true, margin: 0.15, floor: 1500, cat: 'civ' },
  'civ.towns': { group: 'realms', label: 'Most settlements held', fmt: 'int', unit: 'towns' },
  'civ.age': { group: 'realms', label: 'Longest-lived nation', fmt: 'years' },
  'reign.long': { group: 'realms', label: 'Longest reign', fmt: 'years', chron: true, abs: 3 * DAYS_PER_YEAR, floor: 55 * DAYS_PER_YEAR, cat: 'civ' },
  'dynasty.long': { group: 'realms', label: 'Longest dynasty', fmt: 'years', chron: true, abs: 25 * DAYS_PER_YEAR, floor: 250 * DAYS_PER_YEAR, cat: 'civ' },
  'ruler.conquests': { group: 'realms', label: 'Greatest conqueror', fmt: 'int', unit: 'towns taken' },
  'city.peak': { group: 'cities', label: 'Largest city', fmt: 'people', unit: 'people', chron: true, margin: 0.15, floor: 12000, cat: 'civ' },
  'city.conquered': { group: 'cities', label: 'Most fought-over city', fmt: 'int', unit: 'conquests' },
  'city.age': { group: 'cities', label: 'Oldest city', fmt: 'years' },
  'faith.peak': { group: 'faith', label: 'Greatest faith', fmt: 'people', unit: 'faithful', chron: true, margin: 0.2, floor: 60000, cat: 'religion' },
  'faith.nations': { group: 'faith', label: 'Widest faith', fmt: 'int', unit: 'nations' },
  'plague.dead': { group: 'faith', label: 'Deadliest plague', fmt: 'people', unit: 'dead', chron: true, margin: 0.2, floor: 2500, cat: 'disease' },
  'plague.towns': { group: 'faith', label: 'Widest plague', fmt: 'int', unit: 'towns' },
  'quake.mag': { group: 'fury', label: 'Strongest earthquake', fmt: 'mag', chron: true, abs: 0.3, floor: 8, cat: 'disaster' },
  'quake.dead': { group: 'fury', label: 'Deadliest earthquake', fmt: 'people', unit: 'dead' },
  'eruption.vei': { group: 'fury', label: 'Greatest eruption', fmt: 'vei', chron: true, abs: 0.95, floor: 6, cat: 'disaster' },
  'eruption.dead': { group: 'fury', label: 'Deadliest eruption', fmt: 'people', unit: 'dead' },
  'storm.dead': { group: 'fury', label: 'Deadliest storm', fmt: 'people', unit: 'dead', chron: true, margin: 0.25, floor: 600, cat: 'disaster' },
  'storm.cat': { group: 'fury', label: 'Fiercest storm', fmt: 'cat' },
  'wave.dead': { group: 'fury', label: 'Deadliest wave', fmt: 'people', unit: 'dead' },
  'flood.dead': { group: 'fury', label: 'Deadliest flood', fmt: 'people', unit: 'dead' },
  'fire.tiles': { group: 'fury', label: 'Greatest wildfire', fmt: 'area' },
  'impact.r': { group: 'fury', label: 'Greatest falling star', fmt: 'crater' },
  'famine.dead': { group: 'fury', label: 'Worst famine', fmt: 'people', unit: 'dead', chron: true, margin: 0.25, floor: 1500, cat: 'civ' },
  'route.value': { group: 'trade', label: 'Richest trade road', fmt: 'int', unit: 'crowns a month' },
  'route.traffic': { group: 'trade', label: 'Busiest trade road', fmt: 'int', unit: 'loads carried' },
  'route.long': { group: 'trade', label: 'Oldest trade road', fmt: 'years' },
};
export const RECORD_GROUPS = [
  { id: 'war', label: 'War' }, { id: 'realms', label: 'Realms' }, { id: 'cities', label: 'Cities' },
  { id: 'faith', label: 'Faith and plague' }, { id: 'fury', label: 'Nature’s fury' }, { id: 'trade', label: 'Trade' },
];

function store(world) {
  const st = (world.sys.stats ||= {});
  if (!st.records || typeof st.records !== 'object') st.records = {};
  return st.records;
}

// ---------------------------------------------------------------------------
// Noting

/**
 * Offer a value for a record. meta: { label, ref?, x?, y?, holder? (standing records: one
 * entry per holder, updated in place when it grows), civId?, shown?, place? }.
 * Returns true when the value entered the top five.
 */
export function noteRecord(world, key, v, meta = {}) {
  const def = RECORDS[key];
  if (!def || !Number.isFinite(v) || v <= 0) return false;
  const recs = store(world);
  const rec = (recs[key] ||= { top: [], br: [] });
  const top = rec.top;
  const day = world.time.day;
  const h = meta.holder ?? null;
  const prev = top[0] || null;
  let entry = null;
  if (h != null) {
    const k = top.findIndex((t) => t.h === h);
    if (k >= 0) {
      if (v <= top[k].v) {
        // labels follow renames; values only ever grow
        if (meta.label && top[k].l !== meta.label) top[k].l = meta.label;
        return false;
      }
      entry = top[k];
      entry.v = v; entry.d = day; if (meta.label) entry.l = meta.label;
      if (meta.shown != null) entry.s = meta.shown;
      top.sort(byValue);
    }
  }
  if (!entry) {
    if (top.length >= TOP && v <= top[top.length - 1].v) return false;
    entry = { v, d: day, l: String(meta.label || '—') };
    if (meta.ref && meta.ref.k) entry.r = { k: meta.ref.k, id: meta.ref.id ?? null };
    if (Number.isFinite(meta.x) && Number.isFinite(meta.y)) { entry.x = Math.round(meta.x * 10) / 10; entry.y = Math.round(meta.y * 10) / 10; }
    if (h != null) entry.h = h;
    if (meta.civId != null && meta.civId >= 0) entry.c = meta.civId;
    if (meta.shown != null) entry.s = meta.shown;
    top.push(entry);
    top.sort(byValue);
    if (top.length > TOP) top.length = TOP;
    if (!top.includes(entry)) return false;
  }
  // a new holder at the head of the table: the record has fallen
  if (top[0] === entry && prev && prev !== entry && (h == null || prev.h !== h)) {
    // the jostling of the first few years is not history yet
    if (day >= 10 * DAYS_PER_YEAR) {
      rec.br.push([day, Math.round(v * 100) / 100, entry.l]);
      if (rec.br.length > BREAKS) rec.br.splice(0, rec.br.length - BREAKS);
    }
    rec.pa = { h: h ?? `e${day}`, pv: prev.v, pl: prev.l, pd: prev.d, ps: prev.s ?? null };
  }
  if (top[0] === entry && rec.pa && (h == null ? rec.pa.h === `e${day}` : rec.pa.h === h)) maybeAnnounce(world, key, def, rec, entry, meta);
  return true;
}
const byValue = (a, b) => b.v - a.v || a.d - b.d;

/** Chronicle a fallen record when its new holder leads by the margin (after Year 100, ≤ 1 per 25 years). */
function maybeAnnounce(world, key, def, rec, entry, meta) {
  if (!def.chron) { rec.pa = null; return; }
  const day = world.time.day;
  if (day < MIN_YEAR * DAYS_PER_YEAR) return;
  if (rec.lb != null && day - rec.lb < COOLDOWN) return;
  if (def.floor != null && (entry.s ?? entry.v) < def.floor) return;
  const st = (world.sys.stats ||= {});
  // one record-breaking story at a time across the whole Hall: the rest wait their turn
  if (st.rlb != null && day - st.rlb < GLOBAL_GAP) return;
  const pa = rec.pa;
  const lead = def.abs != null ? entry.v >= pa.pv + def.abs : entry.v >= pa.pv * (1 + (def.margin ?? 0.1));
  if (!lead) return;
  rec.lb = day;
  rec.pa = null;
  st.rlb = day;
  (st.rq ||= []).push({ key, v: entry.s ?? entry.v, l: entry.l, r: entry.r || null, x: entry.x ?? null, y: entry.y ?? null, c: entry.c ?? meta.civId ?? null, pv: pa.ps ?? pa.pv, pl: pa.pl, pd: pa.pd, place: meta.place || null });
}

// ---------------------------------------------------------------------------
// Chronicle prose for fallen records (flushed by stats.update at the end of the day)

const FMT = {
  people: (v) => fmtInt(v),
  int: (v) => fmtInt(v),
  years: (v) => yearsText(v),
  area: (v) => `${fmtInt(v * 400)} square kilometres`,
  mag: (v) => `magnitude ${v.toFixed(1)}`,
  vei: (v) => `the ${['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][Math.max(1, Math.min(8, Math.floor(v)))]} degree`,
  cat: (v) => `category ${Math.floor(v)}`,
  crater: (v) => `a crater ${fmtInt(v * 2 * 20)} kilometres wide`,
};
function fmtInt(v) {
  const n = Math.round(fin(v));
  return String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function yearsText(days) {
  const y = Math.floor(fin(days) / DAYS_PER_YEAR);
  return y === 1 ? 'a year' : `${fmtInt(y)} years`;
}
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);
function season(world, day, y) {
  const s = MONTH_SEASON[Math.floor(day / DAYS_PER_MONTH) % 12];
  return SEASONS[y != null && world.H && y >= world.H / 2 ? (s + 2) % 4 : s].toLowerCase();
}
function rulerOf(world, civId) {
  const c = civId != null ? world.civs[civId] : null;
  const r = c && c.alive !== false ? c.ruler : null;
  return r ? rulerDisplay(r) : null;
}

/** Sentence pools per record: (t) → string, t = { H, V, P, PV, PY, Y, S, R, K, L }. */
const PROSE = {
  'battle.dead': [
    (t) => `No field had ever drunk so much blood: ${t.H}, fought in the ${t.S} of Year ${t.Y}, left ${t.V} dead, more than fell at ${t.P} in Year ${t.PY}.`,
    (t) => `${cap1(t.H)} became the bloodiest battle in the memory of the world, ${t.V} slain${t.L ? ` near ${t.L}` : ''}; the old tale of ${t.P} was a lesser grief now.`,
    (t) => `Bards who had sung of ${t.P} fell silent after ${t.H}: ${t.V} dead, the greatest slaughter ever reckoned.`,
  ],
  'war.dead': [
    (t) => `${cap1(t.H)} had now cost ${t.V} lives, the deadliest war ever waged, surpassing ${t.P}.`,
    (t) => `By Year ${t.Y} the dead of ${t.H} numbered ${t.V}; no war before, not even ${t.P}, had taken so many.`,
    (t) => `${cap1(t.H)} outgrew every war before it in ruin: ${t.V} fallen, where ${t.P} had claimed ${t.PV}.`,
  ],
  'civ.peakPop': [
    (t) => `${cap1(t.H)} now numbered ${t.V} souls, the most populous realm the world had known, greater than ${t.P} at its height.`,
    (t) => `The census of Year ${t.Y} counted ${t.V} subjects of ${t.H}${t.K ? ` under ${t.K}` : ''}: never had so many lived under one crown, not even in ${t.P}.`,
    (t) => `No people had ever been so many as ${t.H}: ${t.V}, eclipsing the ${t.PV} of ${t.P}.`,
  ],
  'civ.peakLand': [
    (t) => `${cap1(t.H)} stretched across ${t.V}, the widest dominion in the memory of the world, surpassing ${t.P}.`,
    (t) => `${t.K ? `Under ${t.K}, ` : ''}${t.H} came to rule more land than any realm before it: ${t.V}, more than ${t.P} had ever held.`,
    (t) => `Mapmakers of Year ${t.Y} drew ${t.H} wider than ${t.P} at its greatest: ${t.V} under one rule.`,
  ],
  'reign.long': [
    (t) => `${cap1(t.H)} had reigned ${t.V}, longer than any ruler before; even ${t.P} had held the throne for less.`,
    (t) => `In Year ${t.Y} ${t.H} passed ${t.P} as the longest-reigning ruler the world had known: ${t.V} on the throne.`,
    (t) => `No crown had ever rested so long on one head: ${t.H}, ${t.V} and counting.`,
  ],
  'dynasty.long': [
    (t) => `${cap1(t.H)} had held power for ${t.V}, the longest line of rulers in the world's memory, outlasting ${t.P}.`,
    (t) => `With ${t.V} of rule behind it, ${t.H} became the oldest dynasty ever known, older than ${t.P}.`,
    (t) => `${cap1(t.H)} now outlasted ${t.P}: ${t.V} of one blood on the throne.`,
  ],
  'city.peak': [
    (t) => `In the ${t.S} of Year ${t.Y} ${t.H} counted ${t.V} people, more than any city before it; ${t.P} at its height had held ${t.PV}.`,
    (t) => `Travellers called ${t.H}${t.R ? ` of ${t.R}` : ''} the greatest city under heaven, and the census bore them out: ${t.V} souls, more than ${t.P} had ever known.`,
    (t) => `${cap1(t.H)} grew past ${t.P} to become the largest city the world had seen, with ${t.V} people within its bounds.`,
  ],
  'faith.peak': [
    (t) => `${cap1(t.H)} now counted ${t.V} faithful, the greatest following any creed had ever gathered, more than ${t.P}.`,
    (t) => `Never had so many bowed to one faith: ${t.V} followed ${t.H} in Year ${t.Y}, surpassing ${t.P}.`,
    (t) => `${cap1(t.H)} outgrew ${t.P} as the faith of the multitude, ${t.V} strong.`,
  ],
  'plague.dead': [
    (t) => `${cap1(t.H)} had killed ${t.V}, a greater dying than ${t.P} or any sickness before it.`,
    (t) => `Gravediggers who remembered ${t.P} said ${t.H} was worse, and they were right: ${t.V} dead.`,
    (t) => `The toll of ${t.H} reached ${t.V}, the deadliest plague the world had known.`,
  ],
  'quake.mag': [
    (t) => `The earth had never shaken so hard: ${t.H} in the ${t.S} of Year ${t.Y} reached ${t.V}, beyond even ${t.P}.`,
    (t) => `${cap1(t.H)} was the mightiest quake ever felt, ${t.V}${t.L ? `, its heart beneath ${t.L}` : ''}; ${t.P} had been a lesser tremor.`,
    (t) => `Wise men measured ${t.H} at ${t.V} and could find no greater shaking in any record, not even ${t.P}.`,
  ],
  'eruption.vei': [
    (t) => `${cap1(t.H)} erupted in a blast of ${t.V}, the greatest the world had witnessed, greater than ${t.P}.`,
    (t) => `In Year ${t.Y} ${t.H} tore itself open in an eruption of ${t.V}, mightier than anything since ${t.P}.`,
    (t) => `No mountain had ever burst like ${t.H}: an eruption of ${t.V}, eclipsing ${t.P}.`,
  ],
  'storm.dead': [
    (t) => `${cap1(t.H)} was the deadliest storm ever recorded, ${t.V} drowned and crushed, more than ${t.P} had taken.`,
    (t) => `Sailors spoke of ${t.P} no more after ${t.H}: ${t.V} dead in a single ${t.S}.`,
    (t) => `${cap1(t.H)} left ${t.V} dead${t.L ? ` along the coasts near ${t.L}` : ''}, the cruellest storm in the memory of the world.`,
  ],
  'famine.dead': [
    (t) => `${cap1(t.H)} was the worst famine ever known: ${t.V} starved, more than in ${t.P}.`,
    (t) => `In Year ${t.Y} ${t.V} died in ${t.H}; no hunger before, not even ${t.P}, had been so cruel.`,
    (t) => `The granaries failed as never before: ${t.H} took ${t.V} lives, eclipsing ${t.P}.`,
  ],
};

/** Write the queued record announcements (called by stats.update at the end of the day). */
export function flushRecordNews(world) {
  const st = world.sys.stats;
  if (!st || !Array.isArray(st.rq) || !st.rq.length) return;
  const q = st.rq;
  st.rq = [];
  const day = world.time.day;
  for (const n of q) {
    const def = RECORDS[n.key];
    const pool = PROSE[n.key];
    if (!def || !pool) continue;
    const fmt = FMT[def.fmt] || FMT.int;
    const civ = n.c != null ? world.civs[n.c] : null;
    const t = {
      H: mid(n.l), V: fmt(n.v), P: mid(n.pl), PV: fmt(n.pv), PY: yearOf(n.pd), Y: yearOf(day),
      S: season(world, day, n.y), R: civ ? theCiv(civ) : null, K: rulerOf(world, n.c), L: n.place,
    };
    const text = pool[day % pool.length](t);
    chronicle(world, {
      cat: def.cat || 'civ', imp: 3, text, key: 'record.broken', tags: ['record', n.key],
      x: n.x != null ? Math.round(n.x) : null, y: n.y != null ? Math.round(n.y) : null,
      civId: n.c ?? null, sid: n.r && n.r.k === 'settlement' ? n.r.id : null,
      ref: n.r || null, cause: causeOf(world, n, day),
    });
  }
}

/** The entry this record grew out of: the same day's entry about the same thing, if any. */
function causeOf(world, n, day) {
  const es = world.chronicle.entries;
  for (let k = es.length - 1, seen = 0; k >= 0 && seen < 40; k--, seen++) {
    const e = es[k];
    if (e.day !== day) break;
    if (e.key === 'record.broken') continue;
    if (n.r && e.ref && e.ref.k === n.r.k && e.ref.id === n.r.id) return e.seq;
    if (n.x != null && e.x != null && Math.abs(e.x - n.x) <= 1.5 && Math.abs(e.y - n.y) <= 1.5 && e.imp >= 2) return e.seq;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event-time records from hooks

const placeOf = (world, x, y) => nearestSettlement(world, x, y, { maxDist: 6 })?.name ?? null;

export const HANDLERS = {
  battle(world, b) {
    if (!b) return;
    const dead = fin(b.dead?.a) + fin(b.dead?.d);
    const place = placeOf(world, fin(b.x), fin(b.y));
    const label = b.name || (place ? `the fighting near ${place}` : 'a nameless battle');
    const ref = b.warId != null ? { k: 'war', id: b.warId } : b.bandId != null ? { k: 'band', id: b.bandId } : null;
    const meta = { label, ref, x: b.x, y: b.y, civId: b.winnerCivId, place };
    if (dead > 0) noteRecord(world, 'battle.dead', dead, meta);
    if (fin(b.engaged) > 0) noteRecord(world, 'battle.engaged', fin(b.engaged), meta);
  },
  siegeEnded(world, q) {
    if (!q) return;
    const s = world.settlements[q.sid];
    if (!s) return;
    const days = fin(q.days);
    const att = world.civs[q.civId];
    if (days >= 30) noteRecord(world, 'siege.days', days, { label: `the siege of ${s.name}`, ref: { k: 'settlement', id: s.id }, x: s.x, y: s.y, civId: q.civId, place: s.name });
    if (q.outcome === 'razed' && att) {
      const st = (world.sys.stats ||= {});
      const rz = (st.razed ||= {});
      rz[att.id] = (rz[att.id] | 0) + 1;
      noteRecord(world, 'razer', rz[att.id], { label: theCiv(att), ref: { k: 'civ', id: att.id }, holder: 'c' + att.id, civId: att.id });
    }
  },
  plagueEnded(world, p) {
    if (!p) return;
    notePlague(world, p);
  },
};
for (const [name, fn] of Object.entries(HANDLERS)) on(name, fn);

function notePlague(world, p) {
  const s = world.settlements[p.originSid];
  const meta = { label: p.name, ref: { k: 'plague', id: p.id }, holder: 'p' + p.id, x: s?.x, y: s?.y, civId: p.originCivId ?? s?.civId, place: s?.name };
  if (fin(p.deaths) >= 1) noteRecord(world, 'plague.dead', Math.round(fin(p.deaths)), meta);
  if (fin(p.hit) > 0) noteRecord(world, 'plague.towns', fin(p.hit), meta);
}

// ---------------------------------------------------------------------------
// Standing records (yearly scan, O(entities))

/** "the Kingdom of Varath" mid-sentence (styled names take an article), as civ/prose.js does. */
export function theCiv(c) {
  if (!c) return 'a forgotten people';
  const n = c.name || c.baseName || 'a forgotten people';
  if (/^the\s/i.test(n)) return 'the ' + n.slice(4);
  return c.flags?.styled || /\s/.test(n) ? 'the ' + n : n;
}
/** A name as it reads mid-sentence ("The Salt War" → "the Salt War"). */
export const mid = (s) => (typeof s === 'string' ? s.replace(/^The\s/, 'the ') : s);
const ROMAN = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
function roman(n) { let out = ''; for (const [v, r] of ROMAN) while (n >= v) { out += r; n -= v; } return out; }
/** "Queen Ilsa II the Wise" */
export function rulerDisplay(r) {
  if (!r) return 'a ruler';
  if (r.display) return r.display + (r.epithet && !String(r.display).includes(r.epithet) ? ' ' + r.epithet : '');
  const reg = r.regnal > 1 && r.regnal < 40 ? ' ' + roman(r.regnal) : '';
  return `${r.title ? r.title + ' ' : ''}${r.name || 'a ruler'}${reg}${r.epithet ? ' ' + r.epithet : ''}`;
}
const civName = (world, id) => theCiv(world.civs[id]);
function rulerLabel(world, c, r) { return `${rulerDisplay(r)} of ${theCiv(c)}`; }
// a reign is known by its realm and the day it began: stable whether the ruler reigns or is archived
const rulerKey = (c, r) => (Number.isFinite(r.reignStart) ? `r${c.id}:${r.reignStart}` : 'r' + r.id);
const rulerRef = (c, r) => ({ k: 'ruler', id: Number.isFinite(r.reignStart) ? `${c.id}:${r.reignStart}` : r.id });

/** Cheap gate: would v enter the table at all? */
function could(world, key, v) {
  const rec = world.sys.stats?.records?.[key];
  return !rec || rec.top.length < TOP || v > rec.top[rec.top.length - 1].v;
}

/**
 * The yearly scan for standing records. part (0–3) takes one quarter of the work each year —
 * cities; realms, reigns and dynasties; wars, rivalries, faiths and plagues; roads and generals —
 * so every standing record is refreshed every four years; null scans everything.
 */
export function scanRecords(world, part = null) {
  const day = world.time.day;
  const all = part == null;
  // A record that closed before this part's last scan was noted with its final values then;
  // values only grow and labels of the dead do not change, so it is not walked again (the
  // world keeps every town, realm, war and road it ever had). Scan days live in sys.stats.rsc.
  const st = world.sys.stats || (world.sys.stats = {});
  const rsc = Array.isArray(st.rsc) ? st.rsc : (st.rsc = [-1, -1, -1, -1]);
  const seen = (k) => (all ? -1 : fin(rsc[k], -1));
  const closedBefore = (d, k) => Number.isFinite(d) && d < seen(k);
  // cities
  if (all || part === 0) for (const s of world.settlements) {
    if (!s) continue;
    if (!s.alive && closedBefore(s.destroyedDay, 0)) continue;
    const ref = { k: 'settlement', id: s.id }, h = 's' + s.id;
    const meta = { label: s.name, ref, holder: h, x: s.x, y: s.y, civId: s.civId, place: s.name };
    if (could(world, 'city.peak', fin(s.peakPopulation)) || isHolder(world, 'city.peak', h)) noteRecord(world, 'city.peak', Math.round(fin(s.peakPopulation)), meta);
    const own = Array.isArray(s.own) ? s.own : [];
    let cq = 0;
    for (let k = 1; k < own.length; k++) if (own[k][2] === 'c') cq++;
    cq = Math.max(cq, fin(s.hist?.conquered));
    if (cq >= 2) noteRecord(world, 'city.conquered', cq, meta);
    const age = (s.alive ? day : fin(s.destroyedDay, day)) - fin(s.foundedDay);
    if (age > 0 && (could(world, 'city.age', age) || isHolder(world, 'city.age', h))) noteRecord(world, 'city.age', age, meta);
  }
  // realms, reigns, dynasties
  if (all || part === 1) for (const c of world.civs) {
    if (!c) continue;
    if (!c.alive && closedBefore(c.fallenDay, 1)) continue;
    const ref = { k: 'civ', id: c.id }, h = 'c' + c.id;
    const meta = { label: theCiv(c), ref, holder: h, civId: c.id };
    noteRecord(world, 'civ.peakPop', Math.round(fin(c.peakPopulation)), meta);
    noteRecord(world, 'civ.peakLand', Math.round(fin(c.peakTerritory)), meta);
    if (c.alive) noteRecord(world, 'civ.towns', (c.settlementIds || []).length, meta);
    noteRecord(world, 'civ.age', (c.alive ? day : fin(c.fallenDay, day)) - fin(c.foundedDay), meta);
    const rulers = Array.isArray(c.rulerHistory) ? c.rulerHistory : [];
    for (const r of rulers) noteRuler(world, c, r, fin(r.reignEnd ?? r.end, NaN));
    if (c.ruler && c.alive) noteRuler(world, c, c.ruler, day);
    const dy = c.flags?.dynasty;
    if (dy && dy.name && c.alive && Number.isFinite(dy.since)) {
      const v = day - dy.since;
      if (v > 0) noteRecord(world, 'dynasty.long', v, { label: dynastyLabel(dy.name, c), ref: { k: 'dynasty', id: `${c.id}:${dy.name}` }, holder: `d${c.id}:${dy.name}:${dy.since}`, civId: c.id });
    }
  }
  const dyn = world.sys.civ?.dynasties;
  if ((all || part === 1) && Array.isArray(dyn)) {
    for (let k = 0; k < dyn.length; k++) {
      const d = dyn[k];
      if (!d || !d.name || !Number.isFinite(d.start) || closedBefore(d.end, 1)) continue;
      const v = fin(d.end, day) - d.start;
      const c = world.civs[d.civId];
      if (v > 0) noteRecord(world, 'dynasty.long', v, { label: dynastyLabel(d.name, c), ref: { k: 'dynasty', id: k }, holder: `d${d.civId}:${d.name}:${d.start}`, civId: d.civId });
    }
  }
  if (all || part === 2) scanWarsFaiths(world, day, seen(2));
  if (all || part === 3) scanRoadsGenerals(world, day, seen(3));
  if (!all) rsc[part] = day;
}

function scanWarsFaiths(world, day, seen = -1) {
  // wars and rivalries (every war counts toward a rivalry; one over before the last scan has
  // its own records already)
  const pairs = new Map();
  for (const w of world.wars) {
    if (!w) continue;
    const a0 = w.attackers[0], b0 = w.defenders[0];
    if (!w.active && Number.isFinite(w.endDay) && w.endDay < seen) {
      if (a0 != null && b0 != null && a0 !== b0) { const key = a0 < b0 ? `${a0}-${b0}` : `${b0}-${a0}`; pairs.set(key, (pairs.get(key) || 0) + 1); }
      continue;
    }
    const ref = { k: 'war', id: w.id }, h = 'w' + w.id;
    let dead = 0;
    for (const k in w.casualties || {}) dead += fin(w.casualties[k]);
    const meta = { label: mid(w.name), ref, holder: h, civId: w.attackers[0] };
    if (dead >= 1) noteRecord(world, 'war.dead', Math.round(dead), meta);
    noteRecord(world, 'war.long', (w.active ? day : fin(w.endDay, day)) - fin(w.startDay), meta);
    if (fin(w.battles) > 0) noteRecord(world, 'war.battles', fin(w.battles), meta);
    const a = w.attackers[0], b = w.defenders[0];
    if (a != null && b != null && a !== b) {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      pairs.set(key, (pairs.get(key) || 0) + 1);
    }
  }
  for (const [key, n] of pairs) {
    if (n < 2) continue;
    const [a, b] = key.split('-').map(Number);
    noteRecord(world, 'rivals', n, { label: `${civName(world, a)} and ${civName(world, b)}`, ref: { k: 'civ', id: a }, holder: 'v' + key, civId: a });
  }
  // faiths, plagues
  for (const r of world.religions) {
    if (!r) continue;
    const meta = { label: r.name, ref: { k: 'religion', id: r.id }, holder: 'f' + r.id, civId: r.founderCivId };
    noteRecord(world, 'faith.peak', Math.round(fin(r.peakFollowers, fin(r.followers))), meta);
    if (fin(r.nations) > 0) noteRecord(world, 'faith.nations', fin(r.nations), meta);
  }
  for (const p of world.plagues) if (p && !p.active) notePlague(world, p);
}

function scanRoadsGenerals(world, day, seen = -1) {
  // trade roads
  // (the label is built only for a road that may enter or holds a table: there are thousands;
  // a road closed before the last scan has its records already)
  for (const rt of world.tradeRoutes) {
    if (!rt || (!rt.active && Number.isFinite(rt.endDay) && rt.endDay < seen)) continue;
    const holder = 't' + rt.id;
    const pv = Math.round(fin(rt.peakValue, fin(rt.value)));
    const tr = Math.round(fin(rt.traffic));
    const life = (rt.active ? day : fin(rt.endDay, day)) - fin(rt.establishedDay, day);
    const okV = pv > 0 && (could(world, 'route.value', pv) || isHolder(world, 'route.value', holder));
    const okT = tr > 0 && (could(world, 'route.traffic', tr) || isHolder(world, 'route.traffic', holder));
    const okL = life > 0 && (could(world, 'route.long', life) || isHolder(world, 'route.long', holder));
    if (!okV && !okT && !okL) continue;
    const a = world.settlements[rt.aId], b = world.settlements[rt.bId];
    const label = rt.name || (a && b ? `the road from ${a.name} to ${b.name}` : 'a trade road');
    const meta = { label, ref: { k: 'route', id: rt.id }, holder, civId: rt.civA, x: a?.x, y: a?.y };
    if (okV) noteRecord(world, 'route.value', pv, meta);
    if (okT) noteRecord(world, 'route.traffic', tr, meta);
    if (okL) noteRecord(world, 'route.long', life, meta);
  }
  // generals
  for (const f of world.figures) {
    if (!f || f.kind !== 'general') continue;
    let wins = fin(f.wins);
    if (!wins && Array.isArray(f.deeds)) for (const d of f.deeds) if (typeof d === 'string' && /^won\b/i.test(d)) wins++;
    if (wins >= 2) noteRecord(world, 'general.wins', wins, { label: f.name + (world.civs[f.civId] ? ` of ${theCiv(world.civs[f.civId])}` : ''), ref: { k: 'figure', id: f.id }, holder: 'g' + f.id, civId: f.civId });
  }
}

/** "the House of Dree of the Kingdom of Varath" style labels for a dynasty. */
function dynastyLabel(name, c) {
  // "House of Rivu", "House Rivu" and "Rivu dynasty" all read as "the House of Rivu"
  const root = String(name || '').replace(/^(the\s+)?house\s+(of\s+)?/i, '').replace(/\s+dynasty$/i, '').trim();
  const base = root ? `the House of ${root}` : 'a dynasty';
  return c ? `${base} of ${theCiv(c)}` : base;
}

function isHolder(world, key, h) {
  const rec = world.sys.stats?.records?.[key];
  return Boolean(rec && rec.top.some((t) => t.h === h));
}

function noteRuler(world, c, r, end) {
  if (!r || !Number.isFinite(r.reignStart)) return;
  const v = (Number.isFinite(end) ? end : world.time.day) - r.reignStart;
  const h = rulerKey(c, r);
  if (v > 0 && (could(world, 'reign.long', v) || isHolder(world, 'reign.long', h))) noteRecord(world, 'reign.long', v, { label: rulerLabel(world, c, r), ref: rulerRef(c, r), holder: h, civId: c.id });
  const cq = fin(r.deeds?.conquests);
  if (cq >= 2) noteRecord(world, 'ruler.conquests', cq, { label: rulerLabel(world, c, r), ref: rulerRef(c, r), holder: h, civId: c.id });
}

// ---------------------------------------------------------------------------
// Reading (pure)

/** Every record with holders, in RECORDS order: [{ key, group, label, fmt, unit, top, br }]. */
export function getRecords(world) {
  const recs = world?.sys?.stats?.records || {};
  const out = [];
  for (const [key, def] of Object.entries(RECORDS)) {
    const r = recs[key];
    out.push({ key, group: def.group, label: def.label, fmt: def.fmt, unit: def.unit || '', top: r ? r.top.slice() : [], br: r ? r.br.slice() : [] });
  }
  return out;
}

/** Records broken within [fromDay, toDay]: [{ key, label, day, v, holder }] (digests). */
export function recordsBroken(world, fromDay, toDay) {
  const out = [];
  const recs = world?.sys?.stats?.records || {};
  for (const [key, r] of Object.entries(recs)) {
    const def = RECORDS[key];
    if (!def) continue;
    for (const [d, v, l] of r.br || []) if (d >= fromDay && d <= toDay) out.push({ key, label: def.label, fmt: def.fmt, day: d, v, holder: l });
  }
  return out.sort((a, b) => a.day - b.day);
}
