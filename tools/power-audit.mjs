#!/usr/bin/env node
// The powers' audit: what each power of the hand does to a world, at light, middling and full
// strength. A world is grown to a year and kept; each power is then tried on a fresh copy of it, at
// a standard spot (the largest town, the sea off the largest coastal town, the largest realm, two
// realms that know each other), and the place is measured just before, right after, and when the
// power's work is done (the hand's own end: its timed effect, else 1 year for the sky, 2 for
// catastrophes, 5 for the rest). An untouched copy run to the same days is the measure of what would
// have been, so a power's mark is the place against itself, not against the world.
//
//   node tools/power-audit.mjs --seed deck --year 150 [--size small] [--myth 0] [--only quake,rain]
//                              [--out audit.jsonl]
//   node tools/power-audit.mjs --report a.jsonl b.jsonl …   (a table per power from the trials)
//
// A trial line: { seed, year, myth, tool, grp, band ('light' | 'middling' | 'full' | 'held' | '-'),
// str, where, ok, msg, est (the preview's deaths estimate), years (to its end), place (what was
// measured), m0, m1, end, ctl } where m* = { pop, towns, food, pot, wealth, unrest, health, happy,
// veg, herb, fish, soil, rain, dev, land, realm: {…}, pair: {…} }.

import { createWorld, yearOf } from '../src/core/world.js';
import { Simulation } from '../src/core/sim.js';
import { loadSystems } from '../src/systems.js';
import { WATER, DAYS_PER_YEAR as DPY } from '../src/core/constants.js';
import { serializeWorld, deserializeWorld } from '../src/core/serialize.js';
import { availableTools, applyTool, applyPairTool, applyEntityTool, finishTool, previewTool } from '../src/core/tools.js';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, def) => { const k = argv.indexOf('--' + name); return k >= 0 ? argv[k + 1] : def; };
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const SPAN = { weather: 1, catastrophe: 2, life: 5, peoples: 5, fate: 5, myth: 5, terrain: 5 };
// not powers with a mark to measure: gestures, names, acts on a single beast or army, fate's menu
const SKIP = new Set(['rename', 'command_army', 'steer_storm', 'slay_beast', 'tame_beast', 'fate']);   // (fate: a menu of the town's own events)
const HELD = 12;   // a continuous power held for about a second (the map re-applies every ~80 ms)

if (argv[0] === '--report') { report(argv.slice(1)); process.exit(0); }

const seed = opt('seed', 'deck'), year = Number(opt('year', 150)), size = opt('size', 'small'), myth = Number(opt('myth', 0));
const only = opt('only', '') ? new Set(opt('only', '').split(',')) : null;
const out = opt('out', `power-audit-${seed}-${year}.jsonl`);

const { generateWorld } = await import('../src/gen/worldgen.js');
const systems = await loadSystems({});
const newSim = (w) => { const s = new Simulation(w, systems); s.init(); return s; };
const t0 = Date.now();
const base = createWorld({ seed, worldSize: size, mythLevel: myth });
generateWorld(base);
const simB = newSim(base);
while (yearOf(base) < year) simB.step();
const snap = JSON.stringify(serializeWorld(base));
const fresh = () => { const w = deserializeWorld(JSON.parse(snap)); return { w, sim: newSim(w) }; };
console.log(`${seed} Y${year} ${size} myth ${myth}: grown in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// ---------------------------------------------------------------------------
// Measures

const potOf = (s) => (s.flags && Array.isArray(s.flags.pot) ? fin(s.flags.pot[2]) : 0);
function townsM(w, ids) {
  const m = { pop: 0, towns: 0, food: 0, pot: 0, wealth: 0, unrest: 0, health: 0, happy: 0, tp: [] };
  for (const id of ids) {
    const s = w.settlements[id];
    m.tp.push(s && s.alive ? Math.round(fin(s.population)) : 0);
    if (!s || !s.alive) continue;
    const p = Math.max(0, fin(s.population));
    m.pop += p; m.towns++; m.food += Math.max(0, fin(s.food)); m.pot += potOf(s); m.wealth += fin(s.wealth);
    m.unrest += p * fin(s.unrest); m.health += p * fin(s.health); m.happy += p * fin(s.happiness);
  }
  for (const k of ['unrest', 'health', 'happy']) m[k] = m.pop > 0 ? m[k] / m.pop : 0;
  return m;
}
function discM(w, x, y, R) {
  const f = w.f, m = { veg: 0, herb: 0, fish: 0, soil: 0, rain: 0, dev: 0, land: 0, elev: 0 };
  let nl = 0, nw = 0;
  const r = Math.max(1, Math.min(R, 14));
  for (let ty = Math.max(0, Math.floor(y - r)); ty <= Math.min(w.H - 1, Math.ceil(y + r)); ty++) {
    for (let tx = Math.max(0, Math.floor(x - r)); tx <= Math.min(w.W - 1, Math.ceil(x + r)); tx++) {
      if ((tx - x) ** 2 + (ty - y) ** 2 > (r + 0.5) ** 2) continue;
      const i = ty * w.W + tx;
      m.elev += f.elevation[i];
      if (f.water[i] === WATER.LAND) { nl++; m.veg += f.veg[i]; m.herb += f.herb[i]; m.soil += f.soilWater[i]; m.rain += f.annRain[i]; m.dev += f.devastation[i]; }
      else { nw++; m.fish += f.fish[i]; }
    }
  }
  for (const k of ['veg', 'herb', 'soil', 'rain', 'dev']) m[k] = nl ? m[k] / nl : 0;
  m.fish = nw ? m.fish / nw : 0;
  m.elev /= Math.max(1, nl + nw);
  m.land = nl / Math.max(1, nl + nw);
  return m;
}
function realmM(w, id) {
  const c = w.civs[id];
  if (!c || !c.alive) return { alive: 0, pop: 0, towns: 0, treasury: 0, stability: 0, legitimacy: 0, techs: 0, wars: 0, ruler: -1 };
  let wars = 0;
  for (const q of w.wars) if (q && q.active && (q.attackers.includes(id) || q.defenders.includes(id))) wars++;
  return { alive: 1, pop: fin(c.population), towns: c.settlementIds.length, treasury: fin(c.treasury), stability: fin(c.stability), legitimacy: fin(c.legitimacy),
    techs: Object.keys(c.tech?.known || {}).length, wars, ruler: c.ruler ? fin(c.ruler.id, -1) : -1 };
}
function pairM(w, a, b) {
  const ca = w.civs[a], cb = w.civs[b];
  const rel = ca && ca.relations ? ca.relations[b] : null;
  let war = 0;
  for (const q of w.wars) if (q && q.active && ((q.attackers.includes(a) && q.defenders.includes(b)) || (q.attackers.includes(b) && q.defenders.includes(a)))) war = 1;
  return { opinion: fin(rel && rel.opinion), war, allied: ca && (ca.allies || []).includes(b) ? 1 : 0, alive: (ca && ca.alive ? 1 : 0) + (cb && cb.alive ? 1 : 0) };
}
/** What a place is: { towns: [ids], x, y, R, realm, pair } → its measure now. */
function measure(w, pl) {
  const m = { ...townsM(w, pl.towns), ...(Number.isFinite(pl.x) ? discM(w, pl.x, pl.y, pl.R) : {}) };
  // every town standing within reach now (towns founded or lost there, whoever they are)
  if (Number.isFinite(pl.x)) { const R = Math.max(4, Math.min(pl.R, 30)); m.atowns = 0; m.apop = 0; for (const s of w.settlements) if (s && s.alive && Math.hypot(s.x - pl.x, s.y - pl.y) <= R) { m.atowns++; m.apop += fin(s.population); } }
  if (pl.realm != null) m.realm = realmM(w, pl.realm);
  if (pl.pair) { m.pair = pairM(w, pl.pair[0], pl.pair[1]); m.realmA = realmM(w, pl.pair[0]); m.realmB = realmM(w, pl.pair[1]); }
  return m;
}

// ---------------------------------------------------------------------------
// Standard spots

const W = base.W, H = base.H, f = base.f;
const alive = base.settlements.filter((s) => s && s.alive);
const big = alive.slice().sort((a, b) => b.population - a.population)[0];
const coast = alive.filter((s) => s.coastal).sort((a, b) => b.population - a.population)[0] || big;
const inMap = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const landNear = (x, y, r) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const tx = x + dx, ty = y + dy; if (dx * dx + dy * dy <= r * r && inMap(tx, ty) && f.water[ty * W + tx] === WATER.LAND) return true; } return false; };
function seaTile(s, dmin, dmax, open = false) {
  let best = null;
  for (let dy = -dmax; dy <= dmax; dy++) for (let dx = -dmax; dx <= dmax; dx++) {
    const x = s.x + dx, y = s.y + dy, d = Math.hypot(dx, dy);
    if (!inMap(x, y) || d < dmin || d > dmax || f.water[y * W + x] !== WATER.OCEAN) continue;
    if (open && landNear(x, y, 8)) continue;
    if (!best || d < best.d) best = { x, y, d };
  }
  return best;
}
const seaNear = seaTile(coast, 3, 5);
const seaFar = seaTile(coast, 9, 14, true);
function emptyLand(s, dmin) {
  let best = null;
  for (let dy = -16; dy <= 16; dy++) for (let dx = -16; dx <= 16; dx++) {
    const x = s.x + dx, y = s.y + dy, d = Math.hypot(dx, dy), i = y * W + x;
    if (!inMap(x, y) || d < dmin || f.water[i] !== WATER.LAND || f.owner[i] >= 0 || f.settle[i] >= 0 || f.veg[i] < 0.2) continue;
    if (!best || d < best.d) best = { x, y, d };
  }
  return best;
}
const wild = emptyLand(big, 5);
const realms = base.civs.filter((c) => c && c.alive).sort((a, b) => b.population - a.population);
const bigRealm = base.civs[big.civId] && base.civs[big.civId].alive ? base.civs[big.civId] : realms[0];
const atWar = (a, b) => base.wars.some((q) => q && q.active && ((q.attackers.includes(a) && q.defenders.includes(b)) || (q.attackers.includes(b) && q.defenders.includes(a))));
const pairs = [];
for (const a of realms) for (const k in a.relations || {}) { const b = base.civs[k]; if (b && b.alive && b.id !== a.id && a.id < b.id) pairs.push([a, b]); }
pairs.sort((p, q) => (q[0].population + q[1].population) - (p[0].population + p[1].population));
const peacePair = pairs.find(([a, b]) => !atWar(a.id, b.id)) || null;
const warPair = pairs.find(([a, b]) => atWar(a.id, b.id)) || null;
const R0 = (t, o) => Math.max(1, fin(o.radius, fin(t.radius, 0)));

/** The spots a power is tried at: [{ where, x, y } | { where, target } | { where, a, b }]. */
function spotsFor(t) {
  const at = (where, p, more = {}) => (p ? [{ where, x: p.x, y: p.y, ...more }] : []);
  if (t.target === 'pair') {
    const pk = t.pick || ['civ', 'civ'];
    if (pk[0] === 'civ' && pk[1] === 'civ') {
      const pr = t.id === 'broker_peace' ? warPair : peacePair;
      return pr ? [{ where: t.id === 'broker_peace' ? 'two realms at war' : 'two realms that know each other', a: { kind: 'civ', id: pr[0].id }, b: { kind: 'civ', id: pr[1].id }, pair: [pr[0].id, pr[1].id] }] : [];
    }
    if (pk[0] === 'settlement' && pk[1] === 'tile') return wild ? [{ where: 'the largest town to the wilds', a: { kind: 'settlement', id: big.id }, b: { kind: 'tile', x: wild.x, y: wild.y }, towns: [big.id] }] : [];
    if (pk[0] === 'settlement' && pk[1] === 'civ') {
      for (const [a, b] of pairs) { const sid = a.settlementIds.find((id) => id !== a.capitalId); if (sid != null) return [{ where: 'a town to a neighbour', a: { kind: 'settlement', id: sid }, b: { kind: 'civ', id: b.id }, towns: [sid], pair: [a.id, b.id] }]; }
      return [];
    }
    if (pk[0] === 'settlement' && pk[1] === 'settlement') {
      for (const [a, b] of pairs) { const sa = a.capitalId ?? a.settlementIds[0], sb = b.capitalId ?? b.settlementIds[0]; if (sa != null && sb != null) return [{ where: 'two capitals that know each other', a: { kind: 'settlement', id: sa }, b: { kind: 'settlement', id: sb }, towns: [sa, sb], pair: [a.id, b.id] }]; }
      return [];
    }
    return [];
  }
  if (t.target === 'entity') {
    const kinds = (t.entity && t.entity.kinds) || [];
    if (kinds.includes('civ') && bigRealm) return [{ where: 'the largest town’s realm', target: { kind: 'civ', id: bigRealm.id }, realm: bigRealm.id }];
    if (kinds.includes('settlement')) return [{ where: 'the largest town', target: { kind: 'settlement', id: big.id }, towns: [big.id] }];
    return [];
  }
  if (t.target === 'civ') return bigRealm ? [{ where: 'the largest town’s realm', x: big.x, y: big.y, realm: bigRealm.id }] : [];
  if (t.target === 'settlement') return at('the largest town', big, { realm: big.civId });
  if (t.id === 'quake') return [...at('on the largest town', big), ...at('the sea 3–5 tiles off the largest coastal town', seaNear), ...at('open sea 9–14 tiles off it', seaFar)];
  if (t.id === 'tsunami' || t.id === 'fish' || t.id === 'island') return at('the sea 3–5 tiles off the largest coastal town', seaNear);
  if (t.id === 'tribe' || t.id === 'settle' || t.id === 'summon_beast') return at('the wilds near the largest town', wild);
  if (t.id === 'storm') return [...at('on the largest town', big), ...at('the sea 3–5 tiles off the largest coastal town', seaNear)];
  return at('on the largest town', big);
}

/** The strengths a power is tried at: [{ band, str, n }]. */
function strengthsFor(t) {
  if (!t.strength) return [{ band: '-', str: undefined, n: 1 }, ...(t.continuous ? [{ band: 'held', str: undefined, n: HELD }] : [])];
  const lo = fin(t.strength.min, 0), hi = fin(t.strength.max, 1), q = (k) => Math.round((lo + (hi - lo) * k) * 100) / 100;
  const out = [{ band: 'light', str: q(0.15), n: 1 }, { band: 'middling', str: q(0.5), n: 1 }, { band: 'full', str: hi, n: 1 }];
  if (t.continuous) out.push({ band: 'held', str: hi, n: HELD });
  return out;
}

/** The towns a map power reaches at (x, y): its forecast's, else those within its reach. */
function placeOf(w, t, sp, o) {
  if (sp.target || sp.a) return { towns: sp.towns || [], realm: sp.realm ?? null, pair: sp.pair || null, x: sp.b && sp.b.kind === 'tile' ? sp.b.x : undefined, y: sp.b && sp.b.kind === 'tile' ? sp.b.y : undefined, R: 3 };
  let R = R0(t, o), est = null, tg = [];
  const pv = previewTool(w, t.id, sp.x, sp.y, o);
  if (pv) {
    for (const r of pv.rings || []) if (Math.hypot(fin(r.x, sp.x) - sp.x, fin(r.y, sp.y) - sp.y) < 3) R = Math.max(R, fin(r.r));
    tg = (pv.targets || []).filter((q) => q && q.kind === 'settlement').map((q) => q.id);
    if (pv.estimate && Array.isArray(pv.estimate.deaths)) est = pv.estimate.deaths;
    else if (pv.estimate && Number.isFinite(pv.estimate.lo)) est = [pv.estimate.lo, pv.estimate.hi];
  }
  const near = w.settlements.filter((s) => s && s.alive && Math.hypot(s.x - sp.x, s.y - sp.y) <= R + 1).map((s) => s.id);
  const towns = [...new Set([...tg, ...near])].sort((a, b) => a - b);
  return { towns, realm: sp.realm ?? null, pair: null, x: sp.x, y: sp.y, R, est, preview: pv ? String(pv.text || pv.reason || '').slice(0, 140) : '' };
}

// ---------------------------------------------------------------------------
// Trials

const tools = availableTools(base).filter((t) => !SKIP.has(t.id) && (!only || only.has(t.id)));
const trials = [];
writeFileSync(out, '');
for (const t of tools) {
  for (const sp of spotsFor(t)) {
    for (const st of strengthsFor(t)) {
      const { w, sim } = fresh();
      const o = st.str != null ? { strength: st.str } : {};
      const pl = placeOf(w, t, sp, o);
      const m0 = measure(w, pl);
      let res = null;
      if (t.target === 'pair') res = applyPairTool(w, t.id, sp.a, sp.b, {});
      else if (t.target === 'entity') {
        const args = {};
        for (const a of Array.isArray(t.args) ? t.args : []) { try { const op = typeof a.options === 'function' ? a.options(w, sp.target) : []; if (op && op.length) args[a.key] = op[0][0]; } catch (e) { /* no options */ } }
        res = applyEntityTool(w, t.id, sp.target, args);
      } else {
        for (let k = 0; k < st.n; k++) res = applyTool(w, t.id, sp.x, sp.y, o);
        if (t.finish) finishTool(w, t.id);
      }
      const m1 = measure(w, pl);
      const act = w.sys.hand && w.sys.hand.acts.length ? w.sys.hand.acts[w.sys.hand.acts.length - 1] : null;
      const day0 = w.time.day;
      const endDay = act && act.tool === t.id ? act.endDay : day0 + Math.round((SPAN[t.group] || 5) * DPY);
      while (w.time.day < endDay) sim.step();
      const end = measure(w, pl);
      const tr = { seed, year, myth, tool: t.id, label: t.label, grp: t.group, band: st.band, str: st.str ?? null, where: sp.where, ok: Boolean(res && res.ok !== false), msg: String((res && res.message) || '').slice(0, 160),
        est: pl.est || null, preview: pl.preview || '', years: Math.round(((endDay - day0) / DPY) * 10) / 10, place: { towns: pl.towns.length, R: pl.R }, m0, m1, end, endDay, pl };
      trials.push(tr);
      process.stdout.write(`  ${t.id} ${st.band} ${sp.where}: ${tr.ok ? 'ok' : 'refused'} — ${tr.msg.slice(0, 70)}\n`);
    }
  }
}
// the untouched copy: what each place would have been at its end
const { w: wc, sim: simC } = fresh();
for (const tr of trials.slice().sort((a, b) => a.endDay - b.endDay)) {
  while (wc.time.day < tr.endDay) simC.step();
  tr.ctl = measure(wc, tr.pl);
}
for (const tr of trials) { delete tr.pl; appendFileSync(out, JSON.stringify(tr) + '\n'); }
console.log(`${trials.length} trials → ${out} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

// ---------------------------------------------------------------------------
// The report: per power and strength, the median mark over the worlds tried

function report(files) {
  const json = files.includes('--json') ? files[files.indexOf('--json') + 1] : null;
  const rows = files.filter((p, k) => p !== '--json' && files[k - 1] !== '--json').flatMap((p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const rel = (a, b) => (b > 0 ? a / b - 1 : null);
  const med = (xs) => { const s = xs.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
  const pc = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))}%`);
  const dl = (v, k = 2) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(k)}`);
  const worst = (a, b) => { if (!Array.isArray(a) || !Array.isArray(b)) return null; let m = 0; a.forEach((v, k) => { if (v > 50) m = Math.max(m, 1 - fin(b[k]) / v); }); return m; };
  const hits = (a, b) => (Array.isArray(a) && Array.isArray(b) ? a.filter((v, k) => v > 50 && 1 - fin(b[k]) / v >= 0.1).length : null);
  const groups = new Map();
  for (const r of rows) { const k = `${r.tool}|${r.band}|${r.where}`; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
  const out = [];
  for (const [k, all] of groups) {
    const [tool, band, where] = k.split('|');
    const g = all.filter((r) => r.ok);
    const e = (fn) => med(g.map(fn));
    const sub = (r, part, key) => fin(r[part]?.[key]);
    const row = {
      tool, label: all[0].label, grp: all[0].grp, band, where, str: all[0].str, n: all.length, ok: g.length, years: e((r) => r.years),
      refused: [...new Set(all.filter((r) => !r.ok).map((r) => r.msg))].slice(0, 2),
      towns: e((r) => r.place.towns), people: e((r) => r.m0.pop), R: e((r) => r.place.R),
      popNow: e((r) => rel(r.m1.pop, r.m0.pop)), deadNow: e((r) => r.m0.pop - r.m1.pop), est: e((r) => (r.est ? (r.est[0] + r.est[1]) / 2 : null)),
      popEnd: e((r) => rel(r.end.pop, r.ctl.pop)), lost: e((r) => r.ctl.towns - r.end.towns), food: e((r) => rel(r.end.food, r.ctl.food)),
      harvest: e((r) => rel(r.end.pot, r.ctl.pot)), wealth: e((r) => rel(r.end.wealth, r.ctl.wealth)), unrest: e((r) => r.end.unrest - r.ctl.unrest),
      health: e((r) => r.end.health - r.ctl.health), happy: e((r) => r.end.happy - r.ctl.happy),
      // the worst-struck town, and how many lost a tenth or more, at once and at the end against untouched
      worstNow: e((r) => worst(r.m0.tp, r.m1.tp)), worstEnd: e((r) => worst(r.ctl.tp, r.end.tp)), hitNow: e((r) => hits(r.m0.tp, r.m1.tp)), hitEnd: e((r) => hits(r.ctl.tp, r.end.tp)),
      newTowns: e((r) => (Number.isFinite(r.end.atowns) ? r.end.atowns - r.ctl.atowns : null)), areaPop: e((r) => (Number.isFinite(r.end.apop) ? rel(r.end.apop, r.ctl.apop) : null)),
      veg: e((r) => rel(r.end.veg, r.ctl.veg)), herds: e((r) => rel(r.end.herb, r.ctl.herb)), fish: e((r) => rel(r.end.fish, r.ctl.fish)),
      soil: e((r) => (Number.isFinite(r.end.soil) ? r.end.soil - r.ctl.soil : null)), rain: e((r) => rel(r.end.rain, r.ctl.rain)),
      land: e((r) => (Number.isFinite(r.end.land) ? r.end.land - r.ctl.land : null)),
      vegNow: e((r) => rel(r.m1.veg, r.m0.veg)), herdsNow: e((r) => rel(r.m1.herb, r.m0.herb)), fishNow: e((r) => rel(r.m1.fish, r.m0.fish)),
      soilNow: e((r) => (Number.isFinite(r.m1.soil) ? r.m1.soil - r.m0.soil : null)), landNow: e((r) => (Number.isFinite(r.m1.land) ? r.m1.land - r.m0.land : null)), dev: e((r) => (Number.isFinite(r.end.dev) ? r.end.dev - r.ctl.dev : null)),
    };
    if (all[0].m0.realm) Object.assign(row, { stab: e((r) => sub(r.end, 'realm', 'stability') - sub(r.ctl, 'realm', 'stability')), legit: e((r) => sub(r.end, 'realm', 'legitimacy') - sub(r.ctl, 'realm', 'legitimacy')),
      techs: e((r) => sub(r.end, 'realm', 'techs') - sub(r.ctl, 'realm', 'techs')), treasury: e((r) => rel(sub(r.end, 'realm', 'treasury'), sub(r.ctl, 'realm', 'treasury'))),
      rpop: e((r) => rel(sub(r.end, 'realm', 'pop'), sub(r.ctl, 'realm', 'pop'))), rtowns: e((r) => sub(r.end, 'realm', 'towns') - sub(r.ctl, 'realm', 'towns')),
      ruler: g.length ? g.filter((r) => sub(r.end, 'realm', 'ruler') !== sub(r.ctl, 'realm', 'ruler')).length / g.length : null,
      rulerNow: g.length ? g.filter((r) => sub(r.m1, 'realm', 'ruler') !== sub(r.m0, 'realm', 'ruler')).length / g.length : null,
      wars: e((r) => sub(r.end, 'realm', 'wars') - sub(r.ctl, 'realm', 'wars')) });
    if (all[0].m0.pair) Object.assign(row, { opinion: e((r) => sub(r.end, 'pair', 'opinion') - sub(r.ctl, 'pair', 'opinion')), war: e((r) => sub(r.end, 'pair', 'war') - sub(r.ctl, 'pair', 'war')),
      allied: e((r) => sub(r.end, 'pair', 'allied') - sub(r.ctl, 'pair', 'allied')), opNow: e((r) => sub(r.m1, 'pair', 'opinion') - sub(r.m0, 'pair', 'opinion')) });
    out.push(row);
  }
  if (json) writeFileSync(json, JSON.stringify(out, null, 1));
  for (const r of out) {
    const bits = [`towns ${r.towns ?? '—'} (${Math.round(r.people ?? 0)} people, R ${r.R?.toFixed?.(1) ?? '—'})`, `now ${pc(r.popNow)}`, `end ${pc(r.popEnd)}`, `worst ${pc(r.worstNow == null ? null : -r.worstNow)}/${pc(r.worstEnd == null ? null : -r.worstEnd)}`, `hit ${r.hitNow ?? '—'}/${r.hitEnd ?? '—'}`, `lost ${r.lost ?? '—'}`, `new ${r.newTowns ?? '—'}`, `food ${pc(r.food)}`, `harv ${pc(r.harvest)}`, `wealth ${pc(r.wealth)}`, `unrest ${dl(r.unrest)} health ${dl(r.health)}`];
    if (r.est != null) bits.push(`est ${Math.round(r.est)} vs ${Math.round(r.deadNow ?? 0)}`);
    bits.push(`now: veg ${pc(r.vegNow)} herds ${pc(r.herdsNow)} fish ${pc(r.fishNow)} soil ${dl(r.soilNow)} land ${dl(r.landNow)}`, `end: veg ${pc(r.veg)} herds ${pc(r.herds)} fish ${pc(r.fish)} soil ${dl(r.soil)} land ${dl(r.land)}`);
    if (r.stab !== undefined) bits.push(`realm pop ${pc(r.rpop)} towns ${r.rtowns ?? '—'} stab ${dl(r.stab)} legit ${dl(r.legit)} techs ${r.techs ?? '—'} treas ${pc(r.treasury)} ruler ${r.ruler == null ? '—' : Math.round(r.ruler * 100) + '%'} wars ${r.wars ?? '—'}`);
    if (r.opinion !== undefined) bits.push(`opinion ${r.opinion?.toFixed(0) ?? '—'} (now ${r.opNow?.toFixed(0) ?? '—'}) war ${r.war ?? '—'} allied ${r.allied ?? '—'}`);
    console.log(`${r.tool} ${r.band} [${r.where}] ${r.ok}/${r.n} ${r.years}y: ${bits.join(' · ')}${r.refused.length ? ` · refused: ${r.refused.join(' / ')}` : ''}`);
  }
}
