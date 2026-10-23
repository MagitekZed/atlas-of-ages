// Run until… and the Notices.
//
// U opens "Run until": history runs at full speed (app.fastForward with an until test, capped
// at 1,000 years) until something the viewer cares about happens — the next war (anywhere,
// or involving the selected or watched nation, or the patron), the next historic or epochal
// event, a nation falling or rising, a plague, an eruption or great disaster, a new era, the
// selected town changing hands, being besieged or growing, the selected ruler's death, or a
// given year. Then time stops on that day, the map flies there, the record opens and an
// Arrived card offers to keep going until the next one; Shift+U does the same at any time.
// The Leap modal (J) carries the common ones too. Other packages add conditions through
// registerUntilCondition; they are listed here alongside the built-in ones.
//
// Tests run once per simulated day: they compare a few numbers, or read an event log that
// read-only hook listeners fill (ignoring replays and other worlds), so they cost next to
// nothing. The same catalogue arms the Notices' "pause when…" rules during live play.
// The Notices dialog (menu) also sets each category's toast threshold, quiet-at-speed and
// whether a leap clears the Chronicle's badge (prefs.getNotices).

import { CATEGORIES, DAYS_PER_YEAR } from '../core/constants.js';
import { on as onHook } from '../core/hooks.js';
import { chronicleSince } from '../core/chronicle.js';
import { yearOf } from '../core/world.js';
import { registerKey, registerCommand, registerUntilCondition, getUntilConditions, getUntilCondition } from './registry.js';
import { h } from './dom.js';
import { iconEl } from './icons.js';
import { showProgress, openModal, msText, tip } from './widgets.js';
import { statusToast, actionToast } from './toasts.js';
import { getNotices, setNotices, NOTICE_LEVELS, noticeMin } from './prefs.js';
import { entrySel, entryPoint } from './app.js';
import * as F from './format.js';

const Y = DAYS_PER_YEAR;
const CAPS = [100, 250, 500, 1000];
const LOG_CAP = 400;

export function mount(app) {
  // --- the event log hook listeners fill ---------------------------------------------------
  // read-only: they note what happened in the live world and never touch it
  const log = [];       // { n, t, id, day, x?, y?, text? }
  let logN = 0;
  const note = (t, world, rec) => {
    if (!world || world !== app.world || world.cache?.replaying) return;
    log.push({ n: ++logN, t, day: world.time.day, ...rec });
    if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
  };
  onHook('civDestroyed', (w, civ, cause) => note('civFell', w, { id: civ.id, cause }));
  onHook('civCreated', (w, civ) => note('civRose', w, { id: civ.id }));
  onHook('warStarted', (w, war) => note('war', w, { id: war.id }));
  onHook('plagueStarted', (w, p) => note('plague', w, { id: p?.id }));
  onHook('eruption', (w, e) => note('disaster', w, { kind: 'eruption', x: e?.x, y: e?.y, deaths: e?.deaths || 0 }));
  onHook('impact', (w, e) => note('disaster', w, { kind: 'impact', x: e?.x, y: e?.y, deaths: e?.deaths || 0 }));
  onHook('tsunami', (w, e) => note('disaster', w, { kind: 'tsunami', x: e?.x, y: e?.y, deaths: e?.deaths || 0 }));
  onHook('quake', (w, e) => { if ((e?.mag || 0) >= 7) note('disaster', w, { kind: 'quake', x: e?.x, y: e?.y, deaths: e?.deaths || 0 }); });
  onHook('eraReached', (w, civ, era, first) => note('era', w, { id: civ?.id, era, first }));
  onHook('siegeStarted', (w, e) => note('siege', w, { id: e?.sid }));
  onHook('settlementTransferred', (w, s, from, to, cause) => note('hands', w, { id: s.id, from, to, cause }));
  onHook('settlementDestroyed', (w, s, cause) => note('razed', w, { id: s.id, cause }));
  onHook('rulerDied', (w, civ, ruler, cause) => note('ruler', w, { id: civ?.id, cause }));
  const since = (from, t) => { const out = []; for (let k = log.length - 1; k >= 0 && log[k].n > from; k--) if (log[k].t === t) out.unshift(log[k]); return out; };

  // --- places for hits ---------------------------------------------------------------------
  const capitalOf = (w, cid) => { const c = w.civs[cid]; const s = c && c.capitalId != null ? w.settlements[c.capitalId] : null; return s ? { x: s.x, y: s.y } : c && Number.isFinite(c.originX) ? { x: c.originX, y: c.originY } : null; };
  const hitAt = (text, p, ref = null, extra = {}) => ({ text, x: p?.x ?? null, y: p?.y ?? null, ref, ...extra });

  /** The first new chronicle entry since state.seq that passes keep(e). */
  function entryHit(world, state, keep) {
    if (world.chronicle.seq === state.seq) return null;
    const fresh = chronicleSince(world, state.seq);
    state.seq = world.chronicle.seq;
    for (const e of fresh) if (!e.fold && keep(e)) return hitAt(e.text, entryPoint(app, e), e.ref || null, { entry: e });
    return null;
  }

  // --- the catalogue -------------------------------------------------------------------------
  const watchedCivs = () => {
    const w = app.world;
    const ids = new Set();
    for (const q of w?.ui?.watch || []) if (q.kind === 'civ') ids.add(q.id);
    if (w?.ui?.patron != null) ids.add(w.ui.patron);
    return ids;
  };
  /** Is anything watched (a nation, a place, a thing) or a people of the viewer's own chosen? */
  const watchingAny = () => watchedCivs().size > 0 || (app.world?.ui?.watch || []).length > 0;
  const civName = (id) => app.world?.civs[id]?.name || 'that nation';
  const cap = (t) => (t ? String(t)[0].toUpperCase() + String(t).slice(1) : '');
  const townName = (id) => app.world?.settlements[id]?.name || 'that town';

  const BUILTIN = [
    {
      id: 'war', label: 'The next war', icon: 'war', live: true, group: 'War and peace',
      describe: (a) => (a?.scope === 'civ' ? `${civName(a.civId)} goes to war` : a?.scope === 'watched' ? 'A war touches your people or a watched nation' : 'The next war breaks out'),
      arm: (ap, a = {}) => ({ from: logN, scope: a.scope || 'any', civId: a.civId ?? null, civs: a.scope === 'watched' ? [...watchedCivs()] : null }),
      test(world, st) {
        for (const ev of since(st.from, 'war')) {
          st.from = ev.n;
          const war = world.wars[ev.id];
          if (!war) continue;
          const sides = [...war.attackers, ...war.defenders];
          if (st.scope === 'civ' && !sides.includes(st.civId)) continue;
          if (st.scope === 'watched' && !sides.some((id) => st.civs.includes(id))) continue;
          return hitAt(`${cap(war.name)} began: ${civName(war.attackers[0])} against ${civName(war.defenders[0])}.`, capitalOf(world, war.defenders[0]), { k: 'war', id: war.id });
        }
        return null;
      },
    },
    {
      id: 'historic', label: 'The next historic event', icon: 'chronicle', live: true, group: 'The Chronicle',
      describe: () => 'Something historic happens (importance 4 or more)',
      arm: (ap) => ({ seq: ap.world.chronicle.seq }),
      test: (world, st) => entryHit(world, st, (e) => e.imp >= 4),
    },
    {
      id: 'epochal', label: 'The next epochal event', icon: 'crown', live: true, group: 'The Chronicle',
      describe: () => 'An epochal event: the turn of an age',
      arm: (ap) => ({ seq: ap.world.chronicle.seq }),
      test: (world, st) => entryHit(world, st, (e) => e.imp >= 5),
    },
    {
      id: 'civFalls', label: 'A nation falls', icon: 'ruin', live: true, group: 'Nations',
      describe: (a) => (a?.civId != null ? `${civName(a.civId)} falls` : a?.scope === 'watched' ? 'Your people or a watched nation falls' : 'Any nation falls'),
      arm: (ap, a = {}) => ({ from: logN, civId: a.civId ?? null, civs: a.scope === 'watched' ? [...watchedCivs()] : null }),
      test(world, st) {
        for (const ev of since(st.from, 'civFell')) {
          st.from = ev.n;
          if (st.civId != null && ev.id !== st.civId) continue;
          if (st.civs && !st.civs.includes(ev.id)) continue;
          const c = world.civs[ev.id];
          return hitAt(`${c?.name || 'A nation'} fell${ev.cause ? ` to ${F.humanize(ev.cause).toLowerCase()}` : ''}.`, c ? { x: c.originX, y: c.originY } : null, { k: 'civ', id: ev.id });
        }
        if (st.civId != null && world.civs[st.civId]?.alive === false) return hitAt(`${civName(st.civId)} is no more.`, null, { k: 'civ', id: st.civId });
        return null;
      },
    },
    {
      id: 'civRises', label: 'A new nation rises', icon: 'tribe', live: false, group: 'Nations',
      describe: () => 'A new people rises or splits away',
      arm: () => ({ from: logN }),
      test(world, st) {
        for (const ev of since(st.from, 'civRose')) {
          st.from = ev.n;
          const c = world.civs[ev.id];
          if (!c) continue;
          const parent = c.parentId != null ? world.civs[c.parentId] : null;
          return hitAt(`${c.name} rose${parent ? `, breaking away from ${parent.name}` : ''}.`, { x: c.originX, y: c.originY }, { k: 'civ', id: c.id });
        }
        return null;
      },
    },
    {
      id: 'plague', label: 'The next plague', icon: 'plague', live: true, group: 'Nature and fate',
      describe: () => 'A plague breaks out',
      arm: (ap) => ({ from: logN, n: ap.world.plagues.length }),
      test(world, st) {
        const hooked = since(st.from, 'plague');
        if (hooked.length) st.from = hooked[hooked.length - 1].n;
        if (world.plagues.length > st.n || hooked.length) {
          const p = world.plagues[st.n] || world.plagues[world.plagues.length - 1];
          st.n = world.plagues.length;
          if (!p) return null;
          const o = p.originSid != null ? world.settlements[p.originSid] : null;
          return hitAt(`${cap(p.name)} broke out${o ? ` in ${o.name}` : ''}.`, o ? { x: o.x, y: o.y } : null, { k: 'plague', id: p.id });
        }
        return null;
      },
    },
    {
      id: 'disaster', label: 'An eruption or great disaster', icon: 'volcano', live: true, group: 'Nature and fate',
      describe: () => 'An eruption, a falling star or another great disaster',
      arm: (ap) => ({ from: logN, seq: ap.world.chronicle.seq, erupting: new Set(ap.world.volcanoes.filter((v) => v.erupting > 0).map((v) => v.id)) }),
      test(world, st) {
        const hooked = since(st.from, 'disaster');
        if (hooked.length) {
          st.from = hooked[hooked.length - 1].n;
          const ev = hooked[0];
          const e = entryHit(world, st, (q) => q.cat === 'disaster' && q.imp >= 3);
          if (e) return e;
          return hitAt(`A ${ev.kind === 'impact' ? 'star fell' : ev.kind === 'eruption' ? 'volcano erupted' : ev.kind === 'tsunami' ? 'great wave struck' : 'great earthquake struck'}${ev.deaths ? `, and ${F.people(ev.deaths)} died` : ''}.`, { x: ev.x, y: ev.y });
        }
        for (const v of world.volcanoes) {
          if (v.erupting > 0 && !st.erupting.has(v.id)) { st.erupting.add(v.id); return hitAt(`${v.name} erupted.`, { x: v.x, y: v.y }, { k: 'volcano', id: v.id }); }
          if (!(v.erupting > 0)) st.erupting.delete(v.id);
        }
        return entryHit(world, st, (q) => q.cat === 'disaster' && q.imp >= 4);
      },
    },
    {
      id: 'era', label: 'Someone reaches a new era', icon: 'enlighten', live: false, group: 'Nations',
      describe: (a) => (a?.civId != null ? `${civName(a.civId)} reaches a new era` : 'Any people reaches a new era'),
      arm: (ap, a = {}) => ({ from: logN, civId: a.civId ?? null, eras: Object.fromEntries(ap.world.civs.filter((c) => c && c.alive !== false).map((c) => [c.id, c.tech?.era | 0])), next: ap.world.time.day + 30 }),
      test(world, st) {
        for (const ev of since(st.from, 'era')) {
          st.from = ev.n;
          if (st.civId != null && ev.id !== st.civId) continue;
          return hitAt(`${civName(ev.id)} entered the ${F.eraName(ev.era)}.`, capitalOf(world, ev.id), { k: 'civ', id: ev.id });
        }
        if (world.time.day < st.next) return null;      // without the hook: a monthly look
        st.next = world.time.day + 30;
        for (const c of world.civs) {
          if (!c || c.alive === false || (st.civId != null && c.id !== st.civId)) continue;
          const e = c.tech?.era | 0;
          if (e > (st.eras[c.id] ?? e)) return hitAt(`${c.name} entered the ${F.eraName(e)}.`, capitalOf(world, c.id), { k: 'civ', id: c.id });
          st.eras[c.id] = e;
        }
        return null;
      },
    },
    {
      id: 'townHands', label: 'The selected town changes hands', icon: 'town', live: true, needs: 'settlement', group: 'This place',
      describe: (a) => `${townName(a?.sid)} changes hands or falls`,
      arm: (ap, a = {}) => { const s = ap.world.settlements[a.sid]; return { sid: a.sid, civId: s?.civId ?? null }; },
      test(world, st) {
        const s = world.settlements[st.sid];
        if (!s) return null;
        if (!s.alive) return hitAt(`${s.name} was destroyed${s.destroyCause ? ` (${F.humanize(s.destroyCause).toLowerCase()})` : ''}.`, { x: s.x, y: s.y }, { k: 'settlement', id: s.id });
        if (s.civId !== st.civId) return hitAt(`${s.name} passed from ${civName(st.civId)} to ${civName(s.civId)}.`, { x: s.x, y: s.y }, { k: 'settlement', id: s.id });
        return null;
      },
    },
    {
      id: 'townSiege', label: 'The selected town is besieged', icon: 'war', live: true, needs: 'settlement', group: 'This place',
      describe: (a) => `${townName(a?.sid)} is besieged`,
      arm: (ap, a = {}) => ({ sid: a.sid, was: Boolean(ap.world.settlements[a.sid]?.siege) }),
      test(world, st) {
        const s = world.settlements[st.sid];
        if (!s || !s.alive) return s ? hitAt(`${s.name} is no more.`, { x: s.x, y: s.y }, { k: 'settlement', id: s.id }) : null;
        if (s.siege && !st.was) { const c = world.civs[s.siege.civId]; return hitAt(`${c ? c.adjective + ' troops' : 'An army'} laid siege to ${s.name}.`, { x: s.x, y: s.y }, { k: 'settlement', id: s.id }); }
        st.was = Boolean(s.siege);
        return null;
      },
    },
    {
      id: 'townTier', label: 'The selected town grows', icon: 'settle', live: false, needs: 'settlement', group: 'This place',
      describe: (a) => `${townName(a?.sid)} reaches its next size`,
      arm: (ap, a = {}) => ({ sid: a.sid, tier: ap.world.settlements[a.sid]?.tier ?? 0 }),
      test(world, st) {
        const s = world.settlements[st.sid];
        if (!s) return null;
        if (!s.alive) return hitAt(`${s.name} is no more.`, { x: s.x, y: s.y }, { k: 'settlement', id: s.id });
        if (s.tier > st.tier) return hitAt(`${s.name} grew into a ${F.tierName(s.tier).toLowerCase()} of ${F.people(s.population)}.`, { x: s.x, y: s.y }, { k: 'settlement', id: s.id });
        return null;
      },
    },
    {
      id: 'rulerDies', label: 'The selected ruler dies', icon: 'crown', live: false, needs: 'civ', group: 'Nations',
      describe: (a) => `The ruler of ${civName(a?.civId)} dies or falls`,
      arm: (ap, a = {}) => { const c = ap.world.civs[a.civId]; return { civId: a.civId, key: rulerKey(c), name: c?.ruler?.display || c?.ruler?.name || 'the ruler' }; },
      test(world, st) {
        const c = world.civs[st.civId];
        if (!c) return null;
        if (c.alive === false) return hitAt(`${c.name} fell, and ${st.name} with it.`, null, { k: 'civ', id: c.id });
        if (rulerKey(c) !== st.key) { const next = c.ruler?.display || c.ruler?.name; return hitAt(`${st.name} of ${c.name} is gone${next ? `; ${next} rules now` : ''}.`, capitalOf(world, c.id), { k: 'civ', id: c.id }); }
        return null;
      },
    },
    {
      id: 'watched', label: 'News of what you watch', icon: 'star', live: true, group: 'The Chronicle',
      describe: () => 'Something major befalls your people or a watched thing',
      arm: (ap) => ({ seq: ap.world.chronicle.seq }),
      test(world, st) {
        const civs = watchedCivs();
        const others = (world.ui?.watch || []).filter((q) => q.kind !== 'civ');
        if (!civs.size && !others.length) { st.seq = world.chronicle.seq; return null; }
        return entryHit(world, st, (e) => e.imp >= 3 && ((e.civId != null && civs.has(e.civId)) || (e.sid != null && (civs.has(world.settlements[e.sid]?.civId) || others.some((q) => q.kind === 'settlement' && q.id === e.sid))) || (e.ref && others.some((q) => q.kind === e.ref.k && q.id === e.ref.id))));
      },
    },
    {
      id: 'year', label: 'A year of your choosing', icon: 'hourglass', live: false, group: 'Time',
      describe: (a) => `Year ${F.int(a?.year ?? 0)}`,
      arm: (ap, a = {}) => ({ day: Math.round((a.year ?? yearOf(ap.world) + 100) * Y) }),
      test: (world, st) => (world.time.day >= st.day ? hitAt(`It is ${dateText(world)}.`, null) : null),
    },
  ];
  for (const d of BUILTIN) registerUntilCondition(d);
  const rulerKey = (c) => (c?.ruler ? `${c.ruler.id ?? ''}|${c.ruler.name}|${c.ruler.born ?? ''}` : 'none');
  const dateText = (w) => `Year ${F.int(yearOf(w))}`;

  // ---------------------------------------------------------------------------
  // Running

  let running = false;
  const conditionLabel = (def, args) => { try { return def.describe ? def.describe(args) : def.label; } catch (e) { return def.label; } };

  /**
   * Run history until condition id (with args) is met, at most capYears. Resolves to the
   * fast-forward result. Then: pause, fly to the place, open the record, show the Arrived card.
   */
  async function runUntil(id, args = {}, { capYears = null } = {}) {
    const w = app.world;
    const def = getUntilCondition(id);
    if (!w || !def || running || app.fastForwarding) return null;
    if (def.needs && !argsReady(def, args)) { statusToast(app, `Select a ${def.needs === 'civ' ? 'nation' : 'settlement'} first.`, 'info', { icon: 'hourglass' }); return null; }
    if (def.id === 'watched' && !watchingAny()) { statusToast(app, 'Watch a nation or a place first (press . on its record), or choose a people of your own.', 'info', { icon: 'hourglass' }); return null; }
    const cap = capYears || getPrefCap();
    let state;
    try { state = def.arm(app, args); } catch (e) { app.reportError(`until.${id}.arm`, e); return null; }
    app.lastUntil = { id, args };
    const label = conditionLabel(def, args);
    running = true;
    app.emit('untilStart', { id, args });
    const seq0 = w.chronicle.seq, fromDay = w.time.day;
    const prog = showProgress('Running until…', [label]);
    await prog.stage(0);
    prog.note('Searching…');
    let r = null;
    try {
      r = await app.fastForward(cap, prog, { until: { test: (wd, st) => def.test(wd, st), state } });
    } catch (e) { app.reportError('until.run', e); }
    finally {
      prog.close();
      running = false;
      try { def.disarm?.(app, state); } catch (e) { /* the condition's own clean-up */ }
    }
    if (!r || app.world !== w) return r;
    app.emit('leapDone', { fromDay, toDay: w.time.day, seq0, hit: r.hit ?? null, cancelled: r.cancelled });
    arrived(def, args, label, r, fromDay);
    return r;
  }
  app.runUntil = (id, args, opts) => runUntil(id, args, opts);

  function arrived(def, args, label, r, fromDay) {
    const w = app.world;
    const span = lapse(w.time.day - fromDay);
    if (r.hit) {
      app.pause();
      const hit = r.hit;
      const sel = hit.entry ? entrySel(app, hit.entry) : hit.ref ? refSel(hit.ref) : null;
      if (sel) app.select(sel, { frame: sel.kind === 'civ' || sel.kind === 'war' || sel.kind === 'plague', focus: !(sel.kind === 'civ' || sel.kind === 'war' || sel.kind === 'plague') });
      else if (Number.isFinite(hit.x) && Number.isFinite(hit.y)) app.focus(hit.x, hit.y, Math.max(app.renderer?.camera?.zoom || 8, 10));
      actionToast(app, {
        icon: def.icon || 'hourglass', kicker: `Arrived · ${dateText(w)}`, title: hit.text || label,
        text: `${cap(span)} passed in ${msText(r.ms).replace(/\u00a0s$/, ' seconds').replace(/\u00a0ms$/, ' ms')}. Time is paused.`, ms: 14000, cls: 'is-arrived',
        actions: [
          // a year comes once: the way on from it is another span of years, not "the next one"
          def.id === 'year'
            ? { label: 'Another 100 years', primary: true, run: () => runUntil('year', { year: yearOf(w) + 100 }) }
            : { label: 'Keep going until the next one', primary: true, run: () => runUntil(def.id, args) },
          ...(w.time.day - fromDay >= 20 * Y ? [{ label: 'Digest of these years', run: () => { const to = w.time.day; import('./digest.js').then((m) => m.openDigest?.(app, fromDay, to)).catch((e) => app.reportError('until.digest', e)); } }] : []),
          { label: 'Resume time', run: () => app.setSpeed(app.lastSpeed || 2) },
        ],
      });
    } else if (r.cancelled) {
      statusToast(app, `Stopped in ${dateText(w)} after ${span}; ${label.toLowerCase()} had not happened yet.`, 'info', { icon: 'hourglass', ms: 6000 });
    } else {
      actionToast(app, {
        icon: def.icon || 'hourglass', kicker: `${dateText(w)}`, title: `Nothing of the kind in ${span}`,
        text: `${label} did not come to pass. History stopped at the search's limit.`, ms: 9000,
        actions: [{ label: 'Search further', run: () => runUntil(def.id, args) }],
      });
    }
  }
  /** "97 years", "a month", "12 days". */
  function lapse(days) {
    const y = Math.floor(days / Y), m = Math.floor(days / 30);
    if (y >= 1) return y === 1 ? 'a year' : `${F.int(y)} years`;
    if (m >= 1) return m === 1 ? 'a month' : `${m} months`;
    return days === 1 ? 'a day' : `${Math.max(0, days)} days`;
  }
  const refSel = (ref) => (ref && ref.k != null && ref.id != null ? { kind: ref.k, id: ref.id } : null);
  const argsReady = (def, args) => (def.needs === 'settlement' ? args.sid != null && app.world.settlements[args.sid] : def.needs === 'civ' ? args.civId != null && app.world.civs[args.civId] : true);
  const getPrefCap = () => { const v = Number(app.untilCap); return CAPS.includes(v) ? v : 1000; };

  /** Arguments a condition takes from the current selection. */
  function argsFromSelection(def) {
    const sel = app.selection;
    const w = app.world;
    if (def.needs === 'settlement') return sel?.kind === 'settlement' && w.settlements[sel.id]?.alive ? { sid: sel.id } : null;
    if (def.needs === 'civ') {
      if (sel?.kind === 'civ' && w.civs[sel.id]?.alive !== false) return { civId: sel.id };
      if (sel?.kind === 'settlement' && w.settlements[sel.id]) return { civId: w.settlements[sel.id].civId };
      return null;
    }
    return {};
  }

  // ---------------------------------------------------------------------------
  // The Run until dialog (U)

  function openUntil() {
    const w = app.world;
    if (!w || app.fastForwarding || running) return;
    const sel = app.selection;
    const selCiv = sel?.kind === 'civ' ? sel.id : sel?.kind === 'settlement' ? w.settlements[sel.id]?.civId : null;
    const rows = h('div.until-list');
    let modal = null;
    const go = (id, args) => { modal?.close(); runUntil(id, args); };
    const groups = new Map();
    const row = (def, args, label, sub = '', disabled = false) => {
      const b = h('button.until-row', { type: 'button', disabled }, iconEl(def.icon || 'hourglass', { size: 20, label }), h('span.ul', null, h('b', { text: label }), sub ? h('small', { text: sub }) : null));
      b.addEventListener('click', () => go(def.id, args));
      const g = def.group || 'More';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(b);
    };
    for (const def of getUntilConditions()) {
      if (def.id === 'year') continue;
      if (def.id === 'war') {
        row(def, { scope: 'any' }, 'The next war, anywhere');
        if (selCiv != null && w.civs[selCiv]?.alive !== false) row(def, { scope: 'civ', civId: selCiv }, `A war involving ${civName(selCiv)}`, 'The selected nation');
        if (watchedCivs().size) row(def, { scope: 'watched' }, 'A war touching what you watch', 'Your people or a watched nation');
        continue;
      }
      if (def.id === 'civFalls') {
        row(def, {}, 'Any nation falls');
        if (selCiv != null && w.civs[selCiv]?.alive !== false) row(def, { civId: selCiv }, `${civName(selCiv)} falls`, 'The selected nation');
        continue;
      }
      if (def.id === 'era') {
        row(def, {}, 'Anyone reaches a new era');
        if (selCiv != null && w.civs[selCiv]?.alive !== false) row(def, { civId: selCiv }, `${civName(selCiv)} reaches a new era`, `Now in the ${F.eraName(w.civs[selCiv].tech?.era)}`);
        continue;
      }
      if (def.id === 'watched') {
        const ok = watchingAny();
        row(def, {}, conditionLabel(def, {}), ok ? '' : 'Watch a nation or place first', !ok);
        continue;
      }
      if (def.needs) {
        const a = argsFromSelection(def);
        let label = def.label;
        try { if (a) label = def.describe(a); } catch (e) { /* default label */ }
        row(def, a || {}, label, a ? '' : `Select a ${def.needs === 'civ' ? 'nation' : 'settlement'} first`, !a);
        continue;
      }
      let label = def.label;
      try { label = def.describe ? def.describe({}) : def.label; } catch (e) { /* default */ }
      row(def, {}, label);
    }
    for (const [g, bs] of groups) rows.append(h('h4.rule-head', { text: g }), ...bs);
    // a year
    const yearDef = getUntilCondition('year');
    const yIn = h('input.field', { id: 'until-year', type: 'number', min: yearOf(w) + 1, max: yearOf(w) + 5000, step: 1, value: yearOf(w) + 100, inputmode: 'numeric' });
    const yGo = h('button.btn.btn-sm', { type: 'button', text: 'Run' });
    yGo.addEventListener('click', () => { const v = Math.round(Number(yIn.value)); if (v > yearOf(w)) go('year', { year: v }); });
    yIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); yGo.click(); } });
    if (yearDef) rows.append(h('h4.rule-head', { text: 'Time' }), h('div.until-year', null, h('label', { for: 'until-year', text: 'Until the year' }), yIn, yGo));
    // the search's limit
    const capSeg = h('div.seg', { role: 'group', 'aria-label': 'Search at most' });
    for (const c of CAPS) {
      const b = h('button', { type: 'button', text: `${F.int(c)} yrs`, 'aria-pressed': String(getPrefCap() === c) });
      b.addEventListener('click', () => { app.untilCap = c; for (const x of capSeg.children) x.setAttribute('aria-pressed', String(x === b)); });
      capSeg.appendChild(b);
    }
    modal = openModal({
      title: 'Run until…',
      body: h('div.until', null,
        h('p', { text: 'History runs at full speed and stops the day it happens: the map flies there and its record opens.' }),
        rows,
        h('div.until-cap', null, h('span.muted', { text: 'Search at most' }), capSeg)),
      actions: [{ label: 'Cancel', onClick: (m) => m.close() }],
    });
  }
  app.openUntil = openUntil;

  /** A few until-buttons for the Leap modal (hud.js asks for them). */
  app.untilQuick = (close) => {
    const w = app.world;
    if (!w) return null;
    const pick = [['war', { scope: 'any' }, 'the next war'], ['historic', {}, 'something historic'], ['civFalls', {}, 'a nation falls'], ['disaster', {}, 'a great disaster']];
    const box = h('div.until-quick');
    for (const [id, args, label] of pick) {
      const def = getUntilCondition(id);
      if (!def) continue;
      const b = h('button.chip', { type: 'button' }, iconEl(def.icon, { size: 14, label }), h('span', { text: label }));
      b.addEventListener('click', () => { close?.(); runUntil(id, args); });
      box.appendChild(b);
    }
    const more = h('button.chip', { type: 'button', text: 'More…' });
    more.addEventListener('click', () => { close?.(); openUntil(); });
    box.appendChild(more);
    return box;
  };

  // ---------------------------------------------------------------------------
  // Live pause rules (Notices)

  let armed = [];     // [{ id, args, def, state }]
  app.pauseRulesArmed = true;
  function armRules() {
    armed = [];
    const w = app.world;
    if (!w) return;
    for (const r of getNotices().pauseRules) {
      const def = getUntilCondition(r.id);
      if (!def) continue;
      try { armed.push({ id: r.id, args: r.args || {}, def, state: def.arm(app, r.args || {}) }); } catch (e) { app.reportError(`until.rule.${r.id}`, e); }
    }
  }
  function testRules() {
    const w = app.world;
    if (!w || app.fastForwarding || running || app.chrono?.busy) return;
    for (const r of armed) {
      let hit = null;
      try { hit = r.def.test(w, r.state); } catch (e) { app.reportError(`until.rule.${r.id}`, e); continue; }
      if (!hit) continue;
      try { r.state = r.def.arm(app, r.args); } catch (e) { /* re-armed next time */ }
      if (app.speed === 0) continue;
      app.pause();
      const sel = hit.entry ? entrySel(app, hit.entry) : hit.ref ? refSel(hit.ref) : null;
      actionToast(app, {
        icon: r.def.icon || 'pause', kicker: `Paused · ${conditionLabel(r.def, r.args)}`, title: hit.text, ms: 12000, cls: 'is-arrived',
        actions: [
          sel || Number.isFinite(hit.x) ? { label: 'Go there', primary: true, run: () => { if (sel) app.select(sel, { focus: true }); else app.focus(hit.x, hit.y, 10); } } : null,
          { label: 'Resume', run: () => app.setSpeed(app.lastSpeed || 2) },
        ].filter(Boolean),
      });
      break;
    }
  }
  app.on('world', () => armRules());
  app.on('worldRestored', () => armRules());
  app.on('historySkipped', () => armRules());
  app.on('notices', () => armRules());
  app.on('watch', () => armRules());
  app.on('patron', () => armRules());
  app.on('tick', () => testRules());

  // ---------------------------------------------------------------------------
  // The Notices dialog

  function openNotices() {
    const n = getNotices();
    const save = () => { setNotices(n); app.emit('notices'); };
    // one control for every kind of news: shows the shared level, or "Mixed" when they differ
    const allSel = h('select.field', { id: 'notice-all' });
    const mixedOpt = h('option', { value: 'mixed', text: 'Mixed' });
    mixedOpt.disabled = true;
    allSel.appendChild(mixedOpt);
    for (const [v, lab] of NOTICE_LEVELS) allSel.appendChild(h('option', { value: String(v), text: lab }));
    const catSels = [];
    const syncAll = () => {
      const levels = new Set(Object.keys(CATEGORIES).map((c) => noticeMin(n, c)));
      mixedOpt.hidden = levels.size === 1;
      allSel.value = levels.size === 1 ? String([...levels][0]) : 'mixed';
    };
    allSel.addEventListener('change', () => {
      if (allSel.value === 'mixed') return;
      const v = Number(allSel.value);
      for (const [cat, sel] of catSels) { n.cat[cat] = v; sel.value = String(v); }
      syncAll();
      save();
    });
    const all = h('div.notice-all', null,
      h('label.notice-cat', { for: 'notice-all' }, h('span', { text: 'Every kind of news' })), allSel);
    const cats = h('div.notice-cats');
    for (const [cat, meta] of Object.entries(CATEGORIES)) {
      const id = 'notice-' + cat;
      const sel = h('select.field', { id });
      for (const [v, lab] of NOTICE_LEVELS) sel.appendChild(h('option', { value: String(v), text: lab }));
      sel.value = String(noticeMin(n, cat));
      sel.addEventListener('change', () => { n.cat[cat] = Number(sel.value); syncAll(); save(); });
      catSels.push([cat, sel]);
      cats.append(h('label.notice-cat', { for: id }, h('i.swatch', { style: { '--c': meta.color } }), h('span', { text: meta.label })), sel);
    }
    syncAll();
    const rules = h('div.notice-rules');
    for (const def of getUntilConditions().filter((d) => d.live && !d.needs)) {
      const id = 'rule-' + def.id;
      const box = h('input', { id, type: 'checkbox' });
      box.checked = n.pauseRules.some((r) => r.id === def.id);
      box.addEventListener('change', () => {
        n.pauseRules = n.pauseRules.filter((r) => r.id !== def.id);
        if (box.checked) n.pauseRules.push({ id: def.id, args: def.id === 'war' ? { scope: 'watched' } : def.id === 'civFalls' ? { scope: 'watched' } : {} });
        save();
      });
      let label = def.label;
      try { label = def.describe ? def.describe(def.id === 'war' || def.id === 'civFalls' ? { scope: 'watched' } : {}) : def.label; } catch (e) { /* default */ }
      rules.appendChild(h('label.menu-item.switch', { for: id }, box, h('span.track'), h('span', { text: label })));
    }
    const toggle = (key, label, desc) => {
      const id = 'notice-' + key;
      const box = h('input', { id, type: 'checkbox' });
      box.checked = Boolean(n[key]);
      box.addEventListener('change', () => { n[key] = box.checked; save(); });
      const el = h('label.menu-item.switch', { for: id }, box, h('span.track'), h('span', { text: label }));
      tip(el, desc);
      return el;
    };
    openModal({
      title: 'Notices',
      body: h('div.notices', null,
        h('h4.rule-head', { text: 'What reaches you' }),
        h('p.muted', { text: 'For each kind of news, the least importance that raises a notice on the map.' }),
        all,
        cats,
        toggle('quietFast', 'Quiet at Rapid and Max: only epochal news', 'At the fastest speeds only the turning points of history interrupt; the rest are counted in a digest.'),
        toggle('badgeAfterLeap', 'A leap clears the Chronicle’s unread count', 'After a leap or a run until, the badge on the Chronicle starts again from zero.'),
        h('h4.rule-head', { text: 'Pause when…' }),
        h('p.muted', { text: 'Time stops on its own when one of these happens while you watch.' }),
        rules),
      actions: [{ label: 'Done', cls: 'btn-brass', onClick: (m) => m.close() }],
    });
  }
  app.openNotices = openNotices;

  // ---------------------------------------------------------------------------
  // Keys and commands

  registerKey({ key: 'u', label: 'Run until something happens', group: 'Time', when: (a) => Boolean(a.world), run: () => openUntil() });
  registerKey({ key: 'u', shift: true, label: 'Run until the same thing happens again', group: 'Time', when: (a) => Boolean(a.world), run: () => (app.lastUntil ? runUntil(app.lastUntil.id, app.lastUntil.args) : openUntil()) });
  registerCommand({ id: 'until.open', label: 'Run until…', group: 'Time', icon: 'hourglass', keys: 'U', keywords: ['skip', 'wait', 'next', 'fast forward', 'until'], menu: true, when: (a) => Boolean(a.world), run: () => openUntil() });
  registerCommand({ id: 'until.again', label: 'Run until the same thing again', group: 'Time', icon: 'hourglass', keys: 'Shift U', when: (a) => Boolean(a.world && a.lastUntil), run: () => runUntil(app.lastUntil.id, app.lastUntil.args) });
  registerCommand({ id: 'until.war', label: 'Run until the next war', group: 'Time', icon: 'war', keywords: ['skip', 'conflict'], when: (a) => Boolean(a.world), run: () => runUntil('war', { scope: 'any' }) });
  registerCommand({ id: 'until.historic', label: 'Run until something historic', group: 'Time', icon: 'chronicle', keywords: ['skip', 'event'], when: (a) => Boolean(a.world), run: () => runUntil('historic', {}) });
  registerCommand({ id: 'notices.open', label: 'Notices…', group: 'Notices', icon: 'chronicle', keywords: ['notifications', 'alerts', 'pause', 'toasts', 'mute'], menu: true, when: () => true, run: () => openNotices() });
}
