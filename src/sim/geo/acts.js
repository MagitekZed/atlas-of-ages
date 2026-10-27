// Divine acts on geopolitics (contracts §11): two-target 'pair' tools that reach into the
// politics of the world, and the hidden 'command_army' act behind dragging an army's banner.
//
//   incite_war      (civ, civ)            forged letters and murdered envoys: the first declares
//                                         war on the second over a 'provocation' (allies called)
//   broker_peace    (civ, civ)            the war between them ends in white peace, long truce
//   forge_alliance  (civ, civ)            a defensive alliance sworn at once; a realm at war
//                                         gains its new ally in the field
//   open_route      (settlement, settlement)  a trade road over land or a sea road between them
//   command_army    (entity: army)        a vision drives the host toward a town or a spot for
//                                         half a year (flags.divineGoal)
//
// Each has a pure preview: the threads it would draw (hatred, peace, alliance, trade), the
// towns and realms it touches, a one-line forecast, or why it cannot be done here. The war,
// diplomacy and trade logic lives in war.js, diplomacy.js and trade.js; this module only
// registers the acts. Every apply is logged by the kernel (applyPairTool / applyEntityTool).

import { registerTool } from '../../core/tools.js';
import { chronicle } from '../../core/chronicle.js';
import { emitFx } from '../../core/world.js';
import { rel, areAtWar, settlementsNear } from '../../core/entities.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
// war.js imports this module (for its side effect: the tools register) and binds its own functions
// here at load. Importing war.js back would close an import cycle that the single-file bundle
// cannot evaluate (both modules wait on top-level awaits further down the graph).
const W = {};
export function bindWar(fns) { Object.assign(W, fns); }
const inciteWar = (...a) => W.inciteWar(...a), inciteRefusal = (...a) => W.inciteRefusal(...a), brokerPeace = (...a) => W.brokerPeace(...a);
const commandArmy = (...a) => W.commandArmy(...a), commandPreview = (...a) => W.commandPreview(...a), rallyAlly = (...a) => W.rallyAlly(...a);
const sideOf = (...a) => W.sideOf(...a), leaderName = (...a) => W.leaderName(...a);
import { addTreaty, ally } from './diplomacy.js';
import { routePlan, openRoute, routeValueOf } from './trade.js';
import {
  civName, peopleOf, capFirst, countWord, fmtCount, listJoin, hasTreaty, activeWarList, pickOne, civPopulation, rulerName, capitalOf,
} from './common.js';
import { civAtTile, capPoint, threadFx, toolLabel } from './previews.js';

const MAX_ALLIES = 3;   // diplomacy.js: a realm keeps at most three allies

// ---------------------------------------------------------------------------
// Picks

const civOf = (world, p) => (p && p.kind === 'civ' && world.civs[p.id]?.alive ? world.civs[p.id] : null);
const townOf = (world, p) => (p && p.kind === 'settlement' && world.settlements[p.id]?.alive ? world.settlements[p.id] : null);

function thread(world, a, b, tone) {
  const p = capPoint(world, a), q = capPoint(world, b);
  return { x0: p.x, y0: p.y, x1: q.x, y1: q.y, tone };
}

/** First-pick preview: what the source under the cursor would be. */
function firstPick(world, x, y, word) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: true, text: `Choose ${word}` };
  const civ = civAtTile(world, x, y);
  if (!civ || !civ.alive) return { ok: false, reason: 'No nation holds this land.' };
  return { ok: true, text: `${capFirst(civName(civ))} — then choose ${word}`, targets: [{ kind: 'civ', id: civ.id }] };
}

// ---------------------------------------------------------------------------
// incite_war

/** The friends each side would summon (treaty allies and overlords), for the preview's threads. */
function friendsOf(world, civ, foe) {
  const out = [];
  for (const id of civ.allies || []) { const c = world.civs[id]; if (c && c.alive && c.id !== foe.id && !(c.allies || []).includes(foe.id)) out.push(c); }
  if (civ.vassalOf != null && world.civs[civ.vassalOf]?.alive && civ.vassalOf !== foe.id) out.push(world.civs[civ.vassalOf]);
  return out;
}

function incitePreview(world, x, y, opts = {}) {
  const a = civOf(world, opts.a);
  if (!a) return firstPick(world, x, y, 'the realm it will make war on');
  const b = civOf(world, opts.b);
  if (!b) return { ok: true, text: `${capFirst(civName(a))} will declare war on…`, targets: [{ kind: 'civ', id: a.id }] };
  const why = inciteRefusal(world, a.id, b.id);
  if (why) return { ok: false, reason: why, targets: [{ kind: 'civ', id: a.id }, { kind: 'civ', id: b.id }], threads: [thread(world, a, b, 'hate')] };
  const fa = friendsOf(world, a, b), fb = friendsOf(world, b, a);
  const pa = civPopulation(world, a), pb = civPopulation(world, b);
  const odds = pa > 2.5 * pb ? `${capFirst(civName(a))} far outnumbers its foe` : pb > 2.5 * pa ? `${capFirst(civName(b))} is much the stronger` : 'an even match';
  const allies = fb.length ? `; ${listJoin(fb.slice(0, 2).map((c) => civName(c)))} would come to ${civName(b)}'s aid` : '';
  const pacts = hasTreaty(world, a.id, b.id, 'alliance') || (a.allies || []).includes(b.id) ? ' (betraying their alliance)' : hasTreaty(world, a.id, b.id, 'nap') ? ' (breaking a sworn pact of peace)' : '';
  return {
    ok: true, tone: 'bane', severity: 3,
    text: `${capFirst(civName(a))} would declare war on ${civName(b)}${pacts}: ${odds}${allies}`,
    targets: [{ kind: 'civ', id: a.id }, { kind: 'civ', id: b.id }, ...fa.concat(fb).slice(0, 6).map((c) => ({ kind: 'civ', id: c.id }))],
    threads: [thread(world, a, b, 'hate'), ...fa.slice(0, 6).map((c) => thread(world, c, b, 'war')), ...fb.slice(0, 6).map((c) => thread(world, c, a, 'war'))],
  };
}

registerTool({
  id: 'incite_war', label: 'Incite War', group: 'fate', icon: 'war', order: 70, polarity: 'bane',
  desc: 'Choose a nation, then its victim: forged letters and murdered envoys set the first at the throat of the second.',
  target: 'pair', pick: ['civ', 'civ'],
  preview: incitePreview,
  applyPair(world, a0, b0) {
    const a = civOf(world, a0), b = civOf(world, b0);
    if (!a || !b) return { ok: false, message: 'Choose two living nations.' };
    const r = inciteWar(world, a.id, b.id);
    if (!r.ok) return { ok: false, message: r.reason };
    threadFx(world, a, b, 'hate');
    const pa = capPoint(world, a), pb = capPoint(world, b);
    emitFx(world, { type: 'curse', x: pa.x, y: pa.y, r: 5, src: 'tool' });
    emitFx(world, { type: 'curse', x: pb.x, y: pb.y, r: 5, src: 'tool' });
    toolLabel(world, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, r.war.name, 'bane', 1.2);
    return { ok: true, message: `${r.war.name}: ${civName(a)} marches against ${civName(b)}.` };
  },
});

// ---------------------------------------------------------------------------
// broker_peace

/** The war between a and b (opposite sides), or null. */
function warOf(world, a, b) {
  for (const w of activeWarList(world)) if (w.active && sideOf(w, a.id) * sideOf(w, b.id) === -1) return w;
  return null;
}

function brokerPreview(world, x, y, opts = {}) {
  const a = civOf(world, opts.a);
  if (!a) return firstPick(world, x, y, 'its enemy');
  const b = civOf(world, opts.b);
  if (!b) {
    const foes = [];
    for (const w of activeWarList(world)) { const sd = sideOf(w, a.id); if (sd) for (const id of sd > 0 ? w.defenders : w.attackers) if (world.civs[id]?.alive) foes.push(world.civs[id]); }
    return foes.length
      ? { ok: true, text: `${capFirst(civName(a))} is at war with ${listJoin(foes.slice(0, 3).map((c) => civName(c)))} — choose one`, targets: [{ kind: 'civ', id: a.id }, ...foes.slice(0, 6).map((c) => ({ kind: 'civ', id: c.id }))], threads: foes.slice(0, 8).map((c) => thread(world, a, c, 'hate')) }
      : { ok: false, reason: `${capFirst(civName(a))} is at peace with everyone.`, targets: [{ kind: 'civ', id: a.id }] };
  }
  const w = warOf(world, a, b);
  if (!w) return { ok: false, reason: `${capFirst(civName(a))} and ${civName(b)} are not at war.`, targets: [{ kind: 'civ', id: a.id }, { kind: 'civ', id: b.id }] };
  const leaders = (w.attackers[0] === a.id || w.defenders[0] === a.id) && (w.attackers[0] === b.id || w.defenders[0] === b.id);
  const occ = Object.keys(w.geo?.occupied || {}).filter((sid) => { const s = world.settlements[sid]; return s && s.alive && s.civId !== w.geo.occupied[sid]; });
  const years = Math.max(1, Math.round((world.time.day - w.startDay) / DAYS_PER_YEAR));
  const text = leaders
    ? `Would end ${w.name} after ${countWord(years)} year${years === 1 ? '' : 's'} in white peace${occ.length ? `; ${countWord(occ.length)} occupied town${occ.length === 1 ? '' : 's'} handed back` : ''}, with a truce of a generation`
    : `${capFirst(civName(a.id === w.attackers[0] || a.id === w.defenders[0] ? b : a))} would make a separate peace and leave ${w.name}`;
  return { ok: true, tone: 'boon', severity: 1, text, targets: [{ kind: 'civ', id: a.id }, { kind: 'civ', id: b.id }], threads: [thread(world, a, b, 'peace')] };
}

registerTool({
  id: 'broker_peace', label: 'Broker Peace', group: 'fate', icon: 'harmony', order: 72, polarity: 'boon',
  desc: 'Choose two nations at war: their war ends at once in white peace under a long truce.',
  target: 'pair', pick: ['civ', 'civ'],
  preview: brokerPreview,
  applyPair(world, a0, b0) {
    const a = civOf(world, a0), b = civOf(world, b0);
    if (!a || !b) return { ok: false, message: 'Choose two living nations at war with each other.' };
    const r = brokerPeace(world, a.id, b.id);
    if (!r.ok) return { ok: false, message: r.reason };
    threadFx(world, a, b, 'peace');
    const pa = capPoint(world, a), pb = capPoint(world, b);
    emitFx(world, { type: 'bless', x: pa.x, y: pa.y, r: 5, src: 'tool' });
    emitFx(world, { type: 'bless', x: pb.x, y: pb.y, r: 5, src: 'tool' });
    toolLabel(world, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, r.ended ? 'Peace' : 'A separate peace', 'boon', 1.1);
    return { ok: true, message: r.ended ? `${r.war.name} is over.` : `A separate peace in ${r.war.name}.` };
  },
});

// ---------------------------------------------------------------------------
// forge_alliance

function allianceRefusal(world, a, b) {
  if (!a || !b) return 'Choose two living nations.';
  if (a.id === b.id) return 'A nation cannot ally with itself.';
  if (areAtWar(world, a.id, b.id)) return `${capFirst(civName(a))} and ${civName(b)} are at war; make peace first.`;
  if (hasTreaty(world, a.id, b.id, 'alliance')) return 'They are already allies.';
  if (a.vassalOf != null || b.vassalOf != null) return `${capFirst(civName(a.vassalOf != null ? a : b))} is a vassal and may not swear its own alliances.`;
  if ((a.allies || []).length >= MAX_ALLIES) return `${capFirst(civName(a))} already has ${countWord(MAX_ALLIES)} allies.`;
  if ((b.allies || []).length >= MAX_ALLIES) return `${capFirst(civName(b))} already has ${countWord(MAX_ALLIES)} allies.`;
  return null;
}

function alliancePreview(world, x, y, opts = {}) {
  const a = civOf(world, opts.a);
  if (!a) return firstPick(world, x, y, 'its new ally');
  const b = civOf(world, opts.b);
  if (!b) return { ok: true, text: `${capFirst(civName(a))} will swear alliance with…`, targets: [{ kind: 'civ', id: a.id }] };
  const why = allianceRefusal(world, a, b);
  if (why) return { ok: false, reason: why, targets: [{ kind: 'civ', id: a.id }, { kind: 'civ', id: b.id }], threads: [thread(world, a, b, 'alliance')] };
  const wars = [];
  for (const w of activeWarList(world)) if (w.active && ((sideOf(w, a.id) && !sideOf(w, b.id)) || (sideOf(w, b.id) && !sideOf(w, a.id)))) wars.push(w);
  const met = a.relations[b.id] || b.relations[a.id];
  return {
    ok: true, tone: 'boon', severity: 1,
    text: `${capFirst(civName(a))} and ${civName(b)} would swear to stand together${met ? '' : ', meeting for the first time'}${wars.length ? `; ${listJoin(wars.slice(0, 2).map((w) => w.name))} would draw the new ally in` : ''}`,
    targets: [{ kind: 'civ', id: a.id }, { kind: 'civ', id: b.id }], threads: [thread(world, a, b, 'alliance')],
  };
}

registerTool({
  id: 'forge_alliance', label: 'Forge Alliance', group: 'fate', icon: 'diplomacy', order: 74, polarity: 'boon',
  desc: 'Choose two nations: they swear a defensive alliance that holds for twenty years unless they come to blows. A realm at war gains its new ally in the field.',
  target: 'pair', pick: ['civ', 'civ'],
  preview: alliancePreview,
  applyPair(world, a0, b0) {
    const a = civOf(world, a0), b = civOf(world, b0);
    const why = allianceRefusal(world, a, b);
    if (why) return { ok: false, message: why };
    for (const [p, q] of [[a, b], [b, a]]) {
      const r = rel(world, p.id, q.id);
      r.opinion = Math.max(-100, Math.min(100, Math.max(r.opinion || 0, 25) + 15));
      r.trust = Math.max(r.trust ?? 0.5, 0.65);
      r.grievance = (r.grievance || 0) * 0.4;
      r.allyUntil = world.time.day + 20 * DAYS_PER_YEAR;   // a sworn alliance does not lapse for twenty years (war still ends it)
    }
    addTreaty(world, a.id, b.id, 'alliance');
    ally(a, b);
    if (world.sys.diplomacy) world.sys.diplomacy.alliances = (world.sys.diplomacy.alliances || 0) + 1;
    const joined = rallyAlly(world, a, b).concat(rallyAlly(world, b, a));
    threadFx(world, a, b, 'alliance');
    const pa = capPoint(world, a), pb = capPoint(world, b);
    emitFx(world, { type: 'bless', x: pa.x, y: pa.y, r: 4, src: 'tool' });
    emitFx(world, { type: 'bless', x: pb.x, y: pb.y, r: 4, src: 'tool' });
    toolLabel(world, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, 'Alliance', 'boon');
    const ra = rulerName(a), rb = rulerName(b);
    const text = pickOne(world, [
      `As if by a single dream, ${ra ? `${ra} of ${civName(a)}` : civName(a)} and ${rb ? `${rb} of ${civName(b)}` : civName(b)} swore eternal friendship${joined.length ? `, and ${peopleOf(joined.some((w) => sideOf(w, a.id)) ? b : a)} marched at once into ${joined[0].name}` : ''}.`,
      `Heralds of ${civName(a)} and ${civName(b)} met on the road, each bearing the same offer; the two realms became allies${joined.length ? ` and fought side by side in ${joined[0].name}` : ''}.`,
    ]);
    const cap = capitalOf(world, a);
    chronicle(world, { cat: 'divine', imp: joined.length ? 3 : 2, text, x: cap ? cap.x : pa.x, y: cap ? cap.y : pa.y, civId: a.id, sid: cap ? cap.id : null, icon: 'diplomacy', key: 'divine.forge_alliance', ref: { k: 'civ', id: b.id } });
    return { ok: true, message: `${capFirst(civName(a))} and ${civName(b)} are allies${joined.length ? `, together in ${joined[0].name}` : ''}.` };
  },
});

// ---------------------------------------------------------------------------
// open_route

/** A few threads along a path so the preview draws the road itself. */
function pathThreads(world, path, tone) {
  const W = world.W, out = [];
  const n = Math.min(10, Math.max(1, Math.round(path.length / 12)));
  let prev = path[0];
  for (let k = 1; k <= n; k++) {
    const i = path[Math.min(path.length - 1, Math.round((k * (path.length - 1)) / n))];
    out.push({ x0: prev % W, y0: (prev / W) | 0, x1: i % W, y1: (i / W) | 0, tone });
    prev = i;
  }
  return out;
}

function routePreview(world, x, y, opts = {}) {
  const a = townOf(world, opts.a);
  if (!a) {
    const s = Number.isFinite(x) && Number.isFinite(y) ? settlementsNear(world, x, y, 2.5)[0] : null;
    return s ? { ok: true, text: `${s.name} — then choose its partner`, targets: [{ kind: 'settlement', id: s.id }] } : { ok: true, text: 'Choose a town' };
  }
  const b = townOf(world, opts.b);
  if (!b) return { ok: true, text: `A road from ${a.name} to…`, targets: [{ kind: 'settlement', id: a.id }] };
  const plan = routePlan(world, a, b, { peek: true });
  if (!plan.ok) return { ok: false, reason: plan.reason, targets: [{ kind: 'settlement', id: a.id }, { kind: 'settlement', id: b.id }] };
  const v = routeValueOf(world, { id: -1, aId: a.id, bId: b.id, kind: plan.kind, path: plan.path, len: plan.path.length, comp: 1.3 });
  const km = fmtCount(Math.round(plan.path.length * 20));
  return {
    ok: true, tone: 'boon', severity: 1,
    text: `A ${plan.kind === 'sea' ? 'sea road' : 'trade road'} of ${km} km would join ${a.name} and ${b.name}${v > 0 ? `, worth about ${fmtCount(Math.max(1, Math.round(v)))} a month` : ''}`,
    targets: [{ kind: 'settlement', id: a.id }, { kind: 'settlement', id: b.id }],
    threads: pathThreads(world, plan.path, 'trade'),
  };
}

registerTool({
  id: 'open_route', label: 'Open Trade Route', group: 'fate', icon: 'trade', order: 76, polarity: 'boon',
  desc: 'Choose two towns: a trade road (or, across water, a sea road) joins them at once.',
  target: 'pair', pick: ['settlement', 'settlement'],
  preview: routePreview,
  applyPair(world, a0, b0) {
    const a = townOf(world, a0), b = townOf(world, b0);
    if (!a || !b) return { ok: false, message: 'Choose two living towns.' };
    const r = openRoute(world, a, b);
    if (!r.ok) return r;
    emitFx(world, { type: 'thread', x: a.x, y: a.y, x2: b.x, y2: b.y, tone: 'trade', src: 'tool' });
    emitFx(world, { type: 'bless', x: b.x, y: b.y, r: 3, src: 'tool' });
    toolLabel(world, (a.x + b.x) / 2, (a.y + b.y) / 2, `${fmtCount(Math.round(r.route.path.length * 20))} km`, 'boon');
    return { ok: true, message: r.message };
  },
});

// ---------------------------------------------------------------------------
// command_army (hidden: driven by dragging an army's banner, or from its record)

function armyOf(world, target) {
  if (!target || target.kind !== 'army') return null;
  return world.armies.find((a) => a.id === target.id) || null;
}

/** Enemy towns within a march, nearest first (the record's choice list). */
function goalOptions(world, target) {
  const army = armyOf(world, target);
  if (!army) return [];
  const civ = world.civs[army.civId];
  if (!civ) return [];
  const out = [];
  for (const s of settlementsNear(world, army.x, army.y, 60)) {
    if (s.civId === army.civId || !areAtWar(world, army.civId, s.civId)) continue;
    out.push([s.id, `${s.name} · ${world.civs[s.civId]?.name || ''}`.trim(), Math.hypot(s.x - army.x, s.y - army.y)]);
  }
  out.sort((p, q) => p[2] - q[2] || p[0] - q[0]);
  return out.slice(0, 12).map(([id, label]) => [id, label]);
}

/** Where a command points: a chosen town (args.sid), else the spot. */
function goalPoint(world, army, x, y, opts) {
  const sid = opts && opts.sid != null && opts.sid !== '' ? Number(opts.sid) : null;
  if (sid != null && world.settlements[sid]?.alive) return { x: world.settlements[sid].x, y: world.settlements[sid].y };
  const px = Number.isFinite(opts?.x) ? opts.x : x, py = Number.isFinite(opts?.y) ? opts.y : y;
  if (!Number.isFinite(px) || !Number.isFinite(py) || Math.hypot(px - army.x, py - army.y) < 2) return null;
  return { x: px, y: py };
}

registerTool({
  id: 'command_army', label: 'Command Army', group: 'fate', icon: 'army', order: 80, polarity: 'neutral', hidden: true,
  desc: 'Send a vision to an army: drag its banner to a town or a place, and for half a year it marches there before anything else.',
  target: 'entity', entity: { kinds: ['army'] },
  args: [{ key: 'sid', type: 'select', label: 'March on', options: goalOptions }],
  preview(world, x, y, opts = {}) {
    const army = armyOf(world, opts.target);
    if (!army) return { ok: false, reason: 'That army has left the field.' };
    const to = goalPoint(world, army, x, y, opts);
    if (!to) return { ok: true, text: `Drag ${leaderName(army) ? `${leaderName(army)}'s banner` : 'the banner'} to a town to send the host there`, targets: [{ kind: 'army', id: army.id }] };
    const pv = commandPreview(world, army, to.x, to.y);
    if (!pv.ok) return { ok: false, reason: pv.reason, targets: [{ kind: 'army', id: army.id }] };
    return {
      ok: true, tone: pv.goal.enemy ? 'bane' : 'neutral', severity: pv.goal.enemy ? 2 : 1, text: pv.text,
      targets: [{ kind: 'army', id: army.id }, ...(pv.goal.sid != null ? [{ kind: 'settlement', id: pv.goal.sid }] : [{ kind: 'tile', x: pv.goal.x, y: pv.goal.y }])],
      threads: pathThreads(world, pv.path, pv.goal.enemy ? 'war' : 'neutral'),
    };
  },
  applyEntity(world, target, args = {}) {
    const army = armyOf(world, target);
    if (!army) return { ok: false, message: 'That army has left the field.' };
    const to = goalPoint(world, army, null, null, args);
    if (!to) return { ok: false, message: 'Choose where the host should march.' };
    const r = commandArmy(world, army, to.x, to.y);
    if (r.ok) {
      emitFx(world, { type: 'thread', x: army.x, y: army.y, x2: to.x, y2: to.y, tone: 'war', src: 'tool' });
      toolLabel(world, army.x, army.y, r.days ? `${r.days} days' march` : 'A vision', 'neutral');
    }
    return r;
  },
});
