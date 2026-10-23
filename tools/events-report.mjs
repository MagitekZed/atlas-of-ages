#!/usr/bin/env node
// Event deck report (WP1): run several seeds for many years in parallel and check the living
// history against the package acceptance targets (docs/design/expansion-packages.md, WP1):
//   imp ≥ 2 entries 2–40 a year overall and ≥ 1.5 a year in Y0–250
//   first imp ≥ 4 entry before Y60 in at least 4 of 5 seeds
//   war < 40 % of imp ≥ 2 entries after Y250;  routine successions < 20 % of Nations imp ≥ 2
//   world population falls ≥ 10 % within some 50-year window in at least 2 of 5 seeds
//   events ≤ 4 ms per sim-year;  no event family above ~15 % of our imp ≥ 2 entries
//
//   node tools/events-report.mjs [--seeds atlas,kestrel,umber,vane,north-fen-795] [--years 1000]
//                                [--size medium] [--set key=value ...] [--jobs 5] [--json out.json]
//
// Each seed runs in its own child process (--child), which tallies every chronicle entry as it
// is written (pruning never hides one) and samples world population yearly.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, def) => { const k = argv.indexOf('--' + name); return k >= 0 ? argv[k + 1] : def; };
const sets = []; argv.forEach((a, k) => { if (a === '--set') sets.push(argv[k + 1]); });

if (argv.includes('--child')) await child();
else await parent();

// ---------------------------------------------------------------------------

async function child() {
  const { createWorld } = await import('../src/core/world.js');
  const { Simulation } = await import('../src/core/sim.js');
  const { loadSystems } = await import('../src/systems.js');
  const { liveSettlements } = await import('../src/core/entities.js');
  const seed = opt('seed', 'atlas'), years = Number(opt('years', 1000));
  const params = { seed, worldSize: opt('size', 'medium') };
  for (const s of sets) {
    const [k, v] = s.split('=');
    params[k] = v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v;
  }
  const world = createWorld(params);
  try { (await import('../src/gen/worldgen.js')).generateWorld(world); } catch (e) { const { fallbackGenerate } = await import('./fallback-gen.mjs'); fallbackGenerate(world); }
  const systems = await loadSystems({ onError: () => {} });
  const sim = new Simulation(world, systems);
  sim.init();
  const SUCC = /(took|ascended|came to|inherited) the throne|succeeded (him|her|them)|was elected|took the (crown|seat)|became (king|queen|chief|ruler)/i;
  const m = { seed, years, n2: 0, n2early: 0, n2late: 0, war2late: 0, civ2: 0, succ2: 0, first4: null, imp3days: [], pop: [], fam: {}, keys: {}, cats: {} };
  let last = world.chronicle.seq;
  const tally = (e) => {
    m.keys[e.key || '-'] = (m.keys[e.key || '-'] || 0) + (e.imp >= 2 ? 1 : 0);
    if (e.imp >= 4 && m.first4 == null) m.first4 = Math.floor(e.day / 360);
    if (e.imp >= 3) m.imp3days.push(e.day);
    if (e.imp < 2) return;
    const late = e.day >= 250 * 360;
    m.n2++;
    if (late) m.n2late++; else m.n2early++;
    if (late && e.cat === 'war') m.war2late++;
    m.cats[e.cat] = (m.cats[e.cat] || 0) + 1;
    if (e.cat === 'civ') {
      m.civ2++;
      if (e.key === 'succession' || (e.key && e.key.startsWith('succession.')) || (!e.key && SUCC.test(e.text))) m.succ2++;
    }
  };
  const t0 = performance.now();
  for (let d = 0; d < years * 360; d++) {
    sim.step();
    const es = world.chronicle.entries;
    if (world.chronicle.seq !== last) {
      let k = es.length - 1;
      while (k >= 0 && es[k].seq > last) k--;
      for (k++; k < es.length; k++) tally(es[k]);
      last = world.chronicle.seq;
    }
    if (world.time.day % 360 === 0) m.pop.push(Math.round(liveSettlements(world).reduce((a, s) => a + s.population, 0)));
  }
  m.ms = (performance.now() - t0) / years;
  m.timing = Object.fromEntries(Object.entries(sim.timing).map(([k, v]) => [k, v / years]));
  m.errors = Object.fromEntries(Object.entries(sim.errors).map(([k, v]) => [k, v.count]));
  const st = world.sys.events || {};
  m.fam = st.tally?.fam || {};
  m.ages = (st.ages?.past || []).map((a) => [a.name, Math.floor(a.from / 360), Math.floor(a.to / 360)]).concat((st.ages?.cur || []).map((a) => [a.name, Math.floor(a.from / 360), null]));
  m.swans = (st.swan?.hist || []).map((h) => [h.name, Math.floor(h.day / 360)]);
  m.counts = st.counts || {};
  m.beasts = (st.beasts || []).length; m.extinct = (st.beasts || []).filter((b) => b.ext != null).length;
  let epi = 0, traits = 0; for (const s of world.settlements) if (s && s.alive) { if (s.epithet) epi++; if (s.traits && s.traits.length) traits++; }
  m.epithets = epi; m.traitTowns = traits; m.towns = liveSettlements(world).length;
  process.stdout.write(JSON.stringify(m));
}

// ---------------------------------------------------------------------------

function run(seed, years) {
  const script = fileURLToPath(import.meta.url);
  const args = [script, '--child', '--seed', seed, '--years', String(years), '--size', opt('size', 'medium')];
  for (const s of sets) args.push('--set', s);
  return new Promise((resolve) => {
    execFile(process.execPath, args, { maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) { resolve({ seed, error: (errOut || err.message).split('\n').slice(-6).join('\n') }); return; }
      try { resolve(JSON.parse(out)); } catch (e) { resolve({ seed, error: 'bad output: ' + String(out).slice(0, 200) }); }
    });
  });
}

function maxDrop50(pop) {
  let worst = 0;
  for (let i = 0; i < pop.length; i++) {
    const p0 = pop[i];
    if (!(p0 > 0)) continue;
    for (let j = i + 1; j < Math.min(pop.length, i + 51); j++) worst = Math.max(worst, 1 - pop[j] / p0);
  }
  return worst;
}
function p90gap(days) {
  if (days.length < 2) return null;
  const g = [];
  for (let k = 1; k < days.length; k++) g.push((days[k] - days[k - 1]) / 360);
  g.sort((a, b) => a - b);
  return g[Math.floor(g.length * 0.9)];
}

async function parent() {
  const seeds = opt('seeds', 'atlas,kestrel,umber,vane,north-fen-795').split(',');
  const years = Number(opt('years', 1000));
  const jobs = Math.max(1, Number(opt('jobs', seeds.length)));
  console.log(`Event deck report: ${seeds.length} seeds × ${years} years${sets.length ? ' (' + sets.join(', ') + ')' : ''}`);
  const t0 = Date.now();
  const res = [];
  for (let k = 0; k < seeds.length; k += jobs) res.push(...await Promise.all(seeds.slice(k, k + jobs).map((s) => run(s, years))));
  console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
  const ok = res.filter((r) => !r.error);
  for (const r of res.filter((x) => x.error)) console.log(`!! ${r.seed} failed:\n${r.error}\n`);
  const pad = (s, n) => String(s).padStart(n);
  console.log(['seed', 'imp2/y', 'Y0-250', 'first4', 'war%', 'succ%', 'drop50', 'p90gap', 'ev ms', 'all ms', 'top family'].map((h, i) => pad(h, i ? 9 : 14)).join(''));
  const rows = [];
  for (const r of ok) {
    const early = Math.min(250, r.years);
    const famTot = Object.values(r.fam).reduce((a, b) => a + b, 0);
    const top = Object.entries(r.fam).sort((a, b) => b[1] - a[1])[0];
    const row = {
      seed: r.seed, imp2: r.n2 / r.years, early: r.n2early / early, first4: r.first4, war: r.n2late ? r.war2late / r.n2late : 0,
      succ: r.civ2 ? r.succ2 / r.civ2 : 0, drop: maxDrop50(r.pop), gap: p90gap(r.imp3days), ev: r.timing.events || 0, all: r.ms,
      top: top ? [top[0], famTot ? top[1] / famTot : 0] : ['—', 0],
    };
    rows.push(row);
    console.log([pad(row.seed, 14), pad(row.imp2.toFixed(2), 9), pad(row.early.toFixed(2), 9), pad(row.first4 ?? '—', 9), pad((100 * row.war).toFixed(0), 9), pad((100 * row.succ).toFixed(0), 9),
      pad((100 * row.drop).toFixed(0) + '%', 9), pad(row.gap != null ? row.gap.toFixed(1) : '—', 9), pad(row.ev.toFixed(2), 9), pad(row.all.toFixed(0), 9), pad(`${row.top[0]} ${(100 * row.top[1]).toFixed(0)}%`, 14)].join(''));
  }
  console.log('');
  for (const r of ok) {
    console.log(`${r.seed}: ages ${r.ages.map(([n, a, b]) => `${n} ${a}–${b ?? ''}`).join('; ')}`);
    console.log(`  swans ${r.swans.map(([n, y]) => `${n} Y${y}`).join('; ') || 'none'} · beasts ${r.beasts} (${r.extinct} extinct) · towns ${r.towns}: ${r.epithets} epithets, ${r.traitTowns} with traits`);
    const famTot = Object.values(r.fam).reduce((a, b) => a + b, 0);
    console.log(`  families ${Object.entries(r.fam).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(100 * v / famTot)}%`).join(' ')}`);
    if (Object.keys(r.errors).length) console.log(`  !! system errors ${JSON.stringify(r.errors)}`);
  }
  const n = ok.length;
  const checks = [
    [rows.every((r) => r.imp2 >= 2 && r.imp2 <= 40), 'imp≥2 entries 2–40 a year overall in every seed'],
    [rows.every((r) => r.early >= 1.5), 'imp≥2 at least 1.5 a year in Y0–250 in every seed'],
    [rows.filter((r) => r.first4 != null && r.first4 < 60).length >= Math.min(4, n), 'first imp≥4 before Y60 in at least 4 of 5 seeds'],
    [years < 300 || rows.every((r) => r.war < 0.4), 'war under 40% of imp≥2 entries after Y250'],
    [rows.every((r) => r.succ < 0.2), 'routine successions under 20% of Nations imp≥2 entries'],
    [rows.filter((r) => r.drop >= 0.1).length >= Math.min(2, n), 'world population falls ≥10% within 50 years in at least 2 of 5 seeds'],
    [rows.every((r) => r.gap == null || r.gap <= 10), 'p90 gap between imp≥3 entries at most 10 years'],
    [rows.every((r) => r.ev <= 4), 'events at most 4 ms per sim-year'],
    [rows.every((r) => r.top[1] <= 0.2), 'no event family above 20% of our imp≥2 entries (target 15%)'],
    [ok.every((r) => !Object.keys(r.errors).length) && n === res.length, 'no system errors'],
  ];
  console.log('\nAcceptance:');
  for (const [pass, label] of checks) console.log(`  ${pass ? 'ok' : '!!'} ${label}`);
  if (opt('json', null)) writeFileSync(opt('json'), JSON.stringify({ rows, raw: ok }, null, 1));
  process.exit(checks.every(([p]) => p) ? 0 : 1);
}
