# Mixed peoples (Mythic) — contract

Today every settlement has exactly one race (`s.race`) and a realm's racial makeup can only be
read as "N elven towns". This addition gives every Mythic town a real, changing mix of peoples
and shows racial breakdowns at every level: town, realm, continent and world.

Everything here is gated on `mythOn(world)` (mythLevel 2). Historical worlds must stay
byte-identical: no new fields, no rng draws, no provider output change at mythLevel 0
(`node tools/headless.mjs --determinism` and the pre-change fingerprints must hold — see
"Gates" below). Legendary (mythLevel 1) has no races and is unaffected.

## Data (sim, owned by src/sim/myth/**)

- `s.peoples`: `{ [race]: share }`, shares in (0, 1], summing to 1 within 1e-6, only races with
  share ≥ `PEOPLES_MIN = 0.005` kept (renormalised after trimming). Plain JSON, saved. Present on
  every live settlement in a Mythic world; absent (undefined) in Historical worlds.
  *Built:* shares are rounded to 1e-6 (the largest takes the rounding, so the sum is 1), keys
  always in `RACE_LIST` order, and every write stores a **new object** (readers may cache by
  identity). A fallen town keeps its last mix.
- `s.race` stays the town's **dominant** people: the race with the largest share. It changes only
  when a challenger leads the current race by ≥ 0.05 (hysteresis), so buildings, town plans and
  identity do not flicker. Every reader of `s.race` keeps working unchanged.
  *Note for readers:* because of the hysteresis `s.race` can trail the top share by < 0.05;
  "the dominant people" is always `s.race`, not `townPeoples(...)[0]`.
- History for charts: `world.sys.myth.mix = { c: { [civId]: [[year, {race: pct}] …] }, w: [[year, {race: pct}] …] }`,
  sampled every 10 years, at most 40 samples per series (thin the oldest by halving when full),
  pct as integers 0–100. Series of realms fallen more than 100 years are dropped.
  *Built:* sampled at the myth's yearly pass (day 200) of years divisible by 10; pct are whole
  numbers that sum to 100 (largest remainder), zeros left out; thinning keeps every other
  sample of the older half.
- *Built (release gate):* `s.peoplesPast` = `[[year, {race: pct}] …]`, the town's own mix taken at its
  yearly pass of every year divisible by 10, the last 6 kept (≈ 50–60 years back), pct whole
  numbers summing to 100; a new array on every write, no rng. It feeds `townPeoplesPast` (below),
  so the town dossier's "Since Year X" survives saves, undo and rewind.
- Saves of older Mythic worlds: on init/load, any live settlement without `s.peoples` gets
  `{ [s.race]: 1 }` (or the realm's race) — idempotent, no rng.
  *Built:* `ensurePeoples` runs in the myth's wake (init after load, a mid-run raise of
  mythLevel) and on `mythAwakened` (the Awaken Magic act); a valid mix is never rewritten.
- *Built, also saved:* `sys.myth.pp` = `{ turn: {sid: day}, expel: {sid: day}, recent: { turn:
  [day], expel: [day] }, n: { turned, told, expelled, arrivals, kept, conquests }, lt: { e } }`
  (rate limits, counters, and the expulsion template told last, which the next expulsion
  avoids: the same single rng draw, so only the words change; turnings keep the plain pick,
  since one of their templates draws once more), and `world.versions.peoples`, bumped whenever what the Peoples map
  shows changes: a town's dominant people, or its second people at ≥ 25 %.

## Mechanics (myth system; yearly per town, staggered by day `(s.id * 29) % 360`)

All rates are per year and small; mixing should be visible over decades, dramatic over centuries.

1. **Founding.** A new town (settlementCreated) takes the mix of the nearest live town of the same
   realm within 30 tiles (the settlers' origin), nudged 15% toward the founding realm's race;
   otherwise `{ [s.race || civ.race]: 1 }`. A brand-new people's first town is pure.
   *Built:* `s.race` is set to the new mix's leader (a tie goes to the realm's race), so elven
   settlers from an elven town under a human crown found an elven town.
2. **Differential growth.** Each share grows with its race's demography (RACES[r].birth /
   mortality, including the Fading's effect on elves and lizardfolk), relative to the town's
   average: `share_r *= 1 + k·(g_r − ḡ)`, k chosen so a 2× birth difference shifts a 50/50 town
   by ~1 point per decade.
   *Built:* `g_r = 0.044·birth_r − 0.02·mortality_r` (the civ module's base rates), k = 0.09.
3. **Migration.** Target mix = weighted average of the peoples of neighbouring towns (within 12
   tiles, weight ∝ population / (1 + distance)) and of trade partners (active routes, weight ∝
   route value), each source race weighted by how welcome it is here:
   `welcome(r) = clamp(1 + raceRel(r, dominant)/40 + 0.3·(tolerance of the ruling realm − 0.5), 0.15, 1.6)`.
   The town moves toward the target by `m = 0.004 × (1 + 0.5·tradeLinks) × pull`, where pull
   grows with tier and prosperity (great cities 2–3×: cosmopolitan capitals).
   *Built:* route weight = 10 × route value, and the trade partners together weigh at most as
   much as the neighbours (when there are any); tradeLinks capped at 4; pull = tier factor
   (camp 0.4, hamlet 0.55, village 0.75, town 1, city 1.4, great city 2, metropolis 2.6) ×
   (0.8 + 0.4·prosperity) × 1.2 for a capital, clamped 0.3–3, prosperity = 0.6·happiness +
   0.4·tanh(wealth per head). A people absent from the town whose inflow `m × target share` is
   below `PEOPLES_MIN` arrives with exactly `PEOPLES_MIN` at odds inflow / `PEOPLES_MIN`
   (world.rng: the first families settle); larger inflows arrive as they are.
   A share that falls below `PEOPLES_MIN` is dropped — unless no other live town holds that
   people, in which case it is held at `PEOPLES_MIN` (mixing alone never ends a race).
4. **Conquest.** On settlementTransferred with cause conquest, the conqueror's race gains
   0.04–0.12 (garrison and settlers; more if the town was sacked, less if the races are kin).
   Defection and secession change nothing.
   *Built:* the mix moves toward the conqueror's race by `g = clamp(0.045 × sack × kin × size,
   0.04, 0.12)`: sack = 1 + 0.35 for a cruel ruler + up to 0.4 for an aggressive people, kin =
   0.55 when the conqueror is the town's own people or kin (raceRel ≥ 8), size = 1.15 − 0.06·tier.
   Conquest is the strongest mixer of all (250–450 conquests by Y600 in a default world), hence
   the low base.
5. **Expulsion and flight** (rare, chronicled). A minority of ≥ 20% whose race is at enmity with
   the ruling race (raceRel ≤ −20), in a town with unrest ≥ 0.45, may be driven out: its share
   halves and the people go to the nearest town where their race dominates (or are lost on the
   road). At most once per town per 60 years and a handful per century world-wide; imp 2, or 3
   in a city. Register it as a town event through `core/events.js` (`minMyth: 2`) or run it from
   the myth system — either way through world.rng and with key `myth.expulsion`.
   *Built (in the myth system):* "minority" means a minority **of the realm** — any people other
   than the ruling race at 20–80 % of the town (a minority of the town alone never occurred in
   tests: the only pairs at ≤ −20 are orcs against elves and dwarves, and such towns are
   conquered towns where the enemy people is the majority). Odds per town-year
   `min(0.45, (0.08 + 0.6·(unrest − 0.45)) × (1.3 − tolerance) × 1.6 if the ruler is cruel)`;
   at most 5 per rolling century world-wide. Half the people leave (the town's population falls
   by that many); the nearest town within 45 tiles where their race dominates takes in three
   quarters of them (its mix and population updated), the rest die on the road; with no such
   town all are lost. A turning the expulsion causes is not told separately.
6. **Turning.** When a town's dominant people changes, chronicle it (imp 2; 3 for a city or a
   capital; rate-limited), e.g. "By Year 640 Kesh had become a dwarven town; the old human
   families kept to the river quarter." Key `myth.turned`.
   *Built:* told at most once per town per century and at most 4 per decade world-wide (the
   turning itself always happens); seven templates, with the town's quarter (river, harbour,
   hill or old town), what the newcomers brought, and why they came (conquerors, settlers,
   merchants, refugees).
7. **Effects of a mix** (replace the single-race logic in races.js):
   - `demography(world, s, civ)`: birth and mortality are the share-weighted averages of the
     town's races (still with the Fading).
   - `loyalty(world, s, civ)`: Σ over races r ≠ the ruling race of `share_r × term(r)`, where
     term uses the current single-race formula (tolerance, enmity, kinship). A pure town of the
     ruling race gives 0, a pure foreign town gives today's value.
   - `raceCensus(world)`: `pop` per race = Σ population × share; `towns` = towns where the race
     dominates; `civs` unchanged.
   - Race buildings and wonders keep using the dominant race.

## Published helpers (src/sim/myth/peoples.js, re-exported from src/sim/myth/index.js)

All pure (no rng, no mutation), safe for UI calls at 4 Hz; cache per month in `world.cache`.

- `townPeoples(world, s)` → `[{ race, share }]` sorted by share (desc). Historical: `[]`.
- `civPeoples(world, civ)` → `[{ race, share, pop, towns }]` by population across the realm's
  live towns (towns = towns where that race dominates), sorted desc.
- `landPeoples(world, landmassId)` and `worldPeoples(world)` → same shape over a continent / the world.
- `peoplesHistory(world, kind, id)` → `[[year, {race: pct}] …]` for `kind` 'civ' (by id) or
  'world', from `sys.myth.mix`.
- `townPeoplesPast(world, s, years = 50)` → `{ year, items: [{ race, share }] }` (items by share,
  desc) from `s.peoplesPast`: the sample whose age is nearest `years`, between 0.8× and 1.4× it;
  `null` while the town is younger than that, or outside Mythic worlds. *(Added at the release
  gate for the town dossier; the UI's own session sampling is now only a fallback.)*
- `PEOPLES_MIN`.

*Built:* the realm / continent / world summary is one pass over the live towns, cached in
`world.cache` by month, `versions.settlements` and `versions.peoples` (so a transfer or a
turning shows at once; shares drift within the month). `civPeoples` takes a civ or its id;
`landPeoples` takes a `world.f.landmass` id; each returns fresh item objects (safe to keep).
`townPeoples` reads `s.peoples` directly (a dead town: its last mix). `peoplesHistory` returns a
shallow copy (do not edit the samples). The sim never reads these caches (its own samples are
computed fresh), so UI calls cannot change a world. For tests and reports, peoples.js also
exports `mixStats(world)` and `peoplesCounts(world)` (not re-exported).

## UI and render (src/ui/**, src/render/**)

- **Town dossier** (Mythic): a "Peoples" block — a stacked bar in race colours (RACE_META colour)
  with each race's share and approximate headcount, the dominant people named, kin/enmity notes
  ("elves and orcs share this town uneasily"), and the change over the last 50 years when known.
- **Nation dossier**: "Peoples of the realm" — stacked bar by population, each race with %, the
  towns where it dominates, the ruling race marked, and a small chart of the makeup over time
  from `peoplesHistory`.
- **Nations ledger** (Mythic): a compact peoples bar per nation; sortable by its leading race's share.
- **Legends tab**: world and per-continent breakdowns, and a table of nations with their bars.
- **Hover card** for towns and nations: the top two or three peoples with %.
- **Peoples map mode**: shade territory by the dominant people of each tile's controlling town, with
  mixed towns visibly blended (e.g. hatching or a second hue for a minority ≥ 25%).
- **Town plans** (should): a town with a second people at ≥ 25% gets a quarter drawn in that
  people's style (e.g. a halfling lane of smials inside a human city, an elven grove quarter).
- All of this hidden in Historical and Legendary worlds; works at 390×844 and in both themes.

## Gates

- Historical fingerprints unchanged: `node tools/headless.mjs --years 300 --size medium --seed S --hash --fullhash`
  for S = atlas, kestrel, north-fen-795 must print the values recorded before the change
  (atlas 5d6fd902 / 5f52dd43, kestrel 491c2b53 / bce335bf, north-fen-795 115e90c4 / b9414ee0).
- `--determinism`, `--rewind-test`, `--trial`, save → load → continue `--hash` at mythLevel 2.
- `tools/myth-check.mjs` passes, with new checks: shares valid on every town; by Y600 at defaults
  at least 25% of towns have a minority ≥ 10% and at least one city has three peoples ≥ 10%;
  no race vanishes from the world purely through mixing; myth ≤ 8 ms per sim-year.
- Browser: the new blocks render in a Mythic world on desktop and phone, hidden in Historical.

*Sim results (3 seeds × 1000 years, medium, defaults; `node tools/myth-check.mjs --seeds 3`):*
all three fingerprints unchanged; `--determinism` ok; `--rewind-test` ok at mythLevel 0 and 2;
`--trial` ok at mythLevel 0 and 2 (60 years, and 220 / 320 years on kestrel / north-fen-795);
save → load → continue `--hash` equal at mythLevel 2 (kestrel Y250 → Y400, north-fen-795
Y400 → Y520); the Awaken Magic path (a Historical world woken at Y100) equal straight, saved
right after the act and replayed from a keyframe before it. myth-check (canonical module order):

| seed | towns with a minority ≥ 10 % (Y300 / Y600 / Y1000) | cities with three peoples ≥ 10 % (Y600 / Y1000) | turnings per century (told) | expulsions per century |
|------|------|------|------|------|
| atlas | 3 % / 43 % / 75 % | 9 / 34 | 5.8 (5.7) | 0 |
| kestrel | 18 % / 61 % / 56 % | 2 / 42 | 2.8 (2.6) | 2.2 |
| north-fen-795 | 7 % / 48 % / 67 % | 2 / 18 | 4.0 (3.6) | 3.5 |

Y600 mean 50 % (gate ≥ 25 %); every race alive in every seed, none lost to mixing; myth 5.8 ms
per sim-year (6 parallel jobs; 5.6 isolated on north-fen-795, the busiest), the peoples pass
≈ 1.6 of it; major Myth & Magic entries 5.3 per century (3–15). Three-people cities at Y600:
"dwarf 74 / lizardfolk 16 / halfling 10", "halfling 52 / orc 29 / human 17", "human 57 / dwarf 15
/ orc 11 / lizardfolk 9 / halfling 8".
Mixing is slow while peoples live apart (Y300) and grows with contact and war; conquest is the
strongest mixer.

*Module order:* hook handlers run in registration order, so a harness must import myth modules
**after** `loadSystems` (as headless and myth-check do); importing `src/sim/myth/index.js` or
`peoples.js` first registers their hooks (and, through the guarded import, trade's) earlier
and makes a different world. The browser loads sim modules from the UI's own imports first and
already made different worlds from Node before this change (Historical kestrel Y300: browser
d41ec19b with the old and the new code, Node 491c2b53).

*Release gate (final code, the rebuilt single file):* the three Historical fingerprints unchanged;
`--determinism` ok on atlas (4dd45e47) and kestrel (b1afe5e8); `--rewind-test` ok at mythLevel 0
and 2; `--trial` ok at mythLevel 0 (60 and 120 years) and 2 (60 and 220 years), 0 stale copies;
save → load → continue equal at mythLevel 0 (kestrel Y150 → Y250) and 2 (kestrel Y250 → Y400,
north-fen-795 Y400 → Y520 across 11 expulsions); a Historical 1000-year run prints the same
Balance block and worldChecksum (atlas e52ff4af) as the pre-change code. Mythic worlds evolve as
the sim half left them (kestrel Y400 5c6b6791, north-fen-795 Y520 9b1f9a47): `s.peoplesPast` and
the expulsion template memory change no draw. myth-check 3 × 1000 years: every peoples check
passes with the numbers above; myth 6.2 ms per sim-year isolated on north-fen-795 to Y1000 (the
6-job figure, 8.55, was taken while other apps loaded the machine: whole sim 239 ms/yr against
163 in the sim half's run). In the browser (file://, Chrome) a Historical and a Legendary world
are byte-identical to the pre-change build on desktop and phone, and a Mythic world is the same
on desktop and phone and across runs.
