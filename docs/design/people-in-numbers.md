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
| **Who works** | Ages 15–64; 10–14 and 65–74 at half before era 4 | Child labour banned or required; women barred from some trades; elders working longer; a desperate town sending its children and old people back to work at a cost in happiness (see "Kept for later") |
| **Births** | Women 15–44 by the fertility shape, with pairing (`PAIR_K` 1.1) | Earlier or later marriage; several wives allowed (higher `PAIR_K`); a faith that blesses large families; a people with long fertility |
| **Where people work** | The trade mix by era, bent by buildings | Caste systems; guild monopolies; trades closed to women or to a people |
| **Who practises magic** (Mythic) | The magical trades’ demand, leaning by people | Magic banned; mage castes; a faith that hunts witches |
| **Deaths** | The mortality shape, flattened by health and medicine | Peoples with different frailty by age; infant care through a faith or an era |
| **Who moves** | The `movers` shape | Nomads who move whole families; colonies of young men only |
| **How a people fights itself** (Mythic) | Each people's `strife` in `RACES`: a strength, and who dies (young men, men and women, or all ages) | A code of law or a warrior faith that tames or feeds the feuds; an era of order; a people whose women take up the blade |

Each rule is read through one function that takes the world, the realm and (in Mythic worlds,
from phase 3) the people: `ruleOf(world, key, civ)` in `src/core/cohorts.js`. For example,
`ruleOf(world, 'levy', civ)` returns per-band weights for both sexes. The keys are `levy`,
`movers`, `frail`, `violent`, `all`, `fertility`, `mortality` (34-number tables) and `pairK` (a
number).

- **Default.** In this chunk each rule returns the defaults.
- **Overrides.** Later chunks register providers at the `cohortRule` extension point (the first
  answer wins), through the same `registerProvider` mechanism the myth module already uses for
  demography.
- **Calibration.** It is always against the default rule's reference shapes, so a realm that
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
- **Calibration (a health check, not a target).**
  - Across twelve worlds (the `tools/hashcheck.mjs` seeds plus two more) run to Year 500 and
    Year 1000, the totals of world population, living realms, towns and wars stay near main
    (about ±10 % to ±15 %).
  - A single world drifts much further either way, because any change sends its history down
    another path. That is expected and is not the test.
  - The user's rule (2026-10-25): totals may move, and other larger changes are fine, if the
    worlds stay interesting and mostly successful. A world failing or nearly dying out should be
    rare but possible. So report drift honestly and fix modelling errors, without forcing the
    totals back onto main's.
  - Births and deaths are scaled against each town's reference shape (below), so a town at that
    shape behaves exactly as today.
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
- **Reference shapes.** Today's crude rates are taken to be the rates of a town whose bands have
  the shape those rates imply: the *stable* population of the default schedules with crude death
  rate `d` growing at `r = birth − death` (0 to 4 % a year), under the same monthly step the towns
  run. A fast-growing town is young, a stagnant one with low deaths is old, and each is measured
  against its own expected shape. So a town at that shape behaves exactly as today, and only a
  departure from it (a hollow, a boom, a town of widows) moves its births, deaths and manpower.
  - The shapes are tabulated once when the module loads, over 28 death rates (0.3 % to 30 %) and
    9 growth rates, and read by interpolation. Pure arithmetic, the same on every machine.
  - Per cell: `Fref = Σ F·women`, `Mref = Σ M·n` and `Eref`, the default levy rule's share, per
    head.
  - `REF`, the stationary shape at a crude death rate of 2.8 % (median age about 26), seeds new
    towns and shapes arrivals from elsewhere.
  - *Why not one fixed shape:* the first build measured every town against `REF` alone. Real
    towns are younger (growing) or older (Mythic peoples with low mortality), so births fell and
    deaths rose almost everywhere: world population ended 33 % below main and manpower 46 %
    below.

## Mechanics

### The monthly pass

`updateSettlement` (`src/sim/civ/settlement.js`) keeps its order. Cohort work slots in like
this:

1. **`reconcileCohorts`** (new, first): settles any difference between `Σ cohorts` and
   `s.population` left by writes elsewhere since last month (see "Writes from elsewhere").
2. **`seasonAndLand`**: unchanged.
3. **`updateJobs`** (new, right after the land scan, `src/sim/civ/jobs.js`): moves `s.jobs`
   toward this month's demand (see "Occupations"). It runs here, not last, so that food,
   production and commerce all read this month's trades. The reconcile counts the working hands
   in the same pass.
4. **`foodPhase`.**
   - The working population and the farmers come from `s.jobs`, no longer from
     `pop × LABOR_SHARE`.
5. **`demographyPhase`.**
   - Births and deaths are computed as today, then shaped by the age structure.
   - Famine deaths and emigrants are taken with profiles.
   - Ageing happens here.
6. **`healthAndEconomy`.**
   - Production reads craftsmen, miners and builders instead of `pop − foodWorkers`.
   - Commerce reads merchants.
7. **`socialPhase`, then `landUseAndGrowth`.** Unchanged, except that a labour shortage now comes
   from the farmers in `s.jobs`.
8. **Rounding**: cohorts are rounded to hundredths as they age, and jobs as they update.

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
births  = birthA · pop / 12 · (fert / Fref(birthA, deathA))
```

Then pairing. Births also depend on there being partners, through the **pairing** rule
(default below):

```
x       = min(1, (men20to54 / women15to44) / Pref(birthA, deathA))
used    = used + (x − used) / 1200 × (1 + 100 × drop²)   (monthly; s.flags.mates)
          drop = (used − x) / used when x < used, else 0
pairing = min(1, PAIR_K · x / used)
births  = births · pairing
```

- **Partners are men of 20–54** for the women of 15–44: husbands are usually older, and widows
  remarry older men.
- `Pref` is that ratio at the town's reference shape (a growing town has fewer men of 20–54 per
  young woman than an old one), so `x` is 1 there.
- **What the town is used to.** `used` is `x` averaged over about a century. A people that has
  long lived short of men adapts through remarriage, later marriage or more wives, but slowly: a
  war-torn realm carries the loss for generations.
  - Births come back sooner the other way: once the killing stops, the boys grow up and `x`
    itself recovers.
  - **New marriages after a great loss** (the user's idea, 2026-10-25). After a sudden loss of
    men, widows remarry and people marry across ages and families, so a town adapts faster the
    bigger the drop.
    - A slight, lasting shortage still takes about a century.
    - Losing a third of the men takes about a decade.
    - Measured in a Mythic world, dwarves had been losing a third of their births to missing
      partners (three-times-longer lives, men lost to wars and feuds). With the faster
      remarriage, they are back to their share on main.
  - *The choice (the user's, 2026-10-25):* the first version adapted over 40 years. A century
    lets wars slow a people's growth for generations, which the user preferred over keeping
    main's numbers. In the event the world totals hardly moved (population 0 % → −3 % against
    main). Most of the early shortfall had come from the levy bug (below), not from how fast
    towns adapt.
- `PAIR_K = 1.1` by default: births fall only once `x` is more than about 9 % below what the
  town is used to.
- *Why:* wars kill about as many young men as old age and illness do (in a 500-year Historical
  world, 158,000 men aged 15–44 died at war against 166,000 of natural causes). The crude birth
  rate main was tuned with already includes that ordinary loss. Measuring every town against a
  peaceful ratio cut births in nearly every town, and world population ended a third below main.
  The first build also sent every returning levy to the town where the army mustered, so the
  other towns lost their young men for good; levies now go home to every town of the realm as
  they were drawn.

Births go into band 0: 1.05 / 2.05 to boys, 1 / 2.05 to girls.

What this does:
- A town at its reference shape gets exactly today's births.
- A town that suddenly lost a third of its young men loses about a fifth of its births for a
  generation, easing as it adapts and as the boys born before the war grow up. That is the second
  echo of the hollow generation.
- A town whose young women emigrated gets fewer births for a generation.
- **Pairing is a society rule.** Where a faith or law allows several wives, `PAIR_K` rises and a
  surplus of women costs fewer births. Where marriage is late, fertility shifts to later bands.

### Deaths

Today's crude rate is kept, including health, crowding, siege, the mortality mods and the
demography provider. It is scaled by how old the town is, and the deaths are shared out by the
mortality shape:

```
mortIdx = Σ_b M[b] · n[b] / pop
deaths  = deathA · pop / 12 · (mortIdx / Mref(birthA, deathA))
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
  levyBase  = Σ_towns pop · (Σ_bands levy[band, sex] · n[band, sex] / pop) / Eref(town)
  manpower  = levyBase · 0.03 · mods.military
  ```

  `Eref` is the default rule's share at the town's reference shape, kept on `s.flags.eref` from
  its last monthly pass. Under the default rule, at the reference shape, this is exactly today's
  `pop × 0.03 × military`.
  - A realm that lost a generation of young men has less manpower twenty years on, and a realm
    in a baby boom has more.
  - A realm whose rule calls more people up has more.
- **Levies.**
  - Raising an army takes the people the rule names from the towns, in today's amounts.
  - When the army disbands, the surviving share goes home in the same bands, aged by the months
    away, to every town of the realm in proportion to its people (as they were drawn).
  - Those who do not come back are the hole.
- **The war machine (chunk 2)** reads the same slice for its companies, so an army raised under
  a different rule fields different people (youths, women, the old).

### Occupations

- **Working population `W`.** The working-age bands times participation (above). At the
  reference structure `W = 0.8 · pop`.
  - *The choice (the user's, 2026-10-25): hands follow the real age mix.* Young, growing towns
    have 70–77 % of their people working, not today's flat 80 %, and from the Medieval Age the
    children stop working at half. More fields go short of hands and growth slows. That brake is
    the honest consequence of having age bands. The alternative, holding `W` at 80 % of a town's
    expected shape, would have kept main's numbers and left the child-labour rule mattering only
    in shocks.
- **Demand per trade**, recomputed each month from what the town already knows:
  - **Farmers:** `farmLoad · fw`, the labour today's code already asks for.
  - **Herders and hunters, fishers:** the full-time share of foraging. Everyone not farming
    still forages part-time, as today, so the gathered food comes from all of them. The
    foragers counted are those today's code already subtracts from production: the food brought
    in over 0.75 of a forager's best month. (Counting only full-time foragers as the ones who
    gather would have cut the Stone Age's food by a fifth.)
  - **Miners:** proportional to the mine's level and the ore and strategic deposits in reach.
  - **Craftsmen:** a share of the remaining hands that grows with the realm's production mod and
    with workshops and factories.
  - **Merchants:** grows with markets, banks, harbours and trade income.
  - **Soldiers:** the garrison.
  - **Clergy:** grows with temples and the realm's religiosity.
  - **Scholars:** grows with libraries, universities and observatories.
  - **Builders:** grows with buildings under way and housing being built.
  - **Labourers:** the rest.
- **Inertia.**
  - The trades that take learning (miners, craftsmen, merchants, clergy, scholars, builders) move
    8 % of the way toward their demand each month, so a loss or a new building shows for a year or
    two.
  - Labourers fill the gap at once. Fields short of farmers take labourers straight away, so a
    harvest goes short only when there are no hands left (after a plague, a levy or a hollow
    generation).
  - The foragers and the soldiers follow their need each month: they are the bookkeeping of
    part-time foraging and of the garrison.
  - *Why farmers don't lag:* the first build moved farmers at 8 % a month like the rest. New
    fields then waited for farmers, and the land-use rule, which expands only when farmers stand
    above 97 % of demand, stalled. That cost about 16 points of population at Year 500 on six
    worlds. With farmers fixed at 80 % of the people, field abandonment matches main.
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
    - Markets add 30 % a level to merchants, banks 25 % a level and a harbour 20 %: today's
      commerce bonuses for those buildings, so commerce at demand matches today's.
    - Each factory level adds 30 % to craftsmen.
    - Builders double while a building is under way.
    - Labourers take up whatever the others give back, and never fall below 15 % of the
      leftover hands.
- **Keeping production and commerce as they are.** Production and commerce read the trades
  against the town's own unbuilt demand. That is the same idea as one constant per era, but
  exact for every town rather than a typical one.
  - **Production:** today's non-food term is multiplied by craftsmen, builders and labourers
    (weights 1, 0.6, 0.3) over what an unbuilt town of that era would have. Ore output is
    multiplied by the miners over the mine's demand.
  - **Commerce:** today's formula, with the merchants over an unbuilt town's in place of the
    market, bank and harbour bonuses.
  - A town whose trades stand at their demand produces and trades exactly as today. Lags, losses,
    and buildings that draw a trade (factories, markets) move it.
  - **Research:** each town keeps its scholars over an unbuilt town's (`s.flags.sch`). The realm
    multiplies research by `1 + 0.25 × (mean − 1)`, between ±10 %.
- **What reads occupations in this chunk.**
  - **Food:** the farmers work the fields (`X.farmLabor`). Everyone else forages, as before,
    out of the town's working hands rather than 0.8 × its people.
  - **Production:** craftsmen, builders, labourers and miners, against an unbuilt town's (above).
  - **Commerce:** merchants, against an unbuilt town's.
  - **Research:** the realm's research gets a small multiplier from its scholars, capped at ±10 %
    (replacing nothing, so it changes outcomes).
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
- **As built** (`src/sim/myth/trades.js`):
  - `sim/civ/jobs.js` asks the ext point `magicJobs` for the four shares, and they come out of
    the labourers.
  - The readers go through ext points owned by the civ and bands modules, which the myth module
    answers and which are neutral below mythLevel 2: `townHealth` (healers),
    `townOutput` (artificers: production and defence), `researchMul` (mages, on an arcane art),
    `taming` (beast-keepers, `bands/kinds/beasts.js`), and `damage` for plague (healers).
  - The mana drain (`mana.js`) keeps today's term and multiplies it by the town's mages over a
    plain town's, from 0.5 to 2. A tower or a people of mages draws harder, and a town where
    the weave runs thin has fewer mages to draw. That is calibrated equal for a typical town,
    as the design asked, without changing how drain grows with a town's size.
  - "Up to" means at the cap, 1.5 % of the hands. A typical town's mages, around 0.4 %, give
    about a quarter of each effect.
- **Who practises magic is a society rule** like the others. A later chunk can add laws that
  ban magic, mage castes, or a faith that hunts witches.
- **Kept for later.** Mage guilds and their rivalries, and the death of the last mage in a
  realm as the Fading closes (a Chronicle event), belong to the Schools of magic idea.

### Kept for later: desperate hands

The user's idea (2026-10-25). A town short of working hands, with fields going unworked or a
famine coming, can send its children and old people back to work.
- **Gain:** more hands now.
- **Cost:** happiness, and perhaps health and the children's later skill.
- **It is a who-works rule.** A realm's rule could allow it, forbid it, or make it its normal
  way. A crisis would raise it for a while, so it varies by society like the others.

### Births and deaths by people (Mythic)

- **Cohorts.** In a Mythic world each people present in a town has its own 34-number table,
  using the same bands in **life stages**: band `b` covers ages `[5b·life, 5(b+1)·life)`. An
  elf's "0–4" band is 0–24 years.
- **Rates.** Each people's births and deaths run on its own table, with its own
  `RACES[r].birth` and `mortality` in place of the demography provider's share-weighted average.
  - The myth module answers the ext point `peopleRates` (`races.js`) with each people's birth
    (the Fading thinning elves and lizardfolk), mortality and life. `src/core/cohorts.js` only
    applies them.
  - Each people's reference shape is read in its own stages of life: `refIndices(birth × life,
    death × life)`. An elf growing 2 % a year is a human town growing 10 % a stage-year. The
    table now covers growth up to 12 % for that.
  - What a town is used to (pairing) adapts over a century of that people's life.
- **Ageing.** The stretch `1 / (60 · life)` makes elves and dwarves age slowly.
- **The core takes either form.** Every helper in `cohorts.js` takes one table or a set of
  tables. A slice taken from a set is a set, so settlers, migrants, drifters and levies carry
  their peoples with them. Levies home go to the towns where their own people lives. Only the
  myth module makes sets, so a Historical world is unchanged with or without it.
- **Shares.**
  - `s.peoples` is still written, as the shares of each table's total. Every reader keeps
    working.
  - The yearly share-growth step in `myth/peoples.js` (the `K_GROWTH` term) is removed: real
    births and deaths replace it.
  - The rest of that file works on tables instead of shares: migration, expulsion, turning and
    the target mix.
    - Moving people of one people takes a `movers` slice from that people's table.
    - A turning moves a slice from one people's table to another's in the same bands.
- **In-fighting.** A town's pressure on births falls on all its peoples alike. Without anything
  more, whichever people's births outrun its deaths by the most gains every year in every mixed
  town. In the first build, orcs, lizardfolk and halflings swamped the rest within centuries:
  humans were down to 0–16 % of six worlds by Year 1000, and elves to 0.1–2 %.
  - So each people also fights among itself, through the ext point `strife` (w, people, civ) →
    `{ k, who }`, from `RACES[r].strife`.
  - `k × share × crowd` of that people die a year:
    - `share` is the people's part of the town.
    - `crowd` is how hard the town presses on its land: 0 below 70 % of what its land can feed,
      rising to 1 at 115 %, where births stop.
    - The more a people fills a town, and the less land is left, the more it feuds, so peoples
      settle into a lasting mix.
    - *Why crowding (the user's choice, 2026-10-25):* without it every young town, which starts
      as one people, feuded at full strength while it still had room to grow. Mythic worlds then
      held about a quarter of main's people at Year 500, with half the realms and wars at Year
      1000. Feuds over land when land runs short leave young worlds to fill up, and still check
      the fast breeders where peoples really compete.
  - `who` says who dies (the user's idea): its young men (`youngMen`), its men and women of
    fighting age (`adults`), or young and old alike (`all`). Fights among the young men leave
    widows, so they cut births as well.
  - Defaults, the most at a town wholly of that people:

    | People | `k` | Who | Why |
    | --- | --- | --- | --- |
    | Orcs | 1.2 % | adults | Clan wars and challenges; the women fight too |
    | Lizardfolk | 0.7 % | all | Brood wars take the young and the old |
    | Halflings | 0.6 % | all | Feuds between families over land and inheritance |
    | Humans | 0.3 % | young men | Brawls and blood feuds |
    | Dwarves | 0.2 % | young men | Clan grudges, settled in the halls |
    | Elves | 0.1 % | adults | Rare, cold quarrels of the old houses |

  - **The cost, chosen by the user.** In-fighting spends exactly the fast breeders' head start,
    so a Mythic world dominated by orcs and lizardfolk grows no faster than a human one.
    Population at Year 1000 ran about 45 % below main on six worlds, against −23 % with no
    in-fighting. The user kept full strength over half (−29 %, but humans thinning to 1–12 %).
  - *Tried and dropped:* counting a people's usual feuding (at a typical 80 % share of its
    town) as already part of its normal death rate, so it fought less than that as a minority.
    That handed the hardest feuders the biggest gain wherever they were few, and orcs spread
    everywhere.
  - Like the other rules, a people's strife is read every month for its realm, so a later chunk
    can let laws, faith or era change it.
- **Elves breed with the magic around them** (the user's choice, 2026-10-25).
  - Measured per people, elves faded because of their own low birth rate (58 % of a human's),
    not war. War cost them half a death per 1,000 a year, and missing partners a little more.
    They grew at a third of the human pace.
  - So elf births scale by `0.7 + 0.8 × mana` at the town, capped at 1.6: about 0.8 where the
    weave is thin, 1 at an elf town's usual mana (about 0.4), 1.34 in strong magic.
  - They thrive in the old magical forests and fade as the Fading thins the weave, on top of the
    Fading's own toll on elven births.
- **Visible result.** Fast-breeding peoples press on slow ones, until their own feuds hold them
  back. Elves hold their own where magic is strong and fade where it fails.
- **Limits.**
  - A people whose share the mix drops (below `PEOPLES_MIN`, unless just arrived or the last of
    its people anywhere) is folded into the dominant people's table, in the same bands.
  - *Why not the floor of 20 souls (decision 4):* a newcomer people arrives as half a percent
    of a town. In any town under about 4,000 that is fewer than 20 souls, so it was folded away
    the next year. Small towns never mixed, and since every world starts with small towns,
    neither did the rest: at Year 400 not one of 124 towns held a second people. The share
    floor keeps today's mixing.
  - The work stays bounded anyway: about three tables per Mythic town (3.4 in a Year-900 world
    on main), never more than six.

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

**As built (phase 4, `src/sim/civ/peoplenews.js`):**
- **The yearly check.** Each town is checked once a year, in its own month (`s.id mod 12`), and
  tells at most one mark.
  - It works from monthly tallies on `s.flags`: births this year, dead in feuds this year, and
    months running that the fields have been short of hands.
  - A boom compares the town's birth rate per head with its own ten-year average.
- **The hollow** is measured on the men alone. A ten-year span of men aged 15–44 under 60 % of
  the spans either side counts.
  - Wars kill men, and the sexes together barely showed a gap: a war that takes a third of the
    young men leaves the span only about 17 % short.
  - The cause named is the realm's bloodiest war of the last 60 years, or "the great sickness"
    if the town has known plague.
  - The hollow is kept on `s.flags.hollow`, so the pyramid marks the gap as it ages ("The gap at
    35–44: the Saqaq War.").
- **A seventh entry, `people.feuds`** (Mythic): a people's in-fighting killed 0.6 % of its town in
  a year, named for the town's main people.
- **Rate limits.** Once per town per 40 years and about three a realm a century, as designed,
  plus a world-wide limit per kind: once in 12 years for the stronger marks, once in 6 for youth,
  ageing and feuds. Without it a 600-year world told 64 tales of widows.
- **Text** is chosen by the town and the year, never by `world.rng`.
- **Youth and elders** are read straight from the age bands rather than kept as heat. The event
  weights ask `ageShares`, `youthLean` and `eldersLean` in `src/core/cohorts.js`:
  - Riots and guild revolts get × the town's youth lean ÷ its elders lean.
  - Festivals and great works get × the elders lean.
  - Border skirmishes get × the stronger youth lean of the two realms (`civ.flags.yth`, monthly).
  - The effect is the same, up to ×1.2, with no state to save or decay, and the age structure
    changes slowly enough that heat's memory adds nothing.

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

  *As built:* world series only, in the yearly record (ext `yearRecord` → `rec.people`) and three
  charts in the Statistics tab:
  - Ages: median age and life expectancy at birth, from the reference shape's hazards at the
    year's natural death and growth rates.
  - Births and deaths per 1,000, natural only. War and plague have their own charts.
  - Working hands by trade, in groups.

  Realm series would change the shape of the saved entity ledger, so the realm dossier shows the
  realm's summed pyramid and trades instead, with a reason beside its manpower ("Few young men:
  the hollow left by the Saqaq War").
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
   - Births, deaths and ageing. One table per town in every world: Mythic towns age at the human
     pace until phase 3 gives each people its own table and its own `life` stretch.
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
  - At its reference shape, a town's births and deaths equal today's crude rates (within 1 %,
    the table's interpolation).

## Phase 1 results (2026-10-25)

Built on `sim/people-in-numbers`: the cohorts, births, deaths and ageing, the profiles for every
population flow, manpower from the levy rule, levies kept and returned as slices, and the People
section of the town dossier.

- **Gates.**
  - `npm test` passes, and so does `--trial` at mythLevel 2.
  - `--cohort-check` passes: no invariant breaks, and the three behaviour checks hold.
- **Calibration**, twelve worlds against main, totals at Year 500 and Year 1000:

  | Population | Realms | Towns | Wars started | Manpower |
  | --- | --- | --- | --- | --- |
  | −3 % | +7 % | 0 % | +5 % | −11 % |

  - Single worlds range from −44 % to +53 % in population.
  - Men per woman of 15–44 run 0.77 to 1.0 across the worlds (1.05 at birth): the wars show.
  - No world came near collapse: the leanest still held 7 realms, 135 towns and 260,000 people.
  - With the 40-year adaptation the totals were 0 %, +5 %, +3 %, +14 % and −5 %.
  - It took three corrections to get here (each is described where it applies above):
    1. Each town is measured against its own reference shape, not one fixed shape.
    2. Partners are men of 20–54, against what the town is used to (over about a century).
    3. Levies go home to every town of the realm.

    The first build ran at −33 % population and −46 % manpower.
- **Speed.**
  - The cohort work costs 1.4 ms per sim-year on the 298 towns of a medium world at Year 1000:
    reconcile 0.15, births, deaths and ageing 1.05, settling 0.15.
  - Manpower adds a sum over each town's bands once a month.
  - `tools/timeab.mjs` cannot isolate this. A save loaded on the branch takes a different path
    from the same save on main (its towns are reseeded with age bands), so the two runs simulate
    different worlds. On the Mythic Year-900 save it showed +7.6 % in all, before the rounding
    was folded into ageing.
- **Size.** At Year 1000 on a medium map the age bands add 97 KB and the two new numbers per town
  (`flags.eref`, `flags.mates`) 16 KB: 113 KB in all.
- **Not yet in phase 1.**
  - The pyramid labels for a gap matched to an event moved to phase 4 with the events.
  - Mythic towns age at the human pace until phase 3.

## Phase 2 results (2026-10-25)

Built on `sim/people-in-numbers`: `s.jobs` (`src/sim/civ/jobs.js`) with demand and inertia;
food, production, commerce and research read it; the town dossier's People section gains a
trades bar under the pyramid.

- **Gates.** `npm test`, `--trial` at mythLevel 2 and `--cohort-check` all pass.
- **Calibration**, the same twelve worlds against main, totals at Year 500 and Year 1000:

  | Population | Realms | Towns | Wars started | Manpower |
  | --- | --- | --- | --- | --- |
  | −11 % | −8 % | −6 % | −5 % | −16 % |

  - Working hands run 71–81 % of the people across the worlds (80 % before).
  - Mythic worlds fall furthest, from −5 % to −55 % in population. Likely cause: long-lived
    peoples ageing at the human pace until phase 3, so their towns fill with elders who don't
    work.
  - No world came near collapse: the leanest held 5 realms, 108 towns and 274,000 people.
- **Speed.** On the 298 towns of a medium world at Year 1000:
  - The trades update costs 0.8 ms per sim-year.
  - The age bands cost 1.5 ms (their reconcile now also counts the working hands).
  - Together that is about 2.3 ms, over the 2 ms budget for the whole chunk, with phases 3 and 4
    still to come. Revisit before the chunk merges.
- **Size.** 11 numbers per town (about 30 KB at Year 1000 on a medium map, estimated).

## Phase 3 results (2026-10-25)

Built on `sim/people-in-numbers`:
- **Each people's own age bands** in Mythic towns, with per-people births, deaths and ageing
  (ext `peopleRates`).
- **The peoples module on tables:** migration, conquest, settlers and expulsion move real people,
  and the yearly share-growth step is gone.
- **In-fighting** (ext `strife`, with crowding).
- **Faster remarriage** after a sudden loss of men.
- **Elves breed with the mana** around them.
- **The four magical trades** (`src/sim/myth/trades.js`).
- **The dossier:** the pyramid stacks the peoples, and the trades list shows the magical trades.

- **Gates.** `npm test`, `--trial` at mythLevel 2 for 300–500 years (save → load → continue
  with several peoples per town) and `--cohort-check` all pass.
- **Calibration**, the twelve worlds against main:

  | | Population | Realms | Towns | Wars |
  | --- | --- | --- | --- | --- |
  | Historical, Year 500 | +10 % | −2 % | +1 % | −1 % |
  | Historical, Year 1000 | +1 % | −15 % | −6 % | −13 % |
  | Mythic, Year 500 | −36 % | −2 % | −12 % | −11 % |
  | Mythic, Year 1000 | −20 % | −23 % | −11 % | −15 % |

  - The Historical change is the faster remarriage.
  - No world came near collapse: the leanest held 4 realms, 111 towns and 339,000 people.
- **The mix of peoples**, six Mythic worlds at Year 1000, against main:

  | People | Main | Phase 3 |
  | --- | --- | --- |
  | Humans | 1.7–23.6 % | 0.7–22.7 % |
  | Elves | 2.1–7.8 % | 0.3–3.5 % |
  | Dwarves | 5.5–13.7 % | 2.1–9.2 % |
  | Orcs | 8.5–36.9 % | 0.7–29.8 % |
  | Halflings | 7–46 % | 15–50 % |
  | Lizardfolk | 18–52 % | 26–39 % |
  | Peoples per town | 3.5–4.8 | 3.0–4.7 |

  Mixing is healthy and no people runs away with a world. Elves stay a small, fading elder
  people outside strong magic. The lever if they should be stronger is the mana factor (up to
  1.6 today).
- **How the mix was reached** (each step is recorded where it applies above):
  1. Real births and deaths alone let orcs, lizardfolk and halflings swamp the rest.
  2. In-fighting at full strength balanced the mix but halved Mythic worlds.
  3. Measured per people, elves faded from their low birth rate and dwarves from missing
     partners. This led to elves following mana, and to faster remarriage.
  4. Feuds tied to crowding gave back most of the population, realms and wars.
- **Speed.** About 5.8 ms per sim-year for the age bands on a Mythic world at Year 900 (3.4
  tables a town), plus about 0.8 ms for the trades. That is roughly 4 % of a Mythic sim-year.
  A Historical world costs about 2.5 ms. Both are over the 2 ms budget: a speed pass is due
  before the chunk merges.
- **Size.** Mythic towns save one 34-number table per people present (about three).

## Phase 4 results (2026-10-25)

Built on `sim/people-in-numbers`:
- The town's people in the Chronicle (`src/sim/civ/peoplenews.js`, seven kinds).
- The youth and elders leans in the event deck.
- The world's ages, births and deaths, life expectancy and trades, in the yearly record and in
  three Statistics charts.
- The realm dossier's summed pyramid and trades, and the reason beside its manpower.
- The pyramid marks a told hollow as it ages.

- **Entries.** In a 600-year world: about 25 tales of widows and 25 of booms, ten of fields short
  of hands, three to five hollows and a few of youth, ageing and (Mythic) feuds. That is about
  one entry in eighty.
- **Gates.** `npm test` passes. So do long Mythic trials on three seeds (`deep`, `trial`,
  `amber`, 300 years) and a long Historical one.
  - They caught a phase 3 bug. The beast-keepers' demand read a "beasts near this town" answer
    cached for a year in `world.cache`, so a world continued from a save mid-year disagreed.
  - The cache is now a coarse map of beasts rebuilt once a day, at its first use. That is the
    same point of the same day in both runs.
- **Calibration**, twelve worlds against main:

  | | Population | Realms | Towns | Wars |
  | --- | --- | --- | --- | --- |
  | Historical, Year 500 | +6 % | −8 % | 0 % | −6 % |
  | Historical, Year 1000 | +5 % | −7 % | −7 % | −7 % |
  | Mythic, Year 500 | −38 % | +2 % | −14 % | −10 % |
  | Mythic, Year 1000 | −16 % | −34 % | −13 % | −24 % |

  - The leans move history a little; the rest is phase 3.
  - One Mythic world ends Year 1000 with two great realms (the meadow seed). Main has 11 there,
    and phase 3 had 9: a world where empires swallowed the rest.

## Speed pass (2026-10-25)

Found by profiling 40 years of the Year-900 saves, function by function, against main.
- **The magical trades' demand** is asked once a year per town, in its own month, and kept on
  the town (`s.flags.mj`). It is written only when there is an answer, so a Historical world
  never sees the field.
- **Feuds** die in the same pass over the bands as natural deaths.
- **Urban drift** moves people straight between the two towns' tables for each people
  (`movePeople`), with no slices.
- **A town's manpower count and youth share** come from its own monthly pass (`s.flags.lb`,
  `s.flags.yt`), so the realm's monthly pass no longer re-reads every table.
- **Ageing returns the rounded total and the largest band**, so the town's new population and
  the end-of-month settle need no further passes when nothing else moved its people.
- **Smaller fixes:** the yearly people check tests its cheap conditions first, and the school
  lookups no longer build arrays.

`tools/timeab.mjs`, 100 years from Year 900 against main (3 rounds; the two runs take different
paths, so read it with the profile):

| | Before the pass | After |
| --- | --- | --- |
| Historical | +7.1 % | **+2.6 %** (within the budget) |
| Mythic | +20.9 % | **+18.4 %** |

The Mythic cost is structural: about 3.4 tables a town, each through the births, deaths,
ageing, emigration and reconcile passes every month. Further gains need a different storage or
cadence for the minority peoples' tables. That decision is the user's.

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
