# Health and sickness (chunk 11)

How each people, custom and faith keeps itself well or falls ill, so plagues and everyday
sickness fall unevenly, and towns, armies and courts sicken by how they live. From the Deep Dive
(chunk 11): peoples and sickness (4), customs of cleanliness (4), healing faiths (4), physicians
and their theories (3), housing and sanitation (3), fever country (3), camp sickness (3). Needs
chunk 1's births and deaths by people and chunk 2's armies, both live; uses chunk 8's peoples.

## Goals and non-goals

- **Plagues fall unevenly.** A plague takes one people of a town and spares another, by each
  people's nature (Mythic: elves seldom, orcs often), the hardiness old plagues left behind, and
  whether it has ever met the sicknesses of the people who carry this one. A sickness newcomers
  bring can be one the natives cannot bear.
- **How a people lives decides how it sickens.** Each people keeps a custom of cleanliness
  (bathing, ritual washing, wells kept apart from the middens, or a fear of water); its faith
  teaches what sickness is and what to do about it; its realm's physicians hold a theory, right in
  some things and wrong in others. Customs and theories change with plague, reform and neighbours.
- **Where and how a town is built matters.** Slums breed sickness and fire; stone and sewers
  guard against both. Marshes and hot wet lowlands keep a fever alive that natives bear and
  newcomers die of, until the marsh is drained.
- **Armies sicken.** Camp fever grows with the size of the host, the length of the campaign, a
  siege's lines, hunger, summer and the army's own customs; before modern medicine it can take
  more men than battle, and soldiers carry it home.
- **The player can see why.** A town's dossier says why it is healthy or sick (its crowding,
  water, customs, faith, physicians and peoples); a plague's account names whom it spared and why.
- **Not in this chunk:** a pool of diseases with animal reservoirs and mutation (rated 3, left
  for later), crops and blights, wells and groundwater, prices.

## What exists today

- **Plagues** (`geo/disease.js`): named strains with SIR dynamics per town every 5 days; they
  emerge in crowded unhealthy towns, among herders, at first contact between realms (a contact
  plague, lethality at least 0.1), and as returns of old strains. Infection is faster in a big,
  unhealthy town and slower with sanitation; deaths scale with the strain's lethality, the
  realm's medicine and plague resistance, the town's health, famine, and a 'healing' tenet
  (× 0.8). Immunity is kept per town (`s.immunity[pid]`) and wanes. Sickness travels to nearby
  towns, along trade routes and with armies. The dead are taken 'frail' (children and the old)
  from the town's age bands, **shared by its peoples as they stand**: today a plague takes every
  people of a town alike.
- **Town health** (`civ/settlement.js healthAndEconomy`): a target from the realm's health mod,
  crowding (less with aqueducts, sewers, hospitals and sanitation), hunger, famine, the current
  plague, pollution and devastation, plus ext `townHealth` (Mythic healers add up to +0.04).
  Health raises natural deaths (`deathA`) and lowers happiness.
- **Medicine** comes from techs: medicine, anatomy, sanitation, vaccination, antibiotics
  (`medicine`, `sanitation`, `plagueResist` mods); lizardfolk may know the rare art of
  swamp-physic.
- **Camp fever** (`geo/war.js`): an army besieging a plague town may catch it (2 % a month) and
  loses 0.2 % a day while it lasts; it can carry the plague to a town. Armies never breed a
  sickness of their own.
- **Rulers' illness** (chunk 4): ext `sickness` by race (elves 0.4, lizardfolk 0.6, dwarves 0.7,
  halflings 0.9, humans 1, orcs 1.4) and the seat's health.
- **Fire:** towns can earn the 'rebuilt in stone' trait after a great fire (fire risk × 0.3).

## Rule: societies vary

| Rule | Ext point | Default |
|---|---|---|
| How readily a people falls ill and dies of it | `frailty` (new; `sickness` stays for notables) | Mythic: the race values above; Historical: 1, × hardiness |
| A people's custom of cleanliness | `cleanRule` | by culture, faith and land at birth; changed by plague and reform |
| What a faith teaches about sickness | `faithHealing` | from its tenets and doctrine (see Mechanics) |
| A realm's theory of sickness | `physicRule` | a ladder by techs, chosen among rivals by the realm (Mythic: each people its own lore) |
| How a town is built (timber, mud brick, stone) | `buildRule` | by land, era and people (dwarves stone, elves timber) |
| Who bears fever country | `feverRule` | natives of wet hot land; lizardfolk always; elves half |
| How an army keeps its camp | `campRule` | by its people's custom and its realm's theory |

## Mechanics

### 1. Peoples and sickness

- **Frailty** per people: how readily it catches a plague (× infection) and how hard it dies of
  it (× deaths). Mythic: the race values. Every people: × (1 − hardiness).
- **Hardiness** (0 to 0.4 per people): rises with each plague it lives through, by the share of it
  that died; fades over about three generations. Peoples of crowded old cities end up hardier.
- **Whose sicknesses a people knows:** each people keeps a short list of the peoples whose
  sicknesses it has met (its neighbours and trading partners, filled in as plagues pass). A plague
  carries its origin people. In a town, a people that has never met that people's sicknesses
  takes it as virgin soil: faster and deadlier (see Decisions). Surviving teaches it.
- **Uneven deaths:** an infected town's SIR step works out each people's share of the dead by its
  share of the town × its frailty × virgin soil; Mythic towns take them from each race's own age
  bands, Historical towns shift their peoples' shares (chunk 8's `s.folk`). The plague keeps a
  count of deaths and exposure by people (top six) for its account.

### 2. Customs of cleanliness

- One custom per people (Historical peoples by culture, land and faith at birth; a new people
  inherits its parent's, sometimes changed): **bathing** (bathhouses; × 0.85 infection, +health),
  **ritual washing** (× 0.9, set by faith), **wells apart** (× 0.9, fewer fluxes), **plain**
  (no effect), **water-fearing** (× 1.15, −health: the belief that water opens the body to sickness).
- Mythic baselines: elves bathing in their springs, dwarves wells apart (cisterns cut in stone),
  halflings plain but clean hearths (+health), orcs water-fearing, lizardfolk bathing, humans by
  culture like a Historical people.
- A town's effect is weighed by its mix of peoples.
- **Change:** after a great plague, a people that bathes may shut its bathhouses in fear of
  contagion (falls to plain or water-fearing); a reformer in a realm with the miasma or contagion
  theory may clean a city (raises a people's custom one step); a faith with ritual washing brings
  it to the peoples it converts.

### 3. Healing faiths

What each faith teaches about sickness, derived from its tenets (no new roll at founding):

- **Tends the sick** ('healing' tenet; or 'monastic'): hospitals and nursing orders; deaths × 0.8
  (as now). In a great plague its monks may nurse a stricken town, and the faith gains converts
  there.
- **Purity** ('ascetic' or a ritual-washing doctrine): rites of washing and fasting; infection × 0.9.
- **Penance** ('apocalyptic' or 'militant'): sickness as punishment. Plagues inflame unrest more
  (as now), flagellant processions walk from town to town and carry it with them, and the faithful
  crowd the shrines.
- **Fate** (the rest): no effect.
- **Pilgrims:** a holy town that draws pilgrims (an existing holy site, a faith's seat) takes in
  sickness more readily and sends it home with them along its faith's lands.

### 4. Physicians and their theories

A ladder per realm, set by its techs and the theory of its neighbours (chunk 5's fronts carry the
techs; a realm takes a rival theory from a stronger neighbour):

| Theory | Comes with | Right | Wrong |
|---|---|---|---|
| Spirits | the start | the sick are kept apart (a little) | charms and exorcisms |
| Humours | medicine | rest, diet, nursing | bleeding and purges |
| Bad air | anatomy (or medicine in a realm that drains or cleans) | clean streets, drained marshes | fires and perfumes against the plague |
| Contagion | anatomy (the rival school) | quarantine and cordons | burning the goods and the sick-houses |
| Germs | vaccination | all of it | — |

- **Quarantine:** a realm that holds bad air or contagion may close a town's gates when a plague
  comes near (the existing `plagueDose` effect at 0.4 for a while); contagion does it sooner and
  more often. A quarantine under bad air is one that works for the wrong reason.
- **Wrong cures** (see Decisions): humours' bleeding may make a plague deadlier, and kill a king.
- **Mythic:** each people its own lore at the start: elves herb-lore (as humours without the
  bleeding), dwarves stone-physic (wells and cisterns, as contagion's quarantine), halflings
  hearth-remedies (nursing), orcs spirit-shamans (spirits), lizardfolk swamp-physic (fever
  country), humans spirits. A realm climbs the ladder from there.
- **Physicians of note:** a realm that reaches a new theory, or a quarantine that saves a city,
  may name a physician in the chronicle (seeded flavour, no record).

### 5. Housing and sanitation

- **Slums:** `s.slum` (0 to 1) follows overcrowding (the town's people over its housing) and
  falls slowly as housing catches up; slums raise infection, lower health and raise fire risk.
- **What a town is built of** (`s.build`: timber, mud brick, stone), by land, era and people;
  'rebuilt in stone' after a great fire becomes a building code that turns timber towns to stone.
  Stone lowers fire risk; mud brick and timber raise it.
- Sewers, aqueducts and hospitals keep their present effects; sewers also clear slums faster.

### 6. Fever country

- **Fever ground:** marsh (chunk 6's wet ground), hot wet lowland and river delta tiles carry an
  endemic fever, its strength by heat and wetness, in a cached field.
- **Seasoning:** a town on fever ground loses health and adds deaths each year; its native peoples
  (those born there or of a fever-bearing nature: lizardfolk always, elves half) bear it,
  newcomers die of it for their first generation there. Settlers avoid fever ground and colonies
  there fail more often.
- **Draining:** a realm with bad air or later theory and engineering can drain a marsh as a great
  work (see Decisions), lowering the fever and raising the farmland.

### 7. Camp sickness

- Once a month per army in the field: the chance of camp fever (flux, typhus, ague) grows with its
  size, months in the field, a siege's lines, hunger (supply), summer, fever ground, and falls
  with its people's custom, its realm's theory and medicine.
- A fevered army loses men each day (see Decisions for how many) and morale, and deserters slip
  home; it ends in a few months or when the army disbands.
- **Carried home:** rarely (a large host, a long war), camp fever becomes a named plague ("the
  Soldier's Flux") that the army brings home or into the towns it takes.
- War accounts count the fever's dead apart from battle's.

## Interface

- **Town dossier, Health:** health and its parts, ranked (crowding, slums, water and sewers,
  customs, faith, physicians, peoples, fever ground, hunger, the current plague).
- **A plague's account:** the dead by people, whom it spared and why (frailty, hardiness, never
  met, custom).
- **A people's record:** its frailty, hardiness, custom of cleanliness and whose sicknesses it knows.
- **A realm's dossier:** its physicians' theory and its quarantines.
- **An army:** camp fever and its dead.

## Phases

1. **Peoples and sickness, customs of cleanliness:** frailty, hardiness, virgin soil, uneven
   deaths, customs and their changes.
2. **Healing faiths and physicians:** faith teachings, nursing, flagellants, pilgrims; the ladder,
   quarantines, wrong cures, Mythic lore.
3. **Housing, fever country, camp sickness.**
4. **Interface and calibration.**

## Speed budget

About 1.5 ms per sim-year for the whole chunk. The per-town work is a cached health term per
month and per-people sums in infected towns only (a handful at a time); per-people state is
yearly; fever ground is a cached field; camp fever is one roll per army per month.

## Decisions (the user's, 2026-10-27)

- **Camp fever: long campaigns.** Short wars lose little; long campaigns and sieges can lose more
  men to fever than to battle, as in history. The chance and the daily loss grow with months in
  the field, so a season's war barely feels it and a three-year siege is a graveyard.
- **Virgin soil: devastating, and rare.** At the first meeting of distant peoples (those whose
  sicknesses neither has met, and whose homelands lie far apart), a sickness can take a third to
  half of a people within a generation, as in the Americas. Between neighbours, who have met each
  other's sicknesses, it is an ordinary plague.
- **Wrong cures: yes, sometimes.** Humours' bleeding raises plague deaths a little and may hasten
  a sick king's death; a great plague can shut a people's bathhouses for generations.
- **Fever country: hard to hold, and drainable.** Newcomers die of fever for a generation and
  settlers avoid it, while natives and lizardfolk thrive; a realm with the bad-air theory or
  later and engineering can drain a marsh into farmland as a great work.
- **Mythic peoples** (following the earlier chunks): each its own customs and healing lore at the
  start, as in Mechanics.

## As built

All in `sim/geo/health.js` (a new system, order 56), with hooks into `disease.js` (the plague
step), `war.js` (camp fever, the fever's dead per war), `civ/rulers.js` (ext `illCure`),
`myth/races.js` (ext `frailty`, `feverRule`) and `events/decks/town.js` (fire risk by material);
the Inspector in `ui/views/health.js`. New ext points: `frailty`, `cleanRule`, `faithHealing`,
`physicRule`, `illCure`, `feverRule`, `buildRule`, `campRule`; `townHealth` now clamps to
−0.3…+0.12. New records: `sys.health.p` (per people: hardiness, custom, whose sicknesses it knows,
when its bathhouses shut), `s.sick` (per town), `civ.physic`, `plague.op`/`byP`/`qs`/`qx`,
`war.fever`, `army.flags.cf`.

- **Peoples and sickness.** In a plague town each people catches it by √frailty × its custom ×
  (1 + 0.4·virgin) and dies of it by √frailty × (1 + 3.5·virgin); frailty = the race's value
  (Mythic) × (1 − hardiness). Hardiness rises by 0.8 × the share of a people a plague killed (to
  0.4 at most) and fades 1.5 % a year; a great city (tier 4+) hardens its peoples toward 0.12.
  Virgin soil: a people that has never met the plague's people, with homelands more than 12 % of
  the map's diagonal apart, fully at 37 %. Peoples learn each other's sicknesses by sharing a town
  (2 %+ each), by trade between their realms, and by surviving a plague. Mythic races share most
  towns from the start, so virgin soil is a Historical matter.
- **Customs** (infection × / health +): bathing 0.85 / +0.02, ritual washing 0.9 / +0.01, wells
  apart 0.9 / +0.015, clean hearths 0.92 / +0.02, none 1 / 0, fear of water 1.15 / −0.02. Mythic:
  elves and lizardfolk bathe, dwarves keep wells apart, halflings clean hearths, orcs fear water,
  men by the land like a Historical people (seeded by the warmth of its homeland). After a notable
  plague that killed 5 %+ of a bathing people, 35 %: it shuts its bathhouses (fear of water at
  15 %+). A reformer of the newer theories (1.2 % a year in a realm with a city capital) raises a
  people from fear or none to wells apart, or reopens shut bathhouses; a state faith of purity
  brings its washings (2 % a year).
- **Faiths** teach from their tenets: healing or monastic → tends the sick (deaths × 0.8 / 0.9;
  in a notable plague its monks nurse a stricken town of another faith, 6 % a month: deaths × 0.85
  there, +6 % converts), apocalyptic → penance (flagellant processions from an infected town, 10 %
  a month, carry it to up to three towns of the faith), ascetic → purity (× 0.9 infection). A holy
  city takes in sickness × 1.1 and its pilgrims carry it to the faith's far towns (15 % a month).
- **Physicians:** spirits → humours (medicine) → bad air or contagion (anatomy; a neighbour's, or
  three to two for bad air) → germs (vaccination); a rank-2 realm may take the rival school from a
  neighbour half again its size (3 % a year). Mythic lores at the start: herb-lore (elves), stone-
  physic (dwarves), hearth-remedies (halflings), spirit-shamans (orcs), swamp-physic (lizardfolk).
  Each theory sets infection, deaths, health, a quarantine readiness, the death hazard of an ill
  ruler (humours 1.25, germs 0.7) and fever's harm (PHYSIC in health.js). Quarantine: a town of
  tier 2+ within 8 tiles of an infected one, 20 % × readiness a month: plague dose × 0.35, trade
  × 0.75 for 180 days. A city of tier 4+ behind shut gates that the plague never reached credits a
  physician (one line per plague).
- **Housing:** slums follow crowding in towns over 3,000 (people against housing above 0.7 ×
  size), clear at 8 % a year (×2.5 with sewers): infection × (1 + 0.5·slums), health −0.08·slums.
  Material by land: stone in the hills, mud brick on plains and in dry lands, timber elsewhere;
  great cities of era 3+ turn to stone (2 % a year), and at once after a great fire. Fire risk ×
  1.2 timber, 0.8 mud brick, 0.55 stone.
- **Fever ground:** 3×3 tiles: marsh 1, hot wet forest 0.5, a river +0.12, by heat; read once a
  century. Harm = the peoples' bearing (lizardfolk 0, elves ½) × (0.15 + 0.85 × unseasoned) × the
  theory's fever factor: health −0.15·fever·harm − 0.02·fever, and 3 %·fever·harm of the town a
  year. Seasoning rises a twenty-fifth of the way a year; a people born on fever ground arrives
  at 0.8; conquest sets it back 15 %. Settlers score fever ground −0.3·fever. Draining: a realm
  with bad air, contagion or germs and engineering, with 1.5× half a year's income, 5 % a year,
  its worst fever town (tier 2+, fever 0.3+): eight years' work, then fever × 0.25 and food × 1.1.
- **Camp fever:** a host at war two months or more: 1.5 % a month × months/12 (0.1–3) × size
  ((strength/2000)^0.35, 0.5–2) × 2 in siege lines × 1.5 hungry × 1.3 in summer × (1 + 2 × fever
  ground) × its people's custom × its physicians. A fever runs about three months, costing 8 % ×
  severity (0.6–1.4) × the physicians' deaths × medicine of the host a month, a fifth of it
  deserters who walk home. A great host (2,500+, 1,000+ lost) may carry it home as a plague: 6 % ×
  the world's room for a new pestilence, once in 60 years at most.
