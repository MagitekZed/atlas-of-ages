#!/usr/bin/env node
// A/B timing for speed work: two checkouts load the same saved worlds and simulate on from them,
// one sim at a time, in alternating A,B rounds; prints the medians and B against A.
//
//   node tools/timeab.mjs [checkoutA] [checkoutB] [--save file ...] [--years 100] [--rounds 3]
//                         [--out results.json]
//
// From the branch, against another checkout of main: node tools/timeab.mjs ../atlas-main
//
// checkoutA, B  the trees whose tools/headless.mjs run. B defaults to the repo this script is in,
//               and A to B (A = B measures the noise floor)
// --save file   a save made by `headless --save` (repeatable). Default: .perf/saves/hist-y900.json
//               and .perf/saves/myth-y900.json, Year 900 of the atlas world (medium) at myth level
//               0 and 2. Make them once, from the repo root (about 90 s each):
//                 mkdir -p .perf/saves
//                 node tools/headless.mjs --years 900 --set mythLevel=0 --chronicle 0 --save .perf/saves/hist-y900.json
//                 node tools/headless.mjs --years 900 --set mythLevel=2 --chronicle 0 --save .perf/saves/myth-y900.json
// --years N     years to simulate after the load (default 100)
// --rounds N    A,B pairs per save (default 3); runs go A,B,A,B,... and never in parallel
// --out file    also write every run's numbers as JSON
//
// Each run is `node tools/headless.mjs --load <save> --years N --report N --chronicle 0 --hash
// --fullhash --json <tmp>` with the checkout as cwd (--report N keeps the vital-signs rows, which
// scan every field, out of the timed loop). Reported per save, as medians over the rounds:
//   wall    the runner's own "ms per sim-year": wall time of the day loop (systems + headless
//           bookkeeping), the number to quote
//   systems the sum of Simulation.timing over all systems (--json msPerYear)
//   <id>    each system's Simulation.timing in ms per sim-year (--json timing)
// plus B vs A as a percentage and each side's spread ((max-min)/median). The end states of A and
// B are compared too (worldChecksum and fullHash): for a bit-identical optimisation they match.
// On a busy machine, 3 rounds cannot tell a change below about 5% in wall time from noise.
// Temp files go to .perf/tmp in the repo this script is in (ignored by git).

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PERF = join(REPO, '.perf');
const argv = process.argv.slice(2);
const opt = (name, def) => { const k = argv.indexOf('--' + name); return k >= 0 ? argv[k + 1] : def; };
const valued = new Set(['--save', '--years', '--rounds', '--out']);
const positional = argv.filter((a, k) => !a.startsWith('--') && !valued.has(argv[k - 1]));
const B = resolve(positional[1] ?? REPO), A = positional[0] ? resolve(positional[0]) : B;
for (const wt of [A, B]) if (!existsSync(join(wt, 'tools', 'headless.mjs'))) { console.error(`no tools/headless.mjs in ${wt}\nusage: node tools/timeab.mjs [checkoutA] [checkoutB] [--save file ...] [--years 100] [--rounds 3]`); process.exit(2); }
const saves = argv.flatMap((a, k) => (a === '--save' ? [resolve(argv[k + 1])] : []));
if (!saves.length) saves.push(join(PERF, 'saves', 'hist-y900.json'), join(PERF, 'saves', 'myth-y900.json'));
for (const s of saves) if (!existsSync(s)) { console.error(`no save ${s} (make it with headless --save; see the header of tools/timeab.mjs)`); process.exit(2); }
const YEARS = Number(opt('years', 100)), ROUNDS = Number(opt('rounds', 3));
mkdirSync(join(PERF, 'tmp'), { recursive: true });

let child = null;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { child?.kill('SIGTERM'); } catch (e) { /* gone */ } process.exit(130); });

function run(wt, save, tag) {
  const json = join(PERF, 'tmp', `timeab-${process.pid}-${tag}.json`);
  const args = [join(wt, 'tools', 'headless.mjs'), '--load', save, '--years', String(YEARS), '--report', String(YEARS), '--chronicle', '0', '--hash', '--fullhash', '--json', json];
  return new Promise((res) => {
    child = spawn(process.execPath, args, { cwd: wt, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      child = null;
      let m = null;
      try { m = JSON.parse(readFileSync(json, 'utf8')); } catch (e) { /* no metrics */ }
      rmSync(json, { force: true });
      const wall = /→ ([\d.]+) ms per sim-year/.exec(out);
      const wc = /\nworldChecksum ([0-9a-f]{8})/.exec(out), fh = /\nfullHash ([0-9a-f]{8})/.exec(out);
      if (!wall || !m) console.log(`  !! run failed (exit ${code}) in ${wt}:\n${(out + err).split('\n').slice(-15).join('\n')}`);
      res({ wall: wall ? Number(wall[1]) : NaN, systems: m ? m.msPerYear : NaN, timing: m ? m.timing : {}, worldChecksum: wc?.[1] ?? null, fullHash: fh?.[1] ?? null, exitCode: code });
    });
  });
}

const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return NaN; const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const spread = (xs) => { const s = xs.filter(Number.isFinite); const md = median(s); return s.length && md ? (Math.max(...s) - Math.min(...s)) / md : NaN; };
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(100 * v).toFixed(1)}%` : '—');
const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);

console.log(`timeab: A=${A}\n        B=${B}\n        ${YEARS} years after the load, ${ROUNDS} rounds of A,B per save, node ${process.version}`);
const report = [];
for (const save of saves) {
  console.log(`\n== ${basename(save)}`);
  const runs = { A: [], B: [] };
  for (let r = 0; r < ROUNDS; r++) {
    for (const [side, wt] of [['A', A], ['B', B]]) {
      const x = await run(wt, save, `${side}${r}`);
      runs[side].push(x);
      console.log(`  round ${r + 1} ${side}: wall ${f1(x.wall)} ms/yr, systems ${f1(x.systems)} ms/yr, wc ${x.worldChecksum} full ${x.fullHash}`);
    }
  }
  const ids = [...new Set([...runs.A, ...runs.B].flatMap((x) => Object.keys(x.timing)))];
  const col = (side, get) => runs[side].map(get);
  const rows = [['wall', (x) => x.wall], ['systems', (x) => x.systems], ...ids.map((id) => [id, (x) => x.timing[id] ?? NaN])]
    .map(([name, get]) => {
      const a = col('A', get), b = col('B', get), ma = median(a), mb = median(b);
      return { name, A: ma, B: mb, delta: ma ? (mb - ma) / ma : NaN, spreadA: spread(a), spreadB: spread(b), runsA: a, runsB: b };
    });
  const head = rows.slice(0, 2), sys = rows.slice(2).sort((p, q) => q.A - p.A);
  console.log(`\n  ${pad('ms per sim-year', 16)}${lpad('A med', 9)}${lpad('B med', 9)}${lpad('B vs A', 9)}${lpad('spread A', 10)}${lpad('spread B', 10)}`);
  for (const x of [...head, ...sys]) console.log(`  ${pad(x.name, 16)}${lpad(f1(x.A), 9)}${lpad(f1(x.B), 9)}${lpad(pct(x.delta), 9)}${lpad(pct(x.spreadA), 10)}${lpad(pct(x.spreadB), 10)}`);
  const ends = [...runs.A, ...runs.B];
  const same = ends.every((x) => x.worldChecksum && x.worldChecksum === ends[0].worldChecksum && x.fullHash === ends[0].fullHash);
  console.log(`  end states: ${same ? `all identical (wc ${ends[0].worldChecksum}, full ${ends[0].fullHash})` : 'DIFFER: ' + ends.map((x) => `${x.worldChecksum}/${x.fullHash}`).join(' ')}`);
  report.push({ save, years: YEARS, rounds: ROUNDS, rows: [...head, ...sys], identicalEndStates: same, runs });
}
if (opt('out', null)) writeFileSync(resolve(opt('out')), JSON.stringify({ createdAt: new Date().toISOString(), A, B, node: process.version, report }, null, 1));
