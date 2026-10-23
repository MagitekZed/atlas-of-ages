# Audit proposals (reference)

## Lens: ux

I looked at this through a UX lens: controls and flow. I drove the single-file build with headless Chrome on port 9701 through the full journey: Genesis, the first minutes of a world, autostarted worlds at Y250 and Y400 on the Earthlike and Age of Strife presets, following an army, the war view, a deep city zoom (40 and 80 px per tile), meteor and raise tools, the menu, help, Leap, Save/Load, the Atlas past view and a 390×844 phone. I also read every src/ui module, main.js, the camera, the parts of the renderer the UI calls, and the kernel tools, chronicle and serialize code, and wrote Node probes for event cadence and snapshot cost. Screenshots are in <scratch>

**What works well.** The base is polished, so new features can build on it:
- The Genesis plate redraws live (147 ms preview) and offers presets plus "start after N years".
- The year dial and speed notches give a clear sense of time.
- Camera flights use van Wijk–Nuij paths.
- Inspector records are humanised and cross-linked, with a Back history.
- The Chronicle is a virtualised list that never jumps while you read, with category and importance filters.
- Toasts are metered (token bucket plus a digest slip).
- The Atlas timelapse, the cursor readout, and Esc backing out step by step all work well.
- Leap ahead keeps the map drawing and can be stopped.
- Space-to-pause is handled in the capture phase.
- The phone bottom sheet frames selections above the sheet.

**The main weakness: the player has to go looking for the story, and is given few tools for it.**
- **Long quiet stretches.** On Earthlike, 300 headless years produced 53 major (imp≥3) events in only 41 distinct years. The gap between major events was 16.8 sim-years at p90 and 35 at most. At the default Normal speed (8 days/s, 45 s per year) that is 12 to 26 minutes of real time with nothing major happening. The seed audit-ux had one war in 400 years.
- **No ways to find or wait for things.** There is no search, no "run until something happens", no camera that finds the action, no event markers on the map and no history timeline to jump around in. Follow exists only for armies and storms, and any new selection cancels it.
- **No safety net when intervening.** A size-2 falling star cast from the default toolbelt drowned four towns and killed about 1,400. The tool gave no preview of who would be hit, and there is no undo.
- **No timeline or context-menu access to the past.** The Atlas view of the past (borders only, while the simulation keeps running) is the only way back, and right-clicking or long-pressing the map does nothing.

**Rewind and undo are cheap.** The kernel is fully deterministic: no Math.random or wall clock in the simulation. On a medium map I measured a raw in-memory snapshot at 2.0 ms to capture and 2.0 ms plus 9.2 ms of system init to restore. Re-simulating from it was bit-identical: population 12963.435 both times and chronicle seq 202 both times after 5 years. Compressed, such a snapshot is about 3.1 MB. Combined with a log of the player's interventions, this makes rewind, undo and what-if branches cheap.

**Proposals.** The 18 proposals are ranked by impact. Each one builds on systems that already exist: chronicle entries, which already carry a place in 100% of major cases; history.years per-nation series; hooks; the fx queue; camera.focusOn; and the saves module.
- **Highest leverage:**
  - A Director (story camera with narrated captions and pacing that slows for action and skips quiet years).
  - Run-until with alert rules.
  - A command palette with universal search.
  - A rewind/branch system, with undo for god tools.
- **Next tier:**
  - A global history timeline.
  - A watchlist with pins and follow-anything.
  - Event pins on the map.
  - A map context menu.
  - Tool consequence previews and two-target "fate" tools.
  - Onboarding.
  - Century digests.
  - Resume and share links.

All of these sit in UI files. The few kernel touches are an intervention log, a world.ui record for pins, optional preview and pair-target fields on tool definitions, and a renderer pickAll and recentFx. They leave the simulation's performance and determinism unchanged.

### Gaps
- Long quiet stretches at the default speed. Headless Earthlike seed c1, 300 years: 53 major (imp≥3) events in only 41 distinct years. Gaps between them were 3.2 years at the median, 16.8 at p90 and 35.2 at most. At Normal (8 days/s, 45 s per sim-year) the p90 gap is about 12.6 minutes of real time with no major event. The seed audit-ux had 1 war in 400 years (s3.mjs). Headless strife-a balance report: imp≥2 events at 0.8 per year (target 2–40), population 81.6k (target 1M–60M), every nation still in the Stone Age at Y300. Balance belongs to other lenses, but it is what makes the first minutes slow.
- No search anywhere. A settlement, figure, wonder, sea or old war can only be reached by panning or by following links from another record. No keyboard command palette.
- Leap ahead only offers fixed spans of 10, 50, 100, 250, 500 or 1000 years (hud.js LEAPS). There is no 'until the next war', 'until this nation falls' or similar.
- Right-click on the map does nothing unless you drag (input.js:138 suppresses contextmenu and right-button always pans), and long-press on touch does nothing. There are no context actions.
- Double-click never zooms. It selects the owning nation, or the bare tile on unclaimed ground (s8.mjs: zoom 3.74 → 3.74, selection = tile).
- No undo or preview for god tools. A size-2 meteor near Oshanun drowned Oshanun, Keuq, Keba and Neja and killed about 1,400 (shot 42-meteor-after.png). The tool card says nothing about who will be hit.
- Follow is offered only for armies and storms (inspector.js standardActions follow flag). app.select() resets follow to false on any new selection (app.js:114). Nations, wars, plagues and caravans cannot be followed.
- The Atlas past view keeps time running. Viewing Year 80 at Fast advanced 91 days in 3 s. Present-day toasts and terrain (snow) are drawn over the historical borders, and no armies or events of that decade are shown (shot 70-atlas-past.png).
- Notification controls are a single 'Pause on epochal events' switch; there is no per-category mute or alert rule. After any autostart or leap the Chronicle badge shows '99+' (shots 20–22), and the leap summary is a status toast that disappears after 7 s.
- Army flags on the map print strength with a decimal ('36.4', '14.9'; render/entities.js formatNumber(str, 1)) while the Inspector says '15 strong'. Strength is a count of soldiers, so the labels should be integers.
- The war view's war-score caption always reads 'Attackers ahead · −1', even when the score is negative, meaning the defenders lead (inspector.js warView right-hand label; shot 22-war.png).
- The 'Menu' tooltip stays on screen after the menu is closed with Escape (shot 34-city-zoom80.png).
- On a 390×844 phone the toolbelt permanently takes about 25% of the screen height (shot 50-phone-overview.png). The cartouche drops the headline stats (population, nations, wars), so phone users cannot see the vitals without opening a tab.
- Reloading the page loses the world unless it was saved by hand. Autosave is off by default, and Genesis has 'Load a saved world' but no 'Continue'. Save slots have no thumbnails.
- Genesis: the preview does not show where the peoples will start; the world cannot be renamed; there is no recent or favourite seed list; and there is no share-link button, although the URL already supports seed, preset, set and years.
- Weak empty state at Year 0. Seven tribes of about 150 people each sit on a fitted map at Normal speed; nothing nudges the player to speed up, leap ahead or try a tool.
- At maximum zoom (80 px per tile) a town of 2,820 is the same roughly 20 px glyph as at zoom 12 (shot 34). Mostly a visual-depth issue, but it makes deep zoom feel unrewarding to interact with.
- The help sheet omits the '0' pause key. The War record has no map framing of the two sides and no score-over-time; settlements have no population history (the latter belongs to the stats lens).

### ux:director-story-mode — Director: an auto-cinematographer and narrator with story pacing (P1, L)

**Value:** Turn it on and the atlas shows you the story: it flies to the battle as it begins, holds on the burning city, follows the cyclone to landfall and captions each moment with the Chronicle's sentence. It slows for action and skips quiet decades, so a new player is never left watching an empty map.

A toggle (key G, a 'Story' button on the drive, and the default suggestion on a first world and on phones). Every UI tick (4 Hz) the Director scores the open 'situations' and moves the camera to the best one with a smooth flight. It then shows a lower-third caption: category icon, place, date, and the chronicle text revealed like a typewriter.

Shot types and framing:
- Battle: the battle fx or armies in contact, at about 14 px per tile.
- Siege: the city and its besiegers, with a siege-progress ring.
- War theatre: the bounding box of the war's armies and besieged towns.
- Founding, fall or split of a nation: its territory bounding box, briefly in political mode.
- Eruption, meteor, quake or tsunami: zoom set by the fx radius.
- Storm landfall: follows the storm.
- Plague front: bounding box of the sick towns; disease mode is optional.
- New faith: the holy city. Wonder, or golden age: the capital.

Pacing (optional): on an action shot the speed drops to Fast (30 days/s). An epochal moment holds for the caption, then resumes. With nothing above the threshold, the Director skips quiet years at Rapid or Max and shows a 'Quiet years · Y312→' chip.

Any manual pan, zoom or click suspends it for 20 s ('Director resumes in 20 s'); G stops it. A settings popover sets categories, shot length (5–15 s), pacing on/off, captions on/off and whether the map mode may change. A 'Cinema' variant hides the panel and toolbelt, as H already does, but keeps the captions.

**Implementation:** New src/ui/director.js (mountDirector(app)), UI-only state in prefs 'director'.

Candidate sources:
- (a) chronicleSince(world, lastSeq) for imp≥3 entries. All measured major entries carry x,y or sid; take the settlement position when only sid is set.
- (b) A live scan each tick: armies with state 'sieging' (progress from settlement.siege), volcanoes with erupting>0, storms with intensity>0.6 whose centre is within 3 tiles of land (f.water, distCoast), world.fires that are active with tiles>40, and the bounding box of settlements with disease.pid for active plagues.
- (c) A new renderer method recentFx(sinceMs) returning shallow copies of active fx {type,x,y,r,t,civId} from fx.js. Battle, eruption, meteor, quake and tsunami are the high-value types.

Scoring: score = base[type] × (1 + imp²/5) × novelty × freshness. Novelty is ×0.3 if within 20 tiles of one of the last 3 shots or about the same nation as the last 2. Freshness is e^(−age/8 s). Hysteresis: switch only when best > current × 1.5 or the dwell time is used up.

Camera: app.focus(x, y, zoom) via camera.focusOn. Bounding-box framing works out zoom = min(viewW/bw, viewH/bh) × 0.8 from settlement positions, O(towns). Under prefers-reduced-motion, cut instead of flying.

Caption: a new #caption element in #stage that reuses entryIcon and CATEGORIES from toasts.js. While directing, toasts.js suppresses imp-3 slips (the caption replaces them).

Pacing: app.setSpeed. Remember the user's speed and restore it when the Director turns off.

Input: input.js and mapdock.js emit app.emit('userCamera') on pan, zoom, wheel, minimap travel and click.

Performance: O(new entries + armies + storms + volcanoes) every 250 ms, well under 0.3 ms; no sim cost.

Determinism: speed only changes how many days run per real second, never which days are simulated.

Files: src/ui/director.js (new), src/render/renderer.js and src/render/fx.js (recentFx), src/ui/hud.js (button, menu toggle), src/ui/input.js (G key, userCamera), src/ui/mapdock.js (userCamera), src/ui/toasts.js (suppression), src/main.js (mount), styles.css (caption).

**Risk:** Bad shot choice on sparse worlds, so pair it with quiet-years skipping. Motion discomfort, handled by minimum dwell and cuts under reduced motion. Fighting with a user who is browsing, handled by suspending on any input.

### ux:run-until-and-alert-rules — Run until… plus alert rules (notification preferences) (P1, M)

**Value:** 'Skip to the next war', 'run until this empire falls', 'stop when my city is besieged'. You spend real time on moments rather than on waiting, and you choose what interrupts you.

The Leap modal (J) gains an 'Until…' section, also reachable with key U and from the palette and context menu:
- the next war (any, or involving the selected or watched nation)
- the next historic (imp 4) or epochal (imp 5) event
- a nation falls, or a new nation rises
- the next plague outbreak
- the next eruption, meteor or great disaster
- someone reaches a new era
- the selected settlement changes hands, is besieged or reaches its next tier
- the selected ruler dies
- Year N

A cap (default 1,000 years) keeps a search from running forever. The progress card reads 'Searching… Year 312'. On a hit, time stops on that exact day, the camera flies to the place, the record opens, and an 'Arrived' card offers 'Keep going until the next one' (Shift+U repeats the last condition).

A 'Notices' popover replaces the single auto-pause switch:
- per-category toast threshold (Off / Epochal / Historic / Major / All)
- 'Pause when…' rules drawn from the same condition catalogue, armed during live play
- 'quiet at Rapid/Max' (only epochal toasts)
- 'clear the Chronicle badge after leaps'

**Implementation:** New src/ui/until.js: a condition catalogue of objects {id, label, params, arm(app), test(world) → {text, x, y, sid?, civId?} | null, disarm()}. Conditions use kernel hooks, which are synchronous during sim.step, through UI-side listeners that only set flags and never mutate the world:
- warStarted
- civDestroyed / civCreated
- settlementTransferred (selected sid)
- settlementDestroyed

Other conditions use chronicleSince(world, seq), checked only when world.chronicle.seq changed: imp thresholds and categories (disaster, climate, disease), filtered by civId or sid. Era checks are a monthly O(civs) scan of civ.tech.era.

src/main.js: fastForward(years, prog, {until}) calls until.test(world) after each sim.step() inside the inner loop, breaks on a hit, then calls app.focusEntryLike(hit). Live play uses the same test on 'tick' (rules for app.pause() plus a toast).

Prefs: 'notices' = {cat: {minImp}, pauseRules: [...], quietFast, badgeAfterLeap}. Migrate 'autoPause' into pauseRules ['epochal']. toasts.js reads notices instead of the constants FAST_SPEED and BUCKET.

Performance: O(1) per simulated day (flag checks), plus O(new entries).

Determinism: listeners are read-only. The hooks module's per-handler try/catch keeps UI errors out of the sim.

Files: src/ui/until.js (new), src/main.js, src/ui/hud.js (Leap modal, menu Notices), src/ui/toasts.js, src/ui/panel.js (badge reset), src/ui/prefs.js, src/ui/input.js (U, Shift+U), styles.css.

**Risk:** A hook subscriber that throws is caught by hooks.js. The risk is low if listeners stay read-only; document that rule next to the SPEC section on hooks.

### ux:command-palette-search — Command palette and universal search (/ or Ctrl+K) (P1, M)

**Value:** Type 'oshan' and fly to Oshanun; type 'feud' to list every war; type '>leap 500' or '>political'. Every entity, place, record, map mode, tool and action is a few keystrokes away, including ruins and fallen empires.

A centred overlay with one field and grouped results:
- Nations (live and fallen), settlements (live and ruins), wars, faiths, plagues
- Great people and wonders, which resolve to their settlement
- Geography: continents, seas, ranges, rivers, lakes, deserts and forests from world.features
- Volcanoes and storms
- Map modes and god tools
- Actions: speeds, leap, run-until, save, quick save, new world, theme, overlay toggles, Director, Atlas, fit world
- Chronicle full-text matches, for queries of 3+ characters, newest first, capped at 8

Filtering: fuzzy, diacritic- and apostrophe-insensitive, so Yi'thathun and Hu'kae match. Prefixes narrow the scope: '>' commands, '@' places, '#' chronicle.

Keys: arrow keys move; Enter selects and flies; Alt+Enter opens the record without moving the camera; Shift+Enter adds to the watchlist. Each row shows a type icon, a nation swatch and a subtitle (e.g. 'Town · 2,821 · High Seat of Bar', 'War · Y248–Y250 · 77 dead'). An empty query shows recent selections and suggestions such as 'Largest city' and 'Ongoing wars'. On phones it opens from a magnifier in the drive as a full-height sheet.

**Implementation:** New src/ui/command.js (openCommand(app)). The index is built lazily on open, O(entities), under 5 ms for a few thousand records: w.civs, w.settlements, w.wars, w.religions, w.plagues, w.figures, w.wonders, w.features, w.volcanoes, w.storms, MAP_MODES (app.mapModes()), getTools(), plus a static action table.

Normalisation: NFD, strip diacritics, drop apostrophes and hyphens, lowercase. Scoring: subsequence match with bonuses for word starts and prefixes, then liveness, then log10(population) or size as a tie-break; render the top 40. The Chronicle scan is substring over entry text (6,000 entries, about 1 ms).

Result actions:
- app.select({kind, id}, {focus: true})
- a new app.focusFeature(ft), zoom from ft.size
- app.setTool, app.r('setMapMode')
- the leap and run-until functions
- focusEntry

Uses openModal from widgets.js with a custom listbox (aria-activedescendant). Recents go in prefs 'cmdRecent' (ids are world-scoped, so key them by seed).

Files: src/ui/command.js (new), src/ui/input.js ('/' and Ctrl/Cmd+K; isTyping guard), src/ui/hud.js (phone search button, help rows), src/ui/app.js (focusFeature), styles.css. No sim or render cost.

**Risk:** Low. Watch for key conflicts: '/' is free, and Ctrl+K needs preventDefault while the page has focus.

### ux:chronoscope-rewind-undo-branch — Chronoscope: rewind history, undo god tools, and keep what-if branches (P1, L)

**Value:** 'What if that meteor had missed?' Undo a tool with Ctrl+Z even after time has moved on, rewind to the eve of a war and change something, or keep both futures as branches. Intervening becomes playful instead of destructive.

Snapshots ('keyframes') are taken automatically: every 10 sim-years for the last century, every 50 before that within a memory budget, and before every god-tool stroke.

Rewind: from the timeline (proposal history-timeline-bar), the Atlas ('Return to this moment') or the palette. The atlas restores the nearest keyframe at or before the target and re-simulates to the exact day with a progress card. It asks first: 'History after Year 312 will be unwritten', offering [Keep it as a branch] [Discard] [Cancel].

Undo / redo (Ctrl+Z / Ctrl+Shift+Z): the last 10 interventions (tool strokes and live-param changes) can be undone. If days have passed since, they are re-simulated without that intervention, with a short progress card when over a year.

Branches: saved as slots with branchOf and branchDay, grouped under their world in Save and Load, with each branch's year and headline numbers side by side.

**Implementation:** Kernel:
- New src/core/keyframe.js: captureKeyframe(world) → {day, json: JSON.stringify(world minus cache/fx/f/rng), rng: state.slice(), fields: {name: typed.slice()}}; restoreKeyframe(kf) → world (bump versions, cache {}, fx []). Share the SKIP set with serialize.js.
- New src/core/replay.js: replayTo(world, sim, targetDay, {skip: Set(seq), onProgress}). Before each sim.step() it applies world.interventions whose day equals world.time.day, in seq order.
- world.interventions = [{seq, day, kind: 'tool' | 'finish' | 'param', id, x, y, radius, strength, key, value}], created in createWorld and defaulted in deserialize. core/tools.js applyTool and finishTool append to it; setParam appends when called with {log: true} from the UI. Logging is suppressed while world.cache.replaying is set.

UI:
- New src/ui/chrono.js: keyframe ring and policy, a memory budget pref (default 64 MB desktop / 24 MB phone, scaled by map size), and async compression of older frames with CompressionStream('deflate-raw') over the concatenated field buffers.
- Restore path: deserialize the keyframe, then new Simulation(world, systems).init(), then replayTo through the existing fastForward slice and progress machinery, then installWorld(world, sim, {keepPause: true}). Re-select the previous selection if the entity still exists.
- Pre-stroke keyframes are captured in input.js beginStroke and worldtab onChange.

Measured on a medium map (Node), a 150-year world: raw keyframe 8.5 MB of fields + 0.73 MB of entity JSON, captured in about 2 ms; deflate level 1 → 3.1 MB in about 65 ms (do it async). Restore 2 ms plus systems init 9 ms; replay from a keyframe is bit-identical (population 12963.435 both times, chronicle seq 202 both times after 5 years).

Performance: about 2 ms on the main thread every 10 sim-years (about once per second at Max); compression off the main thread.

Determinism: holds as long as every mutation outside sim.step is logged. Add a cheap checksum (e.g. a hash of owner, elevation and population) recorded with each keyframe and verified after replay. Add a headless test: node tools/headless.mjs --rewind-test.

Files: src/core/keyframe.js (new), src/core/replay.js (new), src/core/tools.js, src/core/world.js, src/core/serialize.js, src/ui/chrono.js (new), src/ui/input.js, src/ui/worldtab.js, src/ui/atlas.js, src/ui/saves.js (branch meta), src/main.js (restore/install), tools/headless.mjs (test).

**Risk:** An unlogged mutation, such as a future tool that bypasses applyTool, silently breaks replay. Guard with the checksum and the headless test. Memory on phones is handled by the smaller budget and compression. This is a kernel ownership change and needs SPEC §1 and §5 updates.

### ux:history-timeline-bar — A global history timeline to scrub, jump and rewind (P2, M)

**Value:** The whole history in one glance: eras as bands, wars as bars, plagues as spans and great events as ticks. Hover to read, click to jump there, drag to scrub the borders through time.

A collapsible strip (key Y; on desktop above the toolbelt, on phones in the sheet's Atlas tab) drawn on a canvas, with five lanes:
- (1) world population as a line, with era bands coloured by the most advanced age reached
- (2) wars as lane-packed bars from start to end, coloured by the strongest participant, thicker for deadlier wars
- (3) plague spans
- (4) chronicle ticks for imp≥4, coloured by category, with taller marks for imp 5
- (5) keyframe diamonds, when the Chronoscope is enabled

Interactions:
- Hover shows a tooltip with the year, the event text or the war name and toll.
- Clicking a tick or war bar selects it and moves the map to that decade's atlas plate.
- Dragging scrubs Atlas snapshots, reusing the existing atlasGoto.
- The wheel zooms the time range (a brush), and double-click resets it.

While you are in the past the banner reads 'Viewing Year 80 · time paused' with [Return to the present] and, with the Chronoscope, [Rewind to here]. Entering the past auto-pauses and leaving restores the speed, which fixes the time-keeps-running gap.

**Implementation:** New src/ui/timeline.js (mountTimeline(app)) using fitCanvas and chartTheme from charts.js.

Data:
- history.years: pop and era per year
- w.wars: startDay, endDay, casualties total, attackers[0] colour
- w.plagues: startDay, endDay, deaths
- chronicle entries with imp≥4
- chrono keyframe days

Lane packing for wars is a greedy interval schedule into 4 lanes. Hit-testing uses per-lane interval arrays and binary search.

Redraw only when history.years.length, wars.length or chronicle.seq (imp≥4) changes, or on hover, about 1–2 ms per draw. Snapshot selection reuses atlas.js goto via app.emit('atlasGoto', k). Factor out a nearestSnapshot(year) helper from atlas.js tlTravel.

Pause on entering the past: atlas.js goto() calls app.pause() once and records the resume speed; exit() restores it.

Files: src/ui/timeline.js (new), src/ui/atlas.js (helper export, pause and resume, rewind button), src/ui/input.js (Y key), src/main.js (mount), index.html (container in .hud-bottom), styles.css.

**Risk:** Vertical space on small laptops, so the strip collapses to 18 px. Very long histories are handled by the existing thinning of history.years.

### ux:watchlist-pins-follow — Watchlist, map pins and follow-anything (P2, M)

**Value:** Star the nations and cities you care about. They sit in a small strip with live numbers and light up when something happens to them, and you can follow an empire's frontier or a war theatre as easily as a single army.

Watch (key '.' or a star in every Inspector title):
- Up to 8 watched entities appear as chips under the cartouche: swatch, name, a live value (population, army strength or storm intensity) and a red dot when a new entry concerns them.
- Their chronicle entries become gilded 'watched' toasts that bypass the toast meter.
- Optional rule: pause when a watched entity is attacked, besieged or falls (uses the run-until-and-alert-rules catalogue).
- When off-screen, watched moving things (armies, storms, a followed caravan) get edge arrows at the canvas border showing direction and distance.

Pins (key B): name the current view (camera, zoom, map mode), e.g. 'The Gaak frontier'. Shift+1–9 jumps to a pin (e.code Digit1–9, since the number keys set speed).

Follow-anything:
- A nation is framed by its territory's bounding box, re-fitted smoothly every 2 s.
- A war, by its theatre (armies plus besieged towns).
- A plague, by its front (sick towns).
- A caravan or ship can be followed, with new pick hits.
- Follow is now its own state ({kind, id}). Selecting other records no longer cancels it; only a manual pan does.

**Implementation:** Data: world.ui = {watch: [{kind, id, since}], pins: [{n, name, x, y, zoom, mode}]}, added in createWorld and defaulted on load. It is saved with the world, so pins travel with saves, and the sim never reads it.

UI:
- New src/ui/watch.js: the strip, pins popover and edge indicators. Indicators are DOM arrows positioned from renderer.tileToScreen and clamped to the canvas rect minus HUD insets, updated in input.frame at most at 10 Hz.
- app.js: follow becomes {kind, id} | null. select() keeps it; app.on('userCamera') clears it. A frame-target helper builds the bounding box from civSettlements, war armies and besieged towns, or sick settlements.
- inspector.js: a star action on every view; follow offered for civ, war, plague, army, storm and caravan.
- toasts.js: entries whose civId, sid or army civ is watched get class is-watched and skip the bucket.
- render/entities.js: push hits for caravans and ships (kind 'caravan', pri 2) when the routes overlay is on.

Performance: the bounding-box refits are O(towns of one nation) every 2 s.

Files: src/core/world.js (ui field), src/ui/watch.js (new), src/ui/app.js, src/ui/inspector.js, src/ui/input.js ('.', B, Shift+digits, userCamera), src/ui/toasts.js, src/render/entities.js, styles.css.

**Risk:** Ids of dead entities stay valid (index-as-id lists), so watched fallen nations show a 'fallen' state instead of disappearing. world.ui is a small kernel addition.

### ux:event-pins-overlay — Living Chronicle pins on the map (P2, M)

**Value:** Where did that happen? Recent great events leave markers on the map: crossed swords at the battlefield, a broken crown where a dynasty fell, a flame where a city burned. Glance at a region and read its recent history; click a marker to read the entry.

A new 'Events' overlay, on by default at low zoom. It shows imp≥3 entries from the last 25 sim-years as small category glyph pins (war, diplomacy, faith, plague, disaster, climate, culture, discovery, divine). Pins fade with age and get a gilded ring when epochal.

Overlapping pins cluster at the current zoom into a numbered medallion that expands on hover. Hovering a pin shows the sentence; clicking opens the Chronicle scrolled to that entry and focuses it. Pins inherit the Chronicle's active category filters, so the map and the list agree.

In Atlas past view, the pins show that decade's events instead, which gives historical plates their story. Filters and the age window sit in the overlay popover.

**Implementation:** New src/render/events.js (drawEventPins(r, ctx, labels)), called from renderer.js after units when overlays.events is on.

The pin list is cached by chronicle.seq and atlas year: walk entries backwards until day < now − 25 y (or use the snapshot decade), keep imp≥3 entries, and resolve position from e.x,e.y or the settlement's x,y.

Clustering: greedy grid binning at about 28 px cells in screen space, O(pins). Glyphs come from a glyph sprite cache (render/glyphs.js) keyed by category and dpr. Hit entries are {kind: 'entry', id: seq, pri: 3}.

UI:
- mapdock.js: add ['events', 'Events', ...] to OVERLAYS.
- input.js: selectAt handles pick.kind 'entry' with focusEntry plus app.emit('chronicleScrollTo', seq).
- chronicle.js: scrollToSeq(seq), using the offsets array and briefly flashing the row.
- Category filters are shared through prefs 'chronCats', read by the renderer through an app.r('setEventFilter', cats) call.

Performance: at most about 80 pins drawn, under 0.5 ms per frame; list rebuild O(entries in window) only when seq changes.

Files: src/render/events.js (new), src/render/renderer.js, src/render/glyphs.js, src/ui/mapdock.js, src/ui/input.js, src/ui/chronicle.js.

**Risk:** Clutter in war-heavy worlds, where strife had 108 war entries among 164 major ones in 300 years. Clustering, the age window and a per-category cap handle it.

### ux:map-context-menu — Context menu on the map (right-click / long-press) (P2, S)

**Value:** Right-click any spot for everything you can do there: inspect the town, the nation or the army underneath, follow, watch, pin, 'run until this city is besieged', or use your last god tool. On phones a long-press does the same.

A right-click without a drag opens a menu at the cursor; on touch, a long-press of 550 ms without moving more than 8 px does, with a short haptic tick where supported.

The header names what lies under the cursor: biome, height and owner, like the readout. It lists every entity there (overlapping town, army, storm, volcano, event pin) so stacked icons stay reachable.

Actions:
- Inspect [each]
- Inspect nation
- Follow
- Watch
- Pin this view
- Zoom here
- Run until… for this place or nation (from the run-until catalogue)
- Use [last tool] here
- Show this place in [Year X] (Atlas)
- Copy link to this view

Right-drag still pans, unchanged.

**Implementation:** input.js: in pointerdown for buttons 1 and 2, record startPos and set mode 'pan' with moved = false. In pointermove, set moved when the distance exceeds DRAG_PX. On pointerup with button 2 and !moved, call openContextMenu(p). Touch long-press: a timer started on pointerdown in inspect mode is cancelled by movement or a second pointer; on fire, it sets a flag so the release does not also select.

New src/ui/contextmenu.js. It builds items from a new renderer.pickAll(sx, sy), which returns every hit containing the point sorted by priority, plus screenToTile and the owner. It anchors a 1×1 fixed-position element at the pointer and uses widgets.openPopover (which needs an element anchor).

'Copy link' builds ?autostart=1&seed=…&set=…&years=<current>&select=tile:x,y&zoom=z (no interventions; see resume-and-share).

Files: src/ui/input.js, src/ui/contextmenu.js (new), src/render/renderer.js (pickAll), styles.css.

**Risk:** Long-press conflicts with the delay before a touch tool applies; long-press is active only in Inspect mode.

### ux:tool-preview-and-pair-tools — Consequence previews for god tools, and two-target 'fate' tools (P2, L)

**Value:** See who will be hit before the star falls. The towns in range glow red and the card reads 'Would strike Oshanun (2,821) and 3 more'. Reach into politics as well as terrain: incite a war between two rivals, broker peace, forge an alliance, open a trade road, send settlers across the sea.

Previews: while hovering with a tool, settlements inside its predicted effect are ringed (red for destructive tools, gold for blessings). The tool card shows a one-line forecast, e.g. 'Strikes the sea 3 tiles off Oshanun; a wave would reach 4 towns, about 9,000 people'. Big catastrophes (meteor size >6, quake magnitude >8.5, plague virulence >1.6) add an 'Are you sure?' second click, unless the Chronoscope's undo is available.

Pair tools use a new target type 'pair'. Click the source (nation or settlement); a rubber-band line follows the cursor; click the target. The first tools:
- Incite war
- Broker peace
- Forge alliance
- Open trade route
- Send settlers
- Topple ruler (single target)

Each writes a 'Divine Hand' chronicle entry with both names, so the Chronicle records what you did.

**Implementation:** Kernel (src/core/tools.js): tool defs gain optional preview(world, x, y, opts) → {text, sids: [...], ring?: {x, y, r}, severity} and target 'pair' with pick: ['civ' | 'settlement', 'civ' | 'settlement'] and applyPair(world, a, b, opts). Pair applications are logged as interventions if the Chronoscope lands.

UI:
- input.js processHover calls tool.preview at most every 120 ms (cheap: radius queries via settlementsNear).
- New renderer.setHighlights([{sid, color}]) draws pulsing rings in render/entities.js.
- palette.js shows preview.text in the card.
- input.js: pair flow with a pending-source state, and renderer.setBrush({line: [x0, y0, x1, y1]}) for the rubber band.

Sim-side exports, one per owner:
- war.js / diplomacy.js: inciteWar(world, aCiv, bCiv) using startWar(..., 'provocation') and an opinion hit; brokerPeace(world, warId) using endWar(..., 'white_peace'); forgeAlliance (treaty helper).
- trade.js: openRoute(world, aSid, bSid), using findPath for land or sea.
- settlement.js: colonize(world, fromSid, x, y).
- rulers.js: depose(world, civId).
Register each tool in its owner's module.

Determinism: tool code uses world.rng only.

Files: src/core/tools.js, src/ui/input.js, src/ui/palette.js, src/render/renderer.js, src/render/entities.js, and src/sim/geo/{war, diplomacy, trade}.js, src/sim/civ/{settlement, rulers}.js (exports and registrations), plus preview functions in src/sim/disasters.js and src/gen/terraform.js.

**Risk:** Several owners must expose functions. Previews have to stay approximate and cheap, so give no exact death tolls, only ranges.

### ux:first-run-onboarding — First-run tour, 'things to try', and a nudge in quiet years (P2, M)

**Value:** A newcomer learns the controls in 60 seconds by doing them, and the first world never sits silent: the game suggests speeding up, leaping, following or striking something.

On first launch (pref 'onboarded'), Genesis highlights Earthlike and Begin. The new world opens at Fast and offers the Director.

A six-step tour of anchored callouts with Next and Skip, replayable from Menu › Tour:
- (1) the time drive and Space
- (2) click your largest tribe's camp (waits for the click)
- (3) the Chronicle and how a row flies to its place
- (4) map modes (M)
- (5) the toolbelt: try Bloom or a Falling Star, undo with Ctrl+Z
- (6) search (/) and Run until (U)

The Inspector welcome view gains a 'Things to try' row of one-click actions: 'Follow the largest nation', 'Run until the first war', 'Leap 100 years', 'Switch to the political map', 'Drop a falling star near the biggest town'.

Quiet-years nudge: if 60 s of real time pass with no new imp≥3 entry at speed ≤ 3, a dismissible chip offers 'Quiet years. Skip to the next event (U) · Speed up (4) · Let the Director choose (G)'.

**Implementation:** New src/ui/tour.js: a step list of {anchorSelector, text, waitFor: 'select:settlement' | 'key:m' | null} drawn as a positioned callout with an arrow, using the anchor's getBoundingClientRect. It listens to app events ('select', 'mapmode', 'tool') to advance and stores progress in prefs.

inspector.js welcomeView gets an action-chip row that calls palette and command functions.

The nudge lives in toasts.js or a new nudge.js: track the real time of the last imp≥3 toast and show a statusToast with buttons (statusToast needs a multi-action variant).

First-run defaults: main.js beginWorld sets speed 3 when !getPref('onboarded').

Files: src/ui/tour.js (new), src/ui/inspector.js, src/ui/toasts.js, src/ui/hud.js (Menu › Tour), src/main.js, styles.css.

**Risk:** The tour goes stale as the UI changes, so anchor it with stable ids. It must never trap focus, and Esc ends it.

### ux:century-digest — Digest cards: 'The Century in Review' after leaps and on demand (P2, S)

**Value:** After a 500-year leap you get a readable summary of what changed: who rose and fell, the deadliest war, the plague that emptied the cities, the first iron. Every line is a link, so the leap becomes a story you want to explore.

A modal card shown after a leap, a run-until hit or a rewind. It can also appear automatically every 50 or 100 sim-years (pref: off by default; pauses), or on demand from the palette ('Digest since Year …').

Sections, each with up to 3 clickable lines:
- People: world population change, with the biggest riser and faller by population and by land
- Nations: those founded, split and fallen
- Wars: count, deadliest by casualties, biggest conquests by towns captured
- Faith: new religions and schisms
- Plague: deaths by plague
- Catastrophe: imp≥4 disaster and climate entries
- Discovery: era firsts
- Great people: born and died

The card ends with 'Read the full Chronicle for this span', which opens the Chronicle filtered to that year range.

**Implementation:** New src/ui/digest.js with pure digest(world, fromDay, toDay) → sections.
- Population and land deltas come from history.years records: each yearly record's civ field maps a nation id to [pop, territory, towns, era, power].
- Nations from w.civs foundedDay, fallenDay and parentId.
- Wars overlapping the span, casualties summed from war.casualties, captured.length.
- Religions by foundedDay; plagues by deaths.
- Chronicle imp≥4 entries in the span by category; figures by born/died.
Cost O(years × civs + wars + entries in span), under 5 ms.

The leap path (main.js leapAhead) replaces its status toast with openDigest(app, from, to). chronicle.js gains setYearRange(from, to) with a removable chip.

Files: src/ui/digest.js (new), src/main.js, src/ui/chronicle.js, src/ui/hud.js (pref), styles.css.

**Risk:** Low. history.years is thinned for very old spans, so use the nearest records and label approximate values.

### ux:resume-and-share — Pick up where you left off, slot thumbnails, and shareable world links (P2, M)

**Value:** Close the tab and come back to your world exactly as it was. Saves show a little map of each world. A link sends a friend the very same world at the same year, including your divine interventions.

Auto-resume: a rotating 'auto' slot pair is written every 3 minutes of real time and when the page goes hidden. Genesis then leads with a 'Continue Yi'thathun · Year 250 · 18 nations' card with a map thumbnail.

Save slots get thumbnails and a 'last played' time; branches group under their world (see the Chronoscope proposal).

Share: Menu › 'Copy link to this world' and a Genesis 'Copy link' button build a URL with autostart, seed, preset, set (every non-default parameter), years (current year) and select / zoom. If the world has interventions and their compressed log is 4 KB or less, it adds iv=<base64url deflate of the intervention log>, which the autostart path replays. Larger logs offer an exported file instead.

**Implementation:** saves.js:
- Autosave timer in autosaveTick (real-time based) plus document 'visibilitychange' (hidden) and 'pagehide', fire-and-forget (IndexedDB usually completes).
- Two rotating ids 'auto-a' / 'auto-b'.
- Thumbnail: drawMinimap onto a 160×100 offscreen canvas → toDataURL('image/webp', 0.7), about 6–10 KB, stored in the meta store.

Genesis (genesis.js) calls listSlots() on mount and shows the newest auto slot as a card.

Share: a buildShareURL(world) helper in prefs.js or a new share.js. Encode non-default params as set=k:v pairs; main.js already parses this format, so keep values free of ',' and ':' or escape them. The iv param is CompressionStream('deflate-raw') of JSON interventions, base64url. main.js autostart applies it by running beginWorld with years and passing interventions to replayTo (Chronoscope).

Files: src/ui/saves.js, src/ui/genesis.js, src/ui/hud.js, src/main.js, src/ui/share.js (new).

**Risk:** Background tabs may kill the hidden-state save, but the 3-minute timer covers most cases. A world shared from another build version can differ, so put a build version in the URL and warn on mismatch.

### ux:map-affordance-polish — Map affordance polish: zoom on double-click, frame the selection, richer hover cards, small fixes (P2, S)

**Value:** The map behaves the way your hands expect: double-click dives in, Z frames whatever you are reading, Tab walks through towns on screen, and hovering a nation's land tells you who rules it.

Interaction changes:
- Double-click zooms ×2 at the cursor and, on owned ground, also opens the nation, so today's behaviour is kept.
- Z frames the selection: a nation's territory bounding box, a war theatre, a plague front, or a town at zoom 14.
- Tab / Shift+Tab with the map focused cycle through visible settlements by size, then armies, with a focus ring drawn on the map (keyboard accessibility).

Hover cards extended:
- nation territory at low zoom: ruler, population, wars
- volcanoes: activity
- ruins: when and how destroyed
- wonders
- caravans and ships: route and value

Small fixes:
- army flag labels as integers (F.people-style, e.g. '36' and '1.2k') to match the Inspector
- war-score caption reads 'Attackers ahead by N' or 'Defenders ahead by N' from the sign
- close any tooltip when its popover closes (the stuck 'Menu' tooltip)
- add '0 = pause' and the new keys to the help sheet
- the Chronicle badge resets after a leap or autostart (or offers the digest instead)

**Implementation:** input.js:
- In release, when dbl is true, call app.r('zoomAt', p.x, p.y, 2) before selectAt.
- Z key → app.frameSelection(), a new helper in app.js using the follow-anything bounding-box builder.
- Tab cycling: build the visible list from renderer.hits (settlements and armies) sorted by population or strength, keep an index, and call app.select without moving the camera plus renderer.setSelection.

processHover: when there is no pick, use f.owner[t.i] at zoom ≤ 6 for a nation card, throttled. Add pick kinds 'volcano' (render/glyphs.js already draws them; push hits) and 'caravan'.

Fixes:
- render/entities.js uses an integer or k formatter instead of formatNumber(str, 1).
- inspector.js warView right label is computed from the sign.
- widgets.js closePopover hides #tooltip.
- hud.js showHelp rows.
- panel.js resets seenSeq on 'historySkipped'.

Files: src/ui/input.js, src/ui/app.js, src/ui/inspector.js, src/ui/widgets.js, src/ui/hud.js, src/ui/panel.js, src/render/entities.js, src/render/glyphs.js.

**Risk:** Double-click zoom changes muscle memory slightly, but because it also opens the nation, nothing is lost.

### ux:compare-nations — Compare nations side by side (P3, M)

**Value:** Pit two to four empires against each other: their populations, lands, power and eras across centuries on one chart, their wars against each other with outcomes, and who is ahead today.

In the Nations ledger, each row gets a compare checkbox (or Shift+click; or 'Compare with…' in a nation's record or the context menu). A 'Compare (3)' button opens a new 'compare' record in the Inspector:
- overlaid line charts in each nation's colour for population, territory, towns, power and era (as steps), on the shared time range and crosshair
- a head-to-head block: current opinion and treaties, every war between them (dates, side, outcome, casualties), towns that changed hands between them
- a current-stats table: government, ruler and reign, stability, treasury, armies in the field, techs known, state faith, golden or dark age

The map tints only the compared nations.

**Implementation:** inspector.js: new view compareView(app, {kind: 'compare', id: 'a,b,c'}). Series come from history.years[].civ[id] = [pop, territory, towns, era, power], which stats.js already records. Use a TimeChart in a new mode 'lines' with multiple series and per-series colours; charts.js may need multi-line support beside 'stack'.

Head-to-head reads w.wars (attackers and defenders include both), c.relations[o], and war.captured cross-referenced with the settlement's originCivId and civId. Selection: app.select({kind: 'compare', id: ids.join(',')}); rendererSelection maps it to a renderer.setSelection({kind: 'civs', ids}) highlight, a small renderer addition in render/territory.js.

nations.js gets checkbox UI. Cost: O(years × k) chart build.

Files: src/ui/inspector.js, src/ui/nations.js, src/ui/charts.js, src/ui/app.js (selectionPoint for compare), src/render/renderer.js and src/render/territory.js (multi-civ highlight).

**Risk:** Low. history.years thinning makes old spans coarse, which is acceptable.

### ux:genesis-gallery — Genesis: a gallery of seeds, Surprise me, start-point preview, and naming (P3, M)

**Value:** Choosing a world becomes browsing: six candidate worlds side by side, a dice roll that also varies the conditions, a preview of where the first peoples will rise, and a name you chose yourself.

The plate gets a 'Survey six seeds' strip: six thumbnails from random seeds under the current conditions, rendered one after another. Clicking one adopts its seed.

'Surprise me' rerolls the seed and nudges the parameters within curated ranges per group. Each group header gets its own small dice.

The preview marks likely starting regions of the first tribes as small banners, with a toggle.

Other additions:
- A 'World name' field (blank means the generated name).
- 'Recent seeds' (last 12) and favourites (star), each with a thumbnail.
- Keyboard: Enter begins and R rerolls.

**Implementation:** genesis.js:
- Survey: loop of 6 × (createWorld({...params, seed: s, worldSize: 'preview'}), generate(preview), renderPreview onto 192×120 canvases), awaiting yieldTask between them. The measured 147 ms per preview gives about 0.9 s total, cancellable.
- Surprise: per-parameter jitter tables in genesis.js (cosmetic Math.random is allowed in the UI).
- Start points: if src/sim/civ exports spawnSites(world, n) (pure, using world.rng forked by the seed), call it on the preview world; otherwise use a UI heuristic over annTemp, annRain, soil, river and coast that spreads the top-K sites with a minimum distance.
- World name: a new non-live param 'worldName' (core/params.js) that createWorld uses when non-empty.
- Recents and favourites in prefs 'seedRecent' / 'seedFav', with thumbnails as small webp data URLs.

Files: src/ui/genesis.js, src/core/params.js, src/core/world.js (name override), optionally src/sim/civ/index.js (spawnSites export), styles.css.

**Risk:** The start-point preview should come from the real spawn logic, otherwise it misleads; label it 'likely' when using the heuristic.

### ux:timed-decrees — Decrees: timed scenario changes to live settings (P3, M)

**Value:** One-click 'what if' eras: a Little Ice Age for 80 years, an Age of Plagues, a Peace of the Gods. Each runs its course, writes itself into the Chronicle and fades back, which beats nudging fifteen sliders by hand.

The World tab gains a 'Decrees' section of cards, each bundling live-parameter changes with a duration and a ramp:
- Little Ice Age: baseTemperature −2.5 °C and humidity ×0.9 for 80 years
- Age of Plagues: plagueRate ×3 and plagueLethality ×1.5 for 50 years
- Golden Age of Trade: tradePropensity ×1.8 and stabilityFactor ×1.2
- Fury of the Earth: seismicity, volcanism and disasterRate ×3
- Peace of the Gods: aggression ×0.3
- Great Rains: humidity ×1.4
- Age of Discovery: techRate ×2.5

Active decrees show as chips in the cartouche with years remaining and can be revoked. Any live slider can also be right-clicked for 'Change for N years…'. Starting and ending a decree writes a 'Divine Hand' chronicle entry, e.g. 'By decree of the heavens the Little Ice Age began in Year 312…'.

**Implementation:** State: world.sys.decrees = {active: [{id, label, changes: [{key, from, to}], startDay, endDay, rampDays}]} (JSON).

New tiny system src/sim/decrees.js (order 1): on month start, interpolate each change. Ramp in over rampDays, hold, then ramp back to the base value at endDay, using setParam. The base is recorded at start, so user edits during a decree adjust the base. On expiry it chronicles and removes the decree.

Determinism: decrees are started by the UI and logged as interventions (Chronoscope); all timing is in sim days.

UI: worldtab.js decree cards; a hud.js chip row; the paramControl context action.

Performance: O(active changes) monthly, negligible.

Files: src/sim/decrees.js (new) plus registration in src/systems.js, src/ui/worldtab.js, src/ui/hud.js, src/ui/widgets.js (paramControl hook), styles.css.

**Risk:** Interaction with manual slider edits during a decree, handled by base tracking. New system registration is a kernel file (src/systems.js).

### ux:phone-watch-mode — Phone: give the map back (tool button, stats drawer, swipe tabs) (P3, M)

**Value:** On a phone the world fills the screen. Tools are one tap away instead of taking a quarter of the height, the vitals are a pull-down away, and the Director with captions makes it a pocket documentary.

At compact width:
- The toolbelt collapses to a round tools button at the bottom-right that opens the belt as a sheet; the active tool shows as a small chip with an × to return to Inspect.
- Pulling down the cartouche reveals the headline stats (population, nations, wars, faiths, plagues, era), which are hidden today.
- Horizontal swipes on the sheet header switch tabs.
- Long-press opens the context menu (map-context-menu proposal).
- The Director is offered on first launch and captions sit above the sheet.
- navigator.vibrate(8), when available, gives a tick on tool apply and on epochal events (pref).

**Implementation:** palette.js: compact mode renders a FAB and moves the belt into a modal sheet; app.on('tool') shows an active-tool chip. hud.js: the cartouche gets a disclosure (pointer drag or tap) that shows the existing stats block on phones. panel.js: swipe detection on .panel-head with a 40 px threshold, cycling TABS. styles.css: compact-width rules. Uses isCompact() from dom.js.

Files: src/ui/palette.js, src/ui/hud.js, src/ui/panel.js, src/ui/input.js (haptics), styles.css.

**Risk:** Discoverability of the tool button; the first-run tour points at it.

### ux:book-of-ages — Book of Ages: chapters in the Chronicle and an exportable history (P3, M)

**Value:** History reads like a book: 'The Long Peace (Y40–Y188)', 'The Years of Fire', 'The Rise of Ezdria'. You can export it as an illustrated chronicle with atlas plates to keep or share.

The Chronicle gets a 'Chapters' view.

Where chapters break:
- at epochal (imp 5) events
- at new eras of the leading nation
- at regime shifts in 20-year rolling counts of war, plague and disaster entries
- at large changes in the set of the top 3 nations

How chapters are named, from deterministic templates on the dominant pattern:
- war-dense: 'The Age of Strife'
- quiet: 'The Long Peace'
- plague-dominated: 'The Great Dying'
- one nation's large growth: 'The Rise of X'
- disaster-dense: 'The Years of Fire and Ash'

Each chapter shows its years, a three-line summary (its highest-importance entries) and its atlas plate thumbnail, and expands to the full entries. 'Export the Book' produces a standalone HTML file (and Markdown) with chapter headings, summaries, the imp≥3 entries and one atlas plate per chapter as an embedded PNG, downloaded through the existing export path.

**Implementation:** New src/ui/book.js: chapters(world) as a pure function over chronicle entries plus history.years (per-year counts by category in one pass, then segmentation with a minimum chapter length of 25 years), cached by chronicle.seq.

Plate images reuse atlas.js drawPlate; factor it into an exported function drawAtlasPlate(canvas, world, snapshot).

chronicle.js gets a 'List / Chapters' segmented toggle. Export builds an HTML string with inline styles and data-URL images and downloads it via the saves.js download helper (fails gracefully where downloads are blocked, as now).

Cost: chapters about 5 ms for 6,000 entries; export about 0.5 s with images.

Files: src/ui/book.js (new), src/ui/chronicle.js, src/ui/atlas.js (export the plate drawer), src/ui/saves.js (download helper reuse).

**Risk:** Template naming can feel repetitive, so draw from varied pools keyed by seed. Old low-importance entries are pruned by the kernel; chapters rely only on imp≥3, which is kept.

## Lens: visual

LENS: visual depth, meaning how much new and interesting detail appears as you zoom in. I studied every file in src/render and took screenshots of seed "atlas" at four zooms in terrain and political mode. Z below means CSS pixels per tile; one tile is about 20 km, and the whole medium world fits at about z 5.5 on a 1440×900 screen. I shot a mid world (Year 600), a late world (Year 1200 with techRate 4, Renaissance) and a modern world (Year 2100 with techRate 5: every nation in the Modern Age, 165k-person cities with factories, airports and power stations). I also covered harbours, ruins, wonders, battlefields, peaks, wild coast and armies. Everything is in <scratch>

WHAT WORKS: From world view to regional view (z 5.5 to 12) this is a beautiful hand-tinted atlas. The terrain raster has fine relief shading, biome blending, seasons, snow and pack ice, and farmland that changes colour with the crop calendar. Coastlines have engraved water-lining offshore and rivers taper with size. Lettering is good and avoids collisions. Settlement icons change by tier, and storms, fires, volcano plumes and event effects are handled well. All world-derived geometry is versioned and cached. When the camera is still, a frame costs only 1–3 ms of CPU.

WHAT APPEARS AT EACH ZOOM TODAY:
- z < 8: raster, cloud deck (fades out between z 5.5 and 10.5), sun glints on water (until z 26), coast ink, water-lines from z 3.2, rivers fading in by size, roads (major roads from z 1.5, minor tracks from z 5.5), settlement symbols filtered by tier, labels.
- z 8 to 18 (immediate-mode "detail" layer): mountain peaks on a 3/2/1-tile lattice, trees (1 to 1.6 per tile), hill arcs and small grass, dune and reed strokes from z 14. Pictorial town icons once their radius reaches 6.5 px. Ruins (under 60 years old) from z 7. Army march paths from z 9.
- z 18 to 26: one rotated square farm "plot" per tile, furrow lines from z 26, up to 4 trees per tile.
- z 26 to 80 (the maximum zoom): nothing new appears. The 8-pixels-per-tile raster is simply magnified up to 10×, so it turns blurry and blocky. The largest city on the map is still a 40–60 px icon among tile-sized "playing cards" of farmland. Political mode at close zoom is empty apart from rivers and dotted roads.

WHERE IT FALLS SHORT: The simulation tracks far more than the close-zoom renderer shows:
- 20 building types with levels, 22 wonder kinds, and each town's current construction project with its progress.
- The town's dominant faith, siege progress, plague infection, peak versus current population, and founding culture.
- War battle logs with named sites (937 battles logged by Year 1200). The same ford was fought over four times in a row.
- Armies with morale, supply, general and naval state; caravans with full paths; eras from Stone Age to Modern.

The renderer uses only a town's tier, whether it is a capital, and whether its era is 6 or later (which adds one chimney rectangle). So a Modern-Age metropolis with an airport looks the same as a medieval great city. Wonders never appear on the map. Battlefields leave no mark, and ruins disappear after 60 years. Armies are a single flag and caravans are amber dots.

PERFORMANCE: The detail layer is drawn fresh every frame whenever the camera moves, and its sprite sizes change continuously with zoom. With the GPU flushed each frame, zooming in from z 10 to 80 took a median 19.7 ms and a 90th percentile of 43.7 ms per frame, worst in the z 12–25 band. That is below the 50 fps target exactly where detail first appears. Panning at z 20 put the detail layer at about 11–14 ms. The sprite cache grew from 310 to 1380 entries against its 1600 cap.

PROPOSED LEVEL-OF-DETAIL LADDER (z in CSS px per tile):
- L0 World (z < 6) and L1 Continental (6–12): as today, plus wonder and historic-site symbols, a scale bar, and culture-styled town icons.
- L2 Regional (12–24): today's glyphs, but painted into cached chunks; army unit strips; pack trains; bridges.
- L3 Provincial (24–64): field systems, villages and mills, river ribbons with banks, waves and surf, herds, army formations, city footprints with landmark silhouettes, battlefields with graves.
- L4 Town (64–160): full city plans with walls, gates, temples, markets, harbours with moored ships, factories with smoke, single trees with shadows, livestock, fishing boats, birds.
- L5 Street (160–320, a new maximum zoom): individual buildings, wall towers, graves, shipwrecks, milestones.

All static detail would be deterministic per tile, using hash2i of tile and world-seed salt. It would be painted into a camera-independent chunk pyramid (proposal 1) and invalidated by per-chunk signatures of the actual fields. Moving things (units, smoke, waves, herds, birds) stay in screen space, culled and capped.

The simulation has budget to spare: 88 ms per simulated year at Year 600 and 94 ms at Year 1200, against a budget of 150. The few sim-side additions proposed here (a historic-sites ledger, a land-scar field, a per-civ architectural style, recorded wonder geometry) cost well under 5 ms per year. None of this was edited; it is an audit.

### Gaps
- Frame budget fails exactly where detail begins. In a zoom-in from z 10 to 80 with the GPU flushed each frame (zoomperf.mjs in my scratch folder), frames took a median 19.7 ms, 90th percentile 43.7 ms and worst 53.9 ms. Sampled frames ran 45.5, 45.3, 38.7 and 34.9 ms between z 12 and 25. Panning at z 20 put the detail layer at about 14 ms, minus about 3 ms of flush overhead. Cause: renderer.js _drawDetailLayer redraws drawDetail() in immediate mode whenever cam.moving is true. Its screen cache (_detCanvas) only helps when the camera is still, and is keyed on the exact camera position. Note: these numbers came from headless Chrome, which may use software GL, so real hardware will likely be faster.
- Sprite cache churn. treeSprite and peakSprite (glyphs.js) key on sizes that change continuously with zoom (z*0.4*jitter rounded to 0.5 px, and integer peak width/height). One zoom-in pushed the SpriteCache from 310 to 1380 sprites against its 1600 cap, and a second pass was no faster (median 19.5 ms), so the cache is evicting and re-creating sprites.
- Nothing new appears beyond about z 26, and max zoom is 80 (camera.js maxZoom = max(minZoom*2, 80)). At z 80 the base raster (T = 8 px/tile on medium, 5 on vast; pickTpx in terrain.js) is magnified 10×. Snow and vegetation edges show tile-sized steps (shots/late-peak-60.png), and the background is blurry (mid-terrain-close.png).
- Farmland at close zoom looks like scattered playing cards. detail.js drawPlots draws one square per tile at 0.94 tile size, rotated by up to ±0.35 rad, with 2–4 strips each. The squares overlap and leave gaps, ignore neighbouring tiles, crop type and climate, and hang over the coast ink into the sea. Evidence: mid-terrain-local.png, mid-terrain-close.png, late-harbor-80.png, ind-city-80.png (top right).
- Towns ignore almost all their data. settlementSprite keys only on tier, capital, colour, size and whether era ≥ 6. The modern-era metropolis Hene (165k people; factory 3, airport 2, power station 2, railway, university, bank, hospital) draws as the same domed 'great city' icon as a medieval town (ind-city-80.png). s.buildings, s.project, s.dominantReligion, s.siege progress and peak versus current population never reach the map.
- Wonders are invisible at every zoom. Xaehae (settlement 0) holds three standing wonders — the Great Ziggurat, the Pyramid of Moelto and the Bronze Giant — yet draws as a hamlet icon (late-wonder-60.png). Nothing reads world.wonders except the panels.
- Historic sites are invisible. 937 battles are logged in war.geo.log by Year 1200, including the Third and Fourth Battles, the Autumn Battle and the Winter Battle of 'the Crossing at Shybsuq', all on the same tile. Nothing marks that ground at z 30 (late-battlefield-30.png). Ruins render only for 60 years after destruction and only if peakPopulation ≥ 500 (entities.js settlementList). The ruin glyph and its 'ruins of Juq' label are barely visible (late-ruin-30.png).
- Ship wake bug. drawCaravans builds wakes from positions sampled once per render frame and resets them only after a jump of more than 6 tiles. At Fast speed and above, the 7-point wake becomes a long straight polyline crossing land (white line across the peninsula in late-army-70.png).
- River artifacts at close zoom:
- Each width bucket is drawn as a separate semi-transparent stroke with round caps, so where adjacent buckets meet the caps overlap into darker knobs (mid-political-close.png at the Ouyb confluence: 520,90 / 560,250 / 600,410 / 1120,650).
- Short tributary stubs overshoot past the main stem (640,290–370).
- Short coastal streams render as parallel diagonal dashes (late-wonder-60.png).
- Close-zoom linework misreads. Terrain-mode borders use a dash–dot ink pattern ([3.2, 1.3, 0.6, 1.3] × px) that looks like a railway at z ≥ 40. Roads follow the 8-connected tile graph (diagonals suppressed when an orthogonal shortcut exists), so they render as right-angle staircases (late-terrain-close.png, mid-political-close.png). Modern highways (road level 3, 1208 tiles at Year 2100) are just red lines; there are no railways.
- Political, religion and other thematic modes are empty at close zoom: just rivers, dotted roads and the graticule (mid-political-close.png). No district lines, forts, occupied territory or holy sites.
- Close-zoom sea is static and empty. Clouds fade out entirely between z 5.5 and 10.5, and glints are gone by z 26. No waves, surf, reefs, deltas, falls, frozen rivers or boats other than trade ships (late-wildcoast-40.png, late-harbor-80.png).
- Unused or misread glyphs:
- TREE_KINDS 'bare' (would suit burned forest) and 'rain' are defined but never placed; TREE_FOR maps temperate rainforest to 'conifer'.
- Hill arcs float as disconnected 'eyebrows' not aligned to slope (late-peak-60.png).
- Shrubs read as pebbles at z 80 (mid-terrain-close.png).
- Autumn broadleaf trees look like orange balloons at z 70 (late-army-70.png).
- Hard pops between detail levels: farm plots switch on at exactly z 18, hill strokes at z 14, and town icons swap from symbol to picture when their radius crosses 6.5 px. There is also no scale bar or zoom-level indicator anywhere in the UI (grep of hud.js and mapdock.js for scale or km finds nothing).
- No lasting marks on the land. Lava flows (volcanoes.js lavaTile), meteor ejecta, flood silt, battle damage and mining leave only the 'devastation' and 'burnScar' fields, which decay away. Pollution reaches 1.0 by Year 2100 but shows only as a grey tint. The industrial and modern landscape — rail, power, suburbs, quarries, smog — is absent, so a Year 2100 world looks medieval at every zoom.

### visual:lod-chunk-cache — Level-of-detail chunk pyramid: camera-independent cached detail (P1, L)

**Value:** Zooming and panning stay smooth at every level instead of stuttering at 20–45 ms per frame. It is also the foundation that makes every later close-zoom proposal affordable: the map can keep getting richer as you zoom in without slowing down.

Replace the immediate-mode detail layer and its screen-sized cache with a slippy-map style chunk pyramid.
- Each chunk is 256×256 device pixels (512 at devicePixelRatio 2), covering a fixed block of tiles.
- Level k renders at P_k = 16·2^k px per tile for k = 0..4 (16, 32, 64, 128, 256), so a chunk covers 16, 8, 4, 2 or 1 tiles.
- A chunk holds all static or slow-changing detail: ground texture, fields, trees, rocks, river ribbons, roads and bridges, villages, city plans, scars and historic sites.
- Chunks are drawn with one drawImage each, at a scale between 0.5× and 1×.
- A missing chunk falls back to its parent level, then to today's base raster, so the map never shows holes. A newly built chunk fades in over about 120 ms.
- The base 8 px/tile raster stays as the L0–L1 background and as the bottom layer inside each chunk, upscaled with high-quality smoothing and overlaid with a grain/relief pattern scaled to the level. Each level doubles the noise frequency, which gives an endless-detail feel.

**Implementation:** NEW src/render/lod.js:
- class LodCache { levels:[16,32,64,128,256], chunkPx, map: Map(key → {canvas, sig, builtAt, bytes}), queue, bytes, capBytes = 48 MB }.
- Key `${style family}|${k}|${cx}|${cy}`.
- pickLevel(z·dpr) = clamp(ceil(log2(z·dpr/16)), 0, 4).
- Painters registry: [{id, minLevel, paint(ctx, world, terr, x0, y0, tilesPerChunk, P, info)}], all painting in chunk-local pixels with no camera dependence.

Signature: FNV-1a over
- global versions (terrain, water, roads, plus the settlements version only if the chunk contains a settlement) and the style family;
- per-tile quantised values over the chunk plus a 1-tile apron: biome, farm>>5 (8 bins), veg (8 bins), snow (4), log2 popDensity (8), road, burnScar (4), devastation (4), fire>0, river;
- a season bucket: floor(yearPhase × 12), using the hemisphere of the chunk centre, coarsened to 4 buckets when fx.dps > 60.
Visible chunks are re-signed every 300 ms. About 40 chunks × 324 tiles × 10 fields is roughly 130k typed-array reads, about 0.3 ms.

Build queue:
- Stale or missing chunks, sorted by distance from the view centre.
- Built while perf() − t0 < lodBudgetMs (3 ms), at most 2 per frame, and at least 1 if a visible chunk is empty.
- At Max speed, stale chunks keep drawing and rebuild at most one per frame.
- LRU eviction by bytes, farthest first; purge on setWorld, a device-pixel-ratio change or a style-family change.

TOUCH:
- renderer.js: at z ≥ 12, replace _drawDetailLayer with lod.draw(ctx, vb, z, dpr); add stats.lodBuilds and lodMs.
- detail.js: refactor drawDetail into paintDetailChunk(ctx, w, terr, x0, y0, n, P, mode) using P-scaled sizes.
- glyphs.js: quantise sprite sizes to the level (size = round(base·P_k)) and give each level its own SpriteCache so the sprite set per level is small and fixed — this fixes the churn.
- terrain.js: export bil(field, x, y) sampling and paintGround(ctx, x0, y0, n, P), which draws the raster region upscaled plus a multiply-blended tileable relief/grain pattern from reliefTexture.
- Later: move painting to an OffscreenCanvas worker by sending per-chunk field slices and getting back an ImageBitmap.

Determinism: static scatter uses hash2i(x, y, salt ^ seedHash(world.seed)), never Math.random. No sim or state changes.

Performance: blits ≤ 1 ms per frame; builds ≤ 3 ms; memory ≤ 48 MB.

**Risk:** Seasonal and fast-sim invalidation could cause rebuild storms; mitigated by quantised signatures, the coarser season bucket at high speed, and stale-while-rebuilding. Seams at chunk edges need a 1-tile apron and scatter keyed by tile (not by chunk) so glyphs crossing a chunk edge are drawn in both neighbours and clipped. GPU memory on phones needs a lower cap (24 MB).

### visual:city-ground-plans — Cities that grow block by block from their real buildings and history (P1, L)

**Value:** Zooming into a city shows its life story:
- a walled medieval core inside later suburbs, its cathedral roofed in the colour of its faith, a harbour with ships moored by trade, factories smoking downwind, an airport runway along the wind;
- empty roofless quarters when it has shrunk from its peak.
Every city in every run looks different and readable at a glance.

At z ≥ 24 a settlement draws as a procedural ground plan instead of a single sprite. The plan is generated deterministically from the town's own data:
- Footprint radius r = clamp(0.06 + 0.075·log2(1 + pop/800), 0.06, 0.75) tiles, with cartographic exaggeration noted in the legend.
- Arterial streets run along the town tile's actual road directions and river banks; ring roads sit at 0.35r and 0.7r.
- Blocks are ordered by growth priority (distance + hash jitter + slope and water penalties). The first blocksFor(peakPopulation) are built and the first blocksFor(population) are lived in. The difference shows as abandoned, overgrown, roofless blocks, so decline is visible.
- Walls by walls level: palisade, stone wall with towers, castle keep, star fort with bastions. Gates sit where arterials cross. For era ≥ 6, old walls end up inside the sprawl.
- Landmarks on lots near the centre by building key and level:
  - civic and religious: palace or citadel (capital); shrine → temple → cathedral, roof in the dominant religion's colour; market → grand bazaar square with stalls; library/university courtyard; amphitheatre or opera oval; barracks yard;
  - infrastructure: aqueduct arches toward the highest neighbouring tile; harbour piers on the coast side with moored ships = min(8, 1 + sea routes); mine headframe at the catchment's resource tile; hospital; observatory dome on the highest nearby point;
  - industrial and modern: factory sawtooth roofs with chimneys on the downwind side (windX/windY) that emit smoke in proportion to pollution; railway station with track out along the main arterial; power station cooling tower; airport runway outside the footprint aligned with the prevailing wind.
- State overlays: siege camp ring with breaches growing with s.siege.progress; scaffolding or a crane on the lot of s.project, filled by progress/cost; plague (desaturated blocks with marked doors); famine (empty market).

Detail by level:
- L3: footprint blob, arterials and 1–3 landmark silhouettes.
- L4: all blocks, walls and landmarks.
- L5: individual lots and buildings with roofs and shadows.

**Implementation:** - NEW src/render/cityplan.js: buildPlan(world, s) → primitives in tile-local coordinates {streets: Float32Array polylines, blocks: [{poly, cls, state}], walls, gates, landmarks: [{key, level, x, y, rot}], quays}; and paintPlan(ctx, plan, P, style, dpr).
- Plan cache key: s.id | k | bucket(peakPopulation) | bucket(population) | buildings signature | wonders here | civ era | style id | siege bucket | project key. LRU of 64 plans; build cost about 1–3 ms for a metropolis (≤ 1500 lots), counted against the chunk-build budget.
- glyphs.js: landmark sprite functions per BUILDINGS key and level (about 30 small vector routines) with LOD variants.
- entities.js drawSettlements: at z ≥ 24, blit the cached plan sprite under the icon (the icon shrinks to a label marker); add hits for landmarks (kind 'landmark' with sid and key) for the inspector.
- renderer.js: blocks town labels over the plan; the plan masks fields in the chunk pass.
- Data: no new sim state is required. Optional: civ/buildings.js records s.flags.wallR (footprint radius when walls level 1 was first built) for historically placed walls. JSON-safe.
- Determinism: seed = hash2i(s.id, s.x, s.y) ^ seedHash.
- Performance: on-screen cities ≤ 40 blits per frame.

**Risk:** Visual clutter at L3 if too many landmarks; keep L3 to the footprint plus 3 silhouettes. Exaggerated footprints overlap neighbouring towns 2–3 tiles apart at 250k+ population; clamp r to 0.45 × the nearest-neighbour distance. Plan stability: buckets must be coarse enough that monthly population noise doesn't regenerate plans.

### visual:zoom-ladder-ux — Zoom ladder: scale bar, named zoom levels, crossfades, deeper max zoom, dive-in (P2, S)

**Value:** The player always knows how far down they are ('Province view, 1 cm ≈ 60 km'). New layers bloom in instead of popping, and double-clicking a town dives down to its streets. Zooming becomes something to explore rather than just magnification.

Four parts.
1. A cartographic scale bar using 1-2-5 round numbers of km (KM_PER_TILE = 20), plus a small badge naming the zoom level (World, Continent, Region, Province, Town, Street) and a hint of what appears next ('closer: fields and villages').
2. Every level threshold becomes a smoothstep crossfade over about 20% of zoom. Farm plots, hill strokes and town icons currently switch abruptly at z 18, z 14 and an icon radius of 6.5 px; town icons would draw both symbol and picture with complementary alpha across the switch.
3. Raise max zoom from 80 to 320 once the chunk cache and city plans exist. Until then, keep 80 but stop the magnification blur by drawing the chunk ground pass.
4. Double-clicking a settlement icon flies (camera.focusOn) to z 96, framing its footprint. 'Fit realm' and 'fit city' keyboard shortcuts.

**Implementation:** - camera.js: maxZoom constant to 320, behind a renderer.lodReady flag.
- renderer.js:
  - export LOD_BANDS = [[0,6,'World'],[6,12,'Continent'],[12,24,'Region'],[24,64,'Province'],[64,160,'Town'],[160,320,'Street']] and a getZoomInfo() → {name, kmPerPx, next};
  - fadeBand(z, a, b) helper used by detail.js, entities.js drawSettlements (symbol and picture alpha) and drawRuin.
- ui/mapdock.js or hud.js: scale bar element. Length = niceKm(120 px × 20 / z); update on 'tick' and camera change, at most 10 times per second.
- ui/input.js: dblclick on a settlement hit → app.focusSelection plus focusOn(s.x, s.y, 96). Today dblclick selects the owning nation, so require Shift or use the inspector's 'Visit' button to avoid the conflict.

No sim changes. Cost is negligible.

**Risk:** Double-click is already bound to 'select nation', so it needs a modifier or a separate button. A deeper max zoom without the chunk cache would expose blur, so the two are gated together.

### visual:modern-landscape — Industrial and modern landscape signature (P2, M)

**Value:** A Year 2100 world finally looks different from Year 900:
- railways threading between cities, suburbs sprawling past old walls, quarries and open-pit mines, nodding oil pumps;
- power lines, wind farms, reservoirs behind great dams, centre-pivot fields in dry land;
- smog plumes drifting downwind and the glow of light pollution.
Technology becomes visible on the land.

Era-gated painters and dynamic effects driven by owner-civ era, buildings, resources, roads and pollution.
Era 6 (Industrial):
- road level 3 draws as railway with sleepers and an animated train;
- brick terrace suburbs ring cities;
- coal and iron resource tiles in catchments become quarries or open pits with spoil heaps;
- factory smoke plumes advected by wind, opacity ∝ pollution.
Era 7 (Modern):
- highways in asphalt with a centre line;
- grid suburbs and towers;
- pylons with power lines from power stations to the nearest 2–3 cities;
- wind turbines on windy farmland or ridges (renewables tech);
- oil derricks on oil tiles;
- airports with planes taking off and contrails along long trade routes between airport cities;
- centre-pivot circles in farmland with annRain < 0.35;
- field consolidation into large rectangles;
- reservoir tint upstream of great dams.
Polluted land: yellowed trees, discoloured river reaches downstream of factories (river tint by the pollution of upstream tiles along flowDir).

**Implementation:** Painters in lod.js (rail, quarries, pylons, turbines, derricks, pivots), keyed by owner era in the chunk signature (add civ era per owner to the signature: owner id → era lookup, recomputed yearly).

TOUCH:
- vectors.js buildRoads: tag each chain with the owner era of its midpoint; separate rail and highway paths.
- renderer.js _drawRoads: rail and highway styles.
- entities.js: trains and planes as dynamic vehicles, following caravan paths and routes between settlements with airports.
- fx.js Particles: a PLUME kind with long life and wind drift.
- cityplan.js: suburb rings.

Pylon lines: straight segments with sag curves from each powerplant settlement to its nearest 3 same-civ cities, cached by versions.settlements.

Data: all already in state (s.buildings, f.resource, f.pollution, civ.tech.era, f.road). No sim changes.

Performance: baked into chunks; dynamic plumes ≤ 200 particles; trains and planes ≤ 60 sprites.

**Risk:** Visual noise if every era 7 tile gets infrastructure; gate densities by popDensity and distance to cities. Owner-era invalidation must not trigger full rebuilds every year; compare quantised per-chunk era sums.

### visual:field-systems — Field systems instead of farmland 'cards' (P2, M)

**Value:** Farmland becomes one of the most beautiful things on the map. It reads like a real countryside — paddies, vineyards, strip fields, terraces, hedgerows, oases — and shows climate, culture and era at a glance. Fields thin out believably at the frontier and turn white under snow.

Replace drawPlots (one rotated square per tile) with a continuous parcel tessellation.
Layout:
- A smooth orientation field (low-frequency hash noise blended toward the local slope aspect and the nearest road/river direction) lets parcels run across tile edges coherently.
- Each tile's cultivated fraction is set by f.farm. Parcels come from a recursive quad split at depth 2–4, kept or dropped by hash vs farm, so frontiers become scattered clearings.
- The coast mask (terr.Lv bilinear > 0) clips parcels so they never cross into the sea.
Crop by climate and terrain:
- rice paddies where annTemp > 18 and annRain > 0.55 or wetland: blue-green with water sheen, contour terraces on hills (elevation > 0.62);
- wheat or barley in temperate land;
- millet or maize in savanna;
- vineyard and olive rows in shrubland with a dry season;
- orchards as dot rows;
- date-palm oases where hot desert farmland sits next to a river or lake;
- pasture where herbivores are dense, with livestock dots at L4.
Field style by owner era and culture: small irregular plots (era 0–2), long open-field strips (era 3–5, temperate), enclosure hedgerows in wet temperate climates or dry-stone walls in hills and cold land (era 4–6), large consolidated rectangles (era 7).
Seasons: existing per-row crop colours; stubble stripes after harvest; snow cover. Exhausted soil (soil < 0.16) shows as fallow with weeds.

**Implementation:** - lod.js painter 'fields' (levels 0–4; L0 keeps the raster patchwork as today).
- detail.js: remove drawPlots for z ≥ 18 when lod is active.
- terrain.js: export the crop[] row colours and a cropKind(world, i) helper (pure function of biome, annTemp, annRain, river, elevation).
- Orientation field: angle(x, y) = 2π·valueNoise(x/6, y/6, seed) blended 60% toward atan2 of the elevation gradient where the slope is above a threshold. Computed per chunk from tile values; no new field.
- Parcel split depth by level (k+1); hedges as polylines along parcel edges with a hash-chosen subset.
- Optional sim: civ ensureField 'farmPeak' (U8, maximum farm×255 ever reached, updated in the scanCatchment loop at no extra traversal cost), so abandoned fields can show ghost outlines under regrowth — history on the land. JSON-safe via ensureField; about +0.1 ms per year.
- Performance: about 200–800 polygons per chunk, about 1–2 ms per chunk build. Zero per-frame cost.

**Risk:** Getting a coherent look across chunk seams; scatter keyed per tile with the apron solves it. Paddies and terraces need careful colour so they don't read as water. Purely visual, so no sim risk.

### visual:wonders-on-map — Wonders as visible landmarks at every zoom (P2, M)

**Value:** The Pyramid of Moelto, the Colossus, the Great Wall and the Iron Tower become landmarks you can see and click from across the continent. Their ruins remain after empires fall. Wonders are the proudest thing a civilisation makes and today they are invisible.

A glyph registry for all 22 WONDERS kinds, with three levels of detail:
- z 6–16: a small gold-ringed symbol beside the city at a hash-chosen angle, plus an italic gold label from z 12;
- z 16–64: a pictorial silhouette — stepped ziggurat, pyramid with long shadow, colossus astride the harbour mouth, lighthouse with a rotating beam (visible in fog, night or storms), amphitheatre oval, iron tower, skyspire;
- z ≥ 64: drawn into the city plan.
Wonders with their own geometry:
- Great Wall: a crenellated line with towers along the border tiles facing other civs within 12 tiles of the city at completion;
- Grand Canal: a canal line from the city to the nearest river or coast;
- Great Dam: a dam across the downstream river with a reservoir tint over the 3–6 upstream river tiles.
Destroyed wonders: rubble glyph plus a 'ruins of …' label. Clicking a wonder opens its card in the inspector.

**Implementation:** - glyphs.js: WONDER_GLYPHS[kind](g, s, lod).
- entities.js: drawWonders(r, ctx, labels) after drawSettlements, reading world.wonders (sid → settlement x/y, which persist even when the town is dead).
- Sim (small, civ/buildings.js at completion, line ~171): record wonder.path (great_wall: up to 120 border tile indices from a traceEdges-style scan of civ-owned tiles bordering non-owned land within 12 tiles; grand_canal: findPath land between city and nearest river tile, ≤ 60 tiles) and wonder.i (great_dam river tile). Plain JSON arrays of ints; done once per wonder.
- renderer.js: Path2D cache keyed by wonder id; lighthouse beam drawn in screen space.
- Hits: kind 'wonder' → inspector.
- Performance: about 22 wonders at most; trivial.

**Risk:** The Great Wall path recorded at build time may later cross foreign land after border changes. That is intended — it is history — but label it in the inspector so it doesn't look like a bug.

### visual:historic-sites — Historic sites: battlefields, graves, lasting ruins, shipwrecks and craters (P2, M)

**Value:** The land remembers. Fords fought over four times sprout grave mounds and a 'Crossing at Shybsuq — 4 battles, 10,500 dead' label. Dead cities linger as overgrown foundations and finally as 'Ancient Oskel' mounds. Shipwrecks lie in the shallows where fleets sank. Zooming into any region turns up its past, making each run's history feel physical.

A persistent ledger of places where things happened, drawn in proportion to how much happened there.
Site kinds:
- battles and sieges: merged by site name or within 1.5 tiles, accumulating count, dead, years and sides;
- ruins: every destroyed settlement, kept permanently;
- meteor craters, great eruptions, epicentres of great quakes;
- shipwrecks: naval armies destroyed, and storms sinking ships;
- plague pits: towns that lost over 25% to a plague;
- treaty sites and holy cities.
Levels of detail:
- z ≥ 6: only major sites (≥ 3000 dead, wonders' ruins, craters) as small symbols;
- z ≥ 12: all sites as symbols sized by log(dead);
- z ≥ 24: graves (cairns, stelae or crosses by culture style), count = min(40, dead/250), with weapon scatter and vultures in the first year;
- ruins as the dead city's plan in foundation outline, reclaimed by vegetation over centuries: 'ruins of X' → 'Ancient X (fl. Y120–Y480)' after 300 years;
- great victories get an obelisk if the winner knows masonry.
Inspector 'site' card: all chronicle entries within 2 tiles of the site (entries already carry x and y), the combatants and the dead.

**Implementation:** SIM (new src/sim/sites.js, system order 98, about 120 lines; or inside stats.js):
- world.sites = [] holding plain objects {id, kind, x, y, name, firstDay, lastDay, n, dead, civIds:[≤4], ref:{warId?, sid?}}.
- Exported recordSite(world, e) merges within 1.5 tiles with the same kind and name.
- Writers:
  - war.js battle() after g.log.push (one line);
  - hooks: settlementDestroyed (ruin, using s.peakPopulation, tier and buildings already on the object);
  - meteors.js crater; volcanoes.js VEI ≥ 5; quakes.js M ≥ 7.5;
  - storms that sink ships; disease when a town's toll is above 25%.
- Cap 500 with eviction by score = log(1 + dead) + kind weight − age/1000 years. JSON only.
RENDER:
- entities.js drawSites (symbols) and a lod.js painter 'sites' (graves and foundations, so they're cached);
- remove the 60-year and peak ≥ 500 ruin filter from settlementList;
- ruin foundations use buildPlan with state 'ruin';
- hits kind 'site'.
UI: inspector.js site card.
Performance: sim O(events), well under 0.5 ms per year; render culls to the view; graves baked into chunks.

**Risk:** Clutter in war-heavy runs; mitigated by merging, the zoom gates and the cap. Ruin foundations need the city-plan generator for the best look, but the symbols-only first version ships without it.

### visual:armies-formations — Armies as formations; sieges and battles as scenes (P2, M)

**Value:** Wars become something you watch, not just read about:
- columns of spearmen or legions marching along roads in a dust plume, knights and pike squares, then line infantry with cannon, then tank columns;
- fleets of galleys or galleons;
- siege camps ringing a city with trebuchets lobbing stones until the wall breaches;
- two formations clashing in smoke, with the dead left behind as graves.

Level of detail for each army:
- z < 9: banner as today;
- z 9–24: banner plus a strip of 1–5 unit icons;
- z ≥ 24: a formation of blocks, count = clamp(round(log2(strength/250)), 1, 24).
Arrangement by state:
- marching: a 2-abreast column along the heading (path[pathStep] − position);
- idle or camped: a grid with tents and the general's pavilion;
- sieging: an arc around the target's footprint at r + 0.15 tiles, with siege engines by era (ram or tower → trebuchet → cannon → artillery) and cosmetic projectile arcs; wall breaches in the city plan grow with siege.progress;
- retreating: a loose scatter with tilted banners;
- routed: fleeing dots;
- naval: a wedge of 1 + blocks/2 hulls by era (galley with animated oars → longship or dhow by latitude → carrack or galleon → ironclad → destroyer).
Composition: cavalry share 0.3 if the civ owns a horses resource tile and era ≥ 1; artillery share from era 5.
Era unit sprites: bronze spears, classical legion squares, medieval knights and levy, renaissance pike and shot, industrial line infantry and cannon, modern tanks and trucks.
Movement and morale: dust particles behind columns on dry biomes and mud splashes on wet ones. Morale below 0.4 shows tattered banners. The general's name appears under the banner from z 24.
Battle scenes: on a 'battle' fx, if both armies are on screen, draw the two formations converging with a clash line, gunpowder smoke (era ≥ 5) or dust and sparks; graves come from the historic-sites ledger.

**Implementation:** - NEW src/render/armies.js (move drawArmies out of entities.js).
- glyphs.js: unitSprite(era, kind, size) and fleetSprite(era, size). Sizes quantised per level of detail; about 8 eras × 4 kinds × 3 sizes = 96 sprites.
- fx.js battle case: when z ≥ 24, look up the armies nearest fx.x/fx.y (renderer passes world.armies) and render the clash.
- Data already present: army.state, path, pathStep, strength, morale, supply, naval, general, civId, targetId; s.siege.progress; civ.tech.era.
- Optional sim: war.js sets army.flags.cav = 0..1 when raising (from the horses resource access it already can compute) so composition is canonical.
- Performance: ≤ 60 armies × ≤ 24 blocks ≈ 1.5k blits worst case; particle cap shared with the existing system (900).

**Risk:** Readability at L2 when many armies overlap; keep L2 compact (banner plus a short strip). Battle scenes depend on fx timing (fx expire in about 2 s); acceptable as cosmetic.

### visual:river-water-detail — Living water: rivers with banks, deltas and falls; waves, surf, reefs and ice (P2, M)

**Value:** Coasts and rivers are where people settle, and at close zoom they become the most alive part of the map:
- surf breaking on windward shores, turquoise lagoons behind coral reefs;
- great rivers meandering between banks to a fanned delta, waterfalls misting, rivers freezing white in winter;
- icebergs calving from polar shelves.

Fix the current artifacts:
- draw each river chain as one tapered filled ribbon (offset curves ±halfWidth(t) along the normals), so there are no overlapping semi-transparent round caps at bucket changes;
- trim tributary ends exactly at the confluence.
Rivers at L3+:
- dark ink bank lines and a lighter channel centre;
- animated current chevrons moving downstream;
- lowland meanders (sub-tile sinusoidal displacement, amplitude ∝ (1 − slope), seeded per chain), with oxbow lakes on flat great rivers;
- deltas at mouths of class ≥ 3 onto a shelf: 3–5 distributaries plus a sediment plume tint;
- waterfalls and rapids where the elevation drop along flowDir exceeds 0.04 on river class ≥ 2 (white plume plus mist particles);
- frozen reaches when temp < −3 °C.
Sea:
- wave crests in screen space from z 12, oriented perpendicular to the wind (windX/windY), density ∝ wind speed and storm proximity;
- surf: the coast Path2D stroked seaward with animated white dashes (lineDashOffset), brighter on windward coasts;
- reefs and lagoons (shelf depth 0.46–0.5, annTemp > 22, within 2 tiles of land): turquoise, coral speckle, reef-crest line;
- kelp in cold shelves; icebergs drifting near ice-shelf coasts.
Lakes: reed margins on wetland; winter ice.

**Implementation:** - vectors.js: buildRiverRibbons(world) → per-chain {pts, widths, id}, plus ribbon Path2D per level-of-detail chunk; trim the tributary's last point at the main stem's edge.
- renderer.js _drawRivers: at z < 20 keep the buckets but stroke with lineCap 'butt' and a single alpha per bucket to remove the knobs; at z ≥ 20 the lod painter 'rivers' draws ribbons, banks and deltas; chevrons and frozen tint per frame.
- Frozen state: sample f.temp along each chain once a second.
- clouds.js Atmosphere: drawWaves(ctx, r, now) and drawSurf (coast path from vec.coast).
- lod.js painters: 'reefs', 'kelp', 'reeds', 'falls'. Falls and deltas detected once per versions.water and cached.
- No sim changes. Determinism: meander and reef scatter hashed by chain id and tile.
- Performance: waves ≤ 800 strokes in one path; surf is one dashed stroke of the visible coast chunks; the rest is baked.

**Risk:** Meander displacement must stay inside the river's own tiles or towns on banks look misplaced; clamp amplitude to 0.3 tile. Surf animation costs a full coast stroke per frame (≈ 1 ms measured for the coast layer); limit to z ≥ 14.

### visual:traffic-by-era — Caravans, ships and trains that match their land and age (plus a wake fix) (P3, M)

**Value:** Trade becomes visible as life:
- camel trains crossing the desert, mule trains in the hills, ox-carts on country tracks;
- galleys with beating oars giving way to galleons, clippers and smoking steamers;
- steam trains on the railways;
- fishing fleets bobbing off every harbour town.
You can tell the age of a world from its traffic.

Fix the wake: build ship wakes from the caravan's own path (c.path[max(0, pathStep−6)..pathStep] plus the fractional position), so they never cut across land. Draw a V-shaped foam wake at L3.
Land traffic at z ≥ 12, chosen by the biome under the caravan and the road level:
- desert biomes: camel train of 3–6 animals by log(value);
- hills or alpine: mule train;
- rainforest: porters;
- road 0–1: pack horses or ox-cart;
- road 2 and era ≥ 2: wagons;
- road 3 and era ≥ 6: steam train with carriages following the path and smoke puffs;
- era 7: truck convoys.
Ships by owner era and latitude: reed boat or galley (era 0–2), trireme (era 2–3), longship or cog at high latitude and dhow with lateen sail in the tropics (era 4), carrack or galleon (era 5), clipper then steamer (era 6), container ship (era 7).
Fishing boats: 1–6 per coastal or lake settlement, ∝ log(pop) × harbour level, drifting within 1.5 tiles offshore on the town's fishing waters (f.civWaterSettle), with nets at L4.
Ferries shuttle at great-river road crossings before engineering.

**Implementation:** - entities.js drawCaravans → NEW src/render/traffic.js; glyphs.js vehicle sprites (about 14 kinds × 3 sizes).
- Wake: replace the r._trails sampling with path-based trail points.
- Fishing boats: deterministic per settlement — angle = hash(s.id, k) + now × ω on an ellipse over its water tiles, picked from f.civWaterSettle == s.id (an existing saved field), cached per settlements version.
- Particles: steam/smoke from fx.js PK.SMOKE with a cap.
- Data: c.kind, c.path, c.pathStep, c.civId, c.value; civ era; f.biome and f.road at the caravan position. No sim change.
- Performance: caravans ≤ 200 on screen (189 in the Year 600 run); trains ≤ 8 sprites each.

**Risk:** Trains on road level 3 assume rails. If the trade module later distinguishes rail from highway, update the rule; until then highways (era 7) and railways (era 6) are told apart by era.

### visual:roads-bridges-passes — Roads with character: bridges, fords, passes, waystations, border posts (P3, M)

**Value:** Following a road at close zoom becomes a small journey:
- stepping-stone fords become timber bridges, then many-arched stone bridges, then iron trusses;
- a named mountain pass with its watchtower;
- caravanserais spaced through the desert, customs gates at frontiers, milestones counting down to the capital.

Road shape: smooth road chains at z ≥ 20 with Catmull-Rom through tile centres plus hash jitter (±0.15 tile) and corner rounding, so the orthogonal tile staircase disappears. Style roads by the owner civ's era: wheel-rut track, paved road with kerbs, railway, asphalt highway.
Bridges: wherever a road crosses a river tile. Bridge type depends on era and river class:
- ford stones (era ≤ 1, river class ≤ 2);
- ferry raft (river class 4, era < 3);
- timber bridge;
- stone arch bridge, arches = river class + 1 (era ≥ 3);
- iron truss (era 6);
- suspension or concrete (era 7).
Each bridge is oriented perpendicular to flowDir.
Mountain passes: road tiles above elevation 0.7 that are lower than their two road neighbours' flanks get a pass marker, a watchtower and a name ('the Pass of X'), using the same vocabulary as war.js siteName so battle names match map labels.
Waystations and border posts:
- a caravanserai (desert) or inn about every 6 tiles along land trade routes (hashed);
- a customs gate where a road crosses between two civs' land;
- milestones at L5.
Fix the terrain-mode border pattern so it no longer looks like a railway at close zoom: a solid thin ink line plus a soft colour ribbon, keeping the dash–dot only below z 20.

**Implementation:** - vectors.js buildRoads: also return bridges [{i, angle, cls}], passes [{i, angle}] and junctions; cached by versions.roads and versions.water; Catmull-Rom emission for z ≥ 20 paths (store raw chains, emit per level of detail).
- renderer.js _drawRoads: era styles (era looked up per chain midpoint owner, cached yearly); _drawBorders: pattern by zoom.
- lod.js painters: 'bridges', 'waystations', 'milestones'.
- Naming: move landscapeAt and siteName vocabulary from src/sim/geo/war.js into an exported helper in src/sim/geo/common.js (DOM-free). The renderer imports it read-only; or compute names lazily once and cache them in r._gazetteer.
- No new sim state.
- Performance: bridge and pass detection is O(road tiles) ≈ 4k on rebuild; drawing is baked.

**Risk:** The renderer importing a sim helper crosses the file-ownership lines in SPEC §3; put the naming helper in a neutral module (core or a shared namer) instead. Per-chain era styling changes on conquest; cache it by versions.owner at most yearly.

### visual:culture-architecture — Architectural styles per culture (and the hook for fantasy races) (P3, S)

**Value:** Cultures become visible in terrain mode, even at regional zoom:
- flat-roofed adobe towns along the desert rim, pagoda roofs in the east, timber longhouses in the north;
- conquered towns keep their founders' look;
- splinter states inherit their parent's architecture.
This is also the mechanism a fantasy mode would use for elven tree-halls and dwarven mountain holds.

Each civ gets a style record set when the civ is created: {roof: pitched | flat | dome | pagoda | conical-thatch | longhouse, wall: mudbrick | timber | whitewash | stone | brick, temple: ziggurat | stupa | basilica | onion-dome | pyramid-temple, layout: organic | grid | ring, palette: roof RGB}.
- Chosen from the language hash, nudged by the origin biome (flat roofs in hot dry land, steep roofs in snowy land).
- Inherited from parentId with a small mutation, so cultural lineages show.
- Eras modify the style: classical colonnades, medieval keeps, industrial brick and chimneys, modern towers.
- Towns are drawn in the style of their founding civ (s.originCivId), so the cultural map shows in terrain mode.
- Settlement icons from z 6 vary their silhouette by style, not just by colour.
Fantasy hook: a STYLE registry with selection rules. A fantasy mode adds race styles (elven crown-halls placed on forest tiles, dwarven gates carved into peaks with no visible town footprint, orcish palisades with bone towers, burrow-mounds) without renderer changes elsewhere.

**Implementation:** - Sim (civ module, the civCreated hook in src/sim/civ/index.js or government.js): civ.style = pickStyle(world, civ) using world.rng.fork('style:' + civ.id), or a hash of language.seed if present; JSON object.
- Fallback for old saves: derive from civ.id hash at render time when civ.style is missing.
- glyphs.js settlementSprite: add style to the cache key and draw roof and temple variants (≈ 6 roof × 5 temple templates).
- cityplan.js: uses style for blocks and landmarks.
- Inspector: show 'Architecture: whitewashed domes' in the culture section.
- Performance: sprite variants × tiers × sizes stay under 600 entries; no per-frame cost.

**Risk:** More sprite variants; quantise sizes (lod-chunk-cache) so the cache doesn't thrash. Styles must read on parchment and keep the hand-drawn feel; limit palettes to the existing ink and parchment family.

### visual:countryside-life — Countryside life: villages, mills, herds, livestock, birds, chimney smoke (P3, M)

**Value:** The land between towns comes alive:
- hamlets and farmsteads scattered through the fields, watermills on streams and windmills on the steppe;
- wild herds drifting with the seasons and wolves shadowing them; sheep in their paddocks;
- skeins of geese heading north in spring;
- wisps of chimney smoke on winter mornings.
The ecology simulation becomes something you can see.

Static, baked into chunks:
- rural houses per tile = min(6, floor(ruralPop/300)), where ruralPop is popDensity outside the town tile; clustered by hash, avoiding roads and water; roof dots at L3, styled cottages at L4;
- watermills where river > 0, farm > 0.3 and era ≥ 2;
- windmills on steppe or coastal farmland in eras 4–6; wind turbines in era 7 on windy ridges.
Dynamic, screen space, from z ≥ 24:
- wild herds wherever herb > 0.25: groups of 4–12 dots per sampled tile. Position = hash base + seasonal migration offset (±0.4 tile along the latitude-season vector) + slow Lissajous wander over time;
- predators: 1–2 dark dots near herds wherever pred > 0.02;
- livestock (white sheep, brown cattle) on pasture parcels near towns;
- fish-school shimmer where fish > 0.6.
Birds:
- 5–15-bird chevron flocks crossing the view, heading poleward in spring and equatorward in autumn by hemisphere (yearPhase);
- gulls over harbours; vultures circling battle sites less than a year old.
Chimney smoke: towns and villages with temp < 8 °C emit small wisps drifting downwind (windX/windY).

**Implementation:** - lod.js painters 'hamlets' and 'mills'.
- NEW src/render/life.js: drawHerds, drawBirds, drawSmoke(r, ctx, now) — per frame, culled to the view. Herds and predators are a single path fill per colour (≤ 1500 dots); birds ≤ 30 flocks as one stroked path.
- Uses smoothed fields from terrain.sm (herb, pred) when present to avoid striping.
- Smoke goes through the fx Particles pool, capped at 120 for this source.
- Data: f.popDensity, f.herb, f.pred, f.fish, f.farm, f.river, f.temp, f.windX/windY, yearPhase, world sites. No sim change.
- Determinism: positions are a pure function of (tile hash, now).
- Performance: ≤ 1.5 ms per frame at worst, skipped entirely below z 24.

**Risk:** Moving dots can look like noise; keep them sparse, small and desaturated, and honour prefers-reduced-motion (freeze positions).

### visual:land-scars — Lasting scars: lava fields, crater ejecta, flood silt, trenches, quarries, burned snags (P3, M)

**Value:** Catastrophes and industry leave marks that last for centuries:
- a black basalt tongue from Year 812's eruption slowly greening;
- a meteor's pale ejecta blanket; silt fans after floods;
- zig-zag trenches on modern battlefields; quarries and spoil heaps at old mines;
- forests of dead snags after great fires.
Returning to a place shows its scars.

A new tile field, scar (U8): kind in the high nibble, intensity or age in the low nibble. Kinds and writers:
- lava: volcanoes.js lavaTile;
- ejecta: meteors.js rim and blanket;
- silt: floods.js;
- wrack line: tsunamis;
- fissure: quakes M ≥ 7 along the fault direction;
- trench: war.js battle when either army's era ≥ 6;
- quarry or spoil: civ scanCatchment when a mine works a resource tile and resourceAmt < 0.5;
- clear-cut: where logging (eLog) cut veg below 0.2.
Decay: a monthly striped pass lowers intensity at kind-specific rates (lava 1 step per 25 years, so about 375 years to green over; silt 1 per year; trench 1 per 7 years).
Rendering:
- natural-style raster tint in prepassRow: basalt black-violet, ejecta pale grey, silt light tan;
- chunk glyphs: lava ropes, crater rim ring, trench zigzags, spoil heaps, stumps;
- burnScar > 0.25 places the existing (unused) 'bare' snag tree sprite instead of living trees;
- pollution yellows tree sprites and tints rivers downstream.

**Implementation:** - Sim: ensureField(world, 'scar', Uint8Array, N) in each writer, so it is saved automatically. Writes are O(event).
- Decay: in ecology's existing striped update (stripeRow) or civ's landscape pass every second month; O(N/K) per day ≈ 0.1 ms per year total.
- Render: terrain.js prepassRow reads f.scar if present (guarded for old saves); lod.js painter 'scars'; detail.js tree choice checks burnScar for 'bare'.
- Also add 'scar' to the chunk signature.
- SPEC §4 needs a row for the new field.
- Determinism: writers use world.rng where randomness is involved.

**Risk:** Cross-owner writes (nature, geo, civ) into one shared field need a clear ownership note in SPEC. The quantised signature keeps chunk invalidation cheap.

### visual:political-close-zoom — Thematic modes with close-zoom depth (political, religion, disease, trade) (P4, M)

**Value:** Political mode stops being an empty wash when you zoom in:
- county lines and names, forts glaring across hostile frontiers, customs gates on roads;
- occupied towns hatched in the occupier's colour, frontlines where wars are hot.
Religion shows pilgrim trails to holy cities; disease mode shows quarantine cordons.

Political at z ≥ 16:
- catchment boundaries (ownerSettle) as fine dotted 'county' lines, with county names (the settlement name) in small caps at z ≥ 24;
- watchtowers or forts on border tiles facing civs with opinion < −25 or at war;
- customs posts where roads cross borders;
- occupied settlements' land (war.geo.occupied) hatched diagonally in the occupier's colour;
- active war fronts as pulsing red segments of the shared border between belligerents;
- vassal borders lighter.
Religion: shrines and temples coloured by faith, a holy-city halo (holyCityId), animated pilgrim dots along trade routes toward the holy city.
Disease: dotted quarantine rings around infected towns, carts at L4.
Trade: goods icons riding the routes, by origin resource.
Tech: era iconography on town icons.

**Implementation:** - renderer.js: new _drawAdmin(ctx, z, prof), drawn after _drawBorders when prof.region is political, religion or disease.
- territory.js: a sub-border trace on ownerSettle via traceEdges, cached by versions.owner and time-sliced like _borderSteps.
- Fort sites: border tiles nearest to hostile neighbours, picked once per owner version (≤ 3 per civ pair).
- Occupied territory: read war.geo.occupied for active wars, plus the owner grid.
- Pilgrim dots move along cached route paths whose destination is the holy city.
- No sim changes.
- Performance: sub-border path rebuild ≈ the border job (time-sliced); drawing is one dotted stroke.

**Risk:** Dense county lines at regional zoom; gate them at z ≥ 16 and fade them in. Some war.geo fields are internal to war.js; read defensively.

### visual:sky-light-night — Sky and light: cloud shadows, rain and snow, seasonal sun, optional night (P4, M)

**Value:** Close zoom feels like weather passing over real land:
- cloud shadows gliding across fields, rain veils under storms, snow squalls;
- long blue winter shadows at high latitudes and warm summer light.
An optional night view lights the cities — torches in early ages, electric constellations in modern ones — with blinking lighthouses, glowing lava and auroras.

Close-zoom weather:
- the cloud deck currently vanishes at z 10.5. Keep the shadow canvas at close zoom (alpha 0.12–0.18), offset by a season-dependent sun azimuth and moving with the wind;
- at z ≥ 40, occasional cloud wisps where cloud > 0.8, drawn in screen space with parallax (1.3× pan speed) to suggest altitude;
- precipitation streaks or flakes in screen space over visible tiles with rain > 0.5 (snow where temp < 0);
- lightning strikes get a ground flash and a scorch.
Seasonal light: each terrain row's colour is multiplied by a light colour from solar elevation (latitude, season, axialTilt) — dimmer and bluer in polar winter, warm in summer.
Night (toggle in the map dock, purely cosmetic): a dark-blue multiply overlay with an optional terminator sweeping once every ~120 s of real time.
- Light sources: popDensity lamps (sparse orange torches before era 6; dense white or sodium light along roads after);
- fires and lava glow; lighthouses (wonder or great harbour) blink; aurora bands at polar latitudes in winter.

**Implementation:** - clouds.js: drawShadows(ctx, r) for z > 10 (reuses this.shade, already composited); drawPrecip(ctx, r, now) reading f.rain, f.snow and f.temp over the visible tiles, ≤ 600 streaks.
- terrain.js prepassRow: a per-row light tint (cheap, once per row).
- renderer.js: a night pass after the terrain/territory wash — fill multiply rgba(10,16,40,0.65), then 'lighter' blits of a cached lamp canvas built from popDensity (1 px per tile, blurred, rebuilt on settlements version or yearly), plus point lights.
- ui/mapdock.js: overlay toggle 'night'.
- Respect prefers-reduced-motion (no terminator sweep).
- No sim changes.
- Performance: lamp canvas 256×160, rebuilt rarely; night pass ≈ 0.5 ms.

**Risk:** The night overlay hurts legibility; keep it an opt-in toggle and keep labels drawn above it with halos. Parallax wisps could confuse picking; they are drawn non-interactive.

### visual:relief-mountains — Mountains up close: slope hachures, ridges, cliffs, glaciers, named peaks (P4, M)

**Value:** Ranges read like an engraved alpine map:
- ridge lines and cliff bands, scree fans;
- glaciers tonguing down valleys and retreating as the world warms;
- tarns in cirques; named summits with heights ('Mount Fana 5,812 m').

Hachures: replace the floating hill arcs with Swiss-style hachure strokes aligned to the elevation gradient, density ∝ slope and length ∝ relief.
Terrain features from elevation:
- ridge skeleton from local maxima across the gradient (computed once per terrain version) drawn as fine ink crests;
- cliffs where slope exceeds a threshold, as tick bands;
- scree fans at slope feet in alpine biomes;
- glaciers where snow > 0.8 and elevation > 0.78, as tongues following flowDir with crevasse marks — retreating visibly when snow drops;
- tarns in local depressions near peaks.
Named peaks: the top N local maxima get names from world.lang (via gen) and a spot height via elevationMeters, labelled from z ≥ 20.
Volcanoes up close: crater rim, lava channel glow while erupting, fumarole steam when activity > 0.45.

**Implementation:** - lod.js painters 'hachures', 'ridges', 'glaciers' (detail.js hachure code moves here and reorients).
- vectors.js: ridgeSkeleton(world) cached by versions.terrain.
- gen/features.js: add kind 'peak' {name, x, y, elevM} (top 2% of land local maxima, ≤ 60), created at generation.
- renderer.js _featureCand: a 'peak' case with minZ 20.
- Old saves without peaks: the renderer derives unnamed spot heights.
- Performance: baked; ridge extraction O(N) on terrain version change (≈ 2 ms).

**Risk:** Adding features changes world.features for new worlds only, so determinism is preserved per version. Hachure density must stay subtle under labels.

### visual:minor-gazetteer — Gazetteer of minor places that appear as you zoom (P4, S)

**Value:** Every zoom step reveals new names — the Cape of Storms, Ulmar Strait, the Fords of Kesh, the Vale of Oud, Thorn Spring — so the world feels endlessly charted. The names match where the chronicle's battles were fought.

Generated at world creation:
- capes (convex coast tips), bays and gulfs below today's sea threshold, straits (narrow water between landmasses), islets, notable hills, valleys (long low corridors between ranges), springs and oases (desert tiles touching a river or lake).
Each gets a minimum zoom (bay 6, strait 8, cape 12, islet 14, valley 16, hill 24, spring 30).
Dynamic names from the roads × rivers × ranges graph:
- fords, bridges and passes named with the same vocabulary war.js uses for battle sites ('the Fords of X', 'the Pass of Y'), so a battle marker sits on its named ford.
Clicking any place label opens a 'place' card listing chronicle entries within 2 tiles (entries carry x and y).

**Implementation:** - gen/features.js: new kinds with fields {minZ, minor: true}, about 150 extra entries, JSON. Names via world.lang and a fork of world.rng ('features-minor') so existing features are unchanged.
- renderer.js _featureCand: cases for the new kinds with gating by f.minZ; small italic for water and small caps for land.
- Shared naming helper as in roads-bridges-passes.
- inspector.js: a place card; renderer hits for labels (Labeler records placed rects with feature ids).
- Performance: generation O(N) ≈ 5 ms; labels go through the existing greedy placer.

**Risk:** Label clutter; placement priority below towns, and minZ gates. Changing the world.features array for new worlds is fine; old saves simply lack minor names.

### visual:city-portrait — City portrait in the Inspector, with a Visit button (P4, S)

**Value:** Selecting a town shows a little engraved portrait of it — its walls, cathedral, harbour ships and named wonders — before you even zoom. A Visit button flies you there. Towns become characters rather than rows of numbers.

In the settlement card, render a 280×180 portrait of the city plan at Town level (L4) with small landmark captions: temple name, wonders, 'Old Walls (Year 412)'.
- Shows the decline ghost (abandoned quarters), siege ring and current construction project.
- A 'Visit' button calls focusOn(s.x, s.y, 96).
- Hovering a landmark caption highlights it.

**Implementation:** - renderer.js: export renderPortrait(world, sid, canvas, opts), using cityplan.buildPlan and paintPlan with its own small sprite cache, so it doesn't evict map sprites.
- ui/inspector.js: a canvas in the settlement section, refreshed when the plan cache key changes (≤ 1 per second).
- No sim changes.

**Risk:** Low; depends on the plan generator.

### visual:event-vignettes — Close-zoom event vignettes (P5, S)

**Value:** When something happens to the town you're looking at, you see it happen:
- banners change on the towers when it falls; settlers' wagons roll in to found a new town;
- roofs burn in a rebellion; plague carts move through grey streets;
- fireworks greet a finished wonder.

At z ≥ 24, effects anchor to plan geometry instead of generic rings:
- capture: towers' flags swap colour, smoke from the breach;
- founding: a 3-wagon train arrives from the mother city's direction (parent settlement x and y);
- rebellion: burning roofs and crowd dots in the market square;
- plague: desaturated blocks and carts;
- famine: an empty granary and grey fields;
- discovery: a glint on the newly built building;
- wonder: fireworks (era ≥ 5) or golden rays.
Scaffolding and cranes for s.project come from the city plan.

**Implementation:** - fx.js drawOne: if z ≥ 24 and the effect matches a settlement within 0.6 tiles, call vignette(fx, plan anchors) from cityplan.js.
- Founding direction: the settlement's parent is not stored. Use the nearest same-civ older settlement, or record s.flags.from in civ expansion (a tiny JSON addition).
- Performance: bounded by the existing fx caps (MAX_ACTIVE 160).

**Risk:** Effects are brief (about 2–4 s) and may be missed at high speed; that's fine as cosmetic delight.

## Lens: stats

The simulation already tracks a lot more than the UI shows. Each yearly record in world.history.years has 44 keys, including war battles and casualties, plague deaths, the number of chronicle events by category, trade routes, wealth, drought, aerosol, devastation and pollution. A 10-year border snapshot goes into history.atlas. Entities keep their peaks: settlement.peakPopulation, civ.peakTerritory, religion.peakFollowers, plague.peakInfected, tradeRoute.peakValue and storm.peak. The disaster, weather, ecology, war, civ and trade systems keep lifetime counters in world.sys.*. In seed "audit" at Year 1000 these counters held 2,973 quakes, 6,889 cyclones with 17k deaths, 8,462 battles, 467 captures and 53 colonies. The chronicle prose is excellent. The Inspector's Binder updates views in place, and the Statistics tab has 10 well-made charts with a shared crosshair. Measured in Node, stats costs 2.0 ms per simulated year against a 5 ms budget, and saves stay bounded: 18.2 MB of JSON at Y1000, of which fields are 11.3 MB and history 3.8 MB. So the base is there for much deeper statistics.

The weak point is time and granularity. Below world level, history is almost entirely a snapshot of now. A nation gets 5 numbers per year, and only while it is among the 48 itemised. A settlement has no time series and no record of who owned it, only its peak and its last conquest flag. An army has no record of its service. A war keeps only its last 6 battles once it ends, even when it had 371. Past rulers lose their deeds when archived. Storms vanish, and quakes exist only as counters, so "the strongest quake ever" or "the deadliest storm" cannot be answered. Several kinds of record exist but cannot be reached from the UI:
- past plagues
- volcanoes, which are not pickable on the map
- trade routes, which have no view at all
- figures, wonders, fires and dynasties

Much that is computed is never shown: plague reach and worst-hit town, faith peaks and schisms, volcano eruption counts, storm category, landfalls and track, war peace terms, every world counter, and about 22 of the 44 yearly fields. Some of what is shown is wrong or raw. Civ "Strength" is always 0. The "Other records" section dumps internals like "Flag: last settler −1000000000". Infectivity of 2.8 is shown as "280%". There are also no superlatives, leaderboards, regional or continent level, comparisons or timelines, which would make each run feel distinct and easy to retell.

The proposals below build one shared layer first: a bounded whole-life ledger for every entity, plus entity references in chronicle entries. On top of that come the Hall of Records, war ledgers with theatre maps, biographies, a Histomap stream of empires, continent and biome ledgers, a catastrophe catalogue, century digests and statistical map modes. All of it is O(entities) in the sim, adds about 1–2 MB uncompressed to a Y1000 save, and makes no rng calls.

### Gaps
- Immortal generals (bug): generals recruited in src/sim/geo/war.js (recruitGeneral → addFigure, ~line 227) are never added to civ.flags.figs. src/sim/civ/culture.js figuresMonthly (lines 35-41) ages and kills only figures in that list. Seed 'audit' save at Y1000: 94 'living' generals, 72 of them older than 80; the oldest is 668 years (Sistisa the Fox of the long-fallen Chiefdom of Miassiaviast). 17 of the over-80s belong to living realms, and recruitGeneral reuses any idle general with died==null, so centuries-old commanders can lead armies.
- civ.military.strength is never written anywhere in src/sim, so the Inspector's Armed forces › Strength always shows 0. Screenshot shots/07-civ-mid.png shows 'Strength 0' beside '3 armies · 3,335 soldiers'; every living civ in the save has military.strength 0.
- Past rulers lose their deeds: src/sim/civ/rulers.js archiveRuler (lines ~126-131) copies name/title/epithet/regnal/dynasty/born/reign/cause/traits but not the deeds counters (conquests, losses, techs, built, wonders, famines, colonies, reforms, golden). Only the reigning dynasty is kept (civ.flags.dynasty = {name, since, rulers}), so past dynasties are unrecoverable.
- War ledgers are truncated: war.geo.log is capped at 16 while a war runs (war.js:1039) and cut to 6 when it ends (war.js:1702), but wars reach 371 battles (the Tebanekan–Kiurrirkene Raids, shots/10-war.png). war.geo.terms (ceded/returned/tribute/vassal), war.geo.endReason and goalSid are computed but never shown. The War Inspector lists only 'Captured', which counts towns later handed back.
- Records with no UI entry point: past plagues (the only plagueView link is a settlement's current outbreak, inspector.js:342); volcanoes (render/entities.js hit-tests only settlements, armies and storms; volcanoView is reachable only via ?select=volcano); trade routes (no view at all, despite traffic, peakValue, name, endDay and cause; 1,847 routes in the save); great figures (figureRow is not clickable); wonders; world.fires; dynasties.
- Computed but never shown: plague peakInfected, hit (142 towns), civsHit (11 nations), worst, cause, symptom, strainOf; religion peakFollowers, nations, reach, deity, doctrine, child schisms; volcano kind, setting, island, eruptions, lastVEI, temper; storm category, peak, landfalls, deaths, damaged towns, track (shots/21-storm.png shows only intensity, reach, age, position). Also all of world.sys.disasters.counts, weather.counts, ecology.counts (e.g. biggestFire), sys.war (230 declared, 8,462 battles, 467 captures, 26 razed, 113 capitulations), sys.civ.counters, sys.trade and sys.disease totals; sys.civ.firstTech and eraReached.
- About 22 of the 44 fields in each history.years record are never charted: battles, casualties, pdeaths, ev (chronicle events per category), newCivs, fell, newWars, newPlagues, routes, wealth, armies, storms, fires, drought, aer, tOff, dev, poll, soil, rain, roads, temp/ice (src/sim/stats.js buildYearRecord vs src/ui/statistics.js).
- 'Other records' dumps raw internals to players (inspector.js otherRecords; shots/20-city-other-records.png): 'Flag: last settler −1000000000', 'Flag: conquered day 101631' (a day count, not a year), 'Flag: emig 0.40101365844258174', 'Growth −0.000', 'Flag: brev 7', 'Flag: no sea day 180490'.
- Chronicle entries carry no entity reference, only civId/sid/x/y (core/chronicle.js). The plague, faith and volcano histories in inspector.js filter by text.includes(name), which mis-attributes entries for 'the Return of …' strains and similarly named schisms.
- No settlement history: the settlement view has only peakPopulation, and the owner chain (founded by → conquered → seceded → reconquered) is lost because flags keep only the last conqueredDay/seceded. civ.flags.popHist keeps only 12 samples.
- The nation sparkline and stacked population chart drop to 0 whenever a nation falls outside the 48 itemised per year (stats.js RECORD_CIVS; the inspector civ sparkline maps NaN → 0), showing false collapses in fragmented worlds.
- Transient entities vanish: storms are removed at dissipation, and their track, deaths and landfalls survive only as chronicle prose. Quakes are counters only. The War Inspector can name 'the deadliest war' (73,746 dead), but nothing can name the strongest quake, deadliest storm or bloodiest battle.
- Figure eviction ignores importance: entities.addFigure splices the oldest figures once there are more than 1,500. Generals are 991 of 1,096 figures by Y1000, so longer runs will evict early prophets (still referenced by religion.prophetId) and scholars before deedless generals.
- Selecting a war, faith or plague collapses to a one-tile highlight (ui/app.js rendererSelection). No footprint is drawn: no battle sites, captured towns, faith reach, infected towns or storm track (the storm in shots/21-storm.png has 11 recorded track points; none are drawn).
- Charts are hover-only (ui/charts.js): no event annotations, no click-to-time-travel, no range zoom or log scale. The Statistics tile 'largest 17,587' does not name or link the city. Plague 'Infectivity 280%' presents an R-like multiplier as a percentage (shots/14-plague.png).
- Performance note: the headless Y1000 run measured 214.8 ms per simulated year (civ 54.3, weather 53.2, ecology 38.4), against the 150 ms budget. The load average was about 13 on 8 cores from parallel agents, so re-measure on an idle machine. Stats itself was 2.0 ms/yr against a 5 ms budget.
- Save composition at Y1000 (seed 'audit', medium): 18.23 MB JSON. Fields 11.35 MB; history 3.84 MB (atlas 3.01 MB for 100 plates, years 0.82 MB at 823 B per record); chronicle 0.95 MB (4,547 entries); tradeRoutes 0.62 MB, of which 1,493 inactive routes are 0.47 MB; wars 0.28 MB; figures 0.19 MB.
- Minor: the HUD population (monthly summary, 532.3k) and the Statistics tile (last yearly record, 533.4k) disagree at the same moment. The Atlas 'latest plate' reads Year 690 when opened at the exact turn of Year 700.

### stats:surface-the-record — Surface what the simulation already knows (and fix what is shown wrong) (P1, M)

**Value:** This is the fastest way to add depth: dozens of numbers the sim already computes become visible. Examples: the plague that struck 11 nations and 142 towns and was worst in Vathke; the faith that once held 194k souls; the volcano's 3rd eruption; a category 4 cyclone's 3 landfalls; a war's peace terms. A World Ledger of lifetime totals also appears: 2,973 quakes, 8,462 battles, 26 cities razed. Players stop seeing developer flags and an always-zero Strength.

One pass over every Inspector view and the Statistics tab. It shows existing fields, humanises the raw 'Other records' dump, and fixes two correctness bugs (always-zero military strength; immortal generals). It also charts the yearly-record fields that are recorded but never drawn.

**Implementation:** src/ui/inspector.js:
- plagueView: cells for Peak sick (p.peakInfected), Towns struck (p.hit) and Nations struck (p.civsHit as civRef links); 'Worst hit: <town> lost X%' from p.worst; cause in prose (crowd, contact, livestock, divine); symptom. Link to the parent via strainOf, and list later strains (plagues with strainOf === p.id). Show infectivity as 'R ≈ 2.8' plus a word scale instead of a percentage.
- religionView: peak followers (add peakDay where religion.js:441 sets peakFollowers), nations, reach word, deity, doctrine, schisms (religions with parentId === r.id) as links. Prophet links to the figure via prophetId.
- volcanoView: kind, setting, island, eruptions, lastVEI, temper.
- stormView: category and peak category (catOf from nature/storms.js), landfalls, deaths, towns struck (st.damaged as links).
- warView: battle list from war.geo.log (name, year, winner swatch, dead; click focuses x,y). Peace terms from war.geo.terms (ceded and returned towns as links, tribute, vassalage), endReason, goal town (goalSid), a world-war tag.
- civView: allies and vassals as links (vassals = civs with vassalOf === c.id); flags.conquests and losses; figureCounts; 'government since' from flags.govSince; a tech timeline grouped by era with the year learned (civ.tech.known values are days).
- settlementView: replace raw flags with a humanised 'Story' list: founded by; conquered in Year X (flags.conqueredDay); seceded (flags.seceded); former capital (flags.wasCapital); highest rank (flags.maxTier); taxes per month; growth % per year; emigrants; food imported. Raw dump only behind a prefs.js 'developer records' toggle.
- Statistics (src/ui/statistics.js): a 'World ledger' grid of stat tiles from sys.disasters.counts, sys.weather.counts, sys.ecology.counts, sys.war, sys.civ.counters, sys.trade (created/broken), sys.disease (outbreaks, deaths), sys.religion (founded, schisms), sys.civ.firstTech. New charts from fields already recorded: 'Toll of the years' (casualties and pdeaths as stacked bars); 'Pulse of history' (ev by chronicle category, stacked); 'Trade and wealth' (routes, wealth); 'Scars' (dev, poll); drought and aerosol. The largest-city tile names and links the city.
- Fix A: write civ.military.strength in src/sim/civ/civmonth.js as Σ strength of the civ's armies, or derive it in the Inspector and drop the row.
- Fix B: in war.js recruitGeneral, push the new figure id into civ.flags.figs so culture.js figuresMonthly ages it; mark generals dead on civDestroyed; add an age < 70 filter to reuse.
- Perf: UI-only apart from the fixes, refreshed at most 4×/s through the Binder.

**Risk:** Low. The generals fix changes the history a given seed produces; it stays deterministic, but balance numbers shift slightly. Keep raw records available for debugging behind the toggle.

### stats:entity-ledgers — Entity ledgers: whole-life time series for every city, nation, faith, war, army and plague (P1, L)

**Value:** Every record gains a story you can see: a city's rise, sack and recovery; a nation's golden century and slow decline; a faith's spread; a war's swing of fortune; an army melting away on a winter march. Each Inspector view gets a small multi-line chart with a readout, and the city gains a 'chain of title' listing every realm that held it.

A bounded store of time series per entity. It uses doubling-step decimation: each series keeps at most K=48 samples per channel, and whenever it overflows, adjacent pairs are merged and the step doubles. So a series covers the entity's whole life at a resolution of life/48, and memory is bounded by the number of entities, never by age. Settlements also keep an owner chain.

**Implementation:** New src/sim/ledger.js, owned by the stats owner and run from the stats system (order 100) so it sees each finished day.
- Exports: push(ser, day, vals), series(world, kind, id), ownerChain(world, sid).
- Storage: world.history.series = { s:{}, c:{}, r:{}, w:{}, a:{}, p:{} }. Each Ser = { t0 (day), st (days per sample), ch (channel count), v: [[ints]…], last }, plain JSON with rounded ints. Decimation averages pairs, or takes the max for peak or toll channels.
- Cadence and channels:
  - Settlements, yearly: pop, wealth, tradeIncome, health%, happiness%, unrest%, defense, culture.
  - Civs, yearly: pop, territory, towns, treasury, stability%, manpower, era, field-army strength, active wars, prestige.
  - Religions, yearly: followers, towns, nations, fervor%.
  - Wars, monthly: warScore, Σcasualties attackers, Σcasualties defenders, occupied towns, armies per side.
  - Plagues, monthly: infected, towns, deaths.
  - Armies, every 10 days: strength, morale%, supply%, x×10, y×10.
- Owner chain: s.flags.own = [[day, civId, causeCode]] (cap 16), appended from the settlementCreated, settlementTransferred and settlementDestroyed hooks (core/hooks.js).
- Retention: dead entities freeze. Dead settlements with peakPopulation < 1,500 and no conquest drop their series 100 years after death. Army series move into the war ledger on disband.
- UI: generalise ui/charts.js drawSparkline into a MiniChart (several channels, year axis, hover readout) used by every Inspector view. Switch the civ sparkline from history.years to the ledger, which fixes the top-48 dropout.
- Measured with the Y1000 save: 279 settlements × 4 channels = 154 KB JSON, 0.02 ms per year to sample. Estimate for all kinds: 0.5–0.9 MB uncompressed at Y1000, under 0.2 ms per simulated year.
- Deterministic: read-only on sim state, no rng.

**Risk:** Save growth needs watching on vast maps with thousands of short-lived hamlets; the retention rule handles it. Old saves without series must render empty charts gracefully.

### stats:chronicle-refs-almanac — Every record reachable: entity references in the Chronicle and an Almanac index (P1, M)

**Value:** Click any chronicle line about a plague, war, faith, volcano, storm, hero or trade road and open its full record. Browse an Almanac of everything that ever existed: every war, plague, faith, eruption, named storm, great person, wonder, trade road, dynasty, fallen nation and ruined city, sortable and searchable. Past plagues and volcanoes become reachable for the first time.

Chronicle entries get a typed entity reference, which fixes the fragile text-matching histories. New Inspector views are added for trade routes, figures, wonders and fires, plus an Almanac index panel. Volcano glyphs and named roads become clickable.

**Implementation:** - Kernel src/core/chronicle.js: entry gains ref: e.ref ?? null ({k: 'war'|'plague'|'religion'|'volcano'|'storm'|'figure'|'route'|'wonder'|'fire'|'battle', id}). About 20 bytes × 6,000 entries ≈ 120 KB.
- Writers pass refs: war.js (war id); disease.js (plague id); religion.js (religion id); nature/volcanoes.js (volcano id); nature/storms.js finishStorm (archived storm id, see catastrophe-catalogue); civ/culture.js and war.js (figure id); trade.js named routes (route id); civ wonders (wonder id).
- ui/toasts.js focusEntry prefers ref. Inspector histories filter by ref, falling back to text for old saves.
- New views in inspector.js:
  - route: path highlighted on the map, value and traffic, goods, both ends, established and ended with cause.
  - figure: see lives-and-lineages.
  - wonder: builder, ruler, city, destroyedDay.
  - fire: area burned, cause, towns touched.
- New tab 'annals' in ui/app.js TABS and ui/panel.js. Almanac sections: lists with search, sort (date, size, deaths, duration) and filters (living/ended).
- Renderer: render/entities.js pushes hits for volcano glyphs (pri 1.5) and for named routes (nearest polyline segment within 6 px, pri 0.5); renderer.pickEntity returns {kind:'volcano'|'route'}.
- ui/app.js selectionPoint learns 'route', 'figure' and 'wonder'.

**Risk:** This touches the kernel (chronicle.js) and several owners' files, but only to add one optional field; it degrades gracefully when refs are absent.

### stats:hall-of-records — Hall of Records: superlatives, leaderboards and record-breaking moments (P1, M)

**Value:** Every run produces its own legends: the largest city ever (Cailyi, 49,970), the greatest empire by peak land (the Tebanekan Empire, 5,452 tiles), the deadliest war (73,746 dead), the longest (9.4 years), the eternal rivals (realms 2 and 3 fought 14 wars), the bloodiest battle, the strongest quake, the deadliest storm, the most-conquered city, the longest dynasty and reign, the richest trade road. When a record falls, the Chronicle and a toast say so, which gives each run new, varied headline events.

A records module that combines two sources. Some records are scanned from existing data at view time or yearly. Others are captured when the event happens, for things that otherwise vanish. Each record keeps its top-5 holders and its history of being broken.

**Implementation:** New src/sim/records.js, run from stats at order 100.
- Storage: world.sys.stats.records = { key: { top: [{v, day, label, ref, x, y}] (5), broken: [[day, v, label]] (cap 8) } }. About 40 keys × 5 × 80 B ≈ 16 KB.
- Event-time: export noteRecord(world, key, v, meta), imported with a guarded top-level await by:
  - war.js battle(): dead, total engaged; createArmy: host size.
  - nature/quakes.js: magnitude, deaths.
  - nature/volcanoes.js: VEI, deaths.
  - nature/storms.js finishStorm: deaths, peak category.
  - nature/fire.js: tiles burned.
  - nature/meteors.js; civ settlement famine deaths; disease.js endPlague (deaths, nations).
- Yearly scan, O(entities) and under 0.1 ms:
  - settlement.peakPopulation; civ.peakTerritory and peakPopulation; nation lifespan.
  - longest reign (rulerHistory) and dynasty (from lives-and-lineages).
  - religion.peakFollowers; route traffic and peakValue.
  - most-conquered city (owner chain from entity-ledgers); the pair of realms with the most wars.
  - most cities razed by a realm; longest war; deadliest war and plague.
- When a holder is displaced after Year 100 by a clear margin (rate-limited to once per key per 25 years), write chronicle({cat, imp: 3, ref, text from a small template pool}). The template is picked by a deterministic index such as day % n, not by rng, so history does not change.
- UI: a 'Records' view in the annals tab. Card grid grouped as War · Realms · Cities · Faith and Plague · Nature's Fury · Trade. Each card shows holder, value, year, runners-up and a sparkline of record-breaking; clicking opens the Inspector and focuses the map.

**Risk:** Record-broken chronicle lines can spam early in history; mitigate with a minimum year, margins and per-key cooldowns.

### stats:war-ledger-theatre — War ledgers and theatre maps (P2, L)

**Value:** Each war becomes a readable campaign:
- a war-score curve with every battle marked
- casualties per side
- a complete list of battles with victors and dead
- the towns that changed hands, and when
- the armies and generals that fought
- a small theatre map of where the fighting happened
- the record of past wars between the two realms
Selecting the war draws its battlefields and captured towns on the main map.

Keep a complete but compact battle record per war, plus score and casualty series and a log of towns changing hands. Render it as a War Inspector dashboard with a cropped theatre map, and as a selection overlay on the main map.

**Implementation:** src/sim/geo/war.js:
- Replace geo.log (cap 16 while running, 6 at war end) with war.ledger.b: compact tuples [day, x, y, winner, loser, dead, nameKey] for named battles, and skirmishes merged per month as [day, n, dead]. Cap 64, evicting the smallest unnamed.
- war.ledger.t = [[day, sid, from, to, 'cap'|'razed'|'returned']] written in capture, raze and makePeace.
- war.ledger.armies: archived army summaries from army-service-records (cap 12).
- Score and casualty series come from entity-ledgers (monthly).

src/ui/inspector.js warView:
- TimeChart of warScore with battle ticks (charts.js marks), stacked casualty bars per side.
- Battles table (click focuses x,y), 'Changed hands' timeline, Armies list, peace terms.
- Rivalry line, e.g. '14th war between these realms; Varath has won 9', computed from world.wars.

Theatre map:
- Extract drawPlate from ui/atlas.js into ui/plate.js. Crop to the bounding box of battles, participants' capitals and captured towns plus a margin, over the current owner grid or the atlas snapshot nearest startDay.
- Markers: swords sized by log(dead) in the winner's colour, rings on captured towns, X on razed towns.

Renderer:
- app.js rendererSelection passes {kind:'war', id}.
- render/entities.js draws battle glyphs and town rings for the selected war, culled to the view.

Memory: about 235 wars × ~1.5 KB ≈ 0.35 MB at Y1000; wars with fewer than 3 battles keep only a summary. Perf: O(1) per battle.

**Risk:** Several files across war.js (D) and the renderer (E); the ledger format must survive old saves (rebuild from geo.log when the ledger is absent).

### stats:histomap — Histomap: the stream of empires (P2, M)

**Value:** The whole run in one picture: every nation as a coloured stream whose width is its share of humankind. Splinter states branch beside their parents, empires swell and dwindle, eras sweep across the top, and wars and plagues mark the bands. Hover to read it, click to jump the Atlas to that year. It is the most shareable view of a run.

A streamgraph modelled on John Sparks' 1931 Histomap. Stacked bands normalised to 100% of world population (toggle: land), ordered by lineage, labelled at each band's widest point. Era bands, war hatching and epochal-event pins are layered on, and it is linked to Atlas scrubbing.

**Implementation:** - New src/ui/histomap.js, mounted at the top of the Atlas tab with an 'expand' option for a wide panel layout.
- Data: history.years[].civ[id][0] (pop) and [1] (territory), already recorded for the top 48. Smaller nations fill in from entity-ledgers civ series, or fold into 'others'.
- Band order: a DFS over the parentId tree, so breakaways sit beside parents and colour continuity reads as lineage.
- Labels: per band, scan for the x with the greatest thickness and place the name when it fits, using the IM Fell map font.
- Era bands: add sys.civ.eraFirst[era] = {civId, day} in src/sim/civ/tech.js where eraReached is first incremented (a few bytes).
- War bands from world.wars (start/end per participant); plague bands from world.plagues; pins from chronicle imp 5.
- Interaction: pointer hover readout; click → app.emit('atlasGoto', nearest snapshot) and select the nation; drag scrubs.
- Rendering: an offscreen canvas rebuilt when a new yearly record arrives. At most 3,000 x samples × 48 bands is about 150k segment ops, under 10 ms.
- No new sim cost apart from eraFirst.

**Risk:** Readability with 40+ tiny nations: needs an 'others' threshold and label collision handling; colour similarity between neighbouring bands.

### stats:lives-and-lineages — Lives and lineages: biographies for rulers, generals, prophets and dynasties (P2, M)

**Value:** History gets protagonists. Open the life of King Draraiirk the Victorious: 53 years on the throne, 6 cities taken, 2 wonders raised, succeeded by his brother. Follow a general's battle honours. Trace the House of Dree across 4 rulers and 160 years, with each heir's relation spelled out. Records for the longest reign, longest dynasty and most victorious general follow.

Keep the data lost today: deeds of archived rulers, past dynasties, and full deed lists for figures. Fix the immortal-general bug, and make figure eviction fame-aware. Add figure, ruler and dynasty Inspector views linked from everywhere.

**Implementation:** - src/sim/civ/rulers.js:
  - archiveRuler copies r.deeds (9 ints), r.id, r.relation and the predecessor id.
  - New world.sys.civ.dynasties (cap 400): {name, civId, start, end, rulers, founder, last, endCause}, appended when startDynasty replaces civ.flags.dynasty and when a civ falls.
- Figures:
  - Deeds cap 6 → 12.
  - war.js battle() increments fig.wins, losses and battles for the commanding general (army.flags.genId).
  - culture.js adds fig.works for artists and scholars.
- Bug fix (shared with surface-the-record): generals enrolled in civ.flags.figs so they age; marked dead on civDestroyed.
- Kernel src/core/entities.js addFigure: when over 1,500, evict first dead generals with no deeds and fame < 1, then the oldest dead; never the prophet of a living faith (religion.prophetId).
- UI (inspector.js):
  - 'figure' view: kind glyph, title, life span and age, birthplace and nation links, deeds, battles (from war-ledger-theatre), armies led.
  - 'ruler' view {kind:'ruler', civId, idx}: reign, traits, deeds as prose, predecessor and successor links, cause of end.
  - 'dynasty' view: a lineage ladder captioned with relation (son, daughter, brother, usurper, elected), years and epithets.
  - Ruler history rows and figure rows become clickable.
- Memory: about 25 KB of ruler deeds and 20 KB of dynasties at Y1000.

**Risk:** Touches the kernel (addFigure) and civ (C) and geo (D) files. Fame-aware eviction must keep ids stable, since figures are referenced by id.

### stats:army-service-records — Service records for armies: campaign path, strength curve and battle honours (P3, M)

**Value:** An army becomes a character, for example: 'Raised 2,400 strong at Eveeth in Year 699; fought 3 battles and won 2; slew 1,120; lost 640 in battle, 210 to hunger and cold, 90 to camp fever; marched 1,860 km; took Ahahu.' A strength curve shows the winter march, and selecting the army draws its whole campaign path on the map.

Per-army counters split losses by cause (battle, attrition, disease). A decimated position track is kept, plus a summary archived into its war when the army disbands. The army Inspector and the map overlay show them.

**Implementation:** - src/sim/geo/war.js createArmy site (~line 685): army.flags.l = {r0: strength, peak, bat, won, dead, inflicted, attr, sick, dist, caps, sieges}.
- Casualty sources:
  - noteCasualty(world, army, n, src) with src 'battle'|'attrition'|'plague'; the attrition block (~line 915) passes its cause.
  - battle() adds inflicted; capture increments caps.
  - Daily movement adds the step distance to dist.
- Track: an entity-ledgers 'a' series every 10 days (strength, morale, supply, x×10, y×10; K = 48).
- On disband or removeArmy: push the summary {gen, genId, civ, raised, peak, bat, won, dead, inflicted, losses split, fate} into war.ledger.armies (cap 12 per war, largest first), then delete the series.
- UI: inspector.js armyView gets a MiniChart of strength and morale, a 'Service record' paragraph and a general link to the figure.
- Renderer: for the selected army, render/entities.js draws the dotted track polyline and battle marks.
- Perf: O(armies) per day, trivial. Memory: live armies only, plus about 100 B per archived army.

**Risk:** Low; war.js edits are bookkeeping only. Make sure no rng calls are added.

### stats:regional-ledgers — Continents and biomes: regional statistics and a Continent view (P3, M)

**Value:** Statistics at the scale players think in. Each continent shows:
- its peoples and their shares
- its greatest city and dominant faith
- who unified it and when
- its population and forest cover over time
- its wars and disasters
A 'Biomes of the world' chart shows ice ages advancing, deserts creeping and forests falling to farms.

Fold per-landmass and per-biome accumulators into the existing yearly grid survey. Store compact continent and biome series in the yearly record. Add a Continent Inspector view and a biome-share chart.

**Implementation:** src/sim/stats.js surveyGrid accumulates, in the same tile loop:
- per landmass, in a typed Float64Array[lmMax×6] in world.cache: tiles, popDensity, veg, farm, owned, devastation
- per-biome land-tile counts
Measured as standalone passes on the Y1000 save: 0.69 ms per-landmass, 0.91 ms per-biome; fused into the existing loop, about +0.4 ms/yr, within the 5 ms stats budget.

Yearly record adds:
- bio: [17 ints]
- lm: { featureIdx: [pop, towns, owned‰, veg‰, nations] } for named continents (4 in seed 'audit')
About 150 B per year.

Continent view (kind 'continent', id = world.features index):
- Reached from the tile Inspector's continent row (made a link) and by clicking continent labels (render/labels.js hit regions).
- Shows: area and share of land; peoples with share bars; largest cities; dominant faith; era leader; unifications from sys.civ.worldMarks.unified and held; population and forest charts; battles on it (war ledger x,y → landmass); catastrophes on it.

Statistics: 'Biomes of the world' stacked area of land share; per-continent population lines.

**Risk:** Landmass ids change when hydrology reruns after sea-level change; key series by continent feature (anchor tile → landmass at sample time), not by raw landmass id.

### stats:demographics — Who the people are: faith, culture and settlement breakdowns (P3, S)

**Value:** See the makeup of a realm: 62% follow the state faith while a restive 30% keep the old gods; 40% are conquered Kiurrirkene; mostly villages with one great city; 18% urban. World charts show faiths waxing and waning and humanity moving into towns.

On-demand breakdowns computed from live settlements, plus two small yearly-record additions for the world-level history of faiths and urbanisation.

**Implementation:** - UI-only aggregation in src/ui/inspector.js civView, a new 'People' section, O(settlements of the civ):
  - faith shares: Σ s.religion[rid] × pop, plus folk beliefs
  - cultures: originCivId shares with civ swatches, conquered peoples flagged
  - a tier pyramid of counts and population, hamlet → metropolis
  - urbanisation (share in tier ≥ town)
  - median settlement age; coastal share; top 5 cities
- religionView: share bars by nation.
- World Statistics: the same breakdowns at world scale.
- Yearly record (stats.js): rel: {rid: followers} for the top 10 faiths, urb (urbanisation ‰), tiers [6 ints]; about 90 B per year, thinned with the rest.
- New charts: 'Faiths of the world' (stacked, faith colours) and 'Urbanisation'.

**Risk:** Low. Keep the per-refresh aggregation memoised by month to stay cheap at 4 refreshes per second.

### stats:catastrophe-catalogue — Catastrophe catalogue and event map (P3, M)

**Value:** Nature's fury gets a memory:
- every great quake, eruption, cyclone, flood, fire, famine and meteor, listed with magnitude, toll and the towns struck
- storm tracks that can be replayed after the storm is gone
- per-decade frequency charts, where a warming world visibly brews more cyclones
- an event map showing where the earth shook and the sea rose in each century

A capped, structured catalogue of discrete natural events written at event time. It feeds the Hall of Records, an Almanac list, frequency charts and a map overlay synced to the Atlas.

**Implementation:** - Storage: world.history.events (cap 500; when full, evict the lowest score, roughly log(deaths) + magnitude weight, older first). Event: {t, d, x, y, m, dead, n (name), towns: [≤ 4 sids], tr: [storm track ≤ 24 points, decimated from st.track]}.
- Writers:
  - nature/quakes.js (M ≥ 6; tsunamis)
  - nature/volcanoes.js (VEI ≥ 3)
  - nature/storms.js finishStorm (cyclones with landfall or deaths; blizzards and sandstorms that hit towns)
  - nature/floods.js, nature/fire.js (named fires), nature/meteors.js
  - weather.js great droughts; civ settlement famines over a death threshold
  Each writer also calls records.noteRecord.
- UI:
  - Almanac 'Catastrophes' list, sortable.
  - Statistics 'Fury of nature': per-decade bars from the catalogue plus sys.*.counts deltas.
  - Overlay in render/fx-like layer (new renderer overlay 'events'): symbols for events in the Atlas decade or century, storm tracks as lines.
  - Archived storms open the storm view with the track drawn.
- Memory: about 500 × 120 B = 60 KB. Perf: O(1) per event.

**Risk:** Several nature files (owner B) gain one call each. The eviction score must be deterministic (no rng), and the cap must hold with stormRate and disasterRate turned up.

### stats:annals-digest — Annals: century digests and leap reports (P3, M)

**Value:** After 'Leap ahead 100 years' you get the story of the century, not a toast saying '37 major events':
- border plates before and after
- who rose and who fell
- the wars, plagues and catastrophes
- records broken and eras reached
Every century can be re-read in the Annals, and the Chronicle marks each century's turn.

A digest builder that compares two points in history using yearly-record flows, ledgers, records, atlas plates and top chronicle entries. It is shown after leaps and loads, and browsable per century.

**Implementation:** - New src/ui/annals.js digest(world, y0, y1), built from:
  - Σ history.years flows: newCivs, fell, newWars, battles, casualties, pdeaths, newPlagues
  - records broken in range (records.broken)
  - before and after plates (ui/plate.js from atlas snapshots)
  - biggest gainers and losers (entity-ledgers civ series)
  - eras reached (sys.civ.eraFirst)
  - top 8 entries by importance then toll
- main.js leapAhead: replace the statusToast with a digest modal; also offer it on load ('since Year X').
- Annals tab: a century list, each opening its digest.
- Optional sim side in stats.js at y % 100 === 0: a deterministic chronicle imp-3 summary ('The seventh century closed with …') from counter deltas; template index from year, not rng.

**Risk:** The digest must stay readable; cap list lengths and lead with 3 headline facts.

### stats:statistical-map-modes — Statistical map modes: prosperity, unrest, growth, age, allegiance and the scars of history (P3, M)

**Value:** Statistics become geography:
- see where wealth pools and where unrest smoulders before a rebellion
- see which frontier towns are booming and which heartlands are emptying
- find the ancient cores against new colonies, and borderlands that changed hands six times
- a 'Scars of history' heatmap glows where the most blood was shed over the centuries

Five per-settlement map modes built on the renderer's existing categorical region spec, plus a cumulative coarse 'bloodshed' field drawn as a heat overlay.

**Implementation:** - src/render/modes.js adds modes 'prosperity', 'unrest', 'growth', 'age', 'allegiance', 'scars'.
- src/render/renderer.js _territorySpec gets new cases. Each catFn buckets the owning settlement's value into 8 quantised classes; colorFn maps classes to a sequential or diverging ramp (render/palette.js). Inputs: wealth per capita; s.unrest; Δpop over the last two ledger samples (diverging); yearsSince foundedDay; owner-chain length. Cache key: v.owner | v.settlements | month.
- 'scars': ensureField(world, 'bloodshed', Float32Array, (W>>1)×(H>>1)), incremented by:
  - war.js battle dead, siege and razing deaths
  - disease.js deaths at the town tile
  - quakes, volcanoes, storms and meteors deaths
  Optional decay ×0.9995/yr. Drawn like devastation, on a log scale.
- getLegend entries for each new mode.
- Memory: 10,240 floats, about 55 KB base64. Perf: O(1) per event; render cached.

**Risk:** Growth needs ledger data, so without ledgers fall back to peakPopulation ratios. Keep the mode count manageable in the picker (group under 'Statistics').

### stats:compare-nations — Compare: nations side by side and head to head (P4, M)

**Value:** Pit two to four realms against each other: population, land, power, wealth and stability over centuries on shared charts, with their ranks among the living. Their head-to-head record: 14 wars, 9 won by Varath, 23 towns exchanged, 41k dead between them, current treaties and trade.

Multi-select in the Nations ledger and a Compare view with overlaid ledger series, rank badges and a head-to-head ledger.

**Implementation:** - src/ui/nations.js: a checkbox per row (shift-click), a 'Compare (n)' button, and 'Compare with…' on the civ view.
- New src/ui/compare.js:
  - TimeCharts (charts.js) per metric, each series in its nation's colour, from entity-ledgers civ series (fallback: history.years civ arrays).
  - Rank badges among living nations.
  - Head-to-head: world.wars filtered by sides, outcome per side, battles from war ledgers, towns exchanged from owner chains, current rel() opinion, treaties, trade and truce.
- No sim cost. Optional later: monthly opinion samples for at most 64 contacted pairs.

**Risk:** Panel width: use the wide panel layout. Colour clashes between similar civ hues: add dashed styles.

### stats:chart-time-travel — Charts you can touch: annotations, time travel and zoom (P4, S)

**Value:** Every chart becomes a door into history:
- plague years and great wars are marked on the population curve
- click a dip to jump the Atlas and Chronicle to that year
- drag across a century to zoom into it
- flip population to a log scale to see the early tribal centuries
- export the record as CSV

Extend TimeChart with event marks, click-to-travel, range zoom and log scale, and wire it to the Atlas and Chronicle.

**Implementation:** - src/ui/charts.js TimeChart:
  - opts.marks [{y, y2?, color, label}] drawn as ticks or bands
  - pointer click → opts.onPick(year)
  - drag → onRange(y0, y1)
  - opts.log for log scale
- src/ui/statistics.js: custom range state alongside RANGES. Marks from chronicle imp ≥ 4 (as atlas.js drawTimeline already does) and war and plague spans.
- app.emit('timeTravel', y):
  - ui/atlas.js goes to the nearest snapshot
  - ui/chronicle.js scrolls to the first entry of that year (binary search on day)
- CSV export of history.years via the existing ui/saves.js download helper, with graceful fallback.
- UI-only.

**Risk:** Low. Touch devices need a long-press for range select so that tap still shows the readout.

### stats:rankings-movers — Rankings and movers: who is rising, who is falling (P4, S)

**Value:** The world feels alive at a glance:
- the Nations ledger shows trend sparklines and rank changes (▲3) against 50 years ago
- 'Rising' and 'Falling' lists name the boom towns and the crumbling empires
- the Welcome page leads with the top 10 cities of the age

Lightweight leaderboards and momentum derived from the entity ledgers.

**Implementation:** - src/ui/nations.js rows: an inline sparkline canvas (charts.js drawSparkline) from the civ ledger series, plus a rank-delta arrow comparing the current sort key's value now against about 50 years ago (ledger sample interpolation).
- New 'Movers' section: fastest-growing and fastest-shrinking nations and cities (Δ% over 50 years, minimum size threshold).
- src/ui/inspector.js welcomeView: 'Greatest cities' top 10 with rank deltas, and 'Rising' / 'Falling' chips.
- UI-only, O(entities), memoised per yearly record.

**Risk:** Low.

### stats:ages-and-tech-race — Ages of the world and the race for knowledge (P5, S)

**Value:** Watch the race:
- who first learned iron, writing or sailing, and how far behind the rest were
- how many nations lingered in the Stone Age while others built empires
- when each age dawned and who ushered it in
The data already exists (firstTech, the day each tech was learned) but is invisible.

Era-dawn records plus two charts: nations per era over time, and a discovery race across the leading nations.

**Implementation:** - src/sim/civ/tech.js: on the first entry into an era, write sys.civ.eraFirst[era] = {civId, day} (a few bytes; also used by histomap).
- UI (statistics.js):
  - 'Ages' chart: stacked count of living nations per era per year, from history.years[].civ[id][3].
  - 'The race': swimlanes for the top 8 nations, each tech a dot at the year learned (civ.tech.known values are days).
  - 'Firsts' table from sys.civ.firstTech (tech → first civ, linked).
- Civ Inspector: a 'Knowledge timeline' of techs grouped by era with years.

**Risk:** Low; fallen civs' tech.known remains in saves, so the race can include them faded.

## Lens: events

I audited the event families. Method: I recorded the call site of every chronicle entry in five headless runs: seeds atlas, kestrel, umber and vane for 1000 years each, plus an Age-of-Strife setting (aggression 1.8, stability 0.6, 12 tribes) for 800 years. I tallied the 46,805 entries by call site, importance, category, century, settlement and civ. I also drove the single-file build in headless Chrome (seed atlas, 500 years, then 40 real seconds at Faster). Scripts and results are in <scratch> (tally.mjs, analyze.mjs, analyze2.mjs, analysis.txt, analysis2.txt, browse.log, shots/).

**What works.** The game already writes a lot of history, and the prose is excellent and place-specific.
- Volume: 7.6–12.5 entries per year, 3.5–6 per year at importance 2 or higher (imp≥2).
- Variety: entries came from 83–91 of the 138 call sites. Shannon entropy is 4.6–5.0 bits, so about 30 effective event types.
- War is deep: 11 kinds of casus belli, named battles and sieges, suing for peace, calls to arms, world wars.
- Rulers have dynasties, epithets and succession crises.
- Stability produces rebellions, defections, collapses, revolutions and unions.
- Nature adds droughts, wildfires, cyclones, locusts and eruptions.

**Where it falls short.**
1. **The mix is lopsided.** After Year 250, war is 34–62% of imp≥2 entries. Battles alone are 14.5% of all entries. Routine royal deaths are 32–42% of the Nations category's imp≥2 entries. The Notable view in the app shows four "X died; his son took the throne" entries in a row (Years 497–499).
2. **The opening centuries are thin.** Years 0–249, which a new player watches first, get only 0.6–1.3 imp≥2 entries per year. Ruler deaths and weather dominate. Four of five runs waited 82–107 years from Year 0 for the first imp≥4 event.
3. **Cities have no identity.** A town's story is founding, growth, buildings and famine, plus whatever war or disaster passes through. A capital's History is mostly national news, because the civ module's chronicle wrapper tags civ-wide entries with the capital. Pruning removes the importance-1 local history from older parts of long chronicles.
4. **Whole families are missing.** There are no bandits, pirates, mercenaries, steppe hordes or migrating peoples, and no marriages, personal unions, regencies or exiled courts. There are no internal factions, economic crises, urban disasters, crusades, persecutions or pilgrimages. Ecology events are effectively dead.
5. **Many events change nothing.** Exhausted mines, finished buildings, golden-age flourishes and figures with a single deed have no lasting effect. So causal chains stay short: famine → unrest → rebellion, and defeat → dark age, are almost the only ones.
6. **Seeds converge.** World population never fell in 4 of 5 runs (0% largest 50-year drop). Year-1000 outcomes cluster tightly. Late-era events (elections, strongmen, republics) never fire by Year 1000 at default settings, and theocracy is a trap state.

**Room to fix it.** The official headless run (`node tools/headless.mjs --years 800 --seed umber`) measured 104 ms per simulated year: civ 24.3 of its 35 ms budget, geo 13.4 of 30. The chronicle runs at 2.9–6 imp≥2 entries per year against the 2–40 target. The proposals build on one event-deck engine with lasting effects, so every new event changes later odds. On top of it they add event families at each scale that hook into the existing systems:
- town identity and city life
- royal marriages, inheritance and exiles; internal factions
- bandits, pirates, mercenaries and steppe hordes; great migrations
- ruins and their resettlement
- faith events and secret inventions
- world ages and rare world-changing shocks

Two further proposals make this readable and hands-on: Chronicle changes that judge how newsworthy an entry is, so extra variety reads better instead of louder, and a Fate tool for seeing and nudging what may happen next.

### Gaps
- War swamps the Chronicle. After Year 250, war is 34–62% of imp≥2 entries in every run (analysis2.txt). The battle call site src/sim/geo/war.js:1043 alone wrote 6,788 of 46,805 entries (14.5%), mostly at importance 1. Sieges and captures (war.js:1281) wrote another 3,629. In the browser run, all three toasts on screen at once were war news (shots/04-live.png).
- Routine royal successions (src/sim/civ/rulers.js:233/241) are 32–42% of the Nations category's imp≥2 entries in every run. The Chronicle's Notable view shows four 'X died …; his son/niece took the throne' entries back to back for Years 497–499 (shots/01-chronicle.png).
- The early game is thin. Years 0–249 produced only 140–319 imp≥2 entries per run (0.6–1.3 a year). Ruler deaths (25–36%) and climate/nature dominate. Four of five runs waited 82–107 years from Year 0 for the first imp≥4 event (analysis2.txt).
- Ecology events are effectively dead. Fauna dwindling and recovery (ecology.js:571/576) fired once in a single run, across all 4,800 simulated years. Extinction, return and world-herd collapse (586/591/612) never fired. Soil blowing away (ecology.js:601) fired 4 times.
- Many autonomous chronicle sites never fired at default settings over 4,800 simulated years: vassal independence (diplomacy.js:561), tsunami (quakes.js:275), land bridges and coastal drowning (climate.js:456/471/496), ice ages (686/692), greenhouse milestones (735–743), elections and strongman regimes (rulers.js:261/267/284), a crowned claimant (civ/index.js:396) and the idle-war settlement (civ/index.js:421). Runs reach only era 2–3 by Year 1000 (Bronze by about Year 400, Iron by about Year 650–750), so republics, elections and dictatorships never appear in a typical session.
- Theocracy is a trap state. At Year 1000, 15 of 17 living civs (kestrel) and 13 of 16 (vane) are theocracies. In src/sim/civ/government.js a theocracy can only leave via philosophy with religiosity < 0.55, or via printing. rebelGovernment() in stability.js returns the parent's government, so theocracy also spreads through every split.
- Seeds converge at world scale. World population never dropped in 4 of 5 runs (0% largest 50-year drop; 7.9% in vane). At Year 1000 the runs cluster at 11–17 nations, 255–297 towns, 1.7–3.0M people and era 2–3. There is no world-scale shock: plagues are capped at about a third of the world, and there is no systems collapse.
- War generals flood the figures list. Each run created 1,020–1,454 'general' figures but only 46–134 of every other kind combined. The kestrel run hit the kernel's 1,500-figure cap exactly (addFigure in core/entities.js), which evicts the oldest figures, prophets and artists included. Generals recruited in war.js never age: culture.js figuresMonthly ages only civ.flags.figs, and they die only via killGeneral. 'Keemit the Grim' led armies in 11 battles from Year 470 to Year 555 (a name collision is possible, but the epithet makes it likely the same person).
- Settlement history is mixed up with national news. record() in civ/state.js fills sid with the capital for civ-wide entries, and the Inspector's History filters on e.sid. Of Ouyb's 30 History entries in the browser run, about 17 were national: ruler deaths, peace treaties, techs, epithets (browse.log, shots/02-city.png).
- Local history is lost in long runs. Runs write 7.6k–11.6k entries per 1000 years and core/chronicle.js prunes above 6,000, keeping only imp≥2 (or imp≥3) older entries. About half of all entries are importance 1, and these are exactly the town-scale ones: growth, buildings, exhausted deposits, famine endings.
- Many flavour events have no consequence. Deposit exhaustion (settlement.js:619, 656 entries) only lowers yields, with no bust or emigration. Building completions (buildings.js:152, 1,773 entries) are importance-1 notices. Figures perform one deed, then only lend a small bonus. Golden-age flourish texts do not match any mechanic.
- Diplomacy is mostly importance-1 boilerplate. There were 1,189 non-aggression oaths (diplomacy.js:414) and 972 free-trade compacts (423), but no visible incidents leading up to the 2,298 war declarations. Opinion simply drifts until a war is declared.
- Trade has no crisis or actor events. It has only three chronicle sites: first market contact, a route closed by war, and a famous road. trade.js mentions 'banditry' only as a hazard multiplier (line 204). There are no bandits, pirates or trade leagues as actors.
- There are no non-state or stateless actors: no bandits, pirates, mercenary companies, nomad hordes or migrating peoples. Hordes exist only as a government type. All 888–2,175 settlement transfers per run are between states. Migration happens only inside a single civ (routeMigrants, urbanDrift).
- Ruins vanish. 65–114 settlements are destroyed per run (razed, abandoned, lava, sea), but render/entities.js draws ruins for only 60 years, and nothing records, resettles, loots or rediscovers them.
- The treasury-crisis branch is silent: 'could no longer pay its debts' (civmonth.js:186) fired once in 4,800 simulated years. Economic events (debasement, defaults, booms and busts) do not exist.
- Perf headroom, from `node tools/headless.mjs --years 800 --seed umber` run alone: 104.2 ms per simulated year total (civ 24.3/35, geo 13.4/30, disasters 1.0/5, stats 0.9/5), so about 45 ms per year is free. Two balance flags were raised: weather is over its budget (29.0 vs 25 ms/yr), and the largest city is 26.0k at Year 800, below the 30k target (scratch folder/audit-events/headless-umber.txt).

### events:event-engine — Event deck engine with lasting effects and chain heat (P1, L)

**Value:** Gives every town and realm dozens of possible fates. Each event leaves a lasting mark that changes later odds, so the same region reads differently from run to run and stories chain naturally (a fire leads to blame, then persecution, then exile).

A small data-driven engine that every other proposal plugs into. Events are registered in decks by scale: town, realm, pair (two civs), land (continent) and world. A staggered scheduler rolls each subject once per check against the summed weights of its eligible events and fires at most one. Fired events apply timed effect bundles ('fx') that the existing formulas read. Events can also add 'heat' to tags on a subject, and later events' weights read that heat. This is how causal chains emerge without hard-coded scripts: famine heats 'riot', a riot heats 'rebellion', a fire heats 'blame'. Chronicle writes go through the existing record() and chronicle(). Every firing is counted per event id and per century for statistics.

**Implementation:** New owner-neutral folder src/sim/events/: index.js (system { id:'events', order:85 }, after war and before stats), engine.js (registerEvent, scheduler, weighted pick), effects.js (addFx, expire, aggregate), heat.js, data.js, prose.js, plus decks/town.js, realm.js, pair.js, land.js, world.js. Add one line to the LOADERS list in src/systems.js.

Event definition: { id, scale, family, imp, minEra, maxEra, cooldownYears, tags, weight(ctx) → expected firings per check (pure, no allocation), fire(ctx) → applies effects and writes the chronicle }. ctx = { world, s | civ | pair | land, era, mods, day } and always uses world.rng.

Scheduler:
- Town deck: each settlement once a year, on dayOfMonth === s.id % 30 in month s.id % 12.
- Realm deck: on day civ.id % 360.
- Pair deck: yearly for pairs with relation.border > 0, on day (a*7+b) % 360.
- Land deck: yearly per continent feature.
- World deck: midsummer.
Each check draws exactly one roll, rng.next() < min(0.5, Σw), plus one pick only if it fires. RNG consumption therefore does not depend on how many events exist, which keeps save→load→continue identical.

Effects: s.fx and civ.fx are JSON arrays of { k, until (day, or -1 for permanent), src (chronicle seq), m: { happiness, unrest, health, foodYield, trade, defense, culture, birth, research, military, stability, … } }.
- Civ effects: in computeMods (src/sim/civ/tech.js), after wonders, add `for (const e of civ.fx || []) applyFx(m, e.m)`, reusing the MUL/SET/additive semantics. Call refreshMods when an fx is added or expires.
- Town effects: the events system aggregates s.fx monthly into s.flags.fxa (8 numbers). settlement.js socialPhase, foodPhase and healthAndEconomy read fxa with defaults of 1 or 0 (about 8 extra multiply-adds per settlement-month).
- Expired effects are pruned monthly.

Heat: world.sys.events.heat = { 'tag:subjectKey': value }, decaying ×0.9 yearly and pruned below 0.05.

State: world.sys.events = { v, cd (cooldown stamps, pruned like civ rl), counts {id: n}, byCentury {c: {id: n}}, heat, budget }. All JSON; the registry itself is code, not state.

Volume governor: per-family imp≥2 counts per decade. When a family exceeds its budget, its weights are halved until the decade ends. This keeps the added volume at or below +3 imp≥2 entries a year, well inside the SPEC §9 limit of 40.

Perf: about 300 towns × 35 definitions, roughly 10k weight calls a year, plus about 200 pairs and 20 realms, comes to an estimated 1–3 ms per simulated year. Measured headroom is about 45 ms.

UI: the Statistics tab gains 'Events by family per century', read from byCentury.

**Risk:** Balance drift if effects stack. Cap every effect key per subject and clamp in computeMods; the existing sanitise step already clamps. Load must not double-apply effects: fxa is a cache rebuilt in init. Structural changes (splits, transfers) must still go through kernel and civ functions such as splitCiv, transferSettlement and createCiv.

### events:news-value-annals — News value, decade annals and cause-and-effect threads (P1, M)

**Value:** The Chronicle stops reading like the same sentence four times in a row. Routine news folds into readable decade summaries, every big event links back to its cause, and each city keeps its own history no matter how long the run.

Four parts.
(a) Novelty-weighted importance. A recurrence counter per (event key, civ) or (event key, region). A routine succession in a realm that had one within 15 years, with no epithet or crisis, drops to importance 1. Unnamed battles below a casualty threshold go to annals instead of the chronicle. Non-aggression and trade compacts go to annals only.
(b) Decade annals. At each decade's end, every civ with 3 or more folded routine items gets one imp-2 summary, e.g. 'In the 490s the Qubars fought two border wars, buried two kings dead of fever, walled Ouyb in stone and lost 1,600 to famine.'
(c) Causal threads. Chronicle entries gain optional `key` (event type), `cause` (the seq of the parent entry) and `tags`. Engine events and existing chains (famine→rebellion, siege→capture→dark age) pass `cause`. The Chronicle can show 'Because: …' and filter to a thread.
(d) Per-entity annals that survive pruning.

**Implementation:** - src/core/chronicle.js (kernel): add optional key/cause/tags to the entry. Backward compatible; old saves have none.
- src/sim/civ/state.js record(): stop defaulting sid to the capital for civ-wide entries (keep x and y). Accept e.cause and e.key; also push [day, key, refId, n] into s.annals or civ.annals (ring buffers capped at 40 and 80).
- New src/sim/events/annals.js: novelty(world, key, subject) → importance delta; decade digest at year % 10 === 0, O(civs), phrase choice via world.rng.
- civ/rulers.js: succession() uses the novelty helper.
- geo/war.js: battle chronicle at line 1043 only for named/great battles; otherwise annals.
- geo/diplomacy.js: the nap/trade notes go to annals.
- ui/chronicle.js: 'Because' link and thread filter.
- ui/inspector.js: an 'Annals' section for settlements and civs read from s.annals/civ.annals (not affected by pruning), and 'Consequences' (entries whose cause is this one).

Volume: roughly −1.5 importance-1 lines per year from battles, −0.5 to −1.3 imp≥2 per year from successions, +≤1 per year from digests. The headless SPEC §9 check stays green.

**Risk:** UI expectations for existing filters ('Selection only' also matches by text). Digests must not re-report entries already shown. A kernel change to chronicle.js needs owner sign-off.

### events:city-character — City character: specialties, earned epithets, founding legends (P1, M)

**Value:** Every town becomes memorable, e.g. 'Ouyb the Unbowed, city of salt and stone walls'. That identity changes its economy and the events it attracts, so two towns in similar places grow into different cities.

- Founding legend, rolled at founding: a founder figure, an omen, or the circumstance (refugees, colonists, a river ford, a holy spring), using placePhrase plus the biome and river.
- 1–2 specialties, assigned on reaching Town tier from the catchment potentials and buildings: salt pans, shipyards, mines, horse fairs, scriptoria, temple city, fortress, market town, fishing port, timber town. Each grants an effect and biases deck weights: a temple city attracts pilgrimages and cults, a market town fairs and guild revolts, a fortress endured sieges, a mine town booms and busts.
- Epithets earned from history counters: 'the Unbowed' (2 sieges held), 'the Twice-Burned' (fires), 'the Weeping' (a plague killing over 25%), 'the Golden' (top 5% of wealth), 'the Holy' (holy city), 'the Faithless' (3 changes of hands). Epithets can be lost when contradicted (an 'Unbowed' city that is captured).
- Inspector header shows epithet, specialties and legend; map labels add the epithet at high zoom.

**Implementation:** - Data: s.traits: string[] (at most 3), s.epithet: string|null, s.legend: { kind, text, figId? }, s.flags.hist { sieges, held, fires, quakes, plagues, conquered, riots }. Defaults added in ensureSettlementFields (civ/state.js; bump SETTLE_FIELDS_V).
- Specialty table in events/data.js: { key, label, test(pot, bv, s), fx, tags }, reading the existing s.flags.pot (wildPot, fishPot, farmCap, timber, ore, lux, strat) and buildingVec (settlement.js BV).
- Triggers: legend on the settlementCreated hook; specialties via a call from settlement.js tierReport when tier ≥ 3; yearly epithet check in decks/town.js.
- Counter feeds through hooks and small calls: siege lifted without capture (geo/war.js, where s.siege is cleared without capture), fire hits (nature/fire.js chronicleFire, ev.hit), quake damage (nature/quakes.js 'worst' list), plague end (geo/disease.js endPlague p.worst), and settlementTransferred (conquered).
- Prose pools in events/prose.js, using the town's language for legend names (core/names.js makeWord).
- Renderer (render owner): label suffix when zoom ≥ 8 px/tile. Inspector: header line plus a Legend row.
- Perf: O(1) per town per year.

**Risk:** Low. Make sure specialty effects do not dominate yields; cap them at ±10–15%.

### events:urban-life-deck — City life: great fires, riots, guild revolts, booms and busts, fairs, quarantines, sieges endured (P1, M)

**Value:** Cities live, burn, riot, get rich and go bust. A plague nearby makes a city shut its gates; a silver strike draws crowds, then leaves a ghost town. Each event changes the town's numbers, not just the text.

Town-deck events with real effects and chains:
- Great Fire. Odds ∝ tier ≥ 3 × crowding (pop/housing) × dry season (low soilWater, summer) × the biome's wood × (1 − masonry/engineering/sanitation protection) × (0.3 if already 'rebuilt in stone'). Kills 1–5%, wealth −20–50%, buildings −30% via damageSettlement. Applies a 'rebuilding' fx (production −10% for 15 years), then a chance of the permanent 'rebuilt in stone' trait (fire odds ×0.3, culture +). Heats 'blame' toward any faith minority.
- Bread riot. Famine ≥ 1 month plus tax > 0.12 or unrest > 0.4. Unrest +0.2 and legitimacy −0.03. The ruler responds by trait: a cruel ruler crushes it (deaths, loyalty −); a generous one lowers taxes. Adds grieve += 12, which feeds the existing rebellionCheck.
- Guild revolt. Needs the guilds tech, a workshop and high taxes. The 'Weavers' Revolt of X' sets s.flags.commune (tax cap); at era ≥ 3 it may secede as a Free City through the existing splitCiv with a merchant/republic government.
- Boom. A strike in the catchment (vein of silver, new salt pans) gives wealth + and an 'attract' fx that multiplies urbanDrift inflow.
- Bust. Hooked to the existing deposit-exhaustion branch in depleteDeposits: wealth −40%, 10–20% emigration via routeMigrants, possible abandonment.
- Great Fair. A town with ≥ 3 routes and a market: trade ×1.2 for 10 years, more merchant-figure births, and disease exposure via expose().
- Quarantine. A plague within 6 tiles and the town has a hospital, a healing faith or medicine: gates close for n months (s.flags.quarantineUntil), incoming plague dose ×0.2, trade fx 0, unrest +.
- Siege endured. Defense +0.3 permanently, loyalty +, a yearly festival (happiness +), and the 'Unbowed' epithet.

**Implementation:** - events/decks/town.js holds the weight and fire functions.
- settlement.js reads s.flags.fxa (happiness, unrest, health, foodYield, production, attract).
- civmonth.js urbanDrift multiplies the score by fxa.attract.
- trade.js routeValue multiplies by each end's fxa.trade.
- disease.js expose(): dose × (s.flags.quarantineUntil > day ? 0.2 : 1).
- Damage through the kernel's damageSettlement; secession through civ/peoples.js splitCiv.
- Rate limits: 15 years per town per family.
- Volume: about 1–1.5 imp≥2 per year across 250 towns.
- Fx types: reuse 'fire', 'famine', 'rebellion'; add 'riot' and 'fair' (renderer, small).
- Perf: inside the engine's 1–3 ms per year.

**Risk:** Double-counting with existing famine and unrest dynamics. Keep riot effects as short shocks that decay through the existing unrest relaxation in socialPhase.

### events:world-ages-black-swans — World ages and black swans: each run gets its own character (P1, M)

**Value:** No two worlds feel alike. One run becomes an Age of Prophets, another a Long Winter and a Storm from the Steppe. Rare world-changing shocks (a collapse of the whole trade web, a great comet, a pandemic when two continents meet) can redraw the map at any time.

World ages:
- At genesis the world rolls 1–2 ages, weighted by params and geography. It re-rolls every 250–500 years, or when state triggers one: an ice age gives 'Long Winter', 3 notable plagues give 'Age of Plagues', a hegemon gives 'Pax'.
- Each age is a bundle of multipliers that existing systems read through one accessor, ageMul(world, key): prophet odds, schism odds, horde spawns, war appetite, trade, disaster rates, emergence, figure births.
- Examples: Age of Prophets, Restless Earth, Age of Plagues, Steppe Storm, Golden Peace, Long Winter, Sea Peoples, Age of Discovery.

Black swans (world deck), each about 0.1–0.4 per 1000 years at fortune 1:
- Systems Collapse: the trade web seizes up, raiders appear, drought strikes, and 3+ civs take a stability shock.
- Great Comet: an omen that raises faith fervour and shakes rulers' legitimacy (±).
- Pandemic of Contact: the first long-lived trade route between continents seeds a plague its victims have never met, lethality ×3.
- Also: Great River Flood, a Messiah figure, and an explicit link to the existing VEI-7 eruption.

The HUD shows the current age next to the date; the Atlas timeline shades the ages.

**Implementation:** - events/ages.js and events/decks/world.js.
- core/params.js (kernel): new param 'fortune' (0–2, default 1, live, group civ, 'How often history lurches') and 'worldAges' (bool, default true).
- Existing systems read ageMul through guarded imports: geo/war.js APPETITE, geo/religion.js prophets and schisms p, geo/disease.js monthly emergence, civ/expansion.js emergence, civ/culture.js figure p, sim/disasters.js rates, geo/trade.js route value.
- State: world.sys.events.ages = [{ key, from, until, why }].
- Systems Collapse does not write splits itself. It sets crisis effects (civ.fx stability −0.25, trade ×0.5 on all routes for 20 years, raider spawns from the non-state-actors proposal), so the existing collapseCheck and rebellionCheck do the structural work.
- Pandemic of Contact: on a new sea route between different continents (trade.js createRoute plus f.landmass), call disease.createPlague with lethality ×3.
- UI: HUD date line plus Atlas bands.
- Perf: yearly O(civs).
- Determinism: all rolls via world.rng, and all state is JSON.

**Risk:** Tuning: at fortune = 1 the headless SPEC §9 balance check must still pass. Black swans need hard rate limits (no two within 200 years).

### events:non-state-actors — Bandits, pirates, mercenary companies and steppe hordes (P1, L)

**Value:** The map gets roaming troublemakers: brigands who cut the Spice Road, pirates who raid coastal towns, mercenaries who turn on unpaid employers and found their own state, and a horde that rides out of the steppe and topples an old kingdom.

A new roaming entity, a 'band', whose kind is bandits, pirates, mercenaries or horde.
- Bandits spawn on owned land with high devastation and low loyalty, after wars (some disbanded soldiers stay armed) and in dark ages.
- Pirates spawn on busy sea lanes where the coastal owners are weak at sea.
- Mercenary companies form from the disbanded armies of rich realms.
- Hordes form from steppe peoples (horde government, or an emergence in steppe).
Bands move along paths, raid towns (food, wealth) and caravans or ships (routes lose value or break), and fight garrisons and armies. Rulers hunt them. Mercenaries are hired by realms at war and paid monthly; unpaid, they turn and may seize a town, founding the 'Free Company of X'. Pirates may found a 'Pirate Kingdom of the X Isles'. A horde that takes a city becomes a new horde-government state.

**Implementation:** - Data: world.bands = [{ id, kind, name, x, y, strength, morale, loot, leader { name, skill, born }, employerCivId, payUntil, homeI, targetSid, path, pathStep, state, createdDay, raids, kills }] via addEntity(world, 'bands', obj, 'band'). The kernel falls back to nextId.misc, so no kernel id change is needed; create the list with world.bands ||= [] in init (it is saved automatically).
- New src/sim/events/bands.js: daily movement O(bands) along findPath routes (pathfinding.js, maxNodes 4000, cached per target). Monthly interactions: settlementsNear(r = 1.5) raid → damageSettlement({ wealth 0.1, food 0.2 }) and garrison fights (strength vs garrison × defense, morale); routes cut when tradeTraffic is high near a bandit tile → route value ×0.5, or breakRoute(r, 'bandits') after 3 raids.
- Mercenaries: on the geo/war.js disband path, a chance to convert into a company. war.js mobilize() hires the nearest company when treasury > cost and registers it as createArmy({ civId, flags: { merc: bandId } }), so the existing battle and siege code fights with it.
- Turning on employers: unpaid → transferSettlement to a new createCiv (or expansion.newPeople) named 'Free Company of {leader}'.
- Hordes: steppe origin, large strength, target the richest sedentary neighbour; a captured city becomes createCiv with government 'horde'.
- War-module change: war.js chooseTarget lets idle armies hunt bands within 12 tiles of home.
- Render (render owner): band glyphs (campfire banner, black sail, company banner, horse-tail standard) and an fx 'raid'. pickEntity covers bands; the Inspector gets a band panel showing strength, leader, loot and towns raided.
- Stats: per-band kills and loot.
- Perf: at most 40 bands, about 1–2 ms per year.

**Risk:** Interplay with war.js: bands are hostile to everyone and must not appear in areAtWar pairs. Also guard against runaway bands (cap total strength relative to world manpower).

### events:dynastic-politics — Royal marriages, personal unions, regencies, pretenders and exiled courts (P1, L)

**Value:** Royal houses intermarry, inherit each other's crowns, squabble over child kings, and return from exile to restore fallen nations. Fallen realms can come back, and a single death can join two kingdoms.

Pair-deck royal marriages between hereditary realms create claims. When a ruler dies without an heir, the existing successionCrisis consults claims. A strong claimant realm may inherit through a personal union (two realms, one ruler) instead of a usurper. After the shared ruler dies, the junior realm merges (transfer, cause union) or breaks away in a 'War of the X Succession', fought by the existing war machinery.

Child heirs get regents (mother, uncle or general). Regencies roll yearly events: the regent usurps (new dynasty), the regency council misrules, or the young ruler is murdered.

When a realm is conquered and an ally or kin survives, its court goes into exile. The host gains a 'restoration' casus belli, and old core towns with low assimilation may revolt to restore the fallen nation under its old name and colour.

**Implementation:** - civ/rulers.js: ruler.spouse { name, fromCivId, dynasty }; ruler.heir { name, age, gender }; civ.claims { civId: 0..1 }, decaying 2% a year; civ.flags.personalUnion { withCivId, since }; civ.flags.regent { name, kind, until }.
- succession(): before successionCrisis, check claims ≥ 0.5 and claimant power ≥ 0.6 × own → personal union (install a copy of the claimant's ruler, link the flags).
- geo/diplomacy.js: personal-union pairs are treated as allied; the war.js declarations loop skips them.
- Exiles: world.sys.events.exiles = [{ name, adjective, language, hue, colorHex, dynasty, ruler, hostCivId, homeSids, since }], written on civDestroyed (conquest, razed or annexation) when an ally or kin is alive.
- geo/war.js casusBelli: add 'restoration' (weight 1.4 against the conqueror) and 'claim' (from marriage claims).
- civ/stability.js: a restoration revolt for core towns (originCivId = the fallen civ, assim < 0.5, unrest > 0.4) calls createCiv({ name, adjective, language }) and transferSettlement('rebellion'), restoring the old name; colour comes from pickCivColor unless an exile hue is free.
- events/decks/pair.js: the marriage event (opinion +15, trust +0.1, claims +0.3).
- Prose with dynasty names from rulers.newDynastyName.
- Volume: marriages imp 1–2 (rate-limited per pair, 40 years), personal unions imp 3, restorations imp 4.
- Perf: pair deck about 200 pairs a year, negligible.

**Risk:** Edge cases around the shared ruler object: store a copy per civ plus a link id, never a shared reference (the state must stay plain JSON). Restorations could undo conquest too often, so gate at 1 per exile, within 150 years.

### events:early-age-deck — Stone and Bronze Age deck: great beasts, domestication, cattle raids, standing stones, shamans (P1, M)

**Value:** The first centuries — the part every new player watches — get their own drama: the last great elk speared, the first horses tamed at one particular village, cattle raids that escalate into feuds, standing stones raised, a shaman's vision that becomes a faith.

- Named great beasts: at genesis, 3–6 named megafauna per continent from biome tables ('the Woolly Ox of the Kesh Steppe', 'the Great Elk', 'the cave lion'), each with a range region. Yearly population follows mean herbivore density over the range minus hunting pressure (popDensity × era ≤ 1). Extinction is an imp-3 chronicle entry with a food-yield penalty for nearby hunter towns; it also revives the dead ecology chronicle family.
- Domestication: the first village with high herbivore density in a horse or cattle biome grants husbandry or horseback early and earns the trait 'horse-tamers'.
- Cattle raids (pair deck, era ≤ 1): loot, grievance +10 (feeding the existing 'revenge' casus belli), or a bride or hostage exchange instead (opinion +).
- Standing stones, a lesser wonder: culture +, legitimacy +, and the trait 'sacred site', which multiplies prophet odds ×1.5.
- Shaman visions found a folk cult that may become a named faith through religion.foundReligion (doctrine 'spirits').
- Hunting-ground feuds, herd migrations and the first boats are also in the deck.
- Target: +1–2 imp≥2 entries a year in Years 0–300 only.

**Implementation:** - events/decks/early.js, plus world.sys.events.beasts = [{ name, kind, continent, biomes, rangeSample:[i…64], pop, extinctDay }] (a sample of tile indices keeps it O(64) a year).
- Reads world.f.herb and popDensity; ecology.js is not changed.
- Tech grants via civ/tech.js grantTech plus the discover() chronicle.
- Faith via a guarded import of geo/religion.js foundReligion(world, s, { doctrine: 'spirits' }).
- Lesser wonders stored as s.traits plus an fx (not world.wonders, so the global wonder count stays the same).
- Fx 'discovery' and 'faith' reused.
- Perf: under 0.3 ms a year.

**Risk:** Must not over-accelerate tech; keep the early grant to 1 tech per world event. Era pacing in SPEC §6.3 should stay within targets.

### events:estates-factions — Estates and factions: nobles, clergy, merchants, army and commons drive reforms, revolts and coups (P2, L)

**Value:** Governments change for visible reasons: a peasant rising after the great plague, barons forcing a charter, a general's coup, a reformation that breaks the priests' hold. It also ends the trap where most realms get stuck as theocracies.

Each civ tracks 5 estates, each with power and mood (0..1). Yearly drivers:
- government type;
- buildings: temples raise clergy, markets and banks raise merchants, barracks and war raise the army;
- plague deaths: the commons' bargaining power rises after heavy losses (labour shortage);
- taxes (commons' mood) and conquests (nobles and army).
Estate power reweights evaluateGovernment and revolutionTarget instead of the fixed weights, and adds an 'estates' term to stability.

Events:
- Peasant Rising: commons mood < 0.25 and power > 0.35, especially within 15 years of a plague killing > 10%.
- Barons' Revolt: leads to feudal fragmentation via splitCiv.
- Investiture crisis between crown and clergy.
- Military coup: army power > 0.45 and stability < 0.35 → depose to dictatorship, or to a junta before era 6.
- Merchants' Charter: leads to a constitutional or merchant government.
- Reformation: low clergy mood plus printing → religion schism.
Theocracy exits scale with noble and merchant power, and rebel states draw their government from their own estates instead of copying the parent.

**Implementation:** - New src/sim/civ/estates.js: civ.estates = { nobles: { p, m }, clergy, merchants, army, commons }, updated in civmonth.js month 0 in O(towns) using buildingVec counts (settlement.js BV: temple, market, bank, barracks, workshop), civ.flags.plagueDeaths (fed from the disease.js endPlague hook through civ.flags) and taxRate.
- government.js: evaluateGovernment and revolutionTarget multiply option weights by estate power (theocracy × clergy.p, kingdom/feudal × nobles.p, merchant/republic × merchants.p, dictatorship × army.p, democracy × commons.p).
- stability.js: rebelGovernment picks by the rebel cluster's estates; updateStability gets parts.estates = −0.1 × the power-weighted unhappiness.
- Event fire functions in events/decks/realm.js use existing depose(), splitCiv() and geo/religion.js schism (exported).
- ui/inspector.js: estate bars. stats.js: estates in the per-civ yearly record.
- Perf: O(towns) yearly, about 0.2 ms.

**Risk:** Reweighting governments changes the balance of existing runs; retune with headless seeds. Keep total revolution frequency near current levels.

### events:migrations-diasporas — Great migrations, refugee diasporas and peoples on the move (P2, L)

**Value:** Whole peoples pack up and move when droughts, ice or hordes push them, displacing others in a chain reaction. Refugees settle in foreign cities as diaspora quarters that trade, clash and sometimes return home.

Migrations:
- Trigger: a homeland stress index from great-drought years in the region, ice advance, desertification, a horde nearby and famine deaths in the last decade.
- A civ with ≤ 6 towns under high stress may migrate: 60–80% of its people form a migrating host, which leaves ruins or near-empty towns and moves toward the best weakly held habitable region.
- On arrival the host settles free land or takes towns by force. A displaced people may become the next migration (cap 2 at a time).

Diasporas:
- Refugees from razing, conquest or persecution partly go to foreign towns, creating s.minorities.
- A minority gives trade networks (trade +5% per 0.1 share) and assimilates slowly.
- It raises persecution or pogrom odds when unrest is high and the faith differs; expulsion feeds more diaspora.
- It may return home when its homeland is restored.

**Implementation:** - The migrating host is a band of kind 'migration' { civId, pop, fromSids, targetI }, reusing bands.js movement.
- Trigger in events/decks/realm.js, reading weather.js regional drought state (world.sys.weather reg great/start), the climate desertification counters and horde distance.
- Leaving: destroySettlement(…, 'abandoned') for emptied towns (ruins appear), or reduce population.
- Arrival: createSettlement(world, civId, x, y, { population }) on free land; or a battle against garrisons with transferSettlement('conquest').
- Diaspora: civ/expansion.js routeMigrants gets an option to target the nearest foreign town at peace. s.minorities = { originCivId: share } (at most 3 keys, JSON) and s.minorityFaith.
- Effects through the engine; persecution events in the faith deck.
- Render: wagon-train glyph for the host.
- Perf: at most 2 hosts plus O(towns) yearly minority decay.

**Risk:** Mass abandonment can crash populations. Cap at 1 migration per 150 years per continent at fortune = 1 and require real, long-lasting stress.

### events:ruins-resettlement — Persistent ruins: memory, resettlement, looting and rediscovery (P2, M)

**Value:** Burned and drowned cities leave lasting ruins on the map. Later peoples resettle them ('New Myuk', 'the Rohans returned to Myuk'), treasure hunters loot them, and scholars of later ages dig up lost libraries.

A ruin record is created whenever a settlement is destroyed. Settlers favour nearby sites (old foundations, cheaper housing) and may take the old name or 'New X'. Kin of the founders get a reclamation flavour. From era ≥ 4, scholars or library towns within 10 tiles may excavate: culture +, sometimes 'lost knowledge' (a tech the fallen civ knew), sometimes an artifact (a lesser wonder). Looting gives wealth and raises bandit heat. Famous ruins stay on the map permanently with a glyph and an Inspector panel: what stood here, who destroyed it, which wonders were lost. The mythic layer can make them haunted.

**Implementation:** - world.ruins = [{ id, name, x, y, i, civId, originCivId, peak, maxTier, fell, cause, wonderIds, resettledBy, looted, excavated, fame }], created on the settlementDestroyed hook (events/ruins.js). Index-as-id via addIndexed after creating the list in init; cap 400, thinning the lowest fame.
- world.cache.ruinGrid (coarse buckets) for lookups.
- civ/expansion.js findSite: +0.15 habitability within 1 tile of an unresettled ruin (guarded import), and the name choice on founding there.
- Excavation and looting events in decks/town.js.
- render/entities.js: ruins with fame ≥ threshold drawn indefinitely (currently only 60 years).
- ui/inspector.js: ruin panel; renderer.pickEntity → { kind: 'ruin' }.
- Perf: O(ruins near the site) during site search, bucketed.

**Risk:** Low. The site-search bonus could cluster settlements on ruins, so keep it small.

### events:figure-lives — Great figures with life stories (and fix the immortal generals filling the roster) (P2, M)

**Value:** Scholars, artists, generals and explorers live full lives with several deeds, rivals, exile and coups. A great general can seize the throne; a heretic scholar can flee abroad carrying knowledge. Cities list their famous people.

Fix first. war.js turns every army leader into a permanent, never-ageing figure (1,020–1,454 per run), which fills the kernel's 1,500 cap and evicts prophets and artists. Instead, keep army leaders as plain objects on the army, promote them to figures only after a great victory or 3 wins, and age them so they retire or die.

Then give the living figures (≤ 60 worldwide) a yearly kind-specific deed deck:
- scholar: treatise (research burst), heresy trial when the clergy is strong (exile to a rival, adding tech diffusion there), patron's favour;
- artist: masterpiece commission (culture, sometimes a lesser wonder such as 'the Painted Hall');
- general: victories, a coup when the army estate is strong and the ruler weak (installRuler), defection when slighted;
- explorer: first contact through diplomacy's meet(), naming a coast;
- merchant: founds a trading house that becomes a trade league between cities, or goes bankrupt;
- hero: defends a town or slays a beast, earning a legend and town epithet.
Rivalries between same-kind figures in neighbouring realms are chronicled.

**Implementation:** - geo/war.js recruitGeneral: return { name, skill, born } stored on army.general; call addFigure only when a battle is 'great' or wins ≥ 3; keep killGeneral for promoted ones.
- Ageing: civ/culture.js figuresMonthly also handles promoted generals (push to civ.flags.figs).
- core/entities.js (kernel): addFigure cap thinning by fame and kind instead of oldest-first. Alternatively, culture.js trims non-famous dead generals before the cap is reached, avoiding a kernel edit.
- events/decks/figures.js: a yearly roll per living figure. Fields: fig.deeds (≤ 6), fig.fame, fig.rivalId, fig.exiledTo.
- ui/inspector.js: figure panel timeline, and 'Born here' on settlements.
- Perf: ≤ 60 rolls a year.

**Risk:** Coups by generals duplicate revolutionCheck. Route them through depose() and count them in st.counters.revolutions to keep balance visible.

### events:faith-events — Faith events: pilgrimages, crusades, persecutions, religious orders, councils, relics (P2, M)

**Value:** Faiths do more than spread and split. Pilgrims enrich holy cities and carry plague, coalitions march to retake a holy city, minorities are expelled and found new towns, and councils reunite or excommunicate.

- Pilgrimage: the holy city gains yearly wealth and a culture fx in proportion to followers, pilgrim roads upgrade along routes, and pilgrims carry disease through expose().
- Crusade: a holy city held by another faith while ≥ 2 civs share the faith → a coalition war ('The First Crusade of X'), with fervour-driven joining.
- Persecution, inquisition or expulsion: a minority faith in a town with high unrest or a cruel or pious ruler → deaths, refugees (diaspora), trade loss.
- Military religious order: a band of kind 'order', or a splinter state.
- Ecumenical council: may reunite a schismatic child with its parent or declare an anathema (fervour ±).
- Relic discovered: legitimacy +, pilgrimages.
- Syncretism between neighbouring faiths that tolerate each other.
- Heresy trials (ties into figure lives).

**Implementation:** - geo/religion.js: yearly hooks call into events/decks/faith.js (guarded), or the deck reads world.religions directly.
- Crusade: startWar(world, attackers[] (kernel supports arrays), [holder], 'holy', name) plus g.cb = 'holy' in war.js geoOf, so the existing war machinery fights it; boostFervor on all participants.
- Persecution uses s.religion shares and the minorities from the migrations proposal.
- Councils manipulate religion.parentId and shares.
- Fx 'faith' reused.
- Volume: ≤ 0.5 imp≥2 a year.
- Perf: yearly O(religions + towns).

**Risk:** Crusade coalitions could create permanent total war; cap at 1 active crusade and use truces.

### events:inventions-secrets — Breakthrough secrets: first-mover inventions that change war and trade, and leak (P2, M)

**Value:** Being first to master a key technology really matters: the first realm with stirrups or gunpowder or open-sea navigation gets a window of dominance until spies, traders or conquest leak the secret, and wars break out over it.

When a civ is the first in the world to learn certain techs (civ state already records firstTech), it holds a secret with an exclusive effect while no one else has it:
- horseback: cavalry, movement and military in open terrain
- iron: military
- shipbuilding: seaRange
- navigation: early open-sea
- engineering: siege
- gunpowder: siege ×2 and enemy walls ×0.5
- printing: research, and stability − from pamphlets
- banking: trade
- medicine: plague resistance
- steam: production
Secrets leak through trade partners (in proportion to relation.trade), captured towns with the relevant building, defectors, and spy events (opinion −, sometimes a casus belli 'theft'). 'The walls fell' events when gunpowder spreads, plus arms-race opinion effects. Because war.js power estimates use getMods, outcomes shift without extra combat code.

**Implementation:** - civ/tech.js: civ.secrets = { techId: { since } }; computeMods applies a SECRET_FX[techId] bundle for each held secret whose leak set is still small (≤ 2 other civs).
- discover(): when first in the world, add the secret.
- events/decks/realm.js: monthly leak rolls per holder over its trade partners, capped at 1 per civ per year.
- geo/war.js capture(): transfers knowledge (a grantTech chance) and records a leak.
- Chronicle family 'secret' at imp 2–3.
- Perf: O(holders × partners) monthly, small.

**Risk:** Snowballing hegemons. Keep effects at +10–20% and let them expire after 60 years even without a leak.

### events:fate-deck-tool — Fate tool: see what might happen to a town or realm, and nudge or invoke it (P2, M)

**Value:** Makes events tactile. Click a city and see 'Great Fire 7% this decade · Bread riot 12% · Fair 4%', then raise the odds or make it happen. Follow a favourite city so its news always reaches you.

A new god tool in the Fate group. Clicking a settlement, realm or border pair opens a card list of the events currently eligible there. Each card shows its odds over the next decade, computed from the deck's weight functions (which have no side effects), and its likely effects.
- 'Nudge' multiplies an event's weight ×5 for 20 years, stored as an fx so it is deterministic and saved.
- 'Invoke' fires it now, chronicled under the 'divine' category (Divine Hand).
A 'Follow' toggle on any entity makes toasts and the digest prefer followed subjects, and adds a 'Followed' chronicle filter.

**Implementation:** - events/tools.js: registerTool({ id: 'fate', group: 'fate', … }) using the engine's eligible(world, subject) → [{ id, label, pDecade, effects }].
- Weight functions are pure, so the preview never touches world.rng.
- ui/fate.js: popover cards near the click (DOM, styles.css tokens); ui/palette.js icon.
- ui/toasts.js: prioritise followed subjects (world.sys.events.follow = [{ kind, id }], saved with the world).
- ui/chronicle.js: 'Followed' chip.

**Risk:** Players may spam invokes. Rate-limit invokes per subject (1 per 5 years) and label them clearly as divine in the chronicle.

### events:economic-cycles — Economic cycles: debasement, inflation, bank defaults, booms and busts, tax revolts (P3, M)

**Value:** Treasuries matter. Broke rulers debase the coin (prices spiral), borrow from merchant houses and default, or squeeze the provinces into tax revolts. Trade booms lift whole nations and crash when wars cut the roads.

The debt branch is effectively silent today: 'could no longer pay its debts' fired once in 4,800 years. Make treasury stress a decision point. When the treasury stays negative for 12 months, the ruler chooses by traits and estates:
- debase the coin: income +20% for 5 years, then inflation (happiness −, trade −) for 10 years;
- borrow from a merchant house: creates a debt record; default angers merchants and raises interest on the next loan;
- raise taxes: raises tax-revolt odds in distant provinces;
- sell offices: legitimacy −.
Trade boom: a civ's total route value up > 50% in 10 years → a boom fx (growth, culture, more figure births). Bust when routes break by war or bandits (fx reversal). Price spikes in famine years feed riots.

**Implementation:** - civ/civmonth.js treasury branch: civ.flags.debtMonths and civ.debts = [{ lender: civId | 'house', amount, rate, due }].
- events/decks/realm.js chooses the policy; effects via civ.fx.
- Trade boom detection from relation.trade sums kept monthly by geo/trade.js (civ.flags.tradeHist, 12 samples).
- Volume: imp 2–3, about 0.3 a year.

**Risk:** Interacts with spendSurplus and project funding. Keep the treasury clamp at −24 × income.

### events:continental-fates — Continental fates: per-continent ledgers and land-scale events (P3, M)

**Value:** Continents get their own arcs and records: the fall of Yus, the long isolation of the southern isles, the age of contact when two continents finally meet. Players can click a continent and read its story.

A yearly per-continent ledger, keyed by continent feature: population, towns, civs, hegemon, wars, plagues, top era, peak population and its day, dark-age flags.

Land-deck events:
- Continental dark age: population −30% in 50 years ('the Fall of Yus').
- Continental golden age.
- First sustained contact between continents (an 'Age of Contact', with crop exchange: farmYield +5% on both, and plague risk).
- Long isolation flavour, and a scramble when a new continent is reached.
- Continental pandemics.

The milestones module already records unification; the ledger adds the lost-continent and isolation arcs.

**Implementation:** - events/lands.js: one pass over settlements per year, grouped by f.landmass via world.features (as in milestones.js); world.sys.events.lands = { [featureName]: { pop, towns, civs, hegemonId, wars, plagues, era, peakPop, peakDay, contactDay } }.
- stats.js: append per-continent population to world.history.years (small arrays).
- ui/inspector.js: continent panel; renderer pickEntity on feature labels (render owner).
- Perf: about 0.2 ms a year.

**Risk:** Low.

### events:diplomatic-incidents — Diplomatic incidents: visible lead-ups to war and to peace (P3, S)

**Value:** Wars stop coming out of nowhere: border skirmishes, insulted envoys, hostage swaps, royal visits and spy scandals build up (or defuse) tension in ways the player can read and follow.

A pair deck for contacted pairs. Each incident moves the inputs war.js already uses (opinion, trust, tension, grievance), so outcomes change through the existing machinery:
- border skirmish: tension +, grievance +5;
- envoy insulted at court: opinion −10 when a ruler is cruel or proud;
- hostage exchange: trust +;
- royal visit or gift: opinion +;
- embassy founded;
- spy scandal: trust −0.2;
- embargo: trade ×0;
- refugee dispute;
- assassination plot uncovered: grievance +25, revenge casus belli.
These replace the 2,161 boilerplate importance-1 non-aggression and trade-compact lines with varied, rate-limited texts.

**Implementation:** - events/decks/pair.js using rel() and addOpinion() from core/entities.js and refreshTension from geo/diplomacy.js.
- In geo/diplomacy.js the nap and trade notes become annals entries.
- Each incident is tied to a specific town or ruler (placeClause).
- Volume: imp 1–2, at most 1 per pair per 8 years.
- Perf: yearly O(pairs).

**Risk:** More war-relevant inputs could shift war frequency. Keep the net mean of opinion deltas near zero and re-check the 15–35% at-war balance target.

### events:mythic-layer — Optional mythic layer: beasts, omens, oracles, miracles and haunted ruins (P3, L)

**Value:** Turn on 'Mythic' for a fantasy flavour without breaking the realistic default: a dragon nests in the Spine Mountains and burns three towns until a hero slays it, comets foretell a dynasty's fall, the ruins of a drowned city are said to be cursed.

An optional event deck controlled by a 'mythic' param (0–1, default 0) and a 'Mythic Age' preset.
- Great beasts: a band of kind 'beast' that lairs in mountains, forest or sea, raids herds and towns, holds a hoard, and is slain by hero figures (giving a town legend and epithet, and the hoard as wealth).
- Omens: comets and blood moons shift faith fervour and legitimacy.
- Oracles' prophecies: a dynasty's fall is foretold; legitimacy drops and succession-crisis odds rise, so it tends to fulfil itself.
- Miracles at holy cities: plague cured, rain, a siege broken.
- Cursed or haunted ruins: settlers avoid them; occasionally a 'restless dead' band rises.
- Sacred groves: vegetation protected.
It compounds with any fantasy races or magic other lenses add by giving them an event substrate.

**Implementation:** - core/params.js: 'mythic' (live) and a 'mythic' preset.
- events/decks/mythic.js: every definition has mythic: true, and its weight is multiplied by params.mythic.
- Beasts reuse bands.js (kind 'beast', no civ) with a lair tile and roaming radius.
- Haunting via ruins (a fame tag 'cursed' blocks the resettlement bonus).
- Omens via the world deck with fervour (geo/religion.js boostFervor) and legitimacy effects.
- Render: beast glyph and an 'omen' fx (comet streak) in render/fx.js (render owner).
- Chronicle category 'divine', or a new 'myth' category in constants.js (kernel).

**Risk:** Must stay fully off at mythic = 0: no rng draws from mythic definitions when disabled, or seeds would diverge from current histories.

## Lens: mythic

Lens: optional supernatural phenomena and a fantasy ("Mythic") mode for Atlas of Ages.

What already helps: the codebase is a good fit for a mythic layer. Most of what a fantasy mode needs already exists as an extension point:
- **Systems and saves.** Systems are self-contained modules registered in src/systems.js. Extra tile fields come from ensureField and are saved automatically, and per-system JSON state lives in world.sys.
- **Hooks.** Hooks cover the whole civ, settlement and war lifecycle.
- **Mods.** getMods() is the single place where every nation's modifiers are combined, so races and spells can plug in there.
- **Research.** The research machinery (choice weighting, diffusion, "first to…" chronicle prose via the `first` and `deed` strings) would carry a magic branch almost for free.
- **Religion.** Faiths already have a named deity, doctrines and tenets, plus Prophet and Miracle tools.
- **Hero deeds.** culture.js already writes hero deeds like "slew the marsh serpent".
- **Disasters.** meteors.js records craters, which a star-metal mechanic can read.
- **Renderer.** It already has a pattern for map modes that overlay a field (devastation, pollution), a particle and fx queue, a sprite cache and a label placer that creatures and sites can reuse.

**Prototype measurements** (scratch scripts in my folder, read-only use of src/; seed 'mythaudit', medium map):
- **Ley network.** A ley network of 22 nodes, 21 edges and 677 tiles builds in 20 ms. It gives a mean land mana of 0.39, with 21% of land above 0.6.
- **Mana updates.** Relaxing the mana field monthly at full resolution costs 10.3 ms per simulated year. That is too much, so mana should run at half resolution (about 2.5 ms per year).
- **Monster habitat.** Deep wilderness (land outside any border) shrinks from 87% at Year 0 to 73% at Year 100, 62% at Year 200 and 50% at Year 300. Old-forest wild tiles fall from 3,920 to 2,361. Monsters that live in the empty map would retreat on their own as civilisations spread, and come back when realms collapse. The mid and late game therefore needs other pressures: rifts, undead and the magic-versus-industry decline (the Fading).
- **Race niches.** A naive race affinity table split land as follows: humans 16.7%, elves 24.1%, dwarves 6.4%, orcs 34.0%, halflings 0%, lizardfolk 18.8%. Hills are 8.1% of land and mountains 1.8%. Race tables therefore need tuning to guaranteed minimum niches, and dwarves must count hills, not just peaks.
- **Today every people wants the same land.** All eight nations settled the same temperate forest, steppe and wetland niche, because there is one shared habitability grid.

**Where it falls short for this lens:**
- Nothing supernatural is real, and folklore leaks into realism: a historical-mode hero can slay a "river dragon" or a "sabre-toothed cat" in any biome.
- Peoples have no identity beyond random traits and a random phonology.
- The first centuries are quiet. On this seed the world was still all Stone Age with about 76k people at Year 300, with 0.9 notable chronicle entries per year at Year 400 against a target of 2–40. The empty land offers no drama.
- There are no hooks for impacts, eruptions, battles or plague deaths for a layer to build on.
- The palette cannot hide tools that only make sense in one mode.
- The renderer and app only understand a fixed set of selectable kinds (tile, settlement, civ, army).

**Recommended design:** a single `mythLevel` choice with three levels: Historical (0), Legendary (1: omens, saints, folklore, nothing magical) and Mythic (2: races, mana, magic, monsters, gods that answer). It is backed by one new system, src/sim/myth/, which does nothing at level 0 and is guarded by a golden-run determinism test. Within Mythic, sliders set magic strength, monster abundance, divine intervention and wild magic. The proposals below layer onto existing systems rather than sitting beside them:
- **Races** feed habitability, demography, ruler lifespans, diplomacy and town glyphs.
- **Mana** feeds research, battles, ecology and casus belli.
- **Creatures** feed the war machinery (hunts), culture (heroes), trade (krakens) and religion (avatars).
- **The Fading** ties the existing industry, CO₂ and pollution model to the end of the age of myth, so different worlds end differently.

I judge a separate lighter "supernatural toggles for historical worlds" set worth offering only as the Legendary level of the same engine, not as independent switches. Independent switches would multiply the test matrix and the determinism risk.

### Gaps
- Performance has no headroom for a new system. `node tools/headless.mjs --years 400 --size medium --seed mythaudit` reported 207.7 ms per sim-year (total 199.7 against the 150 budget): weather 66.2 against 25, ecology 46.8 against 30, climate 31.8 against 20. The machine was loaded by parallel agents (59% CPU), and my in-process prototype measured 83–98 ms per year for the full sim, so these numbers need re-measuring on an idle machine. Either way, a myth system needs an explicit carve-out of 10 ms per year or less.
- The first centuries are thin. With seed 'mythaudit' at Year 300 the screenshot (audit-mythic/shots/02-city-y300.png) shows 'Pop. 75,882, Nations 8, Wars 0, Era Stone Age'. Headless at Year 400 shows world population 107.6k, largest city 3,035 and 0.9 notable (imp ≥ 2) chronicle entries per year against the target of 2–40. About 87% of land is unclaimed wilderness at Year 0 with nothing happening in it.
- Hero deeds use biome-agnostic, mode-agnostic beasts. src/sim/civ/culture.js:78 has `BEASTS = ['great cave bear', 'white wolf', 'sabre-toothed cat', 'marsh serpent', 'man-eating lion', 'giant boar', 'river dragon']`, picked with world.rng.pick in the hero branch around line 196. Headless Year 398 printed 'The hero Axaax of Pocho slew the marsh serpent that preyed upon the herds'. A historical world can produce a slain 'river dragon', and a desert town can produce a 'marsh serpent'. The flavour creatures never exist on the map.
- There are no kernel hooks for impacts, eruptions, battles or plague deaths. core/hooks.js documents only lifecycle and water/terrain events. meteors.js:103 pushes craters into world.sys.disasters.craters (capped at 30), which another layer would have to poll. Layers that should compound with these events (star-metal, undead from battlefields, divine reactions) have no clean signal.
- Selection kinds are hard-coded. In ui/app.js, rendererSelection() passes through only tile, settlement, civ and army. Storms and volcanoes fall back to a tile highlight, and selectionPoint() is a switch statement. Every new entity kind (creatures, sites) needs edits in app.js, inspector.js, renderer.pickEntity and entities.js. A small kind registry would scale better.
- There is no tool-availability predicate. core/tools.js getTools() returns every registered tool and ui/palette.js shows them all, so mode-specific tools (mythic tools, or tools that need industry) cannot be hidden in worlds where they make no sense.
- Peoples have no cultural identity hook. core/names.js createLanguage(rng) chooses a random CONSONANT_STYLE with no override, and core/entities.js createCiv rolls traits uniformly with rng.float(0.1, 0.9) unless opts.traits is passed. Nothing gives a people a recognisable tongue or temperament family, which races (and historical culture groups) need.
- There is one shared habitability grid. src/sim/civ/land.js habitGrid() scores every tile the same way for all peoples. In the 300-year prototype run every nation's towns sat in temperate forest, steppe, wetland or savanna (for example, Chiefdom of Eiteitl had temperate_forest:6, wetland:2, …), so peoples compete for one niche and maps look alike.
- Water is never owned (territory.js header: 'water is never owned'), so sea peoples such as merfolk cannot be territorial civs without a territory redesign. They are better modelled as non-territorial polities.
- Close-zoom snow and ice render as square texels. In audit-mythic/shots/03-zoom-40.png and crop-snow.png, the snow mask under the peak glyphs shows visible 10-pixel stair steps at zoom 40. The terrain raster at about 4 px per tile limits close-zoom depth (outside this lens; noted for the visual audit).
- The mods tables are closed. tech.js DEFAULT_MODS, LIMITS, SET_KEYS and MODS_VERSION have to change for any new mechanic (races, magic). This works, but every layer must bump MODS_VERSION and keep the defaults neutral so historical results do not move.

### mythic:myth-foundation — Mythic mode foundation: a myth-level switch, a dormant-by-default myth system and a determinism guard (P1, M)

**Value:** A clear choice at Genesis between a believable history, a history with legends, or a full fantasy world. The same seed and settings still replay identically, and historical worlds are untouched.

Add `mythLevel` (0 Historical, 1 Legendary, 2 Mythic). It appears as a three-way segmented switch above the preset cards, with a new 'Myth & Magic' parameter group that is visible only when the level is 1 or more.

Parameters:
- magicStrength: 0–2, default 1, live.
- monsterAbundance: 0–3, default 1, live.
- divineIntervention: 0–3, default 1, live.
- wildMagic: 0–3, default 1, live.
- raceMix: mixed, humanDominant, elderRaces (no humans) or monstrous; fixed at genesis.
- fading: 'Industry drains magic', default true, live.
- undead: default true, live.

Mythic presets:
- High Fantasy.
- Age of Dragons (monsters ×2.5, dragons ×3).
- Twilight of Magic (startingEra 3, magic 0.7, fading on).
- Elder Races (elderRaces).
- Dark Age (undead ×2, divine 0.5, aggression 1.4).
- Legends of Old (level 1).

A new system, myth (order 85, after war and before stats), owns the layer. At level 0 its update returns before touching world.rng, it allocates no fields or lists, and every hook handler starts with `if (!mythOn(world)) return;`.

**Implementation:** Kernel changes:
- core/params.js: PARAM_GROUPS += {id:'myth'}. PARAMS += the keys above with a new `visibleIf: { mythLevel: 1 }` property (genesis.js hides groups or params whose condition fails). PRESETS += 6 entries with `mode:'mythic'`.
- core/constants.js: CATEGORIES.myth = { label:'Myth & Magic', color:'#a98be6' }; RESOURCES += starmetal (id 13, strategic, era 2, value 6), dragonbone and moonsilver (luxury).
- core/tools.js: TOOL_GROUPS += { id:'myth', label:'Stir the Uncanny' }; tool def gains `available?(world)`; export `availableTools(world)`, used by ui/palette.js build().
- core/world.js createWorld: `creatures: []`, `sites: []`, `nextId.creature`. myth.init also creates these lazily for old saves.
- core/hooks.js: document and emit new events: 'impact' (from meteors.js impact), 'eruption' (volcanoes.js erupt, with VEI), 'battle' (war.js battle(): x, y, killed, winner, loser), 'plagueDeaths' (disease.js, per settlement per month). They cost nothing without subscribers.
- core/chronicle.js: optional `ref: {kind, id}` on entries.

Registration and new files:
- src/systems.js LOADERS += './sim/myth/index.js'.
- New src/sim/myth/: index.js (schedule: daily roaming creatures; day 12 of each month mana, civ magic and spawning; quarterly phenomena; Midsummer yearly Fading and tallies), races.js, arcana.js, creatures.js, phenomena.js, divine.js, prose.js, tools.js.
- SPEC §3 gains owner 'G · myth'.

State: world.sys.myth = { v, weave, counters:{raids, slain, workings, miscasts, rifts, sealed, risings, interventions}, rl:{}, spawnDebt, conjunction:null, grudges:{} }.

UI: ui/genesis.js adds the mode switch and the visibleIf filter. At level 2, the preview plate overlays ley lines and race homelands from a DOM-free `mythPreview(world)` exported by myth/arcana.js (about 5 ms at preview size).

Headless: tools/headless.mjs gains (a) a 'Myth balance' block when level ≥ 1, and (b) `--determinism`: run 200 years at level 0 with and without the myth module loaded and compare a hash of serializeWorld(world) minus sys.myth. They must be byte-identical.

Save compatibility: older saves have no mythLevel, so read it as `fin(Number(p.mythLevel), 0)`. The renderer and UI read `world.creatures || []`. formatVersion is unchanged.

**Risk:** Mode creep: every later feature must keep level 0 byte-identical, and the golden test is the guard. Kernel edits touch shared files (params, constants, hooks, tools), so they need one coordinated pass.

### mythic:races — Peoples of the world: six playable races with biome niches, lifespans and temperaments (P1, L)

**Value:** Every map gets a cast: elves holding the deep forests for centuries under one queen, dwarves dug into the hills, orc hordes pouring off the steppe, halflings on the best farmland, lizardfolk in the swamps. Each run deals a different mix in different places.

The race table lives in myth/races.js. 'Affinity' is how much a race prefers a tile type compared with humans (1.0 = same as humans; TF = temperate forest).
- **Human.** Affinity 1 everywhere (generalist). Life ×1, births ×1, mortality ×1.
- **Elf.** Affinity: temperate forest 1.7, temperate rainforest 1.8, taiga 1.3, rainforest 1.3, tropical dry forest 1.2, steppe 0.5, hot desert 0.2. Life ×5, births ×0.45, mortality ×0.4. Traits: aggression −0.2, isolation +0.25, innovation +0.1. Mods: gatherYield +0.3, culture +0.15, farmYield −0.1.
- **Dwarf.** Affinity: hills ×1.8, mountains ×3, alpine 2.5, wetland 0.3, rainforest 0.3, otherwise 0.6. Life ×3, births ×0.6, mortality ×0.5. Traits: militarism +0.15, commerce +0.15, expansion −0.15. Mods: mining +0.5, defense +0.2, farmYield −0.2.
- **Orc.** Affinity: steppe, shrubland, savanna, cold desert, tundra and taiga 1.2–1.5. Life ×0.7, births ×1.45, mortality ×1.3. Traits: aggression +0.3, militarism +0.3, innovation −0.2, tolerance −0.2. Mods: military +0.25, movement +0.1, research −0.15.
- **Halfling.** Affinity: fertile river lowlands ×1.4, steppe and temperate forest 1.2–1.3, hills 0.8, mountains 0.2. Life ×1.3, births ×1.2, mortality ×0.9. Traits: aggression −0.3, commerce +0.2. Mods: farmYield +0.2, storage +0.3, military −0.2, happiness +0.04.
- **Lizardfolk.** Affinity: wetland 2.6, rainforest 1.9, tropical dry forest 1.5, with a cold penalty below 12 °C annual mean. Life ×0.9, births ×1.3, mortality ×1.1. Traits: religiosity +0.2, isolation +0.2. Mods: fishYield +0.3, plagueResist +0.1.

Assignment:
- **Genesis.** Each site gets a weighted roll of affinity² × raceMix weight × a 0.35 penalty per tribe of that race already placed, with at least 3 races when civCount is 4 or more. Sites are chosen by race-aware habitability (habit × affinity), so dwarves really start in hills.
- **Emergence.** A new people takes the race the local land favours (dwarves come out of the hills).
- **Splits** inherit the parent's race. Conquered towns keep s.race, so mixed realms arise.

Rulers: an elf ruler ages a/5, so reigns of 150–400 years, few succession crises and very different politics. Orc chiefs die young.

Tuning rule: niches must be normalised so each enabled race wins 5–30% of land on default worlds. The prototype's naive table gave halflings 0% and orcs 34%.

**Implementation:** - **myth/races.js:** RACES, an AFF Float32Array indexed [race*32 + biome] with elevation-band factors, `raceAff(world, race, i)`, pickRace(), traitsFor(race, rng), and nicheReport(world) for headless.
- **civ/expansion.js:** placeGenesis, findSite, findOverseasSite and emergence multiply habit[i] by raceAff via a guarded `await import('../myth/races.js')` (returns 1 when the level is below 2). newPeople passes civOpts.traits and race.
- **civ/index.js civCreated:** `civ.race ??= parent?.race`.
- **Myth settlementCreated hook:** `s.race ??= civ.race`.
- **civ/settlement.js demographyPhase:** births × RACE(s.race).birth and deathA × mods.mortality × RACE(s.race).mortality. Housing gets × 1.4 on hills and mountains when mods.deepHalls applies.
- **civ/tech.js computeMods:** add RACES[civ.race].mods; DEFAULT_MODS += mortality 1, forestFarm 0, deepHalls 0; bump MODS_VERSION.
- **civ/rulers.js:** `age = (day − born)/DPY / RACE.life` for hazards and old age. makeRuler age ranges are scaled by life.

Data: civ.race, s.race and sys.myth.raceFirst (first city or empire per race, for chronicle milestones).

Performance: table lookups only. Determinism: the rng is used only at civ creation, guarded by the level. Saves: missing race means human.

**Risk:** Slow-breeding elves and dwarves may never grow and fast orcs may snowball. The balance harness must show each race surviving 1000 years in 60% or more of seeds, with compensations (gather yield, defence, longevity) tuned.

### mythic:ley-mana — Ley lines, mana and arcane sites: magic as a resource on the map (P1, M)

**Value:** Magic has geography. Rivers of power cross the continents, and nations near them grow wizards while others fight over a Witchstone. You can watch mana drain around greedy capitals.

**Generation** (seeded from `world.seed + ':ley'`): 18–24 nodes at the strongest plate-boundary, high-relief, old-forest and volcano tiles, spaced by √(land/22). They are joined by a minimum spanning tree plus about 25% extra short edges, rasterised as gently bowed curves into f.ley. The prototype on seed 'mythaudit' produced 22 nodes, 21 edges and 677 ley tiles in 20 ms.

**Mana:** manaBase = 0.85·exp(−d_ley/6) + 0.25·vegMax(biome) + 0.05·noise, × magicStrength × weave. That gives a land mean of 0.39 with 21% of land above 0.6.

**Dynamics** (monthly): mana += (manaBase·(1 − 0.8·pollution) − mana)·0.05, minus consumption from mage towers, arcane research and workings within a radius. Drained patches recover over years.

**Effects:**
- Ecology vegCap × (1 + 0.15·mana), with richer herds and predators.
- Arcane research and spell power scale with the mana in a nation's territory.
- Creature spawning prefers high mana.

**Nodes** are named sites ('the Witchstone of Pozuto', 'the Singing Falls', 'the Moonpool of Reen'). Owning one gives arcane research ×1.25. They are coveted, so war.js covetedResource can make them a casus belli ('The War of the Witchstone').

**Implementation:** Fields:
- f.ley: U8, full resolution, for rendering and node lookups.
- f.manaBase and f.mana: F32 at half resolution (W/2 × H/2 = 10,240 cells on medium).
- Bilinear sampleMana(world, x, y).

The full-resolution naive monthly pass measured 10.3 ms per year, too slow. Half resolution is about 2.5 ms per year.

Code:
- myth/arcana.js: genLey(world) at init when level is 2 or more, manaMonthly, consume(world, x, y, r, amt), and civ.arcane.mana (territory average from a monthly sample of settlement catchments).
- world.sites: index-as-id { id, kind:'node', name, x, y, i, power, foundedDay, endDay }. Ownership is derived from f.owner.
- versions.ley bumps on edits.
- sim/ecology.js reads an optional f.mana in vegCap behind a guard.
- geo/war.js covetedResource treats owned nodes like a value-6 resource.
- myth subscribes to 'terrainChanged' and 'impact' to re-evaluate nearby nodes.

Determinism: generation uses a forked RNG from the seed; the monthly passes use no rng.

**Risk:** Mana-rich hotspots could make arcane civs dominant. Keep mana multiplicative on magic only, and cap the battle bonus.

### mythic:arcane-schools — Six schools of magic as an arcane branch of the tech tree, with real effects (P1, L)

**Value:** Each people grows its own kind of power, such as runes, druidic songs, shaman drums or wizard towers. The chronicle records firsts like 'the Dwarves of Khazdun were the first to bind runes into their walls', and the effects show up in battles, harvests and plagues.

Arcane techs reuse TECHS with `branch:'arcane'`, a `school` and a race list. Foreign schools cost 1.5×.

**Wizardry** (human; any race may learn):
- Hedge Magic (era 0): health +0.02, arcana +0.1.
- Augury (1): stability +0.03, scrying +0.2.
- Sorcery (2): arcana +0.3, military +0.1; Mage Tower building.
- High Wizardry (4): arcana +0.4, research +0.15, wards +0.2; the Arcanum wonder.
- Waygates (5): gates 1, trade +0.2.

**Sylvan Arts** (elf):
- Wood-singing (0): forestFarm 0.6, gatherYield +0.25.
- Grove Wardens (1): ×1.3 terrain defence in forest, wards +0.2.
- Moonweaving (2): medicine ×0.7, mortality −0.15, plagueResist +0.1.
- Starsong (3): research +0.2, culture +0.2.
- Awakening the Trees (4): allied treant guardians, arcana +0.3.

**Runecraft** (dwarf):
- Deep Delving (0): deepHalls 1, mining +0.3.
- Rune-carving (1): defense +0.35, wards +0.25.
- Forge-runes (2): military +0.25, production +0.15.
- Golemcraft (4): production +0.4 with no pollution (a magical alternative to steam).
- Star-forging (5, needs starmetal): military +0.5, siege +0.4.

**Shamanism** (orc):
- Blood Rites (0): military +0.15, faster morale recovery.
- Beast-calling (1): taming +0.5, movement +0.15.
- Spirit Drums (2): war weariness gain ×0.7.
- Storm-calling (3): weatherCraft 0.5.
- Warchief's Ascendance (4): military +0.3, expansionRange +2.

**Hearth-craft** (halfling):
- Bountiful Hearth (0): storage +0.5, farmYield +0.1.
- Luck-charms (1): luck 0.25 (natural-disaster damage ×0.75).
- Hidden Ways (2): enemies target them ×0.6, defense +0.2.
- Green Thumbs (3): farmYield +0.3, soilCare +0.3.

**Serpent Rites** (lizardfolk):
- Swamp-tending (0): wetland farm suitability ×2.
- Venom Lore (1): military +0.15, plagueResist +0.15.
- Sun-blood Rites (2): birth +0.2, culture +0.1.
- Egg-temple Oracles (3): scrying +0.3, stability +0.04.

**Shared dark art:** Necromancy (2): necromancy 0.25, stability −0.04, and every other nation's opinion of the caster −20.

**Implementation:** civ/tech.js:
- computeEra, grantEra and grantWorldKnowledge skip `t.branch === 'arcane'`, so magic never speeds up the historical eras.
- availableTechs(civ, world) gates on mythLevel 2, race or foreign school, and `civ.arcane.mana ≥ t.minMana`.
- effectiveCost × (1.6 − mana) × (foreign ? 1.5 : 1) ÷ weave.
- chooseResearch weight × (0.4 + 1.2·mana) × (0.6 + innovation + religiosity)/2.
- DEFAULT_MODS += arcana 0, wards 0, taming 0, manaDraw 1, necromancy 0, weatherCraft 0, scrying 0, gates 0, luck 0, with LIMITS for each (for example wards 0–0.9, luck 0–0.5); MODS_VERSION bumped.

Where the mods act:
- geo/war.js battle eff: × (1 + 0.5·arcana·manaAt(battle tile)), capped at ×1.6. Siege progress × (1 + 0.3·arcana).
- civ/settlement.js scanCatchment: farm conversion clears veg × (1 − forestFarm), and forest farm cap × (0.6 + 0.4·forestFarm).
- core/entities.js damageSettlement: × (1 − luck) for natural causes and × (1 − wards) for causes dragon, curse and rift.
- civ/data.js BUILDINGS += magetower (tech sorcery; research +, wards +, mana consumer). WONDERS += arcanum, world_tree, rune_gate.

The inspector's tech list groups the arcane techs under a school badge. Chronicle prose comes from each tech's `first` and `deed` strings with no new code.

**Risk:** Many new mods can unbalance war and growth. Every effect must be multiplicative with tight caps, and the balance harness should compare era pacing between Mythic and Historical runs.

### mythic:creature-framework — Creatures of the wild: a bestiary of named monsters living in the empty map (P1, XL)

**Value:** The blank spaces on the map become dangerous and alive. Trolls in the taiga, giants in the hills and wyverns over the peaks push back against expanding nations, and every named beast has a page you can open.

world.creatures[] entries carry: { id, kind, name, epithet, x, y, homeI, homeR, state ('lair'|'sleep'|'roam'|'raid'|'return'|'tamed'|'slain'), power, hp 0–1, born, sleepUntil, hunger, temper, hoard, kills, raids, targetSid, tx, ty, tamedBy, pactCivId, slainBy {civId, by, day, how}, siteId, flags }.

Kinds table (habitat, move mode, speed in tiles per day, power range, behaviour):
- dragon (see the dragons proposal);
- wyvern: alpine, fly 3; raids herds and caravans;
- kraken: deep ocean, sea;
- giant: hills and tundra, land 1; smashes villages of tier 2 or lower;
- troll: taiga and hills; raids only in long winter nights at high latitude;
- treant: old forest; wakes when nearby forest is cleared;
- sand-wyrm: deserts; ambushes land caravans;
- hag: wetland; curses towns;
- behemoth: steppe and savanna; migrates seasonally, tramples farms, herds follow it;
- phoenix: volcano; an omen;
- undead horde, riftspawn and avatar (see later proposals).

Spawning (monthly): capacity K = monsterAbundance × weave × land/800 (about 20 on medium, capped at 60). If below capacity, sample 64 random land tiles and keep those 6 or more tiles from any owned land whose habitat matches.

The prototype shows wild land falling from 87% (Year 0) to 50% (Year 300), so monsters retreat before civilisation and return when realms collapse.

Movement:
- fly: straight line with wobble;
- land: greedy step among the 8 neighbours by distance + 0.5·landCost + noise;
- sea: the same on water.

Only roaming creatures move.

Garrisons: when a creature enters owned land, each month it rolls against s.garrison × mods.military. Small beasts are hunted down (imp 1); big ones raid.

Names: from nearby features and local languages ('the Wyrm of the Tepei Spine', 'Old Mossback', 'Vharokh the Ashen').

**Implementation:** - **myth/creatures.js:** CREATURES table, spawnMonthly (wildDist BFS at half resolution, 10k cells, about 0.3 ms), moveDaily, creatureBattle(world, c, army|settlement), names.
- **Kernel:** addEntity(world, 'creatures', obj, 'creature').
- **Render:**
  - entities.js: drawCreatures(r, ctx, labels) between armies and storms; hits kind 'creature'.
  - glyphs.js: creatureSprite(kind, size, frame) with two cached frames for wing or tentacle motion, plus lair sprites.
  - Labels for named creatures at zoom 5 and above through the label placer.
- **UI:**
  - ui/app.js selectionPoint and rendererSelection: 'creature' and 'site'.
  - ui/inspector.js: creatureView (portrait, kind, epithet, age, power bar, hoard, lair link, raids and kills list via chronicle ref).
- **Determinism:** spawn and movement noise use world.rng only at level 2. The wildDist cache is computed only on the sim schedule, never lazily from the UI (the same rule stats.powerOf follows).

Performance: daily cost is O(roaming creatures, about 25% of at most 60). The total target is 4 ms per year or less.

**Risk:** Monster pressure could stall early expansion when 87% of land is wild. Keep small creatures mostly local, scale raids with settlement size, and have the balance harness check that the expansion pace matches Historical within ±25%.

### mythic:dragons — Dragons: lairs, long sleeps, raids, hoards, pacts and slayers (P1, L)

**Value:** The headline fantasy story. A dragon wakes after a century and burns the richest city in reach, a greedy king bribes it to burn his rivals instead, and a hero brings its gold home and starts a golden age.

**Lairs** sit on the highest peaks and volcanoes. They are named sites ('the Wyrmhold of Mount Veist'), drawn as a cave mouth with bones and a gold glint.

**Varieties:**
- Fire drakes near volcanoes, woken by eruptions through the 'eruption' hook.
- Frost wyrms in alpine and polar land.
- Green wyrms in old forest and wetland; their raids can start plague.
- Sea wyrms on coasts.

**Life cycle:**
- Sleeps 20–120 years, then wakes hungry and stays awake 5–30 years.
- While awake it raids every 4–18 months. The target is the settlement within 35 tiles that maximises wealth^0.7 / distance.
- A raid applies damageSettlement {pop 0.02–0.08, wealth 0.5–0.8, food 0.3, buildings 0.15, cause 'dragon'} × (1 − wards), ignites 3–6 nearby tiles and adds the stolen wealth to the hoard.
- Chronicle imp 3: 'Vharokh the Ashen came down upon Pozuto in the night; its granaries burned and its gold was carried off to the Wyrmhold.'
- Dragons grow with age: power × (1 + age/300). After 500 years one becomes 'the Elder'.
- Two awake dragons within 60 tiles can lay a clutch, which hatches wyrmlings: a dragon dynasty.

**Pacts:** a greedy or craven ruler pays tribute (5% of treasury a year), and the dragon raids that nation's rivals instead (pactCivId).

**When slain:** the hoard goes to the slayer's treasury, adding prestige and a 25% chance of a golden age. The lair becomes 'the Bones of Vharokh', a dragonbone luxury resource. The slayer becomes a hero figure with the epithet Dragonsbane.

**Implementation:** - **myth/creatures.js:** dragon behaviour (onMonth: wake, choose target, raid; onArrive: raid then return).
- **Hooks:** 'eruption' wakes fire drakes.
- **Grudges:** sys.myth.grudges[civId][creatureId] += 1 per raid, read by the confronting-monsters responses.
- **Kernel:** damageSettlement cause 'dragon'.
- **Ecology:** ignite() from sim/ecology.js.
- **fx 'dragonfire':** a breath cone and EMBER particles in render/fx.js.
- **Chronicle:** 'myth' category, with refs.

Performance: dragons number 0–6, and raid targets come from settlementsNear(world, x, y, 35).

**Risk:** Repeated raids could permanently cripple one capital. Use a per-town cooldown, choose the target by wealth (which raids deplete), and pull a dragon back to sleep after big hoards.

### mythic:myth-map-render — Seeing magic: arcane, peoples and danger map modes, ley glow, creature sprites and new effects (P1, L)

**Value:** Magic is visible and gets richer as you zoom in. Glowing ley rivers and standing stones, silver motes drifting in enchanted woods, ashen blight, dragon lairs glinting with gold, haunted lights over old ruins.

**Map modes:**
- **arcane:** muted base, a violet mana ramp and drained patches in charcoal; ley lines as glowing dashed curves with slow drift; nodes as standing-stone glyphs; rifts as swirls.
- **peoples:** territory tinted by race hue family (elves sea-green, dwarves slate-iron, orcs rust, halflings wheat, lizardfolk jade, humans parchment-brown); race symbols on towns; legend swatches.
- **monsters:** wild-distance shading from safe to deep wild; dotted creature home ranges; lairs, graves and rifts; raid arrows from the last 2 years.

**Terrain mode at Mythic:**
- faint ley glimmer at zoom 3 and above;
- enchanted-wood tint plus drifting motes at zoom 14 and above;
- blight tint plus dead-tree glyphs;
- lair glyphs (cave, bones, gold glint) at zoom 10 and above;
- ghost-light flicker over haunted ruins.

**New fx:**
- dragonfire: breath cone and embers;
- spell: rotating rune circle in the school colour;
- rift: purple swirl;
- summon;
- slay: golden burst and banner;
- curse: dark ripple;
- avatar: halo pillar;
- undead: grey-green mist;
- starfall: multiple streaks;
- manastorm: aurora ribbons.

Creature sprites are cached per kind, size and frame (two frames for wing or tentacle motion). Named creatures are labelled at zoom 5 and above.

**Implementation:** - **render/modes.js:** MAP_MODES += arcane, peoples, monsters (shown only when level is 2), MODE_PROFILE entries and legends.
- **render/terrain.js:** styles 'arcane', 'peoples', 'monsters' following the devastation/pollution overlay pattern (incremental band refresh); natural style reads an optional f.enchant or f.blight tint; half-resolution mana sampled bilinearly.
- **render/palette.js:** RAMPS.mana and RACE_COLORS.
- **render/entities.js:** drawCreatures and drawSites.
- **render/glyphs.js:** creatureSprite, siteSprite, treeSprite('dead').
- **render/detail.js:** motes (deterministic hash positions with time phase) and dead trees.
- **render/fx.js:** new DUR, PRIORITY and drawOne cases.
- **render/renderer.js:** draw order and pickEntity kinds 'creature' and 'site'; ley Path2D cached by versions.ley.

Performance: at most 60 creature sprites and a cached ley path, which keeps the 50 fps budget.

**Risk:** Visual clutter on the classic atlas look. Keep Mythic overlays subtle in terrain mode and put the strong colour in the dedicated modes.

### mythic:race-identity — Race-flavoured tongues, titles, governments, buildings and town glyphs (P2, M)

**Value:** You can tell who lives where at a glance and by ear. 'Under-King Thrain of the Khazdun Holds' and 'High Lady Aelwen of the Sylvan Realm of Ithiliel' read as different worlds, and their towns look different on the map.

**Languages.** createLanguage gets per-race phonologies:
- Elf: soft onsets (l, th, s, f, v, n, r); vowels ae, ei, ia, ie; 2–4 syllables; suffixes iel, wen, lond, andor.
- Dwarf: kh, dr, b, g, th, z, gr; vowels a, u, o, i; codas rn, k, m, z, rd; suffixes heim, dun, grim, dor.
- Orc: gr, g, k, z, sh, b, ug; vowels u, a, o; codas k, g, sh, rk; suffixes gash, uk, mog, zug.
- Halfling: plain Anglo-like; suffixes by, wick, bottom, hollow, burrow.
- Lizardfolk: sibilant (ss, sh, x, q, k), apostrophes at 0.6, suffixes 'sa, ix, ath.

**Titles and styles:**
- Dwarf kingdom: Under-King/Under-Queen or Thane; '{adj} Holds', 'Under-Kingdom of {name}'.
- Elf monarchy: High Lord/High Lady or Lord/Lady of the Wood; 'Sylvan Realm of {name}'.
- Orc horde: Warchief or Overlord; '{adj} Warband'.
- Halfling republic: Mayor or Thain; 'the Shire of {name}'.
- Lizardfolk theocracy: Sun-Speaker or Egg-Mother; 'Brood of {name}'.

**Government biases:** orcs toward horde, lizardfolk toward theocracy, halflings and dwarves toward merchant republics.

**Race buildings:**
- Elf: tree-hall (housing without clearing), moonwell (health, mana).
- Dwarf: deep-hall (housing and defence on hills), rune-forge (military, production).
- Orc: war-pit (garrison), beast-pen (taming).
- Halfling: smial (housing, happiness), pantry (storage).
- Lizardfolk: spawning pool (births), sun-altar (culture, stability).

**Race wonders:** the Heartwood Throne, the Great Delving, the Skull Throne, the Hearth of Plenty, the Serpent Ziggurat.

**Glyphs:**
- Dwarf: a gate carved in a rock face with a rune arch and chimney smoke.
- Elf: a great tree with platforms and lanterns, plus a silver spire at higher tiers.
- Orc: a spiked palisade with hide tents and banners.
- Halfling: grassy mounds with round doors.
- Lizardfolk: stilt huts over reeds, plus a stepped ziggurat at tier 3 or more.
- Small-zoom cartographic symbols get race shapes too (diamond, leaf, spike, round, scale).

**Implementation:** - **core/names.js:** `createLanguage(rng, style = null)`, where style can override onsets, codas, vowels, syllable range, suffixes and apostrophe chance. PHONOLOGY tables live in myth/races.js.
- **civ/expansion.js newPeople** passes the race language.
- **civ/data.js:** GOVERNMENTS gain `raceStyles` and `raceTitles` maps. government.js styleName and rulers.js title picking consult civ.race. BUILDINGS gain `race: 'dwarf'` gating, enforced in civ/buildings.js. WONDERS gain a race field.
- **render/glyphs.js:** settlementSprite key adds a race char, and drawSettlement gets race branches (vector paths, no emoji).
- **render/entities.js** passes s.race.
- **ui/inspector.js** shows the race badge.

Performance: sprites are cached, and race adds about 5× the sprite variants.

**Risk:** Sprite cache size grows with race × tier × colour × size; cap it or use an LRU. Some generated words may still read as real English words; reuse prose.goodName vetting.

### mythic:race-relations — Kinship and enmity: racial diplomacy, mixed realms, exodus and ancient wars (P2, M)

**Value:** Alliances of the elder races against the orcs, persecuted minorities fleeing to their kin, and wars named for ancient hatreds create stories that cross borders and centuries.

RACE_REL table (−40 to +20):
- elf–orc −35, dwarf–orc −30, elf–dwarf −10.
- human–halfling +12, dwarf–halfling +8.
- lizardfolk–all −8, orc–orc −5 (clan rivalry).
- Same race +10.

Mixed realms: a town whose s.race differs from civ.race gets a loyalty target −0.1 × (1 − ruler tolerance), and unrest when RACE_REL is −20 or below. Assimilation (s.flags.assim) raises loyalty but never changes race.

Events:
- **Exodus:** a persecuted minority town sends migrants to the nearest realm of its own race (routeMigrants to kin), imp 2–3.
- **Kinstrife:** rebellions secede along race lines and the new realm is named in its own tongue.
- **The Elder Alliance:** when elves and dwarves both border hostile orcs, mutual opinion +15 and treaties form.
- **Half-blood heirs:** rare successors with a 'halfblood' trait (tolerance and charisma).
- **War:** a casus belli 'ancient enmity' when RACE_REL is −30 or below and aggression is high, with war-name pools such as 'The War of Root and Tusk' and 'The Long Feud of the Holds'.

**Implementation:** - **geo/diplomacy.js targetOpinion:** `T += RACE_REL[a.race][b.race] * (0.5 + (1 − tolerance))`, plus a shared-threat term from sys.myth.grudges.
- **geo/war.js:** casusBelli case 'enmity' and warName pools.
- **civ/settlement.js socialPhase:** loyalty and unrest term for race mismatch.
- **civ/stability.js rebellionCheck:** group minority-race towns first.
- **myth/races.js:** RACE_REL and a monthly exodus check (O(minority towns)).

All terms are 0 when race is absent (historical worlds).

**Risk:** Strong race hatred could lock orc realms into permanent war. Clamp the term and keep the war module's weariness and truce logic dominant.

### mythic:great-workings — Great workings: spells a nation casts, the mana they burn, and miscasts (P2, M)

**Value:** Magic you can see being used. A capital raises wards before a dragon, druids call rain to end a drought, and a sorcerer's storm breaks an invading host. Sometimes the spell goes wrong and a town turns into an enchanted wood.

Each month every nation with arcana above 0.2 checks whether a situation calls for a working. Each working costs treasury plus mana in a radius and has a cooldown:
- **Ward the City:** for a threatened capital or raided town; s.wards for N years, raid damage ×0.3.
- **Call the Rains:** drought in its lands; soilWater +0.3 within 6 tiles.
- **Bless the Harvest:** famine; s.food += 2 × population.
- **Storm upon the Host:** an enemy army inside its territory; strength × (1 − 0.15·arcana), morale −0.2, with a lightning effect.
- **Curse of Withering:** cruel or necromancer rulers at war; blight on an enemy town's farmland.
- **Seal the Rift:** reduces a nearby rift's power.
- **Raise the Fallen:** necromancy after a battle; a share of the dead join as undead troops.
- **Open the Waygate:** gates tech; a gate route between two cities that ignores distance.

**Miscasts** happen with chance 0.05 × wildMagic × (1 + local drain). They roll on a table:
- the town is overgrown into an enchanted wood;
- the fields are cursed;
- 5% of the people vanish to the fey;
- a rift opens;
- a mana spike;
- the court sorcerer becomes a lich (feeds the dark-lord arc).

**Implementation:** myth/arcana.js workingsMonthly(world, civ), O(civs), with a ctx built from existing data:
- droughts from soilWater samples at towns;
- s.famine;
- s.siege;
- armies of enemies inside f.owner;
- creatures within 25 tiles;
- open rifts.

Data:
- civ.arcane = { mana, workings, miscasts, last:{kind:day} }
- s.wards (until-day)
- sys.myth.counters.workings and counters.miscasts

Gate routes go in trade.js as tradeRoutes kind 'gate' with path [a.i, b.i] (the renderer draws an arc); breakRoute when either city falls.

fx 'spell' {color by school}. Chronicle: imp 2 for workings (rate-limited per civ per 5 years), imp 3 for miscasts.

**Risk:** Spells that solve every crisis would flatten history. Use long cooldowns and costs, and let miscast risk rise with how drained the local mana is.

### mythic:the-fading — The Fading: industry drains magic, and the old peoples depart (P2, M)

**Value:** Gives the whole age of myth a long arc. Some worlds fade into smokestacks as the last elven ships sail away, some magical realms go to war against industry, and some keep the magic alive. Endings differ from run to run.

'Weave' is a world-wide scalar that sets how strong magic is: 1.0 at genesis.

Weave target = 1 − 0.55·clamp01((co2 − 300)/400) − 0.6·mean pollution on owned land/0.2 − 0.2·(share of nations in era 6 or later) + 0.3 during a Conjunction (a recurring world-wide surge in magic; see the phenomena engine), floored at 0.15. Weave relaxes toward the target by 3% a year.

Effects:
- manaBase and creature capacity × weave.
- Arcane research costs ÷ weave.
- Elf and lizardfolk births × (0.6 + 0.4·weave).
- Magic-heavy nations lose stability −0.05·(1 − weave).

Chronicle thresholds:
- 0.75: 'the ley-fires dimmed', imp 4.
- 0.5: 'the dragons grew few'.
- 0.25: 'the Age of Myth ended', imp 5.

**The Departure:** below 0.4 an elven realm may depart over 20 years. Its coastal towns empty with ships sailing to the map edge, and inland towns pass by treaty to their neighbours ('the Last Ship', imp 5).

**Counter-arc:** magic-aligned nations get a casus belli 'the Smoke War' against industrial neighbours. If weave recovers by 0.3 (renewables, collapse of industry), 'the Return of Wonder'. With fading off, weave stays 1.

**Implementation:** - **myth/arcana.js fadingYearly:** reads world.climate.co2 and a sparse pollution mean (reuse the civ module's touched list or a stride sample), stored as sys.myth.weave.
- **civ/tech.js:** effectiveCost reads weave for arcane techs.
- **civ/settlement.js:** race birth uses weave.
- **geo/war.js casusBelli:** 'smoke' when the attacker's arcana is high, the target's industry is above 0.5 and weave is falling.
- **The Departure:** myth sets civ.flags.departing; each year it abandons (destroySettlement 'departed', chronicle) or transfers (transferSettlement 'treaty') 1–3 towns, with fx 'ship' trails.

Performance: yearly O(N/16).

**Risk:** A run that industrialises early could wipe out the elder races too fast. Use a slow relax rate and keep departure optional (chance-based).

### mythic:confronting-monsters — Fight, tame, bargain or pray: how peoples answer the monsters (P2, L)

**Value:** Monsters are problems nations solve in character. Warlike kings send wyrm-hunts that sometimes die on the slopes, orc shamans ride tamed wyverns to war, merchants pay tribute, priests pray, and heroes go alone and become legends or bones.

Each month, a nation under threat (raided in the last 3 years, or a lair or rift within its territory plus 10 tiles) picks a response by utility:
- **Hunt:** when its power is at least 1.5× the creature's power after arcana; warlike or ambitious rulers favour it. A hunt army is raised from manpower ('the Wyrm-hunt of Reen') with flags.hunt = creature id. Myth moves it with findPath, resolving flyers at their lairs. The fight uses creatureBattle: strength × military × (1 + arcana·mana) × terrain against power × hp × rng(0.7–1.3). The outcome is slain, wounded (the beast flees to its lair) or routed, with heavy losses and a chronicle entry.
- **Hero:** a named figure attempts it with p = 0.15 + 0.1·arcana + 0.2·(small creature). Success gives an epithet; failure kills the hero.
- **Tame:** taming 0.3 or more and a tamable kind: wyvern, troll, giant or behemoth for orcs; treant for elves. The creature follows the nation. Joining an army gives eff + 0.5·creature power. At home it adds defence.
- **Bargain:** a pact (see the dragons proposal).
- **Pray:** a divine intervention roll.
- **Ward:** the ward working (see great-workings).

Since this layer creates real creatures, culture.js hero deeds switch:
- At level 2 they target the nearest real creature.
- At levels 0–1 they pick a biome-appropriate beast list (no river dragon in a desert).

**Implementation:** - **myth/creatures.js:** responsesMonthly(world), O(threatened civs); hunt movement and battles.
- **core/entities.js createArmy:** accept a props.flags merge.
- **geo/war.js:** daily() skips `army.flags.hunt != null` in plan() and move(). Hunt armies can still be attacked in battles() by nations at war with their owner. battle() eff adds the beast bonus when army.flags.beast is a live tamed creature.
- **civ/culture.js:** the hero branch calls the myth API (guarded import) for a real target and uses BEASTS_BY_BIOME otherwise.
- **Render:** a hunt banner variant (crossed spears) and a beast sprite trailing the army.
- **Chronicle:** 'myth' and 'war' categories.

Performance: hunts are at most a few at a time and reuse the path cache.

**Risk:** war.js assumes every army belongs to a war. Skipping hunt armies must also cover disband, sanitize and the civDestroyed cleanup. Add tests that a hunt survives a declared war and a lost capital.

### mythic:undead — The restless dead: battlefields, razed cities and the grey plague (P2, L)

**Value:** Wars leave consequences. A great battle can raise the dead decades later, a razed city haunts its ruins, and an unchecked horde forces old enemies into a truce of the living.

**Sources:**
- Mass graves from the 'battle' hook when killed ≥ max(1500, 0.001·world population), stored as sites of kind 'grave' with a dead count.
- Razed, sacked or meteor-struck cities, which leave haunted ruins (the renderer already draws ruins).
- Necromancy workings.
- The grey plague: createPlague cause 'undead', where deaths seed risings.

**Risings:** a monthly roll per site, ∝ dead × (1 − holy presence: favour of healing or hierarchical faiths nearby) × the undead param × longer winter nights at high latitude. Odds jump during the world event 'Night of Long Shadows'.

**Hordes:** power ∝ dead^0.8. A horde marches on the nearest living town, and each victory turns 30% of the slain into power, so hordes snowball. They decay 1% a day without kills and 3% a day in summer at low latitude. Holy armies fight at ×1.5.

**Coalition:** when a horde threatens two or more nations, diplomacy adds +20 opinion as a common foe. Wars between them may end in 'the Truce of the Living' (endWar with outcome 'truce'), and both send hunts.

**Implementation:** - **myth/phenomena.js:** graves and risings. 'battle' and 'settlementDestroyed' hooks record sites, and legacy saves can also be scanned from war.geo.log and the ruins list.
- **Hordes:** kind 'undead' in myth/creatures.js using land movement. Attacks call damageSettlement with cause 'undead', and power is converted on victory.
- **geo/disease.js createPlague:** accepts cause 'undead' (prose pool: 'the Grey Rot'). A 'plagueDeaths' hook feeds risings, at most one horde per town per 2 years.
- **geo/diplomacy.js targetOpinion:** common-foe term from sys.myth.threats.
- **geo/war.js peace():** honours a myth flag requesting a truce.
- **Render:** fx 'undead' (grey-green mist), a horde banner sprite, and a devastation and blight trail.
- **Defaults:** keep the undead param on with low rates; Dark Age preset ×2.

**Risk:** Snowballing hordes can wipe out a continent. Use hard decay, a cap on power relative to world population, and a balance target that undead kill no more than 10% of world population per century.

### mythic:dark-lords — Dark lords and liches: a villain who unites the world (P2, M)

**Value:** A centuries-long antagonist. A cruel necromancer usurps a throne, never dies, raises the slain, and the rest of the world must form a Grand Alliance and storm the Black Throne.

Mythic-only ruler traits: 'sorcerer' (arcana +0.15) and 'lich' (ageless).

**Trigger:** a nation with necromancy whose ruler is cruel or mad and ambitious, with stability below 0.4 or after a miscast. 'The Ascension of the Dread Lady Ylsa' sets government 'dominion':
- succession: none while the capital holds;
- capacity 30, tax 0.2;
- mods: military +0.35, stability +0.05 (fear), research −0.1, happiness −0.08;
- styles: 'the Dominion of {name}', 'the Black Throne of {name}';
- titles: Dread Lord/Lady, Lich-King/Queen.

**Effects:**
- Armies regenerate from enemy dead.
- Every other nation's opinion of it is −45.
- War appetite ×2.5.
- Each conquest adds a grave.
- Neighbours with opinion below −30 of it form defensive alliances automatically (callToArms already honours alliances): 'the Grand Alliance'.

**Endings:**
- The capital falls: the lich is destroyed (imp 5) and the Dominion shatters into successor realms (splitCiv by region).
- Or the Dominion wins and the world darkens, raising the undead rate.

One dark lord at a time, with a 150-year cooldown.

**Implementation:** - **civ/data.js:** GOVERNMENTS.dominion (`mythic: true`) and RULER_TRAITS sorcerer and lich (weighted 0 outside Mythic).
- **civ/rulers.js:** rulersMonthly skips age and illness death for lich rulers; only capital capture or a hero assassination ends them.
- **civ/government.js:** the transition, triggered from myth/divine.js monthly.
- **geo/diplomacy.js:** opinion term and alliance formation (addTreaty 'alliance').
- **geo/war.js:** declarations appetite multiplier, and a capture hook for capital capture that calls myth endDominion().
- **civ/peoples.js splitCiv:** used for the breakup.
- **Chronicle:** imp 4–5.

**Risk:** A Dominion that wins too often makes every Mythic run the same. Keep the trigger rare (0–1 per millennium), make the coalition strong, and let a weave below 0.5 weaken it.

### mythic:phenomena-engine — Phenomena engine: rifts, wild-magic storms, curses, blights, enchanted woods, star-metal and the Conjunction (P2, L)

**Value:** Wild swings in fortune at every scale. One city is cursed barren for 30 years, a rift pours horrors over a frontier, an enchanted forest swallows farmland, a shower of falling stars sets off a star-metal rush, and every few centuries the moons align.

The engine is table-driven. Each event has { id, scale, minLevel, weight(world, ctx), pick(), apply, prose pool, fx, cooldown }, rolled quarterly with Poisson rates × wildMagic.

**City events:**
- Weeping Curse: births ×0.5 for 10–40 years.
- Sleepless Curse: happiness −0.15.
- Golden Touch: wealth up, food down.
- Haunting: blocks resettlement near ruins.
- Fey Abduction: 5% of the people vanish, near elves or enchanted woods.
- Witch's Bargain: famine relief now, a later toll.
- Blessed Spring: health +.
- Cursed Bloodline: ruler madness ×3 for the dynasty.

**Nation events:**
- Delved Too Deep: a dwarven deep mine at level 2 with depleted ore spawns a demon of the deep.
- The Great Hatching: lizardfolk population +30%, then famine risk.
- The Waaagh: an orc war frenzy for 20 years.
- Long Mourning: elves lose their capital.
- Prophetic Dream.

**Continent events:**
- **Rift:** a site that spawns riftspawn every 6–24 months and raises mana within 10 tiles. Sealed by workings, heroes or hunts.
- **Wild-magic storm:** a moving anomaly that transmutes the tiles in its path (veg up or down, enchant flips) and rolls settlement effects.
- **Enchanted Wood:** f.enchant spreads from nodes through old forest at 0.5% a month where veg is above 0.7. Farms fail there unless forestFarm; elves gain habitat; fey creatures live there.
- **Blight:** f.blight spreads slowly into neighbouring farmland. vegCap and farm yield × (1 − blight). Cured by healing faiths, druids, fire or time.
- **Behemoth migration.**

**World events:**
- **Conjunction:** every 300–800 years, for 30–60 years: mana ×1.5, rifts ×3, arcane cost ×0.6, imp 5.
- **Star-metal rain:** several small impacts; craters yield starmetal plus a node. Nations that own it get military +0.15, and wars break out over fallen stars.
- **Night of Long Shadows.**
- **The Sundering:** very rare; a node erupts, leaving a crater, a blight ring, a rift and a mana spike.
- **Return of the Dragons.**

**Implementation:** - **myth/phenomena.js:** EVENTS table, quarterly roller and state in sys.myth.anomalies, sys.myth.conjunction and sys.myth.cool.
- **Fields:** f.enchant and f.blight, U8 at full resolution, spread over sparse active-tile lists (the same pattern as civ touched()).
- **sim/ecology.js:** an optional vegCap term for blight and enchant.
- **civ/settlement.js scanCatchment:** farm suitability × (1 − blight), and enchanted forest blocks conversion unless forestFarm.
- **Settlement data:** s.curse = {kind, until, by}, read in the demography and social phases.
- **Star-metal:** the 'impact' hook places RESOURCES.starmetal on 1–3 rim tiles. Old saves are covered by scanning world.sys.disasters.craters.
- **Plagues:** plague.kind values for blight and undead.
- **Render:** fx 'rift', 'curse', 'manastorm' (aurora ribbons), 'starfall'.

Performance: about 2 ms per year or less.

**Risk:** Too many events turn into noise. Rate-limit per place (as the chronicle rules require), give the event table cooldowns, and have the balance harness count notable myth events per century (target 3–15).

### mythic:gods-answer — Gods that answer: divine domains, favour, interventions and avatars (P2, M)

**Value:** Faith matters on the map. Lightning breaks a siege before a holy city, a harvest goddess ends a famine, miracles drive conversions, desecrating a shrine brings a curse, and once or twice a millennium a god walks the world.

At level 2 each faith gets a domain from its doctrine:
- sun → sun; storm → storm; mother → harvest; moon → night; ancestors → death; spirits → nature;
- pantheon → war; mystery → secrets; dualism → light and shadow; monotheism → order; stars → fate; way → balance;
- reason → none, which is immune to curses but never answered.

**Favour** (0–1, monthly) = smooth(fervor × log(followers) × temples × holy city intact).

**Interventions:** when a crisis hits a town whose dominant faith has favour above 0.3 (siege, plague outbreak, famine, monster raid, drought, horde nearby), roll p = 0.02 × favour × divineIntervention × domain match:
- storm breaks sieges (besieger strength −30%, siege lifted);
- harvest ends famine;
- sun or healing faiths stop the plague in that town;
- war doubles the defenders' morale;
- death crumbles the undead;
- sea calms krakens.

Each intervention adds a conversion pulse in a radius, so miracles spread the faith.

**Wrath:** razing a holy city puts s.curse on the razer's capital or starts a 'divine' plague.

**Avatars:** favour above 0.85 and fervour above 0.8 can produce an avatar, 1–2 per millennium. It visits the faithful for 10–40 years, converting and curing, gives armies near it ×1.4, and leaves by ascending.

**War in Heaven:** two avatars of opposed domains within 20 tiles clash; the loser's faith loses fervour.

**Implementation:** - **geo/religion.js:** r.domain and r.favor, a monthly O(faiths) favour update, and an exported `requestIntervention(world, s, crisis)`.
- **myth/divine.js:** subscribes to the crisis signals:
  - monthly scan of s.siege, s.famine ≥ 2 and drought towns;
  - the 'plagueDeaths' hook;
  - raid events from creatures.js.
- **geo/war.js:** export clearSiege(world, s) and a strength penalty helper.
- **geo/disease.js:** export cureTown(world, s).
- **Avatars:** creature kind 'avatar'.
- **Chronicle:** cat 'divine', imp 3, naming r.deity ('Thunder split the siege lines before Pimwe, and the faithful praised Oxo of the Storm').
- **UI:** the religion inspector shows domain, a favour gauge and an interventions count.

**Risk:** Frequent miracles would trivialise sieges and plagues. Keep p low, give each town a 30-year cooldown, and scale with the divineIntervention slider (0 turns gods silent).

### mythic:myth-ui-ledgers — Legends ledger: creatures, sites, races and magic in the Inspector, Statistics and a Bestiary (P2, M)

**Value:** Statistics for the mythic layer at every scale: which race is winning the age, how much magic is left in the world, which dragon has burned the most towns, and who killed it.

**Inspector:**
- Tile view: mana (0–100), ley line, enchanted or blighted, nearest lair.
- Settlement view: race and minority note, wards, curse, mage tower.
- Nation view: race badge and lifespan; arcane school with progress; territory mana; tamed beasts; pacts; grudges (monsters that raided it); workings log.
- Creature view (see the creature-framework proposal).
- Site view (node, lair, rift, grave, crater, court): name, power, owner, history.
- Religion view: domain, favour, interventions, avatar.

**New 'Legends' tab:**
- Bestiary of living and slain creatures, sortable by power, raids or age; clicking one focuses the map.
- Sites list.
- Heroes and slayers.
- Dark lords.

**Statistics:**
- stacked race-population share over time ('the Age of Elves gave way to the Age of Men');
- weave and mean mana;
- monsters alive by kind;
- raids and kills per century;
- workings and miscasts.

**Elsewhere:**
- Nations ledger: race column and filter chips.
- HUD headline in Mythic: Weave % and Beasts.
- Chronicle: a 'myth' chip, and entries with refs focus their creature.

**Implementation:** - **src/sim/stats.js:** the yearly record adds `myth: { weave, mana, beasts:{kind:n}, rifts, races:{race:pop} }`, and the civ record gains a compact race index. Rounding and caps as today.
- **UI files:** ui/inspector.js (views), ui/app.js (kinds), new ui/legends.js plus a tab in ui/panel.js, ui/statistics.js and ui/charts.js (stacked area reused from population by nation), ui/nations.js, ui/hud.js, ui/chronicle.js (category from CATEGORIES automatically), ui/icons.js (glyphs: ley, dragon, rift, wand, skull, tree-eye).

Read-only UI must never fill the sim caches (the same rule as stats.powerOf readOnly).

**Risk:** Panel sprawl. Put Legends behind the Mythic level so Historical users never see empty tabs.

### mythic:myth-tools — Stir the Uncanny: mythic god tools, including drawing ley lines by hand (P2, M)

**Value:** Hands-on fun. Drag a river of magic across a continent and watch wizard-towns rise along it, drop a dragon on a smug empire, open a rift, bless a forest, or awaken magic halfway through a historical world.

A 'myth' tool group, shown only at level 2 except Awaken Magic:
- **Ley Line:** a continuous drag that rasterises a new ley segment along the stroke and recomputes manaBase when the stroke finishes.
- **Wellspring:** creates a node.
- **Summon:** the strength slider bands choose wyvern, troll, giant or dragon (dragons need high ground).
- **Slay:** sends a hero at the nearest creature, showing the odds.
- **Tame:** gives the nearest creature to the nation that owns the ground.
- **Rift:** opens a rift, or seals one when clicked on.
- **Bless Wood:** enchant brush.
- **Blight:** brush.
- **Raise the Dead:** at a ruin or battlefield.
- **Avatar:** manifests the area's dominant god.
- **Curse or Bless:** on a town.
- **Starfall:** a shower of star-metal meteors.
- **Awaken Magic:** available in Historical and Legendary worlds. A one-way switch to Mythic that generates ley and mana; the elder races emerge from wild places over the following decades. 'The Awakening', imp 5.

**Implementation:** - **myth/tools.js:** registerTool with `group:'myth'`, `available: (w) => level(w) >= 2`; Awaken's predicate is level below 2.
- **Core and UI:** availableTools(world) in core/tools.js, consumed by ui/palette.js. Continuous drag already works through the `continuous` and `finish` contract.
- **Awaken:** setParam(world, 'mythLevel', 2) via a tool-only path, myth.init(world) at that moment, then emergence biased to elder races for 50 years.
- **Chronicle:** every tool writes a 'divine' entry. New icons in ui/icons.js.

**Risk:** Awaken changes a fixed-at-genesis parameter mid-run. Document it as an irreversible tool and make sure saves record it (sys.myth.awakenedDay).

### mythic:sea-perils — Krakens, sea serpents and the merfolk courts (P3, M)

**Value:** The oceans gain character. Trade lanes bend around kraken waters, navies hunt sea monsters, and a coastal kingdom that overfishes angers the Pearl Court, while one that sends gifts sails in safety.

**Kraken:** a deep-ocean creature far from the coast. Each month it may:
- sink a ship (a caravan of kind 'ship') within 6 tiles; route value −30% for 2 years; 'three merchantmen of Reen were dragged beneath the Staelan Sea';
- maul a naval army (strength −20% to −60%).

Open-sea navies (navigation 2) can hunt it.

**Sea-lane fear:** a coarse 8×8 peril grid, built monthly from sea-creature positions, lowers how attractive a route is and may reroute or abandon it.

**Merfolk courts** are non-territorial polities, because water is never owned. They are sites of kind 'court' on shelf seas ('the Court of the Pearl Throne'). Each keeps a mood (−1 to 1) toward every coastal nation, based on:
- depletion of the fish field within 10 tiles;
- coastal pollution;
- offerings from sea-domain faiths.

Friendly courts give fishYield +20% to that nation's coastal towns, rescue ships and deflect storms. Hostile courts cut nets (fish −30%), sink ships and send sea serpents against harbours. The chronicle covers this like diplomacy.

**Implementation:** - **myth/creatures.js:** a kraken kind using sea movement.
- **myth/courts.js:** monthly mood updates over coastal settlements within 30 tiles (O(courts × towns nearby)).
- **Trade:** trade.js reads `world.cache.myth?.seaPeril` (built by myth on its own schedule) in route scoring and calls breakRoute(world, r, 'kraken') for the worst cases. Remove ships with removeEntity(world, 'caravans', id).
- **Settlements:** settlement.js X.fishPot × court modifier through civ.flags or s.flags.court.
- **Render:** kraken tentacle-ring sprite, a court glyph (pearl crown on a wave), dotted red peril hatching in trade mode.

Performance: small.

**Risk:** Abandoning routes can cascade into a trade collapse. Cap the losses per year and per sea.

### mythic:legendary-level — Legendary level: folklore, omens and saints for historical worlds (P3, M)

**Value:** Historical worlds feel more human and less predictable without any real magic. Comets topple kings, relics draw pilgrims, plagues set off witch-hunts, and prophecies seem to come true.

Judgement: a lighter supernatural set is worth offering, but as mythLevel 1 of the same engine rather than separate toggles. Events act through belief and politics, never physics:
- **Omens:** comets and eclipses on a seeded schedule; ruler legitimacy −, war appetite +, revolts. 'A bearded star hung over Reen for forty nights.'
- **Saints and relics:** dead prophets and heroes become saints. Relic sites add pilgrimage trade value to holy cities, and relic theft is a casus belli.
- **Witch-hunts:** during plagues or famines in towns with a minority faith; unrest, deaths, persecution.
- **Biome-true beast hunts:** heroes hunt beasts tied to real predator density and biome, which fixes the river-dragon-in-a-desert flavour gap.
- **Haunted ruins:** resettlement is delayed.
- **Holy wells and miracle cures:** small health effects.
- **Cursed dynasties:** a legitimacy drag.
- **Sea-serpent sightings:** sailors' fear slightly lowers sea trade in stormy seas.
- **Self-fulfilling prophecies:** a prophecy names a city and a span. War targeting is biased toward it, and the chronicle closes the loop: 'as the prophecy had foretold'.

This also gives quiet early centuries more city- and nation-scale events. The seed-'mythaudit' run had only 0.9 notable entries per year at Year 400.

**Implementation:** - **myth/folklore.js:** events with minLevel 1 in the phenomena engine's table.
- **civ/culture.js:** hero branch uses biome-true beasts at levels 0–1 (BEASTS_BY_BIOME).
- **geo/religion.js:** saints from dead prophet figures; relic sites in world.sites kind 'relic'.
- **geo/trade.js:** pilgrimage value bonus on routes to holy cities with relics.
- **geo/war.js:** casus belli 'relic' and a prophecy target bias.
- **civ/rulers.js:** legitimacy hits from omens.

Presets: 'Legends of Old'. Balance: the headless myth block counts folklore events (target 2–8 per century).

Determinism: only at level 1 or above.

**Risk:** It can read as noise if over-tuned. Keep the effects small and the prose specific, and rate-limit per place.

## Lens: tactile

I tried all 28 placeable god tools through the real UI in headless Chrome (seed "tactile", Year 600, zoomed to the largest city), plus hover, army follow, max zoom, storm dragging and a fresh world's first minute. I also ran Node scripts to check determinism, snapshot cost and the island tool. Scratch work is in <scratch> (shots/sheet0–3.png, shots/11-plague-hover.png, shots/40-fresh-1min.png, tools.json, fork.mjs, island.mjs, snapcost.mjs).

What works well. The tools have real, lasting consequences in the simulation:
- A Falling Star wiped out Qode, left a crater lake and killed about 6,500 people.
- Incite Unrest split Hiki off into a new kingdom.
- Enlighten taught Currency and started a golden age.
- Discord set seven neighbours against the Realm of Irkarir; Harmony undid it.

Each act gets a prose Chronicle entry. The renderer holds 60 fps at "Faster" (about 6 ms per frame). The camera already flies smoothly between places, and armies and storms can be followed. Most importantly for this lens, interventions are fully deterministic. I forked a Year-150 save and ran 100 years twice from the same state. Two runs with no intervention ended identical, down to the random-number state. Two runs with the same meteor applied also ended identical. So user actions can be logged, replayed, undone and compared against "what if I hadn't". Snapshots are cheap: copying all tile fields (8.5 MB) takes 0.5 ms, and cloning the rest of the world without the history takes about 5 ms at Year 600.

Where it falls short. Poking the world gives little feedback. Nearly every Fate, Peoples and Catastrophe tool plays the same golden burst of rays: Ruin ("Calamity fell on Hiki"), Plague, Discord, the Earthquake tool, Blizzard, Storm and Locusts all look like blessings. The six terrain tools, Herds, Predators, Fish, Bloom and Plant Forest play no effect at all, so the feedback is the brush circle and sometimes a status message. Locust swarms are never drawn on the map. Before a click, no tool shows what it will hit:
- Plague and Prophet silently pick the nearest town within 10 tiles.
- Enlighten, Discord and Harmony pick a nation and play their effect at its capital, which may be off-screen; there is no off-screen marker.
- Found Town only tells you "Too close to another settlement" after you click.

There is no undo, sound, renaming, photo or recording export, story framing, goal, or way to grab a storm or direct an army. Dragging a storm just pans the map. The inspector's nation and army pages only offer "show on map", "follow" and "close". A fresh world's first minute at Faster speed produced one toast and 1,635 people. Headless, the first 300 years average 0.8 Chronicle entries of importance 2 or more per year, below SPEC §9's target of 2–40 for a 1000-year run. That quiet early stretch is where goals, a camera director and feedback matter most.

The proposals below are ranked by delight per unit of effort. The first three are mostly renderer and UI work (proposal 2 also adds a kernel contract and preview functions in the tool modules) and turn every click into a readable, satisfying act. Proposals 4 and 12 build on determinism (undo, journal, counterfactual timelines). Proposals 6, 7, 8 and 13 give the player reasons and targets for acting.

### Gaps
- Every Fate, Peoples and Catastrophe tool plays the same golden 'divine' rays, so curses read as blessings: Ruin ('Calamity fell on Hiki… 4,570 died'), Plague, Discord, Earthquake, Blizzard, Storm and Locusts all show a gold sunburst. Evidence: shots/sheet1.png, sheet2.png, sheet3.png; most of these tools emit {type:'divine'} (src/sim/civ/tools.js, geo/diplomacy.js, geo/disease.js, disasters.js, weather.js).
- Many tools emit no visual effect. Raise Land, Lower Land, Flatten, Raise Mountains, Drown Land and Raise Island (src/gen/terraform.js) and Bloom, Plant Forest, Herds, Predators and Fish (src/sim/ecology.js) call emitFx nowhere. Rain and Drought emit only a rate-limited divine burst. The only feedback is the brush circle (shots/sheet0.png). A Raise Mountains stroke at zoom 14 left just a faint hillshade change (shots/sheet-terra.png).
- Locust swarms (world.sys.disasters.swarms) are never drawn: src/render has no locust code. The Locusts tool shows a toast and a gold burst, then nothing on the map (shots/t-locusts-b.png).
- No hover preview of what a tool will hit. Plague and Prophet silently choose the nearest town within 10 tiles; Unrest and Ruin within 3; Enlighten, Discord and Harmony choose the owner or the nearest town's nation. Hovering shows a dot cursor only (shots/11-plague-hover.png, 12-enlighten-hover.png). Found Town fails only after the click ('Too close to another settlement', tools.json).
- Nation-target tools play their effect at the capital, which may be off-screen. FxSystem.draw culls off-screen effects and nothing points to them (src/render/fx.js draw), so the player can see no effect at all.
- Raise Island: one click on deep ocean makes 0 land tiles (3 clicks make 8, 8 clicks make 25; island.mjs), yet the first apply always toasts 'Rock breaks the surface of the sea.' (terraform.js:300).
- One act raises two toasts: the tool's status toast and the importance-3 'Divine Hand' Chronicle toast with the same news (shots/sheet1.png, quake).
- Prose bug in the meteor Chronicle entry: the lake clause is appended after the deaths clause, giving '…the walls of Hiki thrown down, killing some 6,500 that slowly filled into a round lake.' (src/sim/nature/meteors.js:132).
- The Ruin status message prints unformatted numbers: 'Hiki lies in ruins; 4570 of 15233 perished.' (src/sim/civ/tools.js:197).
- Above 150 days per second, the player's own act gets a shortened effect: FxSystem.ingest scales every duration by 0.55 (fx.js), with no exemption for tool-triggered effects.
- No undo: Ctrl+Z is unbound and nothing is snapshotted before an act, even though restore is cheap (snapcost.mjs: 0.5 ms field copy plus about 5 ms structuredClone at Year 600).
- No sound of any kind: no AudioContext anywhere in src. No haptics.
- No direct manipulation. Dragging a storm with Inspect pans the camera and the storm's vx/vy stay unchanged (s2.mjs). Armies cannot be redirected and towns cannot be dragged.
- Individuals cannot be targeted: the nation, army and settlement inspector pages offer only show on map, follow and close (shots/30-civ.png). Rulers, dynasties, generals and prophets have rich data (src/sim/civ/rulers.js) but no levers.
- No naming, postcard, screenshot or time-lapse export. The Atlas timelapse plays only inside the panel. MediaRecorder and canvas.captureStream do work from file:// in headless Chrome (wtest.mjs).
- No goals, challenges, achievements or framing. A fresh world's first minute at Faster speed gave 1 toast and 1,635 people (shots/40-fresh-1min.png). Headless seed 'tactile' Year 0–300 gave 0.8 Chronicle entries of importance 2 or more per year, below SPEC §9's 2–40 target (that target is for a 1000-year run). Chronicle and milestones exist but nothing invites the player to steer toward an outcome.
- No auto-camera or director. Major events reach the player only as toasts. At 1440×900, four toasts plus the digest slip cover about 380×414 px of the map's top-right (shots/10-running.png).
- After 'Leap ahead' the player gets one toast ('N major events were written'). There is no recap of what changed.
- The palette needs two clicks to switch tool group, has no tool hotkeys or recent tools, and no wheel-modifier for radius or strength (src/ui/palette.js, input.js).

### tactile:intervention-fx-kit — A feedback vocabulary for divine acts: polarity-coded effects, floating numbers, impact-scaled screen effects, off-screen pointers (P1, M)

**Value:** Every click lands with a visible, distinct effect sized to what it did: a curse looks like a curse, a blessing glows, raised mountains throw dust, released herds stampede out, and you see '−4,570' rise off a ruined city. This is the cheapest single change that makes the god tools satisfying.

Replace the one-size gold 'divine' burst with a small set of effect types, emitted by each tool to match what it does and how big it is.

- 'bless': gold rays and rising motes (Prosperity, Enlighten, Cure, Harmony, Prophet).
- 'curse': a violet-black ring collapsing inward, red fissures, falling ash and tiny raven sprites (Ruin, Plague, Discord, Incite Unrest).
- 'terraform': dust ring and rock chips; outward for raise, inward for lower; a short shake scaled to the elevation change times the area.
- 'sprout': green leaf particles (Bloom, Plant Forest).
- 'spawn' {glyph: herd, pred or fish}: herd dots running outward, predator eye-glints, fish leaping in arcs.
- 'raincall': falling streaks and local darkening. 'parch': heat shimmer and cracking ochre rings.
- 'thread': lines from a nation's capital to each neighbour's capital, jagged red for Discord and flowing white for Harmony, so you see who was affected.
- 'label': floating text (map serif with halo) that rises and fades, e.g. 'M7.0', '−4,570', '+Golden age', '14 tiles ablaze', 'Currency'.

Screen-space effects scale with an impact score I = log10(deaths+1)/5 + tilesChanged/200 + magnitude: shake 2–14 px, a vignette tinted by polarity (alpha 0.1–0.35), a zoom punch of 1.03× for 200 ms, and 'hit-stop' (at speed 4 or more the UI drops to Normal for 0.5–1.5 s on big strikes, then restores). All of this respects prefers-reduced-motion.

Effects triggered by the player are never shortened at Max speed. When their target is off-screen, an edge chevron with a label points to it for 3 s; clicking it flies there.

The same pass fixes four small bugs: the meteor prose clause order, number formatting in the Ruin message, the Raise Island toast (only claim 'breaks the surface' if a tile actually crossed sea level), and the locust swarms that are never drawn (draw them as a shimmering speckle cloud).

**Implementation:** Render (src/render/fx.js):
- Add DUR/PRIORITY/TYPE_CAP entries and drawOne cases for bless, curse, terraform, sprout, spawn, raincall, parch, thread (uses fx.x2/fx.y2; ingest must copy x2, y2, text, size, sign and src) and label.
- New particle kinds PK.LEAF, PK.RAIN and PK.FEATHER in Particles (pool stays at 900).
- FxSystem gets a vignette {rgb, a} that decays like flash, drawn by renderer.js as a screen-space radial gradient after the fx pass.
- Any fx with src:'tool' skips the dps duration scaling and gets priority 10.
- Off-screen pointer pass in screen space: clamp the fx position to the view inset by 28 px, draw a chevron and label, and push into r.hits as {kind:'fxPointer', x, y} so pickEntity returns it. input.js selectAt then calls app.focus.
- Labels: cap 24; stack upward if overlapping; drawn with the label font stack from labels.js.
- Locust swarm drawing goes in src/render/entities.js (a new drawSwarms reading world.sys.disasters?.swarms; pickable as kind 'swarm').

Emitters:
- src/sim/civ/tools.js: prosper and enlighten emit bless; ruin emits curse plus label '−N'; unrest emits curse plus the existing rebellion.
- src/sim/geo/disease.js: plague emits curse (green-black) plus a label with the plague's name; cure emits bless.
- src/sim/geo/diplomacy.js: discord and harmony emit thread fx, one per affected neighbour capital.
- src/sim/disasters.js: drop 'divine' from quake, volcano, meteor and tsunami; add labels (magnitude, VEI, coasts struck).
- src/sim/weather.js: rain emits raincall, drought emits parch, lightning emits only lightning, storm emits a short swirl.
- src/sim/ecology.js: bloom and forest emit sprout; herds, predators and fish emit spawn.
- src/gen/terraform.js: emit terraform per apply with sign and intensity; fix the island message.
- src/sim/nature/meteors.js:132: insert the lake clause before the deaths clause.

UI: hit-stop in src/ui/input.js after applyAt (UI speed only; it never touches the sim).

SPEC §6.5: list the new fx types.

Performance: renderer only; added draw cost under 0.5 ms per frame with the caps above. Determinism: unaffected, since fx are never saved or read by the sim.

**Risk:** Visual noise if overused at Max speed. Mitigate with the existing TYPE_CAP mechanism and by showing labels only for tool-triggered effects and natural events of importance 3 or more.

### tactile:tool-target-preview — Hover previews: show what a tool will hit and whether it can be used, before the click (P1, M)

**Value:** You can see your aim. Hovering with Plague puts a pulsing reticle on the town it will infect. Enlighten outlines the nation. A quake shows its damage ring and the towns at risk. Found Town shows a red X with the reason before you waste a click. This turns guesswork into deliberate play.

Tools get an optional pure preview(world, x, y, opts) returning { ok, reason?, targets?: [{kind, id}], rings?: [{x, y, r, tone}], estimate? }. The UI calls it while hovering (throttled to 40 ms).

The renderer draws:
- a rotating dashed reticle and name tag on targeted settlements;
- a civ outline tinted by polarity (gold for bless, crimson for curse), reusing the selection-outline code;
- danger rings (meteor crater R and blast 2R, quake damage radius from the same magnitude-to-radius function, volcano lava reach);
- a red slashed cursor and red dashed brush circle when the action is invalid.

The hover card shows the estimate or reason, for example:
- 'M7.0 · 3 towns within reach · about 1,900 at risk'
- 'Will wake Mount Sosinaa (6 tiles)' versus 'Will raise a new volcano here'
- 'Waves from the Nielus Ocean reach 6 coasts'
- 'Too close to Hiki (2 tiles)'
- 'Will strike the Realm of Irkarir (capital Kioqnir, off-screen)'
- for Raise Island over deep water: 'Hold to raise: about 4 applications to break the surface'.

For Discord and Harmony, preview threads to every neighbour that will be affected.

**Implementation:** Kernel (src/core/tools.js):
- Document the def.preview contract.
- Add export previewTool(world, id, x, y, opts) with try/catch, returning null if absent.
- In dev builds, assert that world.rng.state is unchanged by a preview.

Previews per tool:
- civ/tools.js: tribe and settle via spacingOk and the water check, naming the blocking settlement; enlighten via civAt; unrest and ruin via settlementAt.
- disease.js: plague and cure.
- religion.js: prophet (nearestSettlement within 10) and miracle (dominant faith in the brush).
- diplomacy.js: discord and harmony, listing neighbours from civ.relations with border > 0.
- disasters.js: quake (export the radius and severity helper from nature/quakes.js); meteor (R from strength); volcano (nearest volcano within the same search radius the tool uses); tsunami (the ocean body and coastal towns in range from the same routine without applying); flood; locusts.
- weather.js: storm, reusing the kind-selection logic factored into a pure helper.

Renderer (src/render/renderer.js): setToolPreview(p | null), drawn in the selection-outline pass. Reuse _drawSelectionOutline with a color parameter for civ targets; reticles in the entities pass.

UI: src/ui/input.js processHover calls previewTool when app.tool is not inspect and shows the estimate or reason in the hover card; CSS cursor class .is-invalid in styles.css; palette.js card hint mirrors the reason.

Performance: each preview is O(nearby settlements), under 1 ms, only while a tool is active; no sim cost. Determinism: previews must not mutate state (asserted).

**Risk:** Previews duplicate a little logic per tool. Keep them honest by factoring shared helpers (target resolution, radii) out of each apply() so apply and preview call the same function.

### tactile:director-mode — Director: a cinematic auto-camera that flies to great events, with captions (P1, M)

**Value:** Press V (or the camera button) and the atlas narrates itself. It glides to a besieged capital as the walls fall, a falling star, a new faith's holy city, with the Chronicle sentence as a caption and time slowed for the big moments. It works as a screensaver with H, and as a way to never miss anything.

The director takes candidate events from:
- Chronicle entries of importance 3 or more that have a place (sid, civId, or x and y), plus importance 2 for the patron nation;
- important effect starts (meteor, eruption, tsunami, capture, wonder, newcivs).

Score = importance×10 + category bonus (capture, disaster, epochal) − revisit penalty (same place within 60 s) − age, with a novelty bonus for nations not shown recently.

For each pick:
- Fly there with the existing camera flight, at a zoom suited to the event: town events z≈16; war declarations frame both capitals; disasters zoom = view/(6r); plagues frame the bounding box of infected towns.
- Dwell 6–12 s (15 s for importance 5) with a slow drift.
- Show a lower-third caption: category glyph, date, sentence, and Inspect / Follow / Skip buttons.
- Optionally drop to Fast speed during dwells of importance 4 or more, then restore the previous speed.

Between events it eases back toward an overview. Any user pan, zoom or click pauses the director for 15 s, with a small 'Director waiting' chip. An attract mode starts it after 3 minutes idle (a pref). With UI hidden it becomes a cinematic screensaver. Captions replace the toast stack while the director is on, which also clears the top-right of the map.

**Implementation:** New module src/ui/director.js:
- State {on, lastSeq, queue, current, dwellUntil, visited: [{x, y, t}], pausedUntil}.
- Subscribes to app.on('tick') and uses chronicleSince(world, lastSeq).
- Place resolution via selectionPoint and entryHasPlace (src/ui/app.js, toasts.js).
- Flights via app.r('focusOn', x, y, z); drift via app.r('pan', dx, dy) each frame from main.js.

Renderer (src/render/renderer.js): add an onFx callback (FxSystem._onStart calls this.onFx?.(fx)) so the director, and later audio, hear the big effects; expose camera.animating.

Other UI:
- HUD: a camera toggle button next to the speed control (src/ui/hud.js); key V in input.js; caption DOM #director-caption in index.html and styles.css.
- toasts.js: while the director is on, toasts of importance 3 that the director will show are suppressed.
- prefs: director {slowTime, attractAfterMin}.

Performance: UI only, one flight at a time, no sim cost. Determinism: unaffected, except that the optional speed changes are viewer pacing only.

**Risk:** It can feel jumpy at Max speed. Cap at one cut per 6 s, prefer events already in or near view, and fall back to captions only when the event rate exceeds about 1 per second.

### tactile:undo-rewind — Undo and redo for divine acts (Ctrl+Z), with a rewind effect (P2, M)

**Value:** Experimenting stops being scary. Drop the meteor, watch, rewind, try a smaller one. Undo is what makes a god-sim feel safe to play with, and it doubles as the fork point for 'what if' comparisons.

Before each stroke (first apply of any tool, and any live-parameter change), keep a 'pre-act' snapshot in a ring of 5. Ctrl/Cmd+Z restores the latest one; Shift+Ctrl+Z redoes.

A snapshot holds:
- copies of all typed arrays in world.f (8.5 MB on a medium map; 0.5 ms measured);
- a structuredClone of world minus f, cache, fx, chronicle and history (about 5 ms at Year 600);
- the RNG state;
- the Chronicle sequence and entry count, and the history.years and history.atlas lengths, so the Chronicle and history can be truncated instead of copied (history alone is 2.2 MB of JSON at Year 600).

On restore: the state is replaced in place, every version is bumped as on load, 'worldLoaded' is emitted, sim.init() rebuilds caches, and renderer.setWorld refreshes. Visual: a 400 ms sepia wash with a reverse ripple at the act's location, and the toast 'The hand was stayed: Falling Star, Year 600'.

The deed card (see tool-flow-ergonomics) carries an Undo button.

**Implementation:** New DOM-free module src/core/snapshot.js (kernel owner):
- takeSnapshot(world) → {day, fields: {name: typed.slice()}, rest, rng, chronSeq, histYears, histAtlas}.
- restoreSnapshot(world, snap) mutates world in place: f[name].set(copy), or replaces it when the length changed; Object.assign of the rest; chronicle.entries filtered to seq ≤ chronSeq and c.seq reset; history arrays truncated; rng.state set; versions all incremented; emit 'worldLoaded'.
- Headless-testable: compare the serializeWorld hash before an act and after undo.

UI:
- src/ui/undo.js: ring buffer (5 on small and medium maps, 3 on large and vast), redo stack.
- input.js: beginStroke calls undo.push(label); Ctrl+Z and Shift+Ctrl+Z bindings.
- worldtab.js: push a snapshot before live-param changes.
- hud.js: menu items for undo and redo.
- After restore: app.sim.init(), app.r('setWorld', world), app.emit('world'). Or reuse the installWorld path while keeping the camera.

Render: a sepia 'rewind' fx in fx.js.

Performance: about 6 ms on click at Year 600 medium, about 45 MB of memory for 5 snapshots, no per-frame cost. Determinism: verified by fork.mjs; a restored world continues bit-identically.

**Risk:** Systems that keep derived state outside world.cache could desync after restore. The same risk already applies to loading a save, and the version bump plus system.init() is the established path. Test with the headless hash check.

### tactile:webaudio-soundscape — Procedural spatial soundscape (WebAudio, one switch, no assets) (P2, M)

**Value:** Sound doubles the weight of every act: the low rumble of a quake, a meteor's whoosh and boom, thunder over a storm, a choir swell on a blessing, a dissonant drone on a curse. Gentle ambience follows the camera: surf off the coast, birdsong over summer forests, the murmur of a great city when you zoom in.

All sounds are synthesized; nothing is downloaded. The master chain is gain → compressor → destination, with Sound on/off and volume in the Menu. Sound starts off; a one-time chip offers to turn it on after the first act. The AudioContext is created on a user gesture.

Event voices:
- rumble: brown noise, lowpass 60–120 Hz, envelope scaled by magnitude;
- thunder: noise burst and lowpass sweep;
- meteor: rising filtered noise whoosh, then boom and sub thump;
- eruption: rumble plus crackle;
- tsunami: long noise swell;
- battle: muffled drum taps and clash ticks, distance-attenuated and throttled to 4 per second;
- founding: wooden knock; wonder and bless: a slow major chord (three sines plus a soft saw); curse: a minor-second cluster and low drone;
- plague: a detuned breathy pad; war declared: a short horn (filtered saw); new era: a bell chord.

Voices are panned by screen x and attenuated by distance from view centre and by zoom (world zoom dampens local events). Tool clicks get immediate tactile ticks: a confirm 'thock' or a denied 'thud' when a tool fails.

Ambient bed, sampled every 500 ms from the view:
- ocean share of the view → surf;
- forest share × season → birds (FM chirps);
- storms in view → wind;
- average rain → hiss;
- above zoom 14, settlement population in view → murmur;
- war in view → distant drums.

On touch devices, navigator.vibrate is scaled to quake and meteor impact, behind the same switch.

**Implementation:** New module src/ui/audio.js:
- Noise buffers (white, pink and brown; 2 s each, generated once) and recipe functions per voice.
- A voice pool capped at 16, with per-type throttles; ambient loop nodes with gain ramps.
- Suspended when paused (except ambience), when the tab is hidden, or in the Genesis screen.

Hooks:
- renderer.onFx callback (added to the FxSystem._onStart call site in src/render/fx.js and renderer.js), receiving the fx plus its screen position and view distance;
- input.js applyAt result, for the tool click or deny sound;
- toasts.js pushEntry, a chime by importance;
- hud.js, a speed-notch ratchet.

Prefs (src/ui/prefs.js): sound {on, vol, ambient}. Menu toggle and slider in hud.js.

Performance: under 1% CPU; no sim cost. Determinism: unaffected.

**Risk:** Autoplay policies need the context resumed on a gesture. Sandboxed artifact hosts may mute audio. Keep everything optional and fail silently.

### tactile:inspector-divine-acts — Divine acts on individuals: bless or curse a ruler, arrange marriages, kindle feuds, gift a technology, command an army, rename anything (P2, M)

**Value:** Turns the gorgeous inspector pages into levers. Bless a young queen with wisdom, curse a cruel king with madness, marry two houses and watch a personal union merge two realms a generation later, kindle a blood feud, hand a tribe the wheel, or rename a city 'Newhaven'. These are personal, story-making interventions.

Add a 'Divine acts' section to the inspector pages, each button invoking a registered entity tool.

Ruler:
- Bless: add a virtue trait (wise, just or brilliant, chosen against existing opposites), remove one vice, +0.15 legitimacy, ruler.flags.blessed lowers the death hazard ×0.6.
- Curse: add 'mad' or 'cruel', death hazard ×2.5, epithet 'the Accursed' on death.
- Smite: death now, through the normal succession path (crises and civil wars included).
- Grant an heir: civ.flags.heirSecured prevents the next succession crisis.

Dynasty:
- Arrange a marriage with another nation's house: an alliance-like opinion of +30, and civ.flags.marriages [{civId, dynasty, day}].
- Personal union: if a house dies out (succession finds no dynastic heir) while a marriage tie exists, the spouse realm may inherit the whole realm. All settlements transfer with cause 'inheritance'; Chronicle importance 4: 'the crowns of X and Y were united'. Otherwise a claimant war fires with the existing succession-war naming.
- Kindle a blood feud: grievance +40, a yearly assassination-plot chance, and a 'blood feud' casus belli.

Nation:
- Gift a technology: a picker of techs whose prerequisites are met.
- Grant a claim on a town: a casus belli.

Settlement: commission a wonder (pick a kind from the wonder table); bless or curse the harvest (one season); rename.

Army: inspire (+0.3 morale, +general skill); sow desertion (−40% strength over 30 days); send to a target (see direct-manipulation).

Religion and figure: inspire a prophet in this town (precise, unlike the nearest-town Prophet tool); rename a faith.

Rename: inline edit on the inspector title for settlements, nations (baseName and adjective; the government restyles them), faiths, storms, rulers' epithets, and features from the tile view. A Chronicle line follows: 'By divine decree, Hiki was thenceforth called Newhaven.'

**Implementation:** Kernel (src/core/tools.js): document target:'entity' and hidden:true; palette.js skips hidden tools. applyTool passes opts {civId, sid, rulerId, armyId, rid}.

Civ module:
- src/sim/civ/rulers.js: blessRuler, curseRuler and smite helpers; death hazard reads ruler.flags.
- Succession: a marriage-union branch calling a new unifyRealms(world, heirCiv, civ) in peoples.js, using transferSettlement for each town.
- src/sim/civ/tech.js: discover(world, civ, id, 'divine') already exists; add a picker list helper.
- src/sim/civ/buildings.js: commissionWonder(world, s, kind).

Geo modules:
- src/sim/geo/diplomacy.js: marriage and feud relation flags (rel.flags.marriage, rel.flags.feud) and their opinion drift.
- src/sim/geo/war.js: casusBelli recognises 'feud' and 'claim'; army.flags.divineGoal is honoured first in chooseTarget while valid (enemy town, own besieged town, or tile), expiring at flags.goalUntil; morale and strength edits.

UI (src/ui/inspector.js): an actions section per view; a small modal picker (widgets.js) for techs, wonders and marriage partners; contenteditable or input rename with validation (1–32 characters, no markup). Renames bump versions.settlements, civs or features so labels refresh.

Data: all JSON flags on existing entities; journaled once the deeds journal exists.

Performance: hazards and flags are read in existing loops, O(1); marriages are checked only at succession, so the added sim cost is negligible. Determinism: all randomness via world.rng; acts happen at day boundaries.

**Risk:** Personal union can swallow a big realm suddenly. Gate it on the dynasty actually dying out, and allow at most one union per 100 years per realm. Renames must not break prose that uses baseName or adjective; regenerate the styled name through the government module's existing restyle function.

### tactile:fates-and-feats — Fates and Feats: goals the world offers, an optional Favor budget, and per-viewer achievements (P2, L)

**Value:** Gives purpose and stakes. 'Keep the Tribe of Paachu alive for 500 years', 'Unite the continent of Pouu under one crown', 'A century of peace on the Nielus coast', 'Bring any people to the Iron Age before Year 900'. Progress shows in the HUD and completion is a celebrated moment. With Favor turned on, every lightning bolt is a choice.

Every 200 years (and at the start), 'the threads' offer three fates tied to real entities in the current world; the player accepts any. Templates:
- Shepherd: keep civ X alive N years. Offered for the weakest civ.
- Unifier: one realm holds at least 95% of the towns on landmass L, with at least 10 towns.
- Pax: no war involving towns on L for 100 years.
- Lightbringer: any civ reaches era E by Year Y.
- Metropolis: a city of N people on L.
- Underdog: a realm with 5 or fewer towns captures the capital of a top-3 power.
- Phoenix: a new people rises on the former lands of fallen civ X within 200 years.
- Plague-bane: plague P ends having killed fewer than N.
- Purist: reach Year Y with K or fewer deeds.

An HUD chip shows the active fates with progress bars. Completion gives a Chronicle entry of importance 4 in the divine category, a bless effect and a Favor reward; failure gives a quiet entry.

Optional Genesis toggle, Challenge mode: Favor is a budget regenerating per century, and each tool costs by magnitude (an M9 quake costs more than lightning).

Achievements are per viewer, across worlds, in local storage. About 30 of them, e.g. 'Saw a city of a million', 'Ended a war with Harmony', 'Survived an impact winter', 'Five dynasties in one realm', 'Personal union', 'A prophecy fulfilled', with a gallery in the Menu.

**Implementation:** New DOM-free system src/sim/fates.js {id:'fates', order: 95}:
- State world.sys.fates = {offered: [], active: [{id, kind, args, startDay, deadlineDay, progress, status}], done: [], favor, lastOfferDay}.
- Yearly checks are O(civs + settlements); event fates use hooks settlementTransferred, civDestroyed, civCreated and warEnded.
- Reuse the unification logic from src/sim/civ/milestones.js (factor out its continent-holding helper).
- Offers are generated with world.rng from live candidates (weakest civ, largest landmass with 3 or more realms, and so on).
- Exports offerFates, acceptFate, and a favorCost(toolId, opts) used by src/core/tools.js applyTool when world.params.challengeMode is set (a new non-live param in src/core/params.js).

UI:
- src/ui/fates.js: an offer card and the HUD progress chip (hud.js).
- src/ui/achievements.js: watches chronicleSince and world state each tick and stores achievements in local storage behind a try/catch; gallery in the Menu.

Performance: about 0.3 ms per simulated year. Determinism: offers use world.rng; accepting is a journaled input.

**Risk:** Fates that are impossible or trivial. Filter candidates by feasibility (for example, Unifier only when the leading realm already holds 40–80% of the landmass's towns), and show expected difficulty.

### tactile:patron-nation — Patron: adopt a people and follow its saga (P2, S)

**Value:** Attachment. Pick one people to watch over. Their banner, ruler and fortunes sit in the HUD; every notable thing that happens to them reaches you; when they fall you get an elegy and can follow their successors. It turns a crowd of 12 nations into your story.

A 'Watch over this people' button on the nation inspector, or Alt-click a banner, sets the patron. An HUD chip shows the banner, the styled ruler name, a population sparkline, the era icon, and at-war or golden-age badges. Clicking it opens the saga.

Toasts:
- the patron's entries of importance 2 or more always show (bypassing the token bucket);
- other nations show at importance 3 or more as now.

The director favours the patron, and fates of the Shepherd type target it.

When the patron falls, an elegy card shows its lifespan, peak, rulers count and cause of fall, with options to follow a successor: civs whose parentId is the patron, the holder of its old capital, or a split-off. The saga page is the Chronicle filtered to the patron and chaptered by the storyteller.

**Implementation:** Data: world.sys.player = {patronCivId, since, lineage: [civIds]} (JSON, saved with the world). Set by an inspector button in src/ui/inspector.js civView.

UI:
- src/ui/hud.js: patron chip.
- src/ui/toasts.js: patron filter in the tick handler (entries where e.civId === patron, or where e.sid belongs to the patron).
- director.js priority bump.
- Elegy detection in the UI: the civ is no longer alive while it is still the patron; successor candidates from world.civs where parentId === patron, or the owner of world.settlements[lastCapital].
- Saga view reuses the chronicle list with a civId filter (chronicle.js already filters by selection).

Performance: none. Determinism: the patron is UI or pacing only and never read by the sim, unless a fate references it.

**Risk:** Low.

### tactile:direct-manipulation — Grab the world: drag storms (with a forecast track), send armies, cede towns, steer locusts (P2, M)

**Value:** Hands-on control. Grab a cyclone and fling it toward the coast while a dotted forecast track shows which harbours it will hit. Drag a general's march line onto an enemy capital. Drop a town onto a neighbour's land to cede it. Herd a locust swarm away from the breadbasket.

With Inspect, dragging an entity that is already selected grabs it; dragging anything else still pans, so nothing is grabbed by accident.

Storm: while dragging, a forecast track for the next 30–45 days is drawn (mean steering track plus an uncertainty cone widening with √t). Day ticks are marked, and towns inside the predicted radius get red rings and names ('Landfall at Khauthux in about 9 days'). On release, the push is applied as st.push {vx, vy, days: 20}, blended into the storm's steering so it sticks for a while and then decays.

Army: drag from the banner along its dashed path to a town or tile. A route preview comes from pathfinding; release sets army.flags.divineGoal. Chronicle: 'A vision drove the host of Urotrud the Lion toward Dritark.'

Settlement: drop it on another nation's territory, confirm with a chip 'Cede Hiki to the Kingdom of Baux?', then transferSettlement with cause 'divine'.

Locust swarm: drag to reposition or redirect.

Each release is a tool apply at a day boundary, so it is journaled and undoable.

**Implementation:** src/ui/input.js: a new 'grab' mode. In 'pending' mode, if the pick equals app.selection and the pointer moved more than DRAG_PX, enter grab instead of pan; Alt forces pan. A per-kind ghost preview goes through app.r('setGrabPreview', ...).

Renderer (src/render/entities.js): draw forecast cones, route previews and grab ghosts; pickEntity adds 'swarm' (with drawSwarms from intervention-fx-kit).

Storms (src/sim/nature/storms.js):
- export forecastTrack(world, storm, days, push) as a pure function: the same steering as stepStorm without rng noise, returning [{x, y, r, day}];
- stepStorm blends st.push into the target velocity while push.days > 0.
- A hidden tool 'steer' in weather.js.

Armies: hidden tool 'command' in war.js. Validate the target: an enemy town, the army's own besieged town, or a tile; the army must be in a war or idle. Set flags.divineGoal and goalUntil = day + 180; chooseTarget honours it first, and planPath is reused for the preview (findPath is cached and side-effect free).

Settlements: hidden tool 'cede' in src/sim/civ/tools.js: transferSettlement, markTerritoryDirty, Chronicle entry of importance 3.

Locusts: hidden tool 'herd' in disasters.js, editing swarm velocity or position.

Performance: a forecast is 45 steps O(1) each, computed while dragging (throttled 40 ms); no ongoing sim cost. Determinism: forecasts do not touch world.rng; commands are journaled inputs.

**Risk:** Players may expect armies to obey for ever. Make the expiry visible (a fading 'vision' halo on the banner), and let the AI override when the goal becomes invalid.

### tactile:postcards-and-timelapse — Postcards and time-lapse recording (P3, S)

**Value:** Share-worthy keepsakes: a framed atlas postcard of the moment Dritark fell, with a cartouche, scale bar and the Chronicle sentence as caption, or a '600 years in 60 seconds' border time-lapse video. Players love showing off their worlds.

Postcard: Menu → 'Make a postcard' (or a camera button). It enters a photo mode with the UI hidden and offers 3 frames:
- an antique cartouche with the world name, region (nearest feature), date, compass rose and a scale bar at 20 km per tile;
- a plain border;
- a wide letterbox.

An optional caption is the selected entity's one-liner or the last director caption. It renders at 2× into an offscreen canvas, then downloads a PNG (e.g. 'Onothnam-Y608-Hiki.png') or copies to the clipboard.

Live recording: record the canvas for N seconds at the chosen speed, with a date stamp burned in.

Atlas time-lapse: offscreen at 1280×800, draw the current terrain raster plus the historical borders of each history.atlas snapshot plus a year label at 8 fps, then encode to WebM. Recording and encoding both work from file://, as tested in headless Chrome.

If downloads are blocked, open the result in a modal with right-click save and Copy, as the existing export does.

**Implementation:** Renderer (src/render/renderer.js):
- captureFrame({scale}) re-renders into an offscreen canvas at the requested dpr (reusing render() with a temporary target), returning the canvas;
- setOverlay('stamp', on) draws a date stamp.

UI:
- src/ui/postcard.js: frame drawing with Canvas 2D in the map fonts, then toBlob, a download link or navigator.clipboard.write(ClipboardItem).
- src/ui/recorder.js: canvas.captureStream(30) into MediaRecorder (vp9 or vp8 WebM, with an isTypeSupported fallback); atlas time-lapse reuses the owner-grid decode and colour mapping in src/ui/atlas.js (factor its drawPlate into an export).
- hud.js menu items; a key binding (K for postcard).

Performance: capture renders one extra frame on demand; recording costs the encoder only while active. Determinism: unaffected.

**Risk:** Clipboard and download APIs may be blocked in sandboxed hosts. Always provide the in-modal fallback.

### tactile:storyteller-chapters — Storyteller: chapters, leap recaps and 'Previously on…' (P3, M)

**Value:** History reads like a saga. 'Book IV · The Bronze Thrones (Y412–Y598)', with a map plate, five headline sentences and who rose and fell. Leaping 200 years ends with 'While you were away: three chapters' instead of a one-line toast, and reopening a save greets you with a recap.

A deterministic chaptering of the Chronicle and history.

Turning points are scored:
- the first in the world to reach a new era;
- the capture of a top-3 power's capital, or wars involving 3 or more realms;
- the fall of a civ whose peak was at least 10% of world population;
- plague deaths of at least 5% of the world;
- disasters of importance 4 or more; epochal entries.

Points within 30 years are merged; chapters are at least 40 years long.

Titles come from the dominant theme in the span (category counts) and the protagonist (largest absolute population change, or most mentions): 'The Wars of the Uuzi Succession', 'The Ashen Years', 'The Golden Age of Irkarir', 'The Years of the White Fever', 'The Age of Bronze'.

Each chapter has:
- 4–6 headlines picked by importance with category diversity and at most 2 per civ;
- a rise-and-fall table from history.years (population and towns change for the top 5);
- an atlas plate from the snapshot nearest the chapter's end.

Used in a Chronicle 'Story' view toggle, a leap-arrival modal, a 'Previously on…' card when a save opens or after the tab was hidden more than 10 minutes, and per-entity biographies (a nation's saga, a city's story). Export as Markdown or text.

**Implementation:** New UI module src/ui/story.js:
- buildChapters(world, {civId?, sid?}), memoised on chronicle.seq.
- Reads world.chronicle.entries, world.history.years and world.history.atlas.
- Plate drawing reuses the atlas.js plate renderer.

Integration:
- src/ui/chronicle.js: a view toggle.
- src/main.js leapAhead: replace the arrival toast with a story modal for the span seq0..now (widgets.js modal).
- saves.js load path: the 'Previously on…' card.
- Patron saga uses the same builder with a civId filter.

Performance: O(entries) per build (6,000 entries max), done on demand; no sim cost. Determinism: derived data only.

**Risk:** Generated titles can repeat. Use template pools and a per-world dedupe set.

### tactile:deeds-journal-counterfactual — Book of Deeds and 'What if I hadn't?': an input journal, consequence tracking, counterfactual timelines and replay links (P3, L)

**Value:** See the ripples of your choices. Each deed card tracks what happened to its target over 10, 50 and 100 years. One click asks the Oracle 'what if I hadn't?' and the world is re-run without that act in the background, giving 'Two Histories': in the timeline where the star never fell, Padvaai became the greatest city of the age and Uuz never collapsed. A tiny replay file or link reproduces your exact history.

Journal: every input that changes the world is appended to world.sys.journal as compact arrays [day, tool, x, y, radius, strength, extra]: tool applies (continuous strokes coalesced into one entry holding a polyline), entity acts, grabs and commands, and live-parameter changes.

The Book of Deeds is a Chronicle filter view or a section of the Statistics tab. Each card shows the immediate effect (deaths, tiles, towns) and tracked consequences: the target civ's or town's population, territory and era, now and at +10, +50 and +100 years from history.years, plus flags such as 'the people you enlightened were first to reach the Iron Age'.

Counterfactual: choose a deed, start from the undo snapshot just before it (or the nearest autosave plus a replay of the journal), and run the same span in a Web Worker replaying every later deed except that one. It returns a summary diff:
- per-civ population, territory and era now in both timelines;
- cities that exist in only one timeline;
- wars that happened in only one;
- the top divergent headlines;
- both final atlas snapshots, shown side by side.

Replay link: genesis params, seed and journal as a small .atlas-replay.json (or a URL fragment when short). Replaying it rebuilds the identical world; the fork test showed bit-identical RNG state and population after 100 years.

**Implementation:** Data: world.sys.journal = {acts: [[day, toolId, x, y, r, s, extra]], n}. Cap at 5,000 acts, keeping deed summaries when compacting.

Recording: src/core/tools.js applyTool records when opts.journal !== false; continuous strokes are coalesced in src/ui/input.js; world.js setParam records param changes.

Replay: src/core/replay.js (DOM-free). replayTo(world, sim, journal, untilDay, {skipIdx}) steps the sim and applies acts at their day before the step, so acts land at the same point of the day as in the original run. Headless test: replaying a journal reproduces the serializeWorld hash.

Worker:
- tools/build-standalone.mjs builds a second esbuild IIFE bundle (src/worker/branch.js: core + sim systems, no render or ui) and embeds it as a string. The app spawns it with new Worker(URL.createObjectURL(new Blob([...]))). Blob workers work from file:// (verified).
- The worker runs deserialize(snapshot), replays, and posts summaries each simulated decade for a progress bar.
- A separate worker is needed because module-level caches (the path cache keyed by versions) must not be shared by two worlds in one thread.
- Fallback when workers are blocked: run sliced on the main thread only while the main sim is paused, then bump all versions so path and other caches cannot leak between worlds.

UI:
- src/ui/deeds.js: cards and a 'Two Histories' modal with two atlas plates (atlas.js plate drawer).
- saves.js: export and import of replays.

Performance: the ghost run costs about 10 s of CPU per 100 years on a medium map (headless about 100 ms per year), off the main thread; journal writes are O(1).

**Risk:** Any hidden nondeterminism (Math.random or Date in sim, iteration over objects whose key order differs) breaks replays. Add a headless CI check that replays a journal and compares hashes. Note also that tiny acts often do not diverge history at all: the lightning test left the RNG state unchanged, so it is worth showing 'no divergence' honestly.

### tactile:prophecies — Prophecies the world tries to fulfil (P3, L)

**Value:** Narrative arcs with tension. Speak 'Dritark shall burn within forty years' and feel the world lean toward it, or watch a prophet of the Hearth-Faith foretell the fall of the House of Jun and wonder whether it will come true. When it does, the Chronicle remembers who foretold it.

There are two sources:
- the player's 'Prophecy' tool in the Fate group, which opens a chooser of templates bound to the clicked target;
- autonomous oracles: about 30% of newly founded faiths' prophets, and rare ruler deathbed visions, utter one.

Templates:
- doom(civ, years): the realm falls;
- greatness(sid, years): it becomes the world's greatest city or reaches the great-city tier;
- conqueror(sid): a ruler from here captures 3 capitals;
- starfall(place, years): a meteor within 10 tiles;
- triumph(faith, years): the state religion of 3 realms;
- deluge(coast, years): a tsunami or flood strikes.

Each prophecy carries a weight w that rises toward its deadline and with the fervour of the speaker's faith. Systems read soft biases through one helper, fateBias(world, kind, id):
- war.js multiplies declaration odds against a doomed civ by (1 + 0.6w);
- stability.js adds rebellion risk;
- rulers.js multiplies the death hazard by (1 + 0.4w);
- civ growth for a 'great' city ×(1 + 0.15w), and wonder chance ×2;
- the meteor scheduler places half its strikes near a foretold spot;
- disasters bias tsunami and flood sites.

Outcomes: fulfilled gives an importance-4 entry ('As Jiur of Hiki had foretold in Year 412, Dritark fell to fire and the sword') plus a fervour boost for that faith. Failed gives an importance-2 entry, fervour falls, and the prophet may be discredited.

**Implementation:** New DOM-free module src/sim/fate.js (system order 92; monthly O(prophecies), at most 12 active):
- State world.sys.prophecy = {list: [{id, kind, args, spokenDay, deadline, speaker: {figureId?, rid?, divine?}, w, status}]}.
- Exports fateBias, speakProphecy and a monthly check.

Callers import fateBias through the guarded dynamic import pattern from SPEC §1: src/sim/geo/war.js (declare probability), src/sim/civ/stability.js, src/sim/civ/rulers.js, src/sim/civ/settlement.js (growth), src/sim/nature/meteors.js (site choice), src/sim/disasters.js.

The autonomous prophecy is added in src/sim/geo/religion.js foundReligion.

UI: a Fate-group 'prophecy' tool with a chooser modal (src/ui/widgets.js); a prophecy list in the religion and civ inspector pages; director cue on fulfilment.

Performance: under 0.2 ms per simulated year. Determinism: all through world.rng; spoken prophecies are journaled inputs.

**Risk:** Biases that are too strong make the world feel rigged. Keep w at 1 or below and the multipliers modest, and let a third to a half of prophecies fail. Tune with a headless batch that measures fulfilment rate.

### tactile:tool-flow-ergonomics — Faster hands: radial god-menu, recent tools, wheel modifiers, hold-to-charge catastrophes, and one merged deed card (P3, M)

**Value:** Fluid play. Summon any power at the cursor without travelling to the toolbelt, scrub radius with Shift+wheel, and press-and-hold a falling star to charge it (the ring fills and the rumble grows) before letting it fly. A single rich card per act replaces the duplicate toasts.

Radial menu: G, or a right-click without drag, opens a radial at the cursor. The outer ring holds the 6 groups, hovering one expands its tools, and an inner ring holds the last 6 tools used. Q and E cycle tools within the group.

Wheel modifiers: Shift+wheel sets radius and Alt+wheel sets strength, with a floating readout at the cursor and the brush circle updating live.

Hold-to-charge for single-shot catastrophes (quake magnitude, VEI, meteor size, tsunami height, storm fury): holding for 0–1.5 s sweeps strength from min to max along a filling ring, and releasing applies it. Dragging during the charge sets the meteor's entry direction (an elliptical crater rim). Touch gets the same, with a long press.

Merged deed card: the tool's status message and its divine Chronicle entry become one card with a magnitude chip, the sentence, and Undo / Inspect / Watch buttons. The Chronicle toast for the same act is suppressed.

**Implementation:** UI:
- src/ui/radial.js (new): SVG radial built from getTools() and TOOL_GROUPS, reusing the icons from src/ui/icons.js; recent tools in prefs.
- src/ui/input.js: G and Q/E keys; a contextmenu tap without movement opens the radial (right-drag still pans); wheel with modifiers calls app.setToolOption plus a readout; a charge state in beginStroke for tools with def.charge = true, with the strength computed at release. A charge ring is drawn via app.r('setBrush', {x, y, radius, charge}) (src/render/renderer.js brush drawing).
- src/ui/toasts.js: a statusToast variant 'deed' that, for 1.5 s after a tool apply, absorbs the next divine-category Chronicle entry with the same day.

Tools: set charge: true on the quake, volcano, meteor, tsunami, storm and lightning tool defs. Meteor gets an optional opts.angle, used by meteors.js crater rim asymmetry.

Performance: none. Determinism: the strength chosen is just the tool option.

**Risk:** Right-click currently pans when dragged. Only open the radial when the pointer moved less than DRAG_PX, to keep existing habits.

### tactile:sandbox-toys-artifacts — Sandbox toys: seed a vein, forge artifacts that travel through history, drop a wandering hero, raise a holy site (P4, L)

**Value:** Little seeds with big emergent stories. Drop a gold vein in empty hills and watch a rush and a war over it. Forge 'the Crown of Oskel' and follow it as it passes from conqueror to conqueror, is buried in a razed city, and is dug up a thousand years later. Drop a hero who walks the land, or a holy site that pilgrims stream toward.

1. Seed a vein (Life or Peoples group): place copper, tin, iron, gold, gems, horses, spices, salt, furs, coal or oil at a tile by setting f.resource and resourceAmt. The existing expansion site scoring and the war module's covetedResource casus belli then produce rushes and resource wars with no new sim code.

2. Artifacts: world.artifacts[] {id, name, kind: crown|blade|tome|relic|chart, power 0..1, holder: {sid?} | {buried: {x, y}}, forgedDay, history: [{day, event, sid, civId}]}.
- They are forged naturally (wonder completion, a golden-age culture figure, a great general's victory) or with a 'Forge an artifact' tool.
- Effects through civ mods: crown gives stability and legitimacy, blade military, tome research, relic faith fervour, chart navigation and tradeRange.
- Conquest carries them (settlementTransferred); razing buries them (shown as a ruin glyph); Classical-era and later civs owning the tile may rediscover them ('archaeology').
- Each has an inspector page with a provenance timeline, and Chronicle lines like 'The Crown of Oskel passed to the Uuzi with the fall of Dritark.'

3. Wandering hero (figure kind 'hero', which the culture module already creates): a 'Raise a hero' tool spawns a hero who walks between towns via pathfinding. Heroes boost morale or defence where present, can found a town or dynasty, die in battle, and can be followed with the camera.

4. Holy site: a beacon that spawns pilgrim dots along roads (cosmetic, like caravans), adds wealth and fervour to the host town, and gives a holy-war casus belli to faiths that covet it.

**Implementation:** 1. Seed a vein: a tool in src/sim/civ/tools.js (or src/gen/terraform.js) with a resource picker as the strength-select; bump versions.terrain so the resources map mode refreshes.

2. Artifacts: new module src/sim/civ/artifacts.js (monthly O(artifacts), cap 60).
- Hooks: settlementTransferred moves the holder; settlementDestroyed sets buried; wonder and figure creation sites call forgeArtifact.
- getMods in src/sim/civ/tech.js folds in held artifact effects (cached monthly, as now).
- Rendering: entities.js draws held artifacts as small glyph badges at the holder town (z ≥ 10) and buried ones as ruin markers; the inspector gets an artifact view; the kernel's addEntity can supply ids (nextId.misc, or a new 'artifact' key).

3. Hero: wandering logic in src/sim/civ/culture.js (daily movement O(heroes ≤ 10); paths via findPath with maxNodes 4000); drawn as a small standard in entities.js.

4. Holy site: world.sys.religion.holySites; pilgrims as cosmetic caravans in trade.js (kind 'pilgrim'); the casus belli in war.js.

Performance: about 0.5 ms per simulated year in total. Determinism: world.rng throughout; tool uses are journaled.

**Risk:** Artifact effects stacking on one hegemon. Cap total artifact mod bonuses per civ, and let held artifacts raise covet-driven war odds against their holder.
