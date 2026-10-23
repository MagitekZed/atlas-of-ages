// The civ system's headless report (system.report → { title, lines, checks }): the state of
// peoples, rulers and houses at the end of a run, and the package's acceptance checks —
// strength recorded for realms in the field, no general older than ninety, ruler history
// with deeds, the dynasty ledger within its cap, every realm with an architecture, wonder
// geometry recorded, era firsts consistent.

import { DAYS_PER_YEAR as DPY, ERAS, RACE_META } from '../../core/constants.js';
import { liveCivs } from '../../core/entities.js';
import { fin, civCache, DYNASTY_CAP } from './state.js';
import { figureAge } from './culture.js';
import { styleWords } from './style.js';
import { TEMPER_TRAITS, temperWords } from './temper.js';

export function civReport(world) {
  const st = world.sys.civ;
  if (!st) return { title: 'Peoples, rulers and cities', lines: ['no peoples in this world'], checks: [] };
  const lines = [], checks = [];
  const civs = liveCivs(world);
  const c = st.counters || {};
  const day = world.time.day;
  // realms and rulers
  const rulers = civs.filter((v) => v.ruler);
  const reign = rulers.map((v) => (day - fin(v.ruler.reignStart, day)) / DPY).sort((a, b) => a - b);
  const longest = rulers.reduce((best, v) => (!best || v.ruler.reignStart < best.ruler.reignStart ? v : best), null);
  lines.push(`realms ${civs.length} · rulers ${rulers.length} · median reign so far ${reign.length ? reign[reign.length >> 1].toFixed(1) : '—'} y${longest ? ` · longest ${longest.ruler.display || longest.ruler.name} (${Math.round((day - longest.ruler.reignStart) / DPY)} y)` : ''}`);
  const hist = civs.reduce((a, v) => a + (v.rulerHistory?.length || 0), 0);
  lines.push(`ruler records ${hist} · houses ended ${st.dynasties?.length || 0} · regencies ${fin(c.regencies)} · marriages ${fin(c.marriages)} · personal unions ${fin(c.personalUnions)} · restorations ${fin(c.restorations)} · exiled courts ${(st.exiles || []).filter((e) => !e.used).length}`);
  lines.push(`rebellions ${fin(c.rebellions)} · crushed ${fin(c.suppressed)} · civil wars ${fin(c.civilWars)} · collapses ${fin(c.collapses)} · revolutions ${fin(c.revolutions)} · unions ${fin(c.unions)} · colonies ${fin(c.colonies)} · new peoples ${fin(c.emerged)} · divine acts ${fin(c.divine)}`);
  const govs = {};
  for (const v of civs) govs[v.government] = (govs[v.government] || 0) + 1;
  lines.push('governments: ' + Object.entries(govs).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · '));
  // eras
  const ef = st.eraFirst || {};
  const firsts = Object.keys(ef).map(Number).sort((a, b) => a - b).map((e) => `${ERAS[e]?.name || e} Y${Math.floor(ef[e].day / DPY)} (${world.civs[ef[e].civId]?.adjective || '?'})`);
  if (firsts.length) lines.push('first into each era: ' + firsts.join(' · '));
  // figures
  let living = 0, generals = 0, oldestGeneral = 0, oldName = null;
  for (const fg of world.figures) {
    if (fg.died != null) continue;
    living++;
    if (fg.kind !== 'general') continue;
    generals++;
    const a = figureAge(world, world.civs[fg.civId], fg);
    if (a > oldestGeneral) { oldestGeneral = a; oldName = fg.name; }
  }
  lines.push(`figures ${world.figures.length} (living ${living}, generals ${generals}, oldest general ${generals ? `${oldName} ${oldestGeneral.toFixed(0)}` : '—'})`);
  // peoples and styles
  const races = {};
  for (const v of civs) if (v.race) races[v.race] = (races[v.race] || 0) + 1;
  if (Object.keys(races).length) lines.push('peoples: ' + Object.entries(races).map(([r, n]) => `${RACE_META[r]?.plural || r} ${n}`).join(' · '));
  const roofs = {};
  for (const v of civs) if (v.style) roofs[v.style.roof] = (roofs[v.style.roof] || 0) + 1;
  lines.push('architecture: ' + Object.entries(roofs).map(([k, n]) => `${k} ${n}`).join(' · ') + (civs[0]?.style ? ` (e.g. ${civs[0].adjective}: ${styleWords(civs[0].style)})` : ''));
  // temperament drift (temper.js)
  let moved = 0, bounds = 0, told = 0, logged = 0, outside = 0, noBirth = 0;
  const far = [];
  for (const v of civs) {
    const t0 = v.flags?.temper0;
    if (!t0) { noBirth++; continue; }
    let best = 0, key = null, signed = 0;
    for (const k of TEMPER_TRAITS) {
      const x = fin(v.traits?.[k], 0.5), d = Math.abs(x - fin(t0[k], x));
      if (d > best) { best = d; key = k; signed = x - fin(t0[k], x); }
      if (x <= 0.0501 || x >= 0.9499) bounds++;
      if (!(x >= 0.05 - 1e-9 && x <= 0.95 + 1e-9)) outside++;
    }
    if (best >= 0.15) moved++;
    far.push([best, v, key, signed]);
  }
  for (const v of world.civs) for (const e of v?.temperLog || []) { logged++; if (e.seq != null) told++; }
  far.sort((a, b) => b[0] - a[0]);
  lines.push(`temperament: ${moved}/${civs.length} realms ≥ 0.15 from their birth temperament · traits at a bound ${bounds} of ${civs.length * TEMPER_TRAITS.length} · shifts logged ${logged}, told ${told}`
    + (far[0] ? ` · furthest ${far[0][1].adjective} (${far[0][2]} ${far[0][3] >= 0 ? '+' : '−'}${Math.abs(far[0][3]).toFixed(2)}; now ${temperWords(far[0][1], 2).join(' · ') || 'middling'})` : ''));
  const wonders = world.wonders.filter((w) => w.destroyedDay == null);
  lines.push(`wonders standing ${wonders.length} of ${world.wonders.length}` + (wonders.length ? ': ' + wonders.slice(0, 6).map((w) => w.name).join('; ') : ''));

  // checks
  const armyStr = civCache(world).armyStr;
  if (armyStr) {
    const missing = civs.filter((v) => (armyStr.get(v.id) || 0) > 0 && !(fin(v.military?.strength) > 0));
    checks.push({ ok: missing.length === 0, label: `military strength recorded for every realm with armies (${missing.length ? missing.map((v) => v.adjective).join(', ') + ' missing' : 'all'})` });
  }
  checks.push({ ok: oldestGeneral <= 90.01, label: `no general alive past age 90 (oldest ${oldestGeneral.toFixed(1)})` });
  const rows = civs.flatMap((v) => v.rulerHistory || []).filter((r) => r.cause !== 'fall');
  const noDeeds = rows.filter((r) => !r.deeds || typeof r.deeds !== 'object').length;
  checks.push({ ok: noDeeds === 0, label: `ruler history rows carry deeds (${rows.length - noDeeds}/${rows.length})` });
  checks.push({ ok: (st.dynasties?.length || 0) <= DYNASTY_CAP, label: `dynasty ledger within ${DYNASTY_CAP} (${st.dynasties?.length || 0})` });
  const unstyled = world.civs.filter((v) => v && !v.style).length;
  checks.push({ ok: unstyled === 0, label: `every realm has an architecture (${unstyled} without)` });
  const geo = world.wonders.filter((w) => (w.kind === 'great_wall' || w.kind === 'grand_canal') ? !(Array.isArray(w.path) && w.path.length >= 2) : w.kind === 'great_dam' ? !Number.isInteger(w.i) : false);
  checks.push({ ok: geo.length === 0, label: `wonder geometry recorded (${geo.length ? geo.map((w) => w.kind).join(', ') + ' missing' : 'ok'})` });
  checks.push({ ok: outside === 0 && noBirth === 0, label: `temperaments within [0.05, 0.95] with a birth baseline (${outside} outside, ${noBirth} without temper0)` });
  const efOk = Object.keys(ef).every((e) => fin(st.eraReached?.[e]) >= 1);
  checks.push({ ok: efOk, label: 'era firsts agree with era counts' });
  return { title: 'Peoples, rulers and cities (WP3)', lines, checks };
}
