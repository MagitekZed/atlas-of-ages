# Cheap speed wins (`perf/cheap-wins`)

This branch, cut from `main` at ec9ca67, makes the simulation a little faster and Max speed in the browser a good deal faster, without changing any result: every world hash equals main's. The saved state and the save format are unchanged. The tools used to check it are `tools/hashcheck.mjs` and `tools/timeab.mjs` ([development.md](../development.md#checking-speed-work)).

## What changed

| Change | Commits | What it does |
|---|---|---|
| Stable record shapes | a818490, merged in b1f5f58 | Civ, settlement and `civ.mods` records keep one V8 hidden class. `createCiv` and `createSettlement` declare the late fields as `undefined`. `normalizeWorld` rebuilds loaded records through `CIV_SHAPE` and `SETTLEMENT_SHAPE`, but only when their keys are a prefix of that order. `computeMods` and `pruneFallen` set `undefined` instead of using `delete`, and `modsOf` / `peekMods` start from `{ ...DEFAULT_MODS }`. |
| Still-map throttle at Max | 49945c2, merged in ae10f6d | At Max only, a still map is drawn every 50 ms, about every other frame, and the frames not drawn give the render's share of the frame to the sim. Every frame is still drawn while the camera moves, during input, with follow on, or while a tool is showing. No simulation code changed. |
| Review fixes | 0a941d4, fa52a36, 78b2235, fecf3d1 | Renderer, frame loop, town-plan cache and input only (below). |

An incremental territory pass was tried and dropped: σ and reach change for about 99.9% of sources on every pass, so no exact incremental scheme exists.

## Measured gains

**Headless** (`timeab`, main against the merge ae10f6d, Year 900 → 1000, one sim at a time; medians in ms per simulated year). The review fixes changed no simulation code.

| | main | branch | Change |
|---|---:|---:|---|
| Historical, 5 rounds | 164.3 | 160.1 | −2.6%, branch faster in 5 of 5 rounds |
| Mythic, 10 rounds | 178.8 | 174.1 | −2.7%, branch faster in 8 of 10 |

Religion (−11% and −14%), diplomacy (−4.5% and −2.7%) and disease (−35% and −31%) were faster in every round. Weather and climate, which the branch does not touch, were unchanged.

**Browser at Max** (headless Chrome, 1440×900, dpr 1, default UI, the two Year-900 saves; days per second, mean of 2 rounds). The branch column ran with fecf3d1's renderer and input code.

| | main | branch | Change |
|---|---:|---:|---:|
| Historical, still, fitted | 1,793 | 2,043 | +14% |
| Historical, still, zoom 14 | 1,490 | 1,851 | +24% |
| Mythic, still, fitted | 1,691 | 1,956 | +16% |
| Mythic, still, zoom 14 | 1,602 | 1,810 | +13% |
| Historical, drag | 1,759 | 1,808 | +3% |
| Mythic, drag | 1,612 | 1,742 | +8% |

On a still map the branch draws 0.47–0.49 times per frame against 1.00 on main (about 17 draws a second against 32). While dragging it draws every frame, and no frame in which the view moved was left undrawn. The first measurement, before the review fixes, gave +16% to +34% on the still map: the sim's share of the frame went from 52–63% to 66–72%, and the median frame interval stayed 33.3 ms.

## How identity was proven

**Hash matrix.** `hashcheck` against a baseline recorded on ec9ca67: PASS 12 of 12 after the merge and again after each of the four review rounds, every value equal. Both save → load → continue runs equal the direct 500-year runs.

| Case | worldChecksum | fullHash |
|---|---|---|
| atlas-medium-y500-m0 | 25a100cf | 4abb88c0 |
| atlas-medium-y500-m2 | 35ef0e97 | d16ad9cf |
| vane-medium-y500-m0 | 6fa327b9 | e3dc24e7 |
| vane-medium-y500-m2 | aafd342b | 461c8b45 |
| north-fen-medium-y500-m0 | 9efba837 | 6ac5278b |
| north-fen-medium-y500-m2 | 625afa25 | f997950b |
| deck-medium-y1000-m0 | 9e94554b | f80a883e |
| deck-medium-y1000-m2 | 1bc9dcac | 87117699 |
| atlas-medium-y400-m1 | f6748dfd | 22a90e89 |
| meadow-small-y800-m2 | e5ced0d9 | 4ce08cec |
| atlas-medium-y300+200-m0 (save, load, continue) | 25a100cf | 4abb88c0 |
| atlas-medium-y300+200-m2 (save, load, continue) | 35ef0e97 | d16ad9cf |

**Timing runs.** All 30 headless timing runs ended on main's Year-1000 states (Historical 33c64c9e / de0ecb67, Mythic 8afcbb66 / e54cc607).

**Correctness gates**, rerun after each review round with the same results as on main:

| Gate | Result |
|---|---|
| `--determinism` | FNV f2ed0fb0 with and without the myth module |
| `--rewind-test` | checksum cc11ad0c, full state fd798ad3, both sides equal |
| `--trial`, myth level 0 / 2 | f3b04378 / 4e508f8e for every save/load and keyframe replay, 0 stale shared copies |
| `--keyframe-check` | 4f1884e4 from both restore points, 420,079 shared copies verified, 0 stale |
| Build and browser smoke test | The single file built, then ran from Genesis at Max in headless Chrome: 3,600–3,900 days/s still and 2,500–2,800 while panning and zooming, 0 console errors, exceptions or app errors |

## Review rounds

Five rounds of review found regressions in the throttle; the fifth found only minor ones. Each fix changed only render, frame-loop, plan-cache or input code, and the hash matrix and gates were rerun after each.

1. **0a941d4: map effects and detail fill-in.** An undrawn frame left `world.fx` undrained, and `fx.ingest`'s 90-day staleness cutoff then dropped most of the next batch: 1,030–1,092 effects started in 20 s against main's 1,596–1,614. Now `renderer.skipFrame` takes in each undrawn frame's effects (1,643–1,675 started), and `renderer.detailPending` draws every frame until close-zoom detail has filled in, which restores main's fill-in time.
2. **fa52a36: town plans left out of date.** Round 1 made a town's shown fallback plan count as used in the plan cache, which starved waiting towns of rebuilds (up to 30 s out of date), and `detailPending` never cleared with more than 64 towns in view. Now towns that have shown an outdated plan for over 1 s get first claim on a build, and the cache holds every town in view (64 to 256 pictures): the longest wait fell to 1.1–4.1 s. Two findings were rejected: a record held across `normalizeWorld` (every caller already gets new objects) and follow lost on undo or rewind (the same on main).
3. **78b2235: ruin foundations blinked.** Ruin pictures were neither marked used nor counted in the cache size, so in dense views each town build evicted one: on average 3 to 16 ruins were missing per render. Now they are marked and counted with the towns, and at most 0.2 per render are missing, none through eviction.
4. **fecf3d1: sliced jobs, sound cues, keys.** On a still map the territory wash and borders lagged (the wash published every 2.1–2.3 s against main's 1.6–1.7 s), sound cues played up to 131 ms before their effect was drawn, and M, Esc and Tab sometimes showed a frame late. Now the draw after undrawn frames gives the sliced jobs those frames' budgets (at most 3), cues wait for that draw (p50 12–17 ms against main's 7–13 ms), and a key or click keeps every frame drawn for 250 ms (0 frames late, as on main). A fifth finding, LOD chunks rebuilt at half main's rate, was confirmed but left: matching main cost 4–14% of days/s in Terrain mode.
5. **Typing and stale cues.** Round 4's key rule also counted keys typed into a text field, so typing in Find drew every frame at Max (back to main's speed); it now ignores them and keeps the throttle on (0.48 draws per frame). Cues held for an undrawn frame were kept across a trip to Genesis and voiced on return, 2.5 s late, for effects no longer on the map; held cues more than 250 ms old are now dropped (0 voiced on return; steady state 0 duplicate and 0 lost).

## Caveats

- **The headless gain is small.** 2.6–2.7% is below the 5% that 3-round runs on a busy machine can resolve. The branch was faster in 13 of 15 paired rounds, with per-round spreads of 1–7% and a load average of 3.6–5.
- **Max on a still map trades freshness for speed:**
  - ambient animation (effects, clouds, water glints, the selection pulse) runs at about 17 fps;
  - the territory wash and borders keep main's pace in wall time, so in sim days the shown wash is about 20% older;
  - close-zoom LOD detail is rebuilt at about 17 chunks a second against 33, so from Region to Street zoom the chunk pictures are 0.8–1.6 s older;
  - a town's plan can lag its state by about 1–4 s, more with more towns in view, but never blinks out;
  - click hit boxes can be up to about 66 ms old.
- **After a camera move** every frame is drawn until detail has filled in: 0.3–1.9 s after a flight, and up to 5.5 s with 70–80 towns in view at 2560×1440.
- **Dense views cost more than the first throttle did.** At 1920×1080, zoom 18 (64 towns), the branch runs about 17% slower than ae10f6d, which left about 19 of those towns undrawn. It is still far ahead of main: 1,030–1,136 against 409–416 days/s at 2560×1440, zoom 18 and 20.
- **Drag right after a still spell:** in one pass the branch got 8–15% fewer days/s than main for the first drag after 20 s still. The likely cause, inferred rather than measured, is the render-cost running mean in `main.js`, which carries the heavier still-map draws for about 20 drawn frames. With no still spell first, drag was even.
- **Measured only in headless Chrome** with GPU raster on Apple hardware, mostly at dpr 1.
- **Shapes upkeep.** The key lists in `createCiv` / `createSettlement` (`entities.js`) and `CIV_SHAPE` / `SETTLEMENT_SHAPE` (`world.js`) must be kept in step. If they drift, results stay correct and only the speed gain is lost. Bit-identity relies on the late fields always arriving in the declared order, which no code breaks today.
- **Not this branch:** undo, redo and rewind drop the follow on main too (`installWorld` clears `app.follow` before `restoreWorld` reads it). That belongs in a fix on main.
