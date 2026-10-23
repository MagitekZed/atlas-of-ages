// Historic sites: places the world remembers — battlefields, sieges, ruins, craters, wrecks,
// plague pits, treaty grounds, holy places, graves, and (pinned) ley nodes and lairs. Recorders
// call addSite; repeated events at one place merge into a single site that grows in fame.
// Only this API writes world.sites (ids from world.nextId.site).
//
// site = { id, kind, x, y, i, name|null, firstDay, lastDay, n (events merged), dead,
//          civIds: [≤ 4], ref|null, fame, pinned, data: {} }
// Ruin data (WP6 creates, WP1 updates): { peak, maxTier, buildings, civId, originCivId,
//          wonderIds, cause, fellDay, sid }.
// Writers: WP6 (history kinds), WP5 (node), WP2 (lair, grave), WP1 (ruin data updates).

import { bumpVersion } from './world.js';
import { touchRecord } from './keyframe.js';
import { DAYS_PER_YEAR } from './constants.js';

/** mergeR in tiles, eviction weight, minimum map zoom to draw; pinned kinds are never evicted. */
export const SITE_KINDS = {
  battle: { label: 'Battlefield', mergeR: 1.5, weight: 1, minZoom: 12 },
  siege: { label: 'Siege', mergeR: 0.6, weight: 1, minZoom: 12 },
  ruin: { label: 'Ruin', mergeR: 0.4, weight: 2, minZoom: 7 },
  crater: { label: 'Crater', mergeR: 2, weight: 3, minZoom: 6 },
  eruption: { label: 'Eruption', mergeR: 1, weight: 2, minZoom: 8 },
  quake: { label: 'Quake', mergeR: 2, weight: 1, minZoom: 10 },
  wreck: { label: 'Wreck', mergeR: 1, weight: 1, minZoom: 14 },
  plaguepit: { label: 'Plague pit', mergeR: 0.4, weight: 1, minZoom: 14 },
  treaty: { label: 'Treaty ground', mergeR: 0.6, weight: 1, minZoom: 14 },
  holy: { label: 'Holy site', mergeR: 0.4, weight: 2, minZoom: 10 },
  grave: { label: 'Grave', mergeR: 0.6, weight: 1, minZoom: 16 },
  node: { label: 'Ley node', mergeR: 0, weight: 0, minZoom: 3, pinned: true },
  lair: { label: 'Lair', mergeR: 0, weight: 0, minZoom: 8, pinned: true },
};
export const MAX_SITES = 600;   // unpinned sites

const DEFAULT_KIND = { mergeR: 0, weight: 1, minZoom: 12 };
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function unionCivs(into, ids) {
  for (const id of ids || []) {
    if (id == null || id < 0 || into.includes(id)) continue;
    if (into.length >= 4) break;
    into.push(id);
  }
  return into;
}

/** Eviction score: higher survives. */
function score(world, s) {
  const w = (SITE_KINDS[s.kind] || DEFAULT_KIND).weight || 0;
  return s.fame + w + Math.log1p(s.n) - (world.time.day - s.firstDay) / DAYS_PER_YEAR / 1000;
}

/**
 * Record an event at a place. props: { kind, x, y, i?, name?, dead?, civIds?, ref?, pinned?,
 * fame?, data? }. Merges into the nearest same-kind unpinned site within the kind's mergeR when
 * their names agree (or either is unnamed): n += 1, dead added, lastDay updated, civIds
 * unioned (≤ 4), fame += log1p(dead) / 4. Otherwise creates a site. Over 600 unpinned sites
 * the lowest score (fame + weight + log1p(n) − ageYears/1000; ties → lowest id) is evicted —
 * possibly the new one. Returns the site.
 */
export function addSite(world, props = {}) {
  const kind = String(props.kind || 'battle');
  const meta = SITE_KINDS[kind] || DEFAULT_KIND;
  const day = world.time.day;
  const x = fin(props.x), y = fin(props.y);
  const i = Number.isFinite(props.i) ? props.i
    : Math.max(0, Math.min(world.H - 1, Math.round(y))) * world.W + Math.max(0, Math.min(world.W - 1, Math.round(x)));
  const dead = Math.max(0, fin(props.dead));
  const pinned = props.pinned != null ? Boolean(props.pinned) : Boolean(meta.pinned);
  const name = props.name ? String(props.name) : null;
  const sites = world.sites;

  if (!pinned && meta.mergeR > 0) {
    // nearest candidate within mergeR; sites are kept in id order, so ties go to the oldest
    let best = null, bd = meta.mergeR * meta.mergeR;
    for (const s of sites) {
      if (s.kind !== kind || s.pinned) continue;
      if (name && s.name && s.name !== name) continue;
      const dx = s.x - x, dy = s.y - y, d = dx * dx + dy * dy;
      if (d <= bd && (!best || d < bd)) { best = s; bd = d; }
    }
    if (best) {
      touchRecord(world, best);   // keyframes share a site's copy until it changes
      best.n += 1;
      best.dead += dead;
      best.lastDay = day;
      unionCivs(best.civIds, props.civIds);
      best.fame += Math.log1p(dead) / 4;
      if (!best.name && name) best.name = name;
      if (!best.ref && props.ref) best.ref = { k: props.ref.k, id: props.ref.id ?? null };
      bumpVersion(world, 'sites');
      return best;
    }
  }

  world.nextId.site ??= 1;
  const site = {
    id: world.nextId.site++,
    kind, x, y, i, name,
    firstDay: Number.isFinite(props.firstDay) ? props.firstDay : day,
    lastDay: day,
    n: Math.max(1, Math.round(fin(props.n, 1))),
    dead,
    civIds: unionCivs([], props.civIds),
    ref: props.ref ? { k: props.ref.k, id: props.ref.id ?? null } : null,
    fame: Number.isFinite(props.fame) ? props.fame : Math.log1p(dead) / 4,
    pinned,
    data: props.data && typeof props.data === 'object' ? { ...props.data } : {},
  };
  sites.push(site);
  evict(world);
  bumpVersion(world, 'sites');
  return site;
}

function evict(world) {
  const sites = world.sites;
  let unpinned = 0;
  for (const s of sites) if (!s.pinned) unpinned++;
  while (unpinned > MAX_SITES) {
    let worst = -1, ws = Infinity;
    for (let k = 0; k < sites.length; k++) {
      const s = sites[k];
      if (s.pinned) continue;
      const sc = score(world, s);
      if (sc < ws || (sc === ws && s.id < sites[worst].id)) { ws = sc; worst = k; }
    }
    if (worst < 0) break;
    sites.splice(worst, 1);
    unpinned--;
  }
}

/** The site with this id, or null. */
export function getSite(world, id) {
  if (id == null) return null;
  for (const s of world.sites) if (s.id === id) return s;
  return null;
}

/** Sites within r tiles of (x, y), optionally of one kind, in list order. */
export function sitesNear(world, x, y, r, kind = null) {
  const out = [];
  const r2 = r * r;
  for (const s of world.sites) {
    if (kind && s.kind !== kind) continue;
    const dx = s.x - x, dy = s.y - y;
    if (dx * dx + dy * dy <= r2) out.push(s);
  }
  return out;
}

/** Merge patch into site.data (only). Returns the site or null. */
export function updateSite(world, id, patch) {
  const s = getSite(world, id);
  if (!s) return null;
  touchRecord(world, s);
  if (patch && typeof patch === 'object') Object.assign(s.data, patch);
  bumpVersion(world, 'sites');
  return s;
}

/** Rename a site (e.g. a slain dragon's lair becomes "the Bones of X"). Returns the site or null. */
export function renameSite(world, id, name) {
  const s = getSite(world, id);
  if (!s) return null;
  touchRecord(world, s);
  s.name = name ? String(name) : null;
  bumpVersion(world, 'sites');
  return s;
}
