# Temperament drift, human identity and wider names — contract

The user asked for three things:
- make each people's temperament drift with its history
- give humans a sharper identity
- widen the fixed name phrases so they repeat less across worlds

This doc is the shared contract for the four builders and the gate.

## 1. Temperament drift (all worlds; owner: src/sim/civ/**)

Every civ has eight temperament traits in `civ.traits` (0–1): aggression, expansion,
religiosity, commerce, innovation, tolerance, militarism, isolation. Today they are fixed at
birth. From now on they drift with what the people live through, in Historical and Mythic worlds alike.

**State** (plain JSON, saved; filled for older saves by the civ module's init):
- `civ.flags.temper0`: the temperament the people was born with (baseline for reversion).
- `civ.temperLog`: the last 24 notable shifts, `[{ day, trait, from, to, cause }]`, where cause is a
  short key (`war`, `defeat`, `conquest`, `peace`, `trade`, `plague`, `famine`, `golden`, `dark`,
  `faith`, `ruler`, `contact`, `mixing`, `industry`, …).
- `civ.flags.temperHist`: a sample of all eight traits every 25 years, `[[year, [8 numbers 0–100]]]`,
  at most 40 samples (thin the oldest by halving).

**Model** (yearly per civ, staggered; deterministic; no new rng draws unless needed for prose):
- Signals from the past year, measured from state the sim already keeps:
  - war months, battles won and lost, towns taken and lost, devastation, war weariness
  - trade income per head, number of trading partners and contacts
  - plague and famine deaths as a share of people
  - golden or dark age; wonders; discoveries
  - state-faith zeal and tenets (militant, tolerant, pacifist, mercantile…)
  - the ruler's personal traits (warlike, scholarly, pious, greedy, just, cruel…) over a long reign
  - era (industry and reason slowly lower religiosity)
  - in Mythic worlds, the share of other peoples in the realm (peaceful mixing raises tolerance;
    expulsions and enmity lower it)
- Each signal nudges specific traits, for example:
  - victories and conquest raise aggression and militarism; long, losing or ruinous wars lower aggression and raise isolation (war-weariness)
  - long peace lowers militarism
  - prosperous trade raises commerce and tolerance
  - plague and famine raise religiosity
  - golden ages and discoveries raise innovation; dark ages lower it
- `delta = adapt × Σ signals`, capped at ±0.03 per trait per year. Reversion toward `temper0` at
  about 1.5% of the gap a year keeps peoples recognisable, and traits stay in [0.05, 0.95].
- `adapt` is the race's drift multiplier: read `RACES[civ.race]?.adapt` from
  `src/sim/myth/races.js` through a guarded import (default 1; Historical civs have no race → 1).
- **Damping is mandatory:** no runaway loops (war → aggression → more war). War weariness and
  defeats must pull aggression down. Keep the SPEC §9 balance targets, notably the typical civ at
  war 15–35% of its life, nations alive 5–25 and war ≤ 40% of imp≥2 entries.
- **Chronicle:** when a trait has moved ≥ 0.15 from its value 50 years earlier, or crosses into a
  named band, write one imp-2 entry with the cause. For example:
  - "Two generations of war had hardened the Varathi; they had become a warlike people."
  - "Decades of trade had made the Oskeli a nation of merchants."

  Use key `temper.shift`, ref to the civ, and several templates per trait × direction × cause. Rate
  limits: per civ per trait once per 60 years, and at most ~3 a decade world-wide.
- **Published helpers** (pure; exported from `src/sim/civ/temper.js`):
  - `temperBands(traits)` → `{ trait: 'band label' }`. Five bands with edges 0.2 / 0.38 / 0.62 / 0.8
    (a value on an edge belongs to the band above it), e.g. aggression 0.85 → 'warlike', 0.7 →
    'combative', 0.5 → 'even-tempered', 0.3 → 'mild', 0.15 → 'peaceable'
  - `temperShifts(world, civ)` → the log plus `temperHist`, for the UI
  - `TEMPER_LABELS`: the human words for each trait and band

## 2. Human identity (Mythic; owner: src/sim/myth/**)

Humans are currently the neutral baseline: no temperament offsets and tiny bonuses. Give them a
distinct identity: **the adaptable, ingenious, restless people**, without making them dominate.

- **Temperament:** innovation +0.12, expansion +0.08, commerce +0.05. Their seeded jitter is wider
  (×1.4), so human peoples differ more from one another than other races do.
- **`adapt`:** add an `adapt` field to every race in RACES. Humans 2.0: their temperament drifts
  twice as fast ("the people who change"). Elves 0.5, dwarves 0.6, lizardfolk 0.7, halflings 0.8,
  orcs 1.0.
- **Ingenious:**
  - research +6% (up from 3%)
  - techs known by contacted or trading peoples cost humans notably less: learning from others,
    through a mods key or provider, capped
- **Cosmopolitan:** human-ruled realms gain research and trade from the share of other peoples in
  their towns (use `civPeoples`), capped at about +10%.
- Optionally a human building or wonder (e.g. academy, guild hall) through registerBuildings or
  registerWonders, if it fits the existing data.
- Update the race blurb and anything that describes humans.
- **Balance** (tools/myth-check.mjs):
  - every race alive in ≥ 60% of seeds
  - era pacing within ±25% of Historical
  - human share of world population at Y1000 not above ~45% at the default raceMix

## 3. Wider names (owners: see below)

Many names come from short fixed tables, so the same phrases repeat across worlds: "the Faith of
the Pale Lady", "the Grey Cough", "the Merchants' War", "the Red Hoods", dragon epithets, lair
forms, town epithets, ruler epithets, dynasty forms. Replace short lists with **combinatorial
generators**:
- structure × themed adjective × themed noun, with generated words from the people's own language
  where they fit (gods, saints, places)
- doctrine-, race-, culture- and era-appropriate vocabularies
- several hundred distinct outcomes per kind

Keep within-world uniqueness where it exists today. Keep names grammatical: articles, plurals,
"the" handling.

Owners:
- **src/sim/geo/** (religion, disease, war), **src/sim/bands/** (outlaws, pirates, companies, dragon
  names, epithets and lairs, beasts), **src/sim/nature/** and **src/sim/weather.js** (storm and fire
  names), **src/sim/events/** (town epithets, legends, event names), **src/gen/features.js**
  (feature names), **src/core/names.js** (shared generator helpers, if any): the names builder.
- **src/sim/civ/**: ruler epithets, dynasty forms, government styles, figure titles. These belong
  to the drift builder, who owns civ.
- **src/sim/myth/**: race titles and realm styles, ley-node and arcane names. These belong to the
  human-identity builder.

**Measure it:** `tools/names-report.mjs` generates N worlds (default 20 seeds × 600 years, both
levels) and reports, per kind, the share of names that also appear in another world, plus the most
repeated names. Record the before numbers first.

Targets:
- faiths, plagues, wars, outlaw/pirate bands, dragons and their lairs: fewer than 10% of names
  shared with another world
- epithets (rulers and towns): fewer than 25% shared

## 4. UI (owner: src/ui/**)

- **Nation dossier:** a "Temperament" block. Each trait gets a bar with its band word ("warlike",
  "mercantile"…), a faint marker at the founding value, and an arrow when it moved recently. Below
  it, a short list of the latest shifts with causes and years, linked to their chronicle entries,
  and a small chart of the traits over time from `temperHist` (pick the traits that moved most).
- Hover cards and the nations ledger may show the two strongest bands ("warlike · pious").
- Mythic Legends race cards: the human identity text and each race's drift speed in plain words
  ("change quickly", "slow to change").
- Hidden where data is absent; works in both themes and at 390×844.

## Gates

- `--determinism`, `--rewind-test`, `--trial`, save → load → continue `--hash` at mythLevel 0 and 2.
- Historical histories change by design. Instead of fingerprints:
  - a 5 seeds × 1000 years batch at defaults
  - a 3-seed batch at mythLevel 2
  - all of these must meet SPEC §9, the events-report targets and myth-check
- Drift sanity:
  - by Y1000 the typical civ has at least one trait ≥ 0.15 from its birth value
  - no trait is pinned at 0.05 or 0.95 for more than 20% of civ-years
- `tools/names-report.mjs` meets the targets above.
- Performance: whole sim ≤ 150 ms per sim-year at Y1000 idle (drift ≤ 1 ms).
- Browser: the Temperament block and the race cards render on desktop and phone, with a clean console.
