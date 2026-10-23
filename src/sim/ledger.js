// The entity ledger: a whole-life time series for every city, nation, faith, war, plague,
// army and band, plus each settlement's chain of title. Run from the stats system (order 100)
// so it samples each finished day; read-only on the rest of the world and draws no rng.
//
//   world.history.series = { s, c, r, w, a, p, b }   kind → { [id]: ser }
//   ser = { t0, st, v: [flat ints, row-major], p: [pending bucket] | null, pn, e }
//     t0 first sample day · st days per sample · v[k·ch + j] channel j of sample k (stored
//     ints, see CHANNELS for the scale) · p / pn the bucket being gathered · e the day the
//     entity ended (frozen) or null
// Doubling-step decimation: a series holds at most K = 40 samples per channel; when it is
// full, adjacent pairs merge (averaged, or the max for peak and toll channels, or the last
// for positions) and the step doubles, so memory is bounded by the number of entities, not
// by their age. Dead entities freeze; small dead towns drop their series after 100 years;
// disbanded armies and destroyed bands keep theirs for a while (capped), then go.
//
// Published (contracts §12): series(world, kind, id) → { t0, st, ch, v, end } | null, where
// v[k] = [value of each channel] for sample k (day t0 + k·st) in natural units (fractions
// 0..1 for health, stability, morale…; tiles for x and y), the gathering bucket included as
// the newest sample; ownerChain(world, sid) → [{ day, civId, code, how }].

import { DAYS_PER_YEAR } from '../core/constants.js';
import { on } from '../core/hooks.js';

export const LEDGER_K = 40;
/** Days of history after which a small dead town's series is dropped. */
const DROP_SMALL_TOWN_DAYS = 100 * DAYS_PER_YEAR;
const SMALL_TOWN_PEAK = 1500;
const SMALL_WAR_DEAD = 5000;
const KEEP_ENDED_ARMY_DAYS = 40 * DAYS_PER_YEAR, MAX_ENDED_ARMIES = 64;
const KEEP_ENDED_BAND_DAYS = 120 * DAYS_PER_YEAR, MAX_ENDED_BANDS = 64;
export const OWN_CAP = 16;

/**
 * Channels per kind: [name, scale (stored int = round(value × scale)), agg ('avg' | 'max' |
 * 'last')], plus the base cadence in days. Labels are for the UI.
 */
export const CHANNELS = {
  s: { base: DAYS_PER_YEAR, label: 'settlement', ch: [
    ['pop', 1, 'avg', 'People'], ['wealth', 1, 'avg', 'Wealth'], ['trade', 10, 'avg', 'Trade / mo'],
    ['health', 100, 'avg', 'Health'], ['happiness', 100, 'avg', 'Happiness'], ['unrest', 100, 'avg', 'Unrest'],
    ['defense', 10, 'avg', 'Defence'], ['culture', 10, 'avg', 'Culture']] },
  c: { base: DAYS_PER_YEAR, label: 'civ', ch: [
    ['pop', 1, 'avg', 'People'], ['land', 1, 'avg', 'Lands (tiles)'], ['towns', 1, 'avg', 'Settlements'],
    ['treasury', 1, 'avg', 'Treasury'], ['stability', 100, 'avg', 'Stability'], ['manpower', 1, 'avg', 'Manpower'],
    ['era', 1, 'max', 'Era'], ['army', 1, 'max', 'Soldiers in the field'], ['wars', 1, 'max', 'Wars'],
    ['prestige', 10, 'avg', 'Prestige']] },
  r: { base: DAYS_PER_YEAR, label: 'religion', ch: [
    ['followers', 1, 'avg', 'Followers'], ['towns', 1, 'avg', 'Towns'], ['nations', 1, 'max', 'Nations'],
    ['fervor', 100, 'avg', 'Fervour']] },
  w: { base: 30, label: 'war', ch: [
    ['score', 10, 'avg', 'War score'], ['casA', 1, 'max', 'Attackers fallen'], ['casD', 1, 'max', 'Defenders fallen'],
    ['occA', 1, 'max', 'Towns held by attackers'], ['occD', 1, 'max', 'Towns held by defenders'],
    ['menA', 1, 'avg', 'Attackers in the field'], ['menD', 1, 'avg', 'Defenders in the field']] },
  p: { base: 30, label: 'plague', ch: [
    ['infected', 1, 'max', 'Sick'], ['towns', 1, 'max', 'Towns stricken'], ['deaths', 1, 'max', 'Dead']] },
  a: { base: 10, label: 'army', ch: [
    ['strength', 1, 'avg', 'Strength'], ['morale', 100, 'avg', 'Morale'], ['supply', 100, 'avg', 'Supply'],
    ['x', 10, 'last', 'x'], ['y', 10, 'last', 'y']] },
  b: { base: 30, label: 'band', ch: [
    ['strength', 1, 'avg', 'Strength'], ['hp', 100, 'avg', 'Vigour'], ['morale', 100, 'avg', 'Morale'],
    ['loot', 1, 'max', 'Loot'], ['x', 10, 'last', 'x'], ['y', 10, 'last', 'y']] },
};
export const LEDGER_KINDS = Object.keys(CHANNELS);

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The series store, created on demand (old saves have none). */
export function seriesStore(world) {
  const h = world.history || (world.history = { years: [], atlas: [] });
  let s = h.series;
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = h.series = {};
  for (const k of LEDGER_KINDS) if (!s[k] || typeof s[k] !== 'object') s[k] = {};
  return s;
}

// ---------------------------------------------------------------------------
// Pushing samples

/** Fold one base-cadence sample (scratch array of natural values) into a series. */
function push(world, kind, id, vals, day) {
  const spec = CHANNELS[kind];
  const C = spec.ch.length;
  const store = seriesStore(world)[kind];
  let ser = store[id];
  if (!ser) ser = store[id] = { t0: day, st: spec.base, v: [], p: null, pn: 0, e: null };
  if (ser.e != null) return;   // frozen
  const p = ser.p || (ser.p = new Array(C).fill(0));
  for (let j = 0; j < C; j++) {
    const [, scale, agg] = spec.ch[j];
    const q = Math.round(fin(vals[j]) * scale);
    if (ser.pn === 0) p[j] = q;
    else if (agg === 'max') { if (q > p[j]) p[j] = q; }
    else if (agg === 'last') p[j] = q;
    else p[j] += q;
  }
  ser.pn++;
  if (ser.pn * spec.base >= ser.st) flushPending(spec, ser);
}

/** Close the gathering bucket into a sample (decimating first when the series is full). */
function flushPending(spec, ser) {
  if (!ser.pn || !ser.p) return;
  const C = spec.ch.length;
  if (ser.v.length / C >= LEDGER_K) {
    decimate(spec, ser);
    // the bucket now covers half of a doubled step: keep gathering unless it is the final flush
    if (ser.pn * spec.base < ser.st && ser.e == null) return;
  }
  for (let j = 0; j < C; j++) {
    const agg = spec.ch[j][2];
    ser.v.push(agg === 'avg' ? Math.round(ser.p[j] / ser.pn) : ser.p[j]);
  }
  ser.pn = 0;
  ser.p = null;
}

/** Merge adjacent sample pairs and double the step. */
function decimate(spec, ser) {
  const C = spec.ch.length;
  const n = Math.floor(ser.v.length / C);
  const out = [];
  for (let k = 0; k < n; k += 2) {
    for (let j = 0; j < C; j++) {
      const a = ser.v[k * C + j];
      if (k + 1 >= n) { out.push(a); continue; }
      const b = ser.v[(k + 1) * C + j];
      const agg = spec.ch[j][2];
      out.push(agg === 'max' ? Math.max(a, b) : agg === 'last' ? b : Math.round((a + b) / 2));
    }
  }
  ser.v = out;
  ser.st *= 2;
}

/** Freeze a series at the entity's end (the partial bucket becomes the last sample). */
function freeze(world, kind, id, day) {
  const ser = seriesStore(world)[kind][id];
  if (!ser || ser.e != null) return;
  ser.e = day;
  flushPending(CHANNELS[kind], ser);
  ser.p = null; ser.pn = 0;
  // a finished life is kept at half resolution (it is saved for ever; the chart still reads well)
  const C = CHANNELS[kind].ch.length;
  if (ser.v.length / C > LEDGER_K / 2) decimate(CHANNELS[kind], ser);
}

// ---------------------------------------------------------------------------
// Sampling (called daily by the stats system)

const scratch = new Array(12).fill(0);   // reused per sample (filled before every push)

function sampleSettlements(world, day) {
  const store = seriesStore(world).s;
  for (const s of world.settlements) {
    if (!s) continue;
    if (!s.alive) { if (store[s.id] && store[s.id].e == null) freeze(world, 's', s.id, fin(s.destroyedDay, day)); continue; }
    scratch[0] = s.population; scratch[1] = s.wealth; scratch[2] = s.tradeIncome;
    scratch[3] = s.health; scratch[4] = s.happiness; scratch[5] = s.unrest;
    scratch[6] = s.defense; scratch[7] = s.culture;
    push(world, 's', s.id, scratch, day);
  }
}

function sampleCivs(world, day) {
  const store = seriesStore(world).c;
  const men = Object.create(null), wars = Object.create(null), pop = Object.create(null), towns = Object.create(null);
  for (const a of world.armies) men[a.civId] = (men[a.civId] || 0) + fin(a.strength);
  for (const w of world.wars) {
    if (!w.active) continue;
    for (const id of w.attackers) wars[id] = (wars[id] || 0) + 1;
    for (const id of w.defenders) wars[id] = (wars[id] || 0) + 1;
  }
  for (const s of world.settlements) {
    if (!s || !s.alive) continue;
    pop[s.civId] = (pop[s.civId] || 0) + fin(s.population);
    towns[s.civId] = (towns[s.civId] || 0) + 1;
  }
  for (const c of world.civs) {
    if (!c) continue;
    if (!c.alive) { if (store[c.id] && store[c.id].e == null) freeze(world, 'c', c.id, fin(c.fallenDay, day)); continue; }
    scratch[0] = pop[c.id] || 0; scratch[1] = c.territory; scratch[2] = towns[c.id] || 0;
    scratch[3] = c.treasury; scratch[4] = c.stability; scratch[5] = c.military?.manpower;
    scratch[6] = c.tech?.era; scratch[7] = men[c.id] || 0; scratch[8] = wars[c.id] || 0;
    scratch[9] = c.prestige;
    push(world, 'c', c.id, scratch, day);
  }
}

function sampleReligions(world, day) {
  if (!world.religions.length) return;
  const store = seriesStore(world).r;
  const towns = Object.create(null), nations = Object.create(null);
  for (const s of world.settlements) if (s && s.alive && s.dominantReligion != null) towns[s.dominantReligion] = (towns[s.dominantReligion] || 0) + 1;
  for (const c of world.civs) if (c && c.alive && c.stateReligion != null) nations[c.stateReligion] = (nations[c.stateReligion] || 0) + 1;
  for (const r of world.religions) {
    if (!r) continue;
    if (r.alive === false) { if (store[r.id] && store[r.id].e == null) freeze(world, 'r', r.id, fin(r.endDay, day)); continue; }
    scratch[0] = r.followers; scratch[1] = towns[r.id] || 0;
    scratch[2] = Math.max(nations[r.id] || 0, fin(r.nations)); scratch[3] = r.fervor;
    push(world, 'r', r.id, scratch, day);
  }
}

function sampleWars(world, day) {
  const store = seriesStore(world).w;
  for (const w of world.wars) {
    if (!w) continue;
    if (!w.active) { if (store[w.id] && store[w.id].e == null) freeze(world, 'w', w.id, fin(w.endDay, day)); continue; }
    let casA = 0, casD = 0;
    const cas = w.casualties || {};
    for (const id of w.attackers) casA += fin(cas[id]);
    for (const id of w.defenders) casD += fin(cas[id]);
    let occA = 0, occD = 0;
    const occ = w.geo?.occupied;
    if (occ && typeof occ === 'object') {
      for (const sid in occ) {
        const s = world.settlements[sid];
        if (!s || !s.alive || s.civId === occ[sid]) continue;
        if (w.attackers.includes(s.civId)) occA++; else if (w.defenders.includes(s.civId)) occD++;
      }
    } else occA = Array.isArray(w.captured) ? w.captured.length : 0;
    let menA = 0, menD = 0;
    for (const a of world.armies) {
      if (a.warId !== w.id) continue;
      if (w.attackers.includes(a.civId)) menA += fin(a.strength); else menD += fin(a.strength);
    }
    scratch[0] = w.warScore; scratch[1] = casA; scratch[2] = casD; scratch[3] = occA; scratch[4] = occD;
    scratch[5] = menA; scratch[6] = menD;
    push(world, 'w', w.id, scratch, day);
  }
}

function samplePlagues(world, day) {
  const store = seriesStore(world).p;
  for (const p of world.plagues) {
    if (!p) continue;
    if (!p.active) { if (store[p.id] && store[p.id].e == null) freeze(world, 'p', p.id, fin(p.endDay, day)); continue; }
    scratch[0] = p.infected; scratch[1] = p.towns; scratch[2] = p.deaths;
    push(world, 'p', p.id, scratch, day);
  }
}

/** Transient lists (armies, bands): sample the living, freeze the series of those gone. */
function sampleTransient(world, kind, list, day, fill) {
  const store = seriesStore(world)[kind];
  let open = 0;
  for (const o of list) {
    if (!o || o.id == null) continue;
    fill(o);
    push(world, kind, o.id, scratch, day);
    open++;
  }
  // every live entity just pushed into an open series; any other open series belongs to the gone
  let total = 0;
  for (const id in store) if (store[id].e == null) total++;
  if (total === open) return;
  const live = new Set();
  for (const o of list) if (o && o.id != null) live.add(+o.id);
  for (const id in store) if (store[id].e == null && !live.has(+id)) freeze(world, kind, id, day);
}
const fillArmy = (a) => { scratch[0] = a.strength; scratch[1] = a.morale; scratch[2] = a.supply; scratch[3] = a.x; scratch[4] = a.y; };
const fillBand = (b) => {
  scratch[0] = fin(b.strength) || fin(b.power); scratch[1] = fin(b.hp, 1); scratch[2] = fin(b.morale, 1);
  scratch[3] = b.loot; scratch[4] = b.x; scratch[5] = b.y;
};

/** Drop what retention lets go: small dead towns after a century, old disbanded armies and bands. */
function prune(world, day) {
  const st = seriesStore(world);
  for (const id of Object.keys(st.s)) {
    const ser = st.s[id];
    if (ser.e == null || day - ser.e < DROP_SMALL_TOWN_DAYS) continue;
    const s = world.settlements[id];
    const conquered = s && Array.isArray(s.own) && s.own.some((o) => o[2] === 'c');
    if (!s || (fin(s.peakPopulation) < SMALL_TOWN_PEAK && !conquered)) delete st.s[id];
  }
  pruneEnded(st.a, day, KEEP_ENDED_ARMY_DAYS, MAX_ENDED_ARMIES);
  pruneEnded(st.b, day, KEEP_ENDED_BAND_DAYS, MAX_ENDED_BANDS);
  // small wars (border feuds of a season or two) let their chart go a century after the peace
  for (const id of Object.keys(st.w)) {
    const ser = st.w[id];
    if (ser.e == null || day - ser.e < DROP_SMALL_TOWN_DAYS) continue;
    const war = world.wars[id];
    let dead = 0;
    if (war && war.casualties && typeof war.casualties === 'object') for (const k in war.casualties) dead += fin(war.casualties[k]);
    if (!war || dead < SMALL_WAR_DEAD) delete st.w[id];
  }
}
function pruneEnded(store, day, keepDays, cap) {
  const ended = [];
  for (const id of Object.keys(store)) {
    const e = store[id].e;
    if (e == null) continue;
    if (day - e > keepDays) delete store[id]; else ended.push([e, Number(id)]);
  }
  if (ended.length > cap) {
    ended.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let k = 0; k < ended.length - cap; k++) delete store[ended[k][1]];
  }
}

/** Daily entry point (stats.update). Cheap: O(entities) on the cadence days only. */
export function sampleLedger(world) {
  const day = world.time.day;
  if (day % CHANNELS.a.base === 0) sampleTransient(world, 'a', world.armies, day, fillArmy);
  if (day % 30 === 0) {
    sampleWars(world, day);
    samplePlagues(world, day);
    sampleTransient(world, 'b', world.bands || [], day, fillBand);
  }
  if (day % DAYS_PER_YEAR === 0) {
    sampleSettlements(world, day);
    sampleCivs(world, day);
    sampleReligions(world, day);
    prune(world, day);
  }
}

// ---------------------------------------------------------------------------
// Reading (pure)

/**
 * The life of an entity as a table: { kind, t0, st, ch: [names], labels, v: [[values]], end }
 * or null. v[k] holds sample k (day t0 + k·st) in natural units; the gathering bucket is
 * appended as the newest sample. Never mutates the world.
 */
export function series(world, kind, id) {
  const spec = CHANNELS[kind];
  const ser = spec && world?.history?.series?.[kind]?.[id];
  if (!ser || !Array.isArray(ser.v)) return null;
  const C = spec.ch.length;
  const v = [];
  const n = Math.floor(ser.v.length / C);
  for (let k = 0; k < n; k++) {
    const row = new Array(C);
    for (let j = 0; j < C; j++) row[j] = ser.v[k * C + j] / spec.ch[j][1];
    v.push(row);
  }
  if (ser.pn > 0 && Array.isArray(ser.p)) {
    const row = new Array(C);
    for (let j = 0; j < C; j++) {
      const q = spec.ch[j][2] === 'avg' ? ser.p[j] / ser.pn : ser.p[j];
      row[j] = q / spec.ch[j][1];
    }
    v.push(row);
  }
  if (!v.length) return null;
  return {
    kind, t0: ser.t0, st: ser.st,
    ch: spec.ch.map((c) => c[0]), labels: spec.ch.map((c) => c[3]),
    v, end: ser.e ?? null,
  };
}

/** One channel of a series as { days: [], values: [] } (UI helper), or null. */
export function channel(world, kind, id, name) {
  const s = series(world, kind, id);
  if (!s) return null;
  const j = s.ch.indexOf(name);
  if (j < 0) return null;
  return { days: s.v.map((_, k) => s.t0 + k * s.st), values: s.v.map((r) => r[j]) };
}

/** The value of a channel near a day (nearest sample at or before it), or null. */
export function valueAt(world, kind, id, name, day) {
  const s = series(world, kind, id);
  if (!s) return null;
  const j = s.ch.indexOf(name);
  if (j < 0) return null;
  const k = Math.min(s.v.length - 1, Math.floor((day - s.t0) / s.st));
  return k < 0 ? null : s.v[k][j];
}

// ---------------------------------------------------------------------------
// Owner chains: s.own = [[day, civId, code]] (cap 16; the founding entry is always kept)

const OWN_HOW = { f: 'founded', c: 'conquest', r: 'rebellion', s: 'secession', t: 'treaty', u: 'union', d: 'divine', x: 'destroyed' };
export const OWN_CODES = OWN_HOW;

/** settlementTransferred cause → owner-chain code. */
export function ownCode(cause) {
  const c = String(cause || '').toLowerCase();
  if (!c) return 'c';
  if (/divine|miracle|god|tool/.test(c)) return 'd';
  if (/reunif|union|marri|inherit|annex|merge|unif/.test(c)) return 'u';
  if (/treaty|peace|cede|ceded|purchase|sale|tribute|gift/.test(c)) return 't';
  if (/secess|independ|split|break|free/.test(c)) return 's';
  if (/rebel|revolt|defect|uprising|coup|riot|mutiny/.test(c)) return 'r';
  return 'c';
}

function pushOwn(s, entry) {
  if (!Array.isArray(s.own)) s.own = [];
  const own = s.own;
  const last = own[own.length - 1];
  if (last && last[0] === entry[0] && last[1] === entry[1] && last[2] === entry[2]) return;
  own.push(entry);
  // keep the founding and the most recent changes
  while (own.length > OWN_CAP) own.splice(1, 1);
}

on('settlementCreated', (world, s) => {
  if (!s) return;
  pushOwn(s, [world.time.day, s.civId, 'f']);
});
on('settlementTransferred', (world, s, oldId, newId, cause) => {
  if (!s) return;
  if (!Array.isArray(s.own) || !s.own.length) seedOwn(world, s, oldId);
  pushOwn(s, [world.time.day, newId, ownCode(cause)]);
});
on('settlementDestroyed', (world, s) => {
  if (!s) return;
  if (!Array.isArray(s.own) || !s.own.length) seedOwn(world, s, s.civId);
  pushOwn(s, [world.time.day, s.civId, 'x']);
});

/** A chain for a settlement recorded before ledgers existed (old saves): founding, then today's holder. */
function seedOwn(world, s, holder = s.civId) {
  s.own = [[fin(s.foundedDay), s.originCivId ?? s.civId, 'f']];
  if (holder != null && holder !== (s.originCivId ?? s.civId)) {
    const fl = s.flags || {};
    const day = Number.isFinite(fl.seceded) ? fl.seceded : Number.isFinite(fl.conqueredDay) ? fl.conqueredDay : fin(s.foundedDay);
    s.own.push([day, holder, Number.isFinite(fl.seceded) && fl.seceded >= fin(fl.conqueredDay, -1) ? 's' : 'c']);
  }
}

/** Fill missing owner chains (old saves). Idempotent; runs from stats.init. */
export function initLedger(world) {
  seriesStore(world);
  for (const s of world.settlements) if (s && (!Array.isArray(s.own) || !s.own.length)) seedOwn(world, s);
}

/** The chain of title of a settlement: [{ day, civId, code, how }] oldest first. */
export function ownerChain(world, sid) {
  const s = world?.settlements?.[sid];
  if (!s) return [];
  const own = Array.isArray(s.own) && s.own.length ? s.own : [[fin(s.foundedDay), s.originCivId ?? s.civId, 'f']];
  return own.map(([day, civId, code]) => ({ day, civId, code, how: OWN_HOW[code] || 'conquest' }));
}

// ---------------------------------------------------------------------------
// Reporting

/** Sizes for reports: series counts per kind, samples, approximate JSON bytes, worst length. */
export function ledgerStats(world) {
  const st = world?.history?.series || {};
  const out = { kinds: {}, series: 0, bytes: 0, maxSamples: 0, bad: 0 };
  for (const k of LEDGER_KINDS) {
    const store = st[k] || {};
    const C = CHANNELS[k].ch.length;
    let n = 0, bytes = 0;
    for (const id of Object.keys(store)) {
      const ser = store[id];
      n++;
      bytes += JSON.stringify(ser).length + id.length + 4;
      const ns = Math.floor(ser.v.length / C);
      if (ns > out.maxSamples) out.maxSamples = ns;
      if (ser.v.length % C !== 0 || !ser.v.every(Number.isFinite)) out.bad++;
    }
    out.kinds[k] = n;
    out.series += n;
    out.bytes += bytes;
  }
  return out;
}
