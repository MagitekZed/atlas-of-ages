#!/usr/bin/env node
// Bit-identity check for speed work: runs a fixed matrix of headless sims in a checkout and
// compares worldChecksum and fullHash with a baseline recorded on main. A change made only for
// speed must leave every case equal.
//
//   node tools/hashcheck.mjs [checkout] [--jobs 3] [--write-baseline] [--quick]
//                            [--baseline file] [--out results.json] [--keep-saves]
//
// Record the baseline on main, then check the branch (the checkout defaults to this repo):
//   git switch main      && node tools/hashcheck.mjs --write-baseline
//   git switch my-branch && node tools/hashcheck.mjs
// or record it from another checkout of main: node tools/hashcheck.mjs --write-baseline ../atlas-main
//
// checkout           the tree whose tools/headless.mjs runs (default: the repo this script is in)
// --jobs N           at most N headless sims at once (default 3)
// --write-baseline   record the results as the baseline (default .perf/baseline.json)
// --quick            only the three atlas cases (myth 0 @500y, myth 1 @400y, myth 2 @500y), for a
//                    look while working; cannot be combined with --write-baseline
// --baseline file    use another baseline file
// --out file         also write this run's raw results as JSON
// --keep-saves       keep the Y300 temp saves of the continuation cases (default: deleted)
//
// The matrix (12 cases, medium worlds unless noted): atlas, vane and north-fen for 500 years at
// myth levels 0 and 2; deck for 1,000 years at 0 and 2; atlas for 400 years at 1; meadow (small)
// for 800 years at 2; and atlas for 300 years → --save → --load → 200 more at 0 and 2. A load
// takes its params from the save and counts --years from the loaded day, so a continuation ends
// on day 500*360 and must also equal the direct 500-year run (reported, not a pass criterion).
// Every sim runs as `node tools/headless.mjs ... --chronicle 0 --hash --fullhash` with the
// checkout as cwd.
//
// Check mode: PASS when worldChecksum, its day and fullHash all equal the baseline (for a
// continuation, the Y300 save's hashes too) and the run reported no system errors that the
// baseline did not. A different exit code with equal hashes is shown as WARN (headless exits 1
// when a report check fails, which short runs often do). Exit code 1 on any FAIL, 2 on bad usage.
// Files go to .perf/ in the repo this script is in (ignored by git): baseline.json,
// logs/<mode>-<stamp>/<case>.log with each sim's output, and tmp/ for the continuation saves.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PERF = join(REPO, '.perf');
const argv = process.argv.slice(2);
const opt = (name, def) => { const k = argv.indexOf('--' + name); return k >= 0 ? argv[k + 1] : def; };
const flag = (name) => argv.includes('--' + name);
const valued = new Set(['--jobs', '--baseline', '--out']);
const positional = argv.filter((a, k) => !a.startsWith('--') && !valued.has(argv[k - 1]));
const WT = resolve(positional[0] ?? REPO);
const RUNNER = join(WT, 'tools', 'headless.mjs');
if (!existsSync(RUNNER)) { console.error(`no tools/headless.mjs in ${WT}\nusage: node tools/hashcheck.mjs [checkout] [--jobs N] [--write-baseline] [--quick]`); process.exit(2); }
const JOBS = Math.max(1, Number(opt('jobs', 3)) || 3);
const WRITE = flag('write-baseline');
const QUICK = flag('quick');
const BASELINE = resolve(opt('baseline', join(PERF, 'baseline.json')));
if (WRITE && QUICK) { console.error('--write-baseline needs the full matrix (drop --quick)'); process.exit(2); }
if (!WRITE && !existsSync(BASELINE)) { console.error(`no baseline at ${BASELINE} (run with --write-baseline first)`); process.exit(2); }

// ---------------------------------------------------------------------------- the matrix
const direct = (seed, size, years, myth) => ({
  id: `${seed}-${size}-y${years}-m${myth}`, kind: 'direct',
  args: ['--seed', seed, '--size', size, '--years', String(years), '--set', `mythLevel=${myth}`],
  weight: years * (size === 'small' ? 0.4 : 1),
});
const cont = (seed, size, myth) => ({
  id: `${seed}-${size}-y300+200-m${myth}`, kind: 'continuation', directId: `${seed}-${size}-y500-m${myth}`,
  save: ['--seed', seed, '--size', size, '--years', '300', '--set', `mythLevel=${myth}`],
  weight: 520 * (size === 'small' ? 0.4 : 1), // two sims in sequence: start before the 500-year ones
});
let cases = [];
for (const seed of ['atlas', 'vane', 'north-fen']) for (const m of [0, 2]) cases.push(direct(seed, 'medium', 500, m));
for (const m of [0, 2]) cases.push(direct('deck', 'medium', 1000, m));
cases.push(direct('atlas', 'medium', 400, 1));
cases.push(direct('meadow', 'small', 800, 2));
for (const m of [0, 2]) cases.push(cont('atlas', 'medium', m));
if (QUICK) cases = cases.filter((c) => ['atlas-medium-y500-m0', 'atlas-medium-y400-m1', 'atlas-medium-y500-m2'].includes(c.id));

// ---------------------------------------------------------------------------- running
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOGDIR = join(PERF, 'logs', `${QUICK ? 'quick' : WRITE ? 'baseline' : 'check'}-${stamp}`);
mkdirSync(LOGDIR, { recursive: true });
mkdirSync(join(PERF, 'tmp'), { recursive: true });
const TMP = mkdtempSync(join(PERF, 'tmp', 'hc-'));
const children = new Set();
const killAll = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } } };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });

function sim(label, args) {
  const full = [RUNNER, ...args, '--chronicle', '0', '--hash', '--fullhash'];
  const t0 = Date.now();
  return new Promise((res) => {
    const ch = spawn(process.execPath, full, { cwd: WT, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(ch);
    let out = '', err = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('close', (code, signal) => {
      children.delete(ch);
      writeFileSync(join(LOGDIR, `${label}.log`), `$ (cd ${WT} && node ${full.map((a) => a.includes(' ') ? JSON.stringify(a) : a).join(' ')})\n\n${out}\n--- stderr ---\n${err}`);
      const wc = /\nworldChecksum ([0-9a-f]{8}) \(day (\d+)\)/.exec(out);
      const fh = /\nfullHash ([0-9a-f]{8})/.exec(out);
      const ms = /→ ([\d.]+) ms per sim-year/.exec(out);
      const sysErr = /\nSYSTEM ERRORS:\n((?: {2}.*\n?)*)/.exec(out);
      res({
        cmd: `node tools/headless.mjs ${full.slice(1).join(' ')}`,
        worldChecksum: wc ? wc[1] : null, day: wc ? Number(wc[2]) : null, fullHash: fh ? fh[1] : null,
        exitCode: code ?? (signal ? 128 : 1), systemErrors: sysErr ? sysErr[1].trim().split('\n').map((l) => l.trim().split(':')[0]) : [],
        failedChecks: (out.match(/^ {2}!! /gm) || []).length,
        msPerYear: ms ? Number(ms[1]) : null, wallS: Math.round((Date.now() - t0) / 100) / 10,
      });
    });
  });
}

async function runCase(c) {
  if (c.kind === 'direct') return { id: c.id, kind: c.kind, ...(await sim(c.id, c.args)) };
  const file = join(TMP, `${c.id}.json`);
  const a = await sim(`${c.id}.save`, [...c.save, '--save', file]);
  if (!existsSync(file)) return { id: c.id, kind: c.kind, directId: c.directId, save: a, load: null, worldChecksum: null, fullHash: null };
  const b = await sim(`${c.id}.load`, ['--load', file, '--years', '200']);
  if (!flag('keep-saves')) rmSync(file, { force: true });
  // the comparable hashes of a continuation are those after the load + 200 years
  return { id: c.id, kind: c.kind, directId: c.directId, save: a, load: b,
    worldChecksum: b.worldChecksum, day: b.day, fullHash: b.fullHash, exitCode: b.exitCode, systemErrors: [...a.systemErrors, ...b.systemErrors],
    wallS: Math.round((a.wallS + b.wallS) * 10) / 10 };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  const queue = items.map((c, k) => k).sort((p, q) => items[q].weight - items[p].weight); // longest first
  const worker = async () => {
    while (next < queue.length) {
      const k = queue[next++];
      out[k] = await fn(items[k]);
      done++;
      process.stdout.write(`  [${done}/${items.length}] ${items[k].id}: wc ${out[k].worldChecksum ?? '—'} full ${out[k].fullHash ?? '—'} (${out[k].wallS}s)\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const commit = (() => { try { return execFileSync('git', ['-C', WT, 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return '?'; } })();
const dirty = (() => { try { return execFileSync('git', ['-C', WT, 'status', '--porcelain', '--untracked-files=no'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() ? ' (+uncommitted changes)' : ''; } catch (e) { return ''; } })();
console.log(`hashcheck: ${cases.length} cases in ${WT} @ ${commit}${dirty}, ${JOBS} at once, node ${process.version}`);
const t0 = Date.now();
const results = await pool(cases, JOBS, runCase);
if (!flag('keep-saves')) rmSync(TMP, { recursive: true, force: true });
else console.log(`continuation saves kept in ${TMP}`);
const byId = Object.fromEntries(results.map((r) => [r.id, r]));
const wallTotal = Math.round((Date.now() - t0) / 1000);

// continuation vs the direct 500-year run (a fact to report, not a pass/fail criterion)
for (const r of results) {
  if (r.kind !== 'continuation') continue;
  const d = byId[r.directId];
  r.equalsDirect = d ? { worldChecksum: r.worldChecksum === d.worldChecksum, fullHash: r.fullHash === d.fullHash } : null;
}

const pad = (s, n) => String(s).padEnd(n);
if (WRITE) {
  const data = { createdAt: new Date().toISOString(), worktree: WT, commit: commit + dirty, node: process.version, jobs: JOBS,
    cases: Object.fromEntries(results.map((r) => [r.id, r])) };
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(data, null, 1));
  console.log(`\nBaseline written: ${BASELINE} (${wallTotal} s)\n`);
  console.log(pad('case', 30) + pad('worldChecksum', 15) + pad('day', 8) + pad('fullHash', 10) + pad('exit', 6) + pad('ms/yr', 14) + 'wall s');
  for (const r of results) console.log(pad(r.id, 30) + pad(r.worldChecksum ?? '—', 15) + pad(r.day ?? '—', 8) + pad(r.fullHash ?? '—', 10) + pad(r.exitCode, 6) + pad(r.msPerYear ?? (r.load ? `${r.save.msPerYear}/${r.load.msPerYear}` : '—'), 14) + r.wallS);
  for (const r of results) if (r.kind === 'continuation') console.log(`  ${r.id}: Y300 save wc ${r.save.worldChecksum} full ${r.save.fullHash}; continuation ${r.equalsDirect?.worldChecksum && r.equalsDirect?.fullHash ? 'EQUALS' : 'DIFFERS FROM'} the direct ${r.directId} run (worldChecksum ${r.equalsDirect?.worldChecksum ? 'same' : 'different'}, fullHash ${r.equalsDirect?.fullHash ? 'same' : 'different'})`);
  const missing = results.filter((r) => !r.worldChecksum || !r.fullHash || r.systemErrors.length);
  if (missing.length) { console.log(`\n!! ${missing.length} case(s) without hashes or with system errors: ${missing.map((r) => r.id).join(', ')}`); process.exit(1); }
  process.exit(0);
}

if (!existsSync(BASELINE)) { console.error(`no baseline at ${BASELINE} (run with --write-baseline first)`); process.exit(2); }
const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
let fails = 0, warns = 0;
console.log(`\nCompared with ${BASELINE} (recorded ${base.createdAt} @ ${base.commit}); ${wallTotal} s\n`);
console.log(pad('result', 7) + pad('case', 30) + pad('worldChecksum now / base', 27) + pad('fullHash now / base', 23) + pad('exit', 7) + 'wall s');
const rows = [];
for (const r of results) {
  const b = base.cases?.[r.id];
  let res = 'PASS';
  const why = [];
  if (!b) { res = 'FAIL'; why.push('no baseline for this case'); }
  else {
    if (!r.worldChecksum || r.worldChecksum !== b.worldChecksum || r.day !== b.day) { res = 'FAIL'; why.push('worldChecksum'); }
    if (!r.fullHash || r.fullHash !== b.fullHash) { res = 'FAIL'; why.push('fullHash'); }
    if (r.kind === 'continuation' && b.save && (r.save.worldChecksum !== b.save.worldChecksum || r.save.fullHash !== b.save.fullHash)) { res = 'FAIL'; why.push('Y300 save hashes'); }
    const newErr = r.systemErrors.filter((e) => !(b.systemErrors || []).includes(e));
    if (newErr.length) { res = 'FAIL'; why.push('new system errors: ' + newErr.join(',')); }
    if (res === 'PASS' && r.exitCode !== b.exitCode) { res = 'WARN'; why.push(`exit ${r.exitCode} vs ${b.exitCode}`); }
  }
  if (res === 'FAIL') fails++; else if (res === 'WARN') warns++;
  rows.push({ id: r.id, res, why });
  console.log(pad(res, 7) + pad(r.id, 30) + pad(`${r.worldChecksum ?? '—'} / ${b?.worldChecksum ?? '—'}`, 27) + pad(`${r.fullHash ?? '—'} / ${b?.fullHash ?? '—'}`, 23) + pad(`${r.exitCode}/${b?.exitCode ?? '—'}`, 7) + r.wallS + (why.length ? `   ${why.join('; ')}` : ''));
}
for (const r of results) if (r.kind === 'continuation') console.log(`  ${r.id}: continuation ${r.equalsDirect?.worldChecksum && r.equalsDirect?.fullHash ? 'equals' : 'differs from'} the direct ${r.directId} run (worldChecksum ${r.equalsDirect?.worldChecksum ? 'same' : 'different'}, fullHash ${r.equalsDirect?.fullHash ? 'same' : 'different'}; baseline: ${base.cases?.[r.id]?.equalsDirect ? JSON.stringify(base.cases[r.id].equalsDirect) : '—'})`);
if (opt('out', null)) writeFileSync(resolve(opt('out')), JSON.stringify({ createdAt: new Date().toISOString(), worktree: WT, commit: commit + dirty, results, verdicts: rows }, null, 1));
console.log(`\n${fails ? 'FAIL' : 'PASS'}: ${results.length - fails - warns} pass, ${warns} warn, ${fails} fail (logs in ${LOGDIR})`);
process.exit(fails ? 1 : 0);
