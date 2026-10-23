# Atlas of Ages — Architecture Spec

An autonomous, deterministic 2-D top-down planet simulator. The user sets ~40 genesis
parameters (land, climate, life, peoples, catastrophe), then watches millennia unfold:
plate-built continents, seasons and weather, forests and herds, tribes becoming empires,
wars, trade, faiths, plagues, disasters and climate change. The user can intervene with
god tools and live parameter changes, inspect any tile / settlement / nation, read the
Chronicle, study charts, and scrub a historical atlas of borders.

The kernel in `src/core/` is written and is the contract. **Read every file in `src/core/`
before writing code** — this document explains intent; the kernel code is authoritative for
names and signatures.

**Expansion pass.** The world is being extended by eight work packages (WP1–WP8, §3) built in
parallel on shared contracts that were implemented in Wave 0 and are now frozen:
`docs/design/expansion-contracts.md` (the contracts, numbered §0–§17 there and cited below as
"contracts §n") and `docs/design/expansion-packages.md` (what each package builds and owns). This
spec summarises those contracts and points to them; where they go into more detail, they
win. Builders file contract change requests in their reports; the lead batches them at
integration.

---------------------------------------------------------------------------------------------

## 1. Ground rules

- Vanilla JavaScript ES modules. No build step, no npm dependencies, no external scripts.
  Canvas 2D for rendering. Plain JS (no TypeScript syntax).
- `src/core`, `src/gen`, `src/sim` are **DOM-free** and must run under Node 24
  (`node tools/headless.mjs`). Only `src/render`, `src/ui`, `src/main.js` touch the DOM.
- **Determinism:** all simulation randomness goes through `world.rng` (see `core/rng.js`).
  Never call `Math.random()` or `Date` in sim/gen code. Renderer/UI may use `Math.random()`
  for purely cosmetic effects. Determinism is exact within one JS engine. Across engines
  (Node vs Chrome, or browser versions) transcendental `Math` functions (`exp`, `log`, `sin`,
  `cos`, `atan2`, `tanh`, `cbrt`) may differ in the last ulp, so the same seed and log give
  worlds that agree in `worldChecksum` and the typed fields but not always byte for byte in the
  saved JSON (stray float digits in entities): compare a browser-made save with the Node tools
  by `worldChecksum`, not by its bytes.
- **Serialisable state:** everything on `world` except `world.cache` and `world.fx` is saved.
  Outside `world.f`, state must be plain JSON: no typed arrays, Map, Set, class instances,
  functions or cycles. Reference other entities **by id**, never by object.
  Extra typed arrays go in `world.f` via `ensureField(world, name, Type, length)`
  (any length — coarse grids are fine) and are saved automatically.
  Per-system persistent scalars/objects go in `world.sys[systemId]`.
  Derived caches go in `world.cache` (rebuild lazily or in `system.init`).
- **Module-level mutable state is forbidden in sim code** except caches that are safe to
  lose (e.g. path cache keyed by versions). After load, `system.init(world)` runs again.
- **Live params:** read `world.params.X` at the moment of use (never cache them in init),
  because the user can change any `live: true` param mid-simulation.
- **Robustness:** never let NaN/Infinity into fields or entity numbers. Clamp. Guard
  divisions. Handle dead civs (`alive === false`) and dead settlements everywhere —
  ids stay valid forever (index-as-id lists never shrink).
- **Chronicle:** write good prose. One finished past-tense sentence, specific names and
  places, e.g. "In the drought of Year 412 the wells of Oskel ran dry, and a third of its
  people fled south." Vary phrasing with small template pools. Use importance honestly
  (see `core/chronicle.js`). Never spam: rate-limit repetitive events per place.
- **Parallel development:** a module you import from another owner may not exist yet
  while you work. Import cross-owner modules with a guarded top-level await so your module
  still loads and degrades gracefully:
  `let hydro = null; try { hydro = await import('../gen/hydrology.js'); } catch (e) { /* not available */ }`
  (kernel imports from `src/core` are always static).
- File ownership is strict (§3). Do not edit files you do not own. If you need a kernel
  change, work around it and list the request in your report.
- **Cross-owner coupling in sim code**, in order of preference: (1) kernel hooks
  (`core/hooks.js`, catalogue in its header and §6.0), (2) `core/ext.js` providers,
  (3) core registries (`core/events.js`, `ext.js` code registries, `tools.js`),
  (4) published exports through a guarded import (§3.2).
- **Providers are pure:** no `world.rng`, no mutation, cheap (some are asked per tile). They
  return neutral values (1 for mul points, 0 for sum points, null otherwise) whenever their
  feature is off. The same holds for event `weight()` and tool `preview()`.
- **Every world mutation outside `sim.step` goes through a logged kernel call:** `applyTool`,
  `applyPairTool`, `applyEntityTool`, `finishTool`, or `setParam(world, k, v, { log: true })`.
  The log (`world.interventions`) is what undo and rewind replay. `world.ui` is the only
  exempt state, and sim code never reads it.
- **Immutable records:** items of `history.years` / `history.atlas` / `history.events`,
  chronicle entries, catalogue events and archived summaries are never edited after they are
  pushed. Thinning removes items and never edits them, so keyframes share them by reference.
- **Closed records:** ended wars, broken trade routes, fallen realms, frozen ledger series,
  fallen bands' archive entries and historic sites are copied once and the copy is shared by
  every keyframe while the record is untouched (§8.1). Code that edits one of them later (ledger
  compaction, shedding, pruning, a late army summary, a site merge) calls
  `touchRecord(world, rec)` (core/keyframe.js) first; `bumpVersion(world, 'archive')` drops every
  shared copy at once. Effects lists and paths are never edited in place (a write stores a new
  array), which lets keyframes share their copies too.
- **Hook payloads are fresh plain objects** (or the live entity where the catalogue says so);
  subscribers copy what they keep. UI subscribers to sim hooks are read-only, O(1), and must
  ignore calls while `world.cache.replaying` is true.
- **Sim code never reads chronicle entries to make decisions.** Only the news filter and
  digests read them.
- **Mythic gate:** `mythLevel(world)` ∈ {0, 1, 2} (`core/params.js`, also re-exported by
  `core/world.js`). At level 0, no myth code may draw rng, allocate fields or lists, return
  non-neutral provider output, or add event weight; `headless --determinism` proves it (§10).
- Every new tile-field writer and entity-field writer has a single owner, listed in §4–§5.

## 2. Scale, coordinates, time

- Tile ≈ 20 km. Sizes in `MAP_SIZES` (medium = 256×160). Index `i = y*W + x`. No wrap.
- `y = 0` is the north pole, `y = H-1` the south pole; `latitude(world, y)` ∈ [-1, 1].
- One simulation step = one day. 30-day months, 12 months, 360-day years, history starts at
  Year 0. Systems run every day via `system.update(world)` and choose their own cadence
  using `everyDays`, `isMonthStart`, `isYearStart`, `stripeRow` (process 1/K of the rows
  each day; scale rates by K).
- Speeds (`SPEEDS`): up to "Rapid" = 360 days/s and "Max" = as fast as the budget allows.

### Performance budget (Node, medium map, `ms per sim-year` printed by headless)

| system(s)                        | budget ms/yr |
|----------------------------------|-------------:|
| climate                          | 20 |
| weather                          | 25 |
| ecology                          | 30 |
| disasters                        | 5  |
| civ (all of src/sim/civ)         | 38 (35 + 3 for the expansion call sites) |
| religion+disease+trade+diplomacy+war | 30 |
| bands (WP2)                      | 3  |
| events (WP1)                     | 4  |
| myth (WP5)                       | 8 at mythLevel 2, ≈ 0 at level 0 |
| stats (incl. ledger, records, sites, catalogue) | 7 |
| **total**                        | **≤ 150 at Y1000** |

Full-grid passes at most monthly per system; per-day work must be O(entities) or a row
stripe. No allocation inside per-tile loops. Use typed arrays and the kernel `MinHeap`.
Run a tile loop as a small kernel function that takes typed arrays and numbers only (as
ecology.js, climate.js, civ/territory.js and civ/land.js do): a loop left inside a function
that also handles entity objects (whose shapes keep changing) is thrown out of optimised code
now and then, and then runs interpreted until on-stack replacement catches up. Never scan a list
that only grows (world.wars, tradeRoutes, settlements, civs) per query: use the cached active
indexes (kernel `activeWars` / `areAtWar` / `enemiesOf`, geo `activeWarList` / `activeRouteList`).
Headless prints these with ok/!! marks in its Balance block.

Browser budgets (contracts §2): LOD chunk blits ≤ 1 ms and chunk builds ≤ 3 ms per frame;
LOD memory ≤ 48 MB desktop / ≤ 24 MB phone; the keyframe ring ≤ 64 MB desktop / ≤ 24 MB
phone; one keyframe capture ≤ 3 ms on the main thread.

## 3. Files and ownership

Ownership follows the expansion work packages (`docs/design/expansion-packages.md`; each package's
**Owns** list there is authoritative, including new files). The original roles map onto them:
A · gen, B · nature and D · geo → WP4; C · civ → WP3; E · render → WP7; F · ui → WP8 and WP6.

| Owner | Files |
|-------|-------|
| **kernel** (lead, Wave 0; frozen) | `src/core/*`, `src/systems.js`, `tools/headless.mjs`, `tools/fallback-gen.mjs`, `tools/build-standalone.mjs`, `index.html`, `SPEC.md`, `docs/expansion-*.md`; the registry files `src/ui/registry.js`, `src/ui/mounts.js`, `src/render/layers.js`, `src/render/plugins.js`, `src/ui/plate.js` |
| **WP1 · Event Deck & Living History** | `src/sim/events/**` (system `events`, order 84: engine, heat, governor, annals, ages, character, ruins, fate, prose, data, `decks/*`), `tools/events-report.mjs` |
| **WP2 · Roaming Powers** (bands, hordes, pirates, beasts) | `src/sim/bands/**` (system `bands`, order 82: engine, move, combat, hire, hunts, names, prose, tools, `kinds/*`), `src/render/bands.js`, `src/ui/views/band.js`, `src/ui/css/bands.css` |
| **WP3 · Peoples, Rulers & Cities** | `src/sim/civ/**` (system `civ`, order 40; all existing files plus `dynasty.js`, `acts.js`, `previews.js`, `style.js`) |
| **WP4 · War, Faith, Trade & Nature** | `src/sim/geo/**` (plus `ledger.js`, `acts.js`, `previews.js`), `src/sim/nature/**`, `src/sim/climate.js`, `src/sim/weather.js`, `src/sim/ecology.js`, `src/sim/disasters.js`, `src/gen/**` (plus `previews.js`) |
| **WP5 · Mythic** (races, magic, the Mythic switch) | `src/sim/myth/**` (system `myth`, order 86: races, identity, ley, mana, arcana, divine, fading, folklore, tools, prose, preview), `src/render/myth.js`, `src/ui/genesis.js`, `src/ui/views/myth.js`, `src/ui/legends.js`, `src/ui/css/myth.css`, `tools/myth-check.mjs` |
| **WP6 · Ledgers, Records & the Inspector** | `src/sim/stats.js`, `src/sim/ledger.js`, `src/sim/records.js`, `src/sim/sites.js` (hook-driven recorder), `src/sim/catalogue.js`, `src/ui/inspector.js`, `src/ui/chronicle.js`, `src/ui/statistics.js`, `src/ui/charts.js`, `src/ui/nations.js`, `src/ui/format.js`, `src/ui/annals.js`, `src/ui/digest.js`, `src/ui/views/records.js`, `src/ui/histomap.js`, `src/ui/compare.js`, `src/render/overlays.js`, `src/ui/css/records.css` |
| **WP7 · Close-zoom depth & feedback rendering** | `src/render/renderer.js`, `camera.js`, `detail.js`, `terrain.js`, `vectors.js`, `glyphs.js`, `labels.js`, `entities.js`, `fx.js`, `territory.js`, `modes.js`, `palette.js`, `clouds.js`, `dev.html`, new `lod.js`, `cityplan.js`, `raceplan.js`, `sites.js`, `highlights.js`, `armies.js`, `fields.js`, `traffic.js`; `tools/zoom-perf.mjs` |
| **WP8 · Story, navigation & hands** | `src/main.js` (after the lead's wiring), `src/ui/app.js`, `input.js`, `hud.js`, `toasts.js`, `panel.js`, `mapdock.js`, `prefs.js`, `widgets.js`, `palette.js`, `worldtab.js`, `atlas.js`, `saves.js`, `dom.js`, `icons.js`, `theme.js`, `fallback-renderer.js`, `styles.css`, new `director.js`, `until.js`, `command.js`, `contextmenu.js`, `watch.js`, `chrono.js`, `acts.js`, `deedcard.js`, `timeline.js`, `audio.js`, `src/render/pins.js`, `src/ui/css/story.css` |

Packages that own a hot file the lead wired in Wave 0 (renderer.js, fx.js, modes.js, app.js,
inspector.js, panel.js, input.js, hud.js, mapdock.js, toasts.js, icons.js, palette.js,
main.js) must keep its registry call sites working. The Wave 0 stubs (`src/sim/{bands,events,
myth}/index.js`, the `mount(){}` stubs listed in `src/ui/mounts.js`, the empty
`src/ui/css/{story,records,myth,bands}.css`) pass to the package that owns their path.

### 3.1 Kernel modules (`src/core/`)

| Module | What it holds |
|--------|---------------|
| `constants.js` | calendar, sizes, `BIOMES`, `ERAS`, `TIERS`, `RESOURCES` (13 starmetal, 14 dragonbone: gen never places them), `CATEGORIES` (+ `myth`), `TOOL_GROUPS` (+ `myth` "Stir the Uncanny"), `REF_KINDS`, `RACE_META` / `RACE_KEYS`, `BAND_KINDS` / `BAND_STATES`, `SPEEDS` |
| `params.js` | `PARAMS` (+ `visibleIf`, type `text`), `PARAM_GROUPS` (+ `myth`), `PRESETS` (+ mythic presets with `mode: 'mythic'`), `paramVisible`, `mythLevel(world)`, `mythOn(world, min = 2)` |
| `world.js` | `createWorld`, `normalizeWorld` (fills every default, idempotent; run by create, load and keyframe restore), `setParam(world, k, v, { log, force })`, `logIntervention`, calendar, geometry, `emitFx` |
| `entities.js` | civ / settlement / war / army / figure lifecycle; `damageSettlement` (× ext `damage`), `damageArmy(world, army, n, src)`, fame-aware `addFigure`; re-exports `addBand` / `removeBand` / `getBand` / `bandsNear` |
| `chronicle.js` | `chronicle()` (returns the entry; optional `ref`, `key`, `cause`, `tags`, `fold`), `setNewsFilter`, `chronicleSince`, `chronicleEntry` |
| `hooks.js` | `on`, `emit`, `listeners`; the hook catalogue (§6.0) |
| `effects.js` | `addEffect`, `removeEffect`, `effectsOf`, `getEffect`, `settlementMods`, `SETTLEMENT_MOD_KEYS` (§5.1) |
| `ext.js` | `registerProvider`, `mulOf` / `sumOf` / `firstOf` / `anyOf` / `concatOf` / `mulEachOf` / `mergeOf`, `EXT_POINTS` (§6.0); code registries `registerModKeys`, `registerTechs`, `registerBuildings`, `registerWonders`, `extVersion` |
| `events.js` | event registry: `registerEvent`, `getEvents(scale)`, `EVENT_SCALES` (§6.6) |
| `bands.js` | band shape, `addBand`, `removeBand`, `getBand`, `bandsNear` (§5) |
| `sites.js` | `SITE_KINDS`, `addSite` (merge + deterministic eviction), `getSite`, `sitesNear`, `updateSite`, `renameSite` (§5) |
| `tools.js` | tool registry and every logged apply: `applyTool`, `finishTool`, `applyPairTool`, `applyEntityTool`, `availableTools`, `previewTool`, `applyIntervention` (§8.1) |
| `keyframe.js` | `captureKeyframe`, `restoreKeyframe`, `worldChecksum`, `jsonHash`, `cloneData`, `touchRecord`, `firstDiff`, `KEYFRAME_DEV` (§8.1) |
| `replay.js` | `replayStep`, `replayTo` (§8.1) |
| `serialize.js` | save / load (`SAVE_SKIP`, shared with keyframes); load runs `normalizeWorld` |
| `sim.js`, `rng.js`, `names.js` (`createLanguage(rng, style = null)`), `util.js` | as before |

### 3.2 Published exports

Cross-module imports are allowed **only** through these published exports (implement them
exactly; other modules code against them before they exist, through a guarded import):

| Module | Export | Signature / meaning |
|--------|--------|---------------------|
| `src/gen/worldgen.js` | `generateWorld(world, opts)` | fills all gen-owned fields + `world.climate.seaLevel/baseSeaLevel/appliedSeaLevel`, `world.volcanoes`, `world.features`. `opts = { preview?: bool, onStage?: (label) => void }`. Synchronous. |
| `src/gen/hydrology.js` | `recomputeWater(world)` | recompute water mask, lakes, coast, distCoast, landmass, flowDir, flow, river from current elevation & `world.climate.seaLevel`; bump `versions.water`; emit `waterChanged`. ≤ 60 ms medium. |
| `src/gen/biomes.js` | `classifyBiomes(world)` → `changedCount` | reclassify `f.biome` from `annTemp`, `annRain`, elevation, water; bump `versions.biome` if changed. |
| `src/sim/ecology.js` | `ignite(world, i, intensity)` | start/strengthen a fire on land tile i (no-op on water or barren). |
| `src/sim/civ/tech.js` | `TECHS`, `getMods(world, civ)` | tech table; derived modifier object (§6.4) — always returns a full object with defaults even for unknown civs. |
| `src/sim/civ/index.js` | `system` | |
| `src/sim/geo/pathfinding.js` | `findPath(world, fromI, toI, opts)` → `number[] \| null` | opts `{ mode: 'land'\|'sea'\|'amphibious', civId?, maxNodes? }`. Tile indices from start to goal inclusive. |
| `src/sim/geo/diplomacy.js` | `civPower(world, civ)` → number | military/economic strength estimate. |
| `src/render/renderer.js` | `createRenderer(canvas, world)`, `renderPreview(world, canvas)`, `MAP_MODES` | §7 |
| every system module | `system` | `{ id, order, init?, update }` |

Added by the expansion (contracts §12; DOM-free, guarded import):

| Module | Export | Signature / meaning |
|--------|--------|---------------------|
| `src/sim/civ/peoples.js` | `splitCiv(world, civ, sids, opts)` | WP3 |
| `src/sim/civ/tech.js` | `grantTech`, `discover`, `getMods` | WP3 |
| `src/sim/civ/acts.js` | `colonize(world, fromSid, x, y)`, `depose(world, civ, how)` | WP3 |
| `src/sim/civ/dynasty.js` | `arrangeMarriage(world, a, b)` (should) | WP3 |
| `src/sim/geo/trade.js` | `breakRoute(world, routeId, cause)`, `routeValueOf` | WP4 |
| `src/sim/geo/disease.js` | `createPlague(world, sid, { lethalityMul, name, cause })`, `cureTown(world, s)` | WP4 |
| `src/sim/geo/religion.js` | `foundReligion(world, s, { doctrine })`, `boostFervor(world, rid, amt)` | WP4 |
| `src/sim/geo/war.js` | `clearSiege(world, s, reason)`, `startWarNamed(world, attackers, defenders, cb, name)` | WP4 |
| `src/sim/geo/diplomacy.js` | `addTreaty(world, a, b, kind)` | WP4 |
| `src/sim/nature/storms.js` | `forecastTrack(world, storm, days, push)` (should, pure) | WP4 |
| `src/sim/events/index.js` | `eligibleEvents(world, subject)`, `currentAges(world)`, `EVENT_FAMILIES`, `annalKeyLabel(key)` | WP1 |
| `src/sim/bands/index.js` | `bandSummary(world, band)`, `BEAST_LORE` | WP2 |
| `src/sim/myth/index.js` | `manaAt(world, x, y)`, `weave(world)`, `RACES`, `mythPreview(world)`; mixed peoples (pure): `townPeoples(world, s)`, `civPeoples(world, civ)`, `landPeoples(world, landmassId)`, `worldPeoples(world)`, `peoplesHistory(world, kind, id)`, `townPeoplesPast(world, s, years)`, `PEOPLES_MIN` | WP5 |
| `src/sim/ledger.js` | `series(world, kind, id)` → `{ t0, st, ch, v } \| null`, `ownerChain(world, sid)` | WP6 |
| `src/sim/records.js` | `getRecords(world)` | WP6 |
| `src/ui/digest.js` | `digest(world, fromDay, toDay)` (pure) | WP6 |
| every system module | `system` | `{ id, order, init?, update, report? }` — `report(world)` → `{ title, lines, checks: [{ ok, label }] }` is printed by headless |

Hooks (`core/hooks.js`, catalogue in §6.0) and `core/ext.js` providers are the other coupling
channels (§1). Systems subscribe with `on(...)` and register providers at module load.

## 4. Fields (`world.f`, one value per tile unless noted)

Elevation is normalised so **sea level at genesis is exactly 0.5** (`baseSeaLevel = 0.5`):
ocean floor 0..0.5, land 0.5..1. The live sea level `world.climate.seaLevel` moves around
0.5 (ice volume, `seaLevelOffset`). `elevationMeters()` converts for display. Land
elevation thresholds: hills ≈ 0.62+, mountains ≈ 0.75+, high peaks ≈ 0.88+.

| field | type | owner (writers) | meaning / units |
|-------|------|-----------------|-----------------|
| elevation | F32 | gen (terraform tools, disasters: quakes/craters/lava) | 0..1, sea level 0.5 |
| plate | U8 | gen | tectonic plate id |
| plateBoundary | F32 | gen | 0..1 stress near plate boundaries (1 at convergent edges) |
| water | U8 | gen/hydrology | `WATER.LAND/OCEAN/LAKE` |
| coast | U8 | hydrology | 1 = land tile touching ocean (8-neigh) |
| distCoast | U16 | hydrology | tiles to nearest ocean (0 on water/coast) |
| landmass | I32 | hydrology | connected land component id (-1 water) |
| flowDir | I32 | hydrology | downstream neighbour index, -1 sink/ocean |
| flow | F32 | hydrology | accumulated runoff (rain-weighted catchment) |
| river | U8 | hydrology | river class 0 none, 1 stream … 4 great river |
| mineral | F32 | gen (civ depletes) | 0..1 ore richness |
| resource | U8 | gen (civ may clear when exhausted) | `RESOURCES` id |
| resourceAmt | F32 | gen (civ depletes) | 0..1 remaining |
| baseTemp | F32 | gen | °C annual mean at genesis (latitude, elevation, ocean moderation; *excludes* `params.baseTemperature`) |
| temp | F32 | climate | °C current (seasonal, includes global offsets) |
| annTemp | F32 | climate (gen inits) | °C running annual mean |
| baseMoisture | F32 | gen | 0..1 genesis precipitation index (1 ≈ 3000 mm/yr) |
| rain | F32 | weather | 0..1 current precipitation rate (same scale, annualised) |
| annRain | F32 | weather/climate (gen inits) | 0..1 running annual mean precipitation |
| soilWater | F32 | weather | 0..1 soil moisture saturation |
| humidity | F32 | weather | 0..1 atmospheric moisture |
| cloud | F32 | weather | 0..1 cloud cover (renderer draws it) |
| snow | F32 | climate | 0..1 snow / ice cover (on water = sea ice) |
| windX, windY | F32 | gen (weather may perturb) | prevailing wind, tiles/day (~±1) |
| biome | U8 | gen, climate (yearly via `classifyBiomes`) | `BIOME` id |
| soil | F32 | gen init; ecology; civ (farming exhausts / manure) ; disasters (ash +) | 0..1 fertility |
| veg | F32 | ecology; civ may subtract (logging, clearing) ; fire/disasters | 0..1 biomass |
| vegCap | F32 | ecology | 0..1 current capacity |
| fire | F32 | ecology (`ignite` from weather/disasters/tools) | 0..1 burning intensity, 0 = not burning |
| burnScar | F32 | ecology | 0..1 recent-burn visual, decays |
| herb | F32 | ecology; civ hunting via popDensity is applied by ecology | 0..1 herbivore density |
| pred | F32 | ecology | 0..1 predator density |
| fish | F32 | ecology; civ subtracts catch | 0..1 fish density (water tiles) |
| owner | I16 | civ territory (kernel on transfer/destroy) | civ id or -1 |
| ownerSettle | I32 | civ territory | controlling settlement id or -1 |
| settle | I32 | kernel only | settlement id located on the tile, -1 |
| farm | F32 | civ | 0..1 farmland intensity |
| road | U8 | trade | 0 none, 1 track, 2 road, 3 highway/rail |
| popDensity | F32 | civ | people on the tile (urban core + rural spread) |
| devastation | F32 | war, disasters, weather storms (+); ecology decays | 0..1 damage |
| pollution | F32 | civ (+, decays) | 0..1 industrial pollution |
| ley | U8 | WP5 myth only, **only at mythLevel 2** | ley-line strength on the tile (0 none) |
| manaBase, mana | F32, half resolution `(W>>1)·(H>>1)` | WP5 myth only, **only at mythLevel 2** | ambient magic: base from ley / nodes, current after consumption (relaxed monthly) |

Fields created with `ensureField` by their owners (e.g. `pathLandCost`, weather grids) are
saved like the rest. A Historical world (mythLevel 0) never allocates the myth fields.

`world.climate` scalars: `seaLevel, baseSeaLevel, appliedSeaLevel` (level hydrology last ran
at), `tempOffset` (total global offset now, °C), `drift`, `aerosol` (0..1 sky dimming from
eruptions/impacts, decays), `co2` (ppm, 280 baseline), `iceVolume`, `iceBaseline`,
`avgTemp`, `avgLandTemp`, `droughtIndex`. Climate owns these; disasters add `aerosol`; civ
adds `co2` emissions.

Kernel world state added by the expansion (`createWorld` + `normalizeWorld`, contracts §3):
`world.bands = []` (WP2 via `core/bands.js`), `world.sites = []` (`core/sites.js` API only),
`world.interventions = []` (kernel log, §8.1), `world.ui = { watch: [{kind, id, since}],
pins: [{n, name, x, y, zoom, mode}], patron: civId|null, lineage: [civId] }` (WP8; saved,
ignored by the sim, kept as-is across keyframe restores); `nextId.band`, `nextId.site`;
`versions.sites / bands / effects / ext`. Params added since a save was made take their
defaults on load.

## 5. Entities

Kernel `entities.js` creates every entity with a complete default shape — read it. Lists:

- `world.civs[id]`, `world.settlements[id]` — index-as-id, never removed (`alive` flag).
  Create/transfer/destroy only via `createCiv`, `createSettlement`, `transferSettlement`,
  `destroySettlement`, `killCiv`, `damageSettlement`.
- `world.wars[id]` — `startWar` / `endWar` (kernel); war module runs them.
- `world.religions[id]` (religion module): `{ id, name, color:[r,g,b], colorHex, alive, foundedDay,
  holyCityId, founderCivId, prophet, tenets:[string], fervor 0..1, parentId, followers }`.
- `world.plagues[id]` (disease module): `{ id, name, originSid, startDay, endDay, active,
  infectivity, lethality, duration, deaths, color }`.
- `world.tradeRoutes[id]` (trade): `{ id, aId, bId, kind:'land'|'sea', path:[i], value,
  active, establishedDay, civA, civB }`.
- `world.armies[]` (war; `createArmy`/`removeArmy`): see kernel. Positions are float tile coords.
- `world.caravans[]` (trade; `addEntity(world,'caravans',obj,'caravan')`):
  `{ id, routeId, civId, x, y, path, pathStep, kind:'caravan'|'ship', value }`.
- `world.storms[]` (weather; `addEntity(...,'storm')`): `{ id, kind:'cyclone'|'blizzard'|'thunderstorm'|'sandstorm',
  name, x, y, vx, vy, intensity 0..1, radius (tiles), age, maxAge, hemisphere }`.
- `world.volcanoes[]` (gen creates, disasters runs): `{ id, i, x, y, name, activity 0..1,
  erupting (days left), lastEruption (day|null), dormantSince }`.
- `world.fires[]` (ecology, notable fire events for chronicle/labels): `{ id, name, x, y, startDay, tiles, active }`.
- `world.figures[]` (`addFigure`): great people. Capped at 1,500: over the cap the kernel
  forgets a dead general with no deeds first, then the figure dead longest; never the
  prophet of a living faith.
- `world.wonders[]` (civ): `{ id, name, kind, sid, civId, builtDay, destroyedDay }`; WP3 adds
  `path: [i] | null` and `i` at completion (great wall, canal, dam geometry).
- `world.bands[]` (kernel `core/bands.js`; only WP2 creates, moves or destroys): `{ id, kind
  (BAND_KINDS), family, name, epithet, x, y (float tiles), homeI, homeR, state
  ('lair'|'sleep'|'roam'|'raid'|'return'|'hired'|'tamed'|'settling'), strength (people; 0 for
  beasts), power (beasts; 0 for people), hp, morale, loot, leader {name, skill, born,
  figureId?} | null, civId (employer, tamer or patron; −1), originCivId, targetSid, targetI,
  path, pathStep, createdDay, raids, kills, data {} }`. `addBand` emits `bandCreated`,
  `removeBand(world, id, cause)` emits `bandDestroyed` (after removal; WP2 archives a summary
  in `sys.bands.archive`, cap 200). Bands never appear in `areAtWar` pairs.
- `world.sites[]` (kernel `core/sites.js` API only): `{ id, kind, x, y, i, name|null,
  firstDay, lastDay, n, dead, civIds [≤ 4], ref|null, fame, pinned, data {} }`. `SITE_KINDS`
  (mergeR, weight, minZoom): battle 1.5/1/12, siege 0.6/1/12, ruin 0.4/2/7, crater 2/3/6,
  eruption 1/2/8, quake 2/1/10, wreck 1/1/14, plaguepit 0.4/1/14, treaty 0.6/1/14,
  holy 0.4/2/10, grave 0.6/1/16, node (pinned)/3, lair (pinned)/8. `addSite` merges a
  same-kind event within mergeR when the names agree (n += 1, dead added, civIds unioned,
  fame += log1p(dead)/4); at most 600 unpinned sites, the lowest score fame + weight +
  log1p(n) − ageYears/1000 is evicted (ties by id). Ruin data `{ peak, maxTier, buildings,
  civId, originCivId, wonderIds, cause, fellDay, sid }`. Writers: WP6 (history kinds), WP5
  (node), WP2 (lair, grave), WP1 (ruin data via `updateSite`).
- `world.interventions[]` (kernel): the user's acts, §8.1.
- `world.features[]` (gen): named geography for map labels
  `{ kind:'continent'|'ocean'|'sea'|'island'|'range'|'lake'|'river'|'desert'|'forest', name, x, y, size, angle? }`.
- `world.history` (stats): `{ years: [...], atlas: [...] }` — §8; WP6 adds `series` (entity
  ledgers) and `events` (the catastrophe catalogue, cap 500). Yearly records gain keys from
  `yearRecord` providers, each under its provider id.
- `world.sys`: per-system state. New keys: `events` (WP1), `bands` (WP2, incl. `archive`),
  `myth` (WP5, incl. `weave` 0..1 and `favor`), `stats.records` (WP6), `civ.dynasties`,
  `civ.eraFirst`, `civ.exiles` (WP3).

New entity fields (contracts §3; defaults from the kernel, single writer in brackets):

- **Civ:** `race` (null | RACE_META key; set at creation from the WP5 `people` provider via
  `createCiv(opts.race)`, splits inherit) · `effects: []`, `effectsV: 0` (core/effects.js only) ·
  `style: null` (WP3 style.js: `{ roof, wall, temple, layout, palette, race? }`) · `claims: {}`
  (WP3) · `arcane: { mana, school }` (WP5, only at mythLevel 2). Archived rulers keep `deeds`,
  `id`, `relation`, `predecessorId` (WP3).
- **Settlement:** `race` (copied from `opts.race ?? civ.race`; in a Mythic world the dominant
  people, moved by WP5 peoples.js) · `peoples`, `peoplesPast` (WP5 peoples.js, Mythic only;
  `docs/design/mixed-peoples.md`) · `effects`, `effectsV` ·
  `traits: []` (≤ 3 specialty / trait keys), `epithet: null`, `legend: null` (`{ kind, text,
  figId? }`), `hist: { sieges, held, fires, quakes, plagues, conquered, riots }` (all WP1
  character.js) · `own: []` (`[[day, civId, code]]`, cap 16; code f founded, c conquest,
  r rebellion, s secession, t treaty, u union, d divine, x destroyed — WP6).
- **Army:** `flags.loss { battle, attrition, plague, band, beast }` (kernel `damageArmy`) ·
  `flags.hunt = bandId`, `flags.merc = bandId` (WP2) · `flags.genId`, `flags.divineGoal` /
  `goalUntil`, `flags.l` service counters (WP4). All casualties go through
  `damageArmy(world, army, n, src)`, which clamps, records the loss and never removes the
  army (war code removes empty ones). Merge into `army.flags`, never replace it.
- **War:** `war.ledger { b, t, armies }` (WP4).

Settlement extra fields used across modules (civ maintains unless noted):
`population, peakPopulation, tier, food (stock, person-months), foodProd, foodNeed (per month),
wealth, production, tradeIncome (trade writes), housing, health, happiness, unrest, loyalty,
culture, defense, garrison, buildings {key: level}, religion {rid: share 0..1, sum ≤ 1}
(religion writes), dominantReligion (religion writes), disease {pid, I, R} | null and
immunity {pid: frac} (disease writes), coastal, harbor, siege {armyId, civId, progress} | null
(war writes), famine (months), radius (catchment tiles)`.

### 5.1 Effects (`core/effects.js`, contracts §6)

`addEffect(world, { kind: 'civ'|'settlement', id }, { k, until (day, −1 permanent), m: { key:
number }, src?, label? })` — same `k` replaces; at most 12 per entity (the existing one expiring
soonest is dropped); expired effects are pruned on write; bumps `entity.effectsV` and
`versions.effects`. `removeEffect`, `effectsOf` (live: `until < 0 || until > day`), `getEffect`.
Civ effects use mods keys (DEFAULT_MODS + registered keys); WP3 applies them in `computeMods`
with applyFx semantics after techs, government, ruler, ages and wonders and before the ext
`mods` providers, then clamps to LIMITS. Settlement effects use `SETTLEMENT_MOD_KEYS`:
additive happiness [−.4, .4], unrest [−.5, .5], loyalty [−.5, .5], health [−.4, .4],
defense [−.5, 1]; multiplicative foodYield [.3, 2], production [.3, 2], trade [0, 2.5],
culture [.3, 3], birth [.3, 2], mortality [.3, 3], attract [.2, 3], housing [.5, 1.6],
research [.5, 2], plagueDose [0, 3], fireRisk [0, 4], raidRisk [0, 4].
`settlementMods(world, s)` returns the frozen, clamped aggregate (cached in
`world.cache.smods` by id | effectsV | month; an effect counts for the whole month in which it
is live, judged at the month's first day, so a world loaded mid-month reads the same values;
a settlement with no effects gets a shared neutral object). Readers: WP3 all keys except trade / plagueDose / fireRisk / raidRisk; WP4
trade, plagueDose, defense; WP1 fireRisk; WP2 raidRisk.

## 6. Systems — module specifications

Every system: `export const system = { id, order, init(world), update(world), report?(world) }`.
Orders: terraform 5, climate 10, weather 15, ecology 20, disasters 25, civ 40, religion 50,
disease 55, trade 60, diplomacy 70, war 80, bands 82, events 84, myth 86, stats 100
(`src/systems.js` LOADERS lists them in this order; the Simulation sorts by `order`).
`report(world)` → `{ title, lines: [string], checks: [{ ok, label }] }` is optional; headless
prints it after a run and a failing check counts towards the exit code.

`init(world)` runs after generation **and after loading a save**: it must be idempotent —
seed initial state only when absent (e.g. `if (!world.sys.civ) { ...spawn tribes... }`),
otherwise just rebuild caches.

### 6.0 Hooks and extension points (contracts §5, §7)

The full hook catalogue with payloads is the header of `src/core/hooks.js`. Existing hooks
stay; the expansion adds, by emitter: `battle`, `siegeStarted`, `siegeEnded`,
`armyDisbanded`, `plagueStarted`, `plagueEnded`, `plagueDeaths`, `routeCreated`,
`routeBroken`, `religionFounded`, `schism`, and the nature hooks `quake`, `tsunami`,
`eruption`, `impact`, `flood`, `locusts`, `fireEnded`, `stormEnded` (WP4; WP2 also emits
`battle` and `armyDisbanded`); `famine`, `tierChanged`, `depositExhausted`,
`buildingCompleted`, `wonderBuilt`, `wonderDestroyed`, `rulerDied`, `succession`,
`techDiscovered`, `eraReached`, `figureBorn`, `figureDied` (WP3); `bandCreated`,
`bandDestroyed` (kernel) and `bandRaid` (WP2); `eventFired` (WP1); `toolApplied` and
`paramChanged (key, value, prev)` (kernel); `mythAwakened` (WP5). `worldLoaded` also fires
after a keyframe restore.

Extension points (`core/ext.js`; `registerProvider(point, id, fn)`, providers run in id
order, each point's combined answer is clamped):

| point | signature | combine, clamp | caller | providers |
|-------|-----------|----------------|--------|-----------|
| habitat | (w, race\|null, i) | mul [0, 4] | WP3 genesis, findSite, findOverseasSite, emergence | WP5 |
| siteBonus | (w, civ, i) | sum [−.5, .5] | WP3 findSite | WP1 |
| settleName | (w, civ, i) → string\|null | first | WP3 | WP1 |
| people | (w, {genesis, k?, i?, parentCivId?}) → {race, traits?, languageStyle?}\|null | first | WP3 | WP5 |
| demography | (w, s, civ) → {birth, mortality} | `mulEachOf`, each [.3, 3] | WP3 | WP5 |
| lifespan | (w, civ, person) → age divisor | mul [.2, 8] | WP3 rulers, figures | WP5 |
| mods | (w, civ) → partial mods (applyFx) | `concatOf` | WP3 computeMods | WP5 |
| loyalty | (w, s, civ) | sum [−.3, .3] | WP3 socialPhase | WP5 |
| nameStyle | (w, civ, govKey) → {styles?, titles?}\|null | first | WP3 | WP5 |
| archStyle | (w, civ) → partial style\|null | first | WP3 style.js | WP5 |
| heroTarget | (w, civ, s) → {name, bandId?}\|null | first | WP3 culture.js | WP2 |
| battle | (w, {army, enemy, i, side}) | mul [.5, 1.6] | WP4, WP2 | WP5, WP2 |
| siege | (w, {army, s}) | mul [.5, 1.5] | WP4 | WP5 |
| opinion | (w, a, b) | sum [−40, 40] | WP4 targetOpinion | WP5, WP2 |
| allied | (w, a, b) | any | WP4 | WP3 |
| warAppetite | (w, a, b) | mul [.2, 3] | WP4 | WP1 |
| casusBelli | (w, a, b) → [{cb, w, name?}] | concat | WP4 | WP3, WP5 |
| rates | (w, key) | mul [0, 5] | WP4 (prophet, schism, plagueEmergence, quake, volcano, meteor, storm, wildfire), WP3 (emergence, figureBirth), WP2 (bandSpawn, horde, beastSpawn) | WP1, WP5 |
| vegCap | (w, i) | mul [.2, 1.5] | WP4 ecology | WP5 |
| routeValue | (w, route) | mul [0, 2] | WP4 trade | WP2, WP1 |
| damage | (w, s, cause) | mul [0, 2] | kernel damageSettlement | WP5 |
| yearRecord | (w) → partial object | `mergeOf` (under each provider id) | WP6 | WP1, WP2, WP5 |

With no provider registered every helper returns its neutral value without allocating
(`mulOf` 1, `sumOf` 0, `firstOf` null, `anyOf` false, `concatOf` a shared empty array).
Code registries: `registerModKeys({ key: { default, limit: [lo, hi], kind: add|mul|set } })`
(WP3 merges into DEFAULT_MODS / LIMITS; known keys taming → WP2, forestFarm / deepHalls /
mortality → WP3, arcana / wards / luck → WP5's own providers), `registerTechs([def])` (extra
`branch: 'arcane'`, `school`, `races`, `minMana`, `available(w, civ)`; the arcane branch is
excluded from computeEra, grantEra, grantWorldKnowledge and era pacing),
`registerBuildings` / `registerWonders` (`race`, `available(w, s, civ)`). Each bumps
`extVersion()`, a process-local counter: fold it into caches in `world.cache`, never into
saved state.

### 6.1 Worldgen — WP4 (`src/gen/`)

`generateWorld(world, {preview, onStage})` — all noise sampled in **normalised coordinates**
(x/W, y/H with aspect) so a 128×80 preview resembles the full-size world with the same seed
and params. Use RNGs forked from `world.rng` / `createNoise2D(world.seed + ':purpose')`.
Pipeline:
1. **Plates**: `params.plateCount` noise-warped Voronoi plates; `params.continents` of them
   continental, the rest oceanic; random motion vectors; classify boundaries (convergent →
   ranges / trenches / volcanic arcs, divergent → rifts / mid-ocean ridges, transform).
   Write `plate`, `plateBoundary`.
2. **Elevation**: continental crust + fbm detail (`params.fragmentation` raises coastal
   noise amplitude/frequency → peninsulas, islands, inlets), ridged mountains along
   convergent edges scaled by `params.mountainHeight`, continental shelves, island arcs,
   a few hotspot island chains. Then normalise by rank so that exactly
   `params.oceanCoverage` of tiles are below 0.5 and land spans 0.5..1 with a pleasing
   hypsometric curve (lots of lowland, few peaks), ocean 0..0.5 (shelves near 0.45–0.5).
3. **Erosion** (`params.erosion`): hydraulic (droplet or stream-power) + thermal smoothing;
   carve valleys, soften peaks. Preview: very light. Keep ≤ 400 ms medium.
4. **Hydrology** `recomputeWater(world)`: ocean = below sea level and connected to the map
   edge or large basins (flood fill); priority-flood depression filling — sizable filled
   depressions on land become lakes (`WATER.LAKE`), small ones are just drained; flowDir on
   the filled surface; flow accumulation weighted by `baseMoisture`; river classes with
   thresholds scaled by `params.riverDensity`; coast, distCoast (BFS), landmass (BFS).
   Bump `versions.water` and emit `waterChanged`. Re-runnable any time (sea level change,
   terraforming, craters) — must preserve lakes sensibly and not touch non-hydrology fields.
5. **Climate baseline**: `baseTemp` from latitude (≈ 27 °C equator → −25 °C poles), lapse
   rate −6.5 °C/km, ocean moderation near coasts. Do **not** include `params.baseTemperature`
   (climate adds it). Wind bands (`windX/windY`): trade winds (E→W) 0–30°, westerlies
   30–60°, polar easterlies, scaled by `params.windStrength`, gently deflected around
   mountains. `baseMoisture` by advecting ocean moisture along the wind with orographic
   rainfall and rain shadows, ITCZ wet band, subtropical dry belts at ~25–30°, continental
   interiors drier, × `params.humidity`. Initialise `temp = annTemp = baseTemp +
   params.baseTemperature`, `annRain = rain = soilWater = baseMoisture`, `humidity`,
   `cloud`, `snow` (polar/high), `windX/Y`.
6. **Biomes** `classifyBiomes(world)`: Whittaker-style from annTemp/annRain, plus ICE for
   very cold, ALPINE for high peaks, WETLAND for flat wet lowlands near rivers/lakes,
   DEEP_OCEAN vs OCEAN by depth (shelf ≥ 0.42). Must produce sensible variety at default
   params (deserts in subtropics/rain shadows, rainforest at the wet equator, taiga/tundra
   toward poles).
7. **Soil** (alluvial river valleys and volcanic plains rich, deserts/ice poor,
   × `params.soilFertility`), **mineral** (mountains, boundaries), **resources** by
   geology/biome rules (copper/tin/iron in hills & boundaries, gold in mountains/rivers,
   gems rare, marble in hills, horses in grassland/steppe, spices in tropical forest,
   salt in deserts/coasts, furs in taiga/tundra, coal in temperate sedimentary lowlands,
   oil in desert basins/shelves) — ~3% of land tiles, `resourceAmt = 1`.
8. **Volcanoes**: 6–24 (× `params.volcanism`) along convergent boundaries and hotspots, on
   land or as islands, with names from `world.lang`.
9. **Features**: name continents (landmasses ≥ 2% of land), oceans/seas (large water
   regions; label anchor at a deep interior point), big islands, mountain ranges (clusters of
   high elevation, anchor + angle along their long axis), large lakes, great rivers (anchor
   mid-course), large deserts and forests. Names from `world.lang` with English kinds,
   e.g. "the Varan Sea", "Mount Oskel", "the Tirenwood", "Kesh Desert".
10. Call `onStage` with human labels ("Raising continents", "Carving rivers", …).
    Bump `versions.terrain/water/biome/features`.

`src/gen/terraform.js`: `export const system = { id: 'terraform', order: 5, init(){}, update(world){ … } }`
plus registered tools (group `terrain`): **raise**, **lower**, **flatten**, **mountain**
(ridge), **sink** (drown land into sea), **island** (raise an island from the sea).
Brush tools are continuous, soft falloff, strength slider. Tool `finish(world)` runs
`recomputeWater` + `classifyBiomes` once per stroke (and the system's `update` also runs it
if `world.pending.hydro` is set, max once per 5 days). Edits bump `versions.terrain`.
Settlement tiles that become water are handled by civ via `waterChanged`.

### 6.2 Nature — WP4 (`src/sim/climate.js`, `weather.js`, `ecology.js`, `disasters.js`)

**climate.js** (order 10)
- Global offset each month: `tempOffset = params.baseTemperature + drift + orbital +
  greenhouse − aerosolCooling`. `drift`: mean-reverting random walk (σ ∝
  `params.climateVolatility`); `orbital`: slow sinusoid with a few-thousand-year period
  (amplitude ∝ volatility) → occasional ice ages / warm periods; greenhouse: ≈ 3 °C per
  doubling of co2 above 280; aerosol cooling up to −4 °C.
- `temp` (striped, every ~5 days per tile): `baseTemp + tempOffset + seasonal`, seasonal
  amplitude ∝ `sin(axialTilt)`, |latitude| and continentality (distCoast), opposite phase
  in the southern hemisphere, small over oceans; regional slow anomalies.
- `annTemp` running mean; `snow`: accumulates when temp < 0 with precipitation, melts above
  0, persistent ice sheets at very cold annTemp, sea ice on cold ocean.
- `iceVolume` from total snow/ice; sea level (if `params.dynamicSeaLevel`):
  `seaLevel = baseSeaLevel + params.seaLevelOffset − k·(iceVolume − iceBaseline)`;
  when `|seaLevel − appliedSeaLevel| > 0.003` → `recomputeWater(world)`,
  `appliedSeaLevel = seaLevel`, chronicle coastlines drowning / land bridges.
  If not dynamic: only `seaLevelOffset` applies.
- Yearly: `classifyBiomes(world)`; chronicle notable shifts (biome changes > N tiles,
  ice age onset/retreat, record heat, "the Year Without Summer" after big aerosol).
- Update `world.climate.avgTemp / avgLandTemp / iceVolume`.

**weather.js** (order 15)
- Moisture cycle on a coarse grid (e.g. 4×4 tiles/cell via `ensureField`), updated every
  1–2 days: evaporation from warm water and wet vegetated land (transpiration ∝ veg, so
  deforestation dries regions), advection along wind, condensation when humidity exceeds
  a temperature-dependent saturation, orographic lift on windward slopes, rain shadows.
  × `params.humidity`, wind × `params.windStrength`. Upsample into tile fields `humidity`,
  `cloud`, `rain` at least every 2 days (bilinear). `soilWater` += rain − evaporation(temp,
  veg) − runoff, striped. `annRain` running mean.
- Storms (`world.storms`, × `params.stormRate`): tropical cyclones spawn over ocean with
  temp > 26 °C in late summer/autumn of their hemisphere, drift westward then curve
  poleward, intensify over warm water, decay over land/cold water; heavy rain; damage
  coastal settlements on landfall (`damageSettlement`, `devastation`, chronicle with storm
  names, imp 2–3, "The cyclone Arashi drowned the harbour of Kel"). Blizzards over
  high-latitude winter land. Thunderstorms over hot humid land in summer — lightning can
  `ignite()` dry vegetation. Sandstorms over deserts (mostly visual). Emit `fx` for
  lightning and landfalls.
- Droughts & floods: track regional soilWater/rain anomalies; chronicle great droughts
  (imp 3) and set `world.climate.droughtIndex`.

**ecology.js** (order 20) — exports `ignite(world, i, intensity)`.
- Striped updates (e.g. K = 6). `vegCap = BIOMES[b].vegMax × moisture(soilWater) ×
  temperature factor × soil factor × (1 − 0.85·farm) × (1 − snow) × (1 − 0.6·devastation)
  × (1 − 0.5·pollution)`; logistic growth × `params.vegetationGrowth`, dormant in winter;
  grazing by herbivores.
- Fire: `fire` intensity on tiles; ignition by lightning (weather), heat + drought chance
  × `BIOMES.fire` × `params.wildfireRate`, `ignite()`; spread to neighbours by veg, dryness
  and wind; burns veg to ~0.05, sets burnScar, slight soil boost after; rain extinguishes;
  burning settlement tiles → `damageSettlement`. Track notable fires in `world.fires`
  (name the big ones, chronicle with burned area km², imp 2–3). Fires must die out — no
  world-consuming blaze at defaults.
- Fauna: Lotka–Volterra with logistic prey capacity from veg × `BIOMES.herbCap`:
  herbivores × `params.faunaAbundance`, predators × `params.predatorRatio`; seasonal
  migration/diffusion toward better pasture; hunting pressure from `popDensity`
  (stronger before agriculture is common); chronicle regional collapses/extinctions and
  recoveries (rate-limited). Fish on water tiles × `params.fishAbundance` (richer on shelves,
  cold upwelling coasts, lakes), regrowth logistic; civ subtracts catch.
- Soil: regenerates toward a biome/moisture baseline; erosion when veg low and rain high;
  desertification feedback (overgrazed/deforested arid land loses soil and veg).
- Decay `devastation` and `burnScar` slowly.
- Tools (group `life` / `weather`): **bloom** (veg + soil), **forest** (plant trees),
  **herds**, **predators**, **fish**, **wildfire** (ignite), **rain** (soilWater/humidity up),
  **drought** (dry an area). Tools that belong to weather may live in weather.js.

**disasters.js** (order 25) — all rates × `params.disasterRate` and their own param.
- Earthquakes (× `seismicity`): along `plateBoundary`, Gutenberg–Richter magnitudes
  (many M4–6, rare M8+); damage settlements within a radius scaled by magnitude
  (pop, buildings, defense), devastation, slight uplift/subsidence (mark
  `world.pending.hydro = true` for big ones); undersea M ≥ 7.5 near coasts → **tsunami**
  hitting coastal settlements on that ocean within range. fx `quake`, `tsunami`.
- Volcanoes (× `volcanism`): activity rises stochastically; eruptions with VEI 1–7; lava
  flows downhill from the vent (raise elevation slightly, veg 0, ignite, devastation,
  destroy settlements in path), ash fall (soil + later), big eruptions add `aerosol`
  (VEI 6–7 → volcanic winter). Occasional new volcano at a hotspot. fx `eruption`.
- Meteors (× `meteorRate`): rare; size power-law; crater (depress centre, raise rim,
  `recomputeWater` if large), annihilate within radius, fires around, ocean impacts →
  mega-tsunami, large ones → `aerosol` impact winter + mass die-off of fauna. fx `meteor`.
- River floods in very wet months (settlements on river ≥ 2 tiles: damage + soil boost),
  locust swarms over hot dry grassland/farmland (eat veg and settlements' food stock).
- Tools (group `catastrophe`): **quake**, **volcano** (erupt nearest or raise a new one),
  **meteor** (strength = size), **tsunami**, **flood**, **locusts**, **storm** (spawn a
  cyclone or blizzard at the point; may live in weather.js).
- Chronicle with named events and magnitudes ("The Great Quake of Year 812 (M8.1) levelled
  Oskel and Tirn"). Importance by impact.

### 6.3 Civilization — WP3 (`src/sim/civ/`)

System entry `src/sim/civ/index.js` (order 40); split logic into files (`tech.js`,
`settlements.js`, `economy.js`, `territory.js`, `expansion.js`, `government.js`,
`rulers.js`, `culture.js`, `tools.js` …).
- **Genesis**: in `init`, if `!world.sys.civ`: spawn `params.civCount` tribes at the most
  habitable sites (food potential, fresh water, temperate), spread far apart, across
  different landmasses when possible; one camp/hamlet each (pop 80–200). Apply
  `params.startingEra` (grant all techs of earlier eras, scale starting pops).
- **civCreated hook**: give the civ a government, ruler (with dynasty), styled name.
- **Tech** (`tech.js`): 36–48 techs across the 8 `ERAS` with prerequisites, costs and
  effects on mods (agriculture, pottery, animal husbandry, bronze working, writing, the wheel,
  sailing, masonry, iron working, mathematics, currency, philosophy, engineering, medicine,
  feudalism, astronomy, printing, gunpowder, navigation, banking, sanitation, steam power,
  railways, electricity, industrial chemistry, vaccines, flight… your design). Research
  points monthly ∝ pop^0.6 × innovation trait × libraries × `params.techRate`; diffusion: techs
  known by contacted / trading civs cost less. `civ.tech.era` = highest era with enough
  techs. Chronicle discoveries (imp 2) and new eras (imp 4). Era pacing at `techRate` 1
  (medium map): Bronze ≈ Y300–600, Iron ≈ Y700–1100, Classical ≈ Y1100–1500, Medieval
  ≈ Y1500–2000, Industrial ≈ Y2200–3200.
- **Mods** (`getMods(world, civ)` — always a full object): multipliers default 1 unless
  noted:
  `farming (0/1 agriculture known), farmYield, gatherYield, fishYield, housing, health,
  birth, research, culture, production, trade, tradeRange (tiles, default 10),
  military, defense, siege, movement (army tiles/day multiplier), navigation (0 none,
  1 coastal, 2 open sea), medicine (≤1, multiplies plague lethality), sanitation,
  mining, stability (additive, default 0), expansionRange (tiles, default 8),
  industry (0..1+, default 0), pollution (default 0), plagueResist (additive 0..0.5)`.
  Combine techs, government, golden age, wonders. Cache on `civ.mods`, recompute monthly.
- **Settlements** (monthly per settlement, fine-grained):
  catchment of radius `s.radius` (grows with tier/tech) over tiles it owns; food from
  gathering/hunting (veg, herb, `wildFood`), farming (`farm × soil × climate suitability ×
  farmYield`, harvest seasonality), fishing (coastal/lake/river, depletes `fish`); farm
  conversion over time (raises `farm`, clears `veg`); soil exhaustion vs fallowing;
  granary storage & spoilage; famine → deaths, unrest, emigration (chronicle large ones).
  Population: births/deaths with health, food, housing, disease (read `s.disease`),
  war; logistic housing cap from tier/buildings/tech. Health (sanitation vs density),
  happiness (food, wealth, taxes, war weariness, faith match with state religion, golden
  age), unrest, loyalty (distance to capital, culture of origin). Production from labour,
  mining (`mineral`/`resourceAmt` depletion), timber (veg); wealth, taxes → treasury.
  Buildings gated by tech: granary, palisade/walls (levels), temple, market, library,
  harbour (coastal + navigation ≥ 1 → `s.harbor = true`), mine, barracks, aqueduct,
  university, hospital, factory, railway station…; wonders for great cities
  (`world.wonders`, prestige, chronicle imp 3–4). Tier changes chronicled (town→city 2,
  great city 3, metropolis 3). Writes `popDensity` over the catchment and `farm`.
  Industrial settlements emit `pollution` and add `world.climate.co2`.
- **Territory** (`territory.js`, every fourth month; a new founding claims its ground at once): multi-source Dijkstra from settlements, influence
  by population/tier/culture, cost by biome move cost / mountains / water (narrow straits
  crossable with navigation), radius cap; writes `owner`, `ownerSettle`; bump
  `versions.owner` only if anything changed; update `civ.territory`. ≤ 6 ms medium.
- **Expansion**: settlers when a settlement is large and food-pressured
  (× `params.expansionism` × traits.expansion): best site within `mods.expansionRange`
  (habitability, fresh water, resources, coast, ≥ 4 tiles from any settlement, own or
  unclaimed land; overseas with navigation). Transfer pop. Chronicle (imp 1–2).
- **Emergence**: new tribes arise in large unclaimed habitable regions
  (× `params.emergenceRate`), chronicle imp 4.
- **Government** (`government.js`): tribe → chiefdom → kingdom / theocracy / republic /
  empire / feudal realm / merchant republic / constitutional monarchy / democracy /
  dictatorship …, chosen by era, traits and events, with effects on mods/stability/taxes.
  Styled names ("Kingdom of Varath", "Varathi Empire", "Free Cities of Oskel").
  Reforms and revolutions chronicled (imp 3).
- **Rulers** (`rulers.js`): ruler persons with age, traits (wise, cruel, pious, warlike,
  craven, scholarly, greedy, just, mad, charismatic…), epithets earned from deeds
  ("the Builder", "the Cruel"); death by age/illness/battle/assassination; succession by
  dynasty / election / coup; succession crises → civil war (split via `createCiv({parentId})`
  + `transferSettlement`, and `startWar(world, [rebel], [parent], 'civil war', 'The X
  War of Succession')`). Keep `rulerHistory` (cap 60). Chronicle (imp 2–3).
- **Stability**: legitimacy, happiness, war weariness, overextension vs government capacity,
  faith unity, golden/dark ages, × `params.stabilityFactor`. Low stability → rebellions
  (settlements secede to a new civ or defect to a neighbour), collapse into fragments.
  Golden ages (prosperity, wonders, great figures) and dark ages (plague, defeat, famine).
- **Great figures** (`addFigure`): scholars, artists, generals (war module may name armies
  after a civ's generals), explorers, merchants. Prophets belong to the religion module.
- `waterChanged` hook: settlements now on water are destroyed ("swallowed by the sea").
- Cache per civ monthly: `population, territory, wealth, peakPopulation, peakTerritory,
  military.manpower` (≈ 3% of pop × mods.military).
- Tools (group `peoples` / `fate`): **tribe** (new people at the tile), **settle** (found a
  town for the owner/nearest civ), **prosper** (food, health, happiness), **enlighten**
  (research burst / golden age for the owning civ), **unrest** (incite rebellion → secession),
  **ruin** (devastate a settlement).

**Expansion (WP3, `docs/design/expansion-packages.md`):** computeMods applies civ effects and the
ext `mods` providers and merges registered mod keys / techs / buildings / wonders (lazily by
`extVersion()`); settlement phases read `settlementMods`; the ext call sites listed in §6.0
(people → race at genesis, habitat, siteBonus, settleName, demography, lifespan, nameStyle,
archStyle, loyalty, heroTarget, rates); the WP3 hooks of §6.0 (eraReached also writes
`sys.civ.eraFirst`); chronicle entries with `key` / `ref` (successions carry key
`succession`); divine acts as entity / pair tools (`acts.js`, all logged by the kernel);
tool previews (`previews.js`, never touching rng); `civ.style` and wonder geometry; dynasties
(should).

### 6.4 Geopolitics — WP4 (`src/sim/geo/`)

- **pathfinding.js** — A* with octile heuristic over tile costs: biome `move`, slope,
  river crossings, `road` (track ×0.6, road ×0.35, highway ×0.2), mountains expensive,
  ice very expensive; water impassable for land mode, land impassable for sea mode except
  start/goal coastal tiles; amphibious = land + sea at higher cost (embark penalty).
  `maxNodes` cap; LRU path cache keyed by (from, to, mode) invalidated by `versions.water`
  and `versions.terrain`; `travelCost(world, i, mode)` export.
- **diplomacy.js** (order 70) — exports `civPower(world, civ)`. Monthly: contact (borders
  touch, or settlements within trade range / sea reach) → create relations, chronicle first
  contact (imp 2); opinion drift from border tension (shared border length), faith (same +,
  different −, scaled by religiosity & tolerance), trade volume (+), alliances (+), past wars
  (decaying grievance), ruler traits, government similarity, relative power (fear), the
  aggression trait; treaties: non-aggression pacts, defensive alliances, trade agreements,
  vassalage of the weak to the strong, tribute; alliances dissolve when opinion falls.
  Chronicle alliances / vassalage / betrayals (imp 2–3). Tools (group `fate`): **discord**
  (sow hatred between the clicked civ and its neighbours), **harmony** (peace and
  goodwill).
- **war.js** (order 80) — Declarations monthly for contacted pairs, not under truce:
  probability from hostility, aggression trait × `params.aggression`, power ratio, ruler
  traits, casus belli (border tension, holy war vs other faith, succession claims, trade
  disputes, opportunism vs a neighbour already at war). War names ("The Salt War",
  "The Holy War of Ashen", "The Second Varathi–Oskel War"). Defensive allies join.
  Armies raised from settlement manpower (cost treasury, reduce population/production),
  marched with `findPath` (amphibious when navigation ≥ 1 and needed; `army.naval` while on
  water) toward targets (border towns, weakly defended, wealthy, enemy armies), moving
  daily by `mods.movement` and terrain. Battles when hostile armies are within ~1.5 tiles:
  strength × military mods × morale × terrain/defense × general × randomness; casualties,
  retreats, routs; named battles ("the Battle of the Tiren Fords") chronicled imp 2–3;
  fx `battle`. Sieges: armies at an enemy settlement reduce defense/garrison over days
  (fx `siege`), capture → `transferSettlement(..., 'conquest')` with population loss,
  possible razing (cruel ruler / holy war → `destroySettlement('razed')`), fx `capture`,
  chronicle imp 3. Devastation along army paths and battlefields. War score, war
  weariness (`civ.warWeariness`), peace when exhausted or decisive — white peace,
  ceding occupied towns, tribute → `endWar` (truce). Civil wars started by the civ module
  are fought by the same machinery. Clean up on `civDestroyed`. After changing any
  `war.attackers/defenders/active` yourself, call `bumpVersion(world, 'wars')` (the
  `areAtWar` cache keys on it). Keep the world from
  permanent total war: at defaults, a typical civ is at war 15–35 % of the time.
- **trade.js** (order 60) — Monthly: establish routes between settlements of the same civ
  or of civs at peace with opinion > −25 and contact, within `mods.tradeRange` (sea routes
  need coastal + navigation and harbours), prioritising size and complementary resources;
  route caps by tier; paths via `findPath`; land routes build up `road` along their path as
  traffic accumulates (bump `versions.roads`); route value → both settlements'
  `tradeIncome`, civs' relation `.trade` and opinion, tech diffusion (relation.trade > 0
  counts as contact for civ tech). Spawn caravans/ships that travel routes daily (visual,
  and carriers for disease). Routes break on war, destruction or blocked paths.
  × `params.tradePropensity`. Chronicle famous routes (imp 2–3, e.g. "the Amber Road").
- **religion.js** (order 50) — Folk beliefs by default (`religion = {}`). Prophets
  (`addFigure` kind 'prophet') arise in cultured settlements (× `params.religiosity`,
  × civ religiosity trait), founding named faiths with tenets (e.g. sun worship, ancestor
  cult, monotheism, dualism, mystery cult, philosophy of the Way, nature spirits) that alter
  behaviour (militant → holy wars, tolerant → peace, ascetic → stability, mercantile →
  trade). Spread by adjacency within territory, along trade routes, by conquest and state
  pressure; civs adopt a state religion (`civ.stateReligion`); conversions; schisms
  (new faith with `parentId`); faiths die without followers (`alive = false`).
  Maintains `settlement.religion`, `dominantReligion`, `religion.followers`. Chronicle
  (imp 2–4). Tools (group `fate`): **prophet** (found a faith at the settlement), **miracle**
  (fervour wave in an area).
- **disease.js** (order 55) — Plagues arise monthly in crowded, unhealthy settlements, at
  first contact between peoples, and from livestock/fauna (× `params.plagueRate`), with
  generated names ("the Grey Cough", "Red Sweat", "the Weeping Pox"), infectivity,
  lethality (× `params.plagueLethality` × civ `mods.medicine`), duration; SIR per settlement
  (`s.disease = {pid, I, R}`, immunity waning); spread along trade routes and caravans,
  between nearby settlements, with armies. Deaths reduce population; panic raises unrest.
  Chronicle outbreaks, toll, end (imp 3–4); fx `plague`. Tools: **plague** (outbreak at the
  settlement), **cure** (end plagues in an area).

**Expansion (WP4):** emits the war, faith, trade, plague and nature hooks of §6.0 with exact
payloads (storms keep a decimated `track`); every geo / nature chronicle writer gets `ref` and
`key` (minor battles `battle.minor`, pacts `pact.nap` / `pact.trade`, so the news filter can
fold them); the war ledger (`geo/ledger.js`, `war.ledger`); generals promoted to figures only
after great victories; all casualties through `damageArmy`; ext call sites battle, siege,
opinion, allied, warAppetite, casusBelli, rates, vegCap, routeValue and settlementMods
trade / plagueDose / defense; armies with `flags.hunt` are WP2's (war planning, movement,
peace disbanding and civDestroyed cleanup skip them); `flags.merc` armies are normal
soldiers; pair tools incite_war, broker_peace, forge_alliance, open_route; previews for every
geo / nature / gen tool.

### 6.5 Visual effects queue (`emitFx`)

Types the renderer must draw (others ignored): `meteor {r}`, `quake {r, intensity}`,
`tsunami {r}`, `eruption {r, intensity}`, `lightning`, `landfall {r}`, `battle {intensity}`,
`siege`, `capture {civId}`, `plague {color}`, `faith {color}`, `wonder`, `founding {civId}`,
`newcivs {civId}`, `rebellion {civId}`, `fire {r}`, `flood {r}`, `divine {r}` (tool used),
`famine`, `discovery {civId}`.

Expansion (contracts §13). `emitFx` accepts the fields `type, x, y, r, civId, intensity, text,
color, x2, y2, tone, sign, glyph, size, src`. The intervention kit drawn by WP7:
`bless {r}`, `curse {r}`, `terraform {r, sign, intensity}`, `sprout {r}`,
`spawn {r, glyph: herd|pred|fish}`, `raincall {r}`, `parch {r}`,
`thread {x2, y2, tone: hate|peace|trade|alliance|marriage}`, `label {text, tone, size}`,
`swirl {r}`, `rewind {r}`, `riot {r}`, `fair {r}`. An fx with `src: 'tool'` is never
time-scaled, gets priority 10 and an off-screen pointer (tools set it on everything they
emit; `divine` gives way to the polarity types). Registered by their owners through
`registerFxType` (§7): `raid`, `dragonfire`, `slay`, `summon` (WP2); `spell {color}`,
`leyflare`, `awaken` (WP5).

### 6.6 Events — WP1 (`src/sim/events/`, order 84)

The event deck over the kernel registry `core/events.js`: `registerEvent(def)`,
`getEvents(scale)`; scales town, realm, pair, land, world, figure. `def = { id, scale, family,
cat, imp, minEra?, maxEra?, minMyth? (0), maxMyth? (2), cooldownYears, tags?, weight(ctx),
fire(ctx) }`; `weight` is pure (no rng, no allocation) and returns expected firings per check;
`fire` uses world.rng, `addEffect`, kernel functions and published exports, and writes its
chronicle entry with key `'event.' + id`, a `ref` and a `cause`. `ctx = { world, day, era,
scale, s?, civ?, a?, b?, land?: { feature, lm }, heat(tag), mythLevel }`. The engine excludes
defs out of myth / era bounds before summing weights and draws exactly one `rng.next()` per
check (plus one `weightedIndex` pick only when it fires). WP1 also owns world ages and black
swans (the `rates`, `warAppetite`, `routeValue` providers; params `fortune`, `worldAges`),
city character (sole writer of `s.traits`, `s.epithet`, `s.legend`, `s.hist`), the annals
news filter (`setNewsFilter`: routine successions, small battles and minor pacts fold;
decade digests `annals.decade`) and the `fate` entity tool. Details: packages WP1.

### 6.7 Bands — WP2 (`src/sim/bands/`, order 82)

Every roaming non-state actor on the kernel band shape (§5): bandits, pirates, free
companies (hired as `flags.merc` armies), steppe hordes, migrations (always on; param
`banditry` × rates `bandSpawn`), and — only when `mythOn(world)` — beasts and dragons (lairs as
pinned sites, sleeps, raids, hoards, slayers; param `monsterAbundance`). Raids use
`damageSettlement` × `settlementMods(s).raidRisk`; clashes use `damageArmy` and emit `battle`
with kind `band` / `beast`; hunts are armies with `flags.hunt`. Caps: ≤ 40 people-bands with
total strength ≤ 3 % of world manpower; 0–6 dragons alive. Details: packages WP2.

### 6.8 Myth — WP5 (`src/sim/myth/`, order 86)

The Mythic mode behind the gate (§11): races and their providers, identity (tongues, titles,
architecture, racial buildings and wonders), ley lines and mana (fields §4), arcane schools as
a registered tech branch, registered mod keys, the `myth` tools, and (should) the gods'
answers and the Fading. At mythLevel 0 the system returns before touching rng and every
provider is neutral. Details: packages WP5 and §11.

### 6.9 Ledgers, records, sites — WP6 (`src/sim/stats.js` and friends, order 100)

`stats.js` also runs the entity ledger (`world.history.series`, doubling-step decimation at
48 samples per channel; `series()` / `ownerChain()`), the hook-driven sites recorder
(`core/sites.js addSite`), the catastrophe catalogue (`history.events`, cap 500) and the Hall
of Records (`sys.stats.records`). Yearly records merge `mergeOf('yearRecord')`. Budget 7 ms
per year in total. Details: packages WP6.

## 7. Renderer — WP7 (`src/render/`)

```js
const r = createRenderer(canvas, world);
r.setWorld(world)            // swap after load / new world
r.render(nowMs)              // draw one frame (call every rAF)
r.resize()                   // after canvas CSS size change (handles devicePixelRatio ≤ 2)
r.camera                     // { x, y, zoom }  x,y = tile coords at view centre, zoom = screen px per tile
r.pan(dxScreen, dyScreen); r.zoomAt(sx, sy, factor); r.focusOn(x, y, zoom?)  // smooth
r.fitWorld()
r.screenToTile(sx, sy) → { x, y, i } | null        // CSS pixel coords relative to canvas
r.tileToScreen(x, y) → { sx, sy }
r.setMapMode(id); r.mapMode
r.setOverlay(name, on); r.overlays   // borders, labels, rivers, roads, clouds, units, routes, features
r.setSelection({ kind: 'tile'|'settlement'|'civ'|'army'|null, id, x, y })
r.setBrush({ x, y, radius } | null)
r.setAtlasSnapshot(snapshot | null)  // §8 — draw historical borders instead of live ones
r.pickEntity(sx, sy) → { kind: 'settlement'|'army'|'storm', id } | null   // hit-test icons
r.drawMinimap(ctx, w, h)             // whole world small + viewport rectangle
r.getLegend() → { title, type: 'gradient'|'swatches', stops?: [[t, css]], items?: [{label, color}] }
renderPreview(world, canvas)          // static terrain image for the setup screen
MAP_MODES = [{ id, label, desc }]
```

Expansion additions (contracts §14; WP7 implements them in renderer.js):

```js
r.setToolPreview(p | null)           // a previewTool() result: reticles, outlines, rings, threads, invalid flag
r.setHighlights([{ x, y, r, tone, label? }])
r.pickAll(sx, sy) → [{ kind, id }]   // every stacked hit, topmost first
r.recentFx(sinceMs) → [{ type, x, y, r, civId, t }]
r.onFx = (fx, { sx, sy, onScreen, dist }) => …   // assignable callback
r.getZoomInfo() → { z, name, band, kmPerPx, next }
r.frameBox(x0, y0, x1, y1, pad)      // fly to frame a box
r.lodReady                           // true once the LOD chunk pyramid can serve deep zoom
r.setSelection({ kind: 'civs', ids }) / r.setSelection({ kind: 'box', x0, y0, x1, y1 })
```

Overlay ids are dynamic (registered overlays join the built-ins). Hit kinds: settlement,
army, storm, band (WP2), site, wonder, landmark, volcano, caravan, swarm, fxPointer (WP7),
pin (WP8).

**Render registries** (`src/render/layers.js`, the lead's Wave 0 file):
`registerLayer({ id, slot, order, draw(r, ctx, env) })` with slots `ground` (world transform,
after the raster), `overTerritory` (after borders), `underIcons` (screen space, before
settlements), `units` (after armies and caravans), `overUnits` (after storms), `labels` (push
candidates into `env.labels` before placement), `hud` (after labels);
`env = { z, dpr, prof, mode, labels, vb, now, dt, worldT(), screenT(), snapshot }`; layers push
`r.hits` entries `{ kind, id, x0, y0, x1, y1, pri }`. `registerFxType(type, { dur, priority,
cap, draw(fx, ctx, r, t, now), onStart? })`. `registerMapMode({ id, label, desc, when(world),
profile, territory?(r) → { key, catFn, colorFn }, legend(world) })`.
`src/render/plugins.js` guard-imports `./bands.js` (WP2), `./myth.js` (WP5), `./overlays.js`
(WP6), `./pins.js` (WP8) and WP7's own new modules (`raceplan.js` is a static import of `cityplan.js`).

Data the renderer reads: `civ.style`, `race` with `RACE_META`, `s.traits` and `s.epithet` (in
labels at z ≥ 8), `s.buildings`, `s.project`, `s.siege`, wonder `path` and `i`, `world.sites`
with `SITE_KINDS`, `world.bands` with `BAND_KINDS`, and `f.ley` / `f.mana` (WP5 only).

Map modes: `terrain` (default, natural atlas), `political`, `elevation`, `temperature`,
`rainfall`, `biome`, `vegetation`, `fauna`, `population`, `religion`, `culture`
(settlement origin civ), `tech` (era of owner), `trade` (roads & routes emphasised),
`disease`, `plates`, `resources`, `devastation`, `pollution`; registered: `arcane`,
`peoples`, `monsters` (WP5, when mythLevel ≥ 2).

Art direction — a living, hand-tinted atlas:
- Terrain: offscreen canvas at ~4 px/tile with bilinear-interpolated elevation hillshade
  (light from the north-west), smooth biome-colour blending, vegetation density shifting
  green ↔ ochre bare ground, farmland as fine patchwork that greens in spring, turns gold
  at harvest, browns in winter; snow/ice overlays by `snow`; burn scars charcoal;
  devastation rust; pollution grey haze. Water: depth gradient deep navy → shelf teal,
  gentle animated shimmer, soft light coastline rim, sea ice. Rivers as tapered lines
  following `flowDir`, width by class. Refresh the terrain canvas incrementally (a band of
  rows per frame) so seasons sweep smoothly without frame spikes; full rebuild on
  `versions.terrain/water` changes.
- Borders: civ-coloured lines (crisp ink edge + soft inner glow); translucent fills in
  political mode. Roads: dotted/dashed warm lines by level.
- Settlements: procedural icons by tier (tent → huts → village cluster → walled town →
  towered city → great city → skyline), civ-coloured, capital marker; labels in the map
  serif with halo, size by tier, LOD + greedy collision avoidance.
- Town plans at close zoom (`cityplan.js`): human towns, and each Mythic race's own plan
  (`raceplan.js`: halfling smials, dwarf terraces and hold gate, elf groves, orc tents and
  war-pit, lizardfolk stilt huts and ziggurat) on the shared plan geometry; population sets
  the size, walls follow their level, landmarks come from the buildings.
- Labels: minor labels (sites, features, ruins, ley nodes, lairs) keep off town-plan
  footprints (a site inside a plan is listed below it; a site label that only repeats a nearby
  town's name is dropped). Labels on moving things (marching armies, bands, storms, fires) are
  placed fresh each frame after the still lettering, which is reused while nothing that
  decides it changes (camera, zoom, label set, plan footprints, fonts, night), for up to 600 ms.
- River deltas start where the river meets the drawn coast and show from z5 to z34; rivers
  end at the drawn coastline.
- Units: armies as civ-coloured banners with strength, ships when `naval`; battles spark;
  sieges pulse; caravans tiny amber dots, ships with wakes; storms as rotating spirals
  (cyclones), blizzard swirls, thunderstorm flashes; clouds as soft drifting layer with
  faint shadow; fires flicker and smoke; volcano glyphs smoke when active, glow when
  erupting.
- fx: meteor streak → flash → shockwave ring → glowing crater; quake ripples (+ subtle
  shake if `prefers-reduced-motion` is not set); tsunami rings; plague pulses; faith rays;
  founding banners.
- Features: cartographic labels — continents in wide letter-spaced capitals, seas in italic,
  ranges along their angle, rivers small italic.
- Selection highlight; brush circle preview.
- Atlas snapshot: political map from the snapshot owner grid (nearest-neighbour upsample)
  with historical civ colours, plus its settlement list.
- 50+ fps at 1440×900 on a medium map: cache layers, cull offscreen, cap particles.

## 8. UI — WP8, WP6, WP5 (`index.html`, `styles.css`, `src/main.js`, `src/ui/*`, `src/sim/stats.js`)

The sections below describe the shipped UI. The expansion adds (contracts §11, §15; details
there):

### 8.1 Tools, interventions, keyframes (kernel: `core/tools.js`, `keyframe.js`, `replay.js`)

- **Tool defs** gain `target: 'pair' | 'entity'`, `pick` (pair: two of civ / settlement /
  tile), `entity: { kinds }`, `available?(world)`, `hidden?`, `charge?`, `polarity`
  (boon | bane | neutral), `danger?(opts)`, `preview?(world, x, y, opts)` → `{ ok, reason?,
  text?, targets?, rings?, threads?, estimate?: { deaths?: [lo, hi], towns? }, severity?,
  cards? }` (pure), `applyPair(world, a, b, opts)`, `applyEntity(world, target, args)`.
  Kernel: `availableTools(world)` (hidden tools included; the palette skips them),
  `previewTool` (try/catch; restores and reports a preview that drew rng), `applyPairTool`,
  `applyEntityTool`. Reserved tool ids: WP3 bless_ruler, curse_ruler, smite_ruler,
  grant_heir, gift_tech, commission_wonder, rename, cede_town, send_settlers, depose,
  arrange_marriage; WP4 incite_war, broker_peace, forge_alliance, open_route, steer_storm,
  command_army; WP1 fate; WP2 summon_beast, slay_beast, tame_beast; WP5 ley_line, wellspring,
  awaken_magic.
- **Interventions:** `{ seq (index in the log), day, kind: tool|finish|pair|entity|param, id,
  x?, y?, opts?, pts?, a?, b?, target?, args?, key?, value?, refused? }`, appended by the kernel
  on every apply and on `setParam(..., { log: true })`, unless `world.cache.replaying` is set,
  the call passed `opts.log === false`, or it is nested inside another logged apply. `day` is
  the day at the call; on replay the act is applied before that day's `sim.step`. Saved with
  the world. A brush stroke's ticks on one day (same continuous tool and opts) join one entry
  (`pts`, never across a keyframe or a finish); an apply the world refused is logged with
  `refused: true` (refusals are pure), and an undo replay leaves out the refused entries after
  the undone act. Map-tool opts are sanitised (non-finite radius / strength → defaults) before
  the apply, so the log holds exactly what the tool saw.
  Every apply emits `toolApplied { kind, id, x, y, opts, result, seq }`.
- **Keyframes:** `captureKeyframe(world)` → `{ day, ivSeq, check, rng, keys, fields, state,
  history, chronicle }` (state = a deep copy of the world minus f, cache, fx, rng, history,
  chronicle, ui; history arrays and chronicle entries are sliced and shared). The copy is made
  by `cloneData` (plain JSON-like data, holes / undefined / NaN / -0 kept, several times faster
  than structuredClone), and copies of closed records (§1) are cached by object identity and
  shared by every keyframe taken while the record is untouched, so at Y1000 a capture copies
  little more than the living world (medium map: ≈ 4.5–5.5 ms when the previous capture is
  recent, ≈ 7.5 ms ten sim-years after it, ≈ 16 ms for the first capture in a freshly loaded or
  restored world, which copies everything; ≈ 26–35 ms before). Keyframes are
  never edited. `restoreKeyframe(kf, { ui })` → a new world (a full deep copy of the keyframe, so
  it never shares an object with one; versions bumped, cache {}, fx [], ui kept).
  `KEYFRAME_DEV.verify = true` checks every shared copy against its record at each capture and
  lists stale ones in `KEYFRAME_DEV.misses` (the headless `--trial` and `--keyframe-check` use it);
  `worldChecksum(world)` → FNV hex over owner, elevation (stride 7), rounded popDensity,
  settlement populations, civ treasuries, bands (position, hp, strength/power), armies
  (position, strength), active wars (score, battles), sites (n, fame), the war and figure
  counts, rng.state, chronicle.seq and day.
- **Replay:** `replayStep(world, sim, log, skip)` applies the log entries dated today (seq
  order, re-logging them) then steps; `replayTo(world, sim, log, targetDay, { skip, from,
  onProgress, sliceDays, sliceMs, applyFinal, signal })` is the async slicer (entries with
  `seq < from`, default `world.interventions.length`, are already in the world). Undo =
  restore the nearest keyframe at or before the act, `replayTo` with that seq skipped.
  Keyframes live only in memory, except in branch saves (WP8).

### 8.2 UI registries and app API (`src/ui/registry.js`, `src/ui/mounts.js`)

`registerView(kind, { label, icon, mount, describe?, point?, frame?, rendererSel? })` (the
inspector and selection / follow / framing consult it for every non-built-in kind),
`registerSection(kind | '*', …)`, `registerTitleAction`, `registerTab` (app.TABS derives from
it), `registerKey` (after the built-ins; the help sheet lists every key), `registerCommand`,
`registerSearchSource`, `registerContextProvider`, `registerToastFilter`,
`registerUntilCondition`, `registerDirectorSource`, `registerOverlay`, `registerIcon`.
`src/ui/mounts.js` lists the package modules that export `mount(app)` (WP8 director, until,
command, contextmenu, watch, chrono, acts, deedcard, timeline, audio; WP6 annals, digest,
views/records; WP2 views/band; WP5 views/myth, legends). Reserved keys: G Director, U / Shift+U
run until, / and Ctrl/Cmd+K command palette, . watch, B pin view (Shift+1–9 jump), Y timeline,
Z frame selection, Ctrl/Cmd+Z / Shift+Z undo / redo, Q / E previous / next tool, R Annals,
O Legends. App API: `app.follow`, `app.fastForward(years, prog, { until })`,
`app.restoreWorld(world, { reason })`; app events `userCamera`, `mapContext`, `mapDblClick`,
`leapDone`, `worldRestored`, `toolApplied`, `chronicleScrollTo`, `timeTravel`, `atlasGoto`.
`src/ui/plate.js drawAtlasPlate(canvas, world, snapshot | null, { box?, marks? })`. Each
package styles itself in `src/ui/css/<package>.css` with tokens from `styles.css` only; pref
keys are prefixed with the package name. The genesis screen honours `visibleIf`, groups the
mythic presets by `preset.mode` and offers the Historical / Legendary / Mythic switch (WP5).

### 8.3 The shipped UI

- **Genesis screen**: title "Atlas of Ages"; seed field + reroll; preset cards (`PRESETS`);
  every `PARAMS` control grouped by `PARAM_GROUPS` (sliders with value readouts using
  `display`/`unit`, selects, toggles, descriptions); live preview map (debounced ~250 ms:
  `createWorld({...params, worldSize: 'preview'})` → `generateWorld(w, {preview:true})` →
  `renderPreview`); "Begin" generates the full world with staged progress text, then
  starts the simulation.
- **HUD** over a full-bleed map canvas: world name, date (`dateString`) and season,
  speed controls (pause + speeds; keys Space, 1–6), headline numbers (population, nations,
  wars), map-mode picker with legend (`getLegend`), overlay toggles, minimap with viewport.
- **God tools palette** from `getTools()` grouped by `TOOL_GROUPS`, each with an inline SVG
  icon keyed by `icon` (design a coherent glyph set; fallback to an initial), tooltip from
  `desc`, brush radius + strength sliders. Default tool = Inspect. Continuous tools apply
  every ~80 ms while dragging; `finishTool` on release. Feedback toast from the tool's
  result message.
- **Side panel tabs**: Inspector (tile: every field humanised — elevation m, °C, mm/yr,
  biome, soil, veg, herds, fire, owner, resource…; settlement: everything incl. buildings,
  faith shares, disease, routes, siege, history; civ: styled name, government, ruler &
  dynasty & history, traits bars, era & techs, treasury, stability, relations with
  opinion bars, wars, allies, sparkline; army; war), Chronicle (virtualised list, category
  chips, importance filter, search, click → focus map & select), Nations ledger (sortable;
  fallen nations with lifespans), Statistics (canvas charts from `world.history`: world
  population, population by nation (stacked), temperature / sea level / CO₂, forest /
  herds / predators, wars & plagues), World (every `live` param as a slider, with "reset
  to genesis"), Atlas (scrub `world.history.atlas` snapshots → `renderer.setAtlasSnapshot`,
  play as timelapse, list the era's key events).
- Toasts for imp ≥ 3 entries (click to focus); option to auto-pause on imp 5.
- **Input**: wheel zoom at cursor; drag pan (left-drag with Inspect, right/middle-drag or
  Space+drag always); WASD/arrows pan; +/- zoom; Esc → Inspect; `M` cycles map modes;
  `H` hides UI; touch pan / pinch-zoom / tap.
- **Save/Load**: IndexedDB slots (`serializeWorld` + `compressJSON`), export/import file
  (downloads may be blocked inside sandboxed hosts — fail gracefully with a message;
  import via file input always works). Optional autosave every 100 years.
- **Loop** (`main.js`): rAF → `sim.advance(dt, budget)` → `renderer.render(t)` → panels
  refresh ≤ 4×/s. Error overlay if a module fails to load. Expose `window.atlas = { world,
  sim, renderer }` for debugging.
- **stats.js** (order 100): yearly record into `world.history.years`:
  `{ y, pop, civs, towns, temp, landTemp, sea (m), co2, ice, veg, herb, pred, fish, wars,
  plagues, faiths, era, civ: { [id]: [pop, territory, towns, era, power] } }`
  (keep ≤ 1500 records; thin older ones); every 10 years an atlas snapshot
  `{ y, w, h, owner: base64 Int16Array at half resolution, towns: [[x, y, civId, tier, name], …top 150] }`
  into `world.history.atlas` (≤ 600 and about 6 MB; thin older ones). Also refresh `world.stats` summary each month.
  Closed records shed working state on a rolling basis (saves and keyframes track living
  history): a war 50 years over keeps 2 army summaries, 8 battles and 12 transfers in its
  ledger; 20 years after a fall, a realm drops its stability/capacity tallies, arcane pool and
  lapsed effects, a dead town its potentials and lapsed effects.
- Design: dark-first "observatory instrument" chrome around the map — deep blue-slate
  panels, brass accent, verdigris secondary, parchment-tinted text; a light theme
  variant; display/map lettering `IM Fell English` (+ SC), UI text `Alegreya Sans`, data
  `IBM Plex Mono` (Google Fonts, with fallback stacks). Define all colours as tokens on
  `:root` with dark default and light overrides under `prefers-color-scheme: light`
  guarded by `:root:not([data-theme="dark"])` and again `:root[data-theme="light"]`
  (`color-scheme` set accordingly); `body` has an explicit background. Works at phone width:
  panels become a bottom sheet, palette scrolls horizontally, 16 px side gutters, no
  horizontal page scroll. `html, body { height: 100% }` (not 100vh). Visible focus
  states, `prefers-reduced-motion` respected, form controls have ids and labels.
  Avoid emoji as icons.

## 9. Balance targets (headless, medium, defaults, `--years 1000`)

- No system errors, no NaN/Infinity anywhere.
- Year 1000: 5–25 nations alive; ≥ 2 have fallen and ≥ 1 new people emerged or split off;
  40–400 settlements; world population 1M–60M; largest city 30k–1M.
- At least one civ reaches the Bronze Age by Y600 and the Iron Age by Y1100.
- Wars: after Y200, on average ≥ 1 new war per 50 years among contacted civs; wars end.
- Ecology: herbivores and predators persist globally; forests retreat around civilisations
  but land-average veg stays ≥ 50 % of its genesis value.
- Climate: seasonal swings visible; land-average annual temp stays within ±2.5 °C of
  genesis over 1000 years at volatility 0.3 without industry.
- Plagues: 1–8 notable outbreaks per 1000 years; none kills > 60 % of world population.
- Disasters: several quakes and eruptions per century; meteors rare (0–2 per 1000 yrs).
- Chronicle: 2–40 entries of imp ≥ 2 per sim-year on average — enough to read, not spam.
- Performance: ≤ 150 ms per sim-year total (§2).

**Integration gate for the expansion** (contracts §17) — a batch of 5 seeds × 1000 years at
defaults *and* at mythLevel 2 meets all of the above plus:
- imp ≥ 2 entries in Y0–250: at least 1.5 a year; the first imp ≥ 4 entry before Y60 in at
  least 4 of 5 seeds; the p90 gap between imp ≥ 3 entries at most 10 years.
- War is at most 40 % of imp ≥ 2 entries after Y250; routine successions at most 20 % of
  imp ≥ 2 entries in the Nations category.
- World population falls by 10 % or more within some 50-year window in at least 2 of 5 seeds.
- `headless --determinism` and `--rewind-test` pass; save → load → continue gives an
  identical `--hash`.
- At most 150 ms per sim-year at Y1000 on an idle machine; browser zoom sweep median ≤ 12 ms,
  p90 ≤ 20 ms; save size grows at most 3 MB at Y1000.
- Mythic (mythLevel 2, §11): each race alive at Y1000 in at least 60 % of seeds; expansion
  and era pacing within ±25 % of Historical; 3–15 major (imp ≥ 3) Myth & Magic entries per century; 0–6
  dragons alive at any time.
- Then rebuild `Atlas of Ages.html` with `tools/build-standalone.mjs` and run a full browser
  pass at desktop and 390×844.

Package acceptance targets (events per century, band caps, generals, hook counters, zoom
performance, undo latency …) are listed with each package in `docs/design/expansion-packages.md`.

## 10. Testing

- `node tools/headless.mjs --years 300 --size medium` (add `--gen fallback` to test sim code
  without the real generator, `--only climate,ecology` to load a subset of systems,
  `--exclude myth` to leave modules out entirely, `--set key=value` to change params,
  `--save path` / `--load path` to test the save/load round-trip, `--hash` to print
  `worldChecksum` at the end). After the Balance block, headless prints every system's
  `report(world)`; a failing check prints `!!` and makes the exit code 1.
- `node tools/headless.mjs --determinism [--years 200]` runs the years at mythLevel 0 twice in
  child processes, once without the myth module (not even imported); the FNV of
  `serializeWorld` minus `sys.myth` must match. The verdict is that comparison alone (the
  children's own balance and report checks judge whole histories and are listed for
  information). Run it after any change near the mythic gate.
- `--fullhash` prints the FNV of the whole saved state (sys.myth included) minus `versions`:
  an optimisation meant to leave results unchanged must leave it (and `--hash`) equal, e.g. over
  3 seeds × 600 years at mythLevel 0 and 2.
- `node tools/headless.mjs --keyframe-check [--years 600] [--every 360] [--set mythLevel=2]`
  captures a keyframe every `--every` days on a medium world with `KEYFRAME_DEV.verify` on (a
  stale shared copy is a code path that edited a closed record without `touchRecord`), restores
  the last keyframe and one `--back` (60) years earlier, replays both to the end, compares the
  full saved state and times a capture with the copies cached.
- `node tools/headless.mjs --rewind-test` captures a keyframe at Y40, drops a scripted meteor
  through `applyTool` at Y45 and runs to Y50 (checksum A), then restores the keyframe and
  `replayTo` Y50 (checksum B): A must equal B, and so must the full saved state minus the
  version counters a restore bumps.
- `node tools/headless.mjs --trial [--set mythLevel=2] [--rs n] [--years 60] [--acts 14]` is the
  randomized gate: one small world takes random acts of every kind (strokes, pair and entity
  acts, live params) over 60 years; the full saved state (sys.myth kept, versions dropped) must
  match after save → load → continue (one save right after an act) and after keyframe restore +
  replay, and every capture (plus one every 5 years) verifies the keyframes' shared copies. Run
  it at mythLevel 0 and 2 after any change to sim state, caches, tools or the kernel, and now
  and then over 600+ years (`--years 650 --acts 40`).
- Save → load → continue: `--years 100 --save s.json --hash`, then `--load s.json --years 100
  --hash` must print the same checksum as a straight `--years 200 --hash`.
- Package tools: `tools/events-report.mjs` (WP1, 5 seeds × 1000 years),
  `tools/myth-check.mjs` (WP5, 10 seeds), `tools/zoom-perf.mjs` (WP7, headless Chrome).
- `node --check file.js` for syntax. Before `tools/build-standalone.mjs`, make sure no import cycle joins modules that
  wait on a top-level await (contracts §18): the bundled page would never finish loading. Render/UI code: run a static server
  (`python3 -m http.server <port> --bind 127.0.0.1` from the project root, in the
  background) and open `http://127.0.0.1:<port>/`.
- Browser screenshots and console capture with headless Chrome (view the PNG with the Read
  tool; console lines appear as `INFO:CONSOLE`):
  ```
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
    --hide-scrollbars --user-data-dir=<scratch>/chrome-profile --window-size=1440,900 \
    --virtual-time-budget=10000 --screenshot=<scratch>/shot.png \
    --enable-logging=stderr --v=0 "http://127.0.0.1:<port>/<page>" 2>&1 | grep CONSOLE
  ```
  Use your own `--user-data-dir` so parallel runs do not collide. Keep scratch files
  outside the project folder.

## 11. Mythic design bible (contracts §16)

**One dial, `mythLevel`** (param, group `myth`, not live; `mythLevel(world)`,
`mythOn(world, min = 2)`):
- **0 Historical** — nothing mythic. No myth code draws rng, allocates fields or lists,
  answers a provider non-neutrally or adds event weight (`--determinism` proves it).
- **1 Legendary** — belief-only folklore: a WP5 deck of omens, saints and relic sites,
  witch-hunts and haunted ruins (should). The option stays disabled until that deck is
  registered.
- **2 Mythic** — everything below. Mid-run, only the Awaken Magic act may raise it:
  `setParam(world, 'mythLevel', 2, { force: true, log: true })`, then `mythAwakened`.

**Ownership.** The gate is WP5's. All mythic behaviour lives in `src/sim/myth/**` (WP5) and
`src/sim/bands/kinds/{beasts,dragons,undead}.js` (WP2); all mythic rendering in
`render/myth.js` (WP5) and `render/bands.js` (WP2). Everything else reaches the myth through
ext providers, registered data and published exports, so a Historical world never notices it.

**Content.**
- Six races — human, elf, dwarf, orc, halfling, lizardfolk (`RACE_META`) — with land niches
  (each wins 5–30 % of land by default; `raceMix` weights the draw), lifespans, birth rates,
  temperaments, tongues (`createLanguage(rng, style)`), titles and styled realm names,
  architecture, racial buildings and wonders.
- Temperament drift (`docs/design/temperament-and-names.md`, `src/sim/civ/temper.js`): every people's
  eight traits drift with its history in both kinds of world; `RACES[r].adapt` scales the drift
  (human 2, orc 1, halfling 0.8, lizardfolk 0.7, dwarf 0.6, elf 0.5) and `RACES[r].jitter` the
  seeded spread at birth (human ×1.4). The race providers are registered by `myth/index.js`
  (`registerRaceProviders`), not at import, so civ code may read the race table safely.
- Humans are the adaptable, ingenious, restless people: innovation +0.12, expansion +0.08,
  commerce +0.05; research +6 %; learning from peoples they trade with or have met (up to
  +30 % on historical techs); cosmopolitan research and trade from the share of other peoples in
  their towns (up to +10 %), through the `mods` provider (`humanEdge`); crossroads towns (other
  peoples ×1.15 as welcome, migration ×1.2); the Hall of Tongues. `tools/myth-check.mjs` checks
  that humans hold at most 45 % of world population at the default `raceMix`.
- Mixed peoples (`docs/design/mixed-peoples.md`, `src/sim/myth/peoples.js`): every Mythic town holds
  `s.peoples` (`{ [race]: share }`, shares ≥ 0.005 summing to 1); `s.race` is its dominant
  people (hysteresis 0.05). Settlers carry their origin's mix, conquerors add 4–12 %, and once a
  year each town drifts toward its neighbours and trade partners (weighted by kinship and
  tolerance) and by its races' birth rates; rare expulsions and every change of dominant
  people ("turning") are chronicled. Demography and loyalty read the mix; `raceCensus`
  counts heads by share. Published: `townPeoples`, `civPeoples`, `landPeoples`,
  `worldPeoples`, `peoplesHistory` (`sys.myth.mix`), `townPeoplesPast` (`s.peoplesPast`, a town's
  decade samples), `PEOPLES_MIN`; `versions.peoples` bumps
  when a town's dominant people or a second people at ≥ 25 % changes. Absent in Historical
  and Legendary worlds.
- Ley lines and mana: 18–24 nodes (pinned `node` sites) joined into a network; `f.ley`,
  `f.manaBase`, `f.mana` (§4); `magicStrength`.
- Seven arcane schools as a registered tech branch (`branch: 'arcane'`): the six race schools
  — Wizardry, Sylvan Arts, Runecraft, Shamanism, Hearth-craft, Serpent Rites — plus
  Necromancy; registered mod keys arcana, wards, taming, luck, scrying, gates, necromancy,
  forestFarm, deepHalls, mortality.
- A bestiary on the bands engine (`BAND_KINDS` with `flags.mythic`; `monsterAbundance`):
  wyverns, trolls, giants, treants, krakens, behemoths and, as the headline, dragons — lairs,
  long sleeps, raids, hoards, clutches, pacts and slayers (dragonbone on the lair tile, the
  slayer a hero). Responses to monsters: hunt, hero, tame, pact.
- Map modes `arcane`, `peoples`, `monsters`; tools (group `myth`, "Stir the Uncanny"):
  Ley Line, Wellspring, Awaken Magic, Summon, Slay, Tame.
- Should: the gods answer (`divineIntervention`), the Fading (`fading`: the weave thins with
  industry), race relations, the Legends tab, the undead.
- Wave 2 (reserved): workings, phenomena (rifts, enchanted woods, blight, the Conjunction,
  starfall — `wildMagic`, starmetal), dark lords, sea courts.

**Presets** (`mode: 'mythic'`): High Fantasy (mythLevel 2), Age of Dragons (+ monsters 2.5),
Twilight of Magic (Classical start, magic 0.7), Elder Races (`raceMix: elderRaces`), Legends
(mythLevel 1).

**Balance at level 2:** each race alive at Y1000 in at least 60 % of seeds; expansion and era
pacing within ±25 % of Historical; 3–15 major (imp ≥ 3) Myth & Magic entries per century; 0–6 dragons alive
at any time; myth ≤ 8 ms per sim-year.
