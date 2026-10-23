#!/usr/bin/env node
// Headless runner: generate a world and simulate it in Node, printing vital signs.
//
//   node tools/headless.mjs [--years 300] [--seed atlas] [--size small|medium|large|vast]
//                           [--report 25] [--only climate,ecology] [--exclude myth] [--gen real|fallback]
//                           [--set key=value ...] [--chronicle 40] [--save out.json] [--load in.json]
//                           [--json metrics.json] [--hash] [--fullhash]
//   node tools/headless.mjs --determinism [--years 200] [--seed …] [--size …]
//   node tools/headless.mjs --rewind-test [--seed …] [--size …]
//   node tools/headless.mjs --trial [--seed …] [--size small] [--years 60] [--acts 14] [--set mythLevel=2]
//   node tools/headless.mjs --keyframe-check [--seed …] [--size medium] [--years 600] [--every 360] [--back 60]
//
// After the run a "Balance (SPEC §9)" block reports the balance targets with ok/!! marks, then
// every system's optional report(world) → { title, lines: [string], checks: [{ ok, label }] }.
// --hash prints worldChecksum (core/keyframe.js) at the end (save → load → continue must match).
// --determinism runs the years (default 200) at mythLevel 0 twice in child processes, once
//   with the myth module not loaded at all; the FNV of serializeWorld minus sys.myth must match
//   (the verdict is that comparison alone; the children's own checks are listed for information).
// --fullhash prints the FNV of the whole saved state (sys.myth included) minus world.versions:
//   what an optimisation that must not change results has to leave equal.
// --rewind-test captures a keyframe at Y40, drops a scripted meteor with applyTool at Y45, runs
//   to Y50 (checksum A); restores the keyframe and replayTo Y50 (checksum B); A must equal B,
//   and so must the full saved state (minus the version counters a restore bumps).
// --trial: a randomized gate. One world (default small, 60 years) takes random acts of every
//   kind (map strokes, pair and entity acts, live params) on random days; the full saved state
//   at the end (sys.myth included, versions excluded) must be the same straight through, after
//   save → load → continue (a save on an act's day, right after it, and another), and after a
//   keyframe restore + replay (from before the first act, and from mid-run). Every capture
//   (and an extra one every --kf-every days, default 5 years) verifies the copies keyframes
//   share (core/keyframe.js KEYFRAME_DEV). Run it at mythLevel 0 and 2.
//
// --keyframe-check: one world (default medium, 600 years) captures a keyframe every --every days
//   (default 360) with KEYFRAME_DEV.verify on, so every closed-record copy the keyframes share is
//   checked against its record (a miss = a code path that edited a closed record without
//   touchRecord). Then it restores the last keyframe and one --back years (default 60) earlier,
//   replays both to the end and compares the full saved state; it also times captures.
//
// Exit code 1 if any system threw, any field holds NaN/Infinity, a system report check failed,
// or a --determinism / --rewind-test / --trial / --keyframe-check comparison failed.

import { createWorld, yearOf } from '../src/core/world.js';
import { Simulation } from '../src/core/sim.js';
import { loadSystems } from '../src/systems.js';
import { liveCivs, liveSettlements, areAtWar } from '../src/core/entities.js';
import { on } from '../src/core/hooks.js';
import { ERAS, WATER, DAYS_PER_YEAR, DAYS_PER_MONTH, CATEGORIES } from '../src/core/constants.js';
import { serializeWorld, serializeWorldText, deserializeWorld } from '../src/core/serialize.js';
import { worldChecksum, jsonHash, captureKeyframe, restoreKeyframe, KEYFRAME_DEV } from '../src/core/keyframe.js';
import { replayTo } from '../src/core/replay.js';
import { applyTool } from '../src/core/tools.js';
import { mythLevel } from '../src/core/params.js';
import { fallbackGenerate } from './fallback-gen.mjs';
import { now, formatNumber } from '../src/core/util.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, def) => { const k = argv.indexOf('--' + name); return k >= 0 ? argv[k + 1] : def; };
const flag = (name) => argv.includes('--' + name);
const sets = []; argv.forEach((a, k) => { if (a === '--set') sets.push(argv[k + 1]); });

if (flag('determinism')) process.exit(await determinism());
if (flag('trial')) process.exit(await trial());
if (flag('keyframe-check')) process.exit(await keyframeCheck());

const rewindTest = flag('rewind-test');
const years = rewindTest ? 50 : Number(opt('years', 300));
const report = Number(opt('report', Math.max(5, Math.round(years / 12))));
const genMode = opt('gen', 'real');
const only = opt('only', null)?.split(',');
const exclude = opt('exclude', null)?.split(',');
const chronN = Number(opt('chronicle', 25));

const params = { seed: opt('seed', 'atlas'), worldSize: opt('size', 'medium') };
for (const s of sets) {
  const [k, v] = s.split('=');
  params[k] = v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v;
}

let world;
const tg = now();
if (opt('load', null)) {
  world = deserializeWorld(JSON.parse(readFileSync(opt('load'), 'utf8')));
  console.log(`Loaded world "${world.name}" at year ${yearOf(world)}`);
} else {
  world = createWorld(params);
  let usedReal = false;
  if (genMode === 'real') {
    try {
      const gen = await import('../src/gen/worldgen.js');
      gen.generateWorld(world);
      usedReal = true;
    } catch (e) {
      console.warn('[headless] real generator unavailable, using fallback:', e.message.split('\n')[0]);
      world = createWorld(params);
    }
  }
  if (!usedReal) fallbackGenerate(world);
  console.log(`Generated "${world.name}" ${world.W}×${world.H} (${usedReal ? 'real' : 'fallback'} gen) in ${(now() - tg).toFixed(0)} ms`);
}

const loadErrors = [];
const systems = await loadSystems({ only, exclude, onError: (p, e) => loadErrors.push(`${p}: ${e.message.split('\n')[0]}`) });
if (loadErrors.length) console.log('Modules not loaded:\n  ' + loadErrors.join('\n  '));
console.log('Systems: ' + systems.map((s) => s.id).join(', '));

const sim = new Simulation(world, systems);
const ti = now();
sim.init();
console.log(`init ${(now() - ti).toFixed(0)} ms`);

if (rewindTest) process.exit(await rewind());

// ---------------------------------------------------------------------------
// Balance tracking (SPEC §9). Cheap: a chronicle tally per day, land means monthly.
function landMean(field) {
  const { f, N } = world; let s = 0, n = 0;
  for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND) { s += field[i]; n++; }
  return n ? s / n : 0;
}
/** Land mean over the hemisphere with more land (the seasons cancel in a global mean). */
const hemiRows = (() => {
  const { f, W, H } = world; let n = 0, s = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (f.water[y * W + x] === WATER.LAND) { if (y < H / 2) n++; else s++; }
  return n >= s ? [0, Math.floor(H / 2)] : [Math.floor(H / 2), H];
})();
function hemiLandMean(field) {
  const { f, W } = world; let s = 0, n = 0;
  for (let i = hemiRows[0] * W; i < hemiRows[1] * W; i++) if (f.water[i] === WATER.LAND) { s += field[i]; n++; }
  return n ? s / n : 0;
}
const bal = {
  startDay: world.time.day,
  civs0: world.civs.length,
  newCivs: 0, fallen: 0,
  firstEra: {},
  monthT: [], swings: [],
  annT0: landMean(world.f.annTemp), annTMaxDev: 0, annTEnd: 0,
  veg0: landMean(world.f.veg), herb0: landMean(world.f.herb), pred0: landMean(world.f.pred),
  vegMin: Infinity, herbMin: Infinity, predMin: Infinity,
  imp2: 0, imp3: 0, entries: 0, seq: world.chronicle.seq,
  atWarSamples: 0, atWarSum: 0, atWar200Samples: 0, atWar200Sum: 0, civMonths: {}, civWarMonths: {},
};
on('civCreated', () => { bal.newCivs++; });
on('civDestroyed', () => { bal.fallen++; });
function balanceDay() {
  const w = world, day = w.time.day;
  // chronicle tally (entries are appended in seq order)
  const es = w.chronicle.entries;
  if (w.chronicle.seq !== bal.seq) {
    for (let k = es.length - 1; k >= 0 && es[k].seq > bal.seq; k--) {
      bal.entries++;
      if (es[k].imp >= 2) bal.imp2++;
      if (es[k].imp >= 3) bal.imp3++;
    }
    bal.seq = w.chronicle.seq;
  }
  if (day % DAYS_PER_MONTH !== 0) return;
  bal.monthT.push(hemiLandMean(w.f.temp));
  if (bal.monthT.length === 12) {
    bal.swings.push(Math.max(...bal.monthT) - Math.min(...bal.monthT));
    bal.monthT.length = 0;
  }
  // share of live civs at war (monthly sample)
  const civs = liveCivs(w);
  if (civs.length) {
    let atWar = 0;
    const warring = new Set();
    for (const war of w.wars) if (war.active) { for (const a of war.attackers) warring.add(a); for (const d of war.defenders) warring.add(d); }
    for (const c of civs) {
      const k = c.id, w8 = warring.has(k);
      if (w8) atWar++;
      bal.civMonths[k] = (bal.civMonths[k] || 0) + 1;
      if (w8) bal.civWarMonths[k] = (bal.civWarMonths[k] || 0) + 1;
    }
    bal.atWarSum += atWar / civs.length; bal.atWarSamples++;
    if (day >= 200 * DAYS_PER_YEAR) { bal.atWar200Sum += atWar / civs.length; bal.atWar200Samples++; }
  }
  if (day % DAYS_PER_YEAR !== 0) return;
  const y = Math.floor(day / DAYS_PER_YEAR);
  const era = civs.reduce((a, c) => Math.max(a, c.tech?.era || 0), 0);
  for (let e = 1; e <= era; e++) if (bal.firstEra[e] == null) bal.firstEra[e] = y;
  const at = landMean(w.f.annTemp);
  if (y >= 1) bal.annTMaxDev = Math.max(bal.annTMaxDev, Math.abs(at - bal.annT0));
  bal.annTEnd = at;
  bal.vegMin = Math.min(bal.vegMin, landMean(w.f.veg) / Math.max(1e-9, bal.veg0));
  bal.herbMin = Math.min(bal.herbMin, landMean(w.f.herb));
  bal.predMin = Math.min(bal.predMin, landMean(w.f.pred));
}

function landAvg(field) {
  const { f, N } = world; let s = 0, n = 0;
  for (let i = 0; i < N; i++) if (f.water[i] === WATER.LAND) { s += field[i]; n++; }
  return n ? s / n : 0;
}
function badFields() {
  const out = [];
  for (const [name, arr] of Object.entries(world.f)) {
    if (!(arr instanceof Float32Array || arr instanceof Float64Array)) continue;
    for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) { out.push(`${name}[${i}]=${arr[i]}`); break; }
  }
  return out;
}
function badEntities() {
  const out = [];
  const scan = (label, o) => {
    for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && !Number.isFinite(v)) { out.push(`${label}.${k}=${v}`); return; }
  };
  for (const s of liveSettlements(world)) scan(`settlement#${s.id}`, s);
  for (const c of liveCivs(world)) scan(`civ#${c.id}`, c);
  for (const a of world.armies) scan(`army#${a.id}`, a);
  return out.slice(0, 6);
}

const header = ['year', 'civs', 'towns', 'pop', 'bigCity', 'era', 'wars', 'armies', 'routes', 'relig', 'plague', 'tempL', 'snow', 'veg', 'herb', 'pred', 'fish', 'fires', 'storms', 'events'];
console.log('\n' + header.map((h) => h.padStart(7)).join(''));
let lastSeq = world.chronicle.seq;
const t0 = now();
let bad = [];
const totalDays = years * DAYS_PER_YEAR;
for (let d = 0; d < totalDays; d++) {
  sim.step();
  balanceDay();
  if (world.time.day % (report * DAYS_PER_YEAR) === 0 || d === totalDays - 1) {
    const civs = liveCivs(world), towns = liveSettlements(world);
    const pop = towns.reduce((a, s) => a + s.population, 0);
    const big = towns.reduce((a, s) => Math.max(a, s.population), 0);
    const era = civs.reduce((a, c) => Math.max(a, c.tech?.era || 0), 0);
    const fires = (() => { let n = 0; for (let i = 0; i < world.N; i++) if (world.f.fire[i] > 0) n++; return n; })();
    const row = [
      yearOf(world), civs.length, towns.length, formatNumber(pop), formatNumber(big), era,
      world.wars.filter((w) => w.active).length, world.armies.length,
      world.tradeRoutes.filter((r) => r.active).length,
      world.religions.filter((r) => r.alive !== false).length,
      world.plagues.filter((p) => p.active).length,
      landAvg(world.f.temp).toFixed(1), landAvg(world.f.snow).toFixed(2), landAvg(world.f.veg).toFixed(2),
      landAvg(world.f.herb).toFixed(2), landAvg(world.f.pred).toFixed(3), (() => { let s = 0, n = 0; for (let i = 0; i < world.N; i++) if (world.f.water[i]) { s += world.f.fish[i]; n++; } return n ? (s / n).toFixed(2) : '0'; })(),
      fires, world.storms.length, world.chronicle.seq - lastSeq,
    ];
    lastSeq = world.chronicle.seq;
    console.log(row.map((v) => String(v).padStart(7)).join(''));
    bad = badFields().concat(badEntities());
    if (bad.length) { console.log('  !! non-finite values: ' + bad.join(', ')); }
  }
}
const elapsed = now() - t0;

console.log(`\nSimulated ${years} years in ${(elapsed / 1000).toFixed(2)} s → ${(elapsed / years).toFixed(1)} ms per sim-year`);
const timing = Object.entries(sim.timing).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / years).toFixed(1)}`).join(' · ');
console.log('ms/year by system: ' + timing);

const errs = Object.entries(sim.errors);
if (errs.length) {
  console.log('\nSYSTEM ERRORS:');
  for (const [k, e] of errs) console.log(`  ${k}: ${e.count}× — ${e.last}`);
}

const civs = world.civs;
console.log(`\nNations: ${civs.filter((c) => c.alive).length} alive, ${civs.filter((c) => !c.alive).length} fallen, ${civs.length} total`);
for (const c of civs.filter((c) => c.alive).sort((a, b) => b.population - a.population).slice(0, 10)) {
  console.log(`  ${c.name.padEnd(30)} pop ${formatNumber(c.population).padStart(7)}  towns ${String(c.settlementIds.length).padStart(3)}  ${ERAS[c.tech?.era || 0].name.padEnd(14)} gov ${c.government}  stab ${(c.stability ?? 0).toFixed(2)}`);
}

const cats = {};
for (const e of world.chronicle.entries) cats[e.cat] = (cats[e.cat] || 0) + 1;
console.log('\nChronicle by category: ' + Object.entries(cats).map(([k, v]) => `${k} ${v}`).join(' · '));
const unknownCats = Object.keys(cats).filter((k) => !CATEGORIES[k]);
if (unknownCats.length) console.log('  !! unknown categories: ' + unknownCats.join(', '));
if (chronN > 0) {
  console.log(`\nLast ${chronN} notable entries (imp ≥ 2):`);
  for (const e of world.chronicle.entries.filter((e) => e.imp >= 2).slice(-chronN)) {
    console.log(`  [Y${Math.floor(e.day / DAYS_PER_YEAR)} ${e.cat} ${e.imp}] ${e.text}`);
  }
}

// ---------------------------------------------------------------------------
// Balance report (SPEC §9: medium map, defaults, 1000 years)
{
  const w = world;
  const yrs = Math.max(1e-9, (w.time.day - bal.startDay) / DAYS_PER_YEAR);
  const endY = yearOf(w);
  const civsL = liveCivs(w), townsL = liveSettlements(w);
  const pop = townsL.reduce((a, s) => a + s.population, 0);
  const big = townsL.reduce((a, s) => Math.max(a, s.population), 0);
  const warsAfter200 = w.wars.filter((x) => x.startDay >= 200 * DAYS_PER_YEAR && x.startDay >= bal.startDay);
  const span200 = Math.max(0, endY - Math.max(200, Math.floor(bal.startDay / DAYS_PER_YEAR)));
  const durs = w.wars.filter((x) => !x.active && x.endDay != null).map((x) => (x.endDay - x.startDay) / DAYS_PER_YEAR).sort((a, b) => a - b);
  const longestOpen = w.wars.filter((x) => x.active).reduce((a, x) => Math.max(a, (w.time.day - x.startDay) / DAYS_PER_YEAR), 0);
  const plg = w.plagues.filter((p) => p && p.startDay >= bal.startDay);
  const notable = plg.filter((p) => p.notable).length;
  const worstPlague = plg.reduce((a, p) => Math.max(a, (p.deaths || 0) / Math.max(1, p.worldPopAtStart || 1)), 0);
  const dc = w.sys.disasters?.counts || {};
  const vegNow = landMean(w.f.veg) / Math.max(1e-9, bal.veg0);
  const herbNow = landMean(w.f.herb), predNow = landMean(w.f.pred);
  const swing = bal.swings.length ? bal.swings.reduce((a, b) => a + b, 0) / bal.swings.length : 0;
  const total = Object.values(sim.timing).reduce((a, b) => a + b, 0) / yrs;
  const t = (k) => (sim.timing[k] || 0) / yrs;
  const geo = t('religion') + t('disease') + t('trade') + t('diplomacy') + t('war');
  const mythBudget = mythLevel(w) >= 2 ? 8 : 1;
  const civShares = Object.keys(bal.civMonths).filter((k) => bal.civMonths[k] >= 600).map((k) => (bal.civWarMonths[k] || 0) / bal.civMonths[k]).sort((a, b) => a - b);
  const civWarMedian = civShares.length ? civShares[civShares.length >> 1] : 0;
  const mark = (ok) => (ok ? 'ok' : '!!');
  const lines = [
    [`nations alive ${civsL.length} (5–25)`, civsL.length >= 5 && civsL.length <= 25],
    [`fallen ${w.civs.filter((c) => !c.alive).length} (≥2), new peoples/splits ${bal.newCivs} (≥1)`, w.civs.filter((c) => !c.alive).length >= 2 && bal.newCivs >= 1],
    [`settlements ${townsL.length} (40–400)`, townsL.length >= 40 && townsL.length <= 400],
    [`world population ${formatNumber(pop)} (1M–60M)`, pop >= 1e6 && pop <= 6e7],
    [`largest city ${formatNumber(big)} (30k–1M)`, big >= 3e4 && big <= 1e6],
    [`first Bronze Y${bal.firstEra[1] ?? '—'} (≤600), Iron Y${bal.firstEra[2] ?? '—'} (≤1100); later eras ${[3, 4, 5, 6, 7].map((e) => bal.firstEra[e] != null ? ERAS[e].name.split(' ')[0] + ' Y' + bal.firstEra[e] : null).filter(Boolean).join(', ') || 'none'}`,
      (bal.firstEra[1] ?? 1e9) <= 600 && (endY < 1100 || (bal.firstEra[2] ?? 1e9) <= 1100)],
    [`wars after Y200: ${warsAfter200.length} (${span200 ? (warsAfter200.length / (span200 / 50)).toFixed(1) : '—'} per 50 y, ≥1); median ${durs.length ? durs[durs.length >> 1].toFixed(1) : '—'} y, p90 ${durs.length ? durs[Math.floor(durs.length * 0.9)].toFixed(1) : '—'} y, longest open ${longestOpen.toFixed(1)} y`,
      span200 < 50 || (warsAfter200.length / (span200 / 50) >= 1 && longestOpen < 40)],
    [`typical civ at war ${(100 * civWarMedian).toFixed(0)}% of its life (median over ${civShares.length} civs that lived 50+ years; 15–35%); share of live civs at war ${(100 * bal.atWarSum / Math.max(1, bal.atWarSamples)).toFixed(0)}% overall, ${(100 * bal.atWar200Sum / Math.max(1, bal.atWar200Samples)).toFixed(0)}% after Y200`,
      endY < 500 || (civWarMedian >= 0.15 && civWarMedian <= 0.35)],
    [`land veg ${(100 * vegNow).toFixed(0)}% of genesis (min ${(100 * bal.vegMin).toFixed(0)}%, ≥50%); herbivores ${herbNow.toFixed(3)} (genesis ${bal.herb0.toFixed(3)}), predators ${predNow.toFixed(4)} (genesis ${bal.pred0.toFixed(4)})`,
      vegNow >= 0.5 && herbNow > 0.01 * bal.herb0 && predNow > 0.01 * bal.pred0],
    [`land annual temp ${bal.annT0.toFixed(2)} → ${bal.annTEnd.toFixed(2)} °C, max deviation ${bal.annTMaxDev.toFixed(2)} °C (±2.5); mean seasonal swing ${swing.toFixed(1)} °C (land of the ${hemiRows[0] === 0 ? 'northern' : 'southern'} hemisphere)`, bal.annTMaxDev <= 2.5 && swing > 1],
    [`plagues ${plg.length}, notable ${notable} (${(notable * 1000 / yrs).toFixed(1)}/1000 y, 1–8); worst killed ${(100 * worstPlague).toFixed(1)}% (≤60%)`, worstPlague <= 0.6 && (yrs < 500 || (notable * 1000 / yrs >= 1 && notable * 1000 / yrs <= 8))],
    [`quakes ${(100 * (dc.quakes || 0) / yrs).toFixed(1)}/century (M6+ ${(100 * (dc.quakes6 || 0) / yrs).toFixed(1)}), eruptions ${(100 * (dc.eruptions || 0) / yrs).toFixed(1)}/century, meteors ${dc.meteors || 0} (${((dc.meteors || 0) * 1000 / yrs).toFixed(1)}/1000 y, 0–2)`,
      (dc.quakes || 0) / yrs >= 0.02 && (dc.eruptions || 0) / yrs >= 0.02 && (dc.meteors || 0) * 1000 / yrs <= 2.5],
    [`chronicle imp≥2 ${(bal.imp2 / yrs).toFixed(1)}/yr (2–40), imp≥3 ${(bal.imp3 / yrs).toFixed(2)}/yr, all ${(bal.entries / yrs).toFixed(1)}/yr`, bal.imp2 / yrs >= 2 && bal.imp2 / yrs <= 40],
    [`ms/yr total ${total.toFixed(1)} (≤150): climate ${t('climate').toFixed(1)} (20) weather ${t('weather').toFixed(1)} (25) ecology ${t('ecology').toFixed(1)} (30) disasters ${t('disasters').toFixed(1)} (5) civ ${t('civ').toFixed(1)} (38) geo ${geo.toFixed(1)} (30) bands ${t('bands').toFixed(1)} (3) events ${t('events').toFixed(1)} (4) myth ${t('myth').toFixed(1)} (${mythBudget}) stats ${t('stats').toFixed(1)} (7)`,
      total <= 150 && t('climate') <= 20 && t('weather') <= 25 && t('ecology') <= 30 && t('disasters') <= 5 && t('civ') <= 38 && geo <= 30 && t('bands') <= 3 && t('events') <= 4 && t('myth') <= mythBudget && t('stats') <= 7],
  ];
  console.log('\nBalance (SPEC §9):');
  for (const [text, ok] of lines) console.log(`  ${mark(ok)} ${text}`);
  if (opt('json', null)) {
    writeFileSync(opt('json'), JSON.stringify({
      seed: w.seed, years: yrs, alive: civsL.length, fallen: w.civs.filter((c) => !c.alive).length, newCivs: bal.newCivs,
      towns: townsL.length, pop, big, firstEra: bal.firstEra, warsAfter200: warsAfter200.length, warsPer50: span200 ? warsAfter200.length / (span200 / 50) : null,
      warMedian: durs.length ? durs[durs.length >> 1] : null, longestOpen, atWar: bal.atWarSum / Math.max(1, bal.atWarSamples), atWar200: bal.atWar200Sum / Math.max(1, bal.atWar200Samples), civWarMedian,
      vegRatio: vegNow, vegMin: bal.vegMin, herb0: bal.herb0, herb: herbNow, pred0: bal.pred0, pred: predNow,
      annT0: bal.annT0, annTEnd: bal.annTEnd, annTMaxDev: bal.annTMaxDev, swing,
      plagues: plg.length, notable, worstPlague, disasters: dc, imp2PerYear: bal.imp2 / yrs, imp3PerYear: bal.imp3 / yrs,
      msPerYear: total, timing: Object.fromEntries(Object.entries(sim.timing).map(([k, v]) => [k, v / yrs])),
      errors: Object.keys(sim.errors),
    }, null, 1));
  }
}

// ---------------------------------------------------------------------------
// System reports: optional system.report(world) → { title, lines: [string], checks: [{ ok, label }] }
let failedChecks = 0;
for (const s of systems) {
  if (typeof s.report !== 'function') continue;
  let r;
  try { r = s.report(world); } catch (e) { console.log(`\n!! report(${s.id}) threw: ${e.message}`); failedChecks++; continue; }
  if (!r) continue;
  console.log(`\n${r.title || s.id}:`);
  for (const line of r.lines || []) console.log('  ' + line);
  for (const c of r.checks || []) {
    if (!c.ok) failedChecks++;
    console.log(`  ${c.ok ? 'ok' : '!!'} ${c.label}`);
  }
}

if (opt('save', null)) {
  const ts = now();
  const text = serializeWorldText(world);
  writeFileSync(opt('save'), text);
  const back = deserializeWorld(JSON.parse(text));
  console.log(`\nSaved ${(text.length / 1e6).toFixed(2)} MB in ${(now() - ts).toFixed(0)} ms; reload ok (${back.settlements.length} settlements, checksum ${worldChecksum(back)})`);
}

if (flag('hash')) console.log(`\nworldChecksum ${worldChecksum(world)} (day ${world.time.day})`);
if (flag('fnv')) console.log(`\nFNV ${stateHash(world)}`);
// the whole saved state (sys.myth included) minus the version counters: what an optimisation
// that must leave results identical has to keep equal
if (flag('fullhash')) { const d = serializeWorld(world); delete d.versions; console.log(`\nfullHash ${jsonHash(JSON.stringify(d))}`); }

if (errs.length || bad.length || failedChecks) process.exit(1);

// ---------------------------------------------------------------------------
// Determinism and rewind checks

/**
 * FNV-1a of the saved form of the world, minus sys.myth (what --determinism compares).
 * noVersions also drops world.versions, the cache-invalidation counters that a load or a
 * keyframe restore bumps on purpose.
 */
function stateHash(w, noVersions = false) {
  const data = serializeWorld(w);
  if (data.sys) delete data.sys.myth;
  if (noVersions) delete data.versions;
  return jsonHash(JSON.stringify(data));
}

/**
 * --determinism: the same world twice at mythLevel 0, once without the myth module (not even
 * imported, so none of its providers or registrations exist). Child processes keep the two
 * runs free of shared module state. Returns the exit code.
 */
async function determinism() {
  const yrs = opt('years', '200');
  const script = fileURLToPath(import.meta.url);
  const pass = [];
  for (const k of ['seed', 'size', 'gen']) if (opt(k, null) != null) pass.push('--' + k, opt(k));
  for (const s of sets) if (!s.startsWith('mythLevel=')) pass.push('--set', s);
  const base = [script, '--years', yrs, '--chronicle', '0', '--report', String(Math.max(1, Number(yrs))), '--set', 'mythLevel=0', '--fnv', ...pass];
  const run = (extra) => new Promise((resolve) => {
    execFile(process.execPath, [...base, ...extra], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const m = /\nFNV ([0-9a-f]{8})/.exec(stdout);
      resolve({ hash: m ? m[1] : null, code: err ? err.code ?? 1 : 0, out: stdout, err: stderr });
    });
  });
  console.log(`Determinism: ${yrs} years at mythLevel 0, with and without the myth module…`);
  const t = now();
  const [a, b] = await Promise.all([run([]), run(['--exclude', 'myth'])]);
  // The verdict is the hash comparison alone. The children's SPEC §9 balance lines and system
  // report checks judge whole histories (some only from Y500), so a short run can fail them
  // without saying anything about determinism: they are listed below for information only.
  const tail = (r) => r.out.split('\n').filter((l) => /ms per sim-year|SYSTEM ERRORS|non-finite|threw/.test(l)).slice(0, 6).join('\n    ');
  const why = (r) => (r.code ? ', a check of the child failed (informational)' : '');
  console.log(`  with myth    FNV ${a.hash ?? '—'} (exit ${a.code}${why(a)})\n    ${tail(a)}`);
  console.log(`  without myth FNV ${b.hash ?? '—'} (exit ${b.code}${why(b)})\n    ${tail(b)}`);
  if (!a.hash || !b.hash) console.log((a.err || '') + (b.err || ''));
  const ok = Boolean(a.hash) && a.hash === b.hash;
  console.log(`  ${ok ? 'ok' : '!!'} serializeWorld minus sys.myth ${ok ? 'identical' : 'DIFFERS'} (${((now() - t) / 1000).toFixed(1)} s)`);
  return ok ? 0 : 1;
}

/** --rewind-test (contracts §0(c)). Returns the exit code. */
async function rewind() {
  const Y = DAYS_PER_YEAR;
  const runTo = (day) => { while (world.time.day < day) sim.step(); };
  runTo(40 * Y);
  const kf = captureKeyframe(world);
  const atCapture = worldChecksum(world);
  runTo(45 * Y);
  const towns = liveSettlements(world).slice().sort((p, q) => q.population - p.population || p.id - q.id);
  const tx = towns[0] ? towns[0].x : world.W >> 1, ty = towns[0] ? towns[0].y : world.H >> 1;
  const res = applyTool(world, 'meteor', tx, ty, { strength: 2 });
  console.log(`Y45: meteor at (${tx}, ${ty})${towns[0] ? ' on ' + towns[0].name : ''} → ${res.ok ? 'ok' : 'failed'}${res.message ? ': ' + res.message : ''}`);
  runTo(50 * Y);
  const A = worldChecksum(world), fullA = stateHash(world, true);
  const w2 = restoreKeyframe(kf, { ui: world.ui });
  const restored = worldChecksum(w2);
  sim.setWorld(w2);
  const t = now();
  const r = await replayTo(w2, sim, world.interventions, 50 * Y);
  const B = worldChecksum(w2), fullB = stateHash(w2, true);
  const logOk = JSON.stringify(w2.interventions) === JSON.stringify(world.interventions);
  const lines = [
    [`keyframe at Y40: check ${kf.check}, restored ${restored}`, kf.check === atCapture && restored === atCapture],
    [`interventions logged: ${world.interventions.length} (${world.interventions.map((iv) => iv.kind + ':' + iv.id + '@' + iv.day).join(', ') || 'none'}); replayed log ${logOk ? 'identical' : 'DIFFERS'}`, logOk && world.interventions.length >= 1],
    [`checksum A (continuous) ${A}  B (restore + replay ${r.days} days in ${(r.ms / 1000).toFixed(1)} s) ${B}`, A === B],
  ];
  console.log('\nRewind test (contracts §0(c)):');
  for (const [text, ok] of lines) console.log(`  ${ok ? 'ok' : '!!'} ${text}`);
  // everything saved except the version counters a restore bumps
  console.log(`  ${fullA === fullB ? 'ok' : '!!'} full saved state minus versions/sys.myth: A ${fullA}  B ${fullB}`);
  const errs = Object.entries(sim.errors);
  if (errs.length) for (const [k, e] of errs) console.log(`  !! system ${k}: ${e.count}× — ${e.last}`);
  return lines.every(([, ok]) => ok) && fullA === fullB && !errs.length ? 0 : 1;
}

/** --trial (see the header). Returns the exit code. */
async function trial() {
  const { getTools, availableTools, applyPairTool, applyEntityTool, finishTool } = await import('../src/core/tools.js');
  const { setParam } = await import('../src/core/world.js');
  const { PARAMS } = await import('../src/core/params.js');
  const Y = DAYS_PER_YEAR;
  const yrs = Number(opt('years', 60)), nActs = Number(opt('acts', 14));
  const p0 = { seed: opt('seed', 'trial'), worldSize: opt('size', 'small') };
  for (const s of sets) { const [k, v] = s.split('='); p0[k] = v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v; }
  const systemsT = await loadSystems({});
  const gen = await import('../src/gen/worldgen.js');
  // a private generator for the script (never world.rng)
  let rs = (Number(opt('rs', 1)) * 2654435761) >>> 0 || 1;
  const rnd = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs / 4294967296; };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pickR = (arr) => arr[Math.floor(rnd() * arr.length)];
  const full = (w) => { const d = serializeWorld(w); delete d.versions; return jsonHash(JSON.stringify(d)); };
  const newSim = (w) => { const sm = new Simulation(w, systemsT); sm.init(); return sm; };
  const w = createWorld(p0);
  gen.generateWorld(w);
  const simA = newSim(w);
  const endDay = yrs * Y;
  const actDays = Array.from({ length: nActs }, () => ri(2 * Y, endDay - 31)).sort((a, b) => a - b);
  const kfDays = [ri(Y, 2 * Y - 1), ri(Math.floor(endDay * 0.4), Math.floor(endDay * 0.6))];
  const saveDays = [actDays[Math.floor(nActs / 2)], ri(Math.floor(endDay * 0.6), endDay - 10)];
  const kfs = [], saves = [];
  const live = (arr) => arr.filter((x) => x && x.alive !== false);
  const townTile = () => { const t = live(w.settlements); const s = t.length ? pickR(t) : null; return s ? { x: Math.max(0, Math.min(w.W - 1, s.x + ri(-3, 3))), y: Math.max(0, Math.min(w.H - 1, s.y + ri(-3, 3))) } : { x: ri(0, w.W - 1), y: ri(0, w.H - 1) }; };
  const side = (k) => {
    if (k === 'civ') { const c = live(w.civs); return c.length ? { kind: 'civ', id: pickR(c).id } : null; }
    if (k === 'settlement') { const t = live(w.settlements); return t.length ? { kind: 'settlement', id: pickR(t).id } : null; }
    const p = townTile(); return { kind: 'tile', x: p.x, y: p.y };
  };
  const target = (kinds) => {
    for (const k of kinds.slice().sort(() => rnd() - 0.5)) {
      if (k === 'civ' || k === 'settlement') return side(k);
      if (k === 'ruler') { const c = live(w.civs).filter((x) => x.ruler); if (c.length) { const civ = pickR(c); return { kind: 'ruler', id: `${civ.id}:${civ.ruler.reignStart}` }; } }
      const list = k === 'band' ? w.bands : k === 'army' ? w.armies : k === 'storm' ? w.storms : k === 'religion' ? live(w.religions) : k === 'feature' ? w.features : [];
      if (list && list.length) return { kind: k, id: pickR(list).id };
    }
    return null;
  };
  let acts = 0;
  const act = () => {
    const tools = availableTools(w).filter((t) => !t.hidden && t.id !== 'awaken_magic');
    const r = rnd();
    if (r < 0.15) {
      const ps = PARAMS.filter((p) => p.live);
      const p = pickR(ps);
      const v = p.type === 'bool' ? !w.params[p.key] : p.type === 'select' ? pickR(p.options)[0] : Math.round((p.min + (p.max - p.min) * rnd()) * 100) / 100;
      setParam(w, p.key, v, { log: true });
      return;
    }
    const t = pickR(tools);
    if (!t) return;
    if (t.target === 'pair') { const pk = Array.isArray(t.pick) && t.pick.length ? t.pick : ['civ', 'civ']; const a = side(pk[0]), b = side(pk[1] || pk[0]); if (a && b) applyPairTool(w, t.id, a, b, {}); return; }
    if (t.target === 'entity') {
      const tg = target(t.entity?.kinds || ['civ']);
      if (!tg) return;
      const args = {};
      for (const a of Array.isArray(t.args) ? t.args : []) { try { const o = typeof a.options === 'function' ? a.options(w, tg) : []; if (o && o.length) args[a.key] = pickR(o)[0]; } catch (e) { /* no options */ } }
      applyEntityTool(w, t.id, tg, args);
      return;
    }
    const p = townTile();
    const o = { radius: Math.max(t.minRadius || 0, Math.min(t.maxRadius ?? 12, (t.radius || 0) + ri(-1, 2))) };
    if (t.strength) o.strength = t.strength.min + (t.strength.max - t.strength.min) * rnd();
    const n = t.continuous ? ri(1, 5) : 1;
    for (let k = 0; k < n; k++) applyTool(w, t.id, Math.max(0, Math.min(w.W - 1, p.x + ri(-2, 2))), Math.max(0, Math.min(w.H - 1, p.y + ri(-2, 2))), o);
    if (t.finish) finishTool(w, t.id);
  };
  let ai = 0;
  const t0 = now();
  // every capture checks the copies keyframes share against their records (a stale one is a
  // code path that edited a closed record without touchRecord); extra frames every few years
  // keep that cache exercised over long trials
  KEYFRAME_DEV.verify = true; KEYFRAME_DEV.misses.length = 0; KEYFRAME_DEV.hits = 0;
  const kfEvery = Number(opt('kf-every', 5 * Y));
  while (w.time.day < endDay) {
    const d = w.time.day;
    if (kfDays.includes(d)) kfs.push(captureKeyframe(w));
    else if (d > 0 && d % kfEvery === 0) captureKeyframe(w);
    while (ai < actDays.length && actDays[ai] === d) { act(); acts++; ai++; }
    if (saveDays.includes(d)) saves.push({ day: d, text: JSON.stringify(serializeWorld(w)) });
    simA.step();
  }
  const A = full(w), log = w.interventions;
  KEYFRAME_DEV.verify = false;
  console.log(`Trial: ${p0.worldSize} "${p0.seed}" mythLevel ${w.params.mythLevel}, ${yrs} years, ${acts} acts → ${log.length} logged (${((now() - t0) / 1000).toFixed(1)} s)`);
  const lines = [];
  const ms = KEYFRAME_DEV.misses;
  lines.push([`keyframes' shared copies: ${KEYFRAME_DEV.hits} verified, ${ms.length} stale${ms.length ? ' — ' + ms.slice(0, 4).map((m) => `${m.list}#${m.id}${m.path} (day ${m.day})`).join(', ') : ''}`, ms.length === 0]);
  for (const sv of saves) {
    const w2 = deserializeWorld(JSON.parse(sv.text));
    const sm = newSim(w2);
    await replayTo(w2, sm, log, endDay, { sliceMs: 1e9, sliceDays: 1e9 });
    lines.push([`save on day ${sv.day} → load → continue: ${full(w2)} vs ${A}`, full(w2) === A]);
  }
  for (const kf of kfs) {
    const w2 = restoreKeyframe(kf, { ui: w.ui });
    const sm = new Simulation(w2, systemsT); sm.init();
    await replayTo(w2, sm, log, endDay, { sliceMs: 1e9, sliceDays: 1e9 });
    lines.push([`keyframe day ${kf.day} → restore + replay: ${full(w2)} vs ${A}; log ${JSON.stringify(w2.interventions) === JSON.stringify(log) ? 'identical' : 'DIFFERS'}`, full(w2) === A && JSON.stringify(w2.interventions) === JSON.stringify(log)]);
  }
  for (const [text, ok] of lines) console.log(`  ${ok ? 'ok' : '!!'} ${text}`);
  const errs = Object.entries(simA.errors);
  if (errs.length) for (const [k, e] of errs) console.log(`  !! system ${k}: ${e.count}× — ${e.last}`);
  return lines.every(([, ok]) => ok) && !errs.length ? 0 : 1;
}

/** --keyframe-check (see the header). Returns the exit code. */
async function keyframeCheck() {
  const Y = DAYS_PER_YEAR;
  const yrs = Number(opt('years', 600)), every = Number(opt('every', 360)), back = Number(opt('back', 60));
  const p0 = { seed: opt('seed', 'atlas'), worldSize: opt('size', 'medium') };
  for (const s of sets) { const [k, v] = s.split('='); p0[k] = v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v; }
  const systemsK = await loadSystems({});
  const gen = await import('../src/gen/worldgen.js');
  const full = (w) => { const d = serializeWorld(w); delete d.versions; return jsonHash(JSON.stringify(d)); };
  const w = createWorld(p0);
  gen.generateWorld(w);
  const simK = new Simulation(w, systemsK); simK.init();
  const endDay = yrs * Y;
  KEYFRAME_DEV.verify = true; KEYFRAME_DEV.misses.length = 0; KEYFRAME_DEV.hits = 0; KEYFRAME_DEV.copies = 0;
  const kfs = [];
  const t0 = now();
  while (w.time.day < endDay) {
    if (w.time.day > 0 && w.time.day % every === 0) kfs.push(captureKeyframe(w));
    simK.step();
  }
  const runS = (now() - t0) / 1000;
  const verified = { hits: KEYFRAME_DEV.hits, copies: KEYFRAME_DEV.copies, misses: KEYFRAME_DEV.misses.slice() };
  KEYFRAME_DEV.verify = false;
  // capture cost now: cold (a world without cached copies: a fresh restore) and warm (the
  // copies of the closed records already made, as by the chronoscope's periodic frames)
  const time = (f, n = 7) => { const xs = []; for (let k = 0; k < n; k++) { const t = now(); f(); xs.push(now() - t); } xs.sort((a, b) => a - b); return xs[n >> 1]; };
  const warm = time(() => captureKeyframe(w));
  const A = full(w);
  const lines = [];
  const byTag = {};
  for (const m of verified.misses) { const k = `${m.list}${m.path.replace(/\[\d+\]/g, '[]')}`; byTag[k] = (byTag[k] || 0) + 1; }
  lines.push([`${p0.worldSize} "${p0.seed}" mythLevel ${w.params.mythLevel}, ${yrs} years, a keyframe every ${every} days (${kfs.length}) in ${runS.toFixed(0)} s: ${verified.hits} shared copies verified, ${verified.copies} made, ${verified.misses.length} stale`
    + (verified.misses.length ? '\n      ' + Object.entries(byTag).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} ×${n}`).join('\n      ') + `\n      first: ${JSON.stringify(verified.misses[0])}` : ''), verified.misses.length === 0]);
  for (const kf of [kfs[kfs.length - 1], kfs.find((k) => k.day >= endDay - back * Y)].filter(Boolean)) {
    const w2 = restoreKeyframe(kf, { ui: w.ui });
    const sm = new Simulation(w2, systemsK); sm.init();
    const cold = (() => { const t = now(); captureKeyframe(w2); return now() - t; })();
    await replayTo(w2, sm, w.interventions, endDay, { sliceMs: 1e9, sliceDays: 1e9 });
    const B = full(w2);
    lines.push([`keyframe Y${(kf.day / Y).toFixed(0)} → restore (first capture there ${cold.toFixed(1)} ms) + replay to Y${yrs}: ${B} vs ${A}`, A === B]);
  }
  lines.push([`capture at Y${yrs} with the closed records' copies cached: ${warm.toFixed(1)} ms (median of 7)`, true]);
  for (const [text, ok] of lines) console.log(`  ${ok ? 'ok' : '!!'} ${text}`);
  const errs = Object.entries(simK.errors);
  if (errs.length) for (const [k, e] of errs) console.log(`  !! system ${k}: ${e.count}× — ${e.last}`);
  return lines.every(([, ok]) => ok) && !errs.length ? 0 : 1;
}
