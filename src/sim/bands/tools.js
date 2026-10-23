// Bands · god tools (group 'myth', "Stir the Uncanny"; Mythic worlds only):
//   summon_beast  a map tool: call a monster out of the ground or the deep. The Might slider
//                 chooses troll, wyvern, giant or — on high ground — a dragon; deep water gives
//                 a kraken. The preview shows the beast, its hunting range and the towns in reach.
//   slay_beast    an entity tool on a band: a champion of the realm that owns the ground (or the
//                 nearest) goes against the beast, the gods at their back. The preview shows the
//                 odds; success ends the beast as any slaying does (dragons: hoard, bones, legend).
//   tame_beast    an entity tool on a band: bend the beast to that realm's will. Odds follow the
//                 realm's taming (WP5 mod key) and its people's knack; failure enrages the beast.
// Previews are pure (no rng, no mutation): names and outcomes are drawn only in apply.

import { registerTool } from '../../core/tools.js';
import { getBand, nearestSettlement, settlementsNear } from '../../core/entities.js';
import { emitFx } from '../../core/world.js';
import { mythOn } from '../../core/params.js';
import { WATER, BIOME, BAND_KINDS, DAYS_PER_MONTH } from '../../core/constants.js';
import { clamp } from '../../core/util.js';
import { isBeast, bandPower, aliveOf } from './engine.js';
import { planRoute } from './move.js';
import { heroOdds, heroAttempt } from './hunts.js';
import { spawnBeast, tame, TAMABLE, tamingOf } from './kinds/beasts.js';
import { spawnDragon, MAX_DRAGONS } from './kinds/dragons.js';
import { say, pick, cap, civName, bandName, BandName, placePhrase, whereFor } from './prose.js';
import { slayerTitle } from './names.js';

const RANGE = { troll: 8, wyvern: 12, giant: 8, dragon: 35, kraken: 10 };
const POWER_HINT = { troll: [40, 120], wyvern: [80, 200], giant: [150, 400], dragon: [1500, 3600], kraken: [300, 900] };
const notMythic = { ok: false, message: 'Only in a Mythic world do such things answer.' };

/** The kind a summons at (x, y) with this might would call, or { kind: null, reason }. Pure. */
function summonKind(world, x, y, strength) {
  const i = y * world.W + x;
  const f = world.f;
  if (f.water[i] !== WATER.LAND) {
    if (f.biome[i] !== BIOME.DEEP_OCEAN) return { kind: null, reason: 'The water here is too shallow for anything that answers from the deep.' };
    return { kind: 'kraken' };
  }
  if (f.settle[i] >= 0) return { kind: null, reason: 'Monsters do not rise in the market square; choose wilder ground.' };
  const s = Number.isFinite(strength) ? strength : 1;
  if (s >= 2.25) {
    if (f.elevation[i] < 0.7) return { kind: 'giant', note: 'Dragons need high ground; a giant answers instead.' };
    if (aliveOf(world, 'dragon') >= MAX_DRAGONS) return { kind: 'giant', note: `The world already holds ${MAX_DRAGONS} dragons; a giant answers instead.` };
    return { kind: 'dragon' };
  }
  if (s >= 1.5) return { kind: 'giant' };
  if (s >= 0.75) return { kind: 'wyvern' };
  return { kind: 'troll' };
}

registerTool({
  id: 'summon_beast', label: 'Summon Beast', group: 'myth', icon: 'summon', order: 40, target: 'tile', radius: 0,
  desc: 'Call a monster out of the wild. Might chooses a troll, a wyvern, a giant or, on high ground, a dragon; deep water gives a kraken.',
  strength: { label: 'Might', min: 0, max: 3, default: 1 },
  polarity: 'bane',
  available: (w) => mythOn(w),
  danger: (opts) => (opts?.strength ?? 1) >= 2.25,
  preview(world, x, y, opts = {}) {
    if (!mythOn(world)) return { ok: false, reason: notMythic.message };
    if (!(x >= 0 && y >= 0 && x < world.W && y < world.H)) return { ok: false, reason: 'Off the edge of the world.' };
    const k = summonKind(world, x, y, opts.strength);
    if (!k.kind) return { ok: false, reason: k.reason };
    const reach = RANGE[k.kind];
    const towns = settlementsNear(world, x, y, reach).sort((a, b) => b.population - a.population).slice(0, 6);
    const label = BAND_KINDS[k.kind].label.toLowerCase();
    const [lo, hi] = POWER_HINT[k.kind];
    const text = `${cap(k.note ? k.note + ' ' : '')}A ${label} will rise here and hunt within ${reach} leagues${towns.length ? `: ${towns.length} town${towns.length === 1 ? '' : 's'} in reach (${towns.slice(0, 3).map((s) => s.name).join(', ')}${towns.length > 3 ? '…' : ''})` : ', where no one lives yet'}.`;
    return {
      ok: true, text, severity: clamp(hi / 4000, 0.1, 1),
      rings: [{ x, y, r: reach, tone: 'bane' }],
      targets: towns.map((s) => ({ kind: 'settlement', id: s.id })),
      estimate: { towns: towns.length },
      cards: [{ id: k.kind, label: BAND_KINDS[k.kind].label, p: 1, effects: [`power ${lo}–${hi}`, `range ${reach} tiles`], actions: [] }],
    };
  },
  apply(world, x, y, opts = {}) {
    if (!mythOn(world)) return notMythic;
    const k = summonKind(world, x, y, opts.strength);
    if (!k.kind) return { ok: false, message: k.reason };
    const i = y * world.W + x;
    let band;
    if (k.kind === 'dragon') {
      const v = Math.abs((y / world.H) * 2 - 1) > 0.55 ? 'frost' : 'fire';
      band = spawnDragon(world, { i, variety: v, volcano: null }, { asleep: false });
      band.data.nextRaid = world.time.day + DAYS_PER_MONTH;
    } else {
      band = spawnBeast(world, k.kind, i, { state: 'lair', summoned: true, quiet: true });
      // summoned things are hungry: they go for the nearest town at once
      let best = null, bd = Infinity;
      for (const s of settlementsNear(world, x, y, RANGE[k.kind])) { const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = s; } }
      if (best && planRoute(world, band, best.i)) { band.state = 'raid'; band.targetSid = best.id; }
    }
    emitFx(world, { type: 'summon', x, y, r: k.kind === 'dragon' ? 3 : 2, color: '#a98be6', src: 'tool' });
    const where = whereFor(k.kind === 'kraken' ? placePhrase(world, x, y, true) : placePhrase(world, x, y), band.name);
    say(world, band, {
      cat: 'divine', imp: 3, key: 'divine.summon', x, y,
      text: pick(world, [
        `At an unseen summons, ${bandName(band)} rose ${where || 'out of the earth'}.`,
        `The sky darkened ${where || 'over the wild country'}, and when it cleared ${bandName(band)} was there, and hungry.`,
      ]),
    });
    return { ok: true, message: `${BandName(band)} has answered the summons.`, ref: { k: 'band', id: band.id } };
  },
});

// ---------------------------------------------------------------------------
// Entity tools on a band

/** The band an entity-tool call means: opts.target / args target, or the beast nearest (x, y). Pure. */
function bandFor(world, x, y, opts) {
  const t = opts?.target;
  if (t && t.kind === 'band') return getBand(world, t.id);
  if (Number.isFinite(opts?.bandId)) return getBand(world, opts.bandId);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let best = null, bd = 9;
  for (const b of world.bands) { const d = (b.x - x) ** 2 + (b.y - y) ** 2; if (isBeast(b) && d < bd) { bd = d; best = b; } }
  return best;
}

/** The realm a god would act through for this band: the owner of the ground, else the nearest. Pure. */
function championRealm(world, band) {
  const i = Math.round(band.y) * world.W + Math.round(band.x);
  const o = world.f.owner[i];
  if (o >= 0 && world.civs[o]?.alive && o !== band.civId) return world.civs[o];
  const s = nearestSettlement(world, band.x, band.y, { maxDist: 45, filter: (q) => q.civId !== band.civId });
  return s ? world.civs[s.civId] : null;
}

const divineOdds = (world, civ, band) => clamp(heroOdds(world, civ, band) + 0.25, 0.05, 0.9);

/** Odds a god's hand gives a taming: the realm's beast-craft and its people's knack. Pure. */
export function tameOdds(world, civ, band) {
  if (!band || !isBeast(band) || band.kind === 'kraken' || band.kind === 'undead') return 0;
  const t = tamingOf(civ);
  if (band.kind === 'dragon') return clamp(0.1 + 0.3 * t, 0.05, 0.5);
  const knack = TAMABLE[band.kind] && civ && TAMABLE[band.kind].includes(civ.race) ? 0.15 : 0;
  return clamp(0.35 + 0.5 * t + knack, 0.05, 0.95);
}

registerTool({
  id: 'slay_beast', label: 'Send a Hero', group: 'myth', icon: 'slay', order: 50, target: 'entity', entity: { kinds: ['band'] },
  desc: 'Send a champion of the nearest realm, the gods at their back, against this beast. Small, wounded and sleeping beasts fall more easily.',
  polarity: 'boon',
  available: (w) => mythOn(w),
  preview(world, x, y, opts = {}) {
    if (!mythOn(world)) return { ok: false, reason: notMythic.message };
    const band = bandFor(world, x, y, opts);
    if (!band) return { ok: false, reason: 'There is no beast there.' };
    if (!isBeast(band)) return { ok: false, reason: 'Heroes are sent against beasts; outlaws are a matter for the realm.' };
    const civ = championRealm(world, band);
    if (!civ) return { ok: false, reason: 'No realm is near enough to send a champion.' };
    const p = divineOdds(world, civ, band);
    return {
      ok: true, text: `A champion of ${civName(civ)} would go against ${bandName(band)}: ${Math.round(p * 100)}% to slay it, else the hero dies.`,
      targets: [{ kind: 'band', id: band.id }, { kind: 'civ', id: civ.id }], severity: 1 - p,
      cards: [{ id: 'hero', label: 'Send a hero', p, effects: band.kind === 'dragon' ? ['the hoard to the slayer', 'dragonbone in the lair', `a legend: ${slayerTitle(band, world)}`] : ['the beast slain', 'a hero of legend'], actions: [{ id: 'go', label: 'Send' }] }],
    };
  },
  applyEntity(world, target, args = {}) {
    if (!mythOn(world)) return notMythic;
    const band = target && target.kind === 'band' ? getBand(world, target.id) : null;
    if (!band || !isBeast(band)) return { ok: false, message: 'There is no beast to slay.' };
    const civ = championRealm(world, band);
    if (!civ) return { ok: false, message: 'No realm is near enough to send a champion.' };
    const p = divineOdds(world, civ, band);
    // the gods' favour is folded into a hero's odds for this one attempt
    const r = heroAttempt(world, civ, band, { divine: true, p });
    emitFx(world, { type: r.slain ? 'slay' : 'curse', x: band.x, y: band.y, r: 2, src: 'tool' });
    return r.slain
      ? { ok: true, message: `${cap(r.hero)} of ${civName(civ)} slew ${bandName(band)}.` }
      : { ok: true, message: `${cap(r.hero)} of ${civName(civ)} fell to ${bandName(band)} (${Math.round(p * 100)}% odds).` };
  },
});

registerTool({
  id: 'tame_beast', label: 'Tame Beast', group: 'myth', icon: 'tame', order: 60, target: 'entity', entity: { kinds: ['band'] },
  desc: 'Bend this beast to the will of the realm that owns the ground beneath it, or the nearest. A refused beast turns on that realm.',
  polarity: 'neutral',
  available: (w) => mythOn(w),
  preview(world, x, y, opts = {}) {
    if (!mythOn(world)) return { ok: false, reason: notMythic.message };
    const band = bandFor(world, x, y, opts);
    if (!band || !isBeast(band)) return { ok: false, reason: 'There is no beast there.' };
    if (band.state === 'tamed') return { ok: false, reason: `${BandName(band)} already answers to ${civName(world.civs[band.civId])}.` };
    const civ = championRealm(world, band);
    if (!civ) return { ok: false, reason: 'No realm is near enough to take it.' };
    const p = tameOdds(world, civ, band);
    if (p <= 0) return { ok: false, reason: `${BandName(band)} cannot be tamed.` };
    return {
      ok: true, text: `${cap(civName(civ))} would gain ${bandName(band)} (${Math.round(p * 100)}%); refused, it turns on them.`,
      targets: [{ kind: 'band', id: band.id }, { kind: 'civ', id: civ.id }], severity: 1 - p,
      cards: [{ id: 'tame', label: 'Tame', p, effects: [`+${Math.round(0.5 * bandPower(band))} to the strongest army of ${civName(civ)}`], actions: [{ id: 'go', label: 'Tame' }] }],
    };
  },
  applyEntity(world, target) {
    if (!mythOn(world)) return notMythic;
    const band = target && target.kind === 'band' ? getBand(world, target.id) : null;
    if (!band || !isBeast(band) || band.state === 'tamed') return { ok: false, message: 'There is no wild beast to tame.' };
    const civ = championRealm(world, band);
    if (!civ) return { ok: false, message: 'No realm is near enough to take it.' };
    const p = tameOdds(world, civ, band);
    if (p <= 0) return { ok: false, message: `${BandName(band)} cannot be tamed.` };
    if (world.rng.chance(p)) {
      tame(world, band, civ, { divine: true });
      return { ok: true, message: `${BandName(band)} now answers to ${civName(civ)}.` };
    }
    // refused: it turns on the realm that tried to chain it
    const s = nearestSettlement(world, band.x, band.y, { civId: civ.id, maxDist: 40 });
    if (s && planRoute(world, band, s.i)) { band.state = 'raid'; band.targetSid = s.id; }
    emitFx(world, { type: 'curse', x: band.x, y: band.y, r: 1.5, src: 'tool' });
    say(world, band, { cat: 'divine', imp: 2, key: 'divine.tame.failed', civId: civ.id, text: `${BandName(band)} would not be bound; it broke free in a fury and turned on ${civName(civ)}${s ? `, making for ${s.name}` : ''}.` });
    return { ok: true, message: `${BandName(band)} refused the chain and turns on ${civName(civ)}.` };
  },
});

