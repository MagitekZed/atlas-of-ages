// Synchronous lifecycle hooks shared by systems. Handlers are module-level (not saved);
// subscribe at module load time. Every handler receives (world, ...args).
//
// Rules (SPEC §1, docs/design/expansion-contracts.md §5):
//   - Payloads are fresh plain objects (or the live entity, where noted); subscribers copy
//     what they keep and never hold on to a payload.
//   - Sim subscribers may mutate the world only as their own owner rules allow; providers
//     and filters registered elsewhere (core/ext.js, chronicle news filter) stay pure.
//   - UI subscribers are read-only, O(1), and ignore calls while world.cache.replaying is true
//     (undo / rewind replays history through the same code paths).
//   - An emitter with an expensive payload may skip building it when listeners(event) is 0.
//
// Kernel and lifecycle (emitter: kernel unless noted)
//   civCreated            (world, civ)
//   civDestroyed          (world, civ, cause)
//   settlementCreated     (world, settlement)
//   settlementTransferred (world, settlement, oldCivId, newCivId, cause)
//   settlementDestroyed   (world, settlement, cause)
//   warStarted            (world, war)
//   warEnded              (world, war)
//   waterChanged          (world)            after hydrology recompute (sea level / terrain edits)
//   terrainChanged        (world)            after elevation edits that need dependent refresh
//   worldLoaded           (world)            after deserialisation or keyframe restore, before system.init
//   paramChanged          (world, key, value, prev)              core/world.js setParam, when the value changed
//                                                                (a non-live param changed mid-run must take
//                                                                effect at once: myth wakes on mythLevel 2)
//   bandCreated           (world, band)                          core/bands.js addBand
//   bandDestroyed         (world, band, cause)                   core/bands.js removeBand (band already removed)
//   toolApplied           (world, { kind: 'tool'|'pair'|'entity', id, x, y, opts, result, seq })
//                                                                core/tools.js, after every apply
//                                                                (seq = intervention seq, or null when not logged)
//
// War, faith, trade, plague (WP4; WP2 also emits battle and armyDisbanded)
//   battle         (world, { day, x, y, i, warId|null, kind: 'field'|'siege'|'naval'|'band'|'beast',
//                            attackerId, defenderId, winnerCivId, loserCivId (−1 for bands), bandId?,
//                            dead: { a, d }, engaged, name|null, great, seq? })   seq: the battle's
//                            chronicle entry when one was written (a cause for what follows)
//   siegeStarted   (world, { sid, armyId, civId })
//   siegeEnded     (world, { sid, armyId, civId, outcome: 'captured'|'razed'|'lifted'|'broken', days })
//   armyDisbanded  (world, army, reason)                      before the army is removed
//   crownWon       (world, war, winnerCiv, loserCiv)          war.js makePeace, a war for a crown won;
//                                                              civ/dynasty.js crowns the victor's ruler there too
//   outgunned      (world, loserCiv, winnerCiv)               geo/war.js, a named battle lost to better-armed foes;
//                                                              civ/knowledge.js gives a head start on their arms
//   armyCoup       (world, civ, gen|null)                     geo/raising.js, a standing army seizes power;
//                                                              civ/rulers.js overthrows the ruler
//   regimentDisbanded (world, civ, regiment, why)             geo/raising.js ('cost' | 'reform')
//   regimentLost   (world, civ, regiment, army)               geo/raising.js, cut down to a handful in the field
//   plagueStarted  (world, plague)
//   plagueEnded    (world, plague)
//   plagueDeaths   (world, { pid, sid, deaths })                monthly per settlement, when deaths ≥ 1
//   routeCreated   (world, route)
//   routeBroken    (world, route, cause)
//   religionFounded(world, religion)
//   schism         (world, child, parent)
//
// Nature (WP4)
//   quake          (world, { x, y, mag, deaths, towns: [sid ≤ 8], undersea })
//   tsunami        (world, { x, y, height, deaths, towns })
//   eruption       (world, { volcanoId, x, y, vei, deaths, towns })
//   impact         (world, { x, y, r, deaths, ocean, towns })
//   flood          (world, { x, y, deaths, towns })
//   locusts        (world, { swarmId, x, y, foodEaten })
//   fireEnded      (world, fire)
//   stormEnded     (world, { id, kind, name, deaths, landfalls, towns, peak, category,
//                            track: [[x, y, intensity]] ≤ 24 })
//
// Peoples, rulers and cities (WP3)
//   famine            (world, { sid, deaths, months })          when deaths ≥ 50 or ≥ 5 %
//   tierChanged       (world, settlement, fromTier, toTier)
//   depositExhausted  (world, { sid, i, resource })
//   buildingCompleted (world, settlement, key, level)
//   wonderBuilt       (world, wonder)
//   wonderDestroyed   (world, wonder)
//   rulerDied         (world, civ, ruler, cause)
//   succession        (world, civ, prevRuler, nextRuler, how)
//   techDiscovered    (world, civ, techId, how, first)
//   eraReached        (world, civ, era, first)
//   figureBorn        (world, figure)
//   figureDied        (world, figure)
//
// Bands (WP2), events (WP1), myth (WP5)
//   bandRaid       (world, { bandId, sid?, routeId?, loot, deaths, sunk })
//   eventFired     (world, { id, family, scale, subject, seq })
//   mythAwakened   (world)                                     mythLevel raised to 2 mid-run

const handlers = Object.create(null);

export function on(event, fn) {
  (handlers[event] ||= []).push(fn);
  return () => { handlers[event] = handlers[event].filter((h) => h !== fn); };
}

export function emit(world, event, ...args) {
  const hs = handlers[event];
  if (!hs) return;
  for (const h of hs) {
    try { h(world, ...args); } catch (e) { console.error(`[hook:${event}]`, e); }
  }
}

/** Number of handlers subscribed to an event (emitters may skip building unused payloads). */
export function listeners(event) {
  const hs = handlers[event];
  return hs ? hs.length : 0;
}
