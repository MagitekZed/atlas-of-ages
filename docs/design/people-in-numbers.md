# People in numbers — design

Chunk 1 of the deeper-simulation plan (the Deep Dive, "the work in chunks"): **age cohorts**,
**births and deaths by people**, and **occupations**. Today a town is one number,
`s.population`, with one birth rate, one death rate and a fixed working share
(`LABOR_SHARE = 0.8`). After this change every town knows its people by age band and sex, and
by trade. Wars, plagues and famines then leave marks that age through the town for decades: the
hollow generation, the baby boom after a peace, a town of widows, too few hands for the harvest.

This chunk is the foundation for three others: Who holds power (estates are sized from
occupations), Peoples and memory (births and deaths by people), and the War machine (recruits
come from the young men).

## Goals and non-goals

- **Goals.**
  - Age structure and sex in every town, with real consequences: births depend on women of
    childbearing age, deaths on the age mix, manpower on the young men.
  - Typed movements of people (levies, migrants, settlers, the dead of a famine or a sack), so
    each flow takes the right people.
  - Occupations that replace today's fixed labour split.
  - Per-people demography in Mythic worlds: elves age five times slower and it shows.
  - Visible results in the town dossier and the Chronicle.
- **Non-goals.**
  - Individual people. This is counts in bins, never records per person.
  - Goods, prices and production chains (rated 2–3 and left out of the plan).
  - Social estates (chunk 7 builds them on top of occupations).
  - Peoples in Historical worlds (chunk 8 brings a culture mix to every town).

## Rule: societies vary

Every "who" in this design is a **rule a society can change**, never a constant in the
mechanics. This chunk ships the defaults. Later chunks vary them without touching the code that
applies them:
- conscription and labour laws in Who holds power
- peoples who fight or work differently in Peoples and memory
- religions and eras

The rules:

| Rule | Default here | Later variations (examples) |
| --- | --- | --- |
| **Who serves** (levy) | Men 15–44, 15–19 at half | All genders; a narrower or wider span; youths from 12 (child soldiers); only the unfree; only volunteers |
| **Who works** | Ages 15–64; 10–14 and 65–74 at half before era 4 | Child labour banned or required; women barred from some trades; elders working longer |
| **Births** | Women 15–44 by the fertility shape, with pairing (`PAIR_K` 1.1) | Earlier or later marriage; several wives allowed (higher `PAIR_K`); a faith that blesses large families; a people with long fertility |
| **Where people work** | The trade mix by era, bent by buildings | Caste systems; guild monopolies; trades closed to women or to a people |
| **Who practises magic** (Mythic) | The magical trades’ demand, leaning by people | Magic banned; mage castes; a faith that hunts witches |
| **Deaths** | The mortality shape, flattened by health and medicine | Peoples with different frailty by age; infant care through a faith or an era |
| **Who moves** | The `movers` shape | Nomads who move whole families; colonies of young men only |

Each rule is read through one function that takes the world, the realm and (in Mythic worlds)
the people. For example, `levyRule(world, civ, people)` returns per-band weights for both sexes.

- **Default.** In this chunk each function returns the defaults.
- **Overrides.** Later chunks register providers that override them, through the same
  `registerProvider` mechanism the myth module already uses for demography.
- **Calibration.** It is always against the default rule's reference structure, so a realm that
  levies women as well as men really does have about twice the manpower. That is a
  consequence, not a bug to tune away.

## Gates

This chunk changes history on purpose, so it is **not** bit-identical with main. It must still
hold the following.

- **Determinism.**
  - `node tools/headless.mjs --determinism`, `--rewind-test` and `--trial` pass (`npm test`).
  - Same seed and same acts give the same history.
  - At mythLevel 0, a world run with and without the myth module stays byte-identical: all
    cohort code for Historical worlds lives in `src/core` and `src/sim/civ`, and the myth module
    adds only Mythic behaviour.
- **No new randomness.** Every cohort operation is plain arithmetic; no `world.rng` draws.
  The one exception: new events roll through the existing event deck's own draws.
- **Calibration.**
  - Across the twelve `tools/hashcheck.mjs` worlds run to Year 500 and Year 1000, world
    population stays within ±10 % of main.
  - Living realms, wars started and towns stay within ±15 %.
  - Births and deaths are scaled against a reference age structure (below), so a town at that
    structure behaves exactly as today. The gate catches the drift that real age structures add.
- **Invariant.** For every live town, after each monthly pass,
  `|Σ cohorts − population| < 0.5`. A dev flag checks it every month (on in `--trial`, like
  `KEYFRAME_DEV.verify`).
- **Speed.**
  - `tools/timeab.mjs` shows at most +3 % time per sim-year at Max on a medium map at Year 800.
  - Budget: ≤ 2 ms per sim-year for the whole chunk, measured, not estimated.
- **Size.** A save grows by no more than 150 KB at Year 1000 on a medium map (about 5 MB today).

## Data

### Cohorts: `s.cohorts`

- **Shape.** A plain array of 34 numbers: 17 age bands × 2 sexes, males first.
  - Bands are five years wide (0–4, 5–9, … 75–79) plus one open band, 80+.
  - Index `b` is males of band `b`; index `17 + b` is females of band `b`.
  - Plain JSON, saved with the town.
- **Values.** Counts of people, rounded to hundredths at the end of every monthly pass. The
  rounding is part of the simulation, not the save, so a reloaded world continues exactly. The
  largest band takes the rounding remainder, so the sum still equals `s.population`.
- **Mythic worlds.** `s.cohorts` is an object of arrays, one 34-number table per people present
  in the town: `{ human: [...], elf: [...] }`, keys in `RACE_LIST` order. See "Births and deaths
  by people".
- **Truth.**
  - `s.population` stays the total every system reads: about 400 reads across the code, and
    they do not change.
  - The cohorts are its shape.
  - The invariant ties the two together; the monthly reconcile and the movement helpers below
    keep it.
- **Hidden classes.** `cohorts` and `jobs` are declared in `createSettlement` and in
  `SETTLEMENT_SHAPE` (`src/core/world.js`), in the order they arrive, like `peoples`.
- **Ruins.** A destroyed town keeps its last cohorts and never changes them again, so keyframes
  may share its copy as a closed record.

### Occupations: `s.jobs`

- **Shape.** A plain array of 11 numbers: the number of workers in each trade, in this fixed
  order.
  1. Farmers
  2. Herders and hunters
  3. Fishers
  4. Miners and quarrymen
  5. Craftsmen
  6. Merchants
  7. Soldiers (the garrison; levies away at war are counted with their army)
  8. Clergy
  9. Scholars and scribes
  10. Builders
  11. Labourers (everyone working who is not needed elsewhere)
- **Mythic worlds.** Four rare magical trades follow the eleven: mages, healers, artificers and
  beast-keepers (see "Magical trades"). So `s.jobs` has 15 entries in a Mythic town and 11
  everywhere else.
- **Values.** Hundredths, like the cohorts.
- **Sum.** It equals the working population (below). It is not part of the population
  invariant.

### Reference tables (defaults, `src/core/cohorts.js`)

All schedules are per band. In Mythic worlds they are stretched by each people's `life`
(see below). They are the **defaults** of the rules in "Rule: societies vary". The mechanics
read them only through the rule functions, never directly.

- **Mortality shape `M[b]`.** Annual risk relative to an adult of 40–44:
  - 0–4: 3.0
  - 5–14: 0.5 then 0.35
  - 15–29: 0.5, 0.7, 0.75
  - 30–44: 0.8, 0.9, 1.0
  - 45–59: 1.2, 1.5, 2.0
  - 60–74: 2.8, 4.0, 5.5
  - 75–79: 7.5
  - 80+: 12

  This is a pre-modern shape: deadly early childhood, safe youth, rising after fifty. Later eras
  flatten it through the existing `health` and `medicine`/`sanitation` mods, which already lower
  the town's death rate.
- **Fertility shape `F[b]`, women only.**
  - 15–19: 0.5
  - 20–24: 1.0
  - 25–29: 1.0
  - 30–34: 0.85
  - 35–39: 0.6
  - 40–44: 0.3
  - every other band: 0
- **Sex ratio at birth.** 1.05 boys per girl.
- **Working ages.**
  - Bands 15–64 work fully.
  - Bands 10–14 and 65–74 work at half in eras 0–3, and not at all from era 4.
  - The participation factor is set so that, at the reference structure, the working population
    is 0.8 × population: today's `LABOR_SHARE`.
- **Reference structure `REF`.** The stationary population these schedules imply. It is computed
  once when the module loads, by running the cohort step on a unit population until it settles.
  It is pure arithmetic and the same on every machine. From it:
  - `REF_FERT = Σ_b F[b]·REF_female[b]`
  - `REF_MORT = Σ_b M[b]·REF[b]`
  - `REF_WORK`, the reference working share
  - `REF_MEN`, the share of men aged 15–44

## Mechanics

### The monthly pass

`updateSettlement` (`src/sim/civ/settlement.js`) keeps its order. Cohort work slots in like
this:

1. **`reconcileCohorts`** (new, first): settles any difference between `Σ cohorts` and
   `s.population` left by writes elsewhere since last month (see "Writes from elsewhere").
2. **`seasonAndLand`**: unchanged.
3. **`foodPhase`.**
   - The working population and the farmers come from `s.jobs`, no longer from
     `pop × LABOR_SHARE`.
   - At the reference structure the numbers match today's.
4. **`demographyPhase`.**
   - Births and deaths are computed as today, then shaped by the age structure.
   - Famine deaths and emigrants are taken with profiles.
   - Ageing happens here.
5. **`healthAndEconomy`.**
   - Production reads craftsmen, miners and builders instead of `pop − foodWorkers`.
   - Commerce reads merchants.
6. **`socialPhase`, then `landUseAndGrowth`.** Unchanged, except that a labour shortage now comes
   from the farmers in `s.jobs`.
7. **`updateJobs`** (new, last): moves `s.jobs` toward this month's demand (see "Occupations").
8. **Rounding**: cohorts and jobs are rounded to hundredths.

### Births

Today's crude rate is kept, including every factor in it:
- food
- housing
- Malthusian pressure
- happiness
- the birthRate setting
- the realm's birth mod
- the town's mods
- the demography provider

It is then scaled by how many women of childbearing age the town has, compared with the
reference:

```
fert    = Σ_b F[b] · women[b] / pop
births  = birthA · pop / 12 · (fert / REF_FERT)
```

Then pairing. Births also depend on there being partners, through the **pairing** rule
(default below):

```
pairing = min(1, PAIR_K · men15to44 / women15to44) / min(1, PAIR_K · REF_RATIO)
births  = births · pairing
```

`PAIR_K = 1.1` by default: a small surplus of women still finds partners. `REF_RATIO` is the
reference structure's ratio, so the factor is exactly 1 there.

Births go into band 0: 1.05 / 2.05 to boys, 1 / 2.05 to girls.

What this does:
- A town at the reference structure gets exactly today's births.
- A town that lost a third of its young men in a war loses about a quarter of its births until
  the boys born before the war grow up. That is the second echo of the hollow generation.
- A town whose young women emigrated gets fewer births for a generation.
- **Pairing is a society rule.** Where a faith or law allows several wives, `PAIR_K` rises and a
  surplus of women costs fewer births. Where marriage is late, fertility shifts to later bands.

### Deaths

Today's crude rate is kept, including health, crowding, siege, the mortality mods and the
demography provider. It is scaled by how old the town is, and the deaths are shared out by the
mortality shape:

```
mortIdx = Σ_b M[b] · n[b] / pop
deaths  = deathA · pop / 12 · (mortIdx / REF_MORT)
dead[b] = deaths · M[b] · n[b] / Σ_b M[b] · n[b]
```

An old town dies faster and a young one slower, at the same health. Famine deaths are taken
separately with the frail profile (below), not through `M`.

### Ageing

- Each month, a fraction `1 / (60 · life)` of every band moves up one band; the 80+ band keeps
  its people until they die. `life` is 1 for humans and comes from `RACES` in Mythic worlds.
- Ageing runs after births and deaths.
- Five-year bands with monthly ageing blur a sharp gap a little: a ten-year hole spreads to about
  fifteen years after two decades. That is still plainly visible in the pyramid and in the
  numbers. One-year bands would remove the blur at five times the size and work; not worth it.

### Moving people: profiles and slices

New module `src/core/cohorts.js` (pure functions, no rng):

- **`takePeople(world, s, n, profile)`**
  - Removes `n` people shaped by the profile and lowers `s.population` by the same amount.
  - Returns a **slice**: a 34-number array, or an object of arrays in Mythic worlds.
  - If a band runs short, the shortfall moves to its neighbours.
- **`addPeople(world, s, slice)`**: adds a slice and raises `s.population` to match.
- **`slicePeople(n, profile, like)`**: makes a slice without a source, shaped like `like` or the
  reference. Used for new tribes and emerging peoples.

The profiles are weights per band and sex, applied to the town's current counts, so a profile
never takes people who are not there:

| Profile | Who | Used for |
| --- | --- | --- |
| `all` | Everyone in proportion | Floods, quakes, eruptions, falling stars, fires, collapse, cold, beasts, ruin, the default for unknown losses |
| `frail` | Children under 10 and people over 60 at ×3, others ×1 | Famine deaths, plague, locusts (the hunger after) |
| `violent` | Men 15–44 ×3, women 15–44 ×1.5, others ×1 | Sack, raid, feud, riot, a crushed rising |
| `levy` | Whoever the realm's **who serves** rule names; by default men 15–44 (15–19 at half) | Levies raised and returned, hunts against outlaws, horde riders, mercenaries who settle a town they seized |
| `movers` | Ages 15–34 ×2, children under 15 ×1, ages 35–54 ×0.6, over 55 ×0.2 | Emigrants, refugees, urban drift, colonists, settlers (the god tool too), explorers’ colonies, flight, bust, expulsion |

### Every write to population today, and its profile

| Where | What | After the change |
| --- | --- | --- |
| `civ/settlement.js` demographyPhase | births, deaths, famine, emigration | Rewritten as above; famine deaths `frail`, emigrants `movers` |
| `core/entities.js` damageSettlement | every disaster, sack, riot, plague… | Profile by `dmg.cause` per the table above; unknown causes `all` |
| `geo/war.js` levy (≈ line 1004) | levies leave the towns | `takePeople(..., 'levy')`; the slice is kept on `army.flags.levy` |
| `geo/war.js` disband (≈ line 1052) | survivors go home | The kept slice is scaled by `strength / start` and added home, aged by months away |
| `bands/hunts.js` (≈ lines 78, 219) | levies against outlaws | As war levies |
| `bands/kinds/hordes.js` (≈ line 97) | riders leave their camps | `levy` |
| `bands/combat.js` (≈ line 671) | mercenaries seize and settle a town | `addPeople` with a `levy`-shaped slice |
| `civ/stability.js` (≈ line 262) | a rising crushed | `violent` |
| `civ/civmonth.js` (≈ line 149) | urban drift between towns | `takePeople(..., 'movers')` then `addPeople` the slice |
| `civ/expansion.js` (≈ line 452) | colonists leave | `movers`; the slice founds the new town |
| `civ/expansion.js` routeMigrants (≈ line 476) | refugees placed | The famine slice is added (×0.85 as now) |
| `civ/culture.js` (≈ line 265) | an explorer’s colony | `movers` |
| `civ/acts.js` (≈ lines 85, 88) | Send Settlers tool | `movers`; returned in full if they cannot take root |
| `myth/peoples.js` (≈ lines 607, 616) | a people expelled | That people’s table, `all`, a quarter lost on the road as now |
| `createSettlement` / `foundSettlement` | new towns | Seeded with the slice they came from, or the reference shape for new tribes and peoples |

`civ.population` (`civmonth.js`) stays the sum of its towns.

### Writes from elsewhere

Other packages, future code and any write not converted yet may still change `s.population`
directly. The monthly reconcile covers them, so the invariant can never break:

- **A loss** (population below `Σ cohorts`) is taken with `all`.
- **A gain** is added with `movers`, because unexplained gains are nearly always arrivals.

Every conversion in the table above makes history truer. None of them is needed for the
invariant to hold, so the conversions can land one at a time.

### Manpower and levies

- **Manpower.** `civ.military.manpower` (`civmonth.js`) becomes:

  ```
  eligible  = Σ_towns Σ_bands levyRule(world, civ)[band, sex] · n[band, sex]
  manpower  = eligible · (0.03 / REF_ELIGIBLE) · mods.military
  ```

  `REF_ELIGIBLE` is the default rule's share at the reference structure. Under the default
  rule, at the reference structure, this is exactly today's `pop × 0.03 × military`.
  - A realm that lost a generation of young men has less manpower twenty years on, and a realm
    in a baby boom has more.
  - A realm whose rule calls more people up has more.
- **Levies.**
  - Raising an army takes the people the rule names from the towns, in today's amounts.
  - When the army disbands, the surviving share goes home in the same bands, aged by the months
    away.
  - Those who do not come back are the hole.
- **The war machine (chunk 2)** reads the same slice for its companies, so an army raised under
  a different rule fields different people (youths, women, the old).

### Occupations

- **Working population `W`.** The working-age bands times participation (above). At the
  reference structure `W = 0.8 · pop`.
- **Demand per trade**, recomputed each month from what the town already knows:
  - **Farmers:** `farmLoad · fw`, the labour today's code already asks for.
  - **Herders and hunters, fishers:** the hands that bring in today's gathered and fished food.
    Today's diminishing-returns formula is turned around to find the hands it needs.
  - **Miners:** proportional to the mine's level and the ore and strategic deposits in reach.
  - **Craftsmen:** a share of the remaining hands that grows with the realm's production mod and
    with workshops and factories.
  - **Merchants:** grows with markets, banks, harbours and trade income.
  - **Soldiers:** the garrison.
  - **Clergy:** grows with temples and the realm's religiosity.
  - **Scholars:** grows with libraries, universities and observatories.
  - **Builders:** grows with buildings under way and housing being built.
  - **Labourers:** the rest.
- **Inertia.** Each trade moves 8 % of the way toward its demand each month, and labourers fill
  any gap at once. A plague that kills a third of the farmers leaves a shortage the next
  harvest, not a reshuffle.
- **The trade mix by era (fixed).**
  - The food trades, miners and soldiers come from need, as above.
  - The hands left over are split by era. This table is the default of the **where people
    work** rule (a caste or guild law could change it later). Each row sums to 1.

  | Era | Craftsmen | Merchants | Clergy | Scholars | Builders | Labourers |
  | --- | --- | --- | --- | --- | --- | --- |
  | Stone | 0.20 | 0.02 | 0.05 | 0.00 | 0.08 | 0.65 |
  | Bronze | 0.24 | 0.05 | 0.06 | 0.01 | 0.10 | 0.54 |
  | Iron | 0.27 | 0.07 | 0.06 | 0.01 | 0.10 | 0.49 |
  | Classical | 0.28 | 0.10 | 0.06 | 0.02 | 0.11 | 0.43 |
  | Medieval | 0.30 | 0.11 | 0.07 | 0.02 | 0.10 | 0.40 |
  | Renaissance | 0.32 | 0.14 | 0.05 | 0.04 | 0.10 | 0.35 |
  | Industrial | 0.40 | 0.14 | 0.03 | 0.05 | 0.10 | 0.28 |
  | Modern | 0.38 | 0.18 | 0.02 | 0.08 | 0.09 | 0.25 |

  - **What the town has bends the mix.**
    - Each temple level adds 30 % to clergy, and the realm's religiosity trait scales clergy by
      0.6 to 1.4.
    - Each level of library, university or observatory adds 40 % to scholars.
    - Each market, bank or harbour adds 25 % to merchants.
    - Each factory level adds 30 % to craftsmen.
    - Builders double while a building is under way.
    - Labourers take up whatever the others give back, and never fall below 15 % of the
      leftover hands.
- **Keeping production and commerce as they are.** Production and commerce read the trades
  through one constant per era. Each is solved once when the module loads, from the reference
  structure and that era's mix with no buildings, so that a typical town produces and trades
  exactly what it does today. The calibration gate checks the result across whole runs.
- **What reads occupations in this chunk.**
  - **Food:** farm labour and gatherers (replacing `X.farmLabor` and `X.left`).
  - **Production:** craftsmen, miners and builders replace `nonFood`.
  - **Commerce:** merchants.
  - **Research:** the realm's research gets a small multiplier from its share of scholars,
    capped at ±10 % (replacing nothing, so it changes outcomes; calibrated in the gate).
  - Nothing else yet. Unrest by trade and the estates arrive in chunk 7.

### Magical trades (Mythic only)

A Mythic town gets four more trades after the eleven: `s.jobs` has 15 entries there, and 11
everywhere else. That keeps Historical worlds byte-identical with and without the myth module.
- **Rarity.** Every one is rare: a fraction of a percent of the working hands, never more than
  1.5 %. The workers come out of the labourers.
- **Demand.** Each grows with the mana around the town (`manaAt`) and the arcane arts its realm
  knows.
- **The Fading.** All four are multiplied by the weave of the world, so as industry thins the
  weave the magical trades dwindle with it.

| Trade | Who they are | Demand (share of working hands) | What reads them |
| --- | --- | --- | --- |
| **Mages** | Practitioners of the realm’s schools: wizards, druids of the sylvan arts, shamans, serpent-priests, and necromancers under a cruel crown | 0.4 % × mana here (up to 1) × arts known (÷ 4, up to 1.5) × (1 + 0.5 × mage-tower level) | The town’s drain on mana (replacing today’s rough "arts known × size" term, calibrated equal for a typical town); the realm’s arcane research, up to +10 % |
| **Healers** | Hedge-witches, herb-wives, gifted temple healers | 0.3 % × mana here, more where hearth-craft or the sylvan arts are known | Health up to +0.04; plague deaths down to ×0.9 at the cap |
| **Artificers** | Enchanters, rune-smiths, alchemists | 0.2 % × mana here × mine and workshop levels, where runecraft or wizardry is known | Production up to +3 %; walls’ defence up to +5 % (wards) |
| **Beast-keepers** | Tamers and keepers of great beasts | 0.1 %, only where beasts range within reach or the realm keeps a tamed one | The Tame Beast odds up to +15 %; war beasts in the War machine (chunk 2) |

- **Peoples lean toward their own arts.** These multipliers apply to the share of each people
  in the town:
  - **Elves:** healers ×2, mages ×1.5
  - **Dwarves:** artificers ×2.5
  - **Orcs:** beast-keepers ×2, mages ×1.3 (shamans)
  - **Halflings:** healers ×2
  - **Lizardfolk:** beast-keepers ×1.5, mages ×1.3
  - **Humans:** mages ×1.2 (wizardry is open to everyone)
- **Who practises magic is a society rule** like the others. A later chunk can add laws that
  ban magic, mage castes, or a faith that hunts witches.
- **Kept for later.** Mage guilds and their rivalries, and the death of the last mage in a
  realm as the Fading closes (a Chronicle event), belong to the Schools of magic idea.

### Births and deaths by people (Mythic)

- **Cohorts.** In a Mythic world each people present in a town has its own 34-number table,
  using the same bands in **life stages**: band `b` covers ages `[5b·life, 5(b+1)·life)`. An
  elf's "0–4" band is 0–24 years.
- **Rates.** Each people's births and deaths run on its own table, with its own
  `RACES[r].birth` and `mortality` in place of the demography provider's share-weighted average.
- **Ageing.** The stretch `1 / (60 · life)` makes elves and dwarves age slowly.
- **Shares.**
  - `s.peoples` is still written, as the shares of each table's total. Every reader keeps
    working.
  - The yearly share-growth step in `myth/peoples.js` (the `K_GROWTH` term) is removed: real
    births and deaths replace it.
  - The rest of that file works on tables instead of shares: migration, expulsion, turning and
    the target mix.
    - Moving people of one people takes a `movers` slice from that people's table.
    - A turning moves a slice from one people's table to another's in the same bands.
- **Visible result.** Fast-breeding peoples swamp slow ones in a few centuries. Elder peoples
  with low birth rates age and fade unless magic returns.
- **Limits.**
  - Peoples below `PEOPLES_MIN` share keep a table only while they hold at least 20 people.
    Below that they are folded into the dominant people's table.
  - This keeps the work and the save bounded: about three tables per Mythic town on average.

## Events and heat

New Chronicle entries, written by `src/sim/civ` on the town's yearly pass. All rate-limited:
once per town per 40 years, and at most three of each kind per realm per century.

| Key | When | Importance |
| --- | --- | --- |
| `people.hollow` | A town of 2,000+ in which a ten-year span of ages 15–44 holds under 55 % of the people in the spans either side, with a war or plague as the cause | 2 (3 if the realm's capital) |
| `people.boom` | Births 30 % above the town's previous decade for three years running, within ten years of a peace | 2 |
| `people.ageing` | People over 65 above 18 % of a town of 1,000+ | 1 |
| `people.hands` | Farmers below 70 % of demand for six months running; fields go fallow (the land-use rule already does this) | 2 |
| `people.widows` | Women 15–44 outnumber men 15–44 by 1.4 to 1 after a war | 2 |
| `people.youth` | Ages 15–24 above 24 % of a town of 2,000+ | 1 |

New heat tags for the event deck:
- **`youth`**, on a town or realm with a youth bulge. Raises the weights of riots, guild revolts
  and border skirmishes.
- **`elders`**, on an ageing town. Raises festivals and great works, lowers riots.

Both are small (×1.2 at most) and decay like all heat.

## Interface

- **Town dossier, new "People" section.**
  - A two-sided age pyramid: men left, women right, 17 bars, the open band on top.
  - In Mythic worlds the bars are stacked by people, in the peoples' colours.
  - Beside the pyramid: median age, children (under 15), elders (65+), working hands, and men and
    women aged 15–44.
  - Under it, the occupations as one stacked bar with labels.
  - A gap or a bulge in the pyramid that matches a recent event is labelled with it ("the war of
    Year 812").
- **Realm dossier.** The summed pyramid, plus manpower with its reason ("few young men: the
  hollow generation of the Nehevim War").
- **Statistics.** World and realm series, sampled yearly in the ledger:
  - median age
  - births and deaths per thousand
  - life expectancy at birth (computed from the death schedule)
  - the share in each trade
- **Map mode (optional, later).** "Ages": median age by town.

## Saves, keyframes and old worlds

- **Saving.** New fields are plain JSON on each town. At hundredths, 34 numbers cost about 270
  bytes per town and jobs about 90, so a medium map at Year 1000 grows by roughly 110 KB. Mythic
  towns with three tables reach about 250 KB.
- **Keyframes.** Live towns are deep-copied as now. Ruins keep fixed cohorts, so their copies
  stay shareable.
- **Old saves** (no `cohorts`).
  - `ensureSettlementFields` seeds each town from its population with the reference shape, and
    `jobs` from today's split.
  - A world loaded from an old save therefore runs a little differently from how it would have
    on the old build. That is the price of upgrading and is unavoidable.
  - A save written by the new build reloads exactly.
- **Determinism.** Rounding happens in the simulation, never only on save, so save → load →
  continue matches the continuous run (the `--trial` checks).

## Performance

- **Per town per month:**
  - reconcile: 34 operations
  - births and deaths: about 70
  - ageing: 34
  - jobs: about 60
  - rounding: 45
- **Total.** About 250 simple operations, × 300–600 towns × 12 months: well under a million per
  sim-year. Expected under 1 ms per sim-year on a medium map, against today's ~80 ms. The 2 ms
  budget leaves room for Mythic towns, which have several tables.
- **Storage.** Plain arrays of doubles (packed in V8). No allocation in the monthly pass:
  slices are scratch arrays reused per call, except for the slice kept on an army.
- **Measure, then land.** `tools/timeab.mjs` against main on the twelve hashcheck worlds before
  each phase merges.

## Build order

Each phase lands on its own branch, passes the gates, and ships.

1. **Cohorts.**
   - The `src/core/cohorts.js` module, the reference tables and the reconcile.
   - Births, deaths and ageing.
   - Manpower from the young men; levies taken and returned as slices.
   - Famine and the damage profiles.
   - The town dossier pyramid.
2. **Occupations.**
   - `s.jobs` with demand and inertia.
   - Food, production and commerce read it; scholars nudge research.
   - The occupations bar.
3. **Births and deaths by people, and the magical trades.**
   - Per-people tables in Mythic worlds, the `peoples.js` changes and the stacked pyramid.
   - The four magical trades with their readers, shown in the occupations bar in the Myth
     colour.
4. **Events and statistics.** The six Chronicle entries, the two heat tags, the ledger series and
   the realm dossier.

Tests added along the way (`tools/headless.mjs`):
- **`--cohort-check`:** the invariant, every month, for the whole run.
- **Behaviour checks:**
  - A war that takes 30 % of a town's men 15–44 leaves a trough in bands 35–49 twenty years
    later.
  - A famine kills more under-10s and over-60s than adults.
  - At the reference structure, births and deaths equal today's crude rates to within rounding.

## Decisions (2026-10-25)

1. **Children's work: yes.** Children 10–14 work at half in eras 0–3 (the default **who works**
   rule).
2. **Widows and births: yes.** Births scale by pairing (see "Births"): a town short of men has
   fewer births directly, not only through its age structure.
3. **The trade mix by era: fixed now.** The era table under "Occupations" is the default of the
   **where people work** rule. Production and commerce are held to today's levels through one
   constant per era, solved at load.
4. **Small peoples in Mythic towns: fold them in.** A people holding fewer than 20 souls in a town
   joins the dominant people's table.
5. **Magical trades: in this chunk.** Four rare trades in Mythic towns (mages, healers,
   artificers, beast-keepers), built in phase 3 with the per-people tables.
