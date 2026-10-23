#!/usr/bin/env node
// Mythic acceptance check (WP5, docs/design/expansion-packages.md): runs worlds in child processes
// and checks
//   1. a Historical world is byte-identical with and without the myth module
//      (tools/headless.mjs --determinism on two seeds)
//   2. at mythLevel 2 every enabled race is still alive at the end (a living town of its
//      people) in at least 60 % of seeds; realms of their own are reported alongside
//   3. era pacing (first Bronze and Iron Age) within ±25 % of the same seeds at mythLevel 0
//   4. the myth system costs at most 8 ms per sim-year at mythLevel 2
//   5. mixed peoples (docs/design/mixed-peoples.md): every live town holds a valid mix (shares ≥
//      PEOPLES_MIN summing to 1, s.race its dominant people) at Y300, Y600 and the end; by Y600
//      at least 25 % of towns (mean over seeds) hold a minority ≥ 10 % and every world has a
//      city with three peoples ≥ 10 %; no race leaves the world purely through mixing (checked
//      year by year: a people that vanishes must have lost its last towns to ruin, not to
//      mixing)
//   6. the human peoples (docs/design/temperament-and-names.md §2): at the default raceMix they hold
//      at most 45 % of the world's people at the end (mean over seeds); reported alongside: how
//      often each race learns a historical tech from others (diffusion) rather than alone, the
//      human bonuses averaged over human realm-years (races.js humanEdge: learning from others,
//      cosmopolitan), each race's temperament drift from birth and the spread between its
//      realms, and a few human chronicle entries
// plus informational lines: niche shares at genesis, notable myth entries per century,
// miracles, folklore, mana and the weave, and the town mixes at Y300 / Y600 / the end with
// turnings and expulsions per century.
//
//   node tools/myth-check.mjs [--seeds 10] [--years 1000] [--size medium] [--jobs 6]
//                             [--set key=value …] [--skip-determinism] [--quick]
//                             [--save-json runs.json] [--hist-json runs.json]
//   --quick: 3 seeds × 300 years (pacing and survival lines are then only indicative)
//   --save-json writes every run's summary; --hist-json reuses the Historical (mythLevel 0)
//   runs of such a file instead of running them again (a Historical world never sees the
//   myth, so a change confined to it leaves those runs as they were: same seeds, years, size)
// Exit code 1 if a check fails.

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, def) => { const k = argv.indexOf('--' + name); return k >= 0 ? argv[k + 1] : def; };
const flag = (name) => argv.includes('--' + name);
const sets = []; argv.forEach((a, k) => { if (a === '--set') sets.push(argv[k + 1]); });
const SELF = fileURLToPath(import.meta.url);
const ROOT = new URL('..', import.meta.url);

if (flag('child')) { await child(); process.exit(0); }

const quick = flag('quick');
const SEEDS_ALL = ['atlas', 'kestrel', 'north-fen-795', 'amber-reach-101', 'cobalt-vale-202', 'dusk-mere-303', 'iron-tor-404', 'salt-weald-505', 'umber-cairn-606', 'jade-firth-707', 'pale-moor-808', 'opal-sound-909'];
const nSeeds = Math.max(1, Math.min(SEEDS_ALL.length, Number(opt('seeds', quick ? 3 : 10))));
const years = Math.max(10, Number(opt('years', quick ? 300 : 1000)));
const size = opt('size', 'medium');
const jobs = Math.max(1, Number(opt('jobs', Math.max(1, Math.min(8, cpus().length - 1)))));
const seeds = SEEDS_ALL.slice(0, nSeeds);

// ---------------------------------------------------------------------------
// Child: simulate one world and print a JSON summary

async function child() {
  const seed = opt('seed', 'atlas');
  const level = Number(opt('level', 2));
  const yrs = Number(opt('years', 1000));
  const params = { seed, worldSize: opt('size', 'medium'), mythLevel: level };
  for (const s of sets) { const [k, v] = s.split('='); params[k] = v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v; }
  const { createWorld } = await import(new URL('src/core/world.js', ROOT));
  const { Simulation } = await import(new URL('src/core/sim.js', ROOT));
  const { loadSystems } = await import(new URL('src/systems.js', ROOT));
  const { DAYS_PER_YEAR } = await import(new URL('src/core/constants.js', ROOT));
  const w = createWorld(params);
  try { (await import(new URL('src/gen/worldgen.js', ROOT))).generateWorld(w); } catch (e) { (await import(new URL('tools/fallback-gen.mjs', ROOT))).fallbackGenerate(w); }
  const sim = new Simulation(w, await loadSystems({}));
  // how each people learns: own research or from others (historical techs only), by race
  const { on } = await import(new URL('src/core/hooks.js', ROOT));
  const tech = await import(new URL('src/sim/civ/tech.js', ROOT));
  const learnBy = {};
  on('techDiscovered', (world, civ, id, how) => {
    if (world !== w || !civ || tech.isArcane(tech.techDef(id))) return;
    if (how !== 'research' && how !== 'diffusion') return;
    const k = civ.race || 'historical';
    const e = (learnBy[k] ||= { research: 0, diffusion: 0 });
    e[how]++;
  });
  sim.init();
  const first = {};
  const raceMod = level >= 2 ? await import(new URL('src/sim/myth/races.js', ROOT)) : null;
  const edge = { n: 0, learn: 0, cosmo: 0, others: 0, learnOn: 0, max: { learn: 0, cosmo: 0 } };   // human bonuses, civ-years
  const peoples = level >= 2 ? await import(new URL('src/sim/myth/peoples.js', ROOT)) : null;
  const mixAt = {};
  const vanished = [];          // [{ race, year, how: 'ruin' | 'mixing' }]
  let holders = null;           // race → sids of live towns holding it (≥ PEOPLES_MIN)
  const holdersOf = () => {
    const m = {};
    for (const s of w.settlements) if (s && s.alive && s.peoples) for (const r in s.peoples) if (s.peoples[r] >= peoples.PEOPLES_MIN) (m[r] ||= []).push(s.id);
    return m;
  };
  let tPeoples = 0;
  const t0 = performance.now();
  for (let y = 1; y <= yrs; y++) {
    sim.run(DAYS_PER_YEAR);
    for (const c of w.civs) if (c && c.alive) for (let e = 1; e <= (c.tech?.era || 0); e++) if (first[e] == null) first[e] = y;
    if (typeof raceMod?.humanEdge === 'function') {
      for (const c of w.civs) {
        if (!c || !c.alive || c.race !== 'human') continue;
        const h = raceMod.humanEdge(w, c);
        if (!h) continue;
        edge.n++; edge.learn += h.learn; edge.cosmo += h.cosmo; edge.others += h.others;
        if (h.learn > 0) edge.learnOn++;
        if (h.learn > edge.max.learn) edge.max.learn = h.learn;
        if (h.cosmo > edge.max.cosmo) edge.max.cosmo = h.cosmo;
      }
    }
    if (peoples) {
      const tp = performance.now();
      const now = holdersOf();
      if (holders) for (const r of Object.keys(holders)) {
        if (now[r]) continue;
        // gone this year: through ruin if every town that held it is dead, else through mixing
        const how = holders[r].every((sid) => !w.settlements[sid]?.alive) ? 'ruin' : 'mixing';
        vanished.push({ race: r, year: y, how });
      }
      holders = now;
      if (y === 300 || y === 600 || y === yrs) {
        const st = peoples.mixStats(w);
        mixAt[y] = { ...st, counts: peoples.peoplesCounts(w), world: peoples.worldPeoples(w).map((e) => [e.race, Math.round(100 * e.share), e.towns]) };
      }
      tPeoples += performance.now() - tp;
    }
  }
  const ms = performance.now() - t0 - tPeoples;
  const out = { seed, level, years: yrs, first, msPerYear: ms / yrs, mythMs: (sim.timing.myth || 0) / yrs, errors: Object.keys(sim.errors), learnBy };
  // per race at the end: live realms, mean era, temperament drift from birth (when the civ
  // module keeps the founding temperament in flags.temper0: mean of each realm's largest move)
  const TR = ['aggression', 'expansion', 'religiosity', 'commerce', 'innovation', 'tolerance', 'militarism', 'isolation'];
  const byRace = {};
  for (const c of w.civs) {
    if (!c || !c.alive) continue;
    const k = c.race || 'historical';
    const e = (byRace[k] ||= { civs: 0, era: 0, techs: 0, drift: 0, driftN: 0, spread: [] });
    e.civs++; e.era += c.tech?.era || 0;
    for (const id in c.tech?.known || {}) if (!tech.isArcane(tech.techDef(id))) e.techs++;
    const t0 = c.flags?.temper0;
    if (t0 && c.traits) {
      let m = 0;
      for (const t of TR) { const d = Math.abs((c.traits[t] ?? 0.5) - (t0[t] ?? 0.5)); if (d > m) m = d; }
      e.drift += m; e.driftN++;
    }
    if (c.traits) e.spread.push(TR.map((t) => c.traits[t] ?? 0.5));
  }
  for (const e of Object.values(byRace)) {
    e.era /= Math.max(1, e.civs);
    e.techs /= Math.max(1, e.civs);
    e.drift = e.driftN ? e.drift / e.driftN : null;
    // how different the realms of one race are from one another: mean trait standard deviation
    const n = e.spread.length;
    if (n >= 2) {
      let s = 0;
      for (let t = 0; t < TR.length; t++) {
        const m = e.spread.reduce((a, v) => a + v[t], 0) / n;
        s += Math.sqrt(e.spread.reduce((a, v) => a + (v[t] - m) ** 2, 0) / n);
      }
      e.spread = s / TR.length;
    } else e.spread = null;
  }
  out.byRace = byRace;
  // which people led the world into each age (sys.civ.eraFirst)
  out.eraFirst = Object.fromEntries(Object.entries(w.sys.civ?.eraFirst || {}).map(([e, v]) => [e, w.civs[v?.civId]?.race || 'historical']));
  if (edge.n) out.edge = { civYears: edge.n, learn: edge.learn / edge.n, cosmo: edge.cosmo / edge.n, others: edge.others / edge.n, learnOn: edge.learnOn / edge.n, max: edge.max };
  if (level >= 2) {
    const myth = await import(new URL('src/sim/myth/index.js', ROOT));
    const races = await import(new URL('src/sim/myth/races.js', ROOT));
    const census = myth.raceCensus(w);
    const enabled = races.enabledRaces(w).filter((r) => (races.mixOf(w).genesis[r] || 0) > 0);
    out.census = Object.fromEntries(Object.entries(census).map(([r, v]) => [r, { civs: v.civs, towns: v.towns, pop: Math.round(v.pop) }]));
    out.enabled = enabled;
    out.niche = w.sys.myth?.niche || null;
    out.weave = w.sys.myth?.weave;
    out.divine = w.sys.myth?.divine?.n || 0;
    out.folk = w.sys.myth?.folk?.n || 0;
    // notable myth news: WP5's own (miracles, tales, race milestones, the Fading, the dead of a
    // people…) and, more widely, everything in the Myth & Magic category (beasts included)
    let own = 0, all = 0, major = 0;
    for (const e of w.chronicle.entries) {
      if (e.imp < 2 || e.day <= 0) continue;
      const mine = Boolean(e.key && (e.key.startsWith('myth.') || e.key.startsWith('event.folk_')));
      if (mine) own++;
      if (mine || e.cat === 'myth') all++;
      if (e.cat === 'myth' && e.imp >= 3) major++;
    }
    out.mythNotablePerCentury = (100 * own) / yrs;
    out.mythAllPerCentury = (100 * all) / yrs;
    out.mythMajorPerCentury = (100 * major) / yrs;
    // splinters of another people (a halfling shire breaking from an orc realm) speak their own
    // tongue, so their rulers and towns read as their people's
    const sig = (l) => JSON.stringify(l ? [l.onsets, l.vowels, l.codas] : null);
    let splits = 0, borrowed = 0;
    for (const c of w.civs) {
      const p = c && c.parentId != null ? w.civs[c.parentId] : null;
      if (!p || (c.race ?? null) === (p.race ?? null)) continue;
      splits++;
      if (sig(c.language) === sig(p.language)) borrowed++;
    }
    out.otherRaceSplits = splits;
    out.borrowedTongue = borrowed;
    const rep = myth.system.report(w);
    out.reportChecks = rep.checks;
    out.mana = rep.lines.find((l) => l.startsWith('Ley:')) || '';
    out.mixAt = mixAt;
    out.vanished = vanished;
    // human peoples in the chronicle: learning from others, temperament shifts, own entries
    const human = (e) => e.civId != null && w.civs[e.civId]?.race === 'human';
    const pickOf = (pred, n) => w.chronicle.entries.filter((e) => e.day > 0 && pred(e)).slice(-n).map((e) => `Y${Math.floor(e.day / DAYS_PER_YEAR)} ${e.text}`);
    out.humanTales = [
      ...pickOf((e) => e.key === 'tech.diffused' && human(e), 2),
      ...pickOf((e) => e.key && e.key.startsWith('temper.') && human(e), 2),
      ...pickOf((e) => e.key && e.key.startsWith('myth.human') && e.imp >= 2, 2),
    ];
    // a few realm names and ruler titles of the other races (their styles come from identity.js)
    out.styled = w.civs.filter((c) => c && c.alive && c.race && c.race !== 'human').slice(0, 4).map((c) => `${c.name}${c.ruler ? ` (${c.ruler.title || '—'} ${c.ruler.name})` : ''}`);
  }
  console.log('@@' + JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// Parent

const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, args, { maxBuffer: 64 * 1024 * 1024, cwd: fileURLToPath(ROOT) }, (err, stdout, stderr) => {
    const line = String(stdout).split('\n').find((l) => l.startsWith('@@'));
    resolve({ ok: !err, json: line ? JSON.parse(line.slice(2)) : null, out: String(stdout), err: String(stderr) });
  });
});

async function pool(tasks) {
  const res = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
    while (next < tasks.length) { const k = next++; res[k] = await tasks[k](); }
  }));
  return res;
}

const t0 = Date.now();
const checks = [];
const say = (s) => console.log(s);
say(`Myth check: ${seeds.length} seeds × ${years} years (${size}), ${jobs} jobs${sets.length ? ', ' + sets.join(' ') : ''}`);

// 1. determinism (Historical, with and without the myth module)
if (!flag('skip-determinism')) {
  const det = await Promise.all(seeds.slice(0, 2).map((s) => run([fileURLToPath(new URL('tools/headless.mjs', ROOT)), '--determinism', '--years', String(Math.min(200, years)), '--seed', s, '--size', size])));
  det.forEach((d, k) => {
    const ok = d.ok && /ok serializeWorld minus sys\.myth identical/.test(d.out);
    checks.push([ok, `Historical world identical with and without the myth module (seed ${seeds[k]}, ${Math.min(200, years)} years)`]);
    if (!ok) say(d.out.split('\n').slice(-6).join('\n'));
  });
}

// 2–4. paired runs
const histFile = opt('hist-json', null);
const histRuns = histFile ? JSON.parse(readFileSync(histFile, 'utf8')).filter((r) => r && r.level === 0 && r.years === years && seeds.includes(r.seed)) : [];
if (histFile) say(`(Historical runs reused from ${histFile}: ${histRuns.map((r) => r.seed).join(', ') || 'none matched'})`);
const tasks = [];
for (const s of seeds) for (const level of [2, 0]) {
  if (level === 0 && histRuns.some((r) => r.seed === s)) continue;
  tasks.push(() => run([SELF, '--child', '--seed', s, '--level', String(level), '--years', String(years), '--size', size, ...sets.flatMap((x) => ['--set', x])]));
}
const results = await pool(tasks);
const L2 = [], L0 = [...histRuns];
results.forEach((r, k) => {
  if (!r.json) { say(`!! run ${k} failed: ${r.err.split('\n').slice(0, 3).join(' | ')}`); return; }
  (r.json.level >= 2 ? L2 : L0).push(r.json);
});
if (opt('save-json', null)) writeFileSync(opt('save-json', null), JSON.stringify([...L2, ...L0]));
L2.sort((a, b) => seeds.indexOf(a.seed) - seeds.indexOf(b.seed));
L0.sort((a, b) => seeds.indexOf(a.seed) - seeds.indexOf(b.seed));

say('\nPer seed (mythLevel 2): realms/towns per race · Bronze/Iron year (Historical in brackets) · myth ms/yr');
const RACES = ['human', 'elf', 'dwarf', 'orc', 'halfling', 'lizardfolk'];
for (const r of L2) {
  const h = L0.find((x) => x.seed === r.seed);
  const cens = RACES.map((k) => `${k.slice(0, 5)} ${r.census[k].civs}/${r.census[k].towns}`).join('  ');
  say(`  ${r.seed.padEnd(16)} ${cens}  · B ${r.first[1] ?? '—'} (${h?.first[1] ?? '—'}) I ${r.first[2] ?? '—'} (${h?.first[2] ?? '—'}) · ${r.mythMs.toFixed(2)} ms${r.errors.length ? ' · errors: ' + r.errors.join(',') : ''}`);
}

// survival
const enabled = L2[0]?.enabled || RACES;
say('\nRaces alive at the end (people / own realm), across seeds:');
const peopled = L2.filter((r) => Object.values(r.census).some((c) => c.towns > 0));
if (peopled.length < L2.length) say(`  (${L2.length - peopled.length} world(s) lost every people, whatever their race: ${L2.filter((r) => !peopled.includes(r)).map((r) => r.seed).join(', ')}; left out of the race shares)`);
for (const race of enabled) {
  const alive = peopled.filter((r) => r.census[race]?.towns > 0).length;
  const realm = peopled.filter((r) => r.census[race]?.civs > 0).length;
  const share = peopled.length ? alive / peopled.length : 0;
  say(`  ${race.padEnd(11)} ${alive}/${peopled.length} alive · ${realm}/${peopled.length} with a realm of their own`);
  checks.push([share >= 0.6, `${race} alive at Y${years} in ${(100 * share).toFixed(0)}% of seeds (≥ 60%)`]);
}

// pacing
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
for (const [era, label] of [[1, 'Bronze'], [2, 'Iron']]) {
  const a = L2.map((r) => r.first[era]).filter(Number.isFinite), b = L0.map((r) => r.first[era]).filter(Number.isFinite);
  if (a.length < Math.ceil(L2.length / 2) || b.length < Math.ceil(L0.length / 2)) { say(`  (${label} Age reached in too few runs to compare: Mythic ${a.length}, Historical ${b.length})`); continue; }
  const d = mean(a) / mean(b) - 1;
  checks.push([Math.abs(d) <= 0.25, `${label} Age pacing: Mythic Y${mean(a).toFixed(0)} vs Historical Y${mean(b).toFixed(0)} (${(100 * d).toFixed(0)}%, within ±25%)`]);
}

// cost: the budget is for an idle machine (SPEC §2, total ≤ 150 ms/yr). On a loaded machine
// every system slows alike, so the myth's share of the whole sim, applied to 150 ms, is the fair
// estimate; it is used only when the Historical runs show the machine is far from idle.
const myMs = mean(L2.map((r) => r.mythMs));
const whole = mean(L2.map((r) => r.msPerYear)), hist = mean(L0.map((r) => r.msPerYear));
const loaded = hist > 220;
const est = whole > 0 ? (myMs / whole) * 150 : myMs;
checks.push([loaded ? est <= 8 : myMs <= 8, `myth ${myMs.toFixed(2)} ms per sim-year at mythLevel 2 (≤ 8)${loaded ? `; the machine is loaded (Historical ${hist.toFixed(0)} ms/yr), so its share ${(100 * myMs / whole).toFixed(1)}% of the sim is about ${est.toFixed(1)} ms of a 150 ms year` : `; whole sim ${whole.toFixed(0)} ms/yr vs Historical ${hist.toFixed(0)}`}`]);
checks.push([L2.every((r) => !r.errors.length) && L0.every((r) => !r.errors.length), 'no system errors']);
checks.push([L2.every((r) => (r.reportChecks || []).every((c) => c.ok)), 'every Mythic world passes the myth report checks']);
{
  const sp = L2.reduce((a, r) => a + (r.otherRaceSplits || 0), 0), bo = L2.reduce((a, r) => a + (r.borrowedTongue || 0), 0);
  // a free company or pirate realm keeps its founders' tongue: a few borrowed tongues are expected
  checks.push([sp === 0 || bo / sp <= 0.15, `splinter realms of another people speak their own tongue: ${sp - bo} of ${sp} (borrowed ≤ 15%)`]);
}
// contracts §16/§18: 3–15 major (imp ≥ 3) Myth & Magic entries per century
if (years >= 500) { const mj = mean(L2.map((r) => r.mythMajorPerCentury)); checks.push([mj >= 3 && mj <= 15, `major Myth & Magic entries ${mj.toFixed(1)} per century (3–15)`]); }

// 5. mixed peoples
{
  const at = (r, y) => r.mixAt?.[y] || null;
  const yEnd = years;
  const bad = L2.reduce((a, r) => a + [300, 600, yEnd].reduce((b, y) => b + (at(r, y)?.bad || 0) + (at(r, y) ? at(r, y).towns - at(r, y).bad - at(r, y).domOk : 0), 0), 0);
  checks.push([L2.length > 0 && L2.every((r) => at(r, yEnd)) && bad === 0, `every live town holds a valid mix of peoples with its race dominant (Y300, Y600, Y${yEnd}): ${bad} bad`]);
  if (years >= 600) {
    const sh = L2.map((r) => (at(r, 600)?.towns ? at(r, 600).mixed / at(r, 600).towns : 0));
    checks.push([mean(sh) >= 0.25, `by Y600 ${(100 * mean(sh)).toFixed(0)}% of towns hold a minority ≥ 10% (mean over seeds; ${sh.map((v) => (100 * v).toFixed(0) + '%').join(', ')}; ≥ 25%)`]);
    const three = L2.map((r) => at(r, 600)?.three || 0);
    checks.push([three.every((n) => n >= 1), `by Y600 every world has a city with three peoples ≥ 10% (${three.join(', ')})`]);
  }
  const lost = L2.flatMap((r) => (r.vanished || []).map((v) => ({ ...v, seed: r.seed })));
  const byMix = lost.filter((v) => v.how === 'mixing');
  checks.push([byMix.length === 0, `no race left the world purely through mixing (${lost.length} vanished in all, ${byMix.length} through mixing${byMix.length ? ': ' + byMix.map((v) => `${v.race} Y${v.year} ${v.seed}`).join(', ') : ''})`]);
  say('\nMixed peoples: towns with a minority ≥ 10% · cities (towns) with three peoples ≥ 10% · per century: turnings (chronicled), expulsions');
  for (const r of L2) {
    const parts = [300, 600, yEnd].filter((y, k, a) => a.indexOf(y) === k && at(r, y)).map((y) => {
      const m = at(r, y);
      return `Y${y} ${(100 * m.mixed / Math.max(1, m.towns)).toFixed(0)}% of ${m.towns} · ${m.three} (${m.threeAny})`;
    });
    const c = at(r, yEnd)?.counts || {};
    say(`  ${r.seed.padEnd(16)} ${parts.join(' | ')} · ${(100 * (c.turned || 0) / years).toFixed(1)} (${(100 * (c.told || 0) / years).toFixed(1)}) turnings, ${(100 * (c.expelled || 0) / years).toFixed(1)} expulsions`);
    const ex = (at(r, 600)?.examples || []).concat(at(r, yEnd)?.examples || []).slice(0, 2);
    for (const e of ex) say(`      e.g. ${e.name} (tier ${e.tier}): ${e.mix}`);
    if (at(r, yEnd)) say(`      world at Y${yEnd}: ${at(r, yEnd).world.map(([k, p, n]) => `${k} ${p}% (${n} towns)`).join(' · ')}`);
  }
}

// 6. the human peoples (docs/design/temperament-and-names.md §2): their share of the world, and how
// their ingenious (learning from others) and cosmopolitan bonuses play out
{
  const share = (r) => {
    const tot = Object.values(r.census).reduce((a, c) => a + c.pop, 0);
    return tot > 0 ? r.census.human.pop / tot : 0;
  };
  const sh = L2.filter((r) => r.census?.human).map(share);
  const mixDefault = !sets.some((s) => s.startsWith('raceMix='));
  if (sh.length && mixDefault) checks.push([mean(sh) <= 0.45, `humans hold ${(100 * mean(sh)).toFixed(0)}% of the world's people at Y${years} (mean; ${sh.map((v) => (100 * v).toFixed(0) + '%').join(', ')}; ≤ 45% at the default raceMix)`]);
  say('\nHumans: share of the world · realms · learned from others (historical techs: diffusion / all) vs the other races');
  for (const r of L2) {
    const lb = r.learnBy || {};
    const dif = (k) => { const e = lb[k]; return e && e.research + e.diffusion ? e.diffusion / (e.research + e.diffusion) : NaN; };
    const others = Object.keys(lb).filter((k) => k !== 'human');
    const od = others.reduce((a, k) => a + lb[k].diffusion, 0), ot = others.reduce((a, k) => a + lb[k].diffusion + lb[k].research, 0);
    const eg = r.edge ? ` · bonus means over ${r.edge.civYears} realm-years: learning +${(100 * r.edge.learn).toFixed(1)}% research (on in ${(100 * r.edge.learnOn).toFixed(0)}%, max +${(100 * r.edge.max.learn).toFixed(0)}%), cosmopolitan +${(100 * r.edge.cosmo).toFixed(1)}% (max +${(100 * r.edge.max.cosmo).toFixed(1)}%, other peoples ${(100 * r.edge.others).toFixed(0)}% of their towns)` : '';
    say(`  ${r.seed.padEnd(16)} ${(100 * share(r)).toFixed(0)}% · ${r.census.human.civs} realms · diffusion ${Number.isFinite(dif('human')) ? (100 * dif('human')).toFixed(0) + '%' : '—'} vs ${ot ? (100 * od / ot).toFixed(0) + '%' : '—'}${eg}`);
  }
  const H0 = L0.map((r) => r.learnBy?.historical).filter(Boolean);
  if (H0.length) say(`  Historical worlds: diffusion ${(100 * H0.reduce((a, e) => a + e.diffusion, 0) / Math.max(1, H0.reduce((a, e) => a + e.diffusion + e.research, 0))).toFixed(0)}% of discoveries`);
  // temperament: drift from birth (largest trait move, mean per realm) and spread between realms
  const races = RACES.filter((k) => L2.some((r) => r.byRace?.[k]));
  const agg = (k, f) => mean(L2.map((r) => r.byRace?.[k]?.[f]).filter(Number.isFinite));
  say('  At the end, by race: largest temperament drift from birth (mean) · spread between realms (mean trait sd) · mean era · historical techs per realm');
  say('    ' + races.map((k) => `${k} ${Number.isFinite(agg(k, 'drift')) ? agg(k, 'drift').toFixed(2) : '—'} · ${Number.isFinite(agg(k, 'spread')) ? agg(k, 'spread').toFixed(3) : '—'} · ${agg(k, 'era').toFixed(1)} · ${Number.isFinite(agg(k, 'techs')) ? agg(k, 'techs').toFixed(1) : '—'}`).join('  |  '));
  const leads = {};
  for (const r of L2) for (const [e, race] of Object.entries(r.eraFirst || {})) if (+e >= 1 && +e <= 4) (leads[race] ||= []).push(+e);
  say('  First into the Bronze, Iron, Classical and Medieval ages (all seeds): ' + (Object.keys(leads).length ? Object.entries(leads).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => `${k} ${v.length}`).join(', ') : '—'));
  for (const r of L2.slice(0, 3)) for (const t of r.humanTales || []) say(`    ${r.seed}: ${t}`);
  for (const r of L2.slice(0, 2)) if (r.styled?.length) say(`    ${r.seed} realms: ${r.styled.join(' · ')}`);
}

// informational
const niche = {};
for (const r of L2) for (const [k, v] of Object.entries(r.niche || {})) (niche[k] ||= []).push(v);
say('\nNiche shares at genesis (target 5–30 %): ' + Object.entries(niche).map(([k, v]) => `${k} ${(100 * Math.min(...v)).toFixed(0)}–${(100 * Math.max(...v)).toFixed(0)}%`).join(', '));
say(`Notable myth entries per century: ${mean(L2.map((r) => r.mythNotablePerCentury)).toFixed(1)} of WP5's own, ${mean(L2.map((r) => r.mythAllPerCentury)).toFixed(1)} with the beasts, ${mean(L2.map((r) => r.mythMajorPerCentury)).toFixed(1)} major (imp ≥ 3; target 3–15) · miracles per century ${(100 * mean(L2.map((r) => r.divine)) / years).toFixed(1)} · folklore per century ${(100 * mean(L2.map((r) => r.folk)) / years).toFixed(1)} · weave at the end ${mean(L2.map((r) => r.weave)).toFixed(2)}`);
for (const r of L2.slice(0, 3)) say(`  ${r.seed}: ${r.mana}`);

say('\nChecks:');
for (const [ok, label] of checks) say(`  ${ok ? 'ok' : '!!'} ${label}`);
say(`\n(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(checks.every(([ok]) => ok) ? 0 : 1);
