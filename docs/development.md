# Development

## Prerequisites

- **Node 24 or newer** for the headless runner, the reports and the build. The build fetches esbuild through `npx`, so the first build needs network access.
- **Python 3**, or any static file server, to serve the source to a browser.
- **Google Chrome** (optional) for `tools/zoom-perf.mjs`. Set `CHROME` to its binary if it is not at the default macOS path.

There is nothing to install: the project has no dependencies.

## Run from source

```bash
python3 -m http.server 8765 --bind 127.0.0.1    # or: npm run serve
```

Open http://127.0.0.1:8765/. The page loads `src/main.js` as ES modules, so opening `index.html` from disk does not work.

URL parameters are useful for testing and sharing. `seed`, `preset`, `size` and `set` fill in the Genesis screen. `autostart=1` skips Genesis (with the seed `atlas` unless one is given), runs `years` of history and then applies the view options (`speed` to `ui` below):

| Parameter | Example | Effect |
|-----------|---------|--------|
| `autostart` | `1` | Skip Genesis and begin at once |
| `seed`, `preset`, `size` | `kestrel`, `pangaea`, `large` | Genesis choices |
| `set` | `mythLevel:2,aggression:1.5` | Any parameters, as `key:value` pairs |
| `years` | `400` | Run this many years first (at most 5,000) |
| `speed` | `0` | Speed index, 0 (paused) to 6 (Max) |
| `mode`, `tab` | `political`, `nations` | Map mode and side-panel tab |
| `select` | `top`, `city`, `tile:120,80`, `war:active`, `civ:3` | Select something and fly to it (`focus=0` stays put) |
| `zoom` | `40` | Zoom level for the flight to the selection |
| `tool` | `rain` | Pick up a god tool by its id |
| `atlas` | `first`, `last`, `12` | Open an Atlas plate |
| `ui` | `hidden` | Hide the instruments |
| `director` | `1`, `0` | Start the Director, or never offer it |
| `theme` | `light`, `dark` | Force a theme |
| `renderer`, `gen` | `fallback` | Use the simple stand-in renderer or generator |

For example: `http://127.0.0.1:8765/?autostart=1&seed=atlas&years=400&set=mythLevel:2&speed=0`. In the console, `window.atlas` exposes the live `world`, `sim` and `renderer`, plus helpers such as `atlas.leap(100)`.

## The headless runner

`tools/headless.mjs` generates a world and simulates it in Node, with no browser. It prints vital signs as it runs. At the end it prints the cost of each system in ms per simulated year, a balance check against the targets in SPEC §9, and each system's own report.

```bash
node tools/headless.mjs --years 1000 --size medium --seed atlas    # or: npm run sim -- --years 1000
```

| Flag | Meaning |
|------|---------|
| `--years N` | Years to simulate (default 300) |
| `--seed S` | World seed (default `atlas`) |
| `--size small\|medium\|large\|vast` | Map size (default medium) |
| `--set key=value` | Set a parameter; repeatable, for example `--set mythLevel=2` |
| `--report N` | Print vital signs every N years |
| `--chronicle N` | Print the last N notable Chronicle entries (default 25) |
| `--only a,b`, `--exclude a,b` | Load only, or leave out, the systems whose paths match |
| `--gen fallback` | Use the simple generator in `tools/fallback-gen.mjs` |
| `--save file.json`, `--load file.json` | Save the world at the end, or start from a save |
| `--json file.json` | Write the metrics as JSON |
| `--hash` | Print `worldChecksum` of the final state |
| `--fullhash` | Print a hash of the whole saved state. An optimisation that must not change results must leave it equal |

The balance targets assume a medium world run for 1,000 years, so shorter runs show misses (`!!`); these are for information only. The exit code is 1 if a system threw, a field holds NaN or Infinity, or a check in a system's own report failed.

## Correctness gates

Run all three with `npm test`:

```bash
node tools/headless.mjs --determinism    # a Historical world is identical with and without the myth module
node tools/headless.mjs --rewind-test    # keyframe, act, replay: the replayed world must match
node tools/headless.mjs --trial          # random acts of every kind; save/load and keyframe replay must all agree
```

Run `--trial` at both `--set mythLevel=0` and `--set mythLevel=2` after any change to simulation state, caches, tools or the kernel. `--keyframe-check` checks that keyframes share closed records correctly over a long run. `--cohort-check` runs the age-band behaviour checks, then a normal run that checks every town's bands against its population after each monthly pass and prints the world's age structure and the people moved by each profile (see [design/people-in-numbers.md](design/people-in-numbers.md)). SPEC §10 describes each gate in full.

## Checking speed work

A change made only for speed must leave every result bit-identical: the same `worldChecksum` and `fullHash` as `main` for every world. `tools/hashcheck.mjs` runs 12 headless sims (five seeds, myth levels 0 to 2, 400 to 1,000 years, and two save → load → continue runs) and compares their hashes with a baseline. Record the baseline on `main`, then check the branch:

```bash
git switch main      && node tools/hashcheck.mjs --write-baseline    # writes .perf/baseline.json
git switch my-branch && node tools/hashcheck.mjs                     # PASS, or FAIL and the cases that differ
```

To record it from another checkout of `main`, pass its path: `node tools/hashcheck.mjs --write-baseline ../atlas-main`. `--quick` checks only the three atlas cases, `--jobs N` sets how many sims run at once (default 3), and the exit code is 1 on any FAIL. Run the correctness gates as well.

`tools/timeab.mjs` times two checkouts on the same saved worlds, one sim at a time, A and B in turn. Make the two Year-900 saves once, then compare:

```bash
mkdir -p .perf/saves
node tools/headless.mjs --years 900 --set mythLevel=0 --chronicle 0 --save .perf/saves/hist-y900.json
node tools/headless.mjs --years 900 --set mythLevel=2 --chronicle 0 --save .perf/saves/myth-y900.json
node tools/timeab.mjs ../atlas-main    # A = that checkout, B = this one; 3 rounds of 100 years per save
```

It prints the medians in ms per simulated year (the whole day loop, the sum of the systems, and each system), B against A, each side's spread, and whether every run ended on the same state. On a busy machine 3 rounds cannot tell a change under about 5% from noise: use `--rounds 5` or more, and trust the system you changed more than the total. Unless `--baseline` or `--out` say otherwise, these tools write to `.perf/`, which git ignores. [design/perf-cheap-wins.md](design/perf-cheap-wins.md) is a worked example.

## Reports

| Tool | What it checks |
|------|----------------|
| `node tools/events-report.mjs` | The event decks over five seeds × 1,000 years: event volume, pacing, variety and cost |
| `node tools/myth-check.mjs` | Mythic acceptance: survival of every race, era pacing against Historical, myth cost, mixed peoples, the human share. `--quick` runs 3 seeds × 300 years |
| `node tools/names-report.mjs` | How often generated names repeat across worlds, with targets for faiths, plagues, wars, bands, dragons, lairs and epithets |
| `node tools/zoom-perf.mjs` | Renderer performance and close-zoom sharpness in headless Chrome. `--save` loads a world saved by the headless runner instead of simulating in the browser |

The first three run their seeds in parallel child processes (`--jobs`) and accept `--set key=value`. All four exit with 1 when a check fails. The header of each file lists all its flags.

## Build the single file

```bash
node tools/build-standalone.mjs    # or: npm run build
```

This bundles every module and stylesheet into `Atlas of Ages.html`, which opens by double-click. Only the web fonts come from Google Fonts; offline, the page falls back to system fonts. It also writes `dist/artifact/index.html`, the same page as a fragment for hosts that supply their own document shell. Both outputs are ignored by git. A bundled page never finishes loading if an import cycle joins modules that wait on a top-level `await`, so avoid such cycles (SPEC §10).

## Deployment

`.github/workflows/pages.yml` runs on every push to `main`, and can also be run by hand. It installs Node 24, builds the single file, and publishes it to GitHub Pages twice: as `index.html` (the playable site) and as `atlas-of-ages.html` (the download). In the repository settings, Pages must use GitHub Actions as its source.

## Ground rules

These are short versions; [SPEC §1](../SPEC.md#1-ground-rules) has the full rules.

- **Determinism.** Generation and simulation draw every random number from `world.rng`. Never call `Math.random()` or `Date` there. The renderer and UI may use `Math.random()` for purely cosmetic effects.
- **Purity.** Tool previews, extension providers and event weights don't mutate the world or draw from `world.rng`.
- **JSON state.** Saved state on `world` is plain JSON, or a typed array in `world.f`, and refers to other entities by id. Caches go in `world.cache`, which is not saved.
- **Logged acts.** Every change from outside the daily loop goes through a logged kernel call, so that undo and rewind can replay it.
- **No DOM in the simulation.** `src/core`, `src/gen` and `src/sim` must run under Node.

Background on how the expansion was built is in [design/](design/).
