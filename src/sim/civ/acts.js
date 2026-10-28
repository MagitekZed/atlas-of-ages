// Divine acts on rulers, realms and towns: the entity and pair tools of the Divine Hand
// (contracts §11). Each is applied through the kernel's logged applyEntityTool /
// applyPairTool (so undo and rewind replay it), writes one Divine Hand chronicle entry with a
// ref (key 'divine.<id>'), and answers with the intervention fx kit (bless, curse, label,
// thread, all src 'tool').
//
// Entity tools (target { kind, id }; kinds per tool):
//   bless_ruler        civ | ruler    a virtue given, a vice lifted, +legitimacy, a long life
//   curse_ruler        civ | ruler    madness or cruelty, death stalks them, "the Accursed"
//   smite_ruler        civ | ruler    death now, through the normal succession (crises and wars)
//   grant_heir         civ | ruler    a child is born (or the heir sealed): no crisis next time
//   gift_tech          civ | settlement   args.techId: a technology whose prerequisites are met
//   commission_wonder  settlement     args.kind: a wonder raised in a single night
//   rename             settlement | civ | religion | feature   args.name (1–32 plain characters)
//   depose             civ | ruler    the ruler is cast down and a new one takes power
// Pair tools:
//   cede_town          settlement → civ    the town changes hands (owner chain code 'divine')
//   send_settlers      settlement → tile   settlers found a town there (colonize)
//   arrange_marriage   civ ↔ civ           a royal match: claims on each other's crowns
// Published (contracts §12): colonize(world, fromSid, x, y), depose(world, civ, how).

import { registerTool } from '../../core/tools.js';
import { emit as emitHook } from '../../core/hooks.js';
import { transferSettlement } from '../../core/entities.js';
import { emitFx, bumpVersion } from '../../core/world.js';
import { sliceLike, takePeople, addPeople } from '../../core/cohorts.js';
import { adjectiveOf } from '../../core/names.js';
import { discover, techDef, giftableTechs, isArcane } from './tech.js';
import { completeWonder } from './buildings.js';
import { styleName } from './government.js';
import { succession, overthrow, syncRulerDisplay } from './rulers.js';
import { foundSettlement } from './expansion.js';
import { arrangeMarriage, unionPartner, houseOf } from './dynasty.js';
import { fin, record, rulerRef } from './state.js';
import { theName, TheName, rulerName, rulerShort, fmtInt, pick } from './prose.js';
import { ERAS } from '../../core/constants.js';
import { makePerson } from '../../core/names.js';
import { personOfRuler, spouseOf, marryNoble, kinBorn, syncSpouse, syncHeir } from './kin.js';
import {
  resolveTarget, blessPlan, cursePlan, renamePlan, settlersPlan, cedePlan, wonderChoices, wonderLabel,
  previewBless, previewCurse, previewSmite, previewGrantHeir, previewGiftTech, previewCommission, previewRename,
  previewDepose, previewCede, previewSettlers, previewMarriage,
} from './previews.js';

const VIRTUE_WORDS = {
  wise: 'grew wise beyond the years of any ruler before', just: 'judged justly ever after', brilliant: 'saw to the heart of every matter',
  charismatic: 'was loved by the people as never before', generous: 'opened the treasury to the poor', industrious: 'laboured from dawn to dusk for the realm',
  cautious: 'weighed every step of state with care',
};
const he = (r) => (r.gender === 'f' ? 'she' : 'he');
const capOf = (world, civ) => (civ && civ.capitalId != null ? world.settlements[civ.capitalId] || null : null);
/** Where the act lands on the map: the town, else the realm's capital, else its origin. */
function spot(world, civ, s = null) {
  if (s) return { x: s.x, y: s.y };
  const cap = capOf(world, civ);
  return cap ? { x: cap.x, y: cap.y } : { x: fin(civ?.originX), y: fin(civ?.originY) };
}
const fx = (world, o) => emitFx(world, { ...o, src: 'tool' });
const counted = (world) => { const st = world.sys.civ; if (st) st.counters.divine = fin(st.counters.divine) + 1; };
const refuse = (p) => ({ ok: false, message: p?.reason || 'Nothing happened.' });

/** The ruler a ruler act touches (and its copy in a personal union). */
function rulerOf(world, target) {
  const t = resolveTarget(world, target);
  if (!t || !t.civ || !t.civ.alive || !t.ruler) return null;
  return { civ: t.civ, ruler: t.ruler };
}
/** Apply fn to the ruler and to the same person's other crown in a personal union. */
function bothCrowns(world, civ, fn) {
  fn(civ, civ.ruler);
  const other = unionPartner(world, civ, false) || unionPartner(world, civ, true);
  if (other && other.ruler && other.ruler.id === civ.ruler.id) fn(other, other.ruler);
}

// ---------------------------------------------------------------------------
// Published

/**
 * Settlers from town fromSid found a new town at (x, y) (the Send Settlers act; the war and
 * events packages may call it). opts: { divine (a Divine Hand entry), cause }.
 * Returns { ok, s?, message }.
 */
export function colonize(world, fromSid, x, y, opts = {}) {
  const from = world.settlements[fromSid];
  const p = settlersPlan(world, from, x, y);
  if (!p.ok) return { ok: false, message: p.reason };
  const civ = p.civ;
  const sl = sliceLike(from);
  takePeople(world, from, p.n, 'movers', sl, civ);
  from.flags.lastSettler = world.time.day;
  const s = foundSettlement(world, civ, p.x, p.y, p.n * 0.95, { from, overseas: p.overseas, divine: Boolean(opts.divine), cause: opts.cause ?? null, cohorts: sl });
  if (!s) { addPeople(world, from, sl, p.n); return { ok: false, message: 'The settlers could not take root there.' }; }
  if (civ.ruler?.deeds && p.overseas) civ.ruler.deeds.colonies = fin(civ.ruler.deeds.colonies) + 1;
  return { ok: true, s, message: `Settlers from ${from.name} founded ${s.name}.` };
}

/**
 * Cast down a realm's ruler (how: 'divine' | 'coup' | 'revolution'): a new ruler (and, in a
 * hereditary realm, a new house) takes power; the government stays. Returns { prev, ruler } or null.
 */
export function depose(world, civ, how = 'divine') {
  if (!civ || !civ.alive || !civ.ruler) return null;
  return overthrow(world, civ, null, how);
}

// ---------------------------------------------------------------------------
// Rulers

registerTool({
  id: 'bless_ruler', label: 'Bless Ruler', group: 'fate', icon: 'star', order: 60, target: 'entity', hidden: true, polarity: 'boon',
  entity: { kinds: ['civ', 'ruler'] },
  desc: 'Grant a ruler a virtue, lift a vice, and the long life of heaven’s favour.',
  preview: previewBless,
  applyEntity(world, target) {
    const pv = previewBless(world, null, null, { target });
    if (!pv.ok) return refuse(pv);
    const { civ, ruler } = rulerOf(world, target);
    const plan = blessPlan(ruler);
    bothCrowns(world, civ, (c, r) => {
      r.traits = plan.traits.slice();
      r.flags = { ...(r.flags || {}), blessed: true };
      if (r.flags.cursed) delete r.flags.cursed;
      c.legitimacy = Math.min(1, fin(c.legitimacy, 0.6) + 0.15);
      syncRulerDisplay(r);
    });
    counted(world);
    const p = spot(world, civ);
    const virtue = plan.add ? plan.add : null;
    const his = ruler.gender === 'f' ? 'her' : 'his', him = ruler.gender === 'f' ? 'her' : 'him';
    const vice = plan.remove ? (plan.remove === 'mad' ? 'madness' : `${plan.remove} temper`) : null;
    const grew = virtue ? VIRTUE_WORDS[virtue] || `grew ${virtue}` : null;
    const text = pick(world, [
      `A light was seen over ${capOf(world, civ)?.name || 'the palace'}, and ${rulerName(ruler)} of ${theName(civ)} rose from prayer a changed ruler${vice ? `: the ${vice} was gone` : ''}${grew ? `${vice ? ', and' : ':'} ${he(ruler)} ${grew}` : ''}. The people said heaven had touched the crown.`,
      `${rulerName(ruler)} of ${theName(civ)} was blessed by the gods${vice ? `; ${his} ${vice} left ${him}` : ''}${grew ? `${vice ? ', and' : ', and'} ${he(ruler)} ${grew}` : ''}.`,
    ]);
    const e = record(world, { cat: 'divine', imp: 3, key: 'divine.bless_ruler', civ, ref: rulerRef(civ, civ.ruler), tags: ['blessing'], text });
    fx(world, { type: 'bless', x: p.x, y: p.y, r: 3, civId: civ.id });
    fx(world, { type: 'label', x: p.x, y: p.y, text: virtue ? `+${cap(virtue)}` : 'Blessed', tone: 'boon', size: 1.1 });
    return { ok: true, message: `${rulerName(ruler)} is blessed${virtue ? ` and now ${virtue}` : ''}.`, seq: e.seq };
  },
});

registerTool({
  id: 'curse_ruler', label: 'Curse Ruler', group: 'fate', icon: 'hatred', order: 61, target: 'entity', hidden: true, polarity: 'bane',
  entity: { kinds: ['civ', 'ruler'] },
  desc: 'Lay a curse on a ruler: madness or cruelty, and death close behind; in a Mythic world, or a wound that wastes the land.',
  // in a Mythic world the curse may instead be the Wasting (myth/sickness.js, through the handWound hook)
  args: [{ key: 'curse', type: 'select', label: 'The curse', options: (world) => (fin(world.params.mythLevel) >= 2 ? [['mind', 'Madness and cruelty'], ['wound', 'A wound that wastes the land']] : []) }],
  preview: previewCurse,
  applyEntity(world, target, args = {}) {
    if (args && args.curse === 'wound' && fin(world.params.mythLevel) >= 2) return woundAct(world, target);
    const pv = previewCurse(world, null, null, { target });
    if (!pv.ok) return refuse(pv);
    const { civ, ruler } = rulerOf(world, target);
    const plan = cursePlan(ruler);
    bothCrowns(world, civ, (c, r) => {
      r.traits = plan.traits.slice();
      r.flags = { ...(r.flags || {}), cursed: true };
      if (r.flags.blessed) delete r.flags.blessed;
      c.legitimacy = Math.max(0, fin(c.legitimacy, 0.6) - 0.1);
      c.stability = Math.max(0, fin(c.stability, 0.6) - 0.05);
      syncRulerDisplay(r);
    });
    counted(world);
    const p = spot(world, civ);
    const word = plan.add === 'mad' ? 'madness' : plan.add === 'cruel' ? 'cruelty' : 'a creeping dread of plots';
    const text = pick(world, [
      `Ravens settled on the roofs of ${capOf(world, civ)?.name || 'the palace'} and would not leave: a curse had fallen on ${rulerName(ruler)} of ${theName(civ)}, and ${word} took hold of ${ruler.gender === 'f' ? 'her' : 'him'}.`,
      `${rulerName(ruler)} of ${theName(civ)} woke from a black dream changed; ${word} gripped the throne, and the court whispered of a curse.`,
    ]);
    const e = record(world, { cat: 'divine', imp: 3, key: 'divine.curse_ruler', civ, ref: rulerRef(civ, civ.ruler), tags: ['curse'], text });
    fx(world, { type: 'curse', x: p.x, y: p.y, r: 3, civId: civ.id });
    fx(world, { type: 'label', x: p.x, y: p.y, text: plan.add === 'mad' ? 'Madness' : plan.add === 'cruel' ? 'Cruelty' : 'Dread', tone: 'bane', size: 1.1 });
    return { ok: true, message: `A curse lies on ${rulerName(ruler)}.`, seq: e.seq };
  },
});

/** The hand's Wasting: a wound that will not close, and the land fails with it (myth/sickness.js). */
function woundAct(world, target) {
  const t = rulerOf(world, target);
  if (!t) return { ok: false, message: 'Choose a nation or its ruler.' };
  const { civ, ruler } = t;
  if ((ruler.flags && ruler.flags.wound) || world.sys.myth?.sick?.wast?.[civ.id]) return { ok: false, message: `${rulerName(ruler)} already bears a wound that will not close.` };
  emitHook(world, 'handWound', civ);
  if (!(ruler.flags && ruler.flags.wound)) return { ok: false, message: 'The curse found no purchase.' };
  counted(world);
  const p = spot(world, civ);
  fx(world, { type: 'curse', x: p.x, y: p.y, r: 3, civId: civ.id });
  fx(world, { type: 'label', x: p.x, y: p.y, text: 'The Wasting', tone: 'bane', size: 1.1 });
  return { ok: true, message: `A wound that will not close lies on ${rulerName(ruler)}; in a year or two the land will begin to fail.` };
}

registerTool({
  id: 'smite_ruler', label: 'Smite Ruler', group: 'fate', icon: 'lightning', order: 62, target: 'entity', hidden: true, polarity: 'bane',
  entity: { kinds: ['civ', 'ruler'] },
  desc: 'Strike a ruler down. The crown passes by custom, and a crisis or a war may follow.',
  danger: () => true,
  preview: previewSmite,
  applyEntity(world, target) {
    const pv = previewSmite(world, null, null, { target });
    if (!pv.ok) return refuse(pv);
    const { civ, ruler } = rulerOf(world, target);
    const name = rulerName(ruler);
    const p = spot(world, civ);
    counted(world);
    const e = succession(world, civ, 'smitten', {}, { cat: 'divine', key: 'divine.smite_ruler', imp: 3, tags: ['smitten'] });
    fx(world, { type: 'lightning', x: p.x, y: p.y, r: 1 });
    fx(world, { type: 'curse', x: p.x, y: p.y, r: 3.5, civId: civ.id });
    fx(world, { type: 'label', x: p.x, y: p.y, text: `${ruler.name} †`, tone: 'bane', size: 1.2 });
    const next = civ.alive ? civ.ruler : null;
    return { ok: true, message: next && next !== ruler ? `${name} is dead; ${rulerName(next)} rules ${theName(civ)}.` : `${name} is dead.`, seq: e ? e.seq : null };
  },
});

registerTool({
  id: 'grant_heir', label: 'Grant an Heir', group: 'fate', icon: 'crown', order: 63, target: 'entity', hidden: true, polarity: 'boon',
  entity: { kinds: ['civ', 'ruler'] },
  desc: 'Give a royal house an heir: the next succession cannot fall into crisis.',
  preview: previewGrantHeir,
  applyEntity(world, target) {
    const pv = previewGrantHeir(world, null, null, { target });
    if (!pv.ok) return refuse(pv);
    const { civ, ruler } = rulerOf(world, target);
    let born = null;
    if (!ruler.heir) {
      // a child of the ruler and their consort (kin.js), married first if need be
      const me = personOfRuler(world, civ, ruler);
      if (me) {
        const sp = spouseOf(world, me) || marryNoble(world, civ, me);
        const [w, h] = me.g === 'f' ? [me, sp] : [sp, me];
        kinBorn(world, civ, w, h);
        syncSpouse(world, civ, ruler, me);
        syncHeir(world, civ);
      }
      if (!ruler.heir) {
        const gender = world.rng.chance(0.5) ? 'm' : 'f';
        ruler.heir = { name: makePerson(civ.language, world.rng), gender, born: world.time.day, relation: gender === 'f' ? 'daughter' : 'son' };
      }
      born = ruler.heir;
    }
    civ.flags.heirSecured = true;
    civ.legitimacy = Math.min(1, fin(civ.legitimacy, 0.6) + 0.05);
    counted(world);
    const p = spot(world, civ);
    const cap = capOf(world, civ);
    const text = born
      ? pick(world, [
        `Under a sky of falling stars, a ${born.relation}, ${born.name}, was born to ${rulerName(ruler)} at ${cap ? cap.name : 'the palace'}; the priests declared the line ${houseOf(civ)} secured by heaven.`,
        `Long childless, ${rulerName(ruler)} of ${theName(civ)} was granted an heir at last: the ${born.relation} ${born.name}, whose birth the court called a miracle.`,
      ])
      : `Heaven set its seal on ${ruler.heir.name}, heir of ${rulerName(ruler)} of ${theName(civ)}; no rival would dare dispute the succession.`;
    const e = record(world, { cat: 'divine', imp: 2, key: 'divine.grant_heir', civ, ref: rulerRef(civ, ruler), tags: ['heir'], text });
    fx(world, { type: 'bless', x: p.x, y: p.y, r: 2.5, civId: civ.id });
    fx(world, { type: 'label', x: p.x, y: p.y, text: born ? `An heir: ${born.name}` : 'Heir secured', tone: 'boon' });
    return { ok: true, message: born ? `${born.name} is born, heir of ${rulerShort(ruler)}.` : `The heir ${ruler.heir.name} is secured.`, seq: e.seq };
  },
});

registerTool({
  id: 'depose', label: 'Depose', group: 'fate', icon: 'unrest', order: 64, target: 'entity', hidden: true, polarity: 'bane',
  entity: { kinds: ['civ', 'ruler'] },
  desc: 'Cast a ruler from the throne; a new ruler, and perhaps a new house, takes power.',
  danger: () => true,
  preview: previewDepose,
  applyEntity(world, target) {
    const pv = previewDepose(world, null, null, { target });
    if (!pv.ok) return refuse(pv);
    const { civ, ruler } = rulerOf(world, target);
    const prevName = rulerName(ruler);
    const oldHouse = civ.dynasty;
    const res = depose(world, civ, 'divine');
    if (!res) return { ok: false, message: 'The throne could not be emptied.' };
    civ.stability = Math.max(0, fin(civ.stability, 0.6) - 0.08);
    counted(world);
    const p = spot(world, civ);
    const nr = res.ruler;
    const house = civ.dynasty && civ.dynasty !== oldHouse ? `, founding ${/^the /i.test(civ.dynasty) ? civ.dynasty : 'the ' + civ.dynasty}` : '';
    const text = pick(world, [
      `Omens without number turned the people of ${theName(civ)} against ${prevName}; the palace guard opened the gates, and ${rulerName(nr)} took the throne${house}.`,
      `As if by the will of heaven, ${prevName} of ${theName(civ)} was cast down in a single day, and ${rulerName(nr)} ruled in ${ruler.gender === 'f' ? 'her' : 'his'} place${house}.`,
    ]);
    const e = record(world, { cat: 'divine', imp: 3, key: 'divine.depose', civ, ref: rulerRef(civ, nr), tags: ['coup', 'divine'], text });
    fx(world, { type: 'curse', x: p.x, y: p.y, r: 3, civId: civ.id });
    fx(world, { type: 'riot', x: p.x, y: p.y, r: 2 });
    fx(world, { type: 'label', x: p.x, y: p.y, text: 'Deposed', tone: 'bane', size: 1.1 });
    return { ok: true, message: `${prevName} is cast down; ${rulerName(nr)} rules ${theName(civ)}.`, seq: e.seq };
  },
});

// ---------------------------------------------------------------------------
// Realms and towns

const eraWord = (e) => ERAS[e]?.name || '';
registerTool({
  id: 'gift_tech', label: 'Gift a Technology', group: 'fate', icon: 'enlighten', order: 65, target: 'entity', hidden: true, polarity: 'boon',
  entity: { kinds: ['civ', 'settlement'] },
  desc: 'Place a technology in a people’s hands, if they are ready to grasp it.',
  args: [{
    key: 'techId', type: 'tech', label: 'Technology',
    options: (world, target) => {
      const civ = resolveTarget(world, target)?.civ;
      return civ && civ.alive ? giftableTechs(world, civ).map((t) => [t.id, `${t.name} · ${isArcane(t) ? 'arcane art' : eraWord(t.era)}`]) : [];
    },
  }],
  preview: previewGiftTech,
  applyEntity(world, target, args = {}) {
    const pv = previewGiftTech(world, null, null, { target, techId: args.techId });
    if (!pv.ok) return refuse(pv);
    if (args.techId == null) return { ok: false, message: 'Choose a technology.' };
    const civ = resolveTarget(world, target).civ;
    const t = techDef(args.techId);
    const cap = capOf(world, civ);
    const st = world.sys.civ;
    const first = st.firstTech?.[t.id] == null;
    const text = pick(world, [
      `A stranger came to ${cap ? cap.name : 'the people'} and stayed one night; in the morning ${theName(civ)} knew the secrets of ${t.name.replace(/^The /, 'the ')}${first ? ', the first in the world' : ''}.`,
      `In a dream sent from heaven the sages of ${theName(civ)} beheld ${t.name.replace(/^The /, 'the ')}, and woke knowing it${first ? ' — no people had ever known it before' : ''}.`,
    ]);
    // the gift is the story: discovery's own entries are folded into ours
    const e = record(world, { cat: 'divine', imp: first ? 3 : 2, key: 'divine.gift_tech', civ, tags: [t.id], text });
    discover(world, civ, t.id, 'divine', null, { quiet: true, cause: e.seq });
    counted(world);
    const p = spot(world, civ);
    fx(world, { type: 'bless', x: p.x, y: p.y, r: 3, civId: civ.id });
    fx(world, { type: 'discovery', x: p.x, y: p.y, civId: civ.id });
    fx(world, { type: 'label', x: p.x, y: p.y, text: t.name, tone: 'boon' });
    return { ok: true, message: `${TheName(civ)} learned ${t.name.replace(/^The /, 'the ')}.`, seq: e.seq };
  },
});

registerTool({
  id: 'commission_wonder', label: 'Commission a Wonder', group: 'fate', icon: 'wonder', order: 66, target: 'entity', hidden: true, polarity: 'boon',
  entity: { kinds: ['settlement'] },
  desc: 'Raise one of the wonders of the world in a town, in a single night.',
  args: [{
    key: 'kind', type: 'wonder', label: 'Wonder',
    options: (world, target) => {
      const t = resolveTarget(world, target);
      const s = t?.s, civ = t?.civ;
      if (!s || !s.alive || !civ || !civ.alive) return [];
      return wonderChoices(world, s, civ).filter((c) => c.ok).map((c) => [c.def.kind, wonderLabel(c.def)]);
    },
  }],
  preview: previewCommission,
  applyEntity(world, target, args = {}) {
    const pv = previewCommission(world, null, null, { target, kind: args.kind });
    if (!pv.ok) return refuse(pv);
    if (args.kind == null) return { ok: false, message: 'Choose a wonder.' };
    const { s, civ } = resolveTarget(world, target);
    const choice = wonderChoices(world, s, civ).find((c) => c.def.kind === args.kind && c.ok);
    if (!choice) return { ok: false, message: 'That wonder cannot rise here.' };
    const label = wonderLabel(choice.def);
    const w = completeWonder(world, s, civ, args.kind, {
      divine: true,
      text: ((k) => (name) => {
        const at = name.includes(s.name) ? '' : ` over ${s.name}`, inn = name.includes(s.name) ? '' : ` in ${s.name}`;
        const many = /\b(Stones|Gardens|Halls|Deeps)\b/.test(name);
        return k === 0
          ? `Between dusk and dawn ${name} rose${at}, built by no hand anyone saw; the people of ${theName(civ)} came out at sunrise to find ${many ? 'them' : 'it'} standing.`
          : `By the will of heaven ${name} ${many ? 'were' : 'was'} raised${inn} in a single night, and ${theName(civ)} became the wonder of the age.`;
      })(world.rng.int(0, 1)),
    });
    if (!w) return { ok: false, message: `${label} could not be raised.` };
    counted(world);
    fx(world, { type: 'bless', x: s.x, y: s.y, r: 3.5, civId: civ.id });
    fx(world, { type: 'label', x: s.x, y: s.y, text: label, tone: 'boon', size: 1.2 });
    const many = /\b(Stones|Gardens|Halls|Deeps)\b/.test(w.name);
    return { ok: true, message: w.name.includes(s.name) ? `${cap(w.name)} now ${many ? 'stand' : 'stands'}.` : `${cap(w.name)} now ${many ? 'stand' : 'stands'} in ${s.name}.`, wonderId: w.id };
  },
});

registerTool({
  id: 'rename', label: 'Rename', group: 'fate', icon: 'chronicle', order: 67, target: 'entity', hidden: true, polarity: 'neutral',
  entity: { kinds: ['settlement', 'civ', 'religion', 'feature'] },
  desc: 'Give a town, a nation, a faith or a place a new name by divine decree.',
  args: [{ key: 'name', type: 'text', label: 'New name' }],
  preview: previewRename,
  applyEntity(world, target, args = {}) {
    const p = renamePlan(world, target, args.name);
    if (!p.ok) return refuse(p);
    let oldShown = p.old, newShown = p.name, at = null, civId = null, sid = null, ref = null;
    if (p.kind === 'settlement') {
      const s = p.ent;
      s.name = p.name;
      // the kernel's name set must hold exactly the names a reload would rebuild
      const set = world.cache.settleNames;
      if (set) {
        if (!world.settlements.some((o) => o && o.id !== s.id && o.name === p.old)) set.delete(p.old);
        set.add(p.name);
      }
      bumpVersion(world, 'settlements');
      at = s; civId = s.civId; sid = s.id; ref = { k: 'settlement', id: s.id };
    } else if (p.kind === 'civ') {
      const civ = p.ent;
      civ.baseName = p.base;
      civ.adjective = p.adjective || adjectiveOf(p.base, civ.language);
      styleName(civ, world);
      newShown = theName(civ);
      bumpVersion(world, 'civs');
      at = capOf(world, civ); civId = civ.id; ref = { k: 'civ', id: civ.id };
    } else if (p.kind === 'religion') {
      const r = p.ent;
      r.name = p.name;
      bumpVersion(world, 'religions');
      at = world.settlements[r.holyCityId] || null; ref = { k: 'religion', id: r.id };
    } else {
      const f = p.ent;
      f.name = p.name;
      bumpVersion(world, 'features');
      at = { x: f.x, y: f.y };
    }
    counted(world);
    const text = pick(world, [
      `By divine decree, ${oldShown} was thenceforth called ${newShown}.`,
      `A voice from heaven gave ${oldShown} a new name, and ever after it was known as ${newShown}.`,
    ]);
    const e = record(world, { cat: 'divine', imp: 2, key: 'divine.rename', text, x: at ? at.x : null, y: at ? at.y : null, civId, sid, ref, tags: [p.kind] });
    if (at) fx(world, { type: 'label', x: at.x, y: at.y, text: p.kind === 'civ' ? cap(newShown) : newShown, tone: 'neutral', size: 1.1 });
    if (at) fx(world, { type: 'swirl', x: at.x, y: at.y, r: 2 });
    return { ok: true, message: `${cap(oldShown)} is now ${newShown}.`, seq: e.seq };
  },
});

// ---------------------------------------------------------------------------
// Pair acts

registerTool({
  id: 'cede_town', label: 'Cede a Town', group: 'fate', icon: 'town', order: 70, target: 'pair', pick: ['settlement', 'civ'], polarity: 'neutral',
  desc: 'Move a town from one nation to another by the will of heaven.',
  preview: previewCede,
  applyPair(world, a, b) {
    const s = a?.kind === 'settlement' ? world.settlements[a.id] : null;
    const civ = b?.kind === 'civ' ? world.civs[b.id] : b?.kind === 'settlement' ? world.civs[world.settlements[b.id]?.civId] : null;
    const p = cedePlan(world, s, civ);
    if (!p.ok) return refuse(p);
    const from = p.from;
    const fromName = theName(from), last = from.settlementIds.length === 1;
    const pop = s.population;
    transferSettlement(world, s.id, civ.id, 'divine');
    if (s.alive) { s.loyalty = Math.max(s.loyalty, 0.55); s.unrest = Math.min(s.unrest, 0.2); s.flags.pacified = world.time.day; }
      counted(world);
    const cap = capOf(world, civ);
    const text = pick(world, [
      `By the will of heaven ${s.name} passed from ${fromName} to ${theName(civ)}; its ${fmtInt(pop)} people woke under a new banner${last ? `, and ${fromName} passed from history` : ''}.`,
      `Portents over ${s.name} bade it leave ${fromName}; the town gave its oaths to ${theName(civ)}${last ? `, and with it ${fromName} came to an end` : ''}.`,
    ]);
    const e = record(world, { cat: 'divine', imp: last || s.tier >= 4 ? 3 : 2, key: 'divine.cede_town', s, ref: { k: 'settlement', id: s.id }, civId: civ.id, tags: ['cession'], text });
    if (cap) fx(world, { type: 'thread', x: s.x, y: s.y, x2: cap.x, y2: cap.y, tone: 'peace' });
    fx(world, { type: 'bless', x: s.x, y: s.y, r: 2, civId: civ.id });
    fx(world, { type: 'label', x: s.x, y: s.y, text: `to ${civ.adjective}`, tone: 'neutral' });
    return { ok: true, message: `${s.name} now belongs to ${theName(civ)}.`, seq: e.seq };
  },
});

registerTool({
  id: 'send_settlers', label: 'Send Settlers', group: 'peoples', icon: 'settle', order: 30, target: 'pair', pick: ['settlement', 'tile'], polarity: 'boon',
  desc: 'Lead settlers from a town to found a new one wherever you point, even across the sea.',
  preview: previewSettlers,
  applyPair(world, a, b) {
    const s = a?.kind === 'settlement' ? world.settlements[a.id] : null;
    const x = Number.isFinite(b?.x) ? b.x : null, y = Number.isFinite(b?.y) ? b.y : null;
    if (x == null || y == null) return { ok: false, message: 'Choose where the settlers should go.' };
    const res = colonize(world, s ? s.id : -1, x, y, { divine: true });
    if (!res.ok) return res;
    counted(world);
    fx(world, { type: 'thread', x: s.x, y: s.y, x2: res.s.x, y2: res.s.y, tone: 'trade' });
    fx(world, { type: 'bless', x: res.s.x, y: res.s.y, r: 2, civId: res.s.civId });
    fx(world, { type: 'label', x: res.s.x, y: res.s.y, text: res.s.name, tone: 'boon' });
    return { ok: true, message: res.message };
  },
});

registerTool({
  id: 'arrange_marriage', label: 'Arrange a Marriage', group: 'fate', icon: 'harmony', order: 71, target: 'pair', pick: ['civ', 'civ'], polarity: 'boon',
  desc: 'Wed two royal houses: friendship, and a claim on each other’s crowns.',
  preview: previewMarriage,
  applyPair(world, a, b) {
    const A = a?.kind === 'civ' ? world.civs[a.id] : a?.kind === 'settlement' ? world.civs[world.settlements[a.id]?.civId] : null;
    const B = b?.kind === 'civ' ? world.civs[b.id] : b?.kind === 'settlement' ? world.civs[world.settlements[b.id]?.civId] : null;
    const res = arrangeMarriage(world, A, B, { divine: true });
    if (!res.ok) return { ok: false, message: res.reason || 'The match could not be made.' };
    counted(world);
    for (const c of [A, B]) {
      const p = spot(world, c);
      fx(world, { type: 'bless', x: p.x, y: p.y, r: 2, civId: c.id });
    }
    const pa = spot(world, A);
    fx(world, { type: 'label', x: pa.x, y: pa.y, text: res.betrothal ? 'Betrothed' : 'Wed', tone: 'boon' });
    return { ok: true, message: res.message, seq: res.seq };
  },
});

function cap(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }

export const ACT_TOOL_IDS = ['bless_ruler', 'curse_ruler', 'smite_ruler', 'grant_heir', 'depose', 'gift_tech', 'commission_wonder', 'rename', 'cede_town', 'send_settlers', 'arrange_marriage'];
