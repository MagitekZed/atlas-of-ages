// Previews and shared targeting for the geopolitics tools (contracts §11). A preview answers
// "what would this do here?" before the click: the towns and realms it would touch (targets),
// threads between the nations it would set against or beside each other, rings for its reach,
// a one-line forecast (text) and a rough toll (estimate), or why it cannot be done (reason).
//
// The same helpers pick the targets for the tool's apply and its preview, so what the hover
// promises is what the click does. Everything here is pure: no world.rng, no mutation of saved
// state (only caches), safe to call several times a second.
//
// Exports: civAtTile, discordTargets, harmonyTargets, prophetTarget, miracleTargets,
//          plagueTarget, cureTargets, divineStrain, capPoint, threadFx, toolLabel,
//          and the previews discordPreview, harmonyPreview, prophetPreview, miraclePreview,
//          plaguePreview, curePreview.

import { nearestSettlement, settlementsNear } from '../../core/entities.js';
import { emitFx } from '../../core/world.js';
import {
  civName, peopleOf, capFirst, capitalOf, countWord, fmtCount, listJoin, activeWarList, finite,
} from './common.js';

const MAX_FAITHS_TOOL = 24;   // religion.js MAX_FAITHS + 8: the prophet tool refuses beyond it

// ---------------------------------------------------------------------------
// Shared targeting

/** The nation holding tile (x, y), else the nation of the nearest town within 12 tiles. */
export function civAtTile(world, x, y) {
  const i = y * world.W + x;
  const o = world.f.owner[i];
  if (o >= 0 && world.civs[o] && world.civs[o].alive) return world.civs[o];
  const s = nearestSettlement(world, x, y, { maxDist: 12 });
  return s ? world.civs[s.civId] : null;
}

/** The capital (or origin) of a civ as a point. */
export function capPoint(world, civ) {
  const c = capitalOf(world, civ);
  return c ? { x: c.x, y: c.y, sid: c.id } : { x: civ.originX ?? 0, y: civ.originY ?? 0, sid: null };
}

/** Neighbours Discord would embitter: every bordering realm, else the first three it knows. */
export function discordTargets(world, civ) {
  const out = [];
  if (!civ || !civ.alive) return out;
  let n = 0;
  for (const k in civ.relations) {
    const b = world.civs[k];
    if (!b || !b.alive) continue;
    const r = civ.relations[k];
    if (!((r.border || 0) > 0 || n < 3)) continue;
    out.push(b);
    n++;
  }
  return out;
}

/** What Harmony would touch: every realm the nation knows, and the wars it is party to. */
export function harmonyTargets(world, civ) {
  const civs = [], wars = [];
  if (!civ || !civ.alive) return { civs, wars };
  for (const k in civ.relations) { const b = world.civs[k]; if (b && b.alive) civs.push(b); }
  for (const w of activeWarList(world)) if (w.active && (w.attackers.includes(civ.id) || w.defenders.includes(civ.id))) wars.push(w);
  return { civs, wars };
}

/** The town a prophet would rise in. */
export const prophetTarget = (world, x, y) => nearestSettlement(world, x, y, { maxDist: 10 });

/** Towns in the brush and the faith a miracle would kindle there (pure). */
export function miracleTargets(world, x, y, radius) {
  const r0 = Math.max(1, radius || 6);
  const towns = settlementsNear(world, x, y, r0);
  const score = {};
  for (const s of towns) for (const k in s.religion || {}) score[k] = (score[k] || 0) + s.religion[k] * s.population;
  let rid = null, bv = 0;
  for (const k in score) {
    const f = world.religions[+k];
    if (score[k] > bv && f && f.alive !== false) { bv = score[k]; rid = +k; }
  }
  if (rid == null) {
    const n = nearestSettlement(world, x, y, { maxDist: 40, filter: (s) => s.dominantReligion != null && world.religions[s.dominantReligion]?.alive !== false });
    if (n) rid = n.dominantReligion;
  }
  const faith = rid != null && world.religions[rid] && world.religions[rid].alive !== false ? world.religions[rid] : null;
  return { towns, faith, r: r0 };
}

/** The town a plague would strike. */
export const plagueTarget = (world, x, y) => nearestSettlement(world, x, y, { maxDist: 10 });

/** Sick towns within the brush. */
export function cureTargets(world, x, y, radius) {
  const r = Math.max(1, radius || 8);
  return { towns: settlementsNear(world, x, y, r).filter((s) => s.disease), r };
}

/**
 * The bounds of a divinely sent strain at virulence str (disease.js createPlague 'divine'):
 * { infectivity: [lo, hi], lethality: [lo, hi] } before medicine and health.
 */
export function divineStrain(str) {
  const s = finite(str) ? Math.max(0.1, str) : 1;
  const infMul = Math.min(1.6, 0.6 + 0.4 * s);
  return {
    infectivity: [1.6 * infMul, 2.6 * infMul],   // the drawn 0.9–2.6, raised to at least 1.6
    lethality: [Math.min(0.6, 0.15 * s), Math.min(0.6, 0.42 * s)],
  };
}

// ---------------------------------------------------------------------------
// Fx helpers (contracts §13: every tool-triggered effect carries src: 'tool')

/** A thread from one realm's capital to another's: tone 'hate' | 'peace' | 'trade' | 'alliance'. */
export function threadFx(world, from, to, tone) {
  const a = capPoint(world, from), b = capPoint(world, to);
  emitFx(world, { type: 'thread', x: a.x, y: a.y, x2: b.x, y2: b.y, tone, src: 'tool' });
}

/** A floating label over the map. tone: 'bane' | 'boon' | 'neutral'. */
export function toolLabel(world, x, y, text, tone = 'neutral', size = 1) {
  emitFx(world, { type: 'label', x, y, text: String(text), tone, size, src: 'tool' });
}

// ---------------------------------------------------------------------------
// Previews

const towns = (list) => list.map((s) => ({ kind: 'settlement', id: s.id }));

export function discordPreview(world, x, y) {
  const civ = civAtTile(world, x, y);
  if (!civ || !civ.alive) return { ok: false, reason: 'No nation holds this land.' };
  const list = discordTargets(world, civ);
  const a = capPoint(world, civ);
  if (!list.length) return { ok: false, reason: `${capFirst(civName(civ))} has no neighbours to quarrel with yet.`, targets: [{ kind: 'civ', id: civ.id }] };
  const allied = list.filter((b) => (civ.allies || []).includes(b.id)).length;
  const pacts = list.filter((b) => (civ.relations[b.id]?.treaties || []).some((t) => t === 'nap' || t === 'trade')).length;
  const names = list.slice(0, 3).map((b) => civName(b));
  const bits = [];
  if (allied) bits.push(`${countWord(allied)} alliance${allied === 1 ? '' : 's'} broken`);
  if (pacts) bits.push(`${countWord(pacts)} pact${pacts === 1 ? '' : 's'} torn up`);
  return {
    ok: true, tone: 'bane', severity: 2,
    text: `Would turn ${listJoin(names)}${list.length > 3 ? ` and ${countWord(list.length - 3)} more` : ''} against ${civName(civ)}${bits.length ? ` (${listJoin(bits)})` : ''}`,
    targets: [{ kind: 'civ', id: civ.id }, ...list.slice(0, 8).map((b) => ({ kind: 'civ', id: b.id }))],
    threads: list.slice(0, 16).map((b) => { const p = capPoint(world, b); return { x0: a.x, y0: a.y, x1: p.x, y1: p.y, tone: 'hate' }; }),
  };
}

export function harmonyPreview(world, x, y) {
  const civ = civAtTile(world, x, y);
  if (!civ || !civ.alive) return { ok: false, reason: 'No nation holds this land.' };
  const { civs, wars } = harmonyTargets(world, civ);
  const a = capPoint(world, civ);
  const foes = new Set();
  for (const w of wars) for (const id of w.attackers.includes(civ.id) ? w.defenders : w.attackers) foes.add(id);
  const text = wars.length
    ? `Would end ${countWord(wars.length)} war${wars.length === 1 ? '' : 's'} (${listJoin(wars.slice(0, 2).map((w) => w.name))}) and soften ${countWord(civs.length)} rivalries`
    : civs.length ? `Would bring goodwill between ${civName(civ)} and ${countWord(civs.length)} realm${civs.length === 1 ? '' : 's'}` : `${capFirst(civName(civ))} knows no other people yet`;
  return {
    ok: true, tone: 'boon', severity: 1, text,
    targets: [{ kind: 'civ', id: civ.id }],
    threads: civs.slice(0, 16).map((b) => { const p = capPoint(world, b); return { x0: a.x, y0: a.y, x1: p.x, y1: p.y, tone: foes.has(b.id) ? 'peace' : 'alliance' }; }),
  };
}

export function prophetPreview(world, x, y) {
  const s = prophetTarget(world, x, y);
  if (!s) return { ok: false, reason: 'No town lies close enough to hear a prophet.' };
  const alive = world.religions.filter((r) => r.alive !== false).length;
  if (alive >= MAX_FAITHS_TOOL) return { ok: false, reason: 'The world already teems with gods.', targets: [{ kind: 'settlement', id: s.id }] };
  const dom = s.dominantReligion != null ? world.religions[s.dominantReligion] : null;
  const civ = world.civs[s.civId];
  return {
    ok: true, tone: 'boon', severity: 1,
    text: `A prophet would rise in ${s.name}${dom && dom.alive !== false ? `, a stronghold of ${dom.name}` : ''}, and the new faith would take ${civ ? `the hearts of ${peopleOf(civ)}` : 'its first converts'} first`,
    targets: [{ kind: 'settlement', id: s.id }],
    rings: [{ x: s.x, y: s.y, r: 8, tone: 'boon' }],
  };
}

export function miraclePreview(world, x, y, opts) {
  const { towns: list, faith, r } = miracleTargets(world, x, y, opts && opts.radius);
  if (!list.length) return { ok: false, reason: 'There is no one here to witness a miracle.', rings: [{ x, y, r, tone: 'neutral' }] };
  if (!faith) return { ok: false, reason: 'No faith is near enough to kindle; raise a prophet first.', rings: [{ x, y, r, tone: 'neutral' }] };
  const people = list.reduce((a, s) => a + Math.max(0, s.population), 0);
  return {
    ok: true, tone: 'boon', severity: 1,
    text: `Fervour for ${faith.name} would sweep ${countWord(list.length)} town${list.length === 1 ? '' : 's'} (${fmtCount(people)} people)`,
    targets: towns(list.slice(0, 24)), rings: [{ x, y, r, tone: 'boon' }],
    estimate: { towns: list.length },
  };
}

export function plaguePreview(world, x, y, opts) {
  const s = plagueTarget(world, x, y);
  if (!s) return { ok: false, reason: 'No town lies close enough to sicken.' };
  const str = finite(opts && opts.strength) ? opts.strength : 1;
  const cur = s.disease ? world.plagues[s.disease.pid] : null;
  if (cur && cur.active) {
    return { ok: true, tone: 'bane', severity: 2, text: `${capFirst(cur.name)} already grips ${s.name}; it would rage anew`, targets: [{ kind: 'settlement', id: s.id }], rings: [{ x: s.x, y: s.y, r: 6, tone: 'bane' }] };
  }
  const k = divineStrain(str);
  const civ = world.civs[s.civId];
  const med = Math.max(0, Math.min(1, finite(civ?.mods?.medicine) ? civ.mods.medicine : 1));
  const lethal = (k.lethality[0] + k.lethality[1]) / 2 * med * (world.params.plagueLethality ?? 1);
  const word = lethal >= 0.25 ? 'a great killer' : lethal >= 0.12 ? 'deadly' : lethal >= 0.05 ? 'a grim sickness' : 'a mild fever';
  // towns within the first reach of its spread
  const near = settlementsNear(world, s.x, s.y, 6).filter((t) => t !== s);
  const pop = Math.max(0, s.population);
  const lo = Math.round(pop * 0.3 * k.lethality[0] * med), hi = Math.round(pop * 0.75 * k.lethality[1] * med);
  return {
    ok: true, tone: 'bane', severity: lethal >= 0.25 ? 4 : lethal >= 0.12 ? 3 : 2,
    text: `Would loose ${word} on ${s.name} (${fmtCount(pop)} people)${near.length ? `, within reach of ${countWord(near.length)} town${near.length === 1 ? '' : 's'} nearby` : ''}`,
    targets: [{ kind: 'settlement', id: s.id }, ...towns(near.slice(0, 8))],
    rings: [{ x: s.x, y: s.y, r: 6, tone: 'bane' }],
    estimate: { deaths: [lo, Math.max(lo, hi)], towns: 1 + near.length },
  };
}

export function curePreview(world, x, y, opts) {
  const { towns: list, r } = cureTargets(world, x, y, opts && opts.radius);
  if (!list.length) return { ok: false, reason: 'No sickness stirs here.', rings: [{ x, y, r, tone: 'neutral' }] };
  const names = new Set();
  for (const s of list) { const p = world.plagues[s.disease.pid]; if (p) names.add(p.name); }
  return {
    ok: true, tone: 'boon', severity: 1,
    text: `Would lift ${listJoin([...names].slice(0, 2))} from ${countWord(list.length)} town${list.length === 1 ? '' : 's'}`,
    targets: towns(list.slice(0, 24)), rings: [{ x, y, r, tone: 'boon' }], estimate: { towns: list.length },
  };
}
