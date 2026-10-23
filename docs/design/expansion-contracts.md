# Expansion contracts (Wave 0)

Shared contracts for the expansion pass. Implemented in src/core and the registry files before the work packages start; frozen afterwards.

SHARED CONTRACTS. The lead implements these in src/core, writes the registry stub files and updates SPEC.md before any builder starts (Wave 0). They are frozen after Wave 0. Builders file change requests in their reports, and the lead batches them at integration.

== 0. WAVE 0: THE LEAD'S PRE-PASS, IN ORDER ==
(a) src/core:
- chronicle.js: new entry fields, the news filter and per-entity prune retention (§4).
- hooks.js: header documents the hook catalogue (§5).
- New effects.js (§6), ext.js (§7), events.js (§8), bands.js (§9), sites.js (§10), keyframe.js and replay.js (§11).
- tools.js: target and preview extensions, plus logging (§11).
- world.js: new state, setParam(world, k, v, {log, force}), and normalizeWorld(world), called by deserialize, which fills every default below idempotently.
- entities.js:
  - createCiv accepts opts.race; createSettlement copies race from opts.race ?? civ.race.
  - New effects, effectsV and race defaults.
  - damageArmy(world, army, n, src).
  - damageSettlement multiplies by mulOf('damage', world, s, cause).
  - addFigure eviction becomes fame-aware: when over 1,500, evict dead generals with no deeds first, then the oldest dead; never the prophet of a living faith.
  - Re-export addBand and removeBand.
- names.js: createLanguage(rng, style = null), where style may override onsets, codas, vowels, syllable range, suffixes and apostrophe chance.
- params.js, constants.js (§3).
- serialize.js: shares its SKIP set with keyframe.js.
(b) src/systems.js: LOADERS adds ./sim/bands/index.js, ./sim/events/index.js and ./sim/myth/index.js. Each starts as a stub exporting system = {id, order, update(){}} so the app boots.
(c) tools/headless.mjs:
- Prints the optional system.report(world) → {title, lines: [string], checks: [{ok, label}]} for every system; a failing check prints !! and counts towards the exit code.
- --hash prints worldChecksum.
- --determinism: run 200 years at mythLevel 0 twice, once with the myth module filtered out. The FNV hash of serializeWorld minus sys.myth must be identical.
- --rewind-test: capture a keyframe at Y40, apply a scripted meteor with applyTool at Y45, run to Y50 and take checksum A; restore the keyframe, replayTo Y50 and take checksum B. A must equal B.
(d) Registry files and minimal wiring:
- New registry files: src/ui/registry.js, src/ui/mounts.js, src/render/layers.js, src/render/plugins.js.
- src/ui/plate.js: drawAtlasPlate extracted from atlas.js drawPlate.
- Call sites in renderer.js, fx.js, modes.js, app.js, inspector.js, panel.js, input.js, hud.js, mapdock.js, toasts.js, icons.js, palette.js and main.js consult the registries; main.js gets the API in §15.
- A stub file exporting mount(){} for every path in mounts.js.
- The packages that own these hot files must keep the registry call sites working.
(e) index.html and tools/build-standalone.mjs: link src/ui/css/{story,records,myth,bands}.css (empty stubs) and inline every such link in the single-file build.
(f) SPEC.md:
- §3 ownership rewritten to WP1–WP8 as listed in the work packages.
- §4 and §5 gain the new fields and entities.
- §6 gains the new systems and budgets; §6.5 the fx types; §7 the renderer API and registries; §8 the UI registries.
- §9 balance targets and §10 tests updated.
- New §11 Mythic design bible.

== 1. GROUND RULES ADDED TO SPEC §1 ==
- Cross-owner coupling in sim code, in order of preference:
  1. kernel hooks
  2. core/ext.js providers
  3. core registries
  4. published exports through a guarded import
- Providers are pure: no world.rng, no mutation, cheap. They must return neutral values when their feature is off.
- Every world mutation outside sim.step goes through a logged kernel call: applyTool, applyPairTool, applyEntityTool, finishTool, or setParam with {log: true}. world.ui is the only exempt state, and sim code never reads it.
- History records (items of history.years and history.atlas), chronicle entries, catalogue events and archived summaries are immutable after they are pushed. Thinning removes items and never edits them, so keyframes can share them by reference.
- Hook payloads are fresh plain objects; subscribers copy what they keep.
- UI subscribers to sim hooks are read-only, must be O(1), and must ignore calls while world.cache.replaying is true.
- Sim code never reads chronicle entries to make decisions. Only the news filter and digests read them.
- Mythic gate: mythLevel(world) ∈ {0, 1, 2}. At level 0, no myth code may draw rng, allocate fields or lists, return non-neutral provider output, or add event weight.
- Every new tile-field writer and entity-field writer is listed with a single owner below.

== 2. SYSTEMS, ORDER, BUDGETS (ms per sim-year, medium map, idle Node) ==
terraform 5, climate 10, weather 15, ecology 20, disasters 25, civ 40 (35 + 3), religion 50, disease 55, trade 60, diplomacy 70, war 80 (geo total 30), bands 82 (≤3), events 84 (≤4), myth 86 (≤8 at level 2, about 0 at level 0), stats 100 (≤7, including ledger, records, sites and catalogue). Total ≤150 at Y1000.
Render: chunk blits ≤1 ms per frame and builds ≤3 ms per frame. LOD memory ≤48 MB on desktop and ≤24 MB on phones. Keyframe ring ≤64 MB on desktop and ≤24 MB on phones. A capture costs ≤3 ms on the main thread.

== 3. KERNEL STATE (createWorld + normalizeWorld) ==
World:
- world.bands = [] (WP2)
- world.sites = [] (core/sites.js API only)
- world.interventions = [] (kernel)
- world.ui = {watch: [{kind, id, since}], pins: [{n, name, x, y, zoom, mode}], patron: civId|null, lineage: [civId]} (WP8; saved; ignored by the sim; kept as-is across keyframe restores)
- nextId adds band and site.
- versions adds sites, bands, effects and ext.
Civ:
- race: null|RACE key (written at creation from the WP5 people provider)
- effects: [] and effectsV: 0 (core/effects.js only)
- style: null (WP3 style.js; shape {roof: pitched|flat|dome|pagoda|thatch|longhouse, wall: mudbrick|timber|whitewash|stone|brick, temple: ziggurat|stupa|basilica|onion|pyramid, layout: organic|grid|ring, palette: [r,g,b], race?})
- claims: {} (WP3)
- arcane: {mana, school} (WP5, only at mythLevel 2)
Settlement:
- race: null
- effects: [] and effectsV: 0
- traits: [] (WP1; up to 3 specialty or trait keys)
- epithet: null (WP1)
- legend: null (WP1; {kind, text, figId?})
- hist: {sieges, held, fires, quakes, plagues, conquered, riots} (WP1)
- own: [] (WP6; [[day, civId, code]], cap 16; code is f founded, c conquest, r rebellion, s secession, t treaty, u union, d divine or x destroyed)
Army:
- flags.loss {battle, attrition, plague, band, beast} (kernel damageArmy)
- flags.hunt = bandId and flags.merc = bandId (WP2)
- flags.genId and flags.divineGoal/goalUntil (WP4)
- flags.l service counters (WP4, should)
Rulers: archived rulers keep deeds, id, relation and predecessorId (WP3).
Wonders: path: [i]|null and i (WP3, at completion).
Wars: war.ledger {b, t, armies} (WP4).
world.sys: events (WP1), bands (WP2, including archive cap 200), myth (WP5, including weave 0..1 and favor), stats.records (WP6), civ.dynasties, eraFirst and exiles (WP3).
world.history: series (WP6), events (the WP6 catalogue, cap 500). Yearly records gain keys from yearRecord providers.
New fields (only at mythLevel 2, owned by WP5): ley U8 (N tiles); manaBase and mana F32 at half resolution ((W>>1)·(H>>1)).

Params (core/params.js). Every param may carry visibleIf: {key, min}. New group 'myth' {label: 'Myth & Magic'} is always shown.
- fortune: civ, range 0–2, step 0.05, default 1, live. 'How often history lurches'. WP1.
- worldAges: civ, bool, default true, live. WP1.
- banditry: civ, range 0–3, default 1, live. 'Brigands, pirates and raiders'. WP2.
- worldName: world, type 'text', default '', not live. createWorld uses it when non-empty.
- mythLevel: myth, select [[0, 'Historical'], [1, 'Legendary'], [2, 'Mythic']], default 0, not live. It may only change mid-run through setParam(world, 'mythLevel', 2, {force: true, log: true}). The change wakes the myth at once (setParam emits paramChanged; WP5 activates the myth with the existing peoples human), so a world saved or keyframed right after it continues alike. The Awaken Magic act does the same and also raises the elder peoples.
- magicStrength: 0–2, default 1, live, shown when mythLevel ≥ 2.
- monsterAbundance: 0–3, default 1, live, shown when mythLevel ≥ 2.
- divineIntervention: 0–3, default 1, live, shown when mythLevel ≥ 1.
- wildMagic: 0–3, default 1, live, shown when mythLevel ≥ 2; reserved for wave 2.
- raceMix: select mixed|humanDominant|elderRaces|monstrous, not live, shown when mythLevel ≥ 2.
- fading: bool, default true, live, shown when mythLevel ≥ 2.
New PRESETS, each with field mode: 'mythic':
- highfantasy {mythLevel: 2}
- dragons {mythLevel: 2, monsterAbundance: 2.5}
- twilight {mythLevel: 2, startingEra: 3, magicStrength: 0.7}
- elder {mythLevel: 2, raceMix: 'elderRaces'}
- legends {mythLevel: 1}
Accessors: mythLevel(world) and mythOn(world, min = 2).

Constants:
- CATEGORIES.myth = {label: 'Myth & Magic', color: '#a98be6'}.
- RESOURCES 13 starmetal (strategic, era 2, value 6) and 14 dragonbone (luxury, era 0, value 5). Gen never places either.
- TOOL_GROUPS adds {id: 'myth', label: 'Stir the Uncanny'}.
- REF_KINDS = civ, settlement, war, army, plague, religion, volcano, storm, figure, route, wonder, fire, band, site, ruler, dynasty, event.
- RACE_META (each with label, adjective, colour, small-zoom symbol):
  - human [166,128,92] round
  - elf [86,160,132] leaf
  - dwarf [112,120,132] diamond
  - orc [170,84,52] spike
  - halfling [206,176,104] mound
  - lizardfolk [78,150,110] scale
- BAND_KINDS (each with label, family, glyph and flags):

  | kind | family | glyph | flags |
  |------|--------|-------|-------|
  | bandits | outlaw | campfire | |
  | pirates | outlaw | blacksail | sea |
  | company | outlaw | company banner | |
  | horde | host | horsetail | |
  | migration | host | wagons | |
  | dragon | beast | dragon | fly, mythic |
  | wyvern | beast | | fly, mythic |
  | troll | beast | | mythic |
  | giant | beast | | mythic |
  | treant | beast | | mythic |
  | kraken | beast | | sea, mythic |
  | behemoth | beast | | mythic |
  | undead | spirit | | mythic |

== 4. CHRONICLE ==
- Entries gain optional fields, stored only when set:
  - ref: {k: REF_KIND, id}
  - key: a dotted event-type string, e.g. 'succession', 'battle.minor', 'pact.nap', 'event.great_fire', 'annals.decade', 'record.broken'
  - cause: the seq of the parent entry
  - tags: [string], at most 4
  - fold: true marks a routine entry. It is hidden from the Notable view, toasts and the Director, and counted by digests.
- chronicle() returns the entry, so callers can pass entry.seq as cause.
- setNewsFilter(fn) installs a single deterministic filter (registered by WP1): fn(world, e) → {imp?, fold?} | null. It runs before push, for entries that have a key.
- Prune retention: an older entry is kept if imp ≥ 2, or it is among the last 12 entries for its sid, or among the last 24 for its civId. Otherwise pruning works as today.

== 5. HOOKS (emitter → payload) ==
Existing hooks stay. New ones:
- battle(world, b), emitted by WP4 and WP2. b = {day, x, y, i, warId|null, kind: field|siege|naval|band|beast, attackerId, defenderId, winnerCivId, loserCivId (−1 for bands), bandId?, dead: {a, d}, engaged, name|null, great}.
- siegeStarted {sid, armyId, civId} and siegeEnded {sid, armyId, civId, outcome: captured|razed|lifted|broken, days}. WP4.
- armyDisbanded(world, army, reason), emitted before removal. WP4, WP2.
- plagueStarted(plague), plagueEnded(plague), and plagueDeaths {pid, sid, deaths}, monthly when deaths ≥ 1. WP4.
- routeCreated(route) and routeBroken(route, cause). WP4.
- religionFounded(r) and schism(child, parent). WP4.
- Nature hooks, WP4:
  - quake {x, y, mag, deaths, towns: [≤8], undersea}
  - tsunami {x, y, height, deaths, towns}
  - eruption {volcanoId, x, y, vei, deaths, towns}
  - impact {x, y, r, deaths, ocean, towns}
  - flood {x, y, deaths, towns}
  - locusts {swarmId, x, y, foodEaten}
  - fireEnded(fire)
  - stormEnded {id, kind, name, deaths, landfalls, towns, peak, category, track: [[x, y, intensity]] ≤24}
- Civ hooks, WP3:
  - famine {sid, deaths, months}, when deaths ≥ 50 or ≥ 5%
  - tierChanged(s, from, to)
  - depositExhausted {sid, i, resource}
  - buildingCompleted(s, key, level)
  - wonderBuilt(w) and wonderDestroyed(w)
  - rulerDied(civ, ruler, cause)
  - succession(civ, prev, next, how)
  - techDiscovered(civ, techId, how, first)
  - eraReached(civ, era, first)
  - figureBorn(fig) and figureDied(fig)
- bandCreated and bandDestroyed(band, cause), emitted by the kernel; bandRaid {bandId, sid?, routeId?, loot, deaths, sunk} by WP2.
- eventFired {id, family, scale, subject, seq}. WP1.
- toolApplied {kind: tool|pair|entity, id, x, y, opts, result, seq}. Kernel.
- mythAwakened. WP5.

== 6. EFFECTS (core/effects.js) ==
addEffect(world, target, eff):
- target is {kind: 'civ'|'settlement', id}.
- eff is {k, until (a day, or −1 for permanent), m: {key: number}, src?: seq, label?}.
- An effect with the same k replaces the old one. At most 12 effects per entity; the one expiring soonest is dropped. Expired effects are pruned on write.
- Bumps target.effectsV and versions.effects.
removeEffect(world, target, k). effectsOf(world, target) returns live effects (until < 0 or until > day).
Civ effect keys are mods keys (DEFAULT_MODS plus registered keys). WP3 applies them in computeMods with applyFx semantics, after techs, government, ruler, ages and wonders and before the ext 'mods' providers, then clamps to LIMITS.
SETTLEMENT_MOD_KEYS (exported by core):
- Additive: happiness [−.4, .4], unrest [−.5, .5], loyalty [−.5, .5], health [−.4, .4], defense [−.5, 1].
- Multiplicative: foodYield [.3, 2], production [.3, 2], trade [0, 2.5], culture [.3, 3], birth [.3, 2], mortality [.3, 3], attract [.2, 3], housing [.5, 1.6], research [.5, 2], plagueDose [0, 3], fireRisk [0, 4], raidRisk [0, 4].
settlementMods(world, s) returns a frozen aggregate, cached in world.cache.smods by s.id|s.effectsV|month. Readers:
- WP3: all keys except trade, plagueDose, fireRisk and raidRisk
- WP4: trade, plagueDose, defense
- WP1: fireRisk
- WP2: raidRisk

== 7. EXTENSION POINTS (core/ext.js) ==
registerProvider(point, id, fn); re-registering replaces. Helpers apply each point's clamp: mulOf (default 1), sumOf (default 0), firstOf, anyOf, concatOf.
Points (signature → combine and clamp; caller; providers):

| point | signature | combine | caller | providers |
|-------|-----------|---------|--------|-----------|
| habitat | (w, race\|null, i) | mul [0, 4] | WP3 genesis, findSite, findOverseasSite, emergence | WP5 |
| siteBonus | (w, civ, i) | sum [−.5, .5] | WP3 findSite | WP1 |
| settleName | (w, civ, i) | string\|null, first | WP3 | WP1 |
| people | (w, {genesis, k?, i?, parentCivId?}) → {race, traits?, languageStyle?}\|null | first | WP3; splits inherit the parent's race | WP5 |
| demography | (w, s, civ) → {birth, mortality} | each mul [.3, 3] | WP3 | WP5 |
| lifespan | (w, civ, person) → age divisor | [.2, 8] | WP3 rulers and figures | WP5 |
| mods | (w, civ) → partial mods via applyFx | | WP3 computeMods | WP5 |
| loyalty | (w, s, civ) | sum [−.3, .3] | WP3 socialPhase | WP5 |
| nameStyle | (w, civ, govKey) → {styles?: ['…{name}…'], titles?: {m: [], f: []}}\|null | first | WP3 government styleName and ruler titles | WP5 |
| archStyle | (w, civ) → partial style\|null | first | WP3 style.js | WP5 |
| heroTarget | (w, civ, s) → {name, bandId?}\|null | first | WP3 culture.js | WP2 |
| battle | (w, {army, enemy, i, side}) | mul [.5, 1.6] | WP4 battle, WP2 band combat | WP5, WP2 |
| siege | (w, {army, s}) | mul [.5, 1.5] | WP4 | WP5 |
| opinion | (w, a, b) | sum [−40, 40] | WP4 targetOpinion | WP5, WP2 |
| allied | (w, a, b) | any | WP4 | WP3 |
| warAppetite | (w, a, b) | mul [.2, 3] | WP4 | WP1 |
| casusBelli | (w, a, b) → [{cb, w, name?}] | concat | WP4 | WP3, WP5 |
| rates | (w, key) | mul [0, 5] | see below | WP1 (ages, black swans), WP5 later |
| vegCap | (w, i) | mul [.2, 1.5] | WP4 ecology | WP5 |
| routeValue | (w, route) | mul [0, 2] | WP4 trade | WP2, WP1 |
| damage | (w, s, cause) | mul [0, 2] | kernel damageSettlement | WP5 |
| yearRecord | (w) → partial object | merged into the record under each provider's id | WP6 | WP1 ev, WP2 bands, WP5 myth |

rates keys by caller: WP4 calls prophet, schism, plagueEmergence, quake, volcano, meteor, storm and wildfire; WP3 calls emergence and figureBirth; WP2 calls bandSpawn, horde and beastSpawn.

Code registries (each bumps extVersion()):
- registerModKeys({key: {default, limit: [lo, hi], kind: add|mul|set}}). WP3 merges these into DEFAULT_MODS and LIMITS, and MODS_VERSION folds in extVersion.
- registerTechs([def]). Defs may add branch: 'arcane', school, races, minMana and available(w, civ). The arcane branch is excluded from computeEra, grantEra, grantWorldKnowledge and era pacing.
- registerBuildings([def]) and registerWonders([def]), with race and available(w, s, civ).
Registered mod keys with known readers:
- taming: read by WP2
- forestFarm, deepHalls and mortality: read by WP3
- arcana, wards and luck: read inside WP5's own providers

== 8. EVENT REGISTRY (core/events.js) ==
- registerEvent(def), getEvents(scale). Scales: town, realm, pair, land, world, figure.
- def = {id, scale, family, cat, imp, minEra?, maxEra?, minMyth? (default 0), maxMyth? (default 2), cooldownYears, tags?, weight(ctx) → expected firings per check, fire(ctx)}.
  - weight is pure: no rng, no allocation.
  - fire uses world.rng, addEffect, kernel functions and published exports, and writes its chronicle entry with key 'event.' + id plus ref and cause.
- ctx = {world, day, era, scale, s?, civ?, a?, b?, land?: {feature, lm}, heat(tag), mythLevel}.
- The engine (WP1) guarantees that defs out of myth or era bounds are excluded before weights are summed, and that each check draws exactly one rng.next(), plus one weightedIndex pick only when it fires.
- WP5 may register folklore decks with minMyth ≥ 1.

== 9. BANDS (core/bands.js) ==
band = {id, kind, family, name, epithet: null, x, y (float tiles), homeI, homeR, state, strength (people; 0 for beasts), power (beasts; 0 for people), hp: 1, morale: 1, loot: 0, leader: {name, skill, born, figureId?}|null, civId: −1 (employer, tamer or patron), originCivId: −1, targetSid: −1, targetI: −1, path: null, pathStep: 0, createdDay, raids: 0, kills: 0, data: {} (kind-specific JSON)}.
state is one of lair, sleep, roam, raid, return, hired, tamed or settling.
- addBand(world, props) fills defaults, takes an id from nextId.band and emits bandCreated.
- removeBand(world, id, cause) emits bandDestroyed. WP2 archives the summary.
- getBand(world, id); bandsNear(world, x, y, r, filter).
- Only WP2 creates, moves or destroys bands. Bands never appear in areAtWar pairs.
- damageArmy clamps, adds to flags.loss[src] and never removes an army; war code removes empty armies.

== 10. SITES (core/sites.js) ==
site = {id, kind, x, y, i, name|null, firstDay, lastDay, n, dead, civIds: [≤4], ref|null, fame, pinned, data: {}}.
SITE_KINDS (mergeR in tiles, weight, minZoom):

| kind | mergeR | weight | minZoom |
|------|--------|--------|---------|
| battle | 1.5 | 1 | 12 |
| siege | 0.6 | 1 | 12 |
| ruin | 0.4 | 2 | 7 |
| crater | 2 | 3 | 6 |
| eruption | 1 | 2 | 8 |
| quake | 2 | 1 | 10 |
| wreck | 1 | 1 | 14 |
| plaguepit | 0.4 | 1 | 14 |
| treaty | 0.6 | 1 | 14 |
| holy | 0.4 | 2 | 10 |
| grave | 0.6 | 1 | 16 |
| node (pinned) | 0 | | 3 |
| lair (pinned) | 0 | | 8 |

addSite(world, props) merges into an existing site of the same kind within mergeR, provided the names match when both are named: n += 1, dead is added, lastDay is updated, civIds are unioned, and fame += log1p(dead)/4. Otherwise it creates a new site.
At most 600 unpinned sites. The lowest score is evicted first, where score = fame + weight + log1p(n) − ageYears/1000; ties break by id.
Other API: getSite, sitesNear(world, x, y, r, kind?), updateSite(world, id, patch) (merges into data only).
Ruin data: {peak, maxTier, buildings, civId, originCivId, wonderIds, cause, fellDay, sid}.
Writers: WP6 (history kinds), WP5 (node), WP2 (lair and grave), WP1 (updates ruin data).

== 11. TOOLS, INTERVENTIONS, KEYFRAMES ==
Tool def additions:
- target: 'pair' | 'entity'
- pick: [civ|settlement|tile, civ|settlement|tile], for pair tools
- entity: {kinds: [...]}, for entity tools
- available?(world) → bool
- hidden?
- charge?
- polarity: boon | bane | neutral
- danger?(opts)
- preview?(world, x, y, opts) → {ok, reason?, text?, targets?: [{kind, id}], rings?: [{x, y, r, tone}], threads?: [{x0, y0, x1, y1, tone}], estimate?: {deaths?: [lo, hi], towns?}, severity?, cards?: [{id, label, p, effects: [string], actions: [{id, label}]}]}. Must be pure.
- applyPair(world, a, b, opts)
- applyEntity(world, target, args)
Kernel functions: availableTools(world); previewTool (try/catch; in dev, asserts rng.state is unchanged); applyPairTool; applyEntityTool.
Reserved tool ids:
- WP3: bless_ruler, curse_ruler, smite_ruler, grant_heir, gift_tech, commission_wonder, rename, cede_town, send_settlers, depose, arrange_marriage.
- WP4: incite_war, broker_peace, forge_alliance, open_route, steer_storm, command_army.
- WP1: fate.
- WP2: summon_beast, slay_beast, tame_beast.
- WP5: ley_line, wellspring, awaken_magic.
Interventions:
- intervention = {seq (index in the log), day, kind: tool|finish|pair|entity|param, id, x?, y?, opts?, a?, b?, target?, args?, key?, value?}.
- The kernel appends one on every apply, unless world.cache.replaying is set or opts.log === false.
- day is world.time.day at the moment of the call. On replay it is applied before that day's sim.step.
Keyframes (core/keyframe.js):
- captureKeyframe(world) → {day, ivSeq, check, rng: state copy, fields: {name: copy of the TypedArray}, state, history, chronicle}:
  - state: deep copy (cloneData) of world minus f, cache, fx, rng, history, chronicle and ui; copies of closed records (ended wars, broken routes, fallen realms, historic sites, fallen bands' archive entries, effects lists and paths) are cached by object identity and shared by later keyframes while untouched
  - history: {years: slice, atlas: slice, events: slice, series: deep copy (frozen series shared)}
  - chronicle: {seq, entries: slice}
  - keyframes are never edited; code that edits a closed record calls touchRecord(world, rec) (SPEC §1, §8.1)
- restoreKeyframe(kf, {ui}) returns a new world (a full deep copy: it shares no object with the keyframe). Versions are bumped, cache is {}, fx is [], and the ui passed in is kept.
- worldChecksum(world) returns an FNV hex over owner, elevation (stride 7), rounded popDensity, settlement populations, civ treasuries, rng.state, chronicle.seq and day (§19: also bands, armies, active wars, sites and the war and figure counts).
Replay (core/replay.js):
- replayStep(world, sim, log, skip) applies the log entries whose day equals today, in seq order, through the kernel apply calls (re-logging them), then calls sim.step().
- replayTo(world, sim, log, targetDay, {skip, onProgress, sliceDays}) is an async slicer.
Interventions are saved with the world. Keyframes live only in memory, except in branch saves (WP8).

== 12. PUBLISHED SIM EXPORTS (guarded import, DOM-free) ==
- WP3: peoples.js splitCiv(world, civ, sids, opts); tech.js grantTech, discover, getMods; acts.js colonize(world, fromSid, x, y) and depose(world, civ, how); dynasty.js arrangeMarriage(world, a, b) (should).
- WP4:
  - trade.js: breakRoute(world, routeId, cause), routeValueOf
  - disease.js: createPlague(world, sid, {lethalityMul, name, cause}), cureTown(world, s)
  - religion.js: foundReligion(world, s, {doctrine}), boostFervor(world, rid, amt)
  - war.js: clearSiege(world, s, reason), startWarNamed(world, attackers, defenders, cb, name)
  - diplomacy.js: addTreaty(world, a, b, kind)
  - nature/storms.js: forecastTrack(world, storm, days, push) (should)
- WP1: events/index.js eligibleEvents(world, subject), currentAges(world), EVENT_FAMILIES, annalKeyLabel(key).
- WP2: bands/index.js bandSummary(world, band), BEAST_LORE.
- WP5: myth/index.js manaAt(world, x, y), weave(world), RACES, mythPreview(world).
- WP6: ledger.js series(world, kind, id) → {t0, st, ch: [names], v: [[...]]}|null and ownerChain(world, sid); records.js getRecords(world); ui/digest.js digest(world, fromDay, toDay).

== 13. FX TYPES (SPEC §6.5) ==
- emitFx accepts these fields: type, x, y, r, civId, intensity, text, color, x2, y2, tone, sign, glyph, size, src.
- Kit types drawn by WP7:
  - bless {r}, curse {r}
  - terraform {r, sign, intensity}
  - sprout {r}
  - spawn {r, glyph: herd|pred|fish}
  - raincall {r}, parch {r}
  - thread {x2, y2, tone: hate|peace|trade|alliance|marriage}
  - label {text, tone, size}
  - swirl {r}, rewind {r}, riot {r}, fair {r}
- An fx with src: 'tool' is never time-scaled, gets priority 10 and gets an off-screen pointer.
- Registered by their owners through registerFxType: raid, dragonfire, slay and summon (WP2); spell {color}, leyflare and awaken (WP5).

== 14. RENDERER API AND RENDER REGISTRIES ==
src/render/layers.js:
- registerLayer({id, slot, order, draw(r, ctx, env)}). Slots:
  - ground: world transform, after the raster
  - overTerritory: world transform, after borders
  - underIcons: screen space, before settlements
  - units: after armies and caravans
  - overUnits: after storms
  - labels: push candidates into env.labels before placement
  - hud: after labels
- env = {z, dpr, prof, mode, labels, vb, now, dt, worldT(), screenT(), snapshot}. Layers push r.hits entries {kind, id, x0, y0, x1, y1, pri}.
- registerFxType(type, {dur, priority, cap, draw(fx, ctx, r, t, now), onStart?}).
- registerMapMode({id, label, desc, when(world), profile, territory?(r) → {key, catFn, colorFn}, legend(world)}).
src/render/plugins.js guard-imports ./bands.js (WP2), ./myth.js (WP5), ./overlays.js (WP6), ./pins.js (WP8) and WP7's own new modules.
Renderer methods (WP7):
- setToolPreview(p|null), setHighlights([{x, y, r, tone, label?}])
- pickAll(sx, sy) → [{kind, id}]
- recentFx(sinceMs) → [{type, x, y, r, civId, t}]
- onFx: an assignable callback (fx, {sx, sy, onScreen, dist})
- getZoomInfo() → {z, name, band, kmPerPx, next}
- frameBox(x0, y0, x1, y1, pad)
- lodReady
- setSelection accepts {kind: 'civs', ids} and {kind: 'box', x0, y0, x1, y1}
- overlay ids are dynamic
Hit kinds: settlement, army, storm, band (WP2), site, wonder, landmark, volcano, caravan, swarm and fxPointer (WP7), pin (WP8).
Data the renderer reads: civ.style, race with RACE_META, s.traits and s.epithet (in labels at z ≥ 8), s.buildings, s.project, s.siege, wonders path and i, world.sites with SITE_KINDS, world.bands with BAND_KINDS, and f.ley and f.mana (WP5 only).

== 15. UI REGISTRIES (src/ui/registry.js), MOUNTS, APP API ==
- registerView(kind, {label, icon, mount(app, sel, el) → {update?, destroy?}, describe?(app, sel) → {name, sub, color}, point?(world, id), frame?(world, id) → box, rendererSel?(world, id)}). inspector.js and app.js selectionPoint, follow and Z framing consult it for every non-built-in kind.
- registerSection(kind|'*', {id, order, when?, mount(app, sel, el) → {update?}}).
- registerTitleAction(kind|'*', {id, icon, label, run, pressed?}).
- registerTab({id, label, key, icon, desc, order, when?, mount(app, el) → {update?, show?, hide?}}). app.TABS is derived from it.
- registerKey({key?|code?, shift?, mod?, label, group, when?, run(app, e)}). Consulted after the built-ins; the help sheet lists every key.
- Reserved keys:
  - G: Director
  - U: Run until (Shift+U repeats)
  - / and Ctrl/Cmd+K: command palette
  - . (period): watch
  - B: pin the view; Shift+Digit1–9: jump to a pin
  - Y: timeline
  - Z: frame the selection
  - Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z: undo and redo
  - Q and E: previous and next tool
  - R: Annals tab
  - O: Legends tab
- registerCommand({id, label, group, keywords?, keys?, icon?, when?, run(app, arg), menu?}).
- registerSearchSource({id, label, search(app, q, limit) → [{kind, id, label, sub, icon, color?, score, run?}]}).
- registerContextProvider(fn(app, {tile, picks, sx, sy}) → [{label, icon?, run}]).
- registerToastFilter(fn(app, entry) → null | {suppress: true} | {watched: true}).
- registerUntilCondition({id, label, params?, arm(app, args) → state, test(world, state) → {text, x, y, ref?}|null, disarm?}).
- registerDirectorSource(fn(app, nowMs) → [{type, x, y, zoom?, box?, score, caption?, ref?}]).
- registerOverlay({id, label, desc, default}).
- registerIcon(key, svgInner).
src/ui/mounts.js lists these modules, each exporting mount(app):
- director, until, command, contextmenu, watch, chrono, acts, deedcard, timeline, audio (WP8)
- annals, digest, views/records (WP6)
- views/band (WP2)
- views/myth, legends (WP5)
App API, added in Wave 0:
- app.follow = {kind, id}|null
- app.fastForward(years, prog, {until}) → {days, cancelled, hit, ms}
- app.restoreWorld(world, {reason}), which runs prepareSim, then installWorld with keepPause, then emits worldRestored
App events: userCamera; mapContext {sx, sy, tile, picks}; mapDblClick; leapDone {fromDay, toDay, seq0, hit, cancelled}; worldRestored {reason, fromDay, toDay}; toolApplied; chronicleScrollTo (seq); timeTravel (year); atlasGoto (k).
src/ui/plate.js: drawAtlasPlate(canvas, world, snapshot|null, {box?, marks?}).
CSS: each package uses its own stylesheet under src/ui/css/ with tokens from styles.css only. Pref keys are prefixed with the package name.

== 16. MYTHIC (SPEC §11 design bible) ==
- One dial, mythLevel:
  - 0 Historical: nothing mythic.
  - 1 Legendary: belief-only folklore deck (WP5, should). The option stays disabled until that deck is registered.
  - 2 Mythic: everything below.
- The gate is owned by WP5. All mythic behaviour lives in src/sim/myth/** (WP5) and src/sim/bands/kinds/{beasts,dragons,undead}.js (WP2). All mythic rendering lives in render/myth.js (WP5) and render/bands.js (WP2).
- Content:
  - six races (human, elf, dwarf, orc, halfling, lizardfolk) with land niches, lifespans, birth rates, temperaments, tongues, titles, buildings and wonders
  - ley lines and mana
  - seven arcane schools as a tech branch (the six race schools plus Necromancy); registered mod keys arcana, wards, taming, luck, scrying, gates, necromancy, forestFarm, deepHalls, mortality
  - a bestiary on the bands engine, with dragons as the headline (lairs, sleeps, raids, hoards, pacts, slayers)
  - responses to monsters: hunt, hero, tame, pact
  - map modes arcane, peoples and monsters
  - tools: Ley Line, Wellspring, Awaken Magic, Summon, Slay, Tame
  - should: gods answer, the Fading, race relations, the Legends tab, undead
- Wave 2: workings, phenomena (rifts, enchanted woods, blight, Conjunction, starfall), dark lords, sea courts.
- Balance at level 2:
  - each race alive at Y1000 in at least 60% of seeds
  - expansion and era pacing within ±25% of Historical
  - 3–15 notable myth events per century (read as major, imp ≥ 3, Myth & Magic entries; §18)
  - 0–6 dragons alive at any time

== 17. TESTS AND INTEGRATION GATE ==
- headless --determinism and --rewind-test pass. Save → load → continue gives an identical --hash.
- Batch of 5 seeds × 1000 years at defaults and at mythLevel 2 meets SPEC §9 plus:
  - imp≥2 entries in Y0–250: at least 1.5 a year
  - first imp≥4 entry before Y60 in at least 4 of 5 seeds
  - p90 gap between imp≥3 entries: at most 10 years
  - war: at most 40% of imp≥2 entries after Y250
  - routine successions: at most 20% of imp≥2 entries in the Nations category
  - world population falls by 10% or more within some 50-year window in at least 2 of 5 seeds
- Performance: at most 150 ms per sim-year at Y1000 on an idle machine. Browser zoom sweep: median ≤12 ms, p90 ≤20 ms. Save size grows at most 3 MB at Y1000.
- Then rebuild Atlas of Ages.html with tools/build-standalone.mjs and run a full browser pass at desktop and 390×844.

== 18. WAVE 1 INTEGRATION AMENDMENTS (lead, after the eight packages landed) ==
Accepted change requests and integration decisions. Where this section and the text above differ, this section wins.
Tools and previews (§11):
- The preview result may carry polarity or tone (boon | bane | neutral); input.js merges the tool's polarity when the preview has none, and the renderer tints reticles and realm outlines by it. A forecast course is drawn as threads plus danger rings (no path field yet).
- Entity tools may declare args = [{key, type: 'tech'|'wonder'|'text'|'select', label, options?(world, target) → [[value, label]]}]; the Inspector's Divine acts ask for them. Fate-card actions apply with args {card, action}.
Hooks (§5):
- famine fires once per famine; tierChanged falls have hysteresis; techDiscovered and eraReached also fire for how = 'grant'; succession how ∈ heir, kin, council, election, coup, usurper, civil war, union, revolution, divine, restoration, deposed; rulerDied causes include smitten and murdered. Payload fields others rely on are kept: siegeEnded.days, fireEnded.hit/towns, plagueEnded.worst, quake.towns. stormEnded.sunk and siegeEnded.dead are not emitted yet.
- leapDone is also emitted after a run-until search (hit set); the digest card does not open on a hit or a cancelled search (the Arrived card offers it instead).
- army.general is the object {name, skill, born, wins, battles, honours}; every reader takes .name (WP2 hire/hunts/combat, WP7 armies were fixed).
State (§3):
- normalizeWorld fills history.series {s,c,r,w,p,a,b} and history.events [].
- world.ui.pins entries carry 'at' (the day pinned). civ.flags.union / regent / heirSecured, ruler.heir / spouse / flags and sys.civ.marriages exist (WP3). Ref ids: ruler 'civId:reignStart'; dynasty a ledger index or 'civId:name'; event a catalogue id, 'age:<key>' or 'swan:<kind>:<year>'.
- Road pressure lives in sys.bands.press (saved). The band cap reads world manpower as a quarter of world population.
- Saved history is kept compact: archived ruler deeds hold non-zero counters only; a war's ledger keeps 1, 4 or 8 army summaries (under 2,000, under 10,000, more dead), zero fields omitted, and a small war at most its 12 bloodiest battle rows; a finished war drops geo.log once its ledger holds the battles and rounds its casualties; a broken trade route rounds its numbers and drops carrierId / lastCarrierDay / gridV; ledger series hold K = 40 samples, a finished life is halved, and small wars (under 5,000 dead) lose their chart a century after the peace.
Registries and data (§7, §12):
- registerTechs defs may add costMul(w, civ) and researchWeight(w, civ); registerBuildings defs may add smods, score, mana and desc. Code registries register lazily (the first Mythic world), so Historical saves never carry neutral registered keys; registered mod keys are stored on civ.mods only when they differ from their default, and MODS_VERSION folds effectsV (saved as civ.mods._e), never extVersion.
- core/events defs may also carry minTier, maxTier, needs, luck, chain, label, hint and icon (WP1's engine honours them); EVENT_FAMILIES gains folklore (WP5's deck).
- RACE_META colours are WP5's RACE_HUE (elf and lizardfolk now read apart everywhere).
- WP2 publishes heroDeed(world, civ, bandId, fig), bandOrArchive, heroOdds, tamingOf and pressureOf; WP3's culture.js heroes call heroDeed when heroTarget names a real beast.
- SITE_KINDS node (WP5) and lair (WP2) are drawn by their owners; WP7's site layer skips them.
- Kernel: settlementMods caches each aggregate until the first month a live effect lapses; emitFx trims the headless queue in batches.
Renderer and UI (§14, §15):
- Hits carry extra fields: fxPointer {x, y} (from ex, ey), landmark {sid, key}. app.select turns map-only kinds into records: landmark → its town (or the wonder), caravan → its trade route, swarm → the ground. The fxPointer pick flies to the act.
- registerKey defs may carry display and hidden. Director source candidates may carry key, imp and caption as a string or {text, cat, icon, place}. app.restoreWorld(world, {reason, sim}) and app.restoring are part of the app API.
- app.frameBox frames into the part of the map left clear by the phone sheet, or on desktop by the top instruments and the tool belt.
- saves.js exports download(bytes, name, type) and the host-aware saveFile(data, name, type).
Balance decisions:
- Myth target (§16) reads "3–15 major (imp ≥ 3) Myth & Magic entries per century"; routine beast news (failed challenges, sleeps, ships taken, re-tamings) is folded. WP5's own myth news is reported alongside.
- Save growth (§17) is measured against the pre-expansion tree (Wave 0 backup) at Y1000 on the same seed.
Build rule (single file):
- No import cycle may join modules that wait on a top-level await (directly or through what they import): esbuild's emulation of top-level await cannot evaluate such a cycle, and the single-file page then never boots. Two were broken at integration (bands/engine ↔ combat: engineHooks.clashScan; geo/war ↔ acts: acts.bindWar). UI modules load sim readers lazily (import().then) rather than by top-level await where a cycle could form. Check with a graph of static imports plus top-level awaited imports before building.

== 19. REVIEW FIXES (kernel and sim, after the integration review) ==
Where this section and the text above differ, this section wins.
Interventions and replay (§11):
- intervention gains pts?: [[x, y], …] and refused?: true. A continuous tool applied again on the same day with the same opts right after its last successful application joins that entry's pts (one entry per stroke and day), never across a keyframe (captureKeyframe seals the log in world.cache.ivSeal), a finish, another act or a refusal. Replay applies an entry's point, then its pts in order, re-logging the same structure.
- An apply the world refused (result ok: false) is logged with refused: true. Refusals must be pure (no rng, no mutation). replayTo with acts skipped (an undo) also skips the refused entries logged after the first skipped one: they came to nothing for the player, and might succeed in the changed history.
- Map-tool args are sanitised before the apply (non-finite radius/strength fall back to the tool's defaults, other non-finite numbers are dropped), so the logged opts are exactly what the tool saw. previewTool answers off-map points of map tools with { ok: false, reason }. Index-addressed targets (civ, settlement, religion, feature) take whole-number ids only; others are refused before logging.
Hooks (§5):
- paramChanged (world, key, value, prev) from setParam when the value changes. WP5 wakes the myth at once when mythLevel reaches 2 outside the Awaken act (the old peoples are human), so a world saved or keyframed right after setParam(world, 'mythLevel', 2, {force, log}) continues alike.
- battle payloads may carry seq (the battle's chronicle entry); eruption already does. Bands use them (and their own entry seqs) as causes: hunt → its band's end, raid → hunt and hero, razing/battle → the dead that rise, eruption → a dragon's waking.
State:
- sys.civ.proxy (the month's ecology-proxy flags, judged at month start) is state, so a mid-month save or keyframe reads the flags the running world uses.
- Ruin sites are unpinned (weight 2, fame from peak and wonders); a town that falls again where its ruin stands updates that ruin. Old saves' pinned ruins are unpinned on load (sys.stats.ruinsUnpinned).
- Closed records shed working state on a rolling basis: a war 50 years over keeps 2 army summaries, its 8 bloodiest battles (named first) and 12 transfers (ledger.old = 1); 20 years after a fall a realm drops flags.stab/figureCounts/capacity/levyRaised, arcane and lapsed effects, a dead town flags.pot/ep/… and lapsed effects (flags.shed = 1). history.atlas is budgeted at about 6 MB, history.years at 1,500 records (older ones thinned). sys.geo.rate keys older than 120 years are pruned yearly.
Saves: serializeWorldText(world) gives the save text in one pass (no deep copy) and compressText(text) gzips it; save paths should use them instead of JSON.stringify(serializeWorld(world)).
Tests (§0(c), §17): --rewind-test fails on a full-state mismatch (minus versions and sys.myth); --trial is the randomized save/load/keyframe gate, run at mythLevel 0 and 2. Equality across JS engines is by worldChecksum and the typed fields, not saved bytes (SPEC §1).
