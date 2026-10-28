# Peoples and memory (chunk 8)

How peoples regard each other and how long they hold a grudge, what each realm does with its
minorities, the great migrations, and minorities in Historical worlds too. From the Deep Dive
(chunk 8): feelings between peoples (5), how long each remembers (5), cultural distance (4),
policy toward minorities (4), waves of migration (4), with diasporas (3) and assimilation (3)
required so Historical worlds have minorities. Needs chunk 1's births and deaths by people.

## Goals and non-goals

- **Peoples have feelings.** How each people regards every other, moved by wars fought against
  or beside each other, massacres and razings, trade, royal matches and time; each forgets at
  its own pace (elves for centuries, men within a few lifetimes). Alliances run along kin lines;
  pogroms and wars between peoples follow hatred.
- **Every world has minorities.** Historical towns hold a mix of peoples, as Mythic towns hold a
  mix of races: merchant quarters, refugees, the conquered, the settlers of a conqueror.
- **Realms decide what to do with them:** equal, tolerated, taxed, persecuted or expelled, by
  their ruler, their people's feelings and their laws; tolerance draws migrants, persecution
  drives them out and breeds risings.
- **Minorities fade or hold on.** A people takes on its neighbours' tongue and ways over the
  generations, faster when the two are alike and the minority is small, slower when it is
  persecuted or clustered; a lost people may rise again.
- **Great migrations.** Crowding, hunger, a cooling climate and war push whole peoples to move:
  across borders into other realms' towns, or into empty land as wandering peoples.
- **Not in this chunk:** languages that change over time (a people's tongue is its founding
  tongue), prices and goods, disease by people (chunk 11).

## What exists today

- **Mythic peoples** (`myth/peoples.js`, `races.js`): every Mythic town holds a mix of the six
  races, each with its own age bands (chunk 1), moving by births, deaths, migration toward
  neighbours and trade partners (weighted by how welcome each race is), settlers, conquest (the
  conqueror's race gains 4–12 % by turning), and rare expulsions of a hated minority from a
  restless town. Feelings between races are a fixed table (`RACE_REL`: elves and orcs −35,
  humans and halflings +12, …). The Legends tab shows the peoples and their turnings.
- **Memory** (chunk 3, `geo/memory.js`): towns remember realms (sacked by, freed by, …) for their
  people's span (`races.js` memory: elves 200 years, orcs 25, humans 40).
- **Historical peoples:** a town is its realm's; realms that split keep their parent's tongue;
  new peoples emerge in empty land with tongues of their own (`expansion.js emergence`). No
  minorities, no feelings between peoples.
- **Migration:** a crowded or hungry town sends its young to a better-fed town of its own realm,
  or founds a camp (`expansion.js routeMigrants`); steppe hordes ride out of the grasslands
  (`bands/kinds/hordes.js`); the World setting 'Migration' scales it.
- **Faith policy:** chunk 7's faith law (one, tolerated, free); state religions and conversion.

## Rule: societies vary

| Rule | Ext point | Default |
|---|---|---|
| How long a people remembers (feelings and grudges) | `memoryRule` (exists) | by race; Historical peoples as humans |
| How a realm treats a minority people | `minorityRule` | by ruler, feelings, laws (see Mechanics) |
| How fast a minority takes on its neighbours' ways | `assimilateRule` | about three generations (see Decisions) |
| Who will move, and where to | `migrateRule` | the crowded, hungry and hunted, toward better land |
| Which peoples count as kin | `kinRule` | Mythic: races' fixed table as a start; Historical: peoples of one root |

## Data

- **Peoples** (Historical): `sys.folk = { p: [{ id, name, adj, root, born, from? }], fe: { 'a>b': n } }`.
  A people is born with each people that emerges (its first realm's tongue and name); realms
  that split keep it. A Mythic world's peoples are its races (keys 'r:elf' …), a Historical
  world's are these (keys 'f:12'); one feelings store serves both.
- **A town's mix** (Historical): `s.folk = { [id]: share }`, shares only (no age bands per
  people: those stay Mythic's, which cost a fifth of the speed); Mythic towns keep `s.peoples`.
- **Feelings:** directed, −100 to +100, kept for pairs that have met (a few hundred a world);
  faded ones are dropped.
- **Policies:** `civ.minor = { [peopleKey]: standing }` for each minority of the realm (≥ 3 % of
  its people), with the year it was set.
- **Migrations:** `sys.folk.waves` (cap 50): `{ day, from, to, people, n, why }`.
- Cultural distance between realms is worked out when needed and cached (not saved).

## Mechanics

### Feelings between peoples

- **Start:** Mythic races from today's fixed table; Historical peoples at meeting from cultural
  distance (close peoples warmer, strangers wary).
- **Moved by:** a war between their realms (each side's people sours on the other, more for a
  long or bloody war), fighting side by side (warms), a town razed or sacked (the victims' people
  sours hard on the razer's), a massacre or expulsion of a minority (its people sours on the
  persecutor's, and its kin abroad too), trade between their realms (warms a little a year), a
  royal match (warms), liberation (warms).
- **Fade** toward the starting point at the people's own memory: a grudge fades at its grudge
  span, a kindness at its thanks span (`memoryRule`).
- **Read by:** realms' opinions of each other (a pull toward the peoples' feelings), the choice
  of whom to attack and whom to ally (kin lines), minority policy, pogroms, migration (where a
  people is welcome), royal matches (chunk 9), and a town's loyalty to a crown of another people.

### Cultural distance

Between two realms, 0 to 1: their peoples (the same people 0, kin 0.3, Mythic races apart 1),
tongues (shared sounds of their languages), faiths (the same 0, a schism of it 0.5, another 1),
and customs (their eight traits). Close realms drift warmer and marry more; distance slows
assimilation and breeds fear of strangers (unrest among minorities of distant peoples).

### Diasporas (Historical mixes)

A Historical town's mix moves like a Mythic town's, by shares: migrants carry their people
(refugees, settlers, the young sent abroad), merchants settle in trade towns of their partners
(merchant quarters), a conqueror's people settles in the towns it takes, and great migrations
bring whole peoples. A people's share in a town reaches its realm's mix, its dossier, and the
realm's minorities.

### Policy toward minorities

Each minority of a realm (≥ 3 % of its people) has a standing: **equal**, **tolerated** (the
default), **taxed** (a levy on them: income up, their content down), **persecuted** (their
towns restless, their young leave, pogroms in hard times) or **expelled** (driven out: half of
them leave for kin abroad, many die on the road). Set yearly by the ruler's temperament (mercy,
piety, greed), the ruling people's feelings toward them, the realm's tolerance and faith law,
the estates (chunk 7: a clergy that wants one faith, towns that want trade), hard times
(scapegoats), and their numbers (a large minority is courted or feared). Changes are decreed and
told; persecution sours the minority's people and kin realms, tolerance draws migrants.

### Assimilation

Each generation a minority takes on its town's main people's tongue and ways at a rate (see
Decisions) × closeness (cultural distance) × a smaller share (a large minority holds on) × the
town's size (cities mix faster) × its standing (persecution hardens it; equality speeds it).
Mythic races never turn into one another by assimilation (they turn only as today, by conquest).
A people that has dwindled to nothing in its homeland may rise again in a revolt of its old towns
(a lost identity revived).

### Waves of migration

Yearly, every region (a block of the map) has a pressure: crowding (people against room),
hunger, devastation, a cooling or drying climate, and war. Where pressure is high beside a
region of good land and lower pressure, a great migration may start (see Decisions for how
often): a part of the region's people (5–15 %) moves, into the towns across the border (as
newcomers: a diaspora, unrest, sometimes war) or into empty land, founding towns of their own
(a wandering people); refugees of a fallen realm likewise. Damped: at most one wave from a
region a century, and a land that received one is slow to take another.

## Events and heat

New Chronicle entries: peoples' feelings at their worst or best ("the Varni and the Tians had
become sworn enemies"), a minority's standing decreed (taxed, persecuted, equal), a pogrom, an
expulsion (as Mythic expulsions today, now in every world), a great migration and where it
went, a wandering people founding a land, a people absorbed ("the last who spoke Varni …"), a
people reborn. The event engine's town deck reads the mix (riots between peoples, a merchant
quarter's prosperity).

## Interface

- **A town's dossier:** its peoples (Historical towns too), as Mythic towns show today.
- **A realm's dossier:** its peoples and each minority's standing.
- **A people's record:** where it lives, its realms, how it regards the others and how they
  regard it, its migrations.
- **The Peoples:** the feelings between peoples (a table for the six races; for Historical
  peoples, each one's warmest and coldest), and the great migrations.

## Saves, keyframes and old worlds

Plain JSON. Old saves: the Historical peoples are made from the realms' roots on the first yearly
pass, each town's mix starting as its realm's people; feelings start from distance. New civ and
settlement fields get their places in the record shapes (`core/world.js`, `core/entities.js`).

## Performance

Budget 1.5 ms a simulated year: the yearly town pass on shares (as Mythic's, without tables),
feelings and policies per realm yearly, migration pressure on a coarse grid yearly.

## Gates (health checks, not targets)

- Historical worlds have minorities: most realms of age hold one or two peoples besides their own.
- Minorities both fade and hold on; some peoples vanish into others over centuries.
- Persecutions and expulsions happen, but not everywhere; tolerant realms prosper from migrants.
- Great migrations a few times a world per millennium, not a flood.
- Realm and war counts stay in their usual range.

## Build order

A. Peoples and mixes: Historical peoples, town mixes, diasporas (migrants, merchants, settlers,
   conquerors), assimilation.
B. Feelings between peoples and how long each remembers; cultural distance; their effects.
C. Policy toward minorities: standings, taxes, persecution, pogroms, expulsions.
D. Waves of migration.
E. Interface.
F. Gates, the twelve worlds, speed and save size.

## Decisions (2026-10-27)

- **Historical peoples by origin, and new ones form.** Each people that emerges is a people;
  realms that split keep it; a realm long cut off from its kin (about three centuries, far away,
  with its own seat) may become a people of its own ("the Varni, of Tian stock").
- **Assimilation in about three generations:** a small minority in a big town of a close people
  is mostly absorbed in about three generations; distant, large, clustered or persecuted
  minorities hold on for centuries.
- **Policy: varied, sometimes cruel.** Most realms tolerate; some tax or persecute, mostly under
  cruel or pious rulers, between peoples who hate each other, or in hard times; expulsions and
  pogroms are rare but remembered; some realms grant equality and draw migrants.
- **Great migrations: a few per world per millennium,** damped so they reshape a frontier
  without swamping realms.
