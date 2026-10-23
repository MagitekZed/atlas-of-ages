# How it works

Atlas of Ages is vanilla JavaScript ES modules with Canvas 2D rendering. It has no runtime dependencies. The simulation (`src/core`, `src/gen`, `src/sim`) never touches the DOM, so the same code runs in the browser and in Node. This page is an overview. [SPEC.md](../SPEC.md) is the full specification, and [design/](design/) holds the design notes behind it.

## Where things live

| Path | Contents |
|------|----------|
| `src/core/` | The kernel: world state, seeded RNG and noise, entities, chronicle, hooks, extension points, registries for events, tools, bands and sites, keyframes, replay, the simulation driver, save and load |
| `src/gen/` | World generation: plates, elevation, erosion, rivers, climate baseline, biomes, resources, volcanoes, named features; the land-shaping tools |
| `src/sim/` | The systems that run each day (below) |
| `src/render/` | The canvas renderer: terrain, level-of-detail chunks, town plans, borders, labels, units, effects, map modes, minimap |
| `src/ui/` | Genesis, the HUD, panels and dossiers, Director, run-until, command palette, Chronoscope, saves |
| `src/main.js`, `index.html`, `styles.css` | Boot, the frame loop, the page and its styles |
| `tools/` | Headless runner, reports, fallback generator, single-file build |

## The daily loop

One simulation step is one day. A month is 30 days and a year is 360, and history starts in Year 0. A tile is about 20 km; a medium world is 256×160 tiles.

`Simulation.step()` (`src/core/sim.js`) calls each system's `update(world)` in order, then advances the day. Each system decides its own cadence: daily, at month or year starts, or on a stripe of rows each day so that a full pass is spread out. If a system throws, the error is recorded and the other systems keep running.

| Order | System | Module | What it runs |
|------:|--------|--------|--------------|
| 5 | terraform | `src/gen/terraform.js` | Land-shaping tools; keeps water in step with terrain edits |
| 10 | climate | `src/sim/climate.js` | Temperature and seasons, snow and ice, sea level, greenhouse and aerosols |
| 15 | weather | `src/sim/weather.js` | Moisture, cloud, rain, soil water, named storms |
| 20 | ecology | `src/sim/ecology.js` | Vegetation, herds, predators, fish, fire |
| 25 | disasters | `src/sim/disasters.js` | Earthquakes, tsunamis, eruptions, falling stars, floods, locusts |
| 40 | civ | `src/sim/civ/` | Settlements, farming, buildings, technology, territory, government, rulers and dynasties, stability, new peoples |
| 50 | religion | `src/sim/geo/religion.js` | Prophets, faiths, spread, state religions, schisms |
| 55 | disease | `src/sim/geo/disease.js` | Named plagues, spread town by town |
| 60 | trade | `src/sim/geo/trade.js` | Routes, roads, caravans and ships |
| 70 | diplomacy | `src/sim/geo/diplomacy.js` | Contact, opinion, treaties, alliances, vassals |
| 80 | war | `src/sim/geo/war.js` | Declarations, armies, battles, sieges, peace |
| 82 | bands | `src/sim/bands/` | Outlaws, pirates, free companies, hordes; in Mythic worlds beasts, dragons and the undead |
| 84 | events | `src/sim/events/` | Event decks at every scale, the ages of the world, town character, annals |
| 86 | myth | `src/sim/myth/` | Races and mixed peoples, ley lines and mana, arcane schools, the gods, the Fading |
| 100 | stats | `src/sim/stats.js` | Yearly records, border snapshots every ten years, entity ledgers, the Hall of Records, the catastrophe catalogue |

In the browser, each animation frame calls `sim.advance(dt, budget)`, which runs as many days as the speed asks for within a time budget, and then `renderer.render(t)`. At Max speed a still map is drawn every other frame (about 15 times a second) and the frames in between go to the simulation; while the view moves or the viewer works on the map, every frame is drawn. Panels refresh at most four times a second. Leaps and run-until call `sim.step()` in slices of about 50 ms and draw a frame between slices.

## World state

`createWorld(params)` (`src/core/world.js`) builds one plain object:

- **Tile fields** in `world.f`. These are typed arrays with one value per tile: elevation, plate, water, rivers, temperature, rain, snow, biome, soil, vegetation, herds, fire, owner, farmland, roads, population density, devastation and more. Mythic worlds add `ley`, `manaBase` and `mana`. SPEC §4 lists every field with its single owner.
- **Entities** in lists: `civs`, `settlements`, `wars`, `armies`, `religions`, `plagues`, `tradeRoutes`, `caravans`, `storms`, `volcanoes`, `fires`, `figures`, `wonders`, `features`, `bands` and `sites`. Civs and settlements are never removed; they are marked `alive: false`, so an id stays valid forever. Entities refer to each other by id.
- **Per-system state** in `world.sys[systemId]`, and climate scalars in `world.climate`.
- **The record**: `world.chronicle` (prose entries with importance 1–5) and `world.history` (yearly records, border snapshots, per-entity series, the catastrophe catalogue).
- **The intervention log** in `world.interventions`: every act of the player, in order.
- **Viewer state** in `world.ui`: the watchlist, pins and patron people. It is saved, but the simulation never reads it.

Outside the typed fields, all state is plain JSON: no Maps, Sets, classes or cycles. Derived data lives in `world.cache` and visual effects in `world.fx`. Neither is saved.

## Determinism, saves and replay

- **One source of chance.** All randomness in generation and simulation goes through `world.rng`, which is seeded from the world's seed. Simulation code never calls `Math.random()` or `Date`. Providers, event weights and tool previews are pure. So a seed, a parameter set and the log of acts always produce the same history. Results are exact within one JavaScript engine. Across engines (Node and a browser, or two browsers), transcendental `Math` functions can differ in the last digit, so a long history from the same seed can drift apart. The correctness gates therefore compare runs within one engine.
- **Saves.** `serializeWorld` (`src/core/serialize.js`) writes everything except `cache` and `fx`. Typed arrays are stored as base64. Loading runs `normalizeWorld`, so older saves gain any newer defaults. Then each system's `init(world)` runs again; `init` must be idempotent.
- **Logged acts.** Every change from outside the daily loop goes through a logged kernel call: `applyTool`, `applyPairTool`, `applyEntityTool`, `finishTool`, or `setParam(..., { log: true })`. Each call adds an entry with its day to `world.interventions`.
- **Keyframes** (`src/core/keyframe.js`) are snapshots of the whole world. Closed records, such as ended wars and fallen realms, are shared between keyframes rather than copied. The Chronoscope (`src/ui/chrono.js`) keeps a ring of keyframes in memory, within a 64 MB budget on desktop and 24 MB on a phone. It takes one when a world opens, one every ten years for the last century, one every fifty years before that, and one just before every act.
- **Replay** (`src/core/replay.js`). To undo an act, the Chronoscope restores the nearest keyframe before it, then replays the log to the present without that act. Rewind restores an earlier day, and the future it leaves can be kept as a branch save.

## Extension points

Systems don't import each other's internals. They connect through these channels, in order of preference:

1. **Hooks** (`src/core/hooks.js`). Synchronous lifecycle events such as `settlementTransferred`, `warStarted`, `battle`, `plagueStarted`, `succession`, `eruption`, `toolApplied` and `paramChanged`. The catalogue with payloads is the header of `hooks.js`. UI listeners are read-only and ignore calls made during a replay.
2. **Providers** (`src/core/ext.js`). An owner asks a question at a fixed call site, for example "how habitable is this tile for this race?", and every registered provider answers. Answers are combined (product, sum, first, any, concatenation or merge) and clamped. Providers are pure and return neutral values when their feature is off.
3. **Registries.** Events (`core/events.js`), god tools (`core/tools.js`), and tech, building, wonder and modifier tables (`core/ext.js`). Bands and sites have their own kernel APIs.
4. **Published exports.** A small set of functions that modules may import from each other, listed in SPEC §3.2.

The UI and renderer have registries of their own:

- **UI** (`src/ui/registry.js`): views, dossier sections, title actions, tabs, keys, commands, search sources, context-menu providers, toast filters, run-until conditions, Director sources, overlays and icons. Feature modules listed in `src/ui/mounts.js` register into them.
- **Renderer** (`src/render/layers.js`): draw layers in named slots, effect types and map modes. `src/render/plugins.js` loads the modules that use them.

## Renderer and UI

The renderer (`src/render/renderer.js`) draws a hand-tinted atlas on one canvas. The terrain is a raster with hillshade, biome colour, vegetation, farmland that follows the seasons, snow and water. On top come rivers, roads, borders, settlements, units, storms, clouds, effects and labels placed to avoid collisions. As you zoom in, a level-of-detail pyramid of 256 px chunks (`lod.js`) takes over through six named levels from World to Street. Towns are drawn by `cityplan.js`, and the Mythic peoples' towns by `raceplan.js`, from each settlement's population, walls and buildings.

`src/main.js` boots the page. It loads the kernel directly and imports the renderer, generator, systems and UI feature modules behind guards. If the renderer or generator fails to load, a simpler stand-in takes over (`src/ui/fallback-renderer.js`, `tools/fallback-gen.mjs`) and a notice says so. The app object (`src/ui/app.js`) holds the current world, simulation, selection and speed, and passes events between parts of the UI. `window.atlas` exposes the live objects for debugging.

## The Mythic layer

A single parameter, `mythLevel`, controls the myth: 0 is Historical, 1 Legendary, 2 Mythic. It is set at genesis. During play only the Awaken Magic act can raise it to 2, through a logged `setParam`.

- **Level 0.** Myth code draws no random numbers, allocates no fields, returns only neutral provider answers and adds no event weight. `node tools/headless.mjs --determinism` checks this: a Historical world must come out identical with and without the myth module loaded.
- **Level 1.** A folklore deck of omens, saints, relics and haunted ruins, which exist only in belief.
- **Level 2.** Six races, each with land niches, lifespans, temperaments, languages, architecture and buildings. Towns hold a mix of peoples that shifts with settlement, conquest and trade. Ley lines and mana, seven arcane schools as a technology branch, the gods' answers, and the Fading. The bestiary runs on the bands engine, and the Arcane, Peoples and Monsters map modes are added.

Almost all mythic behaviour lives in `src/sim/myth/` and `src/sim/bands/kinds/`. It reaches the rest of the simulation only through providers, registries and published exports. SPEC §11 is the design bible. [design/mixed-peoples.md](design/mixed-peoples.md) and [design/temperament-and-names.md](design/temperament-and-names.md) cover two parts in depth.

## Going deeper

- [SPEC.md](../SPEC.md): ground rules (§1), scale and performance budgets (§2), ownership and published exports (§3), fields (§4), entities (§5), every system (§6), renderer (§7), UI, tools and keyframes (§8), balance targets (§9), testing (§10), the Mythic design (§11).
- [design/expansion-contracts.md](design/expansion-contracts.md): the contracts the expansion was built on.
- [design/expansion-packages.md](design/expansion-packages.md): what each work package built and owns.
