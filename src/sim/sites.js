// The historic-sites recorder: the land remembers where things happened. Hook-driven
// (contracts §5, §10): battles and sieges become battlefields that grow with every clash
// fought there, destroyed towns leave ruins (with a snapshot of what they were), falling
// stars leave craters, great eruptions and quakes mark the ground, plagues leave pits where a
// town lost a quarter of its people, sunken fleets leave wrecks, peace is remembered where it
// was made, and every faith's holy city is a holy site. Writes only through core/sites.js
// addSite / updateSite; draws no rng.
//
// Naming: site.name is the place (a battlefield "the Tiren Fords", a ruin, siege, plague pit,
// treaty ground or holy site the town's name, an eruption the mountain's name, a crater or
// quake the nearest town or feature); the UI composes "the Siege of X", "Ancient X",
// "the Peace of X" from the kind. site.data per kind:
//   battle  { names: [≤ 4 battle names], w: { civId: wins }, big: most dead in one battle }
//   siege   { o: { captured, razed, lifted, broken }, days: longest }
//   ruin    { peak, maxTier, buildings, civId, originCivId, wonderIds, cause, fellDay, sid }
//           (unpinned; a town that falls again where it fell before updates its ruin)
//   crater  { r, ocean } · eruption { vei } · quake { mag } · plaguepit { pid, frac, sid }
//   wreck   { cause } · treaty { wars: [≤ 4 war ids], outcome } · holy { rid, sid }

import { addSite, updateSite, sitesNear } from '../core/sites.js';
import { on } from '../core/hooks.js';
import { touchRecord } from '../core/keyframe.js';
import { DAYS_PER_YEAR } from '../core/constants.js';
import { placeName } from './catalogue.js';

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const MIN_BATTLE_DEAD = 80;

/** "the Second Battle of the Tiren Fords" → "the Tiren Fords" (the place the battles share). */
export function battlePlace(name) {
  if (!name) return null;
  const m = /^(?:the\s+)?(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|great|\d+(?:st|nd|rd|th))\s+)?(?:battle|siege|sack|fall|rout|clash|skirmish|massacre|stand|storming|defen[cs]e|relief|fight|slaughter|disaster|engagement|sea[- ]battle)\s+(?:of|at|on|by|near|for|before|off|in|upon)\s+(.+)$/i.exec(String(name).trim());
  if (!m) return null;
  // "the Ouelo River Fords in Year 409" → "the Ouelo River Fords": battles share a place, not a year
  return m[1].replace(/\s*,?\s+(?:in|of)\s+(?:the\s+)?(?:year\s+)?\d+\s*$/i, '').replace(/\s*\((?:year\s+)?\d+\)\s*$/i, '').trim() || null;
}

function stats(world) { return (world.sys.stats ||= {}); }

export const HANDLERS = {
  battle(world, b) {
    if (!b) return;
    const dead = fin(b.dead?.a) + fin(b.dead?.d);
    // a field the land remembers: a great battle, a named one of some size, or a real slaughter
    // for its age (skirmishes of a few dozen would bury the map, and the 600-site cap, in crosses)
    const big = Math.max(MIN_BATTLE_DEAD, fin(world.stats?.pop) * 0.00025);
    if (!b.great && dead < big && !(b.name && dead >= MIN_BATTLE_DEAD / 2)) return;
    const naval = b.kind === 'naval';
    const kind = b.kind === 'siege' ? 'siege' : naval ? 'wreck' : 'battle';
    if (naval && dead < 100) return;
    const civIds = [b.winnerCivId, b.loserCivId].filter((id) => Number.isFinite(id) && id >= 0);
    const place = battlePlace(b.name) || (b.name && !/^an?\s/i.test(b.name) ? b.name : null);
    const site = addSite(world, {
      kind, x: fin(b.x), y: fin(b.y), i: Number.isFinite(b.i) ? b.i : undefined,
      name: kind === 'battle' ? place : kind === 'wreck' ? (place || placeName(world, b.x, b.y)) : place,
      dead, civIds,
      ref: b.warId != null ? { k: 'war', id: b.warId } : b.bandId != null ? { k: 'band', id: b.bandId } : null,
    });
    if (!site || !world.sites.includes(site)) return;
    const d = site.data || {};
    const names = Array.isArray(d.names) ? d.names.slice() : [];
    if (b.name && !names.includes(b.name)) { names.push(b.name); if (names.length > 4) names.shift(); }
    const wins = { ...(d.w || {}) };
    if (Number.isFinite(b.winnerCivId) && b.winnerCivId >= 0) wins[b.winnerCivId] = (wins[b.winnerCivId] | 0) + 1;
    updateSite(world, site.id, kind === 'wreck' ? { cause: 'battle', names } : { names, w: wins, big: Math.max(fin(d.big), Math.round(dead)) });
  },

  siegeEnded(world, q) {
    if (!q) return;
    const s = world.settlements[q.sid];
    if (!s) return;
    const days = fin(q.days);
    const decisive = q.outcome === 'captured' || q.outcome === 'razed';
    if (!decisive && days < 60) return;
    const site = addSite(world, {
      kind: 'siege', x: s.x, y: s.y, i: s.i, name: s.name,
      civIds: [q.civId, s.civId], ref: { k: 'settlement', id: s.id },
    });
    if (!site || !world.sites.includes(site)) return;
    const o = { ...(site.data?.o || {}) };
    o[q.outcome || 'lifted'] = (o[q.outcome || 'lifted'] | 0) + 1;
    updateSite(world, site.id, { o, days: Math.max(fin(site.data?.days), Math.round(days)) });
  },

  settlementDestroyed(world, s, cause) {
    if (!s) return;
    const life = fin(s.destroyedDay, world.time.day) - fin(s.foundedDay);
    const peak = fin(s.peakPopulation);
    const maxTier = Math.max(fin(s.tier), fin(s.flags?.maxTier));
    // a camp that lived a few seasons leaves nothing worth a name on the map
    if (peak < 200 && life < 25 * DAYS_PER_YEAR && maxTier < 2) return;
    const wonderIds = [];
    for (const w of world.wonders || []) if (w && w.sid === s.id) wonderIds.push(w.id);
    // ruins are not pinned (contracts §10): they hold their place under the 600-site cap by
    // weight and fame (a great city's ruin outscores any battlefield)
    const data = {
      peak: Math.round(peak), maxTier, buildings: { ...(s.buildings || {}) }, civId: s.civId,
      originCivId: s.originCivId, wonderIds, cause: cause || s.destroyCause || 'abandoned',
      fellDay: fin(s.destroyedDay, world.time.day), sid: s.id,
      // what its library kept (civ/knowledge.js), unless it burned with the town
      ...(Array.isArray(s.archive) && s.archive.length && (cause || s.destroyCause) !== 'razed' ? { archive: s.archive.slice() } : {}),
    };
    const site = addSite(world, {
      kind: 'ruin', x: s.x, y: s.y, i: s.i, name: s.name,
      firstDay: fin(s.foundedDay), dead: 0, fame: Math.log1p(peak) / 3 + wonderIds.length,
      civIds: [s.civId, s.originCivId], ref: { k: 'settlement', id: s.id }, data,
    });
    // a town rebuilt on its own ruins and fallen again: one ruin, remembering its last fall
    // and its greatest days
    if (site && world.sites.includes(site) && site.data && site.data.sid !== s.id) {
      const old = site.data;
      updateSite(world, site.id, {
        ...data, peak: Math.max(fin(old.peak), data.peak), maxTier: Math.max(fin(old.maxTier), maxTier),
        wonderIds: [...new Set([...(Array.isArray(old.wonderIds) ? old.wonderIds : []), ...wonderIds])],
      });
      touchRecord(world, site);   // (keyframes share a site's copy until it changes)
      site.fame = Math.max(site.fame, Math.log1p(Math.max(fin(old.peak), peak)) / 3 + site.data.wonderIds.length);
    }
  },

  impact(world, q) {
    if (!q || q.ocean) return;
    addSite(world, {
      kind: 'crater', x: fin(q.x), y: fin(q.y), name: placeName(world, q.x, q.y, { ruins: true }),
      dead: fin(q.deaths), fame: 1 + fin(q.r) / 2, data: { r: Math.round(fin(q.r) * 10) / 10 },
    });
  },

  eruption(world, q) {
    if (!q || fin(q.vei) < 5) return;
    const v = q.volcanoId != null ? world.volcanoes.find((o) => o.id === q.volcanoId) : null;
    const site = addSite(world, {
      kind: 'eruption', x: fin(q.x, v?.x), y: fin(q.y, v?.y), name: v?.name || q.name || null,
      dead: fin(q.deaths), ref: v ? { k: 'volcano', id: v.id } : null,
    });
    if (site && world.sites.includes(site)) updateSite(world, site.id, { vei: Math.max(fin(site.data?.vei), fin(q.vei)) });
  },

  quake(world, q) {
    if (!q || fin(q.mag) < 7.5) return;
    const site = addSite(world, { kind: 'quake', x: fin(q.x), y: fin(q.y), name: placeName(world, q.x, q.y), dead: fin(q.deaths), fame: 1 + (fin(q.mag) - 7.5) + Math.log1p(fin(q.deaths)) / 4 });
    if (site && world.sites.includes(site)) updateSite(world, site.id, { mag: Math.max(fin(site.data?.mag), Math.round(fin(q.mag) * 10) / 10) });
  },

  plagueDeaths(world, q) {
    if (!q || !(q.deaths > 0)) return;
    const s = world.settlements[q.sid];
    if (!s) return;
    const pp = (stats(world).pp ||= {});
    const per = (pp[q.pid] ||= {});
    const cur = per[q.sid];
    if (cur) cur[0] += fin(q.deaths);
    else per[q.sid] = [fin(q.deaths), fin(s.population) + fin(q.deaths)];
  },

  plagueEnded(world, p) {
    if (!p) return;
    const pp = stats(world).pp;
    const per = pp && pp[p.id];
    let made = 0;
    if (per) {
      // the worst-struck towns first, at most four pits per plague
      const rows = Object.entries(per).map(([sid, [dead, pop0]]) => [Number(sid), dead, pop0 > 0 ? dead / pop0 : 0]).sort((a, b) => b[2] - a[2] || a[0] - b[0]);
      for (const [sid, dead, frac] of rows) {
        if (made >= 4 || frac < 0.25 || dead < 30) break;
        if (plaguePit(world, p, sid, dead, frac)) made++;
      }
      delete pp[p.id];
    }
    if (!made && p.worst && fin(p.worst.frac) >= 0.25) {
      const s = world.settlements[p.worst.sid];
      if (s) plaguePit(world, p, s.id, fin(s.peakPopulation) * fin(p.worst.frac), fin(p.worst.frac));
    }
  },

  bandRaid(world, q) {
    if (!q || !(fin(q.sunk) > 0)) return;
    const band = (world.bands || []).find((b) => b.id === q.bandId);
    const s = q.sid != null ? world.settlements[q.sid] : null;
    const x = fin(band?.x, s?.x), y = fin(band?.y, s?.y);
    if (!band && !s) return;
    addSite(world, { kind: 'wreck', x, y, name: placeName(world, x, y), dead: fin(q.deaths), civIds: s ? [s.civId] : [], ref: { k: 'band', id: q.bandId }, data: { cause: 'raid' } });
  },

  stormEnded(world, q) {
    if (!q || !(fin(q.sunk) > 0) || !Array.isArray(q.track) || !q.track.length) return;
    const p = q.track.reduce((a, t) => (fin(t[2]) > fin(a[2]) ? t : a), q.track[0]);
    addSite(world, { kind: 'wreck', x: fin(p[0]), y: fin(p[1]), name: placeName(world, p[0], p[1]), dead: fin(q.deaths), ref: q.id != null ? { k: 'storm', id: q.id } : null, data: { cause: 'storm' } });
  },

  warEnded(world, war) {
    if (!war) return;
    const long = fin(war.endDay, world.time.day) - fin(war.startDay) >= DAYS_PER_YEAR;
    if (!long && fin(war.battles) < 5 && !(war.captured && war.captured.length)) return;
    if (war.outcome === 'annihilation') return;
    // peace is made at the loser's hearth: its capital, else the victor's
    const lose = war.outcome === 'attackers' ? war.defenders : war.outcome === 'defenders' ? war.attackers : war.defenders;
    const win = lose === war.defenders ? war.attackers : war.defenders;
    const capOf = (ids) => { for (const id of ids || []) { const c = world.civs[id]; const s = c && c.alive && c.capitalId != null ? world.settlements[c.capitalId] : null; if (s && s.alive) return s; } return null; };
    const s = capOf(lose) || capOf(win);
    if (!s) return;
    let toll = 0;
    for (const k in war.casualties || {}) toll += fin(war.casualties[k]);
    // a peace is remembered by the war it ended
    const site = addSite(world, { kind: 'treaty', x: s.x, y: s.y, i: s.i, name: s.name, fame: 1.5 + Math.log1p(toll) / 4, civIds: [...(war.attackers || []).slice(0, 2), ...(war.defenders || []).slice(0, 2)], ref: { k: 'war', id: war.id } });
    if (!site || !world.sites.includes(site)) return;
    const wars = Array.isArray(site.data?.wars) ? site.data.wars.slice() : [];
    if (!wars.includes(war.id)) { wars.push(war.id); if (wars.length > 4) wars.shift(); }
    updateSite(world, site.id, { wars, outcome: war.outcome || 'white_peace', sid: s.id });
  },

  religionFounded(world, r) {
    if (!r) return;
    const s = r.holyCityId != null ? world.settlements[r.holyCityId] : null;
    if (!s) return;
    const site = addSite(world, { kind: 'holy', x: s.x, y: s.y, i: s.i, name: s.name, fame: 1.5, civIds: [s.civId], ref: { k: 'religion', id: r.id } });
    if (site && world.sites.includes(site)) {
      const rids = Array.isArray(site.data?.rids) ? site.data.rids.slice() : [];
      if (!rids.includes(r.id)) { rids.push(r.id); if (rids.length > 4) rids.shift(); }
      updateSite(world, site.id, { rid: rids[0], rids, sid: s.id });
    }
  },
};

function plaguePit(world, p, sid, dead, frac) {
  const s = world.settlements[sid];
  if (!s) return false;
  if (sitesNear(world, s.x, s.y, 0.5, 'plaguepit').some((q) => q.ref && q.ref.k === 'plague' && q.ref.id === p.id)) return false;
  const site = addSite(world, { kind: 'plaguepit', x: s.x, y: s.y, i: s.i, name: s.name, dead: Math.round(dead), civIds: [s.civId], ref: { k: 'plague', id: p.id } });
  if (site && world.sites.includes(site)) updateSite(world, site.id, { pid: p.id, frac: Math.round(frac * 100) / 100, sid: s.id });
  return true;
}

for (const [name, fn] of Object.entries(HANDLERS)) on(name, fn);

/** Ruins for towns destroyed before the recorder existed (old saves). Idempotent; stats.init. */
export function seedRuins(world) {
  if (stats(world).ruinsSeeded) return;
  stats(world).ruinsSeeded = true;
  const have = new Set();
  for (const site of world.sites) if (site.kind === 'ruin' && site.data && site.data.sid != null) have.add(site.data.sid);
  for (const s of world.settlements) if (s && !s.alive && !have.has(s.id)) HANDLERS.settlementDestroyed(world, s, s.destroyCause);
}

/** Ruins of saves made while ruins were pinned rejoin the 600-site budget. Idempotent; stats.init. */
export function unpinRuins(world) {
  if (stats(world).ruinsUnpinned) return;
  stats(world).ruinsUnpinned = true;
  for (const site of world.sites) if (site.kind === 'ruin' && site.pinned) { site.pinned = false; touchRecord(world, site); }
}

/** Counts by kind (reports). */
export function siteStats(world) {
  const out = { n: 0, pinned: 0, byKind: {} };
  for (const s of world.sites || []) {
    out.n++;
    if (s.pinned) out.pinned++;
    out.byKind[s.kind] = (out.byKind[s.kind] || 0) + 1;
  }
  return out;
}
