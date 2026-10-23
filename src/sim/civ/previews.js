// Tool previews for the peoples and fate tools and the divine acts (contracts §11): what a
// click would do, before it is done. Every function here is pure — no world.rng, no writes to
// saved state (the habitability grid is read as it stands, never rebuilt) — so the hover card
// can ask as often as it likes. The plans the acts follow (which virtue a blessing grants,
// which vice a curse brings, how many settlers leave, what a rename becomes) live here too,
// so the forecast and the deed always agree.
//
// preview(world, x, y, opts) → { ok, reason?, text?, targets?: [{kind, id}],
//   rings?: [{x, y, r, tone}], threads?: [{x0, y0, x1, y1, tone}], estimate?, severity? }
// Entity previews read opts.target ({ kind, id }) and the act's args from opts; pair previews
// read opts.a and opts.b (the source and the target under the cursor).

import { WATER, DAYS_PER_YEAR, ERAS, TIERS } from '../../core/constants.js';
import { settlementsNear, nearestSettlement, areAtWar } from '../../core/entities.js';
import { mulOf, hasProviders } from '../../core/ext.js';
import { RULER_TRAITS, isDynastic, allWonders, wonderDef } from './data.js';
import { giftableTechs, techDef, isArcane } from './tech.js';
import { theName, TheName, rulerName, rulerShort, fmtInt, approx, listJoin, landNameAt } from './prose.js';
import { marriageCheck } from './dynasty.js';
import { wonderSiteOk, wonderGateOk } from './buildings.js';
import { fin } from './state.js';

const notReady = { ok: false, reason: 'There are no peoples in this world to guide yet.' };
const DIST = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------------------
// Targets

/** The live civ at a tile: its owner, else the nearest town's realm within 6 tiles. */
export function civAt(world, x, y) {
  if (!(x >= 0 && y >= 0 && x < world.W && y < world.H)) return null;
  const i = y * world.W + x;
  const o = world.f.owner[i];
  if (o >= 0 && world.civs[o]?.alive) return world.civs[o];
  const s = nearestSettlement(world, x, y, { maxDist: 6 });
  return s ? world.civs[s.civId] : null;
}

/** The live settlement on (or within maxDist of) a tile. */
export function settlementAtXY(world, x, y, maxDist = 3) {
  if (!(x >= 0 && y >= 0 && x < world.W && y < world.H)) return null;
  const sid = world.f.settle[y * world.W + x];
  if (sid >= 0 && world.settlements[sid]?.alive) return world.settlements[sid];
  return nearestSettlement(world, x, y, { maxDist });
}

/** The town that blocks a new one at (x, y) within d tiles, or null. */
export function blockingTown(world, x, y, d) {
  let best = null, bd = Infinity;
  for (const s of settlementsNear(world, x, y, d - 0.01)) {
    const k = Math.hypot(s.x - x, s.y - y);
    if (k < bd) { bd = k; best = s; }
  }
  return best ? { s: best, d: bd } : null;
}

/**
 * Resolve an entity target { kind, id } to what the acts touch: { kind, civ, s, ruler, religion,
 * feature }. A 'ruler' id is "civId:reignStart" (the Inspector's form) and must be the
 * reigning ruler; a settlement brings its realm, a civ its ruler.
 */
export function resolveTarget(world, target) {
  if (!target || target.kind == null) return null;
  const k = target.kind;
  // index-addressed kinds take whole-number ids only ('__proto__', 'length' are Array internals)
  const at = (arr) => { const n = Number(target.id); return Number.isInteger(n) && n >= 0 ? arr[n] || null : null; };
  if (k === 'civ') {
    const civ = at(world.civs);
    return civ ? { kind: k, civ, ruler: civ.ruler || null } : null;
  }
  if (k === 'settlement') {
    const s = at(world.settlements);
    if (!s) return null;
    const civ = world.civs[s.civId] || null;
    return { kind: k, s, civ, ruler: civ?.ruler || null };
  }
  if (k === 'ruler') {
    const str = String(target.id ?? '');
    const c = str.indexOf(':');
    let civ = null;
    if (c > 0) civ = world.civs[Number(str.slice(0, c))] || null;
    else for (const o of world.civs) if (o && o.alive && o.ruler && String(o.ruler.id) === str) { civ = o; break; }
    if (!civ || !civ.ruler) return civ ? { kind: k, civ, ruler: null } : null;
    const live = c > 0 ? String(civ.ruler.reignStart) === str.slice(c + 1) : true;
    return { kind: k, civ, ruler: live ? civ.ruler : null, stale: !live };
  }
  if (k === 'religion') { const r = at(world.religions); return r ? { kind: k, religion: r } : null; }
  if (k === 'feature') { const f = at(world.features || []); return f ? { kind: k, feature: f } : null; }
  return null;
}

/** The ruler an act on a ruler would touch, or a refusal. */
function rulerTarget(world, opts) {
  if (!world.sys.civ) return { err: notReady };
  const t = resolveTarget(world, opts?.target);
  if (!t || !t.civ) return { err: { ok: false, reason: 'Choose a nation or its ruler.' } };
  if (!t.civ.alive) return { err: { ok: false, reason: `${TheName(t.civ)} has passed from history.` } };
  if (!t.ruler) return { err: { ok: false, reason: t.stale ? 'That ruler no longer reigns.' : `${TheName(t.civ)} has no ruler to touch.` } };
  return { civ: t.civ, ruler: t.ruler };
}

const capOf = (world, civ) => (civ && civ.capitalId != null ? world.settlements[civ.capitalId] || null : null);
const civTargets = (civ) => [{ kind: 'civ', id: civ.id }];

// ---------------------------------------------------------------------------
// Plans shared with the acts

const VIRTUES = ['wise', 'just', 'brilliant', 'charismatic', 'generous', 'industrious', 'cautious'];
const VICES = ['mad', 'cruel', 'foolish', 'craven', 'lazy', 'greedy', 'paranoid'];
const clashes = (traits, t) => traits.some((o) => RULER_TRAITS[o]?.opp.includes(t) || RULER_TRAITS[t]?.opp.includes(o));

/** A blessing: the first vice is lifted, then the first virtue the ruler lacks is given. */
export function blessPlan(r) {
  const traits = (r.traits || []).slice();
  const remove = VICES.find((v) => traits.includes(v)) || null;
  const rest = remove ? traits.filter((t) => t !== remove) : traits;
  const add = VIRTUES.find((v) => !rest.includes(v) && !clashes(rest, v)) || null;
  return { remove, add, traits: add ? [...rest, add].slice(-4) : rest };
}

/** A curse: madness, else cruelty, else suspicion; a clashing virtue is lost. */
export function cursePlan(r) {
  const traits = (r.traits || []).slice();
  const add = ['mad', 'cruel', 'paranoid'].find((v) => !traits.includes(v)) || null;
  const lose = add ? traits.filter((t) => RULER_TRAITS[add]?.opp.includes(t) || RULER_TRAITS[t]?.opp.includes(add)) : [];
  const rest = traits.filter((t) => !lose.includes(t));
  return { add, lose, traits: add ? [...rest, add].slice(-4) : rest };
}

/** How many settlers a town sends (10–18 % of its people; 40–5,000). */
export function settlerCount(s) {
  return Math.max(40, Math.min(5000, Math.round(fin(s.population) * 0.14)));
}

/** Can settlers from s found a town at (x, y)? { ok, reason?, n, d } (pure). */
export function settlersPlan(world, s, x, y) {
  if (!world.sys.civ) return notReady;
  if (!s || !s.alive) return { ok: false, reason: 'Choose a living town to send settlers from.' };
  const civ = world.civs[s.civId];
  if (!civ || !civ.alive) return { ok: false, reason: `${s.name} owes allegiance to no one.` };
  if (!(x >= 0 && y >= 0 && x < world.W && y < world.H)) return { ok: false, reason: 'That spot is off the edge of the world.' };
  x = Math.round(x); y = Math.round(y);
  const i = y * world.W + x;
  if (world.f.water[i] !== WATER.LAND) return { ok: false, reason: 'Settlers need dry land to build on.' };
  if (world.f.settle[i] >= 0) return { ok: false, reason: `${world.settlements[world.f.settle[i]]?.name || 'A town'} already stands there.` };
  const o = world.f.owner[i];
  if (o >= 0 && o !== civ.id && world.civs[o]?.alive) return { ok: false, reason: `That land belongs to ${theName(world.civs[o])}.` };
  const block = blockingTown(world, x, y, 4);
  if (block) return { ok: false, reason: `Too close to ${block.s.name} (${Math.max(1, Math.round(block.d))} tile${Math.round(block.d) === 1 ? '' : 's'}).` };
  if (fin(s.population) < 120) return { ok: false, reason: `${s.name} has too few people to spare (${fmtInt(s.population)}).` };
  const d = Math.hypot(x - s.x, y - s.y);
  const overseas = world.f.landmass[i] !== world.f.landmass[s.i];
  return { ok: true, n: settlerCount(s), d, overseas, civ, x, y, i };
}

/** Can town s be ceded to civ? { ok, reason? } */
export function cedePlan(world, s, civ) {
  if (!world.sys.civ) return notReady;
  if (!s || !s.alive) return { ok: false, reason: 'Choose a living town to cede.' };
  if (!civ || !civ.alive) return { ok: false, reason: 'Choose a living nation to receive it.' };
  const from = world.civs[s.civId];
  if (!from || !from.alive) return { ok: false, reason: `${s.name} owes allegiance to no one.` };
  if (from.id === civ.id) return { ok: false, reason: `${s.name} already belongs to ${theName(civ)}.` };
  return { ok: true, from };
}

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}'’\-. ]*$/u;
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What a rename would do: { ok, reason?, kind, old, name, base?, adjective? } (pure).
 * 1–32 plain characters (letters, spaces, apostrophes, hyphens, full stops). A realm's new
 * name may be typed whole ("Kingdom of Newhaven"): its style is recognised and only the base
 * name taken; the government restyles it.
 */
export function renamePlan(world, target, raw) {
  const t = resolveTarget(world, target);
  if (!t) return { ok: false, reason: 'Choose a town, a nation, a faith or a place to rename.' };
  let name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, reason: 'Give it a name.' };
  if (name.length > 32) return { ok: false, reason: 'A name of at most 32 letters.' };
  if (!NAME_RE.test(name)) return { ok: false, reason: 'Use letters, spaces, apostrophes and hyphens only.' };
  if (t.kind === 'settlement') {
    const s = t.s;
    if (!s.alive) return { ok: false, reason: `${s.name} is a ruin; ruins keep their old names.` };
    if (name === s.name) return { ok: false, reason: `It is already called ${s.name}.` };
    if (world.settlements.some((o) => o && o.alive && o.id !== s.id && o.name === name)) return { ok: false, reason: `Another town is already called ${name}.` };
    return { ok: true, kind: 'settlement', old: s.name, name, ent: s };
  }
  if (t.kind === 'civ' || t.kind === 'ruler') {
    const civ = t.civ;
    if (!civ.alive) return { ok: false, reason: `${TheName(civ)} has passed from history.` };
    let base = name.replace(/^the\s+/i, ''), adjective = null;
    // a whole styled name typed back: keep only the part that is the realm's own
    const tpl = (civ.name || '').split(civ.baseName);
    if (tpl.length === 2 && (tpl[0] || tpl[1])) {
      const m = base.match(new RegExp(`^${escRe(tpl[0])}(.+?)${escRe(tpl[1])}$`, 'i'));
      if (m && m[1]) base = m[1].trim();
    } else if ((civ.name || '').includes(civ.adjective)) {
      const parts = civ.name.split(civ.adjective);
      if (parts.length === 2) {
        const m = base.match(new RegExp(`^${escRe(parts[0])}(.+?)${escRe(parts[1])}$`, 'i'));
        if (m && m[1]) { adjective = m[1].trim(); base = adjective; }
      }
    }
    if (!base || base.length > 32 || !NAME_RE.test(base)) return { ok: false, reason: 'That name will not take.' };
    if (base === civ.baseName && (!adjective || adjective === civ.adjective)) return { ok: false, reason: `It is already called ${theName(civ)}.` };
    if (world.civs.some((o) => o && o.alive && o.id !== civ.id && o.baseName === base)) return { ok: false, reason: `Another nation already goes by ${base}.` };
    return { ok: true, kind: 'civ', old: theName(civ), name: base, base, adjective, ent: civ };
  }
  if (t.kind === 'religion') {
    const r = t.religion;
    if (name === r.name) return { ok: false, reason: `It is already called ${r.name}.` };
    return { ok: true, kind: 'religion', old: r.name, name, ent: r };
  }
  if (t.kind === 'feature') {
    const f = t.feature;
    if (name === f.name) return { ok: false, reason: `It is already called ${f.name}.` };
    return { ok: true, kind: 'feature', old: f.name, name, ent: f };
  }
  return { ok: false, reason: 'That cannot be renamed.' };
}

/** Wonders the gods could raise at s for civ now: [{ def, ok, reason }] (pure). */
export function wonderChoices(world, s, civ) {
  const st = world.sys.civ;
  const era = fin(civ?.tech?.era, 0);
  const out = [];
  for (const w of allWonders()) {
    if (!wonderGateOk(world, s, civ, w)) continue;
    let reason = null;
    if (st?.wonderKinds?.[w.kind] != null) {
      const o = world.wonders[st.wonderKinds[w.kind]];
      reason = `${o ? cap1(o.name) : 'One'} already stands`;
    } else if (w.era > era + 1) reason = `belongs to the ${ERAS[w.era]?.name || 'later ages'}`;
    else if (s.tier < Math.max(2, w.minTier - 1)) reason = `needs a ${TIERS[Math.max(2, w.minTier - 1)].name.toLowerCase()}`;
    else if (!wonderSiteOk(world, s, w)) reason = w.needs === 'coastal' ? 'needs a harbour on the sea' : w.needs === 'river' ? 'needs a great river' : `needs a ${w.needs}`;
    out.push({ def: w, ok: !reason, reason });
  }
  return out;
}
const cap1 = (t) => t.charAt(0).toUpperCase() + t.slice(1);
/** A readable wonder name for the picker ("Great Library", "Colossus"). */
export function wonderLabel(def) {
  const n = (def.names?.[0] || def.kind).replace(/\s*(of|at)\s*\{\w+\}.*/, '').replace(/\{\w+\}\s*/g, '').replace(/^the\s+/i, '');
  return cap1(n.trim() || def.kind.replace(/_/g, ' '));
}

// ---------------------------------------------------------------------------
// Peoples and fate tools (tile targets)

export function previewTribe(world, x, y) {
  if (!world.sys.civ) return notReady;
  const i = y * world.W + x;
  if (world.f.water[i] !== WATER.LAND) return { ok: false, reason: 'A people needs dry land beneath its feet.' };
  if (world.f.settle[i] >= 0) return { ok: false, reason: `${world.settlements[world.f.settle[i]]?.name || 'A town'} already stands here.` };
  const block = blockingTown(world, x, y, 3);
  if (block) return { ok: false, reason: `Too close to ${block.s.name} (${Math.max(1, Math.round(block.d))} tile${Math.round(block.d) === 1 ? '' : 's'}); choose emptier country.`, targets: [{ kind: 'settlement', id: block.s.id }], rings: [{ x: block.s.x, y: block.s.y, r: 3, tone: 'bane' }] };
  const h = world.f.civHabit ? fin(world.f.civHabit[i], 0) : 0.4;
  const land = landNameAt(world, x, y);
  const quality = h >= 0.55 ? 'rich land' : h >= 0.35 ? 'fair land' : h >= 0.18 ? 'hard land' : 'barren land';
  const o = world.f.owner[i];
  const claim = o >= 0 && world.civs[o]?.alive ? ` within the borders of ${theName(world.civs[o])}` : '';
  return { ok: true, text: `A new people would arise here on ${quality}${land ? ` of ${land}` : ''}${claim}, sharing the common knowledge of the age.`, rings: [{ x, y, r: 3, tone: 'boon' }], severity: 0.2 };
}

export function previewSettle(world, x, y, opts = {}) {
  if (!world.sys.civ) return notReady;
  const i = y * world.W + x;
  if (world.f.water[i] !== WATER.LAND) return { ok: false, reason: 'Towns cannot be built on water.' };
  if (world.f.settle[i] >= 0) return { ok: false, reason: `${world.settlements[world.f.settle[i]]?.name || 'A town'} already stands here.` };
  const block = blockingTown(world, x, y, 3);
  if (block) return { ok: false, reason: `Too close to ${block.s.name} (${Math.max(1, Math.round(block.d))} tile${Math.round(block.d) === 1 ? '' : 's'}).`, targets: [{ kind: 'settlement', id: block.s.id }], rings: [{ x: block.s.x, y: block.s.y, r: 3, tone: 'bane' }] };
  let civ = civAt(world, x, y);
  if (!civ) { const s = nearestSettlement(world, x, y, { maxDist: 40 }); civ = s ? world.civs[s.civId] : null; }
  if (!civ || !civ.alive) return { ok: false, reason: 'No nation is near enough to settle here. Try raising a new people instead.' };
  const from = nearestSettlement(world, x, y, { civId: civ.id });
  const n = Math.round(250 * Math.max(0.5, fin(opts.strength, 1)));
  return {
    ok: true, text: `${TheName(civ)} would found a town of some ${approx(n)} here${from ? `, ${Math.round(DIST(from, { x, y }))} tiles from ${from.name}` : ''}.`,
    targets: civTargets(civ), rings: [{ x, y, r: 2, tone: 'boon' }],
    threads: from ? [{ x0: from.x, y0: from.y, x1: x, y1: y, tone: 'trade' }] : [],
  };
}

export function previewProsper(world, x, y, opts = {}) {
  if (!world.sys.civ) return notReady;
  const R = Math.max(1, Math.min(16, fin(opts.radius, 5)));
  const st = Math.max(0.25, fin(opts.strength, 1));
  const ss = settlementsNear(world, x, y, R).sort((a, b) => b.population - a.population);
  const pop = ss.reduce((a, s) => a + fin(s.population), 0);
  const hungry = ss.filter((s) => s.famine > 0).length;
  const names = ss.slice(0, 3).map((s) => s.name);
  const more = ss.length > 3 ? ` and ${ss.length - 3} more` : '';
  const text = ss.length
    ? `Plenty for ${ss.length} town${ss.length > 1 ? 's' : ''}: ${listJoin(names)}${more} — about ${approx(pop)} people fed for ${Math.round(6 * st)} months${hungry ? `, ending ${hungry > 1 ? `${hungry} famines` : 'a famine'}` : ''}.`
    : 'No town lies within reach; only the land would grow richer.';
  return { ok: true, text, targets: ss.slice(0, 12).map((s) => ({ kind: 'settlement', id: s.id })), rings: [{ x, y, r: R, tone: 'boon' }], estimate: { towns: ss.length, people: [Math.round(pop * 0.95), Math.round(pop)] }, severity: 0.3 };
}

export function previewEnlighten(world, x, y) {
  if (!world.sys.civ) return notReady;
  const civ = civAt(world, x, y);
  if (!civ) return { ok: false, reason: 'Hover over land ruled by a nation.' };
  const t = civ.tech?.research ? techDef(civ.tech.research) : null;
  const golden = fin(civ.goldenAge) > 0 ? 'its golden age would be lengthened' : 'a golden age would begin';
  const dark = fin(civ.darkAge) > 0 ? ', its dark age lifted' : '';
  return {
    ok: true, text: `${TheName(civ)} would ${t ? `grasp ${t.name.replace(/^The /, 'the ')} at once` : 'be filled with sudden insight'}${dark}, and ${golden}.`,
    targets: civTargets(civ), severity: 0.4,
  };
}

export function previewUnrest(world, x, y) {
  if (!world.sys.civ) return notReady;
  const s = settlementAtXY(world, x, y);
  if (!s) return { ok: false, reason: 'Hover over a settlement.' };
  const civ = world.civs[s.civId];
  if (!civ || !civ.alive) return { ok: false, reason: 'That settlement owes allegiance to no one.' };
  const rings = [{ x: s.x, y: s.y, r: 2, tone: 'bane' }];
  if (s.id !== civ.capitalId && civ.settlementIds.length > 1) {
    const origin = world.civs[s.originCivId];
    const friends = settlementsNear(world, s.x, s.y, 10, (o) => o.civId === civ.id && o.id !== s.id && o.id !== civ.capitalId && o.loyalty < 0.5 && o.unrest > 0.4).slice(0, 4);
    const back = origin && origin.alive && origin.id !== civ.id ? ` (or return to ${theName(origin)}, its old masters)` : '';
    const join = friends.length ? `; ${listJoin(friends.map((o) => o.name))} might join it` : '';
    const share = Math.round(100 * fin(s.population) / Math.max(1, fin(civ.population)));
    return { ok: true, text: `${s.name} (${fmtInt(s.population)}, ${share}% of the realm) would rise against ${theName(civ)}${back}${join}.`, targets: [{ kind: 'settlement', id: s.id }, ...friends.map((o) => ({ kind: 'settlement', id: o.id }))], rings, estimate: { towns: 1 + friends.length }, severity: 0.6 };
  }
  return { ok: true, text: `${s.name} is the heart of ${theName(civ)}: its government would fall${civ.ruler ? ` and ${rulerName(civ.ruler)} with it` : ''}.`, targets: [{ kind: 'settlement', id: s.id }, ...civTargets(civ)], rings, severity: 0.7 };
}

export function previewRuin(world, x, y, opts = {}) {
  if (!world.sys.civ) return notReady;
  const s = settlementAtXY(world, x, y);
  if (!s) return { ok: false, reason: 'Hover over a settlement.' };
  const sv = Math.max(0.2, Math.min(1, fin(opts.strength, 0.6)));
  const m = hasProviders('damage') ? mulOf('damage', world, s, 'ruin') : 1;
  const frac = Math.max(0, Math.min(1, 0.5 * sv * m));
  const dead = fin(s.population) * frac;
  const lo = Math.round(dead * 0.95), hi = Math.round(dead);
  const wiped = fin(s.population) - dead < 8;
  const text = wiped
    ? `${s.name} would be utterly destroyed (${fmtInt(s.population)} people).`
    : `${s.name} would lose ${fmtInt(lo)}–${fmtInt(hi)} of its ${fmtInt(s.population)} people; walls broken, granaries spoiled, fields burned.`;
  return { ok: true, text, targets: [{ kind: 'settlement', id: s.id }], rings: [{ x: s.x, y: s.y, r: (s.radius || 2) + 0.5, tone: 'bane' }], estimate: { deaths: [lo, hi], towns: 1 }, severity: Math.min(1, 0.4 + sv * 0.6) };
}

// ---------------------------------------------------------------------------
// Divine acts on rulers and realms (entity targets)

export function previewBless(world, x, y, opts = {}) {
  const t = rulerTarget(world, opts);
  if (t.err) return t.err;
  const { civ, ruler } = t;
  const plan = blessPlan(ruler);
  if (!plan.add && !plan.remove) return { ok: false, reason: `${rulerName(ruler)} has every virtue heaven can give.`, targets: civTargets(civ) };
  const parts = [];
  if (plan.remove) parts.push(`lose ${plan.remove === 'mad' ? 'madness' : `the ${plan.remove} temper`}`);
  if (plan.add) parts.push(`become ${plan.add}`);
  return { ok: true, text: `${rulerName(ruler)} would ${parts.join(' and ')}, gain legitimacy and live long under heaven's favour.`, targets: civTargets(civ), severity: 0.3 };
}

export function previewCurse(world, x, y, opts = {}) {
  const t = rulerTarget(world, opts);
  if (t.err) return t.err;
  const { civ, ruler } = t;
  const plan = cursePlan(ruler);
  if (!plan.add) return { ok: false, reason: `${rulerName(ruler)} is already as accursed as a ruler can be.`, targets: civTargets(civ) };
  const lose = plan.lose.length ? ` and lose ${listJoin(plan.lose.map((x) => `the ${x} temper`))}` : '';
  return { ok: true, text: `${rulerName(ruler)} would turn ${plan.add}${lose}; death would stalk ${ruler.gender === 'f' ? 'her' : 'him'}, and history would remember ${ruler.gender === 'f' ? 'her' : 'him'} as the Accursed.`, targets: civTargets(civ), severity: 0.6 };
}

export function previewSmite(world, x, y, opts = {}) {
  const t = rulerTarget(world, opts);
  if (t.err) return t.err;
  const { civ, ruler } = t;
  const h = ruler.heir;
  const dyn = isDynastic(civ.government);
  const age = h ? Math.floor((world.time.day - fin(h.born, world.time.day)) / DAYS_PER_YEAR) : null;
  // a realm holding a marriage claim may take the crown in a personal union
  let claimant = null;
  if (dyn && !h && !civ.flags?.heirSecured) {
    let best = 0.49;
    for (const o of world.civs) if (o && o.alive && o.id !== civ.id && fin(o.claims?.[civ.id], 0) > best) { best = o.claims[civ.id]; claimant = o; }
  }
  const next = !dyn ? 'a successor would be chosen by custom'
    : h ? `${h.name}, ${ruler.gender === 'f' ? 'her' : 'his'} ${h.relation || 'heir'}${age != null ? ` (${age})` : ''}, would inherit${age != null && age < 16 ? ' under a regent' : ''}`
      : civ.flags?.heirSecured ? 'a secured heir of the house would inherit'
        : claimant ? `with no heir in waiting, the crown might pass to ${theName(claimant)} by right of marriage — or fall into crisis`
          : 'with no heir in waiting, the succession may fall into crisis or war';
  return { ok: true, text: `${rulerName(ruler)} would be struck down; ${next}.`, targets: civTargets(civ), severity: 0.85 };
}

export function previewGrantHeir(world, x, y, opts = {}) {
  const t = rulerTarget(world, opts);
  if (t.err) return t.err;
  const { civ, ruler } = t;
  if (!isDynastic(civ.government)) return { ok: false, reason: `${TheName(civ)} does not pass its crown by blood.`, targets: civTargets(civ) };
  if (civ.flags?.heirSecured && ruler.heir) return { ok: false, reason: `The heir of ${rulerShort(ruler)} is already secured by heaven.`, targets: civTargets(civ) };
  const text = ruler.heir
    ? `Heaven would set its seal on ${ruler.heir.name}: no crisis could break the next succession.`
    : `A child would be born to ${rulerName(ruler)}, and the next succession could not fall into crisis.`;
  return { ok: true, text, targets: civTargets(civ), severity: 0.2 };
}

export function previewGiftTech(world, x, y, opts = {}) {
  if (!world.sys.civ) return notReady;
  const t = resolveTarget(world, opts?.target);
  const civ = t?.civ;
  if (!civ || !civ.alive) return { ok: false, reason: 'Choose a living nation.' };
  const list = giftableTechs(world, civ);
  if (!list.length) return { ok: false, reason: `${TheName(civ)} knows all it can learn for now.`, targets: civTargets(civ) };
  const id = opts.techId ?? null;
  if (id == null) return { ok: true, text: `${TheName(civ)} could be given any of ${list.length} arts: ${listJoin(list.slice(0, 4).map((q) => q.name))}${list.length > 4 ? '…' : ''}.`, targets: civTargets(civ) };
  const def = list.find((q) => q.id === id);
  if (!def) {
    const d = techDef(id);
    return { ok: false, reason: d ? `${TheName(civ)} cannot learn ${d.name} yet.` : 'Choose a technology.', targets: civTargets(civ) };
  }
  const st = world.sys.civ;
  const first = st.firstTech?.[id] == null;
  return { ok: true, text: `${TheName(civ)} would master ${def.name.replace(/^The /, 'the ')}${first ? ', the first people in the world to do so' : ''}${isArcane(def) ? ' (an arcane art)' : ''}.`, targets: civTargets(civ), severity: 0.3 };
}

export function previewCommission(world, x, y, opts = {}) {
  if (!world.sys.civ) return notReady;
  const t = resolveTarget(world, opts?.target);
  const s = t?.s;
  if (!s || !s.alive) return { ok: false, reason: 'Choose a living town.' };
  const civ = world.civs[s.civId];
  if (!civ || !civ.alive) return { ok: false, reason: `${s.name} owes allegiance to no one.` };
  const ch = wonderChoices(world, s, civ);
  const okList = ch.filter((c) => c.ok);
  if (!okList.length) return { ok: false, reason: `No wonder could rise in ${s.name} now${ch.length ? ` (${wonderLabel(ch[0].def)} ${ch[0].reason})` : ''}.`, targets: [{ kind: 'settlement', id: s.id }] };
  const kind = opts.kind ?? null;
  if (kind == null) return { ok: true, text: `${okList.length} wonder${okList.length > 1 ? 's' : ''} could rise in ${s.name}: ${listJoin(okList.slice(0, 4).map((c) => wonderLabel(c.def)))}${okList.length > 4 ? '…' : ''}.`, targets: [{ kind: 'settlement', id: s.id }] };
  const c = ch.find((q) => q.def.kind === kind);
  if (!c) return { ok: false, reason: `${wonderDef(kind) ? wonderLabel(wonderDef(kind)) : 'That wonder'} is not for ${s.name}.`, targets: [{ kind: 'settlement', id: s.id }] };
  if (!c.ok) return { ok: false, reason: `${wonderLabel(c.def)} ${c.reason}.`, targets: [{ kind: 'settlement', id: s.id }] };
  return { ok: true, text: `${wonderLabel(c.def)} would rise in ${s.name} in a single night, the pride of ${theName(civ)}.`, targets: [{ kind: 'settlement', id: s.id }], rings: [{ x: s.x, y: s.y, r: 2.5, tone: 'boon' }], severity: 0.4 };
}

export function previewRename(world, x, y, opts = {}) {
  if (!world.sys.civ) return notReady;
  const raw = opts.name ?? opts.text ?? '';
  if (!String(raw).trim()) {
    const t = resolveTarget(world, opts?.target);
    return t ? { ok: true, text: 'Type the new name; the chronicle will remember the old.' } : { ok: false, reason: 'Choose a town, a nation, a faith or a place to rename.' };
  }
  const p = renamePlan(world, opts?.target, raw);
  if (!p.ok) return p;
  const shown = p.kind === 'civ' ? styledPreview(p.ent, p.base) : p.name;
  return { ok: true, text: `${cap1(p.old)} would thenceforth be called ${shown}.` };
}
/** The styled name a realm would take with a new base name (pure). */
function styledPreview(civ, base) {
  const cur = civ.name || '';
  if (cur.includes(civ.baseName)) return 'the ' + cur.replace(civ.baseName, base);
  return 'the ' + cur.replace(civ.adjective, base);
}

export function previewDepose(world, x, y, opts = {}) {
  const t = rulerTarget(world, opts);
  if (t.err) return t.err;
  const { civ, ruler } = t;
  const dyn = isDynastic(civ.government);
  return {
    ok: true, text: `${rulerName(ruler)} would be cast down${dyn ? `, and ${civ.dynasty || 'the reigning house'} with ${ruler.gender === 'f' ? 'her' : 'him'}` : ''}; a new ruler would take power in ${theName(civ)}.`,
    targets: civTargets(civ), severity: 0.7,
  };
}

// ---------------------------------------------------------------------------
// Pair acts

const pickSettlement = (world, p) => (p && p.kind === 'settlement' ? world.settlements[p.id] || null : null);
const pickCiv = (world, p) => (p && p.kind === 'civ' ? world.civs[p.id] || null : p && p.kind === 'settlement' ? world.civs[world.settlements[p.id]?.civId] || null : null);

export function previewCede(world, x, y, opts = {}) {
  if (!world.sys.civ) return notReady;
  const s = pickSettlement(world, opts.a) || (!opts.a ? settlementAtXY(world, x, y) : null);
  if (!opts.a) return s ? { ok: true, text: `Choose ${s.name} first, then the nation that should receive it.`, targets: [{ kind: 'settlement', id: s.id }] } : { ok: false, reason: 'First choose the town to cede.' };
  const civ = pickCiv(world, opts.b) || civAt(world, x, y);
  const p = cedePlan(world, s, civ);
  if (!p.ok) return { ...p, targets: s ? [{ kind: 'settlement', id: s.id }] : [] };
  const cap = capOf(world, civ);
  const last = p.from.settlementIds.length === 1;
  const capital = p.from.capitalId === s.id;
  const tail = last ? `; it is the last town of ${theName(p.from)}, which would pass from history` : capital ? `; ${theName(p.from)} would lose its capital` : '';
  return {
    ok: true, text: `${s.name} (${fmtInt(s.population)}) would pass from ${theName(p.from)} to ${theName(civ)}${tail}.`,
    targets: [{ kind: 'settlement', id: s.id }, ...civTargets(civ)],
    threads: cap ? [{ x0: s.x, y0: s.y, x1: cap.x, y1: cap.y, tone: 'peace' }] : [], severity: last ? 0.8 : 0.4,
  };
}

export function previewSettlers(world, x, y, opts = {}) {
  if (!world.sys.civ) return notReady;
  if (!opts.a) {
    const s = settlementAtXY(world, x, y);
    return s ? { ok: true, text: `Choose ${s.name} to send settlers from, then the land where they should build.`, targets: [{ kind: 'settlement', id: s.id }] } : { ok: false, reason: 'First choose the town that sends the settlers.' };
  }
  const s = pickSettlement(world, opts.a);
  const tx = opts.b && Number.isFinite(opts.b.x) ? opts.b.x : x, ty = opts.b && Number.isFinite(opts.b.y) ? opts.b.y : y;
  const p = settlersPlan(world, s, tx, ty);
  if (!p.ok) return { ...p, rings: [{ x: tx, y: ty, r: 4, tone: 'bane' }] };
  const land = p.overseas ? landNameAt(world, p.x, p.y) : null;
  return {
    ok: true, text: `About ${fmtInt(p.n)} settlers would leave ${s.name} and found a town ${Math.round(p.d)} tiles away${p.overseas ? ` across the water${land ? ` on ${land}` : ''}` : ''}.`,
    targets: [{ kind: 'settlement', id: s.id }], rings: [{ x: p.x, y: p.y, r: 2, tone: 'boon' }],
    threads: [{ x0: s.x, y0: s.y, x1: p.x, y1: p.y, tone: 'trade' }], severity: 0.2,
  };
}

export function previewMarriage(world, x, y, opts = {}) {
  if (!world.sys.civ) return notReady;
  if (!opts.a) {
    const c = civAt(world, x, y);
    return c ? { ok: true, text: `Choose ${theName(c)} first, then the crown it should marry.`, targets: civTargets(c) } : { ok: false, reason: 'First choose a royal house.' };
  }
  const A = pickCiv(world, opts.a);
  const B = pickCiv(world, opts.b) || civAt(world, x, y);
  const chk = marriageCheck(world, A, B);
  if (!chk.ok) return chk;
  const ca = capOf(world, A), cb = capOf(world, B);
  const war = areAtWar(world, A.id, B.id);
  return {
    ok: !war, text: `${rulerName(A.ruler)} and ${rulerName(B.ruler)} would bind their houses; each crown would gain a claim on the other's throne.`,
    targets: [...civTargets(A), ...civTargets(B)], threads: ca && cb ? [{ x0: ca.x, y0: ca.y, x1: cb.x, y1: cb.y, tone: 'marriage' }] : [], severity: 0.2,
  };
}
