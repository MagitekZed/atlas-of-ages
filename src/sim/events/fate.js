// Fate: see what might happen to a town or realm, then nudge or invoke it. The 'fate' entity
// tool (group fate) works on a settlement or a civ:
//   preview  → cards: every event that could happen there, with its chance over the next
//              decade (from the decks' pure weight functions: no rng, no writes) and what it
//              would do; a realm's cards include incidents with each neighbour
//   nudge    → the event's weight ×5 for 20 years, kept as a settlement/civ effect
//              'fate:<id>' (deterministic and saved); the engine reads it
//   invoke   → the event happens now, chronicled under Divine Hand; once per subject per 5 years
// eligibleEvents(world, subject) is the published, pure query behind the cards.
// Every apply goes through the kernel's logged applyEntityTool, so undo and rewind replay it.
// applyEntity args: { card: '<def id>' | '<pair def id>@<other civ id>', action: 'nudge'|'invoke' }.

import { registerTool } from '../../core/tools.js';
import { addEffect, getEffect } from '../../core/effects.js';
import { emitFx } from '../../core/world.js';
import { chronicle } from '../../core/chronicle.js';
import { getEvent } from '../../core/events.js';
import { DAYS_PER_YEAR } from '../../core/constants.js';
import { EVENT_FAMILIES, NUDGE_MUL, NUDGE_YEARS, INVOKE_GAP_YEARS } from './data.js';
import { eligibleFor, invokeOn, evState } from './engine.js';
import { SUBJ } from './heat.js';
import { civName } from './prose.js';

const Y = DAYS_PER_YEAR;
const subjKey = (t) => (t.kind === 'settlement' ? SUBJ.town(t.id) : t.kind === 'civ' ? SUBJ.realm(t.id) : t.kind === 'pair' ? SUBJ.pair(t.a, t.b) : null);
const entityOf = (world, t) => (t.kind === 'settlement' ? world.settlements[t.id] : t.kind === 'civ' ? world.civs[t.id] : null);

/**
 * What could happen to a subject ({ kind: 'settlement'|'civ', id } or { kind: 'pair', a, b }):
 * [{ id, label, family, familyLabel, color, scale, imp, p (this year), pDecade, effects: [string],
 *    nudged, restingUntil }] sorted by pDecade. Pure.
 */
export function eligibleEvents(world, subject) {
  if (!world || !subject) return [];
  const ent = subject.kind === 'pair' ? null : entityOf(world, subject);
  const day = world.time.day;
  return eligibleFor(world, subject).map((o) => {
    const d = o.def;
    const fam = EVENT_FAMILIES[d.family] || {};
    const nudge = ent ? getEffect(world, subject, 'fate:' + d.id) : null;
    return {
      id: d.id, label: d.label || d.id, family: d.family, familyLabel: fam.label || d.family, color: fam.color || '#999',
      scale: d.scale, imp: d.imp, p: o.p, pDecade: o.pDecade, effects: Array.isArray(d.hint) ? d.hint.slice() : [],
      nudged: Boolean(nudge), nudgedUntil: nudge ? nudge.until : null, restingUntil: o.until > day ? o.until : null,
    };
  });
}

function canInvoke(world, subject) {
  const last = evState(world).inv[subjKey(subject)];
  return last == null || world.time.day - last >= INVOKE_GAP_YEARS * Y;
}

/** Resolve what a click or an Inspector section means: an explicit target, else the tile. */
function resolveTarget(world, x, y, opts) {
  const t = opts && (opts.target || opts.entity);
  if (t && (t.kind === 'settlement' || t.kind === 'civ') && Number.isFinite(t.id)) return { kind: t.kind, id: t.id };
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const i = Math.floor(y) * world.W + Math.floor(x);
  if (i < 0 || i >= world.N) return null;
  const sid = world.f.settle[i];
  if (sid >= 0) return { kind: 'settlement', id: sid };
  const own = world.f.owner[i];
  return own >= 0 ? { kind: 'civ', id: own } : null;
}

const pct = (p) => (p >= 0.995 ? '>99%' : p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`);

function cardsFor(world, target) {
  const out = [];
  const inv = canInvoke(world, target);
  const add = (e, idSuffix = '', withName = null) => {
    out.push({
      id: e.id + idSuffix, label: withName ? `${e.label} — ${withName}` : e.label, p: e.pDecade,
      pText: `${pct(e.pDecade)} this decade`, family: e.family, familyLabel: e.familyLabel, color: e.color, nudged: e.nudged,
      effects: e.effects.concat(e.restingUntil ? [`resting until Year ${Math.floor(e.restingUntil / Y)}`] : []),
      actions: [
        { id: 'nudge', label: e.nudged ? 'Nudged' : `Nudge ×${NUDGE_MUL}`, disabled: e.nudged || Boolean(e.restingUntil) },
        { id: 'invoke', label: 'Invoke now', disabled: !inv },
      ],
    });
  };
  for (const e of eligibleEvents(world, target)) add(e);
  if (target.kind === 'civ') {
    const civ = world.civs[target.id];
    const ns = Object.keys(civ.relations).map(Number).filter((k) => world.civs[k]?.alive && civ.relations[k].border > 0).sort((a, b) => a - b).slice(0, 4);
    for (const o of ns) {
      const pair = { kind: 'pair', a: Math.min(civ.id, o), b: Math.max(civ.id, o) };
      for (const e of eligibleEvents(world, pair).slice(0, 3)) add(e, '@' + o, civName(world.civs[o]));
    }
  }
  out.sort((a, b) => b.p - a.p || (a.id < b.id ? -1 : 1));
  return out.slice(0, 12);
}

function preview(world, x, y, opts = {}) {
  const t = resolveTarget(world, x, y, opts);
  if (!t) return { ok: false, reason: 'Choose a town or a realm.' };
  const ent = entityOf(world, t);
  if (!ent || ent.alive === false) return { ok: false, reason: 'Nothing lives there for fate to touch.' };
  const cards = cardsFor(world, t);
  const name = t.kind === 'civ' ? civName(ent) : ent.name;
  const rings = t.kind === 'settlement' ? [{ x: ent.x, y: ent.y, r: 2, tone: 'neutral' }] : [];
  return {
    ok: cards.length > 0, reason: cards.length ? undefined : `The threads of ${name} are quiet: nothing is ripe to happen there now.`,
    text: cards.length ? `The threads of ${name}: ${cards.length} fates within reach` : undefined,
    targets: [t], rings, cards,
  };
}

function applyEntity(world, target, args = {}) {
  const t = target && (target.kind === 'settlement' || target.kind === 'civ') ? { kind: target.kind, id: target.id } : null;
  const ent = t ? entityOf(world, t) : null;
  if (!ent || ent.alive === false) return { ok: false, message: 'There is nothing there for fate to touch.' };
  // the Inspector's fate cards send { card, action }; scripts may send { event, action }
  const card = args.card && typeof args.card === 'object' ? args.card.id : args.card;
  const raw = String(card || args.event || args.id || '');
  const [id, other] = raw.split('@');
  const d = getEvent(id);
  if (!d) return { ok: false, message: 'Fate has no such thread.' };
  let subject = t;
  if (d.scale === 'pair') {
    const o = Number(other);
    if (t.kind !== 'civ' || !Number.isFinite(o) || !world.civs[o]?.alive) return { ok: false, message: 'That thread runs between two realms: choose both.' };
    subject = { kind: 'pair', a: Math.min(t.id, o), b: Math.max(t.id, o) };
  }
  const name = t.kind === 'civ' ? civName(ent) : ent.name;
  const x = t.kind === 'settlement' ? ent.x : world.settlements[ent.capitalId]?.x ?? ent.originX;
  const y = t.kind === 'settlement' ? ent.y : world.settlements[ent.capitalId]?.y ?? ent.originY;
  const action = args.action === 'invoke' ? 'invoke' : 'nudge';
  if (action === 'nudge') {
    if (subject.kind === 'pair') return { ok: false, message: 'Only a town or a realm can be nudged; invoke the incident instead.' };
    if (!eligibleEvents(world, subject).some((e) => e.id === id)) return { ok: false, message: `${d.label || id} cannot happen in ${name} now.` };
    addEffect(world, t, { k: 'fate:' + id, until: world.time.day + NUDGE_YEARS * Y, m: {}, label: `Fate: ${d.label || id}` });
    chronicle(world, {
      cat: 'divine', imp: 1, x, y, sid: t.kind === 'settlement' ? t.id : null, civId: t.kind === 'civ' ? t.id : ent.civId,
      text: `An unseen hand tilted the fate of ${name} toward ${String(d.label || id).toLowerCase()}.`,
      ref: { k: t.kind, id: t.id }, key: 'event.nudge', tags: ['fate'],
    });
    emitFx(world, { type: 'swirl', x, y, r: 1.5, src: 'tool' });
    return { ok: true, message: `The threads of ${name} lean toward ${String(d.label || id).toLowerCase()} for ${NUDGE_YEARS} years.` };
  }
  if (!canInvoke(world, t)) return { ok: false, message: `Fate has been asked of ${name} too lately; let ${INVOKE_GAP_YEARS} years pass.` };
  const r = invokeOn(world, subject, id);
  if (!r.ok) return r;
  evState(world).inv[subjKey(t)] = world.time.day;
  emitFx(world, { type: 'divine', x, y, r: 2, src: 'tool' });
  return { ok: true, message: `${d.label || id}: ${name}.` };
}

registerTool({
  id: 'fate', label: 'Fate', group: 'fate', icon: 'fate', order: 5, target: 'entity', entity: { kinds: ['settlement', 'civ'] },
  polarity: 'neutral', radius: 0,
  desc: 'Read the threads of a town or realm: see what may befall it this decade, then nudge an event (×5 for 20 years) or make it happen now.',
  preview, applyEntity,
});
