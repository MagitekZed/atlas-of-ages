#!/usr/bin/env node
// Names report: how often the names a world gives its faiths, plagues, wars, bands, dragons,
// lairs, epithets and the rest also turn up in another world. Several seeds run (each at every
// mythLevel asked for) in parallel child processes; every child collects each kind of name as
// it is made (hooks, so pruning hides none) and from the world at the end, and the parent
// counts, per kind, the share of a world's distinct names that a world of another seed also
// used (the same seed at another level shares its geography, so it is never counted against
// itself), the names repeated across the most seeds, and the names a world used twice.
//
//   node tools/names-report.mjs [--seeds 20 | --seeds atlas,kestrel,…] [--years 600]
//                               [--levels 0,2] [--size medium] [--jobs 8] [--top 6]
//                               [--kinds faith,plague,…] [--json out.json] [--set key=value …]
//   node tools/names-report.mjs --from out.json [--kinds …]     re-reads a saved run (no simulation)
//   --save-dir DIR writes each world's names to DIR/<seed>-L<level>.json as it finishes (a later run
//   with the same DIR skips the worlds already there); --from-dir DIR reports on whatever DIR holds.
//
// Kinds (owner in brackets; targets from docs/design/temperament-and-names.md §3 marked *):
//   faith* plague* war* (war.civ: wars the civ module names) battle outlaw* pirate* company
//   horde beast undead dragon* dragon.epithet lair* leader.epithet general.epithet
//   town.epithet* ruler.epithet* [civ] dynasty [civ] figure.epithet storm fire volcano
//   feature age swan legend route [geo trade] realm [civ/myth]
// A "frame" is a name with its world-made words (tokens seen in fewer than 3 seeds) masked as
// "…": the frames column counts the distinct patterns behind a kind's names.
//
// Exit code 1 when a targeted kind misses its target (faiths, plagues, wars, outlaw and pirate
// bands, dragons and lairs under 10 % shared; town and ruler epithets under 25 %).

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, def) => { const k = argv.indexOf('--' + name); return k >= 0 ? argv[k + 1] : def; };
const sets = []; argv.forEach((a, k) => { if (a === '--set') sets.push(argv[k + 1]); });

const SEED_WORDS = ['atlas', 'kestrel', 'umber', 'vane', 'north-fen-795', 'ember', 'saltmarsh', 'orrery', 'tamarisk', 'gale',
  'lodestar', 'quillon', 'harrow', 'cinder-9', 'meridian', 'fallow', 'bracken', 'isthmus', 'sable', 'wren-31',
  'cobalt', 'drumlin', 'yarrow', 'tessera', 'halcyon', 'moraine', 'veldt', 'pumice', 'osier', 'zenith'];

/** Targets: kind → max share of names shared with another seed. */
const TARGETS = {
  faith: 0.10, plague: 0.10, war: 0.10, outlaw: 0.10, pirate: 0.10, dragon: 0.10, lair: 0.10,
  'town.epithet': 0.25, 'ruler.epithet': 0.25,
};
const OWNER = {
  faith: 'geo', plague: 'geo', war: 'geo', 'war.civ': 'civ', battle: 'geo', 'general.epithet': 'geo',
  outlaw: 'bands', pirate: 'bands', company: 'bands', horde: 'bands', beast: 'bands', undead: 'bands', dragon: 'bands',
  'dragon.epithet': 'bands', lair: 'bands', 'leader.epithet': 'bands', 'town.epithet': 'events', age: 'events', swan: 'events',
  legend: 'events', 'ruler.epithet': 'civ', dynasty: 'civ', realm: 'civ/myth', 'figure.epithet': 'mixed', storm: 'nature',
  fire: 'nature', volcano: 'nature', feature: 'gen', route: 'trade',
};
const ORDER = ['faith', 'plague', 'war', 'war.civ', 'battle', 'general.epithet', 'outlaw', 'pirate', 'company', 'horde', 'beast', 'undead',
  'dragon', 'dragon.epithet', 'lair', 'leader.epithet', 'town.epithet', 'ruler.epithet', 'dynasty', 'figure.epithet', 'age', 'swan',
  'legend', 'storm', 'fire', 'volcano', 'feature', 'route', 'realm'];

/** Text a generator should never leave in a name: unfilled slots, null words, doubled articles or spaces. */
const MALFORMED_CS = /[{}]|\bundefined\b|\bnull\b|\bNaN\b|\s{2}|'s's|^\s|\s$/;
const MALFORMED_CI = /\b(the|of|a|an|and) \1\b/i;
const MALFORMED = { test: (n) => MALFORMED_CS.test(n) || MALFORMED_CI.test(n) };

if (argv.includes('--child')) await child();
else await parent();

// ---------------------------------------------------------------------------

async function child() {
  const { createWorld } = await import('../src/core/world.js');
  const { Simulation } = await import('../src/core/sim.js');
  const { loadSystems } = await import('../src/systems.js');
  const { on } = await import('../src/core/hooks.js');
  const seed = opt('seed', 'atlas'), years = Number(opt('years', 600)), level = Number(opt('level', 0));
  const params = { seed, worldSize: opt('size', 'medium'), mythLevel: level };
  for (const s of sets) {
    const [k, v] = s.split('=');
    params[k] = v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v;
  }
  const world = createWorld(params);
  try { (await import('../src/gen/worldgen.js')).generateWorld(world); } catch (e) { const { fallbackGenerate } = await import('./fallback-gen.mjs'); fallbackGenerate(world); }
  const systems = await loadSystems({ onError: () => {} });
  const sim = new Simulation(world, systems);
  sim.init();

  // kind → { name: times made }; a Map per kind keeps insertion order
  const names = {};
  const seen = new Map();   // kind|ident → true (an entity counted once however often it is sampled)
  const add = (kind, name, ident = null) => {
    if (typeof name !== 'string') return;
    const n = name.trim();
    if (!n) return;
    if (ident != null) { const k = kind + '|' + ident; if (seen.has(k)) return; seen.set(k, true); }
    const m = (names[kind] ||= {});
    m[n] = (m[n] || 0) + 1;
  };
  const CIV_WARS = new Set(['civil war', 'independence', 'claim', 'restoration', 'secession', 'rebellion']);
  const BAND_KIND = { bandits: 'outlaw', pirates: 'pirate', company: 'company', horde: 'horde', migration: 'horde', undead: 'undead',
    troll: 'beast', giant: 'beast', wyvern: 'beast', treant: 'beast', kraken: 'beast', behemoth: 'beast' };
  const tail = (full, head) => {
    if (typeof full !== 'string' || typeof head !== 'string' || !head || full === head) return null;
    if (full.startsWith(head + ' ')) return full.slice(head.length + 1);
    if (full.endsWith(' ' + head)) return full.slice(0, full.length - head.length - 1);
    return null;
  };
  const noteBand = (b) => {
    if (!b) return;
    if (b.kind === 'dragon') {
      add('dragon', b.epithet ? `${b.name} ${b.epithet}` : b.name, b.id);
      if (b.epithet && b.epithet !== 'the Elder') add('dragon.epithet', b.epithet, b.id);
      const site = b.data && b.data.lair != null ? world.sites.find((q) => q && q.id === b.data.lair) : null;   // ids, not indexes
      if (site && site.kind === 'lair' && site.name && !/^the Bones of /.test(site.name)) add('lair', site.name, 'site' + site.id);
    } else if (BAND_KIND[b.kind]) add(BAND_KIND[b.kind], b.name, b.id);
    const L = b.leader;
    if (L && typeof L === 'object') {
      const ep = tail(L.name, L.short);
      if (ep && !/^(Captain|Khan|Noyan)$/.test(ep)) add('leader.epithet', ep, `${b.id}|${L.name}`);
    }
  };
  on('bandCreated', (w, b) => noteBand(b));
  on('battle', (w, p) => { if (p && p.name) add('battle', p.name); });
  const noteRuler = (r) => { if (r && r.epithet) add('ruler.epithet', r.epithet, `${r.id ?? r.name}|${r.epithet}`); if (r && r.dynasty) add('dynasty', String(r.dynasty), r.dynasty); };
  on('succession', (w, civ, prev, next) => { noteRuler(prev); noteRuler(next); });
  on('rulerDied', (w, civ, r) => noteRuler(r));
  on('stormEnded', (w, p) => { if (p && p.kind === 'cyclone') add('storm', p.name, p.id); });
  on('fireEnded', (w, f) => { if (f && f.name) add('fire', f.name, f.id); });
  on('figureBorn', (w, f) => { if (f && f.kind === 'general') { const ep = f.name && f.name.includes(' ') ? f.name.slice(f.name.indexOf(' ') + 1) : null; if (ep) add('general.epithet', ep, f.id); } });

  const sample = () => {
    for (const s of world.settlements) if (s && s.alive && s.epithet) add('town.epithet', String(s.epithet), `${s.id}|${s.epithet}`);
    for (const c of world.civs) if (c && c.alive && c.ruler) noteRuler(c.ruler);
    for (const b of world.bands) noteBand(b);
  };
  for (let d = 0; d < years * 360; d++) {
    sim.step();
    if (world.time.day % (5 * 360) === 0) sample();
  }
  sample();
  for (const r of world.religions) if (r) add('faith', r.name, r.id);
  for (const p of world.plagues) if (p) add('plague', p.name, p.id);
  for (const w of world.wars) if (w) add(CIV_WARS.has(String(w.cause)) ? 'war.civ' : 'war', w.name, w.id);
  for (const s of world.sites || []) if (s && s.kind === 'lair' && s.name && !/^the Bones of /.test(s.name)) add('lair', s.name, 'site' + s.id);
  for (const s of world.settlements) if (s && s.legend && s.legend.text) add('legend', s.legend.text, s.id);
  for (const f of world.figures) if (f && f.epithet) add('figure.epithet', f.epithet, f.id);
  for (const f of world.fires) if (f && f.name) add('fire', f.name, f.id);
  for (const v of world.volcanoes) if (v && v.name) add('volcano', v.name, v.id);
  for (const ft of world.features) if (ft && ft.name) add('feature', ft.name, ft.id);
  for (const r of world.tradeRoutes) if (r && r.name) add('route', r.name, r.id);
  for (const c of world.civs) if (c && c.name) add('realm', c.name, c.id);
  const ev = world.sys.events || {};
  for (const a of [...(ev.ages?.past || []), ...(ev.ages?.cur || [])]) if (a && a.name) add('age', a.name, `${a.key}|${a.from}`);
  for (const h of ev.swan?.hist || []) if (h && h.name) add('swan', h.name, `${h.name}|${h.day}`);
  const errors = Object.fromEntries(Object.entries(sim.errors || {}).map(([k, v]) => [k, v.count]));
  process.stdout.write(JSON.stringify({ seed, level, years, names, errors }));
}

// ---------------------------------------------------------------------------

function run(seed, level, years) {
  const script = fileURLToPath(import.meta.url);
  const args = [script, '--child', '--seed', seed, '--level', String(level), '--years', String(years), '--size', opt('size', 'medium')];
  for (const s of sets) args.push('--set', s);
  return new Promise((resolve) => {
    execFile(process.execPath, args, { maxBuffer: 256 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) { resolve({ seed, level, error: (errOut || err.message).split('\n').slice(-6).join('\n') }); return; }
      try { resolve(JSON.parse(out)); } catch (e) { resolve({ seed, level, error: 'bad output: ' + String(out).slice(0, 200) }); }
    });
  });
}

/** Per kind: distinct names per world, the share another seed also used, top repeats, frames. */
export function analyse(results, kinds = null) {
  // tokens seen in at least 3 seeds are the shared vocabulary; the rest are world-made words
  const tokSeeds = new Map();
  for (const r of results) {
    const toks = new Set();
    for (const kind in r.names) for (const n in r.names[kind]) for (const t of n.split(/[\s–-]+/)) toks.add(t.replace(/[^\p{L}']/gu, ''));
    for (const t of toks) { if (!t) continue; const s = tokSeeds.get(t) || new Set(); s.add(r.seed); tokSeeds.set(t, s); }
  }
  const nSeeds = new Set(results.map((r) => r.seed)).size;
  const need = Math.max(2, Math.min(3, nSeeds));
  const common = (t) => (tokSeeds.get(t.replace(/[^\p{L}']/gu, ''))?.size || 0) >= need || /^(Year|\d+)$/.test(t);
  const frameOf = (n) => n.split(/(\s+|–|-)/).map((t) => (/^(\s+|–|-)$/.test(t) || !t ? t : common(t) ? t : '…')).join('').replace(/…(?:[\s'’-]*…)+/g, '…');
  const out = {};
  const all = new Set();
  for (const r of results) for (const k in r.names) all.add(k);
  for (const kind of [...all]) {
    if (kinds && !kinds.includes(kind)) continue;
    const bySeed = new Map();    // name → Set(seed)
    let total = 0, made = 0, dupWorlds = 0, dupNames = 0;
    const bad = [];
    const frames = new Map();
    for (const r of results) {
      const m = r.names[kind] || {};
      for (const n in m) {
        const s = bySeed.get(n) || new Set(); s.add(r.seed); bySeed.set(n, s);
        total++; made += m[n];
        if (m[n] > 1) dupNames++;
        const f = frameOf(n); frames.set(f, (frames.get(f) || 0) + 1);
        if (MALFORMED.test(n) && bad.length < 8) bad.push(n);
      }
      if (Object.values(m).some((v) => v > 1)) dupWorlds++;
    }
    let shared = 0;
    for (const r of results) for (const n in r.names[kind] || {}) if (bySeed.get(n).size > 1) shared++;
    const top = [...bySeed.entries()].filter(([, s]) => s.size > 1).sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1)).slice(0, 12).map(([n, s]) => [n, s.size]);
    const topFrames = [...frames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    out[kind] = {
      worlds: results.filter((r) => r.names[kind]).length, total, made, distinct: bySeed.size, shared: total ? shared / total : 0,
      dupNames, dupWorlds, bad, frames: frames.size, topFrame: topFrames[0] ? [topFrames[0][0], topFrames[0][1] / Math.max(1, total)] : null, top, topFrames,
    };
  }
  return out;
}

async function parent() {
  const sArg = opt('seeds', '20');
  const seeds = /^\d+$/.test(sArg) ? Array.from({ length: Number(sArg) }, (_, k) => SEED_WORDS[k] || `names-${k}`) : sArg.split(',');
  const years = Number(opt('years', 600));
  const levels = opt('levels', '0,2').split(',').map(Number);
  const jobs = Math.max(1, Number(opt('jobs', Math.max(1, cpus().length))));
  const topN = Number(opt('top', 6));
  const kinds = opt('kinds', null)?.split(',') || null;
  const tasks = [];
  for (const s of seeds) for (const l of levels) tasks.push([s, l]);
  const saveDir = opt('save-dir', null), fromDir = opt('from-dir', null);
  const readDir = (d) => readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')));
  let from = opt('from', null) ? JSON.parse(readFileSync(opt('from'), 'utf8')) : null;
  if (fromDir) {
    const raw = readDir(fromDir);
    from = { raw, seeds: [...new Set(raw.map((r) => r.seed))], years: raw[0]?.years ?? years, levels: [...new Set(raw.map((r) => r.level))] };
  }
  if (saveDir) mkdirSync(saveDir, { recursive: true });
  const fileOf = (s, l) => join(saveDir, `${s}-L${l}.json`);
  if (from) console.log(`Names report (from ${opt('from')}): ${from.seeds.length} seeds × ${from.years} years at mythLevel ${from.levels.join(' and ')}`);
  else console.log(`Names report: ${seeds.length} seeds × ${years} years at mythLevel ${levels.join(' and ')} (${tasks.length} worlds, ${jobs} at a time)${sets.length ? ' (' + sets.join(', ') + ')' : ''}`);
  const t0 = Date.now();
  const res = from ? from.raw.slice() : [];
  if (saveDir && !from) for (let k = tasks.length - 1; k >= 0; k--) if (existsSync(fileOf(...tasks[k]))) { res.push(JSON.parse(readFileSync(fileOf(...tasks[k]), 'utf8'))); tasks.splice(k, 1); }
  let next = from ? tasks.length : 0;
  await Promise.all(Array.from({ length: from ? 0 : Math.min(jobs, tasks.length) }, async () => {
    while (next < tasks.length) {
      const [s, l] = tasks[next++];
      const r = await run(s, l, years);
      res.push(r);
      if (saveDir && !r.error) writeFileSync(fileOf(s, l), JSON.stringify(r));
      process.stderr.write(`  ${r.error ? '!!' : 'ok'} ${s} L${l} (${res.length}/${tasks.length}, ${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
    }
  }));
  console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
  const ok = res.filter((r) => !r.error).sort((a, b) => (a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : a.level - b.level));
  for (const r of res.filter((x) => x.error)) console.log(`!! ${r.seed} L${r.level} failed:\n${r.error}\n`);
  const errs = ok.filter((r) => Object.keys(r.errors || {}).length);
  for (const r of errs) console.log(`!! ${r.seed} L${r.level} system errors ${JSON.stringify(r.errors)}`);

  const report = (label, rs) => {
    const a = analyse(rs, kinds);
    const pad = (s, n) => String(s).padStart(n), padE = (s, n) => String(s).padEnd(n);
    console.log(`${label}`);
    console.log([padE('kind', 16), pad('owner', 9), pad('worlds', 7), pad('names', 7), pad('/world', 7), pad('shared', 8), pad('target', 8), pad('frames', 7), pad('dup', 5), '  most repeated (seeds)'].join(''));
    const ks = Object.keys(a).sort((x, y) => (ORDER.indexOf(x) + 1 || 99) - (ORDER.indexOf(y) + 1 || 99) || (x < y ? -1 : 1));
    for (const k of ks) {
      const v = a[k], t = TARGETS[k];
      const mark = t == null ? '  ' : v.shared < t ? 'ok' : '!!';
      const top = v.top.slice(0, topN).map(([n, c]) => `${n.length > 38 ? n.slice(0, 37) + '…' : n} (${c})`).join('; ');
      console.log([padE(k, 16), pad(OWNER[k] || '', 9), pad(v.worlds, 7), pad(v.total, 7), pad((v.total / Math.max(1, v.worlds)).toFixed(1), 7),
        pad((100 * v.shared).toFixed(1) + '%', 8), pad(t == null ? '' : `<${Math.round(100 * t)}% ${mark}`, 8), pad(v.frames, 7), pad(v.dupNames, 5), '  ' + (top || '—')].join(''));
    }
    console.log('');
    return a;
  };
  const all = report('All worlds (shared = also named in a world of another seed):', ok);
  const byLevel = {};
  const lv = [...new Set(ok.map((r) => r.level))].sort();
  if (lv.length > 1) for (const l of lv) byLevel[l] = report(`mythLevel ${l} only:`, ok.filter((r) => r.level === l));

  console.log('Most common frames (… = a world-made word):');
  for (const k of Object.keys(all).sort((x, y) => (ORDER.indexOf(x) + 1 || 99) - (ORDER.indexOf(y) + 1 || 99))) {
    const v = all[k];
    if (!v.topFrames.length) continue;
    console.log(`  ${k.padEnd(16)} ${v.topFrames.slice(0, 4).map(([f, c]) => `${f.length > 34 ? f.slice(0, 33) + '…' : f} ${Math.round(100 * c / Math.max(1, v.total))}%`).join(' · ')}`);
  }
  const malformed = Object.entries(all).filter(([, v]) => v.bad.length);
  if (malformed.length) {
    console.log('\nMalformed names:');
    for (const [k, v] of malformed) console.log(`  ${k.padEnd(16)} ${v.bad.join(' · ')}`);
  }
  const checks = Object.entries(TARGETS).filter(([k]) => all[k] && (!kinds || kinds.includes(k))).map(([k, t]) => [all[k].shared < t, `${k}: ${(100 * all[k].shared).toFixed(1)}% shared (target < ${Math.round(100 * t)}%)`]);
  checks.push([errs.length === 0 && ok.length === res.length, 'every world ran without system errors']);
  checks.push([!malformed.some(([k]) => OWNER[k] && !['civ', 'civ/myth', 'trade', 'mixed'].includes(OWNER[k])), 'no malformed names (unfilled slots, doubled words) in the kinds this tool targets']);
  console.log('\nTargets:');
  for (const [pass, label] of checks) console.log(`  ${pass ? 'ok' : '!!'} ${label}`);
  if (opt('json', null) && !from) writeFileSync(opt('json'), JSON.stringify({ seeds, years, levels, all, byLevel, raw: ok }, null, 1));
  process.exit(checks.every(([p]) => p) ? 0 : 1);
}
