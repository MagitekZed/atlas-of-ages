// God tools for peoples and fate (registered at module load):
//   tribe      raise a new people at the clicked tile
//   settle     found a town there for the owning (or nearest) nation
//   prosper    a season of plenty: food, health, happiness, calm, richer soil in an area
//   enlighten  a burst of insight and a golden age for the clicked nation
//   unrest     incite a rising: the settlement secedes (or the government falls)
//   ruin       devastate a settlement and its fields
// Each has a pure preview (previews.js: the blocking town, the realm outlined, estimate
// ranges), a polarity for the hover tint, writes a Divine Hand entry (key 'divine.<id>') and
// answers with the intervention fx kit (bless / curse / riot / label, src 'tool').
// The acts on rulers, realms and towns are in acts.js.

import { registerTool } from '../../core/tools.js';
import { WATER, BIOMES } from '../../core/constants.js';
import { settlementsNear, damageSettlement, nearestSettlement } from '../../core/entities.js';
import { emitFx } from '../../core/world.js';
import { clamp01 } from '../../core/util.js';
import { newPeople, foundSettlement, spacingOk, peopleAt } from './expansion.js';
import { discover, researchBurst, refreshMods, techDef } from './tech.js';
import { revolt } from './stability.js';
import { overthrow } from './rulers.js';
import { revolutionTarget } from './government.js';
import { fin, record, rateOk, ensureSettlementFields } from './state.js';
import { theName, TheName, peopleOf, rulerName, placePhrase, pick, peopleCount, fmtInt, listJoin } from './prose.js';
import { civAt, settlementAtXY, previewTribe, previewSettle, previewProsper, previewEnlighten, previewUnrest, previewRuin } from './previews.js';

const notReady = { ok: false, message: 'There are no peoples in this world to guide yet.' };
const fx = (world, o) => emitFx(world, { ...o, src: 'tool' });

registerTool({
  id: 'tribe', label: 'New People', group: 'peoples', icon: 'tribe', order: 10, target: 'tile', radius: 0, polarity: 'boon',
  desc: 'Raise a new people at this spot, sharing the common knowledge of the age.',
  strength: { label: 'Numbers', min: 0.5, max: 4, default: 1 },
  preview: previewTribe,
  apply(world, x, y, { strength }) {
    if (!world.sys.civ) return notReady;
    const i = y * world.W + x;
    if (world.f.water[i] !== WATER.LAND) return { ok: false, message: 'A people needs dry land beneath its feet.' };
    if (world.f.settle[i] >= 0 || !spacingOk(world, x, y, 3)) return { ok: false, message: 'This land is already settled; choose emptier country.' };
    const who = peopleAt(world, { genesis: false, i });
    const civOpts = {};
    if (who) {
      if (who.race !== undefined) civOpts.race = who.race;
      if (who.traits) civOpts.traits = who.traits;
      if (who.languageStyle) civOpts.languageStyle = who.languageStyle;
    }
    const r = newPeople(world, x, y, { population: Math.round(150 * Math.max(0.5, fin(strength, 1))), techFrom: 'world', civOpts });
    if (!r) return { ok: false, message: 'No people could take root here.' };
      record(world, { cat: 'divine', imp: 3, key: 'divine.tribe', s: r.s, ref: { k: 'civ', id: r.civ.id }, text: pick(world, [
      `At the touch of an unseen hand, a new people, ${theName(r.civ)}, appeared ${placePhrase(world, x, y)} and founded ${r.s.name}.`,
      `Out of the empty land ${placePhrase(world, x, y)} came ${peopleOf(r.civ)}, as if the earth itself had made them; their first hearth was ${r.s.name}.`,
    ]) });
    fx(world, { type: 'bless', x, y, r: 3, civId: r.civ.id });
    fx(world, { type: 'newcivs', x, y, civId: r.civ.id });
    fx(world, { type: 'label', x, y, text: TheName(r.civ), tone: 'boon' });
    return { ok: true, message: `${TheName(r.civ)} have arisen at ${r.s.name}.` };
  },
});

registerTool({
  id: 'settle', label: 'Found Town', group: 'peoples', icon: 'settle', order: 20, target: 'tile', radius: 0, polarity: 'boon',
  desc: 'Found a new town here for the nation that owns this land, or the nearest one.',
  strength: { label: 'Settlers', min: 0.5, max: 4, default: 1 },
  preview: previewSettle,
  apply(world, x, y, { strength }) {
    if (!world.sys.civ) return notReady;
    const i = y * world.W + x;
    if (world.f.water[i] !== WATER.LAND) return { ok: false, message: 'Towns cannot be built on water.' };
    if (world.f.settle[i] >= 0 || !spacingOk(world, x, y, 3)) return { ok: false, message: 'Too close to another settlement.' };
    let civ = civAt(world, x, y);
    if (!civ) { const s = nearestSettlement(world, x, y, { maxDist: 40 }); civ = s ? world.civs[s.civId] : null; }
    if (!civ || !civ.alive) return { ok: false, message: 'No nation is near enough to settle here. Try raising a new people instead.' };
    const s = foundSettlement(world, civ, x, y, Math.round(250 * Math.max(0.5, fin(strength, 1))), { divine: true });
    if (!s) return { ok: false, message: 'The settlers could not take root here.' };
    fx(world, { type: 'bless', x, y, r: 2, civId: civ.id });
    fx(world, { type: 'label', x, y, text: s.name, tone: 'boon' });
    return { ok: true, message: `${TheName(civ)} founded ${s.name}.` };
  },
});

registerTool({
  id: 'prosper', label: 'Prosperity', group: 'fate', icon: 'prosper', order: 10, target: 'area', radius: 5, minRadius: 1, maxRadius: 16, polarity: 'boon',
  desc: 'A season of uncanny plenty: full granaries, health, contentment and richer soil.',
  strength: { label: 'Bounty', min: 0.25, max: 2, default: 1 },
  preview: previewProsper,
  apply(world, x, y, { radius, strength }) {
    if (!world.sys.civ) return notReady;
    const st = Math.max(0.25, fin(strength, 1));
    const R = Math.max(1, Math.min(16, fin(radius, 5)));
    const { W, H, f } = world;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > R * R) continue;
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const i = ty * W + tx;
      if (f.water[i] !== WATER.LAND) continue;
      const fall = 1 - Math.sqrt(d2) / (R + 1);
      f.soil[i] = Math.min(1, f.soil[i] + 0.12 * st * fall);
      f.devastation[i] = Math.max(0, f.devastation[i] - 0.4 * st * fall);
      const B = BIOMES[f.biome[i]];
      if (B && f.veg[i] < B.vegMax) f.veg[i] = Math.min(B.vegMax, f.veg[i] + 0.1 * st * fall);
    }
    const ss = settlementsNear(world, x, y, R).sort((a, b) => b.population - a.population);
    let famines = 0;
    for (const s of ss) {
      ensureSettlementFields(s);
      s.food = fin(s.food) + s.population * 6 * st;
      if (s.famine > 0) famines++;
      s.famine = 0;
      s.health = clamp01(s.health + 0.15 * st);
      s.happiness = clamp01(s.happiness + 0.2 * st);
      s.unrest = clamp01(s.unrest - 0.3 * st);
      s.loyalty = clamp01(s.loyalty + 0.1 * st);
    }
    fx(world, { type: 'bless', x, y, r: R });
    fx(world, { type: 'sprout', x, y, r: R * 0.8 });
    if (ss.length) fx(world, { type: 'label', x, y, text: famines ? `Famine ended ×${famines}` : `Plenty ×${ss.length}`, tone: 'boon' });
    if (ss.length && rateOk(world, `tool:prosper:${ss[0].id}`, 3)) {
      const names = ss.slice(0, 3).map((s) => s.name);
      const more = ss.length > 3 ? ` and ${ss.length - 3} more towns` : '';
      record(world, { cat: 'divine', imp: 2, key: 'divine.prosper', s: ss[0], text: pick(world, [
        `A season of uncanny plenty blessed ${listJoin(names)}${more}; granaries overflowed${famines ? ', the famine broke' : ''} and the sick rose from their beds.`,
        `Out of season the fields around ${listJoin(names)}${more} bore a second harvest; ${famines ? 'the hungry were fed, and ' : ''}no one could remember a richer year.`,
      ]) });
    }
    return { ok: true, message: ss.length ? `Plenty came to ${ss.length} settlement${ss.length > 1 ? 's' : ''}.` : 'The land grew richer.' };
  },
});

registerTool({
  id: 'enlighten', label: 'Enlighten', group: 'fate', icon: 'enlighten', order: 20, target: 'civ', radius: 0, polarity: 'boon',
  desc: 'Grant a nation a flash of insight and begin a golden age.',
  preview: previewEnlighten,
  apply(world, x, y) {
    if (!world.sys.civ) return notReady;
    const civ = civAt(world, x, y);
    if (!civ) return { ok: false, message: 'Click on land ruled by a nation.' };
    const t = civ.tech.research ? techDef(civ.tech.research) : null;
    const learned = t ? t.name.replace(/^The /, 'the ') : null;
    const wasDark = fin(civ.darkAge) > 0;
    const e = record(world, { cat: 'divine', imp: 3, key: 'divine.enlighten', civ, text: pick(world, [
      `A divine light fell upon ${theName(civ)}${learned ? `; its sages grasped the secrets of ${learned} in a single night` : ''}${wasDark ? ', the long darkness lifted' : ''}, and a golden age began${civ.ruler ? ` under ${rulerName(civ.ruler)}` : ''}.`,
      `${TheName(civ)} woke as from a long sleep${learned ? `: ${learned} lay open to its scholars` : ''}${wasDark ? ', its dark age over' : ''}, and a golden age dawned${civ.ruler ? ` in the reign of ${rulerName(civ.ruler)}` : ''}.`,
    ]) });
    if (t) discover(world, civ, t.id, 'divine', null, { quiet: true, cause: e.seq });
    researchBurst(world, civ, 0.5);
    civ.darkAge = 0;
    civ.goldenAge = Math.max(fin(civ.goldenAge), 20);
    civ.stability = clamp01(civ.stability + 0.1);
    refreshMods(world, civ);
    const cap = world.settlements[civ.capitalId];
    if (cap) {
      fx(world, { type: 'bless', x: cap.x, y: cap.y, r: 4, civId: civ.id });
      fx(world, { type: 'label', x: cap.x, y: cap.y, text: learned ? t.name : '+Golden age', tone: 'boon', size: 1.1 });
    }
    return { ok: true, message: `${TheName(civ)} entered a golden age${learned ? ` and learned ${learned}` : ''}.` };
  },
});

registerTool({
  id: 'unrest', label: 'Incite Unrest', group: 'fate', icon: 'unrest', order: 30, target: 'settlement', radius: 0, polarity: 'bane',
  desc: 'Stir a settlement to revolt: it breaks away, or its nation’s government falls.',
  preview: previewUnrest,
  apply(world, x, y) {
    if (!world.sys.civ) return notReady;
    const s = settlementAtXY(world, x, y);
    if (!s) return { ok: false, message: 'Click on a settlement.' };
    const civ = world.civs[s.civId];
    if (!civ || !civ.alive) return { ok: false, message: 'That settlement owes allegiance to no one.' };
    fx(world, { type: 'curse', x: s.x, y: s.y, r: 2.5, civId: civ.id });
    fx(world, { type: 'riot', x: s.x, y: s.y, r: 2 });
    s.unrest = 1; s.loyalty = Math.min(s.loyalty, 0.1);
    if (s.id !== civ.capitalId && civ.settlementIds.length > 1) {
      const name = theName(civ);
      if (revolt(world, civ, s, { divine: true })) {
        const now = world.civs[s.civId];
        fx(world, { type: 'label', x: s.x, y: s.y, text: 'Revolt!', tone: 'bane' });
        return { ok: true, message: now && now.id !== civ.id ? `${s.name} broke away from ${name} and joined ${theName(now)}.` : `${s.name} rose in revolt.` };
      }
    }
    // the capital or a lone city: the government itself falls
    const target = revolutionTarget(world, civ);
    const oldName = theName(civ);
    const prevName = civ.ruler ? rulerName(civ.ruler) : 'the old rulers';
    const { ruler } = overthrow(world, civ, target || civ.government, 'revolution');
    civ.stability = 0.4;
    record(world, { cat: 'divine', imp: 3, key: 'divine.unrest', s, ref: { k: 'civ', id: civ.id }, tags: ['coup'], text: pick(world, [
      `Riots inflamed by strange portents spread through ${s.name}; ${prevName} fell, and ${rulerName(ruler, false)} took power in ${oldName === theName(civ) ? oldName : theName(civ)}.`,
      `A comet hung over ${s.name} for nine nights, and on the tenth the mob stormed the palace: ${prevName} was gone, and ${rulerName(ruler, false)} ruled ${theName(civ)}.`,
    ]) });
    fx(world, { type: 'label', x: s.x, y: s.y, text: 'Revolution', tone: 'bane', size: 1.1 });
    return { ok: true, message: `Revolution in ${s.name}: ${theName(civ)} has a new ruler.` };
  },
});

registerTool({
  id: 'ruin', label: 'Ruin', group: 'fate', icon: 'ruin', order: 40, target: 'settlement', radius: 0, polarity: 'bane',
  desc: 'Bring calamity on a settlement: its people, wealth, walls and fields are laid waste.',
  strength: { label: 'Severity', min: 0.2, max: 1, default: 0.6 },
  danger: (opts) => fin(opts?.strength, 0.6) >= 0.9,
  preview: previewRuin,
  apply(world, x, y, { strength }) {
    if (!world.sys.civ) return notReady;
    const s = settlementAtXY(world, x, y);
    if (!s) return { ok: false, message: 'Click on a settlement.' };
    const sv = Math.max(0.2, Math.min(1, fin(strength, 0.6)));
    const name = s.name, sx = s.x, sy = s.y, r = s.radius || 2;
    const { W, H, f } = world;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const tx = sx + dx, ty = sy + dy;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H || dx * dx + dy * dy > (r + 0.5) * (r + 0.5)) continue;
      const i = ty * W + tx;
      if (f.water[i] !== WATER.LAND) continue;
      f.devastation[i] = Math.min(1, f.devastation[i] + 0.7 * sv);
      f.farm[i] *= 1 - 0.6 * sv;
    }
    const pop = s.population;
    const civId = s.civId, sid = s.id;
    const dead = damageSettlement(world, s, { pop: 0.5 * sv, wealth: 0.8 * sv, food: 0.9 * sv, defense: 0.7 * sv, buildings: 0.6 * sv, cause: 'ruin' });
    if (s.alive) { s.happiness = clamp01(s.happiness - 0.3 * sv); s.unrest = clamp01(s.unrest + 0.3 * sv); s.housing *= 1 - 0.4 * sv; }
    fx(world, { type: 'curse', x: sx, y: sy, r: r + 1, civId });
    fx(world, { type: 'label', x: sx, y: sy, text: `−${fmtInt(s.alive ? dead : pop)}`, tone: 'bane', size: Math.min(1.6, 0.9 + Math.log10(1 + dead) / 6) });
    record(world, { cat: 'divine', imp: 3, key: 'divine.ruin', x: sx, y: sy, civId, sid, ref: { k: 'settlement', id: sid }, text: s.alive
      ? pick(world, [
        `Calamity fell on ${name} from a clear sky; ${peopleCount(world, dead)} died, its walls were broken and its fields burned.`,
        `Fire and pestilence came to ${name} in a single night: ${peopleCount(world, dead)} perished, and the granaries were ashes by morning.`,
      ])
      : `Calamity fell on ${name} from a clear sky, and the town of ${fmtInt(pop)} souls was utterly destroyed.` });
    return { ok: true, message: s.alive ? `${name} lies in ruins; ${fmtInt(dead)} of ${fmtInt(pop)} perished.` : `${name} was destroyed with all its ${fmtInt(pop)} people.` };
  },
});

export const CIV_TOOL_IDS = ['tribe', 'settle', 'prosper', 'enlighten', 'unrest', 'ruin'];
