// Digest: "The Century in Review" — what changed between two days of history, as a card of
// short, clickable lines. digest(world, fromDay, toDay) is pure (published, contracts §12):
// it reads the yearly records, the entity ledgers, the chronicle, the catastrophe catalogue,
// the Hall of Records and the atlas plates, and returns
//   { fromDay, toDay, fromYear, toYear, approx, headline: [string ≤ 3],
//     sections: [{ id, title, icon, lines: [{ text, sel?: { kind, id } }] }],
//     plates: { before: atlas index | null, after: atlas index | null } }
// The card shows on 'leapDone', when a run-until stops more than 20 years on, on
// 'worldRestored' over 20 years, and on demand (commands "Digest of the last century" and
// "Digest since Year…"); the Annals list one per century. Automatic cards can be switched off
// from the card itself (pref records.digestAuto).

import { DAYS_PER_YEAR, ERAS } from '../core/constants.js';
import { h } from './dom.js';
import { openModal, promptDialog } from './widgets.js';
import * as F from './format.js';
import { registerCommand } from './registry.js';
import { getPref, setPref } from './prefs.js';
import { recordsBroken } from '../sim/records.js';

let plateMod = null;
try { plateMod = await import('./plate.js'); } catch (e) { /* no plates in the card */ }

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const yearOf = (day) => Math.floor(fin(day) / DAYS_PER_YEAR);
const AUTO_MIN_YEARS = 20;

/** The yearly record nearest a year (records are thinned in old ages). */
function recordNear(ys, y) {
  let best = null, bd = Infinity;
  for (const r of ys) { const d = Math.abs(r.y - y); if (d < bd) { bd = d; best = r; } if (r.y > y && d > bd) break; }
  return best;
}

/** A civ's people / land at a day from its ledger (nearest sample at or before), else from the yearly records. */
function civAt(w, ys, id, day, ch) {
  const raw = w.history?.series?.c?.[id];
  const j = ch === 'pop' ? 0 : 1;
  if (raw && Array.isArray(raw.v) && day >= raw.t0) {
    const C = 10, n = Math.floor(raw.v.length / C);
    const k = Math.min(n - 1, Math.floor((day - raw.t0) / raw.st));
    if (k >= 0 && (raw.e == null || day <= raw.e + DAYS_PER_YEAR)) return raw.v[k * C + j];
  }
  const r = recordNear(ys, yearOf(day));
  return r?.civ?.[id] ? r.civ[id][j] : 0;
}

export function digest(world, fromDay, toDay) {
  const w = world;
  fromDay = Math.max(0, Math.min(fin(fromDay), fin(toDay)));
  toDay = Math.max(fromDay, fin(toDay, w.time.day));
  const y0 = yearOf(fromDay), y1 = yearOf(toDay);
  const ys = w.history?.years || [];
  const inSpan = (d) => d != null && d >= fromDay && d <= toDay;
  const sections = [];
  const add = (id, title, icon, lines) => { const l = lines.filter(Boolean); if (l.length) sections.push({ id, title, icon, lines: l.slice(0, 4) }); };
  // flows over the span from the yearly records
  let wars = 0, dead = 0, pdead = 0, battles = 0, risen = 0, fell = 0;
  let thin = false, prevY = null;
  for (const r of ys) {
    if (r.y <= y0 || r.y > y1) continue;
    if (prevY != null && r.y - prevY > 1) thin = true;
    prevY = r.y;
    wars += fin(r.newWars); dead += fin(r.casualties); pdead += fin(r.pdeaths); battles += fin(r.battles); risen += fin(r.newCivs); fell += fin(r.fell);
  }
  const rA = recordNear(ys, y0), rB = recordNear(ys, y1);
  const popA = fin(rA?.pop), popB = fin(w.time.day <= toDay + DAYS_PER_YEAR ? w.stats?.pop ?? rB?.pop : rB?.pop, fin(rB?.pop));

  // --- people: the world, and who rose and fell
  const ids = new Set();
  for (const c of w.civs) if (c && fin(c.foundedDay) <= toDay && (c.alive || fin(c.fallenDay) >= fromDay)) ids.add(c.id);
  const delta = [];
  for (const id of ids) {
    const c = w.civs[id];
    const a = civAt(w, ys, id, fromDay, 'pop'), b = c.alive && toDay >= w.time.day - 30 ? fin(c.population) : civAt(w, ys, id, toDay, 'pop');
    const la = civAt(w, ys, id, fromDay, 'land'), lb = c.alive && toDay >= w.time.day - 30 ? fin(c.territory) : civAt(w, ys, id, toDay, 'land');
    delta.push({ c, a, b, d: b - a, la, lb, dl: lb - la });
  }
  const riser = delta.slice().sort((p, q) => q.d - p.d)[0];
  const faller = delta.slice().sort((p, q) => p.d - q.d)[0];
  const landRiser = delta.slice().sort((p, q) => q.dl - p.dl)[0];
  const ppl = [];
  if (popA > 0 || popB > 0) ppl.push({ text: `The world ${popB >= popA ? 'grew' : 'shrank'} from ${F.people(popA)} to ${F.people(popB)} people (${F.signed(popA > 0 ? ((popB - popA) / popA) * 100 : 0, 0, '%')}).` });
  if (riser && riser.d > 0) ppl.push({ text: `${F.TheCiv(riser.c)} grew most, by ${F.people(riser.d)} people${riser.a > 0 ? ` (${F.signed(((riser.b - riser.a) / riser.a) * 100, 0, '%')})` : ''}.`, sel: { kind: 'civ', id: riser.c.id } });
  if (landRiser && landRiser.dl > 20 && landRiser.c !== riser?.c) ppl.push({ text: `${F.TheCiv(landRiser.c)} gained the most land: ${F.areaShort(landRiser.dl)}.`, sel: { kind: 'civ', id: landRiser.c.id } });
  if (faller && faller.d < 0) ppl.push({ text: `${F.TheCiv(faller.c)} lost the most, ${F.people(-faller.d)} people${faller.c.alive ? '' : ', and fell'}.`, sel: { kind: 'civ', id: faller.c.id } });
  add('people', 'People', 'people', ppl);

  // --- nations founded, split and fallen
  const born = w.civs.filter((c) => c && inSpan(c.foundedDay) && c.foundedDay > 0);
  const gone = w.civs.filter((c) => c && inSpan(c.fallenDay));
  const nat = [];
  const splits = born.filter((c) => c.parentId != null && w.civs[c.parentId]);
  const fresh = born.filter((c) => c.parentId == null || !w.civs[c.parentId]);
  for (const c of splits.slice(0, 2)) nat.push({ text: `${F.TheCiv(c)} broke away from ${F.theCiv(w.civs[c.parentId])} in ${F.year(c.foundedDay)}.`, sel: { kind: 'civ', id: c.id } });
  for (const c of fresh.slice(0, 1)) nat.push({ text: `A new people arose: ${F.theCiv(c)}, ${F.year(c.foundedDay)}.`, sel: { kind: 'civ', id: c.id } });
  for (const c of gone.sort((p, q) => fin(q.peakPopulation) - fin(p.peakPopulation)).slice(0, 2)) nat.push({ text: `${F.TheCiv(c)} fell in ${F.year(c.fallenDay)} (${F.humanize(c.fallCause || 'collapse').toLowerCase()}), after ${F.span(c.fallenDay - c.foundedDay)}.`, sel: { kind: 'civ', id: c.id } });
  if (born.length + gone.length > nat.length) nat.push({ text: `${F.int(born.length)} nations rose and ${F.int(gone.length)} fell in all.` });
  add('nations', 'Nations', 'nations', nat);

  // --- wars: the deadliest, and the greatest conquests
  const overlap = w.wars.filter((q) => q && fin(q.startDay) <= toDay && (q.active || fin(q.endDay) >= fromDay));
  const toll = (q) => Object.values(q.casualties || {}).reduce((a, v) => a + fin(v), 0);
  const deadliest = overlap.slice().sort((p, q) => toll(q) - toll(p))[0];
  const takers = new Map();
  for (const s of w.settlements) {
    if (!s || !Array.isArray(s.own)) continue;
    for (let k = 1; k < s.own.length; k++) { const [d, to, code] = s.own[k]; if (code === 'c' && inSpan(d)) takers.set(to, (takers.get(to) || 0) + 1); }
  }
  const topTaker = [...takers.entries()].sort((a, b) => b[1] - a[1])[0];
  const warL = [];
  if (wars || battles) warL.push({ text: `${F.int(wars)} war${wars === 1 ? '' : 's'} began; ${F.int(battles)} battles were fought and ${F.people(dead)} fell.` });
  if (deadliest && toll(deadliest) > 0) warL.push({ text: `The deadliest was ${F.midName(deadliest.name)}: ${F.people(toll(deadliest))} dead${deadliest.active ? ', and still raging' : `, ${F.outcomeName(deadliest.outcome).toLowerCase()}`}.`, sel: { kind: 'war', id: deadliest.id } });
  if (topTaker && topTaker[1] >= 2 && w.civs[topTaker[0]]) warL.push({ text: `${F.TheCiv(w.civs[topTaker[0]])} took ${F.int(topTaker[1])} towns by the sword.`, sel: { kind: 'civ', id: topTaker[0] } });
  add('wars', 'Wars', 'war', warL);

  // --- faith
  const faiths = w.religions.filter((r) => r && inSpan(r.foundedDay));
  const faithL = faiths.slice(0, 3).map((r) => ({ text: r.parentId != null && w.religions[r.parentId] ? `${F.headName(r.name)} split from ${F.midName(w.religions[r.parentId].name)} (${F.year(r.foundedDay)}).` : `${F.headName(r.name)} was founded${w.settlements[r.holyCityId] ? ` at ${w.settlements[r.holyCityId].name}` : ''} (${F.year(r.foundedDay)}).`, sel: { kind: 'religion', id: r.id } }));
  const deadFaiths = w.religions.filter((r) => r && r.alive === false && inSpan(r.endDay));
  if (deadFaiths.length) faithL.push({ text: `${F.int(deadFaiths.length)} faith${deadFaiths.length === 1 ? '' : 's'} died out.` });
  add('faith', 'Faith', 'faith', faithL);

  // --- plague
  const plagues = w.plagues.filter((p) => p && fin(p.startDay) <= toDay && (p.active || fin(p.endDay) >= fromDay)).sort((p, q) => fin(q.deaths) - fin(p.deaths));
  const plL = [];
  // the span's toll (from the yearly records) and each outbreak's whole toll are told as such
  if (pdead >= 1) plL.push({ text: `Plague killed ${F.people(pdead)} in these years${plagues.length ? ` (${F.int(plagues.length)} outbreak${plagues.length === 1 ? '' : 's'})` : ''}.` });
  for (const p of plagues.slice(0, 2)) if (fin(p.deaths) >= 50) plL.push({ text: `${F.headName(p.name)}: ${F.people(p.deaths)} dead in all${fin(p.startDay) < fromDay ? ` since ${F.year(p.startDay)}` : ''}, in ${F.int(p.hit || 0)} town${(p.hit || 0) === 1 ? '' : 's'}${p.worst?.frac >= 0.15 ? `; ${p.worst.name} lost ${F.pct(p.worst.frac)}` : ''}.`, sel: { kind: 'plague', id: p.id } });
  add('plague', 'Plague', 'plague', plL);

  // --- catastrophe: the catalogue, and the historic disaster entries
  const evs = (w.history?.events || []).filter((e) => inSpan(e.d)).sort((p, q) => q.dead - p.dead || q.m - p.m);
  const catL = [];
  for (const e of evs.slice(0, 3)) {
    if (!(e.dead > 0) && e.t !== 'eruption' && e.t !== 'impact' && e.t !== 'quake') continue;
    const what = { quake: `a quake of magnitude ${fin(e.m).toFixed(1)}`, tsunami: 'a great wave', eruption: `an eruption of VEI ${Math.round(e.m)}`, impact: 'a falling star', flood: 'a flood', storm: e.k === 'cyclone' && e.m > 0 ? `a category ${Math.round(e.m)} cyclone` : `a ${e.k || 'storm'}`, fire: 'a great fire', famine: 'a famine', locusts: 'locusts' }[e.t] || e.t;
    const head = e.n ? `${F.headName(e.n)}, ${what},` : F.headName(what);
    catL.push({ text: `${head} in ${F.year(e.d)}${e.dead ? `: ${F.people(e.dead)} dead` : ''}.`, sel: e.t === 'storm' && e.sid != null ? { kind: 'storm', id: e.sid } : { kind: 'event', id: e.id } });
  }
  for (const e of w.chronicle.entries) {
    if (catL.length >= 4) break;
    if (inSpan(e.day) && e.imp >= 4 && (e.cat === 'disaster' || e.cat === 'climate') && !e.fold) catL.push({ text: e.text, sel: e.ref ? { kind: e.ref.k, id: e.ref.id } : e.sid != null ? { kind: 'settlement', id: e.sid } : null });
  }
  add('fury', 'Catastrophe', 'volcano', catL);

  // --- discovery: eras first reached
  const disc = [];
  const ef = w.sys?.civ?.eraFirst;
  if (ef && typeof ef === 'object') {
    for (const [era, rec] of Object.entries(ef)) if (rec && inSpan(rec.day) && w.civs[rec.civId]) disc.push({ text: `${F.TheCiv(w.civs[rec.civId])} ${F.civPlural(w.civs[rec.civId]) ? 'were' : 'was'} the first to enter the ${ERAS[era]?.name || 'new age'} (${F.year(rec.day)}).`, sel: { kind: 'civ', id: rec.civId } });
  } else {
    const eraA = fin(rA?.era), eraB = fin(rB?.era);
    for (let e = eraA + 1; e <= eraB; e++) disc.push({ text: `The world entered the ${ERAS[e]?.name || 'new age'}.` });
  }
  for (const e of w.chronicle.entries) {
    if (disc.length >= 3) break;
    if (inSpan(e.day) && e.cat === 'tech' && e.imp >= 4 && !disc.some((d) => d.text === e.text)) disc.push({ text: e.text, sel: e.civId != null ? { kind: 'civ', id: e.civId } : null });
  }
  add('discovery', 'Discovery', 'enlighten', disc);

  // --- records broken
  // the standing mark of each record broken in the span (a record broken twice is told once, as it stands)
  const br = recordsBroken(w, fromDay, toDay);
  const told = new Set();
  const marks = br.slice().reverse().filter((r) => { if (told.has(r.key)) return false; told.add(r.key); return true; }).slice(0, 4);
  add('records', 'Records broken', 'star', marks.map((r) => ({ text: `${r.label}: ${F.headName(r.holder)} (${F.recordValue(r.fmt, r.v)}), ${F.year(r.day)}.` })));

  // --- great people
  const figs = w.figures.filter((f) => f && (inSpan(f.died) || inSpan(f.born)) && (f.kind !== 'general' || (f.deeds || []).length >= 2));
  const figL = [];
  for (const f of figs.filter((q) => inSpan(q.died)).sort((p, q) => (q.deeds?.length || 0) - (p.deeds?.length || 0)).slice(0, 2)) figL.push({ text: `${f.name}, ${f.kind}${w.civs[f.civId] ? ` of ${F.theCiv(w.civs[f.civId])}` : ''}, died in ${F.year(f.died)}${f.deeds?.length ? ` (${f.deeds[f.deeds.length - 1]})` : ''}.`, sel: { kind: 'figure', id: f.id } });
  for (const f of figs.filter((q) => inSpan(q.born) && q.died == null).slice(0, 1)) figL.push({ text: `${f.name}, a ${f.kind}${w.civs[f.civId] ? ` of ${F.theCiv(w.civs[f.civId])}` : ''}, came into the world.`, sel: { kind: 'figure', id: f.id } });
  add('people-great', 'Great people', 'star', figL);

  // headline: the three largest facts
  const headline = [];
  const isNow = toDay >= w.time.day - 30;
  if (popA > 0 && popB > 0) headline.push(isNow ? `${F.people(popB)} people now live, ${popB >= popA ? 'up' : 'down'} from ${F.people(popA)}.` : `By Year ${y1} the world held ${F.people(popB)} people, ${popB >= popA ? 'up' : 'down'} from ${F.people(popA)}.`);
  if (deadliest && toll(deadliest) >= 1000) headline.push(`${F.headName(F.midName(deadliest.name))} cost ${F.people(toll(deadliest))} lives.`);
  else if (gone.length) headline.push(`${F.TheCiv(gone[0])} fell.`);
  if (plagues[0] && fin(plagues[0].deaths) >= 1000) headline.push(fin(plagues[0].startDay) < fromDay ? `${F.headName(plagues[0].name)} has killed ${F.people(plagues[0].deaths)} since ${F.year(plagues[0].startDay)}.` : `${F.headName(plagues[0].name)} killed ${F.people(plagues[0].deaths)}.`);
  else if (evs[0] && evs[0].dead >= 200) headline.push(`${F.headName(evs[0].n || EVENT_WORD[evs[0].t] || 'A catastrophe')} killed ${F.people(evs[0].dead)}.`);
  else if (riser && riser.d > 0) headline.push(`${F.TheCiv(riser.c)} rose highest.`);

  // atlas plates before and after
  const atlas = w.history?.atlas || [];
  let before = null, after = null;
  for (let k = 0; k < atlas.length; k++) { const d = atlas[k].day ?? atlas[k].y * DAYS_PER_YEAR; if (d <= fromDay + 5 * DAYS_PER_YEAR) before = k; if (d <= toDay) after = k; }
  if (before === after) before = null;
  return { fromDay, toDay, fromYear: y0, toYear: y1, approx: thin, headline: headline.slice(0, 3), sections, plates: { before, after } };
}
const EVENT_WORD = { quake: 'A great quake', tsunami: 'A great wave', eruption: 'An eruption', impact: 'A falling star', flood: 'A flood', storm: 'A storm', fire: 'A great fire', famine: 'Famine', locusts: 'Locusts' };

// ---------------------------------------------------------------------------
// The card

function spanTitle(d) {
  const n = d.toYear - d.fromYear;
  if (n >= 95 && n <= 105 && d.fromYear % 100 === 0) return `The ${F.ordinal(d.fromYear / 100 + 1)} century in review`;
  return n >= 1 ? `${F.int(n)} years in review` : 'The year in review';
}

/** Show the digest card for [fromDay, toDay]. */
export function openDigest(app, fromDay, toDay, { auto = false } = {}) {
  const w = app.world;
  if (!w) return null;
  const d = digest(w, fromDay, toDay);
  const body = h('div.digest');
  body.appendChild(h('p.digest-span', { text: `From Year ${d.fromYear} to Year ${d.toYear}${d.approx ? ' · older years are summarised from thinned records' : ''}` }));
  if (d.headline.length) body.appendChild(h('ul.digest-headline', null, d.headline.map((t) => h('li', { text: t }))));
  let modal = null;
  if (plateMod && (d.plates.before != null || d.plates.after != null)) {
    const atlas = w.history.atlas;
    const pair = h('div.digest-plates');
    for (const [k, label] of [[d.plates.before, 'Before'], [d.plates.after, 'After']]) {
      if (k == null) continue;
      const cv = h('canvas.digest-plate', { role: 'img', 'aria-label': `Borders in Year ${atlas[k].y}` });
      pair.appendChild(h('figure', null, cv, h('figcaption', { text: `${label} · Year ${atlas[k].y}` })));
      requestAnimationFrame(() => { try { plateMod.drawAtlasPlate(cv, w, atlas[k], { scale: 3 }); } catch (e) { cv.remove(); } });
    }
    body.appendChild(pair);
  }
  const grid = h('div.digest-sections');
  for (const s of d.sections) {
    const list = h('ul');
    for (const line of s.lines) {
      const li = h('li');
      if (line.sel) {
        const b = h('button.link', { type: 'button', text: line.text });
        b.addEventListener('click', () => { modal?.close(true); app.select(line.sel, { focus: true }); });
        li.appendChild(b);
      } else li.textContent = line.text;
      list.appendChild(li);
    }
    grid.appendChild(h('section.digest-sec', { dataset: { sec: s.id } }, h('h4.rule-head', { text: s.title }), list));
  }
  if (!d.sections.length) grid.appendChild(h('p.empty-note', { text: 'Nothing of great note happened in these years.' }));
  body.appendChild(grid);
  const autoBox = h('label.digest-auto', null, h('input', { type: 'checkbox', id: 'digest-auto', checked: getPref('records.digestAuto', true) ? true : null }), ' Show this after every leap through time');
  autoBox.querySelector('input').addEventListener('change', (e) => setPref('records.digestAuto', e.target.checked));
  body.appendChild(autoBox);
  modal = openModal({
    title: spanTitle(d), body,
    actions: [
      { label: 'Read the Chronicle of these years', cls: 'btn-brass', onClick: (m) => { m.close(true); app.emit('chronicleRange', d.fromYear, d.toYear); app.setTab('chronicle'); app.emit('layout', 'open-panel'); } },
      { label: 'Close', onClick: (m) => m.close(false) },
    ],
  });
  modal?.box?.classList.add('is-digest');
  return modal;
}

// ---------------------------------------------------------------------------

export function mount(app) {
  let lastStill = null;     // the day the world last stood still (not fast-forwarding)
  let leapSeen = false;
  app.on('world', (w) => { lastStill = w?.time?.day ?? null; });
  app.on('tick', () => { if (app.world && !app.fastForwarding) lastStill = app.world.time.day; });
  const auto = () => getPref('records.digestAuto', true) !== false;
  app.on('leapDone', (e) => {
    leapSeen = true;
    // a run-until arrival (hit set) shows its own Arrived card, which offers the digest;
    // a cancelled search is not a span worth summing up
    if (!auto() || !app.world || !e || e.hit || e.cancelled) return;
    const span = fin(e.toDay) - fin(e.fromDay);
    if (span >= DAYS_PER_YEAR) setTimeout(() => openDigest(app, e.fromDay, e.toDay, { auto: true }), 120);
  });
  // a run-until (or any other fast-forward) that carried the world far: digest the span it covered
  app.on('historySkipped', () => {
    const from = lastStill, w = app.world;
    leapSeen = false;
    setTimeout(() => {
      if (leapSeen || !auto() || !w || app.world !== w || from == null || from <= 0) return;
      if (w.time.day - from >= AUTO_MIN_YEARS * DAYS_PER_YEAR) openDigest(app, from, w.time.day, { auto: true });
      lastStill = w.time.day;
    }, 200);
  });
  app.on('worldRestored', (e) => {
    if (!auto() || !e || !app.world) return;
    if (fin(e.toDay) - fin(e.fromDay) > AUTO_MIN_YEARS * DAYS_PER_YEAR) setTimeout(() => openDigest(app, e.fromDay, e.toDay, { auto: true }), 120);
  });
  registerCommand({
    id: 'digest.century', label: 'Digest of the last hundred years', group: 'Records', keywords: ['review', 'summary', 'century', 'digest'], icon: 'chronicle',
    when: (a) => Boolean(a.world), run(a) { const w = a.world; openDigest(a, Math.max(0, w.time.day - 100 * DAYS_PER_YEAR), w.time.day); }, menu: 'History',
  });
  registerCommand({
    id: 'digest.since', label: 'Digest since Year…', group: 'Records', keywords: ['review', 'summary', 'since', 'digest'], icon: 'chronicle',
    when: (a) => Boolean(a.world),
    async run(a, arg) {
      const w = a.world;
      let y = Number(arg);
      if (!Number.isFinite(y)) {
        const v = await promptDialog({ title: 'Digest since…', label: 'From which year?', value: String(Math.max(0, yearOf(w.time.day) - 100)), confirmLabel: 'Show the digest' });
        if (v == null || !/^\s*\d+\s*$/.test(v)) return;
        y = Number(v);
      }
      if (Number.isFinite(y)) openDigest(a, Math.max(0, Math.min(w.time.day, y * DAYS_PER_YEAR)), w.time.day);
    },
  });
}
